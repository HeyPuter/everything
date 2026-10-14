//! Delay-line effects: the tempo-synced stereo delay (ping-pong, darkening
//! feedback) and the chorus / flanger.

use crate::dsp::*;
use crate::params::DIVISION_BEATS;

/// Fractional read `d` samples behind `pos` in a ring of `buf.len()` samples.
#[inline]
fn tap(buf: &[f32], pos: usize, d: f32) -> f32 {
    let n = buf.len();
    let di = d.floor();
    let t = d - di;
    let i = di as usize;
    let a = buf[(pos + n - i % n) % n];
    let b = buf[(pos + 2 * n - (i + 1) % n) % n];
    a + (b - a) * t
}

// ------------------------------------------------------------------ delay

const DN: usize = 8;
const D_DEFAULTS: [f32; DN] = [1.0, 7.0, 350.0, 0.4, 1.0, 6000.0, 0.3, 1.0];
const MAX_SECONDS: f32 = 4.0;

pub struct Delay {
    pub p: Params<DN>,
    bl: Vec<f32>,
    br: Vec<f32>,
    pos: usize,
    time: f32,
    lpl: OnePole,
    lpr: OnePole,
    wet: f32,
    dry: f32,
    rate: f32,
    sc: f32,
}

impl Delay {
    pub fn new(rate: f32) -> Box<Self> {
        let n = (MAX_SECONDS * rate) as usize + 4;
        Box::new(Delay {
            p: Params::new(&D_DEFAULTS, &[false, false, true, true, false, true, true, true]),
            bl: vec![0.0; n],
            br: vec![0.0; n],
            pos: 0,
            time: -1.0,
            lpl: OnePole::default(),
            lpr: OnePole::default(),
            wet: D_DEFAULTS[6],
            dry: D_DEFAULTS[7],
            rate,
            sc: block_coef(0.02, rate, BLOCK),
        })
    }

    pub fn reset(&mut self) {
        self.bl.iter_mut().for_each(|x| *x = 0.0);
        self.br.iter_mut().for_each(|x| *x = 0.0);
        self.lpl.z = 0.0;
        self.lpr.z = 0.0;
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32], bpm: f32) {
        self.p.step(self.sc);
        let p = &self.p;
        let secs = if p.get(0) >= 0.5 {
            let d = clampf(p.get(1).round(), 0.0, (DIVISION_BEATS.len() - 1) as f32) as usize;
            DIVISION_BEATS[d] * 60.0 / clampf(bpm, 10.0, 999.0)
        } else {
            p.get(2) * 0.001
        };
        let target = clampf(secs * self.rate, 1.0, (self.bl.len() - 3) as f32);
        if self.time < 0.0 {
            self.time = target;
        }
        let fb = clampf(p.get(3), 0.0, 0.98);
        let ping = p.get(4) >= 0.5;
        let a = OnePole::coef(p.get(5), self.rate);
        let (w0, w1) = (self.wet, p.get(6));
        let (d0, d1) = (self.dry, p.get(7));
        self.wet = w1;
        self.dry = d1;
        let tc = 1.0 - (-1.0 / (0.06 * self.rate)).exp();
        let n = l.len();
        let inv = 1.0 / n.max(1) as f32;
        let size = self.bl.len();
        for i in 0..n {
            self.time += (target - self.time) * tc;
            let yl = tap(&self.bl, self.pos, self.time);
            let yr = tap(&self.br, self.pos, self.time);
            let fl = self.lpl.lp(yl, a) * fb;
            let fr = self.lpr.lp(yr, a) * fb;
            let (xl, xr) = (l[i], r[i]);
            if ping {
                self.bl[self.pos] = undenorm((xl + xr) * 0.5 + fr);
                self.br[self.pos] = undenorm(fl);
            } else {
                self.bl[self.pos] = undenorm(xl + fl);
                self.br[self.pos] = undenorm(xr + fr);
            }
            self.pos += 1;
            if self.pos == size {
                self.pos = 0;
            }
            let t = (i + 1) as f32 * inv;
            let wet = lerp(w0, w1, t);
            let dry = lerp(d0, d1, t);
            l[i] = xl * dry + yl * wet;
            r[i] = xr * dry + yr * wet;
        }
        self.lpl.z = undenorm(self.lpl.z);
        self.lpr.z = undenorm(self.lpr.z);
        if !self.lpl.z.is_finite() || !self.lpr.z.is_finite() {
            self.reset();
        }
    }
}

// ------------------------------------------------------------------ chorus

const CN: usize = 6;
const C_DEFAULTS: [f32; CN] = [0.8, 0.5, 8.0, 0.0, 0.8, 0.5];

pub struct Chorus {
    pub p: Params<CN>,
    bl: Vec<f32>,
    br: Vec<f32>,
    pos: usize,
    phase: f32,
    rate: f32,
    sc: f32,
}

impl Chorus {
    pub fn new(rate: f32) -> Box<Self> {
        let n = (0.08 * rate) as usize + 4;
        Box::new(Chorus { p: Params::new(&C_DEFAULTS, &[true; CN]), bl: vec![0.0; n], br: vec![0.0; n], pos: 0, phase: 0.0, rate, sc: block_coef(0.02, rate, BLOCK) })
    }

    pub fn reset(&mut self) {
        self.bl.iter_mut().for_each(|x| *x = 0.0);
        self.br.iter_mut().for_each(|x| *x = 0.0);
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        self.p.step(self.sc);
        let p = &self.p;
        let rate_hz = clampf(p.get(0), 0.01, 20.0);
        let depth = clampf(p.get(1), 0.0, 1.0);
        let base = clampf(p.get(2), 0.1, 40.0) * 0.001 * self.rate;
        let fb = clampf(p.get(3), -0.95, 0.95);
        let spread = clampf(p.get(4), 0.0, 1.0) * 0.5;
        let wet = clampf(p.get(5), 0.0, 1.0);
        let modamt = base * 0.9 * depth;
        let inc = rate_hz / self.rate;
        let size = self.bl.len();
        let maxd = (size - 3) as f32;
        let n = l.len();
        // Modulation at control rate, linearly interpolated.
        let mut i = 0;
        while i < n {
            let m = (n - i).min(CR);
            let pa = self.phase;
            let pb = pa + inc * m as f32;
            let dla = clampf(base + modamt * sin_turns(pa), 1.0, maxd);
            let dlb = clampf(base + modamt * sin_turns(pb), 1.0, maxd);
            let dra = clampf(base + modamt * sin_turns(pa + spread), 1.0, maxd);
            let drb = clampf(base + modamt * sin_turns(pb + spread), 1.0, maxd);
            self.phase = pb - pb.floor();
            for j in 0..m {
                let t = (j + 1) as f32 / m as f32;
                let yl = tap(&self.bl, self.pos, lerp(dla, dlb, t));
                let yr = tap(&self.br, self.pos, lerp(dra, drb, t));
                let (xl, xr) = (l[i + j], r[i + j]);
                self.bl[self.pos] = undenorm(xl + yl * fb);
                self.br[self.pos] = undenorm(xr + yr * fb);
                self.pos += 1;
                if self.pos == size {
                    self.pos = 0;
                }
                l[i + j] = xl * (1.0 - wet) + yl * wet;
                r[i + j] = xr * (1.0 - wet) + yr * wet;
            }
            i += m;
        }
    }
}
