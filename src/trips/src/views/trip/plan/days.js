import { el, uid } from '../../../ui/dom.js';
import { button, chip, emptyState, skeleton } from '../../../ui/bits.js';
import { openMenu } from '../../../ui/menu.js';
import { toast } from '../../../ui/toast.js';
import { markdown } from '../../../ui/md.js';
import { avatarStack } from '../../../ui/avatar.js';
import { makeDragSource, makeDropZone } from '../../../ui/dnd.js';
import { openConflictDialog } from '../../../ui/conflict.js';
import { t } from '../../../lib/i18n/index.js';
import { formatDate, formatTime } from '../../../lib/format.js';
import { onPrefs, prefersReducedMotion } from '../../../lib/prefs.js';
import { routeHash } from '../../../lib/router.js';
import { phaseLabelKey, stopNumbers, upcoming } from '../../../lib/timeline/index.js';
import { isDate } from '../../../shared/dates.js';
import { icon, MODE_ICONS, RES_ICONS } from './icons.js';
import { callHook, onPlanHooks } from './hooks.js';
import { createActions, dayCountPatch, dayImpact, missingDates, nextDate, timelineOf } from './ops.js';
import { dayLabel, openDayForm, openItemForm, openNoteForm, openRemoveDay, openVisitForm, pickDay, pickPlaces } from './forms.js';

const WATCHED = new Set(['day', 'visit', 'dayNote', 'res', 'place', 'meta', 'member', 'guest', 'exp']);
const PLAN_OPS = new Set(['day', 'visit', 'dayNote']);
const iconButton = (name, label, attrs = {}) => el('button.icon-btn', { type: 'button', title: label, 'aria-label': label, ...attrs }, icon(name));
const sameRefs = (a, b) => a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
// Positions in `refsOf` of the hook, preference and member versions and the day count: a change there alone can
// wait a few frames.
const VERSION_REFS = new Set([6, 7, 8, 9, 10]);
const onlyVersions = (a, b) => a.length === b.length && a.every((value, index) => VERSION_REFS.has(index) || Object.is(value, b[index]));
// Day sections built by a render; long trips build the rest in slices of about SLICE_MS on later tasks.
const BATCH = 6;
const SLICE_MS = 12;

/**
 * The days column: day cards with their timelines, the day rail, what's next, undo/redo and drag and drop.
 * Returns `{step(delta), addDay(), undo(), redo(), addToDay({placeId, dayId}), destroy()}`.
 */
export function mountDays(container, { space, plan, app, route, showPane }) {
  const actions = createActions(space, { label: (key) => t(`plan.history.${key}`) });
  const live = el('div.sr-only', { role: 'status', 'aria-live': 'polite' });
  const undoButton = iconButton('undo', t('plan.undo'), { disabled: true, onclick: () => undo() });
  const redoButton = iconButton('redo', t('plan.redo'), { disabled: true, onclick: () => redo() });
  const addDayButton = button(t('plan.addDay'), { icon: 'plus', size: 'sm', onclick: (event) => addDayMenu(event.currentTarget) });
  const tools = el('div.plan-col-tools', {}, undoButton, redoButton, addDayButton);
  const status = el('div.plan-status');
  const rail = el('nav.plan-rail', { 'aria-label': t('plan.dayRail') });
  const next = el('div.plan-next-host');
  const dayList = el('div.plan-day-list');
  const orphans = el('div.plan-orphans-host');
  const empty = el('div.plan-empty-host');
  const root = el('div.plan-col', {},
    el('header.plan-col-head', {}, el('h2.plan-col-title', {}, t('plan.title')), tools),
    status, rail, next, empty, dayList, orphans, live);
  container.replaceChildren(root);

  let timeline = timelineOf(space);
  let canEdit = false;
  let hookVersion = 0;
  const dayHookVersions = new Map();
  let prefsVersion = 0;
  let membersVersion = 0;
  let frame = 0;
  let backlog = 0;
  let pendingFocus = null;
  let destroyed = false;
  let nextOpen = false;
  const sections = new Map();
  const chips = new Map();
  const allChip = el('button.day-chip.plan-rail-chip', { type: 'button', 'aria-pressed': 'true', onclick: () => plan.set({ day: null, visit: null }) });
  const context = { space, plan };

  const announce = (message) => { live.textContent = ''; live.textContent = message; };
  const fail = () => toast(t('plan.saveFailed'));
  const guard = (promise) => Promise.resolve(promise).catch(fail);
  const placeOf = (visit) => (visit?.placeId ? space.get('place', visit.placeId) : null);
  const rowName = (row) => {
    if (row.kind === 'visit') return placeOf(row.entity)?.name ?? row.entity.title ?? t('plan.untitled');
    return row.entity.title ?? t('plan.untitled');
  };
  const entryOf = (dayId) => timeline.byDay.get(dayId);
  let people = null;
  function personOf(id) {
    people ??= new Map(space.members().map((member) => [member.uid, { id: member.uid, name: member.name }]));
    const guest = people.has(id) ? null : space.get('guest', id);
    return people.get(id) ?? (guest ? { id: guest.id, name: guest.name } : null);
  }
  const orphanRows = () => [
    ...timeline.orphans.visits.map((visit) => ({ key: `visit:${visit.id}`, kind: 'visit', id: visit.id, entity: visit, leg: null, phase: null, order: visit.order, time: visit.start ?? null, end: visit.end ?? null, primary: true })),
    ...timeline.orphans.notes.map((note) => ({ key: `note:${note.id}`, kind: 'note', id: note.id, entity: note, leg: null, phase: null, order: note.order, time: note.time ?? null, end: null, primary: true })),
  ];
  function findRow({ key, day }) {
    const rows = day ? entryOf(day)?.rows : orphanRows();
    return rows?.find((row) => row.key === key) ?? null;
  }
  const resMovable = (res) => !isDate(res.start?.date) && !res.legs?.length;
  function accepts(data, dayId) {
    if (!canEdit || !data) return false;
    if (data.t === 'place') return Boolean(space.get('place', data.id));
    if (data.t !== 'row') return false;
    const row = findRow(data);
    if (!row?.primary) return false;
    if (row.kind === 'res') return space.can('res.edit') && (data.day === dayId || resMovable(row.entity));
    return true;
  }
  async function dropOn(dayId, data, index) {
    const entry = entryOf(dayId);
    if (!entry) return;
    if (data.t === 'place') {
      const place = space.get('place', data.id);
      await guard(actions.addVisits(dayId, [data.id], { index }));
      announce(t('plan.addedTo', { name: place?.name ?? '', day: dayLabel(entry) }));
      return;
    }
    const row = findRow(data);
    if (!row) return;
    pendingFocus = `grip:${row.key}`;
    await guard(actions.moveRow(row, data.day || row.entity.dayId, dayId, index));
    announce(t('plan.movedTo', { name: rowName(row), day: dayLabel(entry) }));
  }

  // Rows move by grip or long press; days by their grip. Zones pick the innermost list that takes the payload.
  const rowSource = makeDragSource(root, {
    itemSelector: '.plan-row[data-movable]', handle: '[data-drag-handle]', longPress: true,
    data: (item) => (canEdit ? { t: 'row', key: item.dataset.key, day: item.dataset.day ?? '' } : null),
    onKey: ({ data, delta }) => keyMove(data, delta),
  });
  const daySource = makeDragSource(dayList, {
    itemSelector: '.plan-day', handle: '[data-day-handle]',
    data: (item) => (canEdit ? { t: 'day', id: item.dataset.day } : null),
    onKey: ({ data, delta }) => moveDayBy(data.id, delta),
  });
  const dayZone = makeDropZone(dayList, {
    itemSelector: '.plan-day', accepts: (data) => canEdit && data?.t === 'day',
    onDrop: ({ data, index }) => { pendingFocus = `dayGrip:${data.id}`; void guard(actions.moveDay(data.id, index)); },
  });

  function keyMove(data, delta) {
    const row = findRow(data);
    const entry = data.day ? entryOf(data.day) : null;
    if (!row || !entry || !canEdit) return;
    const at = entry.rows.findIndex((item) => item.key === row.key);
    const inside = delta < 0 ? at > 0 : at < entry.rows.length - 1;
    pendingFocus = `grip:${row.key}`;
    if (inside) {
      void guard(actions.moveRow(row, entry.day.id, entry.day.id, delta < 0 ? at - 1 : at + 1));
      announce(t('plan.movedWithin', { name: rowName(row), position: at + delta + 1, count: entry.rows.length }));
      return;
    }
    const target = timeline.days[entry.index + delta];
    if (!target || (row.kind === 'res' && !resMovable(row.entity))) { announce(t('plan.cannotMove', { name: rowName(row) })); return; }
    void guard(actions.moveRow(row, entry.day.id, target.day.id, delta < 0 ? -1 : 0));
    announce(t('plan.movedTo', { name: rowName(row), day: dayLabel(target) }));
  }
  function moveDayBy(dayId, delta) {
    const entry = entryOf(dayId);
    if (!entry || !canEdit) return;
    const index = entry.index + delta;
    if (index < 0 || index >= timeline.days.length) return;
    pendingFocus = `dayGrip:${dayId}`;
    void guard(actions.moveDay(dayId, index));
    announce(t('plan.dayMoved', { day: t('plan.dayNumber', { number: entry.number }), position: index + 1, count: timeline.days.length }));
  }

  function selectDay(dayId, { scroll = true } = {}) {
    plan.set({ day: dayId, visit: null, place: null });
    if (!scroll) return;
    buildAll();
    sections.get(dayId)?.element.scrollIntoView?.({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }
  function selectRow(row, entry) {
    if (row.kind === 'visit') plan.set({ day: entry?.day.id ?? null, visit: row.id, place: row.entity.placeId ?? null });
    else plan.set({ day: entry?.day.id ?? null, visit: null, place: null });
  }
  function step(delta) {
    if (!timeline.days.length) return;
    const index = timeline.days.findIndex((entry) => entry.day.id === plan.get().day);
    const target = timeline.days[Math.max(0, Math.min(timeline.days.length - 1, index === -1 ? (delta > 0 ? 0 : timeline.days.length - 1) : index + delta))];
    selectDay(target.day.id);
    root.querySelector(`[data-focus="day:${target.day.id}"]`)?.focus({ preventScroll: true });
  }

  async function addDay(dated = false) {
    try {
      const id = await actions.addDay({ dated });
      pendingFocus = `day:${id}`;
      announce(t('plan.dayAdded'));
    } catch { fail(); }
  }
  function addDayMenu(anchor) {
    const date = space.can('trip.edit') ? nextDate(space) : null;
    if (!date) { void addDay(false); return; }
    openMenu(anchor, [
      { label: t('plan.addDate', { date: formatDate(date, { weekday: true }) }), icon: 'calendar', onSelect: () => addDay(true) },
      { label: t('plan.addUndatedDay'), icon: 'plus', onSelect: () => addDay(false) },
    ]);
  }
  async function addToDay({ placeId, dayId }) {
    if (!canEdit || !space.get('place', placeId)) return;
    const target = dayId && entryOf(dayId) ? dayId : await pickDay({ title: t('plan.addToDayTitle', { name: space.get('place', placeId).name }), days: timeline.days });
    if (!target || destroyed) return;
    await dropOn(target, { t: 'place', id: placeId }, -1);
    toast(t('plan.addedTo', { name: space.get('place', placeId)?.name ?? '', day: dayLabel(entryOf(target)) }));
  }

  async function undo() {
    if (!space.history.canUndo) return;
    try { announce(t('plan.undone', { label: await space.history.undo() })); } catch { toast(t('plan.undoFailed')); }
  }
  async function redo() {
    if (!space.history.canRedo) return;
    try { announce(t('plan.redone', { label: await space.history.redo() })); } catch { toast(t('plan.undoFailed')); }
  }
  function updateHistory() {
    undoButton.disabled = !space.history.canUndo;
    redoButton.disabled = !space.history.canRedo;
    const label = space.history.label;
    undoButton.title = label ? t('plan.undoLabel', { label }) : t('plan.undo');
    undoButton.setAttribute('aria-label', undoButton.title);
  }

  async function removeDay(entry) {
    const impact = dayImpact(space, entry.day.id);
    if (!impact) return;
    await openRemoveDay({ impact, entry, canRes: space.can('res.edit'), canCosts: space.can('costs.edit'), onConfirm: async (exps) => {
      await actions.removeDay(impact, exps);
      if (plan.get().day === entry.day.id) plan.set({ day: null, visit: null });
      announce(t('plan.dayRemoved', { day: dayLabel(entry) }));
    } });
  }
  async function removeRow(row) {
    const type = row.kind === 'visit' ? 'visit' : 'dayNote';
    try {
      const { restore } = await actions.remove(type, row.entity);
      if (plan.get().visit === row.id) plan.set({ visit: null });
      toast(t(row.kind === 'visit' ? 'plan.visitRemoved' : 'plan.noteRemoved', { name: rowName(row) }), { action: { label: t('plan.undo'), onClick: () => guard(restore()) } });
    } catch { fail(); }
  }
  async function moveToDay(row, fromDayId) {
    const target = await pickDay({ title: t('plan.moveToDayTitle', { name: rowName(row) }), days: timeline.days, exclude: fromDayId });
    if (!target || destroyed) return;
    await dropOn(target, { t: 'row', key: row.key, day: fromDayId ?? '' }, -1);
  }
  async function duplicateTo(row) {
    const target = await pickDay({ title: t('plan.addToDayTitle', { name: rowName(row) }), days: timeline.days, exclude: row.entity.dayId });
    if (!target || destroyed) return;
    await guard(actions.duplicateVisit(row.entity, target));
    announce(t('plan.addedTo', { name: rowName(row), day: dayLabel(entryOf(target)) }));
  }
  const openBookings = () => app?.navigate?.(routeHash({ ...route, tab: 'bookings' }));

  function rowMenu(anchor, row, entry) {
    const items = [];
    const dayId = entry?.day.id ?? null;
    if (row.kind === 'visit') {
      const visit = row.entity;
      if (canEdit && row.primary) items.push({ label: t('plan.edit'), icon: 'pencil', onSelect: () => editRow(row, entry) });
      items.push({ label: t('plan.showOnMap'), icon: 'map', onSelect: () => { selectRow(row, entry); plan.emit('locate', { t: 'visit', id: visit.id }); } });
      if (visit.placeId) items.push({ label: t('plan.openPlace'), icon: 'pin', onSelect: () => plan.emit('openPlace', { id: visit.placeId }) });
      if (canEdit && row.primary) {
        items.push({ label: t('plan.moveToDay'), icon: 'arrowRight', onSelect: () => moveToDay(row, dayId) });
        if (visit.placeId && entry) items.push({ label: t('plan.addToAnotherDay'), icon: 'copy', onSelect: () => duplicateTo(row) });
        items.push({ separator: true }, { label: t('plan.removeFromDay'), icon: 'trash', danger: true, onSelect: () => removeRow(row) });
      }
    } else if (row.kind === 'note') {
      if (canEdit) {
        items.push({ label: t('plan.edit'), icon: 'pencil', onSelect: () => editRow(row, entry) });
        items.push({ label: t('plan.moveToDay'), icon: 'arrowRight', onSelect: () => moveToDay(row, dayId) });
        items.push({ separator: true }, { label: t('plan.deleteNote'), icon: 'trash', danger: true, onSelect: () => removeRow(row) });
      }
    } else {
      items.push({ label: t('plan.openBookings'), icon: 'plane', onSelect: openBookings });
      if (row.entity.location?.lat != null || row.entity.legs?.length) items.push({ label: t('plan.showOnMap'), icon: 'map', onSelect: () => plan.emit('locate', { t: 'res', id: row.id }) });
    }
    if (items.length) openMenu(anchor, items);
  }
  function editRow(row, entry) {
    if (!canEdit) return;
    if (row.kind === 'visit') {
      void openVisitForm({ space, visit: row.entity, entry, days: timeline.days, plan, onSave: (set, unset) => actions.editVisit(row.entity, set, unset) });
    } else if (row.kind === 'note') {
      void openNoteForm({ entry, note: row.entity, onSave: (set, unset) => actions.editNote(row.entity, set, unset) });
    }
  }
  function addMenu(anchor, entry) {
    openMenu(anchor, [
      { label: t('plan.addPlacesMenu'), icon: 'pin', onSelect: () => addPlaces(entry) },
      { label: t('plan.addItem'), icon: 'clock', onSelect: () => openItemForm({ entry, onSave: (fields) => actions.addItem(entry.day.id, fields) }) },
      { label: t('plan.addNote'), icon: 'file', onSelect: () => openNoteForm({ entry, onSave: (fields) => actions.addNote(entry.day.id, fields) }) },
    ]);
  }
  async function addPlaces(entry) {
    const ids = await pickPlaces({ space, entry, days: timeline.days, onEmpty: () => showPane?.('places') });
    if (!ids.length || destroyed) return;
    await guard(actions.addVisits(entry.day.id, ids));
    announce(t('plan.placesAdded', { count: ids.length, day: dayLabel(entry) }));
  }
  function dayMenu(anchor, entry) {
    const items = [
      ...(canEdit ? [{ label: t('plan.editDay'), icon: 'pencil', onSelect: () => openDayForm({ entry, onSave: (set, unset) => actions.editDay(entry.day, set, unset) }) }] : []),
      { label: t('plan.showDayOnMap'), icon: 'map', onSelect: () => { selectDay(entry.day.id, { scroll: false }); plan.emit('locate', { t: 'day', id: entry.day.id }); } },
    ];
    if (canEdit) {
      items.push(
        { label: t('plan.moveDayUp'), disabled: entry.index === 0, onSelect: () => moveDayBy(entry.day.id, -1) },
        { label: t('plan.moveDayDown'), disabled: entry.index === timeline.days.length - 1, onSelect: () => moveDayBy(entry.day.id, 1) },
      );
    }
    for (const item of callHook('dayActions', { entry, context }) ?? []) items.push(item);
    if (canEdit) items.push({ separator: true }, { label: t('plan.removeDay'), icon: 'trash', danger: true, onSelect: () => removeDay(entry) });
    openMenu(anchor, items);
  }

  function timeText(row) {
    const start = formatTime(row.time);
    const end = formatTime(row.end);
    if (start && end) return t('plan.timeRange', { start, end });
    return start || (end ? t('plan.until', { time: end }) : '');
  }
  function phaseChip(row) {
    if (!row.phase || !row.family) return null;
    const key = row.kind === 'visit' ? phaseLabelKey('visit', row.phase) : phaseLabelKey(row.family, row.phase);
    return el('span.plan-phase', {}, t(key));
  }
  function grip(row) {
    return el('button.plan-grip', { type: 'button', dataset: { dragHandle: '', focus: `grip:${row.key}` }, 'aria-label': t('plan.reorder', { name: rowName(row) }), 'aria-describedby': hintId }, icon('grip', 16));
  }
  const hintId = uid('plan-hint');
  const hint = el('span.sr-only', { id: hintId }, t('plan.reorderHint'));
  root.append(hint);

  function legNode(visit, next, entry, info) {
    const mode = visit.legMode ?? next.inMode ?? entry.day.mode ?? 'walk';
    const label = t(`plan.mode.${mode}`);
    const control = canEdit
      ? el('button.plan-leg-mode', { type: 'button', 'aria-label': t('plan.changeMode', { mode: label }), onclick: (event) => openMenu(event.currentTarget, Object.keys(MODE_ICONS).map((value) => ({
        label: t(`plan.mode.${value}`), checked: value === mode, onSelect: () => guard(actions.setLegMode(visit, value)),
      }))) }, icon(MODE_ICONS[mode] ?? 'route', 14), el('span', {}, label))
      : el('span.plan-leg-mode', {}, icon(MODE_ICONS[mode] ?? 'route', 14), el('span', {}, label));
    const extra = callHook('connector', { from: visit, to: next, mode, info, entry, context });
    const action = callHook('connectorAction', { from: visit, to: next, mode, info, entry, context });
    return el('div.plan-leg', { role: 'group', 'aria-label': t('plan.legTo', { name: placeOf(next)?.name ?? next.title ?? '' }) }, control, extra, action);
  }

  function rowNode(row, entry, numbers, info, nextRow) {
    const movable = canEdit && row.primary && (row.kind !== 'res' || space.can('res.edit'));
    const node = el('li.plan-row', { dataset: { key: row.key, kind: row.kind, id: row.id, ...(entry ? { day: entry.day.id } : {}), ...(movable ? { movable: '' } : {}) } });
    if (row.phase) node.dataset.phase = row.phase;
    const meta = [];
    const time = timeText(row);
    if (time) meta.push(el('span.plan-time.num', {}, time));
    const phase = phaseChip(row);
    if (phase) meta.push(phase);
    let lead;
    const title = rowName(row);
    let body = null;
    if (row.kind === 'visit') {
      const place = placeOf(row.entity);
      const number = numbers.get(row.id);
      lead = number ? el('span.plan-stop.num', {}, el('span.sr-only', {}, t('plan.stop', { number })), el('span', { 'aria-hidden': 'true' }, String(number)))
        : el('span.plan-bullet', { 'aria-hidden': 'true' }, icon(place ? 'map-pin' : 'list-plus', 15));
      if (place?.stop?.type) node.dataset.stop = place.stop.type;
      if (place?.address) meta.push(el('span.plan-sub', {}, place.address));
      if (!place && row.entity.placeId) meta.push(el('span.plan-sub', {}, t('plan.placeMissing')));
      const who = (row.entity.people ?? []).map(personOf).filter(Boolean);
      if (who.length && row.primary) meta.push(avatarStack(who, { max: 3, size: 20 }));
      if (row.entity.notes && row.primary) body = el('p.plan-row-notes', {}, row.entity.notes.slice(0, 200));
    } else if (row.kind === 'note') {
      const color = Number.isInteger(row.entity.color) ? `var(--day-${row.entity.color})` : null;
      lead = el('span.plan-bullet.plan-note-icon', { 'aria-hidden': 'true', style: color ? { color } : {} }, icon(row.entity.icon ?? 'sticky-note', 15));
      if (row.entity.text) {
        const details = el('div.plan-note-text.markdown', { hidden: true }, markdown(row.entity.text));
        const toggle = el('button.plan-link', { type: 'button', 'aria-expanded': 'false', onclick: () => {
          details.hidden = !details.hidden; toggle.setAttribute('aria-expanded', String(!details.hidden));
          toggle.textContent = t(details.hidden ? 'plan.showDetails' : 'plan.hideDetails');
        } }, t('plan.showDetails'));
        body = el('div', {}, toggle, details);
      }
    } else {
      const res = row.entity;
      lead = el('span.plan-bullet.plan-res-icon', { 'aria-hidden': 'true' }, icon(RES_ICONS[res.type] ?? 'bookmark', 15));
      if (row.leg !== null) {
        const leg = res.legs?.[row.leg];
        const route = [leg?.from?.code || leg?.from?.name, leg?.to?.code || leg?.to?.name].filter(Boolean).join(' → ');
        if (route) meta.push(el('span.plan-sub', {}, route));
      }
      if (res.status !== 'confirmed') meta.push(chip(t(`plan.status.${res.status}`), { status: res.status === 'cancelled' ? '' : 'warn' }));
      if (res.status === 'cancelled') node.classList.add('is-cancelled');
    }
    const main = el('button.plan-row-main', {
      type: 'button', dataset: { focus: `row:${row.key}` },
      onclick: () => (row.kind === 'res' ? openBookings() : selectRow(row, entry)),
      ondblclick: () => editRow(row, entry),
    }, el('span.plan-row-title', {}, title), meta.length ? el('span.plan-row-meta', {}, meta) : null);
    node.append(movable ? grip(row) : el('span.plan-grip-space', { 'aria-hidden': 'true' }), lead, el('div.plan-row-body', {}, main, body,
      callHook('rowDetail', { row, info: info?.get(row.key) ?? null, entry, context })),
    iconButton('more', t('plan.rowActions', { name: title }), { className: 'icon-btn icon-btn-sm plan-row-more', onclick: (event) => rowMenu(event.currentTarget, row, entry) }));
    if (row.kind === 'visit' && row.primary && nextRow?.kind === 'visit' && nextRow.primary && row.entity.placeId && nextRow.entity.placeId) {
      node.append(legNode(row.entity, nextRow.entity, entry, info));
    }
    return node;
  }

  function refsOf(entry) {
    const refs = [entry.day, entry.number, entry.color, entry.date, canEdit, space.can('res.edit'), hookVersion, dayHookVersions.get(entry.day.id), prefsVersion, membersVersion, timeline.days.length];
    for (const row of entry.rows) refs.push(row.key, row.entity, row.phase, row.order, placeOf(row.kind === 'visit' ? row.entity : null));
    for (const stay of entry.stays) refs.push(stay.res, stay.phase);
    return refs;
  }

  function buildDay(entry) {
    const { day } = entry;
    const label = dayLabel(entry);
    const info = callHook('annotate', { entry, rows: entry.rows, context });
    const numbers = stopNumbers(entry.rows, (visit) => {
      const place = placeOf(visit);
      return place?.lat != null;
    });
    const list = el('ol.plan-rows', { 'aria-label': t('plan.dayItems', { day: label }) });
    entry.rows.forEach((row, index) => list.append(rowNode(row, entry, numbers, info, entry.rows[index + 1])));
    if (!entry.rows.length) list.append(el('li.plan-rows-empty', {}, t(canEdit ? 'plan.dayEmptyEdit' : 'plan.dayEmpty')));
    const headingId = uid('plan-day');
    const stays = entry.stays.filter((stay) => stay.res.status !== 'cancelled').map((stay) => el('p.plan-stay', {}, icon('bed-double', 14),
      el('span', {}, t(phaseLabelKey('stay', stay.phase))), el('strong', {}, stay.res.title),
      stay.phase === 'checkin' && stay.res.stay?.checkInFrom && el('span.num', {}, formatTime(stay.res.stay.checkInFrom)),
      stay.phase === 'checkout' && stay.res.stay?.checkOut && el('span.num', {}, formatTime(stay.res.stay.checkOut))));
    const notes = day.notes ? el('div.plan-day-notes.markdown', {}, markdown(day.notes)) : null;
    const element = el('section.plan-day', { dataset: { day: day.id }, style: { '--day-color': `var(--day-${entry.color})` }, 'aria-labelledby': headingId },
      el('header.plan-day-head', {},
        canEdit && el('button.plan-grip.plan-day-grip', { type: 'button', dataset: { dayHandle: '', focus: `dayGrip:${day.id}` }, 'aria-label': t('plan.reorderDay', { day: label }), 'aria-describedby': hintId }, icon('grip', 16)),
        el('h3.plan-day-heading', { id: headingId }, el('button.plan-day-title', { type: 'button', dataset: { focus: `day:${day.id}` }, 'aria-pressed': 'false', onclick: () => selectDay(day.id, { scroll: false }) },
          el('span.plan-day-num', {}, t('plan.dayNumber', { number: entry.number })),
          entry.date && el('span.plan-day-date', {}, formatDate(entry.date, { weekday: true, year: false })),
          day.title && el('span.plan-day-name', {}, day.title))),
        callHook('dayHeader', { entry, context }),
        el('div.plan-day-actions', {},
          canEdit && iconButton('plus', t('plan.addToDay', { day: label }), { className: 'icon-btn icon-btn-sm', onclick: (event) => addMenu(event.currentTarget, entry) }),
          iconButton('more', t('plan.dayActions', { day: label }), { className: 'icon-btn icon-btn-sm', onclick: (event) => dayMenu(event.currentTarget, entry) }))),
      callHook('dayInfo', { entry, context }), stays, notes, list);
    const zone = makeDropZone(list, { area: element, itemSelector: '.plan-row', accepts: (data) => accepts(data, day.id), onDrop: ({ data, index }) => dropOn(day.id, data, index) });
    return { element, zone, refs: refsOf(entry) };
  }

  /**
   * Entity changes rebuild their day at once. New days and version-only refreshes (hooks, preferences, members) build
   * `BATCH` at a time, then in short slices on later tasks; until then a refreshed day keeps its previous section and
   * a new one is not shown yet.
   */
  function renderDays({ all = false, slice = false } = {}) {
    clearTimeout(backlog); backlog = 0;
    const nodes = [];
    const ids = new Set();
    let budget = all ? Infinity : slice ? 1 : BATCH;
    const until = slice ? performance.now() + SLICE_MS : Infinity;
    let deferred = false;
    for (const entry of timeline.days) {
      const refs = refsOf(entry);
      let cached = sections.get(entry.day.id);
      if (!cached || !sameRefs(cached.refs, refs)) {
        const waits = !cached || onlyVersions(cached.refs, refs);
        if (waits && budget <= 0 && (!slice || performance.now() >= until)) {
          deferred = true;
          if (cached) { nodes.push(cached.element); ids.add(entry.day.id); }
          continue;
        }
        if (waits) budget--;
        const fresh = buildDay(entry);
        if (cached) { cached.zone.destroy(); if (cached.element.isConnected) cached.element.replaceWith(fresh.element); }
        cached = fresh;
        sections.set(entry.day.id, cached);
      }
      nodes.push(cached.element);
      ids.add(entry.day.id);
    }
    for (const [id, cached] of sections) if (!ids.has(id)) { cached.zone.destroy(); cached.element.remove(); sections.delete(id); }
    const current = [...dayList.children];
    if (current.length !== nodes.length || current.some((node, index) => node !== nodes[index])) dayList.replaceChildren(...nodes);
    if (deferred && !destroyed) backlog = setTimeout(() => { if (!destroyed) { renderDays({ slice: true }); applySelection(); } }, 0);
  }
  /** Builds every pending day now, before code that scrolls to or focuses one. */
  function buildAll() { if (backlog) { renderDays({ all: true }); applySelection(); } }

  function renderEmpty(loading) {
    if (timeline.days.length) { empty.replaceChildren(); return; }
    if (loading) { empty.replaceChildren(el('div.plan-skeleton', { 'aria-hidden': 'true' }, skeleton('60%'), skeleton(), skeleton('80%'))); return; }
    const meta = space.get('meta', 'meta');
    const dated = isDate(meta?.start);
    empty.replaceChildren(emptyState({
      icon: 'calendar', title: t('plan.noDays'), body: t(canEdit ? (dated ? 'plan.noDaysDated' : 'plan.noDaysUndated') : 'plan.noDaysViewer', { count: meta?.dayCount ?? 7 }),
      action: canEdit && button(t('plan.setUpDays'), { variant: 'primary', onclick: () => guard(actions.setUpDays()) }),
    }));
  }

  function renderStatus() {
    const nodes = [];
    if (!canEdit) nodes.push(el('p.plan-note', {}, icon('users', 15), t('plan.viewOnly')));
    const missing = canEdit && timeline.days.length ? missingDates(space).length : 0;
    if (missing) nodes.push(el('div.plan-banner', { role: 'status' }, el('span', {}, t('plan.missingDates', { count: missing })), button(t('plan.addMissing'), { size: 'sm', onclick: () => guard(actions.setUpDays()) })));
    const conflicts = space.conflicts().filter((conflict) => PLAN_OPS.has(conflict.op.t) || ['day.remove', 'visit.move'].includes(conflict.op.do)
      || (conflict.op.t === 'res' && Object.keys(conflict.op.set ?? {}).every((path) => path.startsWith('dayPos.'))));
    if (conflicts.length) {
      nodes.push(el('div.plan-banner.plan-banner-warn', { role: 'alert' }, icon('warning', 16), el('span', {}, t('plan.conflicts', { count: conflicts.length })),
        button(t('plan.review'), { size: 'sm', onclick: () => openConflictDialog({
          conflict: conflicts[0], typeLabel: (type) => t(`plan.type.${type}`), fieldLabel: (_type, name) => t(`plan.field.${name}`),
          onResolve: (choice) => space.resolveConflict(conflicts[0].op.opId, choice),
        }) })));
    }
    status.replaceChildren(...nodes);
  }

  // Chips are kept per day and rebuilt only when their day, label or hooks change; selection is applySelection's.
  function renderRail() {
    const selected = plan.get().day;
    const ids = new Set();
    const nodes = [allChip];
    const allLabel = t('plan.allDays');
    if (allChip.textContent !== allLabel) allChip.textContent = allLabel;
    for (const entry of timeline.days) {
      const refs = [entry.day, entry.number, entry.color, entry.date, hookVersion, dayHookVersions.get(entry.day.id), prefsVersion];
      let cached = chips.get(entry.day.id);
      if (!cached || !sameRefs(cached.refs, refs)) {
        cached?.zone.destroy();
        const node = el('button.day-chip.plan-rail-chip', { type: 'button', 'aria-pressed': String(entry.day.id === selected), style: { '--day-color': `var(--day-${entry.color})` }, dataset: { day: entry.day.id, focus: `chip:${entry.day.id}` },
          onclick: () => selectDay(entry.day.id) }, el('span.day-dot', { 'aria-hidden': 'true' }), el('span', {}, entry.date ? formatDate(entry.date, { weekday: true, year: false }) : t('plan.dayNumber', { number: entry.number })),
          callHook('dayChip', { entry, context }));
        cached = { node, refs, zone: makeDropZone(node, { placeholder: false, accepts: (data) => accepts(data, entry.day.id), onDrop: ({ data }) => dropOn(entry.day.id, data, -1) }) };
        chips.set(entry.day.id, cached);
      }
      nodes.push(cached.node);
      ids.add(entry.day.id);
    }
    for (const [id, cached] of chips) if (!ids.has(id)) { cached.zone.destroy(); chips.delete(id); }
    const current = [...rail.children];
    if (current.length !== nodes.length || current.some((node, index) => node !== nodes[index])) rail.replaceChildren(...nodes);
    rail.hidden = !timeline.days.length;
  }

  function renderNext() {
    const items = upcoming(timeline);
    if (!items.length) { next.replaceChildren(); return; }
    const first = items[0];
    const details = el('details.plan-next', { open: nextOpen, ontoggle: () => { nextOpen = details.open; } },
      el('summary', {}, el('span.plan-next-label', {}, t('plan.whatsNext')), el('span.plan-next-first', {}, `${formatDate(first.date, { weekday: true, year: false })} ${formatTime(first.time)} · ${rowName(first.row)}`)),
      el('ol.plan-next-list', {}, items.map((item) => el('li', {}, el('button.plan-next-item', { type: 'button', onclick: () => {
        selectRow(item.row, item.entry);
        if (item.row.kind !== 'visit') plan.set({ day: item.entry.day.id });
        buildAll();
        const target = root.querySelector(`[data-focus="row:${item.row.key}"]`);
        target?.scrollIntoView?.({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
        target?.focus({ preventScroll: true });
      } }, el('span.plan-next-when.num', {}, `${formatDate(item.date, { weekday: true, year: false })} · ${formatTime(item.time)}`), el('span', {}, rowName(item.row)),
      item.row.phase && el('span.plan-phase', {}, t(item.row.kind === 'res' ? phaseLabelKey(item.row.family, item.row.phase) : phaseLabelKey('visit', item.row.phase))))))));
    next.replaceChildren(details);
  }

  function renderOrphans() {
    const rows = orphanRows();
    if (!rows.length) { orphans.replaceChildren(); return; }
    const list = el('ol.plan-rows', {}, rows.map((row) => rowNode(row, null, new Map(), null, null)));
    orphans.replaceChildren(el('section.plan-orphans', { 'aria-label': t('plan.orphans') }, el('h3', {}, t('plan.orphans')), el('p.field-hint', {}, t('plan.orphansHint')), list));
  }

  function applySelection() {
    const { day, visit } = plan.get();
    for (const [id, cached] of sections) {
      cached.element.classList.toggle('is-selected', id === day);
      cached.element.querySelector('.plan-day-title')?.setAttribute('aria-pressed', String(id === day));
    }
    for (const node of root.querySelectorAll('.plan-row.is-selected')) node.classList.remove('is-selected');
    if (visit) for (const node of root.querySelectorAll(`.plan-row[data-kind="visit"][data-id="${visit}"]`)) node.classList.add('is-selected');
    for (const node of rail.querySelectorAll('.plan-rail-chip')) node.setAttribute('aria-pressed', String((node.dataset.day ?? null) === day));
  }

  // Undated trips keep `dayCount` equal to their days, whoever changed them; a refused value is not retried.
  let countTried = null;
  function syncDayCount() {
    const ops = space.state.rev ? dayCountPatch(space) : [];
    if (!ops.length || ops[0].set.dayCount === countTried) return;
    countTried = ops[0].set.dayCount;
    space.apply(ops).catch(() => {});
  }

  function render() {
    frame = 0;
    if (destroyed) return;
    if (document.body.classList.contains('dnd-active')) { frame = setTimeout(render, 150); return; }
    const focused = root.contains(document.activeElement) ? document.activeElement.closest('[data-focus]')?.dataset.focus : null;
    canEdit = space.can('plan.edit');
    timeline = timelineOf(space);
    syncDayCount();
    people = null;
    const state = space.state;
    tools.hidden = false;
    addDayButton.hidden = !canEdit;
    renderStatus();
    renderEmpty(!timeline.days.length && state.rev === 0 && ['idle', 'syncing'].includes(state.sync));
    renderRail();
    renderNext();
    renderDays();
    renderOrphans();
    applySelection();
    updateHistory();
    const want = pendingFocus ?? (focused && !root.contains(document.activeElement) ? focused : null);
    if (want) {
      if (!root.querySelector(`[data-focus="${want}"]`)) buildAll();
      const target = root.querySelector(`[data-focus="${want}"]`);
      if (target) { target.focus({ preventScroll: !pendingFocus }); pendingFocus = null; }
    }
  }
  const schedule = () => { if (!frame && !destroyed) frame = setTimeout(render, 0); };
  // The sync status changes on every poll; the column only shows loading, conflicts and the role.
  const stateKey = () => { const { rev, sync, conflicts } = space.state; return `${rev === 0 ? sync : ''}|${conflicts}|${space.role}`; };
  let shownState = stateKey();

  const offs = [
    space.subscribe((event) => {
      if (event.types.has('member')) membersVersion++;
      if ([...event.types].some((type) => WATCHED.has(type))) schedule();
    }),
    space.onState(() => { const key = stateKey(); if (key !== shownState) { shownState = key; schedule(); } }),
    space.history.subscribe(updateHistory),
    plan.subscribe((state, patch) => {
      applySelection();
      if ('visit' in patch && state.visit) {
        buildAll();
        root.querySelector(`.plan-row[data-kind="visit"][data-id="${state.visit}"]`)?.scrollIntoView?.({ block: 'nearest' });
      }
    }),
    onPlanHooks((days) => {
      if (days) for (const id of days) dayHookVersions.set(id, (dayHookVersions.get(id) ?? 0) + 1);
      else hookVersion++;
      schedule();
    }),
    onPrefs(() => { prefsVersion++; schedule(); }),
  ];
  // What's next moves with the clock.
  const clock = setInterval(() => { if (!document.hidden) renderNext(); }, 60_000);
  render();

  return {
    step, undo, redo, addToDay,
    addDay: () => (canEdit ? addDayMenu(addDayButton) : undefined),
    destroy() {
      destroyed = true;
      clearTimeout(frame); clearTimeout(backlog); clearInterval(clock);
      for (const off of offs) off();
      rowSource.destroy(); daySource.destroy(); dayZone.destroy();
      for (const cached of chips.values()) cached.zone.destroy();
      chips.clear();
      for (const cached of sections.values()) cached.zone.destroy();
      sections.clear();
    },
  };
}
