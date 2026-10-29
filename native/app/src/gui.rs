//! The window: top bar (open files), viewport, timeline at the bottom, information and display settings on the right.

use crate::render::{self, Doc, Look, Orbit, Renderer};
use eframe::egui;
use eframe::egui_wgpu::{self, WgpuConfiguration, WgpuSetup, WgpuSetupCreateNew};
use eframe::wgpu;
use splash_format::Cache;
use crate::bakeui::{Action, BakeUi, Worker};
use crate::tf::{self, Kind, Tf, Tool};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc};
use std::time::Instant;

pub fn run(files: Vec<PathBuf>) {
    let options = eframe::NativeOptions {
        renderer: eframe::Renderer::Wgpu,
        viewport: egui::ViewportBuilder::default().with_title(title()).with_icon(icon()).with_inner_size([1400.0, 860.0]).with_drag_and_drop(true),
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

/// The window's icon (assets/icon256.png, the same drop as the program's icon).
fn icon() -> Arc<egui::IconData> {
    let dec = png::Decoder::new(std::io::Cursor::new(include_bytes!("../assets/icon256.png")));
    let mut r = dec.read_info().expect("icon");
    let mut buf = vec![0; r.output_buffer_size().unwrap_or(256 * 256 * 4)];
    let info = r.next_frame(&mut buf).expect("icon");
    Arc::new(egui::IconData { rgba: buf[..info.buffer_size()].to_vec(), width: info.width, height: info.height })
}

/// The window title: which copy this is (channel.txt next to the program, written by native/tools/install.ps1: testing or published)
/// and the commit it was built from.
fn title() -> String {
    let channel = std::env::current_exe().ok().and_then(|p| std::fs::read_to_string(p.with_file_name("channel.txt")).ok()).map(|s| s.trim().to_string());
    let commit = env!("SPLASH_COMMIT");
    match channel.as_deref() {
        Some("testing") => format!("SplashTank Testing ({commit})"),
        Some("published") => format!("SplashTank ({commit})"),
        _ => format!("SplashTank (build {commit})"),
    }
}

/// The page's starting scenes, as scene files (scenes.json, made by native/tools/export-scenes.js from the page).
fn scenes() -> &'static Value {
    static S: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    S.get_or_init(|| serde_json::from_str(include_str!("scenes.json")).expect("scenes.json"))
}

/// The Help tab: the hotkeys, as the page lists them.
fn help(ui: &mut egui::Ui) {
    ui.heading("Hotkeys, Blender style");
    for l in [
        "G move, R rotate, S scale; then X, Y or Z locks an axis (pressed again: the object's own axis), Shift + an axis locks a plane",
        "type a number for an exact value; Ctrl held flips snapping; Shift + Tab turns snapping on or off; V held snaps to points; middle click picks the axis you moved along",
        "click or Enter confirms, right click or Esc cancels",
        "click selects, Shift + click adds to the selection, drag for a box",
        "A select all, Alt + A none",
        "Shift + A add, Shift + D duplicate, X or Delete delete, H hide, Alt + H show all",
        "I keys the selection at the playhead (over a row in the Objects tab: only that row), Alt + I takes the key off; click a key mark to pick it, drag it to move it, Delete removes it",
        "Tab edits the shape of a collider: 1 points, 2 edges, 3 faces, E extrude, I inset, Tab to leave",
        "Ctrl + Z undo, Ctrl + Shift + Z or Ctrl + Y redo, Ctrl + S save the scene",
        "Space plays, Left / Right step a frame, Shift + Left / Right go to the ends, Up / Down jump between keys",
        "orbit: middle or right drag, or Alt + drag; pan: Shift + drag; zoom: the wheel or Ctrl + drag",
        "F focuses the selection, Home frames the tank; 1, 3, 7 look from the front, side and top (Ctrl: the other side), 5 switches orthographic",
        "P shows the performance overlay",
        "Simulation tab: type in Search to find a setting; right-click a setting to reset it",
    ] { ui.label(format!("- {l}")); }
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
enum Tab { Bake, Sim, Tank, Objects, View, Help }

struct App {
    doc: Doc,
    tab: Tab,
    /// the scene file edits are saved to (None: not saved as a scene file yet), whether there are unsaved edits, the selected object
    scene_path: Option<PathBuf>,
    dirty: bool,
    sel: Option<usize>,
    /// every selected object (sel is the active one, shown in the Objects tab)
    sel_set: Vec<usize>,
    tool: Tool,
    tf: Option<Tf>,
    tf_text: String,
    /// with a bake open: show the scene to edit instead of the bake
    scene_view: bool,
    /// undo: the scene before each change; stable is the scene at rest, burst says a change is going on (a drag, a G move)
    undo: Vec<Value>,
    redo: Vec<Value>,
    stable: Option<Value>,
    burst: bool,
    changed_now: bool,
    hover: Option<tf::Part>,
    add_at: Option<egui::Pos2>,
    box_from: Option<egui::Pos2>,
    /// the New scene menu is open
    new_menu: bool,
    /// the Simulation tab's search text, and a button in the Objects tab asking for something done to the selection
    find: String,
    obj_act: Option<&'static str>,
    /// the scene's time (seconds) on its timeline, and whether the scene plays (its keyed objects move)
    st: f64,
    splay: bool,
    /// Blender's record button: changing an object keys what changed
    auto_key: bool,
    /// Bake playback: 0 Full, 1 Smooth (drops the look-only extras while playback falls behind), 2 Fast
    pb: u8,
    /// a key time picked on the timeline (Delete removes the keys there), and a key mark being dragged (from, to)
    sel_key: Option<f64>,
    key_drag: Option<(f64, f64)>,
    /// Delete already removed a picked key this frame (so it does not also delete the selected objects)
    key_del_now: bool,
    /// the live sim: on, its own worker (its own GPU device), the frames coming in, and whether the scene changed since it started
    live: bool,
    live_w: Worker,
    live_rx: Option<mpsc::Receiver<Vec<u8>>>,
    live_pending: Vec<Vec<u8>>,
    live_stale: bool,
    /// the click that finished a move is only that (it does not also select)
    swallow: bool,
    /// edit mode: the shape being edited, and a move of its points going on (the move, the points, the points as tiny objects)
    edit: Option<crate::editmode::Edit>,
    /// Global or Local axes, snapping on (the magnet) and what it snaps to (0 increments, 1 points, 2 edge centres, 3 face centres),
    /// the tank's face arrows shown, and a face being dragged (which, and the tank's low and high corners when the drag began)
    orient_local: bool,
    snap_on: bool,
    snap_to: u8,
    handles: bool,
    face_drag: Option<(usize, glam::Vec3, glam::Vec3, egui::Pos2)>,
    etf: Option<(Tf, Vec<usize>, Vec<Value>)>,
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
    /// the performance overlay (P): shown, and the slowest frame lately
    perf: bool,
    slow_ms: f32,
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
            sel_set: Vec::new(), tool: Tool::Select, tf: None, tf_text: String::new(), scene_view: false, undo: Vec::new(), redo: Vec::new(), stable: None, burst: false,
            changed_now: false, hover: None, add_at: None, box_from: None, new_menu: false, find: String::new(), obj_act: None, edit: None, etf: None, orient_local: false, snap_on: false, snap_to: 0, handles: true, face_drag: None, st: 0.0, splay: false, auto_key: false, pb: 1, sel_key: None, key_drag: None, key_del_now: false,
            live: false, live_w: Worker::new(ctx.clone()), live_rx: None, live_pending: Vec::new(), live_stale: false, swallow: false,
            cam: Orbit { target: glam::Vec3::new(0.0, 0.7, 0.0), theta: 0.8, phi: 1.0, r: 6.2, ortho: false }, goal: None,
            t: 0.0, playing: false, looping: true, speed: 1.0, look: Look::default(),
            msg: "Open a bake cache (.splc) or a scene file (.json), or drop one on the window.".into(),
            gpu: crate::gpu::describe(&rs.adapter, &rs.device), last: Instant::now(), frame_ms: 0.0, perf: false, slow_ms: 0.0, ahead: tx,
            path: None, bake: BakeUi::default(), worker: Worker::new(ctx.clone()), seen: 0, was_busy: false, autobake: None,
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
            Ok(()) => { self.msg = format!("Saved the scene as {}", p.display()); self.bake.saved_as(&p); self.scene_path = Some(p); self.dirty = false; }
            Err(e) => self.msg = format!("Could not save {}: {e}", p.display()),
        }
    }

    /// After an edit to the scene's JSON: the parsed scene (tank, objects) is made again from it.
    fn edited(&mut self) {
        self.live_stale = true;
        // the first change of a burst saves the scene before it for undo
        if !self.burst { if let Some(s) = self.stable.take() { self.undo.push(s); if self.undo.len() > 100 { self.undo.remove(0); } } self.redo.clear(); self.burst = true; }
        self.changed_now = true;
        if let Some(s) = self.doc.scene.take() {
            let j = s.json.clone();
            self.doc.scene = Some(splash_format::Scene::from_json(j).unwrap_or(s));
        }
        self.dirty = true;
    }

    /// New scene: an empty tank, or one of the page's starting scenes (scenes.json, made by native/tools/export-scenes.js from the page).
    fn new_scene(&mut self, name: &str) {
        self.live_off();
        self.edit = None; self.etf = None;
        let all = scenes();
        let mut j = if name == "Empty tank" {
            // the page's default tank and settings (Wave tank is built from them) with nothing in it
            let mut j = all["scenes"]["Wave tank"].clone();
            j["objs"] = serde_json::json!([]); j["fills"] = serde_json::json!([]); j["events"] = serde_json::json!([]);
            j
        } else { all["scenes"][name].clone() };
        if j.is_null() { return; }
        j["saved"] = Value::Null;
        if let Some(o) = j.as_object_mut() { o.remove("saved"); }
        let Ok(s) = splash_format::Scene::from_json(j.clone()) else { self.msg = format!("Could not make {name}."); return; };
        self.doc.scene = Some(s);
        self.doc.cache = None;
        self.doc.gen += 1;
        self.path = None;
        self.scene_path = None;
        self.dirty = false;
        self.sel = None; self.sel_set.clear();
        self.scene_view = false;
        self.undo.clear(); self.redo.clear(); self.burst = false;
        self.stable = Some(j.clone());
        self.t = 0.0; self.playing = false;
        self.bake.source_scene(name, &j);
        if let Some(b) = self.doc.tank() { self.cam = Orbit::frame(&b); self.goal = None; }
        self.tab = Tab::Objects;
        self.splay = false;
        self.auto_key = false;
        self.set_time(0.0);
        self.msg = format!("New scene: {name}. Add objects with Shift+A or Add, fill the tank in the Tank tab, and save it with Save scene.");
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
                if !same { self.sel = None; self.sel_set.clear(); }
                self.edit = None; self.etf = None;
                self.scene_view = false;
                self.undo.clear(); self.redo.clear(); self.burst = false;
                self.stable = self.doc.scene.as_ref().map(|s| s.json.clone());
                if self.live { self.live = false; self.live_w.stop(); self.live_rx = None; }
                self.splay = false;
                self.auto_key = self.doc.scene.as_ref().and_then(|s| s.json.pointer("/timeline/auto")?.as_bool()).unwrap_or(false);
                if is_json { self.set_time(0.0); }
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
                // a bake shows its own frames: the live sim stops
                self.live_off();
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
    /// The objects of the scene being edited, while the scene (not a bake) is shown.
    fn editing(&self) -> bool { self.doc.scene.is_some() && (self.doc.cache.is_none() || self.scene_view || self.live) }

    /// Starts (or starts again) the live sim: the scene as it is now, at the Bake tab's spacing (Preview), its frames kept in memory.
    fn live_start(&mut self) {
        let Some(j) = self.doc.scene.as_ref().map(|s| s.json.clone()) else { return; };
        let (tx, rx) = mpsc::channel();
        self.doc.cache = None;
        self.doc.gen += 1;
        self.live_rx = Some(rx);
        self.live_pending.clear();
        self.live_stale = false;
        let o = splash_sim::scene::BakeOpts { spacing: self.bake.spacing(), seconds: Some(self.scene_dur() as f32), detail: Some(1.0), max_points: None, accurate: Some(false) };
        self.live_w.start("Live".into(), crate::bake_cli::Task { kind: crate::bake_cli::Kind::Live(tx), inp: None, scene: j, o, out: std::env::temp_dir().join("splashtank-live.splc") });
    }
    fn live_off(&mut self) {
        if !self.live { return; }
        self.live = false;
        self.live_w.stop();
        self.live_rx = None;
        self.live_pending.clear();
        self.doc.cache = None;
        self.doc.gen += 1;
    }
    /// Takes the live sim's new frames into the cache shown.
    fn live_poll(&mut self) {
        // the live worker never waits for the window to let go of a file (it writes none)
        { let mut j = self.live_w.job.lock().unwrap(); if j.finishing { j.released = true; } }
        let Some(rx) = &self.live_rx else { return; };
        self.live_pending.extend(rx.try_iter());
        let mut done = 0;
        for b in &self.live_pending {
            match &mut self.doc.cache {
                None => match Cache::from_header(b.clone()) { Ok(c) => self.doc.cache = Some(Arc::new(c)), Err(_) => {} },
                Some(c) => match Arc::get_mut(c) { Some(c) => { let _ = c.push(b); } None => break },
            }
            done += 1;
        }
        self.live_pending.drain(..done);
        // memory: like the page's live cache, at most about 2 GB of frames
        if self.doc.cache.as_ref().is_some_and(|c| c.bytes().len() > 2usize << 30) { self.live_w.stop(); self.msg = "The live sim stopped at 2 GB of frames.".into(); }
    }
    fn objs_mut(&mut self) -> Option<&mut Vec<Value>> { self.doc.scene.as_mut()?.json.get_mut("objs")?.as_array_mut() }
    fn objs(&self) -> &[Value] { self.doc.scene.as_ref().and_then(|s| s.json["objs"].as_array()).map(|v| v.as_slice()).unwrap_or(&[]) }

    fn select(&mut self, hit: Option<usize>, add: bool) {
        match (hit, add) {
            (Some(i), true) => { if let Some(k) = self.sel_set.iter().position(|&x| x == i) { self.sel_set.remove(k); self.sel = self.sel_set.last().copied(); } else { self.sel_set.push(i); self.sel = Some(i); } }
            (Some(i), false) => { self.sel_set = vec![i]; self.sel = Some(i); }
            (None, false) => { self.sel_set.clear(); self.sel = None; }
            (None, true) => {}
        }
    }

    fn start_tf(&mut self, kind: Kind, m: egui::Pos2, axis: Option<usize>, from_drag: bool) {
        if self.doc.cache.is_some() && !self.live { self.scene_view = true; }
        if self.sel_set.is_empty() { self.msg = "Click an object first.".into(); return; }
        let mut t = Tf::start(kind, self.objs(), self.sel_set.clone(), m, axis, from_drag);
        if let Some(t) = t.as_mut() {
            t.orient_local = self.orient_local;
            // what it may snap to: everything not moving (shown) and the tank; what lands: the moving objects' places
            let mut tg: [Vec<glam::Vec3>; 3] = Default::default();
            let mut sr: [Vec<glam::Vec3>; 3] = Default::default();
            for (i, o) in self.objs().iter().enumerate() {
                let p = tf::snap_places(o);
                if self.sel_set.contains(&i) { for k in 0..3 { sr[k].extend(&p[k]); } }
                else if !o["id"].as_u64().is_some_and(|id| self.doc.hidden.contains(&id)) { for k in 0..3 { tg[k].extend(&p[k]); } }
            }
            if let Some(b) = self.doc.tank() { let bp = tf::box_places(glam::Vec3::new(b.x0, b.y0, b.z0), glam::Vec3::new(b.x1, b.y1, b.z1)); for k in 0..3 { tg[k].extend(&bp[k]); } }
            t.targets = tg; t.sources = sr;
            self.edited();
        }
        self.tf = t;
    }
    fn end_tf(&mut self, keep: bool) {
        let Some(t) = self.tf.take() else { return; };
        if keep && self.auto_key {
            let (st, dur) = (self.st, self.scene_dur());
            if let Some(objs) = self.objs_mut() { for &i in &t.list { if let Some(o) = objs.get_mut(i) { let g = tf::tf_groups(o, t.kind); tf::add_key(o, st, Some(g), dur); } } }
            self.edited();
        }
        if !keep {
            if let Some(o) = self.objs_mut() { t.cancel(o); }
            self.edited();
        }
        self.tf_text.clear();
    }

    /// The tank's face arrows (the page's face handles): drawn at each face's centre pointing out; dragging one moves that face along
    /// its axis (Ctrl: steps of 0.1), the tank kept at least 0.1 across. Returns Some while a face is being dragged.
    #[allow(clippy::too_many_arguments)]
    fn face_arrows(&mut self, ui: &egui::Ui, resp: &egui::Response, view: &tf::View, m: egui::Pos2, press: Option<egui::Pos2>, ct: bool) -> Option<usize> {
        let b = self.doc.tank()?;
        let (lo, hi) = (glam::Vec3::new(b.x0, b.y0, b.z0), glam::Vec3::new(b.x1, b.y1, b.z1));
        let arrow = |k: usize, lo: glam::Vec3, hi: glam::Vec3| -> (glam::Vec3, glam::Vec3) {
            let a = k / 2;
            let mut p = (lo + hi) * 0.5;
            p[a] = if k % 2 == 0 { lo[a] } else { hi[a] };
            let mut d = glam::Vec3::ZERO; d[a] = if k % 2 == 0 { -1.0 } else { 1.0 };
            (p, d)
        };
        let seg = |k: usize| -> Option<(egui::Pos2, egui::Pos2)> {
            let (p, d) = arrow(k, lo, hi);
            let s0 = view.screen(p)?;
            let s1 = view.screen(p + d * 0.001)?;
            let dir = (s1 - s0).normalized();
            Some((s0 + dir * 8.0, s0 + dir * 46.0))
        };
        let near = |at: egui::Pos2| (0..6).filter_map(|k| { let (a, bb) = seg(k)?; let ab = bb - a; let t = ((at - a).dot(ab) / ab.length_sq().max(1e-6)).clamp(0.0, 1.0); Some(((a + ab * t).distance(at), k)) })
            .filter(|x| x.0 < 9.0).min_by(|x, y| x.0.total_cmp(&y.0)).map(|x| x.1);
        if self.face_drag.is_none() && resp.drag_started_by(egui::PointerButton::Primary) {
            if let Some(k) = press.and_then(near) { self.face_drag = Some((k, lo, hi, press.unwrap())); }
        }
        let hover = if self.face_drag.is_none() { resp.hover_pos().and_then(near) } else { None };
        if let Some((k, lo0, hi0, m0)) = self.face_drag {
            let (p, d) = arrow(k, lo0, hi0);
            let a = k / 2;
            if let (Some(t0), Some(t1)) = (tf::line_param(p, d, view.ray(m0)), tf::line_param(p, d, view.ray(m))) {
                let mv = (t1 - t0) * d[a];
                let (mut l, mut h) = (lo0, hi0);
                if k % 2 == 0 { l[a] = (lo0[a] + mv).min(hi0[a] - 0.1); if ct { l[a] = (l[a] / 0.1).round() * 0.1; } } else { h[a] = (hi0[a] + mv).max(lo0[a] + 0.1); if ct { h[a] = (h[a] / 0.1).round() * 0.1; } }
                if let Some(s) = self.doc.scene.as_mut() {
                    // the file's box is the page's min and size; the cache-less tank is the scene's box
                    s.json["box"]["min"] = serde_json::json!({ "x": l.x, "y": l.y, "z": l.z });
                    s.json["box"]["size"] = serde_json::json!({ "w": h.x - l.x, "h": h.y - l.y, "d": h.z - l.z });
                }
                self.edited();
            }
            if resp.drag_stopped() || !ui.input(|i| i.pointer.primary_down()) { self.face_drag = None; }
        }
        for k in 0..6 {
            let Some((s0, s1)) = seg(k) else { continue; };
            let on = hover == Some(k) || self.face_drag.is_some_and(|f| f.0 == k);
            let col = if on { egui::Color32::from_rgb(0xff, 0xd3, 0x4a) } else { tf::AXCOL[k / 2] };
            ui.painter().line_segment([s0, s1], egui::Stroke::new(2.5, col));
            let dv = (s1 - s0).normalized();
            let n = egui::vec2(-dv.y, dv.x) * 5.0;
            ui.painter().add(egui::Shape::convex_polygon(vec![s1 + dv * 10.0, s1 + n, s1 - n], col, egui::Stroke::NONE));
        }
        self.face_drag.map(|f| f.0)
    }

    /// The scene's length (the page's timeline length, which is also the bake's).
    fn scene_dur(&self) -> f64 { self.doc.scene.as_ref().and_then(|s| s.json.pointer("/timeline/dur").or(s.json.pointer("/bake/dur"))?.as_f64()).unwrap_or(5.0).max(0.5) }
    fn smooth(&self) -> bool { self.doc.scene.as_ref().and_then(|s| s.json.pointer("/timeline/smooth")?.as_bool()).unwrap_or(true) }
    /// Moves the scene's time; keyed objects take their pose there (the page's applyKeysAt). Not a change to the scene: nothing to save
    /// or undo (the page also keeps the pose shown in the objects' places).
    fn set_time(&mut self, t: f64) {
        self.st = ((t * tf::FPS_TL).round() / tf::FPS_TL).clamp(0.0, self.scene_dur());
        self.apply_keys();
    }
    fn apply_keys(&mut self) {
        let (st, smooth) = (self.st, self.smooth());
        let Some(objs) = self.objs_mut() else { return; };
        let mut any = false;
        for o in objs.iter_mut() { any |= tf::apply_keys(o, st, smooth); }
        if !any { return; }
        if let Some(s) = self.doc.scene.take() { let j = s.json.clone(); self.doc.scene = Some(splash_format::Scene::from_json(j).unwrap_or(s)); }
        if !self.burst { self.stable = self.doc.scene.as_ref().map(|s| s.json.clone()); }
    }
    /// I: keys every group of the selected objects at the time shown; Alt+I takes their key on that frame off.
    fn key_selected(&mut self, remove: bool) {
        if self.sel_set.is_empty() { self.msg = "Click an object first.".into(); return; }
        // over a row in the Objects tab, only that group of the object shown there (the page's I over a field)
        let row = if self.tab == Tab::Objects { crate::edit::hover_group() } else { None };
        let groups: Option<Vec<&str>> = row.map(|g| vec![g]);
        let (st, dur) = (self.st, self.scene_dur());
        let sel = match (row, self.sel) { (Some(_), Some(a)) => vec![a], _ => self.sel_set.clone() };
        let mut n = 0;
        if let Some(objs) = self.objs_mut() {
            for i in sel { if let Some(o) = objs.get_mut(i) { if remove { if tf::clear_key(o, st, groups.as_deref()) { n += 1; } } else { tf::add_key(o, st, groups.as_deref(), dur); n += 1; } } }
        }
        if let (Some(g), true) = (row, n > 0) { self.msg = format!("{} ({g})", if remove { "Key taken off" } else { "Keyed" }); if !remove { self.edited(); self.apply_keys(); return; } }
        self.msg = match (remove, n) { (true, 0) => "No key on this frame.".into(), (true, _) => format!("Key taken off at {st:.2} s"), _ => format!("Keyed at {st:.2} s") };
        if n > 0 { self.edited(); self.apply_keys(); }
    }
    /// The keys at time from (of the selected objects, or of all when none is selected) moved to time to; a key already there takes
    /// their channels.
    fn move_keys(&mut self, from: f64, to: f64) {
        if (from - to).abs() < 1e-6 { return; }
        let sel = self.sel_set.clone();
        let half = 0.5 / tf::FPS_TL;
        let Some(objs) = self.objs_mut() else { return; };
        for (i, o) in objs.iter_mut().enumerate() {
            if !sel.is_empty() && !sel.contains(&i) { continue; }
            let Some(ks) = o["keys"].as_array_mut() else { continue; };
            let Some(a) = ks.iter().position(|k| (k["t"].as_f64().unwrap_or(-1.0) - from).abs() < half) else { continue; };
            let mut k = ks.remove(a);
            k["t"] = serde_json::json!(to);
            match ks.iter_mut().find(|q| (q["t"].as_f64().unwrap_or(-1.0) - to).abs() < half) {
                Some(ex) => { if let (Some(e), Some(m)) = (ex.as_object_mut(), k.as_object()) { for (c, v) in m { if c != "t" { e.insert(c.clone(), v.clone()); } } } }
                None => ks.push(k),
            }
            ks.sort_by(|p, q| p["t"].as_f64().unwrap_or(0.0).total_cmp(&q["t"].as_f64().unwrap_or(0.0)));
        }
        self.sel_key = Some(to);
        self.msg = format!("Key moved from {from:.2} s to {to:.2} s");
        self.edited();
        self.apply_keys();
    }
    /// Delete with a key picked on the timeline: the keys at that time go.
    fn delete_keys(&mut self) {
        let Some(t) = self.sel_key.take() else { return; };
        self.key_del_now = true;
        let sel = self.sel_set.clone();
        let mut n = 0;
        if let Some(objs) = self.objs_mut() {
            for (i, o) in objs.iter_mut().enumerate() { if (sel.is_empty() || sel.contains(&i)) && tf::clear_key(o, t, None) { n += 1; } }
        }
        self.msg = format!("Removed {n} key{} at {t:.2} s", if n == 1 { "" } else { "s" });
        if n > 0 { self.edited(); self.apply_keys(); }
    }

    /// The key times of the selected objects (of all objects when none is selected), for the timeline's marks and Up/Down.
    fn key_times(&self) -> Vec<f64> {
        let objs = self.objs();
        let list: Vec<&Value> = if self.sel_set.is_empty() { objs.iter().collect() } else { self.sel_set.iter().filter_map(|&i| objs.get(i)).collect() };
        let mut t: Vec<f64> = list.iter().flat_map(|o| tf::keys(o).iter().filter_map(|k| k["t"].as_f64())).collect();
        t.sort_by(f64::total_cmp);
        t.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
        t
    }

    /// The scene's timeline (the page's): play, frames, key marks, length, Smooth or Linear between keys, Auto key, Key and Unkey.
    fn scene_timeline(&mut self, ui: &mut egui::Ui) {
        let dur = self.scene_dur();
        let frames = (dur * tf::FPS_TL).round() as usize;
        ui.horizontal(|ui| {
            let lv = ui.selectable_label(self.live, "Live water").on_hover_text("Simulate the water while you work, at the Bake tab's spacing (Preview quality), on its own copy of the solver. The frames stay in memory, so the timeline plays them back; changing the scene starts it again.");
            if lv.clicked() { if self.live { self.live_off(); } else { self.live = true; self.scene_view = false; self.live_start(); self.splay = true; } }
            if self.live {
                let (busy, n) = (self.live_w.busy(), self.frames());
                let txt = if busy { format!("simulating {n}/{} frames", frames + 1) } else if let Some((e, true)) = self.live_w.job.lock().unwrap().result.clone() { e } else { format!("{n} frames") };
                ui.label(egui::RichText::new(txt).small());
            }
            ui.separator();
            if ui.button("|<").on_hover_text("Start (Shift+Left)").clicked() { self.splay = false; self.set_time(0.0); }
            if ui.button("<").on_hover_text("One frame back (Left)").clicked() { self.splay = false; self.set_time(self.st - 1.0 / tf::FPS_TL); }
            if ui.button(if self.splay { "Pause" } else { "Play" }).on_hover_text("Play the scene's keys (Space)").clicked() { self.splay = !self.splay; }
            if ui.button(">").on_hover_text("One frame on (Right)").clicked() { self.splay = false; self.set_time(self.st + 1.0 / tf::FPS_TL); }
            if ui.button(">|").on_hover_text("End (Shift+Right)").clicked() { self.splay = false; self.set_time(dur); }
            let rec = ui.selectable_label(self.auto_key, "Auto key")
                .on_hover_text("Auto keying (Blender's record button): moving, turning or scaling an object keys it on the frame shown.");
            // kept in the scene file, as the page does (a setting of the editor, so not a change to save)
            if rec.clicked() { self.auto_key = !self.auto_key; if let Some(s) = self.doc.scene.as_mut() { s.json["timeline"]["auto"] = Value::Bool(self.auto_key); } }
            if ui.button("Key").on_hover_text("Key the selected objects on this frame (I)").clicked() { self.key_selected(false); }
            if ui.button("Unkey").on_hover_text("Take the selected objects' key on this frame off (Alt+I)").clicked() { self.key_selected(true); }
            let mut smooth = self.smooth();
            if ui.selectable_label(smooth, "Smooth").on_hover_text("Ease in and out between keys").clicked() { smooth = true; }
            if ui.selectable_label(!smooth, "Linear").on_hover_text("Straight between keys, at even speed").clicked() { smooth = false; }
            // what playing does at the end: Hold or Stop stop there, Loop goes round (timeline.end)
            let end = self.doc.scene.as_ref().and_then(|s| s.json.pointer("/timeline/end")?.as_str().map(str::to_owned)).unwrap_or_else(|| "hold".into());
            let mut e2 = end.clone();
            egui::ComboBox::from_id_salt("tlend").selected_text(match e2.as_str() { "loop" => "Loop", "stop" => "Stop", _ => "Hold" }).width(60.0).show_ui(ui, |ui| {
                for (v, n) in [("hold", "Hold"), ("stop", "Stop"), ("loop", "Loop")] { ui.selectable_value(&mut e2, v.to_string(), n); }
            }).response.on_hover_text("At the end: Hold and Stop stop there, Loop starts again");
            if e2 != end { if let Some(s) = self.doc.scene.as_mut() { s.json["timeline"]["end"] = Value::String(e2); } self.dirty = true; }
            if smooth != self.smooth() { if let Some(s) = self.doc.scene.as_mut() { s.json["timeline"]["smooth"] = Value::Bool(smooth); } self.edited(); self.apply_keys(); }
            let mut d = dur;
            if ui.add(egui::DragValue::new(&mut d).range(1.0..=60.0).speed(0.05).max_decimals(1).prefix("length ").suffix(" s")).on_hover_text("How long the scene (and its bake) is").changed() {
                let d = (d * 2.0).round() / 2.0;
                if let Some(s) = self.doc.scene.as_mut() { s.json["timeline"]["dur"] = serde_json::json!(d); s.json["bake"]["dur"] = serde_json::json!(d); }
                self.bake.set_seconds(d as f32);
                self.edited();
                if self.st > d { self.set_time(d); }
            }
            let mut f = (self.st * tf::FPS_TL).round() as usize;
            let sw = (ui.available_width() - 150.0).max(100.0);
            ui.spacing_mut().slider_width = sw;
            let r = ui.add(egui::Slider::new(&mut f, 0..=frames).text("frame"));
            if r.changed() { self.splay = false; self.set_time(f as f64 / tf::FPS_TL); }
            // key marks along the slider (the selected objects' keys, or every key when nothing is selected)
            // where egui puts the handle: along the rail (slider_width wide) inset by the handle's radius
            let rr = r.rect;
            let hr = rr.height() / 2.5;
            let (x0, y) = (rr.left() + hr, rr.center().y);
            // a mark can be clicked (picks that time: Delete removes the keys there) and dragged to another frame
            let span = sw - 2.0 * hr;
            for (i, t) in self.key_times().into_iter().enumerate() {
                let shown_t = match self.key_drag { Some((from, to)) if (from - t).abs() < 1e-6 => to, _ => t };
                let p = egui::pos2(x0 + (shown_t / dur) as f32 * span, y);
                let kr = ui.interact(egui::Rect::from_center_size(p, egui::vec2(12.0, 14.0)), ui.scope_id().with(("keymark", i)), egui::Sense::click_and_drag())
                    .on_hover_text("A key: click to pick it (Delete removes it), drag to move it");
                if kr.clicked() { self.sel_key = Some(t); self.splay = false; self.set_time(t); }
                if kr.dragged() {
                    if let Some(px) = kr.interact_pointer_pos() {
                        let nt = (((px.x - x0) / span) as f64 * dur * tf::FPS_TL).round().clamp(0.0, dur * tf::FPS_TL) / tf::FPS_TL;
                        self.key_drag = Some((t, nt));
                    }
                }
                if kr.drag_stopped() { if let Some((from, to)) = self.key_drag.take() { self.move_keys(from, to); } }
                let picked = self.sel_key.is_some_and(|k| (k - t).abs() < 1e-6) || self.key_drag.is_some_and(|d| (d.0 - t).abs() < 1e-6);
                let s = if picked { 6.5 } else { 5.0 };
                let fill = if picked { egui::Color32::WHITE } else { egui::Color32::from_rgb(0xe9, 0xc8, 0x4a) };
                ui.painter().add(egui::Shape::convex_polygon(vec![p + egui::vec2(0.0, -s), p + egui::vec2(s, 0.0), p + egui::vec2(0.0, s), p + egui::vec2(-s, 0.0)],
                    fill, egui::Stroke::new(1.0, egui::Color32::from_gray(0x20))));
            }
            ui.label(format!("{:.2} s", self.st));
        });
    }

    fn undo_redo(&mut self, redo: bool) {
        if self.tf.is_some() { return; }
        let (from, to) = if redo { (&mut self.redo, &mut self.undo) } else { (&mut self.undo, &mut self.redo) };
        let Some(j) = from.pop() else { self.msg = if redo { "Nothing to redo." } else { "Nothing to undo." }.into(); return; };
        if let Some(s) = self.doc.scene.as_mut() { to.push(std::mem::replace(&mut s.json, j)); }
        self.burst = false;
        if let Some(s) = self.doc.scene.take() { let j = s.json.clone(); self.doc.scene = Some(splash_format::Scene::from_json(j).unwrap_or(s)); }
        self.stable = self.doc.scene.as_ref().map(|s| s.json.clone());
        let n = self.objs().len();
        self.sel_set.retain(|&i| i < n);
        self.sel = self.sel.filter(|&i| i < n);
        self.dirty = true;
        self.apply_keys();
        if self.edit.as_ref().is_some_and(|e| e.obj >= n) { self.edit = None; } else if let Some(ed) = self.edit.as_mut() { ed.clear(); }
        self.msg = if redo { "Redone" } else { "Undone" }.into();
    }

    fn add_object(&mut self, shape: &str, water: bool) {
        let Some(j) = self.doc.scene.as_ref().map(|s| &s.json) else { return; };
        let o = tf::new_object(j, shape, water);
        self.msg = format!("Added {}", o["name"].as_str().unwrap_or(""));
        if let Some(v) = self.objs_mut() { v.push(o); }
        let i = self.objs().len() - 1;
        self.select(Some(i), false);
        if self.doc.cache.is_some() && !self.live { self.scene_view = true; }
        self.edited();
    }
    fn delete_selected(&mut self) {
        if self.sel_set.is_empty() { return; }
        self.edit = None;
        let mut del = self.sel_set.clone();
        del.sort_unstable();
        if let Some(v) = self.objs_mut() { for &i in del.iter().rev() { if i < v.len() { v.remove(i); } } }
        self.msg = format!("Deleted {} object{}", del.len(), if del.len() == 1 { "" } else { "s" });
        self.select(None, false);
        self.edited();
    }
    fn duplicate(&mut self, m: egui::Pos2) {
        let Some(j) = self.doc.scene.as_ref().map(|s| &s.json) else { return; };
        let fresh = tf::duplicate(j, &self.sel_set);
        if fresh.is_empty() { return; }
        let n0 = self.objs().len();
        let k = fresh.len();
        if let Some(v) = self.objs_mut() { v.extend(fresh); }
        self.sel_set = (n0..n0 + k).collect();
        self.sel = self.sel_set.last().copied();
        self.edited();
        // as in Blender, the copies follow the mouse until a click puts them down
        self.start_tf(Kind::G, m, None, false);
    }
    /// F: the selection fills the view (the whole tank when nothing is selected)
    fn focus_selected(&mut self) {
        let pts: Vec<glam::Vec3> = self.sel_set.iter().filter_map(|&i| self.objs().get(i)).flat_map(|o| { let w = tf::world_points(o); if w.is_empty() { vec![tf::pos(o) - glam::Vec3::splat(0.2), tf::pos(o) + glam::Vec3::splat(0.2)] } else { w } }).collect();
        if pts.is_empty() { self.frame_all(); return; }
        let (lo, hi) = pts.iter().fold((glam::Vec3::splat(f32::MAX), glam::Vec3::splat(f32::MIN)), |(a, b), p| (a.min(*p), b.max(*p)));
        let r = ((hi - lo).length() * 1.6).clamp(1.2, 40.0);
        self.goal = Some(Goal { target: Some((lo + hi) * 0.5), r: Some(r), theta: None, phi: None });
    }

    /// The scene editing keys (the page's): G move, R rotate, S scale, Shift+A add, Shift+D duplicate, X or Delete delete, A select all
    /// (Alt+A none), Ctrl+Z undo, Ctrl+Shift+Z or Ctrl+Y redo. While moving: X Y Z pick an axis (twice: the object's own; with Shift the
    /// plane across it), numbers type an amount, Enter or a click finishes, Esc or a right click puts things back, Ctrl snaps.
    /// While moving: X Y Z, numbers, Backspace; Some(true) for Enter, Some(false) for Esc.
    fn modal_keys(t: &mut Tf, ui: &egui::Ui) -> Option<bool> {
        let ev = ui.input(|i| i.events.clone());
        for e in &ev {
            match e {
                egui::Event::Text(s) => for c in s.chars() {
                    match c {
                        'x' | 'y' | 'z' => t.key_axis((c as u8 - b'x') as usize, false),
                        'X' | 'Y' | 'Z' => t.key_axis((c as u8 - b'X') as usize, true),
                        '0'..='9' | '.' => t.num.push(c),
                        ',' => t.num.push('.'),
                        '-' => { if t.num.starts_with('-') { t.num.remove(0); } else { t.num.insert(0, '-'); } }
                        _ => {}
                    }
                },
                egui::Event::Key { key: egui::Key::Backspace, pressed: true, .. } => { t.num.pop(); }
                _ => {}
            }
        }
        if ui.input(|i| i.key_pressed(egui::Key::Escape)) { Some(false) } else if ui.input(|i| i.key_pressed(egui::Key::Enter)) { Some(true) } else { None }
    }

    // ---------- edit mode ----------
    fn edit_obj(&self) -> Option<&Value> { self.objs().get(self.edit.as_ref()?.obj) }
    /// Tab: edit the selected shape, or leave edit mode.
    fn toggle_edit(&mut self) {
        if self.edit.is_some() { self.end_etf(true); self.edit = None; self.msg = "Object mode".into(); return; }
        let Some(i) = self.sel else { self.msg = "Click a shape first, then press Tab to edit it.".into(); return; };
        let ok = self.objs().get(i).is_some_and(|o| !tf::is_emitter(o) && o["mesh"]["v"].is_array());
        if !ok { self.msg = "Only shapes have points to edit (a source has none).".into(); return; }
        self.edit = Some(crate::editmode::Edit::new(i));
        self.msg = "Edit mode: 1 points, 2 edges, 3 faces. Click or drag a box to select, A all, G R S move, E extrude, I inset, Tab to leave.".into();
    }
    fn start_etf(&mut self, kind: Kind, m: egui::Pos2, nrm: Option<glam::Vec3>) {
        let Some(o) = self.edit_obj() else { return; };
        let verts = self.edit.as_ref().unwrap().verts(o);
        if verts.is_empty() { self.msg = "Select some points, edges or faces first.".into(); return; }
        let pts = crate::editmode::as_objects(o, &verts);
        let Some(mut t) = Tf::start(kind, &pts, (0..pts.len()).collect(), m, None, false) else { return; };
        t.nrm = nrm;
        self.edited();
        self.etf = Some((t, verts, pts));
    }
    fn end_etf(&mut self, keep: bool) {
        let Some((t, verts, mut pts)) = self.etf.take() else { return; };
        if !keep {
            t.cancel(&mut pts);
            let i = self.edit.as_ref().map(|e| e.obj);
            if let (Some(i), Some(objs)) = (i, self.objs_mut()) { if let Some(o) = objs.get_mut(i) { crate::editmode::put_back(o, &verts, &pts); } }
            self.edited();
        }
        self.tf_text.clear();
    }
    /// E (and I): the selected faces extruded, then moved out along their normal (I: shrunk towards their centre instead).
    fn extrude(&mut self, m: egui::Pos2, inset: bool) {
        let Some(ed) = self.edit.as_ref() else { return; };
        let (i, fs) = (ed.obj, self.edit_obj().map(|o| ed.sel_faces(o)).unwrap_or_default());
        if fs.is_empty() { self.msg = "Extrude and inset need faces: press 3, click a face, then E or I.".into(); return; }
        let n = self.objs_mut().and_then(|objs| crate::editmode::extrude(objs.get_mut(i)?, &fs));
        if let Some(ed) = self.edit.as_mut() { ed.clear(); ed.mode = crate::editmode::Mode::F; ed.f = fs; }
        self.edited();
        if inset { self.start_etf(Kind::S, m, None); } else { self.start_etf(Kind::G, m, n); }
    }
    fn edit_mode_keys(&mut self, ui: &egui::Ui, m: egui::Pos2) {
        if let Some((t, _, _)) = self.etf.as_mut() {
            if let Some(keep) = Self::modal_keys(t, ui) { self.end_etf(keep); }
            return;
        }
        let mods = ui.input(|i| i.modifiers);
        let k = |key| ui.input(|i| i.key_pressed(key));
        if mods.command { if k(egui::Key::Z) { self.undo_redo(mods.shift); } if k(egui::Key::Y) { self.undo_redo(true); } return; }
        use crate::editmode::Mode;
        // Tab is edit mode here, not moving the keyboard focus to the next field
        if k(egui::Key::Tab) { self.toggle_edit(); ui.ctx().memory_mut(|m| m.stop_text_input()); return; }
        let o = self.edit_obj().cloned().unwrap_or_default();
        for (key, md) in [(egui::Key::Num1, Mode::V), (egui::Key::Num2, Mode::E), (egui::Key::Num3, Mode::F)] { if k(key) { if let Some(ed) = self.edit.as_mut() { ed.set_mode(&o, md); } } }
        if k(egui::Key::G) { self.start_etf(Kind::G, m, None); }
        else if k(egui::Key::R) { self.start_etf(Kind::R, m, None); }
        else if k(egui::Key::S) { self.start_etf(Kind::S, m, None); }
        else if k(egui::Key::E) { self.extrude(m, false); }
        else if k(egui::Key::I) { self.extrude(m, true); }
        else if k(egui::Key::A) { if let Some(ed) = self.edit.as_mut() { if mods.alt { ed.clear(); } else { ed.all(&o); } } }
        else if k(egui::Key::X) || k(egui::Key::Delete) { self.msg = "Points and faces cannot be deleted because the collider has to stay closed. Move or scale them instead.".into(); }
    }
    /// The viewport in edit mode; returns whether the mouse orbits.
    #[allow(clippy::too_many_arguments)]
    fn edit_view(&mut self, ui: &egui::Ui, resp: &egui::Response, view: &tf::View, m: egui::Pos2, sh: bool, ct: bool, alt: bool) -> bool {
        let i = self.edit.as_ref().unwrap().obj;
        if let Some((mut t, verts, mut pts)) = self.etf.take() {
            self.tf_text = t.apply(&mut pts, view, m, ct);
            if let Some(o) = self.objs_mut().and_then(|v| v.get_mut(i)) { crate::editmode::put_back(o, &verts, &pts); }
            self.etf = Some((t, verts, pts));
            self.edited();
            let (pressed, right) = ui.input(|i| (i.pointer.primary_pressed(), i.pointer.secondary_pressed()));
            if right { self.end_etf(false); self.swallow = true; } else if pressed { self.end_etf(true); self.swallow = true; }
            ui.ctx().request_repaint();
            return false;
        }
        let o = self.objs().get(i).cloned().unwrap_or_default();
        let press = ui.input(|i| i.pointer.press_origin());
        if resp.drag_started_by(egui::PointerButton::Primary) && !alt { self.box_from = Some(press.unwrap_or(m)); }
        if let Some(b) = self.box_from {
            let r = egui::Rect::from_two_pos(b, m);
            ui.painter().rect(r, 0.0, egui::Color32::from_rgba_unmultiplied(120, 160, 230, 25), egui::Stroke::new(1.0, egui::Color32::from_rgb(120, 160, 230)), egui::StrokeKind::Inside);
            if resp.drag_stopped() { if let Some(ed) = self.edit.as_mut() { ed.boxed(&o, view, r, sh); } self.box_from = None; }
        }
        if resp.clicked() && !self.swallow { if let Some(ed) = self.edit.as_mut() { ed.click(&o, view, m, sh); } }
        resp.dragged_by(egui::PointerButton::Secondary) || resp.dragged_by(egui::PointerButton::Middle) || (alt && resp.dragged_by(egui::PointerButton::Primary))
    }

    fn edit_keys(&mut self, ui: &egui::Ui, m: egui::Pos2) {
        if self.edit.is_some() { self.edit_mode_keys(ui, m); return; }
        let mods = ui.input(|i| i.modifiers);
        if let Some(t) = self.tf.as_mut() {
            if let Some(keep) = Self::modal_keys(t, ui) { self.end_tf(keep); }
            return;
        }
        if ui.input(|i| i.key_pressed(egui::Key::Tab)) {
            // Shift+Tab: the snapping magnet; Tab: edit mode
            if mods.shift { self.snap_on = !self.snap_on; self.msg = format!("Snapping {}", if self.snap_on { "on" } else { "off" }); } else { self.toggle_edit(); }
            ui.ctx().memory_mut(|m| m.stop_text_input());
            return;
        }
        // H hides the selection, Alt+H shows everything again
        if ui.input(|i| i.key_pressed(egui::Key::H)) && !mods.command {
            if mods.alt { self.doc.hidden.clear(); } else { for &i in &self.sel_set.clone() { if let Some(id) = self.objs().get(i).and_then(|o| o["id"].as_u64()) { if !self.doc.hidden.contains(&id) { self.doc.hidden.push(id); } } } self.select(None, false); }
            return;
        }
        let k = |key| ui.input(|i| i.key_pressed(key));
        if mods.command {
            if k(egui::Key::Z) { self.undo_redo(mods.shift); }
            if k(egui::Key::Y) { self.undo_redo(true); }
            return;
        }
        if k(egui::Key::G) { self.start_tf(Kind::G, m, None, false); }
        else if k(egui::Key::R) { self.start_tf(Kind::R, m, None, false); }
        else if k(egui::Key::S) { self.start_tf(Kind::S, m, None, false); }
        else if k(egui::Key::A) && mods.shift { self.add_at = Some(m); }
        else if k(egui::Key::A) { if mods.alt { self.select(None, false); } else { self.sel_set = (0..self.objs().len()).collect(); self.sel = self.sel.or(self.sel_set.first().copied()); } }
        else if k(egui::Key::D) && mods.shift { self.duplicate(m); }
        else if k(egui::Key::Delete) && (self.sel_key.is_some() || self.key_del_now) { if !self.key_del_now { self.delete_keys(); } }
        else if k(egui::Key::X) || k(egui::Key::Delete) { self.delete_selected(); }
    }

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

    /// The tools at the viewport's top left (the page's tool shelf: which gizmo handles show) and, with a bake open, Scene / Bake.
    fn viewport_bar(&mut self, ui: &mut egui::Ui, rect: egui::Rect) {
        let r = egui::Rect::from_min_size(rect.min + egui::vec2(10.0, 8.0), egui::vec2(560.0, 28.0));
        ui.scope_builder(egui::UiBuilder::new().max_rect(r), |ui| {
            ui.horizontal(|ui| {
                if self.doc.cache.is_some() && self.doc.scene.is_some() && !self.live {
                    if ui.selectable_label(!self.scene_view, "Bake").on_hover_text("Show the bake").clicked() { self.scene_view = false; self.end_tf(false); }
                    if ui.selectable_label(self.scene_view, "Scene").on_hover_text("Show the scene to edit its objects (the bake stays open)").clicked() { self.scene_view = true; }
                    ui.separator();
                }
                if self.edit.is_some() {
                    ui.label(egui::RichText::new("Edit mode").strong());
                    let o = self.edit_obj().cloned().unwrap_or_default();
                    use crate::editmode::Mode;
                    for (md, name, tip) in [(Mode::V, "Points", "1"), (Mode::E, "Edges", "2"), (Mode::F, "Faces", "3")] {
                        let on = self.edit.as_ref().is_some_and(|e| e.mode == md);
                        if ui.selectable_label(on, name).on_hover_text(tip).clicked() { if let Some(ed) = self.edit.as_mut() { ed.set_mode(&o, md); } }
                    }
                    if ui.button("Extrude").on_hover_text("E: the selected faces pulled out along their normal").clicked() { self.extrude(rect.center(), false); }
                    if ui.button("Inset").on_hover_text("I: a smaller copy of the selected faces inside them").clicked() { self.extrude(rect.center(), true); }
                    if ui.button("Done").on_hover_text("Leave edit mode (Tab)").clicked() { self.toggle_edit(); }
                } else if self.editing() {
                    for (t, name, tip) in [(Tool::Select, "Select", "Click to select, drag for a box. G, R, S move, turn and scale."), (Tool::Move, "Move", "Arrows move along an axis, the ball moves freely."),
                        (Tool::Rotate, "Rotate", "Rings turn about an axis."), (Tool::Scale, "Scale", "Cubes scale along an axis."), (Tool::Transform, "Transform", "All the handles.")] {
                        if ui.selectable_label(self.tool == t, name).on_hover_text(tip).clicked() { self.tool = t; }
                    }
                    if ui.button("Add").on_hover_text("Add an object (Shift+A)").clicked() { self.add_at = Some(rect.min + egui::vec2(300.0, 40.0)); }
                    ui.separator();
                    if ui.selectable_label(self.orient_local, if self.orient_local { "Local" } else { "Global" }).on_hover_text("Which axes X, Y and Z mean when moving: the scene's (Global) or a shape's own (Local). Pressing an axis key twice switches for that move.").clicked() { self.orient_local = !self.orient_local; }
                    if ui.selectable_label(self.snap_on, "Snap").on_hover_text("Snapping while moving (Shift+Tab). Holding Ctrl flips it for the moment; holding V snaps to points whatever this says.").clicked() { self.snap_on = !self.snap_on; }
                    let names = ["Increment", "Point", "Edge centre", "Face centre"];
                    egui::ComboBox::from_id_salt("snapto").selected_text(names[self.snap_to as usize]).width(100.0).show_ui(ui, |ui| {
                        for (k, n) in names.iter().enumerate() { ui.selectable_value(&mut self.snap_to, k as u8, *n); }
                    }).response.on_hover_text("Increment: steps of 0.1 (5 degrees, 0.1 scale). Point, Edge centre, Face centre: the place nearest the mouse on other objects or the tank, and the moving place closest to it lands on it.");
                    if ui.selectable_label(self.handles, "Tank arrows").on_hover_text("Arrows on the tank's faces: drag one to move that face").clicked() { self.handles = !self.handles; }
                    if ui.button("Drop water").on_hover_text("Drop a ball of water into the tank at the time shown (the page's Drop a blob); it falls in when the scene is simulated or baked").clicked() { self.drop_water(); }
                }
            });
        });
    }

    /// Drop water (the page's Drop a blob): a ball of water 0.38 across, a little off the middle and high in the tank, added to the scene's
    /// events at the time shown.
    fn drop_water(&mut self) {
        let Some(j) = self.doc.scene.as_mut().map(|s| &mut s.json) else { return; };
        let n = |p: &str, d: f64| j.pointer(p).and_then(Value::as_f64).unwrap_or(d);
        let (w, h, d) = (n("/box/size/w", 3.0), n("/box/size/h", 2.6), n("/box/size/d", 3.0));
        let (cx, y0, cz) = (n("/box/min/x", -w / 2.0) + w / 2.0, n("/box/min/y", 0.0), n("/box/min/z", -d / 2.0) + d / 2.0);
        let k = j["events"].as_array().map_or(0, Vec::len) as f64;
        let (x, z) = (cx + (k * 2.399).sin() * 0.4f64.min(w * 0.25), cz + (k * 1.731).cos() * 0.4f64.min(d * 0.25));
        let y = y0 + (h - 0.5).clamp(0.6, 2.0);
        if !j["events"].is_array() { j["events"] = serde_json::json!([]); }
        j["events"].as_array_mut().unwrap().push(serde_json::json!({ "t": self.st, "x": x, "y": y, "z": z, "r": 0.38, "done": false }));
        self.msg = format!("A ball of water drops in at {:.2} s", self.st);
        self.edited();
    }

    /// The page's camera tools at the viewport's bottom right: frame the tank, focus the selection, the axis views, orthographic.
    fn camera_buttons(&mut self, ui: &mut egui::Ui, rect: egui::Rect) {
        let r = egui::Rect::from_min_size(egui::pos2(rect.right() - 330.0, rect.bottom() - 34.0), egui::vec2(320.0, 28.0));
        ui.scope_builder(egui::UiBuilder::new().max_rect(r), |ui| {
            ui.horizontal(|ui| {
                if ui.small_button("All").on_hover_text("Frame the tank (Home)").clicked() { self.frame_all(); }
                if ui.small_button("Focus").on_hover_text("Frame the selection (F)").clicked() { self.focus_selected(); }
                if ui.small_button("Front").on_hover_text("Numpad 1").clicked() { self.snap_view("front"); }
                if ui.small_button("Side").on_hover_text("Numpad 3").clicked() { self.snap_view("right"); }
                if ui.small_button("Top").on_hover_text("Numpad 7").clicked() { self.snap_view("top"); }
                if ui.selectable_label(self.cam.ortho, "Ortho").on_hover_text("Orthographic or perspective (numpad 5)").clicked() { self.cam.ortho = !self.cam.ortho; }
            });
        });
    }

    /// P: drawing, the live sim and the frames kept, as the page's performance overlay.
    fn perf_overlay(&mut self, ui: &egui::Ui, rect: egui::Rect, dt: f32) {
        self.slow_ms = (self.slow_ms * 0.995).max(dt * 1000.0);
        let mut lines = vec![
            format!("drawn {:.1} ms a frame ({:.0} a second), slowest lately {:.0} ms", self.frame_ms, 1000.0 / self.frame_ms.max(0.1), self.slow_ms),
            format!("frames on the GPU {} ({} MB), uploads {}", self.r.kept_frames(), self.r.kept_bytes >> 20, self.r.uploads),
        ];
        if let Some(c) = &self.doc.cache { lines.push(format!("{} frames, {} water points this frame", c.frames.len(), c.frames.get(self.t as usize).map_or(0, |f| f.water.n))); }
        for (w, name) in [(&self.live_w, "live water"), (&self.worker, "bake")] {
            let j = w.job.lock().unwrap();
            if let (true, Some(p)) = (j.busy, j.prog) { lines.push(format!("{name}: frame {}/{}, {:.0} ms a frame, {} substeps, {} points", p.f, p.frames, p.frame_ms, p.sub, p.n)); }
        }
        let txt = lines.join("\n");
        let pos = rect.left_top() + egui::vec2(12.0, 44.0);
        let galley = ui.painter().layout_no_wrap(txt, egui::FontId::monospace(12.0), egui::Color32::from_gray(0xe0));
        ui.painter().rect_filled(egui::Rect::from_min_size(pos, galley.size()).expand(6.0), 4.0, egui::Color32::from_black_alpha(170));
        ui.painter().galley(pos, galley, egui::Color32::WHITE);
        ui.ctx().request_repaint();
    }

    /// Shift+A: the page's add menu.
    fn add_menu(&mut self, ui: &mut egui::Ui) {
        let Some(at) = self.add_at else { return; };
        let mut pick = None;
        let r = egui::Area::new(ui.scope_id().with("addmenu")).fixed_pos(at).order(egui::Order::Foreground).show(ui.ctx(), |ui| {
            egui::Frame::popup(ui.style()).show(ui, |ui| {
                ui.label(egui::RichText::new("Add").strong());
                for (shape, water, name) in [("cube", false, "Cube"), ("sphere", false, "Sphere"), ("cylinder", false, "Cylinder"), ("cube", true, "Water box"), ("sphere", true, "Water ball"), ("emitter", false, "Source")] {
                    if ui.button(name).clicked() { pick = Some((shape, water)); }
                }
            });
        });
        if let Some((s, w)) = pick { self.add_at = None; self.add_object(s, w); }
        else if ui.input(|i| i.key_pressed(egui::Key::Escape)) || (ui.input(|i| i.pointer.any_pressed()) && !r.response.contains_pointer()) { self.add_at = None; }
    }

    fn top(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            let nb = ui.button("New scene").on_hover_text("Start a new scene: an empty tank, or one of the page's starting scenes");
            if nb.clicked() { self.new_menu = !self.new_menu; }
            if self.new_menu {
                let mut pick = None;
                let r = egui::Area::new(ui.scope_id().with("newmenu")).fixed_pos(nb.rect.left_bottom() + egui::vec2(0.0, 4.0)).order(egui::Order::Foreground).show(ui.ctx(), |ui| {
                    egui::Frame::popup(ui.style()).show(ui, |ui| {
                        if ui.button("Empty tank").clicked() { pick = Some("Empty tank".to_string()); }
                        ui.separator();
                        for n in scenes()["order"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                            if ui.button(n).clicked() { pick = Some(n.to_string()); }
                        }
                    });
                });
                if let Some(n) = pick { self.new_menu = false; if self.may_discard() { self.new_scene(&n); } }
                else if ui.input(|i| i.pointer.any_pressed()) && !r.response.contains_pointer() && !nb.contains_pointer() { self.new_menu = false; }
            }
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
        if self.editing() { self.scene_timeline(ui); return; }
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
            for (t, name) in [(Tab::Bake, "Bake"), (Tab::Sim, "Simulation"), (Tab::Tank, "Tank"), (Tab::Objects, "Objects"), (Tab::View, "View"), (Tab::Help, "Help")] {
                ui.selectable_value(&mut self.tab, t, name);
            }
        });
        ui.separator();
        egui::ScrollArea::vertical().show(ui, |ui| {
            let tab = self.tab;
            if tab == Tab::Help { help(ui); return; }
            if tab == Tab::Bake {
                let shown = self.path.clone().filter(|p| self.doc.cache.is_some() && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("splc")));
                let scene = self.doc.scene.as_ref().map(|s| &s.json);
                if let Some(a) = self.bake.panel(ui, &self.worker, scene, shown.as_deref()) { self.act(a); }
                return;
            }
            if matches!(tab, Tab::Sim | Tab::Tank | Tab::Objects) {
                let Some(s) = self.doc.scene.as_mut() else { ui.label("Open a scene file (.json) or a bake (.splc) to edit its scene."); return; };
                if self.doc.cache.is_some() && !self.live { ui.label(egui::RichText::new("Changes apply to the next bake; the bake shown stays as it was.").small()); }
                let changed = match tab {
                    Tab::Sim => crate::edit::settings(ui, &mut s.json, &mut self.find),
                    Tab::Tank => crate::edit::tank(ui, &mut s.json),
                    _ => {
                        let before = self.sel;
                        let mut act = None;
                        let ch = crate::edit::objects(ui, &mut s.json, &mut self.sel, self.st, &mut self.doc.hidden, &mut act);
                        if self.sel != before { self.sel_set = self.sel.into_iter().collect(); }
                        self.obj_act = act;
                        ch
                    }
                };
                if changed { self.edited(); }
                match self.obj_act.take() { Some("dup") => self.duplicate(egui::pos2(0.0, 0.0)), Some("del") => self.delete_selected(), _ => {} }
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
                // the bake report: what the bake's measurements say (the page's bakeLimits), and the whole report saved to a file
                let m = &i.meta;
                if let Some(dg) = m["diag"].as_array().filter(|d| !d.is_empty()) {
                    let sc = i.scale as f64;
                    let fastest = dg.iter().filter_map(|d| d["fastestParticle"].as_f64()).fold(0.0, f64::max) * sc;
                    let max_sub = m.pointer("/desc/maxSub").and_then(Value::as_u64).unwrap_or(u64::MAX);
                    let vmax = m.pointer("/desc/vmaxW").and_then(Value::as_f64).unwrap_or(f64::MAX) * sc;
                    let at_sub = dg.iter().filter(|d| d["sub"].as_u64().is_some_and(|s| s >= max_sub)).count();
                    let at_v = dg.iter().filter(|d| d["fastestParticle"].as_f64().is_some_and(|v| v * sc >= 0.99 * vmax)).count();
                    let most = dg.iter().filter_map(|d| d["alive"].as_u64()).max().unwrap_or(0);
                    let unsolved = dg.iter().filter_map(|d| d["unsolved"].as_f64()).fold(0.0, f64::max);
                    egui::CollapsingHeader::new("Bake report").default_open(false).show(ui, |ui| {
                        ui.label(format!("Baked in {:.0} s", m["seconds"].as_f64().unwrap_or(0.0)));
                        ui.label(format!("Fastest water {fastest:.1} m/s (limit {vmax:.0}); frames at the speed limit {at_v}, at the substep limit ({max_sub}) {at_sub}"));
                        ui.label(format!("Most particles {most}{}", m["maxN"].as_u64().map(|n| format!(" of Max points {n}")).unwrap_or_default()));
                        if unsolved > 0.0 { ui.label(format!("Pressure left unsolved at most {:.2}%", unsolved * 100.0)); }
                        if m["cancelled"] == true { ui.colored_label(egui::Color32::ORANGE, "Stopped before its end."); }
                        if ui.button("Save report...").on_hover_text("The bake's settings, its measurements for every frame and the scene, as a file to send").clicked() {
                            if let Some(p) = rfd::FileDialog::new().set_file_name("splashtank-bake-report.json").add_filter("Report", &["json"]).save_file() {
                                let mut rep = serde_json::json!({ "app": "SplashTank native bake report", "version": 1, "gpu": self.gpu, "frames": c.frames.len(), "fps": i.fps, "spacing": i.d, "scale": i.scale });
                                for k in ["desc", "diag", "scene", "seconds", "maxN", "native", "cancelled"] { if !m[k].is_null() { rep[k] = m[k].clone(); } }
                                self.msg = match std::fs::write(&p, serde_json::to_vec_pretty(&rep).unwrap_or_default()) { Ok(()) => format!("Saved {}", p.display()), Err(e) => format!("Could not save the report: {e}") };
                            }
                        }
                    });
                }
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
            ui.horizontal(|ui| {
                ui.label("Colour by").on_hover_text("Speed: blue to cyan to white as the water speeds up, churned water white. Type: one colour per kind of point: water blue, churned water pale blue, foam white, spray orange, mist lilac, bubbles green, deep water (narrow band) dark blue.");
                ui.selectable_value(&mut self.look.by_type, false, "Speed");
                ui.selectable_value(&mut self.look.by_type, true, "Type");
            });
            ui.horizontal(|ui| {
                ui.label("Bake playback").on_hover_text("Full: every look-only extra point. Smooth: drops them while playback cannot keep up. Fast: never draws them (each point once).");
                for (v, n) in [(0u8, "Full"), (1, "Smooth"), (2, "Fast")] { ui.selectable_value(&mut self.pb, v, n); }
            });
            if let Some(s) = self.doc.scene.as_mut().filter(|s| s.json.pointer("/ocean/on") == Some(&serde_json::json!(true))) {
                let mut ov = s.json.pointer("/solver/oceanView").and_then(Value::as_bool).unwrap_or(true);
                if ui.checkbox(&mut ov, "Ocean past the walls").on_hover_text("Draws the wave surface around the tank, from the same waves the water feels. Drawing only.").changed() {
                    s.json["solver"]["oceanView"] = Value::Bool(ov);
                    self.dirty = true;
                }
            }
            ui.horizontal(|ui| {
                ui.label("Background");
                for (v, n) in [(0u8, "Grey"), (1, "Light"), (2, "Black")] { ui.selectable_value(&mut self.look.bg, v, n); }
            });
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

        self.key_del_now = false;
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
            if self.editing() {
                // the scene's time: Space plays its keys, Left/Right a frame, Shift to the ends, Up/Down to the next or last key; I keys, Alt+I unkeys
                let (up, down, ki, alt) = ui.input(|i| (i.key_pressed(egui::Key::ArrowUp), i.key_pressed(egui::Key::ArrowDown), i.key_pressed(egui::Key::I), i.modifiers.alt));
                if self.tf.is_none() {
                    if space { self.splay = !self.splay; }
                    let f = 1.0 / tf::FPS_TL;
                    if left { self.splay = false; self.set_time(if shift { 0.0 } else { self.st - f }); }
                    if right { self.splay = false; let d = self.scene_dur(); self.set_time(if shift { d } else { self.st + f }); }
                    if up { if let Some(t) = self.key_times().into_iter().find(|&t| t > self.st + 1e-6) { self.splay = false; self.set_time(t); } }
                    if down { if let Some(t) = self.key_times().into_iter().rev().find(|&t| t < self.st - 1e-6) { self.splay = false; self.set_time(t); } }
                    if ki && !ctrl && self.edit.is_none() { self.key_selected(alt); }
                    // Delete with a key picked on the timeline, wherever the mouse is
                    if ui.input(|i| i.key_pressed(egui::Key::Delete)) && self.sel_key.is_some() && self.edit.is_none() { self.delete_keys(); }
                }
            } else {
            if space && n > 0 { self.bake.follow = false; self.playing = !self.playing; }
            if (left || right) && shift { self.bake.follow = false; }
            if left { if shift { self.playing = false; self.t = 0.0; } else { self.step(-1.0); } }
            if right { if shift { if n > 0 { self.playing = false; self.t = (n - 1) as f64; } } else { self.step(1.0); } }
            }
            if home { self.frame_all(); }
            if kf { if self.editing() { self.focus_selected(); } else { self.frame_all(); } }
            // while moving, number keys type an amount instead; in edit mode 1 2 3 pick points, edges, faces
            if self.tf.is_none() && self.etf.is_none() && self.edit.is_none() {
                if k1 { self.snap_view(if ctrl { "back" } else { "front" }); }
                if k3 { self.snap_view(if ctrl { "left" } else { "right" }); }
                if k7 { self.snap_view(if ctrl { "bottom" } else { "top" }); }
                if k5 { self.cam.ortho = !self.cam.ortho; }
                if ui.input(|i| i.key_pressed(egui::Key::P)) { self.perf = !self.perf; }
            }
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
        self.doc.selected = if self.editing() { self.sel_set.iter().filter_map(|&k| self.objs().get(k)?["id"].as_u64()).collect() } else { Vec::new() };
        if self.playing { self.scene_view = false; }
        if self.splay && self.editing() && self.tf.is_none() {
            // the scene plays its keys, round and round
            let d = self.scene_dur();
            let t = self.st + dt.min(0.1) as f64;
            let looping = self.doc.scene.as_ref().and_then(|s| s.json.pointer("/timeline/end")?.as_str()) == Some("loop") || self.live;
            self.st = if t > d { if looping { 0.0 } else { self.splay = false; d } } else { t };
            self.apply_keys();
            ui.ctx().request_repaint();
        } else if !self.editing() { self.splay = false; }
        // a change that has ended (nothing changed this frame, no move going on): the scene now at rest is what undo goes back to
        if self.burst && !self.changed_now && self.tf.is_none() { self.stable = self.doc.scene.as_ref().map(|s| s.json.clone()); self.burst = false; }
        // the live sim starts again once a change has ended (not on every step of a drag)
        if self.live && self.live_stale && !self.burst && self.tf.is_none() { self.live_start(); }
        if self.live {
            self.live_poll();
            let n = self.frames();
            let busy = self.live_w.busy();
            if n > 0 {
                // while it computes, playing follows the newest frame (the page's live view); afterwards it plays the frames round and round
                let newest = (n - 1) as f64 / self.fps() as f64;
                if busy && self.st > newest { self.st = newest; }
                self.t = (self.st * self.fps() as f64).floor().min((n - 1) as f64);
            }
            if busy { ui.ctx().request_repaint(); }
        }
        self.look.scene_objs = self.live;
        self.changed_now = false;
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
            // the scene view leaves the bake out of the picture (it stays open)
            let hidden = if self.scene_view && !self.live { self.doc.cache.take() } else { None };
            // what this frame draws with: the time shown, and Bake playback's lighter look when asked for or when playing falls behind
            let mut lk = self.look;
            lk.time = if self.doc.cache.is_some() && !self.live && !self.scene_view { (self.t / self.fps() as f64) as f32 } else { self.st as f32 };
            if self.pb == 2 || (self.pb == 1 && (self.playing || self.splay) && self.frame_ms > 30.0) { lk.detail = 0; lk.spr_detail = lk.spr_detail.min(1); }
            self.r.draw(&rs.device, &rs.queue, &mut enc, &t.color.create_view(&Default::default()), size, &self.cam, &self.doc, f, fb, w, &lk);
            if hidden.is_some() { self.doc.cache = hidden; }
            rs.queue.submit([enc.finish()]);
            let resp = ui.add(egui::Image::new(egui::load::SizedTexture::new(t.id, avail)).sense(egui::Sense::click_and_drag()));
            let rect = resp.rect;
            let editing = self.editing();
            let m = ui.input(|i| i.pointer.latest_pos()).unwrap_or(rect.center());
            let (sh, ct, alt) = ui.input(|i| (i.modifiers.shift, i.modifiers.command, i.modifiers.alt));
            let view = tf::View::new(&self.cam, rect);
            if editing && !typing && self.add_at.is_none() && (resp.hovered() || self.tf.is_some()) { self.edit_keys(ui, m); }
            let mut orbiting = !editing;
            if editing && self.edit.is_some() {
                orbiting = self.edit_view(ui, &resp, &view, m, sh, ct, alt);
                if let (Some(ed), Some(o)) = (&self.edit, self.edit_obj()) { ed.draw(&ui.painter().with_clip_rect(rect), o, &view); }
            } else if editing {
                if let Some(mut t) = self.tf.take() {
                    // moving: follow the mouse; a click (or letting go of a handle) finishes, a right click puts things back
                    // snapping: the magnet flipped by Ctrl, or V held for points
                    let vk = ui.input(|i| i.key_down(egui::Key::V));
                    t.snap_mode = if vk { 1 } else { self.snap_to };
                    if ui.input(|i| i.pointer.button_pressed(egui::PointerButton::Middle)) { t.mid_axis(&view, m); }
                    let on = vk || (self.snap_on != ct);
                    if let Some(o) = self.objs_mut() { self.tf_text = t.apply(o, &view, m, on); }
                    if let Some(p) = t.snapped.and_then(|p| view.screen(p)) { ui.painter().circle_stroke(p, 9.0, egui::Stroke::new(2.0, egui::Color32::from_rgb(0xff, 0xd3, 0x4a))); }
                    self.tf = Some(t);
                    self.edited();
                    let (pressed, released, right) = ui.input(|i| (i.pointer.primary_pressed(), i.pointer.primary_released(), i.pointer.secondary_pressed()));
                    let from_drag = self.tf.as_ref().is_some_and(|t| t.from_drag);
                    if right { self.end_tf(false); self.swallow = true; } else if (from_drag && released) || (!from_drag && pressed) { self.end_tf(true); self.swallow = true; }
                    ui.ctx().request_repaint();
                } else {
                    let giz = (self.tool != Tool::Select).then(|| tf::gizmo(self.objs(), &self.sel_set, &view, self.orient_local)).flatten();
                    self.hover = giz.as_ref().and_then(|g| resp.hover_pos().and_then(|p| tf::pick_gizmo(g, &view, self.tool, p)));
                    let press = ui.input(|i| i.pointer.press_origin()).filter(|p| rect.contains(*p));
                    // the tank's face arrows: drag a face to move it
                    if self.handles { self.face_arrows(ui, &resp, &view, m, press, ct); }
                    if resp.drag_started_by(egui::PointerButton::Primary) && !alt && self.face_drag.is_none() {
                        let at = press.unwrap_or(m);
                        match giz.as_ref().and_then(|g| tf::pick_gizmo(g, &view, self.tool, at)) {
                            Some(part) => self.start_tf(part.kind, at, part.axis, true),
                            // dragging never moves things: it draws a selection box (move with G or the gizmo)
                            None => self.box_from = Some(at),
                        }
                    }
                    if let Some(b) = self.box_from {
                        let r = egui::Rect::from_two_pos(b, m);
                        ui.painter().rect(r, 0.0, egui::Color32::from_rgba_unmultiplied(120, 160, 230, 25), egui::Stroke::new(1.0, egui::Color32::from_rgb(120, 160, 230)), egui::StrokeKind::Inside);
                        if resp.drag_stopped() {
                            let hits = tf::in_box(self.objs(), &view, r, &self.doc.hidden);
                            if !sh { self.sel_set.clear(); }
                            for i in hits { if !self.sel_set.contains(&i) { self.sel_set.push(i); } }
                            self.sel = self.sel_set.last().copied();
                            self.box_from = None;
                        }
                    }
                    if resp.clicked() && self.add_at.is_none() && !self.swallow { let hit = tf::pick(self.objs(), &view, m, &self.doc.hidden); self.select(hit, sh); }
                    if resp.double_clicked() { let hit = tf::pick(self.objs(), &view, m, &self.doc.hidden); if hit.is_some() { self.select(hit, false); self.focus_selected(); } else { self.frame_all(); } }
                    if let Some(g) = &giz { tf::draw_gizmo(ui.painter(), g, &view, self.tool, self.hover); }
                    // the middle or right button (or Alt with the left) orbits, as on the page
                    orbiting = resp.dragged_by(egui::PointerButton::Secondary) || resp.dragged_by(egui::PointerButton::Middle) || (alt && resp.dragged_by(egui::PointerButton::Primary));
                }
            } else if resp.double_clicked() { self.frame_all(); }
            if ui.input(|i| i.pointer.any_released()) && self.tf.is_none() { self.swallow = false; }
            // the page's mouse in a bake's view: any button orbits, with Shift it pans, with Ctrl it zooms; the wheel zooms
            let d = resp.drag_delta();
            if orbiting && resp.dragged() && d != egui::Vec2::ZERO && self.tf.is_none() {
                self.goal = None;
                if sh { self.cam.pan(d.x, d.y); } else if ct { self.cam.zoom(d.y * 10.0); } else { self.cam.orbit(d.x, d.y); }
            }
            if resp.hovered() {
                let s = ui.input(|i| i.smooth_scroll_delta.y);
                if s != 0.0 { self.goal = None; self.cam.zoom(-s * 2.0); }
            }
            self.axis_widget(ui, rect);
            self.viewport_bar(ui, rect);
            self.camera_buttons(ui, rect);
            if self.perf { self.perf_overlay(ui, rect, dt); }
            if !self.tf_text.is_empty() {
                let help = "X Y Z: axis (twice: its own axes, Shift: across) · type a number · Ctrl: snap · click or Enter: done · Esc or right click: cancel";
                ui.painter().text(rect.left_bottom() + egui::vec2(12.0, -30.0), egui::Align2::LEFT_BOTTOM, &self.tf_text, egui::FontId::proportional(15.0), egui::Color32::WHITE);
                ui.painter().text(rect.left_bottom() + egui::vec2(12.0, -10.0), egui::Align2::LEFT_BOTTOM, help, egui::FontId::proportional(12.0), egui::Color32::from_gray(0xb0));
            }
            self.add_menu(ui);
        });
    }
}
