//! Building blocks shared by the effect processors: biquads (RBJ cookbook),
//! delay lines, envelope followers, compressor gain curves, a brickwall
//! lookahead limiter, Linkwitz-Riley crossovers, LFOs, a seeded noise source
//! and a multichannel STFT overlap-add engine.
//!
//! Everything here allocates only in constructors; the per-sample methods are
//! allocation free so effects stay safe inside the AudioWorklet.

use crate::fft::{RealFft, Window};

pub const TAU: f32 = std::f32::consts::TAU;
pub const PI: f32 = std::f32::consts::PI;

/// Decibels to linear gain.
#[inline]
pub fn db_to_gain(db: f32) -> f32 {
    10f32.powf(db * 0.05)
}

/// Linear gain to decibels, floored at -200 dB.
#[inline]
pub fn gain_to_db(g: f32) -> f32 {
    20.0 * g.abs().max(1e-10).log10()
}

/// One-pole smoothing coefficient for a time constant of `ms` at `rate` Hz.
#[inline]
pub fn ms_coef(ms: f32, rate: f32) -> f32 {
    if ms <= 0.0 {
        0.0
    } else {
        (-1.0 / (rate * ms * 0.001)).exp()
    }
}

/// Milliseconds to frames, rounded.
#[inline]
pub fn ms_frames(ms: f32, rate: f32) -> usize {
    (ms.max(0.0) * 0.001 * rate).round() as usize
}

/// Replaces denormals and non-finite values with zero (state hygiene).
#[inline]
pub fn sanitize(x: f32) -> f32 {
    if x.is_finite() && x.abs() > 1e-25 {
        x
    } else {
        0.0
    }
}

/// Planar channel `c` of a buffer of `frames` frames.
#[inline]
pub fn chan(buf: &mut [f32], c: usize, frames: usize) -> &mut [f32] {
    &mut buf[c * frames..(c + 1) * frames]
}

/// Biquad coefficients, normalised so a0 = 1. `wide` keeps the designed
/// values in double precision [b0, b1, b2, a1, a2]: filters with poles very
/// close to DC (a few Hz at high sample rates) need more than f32 resolution
/// (see filter::Cascade). Code that edits the f32 fields leaves `wide`
/// stale, which Cascade detects (Coefs::wide_ok).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Coefs {
    pub b0: f32,
    pub b1: f32,
    pub b2: f32,
    pub a1: f32,
    pub a2: f32,
    pub wide: [f64; 5],
}

impl Default for Coefs {
    fn default() -> Self {
        Coefs::IDENTITY
    }
}

impl Coefs {
    pub const IDENTITY: Coefs = Coefs { b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0, wide: [1.0, 0.0, 0.0, 0.0, 0.0] };

    /// Coefficients from double-precision values already normalised (a0 = 1).
    pub fn from_wide(w: [f64; 5]) -> Coefs {
        Coefs { b0: w[0] as f32, b1: w[1] as f32, b2: w[2] as f32, a1: w[3] as f32, a2: w[4] as f32, wide: w }
    }

    pub fn norm(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) -> Coefs {
        Coefs::from_wide([b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0])
    }

    /// Whether `wide` still matches the f32 coefficients (to within f32
    /// rounding), i.e. they were not edited on their own since.
    pub fn wide_ok(&self) -> bool {
        let near = |w: f64, v: f32| (w - v as f64).abs() <= 1e-6 * w.abs().max(1.0);
        let w = &self.wide;
        near(w[0], self.b0) && near(w[1], self.b1) && near(w[2], self.b2) && near(w[3], self.a1) && near(w[4], self.a2)
    }

    /// Multiplies the numerator (the section's gain) by `s`; the f32 values
    /// are scaled in f32 as before.
    pub fn scale(&mut self, s: f64) {
        let sf = s as f32;
        self.b0 *= sf;
        self.b1 *= sf;
        self.b2 *= sf;
        for w in &mut self.wide[..3] {
            *w *= s;
        }
    }

    fn w(rate: f32, f: f32) -> (f64, f64) {
        let f = (f as f64).clamp(1.0, rate as f64 * 0.4999);
        let w0 = 2.0 * std::f64::consts::PI * f / rate as f64;
        (w0.cos(), w0.sin())
    }

    pub fn lowpass(rate: f32, f: f32, q: f32) -> Coefs {
        let (c, s) = Coefs::w(rate, f);
        let alpha = s / (2.0 * q.max(0.01) as f64);
        Coefs::norm((1.0 - c) / 2.0, 1.0 - c, (1.0 - c) / 2.0, 1.0 + alpha, -2.0 * c, 1.0 - alpha)
    }

    pub fn highpass(rate: f32, f: f32, q: f32) -> Coefs {
        let (c, s) = Coefs::w(rate, f);
        let alpha = s / (2.0 * q.max(0.01) as f64);
        Coefs::norm((1.0 + c) / 2.0, -(1.0 + c), (1.0 + c) / 2.0, 1.0 + alpha, -2.0 * c, 1.0 - alpha)
    }

    /// Band pass with 0 dB peak gain.
    pub fn bandpass(rate: f32, f: f32, q: f32) -> Coefs {
        let (c, s) = Coefs::w(rate, f);
        let alpha = s / (2.0 * q.max(0.01) as f64);
        Coefs::norm(alpha, 0.0, -alpha, 1.0 + alpha, -2.0 * c, 1.0 - alpha)
    }

    pub fn notch(rate: f32, f: f32, q: f32) -> Coefs {
        let (c, s) = Coefs::w(rate, f);
        let alpha = s / (2.0 * q.max(0.01) as f64);
        Coefs::norm(1.0, -2.0 * c, 1.0, 1.0 + alpha, -2.0 * c, 1.0 - alpha)
    }

    pub fn allpass(rate: f32, f: f32, q: f32) -> Coefs {
        let (c, s) = Coefs::w(rate, f);
        let alpha = s / (2.0 * q.max(0.01) as f64);
        Coefs::norm(1.0 - alpha, -2.0 * c, 1.0 + alpha, 1.0 + alpha, -2.0 * c, 1.0 - alpha)
    }

    /// Peaking (bell) filter. `q` is the RBJ Q; see `peaking_cq` for constant-Q.
    pub fn peaking(rate: f32, f: f32, q: f32, gain_db: f32) -> Coefs {
        let (c, s) = Coefs::w(rate, f);
        let a = 10f64.powf(gain_db as f64 / 40.0);
        let alpha = s / (2.0 * q.max(0.01) as f64);
        Coefs::norm(1.0 + alpha * a, -2.0 * c, 1.0 - alpha * a, 1.0 + alpha / a, -2.0 * c, 1.0 - alpha / a)
    }

    /// Constant-Q peaking filter: the bandwidth is the same for boosts and
    /// cuts, and a cut exactly inverts the matching boost.
    pub fn peaking_cq(rate: f32, f: f32, q: f32, gain_db: f32) -> Coefs {
        let (c, s) = Coefs::w(rate, f);
        let g = 10f64.powf(gain_db.abs() as f64 / 20.0);
        let alpha = s / (2.0 * q.max(0.01) as f64);
        if gain_db >= 0.0 {
            Coefs::norm(1.0 + alpha * g, -2.0 * c, 1.0 - alpha * g, 1.0 + alpha, -2.0 * c, 1.0 - alpha)
        } else {
            Coefs::norm(1.0 + alpha, -2.0 * c, 1.0 - alpha, 1.0 + alpha * g, -2.0 * c, 1.0 - alpha * g)
        }
    }

    /// Low shelf; `q` of 0.7071 gives the steepest monotonic slope.
    pub fn low_shelf(rate: f32, f: f32, q: f32, gain_db: f32) -> Coefs {
        let (c, s) = Coefs::w(rate, f);
        let a = 10f64.powf(gain_db as f64 / 40.0);
        let alpha = s / (2.0 * q.max(0.01) as f64);
        let sa = 2.0 * a.sqrt() * alpha;
        Coefs::norm(
            a * ((a + 1.0) - (a - 1.0) * c + sa),
            2.0 * a * ((a - 1.0) - (a + 1.0) * c),
            a * ((a + 1.0) - (a - 1.0) * c - sa),
            (a + 1.0) + (a - 1.0) * c + sa,
            -2.0 * ((a - 1.0) + (a + 1.0) * c),
            (a + 1.0) + (a - 1.0) * c - sa,
        )
    }

    pub fn high_shelf(rate: f32, f: f32, q: f32, gain_db: f32) -> Coefs {
        let (c, s) = Coefs::w(rate, f);
        let a = 10f64.powf(gain_db as f64 / 40.0);
        let alpha = s / (2.0 * q.max(0.01) as f64);
        let sa = 2.0 * a.sqrt() * alpha;
        Coefs::norm(
            a * ((a + 1.0) + (a - 1.0) * c + sa),
            -2.0 * a * ((a - 1.0) + (a + 1.0) * c),
            a * ((a + 1.0) + (a - 1.0) * c - sa),
            (a + 1.0) - (a - 1.0) * c + sa,
            2.0 * ((a - 1.0) - (a + 1.0) * c),
            (a + 1.0) - (a - 1.0) * c - sa,
        )
    }

    /// First-order low pass (bilinear, matched at `f`).
    pub fn lowpass1(rate: f32, f: f32) -> Coefs {
        let k = (std::f64::consts::PI * (f as f64).clamp(1.0, rate as f64 * 0.4999) / rate as f64).tan();
        Coefs::norm(k, k, 0.0, 1.0 + k, k - 1.0, 0.0)
    }

    pub fn highpass1(rate: f32, f: f32) -> Coefs {
        let k = (std::f64::consts::PI * (f as f64).clamp(1.0, rate as f64 * 0.4999) / rate as f64).tan();
        Coefs::norm(1.0, -1.0, 0.0, 1.0 + k, k - 1.0, 0.0)
    }

    /// First-order all pass with its 90 degree point at `f`.
    pub fn allpass1(rate: f32, f: f32) -> Coefs {
        let k = (std::f64::consts::PI * (f as f64).clamp(1.0, rate as f64 * 0.4999) / rate as f64).tan();
        let a = (k - 1.0) / (k + 1.0);
        Coefs::from_wide([a, 1.0, 0.0, a, 0.0])
    }

    /// Magnitude response at `f` Hz (linear) of the double-precision design.
    #[cfg(test)]
    pub fn magnitude_wide(&self, f: f32, rate: f32) -> f32 {
        let w = 2.0 * std::f64::consts::PI * f as f64 / rate as f64;
        let k = &self.wide;
        let (c1, s1) = (w.cos(), -w.sin());
        let (c2, s2) = ((2.0 * w).cos(), -(2.0 * w).sin());
        let (nr, ni) = (k[0] + k[1] * c1 + k[2] * c2, k[1] * s1 + k[2] * s2);
        let (dr, di) = (1.0 + k[3] * c1 + k[4] * c2, k[3] * s1 + k[4] * s2);
        ((nr * nr + ni * ni) / (dr * dr + di * di).max(1e-30)).sqrt() as f32
    }

    /// Magnitude response at `f` Hz (linear).
    pub fn magnitude(&self, f: f32, rate: f32) -> f32 {
        let w = 2.0 * std::f64::consts::PI * f as f64 / rate as f64;
        let (c1, s1) = (w.cos(), -w.sin());
        let (c2, s2) = ((2.0 * w).cos(), -(2.0 * w).sin());
        let nr = self.b0 as f64 + self.b1 as f64 * c1 + self.b2 as f64 * c2;
        let ni = self.b1 as f64 * s1 + self.b2 as f64 * s2;
        let dr = 1.0 + self.a1 as f64 * c1 + self.a2 as f64 * c2;
        let di = self.a1 as f64 * s1 + self.a2 as f64 * s2;
        ((nr * nr + ni * ni) / (dr * dr + di * di).max(1e-30)).sqrt() as f32
    }
}

/// Transposed direct form II biquad.
#[derive(Clone, Copy, Default, Debug)]
pub struct Biquad {
    pub c: Coefs,
    z1: f32,
    z2: f32,
}

impl Biquad {
    pub fn new(c: Coefs) -> Biquad {
        Biquad { c, z1: 0.0, z2: 0.0 }
    }
    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let c = &self.c;
        let y = c.b0 * x + self.z1;
        self.z1 = c.b1 * x - c.a1 * y + self.z2;
        self.z2 = c.b2 * x - c.a2 * y;
        y
    }
    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }
    /// Flushes denormal state; call once per block.
    pub fn flush(&mut self) {
        self.z1 = sanitize(self.z1);
        self.z2 = sanitize(self.z2);
    }
}

/// Butterworth Q values for each biquad section of an order-`n` filter
/// (n even; odd orders add one first-order section, not covered here).
pub fn butterworth_qs(n: usize) -> impl Iterator<Item = f32> {
    (0..n / 2).map(move |k| {
        let theta = PI * (2 * k + 1) as f32 / (2 * n) as f32;
        1.0 / (2.0 * theta.sin())
    })
}

/// Power-of-two ring delay line with integer and interpolated taps.
pub struct DelayLine {
    buf: Vec<f32>,
    mask: usize,
    pos: usize,
}

impl DelayLine {
    /// A delay line able to delay by up to `max` frames.
    pub fn new(max: usize) -> DelayLine {
        let n = (max + 4).next_power_of_two();
        DelayLine { buf: vec![0.0; n], mask: n - 1, pos: 0 }
    }
    pub fn capacity(&self) -> usize {
        self.buf.len() - 4
    }
    #[inline]
    pub fn push(&mut self, x: f32) {
        self.pos = (self.pos + 1) & self.mask;
        self.buf[self.pos] = x;
    }
    /// The sample pushed `d` pushes ago (0 = the latest).
    #[inline]
    pub fn tap(&self, d: usize) -> f32 {
        self.buf[(self.pos.wrapping_sub(d)) & self.mask]
    }
    /// Linearly interpolated fractional tap.
    #[inline]
    pub fn tap_linear(&self, d: f32) -> f32 {
        let d = d.max(0.0);
        let i = d as usize;
        let f = d - i as f32;
        let a = self.tap(i);
        let b = self.tap(i + 1);
        a + (b - a) * f
    }
    /// 4-point Hermite interpolated tap (for modulated delays).
    #[inline]
    pub fn tap_cubic(&self, d: f32) -> f32 {
        let d = d.max(1.0);
        let i = d as usize;
        let f = d - i as f32;
        let xm1 = self.tap(i - 1);
        let x0 = self.tap(i);
        let x1 = self.tap(i + 1);
        let x2 = self.tap(i + 2);
        let c1 = 0.5 * (x1 - xm1);
        let c2 = xm1 - 2.5 * x0 + 2.0 * x1 - 0.5 * x2;
        let c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
        ((c3 * f + c2) * f + c1) * f + x0
    }
    pub fn clear(&mut self) {
        self.buf.iter_mut().for_each(|v| *v = 0.0);
    }
}

/// Peak envelope follower with separate attack and release.
#[derive(Clone, Copy, Default)]
pub struct Envelope {
    pub att: f32,
    pub rel: f32,
    pub env: f32,
}

impl Envelope {
    pub fn new(rate: f32, attack_ms: f32, release_ms: f32) -> Envelope {
        let mut e = Envelope::default();
        e.set(rate, attack_ms, release_ms);
        e
    }
    pub fn set(&mut self, rate: f32, attack_ms: f32, release_ms: f32) {
        self.att = ms_coef(attack_ms, rate);
        self.rel = ms_coef(release_ms, rate);
    }
    /// Follows a non-negative detector value.
    #[inline]
    pub fn next(&mut self, x: f32) -> f32 {
        let c = if x > self.env { self.att } else { self.rel };
        self.env = x + (self.env - x) * c;
        self.env
    }
    pub fn reset(&mut self) {
        self.env = 0.0;
    }
}

/// Static compressor curve: gain change in dB (<= 0 for compression) for an
/// input level in dB, with a soft knee of `knee` dB centred on `threshold`.
/// `ratio` >= 1; use f32::INFINITY (or a large value) for limiting.
#[inline]
pub fn compress_db(level: f32, threshold: f32, ratio: f32, knee: f32) -> f32 {
    let slope = 1.0 / ratio.max(1.0) - 1.0;
    let over = level - threshold;
    if knee > 0.0 && 2.0 * over.abs() <= knee {
        let t = over + knee * 0.5;
        slope * t * t / (2.0 * knee)
    } else if over > 0.0 {
        slope * over
    } else {
        0.0
    }
}

/// Downward expander/gate curve: gain change in dB (<= 0) below `threshold`.
#[inline]
pub fn expand_db(level: f32, threshold: f32, ratio: f32, knee: f32) -> f32 {
    let slope = ratio.max(1.0) - 1.0;
    let under = threshold - level;
    if knee > 0.0 && 2.0 * under.abs() <= knee {
        let t = under + knee * 0.5;
        -slope * t * t / (2.0 * knee)
    } else if under > 0.0 {
        -slope * under
    } else {
        0.0
    }
}

/// Brickwall lookahead limiter for up to two channels (linked detection).
/// The output never exceeds `ceiling` (sample peak): a sliding minimum of the
/// required gain over the lookahead window, release smoothing, then a boxcar
/// average over the same window, so the gain reaches its target before the
/// delayed peak arrives. Latency is `lookahead` frames.
pub struct Limiter {
    delay: [DelayLine; 2],
    look: usize,
    max_look: usize,
    // Monotonic deque of (index, gain) for the sliding minimum.
    dq_idx: Vec<u64>,
    dq_val: Vec<f32>,
    dq_head: usize,
    dq_len: usize,
    // Boxcar over the release-smoothed gain.
    box_buf: Vec<f32>,
    box_pos: usize,
    box_sum: f64,
    n: u64,
    env: f32,
    rel: f32,
    pub ceiling: f32,
    /// Last applied gain (for metering).
    pub gain: f32,
}

impl Limiter {
    pub fn new(rate: f32, max_lookahead_ms: f32) -> Limiter {
        let max_look = ms_frames(max_lookahead_ms, rate).max(1);
        let mut l = Limiter {
            delay: [DelayLine::new(max_look + 1), DelayLine::new(max_look + 1)],
            look: max_look,
            max_look,
            dq_idx: vec![0; max_look + 2],
            dq_val: vec![0.0; max_look + 2],
            dq_head: 0,
            dq_len: 0,
            box_buf: vec![1.0; max_look + 1],
            box_pos: 0,
            box_sum: 0.0,
            n: 0,
            env: 1.0,
            rel: 0.0,
            ceiling: 1.0,
            gain: 1.0,
        };
        l.set(rate, max_lookahead_ms, 50.0, 1.0);
        l.reset();
        l
    }

    /// Lookahead (clamped to the constructor maximum), release and ceiling (linear).
    pub fn set(&mut self, rate: f32, lookahead_ms: f32, release_ms: f32, ceiling: f32) {
        let look = ms_frames(lookahead_ms, rate).clamp(1, self.max_look);
        if look != self.look {
            self.look = look;
            self.reset();
        }
        self.rel = ms_coef(release_ms.max(1.0), rate);
        self.ceiling = ceiling.max(1e-6);
    }

    pub fn latency(&self) -> usize {
        self.look - 1
    }

    pub fn reset(&mut self) {
        self.delay[0].clear();
        self.delay[1].clear();
        self.dq_len = 0;
        self.dq_head = 0;
        for v in &mut self.box_buf {
            *v = 1.0;
        }
        self.box_sum = self.look as f64;
        self.box_pos = 0;
        self.env = 1.0;
        self.gain = 1.0;
    }

    /// Processes one frame (l, r); for mono pass the same value twice and
    /// read back the first.
    #[inline]
    pub fn process(&mut self, l: f32, r: f32) -> (f32, f32) {
        self.process_peak(l, r, l.abs().max(r.abs()))
    }

    /// As `process`, with the frame's detected peak given (true-peak detection).
    #[inline]
    pub fn process_peak(&mut self, l: f32, r: f32, peak: f32) -> (f32, f32) {
        let need = if peak > self.ceiling { self.ceiling / peak } else { 1.0 };
        let cap = self.dq_idx.len();
        // Sliding minimum over the last `look` frames.
        while self.dq_len > 0 {
            let back = (self.dq_head + self.dq_len - 1) % cap;
            if self.dq_val[back] >= need {
                self.dq_len -= 1;
            } else {
                break;
            }
        }
        let slot = (self.dq_head + self.dq_len) % cap;
        self.dq_idx[slot] = self.n;
        self.dq_val[slot] = need;
        self.dq_len += 1;
        let look = self.look as u64;
        while self.dq_len > 0 && self.dq_idx[self.dq_head] + look <= self.n {
            self.dq_head = (self.dq_head + 1) % cap;
            self.dq_len -= 1;
        }
        let hold = self.dq_val[self.dq_head];
        self.n += 1;
        // Instant attack, smooth release.
        self.env = if hold < self.env { hold } else { hold + (self.env - hold) * self.rel };
        // Boxcar over `look` frames.
        let old = self.box_buf[self.box_pos];
        self.box_buf[self.box_pos] = self.env;
        self.box_pos += 1;
        if self.box_pos >= self.look {
            self.box_pos = 0;
        }
        self.box_sum += self.env as f64 - old as f64;
        let g = ((self.box_sum / self.look as f64) as f32).min(1.0);
        self.gain = g;
        self.delay[0].push(l);
        self.delay[1].push(r);
        let d = self.look - 1;
        let (yl, yr) = (self.delay[0].tap(d) * g, self.delay[1].tap(d) * g);
        // Guard against float drift in the running sum.
        (yl.clamp(-self.ceiling, self.ceiling), yr.clamp(-self.ceiling, self.ceiling))
    }
}

/// Fourth-order Linkwitz-Riley crossover: low and high outputs sum to an
/// all-pass response (flat magnitude).
#[derive(Clone, Copy, Default)]
pub struct Crossover {
    lp: [Biquad; 2],
    hp: [Biquad; 2],
}

impl Crossover {
    pub fn new(rate: f32, f: f32) -> Crossover {
        let mut x = Crossover::default();
        x.set(rate, f);
        x
    }
    pub fn set(&mut self, rate: f32, f: f32) {
        let q = std::f32::consts::FRAC_1_SQRT_2;
        let lp = Coefs::lowpass(rate, f, q);
        let hp = Coefs::highpass(rate, f, q);
        for b in &mut self.lp {
            b.c = lp;
        }
        for b in &mut self.hp {
            b.c = hp;
        }
    }
    /// (low, high)
    #[inline]
    pub fn split(&mut self, x: f32) -> (f32, f32) {
        let l0 = self.lp[0].process(x);
        let l = self.lp[1].process(l0);
        let h0 = self.hp[0].process(x);
        let h = self.hp[1].process(h0);
        (l, h)
    }
    pub fn reset(&mut self) {
        for b in self.lp.iter_mut().chain(self.hp.iter_mut()) {
            b.reset();
        }
    }
    pub fn flush(&mut self) {
        for b in self.lp.iter_mut().chain(self.hp.iter_mut()) {
            b.flush();
        }
    }
}

/// Second-order all pass matching a Linkwitz-Riley 4 crossover's phase at `f`;
/// use it on bands that did not pass through that crossover so all bands stay
/// phase aligned when summed.
pub fn lr_allpass(rate: f32, f: f32) -> Coefs {
    Coefs::allpass(rate, f, std::f32::consts::FRAC_1_SQRT_2)
}

/// Phase accumulator LFO.
#[derive(Clone, Copy, Default)]
pub struct Lfo {
    pub phase: f32,
    pub inc: f32,
}

impl Lfo {
    pub fn set_rate(&mut self, hz: f32, rate: f32) {
        self.inc = hz / rate;
    }
    #[inline]
    pub fn advance(&mut self) {
        self.phase += self.inc;
        if self.phase >= 1.0 {
            self.phase -= 1.0;
        }
    }
    /// Sine in [-1, 1] at phase + `offset` cycles.
    #[inline]
    pub fn sine(&self, offset: f32) -> f32 {
        (TAU * (self.phase + offset)).sin()
    }
    /// Triangle in [-1, 1] at phase + `offset` cycles.
    #[inline]
    pub fn triangle(&self, offset: f32) -> f32 {
        let p = (self.phase + offset).rem_euclid(1.0);
        4.0 * (p - 0.5).abs() - 1.0
    }
}

/// Deterministic xorshift noise.
#[derive(Clone, Copy)]
pub struct Rng(pub u32);

impl Rng {
    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
    /// Uniform in [-1, 1).
    #[inline]
    pub fn bipolar(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 * (2.0 / 16_777_216.0) - 1.0
    }
    /// Uniform in [0, 1).
    #[inline]
    pub fn unit(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 * (1.0 / 16_777_216.0)
    }
}

/// Streaming multichannel STFT with weighted overlap-add. Every channel is
/// framed in lockstep, so a spectral callback sees all channels of the same
/// frame at once (needed for centre extraction and linked gating).
///
/// Analysis and synthesis use the same window (Hann by default), and the
/// output is normalised for the chosen overlap so an identity callback
/// reconstructs the input delayed by `latency()` frames.
pub struct Stft {
    pub n: usize,
    pub hop: usize,
    pub channels: usize,
    fft: RealFft,
    window: Vec<f32>,
    norm: f32,
    inbuf: Vec<Vec<f32>>,
    outbuf: Vec<Vec<f32>>,
    accum: Vec<Vec<f32>>,
    frame: Vec<f32>,
    /// Per-channel spectra of the current frame (n/2 + 1 bins).
    pub re: Vec<Vec<f32>>,
    pub im: Vec<Vec<f32>>,
    rover: usize,
}

impl Stft {
    /// `n` is the FFT size (power of two), `overlap` the frames per window (4 or 8).
    pub fn new(n: usize, overlap: usize, channels: usize) -> Stft {
        Stft::with_window(n, overlap, channels, Window::Hann)
    }

    pub fn with_window(n: usize, overlap: usize, channels: usize, window: Window) -> Stft {
        let hop = n / overlap.max(2);
        let w = window.build(n);
        // Sum of squared windows at one point across overlapping frames.
        let mut s = 0.0f32;
        let mut i = 0;
        while i < n {
            s += w[i] * w[i];
            i += hop;
        }
        let bins = n / 2 + 1;
        Stft {
            n,
            hop,
            channels,
            fft: RealFft::new(n),
            window: w,
            norm: 1.0 / s.max(1e-9),
            inbuf: vec![vec![0.0; n]; channels],
            outbuf: vec![vec![0.0; n]; channels],
            accum: vec![vec![0.0; 2 * n]; channels],
            frame: vec![0.0; n],
            re: vec![vec![0.0; bins]; channels],
            im: vec![vec![0.0; bins]; channels],
            rover: n - hop,
        }
    }

    pub fn bins(&self) -> usize {
        self.n / 2 + 1
    }

    /// Delay from input to output in frames (one full window).
    pub fn latency(&self) -> usize {
        self.n
    }

    pub fn reset(&mut self) {
        for c in 0..self.channels {
            self.inbuf[c].iter_mut().for_each(|v| *v = 0.0);
            self.outbuf[c].iter_mut().for_each(|v| *v = 0.0);
            self.accum[c].iter_mut().for_each(|v| *v = 0.0);
        }
        self.rover = self.n - self.hop;
    }

    /// Processes planar `buf` (`channels` x `frames`) in place. `f` is called
    /// once per hop with the spectra of every channel (`re[c]`, `im[c]`) to modify.
    pub fn process<F: FnMut(&mut [Vec<f32>], &mut [Vec<f32>])>(&mut self, buf: &mut [f32], frames: usize, mut f: F) {
        let lat = self.n - self.hop;
        let channels = self.channels.min(buf.len() / frames.max(1));
        for i in 0..frames {
            for c in 0..channels {
                let x = buf[c * frames + i];
                self.inbuf[c][self.rover] = x;
                buf[c * frames + i] = self.outbuf[c][self.rover - lat];
            }
            self.rover += 1;
            if self.rover >= self.n {
                self.rover = lat;
                self.frame_step(channels, &mut f);
            }
        }
    }

    fn frame_step<F: FnMut(&mut [Vec<f32>], &mut [Vec<f32>])>(&mut self, channels: usize, f: &mut F) {
        let n = self.n;
        let hop = self.hop;
        for c in 0..channels {
            for k in 0..n {
                self.frame[k] = self.inbuf[c][k] * self.window[k];
            }
            self.fft.forward(&self.frame, &mut self.re[c], &mut self.im[c]);
        }
        f(&mut self.re[..channels], &mut self.im[..channels]);
        for c in 0..channels {
            self.fft.inverse(&self.re[c], &self.im[c], &mut self.frame);
            let acc = &mut self.accum[c];
            for k in 0..n {
                acc[k] += self.frame[k] * self.window[k] * self.norm;
            }
            self.outbuf[c][..hop].copy_from_slice(&acc[..hop]);
            acc.copy_within(hop..2 * n, 0);
            for v in &mut acc[2 * n - hop..] {
                *v = 0.0;
            }
            self.inbuf[c].copy_within(hop..n, 0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(f: f32, rate: f32, n: usize) -> Vec<f32> {
        (0..n).map(|i| (TAU * f * i as f32 / rate).sin()).collect()
    }

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
    }

    #[test]
    fn biquad_shapes() {
        let r = 48000.0;
        let lp = Coefs::lowpass(r, 1000.0, 0.7071);
        assert!((lp.magnitude(100.0, r) - 1.0).abs() < 0.01);
        assert!((gain_to_db(lp.magnitude(1000.0, r)) + 3.01).abs() < 0.1);
        assert!(lp.magnitude(10000.0, r) < 0.02);
        let pk = Coefs::peaking(r, 2000.0, 1.0, 6.0);
        assert!((gain_to_db(pk.magnitude(2000.0, r)) - 6.0).abs() < 0.05);
        let cq_up = Coefs::peaking_cq(r, 2000.0, 2.0, 9.0);
        let cq_dn = Coefs::peaking_cq(r, 2000.0, 2.0, -9.0);
        for f in [200.0, 1500.0, 2000.0, 3000.0, 9000.0] {
            let p = cq_up.magnitude(f, r) * cq_dn.magnitude(f, r);
            assert!((p - 1.0).abs() < 1e-3, "{f} {p}");
        }
        let ls = Coefs::low_shelf(r, 200.0, 0.7071, -12.0);
        assert!((gain_to_db(ls.magnitude(20.0, r)) + 12.0).abs() < 0.2);
        assert!(gain_to_db(ls.magnitude(5000.0, r)).abs() < 0.1);
        let hs = Coefs::high_shelf(r, 4000.0, 0.7071, 6.0);
        assert!((gain_to_db(hs.magnitude(18000.0, r)) - 6.0).abs() < 0.3);
        let ap = Coefs::allpass(r, 1000.0, 0.7);
        assert!((ap.magnitude(3000.0, r) - 1.0).abs() < 1e-4);
        let n = Coefs::notch(r, 60.0, 10.0);
        assert!(n.magnitude(60.0, r) < 1e-2);
    }

    #[test]
    fn biquad_filters_signal() {
        let r = 48000.0;
        let mut b = Biquad::new(Coefs::lowpass(r, 500.0, 0.7071));
        let x = sine(8000.0, r, 4800);
        let y: Vec<f32> = x.iter().map(|&v| b.process(v)).collect();
        assert!(rms(&y[2000..]) < 0.01);
    }

    #[test]
    fn delay_taps() {
        let mut d = DelayLine::new(100);
        for i in 0..50 {
            d.push(i as f32);
        }
        assert_eq!(d.tap(0), 49.0);
        assert_eq!(d.tap(10), 39.0);
        assert!((d.tap_linear(10.5) - 38.5).abs() < 1e-6);
        assert!((d.tap_cubic(10.5) - 38.5).abs() < 1e-4);
    }

    #[test]
    fn compressor_curves() {
        assert_eq!(compress_db(-30.0, -20.0, 4.0, 0.0), 0.0);
        assert!((compress_db(-10.0, -20.0, 4.0, 0.0) + 7.5).abs() < 1e-4);
        // Soft knee is continuous at its edges.
        let k = 6.0;
        assert!((compress_db(-17.0, -20.0, 4.0, k) - compress_db(-17.0, -20.0, 4.0, 0.0)).abs() < 1e-4);
        assert!(compress_db(-23.0, -20.0, 4.0, k).abs() < 1e-4);
        assert!((expand_db(-50.0, -40.0, 2.0, 0.0) + 10.0).abs() < 1e-4);
    }

    #[test]
    fn limiter_holds_ceiling_and_reports_latency() {
        let r = 48000.0;
        let mut l = Limiter::new(r, 10.0);
        l.set(r, 5.0, 100.0, db_to_gain(-1.0));
        let x: Vec<f32> = sine(440.0, r, 48000).iter().map(|v| v * 4.0).collect();
        let mut peak = 0.0f32;
        for &v in &x {
            let (a, _) = l.process(v, v);
            peak = peak.max(a.abs());
        }
        assert!(peak <= db_to_gain(-1.0) + 1e-6);
        assert!(peak > db_to_gain(-1.5));
        assert_eq!(l.latency(), ms_frames(5.0, r) - 1);
        // Quiet signals pass unchanged (after the latency).
        let mut l = Limiter::new(r, 5.0);
        let lat = l.latency();
        let x = sine(1000.0, r, 2000);
        let y: Vec<f32> = x.iter().map(|&v| l.process(v * 0.5, v * 0.5).0).collect();
        for i in lat..2000 {
            assert!((y[i] - x[i - lat] * 0.5).abs() < 1e-5);
        }
    }

    #[test]
    fn crossover_sums_flat() {
        let r = 48000.0;
        for f in [100.0, 1000.0, 5000.0] {
            let mut x = Crossover::new(r, 1000.0);
            let s = sine(f, r, 9600);
            let y: Vec<f32> = s.iter().map(|&v| {
                let (a, b) = x.split(v);
                a + b
            }).collect();
            assert!((rms(&y[4800..]) - rms(&s[4800..])).abs() < 0.01, "{f}");
        }
    }

    #[test]
    fn stft_identity_reconstructs() {
        for overlap in [4, 8] {
            let n = 512;
            let mut st = Stft::new(n, overlap, 2);
            let frames = 4096;
            let mut buf = vec![0.0; 2 * frames];
            let src: Vec<f32> = (0..frames).map(|i| ((i * 7919) % 101) as f32 / 50.0 - 1.0).collect();
            buf[..frames].copy_from_slice(&src);
            buf[frames..].copy_from_slice(&src);
            // Odd block sizes like the worklet's.
            let mut out = Vec::new();
            let mut at = 0;
            while at < frames {
                let m = 128.min(frames - at);
                let mut blk = vec![0.0; 2 * m];
                blk[..m].copy_from_slice(&buf[at..at + m]);
                blk[m..].copy_from_slice(&buf[frames + at..frames + at + m]);
                st.process(&mut blk, m, |_, _| {});
                out.extend_from_slice(&blk[..m]);
                at += m;
            }
            let lat = st.latency();
            for i in 2 * n..frames {
                assert!((out[i] - src[i - lat]).abs() < 1e-3, "overlap {overlap} at {i}: {} vs {}", out[i], src[i - lat]);
            }
        }
    }
}
