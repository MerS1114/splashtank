//! The FLIP solver: a port of the FlipSim class in src/flip/sim.js (buffers, parameter block, stages, block pool growth, readbacks),
//! running the page's own kernels. So far the water itself: blocks, transfer (FLIP or APIC), pressure (red-black SOR or multigrid),
//! separation, fast drops, colliders and emitters. Narrow band, ocean, whitewater, the air field and drips come in the next phase; their
//! parameter words are written with those parts off.

use crate::gpu::Gpu;
use crate::scene::Col;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;

const SLOT_CELLS: u64 = 512;
const MGS: u64 = 220;
const MG_LEVELS: usize = 7;
const STOR: wgpu::BufferUsages = wgpu::BufferUsages::STORAGE.union(wgpu::BufferUsages::COPY_SRC).union(wgpu::BufferUsages::COPY_DST);

/// Grid of a sim with these options (FlipSim.layout): cell size h = ratio x spacing, cells a side, the box centred on x and z on y = 0.
#[derive(Clone, Copy, Debug)]
pub struct Layout { pub d: f32, pub ratio: f32, pub h: f32, pub n: [u32; 3], pub b: splash_format::Box3, pub size: [f32; 3] }

pub fn layout(d: f32, ratio: f32, size: [f32; 3]) -> Layout {
    let ratio = ratio.clamp(1.4, 4.0);
    let h = ratio * d;
    let n = size.map(|s| ((s / h).round() as u32).max(4));
    let (w, hh, dd) = (n[0] as f32 * h, n[1] as f32 * h, n[2] as f32 * h);
    Layout { d, ratio, h, n, b: splash_format::Box3 { x0: -w / 2.0, x1: w / 2.0, y0: 0.0, y1: hh, z0: -dd / 2.0, z1: dd / 2.0 }, size: [w, hh, dd] }
}

#[derive(Clone, Copy, Default, Debug)]
pub struct Stats { pub sc: u32, pub ovf: u32, pub fluid: u32, pub settled: u32, pub free: u32, pub need: u32, pub vmax: f32, pub seen: bool }

/// Per-step settings (the page's simPar with the parts the native solver runs).
#[derive(Clone, Copy, Debug)]
pub struct StepPar { pub g: f32, pub iters: u32, pub flip: f32, pub apic_flip: f32, pub comp: f32, pub vmax: f32, pub vs: f32, pub tear: f32, pub time: f32 }

/// Solver options (sim.opt).
#[derive(Clone, Copy, Debug)]
pub struct Opt { pub apic: bool, pub sort: bool, pub sort_auto: bool, pub p2g_win: bool, pub ballistic: bool, pub settle: bool, pub settle_tol: f32,
    pub mg: bool, pub sep: f32, pub sep_iters: u32, pub extrap: bool }
impl Default for Opt {
    fn default() -> Opt { Opt { apic: true, sort: false, sort_auto: true, p2g_win: false, ballistic: true, settle: false, settle_tol: 0.001, mg: true, sep: 10.0, sep_iters: 8, extrap: true } }
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
    pub grew: u32,
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
        buf.insert(10, mk(32 * 128)); buf.insert(22, mk(65536 * 4)); buf.insert(23, mk(16)); buf.insert(24, mk(16));
        buf.insert(12, dev.create_buffer(&wgpu::BufferDescriptor { label: Some("ctl"), size: 64, usage: STOR, mapped_at_creation: false }));
        buf.insert(25, mk(16));
        buf.insert(15, mk(16)); buf.insert(37, mk(16));
        buf.insert(38, dev.create_buffer(&wgpu::BufferDescriptor { label: Some("packU"), size: 128, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false }));
        buf.insert(14, dev.create_buffer(&wgpu::BufferDescriptor { label: Some("args"), size: 192, usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::INDIRECT | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false }));
        buf.insert(11, mk(64));
        let stats_ring = StatRing { bufs: (0..3).map(|_| (dev.create_buffer(&wgpu::BufferDescriptor { label: Some("stat"), size: 64,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false }), Arc::new(AtomicU8::new(FREE)))).collect() };
        let mut s = FlipSim {
            l, rest: l.ratio.powi(3), open, max_n, cap: max_n, n: 0, opt: Opt::default(), ntiles, t, scap, scap_max, lcap: 0, buf,
            groups: HashMap::new(), groups_dirty: true, pu: vec![0; (gpu.params_bytes / 4) as usize], cf: vec![0.0; 32 * 32], cf_prev: None, solid_dirty: true,
            sdf_sig: 0, sdf_cap: 16, run_start: 0, run_pos: Vec::new(), run_vel: Vec::new(), tm: 0.0, seed: 0, sort_tick: 0, sort_moved: 0.0, sorted_ever: false,
            last_dt: 0.0, mg_size: 0, mg_dense: Vec::new(), mg_top: 0, only_tiles: false, stats_ring, stats: None, ovf_total: 0, stage: None, grew: 0,
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
    pub fn h(&self) -> f32 { self.l.h }

    fn mk(gpu: &Gpu, size: u64) -> wgpu::Buffer {
        gpu.device.create_buffer(&wgpu::BufferDescriptor { label: None, size: size.max(16).div_ceil(4) * 4, usage: STOR, mapped_at_creation: false })
    }

    /// Per-block storage: counts, type, pressure, rhs, calm, separation potential (4 bytes a cell), the faces (12 bytes a cell, twice),
    /// kept velocity (narrow band only), slot bookkeeping, and the fluid cell lists.
    fn make_slot_buffers(&mut self, gpu: &Gpu, n: u32) {
        let c = n as u64 * SLOT_CELLS;
        for k in [6, 7, 8, 9, 39, 41] { self.buf.insert(k, Self::mk(gpu, c * 4)); }
        self.buf.insert(3, Self::mk(gpu, c * 12)); self.buf.insert(5, Self::mk(gpu, c * 12)); self.buf.insert(31, Self::mk(gpu, 16));
        for k in [18, 19, 20] { self.buf.insert(k, Self::mk(gpu, n as u64 * 4)); }
        self.lcap = (c as u32).min(self.max_n);
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
        let keep: Vec<(u32, wgpu::Buffer, u64)> = [(6, 2048), (7, 2048), (8, 2048), (9, 2048), (39, 2048), (41, 2048), (3, 6144), (5, 6144), (18, 4), (19, 4), (20, 4)]
            .iter().map(|&(k, per)| (k, self.buf.remove(&k).unwrap(), per)).collect();
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
        if s.ovf > 0 || want as f32 > 0.8 * self.scap as f32 {
            let w = ((self.scap as f32 * 1.5).ceil() as u32).max((want as f32 * 1.4).ceil() as u32 + 8);
            self.grow(gpu, w);
        }
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
    pub fn fill_box(&mut self, gpu: &Gpu, rng: &mut Rng, b: [f32; 6]) {
        let d = self.l.d as f64;
        let j = (0.01 * d / 0.12) as f32;
        let b = b.map(|v| v as f64);
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
    pub fn fill_sphere(&mut self, gpu: &Gpu, rng: &mut Rng, c: [f32; 3], r: f32, v: [f32; 3]) {
        let d = self.l.d as f64;
        let j = (0.01 * d / 0.12) as f32;
        let r = r as f64;
        let mut y = -r;
        while y <= r {
            let mut x = -r;
            while x <= r {
                let mut z = -r;
                while z <= r {
                    if x * x + y * y + z * z <= r * r && !self.add(gpu, [c[0] + x as f32 + (rng.f() - 0.5) * j, c[1] + y as f32 + (rng.f() - 0.5) * j, c[2] + z as f32 + (rng.f() - 0.5) * j], v) { return; }
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
        if !self.only_tiles { self.maybe_grow(gpu); }
        let (h, b) = (self.l.h, self.l.b);
        let nc = self.pack_colliders(gpu, cols);
        {
            let n32 = nc * 32;
            let same = matches!(&self.cf_prev, Some((pn, ps, a)) if *pn == nc && *ps == self.sdf_sig && a[..] == self.cf[..n32]);
            if !same { self.solid_dirty = true; self.cf_prev = Some((nc, self.sdf_sig, self.cf[..n32].to_vec())); }
        }
        let apic = self.opt.apic;
        if apic && self.buf[&42].size() < self.max_n as u64 * 48 { self.buf.insert(42, Self::mk(gpu, self.max_n as u64 * 48)); self.groups_dirty = true; }
        let fr = if apic { if gpu.pipes.contains_key("g2pAo") { o.apic_flip } else { 0.0 } } else { o.flip };
        let flip = fr.clamp(0.0, 1.0).powf(dt * 60.0);
        let stride = 1u32.max(n.div_ceil(300000));
        self.pu.iter_mut().for_each(|w| *w = 0);
        let u = &mut self.pu;
        u[0] = n; u[1] = self.l.n[0]; u[2] = self.l.n[1]; u[3] = self.l.n[2]; u[4] = nc as u32; u[5] = self.open; u[6] = 0; u[7] = self.l.n[0] * self.l.n[1] * self.l.n[2];
        let omega = if self.opt.mg { 1.4 } else { self.omega() };
        let f = [dt, h, 1.0 / h, o.g, flip, self.rest, o.comp, omega, b.x0, b.y0, b.z0, o.vmax, 0.3 * self.l.d, 65536.0, b.x1, b.y1, b.z1, 0.3 * h,
            0.0, 0.0, 0.0, 0.0, 1.2, 1.0, 0.0, self.tm, 0.0, 0.0, stride as f32, 0.0];
        if !self.only_tiles { self.tm += dt; }
        for (k, v) in f.iter().enumerate() { self.set_f(8 + k, *v); }
        let bb = 8 + f.len();
        let u = &mut self.pu;
        u[bb] = self.lcap; u[bb + 1] = self.t[0]; u[bb + 2] = self.t[1]; u[bb + 3] = self.t[2]; u[bb + 4] = self.scap;
        self.set_f(bb + 5, o.tear); self.set_f(bb + 6, 0.0); self.set_f(bb + 7, 1.0); self.set_f(bb + 8, 1.0); self.set_f(bb + 9, 0.0);
        self.set_f(bb + 10, 1.0); self.set_f(bb + 11, 4.0); self.set_f(bb + 12, o.vs);
        self.pu[bb + 13] = 0; self.pu[bb + 14] = if stride <= 1 { n } else { n.div_ceil(stride) }; self.pu[bb + 15] = 0;
        if !self.only_tiles { self.seed = self.seed.wrapping_add(1); }
        self.pu[bb + 16] = self.seed;
        // narrow band and ocean off (words 55-67)
        self.set_f(56, 3.0); self.set_f(59, o.time); self.set_f(63, b.y0); self.set_f(66, 1.0);
        // whitewater, air, drips off (68-83, 440-447), with the page's defaults
        self.set_f(68, 3.0); self.set_f(69, 0.3); self.set_f(70, 1.0); self.set_f(71, 0.5); self.set_f(75, 1.0);
        self.pu[76] = 1; self.pu[77] = 1; self.pu[78] = 1; self.set_f(81, 1.0); self.set_f(83, 0.5);
        self.set_f(441, 3.0); self.set_f(447, 20.0);
        for (k, v) in [b.x0, b.y0, b.z0, 0.0, b.x1, b.y1, b.z1, 0.0].iter().enumerate() { self.set_f(408 + k, *v); }
        self.set_f(404, (70f32).to_radians().cos()); self.set_f(405, 0.25); self.set_f(406, 1.0); self.set_f(407, 1.0);
        self.set_f(416, if self.opt.ballistic { 1.0 } else { 0.0 });
        self.set_f(417, if self.opt.settle { self.opt.settle_tol } else { 0.0 });
        self.set_f(418, if self.opt.sep > 0.0 { 1.0 - (-self.opt.sep * dt).exp() } else { 0.0 });
        self.set_f(421, if apic { 1.0 } else { 0.0 });
        if self.opt.mg {
            self.mg_top = self.mg_plan(gpu);
            for (k, q) in self.mg_dense.clone().iter().enumerate() { self.pu[424 + 4 * k..428 + 4 * k].copy_from_slice(q); }
            self.set_f(420, 1.0);
        }
        gpu.queue.write_buffer(&self.buf[&0], 0, bytemuck::cast_slice(&self.pu));
        self.make_groups(gpu);
        let iters = o.iters.max(1);
        let mut enc = gpu.device.create_command_encoder(&Default::default());
        {
            let mut ps = enc.begin_compute_pass(&Default::default());
            self.stages(gpu, &mut ps, n, iters);
        }
        let k = self.read_stats(gpu, &mut enc);
        gpu.queue.submit([enc.finish()]);
        if let Some(k) = k { self.start_map(k); }
    }

    fn stages(&mut self, gpu: &Gpu, ps: &mut wgpu::ComputePass, n: u32, iters: u32) {
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
        let apic = self.opt.apic;
        let sort_on = self.opt.sort && !apic;
        if sort_on && !self.only_tiles {
            self.sort_tick += 1;
            self.sort_moved += self.stats.map(|s| s.vmax).unwrap_or(0.0) * self.last_dt / self.l.h;
            if !self.sorted_ever || self.sort_tick >= 64 || (self.sort_tick >= 4 && self.sort_moved >= 2.0) {
                self.sort_tick = 0; self.sort_moved = 0.0; self.sorted_ever = true;
                dispatch(ps, "sortClear", 65536); dispatch(ps, "sortHist", n);
                ps.set_pipeline(&gpu.pipes["sortScan"].pipeline); ps.set_bind_group(0, &g["sortScan"], &[]); ps.dispatch_workgroups(1, 1, 1);
                dispatch(ps, "sortScatter", n); dispatch(ps, "sortCopy", n);
            }
        }
        // blocks
        dispatch(ps, "tileNeedClear", self.ntiles); dispatch(ps, "tileMark", n);
        dispatch(ps, "tileReset", 1);
        dispatch(ps, "tileFree", self.ntiles); dispatch(ps, "argsNew", 1); indirect(ps, "tileAlloc", 32); dispatch(ps, "tileFix", 1);
        indirect(ps, "initNew", 48); dispatch(ps, "slotListBuild", self.ntiles); dispatch(ps, "argsSlots", 1);
        if self.only_tiles { return; }
        indirect(ps, "clearSlots", 80);
        dispatch(ps, if self.opt.p2g_win && !apic { "p2gWin" } else { "p2g" }, n);
        if self.solid_dirty { indirect(ps, "solidBuild", 64); self.solid_dirty = false; }
        indirect(ps, "classify", 64);
        indirect(ps, "normFaces", 64);
        indirect(ps, "divergence", 64);
        indirect(ps, "settleMark", 64);
        dispatch(ps, "listClear", 1);
        indirect(ps, if gpu.sg && gpu.pipes.contains_key("buildListSG") { "buildListSG" } else { "buildList" }, 64);
        dispatch(ps, "listArgs", 1);
        // pressure: red-black sweeps, or multigrid V-cycles (about one per 10 iterations asked for) between sweeps
        let sweep = |ps: &mut wgpu::ComputePass, k: u32| { for _ in 0..k { indirect(ps, "rbRed", 0); indirect(ps, "rbBlack", 16); } };
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
        indirect(ps, "project", 64);
        if self.opt.extrap { indirect(ps, "extrap", 64); }
        dispatch(ps, if apic { if gpu.pipes.contains_key("g2pAo") { "g2pAo" } else { "g2pA" } } else if self.opt.p2g_win { "g2pWin" } else { "g2p" }, n);
        if self.opt.ballistic { dispatch(ps, "ballistic", n); }
        if self.opt.sep > 0.0 {
            indirect(ps, "sepClear", 64);
            for _ in 0..self.opt.sep_iters { indirect(ps, "sepRed", 0); indirect(ps, "sepBlack", 16); }
            dispatch(ps, "sepMove", n);
        }
    }

    /// Runs only the block allocation until the starting water fits the pool (prime).
    pub fn prime(&mut self, gpu: &Gpu, g: f32) {
        let par = StepPar { g, iters: 1, flip: 0.95, apic_flip: 0.8, comp: 0.0, vmax: 14.0, vs: 1.0, tear: 0.0, time: 0.0 };
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
        self.flush_run(gpu);
        let n = self.n;
        let bytes = sizes(n) * 16;
        if self.stage.as_ref().map(|s| s.size() < bytes).unwrap_or(true) {
            self.stage = Some(gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some("readback"), size: (self.max_n as u64).max(1) * 16,
                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false }));
        }
        self.make_groups(gpu);
        let mut enc = gpu.device.create_command_encoder(&Default::default());
        if self.sorted_ever {
            self.pu[0] = n;
            gpu.queue.write_buffer(&self.buf[&0], 0, bytemuck::cast_slice(&self.pu[..1]));
            {
                let mut ps = enc.begin_compute_pass(&Default::default());
                let g = n.div_ceil(256);
                ps.set_pipeline(&gpu.pipes["unsort"].pipeline); ps.set_bind_group(0, &self.groups["unsort"], &[]);
                ps.dispatch_workgroups(g.min(65535), g.div_ceil(65535), 1);
            }
            enc.copy_buffer_to_buffer(&self.buf[&23], 0, self.stage.as_ref().unwrap(), 0, bytes);
        } else {
            enc.copy_buffer_to_buffer(&self.buf[&1], 0, self.stage.as_ref().unwrap(), 0, bytes);
        }
        gpu.queue.submit([enc.finish()]);
        let st = self.stage.as_ref().unwrap();
        st.slice(..bytes).map_async(wgpu::MapMode::Read, |_| {});
        let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
        dst.clear();
        dst.extend_from_slice(bytemuck::cast_slice(&st.slice(..bytes).get_mapped_range().unwrap()[..n as usize * 16]));
        st.unmap();
        self.collect_stats(gpu);
        n
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
                    nns += 1.0;
                    if q == 1 { sum += pr[idx(i + a, j + b, k + cc) as usize] as f64; }
                }
                let r = rh[c] as f64 - (nns * pr[c] as f64 - sum);
                r2 += r * r; b2 += (rh[c] as f64).powi(2);
            }
        }
        (r2 / b2.max(1e-30)).sqrt() as f32
    }
}

/// A small fast random number generator (splitmix64) for jitter and emitters; the page uses Math.random, so runs differ anyway.
pub struct Rng(u64);
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
