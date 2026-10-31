//! Export for Blender: a bake as one PLY file a frame, in metres. water_0001.ply and whitewater_0001.ply are points (with speed, and white-water
//! level or kind), surface_0001.ply is the water's surface as a closed mesh. import_into_blender.py, written beside them, loads the
//! sequence into Blender. Y is up in these files, as in the scene; the script turns the object for Blender.

use splash_format::cache::{decode_point, Points};
use splash_format::Cache;
use std::io::Write;
use std::path::Path;

fn out(p: &Path) -> Result<std::io::BufWriter<std::fs::File>, String> {
    std::fs::File::create(p).map(|f| std::io::BufWriter::with_capacity(1 << 20, f)).map_err(|e| format!("Could not write {}: {e}", p.display()))
}
fn bad(e: std::io::Error) -> String { format!("Writing the export failed: {e}") }

/// A particle's reach when the surface is built, in particle spacings.
const REACH: f32 = 2.0;
/// The field's value at the surface. Inside water it reads about 5; this low, small groups of drops keep a surface of their own.
const ISO: f32 = 1.2;
const INSIDE: f32 = 5.0;
/// The most grid nodes a frame's surface may use (4 bytes a node, 4 more while meshing).
const MAX_NODES: f64 = 150e6;

/// One frame's water surface by surface nets over a field the particles add to. Water with no particles (deep under a narrow band) is filled in:
/// everything the air cannot reach from the top of the tank is water. Returns vertices (scene units) and quads.
pub fn surface(pts: &[[f32; 3]], tank: &splash_format::Box3, d: f32) -> (Vec<[f32; 3]>, Vec<[u32; 4]>) {
    let e = tank.size();
    let mut h = d;
    let cells = |h: f32| [(e[0] / h).ceil() as usize + 1, (e[1] / h).ceil() as usize + 1, (e[2] / h).ceil() as usize + 1];
    while { let c = cells(h); ((c[0] + 4) * (c[1] + 4) * (c[2] + 4)) as f64 > MAX_NODES } { h *= 1.1; }
    let c = cells(h);
    // two empty layers around the tank close the mesh at its walls
    let n = [c[0] + 4, c[1] + 4, c[2] + 4];
    let at = |i: usize, j: usize, k: usize| i + n[0] * (j + n[1] * k);
    let o = [tank.x0 - 2.0 * h, tank.y0 - 2.0 * h, tank.z0 - 2.0 * h];
    let mut f = vec![0f32; n[0] * n[1] * n[2]];
    let r = REACH * d;
    let (r2, reach) = (r * r, (r / h).ceil() as i64);
    for p in pts {
        let g = [(p[0] - o[0]) / h, (p[1] - o[1]) / h, (p[2] - o[2]) / h];
        let lo = |a: usize| ((g[a].floor() as i64 - reach + 1).max(2)) as usize;
        let hi = |a: usize| ((g[a].floor() as i64 + reach).min(n[a] as i64 - 3).max(0)) as usize;
        for k in lo(2)..=hi(2) { for j in lo(1)..=hi(1) { for i in lo(0)..=hi(0) {
            let q = [o[0] + i as f32 * h - p[0], o[1] + j as f32 * h - p[1], o[2] + k as f32 * h - p[2]];
            let t = 1.0 - (q[0] * q[0] + q[1] * q[1] + q[2] * q[2]) / r2;
            if t > 0.0 { f[at(i, j, k)] += t * t * t; }
        } } }
    }
    // the air: from the top of the tank through empty nodes, inside the walls
    let mut air = vec![false; f.len()];
    let top = n[1] - 3;
    let mut stack: Vec<usize> = Vec::new();
    for k in 2..n[2] - 2 { for i in 2..n[0] - 2 { let a = at(i, top, k); if f[a] < ISO { air[a] = true; stack.push(a); } } }
    while let Some(a) = stack.pop() {
        let (i, j, k) = (a % n[0], (a / n[0]) % n[1], a / (n[0] * n[1]));
        let mut go = |b: usize| if !air[b] && f[b] < ISO { air[b] = true; stack.push(b); };
        if i > 2 { go(a - 1); } if i < n[0] - 3 { go(a + 1); }
        if j > 2 { go(a - n[0]); } if j < n[1] - 3 { go(a + n[0]); }
        if k > 2 { go(a - n[0] * n[1]); } if k < n[2] - 3 { go(a + n[0] * n[1]); }
    }
    for k in 2..n[2] - 2 { for j in 2..n[1] - 2 { for i in 2..n[0] - 2 { let a = at(i, j, k); if !air[a] && f[a] < INSIDE { f[a] = INSIDE; } } } }
    drop(air);
    // a light blur along each axis: the particles lie on a lattice, which otherwise shows on flat water as rows of bumps
    let mut tmp = vec![0f32; f.len()];
    for _ in 0..2 {
        for step in [1, n[0], n[0] * n[1]] {
            tmp.copy_from_slice(&f);
            for k in 2..n[2] - 2 { for j in 2..n[1] - 2 { for i in 2..n[0] - 2 {
                let a = at(i, j, k);
                f[a] = 0.25 * tmp[a - step] + 0.5 * tmp[a] + 0.25 * tmp[a + step];
            } } }
        }
    }
    drop(tmp);
    // surface nets: a vertex in each cell the surface crosses, at the mean of the crossings on its edges; a quad across each crossed edge
    const NONE: u32 = u32::MAX;
    let mut id = vec![NONE; f.len()];
    let mut verts = Vec::new();
    const EDGES: [(usize, usize); 12] = [(0, 1), (2, 3), (4, 5), (6, 7), (0, 2), (1, 3), (4, 6), (5, 7), (0, 4), (1, 5), (2, 6), (3, 7)];
    for k in 0..n[2] - 1 { for j in 0..n[1] - 1 { for i in 0..n[0] - 1 {
        let v: [f32; 8] = std::array::from_fn(|c| f[at(i + (c & 1), j + ((c >> 1) & 1), k + (c >> 2))]);
        let mask = v.iter().enumerate().fold(0u32, |m, (c, x)| m | (((*x >= ISO) as u32) << c));
        if mask == 0 || mask == 255 { continue; }
        let (mut s, mut m) = ([0f32; 3], 0f32);
        for (a, b) in EDGES {
            if (v[a] >= ISO) == (v[b] >= ISO) { continue; }
            let t = (ISO - v[a]) / (v[b] - v[a]);
            for x in 0..3 {
                let (pa, pb) = (((a >> x) & 1) as f32, ((b >> x) & 1) as f32);
                s[x] += pa + (pb - pa) * t;
            }
            m += 1.0;
        }
        id[at(i, j, k)] = verts.len() as u32;
        verts.push([o[0] + (i as f32 + s[0] / m) * h, o[1] + (j as f32 + s[1] / m) * h, o[2] + (k as f32 + s[2] / m) * h]);
    } } }
    let mut quads = Vec::new();
    let mut quad = |a: u32, b: u32, c2: u32, d2: u32, flip: bool| {
        if a == NONE || b == NONE || c2 == NONE || d2 == NONE { return; }
        quads.push(if flip { [a, d2, c2, b] } else { [a, b, c2, d2] });
    };
    for k in 1..n[2] - 1 { for j in 1..n[1] - 1 { for i in 1..n[0] - 1 {
        let inside = f[at(i, j, k)] >= ISO;
        if (f[at(i + 1, j, k)] >= ISO) != inside { quad(id[at(i, j - 1, k - 1)], id[at(i, j, k - 1)], id[at(i, j, k)], id[at(i, j - 1, k)], !inside); }
        if (f[at(i, j + 1, k)] >= ISO) != inside { quad(id[at(i - 1, j, k - 1)], id[at(i - 1, j, k)], id[at(i, j, k)], id[at(i, j, k - 1)], !inside); }
        if (f[at(i, j, k + 1)] >= ISO) != inside { quad(id[at(i - 1, j - 1, k)], id[at(i, j - 1, k)], id[at(i, j, k)], id[at(i - 1, j, k)], !inside); }
    } } }
    (verts, quads)
}

fn ply_head(w: &mut impl Write, n: usize, props: &[&str], faces: usize) -> std::io::Result<()> {
    write!(w, "ply\nformat binary_little_endian 1.0\ncomment SplashTank export, metres\nelement vertex {n}\n")?;
    for p in props { writeln!(w, "property {p}")?; }
    if faces > 0 { write!(w, "element face {faces}\nproperty list uchar int vertex_indices\n")?; }
    writeln!(w, "end_header")
}

/// The Blender script written beside the files: swaps the mesh of an object "SplashTank water" as the frame changes.
const SCRIPT: &str = r#"# Run this in Blender's Scripting tab (Open, then Run Script). It shows the water's surface, one PLY a frame, as the object
# "SplashTank water". Give that object a material as usual: it stays when the frame changes. The files are Y up, so the object is turned.
import bpy, math, os
folder = FOLDER
def load(frame):
    path = os.path.join(folder, "surface_%04d.ply" % frame)
    if not os.path.exists(path): return None
    before = set(bpy.data.objects)
    bpy.ops.wm.ply_import(filepath=path)
    new = list(set(bpy.data.objects) - before)[0]
    mesh = new.data
    bpy.data.objects.remove(new)
    mesh.polygons.foreach_set("use_smooth", [True] * len(mesh.polygons))
    return mesh
ob = bpy.data.objects.get("SplashTank water")
if ob is None:
    ob = bpy.data.objects.new("SplashTank water", load(0))
    bpy.context.scene.collection.objects.link(ob)
    ob.rotation_euler = (math.pi / 2, 0, 0)
def step(scene, depsgraph=None):
    old = ob.data
    m = load(scene.frame_current)
    if m is None: return
    for mat in old.materials: m.materials.append(mat)
    ob.data = m
    if old.users == 0: bpy.data.meshes.remove(old)
for h in list(bpy.app.handlers.frame_change_post):
    if h.__name__ == "step": bpy.app.handlers.frame_change_post.remove(h)
bpy.app.handlers.frame_change_post.append(step)
bpy.context.scene.frame_start = 0
bpy.context.scene.frame_end = LAST
bpy.context.scene.render.fps = FPS
"#;

/// Writes every frame of the bake into dir. mesh: the surface too (the slow part). progress(frame, frames, points): false stops.
pub fn run(c: &Cache, dir: &Path, mesh: bool, mut progress: impl FnMut(usize, usize, u32) -> bool) -> Result<String, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not make {}: {e}", dir.display()))?;
    let (b, sc) = (c.bytes(), c.info.scale);
    let nf = c.frames.len();
    let tank = c.info.b;
    let spd_k = if c.info.spd_ms { 1.0 / 16.0 } else { sc / 16.0 };
    let mut done = 0;
    for (f, fr) in c.frames.iter().enumerate() {
        let bx = c.frame_box(f);
        let mut pts: Vec<[f32; 3]> = Vec::with_capacity(fr.water.n as usize);
        let mut w = out(&dir.join(format!("water_{f:04}.ply")))?;
        let n_live = (0..fr.water.n as usize).filter(|&i| decode_point(b, &fr.water, fr.q, &bx, i).1 != 255).count();
        ply_head(&mut w, n_live, &["float x", "float y", "float z", "float speed", "float foam"], 0).map_err(bad)?;
        for i in 0..fr.water.n as usize {
            let (p, s, l) = decode_point(b, &fr.water, fr.q, &bx, i);
            if s == 255 { continue; }
            pts.push(p);
            for v in [p[0] * sc, p[1] * sc, p[2] * sc, s as f32 * spd_k, l as f32 / 15.0] { w.write_all(&v.to_le_bytes()).map_err(bad)?; }
        }
        w.flush().map_err(bad)?;
        if let Some(ww) = fr.ww.as_ref().filter(|x| x.n > 0) {
            let mut w = out(&dir.join(format!("whitewater_{f:04}.ply")))?;
            ply_head(&mut w, ww.n as usize, &["float x", "float y", "float z", "uchar kind", "float speed"], 0).map_err(bad)?;
            let wb = c.ww_box();
            let p2 = Points { n: ww.n, pos: ww.pos.clone(), spd: ww.pk.clone(), fm: None };
            for i in 0..ww.n as usize {
                let (p, _, _) = decode_point(b, &p2, fr.q, &wb, i);
                let o = ww.pk.start + i * 4;
                let pk = u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
                // kinds as stored: 0 spray, 1 mist, 2 foam, 3 bubbles
                let kind = match (pk >> 29) & 3 { 0 => 0u8, 2 => 1, 1 => 2, _ => 3 };
                for v in [p[0] * sc, p[1] * sc, p[2] * sc] { w.write_all(&v.to_le_bytes()).map_err(bad)?; }
                w.write_all(&[kind]).map_err(bad)?;
                w.write_all(&(((pk >> 21) & 255) as f32 / 4.0).to_le_bytes()).map_err(bad)?;
            }
            w.flush().map_err(bad)?;
        }
        if mesh {
            // deep water is under the band: its points only help the fill
            if let Some(dp) = fr.deep.as_ref() {
                for i in 0..dp.n as usize { let (p, s, _) = decode_point(b, dp, fr.q, &bx, i); if s != 255 { pts.push(p); } }
            }
            let (v, q) = surface(&pts, &tank, c.info.d);
            let mut w = out(&dir.join(format!("surface_{f:04}.ply")))?;
            ply_head(&mut w, v.len(), &["float x", "float y", "float z"], q.len()).map_err(bad)?;
            for p in &v { for x in p { w.write_all(&(x * sc).to_le_bytes()).map_err(bad)?; } }
            for t in &q {
                w.write_all(&[4u8]).map_err(bad)?;
                for x in t { w.write_all(&(*x as i32).to_le_bytes()).map_err(bad)?; }
            }
            w.flush().map_err(bad)?;
        }
        done = f + 1;
        if !progress(f, nf.saturating_sub(1), pts.len() as u32) { break; }
    }
    let script = SCRIPT.replace("FOLDER", &format!("r\"{}\"", dir.display())).replace("LAST", &nf.saturating_sub(1).to_string()).replace("FPS", &(c.info.fps.round() as u32).to_string());
    std::fs::write(dir.join("import_into_blender.py"), script).map_err(|e| format!("Could not write the Blender script: {e}"))?;
    Ok(format!("Exported {done} frames to {}", dir.display()))
}

#[cfg(test)]
mod tests {
    /// A half-filled shell (particles only near the top, as a narrow band leaves them) comes out as one closed solid: a flat top at the right
    /// height and nothing inside. Every edge of a closed mesh belongs to exactly two quads.
    #[test]
    fn surface_is_closed_and_filled() {
        let tank = splash_format::Box3 { x0: 0.0, y0: 0.0, z0: 0.0, x1: 1.0, y1: 1.0, z1: 1.0 };
        let d = 0.04;
        let mut pts = Vec::new();
        // a band 0.16 deep under a surface at 0.5
        let mut x = d / 2.0;
        while x < 1.0 { let mut z = d / 2.0; while z < 1.0 { let mut y = 0.5 - d / 2.0; while y > 0.34 { pts.push([x, y, z]); y -= d; } z += d; } x += d; }
        let (v, q) = super::surface(&pts, &tank, d);
        assert!(!q.is_empty());
        let mut edges = std::collections::HashMap::new();
        for t in &q { for k in 0..4 { let (a, b) = (t[k], t[(k + 1) % 4]); *edges.entry((a.min(b), a.max(b))).or_insert(0) += 1; } }
        assert!(edges.values().all(|&n| n == 2), "the mesh has open edges");
        // the top sits a little above the last particles, and no surface floats inside the water
        let inner = v.iter().filter(|p| p[1] > 0.05 && p[1] < 0.45 && p[0] > 0.1 && p[0] < 0.9 && p[2] > 0.1 && p[2] < 0.9).count();
        assert_eq!(inner, 0, "a surface inside the water");
        let top = v.iter().filter(|p| p[0] > 0.3 && p[0] < 0.7 && p[2] > 0.3 && p[2] < 0.7).map(|p| p[1]).fold(0f32, f32::max);
        assert!(top > 0.5 && top < 0.57, "top at {top}");
    }
}
