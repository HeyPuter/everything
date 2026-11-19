//! Hard Limiter (kind 30) and Loudness Maximizer (kind 38): brickwall
//! lookahead limiting with util::Limiter.
//!
//! Hard Limiter params: 0 ceiling dB, 1 input boost dB, 2 lookahead ms,
//! 3 release ms, 4 link channels (0/1), 5 true peak (0/1: detect peaks 4x
//! oversampled so peaks between samples stay under the ceiling too; adds
//! TP_DELAY frames of latency). Readout: [input peak dB, deepest gain
//! reduction dB, output peak dB] since the last read.
//! Loudness Maximizer params: 0 boost dB, 1 ceiling dB, 2 release ms,
//! 3 lookahead ms, 4 low level boost % (slow upward compression of quiet passages).

use super::common::{db_lin, frame_peak, lin_db, Detector, GainSmoother, Meters};
use crate::fx::util::{db_to_gain, Limiter};
use crate::loudness::TruePeak;
use crate::fx::Effect;
use super::common::Ramp;

/// Longest lookahead either effect accepts.
pub const MAX_LOOKAHEAD_MS: f32 = 20.0;
/// Frames the true-peak interpolator lags its input (half its 64-tap 4x filter).
pub const TP_DELAY: usize = 8;

pub struct HardLimiter {
    rate: f32,
    lim: [Limiter; 2],
    boost: Ramp,
    ceiling_db: f32,
    look_ms: f32,
    release_ms: f32,
    link: bool,
    true_peak: bool,
    tp: TruePeak,
    /// Audio delayed by TP_DELAY so it lines up with the true-peak detector.
    tp_delay: [[f32; TP_DELAY]; 2],
    tp_pos: usize,
    meters: Meters,
}

impl HardLimiter {
    pub fn new(rate: f32, _channels: usize) -> HardLimiter {
        let mut h = HardLimiter {
            rate,
            lim: [Limiter::new(rate, MAX_LOOKAHEAD_MS), Limiter::new(rate, MAX_LOOKAHEAD_MS)],
            boost: Ramp::new(1.0, rate, 20.0),
            ceiling_db: -0.1,
            look_ms: 5.0,
            release_ms: 80.0,
            link: true,
            true_peak: false,
            tp: TruePeak::new(2),
            tp_delay: [[0.0; TP_DELAY]; 2],
            tp_pos: 0,
            meters: Meters::default(),
        };
        h.update();
        h
    }
    /// One frame through the true-peak path: detects on the oversampled
    /// input and limits the matching delayed frame.
    #[inline]
    fn true_peak_frame(&mut self, l: f32, r: f32, stereo: bool) -> (f32, f32) {
        let pl = self.tp.push(0, l);
        let pr = if stereo { self.tp.push(1, r) } else { pl };
        self.tp.advance();
        let k = self.tp_pos;
        let (dl, dr) = (self.tp_delay[0][k], self.tp_delay[1][k]);
        self.tp_delay[0][k] = l;
        self.tp_delay[1][k] = r;
        self.tp_pos = (k + 1) % TP_DELAY;
        let (a, b) = (pl.max(dl.abs()), pr.max(dr.abs()));
        if !stereo {
            let y = self.lim[0].process_peak(dl, dl, a).0;
            return (y, y);
        }
        if self.link {
            self.lim[0].process_peak(dl, dr, a.max(b))
        } else {
            (self.lim[0].process_peak(dl, dl, a).0, self.lim[1].process_peak(dr, dr, b).0)
        }
    }
    fn update(&mut self) {
        let ceiling = db_to_gain(self.ceiling_db);
        for l in &mut self.lim {
            l.set(self.rate, self.look_ms, self.release_ms, ceiling);
        }
    }
}

impl Effect for HardLimiter {
    fn set_param(&mut self, idx: u32, v: f32) {
        match idx {
            0 => self.ceiling_db = v.clamp(-100.0, 0.0),
            1 => self.boost.target = db_to_gain(v.clamp(-100.0, 48.0)),
            2 => self.look_ms = v.clamp(0.1, MAX_LOOKAHEAD_MS),
            3 => self.release_ms = v.clamp(1.0, 5000.0),
            4 => self.link = v >= 0.5,
            5 => {
                let on = v >= 0.5;
                if on != self.true_peak {
                    self.true_peak = on;
                    self.reset();
                }
            }
            _ => return,
        }
        self.update();
    }
    fn process(&mut self, buf: &mut [f32], channels: usize, frames: usize) {
        // Input level before the boost; reduction is the limiter's own gain.
        for i in 0..frames {
            self.meters.inp = self.meters.inp.max(frame_peak(buf, channels, frames, i));
        }
        let least = self.limit(buf, channels, frames);
        self.meters.gr = self.meters.gr.min(lin_db(least.max(1e-6)));
        for i in 0..frames {
            self.meters.out = self.meters.out.max(frame_peak(buf, channels, frames, i));
        }
    }
    fn readout(&mut self, out: &mut [f32]) -> usize {
        self.meters.read(out)
    }
    fn reset(&mut self) {
        self.boost.settle();
        for l in &mut self.lim {
            l.reset();
        }
        self.tp = TruePeak::new(2);
        self.tp_delay = [[0.0; TP_DELAY]; 2];
        self.tp_pos = 0;
    }
    fn latency(&self) -> u32 {
        (self.lim[0].latency() + if self.true_peak { TP_DELAY } else { 0 }) as u32
    }
}

impl HardLimiter {
    /// Limits one block; returns the least gain the limiters applied in it.
    fn limit(&mut self, buf: &mut [f32], channels: usize, frames: usize) -> f32 {
        let mut least = 1.0f32;
        if self.true_peak {
            for i in 0..frames {
                let g = self.boost.next();
                if channels >= 2 {
                    let (a, b) = self.true_peak_frame(buf[i] * g, buf[frames + i] * g, true);
                    buf[i] = a;
                    buf[frames + i] = b;
                } else {
                    buf[i] = self.true_peak_frame(buf[i] * g, 0.0, false).0;
                }
                least = least.min(self.lim[0].gain).min(self.lim[1].gain);
            }
            return least;
        }
        for i in 0..frames {
            let g = self.boost.next();
            if channels >= 2 {
                let (l, r) = (buf[i] * g, buf[frames + i] * g);
                let (a, b) = if self.link {
                    self.lim[0].process(l, r)
                } else {
                    (self.lim[0].process(l, l).0, self.lim[1].process(r, r).0)
                };
                buf[i] = a;
                buf[frames + i] = b;
            } else {
                let x = buf[i] * g;
                buf[i] = self.lim[0].process(x, x).0;
            }
            least = least.min(self.lim[0].gain).min(self.lim[1].gain);
        }
        least
    }
}

pub struct LoudnessMaximizer {
    rate: f32,
    lim: Limiter,
    boost: Ramp,
    ceiling_db: f32,
    look_ms: f32,
    release_ms: f32,
    low_amount: f32,
    det: Detector,
    up: GainSmoother,
}

impl LoudnessMaximizer {
    pub fn new(rate: f32, _channels: usize) -> LoudnessMaximizer {
        let mut m = LoudnessMaximizer {
            rate,
            lim: Limiter::new(rate, MAX_LOOKAHEAD_MS),
            boost: Ramp::new(1.0, rate, 20.0),
            ceiling_db: -0.3,
            look_ms: 5.0,
            release_ms: 100.0,
            low_amount: 0.0,
            det: Detector::default(),
            up: GainSmoother::default(),
        };
        // Slow RMS for upward compression; the gain falls quickly (so a loud
        // entry is not over-boosted) and rises slowly.
        m.det.set(rate, 30.0, 300.0, true);
        m.up.set(rate, 30.0, 800.0);
        m.update();
        m
    }
    fn update(&mut self) {
        self.lim.set(self.rate, self.look_ms, self.release_ms, db_to_gain(self.ceiling_db));
    }
    /// Upward gain in dB for a slow RMS level: lifts passages below -30 dB by
    /// up to 12 dB scaled by the amount, fading out for near-silence (< -70 dB)
    /// so noise floors are not raised.
    #[inline]
    fn upward_db(level: f32, amount: f32) -> f32 {
        if amount <= 0.0 {
            return 0.0;
        }
        let lift = ((-30.0 - level) * 0.5).clamp(0.0, 12.0);
        let gate = ((level + 70.0) / 10.0).clamp(0.0, 1.0);
        lift * gate * amount
    }
}

impl Effect for LoudnessMaximizer {
    fn set_param(&mut self, idx: u32, v: f32) {
        match idx {
            0 => self.boost.target = db_to_gain(v.clamp(-12.0, 36.0)),
            1 => self.ceiling_db = v.clamp(-30.0, 0.0),
            2 => self.release_ms = v.clamp(1.0, 5000.0),
            3 => self.look_ms = v.clamp(0.1, MAX_LOOKAHEAD_MS),
            4 => self.low_amount = (v * 0.01).clamp(0.0, 1.0),
            _ => return,
        }
        self.update();
    }
    fn process(&mut self, buf: &mut [f32], channels: usize, frames: usize) {
        let amount = self.low_amount;
        for i in 0..frames {
            let mut g = self.boost.next();
            if amount > 0.0 {
                let level = self.det.level_db(frame_peak(buf, channels, frames, i));
                g *= db_lin(self.up.next(Self::upward_db(level, amount)));
            } else if self.up.db != 0.0 {
                g *= db_lin(self.up.next(0.0));
            }
            if channels >= 2 {
                let (a, b) = self.lim.process(buf[i] * g, buf[frames + i] * g);
                buf[i] = a;
                buf[frames + i] = b;
            } else {
                let x = buf[i] * g;
                buf[i] = self.lim.process(x, x).0;
            }
        }
        if self.up.db.abs() < 1e-6 {
            self.up.db = 0.0;
        }
    }
    fn reset(&mut self) {
        self.boost.settle();
        self.lim.reset();
        self.det.reset();
        self.up.reset();
    }
    fn latency(&self) -> u32 {
        self.lim.latency() as u32
    }
}

#[cfg(test)]
mod tests {
    use crate::fx::testutil::*;
    use crate::fx::util::{db_to_gain, ms_frames};

    #[test]
    fn hard_limiter_never_exceeds_ceiling() {
        let r = 48000.0;
        let mut fx = make(30, r, 2);
        fx.set_param(0, -3.0);
        fx.set_param(1, 12.0);
        fx.reset();
        let x = noise(48000, 0.9, 7);
        let (l, rr) = run_stereo(fx.as_mut(), &x, &x);
        assert!(peak(&l) <= db_to_gain(-3.0) + 1e-6);
        assert!(peak(&rr) <= db_to_gain(-3.0) + 1e-6);
        assert!(peak(&l) > db_to_gain(-3.5));
        assert_eq!(fx.latency() as usize, ms_frames(5.0, r) - 1);
    }

    /// Largest 4x-oversampled peak of a signal from frame `from` on (the
    /// interpolator runs from the start so its onset ringing is skipped).
    fn true_peak(x: &[f32], from: usize) -> f32 {
        let mut tp = crate::loudness::TruePeak::new(1);
        let mut m = 0.0f32;
        for (i, &v) in x.iter().enumerate() {
            let p = tp.push(0, v);
            tp.advance();
            if i >= from {
                m = m.max(p);
            }
        }
        m
    }

    #[test]
    fn true_peak_mode_keeps_peaks_between_samples_under_the_ceiling() {
        let r = 48000.0;
        // A quarter-rate tone sampled 45 degrees off its crests: samples reach
        // only 71 % of the waveform's true peak.
        let x: Vec<f32> = (0..9600).map(|i| 0.95 * (std::f32::consts::FRAC_PI_2 * i as f32 + std::f32::consts::FRAC_PI_4).sin()).collect();
        let ceiling = db_to_gain(-1.0);
        let run = |tp: f32| {
            let mut fx = make(30, r, 1);
            fx.set_param(0, -1.0);
            fx.set_param(5, tp);
            fx.reset();
            let y = run_mono(fx.as_mut(), &x);
            (true_peak(&y, 2400), fx.latency() as usize)
        };
        let (sample_mode, lat0) = run(0.0);
        let (tp_mode, lat1) = run(1.0);
        assert!(sample_mode > ceiling * 1.05, "{sample_mode}");
        // Within the interpolator's accuracy.
        assert!(tp_mode <= ceiling * 1.005, "{tp_mode}");
        assert_eq!(lat1, lat0 + super::TP_DELAY);
    }

    #[test]
    fn true_peak_mode_passes_quiet_audio_delayed() {
        let r = 48000.0;
        let mut fx = make(30, r, 1);
        fx.set_param(5, 1.0);
        fx.reset();
        let lat = fx.latency() as usize;
        let x = sine(440.0, r, 4800, 0.3);
        let y = run_mono(fx.as_mut(), &x);
        for i in lat..x.len() {
            assert!((y[i] - x[i - lat]).abs() < 1e-5);
        }
    }

    #[test]
    fn hard_limiter_passes_quiet_audio_delayed() {
        let r = 48000.0;
        let mut fx = make(30, r, 1);
        fx.set_param(2, 2.0);
        fx.reset();
        let lat = fx.latency() as usize;
        let x = sine(440.0, r, 4800, 0.3);
        let y = run_mono(fx.as_mut(), &x);
        for i in lat..x.len() {
            assert!((y[i] - x[i - lat]).abs() < 1e-5);
        }
    }

    #[test]
    fn unlinked_channels_limit_independently() {
        let r = 48000.0;
        let mut fx = make(30, r, 2);
        fx.set_param(0, -6.0);
        fx.set_param(4, 0.0);
        fx.reset();
        let loud = sine(200.0, r, 24000, 1.0);
        let quiet = sine(300.0, r, 24000, 0.2);
        let (l, q) = run_stereo(fx.as_mut(), &loud, &quiet);
        assert!(peak(&l[12000..]) <= db_to_gain(-6.0) + 1e-6);
        // The quiet channel is untouched when unlinked.
        assert!((peak(&q[12000..]) - 0.2).abs() < 0.01);
        let mut fx = make(30, r, 2);
        fx.set_param(0, -6.0);
        fx.reset();
        let (_, q) = run_stereo(fx.as_mut(), &loud, &quiet);
        assert!(peak(&q[12000..]) < 0.15, "linked limiting ducks both channels");
    }

    #[test]
    fn maximizer_raises_loudness_under_the_ceiling() {
        let r = 48000.0;
        let mut fx = make(38, r, 2);
        fx.set_param(0, 10.0);
        fx.set_param(1, -1.0);
        fx.reset();
        let x = noise(48000, 0.5, 3);
        let (l, _) = run_stereo(fx.as_mut(), &x, &x);
        assert!(peak(&l) <= db_to_gain(-1.0) + 1e-6);
        assert!(rms(&l[4800..]) > rms(&x) * 1.3);
    }

    #[test]
    fn low_level_boost_lifts_quiet_passages_only() {
        let r = 48000.0;
        let run = |amount: f32, amp: f32| {
            let mut fx = make(38, r, 1);
            fx.set_param(0, 0.0);
            fx.set_param(4, amount);
            fx.reset();
            let x = sine(500.0, r, 192000, amp);
            let y = run_mono(fx.as_mut(), &x);
            rms(&y[168000..]) / rms(&x[168000..])
        };
        assert!(run(100.0, 0.01) > 1.8); // -43 dB RMS gets lifted about 6.5 dB
        assert!((run(100.0, 0.5) - 1.0).abs() < 0.02); // loud passes
        assert!((run(0.0, 0.01) - 1.0).abs() < 0.01);
        assert!((run(100.0, 0.00005) - 1.0).abs() < 0.05); // near-silence is not raised
    }

    #[test]
    fn hard_limiter_reports_its_gain_reduction() {
        let mut fx = make(30, 48000.0, 2);
        fx.set_param(0, -6.0);
        fx.reset();
        let x = sine(1000.0, 48000.0, 9600, 1.0);
        let mut buf: Vec<f32> = x.iter().chain(x.iter()).copied().collect();
        fx.process(&mut buf, 2, 9600);
        let mut out = [0.0f32; 3];
        assert_eq!(fx.readout(&mut out), 3);
        assert!(out[0] > -0.1, "input {}", out[0]);
        assert!((out[1] + 6.0).abs() < 0.5, "reduction {}", out[1]);
        assert!(out[2] < -5.8, "output {}", out[2]);
        // Read again: reset, so quiet input shows no reduction.
        let mut quiet: Vec<f32> = vec![0.01; 2 * 9600];
        fx.process(&mut quiet, 2, 9600);
        fx.readout(&mut out);
        assert!(out[0] < -39.0 && out[1] > -6.5, "{:?}", out);
    }
}
