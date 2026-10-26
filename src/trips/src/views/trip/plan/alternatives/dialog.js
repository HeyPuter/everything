// The Plan B dialog for one day: the main plan, each alternative (editable), and a side-by-side comparison.
import { el, uid as uniqueId } from '../../../../ui/dom.js';
import { button, chip } from '../../../../ui/bits.js';
import { field } from '../../../../ui/fields.js';
import { confirmDialog, openModal, promptDialog } from '../../../../ui/modal.js';
import { tabs } from '../../../../ui/tabs.js';
import { toast } from '../../../../ui/toast.js';
import { t } from '../../../../lib/i18n/index.js';
import { formatDistance, formatDuration, formatTime } from '../../../../lib/format.js';
import { dayLabel } from '../forms.js';
import {
  addStopWrite, altStops, copyToMainWrite, createWrites, dayAlternatives, daysOf, mainStops, moveStopWrite, nextLetter, onlyIn,
  planStats, promoteWrites, removeWrites,
} from './model.js';
import { icon } from './icons.js';

const MAIN = 'main';
const COMPARE = 'compare';
const iconButton = (name, label, { className = 'icon-btn icon-btn-sm', ...attrs } = {}) => el('button', { type: 'button', className, title: label, 'aria-label': label, ...attrs }, icon(name, 16));
const clock = (value) => formatTime(value % 1440);

/** Re-renders, keeping focus and anything typed into the add-stop forms. */
function keepFocus(container, render) {
  const active = container.ownerDocument.activeElement;
  const key = active && container.contains(active) ? active.closest('[data-focus]')?.dataset.focus : null;
  const drafts = new Map([...container.querySelectorAll('.alt-add [data-focus]')].filter((node) => 'value' in node && node.value).map((node) => [node.dataset.focus, node.value]));
  render();
  const byKey = (value) => [...container.querySelectorAll('[data-focus]')].find((node) => node.dataset.focus === value);
  for (const [draft, value] of drafts) { const node = byKey(draft); if (node && !node.value) node.value = value; }
  const target = key ? byKey(key) : null;
  // A move to the top or bottom disables the button that did it; focus stays on the same stop.
  (target?.disabled ? target.closest('.alt-stop')?.querySelector('button:not([disabled])') : target)?.focus({ preventScroll: true });
}

/** Opens the plans of the timeline day `entry` (`{day, number, date}`). */
export function openAlternatives({ space }, entry) {
  const dayId = entry.day.id;
  let selected = MAIN;
  let compare = { left: MAIN, right: null };
  let frame = 0;
  const body = el('div.alt-dialog');
  const dialog = openModal({ title: t('alternatives.title', { day: dayLabel(entry) }), content: body, wide: true });

  const data = () => ({ alts: space.select.alt.all(), days: space.select.day.all(), visits: space.select.visit.all() });
  const canEdit = () => space.can('plan.edit');
  const placeOf = (id) => (id ? space.get('place', id) : null);
  const nameOf = (visit) => placeOf(visit.placeId)?.name ?? (visit.title?.trim() || t('alternatives.untitled'));
  const dayName = (id) => {
    const days = space.select.day.all();
    const index = days.findIndex((day) => day.id === id);
    return index === -1 ? '' : dayLabel({ day: days[index], number: index + 1, date: days[index].date ?? null });
  };

  async function apply(writes, key) {
    if (!writes.length) return true;
    const ops = writes.map((write) => (write.put ? space.ops.create(write.t, write.put, { id: write.id })
      : write.del ? space.ops.remove(write.t, write.id) : space.ops.patch(write.t, write.id, { set: write.set, unset: write.unset })));
    try {
      await space.apply(ops, { history: t(`alternatives.history.${key}`) });
      return true;
    } catch {
      toast(t('alternatives.saveFailed'));
      return false;
    }
  }

  function stopsFor(id, current = data()) {
    return id === MAIN ? mainStops(current.visits, dayId) : altStops(current.visits, id, dayId);
  }
  function planName(id, current = data()) {
    return id === MAIN ? t('alternatives.main') : current.alts.find((alt) => alt.id === id)?.name ?? '';
  }

  function stopTime(visit) {
    const start = formatTime(visit.start);
    const end = formatTime(visit.end);
    return start && end ? t('plan.timeRange', { start, end }) : start;
  }

  function mainPanel(current) {
    const stops = stopsFor(MAIN, current);
    const list = stops.length
      ? el('ol.alt-stops', {}, stops.map((visit) => el('li.alt-stop', {}, el('span.alt-stop-name', {}, nameOf(visit)), stopTime(visit) && el('span.alt-stop-time.num', {}, stopTime(visit)))))
      : el('p.alt-empty', {}, t('alternatives.mainEmpty'));
    const actions = canEdit() ? el('div.alt-actions', {},
      button(t('alternatives.newCopy'), { size: 'sm', dataset: { focus: 'new-copy' }, onclick: () => void create({ copy: true }) }),
      button(t('alternatives.newEmpty'), { size: 'sm', dataset: { focus: 'new-empty' }, onclick: () => void create({ copy: false }) }),
      button(t('alternatives.newTrip'), { size: 'sm', variant: 'ghost', dataset: { focus: 'new-trip' }, onclick: () => void create({ copy: true, whole: true }) })) : null;
    return el('div.alt-panel', {}, el('p.alt-intro', {}, t('alternatives.intro')), list, actions);
  }

  function altPanel(alt, current) {
    const stops = stopsFor(alt.id, current);
    const editable = canEdit();
    const rows = stops.map((visit, index) => {
      const name = nameOf(visit);
      const time = el('input.input.alt-time', { type: 'time', value: visit.start ?? '', disabled: !editable, 'aria-label': `${t('alternatives.time')} · ${name}`, dataset: { focus: `time:${visit.id}` },
        onchange: (event) => void apply([{ t: 'visit', id: visit.id, ...(event.target.value ? { set: { start: event.target.value } } : { unset: ['start'] }) }], 'edit') });
      return el('li.alt-stop', {},
        el('span.alt-stop-name', {}, name), time,
        editable && el('div.alt-stop-actions', {},
          iconButton('up', t('alternatives.moveUp', { name }), { disabled: index === 0, dataset: { focus: `up:${visit.id}` }, onclick: () => void move(stops, index, -1) }),
          iconButton('down', t('alternatives.moveDown', { name }), { disabled: index === stops.length - 1, dataset: { focus: `down:${visit.id}` }, onclick: () => void move(stops, index, 1) }),
          iconButton('copy', t('alternatives.toMain', { name }), { dataset: { focus: `main:${visit.id}` }, onclick: () => void toMain(visit) }),
          iconButton('trash', t('alternatives.remove', { name }), { dataset: { focus: `remove:${visit.id}` }, onclick: () => void apply([{ t: 'visit', id: visit.id, del: true }], 'edit') })));
    });
    const elsewhere = alt.dayId ? [] : [...new Set(altStops(current.visits, alt.id).filter((visit) => visit.dayId !== dayId).map((visit) => visit.dayId))].map(dayName).filter(Boolean);
    return el('div.alt-panel', {},
      !alt.dayId && el('p.alt-intro', {}, chip(t('alternatives.wholeTrip')), ' ', t('alternatives.wholeTripHint')),
      alt.notes && el('p.alt-notes', {}, alt.notes),
      stops.length ? el('ol.alt-stops', {}, rows) : el('p.alt-empty', {}, t('alternatives.empty')),
      elsewhere.length ? el('p.alt-note', {}, t('alternatives.otherDays', { days: elsewhere.join(', ') })) : null,
      editable && addForm(alt, stops),
      editable && el('div.alt-actions', {},
        button(t('alternatives.promote'), { size: 'sm', variant: 'primary', dataset: { focus: `promote:${alt.id}` }, onclick: () => void promote(alt) }),
        button(t('alternatives.rename'), { size: 'sm', dataset: { focus: `rename:${alt.id}` }, onclick: () => void rename(alt) }),
        button(t('alternatives.delete'), { size: 'sm', variant: 'danger', dataset: { focus: `delete:${alt.id}` }, onclick: () => void remove(alt) })),
      !editable && el('p.alt-note', {}, t('alternatives.readOnly')));
  }

  function addForm(alt, stops) {
    const places = [...space.select.place.all()].sort((a, b) => a.name.localeCompare(b.name));
    const place = field({ label: t('alternatives.place'), type: 'select', options: [{ value: '', label: t('alternatives.choosePlace') }, ...places.map((item) => ({ value: item.id, label: item.name }))], dataset: { focus: `place:${alt.id}` } });
    const title = field({ label: t('alternatives.freeTitle'), maxLength: 500, dataset: { focus: `title:${alt.id}` } });
    const headingId = uniqueId('alt-add');
    return el('form.alt-add', { 'aria-labelledby': headingId, onsubmit: (event) => {
      event.preventDefault();
      const placeId = place.input.value || null;
      const text = title.input.value.trim();
      if (!placeId && !text) { place.input.focus(); return; }
      // Cleared before the re-render, which otherwise keeps drafts.
      place.input.value = ''; title.input.value = '';
      void apply([addStopWrite({ stops, dayId, altId: alt.id, placeId, title: text })], 'edit');
    } }, el('h3.alt-subhead', { id: headingId }, t('alternatives.addStop')), el('div.alt-add-row', {}, place.element, title.element,
      button(t('alternatives.add'), { type: 'submit', size: 'sm', dataset: { focus: `add:${alt.id}` } })));
  }

  function column(id, other, current) {
    const stops = stopsFor(id, current);
    const otherStops = other ? stopsFor(other, current) : [];
    const unique = other ? onlyIn(stops, otherStops) : new Set();
    const stats = planStats(stops, placeOf);
    const span = stats.first !== null ? t('plan.timeRange', { start: clock(stats.first), end: clock(stats.last) }) : t('alternatives.none');
    return el('section.alt-column', { 'aria-label': planName(id, current) },
      el('h3.alt-subhead', {}, planName(id, current)),
      el('dl.alt-stats', {},
        el('dt', {}, t('alternatives.stops')), el('dd.num', {}, String(stats.stops)),
        el('dt', {}, t('alternatives.span')), el('dd.num', {}, span),
        el('dt', {}, t('alternatives.planned')), el('dd.num', {}, stats.planned ? formatDuration(stats.planned) : t('alternatives.none')),
        el('dt', {}, t('alternatives.distance')), el('dd.num', {}, stats.meters ? formatDistance(stats.meters) : t('alternatives.none'))),
      stops.length ? el('ol.alt-stops', {}, stops.map((visit) => el('li.alt-stop', { dataset: { unique: unique.has(visit.id) ? 'true' : 'false' } },
        el('span.alt-stop-name', {}, nameOf(visit)), stopTime(visit) && el('span.alt-stop-time.num', {}, stopTime(visit)),
        unique.has(visit.id) && chip(t('alternatives.onlyHere'))))) : el('p.alt-empty', {}, t('alternatives.empty')));
  }

  function comparePanel(current, plans) {
    const ids = plans.map((plan) => plan.id);
    if (!ids.includes(compare.left)) compare.left = MAIN;
    if (!ids.includes(compare.right) || compare.right === compare.left) compare.right = ids.find((value) => value !== compare.left) ?? null;
    const options = plans.map((plan) => ({ value: plan.id, label: plan.label }));
    const pick = (side, label) => {
      const control = field({ label, type: 'select', options, value: compare[side] ?? '', dataset: { focus: `compare:${side}` } });
      control.input.addEventListener('change', () => { compare = { ...compare, [side]: control.input.value }; render(); });
      return control.element;
    };
    return el('div.alt-panel', {},
      el('div.alt-compare-pick', {}, pick('left', t('alternatives.left')), pick('right', t('alternatives.right'))),
      el('div.alt-compare', {}, column(compare.left, compare.right, current), compare.right && column(compare.right, compare.left, current)));
  }

  function render() {
    if (!body.isConnected) return;
    const current = data();
    const alts = dayAlternatives(current.alts, current.days, dayId);
    if (selected !== MAIN && selected !== COMPARE && !alts.some((alt) => alt.id === selected)) selected = MAIN;
    const plans = [{ id: MAIN, label: t('alternatives.main') }, ...alts.map((alt) => ({ id: alt.id, label: alt.name }))];
    const items = [
      { id: MAIN, label: t('alternatives.main'), content: mainPanel(current) },
      ...alts.map((alt) => ({ id: alt.id, label: alt.name, content: altPanel(alt, current) })),
      ...(alts.length ? [{ id: COMPARE, label: t('alternatives.compare'), content: comparePanel(current, plans) }] : []),
    ];
    keepFocus(body, () => body.replaceChildren(tabs({ label: t('alternatives.tabs'), items, value: selected, onChange: (id) => { selected = id; } }).element));
  }
  const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { frame = 0; render(); }); };

  async function create({ copy, whole = false }) {
    const current = data();
    const scoped = dayAlternatives(current.alts, current.days, dayId);
    const name = t('alternatives.defaultName', { letter: nextLetter(scoped.length) });
    const writes = createWrites({ alts: current.alts, days: current.days, visits: current.visits, dayId: whole ? null : dayId, name, copy });
    if (await apply(writes, 'create')) { selected = writes[0].id; render(); }
  }
  async function move(stops, index, delta) {
    const write = moveStopWrite(stops, index, delta);
    if (write) await apply([write], 'edit');
  }
  async function toMain(visit) {
    if (await apply([copyToMainWrite({ visit, visits: data().visits })], 'edit')) toast(t('alternatives.copiedToMain'));
  }
  async function rename(alt) {
    const name = await promptDialog({ title: t('alternatives.renameTitle'), label: t('alternatives.name'), value: alt.name });
    if (name?.trim() && name.trim() !== alt.name) await apply([{ t: 'alt', id: alt.id, set: { name: name.trim().slice(0, 500) } }], 'edit');
  }
  async function promote(alt) {
    const current = data();
    const days = daysOf(alt, current.days).map(dayName).filter(Boolean);
    const ok = await confirmDialog({ title: t('alternatives.promoteTitle', { name: alt.name }), body: t('alternatives.promoteBody', { days: days.join(', ') }), confirmLabel: t('alternatives.promote') });
    if (!ok) return;
    const writes = promoteWrites({ alt, days: current.days, visits: current.visits, previousName: t('alternatives.previous') });
    if (await apply(writes, 'promote')) {
      toast(t('alternatives.promoted', { name: alt.name }), { action: { label: t('plan.undo'), onClick: () => void space.history.undo() } });
      selected = MAIN;
      render();
    }
  }
  async function remove(alt) {
    const ok = await confirmDialog({ title: t('alternatives.deleteTitle', { name: alt.name }), body: t('alternatives.deleteBody'), confirmLabel: t('alternatives.delete'), danger: true });
    if (ok && await apply(removeWrites({ alt, visits: data().visits }), 'edit')) { selected = MAIN; toast(t('alternatives.deleted')); render(); }
  }

  const offs = ['visit', 'alt', 'place', 'day'].map((type) => space.subscribe(type, schedule));
  void dialog.closed.then(() => { cancelAnimationFrame(frame); for (const off of offs) off(); });
  render();
  return dialog;
}
