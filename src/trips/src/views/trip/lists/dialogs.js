import { el, uid as nextUid } from '../../../ui/dom.js';
import { button } from '../../../ui/bits.js';
import { field, choiceGroup } from '../../../ui/fields.js';
import { openModal } from '../../../ui/modal.js';
import { t } from '../../../lib/i18n/index.js';
import { parseWeight, unitLabel, weightValue } from '../../../lib/format.js';
import { prefs } from '../../../lib/prefs.js';
import { cleanName, COLORS } from './model.js';
import { colorDot, colorName } from './common.js';

const weightUnit = () => (prefs().weightUnit === 'lb' ? 'lb' : 'kg');

/** Checkboxes for members and guests; `value()` returns the checked ids in display order. */
export function peoplePicker({ legend, people, selected = [], hint }) {
  const chosen = new Set(selected);
  const boxes = [];
  const options = [...people.values()].filter((person) => person.kind !== 'unknown');
  for (const id of selected) if (!people.has(id)) options.push({ id, name: t('lists.unknownPerson'), kind: 'unknown' });
  const node = el('fieldset.lists-people', {}, el('legend.field-label', {}, legend),
    hint && el('p.field-hint', {}, hint),
    options.length ? options.map((person) => {
      const input = el('input', { type: 'checkbox', checked: chosen.has(person.id), value: person.id });
      boxes.push(input);
      return el('label.check-field', {}, input, el('span', {}, person.name, person.kind === 'guest' && el('span.lists-muted', {}, ` · ${t('lists.guest')}`)));
    }) : el('p.field-hint', {}, t('lists.nobody')));
  return { node, value: () => boxes.filter((box) => box.checked).map((box) => box.value) };
}

function alertNode() {
  const node = el('p.lists-alert', { role: 'alert', hidden: true });
  return { node, show(text) { node.textContent = text; node.hidden = false; }, clear() { node.hidden = true; node.textContent = ''; } };
}

/** Submit runs `save(values)`; the dialog closes when it resolves truthy and stays open (re-enabled) otherwise. */
function formDialog({ title, content, submitLabel, onSubmit, initialFocus, wide = false }) {
  const alert = alertNode();
  const submit = button(submitLabel, { type: 'submit', variant: 'primary' });
  let dialog;
  const form = el('form.lists-form', { noValidate: true, onsubmit: async (event) => {
    event.preventDefault();
    alert.clear();
    submit.setAttribute('aria-busy', 'true');
    try { if (await onSubmit(alert)) dialog.close('saved'); } finally { submit.setAttribute('aria-busy', 'false'); }
  } }, alert.node, content, el('div.modal-actions', {}, button(t('lists.cancel'), { onclick: () => dialog.close('cancel') }), submit));
  dialog = openModal({ title, content: form, wide, dismissOnBackdrop: false, initialFocus });
  dialog.alert = alert;
  return dialog;
}

/** Edit a packing item: name, quantity, list, weight, bag, and who sees it. */
export function openItemDialog({ item, lists, bags, people, canEdit, canPrivate, onSave }) {
  const unit = weightUnit();
  const name = field({ label: t('lists.itemName'), value: item.name, maxLength: 500, required: true, autocomplete: 'off' });
  const qty = field({ label: t('lists.quantity'), type: 'number', value: String(item.qty ?? 1), min: 1, max: 999999, step: 1, inputMode: 'numeric' });
  const listId = nextUid('lists-names');
  const list = field({ label: t('lists.list'), value: item.list ?? '', maxLength: 500, list: listId, autocomplete: 'off' });
  const datalist = el('datalist', { id: listId }, lists.map((value) => el('option', { value })));
  const weight = field({ label: t('lists.weightEach', { unit: unitLabel(unit) }), type: 'number', min: 0, step: 'any', inputMode: 'decimal',
    value: item.grams > 0 ? String(weightValue(item.grams, { unit })) : '' });
  const initialWeight = weight.input.value;
  const bag = bags ? field({ label: t('lists.bag'), type: 'select', value: item.bagId && bags.some((entry) => entry.id === item.bagId) ? item.bagId : '',
    options: [{ value: '', label: t('lists.noBag') }, ...bags.map((entry) => ({ value: entry.id, label: entry.name }))] }) : null;
  const visibilities = [
    canEdit && { value: 'shared', label: t('lists.visShared'), hint: t('lists.visSharedHint') },
    canEdit && { value: 'people', label: t('lists.visPeople'), hint: t('lists.visPeopleHint') },
    canPrivate && { value: 'private', label: t('lists.visPrivate'), hint: t('lists.visPrivateHint') },
  ].filter(Boolean);
  const current = item.private ? 'private' : item.vis === 'people' ? 'people' : 'shared';
  let vis = visibilities.some((entry) => entry.value === current) ? current : visibilities[0]?.value ?? current;
  const picker = peoplePicker({ legend: t('lists.visPeopleWho'), people, selected: item.for ?? [] });
  const syncPicker = () => { picker.node.hidden = vis !== 'people'; };
  const visControl = visibilities.length > 1 ? choiceGroup({ label: t('lists.visibility'), value: vis, items: visibilities, onChange: (value) => { vis = value; syncPicker(); } }) : null;
  syncPicker();
  const content = el('div.lists-form-body', {}, name.element, el('div.field-row', {}, qty.element, weight.element), list.element, datalist, bag?.element,
    visControl && el('div.field', {}, el('span.field-label', {}, t('lists.visibility')), visControl.element), picker.node);
  return formDialog({ title: t('lists.editItem'), content, submitLabel: t('lists.save'), initialFocus: name.input, onSubmit: async (alert) => {
    name.setError(''); qty.setError(''); weight.setError('');
    const value = cleanName(name.input.value);
    if (!value) { name.setError(t('lists.nameRequired')); name.input.focus(); return false; }
    const count = Number(qty.input.value || 1);
    if (!Number.isInteger(count) || count < 1 || count > 999999) { qty.setError(t('lists.quantityInvalid')); qty.input.focus(); return false; }
    // An untouched field keeps the stored grams; the unit round trip would otherwise drift them.
    const grams = weight.input.value === initialWeight ? item.grams ?? 0 : weight.input.value.trim() ? parseWeight(weight.input.value, { unit }) : 0;
    if (grams === null || grams > 1_000_000_000) { weight.setError(t('lists.weightInvalid')); weight.input.focus(); return false; }
    const chosen = picker.value();
    if (vis === 'people' && !chosen.length) { alert.show(t('lists.visPeopleRequired')); return false; }
    return onSave({ name: value, qty: count, list: cleanName(list.input.value), grams, bagId: bag ? bag.input.value || null : item.bagId ?? null, vis, for: chosen });
  } });
}

/** Add or edit a bag: name, weight limit, color and the people sharing it. */
export function openBagDialog({ bag, people, onSave }) {
  const unit = weightUnit();
  const name = field({ label: t('lists.bagName'), value: bag?.name ?? '', maxLength: 500, required: true, autocomplete: 'off' });
  const limit = field({ label: t('lists.bagLimit', { unit: unitLabel(unit) }), type: 'number', min: 0, step: 'any', inputMode: 'decimal', hint: t('lists.bagLimitHint'),
    value: bag?.limitGrams > 0 ? String(weightValue(bag.limitGrams, { unit })) : '' });
  const initialLimit = limit.input.value;
  let color = Number.isInteger(bag?.color) ? bag.color : null;
  const colors = choiceGroup({ label: t('lists.color'), value: color ?? 0, onChange: (value) => { color = value || null; },
    items: [{ value: 0, label: t('lists.colorAuto') }, ...COLORS.map((value) => ({ value, label: colorName(value) }))] });
  [...colors.element.children].slice(1).forEach((node, index) => node.prepend(colorDot(COLORS[index])));
  colors.element.classList.add('lists-colors');
  const picker = peoplePicker({ legend: t('lists.bagPeople'), people, selected: bag?.people ?? [] });
  const content = el('div.lists-form-body', {}, name.element, limit.element,
    el('div.field', {}, el('span.field-label', {}, t('lists.color')), colors.element), picker.node);
  return formDialog({ title: t(bag ? 'lists.editBag' : 'lists.addBag'), content, submitLabel: t(bag ? 'lists.save' : 'lists.add'), initialFocus: name.input, onSubmit: async () => {
    name.setError(''); limit.setError('');
    const value = cleanName(name.input.value);
    if (!value) { name.setError(t('lists.nameRequired')); name.input.focus(); return false; }
    const grams = limit.input.value === initialLimit ? bag?.limitGrams ?? 0 : limit.input.value.trim() ? parseWeight(limit.input.value, { unit }) : 0;
    if (grams === null || grams > 1_000_000_000) { limit.setError(t('lists.weightInvalid')); limit.input.focus(); return false; }
    return onSave({ name: value, limitGrams: grams > 0 ? grams : undefined, color: color ?? bag?.color ?? undefined, people: picker.value() });
  } });
}

/** Pick the members responsible for a list. */
export function openAssigneesDialog({ title, people, selected, onSave }) {
  const members = new Map([...people].filter(([, person]) => person.kind === 'member'));
  const picker = peoplePicker({ legend: t('lists.assignees'), people: members, selected, hint: t('lists.assigneesHint') });
  return formDialog({ title, content: picker.node, submitLabel: t('lists.save'), onSubmit: () => onSave(picker.value()) });
}

export { formDialog, alertNode };
