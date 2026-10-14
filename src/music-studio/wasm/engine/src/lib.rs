//! Music Studio audio engine core, compiled to wasm32 and driven through a
//! plain C ABI (no bindings generator). One engine lives per WebAssembly
//! instance: the AudioWorklet and the offline render worker each create one.
//!
//! The host (src/engine/core.js) configures channel slots (an instrument type
//! and its parameter vector, in catalog order), mixer tracks (effect slots,
//! volume, pan, width, routes and a processing order), loads sample data into
//! linear memory, queues sample-accurate note events for the next block and
//! calls `process(frames)`, which returns a pointer to the stereo output
//! (planar: BLOCK left samples, then BLOCK right samples).
//!
//! Signal flow per block: instruments render into their channel buffers
//! (split at event offsets), the channel strip (volume, balance pan, audible
//! gain) adds them into the channel's mixer track, then tracks run in the
//! given order: effect slots (each with an on switch and dry/wet mix),
//! volume, pan, stereo width, audible gain, peak meters, then routes into
//! other tracks. The master (track 0) runs last; its output only gets a
//! NaN guard and a runaway clamp at +-2 (no limiter unless the user adds one).

pub mod dsp;
pub mod drum;
pub mod fx;
pub mod params;
pub mod sampler;
pub mod synth;

use dsp::*;
use params::*;
use sampler::{AudioPlayer, Sample, Sampler};
use std::alloc::{alloc as raw_alloc, dealloc as raw_dealloc, Layout};
use synth::Synth;

pub const MAX_FX: usize = 10;
const SCRATCH: usize = 4096;

/// What an instrument needs from the engine while rendering.
pub struct Ctx<'a> {
    pub samples: &'a [Option<Sample>],
    /// Pitch offset in semitones (channel pitch plus master pitch).
    pub pitch: f32,
}

enum Inst {
    None,
    Synth(Box<Synth>),
    Drum(Box<drum::Drum>),
    Sampler(Box<Sampler>),
    Audio(Box<AudioPlayer>),
}

struct Channel {
    kind: i32,
    inst: Inst,
    l: [f32; BLOCK],
    r: [f32; BLOCK],
    vol: f32,
    pan: f32,
    pitch: f32,
    track: usize,
    gain: f32,
    cur_l: f32,
    cur_r: f32,
    live: bool,
}

impl Channel {
    fn new() -> Box<Self> {
        Box::new(Channel { kind: -1, inst: Inst::None, l: [0.0; BLOCK], r: [0.0; BLOCK], vol: 0.78, pan: 0.0, pitch: 0.0, track: 0, gain: 1.0, cur_l: -1.0, cur_r: -1.0, live: false })
    }

    fn active(&self) -> bool {
        match &self.inst {
            Inst::None => false,
            Inst::Synth(s) => s.active(),
            Inst::Drum(d) => d.active(),
            Inst::Sampler(s) => s.active(),
            Inst::Audio(a) => a.active(),
        }
    }

    fn all_off(&mut self, hard: bool) {
        match &mut self.inst {
            Inst::None => {}
            Inst::Synth(s) => s.all_off(hard),
            Inst::Drum(d) => d.all_off(hard),
            Inst::Sampler(s) => s.all_off(hard),
            Inst::Audio(a) => a.all_off(hard),
        }
    }
}

struct Slot {
    fx: Option<fx::Fx>,
    kind: i32,
    on: bool,
    mix: f32,
    cur: f32,
}

struct Route {
    dest: usize,
    gain: f32,
    cur: f32,
}

struct Track {
    l: [f32; BLOCK],
    r: [f32; BLOCK],
    vol: f32,
    pan: f32,
    width: f32,
    gain: f32,
    cur_l: f32,
    cur_r: f32,
    cur_w: f32,
    slots: [Slot; MAX_FX],
    routes: Vec<Route>,
    peak_l: f32,
    peak_r: f32,
}

impl Track {
    fn new(index: usize) -> Box<Self> {
        const EMPTY: Slot = Slot { fx: None, kind: -1, on: false, mix: 1.0, cur: 0.0 };
        let mut routes = Vec::with_capacity(4);
        if index > 0 {
            routes.push(Route { dest: 0, gain: 1.0, cur: 1.0 });
        }
        Box::new(Track {
            l: [0.0; BLOCK],
            r: [0.0; BLOCK],
            vol: 0.8,
            pan: 0.0,
            width: 1.0,
            gain: 1.0,
            cur_l: -1.0,
            cur_r: -1.0,
            cur_w: 1.0,
            slots: [EMPTY; MAX_FX],
            routes,
            peak_l: 0.0,
            peak_r: 0.0,
        })
    }
}

#[derive(Clone, Copy)]
struct Event {
    offset: u32,
    kind: u8,
    slot: u32,
    id: u32,
    key: u8,
    vel: f32,
    pan: f32,
}

const EV_OFF: u8 = 0;
const EV_ALL_SOFT: u8 = 1;
const EV_ALL_HARD: u8 = 2;
const EV_ON: u8 = 3;
const EV_AUDIO: u8 = 4;
const EV_CLICK: u8 = 5;

struct Click {
    phase: f32,
    dt: f32,
    env: f32,
    coef: f32,
    amp: f32,
}

pub struct Engine {
    rate: f32,
    bpm: f32,
    master_pitch: f32,
    channels: Vec<Box<Channel>>,
    tracks: Vec<Box<Track>>,
    order: Vec<u32>,
    events: Vec<Event>,
    samples: Vec<Option<Sample>>,
    out: [f32; BLOCK * 2],
    meters: Vec<f32>,
    scratch: [f32; SCRATCH],
    dry_l: [f32; BLOCK],
    dry_r: [f32; BLOCK],
    click: Click,
    click_gain: f32,
}

impl Engine {
    fn new(rate: f32) -> Self {
        let mut e = Engine {
            rate,
            bpm: 120.0,
            master_pitch: 0.0,
            channels: Vec::with_capacity(64),
            tracks: Vec::with_capacity(32),
            order: Vec::with_capacity(32),
            events: Vec::with_capacity(4096),
            samples: Vec::with_capacity(64),
            out: [0.0; BLOCK * 2],
            meters: Vec::with_capacity(64),
            scratch: [0.0; SCRATCH],
            dry_l: [0.0; BLOCK],
            dry_r: [0.0; BLOCK],
            click: Click { phase: 0.0, dt: 0.0, env: 0.0, coef: 0.0, amp: 0.0 },
            click_gain: 0.35,
        };
        e.set_track_count(17);
        e
    }

    fn set_track_count(&mut self, n: usize) {
        let n = n.clamp(1, 256);
        while self.tracks.len() < n {
            let i = self.tracks.len();
            self.tracks.push(Track::new(i));
        }
        self.tracks.truncate(n);
        self.meters.resize(n * 2, 0.0);
        self.order.retain(|&t| (t as usize) < n);
    }

    fn channel(&mut self, slot: u32) -> &mut Channel {
        let s = slot as usize;
        while self.channels.len() <= s {
            self.channels.push(Channel::new());
        }
        &mut self.channels[s]
    }

    fn set_type(&mut self, slot: u32, kind: i32) {
        let rate = self.rate;
        let ch = self.channel(slot);
        if ch.kind == kind {
            return;
        }
        ch.kind = kind;
        ch.inst = match kind {
            INST_SYNTH => Inst::Synth(Synth::new(rate)),
            INST_DRUM => Inst::Drum(drum::Drum::new(rate)),
            INST_SAMPLER => Inst::Sampler(Sampler::new(rate)),
            INST_AUDIO => Inst::Audio(AudioPlayer::new(rate)),
            _ => Inst::None,
        };
        ch.cur_l = -1.0;
        ch.cur_r = -1.0;
    }

    fn push(&mut self, ev: Event) {
        self.events.push(ev);
    }

    fn apply(&mut self, ev: Event) {
        if ev.kind == EV_CLICK {
            let accent = ev.id != 0;
            self.click = Click {
                phase: 0.0,
                dt: (if accent { 1760.0 } else { 1320.0 }) / self.rate,
                env: 1.0,
                coef: tau_coef(if accent { 0.03 } else { 0.022 }, self.rate),
                amp: if accent { 1.0 } else { 0.6 },
            };
            return;
        }
        if ev.kind == EV_ALL_SOFT || ev.kind == EV_ALL_HARD {
            let hard = ev.kind == EV_ALL_HARD;
            if ev.slot == u32::MAX {
                for ch in self.channels.iter_mut() {
                    ch.all_off(hard);
                }
            } else if let Some(ch) = self.channels.get_mut(ev.slot as usize) {
                ch.all_off(hard);
            }
            return;
        }
        let s = ev.slot as usize;
        if s >= self.channels.len() {
            return;
        }
        let pitch = (self.channels[s].pitch + self.master_pitch) * 0.01;
        // A closed hat chokes open hats on its own channel and on every drum
        // channel that shares its mixer insert.
        if ev.kind == EV_ON {
            if let Inst::Drum(d) = &self.channels[s].inst {
                if d.kind() == drum_kinds::CLOSED_HAT {
                    let track = self.channels[s].track;
                    for (i, ch) in self.channels.iter_mut().enumerate() {
                        if i == s || ch.track != track {
                            continue;
                        }
                        if let Inst::Drum(o) = &mut ch.inst {
                            if o.kind() == drum_kinds::OPEN_HAT {
                                o.choke();
                            }
                        }
                    }
                }
            }
        }
        let samples = &self.samples;
        let ch = &mut self.channels[s];
        match (&mut ch.inst, ev.kind) {
            (Inst::Synth(x), EV_ON) => x.note_on(ev.id, ev.key, ev.vel, ev.pan),
            (Inst::Synth(x), EV_OFF) => x.note_off(ev.id),
            (Inst::Drum(x), EV_ON) => x.note_on(ev.id, ev.key, ev.vel, pitch),
            (Inst::Drum(x), EV_OFF) => x.note_off(ev.id),
            (Inst::Sampler(x), EV_ON) => x.note_on(ev.id, ev.key, ev.vel, ev.pan, samples),
            (Inst::Sampler(x), EV_OFF) => x.note_off(ev.id),
            (Inst::Audio(x), EV_ON) => x.play(ev.id, 0.0, ev.vel, samples),
            (Inst::Audio(x), EV_AUDIO) => x.play(ev.id, ev.pan, ev.vel, samples),
            (Inst::Audio(x), EV_OFF) => x.stop(ev.id),
            _ => {}
        }
    }

    fn render_channels(&mut self, a: usize, b: usize) {
        let mp = self.master_pitch;
        let samples = &self.samples;
        for ch in self.channels.iter_mut() {
            if !ch.live {
                continue;
            }
            let ctx = Ctx { samples, pitch: (ch.pitch + mp) * 0.01 };
            let (l, r) = (&mut ch.l, &mut ch.r);
            match &mut ch.inst {
                Inst::None => {}
                Inst::Synth(s) => s.render(l, r, a, b, &ctx),
                Inst::Drum(d) => d.render(l, r, a, b),
                Inst::Sampler(s) => s.render(l, r, a, b, &ctx),
                Inst::Audio(p) => p.render(l, r, a, b, &ctx),
            }
        }
    }

    fn process(&mut self, n: usize) -> *const f32 {
        let n = n.clamp(1, BLOCK);
        // Events in time order; at equal offsets note-offs come before note-ons.
        let evs = &mut self.events;
        for i in 1..evs.len() {
            let mut j = i;
            while j > 0 && (evs[j - 1].offset, evs[j - 1].kind) > (evs[j].offset, evs[j].kind) {
                evs.swap(j - 1, j);
                j -= 1;
            }
        }
        for ch in self.channels.iter_mut() {
            ch.live = ch.active();
        }
        for i in 0..self.events.len() {
            let ev = self.events[i];
            if ev.kind == EV_ON || ev.kind == EV_AUDIO {
                if let Some(ch) = self.channels.get_mut(ev.slot as usize) {
                    ch.live = true;
                }
            }
        }
        for ch in self.channels.iter_mut() {
            if ch.live {
                ch.l[..n].fill(0.0);
                ch.r[..n].fill(0.0);
            }
        }
        // Render, split at event offsets.
        let mut t = 0usize;
        let mut ei = 0usize;
        let count = self.events.len();
        while ei < count {
            let ev = self.events[ei];
            let at = (ev.offset as usize).min(n - 1);
            if at > t {
                self.render_channels(t, at);
                t = at;
            }
            self.apply(ev);
            ei += 1;
        }
        if t < n {
            self.render_channels(t, n);
        }
        self.events.clear();

        // Channel strips into mixer tracks.
        for tr in self.tracks.iter_mut() {
            tr.l[..n].fill(0.0);
            tr.r[..n].fill(0.0);
        }
        let ntracks = self.tracks.len();
        let inv = 1.0 / n as f32;
        for ch in self.channels.iter_mut() {
            let (bl, br) = balance(ch.pan);
            let g = ch.vol * ch.gain;
            let (tl, tr) = (g * bl, g * br);
            if ch.cur_l < 0.0 {
                ch.cur_l = tl;
                ch.cur_r = tr;
            }
            if !ch.live {
                ch.cur_l = tl;
                ch.cur_r = tr;
                continue;
            }
            // Guard against an instrument blowing up.
            if !(ch.l[0] + ch.l[n - 1] + ch.r[n / 2]).is_finite() {
                ch.all_off(true);
                continue;
            }
            let dst = &mut self.tracks[if ch.track < ntracks { ch.track } else { 0 }];
            let (l0, r0) = (ch.cur_l, ch.cur_r);
            for i in 0..n {
                let k = (i + 1) as f32 * inv;
                dst.l[i] += ch.l[i] * lerp(l0, tl, k);
                dst.r[i] += ch.r[i] * lerp(r0, tr, k);
            }
            ch.cur_l = tl;
            ch.cur_r = tr;
        }

        // Mixer tracks in dependency order, the master last.
        let bpm = self.bpm;
        let mut order_len = self.order.len();
        if order_len == 0 {
            for t in 1..ntracks {
                self.scratch[t - 1] = t as f32;
            }
            order_len = ntracks - 1;
        } else {
            for (i, &t) in self.order.iter().enumerate() {
                self.scratch[i] = t as f32;
            }
        }
        for oi in 0..=order_len {
            let ti = if oi == order_len { 0 } else { self.scratch[oi] as usize };
            if ti >= ntracks || (ti == 0 && oi != order_len) {
                continue;
            }
            self.run_track(ti, n, bpm);
            if ti == 0 {
                continue;
            }
            // Routes.
            let (src_l, src_r) = {
                let tr = &self.tracks[ti];
                (tr.l, tr.r)
            };
            let nr = self.tracks[ti].routes.len();
            for ri in 0..nr {
                let (dest, g1, g0) = {
                    let r = &self.tracks[ti].routes[ri];
                    (r.dest, r.gain, r.cur)
                };
                self.tracks[ti].routes[ri].cur = g1;
                if dest >= ntracks || dest == ti || (g0 == 0.0 && g1 == 0.0) {
                    continue;
                }
                let d = &mut self.tracks[dest];
                for i in 0..n {
                    let g = lerp(g0, g1, (i + 1) as f32 * inv);
                    d.l[i] += src_l[i] * g;
                    d.r[i] += src_r[i] * g;
                }
            }
        }

        // Master out, then the metronome click.
        let m = &self.tracks[0];
        for i in 0..n {
            let mut l = m.l[i];
            let mut r = m.r[i];
            if !l.is_finite() {
                l = 0.0;
            }
            if !r.is_finite() {
                r = 0.0;
            }
            self.out[i] = clampf(l, -2.0, 2.0);
            self.out[BLOCK + i] = clampf(r, -2.0, 2.0);
        }
        if self.click.env > 1e-4 {
            let c = &mut self.click;
            for i in 0..n {
                let s = sin_turns(c.phase) * c.env * c.amp * self.click_gain;
                c.phase += c.dt;
                c.env *= c.coef;
                self.out[i] += s;
                self.out[BLOCK + i] += s;
            }
        }
        self.out.as_ptr()
    }

    fn run_track(&mut self, ti: usize, n: usize, bpm: f32) {
        let inv = 1.0 / n as f32;
        let tr = &mut self.tracks[ti];
        let mut bad = false;
        for s in tr.slots.iter_mut() {
            let Some(fx) = s.fx.as_mut() else { continue };
            let target = if s.on { s.mix } else { 0.0 };
            if s.cur == 0.0 && target == 0.0 {
                continue;
            }
            let (m0, m1) = (s.cur, target);
            s.cur = m1;
            let full = m0 == 1.0 && m1 == 1.0;
            if !full {
                self.dry_l[..n].copy_from_slice(&tr.l[..n]);
                self.dry_r[..n].copy_from_slice(&tr.r[..n]);
            }
            fx.process(&mut tr.l[..n], &mut tr.r[..n], bpm);
            if !full {
                for i in 0..n {
                    let k = lerp(m0, m1, (i + 1) as f32 * inv);
                    tr.l[i] = self.dry_l[i] + (tr.l[i] - self.dry_l[i]) * k;
                    tr.r[i] = self.dry_r[i] + (tr.r[i] - self.dry_r[i]) * k;
                }
            }
            if m1 == 0.0 {
                // Fully bypassed now: start clean when switched back on.
                fx.reset();
            }
            if !(tr.l[0] + tr.l[n - 1] + tr.r[n / 2]).is_finite() {
                fx.reset();
                bad = true;
            }
        }
        if bad {
            tr.l[..n].fill(0.0);
            tr.r[..n].fill(0.0);
        }
        let (bl, br) = balance(tr.pan);
        let g = tr.vol * tr.gain;
        let (tl, trr) = (g * bl, g * br);
        if tr.cur_l < 0.0 {
            tr.cur_l = tl;
            tr.cur_r = trr;
        }
        let (l0, r0, w0, w1) = (tr.cur_l, tr.cur_r, tr.cur_w, tr.width);
        tr.cur_l = tl;
        tr.cur_r = trr;
        tr.cur_w = w1;
        let mut pl = tr.peak_l;
        let mut pr = tr.peak_r;
        let stereo = w0 != 1.0 || w1 != 1.0;
        for i in 0..n {
            let k = (i + 1) as f32 * inv;
            let (mut x, mut y) = (tr.l[i], tr.r[i]);
            if stereo {
                let w = lerp(w0, w1, k);
                let m = (x + y) * 0.5;
                let s = (x - y) * 0.5 * w;
                x = m + s;
                y = m - s;
            }
            x *= lerp(l0, tl, k);
            y *= lerp(r0, trr, k);
            tr.l[i] = x;
            tr.r[i] = y;
            let ax = x.abs();
            let ay = y.abs();
            if ax > pl {
                pl = ax;
            }
            if ay > pr {
                pr = ay;
            }
        }
        tr.peak_l = if pl.is_finite() { pl } else { 0.0 };
        tr.peak_r = if pr.is_finite() { pr } else { 0.0 };
    }

    fn active_voices(&self) -> u32 {
        self.channels.iter().filter(|c| c.active()).count() as u32
    }
}

mod drum_kinds {
    pub use crate::params::drum::{CLOSED_HAT, OPEN_HAT};
}

// ------------------------------------------------------------------ C ABI

static mut ENGINE: Option<Engine> = None;

#[inline]
fn eng() -> Option<&'static mut Engine> {
    unsafe { (*core::ptr::addr_of_mut!(ENGINE)).as_mut() }
}

/// Allocates `bytes` bytes aligned to 16 and returns the pointer (0 on failure).
#[no_mangle]
pub extern "C" fn mem_alloc(bytes: u32) -> u32 {
    if bytes == 0 {
        return 0;
    }
    match Layout::from_size_align(bytes as usize, 16) {
        Ok(layout) => unsafe { raw_alloc(layout) as u32 },
        Err(_) => 0,
    }
}

#[no_mangle]
pub extern "C" fn mem_free(ptr: u32, bytes: u32) {
    if ptr == 0 || bytes == 0 {
        return;
    }
    if let Ok(layout) = Layout::from_size_align(bytes as usize, 16) {
        unsafe { raw_dealloc(ptr as *mut u8, layout) }
    }
}

/// Creates (or recreates) the engine at a sample rate.
#[no_mangle]
pub extern "C" fn engine_init(rate: f32) {
    let rate = if rate.is_finite() && rate >= 8000.0 { rate } else { 48000.0 };
    unsafe {
        *core::ptr::addr_of_mut!(ENGINE) = Some(Engine::new(rate));
    }
}

#[no_mangle]
pub extern "C" fn engine_block() -> u32 {
    BLOCK as u32
}

#[no_mangle]
pub extern "C" fn inst_type_count() -> u32 {
    INST_TYPES as u32
}

#[no_mangle]
pub extern "C" fn inst_param_count(kind: u32) -> u32 {
    INST_PARAM_COUNTS.get(kind as usize).copied().unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn fx_type_count() -> u32 {
    FX_TYPES as u32
}

#[no_mangle]
pub extern "C" fn fx_param_count(kind: u32) -> u32 {
    FX_PARAM_COUNTS.get(kind as usize).copied().unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn division_count() -> u32 {
    DIVISION_BEATS.len() as u32
}

#[no_mangle]
pub extern "C" fn division_beats(i: u32) -> f32 {
    DIVISION_BEATS.get(i as usize).copied().unwrap_or(0.0)
}

/// A scratch area of SCRATCH f32 values the host may fill before calls that take it.
#[no_mangle]
pub extern "C" fn scratch_ptr() -> u32 {
    eng().map(|e| e.scratch.as_ptr() as u32).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn set_tempo(bpm: f32) {
    if let Some(e) = eng() {
        if bpm.is_finite() && bpm > 0.0 {
            e.bpm = bpm;
        }
    }
}

/// Global transposition in cents (project.masterPitch).
#[no_mangle]
pub extern "C" fn set_master_pitch(cents: f32) {
    if let Some(e) = eng() {
        if cents.is_finite() {
            e.master_pitch = clampf(cents, -4800.0, 4800.0);
        }
    }
}

/// Metronome click level (0 mutes).
#[no_mangle]
pub extern "C" fn set_click_gain(g: f32) {
    if let Some(e) = eng() {
        e.click_gain = clampf(g, 0.0, 2.0);
    }
}

/// Sets a channel slot's instrument type (-1 removes it). Changing the type resets the voice state.
#[no_mangle]
pub extern "C" fn ch_set_type(slot: u32, kind: i32) {
    if let Some(e) = eng() {
        if slot < 4096 {
            e.set_type(slot, kind);
        }
    }
}

#[no_mangle]
pub extern "C" fn ch_set_param(slot: u32, i: u32, v: f32) {
    let Some(e) = eng() else { return };
    let Some(ch) = e.channels.get_mut(slot as usize) else { return };
    let i = i as usize;
    match &mut ch.inst {
        Inst::None => {}
        Inst::Synth(s) => s.set_param(i, v),
        Inst::Drum(d) => d.set_param(i, v),
        Inst::Sampler(s) => s.set_param(i, v),
        Inst::Audio(a) => a.set_param(i, v),
    }
}

/// Snaps smoothed parameters to their set values (after configuring a new channel).
#[no_mangle]
pub extern "C" fn ch_settle(slot: u32) {
    let Some(e) = eng() else { return };
    let Some(ch) = e.channels.get_mut(slot as usize) else { return };
    match &mut ch.inst {
        Inst::None => {}
        Inst::Synth(s) => s.settle(),
        Inst::Drum(d) => d.settle(),
        Inst::Sampler(s) => s.settle(),
        Inst::Audio(a) => a.settle(),
    }
    ch.cur_l = -1.0;
}

/// Channel strip: volume (linear), pan (-1..1, balance law), pitch (cents),
/// destination mixer track and audible gain (0 when muted or not soloed).
#[no_mangle]
pub extern "C" fn ch_set_strip(slot: u32, vol: f32, pan: f32, pitch: f32, track: u32, gain: f32) {
    let Some(e) = eng() else { return };
    let Some(ch) = e.channels.get_mut(slot as usize) else { return };
    ch.vol = if vol.is_finite() { clampf(vol, 0.0, 4.0) } else { 0.0 };
    ch.pan = if pan.is_finite() { clampf(pan, -1.0, 1.0) } else { 0.0 };
    ch.pitch = if pitch.is_finite() { clampf(pitch, -4800.0, 4800.0) } else { 0.0 };
    ch.track = track as usize;
    ch.gain = if gain.is_finite() { clampf(gain, 0.0, 4.0) } else { 0.0 };
}

#[no_mangle]
pub extern "C" fn ch_set_sample(slot: u32, sample: i32) {
    let Some(e) = eng() else { return };
    let Some(ch) = e.channels.get_mut(slot as usize) else { return };
    match &mut ch.inst {
        Inst::Sampler(s) => {
            if s.sample != sample {
                s.all_off(true);
                s.sample = sample;
            }
        }
        Inst::Audio(a) => {
            if a.sample != sample {
                a.all_off(true);
                a.sample = sample;
            }
        }
        _ => {}
    }
}

/// Queues a note-on `offset` frames into the next block. `id` identifies the note for its note-off.
#[no_mangle]
pub extern "C" fn ch_note_on(slot: u32, id: u32, key: u32, vel: f32, pan: f32, offset: u32) {
    if let Some(e) = eng() {
        e.push(Event { offset, kind: EV_ON, slot, id, key: key.min(127) as u8, vel: clampf(vel, 0.0, 1.0), pan: clampf(pan, -1.0, 1.0) });
    }
}

#[no_mangle]
pub extern "C" fn ch_note_off(slot: u32, id: u32, offset: u32) {
    if let Some(e) = eng() {
        e.push(Event { offset, kind: EV_OFF, slot, id, key: 0, vel: 0.0, pan: 0.0 });
    }
}

/// Queues audio clip playback: `start` seconds into the sample, at `gain`.
#[no_mangle]
pub extern "C" fn ch_audio_on(slot: u32, id: u32, start: f32, gain: f32, offset: u32) {
    if let Some(e) = eng() {
        e.push(Event { offset, kind: EV_AUDIO, slot, id, key: 0, vel: gain, pan: if start.is_finite() { start } else { 0.0 } });
    }
}

/// Releases (or with `hard`, silences) every voice of a slot; slot 0xffffffff means all channels.
#[no_mangle]
pub extern "C" fn ch_all_off(slot: u32, hard: u32, offset: u32) {
    if let Some(e) = eng() {
        e.push(Event { offset, kind: if hard != 0 { EV_ALL_HARD } else { EV_ALL_SOFT }, slot, id: 0, key: 0, vel: 0.0, pan: 0.0 });
    }
}

/// Queues a metronome click (accent on the first beat of a bar).
#[no_mangle]
pub extern "C" fn click(accent: u32, offset: u32) {
    if let Some(e) = eng() {
        e.push(Event { offset, kind: EV_CLICK, slot: 0, id: accent, key: 0, vel: 0.0, pan: 0.0 });
    }
}

#[no_mangle]
pub extern "C" fn mix_set_count(n: u32) {
    if let Some(e) = eng() {
        e.set_track_count(n as usize);
    }
}

#[no_mangle]
pub extern "C" fn mix_set_track(t: u32, vol: f32, pan: f32, width: f32, gain: f32) {
    let Some(e) = eng() else { return };
    let Some(tr) = e.tracks.get_mut(t as usize) else { return };
    tr.vol = if vol.is_finite() { clampf(vol, 0.0, 4.0) } else { 0.0 };
    tr.pan = if pan.is_finite() { clampf(pan, -1.0, 1.0) } else { 0.0 };
    tr.width = if width.is_finite() { clampf(width, 0.0, 2.0) } else { 1.0 };
    tr.gain = if gain.is_finite() { clampf(gain, 0.0, 4.0) } else { 0.0 };
}

/// Sets an effect slot: type (-1 empties it), on switch and dry/wet mix.
#[no_mangle]
pub extern "C" fn mix_set_fx(t: u32, slot: u32, kind: i32, on: u32, mix: f32) {
    let Some(e) = eng() else { return };
    let rate = e.rate;
    let Some(tr) = e.tracks.get_mut(t as usize) else { return };
    let Some(s) = tr.slots.get_mut(slot as usize) else { return };
    if s.kind != kind {
        s.kind = kind;
        s.fx = fx::Fx::new(kind, rate);
        s.cur = 0.0;
    }
    s.on = on != 0;
    s.mix = if mix.is_finite() { clampf(mix, 0.0, 1.0) } else { 1.0 };
}

#[no_mangle]
pub extern "C" fn mix_set_fx_param(t: u32, slot: u32, i: u32, v: f32) {
    let Some(e) = eng() else { return };
    let Some(tr) = e.tracks.get_mut(t as usize) else { return };
    if let Some(Some(fx)) = tr.slots.get_mut(slot as usize).map(|s| s.fx.as_mut()) {
        fx.set(i as usize, v);
    }
}

/// Replaces a track's routes with `n` (dest, gain) pairs read from the scratch area.
#[no_mangle]
pub extern "C" fn mix_set_routes(t: u32, n: u32) {
    let Some(e) = eng() else { return };
    let n = (n as usize).min(SCRATCH / 2);
    let mut pairs = [(0usize, 0.0f32); 256];
    let n = n.min(256);
    for (i, p) in pairs.iter_mut().enumerate().take(n) {
        *p = (e.scratch[i * 2] as usize, e.scratch[i * 2 + 1]);
    }
    let Some(tr) = e.tracks.get_mut(t as usize) else { return };
    for r in tr.routes.iter_mut() {
        r.gain = 0.0;
    }
    for &(dest, gain) in pairs.iter().take(n) {
        let g = if gain.is_finite() { clampf(gain, 0.0, 4.0) } else { 0.0 };
        if let Some(r) = tr.routes.iter_mut().find(|r| r.dest == dest) {
            r.gain = g;
        } else {
            tr.routes.push(Route { dest, gain: g, cur: g });
        }
    }
    tr.routes.retain(|r| r.gain != 0.0 || r.cur != 0.0);
}

/// Sets the track processing order (`n` track indices from the scratch area, master excluded).
#[no_mangle]
pub extern "C" fn mix_set_order(n: u32) {
    let Some(e) = eng() else { return };
    let n = (n as usize).min(SCRATCH);
    e.order.clear();
    for i in 0..n {
        let t = e.scratch[i] as u32;
        if t != 0 && (t as usize) < e.tracks.len() {
            e.order.push(t);
        }
    }
}

/// Clears every effect's state (delay lines, reverb tails), e.g. before an offline render.
#[no_mangle]
pub extern "C" fn mix_reset() {
    let Some(e) = eng() else { return };
    for tr in e.tracks.iter_mut() {
        for s in tr.slots.iter_mut() {
            if let Some(f) = s.fx.as_mut() {
                f.reset();
            }
        }
    }
    for ch in e.channels.iter_mut() {
        ch.all_off(true);
    }
    e.events.clear();
    e.click.env = 0.0;
}

/// Allocates sample storage (planar, `chans` x `frames` f32) and returns its pointer for the host to fill.
#[no_mangle]
pub extern "C" fn sample_alloc(idx: u32, frames: u32, chans: u32, rate: f32) -> u32 {
    let Some(e) = eng() else { return 0 };
    let idx = idx as usize;
    if idx >= 65536 {
        return 0;
    }
    while e.samples.len() <= idx {
        e.samples.push(None);
    }
    for ch in e.channels.iter_mut() {
        match &mut ch.inst {
            Inst::Sampler(s) => s.drop_sample(idx as i32),
            Inst::Audio(a) => a.drop_sample(idx as i32),
            _ => {}
        }
    }
    let chans = chans.clamp(1, 2) as usize;
    let frames = frames as usize;
    let data = vec![0.0f32; chans * frames];
    let s = Sample { chans, frames, rate: if rate.is_finite() && rate > 0.0 { rate } else { 48000.0 }, data };
    let ptr = s.data.as_ptr() as u32;
    e.samples[idx] = Some(s);
    ptr
}

#[no_mangle]
pub extern "C" fn sample_free(idx: u32) {
    let Some(e) = eng() else { return };
    for ch in e.channels.iter_mut() {
        match &mut ch.inst {
            Inst::Sampler(s) => s.drop_sample(idx as i32),
            Inst::Audio(a) => a.drop_sample(idx as i32),
            _ => {}
        }
    }
    if let Some(s) = e.samples.get_mut(idx as usize) {
        *s = None;
    }
}

/// Renders `frames` (at most BLOCK) and returns the output pointer (left, then right at +BLOCK).
#[no_mangle]
pub extern "C" fn process(frames: u32) -> u32 {
    match eng() {
        Some(e) => e.process(frames as usize) as u32,
        None => 0,
    }
}

/// Copies per-track peaks (L, R per track) into the meters buffer, resets them and returns its pointer.
#[no_mangle]
pub extern "C" fn meters_take() -> u32 {
    let Some(e) = eng() else { return 0 };
    for (i, tr) in e.tracks.iter_mut().enumerate() {
        e.meters[i * 2] = tr.peak_l;
        e.meters[i * 2 + 1] = tr.peak_r;
        tr.peak_l = 0.0;
        tr.peak_r = 0.0;
    }
    e.meters.as_ptr() as u32
}

#[no_mangle]
pub extern "C" fn track_count() -> u32 {
    eng().map(|e| e.tracks.len() as u32).unwrap_or(0)
}

/// Channels with sounding voices (for load statistics and render tails).
#[no_mangle]
pub extern "C" fn active_channels() -> u32 {
    eng().map(|e| e.active_voices()).unwrap_or(0)
}
