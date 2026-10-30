//! The FLIP solver: a port of the FlipSim class in src/flip/sim.js (buffers, parameter block, stages, block pool growth, readbacks),
//! running the page's own kernels: blocks, transfer (FLIP or APIC), pressure (red-black SOR or multigrid), separation, fast drops,
//! colliders, narrow band and ocean, whitewater, the air field and drips, and the deep water points of the narrow band look.

use crate::gpu::Gpu;
use crate::nb::NbFill;
use crate::scene::Col;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;

const SLOT_CELLS: u64 = 512;
const MGS: u64 = 220;
const MG_LEVELS: usize = 7;
const STOR: wgpu::BufferUsages = wgpu::BufferUsages::STORAGE.union(wgpu::BufferUsages::COPY_SRC).union(wgpu::BufferUsages::COPY_DST);

/// Grid of a sim with these options (FlipSim.layout): cell size h = ratio x spacing, cells a side, the box centred on x and z on y = 0.
/// The most timestamps a profiled step takes (about 16 stages).
const PROF_CAP: u32 = 64;

#[derive(Clone, Copy, Debug)]
pub struct Layout { pub d: f32, pub ratio: f32, pub h: f32, pub n: [u32; 3], pub b: splash_format::Box3, pub size: [f32; 3] }

impl Layout {
    /// The spacing, cell size and box as the page's 64-bit JS numbers have them (bakeRes rounds the spacing to 4 decimals). Lattice fills
    /// use these: in 32 bits a lattice point exactly on a sphere's surface or a box edge can land on the other side of it.
    pub fn d64(&self) -> f64 { (self.d as f64 * 1e4).round() / 1e4 }
    pub fn h64(&self) -> f64 { (self.ratio as f64 * 100.0).round() / 100.0 * self.d64() }
    pub fn size64(&self) -> [f64; 3] { let h = self.h64(); self.n.map(|v| v as f64 * h) }
    /// x0 x1 y0 y1 z0 z1, for a tank centred on x and z (layout, not layout_at)
    pub fn b64(&self) -> [f64; 6] { let s = self.size64(); [-s[0] / 2.0, s[0] / 2.0, 0.0, s[1], -s[2] / 2.0, s[2] / 2.0] }
}

/// A grid whose box starts at org instead (the detail pass simulates only a region of the tank).
pub fn layout_at(d: f32, ratio: f32, size: [f32; 3], org: [f32; 3]) -> Layout {
    let mut l = layout(d, ratio, size);
    l.b = splash_format::Box3 { x0: org[0], x1: org[0] + l.size[0], y0: org[1], y1: org[1] + l.size[1], z0: org[2], z1: org[2] + l.size[2] };
    l
}

pub fn layout(d: f32, ratio: f32, size: [f32; 3]) -> Layout {
    let ratio = ratio.clamp(1.4, 4.0);
    let h = ratio * d;
    let n = size.map(|s| ((s / h).round() as u32).max(4));
    let (w, hh, dd) = (n[0] as f32 * h, n[1] as f32 * h, n[2] as f32 * h);
    Layout { d, ratio, h, n, b: splash_format::Box3 { x0: -w / 2.0, x1: w / 2.0, y0: 0.0, y1: hh, z0: -dd / 2.0, z1: dd / 2.0 }, size: [w, hh, dd] }
}

#[derive(Clone, Copy, Default, Debug)]
pub struct Stats { pub sc: u32, pub ovf: u32, pub fluid: u32, pub settled: u32, pub free: u32, pub need: u32, pub vmax: f32, pub seen: bool }

/// The ocean in solver units (oceanCfg): wave height and length, direction and spread in degrees, still water level above the box
/// floor and the boundary layer's width.
#[derive(Clone, Copy, Debug)]
pub struct Ocean { pub height: f64, pub length: f64, pub dir: f64, pub spread: f64, pub seed: i32, pub level: f64, pub layer: f64 }

/// Whitewater settings (simPar().spr with its ww part); area is the whitewater area's widening and raising (wwArea).
#[derive(Clone, Copy, Debug)]
pub struct Spr {
    pub rate: f32, pub min: f32, pub life: f32, pub mist: f32, pub drag: f32, pub mdrag: f32,
    pub foam_life: f32, pub rise: f32, pub crest: f32, pub impact: f32, pub spin: f32, pub edge: f32, pub erode: f32, pub land: f32, pub trail: f32,
    pub area: [f32; 2],
}
/// The air field (simPar().air).
#[derive(Clone, Copy, Debug)]
pub struct Air { pub couple: f32, pub decay: f32, pub real: bool, pub feel: bool, pub size: f32, pub oct: f32, pub speed: f32, pub swirl: f32, pub iters: u32, pub blur: f32 }
/// Dripping off wet colliders (simPar().drip).
#[derive(Clone, Copy, Debug)]
pub struct Drip { pub rate: f32, pub dry: f32 }

/// Per-step settings (the page's simPar). Narrow band and ocean are the sim's own (set when the starting water is seeded).
#[derive(Clone, Copy, Debug)]
pub struct StepPar {
    pub g: f32, pub iters: u32, pub flip: f32, pub apic_flip: f32, pub comp: f32, pub vmax: f32, pub vs: f32, pub tear: f32, pub time: f32,
    pub wind: [f32; 3], pub drag: f32, pub gust: f32, pub foam_sens: f32, pub foam_tau: f32,
    pub spr: Option<Spr>, pub air: Option<Air>, pub drip: Option<Drip>,
}
impl StepPar {
    /// Gravity and iterations only (prime's steps).
    pub fn bare(g: f32, iters: u32) -> StepPar {
        StepPar { g, iters, flip: 0.95, apic_flip: 0.8, comp: 0.0, vmax: 14.0, vs: 1.0, tear: 0.0, time: 0.0, wind: [0.0; 3], drag: 0.0, gust: 0.0, foam_sens: 1.0, foam_tau: 1.2,
            spr: None, air: None, drip: None }
    }
}

/// Deep water points drawn at most (narrow band look only); matches DEEPMAX in the shader.
pub const DEEPMAX: u32 = 200_000;
const DISP_MAX: u32 = 300_000;

#[derive(Clone, Copy, Debug)]
pub struct AirDims { pub n: [u32; 3], pub cells: u32, pub h: f32 }

/// The whitewater area: the tank widened k times about its centre and raised to up times its height, floor kept (wwAreaBox).
pub fn ww_area_box(b: &splash_format::Box3, k: f32, up: f32) -> splash_format::Box3 {
    let (k, up) = (k.max(1.0), up.max(1.0));
    let (cx, cz) = ((b.x0 + b.x1) / 2.0, (b.z0 + b.z1) / 2.0);
    let (hx, hz) = ((b.x1 - b.x0) / 2.0 * k, (b.z1 - b.z0) / 2.0 * k);
    splash_format::Box3 { x0: cx - hx, x1: cx + hx, y0: b.y0, y1: b.y0 + (b.y1 - b.y0) * up, z0: cz - hz, z1: cz + hz }
}

/// Solver options (sim.opt).
/// The sort's most keys and their chunks of 64 (SORTKMAX in blocks.wgsl): the count buffer's size.
const SORT_K: u32 = 1 << 21;
const SORT_CH: u32 = (SORT_K + 1).div_ceil(64);
/// The keys this layout's sort uses (sortK in blocks.wgsl), and their chunks of 64.
fn sort_keys(n: [u32; 3]) -> (u32, u32) {
    let m = n[0].max(n[1]).max(n[2]);
    let mut sh = 2; while ((m - 1) >> sh) >= 128 && sh < 12 { sh += 1; }
    let top = (m - 1) >> sh;
    let mut b = 1; while (top >> b) != 0 && b < 7 { b += 1; }
    let k = 1u32 << (3 * b);
    (k, (k + 64) / 64)
}

#[derive(Clone, Copy, Debug)]
pub struct Opt { pub apic: bool, pub sort: bool, pub sort_auto: bool, pub p2g_win: bool, pub ballistic: bool, pub settle: bool, pub settle_tol: f32,
    pub mg: bool, pub sep: f32, pub sep_iters: u32, pub extrap: bool, pub ghost: bool }
impl Default for Opt {
    fn default() -> Opt { Opt { apic: true, sort: false, sort_auto: true, p2g_win: false, ballistic: true, settle: false, settle_tol: 0.001, mg: true, sep: 10.0, sep_iters: 8, extrap: true, ghost: true } }
}

/// Three small staging buffers for the ctl counters, read back without waiting (readStats): each step uses the newest that arrived.
struct StatRing { bufs: Vec<(wgpu::Buffer, Arc<AtomicU8>)> }
const FREE: u8 = 0;
const PENDING: u8 = 1;
const READY: u8 = 2;

pub struct FlipSim {
    pub l: Layout,
    pub rest: f32,
    pub open: u32,
    pub max_n: u32,
    pub cap: u32,
    pub n: u32,
    pub opt: Opt,
    ntiles: u32,
    t: [u32; 3],
    pub scap: u32,
    scap_max: u32,
    lcap: u32,
    buf: HashMap<u32, wgpu::Buffer>,
    groups: HashMap<String, wgpu::BindGroup>,
    groups_dirty: bool,
    pu: Vec<u32>,
    cf: Vec<f32>,
    cf_prev: Option<(usize, u32, Vec<f32>)>,
    solid_dirty: bool,
    sdf_sig: u32,
    sdf_cap: u64,
    run_start: u32,
    run_pos: Vec<f32>,
    run_vel: Vec<f32>,
    tm: f32,
    seed: u32,
    sort_tick: u32,
    sort_moved: f32,
    sorted_ever: bool,
    last_dt: f32,
    mg_size: u64,
    mg_dense: Vec<[u32; 4]>,
    mg_top: u32,
    only_tiles: bool,
    stats_ring: StatRing,
    pub stats: Option<Stats>,
    pub ovf_total: u64,
    stage: Option<wgpu::Buffer>,
    /// a readback started and not collected yet: the particles' bytes, and the fastest particle's 4 bytes
    pending: Option<(u32, u64, wgpu::SubmissionIndex)>,
    fstage: Option<wgpu::Buffer>,
    fmapped: bool,
    pub grew: u32,
    /// the whitewater pass over a finished bake (Bake whitewater): the loaded particles only build the grid, the whitewater stages run
    pub ww_only: bool,
    /// tall cells (native only, tall.wgsl): the row they started below (0: off); the GPU lowers it when the water needs the room
    pub tall_t0: u32,
    /// the solver benchmark: timestamps between the stages of each step (enable_prof), and GPU milliseconds a stage summed with the steps
    prof: Option<(wgpu::QuerySet, wgpu::Buffer, wgpu::Buffer)>,
    pub prof_acc: Vec<(String, f64)>,
    pub prof_steps: u32,
    // narrow band and ocean
    vel_g_on: bool,
    /// the next step starts the depth field from the starting shapes (1: a restart)
    pub nb_init: u32,
    pub nb_fills: Vec<NbFill>,
    pub nb_vols: Vec<Col>,
    /// band depth in cells, when narrow band is on
    pub nb_band: Option<f32>,
    pub ocean: Option<Ocean>,
    pub ocean_w: Vec<f32>,
    nb_on: bool,
    init_step: u32,
    // whitewater, air, drips, deep water look
    pub spray_cap: u32,
    spr_disp_max: u32,
    pub deep_on: bool,
    pub air_dims: Option<AirDims>,
    ndrip: u32,
    drip_sig: Vec<u32>,
    drip_cache: HashMap<u32, Vec<f32>>,
    air_real: bool,
    air_feel: bool,
    air_iters: u32,
    air_on_step: bool,
    drip_on_step: bool,
    spr_on_step: bool,
    /// the whitewater area of the last step
    pub ab: splash_format::Box3,
    sctl_stage: Option<wgpu::Buffer>,
    sstage: Option<wgpu::Buffer>,
    dstage: Option<wgpu::Buffer>,
}

fn sizes(n: u32) -> u64 { (n as u64).max(1) }

impl FlipSim {
    pub fn new(gpu: &Gpu, l: Layout, open: u32, max_n: u32) -> FlipSim {
        let dev = &gpu.device;
        let mk = |size: u64| dev.create_buffer(&wgpu::BufferDescriptor { label: None, size: size.max(16).div_ceil(4) * 4, usage: STOR, mapped_at_creation: false });
        let m = max_n as u64;
        let t = [(l.n[0] + 1).div_ceil(8), (l.n[1] + 1).div_ceil(8), (l.n[2] + 1).div_ceil(8)];
        let ntiles = t[0] * t[1] * t[2];
        let max_bind = dev.limits().max_storage_buffer_binding_size as u64;
        let scap_max = 2u64.max((ntiles as u64 + 1).min(max_bind / (512 * 3 * 4))) as u32;
        let scap = 2u32.max(scap_max.min(64u32.max(max_n.div_ceil(1024))));
        let mut buf = HashMap::new();
        buf.insert(0, dev.create_buffer(&wgpu::BufferDescriptor { label: Some("params"), size: gpu.params_bytes, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false }));
        buf.insert(1, mk(m * 16)); buf.insert(2, mk(m * 16)); buf.insert(42, mk(16));
        buf.insert(26, mk(m * 4)); buf.insert(27, mk(16));
        buf.insert(28, mk(16)); buf.insert(29, mk(16)); buf.insert(30, mk(16)); buf.insert(33, mk(16));
        buf.insert(32, mk(16)); buf.insert(35, mk(16)); buf.insert(34, mk(16)); buf.insert(36, mk(32));
        buf.insert(16, mk(ntiles as u64 * 4)); buf.insert(17, mk(ntiles as u64 * 4)); buf.insert(21, mk(ntiles as u64 * 8));
        buf.insert(40, mk(16));
        buf.insert(43, mk(32));   // tall cells: off (T = 0) until enable_tall
        buf.insert(44, mk(16));
        buf.insert(45, mk(16));   // the sort's copy of the APIC rows, made on first use
        buf.insert(10, mk(32 * 128)); buf.insert(22, mk((SORT_K + 1 + SORT_CH) as u64 * 4)); buf.insert(23, mk(16)); buf.insert(24, mk(16));
        buf.insert(12, dev.create_buffer(&wgpu::BufferDescriptor { label: Some("ctl"), size: 64, usage: STOR, mapped_at_creation: false }));
        buf.insert(25, mk(16));
        buf.insert(15, mk(16)); buf.insert(37, mk(16));
        buf.insert(38, dev.create_buffer(&wgpu::BufferDescriptor { label: Some("packU"), size: 128, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false }));
        buf.insert(14, dev.create_buffer(&wgpu::BufferDescriptor { label: Some("args"), size: 192, usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::INDIRECT | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false }));
        buf.insert(11, mk(64));
        let stats_ring = StatRing { bufs: (0..3).map(|_| (dev.create_buffer(&wgpu::BufferDescriptor { label: Some("stat"), size: 64,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false }), Arc::new(AtomicU8::new(FREE)))).collect() };
        let mut s = FlipSim {
            l, rest: l.ratio.powi(3), open, max_n, cap: max_n, n: 0, opt: Opt::default(), ntiles, t, scap, scap_max, lcap: 0, buf,
            groups: HashMap::new(), groups_dirty: true, pu: vec![0; (gpu.params_bytes / 4) as usize], cf: vec![0.0; 32 * 32], cf_prev: None, solid_dirty: true,
            sdf_sig: 0, sdf_cap: 16, run_start: 0, run_pos: Vec::new(), run_vel: Vec::new(), tm: 0.0, seed: 0, sort_tick: 0, sort_moved: 0.0, sorted_ever: false,
            last_dt: 0.0, mg_size: 0, mg_dense: Vec::new(), mg_top: 0, only_tiles: false, stats_ring, stats: None, ovf_total: 0, stage: None, pending: None, fstage: None, fmapped: false, grew: 0, ww_only: false, tall_t0: 0, prof: None, prof_acc: Vec::new(), prof_steps: 0,
            vel_g_on: false, nb_init: 0, nb_fills: Vec::new(), nb_vols: Vec::new(), nb_band: None, ocean: None, ocean_w: Vec::new(), nb_on: false, init_step: 0,
            spray_cap: 0, spr_disp_max: 0, deep_on: false, air_dims: None, ndrip: 0, drip_sig: vec![u32::MAX], drip_cache: HashMap::new(),
            air_real: false, air_feel: false, air_iters: 20, air_on_step: false, drip_on_step: false, spr_on_step: false, ab: l.b,
            sctl_stage: None, sstage: None, dstage: None,
        };
        // slot k starts as particle k (written in chunks: 44M ids are 176 MB)
        let q = &gpu.queue;
        let chunk = 1u32 << 22;
        let mut k0 = 0;
        while k0 < max_n {
            let k1 = (k0 + chunk).min(max_n);
            let ids: Vec<u32> = (k0..k1).collect();
            q.write_buffer(&s.buf[&26], k0 as u64 * 4, bytemuck::cast_slice(&ids));
            k0 = k1;
        }
        s.make_slot_buffers(gpu, scap);
        // empty block map, every slot but the spare slot 0 on the free stack
        q.write_buffer(&s.buf[&16], 0, bytemuck::cast_slice(&vec![u32::MAX; ntiles as usize]));
        let st: Vec<u32> = (0..scap - 1).map(|k| scap - 1 - k).collect();
        q.write_buffer(&s.buf[&20], 0, bytemuck::cast_slice(&st));
        let mut ctl = [0u32; 16];
        ctl[2] = scap - 1;
        q.write_buffer(&s.buf[&12], 0, bytemuck::cast_slice(&ctl));
        s
    }

    pub fn d(&self) -> f32 { self.l.d }
    /// Video memory this sim's buffers take now (every binding plus the staging buffers for readbacks).
    pub fn mem_bytes(&self) -> u64 {
        self.buf.values().map(|b| b.size()).sum::<u64>() + [&self.stage, &self.sstage, &self.dstage, &self.sctl_stage].iter().filter_map(|s| s.as_ref().map(|b| b.size())).sum::<u64>() + 3 * 64
    }

    // ---- checkpoints (resuming a bake after a crash) ----

    /// Bytes of binding k a checkpoint keeps: particle buffers only as far as the particles go, everything else whole.
    fn kept_bytes(&self, k: u32, size: u64) -> u64 {
        let n = self.n as u64;
        let per = match k { 1 | 2 | 23 | 24 => 16, 26 | 27 => 4, 42 => 48, _ => return size };
        size.min(n.max(1) * per)
    }

    /// Writes every buffer that carries state from one step to the next to w (the parameter block, colliders and their distance grids
    /// are written again every step, the display and packing buffers hold nothing between steps) and returns what is needed to read
    /// them back, with the sim's own counters.
    pub fn save_state(&self, gpu: &Gpu, w: &mut impl std::io::Write) -> std::io::Result<serde_json::Value> {
        const CHUNK: u64 = 256 << 20;
        let stage = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some("checkpoint"), size: CHUNK,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let mut keys: Vec<u32> = self.buf.keys().copied().filter(|k| ![0, 10, 11, 15, 37, 38].contains(k)).collect();
        keys.sort();
        let mut list = Vec::new();
        for k in keys {
            let b = &self.buf[&k];
            let keep = self.kept_bytes(k, b.size());
            let mut off = 0;
            while off < keep {
                let len = CHUNK.min(keep - off);
                let mut enc = gpu.device.create_command_encoder(&Default::default());
                enc.copy_buffer_to_buffer(b, off, &stage, 0, len);
                gpu.queue.submit([enc.finish()]);
                stage.slice(..len).map_async(wgpu::MapMode::Read, |_| {});
                let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
                w.write_all(&stage.slice(..len).get_mapped_range().unwrap())?;
                stage.unmap();
                off += len;
            }
            list.push(serde_json::json!([k, b.size(), keep]));
        }
        Ok(serde_json::json!({
            "buffers": list, "n": self.n, "cap": self.cap, "maxN": self.max_n, "scap": self.scap, "lcap": self.lcap, "tm": self.tm, "seed": self.seed,
            "sortTick": self.sort_tick, "sortMoved": self.sort_moved, "sortedEver": self.sorted_ever, "lastDt": self.last_dt, "mgSize": self.mg_size,
            "ovfTotal": self.ovf_total, "grew": self.grew, "velG": self.vel_g_on, "nbInit": self.nb_init, "nbBand": self.nb_band,
            "ocean": self.ocean.map(|o| serde_json::json!([o.height, o.length, o.dir, o.spread, o.seed, o.level, o.layer])), "oceanW": self.ocean_w,
            "sprayCap": self.spray_cap, "sprDispMax": self.spr_disp_max, "deepOn": self.deep_on,
            "air": self.air_dims.map(|a| serde_json::json!([a.n, a.cells, a.h])), "ndrip": self.ndrip, "dripSig": self.drip_sig,
            // the last step's counters: they decide growing and sorting on the next steps
            "stats": self.stats.map(|s| serde_json::json!([s.sc, s.ovf, s.fluid, s.settled, s.free, s.need, s.vmax, s.seen])),
        }))
    }

    /// Puts back what save_state wrote (r reads the bytes in the same order). The sim must have been made with the same grid and
    /// Max points. Colliders, their distance grids and solid cells are made again on the next step.
    pub fn restore_state(&mut self, gpu: &Gpu, v: &serde_json::Value, r: &mut impl std::io::Read) -> Result<(), String> {
        let e = |m: &str| format!("The checkpoint is damaged ({m}).");
        if v["maxN"].as_u64() != Some(self.max_n as u64) { return Err("The checkpoint was made with a different Max points.".into()); }
        let mut chunk = vec![0u8; 64 << 20];
        for item in v["buffers"].as_array().ok_or(e("buffers"))? {
            let (k, size, keep) = (item[0].as_u64().ok_or(e("binding"))? as u32, item[1].as_u64().ok_or(e("size"))?, item[2].as_u64().ok_or(e("size"))?);
            // the indirect arguments must stay usable for indirect dispatches
            let b = if k == 14 { gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some("args"), size, usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::INDIRECT | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false }) } else { Self::mk(gpu, size) };
            let mut off = 0;
            while off < keep {
                let len = (chunk.len() as u64).min(keep - off) as usize;
                r.read_exact(&mut chunk[..len]).map_err(|x| format!("Reading the checkpoint failed: {x}"))?;
                gpu.queue.write_buffer(&b, off, &chunk[..len]);
                off += len as u64;
            }
            // flush the queued uploads now and then, so they do not pile up in memory
            let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
            self.buf.insert(k, b);
        }
        let u = |k: &str| v[k].as_u64().unwrap_or(0);
        let f = |k: &str| v[k].as_f64().unwrap_or(0.0) as f32;
        let bl = |k: &str| v[k].as_bool().unwrap_or(false);
        self.n = u("n") as u32; self.cap = u("cap") as u32; self.scap = u("scap") as u32; self.lcap = u("lcap") as u32;
        self.tm = f("tm"); self.seed = u("seed") as u32; self.sort_tick = u("sortTick") as u32; self.sort_moved = f("sortMoved");
        self.sorted_ever = bl("sortedEver"); self.last_dt = f("lastDt"); self.mg_size = u("mgSize"); self.ovf_total = u("ovfTotal"); self.grew = u("grew") as u32;
        self.vel_g_on = bl("velG"); self.nb_init = u("nbInit") as u32; self.nb_band = v["nbBand"].as_f64().map(|b| b as f32);
        self.ocean = v["ocean"].as_array().map(|a| Ocean { height: a[0].as_f64().unwrap_or(0.0), length: a[1].as_f64().unwrap_or(1.0), dir: a[2].as_f64().unwrap_or(0.0),
            spread: a[3].as_f64().unwrap_or(0.0), seed: a[4].as_i64().unwrap_or(1) as i32, level: a[5].as_f64().unwrap_or(0.0), layer: a[6].as_f64().unwrap_or(0.0) });
        self.ocean_w = v["oceanW"].as_array().map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect()).unwrap_or_default();
        self.spray_cap = u("sprayCap") as u32; self.spr_disp_max = u("sprDispMax") as u32; self.deep_on = bl("deepOn");
        self.air_dims = v["air"].as_array().map(|a| AirDims { n: [0, 1, 2].map(|i| a[0][i].as_u64().unwrap_or(1) as u32), cells: a[1].as_u64().unwrap_or(1) as u32, h: a[2].as_f64().unwrap_or(1.0) as f32 });
        self.ndrip = u("ndrip") as u32;
        self.drip_sig = v["dripSig"].as_array().map(|a| a.iter().map(|x| x.as_u64().unwrap_or(0) as u32).collect()).unwrap_or_else(|| vec![u32::MAX]);
        self.nb_fills.clear(); self.nb_vols.clear();
        self.stats = v["stats"].as_array().filter(|a| a.len() == 8).map(|a| {
            let k = |i: usize| a[i].as_u64().unwrap_or(0) as u32;
            Stats { sc: k(0), ovf: k(1), fluid: k(2), settled: k(3), free: k(4), need: k(5), vmax: a[6].as_f64().unwrap_or(0.0) as f32, seen: a[7].as_bool().unwrap_or(true) }
        });
        self.cf_prev = None; self.solid_dirty = true;
        self.run_pos.clear(); self.run_vel.clear();
        self.groups_dirty = true;
        Ok(())
    }
    pub fn h(&self) -> f32 { self.l.h }

    fn mk(gpu: &Gpu, size: u64) -> wgpu::Buffer {
        gpu.device.create_buffer(&wgpu::BufferDescriptor { label: None, size: size.max(16).div_ceil(4) * 4, usage: STOR, mapped_at_creation: false })
    }

    /// Per-block storage: counts, type, pressure, rhs, calm, separation potential (4 bytes a cell), the faces (12 bytes a cell, twice),
    /// kept velocity (narrow band only), slot bookkeeping, and the fluid cell lists.
    fn make_slot_buffers(&mut self, gpu: &Gpu, n: u32) {
        let c = n as u64 * SLOT_CELLS;
        for k in [6, 7, 8, 9, 39, 41, 47] { self.buf.insert(k, Self::mk(gpu, c * 4)); }
        self.buf.insert(46, Self::mk(gpu, c * 16));
        self.buf.insert(3, Self::mk(gpu, c * 12)); self.buf.insert(5, Self::mk(gpu, c * 12));
        self.buf.insert(31, Self::mk(gpu, if self.vel_g_on { c * 12 } else { 16 }));
        for k in [18, 19, 20] { self.buf.insert(k, Self::mk(gpu, n as u64 * 4)); }
        // fluid cell lists: without narrow band a water cell holds at least one particle; with it, deep water cells hold none
        self.lcap = if self.vel_g_on { c as u32 } else { (c as u32).min(self.max_n) };
        self.buf.insert(13, Self::mk(gpu, self.lcap as u64 * 8));
        self.groups_dirty = true;
    }

    fn make_groups(&mut self, gpu: &Gpu) {
        if !self.groups_dirty { return; }
        self.groups.clear();
        for (name, p) in &gpu.pipes {
            let entries: Vec<wgpu::BindGroupEntry> = p.bindings.iter().map(|k| wgpu::BindGroupEntry { binding: *k, resource: self.buf[k].as_entire_binding() }).collect();
            self.groups.insert(name.clone(), gpu.device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some(name), layout: &p.layout, entries: &entries }));
        }
        self.groups_dirty = false;
    }

    /// More blocks: the old ones copied over unchanged, the new slots put on the free stack (grow).
    fn grow(&mut self, gpu: &Gpu, want: u32) -> bool {
        let n = self.scap_max.min(want.max(self.scap + 1));
        if n <= self.scap { return false; }
        let old = self.scap;
        let mut list = vec![(6, 2048), (7, 2048), (8, 2048), (9, 2048), (39, 2048), (41, 2048), (3, 6144), (5, 6144), (18, 4), (19, 4), (20, 4)];
        if self.vel_g_on { list.push((31, 6144)); }
        let keep: Vec<(u32, wgpu::Buffer, u64)> = list.iter().map(|&(k, per)| (k, self.buf.remove(&k).unwrap(), per)).collect();
        self.make_slot_buffers(gpu, n);
        self.scap = n;
        gpu.queue.write_buffer(&self.buf[&25], 0, bytemuck::cast_slice(&[old, n - old, 0, 0]));
        self.make_groups(gpu);
        let mut enc = gpu.device.create_command_encoder(&Default::default());
        for (k, b, per) in &keep { enc.copy_buffer_to_buffer(b, 0, &self.buf[k], 0, old as u64 * per); }
        {
            let mut ps = enc.begin_compute_pass(&Default::default());
            let g = (n - old).div_ceil(256);
            ps.set_pipeline(&gpu.pipes["growFree"].pipeline);
            ps.set_bind_group(0, &self.groups["growFree"], &[]);
            ps.dispatch_workgroups(g.min(65535), g.div_ceil(65535), 1);
        }
        gpu.queue.submit([enc.finish()]);
        self.grew += 1;
        true
    }

    /// Grow before a step when the last finished step used most of the blocks, or some did not fit.
    fn maybe_grow(&mut self, gpu: &Gpu) {
        let Some(s) = self.stats.as_mut() else { return; };
        if s.seen { return; }
        s.seen = true;
        let want = s.sc + s.ovf;
        let (need, free) = (s.need, s.free);
        if s.ovf > 0 || want as f32 > 0.8 * self.scap as f32 {
            let w = ((self.scap as f32 * 1.5).ceil() as u32).max((want as f32 * 1.4).ceil() as u32 + 8);
            self.grow(gpu, w);
        }
        // narrow band: the band is refilled from free particle slots. An impact into deep water asks for far more than the spares seeded at
        // the start, so park more slots (up to the cap) when the cells asking would use over half of what is free
        if self.nb_band.is_some() && self.n < self.cap {
            let need = need as u64 * (0.85 * self.rest).round() as u64;
            if need as f64 > 0.5 * free as f64 {
                let k = ((self.cap - self.n) as u64).min((2 * need).saturating_sub(free as u64).max((0.1 * self.n as f64).ceil() as u64));
                for _ in 0..k { self.add(gpu, [0.0, -1e6, 0.0], [0.0; 3]); }
            }
        }
    }

    /// The first narrow band step: room for the kept grid velocity and longer cell lists (enableNB).
    /// Tall cells below row t (a multiple of 8; narrow band only): deep water there is one cell a column. margin: how close (cells) the
    /// surface, particles or anything not deep water may come to row t before a block row goes back to ordinary cells.
    /// p0: every tall cell's starting pressure.
    pub fn enable_tall(&mut self, gpu: &Gpu, t: u32, margin: u32, p0: f32) {
        let (nx, nz) = (self.l.n[0] as u64, self.l.n[2] as u64);
        let words = 8 + 2 * nx * nz + (nx + 1) * nz + nx * (nz + 1);
        let b = Self::mk(gpu, words * 4);
        gpu.queue.write_buffer(&b, 0, bytemuck::cast_slice(&[t as f32, t as f32, 0.0, margin as f32]));
        gpu.queue.write_buffer(&b, 32, bytemuck::cast_slice(&vec![p0; (nx * nz) as usize]));
        self.buf.insert(43, b);
        self.tall_t0 = t;
        self.groups_dirty = true;
    }
    /// Where the tall cells start now (the GPU lowers it as the water comes near), read back from the GPU.
    pub fn tall_now(&self, gpu: &Gpu) -> u32 {
        if self.tall_t0 == 0 { return 0; }
        let st = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 16, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let mut enc = gpu.device.create_command_encoder(&Default::default());
        enc.copy_buffer_to_buffer(&self.buf[&43], 0, &st, 0, 16);
        gpu.queue.submit([enc.finish()]);
        st.slice(..).map_async(wgpu::MapMode::Read, |_| {});
        let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
        let v: Vec<f32> = { let m = st.slice(..).get_mapped_range().unwrap(); bytemuck::cast_slice(&m).to_vec() };
        v[0] as u32
    }

    /// Times every stage of each step from now on (needs timestamps inside compute passes; false when the device has none).
    pub fn enable_prof(&mut self, gpu: &Gpu) -> bool {
        if !gpu.device.features().contains(wgpu::Features::TIMESTAMP_QUERY_INSIDE_PASSES) { return false; }
        let qs = gpu.device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("prof"), ty: wgpu::QueryType::Timestamp, count: PROF_CAP });
        let res = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: None, size: PROF_CAP as u64 * 8, usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
        let rd = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: None, size: PROF_CAP as u64 * 8, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        self.prof = Some((qs, res, rd));
        self.prof_acc.clear();
        self.prof_steps = 0;
        true
    }

    fn enable_nb(&mut self, gpu: &Gpu) {
        if self.vel_g_on { return; }
        self.vel_g_on = true;
        let c = self.scap as u64 * SLOT_CELLS;
        self.buf.insert(31, Self::mk(gpu, c * 12));
        self.lcap = c as u32;
        self.buf.insert(13, Self::mk(gpu, self.lcap as u64 * 8));
        self.groups_dirty = true;
    }

    /// Room for n whitewater points (0 turns whitewater off): positions, velocities, extra state, and the counters with the free list of
    /// dead slots (setSprayCap).
    pub fn set_spray_cap(&mut self, gpu: &Gpu, n: u32) {
        let n = n.min((gpu.device.limits().max_storage_buffer_binding_size / 16) as u32);
        if n == self.spray_cap { return; }
        self.spray_cap = n;
        self.spr_disp_max = n.min(200_000);
        for k in [28, 29, 33] { self.buf.insert(k, Self::mk(gpu, n.max(1) as u64 * 16)); }
        self.buf.insert(30, Self::mk(gpu, (16 + n as u64) * 4));
        self.sstage = None;
        self.disp_alloc(gpu);
    }

    /// Deep water points (narrow band look only) go into the display buffer after the water sample and the whitewater (dispAlloc).
    pub fn set_deep_look(&mut self, gpu: &Gpu, on: bool) {
        if on == self.deep_on { return; }
        self.deep_on = on;
        self.disp_alloc(gpu);
    }
    fn disp_alloc(&mut self, gpu: &Gpu) {
        let dm = if self.deep_on { DEEPMAX } else { 0 };
        self.buf.insert(15, Self::mk(gpu, (self.max_n.min(DISP_MAX + 1) + self.spr_disp_max + dm) as u64 * 16 + 16));
        self.groups_dirty = true;
    }

    /// The air field's grid: cells a few solver cells wide, at most about 260 thousand of them (airAlloc).
    fn air_alloc(&mut self, gpu: &Gpu) {
        if self.air_dims.is_some() { return; }
        let ncell = (self.l.n[0] * self.l.n[1] * self.l.n[2]) as f64;
        let r = 2u32.max((ncell / 260000.0).cbrt().ceil() as u32);
        let n = self.l.n.map(|v| v.div_ceil(r) + 1);
        let cells = n[0] * n[1] * n[2];
        for k in [32, 35, 34] { self.buf.insert(k, Self::mk(gpu, cells as u64 * 16)); }
        self.air_dims = Some(AirDims { n, cells, h: self.l.h * r as f32 });
        self.groups_dirty = true;
    }

    /// Drip samples over each collider's surface, rebuilt when the set of colliders changes (dripUpdate).
    fn drip_update(&mut self, gpu: &Gpu, cols: &[Col]) {
        let sig: Vec<u32> = cols.iter().map(|c| c.sdf.id).collect();
        if sig == self.drip_sig { return; }
        self.drip_sig = sig;
        let mut all = Vec::new();
        for (k, c) in cols.iter().enumerate() {
            let base = self.drip_cache.entry(c.sdf.id).or_insert_with(|| crate::ww::drip_samples(&c.sdf, self.l.h, 0));
            let mut a = base.clone();
            for i in (3..a.len()).step_by(8) { a[i] = k as f32; }
            all.extend_from_slice(&a);
        }
        self.ndrip = (all.len() / 8) as u32;
        if all.is_empty() { all.resize(8, 0.0); }
        if self.buf[&36].size() < all.len() as u64 * 4 { self.buf.insert(36, Self::mk(gpu, all.len() as u64 * 4)); self.groups_dirty = true; }
        gpu.queue.write_buffer(&self.buf[&36], 0, bytemuck::cast_slice(&all));
    }

    /// Collects stats that arrived and starts another read when a staging buffer is free.
    fn read_stats(&mut self, gpu: &Gpu, enc: &mut wgpu::CommandEncoder) -> Option<usize> {
        let free = self.stats_ring.bufs.iter().position(|(_, st)| st.load(Ordering::Acquire) == FREE)?;
        enc.copy_buffer_to_buffer(&self.buf[&12], 0, &self.stats_ring.bufs[free].0, 0, 64);
        let _ = gpu;
        Some(free)
    }
    fn start_map(&self, k: usize) {
        let (b, st) = &self.stats_ring.bufs[k];
        st.store(PENDING, Ordering::Release);
        let st2 = st.clone();
        b.slice(..).map_async(wgpu::MapMode::Read, move |r| st2.store(if r.is_ok() { READY } else { FREE }, Ordering::Release));
    }
    fn collect_stats(&mut self, gpu: &Gpu) {
        let _ = gpu.device.poll(wgpu::PollType::Poll);
        for (b, st) in &self.stats_ring.bufs {
            if st.load(Ordering::Acquire) != READY { continue; }
            let a: Vec<u32> = { let v = b.slice(..).get_mapped_range().unwrap(); bytemuck::cast_slice(&v).to_vec() };
            b.unmap();
            st.store(FREE, Ordering::Release);
            self.stats = Some(Stats { sc: a[4], ovf: a[5], fluid: a[0] + a[1] + a[15], settled: a[15], free: a[8], need: a[9], vmax: f32::from_bits(a[6]), seen: false });
            self.ovf_total += a[5] as u64;
        }
    }
    /// Waits for every stats read in flight (the bake's frame end, prime).
    pub fn wait_stats(&mut self, gpu: &Gpu) {
        if self.stats_ring.bufs.iter().any(|(_, s)| s.load(Ordering::Acquire) == PENDING) {
            let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
        }
        self.collect_stats(gpu);
    }

    // ---- particles ----

    /// Adds a particle (GpuSim.add). Particles are uploaded in runs before the next step.
    pub fn add(&mut self, gpu: &Gpu, p: [f32; 3], v: [f32; 3]) -> bool {
        if self.n >= self.cap { return false; }
        let i = self.n;
        self.n += 1;
        if !self.run_pos.is_empty() && i != self.run_start + (self.run_pos.len() / 4) as u32 { self.flush_run(gpu); }
        if self.run_pos.is_empty() { self.run_start = i; }
        self.run_pos.extend_from_slice(&[p[0], p[1], p[2], (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()]);
        self.run_vel.extend_from_slice(&[v[0], v[1], v[2], 0.0]);
        true
    }
    /// Replaces every particle with these (x y z w each, 4 floats; Bake whitewater loads each baked frame like this).
    pub fn load(&mut self, gpu: &Gpu, pos: &[f32], vel: &[f32]) {
        self.run_pos.clear(); self.run_vel.clear();
        self.n = ((pos.len() / 4) as u32).min(self.max_n);
        let b = self.n as usize * 16;
        gpu.queue.write_buffer(&self.buf[&1], 0, &bytemuck::cast_slice(pos)[..b]);
        gpu.queue.write_buffer(&self.buf[&2], 0, &bytemuck::cast_slice(vel)[..b]);
        // uploaded particles start with no APIC gradient
        if self.buf[&42].size() >= self.n as u64 * 48 && self.n > 0 { gpu.queue.write_buffer(&self.buf[&42], 0, &vec![0u8; self.n as usize * 48]); }
    }

    /// Particle velocities (x y z w each), in slot order (the detail pass keeps its own copy of the particles).
    /// Every particle slot's position and velocity, in the same (storage) order (for measuring; parked slots have y below -1e5).
    pub fn read_particles(&mut self, gpu: &Gpu, pos: &mut Vec<f32>, vel: &mut Vec<f32>) {
        let bytes = sizes(self.n) * 16;
        let mut st = self.stage.take();
        let p = Self::read_into(gpu, &self.buf[&1], 0, bytes, &mut st, None);
        self.stage = st;
        pos.clear();
        pos.extend_from_slice(&bytemuck::cast_slice::<u8, f32>(&p)[..self.n as usize * 4]);
        self.read_vel(gpu, vel);
    }

    pub fn read_vel(&mut self, gpu: &Gpu, dst: &mut Vec<f32>) {
        let bytes = sizes(self.n) * 16;
        let mut st = self.stage.take();
        let v = Self::read_into(gpu, &self.buf[&2], 0, bytes, &mut st, None);
        self.stage = st;
        dst.clear();
        dst.extend_from_slice(&bytemuck::cast_slice::<u8, f32>(&v)[..self.n as usize * 4]);
    }

    /// Uploads the particles added since the last flush; they start with no APIC gradient.
    pub fn flush_run(&mut self, gpu: &Gpu) {
        if self.run_pos.is_empty() { return; }
        let o = self.run_start as u64 * 16;
        gpu.queue.write_buffer(&self.buf[&1], o, bytemuck::cast_slice(&self.run_pos));
        gpu.queue.write_buffer(&self.buf[&2], o, bytemuck::cast_slice(&self.run_vel));
        let nrun = (self.run_pos.len() / 4) as u64;
        if self.buf[&42].size() >= (self.run_start as u64 + nrun) * 48 {
            gpu.queue.write_buffer(&self.buf[&42], self.run_start as u64 * 48, &vec![0u8; (nrun * 48) as usize]);
        }
        self.run_pos.clear();
        self.run_vel.clear();
    }

    /// Water on a jittered lattice at the particle spacing (FluidSim.fillBox). The lattice is stepped in f64 like the page's JS
    /// numbers: in f32 the last row at a box edge came out on the other side of it (318,000 particles against the page's 312,000).
    pub fn fill_box(&mut self, gpu: &Gpu, rng: &mut Rng, b: [f64; 6]) {
        let d = self.l.d64();
        let j = (0.01 * d / 0.12) as f32;
        let mut y = b[2] + d / 2.0;
        while y < b[3] {
            let mut x = b[0] + d / 2.0;
            while x < b[1] {
                let mut z = b[4] + d / 2.0;
                while z < b[5] {
                    if !self.add(gpu, [x as f32 + (rng.f() - 0.5) * j, y as f32 + (rng.f() - 0.5) * j, z as f32 + (rng.f() - 0.5) * j], [0.0; 3]) { return; }
                    z += d;
                }
                x += d;
            }
            y += d;
        }
    }
    pub fn fill_sphere(&mut self, gpu: &Gpu, rng: &mut Rng, c: [f64; 3], r: f64, v: [f32; 3]) {
        let d = self.l.d64();
        let j = (0.01 * d / 0.12) as f32;
        let mut y = -r;
        while y <= r {
            let mut x = -r;
            while x <= r {
                let mut z = -r;
                while z <= r {
                    if x * x + y * y + z * z <= r * r && !self.add(gpu, [(c[0] + x) as f32 + (rng.f() - 0.5) * j, (c[1] + y) as f32 + (rng.f() - 0.5) * j, (c[2] + z) as f32 + (rng.f() - 0.5) * j], v) { return; }
                    z += d;
                }
                x += d;
            }
            y += d;
        }
    }

    // ---- colliders ----

    /// Packs this step's colliders into 32 floats each and uploads their distance grids when the set changed (packColliders).
    fn pack_colliders(&mut self, gpu: &Gpu, cols: &[Col]) -> usize {
        let nc = cols.len().min(32);
        let mut offs: Vec<(u32, u64)> = Vec::new();
        let mut total = 0u64;
        let mut sig = 0u32;
        for c in &cols[..nc] {
            if !offs.iter().any(|(id, _)| *id == c.sdf.id) { offs.push((c.sdf.id, total)); total += c.sdf.data.len() as u64; sig = sig.wrapping_mul(31).wrapping_add(c.sdf.id); }
        }
        if sig != self.sdf_sig {
            if total > self.sdf_cap {
                self.sdf_cap = (total as f64 * 1.3).ceil() as u64;
                self.buf.insert(11, Self::mk(gpu, self.sdf_cap * 4));
                self.groups_dirty = true;
            }
            let mut seen = Vec::new();
            for c in &cols[..nc] {
                if seen.contains(&c.sdf.id) { continue; }
                seen.push(c.sdf.id);
                let o = offs.iter().find(|(id, _)| *id == c.sdf.id).unwrap().1;
                gpu.queue.write_buffer(&self.buf[&11], o * 4, bytemuck::cast_slice(&c.sdf.data));
            }
            self.sdf_sig = sig;
        }
        for (k, c) in cols[..nc].iter().enumerate() {
            let (sd, r, s, g, j) = (&c.sdf, &c.r, c.s, c.g, k * 32);
            let o = offs.iter().find(|(id, _)| *id == sd.id).unwrap().1;
            let cf = &mut self.cf;
            cf[j..j + 8].copy_from_slice(&[o as f32, sd.dims[0] as f32, sd.dims[1] as f32, sd.dims[2] as f32, sd.origin[0], sd.origin[1], sd.origin[2], sd.cell]);
            // rows take a world offset to the shape's own unscaled coordinates: row i = column i of R over size i; w is size i times its rate
            cf[j + 8..j + 20].copy_from_slice(&[r[0] / s[0], r[3] / s[0], r[6] / s[0], g[0], r[1] / s[1], r[4] / s[1], r[7] / s[1], g[1], r[2] / s[2], r[5] / s[2], r[8] / s[2], g[2]]);
            cf[j + 20..j + 32].copy_from_slice(&[c.pos[0], c.pos[1], c.pos[2], s[0].min(s[1]).min(s[2]), c.v[0], c.v[1], c.v[2], 0.0, c.w[0], c.w[1], c.w[2], 0.0]);
        }
        if nc > 0 { gpu.queue.write_buffer(&self.buf[&10], 0, bytemuck::cast_slice(&self.cf[..nc * 32])); }
        nc
    }

    // ---- stepping ----

    fn omega(&self) -> f32 { (2.0 / (1.0 + (std::f32::consts::PI / self.l.n.iter().copied().max().unwrap() as f32).sin())).min(1.9) }

    /// Multigrid's levels: MGS floats a slot for levels 1-3, then dense levels over the box halving to about 4 a side (mgPlan).
    fn mg_plan(&mut self, gpu: &Gpu) -> u32 {
        let mut d = self.t;
        let mut off = self.scap as u64 * MGS;
        let mut dense = Vec::new();
        while *d.iter().max().unwrap() > 4 && dense.len() < MG_LEVELS - 3 {
            d = d.map(|v| v.div_ceil(2));
            dense.push([d[0], d[1], d[2], off as u32]);
            off += 3 * (d[0] * d[1] * d[2]) as u64;
        }
        if off != self.mg_size { self.buf.insert(40, Self::mk(gpu, off * 4)); self.mg_size = off; self.groups_dirty = true; }
        self.mg_dense = dense;
        3 + self.mg_dense.len() as u32
    }

    fn set_f(&mut self, w: usize, v: f32) { self.pu[w] = v.to_bits(); }

    /// One step of dt seconds with these colliders (FlipSim.step).
    pub fn step(&mut self, gpu: &Gpu, dt: f32, o: &StepPar, cols: &[Col]) {
        self.last_dt = dt;
        self.flush_run(gpu);
        let n = self.n;
        if n == 0 { return; }
        self.collect_stats(gpu);
        if !self.only_tiles { self.maybe_grow(gpu); self.flush_run(gpu); }   // it may park new particle slots
        let n = self.n;
        let (h, b) = (self.l.h, self.l.b);
        let nb_on = self.nb_band.is_some() || self.ocean.is_some();
        self.nb_on = nb_on;
        if nb_on { self.enable_nb(gpu); }
        let init = if nb_on { self.nb_init } else { 0 };
        self.init_step = init;
        // the first narrow band step also gets the water volumes, as colliders after the real ones
        let ntot = if init > 0 && !self.nb_vols.is_empty() { let all: Vec<Col> = cols.iter().cloned().chain(self.nb_vols.iter().cloned()).collect(); self.pack_colliders(gpu, &all) } else { self.pack_colliders(gpu, cols) };
        let nc = cols.len().min(ntot);
        let nfv = ntot - nc;
        {
            let n32 = nc * 32;
            let same = matches!(&self.cf_prev, Some((pn, ps, a)) if *pn == nc && *ps == self.sdf_sig && a[..] == self.cf[..n32]);
            if !same { self.solid_dirty = true; self.cf_prev = Some((nc, self.sdf_sig, self.cf[..n32].to_vec())); }
        }
        let apic = self.opt.apic && !self.ww_only;
        if apic && self.buf[&42].size() < self.max_n as u64 * 48 { self.buf.insert(42, Self::mk(gpu, self.max_n as u64 * 48)); self.groups_dirty = true; }
        // the sort needs a second copy of the particles (and of their APIC rows)
        if self.opt.sort && !self.ww_only && self.buf[&23].size() < self.max_n as u64 * 16 {
            let m = self.max_n as u64;
            self.buf.insert(23, Self::mk(gpu, m * 16)); self.buf.insert(24, Self::mk(gpu, m * 16)); self.buf.insert(27, Self::mk(gpu, m * 4));
            self.groups_dirty = true;
        }
        if self.opt.sort && apic && self.buf[&44].size() < self.max_n as u64 * 48 { self.buf.insert(44, Self::mk(gpu, self.max_n as u64 * 48)); self.groups_dirty = true; }
        let fr =if apic { if gpu.pipes.contains_key("g2pAo") { o.apic_flip } else { 0.0 } } else { o.flip };
        let flip = fr.clamp(0.0, 1.0).powf(dt * 60.0);
        let stride = 1u32.max(n.div_ceil(300000));
        self.pu.iter_mut().for_each(|w| *w = 0);
        let u = &mut self.pu;
        u[0] = n; u[1] = self.l.n[0]; u[2] = self.l.n[1]; u[3] = self.l.n[2]; u[4] = nc as u32; u[5] = self.open; u[6] = 0; u[7] = self.l.n[0] * self.l.n[1] * self.l.n[2];
        let omega = if self.opt.mg { 1.4 } else { self.omega() };
        let or1 = |v: f32| if v != 0.0 { v } else { 1.0 };
        let f = [dt, h, 1.0 / h, o.g, flip, self.rest, o.comp, omega, b.x0, b.y0, b.z0, o.vmax, 0.3 * self.l.d, 65536.0, b.x1, b.y1, b.z1, 0.3 * h,
            o.wind[0], o.wind[1], o.wind[2], o.drag, if o.foam_tau != 0.0 { o.foam_tau } else { 1.2 }, or1(o.foam_sens), o.gust, self.tm, 0.0, 0.0, stride as f32, 0.0];
        if !self.only_tiles { self.tm += dt; }
        for (k, v) in f.iter().enumerate() { self.set_f(8 + k, *v); }
        let bb = 8 + f.len();
        let u = &mut self.pu;
        u[bb] = self.lcap; u[bb + 1] = self.t[0]; u[bb + 2] = self.t[1]; u[bb + 3] = self.t[2]; u[bb + 4] = self.scap;
        let sp = if self.spray_cap > 0 { o.spr } else { None };
        self.set_f(bb + 5, o.tear);
        self.set_f(bb + 6, sp.map_or(0.0, |s| s.rate)); self.set_f(bb + 7, sp.map_or(1.0, |s| s.min.max(0.05))); self.set_f(bb + 8, sp.map_or(1.0, |s| s.life));
        self.set_f(bb + 9, sp.map_or(0.0, |s| s.mist)); self.set_f(bb + 10, sp.map_or(1.0, |s| s.drag)); self.set_f(bb + 11, sp.map_or(4.0, |s| s.mdrag));
        self.set_f(bb + 12, o.vs);
        let ndisp = if stride <= 1 { n } else { n.div_ceil(stride) };
        self.pu[bb + 13] = self.spray_cap; self.pu[bb + 14] = ndisp; self.pu[bb + 15] = self.spr_disp_max;
        if !self.only_tiles { self.seed = self.seed.wrapping_add(1); }
        self.pu[bb + 16] = self.seed;
        self.spr_on_step = sp.is_some();
        // narrow band and ocean (word 55 on, then the starting-water shapes at 84 and the wave list at 148)
        self.pu[55] = nb_on as u32; self.set_f(56, self.nb_band.unwrap_or(3.0).max(2.0)); self.pu[57] = self.ocean.is_some() as u32;
        let oc = self.ocean;
        let nw = if oc.is_some() { self.ocean_w.len() / 8 } else { 0 };
        if nw > 0 { for (k, v) in self.ocean_w.clone().iter().enumerate() { self.set_f(148 + k, *v); } }
        self.pu[58] = nw as u32; self.set_f(59, o.time);
        self.set_f(60, oc.map_or(0.0, |c| c.level as f32)); self.set_f(61, oc.map_or(0.0, |c| c.layer as f32));
        self.set_f(62, if nb_on && self.deep_on { (ndisp + self.spr_disp_max) as f32 } else { 0.0 });
        self.set_f(63, b.y0); self.pu[64] = init;
        let fl: Vec<NbFill> = if init > 0 { self.nb_fills.iter().take(8).copied().collect() } else { Vec::new() };
        self.pu[65] = fl.len() as u32;
        self.set_f(66, oc.map_or(1.0, |c| (c.level as f32 - b.y0).max(1e-3))); self.pu[67] = nfv as u32;
        for (k, f) in fl.iter().enumerate() {
            let w = match f { NbFill::Box(e) => [1.0, e[0], e[1], e[2], e[3], e[4], e[5], 0.0], NbFill::Sphere(s) => [2.0, s[0], s[1], s[2], s[3], 0.0, 0.0, 0.0] };
            for (i, v) in w.iter().enumerate() { self.set_f(84 + k * 8 + i, *v); }
        }
        if init > 0 && !self.only_tiles { self.nb_init = 0; self.nb_fills.clear(); self.nb_vols.clear(); }
        // whitewater, air field and drips (words 68-83, 404-415, 440-447)
        let airo = if sp.is_some() { o.air } else { None };
        let dr = if sp.is_some() { o.drip } else { None };
        if airo.is_some() { self.air_alloc(gpu); }
        let ad = self.air_dims;
        let (ww_life, ww_rise) = o.spr.map_or((3.0, 0.3), |s| (if s.foam_life != 0.0 { s.foam_life } else { 3.0 }, if s.rise != 0.0 { s.rise } else { 0.3 }));
        self.set_f(68, ww_life); self.set_f(69, ww_rise); self.set_f(70, o.spr.map_or(1.0, |s| s.crest)); self.set_f(71, o.spr.map_or(0.5, |s| s.impact));
        self.pu[72] = (airo.is_some() && ad.is_some()) as u32; self.set_f(73, airo.map_or(0.0, |a| a.couple)); self.set_f(74, airo.map_or(0.0, |a| a.decay));
        self.set_f(75, ad.map_or(1.0, |a| a.h));
        let dims = ad.map_or([1; 3], |a| a.n);
        self.pu[76] = dims[0]; self.pu[77] = dims[1]; self.pu[78] = dims[2];
        if dr.is_some() { self.drip_update(gpu, &cols[..nc]); }
        self.pu[79] = if dr.is_some() { self.ndrip } else { 0 };
        self.set_f(80, dr.map_or(0.0, |d| d.rate)); self.set_f(81, dr.map_or(1.0, |d| d.dry)); self.set_f(82, airo.map_or(0.0, |a| a.blur));
        // real air flow (airUpdate .. airProj) and the water feeling it (airDragW); turbulence size in solver units, octaves, change, swirl
        self.air_real = airo.is_some_and(|a| a.real) && ad.is_some();
        self.air_feel = self.air_real && airo.is_some_and(|a| a.feel);
        self.air_iters = airo.map_or(20, |a| if a.iters > 0 { a.iters } else { 20 });
        self.set_f(440, airo.map_or(0.0, |a| a.size)); self.set_f(441, airo.map_or(3.0, |a| if a.oct != 0.0 { a.oct } else { 3.0 }));
        self.set_f(442, airo.map_or(0.0, |a| a.speed)); self.set_f(443, if self.air_real { airo.map_or(0.0, |a| a.swirl) } else { 0.0 });
        self.set_f(444, self.air_real as u32 as f32); self.set_f(445, self.air_feel as u32 as f32); self.set_f(446, o.drag); self.set_f(447, self.air_iters as f32);
        let area = o.spr.map_or([1.0, 1.0], |s| s.area);
        self.ab = ww_area_box(&b, area[0], area[1]);
        let ab = self.ab;
        for (k, v) in [ab.x0, ab.y0, ab.z0, 0.0, ab.x1, ab.y1, ab.z1, 0.0].iter().enumerate() { self.set_f(408 + k, *v); }
        self.set_f(83, o.spr.map_or(0.5, |s| s.spin));
        self.set_f(404, o.spr.map_or(70.0, |s| s.edge).to_radians().cos()); self.set_f(405, o.spr.map_or(0.25, |s| s.erode));
        self.set_f(406, o.spr.map_or(1.0, |s| s.land)); self.set_f(407, o.spr.map_or(1.0, |s| s.trail));
        self.air_on_step = airo.is_some() && ad.is_some();
        self.drip_on_step = dr.is_some() && self.ndrip > 0;
        self.set_f(416, if self.opt.ballistic && !self.ww_only { 1.0 } else { 0.0 });
        self.set_f(417, if self.opt.settle { self.opt.settle_tol } else { 0.0 });
        self.set_f(418, if self.opt.sep > 0.0 && !self.ww_only { 1.0 - (-self.opt.sep * dt).exp() } else { 0.0 });
        self.set_f(421, if apic { 1.0 } else { 0.0 });
        // the sharp water surface (ghost fluid with theta from the surface field each step); off: the page's cell-centred surface
        self.set_f(419, if self.opt.ghost && !self.ww_only { -1.0 } else { 0.0 });
        if self.opt.mg && !self.ww_only {
            self.mg_top = self.mg_plan(gpu);
            for (k, q) in self.mg_dense.clone().iter().enumerate() { self.pu[424 + 4 * k..428 + 4 * k].copy_from_slice(q); }
            self.set_f(420, 1.0);
        }
        gpu.queue.write_buffer(&self.buf[&0], 0, bytemuck::cast_slice(&self.pu));
        self.make_groups(gpu);
        let iters = o.iters.max(1);
        let mut enc = gpu.device.create_command_encoder(&Default::default());
        let qs = self.prof.as_ref().map(|p| p.0.clone());
        let names = std::cell::RefCell::new(Vec::<&'static str>::new());
        let mk = |ps: &mut wgpu::ComputePass, name: &'static str| {
            if let Some(q) = &qs { let i = names.borrow().len() as u32; if i < PROF_CAP { ps.write_timestamp(q, i); names.borrow_mut().push(name); } }
        };
        {
            let mut ps = enc.begin_compute_pass(&Default::default());
            mk(&mut ps, "start");
            self.stages(gpu, &mut ps, n, iters, &mk);
        }
        let k = self.read_stats(gpu, &mut enc);
        let names = names.into_inner();
        if let (Some((q, res, rd)), true) = (&self.prof, names.len() > 1) {
            enc.resolve_query_set(q, 0..names.len() as u32, res, 0);
            enc.copy_buffer_to_buffer(res, 0, rd, 0, names.len() as u64 * 8);
        }
        gpu.queue.submit([enc.finish()]);
        if let Some(k) = k { self.start_map(k); }
        if let (Some((_, _, rd)), true) = (&self.prof, names.len() > 1) {
            rd.slice(..).map_async(wgpu::MapMode::Read, |_| {});
            let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
            let t: Vec<u64> = { let m = rd.slice(..).get_mapped_range().unwrap(); bytemuck::cast_slice(&m[..names.len() * 8]).to_vec() };
            rd.unmap();
            let per = gpu.queue.get_timestamp_period() as f64 * 1e-6;
            for i in 1..names.len() {
                let ms = t[i].saturating_sub(t[i - 1]) as f64 * per;
                match self.prof_acc.iter_mut().find(|e| e.0 == names[i]) { Some(e) => e.1 += ms, None => self.prof_acc.push((names[i].to_string(), ms)) }
            }
            self.prof_steps += 1;
        }
    }

    /// mk(ps, name): a timestamp for the benchmark, ending the stage of that name (nothing unless profiling).
    fn stages(&mut self, gpu: &Gpu, ps: &mut wgpu::ComputePass, n: u32, iters: u32, mk: &dyn Fn(&mut wgpu::ComputePass, &'static str)) {
        let g = &self.groups;
        let args = &self.buf[&14];
        let dispatch = |ps: &mut wgpu::ComputePass, name: &str, items: u32| {
            let groups = items.div_ceil(256);
            ps.set_pipeline(&gpu.pipes[name].pipeline);
            ps.set_bind_group(0, &g[name], &[]);
            ps.dispatch_workgroups(groups.min(65535), groups.div_ceil(65535), 1);
        };
        let indirect = |ps: &mut wgpu::ComputePass, name: &str, off: u64| {
            ps.set_pipeline(&gpu.pipes[name].pipeline);
            ps.set_bind_group(0, &g[name], &[]);
            ps.dispatch_workgroups_indirect(args, off);
        };
        let apic = self.opt.apic && !self.ww_only;
        let sort_on = self.opt.sort && !self.ww_only;
        if sort_on && !self.only_tiles {
            self.sort_tick += 1;
            self.sort_moved += self.stats.map(|s| s.vmax).unwrap_or(0.0) * self.last_dt / self.l.h;
            if !self.sorted_ever || self.sort_tick >= 64 || (self.sort_tick >= 4 && self.sort_moved >= 2.0) {
                self.sort_tick = 0; self.sort_moved = 0.0; self.sorted_ever = true;
                let (sk, sch) = sort_keys(self.l.n);
                dispatch(ps, "sortClear", sk + 1); dispatch(ps, "sortHist", n); dispatch(ps, "sortSums", sch);
                ps.set_pipeline(&gpu.pipes["sortScan"].pipeline); ps.set_bind_group(0, &g["sortScan"], &[]); ps.dispatch_workgroups(1, 1, 1);
                dispatch(ps, "sortApply", sch);
                if apic { dispatch(ps, "sortScatterA", n); dispatch(ps, "sortCopyA", n); } else { dispatch(ps, "sortScatter", n); dispatch(ps, "sortCopy", n); }
                mk(ps, "sort");
            }
        }
        let (nb, init) = (self.nb_on, self.init_step);
        let tall = self.tall_t0 > 0 && nb && !self.ww_only;
        if tall { dispatch(ps, "tallStep", 1); }
        // blocks
        dispatch(ps, "tileNeedClear", self.ntiles); dispatch(ps, "tileMark", n);
        if nb && init != 1 { indirect(ps, "tileMarkPhi", 64); }   // last step's blocks that hold water by depth (before the counters reset)
        if init > 0 { dispatch(ps, "tileMarkFill", self.ntiles); }
        dispatch(ps, "tileReset", 1);
        dispatch(ps, "tileFree", self.ntiles); dispatch(ps, "argsNew", 1); indirect(ps, "tileAlloc", 32); dispatch(ps, "tileFix", 1);
        indirect(ps, "initNew", 48); dispatch(ps, "slotListBuild", self.ntiles); dispatch(ps, "argsSlots", 1);
        if tall { indirect(ps, "tallFill", 64); }   // a block row given back by the tall cells: ordinary deep water again
        if init > 0 { indirect(ps, "phiInitAll", 64); }
        mk(ps, "blocks");
        if self.only_tiles { return; }
        indirect(ps, "clearSlots", 80);
        dispatch(ps, if self.opt.p2g_win { "p2gWin" } else { "p2g" }, n);
        if self.opt.ghost && !self.ww_only { dispatch(ps, "surfSplat", n); }
        mk(ps, "p2g");
        if nb { indirect(ps, "nbPhi", 64); indirect(ps, "nbJacA", 64); indirect(ps, "nbJacB", 64); indirect(ps, "nbJacA", 64); mk(ps, "narrow band"); }
        if self.solid_dirty { indirect(ps, "solidBuild", 64); self.solid_dirty = false; }
        indirect(ps, "classify", 64);
        if self.opt.ghost && !self.ww_only { indirect(ps, "surfPhi", 64); }
        if nb { indirect(ps, "nbVel", 64); }
        indirect(ps, "normFaces", 64);
        mk(ps, "classify");
        if !self.ww_only { self.water_stages(gpu, ps, n, iters, mk); }
        // the air field first, so the whitewater moves with this step's air
        if self.air_on_step {
            let na = self.air_dims.unwrap().cells;
            dispatch(ps, "wwArgs", 1);
            dispatch(ps, "airClear", na); dispatch(ps, "airSplatW", n); indirect(ps, "airSplatS", 112); dispatch(ps, "airUpdate", na);
            if self.air_real {
                dispatch(ps, "airDiv", na);
                for _ in 0..self.air_iters { dispatch(ps, "airRed", na); dispatch(ps, "airBlack", na); }
                dispatch(ps, "airProj", na);
            }
            dispatch(ps, "airCopy", na);
            if self.air_feel { dispatch(ps, "airDragW", n); }   // the water feels this step's air
            mk(ps, "air");
        }
        // whitewater: sampling the water at each point, moving the points, and making new ones from the water
        if self.spray_cap > 0 {
            // sampling the water stays its own pass: folded into sprayStep the one big kernel ran slower (5.7 ms against 2.7 + 1.0 on Meteor lake at 0.015)
            dispatch(ps, "wwArgs", 1); indirect(ps, "wwSample", 112);
            mk(ps, "ww sample");
            indirect(ps, "sprayStep", 112);
            mk(ps, "ww move");
            if self.spr_on_step { dispatch(ps, "sprayEmit", n); if f32::from_bits(self.pu[83]) > 0.0 { dispatch(ps, "spinEmit", n); } }
            if self.drip_on_step { dispatch(ps, "dripStep", self.ndrip); }
            mk(ps, "ww emit");
        }
        if nb {
            if tall { indirect(ps, "tallCheck", 64); }
            dispatch(ps, "nbKill", n); dispatch(ps, "nbReset", 1); dispatch(ps, "nbDead", n); indirect(ps, "nbDeficit", 64); dispatch(ps, "nbArgs", 1); indirect(ps, "nbSpawn", 96);
            mk(ps, "narrow band");
        }
        if self.ww_only { dispatch(ps, "wwAdvect", n); }   // the particles move on towards the next baked frame
    }

    /// The water's own solve: divergence, pressure, projection, grid to particles, fast drops and separation (left out by the
    /// whitewater-only pass, which moves the baked particles along their own velocity instead).
    fn water_stages(&self, gpu: &Gpu, ps: &mut wgpu::ComputePass, n: u32, iters: u32, mk: &dyn Fn(&mut wgpu::ComputePass, &'static str)) {
        let g = &self.groups;
        let args = &self.buf[&14];
        let dispatch = |ps: &mut wgpu::ComputePass, name: &str, items: u32| {
            let groups = items.div_ceil(256);
            ps.set_pipeline(&gpu.pipes[name].pipeline);
            ps.set_bind_group(0, &g[name], &[]);
            ps.dispatch_workgroups(groups.min(65535), groups.div_ceil(65535), 1);
        };
        let indirect = |ps: &mut wgpu::ComputePass, name: &str, off: u64| {
            ps.set_pipeline(&gpu.pipes[name].pipeline);
            ps.set_bind_group(0, &g[name], &[]);
            ps.dispatch_workgroups_indirect(args, off);
        };
        let (apic, nb) = (self.opt.apic, self.nb_on);
        indirect(ps, "divergence", 64);
        let tall = self.tall_t0 > 0 && nb;
        let ncol = self.l.n[0] * self.l.n[2];
        if tall { dispatch(ps, "tallDiv", ncol); }
        indirect(ps, "settleMark", 64);
        dispatch(ps, "listClear", 1);
        indirect(ps, if gpu.sg && gpu.pipes.contains_key("buildListSG") { "buildListSG" } else { "buildList" }, 64);
        dispatch(ps, "listArgs", 1);
        mk(ps, "divergence");
        // pressure: red-black sweeps, or multigrid V-cycles (about one per 10 iterations asked for) between sweeps
        // the tall cells are relaxed with the ordinary ones, twice per sweep (their sideways coupling is their height in cells strong)
        let sweep = |ps: &mut wgpu::ComputePass, k: u32| { for _ in 0..k {
            indirect(ps, "rbRed", 0); indirect(ps, "rbBlack", 16);
            if tall { for _ in 0..16 { dispatch(ps, "tallRed", ncol); dispatch(ps, "tallBlack", ncol); } }
        } };
        if !self.opt.mg || self.mg_top == 0 { sweep(ps, iters); } else {
            let (top, dz) = (self.mg_top, &self.mg_dense);
            let lv = |ps: &mut wgpu::ComputePass, nm: &str, l: u32| {
                if l <= 3 { indirect(ps, nm, [0u64, 128, 144, 160][l as usize]); } else { let q = dz[l as usize - 4]; dispatch(ps, nm, q[0] * q[1] * q[2]); }
            };
            let smooth = |ps: &mut wgpu::ComputePass, l: u32, k: u32| { for _ in 0..k { lv(ps, &format!("mgS{l}a"), l); lv(ps, &format!("mgS{l}b"), l); } };
            dispatch(ps, "mgArgs", 1);
            for _ in 0..1u32.max((iters as f32 / 10.0).round() as u32) {
                sweep(ps, 4);
                for l in 1..=top { lv(ps, &format!("mgDown{l}"), l); smooth(ps, l, if l == top { 16 } else { 2 }); }
                for l in (1..top).rev() { lv(ps, &format!("mgUp{l}"), l); smooth(ps, l, 2); }
                indirect(ps, "mgUp0", 64);
            }
            sweep(ps, 2);
        }
        mk(ps, "pressure");
        indirect(ps, "project", 64);
        if tall { dispatch(ps, "tallProj", (self.l.n[0] + 1) * (self.l.n[2] + 1)); }
        if nb { indirect(ps, "saveVel", 64); }
        if self.opt.extrap { indirect(ps, "extrap", 64); }
        mk(ps, "project");
        dispatch(ps, if apic { if gpu.pipes.contains_key("g2pAo") { "g2pAo" } else { "g2pA" } } else if self.opt.p2g_win { "g2pWin" } else { "g2p" }, n);
        mk(ps, "g2p");
        if self.opt.ballistic { dispatch(ps, "ballistic", n); mk(ps, "fast drops"); }
        if self.opt.sep > 0.0 {
            indirect(ps, "sepClear", 64);
            for _ in 0..self.opt.sep_iters { indirect(ps, "sepRed", 0); indirect(ps, "sepBlack", 16); }
            dispatch(ps, "sepMove", n);
            mk(ps, "separation");
        }
    }

    /// Runs only the block allocation until the starting water fits the pool (prime).
    pub fn prime(&mut self, gpu: &Gpu, g: f32) {
        let par = StepPar::bare(g, 1);
        for _ in 0..8 {
            self.only_tiles = true;
            self.step(gpu, 1.0 / 60.0, &par, &[]);
            self.only_tiles = false;
            self.wait_stats(gpu);
            let Some(s) = self.stats.as_mut() else { return; };
            s.seen = true;
            let (sc, ovf) = (s.sc, s.ovf);
            if ovf == 0 && sc as f32 <= 0.8 * self.scap as f32 { return; }
            let w = ((self.scap as f32 * 1.5).ceil() as u32).max(((sc + ovf) as f32 * 1.4).ceil() as u32 + 8);
            self.grow(gpu, w);
        }
    }

    /// Particle positions in their original order (x y z, speed + 64 x white-water level in w), into dst (readbackInto).
    pub fn readback(&mut self, gpu: &Gpu, dst: &mut Vec<f32>) -> u32 {
        self.readback_begin(gpu);
        self.readback_end(gpu, dst)
    }

    /// Starts reading the particles back (in id order) and the fastest particle (speedMax): the copies are queued behind the frame's work
    /// and mapped when the GPU gets there, so the next frame can be sent meanwhile. Returns how many particles.
    pub fn readback_begin(&mut self, gpu: &Gpu) -> u32 {
        self.flush_run(gpu);
        let n = self.n;
        let bytes = sizes(n) * 16;
        if self.fstage.is_none() {
            self.fstage = Some(gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some("fmax"), size: 16, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false }));
        }
        gpu.queue.write_buffer(&self.buf[&45], 0, &[0u8; 16]);
        if self.stage.as_ref().map(|s| s.size() < bytes).unwrap_or(true) {
            self.stage = Some(gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some("readback"), size: (self.max_n as u64).max(1) * 16,
                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false }));
        }
        self.make_groups(gpu);
        let mut enc = gpu.device.create_command_encoder(&Default::default());
        self.pu[0] = n;
        gpu.queue.write_buffer(&self.buf[&0], 0, bytemuck::cast_slice(&self.pu[..1]));
        {
            let mut ps = enc.begin_compute_pass(&Default::default());
            let g = n.div_ceil(256);
            ps.set_pipeline(&gpu.pipes["speedMax"].pipeline); ps.set_bind_group(0, &self.groups["speedMax"], &[]);
            ps.dispatch_workgroups(g.min(65535), g.div_ceil(65535), 1);
            if self.sorted_ever {
                ps.set_pipeline(&gpu.pipes["unsort"].pipeline); ps.set_bind_group(0, &self.groups["unsort"], &[]);
                ps.dispatch_workgroups(g.min(65535), g.div_ceil(65535), 1);
            }
        }
        enc.copy_buffer_to_buffer(&self.buf[if self.sorted_ever { &23 } else { &1 }], 0, self.stage.as_ref().unwrap(), 0, bytes);
        enc.copy_buffer_to_buffer(&self.buf[&45], 0, self.fstage.as_ref().unwrap(), 0, 16);
        let idx = gpu.queue.submit([enc.finish()]);
        self.stage.as_ref().unwrap().slice(..bytes).map_async(wgpu::MapMode::Read, |_| {});
        self.fstage.as_ref().unwrap().slice(..).map_async(wgpu::MapMode::Read, |_| {});
        self.fmapped = true;
        self.pending = Some((n, bytes, idx));
        n
    }

    /// The fastest particle at the end of the frame whose readback was started (waits for the GPU to finish that frame).
    pub fn frame_speed(&mut self, gpu: &Gpu) -> f32 {
        let Some(fs) = self.fstage.as_ref().filter(|_| self.fmapped) else { return 0.0; };
        // only up to the readback's own submission (a frame sent after it keeps running)
        let idx = self.pending.as_ref().map(|p| p.2.clone());
        let _ = gpu.device.poll(wgpu::PollType::Wait { submission_index: idx, timeout: None });
        let v = { let m = fs.slice(..).get_mapped_range().unwrap(); f32::from_bits(u32::from_le_bytes([m[0], m[1], m[2], m[3]])) };
        fs.unmap();
        self.fmapped = false;
        if v.is_finite() { v } else { 0.0 }
    }

    /// Collects the readback started by readback_begin into dst (waits only if the copy is not done yet).
    pub fn readback_end(&mut self, gpu: &Gpu, dst: &mut Vec<f32>) -> u32 {
        let Some((n, bytes, idx)) = self.pending.take() else { dst.clear(); return 0; };
        let _ = gpu.device.poll(wgpu::PollType::Wait { submission_index: Some(idx), timeout: None });
        // the fastest particle's stage is mapped too: let go of it if frame_speed was not asked
        if self.fmapped { if let Some(fs) = self.fstage.as_ref() { fs.unmap(); } self.fmapped = false; }
        let st = self.stage.as_ref().unwrap();
        dst.clear();
        dst.extend_from_slice(bytemuck::cast_slice(&st.slice(..bytes).get_mapped_range().unwrap()[..n as usize * 16]));
        st.unmap();
        self.collect_stats(gpu);
        n
    }

    /// Copies bytes from buffer k at off into a reused staging buffer and maps it.
    fn read_into(gpu: &Gpu, src: &wgpu::Buffer, off: u64, bytes: u64, stage: &mut Option<wgpu::Buffer>, enc: Option<wgpu::CommandEncoder>) -> Vec<u8> {
        if stage.as_ref().map(|s| s.size() < bytes).unwrap_or(true) {
            *stage = Some(gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some("stage"), size: bytes.max(16).div_ceil(4) * 4,
                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false }));
        }
        let st = stage.as_ref().unwrap();
        let mut enc = enc.unwrap_or_else(|| gpu.device.create_command_encoder(&Default::default()));
        enc.copy_buffer_to_buffer(src, off, st, 0, bytes);
        gpu.queue.submit([enc.finish()]);
        st.slice(..bytes).map_async(wgpu::MapMode::Read, |_| {});
        let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
        let v = st.slice(..bytes).get_mapped_range().unwrap().to_vec();
        st.unmap();
        v
    }

    /// Every whitewater slot handed out so far (until the ring wraps the rest were never used): positions with life in w, then
    /// velocities with kind in w (readSpray).
    pub fn read_spray(&mut self, gpu: &Gpu) -> Option<(usize, Vec<f32>, Vec<f32>)> {
        if self.spray_cap == 0 { return None; }
        let used = { let a = Self::read_into(gpu, &self.buf[&30], 0, 16, &mut self.sctl_stage, None); u32::from_le_bytes([a[0], a[1], a[2], a[3]]) };
        let n = used.min(self.spray_cap).max(1) as u64;
        let p: Vec<f32> = bytemuck::cast_slice(&Self::read_into(gpu, &self.buf[&28], 0, n * 16, &mut self.sstage, None)).to_vec();
        let v: Vec<f32> = bytemuck::cast_slice(&Self::read_into(gpu, &self.buf[&29], 0, n * 16, &mut self.sstage, None)).to_vec();
        Some((n as usize, p, v))
    }

    /// The deep water points of the last step (narrow band look; x y z, 4096 + speed), the empty ones dropped (readDeep).
    pub fn read_deep(&mut self, gpu: &Gpu) -> Option<Vec<f32>> {
        if !self.deep_on || !self.nb_on || !self.vel_g_on || self.n == 0 { return None; }
        let off = f32::from_bits(self.pu[62]).round() as u64 * 16;
        let bytes = DEEPMAX as u64 * 16;
        if off + bytes > self.buf[&15].size() { return None; }
        self.make_groups(gpu);
        let mut enc = gpu.device.create_command_encoder(&Default::default());
        {
            let mut ps = enc.begin_compute_pass(&Default::default());
            let g3 = DEEPMAX.div_ceil(256);
            ps.set_pipeline(&gpu.pipes["deepClear"].pipeline); ps.set_bind_group(0, &self.groups["deepClear"], &[]); ps.dispatch_workgroups(g3.min(65535), g3.div_ceil(65535), 1);
            ps.set_pipeline(&gpu.pipes["deepPick"].pipeline); ps.set_bind_group(0, &self.groups["deepPick"], &[]); ps.dispatch_workgroups_indirect(&self.buf[&14], 64);
            if self.tall_t0 > 0 {
                let gt = (self.l.n[0] * self.l.n[2] * self.tall_t0).div_ceil(256);
                ps.set_pipeline(&gpu.pipes["tallPick"].pipeline); ps.set_bind_group(0, &self.groups["tallPick"], &[]); ps.dispatch_workgroups(gt.min(65535), gt.div_ceil(65535), 1);
            }
            ps.set_pipeline(&gpu.pipes["deepFin"].pipeline); ps.set_bind_group(0, &self.groups["deepFin"], &[]); ps.dispatch_workgroups(1, 1, 1);
        }
        let a: Vec<f32> = bytemuck::cast_slice(&Self::read_into(gpu, &self.buf[&15], off, bytes, &mut self.dstage, Some(enc))).to_vec();
        Some(a.chunks(4).filter(|q| q[1] >= -1e5).flatten().copied().collect())
    }

    fn read_buf(&self, gpu: &Gpu, k: u32, bytes: u64) -> Vec<u8> {
        let st = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: None, size: bytes, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let mut enc = gpu.device.create_command_encoder(&Default::default());
        enc.copy_buffer_to_buffer(&self.buf[&k], 0, &st, 0, bytes);
        gpu.queue.submit([enc.finish()]);
        st.slice(..).map_async(wgpu::MapMode::Read, |_| {});
        let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
        let v = st.slice(..).get_mapped_range().unwrap().to_vec();
        st.unmap();
        v
    }

    /// How far the pressure is from solving the last step exactly over every water cell: root mean square of the residual against
    /// that of the right-hand side (0 exact, 1 as bad as no pressure) (presResidual). Steers the Accurate bake's iterations.
    pub fn pres_residual(&self, gpu: &Gpu) -> f32 {
        let tmap: Vec<u32> = bytemuck::cast_slice(&self.read_buf(gpu, 16, self.ntiles as u64 * 4)).to_vec();
        let bytes = self.scap as u64 * 512 * 4;
        let ty: Vec<u32> = bytemuck::cast_slice(&self.read_buf(gpu, 7, bytes)).to_vec();
        let pr: Vec<f32> = bytemuck::cast_slice(&self.read_buf(gpu, 8, bytes)).to_vec();
        let rh: Vec<f32> = bytemuck::cast_slice(&self.read_buf(gpu, 9, bytes)).to_vec();
        let sp: Vec<f32> = if self.opt.ghost { bytemuck::cast_slice(&self.read_buf(gpu, 47, bytes)).to_vec() } else { Vec::new() };
        let [nx, ny, nz] = self.l.n.map(|v| v as i64);
        let [tx, ty_] = [self.t[0] as i64, self.t[1] as i64];
        let open = self.open;
        let idx = |i: i64, j: i64, k: i64| -> i64 { let s = tmap[((i >> 3) + tx * ((j >> 3) + ty_ * (k >> 3))) as usize]; if s == u32::MAX { -1 } else { s as i64 * 512 + (i & 7) + 8 * ((j & 7) + 8 * (k & 7)) } };
        let ty_of = |i: i64, j: i64, k: i64| -> u32 {
            if i < 0 { return if open & 1 != 0 { 0 } else { 2 }; } if i >= nx { return if open & 2 != 0 { 0 } else { 2 }; }
            if j < 0 { return if open & 4 != 0 { 0 } else { 2 }; } if j >= ny { return if open & 8 != 0 { 0 } else { 2 }; }
            if k < 0 { return if open & 16 != 0 { 0 } else { 2 }; } if k >= nz { return if open & 32 != 0 { 0 } else { 2 }; }
            let c = idx(i, j, k); if c < 0 { 0 } else { ty[c as usize] & 255 }
        };
        let (mut r2, mut b2) = (0f64, 0f64);
        for t in 0..self.ntiles as i64 {
            let s = tmap[t as usize];
            if s == u32::MAX { continue; }
            let (bi, tt) = ((t % tx) * 8, t / tx);
            let (bj, bk) = ((tt % ty_) * 8, (tt / ty_) * 8);
            for l in 0..512i64 {
                let c = s as usize * 512 + l as usize;
                if ty[c] & 255 != 1 { continue; }
                let (i, j, k) = (bi + (l & 7), bj + ((l >> 3) & 7), bk + (l >> 6));
                if i >= nx || j >= ny || k >= nz { continue; }
                let (mut sum, mut nns) = (0f64, 0f64);
                for (a, b, cc) in [(-1, 0, 0), (1, 0, 0), (0, -1, 0), (0, 1, 0), (0, 0, -1), (0, 0, 1)] {
                    let q = ty_of(i + a, j + b, k + cc);
                    if q == 2 { continue; }
                    if q == 1 { nns += 1.0; sum += pr[idx(i + a, j + b, k + cc) as usize] as f64; continue; }
                    // to air: over theta (faceTheta in solver.wgsl)
                    let (qi, qj, qk) = (i + a, j + b, k + cc);
                    let inside = qi >= 0 && qj >= 0 && qk >= 0 && qi < nx && qj < ny && qk < nz;
                    let pa = if sp.is_empty() { 0.0 } else { let x = if inside { idx(qi, qj, qk) } else { -1 }; if x < 0 { 1.5 } else { sp[x as usize] } };
                    let pf = if sp.is_empty() { 0.0 } else { sp[c] };
                    let th = if sp.is_empty() || pa <= 0.0 { 1.0 } else if pf >= 0.0 { 0.1 } else { (pf / (pf - pa)).clamp(0.1, 1.0) };
                    nns += 1.0 / th as f64;
                }
                let r = rh[c] as f64 - (nns * pr[c] as f64 - sum);
                r2 += r * r; b2 += (rh[c] as f64).powi(2);
            }
        }
        (r2 / b2.max(1e-30)).sqrt() as f32
    }
}

/// A small fast random number generator (splitmix64) for jitter and emitters; the page uses Math.random, so runs differ anyway.
pub struct Rng(pub u64);
impl Rng {
    pub fn new(seed: u64) -> Rng { Rng(seed) }
    pub fn f(&mut self) -> f32 {
        self.0 = self.0.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        ((z ^ (z >> 31)) >> 40) as f32 / (1u64 << 24) as f32
    }
}
