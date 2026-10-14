//! Drum Synth: one synthesized drum voice per channel (the `kind` parameter),
//! built from pitch-enveloped sines, metallic square clusters and filtered
//! noise. Parameters are latched when a hit starts, except the level.

use crate::dsp::*;
use crate::params::drum::*;

const MAX_VOICES: usize = 8;
/// Square oscillator frequencies of the metallic cluster (hats, cymbal).
const METAL: [f32; 6] = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0];

#[derive(Clone, Copy)]
struct Voice {
    active: bool,
    id: u32,
    kind: u8,
    t: u32,
    vel: f32,
    choke: f32,
    choking: bool,
    ph: [f32; 6],
    dt: [f32; 6],
    f0: f32,
    e: [f32; 4],
    c: [f32; 4],
    pe: f32,
    pc: f32,
    sweep: f32,
    burst: u8,
    next_burst: u32,
    burst_gap: u32,
    svf: [Svf; 3],
    coef: [SvfCoef; 3],
    lp: OnePole,
    lpa: f32,
    hp: OnePole,
    hpa: f32,
    tone: f32,
    punch: f32,
    noise: f32,
    drive: f32,
    rng: Rng,
}

impl Voice {
    const fn new() -> Self {
        Voice {
            active: false,
            id: 0,
            kind: 0,
            t: 0,
            vel: 1.0,
            choke: 1.0,
            choking: false,
            ph: [0.0; 6],
            dt: [0.0; 6],
            f0: 50.0,
            e: [0.0; 4],
            c: [0.0; 4],
            pe: 0.0,
            pc: 0.0,
            sweep: 0.0,
            burst: 0,
            next_burst: 0,
            burst_gap: 0,
            svf: [Svf::new(); 3],
            coef: [SvfCoef::new(); 3],
            lp: OnePole { z: 0.0 },
            lpa: 1.0,
            hp: OnePole { z: 0.0 },
            hpa: 0.0,
            tone: 0.5,
            punch: 0.5,
            noise: 0.5,
            drive: 0.0,
            rng: Rng(1),
        }
    }
}

pub struct Drum {
    p: [f32; COUNT],
    gain: f32,
    voices: [Voice; MAX_VOICES],
    clock: u32,
    ages: [u32; MAX_VOICES],
    rate: f32,
    seed: u32,
    choke_coef: f32,
}

#[inline]
fn square(ph: f32) -> f32 {
    if ph < 0.5 {
        1.0
    } else {
        -1.0
    }
}

#[inline]
fn adv(ph: &mut f32, dt: f32) {
    *ph += dt;
    if *ph >= 1.0 {
        *ph -= 1.0;
    }
}

impl Drum {
    pub fn new(rate: f32) -> Box<Self> {
        Box::new(Drum {
            p: DEFAULTS,
            gain: DEFAULTS[GAIN],
            voices: [Voice::new(); MAX_VOICES],
            clock: 0,
            ages: [0; MAX_VOICES],
            rate,
            seed: 0x6d2b_79f5,
            choke_coef: tau_coef(0.003, rate),
        })
    }

    pub fn set_param(&mut self, i: usize, v: f32) {
        if i < COUNT && v.is_finite() {
            self.p[i] = v;
        }
    }

    pub fn settle(&mut self) {
        self.gain = self.p[GAIN];
    }

    pub fn kind(&self) -> u8 {
        clampf(self.p[KIND].round(), 0.0, (KINDS - 1) as f32) as u8
    }

    pub fn active(&self) -> bool {
        self.voices.iter().any(|v| v.active)
    }

    /// Fades out every sounding voice (hi-hat choke).
    pub fn choke(&mut self) {
        for v in self.voices.iter_mut() {
            if v.active {
                v.choking = true;
            }
        }
    }

    pub fn note_off(&mut self, _id: u32) {}

    pub fn all_off(&mut self, hard: bool) {
        for v in self.voices.iter_mut() {
            if hard {
                v.active = false;
            } else if v.active {
                v.choking = true;
            }
        }
    }

    pub fn note_on(&mut self, id: u32, key: u8, vel: f32, pitch: f32) {
        let kind = self.kind();
        if kind == CLOSED_HAT || kind == OPEN_HAT {
            self.choke();
        }
        let vi = match self.voices.iter().position(|v| !v.active) {
            Some(i) => i,
            None => {
                let mut best = 0;
                let mut age = 0;
                for i in 0..MAX_VOICES {
                    let a = self.clock.wrapping_sub(self.ages[i]);
                    if a >= age {
                        age = a;
                        best = i;
                    }
                }
                best
            }
        };
        self.clock = self.clock.wrapping_add(1);
        self.ages[vi] = self.clock;
        self.seed = self.seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let p = self.p;
        let rate = self.rate;
        let key_semis = if p[KEY_TRACK] >= 0.5 { key as f32 - 60.0 } else { 0.0 };
        let tr = fast_exp2((clampf(p[TUNE], -48.0, 48.0) + key_semis + pitch) / 12.0);
        let decay = clampf(p[DECAY], 0.05, 8.0);
        let tone = clampf(p[TONE], 0.0, 1.0);
        let punch = clampf(p[PUNCH], 0.0, 1.0);
        let noise = clampf(p[NOISE], 0.0, 1.0);
        let vel_amp = clampf(p[VEL_AMP], 0.0, 1.0);
        let v = &mut self.voices[vi];
        *v = Voice::new();
        v.active = true;
        v.id = id;
        v.kind = kind;
        v.vel = 1.0 - vel_amp * (1.0 - clampf(vel, 0.0, 1.0));
        v.tone = tone;
        v.punch = punch;
        v.noise = noise;
        v.drive = clampf(p[DRIVE], 0.0, 1.0);
        v.rng = Rng(self.seed | 1);
        let tc = |s: f32| tau_coef(s, rate);
        match kind {
            KICK => {
                v.f0 = 50.0 * tr;
                v.sweep = 2.5 + 5.5 * punch;
                v.pe = 1.0;
                v.pc = tc(0.010 + 0.025 * (1.0 - punch));
                v.e = [1.0, 1.0, 0.0, 0.0];
                v.c = [tc(0.15 * decay), tc(0.0025), 0.0, 0.0];
                v.lpa = OnePole::coef(1500.0 + 9000.0 * tone, rate);
            }
            SNARE => {
                v.f0 = 180.0 * tr;
                v.pe = 1.0;
                v.pc = tc(0.008);
                v.sweep = 0.5 * punch;
                v.e = [1.0, 1.0, 1.0, 0.0];
                v.c = [tc(0.045 * decay), tc(0.075 * decay), tc(0.005), 0.0];
                v.coef[0].set((1200.0 + 2500.0 * tone) * tr.sqrt(), 1.2, rate, 1);
                v.coef[1].set(5000.0 + 9000.0 * tone, 1.0, rate, 0);
            }
            CLAP => {
                v.e = [1.0, 0.0, 0.0, 0.0];
                v.c = [tc(0.0028), tc(0.11 * decay), 0.0, 0.0];
                v.burst = 1;
                v.burst_gap = (rate * (0.0095 - 0.003 * punch)) as u32;
                v.next_burst = v.burst_gap;
                v.coef[0].set((1000.0 + 1500.0 * tone) * tr, 0.9, rate, 2);
                v.coef[1].set(800.0 * tr, 1.2, rate, 1);
            }
            CLOSED_HAT | OPEN_HAT | CYMBAL => {
                let scale = tr * if kind == CYMBAL { 1.35 } else { 1.9 };
                for i in 0..6 {
                    v.dt[i] = (METAL[i] * scale / rate).min(0.45);
                    v.ph[i] = v.rng.unit();
                }
                let (bp, hp, tau) = match kind {
                    CLOSED_HAT => (9000.0 + 2500.0 * tone, 7000.0 + 2000.0 * tone, 0.022 * decay),
                    OPEN_HAT => (8500.0 + 2500.0 * tone, 6500.0 + 2000.0 * tone, 0.16 * decay),
                    _ => (5500.0 + 4000.0 * tone, 3500.0 + 3000.0 * tone, 0.5 * decay),
                };
                v.e = [1.0, 1.0, 0.0, 0.0];
                v.c = [tc(tau), tc(0.004), 0.0, 0.0];
                v.coef[0].set(bp.min(rate * 0.45), 1.0, rate, 2);
                v.coef[1].set(hp.min(rate * 0.45), 1.3, rate, 1);
                v.coef[2].set((hp * 1.1).min(rate * 0.45), 1.3, rate, 1);
            }
            TOM => {
                v.f0 = 105.0 * tr;
                v.sweep = 0.8 * punch + 0.2;
                v.pe = 1.0;
                v.pc = tc(0.04);
                v.e = [1.0, 1.0, 1.0, 0.0];
                v.c = [tc(0.13 * decay), tc(0.045 * decay), tc(0.004), 0.0];
                v.lpa = OnePole::coef(3000.0 + 6000.0 * tone, rate);
            }
            RIM => {
                v.dt[0] = (480.0 * tr / rate).min(0.45);
                v.dt[1] = (1680.0 * tr / rate).min(0.45);
                v.e = [1.0, 1.0, 1.0, 0.0];
                v.c = [tc(0.011 * decay), tc(0.006 * decay), tc(0.0018), 0.0];
                v.coef[0].set((2500.0 + 2500.0 * tone) * tr, 0.8, rate, 2);
                v.hpa = OnePole::coef(260.0, rate);
            }
            COWBELL => {
                v.dt[0] = (545.0 * tr / rate).min(0.45);
                v.dt[1] = (815.0 * tr / rate).min(0.45);
                v.e = [1.0, 1.0, 0.0, 0.0];
                v.c = [tc(0.012), tc(0.13 * decay), 0.0, 0.0];
                v.coef[0].set((900.0 + 900.0 * tone) * tr, 0.7, rate, 2);
                v.hpa = OnePole::coef(350.0, rate);
            }
            _ => {
                // Shaker: an attack ramp, then a short decay.
                v.e = [0.0, 0.0, 0.0, 0.0];
                v.c = [tc(0.045 * decay), 0.0, 0.0, 0.0];
                v.next_burst = (rate * (0.004 + 0.012 * (1.0 - punch))) as u32;
                v.coef[0].set((5000.0 + 4000.0 * tone) * tr, 1.0, rate, 2);
                v.coef[1].set(3500.0 * tr, 1.2, rate, 1);
            }
        }
    }

    pub fn render(&mut self, out_l: &mut [f32], out_r: &mut [f32], a: usize, b: usize) {
        // Level smoothing (the only live parameter).
        let g0 = self.gain;
        let g1 = clampf(self.p[GAIN], 0.0, 2.0);
        self.gain = g1;
        let rate = self.rate;
        let cc = self.choke_coef;
        let n = (b - a).max(1) as f32;
        for v in self.voices.iter_mut() {
            if !v.active {
                continue;
            }
            for i in a..b {
                let s = voice_sample(v, rate);
                let mut y = s;
                if v.drive > 0.001 {
                    let k = 1.0 + 8.0 * v.drive;
                    y = fast_tanh(y * k) / fast_tanh(k) * 0.9;
                }
                if v.choking {
                    v.choke *= cc;
                    if v.choke < 1e-4 {
                        v.active = false;
                    }
                }
                let g = lerp(g0, g1, (i - a + 1) as f32 / n) * v.vel * v.choke;
                let y = y * g;
                out_l[i] += y;
                out_r[i] += y;
                if !v.active {
                    break;
                }
            }
            for s in v.svf.iter_mut() {
                s.flush();
            }
        }
    }
}

/// One sample of a drum voice; deactivates the voice when it has decayed.
#[inline]
fn voice_sample(v: &mut Voice, rate: f32) -> f32 {
    v.t += 1;
    let out;
    match v.kind {
        KICK => {
            let f = v.f0 * (1.0 + v.sweep * v.pe);
            v.pe *= v.pc;
            adv(&mut v.ph[0], f / rate);
            let body = sin_turns(v.ph[0]);
            let shaped = if v.tone > 0.0 { fast_tanh(body * (1.0 + v.tone * 1.5)) / fast_tanh(1.0 + v.tone * 1.5) } else { body };
            let click = v.lp.lp(v.rng.bipolar(), v.lpa) * (0.35 * v.noise + 0.25 * v.punch);
            out = shaped * v.e[0] * 0.95 + click * v.e[1] * 2.0;
            v.e[0] *= v.c[0];
            v.e[1] *= v.c[1];
            if v.e[0] < 1e-4 {
                v.active = false;
            }
        }
        SNARE => {
            let f = v.f0 * (1.0 + v.sweep * v.pe);
            v.pe *= v.pc;
            adv(&mut v.ph[0], f / rate);
            adv(&mut v.ph[1], f * 1.58 / rate);
            let body = sin_turns(v.ph[0]) * 0.65 + sin_turns(v.ph[1]) * 0.35;
            let nz = v.rng.bipolar();
            let h = v.svf[0].run(&v.coef[0], nz);
            let nzf = v.svf[1].run(&v.coef[1], h);
            let body_l = 1.0 - 0.55 * v.noise;
            let noise_l = 0.25 + 0.75 * v.noise;
            out = body * body_l * v.e[0] * 0.8 + nzf * noise_l * (v.e[1] + v.punch * 0.8 * v.e[2]) * 0.75;
            v.e[0] *= v.c[0];
            v.e[1] *= v.c[1];
            v.e[2] *= v.c[2];
            if v.e[0] < 1e-4 && v.e[1] < 1e-4 {
                v.active = false;
            }
        }
        CLAP => {
            if v.burst < 4 && v.t >= v.next_burst {
                v.burst += 1;
                v.next_burst += v.burst_gap;
                v.e[0] = 1.0;
                if v.burst == 4 {
                    v.e[1] = 1.0;
                }
            }
            let nz = v.rng.bipolar();
            let bp = v.svf[0].run(&v.coef[0], nz);
            let hp = v.svf[1].run(&v.coef[1], nz);
            let env = if v.e[0] > v.e[1] * 0.75 { v.e[0] } else { v.e[1] * 0.75 };
            out = (bp * 1.8 + hp * 0.35 * v.noise) * env;
            v.e[0] *= v.c[0];
            v.e[1] *= v.c[1];
            if v.burst >= 4 && v.e[1] < 1e-4 {
                v.active = false;
            }
        }
        CLOSED_HAT | OPEN_HAT | CYMBAL => {
            let mut m = 0.0;
            for i in 0..6 {
                m += square(v.ph[i]);
                adv(&mut v.ph[i], v.dt[i]);
            }
            m *= 1.0 / 6.0;
            let bp = v.svf[0].run(&v.coef[0], m);
            let metal = v.svf[1].run(&v.coef[1], bp);
            let nz = v.svf[2].run(&v.coef[2], v.rng.bipolar());
            let mix = metal * (1.4 - 0.6 * v.noise) + nz * (0.15 + 0.6 * v.noise);
            let att = if v.kind == CYMBAL { 1.0 + 0.6 * v.e[1] } else { 1.0 + 0.4 * v.e[1] };
            out = mix * v.e[0] * att * 1.1;
            v.e[0] *= v.c[0];
            v.e[1] *= v.c[1];
            if v.e[0] < 1e-4 {
                v.active = false;
            }
        }
        TOM => {
            let f = v.f0 * (1.0 + v.sweep * v.pe);
            v.pe *= v.pc;
            adv(&mut v.ph[0], f / rate);
            adv(&mut v.ph[1], f * 1.5 / rate);
            let body = sin_turns(v.ph[0]) * v.e[0] + sin_turns(v.ph[1]) * v.e[1] * 0.25 * (0.3 + v.tone);
            let click = v.lp.lp(v.rng.bipolar(), v.lpa) * v.e[2] * (0.2 + 0.6 * v.noise);
            out = body * 0.9 + click;
            v.e[0] *= v.c[0];
            v.e[1] *= v.c[1];
            v.e[2] *= v.c[2];
            if v.e[0] < 1e-4 {
                v.active = false;
            }
        }
        RIM => {
            let tri = 1.0 - 4.0 * (v.ph[0] - 0.5).abs();
            adv(&mut v.ph[0], v.dt[0]);
            let sn = sin_turns(v.ph[1]);
            adv(&mut v.ph[1], v.dt[1]);
            let click = v.svf[0].run(&v.coef[0], v.rng.bipolar());
            let x = tri * v.e[0] * 0.6 + sn * v.e[1] * 0.5 + click * v.e[2] * (0.5 + v.noise);
            out = v.hp.hp(x, v.hpa) * 1.2;
            v.e[0] *= v.c[0];
            v.e[1] *= v.c[1];
            v.e[2] *= v.c[2];
            if v.e[0] < 1e-4 && v.e[1] < 1e-4 {
                v.active = false;
            }
        }
        COWBELL => {
            let x = square(v.ph[0]) + square(v.ph[1]);
            adv(&mut v.ph[0], v.dt[0]);
            adv(&mut v.ph[1], v.dt[1]);
            let y = v.svf[0].run(&v.coef[0], x);
            let env = 0.55 * v.e[0] + 0.45 * v.e[1];
            out = v.hp.hp(y, v.hpa) * env * 0.9;
            v.e[0] *= v.c[0];
            v.e[1] *= v.c[1];
            if v.e[1] < 1e-4 {
                v.active = false;
            }
        }
        _ => {
            // Shaker.
            let env = if v.t < v.next_burst {
                v.t as f32 / v.next_burst as f32
            } else {
                if v.e[0] == 0.0 {
                    v.e[0] = 1.0;
                }
                let e = v.e[0];
                v.e[0] *= v.c[0];
                if v.e[0] < 1e-4 {
                    v.active = false;
                }
                e
            };
            let nz = v.rng.bipolar();
            let bp = v.svf[0].run(&v.coef[0], nz);
            let y = v.svf[1].run(&v.coef[1], bp);
            out = y * env * (1.3 + 0.5 * v.noise);
        }
    }
    if v.t > (rate * 12.0) as u32 {
        v.active = false;
    }
    out
}
