//! Graphic Equalizer with 10 (octave), 20 (half octave) or 30 (third octave)
//! bands at ISO centre frequencies. Each band is a constant-Q bell whose
//! bandwidth matches the band spacing. With high accuracy, the band gains are
//! solved iteratively so the combined response hits each slider value at its
//! centre frequency despite the overlap between neighbouring bands.
//!
//! Params: 0 master gain dB, 1 accuracy (0 standard, 1 high), 2.. band gains dB.

use super::{section_magnitude, Cascade, SUB};
use crate::fx::util::{db_to_gain, gain_to_db, Coefs};
use crate::fx::{Effect, Smooth};

pub const OCTAVE: [f32; 10] = [31.5, 63.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0];
pub const HALF_OCTAVE: [f32; 20] = [
    22.4, 31.5, 45.0, 63.0, 90.0, 125.0, 180.0, 250.0, 355.0, 500.0, 710.0, 1000.0, 1400.0, 2000.0, 2800.0, 4000.0, 5600.0, 8000.0, 11200.0, 16000.0,
];
pub const THIRD_OCTAVE: [f32; 30] = [
    25.0, 31.5, 40.0, 50.0, 63.0, 80.0, 100.0, 125.0, 160.0, 200.0, 250.0, 315.0, 400.0, 500.0, 630.0, 800.0, 1000.0, 1250.0, 1600.0, 2000.0, 2500.0, 3150.0,
    4000.0, 5000.0, 6300.0, 8000.0, 10000.0, 12500.0, 16000.0, 20000.0,
];

/// Bands whose centre is above this fraction of the sample rate are bypassed.
pub const MAX_CENTRE: f32 = 0.46;
const MAX_BANDS: usize = 30;
const LIMIT_DB: f32 = 36.0;

#[derive(Clone, Copy)]
pub enum Spacing {
    Octave,
    HalfOctave,
    ThirdOctave,
}

impl Spacing {
    pub fn centres(self) -> &'static [f32] {
        match self {
            Spacing::Octave => &OCTAVE,
            Spacing::HalfOctave => &HALF_OCTAVE,
            Spacing::ThirdOctave => &THIRD_OCTAVE,
        }
    }
    /// Q of a bell whose -3 dB points sit at the neighbouring band edges.
    pub fn q(self) -> f32 {
        let n: f32 = match self {
            Spacing::Octave => 1.0,
            Spacing::HalfOctave => 0.5,
            Spacing::ThirdOctave => 1.0 / 3.0,
        };
        let r = 2f32.powf(n);
        r.sqrt() / (r - 1.0)
    }
}

/// Solves the n x n system `a x = b` in place (Gaussian elimination with
/// partial pivoting); the solution replaces `b`.
fn solve(a: &mut [[f64; MAX_BANDS]; MAX_BANDS], b: &mut [f64; MAX_BANDS], n: usize) {
    for col in 0..n {
        let mut piv = col;
        for r in col + 1..n {
            if a[r][col].abs() > a[piv][col].abs() {
                piv = r;
            }
        }
        a.swap(col, piv);
        b.swap(col, piv);
        let d = a[col][col];
        if d.abs() < 1e-12 {
            continue;
        }
        for r in col + 1..n {
            let m = a[r][col] / d;
            if m != 0.0 {
                for k in col..n {
                    a[r][k] -= m * a[col][k];
                }
                b[r] -= m * b[col];
            }
        }
    }
    for col in (0..n).rev() {
        let mut v = b[col];
        for k in col + 1..n {
            v -= a[col][k] * b[k];
        }
        b[col] = if a[col][col].abs() < 1e-12 { 0.0 } else { v / a[col][col] };
    }
}

/// Reference gain for the interaction matrix (dB per dB of slider).
const REF_DB: f32 = 6.0;
/// Light Tikhonov regularisation plus a box on the band gains (the slider
/// range widened by `HEADROOM_DB`): patterns the bells cannot reproduce
/// (alternating sliders) are approximated instead of chased with extreme band
/// gains, while ordinary curves are matched closely.
const LAMBDA: f64 = 0.005;
const HEADROOM_DB: f32 = 6.0;

/// Solves band gains so the summed response matches `want` at the centres:
/// regularised Gauss-Newton steps with the band interaction matrix, refined
/// against the exact response (the bells are not exactly linear in dB).
pub fn correct(want: &[f32], centres: &[f32], q: f32, rate: f32, out: &mut [f32]) {
    let n = want.len().min(MAX_BANDS);
    // Active bands are a prefix (centres ascend).
    let m = (0..n).take_while(|&i| centres[i] <= MAX_CENTRE * rate).count();
    let mut b = [[0.0f64; MAX_BANDS]; MAX_BANDS];
    for i in 0..m {
        let c = Coefs::peaking_cq(rate, centres[i], q, REF_DB);
        for j in 0..m {
            // Row j, column i: effect of band i at centre j.
            b[j][i] = (gain_to_db(section_magnitude(&c, centres[j], rate)) / REF_DB) as f64;
        }
    }
    // Normal matrix B^T B + lambda I.
    let mut normal = [[0.0f64; MAX_BANDS]; MAX_BANDS];
    for i in 0..m {
        for k in 0..m {
            let mut v = 0.0;
            for j in 0..m {
                v += b[j][i] * b[j][k];
            }
            normal[i][k] = v + if i == k { LAMBDA } else { 0.0 };
        }
    }
    let lo = want[..m].iter().fold(0.0f32, |a, &v| a.min(v)) - HEADROOM_DB;
    let hi = want[..m].iter().fold(0.0f32, |a, &v| a.max(v)) + HEADROOM_DB;
    let mut x = [0.0f64; MAX_BANDS];
    for _ in 0..6 {
        let mut coefs = [Coefs::IDENTITY; MAX_BANDS];
        for i in 0..m {
            coefs[i] = Coefs::peaking_cq(rate, centres[i], q, x[i] as f32);
        }
        let mut r = [0.0f64; MAX_BANDS];
        for j in 0..m {
            let mut sum = 0.0f32;
            for c in &coefs[..m] {
                sum += gain_to_db(section_magnitude(c, centres[j], rate));
            }
            r[j] = (want[j] - sum) as f64;
        }
        let mut rhs = [0.0f64; MAX_BANDS];
        for i in 0..m {
            let mut v = 0.0;
            for j in 0..m {
                v += b[j][i] * r[j];
            }
            rhs[i] = v - LAMBDA * x[i];
        }
        let mut a = normal;
        solve(&mut a, &mut rhs, m);
        for i in 0..m {
            x[i] = (x[i] + rhs[i]).clamp(lo.max(-LIMIT_DB) as f64, hi.min(LIMIT_DB) as f64);
        }
    }
    for i in 0..n {
        out[i] = if i < m { x[i] as f32 } else { 0.0 };
    }
}

pub struct GraphicEq {
    rate: f32,
    centres: &'static [f32],
    q: f32,
    want: [f32; MAX_BANDS],
    applied: Vec<Smooth>,
    master: Smooth,
    master_db: f32,
    high: bool,
    dirty: bool,
    fresh: bool,
    cascade: Cascade,
}

impl GraphicEq {
    pub fn new(rate: f32, channels: usize, spacing: Spacing) -> GraphicEq {
        let centres = spacing.centres();
        GraphicEq {
            rate,
            centres,
            q: spacing.q(),
            want: [0.0; MAX_BANDS],
            applied: (0..centres.len()).map(|_| Smooth::new(0.0, rate / SUB as f32, 30.0)).collect(),
            master: Smooth::new(1.0, rate, 20.0),
            master_db: 0.0,
            high: true,
            dirty: false,
            fresh: true,
            cascade: Cascade::new(channels, centres.len()),
        }
    }

    fn solve(&mut self) {
        let n = self.centres.len();
        let mut g = [0.0f32; MAX_BANDS];
        if self.high {
            correct(&self.want[..n], self.centres, self.q, self.rate, &mut g);
        } else {
            for i in 0..n {
                g[i] = if self.centres[i] <= MAX_CENTRE * self.rate { self.want[i] } else { 0.0 };
            }
        }
        for i in 0..n {
            if self.fresh {
                self.applied[i].jump(g[i]);
            } else {
                self.applied[i].target = g[i];
            }
        }
        self.master.target = db_to_gain(self.master_db);
        if self.fresh {
            self.master.settle();
        }
    }

    /// Recomputes coefficients of bands that are moving; returns whether any are.
    fn update(&mut self, force: bool) {
        for i in 0..self.centres.len() {
            let s = &mut self.applied[i];
            let moving = !s.settled();
            if moving {
                s.next();
            }
            if moving || force {
                let g = s.value;
                let on = g.abs() > 1e-4 || moving;
                if on && !self.cascade.on[i] {
                    self.cascade.reset_stage(i);
                }
                self.cascade.on[i] = on;
                self.cascade.coefs[i] = Coefs::peaking_cq(self.rate, self.centres[i], self.q, g);
            }
        }
        self.cascade.commit();
    }
}

impl Effect for GraphicEq {
    fn set_param(&mut self, idx: u32, value: f32) {
        if !value.is_finite() {
            return;
        }
        match idx {
            0 => self.master_db = value,
            1 => self.high = value >= 0.5,
            i => {
                let b = i as usize - 2;
                if b < self.centres.len() {
                    self.want[b] = value.clamp(-LIMIT_DB, LIMIT_DB);
                }
            }
        }
        self.dirty = true;
    }

    fn process(&mut self, buf: &mut [f32], channels: usize, frames: usize) {
        let force = self.dirty || self.fresh;
        if self.dirty || self.fresh {
            self.solve();
            self.dirty = false;
        }
        self.fresh = false;
        let mut first = true;
        let mut at = 0;
        while at < frames {
            let len = SUB.min(frames - at);
            self.update(force && first);
            first = false;
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
        self.solve();
        for s in &mut self.applied {
            s.settle();
        }
        self.master.settle();
        self.update(true);
        self.cascade.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fx::testutil::*;

    #[test]
    fn iso_band_counts_and_q() {
        assert_eq!(OCTAVE.len(), 10);
        assert_eq!(HALF_OCTAVE.len(), 20);
        assert_eq!(THIRD_OCTAVE.len(), 30);
        assert!((Spacing::Octave.q() - 1.414).abs() < 0.01);
        assert!((Spacing::ThirdOctave.q() - 4.318).abs() < 0.01);
    }

    #[test]
    fn single_band_hits_slider_value() {
        // 1 kHz band of the 10 band EQ is param 2 + 5.
        let db = sine_gain_db(11, &[(7, 9.0)], 1000.0, 48000.0);
        assert!((db - 9.0).abs() < 0.3, "{db}");
        assert!(sine_gain_db(11, &[(7, 9.0)], 31.5, 48000.0).abs() < 0.5);
    }

    #[test]
    fn high_accuracy_corrects_band_overlap() {
        let r = 48000.0;
        // All 30 sliders at +6 dB: the plain sum overshoots, the corrected one is close.
        let mut params: Vec<(u32, f32)> = (0..30).map(|i| (2 + i as u32, 6.0)).collect();
        let hi = sine_gain_db(13, &params, 1000.0, r);
        params.push((1, 0.0));
        let lo = sine_gain_db(13, &params, 1000.0, r);
        assert!((hi - 6.0).abs() < 0.5, "high accuracy {hi}");
        assert!(lo > hi + 1.0, "standard {lo}");
        // A smooth tilt lands on its targets at the centres.
        let want: Vec<f32> = (0..20).map(|i| -8.0 + 0.8 * i as f32).collect();
        let q = Spacing::HalfOctave.q();
        let mut out = [0.0; 20];
        correct(&want, &HALF_OCTAVE, q, r, &mut out);
        let at = |g: &[f32], j: usize| -> f32 { (0..20).map(|i| gain_to_db(Coefs::peaking_cq(r, HALF_OCTAVE[i], q, g[i]).magnitude(HALF_OCTAVE[j], r))).sum() };
        for j in 0..20 {
            assert!((at(&out, j) - want[j]).abs() < 0.3, "band {j}: {} {out:?}", at(&out, j));
        }
        // Alternating sliders: no wild band gains, and closer than uncorrected.
        let want: Vec<f32> = (0..20).map(|i| if i % 2 == 0 { 6.0 } else { -6.0 }).collect();
        correct(&want, &HALF_OCTAVE, q, r, &mut out);
        assert!(out.iter().all(|g| g.abs() < 16.0), "{out:?}");
        let err = |g: &[f32]| -> f32 { (2..18).map(|j| (at(g, j) - want[j]).abs()).sum() };
        assert!(err(&out) < err(&want), "{} vs {}", err(&out), err(&want));
    }

    #[test]
    fn high_accuracy_holds_flat_low_bands_at_high_rates() {
        // Treble cut on the 30 band EQ: the low bands stay at 0 dB. Their
        // sections run in double precision at 176.4 and 192 kHz, which the
        // solver must model, or it "corrects" errors that are not there.
        for rate in [96000.0, 176400.0, 192000.0] {
            let params: Vec<(u32, f32)> = (25..30).map(|i| (2 + i as u32, -10.0)).collect();
            for f in [25.0, 31.5, 40.0] {
                let db = sine_gain_db(13, &params, f, rate);
                assert!(db.abs() < 0.2, "{rate} Hz rate, {f} Hz: {db} dB");
            }
            // A bass cut lands on its slider values.
            let params: Vec<(u32, f32)> = (0..6).map(|i| (2 + i as u32, -12.0)).collect();
            let db = sine_gain_db(13, &params, 31.5, rate);
            assert!((db + 12.0).abs() < 0.3, "{rate} Hz rate: {db} dB");
        }
    }

    #[test]
    fn bands_above_nyquist_are_bypassed() {
        let mut fx = make(12, 32000.0, 2);
        fx.set_param(2 + 19, 12.0); // 16 kHz band at a 32 kHz rate
        let x = noise(4096, 0.3, 3);
        let y = run_mono(fx.as_mut(), &x);
        assert!(y.iter().all(|v| v.is_finite()));
        assert!((rms(&y) - rms(&x)).abs() < 0.01);
    }
}
