//! Accuracy against known answers, ported from the page's tests/accuracy.js (with the default solver: APIC, separation, multigrid).
//! Each case prints one line to compare runs and fails when the result gets clearly worse than it was when the desktop program took
//! over the solver (the limits sit a little outside those numbers; the plan's phase 2 targets are tighter).
//!   cargo test --release --test accuracy -- --nocapture --test-threads 1
//! (ACC_XFER=flip runs the cases with known answers with the FLIP transfer instead of APIC.)
//!
//!   still   water at rest stays at rest: speeds after 3 s (spurious currents), the mean height (compression)
//!   dam     a column a wide and 2a high let go at a wall: the front against Martin and Moyce 1952
//!   volume  the dam break sloshing for 10 s: the settled depth against the starting volume
//!   slosh   a standing wave A cos(pi x / L): period against w^2 = g k tanh(k h), height lost per period
//!   swirl   a Taylor-Green vortex filling a closed tank (no gravity): energy and vortex kept after 1, 2, 3 s
//!   crown   Meteor lake: water thrown up in a ring around the impact (a crown), not a dome in the middle
//!   blast   Underwater blast: the water pushed out by the growing sphere

use serde_json::{json, Value};
use splash_sim::gpu::Gpu;
use splash_sim::scene::{desc_from_scene, BakeOpts, Desc};
use splash_sim::session::Session;

/// live spacing of the cases with known answers (cell 0.025 m)
const SP: f32 = 0.0125;

fn scene(w: f64, h: f64, d: f64, fills: Value, g: f64) -> Value {
    // ACC_XFER=flip compares the FLIP transfer
    let xfer = std::env::var("ACC_XFER").unwrap_or_else(|_| "apic".into());
    json!({ "app": "SplashTank", "version": 2, "box": { "min": { "x": -w / 2.0, "y": 0, "z": -d / 2.0 }, "size": { "w": w, "h": h, "d": d }, "open": {} },
        "solver": { "engine": "flip", "nbOn": false, "sprOn": false, "airOn": false, "dripOn": false, "scale": 1, "subMax": 16, "vmaxW": 50, "colMax": 100, "g": g, "cap": 4000000, "xfer": xfer },
        "bake": { "dur": 30, "fps": 60 }, "fills": fills, "events": [], "objs": [] })
}

fn desc(sc: &Value, spacing: f32) -> Desc {
    desc_from_scene(sc, &BakeOpts { spacing, seconds: Some(30.0), detail: Some(1.0), ..Default::default() }).unwrap()
}

/// Steps k frames; returns the most substeps a frame took.
fn frames(gpu: &Gpu, s: &mut Session, k: u32) -> u32 {
    let mut buf = Vec::new();
    let mut most = 0;
    for _ in 0..k {
        let (sub, ov) = s.step_frame(gpu, |_, _, _| Ok(false)).unwrap().unwrap();
        let n = s.sim.readback(gpu, &mut buf);
        s.finish_frame(gpu, &buf, n, sub, ov, 0);
        most = most.max(sub);
    }
    most
}

/// Positions and velocities of the living particles (x y z per particle in each).
fn read(gpu: &Gpu, s: &mut Session) -> (Vec<[f32; 3]>, Vec<[f32; 3]>) {
    let (mut p, mut v) = (Vec::new(), Vec::new());
    s.sim.read_particles(gpu, &mut p, &mut v);
    let mut out = (Vec::new(), Vec::new());
    for i in 0..p.len() / 4 {
        if p[i * 4 + 1] < -1e5 || !p[i * 4 + 1].is_finite() { continue; }
        out.0.push([p[i * 4], p[i * 4 + 1], p[i * 4 + 2]]);
        out.1.push([v[i * 4], v[i * 4 + 1], v[i * 4 + 2]]);
    }
    out
}

fn len(v: [f32; 3]) -> f32 { (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt() }

#[test]
fn still() {
    let gpu = Gpu::new().unwrap();
    let sc = scene(1.0, 1.0, 1.0, json!([{ "t": "box", "fx0": 0, "fx1": 1, "y0": 0, "y1": 0.5, "fz0": 0, "fz1": 1 }]), 9.8);
    let d = desc(&sc, SP);
    let mut s = Session::new(&gpu, &d, &|_| {}, None).unwrap();
    s.seed(&gpu);
    let mean_y = |p: &[[f32; 3]]| p.iter().map(|q| q[1] as f64).sum::<f64>() / p.len() as f64;
    let (p0, _) = read(&gpu, &mut s);
    frames(&gpu, &mut s, 180);
    let (p, v) = read(&gpu, &mut s);
    let mut sp: Vec<f32> = v.iter().map(|&q| len(q)).collect();
    sp.sort_by(|a, b| a.total_cmp(b));
    let mean = sp.iter().map(|&x| x as f64).sum::<f64>() / sp.len() as f64;
    let dy = (mean_y(&p) - mean_y(&p0)) / s.lay.h as f64;
    eprintln!("still: after 3 s, speed mean {:.4} m/s, 99% under {:.4}, max {:.3}; mean height moved {dy:.3} cells; particles {} -> {}",
        mean, sp[sp.len() * 99 / 100], sp[sp.len() - 1], p0.len(), p.len());
    assert_eq!(p.len(), p0.len(), "water lost");
    assert!(mean < 0.015, "still water moves at {mean:.4} m/s on average");
    assert!(dy.abs() < 0.5, "still water's mean height moved {dy:.2} cells");
}

/// Martin and Moyce (1952), n^2 = 2, as reprinted in the SPH and MPS literature: (T, Z)
const MM: [(f64, f64); 15] = [(0.41, 1.11), (0.84, 1.22), (1.19, 1.44), (1.43, 1.67), (1.63, 1.89), (1.83, 2.11), (1.98, 2.33), (2.20, 2.56), (2.32, 2.78), (2.51, 3.00), (2.65, 3.22), (2.83, 3.44), (2.98, 3.67), (3.11, 3.89), (3.33, 4.11)];

fn dam_scene() -> (Value, f64, f64) {
    let (a, w, h, d) = (0.4, 2.4, 1.2, 0.24);
    (scene(w, h, d, json!([{ "t": "box", "fx0": 0, "fx1": a / w, "y0": 0, "y1": 2.0 * a, "fz0": 0, "fz1": 1 }]), 9.8), a, w)
}

#[test]
fn dam() {
    let gpu = Gpu::new().unwrap();
    let (sc, a, _) = dam_scene();
    let d = desc(&sc, SP);
    let mut s = Session::new(&gpu, &d, &|_| {}, None).unwrap();
    s.seed(&gpu);
    let (x0, y0) = (s.lay.b.x0, s.lay.b.y0);
    let at = |t: f64| -> Option<f64> { MM.windows(2).find(|w| t <= w[1].0 && t >= w[0].0).map(|w| w[0].1 + (w[1].1 - w[0].1) * (t - w[0].0) / (w[1].0 - w[0].0)) };
    let (mut err, mut ne, mut most) = (0.0, 0, 0);
    let mut pts = Vec::new();
    for f in 1..=40 {
        most = most.max(frames(&gpu, &mut s, 1));
        if f % 2 == 1 { continue; }
        let (p, _) = read(&gpu, &mut s);
        // the front: all but the furthest 0.2% of the water near the floor
        let mut xs: Vec<f64> = p.iter().filter(|q| ((q[1] - y0) as f64) < 0.25 * a).map(|q| (q[0] - x0) as f64).collect();
        xs.sort_by(|p, q| p.total_cmp(q));
        let z = xs[xs.len().saturating_sub(1 + xs.len() / 500)] / a;
        let t = f as f64 / 60.0 * (2.0 * 9.8 / a).sqrt();
        if let Some(m) = at(t) { if t >= 0.8 { err += (z - m) / m; ne += 1; } pts.push(format!("T{t:.2} {z:.2}/{m:.2}")); }
    }
    let ahead = 100.0 * err / ne as f64;
    eprintln!("dam: front ahead of Martin and Moyce by {ahead:.1}% on average (T 0.8-3.3), most substeps {most}\n  Z sim/measured: {}", pts.join(", "));
    assert!(ahead.abs() < 20.0, "the dam break front is {ahead:.1}% off the measurements");
}

#[test]
fn volume() {
    let gpu = Gpu::new().unwrap();
    let (sc, a, w) = dam_scene();
    let want = a * 2.0 * a / w;
    let d = desc(&sc, SP);
    let mut s = Session::new(&gpu, &d, &|_| {}, None).unwrap();
    s.seed(&gpu);
    let (b, h, sp) = (s.lay.b, s.lay.h, s.lay.d);
    // the settled depth: the mean over columns of the highest particle (plus half a spacing)
    let depth = |p: &[[f32; 3]]| {
        let (nx, nz) = (((b.x1 - b.x0) / h).ceil() as usize, ((b.z1 - b.z0) / h).ceil() as usize);
        let mut top = vec![0f64; nx * nz];
        for q in p {
            let (ix, iz) = (((q[0] - b.x0) / h).floor() as isize, ((q[2] - b.z0) / h).floor() as isize);
            if ix >= 0 && (ix as usize) < nx && iz >= 0 && (iz as usize) < nz { let c = &mut top[ix as usize * nz + iz as usize]; *c = c.max((q[1] - b.y0 + sp / 2.0) as f64); }
        }
        top.iter().sum::<f64>() / top.len() as f64
    };
    let mut out = Vec::new();
    let mut most = 0;
    for _ in 0..5 { most = most.max(frames(&gpu, &mut s, 120)); out.push(100.0 * (depth(&read(&gpu, &mut s).0) / want - 1.0)); }
    eprintln!("volume: settled depth {} off the starting volume every 2 s (wants {want:.3} m), most substeps {most}",
        out.iter().map(|v| format!("{v:.1}%")).collect::<Vec<_>>().join(", "));
    let last = out[out.len() - 1];
    assert!(last.abs() < 3.0, "after 10 s of sloshing the water is {last:.1}% off its starting volume");
}

#[test]
fn slosh() {
    let gpu = Gpu::new().unwrap();
    let (l, dd, hd, am) = (1.0f64, 0.2f64, 0.5f64, 0.08f64);
    let sc = scene(l, 1.0, dd, json!([]), 9.8);
    let d = desc(&sc, SP);
    let mut s = Session::new(&gpu, &d, &|_| {}, None).unwrap();
    let (b, sp) = (s.lay.b, s.lay.d as f64);
    let mut rng = splash_sim::flip::Rng::new(7);
    let mut x = b.x0 as f64 + sp / 2.0;
    while x < b.x1 as f64 {
        let top = hd + am * (std::f64::consts::PI * (x - b.x0 as f64) / l).cos();
        let mut y = b.y0 as f64 + sp / 2.0;
        while y < b.y0 as f64 + top {
            let mut z = b.z0 as f64 + sp / 2.0;
            while z < b.z1 as f64 {
                s.sim.add(&gpu, [(x + (rng.f() as f64 - 0.5) * 0.02 * sp) as f32, y as f32, (z + (rng.f() as f64 - 0.5) * 0.02 * sp) as f32], [0.0; 3]);
                z += sp;
            }
            y += sp;
        }
        x += sp;
    }
    s.prime(&gpu);
    let h = s.lay.h as f64;
    // the surface near each end wall: the mean of the highest particle per column within a fifth of L of the wall; left minus right
    let surf = |p: &[[f32; 3]]| {
        let (nx, nz) = ((l / h).ceil() as usize, (dd / h).ceil() as usize);
        let mut top = vec![-1e9f64; nx * nz];
        for q in p {
            let (ix, iz) = (((q[0] - b.x0) as f64 / h).floor() as isize, ((q[2] - b.z0) as f64 / h).floor() as isize);
            if ix >= 0 && (ix as usize) < nx && iz >= 0 && (iz as usize) < nz { let c = &mut top[ix as usize * nz + iz as usize]; *c = c.max((q[1] - b.y0) as f64); }
        }
        let (mut lt, mut rt, mut cl, mut cr) = (0.0, 0.0, 0, 0);
        for ix in 0..nx { for iz in 0..nz { let v = top[ix * nz + iz]; if v < -1e8 { continue; } let xc = (ix as f64 + 0.5) * h; if xc < 0.2 * l { lt += v; cl += 1; } else if xc > 0.8 * l { rt += v; cr += 1; } } }
        lt / cl as f64 - rt / cr as f64
    };
    let (mut ts, mut ys, mut most) = (Vec::new(), Vec::new(), 0);
    for f in 0..=300 {
        if f > 0 { most = most.max(frames(&gpu, &mut s, 1)); }
        if f % 2 == 0 { ts.push(f as f64 / 60.0); ys.push(surf(&read(&gpu, &mut s).0)); }
    }
    // period from the zero crossings, decay from the peaks of successive half periods
    let mut zc = Vec::new();
    for k in 1..ys.len() { if (ys[k - 1] > 0.0) != (ys[k] > 0.0) { zc.push(ts[k - 1] + (ts[k] - ts[k - 1]) * ys[k - 1] / (ys[k - 1] - ys[k])); } }
    let per = 2.0 * (zc[zc.len() - 1] - zc[0]) / (zc.len() - 1) as f64;
    let pk: Vec<f64> = zc.windows(2).map(|w| ts.iter().zip(&ys).filter(|(t, _)| **t > w[0] && **t < w[1]).map(|(_, y)| y.abs()).fold(0.0, f64::max)).collect();
    let pi = std::f64::consts::PI;
    let first = 2.0 * am * (0.2 * pi).sin() / (0.2 * pi);
    let k = pi / l;
    let tth = 2.0 * pi / (9.8 * k * (k * hd).tanh()).sqrt();
    let left = pk[pk.len() - 1] / first;
    let nper = ts[ts.len() - 1] / per;
    let lost = 100.0 * (1.0 - left.powf(1.0 / (nper - 0.5).max(1.0)));
    let off = 100.0 * (per / tth - 1.0);
    eprintln!("slosh: period {per:.3} s against {tth:.3} s from theory ({off:.1}%); height left after {nper:.1} periods {:.0}% ({lost:.1}% lost a period); most substeps {most}\n  half-period peaks (m): {} (start {first:.4})",
        100.0 * left, pk.iter().map(|v| format!("{v:.4}")).collect::<Vec<_>>().join(" "));
    assert!(off.abs() < 5.0, "the standing wave's period is {off:.1}% off");
    assert!(lost < 25.0, "the standing wave loses {lost:.1}% of its height a period");
}

#[test]
fn swirl() {
    let gpu = Gpu::new().unwrap();
    let (l, dd, u) = (1.0f64, 0.1f64, 0.5f64);
    // no gravity: with it, the thin gap left at the top sloshes and pollutes the vortex
    let sc = scene(l, l, dd, json!([]), 0.0);
    let d = desc(&sc, SP);
    let mut s = Session::new(&gpu, &d, &|_| {}, None).unwrap();
    let (b, sp) = (s.lay.b, s.lay.d as f64);
    let pi = std::f64::consts::PI;
    let shape = |x: f64, y: f64| { let (xx, yy) = (pi * (x - b.x0 as f64) / l, pi * (y - b.y0 as f64) / l); (xx.sin() * yy.cos(), -xx.cos() * yy.sin()) };
    let mut x = b.x0 as f64 + sp / 2.0;
    while x < b.x1 as f64 {
        let mut y = b.y0 as f64 + sp / 2.0;
        while y < b.y1 as f64 {
            let mut z = b.z0 as f64 + sp / 2.0;
            while z < b.z1 as f64 { let (su, sv) = shape(x, y); s.sim.add(&gpu, [x as f32, y as f32, z as f32], [(u * su) as f32, (u * sv) as f32, 0.0]); z += sp; }
            y += sp;
        }
        x += sp;
    }
    s.prime(&gpu);
    // kinetic energy per particle, and how much of the flow still is the vortex (projection onto its shape)
    let meas = |p: &[[f32; 3]], v: &[[f32; 3]]| {
        let (mut ke, mut pr, mut n2) = (0.0, 0.0, 0.0);
        for (q, w) in p.iter().zip(v) {
            let (su, sv) = shape(q[0] as f64, q[1] as f64);
            ke += (w[0] * w[0] + w[1] * w[1] + w[2] * w[2]) as f64; pr += w[0] as f64 * su + w[1] as f64 * sv; n2 += su * su + sv * sv;
        }
        (ke / p.len() as f64, pr / n2)
    };
    let mut most = frames(&gpu, &mut s, 1);
    let (p, v) = read(&gpu, &mut s);
    let m0 = meas(&p, &v);
    let mut out = Vec::new();
    for _ in 0..3 { most = most.max(frames(&gpu, &mut s, 60)); let (p, v) = read(&gpu, &mut s); out.push(meas(&p, &v)); }
    let e: Vec<f64> = out.iter().map(|m| 100.0 * m.0 / m0.0).collect();
    let a: Vec<f64> = out.iter().map(|m| 100.0 * m.1 / m0.1).collect();
    eprintln!("swirl: energy left {:.1}%, {:.1}%, {:.1}% after 1, 2, 3 s; vortex strength left {:.1}%, {:.1}%, {:.1}%; most substeps {most}", e[0], e[1], e[2], a[0], a[1], a[2]);
    assert!(e[2] > 80.0, "the vortex keeps only {:.1}% of its energy after 3 s", e[2]);
    assert!(a[2] > 88.0, "the vortex keeps only {:.1}% of its strength after 3 s", a[2]);
}

fn built_in(name: &str) -> Value {
    let all: Value = serde_json::from_str(include_str!("../../app/src/scenes.json")).unwrap();
    all["scenes"][name].clone()
}

#[test]
fn crown() {
    let gpu = Gpu::new().unwrap();
    let sc = built_in("Meteor lake");
    let d = desc(&sc, 0.04);
    let mut s = Session::new(&gpu, &d, &|_| {}, None).unwrap();
    s.seed(&gpu);
    let (b, h) = (s.lay.b, s.lay.h);
    let (cx, cz, r) = ((b.x0 + b.x1) / 2.0, (b.z0 + b.z1) / 2.0, 0.5 * (b.x1 - b.x0).min(b.z1 - b.z0));
    let (p0, _) = read(&gpu, &mut s);
    let mut ys: Vec<f32> = p0.iter().map(|q| q[1]).collect();
    ys.sort_by(|a, b| a.total_cmp(b));
    let surf = ys[ys.len() * 98 / 100];
    // water more than 3 cells above the still surface: in the middle (r < 0.15 R), in a ring (0.15-0.6 R), further out
    let (mut best, mut at, mut line) = ([0usize; 3], 0, String::new());
    for k in 1..=12 {
        frames(&gpu, &mut s, 6);
        let (p, _) = read(&gpu, &mut s);
        let mut up = [0usize; 3];
        for q in &p {
            if q[1] - surf <= 3.0 * h { continue; }
            let rr = ((q[0] - cx).powi(2) + (q[2] - cz).powi(2)).sqrt() / r;
            up[if rr < 0.15 { 0 } else if rr < 0.6 { 1 } else { 2 }] += 1;
        }
        line += &format!(" f{}: {}/{}/{}", k * 6, up[0], up[1], up[2]);
        if up[1] > best[1] { best = up; at = k * 6; }
    }
    eprintln!("crown: most water up in the ring at frame {at}: middle {} ring {} outside {} (Meteor lake 0.04)\n  middle/ring/outside:{line}", best[0], best[1], best[2]);
    assert!(best[1] > 2000, "the impact throws up little water in a ring ({})", best[1]);
    assert!(best[1] > 3 * best[2], "water rises outside the ring ({} against {} in it): a broad mound, not a crown", best[2], best[1]);
}

#[test]
fn blast() {
    let gpu = Gpu::new().unwrap();
    let sc = built_in("Underwater blast");
    let d = desc(&sc, 0.04);
    let mut s = Session::new(&gpu, &d, &|_| {}, None).unwrap();
    s.seed(&gpu);
    let fps = d.fps;
    let mut best = (0.0f32, 0u32);
    for f in 1..=(0.45 * fps) as u32 {
        frames(&gpu, &mut s, 1);
        let t = f as f32 / fps;
        if t < 0.24 { continue; }
        let o = s.objs_at(t).into_iter().find(|o| !o.emitter && !o.water).expect("no sphere");
        let (p, v) = read(&gpu, &mut s);
        // how fast the water near the sphere moves away from its centre (95th percentile)
        let mut out: Vec<f32> = p.iter().zip(&v).filter_map(|(q, w)| {
            let dv = [q[0] - o.x as f32, q[1] - o.y as f32, q[2] - o.z as f32];
            let dist = len(dv);
            (dist > 1e-3 && dist < 0.8).then(|| (dv[0] * w[0] + dv[1] * w[1] + dv[2] * w[2]) / dist)
        }).collect();
        if out.is_empty() { continue; }
        out.sort_by(|a, b| a.total_cmp(b));
        let v95 = out[out.len() * 95 / 100];
        if v95 > best.0 { best = (v95, f); }
    }
    eprintln!("blast: water near the sphere moves out at up to {:.2} m/s (95th percentile, frame {})", best.0, best.1);
    assert!(best.0 > 3.0, "the growing sphere pushes the water out at only {:.2} m/s", best.0);
}
