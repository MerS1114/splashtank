//! The window: top bar (open files), viewport, timeline at the bottom, information and display settings on the right.

use crate::render::{self, Doc, Look, Orbit, Renderer};
use eframe::egui;
use eframe::egui_wgpu::{self, WgpuConfiguration, WgpuSetup, WgpuSetupCreateNew};
use eframe::wgpu;
use splash_format::Cache;
use crate::bakeui::{Action, BakeUi, Worker};
use std::path::{Path, PathBuf};
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
        theme(&cc.egui_ctx);
        let mut app = App::new(rs, cc.egui_ctx.clone());
        for f in &files { app.open(f); }
        // for checking the panel without clicking: SPLASH_AUTOBAKE=out.splc starts a bake of the opened file
        if let Ok(out) = std::env::var("SPLASH_AUTOBAKE") { app.autobake = Some(PathBuf::from(out)); }
        Ok(Box::new(app))
    }));
    if let Err(e) = r { eprintln!("{e}"); }
}

/// The page's Blender-style dark theme (the colours in src/head.html).
fn theme(ctx: &egui::Context) {
    let hex = |v: u32| egui::Color32::from_rgb((v >> 16) as u8, (v >> 8) as u8, v as u8);
    let mut v = egui::Visuals::dark();
    v.panel_fill = hex(0x2a2a2a);
    v.window_fill = hex(0x2a2a2a);
    v.extreme_bg_color = hex(0x1d1d1d);
    v.faint_bg_color = hex(0x303030);
    v.override_text_color = Some(hex(0xe0e0e0));
    v.selection.bg_fill = hex(0x4772b3);
    v.hyperlink_color = hex(0x5fc3f0);
    v.warn_fg_color = hex(0xe9a43a);
    v.widgets.noninteractive.bg_fill = hex(0x2a2a2a);
    v.widgets.noninteractive.bg_stroke = egui::Stroke::new(1.0, hex(0x161616));
    v.widgets.noninteractive.fg_stroke = egui::Stroke::new(1.0, hex(0xb3b3b3));
    for (w, bg) in [(&mut v.widgets.inactive, 0x545454), (&mut v.widgets.hovered, 0x5e5e5e), (&mut v.widgets.active, 0x4772b3), (&mut v.widgets.open, 0x3b4b66)] {
        w.bg_fill = hex(bg); w.weak_bg_fill = hex(bg); w.bg_stroke = egui::Stroke::new(1.0, hex(0x3a3a3a)); w.fg_stroke = egui::Stroke::new(1.0, hex(0xe0e0e0));
    }
    ctx.set_visuals(v);
}

/// Where the camera is moving to (the page's goCam): framing and the axis views ease there.
#[derive(Clone, Copy)]
struct Goal { target: Option<glam::Vec3>, r: Option<f32>, theta: Option<f32>, phi: Option<f32> }

struct Target { size: [u32; 2], color: wgpu::Texture, id: egui::TextureId }

/// The side panel's tabs (the page's property tabs).
#[derive(Clone, Copy, PartialEq)]
enum Tab { Bake, Sim, Tank, Objects, View }

struct App {
    doc: Doc,
    tab: Tab,
    /// the scene file edits are saved to (None: not saved as a scene file yet), whether there are unsaved edits, the selected object
    scene_path: Option<PathBuf>,
    dirty: bool,
    sel: Option<usize>,
    r: Renderer,
    target: Option<Target>,
    cam: Orbit,
    goal: Option<Goal>,
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
    /// the file opened last
    path: Option<PathBuf>,
    bake: BakeUi,
    worker: Worker,
    /// frames of the cache being written already shown, and whether a task was running at the last redraw
    seen: u32,
    was_busy: bool,
    autobake: Option<PathBuf>,
}

impl App {
    fn new(rs: &egui_wgpu::RenderState, ctx: egui::Context) -> App {
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
            doc: Doc::default(), tab: Tab::Bake, scene_path: None, dirty: false, sel: None, r: Renderer::new(&rs.device), target: None,
            cam: Orbit { target: glam::Vec3::new(0.0, 0.7, 0.0), theta: 0.8, phi: 1.0, r: 6.2, ortho: false }, goal: None,
            t: 0.0, playing: false, looping: true, speed: 1.0, look: Look::default(),
            msg: "Open a bake cache (.splc) or a scene file (.json), or drop one on the window.".into(),
            gpu: crate::gpu::describe(&rs.adapter, &rs.device), last: Instant::now(), frame_ms: 0.0, ahead: tx,
            path: None, bake: BakeUi::default(), worker: Worker::new(ctx), seen: 0, was_busy: false, autobake: None,
        }
    }

    /// Asks before unsaved scene edits are thrown away; true to go ahead.
    fn may_discard(&self) -> bool {
        !self.dirty || rfd::MessageDialog::new().set_title("SplashTank").set_level(rfd::MessageLevel::Warning)
            .set_description("The scene has changes that are not saved. Go on without saving them?").set_buttons(rfd::MessageButtons::YesNo).show() == rfd::MessageDialogResult::Yes
    }

    fn save_scene(&mut self, ask: bool) {
        let Some(s) = &self.doc.scene else { self.msg = "No scene to save.".into(); return; };
        let path = match (&self.scene_path, ask) {
            (Some(p), false) => Some(p.clone()),
            _ => {
                let mut d = rfd::FileDialog::new().set_title("Save the scene as").add_filter("Scene", &["json"]).set_file_name("splashtank-scene.json");
                if let Some(dir) = self.path.as_ref().and_then(|p| p.parent()) { d = d.set_directory(dir); }
                d.save_file().map(|p| if p.extension().is_none() { p.with_extension("json") } else { p })
            }
        };
        let Some(p) = path else { return; };
        match s.save(&p) {
            Ok(()) => { self.msg = format!("Saved the scene as {}", p.display()); self.scene_path = Some(p); self.dirty = false; }
            Err(e) => self.msg = format!("Could not save {}: {e}", p.display()),
        }
    }

    /// After an edit to the scene's JSON: the parsed scene (tank, objects) is made again from it.
    fn edited(&mut self) {
        if let Some(s) = self.doc.scene.take() {
            let j = s.json.clone();
            self.doc.scene = Some(splash_format::Scene::from_json(j).unwrap_or(s));
        }
        self.dirty = true;
    }

    fn open(&mut self, path: &Path) {
        let same = self.path.as_deref() == Some(path);
        let is_json = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("json"));
        match crate::open_into(&mut self.doc, path) {
            Ok(m) => {
                self.msg = m;
                self.t = 0.0;
                self.playing = false;
                if !same { if let Some(b) = self.doc.tank() { self.cam = Orbit::frame(&b); self.goal = None; } }
                self.path = Some(path.to_owned());
                self.bake.source(path);
                self.scene_path = is_json.then(|| path.to_owned());
                self.dirty = false;
                if !same { self.sel = None; }
            }
            Err(e) => self.msg = e,
        }
    }

    /// Shows the newest frame of the cache a task is writing (frames are only added, so the ones kept on the GPU stay good).
    fn follow(&mut self, p: &Path) {
        let Ok(c) = Cache::open(p) else { return; };
        if self.path.as_deref() != Some(p) {
            self.path = Some(p.to_owned());
            self.doc.gen += 1;
            if let Some(s) = c.info.meta.get("scene").filter(|v| v.is_object()).and_then(|v| splash_format::Scene::from_json(v.clone()).ok()) { self.doc.scene = Some(s); }
            let first = self.doc.cache.is_none();
            self.doc.cache = Some(Arc::new(c));
            if first { if let Some(b) = self.doc.tank() { self.cam = Orbit::frame(&b); self.goal = None; } }
        } else {
            self.doc.cache = Some(Arc::new(c));
        }
        self.t = self.frames().saturating_sub(1) as f64;
        self.playing = false;
        self.msg = format!("Showing {} as it is written: {} frames", p.file_name().unwrap_or_default().to_string_lossy(), self.frames());
    }

    /// Lets go of the cache at p when it is open (a task is about to write or replace it).
    fn close_if(&mut self, p: &Path) {
        if self.path.as_deref() == Some(p) && self.doc.cache.is_some() { self.doc.cache = None; self.doc.gen += 1; }
    }

    fn act(&mut self, a: Action) {
        match a {
            Action::Stop => self.worker.stop(),
            Action::Start(title, t) => {
                if t.inp.as_deref() == Some(t.out.as_path()) { self.worker.job.lock().unwrap().result = Some(("Save to another file than the bake it works on.".into(), true)); return; }
                self.close_if(&t.out);
                let slow = t.out.to_string_lossy().to_ascii_uppercase().starts_with("C:");
                self.bake.follow = true;
                self.seen = 0;
                self.worker.start(title, t);
                // measured on this computer: C: wrote about 13 MB/s on long writes, G: 463 MB/s
                if slow { self.worker.job.lock().unwrap().log.push("This cache goes to drive C:, which writes slowly on this computer (about 13 MB/s on long writes). Big bakes are much faster on G:.".into()); }
            }
        }
    }

    /// Keeps the view in step with a running task: the newest frame while it writes, letting go of the file when it finishes, and the
    /// finished cache opened at the end.
    fn poll_job(&mut self) {
        let (busy, done, fin, released, out, ok) = {
            let j = self.worker.job.lock().unwrap();
            (j.busy, j.done, j.finishing, j.released, j.out.clone(), j.result.as_ref().is_some_and(|r| !r.1))
        };
        let Some(out) = out else { return; };
        if fin && !released {
            self.close_if(&out);
            self.worker.job.lock().unwrap().released = true;
        }
        if busy && !fin && self.bake.follow && done > self.seen {
            self.seen = done;
            self.follow(&out);
        }
        if self.was_busy && !busy {
            self.bake.check_resume(&out);
            if ok || out.exists() {
                let keep = self.bake.follow;
                // the finished cache holds the scene as edited: keep where it saves and whether it is saved
                let (sp, dirty, sel) = (self.scene_path.clone(), self.dirty, self.sel);
                self.open(&out);
                (self.scene_path, self.dirty, self.sel) = (sp, dirty, sel);
                if keep { self.t = self.frames().saturating_sub(1) as f64; }
            }
        }
        self.was_busy = busy;
    }

    /// Home: the whole tank in view, from the angle the camera has now (frameAll)
    fn frame_all(&mut self) {
        if let Some(b) = self.doc.tank() { let mut o = self.cam; o.frame_keep_angles(&b); self.goal = Some(Goal { target: Some(o.target), r: Some(o.r), theta: None, phi: None }); }
    }
    /// looking along an axis, orthographic, as Blender's numpad views (snapView); top and bottom keep the nearest side square to the screen
    fn snap_view(&mut self, v: &str) {
        use std::f32::consts::PI;
        let (th, ph) = match v { "front" => (Some(0.0), PI / 2.0), "back" => (Some(PI), PI / 2.0), "right" => (Some(PI / 2.0), PI / 2.0), "left" => (Some(-PI / 2.0), PI / 2.0),
            "top" => (None, 0.0008), _ => (None, PI - 0.0008) };
        let th = th.unwrap_or((self.cam.theta / (PI / 2.0)).round() * (PI / 2.0));
        self.cam.ortho = true;
        self.goal = Some(Goal { target: None, r: None, theta: Some(th), phi: Some(ph) });
    }
    /// eases the camera towards its goal (k = 1 - e^(-12 dt)); true while still moving
    fn step_cam(&mut self, dt: f32) -> bool {
        let Some(g) = self.goal else { return false; };
        let k = 1.0 - (-dt.min(0.25) * 12.0).exp();
        let ang = |a: f32, b: f32| (a - b).sin().atan2((a - b).cos());
        let c = &mut self.cam;
        if let Some(t) = g.target { c.target += (t - c.target) * k; }
        if let Some(r) = g.r { c.r += (r - c.r) * k; }
        if let Some(th) = g.theta { c.theta += ang(th, c.theta) * k; }
        if let Some(ph) = g.phi { c.phi += (ph - c.phi) * k; }
        let done = g.target.is_none_or(|t| (t - c.target).length() < 0.003) && g.r.is_none_or(|r| (r - c.r).abs() < 0.005)
            && g.theta.is_none_or(|th| ang(th, c.theta).abs() < 0.003) && g.phi.is_none_or(|ph| (ph - c.phi).abs() < 0.003);
        if done { self.goal = None; }
        true
    }

    /// The axis widget in the viewport's corner, as the page's: drawn from the camera, click a ball to look along that axis, click the
    /// middle to switch perspective and orthographic.
    fn axis_widget(&mut self, ui: &egui::Ui, rect: egui::Rect) {
        let hex = |v: u32, a: u8| egui::Color32::from_rgba_unmultiplied((v >> 16) as u8, (v >> 8) as u8, v as u8, a);
        let area = egui::Rect::from_min_size(egui::pos2(rect.right() - 110.0, rect.top() + 8.0), egui::vec2(96.0, 96.0));
        let (c, rr) = (area.center(), 96.0 * 0.36);
        let v = self.cam.view();
        let mut balls = Vec::new();
        for (a, ax, col) in [('x', glam::Vec3::X, 0xff3352u32), ('y', glam::Vec3::Y, 0x8bdc00), ('z', glam::Vec3::Z, 0x2890ff)] {
            let s = v.transform_vector3(ax);
            balls.push((a, 1.0f32, egui::pos2(c.x + s.x * rr, c.y - s.y * rr), s.z, col));
            balls.push((a, -1.0, egui::pos2(c.x - s.x * rr, c.y + s.y * rr), -s.z, col));
        }
        balls.sort_by(|p, q| p.3.total_cmp(&q.3));
        let resp = ui.interact(area, ui.scope_id().with("axisgiz"), egui::Sense::click());
        let hot = resp.hover_pos().and_then(|m| balls.iter().rev().find(|b| b.2.distance(m) < 12.0).map(|b| (b.0, b.1 > 0.0)));
        let p = ui.painter_at(area.expand(14.0));
        if resp.hovered() { p.circle_filled(c, rr + 12.0, egui::Color32::from_rgba_unmultiplied(255, 255, 255, 30)); }
        for (a, s, pos, _, col) in &balls {
            let is_hot = hot == Some((*a, *s > 0.0));
            if *s > 0.0 {
                p.line_segment([c, *pos], egui::Stroke::new(2.0, hex(*col, 255)));
                p.circle_filled(*pos, 9.0, if is_hot { egui::Color32::WHITE } else { hex(*col, 255) });
                p.text(*pos + egui::vec2(0.0, 0.5), egui::Align2::CENTER_CENTER, a.to_ascii_uppercase(), egui::FontId::proportional(10.0), hex(0x16191c, 255));
            } else {
                p.circle(*pos, 7.0, if is_hot { egui::Color32::from_rgba_unmultiplied(255, 255, 255, 230) } else { hex(*col, 0x55) }, egui::Stroke::new(1.5, hex(*col, 255)));
            }
        }
        if resp.clicked() {
            match hot {
                Some((a, pos)) => self.snap_view(match (a, pos) { ('x', true) => "right", ('x', false) => "left", ('y', true) => "top", ('y', false) => "bottom", (_, true) => "front", _ => "back" }),
                None => self.cam.ortho = !self.cam.ortho,
            }
        }
        if resp.hovered() { ui.ctx().request_repaint(); }
    }

    fn frames(&self) -> usize { self.doc.cache.as_ref().map(|c| c.frames.len()).unwrap_or(0) }
    fn fps(&self) -> f32 { self.doc.cache.as_ref().map(|c| c.info.fps).unwrap_or(24.0) }

    fn ensure_target(&mut self, rs: &egui_wgpu::RenderState, size: [u32; 2]) {
        if self.target.as_ref().map(|t| t.size == size).unwrap_or(false) { return; }
        let ext = wgpu::Extent3d { width: size[0], height: size[1], depth_or_array_layers: 1 };
        let color = rs.device.create_texture(&wgpu::TextureDescriptor { label: Some("view"), size: ext, mip_level_count: 1, sample_count: 1,
            dimension: wgpu::TextureDimension::D2, format: render::COLOR, usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[wgpu::TextureFormat::Rgba8UnormSrgb] });
        // egui shows the picture through a plain view, so the colours come out as the shader wrote them (as in the page and --picture);
        // through an sRGB view they were decoded as sRGB and came out far too dark
        let shown = color.create_view(&wgpu::TextureViewDescriptor { format: Some(wgpu::TextureFormat::Rgba8Unorm), ..Default::default() });
        let mut er = rs.renderer.write();
        if let Some(old) = self.target.take() { er.free_texture(&old.id); }
        let id = er.register_native_texture(&rs.device, &shown, wgpu::FilterMode::Linear);
        self.target = Some(Target { size, color, id });
    }

    fn step(&mut self, k: f64) {
        let n = self.frames();
        if n == 0 { return; }
        self.bake.follow = false;
        self.playing = false;
        self.t = (self.t.floor() + k).rem_euclid(n as f64);
    }

    fn top(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            if ui.button("Open…").on_hover_text("Open a bake cache (.splc) or a scene file (.json) saved by the web page").clicked() && self.may_discard() {
                if let Some(p) = rfd::FileDialog::new().add_filter("SplashTank files", &["splc", "json"]).add_filter("Bake cache", &["splc"])
                    .add_filter("Scene", &["json"]).pick_file() { self.open(&p); }
            }
            ui.add_enabled_ui(self.doc.scene.is_some(), |ui| {
                if ui.button("Save scene").on_hover_text("Save the scene file (Ctrl+S). The page opens it as before.").clicked() { self.save_scene(false); }
                if ui.button("Save scene as…").clicked() { self.save_scene(true); }
            });
            if self.dirty { ui.colored_label(egui::Color32::from_rgb(0xe9, 0xa4, 0x3a), "unsaved changes"); }
            ui.separator();
            ui.label(&self.msg);
        });
    }

    fn timeline(&mut self, ui: &mut egui::Ui) {
        let n = self.frames();
        ui.horizontal(|ui| {
            ui.add_enabled_ui(n > 0, |ui| {
                if ui.button("|<").on_hover_text("First frame (Shift+Left)").clicked() { self.bake.follow = false; self.playing = false; self.t = 0.0; }
                if ui.button("<").on_hover_text("One frame back (Left)").clicked() { self.step(-1.0); }
                if ui.button(if self.playing { "Pause" } else { "Play" }).on_hover_text("Play or pause (Space)").clicked() { self.bake.follow = false; self.playing = !self.playing; }
                if ui.button(">").on_hover_text("One frame on (Right)").clicked() { self.step(1.0); }
                if ui.button(">|").on_hover_text("Last frame (Shift+Right)").clicked() { self.bake.follow = false; self.playing = false; self.t = n.saturating_sub(1) as f64; }
                ui.checkbox(&mut self.looping, "Loop");
                ui.add(egui::DragValue::new(&mut self.speed).range(0.05..=4.0).speed(0.01).prefix("speed ").suffix("x"));
                let mut f = self.t.floor() as usize;
                ui.spacing_mut().slider_width = (ui.available_width() - 160.0).max(100.0);
                if ui.add(egui::Slider::new(&mut f, 0..=n.saturating_sub(1)).text("frame")).changed() { self.bake.follow = false; self.playing = false; self.t = f as f64; }
                ui.label(format!("{:.2} s", self.t.floor() / self.fps() as f64));
            });
        });
    }

    fn side(&mut self, ui: &mut egui::Ui) {
        ui.horizontal_wrapped(|ui| {
            for (t, name) in [(Tab::Bake, "Bake"), (Tab::Sim, "Simulation"), (Tab::Tank, "Tank"), (Tab::Objects, "Objects"), (Tab::View, "View")] {
                ui.selectable_value(&mut self.tab, t, name);
            }
        });
        ui.separator();
        egui::ScrollArea::vertical().show(ui, |ui| {
            let tab = self.tab;
            if tab == Tab::Bake {
                let shown = self.path.clone().filter(|p| self.doc.cache.is_some() && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("splc")));
                let scene = self.doc.scene.as_ref().map(|s| &s.json);
                if let Some(a) = self.bake.panel(ui, &self.worker, scene, shown.as_deref()) { self.act(a); }
                return;
            }
            if matches!(tab, Tab::Sim | Tab::Tank | Tab::Objects) {
                let Some(s) = self.doc.scene.as_mut() else { ui.label("Open a scene file (.json) or a bake (.splc) to edit its scene."); return; };
                if self.doc.cache.is_some() { ui.label(egui::RichText::new("Changes apply to the next bake; the bake shown stays as it was.").small()); }
                let changed = match tab {
                    Tab::Sim => crate::edit::settings(ui, &mut s.json),
                    Tab::Tank => crate::edit::tank(ui, &mut s.json),
                    _ => crate::edit::objects(ui, &mut s.json, &mut self.sel),
                };
                if changed { self.edited(); }
                return;
            }
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
                // a cache still being written always ends inside a frame
                let writing = { let j = self.worker.job.lock().unwrap(); j.busy && j.out == self.path };
                if c.truncated && !writing { ui.colored_label(egui::Color32::ORANGE, "The file ends inside a frame: a bake cut short."); }
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
            ui.add(egui::Slider::new(&mut self.look.size, 0.2..=2.0).text("Point size")).on_hover_text("Point size as a share of the particle spacing (the page's default 0.85).");
            ui.add(egui::Slider::new(&mut self.look.vmax, 1.0..=12.0).step_by(0.5).text("White at, m/s")).on_hover_text("The speed that is coloured white. Slower water runs from blue to cyan.");
            ui.add(egui::Slider::new(&mut self.look.foam, 0.0..=1.0).step_by(0.05).text("White water")).on_hover_text("How strongly churned water is drawn white.");
            ui.add(egui::Slider::new(&mut self.look.detail, 0..=15).text("Water detail")).on_hover_text("Look-only extra points drawn around each water point.");
            ui.add(egui::Slider::new(&mut self.look.spr_detail, 0..=15).text("Whitewater detail")).on_hover_text("Look-only extra points drawn around each whitewater point: spray streaks, mist clouds, foam patches.");
            ui.checkbox(&mut self.look.blend, "Blend between frames").on_hover_text("While playing, the water moves smoothly from one baked frame to the next, as on the page.");
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
        // the page's keys: Space plays, Left/Right step a frame, Shift+Left/Right go to the ends, Home (or F) frames the tank, 1/3/7 look
        // along an axis (with Ctrl from the other side), 5 switches perspective and orthographic
        let typing = ui.ctx().egui_wants_keyboard_input();
        let (space, left, right, home, shift, ctrl) = ui.input(|i| (i.key_pressed(egui::Key::Space), i.key_pressed(egui::Key::ArrowLeft),
            i.key_pressed(egui::Key::ArrowRight), i.key_pressed(egui::Key::Home), i.modifiers.shift, i.modifiers.command));
        let (k1, k3, k5, k7, kf) = ui.input(|i| (i.key_pressed(egui::Key::Num1), i.key_pressed(egui::Key::Num3), i.key_pressed(egui::Key::Num5),
            i.key_pressed(egui::Key::Num7), i.key_pressed(egui::Key::F)));
        if !typing {
            if space && n > 0 { self.bake.follow = false; self.playing = !self.playing; }
            if (left || right) && shift { self.bake.follow = false; }
            if left { if shift { self.playing = false; self.t = 0.0; } else { self.step(-1.0); } }
            if right { if shift { if n > 0 { self.playing = false; self.t = (n - 1) as f64; } } else { self.step(1.0); } }
            if home || kf { self.frame_all(); }
            if k1 { self.snap_view(if ctrl { "back" } else { "front" }); }
            if k3 { self.snap_view(if ctrl { "left" } else { "right" }); }
            if k7 { self.snap_view(if ctrl { "bottom" } else { "top" }); }
            if k5 { self.cam.ortho = !self.cam.ortho; }
        }
        if self.step_cam(dt) { ui.ctx().request_repaint(); }
        if let Some(out) = self.autobake.take() {
            if let Some(src) = self.path.clone() {
                let scene = if src.extension().is_some_and(|e| e.eq_ignore_ascii_case("splc")) { crate::bake_cli::from_cache(&src).map(|x| x.0) } else { crate::bake_cli::read_json(&src) };
                if let Ok(scene) = scene {
                    let o = splash_sim::scene::BakeOpts { spacing: std::env::var("SPLASH_AUTOBAKE_SPACING").ok().and_then(|v| v.parse().ok()).unwrap_or(0.04), ..Default::default() };
                    self.act(Action::Start("Baking (automatic)".into(), crate::bake_cli::Task { kind: crate::bake_cli::Kind::Bake { water_only: false, checkpoint_secs: 300.0 }, inp: None, scene, o, out }));
                }
            }
        }
        self.poll_job();
        self.look.region = (self.bake.det_open && self.tab == Tab::Bake).then_some((self.bake.det.c, self.bake.det.s));
        self.look.selected = if self.tab == Tab::Objects { self.sel.and_then(|k| self.doc.scene.as_ref()?.json["objs"].get(k)?["id"].as_u64()) } else { None };
        // Ctrl+S saves the scene; closing the window with unsaved edits asks first
        if ui.input(|i| i.modifiers.command && i.key_pressed(egui::Key::S)) && self.doc.scene.is_some() { self.save_scene(false); }
        if ui.ctx().input(|i| i.viewport().close_requested()) && self.dirty && !self.may_discard() {
            ui.ctx().send_viewport_cmd(egui::ViewportCommand::CancelClose);
        }

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
        egui::Panel::right("side").default_size(380.0).min_size(330.0).show(ui, |ui| self.side(ui));
        egui::CentralPanel::default().frame(egui::Frame::NONE).show(ui, |ui| {
            let avail = ui.available_size();
            let ppp = ui.ctx().pixels_per_point();
            let size = [((avail.x * ppp) as u32).max(16), ((avail.y * ppp) as u32).max(16)];
            self.ensure_target(&rs, size);
            let f = (self.t.floor() as usize).min(n.saturating_sub(1));
            // the water blends from this frame towards the next while playing (paused, the frame is shown as it is)
            let (fb, w) = if n > 1 && self.t.fract() > 0.0 { (if f + 1 < n { f + 1 } else if self.looping { 0 } else { f }, self.t.fract() as f32) } else { (f, 0.0) };
            // while paused, put the following frames on the GPU too, one per redraw, as long as they fit the budget (like the page's idleFill)
            if !self.playing && n > 1 && self.r.kept_bytes < self.r.budget * 9 / 10 {
                if let Some(k) = (1..n).map(|k| (f + k) % n).find(|&k| !self.r.is_kept(k)) {
                    self.r.load(&rs.device, &self.doc, k);
                    ui.ctx().request_repaint();
                }
            }
            let t = self.target.as_ref().unwrap();
            let mut enc = rs.device.create_command_encoder(&Default::default());
            self.r.draw(&rs.device, &rs.queue, &mut enc, &t.color.create_view(&Default::default()), size, &self.cam, &self.doc, f, fb, w, &self.look);
            rs.queue.submit([enc.finish()]);
            let resp = ui.add(egui::Image::new(egui::load::SizedTexture::new(t.id, avail)).sense(egui::Sense::click_and_drag()));
            // the page's mouse in a bake's view: any button orbits, with Shift it pans, with Ctrl it zooms; the wheel zooms
            let d = resp.drag_delta();
            if resp.dragged() && d != egui::Vec2::ZERO {
                self.goal = None;
                let (sh, ct) = ui.input(|i| (i.modifiers.shift, i.modifiers.command));
                if sh { self.cam.pan(d.x, d.y); } else if ct { self.cam.zoom(d.y * 10.0); } else { self.cam.orbit(d.x, d.y); }
            }
            if resp.hovered() {
                let s = ui.input(|i| i.smooth_scroll_delta.y);
                if s != 0.0 { self.goal = None; self.cam.zoom(-s * 2.0); }
            }
            if resp.double_clicked() { self.frame_all(); }
            self.axis_widget(ui, resp.rect);
        });
    }
}
