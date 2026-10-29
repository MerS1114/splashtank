//! Headless bakes that stream to disk: the page's runBakeFlipGpu (src/flip/bake.js) with its frame packing (packFrameBuf in src/gpu.js,
//! compactFrame / compactFrameBox / markInterior in src/shared.js, onBakeFrame in src/app/09-bake.js). Each finished frame is packed and
//! handed to a writer thread that appends it to the cache file, so memory holds a frame or two, never the whole bake.

use crate::flip::{layout, FlipSim, Rng, StepPar};
use crate::gpu::Gpu;
use crate::runner::Runner;
use crate::scene::{obj_speed, sample, Desc, Fill, Obj};
use crate::sdf;
use serde_json::{json, Value};
use splash_format::{Box3, CacheWriter, FrameOut};
use rayon::prelude::*;
use std::path::Path;
use std::sync::mpsc;
use std::time::Instant;

/// One frame in the cache layout, owned (sent to the writer thread).
pub struct Packed {
    pub q: Option<[u8; 3]>,
    pub own_box: Option<Box3>,
    pub objs: Vec<f32>,
    pub n: u32,
    pub pos: Vec<u8>,
    pub spd: Vec<u8>,
    pub fm: Option<Vec<u8>>,
    pub buried: u32,
}

/// Bits per axis for compact frames across box b at spacing d, or None when a step would be over a quarter of the spacing (compactBits).
pub fn compact_bits(b: &Box3, d: f32) -> Option<[u8; 3]> {
    let e = b.size();
    let s = if e[0] <= e[1] && e[0] <= e[2] { 0 } else if e[1] <= e[2] { 1 } else { 2 };
    let mut q = [11u8; 3];
    q[s] = 10;
    for k in 0..3 { if e[k] / ((1u32 << q[k]) - 1) as f32 > d / 4.0 { return None; } }
    Some(q)
}

fn pack_pos32(pos: &[u16], n: usize, q: [u8; 3]) -> Vec<u32> {
    let k = [0, 1, 2].map(|i| ((1u32 << q[i]) - 1) as f32 / 65535.0);
    let (sy, sz) = (q[0] as u32, (q[0] + q[1]) as u32);
    (0..n).into_par_iter().map(|i| {
        let j = i * 3;
        // JS Math.round rounds halves up; these are non-negative, so (x + 0.5).floor()
        let r = |v: u16, kk: f32| (v as f32 * kk + 0.5).floor() as u32;
        r(pos[j], k[0]) | (r(pos[j + 1], k[1]) << sy) | (r(pos[j + 2], k[2]) << sz)
    }).collect()
}

/// Marks compact water points three cells inside the water (sf bit 12), which no view can see (markInterior). Returns how many.
fn mark_interior(p32: &[u32], sf: &mut [u16], q: [u8; 3], bb: &Box3, d: f32) -> u32 {
    let n = p32.len();
    if n == 0 { return 0; }
    let h = d * 1.25;
    let e = bb.size();
    let dims = [0, 1, 2].map(|k| ((e[k] / h).ceil() as usize).max(1));
    let (nx, ny, nz) = (dims[0], dims[1], dims[2]);
    if nx * ny * nz > 64_000_000 { return 0; }
    let m = [0, 1, 2].map(|k| (1u32 << q[k]) - 1);
    let kk = [0, 1, 2].map(|k| e[k] / h / m[k] as f32);
    let (sy, sz) = (q[0] as u32, (q[0] + q[1]) as u32);
    let mut cell_of = vec![-1i64; n];
    let mut g = vec![0u8; nx * ny * nz];
    for i in 0..n {
        if sf[i] & 255 == 255 { continue; }
        let v = p32[i];
        let x = (((v & m[0]) as f32 * kk[0]) as usize).min(nx - 1);
        let y = ((((v >> sy) & m[1]) as f32 * kk[1]) as usize).min(ny - 1);
        let z = ((((v >> sz) & m[2]) as f32 * kk[2]) as usize).min(nz - 1);
        let c = x + nx * (y + ny * z);
        cell_of[i] = c as i64;
        g[c] = 1;
    }
    let (syy, szz) = (nx, nx * ny);
    for pass in 1..=3u8 {
        for z in 1..nz.saturating_sub(1) { for y in 1..ny.saturating_sub(1) {
            let mut c = 1 + nx * (y + ny * z);
            for _ in 1..nx - 1 {
                if g[c] == pass && g[c - 1] >= pass && g[c + 1] >= pass && g[c - syy] >= pass && g[c + syy] >= pass && g[c - szz] >= pass && g[c + szz] >= pass { g[c] = pass + 1; }
                c += 1;
            }
        } }
    }
    let mut cnt = 0;
    for i in 0..n {
        let c = cell_of[i];
        if c >= 0 && g[c as usize] == 4 { sf[i] |= 4096; cnt += 1; } else { sf[i] &= !4096; }
    }
    cnt
}

/// Particles read back from the sim (x y z, speed + 64 x level in w) to a cache frame: 16-bit positions across the sim box first, as
/// packFrameBuf does, then compact across the box (q) or across the box around this frame's water (compactFrameBox), buried water marked.
pub fn pack_frame(buf: &[f32], n: usize, b: &Box3, q: Option<[u8; 3]>, d: f32, vs: f32, objs: Vec<f32>) -> Packed {
    let ks = 16.0 * vs;
    let mut last: i64 = -1;
    for i in 0..n { if buf[i * 4 + 1] > -1e5 { last = i as i64; } }
    let n = (last + 1) as usize;
    let mut pos = vec![0u16; n * 3];
    let mut spd = vec![0u8; n];
    let mut fm = vec![0u8; n];
    let e = b.size();
    let k = [65535.0 / e[0], 65535.0 / e[1], 65535.0 / e[2]];
    let b0 = [b.x0, b.y0, b.z0];
    let qz = |v: f32, c: usize| ((v - b0[c]) * k[c]).round().clamp(0.0, 65535.0) as u16;
    pos.par_chunks_mut(3).zip(spd.par_iter_mut()).zip(fm.par_iter_mut()).enumerate().for_each(|(i, ((p, s), f))| {
        let i4 = i * 4;
        if buf[i4 + 1] < -1e5 { *s = 255; return; }
        for c in 0..3 { p[c] = qz(buf[i4 + c], c); }
        let w = buf[i4 + 3];
        let lv = (w / 64.0).floor();
        let sp = (w - lv * 64.0) * ks;
        *s = if sp > 191.0 { 191 } else { sp.max(0.0) as u8 };
        if lv > 0.0 { *f = (lv * 17.0) as u8; }
    });
    let any_foam = fm.par_iter().any(|&f| f > 0);
    let to_sf = |spd: &[u8], fm: &[u8]| -> Vec<u16> { spd.par_iter().zip(fm).map(|(&s, &f)| s as u16 | (((f as f32 / 17.0).round() as u16) << 8)).collect() };
    if let Some(q) = q {
        let p32 = pack_pos32(&pos, n, q);
        let mut sf = to_sf(&spd, &fm);
        let buried = mark_interior(&p32, &mut sf, q, b, d);
        return Packed { q: Some(q), own_box: None, objs, n: n as u32, pos: bytemuck::cast_slice(&p32).to_vec(), spd: bytemuck::cast_slice(&sf).to_vec(), fm: None, buried };
    }
    // a tank too big for compact frames: the box around this frame's water, re-measured, with its own bits (compactFrameBox)
    let (mut lo, mut hi) = ([65535u32; 3], [0u32; 3]);
    for i in 0..n { if spd[i] == 255 { continue; } for c in 0..3 { let v = pos[i * 3 + c] as u32; lo[c] = lo[c].min(v); hi[c] = hi[c].max(v); } }
    for c in 0..3 { if hi[c] < lo[c] { lo[c] = 0; hi[c] = 1; } else { lo[c] = lo[c].saturating_sub(1); hi[c] = 65535.min((hi[c] + 1).max(lo[c] + 1)); } }
    let fb = Box3 { x0: b.x0 + lo[0] as f32 / 65535.0 * e[0], x1: b.x0 + hi[0] as f32 / 65535.0 * e[0], y0: b.y0 + lo[1] as f32 / 65535.0 * e[1],
        y1: b.y0 + hi[1] as f32 / 65535.0 * e[1], z0: b.z0 + lo[2] as f32 / 65535.0 * e[2], z1: b.z0 + hi[2] as f32 / 65535.0 * e[2] };
    if let Some(fq) = compact_bits(&fb, d) {
        let re: Vec<u16> = pos.iter().enumerate().map(|(i, &v)| { let c = i % 3; (((v as f32 - lo[c] as f32) * 65535.0 / (hi[c] - lo[c]) as f32).round()).clamp(0.0, 65535.0) as u16 }).collect();
        let p32 = pack_pos32(&re, n, fq);
        let mut sf = to_sf(&spd, &fm);
        let buried = mark_interior(&p32, &mut sf, fq, &fb, d);
        return Packed { q: Some(fq), own_box: Some(fb), objs, n: n as u32, pos: bytemuck::cast_slice(&p32).to_vec(), spd: bytemuck::cast_slice(&sf).to_vec(), fm: None, buried };
    }
    Packed { q: None, own_box: None, objs, n: n as u32, pos: bytemuck::cast_slice(&pos).to_vec(), spd, fm: any_foam.then_some(fm), buried: 0 }
}

/// Per-frame measurements for the bake report, as bakeDiag: where the water is, how fast, how much left or went bad.
pub fn diag(buf: &[f32], n: usize, b: &Box3, vcap: f32) -> Value {
    const H: usize = 16;
    let mut hist = [0u32; H];
    let hy = (b.y1 - b.y0) / H as f32;
    let cap = vcap.min(63.0) * 0.98;
    let e = 1e-3;
    let (mut alive, mut bad, mut out, mut capped, mut foamy) = (0u32, 0u32, 0u32, 0u32, 0u32);
    let (mut sx, mut sy, mut sz, mut ss, mut smax, mut fl) = (0f64, 0f64, 0f64, 0f64, 0f32, 0f64);
    let (mut lo, mut hi) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
    for i in 0..n {
        let p = &buf[i * 4..i * 4 + 4];
        if !p.iter().all(|v| v.is_finite()) { bad += 1; continue; }
        if p[1] < -1e5 { continue; }
        alive += 1;
        let lv = (p[3] / 64.0).floor();
        let sp = p[3] - lv * 64.0;
        sx += p[0] as f64; sy += p[1] as f64; sz += p[2] as f64; ss += sp as f64; smax = smax.max(sp); fl += lv as f64;
        if lv >= 8.0 { foamy += 1; }
        if sp >= cap { capped += 1; }
        if p[0] < b.x0 - e || p[0] > b.x1 + e || p[1] < b.y0 - e || p[1] > b.y1 + e || p[2] < b.z0 - e || p[2] > b.z1 + e { out += 1; }
        for k in 0..3 { lo[k] = lo[k].min(p[k]); hi[k] = hi[k].max(p[k]); }
        hist[(((p[1] - b.y0) / hy).floor() as i64).clamp(0, H as i64 - 1) as usize] += 1;
    }
    let a = alive.max(1) as f64;
    json!({ "alive": alive, "gone": n as u32 - alive - bad, "nonFinite": bad, "outsideBox": out, "atWaterSpeedLimit": capped, "meanSpeed": ss / a, "maxSpeed": smax,
        "meanFoam": fl / a / 15.0, "foamyPoints": foamy, "center": [sx / a, sy / a, sz / a],
        "bbox": if alive > 0 { json!([lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]]) } else { Value::Null }, "heightHist": hist })
}

/// Water on a lattice inside a volume object's mesh (fillVolume).
fn fill_volume(gpu: &Gpu, sim: &mut FlipSim, rng: &mut Rng, f: &Fill) {
    let Fill::Vol { sdf, pos, r, s, lo, hi } = f else { return; };
    let d = sim.d() as f64;
    let j = (0.01 * d / 0.12) as f32;
    let mut y = lo[1] as f64 + d / 2.0;
    while y < hi[1] as f64 {
        let mut x = lo[0] as f64 + d / 2.0;
        while x < hi[0] as f64 {
            let mut z = lo[2] as f64 + d / 2.0;
            while z < hi[2] as f64 {
                let p = [x as f32, y as f32, z as f32];
                if sdf::world(sdf, *pos, r, *s, p)[0] < 0.0 && !sim.add(gpu, [p[0] + (rng.f() - 0.5) * j, p[1] + (rng.f() - 0.5) * j, p[2] + (rng.f() - 0.5) * j], [0.0; 3]) { return; }
                z += d;
            }
            x += d;
        }
        y += d;
    }
}

fn poses(states: &[Obj]) -> Vec<f32> {
    states.iter().flat_map(|o| [o.x, o.y, o.z, o.rx, o.yaw, o.rz]).collect()
}

pub struct Progress { pub f: u32, pub frames: u32, pub n: u32, pub elapsed: f32, pub sub: u32, pub frame_ms: f32 }

/// Bakes desc into a cache file at out. progress is told about every frame; returning false stops the bake (the frames so far stay
/// in the file, which opens like a finished bake).
pub fn run(gpu: &Gpu, desc: &Desc, out: &Path, mut progress: impl FnMut(&Progress) -> bool) -> Result<(), String> {
    let lay = layout(desc.d, desc.cell_ratio, desc.size);
    let lim = (gpu.device.limits().max_storage_buffer_binding_size as u64 / if desc.apic { 48 } else { 16 }) as u32;
    let max_n = desc.max_n.min(lim);
    let mut sim = FlipSim::new(gpu, lay, desc.open, max_n);
    sim.opt.apic = desc.apic; sim.opt.sort = desc.sort; sim.opt.p2g_win = desc.p2g_win; sim.opt.ballistic = desc.ballistic; sim.opt.settle = desc.settle;
    sim.opt.mg = desc.mg; sim.opt.sep = desc.sep;
    let acc = desc.accurate;
    const ACC_TOL: f32 = 0.001;
    let mut iters = desc.iters;
    if acc { sim.opt.sep_iters = 16; }
    let mut runner = Runner::new(0x5eed);
    let mut rng = Rng::new(0xf111);
    for f in &desc.fills {
        match f {
            Fill::Box { x0, x1, y0, y1, z0, z1 } => sim.fill_box(gpu, &mut rng, [*x0, *x1, *y0, *y1, *z0, *z1]),
            Fill::Sphere { x, y, z, r, vy } => sim.fill_sphere(gpu, &mut rng, [*x, *y, *z], *r, [0.0, *vy, 0.0]),
            Fill::Vol { .. } => fill_volume(gpu, &mut sim, &mut rng, f),
        }
    }
    let (fps, frames) = (desc.fps, desc.frames);
    let dtf = 1.0 / fps;
    let cfl = if acc { 0.6 } else { 1.5 };
    let max_sub = desc.substeps.max(if acc { desc.max_sub.max(64) } else { desc.max_sub });
    let mut ev = desc.events.clone();
    ev.sort_by(|a, b| a.t.total_cmp(&b.t));
    let mut ei = 0;
    let sample_all = |t: f32| desc.objs.iter().map(|o| sample(o, t)).collect::<Vec<_>>();
    let mut vmax: f32 = 2.0;
    for o in sample_all(0.0) { if o.emitter { vmax = vmax.max(o.speed); } }

    // the cache header: what the page writes (writeCacheParts), with room reserved for the per-frame measurements
    let q = compact_bits(&lay.b, desc.d);
    let mut meta = json!({ "d": desc.d, "fps": fps, "ids": desc.objs.iter().map(|o| o.id).collect::<Vec<_>>(), "b": lay.b.to_json(),
        "org": { "x": desc.org[0], "y": desc.org[1], "z": desc.org[2] }, "maxN": max_n, "seconds": 0, "engine": "flip", "scene": desc.scene, "desc": desc.light,
        "diag": [], "stableIds": true, "scale": desc.scale, "spdMs": true, "q": q.map(|q| q.to_vec()), "sb": Value::Null });
    let writer = CacheWriter::create(out, &meta, 64 * 1024 + frames as usize * 1200).map_err(|e| format!("Could not write {}: {e}", out.display()))?;
    // Two threads behind the bake: a packer (measurements, compact positions, buried water) and a writer that appends each frame to the
    // file. The GPU runs the next frame's steps meanwhile. At most two frames wait at each, so a slow disk holds the bake back instead of
    // filling memory.
    let (b, d, vs) = (lay.b, desc.d, desc.scale);
    let vmax_w = desc.vmax_w;
    let (tx, rx) = mpsc::sync_channel::<(Vec<f32>, usize, Vec<f32>, Value)>(2);
    let (ptx, prx) = mpsc::sync_channel::<(Packed, Value)>(2);
    let pt = std::thread::spawn(move || {
        for (buf, n, objs, dg) in rx {
            let tp = Instant::now();
            let mut m = diag(&buf, n, &b, vmax_w);
            let p = pack_frame(&buf, n, &b, q, d, vs, objs);
            m["buried"] = json!(p.buried);
            if let (Some(o), Value::Object(t)) = (m.as_object_mut(), dg) { for (k, v) in t { o.insert(k, v); } }
            if let Some(t) = m.get_mut("timing") { t["pack"] = json!(tp.elapsed().as_secs_f32() * 1000.0); }
            if ptx.send((p, m)).is_err() { break; }
        }
    });
    let wt = std::thread::spawn(move || -> Result<(CacheWriter, Vec<Value>), String> {
        let mut w = writer;
        let mut diags = Vec::new();
        for (p, dg) in prx {
            w.append(&FrameOut { q: p.q, own_box: p.own_box, ww_baked: false, objs: &p.objs, n: p.n, pos: &p.pos, spd: &p.spd, fm: p.fm.as_deref(), ww: None, deep: None })
                .map_err(|e| format!("Writing the cache failed: {e}"))?;
            diags.push(dg);
        }
        Ok((w, diags))
    });

    let t0 = Instant::now();
    if sim.n > 0 { sim.prime(gpu, desc.g); }
    let mut buf = Vec::new();
    let mut n = sim.readback(gpu, &mut buf);
    let _ = tx.send((std::mem::take(&mut buf), n as usize, poses(&sample_all(0.0)), json!({ "f": 0, "n": n, "sub": 0, "blockPool": sim.scap, "pointCap": max_n })));
    let mut stopped = !progress(&Progress { f: 0, frames, n, elapsed: 0.0, sub: 0, frame_ms: 0.0 });
    let mut f = 1;
    while f <= frames && !stopped {
        let tf0 = Instant::now();
        let ovf0 = sim.ovf_total;
        let obj_v = obj_speed(&sample_all((f - 1) as f32 * dtf), &sample_all(f as f32 * dtf), dtf, desc.col_max);
        let sub = desc.substeps.max(max_sub.min((dtf * vmax.max(obj_v) / (cfl * sim.h())).ceil() as u32));
        let dt = dtf / sub as f32;
        for s in 0..sub {
            let t = (f - 1) as f32 * dtf + (s + 1) as f32 * dt;
            while ei < ev.len() && ev[ei].t <= t { let e = ev[ei]; ei += 1; sim.fill_sphere(gpu, &mut rng, [e.x, e.y, e.z], e.r, [0.0, -1.0, 0.0]); }
            let par = StepPar { g: desc.g, iters, flip: desc.flip, apic_flip: desc.apic_flip, comp: desc.comp, vmax: desc.vmax_w, vs: desc.scale, tear: desc.tear, time: t };
            runner.step(gpu, &mut sim, dt, &sample_all(t), &par, desc.col_max, desc.scale);
        }
        let t_sub = tf0.elapsed().as_secs_f32();
        let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
        let t_gpu = tf0.elapsed().as_secs_f32();
        n = sim.readback(gpu, &mut buf);
        let t_read = tf0.elapsed().as_secs_f32();
        sim.wait_stats(gpu);
        let mut mv: f32 = 0.0;
        for i in 0..n as usize { mv = mv.max(buf[i * 4 + 3] % 64.0); }
        let st = sim.stats.unwrap_or_default();
        mv = mv.max(st.vmax);
        let states = sample_all(f as f32 * dtf);
        for o in &states { if o.emitter && o.on { mv = mv.max(o.speed); } }
        vmax = mv.max(1.0);
        let mut dg = json!({ "f": f, "n": n, "t": f as f32 / fps, "sub": sub, "objectSpeed": obj_v, "fastestParticle": st.vmax, "fluidCells": st.fluid, "blocksUsed": st.sc,
            "blockPool": sim.scap, "blocksNoRoom": sim.ovf_total - ovf0, "iters": iters });
        if acc {
            // the pressure left unsolved after the frame's last substep steers the next frame's iterations
            let r = sim.pres_residual(gpu);
            dg["unsolved"] = json!(r);
            if r > ACC_TOL { iters = (desc.iters * 8).min((iters as f32 * 1.5).ceil() as u32); } else if r < ACC_TOL / 4.0 { iters = desc.iters.max((iters as f32 * 0.85).floor() as u32); }
        }
        let frame_ms = tf0.elapsed().as_secs_f32() * 1000.0;
        // where the frame's time went (ms): sending the steps, the GPU finishing them, reading the particles back; packing runs alongside
        dg["timing"] = json!({ "send": t_sub * 1000.0, "gpu": (t_gpu - t_sub) * 1000.0, "read": (t_read - t_gpu) * 1000.0 });
        dg["ms"] = json!(frame_ms); dg["elapsed"] = json!(t0.elapsed().as_secs_f32());
        if tx.send((std::mem::take(&mut buf), n as usize, poses(&states), dg)).is_err() { break; }
        stopped = !progress(&Progress { f, frames, n, elapsed: t0.elapsed().as_secs_f32(), sub, frame_ms });
        f += 1;
    }
    drop(tx);
    let _ = pt.join();
    let (w, diags) = wt.join().map_err(|_| "The cache writer stopped.".to_string())??;
    meta["seconds"] = json!(t0.elapsed().as_secs_f64());
    meta["diag"] = Value::Array(diags);
    meta["maxN"] = json!(max_n);
    if stopped { meta["cancelled"] = json!(true); }
    w.finish(&meta).map_err(|e| format!("Finishing the cache failed: {e}"))?;
    Ok(())
}
