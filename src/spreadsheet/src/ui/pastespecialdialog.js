/**
 * The Paste Special dialog (Ctrl+Alt+V, Cmd+Ctrl+V on a Mac): what to paste, an operation, Skip
 * blanks and Transpose, and Paste Link; the choices another app's content cannot carry are greyed.
 * Each option is chosen by its underlined letter too. Also the Insert
 * Paste dialog (Insert Copied Cells) and the Paste gallery shared by the ribbon, the cell menu and the
 * Paste Options button.
 */
import { el, fieldId, isComposing } from './dom.js';
import { openModal } from './modal.js';
import { PASTE_WHAT, OPERATIONS, EXTERNAL_WHAT } from '../core/paste-special.js';

/** The Paste gallery (Home ▸ Paste arrow, the Paste Options button): label, icon, options. */
export function pasteGallery({ external = false } = {}) {
  if (external) {
    return [
      { label: 'Keep Source Formatting', icon: 'paste', paste: { what: 'all' } },
      { label: 'Match Destination Formatting', icon: 'paint', paste: { what: 'formulas' } },
      { label: 'Values', icon: 'number', paste: { what: 'values' } },
      { label: 'Transpose', icon: 'swap', paste: { what: 'all', transpose: true } },
    ];
  }
  return [
    { header: 'Paste' },
    { label: 'Paste', icon: 'paste', paste: { what: 'all' } },
    { label: 'Formulas', icon: 'fx', paste: { what: 'formulas' } },
    { label: 'Formulas & Number Formatting', icon: 'percent', paste: { what: 'formulasNumFmt' } },
    { label: 'Keep Source Formatting', icon: 'paint', paste: { what: 'allSourceTheme' } },
    { label: 'No Borders', icon: 'borderNone', paste: { what: 'noBorders' } },
    { label: 'Keep Source Column Widths', icon: 'cols', paste: { what: 'allWidths' } },
    { label: 'Transpose', icon: 'swap', paste: { what: 'all', transpose: true } },
    { header: 'Paste Values' },
    { label: 'Values', icon: 'number', paste: { what: 'values' } },
    { label: 'Values & Number Formatting', icon: 'percent', paste: { what: 'valuesNumFmt' } },
    { label: 'Values & Source Formatting', icon: 'paint', paste: { what: 'valuesSourceFmt' } },
    { header: 'Other Paste Options' },
    { label: 'Formatting', icon: 'paint', paste: { what: 'formats' } },
    { label: 'Paste Link', icon: 'link', paste: { link: true } },
    // A picture of the copied cells, as they look now or (linked) as they come to look.
    { label: 'Picture', icon: 'pastePicture', paste: { picture: true } },
    { label: 'Linked Picture', icon: 'linkedPicture', paste: { picture: 'linked' } },
  ];
}

/** The gallery as menu-bar items running `pasteWith`, ending in Paste Special…. */
export function pasteGalleryItems({ disabled = false } = {}) {
  return [...pasteGallery().map((item) => (item.header ? item : { label: item.label, icon: item.icon, cmd: 'pasteWith', arg: item.paste, disabled })),
    { separator: true }, { label: 'Paste Special…', icon: 'paste', cmd: 'pasteSpecialMenu', disabled }];
}

/** The label with its access letter underlined (the first occurrence). */
function underlined(label, key) {
  const at = label.toUpperCase().indexOf(key);
  if (at < 0) return [label];
  return [label.slice(0, at), el('u', {}, label[at]), label.slice(at + 1)];
}

/**
 * Open the dialog. `external` greys what another app's content cannot carry. `onPaste(options)` runs
 * on OK; `onPasteLink()` on Paste Link. Returns the modal.
 */
export function openPasteSpecialDialog({ external = false, onPaste, onPasteLink, onClose, initial = null }) {
  const whatName = fieldId('paste-what'), opName = fieldId('paste-op');
  const radio = (name, [value, label, key], checked, disabled) => {
    const node = el('label.check', { dataset: { key } }, el('input', { type: 'radio', name, value, checked, disabled }), el('span', {}, ...underlined(label, key)));
    node.classList.toggle('is-disabled', !!disabled);
    return node;
  };
  const whatRadios = PASTE_WHAT.map((choice) => radio(whatName, choice, choice[0] === (initial?.what || 'all'), external && !EXTERNAL_WHAT.has(choice[0])));
  const opRadios = OPERATIONS.map((choice) => radio(opName, choice, choice[0] === (initial?.operation || 'none'), false));
  const skip = el('input', { type: 'checkbox', checked: !!initial?.skipBlanks });
  const transpose = el('input', { type: 'checkbox', checked: !!initial?.transpose });
  const skipLabel = el('label.check', { dataset: { key: 'B' } }, skip, el('span', {}, ...underlined('Skip blanks', 'B')));
  const transposeLabel = el('label.check', { dataset: { key: 'E' } }, transpose, el('span', {}, ...underlined('Transpose', 'E')));
  const link = el('button.btn.btn-ghost', { type: 'button', dataset: { key: 'L' }, onclick: () => { if (link.disabled) return; modal.close(); onPasteLink?.(); } }, el('span', {}, ...underlined('Paste Link', 'L')));
  const value = (name) => form.querySelector(`input[name="${name}"]:checked`)?.value;
  const options = () => ({ what: value(whatName) || 'all', operation: value(opName) || 'none', skipBlanks: skip.checked, transpose: transpose.checked });
  // What a choice rules out, greyed in the dialog: no arithmetic on formats, notes, rules or widths,
  // and Paste Link only for the whole cells as they are.
  const sync = () => {
    const o = options();
    const noOp = ['formats', 'comments', 'validation', 'widths'].includes(o.what);
    for (const label of opRadios) { const input = label.querySelector('input'); input.disabled = noOp; label.classList.toggle('is-disabled', noOp); }
    if (noOp) form.querySelector(`input[name="${opName}"][value="none"]`).checked = true;
    const widths = o.what === 'widths';
    for (const [input, label] of [[skip, skipLabel], [transpose, transposeLabel]]) { input.disabled = widths; label.classList.toggle('is-disabled', widths); }
    link.disabled = external || !['all', 'allSourceTheme', 'noBorders'].includes(o.what) || o.operation !== 'none' || o.skipBlanks || o.transpose;
  };
  const form = el('form.paste-special', {
    onsubmit: (e) => { e.preventDefault(); const o = options(); modal.close(); onPaste?.(o); },
    onchange: sync,
    onkeydown: (e) => {
      // The underlined letter picks its choice, with Alt or alone.
      if (isComposing(e) || e.ctrlKey || e.metaKey || e.key.length !== 1) return;
      const key = e.key.toUpperCase();
      const target = form.querySelector(`[data-key="${key}"]`);
      if (!target) return;
      e.preventDefault();
      if (target.tagName === 'BUTTON') { target.click(); return; }
      const input = target.querySelector('input');
      if (!input || input.disabled) return;
      if (input.type === 'checkbox') input.checked = !input.checked; else input.checked = true;
      input.focus();
      sync();
    },
  },
  el('fieldset.paste-special-group', { role: 'radiogroup', 'aria-label': 'Paste' }, el('legend', {}, 'Paste'), el('div.paste-special-grid', {}, ...whatRadios)),
  el('fieldset.paste-special-group', { role: 'radiogroup', 'aria-label': 'Operation' }, el('legend', {}, 'Operation'), el('div.paste-special-grid.paste-special-ops', {}, ...opRadios)),
  el('div.paste-special-checks', {}, skipLabel, transposeLabel),
  el('div.row.paste-special-actions', {},
    link,
    el('span.paste-special-gap'),
    el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
    el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
  sync();
  const modal = openModal({ title: 'Paste Special', content: form, className: 'paste-special-panel', initialFocus: form.querySelector(`input[name="${whatName}"]:checked`), onClose });
  return modal;
}

/** The Insert Paste dialog for Insert Copied Cells: shift the cells right or down. */
export function openInsertPasteDialog({ range, onInsert, onClose }) {
  const name = fieldId('insert-paste');
  // As Insert Cells… does: a selection wider than it is tall shifts down, otherwise right.
  const wide = range ? range.c2 - range.c1 > range.r2 - range.r1 : false;
  const radios = [['right', 'Shift cells right', !wide], ['down', 'Shift cells down', wide]].map(([value, label, checked]) => el('label.check', {},
    el('input', { type: 'radio', name, value, checked }), el('span', {}, label)));
  const form = el('form.insert-delete-cells', {
    onsubmit: (e) => { e.preventDefault(); const value = form.querySelector(`input[name="${name}"]:checked`)?.value; modal.close(); if (value) onInsert?.(value); },
  },
  el('fieldset.check-group.vertical', { role: 'radiogroup', 'aria-label': 'Insert Paste' }, ...radios),
  el('div.row.row-end', { style: { marginTop: '14px' } },
    el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
    el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
  const modal = openModal({ title: 'Insert Paste', content: form, initialFocus: form.querySelector('input:checked'), onClose });
  return modal;
}
