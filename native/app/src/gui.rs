//! The window: top bar (open files), viewport, timeline at the bottom, information and display settings on the right.

use crate::render::{self, Doc, Look, Orbit, Renderer};
use eframe::egui;
use eframe::egui_wgpu::{self, WgpuConfiguration, WgpuSetup, WgpuSetupCreateNew};
use eframe::wgpu;
use splash_format::Cache;
use std::path::PathBuf;
use std::sync::{mpsc, Arc};
use std::time::Instant;

pub fn run(files: Vec<PathBuf>) {
    let options = eframe::NativeOptions {
        renderer: eframe::Renderer::Wgpu,
        viewport: egui::ViewportBuilder::default().with_title("SplashTank").with_inner_size([1400.0, 860.0]).with_drag_and_drop(true),
        wgpu_options: WgpuConfiguration {
            wgpu_setup: WgpuSetup::CreateNew(WgpuSetupCreateNew {
                device_descriptor: Arc::new(crate::gpu::device_descriptor),
                ..WgpuSetupCreateNew::without_display_handle()
            }),
            ..Default::default()
        },
        ..Default::default()
    };
    let r = eframe::run_native("SplashTank", options, Box::new(move |cc| {
        let rs = cc.wgpu_render_state.as_ref().ok_or("This program needs a GPU through wgpu.")?;
        let mut app = App::new(rs);
        for f in &files { app.open(f); }
        Ok(Box::new(app))
    }));
    if let Err(e) = r { eprintln!("{e}"); }
}

struct Target { size: [u32; 2], color: wgpu::Texture, depth: wgpu::TextureView, id: egui::TextureId }

struct App {
    doc: Doc,
    r: Renderer,
    target: Option<Target>,
    cam: Orbit,
    /// playhead in frames
    t: f64,
    playing: bool,
    looping: bool,
    speed: f32,
    look: Look,
    msg: String,
    gpu: String,
    last: Instant,
    frame_ms: f32,
    /// frames to read ahead from disk (the loader thread touches their pages so uploads do not wait for the disk)
    ahead: mpsc::Sender<(Arc<Cache>, Vec<usize>)>,
}

impl App {
    fn new(rs: &egui_wgpu::RenderState) -> App {
        let (tx, rx) = mpsc::channel::<(Arc<Cache>, Vec<usize>)>();
        std::thread::spawn(move || {
            let mut sum = 0u64;
            while let Ok((c, frames)) = rx.recv() {
                for f in frames {
                    let Some(fr) = c.frames.get(f) else { continue; };
                    let end = fr.ww.as_ref().map(|w| w.pk.end).into_iter().chain(fr.deep.as_ref().map(|d| d.spd.end)).fold(fr.water.spd.end, usize::max);
                    let b = c.bytes();
                    for i in (fr.objs.start..end.min(b.len())).step_by(4096) { sum = sum.wrapping_add(b[i] as u64); }
                }
            }
            std::hint::black_box(sum);
        });
        App {
            doc: Doc::default(), r: Renderer::new(&rs.device), target: None,
            cam: Orbit { target: glam::Vec3::new(0.0, 0.7, 0.0), theta: 0.75, phi: 1.15, r: 6.0 },
            t: 0.0, playing: false, looping: true, speed: 1.0, look: Look::default(),
            msg: "Open a bake cache (.splc) or a scene file (.json), or drop one on the window.".into(),
            gpu: crate::gpu::describe(&rs.adapter, &rs.device), last: Instant::now(), frame_ms: 0.0, ahead: tx,
        }
    }

    fn open(&mut self, path: &std::path::Path) {
        match crate::open_into(&mut self.doc, path) {
            Ok(m) => {
                self.msg = m;
                self.t = 0.0;
                self.playing = false;
                if let Some(b) = self.doc.tank() { self.cam = Orbit::frame(&b); }
            }
            Err(e) => self.msg = e,
        }
    }

    fn frames(&self) -> usize { self.doc.cache.as_ref().map(|c| c.frames.len()).unwrap_or(0) }
    fn fps(&self) -> f32 { self.doc.cache.as_ref().map(|c| c.info.fps).unwrap_or(24.0) }

    fn ensure_target(&mut self, rs: &egui_wgpu::RenderState, size: [u32; 2]) {
        if self.target.as_ref().map(|t| t.size == size).unwrap_or(false) { return; }
        let ext = wgpu::Extent3d { width: size[0], height: size[1], depth_or_array_layers: 1 };
        let color = rs.device.create_texture(&wgpu::TextureDescriptor { label: Some("view"), size: ext, mip_level_count: 1, sample_count: 1,
            dimension: wgpu::TextureDimension::D2, format: render::COLOR, usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[wgpu::TextureFormat::Rgba8UnormSrgb] });
        let depth = rs.device.create_texture(&wgpu::TextureDescriptor { label: Some("depth"), size: ext, mip_level_count: 1, sample_count: 1,
            dimension: wgpu::TextureDimension::D2, format: render::DEPTH, usage: wgpu::TextureUsages::RENDER_ATTACHMENT, view_formats: &[] });
        // egui samples the picture through an sRGB view, so the colours come out as the shader wrote them (as in the page)
        let shown = color.create_view(&wgpu::TextureViewDescriptor { format: Some(wgpu::TextureFormat::Rgba8UnormSrgb), ..Default::default() });
        let mut er = rs.renderer.write();
        if let Some(old) = self.target.take() { er.free_texture(&old.id); }
        let id = er.register_native_texture(&rs.device, &shown, wgpu::FilterMode::Linear);
        self.target = Some(Target { size, color, depth: depth.create_view(&Default::default()), id });
    }

    fn step(&mut self, k: f64) {
        let n = self.frames();
        if n == 0 { return; }
        self.playing = false;
        self.t = (self.t.floor() + k).rem_euclid(n as f64);
    }

    fn top(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            if ui.button("Open…").on_hover_text("Open a bake cache (.splc) or a scene file (.json) saved by the web page").clicked() {
                if let Some(p) = rfd::FileDialog::new().add_filter("SplashTank files", &["splc", "json"]).add_filter("Bake cache", &["splc"])
                    .add_filter("Scene", &["json"]).pick_file() { self.open(&p); }
            }
            ui.separator();
            ui.label(&self.msg);
        });
    }

    fn timeline(&mut self, ui: &mut egui::Ui) {
        let n = self.frames();
        ui.horizontal(|ui| {
            ui.add_enabled_ui(n > 0, |ui| {
                if ui.button("⏮").on_hover_text("First frame (Home)").clicked() { self.playing = false; self.t = 0.0; }
                if ui.button("◀").on_hover_text("One frame back (Left)").clicked() { self.step(-1.0); }
                if ui.button(if self.playing { "⏸" } else { "▶" }).on_hover_text("Play or pause (Space)").clicked() { self.playing = !self.playing; }
                if ui.button("▶|").on_hover_text("One frame on (Right)").clicked() { self.step(1.0); }
                if ui.button("⏭").on_hover_text("Last frame (End)").clicked() { self.playing = false; self.t = n.saturating_sub(1) as f64; }
                ui.checkbox(&mut self.looping, "Loop");
                ui.add(egui::DragValue::new(&mut self.speed).range(0.05..=4.0).speed(0.01).prefix("speed ").suffix("x"));
                let mut f = self.t.floor() as usize;
                ui.spacing_mut().slider_width = (ui.available_width() - 160.0).max(100.0);
                if ui.add(egui::Slider::new(&mut f, 0..=n.saturating_sub(1)).text("frame")).changed() { self.playing = false; self.t = f as f64; }
                ui.label(format!("{:.2} s", self.t.floor() / self.fps() as f64));
            });
        });
    }

    fn side(&mut self, ui: &mut egui::Ui) {
        egui::ScrollArea::vertical().show(ui, |ui| {
            ui.heading("Cache");
            if let Some(c) = &self.doc.cache {
                let f = (self.t.floor() as usize).min(c.frames.len().saturating_sub(1));
                let fr = c.frames.get(f);
                let i = &c.info;
                ui.label(format!("{} frames at {} a second, spacing {} ({:.1} mm at scale {})", c.frames.len(), i.fps, i.d, i.d * i.scale * 1000.0, i.scale));
                ui.label(format!("File {:.0} MB", c.bytes().len() as f64 / 1048576.0));
                if let Some(fr) = fr {
                    ui.label(format!("Frame {f}: {} water points{}", fr.water.n, if fr.compact() { " (compact)" } else { "" }));
                    ui.label(format!("{} deep water, {} whitewater", fr.deep.as_ref().map(|d| d.n).unwrap_or(0), fr.ww.as_ref().map(|w| w.n).unwrap_or(0)));
                }
                if c.truncated { ui.colored_label(egui::Color32::ORANGE, "The file ends inside a frame: a bake cut short."); }
            } else {
                ui.label("No cache open.");
            }
            ui.separator();
            ui.heading("Scene");
            if let Some(s) = &self.doc.scene {
                ui.label(format!("Tank {:.2} x {:.2} x {:.2}", s.size[0], s.size[1], s.size[2]));
                ui.label(format!("{} objects{}{}", s.objs.len(), if s.ocean_level.is_some() { ", ocean" } else { "" }, if s.narrow_band { ", narrow band" } else { "" }));
                for o in &s.objs { ui.label(format!("  {} ({}{})", o.name, o.shape, if o.water { ", water" } else { "" })); }
            } else {
                ui.label("No scene open.");
            }
            ui.separator();
            ui.heading("Display");
            ui.add(egui::Slider::new(&mut self.look.size, 0.2..=2.0).text("point size"));
            ui.add(egui::Slider::new(&mut self.look.vmax, 0.5..=50.0).logarithmic(true).text("white at m/s"));
            ui.checkbox(&mut self.look.water, "Water");
            ui.checkbox(&mut self.look.deep, "Deep water");
            ui.checkbox(&mut self.look.whitewater, "Whitewater");
            ui.checkbox(&mut self.look.objects, "Objects");
            ui.checkbox(&mut self.look.skip_buried, "Skip buried water").on_hover_text("Water three cells inside the water cannot be seen; drawing 1 in 16 of it is faster. Same as the page's setting.");
            ui.separator();
            ui.heading("GPU");
            ui.label(&self.gpu);
            let mut mb = (self.r.budget >> 20) as u32;
            if ui.add(egui::Slider::new(&mut mb, 256..=16384).logarithmic(true).text("MB of frames kept")).changed() { self.r.budget = (mb as u64) << 20; }
            ui.label(format!("{} frames kept, {} MB, {} uploads", self.r.kept_frames(), self.r.kept_bytes >> 20, self.r.uploads));
            ui.label(format!("{:.1} ms a frame ({:.0} a second)", self.frame_ms, 1000.0 / self.frame_ms.max(0.1)));
        });
    }
}

impl eframe::App for App {
    fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
        let Some(rs) = frame.wgpu_render_state().cloned() else { return; };
        let now = Instant::now();
        let dt = now.duration_since(self.last).as_secs_f32();
        self.last = now;
        self.frame_ms = self.frame_ms * 0.9 + dt * 1000.0 * 0.1;

        let dropped: Vec<PathBuf> = ui.input(|i| i.raw.dropped_files.iter().map(|f| f.path().to_path_buf()).filter(|p| !p.as_os_str().is_empty()).collect());
        if let Some(p) = dropped.last() { self.open(p); }
        let n = self.frames();
        let (space, left, right, home, end) = ui.input(|i| (i.key_pressed(egui::Key::Space), i.key_pressed(egui::Key::ArrowLeft),
            i.key_pressed(egui::Key::ArrowRight), i.key_pressed(egui::Key::Home), i.key_pressed(egui::Key::End)));
        if space && n > 0 { self.playing = !self.playing; }
        if left { self.step(-1.0); }
        if right { self.step(1.0); }
        if home { self.playing = false; self.t = 0.0; }
        if end && n > 0 { self.playing = false; self.t = (n - 1) as f64; }

        if self.playing && n > 0 {
            self.t += (dt.min(0.1) * self.fps() * self.speed) as f64;
            if self.t >= n as f64 { if self.looping { self.t %= n as f64; } else { self.t = (n - 1) as f64; self.playing = false; } }
            if let Some(c) = &self.doc.cache {
                let f = self.t.floor() as usize;
                let next: Vec<usize> = (1..=3).map(|k| (f + k) % n).filter(|&k| !self.r.is_kept(k)).collect();
                if !next.is_empty() { let _ = self.ahead.send((c.clone(), next)); }
            }
            ui.ctx().request_repaint();
        }

        egui::Panel::top("top").show(ui, |ui| self.top(ui));
        egui::Panel::bottom("timeline").show(ui, |ui| self.timeline(ui));
        egui::Panel::right("side").default_size(300.0).show(ui, |ui| self.side(ui));
        egui::CentralPanel::default().frame(egui::Frame::NONE).show(ui, |ui| {
            let avail = ui.available_size();
            let ppp = ui.ctx().pixels_per_point();
            let size = [((avail.x * ppp) as u32).max(16), ((avail.y * ppp) as u32).max(16)];
            self.ensure_target(&rs, size);
            let f = self.t.floor() as usize;
            // while paused, put the following frames on the GPU too, one per redraw, as long as they fit the budget (like the page's idleFill)
            if !self.playing && n > 1 && self.r.kept_bytes < self.r.budget * 9 / 10 {
                if let Some(k) = (1..n).map(|k| (f + k) % n).find(|&k| !self.r.is_kept(k)) {
                    self.r.load(&rs.device, &self.doc, k);
                    ui.ctx().request_repaint();
                }
            }
            let t = self.target.as_ref().unwrap();
            let mut enc = rs.device.create_command_encoder(&Default::default());
            self.r.draw(&rs.device, &rs.queue, &mut enc, &t.color.create_view(&Default::default()), &t.depth, size, &self.cam, &self.doc, f, &self.look);
            rs.queue.submit([enc.finish()]);
            let resp = ui.add(egui::Image::new(egui::load::SizedTexture::new(t.id, avail)).sense(egui::Sense::click_and_drag()));
            let d = resp.drag_delta();
            if resp.dragged_by(egui::PointerButton::Primary) { self.cam.orbit(d.x, d.y); }
            if resp.dragged_by(egui::PointerButton::Secondary) || resp.dragged_by(egui::PointerButton::Middle) { self.cam.pan(d.x, d.y, avail.y); }
            if resp.hovered() {
                let s = ui.input(|i| i.smooth_scroll_delta.y);
                if s != 0.0 { self.cam.zoom(s / 50.0); }
            }
            if resp.double_clicked() { if let Some(b) = self.doc.tank() { self.cam = Orbit::frame(&b); } }
        });
    }
}
