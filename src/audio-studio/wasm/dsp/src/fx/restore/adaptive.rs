//! Adaptive Noise Reduction: tracks the noise floor continuously (minimum
//! statistics) and gates each bin against it, dilating the kept bins by the
//! broadband preservation width so audio around detected signal survives.
//!
//! Params: 0 reduce noise by dB, 1 noisiness % (how much of the audio is
//! assumed to be noise; scales the floor estimate), 2 noise floor dB (fine
//! offset of the floor), 3 signal threshold dB (above the floor), 4 spectral
//! decay rate (ms per 60 dB), 5 broadband preservation Hz, 6 FFT size,
//! 7 high quality (1: twice the frame overlap, with signal power and gains
//! smoothed over more frames and bins, for less "musical" residual noise at
//! about twice the processing cost).

use super::noise_reduction::fft_size;
use super::spectral::{fall_per_frame, power, power_scale, GateCore, GateSettings, MinStats};
use crate::fx::util::{db_to_gain, Stft};
use crate::fx::Effect;

pub struct AdaptiveNoiseReduction {
    rate: f32,
    channels: usize,
    reduce_db: f32,
    noisiness: f32,
    floor_db: f32,
    threshold: f32,
    decay_ms: f32,
    broadband: f32,
    fft: usize,
    high_quality: bool,
    stft: Stft,
    gate: GateCore,
    stats: Vec<MinStats>,
    noise: Vec<f32>,
    p: Vec<f32>,
}

impl AdaptiveNoiseReduction {
    pub fn new(rate: f32, channels: usize) -> AdaptiveNoiseReduction {
        let mut a = AdaptiveNoiseReduction {
            rate,
            channels,
            reduce_db: 12.0,
            noisiness: 20.0,
            floor_db: 0.0,
            threshold: 3.0,
            decay_ms: 150.0,
            broadband: 100.0,
            fft: 1024,
            high_quality: false,
            stft: Stft::new(256, 4, 1),
            gate: GateCore::new(1, 1),
            stats: Vec::new(),
            noise: Vec::new(),
            p: Vec::new(),
        };
        a.rebuild();
        a
    }

    fn rebuild(&mut self) {
        let bins = self.fft / 2 + 1;
        let overlap = if self.high_quality { 8 } else { 4 };
        self.stft = Stft::new(self.fft, overlap, self.channels);
        self.gate = GateCore::new(bins, self.channels);
        let hop = self.fft / overlap;
        let window = (1.0 * self.rate / hop as f32).max(16.0) as usize;
        self.stats = (0..self.channels).map(|_| MinStats::new(bins, window).warmup(4)).collect();
        self.noise = vec![0.0; bins];
        self.p = vec![0.0; bins];
    }
}

impl Effect for AdaptiveNoiseReduction {
    fn set_param(&mut self, idx: u32, v: f32) {
        match idx {
            0 => self.reduce_db = v.clamp(0.0, 80.0),
            1 => self.noisiness = v.clamp(0.0, 100.0),
            2 => self.floor_db = v.clamp(-40.0, 40.0),
            3 => self.threshold = v.clamp(-20.0, 40.0),
            4 => self.decay_ms = v.clamp(0.0, 10000.0),
            5 => self.broadband = v.clamp(0.0, 2000.0),
            6 => {
                let n = fft_size(v).min(8192);
                if n != self.fft {
                    self.fft = n;
                    self.rebuild();
                }
            }
            7 => {
                let hq = v >= 0.5;
                if hq != self.high_quality {
                    self.high_quality = hq;
                    self.rebuild();
                }
            }
            _ => {}
        }
    }

    fn process(&mut self, buf: &mut [f32], _channels: usize, frames: usize) {
        let hq = self.high_quality;
        let hop = self.stft.hop;
        let bin_hz = self.rate / self.fft as f32;
        let s = GateSettings {
            threshold_db: self.threshold,
            width_db: 6.0,
            floor_db: -self.reduce_db,
            // Twice the frames per second: a slower per-frame smoothing for a longer memory.
            power_alpha: if hq { 0.8 } else { 0.5 },
            instant_rise: true,
            smooth_bins: if hq { 2 } else { 1 },
            dilate_bins: (self.broadband / bin_hz).round() as usize,
            snr_bins: 0,
            fall: fall_per_frame(self.decay_ms, hop, self.rate),
            residual: false,
        };
        // More noisiness: the floor estimate is raised (more is treated as noise).
        let k = (1.0 + self.noisiness * 0.04) * db_to_gain(self.floor_db).powi(2);
        let scale = power_scale(self.fft);
        let (gate, stats, noise, p) = (&mut self.gate, &mut self.stats, &mut self.noise, &mut self.p);
        self.stft.process(buf, frames, |re, im| {
            for c in 0..re.len() {
                power(&re[c], &im[c], p, scale);
                stats[c].update(p);
                for b in 0..noise.len() {
                    noise[b] = stats[c].noise[b] * k;
                }
                gate.frame(c, &mut re[c], &mut im[c], noise, scale, &s, |_| 1.0);
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
    fn high_quality_mode_reduces_noise_and_keeps_the_tone() {
        let rate = 48000.0;
        let n = 3 * 48000;
        let hiss = noise(n, 0.03, 8);
        let tone = sine(1500.0, rate, n, 0.25);
        let x: Vec<f32> = (0..n).map(|i| hiss[i] + if (i / 24000) % 2 == 1 { tone[i] } else { 0.0 }).collect();
        let mut fx = make(134, rate, 1);
        fx.set_param(0, 20.0);
        fx.set_param(7, 1.0);
        let lat = fx.latency() as usize;
        assert_eq!(lat, 1024);
        let y = run_mono(fx.as_mut(), &x);
        let (a, b) = (96000 + 3000, 120000 - 3000);
        let red = rms(&y[a + lat..b + lat]) / rms(&hiss[a..b]);
        assert!(red < 0.35, "noise reduced to {red}");
        let (a, b) = (72000 + 3000, 96000 - 3000);
        let dot: f32 = (a..b).map(|i| y[i + lat] * tone[i]).sum();
        let tt: f32 = (a..b).map(|i| tone[i] * tone[i]).sum();
        assert!((dot / tt - 1.0).abs() < 0.12, "tone gain {}", dot / tt);
    }

    #[test]
    fn follows_the_floor_and_gates_noise() {
        let rate = 48000.0;
        let n = 3 * 48000;
        let hiss = noise(n, 0.03, 8);
        let tone = sine(1500.0, rate, n, 0.25);
        let x: Vec<f32> = (0..n).map(|i| hiss[i] + if (i / 24000) % 2 == 1 { tone[i] } else { 0.0 }).collect();
        let mut fx = make(134, rate, 1);
        fx.set_param(0, 20.0);
        let lat = fx.latency() as usize;
        let y = run_mono(fx.as_mut(), &x);
        let (a, b) = (96000 + 3000, 120000 - 3000);
        let red = rms(&y[a + lat..b + lat]) / rms(&hiss[a..b]);
        assert!(red < 0.35, "noise reduced to {red}");
        let (a, b) = (72000 + 3000, 96000 - 3000);
        let dot: f32 = (a..b).map(|i| y[i + lat] * tone[i]).sum();
        let tt: f32 = (a..b).map(|i| tone[i] * tone[i]).sum();
        assert!((dot / tt - 1.0).abs() < 0.12, "tone gain {}", dot / tt);
    }
}
