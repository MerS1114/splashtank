//! Reference numbers: a fixed set of short bakes, measured frame by frame, against numbers recorded from the solver as it was when the
//! desktop program took over the shader (native/tests/reference/). A change that alters the water fails here; when the change is meant
//! (a better solver), record again and say why in the commit:
//!   SPLASH_RECORD=1 cargo test --release --test reference -- --nocapture
//! Recording runs each scene eight times; a later run passes when every measure of every frame is within the recorded runs' range,
//! widened by twice that range plus a small floor (GPU atomics add in a different order each run, so splashes differ run to run).

use serde_json::{json, Value};
use std::path::PathBuf;

/// (scene from app/src/scenes.json, live spacing, seconds; " FLIP" after the name: the FLIP transfer instead of APIC)
pub const SCENES: [(&str, f32, f32); 6] = [
    ("Dam break", 0.025, 2.5),
    ("Dam break FLIP", 0.025, 2.5),
    ("Meteor lake", 0.04, 3.0),
    ("Ocean", 0.04, 2.0),
    ("Fountain", 0.03, 2.0),
    ("Underwater blast", 0.04, 1.0),
];

/// What is compared per frame: name, how to read it from the frame's diag, the floor (absolute, and as a share of the value)
fn measures() -> Vec<(&'static str, fn(&Value, f64) -> f64, f64, f64)> {
    vec![
        ("points", |d, _| d["alive"].as_f64().unwrap_or(0.0), 50.0, 0.01),
        ("centre x", |d, s| d["center"][0].as_f64().unwrap_or(0.0) / s, 0.005, 0.0),
        ("centre y", |d, s| d["center"][1].as_f64().unwrap_or(0.0) / s, 0.005, 0.0),
        ("centre z", |d, s| d["center"][2].as_f64().unwrap_or(0.0) / s, 0.005, 0.0),
        ("height 99%", |d, _| high(d), 1.5 / 16.0, 0.0),
        ("mean speed", |d, _| d["meanSpeed"].as_f64().unwrap_or(0.0), 0.05, 0.05),
        // (a single thrown particle can double a frame's substeps now and then: the blast's growth, about 1 run in 6)
        ("substeps", |d, _| d["sub"].as_f64().unwrap_or(0.0), 1.0, 1.5),
        ("water cells", |d, _| d["fluidCells"].as_f64().unwrap_or(0.0), 40.0, 0.03),
        ("spray", |d, _| d["sprayPoints"].as_f64().unwrap_or(0.0), 50.0, 0.1),
    ]
}

/// The height (share of the tank, in 16ths) under which 99% of the water lies: the top of the water without single drops.
fn high(d: &Value) -> f64 {
    let h: Vec<f64> = d["heightHist"].as_array().map(|a| a.iter().map(|v| v.as_f64().unwrap_or(0.0)).collect()).unwrap_or_default();
    let total: f64 = h.iter().sum();
    let mut acc = 0.0;
    for (i, v) in h.iter().enumerate() { acc += v; if acc >= 0.99 * total { return (i + 1) as f64 / h.len() as f64; } }
    1.0
}

fn dir() -> PathBuf { PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/reference") }

fn scene(name: &str) -> Value {
    let all: Value = serde_json::from_str(include_str!("../../app/src/scenes.json")).unwrap();
    all["scenes"][name].clone()
}

/// One bake of the scene: per frame the diag, and the tank's largest side (centres are compared as shares of it).
pub fn bake(gpu: &splash_sim::gpu::Gpu, name: &str, spacing: f32, secs: f32) -> (Vec<Value>, f64) {
    let mut sc = scene(name.trim_end_matches(" FLIP"));
    if name.ends_with(" FLIP") { sc["solver"]["xfer"] = json!("flip"); }
    assert!(sc.is_object(), "no scene {name}");
    let o = splash_sim::scene::BakeOpts { spacing, seconds: Some(secs), detail: Some(1.0), ..Default::default() };
    let desc = splash_sim::scene::desc_from_scene(&sc, &o).unwrap();
    let size = desc.size.iter().cloned().fold(0.0f32, f32::max) as f64;
    let out = std::env::temp_dir().join(format!("splash-ref-{}.splc", name.replace(' ', "-")));
    splash_sim::bake::run(gpu, &desc, &out, &Default::default(), |_| true).unwrap();
    let c = splash_format::Cache::open(&out).unwrap();
    let d = c.info.meta["diag"].as_array().unwrap().clone();
    drop(c);
    let _ = std::fs::remove_file(&out);
    (d, size)
}

#[test]
fn reference() {
    let gpu = splash_sim::gpu::Gpu::new().unwrap();
    let record = std::env::var("SPLASH_RECORD").is_ok();
    let ms = measures();
    let mut fails = Vec::new();
    for (name, sp, secs) in SCENES {
        let file = dir().join(format!("{}.json", name.replace(' ', "-").to_lowercase()));
        if record {
            let t0 = std::time::Instant::now();
            let runs: Vec<(Vec<Value>, f64)> = (0..8).map(|_| bake(&gpu, name, sp, secs)).collect();
            let frames = runs.iter().map(|r| r.0.len()).min().unwrap();
            let mut fr = Vec::new();
            for f in 0..frames {
                let mut m = serde_json::Map::new();
                for (k, get, _, _) in &ms {
                    let v: Vec<f64> = runs.iter().map(|r| get(&r.0[f], r.1)).collect();
                    m.insert(k.to_string(), json!([v.iter().cloned().fold(f64::INFINITY, f64::min), v.iter().cloned().fold(f64::NEG_INFINITY, f64::max)]));
                }
                fr.push(Value::Object(m));
            }
            std::fs::create_dir_all(dir()).unwrap();
            let doc = json!({ "scene": name, "spacing": sp, "seconds": secs, "gpu": gpu.describe(), "recorded": "eight runs, min and max per frame", "frames": fr });
            std::fs::write(&file, serde_json::to_string_pretty(&doc).unwrap()).unwrap();
            eprintln!("{name}: recorded {frames} frames in {:.1} s", t0.elapsed().as_secs_f64());
            continue;
        }
        let refd: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap_or_else(|_| panic!("no reference for {name}: record it"))).unwrap();
        let (d, size) = bake(&gpu, name, sp, secs);
        let rf = refd["frames"].as_array().unwrap();
        assert_eq!(d.len(), rf.len(), "{name}: frame count");
        let mut worst = (0.0f64, String::new());
        for (f, (dg, r)) in d.iter().zip(rf).enumerate() {
            for (k, get, abs, rel) in &ms {
                let (lo, hi) = (r[*k][0].as_f64().unwrap(), r[*k][1].as_f64().unwrap());
                let v = get(dg, size);
                let tol = 2.0 * (hi - lo) + abs + rel * lo.abs().max(hi.abs());
                let off = if v < lo { lo - v } else if v > hi { v - hi } else { 0.0 };
                if off > tol { fails.push(format!("{name} frame {f} {k}: {v:.4}, recorded {lo:.4} to {hi:.4}")); }
                if tol > 0.0 && off / tol > worst.0 { worst = (off / tol, format!("frame {f} {k}")); }
            }
        }
        eprintln!("{name}: {} frames, closest to failing: {} ({:.0}% of the allowance)", d.len(), worst.1, worst.0 * 100.0);
    }
    for f in fails.iter().take(40) { eprintln!("{f}"); }
    assert!(fails.is_empty(), "{} measures outside the reference", fails.len());
}
