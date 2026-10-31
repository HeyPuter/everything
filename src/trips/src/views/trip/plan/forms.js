import { el, uid } from '../../../ui/dom.js';
import { button } from '../../../ui/bits.js';
import { field } from '../../../ui/fields.js';
import { openModal } from '../../../ui/modal.js';
import { t } from '../../../lib/i18n/index.js';
import { formatDate, formatMoney } from '../../../lib/format.js';
import { DAY_NOTE_ICONS } from '../../../shared/schema/trip.js';
import { icon, MODE_ICONS } from './icons.js';
import { callHook } from './hooks.js';

const MODES = Object.keys(MODE_ICONS);
const COLORS = [1, 2, 3, 4, 5, 6, 7, 8];

/** "Day 3 · Mon, 3 May" (or "Day 3 · Title" for undated days). */
export function dayLabel(entry) {
  const parts = [t('plan.dayNumber', { number: entry.number })];
  if (entry.date) parts.push(formatDate(entry.date, { weekday: true, year: false }));
  else if (entry.day.title) parts.push(entry.day.title);
  return parts.join(' · ');
}

/** A form in a dialog. `submit()` may throw to keep the dialog open; resolves `true` when saved. `bind(close)` gets the closer. */
function formDialog({ title, fields, submitLabel = t('ui.save'), danger = false, submit, wide = false, initialFocus, disabled = false, bind }) {
  return new Promise((resolve) => {
    let saved = false;
    const error = el('p.plan-form-error', { role: 'alert', hidden: true });
    const save = button(submitLabel, { type: 'submit', variant: danger ? 'danger' : 'primary', disabled });
    const form = el('form.plan-form', { noValidate: false }, ...fields, error,
      el('div.modal-actions', {}, button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }), save));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      save.setAttribute('aria-busy', 'true');
      try {
        await submit();
        saved = true;
        dialog.close('save');
      } catch {
        error.textContent = t('plan.saveFailed'); error.hidden = false;
      } finally { save.setAttribute('aria-busy', 'false'); }
    });
    const dialog = openModal({ title, content: form, wide, initialFocus, onClose: () => resolve(saved) });
    bind?.((reason) => dialog.close(reason));
  });
}

/** Radio buttons in a grid with roving focus; `items: [{value, label, content}]`. */
function radioGrid({ label, items, value, className = '' }) {
  let current = items.some((item) => item.value === value) ? value : items[0].value;
  const nodes = items.map((item) => el('button.plan-radio', {
    type: 'button', role: 'radio', title: item.label, 'aria-label': item.label, dataset: item.data ?? {},
    onclick: () => select(item.value, true),
  }, item.content));
  const element = el(`div.plan-radios${className ? `.${className}` : ''}`, { role: 'radiogroup', 'aria-label': label }, nodes);
  function select(next, focus = false) {
    current = next;
    nodes.forEach((node, index) => {
      const on = items[index].value === current;
      node.setAttribute('aria-checked', String(on)); node.tabIndex = on ? 0 : -1;
      if (on && focus) node.focus();
    });
  }
  element.addEventListener('keydown', (event) => {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
    const horizontal = event.key === 'ArrowRight' || event.key === 'ArrowLeft';
    const delta = horizontal && getComputedStyle(element).direction === 'rtl' ? -step : step;
    const index = (items.findIndex((item) => item.value === current) + delta + items.length) % items.length;
    select(items[index].value, true);
  });
  select(current);
  return { element: el('div.field', {}, el('span.field-label', {}, label), element), get value() { return current; } };
}

const colorItems = (auto) => [
  ...(auto ? [{ value: 0, label: t('plan.colorAuto'), content: el('span.plan-swatch.plan-swatch-auto', { dataset: { color: String(auto) } }) }] : [{ value: 0, label: t('plan.colorNone'), content: el('span.plan-swatch.plan-swatch-none') }]),
  ...COLORS.map((color) => ({ value: color, label: t('plan.colorN', { number: color }), content: el('span.plan-swatch', { dataset: { color: String(color) } }) })),
];
const modeOptions = (defaultLabel) => [{ value: '', label: defaultLabel }, ...MODES.map((mode) => ({ value: mode, label: t(`plan.mode.${mode}`) }))];

/** Collects `set`/`unset` for optional fields from `{key: [value, previous]}`; empty strings unset. */
function diff(entries) {
  const set = {}; const unset = [];
  for (const [key, [value, previous]] of Object.entries(entries)) {
    const empty = value === '' || value === null || value === undefined || (Array.isArray(value) && !value.length);
    if (empty) { if (previous !== undefined) unset.push(key); continue; }
    if (JSON.stringify(value) !== JSON.stringify(previous)) set[key] = value;
  }
  return { set, unset };
}

export function openDayForm({ entry, onSave }) {
  const { day } = entry;
  const title = field({ label: t('plan.dayTitle'), value: day.title ?? '', maxLength: 500 });
  const notes = field({ label: t('plan.dayNotes'), type: 'textarea', value: day.notes ?? '', rows: 4, hint: t('plan.markdownHint') });
  const mode = field({ label: t('plan.dayMode'), type: 'select', options: modeOptions(t('plan.modeNone')), value: day.mode ?? '' });
  const color = radioGrid({ label: t('plan.color'), items: colorItems(entry.color), value: day.color ?? 0 });
  return formDialog({
    title: t('plan.editDayTitle', { day: dayLabel(entry) }), fields: [title.element, notes.element, mode.element, color.element],
    submit: () => {
      const { set, unset } = diff({ title: [title.input.value.trim(), day.title], notes: [notes.input.value, day.notes], mode: [mode.input.value, day.mode], color: [color.value || '', day.color] });
      return Object.keys(set).length || unset.length ? onSave(set, unset) : undefined;
    },
  });
}

function peoplePicker(space, selected = []) {
  const people = [
    ...space.members().map((member) => ({ id: member.uid, name: member.name })),
    ...space.select.guest.all().map((guest) => ({ id: guest.id, name: guest.name })),
  ];
  const chosen = new Set(selected);
  const boxes = people.map((person) => {
    const input = el('input', { type: 'checkbox', checked: chosen.has(person.id), onchange: () => { if (input.checked) chosen.add(person.id); else chosen.delete(person.id); } });
    return el('label.check-field', {}, input, el('span', {}, person.name));
  });
  const element = el('fieldset.plan-people', {}, el('legend.field-label', {}, t('plan.people')),
    el('p.field-hint', {}, t('plan.peopleHint')), people.length ? boxes : el('p.field-hint', {}, t('plan.noPeople')));
  return { element, get value() { return people.map((person) => person.id).filter((id) => chosen.has(id)); } };
}

export function openVisitForm({ space, visit, entry, days, plan, onSave }) {
  const place = visit.placeId ? space.get('place', visit.placeId) : null;
  const nodes = [];
  let close = () => {};
  const title = place ? null : field({ label: t('plan.itemTitle'), value: visit.title ?? '', required: true, maxLength: 500 });
  if (place) {
    nodes.push(el('div.plan-form-place', {}, icon('map-pin', 16), el('span', {}, place.name),
      button(t('plan.openPlace'), { size: 'sm', variant: 'ghost', onclick: () => { close('place'); plan.emit('openPlace', { id: place.id }); } })));
  } else nodes.push(title.element);
  const start = field({ label: t('plan.start'), type: 'time', value: visit.start ?? '' });
  const end = field({ label: t('plan.end'), type: 'time', value: visit.end ?? '' });
  const later = days.filter((item) => item.index > entry.index);
  const endDay = field({ label: t('plan.endsOn'), type: 'select', value: visit.endDayId ?? '',
    options: [{ value: '', label: t('plan.sameDay') }, ...later.map((item) => ({ value: item.day.id, label: dayLabel(item) }))] });
  const warning = el('p.field-hint.plan-warning', { role: 'status' });
  const check = () => { warning.textContent = start.input.value && end.input.value && end.input.value < start.input.value && !endDay.input.value ? t('plan.endBeforeStart') : ''; };
  for (const input of [start.input, end.input, endDay.input]) input.addEventListener('input', check);
  check();
  const legMode = field({ label: t('plan.legMode'), type: 'select', options: modeOptions(t('plan.modeDefault')), value: visit.legMode ?? '' });
  const inMode = field({ label: t('plan.inMode'), type: 'select', options: modeOptions(t('plan.modeDefault')), value: visit.inMode ?? '' });
  const people = peoplePicker(space, visit.people);
  const notes = field({ label: t('plan.notes'), type: 'textarea', value: visit.notes ?? '', rows: 4, hint: t('plan.markdownHint') });
  const extra = callHook('visitFields', { visit, context: { space, plan } });
  return formDialog({
    title: place ? place.name : t('plan.editItem'), wide: true, bind: (closer) => { close = closer; },
    fields: [...nodes, el('div.field-row', {}, start.element, end.element), warning, endDay.element,
      el('div.field-row', {}, legMode.element, inMode.element), people.element, notes.element, ...(extra?.nodes ?? [])],
    submit: () => {
      const changes = diff({
        ...(title ? { title: [title.input.value.trim(), visit.title] } : {}),
        start: [start.input.value, visit.start], end: [end.input.value, visit.end], endDayId: [endDay.input.value, visit.endDayId],
        legMode: [legMode.input.value, visit.legMode], inMode: [inMode.input.value, visit.inMode], people: [people.value, visit.people], notes: [notes.input.value, visit.notes],
      });
      const hooked = extra?.read?.() ?? {};
      Object.assign(changes.set, hooked.set ?? {});
      changes.unset.push(...(hooked.unset ?? []));
      return Object.keys(changes.set).length || changes.unset.length ? onSave(changes.set, changes.unset) : undefined;
    },
  });
}

export function openItemForm({ entry, onSave }) {
  const title = field({ label: t('plan.itemTitle'), required: true, maxLength: 500 });
  const start = field({ label: t('plan.start'), type: 'time' });
  const end = field({ label: t('plan.end'), type: 'time' });
  const notes = field({ label: t('plan.notes'), type: 'textarea', rows: 3, hint: t('plan.markdownHint') });
  return formDialog({
    title: t('plan.addItemTitle', { day: dayLabel(entry) }), submitLabel: t('plan.add'), initialFocus: title.input,
    fields: [el('p.field-hint', {}, t('plan.itemHint')), title.element, el('div.field-row', {}, start.element, end.element), notes.element],
    submit: () => {
      const fields = { title: title.input.value.trim() };
      if (start.input.value) fields.start = start.input.value;
      if (end.input.value) fields.end = end.input.value;
      if (notes.input.value.trim()) fields.notes = notes.input.value;
      return onSave(fields);
    },
  });
}

export function openNoteForm({ entry, note = null, onSave }) {
  const title = field({ label: t('plan.noteTitle'), value: note?.title ?? '', required: true, maxLength: 500 });
  const time = field({ label: t('plan.time'), type: 'time', value: note?.time ?? '' });
  const iconGrid = radioGrid({ label: t('plan.icon'), className: 'plan-icons', value: note?.icon ?? 'sticky-note',
    items: DAY_NOTE_ICONS.map((name) => ({ value: name, label: t(`plan.icons.${name}`), content: icon(name, 18) })) });
  const color = radioGrid({ label: t('plan.color'), items: colorItems(0), value: note?.color ?? 0 });
  const text = field({ label: t('plan.noteText'), type: 'textarea', value: note?.text ?? '', rows: 4, hint: t('plan.markdownHint') });
  return formDialog({
    title: note ? t('plan.editNote') : t('plan.addNoteTitle', { day: dayLabel(entry) }), submitLabel: note ? t('ui.save') : t('plan.add'), wide: true, initialFocus: title.input,
    fields: [title.element, time.element, iconGrid.element, color.element, text.element],
    submit: () => {
      const values = { title: [title.input.value.trim(), note?.title], time: [time.input.value, note?.time], icon: [iconGrid.value, note?.icon], color: [color.value || '', note?.color], text: [text.input.value, note?.text] };
      if (!note) return onSave(Object.fromEntries(Object.entries(values).map(([key, [value]]) => [key, value]).filter(([, value]) => value !== '' && value !== 0)));
      const { set, unset } = diff(values);
      return Object.keys(set).length || unset.length ? onSave(set, unset) : undefined;
    },
  });
}

/** Resolves the chosen day id, or null. */
export function pickDay({ title, days, exclude = null }) {
  return new Promise((resolve) => {
    let chosen = null;
    const list = el('div.plan-pick', { role: 'list' }, days.filter((entry) => entry.day.id !== exclude).map((entry) => el('div', { role: 'listitem' },
      el('button.pick-item', { type: 'button', style: { '--day-color': `var(--day-${entry.color})` }, onclick: () => { chosen = entry.day.id; dialog.close('pick'); } },
        el('span.day-dot', { 'aria-hidden': 'true' }), el('span', {}, dayLabel(entry))))));
    const dialog = openModal({ title, content: days.length ? list : el('p', {}, t('plan.noDays')), onClose: () => resolve(chosen) });
  });
}

/** Multi-select of pool places; resolves the chosen ids in pool order. */
export function pickPlaces({ space, entry, days, onEmpty }) {
  return new Promise((resolve) => {
    const places = [...space.select.place.all()].sort((a, b) => a.name.localeCompare(b.name));
    const plannedOn = new Map();
    for (const item of days) for (const row of item.rows) if (row.kind === 'visit' && row.primary && row.entity.placeId) {
      if (!plannedOn.has(row.entity.placeId)) plannedOn.set(row.entity.placeId, []);
      plannedOn.get(row.entity.placeId).push(item.number);
    }
    const chosen = new Set();
    let result = [];
    const listId = uid('places');
    const search = field({ label: t('plan.searchPlaces'), type: 'search', prefix: 'search', autocomplete: 'off', 'aria-controls': listId });
    const list = el('div.plan-pick.plan-pick-places', { id: listId, role: 'group', 'aria-label': t('plan.pool') });
    const add = button(t('plan.addPlaces', { count: 0 }), { type: 'button', variant: 'primary', disabled: true, onclick: () => { result = places.filter((place) => chosen.has(place.id)).map((place) => place.id); dialog.close('add'); } });
    function render() {
      const query = search.input.value.trim().toLocaleLowerCase();
      const shown = places.filter((place) => !query || place.name.toLocaleLowerCase().includes(query) || (place.address ?? '').toLocaleLowerCase().includes(query));
      list.replaceChildren(...shown.map((place) => el('button.pick-item', {
        type: 'button', role: 'checkbox', 'aria-checked': chosen.has(place.id),
        onclick: (event) => { if (chosen.has(place.id)) chosen.delete(place.id); else chosen.add(place.id); event.currentTarget.setAttribute('aria-checked', String(chosen.has(place.id))); update(); },
      }, el('span.pick-check', { 'aria-hidden': 'true' }, icon('check', 14)), el('span.plan-pick-name', {}, place.name),
      plannedOn.has(place.id) && el('span.plan-pick-meta', {}, t('plan.onDays', { days: plannedOn.get(place.id).join(', ') })))));
      if (!shown.length) list.append(el('p.field-hint', {}, t('plan.noMatches')));
    }
    function update() { add.textContent = t('plan.addPlaces', { count: chosen.size }); add.disabled = chosen.size === 0; }
    search.input.addEventListener('input', render);
    render();
    const content = places.length ? el('div.plan-picker', {}, search.element, list)
      : el('div.plan-picker', {}, el('p', {}, t('plan.poolEmpty')), onEmpty && button(t('plan.openPlaces'), { onclick: () => { dialog.close('places'); onEmpty(); } }));
    const dialog = openModal({ title: t('plan.addPlacesTitle', { day: dayLabel(entry) }), content, wide: true, actions: places.length ? [button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }), add] : [],
      initialFocus: places.length ? search.input : undefined, onClose: () => resolve(result) });
  });
}

/** The impact of removing a day, then the removal. Resolves true when the user confirmed. */
export function openRemoveDay({ impact, entry, canRes, canCosts, onConfirm }) {
  const items = [];
  const line = (key, count, values = {}) => { if (count) items.push(el('li', {}, t(key, { count, ...values }))); };
  line('plan.impactVisits', impact.visits);
  line('plan.impactSpanning', impact.spanning);
  line('plan.impactNotes', impact.notes);
  line('plan.impactUnassigned', impact.unassigned);
  for (const res of impact.shortened) items.push(el('li', {}, t('plan.impactShortened', { name: res.title })));
  for (const res of impact.cancelled) items.push(el('li', {}, t('plan.impactCancelled', { name: res.title })));
  line('plan.impactShifted', impact.shifted);
  if (impact.end) items.push(el('li', {}, t('plan.impactEnd', { date: formatDate(impact.end) })));
  const boxes = impact.expenses.map((exp) => {
    const input = el('input', { type: 'checkbox', value: exp.id, disabled: !canCosts });
    return { input, node: el('label.check-field', {}, input, el('span', {}, `${exp.name} · ${formatMoney(exp.amount, exp.currency)}`)) };
  });
  const blocked = impact.tooLarge ? t('plan.dayTooLarge') : impact.needs.res && !canRes ? t('plan.removeNeedsRes') : '';
  const fields = [
    el('p', {}, items.length ? t('plan.removeIntro') : t('plan.removeEmpty')),
    items.length && el('ul.plan-impact', {}, items),
    boxes.length && el('fieldset.plan-impact-exps', {}, el('legend.field-label', {}, t('plan.impactExpenses')), el('p.field-hint', {}, t('plan.impactExpensesHint')), boxes.map((box) => box.node)),
    el('p.field-hint', {}, t('plan.removeNoUndo')),
    blocked && el('p.plan-form-error', { role: 'alert' }, blocked),
  ].filter(Boolean);
  return formDialog({
    title: t('plan.removeDayTitle', { day: dayLabel(entry) }), submitLabel: t('plan.removeDay'), danger: true, fields, disabled: Boolean(blocked),
    submit: () => onConfirm(boxes.filter((box) => box.input.checked).map((box) => box.input.value)),
  });
}
