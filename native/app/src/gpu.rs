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
/// frame may be fractional: the water is then blended between the two frames around it, as while playing.
pub fn picture(files: &[PathBuf], out: &Path, frame: f64, size: [u32; 2]) -> Result<(), String> {
    let mut doc = Doc::default();
    for f in files { eprintln!("{}", crate::open_into(&mut doc, f)?); }
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor { backends: splash_sim::gpu::preferred_backends(), ..wgpu::InstanceDescriptor::new_without_display_handle() });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, ..Default::default() }))
        .map_err(|e| format!("No GPU adapter: {e}"))?;
    let (device, queue) = pollster::block_on(adapter.request_device(&device_descriptor(&adapter))).map_err(|e| format!("No GPU device: {e}"))?;
    eprintln!("{}", describe(&adapter, &device));
    let tex = |format, usage| device.create_texture(&wgpu::TextureDescriptor { label: None, size: wgpu::Extent3d { width: size[0], height: size[1], depth_or_array_layers: 1 },
        mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format, usage, view_formats: &[] });
    let color = tex(render::COLOR, wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC);
    let mut r = Renderer::new(&device);
    let cam = doc.tank().map(|b| Orbit::frame(&b)).ok_or("Nothing to draw: open a cache or a scene.")?;
    let frame = doc.cache.as_ref().map(|c| frame.clamp(0.0, c.frames.len().saturating_sub(1) as f64)).unwrap_or(0.0);
    let t0 = std::time::Instant::now();
    let mut enc = device.create_command_encoder(&Default::default());
    r.draw(&device, &queue, &mut enc, &color.create_view(&Default::default()), size, &cam, &doc, frame.floor() as usize, frame.ceil() as usize, frame.fract() as f32, &Look::default());
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

/// Plays a cache through without a window, as the window does while playing (each frame blended halfway towards the next), with a
/// budget of video memory for the frames kept, and times every frame from start to finish on the GPU: how playback holds up when a
/// bake is bigger than the budget and frames have to come from the disk.
pub fn playback_test(file: &Path, budget_mb: u64, size: [u32; 2], loops: u32) -> Result<(), String> {
    let mut doc = Doc::default();
    eprintln!("{}", crate::open_into(&mut doc, file)?);
    let n = doc.cache.as_ref().map(|c| c.frames.len()).ok_or("That is not a cache.")?;
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor { backends: splash_sim::gpu::preferred_backends(), ..wgpu::InstanceDescriptor::new_without_display_handle() });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, ..Default::default() }))
        .map_err(|e| format!("No GPU adapter: {e}"))?;
    let (device, queue) = pollster::block_on(adapter.request_device(&device_descriptor(&adapter))).map_err(|e| format!("No GPU device: {e}"))?;
    let color = device.create_texture(&wgpu::TextureDescriptor { label: None, size: wgpu::Extent3d { width: size[0], height: size[1], depth_or_array_layers: 1 },
        mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: render::COLOR, usage: wgpu::TextureUsages::RENDER_ATTACHMENT, view_formats: &[] });
    let view = color.create_view(&Default::default());
    let mut r = Renderer::new(&device);
    r.budget = budget_mb << 20;
    let cam = doc.tank().map(|b| Orbit::frame(&b)).ok_or("Nothing to draw.")?;
    let file_mb = doc.cache.as_ref().map(|c| c.bytes().len() >> 20).unwrap_or(0);
    for lp in 0..loops {
        let mut ms = Vec::new();
        let up0 = r.uploads;
        let t0 = std::time::Instant::now();
        for f in 0..n {
            let t = std::time::Instant::now();
            let mut enc = device.create_command_encoder(&Default::default());
            r.draw(&device, &queue, &mut enc, &view, size, &cam, &doc, f, (f + 1) % n, 0.5, &Look::default());
            queue.submit([enc.finish()]);
            device.poll(wgpu::PollType::wait_indefinitely()).map_err(|e| e.to_string())?;
            ms.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        let all = t0.elapsed().as_secs_f64();
        let mut s = ms.clone();
        s.sort_by(|a, b| a.total_cmp(b));
        eprintln!("loop {}: {} frames in {:.1} s ({:.1} a second); a frame {:.0} ms median, {:.0} slowest; {} uploads; {} MB kept of a {} MB budget, file {} MB",
            lp + 1, n, all, n as f64 / all, s[s.len() / 2], s[s.len() - 1], r.uploads - up0, r.kept_bytes >> 20, budget_mb, file_mb);
    }
    Ok(())
}
