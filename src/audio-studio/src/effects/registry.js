// Effect registry: the contract between DSP (wasm/dsp/src/fx), effect dialogs,
// the Effects Rack, favorites and track effect chains.
//
// An effect definition:
// {
//   id: 'parametricEq',            // matches the menu command fx.<id>
//   name: 'Parametric Equalizer',
//   group: 'Filter and EQ',        // EFFECT_GROUPS label in ui/menus.js
//   topLevel: true,                // optional: listed directly in the Effects menu (Repair DC
//                                  // Offset) instead of in its group's submenu
//   kind: 12,                      // WASM processor kind (fx/mod.rs create()), or null for offline-only effects
//   params: [                      // order = WASM parameter index
//     { id: 'gain', label: 'Gain', min: -24, max: 24, step: 0.1, default: 0, unit: 'dB',
//       scale: 'linear' | 'log', type: 'number' | 'bool' | 'choice', options: [{ value, label }],
//       sig: 4,                     // optional: kept and shown to 4 significant digits instead of
//                                  // the step's decimals (a Q of 0.7071; the step still moves it)
//       section: 'Band 1',          // optional grouping label for dialogs
//       hidden: true },             // optional: driven by a custom editor, not a plain control
//     // Data params hold JSON-able structures instead of numbers. They keep their
//     // index (WASM receives 0 there) and reach the processor through `data`:
//     { id: 'curve', type: 'curve', default: [{ f: 20, g: 0 }, { f: 20000, g: 0 }],
//       min: -60, max: 24, unit: 'dB' },      // frequency curve: f in Hz, g in dB
//     { id: 'envelope', type: 'envelope', default: [{ t: 0, v: 1 }, { t: 1, v: 1 }],
//       min: 0, max: 4, unit: '%' },          // t: 0..1 across the range, v in [min, max]
//                                  // optional render: (points, n, values) => Float32Array draws
//                                  // the curve the process applies (n samples across)
//     { id: 'curve', type: 'transfer', default: [{ x: -100, y: -100 }, { x: 0, y: 0 }],
//       min: -100, max: 0, unit: 'dB' },      // level transfer curve: input x to output y in dBFS
//   ],
//   presets: [{ name: 'Default', values: { gain: 0 } }],
//   realtime: true,                // usable in the Effects Rack and track chains
//   tail: (values, rate) => frames // extra frames to render after the selection (reverb, delay)
//   latency: (values, rate) => frames // processing delay (lookahead, STFT); renders must
//                                  // drop this many leading frames (applyChain `latency`)
//   data: (values, { doc, rate }) => [{ slot, id, values: Float32Array }]
//                                  // optional blocks uploaded with fx_data (curves, impulses,
//                                  // noise prints); `id` changes only when the data changes
//   process: async ({ channels, rate, values, signal, onProgress, doc, app }) =>
//             Float32Array[] | { channels: Float32Array[], markers?: [{ start, duration, name }] }
//                                  // optional offline implementation (noise reduction, stretch...).
//                                  // `channels` are the selected range; the result may have a
//                                  // different length (stretch, delete silence) and replaces the
//                                  // range. Returned markers are relative to the range start and
//                                  // the caller adds them to the document (Mark Audio).
//   response: (values, freqs, rate) => Float32Array // optional dB response per frequency,
//                                  // for drawing EQ and filter curves
//   needsNoisePrint: true          // optional: process/realtime use doc.noisePrint
//   needsSoundModel: true          // optional: process uses doc.soundModel (Learn Sound Model)
//   tasks: { name: async (args) => result } // optional worker helpers (offline-fx.js runTask)
//   editor: (ctx) => HTMLElement   // optional custom dialog body (EQ curve, graph...); ctx has
//                                  // { values, set(id, value), def, app, doc, onReadout(fn), onClose(fn) }
//   measureOnly: true              // optional: passes audio through unchanged to measure it
//                                  // (Loudness Meter); its dialog has no Apply
//   display: 'loudness'            // optional: a built-in live display for the dialog (editors.js)
//   surround: true                 // optional: also runs on 5.1 (6-channel tracks, a 5.1 master),
//                                  // created with six channels (slotSpec `channels`)
//   readout: true                  // optional: the processor reports live readings (fx_readout:
//                                  // meters, detector levels) while playing; editors receive them
//                                  // through ctx.onReadout(fn(Float32Array))
// }

export const EFFECTS = new Map();

export function registerEffect(def) {
  EFFECTS.set(def.id, { realtime: def.kind != null, presets: [], ...def });
  return def;
}

export function getEffect(id) {
  return EFFECTS.get(id) || null;
}

/** Default parameter values keyed by param id. */
export function defaults(def) {
  return Object.fromEntries(def.params.map((p) => [p.id, p.default]));
}

/** Values keyed by id to the WASM parameter array (declared order). */
export function paramArray(def, values) {
  return def.params.map((p) => {
    const v = values[p.id] ?? p.default;
    if (typeof v === 'boolean') return v ? 1 : 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0; // data params (curves, envelopes) travel through `data`
  });
}

/**
 * A slot spec for FxHost / the mix graph. Pass `doc` and `rate` for effects
 * with `data` (FFT Filter curve, convolution impulse, noise print), and a
 * channel `route` (routing.js) to feed and write chosen channels.
 */
export function slotSpec(def, values, { key = def.id, enabled = true, mix = 1, doc = null, rate = doc?.sampleRate ?? 48000, route = null, channels = 2 } = {}) {
  const spec = { key, kind: def.kind, params: paramArray(def, values), enabled, mix };
  // On a 5.1 chain a surround-capable effect gets all six channels; the others are not run there.
  if (channels === 6 && def.surround) spec.channels = 6;
  if (route && !(route.in[0] === 0 && route.in[1] === 1 && route.out[0] === 0 && route.out[1] === 1)) spec.route = { in: [...route.in], out: [...route.out] };
  if (def.readout) spec.readout = true;
  if (def.data) spec.data = def.data({ ...defaults(def), ...values }, { doc, rate }) || [];
  return spec;
}

// The one effect the foundation ships; the effects modules register the rest.
registerEffect({
  id: 'amplify',
  name: 'Amplify',
  group: 'Amplitude and Compression',
  kind: 1,
  about: 'Raises or lowers the level of each channel. Link the sliders to keep the channels balanced.',
  params: [
    { id: 'left', label: 'Left', min: -96, max: 48, step: 0.1, default: 0, unit: 'dB', section: 'Gain' },
    { id: 'right', label: 'Right', min: -96, max: 48, step: 0.1, default: 0, unit: 'dB', section: 'Gain' },
    { id: 'linked', label: 'Link Sliders', type: 'bool', default: true, section: 'Gain' },
  ],
  presets: [
    { name: 'Default', values: { left: 0, right: 0, linked: true } },
    { name: '+3 dB Boost', values: { left: 3, right: 3, linked: true } },
    { name: '+10 dB Boost', values: { left: 10, right: 10, linked: true } },
    { name: '-3 dB Cut', values: { left: -3, right: -3, linked: true } },
    { name: '-10 dB Cut', values: { left: -10, right: -10, linked: true } },
  ],
});
