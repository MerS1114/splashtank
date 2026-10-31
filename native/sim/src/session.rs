//! A simulation run: the solver set up from a scene's description, its starting water, and stepping one frame at a time (substeps,
//! dropped water, how fast the water got, the pressure iterations of Accurate). Bakes, live water and the accuracy tests all drive this.

use crate::bake::{estimate_bytes, free_vram_mb, tall_row};
use crate::flip::{layout, FlipSim, Layout, Rng, StepPar};
use crate::gpu::Gpu;
use crate::nb;
use crate::runner::Runner;
use crate::scene::{obj_speed, sample, Desc, Event, Fill, Obj};
use serde_json::{json, Value};

/// Pressure left unsolved that Accurate aims under (share of the starting imbalance).
pub const ACC_TOL: f32 = 0.001;

pub struct Session<'d> {
    pub desc: &'d Desc,
    pub lay: Layout,
    pub sim: FlipSim,
    pub runner: Runner,
    pub rng: Rng,
    /// Max points this run uses (raised for a narrow band's starting water) and what the starting water needs
    pub max_n: u32,
    pub need: u64,
    /// narrow band depth (cells), and the ocean's waves
    pub nb_band: Option<f32>,
    pub ocean_w: Vec<f32>,
    /// pressure iterations now (Accurate steers them), fastest water last frame, next dropped water, next frame to make
    pub iters: u32,
    pub vmax: f32,
    pub ei: usize,
    pub f: u32,
    ev: Vec<Event>,
    cfl: f32,
    max_sub: u32,
}

impl<'d> Session<'d> {
    /// The solver for desc. say: remarks (Max points chosen, tall cells). resumed: Max points and the start's needs from a checkpoint.
    pub fn new(gpu: &Gpu, desc: &'d Desc, say: &dyn Fn(&str), resumed: Option<(u32, u64)>) -> Result<Session<'d>, String> {
        let lay = layout(desc.d, desc.cell_ratio, desc.size);
        let lim = (gpu.device.limits().max_storage_buffer_binding_size as u64 / if desc.apic { 48 } else { 16 }) as u32;
        let mut max_n = desc.max_n.min(lim);
        // narrow band: the starting band must fit, or the seed stops partway across the tank and the water there drains away
        let nb_band = if desc.nb.is_some() || desc.ocean.is_some() { Some(desc.nb.unwrap_or(3.0)) } else { None };
        let ocean_w = desc.ocean.map(|oc| nb::waves(&oc, desc.g as f64, oc.level - lay.b.y0 as f64)).unwrap_or_default();
        let oc = desc.ocean.as_ref().map(|c| (c, &ocean_w[..]));
        let mut need = 0u64;
        let free = free_vram_mb();
        // sorting keeps a second copy of the particles; when that does not fit the card, the bake goes without sorting (slower, same water)
        let mut sort = desc.sort;
        let fits = |n: u64, s: bool| free.is_none_or(|mb| estimate_bytes(n, desc.apic, desc.cell_ratio, desc.spray_cap as u64, s) <= mb << 20);
        if let Some((m, nd)) = resumed {
            max_n = m;
            need = nd;
        } else if let Some(band) = nb_band {
            let s = nb::seed(&lay, &desc.fills, band, oc, 0.0, &mut |_, _| true);
            need = s.seeded + nb::spares(s.seeded);
            if need > lim as u64 { return Err(format!("The starting water needs {:.1}M points, more than one GPU buffer holds here ({:.1}M). Use less detail, a coarser spacing or a thinner narrow band.", need as f64 / 1e6, lim as f64 / 1e6)); }
            // Max points for the band to refill from: the band asks for about twice the starting water after an impact (on Mer's ocean
            // at 0.012, 10.5 to 12M against 6.2M at the start), and when it runs out the refill goes where the GPU happens to list cells
            // first. So, unless Max points was given, 2.5 times the start, as far as the card's free memory and one buffer allow.
            if !desc.max_n_set {
                let mut want = (need as f64 * 2.5).ceil() as u64;
                let least = (need as f64 * 1.3).ceil() as u64;
                if sort && !fits(least, true) && fits(least, false) { sort = false; }
                if let Some(mb) = free {
                    let per = (estimate_bytes(1 << 20, desc.apic, desc.cell_ratio, 0, sort) - estimate_bytes(0, desc.apic, desc.cell_ratio, 0, sort)) as f64 / (1 << 20) as f64;
                    let room = (mb as f64 * 1048576.0 * 0.85 - estimate_bytes(0, desc.apic, desc.cell_ratio, desc.spray_cap as u64, sort) as f64).max(0.0);
                    want = want.min((room / per) as u64).max((need as f64 * 1.3).ceil() as u64);
                }
                max_n = (max_n as u64).max(want).min(lim as u64) as u32;
                say(&format!("Max points {:.1}M: the starting water needs {:.1}M, and the narrow band refills from the rest", max_n as f64 / 1e6, need as f64 / 1e6));
            } else if need as f64 * 1.15 > max_n as f64 { max_n = lim.min((need as f64 * 1.3).ceil() as u32); }
        } else if !desc.max_n_set {
            // A scene's cap is the page's live Max points (120,000 in the page's default scenes), which the page raised by itself as the
            // spacing got finer; used as it is, a finer bake stopped filling the starting water partway. So, unless Max points was given,
            // at least 4M, or 1.3 times the starting water (its volume over the spacing cubed, dropped water included) if more.
            let d3 = (lay.d as f64).powi(3);
            let start: f64 = desc.fills.iter().map(|f| match f {
                Fill::Box { x0, x1, y0, y1, z0, z1 } => (x1 - x0) * (y1 - y0) * (z1 - z0),
                Fill::Sphere { r, .. } => 4.19 * r * r * r,
                Fill::Vol { lo, hi, .. } => ((hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2])) as f64,
            }).sum::<f64>() + desc.events.iter().map(|e| 4.19 * e.r * e.r * e.r).sum::<f64>();
            need = (start / d3).ceil() as u64;
            // (live water restarts often and its particle buffers are made each time: 1M will do there)
            max_n = (max_n as u64).max(if desc.live { 1_000_000 } else { 4_000_000 }).max((need as f64 * 1.3).ceil() as u64).min(lim as u64) as u32;
        }
        // the card must hold it: say so before starting rather than fail partway
        if sort && !fits(max_n as u64, true) && fits(max_n as u64, false) { sort = false; }
        if sort != desc.sort { say("Sorting particles is off for this bake: its second copy of the particles does not fit the card's free memory (same water, a little slower)."); }
        let est = estimate_bytes(max_n as u64, desc.apic, desc.cell_ratio, desc.spray_cap as u64, sort);
        if let Some(mb) = free {
            if est > mb << 20 { return Err(format!("This bake needs about {:.1} GB of video memory and {:.1} GB is free. Lower Max points or Max whitewater, or use a coarser spacing.", est as f64 / 1e9, mb as f64 / 1024.0)); }
        }
        let mut sim = FlipSim::new(gpu, lay, desc.open, max_n);
        if let (true, Some(band)) = (desc.tall, nb_band) {
            let (t, surf) = tall_row(desc, &sim.l, band, 8);
            // the tall cells start at the pressure of the water above them (at rest: gravity x h a cell), else the first steps see air below
            let margin = 8;
            if t > 0 { sim.enable_tall(gpu, t, margin, desc.g * sim.l.h * (surf - t as f32 + 0.5)); say(&format!("Tall cells: the deep water below {:.2} (row {t}) is one cell a column", sim.l.b.y0 + t as f32 * sim.l.h)); }
            else { say("Tall cells: the water is not deep enough under its band for them here"); }
        }
        sim.opt.apic = desc.apic; sim.opt.sort = sort; sim.opt.p2g_win = desc.p2g_win; sim.opt.ballistic = desc.ballistic; sim.opt.settle = desc.settle;
        sim.opt.mg = desc.mg; sim.opt.sep = desc.sep; sim.opt.ghost = desc.ghost; sim.opt.smooth = desc.smooth;
        let acc = desc.accurate;
        if acc { sim.opt.sep_iters = 16; }
        if desc.spr.is_some() && desc.spray_cap > 0 { sim.set_spray_cap(gpu, desc.spray_cap); }
        if desc.nb_look { sim.set_deep_look(gpu, true); }
        let mut ev = desc.events.clone();
        ev.sort_by(|a, b| a.t.total_cmp(&b.t));
        let mut vmax: f32 = 2.0;
        for o in desc.objs.iter().map(|o| sample(o, 0.0)) { if o.emitter { vmax = vmax.max(o.speed); } }
        Ok(Session { desc, lay, sim, runner: Runner::new(0x5eed), rng: Rng::new(0xf111), max_n, need, nb_band, ocean_w, iters: desc.iters, vmax, ei: 0, f: 1, ev,
            cfl: if acc { 0.6 } else { 1.5 }, max_sub: desc.substeps.max(if acc { desc.max_sub.max(64) } else { desc.max_sub }) })
    }

    /// Every object posed at time t.
    pub fn objs_at(&self, t: f32) -> Vec<Obj> { self.desc.objs.iter().map(|o| sample(o, t)).collect() }

    /// The starting water: the narrow band's seed with its spare slots, or the fills; then the blocks it needs.
    pub fn seed(&mut self, gpu: &Gpu) {
        let (desc, lay) = (self.desc, self.lay);
        if let Some(band) = self.nb_band {
            let j = (0.01 * lay.d as f64 / 0.12) as f32;
            let oc = desc.ocean.as_ref().map(|c| (c, &self.ocean_w[..]));
            let s = {
                let (sim, rng) = (&mut self.sim, &mut self.rng);
                nb::seed(&lay, &desc.fills, band, oc, 0.0, &mut |p, v| sim.add(gpu, [p[0] + (rng.f() - 0.5) * j, p[1] + (rng.f() - 0.5) * j, p[2] + (rng.f() - 0.5) * j], v))
            };
            let sim = &mut self.sim;
            // spare slots, parked off the map, for the solver to refill the band with
            let spare = ((sim.cap - sim.n) as u64).min(nb::spares(s.seeded));
            for _ in 0..spare { sim.add(gpu, [0.0, -1e6, 0.0], [0.0; 3]); }
            sim.nb_fills = s.prims; sim.nb_vols = s.vols; sim.nb_init = 1; sim.nb_band = Some(band); sim.ocean = desc.ocean; sim.ocean_w = self.ocean_w.clone();
        } else {
            for fl in &desc.fills {
                match fl {
                    Fill::Box { x0, x1, y0, y1, z0, z1 } => self.sim.fill_box(gpu, &mut self.rng, [*x0, *x1, *y0, *y1, *z0, *z1]),
                    Fill::Sphere { x, y, z, r, vy } => self.sim.fill_sphere(gpu, &mut self.rng, [*x, *y, *z], *r, [0.0, *vy as f32, 0.0]),
                    Fill::Vol { .. } => crate::bake::fill_volume(gpu, &mut self.sim, &mut self.rng, fl),
                }
            }
        }
        self.prime(gpu);
    }

    /// Blocks for the particles added so far (after seeding, or after adding particles by hand).
    pub fn prime(&mut self, gpu: &Gpu) { if self.sim.n > 0 { self.sim.prime(gpu, self.desc.g); } }

    /// The settings of one step at time t.
    pub fn par(&self, t: f32) -> StepPar {
        let d = self.desc;
        StepPar { g: d.g, iters: self.iters, flip: d.flip, apic_flip: d.apic_flip, comp: d.comp, vmax: d.vmax_w, vs: d.scale, tear: d.tear, time: t,
            wind: d.wind, drag: d.drag, gust: d.gust, foam_sens: d.foam_sens, foam_tau: d.foam_tau, spr: d.spr, air: d.air, drip: d.drip }
    }

    /// Sends frame self.f's substeps to the GPU (not waiting for them). after_sub runs after each substep with its time and the frame's substeps; returning true
    /// stops the frame there (the benchmark). Returns the substeps and the fastest object, or None when stopped.
    pub fn step_frame(&mut self, gpu: &Gpu, mut after_sub: impl FnMut(&mut FlipSim, f32, u32) -> Result<bool, String>) -> Result<Option<(u32, f32)>, String> {
        let dtf = 1.0 / self.desc.fps;
        let f = self.f;
        let obj_v = obj_speed(&self.objs_at((f - 1) as f32 * dtf), &self.objs_at(f as f32 * dtf), dtf, self.desc.col_max);
        let sub = self.desc.substeps.max(self.max_sub.min((dtf * self.vmax.max(obj_v) / (self.cfl * self.sim.h())).ceil() as u32));
        let dt = dtf / sub as f32;
        for s in 0..sub {
            let t = (f - 1) as f32 * dtf + (s + 1) as f32 * dt;
            while self.ei < self.ev.len() && self.ev[self.ei].t <= t {
                let e = self.ev[self.ei];
                self.ei += 1;
                self.sim.fill_sphere(gpu, &mut self.rng, [e.x, e.y, e.z], e.r, [0.0, -1.0, 0.0]);
            }
            let objs = self.objs_at(t);
            let par = self.par(t);
            self.runner.step(gpu, &mut self.sim, dt, &objs, &par, self.desc.col_max, self.desc.scale);
            if after_sub(&mut self.sim, t, sub)? { return Ok(None); }
        }
        Ok(Some((sub, obj_v)))
    }

    /// After frame self.f's readback was started (sim.readback_begin, n particles): how fast the water got (the next frame's substeps,
    /// measured on the GPU by speedMax), the frame's measurements, and under Accurate the next frame's pressure iterations. Moves on to
    /// the next frame. The particles themselves can be collected later (readback_end), while the next frame runs.
    pub fn finish_frame(&mut self, gpu: &Gpu, n: u32, sub: u32, obj_v: f32, ovf0: u64) -> Value {
        let sim = &mut self.sim;
        let mut mv: f32 = sim.frame_speed(gpu);
        sim.wait_stats(gpu);
        let st = sim.stats.unwrap_or_default();
        mv = mv.max(st.vmax);
        let f = self.f;
        let dtf = 1.0 / self.desc.fps;
        for o in self.desc.objs.iter().map(|o| sample(o, f as f32 * dtf)) { if o.emitter && o.on { mv = mv.max(o.speed); } }
        self.vmax = mv.max(1.0);
        let mut dg = json!({ "f": f, "n": n, "t": f as f32 * dtf, "sub": sub, "objectSpeed": obj_v, "fastestParticle": st.vmax, "fluidCells": st.fluid, "blocksUsed": st.sc,
            "blockPool": sim.scap, "blocksNoRoom": sim.ovf_total - ovf0, "iters": self.iters, "gpuMB": sim.mem_bytes() >> 20 });
        if sim.tall_t0 > 0 { dg["tallRow"] = json!(sim.tall_now(gpu)); }
        if self.desc.accurate {
            // the pressure left unsolved after the frame's last substep steers the next frame's iterations
            let r = sim.pres_residual(gpu);
            dg["unsolved"] = json!(r);
            let base = self.desc.iters;
            if r > ACC_TOL { self.iters = (base * 8).min((self.iters as f32 * 1.5).ceil() as u32); } else if r < ACC_TOL / 4.0 { self.iters = base.max((self.iters as f32 * 0.85).floor() as u32); }
        }
        self.f += 1;
        dg
    }

    /// The run's own state for a checkpoint (the solver's buffers are saved separately).
    pub fn save_state(&self) -> Value {
        json!({ "rng": self.rng.0, "vmax": self.vmax, "iters": self.iters, "ei": self.ei, "runner": self.runner.save_state(), "maxN": self.max_n, "need": self.need })
    }

    /// Carries on from a checkpoint: the solver's buffers from r, the rest from v.
    pub fn restore(&mut self, gpu: &Gpu, v: &Value, r: &mut impl std::io::Read) -> Result<(), String> {
        self.sim.restore_state(gpu, &v["sim"], r)?;
        self.runner.restore_state(&v["runner"]);
        self.rng = Rng(v["rng"].as_u64().unwrap_or(0xf111));
        self.vmax = v["vmax"].as_f64().unwrap_or(2.0) as f32;
        self.iters = v["iters"].as_u64().unwrap_or(self.desc.iters as u64) as u32;
        self.ei = v["ei"].as_u64().unwrap_or(0) as usize;
        self.f = v["frame"].as_u64().unwrap_or(0) as u32 + 1;
        Ok(())
    }
}
