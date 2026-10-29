//! Editing a scene in the window: the Simulation settings (the page's rows, from settings.json made by native/tools/export-settings.js),
//! the tank, and the objects. Everything edits the scene file's JSON in place, so whatever the window does not show is kept as it was and
//! the saved file opens in the page as before.

use eframe::egui;
use serde_json::{json, Value};
use std::sync::OnceLock;

fn spec() -> &'static Value {
    static S: OnceLock<Value> = OnceLock::new();
    S.get_or_init(|| serde_json::from_str(include_str!("settings.json")).expect("settings.json"))
}

fn get<'a>(j: &'a Value, path: &[&str]) -> Option<&'a Value> { path.iter().try_fold(j, |v, k| v.get(*k)) }
fn set(j: &mut Value, path: &[&str], val: Value) {
    let mut v = j;
    for k in &path[..path.len() - 1] {
        if !v.get(*k).is_some_and(Value::is_object) { v[*k] = json!({}); }
        v = &mut v[*k];
    }
    v[path[path.len() - 1]] = val;
}
fn path_of(r: &Value) -> Vec<&str> { r["path"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default() }

/// A row's name, bold when the setting differs from the page's default (as the page shows it), with the page's tooltip.
fn label(ui: &mut egui::Ui, text: &str, changed: bool, tip: &str) {
    let t = egui::RichText::new(text);
    let r = ui.label(if changed { t.strong().color(egui::Color32::WHITE) } else { t.color(egui::Color32::from_gray(0xa0)) });
    if !tip.is_empty() { r.on_hover_text(tip); }
}

fn row(ui: &mut egui::Ui, j: &mut Value, r: &Value) -> bool {
    let path = path_of(r);
    let tip = r["tip"].as_str().unwrap_or("");
    let name = r["label"].as_str().unwrap_or("");
    if r["kind"] == "check" {
        let def = r["def"].as_bool().unwrap_or(false);
        let mut on = get(j, &path).and_then(Value::as_bool).unwrap_or(def);
        label(ui, name, on != def, tip);
        let ch = ui.checkbox(&mut on, "").changed();
        if ch { set(j, &path, json!(on)); }
        return ch;
    }
    let f = |k: &str| r[k].as_f64();
    let (min, max, def) = (f("min").unwrap_or(0.0), f("max").unwrap_or(1.0), f("def").unwrap_or(0.0));
    let inv = r["inv"].as_bool().unwrap_or(false);
    let v = get(j, &path).and_then(Value::as_f64).unwrap_or(def);
    // White water amount shows 1 / foamSens, as the page does
    let mut shown = if inv { 1.0 / v.max(1e-6) } else { v };
    label(ui, name, (v - def).abs() > 1e-9 * def.abs().max(1.0), tip);
    let unit = r["unit"].as_str().unwrap_or("").to_owned();
    let (pct, off) = (r["pct"].as_bool().unwrap_or(false), r["off"].as_bool().unwrap_or(false));
    let full = r["key"] == "nbBand";
    let step = f("step").or(f("round")).unwrap_or(0.0);
    let before = shown;
    let mut s = egui::Slider::new(&mut shown, min..=max).logarithmic(r["log"].as_bool().unwrap_or(false)).clamping(egui::SliderClamping::Edits)
        .custom_formatter(move |x, _| {
            if off && x == 0.0 { return "off".into(); }
            if full && x >= 10.0 { return "Full depth".into(); }
            if pct { return format!("{:.0}%", x * 100.0); }
            let n = if x.abs() >= 100.0 || step >= 1.0 { format!("{x:.0}") } else if x.abs() >= 10.0 { format!("{x:.1}") } else { format!("{x:.2}") };
            if unit.is_empty() { n } else if unit == "x" || unit == "°" || unit == "%" { format!("{n}{unit}") } else { format!("{n} {unit}") }
        })
        .custom_parser(|t| t.trim().trim_end_matches(|c: char| !c.is_ascii_digit() && c != '.').trim().parse::<f64>().ok().map(|x| if pct && x > 1.0 { x / 100.0 } else { x }));
    if step > 0.0 { s = s.step_by(step); }
    let resp = ui.add(s);
    // only a real edit counts: drawing a stored value that is off the step or range must not mark the scene changed
    let ch = resp.changed() && (resp.dragged() || resp.has_focus() || resp.lost_focus() || resp.clicked()) && (shown - before).abs() > 1e-12;
    if ch {
        let nv = if inv { 1.0 / shown } else { shown };
        // whole numbers stay whole in the file (the page writes 30, not 30.0)
        set(j, &path, if nv.fract() == 0.0 && nv.abs() < 1e15 { json!(nv as i64) } else { json!(nv) });
    }
    ch
}

fn group(ui: &mut egui::Ui, j: &mut Value, gi: usize) -> bool {
    let sp = spec();
    let g = &sp["groups"][gi];
    let rows: Vec<&Value> = sp["rows"].as_array().unwrap().iter().filter(|r| r["group"].as_u64() == Some(gi as u64)).collect();
    let subs: Vec<usize> = sp["groups"].as_array().unwrap().iter().enumerate().filter(|(_, s)| s["parent"].as_u64() == Some(gi as u64)).map(|(k, _)| k).collect();
    if rows.is_empty() && subs.is_empty() { return false; }
    let mut changed = false;
    let h = egui::CollapsingHeader::new(g["title"].as_str().unwrap_or("")).id_salt(("simgroup", gi)).default_open(g["open"].as_bool().unwrap_or(false)).show(ui, |ui| {
        egui::Grid::new(("simrows", gi)).num_columns(2).spacing([8.0, 3.0]).show(ui, |ui| {
            for r in &rows { changed |= row(ui, j, r); ui.end_row(); }
        });
        for s in &subs { changed |= group(ui, j, *s); }
    });
    if let Some(t) = g["tip"].as_str().filter(|t| !t.is_empty()) { h.header_response.on_hover_text(t); }
    changed
}

/// The Simulation tab: every setting a scene file keeps, grouped as on the page.
pub fn settings(ui: &mut egui::Ui, j: &mut Value) -> bool {
    let sp = spec();
    let mut changed = false;
    for (gi, g) in sp["groups"].as_array().unwrap().iter().enumerate() {
        if g["parent"].is_null() { changed |= group(ui, j, gi); }
    }
    // the ocean needs the narrow band (the page turns it on with the ocean)
    if changed && get(j, &["ocean", "on"]).and_then(Value::as_bool) == Some(true) { set(j, &["solver", "nbOn"], json!(true)); }
    changed
}

/// The Tank tab: where each face of the tank is, which faces are open, and how far whitewater may fly past it.
pub fn tank(ui: &mut egui::Ui, j: &mut Value) -> bool {
    let n = |p: &[&str], d: f64| get(j, p).and_then(Value::as_f64).unwrap_or(d);
    let (w, h, d) = (n(&["box", "size", "w"], 3.0), n(&["box", "size", "h"], 2.6), n(&["box", "size", "d"], 3.0));
    let (x0, y0, z0) = (n(&["box", "min", "x"], -w / 2.0), n(&["box", "min", "y"], 0.0), n(&["box", "min", "z"], -d / 2.0));
    let mut f = [x0, x0 + w, y0, y0 + h, z0, z0 + d];
    let mut changed = false;
    ui.label("Type a position for each face. Tick Open to let water leave through that face.");
    egui::Grid::new("tankfaces").num_columns(3).spacing([8.0, 3.0]).show(ui, |ui| {
        for (k, (key, name)) in [("x0", "Left (-X)"), ("x1", "Right (+X)"), ("y0", "Floor"), ("y1", "Top"), ("z0", "Back (-Z)"), ("z1", "Front (+Z)")].iter().enumerate() {
            ui.label(*name);
            if ui.add(egui::DragValue::new(&mut f[k]).speed(0.01).max_decimals(3)).changed() { changed = true; }
            let mut open = get(j, &["box", "open", key]).and_then(Value::as_bool).unwrap_or(false);
            if ui.checkbox(&mut open, "Open").changed() { set(j, &["box", "open", key], json!(open)); changed = true; }
            ui.end_row();
        }
    });
    if changed {
        // a face cannot pass the opposite one
        for a in 0..3 { if f[2 * a + 1] < f[2 * a] + 0.05 { f[2 * a + 1] = f[2 * a] + 0.05; } }
        set(j, &["box", "min"], json!({ "x": f[0], "y": f[2], "z": f[4] }));
        set(j, &["box", "size"], json!({ "w": f[1] - f[0], "h": f[3] - f[2], "d": f[5] - f[4] }));
    }
    ui.label(format!("The tank is {:.2} x {:.2} x {:.2}.", f[1] - f[0], f[3] - f[2], f[5] - f[4]));
    // the page's Fill tank: a water box across the whole tank up to a height
    ui.horizontal(|ui| {
        let id = ui.make_persistent_id("fillh");
        let mut fh: f64 = ui.data_mut(|d| *d.get_temp_mut_or(id, (f[3] - f[2]).min(1.0 / 0.4) * 0.4));
        ui.label("Fill tank").on_hover_text("Adds a water volume across the whole tank, up to this height above the floor.");
        ui.add(egui::DragValue::new(&mut fh).range(0.05..=(f[3] - f[2])).speed(0.01).max_decimals(2));
        ui.data_mut(|d| d.insert_temp(id, fh));
        if ui.button("to height").clicked() {
            let objs = j["objs"].as_array().cloned().unwrap_or_default();
            let id = objs.iter().filter_map(|o| o["id"].as_u64()).max().unwrap_or(0) + 1;
            let (hx, hy, hz) = ((f[1] - f[0]) / 2.0 - 0.02, fh / 2.0, (f[5] - f[4]) / 2.0 - 0.02);
            let (x, y, z) = ((f[0] + f[1]) / 2.0, f[2] + fh / 2.0, (f[4] + f[5]) / 2.0);
            let mut o = crate::tf::new_object(j, "cube", true);
            o["id"] = json!(id); o["name"] = json!("Tank water");
            for (k, v) in [("x", x), ("y", y), ("z", z), ("px", x), ("py", y), ("pz", z), ("hx", hx), ("hy", hy), ("hz", hz)] { o[k] = json!(v); }
            o["mesh"] = crate::tf::mesh_cube(hx, hy, hz);
            if let Some(a) = j["objs"].as_array_mut() { a.push(o); }
            changed = true;
        }
    });
    let area = [(1.0, "Tank only"), (1.5, "1.5 x tank"), (2.0, "2 x tank"), (3.0, "3 x tank"), (4.0, "4 x tank")];
    for (key, name, tip) in [("wwArea", "Whitewater area", "Spray, mist and foam may fly on past the tank walls, up to this many times the tank's width and depth (the dashed box). The water itself stays in the tank."),
                             ("wwAreaUp", "Spray height", "How high spray may fly above the tank floor, in tank heights.")] {
        let mut v = get(j, &["solver", key]).and_then(Value::as_f64).unwrap_or(2.0);
        ui.horizontal(|ui| {
            label(ui, name, v != 2.0, tip);
            egui::ComboBox::from_id_salt(key).selected_text(area.iter().find(|a| a.0 == v).map(|a| a.1).unwrap_or("?")).show_ui(ui, |ui| {
                for (a, t) in area { if ui.selectable_value(&mut v, a, t).changed() { set(j, &["solver", key], json!(a)); changed = true; } }
            });
        });
    }
    changed
}

/// A field's name coloured as Blender does: yellow where its group has a key on the frame shown, green where it is animated.
fn klabel(ui: &mut egui::Ui, text: &str, (now, anim): (bool, bool), tip: &str) {
    let c = if now { egui::Color32::from_rgb(0xe9, 0xc8, 0x4a) } else if anim { egui::Color32::from_rgb(0x6c, 0xc0, 0x4a) } else { egui::Color32::from_gray(0xa0) };
    let r = ui.label(egui::RichText::new(text).color(c));
    if !tip.is_empty() { r.on_hover_text(tip); }
}

/// Three number fields in a row (scale: shown = stored x scale, e.g. radians shown in degrees).
#[allow(clippy::too_many_arguments)]
fn vec3(ui: &mut egui::Ui, o: &mut Value, name: &str, keys: [&str; 3], d: f64, scale: f64, speed: f64, tip: &str, ks: (bool, bool)) -> bool {
    let mut changed = false;
    ui.horizontal(|ui| {
        klabel(ui, name, ks, tip);
        for k in keys {
            let mut v = o[k].as_f64().unwrap_or(d) * scale;
            if ui.add(egui::DragValue::new(&mut v).speed(speed).max_decimals(3)).changed() { o[k] = json!(v / scale); changed = true; }
        }
    });
    changed
}

/// The Objects tab: the outliner and the selected object's settings (the page's object panel).
pub fn objects(ui: &mut egui::Ui, j: &mut Value, sel: &mut Option<usize>, t: f64) -> bool {
    let mut changed = false;
    let Some(list) = j.get_mut("objs").and_then(Value::as_array_mut) else { return false; };
    if list.is_empty() { ui.label("No objects."); return false; }
    egui::ScrollArea::vertical().id_salt("outliner").max_height(180.0).show(ui, |ui| {
        for (k, o) in list.iter().enumerate() {
            let kind = if crate::tf::is_emitter(o) { "source" } else if o["water"].as_bool() == Some(true) { "water" } else { o["shape"].as_str().unwrap_or("mesh") };
            let keys = o["keys"].as_array().map_or(0, Vec::len);
            let txt = format!("{}  ({kind}{})", o["name"].as_str().unwrap_or("?"), if keys > 0 { format!(", {keys} keys") } else { String::new() });
            if ui.selectable_label(*sel == Some(k), txt).clicked() { *sel = Some(k); }
        }
    });
    let Some(o) = sel.and_then(|k| list.get_mut(k)) else { return false; };
    ui.separator();
    let emitter = crate::tf::is_emitter(o);
    let mut name = o["name"].as_str().unwrap_or("").to_owned();
    ui.horizontal(|ui| { ui.label("Name"); if ui.text_edit_singleline(&mut name).changed() { o["name"] = json!(name); changed = true; } });
    if o["keys"].as_array().is_some_and(|a| !a.is_empty()) {
        ui.colored_label(egui::Color32::from_rgb(0xe9, 0xa4, 0x3a), "Keyed: the fields show the pose at the time on the timeline (yellow: a key on this frame, green: animated). Change a field and press I (or turn on Auto key) to key it; moving the time puts it back to its keys.");
    }
    let num = |o: &Value, k: &str, d: f64| o[k].as_f64().unwrap_or(d);
    let ks = |g: &str| crate::tf::key_state(o, g, t);
    let (kl, kr, kc) = (ks("loc"), ks("rot"), ks("scale"));
    let (ka, kd, kv, ko) = (ks("aim"), ks("radius"), ks("speed"), ks("on"));
    if vec3(ui, o, "Location", ["x", "y", "z"], 0.0, 1.0, 0.01, "Where the object is, in scene units.", kl) {
        // the pose the page draws a stopped scene at goes with it
        for (k, p) in [("x", "px"), ("y", "py"), ("z", "pz")] { o[p] = o[k].clone(); }
        changed = true;
    }
    if !emitter {
        changed |= vec3(ui, o, "Rotation", ["rx", "yaw", "rz"], 0.0, 180.0 / std::f64::consts::PI, 0.5, "Turned about X, Y and Z, in degrees.", kr);
        changed |= vec3(ui, o, "Scale", ["sx", "sy", "sz"], 1.0, 1.0, 0.01, "A factor on the shape along its own axes.", kc);
        let mut water = o["water"].as_bool().unwrap_or(false);
        if ui.checkbox(&mut water, "Water volume").on_hover_text("The shape is filled with water instead of colliding.").changed() { o["water"] = json!(water); changed = true; }
        let mut spin = num(o, "spin", 0.0);
        ui.horizontal(|ui| { ui.label("Spin"); if ui.add(egui::Slider::new(&mut spin, -6.0..=6.0).step_by(0.1).suffix("/s")).changed() { o["spin"] = json!(spin); changed = true; } });
    } else {
        let mut on = o["on"].as_bool().unwrap_or(true);
        ui.horizontal(|ui| { if ui.checkbox(&mut on, "").changed() { o["on"] = json!(on); changed = true; } klabel(ui, "Emitting", ko, ""); });
        let mut mode = o["mode"].as_str().unwrap_or("smooth").to_owned();
        ui.horizontal(|ui| {
            ui.label("Emission");
            for (m, t) in [("smooth", "Smooth"), ("random", "Random")] { if ui.selectable_value(&mut mode, m.to_owned(), t).changed() { o["mode"] = json!(m); changed = true; } }
        });
        let random = mode == "random";
        egui::Grid::new("emitrows").num_columns(2).spacing([8.0, 3.0]).show(ui, |ui| {
            for (k, name, lo, hi, step, d, suffix) in [("speed", "Speed", 0.0, 10.0, 0.1, 4.0, " m/s"), ("radius", "Radius", 0.03, 0.5, 0.01, 0.15, ""), ("az", "Heading", -180.0, 180.0, 1.0, 0.0, "°"),
                ("el", "Pitch", -90.0, 90.0, 1.0, -30.0, "°"), ("turb", "Turbulence", 0.0, 1.5, 0.05, 0.0, ""), ("spread", "Spread", 0.0, 1.0, 0.02, 0.0, " m/s"), ("density", "Density", 0.2, 1.5, 0.05, 1.0, "")] {
                if k == "density" && !random { continue; }
                let mut v = num(o, k, d);
                klabel(ui, name, match k { "speed" => kv, "radius" => kd, "az" | "el" => ka, _ => (false, false) }, "");
                if ui.add(egui::Slider::new(&mut v, lo..=hi).step_by(step).suffix(suffix)).changed() { o[k] = json!(v); changed = true; }
                ui.end_row();
            }
        });
    }
    changed
}

#[cfg(test)]
mod tests {
    /// settings.json must be what the page's panels make now (node native/tools/export-settings.js writes it).
    #[test]
    fn settings_up_to_date() {
        let script = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tools/export-settings.js");
        let Ok(out) = std::process::Command::new("node").arg(&script).arg("--check").output() else { eprintln!("node not found, skipped"); return; };
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }

    /// Every starting scene from the page opens, and the native solver can bake it.
    #[test]
    fn starting_scenes_open() {
        let all: serde_json::Value = serde_json::from_str(include_str!("scenes.json")).unwrap();
        let names = all["order"].as_array().unwrap();
        assert!(names.len() >= 6);
        for n in names {
            let j = all["scenes"][n.as_str().unwrap()].clone();
            splash_format::Scene::from_json(j.clone()).unwrap_or_else(|e| panic!("{n}: {e}"));
            splash_sim::scene::desc_from_scene(&j, &Default::default()).unwrap_or_else(|e| panic!("{n}: {e}"));
        }
    }

    /// Editing a value writes it where the page reads it, and leaves the rest of the file alone.
    #[test]
    fn set_keeps_the_rest() {
        let mut j = serde_json::json!({ "app": "SplashTank", "solver": { "g": 9.8, "other": [1, 2] }, "objs": [] });
        super::set(&mut j, &["solver", "wind", "speed"], serde_json::json!(3.5));
        super::set(&mut j, &["ocean", "on"], serde_json::json!(true));
        assert_eq!(j["solver"]["wind"]["speed"], 3.5);
        assert_eq!(j["solver"]["other"], serde_json::json!([1, 2]));
        assert_eq!(j["ocean"]["on"], true);
        // every row's place in the file is solver.<key>, solver.wind.<key> or ocean.<key>
        for r in super::spec()["rows"].as_array().unwrap() {
            let p = super::path_of(r);
            assert!(matches!(p.as_slice(), ["solver", _] | ["solver", "wind", _] | ["ocean", _]), "{p:?}");
        }
    }
}
