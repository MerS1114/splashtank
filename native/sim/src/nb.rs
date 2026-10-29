//! Narrow band starting water and ocean waves: ports of nbSeed / nbSeedCount, oceanWaves, oceanEtaJS and oceanVelJS (src/shared.js).
//! The deep water starts on the solver's grid from the same shapes (sent to the GPU as the fills at Params word 84 and, for water
//! volumes, as extra colliders), so only a band under the free surface gets particles.

use crate::flip::{Layout, Ocean};
use crate::scene::{Col, Fill};
use crate::sdf;
use std::f64::consts::PI;

/// A starting-water shape for the first narrow band step (word 84 on): a box whose faces on the tank walls are pushed far out (they
/// are not free surfaces), or a sphere.
#[derive(Clone, Copy, Debug)]
pub enum NbFill { Box([f32; 6]), Sphere([f32; 4]) }

fn mulberry32(mut a: u32) -> impl FnMut() -> f64 {
    move || {
        a = a.wrapping_add(0x6D2B79F5);
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        (t ^ (t >> 14)) as f64 / 4294967296.0
    }
}

/// 24 linear waves around the peak wavelength, with a Pierson-Moskowitz shaped spectrum scaled to the significant wave height, spread
/// around the wave direction; depth and gravity set each wave's speed. 8 floats a wave: kx, kz, amplitude, angular frequency, phase,
/// wavenumber, 0, 0 (oceanWaves).
pub fn waves(oc: &Ocean, g: f64, depth: f64) -> Vec<f32> {
    const N: usize = 24;
    let s = if oc.seed == 0 { 1 } else { oc.seed as i64 };
    let mut rnd = mulberry32((s * 7919 + 13) as u32);
    let (d, gg, lp) = (depth.max(1e-3), g.max(1e-4), oc.length.max(1e-3));
    let kp = 2.0 * PI / lp;
    let wp = (gg * kp * (kp * d).tanh()).sqrt();
    let k_of = |om: f64| { let mut k = om * om / gg; for _ in 0..40 { k = om * om / (gg * (k * d).max(1e-6).tanh()); } k };
    let (th0, spr) = (oc.dir * PI / 180.0, oc.spread.max(0.0) * PI / 180.0);
    let mut tmp = Vec::with_capacity(N);
    let mut sum = 0.0;
    for i in 0..N {
        let r = 0.6 + 1.6 * (i as f64 + rnd()) / N as f64;
        let om = r * wp;
        let k = k_of(om);
        let sp = r.powi(-5) * (-1.25 * r.powi(-4)).exp();
        let th = th0 + spr * (rnd() + rnd() + rnd() - 1.5) / 1.5;
        let ph = rnd() * 2.0 * PI;
        tmp.push((k, om, sp, th, ph));
        sum += sp;
    }
    // significant height = 4 x the standard deviation of the surface
    let m0 = (oc.height.max(0.0) / 4.0).powi(2);
    let mut w = vec![0f32; N * 8];
    for (i, (k, om, sp, th, ph)) in tmp.into_iter().enumerate() {
        let a = (2.0 * m0 * sp / sum).sqrt().min(0.3 / k);
        w[i * 8..i * 8 + 6].copy_from_slice(&[(k * th.cos()) as f32, (k * th.sin()) as f32, a as f32, om as f32, ph as f32, k as f32]);
    }
    w
}

/// The surface height at (x, z) and time t (oceanEtaJS).
pub fn eta(w: &[f32], oc: &Ocean, x: f64, z: f64, t: f64) -> f64 {
    let mut e = oc.level;
    for a in w.chunks(8) { e += a[2] as f64 * (a[0] as f64 * x + a[1] as f64 * z - a[3] as f64 * t + a[4] as f64).cos(); }
    e
}

/// The waves' water velocity at a point, the depth stretched to the surface above it (oceanVelJS).
pub fn vel(w: &[f32], oc: &Ocean, y0: f64, x: f64, y: f64, z: f64, t: f64) -> [f64; 3] {
    let d = (oc.level - y0).max(1e-3);
    let e = eta(w, oc, x, z, t);
    let ys = ((y - y0) * d / (d + e - oc.level).max(0.1 * d)).clamp(0.0, d);
    let mut v = [0f64; 3];
    for a in w.chunks(8) {
        let a: Vec<f64> = a.iter().map(|&q| q as f64).collect();
        let kk = a[5].max(1e-4);
        let th = a[0] * x + a[1] * z - a[3] * t + a[4];
        let (e1, e2) = ((kk * (ys - d)).exp(), (-kk * (ys + d)).exp());
        let dn = (1.0 - (-2.0 * kk * d).exp()).max(1e-4);
        let aw = a[2] * a[3];
        let hc = aw * (e1 + e2) / dn * th.cos() / kk;
        v[0] += hc * a[0]; v[1] += aw * (e1 - e2) / dn * th.sin(); v[2] += hc * a[1];
    }
    v
}

/// JavaScript's Math.hypot as V8 computes it (scaled by the largest value, Kahan summation): it rounds differently from a plain square
/// root, which decides lattice points that lie exactly on a sphere's surface.
fn hypot3(x: f64, y: f64, z: f64) -> f64 {
    let v = [x.abs(), y.abs(), z.abs()];
    let m = v[0].max(v[1]).max(v[2]);
    if m == 0.0 { return 0.0; }
    let (mut sum, mut comp) = (0f64, 0f64);
    for a in v {
        let n = a / m;
        let summand = n * n - comp;
        let pre = sum + summand;
        comp = (pre - sum) - summand;
        sum = pre;
    }
    sum.sqrt() * m
}

pub struct Seeded { pub prims: Vec<NbFill>, pub vols: Vec<Col>, pub seeded: u64, pub full: bool }

/// Particles only in the band under the free surface of each starting shape and of the ocean (nbSeed). put adds one particle at a
/// lattice point with a velocity and returns false once the sim is full; the caller adds the jitter. Box faces on the tank walls are
/// not free surfaces; for water meshes a surface point on a wall counts as deep, and the depth is measured upwards instead.
pub fn seed(l: &Layout, fills: &[Fill], band_cells: f32, oc: Option<(&Ocean, &[f32])>, t: f64, put: &mut dyn FnMut([f32; 3], [f32; 3]) -> bool) -> Seeded {
    let (d, h) = (l.d64(), l.h64());
    let band = (band_cells.max(2.0)) as f64 * h;
    let [bx0, bx1, by0, by1, bz0, bz1] = l.b64();
    let near = 0.6 * h;
    let on_wall = |x: f64, y: f64, z: f64| x < bx0 + near || x > bx1 - near || z < bz0 + near || z > bz1 - near || y < by0 + near || y > by1 - near;
    let mut s = Seeded { prims: Vec::new(), vols: Vec::new(), seeded: 0, full: false };
    let mut add = |s: &mut Seeded, x: f64, y: f64, z: f64, v: [f64; 3]| {
        if put([x as f32, y as f32, z as f32], [v[0] as f32, v[1] as f32, v[2] as f32]) { s.seeded += 1; } else { s.full = true; }
    };
    for f in fills {
        if s.full { break; }
        match f {
            Fill::Box { x0, x1, y0, y1, z0, z1 } => {
                let [x0, x1, y0, y1, z0, z1] = [*x0, *x1, *y0, *y1, *z0, *z1];
                let e = [if x0 <= bx0 + near { -1e4 } else { x0 }, if x1 >= bx1 - near { 1e4 } else { x1 }, if y0 <= by0 + near { -1e4 } else { y0 },
                    if y1 >= by1 - near { 1e4 } else { y1 }, if z0 <= bz0 + near { -1e4 } else { z0 }, if z1 >= bz1 - near { 1e4 } else { z1 }];
                let mut y = y0 + d / 2.0;
                while y < y1 && !s.full {
                    let mut x = x0 + d / 2.0;
                    while x < x1 && !s.full {
                        let mut z = z0 + d / 2.0;
                        while z < z1 {
                            if (x - e[0]).min(e[1] - x).min(y - e[2]).min(e[3] - y).min(z - e[4]).min(e[5] - z) <= band { add(&mut s, x, y, z, [0.0; 3]); }
                            z += d;
                        }
                        x += d;
                    }
                    y += d;
                }
                s.prims.push(NbFill::Box([e[0] as f32, e[2] as f32, e[4] as f32, e[1] as f32, e[3] as f32, e[5] as f32]));
            }
            Fill::Vol { sdf: sd, pos, r, s: sc, lo, hi } => {
                let loc = |x: f64, y: f64, z: f64| sdf::world(sd, *pos, r, *sc, [x as f32, y as f32, z as f32]);
                let mut y = lo[1] as f64 + d / 2.0;
                while y < hi[1] as f64 && !s.full {
                    let mut x = lo[0] as f64 + d / 2.0;
                    while x < hi[0] as f64 && !s.full {
                        let mut z = lo[2] as f64 + d / 2.0;
                        while z < hi[2] as f64 {
                            let q = loc(x, y, z);
                            let sd0 = q[0] as f64;
                            if sd0 < 0.0 && -sd0 <= band {
                                // nearest surface point: on a wall it is not a free surface, so measure the depth straight up instead
                                if on_wall(x - sd0 * q[1] as f64, y - sd0 * q[2] as f64, z - sd0 * q[3] as f64) {
                                    let mut up = 0.0;
                                    while up <= band && y + up < by1 && loc(x, y + up, z)[0] < 0.0 { up += d; }
                                    if up <= band && y + up < by1 { add(&mut s, x, y, z, [0.0; 3]); }
                                } else { add(&mut s, x, y, z, [0.0; 3]); }
                            }
                            z += d;
                        }
                        x += d;
                    }
                    y += d;
                }
                s.vols.push(Col { sdf: sd.clone(), pos: *pos, r: *r, s: sc.unwrap_or([1.0; 3]), v: [0.0; 3], w: [0.0; 3], g: [0.0; 3] });
            }
            Fill::Sphere { x: cx, y: cy, z: cz, r, vy } => {
                let r = *r;
                let mut y = -r;
                while y <= r && !s.full {
                    let mut x = -r;
                    while x <= r && !s.full {
                        let mut z = -r;
                        while z <= r {
                            let dist = r - hypot3(x, y, z);
                            if dist >= 0.0 && dist <= band { add(&mut s, *cx + x, *cy + y, *cz + z, [0.0, *vy, 0.0]); }
                            z += d;
                        }
                        x += d;
                    }
                    y += d;
                }
                s.prims.push(NbFill::Sphere([*cx as f32, *cy as f32, *cz as f32, r as f32]));
            }
        }
    }
    if let Some((oc, w)) = oc {
        if !s.full {
            // the ocean: the band under the waves, moving with them, inside the boundary
            let mut x = bx0 + d / 2.0;
            while x < bx1 && !s.full {
                let mut z = bz0 + d / 2.0;
                while z < bz1 && !s.full {
                    if 1.0 - (x - bx0).min(bx1 - x).min(z - bz0).min(bz1 - z) / oc.layer.max(1e-4) < 0.5 {
                        let e = eta(w, oc, x, z, t).min(by1 - d);
                        let mut y = by0 + d / 2.0 + (((e - band - by0) / d).floor()).max(0.0) * d;
                        while y < e { let v = vel(w, oc, by0, x, y, z, t); add(&mut s, x, y, z, v); y += d; }
                    }
                    z += d;
                }
                x += d;
            }
        }
    }
    s
}

/// The spare slots a seed parks off the map for the solver to refill the band with.
pub fn spares(seeded: u64) -> u64 { (0.35 * seeded as f64).ceil() as u64 + 4000 }
