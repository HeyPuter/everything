//! Multiband Compressor (kind 33): four bands split by fourth-order
//! Linkwitz-Riley crossovers (with all-pass phase alignment so the bands sum
//! flat), a compressor per band and an output limiter.
//!
//! Params: 0..=2 crossover frequencies Hz (low/mid, mid, mid/high; kept ordered),
//!   then per band b (0..4) at 3 + 7 b: threshold dB, gain dB, ratio, attack ms,
//!   release ms, solo, bypass;
//!   31 output gain dB, 32 limiter on, 33 limiter threshold dB, 34 limiter margin dB,
//!   35 limiter release ms, 36 brickwall (lookahead) limiting, 37 link channels,
//!   38 limiter attack ms.
//! The limiter boosts by (margin - threshold) and caps peaks at the margin.
//! Brickwall limiting looks ahead by the attack time, so the gain has reached
//! its target when a peak arrives; otherwise the attack smooths the gain
//! drop and short peaks may pass.
//! Latency: the attack (as lookahead) minus one frame when the limiter is on
//! and brickwall.
//! Readout (9 values): per band its input peak dB and deepest gain reduction
//! dB since the last read, then the output peak dB.
//!
//! Band gains are computed at a control rate of one update per K frames (the
//! detectors still see every sample) and interpolated per sample, which keeps
//! four compressors per channel cheap enough for the AudioWorklet.

use super::common::{db_lin, lin_db, Detector, GainSmoother, Ramp};
use crate::fx::util::{compress_db, lr_allpass, ms_coef, ms_frames, Biquad, Crossover, Limiter};
use crate::fx::Effect;

/// Longest limiter attack (the brickwall lookahead buffer).
pub const MAX_ATTACK_MS: f32 = 50.0;
const BANDS: usize = 4;
const PER_BAND: usize = 7;
const NPARAMS: usize = 39;
/// Control-rate block for gain computation.
const K: usize = 8;

#[derive(Clone, Copy, Default)]
struct Split {
    x2: Crossover,
    x1: Crossover,
    x3: Crossover,
    ap_low: Biquad,
    ap_high: Biquad,
}

impl Split {
    fn set(&mut self, rate: f32, f: [f32; 3]) {
        self.x1.set(rate, f[0]);
        self.x2.set(rate, f[1]);
        self.x3.set(rate, f[2]);
        self.ap_low.c = lr_allpass(rate, f[2]);
        self.ap_high.c = lr_allpass(rate, f[0]);
    }
    #[inline]
    fn split(&mut self, x: f32) -> [f32; 4] {
        let (lo, hi) = self.x2.split(x);
        let lo = self.ap_low.process(lo);
        let hi = self.ap_high.process(hi);
        let (b0, b1) = self.x1.split(lo);
        let (b2, b3) = self.x3.split(hi);
        [b0, b1, b2, b3]
    }
    fn reset(&mut self) {
        self.x1.reset();
        self.x2.reset();
        self.x3.reset();
        self.ap_low.reset();
        self.ap_high.reset();
    }
    fn flush(&mut self) {
        self.x1.flush();
        self.x2.flush();
        self.x3.flush();
        self.ap_low.flush();
        self.ap_high.flush();
    }
}

#[derive(Clone, Copy, Default)]
struct Band {
    threshold: f32,
    ratio: f32,
    floor: f32,
    bypass: bool,
    solo: bool,
    det: [Detector; 2],
    gr: [GainSmoother; 2],
    gain: Ramp,
    /// Gain applied at the end of the previous control block.
    last: [f32; 2],
}

pub struct Multiband {
    rate: f32,
    p: [f32; NPARAMS],
    split: [Split; 2],
    freq: [Ramp; 3],
    bands: [Band; BANDS],
    out: Ramp,
    lim: Limiter,
    fast_env: f32,
    fast_rel: f32,
    fast_att: f32,
    lim_boost: Ramp,
    lim_on: bool,
    brickwall: bool,
    link: bool,
    any_solo: bool,
    /// Meters since the last readout: band input peaks (linear), band gain
    /// reductions (dB, <= 0) and the output peak (linear).
    meter_in: [f32; BANDS],
    meter_gr: [f32; BANDS],
    meter_out: f32,
}

/// Default parameter values (also the JS defaults).
pub const DEFAULTS: [f32; NPARAMS] = [
    120.0, 2000.0, 10000.0, //
    -18.0, 0.0, 2.0, 10.0, 250.0, 0.0, 0.0, //
    -18.0, 0.0, 2.0, 5.0, 150.0, 0.0, 0.0, //
    -18.0, 0.0, 2.0, 3.0, 100.0, 0.0, 0.0, //
    -18.0, 0.0, 2.0, 1.0, 80.0, 0.0, 0.0, //
    0.0, 1.0, 0.0, -0.1, 100.0, 1.0, 1.0, //
    5.0,
];

impl Multiband {
    pub fn new(rate: f32, _channels: usize) -> Multiband {
        let mut m = Multiband {
            rate,
            p: DEFAULTS,
            split: [Split::default(); 2],
            freq: [Ramp::new(0.0, rate / K as f32, 30.0); 3],
            bands: [Band { gain: Ramp::new(1.0, rate / K as f32, 20.0), last: [1.0; 2], ..Band::default() }; BANDS],
            out: Ramp::new(1.0, rate, 20.0),
            lim: Limiter::new(rate, MAX_ATTACK_MS),
            fast_env: 1.0,
            fast_rel: 0.0,
            fast_att: 0.0,
            lim_boost: Ramp::new(1.0, rate, 20.0),
            lim_on: true,
            brickwall: true,
            link: true,
            any_solo: false,
            meter_in: [0.0; BANDS],
            meter_gr: [0.0; BANDS],
            meter_out: 0.0,
        };
        m.update();
        m.reset();
        m
    }

    /// Ordered crossover frequencies in log2 Hz. Each bound is applied as a
    /// max then a min (not `clamp`): at the ceiling, f1 * 1.1 can round just
    /// above top / 1.1, and `clamp` panics when its lower bound passes the
    /// upper one.
    fn freq_targets(&self) -> [f32; 3] {
        let top = self.rate * 0.45;
        let f1 = self.p[0].max(20.0).min(top / 1.21);
        let f2 = self.p[1].max(f1 * 1.1).min(top / 1.1);
        let f3 = self.p[2].max(f2 * 1.1).min(top);
        [f1.log2(), f2.log2(), f3.log2()]
    }

    fn update(&mut self) {
        let r = self.rate;
        let t = self.freq_targets();
        for k in 0..3 {
            self.freq[k].target = t[k];
        }
        self.link = self.p[37] >= 0.5;
        self.any_solo = false;
        for b in 0..BANDS {
            let q = &self.p[3 + b * PER_BAND..3 + (b + 1) * PER_BAND];
            let band = &mut self.bands[b];
            band.threshold = q[0];
            band.gain.target = db_lin(q[1]);
            band.ratio = q[2].max(1.0);
            band.solo = q[5] >= 0.5;
            band.bypass = q[6] >= 0.5;
            band.floor = db_lin(band.threshold);
            for c in 0..2 {
                band.det[c].set(r, 0.0, 5.0, false);
                band.gr[c].set(r / K as f32, q[3].max(0.0), q[4].max(1.0));
            }
            self.any_solo |= band.solo;
        }
        self.out.target = db_lin(self.p[31]);
        self.lim_on = self.p[32] >= 0.5;
        let (thr, margin) = (self.p[33].min(0.0), self.p[34].min(0.0));
        self.lim_boost.target = db_lin((margin - thr).max(0.0));
        self.brickwall = self.p[36] >= 0.5;
        let attack = self.attack_ms();
        self.lim.set(r, attack, self.p[35].max(1.0), db_lin(margin));
        self.fast_rel = ms_coef(self.p[35].max(1.0), r);
        self.fast_att = ms_coef(attack, r);
    }

    fn attack_ms(&self) -> f32 {
        self.p[38].clamp(0.1, MAX_ATTACK_MS)
    }

    fn apply_freqs(&mut self) {
        let f = [self.freq[0].value.exp2(), self.freq[1].value.exp2(), self.freq[2].value.exp2()];
        for s in &mut self.split {
            s.set(self.rate, f);
        }
    }

    /// Linear gain at the end of a control block for one sidechain, given the
    /// block's detector peak.
    #[inline]
    fn band_gain(band: &mut Band, c: usize, level: f32) -> f32 {
        let target = if level > band.floor { compress_db(lin_db(level), band.threshold, band.ratio, 0.0) } else { 0.0 };
        let gr = band.gr[c].next(target);
        if gr > -1e-4 {
            1.0
        } else {
            db_lin(gr)
        }
    }
}

impl Effect for Multiband {
    fn set_param(&mut self, idx: u32, v: f32) {
        if (idx as usize) < NPARAMS {
            self.p[idx as usize] = v;
            self.update();
        }
    }
    /// Gain computation runs at a control rate of one update per K frames
    /// (detectors still see every sample); gains are interpolated per sample.
    fn process(&mut self, buf: &mut [f32], channels: usize, frames: usize) {
        let channels = channels.min(2);
        let ceiling = self.lim.ceiling;
        let linked = self.link || channels == 1;
        let mut at = 0;
        while at < frames {
            let n = K.min(frames - at);
            if !self.freq.iter().all(|f| f.settled()) {
                for f in &mut self.freq {
                    f.next();
                }
                self.apply_freqs();
            }
            let mut split = [[[0.0f32; BANDS]; K]; 2];
            for j in 0..n {
                for c in 0..channels {
                    split[c][j] = self.split[c].split(buf[c * frames + at + j]);
                }
            }
            // Gains at the start (g0) and end (g1) of this block per band and channel.
            let mut g0 = [[0.0f32; 2]; BANDS];
            let mut g1 = [[0.0f32; 2]; BANDS];
            for (b, band) in self.bands.iter_mut().enumerate() {
                let g_band = band.gain.next();
                let (a, z) = if self.any_solo && !band.solo {
                    (0.0, 0.0)
                } else if band.bypass {
                    (1.0, 1.0)
                } else {
                    (-1.0, -1.0)
                };
                if a >= 0.0 {
                    for c in 0..2 {
                        g0[b][c] = band.last[c];
                        g1[b][c] = a;
                        band.last[c] = z;
                    }
                    continue;
                }
                if linked {
                    let mut level = 0.0f32;
                    for j in 0..n {
                        let x = if channels == 2 { split[0][j][b].abs().max(split[1][j][b].abs()) } else { split[0][j][b].abs() };
                        level = level.max(band.det[0].next(x));
                    }
                    let g = Self::band_gain(band, 0, level) * g_band;
                    self.meter_in[b] = self.meter_in[b].max(level);
                    self.meter_gr[b] = self.meter_gr[b].min(band.gr[0].db);
                    for c in 0..2 {
                        g0[b][c] = band.last[c];
                        g1[b][c] = g;
                        band.last[c] = g;
                    }
                } else {
                    for c in 0..channels {
                        let mut level = 0.0f32;
                        for j in 0..n {
                            level = level.max(band.det[c].next(split[c][j][b].abs()));
                        }
                        let g = Self::band_gain(band, c, level) * g_band;
                        self.meter_in[b] = self.meter_in[b].max(level);
                        self.meter_gr[b] = self.meter_gr[b].min(band.gr[c].db);
                        g0[b][c] = band.last[c];
                        g1[b][c] = g;
                        band.last[c] = g;
                    }
                }
            }
            let inv = 1.0 / n as f32;
            for j in 0..n {
                let u = (j + 1) as f32 * inv;
                let mut out = [0.0f32; 2];
                for c in 0..channels {
                    let mut acc = 0.0;
                    for b in 0..BANDS {
                        acc += split[c][j][b] * (g0[b][c] + (g1[b][c] - g0[b][c]) * u);
                    }
                    out[c] = acc;
                }
                let o = self.out.next();
                let boost = self.lim_boost.next();
                let (mut l, mut r) = (out[0] * o, out[1] * o);
                if self.lim_on {
                    l *= boost;
                    r *= boost;
                    if channels == 1 {
                        r = l;
                    }
                    if self.brickwall {
                        let y = self.lim.process(l, r);
                        l = y.0;
                        r = y.1;
                    } else {
                        // No lookahead: the gain falls over the attack time and recovers over the release.
                        let peak = l.abs().max(r.abs());
                        let need = if peak > ceiling { ceiling / peak } else { 1.0 };
                        let k = if need < self.fast_env { self.fast_att } else { self.fast_rel };
                        self.fast_env = need + (self.fast_env - need) * k;
                        l *= self.fast_env;
                        r *= self.fast_env;
                    }
                }
                self.meter_out = self.meter_out.max(l.abs().max(if channels == 2 { r.abs() } else { 0.0 }));
                buf[at + j] = l;
                if channels == 2 {
                    buf[frames + at + j] = r;
                }
            }
            at += n;
        }
        for s in &mut self.split {
            s.flush();
        }
    }

    fn reset(&mut self) {
        for f in &mut self.freq {
            f.settle();
        }
        self.apply_freqs();
        self.out.settle();
        self.lim_boost.settle();
        for s in &mut self.split {
            s.reset();
        }
        for b in &mut self.bands {
            b.gain.settle();
            for c in 0..2 {
                b.det[c].reset();
                b.gr[c].reset();
            }
            b.last = [b.gain.value; 2];
        }
        self.lim.reset();
        self.fast_env = 1.0;
    }

    fn latency(&self) -> u32 {
        if self.lim_on && self.brickwall {
            (ms_frames(self.attack_ms(), self.rate).clamp(1, ms_frames(MAX_ATTACK_MS, self.rate).max(1)) - 1) as u32
        } else {
            0
        }
    }

    fn readout(&mut self, out: &mut [f32]) -> usize {
        if out.len() < 2 * BANDS + 1 {
            return 0;
        }
        for b in 0..BANDS {
            out[2 * b] = lin_db(self.meter_in[b] + 1e-10).max(-120.0);
            out[2 * b + 1] = self.meter_gr[b];
            self.meter_in[b] = 0.0;
            self.meter_gr[b] = 0.0;
        }
        out[2 * BANDS] = lin_db(self.meter_out + 1e-10).max(-120.0);
        self.meter_out = 0.0;
        2 * BANDS + 1
    }
}

#[cfg(test)]
mod tests {
    use crate::fx::testutil::*;
    use crate::fx::util::db_to_gain;

    fn neutral(fx: &mut dyn crate::fx::Effect) {
        // Thresholds at 0 dB and the limiter off: the bands only split and sum.
        for b in 0..4 {
            fx.set_param(3 + 7 * b, 0.0);
        }
        fx.set_param(32, 0.0);
    }

    #[test]
    fn crossovers_at_the_ceiling_keep_their_order() {
        // f1 at top / 1.21 used to round f1 * 1.1 above top / 1.1 and panic.
        for r in [8000.0, 11025.0, 22050.0, 44100.0, 48000.0, 88200.0, 176400.0, 192000.0] {
            for p in [[20000.0, 20000.0, 20000.0], [1e6, 0.0, 0.0], [16500.0, 18000.0, 19500.0]] {
                let mut fx = make(33, r, 2);
                for (i, v) in p.iter().enumerate() {
                    fx.set_param(i as u32, *v);
                }
                fx.reset();
                let mut buf = vec![0.1f32; 256];
                fx.process(&mut buf, 2, 128);
                assert!(buf.iter().all(|v| v.is_finite()), "{r}");
            }
        }
    }

    #[test]
    fn bands_sum_flat_when_not_compressing() {
        let r = 48000.0;
        for f in [50.0, 120.0, 700.0, 2000.0, 6000.0, 10000.0, 15000.0] {
            let mut fx = make(33, r, 1);
            neutral(fx.as_mut());
            fx.reset();
            let x = sine(f, r, 24000, 0.3);
            let y = run_mono(fx.as_mut(), &x);
            let ratio = rms(&y[12000..]) / rms(&x[12000..]);
            assert!((ratio - 1.0).abs() < 0.01, "{f}: {ratio}");
        }
    }

    #[test]
    fn solo_and_band_gain_isolate_bands() {
        let r = 48000.0;
        let mut fx = make(33, r, 1);
        neutral(fx.as_mut());
        fx.set_param(3 + 7 * 3 + 5, 1.0); // solo the top band
        fx.reset();
        let low = sine(100.0, r, 24000, 0.3);
        let y = run_mono(fx.as_mut(), &low);
        assert!(rms(&y[12000..]) < 0.003);
        let mut fx = make(33, r, 1);
        neutral(fx.as_mut());
        fx.set_param(3 + 7 + 1, -12.0); // band 2 gain
        fx.reset();
        let mid = sine(600.0, r, 24000, 0.3);
        let y = run_mono(fx.as_mut(), &mid);
        let g = rms(&y[12000..]) / rms(&mid[12000..]);
        assert!((g - db_to_gain(-12.0)).abs() < 0.03, "{g}");
    }

    #[test]
    fn band_compression_only_affects_its_band() {
        let r = 48000.0;
        let mut fx = make(33, r, 1);
        neutral(fx.as_mut());
        fx.set_param(3, -40.0); // band 1 threshold
        fx.set_param(5, 10.0);
        fx.reset();
        let low = sine(50.0, r, 48000, 0.5);
        let high = sine(5000.0, r, 48000, 0.5);
        let yl = run_mono(fx.as_mut(), &low);
        fx.reset();
        let yh = run_mono(fx.as_mut(), &high);
        assert!(rms(&yl[24000..]) < rms(&low[24000..]) * 0.2);
        assert!((rms(&yh[24000..]) / rms(&high[24000..]) - 1.0).abs() < 0.02);
    }

    #[test]
    fn output_limiter_caps_peaks() {
        let r = 48000.0;
        let mut fx = make(33, r, 2);
        fx.set_param(33, -12.0);
        fx.set_param(34, -1.0);
        fx.reset();
        let x = noise(48000, 0.7, 9);
        let (l, rr) = run_stereo(fx.as_mut(), &x, &x);
        assert!(peak(&l) <= db_to_gain(-1.0) + 1e-5 && peak(&rr) <= db_to_gain(-1.0) + 1e-5);
        assert_eq!(fx.latency(), 239);
        fx.set_param(36, 0.0);
        assert_eq!(fx.latency(), 0);
    }

    #[test]
    fn limiter_attack_sets_lookahead_or_smooths_the_drop() {
        let r = 48000.0;
        let mut fx = make(33, r, 1);
        fx.set_param(38, 20.0);
        assert_eq!(fx.latency(), 959);
        // Without lookahead a slow attack lets the start of a burst through; a fast one barely does.
        let burst: Vec<f32> = (0..9600).map(|i| if i >= 4800 { 0.9 * (i as f32 * 0.3).sin() } else { 0.0 }).collect();
        let over = |attack: f32| {
            let mut fx = make(33, r, 1);
            fx.set_param(36, 0.0);
            fx.set_param(34, -6.0);
            fx.set_param(33, -6.0);
            fx.set_param(38, attack);
            fx.reset();
            peak(&run_mono(fx.as_mut(), &burst)[4800..5400])
        };
        let (fast, slow) = (over(0.1), over(30.0));
        assert!(slow > fast + 0.1, "fast {fast} slow {slow}");
    }
}
