//! Algorithmic stereo reverb: pre-delay, a low cut, four input diffusers and
//! an 8-line feedback delay network (Hadamard mixing) with per-line damping
//! and slowly modulated line lengths, then stereo width on the wet signal.

use crate::dsp::*;

const RN: usize = 8;
const R_DEFAULTS: [f32; RN] = [0.6, 2.5, 0.5, 10.0, 1.0, 120.0, 0.25, 1.0];
const LINES: usize = 8;
/// Line lengths in milliseconds at size 1 (mutually prime-ish).
const LEN_MS: [f32; LINES] = [53.1, 61.7, 71.3, 79.9, 89.3, 97.7, 107.9, 116.3];
const DIFF_MS: [f32; 4] = [4.77, 3.59, 12.73, 9.31];
const MAX_PRE_MS: f32 = 250.0;

struct Line {
    buf: Vec<f32>,
    pos: usize,
    lp: f32,
}

struct Allpass {
    buf: Vec<f32>,
    pos: usize,
}

impl Allpass {
    #[inline]
    fn run(&mut self, x: f32, g: f32) -> f32 {
        let d = self.buf[self.pos];
        let v = x + d * g;
        self.buf[self.pos] = undenorm(v);
        self.pos += 1;
        if self.pos == self.buf.len() {
            self.pos = 0;
        }
        d - v * g
    }
}

pub struct Reverb {
    pub p: Params<RN>,
    lines: [Line; LINES],
    len: [f32; LINES],
    gain: [f32; LINES],
    diff_l: [Allpass; 2],
    diff_r: [Allpass; 2],
    pre_l: Vec<f32>,
    pre_r: Vec<f32>,
    pre_pos: usize,
    hp_l: OnePole,
    hp_r: OnePole,
    damp: f32,
    lfo: f32,
    wet: f32,
    dry: f32,
    rate: f32,
    sc: f32,
}

#[inline]
fn hadamard(x: &mut [f32; LINES]) {
    let mut h = 1;
    while h < LINES {
        let mut i = 0;
        while i < LINES {
            for j in i..i + h {
                let a = x[j];
                let b = x[j + h];
                x[j] = a + b;
                x[j + h] = a - b;
            }
            i += h * 2;
        }
        h *= 2;
    }
    let s = 0.353_553_4; // 1 / sqrt(8)
    for v in x.iter_mut() {
        *v *= s;
    }
}

impl Reverb {
    pub fn new(rate: f32) -> Box<Self> {
        let k = rate / 1000.0;
        let line = |ms: f32| Line { buf: vec![0.0; (ms * 1.6 * k) as usize + 64], pos: 0, lp: 0.0 };
        let ap = |ms: f32| Allpass { buf: vec![0.0; ((ms * k) as usize).max(1)], pos: 0 };
        let pre = (MAX_PRE_MS * k) as usize + 2;
        Box::new(Reverb {
            p: Params::new(&R_DEFAULTS, &[true; RN]),
            lines: [line(LEN_MS[0]), line(LEN_MS[1]), line(LEN_MS[2]), line(LEN_MS[3]), line(LEN_MS[4]), line(LEN_MS[5]), line(LEN_MS[6]), line(LEN_MS[7])],
            len: [1.0; LINES],
            gain: [0.0; LINES],
            diff_l: [ap(DIFF_MS[0]), ap(DIFF_MS[2])],
            diff_r: [ap(DIFF_MS[1]), ap(DIFF_MS[3])],
            pre_l: vec![0.0; pre],
            pre_r: vec![0.0; pre],
            pre_pos: 0,
            hp_l: OnePole::default(),
            hp_r: OnePole::default(),
            damp: 0.5,
            lfo: 0.0,
            wet: R_DEFAULTS[6],
            dry: R_DEFAULTS[7],
            rate,
            sc: block_coef(0.03, rate, BLOCK),
        })
    }

    pub fn reset(&mut self) {
        for l in self.lines.iter_mut() {
            l.buf.iter_mut().for_each(|x| *x = 0.0);
            l.lp = 0.0;
        }
        for a in self.diff_l.iter_mut().chain(self.diff_r.iter_mut()) {
            a.buf.iter_mut().for_each(|x| *x = 0.0);
        }
        self.pre_l.iter_mut().for_each(|x| *x = 0.0);
        self.pre_r.iter_mut().for_each(|x| *x = 0.0);
        self.hp_l.z = 0.0;
        self.hp_r.z = 0.0;
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        self.p.step(self.sc);
        let p = &self.p;
        let k = self.rate / 1000.0;
        let size = 0.35 + 1.25 * clampf(p.get(0), 0.0, 1.0);
        let t60 = clampf(p.get(1), 0.05, 60.0);
        for i in 0..LINES {
            let max = (self.lines[i].buf.len() - 40) as f32;
            self.len[i] = clampf(LEN_MS[i] * size * k, 16.0, max);
            // Feedback gain for -60 dB after t60 seconds.
            self.gain[i] = fast_exp2(-9.966 * self.len[i] / (t60 * self.rate));
        }
        let damp = clampf(p.get(2), 0.0, 1.0);
        let damp_hz = 18_000.0 * fast_exp2(-damp * 3.6);
        let da = OnePole::coef(damp_hz, self.rate);
        let pre = clampf(p.get(3), 0.0, MAX_PRE_MS) * k;
        let width = clampf(p.get(4), 0.0, 1.0);
        let ha = OnePole::coef(clampf(p.get(5), 10.0, 5000.0), self.rate);
        let (w0, w1) = (self.wet, clampf(p.get(6), 0.0, 1.0));
        let (d0, d1) = (self.dry, clampf(p.get(7), 0.0, 1.0));
        self.wet = w1;
        self.dry = d1;
        self.damp = da;
        let n = l.len();
        let inv = 1.0 / n.max(1) as f32;
        let pre_n = self.pre_l.len();
        let pre_i = (pre as usize).min(pre_n - 1);
        // Slow modulation of line lengths (per block).
        self.lfo += 0.7 * n as f32 / self.rate;
        if self.lfo >= 1.0 {
            self.lfo -= 1.0;
        }
        let mut modd = [0.0f32; LINES];
        for (i, m) in modd.iter_mut().enumerate() {
            *m = sin_turns(self.lfo + i as f32 * 0.125) * 0.25 * k;
        }
        for i in 0..n {
            let (xl, xr) = (l[i], r[i]);
            // Pre-delay.
            self.pre_l[self.pre_pos] = xl;
            self.pre_r[self.pre_pos] = xr;
            let rd = (self.pre_pos + pre_n - pre_i) % pre_n;
            let (pl, pr) = (self.pre_l[rd], self.pre_r[rd]);
            self.pre_pos += 1;
            if self.pre_pos == pre_n {
                self.pre_pos = 0;
            }
            let mut il = self.hp_l.hp(pl, ha);
            let mut ir = self.hp_r.hp(pr, ha);
            for a in self.diff_l.iter_mut() {
                il = a.run(il, 0.6);
            }
            for a in self.diff_r.iter_mut() {
                ir = a.run(ir, 0.6);
            }
            // Read the lines.
            let mut y = [0.0f32; LINES];
            for j in 0..LINES {
                let line = &mut self.lines[j];
                let len = line.buf.len();
                let d = self.len[j] + modd[j];
                let di = d as usize;
                let t = d - di as f32;
                let a = line.buf[(line.pos + len - di) % len];
                let b = line.buf[(line.pos + len - di - 1) % len];
                let v = a + (b - a) * t;
                line.lp += (v - line.lp) * da;
                y[j] = line.lp * self.gain[j];
            }
            let ol = y[0] + y[2] + y[4] + y[6];
            let or = y[1] + y[3] + y[5] + y[7];
            hadamard(&mut y);
            for j in 0..LINES {
                let inj = if j & 1 == 0 { il } else { ir };
                let line = &mut self.lines[j];
                line.buf[line.pos] = undenorm(y[j] + inj * 0.5);
                line.pos += 1;
                if line.pos == line.buf.len() {
                    line.pos = 0;
                }
            }
            // Width on the wet signal.
            let m = (ol + or) * 0.5;
            let s = (ol - or) * 0.5 * width;
            let t = (i + 1) as f32 * inv;
            let wet = lerp(w0, w1, t) * 0.7;
            let dry = lerp(d0, d1, t);
            l[i] = xl * dry + (m + s) * wet;
            r[i] = xr * dry + (m - s) * wet;
        }
        for line in self.lines.iter_mut() {
            line.lp = undenorm(line.lp);
            if !line.lp.is_finite() {
                self.reset();
                break;
            }
        }
    }
}
