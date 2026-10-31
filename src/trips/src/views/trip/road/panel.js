import { el, uid } from '../../../ui/dom.js';
import { button, chip, emptyState } from '../../../ui/bits.js';
import { openMenu } from '../../../ui/menu.js';
import { openModal, confirmDialog } from '../../../ui/modal.js';
import { toast } from '../../../ui/toast.js';
import { makeDragSource, makeDropZone } from '../../../ui/dnd.js';
import { t } from '../../../lib/i18n/index.js';
import { formatDate, formatDistance, formatDuration, formatMoney, formatNumber, formatTime } from '../../../lib/format.js';
import { minutesTime } from '../../../shared/dates.js';
import { fuelEstimate, pointAt, rangeKnown, splitTime } from '../../../lib/road/index.js';
import { ALTERNATIVES } from './state.js';
import { createSearch } from './search.js';
import { openRoadSettings } from './settings.js';
import { proposeFuelExpense } from './costs.js';
import { icon, NODE_ICONS, TRANSPORT_ICONS } from './icons.js';
import { lodgingButton } from './lodging/index.js';

const LEVEL_KEY = { green: 'road.hazard.level.green', orange: 'road.hazard.level.orange', red: 'road.hazard.level.red' };
const SERVICE_ICON = { fuel: 'fuel', charge: 'charge', rest: 'rest' };
const quoted = (value) => String(value).replace(/["\\]/g, '\\$&');
const iconButton = (name, label, attrs = {}) => el('button.icon-btn.icon-btn-sm', { type: 'button', title: label, 'aria-label': label, ...attrs }, icon(name, 16));
const alternativeOf = (prefs, dayId) => {
  if (!Object.hasOwn(prefs.dayAvoid, dayId)) return 'default';
  const list = prefs.dayAvoid[dayId];
  return Object.entries(ALTERNATIVES).find(([, value]) => value.length === list.length && value.every((item) => list.includes(item)))?.[0] ?? 'custom';
};

/**
 * The road-trip view: the trip as one chain of stops and drives with times, limits, night pauses, range bands, flags,
 * hazards and the search along the route. `state` is `roadState()`, `ops` is `createRoadOps()`.
 */
export function mountRoadPanel(container, { space, session, plan, state, ops, lang, account, signal }) {
  const live = el('div.sr-only', { role: 'status', 'aria-live': 'polite' });
  const announce = (message) => { live.textContent = ''; live.textContent = message; };
  const head = el('header.road-head');
  const summary = el('div.road-summary');
  const banners = el('div.road-banners');
  const hazardsBox = el('div.road-hazards-host');
  const searchBox = el('details.road-search-box', { open: false });
  const list = el('div.road-days');
  const credits = el('p.field-hint.road-credits');
  const root = el('div.road', {}, head, summary, banners, hazardsBox, searchBox, list, credits, live);
  container.replaceChildren(root);
  const hintId = uid('road-hint');
  root.append(el('span.sr-only', { id: hintId }, t('road.reorderHint')));

  let frame = 0; let destroyed = false; let pendingFocus = null; let view = null;
  const zones = [];
  const search = createSearch({ state, ops, getView: () => view ?? state.view(), announce, lang, services: session?.services, onLocate: (point) => locatePoint(point) });
  searchBox.append(el('summary', {}, icon('find', 16), t('road.search.title')), search.element);

  const fail = () => toast(t('road.saveFailed'));
  const guard = (promise) => Promise.resolve(promise).catch(fail);
  const dayDate = (index) => view?.days[index]?.date ?? null;
  const dayText = (index) => {
    const date = dayDate(index);
    return date ? formatDate(date, { weekday: true, year: false }) : t('plan.dayNumber', { number: index + 1 });
  };
  /** A trip time as a wall time, with the day when it is not `dayIndex`. */
  function timeText(value, dayIndex) {
    if (!Number.isFinite(value)) return '';
    const { day, minutes } = splitTime(value);
    const time = formatTime(minutesTime(minutes));
    return day === dayIndex ? time : t('road.timeOnDay', { time, day: dayText(day) });
  }
  const duration = (minutes) => formatDuration(Math.max(0, Math.round(minutes)));
  const distance = (meters) => formatDistance(meters);
  // The plan tab shows the map pane on phones for any `locate`; the overlay flies to the selection.
  function locatePoint(point) { state.select({ kind: 'point', point }); plan.emit('locate', { t: 'road', id: 'point' }); }
  const locateNode = (node) => {
    if (node.kind === 'visit') plan.emit('locate', { t: 'visit', id: node.id });
    else locatePoint(node.point);
  };

  // Drag a visit by its grip (or Alt+Arrow) to reorder the chain; it lands on the day it is dropped in.
  const source = makeDragSource(list, {
    itemSelector: '.road-node[data-movable]', handle: '[data-drag-handle]', longPress: true,
    data: (item) => (state.canEdit() ? { t: 'road', key: item.dataset.key } : null),
    onKey: ({ data, delta }) => keyMove(data.key, delta),
  });
  function nodeByKey(key) { return view?.chain.nodes.find((node) => node.key === key) ?? null; }
  async function dropOn(dayIndex, data, index) {
    const node = nodeByKey(data.key);
    const day = view?.days[dayIndex];
    if (!node || !day) return;
    const others = view.chain.nodes.filter((item) => item.day === dayIndex && item.key !== node.key);
    pendingFocus = `grip:${node.key}`;
    await guard(ops.moveNode(node, day.id, index >= 0 ? others[index] ?? null : null));
    announce(t('road.moved', { name: node.name, day: dayText(dayIndex) }));
  }
  function keyMove(key, delta) {
    const node = nodeByKey(key);
    if (!node || !state.canEdit()) return;
    // Stays always open or close their day, so moving past one moves to the next day.
    const sameDay = view.chain.nodes.filter((item) => item.day === node.day && item.kind !== 'stay');
    const at = sameDay.indexOf(node);
    pendingFocus = `grip:${node.key}`;
    if (delta < 0 && at > 0) { void guard(ops.moveNode(node, node.dayId, sameDay[at - 1])); return; }
    if (delta > 0 && at < sameDay.length - 1) { void guard(ops.moveNode(node, node.dayId, sameDay[at + 2] ?? null)); return; }
    const target = view.days[node.day + delta];
    if (!target) return;
    const targetNodes = view.chain.nodes.filter((item) => item.day === node.day + delta && item.kind !== 'stay');
    void guard(ops.moveNode(node, target.id, delta > 0 ? targetNodes[0] ?? null : null));
    announce(t('road.moved', { name: node.name, day: dayText(node.day + delta) }));
  }

  function renderHead() {
    const more = iconButton('more', t('road.more'), { dataset: { focus: 'more' }, onclick: (event) => openMenu(event.currentTarget, [
      { label: t('road.settings.title'), onSelect: openSettings },
      { label: t('road.costs.propose'), icon: 'wallet', onSelect: () => proposeCost() },
      { label: t('road.hazard.refresh'), onSelect: () => state.refreshHazards({ force: true }) },
      ...(state.canTrip() ? [{ separator: true }, { label: t('road.mode.off'), danger: true, onSelect: turnOff }] : []),
    ]) });
    head.replaceChildren(el('h2.road-title', {}, icon('car', 18), t('road.title')),
      el('div.road-tools', {}, iconButton('settings', t('road.settings.title'), { onclick: openSettings, dataset: { focus: 'settings' } }), more));
  }
  const openSettings = () => openRoadSettings({ space, ops, tripCurrency: space.get('meta', 'meta')?.currency, onSaved: () => announce(t('road.settings.saved')) });
  async function turnOff() {
    if (!(await confirmDialog({ title: t('road.mode.offTitle'), body: t('road.mode.offBody'), confirmLabel: t('road.mode.off') }))) return;
    await guard(ops.setMode(false));
  }
  function proposeCost() {
    if (!view) return;
    void proposeFuelExpense({ space, session, account, view, openSettings, signal });
  }

  function renderSummary() {
    const { schedule, prefs, fuel } = view;
    const totals = schedule.totals;
    const parts = [distance(totals.distance), t('road.summary.drive', { duration: duration(totals.drive) }), t('road.summary.stops', { count: totals.stops }), t('road.summary.days', { count: totals.days })];
    const estimate = fuelEstimate({ meters: totals.distance, prefs, currency: prefs.currency });
    summary.replaceChildren(
      el('p.road-totals', {}, parts.join(' · '), totals.estimated && el('span.chip.chip-warn', { title: t('road.approxHint') }, t('road.approx'))),
      el('p.road-subtotals', {},
        el('span', {}, icon(prefs.fuel === 'electric' ? 'charge' : 'fuel', 14), rangeKnown(prefs) ? t('road.summary.range', { range: distance(fuel.range * 1000) }) : t('road.summary.rangeDefault', { range: distance(fuel.range * 1000) })),
        estimate && el('span', {}, icon('cost', 14), estimate.amount !== null
          ? t('road.summary.cost', { amount: formatMoney(estimate.amount, estimate.currency), units: formatNumber(estimate.units, { digits: 0 }), unit: t(`road.unit.${estimate.unit}`) })
          : t('road.summary.units', { units: formatNumber(estimate.units, { digits: 0 }), unit: t(`road.unit.${estimate.unit}`) }))),
    );
  }

  function renderBanners() {
    const nodes = [];
    if (!state.canEdit()) nodes.push(el('p.plan-note', {}, icon('users', 15), t('road.viewOnly')));
    if (globalThis.navigator?.onLine === false) nodes.push(el('div.plan-banner', { role: 'status' }, icon('offline', 16), el('span', {}, t('road.offline'))));
    else if (view.schedule.totals.estimated) nodes.push(el('div.plan-banner', { role: 'status' }, icon('route', 16), el('span', {}, t('road.approxHint'))));
    if (view.chain.unlocated.length) nodes.push(el('div.plan-banner', {}, icon('stop', 16), el('span', {}, t('road.unlocated', { count: view.chain.unlocated.length }))));
    if (view.staleEnds.length && state.canEdit()) {
      nodes.push(el('div.plan-banner', {}, icon('night', 16), el('span', {}, t('road.staleEnds', { count: view.staleEnds.length })),
        button(t('road.staleRemove'), { size: 'sm', onclick: () => guard(Promise.all(view.staleEnds.map((end) => ops.removeEntity('dayEnd', end.id)))) })));
    }
    for (const item of view.offTrack) nodes.push(el('div.plan-banner.plan-banner-warn', {}, icon('track', 16), el('span', {}, t('road.offTrack', { name: nodeByKey(item.node)?.name ?? '', distance: distance(item.km * 1000) }))));
    const { flags } = view;
    const known = [];
    if (flags.toll.length) known.push(t('road.flags.toll', { count: flags.toll.length }));
    if (flags.ferry.length) known.push(t('road.flags.ferry', { count: flags.ferry.length }));
    if (known.length) nodes.push(el('div.plan-banner', {}, icon('alternatives', 16), el('span', {}, `${known.join(' · ')}${flags.unknown ? ` ${t('road.flags.partial')}` : ''}`)));
    const warnings = view.schedule.warnings.filter((item) => ['late', 'missed', 'behind', 'checkin'].includes(item.code));
    if (warnings.length) nodes.push(el('div.plan-banner.plan-banner-warn', { role: 'alert' }, icon('alert', 16), el('span', {}, t('road.warnings', { count: warnings.length }))));
    banners.replaceChildren(...nodes);
  }

  function renderHazards() {
    const status = state.hazards;
    const near = view.hazards;
    const items = near.map(({ event, leg, distance: off }) => {
      const legInfo = view.chain.legs.find((item) => item.key === leg);
      const from = legInfo ? view.chain.nodes[legInfo.from].name : '';
      const title = event.source === 'dwd' ? event.headline || event.name : event.name || t(`road.hazard.type.${event.type}`);
      return el('li.road-hazard', { dataset: { level: event.level } },
        el('span.road-hazard-icon', { 'aria-hidden': 'true' }, icon(event.type, 16)),
        el('div', {}, el('span.road-hazard-title', {}, title),
          el('span.road-hazard-meta', {}, [t(LEVEL_KEY[event.level]), off > 0 ? t('road.hazard.off', { distance: distance(off), name: from }) : t('road.hazard.on', { name: from }),
            event.to ? t('road.hazard.until', { date: formatDate(new Date(event.to).toISOString().slice(0, 10), { year: false }) }) : ''].filter(Boolean).join(' · '))),
        event.url && el('a.plan-link', { href: event.url, target: '_blank', rel: 'noopener noreferrer' }, t('road.hazard.details', { host: new URL(event.url).host })));
    });
    let note = '';
    if (status.status === 'loading') note = t('road.hazard.loading');
    else if (status.status === 'offline') note = t('road.hazard.offline');
    else if (status.status === 'error') note = t('road.hazard.error');
    else if (status.status === 'ready' && !near.length) note = t('road.hazard.none');
    hazardsBox.replaceChildren(el('section.road-hazards', { 'aria-label': t('road.hazard.title') },
      el('h3.road-section-title', {}, icon('hazards', 16), t('road.hazard.title'), near.length ? chip(String(near.length), { status: near.some((item) => item.event.level === 'red') ? 'warn' : '' }) : null),
      note && el('p.field-hint', { role: 'status' }, note),
      items.length ? el('ul.road-hazard-list', {}, items) : null,
      status.attribution?.length ? el('p.field-hint.road-credits', {}, t('road.hazard.credit', { sources: status.attribution.map((item) => item.text).join(', ') })) : null));
  }

  function nodeMenu(anchor, node, dayIndex) {
    const canEdit = state.canEdit();
    const items = [{ label: t('road.showOnMap'), icon: 'map', onSelect: () => locateNode(node) }];
    if (canEdit && node.kind === 'visit') {
      items.push({ label: t('road.stay.edit'), icon: 'clock', onSelect: () => editStay(node) });
      const rows = view.chain.nodes.filter((item) => item.day === node.day);
      const later = rows.slice(rows.indexOf(node) + 1).some((item) => item.kind === 'visit');
      if (later) items.push({ label: t('road.endDay'), disabled: !view.days[dayIndex + 1], onSelect: () => endDay(node) });
      if (node.place) {
        items.push({ separator: true });
        for (const type of ['fuel', 'charge', 'rest']) items.push({ label: t(`road.service.${type}`), checked: node.service === type, onSelect: (on) => guard(ops.setService(node.place, on ? type : null)) });
        if (node.service === 'fuel' || node.service === 'charge') items.push({ label: t('road.service.fill'), onSelect: () => editFill(node) });
      }
    }
    if (node.kind === 'visit' && node.place) items.push({ label: t('road.openPlace'), icon: 'pin', onSelect: () => plan.emit('openPlace', { id: node.place.id }) });
    openMenu(anchor, items);
  }
  async function endDay(node) {
    try {
      const moved = await ops.endDayHere(view, node);
      if (moved) toast(t('road.endDayDone', { count: moved }), { action: { label: t('plan.undo'), onClick: () => { void space.history.undo().catch(fail); } } });
    } catch { fail(); }
  }
  function numberDialog({ title, label, value, min, max, hint, onSave, allowEmpty = true }) {
    const id = uid('road-number');
    const input = el('input.input.num', { id, type: 'number', min: String(min), max: String(max), step: '1', value: value ?? '', inputMode: 'numeric' });
    const error = el('p.field-error', { role: 'alert', hidden: true });
    const save = async () => {
      const raw = input.value.trim();
      const number = raw === '' ? null : Number(raw);
      if ((number === null && !allowEmpty) || (number !== null && (!Number.isInteger(number) || number < min || number > max))) {
        error.hidden = false; error.textContent = t('road.settings.range', { min, max }); return;
      }
      try { await onSave(number); dialog.close('saved'); } catch { fail(); }
    };
    const form = el('form', { onsubmit: (event) => { event.preventDefault(); void save(); } },
      el('div.field', {}, el('label.field-label', { htmlFor: id }, label), input, hint && el('span.field-hint', {}, hint)), error);
    const dialog = openModal({ title, content: form, initialFocus: input, actions: [button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }), button(t('ui.save'), { variant: 'primary', onclick: save })] });
  }
  function editStay(node) {
    numberDialog({ title: t('road.stay.title', { name: node.name }), label: t('road.stay.label'), value: node.entity.dwell, min: 0, max: 10080, hint: t('road.stay.hint', { duration: duration(node.dwell) }),
      onSave: (minutes) => ops.setDwell(node.entity, minutes) });
  }
  function editFill(node) {
    numberDialog({ title: t('road.service.fillTitle', { name: node.name }), label: t('road.service.fillLabel'), value: node.fill === null ? null : Math.round(node.fill * 100), min: 10, max: 100,
      hint: t('road.service.fillHint', { percent: view.prefs.fill }), onSave: (percent) => ops.setService(node.place, node.service, percent === null ? null : percent / 100) });
  }

  function nodeRow(node, dayIndex) {
    const stop = view.schedule.stops.get(node.key);
    const canMove = state.canEdit() && node.kind === 'visit' && node.entity.endDayId == null;
    const warnings = view.schedule.warnings.filter((item) => item.node === node.key);
    const meta = [];
    if (stop) {
      if (node.kind === 'stay' && node.leaveDay > node.day) meta.push(t('road.arriveNight', { time: timeText(stop.arrive, dayIndex), count: Math.max(1, node.nights) }));
      else if (node.kind === 'stay') meta.push(t('road.leave', { time: timeText(stop.depart, dayIndex) }));
      else if (node.kind === 'depart') meta.push(t('road.departs', { time: timeText(stop.start + node.buffer, dayIndex), buffer: duration(node.buffer) }));
      else if (stop.depart - stop.arrive >= 1) meta.push(t('road.range', { start: timeText(stop.start, dayIndex), end: timeText(stop.depart, dayIndex) }));
      else meta.push(timeText(stop.arrive, dayIndex));
      if (node.kind === 'visit' && node.dwell) meta.push(t('road.stay.here', { duration: duration(node.dwell) }));
      if (stop.leaveBy) meta.push(t('road.leaveBy', { time: timeText(stop.leaveBy, dayIndex) }));
      if (stop.wait >= 15 && !stop.leaveBy) meta.push(t('road.wait', { duration: duration(stop.wait) }));
    }
    if (node.pinned || (node.fixed !== null && node.kind === 'visit')) meta.push(t('road.fixed', { time: formatTime(minutesTime(node.fixed)) }));
    const serviceIcon = SERVICE_ICON[node.service];
    return el('li.road-node', { dataset: { key: node.key, kind: node.kind, ...(canMove ? { movable: '' } : {}), ...(node.service ? { service: node.service } : {}) } },
      canMove ? el('button.plan-grip', { type: 'button', dataset: { dragHandle: '', focus: `grip:${node.key}` }, 'aria-label': t('road.reorder', { name: node.name }), 'aria-describedby': hintId }, icon('grip', 16)) : el('span.plan-grip-space', { 'aria-hidden': 'true' }),
      el('span.road-node-icon', { 'aria-hidden': 'true' }, icon(serviceIcon ?? (node.kind === 'depart' || node.kind === 'arrive' ? TRANSPORT_ICONS[node.entity.type] ?? 'route' : NODE_ICONS[node.kind]), 15)),
      el('div.road-node-body', {},
        el('button.road-node-main', { type: 'button', dataset: { focus: `node:${node.key}` }, onclick: () => { if (node.kind === 'visit') plan.set({ day: node.dayId, visit: node.id, place: node.place?.id ?? null }); locateNode(node); } },
          el('span.road-node-title', {}, node.name || t('road.untitled')),
          el('span.road-node-meta', {}, meta.join(' · '))),
        warnings.map((warning) => el('p.road-warn', {}, icon('alert', 14), warningText(warning)))),
      iconButton('more', t('road.nodeActions', { name: node.name }), { dataset: { focus: `more:${node.key}` }, onclick: (event) => nodeMenu(event.currentTarget, node, dayIndex) }));
  }
  function warningText(warning) {
    if (warning.code === 'behind') return t('road.warn.behind', { count: warning.days });
    if (warning.code === 'checkin') return t('road.warn.checkin', { duration: duration(warning.minutes) });
    if (warning.code === 'missed') return t('road.warn.missed', { duration: duration(warning.minutes) });
    return t('road.warn.late', { duration: duration(warning.minutes) });
  }

  function nightText(night, leg, info) {
    const along = distance(info.meters * night.at);
    const key = night.source === 'manual' ? 'road.night.manual' : night.source === 'plan' ? 'road.night.plan' : night.source === 'daily' ? 'road.night.daily' : 'road.night.window';
    const where = night.at <= 0.001 ? t('road.night.atStart', { name: view.chain.nodes[leg.from].name }) : night.at >= 0.999 ? t('road.night.atEnd', { name: view.chain.nodes[leg.to].name }) : t('road.night.along', { distance: along });
    return t(key, { where, count: night.count, time: timeText(night.resume, splitTime(night.resume).day) });
  }
  function moveNight(leg, night, info) {
    const existing = (view.dayEnds.get(leg.key) ?? [])[0]?.id ?? null;
    const id = uid('road-night');
    const total = info.meters;
    const value = Math.round(night.at * 100);
    const output = el('output.road-night-output', { htmlFor: id }, distance(total * night.at));
    const input = el('input.road-range', { id, type: 'range', min: '0', max: '100', step: '1', value: String(value),
      oninput: () => { output.textContent = distance(total * Number(input.value) / 100); } });
    const save = async () => {
      try { await ops.placeNight(view.chain, leg, Number(input.value) / 100, existing); dialog.close('saved'); announce(t('road.night.moved')); } catch { fail(); }
    };
    const reset = existing ? button(t('road.night.reset'), { variant: 'ghost', onclick: async () => { try { await ops.removeEntity('dayEnd', existing); dialog.close('reset'); } catch { fail(); } } }) : null;
    const dialog = openModal({
      title: t('road.night.moveTitle'), initialFocus: input,
      content: el('div.field', {}, el('label.field-label', { htmlFor: id }, t('road.night.moveLabel', { from: view.chain.nodes[leg.from].name, to: view.chain.nodes[leg.to].name })), input, output, el('p.field-hint', {}, t('road.night.moveHint'))),
      actions: [reset, button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }), button(t('ui.save'), { variant: 'primary', onclick: save })].filter(Boolean),
    });
  }

  function legRow(leg) {
    const info = view.info.get(leg.key);
    const drive = view.schedule.drives.get(leg.key);
    const canEdit = state.canEdit();
    if (!info || leg.kind === 'none') return null;
    const from = view.chain.nodes[leg.from]; const to = view.chain.nodes[leg.to];
    const lines = [];
    let label;
    if (leg.kind === 'transport') label = leg.estimate !== null ? t('road.leg.transportEstimate', { duration: duration(leg.estimate) }) : t('road.leg.transport', { name: leg.res.title });
    else label = t(info.estimated ? 'road.leg.estimated' : 'road.leg.routed', { duration: duration(info.minutes), distance: distance(info.meters) });
    const chips = [];
    if (info.flags?.toll) chips.push(chip(t('road.flag.toll'), { status: 'warn' }));
    if (info.flags?.ferry) chips.push(chip(t('road.flag.ferry')));
    if (info.track) chips.push(chip(t('road.flag.track')));
    if (leg.kind !== 'drive' && leg.kind !== 'transport') chips.push(chip(t(`plan.mode.${leg.kind}`)));
    for (const pause of drive?.breaks ?? []) lines.push(el('p.road-leg-line', {}, icon('pause', 14), t('road.break', { minutes: duration(pause.minutes), distance: distance(info.meters * pause.at), time: timeText(pause.start, splitTime(pause.start).day) }),
      el('button.plan-link', { type: 'button', onclick: () => search.open({ kind: 'point', point: pointAt(info.line, pause.at), label: t('road.search.nearBreak') }, { categories: ['rest', 'fuel', 'food'], search: true }) }, t('road.findRest'))));
    for (const night of drive?.nights ?? []) {
      const point = pointAt(info.line, night.at);
      lines.push(el('div.road-night', { dataset: { source: night.source } }, icon('night', 14), el('span', {}, nightText(night, leg, info)),
        el('div.road-night-actions', {},
          canEdit && leg.kind === 'drive' && el('button.plan-link', { type: 'button', onclick: () => moveNight(leg, night, info) }, t(night.source === 'manual' ? 'road.night.move' : 'road.night.place')),
          el('button.plan-link', { type: 'button', onclick: () => search.open({ kind: 'point', point, label: t('road.search.nearNight') }, { categories: ['lodging', 'camping'], search: true }) }, t('road.findLodging')),
          lodgingButton({ point, name: night.at >= 0.999 ? to.name : night.at <= 0.001 ? from.name : '', checkIn: dayDate(splitTime(night.resume).day - (night.count || 1)),
            checkOut: dayDate(splitTime(night.resume).day), adults: space.select.member.all().length + space.select.guest.all().length }))));
    }
    const bands = view.fuel.bands.filter((band) => band.start?.leg === leg.key);
    for (const band of bands) {
      lines.push(el('div.road-band', { role: 'note' }, icon(view.prefs.fuel === 'electric' ? 'charge' : 'fuel', 14),
        el('span', {}, band.end ? t('road.band.runsOut', { distance: distance((band.endKm - band.startKm) * 1000) }) : t('road.band.low', { distance: distance((band.endKm - band.startKm) * 1000) })),
        el('button.plan-link', { type: 'button', onclick: () => search.open({ kind: 'band', band, label: t('road.search.inBand') }, { categories: 'refill', search: true }) }, t(view.prefs.fuel === 'electric' ? 'road.findCharging' : 'road.findFuel'))));
    }
    for (const via of leg.vias) {
      lines.push(el('p.road-leg-line', {}, icon('via', 14), t('road.via'),
        canEdit && el('button.plan-link', { type: 'button', 'aria-label': t('road.viaRemove'), onclick: () => guard(ops.removeEntity('via', via.id)) }, t('road.remove'))));
    }
    const actions = leg.kind === 'drive' ? iconButton('more', t('road.legActions', { from: from.name, to: to.name }), { dataset: { focus: `leg:${leg.key}` }, onclick: (event) => openMenu(event.currentTarget, [
      { label: t('road.search.alongLeg'), icon: 'search', onSelect: () => search.open({ kind: 'leg', leg: leg.key, label: t('road.search.legLabel', { from: from.name, to: to.name }) }) },
      { label: t('road.showOnMap'), icon: 'map', onSelect: () => { state.select({ kind: 'leg', key: leg.key }); plan.emit('locate', { t: 'road', id: leg.key }); } },
      ...(canEdit && !drive?.nights.length ? [{ label: t('road.night.add'), onSelect: () => moveNight(leg, { at: 0.5 }, info) }] : []),
    ]) }) : null;
    return el('li.road-leg', { dataset: { leg: leg.key, kind: leg.kind } },
      el('span.road-leg-icon', { 'aria-hidden': 'true' }, icon(leg.kind === 'transport' ? TRANSPORT_ICONS[leg.res?.type] ?? 'route' : leg.kind === 'drive' ? 'car' : leg.kind, 14)),
      el('div.road-leg-body', {}, el('p.road-leg-head', {}, el('span', {}, label), ...chips), ...lines),
      actions);
  }

  function dayRouteButton(day, index) {
    const choice = alternativeOf(view.prefs, day.id);
    const canEdit = state.canEdit();
    const label = t(`road.alt.${choice}`);
    return el('button.road-route-choice', { type: 'button', disabled: !canEdit, 'aria-label': t('road.alt.label', { day: dayText(index), choice: label }), onclick: (event) => openMenu(event.currentTarget, [
      { label: t('road.alt.default'), checked: choice === 'default', onSelect: () => guard(ops.setDayRoute(day.id, null)) },
      ...Object.entries(ALTERNATIVES).map(([name, avoid]) => ({ label: t(`road.alt.${name}`), checked: choice === name, onSelect: () => guard(ops.setDayRoute(day.id, avoid)) })),
      { separator: true },
      { label: t('road.alt.compare'), onSelect: () => compareRoutes(day, index) },
      { label: t('road.track.choose'), onSelect: () => chooseTrack(day, index) },
    ]) }, icon('alternatives', 14), label);
  }
  async function compareRoutes(day, index) {
    const body = el('div.road-compare', { 'aria-live': 'polite' }, el('p.field-hint', {}, t('road.alt.comparing')));
    const controller = new AbortController();
    const dialog = openModal({ title: t('road.alt.compareTitle', { day: dayText(index) }), content: body, onClose: () => controller.abort() });
    try {
      const results = await state.compare(day.id, { signal: controller.signal });
      const current = alternativeOf(view.prefs, day.id);
      body.replaceChildren(el('ul.road-compare-list', {}, Object.entries(results).map(([name, value]) => el('li', {},
        el('span.road-compare-name', {}, t(`road.alt.${name}`)),
        el('span', {}, t(value.estimated ? 'road.leg.estimated' : 'road.leg.routed', { duration: duration(value.minutes), distance: distance(value.meters) })),
        value.flags ? el('span.field-hint', {}, [value.flags.toll && t('road.flag.toll'), value.flags.ferry && t('road.flag.ferry')].filter(Boolean).join(' · ')) : el('span.field-hint', {}, t('road.alt.noFlags')),
        state.canEdit() && button(current === name ? t('road.alt.chosen') : t('road.alt.choose'), { size: 'sm', disabled: current === name, onclick: async () => { await guard(ops.setDayRoute(day.id, ALTERNATIVES[name])); dialog.close('chosen'); } })))));
    } catch (error) { if (error?.name !== 'AbortError') body.replaceChildren(el('p.field-error', { role: 'alert' }, t('road.alt.failed'))); }
  }
  function chooseTrack(day, index) {
    const tracks = space.select.place.all().filter((place) => place.track?.fileId);
    const current = space.select.dayTrack.all().find((item) => item.dayId === day.id);
    if (!tracks.length) { toast(t('road.track.none')); return; }
    const id = uid('road-track');
    const select = el('select.select', { id }, el('option', { value: '' }, t('road.track.off')), tracks.map((place) => el('option', { value: place.id }, place.name)));
    select.value = current?.placeId ?? '';
    const stray = el('input.input.num', { type: 'number', min: '0', max: '1000', step: '1', value: String(current?.strayKm ?? 5), 'aria-label': t('road.track.stray') });
    const save = async () => {
      const km = Number(stray.value);
      if (!Number.isFinite(km) || km < 0 || km > 1000) { stray.setAttribute('aria-invalid', 'true'); return; }
      try { await ops.setDayTrack(day.id, select.value || null, km); dialog.close('saved'); } catch { fail(); }
    };
    const dialog = openModal({
      title: t('road.track.title', { day: dayText(index) }), initialFocus: select,
      content: el('div', {}, el('div.field', {}, el('label.field-label', { htmlFor: id }, t('road.track.label')), select),
        el('div.field', {}, el('label.field-label', {}, t('road.track.stray')), stray, el('span.field-hint', {}, t('road.track.strayHint')))),
      actions: [button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }), button(t('ui.save'), { variant: 'primary', disabled: !state.canEdit(), onclick: save })],
    });
  }

  function renderDays() {
    for (const zone of zones.splice(0)) zone.destroy();
    const { chain, schedule } = view;
    const legFrom = new Map(chain.legs.map((leg) => [leg.from, leg]));
    const sections = view.days.map((day, index) => {
      const stats = schedule.days.find((item) => item.index === index);
      const nodes = chain.nodes.filter((node) => node.day === index);
      const items = [];
      // A drive that starts at a stop of an earlier day (last night's stay, or where the night fell) opens this day.
      const morning = chain.legs.find((leg) => leg.dayIndex === index && chain.nodes[leg.from].day < index);
      if (morning) {
        const start = chain.nodes[morning.from];
        const resume = schedule.drives.get(morning.key)?.nights.find((night) => night.at <= 0.001)?.resume ?? schedule.stops.get(start.key)?.depart;
        items.push(el('li.road-node.road-node-start', { dataset: { kind: 'start' } }, el('span.plan-grip-space'), el('span.road-node-icon', { 'aria-hidden': 'true' }, icon(start.kind === 'stay' ? 'lodging' : 'night', 15)),
          el('div.road-node-body', {}, el('span.road-node-title', {}, start.name), el('span.road-node-meta', {}, t('road.leave', { time: timeText(resume, index) })))));
        const row = legRow(morning);
        if (row) items.push(row);
      }
      for (const node of nodes) {
        items.push(nodeRow(node, index));
        const leg = legFrom.get(chain.nodes.indexOf(node));
        if (leg && leg.dayIndex === node.day) { const row = legRow(leg); if (row) items.push(row); }
      }
      const ol = el('ol.road-items', { 'aria-label': t('road.dayItems', { day: dayText(index) }) }, items.length ? items : el('li.road-empty', {}, t('road.dayEmpty')));
      zones.push(makeDropZone(ol, { itemSelector: '.road-node:not(.road-node-start)', accepts: (data) => state.canEdit() && data?.t === 'road', onDrop: ({ data, index: at }) => dropOn(index, data, at) }));
      const statsText = stats?.drive ? t('road.day.drive', { duration: duration(stats.drive), distance: distance(stats.distance) }) : t('road.day.noDrive');
      return el('section.road-day', { dataset: { day: day.id }, style: { '--day-color': `var(--day-${((index % 8) + 1)})` } },
        el('header.road-day-head', {},
          el('h3.road-day-title', {}, el('span.plan-day-num', {}, t('plan.dayNumber', { number: index + 1 })), dayDate(index) && el('span.plan-day-date', {}, formatDate(dayDate(index), { weekday: true, year: false }))),
          el('p.road-day-stats', {}, statsText, stats?.overDaily && chip(t('road.day.overDaily'), { status: 'warn' }), stats?.overWindow && chip(t('road.day.overWindow'), { status: 'warn' })),
          dayRouteButton(day, index)),
        ol);
    });
    list.replaceChildren(...sections);
  }

  function renderCredits() {
    const list = [...view.attribution, ...(state.hazards.attribution ?? [])];
    credits.replaceChildren(...list.filter((item, i) => list.findIndex((other) => other.url === item.url) === i).map((item) => el('a.plan-link', { href: item.url, target: '_blank', rel: 'noopener noreferrer' }, item.text)));
  }

  function renderOff() {
    const canTrip = state.canTrip();
    root.replaceChildren(emptyState({
      icon: 'map', title: t('road.mode.title'), body: t(canTrip ? 'road.mode.body' : 'road.mode.viewer'),
      action: canTrip && button(t('road.mode.on'), { variant: 'primary', onclick: async () => { await guard(ops.setMode(true)); } }),
    }), live);
  }

  function render() {
    frame = 0;
    if (destroyed) return;
    if (document.body.classList.contains('dnd-active')) { frame = setTimeout(render, 150); return; }
    if (!state.enabled()) { renderOff(); return; }
    if (!root.contains(head)) root.replaceChildren(head, summary, banners, hazardsBox, searchBox, list, credits, live);
    const focused = root.contains(document.activeElement) ? document.activeElement.closest('[data-focus]')?.dataset.focus : null;
    const fresh = state.view();
    const changed = fresh !== view || !list.childElementCount;
    view = fresh;
    renderHead(); renderHazards();
    if (changed) { renderSummary(); renderBanners(); renderDays(); renderCredits(); }
    const want = pendingFocus ?? focused;
    if (want) {
      const target = root.querySelector(`[data-focus="${quoted(want)}"]`);
      if (target) { target.focus({ preventScroll: !pendingFocus }); pendingFocus = null; }
    }
  }
  const schedule = () => { if (!frame && !destroyed) frame = setTimeout(render, 0); };
  const offs = [state.subscribe(schedule), space.onState?.(schedule) ?? (() => {})];
  const onNetwork = () => schedule();
  window.addEventListener('online', onNetwork); window.addEventListener('offline', onNetwork);
  render();

  return {
    root, search,
    focusLeg(key) { root.querySelector(`.road-leg[data-leg="${quoted(key)}"]`)?.scrollIntoView?.({ block: 'nearest' }); },
    destroy() {
      destroyed = true;
      clearTimeout(frame);
      for (const off of offs) off();
      window.removeEventListener('online', onNetwork); window.removeEventListener('offline', onNetwork);
      source.destroy(); search.destroy();
      for (const zone of zones) zone.destroy();
    },
  };
}
