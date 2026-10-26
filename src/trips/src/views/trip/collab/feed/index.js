// Activity: change records kept on this device (30 days), with filters, merged bursts and an unread marker.
import './feed.css';
import { el, uid } from '../../../../ui/dom.js';
import { icon as kitIcon } from '../../../../ui/icons.js';
import { button, emptyState, skeleton } from '../../../../ui/bits.js';
import { t, strings } from '../../../../lib/i18n/index.js';
import { errorText, icon, plural } from '../common.js';
import { dayOf, feedAction, newEntryRevs } from '../model.js';
import { AREAS, areaOf, authorsOf, filterFeed, groupBursts, tabOf } from './model.js';

const SHOWN = 100;
const ITEMS = 6;
const AREA_ICONS = Object.freeze({ plan: 'map', bookings: 'plane', costs: 'wallet', lists: 'backpack', files: 'file', collab: 'chat', trip: 'pin' });
const STORAGE_KEY = 'trips:collab:feed';
const typeLabel = (type) => t(Object.hasOwn(strings, `collab.type.${type}`) ? `collab.type.${type}` : 'collab.type.item');
const fieldLabel = (name) => (Object.hasOwn(strings, `feed.field.${name}`) ? t(`feed.field.${name}`) : Object.hasOwn(strings, `collab.field.${name}`) ? t(`collab.field.${name}`) : null);
const fieldNames = (fields) => [...new Set((fields ?? []).map(fieldLabel).filter(Boolean))];

function readFilters() {
  try { const value = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? 'null'); return { area: AREAS.includes(value?.area) ? value.area : 'all', person: typeof value?.person === 'string' ? value.person : 'all' }; } catch { return { area: 'all', person: 'all' }; }
}
function saveFilters(value) { try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* per-device convenience only */ } }

/** Activity section of the Collab tab. */
export function mountFeed(container, ctx, { unreadAtOpen = Promise.resolve(0) } = {}) {
  const { space, uid: self } = ctx;
  let shown = SHOWN;
  let fresh = null;
  let feed = [];
  let loading = false;
  let queued = false;
  let destroyed = false;
  const filters = readFilters();

  const areaId = uid('feed-area');
  const personId = uid('feed-person');
  const area = el('select.select.feed-filter', { id: areaId, onchange: () => { filters.area = area.value; saveFilters(filters); shown = SHOWN; render(); } },
    el('option', { value: 'all' }, t('feed.areaAll')), AREAS.map((id) => el('option', { value: id }, t(`feed.area.${id}`))));
  const person = el('select.select.feed-filter', { id: personId, onchange: () => { filters.person = person.value; saveFilters(filters); shown = SHOWN; render(); } });
  const toolbar = el('div.feed-toolbar', {},
    el('label.feed-filter-field', { htmlFor: areaId }, el('span', {}, t('feed.areaLabel')), area),
    el('label.feed-filter-field', { htmlFor: personId }, el('span', {}, t('feed.personLabel')), person));
  const count = el('p.feed-count', { 'aria-live': 'polite' });
  const list = el('div.feed-list');
  const more = button(t('collab.feed.more'), { size: 'sm', variant: 'ghost', hidden: true, onclick: () => { shown += SHOWN; render(); } });
  const status = el('div.feed-status');
  container.replaceChildren(el('div.collab-section.feed', {}, el('p.feed-note', {}, t('collab.feed.retention')), toolbar, count, status, list, more));
  status.replaceChildren(el('div.feed-skeleton', { 'aria-hidden': 'true' }, skeleton('70%'), skeleton('50%'), skeleton('60%')));

  function renderPeople() {
    const ids = authorsOf(feed).filter((id) => id !== self);
    if (!['all', 'me', 'others'].includes(filters.person) && !ids.includes(filters.person)) filters.person = 'all';
    person.replaceChildren(el('option', { value: 'all' }, t('feed.personAll')), el('option', { value: 'me' }, t('feed.personMe')), el('option', { value: 'others' }, t('feed.personOthers')),
      ids.map((id) => el('option', { value: id }, ctx.person(id).name)));
    person.value = filters.person;
    area.value = filters.area;
  }

  function itemNode(item) {
    const action = feedAction(item);
    const fields = action === 'change' ? fieldNames(item.fields) : [];
    const named = !action.startsWith('msg') && item.name;
    const tab = tabOf(item);
    const href = tab ? ctx.tabHash(tab) : null;
    const content = [
      el('span.feed-item-icon', { 'aria-hidden': 'true' }, icon(AREA_ICONS[areaOf(item.t)], 14)),
      el('span', {}, t(`collab.feed.${action}`, { type: typeLabel(item.t) })),
      named && el('bdi.feed-name', {}, item.name),
      fields.length > 0 && el('span.feed-fields', {}, t('collab.feed.fields', { fields: fields.join(', ') })),
    ];
    return el(`li.feed-item${item.op === 'remove' ? '.is-removed' : ''}`, {}, href ? el('a.feed-item-link', { href }, content) : el('span.feed-item-link', {}, content));
  }

  function entryNode(entry) {
    const who = ctx.person(entry.by);
    const isNew = entry.revs.some((rev) => fresh?.has(rev));
    const items = entry.items.slice(0, ITEMS);
    const span = entry.revs.length > 1 && Number.isSafeInteger(entry.oldest) && Number.isSafeInteger(entry.at) && ctx.time(entry.oldest) !== ctx.time(entry.at)
      ? `${ctx.time(entry.oldest)}–${ctx.time(entry.at)}` : ctx.time(entry.at);
    return el(`li.feed-entry${isNew ? '.is-new' : ''}`, { dataset: { rev: String(entry.rev) } },
      ctx.avatarOf(entry.by, 32),
      el('div.feed-body', {},
        el('div.feed-head', {}, el('span.feed-who', {}, entry.by === self ? t('feed.you', { name: who.name }) : who.name),
          Number.isSafeInteger(entry.at) && ctx.timeNode(entry.at, span), isNew && el('span.feed-new', {}, t('collab.feed.new'))),
        el('ul.feed-items', {}, items.map(itemNode),
          entry.items.length > ITEMS && el('li.feed-item.feed-rest', {}, plural(entry.items.length - ITEMS, 'collab.feed.restOne', 'collab.feed.rest')))));
  }

  function render() {
    if (destroyed) return;
    renderPeople();
    const filtered = filterFeed(feed, { area: filters.area, person: filters.person, uid: self });
    const entries = groupBursts(filtered.slice(-shown).reverse());
    const sections = [];
    let group = null;
    let divided = false;
    for (const [index, entry] of entries.entries()) {
      const date = Number.isSafeInteger(entry.at) ? dayOf(entry.at, ctx.zone) : '';
      if (!group || group.date !== date) {
        group = { date, list: el('ol.feed-entries') };
        sections.push(el('section.feed-day', {}, el('h3.feed-day-title', {}, date ? ctx.day(date) : t('collab.feed.undated')), group.list));
      }
      // A marker after the last unread entry, when older ones follow.
      const newHere = entry.revs.some((rev) => fresh?.has(rev));
      const next = entries[index + 1];
      group.list.append(entryNode(entry));
      if (!divided && newHere && next && !next.revs.some((rev) => fresh?.has(rev))) {
        divided = true;
        group.list.append(el('li.feed-divider', { role: 'separator' }, el('span', {}, t('feed.earlier'))));
      }
    }
    list.replaceChildren(...sections);
    more.hidden = filtered.length <= shown;
    const filteredOut = filters.area !== 'all' || filters.person !== 'all';
    count.textContent = feed.length && filteredOut ? t('feed.count', { shown: filtered.length, total: feed.length }) : '';
    toolbar.hidden = !feed.length;
    status.replaceChildren(...(feed.length ? (filtered.length ? [] : [el('div.feed-none', {}, kitIcon('search', 18), el('p', {}, t('feed.noneMatch')),
      button(t('feed.clear'), { size: 'sm', onclick: () => { filters.area = 'all'; filters.person = 'all'; saveFilters(filters); render(); } }))])
      : [emptyState({ title: t('collab.feed.emptyTitle'), body: t('collab.feed.emptyBody'), icon: 'clock' })]));
  }

  async function load() {
    if (loading) { queued = true; return; }
    loading = true;
    try {
      const next = await space.feed();
      if (destroyed) return;
      const unread = await unreadAtOpen;
      if (destroyed) return;
      feed = next;
      fresh ??= newEntryRevs(feed, { unread, uid: self });
      render();
    } catch (error) {
      if (!destroyed) status.replaceChildren(el('p.field-error', { role: 'alert' }, errorText(error)), button(t('collab.retry'), { size: 'sm', onclick: () => void load() }));
    } finally {
      loading = false;
      if (queued && !destroyed) { queued = false; void load(); }
    }
  }

  const off = space.subscribe((event) => { if (event.feed || event.types.has('member')) void load(); });
  void load();
  return () => { destroyed = true; off(); };
}
