//! Scientific Filter: Butterworth, Chebyshev (type I) or Bessel low pass,
//! high pass, band pass or band stop of order 1..8, as cascaded biquads.
//!
//! Params: 0 type (0 Butterworth, 1 Chebyshev, 2 Bessel), 1 mode (0 low pass,
//! 1 high pass, 2 band pass, 3 band stop), 2 order, 3 cutoff Hz (low edge in
//! band modes), 4 high cutoff Hz (band modes), 5 passband ripple dB
//! (Chebyshev), 6 master gain dB.

use super::design::{butterworth_proto, chebyshev_proto, design, BesselTable, Family, Mode};
use super::{Cascade, Glide, SmoothParams, SUB};
use crate::fx::util::{db_to_gain, Coefs};
use crate::fx::{Effect, Smooth};

pub struct ScientificFilter {
    rate: f32,
    p: SmoothParams,
    bessel: BesselTable,
    cascade: Cascade,
    master: Smooth,
    shape: (u32, u32, u32),
}

impl ScientificFilter {
    pub fn new(rate: f32, channels: usize) -> ScientificFilter {
        use Glide::*;
        let spec = [(0.0, Step), (0.0, Step), (4.0, Step), (1000.0, Log), (4000.0, Log), (1.0, Lin), (0.0, Lin)];
        ScientificFilter {
            rate,
            p: SmoothParams::new(rate, &spec),
            bessel: BesselTable::new(),
            cascade: Cascade::new(channels, 8),
            master: Smooth::new(1.0, rate, 20.0),
            shape: (u32::MAX, 0, 0),
        }
    }

    fn design(&mut self) {
        let family = match self.p.raw[0].round() as i32 {
            1 => Family::Chebyshev,
            2 => Family::Bessel,
            _ => Family::Butterworth,
        };
        let mode = match self.p.raw[1].round() as i32 {
            1 => Mode::HighPass,
            2 => Mode::BandPass,
            3 => Mode::BandStop,
            _ => Mode::LowPass,
        };
        let order = (self.p.raw[2].round() as usize).clamp(1, 8);
        let shape = (family as u32, mode as u32, order as u32);
        if shape != self.shape {
            self.cascade.reset();
            self.shape = shape;
        }
        let ripple = self.p.get(5).clamp(0.01, 12.0) as f64;
        let proto = match family {
            Family::Butterworth => butterworth_proto(order),
            Family::Chebyshev => chebyshev_proto(order, ripple),
            Family::Bessel => self.bessel.get(order),
        };
        let even_ripple = if family == Family::Chebyshev && order % 2 == 0 { Some(ripple) } else { None };
        let mut out = [Coefs::IDENTITY; 8];
        let n = design(&proto, mode, even_ripple, self.rate, self.p.get(3), self.p.get(4), &mut out);
        for s in 0..8 {
            self.cascade.on[s] = s < n;
            self.cascade.coefs[s] = out[s];
        }
        self.cascade.commit();
        self.master.target = db_to_gain(self.p.get(6));
    }
}

impl Effect for ScientificFilter {
    fn set_param(&mut self, idx: u32, value: f32) {
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
    fn modes_and_types() {
        let r = 48000.0;
        // Butterworth low pass order 4 at 1 kHz.
        assert!((sine_gain_db(15, &[], 1000.0, r) + 3.0).abs() < 0.2);
        assert!(sine_gain_db(15, &[], 4000.0, r) < -45.0);
        // Bessel high pass order 6 at 500 Hz.
        let p = [(0, 2.0), (1, 1.0), (2, 6.0), (3, 500.0)];
        assert!((sine_gain_db(15, &p, 500.0, r) + 3.0).abs() < 0.2);
        assert!(sine_gain_db(15, &p, 5000.0, r).abs() < 0.1);
        // Chebyshev band stop 800..1200 Hz removes 1 kHz.
        let p = [(0, 1.0), (1, 3.0), (2, 4.0), (3, 800.0), (4, 1200.0), (5, 0.5)];
        assert!(sine_gain_db(15, &p, 980.0, r) < -40.0);
        assert!(sine_gain_db(15, &p, 100.0, r) > -0.6);
        // Band pass order 8.
        let p = [(1, 2.0), (2, 8.0), (3, 300.0), (4, 3000.0)];
        assert!(sine_gain_db(15, &p, 950.0, r).abs() < 0.2);
        assert!(sine_gain_db(15, &p, 60.0, r) < -60.0);
    }

    #[test]
    fn passband_stays_at_unity_with_edges_near_dc_at_high_rates() {
        for r in [96000.0, 192000.0] {
            // Band stop 10..200 Hz, order 8: the passband above it is 0 dB.
            let p = [(1, 3.0), (2, 8.0), (3, 10.0), (4, 200.0)];
            assert!(sine_gain_db(15, &p, 2000.0, r).abs() < 0.1, "band stop at {r}");
            assert!(sine_gain_db(15, &p, 20000.0, r).abs() < 0.1, "band stop at {r}");
            // Low pass 10 Hz, order 8: DC passes at unity.
            let mut fx = make(15, r, 1);
            for (i, v) in [(1, 0.0), (2, 8.0), (3, 10.0)] {
                fx.set_param(i, v);
            }
            fx.reset();
            let y = run_mono(fx.as_mut(), &vec![0.5; r as usize * 2]);
            assert!((y[y.len() - 1] / 0.5 - 1.0).abs() < 0.01, "low pass DC at {r}: {}", y[y.len() - 1]);
        }
    }
}
