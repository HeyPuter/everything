/**
 * Color > Wheels: shadows (lift), midtones (gamma), highlights (gain) and
 * offset. Drag a wheel's puck toward a hue to tint that tonal range (arrow
 * keys nudge it, double-click resets it); the slider under each wheel sets
 * its brightness. An overall intensity scales all four.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { WHEELS, wheelVector, wheelHue, neutralWheel } from '../../model/color.js';
import { slider, uidFor, keepFocus } from './common.js';
import { gradeSection, editGrade } from './color-common.js';

const wheelOf = (clip, id) => clip?.grade?.wheels?.[id] || neutralWheel();
const isNeutral = (w) => !w.x && !w.y && !w.l;

/** Hue ring as a CSS conic gradient: hue h sits at math angle h (0 = right, counterclockwise). */
const RING = (() => {
  const stops = [];
  for (let a = 0; a <= 360; a += 15) stops.push(`hsl(${((90 - a) % 360 + 360) % 360} 85% 55%) ${a}deg`);
  return `conic-gradient(${stops.join(', ')})`;
})();

function wheelCard(view, def) {
  const label = def.label;
  const puck = h('span.wheel-puck', { 'aria-hidden': 'true' });
  const disk = h('div.wheel-disk', { tabindex: '0', role: 'slider', 'aria-label': `${label} color`, 'aria-valuemin': '0', 'aria-valuemax': '100', style: { '--ring': RING } }, puck);
  const set = (w, final, what = 'color') => editGrade(view, `${label} ${what}`, (g) => {
    g.wheels[def.id] = w;
  }, { key: `wheel-${def.id}-${what}`, final });

  const fromPointer = (e) => {
    const r = disk.getBoundingClientRect();
    const rad = r.width / 2 || 1;
    let x = (e.clientX - (r.left + rad)) / rad;
    let y = -(e.clientY - (r.top + r.height / 2)) / rad;
    const m = Math.hypot(x, y);
    if (m > 1) {
      x /= m;
      y /= m;
    }
    return [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000];
  };
  let dragging = false;
  let fine = null; // Shift held: { px, py, x, y } where fine dragging started
  disk.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    disk.focus({ preventScroll: true });
    dragging = true;
    fine = null;
    disk.setPointerCapture?.(e.pointerId);
    const [x, y] = fromPointer(e);
    set({ ...wheelOf(view.clip, def.id), x, y }, false);
  });
  disk.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    let [x, y] = fromPointer(e);
    if (e.shiftKey) {
      // Shift: a quarter of the pointer's movement, for fine adjustments.
      const cur = wheelOf(view.clip, def.id);
      fine ||= { px: x, py: y, x: cur.x, y: cur.y };
      x = fine.x + (x - fine.px) * 0.25;
      y = fine.y + (y - fine.py) * 0.25;
      const m = Math.hypot(x, y);
      if (m > 1) {
        x /= m;
        y /= m;
      }
    } else fine = null;
    set({ ...wheelOf(view.clip, def.id), x, y }, false);
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    view.store.seal();
  };
  disk.addEventListener('pointerup', end);
  disk.addEventListener('pointercancel', end);
  disk.addEventListener('dblclick', () => set({ ...wheelOf(view.clip, def.id), x: 0, y: 0 }, true));
  disk.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.05 : 0.01;
    const w = wheelOf(view.clip, def.id);
    let { x, y } = w;
    if (e.key === 'ArrowLeft') x -= step;
    else if (e.key === 'ArrowRight') x += step;
    else if (e.key === 'ArrowUp') y += step;
    else if (e.key === 'ArrowDown') y -= step;
    else if (e.key === 'Home' || e.key === 'Delete' || e.key === 'Backspace') {
      x = 0;
      y = 0;
    } else return;
    e.preventDefault();
    e.stopPropagation();
    const m = Math.hypot(x, y);
    if (m > 1) {
      x /= m;
      y /= m;
    }
    set({ ...w, x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 }, false);
  });
  disk.addEventListener('keyup', () => view.store.seal());

  const levelId = uidFor('level');
  const level = h('input.wheel-level', { type: 'range', id: levelId, min: -100, max: 100, step: 1, value: 0, 'aria-label': `${label} brightness` });
  // Only an active drag holds the slider; a focused one follows undo.
  let levelDrag = false;
  level.addEventListener('pointerdown', () => (levelDrag = true));
  level.addEventListener('pointerup', () => (levelDrag = false));
  level.addEventListener('pointercancel', () => (levelDrag = false));
  level.addEventListener('input', () => set({ ...wheelOf(view.clip, def.id), l: Number(level.value) }, false, 'brightness'));
  level.addEventListener('change', () => {
    levelDrag = false;
    set({ ...wheelOf(view.clip, def.id), l: Number(level.value) }, true, 'brightness');
  });
  level.addEventListener('dblclick', () => set({ ...wheelOf(view.clip, def.id), l: 0 }, true, 'brightness'));

  const vals = ['R', 'G', 'B'].map((c) => h(`span.wheel-val.${c.toLowerCase()}`));
  const reset = h('button.icon-btn.small', { type: 'button', 'aria-label': `Reset ${label}`, 'data-tip': 'Reset' }, icon('rotateLeft', 13));
  // The button turns off once the wheel is neutral; focus goes to the wheel.
  reset.addEventListener('click', () => keepFocus(() => set(neutralWheel(), true, 'reset'), () => disk));

  const paint = () => {
    const w = wheelOf(view.clip, def.id);
    puck.style.left = `${50 + w.x * 50}%`;
    puck.style.top = `${50 - w.y * 50}%`;
    const amount = Math.round(Math.min(1, Math.hypot(w.x, w.y)) * 100);
    disk.setAttribute('aria-valuenow', String(amount));
    disk.setAttribute('aria-valuetext', amount ? `hue ${Math.round(wheelHue(w))} degrees, strength ${amount} percent` : 'neutral');
    if (!levelDrag) level.value = String(w.l);
    level.style.setProperty('--pct', `${(w.l + 100) / 2}%`);
    const v = wheelVector(def.id, w, 100);
    vals.forEach((el, i) => (el.textContent = `${v[i] >= 0 ? '+' : ''}${v[i].toFixed(2)}`));
    reset.disabled = isNeutral(w);
    card.classList.toggle('changed', !isNeutral(w));
  };
  const card = h('div.wheel-card',
    h('div.wheel-head', h('span.wheel-title', def.label, h('span.wheel-hint', def.hint)), reset),
    disk,
    h('label.sr-only', { for: levelId }, `${label} brightness`),
    level,
    h('div.wheel-vals', { 'aria-label': `${label} red, green and blue change` }, vals),
  );
  paint();
  view.bind(paint);
  return card;
}

export function wheelsTab(view) {
  const intensity = slider(view, {
    label: 'Intensity',
    min: 0,
    max: 100,
    unit: '%',
    get: (c) => Math.round(c.grade?.wheels?.intensity ?? 100),
    set: (v, final) => editGrade(view, 'Wheels intensity', (g) => {
      g.wheels.intensity = v;
    }, { key: 'wheels-intensity', final }),
  });
  return h('div.wheels-tab', gradeSection(view, {
    id: 'wheels',
    title: 'Color wheels',
    children: [
      intensity.el,
      h('div.wheel-grid', WHEELS.map((w) => wheelCard(view, w))),
      h('p.curve-help', 'Drag toward a color to tint that range; hold Shift for finer control. Double-click a wheel to center it.'),
    ],
    onReset: () => editGrade(view, 'Reset color wheels', (g) => {
      g.wheels = { intensity: 100, shadows: neutralWheel(), midtones: neutralWheel(), highlights: neutralWheel(), offset: neutralWheel() };
    }),
  }));
}
