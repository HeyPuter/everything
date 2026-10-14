//! Parametric EQ: low cut, low shelf, two bells, high shelf, high cut and
//! output gain. RBJ cookbook biquads (cuts: 2nd order, Q 0.707; shelves:
//! slope 1), matching src/effects/ui/eq-math.js. The low cut at 20 Hz and the
//! high cut at 20 kHz are bypassed, as are bands at 0 dB (exactly flat).

use crate::dsp::*;

const N: usize = 13;
const DEFAULTS: [f32; N] = [20.0, 120.0, 0.0, 500.0, 0.0, 1.0, 2500.0, 0.0, 1.0, 8000.0, 0.0, 20000.0, 0.0];

pub struct Eq {
    pub p: Params<N>,
    coef: [BiquadCoef; 6],
    on: [bool; 6],
    st: [[Biquad; 6]; 2],
    out: f32,
    rate: f32,
    sc: f32,
}

impl Eq {
    pub fn new(rate: f32) -> Box<Self> {
        Box::new(Eq {
            p: Params::new(&DEFAULTS, &[true; N]),
            coef: [BiquadCoef::identity(); 6],
            on: [false; 6],
            st: [[Biquad::default(); 6]; 2],
            out: 1.0,
            rate,
            sc: block_coef(0.02, rate, BLOCK),
        })
    }

    pub fn reset(&mut self) {
        for c in self.st.iter_mut() {
            for b in c.iter_mut() {
                b.reset();
            }
        }
    }

    fn update(&mut self) {
        let p = &self.p;
        let r = self.rate;
        let on = [
            p.get(0) > 20.0,
            p.get(2).abs() > 0.01,
            p.get(4).abs() > 0.01,
            p.get(7).abs() > 0.01,
            p.get(10).abs() > 0.01,
            p.get(11) < 20_000.0,
        ];
        self.coef[0] = BiquadCoef::highpass(p.get(0), 0.707, r);
        self.coef[1] = BiquadCoef::low_shelf(p.get(1), p.get(2), r);
        self.coef[2] = BiquadCoef::peak(p.get(3), clampf(p.get(5), 0.1, 18.0), p.get(4), r);
        self.coef[3] = BiquadCoef::peak(p.get(6), clampf(p.get(8), 0.1, 18.0), p.get(7), r);
        self.coef[4] = BiquadCoef::high_shelf(p.get(9), p.get(10), r);
        self.coef[5] = BiquadCoef::lowpass(p.get(11).min(r * 0.49), 0.707, r);
        for k in 0..6 {
            if on[k] && !self.on[k] {
                self.st[0][k].reset();
                self.st[1][k].reset();
            }
        }
        self.on = on;
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        if self.p.step(self.sc) {
            self.update();
        }
        let g0 = self.out;
        let g1 = db_to_gain(self.p.get(12));
        self.out = g1;
        let n = l.len();
        for (c, buf) in [l, r].into_iter().enumerate() {
            for k in 0..6 {
                if !self.on[k] {
                    continue;
                }
                let coef = self.coef[k];
                let st = &mut self.st[c][k];
                for x in buf.iter_mut() {
                    *x = st.run(&coef, *x);
                }
                st.flush();
            }
            let inv = 1.0 / n.max(1) as f32;
            for (i, x) in buf.iter_mut().enumerate() {
                *x *= lerp(g0, g1, (i + 1) as f32 * inv);
            }
        }
    }
}
