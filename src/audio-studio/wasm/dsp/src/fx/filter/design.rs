//! Classic IIR filter design for the Scientific Filter: Butterworth,
//! Chebyshev type I and Bessel analog prototypes, frequency transformed to
//! low pass, high pass, band pass or band stop, and mapped to digital
//! second-order sections with the bilinear transform (cutoffs prewarped).

use crate::fx::util::Coefs;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct C {
    pub re: f64,
    pub im: f64,
}

impl C {
    pub const fn new(re: f64, im: f64) -> C {
        C { re, im }
    }
    fn add(self, o: C) -> C {
        C::new(self.re + o.re, self.im + o.im)
    }
    fn sub(self, o: C) -> C {
        C::new(self.re - o.re, self.im - o.im)
    }
    fn mul(self, o: C) -> C {
        C::new(self.re * o.re - self.im * o.im, self.re * o.im + self.im * o.re)
    }
    fn scale(self, k: f64) -> C {
        C::new(self.re * k, self.im * k)
    }
    fn div(self, o: C) -> C {
        let d = o.re * o.re + o.im * o.im;
        C::new((self.re * o.re + self.im * o.im) / d, (self.im * o.re - self.re * o.im) / d)
    }
    fn abs(self) -> f64 {
        self.re.hypot(self.im)
    }
    fn sqrt(self) -> C {
        let r = self.abs();
        let re = ((r + self.re) * 0.5).max(0.0).sqrt();
        let im = ((r - self.re) * 0.5).max(0.0).sqrt();
        C::new(re, if self.im < 0.0 { -im } else { im })
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Family {
    Butterworth,
    Chebyshev,
    Bessel,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    LowPass,
    HighPass,
    BandPass,
    BandStop,
}

/// Normalised analog low-pass prototype (cutoff 1 rad/s): the poles in the
/// upper half plane plus one real pole for odd orders.
#[derive(Clone, Copy, Default)]
pub struct Proto {
    pub pairs: [(f64, f64); 4],
    pub npairs: usize,
    pub real: Option<f64>,
}

/// Bessel prototypes for orders 1..=8, normalised for -3 dB at 1 rad/s.
pub struct BesselTable {
    protos: [Proto; 9],
}

impl BesselTable {
    pub fn new() -> BesselTable {
        let mut protos = [Proto::default(); 9];
        for n in 1..=8 {
            protos[n] = bessel_proto(n);
        }
        BesselTable { protos }
    }
    pub fn get(&self, n: usize) -> Proto {
        self.protos[n.clamp(1, 8)]
    }
}

fn factorial(n: usize) -> f64 {
    (1..=n).fold(1.0, |a, k| a * k as f64)
}

/// Roots of the reverse Bessel polynomial (Durand-Kerner), scaled so the
/// magnitude response is -3 dB at 1 rad/s.
fn bessel_proto(n: usize) -> Proto {
    // a[k] coefficient of s^k.
    let mut a = [0.0f64; 9];
    for k in 0..=n {
        a[k] = factorial(2 * n - k) / (2f64.powi((n - k) as i32) * factorial(k) * factorial(n - k));
    }
    let lead = a[n];
    let mut roots = [C::new(0.0, 0.0); 8];
    let seed = C::new(0.4, 0.9);
    let mut z = C::new(1.0, 0.0);
    for r in roots.iter_mut().take(n) {
        z = z.mul(seed);
        *r = z;
    }
    let eval = |s: C| -> C {
        let mut v = C::new(a[n] / lead, 0.0);
        for k in (0..n).rev() {
            v = v.mul(s).add(C::new(a[k] / lead, 0.0));
        }
        v
    };
    for _ in 0..500 {
        for i in 0..n {
            let mut den = C::new(1.0, 0.0);
            for j in 0..n {
                if i != j {
                    den = den.mul(roots[i].sub(roots[j]));
                }
            }
            roots[i] = roots[i].sub(eval(roots[i]).div(den));
        }
    }
    // -3 dB frequency of a0 / theta(s).
    let mag = |w: f64| -> f64 { a[0] / eval(C::new(0.0, w)).scale(lead).abs() };
    let (mut lo, mut hi) = (0.01, 20.0);
    for _ in 0..200 {
        let mid = 0.5 * (lo + hi);
        if mag(mid) > std::f64::consts::FRAC_1_SQRT_2 {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let w3 = 0.5 * (lo + hi);
    let mut p = Proto::default();
    for r in roots.iter().take(n) {
        if r.im > 1e-9 {
            p.pairs[p.npairs] = (r.re / w3, r.im / w3);
            p.npairs += 1;
        } else if r.im.abs() <= 1e-9 {
            p.real = Some(r.re / w3);
        }
    }
    p
}

pub fn butterworth_proto(n: usize) -> Proto {
    let n = n.clamp(1, 8);
    let mut p = Proto::default();
    for k in 0..n / 2 {
        let theta = std::f64::consts::PI * (2 * k + 1) as f64 / (2 * n) as f64;
        p.pairs[k] = (-theta.sin(), theta.cos());
    }
    p.npairs = n / 2;
    if n % 2 == 1 {
        p.real = Some(-1.0);
    }
    p
}

/// Chebyshev type I with `ripple_db` of passband ripple; the cutoff is the
/// edge of the ripple band.
pub fn chebyshev_proto(n: usize, ripple_db: f64) -> Proto {
    let n = n.clamp(1, 8);
    let eps = (10f64.powf(ripple_db.max(0.001) / 10.0) - 1.0).sqrt();
    let mu = (1.0 / eps).asinh() / n as f64;
    let mut p = Proto::default();
    for k in 0..n / 2 {
        let theta = std::f64::consts::PI * (2 * k + 1) as f64 / (2 * n) as f64;
        p.pairs[k] = (-mu.sinh() * theta.sin(), mu.cosh() * theta.cos());
    }
    p.npairs = n / 2;
    if n % 2 == 1 {
        p.real = Some(-mu.sinh());
    }
    p
}

/// Bilinear transform of an analog biquad (b0 + b1 s + b2 s^2) / (a0 + a1 s + a2 s^2)
/// with s = (1 - z^-1) / (1 + z^-1) (frequencies already prewarped with tan).
fn bilinear(b: [f64; 3], a: [f64; 3]) -> Coefs {
    let nb0 = b[0] + b[1] + b[2];
    let nb1 = 2.0 * (b[0] - b[2]);
    let nb2 = b[0] - b[1] + b[2];
    let na0 = a[0] + a[1] + a[2];
    let na1 = 2.0 * (a[0] - a[2]);
    let na2 = a[0] - a[1] + a[2];
    Coefs::from_wide([nb0 / na0, nb1 / na0, nb2 / na0, na1 / na0, na2 / na0])
}

/// Bilinear transform of a first-order analog section (b0 + b1 s) / (a0 + a1 s).
fn bilinear1(b: [f64; 2], a: [f64; 2]) -> Coefs {
    let na0 = a[0] + a[1];
    Coefs::from_wide([(b[0] + b[1]) / na0, (b[0] - b[1]) / na0, 0.0, (a[0] - a[1]) / na0, 0.0])
}

fn warp(f: f32, rate: f32) -> f64 {
    let f = (f as f64).clamp(1.0, rate as f64 * 0.49);
    (std::f64::consts::PI * f / rate as f64).tan()
}

/// Designs the digital sections into `out` (up to 8) and returns how many
/// were written. `f1` is the cutoff (or the low edge of a band), `f2` the
/// high edge for band modes. The passband peak is normalised to 0 dB.
pub fn design(proto: &Proto, mode: Mode, chebyshev_even_ripple: Option<f64>, rate: f32, f1: f32, f2: f32, out: &mut [Coefs; 8]) -> usize {
    let mut n = 0;
    let mut push = |c: Coefs, n: &mut usize| {
        if *n < 8 {
            out[*n] = c;
            *n += 1;
        }
    };
    match mode {
        Mode::LowPass | Mode::HighPass => {
            let k = warp(f1, rate);
            let hp = mode == Mode::HighPass;
            for &(re, im) in &proto.pairs[..proto.npairs] {
                let p = C::new(re, im);
                let w0 = if hp { k / p.abs() } else { k * p.abs() };
                let q = p.abs() / (-2.0 * re);
                let a = [w0 * w0, w0 / q, 1.0];
                let b = if hp { [0.0, 0.0, 1.0] } else { [w0 * w0, 0.0, 0.0] };
                push(bilinear(b, a), &mut n);
            }
            if let Some(r) = proto.real {
                let w = if hp { k / -r } else { k * -r };
                let b = if hp { [0.0, 1.0] } else { [w, 0.0] };
                push(bilinear1(b, [w, 1.0]), &mut n);
            }
        }
        Mode::BandPass | Mode::BandStop => {
            let lo = f1.min(f2);
            let hi = f2.max(f1 * 1.01).max(lo * 1.01);
            let k1 = warp(lo, rate);
            let k2 = warp(hi, rate).max(k1 * 1.001);
            let w02 = k1 * k2;
            let bw = k2 - k1;
            let bp = mode == Mode::BandPass;
            let num = if bp { [0.0, 1.0, 0.0] } else { [w02, 0.0, 1.0] };
            for &(re, im) in &proto.pairs[..proto.npairs] {
                let p = C::new(re, im);
                // Roots of s^2 - c s + w0^2 with c = p B (band pass) or B / p (band stop).
                let c = if bp { p.scale(bw) } else { C::new(bw, 0.0).div(p) };
                let disc = c.mul(c).sub(C::new(4.0 * w02, 0.0)).sqrt();
                for q in [c.add(disc).scale(0.5), c.sub(disc).scale(0.5)] {
                    push(bilinear(num, [q.re * q.re + q.im * q.im, -2.0 * q.re, 1.0]), &mut n);
                }
            }
            if let Some(r) = proto.real {
                let c = if bp { r * bw } else { bw / r };
                push(bilinear(num, [w02, -c, 1.0]), &mut n);
            }
        }
    }
    // Normalise the gain at the passband reference.
    let fref = match mode {
        Mode::LowPass | Mode::BandStop => 0.0,
        Mode::HighPass => rate * 0.5,
        Mode::BandPass => {
            let k = (warp(f1.min(f2), rate) * warp(f2.max(f1 * 1.01), rate)).sqrt();
            (k.atan() * rate as f64 / std::f64::consts::PI) as f32
        }
    };
    // Measured as Cascade runs the sections: one whose poles sit very close
    // to DC (a 10 Hz edge at 192 kHz) runs with its double-precision
    // coefficients, and its f32 ones would misread the gain by several dB.
    let mut g = 1.0f64;
    for c in &out[..n] {
        g *= super::section_magnitude(c, fref, rate) as f64;
    }
    let target = match chebyshev_even_ripple {
        Some(r) => 1.0 / (10f64.powf(r / 10.0)).sqrt(),
        None => 1.0,
    };
    if n > 0 && g > 1e-20 {
        out[0].scale(target / g);
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fx::util::gain_to_db;

    fn response(c: &[Coefs], f: f32, rate: f32) -> f32 {
        gain_to_db(c.iter().map(|x| x.magnitude(f, rate)).product())
    }

    #[test]
    fn bessel_prototypes_match_published_tables() {
        let t = BesselTable::new();
        let p2 = t.get(2);
        assert!((p2.pairs[0].0 + 1.1016).abs() < 1e-3 && (p2.pairs[0].1 - 0.6368).abs() < 1e-3);
        let p3 = t.get(3);
        assert!((p3.real.unwrap() + 1.3226).abs() < 1e-3);
        let p4 = t.get(4);
        let mut re: Vec<f64> = p4.pairs[..2].iter().map(|p| p.0).collect();
        re.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert!((re[0] + 1.3700).abs() < 2e-3 && (re[1] + 0.9952).abs() < 2e-3, "{re:?}");
        for n in 1..=8 {
            let p = t.get(n);
            assert_eq!(p.npairs * 2 + p.real.is_some() as usize, n);
        }
    }

    #[test]
    fn low_and_high_pass_cutoffs() {
        let r = 48000.0;
        let t = BesselTable::new();
        let mut out = [Coefs::IDENTITY; 8];
        for n in 1..=8 {
            for (proto, name) in [(butterworth_proto(n), "butter"), (t.get(n), "bessel")] {
                let k = design(&proto, Mode::LowPass, None, r, 2000.0, 0.0, &mut out);
                assert!((response(&out[..k], 2000.0, r) + 3.01).abs() < 0.05, "{name} lp {n}");
                assert!(response(&out[..k], 20.0, r).abs() < 0.01);
                let k = design(&proto, Mode::HighPass, None, r, 2000.0, 0.0, &mut out);
                assert!((response(&out[..k], 2000.0, r) + 3.01).abs() < 0.05, "{name} hp {n}");
                assert!(response(&out[..k], 23000.0, r).abs() < 0.05);
            }
        }
    }

    #[test]
    fn chebyshev_ripple_band() {
        let r = 48000.0;
        let mut out = [Coefs::IDENTITY; 8];
        for n in [3, 4, 6] {
            let p = chebyshev_proto(n, 1.0);
            let k = design(&p, Mode::LowPass, if n % 2 == 0 { Some(1.0) } else { None }, r, 4000.0, 0.0, &mut out);
            let mut lo = f32::MAX;
            let mut hi = f32::MIN;
            for i in 1..400 {
                let db = response(&out[..k], i as f32 * 10.0, r);
                lo = lo.min(db);
                hi = hi.max(db);
            }
            assert!(hi < 0.02 && hi > -0.05, "n {n} peak {hi}");
            assert!(lo > -1.05, "n {n} trough {lo}");
            assert!((response(&out[..k], 4000.0, r) + 1.0).abs() < 0.05);
            // Steeper than Butterworth beyond the band edge.
            let b = butterworth_proto(n);
            let mut ob = [Coefs::IDENTITY; 8];
            let kb = design(&b, Mode::LowPass, None, r, 4000.0, 0.0, &mut ob);
            assert!(response(&out[..k], 8000.0, r) < response(&ob[..kb], 8000.0, r) - 3.0);
        }
    }

    #[test]
    fn band_pass_and_stop() {
        let r = 48000.0;
        let mut out = [Coefs::IDENTITY; 8];
        let p = butterworth_proto(4);
        let k = design(&p, Mode::BandPass, None, r, 500.0, 2000.0, &mut out);
        assert_eq!(k, 4);
        assert!(response(&out[..k], 1000.0, r).abs() < 0.05);
        assert!((response(&out[..k], 500.0, r) + 3.01).abs() < 0.1);
        assert!((response(&out[..k], 2000.0, r) + 3.01).abs() < 0.1);
        assert!(response(&out[..k], 100.0, r) < -40.0);
        let k = design(&p, Mode::BandStop, None, r, 500.0, 2000.0, &mut out);
        assert!(response(&out[..k], 1000.0, r) < -40.0);
        assert!(response(&out[..k], 20.0, r).abs() < 0.05);
        assert!(response(&out[..k], 15000.0, r).abs() < 0.05);
        // Odd orders work for band modes too.
        let k = design(&butterworth_proto(3), Mode::BandPass, None, r, 300.0, 3000.0, &mut out);
        assert_eq!(k, 3);
        assert!(response(&out[..k], 948.0, r).abs() < 0.05);
    }
}
