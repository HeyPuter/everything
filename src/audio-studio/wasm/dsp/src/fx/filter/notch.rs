//! Notch Filter: up to six narrow cuts (hum, whistles, tones) with a shared
//! width, optionally all at the first notch's depth.
//!
//! Params: 0 master gain dB, 1 width (0 super narrow, 1 narrow, 2 medium,
//! 3 wide), 2 fix gains (all notches use notch 1's gain),
//! 3 + 3n .. notch n (0..5): on, freq Hz, gain dB (<= 0), 21 ultra-quiet
//! (0/1: double-precision filtering).

use super::{Cascade, Glide, SmoothParams, SUB};
use crate::fx::util::{db_to_gain, Coefs};
use crate::fx::{Effect, Smooth};

pub const NOTCHES: usize = 6;
/// Bell Q for each width choice.
pub const WIDTH_Q: [f32; 4] = [60.0, 20.0, 8.0, 3.0];

/// A cut whose -3 dB width is set by the poles (Q), so deep notches stay
/// narrow: (s^2 + (G/Q) s + 1) / (s^2 + s/Q + 1) with G the depth gain.
pub fn notch_bell(rate: f32, f: f32, q: f32, gain_db: f32) -> Coefs {
    let f = (f as f64).clamp(1.0, rate as f64 * 0.4999);
    let w0 = 2.0 * std::f64::consts::PI * f / rate as f64;
    let (c, s) = (w0.cos(), w0.sin());
    let g = 10f64.powf(gain_db.min(0.0) as f64 / 20.0);
    let alpha = s / (2.0 * q.max(0.01) as f64);
    Coefs::norm(1.0 + alpha * g, -2.0 * c, 1.0 - alpha * g, 1.0 + alpha, -2.0 * c, 1.0 - alpha)
}

pub struct NotchFilter {
    rate: f32,
    p: SmoothParams,
    cascade: Cascade,
    master: Smooth,
}

fn spec() -> Vec<(f32, Glide)> {
    use Glide::*;
    let mut s = vec![(0.0, Lin), (1.0, Step), (0.0, Step)];
    let freqs = [60.0, 120.0, 180.0, 240.0, 300.0, 360.0];
    for (n, f) in freqs.iter().enumerate() {
        s.extend([(if n == 0 { 1.0 } else { 0.0 }, Step), (*f, Log), (-30.0, Lin)]);
    }
    s
}

impl NotchFilter {
    pub fn new(rate: f32, channels: usize) -> NotchFilter {
        NotchFilter { rate, p: SmoothParams::new(rate, &spec()), cascade: Cascade::new(channels, NOTCHES), master: Smooth::new(1.0, rate, 20.0) }
    }

    fn design(&mut self) {
        let q = WIDTH_Q[(self.p.raw[1].round() as usize).min(3)];
        let fixed = self.p.on(2);
        for n in 0..NOTCHES {
            let i = 3 + 3 * n;
            let on = self.p.on(i);
            if on && !self.cascade.on[n] {
                self.cascade.reset_stage(n);
            }
            self.cascade.on[n] = on;
            let g = if fixed { self.p.get(5) } else { self.p.get(i + 2) };
            self.cascade.coefs[n] = notch_bell(self.rate, self.p.get(i + 1), q, g);
        }
        self.cascade.commit();
        self.master.target = db_to_gain(self.p.raw[0]);
    }
}

impl Effect for NotchFilter {
    fn set_param(&mut self, idx: u32, value: f32) {
        if idx == 21 {
            self.cascade.set_precise(value >= 0.5);
            return;
        }
        self.p.set(idx as usize, value);
    }

    fn process(&mut self, buf: &mut [f32], channels: usize, frames: usize) {
        let mut at = 0;
        while at < frames {
            let len = SUB.min(frames - at);
            if self.p.advance() {
                self.design();
            }
            self.cascade.run(buf, frames, at, len);
            at += len;
        }
        if !(self.master.settled() && (self.master.value - 1.0).abs() < 1e-7) {
            let start = self.master.value;
            for c in 0..channels {
                self.master.value = start;
                for x in &mut buf[c * frames..(c + 1) * frames] {
                    *x *= self.master.next();
                }
            }
        }
        self.cascade.flush();
    }

    fn reset(&mut self) {
        self.p.settle();
        self.design();
        self.master.settle();
        self.cascade.reset();
    }
}

#[cfg(test)]
mod tests {
    use crate::fx::testutil::*;

    #[test]
    fn notches_cut_their_frequency_only() {
        let r = 48000.0;
        let db = sine_gain_db(14, &[(4, 1000.0), (5, -40.0)], 1000.0, r);
        assert!((db + 40.0).abs() < 1.0, "{db}");
        assert!(sine_gain_db(14, &[(4, 1000.0), (5, -40.0)], 1500.0, r).abs() < 0.5);
        // Second notch at 1 kHz, wide.
        let p = [(6, 1.0), (7, 1000.0), (8, -24.0), (1, 3.0)];
        assert!((sine_gain_db(14, &p, 1000.0, r) + 24.0).abs() < 0.5);
        // Fixed gains: notch 2 takes notch 1's depth.
        let p = [(6, 1.0), (7, 1000.0), (8, -6.0), (2, 1.0), (5, -30.0)];
        assert!((sine_gain_db(14, &p, 1000.0, r) + 30.0).abs() < 1.0);
    }

    #[test]
    fn ultra_quiet_lowers_rounding_noise_of_a_deep_notch() {
        // A -90 dB notch on a 1 kHz tone: away from the notch the output should
        // equal the input; what differs is mostly rounding noise. A 30 Hz notch
        // is ill-conditioned in f32, so it runs in double precision either way.
        let x = sine(1000.0, 48000.0, 48000, 0.5);
        let err = |freq: f32, quiet: f32| {
            let mut fx = make(14, 48000.0, 1);
            fx.set_param(4, freq);
            fx.set_param(5, -90.0);
            fx.set_param(1, 0.0);
            fx.set_param(21, quiet);
            fx.reset();
            let y = run_mono(fx.as_mut(), &x);
            let d: Vec<f32> = y.iter().zip(&x).map(|(a, b)| a - b).collect();
            rms(&d[24000..])
        };
        let (plain, quiet) = (err(300.0, 0.0), err(300.0, 1.0));
        assert!(quiet < plain, "plain {plain} quiet {quiet}");
        let (plain, quiet) = (err(30.0, 0.0), err(30.0, 1.0));
        assert!((plain - quiet).abs() <= quiet * 0.01, "plain {plain} quiet {quiet}");
    }
}
