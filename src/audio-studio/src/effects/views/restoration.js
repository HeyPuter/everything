// Dialog views for Noise Reduction / Restoration effects: DeHummer's notch
// graph, Hiss Reduction's captured noise floor, the Sound Remover's model tools, focus buttons for DeNoise and
// DeReverb, and Advanced sections for the fine-tuning parameters.

import { h, announce } from '../../lib/dom.js';
import { registerEditor } from '../editors.js';
import { cssVar } from '../../ui/theme.js';
import { select } from '../../ui/controls.js';
import { icon } from '../../ui/icons.js';
import { labelText, envelopeControl } from '../editors.js';
import { controlsFor, disclosure, radioChoice, vSlider, groupBox, glyph, enableWhen, checkbox, readout } from '../layout.js';
import { responseEditor, spectrumMonitor, hzLabel, needBanner } from './common.js';
import { learnSoundModel, MAX_SOUND_SECONDS, captureNoisePrint, floorPoints, floorAt, FLOOR_DB, humIn, humInSources } from '../defs/restoration.js';
import { getEffect } from '../registry.js';
import { dsp } from '../../audio/dsp.js';
import { downloadBlob, pickLocalFiles } from '../../storage/files.js';
import { encodeWav } from '../../audio/wav.js';
import { decodeAudio } from '../../audio/decode.js';

// DeHummer: the comb of hum notches, with a handle on the base notch
// (drag sideways for the hum frequency, down for depth; Alt+arrows or the
// wheel change Q). With Auto on, the graph shows the notches at the detected
// fundamental, a line under it says what was found, and dragging the base
// notch switches to a manual frequency.
const dehummer = (ctx) => {
  const def = getEffect('dehummer');
  // A file's audio, or on a session track or clip chain the audio its clips play.
  const hum = () => (ctx.values.auto ? humIn(ctx.doc?.state, ctx.range, ctx.doc) || (ctx.doc ? null : humInSources(ctx.sources)) : null);
  const shown = (v) => (v.auto ? { ...v, frequency: hum()?.frequency ?? v.frequency } : v);
  const manual = Object.create(ctx);
  manual.set = (id, value) => {
    if (id === 'frequency' && ctx.values.auto) ctx.set('auto', false);
    ctx.set(id, value);
  };
  const graph = responseEditor({
    label: 'Hum filter response',
    span: [-80, 6],
    step: 10,
    response: (v, freqs, rate) => def.response(shown(v), freqs, rate),
    handles: (v) => {
      const s = shown(v);
      return [{ label: 'Base notch', freq: s.frequency, gain: s.gain, q: s.q, ids: { freq: 'frequency', gain: 'gain', q: 'q' } }];
    },
    centers: (v) => {
      const s = shown(v);
      return Array.from({ length: Math.max(1, Math.round(s.harmonics)) }, (_, k) => s.frequency * (k + 1));
    },
  })(manual);
  const note = h('div.hum-detected.faint', { role: 'status' });
  const update = () => {
    const v = ctx.values;
    const found = hum();
    note.hidden = !v.auto;
    const playing = !ctx.doc && ctx.sources?.()?.length;
    note.textContent = !v.auto ? '' : found ? `Detected hum: ${found.frequency.toFixed(1)} Hz${playing ? ' in the clips' : ''}` : ctx.doc || playing ? `No steady hum found; using ${v.frequency.toFixed(1)} Hz` : `Detects the hum when applied; until then ${v.frequency.toFixed(1)} Hz`;
  };
  ctx.subscribe(update);
  update();
  return h('div.fx-stack', graph, note);
};

// ------------------------------------------------------- DeNoise, DeReverb

/** Glyphs for the processing focus choices: all, lows, mids, highs, lows and highs. */
const focusIcons = () => ({
  0: glyph('M3 12h18'),
  1: glyph('M3 9h6l4 6h8'),
  2: glyph('M3 15h4l3-6h4l3 6h4'),
  3: glyph('M3 15h8l4-6h6'),
  4: glyph('M3 9h4l3 6h4l3-6h4'),
});

/**
 * Amount and focus on the left; on the right the gain fader under a
 * checkbox (DeNoise: output noise only; DeReverb: auto gain, which takes
 * over from the fader).
 */
const focusView = (extra, check) => {
  const view = (ctx) =>
    h(
      'div.fx-split.rs-focus',
      h('div.fx-stack', spectrumMonitor(ctx), radioChoice(ctx, 'focus', { icons: focusIcons(), className: 'fx-segmented' }), controlsFor(ctx, ['amount', ...extra])),
      groupBox('', checkbox(ctx, check), check === 'autoGain' ? enableWhen(ctx, vSlider(ctx, 'gain', { meter: 'out' }), (v) => !v.autoGain) : vSlider(ctx, 'gain', { meter: 'out' })),
    );
  view.hides = true;
  return view;
};

// ---------------------------------------------------------- Hiss Reduction

const HISS_CHANNELS = ['floorLeft', 'floorRight'];

/** Where the graph draws the floor while it is tracked automatically (a flat line to start a manual one from). */
export const AUTO_FLOOR_DB = -70;

/**
 * The noise floor graph: the captured floor of the chosen channel as
 * editable points over a linear or log frequency axis, and dashed, the
 * threshold the Noise Floor slider sets above it. Without a capture the
 * floor is tracked from the audio: the graph draws a flat line with the
 * same axes, and dragging that line sets a manual floor for every channel.
 */
function hissFloorGraph(ctx, getChannel) {
  const rate = ctx.doc?.sampleRate || 48000;
  const nyq = rate / 2;
  const [min, max] = FLOOR_DB;
  const box = h('div.hr-graph');
  let built = null;
  let last = '';
  const id = () => HISS_CHANNELS[getChannel()];
  const captured = () => Boolean(ctx.values[id()]?.length);
  const build = () => {
    const log = ctx.values.floorScale === 1;
    const toT = (f) => (log ? Math.log(Math.max(20, f) / 20) / Math.log(nyq / 20) : Math.min(1, f / nyq));
    const toF = (t) => (log ? 20 * (nyq / 20) ** t : Math.max(1, t * nyq));
    const auto = !captured();
    const pts = auto ? [{ f: 1, g: AUTO_FLOOR_DB }, { f: nyq, g: AUTO_FLOOR_DB }] : ctx.values[id()];
    last = JSON.stringify(ctx.values[id()] || []);
    const ticks = log ? [100, 1000, 10000].filter((f) => f < nyq) : [0.25, 0.5, 0.75].map((x) => Math.round((x * nyq) / 1000) * 1000);
    const yTicks = [];
    for (let d = min + 20; d < max; d += 20) yTicks.push(d);
    let shown = pts;
    const el = envelopeControl({
      param: { label: 'Noise floor', min, max, unit: 'dB', step: 0.1 },
      value: pts.map((q) => ({ t: toT(q.f), v: q.g })),
      onChange: (env) => {
        const next = env.map((q) => ({ f: Math.round(toF(q.t) * 10) / 10, g: Math.round(q.v * 10) / 10 }));
        shown = next;
        last = JSON.stringify(next);
        // Editing the automatic line starts a manual floor on every channel.
        if (auto && !ctx.values.floorLeft?.length && !ctx.values.floorRight?.length) {
          // The same graph carries on as the manual floor (rebuilding it would end the drag).
          built.key = `${id()}${log}`;
          el.classList.remove('hr-auto');
          for (const c of HISS_CHANNELS) ctx.set(c, next);
        } else ctx.set(id(), next);
      },
      xLabel: (t) => hzLabel(toF(t)),
      xTicks: ticks.map(toT),
      xTickLabels: ticks.map((f) => (f >= 1000 ? `${f / 1000}k` : String(f))),
      yTicks,
      className: 'hr-floor',
      render: (env, n) => {
        const fp = env.map((q) => ({ f: toF(q.t), g: q.v }));
        return Float32Array.from({ length: n }, (_, i) => floorAt(fp, toF(i / (n - 1))));
      },
      overlay: (g, W, H, { yOf }) => {
        const fp = captured() ? ctx.values[id()] : shown;
        // Audio this far above the floor passes; below it is reduced.
        g.strokeStyle = cssVar('--hot');
        g.setLineDash([4, 3]);
        g.lineWidth = 1.5;
        g.beginPath();
        for (let x = 0; x <= W; x += 2) {
          const y = Math.max(0, Math.min(H, yOf(floorAt(fp, toF(x / W)) + 4 + ctx.values.noiseFloor, H)));
          if (x) g.lineTo(x, y);
          else g.moveTo(x, y);
        }
        g.stroke();
        g.setLineDash([]);
        if (auto && !captured()) {
          labelText(g, 'Automatic: the floor is tracked from the audio as it plays.', 64, 8);
          labelText(g, 'Capture Noise Floor from a hiss-only selection, or drag the line to set one.', 64, 24);
        }
      },
    });
    el.classList.toggle('hr-auto', auto);
    built = { el, key: `${auto ? 'auto' : id()}${log}`, redraw: el.redraw, set: el.setPoints, toT };
  };
  const show = () => {
    const pts = ctx.values[id()];
    const key = pts?.length ? `${id()}${ctx.values.floorScale === 1}` : `auto${ctx.values.floorScale === 1}`;
    if (!built || built.key !== key) {
      build();
      box.replaceChildren(built.el);
      return;
    }
    const now = JSON.stringify(pts || []);
    if (now !== last && built.set && pts?.length) {
      last = now;
      built.set(pts.map((q) => ({ t: built.toT(q.f), v: q.g })));
    } else built.redraw();
  };
  ctx.subscribe(show);
  show();
  box.refresh = show;
  return box;
}

/** Captures the selection's mean noise spectrum as editable floor points per channel. */
async function captureHissFloor(ctx) {
  const { doc, app } = ctx;
  const [start, full] = doc.editRange();
  const end = Math.min(full, start + Math.round(30 * doc.sampleRate));
  const channels = doc.state.channels.slice(0, 2).map((c) => c.toArray(start, end));
  const print = await captureNoisePrint(await dsp(), channels, doc.sampleRate, { fftSize: 4096 });
  const pts = print.channels.map((c) => floorPoints(c, print.fftSize, print.rate));
  ctx.set('floorLeft', pts[0]);
  ctx.set('floorRight', pts[1] || pts[0]);
  announce(`Noise floor captured from ${print.seconds.toFixed(print.seconds < 10 ? 2 : 1)} s of audio`);
  if (full > end) app?.notify?.('Only the first 30 s of the selection were used for the noise floor.');
}

function hissView(ctx) {
  const stereo = (ctx.doc?.state?.channels?.length || 1) > 1;
  let channel = 0;
  const graph = hissFloorGraph(ctx, () => channel);
  const capture = h('button.btn', {
    type: 'button',
    disabled: !ctx.doc,
    title: 'Measure the noise floor from the current selection (hiss only)',
    onclick: async () => {
      capture.disabled = true;
      try {
        await captureHissFloor(ctx);
      } catch (err) {
        ctx.app?.notify?.(err?.message || 'Could not capture the noise floor.', { error: true });
      } finally {
        capture.disabled = !ctx.doc;
      }
    },
  }, 'Capture Noise Floor');
  const status = readout(ctx, (v) => (v.floorLeft?.length || v.floorRight?.length ? 'Using the captured noise floor' : 'Tracking the noise floor automatically'), 'nr-status');
  const scaleSel = select({ value: ctx.values.floorScale, options: ctx.def.params.find((p) => p.id === 'floorScale').options, label: 'Graph scale', onChange: (v) => ctx.set('floorScale', Number(v)) });
  const chan = stereo
    ? h('label.fx-inline', h('span.fx-label', 'Channel:'), select({ value: 0, options: [{ value: 0, label: 'Left' }, { value: 1, label: 'Right' }], label: 'Channel shown', onChange: (v) => {
        channel = Number(v);
        graph.refresh();
      } }))
    : null;
  const reset = h('button.icon-btn', {
    type: 'button',
    'aria-label': 'Track the noise floor automatically',
    title: 'Forget the captured floor and track it automatically',
    onclick: () => {
      ctx.set('floorLeft', []);
      ctx.set('floorRight', []);
    },
  }, icon('rotate-ccw', 15));
  const show = (v) => {
    reset.disabled = !(v.floorLeft?.length || v.floorRight?.length);
    scaleSel.value = String(v.floorScale);
  };
  ctx.subscribe(show);
  show(ctx.values);
  return h(
    'div.fx-stack',
    h('div.nr-bar', capture, status),
    graph,
    h('div.hr-bar', h('label.fx-inline', h('span.fx-label', 'Scale:'), scaleSel), chan, h('span.hr-spacer'), reset),
    controlsFor(ctx, ['noiseFloor', 'reduceBy', 'hissOnly']),
    disclosure('Advanced', controlsFor(ctx, ['decay', 'precision', 'transition', 'fftSize']), { prefs: ctx.app?.prefs, key: 'hissReduction' }),
  );
}
hissView.hides = true;

// ----------------------------------------------------------- Sound Remover

/**
 * Sound Remover: learn the model from the selection without leaving the
 * dialog, save it (the example sound, as a WAV file) and load one back
 * (relearned from the file's first seconds).
 */
function soundRemoverView(ctx) {
  const { app, doc } = ctx;
  const status = h('span.nr-status', { 'aria-live': 'polite' });
  const show = () => {
    const m = doc?.soundModel;
    status.textContent = m ? `Sound model: ${m.seconds.toFixed(m.seconds < 10 ? 2 : 1)} s example, ${m.bases.k} components` : 'Sound model: none';
    save.disabled = !m;
  };
  const learn = h('button.btn', {
    type: 'button',
    disabled: !doc,
    title: 'Learn the sound from the current selection (the sound only)',
    onclick: async () => {
      learn.disabled = true;
      try {
        await app.commands.run('fx.learnSoundModel', { values: ctx.values });
      } finally {
        learn.disabled = !doc;
      }
    },
  }, 'Learn Sound Model');
  const save = h('button.icon-btn', {
    type: 'button',
    'aria-label': 'Save the sound model as a WAV file',
    title: 'Save the sound model (its example sound) as a WAV file',
    onclick: () => {
      const m = doc?.soundModel;
      if (m) downloadBlob(encodeWav({ sampleRate: m.rate, channels: [m.samples], bitDepth: 32 }), `${(doc.name || 'sound').replace(/\.[^.]+$/, '')} sound model.wav`);
    },
  }, glyph(['M12 3v12', 'M7 10l5 5 5-5', 'M4 19h16']));
  const load = h('button.icon-btn', {
    type: 'button',
    disabled: !doc,
    'aria-label': 'Load a sound model from an audio file',
    title: `Load a sound model: learns from the first ${MAX_SOUND_SECONDS} s of an audio file`,
    onclick: async () => {
      const [file] = await pickLocalFiles({ multiple: false });
      if (!file) return;
      try {
        const r = await decodeAudio(await file.arrayBuffer(), file.name);
        const n = Math.min(r.channels[0].length, Math.round(MAX_SOUND_SECONDS * r.sampleRate));
        doc.soundModel = await learnSoundModel(r.channels.map((c) => c.subarray(0, n)), r.sampleRate, ctx.values);
        doc.emit('change', { kind: 'soundModel' });
        announce('Sound model loaded');
      } catch (err) {
        app.notify(err?.message || 'Could not load a sound model from that file.', { error: true });
      }
    },
  }, glyph('M3 7h6l2 2h10v10H3z'));
  const off = doc?.on?.('change', (e) => e?.kind === 'soundModel' && show());
  if (off) ctx.onClose?.(off);
  show();
  const need = needBanner(ctx, {
    has: () => doc?.soundModel,
    missing: 'No sound model yet.',
    howTo: 'Select an example of the sound only in the editor (this window stays open), then learn it.',
    action: 'Learn from Selection',
    change: 'soundModel',
    run: () => app.commands.run('fx.learnSoundModel', { values: ctx.values }),
  });
  return h(
    'div.fx-stack',
    h('div.nr-bar', learn, save, load, status),
    need,
    groupBox('Sound Model', controlsFor(ctx, ['complexity', 'passes', 'enhanced', 'suppression'])),
    groupBox('Content', controlsFor(ctx, ['contentComplexity', 'contentPasses'])),
    groupBox('Removal', controlsFor(ctx, ['strength', 'reduceBy', 'sensitivity'])),
    controlsFor(ctx, ['speech', 'fftSize']),
  );
}
soundRemoverView.hides = true;

// Automatic Phase Correction: manual channel shifts apply while the automatic time shift is off.
function phaseView(ctx) {
  return h(
    'div.fx-stack',
    controlsFor(ctx, ['globalShift']),
    enableWhen(ctx, controlsFor(ctx, ['leftShift', 'rightShift']), (v) => !v.globalShift),
    controlsFor(ctx, ['alignBands', 'centerPan', 'channel', 'resolution', 'analysisSize']),
  );
}
phaseView.hides = true;

registerEditor('dehummer', dehummer);
registerEditor('autoPhaseCorrection', phaseView);
registerEditor('denoise', focusView([], 'noiseOnly'));
registerEditor('dereverb', focusView(['decay'], 'autoGain'));
registerEditor('hissReduction', hissView);

// Adaptive Noise Reduction: the live spectrum over the generated controls.
const adaptiveView = (ctx) => spectrumMonitor(ctx);
registerEditor('adaptiveNoiseReduction', adaptiveView);
registerEditor('soundRemover', soundRemoverView);
