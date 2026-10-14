/**
 * Picture Format ▸ Crop: the whole picture with the part kept framed. Eight handles (and the frame
 * itself, to move it) set the crop by pointer or by keyboard (arrow keys move the focused handle a
 * step, Shift a larger one); an aspect ratio keeps the frame in proportion. OK crops the picture
 * (cropPatch in core/picture-format.js): what is kept stays where it was on the sheet, at its scale.
 */
import { el, isComposing } from './dom.js';
import { openModal } from './modal.js';
import { pictureNode } from './picture.js';
import { CROP_ASPECTS, aspectCrop, clampCrop, cropOf, dragCrop, uncroppedSize } from '../core/picture-format.js';

const HANDLES = [['nw', 'top left'], ['n', 'top'], ['ne', 'top right'], ['e', 'right'], ['se', 'bottom right'], ['s', 'bottom'], ['sw', 'bottom left'], ['w', 'left']];
const KEY_STEPS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

export function openCropDialog({ picture, onApply, onClose }) {
  const full = uncroppedSize(picture);
  const scale = Math.min(560 / full.w, 340 / full.h, 3);
  const W = Math.max(40, Math.round(full.w * scale)), H = Math.max(40, Math.round(full.h * scale));
  let crop = clampCrop(cropOf(picture));
  let ratio = null;

  const image = pictureNode({ ...picture, srcRect: null, fillRect: null, rotation: 0, flipH: false, flipV: false, decorative: true });
  const shade = el('div.crop-shade', { 'aria-hidden': 'true' });
  const frame = el('div.crop-frame', { role: 'group', 'aria-label': 'Part of the picture kept' });
  const move = el('button.crop-move', { type: 'button', 'aria-label': 'Move the crop (arrow keys)', title: 'Drag to move the crop' });
  frame.append(move);
  const handles = HANDLES.map(([id, name]) => {
    const handle = el(`button.crop-handle.crop-${id}`, { type: 'button', 'aria-label': `Crop ${name} edge (arrow keys)`, dataset: { handle: id } });
    frame.append(handle);
    return handle;
  });
  const stage = el('div.crop-stage', { style: { width: `${W}px`, height: `${H}px` } }, el('div.crop-picture', {}, image), shade, frame);
  const readout = el('p.small.muted.crop-readout', { 'aria-live': 'polite' });

  function render() {
    const x = crop.x * W, y = crop.y * H, w = crop.w * W, h = crop.h * H;
    Object.assign(frame.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    // The part cut away stays visible, dimmed, around the frame.
    shade.style.clipPath = `polygon(evenodd, 0 0, ${W}px 0, ${W}px ${H}px, 0 ${H}px, 0 0, ${x}px ${y}px, ${x}px ${y + h}px, ${x + w}px ${y + h}px, ${x + w}px ${y}px, ${x}px ${y}px)`;
    const kept = { w: Math.round(full.w * crop.w), h: Math.round(full.h * crop.h) };
    readout.textContent = `Kept: ${kept.w} × ${kept.h} pixels on the sheet (${Math.round(crop.w * crop.h * 100)}% of the picture)`;
  }

  const drag = (handle, e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = { ...crop }, x0 = e.clientX, y0 = e.clientY, node = e.currentTarget;
    node.setPointerCapture?.(e.pointerId);
    const moveTo = (ev) => { crop = dragCrop(start, handle, (ev.clientX - x0) / W, (ev.clientY - y0) / H, { ratio, full }); render(); };
    const end = () => { node.removeEventListener('pointermove', moveTo); node.removeEventListener('pointerup', end); node.removeEventListener('pointercancel', end); };
    node.addEventListener('pointermove', moveTo);
    node.addEventListener('pointerup', end);
    node.addEventListener('pointercancel', end);
  };
  const nudge = (handle, e) => {
    if (isComposing(e)) return;
    const step = KEY_STEPS[e.key];
    if (!step) return;
    e.preventDefault();
    const size = e.shiftKey ? 0.1 : 0.01;
    crop = dragCrop(crop, handle, step[0] * size, step[1] * size, { ratio, full });
    render();
  };
  move.addEventListener('pointerdown', (e) => drag('move', e));
  move.addEventListener('keydown', (e) => nudge('move', e));
  for (const handle of handles) {
    handle.addEventListener('pointerdown', (e) => drag(handle.dataset.handle, e));
    handle.addEventListener('keydown', (e) => nudge(handle.dataset.handle, e));
  }

  const aspect = el('select.select.crop-aspect', { 'aria-label': 'Aspect ratio' },
    el('option', { value: '' }, 'Free'),
    el('option', { value: String(full.w / full.h) }, 'Original'),
    ...CROP_ASPECTS.map(([kind, label, value]) => el('option', { value: String(value) }, `${label} ${kind === 'Square' ? '' : kind.toLowerCase()}`.trim())));
  aspect.addEventListener('change', () => {
    ratio = Number(aspect.value) || null;
    if (ratio) {
      // Fit the largest frame of that shape about the centre of the present one.
      const shown = { ...picture, srcRect: { l: crop.x, t: crop.y, r: 1 - crop.x - crop.w, b: 1 - crop.y - crop.h }, w: full.w * crop.w, h: full.h * crop.h };
      crop = aspectCrop(shown, ratio);
      render();
    }
  });
  const reset = el('button.btn.btn-ghost', { type: 'button', onclick: () => { crop = { x: 0, y: 0, w: 1, h: 1 }; aspect.value = ''; ratio = null; render(); } }, 'Show All');

  const content = el('form.crop-dialog', { onsubmit: (e) => { e.preventDefault(); onApply?.(crop); modal.close(); } },
    el('div.row.crop-toolbar', {}, el('label.crop-aspect-field', {}, el('span', {}, 'Aspect ratio'), aspect), reset),
    stage, readout,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'Crop')));
  render();
  const modal = openModal({ title: 'Crop Picture', content, initialFocus: move, onClose, wide: true });
  return modal;
}
