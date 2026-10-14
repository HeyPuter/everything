//! Dynamics: a feed-forward soft-knee compressor and a look-ahead brickwall
//! limiter.

use crate::dsp::*;

// ------------------------------------------------------------------ compressor

const CN: usize = 6;
const C_DEFAULTS: [f32; CN] = [-18.0, 4.0, 10.0, 120.0, 6.0, 0.0];

pub struct Compressor {
    pub p: Params<CN>,
    env: f32,
    makeup: f32,
    rate: f32,
    sc: f32,
}

impl Compressor {
    pub fn new(rate: f32) -> Box<Self> {
        Box::new(Compressor { p: Params::new(&C_DEFAULTS, &[true, true, false, false, true, true]), env: 0.0, makeup: 1.0, rate, sc: block_coef(0.02, rate, BLOCK) })
    }

    pub fn reset(&mut self) {
        self.env = 0.0;
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        self.p.step(self.sc);
        let th = self.p.get(0);
        let ratio = clampf(self.p.get(1), 1.0, 100.0);
        let att = tau_coef(clampf(self.p.get(2), 0.01, 1000.0) * 0.001, self.rate);
        let rel = tau_coef(clampf(self.p.get(3), 1.0, 5000.0) * 0.001, self.rate);
        let knee = clampf(self.p.get(4), 0.0, 48.0);
        let slope = 1.0 / ratio - 1.0;
        let g0 = self.makeup;
        let g1 = db_to_gain(self.p.get(5));
        self.makeup = g1;
        let n = l.len();
        let inv = 1.0 / n.max(1) as f32;
        let mut env = self.env;
        for i in 0..n {
            let x = l[i].abs().max(r[i].abs());
            let xdb = gain_to_db(x + 1e-9);
            let over = xdb - th;
            let gr = if knee > 0.0 && 2.0 * over.abs() <= knee {
                let t = over + knee * 0.5;
                slope * t * t / (2.0 * knee)
            } else if over > 0.0 {
                slope * over
            } else {
                0.0
            };
            env = if gr < env { gr + (env - gr) * att } else { gr + (env - gr) * rel };
            let g = db_to_gain(env) * lerp(g0, g1, (i + 1) as f32 * inv);
            l[i] *= g;
            r[i] *= g;
        }
        self.env = if env.is_finite() { env } else { 0.0 };
    }
}

// ------------------------------------------------------------------ limiter

const LN: usize = 3;
const L_DEFAULTS: [f32; LN] = [0.0, -0.3, 60.0];
/// Look-ahead in seconds (also the latency the limiter adds).
const LOOKAHEAD: f32 = 0.002;

pub struct Limiter {
    pub p: Params<LN>,
    la: usize,
    dl: Vec<f32>,
    dr: Vec<f32>,
    dpos: usize,
    // Sliding minimum (monotonic deque over a ring).
    dq_v: Vec<f32>,
    dq_i: Vec<u32>,
    head: usize,
    len: usize,
    n: u32,
    // Box smoothing of the held gain.
    bx: Vec<f32>,
    bpos: usize,
    bsum: f64,
    env: f32,
    gin: f32,
    rate: f32,
    sc: f32,
}

impl Limiter {
    pub fn new(rate: f32) -> Box<Self> {
        let la = ((LOOKAHEAD * rate) as usize).max(4);
        Box::new(Limiter {
            p: Params::new(&L_DEFAULTS, &[true, true, false]),
            la,
            dl: vec![0.0; la + 1],
            dr: vec![0.0; la + 1],
            dpos: 0,
            dq_v: vec![1.0; la + 2],
            dq_i: vec![0; la + 2],
            head: 0,
            len: 0,
            n: 0,
            bx: vec![1.0; la],
            bpos: 0,
            bsum: la as f64,
            env: 1.0,
            gin: 1.0,
            rate,
            sc: block_coef(0.02, rate, BLOCK),
        })
    }

    pub fn reset(&mut self) {
        self.dl.iter_mut().for_each(|x| *x = 0.0);
        self.dr.iter_mut().for_each(|x| *x = 0.0);
        self.len = 0;
        self.bx.iter_mut().for_each(|x| *x = 1.0);
        self.bsum = self.la as f64;
        self.env = 1.0;
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        self.p.step(self.sc);
        let g0 = self.gin;
        let g1 = db_to_gain(self.p.get(0));
        self.gin = g1;
        let ceil = db_to_gain(clampf(self.p.get(1), -60.0, 0.0));
        let rel = 1.0 - tau_coef(clampf(self.p.get(2), 0.1, 5000.0) * 0.001, self.rate);
        let la = self.la;
        let w = (la + 1) as u32;
        let cap = self.dq_v.len();
        let nfr = l.len();
        let inv = 1.0 / nfr.max(1) as f32;
        let inv_la = 1.0 / la as f64;
        for i in 0..nfr {
            let gi = lerp(g0, g1, (i + 1) as f32 * inv);
            let xl = l[i] * gi;
            let xr = r[i] * gi;
            let pk = xl.abs().max(xr.abs());
            let g = if pk > ceil { ceil / pk } else { 1.0 };
            // Push into the min-deque.
            while self.len > 0 {
                let back = (self.head + self.len - 1) % cap;
                if self.dq_v[back] >= g {
                    self.len -= 1;
                } else {
                    break;
                }
            }
            let at = (self.head + self.len) % cap;
            self.dq_v[at] = g;
            self.dq_i[at] = self.n;
            self.len += 1;
            while self.n.wrapping_sub(self.dq_i[self.head]) >= w {
                self.head = (self.head + 1) % cap;
                self.len -= 1;
            }
            self.n = self.n.wrapping_add(1);
            let h = self.dq_v[self.head];
            self.env = if h < self.env { h } else { self.env + (h - self.env) * rel };
            self.bsum += (self.env - self.bx[self.bpos]) as f64;
            self.bx[self.bpos] = self.env;
            self.bpos += 1;
            if self.bpos == la {
                self.bpos = 0;
            }
            let gain = (self.bsum * inv_la) as f32;
            // Delay the audio by the look-ahead.
            let dl = self.dl[self.dpos];
            let dr = self.dr[self.dpos];
            self.dl[self.dpos] = xl;
            self.dr[self.dpos] = xr;
            self.dpos += 1;
            if self.dpos == la {
                self.dpos = 0;
            }
            l[i] = clampf(dl * gain, -ceil, ceil);
            r[i] = clampf(dr * gain, -ceil, ceil);
        }
        if !self.bsum.is_finite() || !self.env.is_finite() {
            self.reset();
        }
    }
}
