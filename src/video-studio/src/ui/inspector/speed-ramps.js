/**
 * Speed > Ramps: a gallery of velocity ramps (model/speed-ramps.js). Each
 * tile draws the ramp's speed curve with a dot riding it, a footage marker
 * that rushes and lingers with the speed, and a hint of its accent (a
 * flash or a zoom punch) at the ramp. Picking a tile applies the curve and
 * the accent as one undo step; picking the active tile again resets it.
 * The active ramp stays marked after the curve is tweaked in Curve mode.
 */
import { h, announce } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { CURVE_MIN, CURVE_MAX, curveTable, hasCurve } from '../../model/speed-curve.js';
import { SPEED_RAMPS, RAMP_ACCENTS, findRamp, activeRamp, accentLabel } from '../../model/speed-ramps.js';
import { switchField } from '../controls.js';
import { choiceGrid, propSection, secs } from './common.js';

const LMIN = Math.log(CURVE_MIN);
const LMAX = Math.log(CURVE_MAX);
const LOOP_MS = 2600;
const SVG_NS = 'http://www.w3.org/2000/svg';
/** Height of the drawing box (the width is 100), in viewBox units. */
const VH = 60;
const yOf = (v) => 4 + (1 - (Math.log(v) - LMIN) / (LMAX - LMIN)) * (VH - 8);

const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

function svgEl(name, attrs) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/** Keyframes that pulse prop to on at each accent of a kind, off elsewhere. */
function pulseFrames(accents, kind, prop, on, off, width = 0.1) {
  const frames = [{ offset: 0, [prop]: off }];
  let last = 0;
  for (const a of accents.filter((x) => x.kind === kind).sort((x, y) => x.at - y.at)) {
    const lo = Math.max(last, a.at - 0.03);
    const hi = Math.min(1, a.at + width);
    if (lo > last) frames.push({ offset: lo, [prop]: off });
    frames.push({ offset: Math.max(lo, a.at), [prop]: on }, { offset: hi, [prop]: off });
    last = hi;
  }
  if (last < 1) frames.push({ offset: 1, [prop]: off });
  return frames;
}

/**
 * Tile preview of a ramp: the curve, a dot riding it in timeline time, a
 * footage marker below moving at the ramp's speed, and the accent marks.
 * Animated with the Web Animations API unless motion is reduced.
 */
export function rampPreview(ramp) {
  const tb = curveTable(ramp.points);
  const N = 48;
  let d = '';
  for (let i = 0; i <= N; i++) d += `${i ? 'L' : 'M'}${((i / N) * 100).toFixed(2)} ${yOf(tb.speed(i / N)).toFixed(2)}`;
  const svg = svgEl('svg', { viewBox: `0 0 100 ${VH}`, preserveAspectRatio: 'none', class: 'ramp-curve', 'aria-hidden': 'true' });
  svg.append(
    svgEl('path', { d: `M0 ${yOf(1)}L100 ${yOf(1)}`, class: 'ramp-curve-base', 'vector-effect': 'non-scaling-stroke' }),
    ...ramp.accents.map((a) => svgEl('path', { d: `M${a.at * 100} 2L${a.at * 100} ${VH - 2}`, class: `ramp-curve-accent is-${a.kind}`, 'vector-effect': 'non-scaling-stroke' })),
    svgEl('path', { d, class: 'ramp-curve-line', 'vector-effect': 'non-scaling-stroke' }),
  );
  const dot = h('span.ramp-dot');
  const dotLayer = h('span.ramp-dot-layer', dot);
  const tick = h('span.ramp-tick');
  const tickLayer = h('span.ramp-tick-layer', tick);
  const flash = h('span.ramp-flash');
  const stage = h('span.ramp-stage', svg, dotLayer);
  const kinds = [...new Set(ramp.accents.map((a) => a.kind))];
  const badge = kinds.length ? h('span.ramp-badge', kinds.map((k) => icon(RAMP_ACCENTS[k].icon, 11))) : null;
  const el = h('span.ramp-preview', { dataset: { ramp: ramp.id } }, stage, h('span.ramp-strip', tickLayer), flash, badge);

  // Resting state: the dot at the ramp's first accent (or the middle).
  const rest = ramp.accents[0]?.at ?? 0.5;
  const pos = (x) => `translate(${(x * 100).toFixed(2)}%, ${((yOf(tb.speed(x)) / VH) * 100).toFixed(2)}%)`;
  dotLayer.style.transform = pos(rest);
  tickLayer.style.transform = `translateX(${((tb.integral(rest) / tb.total) * 100).toFixed(2)}%)`;
  if (typeof dotLayer.animate !== 'function' || reducedMotion()) return el;

  const timing = { duration: LOOP_MS, iterations: Infinity, easing: 'linear' };
  const dotFrames = [];
  const tickFrames = [];
  for (let i = 0; i <= N; i++) {
    const x = i / N;
    dotFrames.push({ offset: x, transform: pos(x) });
    tickFrames.push({ offset: x, transform: `translateX(${((tb.integral(x) / tb.total) * 100).toFixed(2)}%)` });
  }
  dotLayer.animate(dotFrames, timing);
  tickLayer.animate(tickFrames, timing);
  if (kinds.includes('flash')) flash.animate(pulseFrames(ramp.accents, 'flash', 'opacity', 0.75, 0, 0.12), timing);
  if (kinds.includes('punch') || kinds.includes('blur')) {
    const frames = pulseFrames(ramp.accents.map((a) => ({ ...a, kind: a.kind === 'blur' ? 'punch' : a.kind })), 'punch', 'transform', 'scale(1.1)', 'scale(1)', 0.14);
    stage.animate(frames, timing);
  }
  if (kinds.includes('blur')) dot.animate(pulseFrames(ramp.accents, 'blur', 'transform', 'scaleX(2.6)', 'scaleX(1)', 0.12), timing);
  return el;
}

/** Inline description of the active ramp ("Snap and glide, edited in Curve"). */
function statusText(clip) {
  const a = activeRamp(clip);
  if (!a) return hasCurve(clip) ? 'This clip follows its own speed curve. Pick a ramp to replace it.' : 'No ramp. Pick one to apply its speed curve and accent in one step.';
  return a.tweaked ? `${a.ramp.label}, edited in Curve. Pick it again to reset.` : `${a.ramp.label}: ${a.ramp.hint}`;
}

/**
 * The Ramps panel. onTweak switches the Speed tab to Curve mode with the
 * ramp's curve to edit.
 */
export function speedRampsPanel(view, { onTweak } = {}) {
  const { store, actions } = view;
  const visual = Boolean(view.clip.transform);
  let accentOn = view.clip.speedRamp ? view.clip.speedRamp.accent !== false : true;

  const items = [
    { id: null, label: 'None', preview: h('span.ramp-none', icon('close', 16)) },
    ...SPEED_RAMPS.map((r) => ({ id: r.id, label: r.label, preview: rampPreview(r) })),
  ];
  const valueOf = () => {
    const a = activeRamp(view.clip);
    if (a) return a.ramp.id;
    return hasCurve(view.clip) ? '' : null;
  };
  const grid = choiceGrid({
    label: 'Velocity ramps',
    className: 'speed-ramp-grid',
    items,
    value: valueOf(),
    onPick: (id) => {
      const clip = view.clip;
      if (!clip) return;
      if (id === null) {
        if (actions.applySpeedRamp(view.id, null)) announce('Velocity ramp removed. Constant speed.');
      } else {
        const ramp = findRamp(id);
        if (actions.applySpeedRamp(view.id, id, { accent: accentOn })) {
          const accent = accentOn && visual ? accentLabel(ramp) : '';
          announce(`${ramp.label} ramp${accent ? ` with ${accent.toLowerCase()}` : ''}, ${secs(view.clip?.duration || 0)}`);
        }
      }
      store.seal();
      paint();
    },
  });
  // Tooltips carry the description and the accent.
  grid.buttons.forEach((b, i) => {
    const r = SPEED_RAMPS[i - 1];
    if (!r) return;
    const acc = accentLabel(r);
    b.title = `${r.label}: ${r.hint}${acc && visual ? ` Accent: ${acc}.` : ''}`;
  });

  const status = h('p.speed-ramp-status', { 'aria-live': 'polite' });
  const tweak = h('button.btn.small.speed-ramp-tweak', { type: 'button' }, icon('speedCurve', 14), h('span', 'Tweak in Curve'));
  tweak.addEventListener('click', () => onTweak?.());
  const head = h('div.speed-ramp-head', h('span.speed-ramp-active', icon('speed', 14), status), tweak);

  let accentField = null;
  if (visual) {
    accentField = switchField({
      label: 'Accent at the ramp',
      hint: 'A brief flash, a zoom punch or motion blur where the speed turns, as keys you can edit.',
      checked: accentOn,
      onChange: (v) => {
        accentOn = v;
        if (view.clip?.speedRamp) {
          actions.setRampAccent(view.id, v);
          store.seal();
        }
        announce(v ? 'Ramp accent on' : 'Ramp accent off');
      },
    });
  }

  function paint() {
    const clip = view.clip;
    if (!clip) return;
    grid.set(valueOf());
    const a = activeRamp(clip);
    status.textContent = statusText(clip);
    tweak.hidden = !hasCurve(clip);
    head.classList.toggle('is-active', Boolean(a));
    head.classList.toggle('is-tweaked', Boolean(a?.tweaked));
    if (clip.speedRamp) accentOn = clip.speedRamp.accent !== false;
    accentField?.set(accentOn);
  }
  paint();
  view.bind(paint);

  return h('div.speed-ramps-panel',
    propSection('Velocity ramps', [head, grid.el, accentField?.el || null], {
      onReset: () => {
        if (actions.applySpeedRamp(view.id, null)) announce('Velocity ramp removed. Constant speed.');
        store.seal();
      },
    }),
  );
}
