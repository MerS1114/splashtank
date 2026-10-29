//! Edit mode (the page's 10-edit.js, as in Blender): Tab on a shape edits its points, edges or faces (1, 2, 3). Click or drag a box to
//! select, A for all; G, R, S move the selection (as tiny objects through tf::Tf, then back into the shape's own coordinates); E extrudes
//! the selected faces and moves them out along their normal; I insets them (an extrude that then shrinks towards their centre). The shape
//! stays closed, so points and faces cannot be deleted. The shape is the scene file's mesh {v, f} in the object's own coordinates.

use crate::tf::{self, View};
use eframe::egui::{self, Color32, Pos2, Stroke};
use glam::Vec3;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Mode { V, E, F }

pub struct Edit { pub obj: usize, pub mode: Mode, pub v: BTreeSet<usize>, pub e: BTreeSet<(usize, usize)>, pub f: BTreeSet<usize> }

pub fn faces(o: &Value) -> Vec<Vec<usize>> {
    o["mesh"]["f"].as_array().map(|f| f.iter().filter_map(|t| t.as_array().map(|t| t.iter().filter_map(|k| k.as_u64().map(|k| k as usize)).collect())).collect()).unwrap_or_default()
}
fn local(o: &Value) -> Vec<[f64; 3]> {
    o["mesh"]["v"].as_array().map(|v| v.iter().map(|q| [0, 1, 2].map(|k| q[k].as_f64().unwrap_or(0.0))).collect()).unwrap_or_default()
}
/// The shape's edges, each once (smaller point first).
pub fn edges(o: &Value) -> Vec<(usize, usize)> {
    let mut s = BTreeSet::new();
    for f in faces(o) { for k in 0..f.len() { let (a, b) = (f[k], f[(k + 1) % f.len()]); s.insert((a.min(b), a.max(b))); } }
    s.into_iter().collect()
}
/// A point in the scene back into the shape's own coordinates (through the object's place, turn and Scale).
pub fn to_local(o: &Value, w: Vec3) -> [f64; 3] {
    let r = crate::render::euler(o["rx"].as_f64().unwrap_or(0.0) as f32, o["yaw"].as_f64().unwrap_or(0.0) as f32, o["rz"].as_f64().unwrap_or(0.0) as f32);
    let s = Vec3::new(o["sx"].as_f64().unwrap_or(1.0) as f32, o["sy"].as_f64().unwrap_or(1.0) as f32, o["sz"].as_f64().unwrap_or(1.0) as f32);
    let l = r.transpose() * (w - tf::pos(o)) / s;
    [l.x as f64, l.y as f64, l.z as f64]
}
fn centre(w: &[Vec3], f: &[usize]) -> Vec3 { f.iter().filter_map(|&i| w.get(i)).copied().sum::<Vec3>() / f.len().max(1) as f32 }

#[derive(Clone, Copy, PartialEq, Debug)]
enum Hit { V(usize), E(usize, usize), F(usize) }

impl Edit {
    pub fn new(obj: usize) -> Edit { Edit { obj, mode: Mode::V, v: BTreeSet::new(), e: BTreeSet::new(), f: BTreeSet::new() } }
    pub fn clear(&mut self) { self.v.clear(); self.e.clear(); self.f.clear(); }

    /// The points the selection moves.
    pub fn verts(&self, o: &Value) -> Vec<usize> {
        let mut s: BTreeSet<usize> = BTreeSet::new();
        match self.mode {
            Mode::V => s.extend(&self.v),
            Mode::E => for &(a, b) in &self.e { s.insert(a); s.insert(b); },
            Mode::F => { let fs = faces(o); for &i in &self.f { if let Some(f) = fs.get(i) { s.extend(f); } } }
        }
        s.into_iter().collect()
    }
    /// The selected faces (in point or edge mode, the faces whose points are all selected).
    pub fn sel_faces(&self, o: &Value) -> BTreeSet<usize> {
        if self.mode == Mode::F { return self.f.clone(); }
        let vs: BTreeSet<usize> = self.verts(o).into_iter().collect();
        faces(o).iter().enumerate().filter(|(_, f)| f.iter().all(|v| vs.contains(v))).map(|(i, _)| i).collect()
    }

    fn pick(&self, o: &Value, v: &View, p: Pos2) -> Option<Hit> {
        let w = tf::world_points(o);
        let sp: Vec<Option<Pos2>> = w.iter().map(|q| v.screen(*q)).collect();
        match self.mode {
            Mode::V => sp.iter().enumerate().filter_map(|(i, s)| Some((s.as_ref()?.distance(p), i))).filter(|(d, _)| *d < 10.0).min_by(|a, b| a.0.total_cmp(&b.0)).map(|(_, i)| Hit::V(i)),
            Mode::E => edges(o).into_iter().filter_map(|(a, b)| {
                let (sa, sb) = ((*sp.get(a)?)?, (*sp.get(b)?)?);
                let ab = sb - sa;
                let t = ((p - sa).dot(ab) / ab.length_sq().max(1e-6)).clamp(0.0, 1.0);
                Some(((sa + ab * t).distance(p), a, b))
            }).filter(|x| x.0 < 7.0).min_by(|a, b| a.0.total_cmp(&b.0)).map(|x| Hit::E(x.1, x.2)),
            Mode::F => faces(o).iter().enumerate().filter_map(|(i, f)| Some((v.screen(centre(&w, f))?.distance(p), i))).filter(|(d, _)| *d < 10.0)
                .min_by(|a, b| a.0.total_cmp(&b.0)).map(|(_, i)| Hit::F(i)),
        }
    }
    /// A click: that part alone (with add, it is added or taken off); nothing hit clears the selection unless add.
    pub fn click(&mut self, o: &Value, v: &View, p: Pos2, add: bool) {
        let h = self.pick(o, v, p);
        if !add { self.clear(); }
        fn flip<T: Ord>(s: &mut BTreeSet<T>, x: T) { if !s.remove(&x) { s.insert(x); } }
        match h { Some(Hit::V(i)) => flip(&mut self.v, i), Some(Hit::E(a, b)) => flip(&mut self.e, (a, b)), Some(Hit::F(i)) => flip(&mut self.f, i), None => {} }
    }
    pub fn boxed(&mut self, o: &Value, v: &View, r: egui::Rect, add: bool) {
        if !add { self.clear(); }
        let w = tf::world_points(o);
        let inside = |q: &Vec3| v.screen(*q).is_some_and(|s| r.contains(s));
        match self.mode {
            Mode::V => for (i, q) in w.iter().enumerate() { if inside(q) { self.v.insert(i); } },
            Mode::E => for (a, b) in edges(o) { if w.get(a).is_some_and(inside) && w.get(b).is_some_and(inside) { self.e.insert((a, b)); } },
            Mode::F => for (i, f) in faces(o).iter().enumerate() { if inside(&centre(&w, f)) { self.f.insert(i); } },
        }
    }
    /// A: everything, or nothing when everything is selected already.
    pub fn all(&mut self, o: &Value) {
        let n = local(o).len();
        let full = match self.mode { Mode::V => self.v.len() == n, Mode::E => self.e.len() == edges(o).len(), Mode::F => self.f.len() == faces(o).len() };
        self.clear();
        if full { return; }
        match self.mode { Mode::V => self.v.extend(0..n), Mode::E => self.e.extend(edges(o)), Mode::F => self.f.extend(0..faces(o).len()) }
    }
    /// 1, 2, 3: points, edges, faces; what was selected carries over (as Blender does: its points).
    pub fn set_mode(&mut self, o: &Value, m: Mode) {
        if m == self.mode { return; }
        let vs: BTreeSet<usize> = self.verts(o).into_iter().collect();
        self.clear();
        self.mode = m;
        match m {
            Mode::V => self.v = vs,
            Mode::E => self.e = edges(o).into_iter().filter(|(a, b)| vs.contains(a) && vs.contains(b)).collect(),
            Mode::F => self.f = faces(o).iter().enumerate().filter(|(_, f)| f.iter().all(|x| vs.contains(x))).map(|(i, _)| i).collect(),
        }
    }

    /// The overlay: every edge dark, the selection orange; dots on points (point mode) or face centres (face mode).
    pub fn draw(&self, painter: &egui::Painter, o: &Value, v: &View) {
        let w = tf::world_points(o);
        let sp: Vec<Option<Pos2>> = w.iter().map(|q| v.screen(*q)).collect();
        let acc = Color32::from_rgb(0xff, 0xa0, 0x28);
        let vs: BTreeSet<usize> = self.verts(o).into_iter().collect();
        for (a, b) in edges(o) {
            let (Some(Some(sa)), Some(Some(sb))) = (sp.get(a), sp.get(b)) else { continue; };
            let on = match self.mode { Mode::E => self.e.contains(&(a, b)), _ => vs.contains(&a) && vs.contains(&b) };
            painter.line_segment([*sa, *sb], if on { Stroke::new(2.5, acc) } else { Stroke::new(1.2, Color32::from_gray(0x11)) });
        }
        match self.mode {
            Mode::V => for (i, s) in sp.iter().enumerate() { if let Some(s) = s { painter.circle(*s, 3.5, if self.v.contains(&i) { acc } else { Color32::from_gray(0x0b) }, Stroke::new(1.0, Color32::from_gray(0xcc))); } },
            Mode::F => for (i, f) in faces(o).iter().enumerate() {
                if let Some(s) = v.screen(centre(&w, f)) { painter.rect_filled(egui::Rect::from_center_size(s, egui::vec2(6.0, 6.0)), 1.0, if self.f.contains(&i) { acc } else { Color32::from_gray(0x11) }); }
            },
            Mode::E => {}
        }
    }
}

/// The selected points as tiny objects in the scene (what tf::Tf moves), and putting them back into the shape.
pub fn as_objects(o: &Value, verts: &[usize]) -> Vec<Value> {
    let w = tf::world_points(o);
    verts.iter().filter_map(|&i| w.get(i)).map(|q| json!({ "shape": "point", "x": q.x, "y": q.y, "z": q.z })).collect()
}
pub fn put_back(o: &mut Value, verts: &[usize], pts: &[Value]) {
    let ls: Vec<[f64; 3]> = pts.iter().map(|p| to_local(o, tf::pos(p))).collect();
    if let Some(v) = o["mesh"]["v"].as_array_mut() { for (k, &i) in verts.iter().enumerate() { if let (Some(q), Some(l)) = (v.get_mut(i), ls.get(k)) { *q = json!(l); } } }
    // the collision shape is made again from the mesh before the water next needs it
    o["sdf"] = Value::Null;
}

/// E: the selected faces get copies of their points; the faces move to the copies and their outline is joined to the old one by new
/// side faces (extrudeFaces). Returns the faces (now on the copies) and their mean normal in the scene, to move them out along it.
pub fn extrude(o: &mut Value, fs: &BTreeSet<usize>) -> Option<Vec3> {
    if fs.is_empty() { return None; }
    let mut f = faces(o);
    let mut v = local(o);
    let mut cnt: BTreeMap<(usize, usize), (usize, (usize, usize))> = BTreeMap::new();
    for &fi in fs { let fc = &f[fi]; for k in 0..fc.len() { let (a, b) = (fc[k], fc[(k + 1) % fc.len()]); let e = cnt.entry((a.min(b), a.max(b))).or_insert((0, (a, b))); e.0 += 1; e.1 = (a, b); } }
    let mut map = BTreeMap::new();
    for &fi in fs { for &vi in &f[fi] { map.entry(vi).or_insert_with(|| { v.push(v[vi]); v.len() - 1 }); } }
    // the faces' normal (Newell's), summed, before they move
    let mut nl = Vec3::ZERO;
    for &fi in fs {
        let fc = &f[fi];
        for k in 0..fc.len() { let (a, b) = (v[fc[k]], v[fc[(k + 1) % fc.len()]]); nl += Vec3::new(((a[1] - b[1]) * (a[2] + b[2])) as f32, ((a[2] - b[2]) * (a[0] + b[0])) as f32, ((a[0] - b[0]) * (a[1] + b[1])) as f32); }
    }
    for &fi in fs { f[fi] = f[fi].iter().map(|vi| map[vi]).collect(); }
    for (c, (a, b)) in cnt.values() { if *c == 1 { f.push(vec![*a, *b, map[b], map[a]]); } }
    // points no face uses any more go, and the rest are numbered again
    let used: BTreeSet<usize> = f.iter().flatten().copied().collect();
    let mut ren = BTreeMap::new();
    let mut nv = Vec::new();
    for (i, q) in v.iter().enumerate() { if used.contains(&i) { ren.insert(i, nv.len()); nv.push(*q); } }
    let nf: Vec<Vec<usize>> = f.iter().map(|fc| fc.iter().map(|x| ren[x]).collect()).collect();
    o["mesh"]["v"] = json!(nv);
    o["mesh"]["f"] = json!(nf);
    o["sdf"] = Value::Null;
    // a normal goes through Scale divided, then the object's turn
    let s = Vec3::new(o["sx"].as_f64().unwrap_or(1.0) as f32, o["sy"].as_f64().unwrap_or(1.0) as f32, o["sz"].as_f64().unwrap_or(1.0) as f32);
    let r = crate::render::euler(o["rx"].as_f64().unwrap_or(0.0) as f32, o["yaw"].as_f64().unwrap_or(0.0) as f32, o["rz"].as_f64().unwrap_or(0.0) as f32);
    Some((r * (nl / s)).normalize_or(Vec3::Y))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Extruding a cube's top face keeps the shape closed (every edge in exactly two faces, once each way) and adds four sides.
    #[test]
    fn extrude_stays_closed() {
        let mut o = tf::new_object(&json!({ "objs": [] }), "cube", false);
        let top = faces(&o).iter().position(|f| f.iter().all(|&i| local(&o)[i][1] > 0.0)).unwrap();
        let n = extrude(&mut o, &BTreeSet::from([top])).unwrap();
        assert!(n.y > 0.99, "{n}");
        let (fs, vs) = (faces(&o), local(&o));
        assert_eq!((fs.len(), vs.len()), (10, 12));
        let mut dir: BTreeMap<(usize, usize), usize> = BTreeMap::new();
        for f in &fs { for k in 0..f.len() { *dir.entry((f[k], f[(k + 1) % f.len()])).or_default() += 1; } }
        for (&(a, b), &c) in &dir { assert_eq!(c, 1, "edge {a}-{b} twice the same way"); assert_eq!(dir.get(&(b, a)), Some(&1), "edge {a}-{b} has no twin"); }
    }

    /// Points moved in the scene come back into the shape's own coordinates through the object's place, turn and Scale.
    #[test]
    fn points_round_trip() {
        let mut o = tf::new_object(&json!({ "objs": [] }), "cube", false);
        o["rx"] = json!(0.4); o["yaw"] = json!(1.1); o["sx"] = json!(2.0);
        let before = local(&o);
        let pts = as_objects(&o, &[0, 3, 5]);
        put_back(&mut o, &[0, 3, 5], &pts);
        for (a, b) in before.iter().zip(local(&o)) { for k in 0..3 { assert!((a[k] - b[k]).abs() < 1e-5); } }
    }
}
