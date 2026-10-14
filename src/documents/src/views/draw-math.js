/**
 * Ink to Math: write an equation by hand (or start from ink selected with the lasso), have Puter's AI
 * read the picture as an equation in linear format, check and correct it against a live preview, and
 * insert it through the Insert tab's equation path.
 */
import { el } from '../ui/dom.js';
import { formDialog } from './insert-dialogs.js';
import { filterPoints, unionBounds, strokeBounds, PX_PER_MM } from '../engine/ink-geometry.js';
import { paintStroke } from './draw-surface.js';
import { linearToOmml } from '../engine/math-linear.js';
import { ommlToMathml } from '../engine/omml-mathml.js';

const PAD_WIDTH = 520, PAD_HEIGHT = 200;

/** Scale strokes to fit a box with a margin, keeping their proportions. */
function fitStrokes(strokes, width, height, margin = 16) {
  if (!strokes.length) return [];
  const b = unionBounds(strokes.map(strokeBounds));
  const scale = Math.min((width - 2 * margin) / Math.max(1, b.width), (height - 2 * margin) / Math.max(1, b.height), 3);
  const ox = (width - b.width * scale) / 2 - b.left * scale, oy = (height - b.height * scale) / 2 - b.top * scale;
  return strokes.map(s => ({ ...s, tool: 'pen', color: '000000', width: Math.max(1.5, s.width * scale), points: s.points.map(p => ({ x: p.x * scale + ox, y: p.y * scale + oy, p: p.p })) }));
}

export function openInkMath({ strokes: initial = [], recognize, onInsert, onClose }) {
  let strokes = fitStrokes(initial, PAD_WIDTH, PAD_HEIGHT), current = null, busy = false;
  const pad = el('canvas.draw-math-pad', { width: PAD_WIDTH, height: PAD_HEIGHT, 'aria-label': 'Writing area: write an equation with a pen, finger or mouse', role: 'img' });
  const ratio = window.devicePixelRatio || 1;
  pad.width = PAD_WIDTH * ratio; pad.height = PAD_HEIGHT * ratio;
  const paint = () => {
    const ctx = pad.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, pad.width, pad.height);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    for (const s of strokes) paintStroke(ctx, s);
    if (current) paintStroke(ctx, current);
  };
  const point = e => { const r = pad.getBoundingClientRect(); return { x: (e.clientX - r.left) * PAD_WIDTH / r.width, y: (e.clientY - r.top) * PAD_HEIGHT / r.height, p: e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5 }; };
  let raw = [];
  pad.addEventListener('pointerdown', e => { e.preventDefault(); pad.setPointerCapture(e.pointerId); raw = [point(e)]; current = { tool: 'pen', color: '000000', width: 0.6 * PX_PER_MM * 2, points: raw.slice() }; paint(); });
  pad.addEventListener('pointermove', e => { if (!current) return; for (const s of e.getCoalescedEvents?.().length ? e.getCoalescedEvents() : [e]) raw.push(point(s)); current.points = filterPoints(raw); paint(); });
  const end = () => { if (!current) return; strokes.push(current); current = null; paint(); };
  pad.addEventListener('pointerup', end); pad.addEventListener('pointercancel', end);

  const input = el('textarea.input.draw-math-input', { rows: 2, 'aria-label': 'Recognized equation', spellcheck: false, placeholder: 'The equation appears here; you can correct it before inserting.' });
  const preview = el('div.insert-equation-preview.draw-math-preview', { 'aria-live': 'polite' });
  const status = el('span.field-hint', { 'aria-live': 'polite' });
  const render = () => {
    const text = input.value.trim();
    if (!text) { preview.replaceChildren(el('span.field-hint', {}, 'Write an equation above, then choose Recognize.')); return; }
    try { preview.innerHTML = ommlToMathml(linearToOmml(text, { display: true })); } catch { preview.textContent = text; }
  };
  input.addEventListener('input', render);
  const clear = el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => { strokes = []; paint(); } }, 'Clear');
  const undo = el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => { strokes.pop(); paint(); } }, 'Undo Stroke');
  const read = el('button.btn.btn-outline.btn-sm', { type: 'button', onclick: async () => {
    if (busy) return;
    if (!strokes.length) { status.textContent = 'Write an equation first.'; return; }
    busy = true; read.disabled = true; status.textContent = 'Reading your handwriting…';
    try { input.value = await recognize(pad.toDataURL('image/png')); render(); status.textContent = 'Check the equation, then insert it.'; input.focus(); }
    catch (e) { status.textContent = e.message || String(e); }
    finally { busy = false; read.disabled = false; }
  } }, 'Recognize');
  const dialog = formDialog({ title: 'Ink to Math', submit: 'Insert', wide: true, className: 'draw-math', onClose, content: [
    el('div.draw-math-pad-wrap', {}, pad),
    el('div.row.draw-math-tools', {}, read, undo, clear, status),
    el('label.field-label', {}, 'Equation'), input,
    el('div', {}, el('span.field-label', {}, 'Preview'), preview)],
  onSubmit: () => {
    const text = input.value.trim();
    if (!text) throw new Error('Recognize the handwriting or type the equation first.');
    onInsert(text);
  } });
  paint(); render();
  if (strokes.length) read.click();
  return dialog.modal;
}
