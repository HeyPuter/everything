import './bookings.css';
import { el, uid, safeURL } from '../../../ui/dom.js';
import { button, chip, emptyState, skeleton } from '../../../ui/bits.js';
import { checkbox, segmented } from '../../../ui/fields.js';
import { avatarStack } from '../../../ui/avatar.js';
import { openMenu } from '../../../ui/menu.js';
import { openModal } from '../../../ui/modal.js';
import { markdown } from '../../../ui/md.js';
import { toast } from '../../../ui/toast.js';
import { openConflictDialog } from '../../../ui/conflict.js';
import { t } from '../../../lib/i18n/index.js';
import { formatDate, formatMoney, formatTime } from '../../../lib/format.js';
import { onPrefs, prefs } from '../../../lib/prefs.js';
import { isDate } from '../../../shared/dates.js';
import {
  BOOKING_TYPES, TRANSPORT_TYPES, attachedFiles, duplicateDraft, entriesByDay, filterRes, groupByStatus, isTransport, linkedExpenses,
  pointZoneLabel, removalOps, returnDraft, soleExpenses, unplaced,
} from '../../../lib/res/index.js';
import { icon } from './icons.js';
import { fieldLabel, legDetails, legRoute, legTimes, personName, phaseLabel, pointText, showZones, statusLabel, typeLabel, whenText } from './display.js';
import { openEditor } from './form.js';
import { importEntry } from './import/index.js';
import { moveNotices, openMoveDialog } from './move/index.js';
import { createFlightStatus } from './status/index.js';
import { airtrailEntry } from '../../integrations/entry.js';

const WATCHED = ['res', 'day', 'member', 'guest', 'file', 'exp', 'meta', 'place', 'visit'];
const STATUS_CHIP = { pending: 'warn', confirmed: 'success', cancelled: '' };

/** Bookings tab: reservations, transports and stays of one trip. */
export async function mount(container, context) {
  return createView(container, context);
}

function createView(container, { space, session, signal, puter, account, personal: contextPersonal, app }) {
  const filters = { group: 'all', type: '', traveler: '', mode: 'list' };
  const revealed = new Set();
  const dialogs = new Set();
  const painters = new Set();
  const cleanups = [];
  const headingId = uid('bookings-heading');
  const list = (name) => space.select[name]?.all() ?? [];
  const canEdit = () => space.can('res.edit');
  let queued = false;
  let notesKey = '';

  const addButton = button(t('bookings.add'), { icon: 'plus', variant: 'primary', onclick: () => openMenu(addButton, [
    ...TRANSPORT_TYPES.map((type) => ({ label: typeLabel(type), icon: icon(type, 16), onSelect: () => edit(null, { type }) })),
    { separator: true },
    ...BOOKING_TYPES.map((type) => ({ label: typeLabel(type), icon: icon(type, 16), onSelect: () => edit(null, { type }) })),
  ]) });
  addButton.dataset.focus = 'add';
  const importer = importEntry({ space, session, puter, account, signal });
  cleanups.push(importer.destroy);
  const flightStatus = createFlightStatus({ session, puter, account });
  cleanups.push(flightStatus.destroy);
  const airtrail = airtrailEntry({ space, session, puter, account, app, personal: contextPersonal });
  cleanups.push(airtrail.destroy);
  const head = el('header.bookings-head', {}, el('h2', { id: headingId }, t('bookings.heading')), el('div.bookings-actions', {}, airtrail.element, importer.element, addButton));
  const notes = el('div.bookings-notes', { role: 'status' });
  const filterBar = el('div.bookings-filters', { role: 'group', 'aria-label': t('bookings.filters') });
  const body = el('div.bookings-body');
  const personal = session?.personal ?? contextPersonal;
  const moves = moveNotices({ space, session, puter, personal, navigate: app?.navigate });
  const root = el('section.bookings', { 'aria-labelledby': headingId }, head, notes, moves.element, filterBar, body);
  container.replaceChildren(root);

  const group = segmented({
    label: t('bookings.filterGroup'), value: filters.group,
    items: [{ value: 'all', label: t('bookings.groupAll') }, { value: 'transport', label: t('bookings.groupTransport') }, { value: 'booking', label: t('bookings.groupBooking') }],
    onChange: (value) => { filters.group = value; filters.type = ''; paintFilters(); render(); },
  });
  const mode = segmented({
    label: t('bookings.viewMode'), value: filters.mode,
    items: [{ value: 'list', label: t('bookings.viewList') }, { value: 'days', label: t('bookings.viewDays') }],
    onChange: (value) => { filters.mode = value; render(); },
  });
  const typeId = uid('bookings-type');
  const typeSelect = el('select.select', { id: typeId, onchange: () => { filters.type = typeSelect.value; render(); } });
  const travelerId = uid('bookings-traveler');
  const travelerSelect = el('select.select', { id: travelerId, onchange: () => { filters.traveler = travelerSelect.value; render(); } });
  filterBar.append(group.element,
    el('div.bookings-select', {}, el('label.field-label', { htmlFor: typeId }, t('bookings.filterType')), typeSelect),
    el('div.bookings-select', {}, el('label.field-label', { htmlFor: travelerId }, t('bookings.filterTraveler')), travelerSelect),
    mode.element);

  function paintFilters() {
    const types = filters.group === 'transport' ? TRANSPORT_TYPES : filters.group === 'booking' ? BOOKING_TYPES : [...TRANSPORT_TYPES, ...BOOKING_TYPES];
    typeSelect.replaceChildren(el('option', { value: '' }, t('bookings.allTypes')), ...types.map((type) => el('option', { value: type }, typeLabel(type))));
    typeSelect.value = types.includes(filters.type) ? filters.type : '';
    const members = space.members();
    const guests = list('guest');
    const people = [...members.map((member) => member.uid), ...guests.map((guest) => guest.id)];
    if (filters.traveler && !people.includes(filters.traveler)) filters.traveler = '';
    travelerSelect.replaceChildren(el('option', { value: '' }, t('bookings.everyone')), ...people.map((id) => el('option', { value: id }, personName(id, members, guests))));
    travelerSelect.value = filters.traveler;
  }

  function paintNotes() {
    const state = space.state ?? {};
    const conflicts = space.conflicts?.().filter((conflict) => conflict.op.t === 'res') ?? [];
    // Repainting an unchanged live region would announce it again.
    const key = [canEdit(), state.sync, conflicts.length].join(':');
    if (key === notesKey) return;
    notesKey = key;
    const items = [];
    if (!canEdit()) items.push(el('p.bookings-note', {}, t('bookings.readOnly')));
    if (state.sync === 'offline') items.push(el('p.bookings-note.warn', {}, t('bookings.offline')));
    if (state.sync === 'credit') items.push(el('p.bookings-note.warn', {}, t('bookings.credit')));
    if (state.sync === 'forbidden') items.push(el('p.bookings-note.danger', {}, t('bookings.forbidden')));
    if (conflicts.length) {
      items.push(el('div.bookings-note.warn.bookings-conflicts', {}, icon('alert', 16),
        el('span', {}, conflicts.length === 1 ? t('bookings.conflictsOne') : t('bookings.conflictsMany', { count: conflicts.length })),
        button(t('bookings.review'), { size: 'sm', variant: 'outline', onclick: () => {
          const first = space.conflicts().find((conflict) => conflict.op.t === 'res');
          if (first) resolve(first);
        } })));
    }
    notes.replaceChildren(...items);
    notes.hidden = !items.length;
  }

  function resolve(conflict) {
    track(openConflictDialog({
      conflict, typeLabel: () => t('bookings.conflictType'), fieldLabel: (_type, name) => fieldLabel(name),
      onResolve: (choice) => space.resolveConflict(conflict.op.opId, choice),
    }));
  }

  function track(dialog) {
    dialogs.add(dialog);
    void dialog.closed.then(() => dialogs.delete(dialog));
    return dialog;
  }

  function edit(res, { type, draft } = {}) {
    if (!canEdit()) return;
    track(openEditor({ space, session, res, type, draft }));
  }

  // Rows

  function codeNode(res) {
    if (!res.code) return null;
    if (!prefs().blurCodes || revealed.has(res.id)) {
      const node = el('span.res-code', {}, res.code);
      if (!prefs().blurCodes) return node;
      return el('span.res-code-wrap', {}, node, revealButton(res, true));
    }
    return el('span.res-code-wrap', {}, el('span.res-code.blurred', { 'aria-hidden': 'true' }, '••••••'), el('span.sr-only', {}, t('bookings.codeHidden')), revealButton(res, false));
  }
  function revealButton(res, shown) {
    const label = t(shown ? 'bookings.codeHide' : 'bookings.codeShow', { name: res.title });
    return el('button.icon-btn.icon-btn-sm', { type: 'button', title: label, 'aria-label': label, 'aria-pressed': shown, dataset: { focus: `${res.id}:code` },
      onclick: () => { if (shown) revealed.delete(res.id); else revealed.add(res.id); render(); for (const paint of painters) paint(); } }, icon(shown ? 'eyeOff' : 'eye', 16));
  }

  function moreMenu(res, anchor) {
    const editable = canEdit();
    const items = [{ label: t('bookings.details'), onSelect: () => details(res.id) }];
    if (editable) {
      items.push({ label: t('bookings.edit'), icon: 'pencil', onSelect: () => edit(space.get('res', res.id) ?? res) });
      items.push({ label: t('bookings.duplicate'), icon: 'copy', onSelect: () => edit(null, { type: res.type, draft: duplicateDraft(res) }) });
      if (isTransport(res.type) && res.legs?.length) items.push({ label: t('bookings.returnTrip'), onSelect: () => edit(null, { type: res.type, draft: returnDraft(res) }) });
      if (session?.db && session?.api) items.push({ label: t('resMove.action'), onSelect: () => track(openMoveDialog({ space, session, puter, personal, res: space.get('res', res.id) ?? res, track, navigate: app?.navigate, onChange: moves.refresh })) });
      items.push({ separator: true });
      for (const status of ['confirmed', 'pending', 'cancelled']) {
        if (status !== res.status) items.push({ label: t(`bookings.mark${status[0].toUpperCase()}${status.slice(1)}`), onSelect: () => setStatus(res, status) });
      }
      items.push({ separator: true }, { label: t('bookings.delete'), icon: 'trash', danger: true, onSelect: () => remove(res) });
    }
    openMenu(anchor, items);
  }

  async function setStatus(res, status) {
    try { await space.apply([space.ops.patch('res', res.id, { set: { status } })], { history: t('bookings.historyStatus') }); }
    catch { toast(t('bookings.actionFailed')); }
  }

  function remove(res) {
    const exps = list('exp');
    const sole = space.can('costs.edit') ? soleExpenses(exps, res.id) : [];
    let alsoExpenses = false;
    let dialog;
    const content = el('div.res-delete', {}, el('p', {}, t('bookings.deleteBody')),
      sole.length ? checkbox(sole.length === 1 ? t('bookings.deleteExpenseOne', { name: sole[0].name }) : t('bookings.deleteExpenseMany', { count: sole.length }),
        { onChange: (checked) => { alsoExpenses = checked; } }) : null);
    const confirm = button(t('bookings.delete'), { variant: 'danger', onclick: async () => {
      const ops = removalOps({
        res, files: list('file'), exps, visits: list('visit'), reservations: list('res'), ops: space.ops, can: (action) => space.can(action),
        deleteExpenses: alsoExpenses ? sole.map((exp) => exp.id) : [],
      });
      confirm.setAttribute('aria-busy', 'true');
      try { await space.apply(ops); }
      catch { confirm.setAttribute('aria-busy', 'false'); toast(t('bookings.actionFailed')); return; }
      dialog.close('confirm');
      toast(t('bookings.deleted', { name: res.title }));
    } });
    dialog = track(openModal({ title: t('bookings.deleteTitle', { name: res.title }), content, actions: [button(t('bookings.cancel'), { onclick: () => dialog.close('cancel') }), confirm] }));
  }

  function travelers(res) {
    if (!res.people?.length) return null;
    const members = space.members();
    const guests = list('guest');
    return avatarStack(res.people.map((id) => ({ id, name: personName(id, members, guests), photo: members.find((member) => member.uid === id)?.avatar })), { max: 3, size: 24 });
  }

  function legLines(res) {
    if (!isTransport(res.type) || !res.legs?.length) return null;
    const zone = showZones(res);
    return el('ol.res-legs-summary', {}, res.legs.map((leg, index) => el('li', {},
      el('span.res-leg-route', {}, legRoute(leg)), ' ', el('span.res-leg-time', {}, legTimes(leg, { zone })),
      ...legDetails(leg, res.type).map((part) => el('span.res-leg-detail', {}, part)), flightStatus.chip(res, index))));
  }

  function row(res) {
    const files = attachedFiles(list('file'), res.id).length;
    const more = el('button.icon-btn', { type: 'button', title: t('bookings.actions', { name: res.title }), 'aria-label': t('bookings.actions', { name: res.title }),
      dataset: { focus: `${res.id}:more` }, onclick: () => moreMenu(res, more) }, icon('more'));
    const when = whenText(res);
    const where = !isTransport(res.type) ? res.location?.name : null;
    return el(`li.res-row${res.status === 'cancelled' ? '.is-cancelled' : ''}`, { dataset: { res: res.id } },
      el(`span.res-icon.${isTransport(res.type) ? 'transport' : 'booking'}`, { title: typeLabel(res.type) }, icon(res.type, 20)),
      el('div.res-main', {},
        el('div.res-title-line', {},
          el('button.res-open', { type: 'button', dataset: { focus: `${res.id}:open` }, onclick: () => details(res.id) }, res.title),
          el('span.sr-only', {}, `, ${typeLabel(res.type)}`),
          chip(statusLabel(res.status), { status: STATUS_CHIP[res.status] }),
          res.review && chip(t('bookings.needsReview'), { status: 'warn' })),
        (when || where) && el('p.res-meta', {}, [when, where].filter(Boolean).join(' · ')),
        legLines(res),
        el('div.res-extra', {}, codeNode(res), files ? el('span.res-files-count', {}, icon('attach', 14), files === 1 ? t('bookings.attachmentsOne') : t('bookings.attachmentsMany', { count: files })) : null)),
      el('div.res-side', {}, travelers(res), more));
  }

  // Views

  function renderList(items) {
    const groups = groupByStatus(items);
    return ['pending', 'confirmed', 'cancelled'].filter((status) => groups[status].length).map((status) => {
      const id = uid('bookings-group');
      return el('section.bookings-group', { 'aria-labelledby': id },
        el('h3.bookings-group-title', { id }, t('bookings.groupCount', { label: statusLabel(status), count: groups[status].length })),
        el('ul.card.res-list', {}, groups[status].map(row)));
    });
  }

  function entryRow(entry) {
    const res = entry.res;
    const leg = entry.leg !== null ? res.legs?.[entry.leg] : null;
    const zone = showZones(res);
    const time = entry.time ? [formatTime(entry.time), zone && pointZoneLabel({ date: entry.date ?? res.start?.date, time: entry.time, tz: entry.tz })].filter(Boolean).join(' ') : '';
    const end = entry.endTime ? [formatTime(entry.endTime), zone && entry.endTz && pointZoneLabel({ date: leg?.arr?.date ?? res.end?.date ?? entry.date, time: entry.endTime, tz: entry.endTz })].filter(Boolean).join(' ') : '';
    return el('li.res-entry', {},
      el('span.res-entry-time', {}, [time, end].filter(Boolean).join(' – ')),
      el(`span.res-icon.small.${isTransport(res.type) ? 'transport' : 'booking'}`, { title: typeLabel(res.type) }, icon(res.type, 16)),
      el('div.res-main', {},
        el('div.res-title-line', {}, el('button.res-open', { type: 'button', dataset: { focus: `${entry.key}:open` }, onclick: () => details(res.id) }, res.title),
          entry.name !== 'single' && el('span.res-phase', {}, phaseLabel(entry.name)),
          res.status === 'pending' && chip(statusLabel('pending'), { status: 'warn' })),
        leg && el('p.res-meta', {}, [legRoute(leg), ...legDetails(leg, res.type)].join(' · ')), leg && flightStatus.chip(res, entry.leg)));
  }

  function renderDays(items) {
    const days = list('day');
    const byDay = entriesByDay(items, days);
    const sections = days.map((day, index) => {
      const id = uid('bookings-day');
      const entries = byDay.get(day.id) ?? [];
      return el('section.bookings-group', { 'aria-labelledby': id },
        el('h3.bookings-group-title', { id }, isDate(day.date) ? formatDate(day.date, { weekday: true }) : t('bookings.dayN', { n: index + 1 }), day.title ? ` · ${day.title}` : ''),
        entries.length ? el('ul.card.res-list', {}, entries.map(entryRow)) : el('p.bookings-empty-day', {}, t('bookings.nothingBooked')));
    });
    const loose = unplaced(items.filter((res) => res.status !== 'cancelled'), days);
    if (loose.length) {
      const id = uid('bookings-day');
      sections.push(el('section.bookings-group', { 'aria-labelledby': id }, el('h3.bookings-group-title', { id }, t('bookings.unplaced')),
        el('p.bookings-hint', {}, t('bookings.unplacedHint')), el('ul.card.res-list', {}, loose.map(row))));
    }
    return sections;
  }

  function render() {
    queued = false;
    if (signal.aborted) return;
    const focusKey = root.contains(document.activeElement) ? document.activeElement.closest('[data-focus]')?.dataset.focus : null;
    addButton.hidden = !canEdit();
    importer.refresh();
    paintNotes();
    const all = list('res');
    const state = space.state ?? {};
    if (!all.length && !state.rev && ['idle', 'syncing'].includes(state.sync)) {
      body.replaceChildren(el('div.bookings-loading', { 'aria-label': t('bookings.loading') }, skeleton(), skeleton('70%'), skeleton('85%')));
      filterBar.hidden = true;
      return;
    }
    if (!all.length) {
      filterBar.hidden = true;
      body.replaceChildren(emptyState({ title: t('bookings.empty'), body: canEdit() ? t('bookings.emptyBody') : t('bookings.emptyViewer'), icon: 'plane',
        action: canEdit() ? button(t('bookings.add'), { icon: 'plus', variant: 'primary', onclick: () => addButton.click() }) : null }));
      return;
    }
    filterBar.hidden = false;
    const items = filterRes(all, filters);
    if (!items.length) {
      body.replaceChildren(el('div.bookings-nomatch', {}, el('p', {}, t('bookings.noMatch')),
        button(t('bookings.clearFilters'), { size: 'sm', variant: 'outline', dataset: { focus: 'clear' }, onclick: () => {
          Object.assign(filters, { group: 'all', type: '', traveler: '' }); group.setValue('all'); paintFilters(); render(); group.element.querySelector('button')?.focus();
        } })));
    } else body.replaceChildren(...(filters.mode === 'days' ? renderDays(items) : renderList(items)));
    if (focusKey) [...root.querySelectorAll('[data-focus]')].find((node) => node.dataset.focus === focusKey)?.focus();
  }
  const schedule = () => { if (!queued) { queued = true; queueMicrotask(render); } };

  // Details

  function details(id) {
    const res = space.get('res', id);
    if (!res) return;
    const content = el('div.res-details');
    let dialog;
    const paint = () => {
      const current = space.get('res', id);
      if (!current) { dialog?.close('gone'); return; }
      const focusKey = content.contains(document.activeElement) ? document.activeElement.closest('[data-focus]')?.dataset.focus : null;
      content.replaceChildren(...detailBody(current));
      if (focusKey) [...content.querySelectorAll('[data-focus]')].find((node) => node.dataset.focus === focusKey)?.focus();
    };
    const actions = [button(t('ui.close'), { onclick: () => dialog.close('close') })];
    if (canEdit()) {
      actions.unshift(button(t('bookings.delete'), { variant: 'danger', onclick: () => { const current = space.get('res', id); dialog.close('delete'); if (current) remove(current); } }));
      actions.push(button(t('bookings.edit'), { variant: 'primary', icon: 'pencil', onclick: () => { const current = space.get('res', id); dialog.close('edit'); if (current) edit(current); } }));
    }
    paint();
    dialog = track(openModal({ title: res.title, content, actions, wide: true }));
    const off = space.subscribe({ type: 'res', id }, paint);
    painters.add(paint);
    void dialog.closed.then(() => { off(); painters.delete(paint); });
  }

  function detailBody(res) {
    const members = space.members();
    const guests = list('guest');
    const rows = [];
    const add = (label, ...value) => { if (value.some((item) => item !== null && item !== undefined && item !== '')) rows.push(el('dt', {}, label), el('dd', {}, ...value)); };
    add(t('bookings.field.type'), typeLabel(res.type));
    add(t('bookings.field.status'), chip(statusLabel(res.status), { status: STATUS_CHIP[res.status] }), res.review ? chip(t('bookings.needsReview'), { status: 'warn' }) : null);
    add(t('bookings.field.code'), codeNode(res), res.code ? copyButton(res.code) : null);
    if (isTransport(res.type) && res.legs?.length) add(t('bookings.route'), legLines(res));
    else {
      add(t('bookings.when'), whenText(res));
      if (res.type === 'lodging' && res.stay) {
        const times = [res.stay.checkInFrom && `${t('bookings.checkInFrom')} ${formatTime(res.stay.checkInFrom)}`, res.stay.checkInUntil && `${t('bookings.checkInUntil')} ${formatTime(res.stay.checkInUntil)}`,
          res.stay.checkOut && `${t('bookings.checkOutBy')} ${formatTime(res.stay.checkOut)}`].filter(Boolean).join(' · ');
        add(t('bookings.field.stay'), times);
      }
      add(t('bookings.location'), [res.location?.name, res.location?.address && res.location.address !== res.location.name ? res.location.address : ''].filter(Boolean).join(' · '));
    }
    add(t('flightStatus.title'), flightStatus.details(res));
    if (res.placeId) add(t('bookings.place'), space.get('place', res.placeId)?.name ?? '');
    if (res.stayId) add(t('bookings.stayLink'), space.get('res', res.stayId)?.title ?? '');
    add(t('bookings.people'), res.people?.length ? res.people.map((who) => personName(who, members, guests)).join(', ') : '');
    const href = safeURL(res.url);
    if (href) add(t('bookings.url'), el('a.res-link', { href, target: '_blank', rel: 'noopener noreferrer' }, icon('external', 14), t('bookings.openLink', { host: new URL(href).host })));
    if (res.notes) add(t('bookings.notes'), markdown(res.notes));
    const files = attachedFiles(list('file'), res.id);
    add(t('bookings.files'), files.length ? el('ul.res-file-list', {}, files.map((file) => el('li.res-file', {}, icon('attach', 14), el('span', {}, file.name)))) : '');
    const exps = linkedExpenses(list('exp'), res.id);
    add(t('bookings.expenses'), exps.length ? el('ul.res-file-list', {}, exps.map((exp) => el('li', {}, `${exp.name} · ${formatMoney(exp.amount, exp.currency)}`))) : '');
    if (!isTransport(res.type) && res.start?.tz && showZones(res)) add(t('bookings.timeZone'), `${res.start.tz} (${pointZoneLabel(res.start)})`);
    return [el('p.res-details-type', {}, icon(res.type, 18), typeLabel(res.type), res.start?.date ? ` · ${pointText(res.start)}` : ''), el('dl.res-dl', {}, rows)];
  }

  function copyButton(text) {
    return button(t('bookings.copyCode'), { size: 'sm', variant: 'ghost', onclick: async () => {
      try { await navigator.clipboard.writeText(text); toast(t('bookings.copied')); } catch { toast(t('bookings.copyFailed')); }
    } });
  }

  paintFilters();
  render();
  cleanups.push(space.subscribe((event) => {
    if (WATCHED.some((type) => event.types?.has(type))) {
      if (event.types.has('member') || event.types.has('guest')) paintFilters();
      schedule();
    }
  }));
  // The sync status changes on every poll; only what the tab shows (notes, loading, conflicts, role) repaints.
  const stateKey = () => {
    const { sync, rev, conflicts } = space.state ?? {};
    return `${['offline', 'credit', 'forbidden'].includes(sync) || !rev ? sync : ''}|${conflicts}|${space.role}`;
  };
  let shownState = stateKey();
  if (space.onState) cleanups.push(space.onState(() => { const key = stateKey(); if (key !== shownState) { shownState = key; schedule(); } }));
  cleanups.push(onPrefs(() => { schedule(); for (const paint of painters) paint(); }));
  signal?.addEventListener('abort', () => destroy(), { once: true });

  function destroy() {
    moves.destroy();
    for (const off of cleanups.splice(0)) off();
    for (const dialog of [...dialogs]) dialog.close('navigation');
    dialogs.clear();
  }
  return destroy;
}
