/**
 * Artboard tool controls, shown in the Properties panel while the Artboard
 * tool is active: preset, orientation, new/delete, name, X/Y/W/H, "Move/Copy
 * Artwork with Artboard", Rearrange All and Artboard Options.
 */
import { h } from '../../lib/dom.js';
import { numberField, segmented, iconButton } from '../../ui/widgets.js';
import { ARTBOARD_MAX, ARTBOARD_PRESETS, presetFor, updateArtboard, addArtboard, artboardRef, refPoint, rectAtRef, resizeAtRef } from './artboard-ops.js';
import { referencePointGrid } from '../../ui/panels/transform-section.js';
import { moveArtworkEnabled } from './artboard-tool.js';

export function artboardControlsSection(app) {
  return {
    id: 'artboard-controls',
    title: 'Artboard',
    noSelection: true,
    when: () => app.toolId === 'artboard',
    build: () => buildControls(app),
  };
}

function buildControls(app) {
  const ed = () => app.editor;
  const unit = () => ed()?.doc.root.units || 'pt';
  const board = () => ed()?.artboard();
  const patch = (p, label = 'Change Artboard', coalesce = null) => {
    const e = ed();
    if (!e || !board()) return;
    e.doc.transact(label, () => updateArtboard(e.doc, e.activeArtboard, p), { coalesce });
  };

  const presetSel = h('select.select', { 'aria-label': 'Artboard preset' }, h('option', { value: 'custom' }, 'Custom'), ARTBOARD_PRESETS.map((p) => h('option', { value: p.id }, p.label)));
  presetSel.addEventListener('change', () => {
    const p = ARTBOARD_PRESETS.find((q) => q.id === presetSel.value);
    const a = board();
    if (!p || !a) return;
    const land = a.w > a.h;
    patch(resizeAtRef(a, land ? Math.max(p.w, p.h) : Math.min(p.w, p.h), land ? Math.min(p.w, p.h) : Math.max(p.w, p.h)), 'Artboard Preset');
  });
  const orient = segmented(
    'Orientation',
    [
      { value: 'portrait', label: 'Portrait', icon: 'orient-portrait' },
      { value: 'landscape', label: 'Landscape', icon: 'orient-landscape' },
    ],
    'portrait',
    (v) => {
      const a = board();
      if (!a || (v === 'landscape') === a.w > a.h) return;
      patch(resizeAtRef(a, a.h, a.w), 'Artboard Orientation');
    },
  );
  const newBtn = iconButton('artboard-new', 'New Artboard', () => {
    const e = ed();
    const a = board();
    if (!e || !a) return;
    // A same-size artboard to the right of the rightmost one.
    const right = Math.max(...e.doc.artboards.map((b) => b.x + b.w));
    let index = -1;
    e.doc.transact('New Artboard', () => {
      index = addArtboard(e.doc, { x: right + 20, y: a.y, w: a.w, h: a.h });
    });
    e.setActiveArtboard(index);
  });
  const delBtn = iconButton('trash', 'Delete Artboard', () => app.getTool('artboard')?.deleteActive());
  const nameId = `ab-name-${Math.random().toString(36).slice(2, 7)}`;
  const nameInput = h('input.text-input', {
    type: 'text',
    id: nameId,
    spellcheck: false,
    autocomplete: 'off',
    onkeydown: (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') nameInput.blur();
      if (e.key === 'Escape') {
        nameInput.value = board()?.name || '';
        nameInput.blur();
      }
    },
    onchange: () => {
      const v = nameInput.value.trim();
      if (v && v !== board()?.name) patch({ name: v }, 'Rename Artboard');
    },
  });
  // X and Y name the reference point (center by default); W and H resize around it.
  const at = (fn) => (v, o) => {
    const a = board();
    if (a) fn(a, v, o);
  };
  const fx = numberField({ label: 'X', value: 0, unit: unit(), min: -ARTBOARD_MAX, max: ARTBOARD_MAX, onCommit: at((a, v, o) => patch(rectAtRef(a.w, a.h, v, refPoint(a).y), 'Move Artboard', o?.live ? 'ab-x' : null)) });
  const fy = numberField({ label: 'Y', value: 0, unit: unit(), min: -ARTBOARD_MAX, max: ARTBOARD_MAX, onCommit: at((a, v, o) => patch(rectAtRef(a.w, a.h, refPoint(a).x, v), 'Move Artboard', o?.live ? 'ab-y' : null)) });
  const fw = numberField({ label: 'W', value: 0, unit: unit(), min: 1, max: ARTBOARD_MAX, onCommit: at((a, v, o) => patch(resizeAtRef(a, v, a.h), 'Resize Artboard', o?.live ? 'ab-w' : null)) });
  const fh = numberField({ label: 'H', value: 0, unit: unit(), min: 1, max: ARTBOARD_MAX, onCommit: at((a, v, o) => patch(resizeAtRef(a, a.w, v), 'Resize Artboard', o?.live ? 'ab-h' : null)) });
  const ref = referencePointGrid(artboardRef.index, (i) => {
    artboardRef.index = i;
    refresh();
  });
  const moveId = `ab-move-${Math.random().toString(36).slice(2, 7)}`;
  const moveChk = h('input', { type: 'checkbox', id: moveId, onchange: () => app.prefs.set('artboardMoveArtwork', moveChk.checked) });
  const rearrange = h('button.btn', { type: 'button', onclick: () => app.commands.run('artboards.rearrange') }, 'Rearrange All');
  const options = h('button.btn', { type: 'button', onclick: () => app.commands.run('artboards.options', { index: ed()?.activeArtboard ?? 0 }) }, 'Artboard Options');
  const exit = h('button.btn.primary', { type: 'button', onclick: () => app.setTool(app.lastSelectionTool || 'selection') }, 'Exit');

  const el = h(
    'div.ab-controls',
    h('div.prop-row', h('span.prop-label', 'Preset'), presetSel),
    h('div.ab-row', orient.el, h('span.ab-spacer'), newBtn, delBtn),
    h('div.prop-row', h('label.prop-label', { for: nameId }, 'Name'), nameInput),
    h('div.tf-grid.ab-tf', ref.el, h('div.tf-fields.ab-fields', fx.el, fw.el, fy.el, fh.el)),
    h('div.check-row', moveChk, h('label', { for: moveId }, 'Move/Copy Artwork with Artboard')),
    h('div.quick-actions.ab-actions', rearrange, options, exit),
  );

  const refresh = () => {
    const e = ed();
    const a = board();
    if (!e || !a) return;
    const u = unit();
    for (const f of [fx, fy, fw, fh]) {
      f.setUnit(u);
    }
    const p = refPoint(a);
    ref.set(artboardRef.index);
    fx.set(p.x);
    fy.set(p.y);
    fw.set(a.w);
    fh.set(a.h);
    presetSel.value = presetFor(a.w, a.h);
    orient.set(a.w > a.h ? 'landscape' : 'portrait');
    if (document.activeElement !== nameInput) nameInput.value = a.name;
    delBtn.disabled = e.doc.artboards.length <= 1;
    moveChk.checked = moveArtworkEnabled(app);
  };
  return { el, refresh };
}
