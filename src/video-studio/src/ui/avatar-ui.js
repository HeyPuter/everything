/**
 * Controls shared by the Avatars panel and the avatar clip's Details tab:
 * the character gallery, the look pickers (framing, background, position)
 * and a small live preview that idles and talks a demo line.
 */
import '../styles/avatar.css';
import { h } from '../lib/dom.js';
import { segmented, colorField } from './controls.js';
import { choiceGrid } from './inspector/common.js';
import { AVATAR_CHARACTERS, drawAvatar } from '../engine/avatars.js';
import { avatarPose } from '../engine/avatar-motion.js';
import { AVATAR_FRAMINGS, AVATAR_BACKGROUNDS, AVATAR_POSITIONS } from '../model/avatar.js';

/** A canvas with a character's head on its own color (gallery tiles). */
export function characterThumb(id, size = 96) {
  const c = h('canvas.avatar-thumb', { width: size, height: size, 'aria-hidden': 'true' });
  const g = c.getContext('2d');
  const ch = AVATAR_CHARACTERS.find((x) => x.id === id);
  if (g && ch) drawAvatar(g, size, size, { character: id, framing: 'close', background: 'color', bgColor: ch.bg, seed: 3 });
  return c;
}

/** Radio grid of the characters. */
export function characterGrid({ value, onPick, label = 'Presenter' }) {
  const grid = choiceGrid({
    label,
    className: 'avatar-grid',
    items: AVATAR_CHARACTERS.map((c) => ({ id: c.id, label: c.label, preview: characterThumb(c.id) })),
    value,
    onPick,
  });
  grid.buttons.forEach((b, i) => b.setAttribute('title', `${AVATAR_CHARACTERS[i].label}: ${AVATAR_CHARACTERS[i].hint}`));
  return grid;
}

export function framingControl({ value, onChange }) {
  return segmented({ label: 'Framing', options: AVATAR_FRAMINGS.map((f) => ({ value: f.id, label: f.label })), value, onChange });
}

export function backgroundControl({ value, color, onChange, onColor }) {
  const seg = segmented({ label: 'Background', options: AVATAR_BACKGROUNDS.map((b) => ({ value: b.id, label: b.label })), value, onChange: (v) => {
    sync(v);
    onChange(v);
  } });
  const col = colorField({ label: 'Background color', value: color, onInput: (v, final) => onColor(v, final) });
  const sync = (v) => {
    col.el.hidden = v === 'none';
  };
  sync(value);
  return {
    el: h('div.avatar-bg', seg.el, col.el),
    set(v, c) {
      seg.set(v);
      if (c) col.set(c);
      sync(v);
    },
  };
}

/** Position presets as small frame glyphs. */
export function positionControl({ value, onChange }) {
  const group = h('div.segmented.avatar-pos', { role: 'radiogroup', 'aria-label': 'Position' });
  const btns = AVATAR_POSITIONS.map((p) => {
    const b = h('button', { type: 'button', role: 'radio', 'aria-label': p.label, 'data-tip': p.label, 'aria-checked': 'false', tabindex: '-1' },
      h(`span.pos-glyph.pos-${p.id}`, { 'aria-hidden': 'true' }, h('span.pos-box')));
    b.addEventListener('click', () => {
      set(p.id);
      onChange(p.id);
    });
    return b;
  });
  const set = (id) => {
    btns.forEach((b, i) => {
      const on = AVATAR_POSITIONS[i].id === id;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    if (!btns.some((b) => b.tabIndex === 0)) btns[0].tabIndex = 0;
  };
  group.addEventListener('keydown', (e) => {
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const j = (i + d + btns.length) % btns.length;
    btns[j].focus();
    btns[j].click();
  });
  group.append(...btns);
  set(value);
  return { el: group, set };
}

/** Syllables for the preview: mouth shapes the demo cycles through. */
const DEMO = [[0.7, 0.2, 0], [0.15, 0.8, 0], [0.55, 0, 0.8], [0, 0, 0], [0.8, 0.4, 0], [0.3, 0.9, 0], [0, 0, 0], [0.5, 0.1, 0.6]];

/**
 * A live preview of a look in a frame of the project's shape. While it is
 * on screen it idles and mouths a demo line; getLook() is read each frame.
 */
export function avatarPreview(getLook, { width = 320, aspect = 16 / 9 } = {}) {
  const w = width;
  const hh = Math.round(width / aspect);
  const canvas = h('canvas.avatar-preview', { width: w, height: hh, 'aria-hidden': 'true' });
  const g = canvas.getContext('2d');
  let raf = 0;
  let start = 0;
  const draw = (t) => {
    if (!g) return;
    const look = getLook();
    const pose = avatarPose({ seed: look.seed || 1, t, framing: look.framing });
    const k = (t * 5) % DEMO.length;
    const i = Math.floor(k);
    const f = k - i;
    const a = DEMO[i];
    const b = DEMO[(i + 1) % DEMO.length];
    const talk = Math.floor(t / 3) % 2 === 0 ? 1 : 0;
    pose.open = (a[0] + (b[0] - a[0]) * f) * talk;
    pose.wide = (a[1] + (b[1] - a[1]) * f) * talk;
    pose.round = (a[2] + (b[2] - a[2]) * f) * talk;
    g.clearRect(0, 0, w, hh);
    if (look.background === 'none') {
      g.fillStyle = '#2b2b30';
      g.fillRect(0, 0, w, hh);
    }
    drawAvatar(g, w, hh, look, pose);
  };
  const frame = (now) => {
    if (!canvas.isConnected) {
      raf = 0;
      return;
    }
    if (!start) start = now;
    draw((now - start) / 1000);
    raf = requestAnimationFrame(frame);
  };
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  return {
    el: canvas,
    /** Redraw now (after a change) and keep animating while shown. */
    refresh() {
      draw(start ? (performance.now() - start) / 1000 : 0.4);
      if (!raf && !reduce && typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(frame);
    },
    stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}
