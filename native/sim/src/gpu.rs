//! The GPU device (all the limits the card offers) and the FLIP pipelines: every kernel of the page's shader, compiled once
//! (flipPipes in src/flip/sim.js). The shader text and binding table come from native/tools/export-wgsl.js.

use std::collections::HashMap;

pub const FLIP_WGSL: &str = include_str!("../shaders/flip.wgsl");
pub const FLIP_SG_WGSL: &str = include_str!("../shaders/flip_sg.wgsl");
pub const FLIP_LAYOUT: &str = include_str!("../shaders/flip_layout.json");

/// The shader text for this device. Naga takes subgroup functions with the SUBGROUP feature but rejects WGSL's `enable subgroups;`
/// and has no subgroupElect: the first active lane is the one whose lane number the subgroup broadcasts (both SG kernels have `lane`).
pub fn flip_source(sg: bool) -> String {
    if !sg { return FLIP_WGSL.to_owned(); }
    FLIP_SG_WGSL.replacen("enable subgroups;", "", 1).replace("subgroupElect()", "(lane == subgroupBroadcastFirst(lane))")
}

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
            required_features: adapter.features() & (wgpu::Features::TIMESTAMP_QUERY | wgpu::Features::SUBGROUP),
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
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("flip"), source: wgpu::ShaderSource::Wgsl(flip_source(sg).into()) });
        let mut pipes = HashMap::new();
        for (name, b) in layout["bindings"].as_object().ok_or("bad layout")? {
            if !sg && name.ends_with("SG") { continue; }
            let bindings: Vec<u32> = b.as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u32).collect();
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
