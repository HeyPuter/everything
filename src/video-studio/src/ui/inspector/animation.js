/**
 * Animation tab: In, Out and Loop sub-tabs, each a grid of tiles (with a
 * None tile) that preview their motion on hover, plus a duration slider for
 * the active animation.
 */
import { h, announce } from '../../lib/dom.js';
import { US } from '../../lib/time.js';
import { ANIMATIONS, ANIMATION_CATEGORIES } from '../../model/catalog.js';
import { applyAnimations } from '../../engine/scene.js';
import { defaultLength } from '../preferences-dialog.js';
import { slider, color, propSection, tabSet, choiceGrid } from './common.js';
import { lookCanvas, hoverAnimateLook } from '../text-thumbs.js';

/** Sample text for letter and word animation tiles. */
const TEXT_LOOK = { text: 'Hey you', style: { font: 'Poppins', bold: true, size: 64, color: '#ffffff', highlightColor: '#ffd23f' } };

const KINDS = [
  { id: 'in', label: 'In', key: 'animIn' },
  { id: 'out', label: 'Out', key: 'animOut' },
  { id: 'loop', label: 'Loop', key: 'animLoop' },
];

export const animKey = (kind) => KINDS.find((k) => k.id === kind).key;

/** The longest this kind may run: in and out share the clip. */
export function maxAnimDuration(clip, kind) {
  if (kind === 'loop') return clip.duration;
  const other = kind === 'in' ? clip.animOut : clip.animIn;
  return Math.max(100_000, clip.duration - (other?.duration || 0));
}

/**
 * Play a motion animation on a tile's demo block while it is hovered or
 * focused, using the same math as the renderer.
 */
function motionPreview(button, demo, kind, id) {
  let raf = 0;
  let t0 = 0;
  const CYCLE = 1600;
  const frame = (now) => {
    // A tile replaced while hovered never gets pointerleave.
    if (!demo.isConnected) {
      raf = 0;
      return;
    }
    const ms = (now - t0) % CYCLE;
    const clip = { duration: 1.4e6, animIn: null, animOut: null, animLoop: null };
    if (kind === 'in') clip.animIn = { id, duration: 0.9e6 };
    else if (kind === 'out') clip.animOut = { id, duration: 0.9e6 };
    else clip.animLoop = { id, duration: 1.4e6 };
    const local = Math.min(1.4e6, ms * 1000);
    const st = applyAnimations(clip, local, { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, blur: 0, reveal: 1 });
    const w = demo.parentElement?.clientWidth || 100;
    const hgt = demo.parentElement?.clientHeight || 100;
    demo.style.transform = `translate(${st.x * w}px, ${st.y * hgt}px) rotate(${st.rotation}deg) scale(${Math.max(0, st.scale)})`;
    demo.style.opacity = String(Math.max(0, Math.min(1, st.opacity)));
    demo.style.filter = st.blur > 0 ? `blur(${(st.blur * 6).toFixed(1)}px)` : '';
    raf = requestAnimationFrame(frame);
  };
  const start = () => {
    if (raf || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    t0 = performance.now();
    raf = requestAnimationFrame(frame);
  };
  const stop = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    demo.style.transform = '';
    demo.style.opacity = '';
    demo.style.filter = '';
  };
  button.addEventListener('pointerenter', start);
  button.addEventListener('focus', start);
  button.addEventListener('pointerleave', stop);
  button.addEventListener('blur', stop);
}

function kindPanel(view, kind, state) {
  const key = animKey(kind);
  const isText = view.clip.type === 'text';
  // Text clips list their letter and word animations first.
  const all = ANIMATIONS[kind].filter((a) => !a.textOnly || isText);
  const list = isText ? [...all.filter((a) => a.textOnly), ...all.filter((a) => !a.textOnly)] : all;
  const catOf = (a) => (a.textOnly ? 'text' : a.cat || 'basic');
  const cats = ANIMATION_CATEGORIES.filter((c) => c.id === 'all' || list.some((a) => catOf(a) === c.id));
  let cat = cats.some((c) => c.id === state.animCat) ? state.animCat : 'all';
  let query = '';
  const canvases = new Map();
  const grid = choiceGrid({
    label: `${KINDS.find((k) => k.id === kind).label} animations`,
    className: 'anim-grid',
    items: [{ id: null, label: 'None' }, ...list].map((a) => ({
      id: a.id,
      label: a.label,
      preview: a.glyph
        ? canvases.set(a.id, lookCanvas(TEXT_LOOK, 104, 104, { className: 'preset-canvas', bg: null, maxScale: 0.9 })).get(a.id)
        : h('span.anim-stage', { 'aria-hidden': 'true' }, h('span.anim-demo', { dataset: { anim: a.id ? 'motion' : 'none' } })),
    })),
    value: view.clip[key]?.id || null,
    onPick: (id) => {
      const c = view.clip;
      let duration;
      if (id && kind !== 'loop' && !c[key]) duration = Math.min(defaultLength.animation(), maxAnimDuration(c, kind));
      view.actions.applyAnimation(kind, id, duration);
      view.store.seal();
      announce(id ? `${list.find((a) => a.id === id).label} animation applied` : 'Animation removed');
    },
  });
  const dur = slider(view, {
    label: 'Duration',
    min: 0.1,
    max: 5,
    step: 0.1,
    unit: 's',
    get: (c) => Math.round(((c[key]?.duration || 500_000) / US) * 10) / 10,
    set: (v, final) => view.edit('Animation duration', (c) => {
      if (!c[key]) return false;
      c[key].duration = Math.round(Math.min(v * US, maxAnimDuration(c, kind)));
    }, { key: `anim-${kind}`, final }),
  });
  grid.buttons.forEach((b) => {
    const c = canvases.get(b.dataset.id);
    if (c) hoverAnimateLook(b, c, TEXT_LOOK, b.dataset.id, kind, { bg: null, maxScale: 0.9 });
    else if (b.dataset.id) {
      const demo = b.querySelector('.anim-demo');
      if (demo) motionPreview(b, demo, kind, b.dataset.id);
    }
  });
  // Category chips and search narrow the grid (None stays visible).
  const filter = () => {
    const q = query.trim().toLowerCase();
    grid.buttons.forEach((b) => {
      const a = list.find((x) => x.id === b.dataset.id);
      b.hidden = Boolean(a) && ((cat !== 'all' && catOf(a) !== cat) || (q && !a.label.toLowerCase().includes(q)));
    });
  };
  const chips = h('div.anim-cats', { role: 'radiogroup', 'aria-label': 'Animation category' }, cats.map((c) => {
    const b = h('button.chip', { type: 'button', role: 'radio', 'aria-checked': String(c.id === cat), 'data-cat': c.id }, c.label);
    b.addEventListener('click', () => {
      cat = c.id;
      state.animCat = c.id;
      chips.querySelectorAll('[role=radio]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      filter();
    });
    return b;
  }));
  const search = h('input.input.small.anim-search', { type: 'search', placeholder: 'Search animations', 'aria-label': 'Search animations' });
  search.addEventListener('input', () => {
    query = search.value;
    filter();
  });
  filter();
  const durSection = propSection('Duration', dur.el);
  // Karaoke runs over the whole clip; it has a highlight color instead of a duration.
  const whole = (c) => Boolean(ANIMATIONS[kind].find((a) => a.id === c[key]?.id)?.whole);
  const highlight = isText ? propSection('Highlight', color(view, {
    label: 'Highlight color',
    get: (c) => c.style.highlightColor,
    set: (v, final) => view.edit('Highlight color', (c) => {
      c.style.highlightColor = v;
    }, { key: 'style-highlightColor', final }),
  }).el) : null;
  const render = () => {
    const c = view.clip;
    if (!c) return;
    grid.set(c[key]?.id || null);
    durSection.hidden = !c[key] || whole(c);
    if (highlight) highlight.hidden = c[key]?.id !== 'karaoke';
    dur.input.max = String(Math.max(0.1, Math.floor((maxAnimDuration(c, kind) / US) * 10) / 10));
  };
  render();
  view.bind(render);
  return h('div', search, chips, h('div.anim-grid-wrap', grid.el), durSection, highlight);
}

export function animationTab(view, state) {
  const c = view.clip;
  // Open the sub-tab that already has an animation, else the last one used.
  const active = KINDS.find((k) => c[k.key])?.id;
  const subs = tabSet({
    label: 'Animation type',
    className: 'subtabs',
    items: KINDS,
    value: state.animSub || active || 'in',
    onChange: (id) => {
      state.animSub = id;
      show(id);
    },
  });
  const show = (id) => {
    view.resetScope();
    subs.panel.replaceChildren(kindPanel(view, id, state));
  };
  show(subs.current);
  return h('div.animation-tab', subs.list, subs.panel);
}
