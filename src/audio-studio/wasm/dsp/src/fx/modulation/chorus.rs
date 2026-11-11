//! Chorus: up to eight voices, each a slowly swept delay with its own LFO
//! phase and rate, a slow amplitude wobble and a place in the stereo field.
//!
//! Params: 0 voices (2..8), 1 delay ms, 2 delay rate Hz, 3 feedback %,
//! 4 spread ms (extra delay across voices), 5 modulation depth dB,
//! 6 modulation rate Hz, 7 stereo width %, 8 dry % (0..200), 9 wet % (0..200),
//! 10 highest quality, 11 average left and right input (the voices all hear
//! the mono sum), 12 binaural cues (a voice panned to one side reaches the
//! other ear up to ITD_MS later and quieter, as sound around a head does).
//! The sum of the voices is fed back, so the feedback is held where that loop
//! gain stays below 0.95 (loop_gain); lower settings are applied as set.

use super::fsin;
use crate::fx::delay::feedback_tail;
use crate::fx::util::{sanitize, DelayLine};
use crate::fx::{Effect, Smooth};

pub const MAX_VOICES: usize = 8;
const MAX_DELAY_MS: f32 = 50.0;
const MAX_SPREAD_MS: f32 = 200.0;
/// Frames between LFO evaluations.
const CTRL: usize = 16;
/// Largest interaural time difference for binaural cues, in ms.
const ITD_MS: f32 = 0.65;

pub struct Chorus {
    rate: f32,
    lines: [DelayLine; 2],
    voices: usize,
    delay: Smooth,
    spread: Smooth,
    delay_ms: f32,
    spread_ms: f32,
    delay_rate: f32,
    fb: f32,
    /// Feedback actually applied: `fb`, held below a loop gain of 0.95.
    fb_eff: f32,
    /// Channels the instance runs on (the voices are panned only on two).
    channels: usize,
    depth_db: f32,
    mod_rate: f32,
    width: f32,
    dry: Smooth,
    wet: Smooth,
    hq: bool,
    average: bool,
    binaural: bool,
    phase: [f32; MAX_VOICES],
    amp_phase: [f32; MAX_VOICES],
    last: [f32; 2],
    fresh: bool,
}

impl Chorus {
    pub fn new(rate: f32, channels: usize) -> Chorus {
        let max = ((MAX_DELAY_MS * 1.3 + MAX_SPREAD_MS + ITD_MS + 2.0) * rate / 1000.0) as usize + 8;
        let mut phase = [0.0; MAX_VOICES];
        let mut amp_phase = [0.0; MAX_VOICES];
        for i in 0..MAX_VOICES {
            phase[i] = i as f32 * 0.618_034 % 1.0;
            amp_phase[i] = i as f32 * 0.377 % 1.0;
        }
        Chorus {
            rate,
            lines: [DelayLine::new(max), DelayLine::new(max)],
            voices: 5,
            delay: Smooth::new(12.0, rate, 80.0),
            spread: Smooth::new(10.0, rate, 80.0),
            delay_ms: 12.0,
            spread_ms: 10.0,
            delay_rate: 0.6,
            fb: 0.0,
            fb_eff: 0.0,
            channels,
            depth_db: 2.0,
            mod_rate: 1.2,
            width: 0.8,
            dry: Smooth::new(0.7, rate, 20.0),
            wet: Smooth::new(0.5, rate, 20.0),
            hq: true,
            average: false,
            binaural: false,
            phase,
            amp_phase,
            last: [0.0; 2],
            fresh: true,
        }
    }

    /// Gain of the summed voices fed back, in the louder channel: each voice
    /// at 1 / sqrt(voices), panned by the width (or the binaural levels), at
    /// its mean level under the amplitude wobble. It exceeds 1 with several
    /// voices near the middle, so the feedback alone does not bound the loop.
    pub fn loop_gain(&self) -> f32 {
        let v = self.voices;
        let floor = 10f32.powf(-self.depth_db / 20.0);
        let (mut l, mut r) = (0.0f32, 0.0f32);
        for i in 0..v {
            let p = if self.channels >= 2 { self.width * (2.0 * i as f32 / (v - 1) as f32 - 1.0) } else { 0.0 };
            if self.binaural && self.channels >= 2 {
                let far = 1.0 - 0.5 * p.abs();
                l += if p > 0.0 { far } else { 1.0 };
                r += if p > 0.0 { 1.0 } else { far };
            } else {
                l += 1.0 - p.max(0.0);
                r += 1.0 + p.min(0.0);
            }
        }
        l.max(r) / (v as f32).sqrt() * (1.0 + floor) / 2.0
    }

    /// Holds the applied feedback below a loop gain of 0.95 (unchanged below it),
    /// so a high feedback with many voices rings down instead of growing.
    fn update_feedback(&mut self) {
        let g = self.loop_gain();
        self.fb_eff = if self.fb * g > 0.95 { 0.95 / g } else { self.fb };
    }

    /// Longest delay any voice reaches, in ms.
    pub fn max_delay_ms(delay: f32, spread: f32) -> f32 {
        delay * 1.3 + spread
    }
}

impl Effect for Chorus {
    fn set_param(&mut self, idx: u32, v: f32) {
        match idx {
            0 => self.voices = (v.round() as usize).clamp(2, MAX_VOICES),
            1 => {
                self.delay_ms = v.clamp(1.0, MAX_DELAY_MS);
                self.delay.target = self.delay_ms;
            }
            2 => self.delay_rate = v.clamp(0.0, 20.0),
            3 => self.fb = (v * 0.01).clamp(0.0, 0.9),
            4 => {
                self.spread_ms = v.clamp(0.0, MAX_SPREAD_MS);
                self.spread.target = self.spread_ms;
            }
            5 => self.depth_db = v.clamp(0.0, 24.0),
            6 => self.mod_rate = v.clamp(0.0, 30.0),
            7 => self.width = (v * 0.01).clamp(0.0, 1.0),
            8 => self.dry.target = (v * 0.01).clamp(0.0, 2.0),
            9 => self.wet.target = (v * 0.01).clamp(0.0, 2.0),
            10 => self.hq = v >= 0.5,
            11 => self.average = v >= 0.5,
            12 => self.binaural = v >= 0.5,
            _ => {}
        }
        if matches!(idx, 0 | 3 | 5 | 7 | 12) {
            self.update_feedback();
        }
    }

    fn process(&mut self, buf: &mut [f32], channels: usize, frames: usize) {
        if self.fresh {
            self.fresh = false;
            for s in [&mut self.delay, &mut self.spread, &mut self.dry, &mut self.wet] {
                s.settle();
            }
        }
        let ch = channels.min(2);
        let v = self.voices;
        let fpm = self.rate / 1000.0;
        // Each voice runs at a slightly different rate so they never lock.
        let mut inc = [0.0f32; MAX_VOICES];
        let mut ainc = [0.0f32; MAX_VOICES];
        let mut pan = [[1.0f32; 2]; MAX_VOICES];
        // Extra delay (frames) per voice and channel for binaural cues.
        let mut itd = [[0.0f32; 2]; MAX_VOICES];
        for i in 0..v {
            inc[i] = self.delay_rate * (1.0 + 0.11 * i as f32) / self.rate;
            ainc[i] = self.mod_rate * (1.0 + 0.07 * i as f32) / self.rate;
            let p = if ch == 2 { self.width * (2.0 * i as f32 / (v - 1) as f32 - 1.0) } else { 0.0 };
            pan[i] = [1.0 - p.max(0.0), 1.0 + p.min(0.0)];
            if self.binaural && ch == 2 {
                // The far ear hears the voice later and shadowed by the head
                // instead of not at all.
                let lag = p.abs() * ITD_MS * fpm;
                let far = 1.0 - 0.5 * p.abs();
                if p > 0.0 {
                    itd[i] = [lag, 0.0];
                    pan[i] = [far, 1.0];
                } else {
                    itd[i] = [0.0, lag];
                    pan[i] = [1.0, far];
                }
            }
        }
        let floor = 10f32.powf(-self.depth_db / 20.0);
        let norm = 1.0 / (v as f32).sqrt();
        // LFOs run at control rate (every CTRL frames); delays and gains are
        // interpolated linearly in between.
        let voice = |phase: f32, amp: f32, base: f32, spread: f32, k: usize| {
            let ms = base + spread * k as f32 / (v - 1) as f32 + 0.3 * base * fsin(phase);
            let g = norm * (1.0 - (1.0 - floor) * (0.5 + 0.5 * fsin(amp)));
            ((ms * fpm - 1.0).max(1.0), g)
        };
        let mut i = 0;
        while i < frames {
            let m = CTRL.min(frames - i);
            let (b0, s0) = (self.delay.value, self.spread.value);
            for _ in 0..m {
                self.delay.next();
                self.spread.next();
            }
            let (b1, s1) = (self.delay.value, self.spread.value);
            let mut d = [0.0f32; MAX_VOICES];
            let mut dd = [0.0f32; MAX_VOICES];
            let mut g = [0.0f32; MAX_VOICES];
            let mut dg = [0.0f32; MAX_VOICES];
            for k in 0..v {
                let (da, ga) = voice(self.phase[k], self.amp_phase[k], b0, s0, k);
                self.phase[k] = (self.phase[k] + inc[k] * m as f32).fract();
                self.amp_phase[k] = (self.amp_phase[k] + ainc[k] * m as f32).fract();
                let (db, gb) = voice(self.phase[k], self.amp_phase[k], b1, s1, k);
                d[k] = da;
                dd[k] = (db - da) / m as f32;
                g[k] = ga;
                dg[k] = (gb - ga) / m as f32;
            }
            for j in i..i + m {
                let (dry, wet) = (self.dry.next(), self.wet.next());
                let mut acc = [0.0f32; 2];
                for k in 0..v {
                    for c in 0..ch {
                        let at = d[k] + itd[k][c];
                        let t = if self.hq { self.lines[c].tap_cubic(at) } else { self.lines[c].tap_linear(at) };
                        acc[c] += t * g[k] * pan[k][c];
                    }
                    d[k] += dd[k];
                    g[k] += dg[k];
                }
                let mono = if self.average && ch == 2 { 0.5 * (buf[j] + buf[frames + j]) } else { 0.0 };
                for c in 0..ch {
                    let x = buf[c * frames + j];
                    let input = if self.average && ch == 2 { mono } else { x };
                    self.lines[c].push(input + self.fb_eff * self.last[c]);
                    self.last[c] = acc[c];
                    buf[c * frames + j] = x * dry + acc[c] * wet;
                }
            }
            i += m;
        }
        self.last = [sanitize(self.last[0]), sanitize(self.last[1])];
    }

    fn reset(&mut self) {
        self.lines.iter_mut().for_each(|l| l.clear());
        self.last = [0.0; 2];
    }

    fn tail(&self) -> u32 {
        let itd = if self.binaural { ITD_MS } else { 0.0 };
        let ms = (Chorus::max_delay_ms(self.delay_ms, self.spread_ms) + itd) as f64;
        // The loop rings at the feedback times the voices' gain (at least the feedback).
        let g = (self.fb * self.loop_gain()).min(0.95).max(self.fb) as f64;
        feedback_tail(ms * self.rate as f64 / 1000.0, g, self.rate)
    }
}

#[cfg(test)]
mod tests {
    use crate::fx::testutil::*;

    #[test]
    fn high_feedback_with_many_voices_rings_down() {
        let rate = 48000.0;
        for (voices, fb, width) in [(8.0, 90.0, 100.0), (8.0, 45.0, 0.0), (5.0, 90.0, 80.0)] {
            let mut fx = make(70, rate, 2);
            for (i, v) in [(0, voices), (3, fb), (7, width)] {
                fx.set_param(i, v);
            }
            fx.reset();
            let x = sine(300.0, rate, 48000, 0.3);
            let silent = vec![0.0; 48000];
            run_stereo(fx.as_mut(), &x, &x);
            let (l, r) = run_stereo(fx.as_mut(), &silent, &silent);
            let tail = rms(&l[36000..]).max(rms(&r[36000..]));
            assert!(tail < 0.01, "{voices} {fb} {width}: {tail}");
        }
    }

    #[test]
    fn average_input_feeds_both_sides_and_binaural_cues_delay_the_far_ear() {
        let rate = 48000.0;
        let x = sine(700.0, rate, 24000, 0.5);
        let silent = vec![0.0; 24000];
        let run = |params: &[(u32, f32)]| {
            let mut fx = make(70, rate, 2);
            for &(i, v) in [(0, 2.0), (7, 0.0), (8, 0.0), (9, 100.0)].iter().chain(params) {
                fx.set_param(i, v);
            }
            run_stereo(fx.as_mut(), &x, &silent)
        };
        let (_, r_off) = run(&[]);
        let (_, r_on) = run(&[(11, 1.0)]);
        assert!(rms(&r_off[12000..]) < 1e-4);
        assert!(rms(&r_on[12000..]) > 0.05);
        // Binaural cues change the stereo image of panned voices.
        let (l0, r0) = run(&[(7, 100.0), (11, 1.0)]);
        let (l1, r1) = run(&[(7, 100.0), (11, 1.0), (12, 1.0)]);
        let diff: f32 = l0.iter().zip(&l1).chain(r0.iter().zip(&r1)).map(|(a, b)| (a - b).abs()).sum();
        assert!(diff > 1.0, "{diff}");
        assert!(l1.iter().chain(&r1).all(|v| v.is_finite()));
    }

    #[test]
    fn wet_voices_are_delayed_and_modulated() {
        let rate = 48000.0;
        let mut fx = make(70, rate, 2);
        for (i, v) in [(0, 4.0), (1, 20.0), (2, 1.0), (4, 5.0), (8, 0.0), (9, 100.0)] {
            fx.set_param(i, v);
        }
        let x = sine(1000.0, rate, 48000, 0.5);
        let (l, r) = run_stereo(fx.as_mut(), &x, &x);
        // Silent until the shortest voice delay (20 ms minus 30 % sweep).
        assert!(peak(&l[..600]) < 1e-6);
        assert!(rms(&l[24000..]) > 0.1);
        // Voices panned apart decorrelate the channels.
        let diff: Vec<f32> = l.iter().zip(&r).map(|(a, b)| a - b).collect();
        assert!(rms(&diff[24000..]) > 0.02);
    }

    #[test]
    fn dry_only_is_transparent() {
        let mut fx = make(70, 48000.0, 1);
        fx.set_param(8, 100.0);
        fx.set_param(9, 0.0);
        let x = noise(4800, 0.5, 2);
        let y = run_mono(fx.as_mut(), &x);
        for i in 0..x.len() {
            assert!((x[i] - y[i]).abs() < 1e-6);
        }
    }
}
