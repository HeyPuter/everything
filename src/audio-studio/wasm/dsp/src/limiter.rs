//! Look-ahead peak limiter used by Match Loudness. Gain reduction is the
//! moving average of a sliding minimum of the required gain, so it reaches
//! the needed reduction exactly at each peak without clipping it. Peaks are
//! measured 4x oversampled (true peak). Output is delayed by the look-ahead;
//! callers flush with zeros and drop the first `latency` frames.

use crate::loudness::TruePeak;

pub struct Limiter {
    channels: usize,
    ceiling: f32,
    gain: f32,
    look: usize,
    release: f32,
    tp: TruePeak,
    delay: Vec<Vec<f32>>,
    // Monotonic deque (ring) of (frame, required gain) for the sliding
    // minimum over the last look + 1 frames: O(1) per frame instead of a
    // scan of the whole window.
    dq_idx: Vec<u64>,
    dq_val: Vec<f32>,
    dq_head: usize,
    dq_len: usize,
    t: u64,
    mins: Vec<f32>, // ring of sliding minima for the average
    min_sum: f64,
    pos: usize,
    g: f32,
}

impl Limiter {
    pub fn new(rate: f32, channels: usize, ceiling: f32, look_ms: f32, release_ms: f32, gain: f32) -> Limiter {
        // The true-peak interpolator lags its input by 8 samples; look further.
        let look = ((rate * look_ms / 1000.0).round() as usize).max(1) + 8;
        Limiter {
            channels,
            ceiling,
            gain,
            look,
            release: 1.0 - (-1.0 / (rate * release_ms.max(1.0) / 1000.0)).exp(),
            tp: TruePeak::new(channels),
            delay: vec![vec![0.0; look + 1]; channels],
            dq_idx: vec![0; look + 2],
            dq_val: vec![0.0; look + 2],
            dq_head: 0,
            dq_len: 0,
            t: 0,
            mins: vec![1.0; look + 1],
            min_sum: (look + 1) as f64,
            pos: 0,
            g: 1.0,
        }
    }

    pub fn latency(&self) -> usize {
        self.look
    }

    /// Processes planar frames in place (output delayed by `latency`).
    pub fn process(&mut self, buf: &mut [f32], frames: usize) {
        let n = self.look + 1;
        for i in 0..frames {
            let mut peak = 0.0f32;
            for c in 0..self.channels {
                let x = buf[c * frames + i] * self.gain;
                buf[c * frames + i] = x;
                peak = peak.max(self.tp.push(c, x)).max(x.abs());
            }
            self.tp.advance();
            let need = if peak > self.ceiling { self.ceiling / peak } else { 1.0 };
            // Sliding minimum over the last n required gains. Every gain is
            // at most 1, so the window's initial 1.0 entries never change it.
            let cap = self.dq_idx.len();
            while self.dq_len > 0 && self.dq_val[(self.dq_head + self.dq_len - 1) % cap] >= need {
                self.dq_len -= 1;
            }
            let slot = (self.dq_head + self.dq_len) % cap;
            self.dq_idx[slot] = self.t;
            self.dq_val[slot] = need;
            self.dq_len += 1;
            while self.dq_idx[self.dq_head] + n as u64 <= self.t {
                self.dq_head = (self.dq_head + 1) % cap;
                self.dq_len -= 1;
            }
            self.t += 1;
            let m = self.dq_val[self.dq_head];
            self.min_sum += m as f64 - self.mins[self.pos] as f64;
            self.mins[self.pos] = m;
            let avg = (self.min_sum / n as f64) as f32;
            self.g = if avg < self.g { avg } else { self.g + (avg - self.g) * self.release };
            let g = self.g.min(avg);
            let read = (self.pos + 1) % n;
            for c in 0..self.channels {
                let d = &mut self.delay[c];
                d[self.pos] = buf[c * frames + i];
                buf[c * frames + i] = d[read] * g;
            }
            self.pos = read;
        }
    }
}

#[no_mangle]
pub extern "C" fn lim_new(rate: f32, channels: u32, ceiling: f32, look_ms: f32, release_ms: f32, gain: f32) -> u32 {
    Box::into_raw(Box::new(Limiter::new(rate, channels.max(1) as usize, ceiling, look_ms, release_ms, gain))) as u32
}

#[no_mangle]
pub extern "C" fn lim_free(h: u32) {
    if h != 0 {
        unsafe { drop(Box::from_raw(h as *mut Limiter)) }
    }
}

#[no_mangle]
pub extern "C" fn lim_latency(h: u32) -> u32 {
    unsafe { (*(h as *mut Limiter)).latency() as u32 }
}

#[no_mangle]
pub extern "C" fn lim_process(h: u32, buf: u32, frames: u32) {
    let l = unsafe { &mut *(h as *mut Limiter) };
    let s = unsafe { crate::slice_mut(buf, frames * l.channels as u32) };
    l.process(s, frames as usize);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::loudness::Meter;

    /// The sliding minimum as a scan of the whole window (the previous
    /// implementation), for comparison.
    fn reference(rate: f32, channels: usize, ceiling: f32, look_ms: f32, release_ms: f32, gain: f32, buf: &mut [f32], frames: usize) {
        let mut l = Limiter::new(rate, channels, ceiling, look_ms, release_ms, gain);
        let n = l.look + 1;
        let mut need_ring = vec![1.0f32; n];
        for i in 0..frames {
            let mut peak = 0.0f32;
            for c in 0..channels {
                let x = buf[c * frames + i] * l.gain;
                buf[c * frames + i] = x;
                peak = peak.max(l.tp.push(c, x)).max(x.abs());
            }
            l.tp.advance();
            need_ring[l.pos] = if peak > l.ceiling { l.ceiling / peak } else { 1.0 };
            let m = need_ring.iter().copied().fold(1.0f32, f32::min);
            l.min_sum += m as f64 - l.mins[l.pos] as f64;
            l.mins[l.pos] = m;
            let avg = (l.min_sum / n as f64) as f32;
            l.g = if avg < l.g { avg } else { l.g + (avg - l.g) * l.release };
            let g = l.g.min(avg);
            let read = (l.pos + 1) % n;
            for c in 0..channels {
                let d = &mut l.delay[c];
                d[l.pos] = buf[c * frames + i];
                buf[c * frames + i] = d[read] * g;
            }
            l.pos = read;
        }
    }

    #[test]
    fn sliding_minimum_matches_a_full_window_scan() {
        let mut seed = 7u32;
        let mut rnd = || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            seed as f32 / 4294967296.0 - 0.5
        };
        for &(rate, channels, ceiling, look, release, gain) in
            &[(48000.0, 2, 0.89, 12.0, 80.0, 2.0), (44100.0, 1, 0.5, 0.0, 10.0, 4.0), (8000.0, 2, 1.2, 50.0, 300.0, 3.0), (192000.0, 2, 0.95, 5.0, 50.0, 1.5)]
        {
            let frames = 20000;
            let buf: Vec<f32> = (0..frames * channels).map(|i| rnd() * if (i / 3000) % 2 == 0 { 0.2 } else { 2.0 }).collect();
            let mut a = buf.clone();
            let mut b = buf.clone();
            let mut l = Limiter::new(rate, channels, ceiling, look, release, gain);
            // In blocks, as JavaScript feeds it.
            for chunk in [(0, 7000), (7000, frames)] {
                let len = chunk.1 - chunk.0;
                let mut part: Vec<f32> = (0..channels).flat_map(|c| a[c * frames + chunk.0..c * frames + chunk.1].to_vec()).collect();
                l.process(&mut part, len);
                for c in 0..channels {
                    a[c * frames + chunk.0..c * frames + chunk.1].copy_from_slice(&part[c * len..(c + 1) * len]);
                }
            }
            reference(rate, channels, ceiling, look, release, gain, &mut b, frames);
            assert!(a.iter().zip(&b).all(|(x, y)| x.to_bits() == y.to_bits()), "{rate} {look}");
        }
    }

    #[test]
    fn limits_true_peak_and_preserves_quiet_signal() {
        let rate = 48000.0;
        let frames = 48000;
        let mut buf = vec![0.0f32; frames * 2];
        for i in 0..frames {
            let t = i as f32 / rate;
            // Quiet tone with a loud burst in the middle.
            let amp = if (20000..22000).contains(&i) { 0.9 } else { 0.1 };
            let v = amp * (2.0 * std::f32::consts::PI * 3000.0 * t).sin();
            buf[i] = v;
            buf[frames + i] = v;
        }
        let orig = buf.clone();
        let gain = 2.0; // +6 dB pushes the burst to 1.8
        let ceiling = 10f32.powf(-1.0 / 20.0);
        let mut lim = Limiter::new(rate, 2, ceiling, 5.0, 50.0, gain);
        let lat = lim.latency();
        let mut padded = vec![0.0f32; (frames + lat) * 2];
        for c in 0..2 {
            padded[c * (frames + lat)..c * (frames + lat) + frames].copy_from_slice(&orig[c * frames..(c + 1) * frames]);
        }
        lim.process(&mut padded, frames + lat);
        let out: Vec<f32> = (0..2).flat_map(|c| padded[c * (frames + lat) + lat..(c + 1) * (frames + lat)].to_vec()).collect();
        let mut meter = Meter::new(rate as f64, 2);
        meter.push(&out, frames);
        let tp = meter.tp.peak[0].max(meter.sample_peak[0]);
        assert!(tp <= ceiling * 1.02, "true peak {}", tp);
        // Away from the burst the gain is the plain +6 dB.
        for i in 5000..6000 {
            assert!((out[i] - orig[i] * gain).abs() < 1e-4, "{} {} {}", i, out[i], orig[i] * gain);
        }
    }
}
