// Public and school holidays for a leave year through `services.holidays`, plus extra calendars as day bands.
import { addDays } from '../../shared/dates.js';
import { isCountry, isRegion } from './model.js';

const PERIOD_DAYS = 400;

/** Calendar years a date range touches. */
export function yearsOf(range) {
  const years = [];
  for (let year = Number(range.start.slice(0, 4)); year <= Number(range.end.slice(0, 4)); year++) years.push(year);
  return years;
}

/** Dates of `[start, end]` that fall inside `range`. */
export function periodDates(start, end, range) {
  const from = start < range.start ? range.start : start;
  const to = end > range.end ? range.end : end;
  const dates = [];
  for (let date = from; date <= to && dates.length < PERIOD_DAYS; date = addDays(date, 1)) dates.push(date);
  return dates;
}

const add = (map, date, name) => { const names = map.get(date) ?? []; if (name && !names.includes(name)) names.push(name); map.set(date, names); };
const split = (region) => (isRegion(region) ? { country: region.slice(0, 2), sub: region } : isCountry(region) ? { country: region, sub: undefined } : null);

async function publicDays(services, country, sub, range, opts) {
  const days = new Map();
  let missing = false;
  for (const year of yearsOf(range)) {
    try {
      const result = await services.holidays.public(country, year, sub, opts);
      if (!result?.data) { missing = true; continue; }
      for (const day of result.data) if (day.date >= range.start && day.date <= range.end) add(days, day.date, day.localName || day.name);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      missing = true;
    }
  }
  return { days, missing };
}

async function schoolDays(services, country, sub, range, opts) {
  const days = new Map();
  let missing = false;
  for (const year of yearsOf(range)) {
    try {
      const result = await services.holidays.school(country, year, sub, opts);
      if (!result?.data) { missing = true; continue; }
      for (const period of result.data) {
        if (sub && period.regions?.length && !period.regions.includes(sub)) continue;
        for (const date of periodDates(period.start, period.end, range)) add(days, date, period.name);
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      missing = true;
    }
  }
  return { days, missing };
}

/**
 * `{publicDays, schoolDays, bands, missing}` for `range`. `publicDays` and `schoolDays` map date → names;
 * `bands` maps calendar id → `{label, color, days}`. `missing` is true when a provider gave no answer (offline, down).
 */
export async function loadHolidays({ services, plan, calendars = new Map(), range, lang = 'en', signal }) {
  const opts = { lang, signal };
  const result = { publicDays: new Map(), schoolDays: new Map(), bands: new Map(), missing: false };
  const holidays = services?.holidays;
  if (holidays && isCountry(plan?.holidays?.country)) {
    const sub = isRegion(plan.holidays.region) && plan.holidays.region.startsWith(plan.holidays.country) ? plan.holidays.region : undefined;
    const found = await publicDays(services, plan.holidays.country, sub, range, opts);
    result.publicDays = found.days; result.missing ||= found.missing;
  }
  if (holidays && isCountry(plan?.school?.country)) {
    const sub = isRegion(plan.school.subdivision) && plan.school.subdivision.startsWith(plan.school.country) ? plan.school.subdivision : undefined;
    const found = await schoolDays(services, plan.school.country, sub, range, opts);
    result.schoolDays = found.days; result.missing ||= found.missing;
  }
  for (const [id, calendar] of calendars) {
    let days = new Map();
    if (calendar.type === 'custom') {
      for (const period of calendar.periods) for (const date of periodDates(period.start, period.end, range)) add(days, date, calendar.label);
    } else if (holidays) {
      const place = split(calendar.region);
      if (!place) continue;
      const found = await (calendar.type === 'public' ? publicDays : schoolDays)(services, place.country, place.sub, range, opts);
      days = found.days; result.missing ||= found.missing;
    }
    result.bands.set(id, { label: calendar.label, color: calendar.color, type: calendar.type, days });
  }
  return result;
}
