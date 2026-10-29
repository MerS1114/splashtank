//! GPU setup shared by the window and the headless mode: every limit the adapter offers, not the WebGPU defaults the page gets.

use crate::render::{self, Doc, Look, Orbit, Renderer};
use eframe::wgpu;
use std::path::{Path, PathBuf};

/// The adapter's own limits, so big caches (and later big sims) can use buffers as large as the card allows.
pub fn device_descriptor(adapter: &wgpu::Adapter) -> wgpu::DeviceDescriptor<'static> {
    wgpu::DeviceDescriptor {
        label: Some("splashtank"),
        required_features: adapter.features() & (wgpu::Features::TIMESTAMP_QUERY | wgpu::Features::SUBGROUP),
        required_limits: adapter.limits(),
        ..Default::default()
    }
}

/// One line about the GPU for the info panel.
pub fn describe(adapter: &wgpu::Adapter, device: &wgpu::Device) -> String {
    let i = adapter.get_info();
    let l = device.limits();
    format!("{} ({:?}), largest buffer {} MB, storage binding {} MB, {} storage buffers a stage",
        i.name, i.backend, l.max_buffer_size >> 20, l.max_storage_buffer_binding_size >> 20, l.max_storage_buffers_per_shader_stage)
}

/// Draws one frame of the given files into a PNG, without a window (for checking and tests).
pub fn picture(files: &[PathBuf], out: &Path, frame: usize, size: [u32; 2]) -> Result<(), String> {
    let mut doc = Doc::default();
    for f in files { eprintln!("{}", crate::open_into(&mut doc, f)?); }
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor { backends: wgpu::Backends::PRIMARY, ..wgpu::InstanceDescriptor::new_without_display_handle() });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, ..Default::default() }))
        .map_err(|e| format!("No GPU adapter: {e}"))?;
    let (device, queue) = pollster::block_on(adapter.request_device(&device_descriptor(&adapter))).map_err(|e| format!("No GPU device: {e}"))?;
    eprintln!("{}", describe(&adapter, &device));
    let tex = |format, usage| device.create_texture(&wgpu::TextureDescriptor { label: None, size: wgpu::Extent3d { width: size[0], height: size[1], depth_or_array_layers: 1 },
        mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format, usage, view_formats: &[] });
    let color = tex(render::COLOR, wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC);
    let depth = tex(render::DEPTH, wgpu::TextureUsages::RENDER_ATTACHMENT);
    let mut r = Renderer::new(&device);
    let cam = doc.tank().map(|b| Orbit::frame(&b)).ok_or("Nothing to draw: open a cache or a scene.")?;
    let frame = doc.cache.as_ref().map(|c| frame.min(c.frames.len().saturating_sub(1))).unwrap_or(0);
    let t0 = std::time::Instant::now();
    let mut enc = device.create_command_encoder(&Default::default());
    r.draw(&device, &queue, &mut enc, &color.create_view(&Default::default()), &depth.create_view(&Default::default()), size, &cam, &doc, frame, &Look::default());
    let row = (size[0] * 4).div_ceil(256) * 256;
    let buf = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: (row * size[1]) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    enc.copy_texture_to_buffer(color.as_image_copy(), wgpu::TexelCopyBufferInfo { buffer: &buf, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: None } },
        wgpu::Extent3d { width: size[0], height: size[1], depth_or_array_layers: 1 });
    queue.submit([enc.finish()]);
    buf.slice(..).map_async(wgpu::MapMode::Read, |_| {});
    device.poll(wgpu::PollType::wait_indefinitely()).map_err(|e| e.to_string())?;
    eprintln!("frame {frame} uploaded and drawn in {:.0} ms ({} MB on the GPU)", t0.elapsed().as_secs_f64() * 1000.0, r.kept_bytes >> 20);
    let data = buf.slice(..).get_mapped_range().map_err(|e| e.to_string())?;
    let mut px = Vec::with_capacity((size[0] * size[1] * 4) as usize);
    for y in 0..size[1] { px.extend_from_slice(&data[(y * row) as usize..(y * row + size[0] * 4) as usize]); }
    let file = std::fs::File::create(out).map_err(|e| e.to_string())?;
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), size[0], size[1]);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().and_then(|mut w| w.write_image_data(&px)).map_err(|e| e.to_string())?;
    eprintln!("wrote {}", out.display());
    Ok(())
}
