//! Version 3 frames: smaller on disk, exact when read back. Water positions are stored as the difference from where the last two frames
//! say each point should be, whitewater and deep water sorted, each byte of each number in a stream of its own (the top bytes are
//! nearly all zero), every stream through zstd. A full frame every KEY_EVERY frames lets a seek start nearby. Frames in the 16-bit layout
//! (big tanks after a splash spreads) are predicted the same way; their whitewater and deep water are not sorted.
//!
//! On disk: n, flags (+ KEY, LINEAR), bytes after these three words, own box and bits if any, object poses (not compressed, so moving
//! objects need no frame unpacked), whitewater count, deep count, the compressed length of each stream, the streams.
//! Unpacking gives back a version 2 frame, so everything after the reader works as it always did. Whitewater and deep points come back sorted.

use crate::cache::*;
use rayon::prelude::*;

pub const KEY_EVERY: u32 = 24;
pub const FLAG_KEY: u32 = 64;
pub const FLAG_LINEAR: u32 = 128;
/// Position 3 x 3 bytes, speed 2, whitewater 4 + 4, deep 4 + 2.
const STREAMS: usize = 25;
/// 16-bit layout: position 3 x 3, speed, level, whitewater 6 + 4, deep 6 + 1.
const STREAMS16: usize = 28;
const Q16: [u8; 3] = [16, 16, 16];
const LEVEL: i32 = 1;

fn zig(v: i32) -> u32 { ((v << 1) ^ (v >> 31)) as u32 }
fn unzig(v: u32) -> i32 { (v >> 1) as i32 ^ -((v & 1) as i32) }
fn u32_at(b: &[u8], i: usize) -> u32 { u32::from_le_bytes(b[i * 4..i * 4 + 4].try_into().unwrap()) }

/// A frame already written or read, as far as predicting the next one needs.
pub struct Prev<'a> { pub n: usize, pub q: Option<[u8; 3]>, pub bx: Box3, pub pos: &'a [u8], pub sf: &'a [u8] }

impl Prev<'_> {
    fn alive(&self, i: usize) -> bool { i < self.n && self.sf[if self.q.is_some() { i * 2 } else { i }] != GONE }
}

/// Where each point should be in this frame's own whole numbers. Frames have boxes of their own, so the last frames are put into this one's;
/// the sums are worked out once here because this runs for every point of every frame.
struct Predict<'a> { p1: &'a Prev<'a>, p2: Option<&'a Prev<'a>>, k1: [(f64, f64); 3], k2: [(f64, f64); 3], m: [f64; 3] }

impl<'a> Predict<'a> {
    fn new(q: [u8; 3], bx: &Box3, p1: &'a Prev<'a>, p2: Option<&'a Prev<'a>>, linear: bool) -> Self {
        let (e, b0) = (bx.size(), [bx.x0, bx.y0, bx.z0]);
        let m = [0, 1, 2].map(|k| ((1u32 << q[k]) - 1) as f64);
        // lattice = a x (the old frame's whole number) + b; a flat box maps to 0
        let terms = |p: &Prev| {
            let (pe, pb, pq) = (p.bx.size(), [p.bx.x0, p.bx.y0, p.bx.z0], p.q.unwrap_or(Q16));
            [0, 1, 2].map(|k| if e[k] <= 0.0 { (0.0, 0.0) } else {
                let u = m[k] / e[k] as f64;
                (pe[k] as f64 / ((1u32 << pq[k]) - 1) as f64 * u, (pb[k] as f64 - b0[k] as f64) * u)
            })
        };
        Predict { p1, p2: p2.filter(|_| linear), k1: terms(p1), k2: p2.map_or([(0.0, 0.0); 3], terms), m }
    }
    #[inline]
    fn at(&self, i: usize) -> [u32; 3] {
        if !self.p1.alive(i) { return [0; 3]; }
        let v1 = at(self.p1.pos, self.p1.q, i);
        let mut x = [0, 1, 2].map(|k| v1[k] as f64 * self.k1[k].0 + self.k1[k].1);
        if let Some(p2) = self.p2.filter(|p| p.alive(i)) {
            let v2 = at(p2.pos, p2.q, i);
            for k in 0..3 { x[k] = 2.0 * x[k] - (v2[k] as f64 * self.k2[k].0 + self.k2[k].1); }
        }
        [0, 1, 2].map(|k| x[k].round().clamp(0.0, self.m[k]) as u32)
    }
}

/// Point i's whole numbers, in either layout.
fn at(pos: &[u8], q: Option<[u8; 3]>, i: usize) -> [u32; 3] {
    match q {
        Some(q) => {
            let v = u32_at(pos, i);
            [v & ((1u32 << q[0]) - 1), (v >> q[0]) & ((1u32 << q[1]) - 1), (v >> (q[0] + q[1])) & ((1u32 << q[2]) - 1)]
        }
        None => [0, 1, 2].map(|k| u16::from_le_bytes([pos[i * 6 + k * 2], pos[i * 6 + k * 2 + 1]]) as u32),
    }
}

/// Byte k of every 4 byte number, or of every 2 byte number with stride 2.
fn plane(b: &[u8], stride: usize, k: usize) -> Vec<u8> { b.chunks_exact(stride).map(|c| c[k]).collect() }

/// Sorted by position, the positions as gaps: positions in no useful order are the part of a frame that compresses worst.
fn sorted(pos: &[u8], other: &[u8], stride: usize) -> (Vec<u8>, Vec<u8>) {
    let n = pos.len() / 4;
    let mut ord: Vec<(u32, u32)> = (0..n).map(|i| (u32_at(pos, i), i as u32)).collect();
    ord.par_sort_unstable();
    let (mut gaps, mut rest) = (Vec::with_capacity(n * 4), Vec::with_capacity(n * stride));
    let mut last = 0u32;
    for (v, i) in ord {
        gaps.extend_from_slice(&v.wrapping_sub(last).to_le_bytes());
        last = v;
        rest.extend_from_slice(&other[i as usize * stride..(i as usize + 1) * stride]);
    }
    (gaps, rest)
}
fn unsorted(gaps: &[Vec<u8>]) -> Vec<u8> {
    let mut o = Vec::with_capacity(gaps[0].len() * 4);
    let mut last = 0u32;
    for i in 0..gaps[0].len() {
        last = last.wrapping_add(u32::from_le_bytes([gaps[0][i], gaps[1][i], gaps[2][i], gaps[3][i]]));
        o.extend_from_slice(&last.to_le_bytes());
    }
    o
}
fn woven(p: &[Vec<u8>]) -> Vec<u8> {
    let mut o = vec![0u8; p[0].len() * p.len()];
    o.par_chunks_mut(p.len()).enumerate().for_each(|(i, c)| for (k, x) in c.iter_mut().enumerate() { *x = p[k][i]; });
    o
}

/// The whole frame as stored. hist: the frames since the last full one that count, newest first (empty: this is a full frame).
pub fn encode(f: &FrameOut, b0: Box3, hist: &[Prev]) -> std::io::Result<Vec<u8>> {
    let ww = f.ww.filter(|s| s.0 > 0);
    let deep = f.deep.filter(|s| s.0 > 0);
    let (ns, nd) = (ww.map_or(0, |s| s.0), deep.map_or(0, |s| s.0));
    let mut plain = Vec::new();
    frame_bytes(&mut plain, f)?;
    let flags0 = u32::from_le_bytes(plain[4..8].try_into().unwrap());
    drop(plain);
    let mut streams: Vec<Vec<u8>> = Vec::new();
    let mut flags = flags0;
    {
        let (n, q) = (f.n as usize, f.q.unwrap_or(Q16));
        let bx = f.own_box.unwrap_or(b0);
        let (p1, p2) = (hist.first(), hist.get(1));
        if p1.is_none() { flags |= FLAG_KEY; }
        // going straight on from the last two frames is usually best, but doubles their rounding: a very fine frame does better from the last one
        let linear = p1.is_some_and(|p1| {
            let cost = |lin: bool| (0..n).step_by(64).map(|i| {
                let (v, r) = (at(f.pos, f.q, i), Predict::new(q, &bx, p1, p2, lin).at(i));
                (0..3).map(|k| ((v[k] as f64 - r[k] as f64).abs() + 1.0).log2()).sum::<f64>()
            }).sum::<f64>();
            cost(true) < cost(false)
        });
        if linear { flags |= FLAG_LINEAR; }
        let pr = p1.map(|p1| Predict::new(q, &bx, p1, p2, linear));
        let res: Vec<[u32; 3]> = (0..n).into_par_iter().map(|i| {
            let v = at(f.pos, f.q, i);
            let r = pr.as_ref().map_or([0; 3], |p| p.at(i));
            [0, 1, 2].map(|k| zig(v[k] as i32 - r[k] as i32))
        }).collect();
        for a in 0..3 { for k in 0..3 { streams.push(res.iter().map(|r| (r[a] >> (k * 8)) as u8).collect()); } }
        // speed bytes change little from frame to frame
        let same = p1.filter(|p| p.q.is_some() == f.q.is_some());
        let dsf: Vec<u8> = f.spd.iter().enumerate().map(|(i, x)| x.wrapping_sub(same.map_or(0, |p| *p.sf.get(i).unwrap_or(&0)))).collect();
        if f.q.is_some() {
            streams.push(plane(&dsf, 2, 0));
            streams.push(plane(&dsf, 2, 1));
            let (ga, pk) = ww.map_or((Vec::new(), Vec::new()), |(_, pos, pk)| sorted(pos, bytemuck::cast_slice(pk), 4));
            for k in 0..4 { streams.push(plane(&ga, 4, k)); }
            for k in 0..4 { streams.push(plane(&pk, 4, k)); }
            let (gd, sd) = deep.map_or((Vec::new(), Vec::new()), |(_, pos, s)| sorted(pos, s, 2));
            for k in 0..4 { streams.push(plane(&gd, 4, k)); }
            for k in 0..2 { streams.push(plane(&sd, 2, k)); }
        } else {
            streams.push(dsf);
            streams.push(f.fm.map_or(Vec::new(), <[u8]>::to_vec));
            let (wp, wk): (&[u8], &[u8]) = ww.map_or((&[], &[]), |(_, p, k)| (p, bytemuck::cast_slice(k)));
            for k in 0..6 { streams.push(plane(wp, 6, k)); }
            for k in 0..4 { streams.push(plane(wk, 4, k)); }
            let (dp, ds): (&[u8], &[u8]) = deep.map_or((&[], &[]), |(_, p, s)| (p, s));
            for k in 0..6 { streams.push(plane(dp, 6, k)); }
            streams.push(ds.to_vec());
        }
        if let Some((_, _, d)) = f.fog { streams.push(d.to_vec()); }
    }
    let comp: Vec<Vec<u8>> = streams.par_iter().map(|s| if s.is_empty() { Ok(Vec::new()) } else { zstd::bulk::compress(s, LEVEL) }).collect::<Result<_, _>>()?;
    let mut w = Vec::with_capacity(comp.iter().map(Vec::len).sum::<usize>() + 256);
    let mut head = Vec::new();
    if let Some(b) = f.own_box.filter(|_| f.q.is_some()) {
        for v in [b.x0, b.y0, b.z0, b.x1, b.y1, b.z1] { head.extend_from_slice(&v.to_le_bytes()); }
        let q = f.q.unwrap();
        head.extend_from_slice(&[q[0], q[1], q[2], 0]);
    }
    for v in f.objs { head.extend_from_slice(&v.to_le_bytes()); }
    head.extend_from_slice(&ns.to_le_bytes());
    head.extend_from_slice(&nd.to_le_bytes());
    if let Some((n, h, _)) = f.fog { for v in n { head.extend_from_slice(&v.to_le_bytes()); } head.extend_from_slice(&h.to_le_bytes()); }
    for c in &comp { head.extend_from_slice(&(c.len() as u32).to_le_bytes()); }
    w.extend_from_slice(&f.n.to_le_bytes());
    w.extend_from_slice(&flags.to_le_bytes());
    w.extend_from_slice(&((head.len() + comp.iter().map(Vec::len).sum::<usize>()) as u32).to_le_bytes());
    w.extend_from_slice(&head);
    for c in &comp { w.extend_from_slice(c); }
    Ok(w)
}

/// What a stored frame's head says, without unpacking anything.
pub struct Head { pub fr: FrameIndex, pub lens: Vec<u32>, pub data: usize, pub end: usize }

pub fn read_head(b: &[u8], o: &mut usize, nobj: usize, q0: Option<[u8; 3]>) -> Option<Head> {
    let mut r = Rd { b, o: *o };
    let n = r.u32()?;
    let fl = r.u32()?;
    let total = r.u32()? as usize;
    let end = r.o.checked_add(total)?;
    if end > b.len() { return None; }
    let compact = fl & FLAG_COMPACT != 0;
    let (mut own_box, mut q) = (None, if compact { q0 } else { None });
    if compact && fl & FLAG_OWN_BOX != 0 {
        let v = [r.f32()?, r.f32()?, r.f32()?, r.f32()?, r.f32()?, r.f32()?];
        own_box = Some(Box3 { x0: v[0], y0: v[1], z0: v[2], x1: v[3], y1: v[4], z1: v[5] });
        let qb = r.take(4)?;
        q = Some([b[qb.start], b[qb.start + 1], b[qb.start + 2]]);
    }
    let objs = r.take(nobj * 24)?;
    let (ns, nd) = (r.u32()?, r.u32()?);
    let fog = if fl & FLAG_FOG != 0 { Some(FogIndex { n: [r.u32()?, r.u32()?, r.u32()?], h: r.f32()?, d: 0..0 }) } else { None };
    let lens = (0..if compact { STREAMS } else { STREAMS16 } + fog.is_some() as usize).map(|_| r.u32()).collect::<Option<Vec<_>>>()?;
    if compact && q.is_none() { return None; }
    let water = Points { n, ..Default::default() };
    let ww = (ns > 0).then(|| WwPoints { n: ns, pos: 0..0, pk: 0..0 });
    let deep = (nd > 0).then(|| Points { n: nd, ..Default::default() });
    let data = r.o;
    *o = end;
    Some(Head { fr: FrameIndex { flags: fl, q, own_box, objs, water, ww, deep, fog, packed: Some(data..end) }, lens, data, end })
}

/// A version 2 frame's bytes from a stored frame. hist as for encode (what its flags say it needs).
pub fn decode(b: &[u8], h: &Head, b0: Box3, hist: &[Prev], objs: &[f32]) -> std::io::Result<Vec<u8>> {
    let mut at = h.data;
    let blobs: Vec<&[u8]> = h.lens.iter().map(|&l| { let s = &b[at..at + l as usize]; at += l as usize; s }).collect();
    let fr = &h.fr;
    let (n, ns, nd) = (fr.water.n as usize, fr.ww.as_ref().map_or(0, |w| w.n as usize), fr.deep.as_ref().map_or(0, |d| d.n as usize));
    let compact = fr.q.is_some();
    let q = fr.q.unwrap_or(Q16);
    let fogv = |s: &'_ Vec<Vec<u8>>| -> Option<Vec<u8>> { fr.fog.as_ref().map(|_| s.last().unwrap().clone()) };
    let nf = fr.fog.as_ref().map_or(0, |g| g.n[0] as usize * g.n[1] as usize * g.n[2] as usize);
    let (last, count) = (blobs.len() - 1, if compact { STREAMS } else { STREAMS16 });
    let size = |i: usize| if i == last && last == count { nf } else if compact { match i { 0..=10 => n, 11..=18 => ns, _ => nd } } else { match i { 0..=10 => n, 11..=20 => ns, _ => nd } };
    let s: Vec<Vec<u8>> = blobs.par_iter().enumerate().map(|(i, c)| if c.is_empty() { Ok(Vec::new()) } else { zstd::bulk::decompress(c, size(i)) }).collect::<Result<_, _>>()?;
    let bx = fr.own_box.unwrap_or(b0);
    let (p1, p2) = (hist.first(), hist.get(1));
    let linear = fr.flags & FLAG_LINEAR != 0;
    let pr = p1.map(|p1| Predict::new(q, &bx, p1, p2, linear));
    let point = |i: usize| {
        let r = pr.as_ref().map_or([0; 3], |p| p.at(i));
        [0, 1, 2].map(|a| {
            let z = s[a * 3][i] as u32 | (s[a * 3 + 1][i] as u32) << 8 | (s[a * 3 + 2][i] as u32) << 16;
            (r[a] as i32 + unzig(z)) as u32
        })
    };
    let (mut pos, mut p6) = (Vec::new(), Vec::new());
    if compact {
        let sh = [q[0] as u32, (q[0] + q[1]) as u32];
        pos = (0..n).into_par_iter().map(|i| { let v = point(i); v[0] | v[1] << sh[0] | v[2] << sh[1] }).collect();
    } else {
        p6 = vec![0u8; n * 6];
        p6.par_chunks_mut(6).enumerate().for_each(|(i, c)| { let v = point(i); for k in 0..3 { c[k * 2..k * 2 + 2].copy_from_slice(&(v[k] as u16).to_le_bytes()); } });
    }
    let mut sf = if compact { woven(&s[9..11]) } else { s[9].clone() };
    if let Some(p) = p1.filter(|p| p.q.is_some() == compact) { sf.par_iter_mut().enumerate().for_each(|(i, x)| *x = x.wrapping_add(*p.sf.get(i).unwrap_or(&0))); }
    if !compact {
        let (wp, pk16) = if ns > 0 { (woven(&s[11..17]), woven(&s[17..21])) } else { (Vec::new(), Vec::new()) };
        let pk: Vec<u32> = pk16.chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect();
        let dp = if nd > 0 { woven(&s[21..27]) } else { Vec::new() };
        let mut o = Vec::new();
        let fm = fr.flags & FLAG_LEVELS != 0;
        let fd = fogv(&s);
        frame_bytes(&mut o, &FrameOut { q: None, own_box: None, ww_baked: fr.flags & FLAG_WW_BAKED != 0, objs, n: fr.water.n, pos: &p6, spd: &sf, fm: fm.then_some(&s[10][..]),
            ww: (ns > 0).then_some((ns as u32, &wp[..], &pk[..])), deep: (nd > 0).then_some((nd as u32, &dp[..], &s[27][..])), fog: fr.fog.as_ref().map(|g| (g.n, g.h, &fd.as_ref().unwrap()[..])) })?;
        return Ok(o);
    }
    let (wpos, wpk) = if ns > 0 { (unsorted(&s[11..15]), woven(&s[15..19])) } else { (Vec::new(), Vec::new()) };
    let pk: Vec<u32> = wpk.chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect();
    let (dpos, dsf) = if nd > 0 { (unsorted(&s[19..23]), woven(&s[23..25])) } else { (Vec::new(), Vec::new()) };
    let mut o = Vec::new();
    let fd = fogv(&s);
    frame_bytes(&mut o, &FrameOut { q: Some(q), own_box: fr.own_box, ww_baked: fr.flags & FLAG_WW_BAKED != 0, objs, n: fr.water.n, pos: bytemuck::cast_slice(&pos), spd: &sf, fm: None,
        ww: (ns > 0).then_some((ns as u32, &wpos[..], &pk[..])), deep: (nd > 0).then_some((nd as u32, &dpos[..], &dsf[..])), fog: fr.fog.as_ref().map(|g| (g.n, g.h, &fd.as_ref().unwrap()[..])) })?;
    Ok(o)
}
