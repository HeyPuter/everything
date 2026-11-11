//! Spectral helpers shared by the restoration processors: power
//! normalisation, minimum-statistics noise tracking, frequency smoothing,
//! spectral dilation and a gate core that turns a noise estimate into smooth
//! per-bin gains.

/// Scale that turns |X|^2 of a Hann-windowed frame of size `n` into a power
/// density: white noise of RMS s reads s^2 in every bin, independent of `n`.
#[inline]
pub fn power_scale(n: usize) -> f32 {
    1.0 / (0.375 * n as f32)
}

/// Branchy max/min: `f32::max` compiles to a libm call in WebAssembly
/// (NaN handling), which shows up in per-bin loops.
#[inline(always)]
pub fn fmax(a: f32, b: f32) -> f32 {
    if a > b {
        a
    } else {
        b
    }
}

#[inline(always)]
pub fn fmin(a: f32, b: f32) -> f32 {
    if a < b {
        a
    } else {
        b
    }
}

/// Fast log2 (absolute error under 1e-4) for per-bin gain math, where
/// libm's log and pow dominate the cost in WebAssembly.
#[inline]
pub fn fast_log2(x: f32) -> f32 {
    let bits = fmax(x, 1e-37).to_bits();
    let e = ((bits >> 23) & 0xff) as i32 - 127;
    let m = f32::from_bits((bits & 0x007f_ffff) | 0x3f80_0000);
    let p = ((((0.043_434_335 * m - 0.404_915_68) * m + 1.594_069) * m - 3.492_775_8) * m + 5.047_106_5) * m - 2.786_886_6;
    e as f32 + p
}

/// Fast 2^x (relative error under 1e-4).
#[inline]
pub fn fast_exp2(x: f32) -> f32 {
    let x = fmin(fmax(x, -126.0), 126.0);
    let xi = x.floor();
    let f = x - xi;
    let p = 1.0 + f * (0.693_147_2 + f * (0.240_226_5 + f * (0.055_504_1 + f * (0.009_618_1 + f * 0.001_333_4))));
    p * f32::from_bits(((xi as i32 + 127) as u32) << 23)
}

/// Fast 10^(db / 20).
#[inline]
pub fn fast_db_to_gain(db: f32) -> f32 {
    fast_exp2(db * 0.166_096_4)
}

/// Fast 10 log10(x).
#[inline]
pub fn fast_power_db(x: f32) -> f32 {
    fast_log2(x) * 3.010_3
}

/// Normalised power of every bin.
#[inline]
pub fn power(re: &[f32], im: &[f32], out: &mut [f32], scale: f32) {
    for k in 0..out.len() {
        out[k] = (re[k] * re[k] + im[k] * im[k]) * scale;
    }
}

/// Frequency of bin `k` for an FFT of size `n`.
#[inline]
pub fn bin_hz(k: usize, n: usize, rate: f32) -> f32 {
    k as f32 * rate / n as f32
}

/// Per-bin weight for a "processing focus" choice:
/// 0 all frequencies, 1 low, 2 mid, 3 high, 4 low and high.
pub fn focus_weight(mode: u32, f: f32) -> f32 {
    let lf = (f.max(10.0) / 1000.0).log2(); // octaves from 1 kHz
    match mode {
        1 => (0.5 - 0.5 * (lf + 0.5)).clamp(0.15, 1.0),
        2 => (1.0 - 0.3 * (lf - 0.6).abs()).clamp(0.15, 1.0),
        3 => (0.6 + 0.4 * (lf - 0.5)).clamp(0.15, 1.0),
        // Low and high: strongest at both ends, lightest around 1.5 kHz.
        4 => (0.3 + 0.35 * (lf - 0.6).abs()).clamp(0.15, 1.0),
        _ => 1.0,
    }
}

/// Noise tracker after Cohen's minima-controlled recursive averaging: the
/// minimum of the smoothed power over a sliding window (Martin's minimum
/// statistics, `u` sub-windows) decides, per bin, whether signal is present;
/// where it is not, the raw power is averaged into an unbiased noise mean.
pub struct MinStats {
    bins: usize,
    pub alpha: f32,
    /// Smoothing of the noise mean while no signal is present.
    pub alpha_d: f32,
    /// Smoothed power above `delta` times the minimum counts as signal.
    pub delta: f32,
    smooth: Vec<f32>,
    cur: Vec<f32>,
    mins: Vec<f32>,
    win: Vec<f32>,
    u: usize,
    v: usize,
    count: usize,
    slot: usize,
    init: bool,
    warm: usize,
    skip: usize,
    pub noise: Vec<f32>,
}

impl MinStats {
    /// Ignores the first `frames` frames after a reset (the STFT is still
    /// filling, so those frames read too low) and any silent lead-in.
    pub fn warmup(mut self, frames: usize) -> MinStats {
        self.warm = frames;
        self.skip = frames;
        self
    }

    /// `window_frames` frames of history split into 8 sub-windows.
    pub fn new(bins: usize, window_frames: usize) -> MinStats {
        let u = 8;
        MinStats {
            bins,
            alpha: 0.8,
            alpha_d: 0.95,
            delta: 6.0,
            smooth: vec![0.0; bins],
            cur: vec![0.0; bins],
            mins: vec![0.0; u * bins],
            win: vec![0.0; bins],
            u,
            v: (window_frames / u).max(1),
            count: 0,
            slot: 0,
            init: false,
            warm: 0,
            skip: 0,
            noise: vec![0.0; bins],
        }
    }

    pub fn reset(&mut self) {
        self.init = false;
        self.count = 0;
        self.slot = 0;
        self.skip = self.warm;
    }

    pub fn update(&mut self, p: &[f32]) {
        let b = self.bins;
        if self.skip > 0 {
            self.skip -= 1;
            return;
        }
        if !self.init && p[..b].iter().all(|&v| v <= 1e-24) {
            return;
        }
        if !self.init {
            self.init = true;
            self.smooth.copy_from_slice(&p[..b]);
            self.cur.copy_from_slice(&p[..b]);
            self.noise.copy_from_slice(&p[..b]);
            // Unfilled sub-windows do not count, so the floor adapts quickly at the start.
            self.win.iter_mut().for_each(|v| *v = f32::MAX);
            self.mins.iter_mut().for_each(|v| *v = f32::MAX);
        }
        let a = self.alpha;
        for k in 0..b {
            let s = a * self.smooth[k] + (1.0 - a) * p[k];
            self.smooth[k] = s;
            if s < self.cur[k] {
                self.cur[k] = s;
            }
        }
        self.count += 1;
        if self.count >= self.v {
            self.count = 0;
            let off = self.slot * b;
            self.mins[off..off + b].copy_from_slice(&self.cur);
            self.slot = (self.slot + 1) % self.u;
            self.cur.copy_from_slice(&self.smooth);
            for k in 0..b {
                let mut m = f32::MAX;
                for s in 0..self.u {
                    m = fmin(m, self.mins[s * b + k]);
                }
                self.win[k] = m;
            }
        }
        let ad = self.alpha_d;
        for k in 0..b {
            let min = fmin(self.win[k], self.cur[k]);
            if self.smooth[k] < self.delta * min {
                self.noise[k] = ad * self.noise[k] + (1.0 - ad) * p[k];
            }
            // The mean lies between the proven minimum and a few times it.
            self.noise[k] = fmin(fmax(self.noise[k], min), self.delta * 2.0 * min);
        }
    }
}

/// Moving average of `src` with a per-bin radius, through prefix sums.
pub fn smooth_bins<R: Fn(usize) -> usize>(src: &[f32], dst: &mut [f32], prefix: &mut [f64], radius: R) {
    let n = src.len();
    prefix[0] = 0.0;
    for k in 0..n {
        prefix[k + 1] = prefix[k] + src[k] as f64;
    }
    for k in 0..n {
        let r = radius(k);
        let a = k.saturating_sub(r);
        let b = (k + r + 1).min(n);
        dst[k] = ((prefix[b] - prefix[a]) / (b - a) as f64) as f32;
    }
}

/// Sliding maximum over +-`r` bins (spectral dilation), O(n) with a deque.
pub fn max_filter(src: &[f32], dst: &mut [f32], r: usize, idx: &mut [usize]) {
    let n = src.len();
    if r == 0 {
        dst[..n].copy_from_slice(src);
        return;
    }
    let (mut head, mut tail, mut j) = (0usize, 0usize, 0usize);
    for i in 0..n {
        let hi = (i + r).min(n - 1);
        while j <= hi {
            while tail > head && src[idx[tail - 1]] <= src[j] {
                tail -= 1;
            }
            idx[tail] = j;
            tail += 1;
            j += 1;
        }
        let lo = i.saturating_sub(r);
        while idx[head] < lo {
            head += 1;
        }
        dst[i] = src[idx[head]];
    }
}

/// Gate gain in dB for an SNR (dB): `floor_db` at or below `threshold`,
/// 0 dB at `threshold + width`, linear in dB between.
#[inline]
pub fn gate_db(snr_db: f32, threshold: f32, width: f32, floor_db: f32) -> f32 {
    if snr_db >= threshold + width.max(0.0) {
        0.0
    } else if snr_db <= threshold {
        floor_db
    } else {
        floor_db * (1.0 - (snr_db - threshold) / width)
    }
}

/// Settings for `GateCore::frame`.
#[derive(Clone, Copy)]
pub struct GateSettings {
    /// SNR (dB) at or below which a bin is fully reduced.
    pub threshold_db: f32,
    /// dB above the threshold over which the gain returns to unity.
    pub width_db: f32,
    /// Maximum reduction in dB (negative).
    pub floor_db: f32,
    /// Signal power smoothing across frames (0 = none).
    pub power_alpha: f32,
    /// Let the signal estimate rise instantly (onsets never smeared) and
    /// only smooth its fall.
    pub instant_rise: bool,
    /// Gain smoothing radius across bins.
    pub smooth_bins: usize,
    /// Dilation radius across bins (keeps audio near detected signal).
    pub dilate_bins: usize,
    /// Per-frame multiplicative fall of the gain (0 = instant, near 1 = slow).
    pub fall: f32,
    /// Output only what is removed.
    pub residual: bool,
}

/// Turns a noise estimate into smooth per-bin gains and applies them.
pub struct GateCore {
    pub bins: usize,
    psmooth: Vec<Vec<f32>>,
    pub gain: Vec<Vec<f32>>,
    p: Vec<f32>,
    g: Vec<f32>,
    g2: Vec<f32>,
    prefix: Vec<f64>,
    idx: Vec<usize>,
}

impl GateCore {
    pub fn new(bins: usize, channels: usize) -> GateCore {
        GateCore {
            bins,
            psmooth: vec![vec![0.0; bins]; channels],
            gain: vec![vec![1.0; bins]; channels],
            p: vec![0.0; bins],
            g: vec![0.0; bins],
            g2: vec![0.0; bins],
            prefix: vec![0.0; bins + 1],
            idx: vec![0; bins],
        }
    }

    pub fn reset(&mut self) {
        for c in 0..self.psmooth.len() {
            self.psmooth[c].iter_mut().for_each(|v| *v = 0.0);
            self.gain[c].iter_mut().for_each(|v| *v = 1.0);
        }
    }

    /// Processes channel `c` of one frame. `noise` is the noise power per bin
    /// (same normalisation as `scale`), `weight` scales the reduction per bin.
    pub fn frame<W: Fn(usize) -> f32>(&mut self, c: usize, re: &mut [f32], im: &mut [f32], noise: &[f32], scale: f32, s: &GateSettings, weight: W) {
        let b = self.bins;
        power(re, im, &mut self.p, scale);
        let ps = &mut self.psmooth[c];
        let a = s.power_alpha;
        // Linear SNR bounds of the transition, so most bins need no logarithm.
        let lo = 10f32.powf(s.threshold_db * 0.1);
        let hi = 10f32.powf((s.threshold_db + s.width_db.max(0.0)) * 0.1);
        let floor_db = s.floor_db;
        for k in 0..b {
            ps[k] = if s.instant_rise && self.p[k] > ps[k] { self.p[k] } else { a * ps[k] + (1.0 - a) * self.p[k] };
            let n = noise[k] + 1e-20;
            let sig = ps[k] + 1e-20;
            self.g[k] = if sig >= hi * n {
                1.0
            } else {
                let gdb = if sig <= lo * n { floor_db } else { gate_db(fast_power_db(sig / n), s.threshold_db, s.width_db, floor_db) };
                fast_db_to_gain(gdb * weight(k))
            };
        }
        if s.dilate_bins > 0 {
            max_filter(&self.g, &mut self.g2, s.dilate_bins, &mut self.idx);
            self.g.copy_from_slice(&self.g2);
        }
        if s.smooth_bins > 0 {
            let r = s.smooth_bins;
            smooth_bins(&self.g, &mut self.g2, &mut self.prefix, |_| r);
            self.g.copy_from_slice(&self.g2);
        }
        let gs = &mut self.gain[c];
        for k in 0..b {
            let t = self.g[k];
            gs[k] = if t >= gs[k] { t } else { fmax(t, gs[k] * s.fall) };
            let g = if s.residual { 1.0 - gs[k] } else { gs[k] };
            re[k] *= g;
            im[k] *= g;
        }
    }
}

/// Per-frame gain fall factor for a decay of 60 dB in `ms` with frames `hop`
/// samples apart (0 when `ms` is 0: instant).
pub fn fall_per_frame(ms: f32, hop: usize, rate: f32) -> f32 {
    if ms <= 0.0 {
        return 0.0;
    }
    let frames = ms * 0.001 * rate / hop as f32;
    10f32.powf(-3.0 / frames.max(1e-3))
}

/// Linear interpolation of a power profile sampled at bins of FFT size
/// `from_n` (rate `from_rate`) onto bins of size `to_n` at `rate`.
pub fn resample_profile(src: &[f32], from_n: usize, from_rate: f32, dst: &mut [f32], to_n: usize, rate: f32) {
    let last = src.len().saturating_sub(1);
    for (k, d) in dst.iter_mut().enumerate() {
        let f = bin_hz(k, to_n, rate);
        let pos = f * from_n as f32 / from_rate;
        let i = (pos as usize).min(last);
        let j = (i + 1).min(last);
        let t = (pos - i as f32).clamp(0.0, 1.0);
        *d = if src.is_empty() { 0.0 } else { src[i] + (src[j] - src[i]) * t };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_filter_matches_naive() {
        let src: Vec<f32> = (0..50).map(|i| ((i * 37) % 23) as f32).collect();
        let mut dst = vec![0.0; 50];
        let mut idx = vec![0; 50];
        for r in [1, 3, 7, 60] {
            max_filter(&src, &mut dst, r, &mut idx);
            for i in 0usize..50 {
                let a = i.saturating_sub(r);
                let b = (i + r).min(49);
                let m = src[a..=b].iter().cloned().fold(f32::MIN, f32::max);
                assert_eq!(dst[i], m);
            }
        }
    }

    #[test]
    fn fast_math_is_accurate() {
        let mut x = 1e-12f32;
        while x < 1e12 {
            assert!((fast_log2(x) - x.log2()).abs() < 2e-4, "log2 {x}");
            x *= 1.37;
        }
        let mut y = -60.0f32;
        while y < 60.0 {
            let e = fast_exp2(y);
            assert!((e / y.exp2() - 1.0).abs() < 2e-4, "exp2 {y}");
            y += 0.173;
        }
    }

    #[test]
    fn gate_curve() {
        assert_eq!(gate_db(20.0, 0.0, 10.0, -30.0), 0.0);
        assert_eq!(gate_db(-5.0, 0.0, 10.0, -30.0), -30.0);
        assert!((gate_db(5.0, 0.0, 10.0, -30.0) + 15.0).abs() < 1e-4);
    }

    #[test]
    fn min_stats_tracks_noise_under_tones() {
        let bins = 16;
        let mut m = MinStats::new(bins, 128);
        let mut r = crate::fx::util::Rng(7);
        for f in 0..600 {
            let mut p = vec![0.0f32; bins];
            for k in 0..bins {
                // Exponentially distributed noise power of mean 1e-4, plus a tone burst in bin 3.
                let e = -(r.unit().max(1e-6)).ln();
                p[k] = 1e-4 * e + if k == 3 && f % 100 < 30 { 1.0 } else { 0.0 };
            }
            m.update(&p);
        }
        for k in 0..bins {
            let ratio = m.noise[k] / 1e-4;
            assert!(ratio > 0.5 && ratio < 2.0, "bin {k} ratio {ratio}");
        }
    }
}
