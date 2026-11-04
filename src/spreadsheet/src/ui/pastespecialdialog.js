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
import { t } from '../i18n/index.js';

/** The Paste gallery (Home ▸ Paste arrow, the Paste Options button): label, icon, options. */
export function pasteGallery({ external = false } = {}) {
  if (external) {
    return [
      { label: t('pastespecialdialog.gallery.keepSource'), icon: 'paste', paste: { what: 'all' } },
      { label: t('pastespecialdialog.gallery.matchDestination'), icon: 'paint', paste: { what: 'formulas' } },
      { label: t('pastespecialdialog.gallery.values'), icon: 'number', paste: { what: 'values' } },
      { label: t('pastespecialdialog.gallery.transpose'), icon: 'swap', paste: { what: 'all', transpose: true } },
    ];
  }
  return [
    { header: t('pastespecialdialog.gallery.paste') },
    { label: t('pastespecialdialog.gallery.paste'), icon: 'paste', paste: { what: 'all' } },
    { label: t('pastespecialdialog.gallery.formulas'), icon: 'fx', paste: { what: 'formulas' } },
    { label: t('pastespecialdialog.gallery.formulasNumFmt'), icon: 'percent', paste: { what: 'formulasNumFmt' } },
    { label: t('pastespecialdialog.gallery.keepSource'), icon: 'paint', paste: { what: 'allSourceTheme' } },
    { label: t('pastespecialdialog.gallery.noBorders'), icon: 'borderNone', paste: { what: 'noBorders' } },
    { label: t('pastespecialdialog.gallery.keepWidths'), icon: 'cols', paste: { what: 'allWidths' } },
    { label: t('pastespecialdialog.gallery.transpose'), icon: 'swap', paste: { what: 'all', transpose: true } },
    { header: t('pastespecialdialog.gallery.pasteValues') },
    { label: t('pastespecialdialog.gallery.values'), icon: 'number', paste: { what: 'values' } },
    { label: t('pastespecialdialog.gallery.valuesNumFmt'), icon: 'percent', paste: { what: 'valuesNumFmt' } },
    { label: t('pastespecialdialog.gallery.valuesSourceFmt'), icon: 'paint', paste: { what: 'valuesSourceFmt' } },
    { header: t('pastespecialdialog.gallery.other') },
    { label: t('pastespecialdialog.gallery.formatting'), icon: 'paint', paste: { what: 'formats' } },
    { label: t('pastespecialdialog.gallery.pasteLink'), icon: 'link', paste: { link: true } },
    // A picture of the copied cells, as they look now or (linked) as they come to look.
    { label: t('pastespecialdialog.gallery.picture'), icon: 'pastePicture', paste: { picture: true } },
    { label: t('pastespecialdialog.gallery.linkedPicture'), icon: 'linkedPicture', paste: { picture: 'linked' } },
  ];
}

/** The gallery as menu-bar items running `pasteWith`, ending in Paste Special…. */
export function pasteGalleryItems({ disabled = false } = {}) {
  return [...pasteGallery().map((item) => (item.header ? item : { label: item.label, icon: item.icon, cmd: 'pasteWith', arg: item.paste, disabled })),
    { separator: true }, { label: t('pastespecialdialog.pasteSpecialMenu'), icon: 'paste', cmd: 'pasteSpecialMenu', disabled }];
}

/**
 * The label with its access letter underlined (the first occurrence); a label without the letter (a
 * translation) is followed by it in parentheses, as in Excel's Chinese edition: 转置(E).
 */
function underlined(label, key) {
  const at = label.toUpperCase().indexOf(key);
  if (at < 0) return [label, '(', el('u', {}, key), ')'];
  return [label.slice(0, at), el('u', {}, label[at]), label.slice(at + 1)];
}

/**
 * Open the dialog. `external` greys what another app's content cannot carry. `onPaste(options)` runs
 * on OK; `onPasteLink()` on Paste Link. Returns the modal.
 */
export function openPasteSpecialDialog({ external = false, onPaste, onPasteLink, onClose, initial = null }) {
  const whatName = fieldId('paste-what'), opName = fieldId('paste-op');
  const radio = (name, [value, label, key], checked, disabled) => {
    const node = el('label.check', { dataset: { key } }, el('input', { type: 'radio', name, value, checked, disabled }), el('span', {}, ...underlined(t(label), key)));
    node.classList.toggle('is-disabled', !!disabled);
    return node;
  };
  const whatRadios = PASTE_WHAT.map((choice) => radio(whatName, choice, choice[0] === (initial?.what || 'all'), external && !EXTERNAL_WHAT.has(choice[0])));
  const opRadios = OPERATIONS.map((choice) => radio(opName, choice, choice[0] === (initial?.operation || 'none'), false));
  const skip = el('input', { type: 'checkbox', checked: !!initial?.skipBlanks });
  const transpose = el('input', { type: 'checkbox', checked: !!initial?.transpose });
  const skipLabel = el('label.check', { dataset: { key: 'B' } }, skip, el('span', {}, ...underlined(t('pastespecialdialog.skipBlanks'), 'B')));
  const transposeLabel = el('label.check', { dataset: { key: 'E' } }, transpose, el('span', {}, ...underlined(t('pastespecialdialog.transpose'), 'E')));
  const link = el('button.btn.btn-ghost', { type: 'button', dataset: { key: 'L' }, onclick: () => { if (link.disabled) return; modal.close(); onPasteLink?.(); } }, el('span', {}, ...underlined(t('pastespecialdialog.gallery.pasteLink'), 'L')));
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
  el('fieldset.paste-special-group', { role: 'radiogroup', 'aria-label': t('pastespecialdialog.gallery.paste') }, el('legend', {}, t('pastespecialdialog.gallery.paste')), el('div.paste-special-grid', {}, ...whatRadios)),
  el('fieldset.paste-special-group', { role: 'radiogroup', 'aria-label': t('pastespecialdialog.operation') }, el('legend', {}, t('pastespecialdialog.operation')), el('div.paste-special-grid.paste-special-ops', {}, ...opRadios)),
  el('div.paste-special-checks', {}, skipLabel, transposeLabel),
  el('div.row.paste-special-actions', {},
    link,
    el('span.paste-special-gap'),
    el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
    el('button.btn.btn-primary', { type: 'submit' }, t('common.ok'))));
  sync();
  const modal = openModal({ title: t('pastespecialdialog.title'), content: form, className: 'paste-special-panel', initialFocus: form.querySelector(`input[name="${whatName}"]:checked`), onClose });
  return modal;
}

/** The Insert Paste dialog for Insert Copied Cells: shift the cells right or down. */
export function openInsertPasteDialog({ range, onInsert, onClose }) {
  const name = fieldId('insert-paste');
  // As Insert Cells… does: a selection wider than it is tall shifts down, otherwise right.
  const wide = range ? range.c2 - range.c1 > range.r2 - range.r1 : false;
  const radios = [['right', t('pastespecialdialog.insert.shiftRight'), !wide], ['down', t('pastespecialdialog.insert.shiftDown'), wide]].map(([value, label, checked]) => el('label.check', {},
    el('input', { type: 'radio', name, value, checked }), el('span', {}, label)));
  const form = el('form.insert-delete-cells', {
    onsubmit: (e) => { e.preventDefault(); const value = form.querySelector(`input[name="${name}"]:checked`)?.value; modal.close(); if (value) onInsert?.(value); },
  },
  el('fieldset.check-group.vertical', { role: 'radiogroup', 'aria-label': t('pastespecialdialog.insert.title') }, ...radios),
  el('div.row.row-end', { style: { marginTop: '14px' } },
    el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
    el('button.btn.btn-primary', { type: 'submit' }, t('common.ok'))));
  const modal = openModal({ title: t('pastespecialdialog.insert.title'), content: form, initialFocus: form.querySelector('input:checked'), onClose });
  return modal;
}
