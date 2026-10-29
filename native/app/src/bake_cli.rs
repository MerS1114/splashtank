//! `--bake`: a headless bake from a scene file, or again from a page cache's scene and settings, streamed to a cache file.
//! `--detail-pass`: a finer sim over a region of a finished bake, guided by it (the page's Detail), written to a new cache.
//! `--bake-whitewater`: whitewater made afterwards from a finished bake's water (the page's Bake whitewater), written to a new cache.
//! `--resume out.splc`: carries on a bake that stopped (a crash, a power cut, closing it) from its last checkpoint.

use serde_json::Value;
use splash_sim::bake;
use splash_sim::gpu::Gpu;
use splash_sim::scene::{desc_from_scene, BakeOpts};
use std::path::Path;

pub fn run(args: &[String]) -> Result<(), String> {
    let flag = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
    let resume = flag("--resume");
    let ww = args.iter().any(|a| a == "--bake-whitewater");
    let det = args.iter().any(|a| a == "--detail-pass");
    let cmd = if ww { "--bake-whitewater" } else if det { "--detail-pass" } else { "--bake" };
    if let Some(out) = &resume { return resume_bake(out); }
    let i = args.iter().position(|a| a == cmd).unwrap();
    let (inp, out) = (args.get(i + 1).ok_or(format!("{cmd} needs an input file and an output file"))?, args.get(i + 2).ok_or(format!("{cmd} needs an output file"))?);
    if (ww || det) && !inp.to_ascii_lowercase().ends_with(".splc") { return Err(format!("{cmd} works on a finished bake (.splc).")); }
    let mut o = BakeOpts::default();
    let scene: Value = if inp.to_ascii_lowercase().ends_with(".splc") {
        // a page cache: its scene, live spacing (the bake's spacing times its detail), length and detail
        let c = splash_format::Cache::open(Path::new(inp)).map_err(|e| e.to_string())?;
        let m = &c.info.meta;
        let det = m.pointer("/desc/detail").and_then(Value::as_f64).unwrap_or(1.0) as f32;
        o.spacing = c.info.d * det;
        o.detail = Some(det);
        o.seconds = Some((c.frames.len().saturating_sub(1)) as f32 / c.info.fps);
        if let Some(a) = m.pointer("/desc/accurate").and_then(Value::as_bool) { o.accurate = Some(a); }
        match flag("--scene") {
            // Bake whitewater with the scene as it is now (whitewater settings, colliders), as the page does
            Some(p) => serde_json::from_slice(&std::fs::read(&p).map_err(|e| format!("{p}: {e}"))?).map_err(|e| format!("{p}: {e}"))?,
            None => m.get("scene").cloned().filter(Value::is_object).ok_or("That cache has no scene in its header.")?,
        }
    } else {
        serde_json::from_slice(&std::fs::read(inp).map_err(|e| format!("{inp}: {e}"))?).map_err(|e| format!("{inp}: {e}"))?
    };
    if let Some(v) = flag("--spacing") { o.spacing = v.parse().map_err(|_| "bad --spacing")?; }
    if let Some(v) = flag("--seconds") { o.seconds = Some(v.parse().map_err(|_| "bad --seconds")?); }
    if let Some(v) = flag("--detail") { o.detail = Some(v.parse().map_err(|_| "bad --detail")?); }
    if let Some(v) = flag("--max-points") { o.max_points = Some(v.parse().map_err(|_| "bad --max-points")?); }
    if args.iter().any(|a| a == "--accurate") { o.accurate = Some(true); }
    let mut desc = desc_from_scene(&scene, &o)?;
    // the page's Bake water: the water without whitewater (Bake whitewater makes it afterwards)
    let water_only = args.iter().any(|a| a == "--water-only");
    if water_only { desc.spr = None; desc.spray_cap = 0; desc.air = None; desc.drip = None; }
    let gpu = Gpu::new()?;
    eprintln!("{}; shaders ready in {:.0} ms", gpu.describe(), gpu.compile_ms);
    if det {
        let c = splash_format::Cache::open(Path::new(inp)).map_err(|e| e.to_string())?;
        let mut d = splash_sim::detail::DetailOpts::default();
        if let Some(v) = flag("--region") {
            let a: Vec<f32> = v.split(',').map(|x| x.trim().parse::<f32>()).collect::<Result<_, _>>().map_err(|_| "bad --region")?;
            if a.len() != 6 { return Err("--region takes cx,cy,cz,sx,sy,sz as shares of the tank (0-1)".into()); }
            d.c = [a[0], a[1], a[2]]; d.s = [a[3], a[4], a[5]];
        }
        if let Some(v) = flag("--k") { d.k = v.parse().map_err(|_| "bad --k")?; }
        if let Some(v) = flag("--pull") { d.pull = v.parse().map_err(|_| "bad --pull")?; }
        eprintln!("Detail {}x over {} frames, region centre {:?} size {:?}, follow the bake {}", d.k, c.frames.len(), d.c, d.s, d.pull);
        splash_sim::detail::run(&gpu, &c, &desc, &d, Path::new(out), |p| {
            let eta = if p.f > 0 { p.elapsed / p.f as f32 * (p.frames - p.f) as f32 } else { 0.0 };
            eprintln!("frame {}/{}: {} fine points, {} substeps, {:.0} ms, {:.0} s so far, about {:.0} s left", p.f, p.frames, p.n, p.sub, p.frame_ms, p.elapsed, eta);
            true
        })?;
        eprintln!("wrote {out}");
        return Ok(());
    }
    if ww {
        let c = splash_format::Cache::open(Path::new(inp)).map_err(|e| e.to_string())?;
        eprintln!("Whitewater over {} frames, up to {} points alive", c.frames.len(), desc.spray_cap);
        bake::whitewater_pass(&gpu, &c, &desc, Path::new(out), |p| {
            let eta = if p.f > 0 { p.elapsed / p.f as f32 * (p.frames - p.f) as f32 } else { 0.0 };
            eprintln!("frame {}/{}: {} substeps, {:.0} ms, {:.0} s so far, about {:.0} s left", p.f, p.frames, p.sub, p.frame_ms, p.elapsed, eta);
            true
        })?;
        eprintln!("wrote {out}");
        return Ok(());
    }
    let secs = match flag("--checkpoint-every") { Some(v) => v.parse().map_err(|_| "bad --checkpoint-every")?, None => 300.0 };
    let started = serde_json::json!({ "scene": scene, "waterOnly": water_only, "opts": { "spacing": o.spacing, "seconds": o.seconds, "detail": o.detail, "maxPoints": o.max_points, "accurate": o.accurate } });
    bake_now(&gpu, &desc, &o, Path::new(out), &bake::RunOpts { checkpoint_secs: secs, resume: false, started_with: started })
}

/// Runs a bake with its progress on the terminal; says at the end when the disk held it back.
fn bake_now(gpu: &Gpu, desc: &splash_sim::scene::Desc, o: &BakeOpts, out: &Path, ro: &bake::RunOpts) -> Result<(), String> {
    eprintln!("Spacing {} (live {} / detail {}), {} frames at {} a second, {} to {} substeps a frame, {} iterations{}",
        desc.d, o.spacing, desc.detail, desc.frames, desc.fps, desc.substeps, desc.max_sub, desc.iters, if desc.accurate { ", Accurate" } else { "" });
    if !desc.left_out.is_empty() { eprintln!("Not in the native solver yet, left out: {}", desc.left_out.join(", ")); }
    if ro.checkpoint_secs > 0.0 { eprintln!("A checkpoint every {:.0} s, so a stopped bake can carry on: splashtank --resume {}", ro.checkpoint_secs, out.display()); }
    let (mut wait, mut el) = (0.0f32, 0.0f32);
    bake::run(gpu, desc, out, ro, |p| {
        let eta = if p.f > 0 { p.elapsed / p.f as f32 * (p.frames - p.f) as f32 } else { 0.0 };
        eprintln!("frame {}/{}: {} points, {} substeps, {:.0} ms, {:.0} s so far, about {:.0} s left", p.f, p.frames, p.n, p.sub, p.frame_ms, p.elapsed, eta);
        wait = p.wait; el = p.elapsed;
        true
    })?;
    eprintln!("wrote {}", out.display());
    if wait > 0.1 * el && wait > 5.0 {
        eprintln!("The bake waited {wait:.0} s of {el:.0} s for the disk to take its frames: that drive writes too slowly for this bake. Bake to a faster drive.");
    }
    Ok(())
}

/// --resume out.splc: the scene and settings the bake was started with come from its checkpoint.
fn resume_bake(out: &str) -> Result<(), String> {
    let out = Path::new(out);
    let (v, _) = bake::read_checkpoint(&bake::checkpoint_path(out))?;
    let s = &v["startedWith"];
    let op = &s["opts"];
    let o = BakeOpts {
        spacing: op["spacing"].as_f64().ok_or("The checkpoint has no settings.")? as f32,
        seconds: op["seconds"].as_f64().map(|x| x as f32), detail: op["detail"].as_f64().map(|x| x as f32),
        max_points: op["maxPoints"].as_u64().map(|x| x as u32), accurate: op["accurate"].as_bool(),
    };
    let mut desc = desc_from_scene(&s["scene"], &o)?;
    if s["waterOnly"].as_bool().unwrap_or(false) { desc.spr = None; desc.spray_cap = 0; desc.air = None; desc.drip = None; }
    let gpu = Gpu::new()?;
    eprintln!("{}; shaders ready in {:.0} ms", gpu.describe(), gpu.compile_ms);
    eprintln!("Carrying on {} after frame {} of {}", out.display(), v["frame"], desc.frames);
    let secs = v["checkpointEvery"].as_f64().unwrap_or(300.0) as f32;
    bake_now(&gpu, &desc, &o, out, &bake::RunOpts { checkpoint_secs: secs, resume: true, started_with: s.clone() })
}
