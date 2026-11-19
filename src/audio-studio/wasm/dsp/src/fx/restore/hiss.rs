//! Hiss Reduction: spectral gating against a smooth, slowly tracked hiss
//! floor (minimum statistics over about two seconds, smoothed across
//! frequency so the threshold is a broadband curve rather than per-bin noise).
//!
//! Params: 0 noise floor dB (offset of the threshold curve), 1 reduce by dB,
//! 2 spectral decay rate %, 3 precision factor (1..20), 4 transition width dB,
//! 5 FFT size, 6 output hiss only (0/1).
//!
//! Data slots 0 and 1: a captured (or drawn) noise floor for channel 0 / 1 as
//! (frequency Hz, level dB) pairs sorted by frequency, where the level is the
//! per-bin power of `spectral::power` in dB. A channel with a floor uses it
//! instead of tracking one; an empty block returns it to tracking.

use super::noise_reduction::fft_size;
use super::spectral::{fall_per_frame, power, power_scale, smooth_bins, GateCore, GateSettings, MinStats};
use crate::fx::util::Stft;
use crate::fx::Effect;

pub struct HissReduction {
    rate: f32,
    channels: usize,
    offset: f32,
    reduce_db: f32,
    decay: f32,
    precision: f32,
    width: f32,
    fft: usize,
    residual: bool,
    stft: Stft,
    gate: GateCore,
    stats: Vec<MinStats>,
    floor: Vec<Vec<f32>>,
    p: Vec<f32>,
    prefix: Vec<f64>,
    /// Captured floor points per channel (Hz, dB); empty = track automatically.
    curves: [Vec<(f32, f32)>; 2],
    fixed: Vec<Option<Vec<f32>>>,
}

/// Level in dB of floor points at `f`: linear in frequency below the first
/// point above 0 Hz, linear in log frequency elsewhere (`floorAt` in JS).
pub fn floor_at(pts: &[(f32, f32)], f: f32) -> f32 {
    if pts.is_empty() {
        return -200.0;
    }
    if f <= pts[0].0 {
        return pts[0].1;
    }
    for w in pts.windows(2) {
        let (a, b) = (w[0], w[1]);
        if f <= b.0 {
            let t = if a.0 <= 1.0 { (f - a.0) / (b.0 - a.0).max(1e-6) } else { (f / a.0).ln() / (b.0 / a.0).ln().max(1e-9) };
            return a.1 + (b.1 - a.1) * t.clamp(0.0, 1.0);
        }
    }
    pts[pts.len() - 1].1
}

impl HissReduction {
    pub fn new(rate: f32, channels: usize) -> HissReduction {
        let mut h = HissReduction {
            rate,
            channels,
            offset: 0.0,
            reduce_db: 18.0,
            decay: 60.0,
            precision: 7.0,
            width: 6.0,
            fft: 2048,
            residual: false,
            stft: Stft::new(256, 4, 1),
            gate: GateCore::new(1, 1),
            stats: Vec::new(),
            floor: Vec::new(),
            p: Vec::new(),
            prefix: Vec::new(),
            curves: [Vec::new(), Vec::new()],
            fixed: Vec::new(),
        };
        h.rebuild();
        h
    }

    fn overlap(&self) -> usize {
        if self.precision >= 10.0 {
            8
        } else {
            4
        }
    }

    fn rebuild(&mut self) {
        let bins = self.fft / 2 + 1;
        let ov = self.overlap();
        self.stft = Stft::new(self.fft, ov, self.channels);
        self.gate = GateCore::new(bins, self.channels);
        let hop = self.fft / ov;
        let window = (2.0 * self.rate / hop as f32) as usize;
        self.stats = (0..self.channels).map(|_| MinStats::new(bins, window).warmup(ov)).collect();
        self.floor = vec![vec![0.0; bins]; self.channels];
        self.p = vec![0.0; bins];
        self.prefix = vec![0.0; bins + 1];
        self.fixed = (0..self.channels).map(|c| self.fixed_floor(c)).collect();
    }

    /// The captured floor of channel `c` as per-bin power at the current FFT size.
    fn fixed_floor(&self, c: usize) -> Option<Vec<f32>> {
        let pts = &self.curves[c.min(1)];
        if pts.is_empty() {
            return None;
        }
        let bins = self.fft / 2 + 1;
        Some((0..bins).map(|k| 10f32.powf(floor_at(pts, k as f32 * self.rate / self.fft as f32).clamp(-200.0, 40.0) * 0.1)).collect())
    }
}

impl Effect for HissReduction {
    fn set_param(&mut self, idx: u32, v: f32) {
        match idx {
            0 => self.offset = v.clamp(-40.0, 40.0),
            1 => self.reduce_db = v.clamp(0.0, 100.0),
            2 => self.decay = v.clamp(0.0, 100.0),
            3 => {
                let old = self.overlap();
                self.precision = v.clamp(1.0, 20.0);
                if self.overlap() != old {
                    self.rebuild();
                }
            }
            4 => self.width = v.clamp(0.0, 40.0),
            5 => {
                let n = fft_size(v);
                if n != self.fft {
                    self.fft = n;
                    self.rebuild();
                }
            }
            6 => self.residual = v >= 0.5,
            _ => {}
        }
    }

    fn set_data(&mut self, slot: u32, data: &[f32]) {
        if slot > 1 {
            return;
        }
        let mut pts: Vec<(f32, f32)> = data.chunks_exact(2).filter(|p| p[0].is_finite() && p[1].is_finite()).map(|p| (p[0].max(0.0), p[1])).collect();
        pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(core::cmp::Ordering::Equal));
        self.curves[slot as usize] = pts;
        for c in 0..self.channels {
            if c.min(1) == slot as usize {
                self.fixed[c] = self.fixed_floor(c);
            }
        }
    }

    fn process(&mut self, buf: &mut [f32], _channels: usize, frames: usize) {
        let hop = self.fft / self.overlap();
        let s = GateSettings {
            threshold_db: 4.0 + self.offset,
            width_db: self.width,
            floor_db: -self.reduce_db,
            power_alpha: 1.0 - 1.0 / (1.0 + self.precision * 0.15),
            instant_rise: false,
            smooth_bins: 1,
            dilate_bins: 0,
            snr_bins: 0,
            fall: fall_per_frame(self.decay * 6.0, hop, self.rate),
            residual: self.residual,
        };
        let scale = power_scale(self.fft);
        let (gate, stats, floor, p, prefix, fixed) = (&mut self.gate, &mut self.stats, &mut self.floor, &mut self.p, &mut self.prefix, &self.fixed);
        self.stft.process(buf, frames, |re, im| {
            for c in 0..re.len() {
                if let Some(f) = &fixed[c] {
                    gate.frame(c, &mut re[c], &mut im[c], f, scale, &s, |_| 1.0);
                    continue;
                }
                power(&re[c], &im[c], p, scale);
                stats[c].update(p);
                // A broadband curve: wider smoothing higher up (about a sixth of an octave).
                smooth_bins(&stats[c].noise, &mut floor[c], prefix, |k| 2 + k / 12);
                gate.frame(c, &mut re[c], &mut im[c], &floor[c], scale, &s, |_| 1.0);
            }
        });
    }

    fn reset(&mut self) {
        self.stft.reset();
        self.gate.reset();
        for m in &mut self.stats {
            m.reset();
        }
    }

    fn latency(&self) -> u32 {
        self.stft.latency() as u32
    }
}

#[cfg(test)]
mod tests {
    use crate::fx::testutil::*;

    #[test]
    fn reduces_steady_hiss_and_keeps_tones() {
        let rate = 48000.0;
        let n = 4 * 48000;
        let hiss = noise(n, 0.02, 11);
        let tone = sine(800.0, rate, n, 0.3);
        // Tone gated on and off so the floor tracker sees hiss-only stretches.
        let x: Vec<f32> = (0..n).map(|i| hiss[i] + if (i / 24000) % 2 == 1 { tone[i] } else { 0.0 }).collect();
        let mut fx = make(131, rate, 1);
        fx.set_param(1, 30.0);
        let lat = fx.latency() as usize;
        let y = run_mono(fx.as_mut(), &x);
        // A hiss-only stretch after the tracker settled (frames 96000..120000 are tone-off).
        let a = 96000 + 4000;
        let b = 120000 - 2000;
        let red = rms(&y[a + lat..b + lat]) / rms(&hiss[a..b]);
        assert!(red < 0.25, "hiss reduced to {red}");
        // A tone-on stretch keeps the tone.
        let (a, b) = (120000 + 4000, 144000 - 2000);
        let dot: f32 = (a..b).map(|i| y[i + lat] * tone[i]).sum();
        let tt: f32 = (a..b).map(|i| tone[i] * tone[i]).sum();
        assert!((dot / tt - 1.0).abs() < 0.1, "tone gain {}", dot / tt);
    }

    #[test]
    fn captured_floor_gates_from_the_first_frame() {
        let rate = 48000.0;
        let n = 48000;
        let hiss = noise(n, 0.02, 5);
        // White noise of variance a^2/3 reads that power in every bin.
        let level = 10.0 * (0.02f32 * 0.02 / 3.0).log10();
        let mut fx = make(131, rate, 1);
        fx.set_param(1, 30.0);
        fx.set_data(0, &[0.0, level, 24000.0, level]);
        let lat = fx.latency() as usize;
        let y = run_mono(fx.as_mut(), &hiss);
        // Tracking needs about two seconds; a captured floor works at once.
        let red = rms(&y[lat + 4096..lat + 24000]) / rms(&hiss[4096..24000]);
        assert!(red < 0.2, "hiss reduced to {red}");
        // A floor far below the hiss leaves it alone.
        let mut fx = make(131, rate, 1);
        fx.set_param(1, 30.0);
        fx.set_data(0, &[0.0, level - 40.0, 24000.0, level - 40.0]);
        let y = run_mono(fx.as_mut(), &hiss);
        let kept = rms(&y[lat + 4096..lat + 24000]) / rms(&hiss[4096..24000]);
        assert!(kept > 0.8, "hiss kept {kept}");
        // An empty block goes back to tracking.
        fx.set_data(0, &[]);
    }

    #[test]
    fn floor_points_interpolate_in_log_frequency() {
        let pts = [(0.0, -60.0), (100.0, -80.0), (10000.0, -100.0)];
        assert_eq!(super::floor_at(&pts, 50.0), -70.0);
        assert!((super::floor_at(&pts, 1000.0) + 90.0).abs() < 1e-3);
        assert_eq!(super::floor_at(&pts, 20000.0), -100.0);
    }
}
