import { el, uid } from '../../../../ui/dom.js';
import { button, chip } from '../../../../ui/bits.js';
import { field, segmented } from '../../../../ui/fields.js';
import { t } from '../../../../lib/i18n/index.js';
import { BOOKING_TYPES, LEG_FIELDS, STATUSES, TRANSPORT_TYPES, emptyLeg, endpointKind, groupOf, isLodging, isTransport } from '../../../../lib/res/index.js';
import { legFieldLabel, statusLabel, typeLabel, whenText } from '../display.js';
import { endpointPicker, locationPicker, zoneField } from '../pickers.js';
import { icon } from './icons.js';

const BOOKING_LABELS = {
  lodging: ['bookings.checkInDate', null, 'bookings.checkOutDate', null],
  parking: ['bookings.dropoffDate', 'bookings.dropoffTime', 'bookings.collectDate', 'bookings.collectTime'],
  restaurant: ['bookings.date', 'bookings.time', null, 'bookings.endTime'],
};
const DEFAULT_LABELS = ['bookings.startDate', 'bookings.startTime', 'bookings.endDate', 'bookings.endTime'];
const WARNING_KEYS = new Set(['unknown_airport', 'arrival_next_day', 'ampm_fixed', 'duplicate_leg', 'legs_reordered', 'arrival_before_departure', 'departure_before_previous_arrival', 'end_before_start', 'outside_trip']);

function selectField({ label, value, options, onChange }) {
  const id = uid('bi-select');
  const select = el('select.select', { id, onchange: () => onChange(select.value) }, options.map((option) => (option.group
    ? el('optgroup', { label: option.group }, option.options.map((item) => el('option', { value: item.value }, item.label)))
    : el('option', { value: option.value }, option.label))));
  select.value = value ?? '';
  return { element: el('div.field', {}, el('label.field-label', { htmlFor: id }, label), select), select };
}

export function warningText(warning) {
  if (!WARNING_KEYS.has(warning.code)) return '';
  const leg = warning.leg !== undefined ? warning.leg + 1 : '';
  return t(`bookingImport.warning.${warning.code}`, { leg, value: warning.value ?? '' });
}

function issueText(issue) {
  if (issue.rule === 'date' || issue.path.endsWith('.date')) return t('bookingImport.issue.date');
  if (issue.rule === 'required') return t('bookingImport.issue.required');
  return t('bookingImport.issue.invalid');
}

/** Form state from a draft: bookings keep their single zone apart from the points. */
function stateOf(draft) {
  const state = structuredClone(draft);
  if (isTransport(state.type) && !state.legs?.length) state.legs = [emptyLeg()];
  if (!isTransport(state.type)) state.zone = state.start?.tz ?? state.end?.tz;
  return state;
}

/** Fields for `editCandidate` from form state. */
function fieldsOf(state) {
  const { zone, ...fields } = structuredClone(state);
  if (!isTransport(fields.type)) {
    for (const key of ['start', 'end']) {
      if (!fields[key]?.date) { delete fields[key]; continue; }
      if (zone) fields[key].tz = zone; else delete fields[key].tz;
      if (!fields[key].time) delete fields[key].time;
    }
  }
  return fields;
}

/**
 * One review card for an import candidate: a summary, warnings and duplicate notices, the action to take, and an
 * editor for the draft. `ctx` gives `services`, `datalist` (zone list id), `resTitle(id)`, `candidateTitle(id)`,
 * `onEdit(id, fields)`, `onAction(id, action)`, `onDiscard(id)` and `onSelect(id, selected)`.
 */
export function candidateCard(initial, ctx) {
  let candidate = initial;
  const state = stateOf(candidate.draft);
  const controls = new Map();
  const titleId = uid('bi-card-title');
  const selectBox = el('input', { type: 'checkbox', 'aria-label': t('bookingImport.selectCard', { name: candidate.draft.title }), onchange: () => ctx.onSelect(candidate.id, selectBox.checked) });
  const iconSlot = el('span.res-icon');
  const title = el('h4.bi-card-title', { id: titleId });
  const summary = el('p.res-meta');
  const actionChip = el('span.bi-card-chip');
  const notes = el('div.bi-card-notes');
  const actionSlot = el('div.bi-card-action');
  const discard = button(t('bookingImport.discard'), { size: 'sm', variant: 'ghost', icon: 'trash', onclick: () => ctx.onDiscard(candidate.id) });
  const editor = el('div.bi-editor');
  const details = el('details.bi-card-edit', {}, el('summary', {}, t('bookingImport.editDetails')), editor);
  const element = el('li.bi-card', { dataset: { id: candidate.id }, 'aria-labelledby': titleId },
    el('div.bi-card-head', {}, selectBox, iconSlot, el('div.bi-card-main', {}, title, summary), actionChip),
    notes, details, el('div.bi-card-foot', {}, actionSlot, discard));

  const emit = () => ctx.onEdit(candidate.id, fieldsOf(state));
  const register = (path, control) => { controls.set(path, control); return control; };

  // Editor

  function build() {
    controls.clear();
    const typeField = selectField({
      label: t('bookings.field.type'), value: state.type, onChange: (next) => { changeType(next); },
      options: [
        { group: t('bookings.groupTransport'), options: TRANSPORT_TYPES.map((value) => ({ value, label: typeLabel(value) })) },
        { group: t('bookings.groupBooking'), options: BOOKING_TYPES.map((value) => ({ value, label: typeLabel(value) })) },
      ],
    });
    const titleField = register('$.title', field({ label: t('bookings.field.title'), value: state.title ?? '', maxLength: 500, autocomplete: 'off' }));
    titleField.input.addEventListener('input', () => { state.title = titleField.input.value; emit(); });
    const statusField = selectField({ label: t('bookings.field.status'), value: state.status, options: STATUSES.map((value) => ({ value, label: statusLabel(value) })), onChange: (value) => { state.status = value; emit(); } });
    const codeField = register('$.code', field({ label: t('bookings.field.code'), value: state.code ?? '', maxLength: 500, autocomplete: 'off', spellcheck: false }));
    codeField.input.addEventListener('input', () => { state.code = codeField.input.value.trim() || undefined; emit(); });
    const notesField = register('$.notes', field({ label: t('bookings.notes'), type: 'textarea', rows: 3, value: state.notes ?? '', maxLength: 100_000 }));
    notesField.input.addEventListener('input', () => { state.notes = notesField.input.value; emit(); });
    editor.replaceChildren(
      el('div.bi-grid', {}, typeField.element, titleField.element, statusField.element, codeField.element),
      isTransport(state.type) ? legsEditor() : bookingEditor(),
      notesField.element,
    );
    paintIssues();
  }

  function changeType(next) {
    const wasTransport = isTransport(state.type);
    state.type = next;
    if (isTransport(next) && !wasTransport) {
      state.legs = [{ ...emptyLeg(), dep: { date: state.start?.date ?? '', time: state.start?.time }, arr: { date: state.end?.date ?? state.start?.date ?? '', time: state.end?.time } }];
      delete state.start; delete state.end; delete state.location; delete state.stay; delete state.zone;
    } else if (!isTransport(next) && wasTransport) {
      const first = state.legs?.[0];
      const last = state.legs?.at(-1);
      state.start = first?.dep?.date ? { date: first.dep.date, time: first.dep.time } : undefined;
      state.end = last?.arr?.date ? { date: last.arr.date, time: last.arr.time } : undefined;
      state.zone = first?.from?.tz;
      if (last?.to?.name) state.location = { name: last.to.name };
      delete state.legs;
    }
    emit();
    build();
    editor.querySelector('select')?.focus();
  }

  function legsEditor() {
    const wrap = el('fieldset.bi-legs', {}, el('legend.res-section-title', {}, t('bookings.route')));
    state.legs.forEach((leg, index) => wrap.append(legEditor(leg, index)));
    wrap.append(button(t('bookings.addLeg'), { icon: 'plus', size: 'sm', variant: 'outline', onclick: () => {
      state.legs.push(emptyLeg(state.legs.at(-1))); emit(); build();
      editor.querySelectorAll('.bi-leg').item(state.legs.length - 1)?.querySelector('input')?.focus();
    } }));
    return wrap;
  }

  function legEditor(leg, index) {
    const n = index + 1;
    const kind = endpointKind(state.type);
    leg.from ??= {}; leg.to ??= {}; leg.dep ??= { date: '' }; leg.arr ??= { date: '' };
    const pick = (side, label) => endpointPicker({ label, value: leg[side], kind, services: ctx.services, datalist: ctx.datalist, onChange: (end) => { leg[side] = end; emit(); } });
    const from = pick('from', t('bookings.from'));
    const to = pick('to', t('bookings.to'));
    const dateTime = (key, dateLabel, timeLabel) => {
      const date = register(`$.legs.${index}.${key}.date`, field({ label: t(dateLabel), type: 'date', value: leg[key].date ?? '' }));
      const time = register(`$.legs.${index}.${key}.time`, field({ label: t(timeLabel), type: 'time', value: leg[key].time ?? '' }));
      date.input.addEventListener('input', () => { leg[key] = { ...leg[key], date: date.input.value }; emit(); });
      time.input.addEventListener('input', () => { leg[key] = { ...leg[key], time: time.input.value || undefined }; emit(); });
      return el('div.res-time-pair', {}, date.element, time.element);
    };
    const extras = (LEG_FIELDS[state.type] ?? []).map((name) => {
      const input = field({ label: legFieldLabel(name, state.type), value: leg[name] ?? '', maxLength: 500, autocomplete: 'off' });
      input.input.addEventListener('input', () => { leg[name] = input.input.value.trim() || undefined; emit(); });
      return input.element;
    });
    const remove = state.legs.length > 1 ? el('button.icon-btn.icon-btn-sm', {
      type: 'button', title: t('bookings.removeLeg', { n }), 'aria-label': t('bookings.removeLeg', { n }),
      onclick: () => { state.legs.splice(index, 1); emit(); build(); editor.querySelector('.bi-leg input')?.focus(); },
    }, icon('trash', 16)) : null;
    return el('fieldset.bi-leg', {}, state.legs.length > 1 ? el('legend.res-leg-title', {}, t('bookings.legN', { n })) : null, remove,
      el('div.field-row.res-wrap', {}, from.element, to.element),
      el('div.field-row.res-wrap', {}, dateTime('dep', 'bookings.depDate', 'bookings.depTime'), dateTime('arr', 'bookings.arrDate', 'bookings.arrTime')),
      extras.length ? el('div.bi-grid', {}, extras) : null);
  }

  function bookingEditor() {
    const labels = BOOKING_LABELS[state.type] ?? DEFAULT_LABELS;
    const wrap = el('fieldset.bi-legs', {}, el('legend.res-section-title', {}, t('bookings.when')));
    const point = (key, dateLabel, timeLabel) => {
      const cells = [];
      if (dateLabel) {
        const date = register(`$.${key}.date`, field({ label: t(dateLabel), type: 'date', value: state[key]?.date ?? '' }));
        date.input.addEventListener('input', () => { state[key] = { ...(state[key] ?? {}), date: date.input.value }; emit(); });
        cells.push(date.element);
      }
      if (timeLabel) {
        const time = register(`$.${key}.time`, field({ label: t(timeLabel), type: 'time', value: state[key]?.time ?? '' }));
        time.input.addEventListener('input', () => {
          const date = state[key]?.date ?? (key === 'end' ? state.start?.date : '');
          state[key] = { ...(state[key] ?? {}), date, time: time.input.value || undefined };
          emit();
        });
        cells.push(time.element);
      }
      return cells.length ? el('div.res-time-pair', {}, cells) : null;
    };
    wrap.append(el('div.field-row.res-wrap', {}, point('start', labels[0], labels[1]), point('end', labels[2], labels[3])));
    if (isLodging(state.type)) {
      const stayTime = (key, label) => {
        const input = field({ label: t(label), type: 'time', value: state.stay?.[key] ?? '' });
        input.input.addEventListener('input', () => { state.stay = { ...(state.stay ?? {}), [key]: input.input.value || undefined }; emit(); });
        return input.element;
      };
      wrap.append(el('div.bi-grid', {}, stayTime('checkInFrom', 'bookings.checkInFrom'), stayTime('checkOut', 'bookings.checkOutBy')));
    }
    const zone = zoneField({ value: state.zone, datalist: ctx.datalist, onChange: (tz) => { state.zone = tz; emit(); } });
    const location = locationPicker({
      label: t('bookings.location'), value: state.location, services: ctx.services,
      onChange: ({ location: next, tz }) => {
        state.location = next ?? undefined;
        if (tz && !state.zone) { state.zone = tz; zone.set(tz); }
        emit();
      },
    });
    wrap.append(zone.element, location.element);
    return wrap;
  }

  // Status

  function paintIssues() {
    for (const control of controls.values()) control.setError?.('');
    const unplaced = [];
    for (const issue of candidate.issues ?? []) {
      const control = controls.get(issue.path) ?? controls.get(issue.path.replace(/\.(date|time)$/, '.date'));
      if (control) control.setError(issueText(issue)); else unplaced.push(issue);
    }
    return unplaced;
  }

  function actionControl() {
    const { duplicate, duplicateOf } = candidate;
    const items = duplicate
      ? [{ value: 'skip', label: t('bookingImport.action.skip') }, { value: 'create', label: t('bookingImport.action.createAnyway') }, { value: 'update', label: t('bookingImport.action.update') }]
      : duplicateOf
        ? [{ value: 'skip', label: t('bookingImport.action.skip') }, { value: 'create', label: t('bookingImport.action.createAnyway') }]
        : [{ value: 'create', label: t('bookingImport.action.create') }, { value: 'skip', label: t('bookingImport.action.skip') }];
    return segmented({ label: t('bookingImport.actionLabel', { name: candidate.draft.title }), radio: true, value: candidate.action, items, onChange: (value) => ctx.onAction(candidate.id, value) });
  }

  let actionKey = '';
  function paint() {
    const { draft } = candidate;
    iconSlot.className = `res-icon ${groupOf(draft.type)}`;
    iconSlot.replaceChildren(icon(draft.type, 20));
    iconSlot.title = typeLabel(draft.type);
    title.textContent = draft.title;
    selectBox.setAttribute('aria-label', t('bookingImport.selectCard', { name: draft.title }));
    summary.textContent = [typeLabel(draft.type), whenText(draft), draft.code].filter(Boolean).join(' · ');
    const blocked = candidate.issues?.length > 0;
    const status = blocked ? 'blocked' : candidate.action;
    actionChip.replaceChildren(chip(t(`bookingImport.state.${status}`), { status: { blocked: 'warn', create: 'success', update: 'accent', skip: '' }[status] ?? '' }));
    const unplaced = paintIssues();
    const lines = [];
    if (blocked) lines.push(el('p.bi-note.danger', { role: 'alert' }, t('bookingImport.fixFields'), unplaced.length ? ` ${unplaced.map(issueText).filter((text, i, all) => all.indexOf(text) === i).join(' ')}` : ''));
    if (candidate.duplicate) lines.push(el('p.bi-note.warn', {}, t(`bookingImport.duplicate.${candidate.duplicate.reason}`, { name: ctx.resTitle(candidate.duplicate.resId) })));
    else if (candidate.duplicateOf) lines.push(el('p.bi-note.warn', {}, t('bookingImport.duplicate.candidate', { name: ctx.candidateTitle(candidate.duplicateOf) })));
    for (const text of (candidate.warnings ?? []).map(warningText).filter(Boolean)) lines.push(el('p.bi-note', {}, text));
    notes.replaceChildren(...lines);
    notes.hidden = !lines.length;
    if (blocked) details.open = true;
    const key = JSON.stringify([candidate.action, Boolean(candidate.duplicate), Boolean(candidate.duplicateOf)]);
    if (key !== actionKey) {
      const hadFocus = actionSlot.contains(document.activeElement);
      actionKey = key;
      const control = actionControl();
      actionSlot.replaceChildren(el('span.field-label', { 'aria-hidden': 'true' }, t('bookingImport.actionShort')), control.element);
      if (hadFocus) control.element.querySelector('[aria-checked=true]')?.focus();
    }
  }

  build();
  paint();
  return {
    element,
    get id() { return candidate.id; },
    // The editor owns its state after the first render; updates only repaint the summary and notices.
    update(next) { candidate = next; paint(); },
    setSelected(on) { selectBox.checked = on; },
    focus() { title.tabIndex = -1; title.focus(); },
  };
}
