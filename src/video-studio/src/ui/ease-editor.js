/**
 * Custom easing curve for a keyframe: drag the two handles of the curve
 * (time across, progress up; handles may go above or below the box for an
 * overshoot), or start from a preset. A dot runs along the curve so the
 * timing can be felt before applying. Returns the ease name or null.
 */
import { h, clamp } from '../lib/dom.js';
import { ease, parseCubic, cubicName } from '../model/keyframes.js';
import { openDialog } from './dialog.js';
import { EASE_LABELS } from './organize-actions.js';

const SIZE = 220;
const REACH = 0.35; // how far handles may go above or below the box
const PAD = REACH * SIZE;
const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

/** Starting handles for an ease name (presets are approximated by a cubic). */
const START = {
  linear: [0.25, 0.25, 0.75, 0.75],
  easeIn: [0.55, 0, 1, 0.45],
  easeOut: [0, 0.55, 0.45, 1],
  easeInOut: [0.65, 0, 0.35, 1],
  smooth: [0.37, 0, 0.63, 1],
  overshoot: [0.34, 1.35, 0.64, 1],
  anticipate: [0.36, 0, 0.66, -0.35],
};

export function openEaseEditor(current = 'linear') {
  let hd = [...(parseCubic(current) || START[current] || START.linear)].map((v, i) => (i % 2 ? clamp(v, -REACH, 1 + REACH) : v));
  const toX = (x) => x * SIZE;
  const toY = (y) => PAD + (1 - y) * SIZE;
  const view = svg('svg', { viewBox: `-12 0 ${SIZE + 24} ${SIZE + PAD * 2}`, class: 'ease-graph', role: 'img', 'aria-label': 'Easing curve' });
  view.append(
    svg('rect', { x: 0, y: PAD, width: SIZE, height: SIZE, class: 'ease-box' }),
    svg('line', { x1: 0, y1: PAD + SIZE, x2: SIZE, y2: PAD, class: 'ease-diag' }),
  );
  const arm1 = svg('line', { class: 'ease-arm' });
  const arm2 = svg('line', { class: 'ease-arm' });
  const curve = svg('path', { class: 'ease-curve' });
  const dot = svg('circle', { r: 5, class: 'ease-dot' });
  const h1 = svg('circle', { r: 8, class: 'ease-handle', tabindex: 0, 'aria-label': 'First handle' });
  const h2 = svg('circle', { r: 8, class: 'ease-handle', tabindex: 0, 'aria-label': 'Second handle' });
  view.append(arm1, arm2, curve, dot, h1, h2);
  const readout = h('output.ease-readout');
  const presets = h('div.ease-presets', { role: 'group', 'aria-label': 'Start from' }, ...Object.keys(START).map((k) => {
    const b = h('button.btn.small', { type: 'button' }, EASE_LABELS[k] || k);
    b.addEventListener('click', () => {
      hd = [...START[k]];
      draw();
    });
    return b;
  }));

  function draw() {
    const [x1, y1, x2, y2] = hd;
    curve.setAttribute('d', `M0 ${toY(0)} C${toX(x1)} ${toY(y1)} ${toX(x2)} ${toY(y2)} ${toX(1)} ${toY(1)}`);
    arm1.setAttribute('x1', 0); arm1.setAttribute('y1', toY(0)); arm1.setAttribute('x2', toX(x1)); arm1.setAttribute('y2', toY(y1));
    arm2.setAttribute('x1', toX(1)); arm2.setAttribute('y1', toY(1)); arm2.setAttribute('x2', toX(x2)); arm2.setAttribute('y2', toY(y2));
    h1.setAttribute('cx', toX(x1)); h1.setAttribute('cy', toY(y1));
    h2.setAttribute('cx', toX(x2)); h2.setAttribute('cy', toY(y2));
    readout.textContent = cubicName(...hd).slice(6, -1).split(',').join(', ');
  }

  const drag = (which) => (e) => {
    e.preventDefault();
    const handle = which ? h2 : h1;
    handle.setPointerCapture?.(e.pointerId);
    const move = (ev) => {
      const pt = view.createSVGPoint ? view.createSVGPoint() : null;
      let x;
      let y;
      if (pt && view.getScreenCTM()) {
        pt.x = ev.clientX;
        pt.y = ev.clientY;
        const p = pt.matrixTransform(view.getScreenCTM().inverse());
        x = p.x;
        y = p.y;
      } else return;
      const nx = clamp(x / SIZE, 0, 1);
      const ny = clamp(1 - (y - PAD) / SIZE, -REACH, 1 + REACH);
      if (which) hd = [hd[0], hd[1], nx, ny];
      else hd = [nx, ny, hd[2], hd[3]];
      draw();
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      handle.removeEventListener('lostpointercapture', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    // Without these a drag that the browser takes over keeps moving the handle on later hovers.
    handle.addEventListener('pointercancel', up);
    handle.addEventListener('lostpointercapture', up);
  };
  h1.addEventListener('pointerdown', drag(0));
  h2.addEventListener('pointerdown', drag(1));
  // Arrow keys nudge a focused handle.
  const nudge = (which) => (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (!d) return;
    e.preventDefault();
    const i = which ? 2 : 0;
    hd[i] = clamp(hd[i] + d[0], 0, 1);
    hd[i + 1] = clamp(hd[i + 1] + d[1], -REACH, 1 + REACH);
    draw();
  };
  h1.addEventListener('keydown', nudge(0));
  h2.addEventListener('keydown', nudge(1));

  // The running dot.
  let raf = 0;
  let start = 0;
  const run = (now) => {
    start ||= now;
    const t = ((now - start) / 1400) % 1.25;
    const p = Math.min(1, t);
    const v = ease(cubicName(...hd), p);
    dot.setAttribute('cx', toX(p));
    dot.setAttribute('cy', toY(v));
    raf = requestAnimationFrame(run);
  };
  if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(run);

  draw();
  return new Promise((resolve) => {
    let result = null;
    const apply = h('button.btn.primary', { type: 'button' }, 'Apply');
    const cancel = h('button.btn', { type: 'button' }, 'Cancel');
    const d = openDialog({
      title: 'Easing curve',
      body: h('div.ease-editor', h('p.dialog-text', 'Drag the handles to shape how the value moves between the two keyframes. Pull a handle past the top or bottom for an overshoot.'), view, readout, presets),
      actions: [cancel, apply],
      className: 'ease-dialog',
      onClose: () => {
        cancelAnimationFrame?.(raf);
        resolve(result);
      },
    });
    cancel.addEventListener('click', () => d.close());
    apply.addEventListener('click', () => {
      result = cubicName(...hd);
      d.close();
    });
  });
}

