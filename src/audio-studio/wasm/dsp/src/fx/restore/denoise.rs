//! DeNoise: one-knob broadband noise reduction. Minimum-statistics noise
//! tracking feeds a decision-directed Wiener gain (Ephraim-Malah style a
//! priori SNR), which keeps residual noise smooth instead of "musical".
//!
//! Params: 0 amount % (sets the deepest reduction, 100% = 40 dB),
//! 1 processing focus (0 all, 1 low, 2 mid, 3 high, 4 low and high), 2 output gain dB,
//! 3 output noise only (0/1: what the reduction removes, to audition it).

use super::spectral::{fmax, bin_hz, focus_weight, power, power_scale, MinStats};
use crate::fx::util::{db_to_gain, Stft};
use crate::fx::{Effect, Smooth};

pub const FFT: usize = 2048;

pub struct DeNoise {
    rate: f32,
    amount: f32,
    focus: u32,
    gain: Smooth,
    stft: Stft,
    stats: Vec<MinStats>,
    prev_clean: Vec<Vec<f32>>,
    p: Vec<f32>,
    gmin: Vec<f32>,
    noise_only: bool,
}

impl DeNoise {
    pub fn new(rate: f32, channels: usize) -> DeNoise {
        let bins = FFT / 2 + 1;
        let hop = FFT / 4;
        let window = (1.5 * rate / hop as f32) as usize;
        let mut d = DeNoise {
            rate,
            amount: 40.0,
            focus: 0,
            gain: Smooth::new(1.0, rate, 20.0),
            stft: Stft::new(FFT, 4, channels),
            stats: (0..channels).map(|_| MinStats::new(bins, window).warmup(4)).collect(),
            prev_clean: vec![vec![0.0; bins]; channels],
            p: vec![0.0; bins],
            gmin: vec![1.0; bins],
            noise_only: false,
        };
        d.update_floor();
        d
    }

    fn update_floor(&mut self) {
        for k in 0..self.gmin.len() {
            let w = focus_weight(self.focus, bin_hz(k, FFT, self.rate));
            self.gmin[k] = db_to_gain(-0.4 * self.amount * w);
        }
    }
}

impl Effect for DeNoise {
    fn set_param(&mut self, idx: u32, v: f32) {
        match idx {
            0 => self.amount = v.clamp(0.0, 100.0),
            1 => self.focus = v.round().clamp(0.0, 4.0) as u32,
            2 => self.gain.target = db_to_gain(v.clamp(-40.0, 40.0)),
            3 => {
                self.noise_only = v >= 0.5;
                return;
            }
            _ => return,
        }
        self.update_floor();
    }

    fn process(&mut self, buf: &mut [f32], channels: usize, frames: usize) {
        let scale = power_scale(FFT);
        let (stats, prev, p, gmin) = (&mut self.stats, &mut self.prev_clean, &mut self.p, &self.gmin);
        let off = self.amount <= 0.0;
        let noise_only = self.noise_only;
        self.stft.process(buf, frames, |re, im| {
            for c in 0..re.len() {
                power(&re[c], &im[c], p, scale);
                stats[c].update(p);
                if off {
                    if noise_only {
                        re[c].iter_mut().chain(im[c].iter_mut()).for_each(|v| *v = 0.0);
                    }
                    continue;
                }
                let noise = &stats[c].noise;
                for k in 0..p.len() {
                    let n = fmax(noise[k], 1e-20);
                    let gamma = p[k] / n;
                    let xi = fmax(0.98 * prev[c][k] / n + 0.02 * fmax(gamma - 1.0, 0.0), 1e-3);
                    let g = fmax(xi / (1.0 + xi), gmin[k]);
                    prev[c][k] = g * g * p[k];
                    let m = if noise_only { 1.0 - g } else { g };
                    re[c][k] *= m;
                    im[c][k] *= m;
                }
            }
        });
        let start = self.gain.value;
        for c in 0..channels.min(buf.len() / frames.max(1)) {
            self.gain.value = start;
            for x in &mut buf[c * frames..(c + 1) * frames] {
                *x *= self.gain.next();
            }
        }
    }

    fn reset(&mut self) {
        self.stft.reset();
        for m in &mut self.stats {
            m.reset();
        }
        for p in &mut self.prev_clean {
            p.iter_mut().for_each(|v| *v = 0.0);
        }
        self.gain.settle();
    }

    fn latency(&self) -> u32 {
        self.stft.latency() as u32
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn noise_only_is_what_the_reduction_removes() {
        use crate::fx::testutil::*;
        let rate = 48000.0;
        let x = noise(24000, 0.2, 9);
        let run = |only: f32| {
            let mut fx = make(132, rate, 1);
            fx.set_param(0, 80.0);
            fx.set_param(3, only);
            fx.reset();
            run_mono(fx.as_mut(), &x)
        };
        let (kept, removed) = (run(0.0), run(1.0));
        let lat = 2048;
        for i in 12000..24000 {
            assert!((kept[i] + removed[i] - x[i - lat]).abs() < 1e-3, "at {i}");
        }
    }

    use crate::fx::testutil::*;

    #[test]
    fn reduces_noise_and_keeps_signal() {
        let rate = 48000.0;
        let n = 3 * 48000;
        let hiss = noise(n, 0.03, 4);
        let tone = sine(500.0, rate, n, 0.3);
        let x: Vec<f32> = (0..n).map(|i| hiss[i] + if (i / 24000) % 2 == 1 { tone[i] } else { 0.0 }).collect();
        let mut fx = make(132, rate, 1);
        fx.set_param(0, 80.0);
        let lat = fx.latency() as usize;
        let y = run_mono(fx.as_mut(), &x);
        let (a, b) = (96000 + 3000, 120000 - 3000);
        let red = rms(&y[a + lat..b + lat]) / rms(&hiss[a..b]);
        assert!(red < 0.3, "noise reduced to {red}");
        let (a, b) = (72000 + 3000, 96000 - 3000);
        let dot: f32 = (a..b).map(|i| y[i + lat] * tone[i]).sum();
        let tt: f32 = (a..b).map(|i| tone[i] * tone[i]).sum();
        assert!((dot / tt - 1.0).abs() < 0.1, "tone gain {}", dot / tt);
        // Amount 0 is transparent.
        let mut fx = make(132, rate, 1);
        fx.set_param(0, 0.0);
        let y = run_mono(fx.as_mut(), &x[..20000]);
        for i in 5000..20000 {
            assert!((y[i] - x[i - lat]).abs() < 1e-3);
        }
    }
}
