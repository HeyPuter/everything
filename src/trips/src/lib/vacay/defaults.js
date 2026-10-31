// Defaults for a new plan, from the browser locale and the user's preferences.
import { weekStart } from '../format.js';
import { displayLocale, localeRegion } from '../prefs.js';
import { isCountry } from './model.js';

function localeWeekend(locale) {
  try {
    const intl = new Intl.Locale(locale);
    const info = typeof intl.getWeekInfo === 'function' ? intl.getWeekInfo() : intl.weekInfo;
    if (Array.isArray(info?.weekend) && info.weekend.length && info.weekend.length < 7) return [...new Set(info.weekend.map((day) => day % 7))];
  } catch { /* Fall back to Saturday and Sunday. */ }
  return [6, 0];
}

/** The plan written on first use: locale weekend, preferred week start, calendar year, the locale's country for holidays. */
export function defaultPlan({ locale = displayLocale() } = {}) {
  const region = localeRegion(locale);
  return { weekendDays: localeWeekend(locale), weekStart: weekStart(), yearType: 'calendar', color: 1, ...(isCountry(region) ? { holidays: { country: region } } : {}) };
}
