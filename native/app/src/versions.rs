//! Bake versions: bakes kept on purpose, beside each other, so a scene can be tuned by comparing them. Each is a copy of the bake in
//! "Versions\<scene>" inside the bake folder, with a note and a small picture next to it (<name>.json, <name>.png).

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub struct Ver {
    pub path: PathBuf,
    pub name: String,
    pub note: String,
    pub frames: usize,
    pub spacing: f32,
    /// the scene the bake was made from (its settings, to compare with)
    pub scene: Value,
    pub thumb: PathBuf,
}

/// Where a scene's versions are kept.
pub fn dir(folder: &Path, scene: &str) -> PathBuf { folder.join("Versions").join(scene) }

/// The versions of a scene, oldest first.
pub fn list(dir: &Path) -> Vec<Ver> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new(); };
    let mut v: Vec<Ver> = rd.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("splc"))).filter_map(|p| {
        let c = splash_format::Cache::open(&p).ok()?;
        let side: Value = std::fs::read(p.with_extension("json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
        Some(Ver { name: p.file_stem()?.to_string_lossy().into_owned(), note: side["note"].as_str().unwrap_or("").to_owned(), frames: c.frames.len(), spacing: c.info.d,
            scene: c.info.meta["scene"].clone(), thumb: p.with_extension("png"), path: p })
    }).collect();
    v.sort_by(|a, b| a.name.cmp(&b.name));
    v
}

/// Copies the bake at src into the scene's versions as the next one, and starts its picture.
pub fn keep(src: &Path, dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not make {}: {e}", dir.display()))?;
    let n = list(dir).len() + 1;
    let to = dir.join(format!("Version {n}.splc"));
    std::fs::copy(src, &to).map_err(|e| format!("Could not keep the bake: {e}"))?;
    let frames = splash_format::Cache::open(&to).map(|c| c.frames.len()).unwrap_or(1);
    picture(&to, frames * 2 / 3);
    Ok(to)
}

/// The version's picture: this program drawing one frame without a window, on its own process so the window never waits.
pub fn picture(p: &Path, frame: usize) {
    let Ok(exe) = std::env::current_exe() else { return; };
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("--picture").arg(p.with_extension("png")).arg(p).arg("--frame").arg(frame.to_string()).arg("--size").arg("480x270");
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000);   // CREATE_NO_WINDOW
    let _ = cmd.spawn();
}

pub fn set_note(v: &Ver) { let _ = std::fs::write(v.path.with_extension("json"), serde_json::to_vec_pretty(&json!({ "note": v.note })).unwrap_or_default()); }

pub fn delete(v: &Ver) { for p in [v.path.clone(), v.path.with_extension("json"), v.thumb.clone()] { let _ = std::fs::remove_file(p); } }
