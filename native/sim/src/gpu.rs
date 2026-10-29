//! The GPU device (all the limits the card offers) and the FLIP pipelines: every kernel of the page's shader, compiled once
//! (flipPipes in src/flip/sim.js). The shader text and binding table come from native/tools/export-wgsl.js.

use std::collections::HashMap;

pub const FLIP_WGSL: &str = include_str!("../shaders/flip.wgsl");
pub const FLIP_SG_WGSL: &str = include_str!("../shaders/flip_sg.wgsl");
pub const FLIP_LAYOUT: &str = include_str!("../shaders/flip_layout.json");
/// Native only: tall cells for deep narrow-band water (see the file), appended to the page's shader with the patches in TALL_PATCHES.
pub const TALL_WGSL: &str = include_str!("../shaders/tall.wgsl");
/// Where the page's shader is changed for tall cells: below row T a cell is water (the tall cell), its pressure and kept velocity come
/// from the tall cell, its depth is deep and no blocks are marked there. Multigrid is left as it is: a block without storage holds no
/// correction, which is right for the tall cells too, as their pressure is held while a V-cycle runs (treating them as a wall made the
/// coarse correction blow the water apart). Each text must occur exactly once.
const TALL_PATCHES: [(&str, &str); 12] = [
    ("  return ctype[cellIdx(i, j, k)] & 0xffu;", "  if (j < tallT()) { return 1u; }\n  return ctype[cellIdx(i, j, k)] & 0xffu;"),
    ("sum += pres[cellIdx(q.x, q.y, q.z)]; } else { nns += 1.0 / ghostTheta(); }", "sum += presAt(q); } else { nns += 1.0 / ghostTheta(); }"),
    ("  if (tl == 1u) { pl = pres[cellIdx(lo.x, lo.y, lo.z)]; }", "  if (tl == 1u) { pl = presAt(lo); }"),
    ("    s += w * velG[faceIndex(axis, i0.x + dx, i0.y + dy, i0.z + dz)];", "    s += w * velGF(axis, i0 + vec3<i32>(dx, dy, dz));"),
    ("fn phiCell(p: vec3<i32>) -> f32 { if (!inDom(p)) { return 8.0; }", "fn phiCell(p: vec3<i32>) -> f32 { if (!inDom(p)) { return 8.0; } if (p.y < tallT()) { return -7.9; }"),
    ("    let ci = cellIdx(i0.x + dx, i0.y + dy, i0.z + dz);\n    if (colBits(ci) != 0u || w <= 0.0) { continue; }",
     "    if (i0.y + dy < tallT()) { if (w > 0.0) { s += w * -7.9; ws += w; } continue; }\n    let ci = cellIdx(i0.x + dx, i0.y + dy, i0.z + dz);\n    if (colBits(ci) != 0u || w <= 0.0) { continue; }"),
    ("    let cq = cellIdx(n.x, n.y, n.z);", "    if (n.y < tallT()) { m = max(m, -7.9); continue; }\n    let cq = cellIdx(n.x, n.y, n.z);"),
    ("for (var tj = lo.y; tj <= hi.y; tj++)", "for (var tj = max(lo.y, tallT() >> 3u); tj <= hi.y; tj++)"),
    ("  if (fillPhi(vec3<f32>(P.x0, P.y0, P.z0) + tc * P.h) < 9.0) { atomicStore(&need[t], 1u); }",
     "  if (i32(tt % P.ty) * 8 < tallT()) { return; }\n  if (fillPhi(vec3<f32>(P.x0, P.y0, P.z0) + tc * P.h) < 9.0) { atomicStore(&need[t], 1u); }"),
    ("    if ((ctype[cellIdx(lo.x, lo.y, lo.z)] & 0xffu) != 1u) { continue; }", "    if (ctypeOf(lo.x, lo.y, lo.z) != 1u) { continue; }"),
    ("if (hasStorage(cc) && phiOf(cellIdx(cc.x, cc.y, cc.z)) < -P.band) { kill = true; }", "if (cc.y < tallT() || (hasStorage(cc) && phiOf(cellIdx(cc.x, cc.y, cc.z)) < -P.band)) { kill = true; }"),
    ("    let ty = ctypeOf(q.x, q.y, q.z);\n    if (ty == 2u) { continue; }\n    nns += 1.0;\n    if (ty == 1u) { sum += dpres",
     "    if (q.y < tallT()) { continue; }\n    let ty = ctypeOf(q.x, q.y, q.z);\n    if (ty == 2u) { continue; }\n    nns += 1.0;\n    if (ty == 1u) { sum += dpres"),
];

/// The page's shader with the tall cell patches and kernels (the text exported files may have CRLF line ends).
fn with_tall(src: &str) -> String {
    let mut s = src.replace("\r\n", "\n");
    for (a, b) in TALL_PATCHES {
        assert_eq!(s.matches(a).count(), 1, "tall cell patch target not found exactly once: {a}");
        s = s.replacen(a, b, 1);
    }
    s + "\n" + TALL_WGSL
}

/// For every function in the shader, the bindings it uses itself or through what it calls (a plain scan of identifiers; enough for the
/// tall cell kernels and to add binding 43 to the page's kernels that now reach the tall cells).
pub fn binding_use(src: &str) -> HashMap<String, Vec<u32>> {
    let ident = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let uses = |text: &str, name: &str| -> bool {
        let b = text.as_bytes();
        text.match_indices(name).any(|(i, _)| (i == 0 || !ident(b[i - 1] as char)) && b.get(i + name.len()).is_none_or(|&c| !ident(c as char)))
    };
    let mut vars = Vec::new();
    for line in src.lines() {
        let Some(at) = line.find("@binding(") else { continue; };
        let num: u32 = line[at + 9..].split(')').next().and_then(|v| v.trim().parse().ok()).unwrap_or(u32::MAX);
        let Some(v) = line.find(" var") else { continue; };
        let rest = &line[v + 4..];
        let rest = if let Some(e) = rest.find('>') { &rest[e + 1..] } else { rest };
        let name = rest.trim().split(':').next().unwrap_or("").trim().to_string();
        if !name.is_empty() { vars.push((name, num)); }
    }
    // comments name things too (a comment saying "air" is not a use of the air field)
    let code: String = src.lines().map(|l| l.split("//").next().unwrap_or("")).collect::<Vec<_>>().join("\n");
    let mut fns: Vec<(String, &str)> = Vec::new();
    let parts: Vec<&str> = code.split("\nfn ").collect();
    for p in &parts[1..] {
        let name = p.split('(').next().unwrap_or("").trim().to_string();
        // the function ends where its braces close (what follows is declarations and comments, not its body)
        let (mut depth, mut end) = (0i32, p.len());
        if let Some(open) = p.find('{') {
            for (i, ch) in p[open..].char_indices() {
                if ch == '{' { depth += 1; } else if ch == '}' { depth -= 1; if depth == 0 { end = open + i + 1; break; } }
            }
        }
        fns.push((name, &p[..end]));
    }
    let names: Vec<String> = fns.iter().map(|f| f.0.clone()).collect();
    let mut set: HashMap<String, std::collections::BTreeSet<u32>> = fns.iter().map(|(n, body)| {
        let body = &body[n.len()..];
        (n.clone(), vars.iter().filter(|(v, _)| uses(body, v)).map(|(_, b)| *b).collect())
    }).collect();
    let calls: HashMap<String, Vec<String>> = fns.iter().map(|(n, body)| {
        let body = &body[n.len()..];
        (n.clone(), names.iter().filter(|m| *m != n && uses(body, m) && body.contains(&format!("{m}("))).cloned().collect())
    }).collect();
    loop {
        let mut more = false;
        for n in &names {
            let add: Vec<u32> = calls[n].iter().flat_map(|m| set[m].iter().copied().collect::<Vec<_>>()).collect();
            let s = set.get_mut(n).unwrap();
            for b in add { more |= s.insert(b); }
        }
        if !more { break; }
    }
    set.into_iter().map(|(n, s)| (n, s.into_iter().collect())).collect()
}

/// The shader text for this device. Naga takes subgroup functions with the SUBGROUP feature but rejects WGSL's `enable subgroups;`
/// and has no subgroupElect: the first active lane is the one whose lane number the subgroup broadcasts (both SG kernels have `lane`).
pub fn flip_source(sg: bool) -> String {
    if !sg { return with_tall(FLIP_WGSL); }
    with_tall(&FLIP_SG_WGSL.replacen("enable subgroups;", "", 1).replace("subgroupElect()", "(lane == subgroupBroadcastFirst(lane))"))
}
/// The tall cell kernels (not in the page's binding table: their bindings come from binding_use).
pub const TALL_KERNELS: [&str; 8] = ["tallStep", "tallFill", "tallDiv", "tallRed", "tallBlack", "tallProj", "tallCheck", "tallPick"];

pub struct Pipe {
    pub pipeline: wgpu::ComputePipeline,
    pub layout: wgpu::BindGroupLayout,
    /// the binding numbers this kernel uses (FLIP_L)
    pub bindings: Vec<u32>,
}

pub struct Gpu {
    pub adapter: wgpu::Adapter,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub pipes: HashMap<String, Pipe>,
    pub sg: bool,
    pub params_bytes: u64,
    pub compile_ms: f64,
}

impl Gpu {
    /// The fastest adapter, with every limit and the optional features the solver can use (subgroups, timestamps).
    pub fn new() -> Result<Gpu, String> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor { backends: wgpu::Backends::PRIMARY, ..wgpu::InstanceDescriptor::new_without_display_handle() });
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, ..Default::default() }))
            .map_err(|e| format!("No GPU: {e}"))?;
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("splash-sim"),
            required_features: adapter.features() & (wgpu::Features::TIMESTAMP_QUERY | wgpu::Features::TIMESTAMP_QUERY_INSIDE_PASSES | wgpu::Features::SUBGROUP),
            required_limits: adapter.limits(),
            ..Default::default()
        })).map_err(|e| format!("No GPU device: {e}"))?;
        Gpu::with_device(adapter, device, queue)
    }

    pub fn with_device(adapter: wgpu::Adapter, device: wgpu::Device, queue: wgpu::Queue) -> Result<Gpu, String> {
        let t0 = std::time::Instant::now();
        let sg = device.features().contains(wgpu::Features::SUBGROUP);
        let layout: serde_json::Value = serde_json::from_str(FLIP_LAYOUT).map_err(|e| e.to_string())?;
        let storage_max = device.limits().max_storage_buffers_per_shader_stage;
        let guard = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let src = flip_source(sg);
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("flip"), source: wgpu::ShaderSource::Wgsl(src.clone().into()) });
        let used = binding_use(&src);
        let mut pipes = HashMap::new();
        let mut list: Vec<(String, Vec<u32>)> = layout["bindings"].as_object().ok_or("bad layout")?.iter()
            .map(|(n, b)| (n.clone(), b.as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u32).collect())).collect();
        for k in TALL_KERNELS { list.push((k.to_string(), used.get(k).cloned().unwrap_or_default())); }
        for (name, mut bindings) in list {
            let name = &name;
            if !sg && name.ends_with("SG") { continue; }
            // the page's kernels that now reach the tall cells (through ctypeOf, presAt, velGF...) bind them too
            if used.get(name).is_some_and(|u| u.contains(&43)) && !bindings.contains(&43) { bindings.push(43); }
            // kernels needing more storage buffers than the device has are left out (flipStorage); 0 and 38 are uniform blocks
            if bindings.iter().filter(|&&k| k != 0 && k != 38).count() as u32 > storage_max { continue; }
            let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor { label: Some(name), layout: None, module: &module,
                entry_point: Some(name), compilation_options: Default::default(), cache: None });
            let layout = pipeline.get_bind_group_layout(0);
            pipes.insert(name.clone(), Pipe { pipeline, layout, bindings });
        }
        if let Some(e) = pollster::block_on(guard.pop()) { return Err(format!("The FLIP shader did not compile: {e}")); }
        Ok(Gpu { adapter, device, queue, pipes, sg, params_bytes: layout["paramsBytes"].as_u64().unwrap_or(1792), compile_ms: t0.elapsed().as_secs_f64() * 1000.0 })
    }

    pub fn describe(&self) -> String {
        let i = self.adapter.get_info();
        let l = self.device.limits();
        format!("{} ({:?}), storage binding {} MB, {} kernels{}", i.name, i.backend, l.max_storage_buffer_binding_size >> 20, self.pipes.len(), if self.sg { ", subgroups" } else { "" })
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn compile_all() {
        let g = super::Gpu::new().unwrap();
        eprintln!("{} in {:.0} ms", g.describe(), g.compile_ms);
        assert!(g.pipes.len() >= 100);
        assert!(g.pipes.contains_key("g2pAo"), "the APIC kernel with the old grid velocity needs 9 storage buffers");
    }
}
