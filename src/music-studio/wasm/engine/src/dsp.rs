//! Shared DSP building blocks: fast math, oscillators helpers, envelopes,
//! filters and parameter smoothing. Nothing here allocates.

pub const BLOCK: usize = 128;
/// Control-rate period in samples (pitch, filter coefficients, LFOs).
pub const CR: usize = 16;

pub const PI: f32 = core::f32::consts::PI;

#[inline]
pub fn clampf(x: f32, lo: f32, hi: f32) -> f32 {
    if x < lo {
        lo
    } else if x > hi {
        hi
    } else {
        x
    }
}

#[inline]
pub fn db_to_gain(db: f32) -> f32 {
    fast_exp2(db * 0.166_096_4)
}

/// Fast 2^x, about 5e-6 relative error.
#[inline]
pub fn fast_exp2(x: f32) -> f32 {
    let x = clampf(x, -126.0, 126.0);
    let xi = x.floor();
    let f = x - xi;
    // Polynomial for 2^f on [0, 1).
    let p = 1.0 + f * (0.693_018_6 + f * (0.241_405_3 + f * (0.052_072_97 + f * 0.013_494_05)));
    let bits = ((xi as i32 + 127) as u32) << 23;
    f32::from_bits(bits) * p
}

/// Fast log2 for x > 0, about 3e-5 absolute error.
#[inline]
pub fn fast_log2(x: f32) -> f32 {
    let x = if x < 1e-30 { 1e-30 } else { x };
    let bits = x.to_bits();
    let e = ((bits >> 23) & 0xff) as i32 - 127;
    let m = f32::from_bits((bits & 0x007f_ffff) | 0x3f80_0000); // [1, 2)
    let t = m - 1.0;
    let p = t * (1.441_825_1 + t * (-0.708_674_9 + t * (0.415_397_8 + t * (-0.194_390_4 + t * 0.045_870_75))));
    e as f32 + p
}

#[inline]
pub fn gain_to_db(g: f32) -> f32 {
    6.020_6 * fast_log2(g)
}

/// Rational tanh approximation, exact at the clip points.
#[inline]
pub fn fast_tanh(x: f32) -> f32 {
    if x > 3.0 {
        1.0
    } else if x < -3.0 {
        -1.0
    } else {
        let x2 = x * x;
        x * (27.0 + x2) / (27.0 + 9.0 * x2)
    }
}

/// sin(2 pi p) for any p (turns), about 1e-3 error.
#[inline]
pub fn sin_turns(p: f32) -> f32 {
    let mut x = p - p.floor();
    if x > 0.5 {
        x -= 1.0;
    }
    let y = 8.0 * x - 16.0 * x * x.abs();
    0.225 * (y * y.abs() - y) + y
}

/// MIDI note number (fractional) to Hz.
#[inline]
pub fn note_hz(note: f32) -> f32 {
    440.0 * fast_exp2((note - 69.0) * (1.0 / 12.0))
}

/// Zeroes tiny values so recursive filters never run on denormals.
#[inline]
pub fn undenorm(x: f32) -> f32 {
    if x.abs() < 1e-15 {
        0.0
    } else {
        x
    }
}

/// Band-limited step correction (PolyBLEP) at phase `t` with increment `dt`.
#[inline]
pub fn poly_blep(t: f32, dt: f32) -> f32 {
    if t < dt {
        let x = t / dt;
        x + x - x * x - 1.0
    } else if t > 1.0 - dt {
        let x = (t - 1.0) / dt;
        x * x + x + x + 1.0
    } else {
        0.0
    }
}

/// xorshift32 noise source.
#[derive(Clone, Copy)]
pub struct Rng(pub u32);

impl Rng {
    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
    /// Uniform in [-1, 1).
    #[inline]
    pub fn bipolar(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 * (2.0 / 16_777_216.0) - 1.0
    }
    /// Uniform in [0, 1).
    #[inline]
    pub fn unit(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 * (1.0 / 16_777_216.0)
    }
}

/// One-pole coefficient for a time constant in seconds.
#[inline]
pub fn tau_coef(seconds: f32, rate: f32) -> f32 {
    if seconds <= 0.0 {
        0.0
    } else {
        (-1.0 / (seconds * rate)).exp()
    }
}

// ------------------------------------------------------------------ envelope

#[derive(Clone, Copy, PartialEq)]
pub enum Stage {
    Idle,
    Attack,
    Decay,
    Sustain,
    Release,
}

/// ADSR: linear attack, exponential decay and release (-60 dB over the set time).
#[derive(Clone, Copy)]
pub struct Adsr {
    pub stage: Stage,
    pub level: f32,
    att_inc: f32,
    dec_coef: f32,
    sus: f32,
    rel_coef: f32,
}

impl Adsr {
    pub const fn new() -> Self {
        Adsr { stage: Stage::Idle, level: 0.0, att_inc: 1.0, dec_coef: 0.0, sus: 1.0, rel_coef: 0.0 }
    }

    /// Times in milliseconds, sustain 0..1.
    pub fn set(&mut self, a: f32, d: f32, s: f32, r: f32, rate: f32) {
        let a = if a < 0.5 { 0.5 } else { a };
        self.att_inc = 1.0 / (a * 0.001 * rate);
        self.dec_coef = (-6.9 / (d.max(1.0) * 0.001 * rate)).exp();
        self.sus = clampf(s, 0.0, 1.0);
        self.rel_coef = (-6.9 / (r.max(1.0) * 0.001 * rate)).exp();
    }

    pub fn trigger(&mut self) {
        self.stage = Stage::Attack;
    }

    pub fn release(&mut self) {
        if self.stage != Stage::Idle {
            self.stage = Stage::Release;
        }
    }

    pub fn active(&self) -> bool {
        self.stage != Stage::Idle
    }

    #[inline]
    pub fn next(&mut self) -> f32 {
        match self.stage {
            Stage::Idle => 0.0,
            Stage::Attack => {
                self.level += self.att_inc;
                if self.level >= 1.0 {
                    self.level = 1.0;
                    self.stage = Stage::Decay;
                }
                self.level
            }
            Stage::Decay => {
                self.level = self.sus + (self.level - self.sus) * self.dec_coef;
                if self.level - self.sus < 1e-4 {
                    self.level = self.sus;
                    self.stage = Stage::Sustain;
                }
                self.level
            }
            Stage::Sustain => {
                // Follows sustain changes smoothly.
                self.level += (self.sus - self.level) * 0.002;
                if self.sus <= 0.0 && self.level < 1e-4 {
                    self.level = 0.0;
                    self.stage = Stage::Idle;
                }
                self.level
            }
            Stage::Release => {
                self.level *= self.rel_coef;
                if self.level < 1e-4 {
                    self.level = 0.0;
                    self.stage = Stage::Idle;
                }
                self.level
            }
        }
    }
}

// ------------------------------------------------------------------ SVF

/// Topology-preserving-transform state variable filter (one channel).
#[derive(Clone, Copy, Default)]
pub struct Svf {
    ic1: f32,
    ic2: f32,
}

/// Coefficients shared by any number of Svf states.
#[derive(Clone, Copy)]
pub struct SvfCoef {
    a1: f32,
    a2: f32,
    a3: f32,
    k: f32,
    pub mode: u8, // 0 low, 1 high, 2 band, 3 notch
}

impl SvfCoef {
    pub const fn new() -> Self {
        SvfCoef { a1: 1.0, a2: 0.0, a3: 0.0, k: 1.414, mode: 0 }
    }

    /// `k` = 1/Q.
    pub fn set(&mut self, hz: f32, k: f32, rate: f32, mode: u8) {
        let f = clampf(hz, 10.0, rate * 0.48);
        let g = (PI * f / rate).tan();
        self.k = k;
        self.a1 = 1.0 / (1.0 + g * (g + k));
        self.a2 = g * self.a1;
        self.a3 = g * self.a2;
        self.mode = mode;
    }

    /// Resonance 0..1 to damping (Q from 0.707 to about 50).
    pub fn reso_k(reso: f32) -> f32 {
        let r = 1.0 - clampf(reso, 0.0, 1.0);
        1.414 * r * r.sqrt() + 0.02
    }
}

impl Svf {
    pub const fn new() -> Self {
        Svf { ic1: 0.0, ic2: 0.0 }
    }

    #[inline]
    pub fn run(&mut self, c: &SvfCoef, v0: f32) -> f32 {
        let v3 = v0 - self.ic2;
        let v1 = c.a1 * self.ic1 + c.a2 * v3;
        let v2 = self.ic2 + c.a2 * self.ic1 + c.a3 * v3;
        self.ic1 = 2.0 * v1 - self.ic1;
        self.ic2 = 2.0 * v2 - self.ic2;
        match c.mode {
            0 => v2,
            1 => v0 - c.k * v1 - v2,
            2 => v1,
            _ => v0 - c.k * v1,
        }
    }

    pub fn reset(&mut self) {
        self.ic1 = 0.0;
        self.ic2 = 0.0;
    }

    pub fn flush(&mut self) {
        self.ic1 = undenorm(self.ic1);
        self.ic2 = undenorm(self.ic2);
        if !self.ic1.is_finite() || !self.ic2.is_finite() {
            self.reset();
        }
    }
}

// ------------------------------------------------------------------ biquad

#[derive(Clone, Copy)]
pub struct BiquadCoef {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
}

#[derive(Clone, Copy, Default)]
pub struct Biquad {
    z1: f32,
    z2: f32,
}

impl BiquadCoef {
    pub const fn identity() -> Self {
        BiquadCoef { b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0 }
    }

    fn norm(b0: f32, b1: f32, b2: f32, a0: f32, a1: f32, a2: f32) -> Self {
        let i = 1.0 / a0;
        BiquadCoef { b0: b0 * i, b1: b1 * i, b2: b2 * i, a1: a1 * i, a2: a2 * i }
    }

    fn w(hz: f32, rate: f32) -> (f32, f32) {
        let w0 = 2.0 * PI * clampf(hz, 5.0, rate * 0.49) / rate;
        (w0.cos(), w0.sin())
    }

    pub fn lowpass(hz: f32, q: f32, rate: f32) -> Self {
        let (c, s) = Self::w(hz, rate);
        let al = s / (2.0 * q);
        Self::norm((1.0 - c) * 0.5, 1.0 - c, (1.0 - c) * 0.5, 1.0 + al, -2.0 * c, 1.0 - al)
    }

    pub fn highpass(hz: f32, q: f32, rate: f32) -> Self {
        let (c, s) = Self::w(hz, rate);
        let al = s / (2.0 * q);
        Self::norm((1.0 + c) * 0.5, -(1.0 + c), (1.0 + c) * 0.5, 1.0 + al, -2.0 * c, 1.0 - al)
    }

    pub fn peak(hz: f32, q: f32, db: f32, rate: f32) -> Self {
        let (c, s) = Self::w(hz, rate);
        let a = 10f32.powf(db / 40.0);
        let al = s / (2.0 * q);
        Self::norm(1.0 + al * a, -2.0 * c, 1.0 - al * a, 1.0 + al / a, -2.0 * c, 1.0 - al / a)
    }

    pub fn low_shelf(hz: f32, db: f32, rate: f32) -> Self {
        let (c, s) = Self::w(hz, rate);
        let a = 10f32.powf(db / 40.0);
        let al = s / 2.0 * 2f32.sqrt();
        let sa = 2.0 * a.sqrt() * al;
        Self::norm(
            a * ((a + 1.0) - (a - 1.0) * c + sa),
            2.0 * a * ((a - 1.0) - (a + 1.0) * c),
            a * ((a + 1.0) - (a - 1.0) * c - sa),
            (a + 1.0) + (a - 1.0) * c + sa,
            -2.0 * ((a - 1.0) + (a + 1.0) * c),
            (a + 1.0) + (a - 1.0) * c - sa,
        )
    }

    pub fn high_shelf(hz: f32, db: f32, rate: f32) -> Self {
        let (c, s) = Self::w(hz, rate);
        let a = 10f32.powf(db / 40.0);
        let al = s / 2.0 * 2f32.sqrt();
        let sa = 2.0 * a.sqrt() * al;
        Self::norm(
            a * ((a + 1.0) + (a - 1.0) * c + sa),
            -2.0 * a * ((a - 1.0) + (a + 1.0) * c),
            a * ((a + 1.0) + (a - 1.0) * c - sa),
            (a + 1.0) - (a - 1.0) * c + sa,
            2.0 * ((a - 1.0) - (a + 1.0) * c),
            (a + 1.0) - (a - 1.0) * c - sa,
        )
    }
}

impl Biquad {
    #[inline]
    pub fn run(&mut self, c: &BiquadCoef, x: f32) -> f32 {
        let y = c.b0 * x + self.z1;
        self.z1 = c.b1 * x - c.a1 * y + self.z2;
        self.z2 = c.b2 * x - c.a2 * y;
        y
    }

    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }

    pub fn flush(&mut self) {
        self.z1 = undenorm(self.z1);
        self.z2 = undenorm(self.z2);
        if !self.z1.is_finite() || !self.z2.is_finite() {
            self.reset();
        }
    }
}

// ------------------------------------------------------------------ one-pole

/// One-pole low-pass (used for tone controls and smoothing).
#[derive(Clone, Copy, Default)]
pub struct OnePole {
    pub z: f32,
}

impl OnePole {
    /// Coefficient for a cutoff in Hz.
    pub fn coef(hz: f32, rate: f32) -> f32 {
        1.0 - (-2.0 * PI * clampf(hz, 1.0, rate * 0.49) / rate).exp()
    }
    #[inline]
    pub fn lp(&mut self, x: f32, a: f32) -> f32 {
        self.z += (x - self.z) * a;
        self.z
    }
    #[inline]
    pub fn hp(&mut self, x: f32, a: f32) -> f32 {
        self.z += (x - self.z) * a;
        x - self.z
    }
}

// ------------------------------------------------------------------ smoothing

/// A parameter block: targets set from the host, current values smoothed per block.
pub struct Params<const N: usize> {
    pub target: [f32; N],
    pub cur: [f32; N],
    pub smooth: [bool; N],
    fresh: [bool; N],
    pub dirty: bool,
}

impl<const N: usize> Params<N> {
    pub fn new(defaults: &[f32], smooth: &[bool]) -> Self {
        let mut p = Params { target: [0.0; N], cur: [0.0; N], smooth: [false; N], fresh: [true; N], dirty: true };
        for i in 0..N.min(defaults.len()) {
            p.target[i] = defaults[i];
            p.cur[i] = defaults[i];
        }
        for i in 0..N.min(smooth.len()) {
            p.smooth[i] = smooth[i];
        }
        p
    }

    pub fn set(&mut self, i: usize, v: f32) {
        if i >= N || !v.is_finite() {
            return;
        }
        self.target[i] = v;
        if self.fresh[i] || !self.smooth[i] {
            self.cur[i] = v;
            self.fresh[i] = false;
        }
        self.dirty = true;
    }

    /// Moves smoothed values toward their targets; returns true when anything changed.
    pub fn step(&mut self, coef: f32) -> bool {
        let mut changed = self.dirty;
        self.dirty = false;
        for i in 0..N {
            let t = self.target[i];
            let c = self.cur[i];
            if c != t {
                let d = t - c;
                let n = c + d * coef;
                self.cur[i] = if (n - t).abs() <= 1e-5 * (1.0 + t.abs()) { t } else { n };
                changed = true;
            }
        }
        changed
    }

    #[inline]
    pub fn get(&self, i: usize) -> f32 {
        self.cur[i]
    }
}

/// Per-block smoothing coefficient for about `seconds` of glide.
pub fn block_coef(seconds: f32, rate: f32, frames: usize) -> f32 {
    1.0 - (-(frames as f32) / (seconds * rate)).exp()
}

/// Linear ramp helper: value at sample i of n going from a to b.
#[inline]
pub fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

/// Balance pan law: center is unity, a hard pan silences the other side.
#[inline]
pub fn balance(pan: f32) -> (f32, f32) {
    let p = clampf(pan, -1.0, 1.0);
    (if p > 0.0 { 1.0 - p } else { 1.0 }, if p < 0.0 { 1.0 + p } else { 1.0 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fast_math_is_accurate() {
        let mut x = -20.0f32;
        while x < 20.0 {
            let e = fast_exp2(x);
            assert!(((e - x.exp2()) / x.exp2()).abs() < 2e-4, "exp2 {x}");
            x += 0.013;
        }
        let mut g = 1e-6f32;
        while g < 1e6 {
            assert!((fast_log2(g) - g.log2()).abs() < 2e-4, "log2 {g}");
            g *= 1.07;
        }
        let mut p = -2.0f32;
        while p < 2.0 {
            assert!((sin_turns(p) - (p * 2.0 * PI).sin()).abs() < 2e-3, "sin {p}");
            p += 0.001;
        }
    }
}
