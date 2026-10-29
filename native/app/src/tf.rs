//! Moving objects in the viewport, as the page does (11-transform.js, 12-input.js, the gizmo in 02-viewport.js): rays from the mouse,
//! picking, G/R/S with axis keys, typed values and snapping, the gizmo's handles, and adding objects. Objects are the scene file's JSON
//! objects (x y z, rx yaw rz in radians, sx sy sz, a source's az el in degrees and radius), edited in place.

use crate::render::{euler, Orbit};
use eframe::egui::{self, pos2, Color32, Pos2, Stroke};
use glam::{EulerRot, Mat3, Mat4, Quat, Vec3};
use serde_json::{json, Value};

fn f(o: &Value, k: &str, d: f32) -> f32 { o[k].as_f64().map_or(d, |v| v as f32) }
pub fn is_emitter(o: &Value) -> bool { o["shape"] == "emitter" || o["kind"] == "emitter" }
pub fn pos(o: &Value) -> Vec3 { Vec3::new(f(o, "x", 0.0), f(o, "y", 0.0), f(o, "z", 0.0)) }
fn rot(o: &Value) -> Mat3 { euler(f(o, "rx", 0.0), f(o, "yaw", 0.0), f(o, "rz", 0.0)) }
fn scl(o: &Value) -> Vec3 { Vec3::new(f(o, "sx", 1.0), f(o, "sy", 1.0), f(o, "sz", 1.0)) }
/// where a source points (az around the vertical from +X, el up), as the page's dirOf
fn aim(az: f32, el: f32) -> Vec3 { let (a, e) = (az.to_radians(), el.to_radians()); Vec3::new(e.cos() * a.cos(), e.sin(), e.cos() * a.sin()) }
/// x y z moved by d from where q was (in full precision, so an axis not moved keeps its exact value), and the pose the page draws
/// (px py pz), which a stopped scene keeps equal to it
fn move_from(o: &mut Value, q: &Value, d: Vec3) {
    for (k, pk, dv) in [("x", "px", d.x), ("y", "py", d.y), ("z", "pz", d.z)] {
        let v = q[k].as_f64().unwrap_or(0.0) + dv as f64;
        o[k] = json!(v); o[pk] = json!(v);
    }
}

/// The shape's points in the scene, as drawn.
pub fn world_points(o: &Value) -> Vec<Vec3> {
    let (p, r, s) = (pos(o), rot(o), scl(o));
    o["mesh"]["v"].as_array().map(|v| v.iter().filter_map(|q| {
        let a = q.as_array()?;
        Some(p + r * (Vec3::new(a.first()?.as_f64()? as f32, a.get(1)?.as_f64()? as f32, a.get(2)?.as_f64()? as f32) * s))
    }).collect()).unwrap_or_default()
}
fn faces(o: &Value) -> Vec<Vec<usize>> {
    o["mesh"]["f"].as_array().map(|f| f.iter().filter_map(|t| t.as_array().map(|t| t.iter().filter_map(|k| k.as_u64().map(|k| k as usize)).collect())).collect()).unwrap_or_default()
}

/// The viewport's camera, for turning the mouse into rays and scene points into screen points.
pub struct View { vp: Mat4, inv: Mat4, rect: egui::Rect, pub fwd: Vec3, right: Vec3 }
impl View {
    pub fn new(cam: &Orbit, rect: egui::Rect) -> View {
        let vp = cam.proj(rect.width() / rect.height().max(1.0)) * cam.view();
        let fwd = (cam.target - cam.eye()).normalize_or(Vec3::NEG_Z);
        View { vp, inv: vp.inverse(), rect, fwd, right: fwd.cross(Vec3::Y).normalize_or(Vec3::X) }
    }
    pub fn ray(&self, p: Pos2) -> (Vec3, Vec3) {
        let x = (p.x - self.rect.min.x) / self.rect.width() * 2.0 - 1.0;
        let y = 1.0 - (p.y - self.rect.min.y) / self.rect.height() * 2.0;
        let (a, b) = (self.inv.project_point3(Vec3::new(x, y, 0.0)), self.inv.project_point3(Vec3::new(x, y, 1.0)));
        (a, (b - a).normalize_or(self.fwd))
    }
    pub fn screen(&self, w: Vec3) -> Option<Pos2> {
        let c = self.vp * w.extend(1.0);
        if c.w <= 1e-6 { return None; }
        let n = c.truncate() / c.w;
        Some(pos2(self.rect.min.x + (n.x + 1.0) * 0.5 * self.rect.width(), self.rect.min.y + (1.0 - n.y) * 0.5 * self.rect.height()))
    }
    /// scene units per screen point at w
    fn per_px(&self, w: Vec3) -> f32 {
        match (self.screen(w), self.screen(w + self.right)) { (Some(a), Some(b)) => 1.0 / a.distance(b).max(1e-4), _ => 0.01 }
    }
}

fn ray_tri(o: Vec3, d: Vec3, a: Vec3, b: Vec3, c: Vec3) -> Option<f32> {
    let (e1, e2) = (b - a, c - a);
    let p = d.cross(e2);
    let det = e1.dot(p);
    if det.abs() < 1e-9 { return None; }
    let s = o - a;
    let u = s.dot(p) / det;
    if !(0.0..=1.0).contains(&u) { return None; }
    let q = s.cross(e1);
    let v = d.dot(q) / det;
    if v < 0.0 || u + v > 1.0 { return None; }
    let t = e2.dot(q) / det;
    (t > 0.0).then_some(t)
}

/// The object under the mouse: the nearest shape the ray hits, or a source's handle within 10 points.
pub fn pick(objs: &[Value], v: &View, p: Pos2) -> Option<usize> {
    let (o, d) = v.ray(p);
    let mut best: Option<(f32, usize)> = None;
    for (i, ob) in objs.iter().enumerate() {
        if ob["hidden"] == true { continue; }
        if is_emitter(ob) {
            let c = pos(ob);
            if v.screen(c).is_some_and(|s| s.distance(p) < 10.0) {
                let t = (c - o).dot(d);
                if best.is_none_or(|b| t < b.0) { best = Some((t, i)); }
            }
            continue;
        }
        let w = world_points(ob);
        for fc in faces(ob) {
            for k in 1..fc.len().saturating_sub(1) {
                let (Some(a), Some(b), Some(c)) = (w.get(fc[0]), w.get(fc[k]), w.get(fc[k + 1])) else { continue; };
                if let Some(t) = ray_tri(o, d, *a, *b, *c) { if best.is_none_or(|b| t < b.0) { best = Some((t, i)); } }
            }
        }
    }
    best.map(|b| b.1)
}

/// Objects whose centre is inside the screen rectangle (box select).
pub fn in_box(objs: &[Value], v: &View, r: egui::Rect) -> Vec<usize> {
    objs.iter().enumerate().filter(|(_, o)| o["hidden"] != true && v.screen(pos(o)).is_some_and(|s| r.contains(s))).map(|(i, _)| i).collect()
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind { G, R, S }

/// A move, turn or scale in progress (the page's tf).
pub struct Tf {
    pub kind: Kind,
    pub list: Vec<usize>,
    orig: Vec<Value>,
    pivot: Vec3,
    pub axis: Option<usize>,
    pub plane: bool,
    /// the object's own axes instead of the scene's (an axis key pressed twice)
    pub local: bool,
    /// a typed value
    pub num: String,
    m0: Pos2,
    ang: f32,
    prev_a: Option<f32>,
    /// started by dragging a gizmo handle: letting go finishes it
    pub from_drag: bool,
}

const AXES: [Vec3; 3] = [Vec3::X, Vec3::Y, Vec3::Z];

impl Tf {
    pub fn start(kind: Kind, objs: &[Value], list: Vec<usize>, m0: Pos2, axis: Option<usize>, from_drag: bool) -> Option<Tf> {
        let list: Vec<usize> = list.into_iter().filter(|&i| i < objs.len()).collect();
        if list.is_empty() { return None; }
        let pivot = list.iter().map(|&i| pos(&objs[i])).sum::<Vec3>() / list.len() as f32;
        Some(Tf { kind, orig: list.iter().map(|&i| objs[i].clone()).collect(), list, pivot, axis, plane: false, local: false, num: String::new(), m0, ang: 0.0, prev_a: None, from_drag })
    }
    /// the object whose own axes Local means: one shape on its own
    fn frame(&self) -> Option<&Value> { (self.orig.len() == 1 && !is_emitter(&self.orig[0])).then(|| &self.orig[0]) }
    fn use_local(&self) -> bool { self.local && self.frame().is_some() }
    fn axis_dir(&self, a: usize) -> Vec3 { match (self.use_local(), self.frame()) { (true, Some(o)) => rot(o).col(a), _ => AXES[a] } }

    /// X, Y or Z: along that axis; again: the object's own axis; with Shift: the plane across it.
    pub fn key_axis(&mut self, a: usize, shift: bool) {
        if shift { self.axis = Some(a); self.plane = true; self.local = false; }
        else if self.axis == Some(a) && !self.plane { self.local = !self.local; }
        else { self.axis = Some(a); self.plane = false; self.local = false; }
    }

    /// Puts the objects back where they were.
    pub fn cancel(&self, objs: &mut [Value]) { for (k, &i) in self.list.iter().enumerate() { if let Some(o) = objs.get_mut(i) { *o = self.orig[k].clone(); } } }

    /// Works out the move from the mouse (or the typed value) and applies it; returns the text for the viewport. snap: Ctrl held.
    pub fn apply(&mut self, objs: &mut [Value], v: &View, m: Pos2, snap: bool) -> String {
        let ax = self.axis.map(|a| self.axis_dir(a));
        let typed = (!self.num.is_empty()).then(|| self.num.parse::<f32>().ok()).flatten();
        let multi = self.list.len() > 1;
        let axname = match (self.axis, self.plane) { (Some(a), false) => format!(" along {}{}", ["X", "Y", "Z"][a], if self.use_local() { " (own)" } else { "" }), (Some(a), true) => format!(" across {}", ["X", "Y", "Z"][a]), _ => String::new() };
        let shown = |val: String| if self.num.is_empty() { val } else { format!("{} (typed)", self.num) };
        match self.kind {
            Kind::G => {
                let mut d = Vec3::ZERO;
                if !self.num.is_empty() { if let Some(t) = typed { d = ax.unwrap_or(Vec3::X) * t; } }
                else {
                    let (r0, r1) = (v.ray(self.m0), v.ray(m));
                    match ax {
                        Some(a) if !self.plane => {
                            if let (Some(t0), Some(t1)) = (line_param(self.pivot, a, r0), line_param(self.pivot, a, r1)) { d = a * (t1 - t0); }
                        }
                        _ => {
                            let n = if self.plane { ax.unwrap() } else { -v.fwd };
                            if let (Some(h0), Some(h1)) = (plane_hit(self.pivot, n, r0), plane_hit(self.pivot, n, r1)) { d = h1 - h0; }
                        }
                    }
                    if snap {
                        // increments of 0.1 (Snap to Increment)
                        d = match ax { Some(a) if !self.plane => a * ((d.dot(a) / 0.1).round() * 0.1), _ => (d / 0.1).round() * 0.1 };
                    }
                }
                if d.length() > 60.0 { d = d.normalize() * 60.0; }
                for (k, &i) in self.list.iter().enumerate() { move_from(&mut objs[i], &self.orig[k], d); }
                shown(format!("Move{axname}: {:.3} {:.3} {:.3}", d.x, d.y, d.z))
            }
            Kind::R => {
                let p = v.screen(self.pivot).unwrap_or(self.m0);
                let a1 = (m.y - p.y).atan2(m.x - p.x);
                let a0 = *self.prev_a.get_or_insert((self.m0.y - p.y).atan2(self.m0.x - p.x));
                let mut da = a1 - a0;
                while da > std::f32::consts::PI { da -= std::f32::consts::TAU; }
                while da < -std::f32::consts::PI { da += std::f32::consts::TAU; }
                self.ang -= da;
                self.prev_a = Some(a1);
                let axis = ax.unwrap_or(-v.fwd).normalize();
                let mut ang = self.ang;
                if ax.is_some_and(|a| a.dot(-v.fwd) < 0.0) { ang = -ang; }
                if !self.num.is_empty() { ang = typed.unwrap_or(0.0).to_radians(); } else if snap { ang = (ang.to_degrees() / 5.0).round() * 5.0 * std::f32::consts::PI / 180.0; }
                let rd = Mat3::from_axis_angle(axis, ang);
                for (k, &i) in self.list.iter().enumerate() {
                    let q = &self.orig[k];
                    let o = &mut objs[i];
                    if multi { move_from(o, q, self.pivot + rd * (pos(q) - self.pivot) - pos(q)); }
                    if is_emitter(q) {
                        let dir = (rd * aim(f(q, "az", 0.0), f(q, "el", -30.0))).normalize();
                        o["az"] = json!(dir.z.atan2(dir.x).to_degrees());
                        o["el"] = json!(dir.y.clamp(-1.0, 1.0).asin().to_degrees());
                    } else {
                        let (z, y, x) = Quat::from_mat3(&(rd * rot(q))).to_euler(EulerRot::ZYX);
                        // no -0 in the file
                        let c = |v: f32| if v.abs() < 1e-7 { 0.0 } else { v as f64 };
                        o["rx"] = json!(c(x)); o["yaw"] = json!(c(y)); o["rz"] = json!(c(z));
                    }
                }
                shown(format!("Rotate{axname}: {:.1}°", ang.to_degrees()))
            }
            Kind::S => {
                let p = v.screen(self.pivot).unwrap_or(self.m0);
                let mut k = if !self.num.is_empty() { typed.unwrap_or(1.0) } else {
                    let r = m.distance(p) / self.m0.distance(p).max(24.0);
                    if snap { (r / 0.1).round() * 0.1 } else { r }
                };
                k = k.max(0.02);
                // locked proportions (the lock beside Scale) scale evenly
                let even = self.axis.is_none() || self.orig.iter().all(|o| o["lockScale"] == true || is_emitter(o));
                let mut fk = [1.0f32; 3];
                match self.axis { _ if even => fk = [k; 3], Some(a) if self.plane => { for (i, x) in fk.iter_mut().enumerate() { if i != a { *x = k; } } }, Some(a) => fk[a] = k, None => {} }
                for (j, &i) in self.list.iter().enumerate() {
                    let q = &self.orig[j];
                    let o = &mut objs[i];
                    if multi { let d = pos(q) - self.pivot; move_from(o, q, Vec3::new(d.x * (fk[0] - 1.0), d.y * (fk[1] - 1.0), d.z * (fk[2] - 1.0))); }
                    if is_emitter(q) { o["radius"] = json!((f(q, "radius", 0.15) * k).clamp(0.03, 0.5)); continue; }
                    // a factor along a scene axis goes to the object's own axes by how much each lines up with it (no shear)
                    let lf = if self.use_local() { fk } else {
                        let r = rot(q);
                        [0, 1, 2].map(|c| (0..3).map(|a| r.col(c)[a] * r.col(c)[a] * fk[a]).sum::<f32>())
                    };
                    // in full precision: 0.7 scaled by 2 is 1.4
                    for (k, l) in ["sx", "sy", "sz"].iter().zip(lf) { o[*k] = json!((q[*k].as_f64().unwrap_or(1.0) * l as f64).clamp(0.02, 1000.0)); }
                }
                shown(format!("Scale{axname}: {k:.3}x"))
            }
        }
    }
}

/// Where along the line p + a t the ray comes closest.
fn line_param(p: Vec3, a: Vec3, (ro, rd): (Vec3, Vec3)) -> Option<f32> {
    let w = p - ro;
    let b = a.dot(rd);
    let den = 1.0 - b * b;
    if den < 1e-6 { return None; }
    Some((b * rd.dot(w) - a.dot(w)) / den)
}
fn plane_hit(p: Vec3, n: Vec3, (ro, rd): (Vec3, Vec3)) -> Option<Vec3> {
    let den = n.dot(rd);
    if den.abs() < 1e-6 { return None; }
    let t = n.dot(p - ro) / den;
    (t > 0.0).then(|| ro + rd * t)
}

// ---------- the gizmo: arrows move along an axis, rings turn about it, small cubes scale along it, the centre ball moves freely ----------

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Tool { Select, Move, Rotate, Scale, Transform }
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Part { pub kind: Kind, pub axis: Option<usize> }

pub const AXCOL: [Color32; 3] = [Color32::from_rgb(0xff, 0x33, 0x52), Color32::from_rgb(0x8b, 0xdc, 0x00), Color32::from_rgb(0x28, 0x90, 0xff)];
const HOVER: Color32 = Color32::from_rgb(0xff, 0xd3, 0x4a);

/// The gizmo's place and axes: at the selection's centre, the one shape's own axes when it is alone and local is wanted.
pub struct Giz { pivot: Vec3, ax: [Vec3; 3], len: f32 }
pub fn gizmo(objs: &[Value], sel: &[usize], v: &View) -> Option<Giz> {
    let list: Vec<&Value> = sel.iter().filter_map(|&i| objs.get(i)).collect();
    if list.is_empty() { return None; }
    let pivot = list.iter().map(|o| pos(o)).sum::<Vec3>() / list.len() as f32;
    // a fixed size on screen: the arrows are about 64 points long whatever the zoom
    Some(Giz { pivot, ax: AXES, len: v.per_px(pivot) * 64.0 })
}
fn shows(tool: Tool, p: Part) -> bool {
    match p.kind {
        Kind::G => if p.axis.is_some() { matches!(tool, Tool::Move | Tool::Transform) } else { !matches!(tool, Tool::Rotate | Tool::Scale | Tool::Select) },
        Kind::R => matches!(tool, Tool::Rotate | Tool::Transform),
        Kind::S => matches!(tool, Tool::Scale | Tool::Transform),
    }
}
fn ring(g: &Giz, v: &View, a: usize) -> Vec<Pos2> {
    let (u, w) = (g.ax[(a + 1) % 3], g.ax[(a + 2) % 3]);
    (0..=64).filter_map(|i| { let t = i as f32 / 64.0 * std::f32::consts::TAU; v.screen(g.pivot + (u * t.cos() + w * t.sin()) * g.len * 1.25) }).collect()
}
fn seg_dist(p: Pos2, a: Pos2, b: Pos2) -> f32 {
    let (ab, ap) = (b - a, p - a);
    let t = (ap.dot(ab) / ab.length_sq().max(1e-6)).clamp(0.0, 1.0);
    (a + ab * t).distance(p)
}

/// The handle under the mouse: scale cubes first, then the arrows and ball, then the rings (the page's order).
pub fn pick_gizmo(g: &Giz, v: &View, tool: Tool, p: Pos2) -> Option<Part> {
    let at = |k: f32, a: usize| v.screen(g.pivot + g.ax[a] * g.len * k);
    for a in 0..3 {
        let pt = Part { kind: Kind::S, axis: Some(a) };
        if shows(tool, pt) && at(0.4, a).is_some_and(|s| s.distance(p) < 9.0) { return Some(pt); }
    }
    let c = v.screen(g.pivot)?;
    let ball = Part { kind: Kind::G, axis: None };
    if shows(tool, ball) && c.distance(p) < 10.0 { return Some(ball); }
    for a in 0..3 {
        let pt = Part { kind: Kind::G, axis: Some(a) };
        if let (true, Some(s0), Some(s1)) = (shows(tool, pt), at(0.14, a), at(1.05, a)) { if seg_dist(p, s0, s1) < 7.0 { return Some(pt); } }
    }
    for a in 0..3 {
        let pt = Part { kind: Kind::R, axis: Some(a) };
        if shows(tool, pt) && ring(g, v, a).windows(2).any(|w| seg_dist(p, w[0], w[1]) < 6.0) { return Some(pt); }
    }
    None
}

pub fn draw_gizmo(painter: &egui::Painter, g: &Giz, v: &View, tool: Tool, hover: Option<Part>) {
    let col = |pt: Part, a: usize| if hover == Some(pt) { HOVER } else { AXCOL[a] };
    let Some(c) = v.screen(g.pivot) else { return; };
    for a in 0..3 {
        let pt = Part { kind: Kind::R, axis: Some(a) };
        if shows(tool, pt) { painter.add(egui::Shape::line(ring(g, v, a), Stroke::new(2.0, col(pt, a)))); }
    }
    for a in 0..3 {
        let pt = Part { kind: Kind::G, axis: Some(a) };
        if let (true, Some(s0), Some(s1), Some(tip)) = (shows(tool, pt), v.screen(g.pivot + g.ax[a] * g.len * 0.14), v.screen(g.pivot + g.ax[a] * g.len * 0.9), v.screen(g.pivot + g.ax[a] * g.len * 1.1)) {
            painter.line_segment([s0, s1], Stroke::new(2.5, col(pt, a)));
            let d = (tip - s1).normalized();
            let n = egui::vec2(-d.y, d.x) * 5.0;
            painter.add(egui::Shape::convex_polygon(vec![tip, s1 + n, s1 - n], col(pt, a), Stroke::NONE));
        }
        let ps = Part { kind: Kind::S, axis: Some(a) };
        if let (true, Some(s)) = (shows(tool, ps), v.screen(g.pivot + g.ax[a] * g.len * 0.4)) {
            painter.rect_filled(egui::Rect::from_center_size(s, egui::vec2(8.0, 8.0)), 1.0, col(ps, a));
        }
    }
    let ball = Part { kind: Kind::G, axis: None };
    if shows(tool, ball) { painter.circle_filled(c, 5.0, if hover == Some(ball) { HOVER } else { Color32::from_gray(0xf2) }); }
}

// ---------- adding objects ----------

pub fn mesh_cube(hx: f64, hy: f64, hz: f64) -> Value {
    let mut v = Vec::new();
    for z in [-1.0, 1.0] { for y in [-1.0, 1.0] { for x in [-1.0, 1.0] { v.push(json!([x * hx, y * hy, z * hz])); } } }
    json!({ "v": v, "f": [[0, 4, 6, 2], [1, 3, 7, 5], [0, 1, 5, 4], [2, 6, 7, 3], [0, 2, 3, 1], [4, 5, 7, 6]] })
}
fn mesh_sphere(r: f64, seg: usize, rings: usize) -> Value {
    use std::f64::consts::PI;
    let mut v = vec![json!([0.0, -r, 0.0])];
    for i in 1..rings {
        let a = -PI / 2.0 + i as f64 / rings as f64 * PI;
        let (y, rr) = (a.sin() * r, a.cos() * r);
        for j in 0..seg { let b = j as f64 / seg as f64 * PI * 2.0; v.push(json!([b.cos() * rr, y, b.sin() * rr])); }
    }
    v.push(json!([0.0, r, 0.0]));
    let top = v.len() - 1;
    let ring = |i: usize, j: usize| 1 + (i - 1) * seg + (j + seg) % seg;
    let mut f = Vec::new();
    for j in 0..seg { f.push(json!([0, ring(1, j + 1), ring(1, j)])); }
    for i in 1..rings - 1 { for j in 0..seg { f.push(json!([ring(i, j), ring(i, j + 1), ring(i + 1, j + 1), ring(i + 1, j)])); } }
    for j in 0..seg { f.push(json!([top, ring(rings - 1, j), ring(rings - 1, j + 1)])); }
    json!({ "v": v, "f": f })
}
fn mesh_cylinder(r: f64, hh: f64, seg: usize) -> Value {
    use std::f64::consts::PI;
    let mut v = Vec::new();
    for y in [-hh, hh] { for j in 0..seg { let a = j as f64 / seg as f64 * PI * 2.0; v.push(json!([a.cos() * r, y, a.sin() * r])); } }
    let mut f: Vec<Value> = (0..seg).map(|j| { let k = (j + 1) % seg; json!([j, k, seg + k, seg + j]) }).collect();
    f.push(json!((0..seg).map(|j| seg - 1 - j).collect::<Vec<_>>()));
    f.push(json!((0..seg).map(|j| seg + j).collect::<Vec<_>>()));
    json!({ "v": v, "f": f })
}

/// A new object like the page's addAt: shape cube, sphere, cylinder or emitter, as water or not, near the middle of the tank.
pub fn new_object(j: &Value, shape: &str, water: bool) -> Value {
    let objs = j["objs"].as_array().cloned().unwrap_or_default();
    let id = objs.iter().filter_map(|o| o["id"].as_u64()).max().unwrap_or(0) + 1;
    let n = |p: &[&str], d: f64| p.iter().try_fold(j, |v, k| v.get(*k)).and_then(Value::as_f64).unwrap_or(d);
    let (w, h, d) = (n(&["box", "size", "w"], 3.0), n(&["box", "size", "h"], 2.6), n(&["box", "size", "d"], 3.0));
    let (cx, y0, cz) = (n(&["box", "min", "x"], -w / 2.0) + w / 2.0, n(&["box", "min", "y"], 0.0), n(&["box", "min", "z"], -d / 2.0) + d / 2.0);
    // a little apart from the last one added, as the page's jitter
    let jit = ((id as f64 * 2.399).sin() * 0.3, (id as f64 * 1.731).cos() * 0.3);
    let base = |prefix: &str| {
        let k = objs.iter().filter(|o| o["name"].as_str().is_some_and(|s| s.starts_with(prefix))).count() + 1;
        format!("{prefix}{k}")
    };
    let (x, z) = (cx + jit.0, cz + jit.1);
    if shape == "emitter" {
        return json!({ "id": id, "kind": "emitter", "shape": "emitter", "name": base("source"), "x": x, "y": y0 + (h - 0.4).min(2.0), "z": z, "px": x, "py": y0 + (h - 0.4).min(2.0), "pz": z,
            "rx": 0, "yaw": 0, "rz": 0, "sx": 1, "sy": 1, "sz": 1, "spin": 0, "rec": null, "keys": [],
            "az": 0, "el": -90, "speed": 3, "radius": 0.15, "on": true, "mode": "smooth", "spread": 0, "density": 1, "turb": 0, "mesh": null, "sdf": null });
    }
    let (mesh, extra) = match (shape, water) {
        ("cube", true) => (mesh_cube(0.6, 0.45, 0.6), json!({ "hx": 0.6, "hy": 0.45, "hz": 0.6 })),
        ("cube", false) => (mesh_cube(0.3, 0.3, 0.3), json!({})),
        ("sphere", true) => (mesh_sphere(0.5, 14, 9), json!({ "r": 0.5 })),
        ("sphere", false) => (mesh_sphere(0.35, 14, 9), json!({})),
        _ => (mesh_cylinder(0.25, 0.3, 16), json!({})),
    };
    let name = if water { base("Water") } else { base(shape) };
    let y = if water { y0 + 1.2f64.min(h * 0.5) } else { y0 + 0.9 };
    let mut o = json!({ "id": id, "kind": "mesh", "shape": shape, "name": name, "x": x, "y": y, "z": z, "px": x, "py": y, "pz": z, "rx": 0, "yaw": 0, "rz": 0, "sx": 1, "sy": 1, "sz": 1,
        "lockScale": false, "spin": 0, "water": water, "mesh": mesh, "sdf": null, "keys": [], "rec": null });
    if let (Some(o), Some(e)) = (o.as_object_mut(), extra.as_object()) { for (k, v) in e { o.insert(k.clone(), v.clone()); } }
    o
}

/// Copies for Shift+D (the page's dupSelected): new ids, names with .001, keys kept.
pub fn duplicate(j: &Value, sel: &[usize]) -> Vec<Value> {
    let objs = j["objs"].as_array().cloned().unwrap_or_default();
    let mut id = objs.iter().filter_map(|o| o["id"].as_u64()).max().unwrap_or(0);
    sel.iter().filter_map(|&i| objs.get(i)).map(|o| {
        id += 1;
        let mut n = o.clone();
        n["id"] = json!(id);
        let name = o["name"].as_str().unwrap_or("");
        let stem = name.rsplit_once('.').filter(|(_, d)| !d.is_empty() && d.chars().all(|c| c.is_ascii_digit())).map_or(name, |(s, _)| s);
        n["name"] = json!(format!("{stem}.001"));
        n
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Rotations go back into rx, yaw, rz the way the page's Euler 'ZYX' reads them.
    #[test]
    fn euler_round_trip() {
        let (rx, ry, rz) = (0.3f32, -1.1f32, 0.7f32);
        let m = euler(rx, ry, rz);
        let (z, y, x) = Quat::from_mat3(&m).to_euler(EulerRot::ZYX);
        assert!((x - rx).abs() < 1e-4 && (y - ry).abs() < 1e-4 && (z - rz).abs() < 1e-4, "{x} {y} {z}");
    }

    /// A ray from the camera through an object's centre on screen picks it; a move along X typed as 0.5 moves it by 0.5.
    #[test]
    fn pick_and_move() {
        let mut j = json!({ "app": "SplashTank", "box": { "min": { "x": -1.5, "y": 0, "z": -1.5 }, "size": { "w": 3, "h": 2.6, "d": 3 } }, "objs": [] });
        let o = new_object(&j, "cube", false);
        j["objs"] = json!([o]);
        let cam = Orbit { target: Vec3::new(0.0, 0.7, 0.0), theta: 0.8, phi: 1.0, r: 6.2, ortho: false };
        let v = View::new(&cam, egui::Rect::from_min_size(pos2(0.0, 0.0), egui::vec2(1200.0, 800.0)));
        let objs = j["objs"].as_array_mut().unwrap();
        let c = v.screen(pos(&objs[0])).unwrap();
        assert_eq!(pick(objs, &v, c), Some(0));
        assert_eq!(pick(objs, &v, pos2(5.0, 5.0)), None);
        let p0 = pos(&objs[0]);
        let mut t = Tf::start(Kind::G, objs, vec![0], c, None, false).unwrap();
        t.key_axis(0, false);
        t.num = "0.5".into();
        t.apply(objs, &v, c, false);
        assert!((pos(&objs[0]) - (p0 + Vec3::X * 0.5)).length() < 1e-5);
        t.cancel(objs);
        assert!((pos(&objs[0]) - p0).length() < 1e-6);
        // the mouse moved along the X arrow on screen moves the object along X only
        let s1 = v.screen(p0 + Vec3::X).unwrap();
        let mut t = Tf::start(Kind::G, objs, vec![0], c, Some(0), true).unwrap();
        t.apply(objs, &v, s1, false);
        let d = pos(&objs[0]) - p0;
        assert!((d.x - 1.0).abs() < 1e-3 && d.y.abs() < 1e-5 && d.z.abs() < 1e-5, "{d}");
    }
}

// ---------- keys (KEY_GROUPS, keyPose, addKey, clearKeyAt in src/shared.js and 07-timeline.js) ----------

/// The channel groups an object can key, as Blender's Location, Rotation and Scale; a source has Aim, Radius, Speed and Emitting.
pub const GROUPS: [(&str, &[&str]); 7] = [("loc", &["x", "y", "z"]), ("rot", &["rx", "yaw", "rz"]), ("scale", &["sx", "sy", "sz"]), ("aim", &["az", "el"]),
    ("radius", &["radius"]), ("speed", &["speed"]), ("on", &["on"])];
pub const FPS_TL: f64 = 24.0;
pub fn obj_groups(o: &Value) -> &'static [&'static str] { if is_emitter(o) { &["loc", "aim", "radius", "speed", "on"] } else { &["loc", "rot", "scale"] } }
/// The groups a move keys with auto keying on: Move keys Location, Rotate keys Rotation (a source's Aim), Scale keys Scale (a source's Radius).
pub fn tf_groups(o: &Value, k: Kind) -> &'static [&'static str] {
    match (k, is_emitter(o)) { (Kind::G, _) => &["loc"], (Kind::R, true) => &["aim"], (Kind::R, false) => &["rot"], (Kind::S, true) => &["radius"], (Kind::S, false) => &["scale"] }
}
fn chans(g: &str) -> &'static [&'static str] { GROUPS.iter().find(|x| x.0 == g).map(|x| x.1).unwrap_or(&[]) }
fn key_has(k: &Value, g: &str) -> bool { chans(g).first().is_some_and(|c| !k[*c].is_null()) }
pub fn keys(o: &Value) -> &[Value] { o["keys"].as_array().map(|v| v.as_slice()).unwrap_or(&[]) }

/// The pose at time t from the keys (sorted by t): the channels of every group some key holds. smooth: Catmull-Rom between keys, else
/// straight lines (Speed is always straight; Emitting switches at the key).
pub fn key_pose(ks: &[Value], t: f64, smooth: bool) -> serde_json::Map<String, Value> {
    let mut out = serde_json::Map::new();
    let num = |k: &Value, c: &str| k[c].as_f64().unwrap_or(0.0);
    for (g, ch) in GROUPS {
        let ks: Vec<&Value> = ks.iter().filter(|k| key_has(k, g)).collect();
        let n = ks.len();
        if n == 0 { continue; }
        if g == "on" { let mut v = ks[0]["on"].clone(); for k in &ks { if num(k, "t") <= t { v = k["on"].clone(); } } out.insert("on".into(), v); continue; }
        let put = |out: &mut serde_json::Map<String, Value>, k: &Value| for c in ch { out.insert((*c).into(), k[*c].clone()); };
        if t <= num(ks[0], "t") || n == 1 { put(&mut out, ks[0]); continue; }
        if t >= num(ks[n - 1], "t") { put(&mut out, ks[n - 1]); continue; }
        let mut i = 0;
        while i < n - 2 && t >= num(ks[i + 1], "t") { i += 1; }
        let (a, b) = (ks[i], ks[i + 1]);
        let u = (t - num(a, "t")) / (num(b, "t") - num(a, "t")).max(1e-6);
        let (p0, p3) = (if i > 0 { ks[i - 1] } else { a }, ks.get(i + 2).copied().unwrap_or(b));
        let (u2, u3) = (u * u, u * u * u);
        for c in ch {
            let (aa, bb, pp0, pp3) = (num(a, c), num(b, c), num(p0, c), num(p3, c));
            let mut v = if !smooth || g == "speed" { aa + (bb - aa) * u } else {
                0.5 * ((2.0 * aa) + (-pp0 + bb) * u + (2.0 * pp0 - 5.0 * aa + 4.0 * bb - pp3) * u2 + (-pp0 + 3.0 * aa - 3.0 * bb + pp3) * u3)
            };
            if g == "scale" { v = v.max(0.02); }
            out.insert((*c).into(), json!(v));
        }
    }
    out
}

/// Puts a keyed object where its keys say it is at time t (the page's applyKeysAt); false when it has no keys.
pub fn apply_keys(o: &mut Value, t: f64, smooth: bool) -> bool {
    if keys(o).is_empty() { return false; }
    let mut p = key_pose(keys(o), t, smooth);
    let own = obj_groups(o);
    p.retain(|c, _| GROUPS.iter().any(|(g, ch)| own.contains(g) && ch.contains(&c.as_str())));
    if let Some(r) = p.get_mut("radius") { *r = json!(r.as_f64().unwrap_or(0.15).clamp(0.03, 0.5)); }
    for (c, v) in p {
        if let Some(pk) = match c.as_str() { "x" => Some("px"), "y" => Some("py"), "z" => Some("pz"), _ => None } { o[pk] = v.clone(); }
        o[c.as_str()] = v;
    }
    true
}

/// Keys the groups (all the object's when None) at time t, on the frame grid; a key already on that frame gets them added or updated.
pub fn add_key(o: &mut Value, t: f64, groups: Option<&[&str]>, dur: f64) {
    let own = obj_groups(o);
    let gs: Vec<&str> = groups.unwrap_or(own).iter().copied().filter(|g| own.contains(g)).collect();
    if gs.is_empty() { return; }
    let t = ((t * FPS_TL).round() / FPS_TL).clamp(0.0, dur);
    let defaults = |c: &str| match c { "sx" | "sy" | "sz" => json!(1.0), "az" => json!(0.0), "el" => json!(-30.0), "radius" => json!(0.15), "speed" => json!(4.0), "on" => json!(true), _ => json!(0.0) };
    let mut k = serde_json::Map::new();
    for g in &gs { for c in chans(g) { k.insert((*c).into(), if o[*c].is_null() { defaults(c) } else { o[*c].clone() }); } }
    if !o["keys"].is_array() { o["keys"] = json!([]); }
    let ks = o["keys"].as_array_mut().unwrap();
    match ks.iter_mut().find(|q| (q["t"].as_f64().unwrap_or(-1.0) - t).abs() < 0.5 / FPS_TL) {
        Some(ex) => for (c, v) in k { ex[c.as_str()] = v; },
        None => { k.insert("t".into(), json!(t)); ks.push(Value::Object(k)); }
    }
    ks.sort_by(|a, b| a["t"].as_f64().unwrap_or(0.0).total_cmp(&b["t"].as_f64().unwrap_or(0.0)));
}

/// Alt+I: takes the groups (all when None) off the key on the frame at t; a key left with nothing is removed. False when no key there.
pub fn clear_key(o: &mut Value, t: f64, groups: Option<&[&str]>) -> bool {
    let Some(ks) = o["keys"].as_array_mut() else { return false; };
    let Some(i) = ks.iter().position(|q| (q["t"].as_f64().unwrap_or(-1.0) - t).abs() < 0.5 / FPS_TL) else { return false; };
    for (g, ch) in GROUPS { if groups.is_none_or(|gs| gs.contains(&g)) { for c in ch { if let Some(m) = ks[i].as_object_mut() { m.remove(*c); } } } }
    if !GROUPS.iter().any(|(g, _)| key_has(&ks[i], g)) { ks.remove(i); }
    true
}

/// Whether a group is keyed on the frame at t ("now", yellow in Blender) or animated at all (green).
pub fn key_state(o: &Value, g: &str, t: f64) -> (bool, bool) {
    let ks = keys(o);
    (ks.iter().any(|k| key_has(k, g) && (k["t"].as_f64().unwrap_or(-1.0) - t).abs() < 0.5 / FPS_TL), ks.iter().any(|k| key_has(k, g)))
}

#[cfg(test)]
mod key_tests {
    use super::*;

    /// Keys made, read back between them (straight and smooth), changed and taken off as the page does.
    #[test]
    fn keys_round_trip() {
        let mut o = json!({ "shape": "cube", "x": 0.0, "y": 1.0, "z": 0.0, "rx": 0, "yaw": 0, "rz": 0, "sx": 1, "sy": 1, "sz": 1, "keys": [] });
        add_key(&mut o, 0.0, None, 5.0);
        o["y"] = json!(3.0);
        add_key(&mut o, 2.0, Some(&["loc"]), 5.0);
        assert_eq!(keys(&o).len(), 2);
        let p = key_pose(keys(&o), 1.0, false);
        assert!((p["y"].as_f64().unwrap() - 2.0).abs() < 1e-9);
        assert!(p.contains_key("sx") && p.contains_key("rx"));
        // smooth with two keys: Catmull-Rom with the ends repeated, the middle still halfway
        assert!((key_pose(keys(&o), 1.0, true)["y"].as_f64().unwrap() - 2.0).abs() < 1e-9);
        o["y"] = json!(9.0);
        assert!(apply_keys(&mut o, 2.0, true));
        assert_eq!(o["y"], json!(3.0));
        assert_eq!(o["py"], json!(3.0));
        assert_eq!(key_state(&o, "loc", 2.0), (true, true));
        assert_eq!(key_state(&o, "rot", 2.0), (false, true));
        // a time between frames lands on the frame grid
        add_key(&mut o, 2.01, Some(&["scale"]), 5.0);
        assert_eq!(keys(&o).len(), 2);
        assert!(clear_key(&mut o, 2.0, Some(&["loc"])));
        assert_eq!(keys(&o).len(), 2, "the key at 2 s still holds Scale");
        assert!(clear_key(&mut o, 2.0, None));
        assert_eq!(keys(&o).len(), 1);
        assert!(!clear_key(&mut o, 3.0, None));
    }
}
