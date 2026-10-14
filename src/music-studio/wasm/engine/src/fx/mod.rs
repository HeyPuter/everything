//! Mixer effects. Each effect owns its parameter block (catalog order) and
//! processes a stereo block in place. Buffers are allocated when the effect
//! is created, never while processing.

mod delay;
mod dynamics;
mod eq;
mod misc;
mod reverb;

use crate::params::*;

pub enum Fx {
    Eq(Box<eq::Eq>),
    Comp(Box<dynamics::Compressor>),
    Limiter(Box<dynamics::Limiter>),
    Delay(Box<delay::Delay>),
    Reverb(Box<reverb::Reverb>),
    Chorus(Box<delay::Chorus>),
    Phaser(Box<misc::Phaser>),
    Dist(Box<misc::Distortion>),
    Crush(Box<misc::Bitcrusher>),
    Filter(Box<misc::Filter>),
    Stereo(Box<misc::StereoTool>),
}

impl Fx {
    pub fn new(kind: i32, rate: f32) -> Option<Fx> {
        Some(match kind {
            FX_EQ => Fx::Eq(eq::Eq::new(rate)),
            FX_COMPRESSOR => Fx::Comp(dynamics::Compressor::new(rate)),
            FX_LIMITER => Fx::Limiter(dynamics::Limiter::new(rate)),
            FX_DELAY => Fx::Delay(delay::Delay::new(rate)),
            FX_REVERB => Fx::Reverb(reverb::Reverb::new(rate)),
            FX_CHORUS => Fx::Chorus(delay::Chorus::new(rate)),
            FX_PHASER => Fx::Phaser(misc::Phaser::new(rate)),
            FX_DISTORTION => Fx::Dist(misc::Distortion::new(rate)),
            FX_BITCRUSHER => Fx::Crush(misc::Bitcrusher::new(rate)),
            FX_FILTER => Fx::Filter(misc::Filter::new(rate)),
            FX_STEREO => Fx::Stereo(misc::StereoTool::new(rate)),
            _ => return None,
        })
    }

    pub fn set(&mut self, i: usize, v: f32) {
        match self {
            Fx::Eq(f) => f.p.set(i, v),
            Fx::Comp(f) => f.p.set(i, v),
            Fx::Limiter(f) => f.p.set(i, v),
            Fx::Delay(f) => f.p.set(i, v),
            Fx::Reverb(f) => f.p.set(i, v),
            Fx::Chorus(f) => f.p.set(i, v),
            Fx::Phaser(f) => f.p.set(i, v),
            Fx::Dist(f) => f.p.set(i, v),
            Fx::Crush(f) => f.p.set(i, v),
            Fx::Filter(f) => f.p.set(i, v),
            Fx::Stereo(f) => f.p.set(i, v),
        }
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32], bpm: f32) {
        match self {
            Fx::Eq(f) => f.process(l, r),
            Fx::Comp(f) => f.process(l, r),
            Fx::Limiter(f) => f.process(l, r),
            Fx::Delay(f) => f.process(l, r, bpm),
            Fx::Reverb(f) => f.process(l, r),
            Fx::Chorus(f) => f.process(l, r),
            Fx::Phaser(f) => f.process(l, r),
            Fx::Dist(f) => f.process(l, r),
            Fx::Crush(f) => f.process(l, r),
            Fx::Filter(f) => f.process(l, r),
            Fx::Stereo(f) => f.process(l, r),
        }
    }

    pub fn reset(&mut self) {
        match self {
            Fx::Eq(f) => f.reset(),
            Fx::Comp(f) => f.reset(),
            Fx::Limiter(f) => f.reset(),
            Fx::Delay(f) => f.reset(),
            Fx::Reverb(f) => f.reset(),
            Fx::Chorus(f) => f.reset(),
            Fx::Phaser(f) => f.reset(),
            Fx::Dist(f) => f.reset(),
            Fx::Crush(f) => f.reset(),
            Fx::Filter(f) => f.reset(),
            Fx::Stereo(f) => f.reset(),
        }
    }
}
