//! The GPU device (all the limits the card offers) and the FLIP pipelines: every kernel of the solver's shader, compiled once.
//! The shader is the files in sim/shaders/, joined (WGSL does not care about declaration order). Which bindings each kernel uses is
//! read from the shader by naga (the same analysis wgpu uses to lay out a pipeline), so there is no table to keep in step.

use std::collections::HashMap;

/// The solver's shader, by area (subgroups.wgsl only when the card offers subgroups).
pub const SHADER_PARTS: [(&str, &str); 7] = [
    ("core", include_str!("../shaders/core.wgsl")),
    ("blocks", include_str!("../shaders/blocks.wgsl")),
    ("solver", include_str!("../shaders/solver.wgsl")),
    ("whitewater", include_str!("../shaders/whitewater.wgsl")),
    ("narrowband", include_str!("../shaders/narrowband.wgsl")),
    ("multigrid", include_str!("../shaders/multigrid.wgsl")),
    ("tall", include_str!("../shaders/tall.wgsl")),
];
pub const SUBGROUPS_WGSL: &str = include_str!("../shaders/subgroups.wgsl");
/// Size of the uniform block Params (core.wgsl); checked against the shader in the tests.
pub const PARAMS_BYTES: u64 = 1792;

/// The shader text for this device.
pub fn flip_source(sg: bool) -> String {
    // git on Windows may check the files out with CRLF line ends
    let mut s: String = SHADER_PARTS.iter().map(|(_, t)| t.replace("\r\n", "\n")).collect::<Vec<_>>().join("\n");
    if sg { s.push('\n'); s += &SUBGROUPS_WGSL.replace("\r\n", "\n"); }
    s
}

/// Each kernel's bindings (number, and whether it is a storage buffer), from naga's analysis of the shader.
pub fn kernel_bindings(src: &str) -> Result<HashMap<String, Vec<(u32, bool)>>, String> {
    let module = naga::front::wgsl::parse_str(src).map_err(|e| e.emit_to_string(src))?;
    let info = naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::all())
        .validate(&module).map_err(|e| e.emit_to_string(src))?;
    Ok(module.entry_points.iter().enumerate().map(|(i, ep)| {
        let fi = info.get_entry_point(i);
        let mut b: Vec<(u32, bool)> = module.global_variables.iter()
            .filter(|(h, _)| !fi[*h].is_empty())
            .filter_map(|(_, g)| g.binding.as_ref().map(|rb| (rb.binding, matches!(g.space, naga::AddressSpace::Storage { .. }))))
            .collect();
        b.sort();
        (ep.name.clone(), b)
    }).collect())
}

pub struct Pipe {
    pub pipeline: wgpu::ComputePipeline,
    pub layout: wgpu::BindGroupLayout,
    /// the binding numbers this kernel uses
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

/// The graphics API to use: Vulkan where the card offers it (about 3 times faster than DirectX 12 on Mer's card), else wgpu's choice;
/// SPLASH_BACKEND=dx12 or vulkan forces one.
pub fn preferred_backends() -> wgpu::Backends {
    match std::env::var("SPLASH_BACKEND").unwrap_or_default().to_ascii_lowercase().as_str() {
        "dx12" => return wgpu::Backends::DX12, "vulkan" => return wgpu::Backends::VULKAN, _ => {}
    }
    let vk = wgpu::Instance::new(wgpu::InstanceDescriptor { backends: wgpu::Backends::VULKAN, ..wgpu::InstanceDescriptor::new_without_display_handle() });
    if pollster::block_on(vk.enumerate_adapters(wgpu::Backends::VULKAN)).is_empty() { wgpu::Backends::PRIMARY } else { wgpu::Backends::VULKAN }
}

impl Gpu {
    /// The fastest adapter, with every limit and the optional features the solver can use (subgroups, timestamps).
    pub fn new() -> Result<Gpu, String> {
        // SPLASH_BACKEND=dx12 or vulkan picks the graphics API (to compare them); otherwise wgpu's choice
        // Vulkan: on Mer's RTX 3060 Ti the benchmark set ran about 3 times faster than on DirectX 12 (2026-10-29). DirectX 12 only when
        // there is no Vulkan; SPLASH_BACKEND=dx12 or vulkan forces one (to compare them).
        let forced = match std::env::var("SPLASH_BACKEND").unwrap_or_default().to_ascii_lowercase().as_str() {
            "dx12" => Some(wgpu::Backends::DX12), "vulkan" => Some(wgpu::Backends::VULKAN), _ => None };
        // DirectX 12's old shader compiler (FXC) rejects the grouped-transfer kernels; the newer one (DXC) comes with the Windows SDK
        let dxc = std::env::var("SPLASH_DXC").ok().or_else(|| {
            let p = std::path::Path::new(r"C:\Program Files (x86)\Windows Kits\10\bin");
            std::fs::read_dir(p).ok()?.flatten().map(|e| e.path().join(r"x64\dxcompiler.dll")).filter(|f| f.exists()).max().map(|f| f.display().to_string())
        });
        let adapter_on = |backends: wgpu::Backends| {
            let mut bo = wgpu::BackendOptions::default();
            if let Some(path) = dxc.clone() { bo.dx12.shader_compiler = wgpu::Dx12Compiler::DynamicDxc { dxc_path: path }; }
            let instance = wgpu::Instance::new(wgpu::InstanceDescriptor { backends, backend_options: bo, ..wgpu::InstanceDescriptor::new_without_display_handle() });
            pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, ..Default::default() }))
        };
        let adapter = match forced {
            Some(b) => adapter_on(b),
            None => adapter_on(wgpu::Backends::VULKAN).or_else(|_| adapter_on(wgpu::Backends::PRIMARY)),
        }.map_err(|e| format!("No GPU: {e}"))?;
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
        let storage_max = device.limits().max_storage_buffers_per_shader_stage;
        let src = flip_source(sg);
        let kernels = kernel_bindings(&src).map_err(|e| format!("The FLIP shader did not compile: {e}"))?;
        let guard = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("flip"), source: wgpu::ShaderSource::Wgsl(src.into()) });
        let mut pipes = HashMap::new();
        for (name, b) in kernels {
            // kernels needing more storage buffers than the device has are left out (g2pAo needs 9)
            if b.iter().filter(|x| x.1).count() as u32 > storage_max { continue; }
            let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor { label: Some(&name), layout: None, module: &module,
                entry_point: Some(&name), compilation_options: Default::default(), cache: None });
            let layout = pipeline.get_bind_group_layout(0);
            pipes.insert(name, Pipe { pipeline, layout, bindings: b.iter().map(|x| x.0).collect() });
        }
        if let Some(e) = pollster::block_on(guard.pop()) { return Err(format!("The FLIP shader did not compile: {e}")); }
        Ok(Gpu { adapter, device, queue, pipes, sg, params_bytes: PARAMS_BYTES, compile_ms: t0.elapsed().as_secs_f64() * 1000.0 })
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

    /// PARAMS_BYTES is the size of the shader's Params block (flip.rs writes it word by word).
    #[test]
    fn params_size() {
        let src = super::flip_source(false);
        let m = naga::front::wgsl::parse_str(&src).unwrap();
        let mut lay = naga::proc::Layouter::default();
        lay.update(m.to_ctx()).unwrap();
        let (h, _) = m.types.iter().find(|(_, t)| t.name.as_deref() == Some("Params")).expect("no Params struct");
        assert_eq!(lay[h].size as u64, super::PARAMS_BYTES);
    }
}

