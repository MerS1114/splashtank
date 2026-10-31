//! Scene files (.json), as written by `sceneData` in `src/app/13-files.js`. The whole file is kept as a JSON value so that a
//! load and save keeps every field, including ones the native program does not know yet; the typed fields are read from it.

use serde_json::Value;
use std::io;
use std::path::Path;

#[derive(Clone, Debug)]
pub struct Mesh {
    pub v: Vec<[f32; 3]>,
    /// faces: three or more corners (cubes and cylinders have quads and caps)
    pub f: Vec<Vec<u32>>,
}

impl Mesh {
    /// Triangles, fanned out from each face's first corner (meshTris in shared.js).
    pub fn tris(&self) -> Vec<[u32; 3]> {
        let mut t = Vec::new();
        for f in &self.f { for k in 1..f.len().saturating_sub(1) { t.push([f[0], f[k], f[k + 1]]); } }
        t
    }
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
        let mut s = Scene { json, min: [0.0; 3], size: [0.0; 3], objs: Vec::new(), ocean_level: None, narrow_band: false };
        s.refresh(true);
        Ok(s)
    }

    /// The typed fields again after json was edited. meshes false: objects' shapes did not change, so only their places are read
    /// (this runs every frame an object moves or the keys play).
    pub fn refresh(&mut self, meshes: bool) {
        let j = &self.json;
        let (bx, none) = (j.get("box").unwrap_or(&Value::Null), Value::Null);
        let sz = bx.get("size").unwrap_or(&none);
        let size = [num(sz, "w", 3.0), num(sz, "h", 2.6), num(sz, "d", 3.0)];
        let mn = bx.get("min").unwrap_or(&none);
        let min = [num(mn, "x", -size[0] / 2.0), num(mn, "y", 0.0), num(mn, "z", -size[2] / 2.0)];
        let list = j["objs"].as_array().map(Vec::as_slice).unwrap_or(&[]);
        if !meshes && list.len() == self.objs.len() {
            for (o, v) in self.objs.iter_mut().zip(list) {
                o.pos = [num(v, "x", 0.0), num(v, "y", 0.0), num(v, "z", 0.0)];
                o.rot = [num(v, "rx", 0.0), num(v, "yaw", 0.0), num(v, "rz", 0.0)];
                o.scale = [num(v, "sx", 1.0), num(v, "sy", 1.0), num(v, "sz", 1.0)];
            }
        } else { self.objs = list.iter().map(obj).collect(); }
        let oc = j.get("ocean").unwrap_or(&none);
        let ocean_on = oc.get("on").and_then(Value::as_bool).unwrap_or(false);
        // level is a share of the box height (ocean config in 00-state.js)
        self.ocean_level = ocean_on.then(|| num(oc, "level", 0.5) * size[1]);
        self.narrow_band = j.pointer("/solver/nbOn").and_then(Value::as_bool).unwrap_or(false);
        self.min = min; self.size = size;
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
            t.as_array()?.iter().map(|k| k.as_u64().map(|k| k as u32)).collect::<Option<Vec<u32>>>()
        }).filter(|t| t.len() >= 3 && t.iter().all(|&k| (k as usize) < v.len())).collect::<Vec<_>>();
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
