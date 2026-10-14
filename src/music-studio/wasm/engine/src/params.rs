//! Parameter layout: indices into each instrument's and effect's parameter
//! vector. The order matches src/instruments/catalog.js and
//! src/effects/catalog.js exactly (tests/engine-wasm.test.js checks the counts).

// Instrument types, in INSTRUMENT_TYPES order.
pub const INST_SYNTH: i32 = 0;
pub const INST_DRUM: i32 = 1;
pub const INST_SAMPLER: i32 = 2;
pub const INST_AUDIO: i32 = 3;
pub const INST_TYPES: usize = 4;

pub const INST_PARAM_COUNTS: [u32; INST_TYPES] = [38, 10, 17, 3];

/// Poly Synth.
pub mod synth {
    pub const OSC1_WAVE: usize = 0;
    pub const OSC1_OCT: usize = 1;
    pub const OSC1_SEMI: usize = 2;
    pub const OSC1_FINE: usize = 3;
    pub const OSC1_LEVEL: usize = 4;
    pub const OSC2_WAVE: usize = 5;
    pub const OSC2_OCT: usize = 6;
    pub const OSC2_SEMI: usize = 7;
    pub const OSC2_FINE: usize = 8;
    pub const OSC2_LEVEL: usize = 9;
    pub const SUB_LEVEL: usize = 10;
    pub const NOISE_LEVEL: usize = 11;
    pub const UNISON: usize = 12;
    pub const DETUNE: usize = 13;
    pub const SPREAD: usize = 14;
    pub const FLT_TYPE: usize = 15;
    pub const CUTOFF: usize = 16;
    pub const RESO: usize = 17;
    pub const FLT_ENV: usize = 18;
    pub const FLT_KEY: usize = 19;
    pub const F_ATTACK: usize = 20;
    pub const F_DECAY: usize = 21;
    pub const F_SUSTAIN: usize = 22;
    pub const F_RELEASE: usize = 23;
    pub const A_ATTACK: usize = 24;
    pub const A_DECAY: usize = 25;
    pub const A_SUSTAIN: usize = 26;
    pub const A_RELEASE: usize = 27;
    pub const LFO_WAVE: usize = 28;
    pub const LFO_RATE: usize = 29;
    pub const LFO_PITCH: usize = 30;
    pub const LFO_CUTOFF: usize = 31;
    pub const LFO_AMP: usize = 32;
    pub const GLIDE: usize = 33;
    pub const MONO: usize = 34;
    pub const VEL_AMP: usize = 35;
    pub const VEL_CUTOFF: usize = 36;
    pub const GAIN: usize = 37;
    pub const COUNT: usize = 38;
    pub const DEFAULTS: [f32; COUNT] = [
        2.0, 0.0, 0.0, 0.0, 0.8, 3.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 12.0, 0.6, 0.0, 8000.0, 0.15, 0.0, 0.3, 5.0, 300.0,
        0.4, 300.0, 3.0, 200.0, 0.8, 250.0, 0.0, 4.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.7, 0.2, 0.7,
    ];
}

/// Drum Synth.
pub mod drum {
    pub const KIND: usize = 0;
    pub const TUNE: usize = 1;
    pub const DECAY: usize = 2;
    pub const TONE: usize = 3;
    pub const PUNCH: usize = 4;
    pub const NOISE: usize = 5;
    pub const DRIVE: usize = 6;
    pub const GAIN: usize = 7;
    pub const VEL_AMP: usize = 8;
    pub const KEY_TRACK: usize = 9;
    pub const COUNT: usize = 10;
    pub const DEFAULTS: [f32; COUNT] = [0.0, 0.0, 1.0, 0.5, 0.5, 0.5, 0.0, 0.8, 0.8, 0.0];

    pub const KICK: u8 = 0;
    pub const SNARE: u8 = 1;
    pub const CLAP: u8 = 2;
    pub const CLOSED_HAT: u8 = 3;
    pub const OPEN_HAT: u8 = 4;
    pub const TOM: u8 = 5;
    pub const RIM: u8 = 6;
    pub const CYMBAL: u8 = 7;
    pub const COWBELL: u8 = 8;
    pub const SHAKER: u8 = 9;
    pub const KINDS: u8 = 10;
}

/// Sampler.
pub mod sampler {
    pub const ROOT: usize = 0;
    pub const TUNE: usize = 1;
    pub const FINE: usize = 2;
    pub const START: usize = 3;
    pub const END: usize = 4;
    pub const LOOP: usize = 5;
    pub const REVERSE: usize = 6;
    pub const TRACK: usize = 7;
    pub const ONESHOT: usize = 8;
    pub const A_ATTACK: usize = 9;
    pub const A_DECAY: usize = 10;
    pub const A_SUSTAIN: usize = 11;
    pub const A_RELEASE: usize = 12;
    pub const CUTOFF: usize = 13;
    pub const RESO: usize = 14;
    pub const VEL_AMP: usize = 15;
    pub const GAIN: usize = 16;
    pub const COUNT: usize = 17;
    pub const DEFAULTS: [f32; COUNT] = [60.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1000.0, 1.0, 60.0, 20000.0, 0.0, 0.6, 0.8];
}

/// Audio clip channel.
pub mod audio {
    pub const GAIN: usize = 0;
    pub const TUNE: usize = 1;
    pub const REVERSE: usize = 2;
    pub const COUNT: usize = 3;
    pub const DEFAULTS: [f32; COUNT] = [0.8, 0.0, 0.0];
}

// Effect types, in EFFECT_TYPES order.
pub const FX_EQ: i32 = 0;
pub const FX_COMPRESSOR: i32 = 1;
pub const FX_LIMITER: i32 = 2;
pub const FX_DELAY: i32 = 3;
pub const FX_REVERB: i32 = 4;
pub const FX_CHORUS: i32 = 5;
pub const FX_PHASER: i32 = 6;
pub const FX_DISTORTION: i32 = 7;
pub const FX_BITCRUSHER: i32 = 8;
pub const FX_FILTER: i32 = 9;
pub const FX_STEREO: i32 = 10;
pub const FX_TYPES: usize = 11;

pub const FX_PARAM_COUNTS: [u32; FX_TYPES] = [13, 6, 3, 8, 8, 6, 6, 5, 3, 5, 4];

/// Delay division lengths in quarter notes (effects/catalog.js DIVISION_BEATS).
pub const DIVISION_BEATS: [f32; 13] = [
    1.0 / 16.0,
    1.0 / 8.0,
    1.0 / 6.0,
    1.0 / 4.0,
    3.0 / 8.0,
    1.0 / 3.0,
    1.0 / 2.0,
    3.0 / 4.0,
    2.0 / 3.0,
    1.0,
    3.0 / 2.0,
    2.0,
    4.0,
];
