//! Autoregressive modelling for click and clip repair: Burg estimation over
//! one or two context segments and least-squares AR interpolation (LSAR,
//! Janssen/Vaseghi) of a gap, solved with a banded Cholesky factorisation.
//! `Lsar` owns all scratch memory, so repairs never allocate.

pub struct Lsar {
    pub max_gap: usize,
    pub max_order: usize,
    pub a: Vec<f64>,
    f: Vec<f64>,
    b: Vec<f64>,
    band: Vec<f64>,
    rhs: Vec<f64>,
    ek: Vec<f64>,
    ra: Vec<f64>,
}

impl Lsar {
    /// `max_ctx` is the most context samples (both sides together) used for estimation.
    pub fn new(max_gap: usize, max_order: usize, max_ctx: usize) -> Lsar {
        Lsar {
            max_gap,
            max_order,
            a: vec![0.0; max_order + 1],
            f: vec![0.0; max_ctx],
            b: vec![0.0; max_ctx],
            band: vec![0.0; max_gap * (max_order + 1)],
            rhs: vec![0.0; max_gap],
            ek: vec![0.0; max_gap + max_order],
            ra: vec![0.0; max_order + 1],
        }
    }

    /// Burg estimate of order `p` over up to two segments (the context on each
    /// side of a gap); writes the prediction error filter to `self.a`
    /// (a[0] = 1, e[n] = sum a[k] x[n - k]). Returns the actual order used.
    pub fn burg(&mut self, left: &[f32], right: &[f32], p: usize) -> usize {
        let segs = [left, right];
        let total = (left.len() + right.len()).min(self.f.len());
        let nl = left.len().min(total);
        let nr = total - nl;
        let lens = [nl, nr];
        let offs = [0, nl];
        for (s, seg) in segs.iter().enumerate() {
            for i in 0..lens[s] {
                // Left context: the samples nearest the gap are its tail; right: its head.
                let v = if s == 0 { seg[seg.len() - lens[s] + i] } else { seg[i] } as f64;
                self.f[offs[s] + i] = v;
                self.b[offs[s] + i] = v;
            }
        }
        let p = p.min(self.max_order).min(nl.max(nr).saturating_sub(1));
        for v in self.a.iter_mut() {
            *v = 0.0;
        }
        self.a[0] = 1.0;
        for k in 0..p {
            let (mut num, mut den) = (0.0f64, 0.0f64);
            for s in 0..2 {
                let (o, n) = (offs[s], lens[s]);
                if n < k + 2 {
                    continue;
                }
                for i in 0..n - k - 1 {
                    let fv = self.f[o + i + k + 1];
                    let bv = self.b[o + i];
                    num += fv * bv;
                    den += fv * fv + bv * bv;
                }
            }
            if den <= 1e-30 {
                return k;
            }
            let mu = -2.0 * num / den;
            let mut i = 0;
            while i <= (k + 1) / 2 {
                let j = k + 1 - i;
                let t1 = self.a[i] + mu * self.a[j];
                let t2 = self.a[j] + mu * self.a[i];
                self.a[i] = t1;
                self.a[j] = t2;
                i += 1;
            }
            for s in 0..2 {
                let (o, n) = (offs[s], lens[s]);
                if n < k + 2 {
                    continue;
                }
                for i in 0..n - k - 1 {
                    let fv = self.f[o + i + k + 1];
                    let bv = self.b[o + i];
                    self.f[o + i + k + 1] = fv + mu * bv;
                    self.b[o + i] = bv + mu * fv;
                }
            }
        }
        p
    }

    /// Replaces x[s .. s + l] by the least-squares AR interpolation with the
    /// filter in `self.a` of order `p`. Needs x[s - p ..] and x[.. s + l + p].
    pub fn interpolate(&mut self, x: &mut [f32], s: usize, l: usize, p: usize) -> bool {
        if l == 0 || l > self.max_gap || s < p || s + l + p > x.len() {
            return false;
        }
        let a = &self.a;
        let w = p + 1;
        // Autocorrelation of the filter.
        for m in 0..=p {
            let mut r = 0.0;
            for k in 0..=p - m {
                r += a[k] * a[k + m];
            }
            self.ra[m] = r;
        }
        // Known-sample part of each error term e[n], n in s .. s + l + p.
        for j in 0..l + p {
            let n = s + j;
            let mut e = 0.0;
            for k in 0..=p {
                let idx = n - k;
                if idx < s || idx >= s + l {
                    e += a[k] * x[idx] as f64;
                }
            }
            self.ek[j] = e;
        }
        for i in 0..l {
            let mut r = 0.0;
            for k in 0..=p {
                r += a[k] * self.ek[i + k];
            }
            self.rhs[i] = -r;
        }
        // Banded Cholesky of the Toeplitz matrix M[i][j] = ra[|i - j|].
        let reg = 1e-9 * self.ra[0].max(1e-30);
        for i in 0..l {
            let j0 = i.saturating_sub(p);
            for j in j0..=i {
                let d = i - j;
                let mut sum = self.ra[d] + if d == 0 { reg } else { 0.0 };
                let k0 = j0.max(j.saturating_sub(p));
                for k in k0..j {
                    sum -= self.band[i * w + (i - k)] * self.band[j * w + (j - k)];
                }
                if i == j {
                    if sum <= 0.0 {
                        return false;
                    }
                    self.band[i * w] = sum.sqrt();
                } else {
                    self.band[i * w + d] = sum / self.band[j * w];
                }
            }
        }
        // Forward then back substitution, in place in rhs.
        for i in 0..l {
            let mut v = self.rhs[i];
            for k in i.saturating_sub(p)..i {
                v -= self.band[i * w + (i - k)] * self.rhs[k];
            }
            self.rhs[i] = v / self.band[i * w];
        }
        for i in (0..l).rev() {
            let mut v = self.rhs[i];
            for k in i + 1..(i + p + 1).min(l) {
                v -= self.band[k * w + (k - i)] * self.rhs[k];
            }
            self.rhs[i] = v / self.band[i * w];
        }
        for i in 0..l {
            let v = self.rhs[i] as f32;
            x[s + i] = if v.is_finite() { v } else { 0.0 };
        }
        true
    }

    /// Estimates a model from the context around x[s .. s + l] (up to `ctx`
    /// samples each side) and interpolates the gap. Returns false when the
    /// context is too short.
    pub fn repair(&mut self, x: &mut [f32], s: usize, l: usize, order: usize, ctx: usize) -> bool {
        let left0 = s.saturating_sub(ctx);
        let right1 = (s + l + ctx).min(x.len());
        let p = {
            let (left, rest) = x.split_at(s);
            let right = &rest[l.min(rest.len())..right1 - s];
            self.burg(&left[left0..], right, order)
        };
        if p == 0 && s >= 1 && s + l < x.len() {
            // No model to fit (the surroundings are digital silence): a straight
            // line between the samples either side, so a click in silence still goes.
            let (a, b) = (x[s - 1], x[s + l]);
            for i in 0..l {
                x[s + i] = a + (b - a) * (i + 1) as f32 / (l + 1) as f32;
            }
            return true;
        }
        if p == 0 || s < p || s + l + p > x.len() {
            return false;
        }
        self.interpolate(x, s, l, p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repairs_a_click_in_digital_silence() {
        let mut x = vec![0.0f32; 2000];
        for v in &mut x[1000..1003] {
            *v = 0.5;
        }
        let mut l = Lsar::new(64, 16, 4096);
        assert!(l.repair(&mut x, 998, 7, 16, 512));
        assert!(x.iter().all(|v| v.abs() < 1e-6), "{:?}", &x[996..1008]);
    }

    #[test]
    fn burg_recovers_ar2() {
        // x[n] = 1.6 x[n-1] - 0.8 x[n-2] + noise
        let mut r = crate::fx::util::Rng(3);
        let mut x = vec![0.0f32; 4000];
        for n in 2..x.len() {
            x[n] = 1.6 * x[n - 1] - 0.8 * x[n - 2] + 0.1 * r.bipolar();
        }
        let mut l = Lsar::new(64, 16, 4096);
        let p = l.burg(&x[..2000], &x[2000..], 2);
        assert_eq!(p, 2);
        assert!((l.a[1] + 1.6).abs() < 0.05, "{}", l.a[1]);
        assert!((l.a[2] - 0.8).abs() < 0.05, "{}", l.a[2]);
    }

    #[test]
    fn interpolates_a_gap_in_music_like_signal() {
        let rate = 48000.0;
        let x: Vec<f32> = (0..3000)
            .map(|i| {
                let t = i as f32 / rate;
                0.5 * (crate::fx::util::TAU * 440.0 * t).sin() + 0.3 * (crate::fx::util::TAU * 1250.0 * t).sin()
            })
            .collect();
        let mut y = x.clone();
        for i in 1500..1540 {
            y[i] = 0.9;
        }
        let mut l = Lsar::new(256, 64, 2048);
        assert!(l.repair(&mut y, 1500, 40, 32, 512));
        let err: f32 = (1500..1540).map(|i| (y[i] - x[i]).abs()).fold(0.0, f32::max);
        assert!(err < 0.01, "max error {err}");
    }
}
