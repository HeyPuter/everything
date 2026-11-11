//! Effect group: Filter and EQ (kinds 10..29).
//!
//!   10 parametricEq      11 graphicEq10   12 graphicEq20   13 graphicEq30
//!   14 notchFilter       15 scientificFilter                16 fftFilter
//!
//! Shared here: a multichannel biquad cascade, sub-block parameter smoothing
//! and frequency curve evaluation (also used by the stereo group).

mod design;
mod fft_filter;
mod graphic;
mod notch;
mod parametric;
mod scientific;

use super::util::{sanitize, Coefs};
use super::{Effect, Smooth};

pub fn create(kind: u32, rate: f32, channels: usize) -> Option<Box<dyn Effect>> {
    Some(match kind {
        10 => Box::new(parametric::ParametricEq::new(rate, channels)),
        11 => Box::new(graphic::GraphicEq::new(rate, channels, graphic::Spacing::Octave)),
        12 => Box::new(graphic::GraphicEq::new(rate, channels, graphic::Spacing::HalfOctave)),
        13 => Box::new(graphic::GraphicEq::new(rate, channels, graphic::Spacing::ThirdOctave)),
        14 => Box::new(notch::NotchFilter::new(rate, channels)),
        15 => Box::new(scientific::ScientificFilter::new(rate, channels)),
        16 => Box::new(fft_filter::FftFilter::new(rate, channels)),
        _ => return None,
    })
}

/// Frames per coefficient update while parameters glide.
pub(crate) const SUB: usize = 32;

/// How a parameter glides: linearly, in the log domain (frequencies, Q) or
/// not at all (switches and choices).
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Glide {
    Lin,
    Log,
    Step,
}

/// Parameter values smoothed at the coefficient update rate (one step per
/// `SUB` frames, about 30 ms to settle). The first values set before any
/// audio is processed apply immediately.
pub(crate) struct SmoothParams {
    pub raw: Vec<f32>,
    sm: Vec<Smooth>,
    glide: Vec<Glide>,
    fresh: bool,
    dirty: bool,
}

impl SmoothParams {
    pub fn new(rate: f32, spec: &[(f32, Glide)]) -> SmoothParams {
        let block_rate = rate / SUB as f32;
        let sm = spec.iter().map(|&(v, g)| Smooth::new(if g == Glide::Log { v.max(1e-3).log2() } else { v }, block_rate, 30.0)).collect();
        SmoothParams { raw: spec.iter().map(|s| s.0).collect(), sm, glide: spec.iter().map(|s| s.1).collect(), fresh: true, dirty: true }
    }

    pub fn set(&mut self, i: usize, v: f32) {
        if i >= self.raw.len() || !v.is_finite() {
            return;
        }
        self.raw[i] = v;
        let t = match self.glide[i] {
            Glide::Log => v.max(1e-3).log2(),
            _ => v,
        };
        if self.fresh || self.glide[i] == Glide::Step {
            self.sm[i].jump(t);
        } else {
            self.sm[i].target = t;
        }
        self.dirty = true;
    }

    /// Current (smoothed) value of parameter `i`.
    #[inline]
    pub fn get(&self, i: usize) -> f32 {
        match self.glide[i] {
            Glide::Log => self.sm[i].value.exp2(),
            Glide::Lin => self.sm[i].value,
            Glide::Step => self.raw[i],
        }
    }

    pub fn on(&self, i: usize) -> bool {
        self.raw[i] >= 0.5
    }

    /// Steps the glide once; true when coefficients should be recomputed.
    pub fn advance(&mut self) -> bool {
        self.fresh = false;
        let mut need = self.dirty;
        self.dirty = false;
        for s in &mut self.sm {
            if !s.settled() {
                s.next();
                need = true;
            }
        }
        need
    }

    /// Jumps every value to its target.
    pub fn settle(&mut self) {
        for s in &mut self.sm {
            s.settle();
        }
        self.dirty = true;
    }
}

/// Below this distance of a section's poles from DC (|1 + a1 + a2|, or from
/// Nyquist, |1 - a1 + a2|) f32 cannot resolve its coefficients: a 10 Hz shelf
/// at 192 kHz has 1 + a1 + a2 near 1e-7, under the f32 step at 2 (1.2e-7).
/// Sections above it (bells and shelves from about 60 Hz at 48 kHz, 240 Hz at
/// 192 kHz) keep the f32 path unchanged.
const ILL_CONDITIONED: f64 = 1e-4;

/// Whether a section needs double-precision coefficients and state.
#[inline]
fn ill_conditioned(k: &Coefs) -> bool {
    let w = &k.wide;
    k.wide_ok() && ((1.0 + w[3] + w[4]).abs() < ILL_CONDITIONED || (1.0 - w[3] + w[4]).abs() < ILL_CONDITIONED)
}

/// A section's coefficients in double precision: the designed values when
/// they are current, else the f32 ones.
#[inline]
fn wide_coefs(k: &Coefs) -> (f64, f64, f64, f64, f64) {
    if k.wide_ok() {
        let w = &k.wide;
        (w[0], w[1], w[2], w[3], w[4])
    } else {
        (k.b0 as f64, k.b1 as f64, k.b2 as f64, k.a1 as f64, k.a2 as f64)
    }
}

/// A bank of biquad stages run in series on every channel. Stages that are
/// off are skipped entirely. The state lives here (not in util::Biquad) so the
/// inner loop keeps it in registers. Sections whose poles sit very close to
/// DC or Nyquist (ill_conditioned) run in double precision with their
/// designed coefficients even outside Ultra-Quiet.
pub(crate) struct Cascade {
    pub coefs: Vec<Coefs>,
    pub on: Vec<bool>,
    /// [channel][stage] = (z1, z2), transposed direct form II.
    state: Vec<Vec<(f32, f32)>>,
    /// Ultra-quiet: double-precision state per [channel][stage] while on.
    wide: Option<Vec<Vec<(f64, f64)>>>,
    /// Double-precision state per [channel][stage] of ill-conditioned sections.
    deep: Vec<Vec<(f64, f64)>>,
    /// Per stage: whether its state currently lives in `deep`.
    deep_on: Vec<bool>,
}

impl Cascade {
    pub fn new(channels: usize, stages: usize) -> Cascade {
        Cascade {
            coefs: vec![Coefs::IDENTITY; stages],
            on: vec![false; stages],
            state: vec![vec![(0.0, 0.0); stages]; channels],
            wide: None,
            deep: vec![vec![(0.0, 0.0); stages]; channels],
            deep_on: vec![false; stages],
        }
    }

    /// Switches double-precision filtering (Ultra-Quiet) on or off; clears the state on a change.
    pub fn set_precise(&mut self, on: bool) {
        if on == self.wide.is_some() {
            return;
        }
        self.wide = if on { Some(vec![vec![(0.0, 0.0); self.coefs.len()]; self.state.len()]) } else { None };
        self.reset();
    }

    /// Coefficients are read directly at run time; kept for call-site clarity.
    #[inline]
    pub fn commit(&mut self) {}

    /// Like `run`, with the arithmetic and the filter state in double
    /// precision (`wide`: [channel][stage] state): a far lower noise floor
    /// for deep, narrow or very low filters, at about twice the cost.
    fn run_precise(coefs: &[Coefs], on: &[bool], wide: &mut [Vec<(f64, f64)>], buf: &mut [f32], frames: usize, at: usize, len: usize) {
        for (c, ch) in wide.iter_mut().enumerate() {
            if (c + 1) * frames > buf.len() {
                break;
            }
            let x = &mut buf[c * frames + at..c * frames + at + len];
            let mut acc = [0f64; SUB];
            for (a, v) in acc.iter_mut().zip(x.iter()) {
                *a = *v as f64;
            }
            for (s, st) in ch.iter_mut().enumerate() {
                if !on[s] {
                    continue;
                }
                let (b0, b1, b2, a1, a2) = wide_coefs(&coefs[s]);
                let (mut z1, mut z2) = *st;
                for v in acc[..len].iter_mut() {
                    let i = *v;
                    let y = b0 * i + z1;
                    z1 = b1 * i - a1 * y + z2;
                    z2 = b2 * i - a2 * y;
                    *v = y;
                }
                *st = (if z1.is_finite() { z1 } else { 0.0 }, if z2.is_finite() { z2 } else { 0.0 });
            }
            for (v, a) in x.iter_mut().zip(acc.iter()) {
                *v = *a as f32;
            }
        }
    }

    /// Filters frames [at, at + len) of each channel of planar `buf`.
    pub fn run(&mut self, buf: &mut [f32], frames: usize, at: usize, len: usize) {
        if let Some(w) = &mut self.wide {
            Self::run_precise(&self.coefs, &self.on, w, buf, frames, at, len);
            return;
        }
        // Move a section's state between f32 and f64 when it changes precision.
        for s in 0..self.coefs.len() {
            let deep = self.on[s] && ill_conditioned(&self.coefs[s]);
            if deep != self.deep_on[s] {
                for (st, dp) in self.state.iter_mut().zip(self.deep.iter_mut()) {
                    if deep {
                        dp[s] = (st[s].0 as f64, st[s].1 as f64);
                    } else {
                        st[s] = (dp[s].0 as f32, dp[s].1 as f32);
                    }
                }
                self.deep_on[s] = deep;
            }
        }
        for (c, (ch, dch)) in self.state.iter_mut().zip(self.deep.iter_mut()).enumerate() {
            if (c + 1) * frames > buf.len() {
                break;
            }
            let x = &mut buf[c * frames + at..c * frames + at + len];
            for (s, st) in ch.iter_mut().enumerate() {
                if !self.on[s] {
                    continue;
                }
                if self.deep_on[s] {
                    let (b0, b1, b2, a1, a2) = wide_coefs(&self.coefs[s]);
                    let (mut z1, mut z2) = dch[s];
                    for v in x.iter_mut() {
                        let i = *v as f64;
                        let y = b0 * i + z1;
                        z1 = b1 * i - a1 * y + z2;
                        z2 = b2 * i - a2 * y;
                        *v = y as f32;
                    }
                    dch[s] = (if z1.is_finite() { z1 } else { 0.0 }, if z2.is_finite() { z2 } else { 0.0 });
                    continue;
                }
                let k = self.coefs[s];
                let (mut z1, mut z2) = *st;
                for v in x.iter_mut() {
                    let i = *v;
                    let y = k.b0 * i + z1;
                    z1 = k.b1 * i - k.a1 * y + z2;
                    z2 = k.b2 * i - k.a2 * y;
                    *v = y;
                }
                *st = (z1, z2);
            }
        }
    }

    pub fn reset(&mut self) {
        for ch in &mut self.state {
            for st in ch {
                *st = (0.0, 0.0);
            }
        }
        self.deep.iter_mut().flatten().for_each(|st| *st = (0.0, 0.0));
        if let Some(w) = &mut self.wide {
            w.iter_mut().flatten().for_each(|st| *st = (0.0, 0.0));
        }
    }

    /// Resets only the state of stage `s` (when its structure changes).
    pub fn reset_stage(&mut self, s: usize) {
        for ch in &mut self.state {
            ch[s] = (0.0, 0.0);
        }
        for ch in &mut self.deep {
            ch[s] = (0.0, 0.0);
        }
        if let Some(w) = &mut self.wide {
            for ch in w {
                ch[s] = (0.0, 0.0);
            }
        }
    }

    /// Flushes denormal and non-finite state; call once per block.
    pub fn flush(&mut self) {
        for ch in &mut self.state {
            for st in ch {
                *st = (sanitize(st.0), sanitize(st.1));
            }
        }
        let tiny = |v: f64| if v.abs() < 1e-30 { 0.0 } else { v };
        for st in self.deep.iter_mut().flatten() {
            *st = (tiny(st.0), tiny(st.1));
        }
    }

    /// Product of the active stages' magnitudes at `f` (linear).
    #[cfg(test)]
    pub fn magnitude(&self, f: f32, rate: f32) -> f32 {
        self.coefs.iter().zip(&self.on).filter(|(_, &on)| on).map(|(c, _)| c.magnitude(f, rate)).product()
    }
}

/// Butterworth sections for an order-`n` low or high pass (n = 1..8): fills
/// `out` with the Q of each second-order section, and returns
/// (number of second-order sections, whether a first-order section is needed).
pub(crate) fn butterworth_sections(n: usize, out: &mut [f32; 4]) -> (usize, bool) {
    let n = n.clamp(1, 8);
    let pairs = n / 2;
    for k in 0..pairs {
        // Angle of each pole pair from the negative real axis.
        let psi = if n % 2 == 0 {
            std::f32::consts::PI * (2 * k + 1) as f32 / (2 * n) as f32
        } else {
            std::f32::consts::PI * (k + 1) as f32 / n as f32
        };
        out[k] = 1.0 / (2.0 * psi.cos());
    }
    (pairs, n % 2 == 1)
}

/// Fills up to 4 stages of a Butterworth pass filter starting at `first`.
pub(crate) fn butterworth_stages(coefs: &mut [Coefs], on: &mut [bool], first: usize, rate: f32, f: f32, order: usize, high: bool, enabled: bool) {
    let mut qs = [0.0f32; 4];
    let (pairs, odd) = butterworth_sections(order, &mut qs);
    for s in 0..4 {
        let i = first + s;
        if !enabled {
            on[i] = false;
            continue;
        }
        if s < pairs {
            coefs[i] = if high { Coefs::highpass(rate, f, qs[s]) } else { Coefs::lowpass(rate, f, qs[s]) };
            on[i] = true;
        } else if s == pairs && odd {
            coefs[i] = if high { Coefs::highpass1(rate, f) } else { Coefs::lowpass1(rate, f) };
            on[i] = true;
        } else {
            on[i] = false;
        }
    }
}

/// Evaluates a packed curve [f0, g0, f1, g1, ...] (sorted by f) at `f`,
/// interpolating linearly against log frequency (`log`) or linear frequency.
/// Outside the points the end values hold. An empty curve reads 0.
pub(crate) fn curve_at(points: &[f32], f: f32, log: bool) -> f32 {
    let n = points.len() / 2;
    if n == 0 {
        return 0.0;
    }
    if f <= points[0] {
        return points[1];
    }
    if f >= points[2 * (n - 1)] {
        return points[2 * n - 1];
    }
    let mut i = 1;
    while i < n && points[2 * i] < f {
        i += 1;
    }
    let (f0, g0, f1, g1) = (points[2 * i - 2], points[2 * i - 1], points[2 * i], points[2 * i + 1]);
    let t = if log && f0 > 0.0 {
        (f / f0).ln() / (f1 / f0).ln().max(1e-9)
    } else {
        (f - f0) / (f1 - f0).max(1e-9)
    };
    g0 + (g1 - g0) * t.clamp(0.0, 1.0)
}

/// Fills `out[k]` (one per FFT bin of an `n`-point transform) with the curve
/// value at the bin frequency.
pub(crate) fn curve_bins(points: &[f32], n: usize, rate: f32, log: bool, out: &mut [f32]) {
    let bins = n / 2 + 1;
    for k in 0..bins.min(out.len()) {
        let f = k as f32 * rate / n as f32;
        // DC takes the lowest point's value.
        out[k] = curve_at(points, if k == 0 { 0.0 } else { f }, log);
    }
}

/// Sorts a packed curve by frequency and drops non-finite points (copies).
pub(crate) fn clean_curve(data: &[f32]) -> Vec<f32> {
    let mut pts: Vec<(f32, f32)> = data.chunks_exact(2).filter(|p| p[0].is_finite() && p[1].is_finite()).map(|p| (p[0].max(0.0), p[1])).collect();
    pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    pts.into_iter().flat_map(|(f, g)| [f, g]).collect()
}

/// FFT size from a parameter value: the nearest power of two in [min, max].
pub(crate) fn fft_size(v: f32, min: usize, max: usize) -> usize {
    let v = if v.is_finite() { v.max(1.0) } else { 4096.0 };
    let p = v.log2().round().clamp(min.trailing_zeros() as f32, max.trailing_zeros() as f32);
    1usize << (p as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fx::util::gain_to_db;

    #[test]
    fn butterworth_q_values() {
        let mut q = [0.0; 4];
        assert_eq!(butterworth_sections(2, &mut q), (1, false));
        assert!((q[0] - 0.7071).abs() < 1e-3);
        assert_eq!(butterworth_sections(3, &mut q), (1, true));
        assert!((q[0] - 1.0).abs() < 1e-3);
        assert_eq!(butterworth_sections(4, &mut q), (2, false));
        assert!((q[0] - 0.5412).abs() < 1e-3 && (q[1] - 1.3066).abs() < 1e-3);
    }

    #[test]
    fn butterworth_cascade_is_3db_at_cutoff_for_all_orders() {
        let r = 48000.0;
        for order in [1, 2, 3, 4, 6, 8] {
            for high in [false, true] {
                let mut c = Cascade::new(1, 4);
                butterworth_stages(&mut c.coefs, &mut c.on, 0, r, 1000.0, order, high, true);
                let db = gain_to_db(c.magnitude(1000.0, r));
                assert!((db + 3.01).abs() < 0.05, "order {order} high {high}: {db}");
                // Slope: one octave past the cutoff falls about 6 dB per order.
                let far = gain_to_db(c.magnitude(if high { 250.0 } else { 4000.0 }, r));
                assert!(far < -5.5 * order as f32, "order {order} high {high}: {far}");
            }
        }
    }

    #[test]
    fn curve_interpolation() {
        let pts = [100.0, 0.0, 1000.0, -12.0, 10000.0, 6.0];
        assert_eq!(curve_at(&pts, 50.0, true), 0.0);
        assert!((curve_at(&pts, 316.227_77, true) + 6.0).abs() < 1e-3);
        assert!((curve_at(&pts, 550.0, false) + 6.0).abs() < 1e-3);
        assert_eq!(curve_at(&pts, 20000.0, true), 6.0);
        assert_eq!(curve_at(&[], 1000.0, true), 0.0);
        assert_eq!(clean_curve(&[1000.0, 1.0, 10.0, 2.0, f32::NAN, 0.0]), vec![10.0, 2.0, 1000.0, 1.0]);
        assert_eq!(fft_size(3000.0, 512, 16384), 4096);
        assert_eq!(fft_size(1e9, 512, 16384), 16384);
    }
}
