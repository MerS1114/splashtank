//! Headless bakes that stream to disk: the page's runBakeFlipGpu (src/flip/bake.js) with its frame packing (packFrameBuf in src/gpu.js,
//! compactFrame / compactFrameBox / markInterior in src/shared.js, onBakeFrame in src/app/09-bake.js). Each finished frame is packed and
//! handed to a writer thread that appends it to the cache file, so memory holds a frame or two, never the whole bake.

use crate::flip::{layout, FlipSim, Rng, StepPar};
use crate::gpu::Gpu;
use crate::{nb, ww};
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
    /// whitewater: count, positions (u32 compact or 3 x u16, across the whitewater area), codes
    pub ww: Option<(u32, Vec<u8>, Vec<u32>)>,
    /// deep water: count, positions, speeds (u16 compact or u8)
    pub deep: Option<(u32, Vec<u8>, Vec<u8>)>,
}

/// A frame's whitewater (16-bit across the whitewater area, codes) and deep water (16-bit across the box, speed bytes) before packing.
pub struct Extra { pub ww: Option<(usize, Vec<u16>, Vec<u32>)>, pub deep: Option<(usize, Vec<u16>, Vec<u8>)> }

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
pub fn pack_frame(buf: &[f32], n: usize, b: &Box3, q: Option<[u8; 3]>, d: f32, vs: f32, objs: Vec<f32>, ex: Extra) -> Packed {
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
    pack16(pos, spd, fm, n, b, q, d, objs, ex)
}

/// A frame already 16-bit across box b (positions, speed bytes with 255 for none, white-water levels times 17) to the cache layout:
/// compact across b (q), or across the box around this frame's water (compactFrameBox), or left 16-bit; buried water marked at spacing d.
pub fn pack16(pos: Vec<u16>, spd: Vec<u8>, fm: Vec<u8>, n: usize, b: &Box3, q: Option<[u8; 3]>, d: f32, objs: Vec<f32>, ex: Extra) -> Packed {
    let e = b.size();
    let any_foam = fm.par_iter().any(|&f| f > 0);
    let to_sf = |spd: &[u8], fm: &[u8]| -> Vec<u16> { spd.par_iter().zip(fm).map(|(&s, &f)| s as u16 | (((f as f32 / 17.0).round() as u16) << 8)).collect() };
    // whitewater keeps its 16-bit positions across the whitewater area; only the bits change (compactFrame)
    let ww_c = |q: [u8; 3]| ex.ww.as_ref().map(|(ns, p, pk)| (*ns as u32, bytemuck::cast_slice(&pack_pos32(p, *ns, q)).to_vec(), pk.clone()));
    let deep_c = |dp: &[u16], nd: usize, ds: &[u8], q: [u8; 3]| {
        let sf: Vec<u16> = ds.iter().map(|&s| s as u16).collect();
        (nd as u32, bytemuck::cast_slice(&pack_pos32(dp, nd, q)).to_vec(), bytemuck::cast_slice(&sf).to_vec())
    };
    if let Some(q) = q {
        let p32 = pack_pos32(&pos, n, q);
        let mut sf = to_sf(&spd, &fm);
        let buried = mark_interior(&p32, &mut sf, q, b, d);
        let deep = ex.deep.as_ref().map(|(nd, dp, ds)| deep_c(dp, *nd, ds, q));
        return Packed { q: Some(q), own_box: None, objs, n: n as u32, pos: bytemuck::cast_slice(&p32).to_vec(), spd: bytemuck::cast_slice(&sf).to_vec(), fm: None, buried, ww: ww_c(q), deep };
    }
    // a tank too big for compact frames: the box around this frame's water and deep water, re-measured, with its own bits (compactFrameBox)
    let (mut lo, mut hi) = ([65535u32; 3], [0u32; 3]);
    for i in 0..n { if spd[i] == 255 { continue; } for c in 0..3 { let v = pos[i * 3 + c] as u32; lo[c] = lo[c].min(v); hi[c] = hi[c].max(v); } }
    if let Some((nd, dp, ds)) = &ex.deep { for i in 0..*nd { if ds[i] == 255 { continue; } for c in 0..3 { let v = dp[i * 3 + c] as u32; lo[c] = lo[c].min(v); hi[c] = hi[c].max(v); } } }
    for c in 0..3 { if hi[c] < lo[c] { lo[c] = 0; hi[c] = 1; } else { lo[c] = lo[c].saturating_sub(1); hi[c] = 65535.min((hi[c] + 1).max(lo[c] + 1)); } }
    let fb = Box3 { x0: b.x0 + lo[0] as f32 / 65535.0 * e[0], x1: b.x0 + hi[0] as f32 / 65535.0 * e[0], y0: b.y0 + lo[1] as f32 / 65535.0 * e[1],
        y1: b.y0 + hi[1] as f32 / 65535.0 * e[1], z0: b.z0 + lo[2] as f32 / 65535.0 * e[2], z1: b.z0 + hi[2] as f32 / 65535.0 * e[2] };
    if let Some(fq) = compact_bits(&fb, d) {
        let re = |p: &[u16]| -> Vec<u16> { p.par_iter().enumerate().map(|(i, &v)| { let c = i % 3; (((v as f32 - lo[c] as f32) * 65535.0 / (hi[c] - lo[c]) as f32).round()).clamp(0.0, 65535.0) as u16 }).collect() };
        let p32 = pack_pos32(&re(&pos), n, fq);
        let mut sf = to_sf(&spd, &fm);
        let buried = mark_interior(&p32, &mut sf, fq, &fb, d);
        let deep = ex.deep.as_ref().map(|(nd, dp, ds)| deep_c(&re(dp), *nd, ds, fq));
        return Packed { q: Some(fq), own_box: Some(fb), objs, n: n as u32, pos: bytemuck::cast_slice(&p32).to_vec(), spd: bytemuck::cast_slice(&sf).to_vec(), fm: None, buried, ww: ww_c(fq), deep };
    }
    let ww = ex.ww.map(|(ns, p, pk)| (ns as u32, bytemuck::cast_slice(&p).to_vec(), pk));
    let deep = ex.deep.map(|(nd, p, s)| (nd as u32, bytemuck::cast_slice(&p).to_vec(), s));
    Packed { q: None, own_box: None, objs, n: n as u32, pos: bytemuck::cast_slice(&pos).to_vec(), spd, fm: any_foam.then_some(fm), buried: 0, ww, deep }
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

/// What the GPU handed back besides the water: every whitewater slot used (count, positions with life, velocities with kind) and the
/// deep water points.
pub struct Raw { pub spray: Option<(usize, Vec<f32>, Vec<f32>)>, pub deep: Option<Vec<f32>> }

/// A frame done. wait: seconds the bake has waited in all for the packer and the disk to take its frames.
pub struct Progress { pub f: u32, pub frames: u32, pub n: u32, pub elapsed: f32, pub sub: u32, pub frame_ms: f32, pub wait: f32 }

/// How a bake runs besides its scene: checkpoints for resuming after a crash.
#[derive(Clone, Default)]
pub struct RunOpts {
    /// write a checkpoint about this often, in seconds of baking (0: never)
    pub checkpoint_secs: f32,
    /// carry on from the checkpoint next to out instead of starting again
    pub resume: bool,
    /// what the bake was started with, kept in the checkpoint so resuming needs nothing else
    pub started_with: Value,
    /// where the bake's remarks go (Max points chosen, checkpoints written); the terminal when None
    pub log: Option<std::sync::Arc<dyn Fn(&str) + Send + Sync>>,
}
impl RunOpts {
    fn say(&self, s: &str) { match &self.log { Some(l) => l(s), None => eprintln!("{s}") } }
}

/// Where a bake's checkpoint lives: next to its cache.
pub fn checkpoint_path(out: &Path) -> std::path::PathBuf { out.with_extension("splc.ckpt") }

/// A checkpoint file: the buffers' bytes, then the JSON that says what they are and the bake's own state, then its length and "SPCK".
pub fn read_checkpoint(path: &Path) -> Result<(Value, std::io::BufReader<std::fs::File>), String> {
    use std::io::{Read, Seek, SeekFrom};
    let e = |x: std::io::Error| format!("Could not read the checkpoint {}: {x}", path.display());
    let mut f = std::fs::File::open(path).map_err(e)?;
    let len = f.metadata().map_err(e)?.len();
    if len < 12 { return Err(format!("{} is not a checkpoint.", path.display())); }
    f.seek(SeekFrom::Start(len - 12)).map_err(e)?;
    let mut tail = [0u8; 12];
    f.read_exact(&mut tail).map_err(e)?;
    if &tail[8..] != b"SPCK" { return Err(format!("{} is not a checkpoint (or was cut short while being written).", path.display())); }
    let jl = u64::from_le_bytes(tail[..8].try_into().unwrap());
    f.seek(SeekFrom::Start(len - 12 - jl)).map_err(e)?;
    let mut js = vec![0u8; jl as usize];
    f.read_exact(&mut js).map_err(e)?;
    let v: Value = serde_json::from_slice(&js).map_err(|x| format!("The checkpoint is damaged: {x}"))?;
    f.seek(SeekFrom::Start(0)).map_err(e)?;
    Ok((v, std::io::BufReader::with_capacity(8 << 20, f)))
}

/// The free video memory in MB, from the NVIDIA driver's nvidia-smi (this program is built for Mer's NVIDIA card); None if it cannot say.
pub fn free_vram_mb() -> Option<u64> {
    let o = std::process::Command::new("nvidia-smi").args(["--query-gpu=memory.free", "--format=csv,noheader,nounits"]).output().ok()?;
    String::from_utf8_lossy(&o.stdout).lines().next()?.trim().parse().ok()
}

/// About how much video memory a bake with Max points max_n takes: per particle its position, velocity, number, APIC rows and the
/// readback copy; the block pool when its water sits packed (gridCost's estimate); whitewater with its readback copy; a margin.
pub fn estimate_bytes(max_n: u64, apic: bool, ratio: f32, spray_cap: u64) -> u64 {
    let per = 16 + 16 + 4 + 16 + if apic { 48 } else { 0 };
    let blocks = (max_n as f64 / (ratio as f64).powi(3) / 512.0 * 2.5).ceil() as u64;
    max_n * per + blocks * (512 * 72 + 12) + spray_cap * (16 * 4 + 4) + (300 << 20)
}

/// What the bake loop needs from the frame writer: frames to write, or a request to write out everything so far and say where the file
/// ends (for a checkpoint).
enum Job { Frame(Vec<f32>, usize, Vec<f32>, Value, Raw), Mark(mpsc::Sender<(u64, u32, Vec<Value>)>) }
enum Out { Frame(Packed, Value), Mark(mpsc::Sender<(u64, u32, Vec<Value>)>) }

/// Bakes desc into a cache file at out. progress is told about every frame; returning false stops the bake (the frames so far stay
/// in the file, which opens like a finished bake). With ro.checkpoint_secs, a checkpoint is written next to the cache that often; with
/// ro.resume, the bake carries on from it.
pub fn run(gpu: &Gpu, desc: &Desc, out: &Path, ro: &RunOpts, mut progress: impl FnMut(&Progress) -> bool) -> Result<(), String> {
    let lay = layout(desc.d, desc.cell_ratio, desc.size);
    let lim = (gpu.device.limits().max_storage_buffer_binding_size as u64 / if desc.apic { 48 } else { 16 }) as u32;
    let ck_path = checkpoint_path(out);
    let resume = if ro.resume { Some(read_checkpoint(&ck_path)?) } else { None };
    let mut max_n = desc.max_n.min(lim);
    // narrow band: the starting band must fit, or the seed stops partway across the tank and the water there drains away
    let nb_band = if desc.nb.is_some() || desc.ocean.is_some() { Some(desc.nb.unwrap_or(3.0)) } else { None };
    let ocean_w = desc.ocean.map(|oc| nb::waves(&oc, desc.g as f64, oc.level - lay.b.y0 as f64)).unwrap_or_default();
    let oc = desc.ocean.as_ref().map(|c| (c, &ocean_w[..]));
    let mut need = 0u64;
    let free = free_vram_mb();
    if let Some((v, _)) = &resume {
        max_n = v["maxN"].as_u64().unwrap_or(max_n as u64) as u32;
        need = v["need"].as_u64().unwrap_or(0);
    } else if let Some(band) = nb_band {
        let s = nb::seed(&lay, &desc.fills, band, oc, 0.0, &mut |_, _| true);
        need = s.seeded + nb::spares(s.seeded);
        if need > lim as u64 { return Err(format!("The starting water needs {:.1}M points, more than one GPU buffer holds here ({:.1}M). Use less detail, a coarser spacing or a thinner narrow band.", need as f64 / 1e6, lim as f64 / 1e6)); }
        // Max points for the band to refill from: the page raises it to 1.3 times the starting water, but the band asks for about twice
        // that after an impact (on Mer's ocean at 0.012, 10.5 to 12M against 6.2M at the start), and when it runs out the refill goes
        // where the GPU happens to list cells first. So, unless Max points was given, 2.5 times the start, as far as the card's free
        // memory and one buffer allow.
        if !desc.max_n_set {
            let mut want = (need as f64 * 2.5).ceil() as u64;
            if let Some(mb) = free {
                let per = (estimate_bytes(1 << 20, desc.apic, desc.cell_ratio, 0) - estimate_bytes(0, desc.apic, desc.cell_ratio, 0)) as f64 / (1 << 20) as f64;
                let room = (mb as f64 * 1048576.0 * 0.85 - estimate_bytes(0, desc.apic, desc.cell_ratio, desc.spray_cap as u64) as f64).max(0.0);
                want = want.min((room / per) as u64).max((need as f64 * 1.3).ceil() as u64);
            }
            max_n = (max_n as u64).max(want).min(lim as u64) as u32;
            ro.say(&format!("Max points {:.1}M: the starting water needs {:.1}M, and the narrow band refills from the rest", max_n as f64 / 1e6, need as f64 / 1e6));
        } else if need as f64 * 1.15 > max_n as f64 { max_n = lim.min((need as f64 * 1.3).ceil() as u32); }
    }
    // the card must hold it: say so before baking rather than fail partway
    let est = estimate_bytes(max_n as u64, desc.apic, desc.cell_ratio, desc.spray_cap as u64);
    if let Some(mb) = free {
        if est > mb << 20 { return Err(format!("This bake needs about {:.1} GB of video memory and {:.1} GB is free. Lower Max points or Max whitewater, or use a coarser spacing.", est as f64 / 1e9, mb as f64 / 1024.0)); }
    }
    let mut sim = FlipSim::new(gpu, lay, desc.open, max_n);
    sim.opt.apic = desc.apic; sim.opt.sort = desc.sort; sim.opt.p2g_win = desc.p2g_win; sim.opt.ballistic = desc.ballistic; sim.opt.settle = desc.settle;
    sim.opt.mg = desc.mg; sim.opt.sep = desc.sep;
    let acc = desc.accurate;
    const ACC_TOL: f32 = 0.001;
    let mut iters = desc.iters;
    if acc { sim.opt.sep_iters = 16; }
    if desc.spr.is_some() && desc.spray_cap > 0 { sim.set_spray_cap(gpu, desc.spray_cap); }
    if desc.nb_look { sim.set_deep_look(gpu, true); }
    let mut runner = Runner::new(0x5eed);
    let mut rng = Rng::new(0xf111);
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
    // whitewater positions are across the whitewater area
    let ab = desc.spr.map(|s| crate::flip::ww_area_box(&lay.b, s.area[0], s.area[1])).unwrap_or(lay.b);
    let sb = if sim.spray_cap > 0 { ab.to_json() } else { Value::Null };
    let mut meta = json!({ "d": desc.d, "fps": fps, "ids": desc.objs.iter().map(|o| o.id).collect::<Vec<_>>(), "b": lay.b.to_json(),
        "org": { "x": desc.org[0], "y": desc.org[1], "z": desc.org[2] }, "maxN": max_n, "seconds": 0, "engine": "flip", "scene": desc.scene, "desc": desc.light,
        "diag": [], "stableIds": true, "scale": desc.scale, "spdMs": true, "q": q.map(|q| q.to_vec()), "sb": sb });

    let mut f = 1;
    let mut elapsed0 = 0.0f64;
    let mut diags0 = Vec::new();
    let writer = match &resume {
        None => CacheWriter::create(out, &meta, 64 * 1024 + frames as usize * 1200).map_err(|e| format!("Could not write {}: {e}", out.display()))?,
        Some((v, _)) => {
            let fw = v["framesWritten"].as_u64().ok_or("The checkpoint is damaged (frames).")? as u32;
            diags0 = v["diags"].as_array().cloned().unwrap_or_default();
            f = v["frame"].as_u64().unwrap_or(0) as u32 + 1;
            elapsed0 = v["elapsed"].as_f64().unwrap_or(0.0);
            CacheWriter::reopen(out, fw, v["fileEnd"].as_u64().ok_or("The checkpoint is damaged (file end).")?)
                .map_err(|e| format!("Could not carry on writing {}: {e}", out.display()))?
        }
    };
    // Two threads behind the bake: a packer (measurements, compact positions, buried water) and a writer that appends each frame to the
    // file. The GPU runs the next frame's steps meanwhile. At most two frames wait at each, so a slow disk holds the bake back instead of
    // filling memory (the time the bake waits for them is measured).
    let (b, d, vs) = (lay.b, desc.d, desc.scale);
    let vmax_w = desc.vmax_w;
    let foam_life = desc.spr.map_or(3.0, |s| s.foam_life);
    let (tx, rx) = mpsc::sync_channel::<Job>(2);
    let (ptx, prx) = mpsc::sync_channel::<Out>(2);
    let pt = std::thread::spawn(move || {
        for job in rx {
            let Job::Frame(buf, n, objs, dg, raw) = job else { if let Job::Mark(s) = job { if ptx.send(Out::Mark(s)).is_err() { break; } } continue; };
            let tp = Instant::now();
            let mut m = diag(&buf, n, &b, vmax_w);
            let ww = raw.spray.map(|(ns, p, v)| { let (k, pos, pk, alive) = ww::pack_spray_frame(&p, &v, ns, &ab, 200_000, foam_life); m["sprayPoints"] = json!(alive); (k, pos, pk) });
            let deep = raw.deep.map(|a| { let (k, pos, spd) = ww::pack_deep(&a, a.len() / 4, &b, vs); m["deepPoints"] = json!(k); (k, pos, spd) });
            let p = pack_frame(&buf, n, &b, q, d, vs, objs, Extra { ww, deep });
            m["buried"] = json!(p.buried);
            if let (Some(o), Value::Object(t)) = (m.as_object_mut(), dg) { for (k, v) in t { o.insert(k, v); } }
            if let Some(t) = m.get_mut("timing") { t["pack"] = json!(tp.elapsed().as_secs_f32() * 1000.0); }
            if ptx.send(Out::Frame(p, m)).is_err() { break; }
        }
    });
    let wt = std::thread::spawn(move || -> Result<(CacheWriter, Vec<Value>), String> {
        let mut w = writer;
        let mut diags = diags0;
        for o in prx {
            match o {
                Out::Frame(p, dg) => {
                    w.append(&FrameOut { q: p.q, own_box: p.own_box, ww_baked: false, objs: &p.objs, n: p.n, pos: &p.pos, spd: &p.spd, fm: p.fm.as_deref(),
                        ww: p.ww.as_ref().map(|(n, pos, pk)| (*n, &pos[..], &pk[..])), deep: p.deep.as_ref().map(|(n, pos, s)| (*n, &pos[..], &s[..])) })
                        .map_err(|e| format!("Writing the cache failed: {e}"))?;
                    diags.push(dg);
                }
                Out::Mark(s) => { let end = w.flush_point().map_err(|e| format!("Writing the cache failed: {e}"))?; let _ = s.send((end, w.frames(), diags.clone())); }
            }
        }
        Ok((w, diags))
    });

    let t0 = Instant::now();
    let since = |t0: &Instant| elapsed0 + t0.elapsed().as_secs_f64();
    let mut buf = Vec::new();
    let mut n;
    let mut wait = 0.0f64;
    let mut stopped = false;
    match resume {
        None => {
            if let Some(band) = nb_band {
                let j = (0.01 * lay.d as f64 / 0.12) as f32;
                let s = {
                    let sim = &mut sim;
                    let rng = &mut rng;
                    nb::seed(&lay, &desc.fills, band, oc, 0.0, &mut |p, v| sim.add(gpu, [p[0] + (rng.f() - 0.5) * j, p[1] + (rng.f() - 0.5) * j, p[2] + (rng.f() - 0.5) * j], v))
                };
                // spare slots, parked off the map, for the solver to refill the band with
                let spare = ((sim.cap - sim.n) as u64).min(nb::spares(s.seeded));
                for _ in 0..spare { sim.add(gpu, [0.0, -1e6, 0.0], [0.0; 3]); }
                sim.nb_fills = s.prims; sim.nb_vols = s.vols; sim.nb_init = 1; sim.nb_band = Some(band); sim.ocean = desc.ocean; sim.ocean_w = ocean_w.clone();
            } else {
                for fl in &desc.fills {
                    match fl {
                        Fill::Box { x0, x1, y0, y1, z0, z1 } => sim.fill_box(gpu, &mut rng, [*x0, *x1, *y0, *y1, *z0, *z1]),
                        Fill::Sphere { x, y, z, r, vy } => sim.fill_sphere(gpu, &mut rng, [*x, *y, *z], *r, [0.0, *vy as f32, 0.0]),
                        Fill::Vol { .. } => fill_volume(gpu, &mut sim, &mut rng, fl),
                    }
                }
            }
            if sim.n > 0 { sim.prime(gpu, desc.g); }
            n = sim.readback(gpu, &mut buf);
            let _ = tx.send(Job::Frame(std::mem::take(&mut buf), n as usize, poses(&sample_all(0.0)),
                json!({ "f": 0, "n": n, "sub": 0, "blockPool": sim.scap, "pointCap": max_n, "startNeed": need, "gpuMB": sim.mem_bytes() >> 20 }), Raw { spray: None, deep: None }));
            stopped = !progress(&Progress { f: 0, frames, n, elapsed: 0.0, sub: 0, frame_ms: 0.0, wait: 0.0 });
        }
        Some((v, mut r)) => {
            sim.restore_state(gpu, &v["sim"], &mut r)?;
            runner.restore_state(&v["runner"]);
            rng = Rng(v["rng"].as_u64().unwrap_or(0xf111));
            vmax = v["vmax"].as_f64().unwrap_or(2.0) as f32;
            iters = v["iters"].as_u64().unwrap_or(desc.iters as u64) as u32;
            ei = v["ei"].as_u64().unwrap_or(0) as usize;
        }
    }
    let par_of = |iters: u32, t: f32| StepPar { g: desc.g, iters, flip: desc.flip, apic_flip: desc.apic_flip, comp: desc.comp, vmax: desc.vmax_w, vs: desc.scale, tear: desc.tear, time: t,
        wind: desc.wind, drag: desc.drag, gust: desc.gust, foam_sens: desc.foam_sens, foam_tau: desc.foam_tau, spr: desc.spr, air: desc.air, drip: desc.drip };
    // checkpoints are spaced so writing them takes at most a tenth of the bake (a slow drive takes minutes for a big one)
    let (mut last_ck, mut ck_gap) = (Instant::now(), ro.checkpoint_secs);
    while f <= frames && !stopped {
        let tf0 = Instant::now();
        let ovf0 = sim.ovf_total;
        let obj_v = obj_speed(&sample_all((f - 1) as f32 * dtf), &sample_all(f as f32 * dtf), dtf, desc.col_max);
        let sub = desc.substeps.max(max_sub.min((dtf * vmax.max(obj_v) / (cfl * sim.h())).ceil() as u32));
        let dt = dtf / sub as f32;
        for s in 0..sub {
            let t = (f - 1) as f32 * dtf + (s + 1) as f32 * dt;
            while ei < ev.len() && ev[ei].t <= t { let e = ev[ei]; ei += 1; sim.fill_sphere(gpu, &mut rng, [e.x, e.y, e.z], e.r, [0.0, -1.0, 0.0]); }
            runner.step(gpu, &mut sim, dt, &sample_all(t), &par_of(iters, t), desc.col_max, desc.scale);
        }
        let t_sub = tf0.elapsed().as_secs_f32();
        let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
        let t_gpu = tf0.elapsed().as_secs_f32();
        n = sim.readback(gpu, &mut buf);
        let raw = Raw { spray: sim.read_spray(gpu), deep: if desc.nb_look { sim.read_deep(gpu) } else { None } };
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
            "blockPool": sim.scap, "blocksNoRoom": sim.ovf_total - ovf0, "iters": iters, "gpuMB": sim.mem_bytes() >> 20 });
        if acc {
            // the pressure left unsolved after the frame's last substep steers the next frame's iterations
            let r = sim.pres_residual(gpu);
            dg["unsolved"] = json!(r);
            if r > ACC_TOL { iters = (desc.iters * 8).min((iters as f32 * 1.5).ceil() as u32); } else if r < ACC_TOL / 4.0 { iters = desc.iters.max((iters as f32 * 0.85).floor() as u32); }
        }
        // where the frame's time went (ms): sending the steps, the GPU finishing them, reading the particles back; packing runs alongside.
        // waitDisk: how long this frame waited for the packer and the disk to take it (a slow drive holds the whole bake back)
        let tw = Instant::now();
        dg["timing"] = json!({ "send": t_sub * 1000.0, "gpu": (t_gpu - t_sub) * 1000.0, "read": (t_read - t_gpu) * 1000.0 });
        dg["ms"] = json!(tf0.elapsed().as_secs_f32() * 1000.0); dg["elapsed"] = json!(since(&t0));
        if tx.send(Job::Frame(std::mem::take(&mut buf), n as usize, poses(&states), dg, raw)).is_err() { break; }
        let w1 = tw.elapsed().as_secs_f64();
        wait += w1;
        stopped = !progress(&Progress { f, frames, n, elapsed: since(&t0) as f32, sub, frame_ms: tf0.elapsed().as_secs_f32() * 1000.0, wait: wait as f32 });
        // a checkpoint: once the frame is in the file, the GPU state and the bake's own state next to it; also when stopped, so a
        // stopped bake can always carry on
        if ro.checkpoint_secs > 0.0 && f < frames && (stopped || last_ck.elapsed().as_secs_f32() >= ck_gap) {
            let tc = Instant::now();
            let (ms, mr) = mpsc::channel();
            if tx.send(Job::Mark(ms)).is_err() { break; }
            let (end, fw, diags) = mr.recv().map_err(|_| "The cache writer stopped.".to_string())?;
            let st = json!({ "version": 1, "startedWith": ro.started_with, "checkpointEvery": ro.checkpoint_secs, "frame": f, "framesWritten": fw, "fileEnd": end, "diags": diags, "maxN": max_n, "need": need,
                "elapsed": since(&t0), "rng": rng.0, "vmax": vmax, "iters": iters, "ei": ei, "runner": runner.save_state() });
            write_checkpoint(gpu, &sim, st, &ck_path)?;
            let took = tc.elapsed().as_secs_f32();
            ck_gap = ro.checkpoint_secs.max(10.0 * took);
            if stopped { ro.say(&format!("Stopped; checkpoint after frame {f} written in {took:.1} s, so it can carry on")); } else { ro.say(&format!("Checkpoint after frame {f} in {took:.1} s; the next in {ck_gap:.0} s")); }
            last_ck = Instant::now();
        }
        f += 1;
    }
    drop(tx);
    let _ = pt.join();
    let (w, diags) = wt.join().map_err(|_| "The cache writer stopped.".to_string())??;
    meta["seconds"] = json!(since(&t0));
    meta["diag"] = Value::Array(diags);
    meta["maxN"] = json!(max_n);
    if stopped { meta["cancelled"] = json!(true); }
    w.finish(&meta).map_err(|e| format!("Finishing the cache failed: {e}"))?;
    // a finished bake needs no checkpoint (a stopped one keeps it, to carry on later)
    if !stopped { let _ = std::fs::remove_file(&ck_path); }
    Ok(())
}

/// Writes the sim's buffers and then st with the sim's own state, into a new file that replaces the old checkpoint only when complete.
fn write_checkpoint(gpu: &Gpu, sim: &FlipSim, mut st: Value, path: &Path) -> Result<(), String> {
    use std::io::Write;
    let tmp = path.with_extension("ckpt.tmp");
    let e = |x: std::io::Error| format!("Could not write the checkpoint {}: {x}", tmp.display());
    let mut w = std::io::BufWriter::with_capacity(8 << 20, std::fs::File::create(&tmp).map_err(e)?);
    st["sim"] = sim.save_state(gpu, &mut w).map_err(e)?;
    let js = serde_json::to_vec(&st).map_err(|x| x.to_string())?;
    w.write_all(&js).map_err(e)?;
    w.write_all(&(js.len() as u64).to_le_bytes()).map_err(e)?;
    w.write_all(b"SPCK").map_err(e)?;
    let file = w.into_inner().map_err(|x| e(x.into_error()))?;
    file.sync_all().map_err(e)?;
    drop(file);
    std::fs::rename(&tmp, path).map_err(|x| format!("Could not replace the checkpoint {}: {x}", path.display()))
}

/// Whitewater made afterwards from a finished water bake (Bake whitewater, runWhitewaterPass): the water is not simulated again. For each
/// baked frame the particles are loaded with the velocity worked out from where they are in the next frame (a bake keeps every particle
/// in its place), deep water points are loaded as still water so the grid knows the water is there, and the whitewater stages run over
/// the frame in substeps while the particles move on towards the next frame. Writes a copy of the cache at out with the water as it was
/// and each frame's whitewater replaced. desc: the scene (colliders, whitewater settings).
pub fn whitewater_pass(gpu: &Gpu, c: &splash_format::Cache, desc: &Desc, out: &Path, mut progress: impl FnMut(&Progress) -> bool) -> Result<(), String> {
    use splash_format::cache::decode_point;
    let (fr, nf, fps) = (&c.frames, c.frames.len(), c.info.fps);
    let spr = desc.spr.ok_or("Whitewater is off in this scene (Whitewater > Enabled).")?;
    if nf < 2 || desc.spray_cap == 0 { return Err("Nothing to do: the bake needs at least two frames and room for whitewater.".into()); }
    let dtf = 1.0 / fps;
    let cd = c.info.meta.get("desc").cloned().unwrap_or(Value::Null);
    let ratio = cd.get("cellRatio").and_then(Value::as_f64).map_or(desc.cell_ratio, |v| v as f32);
    let size = cd.get("size").and_then(Value::as_array).filter(|a| a.len() == 3).map(|a| [0, 1, 2].map(|k| a[k].as_f64().unwrap_or(1.0) as f32)).unwrap_or(desc.size);
    let open = cd.get("open").and_then(Value::as_u64).map_or(desc.open, |v| v as u32);
    // a deep cell holds as many particles as a full water cell
    let copies = (ratio.powi(3).round() as usize).clamp(1, 8);
    let max_d = fr.iter().map(|f| f.deep.as_ref().map_or(0, |d| d.n as usize)).max().unwrap_or(0);
    let max_w = fr.iter().map(|f| f.water.n as usize).max().unwrap_or(0);
    let lay = layout(c.info.d, ratio, size);
    let mut sim = FlipSim::new(gpu, lay, open, (max_w + max_d * copies + 16) as u32);
    sim.opt.sort = false;
    sim.ww_only = true;
    sim.set_spray_cap(gpu, desc.spray_cap);
    let mut runner = Runner::new(0x5eed);
    let h = sim.h();
    let scale = desc.scale;
    let spd_k = if c.info.spd_ms { 1.0 / 16.0 / c.info.scale } else { 1.0 / 16.0 };
    let jit = h * 0.25;
    let meshes: Vec<&Obj> = desc.objs.iter().filter(|o| !o.emitter).collect();
    let par = |t: f32| StepPar { g: desc.g, iters: 1, flip: 0.95, apic_flip: 0.0, comp: 6.0, vmax: desc.vmax_w, vs: scale, tear: 0.0, time: t,
        wind: desc.wind, drag: desc.drag, gust: desc.gust, foam_sens: desc.foam_sens, foam_tau: desc.foam_tau, spr: Some(spr), air: desc.air, drip: desc.drip };
    let ab = crate::flip::ww_area_box(&lay.b, spr.area[0], spr.area[1]);
    let mut meta = c.info.meta.clone();
    meta["sb"] = ab.to_json();
    let mut w = CacheWriter::create(out, &meta, 64 * 1024 + meta.to_string().len()).map_err(|e| format!("Could not write {}: {e}", out.display()))?;
    let bytes = c.bytes();
    // a frame copied as it is, with new whitewater (16-bit across the whitewater area; compact with the frame's bits)
    let write = |w: &mut CacheWriter, f: usize, ww: Option<(usize, Vec<u16>, Vec<u32>)>| -> Result<(), String> {
        let x = &fr[f];
        let fq = x.q;
        let ww: Option<(u32, Vec<u8>, Vec<u32>)> = ww.filter(|s| s.0 > 0).map(|(n, p, pk)| match fq {
            Some(q) => (n as u32, bytemuck::cast_slice(&pack_pos32(&p, n, q)).to_vec(), pk),
            None => (n as u32, bytemuck::cast_slice(&p).to_vec(), pk),
        });
        let objs = c.objs(f);
        w.append(&FrameOut { q: x.q, own_box: x.own_box, ww_baked: true, objs: &objs, n: x.water.n, pos: c.slice(&x.water.pos), spd: c.slice(&x.water.spd),
            fm: x.water.fm.as_ref().map(|r| c.slice(r)), ww: ww.as_ref().map(|(n, p, pk)| (*n, &p[..], &pk[..])),
            deep: x.deep.as_ref().map(|d| (d.n, c.slice(&d.pos), c.slice(&d.spd))) }).map_err(|e| format!("Writing the cache failed: {e}"))
    };
    write(&mut w, 0, None)?;
    let t0 = Instant::now();
    let (mut ps, mut vs) = (Vec::new(), Vec::new());
    let mut stopped = false;
    for f in 1..nf {
        let tf0 = Instant::now();
        let (a, bf) = (&fr[f - 1], &fr[f]);
        let (ba, bb) = (c.frame_box(f - 1), c.frame_box(f));
        ps.clear(); vs.clear();
        let mut vmax: f32 = 0.0;
        for i in 0..a.water.n as usize {
            let (pa, sa, la) = decode_point(bytes, &a.water, a.q, &ba, i);
            if sa == 255 { ps.extend_from_slice(&[0.0, -1e6, 0.0, 0.0]); vs.extend_from_slice(&[0.0; 4]); continue; }
            let mut v = [0f32; 3];
            if i < bf.water.n as usize {
                let (pb, sb, _) = decode_point(bytes, &bf.water, bf.q, &bb, i);
                if sb != 255 {
                    v = [(pb[0] - pa[0]) * fps, (pb[1] - pa[1]) * fps, (pb[2] - pa[2]) * fps];
                    // a slot the narrow band gave to another particle jumps further than either speed allows: no velocity for that frame
                    let u = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
                    let s = sa.max(sb) as f32 * spd_k;
                    if sa.max(sb) < 191 && u > 2.0 * s + 2.0 * h * fps { v = [0.0; 3]; }
                }
            }
            ps.extend_from_slice(&[pa[0], pa[1], pa[2], 0.0]);
            // the white-water level the bake gave it (impacts, churn)
            vs.extend_from_slice(&[v[0], v[1], v[2], la as f32 / 15.0]);
            vmax = vmax.max(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        }
        if let Some(dp) = &a.deep {
            for i in 0..dp.n as usize {
                let (pd, sd, _) = decode_point(bytes, dp, a.q, &ba, i);
                if sd == 255 { continue; }
                for m in 0..copies {
                    let o = |bit: usize| if m & bit != 0 { jit } else { -jit };
                    ps.extend_from_slice(&[pd[0] + o(1), pd[1] + o(2), pd[2] + o(4), 0.0]);
                    vs.extend_from_slice(&[0.0; 4]);
                }
            }
        }
        sim.load(gpu, &ps, &vs);
        let sub = ((dtf * vmax.sqrt() / (1.5 * h)).ceil() as u32).clamp(2, 8);
        let dt = dtf / sub as f32;
        for s in 0..sub {
            let t = (f - 1) as f32 * dtf + (s + 1) as f32 * dt;
            let states: Vec<Obj> = meshes.iter().map(|o| sample(o, t)).collect();
            runner.step(gpu, &mut sim, dt, &states, &par(t), desc.col_max, scale);
        }
        let ww = sim.read_spray(gpu).map(|(n, p, v)| { let (k, pos, pk, _) = ww::pack_spray_frame(&p, &v, n, &ab, 200_000, spr.foam_life); (k, pos, pk) });
        write(&mut w, f, ww)?;
        if !progress(&Progress { f: f as u32, frames: nf as u32 - 1, n: sim.n, elapsed: t0.elapsed().as_secs_f32(), sub, frame_ms: tf0.elapsed().as_secs_f32() * 1000.0, wait: 0.0 }) { stopped = true; break; }
    }
    if stopped { meta["cancelled"] = json!(true); }
    w.finish(&meta).map_err(|e| format!("Finishing the cache failed: {e}"))?;
    Ok(())
}
