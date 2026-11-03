// OSM opening_hours subset: day lists/ranges, PH, time ranges, off and 24/7. Anything else stays raw text.
const DAY_KEYS = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];
const DAY = '(?:mo|tu|we|th|fr|sa|su)';
const DAYSPEC = `(?:${DAY}(?:-${DAY})?|ph)`;
const TIME = '(?:[01]?\\d|2[0-4]):[0-5]\\d';
const RANGE = `${TIME}-${TIME}`;
const RULE = new RegExp(`^(?:(${DAYSPEC}(?:,${DAYSPEC})*) )?(off|closed|${RANGE}(?:,${RANGE})*)$`);
const RANGE_ONLY = new RegExp(`^${RANGE}$`);
let library;
const loadLibrary = () => library ??= import('simple-opening-hours').then(module => module.SimpleOpeningHours ?? module.default?.SimpleOpeningHours);
const minutes = value => { const [h, m] = value.split(':').map(Number); return h * 60 + m; };
const validRange = value => { if (!RANGE_ONLY.test(value)) return false; const [a, b] = value.split('-'); return minutes(a) < 1440 && minutes(b) <= 1440; };

function normalize(raw) {
  const value = raw.toLowerCase().replace(/\s+/g, ' ').replace(/\s*([-,:;])\s*/g, '$1').trim();
  if (value === '24/7') return ['mo-su 00:00-24:00'];
  const rules = value.split(';').filter(Boolean);
  if (!rules.length || rules.length > 20) return null;
  const out = [];
  for (const rule of rules) {
    const match = RULE.exec(rule); if (!match) return null;
    out.push(`${match[1] ?? 'mo-su'} ${match[2] === 'closed' ? 'off' : match[2]}`);
  }
  return out;
}

/** Parses an OSM `opening_hours` value into a weekly table, or `{raw, week: null}` when it uses unsupported syntax. */
export async function parseOpeningHours(raw, { load = loadLibrary } = {}) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 500) return null;
  const text = raw.trim(); const rules = normalize(text);
  if (!rules) return { raw: text, week: null, holidays: null };
  const Parser = await load(); const table = new Parser(rules.join(';')).getTable();
  const week = {};
  for (const key of DAY_KEYS) {
    const ranges = Array.isArray(table?.[key]) ? table[key] : [];
    if (!ranges.every(validRange)) return { raw: text, week: null, holidays: null };
    week[key] = [...ranges];
  }
  const holidays = Array.isArray(table?.ph) && table.ph.every(validRange) && rules.some(rule => /(^|,)ph[ ,]/.test(rule)) ? [...table.ph] : null;
  return { raw: text, week, holidays };
}

/** Open/closed at `now` in the place's time zone; `open` is null when the table is unknown. Public holidays are not detected. */
export function openingStatus(hours, { timeZone, now = Date.now() } = {}) {
  if (!hours?.week || typeof timeZone !== 'string') return { open: null };
  let parts;
  try { parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(now)); }
  catch { return { open: null }; }
  const get = type => parts.find(part => part.type === type)?.value;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  if (day < 0) return { open: null };
  const at = (Number(get('hour')) % 24) * 60 + Number(get('minute'));
  const spans = key => (hours.week[key] ?? []).map(range => range.split('-').map(minutes));
  const today = spans(DAY_KEYS[day]).some(([start, end]) => end > start ? at >= start && at < end : at >= start);
  const spill = spans(DAY_KEYS[(day + 6) % 7]).some(([start, end]) => end <= start && end !== 0 && at < end);
  return { open: today || spill };
}
