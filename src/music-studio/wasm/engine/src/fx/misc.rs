//! Phaser, distortion, bitcrusher, multimode filter and stereo tool.

use crate::dsp::*;

// ------------------------------------------------------------------ phaser

const PN: usize = 6;
const P_DEFAULTS: [f32; PN] = [0.4, 0.7, 2.0, 0.4, 900.0, 0.5];
const STAGES: [usize; 5] = [2, 4, 6, 8, 12];

pub struct Phaser {
    pub p: Params<PN>,
    zl: [f32; 12],
    zr: [f32; 12],
    fbl: f32,
    fbr: f32,
    phase: f32,
    rate: f32,
    sc: f32,
}

impl Phaser {
    pub fn new(rate: f32) -> Box<Self> {
        Box::new(Phaser { p: Params::new(&P_DEFAULTS, &[true, true, false, true, true, true]), zl: [0.0; 12], zr: [0.0; 12], fbl: 0.0, fbr: 0.0, phase: 0.0, rate, sc: block_coef(0.02, rate, BLOCK) })
    }

    pub fn reset(&mut self) {
        self.zl = [0.0; 12];
        self.zr = [0.0; 12];
        self.fbl = 0.0;
        self.fbr = 0.0;
    }

    #[inline]
    fn coef(hz: f32, rate: f32) -> f32 {
        let t = (PI * clampf(hz, 20.0, rate * 0.45) / rate).tan();
        (t - 1.0) / (t + 1.0)
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        self.p.step(self.sc);
        let p = &self.p;
        let rate_hz = clampf(p.get(0), 0.01, 20.0);
        let depth = clampf(p.get(1), 0.0, 1.0);
        let stages = STAGES[clampf(p.get(2).round(), 0.0, 4.0) as usize];
        let fb = clampf(p.get(3), 0.0, 0.95);
        let center = clampf(p.get(4), 50.0, 12_000.0);
        let wet = clampf(p.get(5), 0.0, 1.0);
        let n = l.len();
        let inc = rate_hz / self.rate;
        let mut i = 0;
        while i < n {
            let m = (n - i).min(CR);
            let lf = sin_turns(self.phase);
            let rf = sin_turns(self.phase + 0.25);
            self.phase += inc * m as f32;
            self.phase -= self.phase.floor();
            let al = Self::coef(center * fast_exp2(depth * 2.0 * lf), self.rate);
            let ar = Self::coef(center * fast_exp2(depth * 2.0 * rf), self.rate);
            for j in i..i + m {
                let (xl, xr) = (l[j], r[j]);
                let mut yl = xl + self.fbl * fb;
                let mut yr = xr + self.fbr * fb;
                for s in 0..stages {
                    let ol = al * yl + self.zl[s];
                    self.zl[s] = yl - al * ol;
                    yl = ol;
                    let or = ar * yr + self.zr[s];
                    self.zr[s] = yr - ar * or;
                    yr = or;
                }
                self.fbl = undenorm(yl);
                self.fbr = undenorm(yr);
                l[j] = xl * (1.0 - wet) + yl * wet;
                r[j] = xr * (1.0 - wet) + yr * wet;
            }
            i += m;
        }
        for z in self.zl.iter_mut().chain(self.zr.iter_mut()) {
            *z = undenorm(*z);
        }
        if !self.fbl.is_finite() || !self.fbr.is_finite() {
            self.reset();
        }
    }
}

// ------------------------------------------------------------------ distortion

const DN: usize = 5;
const D_DEFAULTS: [f32; DN] = [0.0, 12.0, 8000.0, -6.0, 1.0];

pub struct Distortion {
    pub p: Params<DN>,
    tl: Svf,
    tr: Svf,
    dcl: OnePole,
    dcr: OnePole,
    coef: SvfCoef,
    rate: f32,
    sc: f32,
}

#[inline]
fn shape(kind: u8, x: f32) -> f32 {
    match kind {
        0 => fast_tanh(x),
        1 => clampf(x, -1.0, 1.0),
        2 => {
            // Asymmetric tube-like curve: softer on the negative half.
            if x >= 0.0 {
                fast_tanh(x)
            } else {
                fast_tanh(x * 0.6) / 0.6 * 0.8
            }
        }
        _ => sin_turns(x * 0.25),
    }
}

impl Distortion {
    pub fn new(rate: f32) -> Box<Self> {
        Box::new(Distortion {
            p: Params::new(&D_DEFAULTS, &[false, true, true, true, true]),
            tl: Svf::new(),
            tr: Svf::new(),
            dcl: OnePole::default(),
            dcr: OnePole::default(),
            coef: SvfCoef::new(),
            rate,
            sc: block_coef(0.02, rate, BLOCK),
        })
    }

    pub fn reset(&mut self) {
        self.tl.reset();
        self.tr.reset();
        self.dcl.z = 0.0;
        self.dcr.z = 0.0;
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        self.p.step(self.sc);
        let p = &self.p;
        let kind = clampf(p.get(0).round(), 0.0, 3.0) as u8;
        let drive = db_to_gain(clampf(p.get(1), -24.0, 60.0));
        self.coef.set(clampf(p.get(2), 20.0, 20_000.0), 1.0, self.rate, 0);
        let out = db_to_gain(clampf(p.get(3), -60.0, 24.0));
        let wet = clampf(p.get(4), 0.0, 1.0);
        let dca = OnePole::coef(10.0, self.rate);
        let c = self.coef;
        let bias = if kind == 2 { 0.1 } else { 0.0 };
        for i in 0..l.len() {
            let (xl, xr) = (l[i], r[i]);
            let yl = self.dcl.hp(shape(kind, xl * drive + bias), dca);
            let yr = self.dcr.hp(shape(kind, xr * drive + bias), dca);
            let yl = self.tl.run(&c, yl) * out;
            let yr = self.tr.run(&c, yr) * out;
            l[i] = xl * (1.0 - wet) + yl * wet;
            r[i] = xr * (1.0 - wet) + yr * wet;
        }
        self.tl.flush();
        self.tr.flush();
    }
}

// ------------------------------------------------------------------ bitcrusher

const BN: usize = 3;
const B_DEFAULTS: [f32; BN] = [8.0, 4.0, 1.0];

pub struct Bitcrusher {
    pub p: Params<BN>,
    hold_l: f32,
    hold_r: f32,
    count: f32,
}

impl Bitcrusher {
    pub fn new(rate: f32) -> Box<Self> {
        let _ = rate;
        Box::new(Bitcrusher { p: Params::new(&B_DEFAULTS, &[false, false, true]), hold_l: 0.0, hold_r: 0.0, count: 0.0 })
    }

    pub fn reset(&mut self) {
        self.hold_l = 0.0;
        self.hold_r = 0.0;
        self.count = 0.0;
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        self.p.step(1.0);
        let bits = clampf(self.p.get(0), 1.0, 24.0);
        let levels = fast_exp2(bits - 1.0);
        let inv = 1.0 / levels;
        let ds = clampf(self.p.get(1).round(), 1.0, 64.0);
        let wet = clampf(self.p.get(2), 0.0, 1.0);
        for i in 0..l.len() {
            let (xl, xr) = (l[i], r[i]);
            self.count -= 1.0;
            if self.count <= 0.0 {
                self.count += ds;
                self.hold_l = (clampf(xl, -1.0, 1.0) * levels).round() * inv;
                self.hold_r = (clampf(xr, -1.0, 1.0) * levels).round() * inv;
            }
            l[i] = xl * (1.0 - wet) + self.hold_l * wet;
            r[i] = xr * (1.0 - wet) + self.hold_r * wet;
        }
    }
}

// ------------------------------------------------------------------ filter

const FN: usize = 5;
const F_DEFAULTS: [f32; FN] = [0.0, 2000.0, 0.3, 1.0, 0.0];

pub struct Filter {
    pub p: Params<FN>,
    fl: Svf,
    fr: Svf,
    phase: f32,
    rate: f32,
    sc: f32,
}

impl Filter {
    pub fn new(rate: f32) -> Box<Self> {
        Box::new(Filter { p: Params::new(&F_DEFAULTS, &[false, true, true, true, true]), fl: Svf::new(), fr: Svf::new(), phase: 0.0, rate, sc: block_coef(0.02, rate, BLOCK) })
    }

    pub fn reset(&mut self) {
        self.fl.reset();
        self.fr.reset();
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        self.p.step(self.sc);
        let p = &self.p;
        let mode = clampf(p.get(0).round(), 0.0, 3.0) as u8;
        let cutoff = clampf(p.get(1), 20.0, 20_000.0);
        let k = SvfCoef::reso_k(p.get(2));
        let inc = clampf(p.get(3), 0.01, 50.0) / self.rate;
        let depth = clampf(p.get(4), 0.0, 1.0) * 3.0;
        let n = l.len();
        let mut c = SvfCoef::new();
        let mut i = 0;
        while i < n {
            let m = (n - i).min(CR);
            let lfo = if depth > 0.0 { sin_turns(self.phase) } else { 0.0 };
            self.phase += inc * m as f32;
            self.phase -= self.phase.floor();
            c.set(cutoff * fast_exp2(lfo * depth), k, self.rate, mode);
            for j in i..i + m {
                l[j] = self.fl.run(&c, l[j]);
                r[j] = self.fr.run(&c, r[j]);
            }
            i += m;
        }
        self.fl.flush();
        self.fr.flush();
    }
}

// ------------------------------------------------------------------ stereo tool

const SN: usize = 4;
const S_DEFAULTS: [f32; SN] = [1.0, 0.0, 0.0, 20.0];

pub struct StereoTool {
    pub p: Params<SN>,
    hp: Biquad,
    coef: BiquadCoef,
    bal: (f32, f32),
    rate: f32,
    sc: f32,
}

impl StereoTool {
    pub fn new(rate: f32) -> Box<Self> {
        Box::new(StereoTool { p: Params::new(&S_DEFAULTS, &[true, true, false, true]), hp: Biquad::default(), coef: BiquadCoef::identity(), bal: (1.0, 1.0), rate, sc: block_coef(0.02, rate, BLOCK) })
    }

    pub fn reset(&mut self) {
        self.hp.reset();
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        self.p.step(self.sc);
        let p = &self.p;
        let width = clampf(p.get(0), 0.0, 4.0);
        let swap = p.get(2) >= 0.5;
        let mono_hz = p.get(3);
        let mono = mono_hz > 20.5;
        if mono {
            self.coef = BiquadCoef::highpass(mono_hz, 0.707, self.rate);
        }
        let (b0, b1) = (self.bal, balance(p.get(1)));
        self.bal = b1;
        let n = l.len();
        let inv = 1.0 / n.max(1) as f32;
        let c = self.coef;
        for i in 0..n {
            let (mut xl, mut xr) = (l[i], r[i]);
            if swap {
                core::mem::swap(&mut xl, &mut xr);
            }
            let m = (xl + xr) * 0.5;
            let mut s = (xl - xr) * 0.5;
            if mono {
                s = self.hp.run(&c, s);
            }
            s *= width;
            let t = (i + 1) as f32 * inv;
            l[i] = (m + s) * lerp(b0.0, b1.0, t);
            r[i] = (m - s) * lerp(b0.1, b1.1, t);
        }
        self.hp.flush();
    }
}
