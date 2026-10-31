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
                // the window draws on the same graphics API the solver runs on (Vulkan here)
                instance_descriptor: wgpu::InstanceDescriptor { backends: splash_sim::gpu::preferred_backends(), ..wgpu::InstanceDescriptor::new_without_display_handle() },
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
        crate::bakeui::clean_folder(&app.bake.folder);
        app.load_look();
        let back = app.offer_recovery();
        for f in &files { app.open(f); }
        // like the page: a scene to start from, with live water on
        if files.is_empty() && !back { app.new_scene("Wave tank"); app.msg = "The Wave tank, with live water. File > New scene for another, or drop a scene or bake on the window.".into(); }
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
        "I keys the selection at the playhead (over a row in the Object tab: only that row), Alt + I takes the key off; click a key mark to pick it, drag it to move it, Delete removes it",
        "Tab edits the shape of a collider: 1 points, 2 edges, 3 faces, E extrude, I inset, Tab to leave",
        "Ctrl + Z undo, Ctrl + Shift + Z or Ctrl + Y redo, Ctrl + S save the scene",
        "Simulate ahead (top bar): off, the water simulates only while you play; on, it simulates the whole timeline after each change. Refresh water starts it again from the beginning",
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

/// Icons drawn with the painter (the default fonts have none of these symbols; the page draws them as SVG).
#[derive(Clone, Copy, PartialEq)]
enum Ico { Rewind, PrevKey, PrevFrame, Play, Pause, NextFrame, NextKey, Down, Up, Dot, Tank, Cube, Source, Water, Sim, Eye, EyeOff }

fn paint_icon(p: &egui::Painter, r: egui::Rect, ico: Ico, col: egui::Color32) {
    let c = r.center();
    let s = r.height().min(r.width()) * 0.32;
    let tri = |dir: f32, x: f32| -> egui::Shape { egui::Shape::convex_polygon(vec![egui::pos2(x + dir * s, c.y), egui::pos2(x - dir * s * 0.7, c.y - s), egui::pos2(x - dir * s * 0.7, c.y + s)], col, egui::Stroke::NONE) };
    let bar = |x: f32| egui::Shape::rect_filled(egui::Rect::from_center_size(egui::pos2(x, c.y), egui::vec2(s * 0.35, s * 2.0)), 0.0, col);
    let dia = |x: f32, k: f32| egui::Shape::convex_polygon(vec![egui::pos2(x, c.y - s * k), egui::pos2(x + s * k, c.y), egui::pos2(x, c.y + s * k), egui::pos2(x - s * k, c.y)], col, egui::Stroke::NONE);
    let st = egui::Stroke::new(1.4, col);
    match ico {
        Ico::Rewind => { p.add(bar(c.x - s * 1.1)); p.add(tri(-1.0, c.x - s * 0.1)); p.add(tri(-1.0, c.x + s * 0.9)); }
        Ico::PrevKey => { p.add(dia(c.x - s * 0.8, 0.6)); p.add(tri(-1.0, c.x + s * 0.7)); }
        Ico::PrevFrame => { p.add(bar(c.x - s * 0.7)); p.add(tri(-1.0, c.x + s * 0.3)); }
        Ico::Play => { p.add(tri(1.0, c.x + s * 0.2)); }
        Ico::Pause => { p.add(bar(c.x - s * 0.4)); p.add(bar(c.x + s * 0.4)); }
        Ico::NextFrame => { p.add(tri(1.0, c.x - s * 0.3)); p.add(bar(c.x + s * 0.7)); }
        Ico::NextKey => { p.add(tri(1.0, c.x - s * 0.7)); p.add(dia(c.x + s * 0.8, 0.6)); }
        Ico::Down => { p.line_segment([egui::pos2(c.x - s, c.y - s * 0.4), egui::pos2(c.x, c.y + s * 0.5)], st); p.line_segment([egui::pos2(c.x, c.y + s * 0.5), egui::pos2(c.x + s, c.y - s * 0.4)], st); }
        Ico::Up => { p.line_segment([egui::pos2(c.x - s, c.y + s * 0.4), egui::pos2(c.x, c.y - s * 0.5)], st); p.line_segment([egui::pos2(c.x, c.y - s * 0.5), egui::pos2(c.x + s, c.y + s * 0.4)], st); }
        Ico::Dot => { p.circle_filled(c, s * 0.7, col); }
        Ico::Tank => { let k = s * 1.1; p.add(egui::Shape::closed_line(vec![egui::pos2(c.x - k, c.y - k * 0.4), egui::pos2(c.x, c.y - k), egui::pos2(c.x + k, c.y - k * 0.4), egui::pos2(c.x + k, c.y + k * 0.4), egui::pos2(c.x, c.y + k), egui::pos2(c.x - k, c.y + k * 0.4)], st)); }
        Ico::Cube => { p.rect_stroke(egui::Rect::from_center_size(c, egui::vec2(s * 1.8, s * 1.8)), 1.0, st, egui::StrokeKind::Middle); }
        Ico::Source => { p.circle_stroke(c, s * 0.9, st); p.circle_filled(c, s * 0.35, col); }
        Ico::Water => { p.add(egui::Shape::convex_polygon(vec![egui::pos2(c.x, c.y - s * 1.2), egui::pos2(c.x + s * 0.8, c.y + s * 0.2), egui::pos2(c.x, c.y + s), egui::pos2(c.x - s * 0.8, c.y + s * 0.2)], col, egui::Stroke::NONE)); }
        Ico::Sim => { for (dx, dy) in [(-0.8, 0.4), (0.0, -0.5), (0.8, 0.3)] { p.circle_filled(egui::pos2(c.x + dx * s, c.y + dy * s), s * 0.32, col); } }
        Ico::Eye | Ico::EyeOff => {
            let pts: Vec<egui::Pos2> = (0..=16).map(|i| { let a = i as f32 / 16.0 * std::f32::consts::TAU; egui::pos2(c.x + a.cos() * s * 1.2, c.y + a.sin() * s * 0.6) }).collect();
            p.add(egui::Shape::closed_line(pts, st));
            if ico == Ico::Eye { p.circle_filled(c, s * 0.35, col); } else { p.line_segment([egui::pos2(c.x - s * 1.2, c.y + s * 0.8), egui::pos2(c.x + s * 1.2, c.y - s * 0.8)], st); }
        }
    }
}

/// A small button showing an icon (the page's .ib buttons).
fn icon_btn(ui: &mut egui::Ui, ico: Ico, on: bool) -> egui::Response {
    let (r, resp) = ui.allocate_exact_size(egui::vec2(26.0, 22.0), egui::Sense::click());
    let v = ui.style().interact_selectable(&resp, on);
    ui.painter().rect_filled(r, 3.0, if on { ui.visuals().selection.bg_fill } else { v.weak_bg_fill });
    paint_icon(ui.painter(), r, ico, v.fg_stroke.color);
    resp
}

/// An icon in the line of text (outliner rows).
fn icon_at(ui: &mut egui::Ui, ico: Ico, col: egui::Color32) {
    let (r, _) = ui.allocate_exact_size(egui::vec2(14.0, 16.0), egui::Sense::hover());
    paint_icon(ui.painter(), r, ico, col);
}

/// Where the camera is moving to (the page's goCam): framing and the axis views ease there.
#[derive(Clone, Copy)]
struct Goal { target: Option<glam::Vec3>, r: Option<f32>, theta: Option<f32>, phi: Option<f32> }

struct Target { size: [u32; 2], color: wgpu::Texture, id: egui::TextureId }

/// The property tabs under the outliner (the page's: Scene, Object, Simulation, Bake, Display, Performance, Help).
#[derive(Clone, Copy, PartialEq)]
enum Tab { Scene, Object, Sim, Bake, Display, Perf, Help }
const TABS: [(Tab, &str, &str); 7] = [(Tab::Scene, "Scene", "The tank, saving and loading"), (Tab::Object, "Object", "The selected object and recorded motion"),
    (Tab::Sim, "Simulation", "The solver, whitewater, narrow band and ocean"), (Tab::Bake, "Bake", "Bake and cache (switches to the Bake workspace)"),
    (Tab::Display, "Display", "How the water is drawn"), (Tab::Perf, "Performance", "Benchmark, the cache shown, the GPU"), (Tab::Help, "Help", "Hotkeys")];

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
    /// the page's workspaces: Live (edit the scene, live water) or Bake (the bake shown); the cache of the other one is kept aside here
    ws_bake: bool,
    aside: Option<Arc<Cache>>,
    /// the timeline's key tracks shown (the page's collapse button)
    kf_open: bool,
    /// the shown bake changed or the scene changed since it was baked (the pipeline's Water step goes orange)
    bake_stale: bool,
    /// a bake being moved to where Save bake put it: done (Ok: the new path) or failed, from a copying thread
    saving: Option<mpsc::Receiver<Result<PathBuf, String>>>,
    /// the temporary bake shown when a task started: deleted once the task's own bake exists (a new bake replaces the old one)
    replaced: Option<PathBuf>,
    /// undo: the scene before each change; stable is the scene at rest, burst says a change is going on (a drag, a G move)
    undo: Vec<Value>,
    redo: Vec<Value>,
    stable: Option<Value>,
    burst: bool,
    changed_now: bool,
    hover: Option<tf::Part>,
    add_at: Option<egui::Pos2>,
    box_from: Option<egui::Pos2>,
    /// the Simulation tab's search text, and a button in the Objects tab asking for something done to the selection
    find: String,
    obj_act: Option<&'static str>,
    /// the scene's time (seconds) on its timeline, and whether the scene plays (its keyed objects move)
    st: f64,
    splay: bool,
    /// Blender's record button: changing an object keys what changed
    auto_key: bool,
    /// recording motion (the page's Record object motion): on, and per object id the frame it started (60 a second) and x y z yaw a frame
    rec_on: bool,
    rec_buf: std::collections::HashMap<u64, (i64, Vec<f64>)>,
    /// Bake playback: 0 Full, 1 Smooth (drops the look-only extras while playback falls behind), 2 Fast
    pb: u8,
    /// a key picked on the timeline (its object, None: every object's, and time; Delete removes it), and a key being dragged (object, from, to)
    sel_key: Option<(Option<usize>, f64)>,
    key_drag: Option<(Option<usize>, f64, f64)>,
    /// Delete already removed a picked key this frame (so it does not also delete the selected objects)
    key_del_now: bool,
    /// the live sim: on, its own worker (its own GPU device), the frames coming in, and whether the scene changed since it started
    live: bool,
    live_w: Worker,
    live_rx: Option<mpsc::Receiver<Vec<u8>>>,
    live_pending: Vec<Vec<u8>>,
    live_stale: bool,
    /// Simulate ahead: live water simulates and caches the whole timeline by itself after a change. Off (the default): only while playing
    ahead: bool,
    /// live water was started for this scene, the frames shown are the old run's until the new one's first frame, when the scene last changed
    live_tried: bool,
    live_fresh: bool,
    last_change: Instant,
    /// any input lately (uploading kept frames waits for a quiet moment)
    last_input: Instant,
    /// counts every change to the scene (the Bake tab's estimate follows it), numbers for the caches' frames on the GPU
    scene_rev: u64,
    gens: u64,
    aside_gen: u64,
    /// the bake being written is reopened on a thread, at most twice a second: its index takes long to read on the window's thread
    follow_rx: Option<mpsc::Receiver<(PathBuf, Option<Cache>)>>,
    follow_at: Instant,
    /// SPLASH_TRACE: slow frames are written to a file
    trace: bool,
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
    /// the frame shown of the cache shown, from the timeline's time st (fractional while playing: the water blends to the next frame)
    t: f64,
    look: Look,
    msg: String,
    gpu: String,
    last: Instant,
    frame_ms: f32,
    /// the performance overlay (P): shown, and the slowest frame lately
    perf: bool,
    /// the solver benchmark: its result, from when, how many steps
    bench: Arc<std::sync::Mutex<Option<splash_sim::bake::Bench>>>,
    bench_at: f32,
    bench_steps: u32,
    slow_ms: f32,
    /// frames to read ahead from disk (the loader thread touches their pages so uploads do not wait for the disk)
    readahead: mpsc::Sender<(Arc<Cache>, Vec<usize>)>,
    /// the file opened last
    path: Option<PathBuf>,
    bake: BakeUi,
    worker: Worker,
    /// frames of the cache being written already shown, and whether a task was running at the last redraw
    seen: u32,
    was_busy: bool,
    autobake: Option<PathBuf>,
    autosaved: Instant,
    ctx_attention: bool,
}

/// Where the scene is kept every minute while it has unsaved changes. Gone after a save or a normal close, so finding it at start-up means a crash.
fn autosave_path() -> Option<PathBuf> { std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("SplashTank").join("autosave.json")) }
fn forget_autosave() { if let Some(p) = autosave_path() { let _ = std::fs::remove_file(p); } }
/// The file goes to the top of File > Open recent. Temporary bakes are not worth listing.
fn remember_file(p: &Path) {
    if autosave_path().as_deref() == Some(p) { return; }
    if p.ancestors().any(|a| a.file_name().is_some_and(|n| n == "SplashTank bakes" || n == "Bakes")) && !p.ancestors().any(|a| a.file_name().is_some_and(|n| n == "Queued bakes")) { return; }
    let f = p.display().to_string();
    let mut v: Vec<serde_json::Value> = crate::bakeui::setting("recent").and_then(|v| v.as_array().cloned()).unwrap_or_default();
    v.retain(|x| x.as_str() != Some(&f));
    v.insert(0, serde_json::json!(f));
    v.truncate(10);
    crate::bakeui::set_setting("recent", serde_json::Value::Array(v));
}

impl App {
    fn new(rs: &egui_wgpu::RenderState, ctx: egui::Context) -> App {
        let (tx, rx) = mpsc::channel::<(Arc<Cache>, Vec<usize>)>();
        std::thread::spawn(move || {
            let mut sum = 0u64;
            while let Ok((c, frames)) = rx.recv() {
                for f in frames {
                    let Some(fr) = c.frames.get(f) else { continue; };
                    if c.packed() { c.view(f); continue; }
                    let end = fr.ww.as_ref().map(|w| w.pk.end).into_iter().chain(fr.deep.as_ref().map(|d| d.spd.end)).fold(fr.water.spd.end, usize::max);
                    let b = c.bytes();
                    for i in (fr.objs.start..end.min(b.len())).step_by(4096) { sum = sum.wrapping_add(b[i] as u64); }
                }
            }
            std::hint::black_box(sum);
        });
        App {
            doc: Doc::default(), tab: Tab::Object, scene_path: None, dirty: false, sel: None, r: Renderer::new(&rs.device), target: None,
            ws_bake: false, aside: None, kf_open: true, bake_stale: false, saving: None, replaced: None,
            sel_set: Vec::new(), tool: Tool::Select, tf: None, tf_text: String::new(), undo: Vec::new(), redo: Vec::new(), stable: None, burst: false,
            changed_now: false, hover: None, add_at: None, box_from: None, find: String::new(), obj_act: None, edit: None, etf: None, orient_local: false, snap_on: false, snap_to: 0, handles: true, face_drag: None, st: 0.0, splay: false, auto_key: false, rec_on: false, rec_buf: std::collections::HashMap::new(), pb: 1, sel_key: None, key_drag: None, key_del_now: false,
            live: false, live_w: Worker::new(ctx.clone()), live_rx: None, live_pending: Vec::new(), live_stale: false, ahead: crate::bakeui::setting("simAhead").and_then(|v| v.as_bool()).unwrap_or(false), live_tried: false, live_fresh: false, last_change: Instant::now(), last_input: Instant::now(), follow_rx: None, follow_at: Instant::now(), scene_rev: 0, gens: 1, aside_gen: 1, trace: std::env::var("SPLASH_TRACE").is_ok(), swallow: false,
            cam: Orbit { target: glam::Vec3::new(0.0, 0.7, 0.0), theta: 0.8, phi: 1.0, r: 6.2, ortho: false }, goal: None,
            t: 0.0, look: Look::default(),
            msg: "Open a bake cache (.splc) or a scene file (.json), or drop one on the window.".into(),
            gpu: crate::gpu::describe(&rs.adapter, &rs.device), last: Instant::now(), frame_ms: 0.0, perf: false, bench: Arc::new(std::sync::Mutex::new(None)), bench_at: 2.5, bench_steps: 60, slow_ms: 0.0, readahead: tx,
            path: None, bake: BakeUi::default(), worker: Worker::new(ctx.clone()), seen: 0, was_busy: false, autobake: None, autosaved: Instant::now(), ctx_attention: false,
        }
    }

    /// Asks before unsaved scene edits or an unsaved bake are thrown away; true to go ahead. A bake in the bake folder is temporary: going
    /// ahead deletes it (File > Save bake keeps one).
    fn may_discard(&mut self) -> bool {
        let bake = self.bake_unsaved() && !self.worker.busy();
        if !self.dirty && !bake { return true; }
        let what = match (self.dirty, bake) {
            (true, true) => "The scene has changes that are not saved, and the bake is not saved (it will be deleted; File > Save bake keeps it).",
            (true, false) => "The scene has changes that are not saved.",
            _ => "The bake is not saved: it will be deleted (File > Save bake keeps it).",
        };
        let yes = rfd::MessageDialog::new().set_title("SplashTank").set_level(rfd::MessageLevel::Warning)
            .set_description(format!("{what} Go on?")).set_buttons(rfd::MessageButtons::YesNo).show() == rfd::MessageDialogResult::Yes;
        if yes && bake { if let Some(p) = self.path.clone() { self.drop_temp(&p); } }
        yes
    }
    /// Deletes a temporary bake (in the bake folder) and its checkpoint, letting go of it first if it is shown.
    fn drop_temp(&mut self, p: &Path) {
        if !self.bake.in_folder(p) { return; }
        self.close_if(p);
        let _ = std::fs::remove_file(p);
        let _ = std::fs::remove_file(splash_sim::bake::checkpoint_path(p));
        if self.path.as_deref() == Some(p) { self.path = None; }
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
            Ok(()) => { self.msg = format!("Saved the scene as {}", p.display()); remember_file(&p); forget_autosave(); self.bake.saved_as(&p); self.scene_path = Some(p); self.dirty = false; }
            Err(e) => self.msg = format!("Could not save {}: {e}", p.display()),
        }
    }

    /// After an edit to the scene's JSON: the parsed scene (tank, objects) is made again from it.
    fn edited(&mut self) { self.touch(true); }
    /// As edited, when only objects' places changed (a move, every frame of it).
    fn posed(&mut self) { self.touch(false); }
    fn touch(&mut self, meshes: bool) {
        // nothing is simulated while editing: the water's frames stay, marked out of date, and the sim stops at once
        self.live_stale = true;
        self.last_change = Instant::now();
        self.scene_rev += 1;
        if self.bake_cache().is_some() { self.bake_stale = true; }
        if self.live_w.busy() { self.live_w.stop(); self.live_rx = None; self.live_pending.clear(); }
        // the first change of a burst saves the scene before it for undo
        if !self.burst { if let Some(s) = self.stable.take() { self.undo.push(s); if self.undo.len() > 100 { self.undo.remove(0); } } self.redo.clear(); self.burst = true; }
        self.changed_now = true;
        if let Some(s) = self.doc.scene.as_mut() { s.refresh(meshes); }
        self.dirty = true;
    }

    /// A cache has gone: its frames leave the GPU. shown: the one in doc.cache, else the one kept aside.
    fn bump(&mut self, shown: bool) {
        self.gens += 1;
        let (old, n) = if shown { (std::mem::replace(&mut self.doc.gen, self.gens), self.gens) } else { (std::mem::replace(&mut self.aside_gen, self.gens), self.gens) };
        let _ = n;
        self.r.forget(old);
    }

    /// Play or pause. Water out of date simulates again from the start now: this is when the work is wanted.
    fn play(&mut self) {
        self.bake.follow = false;
        self.splay = !self.splay;
        if !self.splay { return; }
        if self.st >= self.tl_dur() - 1e-6 { self.set_time(0.0); }
        if !self.ws_bake && self.live && self.live_stale && !self.worker.busy() { self.set_time(0.0); self.live_start(); }
    }

    /// Refresh: the water from nothing, at the start (whatever state it got into).
    fn refresh_water(&mut self) {
        if self.doc.scene.is_none() { return; }
        self.set_ws(false);
        self.live_w.stop();
        self.live_rx = None; self.live_pending.clear();
        *self.live_slot() = None;
        self.bump(!self.ws_bake);
        self.live = true;
        self.splay = false;
        self.set_time(0.0);
        self.live_start();
        self.msg = "Water refreshed from the start.".into();
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
        self.aside = None;
        self.ws_bake = false;
        self.bump(true); self.bump(false);
        self.path = None;
        self.scene_path = None;
        self.dirty = false;
        self.sel = None; self.sel_set.clear();
        self.undo.clear(); self.redo.clear(); self.burst = false;
        self.stable = Some(j.clone());
        self.bake.source_scene(name, &j);
        if let Some(b) = self.doc.tank() { self.cam = Orbit::frame(&b); self.goal = None; }
        self.tab = Tab::Object;
        self.splay = false;
        self.auto_key = false;
        self.set_time(0.0);
        self.msg = format!("New scene: {name}. Add objects with Shift+A, fill the tank in the Scene tab, save it with Ctrl+S.");
        self.scene_rev += 1;
        self.live = true; self.live_tried = false; self.live_stale = false;
    }

    fn open(&mut self, path: &Path) {
        let same = self.path.as_deref() == Some(path);
        let is_json = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("json"));
        // the live water belongs to the scene shown: it goes with it
        self.live_w.stop(); self.live_rx = None; self.live_pending.clear();
        self.aside = None;
        let g0 = self.doc.gen;
        let r = crate::open_into(&mut self.doc, path);
        self.doc.gen = g0;
        match r {
            Ok(m) => {
                self.bump(true); self.bump(false);
                self.scene_rev += 1;
                self.msg = m;
                if !same { if let Some(b) = self.doc.tank() { self.cam = Orbit::frame(&b); self.goal = None; } }
                self.path = Some(path.to_owned());
                remember_file(path);
                self.bake.source(path);
                self.scene_path = is_json.then(|| path.to_owned());
                self.dirty = false;
                if !same { self.sel = None; self.sel_set.clear(); }
                self.edit = None; self.etf = None;
                self.undo.clear(); self.redo.clear(); self.burst = false;
                self.stable = self.doc.scene.as_ref().map(|s| s.json.clone());
                self.splay = false;
                self.auto_key = self.doc.scene.as_ref().and_then(|s| s.json.pointer("/timeline/auto")?.as_bool()).unwrap_or(false);
                // a bake opens in the Bake workspace; its scene gets live water in the Live workspace
                self.ws_bake = !is_json && self.doc.cache.is_some();
                self.bake_stale = false;
                if !self.ws_bake { self.tab = Tab::Object; } else if !matches!(self.tab, Tab::Bake | Tab::Display | Tab::Perf) { self.tab = Tab::Bake; }
                self.set_time(0.0);
                self.live = self.doc.scene.is_some();
                self.live_tried = false; self.live_stale = false;
            }
            Err(e) => self.msg = e,
        }
    }

    /// The other workspace: the cache shown and the one kept aside change places (Live shows the live water, Bake the bake).
    fn set_ws(&mut self, bake: bool) {
        if self.ws_bake == bake { return; }
        self.end_tf(false);
        if bake && self.edit.is_some() { self.toggle_edit(); }
        std::mem::swap(&mut self.doc.cache, &mut self.aside);
        std::mem::swap(&mut self.doc.gen, &mut self.aside_gen);
        self.ws_bake = bake;
        if bake && !matches!(self.tab, Tab::Bake | Tab::Display | Tab::Perf) { self.tab = Tab::Bake; }
        if !bake && self.tab == Tab::Bake { self.tab = Tab::Object; }
        self.set_time(self.st);
    }
    /// Where the live water's frames are, and the bake's (whichever is shown is doc.cache).
    fn live_slot(&mut self) -> &mut Option<Arc<Cache>> { if self.ws_bake { &mut self.aside } else { &mut self.doc.cache } }
    fn bake_slot(&mut self) -> &mut Option<Arc<Cache>> { if self.ws_bake { &mut self.doc.cache } else { &mut self.aside } }
    fn live_cache(&self) -> Option<&Arc<Cache>> { if self.ws_bake { self.aside.as_ref() } else { self.doc.cache.as_ref() } }
    fn bake_cache(&self) -> Option<&Arc<Cache>> { if self.ws_bake { self.doc.cache.as_ref() } else { self.aside.as_ref() } }
    /// The bake shown lives in the bake folder (not saved under a name of its own yet).
    fn bake_unsaved(&self) -> bool { self.bake_cache().is_some() && self.path.as_deref().is_some_and(|p| self.bake.in_folder(p)) }

    /// Shows the newest frame of the cache a task is writing (frames are only added, so the ones kept on the GPU stay good).
    fn follow(&mut self, p: &Path) {
        let Ok(c) = Cache::open(p) else { return; };
        self.show_bake(p, c);
    }
    /// The bake at p, as read, becomes the bake shown. The Live workspace stays open if that is where you are (a bake runs behind it).
    fn show_bake(&mut self, p: &Path, c: Cache) {
        // the scene stays the one being edited (the bake was made from it)
        if self.path.as_deref() != Some(p) {
            self.path = Some(p.to_owned());
            self.bump(self.ws_bake);
        }
        let n = c.frames.len();
        let fps = c.info.fps as f64;
        *self.bake_slot() = Some(Arc::new(c));
        self.bake_stale = false;
        if self.ws_bake && self.bake.follow {
            self.splay = false;
            self.st = n.saturating_sub(1) as f64 / fps.max(1.0);
        }
        self.msg = format!("Showing {} as it is written: {} frames", p.file_name().unwrap_or_default().to_string_lossy(), n);
    }

    /// Lets go of the bake at p when it is open (a task is about to write or replace it).
    fn close_if(&mut self, p: &Path) {
        if self.path.as_deref() == Some(p) && self.bake_cache().is_some() { *self.bake_slot() = None; self.bump(self.ws_bake); }
    }

    fn act(&mut self, a: Action) {
        match a {
            Action::Stop => self.worker.stop(),
            Action::Fail(e) => self.msg = e,
            Action::Start(title, t) => {
                self.replaced = self.path.clone().filter(|p| self.bake_unsaved() && *p != t.out);
                // the bake gets the GPU: live water pauses, keeping its frames (it carries on after the bake if it was not finished)
                if self.live_w.busy() { self.live_stale = true; }
                self.live_w.stop(); self.live_rx = None; self.live_pending.clear();
                if t.inp.as_deref() == Some(t.out.as_path()) { self.worker.job.lock().unwrap().result = Some(("Save to another file than the bake it works on.".into(), true)); return; }
                self.close_if(&t.out);
                let slow = t.out.to_string_lossy().to_ascii_uppercase().starts_with("C:");
                self.bake.follow = true;
                self.seen = 0;
                self.set_ws(true);
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
        let Some(out) = out.filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("splc"))) else { self.was_busy = busy; return; };
        // the frames so far, read on a thread
        if let Some(rx) = &self.follow_rx {
            if let Ok((p, c)) = rx.try_recv() { self.follow_rx = None; if let (Some(c), false) = (c, fin) { self.show_bake(&p, c); } }
        }
        if fin && !released {
            // (a read still going holds the file open)
            if let Some(rx) = self.follow_rx.take() { let _ = rx.recv(); }
            self.close_if(&out);
            self.worker.job.lock().unwrap().released = true;
        }
        if busy && !fin && done > self.seen && self.follow_rx.is_none() && self.follow_at.elapsed().as_secs_f32() > 0.5 {
            self.seen = done;
            self.follow_at = Instant::now();
            let (tx, rx) = mpsc::channel();
            let p = out.clone();
            std::thread::spawn(move || { let c = Cache::open(&p).ok(); let _ = tx.send((p, c)); });
            self.follow_rx = Some(rx);
        }
        if self.was_busy && !busy {
            self.bake.check_resume(&out);
            let _ = ok;
            if let Some(old) = self.replaced.take().filter(|_| out.exists()) { self.drop_temp(&old); }
            // a flash on the taskbar when the window is not in front
            if out.exists() { self.ctx_attention = true; }
            if out.exists() {
                // the finished bake is shown (the scene stays as it is being edited)
                let (keep, st) = (self.bake.follow, self.st);
                self.path = None;
                self.follow(&out);
                if !keep { self.set_time(st); }
                self.msg = if self.bake_unsaved() { format!("Baked {} frames. The bake is temporary: File > Save bake keeps it.", self.frames()) } else { format!("Baked {} frames into {}", self.frames(), out.display()) };
            }
        }
        self.was_busy = busy;
    }

    /// Home: the whole tank in view, from the angle the camera has now (frameAll)
    /// The objects of the scene being edited, while the scene (not a bake) is shown.
    fn editing(&self) -> bool { self.doc.scene.is_some() && !self.ws_bake }

    /// Starts (or starts again) the live sim: the scene as it is now, at the Bake tab's spacing (Preview), its frames kept in memory.
    fn live_start(&mut self) {
        let Some(j) = self.doc.scene.as_ref().map(|s| s.json.clone()) else { return; };
        let (tx, rx) = mpsc::channel();
        // the old frames stay shown until the new run's first one
        self.live_fresh = true;
        self.live_tried = true;
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
        *self.live_slot() = None;
        self.bump(!self.ws_bake);
    }
    /// Takes the live sim's new frames into the cache shown.
    fn live_poll(&mut self) {
        // the live worker never waits for the window to let go of a file (it writes none)
        { let mut j = self.live_w.job.lock().unwrap(); if j.finishing { j.released = true; } }
        let Some(rx) = &self.live_rx else { return; };
        let mut pending = std::mem::take(&mut self.live_pending);
        pending.extend(rx.try_iter());
        let mut done = 0;
        let slot = if self.ws_bake { &mut self.aside } else { &mut self.doc.cache };
        let mut replaced = false;
        for b in &pending {
            if self.live_fresh || slot.is_none() {
                // a new run's first message: it takes over from the old frames
                if let Ok(c) = Cache::from_header(b.clone()) { *slot = Some(Arc::new(c)); self.live_fresh = false; replaced = true; }
                done += 1;
                continue;
            }
            match slot {
                Some(c) => match Arc::get_mut(c) { Some(c) => { let _ = c.push(b); } None => break },
                None => {}
            }
            done += 1;
        }
        pending.drain(..done);
        self.live_pending = pending;
        if replaced { self.bump(!self.ws_bake); }
        // memory: like the page's live cache, at most about 2 GB of frames
        if self.live_cache().is_some_and(|c| c.bytes().len() > 2usize << 30) { self.live_w.stop(); self.msg = "Live water stopped at 2 GB of frames.".into(); }
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
        if self.ws_bake { self.set_ws(false); }
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
        self.st = ((t * tf::FPS_TL).round() / tf::FPS_TL).clamp(0.0, self.tl_dur());
        self.apply_keys();
    }
    /// The timeline's length: the scene's, or the bake shown when it is longer.
    fn tl_dur(&self) -> f64 {
        let c = self.doc.cache.as_ref().filter(|_| self.ws_bake).map_or(0.0, |c| c.frames.len().saturating_sub(1) as f64 / c.info.fps.max(1.0) as f64);
        self.scene_dur().max(c)
    }
    /// One frame of the timeline: a frame of the bake shown, else a 24th of a second.
    fn tl_step(&self) -> f64 { if self.ws_bake && self.doc.cache.is_some() { 1.0 / self.fps() as f64 } else { 1.0 / tf::FPS_TL } }
    fn apply_keys(&mut self) {
        let (st, smooth, replay) = (self.st, self.smooth(), self.rec_buf.is_empty() && !self.rec_on);
        let Some(objs) = self.objs_mut() else { return; };
        let mut any = false;
        for o in objs.iter_mut() { any |= tf::apply_keys(o, st, smooth); if replay { any |= tf::apply_rec(o, st); } }
        if !any { return; }
        if let Some(s) = self.doc.scene.as_mut() { s.refresh(false); }
        if !self.burst { self.stable = self.doc.scene.as_ref().map(|s| s.json.clone()); }
    }
    /// I: keys every group of the selected objects at the time shown; Alt+I takes their key on that frame off.
    fn key_selected(&mut self, remove: bool) {
        if self.sel_set.is_empty() { self.msg = "Click an object first.".into(); return; }
        // over a row in the Objects tab, only that group of the object shown there (the page's I over a field)
        let row = if self.tab == Tab::Object { crate::edit::hover_group() } else { None };
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
    /// The key at time from of object obj (None: of every object) moved to time to; a key already there takes its channels.
    fn move_keys(&mut self, obj: Option<usize>, from: f64, to: f64) {
        if (from - to).abs() < 1e-6 { return; }
        let half = 0.5 / tf::FPS_TL;
        let Some(objs) = self.objs_mut() else { return; };
        for (i, o) in objs.iter_mut().enumerate() {
            if obj.is_some_and(|k| k != i) { continue; }
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
        self.sel_key = Some((obj, to));
        self.msg = format!("Key moved from {from:.2} s to {to:.2} s");
        self.edited();
        self.apply_keys();
    }
    /// Delete with a key picked on the timeline: that key goes (every object's at that time when picked on the summary).
    fn delete_keys(&mut self) {
        let Some((obj, t)) = self.sel_key.take() else { return; };
        self.key_del_now = true;
        let mut n = 0;
        if let Some(objs) = self.objs_mut() {
            for (i, o) in objs.iter_mut().enumerate() { if obj.is_none_or(|k| k == i) && tf::clear_key(o, t, None) { n += 1; } }
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

    /// The timeline (the page's #kf): the head row (play, keys, Smooth / Linear, Hold / Stop / Loop, End), then lanes for the water
    /// bake, its whitewater and the live water's frames, and one row of keys per object, under a ruler in seconds with the playhead.
    /// One time (st) for everything: the live water and the bake show the frame at it.
    fn timeline(&mut self, ui: &mut egui::Ui) {
        let dur = self.tl_dur();
        let step = self.tl_step();
        let has_scene = self.doc.scene.is_some();
        ui.horizontal(|ui| {
            let go = |s: &mut Self, t: f64| { s.splay = false; s.bake.follow = false; s.set_time(t); };
            if icon_btn(ui, Ico::Rewind, false).on_hover_text("Back to the start (Shift+Left)").clicked() { go(self, 0.0); }
            if icon_btn(ui, Ico::PrevKey, false).on_hover_text("Previous key (Down)").clicked() { if let Some(t) = self.key_times().into_iter().rev().find(|&t| t < self.st - 1e-6) { go(self, t); } }
            if icon_btn(ui, Ico::PrevFrame, false).on_hover_text("Back one frame (Left)").clicked() { go(self, self.st - step); }
            if icon_btn(ui, if self.splay { Ico::Pause } else { Ico::Play }, self.splay).on_hover_text("Play or stop (Space). Out-of-date water simulates again from the start.").clicked() { self.play(); }
            if icon_btn(ui, Ico::NextFrame, false).on_hover_text("Forward one frame (Right)").clicked() { go(self, self.st + step); }
            if icon_btn(ui, Ico::NextKey, false).on_hover_text("Next key (Up)").clicked() { if let Some(t) = self.key_times().into_iter().find(|&t| t > self.st + 1e-6) { go(self, t); } }
            let frames = (dur / step).round() as usize + 1;
            ui.label(egui::RichText::new(format!("{:.2} s · frame {} / {}", self.st, (self.st / step).round() as usize + 1, frames)).monospace());
            ui.separator();
            ui.add_enabled_ui(has_scene, |ui| {
                if ui.button("Add key").on_hover_text("Key the selected objects' Location, Rotation and Scale at the playhead (I in the view). Hover a field and press I to key only that one; Alt+I takes it off again.").clicked() { self.key_selected(false); }
                if ui.button("Delete key").on_hover_text("Delete the selected key (Delete); with none picked, the selected objects' key at the playhead").clicked() {
                    if self.sel_key.is_some() { self.delete_keys(); } else { self.key_selected(true); }
                }
                let ak = ui.selectable_label(self.auto_key, egui::RichText::new("Auto key").color(if self.auto_key { egui::Color32::from_rgb(0xff, 0x55, 0x55) } else { egui::Color32::from_gray(0xd0) }))
                    .on_hover_text("Auto key, as Blender's record button: while it is on, whatever you change on an object is keyed at the playhead (Move keys Location, Rotate keys Rotation, Scale keys Scale).");
                // kept in the scene file, as the page does (a setting of the editor, so not a change to save)
                if ak.clicked() { self.auto_key = !self.auto_key; if let Some(s) = self.doc.scene.as_mut() { s.json["timeline"]["auto"] = Value::Bool(self.auto_key); } }
                ui.separator();
                let mut smooth = self.smooth();
                if ui.selectable_label(smooth, "Smooth").on_hover_text("Ease in and out between keys").clicked() { smooth = true; }
                if ui.selectable_label(!smooth, "Linear").on_hover_text("Straight between keys, at even speed").clicked() { smooth = false; }
                if smooth != self.smooth() { if let Some(s) = self.doc.scene.as_mut() { s.json["timeline"]["smooth"] = Value::Bool(smooth); } self.edited(); self.apply_keys(); }
                ui.separator();
                // what playing does at the end: Hold and Stop stop there, Loop goes round (timeline.end)
                let end = self.end_mode();
                for (v, n, tip) in [("hold", "Hold", "Stop at the end and keep the last frame"), ("stop", "Stop", "Stop at the end"), ("loop", "Loop", "Start again from the beginning")] {
                    if ui.selectable_label(end == v, n).on_hover_text(tip).clicked() && end != v { if let Some(s) = self.doc.scene.as_mut() { s.json["timeline"]["end"] = Value::String(v.into()); } self.dirty = true; }
                }
                ui.label("End");
                let mut d = self.scene_dur();
                if ui.add(egui::DragValue::new(&mut d).range(1.0..=60.0).speed(0.05).max_decimals(1).suffix(" s")).on_hover_text("How long the scene (and its bake) is").changed() {
                    let d = (d * 2.0).round() / 2.0;
                    if let Some(s) = self.doc.scene.as_mut() { s.json["timeline"]["dur"] = serde_json::json!(d); s.json["bake"]["dur"] = serde_json::json!(d); }
                    self.bake.set_seconds(d as f32);
                    self.edited();
                    if self.st > self.tl_dur() { self.set_time(self.tl_dur()); }
                }
            });
            if icon_btn(ui, if self.kf_open { Ico::Down } else { Ico::Up }, false).on_hover_text("Hide or show the key tracks").clicked() { self.kf_open = !self.kf_open; }
        });
        if !self.kf_open { return; }
        ui.separator();
        self.tracks(ui, dur, step);
    }

    /// What playing does at the scene's end (timeline.end): hold, stop or loop.
    fn end_mode(&self) -> String { self.doc.scene.as_ref().and_then(|s| s.json.pointer("/timeline/end")?.as_str().map(str::to_owned)).unwrap_or_else(|| "hold".into()) }

    /// The timeline's tracks: names on the left, then the ruler, the three cache lanes and a row of keys per object.
    fn tracks(&mut self, ui: &mut egui::Ui, dur: f64, step: f64) {
        const NAMES: f32 = 120.0;
        const RULER: f32 = 18.0;
        const LANE: f32 = 14.0;
        const ROW: f32 = 20.0;
        let gray = |v: u8| egui::Color32::from_gray(v);
        let full = ui.available_rect_before_wrap();
        let x0 = full.left() + NAMES + 8.0;
        let x1 = full.right() - 10.0;
        let span = (x1 - x0).max(10.0);
        let tx = |t: f64| x0 + (t / dur.max(1e-6)) as f32 * span;
        let tof = |x: f32| (((x - x0) / span) as f64 * dur).clamp(0.0, dur);
        let painter = ui.painter_at(full);
        // ruler: seconds (halves when there is room), clicking or dragging it scrubs
        let ruler = egui::Rect::from_min_max(egui::pos2(x0 - 6.0, full.top()), egui::pos2(x1 + 6.0, full.top() + RULER));
        painter.rect_filled(egui::Rect::from_min_max(egui::pos2(full.left(), full.top()), egui::pos2(full.right(), full.top() + RULER)), 0.0, gray(0x24));
        let every = if span / dur as f32 > 90.0 { 0.5 } else if span / dur as f32 > 40.0 { 1.0 } else { 2.0 };
        let mut s = 0.0;
        while s <= dur + 1e-6 {
            let x = tx(s);
            let whole = (s - s.round()).abs() < 1e-6;
            painter.line_segment([egui::pos2(x, full.top() + if whole { 8.0 } else { 12.0 }), egui::pos2(x, full.bottom())], egui::Stroke::new(1.0, gray(if whole { 0x3a } else { 0x30 })));
            if whole { painter.text(egui::pos2(x + 3.0, full.top() + 2.0), egui::Align2::LEFT_TOP, format!("{s:.0}s"), egui::FontId::proportional(11.0), gray(0x9a)); }
            s += every;
        }
        let rr = ui.interact(ruler, ui.scope_id().with("ruler"), egui::Sense::click_and_drag());
        if let Some(p) = rr.interact_pointer_pos().filter(|_| rr.clicked() || rr.dragged()) { self.splay = false; self.bake.follow = false; self.set_time(tof(p.x)); }
        let mut y = full.top() + RULER + 3.0;
        // the cache lanes: frames of the water bake, frames with whitewater (cached with the water, or made by Bake whitewater), the live water
        let lane = |y: f32, name: &str, tip: &str, ui: &mut egui::Ui| {
            painter.text(egui::pos2(full.left() + 6.0, y + LANE / 2.0), egui::Align2::LEFT_CENTER, name, egui::FontId::proportional(11.0), gray(0x9a));
            ui.interact(egui::Rect::from_min_size(egui::pos2(full.left(), y), egui::vec2(NAMES, LANE)), ui.scope_id().with(("lane", name)), egui::Sense::hover()).on_hover_text(tip);
            painter.rect_filled(egui::Rect::from_min_max(egui::pos2(x0, y + 3.0), egui::pos2(x1, y + LANE - 3.0)), 2.0, gray(0x30));
        };
        let bar = |c: &Cache, y: f32, col: &dyn Fn(usize) -> Option<egui::Color32>| {
            let fps = c.info.fps.max(1.0) as f64;
            let mut k = 0;
            let n = c.frames.len();
            while k < n {
                let Some(cl) = col(k) else { k += 1; continue; };
                let mut e = k + 1;
                while e < n && col(e) == Some(cl) { e += 1; }
                painter.rect_filled(egui::Rect::from_min_max(egui::pos2(tx(k as f64 / fps), y + 3.0), egui::pos2(tx(((e - 1) as f64 / fps).max(k as f64 / fps + 0.5 / fps)).max(tx(k as f64 / fps) + 2.0), y + LANE - 3.0)), 2.0, cl);
                k = e;
            }
        };
        lane(y, "Water bake", "The baked water's frames (blue), orange when the scene changed since it was baked", ui);
        if let Some(c) = self.bake_cache() { let col = if self.bake_stale { egui::Color32::from_rgb(0xc8, 0x82, 0x2e) } else { egui::Color32::from_rgb(0x3d, 0x6f, 0xd0) }; bar(c, y, &|_| Some(col)); }
        y += LANE;
        lane(y, "Whitewater", "Frames with whitewater: teal made with the water bake, white made by Bake whitewater", ui);
        if let Some(c) = self.bake_cache() {
            bar(c, y, &|k| c.frames[k].ww.as_ref().filter(|w| w.n > 0).map(|_| if c.frames[k].flags & splash_format::cache::FLAG_WW_BAKED != 0 { egui::Color32::from_gray(0xd8) } else { egui::Color32::from_rgb(0x3a, 0xa8, 0x9c) }));
        }
        y += LANE;
        lane(y, "Live cache", "The live water's frames, kept to play back and scrub (green); orange while it simulates again after a change", ui);
        if let Some(c) = self.live_cache() {
            let col = if self.live_stale { egui::Color32::from_rgb(0xc8, 0x82, 0x2e) } else { egui::Color32::from_rgb(0x4a, 0xa8, 0x55) };
            bar(c, y, &|_| Some(col));
        }
        y += LANE + 4.0;
        // a row per object: its name (click selects) and its keys (click picks, drag moves, Delete removes)
        let objs: Vec<(String, Vec<f64>)> = self.objs().iter().map(|o| (o["name"].as_str().unwrap_or("?").to_string(), tf::keys(o).iter().filter_map(|k| k["t"].as_f64()).collect())).collect();
        let rows_rect = egui::Rect::from_min_max(egui::pos2(full.left(), y), full.right_bottom());
        let mut pick: Option<usize> = None;
        let mut drag_end: Option<(Option<usize>, f64, f64)> = None;
        ui.scope_builder(egui::UiBuilder::new().max_rect(rows_rect), |ui| {
            egui::ScrollArea::vertical().id_salt("kfrows").auto_shrink([false, false]).show(ui, |ui| {
                let top = ui.cursor().top();
                let (r, _) = ui.allocate_exact_size(egui::vec2(rows_rect.width(), (objs.len() as f32 * ROW).max(ROW)), egui::Sense::hover());
                let p = ui.painter_at(rows_rect);
                for (i, (name, keys)) in objs.iter().enumerate() {
                    let ry = top + i as f32 * ROW;
                    let selected = self.sel_set.contains(&i);
                    let name_r = egui::Rect::from_min_size(egui::pos2(r.left(), ry), egui::vec2(NAMES, ROW));
                    if selected { p.rect_filled(egui::Rect::from_min_max(egui::pos2(r.left(), ry), egui::pos2(r.right(), ry + ROW)), 0.0, egui::Color32::from_rgba_unmultiplied(0x47, 0x72, 0xb3, 50)); }
                    p.text(egui::pos2(r.left() + 6.0, ry + ROW / 2.0), egui::Align2::LEFT_CENTER, name, egui::FontId::proportional(12.0), if selected { egui::Color32::from_rgb(0xe9, 0xa4, 0x3a) } else { gray(0xd0) });
                    if ui.interact(name_r, ui.scope_id().with(("kfname", i)), egui::Sense::click()).clicked() { pick = Some(i); }
                    p.line_segment([egui::pos2(x0, ry + ROW - 0.5), egui::pos2(x1, ry + ROW - 0.5)], egui::Stroke::new(1.0, gray(0x30)));
                    for &t in keys {
                        let shown = match self.key_drag { Some((Some(o), from, to)) if o == i && (from - t).abs() < 1e-6 => to, _ => t };
                        let c = egui::pos2(tx(shown), ry + ROW / 2.0);
                        let kr = ui.interact(egui::Rect::from_center_size(c, egui::vec2(12.0, 14.0)), ui.scope_id().with(("key", i, (t * 1000.0).round() as i64)), egui::Sense::click_and_drag())
                            .on_hover_text(format!("{name}: a key at {t:.2} s. Click to pick it (Delete removes it), drag to move it."));
                        if kr.clicked() { self.sel_key = Some((Some(i), t)); self.splay = false; self.set_time(t); }
                        if kr.dragged() { if let Some(px) = kr.interact_pointer_pos() { self.key_drag = Some((Some(i), t, (tof(px.x) / tf::FPS_TL.recip()).round() * tf::FPS_TL.recip())); } }
                        if kr.drag_stopped() { drag_end = self.key_drag.take(); }
                        let picked = self.sel_key.is_some_and(|(o, k)| o.is_none_or(|o| o == i) && (k - t).abs() < 1e-6);
                        let s = if picked { 6.5 } else { 5.0 };
                        let fill = if picked { egui::Color32::WHITE } else { egui::Color32::from_rgb(0xe9, 0xc8, 0x4a) };
                        p.add(egui::Shape::convex_polygon(vec![c + egui::vec2(0.0, -s), c + egui::vec2(s, 0.0), c + egui::vec2(0.0, s), c + egui::vec2(-s, 0.0)], fill, egui::Stroke::new(1.0, gray(0x20))));
                    }
                }
                if objs.is_empty() { p.text(egui::pos2(r.left() + 6.0, top + ROW / 2.0), egui::Align2::LEFT_CENTER, "No objects", egui::FontId::proportional(12.0), gray(0x80)); }
            });
        });
        if let Some(i) = pick { self.select(Some(i), ui.input(|i| i.modifiers.shift)); self.tab = Tab::Object; }
        if let Some((o, from, to)) = drag_end { self.move_keys(o, from, to); }
        // the playhead across everything, with its handle on the ruler
        let px = tx(self.st);
        let ph = egui::Color32::from_rgb(0xe9, 0xa4, 0x3a);
        painter.line_segment([egui::pos2(px, full.top()), egui::pos2(px, full.bottom())], egui::Stroke::new(1.5, ph));
        painter.rect_filled(egui::Rect::from_center_size(egui::pos2(px, full.top() + 6.0), egui::vec2(10.0, 12.0)), 2.0, ph);
        let _ = step;
        ui.allocate_rect(full, egui::Sense::hover());
    }

    /// Recording ends: what was recorded becomes each object's rec (replayed by bakes and when the time moves).
    fn rec_stop(&mut self) {
        self.rec_on = false;
        let buf = std::mem::take(&mut self.rec_buf);
        if buf.is_empty() { return; }
        let mut secs = 0.0f64;
        if let Some(objs) = self.objs_mut() {
            for o in objs.iter_mut() {
                let Some((start, arr)) = o["id"].as_u64().and_then(|id| buf.get(&id)) else { continue; };
                if arr.len() < 8 { continue; }
                secs = secs.max((*start as f64 + (arr.len() / 4) as f64) / 60.0);
                o["rec"] = serde_json::json!({ "start": start, "arr": arr });
            }
        }
        self.msg = format!("Recorded {secs:.1} s of motion; baking replays it");
        self.edited();
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
        if self.ws_bake { self.set_ws(false); }
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
    /// The View tab's settings stay for next time.
    fn save_look(&self) {
        let l = &self.look;
        crate::bakeui::set_setting("look", serde_json::json!({ "size": l.size, "vmax": l.vmax, "foam": l.foam, "detail": l.detail, "sprDetail": l.spr_detail, "streak": l.streak, "bg": l.bg, "fog": l.fog, "fogK": l.fog_k, "byType": l.by_type }));
    }
    fn load_look(&mut self) {
        let Some(v) = crate::bakeui::setting("look") else { return; };
        let (f, l) = (|k: &str| v[k].as_f64().map(|x| x as f32), &mut self.look);
        if let Some(x) = f("size") { l.size = x; } if let Some(x) = f("vmax") { l.vmax = x; } if let Some(x) = f("foam") { l.foam = x; }
        if let Some(x) = f("detail") { l.detail = x as u32; } if let Some(x) = f("sprDetail") { l.spr_detail = x as u32; } if let Some(x) = f("streak") { l.streak = x; }
        if let Some(x) = f("bg") { l.bg = x as u8; } if let Some(x) = f("fogK") { l.fog_k = x; }
        if let Some(x) = v["fog"].as_bool() { l.fog = x; } if let Some(x) = v["byType"].as_bool() { l.by_type = x; }
    }
    /// Offered at start-up when the last run ended without closing properly.
    fn offer_recovery(&mut self) -> bool {
        let Some(p) = autosave_path().filter(|p| p.exists()) else { return false; };
        let of = crate::bakeui::setting("autosaveOf").and_then(|v| v.as_str().map(String::from));
        let said = rfd::MessageDialog::new().set_title("SplashTank").set_level(rfd::MessageLevel::Info)
            .set_description(format!("SplashTank did not close properly last time. Open the scene as it was a minute or less before that ({})?", of.as_deref().unwrap_or("not saved yet")))
            .set_buttons(rfd::MessageButtons::YesNo).show() == rfd::MessageDialogResult::Yes;
        if said {
            self.open(&p);
            self.scene_path = of.map(PathBuf::from);
            self.dirty = true;
            self.msg = "Recovered the scene. Save it to keep it.".into();
        } else { forget_autosave(); }
        said
    }
    /// Everything not selected becomes the selection.
    fn invert_selection(&mut self) {
        self.sel_set = (0..self.objs().len()).filter(|k| !self.sel_set.contains(k)).collect();
        self.sel = self.sel_set.first().copied();
    }
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

    /// The tools at the viewport's top left (the page's tool shelf: which gizmo handles show) and, with a bake open, Scene / Bake.
    fn viewport_bar(&mut self, ui: &mut egui::Ui, rect: egui::Rect) {
        let r = egui::Rect::from_min_size(rect.min + egui::vec2(10.0, 8.0), egui::vec2(560.0, 28.0));
        ui.scope_builder(egui::UiBuilder::new().max_rect(r), |ui| {
            ui.horizontal(|ui| {
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

    /// The top bar (the page's): menus, the Live / Bake workspaces, then on the right the bake buttons, the bake steps (Water ›
    /// Whitewater › Saved), and the live water's state with Start / Stop.
    fn top(&mut self, ui: &mut egui::Ui) {
        let orange = egui::Color32::from_rgb(0xe9, 0xa4, 0x3a);
        egui::MenuBar::new().ui(ui, |ui| {
            ui.label(egui::RichText::new("SplashTank").color(orange).strong());
            ui.menu_button("File", |ui| self.file_menu(ui));
            ui.menu_button("Edit", |ui| {
                if ui.button("Undo                Ctrl Z").clicked() { self.undo_redo(false); ui.close(); }
                if ui.button("Redo        Ctrl Shift Z").clicked() { self.undo_redo(true); ui.close(); }
                ui.separator();
                if ui.button("Select all                 A").clicked() { self.sel_set = (0..self.objs().len()).collect(); self.sel = self.sel.or(self.sel_set.first().copied()); ui.close(); }
                if ui.button("Invert selection      Ctrl I").clicked() { self.invert_selection(); ui.close(); }
                ui.separator();
                if ui.button("Search settings        F3").clicked() { self.tab = Tab::Sim; self.set_ws(false); ui.close(); }
                if ui.button(format!("Snapping: {}   Shift Tab", if self.snap_on { "on" } else { "off" })).clicked() { self.snap_on = !self.snap_on; ui.close(); }
                if ui.button(format!("Orientation: {}", if self.orient_local { "Local" } else { "Global" })).clicked() { self.orient_local = !self.orient_local; ui.close(); }
            });
            ui.menu_button("Add", |ui| {
                ui.add_enabled_ui(self.doc.scene.is_some(), |ui| {
                    for (shape, water, name) in [("cube", false, "Cube"), ("sphere", false, "Sphere"), ("cylinder", false, "Cylinder"), ("cube", true, "Water box"), ("sphere", true, "Water ball"), ("emitter", false, "Source")] {
                        if ui.button(name).clicked() { self.add_object(shape, water); ui.close(); }
                    }
                    ui.separator();
                    if ui.button("Drop water").on_hover_text("A ball of water dropped in at the playhead").clicked() { self.drop_water(); ui.close(); }
                });
            });
            ui.menu_button("View", |ui| {
                if ui.button("Frame all             Home").clicked() { self.frame_all(); ui.close(); }
                if ui.button("Frame selected           F").clicked() { self.focus_selected(); ui.close(); }
                ui.separator();
                if ui.button("Front             Numpad 1").clicked() { self.snap_view("front"); ui.close(); }
                if ui.button("Right             Numpad 3").clicked() { self.snap_view("right"); ui.close(); }
                if ui.button("Top               Numpad 7").clicked() { self.snap_view("top"); ui.close(); }
                if ui.button("Back         Ctrl Numpad 1").clicked() { self.snap_view("back"); ui.close(); }
                if ui.button("Left         Ctrl Numpad 3").clicked() { self.snap_view("left"); ui.close(); }
                if ui.button("Bottom       Ctrl Numpad 7").clicked() { self.snap_view("bottom"); ui.close(); }
                if ui.button(format!("{}      Numpad 5", if self.cam.ortho { "Perspective " } else { "Orthographic" })).clicked() { self.cam.ortho = !self.cam.ortho; ui.close(); }
                ui.separator();
                if ui.button(if self.kf_open { "Hide key tracks" } else { "Show key tracks" }).clicked() { self.kf_open = !self.kf_open; ui.close(); }
                if ui.button(if self.handles { "Hide tank arrows" } else { "Show tank arrows" }).clicked() { self.handles = !self.handles; ui.close(); }
                if ui.button(format!("Performance overlay  P{}", if self.perf { "  (on)" } else { "" })).clicked() { self.perf = !self.perf; ui.close(); }
            });
            ui.menu_button("Help", |ui| {
                if ui.button("Hotkeys").clicked() { self.tab = Tab::Help; ui.close(); }
                if ui.button("Run the benchmark").clicked() { self.tab = Tab::Perf; ui.close(); }
            });
            ui.separator();
            if ui.selectable_label(!self.ws_bake, egui::RichText::new("  Live  ").strong()).on_hover_text("Live: set up the scene, with live water simulating as you work.").clicked() { self.set_ws(false); }
            if ui.selectable_label(self.ws_bake, egui::RichText::new("  Bake  ").strong()).on_hover_text("Bake: run the whole shot at full quality into a cache, then play it back.").clicked() { self.set_ws(true); }
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                // live water: simulate ahead or only while playing, Refresh, and what it is doing
                let busy = self.live_w.busy();
                let label = egui::RichText::new(if self.ahead { "Simulate ahead: On" } else { "Simulate ahead: Off" }).strong();
                let label = if self.ahead { label.color(egui::Color32::BLACK) } else { label };
                let sw = egui::Button::new(label).fill(if self.ahead { orange } else { egui::Color32::from_gray(0x54) });
                if ui.add_enabled(self.doc.scene.is_some(), sw).on_hover_text("Off: nothing is simulated while you edit. The water simulates only while you play, a little ahead of the playhead, and stops when you pause.\nOn: after each change the whole timeline simulates and caches by itself, ready to scrub, which keeps the graphics card busy.").clicked() {
                    self.ahead = !self.ahead;
                    crate::bakeui::set_setting("simAhead", serde_json::json!(self.ahead));
                }
                if ui.add_enabled(self.doc.scene.is_some() && !self.worker.busy(), egui::Button::new("Refresh water")).on_hover_text("Throw away the water's frames and start it again from the beginning. Use it when the water is out of date or looks stuck.").clicked() { self.refresh_water(); }
                let n = self.live_cache().map_or(0, |c| c.frames.len());
                let total = (self.scene_dur() * self.live_fps()).round() as usize + 1;
                let green = egui::Color32::from_rgb(0x4a, 0xc8, 0x5a);
                let grey = egui::Color32::from_gray(0x90);
                let (dot, txt) = if self.worker.busy() { (grey, "Water waits for the bake".to_string()) }
                    else if self.live_stale { (orange, if self.ahead { "Water out of date: simulating soon".to_string() } else { "Water out of date: press Play or Refresh".to_string() }) }
                    else if busy && n as u32 >= self.live_w.limit.load(std::sync::atomic::Ordering::Relaxed) { (grey, format!("Water paused at frame {n}")) }
                    else if busy { (green, format!("Simulating {n} of {total}")) }
                    else if let Some((e, true)) = self.live_w.job.lock().unwrap().result.clone() { (egui::Color32::from_rgb(0xe0, 0x60, 0x50), format!("Water: {e}")) }
                    else { (green, format!("Water cached, {n} frames")) };
                ui.label(egui::RichText::new(txt).small());
                icon_at(ui, Ico::Dot, dot);
                ui.separator();
                // the bake steps: none (grey), working (blue), done (green), out of date (orange); a click opens the Bake tab
                let (wstate, wwstate, sstate) = self.pipe_states();
                let col = |s: u8| match s { 1 => egui::Color32::from_rgb(0x5f, 0x9c, 0xf0), 2 => egui::Color32::from_rgb(0x6a, 0xc8, 0x6f), 3 => orange, _ => egui::Color32::from_gray(0x80) };
                let mut open = false;
                for (k, (name, s)) in [("Saved", sstate), ("Whitewater", wwstate), ("Water", wstate)].into_iter().enumerate() {
                    if k > 0 { ui.label(egui::RichText::new("›").color(egui::Color32::from_gray(0x80))); }
                    open |= ui.add(egui::Label::new(egui::RichText::new(name).color(col(s)).small()).sense(egui::Sense::click()))
                        .on_hover_text("The bake steps: the water, its whitewater, saved under a name. Click to open Bake.").clicked();
                }
                if open { self.tab = Tab::Bake; self.set_ws(true); }
                ui.separator();
                let can = self.doc.scene.is_some() && !self.worker.busy();
                if ui.add_enabled(can && self.bake_cache().is_some(), egui::Button::new("Bake whitewater").small()).on_hover_text("Whitewater for the bake shown, made from its water with the Whitewater settings as they are now.").clicked() {
                    if let Some(a) = self.bake.start_whitewater(self.path.clone(), self.doc.scene.as_ref().map(|s| &s.json)) { self.act(a); }
                }
                if ui.add_enabled(can, egui::Button::new("Bake").small()).on_hover_text("Bake the scene with the Bake tab's settings into the bake folder (no file to pick first; File > Save bake keeps it under a name).").clicked() {
                    if let Some(a) = self.bake.start_bake(self.doc.scene.as_ref().map(|s| &s.json)) { self.act(a); }
                }
            });
        });
    }

    /// The bake steps' states (0 none, 1 working, 2 done, 3 out of date): water, whitewater, saved.
    fn pipe_states(&self) -> (u8, u8, u8) {
        let (busy, title) = { let j = self.worker.job.lock().unwrap(); (j.busy, j.title.clone()) };
        let bake = self.bake_cache();
        let water = if busy && (title.starts_with("Baking") || title.starts_with("Carrying")) { 1 } else if bake.is_some() { if self.bake_stale { 3 } else { 2 } } else { 0 };
        let ww = if busy && title.starts_with("Whitewater") { 1 } else if bake.is_some_and(|c| c.frames.iter().any(|f| f.ww.as_ref().is_some_and(|w| w.n > 0))) { 2 } else { 0 };
        let saved = if self.saving.is_some() { 1 } else if bake.is_some() && !self.bake_unsaved() { 2 } else { 0 };
        (water, ww, saved)
    }

    /// The live water's frames a second (its cache's, else the scene's bake setting).
    fn live_fps(&self) -> f64 {
        self.live_cache().map(|c| c.info.fps as f64).or_else(|| self.doc.scene.as_ref().and_then(|s| s.json.pointer("/bake/fps")?.as_f64())).unwrap_or(24.0)
    }

    fn file_menu(&mut self, ui: &mut egui::Ui) {
        ui.menu_button("New scene", |ui| {
            let mut pick = None;
            if ui.button("Empty tank").clicked() { pick = Some("Empty tank".to_string()); }
            ui.separator();
            for n in scenes()["order"].as_array().into_iter().flatten().filter_map(Value::as_str) { if ui.button(n).clicked() { pick = Some(n.to_string()); } }
            if let Some(n) = pick { ui.close(); if self.may_discard() { self.new_scene(&n); } }
        });
        if ui.button("Open…").on_hover_text("A scene file (.json) or a bake (.splc)").clicked() {
            ui.close();
            if self.may_discard() {
                if let Some(p) = rfd::FileDialog::new().add_filter("SplashTank files", &["splc", "json"]).add_filter("Bake cache", &["splc"]).add_filter("Scene", &["json"]).pick_file() { self.open(&p); }
            }
        }
        let recent: Vec<String> = crate::bakeui::setting("recent").and_then(|v| v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())).unwrap_or_default();
        ui.add_enabled_ui(!recent.is_empty(), |ui| ui.menu_button("Open recent", |ui| {
            for f in recent {
                let p = PathBuf::from(&f);
                let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| f.clone());
                if ui.add_enabled(p.exists(), egui::Button::new(name)).on_hover_text(f.clone()).clicked() { ui.close(); if self.may_discard() { self.open(&p); } }
            }
        }));
        ui.separator();
        if ui.add_enabled(self.doc.scene.is_some(), egui::Button::new("Save scene              Ctrl S")).clicked() { ui.close(); self.save_scene(false); }
        if ui.add_enabled(self.doc.scene.is_some(), egui::Button::new("Save scene as…")).clicked() { ui.close(); self.save_scene(true); }
        ui.separator();
        if ui.add_enabled(self.bake_cache().is_some() && self.saving.is_none() && !self.worker.busy(), egui::Button::new("Save bake…")).on_hover_text("Keep the bake shown under a name and place of your own (it is moved out of the bake folder)").clicked() { ui.close(); self.save_bake(); }
        if ui.add_enabled(self.live_cache().is_some_and(|c| !c.frames.is_empty()), egui::Button::new("Save live water…")).on_hover_text("Keep the live water's frames as a bake file").clicked() { ui.close(); self.save_live(); }
        if ui.add_enabled(self.bake_cache().is_some() && !self.worker.busy(), egui::Button::new("Export for Blender…")).on_hover_text("Each frame as PLY files in a folder, in metres: water points, whitewater points and the water's surface as a mesh, with a script that loads the mesh sequence into Blender").clicked() { ui.close(); self.export_bake(true); }
        if ui.add_enabled(self.bake_cache().is_some() && !self.worker.busy(), egui::Button::new("Export points only…")).on_hover_text("As Export for Blender, without the surface mesh: much quicker").clicked() { ui.close(); self.export_bake(false); }
        if ui.add_enabled(self.bake_cache().is_some(), egui::Button::new("Bake report…")).on_hover_text("The bake's settings, its measurements for every frame and the scene, as a file to send").clicked() { ui.close(); self.save_report(); }
        if ui.button("Open the bake folder").on_hover_text(self.bake.folder.display().to_string()).clicked() {
            ui.close();
            let _ = std::fs::create_dir_all(&self.bake.folder);
            let _ = std::process::Command::new("explorer").arg(&self.bake.folder).spawn();
        }
    }

    /// Save bake: the bake shown is moved where the user says (renamed on the same drive, else copied in the background and the
    /// bake folder's copy removed), with its checkpoint when it has one; then opened from there.
    fn save_bake(&mut self) {
        let Some(from) = self.path.clone().filter(|_| self.bake_cache().is_some()) else { return; };
        let stem = self.doc.scene.as_ref().and(self.scene_path.as_ref()).and_then(|p| p.file_stem()).map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "bake".into());
        let mut d = rfd::FileDialog::new().set_title("Save the bake as").add_filter("Bake cache", &["splc"]).set_file_name(format!("{stem}.splc"));
        if let Some(dir) = self.scene_path.as_ref().and_then(|p| p.parent()) { d = d.set_directory(dir); }
        let Some(to) = d.save_file().map(|p| if p.extension().is_none() { p.with_extension("splc") } else { p }) else { return; };
        if to == from { return; }
        // Windows will not move a file that is mapped: let go of it first
        self.close_if(&from);
        let ck = (splash_sim::bake::checkpoint_path(&from), splash_sim::bake::checkpoint_path(&to));
        if std::fs::rename(&from, &to).is_ok() {
            let _ = std::fs::rename(&ck.0, &ck.1);
            self.path = None;
            self.follow(&to);
            self.msg = format!("Saved the bake as {}", to.display());
            return;
        }
        let (tx, rx) = mpsc::channel();
        let (f2, t2) = (from.clone(), to.clone());
        std::thread::spawn(move || {
            let r = std::fs::copy(&f2, &t2).map_err(|e| format!("Could not save the bake as {}: {e}", t2.display()));
            if r.is_ok() { let _ = std::fs::copy(&ck.0, &ck.1); let _ = std::fs::remove_file(&ck.0); let _ = std::fs::remove_file(&f2); }
            let _ = tx.send(r.map(|_| t2));
        });
        self.saving = Some(rx);
        self.path = Some(from);
        self.msg = format!("Saving the bake as {}…", to.display());
    }

    /// Save live water: its frames as a bake file, written on a thread, then opened as the bake shown.
    fn save_live(&mut self) {
        let Some(c) = self.live_cache().cloned() else { return; };
        let Some(to) = rfd::FileDialog::new().set_title("Save the live water as").add_filter("Bake cache", &["splc"]).set_file_name("live water.splc").save_file().map(|p| if p.extension().is_none() { p.with_extension("splc") } else { p }) else { return; };
        let (tx, rx) = mpsc::channel();
        let t2 = to.clone();
        std::thread::spawn(move || {
            let r = splash_format::cache::convert(&c, &t2, false, |_, _| {}).map_err(|e| format!("Could not save {}: {e}", t2.display()));
            let _ = tx.send(r.map(|_| t2));
        });
        self.saving = Some(rx);
        self.msg = format!("Saving the live water as {}…", to.display());
    }

    /// Export for Blender: on the worker, with its progress in the Bake tab.
    fn export_bake(&mut self, mesh: bool) {
        let Some(inp) = self.path.clone().filter(|_| self.bake_cache().is_some()) else { return; };
        let Some(dir) = rfd::FileDialog::new().set_title("Export the bake into this folder").pick_folder() else { return; };
        self.tab = Tab::Bake;
        self.worker.start("Exporting for Blender".into(), crate::bake_cli::Task { kind: crate::bake_cli::Kind::Export { mesh }, inp: Some(inp), scene: Value::Null, o: Default::default(), out: dir });
    }

    /// The bake report (the page's): settings, every frame's measurements and the scene, as a file.
    fn save_report(&mut self) {
        let Some(c) = self.bake_cache().cloned() else { return; };
        let Some(p) = rfd::FileDialog::new().set_file_name("splashtank-bake-report.json").add_filter("Report", &["json"]).save_file() else { return; };
        let (i, m) = (&c.info, &c.info.meta);
        let mut rep = serde_json::json!({ "app": "SplashTank native bake report", "version": 1, "gpu": self.gpu, "frames": c.frames.len(), "fps": i.fps, "spacing": i.d, "scale": i.scale });
        for k in ["desc", "diag", "scene", "seconds", "maxN", "native", "cancelled"] { if !m[k].is_null() { rep[k] = m[k].clone(); } }
        self.msg = match std::fs::write(&p, serde_json::to_vec_pretty(&rep).unwrap_or_default()) { Ok(()) => format!("Saved {}", p.display()), Err(e) => format!("Could not save the report: {e}") };
    }

    /// The outliner (the page's): the tank, every object (its kind, shown or hidden) and the simulation.
    fn outliner(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            ui.label(egui::RichText::new("Outliner").strong());
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.add_enabled(self.doc.scene.is_some(), egui::Button::new("+").small()).on_hover_text("Add water, a source or a collider (Shift+A)").clicked() {
                    self.add_at = Some(ui.max_rect().left_bottom() + egui::vec2(-160.0, 4.0));
                }
            });
        });
        let gray = egui::Color32::from_gray(0x90);
        egui::ScrollArea::vertical().id_salt("outliner").max_height(170.0).auto_shrink([false, true]).show(ui, |ui| {
            let Some(s) = self.doc.scene.as_ref() else { ui.label(egui::RichText::new("No scene: File > New scene or Open.").color(gray)); return; };
            let sz = s.size;
            let tank = ui.horizontal(|ui| {
                icon_at(ui, Ico::Tank, egui::Color32::from_rgb(0xae, 0xb6, 0xbd));
                let r = ui.selectable_label(self.tab == Tab::Scene && self.sel.is_none(), "Tank");
                ui.label(egui::RichText::new(format!("domain {:.1} × {:.1} × {:.1}", sz[0], sz[1], sz[2])).small().color(gray));
                r
            }).inner;
            if tank.on_hover_text("The tank: the box the water lives in. Its size and open sides are in the Scene tab.").clicked() { self.tab = Tab::Scene; }
            let rows: Vec<(String, Ico, &'static str, u64, usize)> = self.objs().iter().map(|o| {
                let (icon, kind) = if tf::is_emitter(o) { (Ico::Source, "source") } else if o["water"].as_bool() == Some(true) { (Ico::Water, "water") } else { (Ico::Cube, "collider") };
                (o["name"].as_str().unwrap_or("?").to_string(), icon, kind, o["id"].as_u64().unwrap_or(0), tf::keys(o).len())
            }).collect();
            let mut pick = None;
            for (i, (name, ico, kind, id, keys)) in rows.into_iter().enumerate() {
                ui.horizontal(|ui| {
                    ui.add_space(14.0);
                    let col = match ico { Ico::Source => egui::Color32::from_rgb(0x5f, 0xd0, 0x8a), Ico::Water => egui::Color32::from_rgb(0x5f, 0x9c, 0xf0), _ => egui::Color32::from_rgb(0xae, 0xb6, 0xbd) };
                    icon_at(ui, ico, col);
                    let r = ui.selectable_label(self.sel_set.contains(&i), name);
                    ui.label(egui::RichText::new(if keys > 0 { format!("{kind} · {keys} keys") } else { kind.to_string() }).small().color(gray));
                    if r.clicked() { pick = Some((i, false)); }
                    if r.double_clicked() { pick = Some((i, true)); }
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        let hid = self.doc.hidden.contains(&id);
                        if icon_btn(ui, if hid { Ico::EyeOff } else { Ico::Eye }, false).on_hover_text("Show or hide in the view (H, Alt+H). Hidden objects still act on the water.").clicked() {
                            if hid { self.doc.hidden.retain(|&x| x != id); } else { self.doc.hidden.push(id); }
                        }
                    });
                });
            }
            if let Some((i, focus)) = pick {
                self.select(Some(i), ui.input(|x| x.modifiers.shift));
                self.tab = Tab::Object;
                if focus { self.focus_selected(); }
            }
            let n = self.live_cache().and_then(|c| c.frames.get(self.t as usize).or(c.frames.last())).map_or(0, |f| f.water.n);
            ui.horizontal(|ui| {
                icon_at(ui, Ico::Sim, egui::Color32::from_rgb(0xe9, 0xa4, 0x3a));
                if ui.selectable_label(self.tab == Tab::Sim, egui::RichText::new("Simulation").color(egui::Color32::from_rgb(0xe9, 0xa4, 0x3a))).clicked() { self.tab = Tab::Sim; }
                if n > 0 { ui.label(egui::RichText::new(format!("{:.1}k particles", n as f64 / 1000.0)).small().color(gray)); }
            });
        });
    }

    /// The status bar (the page's): the main keys, and the last message.
    fn status(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            let gray = egui::Color32::from_gray(0x9a);
            for (k, what) in [("G R S", "move, rotate, scale"), ("Shift D", "duplicate"), ("X", "delete"), ("I", "keyframe"), ("F", "focus"), ("Shift A", "add"), ("Space", "play")] {
                ui.label(egui::RichText::new(k).monospace().small().background_color(egui::Color32::from_gray(0x3a)));
                ui.label(egui::RichText::new(what).small().color(gray));
            }
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if self.dirty { ui.label(egui::RichText::new("unsaved scene").small().color(egui::Color32::from_rgb(0xe9, 0xa4, 0x3a))); }
                ui.add(egui::Label::new(egui::RichText::new(&self.msg).small().color(gray)).truncate());
            });
        });
    }

    /// The right column (the page's): the outliner, then the property tabs down the left with the open tab beside them.
    fn side(&mut self, ui: &mut egui::Ui) {
        self.outliner(ui);
        ui.separator();
        ui.horizontal_top(|ui| {
            ui.vertical(|ui| {
                ui.set_width(98.0);
                for (t, name, tip) in TABS {
                    if ui.add_sized([96.0, 24.0], egui::Button::selectable(self.tab == t, name)).on_hover_text(tip).clicked() {
                        self.tab = t;
                        if t == Tab::Bake { self.set_ws(true); }
                        if matches!(t, Tab::Object | Tab::Sim | Tab::Scene) && self.ws_bake && self.bake_cache().is_none() { self.set_ws(false); }
                    }
                }
            });
            ui.separator();
            ui.vertical(|ui| {
                let name = TABS.iter().find(|x| x.0 == self.tab).map_or("", |x| x.1);
                ui.horizontal(|ui| {
                    ui.label(egui::RichText::new(if self.ws_bake { "Bake" } else { "Scene" }).small().color(egui::Color32::from_gray(0x90)));
                    ui.label(egui::RichText::new("›").small().color(egui::Color32::from_gray(0x70)));
                    ui.label(egui::RichText::new(name).small().strong());
                });
                egui::ScrollArea::vertical().id_salt("tabbody").show(ui, |ui| self.tab_body(ui));
            });
        });
    }

    /// What the open property tab shows.
    fn tab_body(&mut self, ui: &mut egui::Ui) {
        {
            let tab = self.tab;
            if tab == Tab::Help { help(ui); return; }
            if tab == Tab::Bake {
                let shown = self.path.clone().filter(|p| self.bake_cache().is_some() && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("splc")));
                let scene = self.doc.scene.as_ref().map(|s| &s.json);
                if let Some(a) = self.bake.panel(ui, &self.worker, scene, self.scene_rev, shown.as_deref()) { self.act(a); }
                if std::mem::take(&mut self.bake.bake_edited) {
                    // kept in the scene (detail for the web page); nothing to simulate again
                    let (b, l) = (self.bake.bake_spacing(), self.bake.spacing());
                    if let Some(s) = self.doc.scene.as_mut() { s.json["bake"]["spacing"] = serde_json::json!(b); s.json["bake"]["detail"] = serde_json::json!(l / b); self.dirty = true; }
                }
                return;
            }
            if matches!(tab, Tab::Sim | Tab::Scene | Tab::Object) {
                if tab == Tab::Scene {
                    ui.horizontal(|ui| {
                        if ui.add_enabled(self.doc.scene.is_some(), egui::Button::new("Save scene (Ctrl+S)")).on_hover_text("Saves objects, keyframes, the tank and solver settings. Bakes are not included.").clicked() { self.save_scene(false); }
                        if ui.button("Load scene").on_hover_text("Open a scene saved earlier").clicked() && self.may_discard() {
                            if let Some(p) = rfd::FileDialog::new().add_filter("Scene", &["json"]).pick_file() { self.open(&p); }
                        }
                    });
                    ui.separator();
                }
                if tab == Tab::Sim && self.doc.scene.is_some() {
                    let mut sp = self.bake.spacing();
                    let r = ui.horizontal(|ui| {
                        ui.label(egui::RichText::new("Spacing").strong());
                        ui.add(egui::DragValue::new(&mut sp).range(0.003..=0.3).speed(0.0005).max_decimals(4))
                    }).inner.on_hover_text("How far apart live water's particles are: smaller is finer and slower. The bake has its own spacing in the Bake tab.");
                    if r.changed() {
                        self.bake.set_spacing(sp);
                        if let Some(s) = self.doc.scene.as_mut() { s.json["solver"]["spacing"] = serde_json::json!(sp); }
                        self.edited();
                    }
                    ui.separator();
                }
                if tab == Tab::Object && self.doc.scene.is_some() {
                    // the page's Motion for baking
                    egui::CollapsingHeader::new(egui::RichText::new("Motion for baking").strong()).default_open(false).show(ui, |ui| {
                        let mut on = self.rec_on;
                        if ui.checkbox(&mut on, "Record object motion").on_hover_text("While the scene plays, every object's place is recorded 60 times a second as you move them (G, the gizmo); baking replays it. Objects with keys follow their keys instead.").changed() {
                            if on { self.rec_on = true; self.set_ws(false); self.st = 0.0; self.splay = true; self.msg = "Recording: move objects while the scene plays; untick to stop".into(); } else { self.rec_stop(); }
                        }
                        if !self.rec_on { ui.label(egui::RichText::new("Turn this on, then drag objects while the scene plays.").small()); }
                    });
                }
                let Some(s) = self.doc.scene.as_mut() else { ui.label("File > New scene, or open a scene file (.json) or a bake (.splc), to edit its scene."); return; };
                if self.ws_bake && self.doc.cache.is_some() { ui.label(egui::RichText::new("Changes apply to the next bake; the bake shown stays as it was.").small()); }
                let changed = match tab {
                    Tab::Sim => crate::edit::settings(ui, &mut s.json, &mut self.find),
                    Tab::Scene => crate::edit::tank(ui, &mut s.json),
                    _ => {
                        let before = self.sel;
                        let mut act = None;
                        let ch = crate::edit::objects(ui, &mut s.json, &mut self.sel, self.st, &mut self.doc.hidden, &mut act, false);
                        if self.sel != before { self.sel_set = self.sel.into_iter().collect(); }
                        self.obj_act = act;
                        ch
                    }
                };
                if changed { self.edited(); }
                match self.obj_act.take() {
                    Some("dup") => self.duplicate(egui::pos2(0.0, 0.0)),
                    Some("del") => self.delete_selected(),
                    Some("clearrec") => {
                        if let Some(s) = self.doc.scene.as_mut() {
                            for o in s.json["objs"].as_array_mut().into_iter().flatten() { o["rec"] = Value::Null; }
                            s.json["events"] = serde_json::json!([]);
                        }
                        self.edited();
                    }
                    _ => {}
                }
                return;
            }
            if tab == Tab::Display { self.display_tab(ui); return; }
            ui.heading("Performance");
            ui.horizontal(|ui| {
                ui.label("From");
                ui.add(egui::DragValue::new(&mut self.bench_at).range(0.0..=60.0).speed(0.05).max_decimals(2).suffix(" s"));
                ui.add(egui::DragValue::new(&mut self.bench_steps).range(5..=600).suffix(" steps"));
                let can = self.doc.scene.is_some() && !self.worker.busy();
                if ui.add_enabled(can, egui::Button::new("Solver benchmark")).on_hover_text("Simulates the scene (Bake tab spacing) up to that moment, then times that many steps, every stage on the GPU (the page's Solver benchmark). Nothing is saved.").clicked() {
                    let scene = self.doc.scene.as_ref().unwrap().json.clone();
                    let o = splash_sim::scene::BakeOpts { spacing: self.bake.spacing(), seconds: Some(self.scene_dur().max(self.bench_at as f64 + 1.0) as f32), detail: Some(1.0), max_points: None, accurate: None };
                    *self.bench.lock().unwrap() = None;
                    self.worker.start("Solver benchmark".into(), crate::bake_cli::Task { kind: crate::bake_cli::Kind::Bench { at: self.bench_at, steps: self.bench_steps, out: self.bench.clone() }, inp: None, scene, o, out: std::env::temp_dir().join("splashtank-bench.splc") });
                }
            });
            if let Some(b) = self.bench.lock().unwrap().as_ref() { ui.label(egui::RichText::new(b.text()).monospace().small()); }
            else if self.worker.busy() && self.worker.job.lock().unwrap().title == "Solver benchmark" { ui.label("Running..."); }
            ui.separator();
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
            ui.heading("GPU");
            ui.label(&self.gpu);
            let mut mb = (self.r.budget >> 20) as u32;
            if ui.add(egui::Slider::new(&mut mb, 256..=16384).logarithmic(true).text("MB of frames kept")).changed() { self.r.budget = (mb as u64) << 20; }
            ui.label(format!("{} frames kept, {} MB, {} uploads", self.r.kept_frames(), self.r.kept_bytes >> 20, self.r.uploads));
            ui.label(format!("{:.1} ms a frame ({:.0} a second)", self.frame_ms, 1000.0 / self.frame_ms.max(0.1)));
        }
    }

    /// The Display tab: how the water is drawn.
    fn display_tab(&mut self, ui: &mut egui::Ui) {
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
            ui.checkbox(&mut self.look.fog, "Mist and smoke").on_hover_text("The cloud kept with the bake, drawn as see-through fog.");
            ui.add(egui::Slider::new(&mut self.look.fog_k, 0.1..=5.0).logarithmic(true).text("Mist look")).on_hover_text("How thick the cloud is drawn. Only changes the picture, not the bake.");
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
        if let Some(p) = dropped.last() { if self.may_discard() { self.open(p); } }
        let n = self.frames();
        // the page's keys: Space plays, Left/Right step a frame, Shift+Left/Right go to the ends, Home (or F) frames the tank, 1/3/7 look
        // along an axis (with Ctrl from the other side), 5 switches perspective and orthographic
        let typing = ui.ctx().egui_wants_keyboard_input();
        let (space, left, right, home, shift, ctrl) = ui.input(|i| (i.key_pressed(egui::Key::Space), i.key_pressed(egui::Key::ArrowLeft),
            i.key_pressed(egui::Key::ArrowRight), i.key_pressed(egui::Key::Home), i.modifiers.shift, i.modifiers.command));
        let (k1, k3, k5, k7, kf) = ui.input(|i| (i.key_pressed(egui::Key::Num1), i.key_pressed(egui::Key::Num3), i.key_pressed(egui::Key::Num5),
            i.key_pressed(egui::Key::Num7), i.key_pressed(egui::Key::F)));
        let _ = n;
        if !typing {
            // the one timeline: Space plays, Left/Right a frame, Shift to the ends, Up/Down to the next or last key; I keys, Alt+I unkeys
            let (up, down, ki, alt) = ui.input(|i| (i.key_pressed(egui::Key::ArrowUp), i.key_pressed(egui::Key::ArrowDown), i.key_pressed(egui::Key::I), i.modifiers.alt));
            if self.tf.is_none() && self.etf.is_none() {
                let step = self.tl_step();
                if space { self.play(); }
                if left || right || up || down { self.splay = false; self.bake.follow = false; }
                if left { self.set_time(if shift { 0.0 } else { self.st - step }); }
                if right { let d = self.tl_dur(); self.set_time(if shift { d } else { self.st + step }); }
                if up { if let Some(t) = self.key_times().into_iter().find(|&t| t > self.st + 1e-6) { self.set_time(t); } }
                if down { if let Some(t) = self.key_times().into_iter().rev().find(|&t| t < self.st - 1e-6) { self.set_time(t); } }
                if self.editing() && ki && !ctrl && self.edit.is_none() { self.key_selected(alt); }
                if self.editing() && ki && ctrl && self.edit.is_none() { self.invert_selection(); }
                // Delete with a key picked on the timeline, wherever the mouse is
                if ui.input(|i| i.key_pressed(egui::Key::Delete)) && self.sel_key.is_some() && self.edit.is_none() { self.delete_keys(); }
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
        if std::mem::take(&mut self.ctx_attention) { ui.ctx().send_viewport_cmd(egui::ViewportCommand::RequestUserAttention(egui::UserAttentionType::Informational)); }
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
        if self.bake.queue_run && !self.worker.busy() && !self.was_busy && self.saving.is_none() {
            if self.bake.queue.is_empty() { self.bake.queue_run = false; self.msg = "The queue is finished.".into(); }
            else { let (t, task) = self.bake.queue.remove(0); self.act(Action::Start(format!("Queue: {t}"), task)); }
        }
        // the scene every minute while it has changes that are not saved, for after a crash
        if self.dirty && self.tf.is_none() && self.autosaved.elapsed().as_secs() >= 60 {
            self.autosaved = Instant::now();
            if let (Some(s), Some(p)) = (&self.doc.scene, autosave_path()) {
                let _ = std::fs::create_dir_all(p.parent().unwrap());
                let _ = s.save(&p);
                crate::bakeui::set_setting("autosaveOf", serde_json::json!(self.scene_path.as_ref().map(|q| q.display().to_string())));
            }
        }
        self.look.region = (self.bake.det_open && self.tab == Tab::Bake).then_some((self.bake.det.c, self.bake.det.s));
        self.doc.selected = if self.editing() { self.sel_set.iter().filter_map(|&k| self.objs().get(k)?["id"].as_u64()).collect() } else { Vec::new() };
        // recording: every object's place this frame (the page's recordStep, at 60 a second, gaps filled with the last place)
        if self.rec_on && self.splay {
            let fr = (self.st * 60.0).round() as i64;
            let poses: Vec<(u64, [f64; 4])> = self.objs().iter().filter_map(|o| Some((o["id"].as_u64()?, [o["x"].as_f64()?, o["y"].as_f64()?, o["z"].as_f64()?, o["yaw"].as_f64().unwrap_or(0.0)]))).collect();
            for (id, p) in poses {
                let e = self.rec_buf.entry(id).or_insert((fr, Vec::new()));
                let have = e.0 + (e.1.len() / 4) as i64;
                if e.1.len() >= 4 { let last: Vec<f64> = e.1[e.1.len() - 4..].to_vec(); for _ in have..fr { e.1.extend_from_slice(&last); } }
                if have <= fr { e.1.extend_from_slice(&p); }
            }
        } else if self.rec_on && !self.splay && !self.rec_buf.is_empty() { self.rec_stop(); }
        if self.splay && self.tf.is_none() {
            // playing: the time runs on (keyed objects move, the water shown follows); at the end Hold and Stop stop there, Loop goes
            // round, and the live water always goes round
            let d = self.tl_dur();
            let t = self.st + dt.min(0.1) as f64;
            let looping = self.end_mode() == "loop" || (self.live && !self.ws_bake);
            if t > d { if looping { self.st = 0.0; } else { self.splay = false; self.st = d; } } else { self.st = t; }
            self.apply_keys();
            ui.ctx().request_repaint();
        }
        // a bake being saved by copying: done
        if let Some(rx) = &self.saving {
            if let Ok(r) = rx.try_recv() {
                self.saving = None;
                match r { Ok(p) => { self.path = None; self.follow(&p); self.msg = format!("Saved the bake as {}", p.display()); } Err(e) => { self.msg = e.clone(); if let Some(p) = self.path.clone() { self.path = None; self.follow(&p); } } }
            } else { ui.ctx().request_repaint_after(std::time::Duration::from_millis(200)); }
        }
        // a change that has ended (nothing changed this frame, no move going on): the scene now at rest is what undo goes back to
        if self.burst && !self.changed_now && self.tf.is_none() { self.stable = self.doc.scene.as_ref().map(|s| s.json.clone()); self.burst = false; }
        // the live sim starts again once a change has ended (not on every step of a drag)
        // live water: its first frames when a scene opens; after a change, by itself only with Simulate ahead on, once the change has
        // been over for a moment and nothing is held down
        if self.live && !self.ws_bake && !self.live_tried && !self.worker.busy() { self.live_start(); }
        if self.live && self.live_stale && self.ahead && !self.ws_bake && !self.burst && self.tf.is_none() && !self.worker.busy() {
            if self.last_change.elapsed().as_secs_f32() > 0.8 && !ui.input(|i| i.pointer.any_down()) { self.live_start(); } else { ui.ctx().request_repaint_after(std::time::Duration::from_millis(200)); }
        }
        // how far it may go: all the way with Simulate ahead; otherwise a second past the playhead while playing, a frame past it when not
        {
            let f = (self.st * self.live_fps()) as u32;
            let lim = if self.ahead { u32::MAX } else if self.ws_bake { 0 } else if self.splay { f + 24 } else { f + 1 };
            self.live_w.limit.store(lim, std::sync::atomic::Ordering::Relaxed);
        }
        if self.live {
            self.live_poll();
            let busy = self.live_w.busy();
            // while it computes, playing in the Live workspace waits at the newest frame (the page's live view)
            if let (false, true, Some(c)) = (self.ws_bake, busy, self.live_cache()) {
                let newest = c.frames.len().saturating_sub(1) as f64 / c.info.fps.max(1.0) as f64;
                if self.splay && self.st > newest { self.st = newest; }
            }
            if busy { ui.ctx().request_repaint_after(std::time::Duration::from_millis(100)); }
        }
        // a bake being written: the view shows its newest frame (until the playhead is moved)
        if self.ws_bake && self.worker.busy() && self.bake.follow { let n = self.frames(); if n > 0 { self.st = (n - 1) as f64 / self.fps() as f64; } }
        // the frame shown, from the time
        let n = self.frames();
        self.t = if n > 0 { (self.st * self.fps() as f64).clamp(0.0, (n - 1) as f64) } else { 0.0 };
        if (self.t - self.t.round()).abs() < 1e-4 { self.t = self.t.round(); }
        // in the Live workspace objects are drawn where the scene has them (they are being edited); a bake draws them where it baked them
        self.look.scene_objs = !self.ws_bake;
        self.changed_now = false;
        // Ctrl+S saves the scene; closing the window with unsaved edits asks first
        if ui.input(|i| i.modifiers.command && i.key_pressed(egui::Key::S)) && self.doc.scene.is_some() { self.save_scene(false); }
        if ui.ctx().input(|i| i.viewport().close_requested()) && self.may_discard() { forget_autosave(); self.save_look(); }
        else if ui.ctx().input(|i| i.viewport().close_requested()) {
            ui.ctx().send_viewport_cmd(egui::ViewportCommand::CancelClose);
        }
        if ui.input(|i| i.key_pressed(egui::Key::F3)) { self.tab = Tab::Sim; self.set_ws(false); }

        if self.splay && n > 0 {
            if let Some(c) = &self.doc.cache {
                let f = self.t.floor() as usize;
                let next: Vec<usize> = (1..=3).map(|k| (f + k) % n).filter(|&k| !self.r.is_kept(k)).collect();
                if !next.is_empty() { let _ = self.readahead.send((c.clone(), next)); }
            }
            ui.ctx().request_repaint();
        }

        let t_before = now.elapsed().as_secs_f32() * 1000.0;
        egui::Panel::top("top").show(ui, |ui| self.top(ui));
        egui::Panel::bottom("status").show(ui, |ui| self.status(ui));
        let kf = egui::Panel::bottom("timeline").resizable(self.kf_open).min_size(if self.kf_open { 120.0 } else { 0.0 });
        let kf = if self.kf_open { kf.default_size(190.0) } else { kf };
        kf.show(ui, |ui| self.timeline(ui));
        egui::Panel::right("side").default_size(430.0).min_size(360.0).show(ui, |ui| self.side(ui));
        egui::CentralPanel::default().frame(egui::Frame::NONE).show(ui, |ui| {
            let avail = ui.available_size();
            let ppp = ui.ctx().pixels_per_point();
            let size = [((avail.x * ppp) as u32).max(16), ((avail.y * ppp) as u32).max(16)];
            self.ensure_target(&rs, size);
            let f = (self.t.floor() as usize).min(n.saturating_sub(1));
            // the water blends from this frame towards the next while playing (paused, the frame is shown as it is)
            let (fb, w) = if n > 1 && self.t.fract() > 0.0 { ((f + 1).min(n - 1), self.t.fract() as f32) } else { (f, 0.0) };
            // while paused, put the following frames on the GPU too, one per redraw, as long as they fit the budget (like the page's idleFill)
            if ui.input(|i| !i.events.is_empty() || i.pointer.is_moving()) { self.last_input = now; }
            if !self.splay && n > 1 && self.r.kept_bytes < self.r.budget * 9 / 10 && self.last_input.elapsed().as_secs_f32() > 0.5 {
                if let Some(k) = (1..n).map(|k| (f + k) % n).find(|&k| !self.r.is_kept(k)) {
                    self.r.load(&rs.device, &rs.queue, &self.doc, k);
                    ui.ctx().request_repaint();
                }
            }
            let t = self.target.as_ref().unwrap();
            let mut enc = rs.device.create_command_encoder(&Default::default());
            // what this frame draws with: the time shown, and Bake playback's lighter look when asked for or when playing falls behind
            let mut lk = self.look;
            lk.time = self.st as f32;
            if self.pb == 2 || (self.pb == 1 && self.splay && self.frame_ms > 30.0) { lk.detail = 0; lk.spr_detail = lk.spr_detail.min(1); }
            self.r.draw(&rs.device, &rs.queue, &mut enc, &t.color.create_view(&Default::default()), size, &self.cam, &self.doc, f, fb, w, &lk);
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
                    self.posed();
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
        if self.trace {
            let ms = now.elapsed().as_secs_f32() * 1000.0;
            if ms > 25.0 {
                use std::io::Write;
                if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(std::env::temp_dir().join("splash-trace.txt")) {
                    let _ = writeln!(f, "{ms:.0} ms (before panels {t_before:.0}), bake workspace {}, tab {:?}, live busy {}", self.ws_bake, TABS.iter().find(|x| x.0 == self.tab).map(|x| x.1), self.live_w.busy());
                }
            }
        }
    }
}
