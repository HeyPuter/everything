//! Helpers shared by the dynamics processors: fast dB conversions accurate to
//! about 0.001 dB (the per-sample gain computers call them for every frame),
//! a level detector with peak and RMS modes, and a gain-reduction smoother
//! that runs in the dB domain.

use crate::fx::util::ms_coef;

const DB_PER_LOG2: f32 = 6.020_599_9; // 20 * log10(2)

/// log2 of a positive finite value (abs error below 1e-6).
#[inline]
pub fn fast_log2(x: f32) -> f32 {
    let x = x.max(1e-20);
    let bits = x.to_bits();
    let mut e = ((bits >> 23) & 0xff) as i32 - 127;
    let mut m = f32::from_bits((bits & 0x007f_ffff) | 0x3f80_0000);
    // Centre the mantissa on 1 so the series converges fast: m in [0.707, 1.414).
    if m > std::f32::consts::SQRT_2 {
        m *= 0.5;
        e += 1;
    }
    // ln(m) = 2 atanh(t), t = (m - 1) / (m + 1), |t| < 0.172.
    let t = (m - 1.0) / (m + 1.0);
    let t2 = t * t;
    let ln = 2.0 * t * (1.0 + t2 * (1.0 / 3.0 + t2 * (0.2 + t2 * (1.0 / 7.0))));
    e as f32 + ln * std::f32::consts::LOG2_E
}

/// 2^x for x in about [-120, 120] (relative error about 1e-7).
#[inline]
pub fn fast_exp2(x: f32) -> f32 {
    let x = x.clamp(-126.0, 126.0);
    let i = x.round();
    let f = x - i; // [-0.5, 0.5]
    let p = 1.0
        + f * (0.693_147_2
            + f * (0.240_226_5 + f * (0.055_504_11 + f * (0.009_618_13 + f * (0.001_333_36 + f * 0.000_154_03)))));
    f32::from_bits(((i as i32 + 127) as u32) << 23) * p
}

/// Linear amplitude to dB (floored near -400 dB).
#[inline]
pub fn lin_db(x: f32) -> f32 {
    DB_PER_LOG2 * fast_log2(x)
}

/// dB to linear amplitude.
#[inline]
pub fn db_lin(db: f32) -> f32 {
    fast_exp2(db * (1.0 / DB_PER_LOG2))
}

/// Level detector: peak follows |x| with attack/release; RMS averages x^2
/// over the release time constant (attack used while rising).
#[derive(Clone, Copy, Default)]
pub struct Detector {
    att: f32,
    rel: f32,
    rms: bool,
    state: f32,
}

impl Detector {
    pub fn set(&mut self, rate: f32, attack_ms: f32, release_ms: f32, rms: bool) {
        self.att = ms_coef(attack_ms, rate);
        self.rel = ms_coef(release_ms, rate);
        self.rms = rms;
    }
    /// Feeds |x| (or a linked maximum) and returns the linear level.
    #[inline]
    pub fn next(&mut self, x: f32) -> f32 {
        if self.rms {
            let p = x * x;
            let c = if p > self.state { self.att } else { self.rel };
            self.state = p + (self.state - p) * c;
            self.state.sqrt()
        } else {
            let c = if x > self.state { self.att } else { self.rel };
            self.state = x + (self.state - x) * c;
            self.state
        }
    }
    /// Feeds |x| and returns the level in dB.
    #[inline]
    pub fn level_db(&mut self, x: f32) -> f32 {
        lin_db(self.next(x) + 1e-10)
    }
    pub fn reset(&mut self) {
        self.state = 0.0;
    }
}

/// Smooths a gain change in dB: `attack` while reduction deepens, `release`
/// while it recovers.
#[derive(Clone, Copy, Default)]
pub struct GainSmoother {
    pub att: f32,
    pub rel: f32,
    pub db: f32,
}

impl GainSmoother {
    pub fn set(&mut self, rate: f32, attack_ms: f32, release_ms: f32) {
        self.att = ms_coef(attack_ms, rate);
        self.rel = ms_coef(release_ms, rate);
    }
    #[inline]
    pub fn next(&mut self, target_db: f32) -> f32 {
        let c = if target_db < self.db { self.att } else { self.rel };
        self.db = target_db + (self.db - target_db) * c;
        self.db
    }
    pub fn reset(&mut self) {
        self.db = 0.0;
    }
}

/// Smooth saturator with rational tanh: odd, monotonic, limits to +/-1.
#[inline]
pub fn soft_tanh(x: f32) -> f32 {
    let x = x.clamp(-3.0, 3.0);
    let x2 = x * x;
    x * (27.0 + x2) / (27.0 + 9.0 * x2)
}

/// Linked absolute peak of frame `i` across channels.
#[inline]
pub fn frame_peak(buf: &[f32], channels: usize, frames: usize, i: usize) -> f32 {
    let mut p = 0.0f32;
    for c in 0..channels {
        p = p.max(buf[c * frames + i].abs());
    }
    p
}

/// Copyable one-pole parameter smoother (like fx::Smooth, usable in arrays).
#[derive(Clone, Copy, Default)]
pub struct Ramp {
    pub value: f32,
    pub target: f32,
    coef: f32,
}

impl Ramp {
    pub fn new(value: f32, rate: f32, ms: f32) -> Ramp {
        Ramp { value, target: value, coef: ms_coef(ms, rate) }
    }
    #[inline]
    pub fn next(&mut self) -> f32 {
        self.value = self.target + (self.value - self.target) * self.coef;
        self.value
    }
    pub fn settle(&mut self) {
        self.value = self.target;
    }
    #[inline]
    pub fn settled(&self) -> bool {
        (self.value - self.target).abs() <= 1e-5 * (1.0 + self.target.abs())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fast_db_conversions_are_accurate() {
        for &x in &[1e-6f32, 0.001, 0.1, 0.5, 0.7071, 1.0, 1.9, 3.0, 100.0] {
            let exact = 20.0 * x.log10();
            assert!((lin_db(x) - exact).abs() < 0.002, "{x}: {} vs {exact}", lin_db(x));
        }
        for i in -1200..=400 {
            let db = i as f32 * 0.1;
            let exact = 10f32.powf(db / 20.0);
            assert!(((db_lin(db) - exact) / exact).abs() < 1e-5, "{db}");
        }
    }

    #[test]
    fn soft_tanh_is_bounded_and_odd() {
        assert!((soft_tanh(10.0) - 1.0).abs() < 1e-6);
        assert!((soft_tanh(-0.5) + soft_tanh(0.5)).abs() < 1e-7);
        assert!((soft_tanh(0.01) - 0.01).abs() < 1e-5);
    }
}

/// Meters since the last readout: input peak and output peak (linear) and the
/// deepest gain reduction (dB, 0 or below).
#[derive(Clone, Copy, Default)]
pub struct Meters {
    pub inp: f32,
    pub gr: f32,
    pub out: f32,
}

impl Meters {
    /// Writes [input peak dB, deepest gain reduction dB, output peak dB] and starts over.
    pub fn read(&mut self, out: &mut [f32]) -> usize {
        if out.len() < 3 {
            return 0;
        }
        out[0] = lin_db(self.inp + 1e-10).max(-120.0);
        out[1] = self.gr.min(0.0);
        out[2] = lin_db(self.out + 1e-10).max(-120.0);
        *self = Meters::default();
        3
    }
}
