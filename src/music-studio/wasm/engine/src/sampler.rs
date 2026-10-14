//! Sample playback: the Sampler instrument (key-tracked, start/end, loop,
//! reverse, one-shot or gated, ADSR and filter) and the audio clip player
//! used by playlist audio clips. Both read 4-point Hermite interpolated
//! sample data and convert from the sample's rate to the engine rate.

use crate::dsp::*;
use crate::Ctx;

/// Decoded audio in linear memory: planar, `chans` (1 or 2) x `frames`.
pub struct Sample {
    pub chans: usize,
    pub frames: usize,
    pub rate: f32,
    pub data: Vec<f32>,
}

impl Sample {
    #[inline]
    fn get(&self, c: usize, i: isize) -> f32 {
        if i < 0 || i as usize >= self.frames {
            0.0
        } else {
            self.data[c * self.frames + i as usize]
        }
    }

    /// Interpolated stereo frame at fractional position `pos`.
    #[inline]
    pub fn read(&self, pos: f64) -> (f32, f32) {
        let i = pos.floor();
        let t = (pos - i) as f32;
        let i = i as isize;
        let l = hermite(self.get(0, i - 1), self.get(0, i), self.get(0, i + 1), self.get(0, i + 2), t);
        if self.chans > 1 {
            let r = hermite(self.get(1, i - 1), self.get(1, i), self.get(1, i + 1), self.get(1, i + 2), t);
            (l, r)
        } else {
            (l, l)
        }
    }
}

#[inline]
fn hermite(xm1: f32, x0: f32, x1: f32, x2: f32, t: f32) -> f32 {
    let c = (x1 - xm1) * 0.5;
    let v = x0 - x1;
    let w = c + v;
    let a = w + v + (x2 - x0) * 0.5;
    let b = w + a;
    ((a * t - b) * t + c) * t + x0
}

pub fn sample_at(samples: &[Option<Sample>], idx: i32) -> Option<&Sample> {
    if idx < 0 {
        return None;
    }
    samples.get(idx as usize).and_then(|s| s.as_ref()).filter(|s| s.frames > 0)
}

// ------------------------------------------------------------------ sampler

use crate::params::sampler::*;

const MAX_VOICES: usize = 16;

#[derive(Clone, Copy)]
struct Voice {
    active: bool,
    gate: bool,
    id: u32,
    key: u8,
    vamp: f32,
    pl: f32,
    pr: f32,
    pos: f64,
    env: Adsr,
    fl: Svf,
    fr: Svf,
    age: u32,
}

impl Voice {
    const fn new() -> Self {
        Voice { active: false, gate: false, id: 0, key: 60, vamp: 1.0, pl: 1.0, pr: 1.0, pos: 0.0, env: Adsr::new(), fl: Svf::new(), fr: Svf::new(), age: 0 }
    }
}

pub struct Sampler {
    p: [f32; COUNT],
    pub sample: i32,
    voices: [Voice; MAX_VOICES],
    env_t: Adsr,
    env_dirty: bool,
    cutoff: f32,
    gain: f32,
    coef: SvfCoef,
    rate: f32,
    clock: u32,
}

impl Sampler {
    pub fn new(rate: f32) -> Box<Self> {
        Box::new(Sampler {
            p: DEFAULTS,
            sample: -1,
            voices: [Voice::new(); MAX_VOICES],
            env_t: Adsr::new(),
            env_dirty: true,
            cutoff: 20000.0,
            gain: DEFAULTS[GAIN],
            coef: SvfCoef::new(),
            rate,
            clock: 0,
        })
    }

    pub fn set_param(&mut self, i: usize, v: f32) {
        if i < COUNT && v.is_finite() {
            self.p[i] = v;
            if (A_ATTACK..=A_RELEASE).contains(&i) {
                self.env_dirty = true;
            }
        }
    }

    pub fn settle(&mut self) {
        self.cutoff = clampf(self.p[CUTOFF], 20.0, 20000.0);
        self.gain = self.p[GAIN];
    }

    pub fn active(&self) -> bool {
        self.voices.iter().any(|v| v.active)
    }

    fn update_env(&mut self) {
        if self.env_dirty {
            self.env_dirty = false;
            self.env_t.set(self.p[A_ATTACK], self.p[A_DECAY], self.p[A_SUSTAIN], self.p[A_RELEASE], self.rate);
            let t = self.env_t;
            for v in self.voices.iter_mut() {
                v.env.copy_coefs(&t);
            }
        }
    }

    /// Start and end frames of the playable region, or None when empty.
    fn region(&self, s: &Sample) -> Option<(f64, f64)> {
        let n = s.frames as f64;
        let a = clampf(self.p[START], 0.0, 1.0) as f64 * n;
        let b = clampf(self.p[END], 0.0, 1.0) as f64 * n;
        if b - a < 2.0 {
            None
        } else {
            Some((a, b))
        }
    }

    pub fn note_on(&mut self, id: u32, key: u8, vel: f32, pan: f32, samples: &[Option<Sample>]) {
        self.update_env();
        let Some(s) = sample_at(samples, self.sample) else { return };
        let Some((a, b)) = self.region(s) else { return };
        let vi = match self.voices.iter().position(|v| !v.active) {
            Some(i) => i,
            None => {
                let mut best = 0;
                let mut age = 0;
                for (i, v) in self.voices.iter().enumerate() {
                    let d = self.clock.wrapping_sub(v.age);
                    if d >= age {
                        age = d;
                        best = i;
                    }
                }
                best
            }
        };
        self.clock = self.clock.wrapping_add(1);
        let reverse = self.p[REVERSE] >= 0.5;
        let vel_amp = clampf(self.p[VEL_AMP], 0.0, 1.0);
        let (pl, pr) = balance(pan);
        let t = self.env_t;
        let v = &mut self.voices[vi];
        let was = v.active;
        v.active = true;
        v.gate = true;
        v.id = id;
        v.key = key;
        v.vamp = 1.0 - vel_amp * (1.0 - clampf(vel, 0.0, 1.0));
        v.pl = pl;
        v.pr = pr;
        v.age = self.clock;
        v.pos = if reverse { b - 1.0 } else { a };
        v.env.copy_coefs(&t);
        if !was {
            v.env.level = 0.0;
            v.fl.reset();
            v.fr.reset();
        }
        v.env.trigger();
    }

    pub fn note_off(&mut self, id: u32) {
        let oneshot = self.p[ONESHOT] >= 0.5 && self.p[LOOP] < 0.5;
        if oneshot {
            return;
        }
        for v in self.voices.iter_mut() {
            if v.gate && v.id == id {
                v.gate = false;
                v.env.release();
            }
        }
    }

    pub fn all_off(&mut self, hard: bool) {
        for v in self.voices.iter_mut() {
            v.gate = false;
            v.env.release();
            if hard {
                v.active = false;
            }
        }
    }

    /// Stops voices reading a sample that is being unloaded.
    pub fn drop_sample(&mut self, idx: i32) {
        if self.sample == idx {
            self.all_off(true);
        }
    }

    pub fn render(&mut self, l: &mut [f32], r: &mut [f32], a: usize, b: usize, ctx: &Ctx) {
        self.update_env();
        let Some(s) = sample_at(ctx.samples, self.sample) else {
            for v in self.voices.iter_mut() {
                v.active = false;
            }
            return;
        };
        let Some((ra, rb)) = self.region(s) else {
            for v in self.voices.iter_mut() {
                v.active = false;
            }
            return;
        };
        let p = self.p;
        // Smooth level and cutoff once per call (calls are at most one block).
        let g0 = self.gain;
        let g1 = clampf(p[GAIN], 0.0, 2.0);
        self.gain = g1;
        let tc = clampf(p[CUTOFF], 20.0, 20000.0);
        self.cutoff = fast_exp2(fast_log2(self.cutoff) + (fast_log2(tc) - fast_log2(self.cutoff)) * 0.3);
        let filt = self.cutoff < 19_500.0 || p[RESO] > 0.01;
        if filt {
            self.coef.set(self.cutoff, SvfCoef::reso_k(p[RESO]), self.rate, 0);
        }
        let reverse = p[REVERSE] >= 0.5;
        let looping = p[LOOP] >= 0.5;
        let track = p[TRACK] >= 0.5;
        let root = p[ROOT];
        let len = rb - ra;
        let n = (b - a).max(1) as f32;
        let coef = self.coef;
        let base = s.rate as f64 / self.rate as f64;
        for v in self.voices.iter_mut() {
            if !v.active {
                continue;
            }
            let semis = if track { v.key as f32 - root } else { 0.0 } + p[TUNE] + p[FINE] * 0.01 + ctx.pitch;
            let step = base * fast_exp2(clampf(semis, -96.0, 96.0) / 12.0) as f64;
            for i in a..b {
                if reverse {
                    if v.pos < ra {
                        if looping {
                            v.pos += len;
                        } else {
                            v.active = false;
                            break;
                        }
                    }
                } else if v.pos >= rb {
                    if looping {
                        v.pos -= len;
                    } else {
                        v.active = false;
                        break;
                    }
                }
                let (mut x, mut y) = s.read(v.pos);
                v.pos += if reverse { -step } else { step };
                if filt {
                    x = v.fl.run(&coef, x);
                    y = v.fr.run(&coef, y);
                }
                let e = v.env.next();
                let g = e * v.vamp * lerp(g0, g1, (i - a + 1) as f32 / n);
                l[i] += x * g * v.pl;
                r[i] += y * g * v.pr;
                if !v.env.active() {
                    v.active = false;
                    break;
                }
            }
            v.fl.flush();
            v.fr.flush();
        }
    }
}

// ------------------------------------------------------------------ audio clips

use crate::params::audio as ap;

const AUDIO_VOICES: usize = 4;

#[derive(Clone, Copy)]
struct Play {
    active: bool,
    id: u32,
    pos: f64,
    fade: f32,
    fade_step: f32,
    gain: f32,
}

pub struct AudioPlayer {
    p: [f32; ap::COUNT],
    pub sample: i32,
    voices: [Play; AUDIO_VOICES],
    gain: f32,
    rate: f32,
    next: usize,
}

impl AudioPlayer {
    pub fn new(rate: f32) -> Box<Self> {
        Box::new(AudioPlayer {
            p: ap::DEFAULTS,
            sample: -1,
            voices: [Play { active: false, id: 0, pos: 0.0, fade: 0.0, fade_step: 0.0, gain: 1.0 }; AUDIO_VOICES],
            gain: ap::DEFAULTS[ap::GAIN],
            rate,
            next: 0,
        })
    }

    pub fn set_param(&mut self, i: usize, v: f32) {
        if i < ap::COUNT && v.is_finite() {
            self.p[i] = v;
        }
    }

    pub fn settle(&mut self) {
        self.gain = self.p[ap::GAIN];
    }

    pub fn active(&self) -> bool {
        self.voices.iter().any(|v| v.active)
    }

    /// Starts playback `offset` seconds into the sample (from the end when reversed).
    pub fn play(&mut self, id: u32, offset: f32, gain: f32, samples: &[Option<Sample>]) {
        let Some(s) = sample_at(samples, self.sample) else { return };
        let start = (offset.max(0.0) * s.rate) as f64;
        if start >= s.frames as f64 {
            return;
        }
        let vi = match self.voices.iter().position(|v| !v.active) {
            Some(i) => i,
            None => {
                self.next = (self.next + 1) % AUDIO_VOICES;
                self.next
            }
        };
        let reverse = self.p[ap::REVERSE] >= 0.5;
        // A short fade-in when starting mid-file avoids a click.
        let fade_in = if offset > 0.0 { 1.0 / (0.002 * self.rate) } else { 1.0 };
        self.voices[vi] = Play {
            active: true,
            id,
            pos: if reverse { s.frames as f64 - 1.0 - start } else { start },
            fade: if offset > 0.0 { 0.0 } else { 1.0 },
            fade_step: fade_in,
            gain: clampf(gain, 0.0, 2.0),
        };
    }

    pub fn stop(&mut self, id: u32) {
        let step = -1.0 / (0.005 * self.rate);
        for v in self.voices.iter_mut() {
            if v.active && v.id == id {
                v.fade_step = step;
            }
        }
    }

    pub fn all_off(&mut self, hard: bool) {
        let step = -1.0 / (0.005 * self.rate);
        for v in self.voices.iter_mut() {
            if hard {
                v.active = false;
            } else {
                v.fade_step = step;
            }
        }
    }

    pub fn drop_sample(&mut self, idx: i32) {
        if self.sample == idx {
            self.all_off(true);
        }
    }

    pub fn render(&mut self, l: &mut [f32], r: &mut [f32], a: usize, b: usize, ctx: &Ctx) {
        let Some(s) = sample_at(ctx.samples, self.sample) else {
            for v in self.voices.iter_mut() {
                v.active = false;
            }
            return;
        };
        let g0 = self.gain;
        let g1 = clampf(self.p[ap::GAIN], 0.0, 2.0);
        self.gain = g1;
        let reverse = self.p[ap::REVERSE] >= 0.5;
        let semis = clampf(self.p[ap::TUNE] + ctx.pitch, -96.0, 96.0);
        let step = s.rate as f64 / self.rate as f64 * fast_exp2(semis / 12.0) as f64;
        let n = (b - a).max(1) as f32;
        let end = s.frames as f64;
        for v in self.voices.iter_mut() {
            if !v.active {
                continue;
            }
            for i in a..b {
                if v.pos < 0.0 || v.pos >= end {
                    v.active = false;
                    break;
                }
                let (x, y) = s.read(v.pos);
                v.pos += if reverse { -step } else { step };
                v.fade += v.fade_step;
                if v.fade >= 1.0 {
                    v.fade = 1.0;
                } else if v.fade <= 0.0 && v.fade_step < 0.0 {
                    v.active = false;
                    break;
                }
                let g = v.fade * v.gain * lerp(g0, g1, (i - a + 1) as f32 / n);
                l[i] += x * g;
                r[i] += y * g;
            }
        }
    }
}
