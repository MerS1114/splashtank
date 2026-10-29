//! SplashTank native: opens bake caches (.splc) and scene files (.json) made by the web page and plays them back, and bakes them.
//!
//!   splashtank [file.splc | scene.json ...]                    the window
//!   splashtank --info file.splc                                what a cache holds, frame by frame
//!   splashtank --picture out.png file [--frame n] [--size WxH] draws one frame without a window (n.5: blended halfway)
//!   splashtank --bake in.json|in.splc out.splc [--spacing 0.04] [--seconds s] [--detail 1|1.5|2] [--max-points n] [--accurate]
//!       bakes without a window, streaming frames to out.splc. From a page cache: its scene and settings, baked again natively.
//!       --water-only leaves whitewater, air and drips out (the page's Bake water).
//!   splashtank --bake-whitewater in.splc out.splc [--scene scene.json]
//!       whitewater made from a finished bake's water (Bake whitewater), with the cache's scene or the one given.
//!   splashtank --detail-pass in.splc out.splc [--region cx,cy,cz,sx,sy,sz] [--k 2|3] [--pull 0.15] [--scene scene.json]
//!       a finer sim over a region of a finished bake (Detail); the region as shares of the tank, by default 0.5,0.5,0.5,0.4,1,0.4.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bake_cli;
mod gpu;
mod gui;
mod render;

use splash_format::{Cache, Scene};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Opens a file into the document: a cache (and the scene stored in its header) or a scene file.
pub fn open_into(doc: &mut render::Doc, path: &Path) -> Result<String, String> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if ext == "json" {
        let s = Scene::open(path).map_err(|e| format!("Could not open {name}: {e}"))?;
        doc.scene = Some(s);
        doc.cache = None;
        doc.gen += 1;
        return Ok(format!("Opened scene {name}"));
    }
    let c = Cache::open(path).map_err(|e| format!("Could not open {name}: {e}"))?;
    let embedded = c.info.meta.get("scene").cloned().filter(|v| v.is_object()).and_then(|v| Scene::from_json(v).ok());
    let mut msg = format!("Opened {name}: {} frames", c.frames.len());
    if c.truncated { msg += " (the file ends early; every complete frame is shown)"; }
    if embedded.is_some() { doc.scene = embedded; }
    doc.cache = Some(Arc::new(c));
    doc.gen += 1;
    Ok(msg)
}

fn info(path: &Path) -> Result<(), String> {
    let c = Cache::open(path).map_err(|e| e.to_string())?;
    let i = &c.info;
    println!("version {}, {} frames{}, spacing {}, {} fps, scale {}, speeds in {}", i.version, c.frames.len(), if c.truncated { " (cut short)" } else { "" },
        i.d, i.fps, i.scale, if i.spd_ms { "m/s" } else { "scene units/s" });
    println!("box {:?}, origin {:?}, objects {:?}", i.b, i.org, i.ids);
    for (f, fr) in c.frames.iter().enumerate() {
        println!("frame {f}: {} water{}, {} whitewater, {} deep, {}", fr.water.n, if fr.compact() { " (compact)" } else { "" },
            fr.ww.as_ref().map(|w| w.n).unwrap_or(0), fr.deep.as_ref().map(|d| d.n).unwrap_or(0),
            fr.own_box.map(|b| format!("own box {:.2} {:.2} {:.2} to {:.2} {:.2} {:.2}", b.x0, b.y0, b.z0, b.x1, b.y1, b.z1)).unwrap_or_default());
    }
    Ok(())
}

/// The release build is a window program; the command-line modes print to the terminal they were started from.
#[cfg(windows)]
fn attach_console() {
    #[link(name = "kernel32")]
    extern "system" { fn AttachConsole(pid: u32) -> i32; }
    // SAFETY: plain Win32 call; ATTACH_PARENT_PROCESS = -1. Failing (no parent console) only means nothing is printed.
    unsafe { AttachConsole(u32::MAX); }
}
#[cfg(not(windows))]
fn attach_console() {}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
    if args.iter().any(|a| a.starts_with("--")) { attach_console(); }
    if args.iter().any(|a| a == "--bake" || a == "--bake-whitewater" || a == "--detail-pass") {
        if let Err(e) = bake_cli::run(&args) { eprintln!("{e}"); std::process::exit(1); }
        return;
    }
    if let Some(p) = flag("--info") {
        if let Err(e) = info(Path::new(&p)) { eprintln!("{e}"); std::process::exit(1); }
        return;
    }
    if let Some(out) = flag("--picture") {
        let skip: Vec<&String> = ["--picture", "--frame", "--size"].iter().filter_map(|k| args.iter().position(|a| a == k).map(|i| &args[i + 1])).collect();
        let files: Vec<PathBuf> = args.iter().filter(|a| !a.starts_with("--") && !skip.contains(a)).map(PathBuf::from).collect();
        let frame = flag("--frame").and_then(|v| v.parse().ok()).unwrap_or(0.0);
        let size = flag("--size").and_then(|v| { let (w, h) = v.split_once('x')?; Some([w.parse().ok()?, h.parse().ok()?]) }).unwrap_or([1280, 720]);
        if let Err(e) = gpu::picture(&files, Path::new(&out), frame, size) { eprintln!("{e}"); std::process::exit(1); }
        return;
    }
    let files: Vec<PathBuf> = args.iter().filter(|a| !a.starts_with("--")).map(PathBuf::from).collect();
    gui::run(files);
}
