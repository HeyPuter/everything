//! Effect processors shared by realtime playback (inside the AudioWorklet) and
//! offline rendering (inside a Worker). Every effect implements `Effect`; the
//! JavaScript side refers to them by numeric kind (the `kind` of each
//! definition in `src/effects/defs/*.js`) and sets parameters by index in the
//! order the registry declares them.
//!
//! Kind ranges by group (each group module owns its range):
//!   1        gain (Amplify)
//!   10..30   filter      Filter and EQ
//!   30..60   dynamics    Amplitude and Compression, Loudness Maximizer
//!   60..70   delay       Delay and Echo
//!   70..80   modulation  Modulation
//!   80..90   reverb      Reverb
//!   90..110  special     Special
//!   110..120 stereo      Stereo Imagery
//!   120..130 pitch       Time and Pitch
//!   130..160 restore     Noise Reduction / Restoration, Diagnostics

mod delay;
mod dynamics;
mod filter;
mod gain;
mod modulation;
mod pitch;
mod restore;
mod reverb;
mod special;
mod stereo;
pub mod util;

pub trait Effect {
    /// Sets parameter `idx` to `value` (in the units the JS registry documents).
    fn set_param(&mut self, idx: u32, value: f32);
    /// Processes `frames` frames of planar audio in place: channel c occupies
    /// `buf[c * frames .. (c + 1) * frames]`.
    fn process(&mut self, buf: &mut [f32], channels: usize, frames: usize);
    /// Clears delay lines and envelopes, e.g. after a seek.
    fn reset(&mut self) {}
    /// Processing latency in frames (lookahead), reported to the host.
    fn latency(&self) -> u32 {
        0
    }
    /// Frames of output the effect keeps producing after its input ends.
    fn tail(&self) -> u32 {
        0
    }
    /// Receives a block of data (a filter curve, an impulse response, a noise
    /// profile...) for data slot `slot`. Called outside `process`, so it may
    /// allocate. The layout of each slot is documented by the effect.
    fn set_data(&mut self, _slot: u32, _data: &[f32]) {}
    /// Writes live measurements (meter readings, detector levels) to `out`
    /// and returns how many values were written. Effects that measure what
    /// passes through them document their layout; the default reports none.
    /// The host reads this a few times a second while playing.
    fn readout(&mut self, _out: &mut [f32]) -> usize {
        0
    }
}

pub struct Slot {
    pub fx: Box<dyn Effect>,
    pub channels: usize,
}

/// Creates an effect of `kind` for `channels` channels at `rate` Hz.
fn create(kind: u32, rate: f32, channels: usize) -> Option<Box<dyn Effect>> {
    // The convolution reverb also runs on 5.1 (Surround Reverb on 6-channel tracks).
    let channels = if kind == 83 && channels >= 6 { 6 } else { channels.clamp(1, 2) };
    match kind {
        1 => Some(Box::new(gain::Gain::new(rate, channels))),
        10..=29 => filter::create(kind, rate, channels),
        30..=59 => dynamics::create(kind, rate, channels),
        60..=69 => delay::create(kind, rate, channels),
        70..=79 => modulation::create(kind, rate, channels),
        80..=89 => reverb::create(kind, rate, channels),
        90..=109 => special::create(kind, rate, channels),
        110..=119 => stereo::create(kind, rate, channels),
        120..=129 => pitch::create(kind, rate, channels),
        130..=159 => restore::create(kind, rate, channels),
        _ => None,
    }
}

#[no_mangle]
pub extern "C" fn fx_new(kind: u32, rate: f32, channels: u32) -> u32 {
    // The block holds 1, 2 or (5.1) 6 planar channels.
    let channels = if channels >= 6 { 6 } else { channels.clamp(1, 2) };
    match create(kind, rate, channels as usize) {
        Some(fx) => Box::into_raw(Box::new(Slot { fx, channels: channels as usize })) as u32,
        None => 0,
    }
}

#[no_mangle]
pub extern "C" fn fx_free(h: u32) {
    if h != 0 {
        unsafe { drop(Box::from_raw(h as *mut Slot)) }
    }
}

#[no_mangle]
pub extern "C" fn fx_set(h: u32, idx: u32, value: f32) {
    let s = unsafe { &mut *(h as *mut Slot) };
    s.fx.set_param(idx, value);
}

#[no_mangle]
pub extern "C" fn fx_process(h: u32, buf: u32, frames: u32) {
    let s = unsafe { &mut *(h as *mut Slot) };
    let n = s.channels as u32 * frames;
    let b = unsafe { crate::slice_mut(buf, n) };
    // A NaN or infinite input sample (a damaged float file) would circulate in
    // feedback delays and reverbs for good, so the rest of the output came out
    // NaN; it is processed as silence instead. Finite input is untouched.
    for v in b.iter_mut() {
        *v = if v.is_finite() { *v } else { 0.0 };
    }
    s.fx.process(b, s.channels, frames as usize);
}

/// Hands `len` floats at `ptr` to data slot `slot` of the effect (copied).
#[no_mangle]
pub extern "C" fn fx_data(h: u32, slot: u32, ptr: u32, len: u32) {
    let s = unsafe { &mut *(h as *mut Slot) };
    let d = unsafe { crate::slice(ptr, len) };
    s.fx.set_data(slot, d);
}

/// Copies up to `cap` live readings of the effect to `out`; returns the count.
#[no_mangle]
pub extern "C" fn fx_readout(h: u32, out: u32, cap: u32) -> u32 {
    let s = unsafe { &mut *(h as *mut Slot) };
    let o = unsafe { crate::slice_mut(out, cap) };
    s.fx.readout(o).min(cap as usize) as u32
}

#[no_mangle]
pub extern "C" fn fx_reset(h: u32) {
    let s = unsafe { &mut *(h as *mut Slot) };
    s.fx.reset();
}

#[no_mangle]
pub extern "C" fn fx_latency(h: u32) -> u32 {
    let s = unsafe { &*(h as *mut Slot) };
    s.fx.latency()
}

#[no_mangle]
pub extern "C" fn fx_tail(h: u32) -> u32 {
    let s = unsafe { &*(h as *mut Slot) };
    s.fx.tail()
}

/// Converts decibels to linear gain.
#[inline]
pub fn db_to_gain(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

/// One-pole smoother used to de-zipper parameter changes.
pub struct Smooth {
    pub value: f32,
    pub target: f32,
    coef: f32,
}

impl Smooth {
    pub fn new(value: f32, rate: f32, ms: f32) -> Smooth {
        Smooth { value, target: value, coef: (-1.0 / (rate * ms * 0.001)).exp() }
    }
    #[inline]
    pub fn next(&mut self) -> f32 {
        self.value = self.target + (self.value - self.target) * self.coef;
        self.value
    }
    pub fn settle(&mut self) {
        self.value = self.target;
    }
    /// True once the value has (practically) reached its target.
    #[inline]
    pub fn settled(&self) -> bool {
        (self.value - self.target).abs() <= 1e-5 * (1.0 + self.target.abs())
    }
    /// Sets the target and jumps there (for the first parameter set).
    pub fn jump(&mut self, v: f32) {
        self.target = v;
        self.value = v;
    }
}

/// Test helpers shared by the effect groups.
#[cfg(test)]
pub mod testutil {
    use super::*;

    pub fn sine(f: f32, rate: f32, n: usize, amp: f32) -> Vec<f32> {
        (0..n).map(|i| amp * (util::TAU * f * i as f32 / rate).sin()).collect()
    }

    pub fn noise(n: usize, amp: f32, seed: u32) -> Vec<f32> {
        let mut r = util::Rng(seed.max(1));
        (0..n).map(|_| amp * r.bipolar()).collect()
    }

    pub fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>() / x.len().max(1) as f64).sqrt() as f32
    }

    pub fn peak(x: &[f32]) -> f32 {
        x.iter().fold(0.0f32, |m, v| m.max(v.abs()))
    }

    /// Runs `fx` over planar stereo made of `l` and `r` in worklet-sized
    /// blocks (128 frames) and returns (l, r).
    pub fn run_stereo(fx: &mut dyn Effect, l: &[f32], r: &[f32]) -> (Vec<f32>, Vec<f32>) {
        let n = l.len();
        let (mut ol, mut or) = (Vec::with_capacity(n), Vec::with_capacity(n));
        let mut blk = vec![0.0f32; 256];
        let mut at = 0;
        while at < n {
            let m = 128.min(n - at);
            blk[..m].copy_from_slice(&l[at..at + m]);
            blk[m..2 * m].copy_from_slice(&r[at..at + m]);
            fx.process(&mut blk[..2 * m], 2, m);
            ol.extend_from_slice(&blk[..m]);
            or.extend_from_slice(&blk[m..2 * m]);
            at += m;
        }
        (ol, or)
    }

    /// Mono version of `run_stereo`.
    pub fn run_mono(fx: &mut dyn Effect, x: &[f32]) -> Vec<f32> {
        let mut out = Vec::with_capacity(x.len());
        for chunk in x.chunks(128) {
            let mut b = chunk.to_vec();
            fx.process(&mut b, 1, chunk.len());
            out.extend_from_slice(&b);
        }
        out
    }

    /// Creates an effect through the same path as the C ABI.
    pub fn make(kind: u32, rate: f32, channels: usize) -> Box<dyn Effect> {
        create(kind, rate, channels).expect("unknown effect kind")
    }

    /// Magnitude in dB of a steady sine at `f` through a fresh effect.
    pub fn sine_gain_db(kind: u32, params: &[(u32, f32)], f: f32, rate: f32) -> f32 {
        let mut fx = make(kind, rate, 1);
        for &(i, v) in params {
            fx.set_param(i, v);
        }
        fx.reset();
        let n = (rate * 0.5) as usize;
        let x = sine(f, rate, n, 0.25);
        let y = run_mono(fx.as_mut(), &x);
        let tail = n / 2;
        util::gain_to_db(rms(&y[tail..]) / rms(&x[tail..]))
    }
}
