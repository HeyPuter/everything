//! Offline kernels for the Special and Diagnostics groups: windowed peak
//! levels (Delete Silence, Mark Audio) and the Doppler Shifter renderer.

use crate::{slice, slice_mut};

/// Peak absolute value of each `win`-frame window of `src` (the last window
/// may be shorter). `out` holds ceil(len / win) values.
#[no_mangle]
pub extern "C" fn special_peaks(src: u32, len: u32, win: u32, out: u32) {
    let win = win.max(1) as usize;
    let x = unsafe { slice(src, len) };
    let o = unsafe { slice_mut(out, x.len().div_ceil(win) as u32) };
    peaks(x, win, o);
}

pub fn peaks(x: &[f32], win: usize, out: &mut [f32]) {
    for (k, chunk) in x.chunks(win.max(1)).enumerate() {
        out[k] = chunk.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    }
}

const SPEED_OF_SOUND: f64 = 343.0;
const EAR: f64 = 0.09;

/// Doppler path settings (see `special_doppler` for the parameter order).
#[derive(Clone, Copy, Debug)]
pub struct Path {
    pub circular: bool,
    pub start_distance: f64,
    pub velocity: f64,
    pub from_deg: f64,
    pub front: f64,
    pub right: f64,
    pub radius: f64,
    pub start_deg: f64,
    pub center_front: f64,
    pub center_right: f64,
    pub distance_volume: bool,
    pub direction_volume: bool,
    pub quality: u32,
}

impl Path {
    pub fn from_params(p: &[f32]) -> Path {
        let g = |i: usize, d: f32| *p.get(i).unwrap_or(&d) as f64;
        Path {
            circular: g(0, 0.0) >= 0.5,
            start_distance: g(1, 30.0),
            velocity: g(2, 20.0).clamp(-300.0, 300.0),
            from_deg: g(3, 0.0),
            front: g(4, 5.0),
            right: g(5, 0.0),
            radius: g(6, 10.0).max(0.1),
            start_deg: g(7, 0.0),
            center_front: g(8, 0.0),
            center_right: g(9, 0.0),
            distance_volume: g(10, 1.0) >= 0.5,
            direction_volume: g(11, 1.0) >= 0.5,
            quality: g(12, 2.0) as u32,
        }
    }

    /// Source position (x = right, y = front) in metres at time t seconds.
    pub fn position(&self, t: f64) -> (f64, f64) {
        if self.circular {
            let a = self.start_deg.to_radians() + self.velocity / self.radius * t;
            (self.center_right + self.radius * a.sin(), self.center_front + self.radius * a.cos())
        } else {
            // Approaches the closest point (right, front) from the given
            // direction, passes it at t = distance / velocity and moves on.
            let a = self.from_deg.to_radians();
            let s = self.start_distance - self.velocity * t;
            (self.right + s * a.sin(), self.front + s * a.cos())
        }
    }
}

fn dist(p: (f64, f64), e: (f64, f64)) -> f64 {
    ((p.0 - e.0).powi(2) + (p.1 - e.1).powi(2)).sqrt()
}

/// Emission time of the sound that reaches `ear` at time t (fixed point).
fn emission_time(path: &Path, t: f64, ear: (f64, f64)) -> f64 {
    let mut te = t - dist(path.position(t), ear) / SPEED_OF_SOUND;
    for _ in 0..4 {
        te = t - dist(path.position(te), ear) / SPEED_OF_SOUND;
    }
    te
}

/// Windowed-sinc kernel table (Blackman window), `RES` points per zero crossing.
struct Kernel {
    half: usize,
    table: Vec<f32>,
}

const RES: usize = 64;

impl Kernel {
    fn new(half: usize) -> Kernel {
        let n = half * RES + 2;
        let table = (0..n)
            .map(|i| {
                let x = i as f64 / RES as f64;
                if x >= half as f64 {
                    return 0.0;
                }
                let s = if x == 0.0 { 1.0 } else { (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x) };
                let w = 0.42 + 0.5 * (std::f64::consts::PI * x / half as f64).cos() + 0.08 * (2.0 * std::f64::consts::PI * x / half as f64).cos();
                (s * w) as f32
            })
            .collect();
        Kernel { half, table }
    }
    #[inline]
    fn at(&self, x: f64) -> f32 {
        let p = x.abs() * RES as f64;
        let i = p as usize;
        if i + 1 >= self.table.len() {
            return 0.0;
        }
        let f = (p - i as f64) as f32;
        self.table[i] + (self.table[i + 1] - self.table[i]) * f
    }
}

#[inline]
fn sample(x: &[f32], i: i64) -> f32 {
    if i < 0 || i as usize >= x.len() {
        0.0
    } else {
        x[i as usize]
    }
}

/// Reads x at fractional position `pos` with the quality's interpolator;
/// `ratio` is the local read speed (above 1 the sinc kernel widens to avoid aliasing).
fn read(x: &[f32], pos: f64, ratio: f64, quality: u32, kernel: Option<&Kernel>) -> f32 {
    let i = pos.floor() as i64;
    let f = (pos - i as f64) as f32;
    if quality == 0 {
        let a = sample(x, i);
        return a + (sample(x, i + 1) - a) * f;
    }
    match kernel {
        None => {
            let xm1 = sample(x, i - 1);
            let x0 = sample(x, i);
            let x1 = sample(x, i + 1);
            let x2 = sample(x, i + 2);
            let c1 = 0.5 * (x1 - xm1);
            let c2 = xm1 - 2.5 * x0 + 2.0 * x1 - 0.5 * x2;
            let c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
            ((c3 * f + c2) * f + c1) * f + x0
        }
        Some(k) => {
            let scale = if ratio > 1.0 { 1.0 / ratio.min(4.0) } else { 1.0 };
            let reach = (k.half as f64 / scale).ceil() as i64;
            let mut acc = 0.0f32;
            for j in (i - reach + 1)..=(i + reach) {
                let d = (j as f64 - pos) * scale;
                acc += sample(x, j) * k.at(d);
            }
            acc * scale as f32
        }
    }
}

/// Renders one channel of the Doppler Shifter.
/// `ear` is -1 (left), 0 (centre, mono) or 1 (right). Params (floats):
/// 0 circular (0/1), 1 starting distance m, 2 velocity m/s, 3 coming from
/// degrees (0 ahead, 90 right), 4 passes in front by m, 5 passes on right
/// by m, 6 radius m, 7 starting angle degrees, 8 centre in front by m,
/// 9 centre on right by m, 10 volume by distance (0/1), 11 volume by
/// direction (0/1), 12 quality (0 linear, 1 cubic, 2 sinc 16, 3 sinc 32).
/// Non-finite input samples (a damaged float file) are read as silence, so
/// the interpolation kernels do not spread them.
pub fn doppler(x: &[f32], rate: f64, ear: f64, path: &Path, out: &mut [f32]) {
    let clean: Vec<f32>;
    let x = if x.iter().all(|v| v.is_finite()) {
        x
    } else {
        clean = x.iter().map(|&v| if v.is_finite() { v } else { 0.0 }).collect();
        &clean
    };
    let n = out.len();
    let e = (ear * EAR, 0.0);
    // Reference delay: the centre of the head at the start, so the output
    // starts in step with the input and the ears keep their relative delay.
    let ref_te = emission_time(path, 0.0, (0.0, 0.0));
    // Closest approach over the render, for distance normalisation.
    let mut dmin = f64::MAX;
    let step = 64.max(n / 4096);
    let mut i = 0;
    while i < n + step {
        dmin = dmin.min(dist(path.position(i as f64 / rate), (0.0, 0.0)));
        i += step;
    }
    let dref = dmin.max(0.5);
    let kernel = match path.quality {
        2 => Some(Kernel::new(8)),
        q if q >= 3 => Some(Kernel::new(16)),
        _ => None,
    };
    let mut prev = 0.0;
    for (k, o) in out.iter_mut().enumerate() {
        let t = k as f64 / rate;
        let te = emission_time(path, t, e);
        let pos = (te - ref_te) * rate;
        let ratio = if k == 0 { 1.0 } else { (pos - prev).abs() };
        prev = pos;
        let mut g = 1.0;
        let p = path.position(te);
        let d = dist(p, e);
        if path.distance_volume {
            g *= dref / d.max(dref);
        }
        if path.direction_volume && d > 1e-6 {
            let (dx, dy) = ((p.0 - e.0) / d, (p.1 - e.1) / d);
            if ear != 0.0 {
                g *= 0.75 + 0.25 * dx * ear;
            }
            if dy < 0.0 {
                g *= 1.0 + 0.2 * dy;
            }
        }
        *o = read(x, pos, ratio, path.quality, kernel.as_ref()) * g as f32;
    }
}

#[no_mangle]
pub extern "C" fn special_doppler(src: u32, len: u32, rate: f32, ear: f32, params: u32, nparams: u32, out: u32) {
    let x = unsafe { slice(src, len) };
    let p = unsafe { slice(params, nparams) };
    let o = unsafe { slice_mut(out, len) };
    doppler(x, rate as f64, ear as f64, &Path::from_params(p), o);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fx::testutil::*;

    /// Zero-crossing frequency estimate of x.
    fn freq(x: &[f32], rate: f32) -> f32 {
        let mut z = 0;
        for i in 1..x.len() {
            if x[i - 1] < 0.0 && x[i] >= 0.0 {
                z += 1;
            }
        }
        z as f32 * rate / x.len() as f32
    }

    #[test]
    fn peaks_per_window() {
        let x = [0.1f32, -0.5, 0.2, 0.0, 0.9, -0.1, 0.3];
        let mut out = [0.0f32; 3];
        peaks(&x, 3, &mut out);
        assert_eq!(out, [0.5, 0.9, 0.3]);
    }

    #[test]
    fn approaching_source_is_higher_then_lower() {
        let rate = 48000.0;
        let n = 96000;
        let x = sine(1000.0, rate, n, 0.5);
        // From the left at 40 m/s, passing 2 m in front at t = 1 s.
        let path = Path::from_params(&[0.0, 40.0, 40.0, -90.0, 2.0, 0.0, 10.0, 0.0, 0.0, 0.0, 0.0, 0.0, 2.0]);
        let mut y = vec![0.0; n];
        doppler(&x, rate as f64, 0.0, &path, &mut y);
        let early = freq(&y[4800..33600], rate);
        let late = freq(&y[62400..91200], rate);
        // f * c / (c - v) = 1132 Hz approaching, f * c / (c + v) = 896 Hz receding.
        assert!((early - 1132.0).abs() < 25.0, "early {early}");
        assert!((late - 896.0).abs() < 25.0, "late {late}");
    }

    #[test]
    fn non_finite_input_samples_do_not_spread() {
        let rate = 48000.0;
        let n = 48000;
        let mut x = sine(1000.0, rate, n, 0.5);
        x[1000] = f32::NAN;
        x[20000] = f32::INFINITY;
        for quality in [0.0, 1.0, 2.0, 3.0] {
            let path = Path::from_params(&[0.0, 40.0, 40.0, -90.0, 2.0, 0.0, 10.0, 0.0, 0.0, 0.0, 0.0, 0.0, quality]);
            let mut y = vec![0.0; n];
            doppler(&x, rate as f64, 0.0, &path, &mut y);
            assert!(y.iter().all(|v| v.is_finite()), "quality {quality}");
        }
    }

    #[test]
    fn distance_volume_peaks_at_closest_approach() {
        let rate = 8000.0;
        let n = 16000;
        let x = vec![0.5f32; n];
        let path = Path::from_params(&[0.0, 20.0, 20.0, -90.0, 1.0, 0.0, 10.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0]);
        let mut y = vec![0.0; n];
        doppler(&x, rate as f64, 0.0, &path, &mut y);
        let mid = y[8000];
        assert!(mid > 0.45, "{mid}");
        assert!(y[200] < 0.1, "{}", y[200]);
        assert!(peak(&y) <= 0.5 + 1e-4);
    }

    #[test]
    fn circular_path_pans_between_ears() {
        let rate = 8000.0;
        let n = 16000;
        let x = vec![0.5f32; n];
        // Circles the head at 3 m, starting ahead, one turn in about 1.9 s.
        let path = Path::from_params(&[1.0, 0.0, 10.0, 0.0, 0.0, 0.0, 3.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0]);
        let mut l = vec![0.0; n];
        let mut r = vec![0.0; n];
        doppler(&x, rate as f64, -1.0, &path, &mut l);
        doppler(&x, rate as f64, 1.0, &path, &mut r);
        // A quarter turn in (source on the right) the right ear is louder.
        let q = (0.25 * 2.0 * std::f64::consts::PI * 3.0 / 10.0 * rate as f64) as usize;
        assert!(r[q] > l[q] * 1.5, "l {} r {}", l[q], r[q]);
    }
}
