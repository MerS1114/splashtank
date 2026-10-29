//! SplashTank's FLIP solver on wgpu, running the page's own WGSL kernels (exported by native/tools/export-wgsl.js).
// the cache header's settings are one big json! literal
#![recursion_limit = "256"]

pub mod bake;
pub mod detail;
pub mod nb;
pub mod ww;
pub mod flip;
pub mod gpu;
pub mod runner;
pub mod scene;
pub mod sdf;

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    /// The shader files here must be what the page's src/flip/*.js make now (node native/tools/export-wgsl.js writes them).
    #[test]
    fn shaders_up_to_date() {
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tools/export-wgsl.js");
        let Ok(out) = std::process::Command::new("node").arg(&script).arg("--check").output() else { eprintln!("node not found, skipped"); return; };
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }

    /// Ocean waves and the narrow band seed (a box against two walls, a sphere, the ocean) the same as the page's oceanWaves and
    /// nbSeedCount (native/tools/nb-check.js runs them).
    #[test]
    fn nb_seed_matches_page() {
        let oc = crate::flip::Ocean { height: 0.12, length: 1.5, dir: 35.0, spread: 30.0, seed: 15, level: 0.5, layer: 0.4 };
        let g = 9.8 / 2.0;
        let l = crate::flip::layout(0.03, 2.0, [3.0, 2.0, 2.5]);
        let fills = vec![crate::scene::Fill::Box { x0: l.b64()[0], x1: -0.5, y0: 0.0, y1: 1.1, z0: l.b64()[4], z1: 0.3 }, crate::scene::Fill::Sphere { x: 0.6, y: 1.2, z: 0.1, r: 0.3, vy: -1.0 }];
        let arg = serde_json::json!({ "d": 0.03, "ratio": 2.0, "size": [3.0, 2.0, 2.5], "band": 4, "g": g,
            "ocean": { "on": true, "height": oc.height, "length": oc.length, "dir": oc.dir, "spread": oc.spread, "seed": oc.seed, "level": oc.level, "layer": oc.layer },
            "fills": [{ "t": "box", "x0": l.b64()[0], "x1": -0.5, "y0": 0.0, "y1": 1.1, "z0": l.b64()[4], "z1": 0.3 }, { "t": "sphere", "x": 0.6, "y": 1.2, "z": 0.1, "r": 0.3, "vy": -1.0 }] });
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tools/nb-check.js");
        let Ok(out) = std::process::Command::new("node").arg(&script).arg(arg.to_string()).output() else { eprintln!("node not found, skipped"); return; };
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let page: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        let w = crate::nb::waves(&oc, g as f64, oc.level - l.b.y0 as f64);
        for (k, (a, b)) in w.iter().zip(page["waves"].as_array().unwrap()).enumerate() {
            let b = b.as_f64().unwrap() as f32;
            assert!((a - b).abs() <= 1e-6 * b.abs().max(1.0), "wave word {k}: native {a}, page {b}");
        }
        let s = crate::nb::seed(&l, &fills, 4.0, Some((&oc, &w)), 0.0, &mut |_, _| true);
        assert_eq!(s.seeded + crate::nb::spares(s.seeded), page["count"].as_u64().unwrap());
    }

    /// A short dam break: every particle stays, none goes bad or leaves the closed tank, the water slumps and the file reads back.
    #[test]
    fn short_bake() {
        let scene = serde_json::json!({ "app": "SplashTank", "version": 2, "box": { "min": { "x": -0.6, "y": 0, "z": -0.4 }, "size": { "w": 1.2, "h": 0.8, "d": 0.8 } },
            "solver": { "iters": 30, "cap": 500000, "nbOn": false, "sprOn": false, "airOn": false }, "bake": { "dur": 0.5, "fps": 24 },
            "fills": [{ "t": "box", "fx0": 0, "fx1": 0.4, "y0": 0, "y1": 0.5, "fz0": 0, "fz1": 1 }], "objs": [] });
        let desc = crate::scene::desc_from_scene(&scene, &crate::scene::BakeOpts { spacing: 0.02, ..Default::default() }).unwrap();
        let gpu = crate::gpu::Gpu::new().unwrap();
        let out = std::env::temp_dir().join("splash-sim-short.splc");
        crate::bake::run(&gpu, &desc, &out, &Default::default(), |_| true).unwrap();
        let c = splash_format::Cache::open(&out).unwrap();
        assert_eq!(c.frames.len(), 13);
        let diag = c.info.meta["diag"].as_array().unwrap();
        let first = &diag[0];
        let last = diag.last().unwrap();
        assert!(first["alive"].as_u64().unwrap() > 10000);
        assert_eq!(first["alive"], last["alive"]);
        assert_eq!(last["nonFinite"], 0);
        assert_eq!(last["outsideBox"], 0);
        // the column has slumped: its centre lower and further out
        assert!(last["center"][1].as_f64().unwrap() < first["center"][1].as_f64().unwrap() - 0.03);
        assert!(last["center"][0].as_f64().unwrap() > first["center"][0].as_f64().unwrap() + 0.03);
    }

    /// A small narrow band ocean with whitewater, the air field, drips and the deep water look, hit by a falling ball of water: nothing goes
    /// bad, whitewater and deep water points are saved, and Bake whitewater and the Detail pass run over the result and read back.
    #[test]
    fn ocean_passes() {
        let scene = serde_json::json!({ "app": "SplashTank", "version": 2, "box": { "min": { "x": -0.6, "y": 0, "z": -0.6 }, "size": { "w": 1.2, "h": 1.2, "d": 1.2 } },
            "solver": { "iters": 30, "cap": 2000000, "nbOn": true, "nbBand": 3, "nbLook": true, "sprOn": true, "sprCap": 200000, "airOn": true, "dripOn": true },
            "ocean": { "on": true, "height": 0.05, "length": 0.6, "dir": 20, "spread": 25, "level": 0.4, "layer": 0.15, "seed": 3 },
            "bake": { "dur": 0.5, "fps": 24 }, "fills": [], "objs": [], "events": [{ "t": 0.02, "x": 0.0, "y": 0.8, "z": 0.0, "r": 0.12 }] });
        let desc = crate::scene::desc_from_scene(&scene, &crate::scene::BakeOpts { spacing: 0.015, ..Default::default() }).unwrap();
        let gpu = crate::gpu::Gpu::new().unwrap();
        let dir = std::env::temp_dir();
        let (out, ww, det) = (dir.join("splash-sim-ocean.splc"), dir.join("splash-sim-ocean-ww.splc"), dir.join("splash-sim-ocean-det.splc"));
        crate::bake::run(&gpu, &desc, &out, &Default::default(), |_| true).unwrap();
        let c = splash_format::Cache::open(&out).unwrap();
        assert_eq!(c.frames.len(), 13);
        let diag = c.info.meta["diag"].as_array().unwrap();
        for d in diag { assert_eq!(d["nonFinite"], 0); assert_eq!(d["outsideBox"], 0); }
        let last = &c.frames[12];
        assert!(last.ww.as_ref().is_some_and(|w| w.n > 100), "whitewater from the splash");
        assert!(last.deep.as_ref().is_some_and(|d| d.n > 100), "deep water look points");
        crate::bake::whitewater_pass(&gpu, &c, &desc, &ww, |_| true).unwrap();
        let cw = splash_format::Cache::open(&ww).unwrap();
        assert_eq!(cw.frames.len(), 13);
        assert!(cw.frames[12].ww.as_ref().is_some_and(|w| w.n > 100));
        assert_eq!(cw.frames[12].water.n, last.water.n);
        crate::detail::run(&gpu, &c, &desc, &crate::detail::DetailOpts::default(), &det, |_| true).unwrap();
        let cd = splash_format::Cache::open(&det).unwrap();
        assert_eq!(cd.frames.len(), 13);
        let n0 = cd.info.meta["detail"]["n0"].as_u64().unwrap() as u32;
        assert!(cd.frames[12].water.n > n0 + 10000, "fine water after the bake's");
    }

    /// A bake sent to a channel (the live sim) arrives as a cache in memory with every frame.
    #[test]
    fn bake_to_channel() {
        let scene = serde_json::json!({ "app": "SplashTank", "version": 2, "box": { "min": { "x": -0.6, "y": 0, "z": -0.4 }, "size": { "w": 1.2, "h": 0.8, "d": 0.8 } },
            "solver": { "iters": 30, "cap": 500000, "nbOn": false, "sprOn": false, "airOn": false }, "bake": { "dur": 0.5, "fps": 24 },
            "fills": [{ "t": "box", "fx0": 0, "fx1": 0.4, "y0": 0, "y1": 0.5, "fz0": 0, "fz1": 1 }], "objs": [] });
        let desc = crate::scene::desc_from_scene(&scene, &crate::scene::BakeOpts { spacing: 0.03, ..Default::default() }).unwrap();
        let gpu = crate::gpu::Gpu::new().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let ro = crate::bake::RunOpts { sink: Some(tx), ..Default::default() };
        crate::bake::run(&gpu, &desc, &std::env::temp_dir().join("never-written.splc"), &ro, |_| true).unwrap();
        drop(ro);
        let mut it = rx.into_iter();
        let mut c = splash_format::Cache::from_header(it.next().unwrap()).unwrap();
        for f in it { c.push(&f).unwrap(); }
        assert_eq!(c.frames.len(), 13);
        assert!(c.frames[12].water.n > 1000);
        assert!(!std::env::temp_dir().join("never-written.splc").exists());
    }

    /// A bake stopped partway (its checkpoint kept) carries on with --resume to the same water as one that ran straight through.
    #[test]
    fn resume_matches() {
        let scene = serde_json::json!({ "app": "SplashTank", "version": 2, "box": { "min": { "x": -0.6, "y": 0, "z": -0.6 }, "size": { "w": 1.2, "h": 1.2, "d": 1.2 } },
            "solver": { "iters": 30, "cap": 2000000, "nbOn": true, "nbBand": 3, "sprOn": true, "sprCap": 200000, "airOn": true },
            "ocean": { "on": true, "height": 0.05, "length": 0.6, "dir": 20, "spread": 25, "level": 0.4, "layer": 0.15, "seed": 3 },
            "bake": { "dur": 0.5, "fps": 24 }, "fills": [], "objs": [], "events": [{ "t": 0.02, "x": 0.0, "y": 0.8, "z": 0.0, "r": 0.12 }] });
        let desc = crate::scene::desc_from_scene(&scene, &crate::scene::BakeOpts { spacing: 0.015, ..Default::default() }).unwrap();
        let gpu = crate::gpu::Gpu::new().unwrap();
        let dir = std::env::temp_dir();
        let (a, b) = (dir.join("splash-sim-straight.splc"), dir.join("splash-sim-resumed.splc"));
        crate::bake::run(&gpu, &desc, &a, &Default::default(), |_| true).unwrap();
        let ro = crate::bake::RunOpts { checkpoint_secs: 0.001, resume: false, started_with: serde_json::Value::Null, ..Default::default() };
        crate::bake::run(&gpu, &desc, &b, &ro, |p| p.f < 6).unwrap();
        assert!(crate::bake::checkpoint_path(&b).exists(), "a stopped bake keeps its checkpoint");
        crate::bake::run(&gpu, &desc, &b, &crate::bake::RunOpts { resume: true, ..ro }, |_| true).unwrap();
        assert!(!crate::bake::checkpoint_path(&b).exists(), "a finished bake removes it");
        let (ca, cb) = (splash_format::Cache::open(&a).unwrap(), splash_format::Cache::open(&b).unwrap());
        assert_eq!(cb.frames.len(), 13);
        let (da, db) = (ca.info.meta["diag"].as_array().unwrap().clone(), cb.info.meta["diag"].as_array().unwrap().clone());
        assert_eq!(db.len(), 13);
        for (x, y) in da.iter().zip(&db) {
            assert_eq!(x["f"], y["f"]);
            assert_eq!(y["nonFinite"], 0);
            let (na, nb) = (x["alive"].as_f64().unwrap(), y["alive"].as_f64().unwrap());
            // two bakes of this narrow band impact differ by up to about 1.1% in particles (the GPU adds particles in no fixed order)
            assert!((na - nb).abs() < 0.025 * na, "frame {}: {na} against {nb} particles", x["f"]);
            let gap: f64 = (0..3).map(|k| (x["center"][k].as_f64().unwrap() - y["center"][k].as_f64().unwrap()).powi(2)).sum::<f64>().sqrt();
            assert!(gap < 0.01, "frame {}: water centre {gap} apart", x["f"]);
        }
    }
}
