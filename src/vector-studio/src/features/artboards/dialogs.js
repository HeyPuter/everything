/**
 * Artboard Options and Rearrange All Artboards dialogs.
 */
import { h } from '../../lib/dom.js';
import { numberField, segmented } from '../../ui/widgets.js';
import { ARTBOARD_MAX, ARTBOARD_PRESETS, presetFor, updateArtboard, rearrangeArtboards, artboardRef, refPoint, rectAtRef, resizeAtRef } from './artboard-ops.js';
import { referencePointGrid } from '../../ui/panels/transform-section.js';

let fid = 0;
const nextId = (p) => `${p}-${++fid}`;

function labeled(label, control, id) {
  return h('div.form-row', h('label', { for: id }, label), control);
}

function checkRow(label, checked) {
  const id = nextId('ab-chk');
  const input = h('input', { type: 'checkbox', id, checked: Boolean(checked) });
  return { el: h('div.form-row.check', input, h('label', { for: id }, label)), input };
}

/** Artboard Options for artboard `index`. Resolves true when applied. */
export async function artboardOptionsDialog(app, index) {
  const ed = app.editor;
  if (!ed) return false;
  const board = ed.doc.artboards[index];
  if (!board) return false;
  const unit = ed.doc.root.units || 'pt';
  const state = { name: board.name, x: board.x, y: board.y, w: board.w, h: board.h };

  const nameId = nextId('ab-name');
  const nameInput = h('input', { type: 'text', id: nameId, value: board.name, spellcheck: false, autocomplete: 'off' });
  const presetId = nextId('ab-preset');
  const presetSel = h('select', { id: presetId }, h('option', { value: 'custom' }, 'Custom'), ARTBOARD_PRESETS.map((p) => h('option', { value: p.id }, p.label)));
  // X and Y name the reference point; W, H, presets and orientation resize around it.
  const resize = (w, hgt) => Object.assign(state, resizeAtRef(state, w, hgt));
  const fw = numberField({ label: 'Width', value: state.w, unit, min: 1, max: ARTBOARD_MAX, onCommit: (v) => (resize(v, state.h), sync()) });
  const fh = numberField({ label: 'Height', value: state.h, unit, min: 1, max: ARTBOARD_MAX, onCommit: (v) => (resize(state.w, v), sync()) });
  const fx = numberField({ label: 'X', value: state.x, unit, min: -ARTBOARD_MAX, max: ARTBOARD_MAX, onCommit: (v) => (Object.assign(state, rectAtRef(state.w, state.h, v, refPoint(state).y)), sync()) });
  const fy = numberField({ label: 'Y', value: state.y, unit, min: -ARTBOARD_MAX, max: ARTBOARD_MAX, onCommit: (v) => (Object.assign(state, rectAtRef(state.w, state.h, refPoint(state).x, v)), sync()) });
  const ref = referencePointGrid(artboardRef.index, (i) => {
    artboardRef.index = i;
    sync();
  });
  const orient = segmented(
    'Orientation',
    [
      { value: 'portrait', label: 'Portrait', icon: 'orient-portrait' },
      { value: 'landscape', label: 'Landscape', icon: 'orient-landscape' },
    ],
    state.w > state.h ? 'landscape' : 'portrait',
    (v) => {
      const land = state.w > state.h;
      if ((v === 'landscape') !== land) resize(state.h, state.w);
      sync();
    },
  );
  const center = checkRow('Show Center Mark', board.showCenter);
  const cross = checkRow('Show Cross Hairs', board.showCross);

  const sync = () => {
    const p = refPoint(state);
    fw.set(state.w);
    fh.set(state.h);
    fx.set(p.x);
    fy.set(p.y);
    presetSel.value = presetFor(state.w, state.h);
    orient.set(state.w > state.h ? 'landscape' : 'portrait');
  };
  presetSel.addEventListener('change', () => {
    const p = ARTBOARD_PRESETS.find((q) => q.id === presetSel.value);
    if (!p) return;
    const land = state.w > state.h;
    resize(land ? Math.max(p.w, p.h) : Math.min(p.w, p.h), land ? Math.min(p.w, p.h) : Math.max(p.w, p.h));
    sync();
  });
  sync();

  const body = h(
    'div.form.ab-options',
    labeled('Name', nameInput, nameId),
    labeled('Preset', presetSel, presetId),
    h('div.ab-geom', h('div.ab-grid', fw.el, fx.el, fh.el, fy.el), ref.el),
    h('div.form-row', h('span.form-label', 'Orientation'), orient.el),
    h('h3.form-heading', 'Display'),
    center.el,
    cross.el,
    h('p.form-help', `Artboard ${index + 1} of ${ed.doc.artboards.length}`),
  );
  const ok = await app.dialogs.open({
    title: 'Artboard Options',
    body,
    className: 'ab-options-dialog',
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'OK',
        primary: true,
        value: () => {
          // Commit any field still being edited.
          for (const f of [fw, fh, fx, fy]) f.input.dispatchEvent(new Event('blur'));
          return true;
        },
      },
    ],
  });
  if (!ok || !ed.doc.artboards[index]) return false;
  const name = nameInput.value.trim() || board.name;
  ed.doc.transact('Artboard Options', () => updateArtboard(ed.doc, index, { name, x: state.x, y: state.y, w: state.w, h: state.h, showCenter: center.input.checked, showCross: cross.input.checked }));
  return true;
}

const LAYOUTS = [
  { value: 'gridRow', label: 'Grid by Row', icon: 'layout-grid-row' },
  { value: 'gridColumn', label: 'Grid by Column', icon: 'layout-grid-col' },
  { value: 'row', label: 'Arrange by Row', icon: 'layout-row' },
  { value: 'column', label: 'Arrange by Column', icon: 'layout-col' },
];

/** Rearrange All Artboards dialog. */
export async function rearrangeDialog(app) {
  const ed = app.editor;
  if (!ed) return false;
  const last = app.prefs.get('artboardRearrange') || {};
  const state = { layout: last.layout || 'gridRow', columns: last.columns || Math.max(1, Math.ceil(Math.sqrt(ed.doc.artboards.length))), spacing: last.spacing ?? 20, moveArtwork: last.moveArtwork ?? true, rtl: Boolean(last.rtl) };
  const unit = ed.doc.root.units || 'pt';
  const layout = segmented('Layout', LAYOUTS, state.layout, (v) => {
    state.layout = v;
    layout.set(v);
    colLabel.textContent = v === 'gridColumn' ? 'Rows' : 'Columns';
    cols.input.disabled = v === 'row' || v === 'column';
  });
  const cols = numberField({ label: 'Columns', kind: 'number', value: state.columns, min: 1, max: 1000, onCommit: (v) => (state.columns = Math.round(v)) });
  const colLabel = cols.el.querySelector('label');
  colLabel.textContent = state.layout === 'gridColumn' ? 'Rows' : 'Columns';
  cols.input.disabled = state.layout === 'row' || state.layout === 'column';
  const spacing = numberField({ label: 'Spacing', value: state.spacing, unit, min: 0, onCommit: (v) => (state.spacing = v) });
  const rtl = checkRow('Right-to-left layout', state.rtl);
  const move = checkRow('Move Artwork with Artboard', state.moveArtwork);
  const body = h('div.form.ab-rearrange', h('div.form-row', h('span.form-label', 'Layout'), layout.el), h('div.ab-grid', cols.el, spacing.el), rtl.el, move.el);
  const ok = await app.dialogs.open({
    title: 'Rearrange All Artboards',
    body,
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'OK', primary: true, value: () => (cols.input.dispatchEvent(new Event('blur')), spacing.input.dispatchEvent(new Event('blur')), true) },
    ],
  });
  if (!ok) return false;
  state.rtl = rtl.input.checked;
  state.moveArtwork = move.input.checked;
  app.prefs.set('artboardRearrange', { ...state });
  ed.doc.transact('Rearrange All Artboards', () => rearrangeArtboards(ed.doc, state));
  ed.fitAll();
  return true;
}
