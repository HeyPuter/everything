import { el, safeURL } from '../../../../ui/dom.js';
import { t } from '../../../../lib/i18n/index.js';
import { prefs, displayLocale } from '../../../../lib/prefs.js';
import { formatInstant, formatNumber, formatTemperature, toFahrenheit } from '../../../../lib/format.js';
import { FORECAST_DAYS } from './model.js';
import { conditionIcon, wxIcon } from './icons.js';

const formats = new Map();
function intl(kind, options) {
  const locale = displayLocale();
  const key = `${kind}|${locale}|${JSON.stringify(options)}`;
  if (!formats.has(key)) {
    try { formats.set(key, kind === 'n' ? new Intl.NumberFormat(locale, options) : kind === 'r' ? new Intl.DisplayNames(locale, options) : new Intl.DateTimeFormat(locale, options)); } catch { formats.set(key, null); }
  }
  return formats.get(key);
}
const imperial = () => prefs().distanceUnit === 'mi';
const degrees = (celsius) => t('weather.degrees', { value: formatNumber(prefs().tempUnit === 'f' ? toFahrenheit(celsius) : celsius, { digits: 0 }) });
const temperature = (celsius) => formatTemperature(celsius);
const percent = (value) => intl('n', { style: 'percent', maximumFractionDigits: 0 })?.format(value / 100) ?? `${Math.round(value)}%`;
function speed(mps) {
  const value = imperial() ? mps * 2.236936 : mps * 3.6;
  return intl('n', { style: 'unit', unit: imperial() ? 'mile-per-hour' : 'kilometer-per-hour', unitDisplay: 'short', maximumFractionDigits: 0 })?.format(value) ?? String(Math.round(value));
}
function rain(mm) {
  const value = imperial() ? mm / 25.4 : mm;
  return intl('n', { style: 'unit', unit: imperial() ? 'inch' : 'millimeter', unitDisplay: 'short', maximumFractionDigits: imperial() ? 2 : 1 })?.format(value) ?? String(value);
}
const monthName = (date) => intl('d', { month: 'long', timeZone: 'UTC' })?.format(Date.UTC(2000, Number(date.slice(5, 7)) - 1, 15)) ?? date.slice(5, 7);
export const countryName = (cc) => intl('r', { type: 'region' })?.of(cc) ?? cc;
const clock = (epoch, zone) => formatInstant(epoch, zone, { date: false });
const conditionLabel = (condition) => t(`weather.condition.${condition ?? 'unknown'}`);
const nightAt = (epoch, sun) => Boolean(sun?.polar === 'night' || (sun?.rise && (epoch < sun.rise || epoch > sun.set)));

/** Keeps the node when nothing changed, so focus and scroll stay put; otherwise swaps its content and attributes. */
function patch(node, build) {
  const next = node.cloneNode(false);
  for (const name of [...next.getAttributeNames()]) if (name !== 'class') next.removeAttribute(name);
  build(next);
  if (next.isEqualNode(node)) return;
  const focus = node.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
  for (const name of node.getAttributeNames()) if (!next.hasAttribute(name)) node.removeAttribute(name);
  for (const name of next.getAttributeNames()) node.setAttribute(name, next.getAttribute(name));
  node.replaceChildren(...next.childNodes);
  if (focus) node.querySelector(`[data-focus="${focus}"]`)?.focus({ preventScroll: true });
}

function headParts(weather) {
  if (weather?.kind === 'forecast') {
    const { day } = weather;
    return { icon: conditionIcon(day.condition), text: t('weather.highLowShort', { high: degrees(day.maxC), low: degrees(day.minC) }),
      label: t('weather.headLabel', { condition: conditionLabel(day.condition), high: temperature(day.maxC), low: temperature(day.minC) }), high: day.maxC };
  }
  if (weather?.kind === 'normals') {
    const { normals } = weather;
    if (Number.isFinite(normals.highC) && Number.isFinite(normals.lowC)) {
      return { icon: wxIcon('typical'), text: t('weather.highLowShort', { high: degrees(normals.highC), low: degrees(normals.lowC) }),
        label: t('weather.headTypical', { high: temperature(normals.highC), low: temperature(normals.lowC) }), high: normals.highC, typical: true };
    }
    return { icon: wxIcon('typical'), text: degrees(normals.temperatureC), label: t('weather.headTypicalMean', { value: temperature(normals.temperatureC) }), high: normals.temperatureC, typical: true };
  }
  return null;
}

/** Compact weather in the day header: forecast icon and high/low, or the typical range marked as such. */
export function renderHead(node, model) {
  patch(node, (next) => {
    const parts = headParts(model?.weather);
    if (!parts) return;
    next.title = parts.label;
    next.append(parts.icon, el('span.num', { 'aria-hidden': 'true' }, parts.text),
      ...(parts.typical ? [el('span.wx-typical', { 'aria-hidden': 'true' }, t('weather.typical'))] : []), el('span.sr-only', {}, parts.label));
  });
}

const applies = (holiday) => !holiday.unresolved;

/** Inside a day chip: condition and high, plus a holiday mark. */
export function renderChip(node, model) {
  patch(node, (next) => {
    const parts = headParts(model?.weather);
    const holiday = model?.holidays?.public.find(applies);
    if (parts) next.append(parts.icon, el('span.num', { 'aria-hidden': 'true' }, degrees(parts.high)), el('span.sr-only', {}, `, ${parts.label}`));
    if (holiday) next.append(wxIcon('holiday', 14), el('span.sr-only', {}, `, ${t('weather.badgePublic', { name: holiday.name })}`));
  });
}

/** Holiday badges under the day header. */
export function renderInfo(node, model) {
  patch(node, (next) => {
    const holidays = model?.holidays;
    if (!holidays) return;
    for (const holiday of holidays.public) {
      const label = t(holiday.unresolved ? 'weather.badgeRegional' : 'weather.badgePublic', { name: holiday.name });
      next.append(el(`span.chip.wx-badge${holiday.unresolved ? '' : '.chip-warn'}`, { title: label }, wxIcon('holiday', 14),
        el('span.wx-badge-text', { 'aria-hidden': 'true' }, holiday.name), el('span.sr-only', {}, label)));
    }
    const school = holidays.school[0];
    if (school) {
      const label = school.unresolved ? t('weather.badgeSchoolSome') : `${t('weather.badgeSchool')}: ${school.name}`;
      next.append(el('span.chip.wx-badge', { title: label }, wxIcon('school', 14), el('span.wx-badge-text', { 'aria-hidden': 'true' }, t('weather.badgeSchool')), el('span.sr-only', {}, label)));
    }
  });
}

function credits(list) {
  if (!list?.length) return null;
  const items = [];
  list.forEach((credit, index) => {
    if (index) items.push(' · ');
    const url = safeURL(credit.url);
    const name = url ? el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, credit.text) : credit.text;
    items.push(name, credit.license ? ` (${credit.license})` : '');
  });
  return el('p.wx-credit', {}, t('weather.credit'), ' ', items);
}

function status({ pending, offline, stale, failed }, keys, retry) {
  if (pending) return el('p.wx-status', { role: 'status' }, t(keys.loading));
  if (stale) return el('p.wx-status', {}, t('weather.saved'));
  if (failed) {
    return el('p.wx-status', { role: 'status' }, t(offline ? keys.offline : keys.unavailable),
      !offline && el('button.plan-link', { type: 'button', dataset: { focus: `wx-retry:${keys.loading}` }, onclick: retry }, t('weather.retry')));
  }
  return null;
}

function weatherSection(model, actions) {
  const { weather, location } = model;
  const heading = el('h3.wx-heading', {}, t('weather.title'));
  if (weather.kind === 'undated') return el('div.wx-section', {}, heading, el('p.field-hint', {}, t('weather.undated')));
  if (weather.kind === 'nolocation') return el('div.wx-section', {}, heading, el('p.field-hint', {}, t('weather.noLocation')));
  const place = location.name || `${formatNumber(location.lat, { digits: 3 })}, ${formatNumber(location.lng, { digits: 3 })}`;
  const where = el('p.wx-where', {}, wxIcon('pin', 14), el('span', {}, weather.kind === 'normals' ? t('weather.typicalFor', { month: monthName(model.date), place }) : t('weather.forecastFor', { place })));
  const borrowed = location.from ? el('p.field-hint', {}, t('weather.borrowed', { place })) : null;
  const sun = weather.sun?.polar
    ? el('li', {}, wxIcon(weather.sun.polar === 'day' ? 'sunrise' : 'sunset'), t(weather.sun.polar === 'day' ? 'weather.polarDay' : 'weather.polarNight'))
    : weather.sun && [
      el('li', {}, wxIcon('sunrise'), el('span.num', {}, t('weather.sunrise', { time: clock(weather.sun.rise, weather.zone) }))),
      el('li', {}, wxIcon('sunset'), el('span.num', {}, t('weather.sunset', { time: clock(weather.sun.set, weather.zone) }))),
    ];
  const body = [];
  if (weather.kind === 'forecast') {
    const { day } = weather;
    body.push(el('div.wx-main', {}, conditionIcon(day.condition, { size: 32 }),
      el('div', {}, el('p.wx-condition', {}, conditionLabel(day.condition)),
        el('p.wx-range.num', {}, t('weather.high', { value: temperature(day.maxC) }), ' · ', t('weather.low', { value: temperature(day.minC) })))));
    body.push(el('ul.wx-facts', {},
      Number.isFinite(day.probability) && el('li', {}, wxIcon('umbrella'), el('span.num', {}, t('weather.precipChance', { value: percent(day.probability) }))),
      Number.isFinite(day.precipitationMm) && el('li', {}, wxIcon('droplets'), el('span.num', {}, t('weather.precip', { value: rain(day.precipitationMm) }))),
      Number.isFinite(day.windMps) && el('li', {}, wxIcon('wind'), el('span.num', {}, t('weather.wind', { value: speed(day.windMps) }))),
      sun));
    const strip = weather.strip ?? [];
    if (strip.length > 1) {
      body.push(el('p.wx-label', {}, t('weather.strip')), el('ol.wx-strip', { 'aria-label': t('weather.strip'), tabIndex: 0 }, strip.map((slot) => {
        const time = clock(slot.at, weather.zone);
        return el('li.wx-slot', { 'aria-label': t('weather.stripItem', { time, condition: conditionLabel(slot.condition), temperature: temperature(slot.temperatureC) }) },
          el('span.wx-slot-time.num', { 'aria-hidden': 'true' }, time),
          conditionIcon(slot.condition, { night: nightAt(slot.at, weather.sun) || slot.symbol?.endsWith('_night'), size: 20 }),
          el('span.wx-slot-temp.num', { 'aria-hidden': 'true' }, degrees(slot.temperatureC)),
          el('span.wx-slot-rain.num', { 'aria-hidden': 'true' }, Number.isFinite(slot.precipitationProbability) && slot.precipitationProbability >= 20 ? percent(slot.precipitationProbability) : Number.isFinite(slot.precipitationMm) && slot.precipitationMm > 0 ? rain(slot.precipitationMm) : ''));
      })));
    }
    if (weather.updatedAt && Number.isFinite(Date.parse(weather.updatedAt))) body.push(el('p.wx-status.num', {}, t('weather.updated', { time: formatInstant(Date.parse(weather.updatedAt), weather.zone) })));
  } else if (weather.kind === 'normals') {
    const { normals } = weather;
    const range = Number.isFinite(normals.highC) && Number.isFinite(normals.lowC);
    body.push(el('div.wx-main', {}, wxIcon('typical', 32), el('div', {},
      el('p.wx-condition', {}, t('weather.typicalHere', { month: monthName(model.date) })),
      el('p.wx-range.num', {}, range ? [t('weather.high', { value: temperature(normals.highC) }), ' · ', t('weather.low', { value: temperature(normals.lowC) })] : t('weather.mean', { value: temperature(normals.temperatureC) })))));
    body.push(el('ul.wx-facts', {},
      Number.isFinite(normals.precipitationMmDay) && el('li', {}, wxIcon('droplets'), el('span.num', {}, t('weather.precipDaily', { value: rain(normals.precipitationMmDay) }))),
      sun));
    body.push(el('p.field-hint', {}, t('weather.typicalHint', { days: FORECAST_DAYS })));
  } else {
    if (sun) body.push(el('ul.wx-facts', {}, sun));
    body.push(status({ pending: weather.kind === 'pending', offline: weather.offline, failed: weather.kind === 'none' },
      { loading: 'weather.loading', offline: 'weather.offline', unavailable: 'weather.unavailable' }, actions.retry));
  }
  if (weather.stale) body.push(status({ stale: true }, {}, null));
  return el('div.wx-section', {}, heading, where, borrowed, body, credits(weather.attribution));
}

function holidaySection(model, actions) {
  const holidays = model.holidays;
  if (!holidays) return null;
  const items = [];
  const closures = holidays.public.filter(applies);
  for (const holiday of holidays.public) {
    const label = holiday.unresolved ? t('weather.regionalHoliday', { country: countryName(holiday.cc) })
      : holiday.regional ? t('weather.regionHoliday', { region: regionLabel(holidays, holiday) }) : t('weather.publicHoliday', { country: countryName(holiday.cc) });
    items.push(el('li.wx-holiday', {}, wxIcon('holiday'), el('div', {}, el('p.wx-holiday-kind', {}, label),
      el('p.wx-holiday-name', {}, holiday.name), holiday.localName && holiday.localName !== holiday.name && el('p.field-hint', {}, holiday.localName))));
  }
  if (closures.length) {
    items.push(el('li.wx-warning', {}, wxIcon('warning'), el('div', {}, el('p', {}, t('weather.closedWarning')),
      model.stops > 0 && el('p', {}, t('weather.closedStops', { count: model.stops })))));
  } else if (holidays.public.length) {
    items.push(el('li.wx-note', {}, el('p.field-hint', {}, t('weather.regionalWarning'))));
  }
  for (const period of holidays.school) {
    const label = period.unresolved ? t('weather.schoolSomeRegions', { country: countryName(period.cc) })
      : period.regional ? t('weather.schoolRegion', { region: regionLabel(holidays, period) }) : t('weather.schoolHoliday', { country: countryName(period.cc) });
    items.push(el('li.wx-holiday', {}, wxIcon('school'), el('div', {}, el('p.wx-holiday-kind', {}, label),
      !period.unresolved && el('p.wx-holiday-name', {}, period.name), el('p.field-hint', {}, t('weather.crowds')))));
  }
  const regions = holidays.regions.map((item) => el('div.wx-region', {},
    el('p', {}, item.code ? t('weather.region', { region: item.name ?? item.code }) : t('weather.regionNeeded', { country: countryName(item.cc) })),
    el('button.btn.btn-sm', { type: 'button', dataset: { focus: `wx-region:${item.cc}` }, onclick: () => actions.chooseRegions(holidays.regions.map((entry) => entry.cc)) },
      t(item.code ? 'weather.changeRegion' : 'weather.chooseRegion'))));
  const state = status({ pending: holidays.pending && !items.length, offline: holidays.offline, failed: holidays.failed },
    { loading: 'weather.holidaysLoading', offline: 'weather.holidaysOffline', unavailable: 'weather.holidaysUnavailable' }, actions.retry);
  if (!items.length && !regions.length && !state) return null;
  return el('div.wx-section', {}, el('h3.wx-heading', {}, t('weather.holidays')),
    items.length > 0 && el('ul.wx-holidays', {}, items), regions, state, items.length > 0 && credits(holidays.attribution));
}
function regionLabel(holidays, item) {
  return holidays.regions.find((entry) => entry.cc === item.cc && entry.code === item.region)?.name ?? item.region;
}

/** The weather and holiday sections of the selected day's panel. */
export function renderPanel(node, model, actions) {
  patch(node, (next) => {
    if (!model) return;
    next.append(...[weatherSection(model, actions), holidaySection(model, actions)].filter(Boolean));
  });
}
