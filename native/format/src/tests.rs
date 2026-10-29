use super::cache::*;
use serde_json::json;
use std::path::PathBuf;

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join("splash-format-tests");
    std::fs::create_dir_all(&d).unwrap();
    d.join(name)
}

fn b() -> Box3 { Box3 { x0: -1.5, x1: 1.5, y0: 0.0, y1: 2.6, z0: -1.5, z1: 1.5 } }

/// Writes a small cache with one frame in each layout: compact with its own box, whitewater and deep water; 16-bit with levels.
pub(crate) fn write_sample(path: &std::path::Path, reserve: usize, meta_extra: usize) -> Vec<([f32; 3], u8, u8)> {
    let meta = json!({ "d": 0.05, "fps": 24, "ids": [7], "b": b().to_json(), "org": { "x": 0.5, "y": 0.1, "z": 0 }, "scale": 2, "spdMs": true, "q": null, "sb": null, "stableIds": true });
    let mut w = CacheWriter::create(path, &meta, reserve).unwrap();
    let q = [11u8, 10, 11];
    let own = Box3 { x0: -1.0, x1: 1.0, y0: 0.0, y1: 0.5, z0: -1.0, z1: 1.0 };
    // compact: three points, one gone, one buried
    let pts = [(5u32, 7u32, 9u32, 40u16 | 3 << 8), (2047, 1023, 2047, 255), (1000, 500, 1000, 16 | BURIED)];
    let pos: Vec<u8> = pts.iter().flat_map(|p| (p.0 | p.1 << 11 | p.2 << 21).to_le_bytes()).collect();
    let sf: Vec<u8> = pts.iter().flat_map(|p| p.3.to_le_bytes()).collect();
    let dpos: Vec<u8> = (1u32 | 2 << 11 | 3 << 21).to_le_bytes().to_vec();
    let dsf: Vec<u8> = 12u16.to_le_bytes().to_vec();
    w.append(&FrameOut { q: Some(q), own_box: Some(own), ww_baked: false, objs: &[1.0, 2.0, 3.0, 0.1, 0.2, 0.3], n: 3, pos: &pos, spd: &sf, fm: None,
        ww: Some((1, &(4u32 | 4 << 11 | 4 << 21).to_le_bytes(), &[0x8000_1234])), deep: Some((1, &dpos, &dsf)) }).unwrap();
    // 16-bit: two points with levels
    let p16: Vec<u8> = [0u16, 0, 0, 65535, 32768, 65535].iter().flat_map(|v| v.to_le_bytes()).collect();
    w.append(&FrameOut { q: None, own_box: None, ww_baked: true, objs: &[4.0, 5.0, 6.0, 0.0, 0.0, 0.0], n: 2, pos: &p16, spd: &[10, 20], fm: Some(&[0, 255]),
        ww: Some((1, &[1, 0, 2, 0, 3, 0], &[0x8000_0001])), deep: None }).unwrap();
    let mut fin = meta.clone();
    fin["diag"] = json!("x".repeat(meta_extra));
    w.finish(&fin).unwrap();
    let mx = |k: u32, bits: u32| k as f32 / ((1u32 << bits) - 1) as f32;
    vec![
        ([mx(5, 11) * 2.0 - 1.0, mx(7, 10) * 0.5, mx(9, 11) * 2.0 - 1.0], 40, 3),
        ([1.0, 0.5, 1.0], 255, 0),
        ([mx(1000, 11) * 2.0 - 1.0, mx(500, 10) * 0.5, mx(1000, 11) * 2.0 - 1.0], 16, 0),
        ([-1.5, 0.0, -1.5], 10, 0),
        ([1.5, 32768.0 / 65535.0 * 2.6, 1.5], 20, 15),
    ]
}

fn check(path: &std::path::Path, want: &[([f32; 3], u8, u8)]) {
    let c = Cache::open(path).unwrap();
    assert_eq!(c.frames.len(), 2);
    assert!(!c.truncated);
    assert_eq!(c.info.ids, vec![7]);
    assert!(c.info.spd_ms && c.info.stable_ids);
    assert_eq!(c.info.org, [0.5, 0.1, 0.0]);
    let got: Vec<_> = (0..3).map(|i| c.water_point(0, i)).chain((0..2).map(|i| c.water_point(1, i))).collect();
    for (g, w) in got.iter().zip(want) {
        for k in 0..3 { assert!((g.0[k] - w.0[k]).abs() < 1e-5, "{g:?} vs {w:?}"); }
        assert_eq!((g.1, g.2), (w.1, w.2));
    }
    assert_eq!(c.objs(0), vec![1.0, 2.0, 3.0, 0.1, 0.2, 0.3]);
    assert_eq!(c.frames[0].ww.as_ref().unwrap().n, 1);
    assert_eq!(c.frames[0].deep.as_ref().unwrap().n, 1);
    assert!(c.frames[1].flags & FLAG_WW_BAKED != 0);
    assert_eq!(c.frames[1].ww.as_ref().unwrap().n, 1);
}

#[test]
fn round_trip() {
    let p = tmp("round.splc");
    let want = write_sample(&p, 4096, 10);
    check(&p, &want);
}

#[test]
fn header_outgrows_room() {
    let p = tmp("grow.splc");
    let want = write_sample(&p, 16, 5000);
    check(&p, &want);
    let c = Cache::open(&p).unwrap();
    assert_eq!(c.info.meta["diag"].as_str().unwrap().len(), 5000);
}

#[test]
fn cut_short_still_opens() {
    let p = tmp("cut.splc");
    write_sample(&p, 4096, 0);
    let mut bytes = std::fs::read(&p).unwrap();
    // as if the bake had stopped while writing frame 2: count still "until the end", last frame half written
    let ml = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    bytes[12 + ml..16 + ml].copy_from_slice(&u32::MAX.to_le_bytes());
    let len = bytes.len();
    bytes.truncate(len - 10);
    std::fs::write(&p, bytes).unwrap();
    let c = Cache::open(&p).unwrap();
    assert_eq!(c.frames.len(), 1);
    assert!(c.truncated);
}

/// The page's own reader (parseCache in src/shared.js, run in Node) must read what this writer writes, point for point.
#[test]
fn page_reads_native_cache() {
    let p = tmp("page.splc");
    let want = write_sample(&p, 4096, 0);
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tools/read-cache.js");
    let Ok(out) = std::process::Command::new("node").arg(&script).arg(&p).arg("5").output() else {
        eprintln!("node not found, skipped");
        return;
    };
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let text = String::from_utf8(out.stdout).unwrap();
    let pts: Vec<Vec<f64>> = text.lines().filter(|l| l.starts_with("pt ")).map(|l| l[3..].split(' ').map(|v| v.parse().unwrap()).collect()).collect();
    assert_eq!(pts.len(), 5, "{text}");
    for (g, w) in pts.iter().zip(&want) {
        for k in 0..3 { assert!((g[k] as f32 - w.0[k]).abs() < 1e-5, "{g:?} vs {w:?}"); }
        assert_eq!((g[3] as u8, g[4] as u8), (w.1, w.2));
    }
}

/// Mer's big page-made bake, when it is on this computer (or SPLASH_CACHE points at another): every frame indexes and the
/// file ends exactly after the last frame.
#[test]
fn real_cache() {
    let path = std::env::var("SPLASH_CACHE").map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(r"C:\Users\maxme\Downloads\splashtank-bake (1).splc"));
    if !path.exists() { eprintln!("{} not found, skipped", path.display()); return; }
    let c = Cache::open(&path).unwrap();
    assert!(!c.truncated);
    assert!(!c.frames.is_empty());
    let last = c.frames.last().unwrap();
    let end = [Some(last.water.spd.end), last.ww.as_ref().map(|w| w.pk.end), last.deep.as_ref().map(|d| d.spd.end)].into_iter().flatten().max().unwrap();
    assert!(c.bytes().len() - end < 4, "file has {} bytes after the last frame", c.bytes().len() - end);
    eprintln!("{} frames, {} points in frame 0", c.frames.len(), c.frames[0].water.n);
    // the first points of frame 0 decode the same as the page's framePoint
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tools/read-cache.js");
    let Ok(out) = std::process::Command::new("node").arg(&script).arg(&path).arg("200").output() else { return; };
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let text = String::from_utf8(out.stdout).unwrap();
    let pts: Vec<Vec<f64>> = text.lines().filter(|l| l.starts_with("pt ")).map(|l| l[3..].split(' ').map(|v| v.parse().unwrap()).collect()).collect();
    assert_eq!(pts.len(), 200);
    for (i, g) in pts.iter().enumerate() {
        let (p, s, l) = c.water_point(0, i);
        for k in 0..3 { assert!((g[k] as f32 - p[k]).abs() < 1e-4, "point {i}: {g:?} vs {p:?}"); }
        assert_eq!((g[3] as u8, g[4] as u8), (s, l));
    }
}
