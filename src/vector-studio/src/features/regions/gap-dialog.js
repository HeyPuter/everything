/**
 * Gap Options: whether paint stops at small gaps between paths, how big a
 * gap may be, the color gaps preview in (View > Show Paint Region Gaps),
 * and a button that closes the current gaps with real paths. Edits the
 * selected regions groups with a live preview and a live gap count, or
 * the defaults for new groups when none is selected.
 */
import { h } from '../../lib/dom.js';
import { numberField } from '../../ui/widgets.js';
import { formatLength } from '../../lib/units.js';
import { DEFAULT_GAPS, GAP_SIZES, isRegions, regionMap, closeGapsWithPaths } from './regions-model.js';

/** Regions groups in or above the selection, or the isolated one. */
export function selectedRegions(editor) {
  if (!editor) return [];
  const out = new Set();
  for (const id of editor.topSelection()) {
    let n = editor.doc.get(id);
    while (n && !isRegions(n)) n = n.parent ? editor.doc.get(n.parent) : null;
    if (n) out.add(n.id);
  }
  if (!out.size && editor.isolation && isRegions(editor.doc.get(editor.isolation))) out.add(editor.isolation);
  return [...out];
}

export function gapDefaults(app) {
  return { ...DEFAULT_GAPS, ...(app.prefs.get('regionGaps') || {}) };
}

export async function gapOptionsDialog(app) {
  const ed = app.editor;
  const doc = ed?.doc;
  const ids = selectedRegions(ed);
  const unit = doc?.root.units || 'pt';
  let state = ids.length ? { ...DEFAULT_GAPS, ...(doc.get(ids[0]).live.gaps || {}) } : gapDefaults(app);
  let closed = false;
  let tx = null;
  const uid = Math.random().toString(36).slice(2, 7);
  const on = h('input', { type: 'checkbox', id: `rg-on-${uid}`, checked: state.on, onchange: () => update({ on: on.checked }) });
  const sizeSel = h(
    'select.select',
    { id: `rg-size-${uid}`, onchange: () => update({ size: sizeSel.value }) },
    [
      ['small', `Small gaps (${formatLength(GAP_SIZES.small, unit)})`],
      ['medium', `Medium gaps (${formatLength(GAP_SIZES.medium, unit)})`],
      ['large', `Large gaps (${formatLength(GAP_SIZES.large, unit)})`],
      ['custom', 'Custom'],
    ].map(([v, l]) => h('option', { value: v, selected: v === state.size }, l)),
  );
  const custom = numberField({ label: 'Custom gap size', icon: 'regions-gaps', value: state.custom, unit, min: 0, max: 720, onCommit: (v) => update({ custom: v, size: 'custom' }) });
  const color = h('input', { type: 'color', id: `rg-color-${uid}`, value: state.color, oninput: () => update({ color: color.value }) });
  const found = h('output', { 'aria-live': 'polite' }, '0');
  const closeBtn = h('button.btn', { type: 'button', onclick: () => closeGaps() }, 'Close Gaps with Paths');
  const prev = h('input', { type: 'checkbox', id: `rg-prev-${uid}`, checked: true, onchange: () => run() });

  const sync = () => {
    on.checked = state.on;
    color.value = state.color;
    sizeSel.value = state.size;
    custom.set(state.size === 'custom' ? state.custom : GAP_SIZES[state.size]);
    sizeSel.disabled = !state.on;
    custom.input.disabled = !state.on || state.size !== 'custom';
    let count = 0;
    for (const id of ids) {
      const g = doc.get(id);
      if (g) count += regionMap(doc, g).gaps.length;
    }
    found.textContent = String(count);
    closeBtn.disabled = !count;
  };
  const apply = () => {
    for (const id of ids) doc.update(id, { live: { ...doc.get(id).live, gaps: { ...state } } });
    if (closed) for (const id of ids) closeGapsWithPaths(doc, id);
  };
  const run = () => {
    if (!ids.length) return sync();
    if (tx) tx.cancel();
    tx = null;
    if (prev.checked || closed) {
      tx = doc.begin('Gap Options');
      apply();
    }
    sync();
  };
  const update = (patch) => {
    state = { ...state, ...patch };
    run();
  };
  const closeGaps = () => {
    // Paths keep the regions closed whatever the gap setting; they join the preview step.
    closed = true;
    run();
  };
  run();
  const body = h(
    'div.form.rg-dialog',
    h('div.form-row.check', on, h('label', { for: on.id }, 'Gap detection')),
    h('div.form-row', h('label', { for: sizeSel.id }, 'Paint stops at'), h('div.rg-size', sizeSel, custom.el)),
    h('div.form-row', h('label', { for: color.id }, 'Gap preview color'), color),
    ids.length ? h('div.rg-found', h('span', 'Gaps found: ', found), closeBtn) : h('p.form-help', 'No Paint Regions group is selected: these options apply to new groups.'),
    ids.length ? h('div.form-row.check', prev, h('label', { for: prev.id }, 'Preview')) : null,
  );
  const ok = await app.dialogs.open({
    title: 'Gap Options',
    body,
    buttons: [
      // Reset goes back to the defaults; Set Default makes these settings the defaults for new groups.
      ...(ids.length
        ? [
            { label: 'Reset', left: true, validate: () => (update({ ...gapDefaults(app) }), false) },
            { label: 'Set Default', left: true, validate: () => (custom.input.dispatchEvent(new Event('blur')), app.prefs.set('regionGaps', { ...state }), app.notify('These gap options are now the defaults for new Paint Regions groups.', { polite: true }), false) },
          ]
        : []),
      { label: 'Cancel', value: null },
      { label: 'OK', primary: true, value: () => (custom.input.dispatchEvent(new Event('blur')), true) },
    ],
  });
  if (tx) tx.cancel();
  tx = null;
  if (!ok) return false;
  // Without a selected group the dialog edits the defaults.
  if (!ids.length) app.prefs.set('regionGaps', { ...state });
  if (ids.length) doc.transact('Gap Options', apply);
  return true;
}
