//! SplashTank's FLIP solver on wgpu, running the page's own WGSL kernels (exported by native/tools/export-wgsl.js).

pub mod bake;
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

    /// A short dam break: every particle stays, none goes bad or leaves the closed tank, the water slumps and the file reads back.
    #[test]
    fn short_bake() {
        let scene = serde_json::json!({ "app": "SplashTank", "version": 2, "box": { "min": { "x": -0.6, "y": 0, "z": -0.4 }, "size": { "w": 1.2, "h": 0.8, "d": 0.8 } },
            "solver": { "iters": 30, "cap": 500000, "nbOn": false, "sprOn": false, "airOn": false }, "bake": { "dur": 0.5, "fps": 24 },
            "fills": [{ "t": "box", "fx0": 0, "fx1": 0.4, "y0": 0, "y1": 0.5, "fz0": 0, "fz1": 1 }], "objs": [] });
        let desc = crate::scene::desc_from_scene(&scene, &crate::scene::BakeOpts { spacing: 0.02, ..Default::default() }).unwrap();
        let gpu = crate::gpu::Gpu::new().unwrap();
        let out = std::env::temp_dir().join("splash-sim-short.splc");
        crate::bake::run(&gpu, &desc, &out, |_| true).unwrap();
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
}
