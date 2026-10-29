//! Collision shapes: signed distance grids of closed meshes. A port of buildSDF, sdfSample, sdfWorld and ptTriDist2 in src/shared.js.

use std::sync::atomic::{AtomicU32, Ordering};

static SDF_ID: AtomicU32 = AtomicU32::new(1);

pub struct Sdf {
    /// changes with every grid built, so the sim knows when to upload the grids again
    pub id: u32,
    pub dims: [usize; 3],
    pub origin: [f32; 3],
    pub cell: f32,
    pub data: Vec<f32>,
}

/// Triangles of a mesh whose faces may have more than three corners (fan triangulation, like meshTris).
pub fn mesh_tris(faces: &[Vec<u32>]) -> Vec<[u32; 3]> {
    let mut t = Vec::new();
    for f in faces { for k in 1..f.len().saturating_sub(1) { t.push([f[0], f[k], f[k + 1]]); } }
    t
}

/// Squared distance from a point to a triangle (Ericson).
fn pt_tri_dist2(p: [f32; 3], a: [f32; 3], b: [f32; 3], c: [f32; 3]) -> f32 {
    let sub = |u: [f32; 3], v: [f32; 3]| [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
    let dot = |u: [f32; 3], v: [f32; 3]| u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    let (ab, ac, ap) = (sub(b, a), sub(c, a), sub(p, a));
    let (d1, d2) = (dot(ab, ap), dot(ac, ap));
    let q: [f32; 3] = 'q: {
        if d1 <= 0.0 && d2 <= 0.0 { break 'q a; }
        let bp = sub(p, b);
        let (d3, d4) = (dot(ab, bp), dot(ac, bp));
        if d3 >= 0.0 && d4 <= d3 { break 'q b; }
        let vc = d1 * d4 - d3 * d2;
        if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 { let v = d1 / (d1 - d3); break 'q [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v]; }
        let cp = sub(p, c);
        let (d5, d6) = (dot(ab, cp), dot(ac, cp));
        if d6 >= 0.0 && d5 <= d6 { break 'q c; }
        let vb = d5 * d2 - d1 * d6;
        if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 { let w = d2 / (d2 - d6); break 'q [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]; }
        let va = d3 * d6 - d5 * d4;
        if va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0 {
            let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
            break 'q [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w];
        }
        let den = 1.0 / (va + vb + vc);
        let (v, w) = (vb * den, vc * den);
        [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]
    };
    let d = sub(p, q);
    dot(d, d)
}

/// Signed distance grid of a closed mesh (negative inside), as buildSDF: exact distances in a band around each triangle, chamfer sweeps
/// for the rest, inside or outside from crossings of lines along x. cell is the voxel size, margin how far outside the mesh it reaches.
pub fn build(v: &[[f32; 3]], faces: &[Vec<u32>], cell: f32, margin: f32) -> Sdf {
    let mut cell = cell;
    let (mut lo, mut hi) = ([1e9f32; 3], [-1e9f32; 3]);
    for p in v { for k in 0..3 { lo[k] = lo[k].min(p[k]); hi[k] = hi[k].max(p[k]); } }
    for k in 0..3 { lo[k] -= margin; hi[k] += margin; }
    let dims_of = |cell: f32| [0, 1, 2].map(|k| ((hi[k] - lo[k]) / cell).ceil() as usize + 1);
    let mut dims = dims_of(cell);
    while dims[0] * dims[1] * dims[2] > 2_600_000 { cell *= 1.25; dims = dims_of(cell); }
    let (nx, ny, nz) = (dims[0], dims[1], dims[2]);
    let (nxy, ic) = (nx * ny, 1.0 / cell);
    let n = nxy * nz;
    let t = mesh_tris(faces);
    let mut data = vec![1e30f32; n];
    let bnd = 2.5 * cell;
    let b2 = bnd * bnd;
    let at = |i: u32| v[i as usize];
    for tri in &t {
        let (a, b, c) = (at(tri[0]), at(tri[1]), at(tri[2]));
        let (u, w) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
        let mut pn = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        let pl = (pn[0] * pn[0] + pn[1] * pn[1] + pn[2] * pn[2]).sqrt();
        if pl > 0.0 { for x in &mut pn { *x /= pl; } }
        let lo_i = |k: usize| ((((a[k].min(b[k]).min(c[k])) - bnd - lo[k]) * ic).floor().max(0.0) as usize).min(dims[k] - 1);
        let hi_i = |k: usize| ((((a[k].max(b[k]).max(c[k])) + bnd - lo[k]) * ic).ceil().max(0.0) as usize).min(dims[k] - 1);
        for k in lo_i(2)..=hi_i(2) {
            let z = lo[2] + k as f32 * cell;
            for j in lo_i(1)..=hi_i(1) {
                let y = lo[1] + j as f32 * cell;
                let base = j * nx + k * nxy;
                for i in lo_i(0)..=hi_i(0) {
                    let x = lo[0] + i as f32 * cell;
                    if pl > 0.0 { let e = (x - a[0]) * pn[0] + (y - a[1]) * pn[1] + (z - a[2]) * pn[2]; if e * e > b2 { continue; } }
                    let d2 = pt_tri_dist2([x, y, z], a, b, c);
                    let idx = base + i;
                    if d2 < data[idx] { data[idx] = d2; }
                }
            }
        }
    }
    for x in &mut data { if *x < 1e29 { *x = x.sqrt(); } }
    // sweeps: forward over the 13 neighbours already passed, then backward over the other 13
    let mut offs = Vec::with_capacity(13);
    for dk in -1i64..=0 { for dj in -1i64..=1 { for di in -1i64..=1 {
        if dk < 0 || dj < 0 || (dj == 0 && di < 0) {
            offs.push((di, dj, dk, di + dj * nx as i64 + dk * nxy as i64, cell * ((di * di + dj * dj + dk * dk) as f32).sqrt()));
        }
    } } }
    for pass in 0..2 {
        let sg: i64 = if pass == 1 { -1 } else { 1 };
        for kk in 0..nz {
            let k = if pass == 1 { nz - 1 - kk } else { kk };
            let k_in = k > 0 && k < nz - 1;
            for jj in 0..ny {
                let j = if pass == 1 { ny - 1 - jj } else { jj };
                let jk_in = k_in && j > 0 && j < ny - 1;
                let row = j * nx + k * nxy;
                for ii in 0..nx {
                    let i = if pass == 1 { nx - 1 - ii } else { ii };
                    let idx = row + i;
                    let mut val = data[idx];
                    if val <= bnd { continue; }
                    if jk_in && i > 0 && i < nx - 1 {
                        for o in &offs { let c2 = data[(idx as i64 + sg * o.3) as usize] + o.4; if c2 < val { val = c2; } }
                    } else {
                        for o in &offs {
                            let (ni, nj, nk) = (i as i64 + sg * o.0, j as i64 + sg * o.1, k as i64 + sg * o.2);
                            if ni < 0 || nj < 0 || nk < 0 || ni >= nx as i64 || nj >= ny as i64 || nk >= nz as i64 { continue; }
                            let c2 = data[(idx as i64 + sg * o.3) as usize] + o.4;
                            if c2 < val { val = c2; }
                        }
                    }
                    data[idx] = val;
                }
            }
        }
    }
    // inside or outside: crossings of each line along x, nudged off the grid
    let (ey, ez) = (0.000137 * cell, 0.000271 * cell);
    let mut rows: Vec<Vec<f32>> = vec![Vec::new(); ny * nz];
    for tri in &t {
        let (a, b, c) = (at(tri[0]), at(tri[1]), at(tri[2]));
        let area = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
        if area.abs() < 1e-14 { continue; }
        let jlo = (((a[1].min(b[1]).min(c[1])) - lo[1] - ey) * ic).ceil().max(0.0) as i64;
        let jhi = ((((a[1].max(b[1]).max(c[1])) - lo[1] - ey) * ic).floor() as i64).min(ny as i64 - 1);
        let klo = (((a[2].min(b[2]).min(c[2])) - lo[2] - ez) * ic).ceil().max(0.0) as i64;
        let khi = ((((a[2].max(b[2]).max(c[2])) - lo[2] - ez) * ic).floor() as i64).min(nz as i64 - 1);
        for k in klo..=khi {
            let z = lo[2] + k as f32 * cell + ez;
            for j in jlo..=jhi {
                let y = lo[1] + j as f32 * cell + ey;
                let w0 = ((c[1] - b[1]) * (z - b[2]) - (c[2] - b[2]) * (y - b[1])) / area;
                let w1 = ((a[1] - c[1]) * (z - c[2]) - (a[2] - c[2]) * (y - c[1])) / area;
                let w2 = 1.0 - w0 - w1;
                if w0 < 0.0 || w1 < 0.0 || w2 < 0.0 { continue; }
                rows[j as usize + ny * k as usize].push(w0 * a[0] + w1 * b[0] + w2 * c[0]);
            }
        }
    }
    for k in 0..nz { for j in 0..ny {
        let xs = &mut rows[j + ny * k];
        if xs.is_empty() { continue; }
        xs.sort_by(|p, q| p.total_cmp(q));
        let mut m = 0;
        let base = j * nx + k * nxy;
        for i in 0..nx {
            let x = lo[0] + i as f32 * cell;
            while m < xs.len() && xs[m] < x { m += 1; }
            if m & 1 == 1 { data[base + i] = -data[base + i]; }
        }
    } }
    Sdf { id: SDF_ID.fetch_add(1, Ordering::Relaxed), dims, origin: lo, cell, data }
}

impl Sdf {
    /// phi and gradient at a local point: [phi, gx, gy, gz]
    pub fn sample(&self, x: f32, y: f32, z: f32) -> [f32; 4] {
        let [nx, ny, nz] = self.dims;
        let inv = 1.0 / self.cell;
        let mut g = [(x - self.origin[0]) * inv, (y - self.origin[1]) * inv, (z - self.origin[2]) * inv];
        let mut o = [0f32; 3];
        let m = [nx as f32 - 1.0001, ny as f32 - 1.0001, nz as f32 - 1.0001];
        for k in 0..3 { if g[k] < 0.0 { o[k] = g[k]; g[k] = 0.0; } else if g[k] > m[k] { o[k] = g[k] - m[k]; g[k] = m[k]; } }
        let (i, j, k) = (g[0] as usize, g[1] as usize, g[2] as usize);
        let (fx, fy, fz) = (g[0] - i as f32, g[1] - j as f32, g[2] - k as f32);
        let d = &self.data;
        let b = i + nx * (j + ny * k);
        let s = nx * ny;
        let (v000, v100, v010, v110) = (d[b], d[b + 1], d[b + nx], d[b + nx + 1]);
        let (v001, v101, v011, v111) = (d[b + s], d[b + s + 1], d[b + s + nx], d[b + s + nx + 1]);
        let c00 = v000 + (v100 - v000) * fx; let c10 = v010 + (v110 - v010) * fx;
        let c01 = v001 + (v101 - v001) * fx; let c11 = v011 + (v111 - v011) * fx;
        let c0 = c00 + (c10 - c00) * fy; let c1 = c01 + (c11 - c01) * fy;
        let phi = c0 + (c1 - c0) * fz;
        let ex = o[0] * o[0] + o[1] * o[1] + o[2] * o[2];
        if ex > 0.0 { let l = ex.sqrt(); return [phi + l * self.cell, o[0] / l, o[1] / l, o[2] / l]; }
        let dx = ((v100 - v000) * (1.0 - fy) + (v110 - v010) * fy) * (1.0 - fz) + ((v101 - v001) * (1.0 - fy) + (v111 - v011) * fy) * fz;
        let dy = (c10 - c00) * (1.0 - fz) + (c11 - c01) * fz;
        let dz = c1 - c0;
        let l = { let l = (dx * dx + dy * dy + dz * dz).sqrt(); if l > 0.0 { l } else { 1.0 } };
        [phi, dx / l, dy / l, dz / l]
    }
}

/// Distance and outward normal in world space of a shape posed at pos with rotation R (row major) and size s (sdfWorld).
pub fn world(sd: &Sdf, pos: [f32; 3], r: &[f32; 9], s: Option<[f32; 3]>, p: [f32; 3]) -> [f32; 4] {
    let d = [p[0] - pos[0], p[1] - pos[1], p[2] - pos[2]];
    let l = [r[0] * d[0] + r[3] * d[1] + r[6] * d[2], r[1] * d[0] + r[4] * d[1] + r[7] * d[2], r[2] * d[0] + r[5] * d[1] + r[8] * d[2]];
    match s {
        None => {
            let o = sd.sample(l[0], l[1], l[2]);
            [o[0], r[0] * o[1] + r[1] * o[2] + r[2] * o[3], r[3] * o[1] + r[4] * o[2] + r[5] * o[3], r[6] * o[1] + r[7] * o[2] + r[8] * o[3]]
        }
        Some(s) => {
            let o = sd.sample(l[0] / s[0], l[1] / s[1], l[2] / s[2]);
            let g = [o[1] / s[0], o[2] / s[1], o[3] / s[2]];
            let w = [r[0] * g[0] + r[1] * g[1] + r[2] * g[2], r[3] * g[0] + r[4] * g[1] + r[5] * g[2], r[6] * g[0] + r[7] * g[1] + r[8] * g[2]];
            let ln = { let l = (w[0] * w[0] + w[1] * w[1] + w[2] * w[2]).sqrt(); if l > 0.0 { l } else { 1.0 } };
            [o[0] * s[0].min(s[1]).min(s[2]), w[0] / ln, w[1] / ln, w[2] / ln]
        }
    }
}

/// R = Rz Ry Rx, row major (eulerMat).
pub fn euler_mat(rx: f32, ry: f32, rz: f32) -> [f32; 9] {
    let (sx, cx) = rx.sin_cos();
    let (sy, cy) = ry.sin_cos();
    let (sz, cz) = rz.sin_cos();
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
     sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
     -sy, cy * sx, cy * cx]
}
