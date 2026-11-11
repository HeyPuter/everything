//! Parametric Equalizer: high pass, low shelf, five bell bands, high shelf
//! and low pass, all as smoothed biquads.
//!
//! Params:
//!   0 master gain dB        1 Q mode (0 constant Q, 1 proportional Q)
//!   2 HP on   3 HP freq   4 HP order (1..8, 6 dB/oct each)
//!   5 LS on   6 LS freq   7 LS gain dB   8 LS Q
//!   9 + 4b .. band b (0..4): on, freq, gain dB, Q
//!   29 HS on  30 HS freq  31 HS gain dB  32 HS Q
//!   33 LP on  34 LP freq  35 LP order
//!   36 ultra-quiet (0/1): double-precision filtering (37 is the dialog's
//!      graph range, not used here)
//!
//! Constant Q keeps a band's width the same whether it boosts or cuts (a cut
//! mirrors the matching boost); proportional Q narrows as the gain grows, like
//! analog console EQs.

use super::{butterworth_stages, Cascade, Glide, SmoothParams, SUB};
use crate::fx::util::{db_to_gain, Coefs};
use crate::fx::{Effect, Smooth};

pub const BANDS: usize = 5;
const NPARAMS: usize = 36;
// Stage layout.
const HP: usize = 0;
const LS: usize = 4;
const BAND: usize = 5;
const HS: usize = 10;
const LP: usize = 11;
const STAGES: usize = 15;

pub struct ParametricEq {
    rate: f32,
    p: SmoothParams,
    cascade: Cascade,
    master: Smooth,
    orders: [usize; 2],
}

fn spec() -> Vec<(f32, Glide)> {
    use Glide::*;
    let mut s = vec![(0.0, Lin), (0.0, Step), (0.0, Step), (60.0, Log), (2.0, Step), (0.0, Step), (100.0, Log), (0.0, Lin), (0.7071, Log)];
    let freqs = [120.0, 400.0, 1000.0, 3000.0, 8000.0];
    for f in freqs {
        s.extend([(1.0, Step), (f, Log), (0.0, Lin), (1.0, Log)]);
    }
    s.extend([(0.0, Step), (8000.0, Log), (0.0, Lin), (0.7071, Log), (0.0, Step), (18000.0, Log), (2.0, Step)]);
    debug_assert_eq!(s.len(), NPARAMS);
    s
}

impl ParametricEq {
    pub fn new(rate: f32, channels: usize) -> ParametricEq {
        ParametricEq { rate, p: SmoothParams::new(rate, &spec()), cascade: Cascade::new(channels, STAGES), master: Smooth::new(1.0, rate, 20.0), orders: [2, 2] }
    }

    fn design(&mut self) {
        let r = self.rate;
        let p = &self.p;
        let c = &mut self.cascade;
        let order = |v: f32| (v.round() as usize).clamp(1, 8);
        let hp_order = order(p.raw[4]);
        let lp_order = order(p.raw[35]);
        if hp_order != self.orders[0] {
            for s in HP..HP + 4 {
                c.reset_stage(s);
            }
        }
        if lp_order != self.orders[1] {
            for s in LP..LP + 4 {
                c.reset_stage(s);
            }
        }
        self.orders = [hp_order, lp_order];
        butterworth_stages(&mut c.coefs, &mut c.on, HP, r, p.get(3), hp_order, true, p.on(2));
        c.on[LS] = p.on(5);
        c.coefs[LS] = Coefs::low_shelf(r, p.get(6), p.get(8), p.get(7));
        let proportional = p.raw[1] >= 0.5;
        for b in 0..BANDS {
            let i = 9 + 4 * b;
            c.on[BAND + b] = p.on(i);
            let (f, g, q) = (p.get(i + 1), p.get(i + 2), p.get(i + 3));
            c.coefs[BAND + b] = if proportional { Coefs::peaking(r, f, q, g) } else { Coefs::peaking_cq(r, f, q, g) };
        }
        c.on[HS] = p.on(29);
        c.coefs[HS] = Coefs::high_shelf(r, p.get(30), p.get(32), p.get(31));
        butterworth_stages(&mut c.coefs, &mut c.on, LP, r, p.get(34), lp_order, false, p.on(33));
        c.commit();
        self.master.target = db_to_gain(p.raw[0]);
    }
}

impl Effect for ParametricEq {
    fn set_param(&mut self, idx: u32, value: f32) {
        if idx == 36 {
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
        // Master gain, smoothed per sample.
        if self.master.settled() && (self.master.value - 1.0).abs() < 1e-7 {
            self.cascade.flush();
            return;
        }
        let start = self.master.value;
        for c in 0..channels {
            self.master.value = start;
            for x in &mut buf[c * frames..(c + 1) * frames] {
                *x *= self.master.next();
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
    use crate::fx::util::{gain_to_db, Coefs};

    #[test]
    fn very_low_shelves_follow_their_design_at_high_rates() {
        // A +12 dB shelf at 10 Hz at 192 kHz: its poles are too close to DC for
        // f32 coefficients, which turned 30 Hz from +0.2 dB into +4.7 dB.
        for rate in [48000.0, 96000.0, 192000.0] {
            for (f, at) in [(10.0, 30.0), (10.0, 15.0), (20.0, 60.0)] {
                let want = gain_to_db(Coefs::low_shelf(rate, f, 0.7071, 12.0).magnitude_wide(at, rate));
                for quiet in [0.0, 1.0] {
                    // Four seconds, measured over the last two (whole cycles at these frequencies).
                    let mut fx = make(10, rate, 1);
                    for (i, v) in [(5, 1.0), (6, f), (7, 12.0), (8, 0.7071), (36, quiet)] {
                        fx.set_param(i, v);
                    }
                    fx.reset();
                    let n = (rate * 4.0) as usize;
                    let x = sine(at, rate, n, 0.25);
                    let y = run_mono(fx.as_mut(), &x);
                    let got = gain_to_db(rms(&y[n / 2..]) / rms(&x[n / 2..]));
                    assert!((got - want).abs() < 0.1, "{rate} {f} Hz at {at}: {got} vs {want} (quiet {quiet})");
                }
            }
        }
    }

    fn eq(params: &[(u32, f32)], f: f32) -> f32 {
        sine_gain_db(10, params, f, 48000.0)
    }

    #[test]
    fn flat_by_default() {
        for f in [50.0, 1000.0, 12000.0] {
            assert!(eq(&[], f).abs() < 0.05, "{f}");
        }
    }

    #[test]
    fn bands_shelves_and_passes() {
        // Band 3 (1 kHz) +9 dB.
        assert!((eq(&[(19, 9.0)], 1000.0) - 9.0).abs() < 0.2);
        assert!(eq(&[(19, 9.0)], 100.0).abs() < 0.3);
        // Proportional vs constant Q differ for a cut.
        let cq = eq(&[(19, -12.0), (20, 1.0)], 1300.0);
        let prop = eq(&[(19, -12.0), (20, 1.0), (1, 1.0)], 1300.0);
        assert!((cq - prop).abs() > 0.5, "{cq} {prop}");
        // Low shelf -10 dB.
        assert!((eq(&[(5, 1.0), (7, -10.0)], 30.0) + 10.0).abs() < 0.5);
        // High pass 24 dB/oct at 200 Hz: 50 Hz is down about 48 dB.
        assert!(eq(&[(2, 1.0), (3, 200.0), (4, 4.0)], 50.0) < -40.0);
        assert!(eq(&[(2, 1.0), (3, 200.0), (4, 4.0)], 2000.0).abs() < 0.1);
        // Low pass 12 dB/oct at 2 kHz.
        assert!((eq(&[(33, 1.0), (34, 2000.0)], 2000.0) + 3.0).abs() < 0.3);
        // Master gain.
        assert!((eq(&[(0, -6.0)], 1000.0) + 6.0).abs() < 0.05);
    }

    #[test]
    fn ultra_quiet_filters_with_less_rounding_noise() {
        // A narrow 30 Hz boost and the matching constant-Q cut cancel exactly
        // in exact arithmetic, so what is left of the input is rounding noise.
        let params = [(9u32, 1.0f32), (10, 30.0), (11, 18.0), (12, 8.0), (13, 1.0), (14, 30.0), (15, -18.0), (16, 8.0)];
        let x: Vec<f32> = sine(1000.0, 48000.0, 96000, 0.5).iter().zip(noise(96000, 0.1, 3)).map(|(a, b)| a + b).collect();
        let err = |quiet: bool| {
            let mut fx = make(10, 48000.0, 1);
            for &(i, v) in &params {
                fx.set_param(i, v);
            }
            fx.set_param(36, if quiet { 1.0 } else { 0.0 });
            fx.reset();
            let y = run_mono(fx.as_mut(), &x);
            let d: Vec<f32> = y.iter().zip(&x).map(|(a, b)| a - b).collect();
            rms(&d[48000..]) / rms(&x[48000..])
        };
        let (plain, quiet) = (err(false), err(true));
        assert!(quiet < plain * 0.2, "plain {plain} quiet {quiet}");
    }

    #[test]
    fn ultra_quiet_keeps_the_response() {
        let quiet = [(19u32, 9.0f32), (36, 1.0)];
        assert!((eq(&quiet, 1000.0) - 9.0).abs() < 0.2);
        assert!(eq(&[(36, 1.0)], 5000.0).abs() < 0.05);
    }

    #[test]
    fn parameter_changes_glide_without_jumps() {
        let mut fx = make(10, 48000.0, 1);
        fx.set_param(19, 0.0);
        let x = sine(1000.0, 48000.0, 4800, 0.5);
        run_mono(fx.as_mut(), &x);
        fx.set_param(19, 15.0);
        let y = run_mono(fx.as_mut(), &x);
        // The gain ramps up instead of jumping in the first block.
        assert!(peak(&y[..64]) < 0.6, "{}", peak(&y[..64]));
        assert!(peak(&y[4000..]) > 2.5);
        for w in y.windows(2) {
            assert!((w[1] - w[0]).abs() < 0.8);
        }
    }
}
