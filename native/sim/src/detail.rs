//! The Detail pass (runDetailPass in src/flip/bake.js), Houdini-style guided resimulation of a region: after a water bake, a second FLIP
//! sim k times finer runs over just a box of the tank, guided by the bake. Each frame, from the coarse frame and the next one (particles
//! keep their places, so their motion gives the velocity; bakes store none):
//! - water is counted in coarse cells over the region; with narrow band, cells under the band's bottom count as deep water (or the deep
//!   water points when the bake kept them);
//! - a boundary layer two coarse cells wide inside each open side of the region is cleared and filled again from the coarse water, with
//!   its velocity, so water flows in and out with the bake (sides on the tank's walls are walls);
//! - inside, fine particles are pulled a little towards the coarse velocity of their cell (Follow the bake);
//! then the fine sim steps through the frame. Each frame is written out with the bake's water inside the region hidden and the fine water
//! after it, at the same index in every frame so playback blends each point with itself.

use crate::bake::{compact_bits, pack16, Extra, Progress};
use crate::flip::{layout_at, FlipSim, StepPar};
use crate::gpu::Gpu;
use crate::runner::Runner;
use crate::scene::{sample, Desc, Obj};
use serde_json::{json, Value};
use splash_format::cache::decode_point;
use splash_format::{Box3, Cache, CacheWriter, FrameOut};
use std::path::Path;
use std::time::Instant;

/// The region as shares of the tank (centre and size on each axis, 0-1), how much finer (2 or 3) and how strongly the fine water is
/// pulled towards the bake's motion each frame (0-1). The page's defaults: centre 0.5, size 0.4 x 1 x 0.4, 2x, 0.15.
#[derive(Clone, Copy, Debug)]
pub struct DetailOpts { pub c: [f32; 3], pub s: [f32; 3], pub k: u32, pub pull: f32 }
impl Default for DetailOpts { fn default() -> Self { DetailOpts { c: [0.5; 3], s: [0.4, 1.0, 0.4], k: 2, pull: 0.15 } } }

/// The region in box b (detShare, detIn), clipped to the tank; None when under four coarse cells a side (detailBox).
pub fn region(b: &Box3, o: &DetailOpts, hc: f32) -> Option<Box3> {
    let sh = |k: usize| ((o.c[k] - o.s[k] / 2.0).clamp(0.0, 1.0), (o.c[k] + o.s[k] / 2.0).clamp(0.0, 1.0));
    let l = |a: f32, z: f32, t: f32| a + (z - a) * t;
    let ((x0, x1), (y0, y1), (z0, z1)) = (sh(0), sh(1), sh(2));
    let r = Box3 { x0: l(b.x0, b.x1, x0), x1: l(b.x0, b.x1, x1), y0: l(b.y0, b.y1, y0), y1: l(b.y0, b.y1, y1), z0: l(b.z0, b.z1, z0), z1: l(b.z0, b.z1, z1) };
    let e = r.size();
    (e.iter().all(|&v| v >= 4.0 * hc)).then_some(r)
}

/// The coarse water over the region and one cell around it, in coarse cells: particle counts, mean velocity, deep water.
struct Grid { g0: [f32; 3], n: [usize; 3], hc: f32, cnt: Vec<f32>, vel: Vec<f32>, deep: Vec<u8> }
impl Grid {
    fn cell_at(&self, x: f32, y: f32, z: f32) -> Option<usize> {
        let i = ((x - self.g0[0]) / self.hc).floor();
        let j = ((y - self.g0[1]) / self.hc).floor();
        let q = ((z - self.g0[2]) / self.hc).floor();
        if i < 0.0 || j < 0.0 || q < 0.0 || i >= self.n[0] as f32 || j >= self.n[1] as f32 || q >= self.n[2] as f32 { return None; }
        Some(i as usize + self.n[0] * (j as usize + self.n[1] * q as usize))
    }
}

/// Runs the detail pass over cache c with the scene desc and writes the result to out.
pub fn run(gpu: &Gpu, c: &Cache, desc: &Desc, o: &DetailOpts, out: &Path, mut progress: impl FnMut(&Progress) -> bool) -> Result<(), String> {
    let (src, nf, b, fps) = (&c.frames, c.frames.len(), c.info.b, c.info.fps);
    if nf < 2 { return Err("The bake needs at least two frames.".into()); }
    let dtf = 1.0 / fps;
    let cd = c.info.meta.get("desc").cloned().unwrap_or(Value::Null);
    let ratio = cd.get("cellRatio").and_then(Value::as_f64).map_or(desc.cell_ratio, |v| v as f32);
    let hc = c.info.d * ratio;
    let k = o.k.clamp(2, 4);
    let df = c.info.d / k as f32;
    let rest_c = ratio.powi(3);
    let r0 = region(&b, o, hc).ok_or("The detail region is too small or outside the tank.")?;
    let spd_k = if c.info.spd_ms { 1.0 / 16.0 / c.info.scale } else { 1.0 / 16.0 };
    let nb_bake = cd.pointer("/nb/on").and_then(Value::as_bool).unwrap_or(false) && cd.pointer("/nb/band").and_then(Value::as_f64).unwrap_or(0.0) < 1e4
        || cd.pointer("/ocean/on").and_then(Value::as_bool).unwrap_or(false);
    let bytes = c.bytes();
    let mut gr = {
        let g0 = [r0.x0 - hc, r0.y0 - hc, r0.z0 - hc];
        let e = r0.size();
        let n = [0, 1, 2].map(|i| (e[i] / hc).ceil() as usize + 2);
        let nc = n[0] * n[1] * n[2];
        Grid { g0, n, hc, cnt: vec![0.0; nc], vel: vec![0.0; nc * 3], deep: vec![0; nc] }
    };
    let occupy = |gr: &mut Grid, fa: usize, fbn: Option<usize>| {
        gr.cnt.fill(0.0); gr.vel.fill(0.0); gr.deep.fill(0);
        let (a, ba) = (&src[fa], c.frame_box(fa));
        for i in 0..a.water.n as usize {
            let (pa, sa, _) = decode_point(bytes, &a.water, a.q, &ba, i);
            if sa == 255 { continue; }
            let Some(ci) = gr.cell_at(pa[0], pa[1], pa[2]) else { continue; };
            gr.cnt[ci] += 1.0;
            if let Some(fb) = fbn {
                let bf = &src[fb];
                if i >= bf.water.n as usize { continue; }
                let (pb, sb, _) = decode_point(bytes, &bf.water, bf.q, &c.frame_box(fb), i);
                if sb == 255 { continue; }
                let v = [(pb[0] - pa[0]) * fps, (pb[1] - pa[1]) * fps, (pb[2] - pa[2]) * fps];
                let u = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
                // a narrow band slot given to another particle: no velocity
                if sa.max(sb) < 191 && u > 2.0 * sa.max(sb) as f32 * spd_k + 2.0 * hc * fps { continue; }
                for q in 0..3 { gr.vel[ci * 3 + q] += v[q]; }
            }
        }
        for ci in 0..gr.cnt.len() { if gr.cnt[ci] > 0.0 { for q in 0..3 { gr.vel[ci * 3 + q] /= gr.cnt[ci]; } } }
        let [nx, ny, nz] = gr.n;
        if let Some(dp) = &a.deep {
            for i in 0..dp.n as usize {
                let (pd, sd, _) = decode_point(bytes, dp, a.q, &ba, i);
                if sd == 255 { continue; }
                if let Some(ci) = gr.cell_at(pd[0], pd[1], pd[2]) { gr.deep[ci] = 1; }
            }
        } else if nb_bake {
            // narrow band without its deep points: under the bottom of the band (a well filled cell) is water, moving with it
            for q in 0..nz { for i in 0..nx {
                let Some(jb) = (0..ny).find(|&j| gr.cnt[i + nx * (j + ny * q)] >= 0.5 * rest_c) else { continue; };
                if jb == 0 { continue; }
                let cb = i + nx * (jb + ny * q);
                for j in 0..jb {
                    let ci = i + nx * (j + ny * q);
                    if gr.g0[1] + (j as f32 + 0.5) * hc < b.y0 || gr.cnt[ci] > 0.0 { continue; }
                    gr.deep[ci] = 1;
                    for w in 0..3 { gr.vel[ci * 3 + w] = gr.vel[cb * 3 + w]; }
                }
            } }
        }
    };
    // how many fine particles the region may hold: the most coarse water it ever had, in fine particles, with room to spare
    let mut most = 0f32;
    for f in 0..nf {
        occupy(&mut gr, f, None);
        let m: f32 = (0..gr.cnt.len()).map(|ci| if gr.deep[ci] != 0 { rest_c } else { gr.cnt[ci].min(rest_c) }).sum();
        most = most.max(m);
    }
    let max_n = (most * (k * k * k) as f32 * 1.3).ceil() as u64 + 65536;
    let lim = gpu.device.limits().max_storage_buffer_binding_size as u64 / if desc.apic { 48 } else { 16 };
    if max_n > lim { return Err(format!("The detail region holds too much water for one GPU buffer here ({:.1}M points). Make it smaller or pick 2x.", max_n as f64 / 1e6)); }
    let max_n = max_n as usize;
    // the fine sim over the region; a side on the tank's wall keeps the tank's wall, the others are open
    let near = |a: f32, w: f32| (a - w).abs() < 0.5 * hc;
    let tank_open = cd.get("open").and_then(Value::as_u64).map_or(desc.open, |v| v as u32);
    let sides = [(r0.x0, b.x0), (r0.x1, b.x1), (r0.y0, b.y0), (r0.y1, b.y1), (r0.z0, b.z0), (r0.z1, b.z1)];
    let open = sides.iter().enumerate().map(|(i, &(r, w))| if !near(r, w) || tank_open & (1 << i) != 0 { 1u32 << i } else { 0 }).sum::<u32>();
    let lay = layout_at(df, ratio, r0.size(), [r0.x0, r0.y0, r0.z0]);
    let mut sim = FlipSim::new(gpu, lay, open, max_n as u32);
    sim.opt.sort = false; sim.opt.ballistic = desc.ballistic; sim.opt.mg = desc.mg; sim.opt.sep = desc.sep; sim.opt.apic = desc.apic;
    let rb = lay.b;
    let hf = sim.h();
    let lw = 2.0 * hc;
    let rs = [rb.x0, rb.x1, rb.y0, rb.y1, rb.z0, rb.z1];
    let open_side: Vec<bool> = (0..6).map(|i| open & (1 << i) != 0 && !near(rs[i], sides[i].1)).collect();
    let in_layer = |x: f32, y: f32, z: f32| (open_side[0] && x - rb.x0 < lw) || (open_side[1] && rb.x1 - x < lw) || (open_side[2] && y - rb.y0 < lw)
        || (open_side[3] && rb.y1 - y < lw) || (open_side[4] && z - rb.z0 < lw) || (open_side[5] && rb.z1 - z < lw);
    let inside = |x: f32, y: f32, z: f32| x >= rb.x0 && x <= rb.x1 && y >= rb.y0 && y <= rb.y1 && z >= rb.z0 && z <= rb.z1;
    let scale = desc.scale;
    let par = |t: f32| StepPar { g: desc.g, iters: desc.iters, flip: desc.flip, apic_flip: desc.apic_flip, comp: desc.comp, vmax: desc.vmax_w, vs: scale, tear: desc.tear, time: t,
        wind: desc.wind, drag: desc.drag, gust: desc.gust, foam_sens: desc.foam_sens, foam_tau: desc.foam_tau, spr: None, air: None, drip: None };
    let sample_all = |t: f32| desc.objs.iter().map(|o| sample(o, t)).collect::<Vec<Obj>>();
    let mut runner = Runner::new(0xde7a);
    let (mut ps, mut vs) = (vec![0f32; max_n * 4], vec![0f32; max_n * 4]);
    let mut dst: Vec<f32> = Vec::new();
    let mut free: Vec<usize> = Vec::new();
    let mut n = 0usize;
    let mut sd: i64 = 12345;
    let mut rnd = move || { sd = (sd * 16807) % 2147483647; sd as f32 / 2147483647.0 };
    // fills the coarse cells chosen by want(centre) with fine particles on a jittered lattice, as full as the coarse water was, moving with it
    let m = (ratio * k as f32).round() as usize;
    let sub_c = hc / m as f32;
    let mut seed = |gr: &Grid, ps: &mut [f32], vs: &mut [f32], n: &mut usize, free: &mut Vec<usize>, want: &dyn Fn(f32, f32, f32) -> bool| {
        let [nx, ny, nz] = gr.n;
        for q in 0..nz { for j in 0..ny { for i in 0..nx {
            let ci = i + nx * (j + ny * q);
            let full = if gr.deep[ci] != 0 { 1.0 } else { (gr.cnt[ci] / rest_c).min(1.0) };
            if full <= 0.0 { continue; }
            let (cx, cy, cz) = (gr.g0[0] + i as f32 * hc, gr.g0[1] + j as f32 * hc, gr.g0[2] + q as f32 * hc);
            if !want(cx + 0.5 * hc, cy + 0.5 * hc, cz + 0.5 * hc) { continue; }
            for c3 in 0..m * m * m {
                if full < 1.0 && rnd() > full { continue; }
                let x = cx + ((c3 % m) as f32 + 0.2 + 0.6 * rnd()) * sub_c;
                let y = cy + (((c3 / m) % m) as f32 + 0.2 + 0.6 * rnd()) * sub_c;
                let z = cz + ((c3 / (m * m)) as f32 + 0.2 + 0.6 * rnd()) * sub_c;
                if !inside(x, y, z) || !want(x, y, z) { continue; }
                let s = if let Some(s) = free.pop() { s } else if *n < max_n { *n += 1; *n - 1 } else { return; };
                ps[s * 4..s * 4 + 4].copy_from_slice(&[x, y, z, 0.0]);
                vs[s * 4..s * 4 + 4].copy_from_slice(&[gr.vel[ci * 3], gr.vel[ci * 3 + 1], gr.vel[ci * 3 + 2], 0.0]);
            }
        } } }
    };
    // the bake's frame with its water inside the region hidden and the fine water after it, laid out as a bake frame
    let hide = |x: f32, y: f32, z: f32| x > rb.x0 && x < rb.x1 && y > rb.y0 && y < rb.y1 && z > rb.z0 && z < rb.z1;
    let na = src.iter().map(|x| x.water.n as usize).max().unwrap_or(0);
    let kq = { let e = b.size(); [65535.0 / e[0], 65535.0 / e[1], 65535.0 / e[2]] };
    let q16 = |p: [f32; 3]| [0, 1, 2].map(|i| ((p[i] - [b.x0, b.y0, b.z0][i]) * kq[i]).round().clamp(0.0, 65535.0) as u16);
    let q_out = compact_bits(&b, df);
    let merge = |f: usize, fine: &[f32], nfine: usize| -> crate::bake::Packed {
        let (a, ba) = (&src[f], c.frame_box(f));
        // the fine water as packFrameBuf has it, 16-bit across the tank
        let ks = 16.0 * scale;
        let mut last = 0;
        for i in 0..nfine { if fine[i * 4 + 1] > -1e5 { last = i + 1; } }
        let total = na + last;
        let (mut pos, mut spd, mut fm) = (vec![0u16; total * 3], vec![255u8; total], vec![0u8; total]);
        for i in 0..a.water.n as usize {
            let (p, s, l) = decode_point(bytes, &a.water, a.q, &ba, i);
            pos[i * 3..i * 3 + 3].copy_from_slice(&q16(p));
            spd[i] = if s == 255 || hide(p[0], p[1], p[2]) { 255 } else { s };
            fm[i] = l * 17;
        }
        for i in 0..last {
            let w = &fine[i * 4..i * 4 + 4];
            let o = na + i;
            if w[1] < -1e5 { continue; }
            pos[o * 3..o * 3 + 3].copy_from_slice(&q16([w[0], w[1], w[2]]));
            let lv = (w[3] / 64.0).floor();
            let sp = (w[3] - lv * 64.0) * ks;
            spd[o] = if sp > 191.0 { 191 } else { sp.max(0.0) as u8 };
            if lv > 0.0 { fm[o] = (lv * 17.0) as u8; }
        }
        // the bake's whitewater as it was (16-bit across the whitewater area), its deep water outside the region
        let ww = a.ww.as_ref().filter(|w| w.n > 0).map(|w| {
            let raw = c.slice(&w.pos);
            let nn = w.n as usize;
            let pos: Vec<u16> = match a.q.or(c.info.q) {
                Some(q) if a.compact() => {
                    let mx = [(1u32 << q[0]) - 1, (1u32 << q[1]) - 1, (1u32 << q[2]) - 1];
                    raw.chunks_exact(4).take(nn).flat_map(|ch| {
                        let v = u32::from_le_bytes(ch.try_into().unwrap());
                        let u = |val: u32, mm: u32| ((val & mm) as f64 / mm as f64 * 65535.0).round() as u16;
                        [u(v, mx[0]), u(v >> q[0], mx[1]), u(v >> (q[0] + q[1]), mx[2])]
                    }).collect()
                }
                _ => bytemuck::pod_collect_to_vec::<u8, u16>(&raw[..nn * 6]),
            };
            let pk: Vec<u32> = bytemuck::pod_collect_to_vec::<u8, u32>(c.slice(&w.pk));
            (nn, pos, pk)
        });
        let deep = a.deep.as_ref().filter(|d| d.n > 0).map(|dp| {
            let nd = dp.n as usize;
            let (mut dpos, mut dspd) = (vec![0u16; nd * 3], vec![0u8; nd]);
            for i in 0..nd {
                let (p, s, _) = decode_point(bytes, dp, a.q, &ba, i);
                dpos[i * 3..i * 3 + 3].copy_from_slice(&q16(p));
                dspd[i] = if s == 255 || hide(p[0], p[1], p[2]) { 255 } else { s };
            }
            (nd, dpos, dspd)
        });
        pack16(pos, spd, fm, total, &b, q_out, df, c.objs(f), Extra { ww, deep })
    };
    let mut meta = c.info.meta.clone();
    let mut w = CacheWriter::create(out, &meta, 64 * 1024 + meta.to_string().len()).map_err(|e| format!("Could not write {}: {e}", out.display()))?;
    let write = |w: &mut CacheWriter, f: usize, p: crate::bake::Packed| -> Result<u32, String> {
        let ww_baked = src[f].flags & splash_format::cache::FLAG_WW_BAKED != 0;
        w.append(&FrameOut { q: p.q, own_box: p.own_box, ww_baked, objs: &p.objs, n: p.n, pos: &p.pos, spd: &p.spd, fm: p.fm.as_deref(),
            ww: p.ww.as_ref().map(|(n, pos, pk)| (*n, &pos[..], &pk[..])), deep: p.deep.as_ref().map(|(n, pos, s)| (*n, &pos[..], &s[..])) })
            .map_err(|e| format!("Writing the cache failed: {e}"))?;
        Ok(p.n)
    };
    let upload = |sim: &mut FlipSim, ps: &[f32], vs: &[f32], n: usize| sim.load(gpu, &ps[..n * 4], &vs[..n * 4]);
    let t0 = Instant::now();
    // frame 0: the region filled from the bake's first frame
    occupy(&mut gr, 0, Some(1));
    seed(&gr, &mut ps, &mut vs, &mut n, &mut free, &|_, _, _| true);
    upload(&mut sim, &ps, &vs, n);
    if n > 0 { sim.prime(gpu, desc.g); }
    sim.readback(gpu, &mut dst);
    let mut max_out = write(&mut w, 0, merge(0, &dst, n))?;
    let mut fine_most = n;
    let mut stopped = false;
    for f in 1..nf {
        let tf0 = Instant::now();
        occupy(&mut gr, f - 1, Some(f));
        // leaving the region or in the boundary layer: gone; inside: pulled towards the coarse water's velocity
        for s in 0..n {
            let o4 = s * 4;
            if ps[o4 + 1] < -1e5 { continue; }
            let (x, y, z) = (ps[o4], ps[o4 + 1], ps[o4 + 2]);
            if !inside(x, y, z) || in_layer(x, y, z) {
                ps[o4..o4 + 4].copy_from_slice(&[0.0, -1e6, 0.0, 0.0]); vs[o4..o4 + 4].copy_from_slice(&[0.0; 4]); free.push(s);
                continue;
            }
            if o.pull > 0.0 {
                if let Some(ci) = gr.cell_at(x, y, z) { if gr.cnt[ci] > 0.0 { for q in 0..3 { vs[o4 + q] += o.pull * (gr.vel[ci * 3 + q] - vs[o4 + q]); } } }
            }
        }
        // the layer again from the bake, with its velocity
        seed(&gr, &mut ps, &mut vs, &mut n, &mut free, &in_layer);
        let mut v2: f32 = 0.0;
        for s in 0..n { let o4 = s * 4; if ps[o4 + 1] < -1e5 { continue; } v2 = v2.max(vs[o4] * vs[o4] + vs[o4 + 1] * vs[o4 + 1] + vs[o4 + 2] * vs[o4 + 2]); }
        let vmax = v2.sqrt().max(1.0);
        upload(&mut sim, &ps, &vs, n);
        let sub = desc.substeps.max(1).max((desc.max_sub.max(8) * k).min((dtf * vmax / (1.5 * hf)).ceil() as u32));
        let dt = dtf / sub as f32;
        for s in 0..sub {
            let t = (f - 1) as f32 * dtf + (s + 1) as f32 * dt;
            runner.step(gpu, &mut sim, dt, &sample_all(t), &par(t), desc.col_max, scale);
        }
        // the fine sim's particles back, velocities too (the next frame starts from them)
        sim.n = n as u32;
        sim.read_vel(gpu, &mut dst);
        vs[..n * 4].copy_from_slice(&dst[..n * 4]);
        sim.readback(gpu, &mut dst);
        ps[..n * 4].copy_from_slice(&dst[..n * 4]);
        max_out = max_out.max(write(&mut w, f, merge(f, &dst, n))?);
        fine_most = fine_most.max(n);
        if !progress(&Progress { f: f as u32, frames: nf as u32 - 1, n: n as u32, elapsed: t0.elapsed().as_secs_f32(), sub, frame_ms: tf0.elapsed().as_secs_f32() * 1000.0, wait: 0.0 }) { stopped = true; break; }
    }
    meta["maxN"] = json!(max_out);
    meta["detail"] = json!({ "box": r0.to_json(), "k": k, "d": df, "pull": o.pull, "maxN": fine_most, "n0": na });
    if stopped { meta["cancelled"] = json!(true); }
    w.finish(&meta).map_err(|e| format!("Finishing the cache failed: {e}"))?;
    Ok(())
}
