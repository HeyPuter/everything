// Dialog views for Stereo Imagery: Center Channel Extractor (Extraction and
// Discrimination tabs, level faders) and Graphic Phase Shifter (a phase
// curve over a linear or log frequency axis, 180 or 360 degree range,
// optional spline curves).

import { h } from '../../lib/dom.js';
import { envelopeControl, registerEditor } from '../editors.js';
import { controlsFor, groupBox, tabPanels, vSlider, readout, enableWhen, radioChoice, checkbox, glyph, disclosure } from '../layout.js';
import { extractorBand, phaseAxis } from '../defs/stereo.js';
import { hzLabel } from './common.js';

// ------------------------------------------------- Center Channel Extractor

function extractorView(ctx) {
  const rate = ctx.doc?.sampleRate || 48000;
  const custom = enableWhen(ctx, controlsFor(ctx, ['phaseAngle', 'pan', 'delay']), (v) => v.target === 4);
  const band = enableWhen(ctx, controlsFor(ctx, ['lowFreq', 'highFreq'], { labels: { lowFreq: 'Start', highFreq: 'End' } }), (v) => v.range === 4);
  const bandText = readout(ctx, (v) => {
    const [lo, hi] = extractorBand(v, rate);
    const centre = Math.sqrt(Math.max(20, lo) * hi);
    return `Band ${hzLabel(lo)} to ${hzLabel(hi)}: centre ${hzLabel(centre)}, width ${hzLabel(hi - lo)}`;
  }, 'faint');
  // Switching to a Custom range starts from the band that was in use (Male Voice's 80 Hz to 8 kHz...).
  let lastRange = ctx.values.range;
  ctx.subscribe((v) => {
    const prev = lastRange;
    lastRange = v.range;
    if (v.range !== 4 || prev === 4 || prev == null) return;
    const [lo, hi] = extractorBand({ ...v, range: prev }, rate);
    ctx.set('lowFreq', Math.round(Math.min(20000, Math.max(20, lo))));
    ctx.set('highFreq', Math.round(Math.min(20000, Math.max(20, hi))));
  });
  const extraction = h('div.fx-stack', controlsFor(ctx, ['target'], { labels: { target: 'Extract' } }), custom, controlsFor(ctx, ['range']), band, bandText);
  const discrimination = controlsFor(ctx, ['bleed', 'phaseDisc', 'ampDisc', 'decay']);
  const tabs = tabPanels([
    { label: 'Extraction', content: extraction },
    { label: 'Discrimination', content: discrimination },
  ], { label: 'Center Channel Extractor settings' });
  const levels = h('div.cce-levels', vSlider(ctx, 'centerLevel', { label: 'Center' }), vSlider(ctx, 'sideLevel', { label: 'Sides' }));
  return h(
    'div.fx-stack',
    h('div.fx-split.cce-split', groupBox('', tabs), groupBox('Levels', levels)),
    disclosure('Advanced', controlsFor(ctx, ['fftSize']), { prefs: ctx.app?.prefs, key: 'centerChannelExtractor' }),
  );
}
extractorView.hides = true;
extractorView.dialogClass = 'fx-wide';

// ---------------------------------------------------- Graphic Phase Shifter

const fText = (f) => hzLabel(f);

function phaseGraph(ctx) {
  const wrap = h('div.gps-graph');
  let env = null;
  let key = '';
  let shown = '';
  let own = false;
  const build = () => {
    const v = ctx.values;
    const log = v.scale !== 1;
    const lim = v.range === 360 ? 360 : 180;
    const toT = (f) => Math.min(1, Math.max(0, phaseAxis(f, log)));
    const toF = (t) => (log ? 20 * 1000 ** t : 20 + t * (20000 - 20));
    const conv = (pts) => (pts || []).map((p) => ({ t: toT(p.f), v: Math.max(-lim, Math.min(lim, p.g)) }));
    const ticks = log ? [100, 1000, 10000] : [5000, 10000, 15000];
    const yTicks = lim === 360 ? [-270, -180, -90, 0, 90, 180, 270] : [-135, -90, -45, 0, 45, 90, 135];
    env = envelopeControl({
      param: { id: 'curve', label: 'Phase shift', min: -lim, max: lim, step: 1, unit: 'deg' },
      value: conv(v.curve),
      smooth: () => Boolean(ctx.values.spline),
      xLabel: (t) => fText(toF(t)),
      pointText: (pt) => `${fText(toF(pt.t))}: ${Math.round(pt.v)} deg`,
      xTicks: ticks.map(toT),
      xTickLabels: ticks.map((f) => (f >= 1000 ? `${f / 1000}k` : String(f))),
      yTicks,
      className: 'gps-plot',
      onChange: (pts) => {
        const next = pts.map((p) => ({ f: Math.round(toF(p.t) * 10) / 10, g: Math.round(p.v) }));
        shown = JSON.stringify(next);
        own = true;
        ctx.set('curve', next);
        own = false;
      },
    });
    env.conv = conv;
    shown = JSON.stringify(v.curve);
    wrap.replaceChildren(env);
  };
  const update = (v) => {
    const k = `${v.scale}|${v.range}`;
    if (k !== key) {
      key = k;
      build();
      return;
    }
    if (own) return;
    const now = JSON.stringify(v.curve);
    if (now !== shown) {
      shown = now;
      env.setPoints(env.conv(v.curve));
    } else env.redraw();
  };
  ctx.subscribe(update);
  update(ctx.values);
  return wrap;
}

function phaseShifterView(ctx) {
  const reset = h('button.icon-btn', { type: 'button', 'aria-label': 'Reset the phase curve', title: 'Reset the phase curve', onclick: () => ctx.set('curve', [{ f: 20, g: 0 }, { f: 20000, g: 0 }]) }, glyph(['M4 12a8 8 0 1 0 2.3-5.7', 'M4 4v4h4']));
  return h(
    'div.fx-stack',
    phaseGraph(ctx),
    h('div.nr-bar', checkbox(ctx, 'spline'), h('div.spacer'), reset),
    radioChoice(ctx, 'scale', { label: 'Frequency Scale' }),
    radioChoice(ctx, 'range', { label: 'Range' }),
    controlsFor(ctx, ['channel', 'fftSize']),
  );
}
phaseShifterView.hides = true;

registerEditor('centerChannelExtractor', extractorView);
registerEditor('graphicPhaseShifter', phaseShifterView);
