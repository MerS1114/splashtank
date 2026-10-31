//! Bake caches (.splc). Mirrors `writeCacheParts`, `parseCache2` and `parseCache` in `src/shared.js`: change both together.
//!
//! Version 3 (bakes now): as version 2, with each frame stored smaller, see packed.rs. Only this program reads it.
//! Version 2: 'SPLC', 2, length of a JSON block, the JSON, padding to 4 bytes, frame count, then per frame: points, flags, and
//! the frame's data. Flags: 1 white-water levels follow (16-bit layout), 2 whitewater follows, 4 deep water points follow,
//! 8 compact frame (32-bit positions, 16-bit speed | level << 8), 16 whitewater made by Bake whitewater, 32 the compact frame
//! has its own box and bits. Every part is padded to 4 bytes.
//!
//! The file is memory-mapped and only the frame headers are read on opening, so a cache of any length costs no memory;
//! a frame's arrays are borrowed straight from the mapping (version 2) or unpacked when asked for (version 3): use Cache::view for them.

use serde_json::Value;
use std::fs::File;
use std::io::{self, BufWriter, Read, Seek, SeekFrom, Write};
use std::ops::Range;
use std::path::Path;
use std::sync::{Arc, Mutex};

pub const FLAG_LEVELS: u32 = 1;
pub const FLAG_WW: u32 = 2;
pub const FLAG_DEEP: u32 = 4;
pub const FLAG_COMPACT: u32 = 8;
pub const FLAG_WW_BAKED: u32 = 16;
pub const FLAG_OWN_BOX: u32 = 32;

/// Speed byte meaning "gone" (a dead particle slot kept so slots line up between frames).
pub const GONE: u8 = 255;
/// sf bit 12: a compact water point buried three cells inside the water (markInterior), which no view can see.
pub const BURIED: u16 = 4096;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Box3 { pub x0: f32, pub y0: f32, pub z0: f32, pub x1: f32, pub y1: f32, pub z1: f32 }

impl Box3 {
    pub fn from_json(v: &Value) -> Option<Box3> {
        let g = |k: &str| v.get(k).and_then(Value::as_f64).map(|x| x as f32);
        Some(Box3 { x0: g("x0")?, y0: g("y0")?, z0: g("z0")?, x1: g("x1")?, y1: g("y1")?, z1: g("z1")? })
    }
    pub fn to_json(&self) -> Value {
        serde_json::json!({ "x0": self.x0, "x1": self.x1, "y0": self.y0, "y1": self.y1, "z0": self.z0, "z1": self.z1 })
    }
    pub fn size(&self) -> [f32; 3] { [self.x1 - self.x0, self.y1 - self.y0, self.z1 - self.z0] }
}

/// Where one point array lives: compact (u32 positions, u16 speed words) or the 16-bit layout (3 x u16 positions, u8 speeds).
#[derive(Clone, Debug, Default)]
pub struct Points {
    pub n: u32,
    pub pos: Range<usize>,
    /// compact: u16 sf per point; 16-bit layout: u8 speed per point
    pub spd: Range<usize>,
    /// 16-bit layout only: u8 white-water level x 17 per point (flag 1)
    pub fm: Option<Range<usize>>,
}

#[derive(Clone, Debug)]
pub struct WwPoints {
    pub n: u32,
    pub pos: Range<usize>,
    /// u32 codes (kind, speed, direction or seed)
    pub pk: Range<usize>,
}

#[derive(Clone, Debug)]
pub struct FrameIndex {
    pub flags: u32,
    /// compact frames: bits per axis; None for the 16-bit layout
    pub q: Option<[u8; 3]>,
    /// a compact frame measured across its own box (flag 32), water and deep water
    pub own_box: Option<Box3>,
    /// object poses, 6 floats each (x y z rx yaw rz), relative to the cache's origin
    pub objs: Range<usize>,
    pub water: Points,
    pub ww: Option<WwPoints>,
    pub deep: Option<Points>,
    /// version 3: the frame's stored streams; its other ranges are empty until Cache::view unpacks it
    pub packed: Option<Range<usize>>,
}

impl FrameIndex {
    pub fn compact(&self) -> bool { self.flags & FLAG_COMPACT != 0 }
}

/// The fields of the cache's JSON block the viewer needs; `meta` keeps all of it.
#[derive(Clone, Debug)]
pub struct CacheInfo {
    pub version: u32,
    pub meta: Value,
    pub d: f32,
    pub fps: f32,
    pub ids: Vec<u64>,
    /// the tank box the positions are measured across (centred on x and z, floor at 0)
    pub b: Box3,
    /// added to every position and object pose to place them in the scene
    pub org: [f32; 3],
    pub scale: f32,
    /// speed bytes are 16ths of m/s (else 16ths of a scene unit per second)
    pub spd_ms: bool,
    /// bits of compact frames that do not carry their own
    pub q: Option<[u8; 3]>,
    /// whitewater area: whitewater positions are measured across it when present (else across b)
    pub sb: Option<Box3>,
    pub stable_ids: bool,
}

/// Where a cache's bytes are: a memory-mapped file, or memory (the live sim, which grows frame by frame).
enum Store { Map(memmap2::Mmap), Mem(Vec<u8>) }

/// A frame unpacked, its ranges measured in its own bytes.
struct Unpacked { bytes: Vec<u8>, fr: FrameIndex }
/// Frames unpacked lately, newest last: the next frame needs the two before it, and going backwards needs the run from the last full frame.
#[derive(Default)]
struct Recent { list: Vec<(usize, Arc<Unpacked>)>, bytes: usize }
const RECENT_BYTES: usize = 1 << 30;

enum ViewBytes<'a> { File(&'a [u8]), Own(Arc<Unpacked>) }
/// One frame's data: fr's ranges index bytes().
pub struct View<'a> { data: ViewBytes<'a>, pub fr: FrameIndex }
impl View<'_> {
    pub fn bytes(&self) -> &[u8] { match &self.data { ViewBytes::File(b) => b, ViewBytes::Own(u) => &u.bytes } }
    pub fn slice(&self, r: &Range<usize>) -> &[u8] { &self.bytes()[r.clone()] }
}

pub struct Cache {
    map: Store,
    pub info: CacheInfo,
    pub frames: Vec<FrameIndex>,
    /// the file ended inside a frame (a bake cut short); the frames before it are all there
    pub truncated: bool,
    /// version 3: where each frame starts
    starts: Vec<usize>,
    recent: Mutex<Recent>,
}

fn bad(msg: impl Into<String>) -> io::Error { io::Error::new(io::ErrorKind::InvalidData, msg.into()) }
fn pad4(k: usize) -> usize { (4 - k % 4) % 4 }
fn q_of(v: &Value) -> Option<[u8; 3]> {
    let a = v.as_array()?;
    if a.len() < 3 { return None; }
    Some([a[0].as_u64()? as u8, a[1].as_u64()? as u8, a[2].as_u64()? as u8])
}

pub(crate) struct Rd<'a> { pub b: &'a [u8], pub o: usize }
impl<'a> Rd<'a> {
    fn need(&self, k: usize) -> bool { self.o + k <= self.b.len() }
    pub fn u32(&mut self) -> Option<u32> {
        if !self.need(4) { return None; }
        let v = u32::from_le_bytes(self.b[self.o..self.o + 4].try_into().unwrap());
        self.o += 4;
        Some(v)
    }
    pub fn f32(&mut self) -> Option<f32> { self.u32().map(f32::from_bits) }
    pub fn take(&mut self, k: usize) -> Option<Range<usize>> {
        if !self.need(k) { return None; }
        let r = self.o..self.o + k;
        self.o += k;
        Some(r)
    }
}

impl Cache {
    pub fn open(path: &Path) -> io::Result<Cache> {
        let file = File::open(path)?;
        // SAFETY: the file is only read; another program truncating it while it is open would be the user's doing.
        let map = unsafe { memmap2::Mmap::map(&file)? };
        let (info, frames, truncated) = index(&map)?;
        let starts = frames.iter().map(|f: &FrameIndex| f.packed.as_ref().map_or(0, |r| r.start)).collect();
        Ok(Cache { map: Store::Map(map), info, frames, truncated, starts, recent: Default::default() })
    }

    /// A cache in memory from a cache's header (what CacheWriter::to_channel sends first); frames are added with push.
    pub fn from_header(head: Vec<u8>) -> io::Result<Cache> {
        let (info, frames, _) = index(&head)?;
        Ok(Cache { map: Store::Mem(head), info, frames, truncated: false, starts: Vec::new(), recent: Default::default() })
    }
    /// Adds one frame's bytes (as CacheWriter::to_channel sends them) to a cache in memory.
    pub fn push(&mut self, frame: &[u8]) -> io::Result<()> {
        let Store::Mem(v) = &mut self.map else { return Err(bad("Only a cache in memory takes frames.")); };
        let start = v.len();
        v.extend_from_slice(frame);
        let mut r = Rd { b: v, o: start };
        match frame_v2(&mut r, self.info.ids.len(), self.info.q) {
            Some(fr) => { self.frames.push(fr); Ok(()) }
            None => { v.truncate(start); Err(bad("A frame the cache could not read.")) }
        }
    }

    pub fn bytes(&self) -> &[u8] { match &self.map { Store::Map(m) => m, Store::Mem(v) => v } }
    pub fn slice(&self, r: &Range<usize>) -> &[u8] { &self.bytes()[r.clone()] }

    pub fn objs(&self, f: usize) -> Vec<f32> {
        self.slice(&self.frames[f].objs).chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect()
    }

    /// The box a frame's water and deep water positions are measured across.
    pub fn frame_box(&self, f: usize) -> Box3 { self.frames[f].own_box.unwrap_or(self.info.b) }
    /// Bits of a compact frame.
    pub fn frame_q(&self, f: usize) -> Option<[u8; 3]> { self.frames[f].q }
    /// The box whitewater positions are measured across.
    pub fn ww_box(&self) -> Box3 { self.info.sb.unwrap_or(self.info.b) }

    /// Point i of a frame's water (like framePoint in shared.js): position in scene units relative to the origin, speed byte, white-water level 0-15.
    pub fn water_point(&self, f: usize, i: usize) -> ([f32; 3], u8, u8) {
        let v = self.view(f);
        decode_point(v.bytes(), &v.fr.water, v.fr.q, &self.frame_box(f), i)
    }

    /// Frames are stored packed (version 3), so a frame costs work to read.
    pub fn packed(&self) -> bool { self.info.version == 3 }

    /// Frame f's arrays. Version 3 unpacks it, with the frames it depends on unless they were unpacked lately.
    pub fn view(&self, f: usize) -> View<'_> {
        if self.frames[f].packed.is_none() { return View { data: ViewBytes::File(self.bytes()), fr: self.frames[f].clone() }; }
        let u = self.unpacked(f);
        View { fr: u.fr.clone(), data: ViewBytes::Own(u) }
    }

    fn unpacked(&self, f: usize) -> Arc<Unpacked> {
        { let g = self.recent.lock().unwrap(); if let Some(x) = g.list.iter().find(|x| x.0 == f) { return x.1.clone(); } }
        let fr = &self.frames[f];
        let key = fr.flags & crate::packed::FLAG_KEY != 0;
        let p1 = (!key).then(|| self.unpacked(f - 1));
        let p2 = p1.as_ref().filter(|_| self.frames[f - 1].flags & crate::packed::FLAG_KEY == 0).map(|_| self.unpacked(f - 2));
        let prev = |k: usize, u: &'_ Arc<Unpacked>| -> (usize, Box3, Option<[u8; 3]>, Range<usize>, Range<usize>) { (u.fr.water.n as usize, self.frame_box(k), u.fr.q, u.fr.water.pos.clone(), u.fr.water.spd.clone()) };
        let mut hist = Vec::new();
        if let Some(u) = &p1 { let (n, bx, q, pos, sf) = prev(f - 1, u); hist.push(crate::packed::Prev { n, q, bx, pos: &u.bytes[pos], sf: &u.bytes[sf] }); }
        if let Some(u) = &p2 { let (n, bx, q, pos, sf) = prev(f - 2, u); hist.push(crate::packed::Prev { n, q, bx, pos: &u.bytes[pos], sf: &u.bytes[sf] }); }
        let b = self.bytes();
        let mut o = self.starts[f];
        let h = crate::packed::read_head(b, &mut o, self.info.ids.len(), self.info.q).expect("a stored frame");
        let objs = self.objs(f);
        let bytes = crate::packed::decode(b, &h, self.info.b, &hist, &objs).expect("A stored frame could not be unpacked.");
        let fr = frame_v2(&mut Rd { b: &bytes, o: 0 }, self.info.ids.len(), self.info.q).expect("an unpacked frame");
        let u = Arc::new(Unpacked { bytes, fr });
        let mut g = self.recent.lock().unwrap();
        g.bytes += u.bytes.len();
        g.list.push((f, u.clone()));
        while g.bytes > RECENT_BYTES && g.list.len() > 4 { let old = g.list.remove(0); g.bytes -= old.1.bytes.len(); }
        u
    }
}

/// One point of a point array in either layout.
pub fn decode_point(b: &[u8], p: &Points, q: Option<[u8; 3]>, bx: &Box3, i: usize) -> ([f32; 3], u8, u8) {
    let e = bx.size();
    match q {
        Some(q) => {
            let o = p.pos.start + i * 4;
            let v = u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
            let (mx, my, mz) = ((1u32 << q[0]) - 1, (1u32 << q[1]) - 1, (1u32 << q[2]) - 1);
            let s = p.spd.start + i * 2;
            let w = u16::from_le_bytes(b[s..s + 2].try_into().unwrap());
            ([(v & mx) as f32 / mx as f32 * e[0] + bx.x0,
              ((v >> q[0]) & my) as f32 / my as f32 * e[1] + bx.y0,
              ((v >> (q[0] + q[1])) & mz) as f32 / mz as f32 * e[2] + bx.z0],
             (w & 255) as u8, ((w >> 8) & 15) as u8)
        }
        None => {
            let o = p.pos.start + i * 6;
            let c = |k: usize| u16::from_le_bytes(b[o + k * 2..o + k * 2 + 2].try_into().unwrap()) as f32 / 65535.0;
            let lvl = p.fm.as_ref().map(|r| ((b[r.start + i] as f32) / 17.0).round() as u8).unwrap_or(0);
            ([c(0) * e[0] + bx.x0, c(1) * e[1] + bx.y0, c(2) * e[2] + bx.z0], b[p.spd.start + i], lvl)
        }
    }
}

fn index(b: &[u8]) -> io::Result<(CacheInfo, Vec<FrameIndex>, bool)> {
    if b.len() < 24 || &b[0..4] != b"SPLC" { return Err(bad("This is not a SplashTank cache file.")); }
    let mut r = Rd { b, o: 4 };
    let ver = r.u32().unwrap();
    if ver != 2 && ver != 3 { return index_v1(b); }
    let ml = r.u32().unwrap() as usize;
    let mj = r.take(ml).ok_or_else(|| bad("The cache file ends inside its header."))?;
    let meta: Value = serde_json::from_slice(&b[mj]).map_err(|e| bad(format!("The cache header is not valid JSON: {e}")))?;
    r.o += pad4(ml);
    let g = |k: &str| meta.get(k).and_then(Value::as_f64);
    let org = meta.get("org").map(|o| {
        let c = |k: &str| o.get(k).and_then(Value::as_f64).unwrap_or(0.0) as f32;
        [c("x"), c("y"), c("z")]
    }).unwrap_or([0.0; 3]);
    let info = CacheInfo {
        version: ver,
        d: g("d").unwrap_or(0.05) as f32,
        fps: g("fps").unwrap_or(24.0) as f32,
        ids: meta.get("ids").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_u64).collect()).unwrap_or_default(),
        b: meta.get("b").and_then(Box3::from_json).ok_or_else(|| bad("The cache header has no box."))?,
        org,
        scale: g("scale").unwrap_or(1.0) as f32,
        spd_ms: meta.get("spdMs").and_then(Value::as_bool).unwrap_or(false),
        q: meta.get("q").and_then(q_of),
        sb: meta.get("sb").and_then(Box3::from_json),
        stable_ids: meta.get("stableIds").and_then(Value::as_bool).unwrap_or(false),
        meta,
    };
    let nf = r.u32().ok_or_else(|| bad("The cache file has no frame count."))?;
    let nobj = info.ids.len();
    let mut frames = Vec::new();
    let mut truncated = false;
    // A frame count of u32::MAX means "until the end of the file" (a bake still running, or cut short).
    for _ in 0..nf {
        if !r.need(8) { truncated = nf != u32::MAX; break; }
        let start = r.o;
        let got = if ver == 3 { crate::packed::read_head(b, &mut r.o, nobj, info.q).map(|h| FrameIndex { packed: Some(start..h.end), ..h.fr }) } else { frame_v2(&mut r, nobj, info.q) };
        match got {
            Some(fr) => frames.push(fr),
            None => { truncated = true; break; }
        }
    }
    Ok((info, frames, truncated))
}

fn frame_v2(r: &mut Rd, nobj: usize, q0: Option<[u8; 3]>) -> Option<FrameIndex> {
    let n = r.u32()?;
    let fl = r.u32()?;
    let nu = n as usize;
    if fl & FLAG_COMPACT != 0 {
        let (mut own_box, mut q) = (None, q0);
        if fl & FLAG_OWN_BOX != 0 {
            let v = [r.f32()?, r.f32()?, r.f32()?, r.f32()?, r.f32()?, r.f32()?];
            own_box = Some(Box3 { x0: v[0], y0: v[1], z0: v[2], x1: v[3], y1: v[4], z1: v[5] });
            let qb = r.take(4)?;
            q = Some([r.b[qb.start], r.b[qb.start + 1], r.b[qb.start + 2]]);
        }
        let objs = r.take(nobj * 24)?;
        let pos = r.take(nu * 4)?;
        let spd = r.take(nu * 2)?;
        r.take(pad4(nu * 2))?;
        let ww = if fl & FLAG_WW != 0 {
            let ns = r.u32()? as usize;
            Some(WwPoints { n: ns as u32, pos: r.take(ns * 4)?, pk: r.take(ns * 4)? })
        } else { None };
        let deep = if fl & FLAG_DEEP != 0 {
            let nd = r.u32()? as usize;
            let p = Points { n: nd as u32, pos: r.take(nd * 4)?, spd: r.take(nd * 2)?, fm: None };
            r.take(pad4(nd * 2))?;
            Some(p)
        } else { None };
        return Some(FrameIndex { flags: fl, q: Some(q?), own_box, objs, water: Points { n, pos, spd, fm: None }, ww, deep, packed: None });
    }
    let objs = r.take(nobj * 24)?;
    let pos = r.take(nu * 6)?;
    let spd = r.take(nu)?;
    let fm = if fl & FLAG_LEVELS != 0 { Some(r.take(nu)?) } else { None };
    r.take(pad4(nu * if fm.is_some() { 8 } else { 7 }))?;
    let ww = if fl & FLAG_WW != 0 {
        let ns = r.u32()? as usize;
        let pos = r.take(ns * 6)?;
        r.take(pad4(ns * 6))?;
        Some(WwPoints { n: ns as u32, pos, pk: r.take(ns * 4)? })
    } else { None };
    let deep = if fl & FLAG_DEEP != 0 {
        let nd = r.u32()? as usize;
        let p = Points { n: nd as u32, pos: r.take(nd * 6)?, spd: r.take(nd)?, fm: None };
        r.take(pad4(nd * 7))?;
        Some(p)
    } else { None };
    Some(FrameIndex { flags: fl, q: None, own_box: None, objs, water: Points { n, pos, spd, fm }, ww, deep, packed: None })
}

/// The older format from native/splash.cpp: d, fps, frames, object ids, then per frame points, poses (x y z yaw), positions, speeds.
/// Poses are 4 floats there; this reader keeps their byte range and the viewer reads them through `objs_v1`.
fn index_v1(b: &[u8]) -> io::Result<(CacheInfo, Vec<FrameIndex>, bool)> {
    let mut r = Rd { b, o: 8 };
    let d = r.f32().unwrap();
    let fps = r.u32().unwrap();
    let nf = r.u32().unwrap();
    let nobj = r.u32().unwrap() as usize;
    let mut ids = Vec::new();
    for _ in 0..nobj { ids.push(r.u32().ok_or_else(|| bad("The cache file ends inside its header."))? as u64); }
    let mut frames = Vec::new();
    let mut truncated = false;
    for _ in 0..nf {
        let Some(n) = r.u32() else { truncated = true; break; };
        let nu = n as usize;
        let (Some(objs), Some(pos), Some(spd)) = (r.take(nobj * 16), r.take(nu * 6), r.take(nu)) else { truncated = true; break; };
        frames.push(FrameIndex { flags: 0x8000_0000, q: None, own_box: None, objs, water: Points { n, pos, spd, fm: None }, ww: None, deep: None, packed: None });
    }
    // splash.cpp's tank: 3 x 2.6 x 3 centred on x and z
    let info = CacheInfo { version: 1, meta: Value::Null, d, fps: fps as f32, ids, b: Box3 { x0: -1.5, x1: 1.5, y0: 0.0, y1: 2.6, z0: -1.5, z1: 1.5 },
        org: [0.0; 3], scale: 1.0, spd_ms: false, q: None, sb: None, stable_ids: false };
    Ok((info, frames, truncated))
}

impl Cache {
    /// Object poses of a frame as 6 floats each, for both versions (version 1 holds x y z yaw with yaw the other way round).
    pub fn poses(&self, f: usize) -> Vec<f32> {
        if self.info.version >= 2 { return self.objs(f); }
        let raw = self.objs(f);
        raw.chunks_exact(4).flat_map(|c| [c[0], c[1], c[2], 0.0, -c[3], 0.0]).collect()
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Writing

/// One frame to write, borrowing its arrays. Compact when `q` is set (pos: u32 per point, spd: u16 sf per point), else the
/// 16-bit layout (pos: 3 x u16, spd: u8, fm: optional u8 levels x 17).
pub struct FrameOut<'a> {
    pub q: Option<[u8; 3]>,
    pub own_box: Option<Box3>,
    pub ww_baked: bool,
    pub objs: &'a [f32],
    pub n: u32,
    pub pos: &'a [u8],
    pub spd: &'a [u8],
    pub fm: Option<&'a [u8]>,
    /// whitewater: count, positions (u32 compact or 3 x u16), codes
    pub ww: Option<(u32, &'a [u8], &'a [u32])>,
    /// deep water: count, positions, speeds (u16 sf compact or u8)
    pub deep: Option<(u32, &'a [u8], &'a [u8])>,
}

/// Streams a cache to disk frame by frame. The JSON block gets reserved room (padded with spaces, which JSON allows) so the
/// final header can be written in place; the frame count is u32::MAX until `finish`, which the page's reader and this one
/// read as "until the end of the file", so a bake cut short still opens.
pub struct CacheWriter {
    w: Sink,
    /// the frame being put together (written to the file or sent whole)
    buf: Vec<u8>,
    room: usize,
    frames: u32,
    path: std::path::PathBuf,
    /// version 3: the box of frames without one of their own, and the frames since the last full one (at most two, newest first)
    packed: Option<Box3>,
    hist: Vec<Kept>,
}

/// A frame just written, kept to predict the next.
struct Kept { n: usize, q: Option<[u8; 3]>, bx: Box3, pos: Vec<u8>, sf: Vec<u8> }

/// A file, or a channel to whoever shows the frames as they come (the live sim): the header first, then one message a frame.
enum Sink { File(BufWriter<File>), Chan(std::sync::mpsc::Sender<Vec<u8>>) }

fn header(meta: &Value, reserve: usize, ver: u32) -> io::Result<(Vec<u8>, usize)> {
    let mj = serde_json::to_vec(meta)?;
    let room = (mj.len() + reserve + 3) / 4 * 4;
    let mut h = Vec::with_capacity(16 + room);
    h.extend_from_slice(b"SPLC");
    h.extend_from_slice(&ver.to_le_bytes());
    h.extend_from_slice(&(room as u32).to_le_bytes());
    h.extend_from_slice(&mj);
    h.resize(12 + room, b' ');
    h.extend_from_slice(&u32::MAX.to_le_bytes());
    Ok((h, room))
}

impl CacheWriter {
    /// A bake's file, version 3.
    pub fn create(path: &Path, meta: &Value, reserve: usize) -> io::Result<CacheWriter> {
        let b = meta.get("b").and_then(Box3::from_json).ok_or_else(|| bad("The cache header has no box."))?;
        Self::start(path, meta, reserve, 3, Some(b))
    }
    /// Version 2, which the web page reads too.
    pub fn create_v2(path: &Path, meta: &Value, reserve: usize) -> io::Result<CacheWriter> { Self::start(path, meta, reserve, 2, None) }
    fn start(path: &Path, meta: &Value, reserve: usize, ver: u32, packed: Option<Box3>) -> io::Result<CacheWriter> {
        let (h, room) = header(meta, reserve, ver)?;
        let mut w = BufWriter::with_capacity(8 << 20, File::create(path)?);
        w.write_all(&h)?;
        Ok(CacheWriter { w: Sink::File(w), buf: Vec::new(), room, frames: 0, path: path.to_owned(), packed, hist: Vec::new() })
    }
    /// Sends the cache to tx instead of a file: the header now, then each frame (Cache::from_header and push read them).
    pub fn to_channel(meta: &Value, tx: std::sync::mpsc::Sender<Vec<u8>>) -> io::Result<CacheWriter> {
        let (h, room) = header(meta, 0, 2)?;
        tx.send(h).map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "nobody takes the frames"))?;
        Ok(CacheWriter { w: Sink::Chan(tx), buf: Vec::new(), room, frames: 0, path: Default::default(), packed: None, hist: Vec::new() })
    }
    fn file(&mut self) -> io::Result<&mut BufWriter<File>> {
        match &mut self.w { Sink::File(f) => Ok(f), Sink::Chan(_) => Err(io::Error::new(io::ErrorKind::Unsupported, "this cache goes to a channel")) }
    }

    pub fn frames(&self) -> u32 { self.frames }

    /// Writes out everything appended so far and returns where the file ends (a checkpoint records it).
    pub fn flush_point(&mut self) -> io::Result<u64> {
        if matches!(self.w, Sink::Chan(_)) { return Ok(0); }
        let w = self.file()?;
        w.flush()?;
        w.get_mut().sync_data()?;
        w.get_mut().stream_position()
    }

    /// Opens a cache being written (frame count still unknown) to carry on after `frames` frames that end at byte `end`: anything
    /// after them (frames written after the checkpoint) is cut off.
    pub fn reopen(path: &Path, frames: u32, end: u64) -> io::Result<CacheWriter> {
        let mut file = std::fs::OpenOptions::new().read(true).write(true).open(path)?;
        let mut head = [0u8; 12];
        file.read_exact(&mut head)?;
        let ver = u32::from_le_bytes(head[4..8].try_into().unwrap());
        let mut packed = None;
        if ver == 3 {
            // (the frames before it are not looked at: the next frame is a full one)
            let room = u32::from_le_bytes(head[8..12].try_into().unwrap()) as usize;
            let mut j = vec![0u8; room];
            file.read_exact(&mut j)?;
            let meta: Value = serde_json::from_slice(&j).map_err(|e| bad(format!("The cache header is not valid JSON: {e}")))?;
            packed = meta.get("b").and_then(Box3::from_json);
        }
        if &head[..4] != b"SPLC" { return Err(io::Error::new(io::ErrorKind::InvalidData, "not a SPLC cache")); }
        let room = u32::from_le_bytes(head[8..12].try_into().unwrap()) as usize;
        if file.metadata()?.len() < end { return Err(io::Error::new(io::ErrorKind::InvalidData, "the cache is shorter than the checkpoint says")); }
        file.set_len(end)?;
        // the frame count goes back to "until the end of the file" until the bake finishes again
        file.seek(SeekFrom::Start(12 + room as u64))?;
        file.write_all(&u32::MAX.to_le_bytes())?;
        file.seek(SeekFrom::Start(end))?;
        Ok(CacheWriter { w: Sink::File(BufWriter::with_capacity(8 << 20, file)), buf: Vec::new(), room, frames, path: path.to_owned(), packed, hist: Vec::new() })
    }

    pub fn append(&mut self, f: &FrameOut) -> io::Result<()> {
        let mut w = std::mem::take(&mut self.buf);
        w.clear();
        match self.packed {
            None => frame_bytes(&mut w, f)?,
            Some(b0) => {
                if self.frames % crate::packed::KEY_EVERY == 0 { self.hist.clear(); }
                let prev: Vec<crate::packed::Prev> = self.hist.iter().map(|k| crate::packed::Prev { n: k.n, q: k.q, bx: k.bx, pos: &k.pos, sf: &k.sf }).collect();
                w = crate::packed::encode(f, b0, &prev)?;
                drop(prev);
                self.hist.insert(0, Kept { n: f.n as usize, q: f.q, bx: f.own_box.unwrap_or(b0), pos: f.pos.to_vec(), sf: f.spd.to_vec() });
                self.hist.truncate(2);
            }
        }
        match &mut self.w {
            Sink::File(file) => file.write_all(&w)?,
            Sink::Chan(tx) => { tx.send(w.clone()).map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "nobody takes the frames"))?; }
        }
        self.buf = w;
        self.frames += 1;
        Ok(())
    }

    /// Writes the final header (JSON with the bake's measurements) and the frame count. If the JSON outgrew its room, the file
    /// is rewritten once with a bigger header.
    pub fn finish(self, meta: &Value) -> io::Result<()> {
        let Sink::File(mut fw) = self.w else { return Ok(()); };
        fw.flush()?;
        let mj = serde_json::to_vec(meta)?;
        let mut file = fw.into_inner().map_err(|e| e.into_error())?;
        if mj.len() <= self.room {
            file.seek(SeekFrom::Start(12))?;
            file.write_all(&mj)?;
            file.write_all(&vec![b' '; self.room - mj.len()])?;
            file.write_all(&self.frames.to_le_bytes())?;
            return file.sync_all();
        }
        drop(file);
        let tmp = self.path.with_extension("splc.tmp");
        {
            let src = File::open(&self.path)?;
            // SAFETY: read-only mapping of the file written above.
            let map = unsafe { memmap2::Mmap::map(&src)? };
            let body = &map[12 + self.room + 4..];
            let mut out = BufWriter::with_capacity(8 << 20, File::create(&tmp)?);
            out.write_all(b"SPLC")?;
            out.write_all(&(if self.packed.is_some() { 3u32 } else { 2 }).to_le_bytes())?;
            out.write_all(&(mj.len() as u32).to_le_bytes())?;
            out.write_all(&mj)?;
            out.write_all(&[0u8; 4][..pad4(mj.len())])?;
            out.write_all(&self.frames.to_le_bytes())?;
            out.write_all(body)?;
            out.flush()?;
        }
        std::fs::rename(&tmp, &self.path)
    }
}

/// A frame's bytes in the version 2 layout.
pub(crate) fn frame_bytes(w: &mut Vec<u8>, f: &FrameOut) -> io::Result<()> {
    let zero = [0u8; 4];
    let n = f.n as usize;
    let ww = f.ww.filter(|s| s.0 > 0);
    let deep = f.deep.filter(|s| s.0 > 0);
    let fl = |c: bool, v: u32| if c { v } else { 0 };
    let objs: Vec<u8> = f.objs.iter().flat_map(|v| v.to_le_bytes()).collect();
    if f.q.is_some() {
        assert_eq!(f.pos.len(), n * 4); assert_eq!(f.spd.len(), n * 2);
        let flags = FLAG_COMPACT | fl(ww.is_some(), FLAG_WW) | fl(deep.is_some(), FLAG_DEEP) | fl(f.ww_baked, FLAG_WW_BAKED) | fl(f.own_box.is_some(), FLAG_OWN_BOX);
        w.write_all(&f.n.to_le_bytes())?; w.write_all(&flags.to_le_bytes())?;
        if let Some(b) = f.own_box {
            for v in [b.x0, b.y0, b.z0, b.x1, b.y1, b.z1] { w.write_all(&v.to_le_bytes())?; }
            let q = f.q.unwrap();
            w.write_all(&[q[0], q[1], q[2], 0])?;
        }
        w.write_all(&objs)?; w.write_all(f.pos)?; w.write_all(f.spd)?; w.write_all(&zero[..pad4(n * 2)])?;
        if let Some((ns, pos, pk)) = ww {
            w.write_all(&ns.to_le_bytes())?; w.write_all(pos)?;
            for c in pk { w.write_all(&c.to_le_bytes())?; }
        }
        if let Some((nd, pos, sf)) = deep {
            w.write_all(&nd.to_le_bytes())?; w.write_all(pos)?; w.write_all(sf)?; w.write_all(&zero[..pad4(nd as usize * 2)])?;
        }
    } else {
        assert_eq!(f.pos.len(), n * 6); assert_eq!(f.spd.len(), n);
        let flags = fl(f.fm.is_some(), FLAG_LEVELS) | fl(ww.is_some(), FLAG_WW) | fl(deep.is_some(), FLAG_DEEP) | fl(f.ww_baked, FLAG_WW_BAKED);
        w.write_all(&f.n.to_le_bytes())?; w.write_all(&flags.to_le_bytes())?;
        w.write_all(&objs)?; w.write_all(f.pos)?; w.write_all(f.spd)?;
        let mut bytes = n * 7;
        if let Some(fm) = f.fm { w.write_all(fm)?; bytes += n; }
        w.write_all(&zero[..pad4(bytes)])?;
        if let Some((ns, pos, pk)) = ww {
            w.write_all(&ns.to_le_bytes())?; w.write_all(pos)?; w.write_all(&zero[..pad4(ns as usize * 6)])?;
            for c in pk { w.write_all(&c.to_le_bytes())?; }
        }
        if let Some((nd, pos, spd)) = deep {
            w.write_all(&nd.to_le_bytes())?; w.write_all(pos)?; w.write_all(spd)?; w.write_all(&zero[..pad4(nd as usize * 7)])?;
        }
    }
    Ok(())
}

/// Copies a cache, frame by frame, to version 3, or to version 2 for the web page. Whitewater and deep points may change order.
pub fn convert(c: &Cache, out: &Path, v2: bool, mut progress: impl FnMut(usize, usize)) -> io::Result<()> {
    let room = c.info.meta.to_string().len() + 4096;
    let mut w = if v2 { CacheWriter::create_v2(out, &c.info.meta, room)? } else { CacheWriter::create(out, &c.info.meta, room)? };
    for f in 0..c.frames.len() {
        let v = c.view(f);
        let fr = &v.fr;
        let objs = c.objs(f);
        let pk: Option<Vec<u32>> = fr.ww.as_ref().map(|s| v.slice(&s.pk).chunks_exact(4).map(|x| u32::from_le_bytes(x.try_into().unwrap())).collect());
        w.append(&FrameOut { q: fr.q, own_box: fr.own_box, ww_baked: fr.flags & FLAG_WW_BAKED != 0, objs: &objs, n: fr.water.n, pos: v.slice(&fr.water.pos), spd: v.slice(&fr.water.spd),
            fm: fr.water.fm.as_ref().map(|r| v.slice(r)), ww: fr.ww.as_ref().map(|s| (s.n, v.slice(&s.pos), &pk.as_ref().unwrap()[..])),
            deep: fr.deep.as_ref().map(|d| (d.n, v.slice(&d.pos), v.slice(&d.spd))) })?;
        progress(f, c.frames.len());
    }
    w.finish(&c.info.meta)
}
