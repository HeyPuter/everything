//! Poly Synth: two PolyBLEP oscillators with unison, a sub oscillator and
//! noise into a TPT state-variable filter with its own envelope, an amp ADSR,
//! a free-running LFO, glide and a mono legato mode.

use crate::dsp::*;
use crate::params::synth::*;
use crate::Ctx;

const MAX_VOICES: usize = 16;
const MAX_UNI: usize = 7;
const HELD: usize = 16;

/// Control values shared by all voices for one control period.
struct Ctl {
    n: usize,
    ratio: [f32; MAX_UNI],
    ul: [f32; MAX_UNI],
    ur: [f32; MAX_UNI],
    w1: u8,
    w2: u8,
    off1: f32,
    off2: f32,
    l1: f32,
    l2: f32,
    sub: f32,
    noise: f32,
    cutoff: f32,
    k: f32,
    ftype: u8,
    fenv: f32,
    fkey: f32,
    vcut: f32,
    lfo: f32,
    lfo_pitch: f32,
    lfo_cut: f32,
    trem: f32,
    gain: f32,
}

#[derive(Clone, Copy)]
struct Voice {
    active: bool,
    gate: bool,
    id: u32,
    key: u8,
    vel: f32,
    vamp: f32,
    pl: f32,
    pr: f32,
    age: u32,
    pitch: f32,
    target: f32,
    glide: f32, // semitones per sample
    ph1: [f32; MAX_UNI],
    ph2: [f32; MAX_UNI],
    sub: f32,
    dt1: [f32; MAX_UNI],
    dt2: [f32; MAX_UNI],
    dsub: f32,
    amp: Adsr,
    fenv: Adsr,
    coef: SvfCoef,
    fl: Svf,
    fr: Svf,
    rng: Rng,
    gprev: f32,
}

impl Voice {
    const fn new() -> Self {
        Voice {
            active: false,
            gate: false,
            id: 0,
            key: 60,
            vel: 1.0,
            vamp: 1.0,
            pl: 1.0,
            pr: 1.0,
            age: 0,
            pitch: 60.0,
            target: 60.0,
            glide: 0.0,
            ph1: [0.0; MAX_UNI],
            ph2: [0.0; MAX_UNI],
            sub: 0.0,
            dt1: [0.0; MAX_UNI],
            dt2: [0.0; MAX_UNI],
            dsub: 0.0,
            amp: Adsr::new(),
            fenv: Adsr::new(),
            coef: SvfCoef::new(),
            fl: Svf::new(),
            fr: Svf::new(),
            rng: Rng(0x1234_5678),
            gprev: 0.0,
        }
    }
}

pub struct Synth {
    p: [f32; COUNT],
    sm: [f32; COUNT],
    fresh: bool,
    voices: [Voice; MAX_VOICES],
    amp_t: Adsr,
    flt_t: Adsr,
    env_dirty: bool,
    lfo_phase: f32,
    lfo_hold: f32,
    rng: Rng,
    held: [(u32, u8, f32, f32); HELD],
    held_n: usize,
    last_pitch: f32,
    clock: u32,
    rate: f32,
    smooth_coef: f32,
}

#[inline]
fn osc(wave: u8, ph: f32, dt: f32, rng: &mut Rng) -> f32 {
    match wave {
        0 => sin_turns(ph),
        1 => 1.0 - 4.0 * (ph - 0.5).abs(),
        2 => 2.0 * ph - 1.0 - poly_blep(ph, dt),
        3 => {
            let mut p2 = ph + 0.5;
            if p2 >= 1.0 {
                p2 -= 1.0;
            }
            (if ph < 0.5 { 1.0 } else { -1.0 }) + poly_blep(ph, dt) - poly_blep(p2, dt)
        }
        4 => {
            let mut p2 = ph + 0.75;
            if p2 >= 1.0 {
                p2 -= 1.0;
            }
            (if ph < 0.25 { 1.0 } else { -1.0 }) + poly_blep(ph, dt) - poly_blep(p2, dt) + 0.5
        }
        _ => rng.bipolar(),
    }
}

impl Synth {
    pub fn new(rate: f32) -> Box<Self> {
        let mut s = Box::new(Synth {
            p: DEFAULTS,
            sm: DEFAULTS,
            fresh: true,
            voices: [Voice::new(); MAX_VOICES],
            amp_t: Adsr::new(),
            flt_t: Adsr::new(),
            env_dirty: true,
            lfo_phase: 0.0,
            lfo_hold: 0.0,
            rng: Rng(0x9e37_79b9),
            held: [(0, 0, 0.0, 0.0); HELD],
            held_n: 0,
            last_pitch: -1.0,
            clock: 0,
            rate,
            smooth_coef: 1.0 - (-(CR as f32) / (0.012 * rate)).exp(),
        });
        for (i, v) in s.voices.iter_mut().enumerate() {
            v.rng = Rng(0x2545_f491 ^ ((i as u32 + 1) * 0x9e37_79b9));
        }
        s
    }

    pub fn set_param(&mut self, i: usize, v: f32) {
        if i >= COUNT || !v.is_finite() {
            return;
        }
        self.p[i] = v;
        if self.fresh {
            self.sm[i] = v;
        }
        if (F_ATTACK..=A_RELEASE).contains(&i) {
            self.env_dirty = true;
        }
    }

    /// Called after the initial parameter vector so smoothing starts at the set values.
    pub fn settle(&mut self) {
        self.sm = self.p;
        self.fresh = false;
    }

    pub fn active(&self) -> bool {
        self.voices.iter().any(|v| v.active)
    }

    fn mono(&self) -> bool {
        self.p[MONO] >= 0.5
    }

    fn glide_rate(&self, from: f32, to: f32) -> f32 {
        let ms = self.p[GLIDE];
        if ms <= 0.5 || from < 0.0 {
            0.0
        } else {
            (to - from).abs() / (ms * 0.001 * self.rate)
        }
    }

    fn start_voice(&mut self, vi: usize, id: u32, key: u8, vel: f32, pan: f32, from: f32) {
        self.clock = self.clock.wrapping_add(1);
        let n = clampf(self.p[UNISON], 1.0, MAX_UNI as f32).round() as usize;
        let glide = self.glide_rate(from, key as f32);
        let vel_amp = clampf(self.p[VEL_AMP], 0.0, 1.0);
        let (pl, pr) = balance(pan);
        let amp_t = self.amp_t;
        let flt_t = self.flt_t;
        let v = &mut self.voices[vi];
        let was_active = v.active;
        v.active = true;
        v.gate = true;
        v.id = id;
        v.key = key;
        v.vel = vel;
        v.vamp = 1.0 - vel_amp * (1.0 - clampf(vel, 0.0, 1.0));
        v.pl = pl;
        v.pr = pr;
        v.age = self.clock;
        v.target = key as f32;
        if glide > 0.0 {
            v.pitch = from;
            v.glide = glide;
        } else {
            v.pitch = key as f32;
            v.glide = 0.0;
        }
        if !was_active {
            // Free-running phases for unison, a fixed start for a single voice.
            for u in 0..MAX_UNI {
                let (a, b) = if n > 1 { (v.rng.unit(), v.rng.unit()) } else { (0.0, 0.0) };
                v.ph1[u] = a;
                v.ph2[u] = b;
            }
            v.sub = 0.0;
            v.fl.reset();
            v.fr.reset();
            v.amp.level = 0.0;
            v.fenv.level = 0.0;
            v.gprev = 0.0;
        }
        v.amp.copy_coefs(&amp_t);
        v.fenv.copy_coefs(&flt_t);
        v.amp.trigger();
        v.fenv.trigger();
    }

    fn pick_voice(&self) -> usize {
        if let Some(i) = self.voices.iter().position(|v| !v.active) {
            return i;
        }
        // Steal the quietest released voice, else the oldest.
        let mut best = usize::MAX;
        let mut lvl = f32::MAX;
        for (i, v) in self.voices.iter().enumerate() {
            if !v.gate && v.amp.level < lvl {
                lvl = v.amp.level;
                best = i;
            }
        }
        if best != usize::MAX {
            return best;
        }
        let mut oldest = 0;
        let mut age = 0;
        for (i, v) in self.voices.iter().enumerate() {
            let a = self.clock.wrapping_sub(v.age);
            if a >= age {
                oldest = i;
                age = a;
            }
        }
        oldest
    }

    pub fn note_on(&mut self, id: u32, key: u8, vel: f32, pan: f32) {
        self.update_env();
        if self.mono() {
            let legato = self.held_n > 0 && self.voices[0].active && self.voices[0].gate;
            if self.held_n == HELD {
                self.held.copy_within(1.., 0);
                self.held_n -= 1;
            }
            self.held[self.held_n] = (id, key, vel, pan);
            self.held_n += 1;
            for v in self.voices.iter_mut().skip(1) {
                v.gate = false;
                v.amp.release();
            }
            if legato {
                let from = self.voices[0].pitch;
                let g = self.glide_rate(from, key as f32);
                let v = &mut self.voices[0];
                v.id = id;
                v.key = key;
                v.target = key as f32;
                if g > 0.0 {
                    v.glide = g;
                } else {
                    v.pitch = key as f32;
                }
            } else {
                let from = if self.voices[0].active { self.voices[0].pitch } else { self.last_pitch };
                self.start_voice(0, id, key, vel, pan, from);
            }
        } else {
            let vi = self.pick_voice();
            let from = self.last_pitch;
            self.start_voice(vi, id, key, vel, pan, from);
        }
        self.last_pitch = key as f32;
    }

    pub fn note_off(&mut self, id: u32) {
        if self.mono() {
            let Some(pos) = self.held[..self.held_n].iter().position(|h| h.0 == id) else {
                // A note started before mono was switched on.
                for v in self.voices.iter_mut() {
                    if v.gate && v.id == id {
                        v.gate = false;
                        v.amp.release();
                        v.fenv.release();
                    }
                }
                return;
            };
            self.held.copy_within(pos + 1..self.held_n, pos);
            self.held_n -= 1;
            let v0 = self.voices[0];
            if v0.id != id {
                return;
            }
            if self.held_n > 0 {
                // Legato back to the last key still held.
                let (hid, key, _, _) = self.held[self.held_n - 1];
                let g = self.glide_rate(v0.pitch, key as f32);
                let v = &mut self.voices[0];
                v.id = hid;
                v.key = key;
                v.target = key as f32;
                if g > 0.0 {
                    v.glide = g;
                } else {
                    v.pitch = key as f32;
                }
                self.last_pitch = key as f32;
            } else {
                let v = &mut self.voices[0];
                v.gate = false;
                v.amp.release();
                v.fenv.release();
            }
            return;
        }
        for v in self.voices.iter_mut() {
            if v.gate && v.id == id {
                v.gate = false;
                v.amp.release();
                v.fenv.release();
            }
        }
    }

    pub fn all_off(&mut self, hard: bool) {
        self.held_n = 0;
        for v in self.voices.iter_mut() {
            v.gate = false;
            v.amp.release();
            v.fenv.release();
            if hard {
                v.active = false;
                v.amp.level = 0.0;
            }
        }
    }

    fn update_env(&mut self) {
        if !self.env_dirty {
            return;
        }
        self.env_dirty = false;
        let p = &self.p;
        self.amp_t.set(p[A_ATTACK], p[A_DECAY], p[A_SUSTAIN], p[A_RELEASE], self.rate);
        self.flt_t.set(p[F_ATTACK], p[F_DECAY], p[F_SUSTAIN], p[F_RELEASE], self.rate);
        let (a, f) = (self.amp_t, self.flt_t);
        for v in self.voices.iter_mut() {
            v.amp.copy_coefs(&a);
            v.fenv.copy_coefs(&f);
        }
    }

    fn control(&mut self, m: usize) -> Ctl {
        self.update_env();
        let c = self.smooth_coef;
        // Smooth continuous parameters (cutoff in the log domain).
        for &i in &[OSC1_FINE, OSC1_LEVEL, OSC2_FINE, OSC2_LEVEL, SUB_LEVEL, NOISE_LEVEL, DETUNE, SPREAD, RESO, FLT_ENV, FLT_KEY, LFO_PITCH, LFO_CUTOFF, LFO_AMP, VEL_CUTOFF, GAIN] {
            self.sm[i] += (self.p[i] - self.sm[i]) * c;
        }
        let tc = clampf(self.p[CUTOFF], 20.0, 20000.0);
        let lc = fast_log2(self.sm[CUTOFF].max(20.0));
        self.sm[CUTOFF] = fast_exp2(lc + (fast_log2(tc) - lc) * c);
        let sm = &self.sm;
        let p = &self.p;

        // LFO.
        let rate = clampf(p[LFO_RATE], 0.01, 50.0);
        let prev = self.lfo_phase;
        self.lfo_phase += rate * m as f32 / self.rate;
        if self.lfo_phase >= 1.0 {
            self.lfo_phase -= self.lfo_phase.floor();
        }
        if self.lfo_phase < prev {
            self.lfo_hold = self.rng.bipolar();
        }
        let ph = self.lfo_phase;
        let lfo = match p[LFO_WAVE].round() as i32 {
            0 => sin_turns(ph),
            1 => 1.0 - 4.0 * (ph - 0.5).abs(),
            2 => 2.0 * ph - 1.0,
            3 => {
                if ph < 0.5 {
                    1.0
                } else {
                    -1.0
                }
            }
            _ => self.lfo_hold,
        };

        let n = clampf(p[UNISON], 1.0, MAX_UNI as f32).round() as usize;
        let mut ctl = Ctl {
            n,
            ratio: [1.0; MAX_UNI],
            ul: [1.0; MAX_UNI],
            ur: [1.0; MAX_UNI],
            w1: clampf(p[OSC1_WAVE].round(), 0.0, 5.0) as u8,
            w2: clampf(p[OSC2_WAVE].round(), 0.0, 5.0) as u8,
            off1: p[OSC1_OCT].round() * 12.0 + p[OSC1_SEMI].round() + sm[OSC1_FINE] * 0.01,
            off2: p[OSC2_OCT].round() * 12.0 + p[OSC2_SEMI].round() + sm[OSC2_FINE] * 0.01,
            l1: sm[OSC1_LEVEL],
            l2: sm[OSC2_LEVEL],
            sub: sm[SUB_LEVEL],
            noise: sm[NOISE_LEVEL],
            cutoff: sm[CUTOFF],
            k: SvfCoef::reso_k(sm[RESO]),
            ftype: clampf(p[FLT_TYPE].round(), 0.0, 3.0) as u8,
            fenv: sm[FLT_ENV],
            fkey: sm[FLT_KEY],
            vcut: sm[VEL_CUTOFF],
            lfo,
            lfo_pitch: sm[LFO_PITCH] * 12.0,
            lfo_cut: sm[LFO_CUTOFF] * 4.0,
            trem: 1.0 - sm[LFO_AMP] * (0.5 + 0.5 * lfo),
            gain: sm[GAIN] * 0.5,
        };
        if n > 1 {
            let det = sm[DETUNE];
            let spread = clampf(sm[SPREAD], 0.0, 1.0);
            let norm = 1.0 / (n as f32).sqrt();
            for u in 0..n {
                let x = u as f32 / (n - 1) as f32 * 2.0 - 1.0; // -1..1
                ctl.ratio[u] = fast_exp2(det * 0.5 * x / 1200.0);
                let pan = x * spread;
                let a = (pan + 1.0) * 0.25 * PI;
                ctl.ul[u] = a.cos() * 1.414 * norm;
                ctl.ur[u] = a.sin() * 1.414 * norm;
            }
        }
        ctl
    }

    pub fn render(&mut self, l: &mut [f32], r: &mut [f32], a: usize, b: usize, ctx: &Ctx) {
        let mut i = a;
        let rate = self.rate;
        while i < b {
            let m = (b - i).min(CR);
            let ctl = self.control(m);
            let inv_m = 1.0 / m as f32;
            for v in self.voices.iter_mut() {
                if !v.active {
                    continue;
                }
                // Glide toward the target pitch.
                if v.pitch != v.target {
                    let step = if v.glide > 0.0 { v.glide * m as f32 } else { 1e9 };
                    let d = v.target - v.pitch;
                    v.pitch = if d.abs() <= step { v.target } else { v.pitch + step * d.signum() };
                }
                let note = v.pitch + ctx.pitch + ctl.lfo * ctl.lfo_pitch;
                let base1 = note_hz(note + ctl.off1) / rate;
                let base2 = note_hz(note + ctl.off2) / rate;
                for u in 0..ctl.n {
                    v.dt1[u] = (base1 * ctl.ratio[u]).min(0.45);
                    v.dt2[u] = (base2 * ctl.ratio[u]).min(0.45);
                }
                v.dsub = (base1 * 0.5).min(0.45);
                // Filter cutoff for this period.
                let fe = v.fenv.level;
                for _ in 0..m {
                    v.fenv.next();
                }
                let oct = fe * ctl.fenv * 6.0 + (v.key as f32 - 60.0) / 12.0 * ctl.fkey + ctl.lfo * ctl.lfo_cut + ctl.vcut * (v.vel - 1.0) * 3.0;
                let fc = clampf(ctl.cutoff * fast_exp2(oct), 20.0, 20000.0);
                v.coef.set(fc, ctl.k, rate, ctl.ftype);
                v.fl.flush();
                v.fr.flush();
                let in_gain = 1.0 - 0.4 * (1.0 - ctl.k / 1.434);
                let g1 = ctl.gain * v.vamp * ctl.trem;
                let g0 = if v.gprev == 0.0 { g1 } else { v.gprev };
                v.gprev = g1;
                let use1 = ctl.l1 > 1e-4;
                let use2 = ctl.l2 > 1e-4;
                for j in 0..m {
                    let mut sl = 0.0;
                    let mut sr = 0.0;
                    for u in 0..ctl.n {
                        let mut s = 0.0;
                        if use1 {
                            s += osc(ctl.w1, v.ph1[u], v.dt1[u], &mut v.rng) * ctl.l1;
                            v.ph1[u] += v.dt1[u];
                            if v.ph1[u] >= 1.0 {
                                v.ph1[u] -= 1.0;
                            }
                        }
                        if use2 {
                            s += osc(ctl.w2, v.ph2[u], v.dt2[u], &mut v.rng) * ctl.l2;
                            v.ph2[u] += v.dt2[u];
                            if v.ph2[u] >= 1.0 {
                                v.ph2[u] -= 1.0;
                            }
                        }
                        sl += s * ctl.ul[u];
                        sr += s * ctl.ur[u];
                    }
                    let mut common = 0.0;
                    if ctl.sub > 1e-4 {
                        common += sin_turns(v.sub) * ctl.sub;
                        v.sub += v.dsub;
                        if v.sub >= 1.0 {
                            v.sub -= 1.0;
                        }
                    }
                    if ctl.noise > 1e-4 {
                        common += v.rng.bipolar() * ctl.noise * 0.7;
                    }
                    sl = (sl + common) * in_gain;
                    sr = (sr + common) * in_gain;
                    let yl = v.fl.run(&v.coef, sl);
                    let yr = v.fr.run(&v.coef, sr);
                    let env = v.amp.next();
                    let t = (j + 1) as f32 * inv_m;
                    let g = env * lerp(g0, g1, t);
                    l[i + j] += yl * g * v.pl;
                    r[i + j] += yr * g * v.pr;
                }
                if !v.amp.active() {
                    v.active = false;
                    v.gate = false;
                }
            }
            i += m;
        }
    }
}

impl Adsr {
    pub fn copy_coefs(&mut self, t: &Adsr) {
        let (stage, level) = (self.stage, self.level);
        *self = *t;
        self.stage = stage;
        self.level = level;
    }
}
