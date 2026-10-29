//! The Bake panel: bakes, Resume, Bake whitewater and Detail run on a worker thread with their own GPU device (made once, so the shaders
//! compile once); the window shows their progress and, while a cache is being written, its newest frame.

use crate::bake_cli::{self, Kind, Note, Task};
use eframe::egui;
use splash_sim::detail::DetailOpts;
use splash_sim::scene::BakeOpts;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Default)]
pub struct Prog { pub f: u32, pub frames: u32, pub n: u32, pub sub: u32, pub frame_ms: f32, pub elapsed: f32 }

#[derive(Default)]
pub struct Job {
    pub busy: bool,
    pub title: String,
    pub out: Option<PathBuf>,
    pub prog: Option<Prog>,
    pub log: Vec<String>,
    /// how the last task ended: what to say, and whether it went wrong
    pub result: Option<(String, bool)>,
    /// frames finished so far: the window reopens the cache being written when this changes
    pub done: u32,
    /// the task is about to finish its cache: the window lets go of the file (finishing may replace it on disk, which Windows refuses
    /// while the file is mapped) and says so in released
    pub finishing: bool,
    pub released: bool,
}

pub struct Worker { tx: mpsc::Sender<Task>, pub job: Arc<Mutex<Job>>, cancel: Arc<AtomicBool> }

impl Worker {
    pub fn new(ctx: egui::Context) -> Worker {
        let (tx, rx) = mpsc::channel::<Task>();
        let job = Arc::new(Mutex::new(Job::default()));
        let cancel = Arc::new(AtomicBool::new(false));
        let (j, c) = (job.clone(), cancel.clone());
        std::thread::spawn(move || {
            let mut gpu = None;
            while let Ok(t) = rx.recv() {
                let t0 = Instant::now();
                let r = bake_cli::execute(&t, &mut gpu, &mut |n| {
                    let last = {
                        let mut s = j.lock().unwrap();
                        match n {
                            Note::Line(l) => { s.log.push(l); false }
                            Note::Frame(p) => {
                                s.prog = Some(Prog { f: p.f, frames: p.frames, n: p.n, sub: p.sub, frame_ms: p.frame_ms, elapsed: p.elapsed });
                                s.done = p.f + 1;
                                let last = c.load(Ordering::Relaxed) || p.f >= p.frames;
                                if last { s.finishing = true; }
                                last
                            }
                        }
                    };
                    ctx.request_repaint();
                    if last {
                        let w = Instant::now();
                        while !j.lock().unwrap().released && w.elapsed() < Duration::from_secs(5) { std::thread::sleep(Duration::from_millis(10)); ctx.request_repaint(); }
                    }
                    !c.load(Ordering::Relaxed)
                });
                let mut s = j.lock().unwrap();
                let secs = t0.elapsed().as_secs_f32();
                s.result = Some(match r {
                    Ok(()) if c.load(Ordering::Relaxed) => (format!("Stopped after {}; the frames so far are in the file.", hms(secs)), false),
                    Ok(()) => (format!("Done in {}.", hms(secs)), false),
                    Err(e) => (e, true),
                });
                s.busy = false;
                s.finishing = false;
                ctx.request_repaint();
            }
        });
        Worker { tx, job, cancel }
    }

    pub fn start(&self, title: String, t: Task) {
        *self.job.lock().unwrap() = Job { busy: true, title, out: Some(t.out.clone()), ..Default::default() };
        self.cancel.store(false, Ordering::Relaxed);
        let _ = self.tx.send(t);
    }
    pub fn stop(&self) { self.cancel.store(true, Ordering::Relaxed); }
    pub fn busy(&self) -> bool { self.job.lock().unwrap().busy }
}

fn hms(s: f32) -> String {
    let s = s.round() as u32;
    if s >= 3600 { format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60) } else if s >= 60 { format!("{}:{:02}", s / 60, s % 60) } else { format!("{s} s") }
}

/// What the panel asks the window to do.
pub enum Action { Start(String, Task), Stop }

/// The settings in the panel (the page's Bake settings), taken from the file opened last.
pub struct BakeUi {
    src: Option<PathBuf>,
    spacing: f32,
    seconds: f32,
    quality: f32,
    auto_max: bool,
    max_m: f32,
    accurate: bool,
    water_only: bool,
    ckpt_min: f32,
    pub det: DetailOpts,
    /// the Detail section is open: the region is shown in the view
    pub det_open: bool,
    /// the view shows the newest frame of the cache being written (until the playhead is moved)
    pub follow: bool,
    /// a stopped bake that can carry on: its cache and what its checkpoint says
    resumable: Option<(PathBuf, String)>,
}

impl Default for BakeUi {
    fn default() -> BakeUi {
        BakeUi { src: None, spacing: 0.04, seconds: 5.0, quality: 1.0, auto_max: true, max_m: 4.0, accurate: false, water_only: false, ckpt_min: 5.0,
            det: DetailOpts::default(), det_open: false, follow: true, resumable: None }
    }
}

/// next to p, named after it with a suffix
fn beside(p: &Path, suffix: &str) -> PathBuf {
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "bake".into());
    p.with_file_name(format!("{stem}{suffix}.splc"))
}

/// The save dialog, starting at def.
fn save_as(title: &str, def: &Path) -> Option<PathBuf> {
    let mut d = rfd::FileDialog::new().set_title(title).add_filter("Bake cache", &["splc"]);
    if let Some(dir) = def.parent() { d = d.set_directory(dir); }
    if let Some(n) = def.file_name() { d = d.set_file_name(n.to_string_lossy()); }
    d.save_file().map(|p| if p.extension().is_none() { p.with_extension("splc") } else { p })
}

impl BakeUi {
    /// A file was opened: its bake settings fill the panel (a scene file holds no live spacing, so the spacing stays as it was).
    pub fn source(&mut self, p: &Path) {
        self.src = Some(p.to_owned());
        if p.extension().is_some_and(|e| e.eq_ignore_ascii_case("splc")) {
            if let Ok((_, o)) = bake_cli::from_cache(p) {
                self.spacing = o.spacing;
                if let Some(s) = o.seconds { self.seconds = s; }
                if let Some(q) = o.detail { self.quality = q; }
                self.accurate = o.accurate.unwrap_or(false);
            }
            self.check_resume(p);
        } else if let Ok(v) = bake_cli::read_json(p) {
            self.settings_of(&v);
        }
    }
    /// The scene was saved to p: it is now where bakes default to (settings in the panel stay as they are).
    pub fn saved_as(&mut self, p: &Path) { if self.src.as_ref().is_none_or(|s| !s.extension().is_some_and(|e| e.eq_ignore_ascii_case("splc"))) { self.src = Some(p.to_owned()); } }
    /// A new scene (not a file yet): its bake settings, and its name for the panel and the default file name.
    pub fn source_scene(&mut self, name: &str, v: &serde_json::Value) {
        self.src = Some(PathBuf::from(format!("{name}.json")));
        self.resumable = None;
        self.settings_of(v);
    }
    pub fn set_seconds(&mut self, s: f32) { self.seconds = s; }
    fn settings_of(&mut self, v: &serde_json::Value) {
        let bk = &v["bake"];
        self.seconds = bk["dur"].as_f64().unwrap_or(5.0) as f32;
        self.quality = bk["detail"].as_f64().unwrap_or(1.0) as f32;
        self.accurate = bk["accuracy"].as_str() == Some("accurate");
    }

    /// Looks for a checkpoint next to the cache at out (a bake that stopped before its end).
    pub fn check_resume(&mut self, out: &Path) {
        let ck = splash_sim::bake::checkpoint_path(out);
        self.resumable = if ck.exists() {
            match splash_sim::bake::read_checkpoint(&ck) {
                Ok((v, _)) => Some((out.to_owned(), format!("{} stopped after frame {}. It can carry on from there.", out.file_name().unwrap_or_default().to_string_lossy(), v["frame"]))),
                Err(_) => None,
            }
        } else if self.resumable.as_ref().is_some_and(|r| r.0 == out) { None } else { self.resumable.take() };
    }

    fn opts(&self) -> BakeOpts {
        BakeOpts { spacing: self.spacing, seconds: Some(self.seconds), detail: Some(self.quality),
            max_points: (!self.auto_max).then(|| (self.max_m * 1e6) as u32), accurate: Some(self.accurate) }
    }

    /// scene: the scene as edited in the window (what gets baked); cache: the bake shown now (Bake whitewater and Detail work on it).
    pub fn panel(&mut self, ui: &mut egui::Ui, w: &Worker, scene: Option<&serde_json::Value>, cache: Option<&Path>) -> Option<Action> {
        let mut act = None;
        let busy = w.busy();
        ui.heading("Bake");
        let Some(src) = self.src.clone() else {
            ui.label("Open a scene file (.json) or a bake (.splc) to bake it here.");
            return None;
        };
        let is_cache = src.extension().is_some_and(|e| e.eq_ignore_ascii_case("splc"));
        let Some(scene) = scene.cloned() else {
            ui.label("This cache holds no scene, so it cannot be baked again.");
            return None;
        };
        // a new scene has only a name (no folder) until it is saved
        if src.parent().is_some_and(|p| p.as_os_str().is_empty()) { ui.label(format!("The new scene {}, as edited here", src.file_stem().unwrap_or_default().to_string_lossy())); }
        else { ui.label(format!("The scene from {}, as edited here", src.file_name().unwrap_or_default().to_string_lossy())); }
        ui.add_enabled_ui(!busy, |ui| {
            egui::Grid::new("bakeset").num_columns(2).spacing([8.0, 4.0]).show(ui, |ui| {
                ui.label("Spacing").on_hover_text("The live particle spacing (the page's Simulation > Spacing). The bake's spacing is this divided by Quality.");
                ui.add(egui::DragValue::new(&mut self.spacing).range(0.003..=0.3).speed(0.0005).max_decimals(4));
                ui.end_row();
                ui.label("Length, s");
                ui.add(egui::DragValue::new(&mut self.seconds).range(0.05..=600.0).speed(0.05).max_decimals(2));
                ui.end_row();
                ui.label("Quality").on_hover_text("Preview bakes at the live spacing, Final 1.5 times finer, Fine 2 times finer.");
                ui.horizontal(|ui| {
                    for (q, n) in [(1.0, "Preview"), (1.5, "Final"), (2.0, "Fine")] { ui.selectable_value(&mut self.quality, q, n); }
                });
                ui.end_row();
                ui.label("Max points").on_hover_text("Auto: the scene's own, and for narrow band bakes 2.5 times the starting water, as far as the card's free memory allows.");
                ui.horizontal(|ui| {
                    ui.checkbox(&mut self.auto_max, "Auto");
                    if !self.auto_max { ui.add(egui::DragValue::new(&mut self.max_m).range(0.1..=40.0).speed(0.05).max_decimals(1).suffix(" M")); }
                });
                ui.end_row();
                ui.label("Accuracy").on_hover_text("Accurate: smaller steps, more substeps, and the pressure solved until under 0.1% is left. Slower.");
                ui.checkbox(&mut self.accurate, "Accurate");
                ui.end_row();
                ui.label("Whitewater").on_hover_text("Water only bakes without whitewater, air and drips (the page's Bake water); Bake whitewater makes it afterwards.");
                ui.checkbox(&mut self.water_only, "Water only");
                ui.end_row();
                ui.label("Checkpoint").on_hover_text("How often the bake saves its state next to the cache, so a stopped or crashed bake can carry on. 0: never.");
                ui.add(egui::DragValue::new(&mut self.ckpt_min).range(0.0..=120.0).speed(0.1).max_decimals(1).suffix(" min"));
                ui.end_row();
            });
            if ui.button("Bake...").on_hover_text("Choose where to save the cache, then bake. The view follows the newest frame.").clicked() {
                let def = beside(&src, if is_cache { "-again" } else { "-native" });
                if let Some(out) = save_as("Save the bake as", &def) {
                    let kind = Kind::Bake { water_only: self.water_only, checkpoint_secs: self.ckpt_min * 60.0 };
                    act = Some(Action::Start(format!("Baking {}", out.file_name().unwrap_or_default().to_string_lossy()), Task { kind, inp: None, scene: scene.clone(), o: self.opts(), out }));
                }
            }
            if let Some((out, say)) = self.resumable.clone().filter(|_| !busy) {
                ui.label(say);
                if ui.button("Resume").on_hover_text("Carry on the stopped bake from its last checkpoint, with the settings it was started with.").clicked() {
                    act = Some(Action::Start(format!("Carrying on {}", out.file_name().unwrap_or_default().to_string_lossy()),
                        Task { kind: Kind::Resume, inp: None, scene: serde_json::Value::Null, o: BakeOpts::default(), out }));
                }
            }
            if ui.button("Resume a bake...").on_hover_text("Pick a stopped bake's cache (.splc) to carry on from its checkpoint.").clicked() {
                if let Some(p) = rfd::FileDialog::new().add_filter("Bake cache", &["splc"]).pick_file() {
                    self.check_resume(&p);
                    if self.resumable.as_ref().is_none_or(|r| r.0 != p) { w.job.lock().unwrap().result = Some(("That bake has no checkpoint to carry on from.".into(), true)); }
                }
            }
        });
        if let Some(c) = cache {
            ui.separator();
            ui.label(format!("On the bake shown ({})", c.file_name().unwrap_or_default().to_string_lossy()));
            ui.add_enabled_ui(!busy, |ui| {
                if ui.button("Bake whitewater...").on_hover_text("Whitewater made from this bake's water, with its scene's whitewater settings; saved as a new cache.").clicked() {
                    if let Some(out) = save_as("Save with whitewater as", &beside(c, "-ww")) {
                        match bake_cli::from_cache(c) {
                            Ok((_, o)) => act = Some(Action::Start(format!("Whitewater for {}", out.file_name().unwrap_or_default().to_string_lossy()),
                                Task { kind: Kind::Whitewater, inp: Some(c.to_owned()), scene: scene.clone(), o, out })),
                            Err(e) => w.job.lock().unwrap().result = Some((e, true)),
                        }
                    }
                }
                let r = egui::CollapsingHeader::new("Detail").default_open(false).show(ui, |ui| {
                    ui.label("A finer sim over a region of this bake, guided by it. The region is the dashed blue box.");
                    egui::Grid::new("detset").num_columns(4).spacing([6.0, 4.0]).show(ui, |ui| {
                        ui.label("");
                        for a in ["x", "y", "z"] { ui.label(a); }
                        ui.end_row();
                        ui.label("Centre").on_hover_text("Where the region is, as shares of the tank (0.5: the middle).");
                        for k in 0..3 { ui.add(egui::DragValue::new(&mut self.det.c[k]).range(0.0..=1.0).speed(0.005).max_decimals(2)); }
                        ui.end_row();
                        ui.label("Size").on_hover_text("How big the region is, as shares of the tank (1: all of it).");
                        for k in 0..3 { ui.add(egui::DragValue::new(&mut self.det.s[k]).range(0.05..=1.0).speed(0.005).max_decimals(2)); }
                        ui.end_row();
                    });
                    ui.horizontal(|ui| {
                        ui.label("Finer");
                        ui.selectable_value(&mut self.det.k, 2, "2x");
                        ui.selectable_value(&mut self.det.k, 3, "3x");
                    });
                    ui.add(egui::Slider::new(&mut self.det.pull, 0.0..=1.0).step_by(0.01).text("Follow the bake"))
                        .on_hover_text("How strongly the fine water is pulled towards the bake's motion each frame.");
                    if ui.button("Bake detail...").clicked() {
                        if let Some(out) = save_as("Save with detail as", &beside(c, "-detail")) {
                            match bake_cli::from_cache(c) {
                                Ok((_, o)) => act = Some(Action::Start(format!("Detail for {}", out.file_name().unwrap_or_default().to_string_lossy()),
                                    Task { kind: Kind::Detail(self.det), inp: Some(c.to_owned()), scene: scene.clone(), o, out })),
                                Err(e) => w.job.lock().unwrap().result = Some((e, true)),
                            }
                        }
                    }
                });
                self.det_open = r.body_returned.is_some();
            });
        } else { self.det_open = false; }

        // progress
        let j = w.job.lock().unwrap();
        if j.busy || j.result.is_some() || !j.log.is_empty() { ui.separator(); }
        if j.busy {
            ui.label(egui::RichText::new(&j.title).strong());
            if let Some(p) = j.prog {
                let share = if p.frames > 0 { p.f as f32 / p.frames as f32 } else { 0.0 };
                let left = if p.f > 0 { p.elapsed / p.f as f32 * (p.frames - p.f) as f32 } else { 0.0 };
                ui.add(egui::ProgressBar::new(share).text(format!("frame {} of {}", p.f, p.frames)));
                ui.label(format!("{} points, {} substeps, {:.0} ms a frame", p.n, p.sub, p.frame_ms));
                ui.label(format!("{} so far, about {} left", hms(p.elapsed), hms(left)));
            } else {
                ui.add(egui::ProgressBar::new(0.0).text("starting").animate(true));
            }
            ui.horizontal(|ui| {
                if ui.button("Stop").on_hover_text("Stop now. The frames so far stay in the file, and a bake's checkpoint stays so it can carry on later.").clicked() { act = Some(Action::Stop); }
                ui.checkbox(&mut self.follow, "Show the newest frame");
            });
        }
        if let Some((s, bad)) = &j.result {
            if *bad { ui.colored_label(egui::Color32::from_rgb(0xe0, 0x60, 0x50), s); } else { ui.label(s); }
        }
        if !j.log.is_empty() {
            egui::CollapsingHeader::new("Messages").default_open(true).show(ui, |ui| {
                for l in j.log.iter().rev().take(12).collect::<Vec<_>>().into_iter().rev() { ui.label(egui::RichText::new(l).small()); }
            });
        }
        act
    }
}
