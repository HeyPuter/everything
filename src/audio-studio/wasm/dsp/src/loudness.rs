//! ITU-R BS.1770-4 loudness: K-weighting, 400 ms gated integrated loudness,
//! momentary (400 ms) and short-term (3 s) loudness, EBU Tech 3342 loudness
//! range and 4x oversampled true peak. The meter is streaming: push planar
//! blocks of any size, read results at any time.

use crate::slice_mut;

#[derive(Clone, Copy, Default)]
struct Biquad {
    b: [f64; 3],
    a: [f64; 3],
    z1: f64,
    z2: f64,
}

impl Biquad {
    #[inline]
    fn run(&mut self, x: f64) -> f64 {
        let y = self.b[0] * x + self.z1;
        self.z1 = self.b[1] * x - self.a[1] * y + self.z2;
        self.z2 = self.b[2] * x - self.a[2] * y;
        y
    }
}

/// The two K-weighting stages (high shelf, then RLB high-pass) for `rate`,
/// derived from the analog prototypes so any sample rate matches the 48 kHz
/// coefficients given in the recommendation.
fn k_weighting(rate: f64) -> [Biquad; 2] {
    use std::f64::consts::PI;
    let f0 = 1681.974450955533;
    let g = 3.999843853973347;
    let q = 0.7071752369554196;
    let k = (PI * f0 / rate).tan();
    let vh = 10f64.powf(g / 20.0);
    let vb = vh.powf(0.4996667741545416);
    let a0 = 1.0 + k / q + k * k;
    let shelf = Biquad {
        b: [(vh + vb * k / q + k * k) / a0, 2.0 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0],
        a: [1.0, 2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0],
        ..Default::default()
    };
    let f0 = 38.13547087602444;
    let q = 0.5003270373238773;
    let k = (PI * f0 / rate).tan();
    let d = 1.0 + k / q + k * k;
    let hp = Biquad { b: [1.0, -2.0, 1.0], a: [1.0, 2.0 * (k * k - 1.0) / d, (1.0 - k / q + k * k) / d], ..Default::default() };
    [shelf, hp]
}

/// Channel weights (ITU-R BS.1770-4): L, R, C = 1, LFE excluded, surrounds
/// +1.5 dB. Layouts by channel count, in WAV order: 5 = 5.0 (L R C Ls Rs),
/// 6 = 5.1 (L R C LFE Ls Rs), 8 = 7.1 (L R C LFE and four surrounds: the back
/// and side pairs, in either order). Other counts keep 5.1's first six.
fn channel_weight(index: usize, channels: usize) -> f64 {
    match channels {
        5 => match index {
            3 | 4 => 1.41,
            _ => 1.0,
        },
        8 => match index {
            3 => 0.0,
            4..=7 => 1.41,
            _ => 1.0,
        },
        c if c >= 6 => match index {
            3 => 0.0,
            4 | 5 => 1.41,
            _ => 1.0,
        },
        _ => 1.0,
    }
}

pub const TP_PHASES: usize = 4;
const TP_TAPS: usize = 16; // per phase

/// 4x oversampling interpolator for true peak: a Blackman windowed sinc,
/// split into polyphase branches; branch 0 reproduces the input samples.
pub struct TruePeak {
    coef: [[f32; TP_TAPS]; TP_PHASES],
    hist: Vec<[f32; TP_TAPS]>,
    pos: usize,
    pub peak: Vec<f32>,
}

impl TruePeak {
    pub fn new(channels: usize) -> TruePeak {
        let len = TP_PHASES * TP_TAPS;
        let centre = (len / 2) as f64;
        let mut coef = [[0.0f32; TP_TAPS]; TP_PHASES];
        for i in 0..len {
            let x = (i as f64 - centre) / TP_PHASES as f64;
            let sinc = if x == 0.0 { 1.0 } else { (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x) };
            let t = i as f64 / len as f64;
            let w = 0.42 - 0.5 * (2.0 * std::f64::consts::PI * t).cos() + 0.08 * (4.0 * std::f64::consts::PI * t).cos();
            coef[i % TP_PHASES][i / TP_PHASES] = (sinc * w) as f32;
        }
        // Unity DC gain per branch.
        for p in coef.iter_mut() {
            let s: f32 = p.iter().sum();
            if s.abs() > 1e-6 {
                p.iter_mut().for_each(|c| *c /= s);
            }
        }
        TruePeak { coef, hist: vec![[0.0; TP_TAPS]; channels], pos: 0, peak: vec![0.0; channels] }
    }

    /// Feeds one sample of channel ch; returns the largest absolute value among
    /// the 4 interpolated points it completes.
    #[inline]
    pub fn push(&mut self, ch: usize, x: f32) -> f32 {
        let h = &mut self.hist[ch];
        h[self.pos] = x;
        let mut m = 0.0f32;
        for p in 0..TP_PHASES {
            let c = &self.coef[p];
            let mut acc = 0.0f32;
            for j in 0..TP_TAPS {
                // h[(pos - j) mod TAPS]
                acc += c[j] * h[(self.pos + TP_TAPS - j) % TP_TAPS];
            }
            m = m.max(acc.abs());
        }
        if m > self.peak[ch] {
            self.peak[ch] = m;
        }
        m
    }

    /// Advances the shared write position after a frame of every channel.
    #[inline]
    pub fn advance(&mut self) {
        self.pos = (self.pos + 1) % TP_TAPS;
    }
}

pub struct Meter {
    channels: usize,
    filters: Vec<[Biquad; 2]>,
    weights: Vec<f64>,
    sub_len: usize,
    acc: f64,
    count: usize,
    /// Weighted mean square of every completed 100 ms sub-block.
    pub subs: Vec<f64>,
    pub tp: TruePeak,
    pub sample_peak: Vec<f32>,
}

pub fn power_to_lufs(p: f64) -> f64 {
    if p <= 0.0 {
        f64::NEG_INFINITY
    } else {
        -0.691 + 10.0 * p.log10()
    }
}

impl Meter {
    pub fn new(rate: f64, channels: usize) -> Meter {
        Meter {
            channels,
            filters: (0..channels).map(|_| k_weighting(rate)).collect(),
            weights: (0..channels).map(|i| channel_weight(i, channels)).collect(),
            sub_len: ((rate * 0.1).round() as usize).max(1),
            acc: 0.0,
            count: 0,
            subs: Vec::new(),
            tp: TruePeak::new(channels),
            sample_peak: vec![0.0; channels],
        }
    }

    /// Planar input: channel c at buf[c * frames .. (c + 1) * frames].
    pub fn push(&mut self, buf: &[f32], frames: usize) {
        for i in 0..frames {
            let mut e = 0.0f64;
            for c in 0..self.channels {
                let x = buf[c * frames + i];
                let x = if x.is_finite() { x } else { 0.0 };
                let a = x.abs();
                if a > self.sample_peak[c] {
                    self.sample_peak[c] = a;
                }
                self.tp.push(c, x);
                let f = &mut self.filters[c];
                let s = f[0].run(x as f64);
                let y = f[1].run(s);
                e += self.weights[c] * y * y;
            }
            self.tp.advance();
            self.acc += e;
            self.count += 1;
            if self.count == self.sub_len {
                self.subs.push(self.acc / self.sub_len as f64);
                self.acc = 0.0;
                self.count = 0;
            }
        }
    }

    fn window(&self, end: usize, n: usize) -> f64 {
        self.subs[end - n..end].iter().sum::<f64>() / n as f64
    }

    /// Loudness of the last `n` sub-blocks (4 = momentary, 30 = short-term).
    pub fn recent(&self, n: usize) -> f64 {
        if self.subs.len() < n {
            return f64::NEG_INFINITY;
        }
        power_to_lufs(self.window(self.subs.len(), n))
    }

    /// Maximum over every position of an n sub-block window.
    pub fn max_window(&self, n: usize) -> f64 {
        let mut best = f64::NEG_INFINITY;
        if self.subs.len() < n {
            return best;
        }
        let mut sum: f64 = self.subs[..n].iter().sum();
        best = power_to_lufs(sum / n as f64);
        for i in n..self.subs.len() {
            sum += self.subs[i] - self.subs[i - n];
            best = best.max(power_to_lufs(sum.max(0.0) / n as f64));
        }
        best
    }

    /// Gated integrated loudness (BS.1770-4): 400 ms blocks, 75 % overlap,
    /// absolute gate -70 LUFS, relative gate -10 LU.
    pub fn integrated(&self) -> f64 {
        let blocks = self.block_powers(4);
        gated_mean(&blocks, -10.0).0
    }

    fn block_powers(&self, n: usize) -> Vec<f64> {
        if self.subs.len() < n {
            return Vec::new();
        }
        let mut out = Vec::with_capacity(self.subs.len() - n + 1);
        let mut sum: f64 = self.subs[..n].iter().sum();
        out.push(sum / n as f64);
        for i in n..self.subs.len() {
            sum += self.subs[i] - self.subs[i - n];
            out.push(sum.max(0.0) / n as f64);
        }
        out
    }

    /// Loudness range (EBU Tech 3342): short-term (3 s) values gated at
    /// -70 LUFS and -20 LU relative, spread between the 10th and 95th percentiles.
    pub fn range(&self) -> f64 {
        let blocks = self.block_powers(30);
        let (_, gated) = gated_mean(&blocks, -20.0);
        if gated.is_empty() {
            return 0.0;
        }
        let mut l: Vec<f64> = gated.iter().map(|&p| power_to_lufs(p)).collect();
        l.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let pick = |q: f64| l[((l.len() - 1) as f64 * q).round() as usize];
        pick(0.95) - pick(0.10)
    }
}

/// Mean loudness of blocks above -70 LUFS and above (that mean + rel) LU.
/// Returns the loudness and the block powers that passed both gates.
fn gated_mean(blocks: &[f64], rel: f64) -> (f64, Vec<f64>) {
    let abs_gate = 10f64.powf((-70.0 + 0.691) / 10.0);
    let above: Vec<f64> = blocks.iter().copied().filter(|&p| p > abs_gate).collect();
    if above.is_empty() {
        return (f64::NEG_INFINITY, Vec::new());
    }
    let mean = above.iter().sum::<f64>() / above.len() as f64;
    let rel_gate = 10f64.powf((power_to_lufs(mean) + rel + 0.691) / 10.0);
    let passed: Vec<f64> = above.into_iter().filter(|&p| p > rel_gate).collect();
    if passed.is_empty() {
        return (f64::NEG_INFINITY, passed);
    }
    let m = passed.iter().sum::<f64>() / passed.len() as f64;
    (power_to_lufs(m), passed)
}

#[no_mangle]
pub extern "C" fn lufs_new(rate: f32, channels: u32) -> u32 {
    Box::into_raw(Box::new(Meter::new(rate as f64, channels.max(1) as usize))) as u32
}

#[no_mangle]
pub extern "C" fn lufs_free(h: u32) {
    if h != 0 {
        unsafe { drop(Box::from_raw(h as *mut Meter)) }
    }
}

#[no_mangle]
pub extern "C" fn lufs_push(h: u32, buf: u32, frames: u32) {
    let m = unsafe { &mut *(h as *mut Meter) };
    let s = unsafe { crate::slice(buf, frames * m.channels as u32) };
    m.push(s, frames as usize);
}

/// Writes [integrated, range, momentary, shortTerm, maxMomentary, maxShortTerm,
/// then true peak (linear) and sample peak (linear) per channel].
#[no_mangle]
pub extern "C" fn lufs_result(h: u32, out: u32) {
    let m = unsafe { &*(h as *mut Meter) };
    let o = unsafe { slice_mut(out, 6 + 2 * m.channels as u32) };
    let f = |v: f64| if v.is_finite() { v as f32 } else { -1000.0 };
    o[0] = f(m.integrated());
    o[1] = m.range() as f32;
    o[2] = f(m.recent(4));
    o[3] = f(m.recent(30));
    o[4] = f(m.max_window(4));
    o[5] = f(m.max_window(30));
    for c in 0..m.channels {
        o[6 + c] = m.tp.peak[c].max(m.sample_peak[c]);
        o[6 + m.channels + c] = m.sample_peak[c];
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    fn stereo_sine(rate: f64, freq: f64, dbfs: f64, secs: f64, phase: f64) -> Vec<f32> {
        let n = (rate * secs) as usize;
        let a = 10f64.powf(dbfs / 20.0);
        let ch: Vec<f32> = (0..n).map(|i| (a * (2.0 * PI * freq * i as f64 / rate + phase).sin()) as f32).collect();
        let mut out = ch.clone();
        out.extend_from_slice(&ch);
        out
    }

    fn measure(rate: f64, channels: usize, parts: &[Vec<f32>]) -> Meter {
        let mut m = Meter::new(rate, channels);
        for p in parts {
            let frames = p.len() / channels;
            // Feed in odd-sized pieces to exercise streaming.
            let mut at = 0;
            while at < frames {
                let n = 1237.min(frames - at);
                let mut buf = Vec::with_capacity(n * channels);
                for c in 0..channels {
                    buf.extend_from_slice(&p[c * frames + at..c * frames + at + n]);
                }
                m.push(&buf, n);
                at += n;
            }
        }
        m
    }

    #[test]
    fn ebu_3341_case_1_and_2_stereo_sine() {
        // EBU Tech 3341: 1 kHz stereo sine at -23 dBFS reads -23.0 LUFS.
        for rate in [44100.0, 48000.0] {
            let m = measure(rate, 2, &[stereo_sine(rate, 1000.0, -23.0, 20.0, 0.0)]);
            assert!((m.integrated() + 23.0).abs() < 0.1, "{} at {}", m.integrated(), rate);
            let m = measure(rate, 2, &[stereo_sine(rate, 1000.0, -33.0, 20.0, 0.0)]);
            assert!((m.integrated() + 33.0).abs() < 0.1);
            assert!((m.recent(4) + 33.0).abs() < 0.1);
            assert!((m.recent(30) + 33.0).abs() < 0.1);
        }
    }

    #[test]
    fn stereo_minus_20_dbfs_reads_minus_20_lufs_and_mono_minus_23() {
        let rate = 48000.0;
        let m = measure(rate, 2, &[stereo_sine(rate, 1000.0, -20.0, 10.0, 0.0)]);
        assert!((m.integrated() + 20.0).abs() < 0.1, "{}", m.integrated());
        // One channel only: half the power, -3 dB.
        let s = stereo_sine(rate, 1000.0, -20.0, 10.0, 0.0);
        let mono = s[..s.len() / 2].to_vec();
        let m = measure(rate, 1, &[mono]);
        assert!((m.integrated() + 23.01).abs() < 0.1, "{}", m.integrated());
    }

    #[test]
    fn surround_channels_are_weighted_for_5_0_5_1_and_7_1() {
        // A -20 dBFS 997 Hz sine in one channel: -23.01 LUFS in front, +1.5 dB in a surround,
        // nothing in the LFE.
        let rate = 48000.0;
        let n = (rate * 10.0) as usize;
        let tone: Vec<f32> = (0..n).map(|i| (0.1 * (2.0 * PI * 997.0 * i as f64 / rate).sin()) as f32).collect();
        let one = |channels: usize, index: usize| {
            let mut p = vec![0.0f32; channels * n];
            p[index * n..(index + 1) * n].copy_from_slice(&tone);
            measure(rate, channels, &[p]).integrated()
        };
        let surround = -23.01 + 10.0 * 1.41f64.log10();
        for (channels, fronts, surrounds) in [(5, vec![0, 1, 2], vec![3, 4]), (6, vec![0, 1, 2], vec![4, 5]), (8, vec![0, 1, 2], vec![4, 5, 6, 7])] {
            for i in fronts {
                assert!((one(channels, i) + 23.01).abs() < 0.05, "{channels} ch {i}: {}", one(channels, i));
            }
            for i in surrounds {
                assert!((one(channels, i) - surround).abs() < 0.05, "{channels} ch {i}: {}", one(channels, i));
            }
        }
        assert!(one(6, 3) < -70.0);
        assert!(one(8, 3) < -70.0);
    }

    #[test]
    fn ebu_3341_case_3_gating() {
        // -36 / -23 / -36 dBFS, 10 / 60 / 10 s: the relative gate drops the quiet parts.
        let rate = 48000.0;
        let m = measure(
            rate,
            2,
            &[
                stereo_sine(rate, 1000.0, -36.0, 10.0, 0.0),
                stereo_sine(rate, 1000.0, -23.0, 60.0, 0.0),
                stereo_sine(rate, 1000.0, -36.0, 10.0, 0.0),
            ],
        );
        assert!((m.integrated() + 23.0).abs() < 0.1, "{}", m.integrated());
    }

    #[test]
    fn ebu_3341_case_5_absolute_gate() {
        // -26 / -20 / -26 dBFS for 20.1 / 20.1... simplified: silence is gated out.
        let rate = 48000.0;
        let silence = vec![0.0f32; (rate * 20.0) as usize * 2];
        let m = measure(rate, 2, &[silence.clone(), stereo_sine(rate, 1000.0, -23.0, 20.0, 0.0), silence]);
        assert!((m.integrated() + 23.0).abs() < 0.1, "{}", m.integrated());
    }

    #[test]
    fn ebu_3342_loudness_range() {
        let rate = 48000.0;
        // Case 1: 20 s at -20 then 20 s at -30 dBFS: LRA 10 LU (+-1).
        let m = measure(rate, 2, &[stereo_sine(rate, 1000.0, -20.0, 20.0, 0.0), stereo_sine(rate, 1000.0, -30.0, 20.0, 0.0)]);
        assert!((m.range() - 10.0).abs() < 1.0, "{}", m.range());
        // Case 2: -20 then -15: 5 LU.
        let m = measure(rate, 2, &[stereo_sine(rate, 1000.0, -20.0, 20.0, 0.0), stereo_sine(rate, 1000.0, -15.0, 20.0, 0.0)]);
        assert!((m.range() - 5.0).abs() < 1.0, "{}", m.range());
    }

    #[test]
    fn silence_and_short_input_are_minus_infinity() {
        let m = measure(48000.0, 2, &[vec![0.0; 96000]]);
        assert!(m.integrated().is_infinite());
        let m = measure(48000.0, 2, &[stereo_sine(48000.0, 1000.0, -20.0, 0.2, 0.0)]);
        assert!(m.integrated().is_infinite());
    }

    #[test]
    fn true_peak_finds_inter_sample_peaks() {
        // A quarter-rate sine at 45 degrees: samples peak at 0.707, the signal at 1.0.
        let rate = 48000.0;
        let s = stereo_sine(rate, 12000.0, -0.0, 1.0, PI / 4.0);
        let m = measure(rate, 2, &[s]);
        let sample_db = 20.0 * (m.sample_peak[0] as f64).log10();
        let tp_db = 20.0 * (m.tp.peak[0] as f64).log10();
        assert!((sample_db + 3.01).abs() < 0.05, "{}", sample_db);
        assert!(tp_db.abs() < 0.3, "{}", tp_db);
        // A low tone's true peak equals its sample peak.
        let m = measure(rate, 2, &[stereo_sine(rate, 997.0, -6.0, 1.0, 0.0)]);
        let tp_db = 20.0 * (m.tp.peak[0] as f64).log10();
        assert!((tp_db + 6.0).abs() < 0.1, "{}", tp_db);
    }
}
