//! Scene files (.json), as written by `sceneData` in `src/app/13-files.js`. The whole file is kept as a JSON value so that a
//! load and save keeps every field, including ones the native program does not know yet; the typed fields are read from it.

use serde_json::Value;
use std::io;
use std::path::Path;

#[derive(Clone, Debug)]
pub struct Mesh {
    pub v: Vec<[f32; 3]>,
    pub f: Vec<[u32; 3]>,
}

#[derive(Clone, Debug)]
pub struct Obj {
    pub id: u64,
    pub name: String,
    pub shape: String,
    /// position in the scene, Euler angles (R = Rz Ry Rx, like eulerMat in shared.js), Scale along its own axes
    pub pos: [f32; 3],
    pub rot: [f32; 3],
    pub scale: [f32; 3],
    /// a water volume (starting water), not a collider
    pub water: bool,
    pub mesh: Option<Mesh>,
}

#[derive(Clone, Debug)]
pub struct Scene {
    pub json: Value,
    pub min: [f32; 3],
    /// tank width, height, depth
    pub size: [f32; 3],
    pub objs: Vec<Obj>,
    /// ocean still-water height above the tank floor, in scene units (None = no ocean)
    pub ocean_level: Option<f32>,
    pub narrow_band: bool,
}

fn bad(msg: impl Into<String>) -> io::Error { io::Error::new(io::ErrorKind::InvalidData, msg.into()) }
fn num(v: &Value, k: &str, d: f32) -> f32 { v.get(k).and_then(Value::as_f64).map(|x| x as f32).unwrap_or(d) }

impl Scene {
    pub fn open(path: &Path) -> io::Result<Scene> {
        let text = std::fs::read(path)?;
        let json: Value = serde_json::from_slice(&text).map_err(|e| bad(format!("Not valid JSON: {e}")))?;
        Scene::from_json(json)
    }

    pub fn from_json(json: Value) -> io::Result<Scene> {
        // the same check as applySceneData
        if json.get("app").and_then(Value::as_str) != Some("SplashTank") || !json.get("objs").map(Value::is_array).unwrap_or(false) {
            return Err(bad("This is not a SplashTank scene file."));
        }
        let bx = json.get("box").cloned().unwrap_or(Value::Null);
        let sz = bx.get("size").cloned().unwrap_or(Value::Null);
        let size = [num(&sz, "w", 3.0), num(&sz, "h", 2.6), num(&sz, "d", 3.0)];
        let mn = bx.get("min").cloned().unwrap_or(Value::Null);
        let min = [num(&mn, "x", -size[0] / 2.0), num(&mn, "y", 0.0), num(&mn, "z", -size[2] / 2.0)];
        let objs = json["objs"].as_array().unwrap().iter().map(obj).collect();
        let oc = json.get("ocean").cloned().unwrap_or(Value::Null);
        let ocean_on = oc.get("on").and_then(Value::as_bool).unwrap_or(false);
        // level is a share of the box height (ocean config in 00-state.js)
        let ocean_level = ocean_on.then(|| num(&oc, "level", 0.5) * size[1]);
        let narrow_band = json.pointer("/solver/nbOn").and_then(Value::as_bool).unwrap_or(false);
        Ok(Scene { json, min, size, objs, ocean_level, narrow_band })
    }

    pub fn save(&self, path: &Path) -> io::Result<()> {
        std::fs::write(path, serde_json::to_vec(&self.json)?)
    }
}

fn obj(o: &Value) -> Obj {
    let mesh = o.get("mesh").and_then(|m| {
        let v = m.get("v")?.as_array()?.iter().filter_map(|p| {
            let a = p.as_array()?;
            Some([a.first()?.as_f64()? as f32, a.get(1)?.as_f64()? as f32, a.get(2)?.as_f64()? as f32])
        }).collect::<Vec<_>>();
        let f = m.get("f")?.as_array()?.iter().filter_map(|t| {
            let a = t.as_array()?;
            Some([a.first()?.as_u64()? as u32, a.get(1)?.as_u64()? as u32, a.get(2)?.as_u64()? as u32])
        }).filter(|t| t.iter().all(|&k| (k as usize) < v.len())).collect::<Vec<_>>();
        Some(Mesh { v, f })
    });
    Obj {
        id: o.get("id").and_then(Value::as_u64).unwrap_or(0),
        name: o.get("name").and_then(Value::as_str).unwrap_or("").to_owned(),
        shape: o.get("shape").or_else(|| o.get("kind")).and_then(Value::as_str).unwrap_or("").to_owned(),
        pos: [num(o, "x", 0.0), num(o, "y", 0.0), num(o, "z", 0.0)],
        rot: [num(o, "rx", 0.0), num(o, "yaw", 0.0), num(o, "rz", 0.0)],
        scale: [num(o, "sx", 1.0), num(o, "sy", 1.0), num(o, "sz", 1.0)],
        water: o.get("water").and_then(Value::as_bool).unwrap_or(false),
        mesh,
    }
}
