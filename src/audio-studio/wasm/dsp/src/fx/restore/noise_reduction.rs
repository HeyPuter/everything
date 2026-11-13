//! Noise Reduction (process): spectral gating against a captured noise print.
//!
//! Params: 0 noise reduction % (how much of the reduction to apply),
//! 1 reduce by dB (maximum attenuation), 2 spectral decay rate % (how slowly
//! the gain falls when audio drops into the noise), 3 smoothing (gain
//! smoothing across bins), 4 precision factor (1..20: time resolution of the
//! signal estimate; 10 and above uses 8x overlap), 5 transition width dB,
//! 6 FFT size, 7 output noise only (0/1).
//!
//! Data slot 0 (the noise print): [fftSize, channels, rate, bins,
//! channel 0 bins..., channel 1 bins...] with per-bin noise power normalised
//! like `spectral::power` (white noise of RMS s reads s^2). The print is
//! re-sampled to the current FFT size, so any capture size works. Without a
//! print the effect passes audio through (delayed by its latency).

use super::spectral::{fall_per_frame, power_scale, resample_profile, GateCore, GateSettings};
use crate::fx::util::Stft;
use crate::fx::Effect;

pub struct NoiseReduction {
    rate: f32,
    channels: usize,
    amount: f32,
    reduce_db: f32,
    decay: f32,
    smoothing: f32,
    precision: f32,
    width: f32,
    fft: usize,
    residual: bool,
    stft: Stft,
    gate: GateCore,
    print: Vec<f32>,
    noise: Vec<Vec<f32>>,
    has_print: bool,
}

pub fn fft_size(v: f32) -> usize {
    (v.round().max(256.0) as usize).next_power_of_two().clamp(256, 16384)
}

impl NoiseReduction {
    pub fn new(rate: f32, channels: usize) -> NoiseReduction {
        let fft = 4096;
        let mut nr = NoiseReduction {
            rate,
            channels,
            amount: 60.0,
            reduce_db: 20.0,
            decay: 65.0,
            smoothing: 1.0,
            precision: 7.0,
            width: 8.0,
            fft,
            residual: false,
            stft: Stft::new(fft, 8, channels),
            gate: GateCore::new(fft / 2 + 1, channels),
            print: Vec::new(),
            noise: vec![vec![0.0; fft / 2 + 1]; channels],
            has_print: false,
        };
        nr.rebuild();
        nr
    }

    fn overlap(&self) -> usize {
        if self.precision >= 10.0 {
            8
        } else {
            4
        }
    }

    /// Reallocates the STFT for the FFT size and precision (outside `process`).
    fn rebuild(&mut self) {
        let bins = self.fft / 2 + 1;
        if self.stft.n != self.fft || self.stft.n / self.stft.hop != self.overlap() {
            self.stft = Stft::new(self.fft, self.overlap(), self.channels);
            self.gate = GateCore::new(bins, self.channels);
        }
        self.noise = vec![vec![0.0; bins]; self.channels];
        self.has_print = false;
        if self.print.len() >= 4 {
            let (pn, pch, prate, pbins) = (self.print[0] as usize, self.print[1] as usize, self.print[2], self.print[3] as usize);
            if pch >= 1 && pn >= 4 && self.print.len() >= 4 + pch * pbins {
                for c in 0..self.channels {
                    let src = c.min(pch - 1);
                    let p = &self.print[4 + src * pbins..4 + (src + 1) * pbins];
                    resample_profile(p, pn, prate, &mut self.noise[c], self.fft, self.rate);
                }
                // A stereo print on a mono signal: use the mean of both channels.
                if self.channels == 1 && pch >= 2 {
                    let mut other = vec![0.0; bins];
                    resample_profile(&self.print[4 + pbins..4 + 2 * pbins], pn, prate, &mut other, self.fft, self.rate);
                    for k in 0..bins {
                        self.noise[0][k] = 0.5 * (self.noise[0][k] + other[k]);
                    }
                }
                self.has_print = true;
            }
        }
    }

    fn settings(&self) -> GateSettings {
        let hop = self.fft / self.overlap();
        GateSettings {
            threshold_db: 3.0,
            width_db: self.width,
            floor_db: -self.reduce_db,
            power_alpha: 1.0 - 1.0 / (1.0 + self.precision * 0.15),
            instant_rise: false,
            smooth_bins: self.smoothing.round() as usize,
            dilate_bins: 0,
            fall: fall_per_frame(self.decay * 6.0, hop, self.rate),
            residual: self.residual,
        }
    }
}

impl Effect for NoiseReduction {
    fn set_param(&mut self, idx: u32, v: f32) {
        match idx {
            0 => self.amount = v.clamp(0.0, 100.0),
            1 => self.reduce_db = v.clamp(0.0, 100.0),
            2 => self.decay = v.clamp(0.0, 100.0),
            3 => self.smoothing = v.clamp(0.0, 32.0),
            4 => {
                self.precision = v.clamp(1.0, 20.0);
                self.rebuild();
            }
            5 => self.width = v.clamp(0.0, 40.0),
            6 => {
                let n = fft_size(v);
                if n != self.fft {
                    self.fft = n;
                    self.rebuild();
                }
            }
            7 => self.residual = v >= 0.5,
            _ => {}
        }
    }

    fn set_data(&mut self, slot: u32, data: &[f32]) {
        if slot == 0 {
            self.print = data.to_vec();
            self.rebuild();
        }
    }

    fn process(&mut self, buf: &mut [f32], _channels: usize, frames: usize) {
        let active = self.has_print;
        let s = self.settings();
        let amount = self.amount * 0.01;
        let scale = power_scale(self.fft);
        let gate = &mut self.gate;
        let noise = &self.noise;
        self.stft.process(buf, frames, |re, im| {
            if !active {
                return;
            }
            for c in 0..re.len() {
                gate.frame(c, &mut re[c], &mut im[c], &noise[c], scale, &s, |_| amount);
            }
        });
    }

    fn reset(&mut self) {
        self.stft.reset();
        self.gate.reset();
    }

    fn latency(&self) -> u32 {
        self.stft.latency() as u32
    }
}

/// Mean noise power per bin of `x` at FFT size `n` (hop n/4, Hann), with
/// the `spectral::power` normalisation; adds into `acc` and returns the
/// number of frames added, so long selections can be captured in chunks.
/// A non-finite sample (a damaged float file) counts as silence: one NaN
/// would otherwise make every bin of the print NaN.
pub fn accumulate_profile(x: &[f32], n: usize, acc: &mut [f32]) -> usize {
    use crate::fft::{RealFft, Window};
    if x.len() < n {
        return 0;
    }
    let mut fft = RealFft::new(n);
    let w = Window::Hann.build(n);
    let mut frame = vec![0.0f32; n];
    let mut re = vec![0.0f32; n / 2 + 1];
    let mut im = vec![0.0f32; n / 2 + 1];
    let scale = power_scale(n);
    let hop = n / 4;
    let mut count = 0;
    let mut at = 0;
    while at + n <= x.len() {
        for i in 0..n {
            let v = x[at + i];
            frame[i] = if v.is_finite() { v * w[i] } else { 0.0 };
        }
        fft.forward(&frame, &mut re, &mut im);
        for k in 0..=n / 2 {
            acc[k] += (re[k] * re[k] + im[k] * im[k]) * scale;
        }
        count += 1;
        at += hop;
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fx::testutil::*;

    fn print_for(noise: &[f32], n: usize, rate: f32) -> Vec<f32> {
        let mut acc = vec![0.0; n / 2 + 1];
        let frames = accumulate_profile(noise, n, &mut acc);
        let mut d = vec![n as f32, 1.0, rate, (n / 2 + 1) as f32];
        d.extend(acc.iter().map(|v| v / frames as f32));
        d
    }

    #[test]
    fn profile_reads_white_noise_power() {
        let x = noise(48000, 0.1, 9);
        let mut acc = vec![0.0; 1025];
        let f = accumulate_profile(&x, 2048, &mut acc);
        let mean: f32 = acc[10..1000].iter().sum::<f32>() / 990.0 / f as f32;
        let var = rms(&x).powi(2);
        assert!((mean / var - 1.0).abs() < 0.15, "{mean} vs {var}");
    }

    #[test]
    fn profile_treats_non_finite_samples_as_silence() {
        let x = noise(48000, 0.1, 9);
        let mut clean = vec![0.0; 1025];
        let f = accumulate_profile(&x, 2048, &mut clean);
        let mut bad = x.clone();
        bad[1000] = f32::NAN;
        bad[30000] = f32::INFINITY;
        let mut acc = vec![0.0; 1025];
        assert_eq!(accumulate_profile(&bad, 2048, &mut acc), f);
        for k in 0..acc.len() {
            assert!(acc[k].is_finite(), "bin {k}");
            assert!((acc[k] / clean[k] - 1.0).abs() < 0.05, "bin {k}: {} vs {}", acc[k], clean[k]);
        }
    }

    #[test]
    fn removes_captured_noise_and_keeps_tone() {
        let rate = 48000.0;
        let n = 96000;
        let hiss = noise(n, 0.05, 21);
        let tone = sine(1000.0, rate, n, 0.3);
        let mut fx = make(135, rate, 1);
        fx.set_data(0, &print_for(&noise(48000, 0.05, 99), 4096, rate));
        fx.set_param(1, 30.0);
        fx.set_param(0, 100.0);
        let lat = fx.latency() as usize;
        // First half: noise alone; second half: noise plus tone.
        let x: Vec<f32> = (0..n).map(|i| hiss[i] + if i >= n / 2 { tone[i] } else { 0.0 }).collect();
        let y = run_mono(fx.as_mut(), &x);
        let quiet = rms(&y[lat + 20000..lat + 44000]) / rms(&hiss[20000..44000]);
        assert!(quiet < 0.1, "noise only reduced to {quiet}");
        // The tone survives (compare 1 kHz content through correlation with the clean tone).
        let a = n / 2 + 20000;
        let b = n - 1000 - lat;
        let dot: f32 = (a..b).map(|i| y[i + lat] * tone[i]).sum();
        let tt: f32 = (a..b).map(|i| tone[i] * tone[i]).sum();
        let g = dot / tt;
        assert!(g > 0.9 && g < 1.1, "tone gain {g}");
    }

    #[test]
    fn passes_through_without_a_print_and_outputs_noise_only() {
        let rate = 48000.0;
        let mut fx = make(135, rate, 1);
        let lat = fx.latency() as usize;
        let x = noise(30000, 0.2, 5);
        let y = run_mono(fx.as_mut(), &x);
        for i in lat + 8192..30000 {
            assert!((y[i] - x[i - lat]).abs() < 1e-3);
        }
        let mut fx = make(135, rate, 1);
        fx.set_data(0, &print_for(&noise(48000, 0.05, 99), 2048, rate));
        fx.set_param(0, 100.0);
        fx.set_param(1, 40.0);
        fx.set_param(7, 1.0);
        let hiss = noise(48000, 0.05, 3);
        let y = run_mono(fx.as_mut(), &hiss);
        let r = rms(&y[lat + 10000..]) / rms(&hiss[10000..48000 - lat]);
        assert!(r > 0.8, "noise-only output keeps the noise: {r}");
    }
}
