//! Sound Remover: supervised non-negative matrix factorization (NMF) of
//! magnitude spectrograms.
//!
//! Learning (Learn Sound Model) factors the magnitude spectrogram V of the
//! example sound into K basis spectra W (bins x K) and their activations H
//! (K x frames), V ~ W H, minimising the generalised Kullback-Leibler
//! divergence with multiplicative updates. Each basis is normalised to unit
//! sum, so a model is a set of spectral shapes.
//!
//! Removal factors the material with the learned bases held fixed plus
//! `k_free` free bases that are learned on the spot and absorb everything
//! else. The sound's share of each time-frequency cell, S^2 / (S^2 + O^2)
//! with S = W_sound H_sound (scaled by the sensitivity) and O = W_free H_free,
//! is a soft mask; the gain 1 - strength x mask (floored at the maximum
//! attenuation) multiplies every channel's STFT, which is resynthesised by
//! weighted overlap-add (Hann, 75 % overlap, perfect reconstruction when the
//! gain is 1). The factorization runs on the sum of the channels'
//! magnitudes, so all channels get the same mask and the stereo image holds.
//!
//! Enhanced suppression (0..1) hardens the mask, (aS)^p / ((aS)^p + O^p)
//! with p rising from 2 to 6, and raises the sensitivity up to three times:
//! cells the sound dominates are cleared more completely, while cells the
//! rest dominates are left more alone.
//!
//! "Enhance for speech" smooths the mask over neighbouring frames (fewer
//! isolated, warbling cells) and halves the attenuation in the 300 Hz to
//! 3.4 kHz band that carries speech intelligibility.

use crate::fft::{RealFft, Window};
use crate::fx::util::Rng;

const EPS: f32 = 1e-9;

/// STFT frame layout for `len` samples with FFT size `n` and hop n / 4:
/// frame t starts at t * hop - (n - hop), so every sample is covered by four
/// full windows and the edges reconstruct exactly.
struct Frames {
    n: usize,
    hop: usize,
    count: usize,
    window: Vec<f32>,
    norm: f32,
}

impl Frames {
    fn new(n: usize, len: usize) -> Frames {
        let hop = n / 4;
        let window = Window::Hann.build(n);
        let mut s = 0.0f32;
        let mut i = 0;
        while i < n {
            s += window[i] * window[i];
            i += hop;
        }
        let count = (len + n - hop).div_ceil(hop);
        Frames { n, hop, count, window, norm: 1.0 / s.max(1e-9) }
    }

    /// First sample of frame t (may be negative).
    fn start(&self, t: usize) -> isize {
        (t * self.hop) as isize - (self.n - self.hop) as isize
    }

    /// Windowed samples of frame t of `x` (zeros outside the signal).
    fn load(&self, x: &[f32], t: usize, out: &mut [f32]) {
        let s = self.start(t);
        for (k, o) in out.iter_mut().enumerate() {
            let i = s + k as isize;
            *o = if i >= 0 && (i as usize) < x.len() { x[i as usize] * self.window[k] } else { 0.0 };
        }
    }
}

/// Valid FFT size: a power of two in [256, 8192].
pub fn fft_size(n: u32) -> usize {
    (n.clamp(256, 8192) as usize).next_power_of_two().min(8192)
}

/// Magnitude spectrogram (frames x bins, frame-major) summed over channels.
fn spectrogram(chans: &[&[f32]], fr: &Frames, fft: &mut RealFft) -> Vec<f32> {
    let bins = fr.n / 2 + 1;
    let mut v = vec![0.0f32; fr.count * bins];
    let mut frame = vec![0.0f32; fr.n];
    let mut re = vec![0.0f32; bins];
    let mut im = vec![0.0f32; bins];
    for x in chans {
        for t in 0..fr.count {
            fr.load(x, t, &mut frame);
            fft.forward(&frame, &mut re, &mut im);
            let row = &mut v[t * bins..(t + 1) * bins];
            for f in 0..bins {
                row[f] += (re[f] * re[f] + im[f] * im[f]).sqrt();
            }
        }
    }
    v
}

/// Normalises basis k of `w` (k-major, `bins` long) to unit sum and returns the old sum.
fn normalise(w: &mut [f32], bins: usize, k: usize) -> f32 {
    let col = &mut w[k * bins..(k + 1) * bins];
    let s: f32 = col.iter().sum::<f32>().max(EPS);
    col.iter_mut().for_each(|x| *x /= s);
    s
}

/// KL-NMF of `v` (frames x bins). `w` holds `k` bases (k-major); bases below
/// `fixed` are not updated. Returns the activations (frames x k, frame-major).
fn factorize(v: &[f32], bins: usize, w: &mut [f32], k: usize, fixed: usize, iters: usize, seed: u32) -> Vec<f32> {
    let frames = v.len() / bins;
    let mut rng = Rng(seed.max(1));
    // Activations start near the frame's level, shared out with a little noise.
    let mut h = vec![0.0f32; frames * k];
    for t in 0..frames {
        let total: f32 = v[t * bins..(t + 1) * bins].iter().sum::<f32>() / k as f32;
        for j in 0..k {
            h[t * k + j] = total * (0.5 + rng.unit()) + EPS;
        }
    }
    let free = k - fixed;
    let mut wnum = vec![0.0f32; free * bins];
    let mut hsum = vec![0.0f32; free];
    let mut lam = vec![0.0f32; bins];
    let mut hn = vec![0.0f32; k];
    for _ in 0..iters {
        wnum.iter_mut().for_each(|x| *x = 0.0);
        hsum.iter_mut().for_each(|x| *x = 0.0);
        for t in 0..frames {
            let vt = &v[t * bins..(t + 1) * bins];
            let ht = &mut h[t * k..(t + 1) * k];
            lam.iter_mut().for_each(|x| *x = EPS);
            for j in 0..k {
                let a = ht[j];
                let col = &w[j * bins..(j + 1) * bins];
                for f in 0..bins {
                    lam[f] += col[f] * a;
                }
            }
            // R = V / (W H) in place of lam.
            for f in 0..bins {
                lam[f] = vt[f] / lam[f];
            }
            for j in 0..k {
                let col = &w[j * bins..(j + 1) * bins];
                let mut s = 0.0f32;
                for f in 0..bins {
                    s += col[f] * lam[f];
                }
                hn[j] = s;
            }
            // W numerators use the activations this pass started from.
            for j in 0..free {
                let a = ht[fixed + j];
                hsum[j] += a;
                let acc = &mut wnum[j * bins..(j + 1) * bins];
                for f in 0..bins {
                    acc[f] += lam[f] * a;
                }
            }
            // Bases have unit sum, so the H denominator is 1.
            for j in 0..k {
                ht[j] = (ht[j] * hn[j]).max(EPS);
            }
        }
        for j in 0..free {
            let col = &mut w[(fixed + j) * bins..(fixed + j + 1) * bins];
            let d = hsum[j].max(EPS);
            let acc = &wnum[j * bins..(j + 1) * bins];
            for f in 0..bins {
                col[f] = (col[f] * acc[f] / d).max(EPS);
            }
            let s = normalise(w, bins, fixed + j);
            for t in 0..frames {
                h[t * k + fixed + j] *= s;
            }
        }
    }
    h
}

/// Learns `k` bases from mono `x` with FFT size `n`; writes them (k-major,
/// n/2 + 1 values each) to `out` and returns the number of frames used.
pub fn learn(x: &[f32], n: usize, k: usize, iters: usize, out: &mut [f32]) -> usize {
    let n = fft_size(n as u32);
    let bins = n / 2 + 1;
    let k = k.max(1);
    let fr = Frames::new(n, x.len());
    let mut fft = RealFft::new(n);
    let v = spectrogram(&[x], &fr, &mut fft);
    let mut rng = Rng(0x5eed_1234);
    let mut w = vec![0.0f32; k * bins];
    for j in 0..k {
        for f in 0..bins {
            w[j * bins + f] = 0.1 + rng.unit();
        }
        normalise(&mut w, bins, j);
    }
    factorize(&v, bins, &mut w, k, 0, iters, 99);
    out[..k * bins].copy_from_slice(&w);
    fr.count
}

/// Sound Remover settings.
pub struct RemoveSettings {
    pub n: usize,
    /// Free bases for everything that is not the sound.
    pub k_free: usize,
    pub iters: usize,
    /// 0..1: how much of the sound's share is removed.
    pub strength: f32,
    /// Deepest attenuation, as a linear gain floor.
    pub floor: f32,
    /// Scales the sound's estimate before masking (>1 removes more).
    pub sensitivity: f32,
    pub speech: bool,
    pub rate: f32,
    /// 0..1: enhanced suppression (0 = off).
    pub enhance: f32,
}

/// Removes the sound described by `model` (k bases, k-major, n/2 + 1 each)
/// from planar `buf` (`channels` x `len`) in place. Non-finite samples (a
/// damaged float file) are taken as silence: in the spectrogram one would
/// turn the fitted mask, and with it thousands of output frames, into NaN.
pub fn remove(buf: &mut [f32], channels: usize, len: usize, model: &[f32], k: usize, s: &RemoveSettings) {
    let n = fft_size(s.n as u32);
    let bins = n / 2 + 1;
    if len == 0 || k == 0 || model.len() < k * bins {
        return;
    }
    for v in buf[..channels * len].iter_mut() {
        if !v.is_finite() {
            *v = 0.0;
        }
    }
    let fr = Frames::new(n, len);
    let mut fft = RealFft::new(n);
    let chans: Vec<&[f32]> = (0..channels).map(|c| &buf[c * len..(c + 1) * len]).collect();
    let v = spectrogram(&chans, &fr, &mut fft);
    let kt = k + s.k_free.max(1);
    let mut w = vec![0.0f32; kt * bins];
    w[..k * bins].copy_from_slice(&model[..k * bins]);
    for j in 0..k {
        normalise(&mut w, bins, j);
    }
    let mut rng = Rng(0x0dd_ba11);
    for j in k..kt {
        for f in 0..bins {
            w[j * bins + f] = 0.1 + rng.unit();
        }
        normalise(&mut w, bins, j);
    }
    let h = factorize(&v, bins, &mut w, kt, k, s.iters, 7);
    drop(v);

    // Soft mask -> gain per cell (frames x bins).
    let frames = fr.count;
    let mut gain = vec![1.0f32; frames * bins];
    let mut sv = vec![0.0f32; bins];
    let mut ov = vec![0.0f32; bins];
    let enh = s.enhance.clamp(0.0, 1.0);
    let alpha = s.sensitivity.max(0.0) * (1.0 + 2.0 * enh);
    let pw = 2.0 + 4.0 * enh;
    for t in 0..frames {
        sv.iter_mut().for_each(|x| *x = 0.0);
        ov.iter_mut().for_each(|x| *x = EPS);
        for j in 0..kt {
            let a = h[t * kt + j];
            let col = &w[j * bins..(j + 1) * bins];
            let dst = if j < k { &mut sv } else { &mut ov };
            for f in 0..bins {
                dst[f] += col[f] * a;
            }
        }
        let row = &mut gain[t * bins..(t + 1) * bins];
        for f in 0..bins {
            let a = alpha * sv[f];
            let m = if enh > 0.0 {
                // (a / o)^p as a ratio keeps the powers in range.
                let r = (a / ov[f]).powf(pw);
                r / (1.0 + r)
            } else {
                a * a / (a * a + ov[f] * ov[f])
            };
            row[f] = m; // the mask for now
        }
    }
    if s.speech {
        // Average each cell's mask with its neighbouring frames.
        let mut prev = vec![0.0f32; bins];
        for t in 0..frames {
            let next = if t + 1 < frames { t + 1 } else { t };
            for f in 0..bins {
                let cur = gain[t * bins + f];
                let p = if t > 0 { prev[f] } else { cur };
                prev[f] = cur;
                gain[t * bins + f] = 0.25 * p + 0.5 * cur + 0.25 * gain[next * bins + f];
            }
        }
    }
    let lo = (300.0 * n as f32 / s.rate) as usize;
    let hi = ((3400.0 * n as f32 / s.rate) as usize).min(bins - 1);
    for t in 0..frames {
        let row = &mut gain[t * bins..(t + 1) * bins];
        for (f, g) in row.iter_mut().enumerate() {
            let mut depth = s.strength * *g;
            if s.speech && f >= lo && f <= hi {
                depth *= 0.5;
            }
            *g = (1.0 - depth).max(s.floor);
        }
    }

    // Resynthesis, channel by channel.
    let mut frame = vec![0.0f32; n];
    let mut re = vec![0.0f32; bins];
    let mut im = vec![0.0f32; bins];
    let mut out = vec![0.0f32; len];
    for c in 0..channels {
        out.iter_mut().for_each(|x| *x = 0.0);
        {
            let x = &buf[c * len..(c + 1) * len];
            for t in 0..frames {
                fr.load(x, t, &mut frame);
                fft.forward(&frame, &mut re, &mut im);
                let g = &gain[t * bins..(t + 1) * bins];
                for f in 0..bins {
                    re[f] *= g[f];
                    im[f] *= g[f];
                }
                fft.inverse(&re, &im, &mut frame);
                let st = fr.start(t);
                for i in 0..n {
                    let at = st + i as isize;
                    if at >= 0 && (at as usize) < len {
                        out[at as usize] += frame[i] * fr.window[i] * fr.norm;
                    }
                }
            }
        }
        buf[c * len..(c + 1) * len].copy_from_slice(&out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fx::testutil::*;

    const RATE: f32 = 48000.0;

    /// A "beep" sound: harmonics of 1500 Hz that come and go.
    fn beeps(n: usize, amp: f32) -> Vec<f32> {
        let a = sine(1500.0, RATE, n, amp);
        let b = sine(4500.0, RATE, n, amp * 0.6);
        (0..n).map(|i| if (i / 4800) % 2 == 0 { a[i] + b[i] } else { 0.0 }).collect()
    }

    /// The material to keep: a low tone with its own harmonic.
    fn tone(n: usize) -> Vec<f32> {
        let a = sine(220.0, RATE, n, 0.3);
        let b = sine(660.0, RATE, n, 0.1);
        (0..n).map(|i| a[i] + b[i]).collect()
    }

    fn settings() -> RemoveSettings {
        RemoveSettings { n: 2048, k_free: 8, iters: 40, strength: 1.0, floor: 0.001, sensitivity: 1.0, speech: false, rate: RATE, enhance: 0.0 }
    }

    #[test]
    fn unit_gain_reconstructs_exactly() {
        let x = tone(10000);
        let mut y = x.clone();
        // An all-zero model (no sound share) leaves the audio as it was.
        let model = vec![0.0f32; 1025];
        let s = RemoveSettings { strength: 0.0, ..settings() };
        remove(&mut y, 1, x.len(), &model, 1, &s);
        for i in 0..x.len() {
            assert!((y[i] - x[i]).abs() < 1e-4, "{i}: {} vs {}", y[i], x[i]);
        }
    }

    #[test]
    fn learns_normalised_bases() {
        let x = beeps(48000, 0.4);
        let mut w = vec![0.0f32; 4 * 1025];
        let frames = learn(&x, 2048, 4, 60, &mut w);
        assert!(frames > 90);
        for j in 0..4 {
            let s: f32 = w[j * 1025..(j + 1) * 1025].iter().sum();
            assert!((s - 1.0).abs() < 1e-3);
        }
        // The energy sits at the beep's partials (bins 64 and 192 at 2048 / 48 kHz).
        let total: f32 = (0..4).map(|j| w[j * 1025 + 64] + w[j * 1025 + 192]).sum();
        assert!(total > 0.5, "{total}");
    }

    #[test]
    fn removes_the_learned_sound_and_keeps_the_rest() {
        let n = 96000;
        let sound = beeps(n, 0.3);
        let keep = tone(n);
        let mut mix: Vec<f32> = (0..n).map(|i| sound[i] + keep[i]).collect();
        let mut model = vec![0.0f32; 6 * 1025];
        learn(&beeps(48000, 0.4), 2048, 6, 80, &mut model);
        remove(&mut mix, 1, n, &model, 6, &settings());
        let mid = 4800..n - 4800;
        let err: f32 = mid.clone().map(|i| (mix[i] - keep[i]).powi(2)).sum();
        let before: f32 = mid.clone().map(|i| sound[i].powi(2)).sum();
        let kept: f32 = mid.clone().map(|i| keep[i].powi(2)).sum();
        // Most of the beeps are gone and the tone survives.
        assert!(err < before * 0.01, "residual {err} vs {before}");
        assert!(err < kept * 0.01, "residual {err} vs kept {kept}");
    }

    #[test]
    fn non_finite_input_samples_do_not_spread() {
        let n = 48000;
        let sound = beeps(n, 0.3);
        let keep = tone(n);
        let mut mix: Vec<f32> = (0..n).map(|i| sound[i] + keep[i]).collect();
        mix[10000] = f32::NAN;
        mix[30000] = f32::INFINITY;
        let mut model = vec![0.0f32; 4 * 1025];
        learn(&beeps(24000, 0.4), 2048, 4, 60, &mut model);
        remove(&mut mix, 1, n, &model, 4, &settings());
        assert!(mix.iter().all(|v| v.is_finite()));
        assert!(rms(&mix[4800..n - 4800]) > 0.15);
    }

    #[test]
    fn stereo_channels_share_the_mask_and_speech_mode_runs() {
        let n = 48000;
        let sound = beeps(n, 0.3);
        let keep = tone(n);
        let l: Vec<f32> = (0..n).map(|i| sound[i] + keep[i]).collect();
        let r: Vec<f32> = (0..n).map(|i| sound[i] + 0.5 * keep[i]).collect();
        let mut buf = [l, r].concat();
        let mut model = vec![0.0f32; 4 * 1025];
        learn(&beeps(24000, 0.4), 2048, 4, 60, &mut model);
        let s = RemoveSettings { speech: true, ..settings() };
        remove(&mut buf, 2, n, &model, 4, &s);
        assert!(buf.iter().all(|v| v.is_finite()));
        let rs = rms(&buf[n + 4800..2 * n - 4800]);
        // Right keeps its (quieter) tone: about 0.5 x 0.316 / sqrt 2.
        assert!((rs - 0.112).abs() < 0.03, "{rs}");
    }

    #[test]
    fn enhanced_suppression_removes_more_of_a_faint_sound_estimate() {
        let n = 96000;
        let sound = beeps(n, 0.3);
        let keep = tone(n);
        let mix: Vec<f32> = (0..n).map(|i| sound[i] + keep[i]).collect();
        let mut model = vec![0.0f32; 6 * 1025];
        learn(&beeps(48000, 0.4), 2048, 6, 80, &mut model);
        let residual = |enhance: f32| {
            let mut y = mix.clone();
            // A low sensitivity leaves part of the sound behind.
            remove(&mut y, 1, n, &model, 6, &RemoveSettings { sensitivity: 0.3, enhance, ..settings() });
            (4800..n - 4800).map(|i| (y[i] - keep[i]).powi(2)).sum::<f32>()
        };
        let (plain, enhanced) = (residual(0.0), residual(1.0));
        assert!(enhanced < plain * 0.85, "plain {plain} enhanced {enhanced}");
    }
}
