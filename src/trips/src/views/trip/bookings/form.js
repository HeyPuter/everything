import { el, uid, safeURL, append, clear } from '../../../ui/dom.js';
import { button } from '../../../ui/bits.js';
import { checkbox, field, segmented } from '../../../ui/fields.js';
import { confirmDialog, openModal } from '../../../ui/modal.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { formatDate } from '../../../lib/format.js';
import { DomainError } from '../../../shared/errors.js';
import { isDate } from '../../../shared/dates.js';
import { distanceMeters } from '../../../shared/geo.js';
import {
  BOOKING_TYPES, LEG_FIELDS, STATUSES, TRANSPORT_TYPES, attachedFiles, dayForDate, emptyLeg, endpointKind, fileLinkChanges, isLodging,
  isTransport, legDayOffset, legIssues, normalizeRes, orderAfter, rangeIssue, resIssues, resPatch, suggestTitle,
} from '../../../lib/res/index.js';
import { openFilePicker } from '../../../lib/files/ui.js';
import { icon } from './icons.js';
import { endpointText, legDurationText, legFieldLabel, personName, statusLabel, typeLabel } from './display.js';
import { endpointPicker, locationPicker, servicesFor, zoneDatalist, zoneField } from './pickers.js';

const STAMPS = ['id', 'v', 'rev', 'upd', 'by', 'cr', 't', 'deleted'];
const strip = (entity) => Object.fromEntries(Object.entries(entity).filter(([key]) => !STAMPS.includes(key)));
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const LABELS = {
  lodging: ['bookings.checkInDate', null, 'bookings.checkOutDate', null],
  parking: ['bookings.dropoffDate', 'bookings.dropoffTime', 'bookings.collectDate', 'bookings.collectTime'],
  restaurant: ['bookings.date', 'bookings.time', null, 'bookings.endTime'],
};
const DEFAULT_LABELS = ['bookings.startDate', 'bookings.startTime', 'bookings.endDate', 'bookings.endTime'];
const ISSUE_TEXT = { arrival_before_departure: 'bookings.arrivalBeforeDeparture', departure_before_previous_arrival: 'bookings.departureBeforePrevious' };

function toolButton(name, label, onclick, disabled = false) {
  return el('button.icon-btn.icon-btn-sm', { type: 'button', title: label, 'aria-label': label, disabled, onclick }, icon(name, 16));
}
function selectField({ label, value = '', options, onChange, hint }) {
  const id = uid('res-select');
  const select = el('select.select', { id, onchange: () => onChange(select.value) }, options.map((option) => (option.group
    ? el('optgroup', { label: option.group }, option.options.map((item) => el('option', { value: item.value }, item.label)))
    : el('option', { value: option.value }, option.label))));
  select.value = value ?? '';
  return { element: el('div.field', {}, el('label.field-label', { htmlFor: id }, label), select, hint && el('span.field-hint', {}, hint)), select };
}
const osmKey = (osm) => (osm?.type && osm?.id ? `${osm.type}/${osm.id}` : null);

/**
 * Create or edit a reservation. `res` edits an entity; otherwise `draft` (from duplicate or return trip) or a blank
 * reservation of `type` is created. Returns the dialog handle.
 */
export function openEditor({ space, session, res = null, draft = null, type = 'flight', onClose }) {
  const services = servicesFor(session);
  const zones = zoneDatalist();
  const existing = res;
  const openBase = existing ? space.store?.serverVersion?.('res', existing.id) : undefined;
  const before = existing ? strip(existing) : null;
  const state = structuredClone(before ?? { type, status: 'pending', ...(draft ?? {}) });
  if (isTransport(state.type) && !state.legs?.length) state.legs = [emptyLeg()];
  const list = (name) => space.select[name]?.all() ?? [];
  const days = list('day');
  const undated = days.some((day) => !isDate(day.date));
  const canPlaces = space.can('plan.edit');
  const canFiles = space.can('files.edit');
  let wanted = new Set(existing ? attachedFiles(list('file'), existing.id).map((file) => file.id) : []);
  let picked = null;
  let dirty = false;
  let gone = false;
  let legViews = [];
  let refreshWhen = () => {};
  const touch = () => { dirty = true; };

  const alert = el('div.res-alert', { role: 'alert', hidden: true });
  const showAlert = (message = '') => { alert.textContent = message; alert.hidden = !message; };

  const typeField = selectField({
    label: t('bookings.field.type'), value: state.type, onChange: (next) => changeType(next),
    options: [
      { group: t('bookings.groupTransport'), options: TRANSPORT_TYPES.map((value) => ({ value, label: typeLabel(value) })) },
      { group: t('bookings.groupBooking'), options: BOOKING_TYPES.map((value) => ({ value, label: typeLabel(value) })) },
    ],
  });
  const title = field({ label: t('bookings.field.title'), value: state.title ?? '', maxLength: 500, hint: ' ', autocomplete: 'off' });
  const titleHint = title.element.querySelector('.field-hint');
  const refreshTitleHint = () => {
    const suggestion = suggestTitle(state) || typeLabel(state.type);
    titleHint.textContent = t('bookings.titleHint', { suggestion });
    title.input.placeholder = suggestion;
  };
  title.input.addEventListener('input', () => { state.title = title.input.value; touch(); });
  const status = segmented({
    label: t('bookings.field.status'), radio: true, value: state.status ?? 'pending',
    items: STATUSES.map((value) => ({ value, label: statusLabel(value) })), onChange: (value) => { state.status = value; touch(); },
  });
  const code = field({ label: t('bookings.field.code'), value: state.code ?? '', maxLength: 500, autocomplete: 'off', spellcheck: false });
  code.input.addEventListener('input', () => { state.code = code.input.value; touch(); });
  const review = state.review ? checkbox(t('bookings.reviewFlag'), { checked: true, onChange: (checked) => { state.review = checked || undefined; touch(); } }) : null;

  const dynamic = el('div.res-dynamic');
  function rebuild() {
    dynamic.replaceChildren(isTransport(state.type) ? legsSection() : bookingSection());
    refreshTitleHint();
  }

  function changeType(next) {
    const wasTransport = isTransport(state.type);
    state.type = next;
    if (isTransport(next) && !wasTransport) {
      state.legs = [{ ...emptyLeg(), dep: { date: state.start?.date ?? '', time: state.start?.time ?? '' }, arr: { date: state.end?.date ?? state.start?.date ?? '', time: state.end?.time ?? '' } }];
    } else if (!isTransport(next) && wasTransport) {
      const first = state.legs?.[0];
      const last = state.legs?.at(-1);
      state.start = first?.dep?.date ? { date: first.dep.date, time: first.dep.time, tz: first.from?.tz } : undefined;
      state.end = last?.arr?.date ? { date: last.arr.date, time: last.arr.time, tz: last.to?.tz } : undefined;
      if (last?.to?.name) state.location = { name: last.to.name, ...(Number.isFinite(last.to.lat) ? { lat: last.to.lat, lng: last.to.lng } : {}) };
    }
    touch();
    rebuild();
  }

  // Transport: ordered legs, each with local times in its endpoints' zones.
  function legsSection() {
    legViews = [];
    refreshWhen = () => {};
    const section = el('fieldset.res-section', {}, el('legend.res-section-title', {}, t('bookings.route')));
    const legs = el('div.res-legs');
    state.legs.forEach((leg, index) => { const view = legEditor(leg, index); legViews.push(view); legs.append(view.element); });
    const add = button(t(state.type === 'car' ? 'bookings.addStop' : 'bookings.addLeg'), {
      icon: 'plus', variant: 'outline', size: 'sm',
      onclick: () => { state.legs.push(emptyLeg(state.legs.at(-1))); touch(); rebuild(); legViews.at(-1)?.focus(); },
    });
    section.append(legs, el('div.res-row-actions', {}, add));
    refreshLegIssues();
    return section;
  }
  function refreshLegIssues() {
    const issues = legIssues(state.legs);
    legViews.forEach((view, index) => view.setIssue(issues.find((issue) => issue.leg === index)?.code));
  }
  function moveLeg(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= state.legs.length) return;
    [state.legs[index], state.legs[target]] = [state.legs[target], state.legs[index]];
    touch(); rebuild();
    legViews[target]?.focusTool(delta < 0 ? 'up' : 'down');
  }
  function legEditor(leg, index) {
    const n = index + 1;
    const many = state.legs.length > 1;
    const car = state.type === 'car' && !many;
    const kind = endpointKind(state.type);
    leg.from ??= {}; leg.to ??= {}; leg.dep ??= { date: '' }; leg.arr ??= { date: '' };
    const info = el('p.res-leg-info', { 'aria-live': 'polite' });
    const issue = el('p.field-error', { hidden: true, 'aria-live': 'polite' });
    const refresh = () => {
      const offset = legDayOffset(leg);
      const duration = legDurationText(leg);
      info.textContent = [duration && t('bookings.duration', { duration }),
        offset === 1 ? t('bookings.arrivesNextDay') : offset > 1 ? t('bookings.arrivesLater', { count: offset }) : offset < 0 ? t('bookings.arrivesEarlier') : ''].filter(Boolean).join(' · ');
      depHint.textContent = t('bookings.localTimeAt', { place: endpointText(leg.from) });
      arrHint.textContent = t('bookings.localTimeAt', { place: endpointText(leg.to) });
      refreshLegIssues();
    };
    const from = endpointPicker({ label: t(car ? 'bookings.pickupPlace' : 'bookings.from'), value: leg.from, kind, services, datalist: zones.id,
      onChange: (end) => { leg.from = end; touch(); refresh(); refreshTitleHint(); } });
    const to = endpointPicker({ label: t(car ? 'bookings.returnPlace' : 'bookings.to'), value: leg.to, kind, services, datalist: zones.id,
      onChange: (end) => { leg.to = end; touch(); refresh(); refreshTitleHint(); } });
    const depDate = field({ label: t(car ? 'bookings.pickupDate' : 'bookings.depDate'), type: 'date', value: leg.dep.date ?? '', required: true });
    const depTime = field({ label: t(car ? 'bookings.pickupTime' : 'bookings.depTime'), type: 'time', value: leg.dep.time ?? '' });
    const arrDate = field({ label: t(car ? 'bookings.returnDate' : 'bookings.arrDate'), type: 'date', value: leg.arr.date ?? '' });
    const arrTime = field({ label: t(car ? 'bookings.returnTime' : 'bookings.arrTime'), type: 'time', value: leg.arr.time ?? '' });
    const depHint = el('span.field-hint');
    const arrHint = el('span.field-hint');
    depDate.input.addEventListener('input', () => {
      const previous = leg.dep.date;
      leg.dep = { ...leg.dep, date: depDate.input.value };
      // The arrival date follows the departure date until the user sets it apart.
      if (!arrDate.input.value || arrDate.input.value === previous) { arrDate.input.value = depDate.input.value; leg.arr = { ...leg.arr, date: depDate.input.value }; }
      depDate.setError(''); touch(); refresh();
    });
    depTime.input.addEventListener('input', () => { leg.dep = { ...leg.dep, time: depTime.input.value }; touch(); refresh(); });
    arrDate.input.addEventListener('input', () => { leg.arr = { ...leg.arr, date: arrDate.input.value }; touch(); refresh(); });
    arrTime.input.addEventListener('input', () => { leg.arr = { ...leg.arr, time: arrTime.input.value }; touch(); refresh(); });
    const extras = (LEG_FIELDS[state.type] ?? []).map((name) => {
      const input = field({ label: legFieldLabel(name, state.type), value: leg[name] ?? '', maxLength: 500, autocomplete: 'off' });
      input.input.addEventListener('input', () => { leg[name] = input.input.value; touch(); if (name === 'carrier' || name === 'number') refreshTitleHint(); });
      return input.element;
    });
    const tools = many ? el('div.res-leg-tools', {},
      toolButton('up', t('bookings.moveLegUp', { n }), () => moveLeg(index, -1), index === 0),
      toolButton('down', t('bookings.moveLegDown', { n }), () => moveLeg(index, 1), index === state.legs.length - 1),
      toolButton('trash', t('bookings.removeLeg', { n }), () => {
        state.legs.splice(index, 1); touch(); rebuild();
        legViews[Math.min(index, legViews.length - 1)]?.focus();
      })) : null;
    const element = el('fieldset.res-leg', {}, many && el('legend.res-leg-title', {}, t('bookings.legN', { n })), tools,
      el('div.field-row.res-wrap', {}, from.element, to.element),
      el('div.field-row.res-wrap', {}, el('div.res-time-pair', {}, depDate.element, depTime.element, depHint), el('div.res-time-pair', {}, arrDate.element, arrTime.element, arrHint)),
      info, issue, extras.length ? el('div.res-grid', {}, extras) : null);
    refresh();
    return {
      element,
      focus: () => from.input.focus(),
      focusTool: (name) => element.querySelectorAll('.res-leg-tools button')[name === 'up' ? 0 : 1]?.focus(),
      setIssue: (key) => { issue.textContent = key ? t(ISSUE_TEXT[key]) : ''; issue.hidden = !key; },
      depDate,
    };
  }

  /** Booking start and end with the booking's zone; a missing end date means the start date. */
  function zonedRange() {
    const zoned = (point) => (point ? { ...point, tz: state.zone } : undefined);
    const start = zoned(state.start);
    // Types without an end date field (restaurant) end on their start date.
    const endDate = (LABELS[state.type] ?? DEFAULT_LABELS)[2] ? state.end?.date || state.start?.date : state.start?.date;
    const end = state.end && endDate ? zoned({ ...state.end, date: endDate }) : undefined;
    if (start && !state.zone) delete start.tz;
    if (end && !state.zone) delete end.tz;
    return { start, end };
  }

  // Bookings: when and where, with stay details for lodging.
  function bookingSection() {
    const kind = state.type;
    const lodging = isLodging(kind);
    const labels = LABELS[kind] ?? DEFAULT_LABELS;
    const when = el('fieldset.res-section', {}, el('legend.res-section-title', {}, t('bookings.when')));
    const rangeError = el('p.field-error', { hidden: true, 'aria-live': 'polite' });
    const outside = el('p.field-hint', { hidden: true });
    let endDateField = null;
    let zone;
    let manualZone = false;
    const setPoint = (key, patch) => {
      const next = { ...(state[key] ?? {}), ...patch };
      state[key] = next.date || next.time ? next : undefined;
      touch(); refreshWhen();
    };
    refreshWhen = () => {
      const { start, end } = zonedRange();
      const issue = rangeIssue(start, end);
      rangeError.textContent = issue ? t(lodging ? 'bookings.checkOutBeforeIn' : 'bookings.endBeforeStart') : '';
      rangeError.hidden = !issue;
      endDateField?.setError('');
      const dated = days.filter((day) => isDate(day.date));
      outside.hidden = !(state.start?.date && dated.length && !dayForDate(days, state.start.date));
      outside.textContent = outside.hidden ? '' : t('bookings.outsideTrip');
    };
    if (lodging && undated) {
      const dayOptions = [{ value: '', label: t('bookings.noDay') }, ...days.map((day, index) => ({ value: day.id, label: dayName(day, index) }))];
      const fromDay = selectField({ label: t('bookings.checkInDay'), value: state.stay?.fromDayId ?? '', options: dayOptions,
        onChange: (value) => { state.stay = { ...state.stay, fromDayId: value || undefined }; touch(); } });
      const toDay = selectField({ label: t('bookings.checkOutDay'), value: state.stay?.toDayId ?? '', options: dayOptions,
        onChange: (value) => { state.stay = { ...state.stay, toDayId: value || undefined }; touch(); } });
      when.append(el('div.field-row.res-wrap', {}, fromDay.element, toDay.element));
    } else {
      const startDate = field({ label: t(labels[0]), type: 'date', value: state.start?.date ?? '' });
      startDate.input.addEventListener('input', () => setPoint('start', { date: startDate.input.value }));
      const startCells = [startDate.element];
      if (labels[1]) {
        const startTime = field({ label: t(labels[1]), type: 'time', value: state.start?.time ?? '' });
        startTime.input.addEventListener('input', () => setPoint('start', { time: startTime.input.value }));
        startCells.push(startTime.element);
      }
      const endCells = [];
      if (labels[2]) {
        endDateField = field({ label: t(labels[2]), type: 'date', value: state.end?.date ?? '' });
        endDateField.input.addEventListener('input', () => setPoint('end', { date: endDateField.input.value }));
        endCells.push(endDateField.element);
      }
      if (labels[3]) {
        const endTime = field({ label: t(labels[3]), type: 'time', value: state.end?.time ?? '' });
        endTime.input.addEventListener('input', () => setPoint('end', { time: endTime.input.value }));
        endCells.push(endTime.element);
      }
      when.append(el('div.field-row.res-wrap', {}, el('div.res-time-pair', {}, startCells), endCells.length ? el('div.res-time-pair', {}, endCells) : null));
    }
    if (lodging) {
      const stayTime = (key, label) => {
        const input = field({ label: t(label), type: 'time', value: state.stay?.[key] ?? '' });
        input.input.addEventListener('input', () => { state.stay = { ...state.stay, [key]: input.input.value || undefined }; touch(); });
        return input.element;
      };
      when.append(el('div.res-grid', {}, stayTime('checkInFrom', 'bookings.checkInFrom'), stayTime('checkInUntil', 'bookings.checkInUntil'), stayTime('checkOut', 'bookings.checkOutBy')));
    }
    state.zone ??= state.start?.tz ?? state.end?.tz;
    zone = zoneField({ value: state.zone, datalist: zones.id, onChange: (tz) => { manualZone = true; setZone(tz); } });
    function setZone(tz) { state.zone = tz; touch(); refreshWhen(); }
    // A picked location sets the zone unless the user chose one by hand.
    const zoneFrom = (tz) => { if (tz && !manualZone && tz !== state.zone) { zone.set(tz); setZone(tz); } };
    when.append(zone.element, rangeError, outside);
    if (!lodging && undated) {
      const current = Object.keys(state.dayPos ?? {}).find((id) => days.some((day) => day.id === id && !isDate(day.date))) ?? '';
      const day = selectField({
        label: t('bookings.day'), value: current,
        options: [{ value: '', label: t('bookings.noDay') }, ...days.map((item, index) => ({ value: item.id, label: dayName(item, index) })).filter((item) => !isDate(days.find((d) => d.id === item.value)?.date))],
        onChange: (value) => assignDay(value),
      });
      when.append(day.element);
    }

    const where = el('fieldset.res-section', {}, el('legend.res-section-title', {}, t('bookings.location')));
    const places = [...list('place')].sort((a, b) => a.name.localeCompare(b.name));
    let placeField = null;
    const location = locationPicker({
      label: t('bookings.location'), value: state.location, services,
      hint: lodging && canPlaces ? t('bookings.placeHint') : undefined,
      onChange: ({ location: next, picked: item, tz }) => {
        state.location = next ?? undefined;
        picked = item ? { location: next, item } : null;
        if (item && state.placeId) { state.placeId = undefined; if (placeField) placeField.select.value = ''; }
        zoneFrom(tz);
        touch(); refreshTitleHint();
      },
    });
    where.append(location.element);
    if (places.length) {
      placeField = selectField({
        label: t('bookings.place'), value: state.placeId ?? '',
        options: [{ value: '', label: t('bookings.noPlace') }, ...places.map((place) => ({ value: place.id, label: place.name }))],
        onChange: (value) => {
          state.placeId = value || undefined;
          const place = places.find((item) => item.id === value);
          if (place) {
            picked = null;
            state.location = { name: place.name, ...(place.address ? { address: place.address } : {}), ...(Number.isFinite(place.lat) ? { lat: place.lat, lng: place.lng } : {}) };
            location.setText(place.name);
            zoneFrom(place.tz);
          }
          touch(); refreshTitleHint();
        },
      });
      where.append(placeField.element);
    }
    const stays = list('res').filter((item) => isLodging(item.type) && item.id !== existing?.id);
    if (!lodging && stays.length) {
      where.append(selectField({
        label: t('bookings.stayLink'), value: state.stayId ?? '',
        options: [{ value: '', label: t('bookings.none') }, ...stays.map((item) => ({ value: item.id, label: item.title }))],
        onChange: (value) => { state.stayId = value || undefined; touch(); },
      }).element);
    }
    refreshWhen();
    return el('div.res-sections', {}, when, where);
  }

  function dayName(day, index) {
    return isDate(day.date) ? formatDate(day.date, { weekday: true, year: false }) : t('bookings.dayN', { n: index + 1 });
  }
  function assignDay(dayId) {
    const kept = Object.fromEntries(Object.entries(state.dayPos ?? {}).filter(([id]) => isDate(days.find((day) => day.id === id)?.date)));
    if (dayId) {
      const keys = [
        ...(space.select.visit?.groupBy('dayId').get(dayId) ?? []).map((item) => item.order),
        ...(space.select.dayNote?.groupBy('dayId').get(dayId) ?? []).map((item) => item.order),
        ...list('res').map((item) => item.dayPos?.[dayId]),
      ];
      kept[dayId] = state.dayPos?.[dayId] ?? orderAfter(keys);
    }
    state.dayPos = Object.keys(kept).length ? kept : undefined;
    touch();
  }

  // Travelers: members and guests, plus anyone already listed who has since left.
  function peopleSection() {
    const members = space.members();
    const guests = list('guest');
    const people = new Set(state.people ?? []);
    const ids = [...members.map((member) => member.uid), ...guests.map((guest) => guest.id)];
    for (const id of people) if (!ids.includes(id)) ids.push(id);
    const section = el('fieldset.res-section', {}, el('legend.res-section-title', {}, t('bookings.people')));
    if (!ids.length) section.append(el('p.field-hint', {}, t('bookings.noPeople')));
    else section.append(el('div.res-people', {}, ids.map((id) => checkbox(personName(id, members, guests), {
      checked: people.has(id),
      onChange: (checked) => { if (checked) people.add(id); else people.delete(id); state.people = [...people]; touch(); },
    }))));
    return section;
  }

  function linksSection() {
    const section = el('fieldset.res-section', {}, el('legend.res-section-title', {}, t('bookings.field.notes')));
    const url = field({ label: t('bookings.url'), type: 'url', value: state.url ?? '', maxLength: 2048, inputmode: 'url', autocomplete: 'off', spellcheck: false });
    url.input.addEventListener('input', () => { state.url = url.input.value; url.setError(''); touch(); });
    const notes = field({ label: t('bookings.notes'), type: 'textarea', value: state.notes ?? '', rows: 3, hint: t('bookings.notesHint'), maxLength: 100_000 });
    notes.input.addEventListener('input', () => { state.notes = notes.input.value; touch(); });
    section.append(url.element, notes.element);
    const visits = list('visit');
    if (visits.length) {
      const placeName = (visit) => visit.title || space.get('place', visit.placeId)?.name || t('bookings.untitledEndpoint');
      const options = days.map((day, index) => ({ group: dayName(day, index), options: (space.select.visit.groupBy('dayId').get(day.id) ?? []).map((visit) => ({ value: visit.id, label: placeName(visit) })) }))
        .filter((group) => group.options.length);
      section.append(selectField({ label: t('bookings.visitLink'), value: state.visitId ?? '', options: [{ value: '', label: t('bookings.none') }, ...options],
        onChange: (value) => { state.visitId = value || undefined; touch(); } }).element);
    }
    return { section, url };
  }

  // Links apply on save; files uploaded from the picker are in the trip at once.
  function filesSection() {
    const section = el('fieldset.res-section', {}, el('legend.res-section-title', {}, t('bookings.files')));
    const body = el('div.res-files');
    const add = button(t('bookings.linkFile'), { icon: 'plus', size: 'sm', variant: 'outline', onclick: async () => {
      const chosen = await openFilePicker(space, { selected: [...wanted], title: t('bookings.pickFileTitle') });
      if (!chosen || (chosen.length === wanted.size && chosen.every((id) => wanted.has(id)))) return;
      wanted = new Set(chosen);
      touch(); paint(); add.focus();
    } });
    const paint = () => {
      const linked = list('file').filter((file) => file.kind === 'user' && !file.trashed && wanted.has(file.id));
      append(clear(body), [
        linked.length ? el('ul.res-file-list', {}, linked.map((file) => el('li.res-file', {}, icon('attach', 16), el('span', {}, file.name),
          canFiles && toolButton('close', t('bookings.unlinkFile', { name: file.name }), () => { wanted.delete(file.id); touch(); paint(); body.querySelector('button')?.focus(); })))) : el('p.field-hint', {}, t('bookings.noFiles')),
        canFiles && add,
      ]);
    };
    paint();
    section.append(body);
    return section;
  }

  const links = linksSection();
  const save = button(t(existing ? 'bookings.save' : 'bookings.create'), { type: 'submit', variant: 'primary' });
  const form = el('form.res-form', { noValidate: true, onsubmit: (event) => { event.preventDefault(); void submit(); } },
    alert, review,
    el('div.res-section.res-basics', {}, el('div.field-row.res-wrap', {}, typeField.element, title.element),
      el('div.field', {}, el('span.field-label', { 'aria-hidden': 'true' }, t('bookings.field.status')), status.element), code.element),
    dynamic, peopleSection(), links.section, filesSection(), zones.element,
    el('div.modal-actions', {}, button(t('bookings.cancel'), { onclick: () => requestClose() }), save));
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); form.requestSubmit(save); }
  });
  rebuild();

  function placeOps(fields) {
    if (!isLodging(fields.type) || !picked?.location || fields.placeId || !canPlaces) return [];
    const loc = picked.location;
    const osm = osmKey(picked.item?.osm);
    const name = loc.name.trim().toLocaleLowerCase();
    const match = list('place').find((place) => (osm && place.ids?.osm === osm)
      || (place.name.trim().toLocaleLowerCase() === name && (!Number.isFinite(loc.lat) || !Number.isFinite(place.lat) || distanceMeters(place, loc) < 100)));
    if (match) { fields.placeId = match.id; return []; }
    const put = { name: loc.name, ...(loc.address ? { address: loc.address.slice(0, 2000) } : {}), ...(Number.isFinite(loc.lat) ? { lat: loc.lat, lng: loc.lng } : {}),
      ...(state.zone ? { tz: state.zone } : {}), cat: 'hotel', ...(osm ? { ids: { osm } } : {}) };
    const op = space.ops.create('place', put);
    fields.placeId = op.id;
    return [op];
  }

  function validate(fields) {
    let first = null;
    const flag = (control, message) => { control.setError(message); first ??= control.input; };
    if (isTransport(state.type)) state.legs.forEach((leg, index) => { if (!isDate(leg.dep?.date)) flag(legViews[index].depDate, t('bookings.depDateRequired')); });
    if (state.url?.trim() && !safeURL(state.url.trim())) flag(links.url, t('bookings.urlInvalid'));
    const order = (dayId) => days.findIndex((day) => day.id === dayId);
    if (!first && fields.stay?.toDayId && order(fields.stay.toDayId) < order(fields.stay.fromDayId)) { showAlert(t('bookings.checkOutBeforeIn')); return false; }
    if (!first && resIssues(fields).length) { showAlert(t('bookings.invalid')); return false; }
    if (first) { showAlert(t('bookings.invalid')); first.focus(); return false; }
    return true;
  }

  async function submit() {
    showAlert();
    const draftState = { ...state, title: state.title?.trim() || suggestTitle(state) || typeLabel(state.type) };
    if (isLodging(state.type) && !undated) {
      const from = dayForDate(days, state.start?.date);
      const to = dayForDate(days, state.end?.date ?? state.start?.date);
      draftState.stay = { ...state.stay, fromDayId: from && to ? from : undefined, toDayId: from && to ? to : undefined };
    }
    if (!isTransport(state.type)) Object.assign(draftState, zonedRange());
    const fields = normalizeRes(draftState);
    if (!validate(fields)) return;
    const ops = placeOps(fields);
    let id = existing?.id;
    const current = existing ? space.get('res', existing.id) : null;
    if (existing && !current && !gone) {
      gone = true;
      showAlert(t('bookings.gone'));
      save.textContent = t('bookings.saveAsNew');
      return;
    }
    if (!existing || gone) {
      const create = space.ops.create('res', fields);
      id = create.id;
      ops.push(create);
    } else {
      const patch = resPatch(before, fields);
      if (Object.keys(patch.set).length || patch.unset.length) {
        const op = space.ops.patch('res', id, patch, { base: true });
        // Fields someone else changed since the form opened get a conflict instead of a silent overwrite.
        const valueAt = (entity, path) => (path.startsWith('dayPos.') ? entity.dayPos?.[path.slice(7)] : entity[path]);
        const touched = [...Object.keys(patch.set), ...patch.unset];
        if (openBase && touched.some((path) => !same(valueAt(current, path), valueAt(before, path)))) op.base = openBase;
        ops.push(op);
      }
    }
    if (canFiles) {
      const visible = list('file').filter((file) => file.kind === 'user' && !file.trashed);
      for (const [fileId, patch] of Object.entries(fileLinkChanges(visible, id, wanted))) ops.push(space.ops.patch('file', fileId, patch));
    }
    if (!ops.length) { dialog.close('saved'); return; }
    save.setAttribute('aria-busy', 'true');
    try {
      await space.apply(ops, { history: t(existing && !gone ? 'bookings.historyEdit' : 'bookings.historyAdd') });
    } catch (error) {
      showAlert(error instanceof DomainError ? t('bookings.invalid') : t('bookings.actionFailed'));
      return;
    } finally { save.setAttribute('aria-busy', 'false'); }
    dirty = false;
    dialog.close('saved');
    const offline = globalThis.navigator?.onLine === false || ['offline', 'queued'].includes(space.state?.sync);
    toast(offline ? t('bookings.savedOffline') : t(existing && !gone ? 'bookings.saved' : 'bookings.added', { name: fields.title }), {
      action: space.history?.canUndo ? { label: t('bookings.undo'), onClick: () => { void space.history.undo().catch(() => toast(t('bookings.actionFailed'))); } } : undefined,
    });
  }

  async function requestClose() {
    if (!dirty || await confirmDialog({ title: t('bookings.discardTitle'), body: t('bookings.discardBody'), confirmLabel: t('bookings.discard'), danger: true })) {
      dirty = false; dialog.close('cancel');
    }
  }

  const dialog = openModal({
    title: t(existing ? 'bookings.editTitle' : 'bookings.newTitle'), content: form, wide: true, dismissOnBackdrop: false,
    initialFocus: existing ? title.input : (dynamic.querySelector('input') ?? title.input), onClose,
  });
  // Escape asks before discarding edits; the kit closes on Escape unless the event was handled.
  dialog.panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || !dirty) return;
    event.preventDefault();
    void requestClose();
  });
  return dialog;
}
