//! `--bake`: a headless bake from a scene file, or again from a page cache's scene and settings, streamed to a cache file.
//! `--detail-pass`: a finer sim over a region of a finished bake, guided by it (the page's Detail), written to a new cache.
//! `--bake-whitewater`: whitewater made afterwards from a finished bake's water (the page's Bake whitewater), written to a new cache.

use serde_json::Value;
use splash_sim::bake;
use splash_sim::gpu::Gpu;
use splash_sim::scene::{desc_from_scene, BakeOpts};
use std::path::Path;

pub fn run(args: &[String]) -> Result<(), String> {
    let flag = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
    let ww = args.iter().any(|a| a == "--bake-whitewater");
    let det = args.iter().any(|a| a == "--detail-pass");
    let cmd = if ww { "--bake-whitewater" } else if det { "--detail-pass" } else { "--bake" };
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
        if let Some(n) = m.pointer("/desc/maxN").and_then(Value::as_u64) { o.max_points = Some(n as u32); }
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
    if args.iter().any(|a| a == "--water-only") { desc.spr = None; desc.spray_cap = 0; desc.air = None; desc.drip = None; }
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
    eprintln!("Spacing {} (live {} / detail {}), {} frames at {} a second, max {} points, {} to {} substeps a frame, {} iterations{}",
        desc.d, o.spacing, desc.detail, desc.frames, desc.fps, desc.max_n, desc.substeps, desc.max_sub, desc.iters, if desc.accurate { ", Accurate" } else { "" });
    if !desc.left_out.is_empty() { eprintln!("Not in the native solver yet, left out: {}", desc.left_out.join(", ")); }
    bake::run(&gpu, &desc, Path::new(out), |p| {
        let eta = if p.f > 0 { p.elapsed / p.f as f32 * (p.frames - p.f) as f32 } else { 0.0 };
        eprintln!("frame {}/{}: {} points, {} substeps, {:.0} ms, {:.0} s so far, about {:.0} s left", p.f, p.frames, p.n, p.sub, p.frame_ms, p.elapsed, eta);
        true
    })?;
    eprintln!("wrote {out}");
    Ok(())
}
