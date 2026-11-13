//! Offline time and pitch processors, streamed so long files never need to be
//! in WASM memory at once: input is pushed in chunks and output pulled as it
//! becomes final.
//!
//! - `Vocoder`: phase-locked phase vocoder. Time stretch by `alpha` (output
//!   length / input length) and pitch ratio by a constant or a curve over
//!   input time, independently. Optional formant preservation and channel lock.
//! - `Wsola`: waveform-similarity overlap-add time stretch (clean on speech),
//!   followed by a resampler for pitch.
//! - `Resampler`: varispeed (tape-style) resampling with a windowed sinc,
//!   speed constant or following a curve over input time.

use super::core::{fft_size, PeakShifter, SincTable};
use crate::fft::{RealFft, Window};

/// Piecewise linear curve over input frames: (position, value) pairs sorted
/// by position, held flat outside the range. The cursor makes monotonic
/// lookups O(1).
pub struct Curve {
    pts: Vec<(f64, f32)>,
    cursor: usize,
    pub constant: f32,
}

impl Curve {
    pub fn new(constant: f32) -> Curve {
        Curve { pts: Vec::new(), cursor: 0, constant }
    }
    pub fn set(&mut self, flat: &[f32]) {
        self.pts = flat.chunks_exact(2).map(|p| (p[0] as f64, p[1])).collect();
        self.pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        self.cursor = 0;
    }
    pub fn at(&mut self, x: f64) -> f32 {
        let p = &self.pts;
        if p.is_empty() {
            return self.constant;
        }
        if x <= p[0].0 {
            return p[0].1;
        }
        if x >= p[p.len() - 1].0 {
            return p[p.len() - 1].1;
        }
        if self.cursor >= p.len() - 1 || p[self.cursor].0 > x {
            self.cursor = 0;
        }
        while self.cursor + 1 < p.len() - 1 && p[self.cursor + 1].0 <= x {
            self.cursor += 1;
        }
        let (a, b) = (p[self.cursor], p[self.cursor + 1]);
        let t = ((x - a.0) / (b.0 - a.0).max(1e-9)) as f32;
        a.1 + (b.1 - a.1) * t
    }
}

/// Growable planar input with an absolute frame index for element 0.
struct Input {
    data: Vec<Vec<f32>>,
    base: i64,
    total: i64,
    finished: bool,
}

impl Input {
    fn new(channels: usize) -> Input {
        Input { data: vec![Vec::new(); channels], base: 0, total: 0, finished: false }
    }
    /// A non-finite sample (a damaged float file) is taken as silence: the
    /// analysis frames and interpolation kernels would otherwise spread it
    /// to thousands of NaN output frames.
    fn push(&mut self, planar: &[f32], frames: usize) {
        for (c, d) in self.data.iter_mut().enumerate() {
            d.extend(planar[c * frames..(c + 1) * frames].iter().map(|&v| if v.is_finite() { v } else { 0.0 }));
        }
        self.total += frames as i64;
    }
    #[inline]
    fn at(&self, c: usize, pos: i64) -> f32 {
        if pos < self.base || pos >= self.total {
            0.0
        } else {
            self.data[c][(pos - self.base) as usize]
        }
    }
    /// Frees frames before `pos` (in large steps to keep moves rare). At extreme stretch
    /// ratios the read position can run ahead of the frames pushed so far: only those are
    /// dropped (frames past them have not arrived yet).
    fn drop_before(&mut self, pos: i64) {
        let pos = pos.min(self.total);
        let n = pos - self.base;
        if n > 1 << 16 {
            for d in &mut self.data {
                d.drain(..n as usize);
            }
            self.base = pos;
        }
    }
}

/// Planar output queue.
struct Output {
    data: Vec<Vec<f32>>,
}

impl Output {
    fn len(&self) -> usize {
        self.data[0].len()
    }
    /// Moves up to `max` frames into `dst` (planar with stride `max`).
    fn pull(&mut self, dst: &mut [f32], max: usize) -> usize {
        let n = self.len().min(max);
        for (c, d) in self.data.iter_mut().enumerate() {
            dst[c * max..c * max + n].copy_from_slice(&d[..n]);
            d.drain(..n);
        }
        n
    }
}

pub struct Vocoder {
    ch: usize,
    n: usize,
    hs: usize,
    h0: usize,
    alpha: f64,
    fft: RealFft,
    window: Vec<f32>,
    norm: f32,
    input: Input,
    out: Output,
    m: i64,
    accum: Vec<Vec<f32>>,
    emitted: i64,
    core: PeakShifter,
    frame: Vec<f32>,
    re: Vec<Vec<f32>>,
    im: Vec<Vec<f32>>,
    pre: Vec<Vec<f32>>,
    pim: Vec<Vec<f32>>,
    pub pitch: Curve,
    lock: bool,
    formants: bool,
}

impl Vocoder {
    pub fn new(ch: usize, rate: f32, precision: u32, alpha: f64, pitch: f32, lock: bool, formants: bool) -> Vocoder {
        let n = fft_size(2048, precision, rate);
        let hs = n / 4;
        let window = Window::Hann.build(n);
        let mut s = 0.0;
        let mut i = 0;
        while i < n {
            s += window[i] * window[i];
            i += hs;
        }
        let bins = n / 2 + 1;
        Vocoder {
            ch,
            n,
            hs,
            h0: n / 8,
            alpha: alpha.clamp(0.05, 20.0),
            fft: RealFft::new(n),
            window,
            norm: 1.0 / s,
            input: Input::new(ch),
            out: Output { data: vec![Vec::new(); ch] },
            m: -4,
            accum: vec![vec![0.0; n]; ch],
            emitted: 0,
            core: PeakShifter::new(n, ch, rate),
            frame: vec![0.0; n],
            re: vec![vec![0.0; bins]; ch],
            im: vec![vec![0.0; bins]; ch],
            pre: vec![vec![0.0; bins]; ch],
            pim: vec![vec![0.0; bins]; ch],
            pitch: Curve::new(pitch),
            lock,
            formants,
        }
    }

    fn out_len(&self) -> Option<i64> {
        if self.input.finished {
            Some((self.input.total as f64 * self.alpha).round() as i64)
        } else {
            None
        }
    }

    fn analyse(&mut self, c: usize, start: i64, prev: bool) {
        for k in 0..self.n {
            self.frame[k] = self.input.at(c, start + k as i64) * self.window[k];
        }
        if prev {
            self.fft.forward(&self.frame, &mut self.pre[c], &mut self.pim[c]);
        } else {
            self.fft.forward(&self.frame, &mut self.re[c], &mut self.im[c]);
        }
    }

    /// Runs every frame whose input is available.
    pub fn run(&mut self) {
        let (n, hs) = (self.n as i64, self.hs as i64);
        loop {
            let out_len = self.out_len();
            if let Some(len) = out_len {
                if self.emitted >= len {
                    break;
                }
            }
            let oc = self.m * hs;
            let ic = oc as f64 / self.alpha;
            let start = ic.round() as i64 - n / 2;
            if !self.input.finished && start + n > self.input.total {
                break;
            }
            for c in 0..self.ch {
                self.analyse(c, start, false);
                self.analyse(c, start - self.h0 as i64, true);
            }
            let ratio = self.pitch.at(ic).clamp(0.125, 8.0);
            let bypass_ok = (self.alpha - 1.0).abs() < 1e-9;
            let groups = if self.lock || self.ch == 1 { 1 } else { self.ch };
            for g in 0..groups {
                let (lo, hi) = if groups == 1 { (0, self.ch) } else { (g, g + 1) };
                let bypass = self.core.shift(&self.re, &self.im, &self.pre, &self.pim, lo, hi, ratio, self.h0 as f32, self.hs as f32, self.formants, bypass_ok);
                for c in lo..hi {
                    let (sr, si) = if bypass { (&self.re[c], &self.im[c]) } else { (&self.core.ore[c], &self.core.oim[c]) };
                    self.fft.inverse(sr, si, &mut self.frame);
                    let acc = &mut self.accum[c];
                    for k in 0..self.n {
                        acc[k] += self.frame[k] * self.window[k] * self.norm;
                    }
                }
            }
            // Frames after this one start at or after (m + 1) * hs - n / 2.
            let final_end = (self.m + 1) * hs - n / 2;
            let acc_start = self.m * hs - n / 2;
            for c in 0..self.ch {
                let acc = &mut self.accum[c];
                for k in 0..self.hs {
                    let pos = acc_start + k as i64;
                    if pos >= 0 && out_len.map_or(true, |l| pos < l) {
                        self.out.data[c].push(acc[k]);
                    }
                }
                acc.copy_within(self.hs.., 0);
                let len = acc.len();
                acc[len - self.hs..].iter_mut().for_each(|v| *v = 0.0);
            }
            self.emitted = self.emitted.max(final_end.max(0));
            if let Some(l) = out_len {
                self.emitted = self.emitted.min(l);
            }
            self.m += 1;
            let next_start = ((self.m * hs) as f64 / self.alpha).round() as i64 - n / 2 - self.h0 as i64;
            self.input.drop_before(next_start);
        }
    }
}

pub struct Wsola {
    ch: usize,
    l: usize,
    hs: usize,
    delta: i64,
    alpha: f64,
    window: Vec<f32>,
    input: Input,
    out: Output,
    m: i64,
    prev: i64,
    accum: Vec<Vec<f32>>,
    emitted: i64,
    mono_a: Vec<f32>,
    mono_b: Vec<f32>,
}

impl Wsola {
    pub fn new(ch: usize, rate: f32, alpha: f64) -> Wsola {
        // 40 ms frames (power of two not needed), tolerance a quarter frame.
        let l = (((rate * 0.04) as usize) / 2) * 2;
        let hs = l / 2;
        // Periodic Hann sums to one at 50% overlap.
        let window = (0..l).map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / l as f32).cos()).collect();
        Wsola {
            ch,
            l,
            hs,
            delta: (l / 4) as i64,
            alpha: alpha.clamp(0.05, 20.0),
            window,
            input: Input::new(ch),
            out: Output { data: vec![Vec::new(); ch] },
            m: -1,
            prev: 0,
            accum: vec![vec![0.0; l]; ch],
            emitted: 0,
            mono_a: vec![0.0; l],
            mono_b: vec![0.0; l + 2 * (l / 4)],
        }
    }

    fn out_len(&self) -> Option<i64> {
        if self.input.finished {
            Some((self.input.total as f64 * self.alpha).round() as i64)
        } else {
            None
        }
    }

    fn mono(&self, pos: i64) -> f32 {
        let mut s = 0.0;
        for c in 0..self.ch {
            s += self.input.at(c, pos);
        }
        s
    }

    /// Offset in [-delta, delta] whose segment best continues the previous frame.
    fn search(&mut self, nominal: i64) -> i64 {
        let (l, d) = (self.l as i64, self.delta);
        let half = (l / 2) as usize;
        let nat = self.prev + self.hs as i64;
        for i in 0..half {
            self.mono_a[i] = self.mono(nat + i as i64);
        }
        let span = half + 2 * d as usize + 1;
        for i in 0..span {
            self.mono_b[i] = self.mono(nominal - d + i as i64);
        }
        let ea: f32 = self.mono_a[..half].iter().map(|v| v * v).sum();
        if ea < 1e-12 {
            return 0;
        }
        let score = |b: &[f32], a: &[f32], off: usize, step: usize| -> f32 {
            let mut num = 0.0;
            let mut eb = 0.0;
            let mut i = 0;
            while i < half {
                let x = b[off + i];
                num += a[i] * x;
                eb += x * x;
                i += step;
            }
            num / (eb.sqrt() + 1e-9)
        };
        // Coarse search on every second offset and sample, then refine.
        let mut best = 0usize;
        let mut best_s = f32::MIN;
        let mut off = 0;
        while off <= 2 * d as usize {
            let s = score(&self.mono_b, &self.mono_a, off, 2);
            if s > best_s {
                best_s = s;
                best = off;
            }
            off += 2;
        }
        let lo = best.saturating_sub(2);
        let hi = (best + 2).min(2 * d as usize);
        best_s = f32::MIN;
        for off in lo..=hi {
            let s = score(&self.mono_b, &self.mono_a, off, 1);
            if s > best_s {
                best_s = s;
                best = off;
            }
        }
        best as i64 - d
    }

    pub fn run(&mut self) {
        let (l, hs) = (self.l as i64, self.hs as i64);
        loop {
            let out_len = self.out_len();
            if let Some(len) = out_len {
                if self.emitted >= len {
                    break;
                }
            }
            let om = self.m * hs;
            let nominal = ((om + l / 2) as f64 / self.alpha).round() as i64 - l / 2;
            if !self.input.finished && nominal + l + self.delta + 1 > self.input.total {
                break;
            }
            let start = if self.m <= 0 { nominal } else { nominal + self.search(nominal) };
            for c in 0..self.ch {
                for k in 0..self.l {
                    self.accum[c][k] += self.input.at(c, start + k as i64) * self.window[k];
                }
            }
            self.prev = start;
            let final_end = (self.m + 1) * hs;
            for c in 0..self.ch {
                let acc = &mut self.accum[c];
                for k in 0..self.hs {
                    let pos = om + k as i64;
                    if pos >= 0 && out_len.map_or(true, |len| pos < len) {
                        self.out.data[c].push(acc[k]);
                    }
                }
                acc.copy_within(self.hs.., 0);
                let len = acc.len();
                acc[len - self.hs..].iter_mut().for_each(|v| *v = 0.0);
            }
            self.emitted = final_end.max(0);
            if let Some(len) = out_len {
                self.emitted = self.emitted.min(len);
            }
            self.m += 1;
            self.input.drop_before(nominal - 2 * l);
        }
    }
}

pub struct Resampler {
    ch: usize,
    table: SincTable,
    input: Input,
    out: Output,
    pos: f64,
    pub speed: Curve,
}

impl Resampler {
    /// `speed` is input frames consumed per output frame (2 = an octave up, half length).
    pub fn new(ch: usize, speed: f32) -> Resampler {
        Resampler::with_zeros(ch, speed, 16)
    }

    /// As `new`, with a kernel of `zeros` zero crossings each side (quality:
    /// longer kernels pass more of the band and alias less, at more cost).
    pub fn with_zeros(ch: usize, speed: f32, zeros: usize) -> Resampler {
        Resampler { ch, table: SincTable::new(zeros.clamp(2, 64), 512), input: Input::new(ch), out: Output { data: vec![Vec::new(); ch] }, pos: 0.0, speed: Curve::new(speed) }
    }

    pub fn run(&mut self) {
        let z = self.table.zeros as f64;
        loop {
            if self.input.finished && self.pos >= self.input.total as f64 {
                break;
            }
            let speed = (self.speed.at(self.pos) as f64).clamp(0.0625, 16.0);
            let cut = (1.0 / speed).min(1.0);
            let reach = (z / cut).ceil() as i64 + 1;
            let centre = self.pos.floor() as i64;
            if !self.input.finished && centre + reach >= self.input.total {
                break;
            }
            for c in 0..self.ch {
                let mut acc = 0.0f32;
                for j in centre - reach + 1..=centre + reach {
                    let u = ((j as f64 - self.pos) * cut) as f32;
                    acc += self.input.at(c, j) * self.table.at(u);
                }
                self.out.data[c].push(acc * cut as f32);
            }
            self.pos += speed;
            self.input.drop_before(centre - reach - 1);
        }
    }
}

/// One offline job: a stretch/pitch processor, or WSOLA feeding a resampler.
pub enum Job {
    Vocoder(Vocoder),
    Wsola(Wsola, Option<Resampler>),
    Resample(Resampler),
}

impl Job {
    pub fn push(&mut self, planar: &[f32], frames: usize) {
        match self {
            Job::Vocoder(v) => {
                v.input.push(planar, frames);
                v.run();
            }
            Job::Wsola(w, r) => {
                w.input.push(planar, frames);
                w.run();
                if let Some(r) = r {
                    pipe(w, r);
                }
            }
            Job::Resample(r) => {
                r.input.push(planar, frames);
                r.run();
            }
        }
    }

    pub fn finish(&mut self) {
        match self {
            Job::Vocoder(v) => {
                v.input.finished = true;
                v.run();
            }
            Job::Wsola(w, r) => {
                w.input.finished = true;
                w.run();
                if let Some(r) = r {
                    pipe(w, r);
                    r.input.finished = true;
                    r.run();
                }
            }
            Job::Resample(r) => {
                r.input.finished = true;
                r.run();
            }
        }
    }

    fn out(&mut self) -> &mut Output {
        match self {
            Job::Vocoder(v) => &mut v.out,
            Job::Wsola(w, None) => &mut w.out,
            Job::Wsola(_, Some(r)) => &mut r.out,
            Job::Resample(r) => &mut r.out,
        }
    }

    pub fn available(&mut self) -> usize {
        self.out().len()
    }

    pub fn pull(&mut self, dst: &mut [f32], max: usize) -> usize {
        self.out().pull(dst, max)
    }
}

fn pipe(w: &mut Wsola, r: &mut Resampler) {
    let n = w.out.len();
    if n == 0 {
        return;
    }
    for c in 0..w.ch {
        r.input.data[c].extend(w.out.data[c].drain(..));
    }
    r.input.total += n as i64;
    r.run();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fx::pitch::shifter::tests::measure_freq;
    use crate::fx::testutil::{rms, sine};

    fn run_job(job: &mut Job, x: &[Vec<f32>], chunk: usize) -> Vec<Vec<f32>> {
        let ch = x.len();
        let mut out = vec![Vec::new(); ch];
        let drain = |job: &mut Job, out: &mut Vec<Vec<f32>>| {
            let n = job.available();
            let mut buf = vec![0.0; ch * n.max(1)];
            let got = job.pull(&mut buf, n.max(1));
            for c in 0..ch {
                out[c].extend_from_slice(&buf[c * n.max(1)..c * n.max(1) + got]);
            }
        };
        let len = x[0].len();
        let mut at = 0;
        while at < len {
            let m = chunk.min(len - at);
            let mut planar = Vec::with_capacity(ch * m);
            for c in 0..ch {
                planar.extend_from_slice(&x[c][at..at + m]);
            }
            job.push(&planar, m);
            drain(job, &mut out);
            at += m;
        }
        job.finish();
        drain(job, &mut out);
        out
    }

    #[test]
    fn non_finite_input_samples_do_not_spread() {
        let rate = 48000.0;
        let mut x = sine(440.0, rate, 48000, 0.5);
        x[10000] = f32::NAN;
        x[20000] = f32::INFINITY;
        x[30000] = f32::NEG_INFINITY;
        let jobs = [
            Job::Vocoder(Vocoder::new(1, rate, 1, 1.2, 1.0, true, false)),
            Job::Wsola(Wsola::new(1, rate, 1.2 * 1.5), Some(Resampler::new(1, 1.5))),
            Job::Resample(Resampler::new(1, 0.8)),
        ];
        for mut job in jobs {
            let y = run_job(&mut job, &[x.clone()], 7000);
            assert!(y[0].len() > 40000);
            assert!(y[0].iter().all(|v| v.is_finite()));
            assert!(rms(&y[0]) > 0.3);
        }
    }

    #[test]
    fn vocoder_stretches_and_keeps_pitch() {
        let rate = 48000.0;
        let x = vec![sine(440.0, rate, 48000, 0.5)];
        for alpha in [0.5, 1.5, 3.0] {
            let mut job = Job::Vocoder(Vocoder::new(1, rate, 1, alpha, 1.0, true, false));
            let y = run_job(&mut job, &x, 10000);
            assert_eq!(y[0].len(), (48000.0 * alpha).round() as usize);
            let mid = &y[0][y[0].len() / 4..3 * y[0].len() / 4];
            let f = measure_freq(mid, rate);
            assert!((f / 440.0 - 1.0).abs() < 0.003, "alpha {alpha}: {f}");
            assert!((rms(mid) / 0.3536 - 1.0).abs() < 0.2, "alpha {alpha}: level {}", rms(mid));
        }
    }

    #[test]
    fn vocoder_shifts_pitch_without_changing_length() {
        let rate = 48000.0;
        let x = vec![sine(440.0, rate, 48000, 0.5), sine(440.0, rate, 48000, 0.25)];
        let ratio = 2f32.powf(5.0 / 12.0);
        let mut job = Job::Vocoder(Vocoder::new(2, rate, 1, 1.0, ratio, true, false));
        let y = run_job(&mut job, &x, 7000);
        assert_eq!(y[0].len(), 48000);
        let f = measure_freq(&y[0][12000..36000], rate);
        assert!((f / (440.0 * ratio) - 1.0).abs() < 0.003, "{f}");
        // Channel balance survives.
        assert!((rms(&y[1][12000..36000]) / rms(&y[0][12000..36000]) - 0.5).abs() < 0.05);
    }

    #[test]
    fn vocoder_unity_is_transparent() {
        let rate = 48000.0;
        let x = vec![sine(300.0, rate, 20000, 0.5)];
        let mut job = Job::Vocoder(Vocoder::new(1, rate, 0, 1.0, 1.0, true, false));
        let y = run_job(&mut job, &x, 3000);
        assert_eq!(y[0].len(), 20000);
        for i in 0..20000 {
            assert!((y[0][i] - x[0][i]).abs() < 1e-3, "{i}");
        }
    }

    #[test]
    fn vocoder_follows_a_pitch_curve() {
        let rate = 48000.0;
        let x = vec![sine(400.0, rate, 96000, 0.5)];
        let mut v = Vocoder::new(1, rate, 1, 1.0, 1.0, true, false);
        // Unity for the first half, a fifth up in the second.
        let r = 2f32.powf(7.0 / 12.0);
        v.pitch.set(&[0.0, 1.0, 47000.0, 1.0, 49000.0, r, 96000.0, r]);
        let mut job = Job::Vocoder(v);
        let y = run_job(&mut job, &x, 8192);
        let f1 = measure_freq(&y[0][10000..40000], rate);
        let f2 = measure_freq(&y[0][60000..90000], rate);
        assert!((f1 / 400.0 - 1.0).abs() < 0.003, "{f1}");
        assert!((f2 / (400.0 * r) - 1.0).abs() < 0.003, "{f2}");
    }

    #[test]
    fn wsola_stretches_speechlike_audio() {
        let rate = 48000.0;
        let x = vec![sine(220.0, rate, 48000, 0.5)];
        for alpha in [0.7, 1.6] {
            let mut job = Job::Wsola(Wsola::new(1, rate, alpha), None);
            let y = run_job(&mut job, &x, 5000);
            assert_eq!(y[0].len(), (48000.0 * alpha).round() as usize);
            let mid = &y[0][y[0].len() / 4..3 * y[0].len() / 4];
            let f = measure_freq(mid, rate);
            assert!((f / 220.0 - 1.0).abs() < 0.004, "alpha {alpha}: {f}");
            assert!((rms(mid) / 0.3536 - 1.0).abs() < 0.1, "alpha {alpha}: level {}", rms(mid));
        }
    }

    #[test]
    fn wsola_with_resampler_shifts_pitch() {
        let rate = 48000.0;
        let x = vec![sine(220.0, rate, 48000, 0.5)];
        let ratio = 2f32.powf(4.0 / 12.0);
        let mut job = Job::Wsola(Wsola::new(1, rate, ratio as f64), Some(Resampler::new(1, ratio)));
        let y = run_job(&mut job, &x, 6000);
        assert!((y[0].len() as i64 - 48000).abs() <= 2, "{}", y[0].len());
        let f = measure_freq(&y[0][12000..36000], rate);
        assert!((f / (220.0 * ratio) - 1.0).abs() < 0.004, "{f}");
    }

    #[test]
    fn resampler_varispeed() {
        let rate = 48000.0;
        let x = vec![sine(500.0, rate, 48000, 0.5)];
        let mut job = Job::Resample(Resampler::new(1, 2.0));
        let y = run_job(&mut job, &x, 4096);
        assert_eq!(y[0].len(), 24000);
        let f = measure_freq(&y[0][2000..22000], rate);
        assert!((f / 1000.0 - 1.0).abs() < 0.001, "{f}");
        assert!((rms(&y[0][2000..22000]) / 0.3536 - 1.0).abs() < 0.01);
        // Slowing down keeps the level and lowers the pitch.
        let mut job = Job::Resample(Resampler::new(1, 0.5));
        let y = run_job(&mut job, &x, 4096);
        assert_eq!(y[0].len(), 96000);
        let f = measure_freq(&y[0][4000..90000], rate);
        assert!((f / 250.0 - 1.0).abs() < 0.001, "{f}");
    }

    #[test]
    fn resampler_suppresses_aliasing_when_speeding_up() {
        let rate = 48000.0;
        // 15 kHz at double speed would alias to 18 kHz; the kernel removes it.
        let x = vec![sine(15000.0, rate, 48000, 0.5)];
        let mut job = Job::Resample(Resampler::new(1, 2.0));
        let y = run_job(&mut job, &x, 4096);
        assert!(rms(&y[0][2000..22000]) < 0.01, "{}", rms(&y[0][2000..22000]));
    }

    #[test]
    fn longer_kernels_resample_more_cleanly() {
        let rate = 48000.0;
        // A 15 kHz tone slowed by a fifth: short kernels leave more error near the band edge.
        let x = vec![sine(15000.0, rate, 48000, 0.5)];
        let speed = 2f32.powf(-7.0 / 12.0);
        let err = |zeros: usize| {
            let mut job = Job::Resample(Resampler::with_zeros(1, speed, zeros));
            let y = run_job(&mut job, &x, 4096);
            let want = sine(15000.0 * speed, rate, y[0].len(), 0.5);
            let d: Vec<f32> = (8000..60000).map(|i| y[0][i] - want[i]).collect();
            rms(&d)
        };
        let (low, high, perfect) = (err(2), err(8), err(32));
        assert!(low > high * 2.0 && high > perfect, "{low} {high} {perfect}");
    }

    #[test]
    fn chunking_does_not_change_output() {
        let rate = 48000.0;
        let x = vec![crate::fx::testutil::noise(30000, 0.5, 9)];
        let a = run_job(&mut Job::Vocoder(Vocoder::new(1, rate, 0, 1.3, 1.2, true, false)), &x, 30000);
        let b = run_job(&mut Job::Vocoder(Vocoder::new(1, rate, 0, 1.3, 1.2, true, false)), &x, 1000);
        assert_eq!(a[0].len(), b[0].len());
        for i in 0..a[0].len() {
            assert!((a[0][i] - b[0][i]).abs() < 1e-6);
        }
    }

    #[test]
    fn drop_before_past_the_pushed_frames_keeps_later_frames_in_place() {
        let mut input = Input::new(1);
        let frames = 70_000;
        let x: Vec<f32> = (0..frames).map(|i| i as f32).collect();
        input.push(&x, frames);
        // A read position ahead of everything pushed (extreme stretch) must not panic.
        input.drop_before(200_000);
        assert_eq!(input.base, frames as i64);
        input.push(&[7.0, 8.0], 2);
        assert_eq!(input.at(0, frames as i64), 7.0);
        assert_eq!(input.at(0, frames as i64 + 1), 8.0);
        assert_eq!(input.at(0, 10), 0.0);
    }
}
