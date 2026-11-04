/**
 * Create Names from Selection: choose which edges of the selection hold the
 * labels. Each labelled row or column becomes a workbook name in one undo step.
 */

import { el, fieldId } from './dom.js';
import { openModal, fieldAlert, confirmDialog } from './modal.js';
import { toast } from './toast.js';
import { rangeName } from '../core/cell.js';
import { t } from '../i18n/index.js';
import { createNamesFromSelection, guessLabelEdges, namesFromSelection, namesReplacedBySelection } from '../core/names-from-selection.js';

export function openCreateNamesDialog(ctx, range) {
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  const guess = guessLabelEdges(wb, sheetId, range);
  const edges = [['top', 'createnames.edge.top'], ['left', 'createnames.edge.left'], ['bottom', 'createnames.edge.bottom'], ['right', 'createnames.edge.right']];
  // Items in a list of names, "A, B, C" in English and "A、B、C" in Chinese.
  const join = (items) => items.reduce((a, b) => t('createnames.listJoin', { a, b }));
  const boxes = Object.fromEntries(edges.map(([key]) => [key, el('input', { type: 'checkbox', id: fieldId('cn'), checked: !!guess[key] })]));
  const preview = el('p.small.muted', { role: 'status' });
  const chosen = () => Object.fromEntries(edges.map(([key]) => [key, boxes[key].checked]));
  const update = () => {
    const names = namesFromSelection(wb, sheetId, range, chosen());
    preview.textContent = names.length
      ? t('createnames.preview', { count: names.length, names: join([...names.slice(0, 6).map(n => n.name), ...(names.length > 6 ? ['…'] : [])]) })
      : t('createnames.noLabels');
  };
  for (const box of Object.values(boxes)) box.addEventListener('change', update);
  const { alert: error, refuse } = fieldAlert('cn');
  let asking = false;
  const submit = async e => {
    e?.preventDefault();
    if (asking) return;
    if (!edges.some(([key]) => boxes[key].checked)) return refuse(boxes.top, t('createnames.chooseEdge'));
    if (!namesFromSelection(wb, sheetId, range, chosen()).length) return refuse(boxes.top, t('createnames.edgesEmpty'));
    // A name formulas already use is not pointed at other cells unasked, as Excel asks first: its definition was
    // replaced in silence, every formula reading it then reading the new cells.
    const clashes = namesReplacedBySelection(wb, sheetId, range, chosen());
    let replace = true;
    if (clashes.length) {
      const shown = join(clashes.slice(0, 3).map(n => t('createnames.clash', { name: n.name, ref: n.ref.replace(/^=/, '') })));
      const list = clashes.length > 3 ? t('createnames.clashMore', { list: shown, count: clashes.length - 3 }) : shown;
      asking = true;
      try {
        replace = await confirmDialog({
          title: t('createnames.replaceTitle', { count: clashes.length }),
          message: t('createnames.replaceMessage', { count: clashes.length, list }),
          confirmLabel: t('common.replace'), cancelLabel: t('createnames.keepExisting'), danger: false, dismissValue: null,
        });
      } finally { asking = false; }
      if (replace == null) return; // dismissed: the dialog stays, as Excel's Cancel leaves it
    }
    const { created, replaced, kept, skipped } = createNamesFromSelection(wb, sheetId, range, chosen(), { replace });
    if (!created && !replaced) return refuse(boxes.top, kept ? t('createnames.allKept', { count: kept }) : skipped[0] ? t('createnames.skippedReason', { name: skipped[0].name, reason: skipped[0].reason }) : t('createnames.noneCreated'));
    modal.close();
    const parts = [created && t('createnames.done.created', { count: created }), replaced && t('createnames.done.replaced', { count: replaced }), kept && t('createnames.done.kept', { count: kept }),
      skipped.length && t('createnames.done.skipped', { count: skipped.length, name: skipped[0].name, reason: skipped[0].reason })].filter(Boolean);
    toast(parts.reduce((a, b) => t('createnames.done.join', { a, b })), { icon: 'tag', duration: skipped.length ? 5000 : 2600 });
  };
  const content = el('form', { onsubmit: submit },
    el('p.small.muted', {}, t('createnames.intro', { range: rangeName(range) })),
    el('fieldset.create-names-edges', {}, el('legend.visually-hidden', {}, t('createnames.legend')),
      ...edges.map(([key, label]) => el('label.find-option', { for: boxes[key].id }, boxes[key], el('span', {}, t(label))))),
    preview, error,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('common.ok'))));
  const modal = openModal({ title: t('createnames.title'), content, className: 'create-names', initialFocus: boxes.top, onClose: () => ctx.grid?.focus?.() });
  update();
  return modal;
}
