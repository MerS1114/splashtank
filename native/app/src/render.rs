//! Draws a bake frame (water, deep water, whitewater points), the tank box, the ocean level and the scene's objects into a
//! colour and depth target. Used by the window and by the headless picture mode (--picture), so both draw the same.

use eframe::wgpu;
use eframe::wgpu::util::DeviceExt;
use glam::{Mat3, Mat4, Vec3};
use splash_format::cache::{Points, FLAG_DEEP};
use splash_format::{Box3, Cache, Scene};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

pub const COLOR: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
pub const DEPTH: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;
/// 4x multisampling, as the page's renderer (antialias: true): smooth lines and object edges
const SAMPLES: u32 = 4;

/// What is open: a cache (with the scene it was baked from, when its header carries one), or just a scene file.
#[derive(Default)]
pub struct Doc {
    pub cache: Option<Arc<Cache>>,
    pub scene: Option<Scene>,
    /// changes whenever a new cache is opened, so frames kept on the GPU from an older one are dropped
    pub gen: u64,
}

impl Doc {
    /// The tank: the cache's box placed at its origin, else the scene's.
    pub fn tank(&self) -> Option<Box3> {
        if let Some(c) = &self.cache {
            let (b, o) = (c.info.b, c.info.org);
            return Some(Box3 { x0: b.x0 + o[0], x1: b.x1 + o[0], y0: b.y0 + o[1], y1: b.y1 + o[1], z0: b.z0 + o[2], z1: b.z1 + o[2] });
        }
        self.scene.as_ref().map(|s| Box3 { x0: s.min[0], y0: s.min[1], z0: s.min[2], x1: s.min[0] + s.size[0], y1: s.min[1] + s.size[1], z1: s.min[2] + s.size[2] })
    }
}

/// Orbit camera as the page's (cam in 02-viewport.js): around a target, angles theta (around y) and phi (from straight up), distance r.
/// Orthographic views (the numpad and axis-widget views) see the same width at the target as the perspective view does.
#[derive(Clone, Copy)]
pub struct Orbit { pub target: Vec3, pub theta: f32, pub phi: f32, pub r: f32, pub ortho: bool }

/// The perspective view's vertical field (the page's 40 degrees).
const HALF_FOV: f32 = 20.0 * std::f32::consts::PI / 180.0;

impl Orbit {
    /// The page's framing of a tank (frameAll) from its starting angles.
    pub fn frame(b: &Box3) -> Orbit {
        let mut o = Orbit { target: Vec3::ZERO, theta: 0.8, phi: 1.0, r: 6.2, ortho: false };
        o.frame_keep_angles(b);
        o
    }
    /// frameAll: the target over the middle of the floor, the distance from the tank's size; the angles stay.
    pub fn frame_keep_angles(&mut self, b: &Box3) {
        let (w, h, d) = (b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0);
        self.target = Vec3::new((b.x0 + b.x1) / 2.0, b.y0 + if h > 3.5 { h * 0.46 } else { h * 0.27 }, (b.z0 + b.z1) / 2.0);
        self.r = (2.1 * w.max(d).max(h * 1.1)).clamp(3.0, 40.0);
    }
    fn dir(&self) -> Vec3 { Vec3::new(self.phi.sin() * self.theta.sin(), self.phi.cos(), self.phi.sin() * self.theta.cos()) }
    /// orthographic views are seen from far away, so nothing is cut off
    pub fn eye(&self) -> Vec3 { self.target + self.dir() * if self.ortho { 150.0 } else { self.r } }
    pub fn view(&self) -> Mat4 {
        // right-handed look-at, camera looking down -z
        let (eye, f) = (self.eye(), -self.dir());
        let s = f.cross(Vec3::Y).normalize_or(Vec3::X);
        let u = s.cross(f);
        Mat4::from_cols(glam::Vec4::new(s.x, u.x, -f.x, 0.0), glam::Vec4::new(s.y, u.y, -f.y, 0.0), glam::Vec4::new(s.z, u.z, -f.z, 0.0),
                        glam::Vec4::new(-s.dot(eye), -u.dot(eye), f.dot(eye), 1.0))
    }
    /// half the height seen at the target (orthographic)
    pub fn half_h(&self) -> f32 { self.r * HALF_FOV.tan() }
    /// projection with depth 0 to 1 (wgpu)
    pub fn proj(&self, aspect: f32) -> Mat4 {
        let a = aspect.max(0.01);
        if self.ortho {
            let (hh, n, fa) = (self.half_h(), 0.1, 400.0);
            return Mat4::from_cols(glam::Vec4::new(1.0 / (hh * a), 0.0, 0.0, 0.0), glam::Vec4::new(0.0, 1.0 / hh, 0.0, 0.0),
                                   glam::Vec4::new(0.0, 0.0, 1.0 / (n - fa), 0.0), glam::Vec4::new(0.0, 0.0, n / (n - fa), 1.0));
        }
        let (n, fa) = ((self.r * 0.005).max(0.005), self.r * 20.0 + 100.0);
        let h = 1.0 / HALF_FOV.tan();
        Mat4::from_cols(glam::Vec4::new(h / a, 0.0, 0.0, 0.0), glam::Vec4::new(0.0, h, 0.0, 0.0),
                        glam::Vec4::new(0.0, 0.0, fa / (n - fa), -1.0), glam::Vec4::new(0.0, 0.0, n * fa / (n - fa), 0.0))
    }
    /// dragging orbits (and leaves an orthographic view, as the page does)
    pub fn orbit(&mut self, dx: f32, dy: f32) {
        self.ortho = false;
        self.theta -= dx * 0.007;
        self.phi = (self.phi - dy * 0.007).clamp(0.02, std::f32::consts::PI - 0.02);
    }
    pub fn pan(&mut self, dx: f32, dy: f32) {
        let v = self.view();
        let right = Vec3::new(v.x_axis.x, v.y_axis.x, v.z_axis.x);
        let up = Vec3::new(v.x_axis.y, v.y_axis.y, v.z_axis.y);
        self.target += (-dx * right + dy * up) * self.r * 0.0012;
    }
    /// the wheel's pixels (or a drag's), as the page: r times e^(delta / 1000)
    pub fn zoom(&mut self, delta: f32) { self.r = (self.r * (delta * 0.001).exp()).clamp(1.2, 40.0); }
}

/// Display settings (the page's Display panel).
#[derive(Clone, Copy)]
pub struct Look {
    /// point size as a share of the particle spacing (Point size, S.psize)
    pub size: f32,
    /// water at this speed (m/s) is drawn white (White at, S.vmax)
    pub vmax: f32,
    /// how strongly churned water is drawn white (White water, S.foam)
    pub foam: f32,
    /// look-only extras a water point (Water detail, S.detail) and a whitewater point (Whitewater detail, S.sprDetail)
    pub detail: u32,
    pub spr_detail: u32,
    /// how far spray's copies trail behind it, seconds (S.streak)
    pub streak: f32,
    pub skip_buried: bool,
    /// blend the water between frames while playing
    pub blend: bool,
    pub water: bool,
    pub deep: bool,
    pub whitewater: bool,
    pub objects: bool,
    /// the Detail region (centre and size as shares of the tank), shown dashed while the Bake panel's Detail is open
    pub region: Option<([f32; 3], [f32; 3])>,
    /// the object selected in the Objects tab (drawn orange, as Blender does)
    pub selected: Option<u64>,
}
impl Default for Look {
    fn default() -> Look { Look { size: 0.85, vmax: 5.0, foam: 0.8, detail: 0, spr_detail: 4, streak: 0.02, skip_buried: true, blend: true, water: true, deep: true, whitewater: true, objects: true, region: None, selected: None } }
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct CamU { view: [[f32; 4]; 4], proj: [[f32; 4]; 4], org: [f32; 4], vp: [f32; 4], a: [f32; 4], b: [f32; 4], c: [f32; 4], d: [f32; 4] }

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct LayerU { b0: [f32; 4], e: [f32; 4], q: [u32; 4], n: [u32; 4] }

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Vert { p: [f32; 3], n: [f32; 3], c: [f32; 4] }

struct GpuLayer { n: u32, bg: wgpu::BindGroup }
struct GpuFrame { water: Option<GpuLayer>, deep: Option<GpuLayer>, ww: Option<GpuLayer>, bytes: u64 }

/// One camera block per draw (water, deep water, whitewater, the rest): they differ in how many copies a point gets.
struct CamSlot { buf: wgpu::Buffer, bg: wgpu::BindGroup }

pub struct Renderer {
    bg: wgpu::RenderPipeline,
    water: wgpu::RenderPipeline,
    deep: wgpu::RenderPipeline,
    ww: wgpu::RenderPipeline,
    tris: wgpu::RenderPipeline,
    lines: wgpu::RenderPipeline,
    cams: Vec<CamSlot>,
    /// the multisampled colour and depth the view is drawn into, resolved into the caller's target
    msaa: Option<([u32; 2], wgpu::TextureView, wgpu::TextureView)>,
    layer_bgl: wgpu::BindGroupLayout,
    empty: wgpu::BindGroup,
    dummy: wgpu::Buffer,
    frames: HashMap<usize, GpuFrame>,
    lru: VecDeque<usize>,
    gen: u64,
    /// bytes of frames kept on the GPU, and the most to keep (older frames are dropped beyond it)
    pub kept_bytes: u64,
    pub budget: u64,
    pub uploads: u64,
}

impl Renderer {
    pub fn new(device: &wgpu::Device) -> Renderer {
        let cam_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("cam"),
            entries: &[wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None }],
        });
        let storage = |b: u32| wgpu::BindGroupLayoutEntry { binding: b, visibility: wgpu::ShaderStages::VERTEX,
            ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: true }, has_dynamic_offset: false, min_binding_size: None }, count: None };
        let layer_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("layer"),
            entries: &[wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None },
                storage(1), storage(2), storage(3)],
        });
        let cams = (0..4).map(|_| {
            let buf = device.create_buffer(&wgpu::BufferDescriptor { label: Some("cam"), size: std::mem::size_of::<CamU>() as u64,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
            let bg = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("cam"), layout: &cam_bgl,
                entries: &[wgpu::BindGroupEntry { binding: 0, resource: buf.as_entire_binding() }] });
            CamSlot { buf, bg }
        }).collect();
        let dummy = device.create_buffer(&wgpu::BufferDescriptor { label: Some("dummy"), size: 64, usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::UNIFORM, mapped_at_creation: false });
        // a layer with no points, bound where a draw has no second frame
        let empty = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("empty layer"), layout: &layer_bgl, entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: dummy.as_entire_binding() }, wgpu::BindGroupEntry { binding: 1, resource: dummy.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: dummy.as_entire_binding() }, wgpu::BindGroupEntry { binding: 3, resource: dummy.as_entire_binding() }] });

        let depth = |write: bool, cmp| Some(wgpu::DepthStencilState { format: DEPTH, depth_write_enabled: Some(write), depth_compare: Some(cmp),
            stencil: Default::default(), bias: Default::default() });
        let opaque = [Some(wgpu::ColorTargetState { format: COLOR, blend: None, write_mask: wgpu::ColorWrites::ALL })];
        let blended = [Some(wgpu::ColorTargetState { format: COLOR, blend: Some(wgpu::BlendState::ALPHA_BLENDING), write_mask: wgpu::ColorWrites::ALL })];
        let less = wgpu::CompareFunction::Less;

        let pm = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("points"), source: wgpu::ShaderSource::Wgsl(include_str!("points.wgsl").into()) });
        let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("points"), bind_group_layouts: &[Some(&cam_bgl), Some(&layer_bgl), Some(&layer_bgl)], immediate_size: 0 });
        let pipe = |label: &str, vs: &str, fs: &str, target: &[Option<wgpu::ColorTargetState>], ds: Option<wgpu::DepthStencilState>| device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(label), layout: Some(&pl),
            vertex: wgpu::VertexState { module: &pm, entry_point: Some(vs), compilation_options: Default::default(), buffers: &[] },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: ds,
            multisample: wgpu::MultisampleState { count: SAMPLES, ..Default::default() },
            fragment: Some(wgpu::FragmentState { module: &pm, entry_point: Some(fs), compilation_options: Default::default(), targets: target }),
            multiview_mask: None, cache: None,
        });
        let bg = pipe("background", "vs_bg", "fs_bg", &opaque, depth(false, wgpu::CompareFunction::Always));
        let water = pipe("water", "vs_water", "fs_water", &opaque, depth(true, less));
        let deep = pipe("deep", "vs_deep", "fs_water", &opaque, depth(true, less));
        // whitewater is see-through: it is tested against the water but does not hide what is behind it
        let ww = pipe("whitewater", "vs_ww", "fs_ww", &blended, depth(false, less));

        let lm = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("lines"), source: wgpu::ShaderSource::Wgsl(include_str!("lines.wgsl").into()) });
        let ll = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("lines"), bind_group_layouts: &[Some(&cam_bgl)], immediate_size: 0 });
        let attrs = wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x4];
        let vb = [Some(wgpu::VertexBufferLayout { array_stride: std::mem::size_of::<Vert>() as u64, step_mode: wgpu::VertexStepMode::Vertex, attributes: &attrs })];
        let geo = |topology, target: &[Option<wgpu::ColorTargetState>], ds| device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("geometry"), layout: Some(&ll),
            vertex: wgpu::VertexState { module: &lm, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &vb },
            primitive: wgpu::PrimitiveState { topology, ..Default::default() },
            depth_stencil: ds,
            multisample: wgpu::MultisampleState { count: SAMPLES, ..Default::default() },
            fragment: Some(wgpu::FragmentState { module: &lm, entry_point: Some("fs"), compilation_options: Default::default(), targets: target }),
            multiview_mask: None, cache: None,
        });
        let tris = geo(wgpu::PrimitiveTopology::TriangleList, &opaque, depth(true, less));
        let lines = geo(wgpu::PrimitiveTopology::LineList, &blended, depth(false, less));
        Renderer { bg, water, deep, ww, tris, lines, cams, msaa: None, layer_bgl, empty, dummy, frames: HashMap::new(), lru: VecDeque::new(), gen: u64::MAX,
            kept_bytes: 0, budget: 2 << 30, uploads: 0 }
    }

    pub fn is_kept(&self, f: usize) -> bool { self.frames.contains_key(&f) }
    pub fn kept_frames(&self) -> usize { self.frames.len() }

    fn layer(&self, device: &wgpu::Device, c: &Cache, p: &Points, q: Option<[u8; 3]>, bx: Box3, ww_codes: Option<&std::ops::Range<usize>>) -> (GpuLayer, u64) {
        let buf = |label: &str, r: &std::ops::Range<usize>| device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some(label), contents: c.slice(r), usage: wgpu::BufferUsages::STORAGE });
        let pos = buf("pos", &p.pos);
        let spd = buf("spd", ww_codes.unwrap_or(&p.spd));
        let lvl = p.fm.as_ref().map(|r| buf("lvl", r));
        let e = bx.size();
        let qq = q.unwrap_or([16, 16, 16]);
        let u = LayerU { b0: [bx.x0, bx.y0, bx.z0, 0.0], e: [e[0], e[1], e[2], 0.0],
            q: [qq[0] as u32, qq[1] as u32, qq[2] as u32, q.is_some() as u32], n: [p.n, lvl.is_some() as u32, 0, 0] };
        let ub = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("layer"), contents: bytemuck::bytes_of(&u), usage: wgpu::BufferUsages::UNIFORM });
        let bg = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("layer"), layout: &self.layer_bgl, entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: ub.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: pos.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: spd.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 3, resource: lvl.as_ref().unwrap_or(&self.dummy).as_entire_binding() },
        ] });
        let bytes = pos.size() + spd.size() + lvl.as_ref().map(|b| b.size()).unwrap_or(0);
        (GpuLayer { n: p.n, bg }, bytes)
    }

    /// Puts frame f on the GPU unless it is there already; drops the least recently used frames beyond the budget.
    pub fn load(&mut self, device: &wgpu::Device, doc: &Doc, f: usize) {
        let Some(c) = &doc.cache else { return; };
        if self.gen != doc.gen { self.frames.clear(); self.lru.clear(); self.kept_bytes = 0; self.gen = doc.gen; }
        if f >= c.frames.len() { return; }
        if self.frames.contains_key(&f) {
            if let Some(k) = self.lru.iter().position(|&x| x == f) { self.lru.remove(k); }
            self.lru.push_back(f);
            return;
        }
        let fr = &c.frames[f];
        let mut bytes = 0;
        let water = (fr.water.n > 0).then(|| { let (l, b) = self.layer(device, c, &fr.water, fr.q, c.frame_box(f), None); bytes += b; l });
        let deep = fr.deep.as_ref().filter(|p| p.n > 0 && fr.flags & FLAG_DEEP != 0).map(|p| {
            let (l, b) = self.layer(device, c, p, fr.q, c.frame_box(f), None); bytes += b; l });
        let ww = fr.ww.as_ref().filter(|w| w.n > 0).map(|w| {
            let p = Points { n: w.n, pos: w.pos.clone(), spd: w.pk.clone(), fm: None };
            let (l, b) = self.layer(device, c, &p, fr.q, c.ww_box(), Some(&w.pk)); bytes += b; l });
        self.uploads += 1;
        self.frames.insert(f, GpuFrame { water, deep, ww, bytes });
        self.lru.push_back(f);
        self.kept_bytes += bytes;
        while self.kept_bytes > self.budget && self.lru.len() > 2 {
            let old = self.lru.pop_front().unwrap();
            if let Some(g) = self.frames.remove(&old) { self.kept_bytes -= g.bytes; }
        }
    }

    /// Draws the cache at frame t (frame a blended towards frame b by w, as the page's showSlots) and the geometry into the targets.
    #[allow(clippy::too_many_arguments)]
    pub fn draw(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, encoder: &mut wgpu::CommandEncoder, color: &wgpu::TextureView,
                size: [u32; 2], cam: &Orbit, doc: &Doc, a: usize, b: usize, w: f32, look: &Look) {
        let (wd, ht) = (size[0] as f32, size[1].max(1) as f32);
        let w = if look.blend && a != b { w.clamp(0.0, 1.0) } else { 0.0 };
        if doc.cache.is_some() { self.load(device, doc, a); if w > 0.0 { self.load(device, doc, b); } }
        let c = doc.cache.as_ref();
        let org = c.map(|c| c.info.org).unwrap_or([0.0; 3]);
        let d = c.map(|c| c.info.d).unwrap_or(0.04);
        let cell = c.and_then(|c| c.info.meta.pointer("/desc/cellRatio").and_then(|v| v.as_f64())).unwrap_or(2.0) as f32;
        let (spd_ms, scale, fps) = c.map(|c| (c.info.spd_ms, c.info.scale, c.info.fps)).unwrap_or((true, 1.0, 24.0));
        // speed bytes are 16ths of m/s (spdMs caches) or of a scene unit a second; the white speed in the same units
        let vs = if spd_ms { scale } else { 1.0 };
        let umax = look.vmax * vs / scale;
        let ortho = if cam.ortho { ht / (2.0 * cam.half_h()) } else { 0.0 };
        let base = CamU { view: cam.view().to_cols_array_2d(), proj: cam.proj(wd / ht).to_cols_array_2d(), org: [org[0], org[1], org[2], 0.0],
            vp: [wd, ht, ht / (2.0 * HALF_FOV.tan()), ortho], a: [look.size * d, d, cell, umax], b: [look.foam, vs, 1.0 / fps, w],
            c: [look.detail as f32, look.spr_detail.min(15) as f32, look.streak, look.skip_buried as u32 as f32], d: [2.0, 1.0, 0.0, 0.0] };
        // copies a point: water 1 + its detail, deep water 5, whitewater 1 + its detail (at most 16 in all)
        let k = [1 + look.detail.min(15), 5, 1 + look.spr_detail.min(15), 1];
        for (i, s) in self.cams.iter().enumerate() { let mut u = base; u.d[1] = k[i] as f32; queue.write_buffer(&s.buf, 0, bytemuck::bytes_of(&u)); }

        let (tris, lines) = geometry(doc, a, b, w, look);
        let tb = (!tris.is_empty()).then(|| device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("tris"), contents: bytemuck::cast_slice(&tris), usage: wgpu::BufferUsages::VERTEX }));
        let lb = (!lines.is_empty()).then(|| device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("lines"), contents: bytemuck::cast_slice(&lines), usage: wgpu::BufferUsages::VERTEX }));

        if self.msaa.as_ref().map(|m| m.0 != size).unwrap_or(true) {
            let ext = wgpu::Extent3d { width: size[0], height: size[1], depth_or_array_layers: 1 };
            let tex = |format| device.create_texture(&wgpu::TextureDescriptor { label: Some("msaa"), size: ext, mip_level_count: 1, sample_count: SAMPLES,
                dimension: wgpu::TextureDimension::D2, format, usage: wgpu::TextureUsages::RENDER_ATTACHMENT, view_formats: &[] }).create_view(&Default::default());
            self.msaa = Some((size, tex(COLOR), tex(DEPTH)));
        }
        let (_, mc, md) = self.msaa.as_ref().unwrap();
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("view"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: mc, depth_slice: None, resolve_target: Some(color),
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Discard } })],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: md,
                depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Discard }), stencil_ops: None }),
            timestamp_writes: None, occlusion_query_set: None, multiview_mask: None,
        });
        pass.set_bind_group(0, &self.cams[3].bg, &[]);
        pass.set_bind_group(1, &self.empty, &[]);
        pass.set_bind_group(2, &self.empty, &[]);
        pass.set_pipeline(&self.bg);
        pass.draw(0..3, 0..1);
        if let Some(bf) = &tb { pass.set_pipeline(&self.tris); pass.set_vertex_buffer(0, bf.slice(..)); pass.draw(0..tris.len() as u32, 0..1); }
        let (fa, fb) = (self.frames.get(&a).filter(|_| c.is_some()), self.frames.get(&b).filter(|_| c.is_some() && w > 0.0));
        // deep water and whitewater from the nearer frame
        let near = if w >= 0.5 { fb } else { fa };
        if look.water {
            let (la, lb) = (fa.and_then(|g| g.water.as_ref()), fb.and_then(|g| g.water.as_ref()));
            let n = la.map_or(0, |l| l.n).max(lb.map_or(0, |l| l.n));
            if n > 0 {
                pass.set_pipeline(&self.water);
                pass.set_bind_group(0, &self.cams[0].bg, &[]);
                pass.set_bind_group(1, la.map_or(&self.empty, |l| &l.bg), &[]);
                pass.set_bind_group(2, lb.map_or(&self.empty, |l| &l.bg), &[]);
                pass.draw(0..n * k[0] * 6, 0..1);
            }
        }
        if let (Some(l), true) = (near.and_then(|g| g.deep.as_ref()), look.deep) {
            pass.set_pipeline(&self.deep);
            pass.set_bind_group(0, &self.cams[1].bg, &[]);
            pass.set_bind_group(1, &l.bg, &[]);
            pass.set_bind_group(2, &self.empty, &[]);
            pass.draw(0..l.n * k[1] * 6, 0..1);
        }
        pass.set_bind_group(0, &self.cams[3].bg, &[]);
        if let Some(bf) = &lb { pass.set_pipeline(&self.lines); pass.set_vertex_buffer(0, bf.slice(..)); pass.draw(0..lines.len() as u32, 0..1); }
        if let (Some(l), true) = (near.and_then(|g| g.ww.as_ref()), look.whitewater) {
            pass.set_pipeline(&self.ww);
            pass.set_bind_group(0, &self.cams[2].bg, &[]);
            pass.set_bind_group(1, &l.bg, &[]);
            pass.set_bind_group(2, &self.empty, &[]);
            pass.draw(0..l.n * k[2] * 6, 0..1);
        }
    }
}

/// R = Rz Ry Rx, as eulerMat in shared.js (the page poses meshes with three.js order 'ZYX', the same matrix).
fn euler(rx: f32, ry: f32, rz: f32) -> Mat3 {
    let (sx, cx) = rx.sin_cos();
    let (sy, cy) = ry.sin_cos();
    let (sz, cz) = rz.sin_cos();
    // eulerMat is row major; glam takes columns
    Mat3::from_cols(Vec3::new(cz * cy, sz * cy, -sy),
                    Vec3::new(cz * sy * sx - sz * cx, sz * sy * sx + cz * cx, cy * sx),
                    Vec3::new(cz * sy * cx + sz * sx, sz * sy * cx - cz * sx, cy * cx))
}

/// Triangles (colliders) and lines (tank box, floor grid, whitewater area, ocean level, water volumes as wireframes) in scene
/// coordinates, with the page's colours. Objects are posed from frame a blended towards frame b by w, as the page poses them.
fn geometry(doc: &Doc, a: usize, b: usize, w: f32, look: &Look) -> (Vec<Vert>, Vec<Vert>) {
    let (mut tris, mut lines) = (Vec::new(), Vec::new());
    let line = |out: &mut Vec<Vert>, a: Vec3, b: Vec3, c: [f32; 4]| {
        out.push(Vert { p: a.into(), n: [0.0; 3], c });
        out.push(Vert { p: b.into(), n: [0.0; 3], c });
    };
    // a box's twelve edges, solid or dashed (dash: the length of a dash)
    let edges = |out: &mut Vec<Vert>, b: &Box3, c: [f32; 4], dash: f32| {
        let p = |i: u32| Vec3::new(if i & 1 != 0 { b.x1 } else { b.x0 }, if i & 2 != 0 { b.y1 } else { b.y0 }, if i & 4 != 0 { b.z1 } else { b.z0 });
        for i in 0..8u32 { for k in [1u32, 2, 4] { if i & k == 0 {
            let (s, e) = (p(i), p(i | k));
            if dash <= 0.0 { line(out, s, e, c); continue; }
            let len = (e - s).length();
            let mut t = 0.0;
            while t < len { line(out, s + (e - s) * (t / len), s + (e - s) * ((t + dash).min(len) / len), c); t += dash * 1.8; }
        } } }
    };
    if let Some(b) = doc.tank() {
        // the page's tank: grey 0x8a949e at half strength, and a floor grid about 0.2 units apart at a fifth
        let grey = [0x8a as f32 / 255.0, 0x94 as f32 / 255.0, 0x9e as f32 / 255.0];
        edges(&mut lines, &b, [grey[0], grey[1], grey[2], 0.5], 0.0);
        let (wd, dd) = (b.x1 - b.x0, b.z1 - b.z0);
        let (nx, nz) = (((wd / 0.2).round() as u32).max(2), ((dd / 0.2).round() as u32).max(2));
        let (gc, gy) = ([grey[0], grey[1], grey[2], 0.2], b.y0 + 0.002);
        for i in 0..=nx { let x = b.x0 + wd / nx as f32 * i as f32; line(&mut lines, Vec3::new(x, gy, b.z0), Vec3::new(x, gy, b.z1), gc); }
        for i in 0..=nz { let z = b.z0 + dd / nz as f32 * i as f32; line(&mut lines, Vec3::new(b.x0, gy, z), Vec3::new(b.x1, gy, z), gc); }
        // the whitewater area (dashed) when it is bigger than the tank: spray and mist fly on past the walls up to there
        if let Some(c) = &doc.cache {
            let (s, o) = (c.ww_box(), c.info.org);
            let ar = Box3 { x0: s.x0 + o[0], x1: s.x1 + o[0], y0: s.y0 + o[1], y1: s.y1 + o[1], z0: s.z0 + o[2], z1: s.z1 + o[2] };
            if ar.x1 - ar.x0 > wd * 1.01 || ar.y1 - ar.y0 > (b.y1 - b.y0) * 1.01 {
                edges(&mut lines, &ar, [0xb8 as f32 / 255.0, 0xc4 as f32 / 255.0, 0xd0 as f32 / 255.0, 0.45], (ar.x1 - ar.x0).max(ar.z1 - ar.z0) * 0.015);
            }
        }
        if let Some((c, s)) = look.region {
            // the Detail region, dashed blue as the page's detBox
            let sh = |k: usize| ((c[k] - s[k] / 2.0).clamp(0.0, 1.0), (c[k] + s[k] / 2.0).clamp(0.0, 1.0));
            let ((x0, x1), (y0, y1), (z0, z1)) = (sh(0), sh(1), sh(2));
            let l = |a: f32, z: f32, t: f32| a + (z - a) * t;
            let r = Box3 { x0: l(b.x0, b.x1, x0), x1: l(b.x0, b.x1, x1), y0: l(b.y0, b.y1, y0), y1: l(b.y0, b.y1, y1), z0: l(b.z0, b.z1, z0), z1: l(b.z0, b.z1, z1) };
            edges(&mut lines, &r, [0.36, 0.62, 1.0, 0.9], (r.x1 - r.x0).max(r.z1 - r.z0) * 0.03);
        }
        if let Some(lv) = doc.scene.as_ref().and_then(|s| s.ocean_level).filter(|_| doc.cache.is_none()) {
            // the ocean's still level as a grid
            let y = b.y0 + lv;
            let c = [0.2, 0.55, 0.95, 1.0];
            for k in 0..=10 {
                let t = k as f32 / 10.0;
                let x = b.x0 + (b.x1 - b.x0) * t;
                let z = b.z0 + (b.z1 - b.z0) * t;
                line(&mut lines, Vec3::new(x, y, b.z0), Vec3::new(x, y, b.z1), c);
                line(&mut lines, Vec3::new(b.x0, y, z), Vec3::new(b.x1, y, z), c);
            }
        }
    }
    let Some(scene) = &doc.scene else { return (tris, lines); };
    if !look.objects { return (tris, lines); }
    let cache = doc.cache.as_ref().filter(|c| a < c.frames.len() && b < c.frames.len());
    let poses = cache.map(|c| { let (pa, pb) = (c.poses(a), c.poses(b)); pa.iter().zip(&pb).map(|(x, y)| x + (y - x) * w).collect::<Vec<f32>>() });
    for o in &scene.objs {
        let Some(m) = &o.mesh else { continue; };
        // in a cache, an object's pose comes from the frame (relative to the origin); otherwise from the scene
        let (pos, rot) = match (cache, &poses) {
            (Some(c), Some(p)) => match c.info.ids.iter().position(|&id| id == o.id) {
                Some(k) if p.len() >= k * 6 + 6 => (Vec3::new(p[k * 6] + c.info.org[0], p[k * 6 + 1] + c.info.org[1], p[k * 6 + 2] + c.info.org[2]),
                                                     [p[k * 6 + 3], p[k * 6 + 4], p[k * 6 + 5]]),
                _ => (Vec3::from(o.pos), o.rot),
            },
            _ => (Vec3::from(o.pos), o.rot),
        };
        let r = euler(rot[0], rot[1], rot[2]);
        let s = Vec3::from(o.scale);
        let w: Vec<Vec3> = m.v.iter().map(|v| pos + r * (Vec3::from(*v) * s)).collect();
        let sel = look.selected == Some(o.id);
        if o.water {
            let c = if sel { [1.0, 0.63, 0.16, 1.0] } else { [0.25, 0.6, 1.0, 1.0] };
            for f in &m.f { for k in 0..f.len() { line(&mut lines, w[f[k] as usize], w[f[(k + 1) % f.len()] as usize], c); } }
            continue;
        }
        // the page's object grey, 0x9ba1a7
        let c = if sel { [1.0, 0.63, 0.16, 1.0] } else { [0x9b as f32 / 255.0, 0xa1 as f32 / 255.0, 0xa7 as f32 / 255.0, 1.0] };
        for t in &m.tris() {
            let (a, b, cc) = (w[t[0] as usize], w[t[1] as usize], w[t[2] as usize]);
            let n: [f32; 3] = (b - a).cross(cc - a).normalize_or_zero().into();
            for p in [a, b, cc] { tris.push(Vert { p: p.into(), n, c }); }
        }
    }
    (tris, lines)
}
