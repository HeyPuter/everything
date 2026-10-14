// Mixer effects and their parameters. Like instruments/catalog.js this is the
// engine contract: parameters are addressed by index, so append new ones at
// the end of a list. Every slot also has a generic dry/wet `mix` and an
// enabled switch handled by the mixer itself.

const OFF_ON = ['Off', 'On'];

export const DIVISIONS = ['1/64', '1/32', '1/16 triplet', '1/16', '1/16 dotted', '1/8 triplet', '1/8', '1/8 dotted', '1/4 triplet', '1/4', '1/4 dotted', '1/2', '1 bar'];
/** Length of each division in quarter notes, matching DIVISIONS. */
export const DIVISION_BEATS = [1 / 16, 1 / 8, 1 / 6, 1 / 4, 3 / 8, 1 / 3, 1 / 2, 3 / 4, 2 / 3, 1, 3 / 2, 2, 4];

const freq = (id, label, def, min = 20, max = 20000, group) => ({ id, label, min, max, def, unit: 'Hz', curve: 'log', group });
const gain = (id, label, def = 0, min = -18, max = 18, group) => ({ id, label, min, max, def, unit: 'dB', group });
const q = (id, def = 1, group) => ({ id, label: 'Q', min: 0.1, max: 18, def, curve: 'log', group });

export const EFFECTS = {
  eq: {
    label: 'Parametric EQ',
    category: 'Filter and EQ',
    description: 'Low cut, low shelf, two bell bands, high shelf and high cut.',
    params: [
      freq('hp_freq', 'Low cut', 20, 20, 2000, 'Low cut'),
      freq('low_freq', 'Freq', 120, 20, 2000, 'Low shelf'),
      gain('low_gain', 'Gain', 0, -18, 18, 'Low shelf'),
      freq('m1_freq', 'Freq', 500, 40, 16000, 'Band 1'),
      gain('m1_gain', 'Gain', 0, -18, 18, 'Band 1'),
      q('m1_q', 1, 'Band 1'),
      freq('m2_freq', 'Freq', 2500, 40, 16000, 'Band 2'),
      gain('m2_gain', 'Gain', 0, -18, 18, 'Band 2'),
      q('m2_q', 1, 'Band 2'),
      freq('high_freq', 'Freq', 8000, 1000, 20000, 'High shelf'),
      gain('high_gain', 'Gain', 0, -18, 18, 'High shelf'),
      freq('lp_freq', 'High cut', 20000, 1000, 20000, 'High cut'),
      gain('output', 'Output', 0, -24, 12, 'Output'),
    ],
  },
  compressor: {
    label: 'Compressor',
    category: 'Dynamics',
    description: 'Feed-forward compressor with soft knee and makeup gain.',
    params: [
      { id: 'threshold', label: 'Threshold', min: -60, max: 0, def: -18, unit: 'dB' },
      { id: 'ratio', label: 'Ratio', min: 1, max: 20, def: 4, curve: 'log', unit: ':1' },
      { id: 'attack', label: 'Attack', min: 0.1, max: 200, def: 10, unit: 'ms', curve: 'log' },
      { id: 'release', label: 'Release', min: 10, max: 2000, def: 120, unit: 'ms', curve: 'log' },
      { id: 'knee', label: 'Knee', min: 0, max: 24, def: 6, unit: 'dB' },
      gain('makeup', 'Makeup', 0, -12, 24),
    ],
  },
  limiter: {
    label: 'Limiter',
    category: 'Dynamics',
    description: 'Look-ahead brickwall limiter for the master.',
    params: [
      gain('input', 'Gain', 0, 0, 24),
      gain('ceiling', 'Ceiling', -0.3, -12, 0),
      { id: 'release', label: 'Release', min: 1, max: 1000, def: 60, unit: 'ms', curve: 'log' },
    ],
  },
  delay: {
    label: 'Delay',
    category: 'Delay and reverb',
    description: 'Tempo-synced stereo delay with ping-pong and a darkening feedback filter.',
    params: [
      { id: 'sync', label: 'Sync', min: 0, max: 1, def: 1, step: 1, options: OFF_ON },
      { id: 'division', label: 'Time', min: 0, max: DIVISIONS.length - 1, def: 7, step: 1, options: DIVISIONS },
      { id: 'time', label: 'Time (free)', min: 1, max: 2000, def: 350, unit: 'ms', curve: 'log' },
      { id: 'feedback', label: 'Feedback', min: 0, max: 0.95, def: 0.4, unit: '%' },
      { id: 'pingpong', label: 'Ping-pong', min: 0, max: 1, def: 1, step: 1, options: OFF_ON },
      freq('tone', 'Tone', 6000, 200, 20000),
      { id: 'wet', label: 'Wet', min: 0, max: 1, def: 0.3, unit: '%' },
      { id: 'dry', label: 'Dry', min: 0, max: 1, def: 1, unit: '%' },
    ],
  },
  reverb: {
    label: 'Reverb',
    category: 'Delay and reverb',
    description: 'Algorithmic stereo reverb with pre-delay and damping.',
    params: [
      { id: 'size', label: 'Size', min: 0, max: 1, def: 0.6, unit: '%' },
      { id: 'decay', label: 'Decay', min: 0.1, max: 20, def: 2.5, unit: 's', curve: 'log' },
      { id: 'damping', label: 'Damping', min: 0, max: 1, def: 0.5, unit: '%' },
      { id: 'predelay', label: 'Pre-delay', min: 0, max: 200, def: 10, unit: 'ms' },
      { id: 'width', label: 'Width', min: 0, max: 1, def: 1, unit: '%' },
      freq('lowcut', 'Low cut', 120, 20, 1000),
      { id: 'wet', label: 'Wet', min: 0, max: 1, def: 0.25, unit: '%' },
      { id: 'dry', label: 'Dry', min: 0, max: 1, def: 1, unit: '%' },
    ],
  },
  chorus: {
    label: 'Chorus',
    category: 'Modulation',
    description: 'Stereo chorus and flanger.',
    params: [
      { id: 'rate', label: 'Rate', min: 0.05, max: 8, def: 0.8, unit: 'Hz', curve: 'log' },
      { id: 'depth', label: 'Depth', min: 0, max: 1, def: 0.5, unit: '%' },
      { id: 'delay', label: 'Delay', min: 0.5, max: 30, def: 8, unit: 'ms', curve: 'log' },
      { id: 'feedback', label: 'Feedback', min: -0.9, max: 0.9, def: 0, unit: '%' },
      { id: 'spread', label: 'Spread', min: 0, max: 1, def: 0.8, unit: '%' },
      { id: 'wet', label: 'Wet', min: 0, max: 1, def: 0.5, unit: '%' },
    ],
  },
  phaser: {
    label: 'Phaser',
    category: 'Modulation',
    description: 'All-pass phaser with feedback.',
    params: [
      { id: 'rate', label: 'Rate', min: 0.02, max: 8, def: 0.4, unit: 'Hz', curve: 'log' },
      { id: 'depth', label: 'Depth', min: 0, max: 1, def: 0.7, unit: '%' },
      { id: 'stages', label: 'Stages', min: 0, max: 4, def: 2, step: 1, options: ['2', '4', '6', '8', '12'] },
      { id: 'feedback', label: 'Feedback', min: 0, max: 0.95, def: 0.4, unit: '%' },
      freq('center', 'Center', 900, 100, 8000),
      { id: 'wet', label: 'Wet', min: 0, max: 1, def: 0.5, unit: '%' },
    ],
  },
  distortion: {
    label: 'Distortion',
    category: 'Distortion',
    description: 'Saturation and distortion: soft, hard, tube and wavefolding curves.',
    params: [
      { id: 'type', label: 'Type', min: 0, max: 3, def: 0, step: 1, options: ['Soft', 'Hard', 'Tube', 'Fold'] },
      gain('drive', 'Drive', 12, 0, 48),
      freq('tone', 'Tone', 8000, 200, 20000),
      gain('output', 'Output', -6, -24, 12),
      { id: 'wet', label: 'Wet', min: 0, max: 1, def: 1, unit: '%' },
    ],
  },
  bitcrusher: {
    label: 'Bitcrusher',
    category: 'Distortion',
    description: 'Bit depth and sample rate reduction.',
    params: [
      { id: 'bits', label: 'Bits', min: 1, max: 16, def: 8, step: 1 },
      { id: 'downsample', label: 'Downsample', min: 1, max: 32, def: 4, step: 1, curve: 'log' },
      { id: 'wet', label: 'Wet', min: 0, max: 1, def: 1, unit: '%' },
    ],
  },
  filter: {
    label: 'Filter',
    category: 'Filter and EQ',
    description: 'Resonant multimode filter with an LFO.',
    params: [
      { id: 'type', label: 'Type', min: 0, max: 3, def: 0, step: 1, options: ['Low pass', 'High pass', 'Band pass', 'Notch'] },
      freq('cutoff', 'Cutoff', 2000),
      { id: 'reso', label: 'Resonance', min: 0, max: 1, def: 0.3, unit: '%' },
      { id: 'lfo_rate', label: 'LFO rate', min: 0.02, max: 20, def: 1, unit: 'Hz', curve: 'log' },
      { id: 'lfo_depth', label: 'LFO depth', min: 0, max: 1, def: 0, unit: '%' },
    ],
  },
  stereo: {
    label: 'Stereo Tool',
    category: 'Stereo',
    description: 'Stereo width, balance, channel swap and mono bass.',
    params: [
      { id: 'width', label: 'Width', min: 0, max: 2, def: 1, unit: '%' },
      { id: 'balance', label: 'Balance', min: -1, max: 1, def: 0, unit: '%' },
      { id: 'swap', label: 'Swap L/R', min: 0, max: 1, def: 0, step: 1, options: OFF_ON },
      freq('mono_bass', 'Mono below', 20, 20, 500),
    ],
  },
};

export const EFFECT_TYPES = Object.keys(EFFECTS);

export function defaultEffectParams(type) {
  const out = {};
  for (const p of EFFECTS[type]?.params || []) out[p.id] = p.def;
  return out;
}

export function effectParamDef(type, id) {
  return EFFECTS[type]?.params.find((p) => p.id === id) || null;
}

export function effectParamVector(type, params = {}) {
  return (EFFECTS[type]?.params || []).map((p) => (Number.isFinite(params[p.id]) ? params[p.id] : p.def));
}

/** Effect types grouped by category for menus. */
export function effectsByCategory() {
  const out = new Map();
  for (const [type, e] of Object.entries(EFFECTS)) {
    if (!out.has(e.category)) out.set(e.category, []);
    out.get(e.category).push(type);
  }
  return out;
}
