// Tool options in the main toolbar for the spectral tools: brush size and
// opacity for the Paintbrush, size for the Spot Healing Brush, and Invert for
// the selection tools. Only the options of the current tool show.

import { h } from '../lib/dom.js';
import { settings, setSettings, displayOn, docState, setSpectralSelection } from './state.js';
import { isEmpty } from './mask.js';

export const BRUSH_SIZE = { min: 4, max: 200 };

/** Which options a tool shows: 'size', 'opacity' and/or 'invert'. */
export function toolOptionKinds(tool) {
  if (tool === 'brush') return ['size', 'opacity'];
  if (tool === 'heal') return ['size'];
  if (tool === 'marquee' || tool === 'lasso') return ['invert'];
  return [];
}

/** The spectral selection with its inversion flipped (null stays null). */
export function invertSelection(sel) {
  if (isEmpty(sel)) return sel;
  return { ...sel, invert: !sel.invert };
}

export function spectralToolOptions(app) {
  const num = (label, min, max, unit, read, write) => {
    const input = h('input.input.num.tool-opt-num', { type: 'number', min, max, step: 1, 'aria-label': label });
    input.addEventListener('change', () => {
      const v = Math.round(Number(input.value));
      if (Number.isFinite(v)) write(Math.max(min, Math.min(max, v)));
      input.value = String(read());
    });
    // Arrow keys and the wheel step the value as in other numeric fields; Enter returns to the editor.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        input.blur();
        app.currentView?.()?.focus?.();
      }
    });
    const el = h('label.tool-opt', h('span.tool-opt-label', label), input, h('span.tool-opt-unit', unit));
    return { el, sync: () => (input.value = String(read())) };
  };
  const size = num(
    'Size',
    BRUSH_SIZE.min,
    BRUSH_SIZE.max,
    'px',
    () => settings(app).brushSize,
    (v) => setSettings(app, { brushSize: v }),
  );
  const opacity = num(
    'Opacity',
    5,
    100,
    '%',
    () => Math.round(settings(app).brushOpacity * 100),
    (v) => setSettings(app, { brushOpacity: v / 100 }),
  );
  const doc = () => (app.active?.kind === 'audio' ? app.active : null);
  const invert = h(
    'button.btn.sm.tool-opt-invert',
    {
      type: 'button',
      'aria-pressed': 'false',
      title: 'Select everything else in the same time range',
      onclick: () => {
        const d = doc();
        if (!d) return;
        const sel = docState(d).selection;
        if (!isEmpty(sel)) setSpectralSelection(app, d, invertSelection(sel));
      },
    },
    'Invert',
  );
  const el = h('div.tool-group.tool-options', { role: 'group', 'aria-label': 'Tool options', hidden: true }, size.el, opacity.el, invert);
  const sync = () => {
    const kinds = displayOn(app) && doc() ? toolOptionKinds(app.tool) : [];
    el.hidden = !kinds.length;
    size.el.hidden = !kinds.includes('size');
    opacity.el.hidden = !kinds.includes('opacity');
    invert.hidden = !kinds.includes('invert');
    if (document.activeElement?.closest?.('.tool-opt') !== size.el) size.sync();
    if (document.activeElement?.closest?.('.tool-opt') !== opacity.el) opacity.sync();
    const sel = doc() ? docState(doc()).selection : null;
    invert.disabled = isEmpty(sel);
    invert.setAttribute('aria-pressed', String(Boolean(sel?.invert)));
  };
  for (const ev of ['tool', 'active', 'spectral-selection']) app.on(ev, sync);
  app.prefs.on('change', (key) => (key === 'spectralSettings' || key === 'spectralDisplay') && sync());
  sync();
  return el;
}
