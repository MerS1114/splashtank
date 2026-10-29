//! Runs the scene each step: colliders with the velocity their motion gives the water, and emitters adding particles (SceneRunner
//! in src/shared.js).

use crate::flip::{FlipSim, Rng, StepPar};
use crate::gpu::Gpu;
use crate::scene::{Col, Obj};
use crate::sdf::euler_mat;
use std::collections::HashMap;

struct Prev { pos: [f32; 3], r: [f32; 9], sz: [f32; 3] }
#[derive(Default)]
struct Em { phase: f32, acc: f32, key: String, pts: Vec<f32>, t: f32, dist: f32 }

pub struct Runner {
    prev: HashMap<u64, Prev>,
    em: HashMap<u64, Em>,
    pub rng: Rng,
}

fn vhash(x: i64, y: i64, z: i64) -> f32 {
    let mut h = (x.wrapping_mul(374761393).wrapping_add(y.wrapping_mul(668265263)).wrapping_add(z.wrapping_mul(2147483647))) as i32;
    h = (h ^ ((h as u32) >> 13) as i32).wrapping_mul(1274126177);
    ((h ^ ((h as u32) >> 16) as i32) as u32) as f32 / 4294967295.0
}
/// Smooth value noise in [-1, 1].
fn vnoise(x: f32, y: f32, z: f32) -> f32 {
    let (ix, iy, iz) = (x.floor(), y.floor(), z.floor());
    let (fx, fy, fz) = (x - ix, y - iy, z - iz);
    let (u, v, w) = (fx * fx * (3.0 - 2.0 * fx), fy * fy * (3.0 - 2.0 * fy), fz * fz * (3.0 - 2.0 * fz));
    let l = |a: f32, b: f32, t: f32| a + (b - a) * t;
    let c = |i: i64, j: i64, k: i64| vhash(ix as i64 + i, iy as i64 + j, iz as i64 + k);
    2.0 * l(l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v), l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v), w) - 1.0
}

impl Runner {
    pub fn new(seed: u64) -> Runner { Runner { prev: HashMap::new(), em: HashMap::new(), rng: Rng::new(seed) } }

    /// What carries over between steps (each collider's last pose, each source's stream, the random numbers), for a checkpoint.
    pub fn save_state(&self) -> serde_json::Value {
        serde_json::json!({
            "rng": self.rng.0,
            "prev": self.prev.iter().map(|(id, p)| serde_json::json!([id, p.pos, p.r, p.sz])).collect::<Vec<_>>(),
            "em": self.em.iter().map(|(id, e)| serde_json::json!([id, e.phase, e.acc, e.key, e.pts, e.t, e.dist])).collect::<Vec<_>>(),
        })
    }
    pub fn restore_state(&mut self, v: &serde_json::Value) {
        let fl = |x: &serde_json::Value| x.as_f64().unwrap_or(0.0) as f32;
        let arr = |x: &serde_json::Value| -> Vec<f32> { x.as_array().map(|a| a.iter().map(fl).collect()).unwrap_or_default() };
        self.rng = Rng(v["rng"].as_u64().unwrap_or(0x5eed));
        self.prev.clear();
        for p in v["prev"].as_array().into_iter().flatten() {
            let (pos, r, sz) = (arr(&p[1]), arr(&p[2]), arr(&p[3]));
            if pos.len() == 3 && r.len() == 9 && sz.len() == 3 {
                self.prev.insert(p[0].as_u64().unwrap_or(0), Prev { pos: [pos[0], pos[1], pos[2]], r: r.try_into().unwrap(), sz: [sz[0], sz[1], sz[2]] });
            }
        }
        self.em.clear();
        for e in v["em"].as_array().into_iter().flatten() {
            self.em.insert(e[0].as_u64().unwrap_or(0), Em { phase: fl(&e[1]), acc: fl(&e[2]), key: e[3].as_str().unwrap_or("").to_string(), pts: arr(&e[4]), t: fl(&e[5]), dist: fl(&e[6]) });
        }
    }

    /// One step: collider records from the objects' states, emitters, then the solver step.
    pub fn step(&mut self, gpu: &Gpu, sim: &mut FlipSim, dt: f32, states: &[Obj], par: &StepPar, col_max: f32, scale: f32) {
        let lim2 = if col_max > 0.0 { col_max * col_max } else { 400.0 };
        let mut cols = Vec::new();
        for o in states {
            if o.emitter { if o.on { self.emit(gpu, sim, o, dt, scale); } continue; }
            let (Some(sdf), false) = (&o.sdf, o.water) else { continue; };
            let r = euler_mat(o.rx, o.yaw, o.rz);
            let sz = [o.sx, o.sy, o.sz];
            let p = self.prev.insert(o.id, Prev { pos: [o.x, o.y, o.z], r, sz });
            let mut c = Col { sdf: sdf.clone(), pos: [o.x, o.y, o.z], r, s: sz, v: [0.0; 3], w: [0.0; 3], g: [0.0; 3] };
            if let Some(p) = p {
                let v = [(o.x - p.pos[0]) / dt, (o.y - p.pos[1]) / dt, (o.z - p.pos[2]) / dt];
                if v[0] * v[0] + v[1] * v[1] + v[2] * v[2] < lim2 { c.v = v; }
                // dR = R Rprev^T
                let mut d = [0f32; 9];
                for rr in 0..3 { for q in 0..3 { d[rr * 3 + q] = r[rr * 3] * p.r[q * 3] + r[rr * 3 + 1] * p.r[q * 3 + 1] + r[rr * 3 + 2] * p.r[q * 3 + 2]; } }
                let w = [(d[7] - d[5]) / (2.0 * dt), (d[2] - d[6]) / (2.0 * dt), (d[3] - d[1]) / (2.0 * dt)];
                if w[0] * w[0] + w[1] * w[1] + w[2] * w[2] < lim2 { c.w = w; }
                // growing or shrinking: size times its rate of change per axis
                let ext = 0.5 * sdf.cell * sdf.dims.iter().copied().max().unwrap() as f32;
                let g = [0, 1, 2].map(|i| sz[i] * (sz[i] - p.sz[i]) / dt);
                if g.iter().any(|&v| v != 0.0) && (0..3).map(|i| (g[i] / sz[i]).abs() * ext).fold(0.0, f32::max).powi(2) < lim2 { c.g = g; }
            }
            cols.push(c);
        }
        sim.step(gpu, dt, par, &cols);
    }

    /// A source adds water: a lattice disc each time the stream advanced one spacing (smooth), or random points at the flow rate.
    fn emit(&mut self, gpu: &Gpu, sim: &mut FlipSim, o: &Obj, dt: f32, scale: f32) {
        let d = sim.d();
        let st = self.em.entry(o.id).or_default();
        let (az, el) = (o.az.to_radians(), o.el.to_radians());
        let (dx, dy, dz) = (el.cos() * az.cos(), el.sin(), el.cos() * az.sin());
        let rf = if dy.abs() > 0.95 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
        let (mut ux, mut uy, mut uz) = (dy * rf[2] - dz * rf[1], dz * rf[0] - dx * rf[2], dx * rf[1] - dy * rf[0]);
        let ul = { let l = (ux * ux + uy * uy + uz * uz).sqrt(); if l > 0.0 { l } else { 1.0 } };
        ux /= ul; uy /= ul; uz /= ul;
        let (wx, wy, wz) = (dy * uz - dz * uy, dz * ux - dx * uz, dx * uy - dy * ux);
        let ks = 1.0 / scale;
        let (sp, v) = (o.spread * ks, o.speed * ks);
        let veff = v.max(0.3 * ks);
        let tb = o.turb;
        st.t += dt;
        st.dist += veff * dt;
        let (stt, sdist) = (st.t, st.dist);
        let rng = &mut self.rng;
        // turbulent flow: eddies carried with the stream, large ones across the disc plus smaller ones, changing in time
        let turb = |a: f32, c: f32, adv: f32, rng: &mut Rng| -> [f32; 3] {
            if tb <= 0.0 { return [0.0; 3]; }
            let r = o.radius.max(0.08);
            let (k1, k2) = (1.4 / r, 4.2 / r);
            let zz = (sdist - adv) / (1.6 * r + 0.25) + stt * 0.5;
            let n = |ox: f32, oy: f32, oz: f32| vnoise(a * k1 + ox, c * k1 + oy, zz + oz) * 0.7 + vnoise(a * k2 + oz, c * k2 + ox, zz * 2.3 + oy) * 0.3;
            let tv = tb * v.max(0.6 * ks);
            let (p1, p2) = (n(31.7, 5.2, 9.1) * 0.9 * tv, n(-12.4, 77.3, 3.3) * 0.9 * tv);
            let f = 1.0 + 0.6 * tb * n(53.1, -8.8, 21.7);
            let jit = tb * 0.1 * v.max(0.6 * ks);
            [dx * v * (f - 1.0) + ux * p1 + wx * p2 + (rng.f() - 0.5) * 2.0 * jit, dy * v * (f - 1.0) + uy * p1 + wy * p2 + (rng.f() - 0.5) * 2.0 * jit,
             dz * v * (f - 1.0) + uz * p1 + wz * p2 + (rng.f() - 0.5) * 2.0 * jit]
        };
        if o.random {
            st.acc += std::f32::consts::PI * o.radius * o.radius * veff / (d * d * d) * o.density * dt;
            let n = st.acc.floor();
            st.acc -= n;
            for _ in 0..n as u32 {
                let a = rng.f() * std::f32::consts::TAU;
                let rr = o.radius * rng.f().sqrt();
                let (ca, sa) = (a.cos() * rr, a.sin() * rr);
                let adv = rng.f() * veff * dt;
                let tz = turb(ca, sa, adv, rng);
                let jv = [(rng.f() - 0.5) * 2.0 * sp, (rng.f() - 0.5) * 2.0 * sp, (rng.f() - 0.5) * 2.0 * sp];
                if !sim.add(gpu, [o.x + ux * ca + wx * sa + dx * adv, o.y + uy * ca + wy * sa + dy * adv, o.z + uz * ca + wz * sa + dz * adv],
                    [dx * v + jv[0] + tz[0], dy * v + jv[1] + tz[1], dz * v + jv[2] + tz[2]]) { break; }
            }
            return;
        }
        let key = format!("{}|{}", o.radius, d);
        if st.key != key {
            let mut pts = Vec::new();
            let r = (o.radius / d).ceil() as i32 + 1;
            for i in -r..=r { for j in -r..=r {
                let (a, c) = ((i as f32 + 0.5) * d, (j as f32 + 0.5) * d);
                if a * a + c * c <= o.radius * o.radius { pts.push(a); pts.push(c); }
            } }
            if pts.is_empty() { pts.extend_from_slice(&[0.0, 0.0]); }
            st.pts = pts;
            st.key = key;
        }
        st.phase += veff * dt;
        let mut guard = 0;
        while st.phase >= d && guard < 8 {
            guard += 1;
            st.phase -= d;
            let adv = st.phase;
            for k in (0..st.pts.len()).step_by(2) {
                let (a, c) = (st.pts[k], st.pts[k + 1]);
                let tz = turb(a, c, adv, rng);
                let jv = if sp != 0.0 { [(rng.f() - 0.5) * 2.0 * sp, (rng.f() - 0.5) * 2.0 * sp, (rng.f() - 0.5) * 2.0 * sp] } else { [0.0; 3] };
                if !sim.add(gpu, [o.x + ux * a + wx * c + dx * adv, o.y + uy * a + wy * c + dy * adv, o.z + uz * a + wz * c + dz * adv],
                    [dx * v + jv[0] + tz[0], dy * v + jv[1] + tz[1], dz * v + jv[2] + tz[2]]) { return; }
            }
        }
    }
}
