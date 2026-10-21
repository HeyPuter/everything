/**
 * Video > Mask: a stack of up to four masks (see model/masks.js). The list
 * selects, hides, reorders, duplicates and deletes masks; the shape tiles
 * add one; the settings below edit the selected mask, with keyframes for
 * position, size, rotation, feather and opacity. While this panel is open
 * the selected mask is also edited on the preview (ui/mask-overlay.js).
 */
import '../../styles/masks.css';
import { h, announce } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { FONTS } from '../../model/catalog.js';
import {
  MASK_SHAPES, MASK_MODES, MAX_MASKS, defaultMask, addMask, removeMask, moveMask, cloneMask, changeMaskType, maskProp, MASK_KEYED, fitPathBox,
} from '../../model/masks.js';
import { selectField, segmented, switchField } from '../controls.js';
import { slider, propSection, createScope, note, toggle, keepFocus } from './common.js';
import { maskEdit } from '../mask-edit-state.js';

const shapeOf = (type) => MASK_SHAPES.find((s) => s.id === type) || MASK_SHAPES[0];

function aspectOf(view) {
  const c = view.clip;
  const a = c && view.project.assets[c.assetId];
  return a?.width && a?.height ? a.width / a.height : view.project.settings.width / view.project.settings.height;
}

export function maskTab(view) {
  const root = h('div.masks-tab');
  const listEl = h('div.mask-list', { role: 'list', 'aria-label': 'Masks' });
  const empty = h('p.insp-empty', 'Add a mask to show only part of the clip. Masks combine from top to bottom.');
  const settingsHost = h('div.mask-settings');
  let sub = createScope();
  view.bind(() => sub.update());
  view.bind(() => sub.tick(), { time: true });
  const sv = Object.create(view);
  sv.bind = (fn, opts) => sub.bind(fn, opts);

  const masks = () => view.clip?.masks || [];
  const sel = () => Math.min(maskEdit.index, Math.max(0, masks().length - 1));

  // --- Add mask -------------------------------------------------------------
  const tiles = MASK_SHAPES.map((s) => {
    const b = h('button.mask-tile', { type: 'button', 'data-shape': s.id, 'data-tip': `Add ${s.label.toLowerCase()} mask`, 'aria-label': `Add ${s.label.toLowerCase()} mask` },
      h('span.mask-tile-icon', icon(s.icon, 20)), h('span.mask-tile-label', s.label));
    b.addEventListener('click', () => add(s.id));
    return b;
  });
  const addGrid = h('div.mask-tiles', { role: 'group', 'aria-label': 'Add mask' }, ...tiles);
  const full = note(`A clip can have up to ${MAX_MASKS} masks.`);

  function add(type) {
    let index = -1;
    view.edit(`Add ${shapeOf(type).label.toLowerCase()} mask`, (c) => {
      index = addMask(c, defaultMask(type, aspectOf(view)));
      return index >= 0;
    });
    if (index < 0) return;
    maskEdit.set({ index, point: -1, drawing: type === 'pen' });
    announce(type === 'pen' ? 'Pen mask added. Click on the preview to place points, then click the first point to close the path.'
      : type === 'brush' ? 'Brush mask added. Paint on the preview.' : `${shapeOf(type).label} mask added`);
    render(true);
  }

  // --- Mask list --------------------------------------------------------------
  // Rows are rebuilt after each change; focus goes back to the same control of the mask.
  const control = (i, act) => () => listEl.children[i]?.querySelector(`[data-act="${act}"]`);
  function rowFor(m, i, n) {
    const shape = shapeOf(m.type);
    const selected = i === sel();
    const mode = MASK_MODES.find((x) => x.id === m.mode) || MASK_MODES[0];
    const pick = h('button.mask-row-main', { type: 'button', dataset: { act: 'pick' }, 'aria-pressed': String(selected), 'aria-label': `Mask ${i + 1}, ${shape.label}, ${i === 0 ? 'base' : mode.label}${m.hidden ? ', hidden' : ''}` },
      h('span.mask-row-icon', icon(shape.icon, 16)),
      h('span.mask-row-name', `${i + 1}. ${shape.label}`),
      i > 0 ? h('span.mask-row-mode', mode.label) : null);
    pick.addEventListener('click', () => keepFocus(() => {
      maskEdit.set({ index: i, point: -1, drawing: false });
      render(true);
    }, control(i, 'pick')));
    const btn = (name, label, act, fn, disabled = false) => {
      const b = h('button.icon-btn.small', { type: 'button', 'aria-label': `${label} mask ${i + 1}`, 'data-tip': label, disabled, dataset: { act } }, icon(name, 14));
      b.addEventListener('click', fn);
      return b;
    };
    const eye = btn(m.hidden ? 'eyeOff' : 'eye', m.hidden ? 'Show' : 'Hide', 'eye', () => keepFocus(() => {
      view.edit(m.hidden ? 'Show mask' : 'Hide mask', (c) => {
        const t = c.masks?.[i];
        if (!t) return false;
        if (t.hidden) delete t.hidden;
        else t.hidden = true;
      });
    }, control(i, 'eye')));
    eye.setAttribute('aria-pressed', String(Boolean(m.hidden)));
    const up = btn('arrowUp', 'Move up', 'up', () => keepFocus(() => move(i, i - 1), control(i - 1, 'up'), control(i - 1, 'down')), i === 0);
    const down = btn('arrowDown', 'Move down', 'down', () => keepFocus(() => move(i, i + 1), control(i + 1, 'down'), control(i + 1, 'up')), i === n - 1);
    const dup = btn('duplicate', 'Duplicate', 'dup', () => keepFocus(() => {
      let index = -1;
      view.edit('Duplicate mask', (c) => {
        if (!c.masks?.[i]) return false;
        index = addMask(c, cloneMask(c.masks[i]));
        if (index < 0) return false;
        for (const key of MASK_KEYED) {
          const keys = c.keyframes?.[maskProp(i, key)];
          if (keys) c.keyframes[maskProp(index, key)] = structuredClone(keys);
        }
      });
      if (index >= 0) {
        maskEdit.set({ index, point: -1 });
        render(true);
      }
    }, control(i, 'dup'), control(i, 'pick')), n >= MAX_MASKS);
    const del = btn('trash', 'Delete', 'delete', () => keepFocus(() => {
      view.edit('Delete mask', (c) => removeMask(c, i));
      maskEdit.set({ index: Math.max(0, i - 1), point: -1, drawing: false });
      announce('Mask deleted');
      render(true);
    }, control(i, 'delete'), control(i - 1, 'delete'), () => tiles[0]));
    return h(`div.mask-row${selected ? '.selected' : ''}${m.hidden ? '.is-hidden' : ''}`, { role: 'listitem' }, pick, h('div.mask-row-tools', eye, up, down, dup, del));
  }

  function move(from, to) {
    view.edit('Reorder masks', (c) => moveMask(c, from, to));
    if (sel() === from) maskEdit.set({ index: to });
    render(true);
  }

  // --- Settings of the selected mask -----------------------------------------
  function buildSettings(i) {
    sub = createScope();
    const m = masks()[i];
    if (!m) return null;
    const type = m.type;
    const get = (key, d = 0) => (c) => c?.masks?.[i]?.[key] ?? d;
    const editMask = (label, key, fn, final = true) => view.edit(label, (c) => {
      const t = c.masks?.[i];
      if (!t) return false;
      return fn(t, c);
    }, { key: `mask${i}-${key}`, final });
    const keyed = (key, opts) => slider(sv, {
      ...opts,
      prop: maskProp(i, key),
      get: () => opts.toUi(sv.valueOf(maskProp(i, key))),
      set: (v, final) => sv.animate(maskProp(i, key), opts.fromUi(v), { label: opts.edit, final }),
    });
    const rows = [];

    const shapeSel = selectField({
      label: 'Shape',
      options: MASK_SHAPES.map((s) => ({ value: s.id, label: s.label })),
      value: type,
      onChange: (v) => {
        view.edit('Change mask shape', (c) => {
          if (!c.masks?.[i]) return false;
          c.masks[i] = changeMaskType(c.masks[i], v, aspectOf(view));
        });
        maskEdit.set({ point: -1, drawing: v === 'pen' });
        render(true);
      },
    });
    shapeSel.el.classList.add('insp-row');
    rows.push(shapeSel.el);

    if (i > 0) {
      const mode = segmented({
        label: 'Combine with the masks above',
        className: 'mask-modes',
        options: MASK_MODES.map((x) => ({ value: x.id, label: x.label, icon: `mask${x.id[0].toUpperCase()}${x.id.slice(1)}` })),
        value: m.mode,
        onChange: (v) => editMask('Mask mode', 'mode', (t) => {
          t.mode = v;
        }),
      });
      sub.bind(() => mode.set(get('mode', 'add')(view.clip)));
      rows.push(h('div.field.insp-row', h('span.field-label', 'Combine'), mode.el));
    } else if (m.mode === 'subtract') {
      rows.push(note('The first mask cuts its shape out of the whole picture.'));
    }

    const box = !['split', 'band'].includes(type);
    rows.push(keyed('x', { label: 'Position X', min: -100, max: 100, hardMin: -500, hardMax: 500, unit: '%', className: 'centered', edit: 'Move mask', toUi: (v) => Math.round(v * 1000) / 10, fromUi: (v) => v / 100, step: 0.1 }).el);
    rows.push(keyed('y', { label: 'Position Y', min: -100, max: 100, hardMin: -500, hardMax: 500, unit: '%', className: 'centered', edit: 'Move mask', toUi: (v) => Math.round(-v * 1000) / 10, fromUi: (v) => -v / 100, step: 0.1 }).el);
    if (box) {
      rows.push(keyed('w', { label: 'Width', min: 1, max: 200, hardMin: 0.1, hardMax: 2000, unit: '%', edit: 'Resize mask', toUi: (v) => Math.round(v * 1000) / 10, fromUi: (v) => Math.max(0.001, v / 100), step: 0.1 }).el);
      rows.push(keyed('h', { label: 'Height', min: 1, max: 200, hardMin: 0.1, hardMax: 2000, unit: '%', edit: 'Resize mask', toUi: (v) => Math.round(v * 1000) / 10, fromUi: (v) => Math.max(0.001, v / 100), step: 0.1 }).el);
    } else if (type === 'band') {
      rows.push(keyed('h', { label: 'Band width', min: 1, max: 200, hardMin: 0.1, hardMax: 2000, unit: '%', edit: 'Resize mask', toUi: (v) => Math.round(v * 1000) / 10, fromUi: (v) => Math.max(0.001, v / 100), step: 0.1 }).el);
    }
    rows.push(keyed('rotation', { label: 'Rotate', min: -180, max: 180, hardMin: -3600, hardMax: 3600, unit: '°', className: 'centered', edit: 'Rotate mask', toUi: (v) => Math.round(v * 10) / 10, fromUi: (v) => v, decimals: 0 }).el);
    rows.push(keyed('feather', { label: 'Feather', min: 0, max: 100, edit: 'Feather mask', toUi: (v) => Math.round(v), fromUi: (v) => v }).el);
    rows.push(keyed('opacity', { label: 'Opacity', min: 0, max: 100, unit: '%', edit: 'Mask opacity', toUi: (v) => Math.round(v * 100), fromUi: (v) => Math.min(1, Math.max(0, v / 100)) }).el);
    rows.push(toggle(sv, {
      label: 'Invert',
      get: (c) => Boolean(c?.masks?.[i]?.invert),
      set: (on) => {
        editMask('Invert mask', 'invert', (t) => {
          t.invert = on;
        });
        announce(on ? 'Mask inverted' : 'Mask not inverted');
      },
    }).el);

    if (type === 'rectangle') {
      rows.push(slider(sv, { label: 'Round corners', min: 0, max: 100, get: (c) => Math.round(get('roundness')(c)), set: (v, final) => editMask('Round mask corners', 'round', (t) => { t.roundness = v; }, final) }).el);
    }
    if (type === 'star') {
      rows.push(slider(sv, { label: 'Points', min: 3, max: 12, hardMax: 24, get: (c) => get('count', 5)(c), set: (v, final) => editMask('Star points', 'count', (t) => { t.count = Math.round(v); }, final) }).el);
      rows.push(slider(sv, { label: 'Inner radius', min: 5, max: 95, unit: '%', get: (c) => Math.round(get('inner', 0.45)(c) * 100), set: (v, final) => editMask('Star inner radius', 'inner', (t) => { t.inner = v / 100; }, final) }).el);
    }
    if (type === 'polygon') {
      rows.push(slider(sv, { label: 'Sides', min: 3, max: 12, hardMax: 24, get: (c) => get('count', 6)(c), set: (v, final) => editMask('Polygon sides', 'count', (t) => { t.count = Math.round(v); }, final) }).el);
    }
    if (type === 'text') {
      const id = `mask-text-${i}`;
      const input = h('textarea.input.mask-text-input', { id, rows: 2, maxLength: 200, spellcheck: false }, m.text || '');
      input.addEventListener('input', () => editMask('Mask text', 'text', (t) => { t.text = input.value; }, false));
      input.addEventListener('change', () => view.store.seal());
      sub.bind(() => {
        const v = get('text', '')(view.clip);
        if (document.activeElement !== input && input.value !== v) input.value = v;
      });
      rows.push(h('div.field.mask-text-field', h('label.field-label', { for: id }, 'Text'), input));
      const font = selectField({
        label: 'Font',
        options: FONTS.map((f) => ({ value: f.id, label: f.label })),
        value: m.font,
        onChange: (v) => editMask('Mask font', 'font', (t) => { t.font = v; }),
      });
      font.el.classList.add('insp-row');
      sub.bind(() => font.set(get('font', 'Inter')(view.clip)));
      rows.push(font.el);
      rows.push(toggle(sv, { label: 'Bold', get: (c) => Boolean(c?.masks?.[i]?.bold), set: (on) => editMask('Mask bold', 'bold', (t) => { t.bold = on; }) }).el);
    }
    if (type === 'pen') {
      const count = h('p.insp-note.mask-pen-note');
      const draw = h('button.btn.small', { type: 'button' }, icon('penTool', 14), h('span', 'Draw path'));
      draw.addEventListener('click', () => {
        if (!maskEdit.drawing) view.edit('Clear mask path', (c) => { if (c.masks?.[i]) c.masks[i].path = []; });
        else {
          // Finishing: fit the box to the path (when nothing is keyed) so its handles hug the drawing.
          const c = view.clip;
          const a = view.project.assets[c?.assetId];
          const t = c?.masks?.[i];
          if (t?.path?.length >= 3 && a?.width && !MASK_KEYED.some((k) => c.keyframes?.[maskProp(i, k)]?.length)) {
            const fit = fitPathBox(t, a.width, a.height);
            view.edit('Close mask path', (x) => Object.assign(x.masks[i], { x: fit.x, y: fit.y, w: fit.w, h: fit.h, path: fit.path }));
          }
        }
        maskEdit.set({ drawing: !maskEdit.drawing, point: -1, index: i });
        announce(maskEdit.drawing ? 'Click on the preview to place points. Drag to curve. Click the first point to close.' : 'Path finished');
      });
      const syncPen = () => {
        const n = get('path', [])(view.clip).length;
        count.textContent = maskEdit.drawing
          ? 'Click on the preview to place points, drag to curve them, click the first point to close.'
          : n >= 3 ? `${n} points. Drag points and handles on the preview. Click the outline to add a point, double-click a point to delete it, Alt-click to toggle a curve.` : 'Draw a path on the preview.';
        draw.querySelector('span').textContent = maskEdit.drawing ? 'Finish path' : n ? 'Redraw path' : 'Draw path';
      };
      sub.bind(syncPen);
      const off = maskEdit.on('change', () => (count.isConnected ? syncPen() : off()));
      syncPen();
      rows.push(h('div.insp-tools.mask-pen-tools', draw), count);
    }
    if (type === 'brush') {
      const size = slider(sv, { label: 'Brush size', min: 1, max: 40, unit: '%', get: () => Math.round(maskEdit.brush.size * 100), set: (v) => { maskEdit.brush = { ...maskEdit.brush, size: v / 100 }; } });
      const kind = segmented({
        label: 'Brush',
        options: [{ value: 'paint', label: 'Paint', icon: 'brush' }, { value: 'erase', label: 'Erase', icon: 'eraser' }],
        value: maskEdit.brush.erase ? 'erase' : 'paint',
        onChange: (v) => maskEdit.set({ brush: { ...maskEdit.brush, erase: v === 'erase' } }),
      });
      const clearBtn = h('button.btn.small', { type: 'button' }, icon('trash', 14), h('span', 'Clear painting'));
      clearBtn.addEventListener('click', () => editMask('Clear mask painting', 'strokes', (t) => { t.strokes = []; }));
      rows.push(size.el, h('div.field.insp-row', h('span.field-label', 'Brush'), kind.el), h('div.insp-tools', clearBtn), note('Paint on the preview to reveal the clip; erase to take paint away.'));
    }
    return propSection(`Mask ${i + 1}: ${shapeOf(type).label}`, rows, {
      onReset: () => {
        view.edit('Reset mask', (c) => {
          const t = c.masks?.[i];
          if (!t) return false;
          const fresh = defaultMask(t.type, aspectOf(view));
          Object.assign(t, { ...fresh, id: t.id, mode: t.mode, path: t.path, strokes: t.strokes, text: t.text, font: t.font });
          if (t.type !== 'pen') delete t.path;
          if (t.type !== 'brush') delete t.strokes;
          if (t.type !== 'text') {
            delete t.text;
            delete t.font;
          }
          for (const key of MASK_KEYED) delete c.keyframes?.[maskProp(i, key)];
        });
        announce('Mask reset');
      },
    });
  }

  // --- Edit on canvas ----------------------------------------------------------
  const canvasSwitch = switchField({
    label: 'Edit on the preview',
    checked: maskEdit.onCanvas,
    onChange: (v) => maskEdit.set({ onCanvas: v }),
  });

  let sig = null;
  function render(force = false) {
    const c = view.clip;
    if (!c) return;
    const list = masks();
    const s = `${list.map((m) => `${m.type}:${m.mode}:${m.hidden ? 1 : 0}`).join(',')}|${sel()}`;
    if (!force && s === sig) return;
    sig = s;
    if (maskEdit.index !== sel()) maskEdit.index = sel();
    listEl.replaceChildren(...list.map((m, i) => rowFor(m, i, list.length)));
    listEl.hidden = !list.length;
    empty.hidden = list.length > 0;
    for (const t of tiles) t.disabled = list.length >= MAX_MASKS;
    full.hidden = list.length < MAX_MASKS;
    const settings = list.length ? buildSettings(sel()) : null;
    settingsHost.replaceChildren(...(settings ? [settings] : []));
    if (!settings) sub = createScope();
  }

  // Masks either cut the clip or only limit where its color applies.
  const useCtl = segmented({
    label: 'Masks',
    options: [{ value: 'cut', label: 'Show part' }, { value: 'color', label: 'Limit color' }],
    value: view.clip?.maskUse === 'color' ? 'color' : 'cut',
    onChange: (v) => view.edit(v === 'color' ? 'Masks limit color' : 'Masks show part', (c) => {
      if (v === 'color') c.maskUse = 'color';
      else if (c.maskUse) delete c.maskUse;
      else return false;
    }),
  });
  const useHint = h('p.asset-hint');
  const useRow = h('div', h('div.field.insp-row', h('span.field-label', 'Use masks to'), useCtl.el), useHint);
  const syncUse = () => {
    const color = view.clip?.maskUse === 'color';
    useCtl.set(color ? 'color' : 'cut');
    useHint.textContent = color
      ? 'The whole clip shows; its color adjustments, filter and LUT apply only inside the masks.'
      : 'Only the part inside the masks shows.';
  };
  syncUse();
  view.bind(syncUse);

  root.append(
    propSection('Masks', [empty, listEl, canvasSwitch.el, useRow]),
    propSection('Add mask', [addGrid, full]),
    settingsHost,
  );
  render(true);
  view.bind(() => render());
  maskEdit.open(root, view.id);
  return root;
}
