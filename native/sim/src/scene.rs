//! A bake's description from a scene file, and what runs the scene each step: object poses from keys, colliders, emitters, starting
//! water. Ports of buildDesc / bakeRes / simPar / resolveFills / volRec / snap (src/app), and keyPose, sampleObjState, objSpeed and
//! SceneRunner (src/shared.js). Settings missing from a scene file take the page's defaults (S in src/app/00-state.js).

use crate::flip::{Air, Drip, Ocean, Spr};
use crate::sdf::{self, Sdf};
use serde_json::Value;
use std::sync::Arc;

/// Options the scene file does not hold: the page keeps the live spacing in its own settings, not in the file.
#[derive(Clone, Debug)]
pub struct BakeOpts {
    /// live particle spacing (the page's Simulation > Spacing); the bake's is this over the detail
    pub spacing: f32,
    /// bake length in seconds (None: the scene's)
    pub seconds: Option<f32>,
    /// Quality: 1 Preview, 1.5 Final, 2 Fine (None: the scene's)
    pub detail: Option<f32>,
    /// Max points (None: the page's rule)
    pub max_points: Option<u32>,
    pub accurate: Option<bool>,
}
impl Default for BakeOpts {
    fn default() -> BakeOpts { BakeOpts { spacing: 0.04, seconds: None, detail: None, max_points: None, accurate: None } }
}

#[derive(Clone, Debug, Default)]
pub struct Key {
    pub t: f32,
    /// channels this key holds, by name (x y z rx yaw rz sx sy sz az el speed radius on)
    pub ch: Vec<(String, f32)>,
}
impl Key {
    fn get(&self, c: &str) -> Option<f32> { self.ch.iter().find(|(k, _)| k == c).map(|(_, v)| *v) }
}

/// An object as the solver sees it, in solver coordinates (the scene position minus the origin).
#[derive(Clone)]
pub struct Obj {
    pub id: u64,
    pub emitter: bool,
    pub water: bool,
    pub x: f32, pub y: f32, pub z: f32,
    pub rx: f32, pub yaw: f32, pub rz: f32,
    pub sx: f32, pub sy: f32, pub sz: f32,
    pub spin: f32,
    pub sdf: Option<Arc<Sdf>>,
    // emitters
    pub az: f32, pub el: f32, pub speed: f32, pub radius: f32, pub on: bool, pub random: bool, pub spread: f32, pub density: f32, pub turb: f32,
    pub keys: Vec<Key>,
    pub smooth: bool,
    /// recorded motion: start frame (60 a second) and x y z yaw per frame
    pub rec: Option<(f32, Vec<f32>)>,
}

/// Starting water: a box, a sphere, or a water volume object (its distance grid and pose).
#[derive(Clone)]
pub enum Fill {
    Box { x0: f64, x1: f64, y0: f64, y1: f64, z0: f64, z1: f64 },
    Sphere { x: f64, y: f64, z: f64, r: f64, vy: f64 },
    Vol { sdf: Arc<Sdf>, pos: [f32; 3], r: [f32; 9], s: Option<[f32; 3]>, lo: [f32; 3], hi: [f32; 3] },
}

#[derive(Clone, Copy, Debug)]
pub struct Event { pub t: f32, pub x: f64, pub y: f64, pub z: f64, pub r: f64 }

/// What the page's buildDesc makes: everything a bake needs. Only what the native solver uses so far is here.
#[derive(Clone)]
pub struct Desc {
    pub d: f32, pub max_n: u32, pub fps: f32,
    /// Max points was given (otherwise a narrow band bake picks its own from the starting water and the card)
    pub max_n_set: bool, pub substeps: u32, pub max_sub: u32, pub frames: u32,
    pub g: f32, pub iters: u32, pub flip: f32, pub apic_flip: f32, pub comp: f32, pub sep: f32, pub apic: bool, pub accurate: bool,
    pub cell_ratio: f32, pub sort: bool, pub p2g_win: bool, pub ballistic: bool, pub settle: bool, pub mg: bool,
    pub detail: f32, pub col_max: f32, pub vmax_w: f32, pub scale: f32, pub tear: f32,
    pub size: [f32; 3], pub open: u32, pub org: [f32; 3],
    pub fills: Vec<Fill>, pub events: Vec<Event>, pub objs: Vec<Obj>,
    pub wind: [f32; 3], pub drag: f32, pub gust: f32, pub foam_sens: f32, pub foam_tau: f32,
    /// narrow band depth in cells (bakeNb: the live band kept in metres), when on
    pub nb: Option<f32>,
    pub ocean: Option<Ocean>,
    pub spr: Option<Spr>, pub air: Option<Air>, pub drip: Option<Drip>,
    /// the most whitewater points alive at once (0: whitewater off)
    pub spray_cap: u32,
    /// narrow band look: the grid-only deep water saved as points too
    pub nb_look: bool,
    /// tall cells for the deep narrow-band water (native only; solver.tallCells, on by default)
    pub tall: bool,
    /// parts of the scene the native solver does not run yet: said once, then left out
    pub left_out: Vec<String>,
    /// the scene file, kept for the cache header (the page reloads it from there)
    pub scene: Value,
    /// the settings as the page writes them into a cache's header (desc), without the heavy parts
    pub light: Value,
}

fn num(v: &Value, k: &str, d: f64) -> f64 { v.get(k).and_then(Value::as_f64).unwrap_or(d) }
fn flag(v: &Value, k: &str, d: bool) -> bool { v.get(k).and_then(Value::as_bool).unwrap_or(d) }

fn keys_of(o: &Value, org: [f32; 3]) -> Vec<Key> {
    let mut ks: Vec<Key> = o.get("keys").and_then(Value::as_array).map(|a| a.iter().map(|k| {
        let mut ch = Vec::new();
        if let Some(m) = k.as_object() {
            for (name, v) in m {
                if name == "t" { continue; }
                let val = match v { Value::Bool(b) => *b as u8 as f32, Value::Number(n) => n.as_f64().unwrap_or(0.0) as f32, _ => continue };
                // keys hold scene positions; the solver's are relative to the origin (buildDesc)
                let val = match name.as_str() { "x" => val - org[0], "y" => val - org[1], "z" => val - org[2], _ => val };
                ch.push((name.clone(), val));
            }
        }
        Key { t: num(k, "t", 0.0) as f32, ch }
    }).collect()).unwrap_or_default();
    ks.sort_by(|a, b| a.t.total_cmp(&b.t));
    ks
}

/// The page's Quality slider and Max points rule (bakeRes), and every other setting (buildDesc, simPar).
pub fn desc_from_scene(scene: &Value, o: &BakeOpts) -> Result<Desc, String> {
    if scene.get("app").and_then(Value::as_str) != Some("SplashTank") { return Err("This is not a SplashTank scene file.".into()); }
    let sv = scene.get("solver").cloned().unwrap_or(Value::Null);
    let bx = scene.get("box").cloned().unwrap_or(Value::Null);
    let sz = bx.get("size").cloned().unwrap_or(Value::Null);
    let size = [num(&sz, "w", 3.0) as f32, num(&sz, "h", 2.6) as f32, num(&sz, "d", 3.0) as f32];
    let mn = bx.get("min").cloned().unwrap_or(Value::Null);
    let min = [num(&mn, "x", -size[0] as f64 / 2.0) as f32, num(&mn, "y", 0.0) as f32, num(&mn, "z", -size[2] as f64 / 2.0) as f32];
    // S.org: the middle of the tank's floor
    // the page fits the tank to whole cells of the live grid, its low corner kept (makeSim); a scene saved at this spacing is already fitted
    let live = crate::flip::layout(o.spacing, num(&sv, "cellRatio", 2.0) as f32, size);
    let (size, size64) = (live.size, live.size64());
    let org = [min[0] + size[0] / 2.0, min[1], min[2] + size[2] / 2.0];
    let op = bx.get("open").cloned().unwrap_or(Value::Null);
    let open = ["x0", "x1", "y0", "y1", "z0", "z1"].iter().enumerate().map(|(k, n)| (flag(&op, n, false) as u32) << k).sum();
    let bk = scene.get("bake").cloned().unwrap_or(Value::Null);
    let scale = num(&sv, "scale", 1.0) as f32;
    let k = 1.0 / scale;
    let fps = num(&bk, "fps", 24.0) as f32;
    let detail = o.detail.unwrap_or(num(&bk, "detail", 1.0) as f32);
    let dur = o.seconds.unwrap_or(num(&bk, "dur", 5.0) as f32);
    let cap = num(&sv, "cap", 120000.0);
    // bakeRes: spacing over the detail; Max points the live cap times detail cubed, at most the larger of 3M (PRESET.flip.bkMax) and the cap
    let d = ((o.spacing / detail) * 10000.0).round() / 10000.0;
    let f3 = (detail as f64).powi(3);
    let max_n = o.max_points.unwrap_or((cap * f3).min(3_000_000f64.max(cap)).round() as u32);
    let kk = 60.0 / fps;
    let lo = num(&sv, "subMin", 1.0).max(1.0).floor() as f32;
    let hi = (num(&sv, "subMax", 16.0).floor() as f32).max(lo);
    let substeps = ((lo * kk - 1e-6).ceil() as u32).max(1);
    let max_sub = ((hi * kk * detail - 1e-6).ceil() as u32).max(1);
    let cell_ratio = num(&sv, "cellRatio", 2.0) as f32;
    let sep = num(&sv, "sep", 10.0) as f32;
    let accurate = o.accurate.unwrap_or(bk.get("accuracy").and_then(Value::as_str) == Some("accurate"));

    let left_out = Vec::new();
    // narrow band and ocean (nbCfg, bakeNb, oceanCfg): a band of 10 cells or more is full depth
    let ov = scene.get("ocean").cloned().unwrap_or(Value::Null);
    let ocean = flag(&ov, "on", false).then(|| Ocean {
        height: num(&ov, "height", 2.0) / scale as f64, length: num(&ov, "length", 30.0) / scale as f64, dir: num(&ov, "dir", 0.0), spread: num(&ov, "spread", 25.0),
        seed: num(&ov, "seed", 1.0) as i32, level: num(&ov, "level", 0.5) * size[1] as f64, layer: num(&ov, "layer", 0.15) * size[0].min(size[2]) as f64 });
    let nb_active = flag(&sv, "nbOn", false) || ocean.is_some();
    let nb = nb_active.then(|| {
        let band = num(&sv, "nbBand", 3.0);
        if band >= 10.0 { 1e4f32 } else { ((band * o.spacing as f64 / d as f64 * 10.0).round() / 10.0) as f32 }
    });
    // whitewater, air field and drips (simPar)
    let spr_on = flag(&sv, "sprOn", true);
    let spr = spr_on.then(|| Spr {
        rate: 12.0 * num(&sv, "sprAmt", 2.0) as f32, min: num(&sv, "sprMin", 2.5) as f32, life: num(&sv, "sprLife", 1.2) as f32, mist: num(&sv, "sprMist", 0.3) as f32,
        drag: num(&sv, "sprDrag", 1.0) as f32, mdrag: num(&sv, "mistDrag", 5.0) as f32,
        foam_life: num(&sv, "wwFoamLife", 8.0) as f32, rise: num(&sv, "wwRise", 0.4) as f32 * k, crest: num(&sv, "wwCrest", 1.0) as f32, impact: num(&sv, "wwImpact", 0.25) as f32,
        spin: num(&sv, "wwSpin", 0.5) as f32, edge: num(&sv, "wwEdge", 70.0) as f32, erode: num(&sv, "wwErode", 0.25) as f32, land: num(&sv, "wwLand", 1.0) as f32,
        trail: num(&sv, "wwTrail", 1.0) as f32,
        area: [(num(&sv, "wwArea", 2.0) as f32).max(1.0), (num(&sv, "wwAreaUp", 2.0) as f32).max(1.0)] });
    let air = flag(&sv, "airOn", true).then(|| Air {
        couple: num(&sv, "airCouple", 3.0) as f32, decay: num(&sv, "airDecay", 0.6) as f32, real: flag(&sv, "airReal", true), feel: flag(&sv, "airFeel", true),
        size: num(&sv, "turbSize", 3.0) as f32 * k, oct: num(&sv, "turbOct", 3.0) as f32, speed: num(&sv, "turbSpeed", 0.4) as f32, swirl: num(&sv, "airSwirl", 0.5) as f32,
        iters: 20, blur: 0.35 });
    let drip = (spr_on && flag(&sv, "dripOn", true)).then(|| Drip { rate: num(&sv, "dripRate", 2.0) as f32, dry: num(&sv, "dripDry", 3.0) as f32 });
    let spray_cap = if spr_on { num(&sv, "sprCap", 600000.0) as u32 } else { 0 };
    let nb_look = flag(&sv, "nbLook", false) && nb_active;
    let wv = sv.get("wind").cloned().unwrap_or(Value::Null);
    let (ws, waz) = (num(&wv, "speed", 0.0) as f32, (num(&wv, "az", 0.0) as f32).to_radians());
    let wind = [ws * waz.cos() * k, num(&wv, "up", 0.0) as f32 * k, ws * waz.sin() * k];

    // objects: meshes get their distance grids (rebuildSDF: cell 0.025, margin 0.16, in the mesh's own unscaled coordinates)
    let smooth = scene.pointer("/timeline/smooth").and_then(Value::as_bool).unwrap_or(true);
    let mut objs = Vec::new();
    let mut fills = Vec::new();
    for ov in scene.get("objs").and_then(Value::as_array).cloned().unwrap_or_default() {
        let shape = ov.get("shape").or_else(|| ov.get("kind")).and_then(Value::as_str).unwrap_or("");
        let emitter = shape == "emitter";
        let water = flag(&ov, "water", false);
        let sdf = if emitter { None } else {
            ov.get("mesh").and_then(|m| {
                let v: Vec<[f32; 3]> = m.get("v")?.as_array()?.iter().filter_map(|p| { let a = p.as_array()?; Some([a.first()?.as_f64()? as f32, a.get(1)?.as_f64()? as f32, a.get(2)?.as_f64()? as f32]) }).collect();
                let f: Vec<Vec<u32>> = m.get("f")?.as_array()?.iter().filter_map(|t| t.as_array()?.iter().map(|k| k.as_u64().map(|k| k as u32)).collect::<Option<Vec<_>>>())
                    .filter(|f| f.len() >= 3 && f.iter().all(|&k| (k as usize) < v.len())).collect();
                (!f.is_empty()).then(|| Arc::new(sdf::build(&v, &f, 0.025, 0.16)))
            })
        };
        let g = |k: &str, d: f64| num(&ov, k, d) as f32;
        let ob = Obj {
            id: ov.get("id").and_then(Value::as_u64).unwrap_or(0), emitter, water,
            x: g("x", 0.0) - org[0], y: g("y", 0.0) - org[1], z: g("z", 0.0) - org[2],
            rx: g("rx", 0.0), yaw: g("yaw", 0.0), rz: g("rz", 0.0),
            sx: if g("sx", 1.0) > 0.0 { g("sx", 1.0) } else { 1.0 }, sy: if g("sy", 1.0) > 0.0 { g("sy", 1.0) } else { 1.0 }, sz: if g("sz", 1.0) > 0.0 { g("sz", 1.0) } else { 1.0 },
            spin: g("spin", 0.0), sdf,
            az: g("az", 0.0), el: g("el", -30.0), speed: g("speed", 4.0), radius: g("radius", 0.15), on: flag(&ov, "on", true),
            random: ov.get("mode").and_then(Value::as_str) == Some("random"), spread: g("spread", 0.0), density: g("density", 1.0), turb: g("turb", 0.0),
            keys: keys_of(&ov, org), smooth,
            rec: ov.get("rec").filter(|r| r.is_object()).and_then(|r| {
                let a: Vec<f32> = r.get("arr")?.as_array()?.iter().enumerate().map(|(i, v)| {
                    let v = v.as_f64().unwrap_or(0.0) as f32;
                    if i % 4 < 3 { v - org[i % 4] } else { v }
                }).collect();
                (a.len() >= 4).then(|| (num(r, "start", 0.0) as f32, a))
            }),
        };
        // a water volume is starting water, not a collider (volRec)
        if water { if let Some(sd) = &ob.sdf {
            let r = sdf::euler_mat(ob.rx, ob.yaw, ob.rz);
            let (mut lo, mut hi) = ([1e9f32; 3], [-1e9f32; 3]);
            if let Some(m) = ov.get("mesh").and_then(|m| m.get("v")).and_then(Value::as_array) {
                for p in m {
                    let a = p.as_array().map(|a| [0, 1, 2].map(|k| a.get(k).and_then(Value::as_f64).unwrap_or(0.0) as f32)).unwrap_or([0.0; 3]);
                    let q = [a[0] * ob.sx, a[1] * ob.sy, a[2] * ob.sz];
                    let w = [r[0] * q[0] + r[1] * q[1] + r[2] * q[2] + ob.x, r[3] * q[0] + r[4] * q[1] + r[5] * q[2] + ob.y, r[6] * q[0] + r[7] * q[1] + r[8] * q[2] + ob.z];
                    for k in 0..3 { lo[k] = lo[k].min(w[k]); hi[k] = hi[k].max(w[k]); }
                }
            }
            let s = (ob.sx != 1.0 || ob.sy != 1.0 || ob.sz != 1.0).then_some([ob.sx, ob.sy, ob.sz]);
            fills.push(Fill::Vol { sdf: sd.clone(), pos: [ob.x, ob.y, ob.z], r, s, lo, hi });
        } }
        objs.push(ob);
    }
    // box fills are shares of the tank's width and depth (resolveFills)
    let (w, dd) = (size64[0], size64[2]);
    let mut box_fills = Vec::new();
    for f in scene.get("fills").and_then(Value::as_array).cloned().unwrap_or_default() {
        match f.get("t").and_then(Value::as_str) {
            Some("box") => {
                let y1 = num(&f, "y1", 0.0).min(size64[1]);
                let y0 = num(&f, "y0", 0.0);
                if y1 - y0 > 0.01 {
                    let fx = |k: &str| num(&f, k, 0.0);
                    box_fills.push(Fill::Box { x0: -w / 2.0 + fx("fx0") * w, x1: -w / 2.0 + fx("fx1") * w, y0, y1, z0: -dd / 2.0 + fx("fz0") * dd, z1: -dd / 2.0 + fx("fz1") * dd });
                }
            }
            Some("sphere") | None => box_fills.push(Fill::Sphere { x: num(&f, "x", 0.0), y: num(&f, "y", 0.0), z: num(&f, "z", 0.0), r: num(&f, "r", 0.0), vy: num(&f, "vy", 0.0) }),
            _ => {}
        }
    }
    box_fills.extend(fills);
    let events = scene.get("events").and_then(Value::as_array).map(|a| a.iter().map(|e| Event {
        t: num(e, "t", 0.0) as f32, x: num(e, "x", 0.0), y: num(e, "y", 0.0), z: num(e, "z", 0.0), r: num(e, "r", 0.38) }).collect()).unwrap_or_default();

    let g = num(&sv, "g", 9.8) as f32 * k;
    let iters = num(&sv, "iters", 30.0) as u32;
    let apic = sv.get("xfer").and_then(Value::as_str).unwrap_or("apic") == "apic";
    let mut dsc = Desc {
        d, max_n, max_n_set: o.max_points.is_some(), fps, substeps, max_sub, frames: (dur * fps).round() as u32,
        g, iters, flip: num(&sv, "flip", 0.95) as f32, apic_flip: num(&sv, "apicFlip", 0.8) as f32, comp: if sep > 0.0 { 0.0 } else { 6.0 }, sep, apic, accurate,
        // the Speed-ups switches: not in the page's scene files (its defaults then), kept under solver by the native window
        cell_ratio, sort: flag(&sv, "sortP", true), p2g_win: flag(&sv, "p2gWin", false), ballistic: flag(&sv, "ballistic", true), settle: flag(&sv, "settle", false), mg: flag(&sv, "mg", true),
        detail, col_max: num(&sv, "colMax", 100.0) as f32 * k, vmax_w: num(&sv, "vmaxW", 50.0) as f32 * k, scale,
        tear: num(&sv, "tear", 0.5) as f32 * 0.5 * cell_ratio.powi(3),
        size, open, org, fills: box_fills, events, objs,
        wind, drag: num(&sv, "airDrag", 0.3) as f32 * k, gust: num(&sv, "gust", 1.0) as f32 * k, foam_sens: num(&sv, "foamSens", 1.0) as f32 * k, foam_tau: num(&sv, "foamTau", 1.2) as f32,
        nb, ocean, spr, air, drip, spray_cap, nb_look, tall: flag(&sv, "tallCells", true),
        left_out, scene: scene.clone(), light: Value::Null,
    };
    dsc.light = serde_json::json!({
        "d": dsc.d, "maxN": dsc.max_n, "fps": dsc.fps, "substeps": dsc.substeps, "frames": dsc.frames, "g": dsc.g, "iters": dsc.iters,
        "flip": dsc.flip, "apicFlip": dsc.apic_flip, "comp": dsc.comp, "sep": dsc.sep, "apic": dsc.apic, "accurate": dsc.accurate, "cellRatio": dsc.cell_ratio,
        "sortP": dsc.sort, "p2gWin": dsc.p2g_win, "ballistic": dsc.ballistic, "settle": dsc.settle, "mg": dsc.mg, "maxSub": dsc.max_sub, "detail": dsc.detail,
        "colMax": dsc.col_max, "vmaxW": dsc.vmax_w, "scale": dsc.scale, "tear": dsc.tear, "size": dsc.size, "open": dsc.open,
        "wind": dsc.wind, "drag": dsc.drag, "gust": dsc.gust, "foamSens": dsc.foam_sens, "foamTau": dsc.foam_tau,
        "nb": dsc.nb.map(|b| serde_json::json!({ "on": true, "band": b })),
        "ocean": dsc.ocean.map(|c| serde_json::json!({ "on": true, "height": c.height, "length": c.length, "dir": c.dir, "spread": c.spread, "seed": c.seed, "level": c.level, "layer": c.layer })),
        "spr": dsc.spr.map(|s| serde_json::json!({ "rate": s.rate, "min": s.min, "life": s.life, "mist": s.mist, "drag": s.drag, "mdrag": s.mdrag,
            "ww": { "foamLife": s.foam_life, "rise": s.rise, "crest": s.crest, "impact": s.impact, "spin": s.spin, "edge": s.edge, "erode": s.erode, "land": s.land, "trail": s.trail,
                "area": { "k": s.area[0], "up": s.area[1] } } })),
        "air": dsc.air.map(|a| serde_json::json!({ "on": true, "couple": a.couple, "decay": a.decay, "real": a.real, "feel": a.feel, "size": a.size, "oct": a.oct, "speed": a.speed, "swirl": a.swirl, "iters": a.iters })),
        "drip": dsc.drip.map(|d| serde_json::json!({ "on": true, "rate": d.rate, "dry": d.dry })),
        "sprayCap": dsc.spray_cap, "nbLook": dsc.nb_look,
        "native": { "spacing": o.spacing, "leftOut": dsc.left_out },
    });
    Ok(dsc)
}

/// An object's state at time t: keys first, else recorded motion, else its spin (sampleObjState).
pub fn sample(o: &Obj, t: f32) -> Obj {
    let mut s = o.clone();
    if !o.keys.is_empty() {
        let groups: [(&str, &[&str]); 7] = [("loc", &["x", "y", "z"]), ("rot", &["rx", "yaw", "rz"]), ("scale", &["sx", "sy", "sz"]), ("aim", &["az", "el"]),
            ("radius", &["radius"]), ("speed", &["speed"]), ("on", &["on"])];
        for (g, ch) in groups {
            // shapes take no source channels and sources no scale
            if !o.emitter && matches!(g, "on" | "speed" | "radius" | "aim") { continue; }
            if o.emitter && g == "scale" { continue; }
            let ks: Vec<&Key> = o.keys.iter().filter(|k| k.get(ch[0]).is_some()).collect();
            let n = ks.len();
            if n == 0 { continue; }
            let mut out: Vec<f32>;
            if g == "on" {
                let mut v = ks[0].get("on").unwrap();
                for k in &ks { if k.t <= t { v = k.get("on").unwrap(); } }
                out = vec![v];
            } else if t <= ks[0].t || n == 1 {
                out = ch.iter().map(|c| ks[0].get(c).unwrap_or(0.0)).collect();
            } else if t >= ks[n - 1].t {
                out = ch.iter().map(|c| ks[n - 1].get(c).unwrap_or(0.0)).collect();
            } else {
                let mut i = 0;
                while i < n - 2 && t >= ks[i + 1].t { i += 1; }
                let (a, b) = (ks[i], ks[i + 1]);
                let u = (t - a.t) / (b.t - a.t).max(1e-6);
                let p0 = if i > 0 { ks[i - 1] } else { a };
                let p3 = if i + 2 < n { ks[i + 2] } else { b };
                let (u2, u3) = (u * u, u * u * u);
                out = ch.iter().map(|c| {
                    let (aa, bb, pp0, pp3) = (a.get(c).unwrap_or(0.0), b.get(c).unwrap_or(0.0), p0.get(c).unwrap_or(0.0), p3.get(c).unwrap_or(0.0));
                    if !o.smooth || g == "speed" { aa + (bb - aa) * u }
                    else { 0.5 * ((2.0 * aa) + (-pp0 + bb) * u + (2.0 * pp0 - 5.0 * aa + 4.0 * bb - pp3) * u2 + (-pp0 + 3.0 * aa - 3.0 * bb + pp3) * u3) }
                }).collect();
            }
            if g == "scale" { for v in &mut out { *v = v.max(0.02); } }
            if g == "radius" { out[0] = out[0].clamp(0.03, 0.5); }
            for (c, v) in ch.iter().zip(out) {
                match *c {
                    "x" => s.x = v, "y" => s.y = v, "z" => s.z = v, "rx" => s.rx = v, "yaw" => s.yaw = v, "rz" => s.rz = v,
                    "sx" => s.sx = v, "sy" => s.sy = v, "sz" => s.sz = v, "az" => s.az = v, "el" => s.el = v,
                    "speed" => s.speed = v, "radius" => s.radius = v, "on" => s.on = v != 0.0, _ => {}
                }
            }
        }
    } else if let Some((start, a)) = &o.rec {
        let n = a.len() / 4;
        let k = (t * 60.0 - start).clamp(0.0, (n - 1) as f32);
        let i0 = k.floor() as usize;
        let i1 = (i0 + 1).min(n - 1);
        let w = k - i0 as f32;
        let l = |c: usize| a[i0 * 4 + c] + (a[i1 * 4 + c] - a[i0 * 4 + c]) * w;
        s.x = l(0); s.y = l(1); s.z = l(2); s.yaw = l(3);
    } else {
        s.yaw = o.yaw + o.spin * t;
    }
    s
}

/// The fastest object (or source) moving between two states a frame apart; jumps beyond lim do not count (objSpeed).
pub fn obj_speed(a: &[Obj], b: &[Obj], dt: f32, lim: f32) -> f32 {
    let mut v = 0f32;
    for (p, o) in a.iter().zip(b) {
        if o.emitter { if o.on { v = v.max(o.speed); } continue; }
        if p.id != o.id { continue; }
        let lin = ((o.x - p.x).powi(2) + (o.y - p.y).powi(2) + (o.z - p.z).powi(2)).sqrt();
        let rot = (o.rx - p.rx).abs() + (o.yaw - p.yaw).abs() + (o.rz - p.rz).abs();
        let r = o.sdf.as_ref().map(|s| 0.5 * s.cell * ((s.dims[0].pow(2) + s.dims[1].pow(2) + s.dims[2].pow(2)) as f32).sqrt()).unwrap_or(0.5);
        let sz = o.sx.max(o.sy).max(o.sz);
        let grow = (o.sx - p.sx).abs() + (o.sy - p.sy).abs() + (o.sz - p.sz).abs();
        let ov = (lin + rot * r * sz + grow * r) / dt;
        if lim <= 0.0 || ov <= lim { v = v.max(ov); }
    }
    v
}

/// A collider for one step: pose, size, and the velocities its motion gives the water.
#[derive(Clone)]
pub struct Col {
    pub sdf: Arc<Sdf>,
    pub pos: [f32; 3],
    pub r: [f32; 9],
    pub s: [f32; 3],
    pub v: [f32; 3],
    pub w: [f32; 3],
    pub g: [f32; 3],
}
