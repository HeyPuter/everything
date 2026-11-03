import { el, safeURL } from '../../ui/dom.js';
import { markdown } from '../../ui/md.js';
import { direction, t } from '../../lib/i18n/index.js';
import { displayLocale } from '../../lib/prefs.js';
import { formatDate, formatDateRange, formatDistance, formatDuration, formatMoney, formatNumber, formatTime, formatWeight } from '../../lib/format.js';
import { localStamp, phaseLabelKey } from '../../lib/timeline/index.js';
import { isBuiltinCategory } from '../../lib/costs/categories.js';
import { isTransport } from '../../lib/res/index.js';
import { icon, MODE_ICONS, RES_ICONS } from '../trip/plan/icons.js';
import { legDetails, legRoute, legTimes, showZones, statusLabel, typeLabel, whenText } from '../trip/bookings/display.js';
import { has } from './options.js';

/*
 * Builds the printed trip as plain DOM. Everything here is user content set as text, or markdown through the shared
 * renderer; images are data or object URLs made by this view, or http(s) links checked with `safeURL`.
 */

const list = (values) => new Intl.ListFormat(displayLocale(), { style: 'long', type: 'conjunction' }).format(values);
const money = (amount, currency) => { try { return formatMoney(amount, currency); } catch { return `${amount} ${currency}`; } };
const approx = (text, estimated) => (estimated ? t('print.approx', { value: text }) : text);
const minutes = (seconds) => Math.round(seconds / 60);

export function dayTitle(day) {
  return [t('plan.dayNumber', { number: day.number }), day.date && formatDate(day.date, { weekday: true, year: false }), day.day.title].filter(Boolean).join(' · ');
}
function personName(model, who) {
  const person = model.names.get(who);
  if (!person) return t('print.formerMember');
  return person.guest ? t('print.guestName', { name: person.name }) : person.name;
}
function routeText(route) {
  if (!route?.distance) return '';
  const parts = [formatDistance(route.distance), route.duration > 0 && formatDuration(minutes(route.duration))].filter(Boolean).join(' · ');
  return approx(parts, route.estimated);
}
function timeText(row) {
  const start = formatTime(row.time);
  const end = formatTime(row.end);
  if (start && end) return t('plan.timeRange', { start, end });
  return start || (end ? t('plan.until', { time: end }) : '');
}
const rich = (text, className = '') => el(`div.pr-rich.markdown${className}`, {}, markdown(text));

function figure(image, { alt, caption, className = '' }) {
  return el(`figure.pr-figure${className}`, {}, el('img', { src: image.src, alt, width: image.width, height: image.height, decoding: 'async' }), caption && el('figcaption', {}, caption));
}
function mapCredits(assets, routes = []) {
  const credits = [...new Set([...(assets.credits ?? []), ...routes.flatMap((route) => route?.attribution ?? []).map((credit) => credit?.text).filter(Boolean)])];
  return credits.length ? t('print.mapCredits', { credits: credits.join(' · ') }) : '';
}

/** Photo sources: `{url}` images as given (http(s) only), file images from the view's loaded object URLs. */
export function photoSource(img, photos) {
  if (img?.fileId) return photos.get(img.fileId) ?? null;
  return img?.url ? safeURL(img.url) : null;
}

function cover(model, options, assets) {
  const { meta, stats } = model;
  const detailed = options.detail === 'detailed';
  const dates = meta.start ? formatDateRange(meta.start, meta.end ?? meta.start, { style: 'long' }) : '';
  const days = model.range.first === model.range.last ? t('plan.dayNumber', { number: model.range.first }) : t('print.rangeDays', { first: model.range.first, last: model.range.last });
  const range = model.full || model.range.first === null ? '' : days
    + (model.range.start ? ` · ${formatDateRange(model.range.start, model.range.end ?? model.range.start, { style: 'long' })}` : '');
  const stat = (label, value) => value !== '' && value != null && el('div.pr-stat', {}, el('dt', {}, label), el('dd', {}, String(value)));
  return el('header.pr-cover', {},
    assets.cover && el('img.pr-cover-image', { src: assets.cover, alt: '', decoding: 'async' }),
    el('h1.pr-title', {}, meta.title || t('print.untitledTrip')),
    (dates || range) && el('p.pr-dates', {}, [dates, range].filter(Boolean).join(' — ')),
    el('dl.pr-stats', {},
      stat(t('print.statDays'), formatNumber(stats.days)),
      stat(t('print.statPlaces'), formatNumber(stats.places)),
      stat(t('print.statBookings'), formatNumber(stats.bookings)),
      stat(t('print.statTravelers'), formatNumber(stats.travelers)),
      stats.distance && stat(t('print.statDistance'), approx(formatDistance(stats.distance.meters), stats.distance.estimated)),
      stats.spend && stat(t('print.statSpend'), money(stats.spend.amount, stats.spend.currency))),
    model.travelers.length > 0 && el('p.pr-travelers', {}, el('strong', {}, t('print.travelers')), ' ',
      list(model.travelers.map((person) => (person.guest ? t('print.guestName', { name: person.name }) : person.name)))),
    detailed && meta.description && rich(meta.description, '.pr-description'));
}

function routeSummary(model) {
  const items = model.days.map((day) => {
    const stops = day.rows.filter((row) => row.kind === 'visit' && row.primary && row.stop).map((row) => row.place?.name ?? row.entity.title ?? t('plan.untitled'));
    if (!stops.length) return null;
    const route = routeText(day.route);
    return el('li', {}, el('strong', {}, dayTitle(day)), ' ', stops.join(' → '), route && el('span.pr-sub', {}, ` · ${route}`));
  }).filter(Boolean);
  return items.length ? el('ul.pr-route-summary', {}, items) : el('p.pr-empty', {}, t('print.noLocatedStops'));
}

function tripMap(model, options, assets) {
  const image = assets.maps?.get('trip');
  let body;
  if (image) body = figure(image, { alt: t('print.mapAlt'), caption: mapCredits(assets, model.days.map((day) => day.route)), className: '.pr-map' });
  else if (assets.mapState === 'pending') body = el('p.pr-pending', {}, t('print.mapPending'));
  else {
    const note = { offline: 'print.mapOffline', unavailable: 'print.mapUnavailable', skipped: 'print.mapSkipped' }[assets.mapState];
    body = [note && el('p.pr-note', {}, t(note)), routeSummary(model)];
  }
  return el('section.pr-section.pr-map-section', {}, el('h2', {}, t('print.sectionMap')), body);
}

function stayLine(stay) {
  const time = stay.phase === 'checkin' ? stay.res.stay?.checkInFrom : stay.phase === 'checkout' ? stay.res.stay?.checkOut : null;
  return el('p.pr-stay', {}, icon('bed-double', 13), el('span', {}, t(phaseLabelKey('stay', stay.phase))), ' ', el('strong', {}, stay.res.title), time && el('span.pr-sub', {}, ` · ${formatTime(time)}`));
}

function rowNode(row, model, detailed) {
  const meta = [];
  let name;
  let mark;
  let extra = null;
  if (row.kind === 'visit') {
    name = row.place?.name ?? row.entity.title ?? t('plan.untitled');
    mark = row.stop ? el('span.pr-stop', {}, String(row.stop)) : el('span.pr-icon', {}, icon('map-pin', 13));
    if (row.phase) meta.push(t(phaseLabelKey('visit', row.phase)));
    if (detailed && row.place?.address) meta.push(row.place.address);
    if (detailed && row.primary && row.entity.people?.length) meta.push(list(row.entity.people.map((who) => personName(model, who))));
    if (detailed && row.primary && row.entity.notes) extra = rich(row.entity.notes);
  } else if (row.kind === 'note') {
    name = row.entity.title;
    mark = el('span.pr-icon', {}, icon(row.entity.icon ?? 'sticky-note', 13));
    if (detailed && row.entity.text) extra = rich(row.entity.text);
  } else {
    const res = row.entity;
    const leg = row.leg !== null ? res.legs?.[row.leg] : null;
    name = res.title;
    mark = el('span.pr-icon', {}, icon(RES_ICONS[res.type] ?? 'bookmark', 13));
    if (row.phase) meta.push(t(phaseLabelKey(row.family, row.phase)));
    if (leg) meta.push(legRoute(leg));
    if (detailed && leg) meta.push(...legDetails(leg, res.type));
    if (detailed && res.code && !leg?.code) meta.push(t('print.code', { code: res.code }));
    if (res.status === 'pending') meta.push(statusLabel(res.status));
  }
  return el('li.pr-row', { dataset: { kind: row.kind } },
    el('span.pr-time', {}, timeText(row)), mark,
    el('div.pr-main', {}, el('span.pr-name', {}, name), meta.length > 0 && el('span.pr-meta', {}, meta.join(' · ')), extra));
}

function legNode(leg) {
  const mode = MODE_ICONS[leg.mode] ? leg.mode : 'walk';
  const parts = [t(`plan.mode.${mode}`), leg.distance > 0 && formatDistance(leg.distance), leg.duration > 0 && formatDuration(minutes(leg.duration))].filter(Boolean).join(' · ');
  return el('li.pr-leg', {}, el('span.pr-time'), el('span.pr-icon', {}, icon(MODE_ICONS[mode], 12)), el('span.pr-main', {}, approx(parts, leg.estimated)));
}

function daySection(day, model, options, assets) {
  const detailed = options.detail === 'detailed';
  const legs = new Map((day.route?.legs ?? []).filter((leg) => leg.from?.t === 'visit' && leg.to?.t === 'visit').map((leg) => [leg.from.id, leg]));
  const rows = [];
  day.rows.forEach((row, index) => {
    rows.push(rowNode(row, model, detailed));
    const next = day.rows[index + 1];
    const leg = detailed && row.kind === 'visit' && row.primary && next?.kind === 'visit' ? legs.get(row.id) : null;
    if (leg && leg.to.id === next.id) rows.push(legNode(leg));
  });
  const route = routeText(day.route);
  const image = detailed && has(options, 'map') ? assets.maps?.get(`day:${day.id}`) : null;
  const photos = detailed && options.photos ? day.photos.map(({ place, img }) => {
    const src = photoSource(img, assets.photos ?? new Map());
    return src && el('figure.pr-photo', {}, el('img', { src, alt: place.name, decoding: 'async', referrerPolicy: 'no-referrer' }),
      el('figcaption', {}, place.name, img.credit && el('span.pr-sub', {}, ` · ${img.credit}`)));
  }).filter(Boolean) : [];
  return el('article.pr-day', { style: { '--day-color': `var(--day-${day.color})` } },
    el('header.pr-day-head', {},
      el('h3', {}, el('span.pr-day-num', {}, t('plan.dayNumber', { number: day.number })),
        day.date && el('span.pr-day-date', {}, formatDate(day.date, { style: 'long', weekday: true })),
        day.day.title && el('span.pr-day-title', {}, day.day.title)),
      route && el('span.pr-day-route', {}, route)),
    day.stays.map(stayLine),
    detailed && day.day.notes && rich(day.day.notes, '.pr-day-notes'),
    day.rows.length ? el('ol.pr-rows', {}, rows) : el('p.pr-empty', {}, t('print.dayEmpty')),
    image && figure(image, { alt: t('print.dayMapAlt', { day: dayTitle(day) }), caption: mapCredits(assets, [day.route]), className: '.pr-day-map' }),
    photos.length > 0 && el('div.pr-photos', {}, photos));
}

function daysSection(model, options, assets) {
  return el('section.pr-section.pr-days', {}, el('h2', {}, t('print.sectionDays')),
    model.days.length ? model.days.map((day) => daySection(day, model, options, assets)) : el('p.pr-empty', {}, t('print.noDays')));
}

function bookingCard(res, model) {
  const transport = isTransport(res.type) && res.legs?.length;
  const location = [res.location?.name, res.location?.address].filter(Boolean).join(', ');
  const facts = [
    res.code && [t('print.confirmation'), res.code],
    location && [t('print.location'), location],
    res.people?.length && [t('print.travelers'), list(res.people.map((who) => personName(model, who)))],
    res.stay?.checkInFrom && [t('print.checkIn'), formatTime(res.stay.checkInFrom)],
    res.stay?.checkOut && [t('print.checkOut'), formatTime(res.stay.checkOut)],
  ].filter(Boolean);
  return el('article.pr-res', { dataset: { status: res.status } },
    el('header.pr-res-head', {}, el('span.pr-icon', {}, icon(RES_ICONS[res.type] ?? 'bookmark', 14)), el('strong', {}, res.title),
      el('span.pr-tag', {}, typeLabel(res.type)), res.status !== 'confirmed' && el('span.pr-tag.pr-tag-warn', {}, statusLabel(res.status))),
    !transport && whenText(res) && el('p.pr-when', {}, whenText(res)),
    transport && el('ul.pr-legs', {}, res.legs.map((leg) => el('li', {}, el('strong', {}, legRoute(leg)), ' ', legTimes(leg, { zone: showZones(res) }),
      legDetails(leg, res.type).length > 0 && el('span.pr-sub', {}, ` · ${legDetails(leg, res.type).join(' · ')}`)))),
    facts.length > 0 && el('dl.pr-facts', {}, facts.map(([label, value]) => el('div', {}, el('dt', {}, label), el('dd', {}, value)))),
    res.notes && rich(res.notes));
}

function bookingRow(res) {
  return el('tr', { dataset: { status: res.status } },
    el('td.pr-nowrap', {}, whenText(res)),
    el('td', {}, el('strong', {}, res.title), res.legs?.length > 0 && el('span.pr-sub', {}, ` · ${res.legs.map(legRoute).join(', ')}`)),
    el('td', {}, typeLabel(res.type)),
    el('td', {}, res.code ?? ''),
    el('td', {}, statusLabel(res.status)));
}

function bookingsSection(model, options) {
  const groups = [['print.groupTransport', model.bookings.transport], ['print.groupStays', model.bookings.stays], ['print.groupOther', model.bookings.other]].filter(([, items]) => items.length);
  const detailed = options.detail === 'detailed';
  const body = !groups.length ? el('p.pr-empty', {}, t(model.full ? 'print.noBookings' : 'print.noBookingsRange'))
    : groups.map(([key, items]) => el('div.pr-group', {}, el('h3', {}, t(key)), detailed ? items.map((res) => bookingCard(res, model))
      : el('table.pr-table', {}, el('thead', {}, el('tr', {}, ['print.colWhen', 'print.colBooking', 'print.colType', 'print.colCode', 'print.colStatus'].map((label) => el('th', { scope: 'col' }, t(label))))),
        el('tbody', {}, items.map(bookingRow)))));
  return el('section.pr-section.pr-bookings', {}, el('h2', {}, t('print.sectionBookings')), body);
}

function packingSection(model, options) {
  const { lists, done, total } = model.packing;
  const detailed = options.detail === 'detailed';
  const item = ({ item: entry, done: checked, bag, grams }) => el('li', { dataset: { done: checked ? 'true' : 'false' } },
    el('span.pr-box', { role: 'img', 'aria-label': t(checked ? 'print.packed' : 'print.notPacked') }, checked && icon('check', 11)),
    el('span', {}, entry.name), entry.qty > 1 && el('span.pr-sub', {}, ` ×${formatNumber(entry.qty)}`),
    detailed && (bag || grams > 0) && el('span.pr-sub', {}, ` · ${[bag && t('print.bag', { name: bag.name }), grams > 0 && formatWeight(grams)].filter(Boolean).join(' · ')}`));
  return el('section.pr-section.pr-packing', {}, el('h2', {}, t('print.sectionPacking')),
    total > 0 && el('p.pr-sub', {}, t('print.packedCount', { done: formatNumber(done), total: formatNumber(total) })),
    lists.length ? el('div.pr-lists', {}, lists.map((group) => el('div.pr-list', {}, el('h3', {}, group.name || t('print.noList')), el('ul.pr-checklist', {}, group.items.map(item)))))
      : el('p.pr-empty', {}, t('print.noPacking')));
}

function categoryName(id, space) {
  if (isBuiltinCategory(id)) return t(`costs.cat.${id}`);
  return space?.get?.('cat', id)?.name ?? t('costs.cat.other');
}

function costsSection(model, space) {
  const costs = model.costs;
  const amount = (value) => money(value, costs.currency);
  const head = (...labels) => el('thead', {}, el('tr', {}, labels.map((label, index) => el(index ? 'th.pr-num' : 'th', { scope: 'col' }, label))));
  const body = !costs.count ? [el('p.pr-empty', {}, t('print.noCosts'))] : [
    el('p.pr-total', {}, t('print.totalSpend', { amount: amount(costs.spend) })),
    costs.categories.length > 0 && el('table.pr-table', {}, el('caption', {}, t('print.byCategory')), head(t('print.colCategory'), t('print.colAmount'), t('print.colShare')),
      el('tbody', {}, costs.categories.map((entry) => el('tr', {}, el('td', {}, categoryName(entry.id, space)), el('td.pr-num', {}, amount(entry.amount)),
        el('td.pr-num', {}, costs.spend ? new Intl.NumberFormat(displayLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(entry.amount / costs.spend) : ''))))),
    costs.people.length > 0 && el('table.pr-table', {}, el('caption', {}, t('print.byPerson')), head(t('print.colPerson'), t('print.colPaid'), t('print.colPersonShare'), t('print.colBalance')),
      el('tbody', {}, costs.people.map((entry) => ({ ...entry, name: personName(model, entry.who) })).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => el('tr', {}, el('td', {}, entry.name), el('td.pr-num', {}, amount(entry.paid)),
        el('td.pr-num', {}, amount(entry.share)), el('td.pr-num', {}, amount(entry.net)))))),
    costs.transfers.length > 0 && el('div.pr-group', {}, el('h3', {}, t('print.settleUp')),
      el('ul.pr-plain', {}, costs.transfers.map((transfer) => el('li', {}, t('print.pays', { from: personName(model, transfer.from), to: personName(model, transfer.to), amount: amount(transfer.amount) }))))),
    costs.pending > 0 && el('p.pr-note', {}, t('print.pendingRates', { count: costs.pending })),
  ];
  if (costs.personal?.total) body.push(el('p.pr-note', {}, t('print.privateSpend', { amount: amount(costs.personal.total) })));
  return el('section.pr-section.pr-costs', {}, el('h2', {}, t('print.sectionCosts')), body);
}

function notesSection(model, options) {
  const detailed = options.detail === 'detailed';
  const card = (note) => {
    const web = safeURL(note.web);
    return el('article.pr-note-card', {}, el('h3', {}, note.title),
      (note.cat || note.pinned) && el('p.pr-sub', {}, [note.cat, note.pinned && t('print.pinned')].filter(Boolean).join(' · ')),
      note.body && (detailed ? rich(note.body) : el('p', {}, note.body.length > 160 ? `${note.body.slice(0, 160)}…` : note.body)),
      web && el('p.pr-sub', {}, t('print.link', { host: new URL(web).host })));
  };
  return el('section.pr-section.pr-notes', {}, el('h2', {}, t('print.sectionNotes')),
    model.notes.length ? model.notes.map(card) : el('p.pr-empty', {}, t('print.noNotes')));
}

/**
 * The printed trip. `assets`: `maps` (Map of job key → image), `mapState` (`pending|ready|offline|unavailable|skipped`),
 * `credits` (map attribution texts), `photos` (Map of file id → object URL), `cover` (URL or null).
 */
export function buildDocument(model, options, assets = {}, { space = null, now = new Date() } = {}) {
  const sections = [];
  if (has(options, 'overview')) sections.push(cover(model, options, assets));
  if (has(options, 'map')) sections.push(tripMap(model, options, assets));
  if (has(options, 'days')) sections.push(daysSection(model, options, assets));
  if (has(options, 'bookings')) sections.push(bookingsSection(model, options));
  if (has(options, 'packing')) sections.push(packingSection(model, options));
  if (has(options, 'costs')) sections.push(costsSection(model, space));
  if (has(options, 'notes')) sections.push(notesSection(model, options));
  const stamp = `${formatDate(localStamp(now).slice(0, 10), { style: 'long' })} ${formatTime(now.getHours() * 60 + now.getMinutes())}`;
  return el('main.print-doc', { dataset: { detail: options.detail, font: options.font, orientation: options.orientation, breaks: options.pageBreak ? 'on' : 'off' } },
    sections, el('footer.pr-footer', {}, t('print.printedOn', { date: stamp })));
}

/** A CSS string literal; every character outside `[A-Za-z0-9 ]` is hex-escaped. */
export function cssString(value) {
  return `"${[...String(value ?? '')].map((char) => (/[A-Za-z0-9 ]/.test(char) ? char : `\\${char.codePointAt(0).toString(16)} `)).join('')}"`;
}

/** `@page` rules: orientation, margins and, where browsers support margin boxes, the trip name and page numbers. */
export function pageStyle(options, { title }) {
  const [before, rest = ''] = t('print.pageOf').split('{page}');
  const [middle, after = ''] = rest.split('{pages}');
  const name = String(title ?? '').slice(0, 80);
  // Margin boxes are physical: the trip name goes at the reading start.
  const [start, end] = direction === 'rtl' ? ['right', 'left'] : ['left', 'right'];
  return `@page { size: ${options.orientation === 'landscape' ? 'landscape' : 'portrait'}; margin: 14mm 12mm 16mm;
  @bottom-${start} { content: ${cssString(name)}; font-size: 8pt; }
  @bottom-${end} { content: ${cssString(before)} counter(page) ${cssString(middle)} counter(pages) ${cssString(after)}; font-size: 8pt; } }`;
}
