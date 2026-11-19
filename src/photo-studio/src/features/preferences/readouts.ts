// Tools → Show tooltips while dragging: a small readout beside the pointer
// with the size of a dragged rectangle, a move offset, a line's length and
// angle, or a transform's size and rotation, in the ruler units.
import type { Editor } from '../../editor';
import { formatUnit, RULER_UNITS, type RulerUnit } from '../../imaging/measure/geometry';
import { documentPpi } from '../../model/text-layer';
import { marqueeRect } from '../selection';

const RECT_TOOLS = new Set(['rect-marquee', 'ellipse-marquee', 'crop', 'rect-shape', 'ellipse-shape', 'triangle-shape', 'polygon-shape', 'custom-shape', 'artboard', 'frame', 'slice']);
const LINE_TOOLS = new Set(['line-shape', 'gradient']);
const MARQUEES = new Set(['rect-marquee', 'ellipse-marquee']);
let el: HTMLDivElement | undefined;

/** Lengths in the ruler units with their suffix. */
export function lengthText(e: Editor, px: number, axis: 'x' | 'y' = 'x') {
  const unit = (RULER_UNITS.some(([u]) => u === e.preferences.rulerUnits) ? e.preferences.rulerUnits : 'px') as RulerUnit;
  const suffix = RULER_UNITS.find(([u]) => u === unit)![2];
  return `${formatUnit(px, unit, documentPpi(e.doc), axis === 'x' ? e.doc.width : e.doc.height)} ${suffix}`;
}

/** Show (or move) the readout near a client point. */
export function showReadout(e: Editor, clientX: number, clientY: number, lines: string[]) {
  if (!e.preferences.toolReadouts || !lines.length) return hideReadout();
  if (!el) {
    el = document.createElement('div');
    el.className = 'drag-readout';
    el.setAttribute('aria-hidden', 'true');
    e.root.append(el);
  }
  el.textContent = lines.join('\n');
  const w = el.offsetWidth,
    h = el.offsetHeight;
  el.style.left = `${Math.min(innerWidth - w - 4, clientX + 18)}px`;
  el.style.top = `${Math.min(innerHeight - h - 4, clientY + 18)}px`;
}
export function hideReadout() {
  el?.remove();
  el = undefined;
}

export function installReadouts(e: Editor) {
  const viewport = e.el('#viewport');
  let start: { x: number; y: number; tool: string; shift: boolean; alt: boolean } | undefined;
  viewport.addEventListener('pointerdown', (ev) => {
    start = ev.button === 0 && !viewport.classList.contains('space-pan') ? { ...pointOf(e, ev), tool: e.tool, shift: ev.shiftKey, alt: ev.altKey } : undefined;
  });
  viewport.addEventListener('pointermove', (ev) => {
    if (!start || !(ev.buttons & 1) || e.transform.dragging || !e.hasDocument) return;
    const p = pointOf(e, ev),
      dx = p.x - start.x,
      dy = p.y - start.y;
    if (Math.hypot(ev.movementX, ev.movementY) === 0 && Math.abs(dx) + Math.abs(dy) < 1) return;
    let lines: string[] = [];
    if (MARQUEES.has(start.tool)) {
      // The size the marquee selects: square with Shift, from the center with
      // Alt, or the fixed ratio or size of its Style.
      const op = start.shift && start.alt ? 'intersect' : start.shift ? 'add' : start.alt ? 'subtract' : 'replace';
      const r = marqueeRect([start.x, start.y], { ...p, shift: ev.shiftKey, alt: ev.altKey }, op, { style: e.settings.marqueeStyle, width: e.settings.marqueeW, height: e.settings.marqueeH });
      lines = [`W: ${lengthText(e, r.width, 'x')}`, `H: ${lengthText(e, r.height, 'y')}`];
    } else if (RECT_TOOLS.has(start.tool)) lines = [`W: ${lengthText(e, Math.abs(dx), 'x')}`, `H: ${lengthText(e, Math.abs(dy), 'y')}`];
    else if (LINE_TOOLS.has(start.tool)) lines = [`L: ${lengthText(e, Math.hypot(dx, dy))}`, `A: ${Math.round((Math.atan2(-dy, dx) * 1800) / Math.PI) / 10}°`];
    else if (start.tool === 'move') lines = [`ΔX: ${lengthText(e, dx, 'x')}`, `ΔY: ${lengthText(e, dy, 'y')}`];
    if (lines.length) showReadout(e, ev.clientX, ev.clientY, lines);
  });
  const end = () => {
    start = undefined;
    hideReadout();
  };
  viewport.addEventListener('pointerup', end);
  viewport.addEventListener('pointercancel', end);
}
const pointOf = (e: Editor, ev: PointerEvent) => {
  const [x, y] = e.docPoint(ev.clientX, ev.clientY);
  return { x, y };
};
