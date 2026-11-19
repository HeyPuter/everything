//! Single-band Compressor (kind 31) and Tube Compressor (kind 34).
//!
//! Single-band params: 0 threshold dB, 1 ratio, 2 attack ms, 3 release ms,
//! 4 output gain dB, 5 knee dB, 6 detection (0 peak, 1 RMS), 7 link channels.
//! Tube params: 0 threshold dB, 1 ratio, 2 attack ms, 3 release ms,
//! 4 output gain dB, 5 drive dB, 6 character % (asymmetry of the saturation).
//! Readout (both): [input peak dB, deepest gain reduction dB, output peak dB]
//! since the last read.
//!
//! Detection is instantaneous (peak) or a 10 ms RMS; the gain change from the
//! static soft-knee curve is smoothed in dB with the attack and release times.

use super::common::{db_lin, frame_peak, lin_db, soft_tanh, Detector, GainSmoother, Meters};
use crate::fx::util::{compress_db, sanitize, Biquad, Coefs};
use crate::fx::Effect;
use super::common::Ramp;

const RMS_MS: f32 = 10.0;

/// Static settings shared by the compressor cores.
#[derive(Clone, Copy)]
pub struct Curve {
    pub threshold: f32,
    pub ratio: f32,
    pub knee: f32,
}

impl Curve {
    /// Linear level below which the curve does nothing.
    #[inline]
    pub fn floor_lin(&self) -> f32 {
        db_lin(self.threshold - self.knee * 0.5)
    }
    #[inline]
    pub fn gain_db(&self, level_lin: f32, floor: f32) -> f32 {
        if level_lin <= floor {
            0.0
        } else {
            compress_db(lin_db(level_lin), self.threshold, self.ratio, self.knee)
        }
    }
}

/// Detector plus smoother for one sidechain.
#[derive(Clone, Copy, Default)]
struct Side {
    det: Detector,
    gain: GainSmoother,
}

pub struct Compressor {
    rate: f32,
    curve: Curve,
    attack: f32,
    release: f32,
    rms: bool,
    link: bool,
    out: Ramp,
    side: [Side; 2],
    meters: Meters,
}

impl Compressor {
    pub fn new(rate: f32, _channels: usize) -> Compressor {
        let mut c = Compressor {
            rate,
            curve: Curve { threshold: -20.0, ratio: 4.0, knee: 6.0 },
            attack: 10.0,
            release: 100.0,
            rms: false,
            link: true,
            out: Ramp::new(1.0, rate, 20.0),
            side: [Side::default(); 2],
            meters: Meters::default(),
        };
        c.update();
        c
    }
    fn update(&mut self) {
        for s in &mut self.side {
            if self.rms {
                s.det.set(self.rate, RMS_MS, RMS_MS, true);
            } else {
                s.det.set(self.rate, 0.0, 0.0, false);
            }
            s.gain.set(self.rate, self.attack, self.release);
        }
    }
}

impl Effect for Compressor {
    fn set_param(&mut self, idx: u32, v: f32) {
        match idx {
            0 => self.curve.threshold = v.clamp(-80.0, 0.0),
            1 => self.curve.ratio = v.clamp(1.0, 100.0),
            2 => self.attack = v.clamp(0.0, 2000.0),
            3 => self.release = v.clamp(1.0, 10000.0),
            4 => self.out.target = db_lin(v.clamp(-40.0, 40.0)),
            5 => self.curve.knee = v.clamp(0.0, 40.0),
            6 => self.rms = v >= 0.5,
            7 => self.link = v >= 0.5,
            _ => return,
        }
        self.update();
    }
    fn process(&mut self, buf: &mut [f32], channels: usize, frames: usize) {
        let floor = self.curve.floor_lin();
        let curve = self.curve;
        let m = &mut self.meters;
        if self.link || channels == 1 {
            let s = &mut self.side[0];
            for i in 0..frames {
                let pk = frame_peak(buf, channels, frames, i);
                let level = s.det.next(pk);
                let gr = s.gain.next(curve.gain_db(level, floor));
                let g = db_lin(gr) * self.out.next();
                m.inp = m.inp.max(pk);
                m.gr = m.gr.min(gr);
                m.out = m.out.max(pk * g);
                for c in 0..channels {
                    buf[c * frames + i] *= g;
                }
            }
        } else {
            for i in 0..frames {
                let o = self.out.next();
                for c in 0..2 {
                    let s = &mut self.side[c];
                    let x = &mut buf[c * frames + i];
                    let level = s.det.next(x.abs());
                    let gr = s.gain.next(curve.gain_db(level, floor));
                    m.inp = m.inp.max(x.abs());
                    m.gr = m.gr.min(gr);
                    *x *= db_lin(gr) * o;
                    m.out = m.out.max(x.abs());
                }
            }
        }
        m.gr = sanitize(m.gr);
    }
    fn readout(&mut self, out: &mut [f32]) -> usize {
        self.meters.read(out)
    }
    fn reset(&mut self) {
        self.out.settle();
        for s in &mut self.side {
            s.det.reset();
            s.gain.reset();
        }
    }
}

pub struct TubeCompressor {
    rate: f32,
    curve: Curve,
    attack: f32,
    release: f32,
    out: Ramp,
    drive: Ramp,
    bias: f32,
    bias_out: f32,
    norm: f32,
    side: Side,
    dc: [Biquad; 2],
    drive_db: f32,
    meter_in: f32,
    meter_gr: f32,
    meter_out: f32,
}

/// Derivative of soft_tanh at x (|x| < 3).
fn soft_tanh_slope(x: f32) -> f32 {
    let x2 = x * x;
    let d = 27.0 + 9.0 * x2;
    ((27.0 + 3.0 * x2) * d - (27.0 * x + x2 * x) * 18.0 * x) / (d * d)
}

impl TubeCompressor {
    pub fn new(rate: f32, _channels: usize) -> TubeCompressor {
        let mut t = TubeCompressor {
            rate,
            curve: Curve { threshold: -20.0, ratio: 3.0, knee: 10.0 },
            attack: 20.0,
            release: 250.0,
            out: Ramp::new(1.0, rate, 20.0),
            drive: Ramp::new(1.0, rate, 20.0),
            bias: 0.0,
            bias_out: 0.0,
            norm: 1.0,
            side: Side::default(),
            dc: [Biquad::new(Coefs::highpass1(rate, 8.0)); 2],
            drive_db: 6.0,
            meter_in: 0.0,
            meter_gr: 0.0,
            meter_out: 0.0,
        };
        t.set_param(6, 30.0);
        t.set_param(5, 6.0);
        t.drive.settle();
        t.update();
        t
    }
    fn update(&mut self) {
        // RMS detection gives the slower, smoother tube response.
        self.side.det.set(self.rate, RMS_MS, RMS_MS * 2.0, true);
        self.side.gain.set(self.rate, self.attack, self.release);
        self.drive.target = db_lin(self.drive_db);
        self.bias_out = soft_tanh(self.bias);
        self.norm = 1.0 / soft_tanh_slope(self.bias);
    }
}

impl Effect for TubeCompressor {
    fn set_param(&mut self, idx: u32, v: f32) {
        match idx {
            0 => self.curve.threshold = v.clamp(-80.0, 0.0),
            1 => self.curve.ratio = v.clamp(1.0, 100.0),
            2 => self.attack = v.clamp(0.0, 2000.0),
            3 => self.release = v.clamp(1.0, 10000.0),
            4 => self.out.target = db_lin(v.clamp(-40.0, 40.0)),
            5 => self.drive_db = v.clamp(0.0, 36.0),
            6 => self.bias = (v * 0.01).clamp(0.0, 1.0) * 0.5,
            _ => return,
        }
        self.update();
    }
    fn process(&mut self, buf: &mut [f32], channels: usize, frames: usize) {
        let floor = self.curve.floor_lin();
        let curve = self.curve;
        let (bias, bias_out, norm) = (self.bias, self.bias_out, self.norm);
        for i in 0..frames {
            let pk = frame_peak(buf, channels, frames, i);
            let level = self.side.det.next(pk);
            let gr = self.side.gain.next(curve.gain_db(level, floor));
            self.meter_in = self.meter_in.max(pk);
            self.meter_gr = self.meter_gr.min(gr);
            let g = db_lin(gr);
            let d = self.drive.next();
            let o = self.out.next();
            // Saturation normalised to unity small-signal gain, so drive adds
            // harmonics and soft peak rounding rather than level.
            let k = norm / d;
            for c in 0..channels {
                let x = &mut buf[c * frames + i];
                let y = (soft_tanh(*x * g * d + bias) - bias_out) * k;
                *x = self.dc[c].process(y) * o;
                self.meter_out = self.meter_out.max(x.abs());
            }
        }
        for b in &mut self.dc {
            b.flush();
        }
        self.side.gain.db = sanitize(self.side.gain.db);
    }
    fn reset(&mut self) {
        self.out.settle();
        self.drive.settle();
        self.side.det.reset();
        self.side.gain.reset();
        for b in &mut self.dc {
            b.reset();
        }
    }
    fn readout(&mut self, out: &mut [f32]) -> usize {
        if out.len() < 3 {
            return 0;
        }
        out[0] = lin_db(self.meter_in + 1e-10).max(-120.0);
        out[1] = self.meter_gr;
        out[2] = lin_db(self.meter_out + 1e-10).max(-120.0);
        self.meter_in = 0.0;
        self.meter_gr = 0.0;
        self.meter_out = 0.0;
        3
    }
}

#[cfg(test)]
mod tests {
    use crate::fx::testutil::*;
    use crate::fx::util::gain_to_db;

    fn steady_gain_db(kind: u32, params: &[(u32, f32)], amp: f32) -> f32 {
        let r = 48000.0;
        let mut fx = make(kind, r, 1);
        for &(i, v) in params {
            fx.set_param(i, v);
        }
        fx.reset();
        let x = sine(1000.0, r, 48000, amp);
        let y = run_mono(fx.as_mut(), &x);
        gain_to_db(rms(&y[36000..]) / rms(&x[36000..]))
    }

    #[test]
    fn compressor_follows_its_static_curve() {
        // Hard knee, RMS detection: a -6 dBFS RMS tone with a -26 dB threshold and
        // 4:1 ratio is 20 dB over, so it is reduced by 15 dB.
        let amp = 0.5f32 * std::f32::consts::SQRT_2;
        let g = steady_gain_db(31, &[(0, -26.0), (1, 4.0), (5, 0.0), (6, 1.0)], amp);
        assert!((g + 15.0).abs() < 0.6, "{g}");
        // Below threshold nothing happens.
        let g = steady_gain_db(31, &[(0, -10.0), (1, 4.0), (5, 0.0)], 0.05);
        assert!(g.abs() < 0.01, "{g}");
        // Output gain applies.
        let g = steady_gain_db(31, &[(0, 0.0), (4, 6.0)], 0.05);
        assert!((g - 6.0).abs() < 0.05, "{g}");
    }

    #[test]
    fn compressor_attack_and_release_shape_the_envelope() {
        let r = 48000.0;
        let mut fx = make(31, r, 1);
        for (i, v) in [(0, -30.0), (1, 10.0), (2, 50.0), (3, 300.0), (5, 0.0)] {
            fx.set_param(i, v);
        }
        fx.reset();
        let mut x = sine(1000.0, r, 48000, 0.02);
        for v in &mut x[12000..24000] {
            *v *= 40.0;
        }
        let y = run_mono(fx.as_mut(), &x);
        // Just after the jump the gain has not caught up (overshoot), later it has.
        let early = peak(&y[12000..12480]);
        let late = peak(&y[22000..24000]);
        assert!(early > late * 1.5, "{early} {late}");
        // Release: the quiet part after the burst recovers gradually.
        let after = peak(&y[24000..24480]);
        let recovered = peak(&y[46000..48000]);
        assert!(after < recovered * 0.7, "{after} {recovered}");
    }

    #[test]
    fn unlinked_compression_is_per_channel() {
        let r = 48000.0;
        let mut fx = make(31, r, 2);
        for (i, v) in [(0, -30.0), (1, 8.0), (7, 0.0)] {
            fx.set_param(i, v);
        }
        fx.reset();
        let loud = sine(500.0, r, 24000, 0.9);
        let quiet = sine(500.0, r, 24000, 0.01);
        let (_, q) = run_stereo(fx.as_mut(), &loud, &quiet);
        assert!((peak(&q[12000..]) - 0.01).abs() < 0.001);
    }

    #[test]
    fn tube_compressor_compresses_and_adds_harmonics() {
        let g_quiet = steady_gain_db(34, &[(0, -20.0), (5, 0.0)], 0.01);
        assert!(g_quiet.abs() < 0.3, "{g_quiet}");
        let g_loud = steady_gain_db(34, &[(0, -20.0), (1, 4.0), (5, 0.0)], 0.7);
        assert!(g_loud < -6.0, "{g_loud}");
        // Drive adds distortion: energy outside the fundamental grows.
        let r = 48000.0;
        let thd = |drive: f32| {
            let mut fx = make(34, r, 1);
            fx.set_param(0, 0.0);
            fx.set_param(5, drive);
            fx.reset();
            let x = sine(1000.0, r, 24000, 0.5);
            let y = run_mono(fx.as_mut(), &x);
            // Remove the fundamental by projection.
            let (mut s, mut c) = (0.0f64, 0.0f64);
            for i in 12000..24000 {
                let p = std::f64::consts::TAU * 1000.0 * i as f64 / 48000.0;
                s += y[i] as f64 * p.sin();
                c += y[i] as f64 * p.cos();
            }
            let n = 12000.0;
            let (s, c) = (2.0 * s / n, 2.0 * c / n);
            let mut res = 0.0f64;
            for i in 12000..24000 {
                let p = std::f64::consts::TAU * 1000.0 * i as f64 / 48000.0;
                let e = y[i] as f64 - s * p.sin() - c * p.cos();
                res += e * e;
            }
            (res / n).sqrt() as f32 / rms(&y[12000..])
        };
        assert!(thd(18.0) > thd(0.0) * 3.0);
        assert!(thd(18.0) > 0.01);
    }

    #[test]
    fn single_band_reports_its_gain_reduction() {
        // -10 dBFS sine, threshold -30, 4:1, no knee: about 15 dB of reduction once settled.
        let mut fx = make(31, 48000.0, 1);
        for (i, v) in [(0u32, -30.0f32), (1, 4.0), (5, 0.0), (2, 1.0)] {
            fx.set_param(i, v);
        }
        fx.reset();
        let x = sine(1000.0, 48000.0, 48000, 0.316);
        let mut buf = x.clone();
        fx.process(&mut buf, 1, 48000);
        let mut out = [0.0f32; 3];
        assert_eq!(fx.readout(&mut out), 3);
        assert!((out[0] + 10.0).abs() < 0.2, "input {}", out[0]);
        assert!((out[1] + 15.0).abs() < 1.0, "reduction {}", out[1]);
        // The output peak includes the first few cycles, before the attack has acted.
        assert!(out[2] < out[0] - 2.0, "output {}", out[2]);
        fx.readout(&mut out);
        assert_eq!(out[1], 0.0);
    }
}

