//! Phaser: a chain of first-order all-pass stages whose break frequency sweeps
//! between the upper frequency and a lower one set by depth; mixing the chain
//! with its input makes moving notches. Feedback sharpens them.
//!
//! Params: 0 stages (2..12), 1 intensity %, 2 depth %, 3 modulation rate Hz,
//! 4 phase difference degrees (right LFO offset), 5 upper frequency Hz,
//! 6 feedback %, 7 mix %, 8 output gain dB.

use super::fsin;
use crate::fx::delay::feedback_tail;
use crate::fx::util::{db_to_gain, sanitize, PI};
use crate::fx::{Effect, Smooth};

pub const MAX_STAGES: usize = 12;
/// Octaves below the upper frequency the sweep reaches at 100 % depth.
const MAX_OCTAVES: f32 = 6.0;
/// Frames between all-pass coefficient updates.
const CTRL: usize = 8;

pub struct Phaser {
    rate: f32,
    stages: usize,
    intensity: f32,
    depth: f32,
    lfo_rate: f32,
    phase_diff: f32,
    upper: f32,
    fb: f32,
    mix: Smooth,
    gain: Smooth,
    phase: f32,
    // All-pass state per channel and stage: x[n-1], y[n-1].
    xs: [[f32; MAX_STAGES]; 2],
    ys: [[f32; MAX_STAGES]; 2],
    coef: [f32; 2],
    last: [f32; 2],
    count: usize,
    fresh: bool,
}

impl Phaser {
    pub fn new(rate: f32, _channels: usize) -> Phaser {
        Phaser {
            rate,
            stages: 8,
            intensity: 1.0,
            depth: 0.7,
            lfo_rate: 0.4,
            phase_diff: 0.0,
            upper: 3000.0,
            fb: 0.3,
            mix: Smooth::new(0.5, rate, 20.0),
            gain: Smooth::new(1.0, rate, 20.0),
            phase: 0.0,
            xs: [[0.0; MAX_STAGES]; 2],
            ys: [[0.0; MAX_STAGES]; 2],
            coef: [0.0; 2],
            last: [0.0; 2],
            count: 0,
            fresh: true,
        }
    }

    /// All-pass coefficient for break frequency f.
    #[inline]
    fn coef_for(&self, f: f32) -> f32 {
        let k = (PI * f.clamp(10.0, self.rate * 0.45) / self.rate).tan();
        (k - 1.0) / (k + 1.0)
    }
}

impl Effect for Phaser {
    fn set_param(&mut self, idx: u32, v: f32) {
        match idx {
            0 => self.stages = (v.round() as usize).clamp(1, MAX_STAGES),
            1 => self.intensity = (v * 0.01).clamp(0.0, 1.0),
            2 => self.depth = (v * 0.01).clamp(0.0, 1.0),
            3 => self.lfo_rate = v.clamp(0.0, 50.0),
            4 => self.phase_diff = v.clamp(-180.0, 180.0) / 360.0,
            5 => self.upper = v.clamp(20.0, 20000.0),
            6 => self.fb = (v * 0.01).clamp(-0.95, 0.95),
            7 => self.mix.target = (v * 0.01).clamp(0.0, 1.0),
            8 => self.gain.target = db_to_gain(v.clamp(-40.0, 24.0)),
            _ => {}
        }
    }

    fn process(&mut self, buf: &mut [f32], channels: usize, frames: usize) {
        if self.fresh {
            self.fresh = false;
            self.mix.settle();
            self.gain.settle();
        }
        let ch = channels.min(2);
        let inc = self.lfo_rate / self.rate;
        let octaves = MAX_OCTAVES * self.depth;
        let lower = (self.upper * (-octaves).exp2()).max(20.0);
        let span = (self.upper / lower).log2();
        let norm = 1.0 / (1.0 + self.intensity);
        for i in 0..frames {
            if self.count == 0 {
                for c in 0..ch {
                    let p = self.phase + if c == 1 { self.phase_diff } else { 0.0 };
                    let u = 0.5 + 0.5 * fsin(p);
                    self.coef[c] = self.coef_for(lower * (span * u).exp2());
                }
            }
            self.count = (self.count + 1) % CTRL;
            self.phase += inc;
            if self.phase >= 1.0 {
                self.phase -= 1.0;
            }
            let (mix, gain) = (self.mix.next(), self.gain.next());
            for c in 0..ch {
                let x = buf[c * frames + i];
                let a = self.coef[c];
                let mut s = x + self.fb * self.last[c];
                for k in 0..self.stages {
                    // y = a x + x[n-1] - a y[n-1]
                    let y = a * s + self.xs[c][k] - a * self.ys[c][k];
                    self.xs[c][k] = s;
                    self.ys[c][k] = y;
                    s = y;
                }
                self.last[c] = s;
                let wet = (x + self.intensity * s) * norm;
                buf[c * frames + i] = gain * (x * (1.0 - mix) + wet * mix);
            }
        }
        for c in 0..2 {
            self.last[c] = sanitize(self.last[c]);
            for k in 0..MAX_STAGES {
                self.xs[c][k] = sanitize(self.xs[c][k]);
                self.ys[c][k] = sanitize(self.ys[c][k]);
            }
        }
    }

    fn reset(&mut self) {
        self.xs = [[0.0; MAX_STAGES]; 2];
        self.ys = [[0.0; MAX_STAGES]; 2];
        self.last = [0.0; 2];
        self.count = 0;
    }

    /// Until the feedback loop rings down by 60 dB, at least the 50 ms the
    /// stages ring on their own. Each pass round the loop loses the feedback
    /// amount and takes the stages' group delay, longest at the lowest break
    /// frequency of the sweep: 1 / tan(pi f / rate) frames per stage.
    fn tail(&self) -> u32 {
        let rate = self.rate as f64;
        let lower = (self.upper * (-MAX_OCTAVES * self.depth).exp2()).max(20.0) as f64;
        let k = (std::f64::consts::PI * lower.clamp(10.0, rate * 0.45) / rate).tan();
        let pass = self.stages as f64 / k;
        (rate * 0.05).round().max(feedback_tail(pass, self.fb.abs() as f64, self.rate) as f64) as u32
    }
}

#[cfg(test)]
mod tests {
    use crate::fx::testutil::*;

    #[test]
    fn tail_lasts_until_strong_feedback_rings_down() {
        let rate = 48000.0;
        let mut fx = make(72, rate, 1);
        for (i, v) in [(0, 12.0), (2, 100.0), (5, 300.0), (6, -90.0), (7, 100.0)] {
            fx.set_param(i, v);
        }
        fx.reset();
        let tail = fx.tail() as usize;
        assert!(tail > 24000, "{tail}");
        let mut x = sine(150.0, rate, 24000, 0.5);
        x.extend(std::iter::repeat(0.0).take(tail + 48000));
        let y = run_mono(fx.as_mut(), &x);
        let peak = |s: &[f32]| s.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        let ratio = peak(&y[24000 + tail..]) / peak(&y[..24000]);
        assert!(ratio < 1e-3, "{ratio}");
    }

    fn gain_at(f: f32, upper: f32) -> f32 {
        // Static phaser (no sweep) with two stages: each shifts 90 degrees at
        // its break frequency, so the sum with the input cancels there.
        let rate = 48000.0;
        let mut fx = make(72, rate, 1);
        for (i, v) in [(0, 2.0), (1, 100.0), (2, 0.0), (3, 0.0), (5, upper), (6, 0.0), (7, 100.0)] {
            fx.set_param(i, v);
        }
        let x = sine(f, rate, 24000, 0.5);
        let y = run_mono(fx.as_mut(), &x);
        rms(&y[12000..]) / rms(&x[12000..])
    }

    #[test]
    fn notch_sits_where_the_chain_inverts() {
        assert!(gain_at(1000.0, 1000.0) < 0.05, "{}", gain_at(1000.0, 1000.0));
        assert!(gain_at(60.0, 1000.0) > 0.9);
        assert!(gain_at(15000.0, 1000.0) > 0.85);
    }

    #[test]
    fn sweeping_stays_finite() {
        let mut fx = make(72, 48000.0, 2);
        for (i, v) in [(0, 12.0), (3, 5.0), (4, 90.0), (6, 95.0)] {
            fx.set_param(i, v);
        }
        let x = noise(48000, 0.5, 8);
        let (l, r) = run_stereo(fx.as_mut(), &x, &x);
        assert!(l.iter().chain(&r).all(|v| v.is_finite()) && peak(&l) < 10.0);
    }
}
