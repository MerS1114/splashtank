//! Whitewater and deep water on the CPU side: drip samples on the colliders, and the whitewater and deep water points of a cache frame
//! (dripSamples, packSprayJS, packSprayFrame in src/flip/bake.js; packDeep in src/gpu.js).

use crate::sdf::Sdf;
use splash_format::Box3;

/// Drip samples on a collider from its distance grid: grid points near the surface moved onto it along the gradient, about one per
/// solver cell of surface (100 to 6000). 8 floats each: local position, collider number, local normal, wetness (starts dry).
pub fn drip_samples(sd: &Sdf, h: f32, k: u32) -> Vec<f32> {
    let [nx, ny, nz] = sd.dims;
    let (c, d, o) = (sd.cell, &sd.data, sd.origin);
    let at = |i: isize, j: isize, q: isize| d[(i.clamp(0, nx as isize - 1) as usize) + nx * ((j.clamp(0, ny as isize - 1) as usize) + ny * (q.clamp(0, nz as isize - 1) as usize))];
    let mut pts: Vec<f32> = Vec::new();
    for q in 1..nz as isize - 1 { for j in 1..ny as isize - 1 { for i in 1..nx as isize - 1 {
        let v = d[i as usize + nx * (j as usize + ny * q as usize)];
        if v.abs() > 0.6 * c { continue; }
        let (mut gx, mut gy, mut gz) = (at(i + 1, j, q) - at(i - 1, j, q), at(i, j + 1, q) - at(i, j - 1, q), at(i, j, q + 1) - at(i, j, q - 1));
        let gl = (gx * gx + gy * gy + gz * gz).sqrt();
        if gl < 1e-9 { continue; }
        gx /= gl; gy /= gl; gz /= gl;
        pts.extend_from_slice(&[o[0] + i as f32 * c - gx * v, o[1] + j as f32 * c - gy * v, o[2] + q as f32 * c - gz * v, gx, gy, gz]);
    } } }
    let nsurf = pts.len() / 6;
    let want = 100f64.max(6000f64.min((nsurf as f64 * (c * c) as f64 / (h * h) as f64).round()));
    let step = 1f64.max(nsurf as f64 / want);
    let mut sdv: i64 = 7 + sd.id as i64;
    let mut rnd = || { sdv = (sdv * 16807) % 2147483647; sdv as f64 / 2147483647.0 };
    let mut out = Vec::new();
    let mut t = rnd() * step;
    while t < nsurf as f64 {
        let i = t.floor() as usize * 6;
        out.extend_from_slice(&[pts[i], pts[i + 1], pts[i + 2], k as f32, pts[i + 3], pts[i + 4], pts[i + 5], 0.0]);
        t += step;
    }
    out
}

/// The shader's 32-bit whitewater code: top bit, two bits of kind (00 spray, 10 mist, 01 foam, 11 bubble), 8 bits of speed in quarter
/// units a second, then the direction (spray, mist) or how much life is left (foam, bubbles) (packSprayJS).
pub fn pack_spray(vx: f32, vy: f32, vz: f32, kind: u32, life_frac: f32, seed: u32) -> u32 {
    let (vx, vy, vz) = (vx as f64, vy as f64, vz as f64);
    let s = (vx * vx + vy * vy + vz * vz).sqrt();
    let mut code = 0x8000_0000u32 | (((s * 4.0).floor().min(255.0) as u32) << 21);
    code |= [0, 0x4000_0000, 0x2000_0000, 0x6000_0000][(kind & 3) as usize];
    if kind >= 2 { return code | ((((seed & 2047) | 1) << 10) | (life_frac.clamp(0.0, 1.0) as f64 * 1023.0).round() as u32); }
    if kind == 1 { return code | (seed & 0xFFFFF) | 1; }
    let (mut nx, mut ny, mut nz) = (0.0, 1.0, 0.0);
    if s > 1e-6 { nx = vx / s; ny = vy / s; nz = vz / s; }
    let l = nx.abs() + ny.abs() + nz.abs();
    let (mut px, mut py) = (nx / l, ny / l);
    if nz < 0.0 {
        let qx = (1.0 - py.abs()) * if px >= 0.0 { 1.0 } else { -1.0 };
        let qy = (1.0 - px.abs()) * if py >= 0.0 { 1.0 } else { -1.0 };
        px = qx; py = qy;
    }
    let u = ((px * 0.5 + 0.5) * 1023.0).round().clamp(0.0, 1023.0) as u32;
    let w = ((py * 0.5 + 0.5) * 1023.0).round().clamp(0.0, 1023.0) as u32;
    code | (w << 10) | u
}

fn ww_seed(j: u32) -> u32 { j.wrapping_mul(2654435761) >> 11 }
fn ww_keep(j: u32) -> f64 { (j.wrapping_mul(7919).wrapping_add(104729)).wrapping_mul(2654435761) as f64 / 4294967296.0 }

/// The live whitewater slots for a cache frame: an even sample of at most about cap points by slot number (a point that stays alive
/// stays in the sample), positions 16-bit across the whitewater area b. p: x y z life; v: velocity and kind (packSprayFrame).
pub fn pack_spray_frame(p: &[f32], v: &[f32], n: usize, b: &Box3, cap: usize, foam_life: f32) -> (usize, Vec<u16>, Vec<u32>, usize) {
    let foam_life = if foam_life > 0.0 { foam_life } else { 3.0 };
    let alive = (0..n).filter(|&j| p[j * 4 + 3] > 0.0).count();
    let share = if alive > cap { cap as f64 / alive as f64 } else { 1.0 };
    let keep = |j: usize| p[j * 4 + 3] > 0.0 && (share >= 1.0 || ww_keep(j as u32) < share);
    let m = (0..n).filter(|&j| keep(j)).count().min(cap);
    let mut pos = vec![0u16; m * 3];
    let mut pk = vec![0u32; m];
    let e = b.size();
    let kq = [65535.0 / e[0], 65535.0 / e[1], 65535.0 / e[2]];
    let b0 = [b.x0, b.y0, b.z0];
    let mut k = 0;
    for j in 0..n {
        if k >= m { break; }
        if !keep(j) { continue; }
        for c in 0..3 { pos[k * 3 + c] = ((p[j * 4 + c] - b0[c]) * kq[c]).round().clamp(0.0, 65535.0) as u16; }
        pk[k] = pack_spray(v[j * 4], v[j * 4 + 1], v[j * 4 + 2], v[j * 4 + 3].round().max(0.0) as u32, p[j * 4 + 3] / foam_life, ww_seed(j as u32));
        k += 1;
    }
    pos.truncate(k * 3);
    pk.truncate(k);
    (k, pos, pk, alive)
}

/// Deep water points (narrow band look; x y z, 4096 + speed), 16-bit across the box with a speed byte (packDeep).
pub fn pack_deep(p: &[f32], n: usize, b: &Box3, vs: f32) -> (usize, Vec<u16>, Vec<u8>) {
    let ks = 16.0 * vs;
    let e = b.size();
    let kq = [65535.0 / e[0], 65535.0 / e[1], 65535.0 / e[2]];
    let b0 = [b.x0, b.y0, b.z0];
    let mut pos = Vec::with_capacity(n * 3);
    let mut spd = Vec::with_capacity(n);
    for i in 0..n {
        let q = &p[i * 4..i * 4 + 4];
        if q[1] <= -1e5 { continue; }
        for c in 0..3 { pos.push(((q[c] - b0[c]) * kq[c]).round().clamp(0.0, 65535.0) as u16); }
        let s = (q[3] - 4096.0) * ks;
        spd.push(if s > 191.0 { 191 } else { s.max(0.0) as u8 });
    }
    (spd.len(), pos, spd)
}
