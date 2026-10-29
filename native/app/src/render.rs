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
pub const BACKGROUND: [f64; 3] = [0.16, 0.17, 0.19];

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

/// Orbit camera like the page's: around a target, angles theta (around y) and phi (from straight up), distance r.
#[derive(Clone, Copy)]
pub struct Orbit { pub target: Vec3, pub theta: f32, pub phi: f32, pub r: f32 }

impl Orbit {
    /// The page's framing of a tank (frameAll in 04-scenes.js).
    pub fn frame(b: &Box3) -> Orbit {
        let (w, h, d) = (b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0);
        let ty = b.y0 + if h > 3.5 { h * 0.46 } else { h * 0.27 };
        Orbit { target: Vec3::new((b.x0 + b.x1) / 2.0, ty, (b.z0 + b.z1) / 2.0), theta: 0.75, phi: 1.15, r: (2.1 * w.max(d).max(h * 1.1)).clamp(3.0, 60.0) }
    }
    pub fn eye(&self) -> Vec3 {
        self.target + self.r * Vec3::new(self.phi.sin() * self.theta.cos(), self.phi.cos(), self.phi.sin() * self.theta.sin())
    }
    pub fn view(&self) -> Mat4 {
        // right-handed look-at, camera looking down -z
        let (eye, f) = (self.eye(), (self.target - self.eye()).normalize());
        let s = f.cross(Vec3::Y).normalize();
        let u = s.cross(f);
        Mat4::from_cols(glam::Vec4::new(s.x, u.x, -f.x, 0.0), glam::Vec4::new(s.y, u.y, -f.y, 0.0), glam::Vec4::new(s.z, u.z, -f.z, 0.0),
                        glam::Vec4::new(-s.dot(eye), -u.dot(eye), f.dot(eye), 1.0))
    }
    /// perspective with depth 0 to 1 (wgpu), 40 degrees vertical
    pub fn proj(&self, aspect: f32) -> Mat4 {
        let (n, fa) = ((self.r * 0.005).max(0.005), self.r * 20.0 + 100.0);
        let h = 1.0 / (20f32.to_radians()).tan();
        let a = aspect.max(0.01);
        Mat4::from_cols(glam::Vec4::new(h / a, 0.0, 0.0, 0.0), glam::Vec4::new(0.0, h, 0.0, 0.0),
                        glam::Vec4::new(0.0, 0.0, fa / (n - fa), -1.0), glam::Vec4::new(0.0, 0.0, n * fa / (n - fa), 0.0))
    }
    pub fn orbit(&mut self, dx: f32, dy: f32) {
        self.theta += dx * 0.008;
        self.phi = (self.phi - dy * 0.008).clamp(0.02, 3.12);
    }
    pub fn pan(&mut self, dx: f32, dy: f32, height_px: f32) {
        let v = self.view();
        let right = Vec3::new(v.x_axis.x, v.y_axis.x, v.z_axis.x);
        let up = Vec3::new(v.x_axis.y, v.y_axis.y, v.z_axis.y);
        let k = 2.0 * self.r * (20f32.to_radians()).tan() / height_px.max(1.0);
        self.target += (-dx * right + dy * up) * k;
    }
    pub fn zoom(&mut self, steps: f32) { self.r = (self.r * 0.9f32.powf(steps)).clamp(0.05, 500.0); }
}

/// Display settings.
#[derive(Clone, Copy)]
pub struct Look {
    /// point radius as a share of the particle spacing
    pub size: f32,
    /// water at this speed (m/s) is drawn white
    pub vmax: f32,
    pub skip_buried: bool,
    pub water: bool,
    pub deep: bool,
    pub whitewater: bool,
    pub objects: bool,
}
impl Default for Look {
    fn default() -> Look { Look { size: 0.6, vmax: 5.0, skip_buried: true, water: true, deep: true, whitewater: true, objects: true } }
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct CamU { view: [[f32; 4]; 4], proj: [[f32; 4]; 4], org: [f32; 4], look: [f32; 4] }

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct LayerU { b0: [f32; 4], e: [f32; 4], q: [u32; 4], n: [u32; 4] }

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Vert { p: [f32; 3], n: [f32; 3], c: [f32; 4] }

struct GpuLayer { n: u32, bg: wgpu::BindGroup }
struct GpuFrame { water: Option<GpuLayer>, deep: Option<GpuLayer>, ww: Option<GpuLayer>, bytes: u64 }

pub struct Renderer {
    points: wgpu::RenderPipeline,
    tris: wgpu::RenderPipeline,
    lines: wgpu::RenderPipeline,
    cam: wgpu::Buffer,
    cam_bg: wgpu::BindGroup,
    layer_bgl: wgpu::BindGroupLayout,
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
        let cam = device.create_buffer(&wgpu::BufferDescriptor { label: Some("cam"), size: std::mem::size_of::<CamU>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let cam_bg = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("cam"), layout: &cam_bgl,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: cam.as_entire_binding() }] });
        let dummy = device.create_buffer(&wgpu::BufferDescriptor { label: Some("dummy"), size: 16, usage: wgpu::BufferUsages::STORAGE, mapped_at_creation: false });

        let depth = Some(wgpu::DepthStencilState { format: DEPTH, depth_write_enabled: Some(true), depth_compare: Some(wgpu::CompareFunction::Less),
            stencil: Default::default(), bias: Default::default() });
        let target = [Some(wgpu::ColorTargetState { format: COLOR, blend: None, write_mask: wgpu::ColorWrites::ALL })];

        let pm = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("points"), source: wgpu::ShaderSource::Wgsl(include_str!("points.wgsl").into()) });
        let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("points"), bind_group_layouts: &[Some(&cam_bgl), Some(&layer_bgl)], immediate_size: 0 });
        let points = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("points"), layout: Some(&pl),
            vertex: wgpu::VertexState { module: &pm, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: depth.clone(),
            multisample: Default::default(),
            fragment: Some(wgpu::FragmentState { module: &pm, entry_point: Some("fs"), compilation_options: Default::default(), targets: &target }),
            multiview_mask: None, cache: None,
        });

        let lm = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("lines"), source: wgpu::ShaderSource::Wgsl(include_str!("lines.wgsl").into()) });
        let ll = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("lines"), bind_group_layouts: &[Some(&cam_bgl)], immediate_size: 0 });
        let attrs = wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x4];
        let vb = [Some(wgpu::VertexBufferLayout { array_stride: std::mem::size_of::<Vert>() as u64, step_mode: wgpu::VertexStepMode::Vertex, attributes: &attrs })];
        let geo = |topology| device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("geometry"), layout: Some(&ll),
            vertex: wgpu::VertexState { module: &lm, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &vb },
            primitive: wgpu::PrimitiveState { topology, ..Default::default() },
            depth_stencil: depth.clone(),
            multisample: Default::default(),
            fragment: Some(wgpu::FragmentState { module: &lm, entry_point: Some("fs"), compilation_options: Default::default(), targets: &target }),
            multiview_mask: None, cache: None,
        });
        let tris = geo(wgpu::PrimitiveTopology::TriangleList);
        let lines = geo(wgpu::PrimitiveTopology::LineList);
        Renderer { points, tris, lines, cam, cam_bg, layer_bgl, dummy, frames: HashMap::new(), lru: VecDeque::new(), gen: u64::MAX,
            kept_bytes: 0, budget: 2 << 30, uploads: 0 }
    }

    pub fn is_kept(&self, f: usize) -> bool { self.frames.contains_key(&f) }
    pub fn kept_frames(&self) -> usize { self.frames.len() }

    fn layer(&self, device: &wgpu::Device, c: &Cache, p: &Points, q: Option<[u8; 3]>, bx: Box3, kind: u32, radius: f32, ww_codes: Option<&std::ops::Range<usize>>) -> (GpuLayer, u64) {
        let buf = |label: &str, r: &std::ops::Range<usize>| device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some(label), contents: c.slice(r), usage: wgpu::BufferUsages::STORAGE });
        let pos = buf("pos", &p.pos);
        let spd = buf("spd", ww_codes.unwrap_or(&p.spd));
        let lvl = p.fm.as_ref().map(|r| buf("lvl", r));
        let e = bx.size();
        let qq = q.unwrap_or([16, 16, 16]);
        let u = LayerU { b0: [bx.x0, bx.y0, bx.z0, kind as f32], e: [e[0], e[1], e[2], radius],
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
        let d = c.info.d;
        let cell = c.info.meta.pointer("/desc/cellRatio").and_then(|v| v.as_f64()).unwrap_or(2.0) as f32;
        let mut bytes = 0;
        let water = (fr.water.n > 0).then(|| { let (l, b) = self.layer(device, c, &fr.water, fr.q, c.frame_box(f), 0, d, None); bytes += b; l });
        let deep = fr.deep.as_ref().filter(|p| p.n > 0 && fr.flags & FLAG_DEEP != 0).map(|p| {
            let (l, b) = self.layer(device, c, p, fr.q, c.frame_box(f), 1, d * cell * 0.6, None); bytes += b; l });
        let ww = fr.ww.as_ref().filter(|w| w.n > 0).map(|w| {
            let p = Points { n: w.n, pos: w.pos.clone(), spd: w.pk.clone(), fm: None };
            let (l, b) = self.layer(device, c, &p, fr.q, c.ww_box(), 2, d * 0.5, Some(&w.pk)); bytes += b; l });
        self.uploads += 1;
        self.frames.insert(f, GpuFrame { water, deep, ww, bytes });
        self.lru.push_back(f);
        self.kept_bytes += bytes;
        while self.kept_bytes > self.budget && self.lru.len() > 1 {
            let old = self.lru.pop_front().unwrap();
            if let Some(g) = self.frames.remove(&old) { self.kept_bytes -= g.bytes; }
        }
    }

    /// Draws frame f (when a cache is open) and the geometry into the targets.
    #[allow(clippy::too_many_arguments)]
    pub fn draw(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, encoder: &mut wgpu::CommandEncoder, color: &wgpu::TextureView,
                depth: &wgpu::TextureView, size: [u32; 2], cam: &Orbit, doc: &Doc, f: usize, look: &Look) {
        let org = doc.cache.as_ref().map(|c| c.info.org).unwrap_or([0.0; 3]);
        let spd_k = doc.cache.as_ref().map(|c| if c.info.spd_ms { 1.0 } else { c.info.scale }).unwrap_or(1.0);
        let u = CamU { view: cam.view().to_cols_array_2d(), proj: cam.proj(size[0] as f32 / size[1].max(1) as f32).to_cols_array_2d(),
            org: [org[0], org[1], org[2], 0.0], look: [look.size, look.vmax, spd_k, look.skip_buried as u32 as f32] };
        queue.write_buffer(&self.cam, 0, bytemuck::bytes_of(&u));
        if doc.cache.is_some() { self.load(device, doc, f); }

        let (tris, lines) = geometry(doc, f, look);
        let tb = (!tris.is_empty()).then(|| device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("tris"), contents: bytemuck::cast_slice(&tris), usage: wgpu::BufferUsages::VERTEX }));
        let lb = (!lines.is_empty()).then(|| device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("lines"), contents: bytemuck::cast_slice(&lines), usage: wgpu::BufferUsages::VERTEX }));

        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("view"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: color, depth_slice: None, resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color { r: BACKGROUND[0], g: BACKGROUND[1], b: BACKGROUND[2], a: 1.0 }), store: wgpu::StoreOp::Store } })],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: depth,
                depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Store }), stencil_ops: None }),
            timestamp_writes: None, occlusion_query_set: None, multiview_mask: None,
        });
        pass.set_bind_group(0, &self.cam_bg, &[]);
        if let Some(g) = self.frames.get(&f).filter(|_| doc.cache.is_some()) {
            pass.set_pipeline(&self.points);
            for (l, on) in [(&g.water, look.water), (&g.deep, look.deep), (&g.ww, look.whitewater)] {
                if let (Some(l), true) = (l, on) {
                    pass.set_bind_group(1, &l.bg, &[]);
                    pass.draw(0..l.n * 6, 0..1);
                }
            }
        }
        if let Some(b) = &tb { pass.set_pipeline(&self.tris); pass.set_vertex_buffer(0, b.slice(..)); pass.draw(0..tris.len() as u32, 0..1); }
        if let Some(b) = &lb { pass.set_pipeline(&self.lines); pass.set_vertex_buffer(0, b.slice(..)); pass.draw(0..lines.len() as u32, 0..1); }
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

/// Triangles (colliders) and lines (tank box, ocean level, water volumes as wireframes) in scene coordinates.
fn geometry(doc: &Doc, f: usize, look: &Look) -> (Vec<Vert>, Vec<Vert>) {
    let (mut tris, mut lines) = (Vec::new(), Vec::new());
    let line = |out: &mut Vec<Vert>, a: Vec3, b: Vec3, c: [f32; 4]| {
        out.push(Vert { p: a.into(), n: [0.0; 3], c });
        out.push(Vert { p: b.into(), n: [0.0; 3], c });
    };
    if let Some(b) = doc.tank() {
        let c = [0.62, 0.65, 0.7, 1.0];
        let p = |i: u32| Vec3::new(if i & 1 != 0 { b.x1 } else { b.x0 }, if i & 2 != 0 { b.y1 } else { b.y0 }, if i & 4 != 0 { b.z1 } else { b.z0 });
        for i in 0..8u32 { for k in [1u32, 2, 4] { if i & k == 0 { line(&mut lines, p(i), p(i | k), c); } } }
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
    let cache = doc.cache.as_ref().filter(|c| f < c.frames.len());
    let poses = cache.map(|c| c.poses(f));
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
        if o.water {
            let c = [0.25, 0.6, 1.0, 1.0];
            for t in &m.f { for k in 0..3 { line(&mut lines, w[t[k] as usize], w[t[(k + 1) % 3] as usize], c); } }
            continue;
        }
        let c = [0.78, 0.74, 0.68, 1.0];
        for t in &m.f {
            let (a, b, cc) = (w[t[0] as usize], w[t[1] as usize], w[t[2] as usize]);
            let n: [f32; 3] = (b - a).cross(cc - a).normalize_or_zero().into();
            for p in [a, b, cc] { tris.push(Vert { p: p.into(), n, c }); }
        }
    }
    (tris, lines)
}
