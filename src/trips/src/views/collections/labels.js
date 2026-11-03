// Label manager: add, rename, recolor and delete a collection's labels. Deleting removes the label from its places.
import { el, uid } from '../../ui/dom.js';
import { button, iconButton, emptyState } from '../../ui/bits.js';
import { openModal, confirmDialog } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../lib/i18n/index.js';
import { appendOrders, fold } from './model.js';
import { COLORS, colorValue, placeCount } from './metaform.js';

export const LABEL_MAX = 100;

/** Ops that delete labels and take them off every place that has them. */
export function deleteLabelOps(space, ids) {
  const gone = new Set(ids);
  const ops = [];
  for (const item of space.select.saved.all()) {
    const labels = item.labels ?? [];
    if (!labels.some((id) => gone.has(id))) continue;
    const rest = labels.filter((id) => !gone.has(id));
    ops.push(space.ops.patch('saved', item.id, rest.length ? { set: { labels: rest } } : { unset: ['labels'] }));
  }
  for (const id of gone) if (space.get('label', id)) ops.push(space.ops.remove('label', id));
  return ops;
}

export function openLabelManager({ space, canEdit }) {
  const offs = [];
  const listId = uid('col-labels');
  const list = el('ul.col-label-list', { 'aria-labelledby': listId });
  const name = el('input.input', { maxLength: LABEL_MAX, autocomplete: 'off', placeholder: t('collections.labelNew'), 'aria-label': t('collections.labelNew') });
  const alert = el('p.col-alert', { role: 'alert', hidden: true });
  const add = el('form.col-label-add', { onsubmit: (event) => { event.preventDefault(); void create(); } }, name, button(t('collections.labelAdd'), { type: 'submit', variant: 'primary', size: 'sm' }));
  add.hidden = !canEdit;

  async function apply(ops) {
    try { await space.apply(ops); return true; } catch { toast(t('collections.saveFailed')); return false; }
  }
  async function create() {
    const value = name.value.replace(/\s+/g, ' ').trim();
    alert.hidden = true;
    if (!value) { name.focus(); return; }
    if (space.select.label.all().some((label) => fold(label.name) === fold(value))) { alert.textContent = t('collections.labelExists'); alert.hidden = false; return; }
    const color = COLORS[space.select.label.all().length % COLORS.length];
    if (await apply([space.ops.create('label', { name: value, color, order: appendOrders(space.select.label.all(), 1)[0] })])) { name.value = ''; name.focus(); }
  }
  function row(label) {
    const input = el('input.input', { value: label.name, maxLength: LABEL_MAX, disabled: !canEdit, 'aria-label': t('collections.labelName', { name: label.name }) });
    input.addEventListener('change', () => {
      const value = input.value.replace(/\s+/g, ' ').trim();
      if (!value || value === label.name) { input.value = label.name; return; }
      void apply([space.ops.patch('label', label.id, { set: { name: value } })]);
    });
    const color = el('select.select.col-label-color', { disabled: !canEdit, 'aria-label': t('collections.labelColor', { name: label.name }) },
      COLORS.map((value) => el('option', { value: String(value), selected: label.color === value }, t('collections.colorN', { n: value }))));
    color.addEventListener('change', () => void apply([space.ops.patch('label', label.id, { set: { color: Number(color.value) } })]));
    const used = space.select.saved.all().filter((item) => item.labels?.includes(label.id)).length;
    return el('li.col-label-row', { dataset: { id: label.id } },
      el('span.col-dot', { style: { '--col-color': colorValue(label.color) }, 'aria-hidden': 'true' }), input, color,
      el('span.col-hint.num', {}, placeCount(used)),
      canEdit && iconButton('trash', t('collections.labelDelete', { name: label.name }), { onclick: () => void remove(label, used) }));
  }
  async function remove(label, used) {
    const ok = await confirmDialog({ title: t('collections.labelDeleteTitle', { name: label.name }), body: used ? t('collections.labelDeleteBody', { count: used }) : t('collections.labelDeleteEmpty'),
      confirmLabel: t('collections.delete'), danger: true });
    if (ok) await apply(deleteLabelOps(space, [label.id]));
  }
  function render() {
    const labels = space.select.label.all();
    const focused = list.contains(document.activeElement) ? document.activeElement.closest('[data-id]')?.dataset.id : null;
    list.replaceChildren(...labels.map(row));
    if (!labels.length) list.replaceChildren(el('li', {}, emptyState({ title: t('collections.labelsEmpty'), body: canEdit ? t('collections.labelsEmptyBody') : '', icon: 'pin' })));
    if (focused) list.querySelector(`[data-id="${focused}"] input`)?.focus({ preventScroll: true });
  }
  offs.push(space.subscribe('label', render));
  render();
  return openModal({ title: t('collections.labelsTitle'), content: el('div.col-labels', {}, el('h3.sr-only', { id: listId }, t('collections.labelsTitle')), add, alert, list),
    onClose: () => { for (const off of offs) off(); } });
}
