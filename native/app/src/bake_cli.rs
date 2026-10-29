//! Bakes, for the command line and the window's Bake panel alike (one Task, run by `execute`, reporting through a callback).
//! `--bake`: a headless bake from a scene file, or again from a page cache's scene and settings, streamed to a cache file.
//! `--detail-pass`: a finer sim over a region of a finished bake, guided by it (the page's Detail), written to a new cache.
//! `--bake-whitewater`: whitewater made afterwards from a finished bake's water (the page's Bake whitewater), written to a new cache.
//! `--resume out.splc`: carries on a bake that stopped (a crash, a power cut, closing it) from its last checkpoint.

use serde_json::Value;
use splash_sim::bake::{self, Progress};
use splash_sim::detail::DetailOpts;
use splash_sim::gpu::Gpu;
use splash_sim::scene::{desc_from_scene, BakeOpts, Desc};
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Clone)]
pub enum Kind {
    /// a bake from the scene (water_only: the page's Bake water)
    Bake { water_only: bool, checkpoint_secs: f32 },
    /// carries on the bake at out from its checkpoint (its scene and settings come from there)
    Resume,
    /// whitewater made from the finished bake at inp
    Whitewater,
    /// a finer sim over a region of the finished bake at inp
    Detail(DetailOpts),
    /// the live sim: a bake of the scene whose frames go to the window (the header, then one message a frame) instead of a file
    Live(std::sync::mpsc::Sender<Vec<u8>>),
}

#[derive(Clone)]
pub struct Task { pub kind: Kind, pub inp: Option<PathBuf>, pub scene: Value, pub o: BakeOpts, pub out: PathBuf }

/// What a task tells whoever runs it: a remark, or a frame done (returning false stops the task).
pub enum Note<'a> { Line(String), Frame(&'a Progress) }

/// A cache's scene and the settings it was baked with: live spacing (the bake's spacing times its detail), length, detail, accuracy.
pub fn from_cache(path: &Path) -> Result<(Value, BakeOpts), String> {
    let c = splash_format::Cache::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let m = &c.info.meta;
    let det = m.pointer("/desc/detail").and_then(Value::as_f64).unwrap_or(1.0) as f32;
    // the length it was meant to have (a stopped bake has fewer frames), else what it holds
    let frames = m.pointer("/desc/frames").and_then(Value::as_u64).unwrap_or(c.frames.len().saturating_sub(1) as u64);
    let o = BakeOpts {
        spacing: c.info.d * det, detail: Some(det), seconds: Some(frames as f32 / c.info.fps),
        accurate: m.pointer("/desc/accurate").and_then(Value::as_bool), max_points: None,
    };
    let scene = m.get("scene").cloned().filter(Value::is_object).ok_or("That cache has no scene in its header.")?;
    Ok((scene, o))
}

pub fn read_json(p: &Path) -> Result<Value, String> {
    serde_json::from_slice(&std::fs::read(p).map_err(|e| format!("{}: {e}", p.display()))?).map_err(|e| format!("{}: {e}", p.display()))
}

/// The scene and settings with water_only taken into account.
fn desc_of(scene: &Value, o: &BakeOpts, water_only: bool) -> Result<Desc, String> {
    let mut desc = desc_from_scene(scene, o)?;
    // the page's Bake water: the water without whitewater (Bake whitewater makes it afterwards)
    if water_only { desc.spr = None; desc.spray_cap = 0; desc.air = None; desc.drip = None; }
    Ok(desc)
}

/// Runs a task to the end (or until report returns false; a stopped bake keeps its frames and its checkpoint). gpu: made on first use and
/// kept, so the shaders compile once.
pub fn execute(t: &Task, gpu: &mut Option<Gpu>, report: &mut dyn FnMut(Note) -> bool) -> Result<(), String> {
    if gpu.is_none() {
        let g = Gpu::new()?;
        report(Note::Line(format!("{}; shaders ready in {:.0} ms", g.describe(), g.compile_ms)));
        *gpu = Some(g);
    }
    let gpu = gpu.as_ref().unwrap();
    match &t.kind {
        Kind::Detail(d) => {
            let inp = t.inp.as_ref().ok_or("Detail works on a finished bake.")?;
            let c = splash_format::Cache::open(inp).map_err(|e| e.to_string())?;
            let desc = desc_of(&t.scene, &t.o, false)?;
            report(Note::Line(format!("Detail {}x over {} frames, region centre {:?} size {:?}, follow the bake {}", d.k, c.frames.len(), d.c, d.s, d.pull)));
            splash_sim::detail::run(gpu, &c, &desc, d, &t.out, |p| report(Note::Frame(p)))?;
        }
        Kind::Whitewater => {
            let inp = t.inp.as_ref().ok_or("Bake whitewater works on a finished bake.")?;
            let c = splash_format::Cache::open(inp).map_err(|e| e.to_string())?;
            let desc = desc_of(&t.scene, &t.o, false)?;
            report(Note::Line(format!("Whitewater over {} frames, up to {} points alive", c.frames.len(), desc.spray_cap)));
            bake::whitewater_pass(gpu, &c, &desc, &t.out, |p| report(Note::Frame(p)))?;
        }
        Kind::Bake { water_only, checkpoint_secs } => {
            let desc = desc_of(&t.scene, &t.o, *water_only)?;
            let o = &t.o;
            let started = serde_json::json!({ "scene": t.scene, "waterOnly": water_only, "opts": { "spacing": o.spacing, "seconds": o.seconds, "detail": o.detail, "maxPoints": o.max_points, "accurate": o.accurate } });
            bake_now(gpu, &desc, o, &t.out, bake::RunOpts { checkpoint_secs: *checkpoint_secs, resume: false, started_with: started, ..Default::default() }, report)?;
        }
        Kind::Live(tx) => {
            let desc = desc_of(&t.scene, &t.o, false)?;
            bake::run(gpu, &desc, &t.out, &bake::RunOpts { sink: Some(tx.clone()), ..Default::default() }, |p| report(Note::Frame(p)))?;
        }
        Kind::Resume => {
            let (v, _) = bake::read_checkpoint(&bake::checkpoint_path(&t.out))?;
            let s = &v["startedWith"];
            let op = &s["opts"];
            let o = BakeOpts {
                spacing: op["spacing"].as_f64().ok_or("The checkpoint has no settings.")? as f32,
                seconds: op["seconds"].as_f64().map(|x| x as f32), detail: op["detail"].as_f64().map(|x| x as f32),
                max_points: op["maxPoints"].as_u64().map(|x| x as u32), accurate: op["accurate"].as_bool(),
            };
            let desc = desc_of(&s["scene"], &o, s["waterOnly"].as_bool().unwrap_or(false))?;
            report(Note::Line(format!("Carrying on {} after frame {} of {}", t.out.display(), v["frame"], desc.frames)));
            let secs = v["checkpointEvery"].as_f64().unwrap_or(300.0) as f32;
            bake_now(gpu, &desc, &o, &t.out, bake::RunOpts { checkpoint_secs: secs, resume: true, started_with: s.clone(), ..Default::default() }, report)?;
        }
    }
    Ok(())
}

/// Runs a bake; says at the end when the disk held it back.
fn bake_now(gpu: &Gpu, desc: &Desc, o: &BakeOpts, out: &Path, mut ro: bake::RunOpts, report: &mut dyn FnMut(Note) -> bool) -> Result<(), String> {
    report(Note::Line(format!("Spacing {} (live {} / detail {}), {} frames at {} a second, {} to {} substeps a frame, {} iterations{}",
        desc.d, o.spacing, desc.detail, desc.frames, desc.fps, desc.substeps, desc.max_sub, desc.iters, if desc.accurate { ", Accurate" } else { "" })));
    if !desc.left_out.is_empty() { report(Note::Line(format!("Not in the native solver yet, left out: {}", desc.left_out.join(", ")))); }
    if ro.checkpoint_secs > 0.0 { report(Note::Line(format!("A checkpoint every {:.0} s, so a stopped bake can carry on (Resume)", ro.checkpoint_secs))); }
    // the bake's own remarks come from inside bake::run, which holds report for the frames; they wait here and go out with the next frame
    let said = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let s2 = said.clone();
    ro.log = Some(Arc::new(move |s: &str| s2.lock().unwrap().push(s.to_string())));
    let (mut wait, mut el) = (0.0f32, 0.0f32);
    let r = bake::run(gpu, desc, out, &ro, |p| {
        for s in said.lock().unwrap().drain(..) { report(Note::Line(s)); }
        wait = p.wait; el = p.elapsed;
        report(Note::Frame(p))
    });
    for s in said.lock().unwrap().drain(..) { report(Note::Line(s)); }
    r?;
    if wait > 0.1 * el && wait > 5.0 {
        report(Note::Line(format!("The bake waited {wait:.0} s of {el:.0} s for the disk to take its frames: that drive writes too slowly for this bake. Bake to a faster drive.")));
    }
    Ok(())
}

/// The command line: builds the task from the arguments and prints its progress.
pub fn run(args: &[String]) -> Result<(), String> {
    let flag = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
    let ww = args.iter().any(|a| a == "--bake-whitewater");
    let det = args.iter().any(|a| a == "--detail-pass");
    let task = if let Some(out) = flag("--resume") {
        Task { kind: Kind::Resume, inp: None, scene: Value::Null, o: BakeOpts::default(), out: PathBuf::from(out) }
    } else {
        let cmd = if ww { "--bake-whitewater" } else if det { "--detail-pass" } else { "--bake" };
        let i = args.iter().position(|a| a == cmd).unwrap();
        let (inp, out) = (args.get(i + 1).ok_or(format!("{cmd} needs an input file and an output file"))?, args.get(i + 2).ok_or(format!("{cmd} needs an output file"))?);
        let is_cache = inp.to_ascii_lowercase().ends_with(".splc");
        if (ww || det) && !is_cache { return Err(format!("{cmd} works on a finished bake (.splc).")); }
        let (mut scene, mut o) = if is_cache { from_cache(Path::new(inp))? } else { (read_json(Path::new(inp))?, BakeOpts::default()) };
        // Bake whitewater with the scene as it is now (whitewater settings, colliders), as the page does
        if let Some(p) = flag("--scene") { scene = read_json(Path::new(&p))?; }
        if let Some(v) = flag("--spacing") { o.spacing = v.parse().map_err(|_| "bad --spacing")?; }
        if let Some(v) = flag("--seconds") { o.seconds = Some(v.parse().map_err(|_| "bad --seconds")?); }
        if let Some(v) = flag("--detail") { o.detail = Some(v.parse().map_err(|_| "bad --detail")?); }
        if let Some(v) = flag("--max-points") { o.max_points = Some(v.parse().map_err(|_| "bad --max-points")?); }
        if args.iter().any(|a| a == "--accurate") { o.accurate = Some(true); }
        let kind = if det {
            let mut d = DetailOpts::default();
            if let Some(v) = flag("--region") {
                let a: Vec<f32> = v.split(',').map(|x| x.trim().parse::<f32>()).collect::<Result<_, _>>().map_err(|_| "bad --region")?;
                if a.len() != 6 { return Err("--region takes cx,cy,cz,sx,sy,sz as shares of the tank (0-1)".into()); }
                d.c = [a[0], a[1], a[2]]; d.s = [a[3], a[4], a[5]];
            }
            if let Some(v) = flag("--k") { d.k = v.parse().map_err(|_| "bad --k")?; }
            if let Some(v) = flag("--pull") { d.pull = v.parse().map_err(|_| "bad --pull")?; }
            Kind::Detail(d)
        } else if ww { Kind::Whitewater } else {
            let secs = match flag("--checkpoint-every") { Some(v) => v.parse().map_err(|_| "bad --checkpoint-every")?, None => 300.0 };
            Kind::Bake { water_only: args.iter().any(|a| a == "--water-only"), checkpoint_secs: secs }
        };
        Task { kind, inp: is_cache.then(|| PathBuf::from(inp)), scene, o, out: PathBuf::from(out) }
    };
    let fine = matches!(task.kind, Kind::Detail(_));
    let mut gpu = None;
    execute(&task, &mut gpu, &mut |n| {
        match n {
            Note::Line(s) => eprintln!("{s}"),
            Note::Frame(p) => {
                let eta = if p.f > 0 { p.elapsed / p.f as f32 * (p.frames - p.f) as f32 } else { 0.0 };
                eprintln!("frame {}/{}: {} {}points, {} substeps, {:.0} ms, {:.0} s so far, about {:.0} s left", p.f, p.frames, p.n, if fine { "fine " } else { "" }, p.sub, p.frame_ms, p.elapsed, eta);
            }
        }
        true
    })?;
    eprintln!("wrote {}", task.out.display());
    Ok(())
}
