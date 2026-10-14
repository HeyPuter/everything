/**
 * Values on screen. A cell stores a raw value (number, string, boolean or
 * null) plus an optional style; this module turns typed text into values
 * and values into display strings, and converts between our number-format
 * names and the codes spreadsheet files use.
 *
 * Dates use the 1900 serial calendar of workbook files, including its fictitious February 29.
 * Gregorian dates from March 1900 onward have the 1899-12-30 epoch. All date
 * math uses UTC so a serial never shifts across a daylight-saving boundary.
 */

export const NUM_FORMATS = ['general', 'number', 'currency', 'percent', 'date', 'time', 'datetime', 'scientific', 'text', 'custom'];
export const MAX_DECIMAL_PLACES = 20;

import { formatWithCode, codeDateKind, codeScalesPercent, codeLocale, localeTag, MAX_FORMAT_CODE_LENGTH } from './numfmt.js';
import { normalizeNumberDigits } from './number-shape.js';

/** Font families a cell can ask for: [key, label, CSS stack]. The default is the app font. */
/**
 * Border styles. A cell's borders share one color (`bc`, a hex) and one
 * style (`bs`); the sides themselves are the bt/bb/bl/br flags.
 */
export const BORDER_STYLES = [
  ['thin', 'Thin'],
  ['medium', 'Medium'],
  ['thick', 'Thick'],
  ['dashed', 'Dashed'],
  ['dotted', 'Dotted'],
  ['double', 'Double'],
];

/** CSS pieces for a cell's border style: { width, style, color }; color is null for the default ink. */
export function borderCss(st) {
  const bs = st?.bs || 'thin';
  const width = bs === 'medium' ? '2px' : bs === 'thick' || bs === 'double' ? '3px' : '1px';
  const style = bs === 'dashed' || bs === 'dotted' || bs === 'double' ? bs : 'solid';
  return { width, style, color: st?.bc || null };
}

/** Plain-language help for each error value, shown when hovering an error cell. */
export const ERROR_HELP = {
  '#DIV/0!': 'Division by zero: a divisor is zero or an empty cell.',
  '#VALUE!': 'Wrong kind of value: text where a number was expected, or an array where one value was.',
  '#REF!': 'A reference points at cells or a sheet that no longer exist.',
  '#NAME?': 'Unknown function or name. Check the spelling, or quote text.',
  '#N/A': 'No match was found (lookup functions), or a value is not available.',
  '#NUM!': 'A number is out of range or a calculation did not converge.',
  '#NULL!': 'Two ranges do not intersect.',
  '#CYCLE!': 'Circular reference: this formula depends on its own result.',
  '#SPILL!': 'The array result cannot fit here. Clear blocking cells, move the formula away from the sheet edge, or reduce the result size.',
  '#CALC!': 'The calculation produced something a cell cannot show, such as an uncalled LAMBDA or an empty array.',
  '#ERROR!': 'The formula could not be parsed. Check parentheses, commas, and quotes.',
  '#BUSY!': 'Waiting for an answer (AI or another slow source); the cell fills in when it arrives.',
  '#BLOCKED!': 'Content from other files or the web is not loaded in this spreadsheet until you allow it in the notice above the sheet.',
};

export function errorHelp(code) {
  const help = ERROR_HELP[code];
  return help ? `${code}: ${help}` : code;
}

export const FONTS = [
  ['default', 'Default', null],
  ['arial', 'Arial', 'Arial, Helvetica, sans-serif'],
  ['arial-black', 'Arial Black', '"Arial Black", Arial, Helvetica, sans-serif'],
  ['calibri', 'Calibri', 'Calibri, Carlito, Arial, sans-serif'],
  ['cambria', 'Cambria', 'Cambria, Caladea, Georgia, "Times New Roman", serif'],
  ['aharoni', 'Aharoni', 'Aharoni, "Arial Black", Arial, sans-serif'],
  ['avenir', 'Avenir Next LT Pro', '"Avenir Next LT Pro", "Avenir Next", Avenir, Arial, sans-serif'],
  ['century', 'Century Gothic', '"Century Gothic", "Avenir Next", Avenir, Arial, sans-serif'],
  ['constantia', 'Constantia', 'Constantia, Georgia, "Times New Roman", serif'],
  ['corbel', 'Corbel', 'Corbel, "Trebuchet MS", Arial, sans-serif'],
  ['helvetica', 'Helvetica', 'Helvetica, Arial, sans-serif'],
  ['impact', 'Impact', 'Impact, Haettenschweiler, "Arial Narrow", sans-serif'],
  ['lato', 'Lato', 'Lato, Arial, Helvetica, sans-serif'],
  ['lato-light', 'Lato Light', '"Lato Light", Lato, Arial, sans-serif'],
  ['lucida-sans', 'Lucida Sans', '"Lucida Sans", "Lucida Sans Unicode", "Lucida Grande", sans-serif'],
  ['nyala', 'Nyala', 'Nyala, Palatino, "Palatino Linotype", Georgia, serif'],
  ['open-sans-semibold', 'Open Sans Semibold', '"Open Sans Semibold", "Open Sans", Arial, sans-serif'],
  ['segoe', 'Segoe UI', '"Segoe UI", Arial, Helvetica, sans-serif'],
  ['source-sans', 'Source Sans Pro', '"Source Sans Pro", "Source Sans 3", Arial, sans-serif'],
  ['tahoma', 'Tahoma', 'Tahoma, Verdana, Arial, sans-serif'],
  ['verdana', 'Verdana', 'Verdana, Geneva, sans-serif'],
  ['trebuchet', 'Trebuchet MS', '"Trebuchet MS", Helvetica, sans-serif'],
  ['georgia', 'Georgia', 'Georgia, "Times New Roman", serif'],
  ['rockwell', 'Rockwell', 'Rockwell, "Rockwell Nova", Georgia, serif'],
  ['times', 'Times New Roman', '"Times New Roman", Times, serif'],
  ['garamond', 'Garamond', 'Garamond, "EB Garamond", Georgia, serif'],
  ['courier', 'Courier New', '"Courier New", Courier, monospace'],
  ['mono', 'Monospace', 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'],
  ['comic', 'Comic Sans MS', '"Comic Sans MS", "Comic Sans", cursive'],
];

const fontPresets = new Map(FONTS.map(font => [font[0], font]));
// Browser-only substitutes when an imported family is not installed. Keep
// the requested family first, and retain its name in native files/clipboard.
// Book Antiqua is a Renaissance roman face; falling back to Arial changes
// its serif design. Palatino is the corresponding commonly installed choice.
const importedFontFallbacks = new Map([
  // Office theme font names can include the regular face's subfamily.
  ['open sans regular', '"Open Sans", Arial, sans-serif'],
  // Carlito shares Aptos Narrow's tabular digit advance and has closer Latin
  // text widths than generic Arial. Keep the requested font first; this is
  // a browser fallback, not a substitution in workbook data.
  ['aptos narrow', 'Carlito, "Arial Narrow", Arial, sans-serif'],
  ['arial nova cond', '"Arial Narrow", "Avenir Next Condensed", Arial, sans-serif'],
  ['book antiqua', 'Palatino, "Palatino Linotype", Georgia, serif'],
  // Office names this humanist family Gill Sans MT; macOS provides Gill Sans.
  // Prefer that installed family before the generic sans-serif fallback, while
  // keeping the requested MT face first and preserving it in serialized data.
  ['gill sans mt', '"Gill Sans", Arial, sans-serif'],
  // Sylfaen is a serif face. Office can supply it privately even when the
  // browser cannot; retain the requested family and its typographic class.
  ['sylfaen', '"Times New Roman", Times, serif'],
]);
const validFontName = name => typeof name === 'string' && name.length <= 255 && name.trim()
  && !/[\u0000-\u001f\u007f-\u009f]/.test(name);

/** The file's family name. Imported families need not be in the preset menu. */
export function fontName(key) {
  if (!key || key === 'default') return null;
  const name = typeof key === 'string' && key.startsWith('font:') ? key.slice(5) : key;
  return fontPresets.get(key)?.[1] || (validFontName(name) ? name : null);
}

/** CSS font-family for a style's font key, or null for the default.
 * Clipboard consumers need the requested family, not a browser substitute. */
export function fontStack(key, { fallbacks = true } = {}) {
  if (!key) return null;
  if (fallbacks && fontPresets.has(key)) return fontPresets.get(key)[2];
  const name = fontName(key);
  // Family names are data, never CSS declarations. Keep punctuation and Unicode
  // names intact, including commas, quotes and backslashes in native XLSX fonts.
  const fallback = importedFontFallbacks.get(name?.toLowerCase()) || 'Arial, sans-serif';
  return name ? `"${name.replace(/[\\"]/g, '\\$&')}"${fallbacks ? `, ${fallback}` : ''}` : null;
}

/** The font key for a family name found in a file or pasted markup, or null. */
export function fontKeyFor(family, { literal = false } = {}) {
  if (typeof family !== 'string' || family.length > 8192) return null;
  let name = family.trim();
  let quoted = false;
  if (!literal) {
    // Read the first CSS family, respecting quoted commas and CSS escapes.
    const first = /^(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|((?:\\.|[^,\\])+))\s*(?:,|$)/s.exec(name);
    if (!first) return null;
    quoted = first[3] == null;
    name = (first[1] ?? first[2] ?? first[3]).replace(/\\([\da-f]{1,6})\s?|\\(.)/gi, (_, hex, ch) => {
      const code = hex && parseInt(hex, 16);
      return hex ? String.fromCodePoint(code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? code : 0xfffd) : ch;
    }).trim();
    if (first[3] && /[;{}"']/.test(name)) return null;
    if (first[3] && /^(?:inherit|initial|unset|revert|revert-layer)$/i.test(name)) return null;
  }
  name = name.replace(/\s+\((?:headings|body)\)$/i, '');
  if (!validFontName(name)) return null;
  const t = name.toLowerCase();
  if (!t) return null;
  const named = FONTS.find((f) => f[1].toLowerCase() === t);
  // Named CSS families, like native families, are not preset keys or aliases:
  // Geneva and Verdana remain distinct even though one can fall back to the
  // other. Only unquoted CSS generic families select a substitute preset.
  const generic = !literal && !quoted && /^(?:serif|sans-serif|monospace|ui-monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-rounded)$/i.test(name);
  const hit = named || (generic && FONTS.find(f => f[2]?.split(',').some(alias => alias.trim().toLowerCase() === t)));
  return hit ? (hit[0] !== 'default' ? hit[0] : null) : `font:${name}`;
}

export const CURRENCIES = [
  ['USD', 'US dollar', '$'], ['EUR', 'Euro', '€'], ['GBP', 'British pound', '£'], ['JPY', 'Japanese yen', '¥'],
  ['INR', 'Indian rupee', '₹'], ['CNY', 'Chinese yuan', '¥'], ['CAD', 'Canadian dollar', '$'], ['AUD', 'Australian dollar', '$'],
  ['CHF', 'Swiss franc', 'CHF'], ['BRL', 'Brazilian real', 'R$'], ['MXN', 'Mexican peso', '$'], ['KRW', 'South Korean won', '₩'],
  ['SEK', 'Swedish krona', 'kr'], ['NOK', 'Norwegian krone', 'kr'], ['PLN', 'Polish zloty', 'zł'], ['TRY', 'Turkish lira', '₺'],
  ['DKK', 'Danish krone', 'kr'], ['CZK', 'Czech koruna', 'Kč'], ['RUB', 'Russian ruble', '₽'],
];

/** Regional formats on offer: how numbers and dates are written and read. */
export const LOCALES = [
  ['en-US', 'English (United States)'], ['en-GB', 'English (United Kingdom)'], ['en-IN', 'English (India)'], ['en-AU', 'English (Australia)'],
  ['de-DE', 'Deutsch'], ['fr-FR', 'Français'], ['es-ES', 'Español'], ['it-IT', 'Italiano'], ['nl-NL', 'Nederlands'], ['pt-BR', 'Português (Brasil)'],
  ['pt-PT', 'Português (Portugal)'], ['sv-SE', 'Svenska'], ['da-DK', 'Dansk'], ['nb-NO', 'Norsk'], ['fi-FI', 'Suomi'], ['pl-PL', 'Polski'], ['cs-CZ', 'Čeština'],
  ['tr-TR', 'Türkçe'], ['ru-RU', 'Русский'], ['ja-JP', '日本語'], ['zh-CN', '中文'], ['ko-KR', '한국어'],
];

let locale = 'en-US';
export function setLocale(l) { locale = LOCALES.some(([code]) => code === l) ? l : 'en-US'; }
export function getLocale() { return locale; }

/** The currency of each regional format, which its Currency format takes on a cell that has none of its own. */
const LOCALE_CURRENCIES = {
  'en-US': 'USD', 'en-GB': 'GBP', 'en-IN': 'INR', 'en-AU': 'AUD', 'de-DE': 'EUR', 'fr-FR': 'EUR', 'es-ES': 'EUR', 'it-IT': 'EUR', 'nl-NL': 'EUR',
  'pt-BR': 'BRL', 'pt-PT': 'EUR', 'sv-SE': 'SEK', 'da-DK': 'DKK', 'nb-NO': 'NOK', 'fi-FI': 'EUR', 'pl-PL': 'PLN', 'cs-CZ': 'CZK', 'tr-TR': 'TRY',
  'ru-RU': 'RUB', 'ja-JP': 'JPY', 'zh-CN': 'CNY', 'ko-KR': 'KRW',
};
export function localeCurrency(loc = locale) { return LOCALE_CURRENCIES[loc] || 'USD'; }

/**
 * The currency the Currency format takes on a cell: the cell's own; on a cell in no currency the regional
 * format's (pounds in British English, euros in German). A
 * currency style without `cur` is in US dollars, the default every style was written with, so a file keeps
 * its dollars whatever regional format opens it.
 */
export function cellCurrency(style, loc = locale) {
  return style?.cur || (style?.fmt === 'currency' ? 'USD' : localeCurrency(loc));
}

const infoCache = new Map();
/** Separators and date order of a locale: { decimal, group, dayFirst }. */
export function localeInfo(loc = locale) {
  let info = infoCache.get(loc);
  if (info) return info;
  try {
    const parts = new Intl.NumberFormat(loc).formatToParts(1234567.5);
    const decimal = parts.find((x) => x.type === 'decimal')?.value || '.';
    const group = parts.find((x) => x.type === 'group')?.value || ',';
    // Indian grouping puts two-digit groups before the last three: 12,34,567.
    const groups = parts.filter((x) => x.type === 'integer').map((x) => x.value);
    const lakh = groups.length > 2 && groups[groups.length - 2].length === 2;
    const dparts = new Intl.DateTimeFormat(loc).formatToParts(new Date(Date.UTC(2000, 10, 22)));
    const order = dparts.filter((x) => x.type === 'day' || x.type === 'month' || x.type === 'year').map((x) => x.type);
    info = { decimal, group, lakh, dayFirst: order[0] === 'day', yearFirst: order[0] === 'year' };
  } catch {
    info = { decimal: '.', group: ',', lakh: false, dayFirst: false, yearFirst: false };
  }
  infoCache.set(loc, info);
  return info;
}

// English names, the same in every English locale (Sep, where British locale data abbreviates Sept),
// and the tables a locale Intl does not know falls back to.
const ENGLISH_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ENGLISH_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// The ddd weekday abbreviations differ from CLDR's short width in these
// languages. They are shared by Gregorian and localized calendar formats;
// full weekday names still come from the locale's ordinary vocabulary.
const SHORT_WEEKDAYS = {
  ru: ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'],
  ca: ['dg', 'dl', 'dt', 'dc', 'dj', 'dv', 'ds'],
  pt: ['dom.', 'seg.', 'ter.', 'qua.', 'qui.', 'sex.', 'sáb.'],
  id: ['Mgg', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'],
  vi: ['CN', 'Th 2', 'Th 3', 'Th 4', 'Th 5', 'Th 6', 'Th 7'],
};
const namesCache = new Map();
/**
 * Month and weekday names of a locale, from its Intl data, as format codes print them and typed dates are read:
 * { months: { long, short, inDate, shortInDate }, days: { long, short } }. `inDate` is the form a month takes
 * beside a day number where the language declines it (Russian "марта" for "март"); where that form is a bare
 * number, as in a locale whose medium date is numeric, the standalone name stands.
 */
export function dateNames(loc = locale) {
  let names = namesCache.get(loc);
  if (names) return names;
  const english = {
    months: { long: ENGLISH_MONTHS, short: ENGLISH_MONTHS.map((m) => m.slice(0, 3)), inDate: ENGLISH_MONTHS, shortInDate: ENGLISH_MONTHS.map((m) => m.slice(0, 3)) },
    days: { long: ENGLISH_DAYS, short: ENGLISH_DAYS.map((d) => d.slice(0, 3)) },
  };
  if (/^en(-|$)/i.test(loc)) names = english;
  else {
    try {
      // A language Intl does not know would silently take the browser's own; English is the same everywhere.
      if (!Intl.DateTimeFormat.supportedLocalesOf([loc]).length) throw new RangeError(loc);
      // A name on its own is the whole of what the formatter writes (3月 in Japanese); beside a day it is the month part.
      const alone = (opts) => { const f = new Intl.DateTimeFormat(loc, { ...opts, timeZone: 'UTC' }); return (d) => f.format(d); };
      const part = (opts, type) => {
        const f = new Intl.DateTimeFormat(loc, { ...opts, timeZone: 'UTC' });
        return (d) => f.formatToParts(d).find((p) => p.type === type)?.value ?? '';
      };
      const months = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2001, i, 1)));
      const days = Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2006, 0, 1 + i))); // 2006-01-01 was a Sunday
      const long = months.map(alone({ month: 'long' }));
      const short = months.map(alone({ month: 'short' }));
      const inDate = (form, standalone) => months.map(part({ day: 'numeric', month: form }, 'month')).map((m, i) => (/\p{L}/u.test(m) ? m : standalone[i]));
      names = {
        months: { long, short, inDate: inDate('long', long), shortInDate: inDate('short', short) },
        days: { long: days.map(alone({ weekday: 'long' })), short: SHORT_WEEKDAYS[loc.toLowerCase().split('-')[0]] || days.map(alone({ weekday: 'short' })) },
      };
      if (long.some((m) => !m) || names.days.long.some((d) => !d)) names = english;
    } catch {
      names = english;
    }
  }
  namesCache.set(loc, names);
  return names;
}

const EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86400000;

/** Convert a real UTC instant; JavaScript dates cannot represent 1900-02-29. */
export function dateToSerial(date) {
  const serial = (date.getTime() - EPOCH_MS) / DAY_MS;
  return serial < 61 ? serial - 1 : serial;
}

/** Gregorian bridge only: serial 60 maps to February 28, and 0 to December 31.
 * Use serialToYMD for spreadsheet calendar fields, which preserve both special days. */
export function serialToDate(serial) {
  return new Date(EPOCH_MS + Math.round((serial < 60 ? serial + 1 : serial) * DAY_MS));
}

/** Serial for a calendar date with month/day overflow through the 1900 leap day.
 * Normalize the month first, then add days in serial space. Date.UTC maps years
 * 0–99 into 1900–1999; shifting by a Gregorian 400-year cycle avoids that. */
export function ymdToSerial(y, m, d) {
  const shift = y >= 0 && y < 100 ? 146097 : 0;
  const first = Math.round((Date.UTC(shift ? y + 400 : y, m - 1, 1) - EPOCH_MS) / DAY_MS) - shift;
  return first - (first < 61 ? 1 : 0) + d - 1;
}

export function serialToYMD(serial) {
  const day = Math.floor(serial);
  // The serial calendar keeps Lotus's weekday sequence even before March 1900; deriving
  // it from a Gregorian Date would change existing WEEKDAY and workday results.
  const weekday = ((day + 6) % 7 + 7) % 7;
  if (day === 0) return { y: 1900, m: 1, d: 0, weekday };
  if (day === 60) return { y: 1900, m: 2, d: 29, weekday };
  const dt = serialToDate(day);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), weekday };
}

/** The first serial past the calendar (10000-01-01): no date or clock format can show it. */
export const CALENDAR_END = ymdToSerial(10000, 1, 1);

/** Today's date as a serial, in the user's local calendar. */
export function todaySerial(now = new Date()) {
  return ymdToSerial(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function nowSerial(now = new Date()) {
  const dayStart = todaySerial(now);
  const ms = now.getHours() * 3600000 + now.getMinutes() * 60000 + now.getSeconds() * 1000 + now.getMilliseconds();
  return dayStart + ms / DAY_MS;
}

const ISO_DATE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
// Minutes and seconds may be a single digit, so 1:5 reads as 1:05; a bare a or p marks the half of the day (1:30p).
// Hours run to four digits for an elapsed time (100:00:30), taken up to 9999:59:59. A fraction of a
// second follows a point, or the comma of a regional format whose decimal mark it is (12:00:00,5 as TEXT prints it there).
const TIME_RE = /^(\d{1,4}):(\d{1,2})(?::(\d{1,2}(?:[.,]\d+)?))?\s*([AaPp][Mm]?)?$/;
const MAX_ELAPSED_HOURS = 9999;
// An hour with its half of the day and no minutes, "3 pm", "12am", "3 p": a bare a or p counts only after a
// space, so a "3A" or "3p" typed as a label stays text.
const HOUR_MERIDIEM_RE = /^(\d{1,2})(?:\s*([AaPp][Mm])|\s+([AaPp]))$/;
/** The format a typed elapsed time implies; the toolbar's Duration preset is the same code. */
export const ELAPSED_TIME_CODE = '[h]:mm:ss';

/** "3 pm" as TIME_RE would match "3:00 pm": the hour, no minutes or seconds, and its half of the day; null for anything else. */
function hourMeridiem(t) {
  const m = HOUR_MERIDIEM_RE.exec(t);
  return m ? [m[0], m[1], '0', undefined, m[2] || m[3]] : null;
}

/**
 * "13:45", "1:45 pm", "09:05:30", "13:30:00.5", "1:5", "1:30p", "3 pm" → fraction of a day, or null. Minutes
 * and seconds past 59 carry over, so 0:90 reads as 1:30 and 1:30:60 as 1:31:00; a time with
 * AM or PM is a clock reading and keeps them under sixty, and needs no minutes at all, as in "3 pm".
 * With `elapsed`, hours count on past 23 up to 9999, so "25:30" is the 1.0625 days a typed cell reads it as,
 * and so is a "23:60" that carries into the next day; a time with AM or PM never does. A caller reading a
 * time of day leaves it off.
 */
export function parseTime(text, { elapsed = false } = {}) {
  const t = normalizeNumberDigits(String(text).trim());
  const m = TIME_RE.exec(t) || hourMeridiem(t);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2]);
  // Seconds may carry a fraction, as in 13:30:00.5; after a comma only where the regional format's decimal mark is one.
  if (m[3]?.includes(',') && localeInfo().decimal !== ',') return null;
  const sec = m[3] ? Number(m[3].replace(',', '.')) : 0;
  const ampm = m[4]?.[0].toLowerCase();
  if (ampm) {
    if (h < 1 || h > 12 || mi > 59 || sec >= 60) return null;
    if (ampm === 'p' && h < 12) h += 12;
    if (ampm === 'a' && h === 12) h = 0;
  } else if (h > (elapsed ? MAX_ELAPSED_HOURS : 23)) return null;
  const total = h * 3600 + mi * 60 + sec;
  // A time of day stays within its day: 23:60 is the next day's midnight, which only an elapsed reading counts.
  if (!elapsed && !ampm && total >= 86400) return null;
  return total / 86400;
}
const SLASH_DATE_RE = /^(\d{1,4})[\/-](\d{1,2})(?:[\/-](\d{1,4}))?$/;
const DOTTED_DATE_RE = /^(\d{1,4})[\/.-] ?(\d{1,2})(?:[\/.-] ?(\d{1,4}))?$/; // 28.08.2026 (and Czech's 28. 8. 2026), where the decimal mark is a comma
// A trailing decimal mark ("5.") is a number; a lone mark is not.
const NUMERIC_RE = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d*)?(?:[eE][-+]?\d+)?$/;
// Comma-decimal locales: groups by period, space, or apostrophe; the decimal mark is a comma.
const COMMA_NUMERIC_RE = /^[-+]?(?:\d{1,3}(?:[.\s\u00a0\u202f']\d{3})+|\d+)?(?:,\d*)?(?:[eE][-+]?\d+)?$/;
// Indian grouping, where the locale writes it (en-IN shows 12,34,567 and must read it back).
const LAKH_NUMERIC_RE = /^[-+]?\d{1,2}(?:,\d{2})*,\d{3}(?:\.\d*)?(?:[eE][-+]?\d+)?$/;

/** Is `body` a number in the locale's notation? Returns the number or null. */
function localeNumber(body, info, numericParser = parseFloat) {
  if (!/\d/.test(body)) return null;
  if (info.decimal === ',') {
    if (!COMMA_NUMERIC_RE.test(body)) return null;
    const n = numericParser(body.replace(/[.\s\u00a0\u202f']/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  if (!NUMERIC_RE.test(body) && !(info.lakh && LAKH_NUMERIC_RE.test(body))) return null;
  const n = numericParser(body.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
const currencyLabelsCache = new Map();
/** The label Intl writes for a currency in a locale, in the given display (symbol or narrowSymbol), or null. */
function intlCurrencyLabel(loc, cur, currencyDisplay) {
  try {
    return new Intl.NumberFormat(loc, { style: 'currency', currency: cur, currencyDisplay }).formatToParts(1).find((p) => p.type === 'currency')?.value ?? null;
  } catch { return null; }
}
/**
 * The labels an amount may carry in a regional format, longest first, each with its currency: for every
 * currency on offer, the picker's own sign, the ISO code (which the Currency format prints for a foreign
 * currency in Italian or Norwegian), the symbol Intl writes in the regional format, as the format prints it
 * (US$ in Britain, $US in France, JP¥ in China, kr in Sweden, 元 in Japan), and its narrow form. A label
 * several currencies share ($, ¥, kr) is the regional format's own currency where that is one of them (AUD in
 * Australia, CNY in China, DKK in Denmark), else the first on offer (USD, JPY, SEK), as before. The labels
 * are kept by their first and by their last character, so an entry tries only the few that could fit it.
 */
function currencyLabels(loc) {
  let table = currencyLabelsCache.get(loc);
  if (table) return table;
  const own = localeCurrency(loc);
  const byLabel = new Map();
  const claim = (label, cur) => { if (label && (!byLabel.has(label) || cur === own)) byLabel.set(label, cur); };
  for (const [cur, , sign] of CURRENCIES) {
    claim(sign, cur);
    claim(cur, cur);
    claim(intlCurrencyLabel(loc, cur, 'symbol'), cur);
    claim(intlCurrencyLabel(loc, cur, 'narrowSymbol'), cur);
  }
  // The full-width yen sign the Japanese regional format writes is the yen sign wherever it is typed.
  claim('￥', byLabel.get('¥'));
  const labels = [...byLabel].sort((a, b) => b[0].length - a[0].length);
  const bucket = (map, key, entry) => { const list = map.get(key); if (list) list.push(entry); else map.set(key, [entry]); };
  table = { first: new Map(), last: new Map() };
  for (const entry of labels) { bucket(table.first, entry[0][0], entry); bucket(table.last, entry[0].at(-1), entry); }
  currencyLabelsCache.set(loc, table);
  return table;
}

/**
 * `body` without the currency label at its start or end, and the currency the label names, or null when it
 * carries none. A minus may come before the label (-$5, -US$ 1.234,50) or after it ($-5, US$ -1.234,50).
 */
function stripCurrencyLabel(body, loc) {
  const { first, last } = currencyLabels(loc);
  const sign = body[0] === '-' || body[0] === '+' ? body[0] : '';
  const head = sign ? body.slice(1).trimStart() : body;
  for (const [label, cur] of first.get(head[0]) || []) {
    if (head.startsWith(label)) return { body: sign + head.slice(label.length).trimStart(), currency: cur };
  }
  for (const [label, cur] of last.get(body.at(-1)) || []) {
    if (body.endsWith(label)) return { body: body.slice(0, -label.length).trimEnd(), currency: cur };
  }
  return null;
}

const formulaCurrencyCache = new Map();
function formulaCurrencies(loc) {
  let labels = formulaCurrencyCache.get(loc);
  if (labels) return labels;
  // Formula conversion recognizes the regional currency in its usual position,
  // plus the euro on either side. Cell entry deliberately accepts a wider set
  // of currency symbols and ISO labels so formatted displays can be pasted.
  const parts = new Intl.NumberFormat(loc, { style: 'currency', currency: localeCurrency(loc), maximumFractionDigits: 0 }).formatToParts(1);
  const index = parts.findIndex(part => part.type === 'currency');
  labels = { prefix: ['€'], suffix: ['€'] };
  const digits = parts.findIndex(part => part.type === 'integer');
  const side = index < digits ? 'prefix' : 'suffix';
  const symbol = parts[index]?.value;
  labels.affixes = Object.freeze({
    prefix: parts.slice(0, digits).map(part => part.value).join(''),
    suffix: parts.slice(digits + 1).map(part => part.value).join(''),
  });
  if (symbol) {
    // Keep the region's own separator as part of its currency token. A German
    // NBSP before € is valid; it is not general whitespace cleanup in a dollar
    // locale, where the same NBSP must still fail.
    labels[side].push(labels.affixes[side], symbol);
    labels[side] = [...new Set(labels[side])].sort((a, b) => b.length - a.length);
  }
  formulaCurrencyCache.set(loc, labels);
  return labels;
}

/** Regional currency text for DOLLAR, sharing the numeric reader's tokens. */
export function formulaCurrencyAffixes(loc = locale) { return formulaCurrencies(loc).affixes; }

/**
 * Numeric formula text, separate from the forgiving cell-entry lexer. A sign
 * or one accounting pair may surround one currency/percent token in either
 * order: -$1, $-1, ($1), $(1), (1%) and %(1). Signs inside parentheses, doubled
 * tokens and currency plus percent are invalid. Only ordinary spaces separate
 * these tokens; regional grouping is still read by localeNumber.
 */
export function parseFormulaNumber(text, loc = locale, numericParser = (s, shift = 0) => parseFloat(s) * 10 ** shift) {
  const trim = value => value.replace(/^ +| +$/g, '');
  let body = trim(text), negative = false, signed = false, accounting = false, adornment = null;
  const labels = formulaCurrencies(loc);
  for (;;) {
    if (body[0] === '+' || body[0] === '-') {
      if (signed || accounting) return null;
      signed = true; negative = body[0] === '-'; body = trim(body.slice(1));
      continue;
    }
    if (body[0] === '(' && body.at(-1) === ')') {
      if (signed || accounting) return null;
      accounting = negative = true; body = trim(body.slice(1, -1));
      continue;
    }
    const prefix = body.startsWith('%') ? '%' : labels.prefix.find(label => body.startsWith(label));
    const suffix = body.endsWith('%') ? '%' : labels.suffix.find(label => body.endsWith(label));
    if (prefix || suffix) {
      if (adornment) return null;
      adornment = prefix || suffix;
      body = trim(prefix ? body.slice(prefix.length) : body.slice(0, -suffix.length));
      continue;
    }
    break;
  }
  if (body !== body.trim()) return null;
  const shift = adornment === '%' ? -2 : 0;
  let value = localeNumber(body, localeInfo(loc), s => numericParser(s, shift));
  // Mixed fractions share the same surrounding tokens. A slash without the
  // whole-number part belongs to the date parser, never a currency amount.
  if (value == null && /^\d+ \d+\/\d+$/.test(body)) {
    const fraction = parseFraction(body);
    if (fraction) value = shift ? fraction.v / 100 : fraction.v;
  }
  return value == null ? null : negative && value !== 0 ? -value : value;
}
// A whole number and a fraction, as in "1 1/2" and "-2 3/4" (a plain "1/2" is a date).
const MIXED_FRACTION_RE = /^([-+]?)(\d+)\s+(\d+)\/(\d+)$/;

/** "1 1/2" → { v: 1.5, code: '# ?/?' }, the fraction format as wide as the denominator typed, or null. */
function parseFraction(t) {
  const m = MIXED_FRACTION_RE.exec(t);
  if (!m || Number(m[4]) === 0) return null;
  const v = Number(m[2]) + Number(m[3]) / Number(m[4]);
  const places = '?'.repeat(Math.min(3, m[4].length));
  return { v: m[1] === '-' ? -v : v, code: `# ${places}/${places}` };
}
// Written-out dates: the month is a word in any alphabet (März, mars, марта), with the period an abbreviation
// may carry (Sept., mar.); the day may carry an ordinal or the period German, Danish and Finnish write (5.); the
// "de" Spanish and Portuguese put around the month and the "г." or "r." Russian and Polish end with are passed over.
// A month may be written with its own number, as Japanese, Chinese and Korean write 2月 and 2월, which is
// the name an mmm code prints there, so such a display reads back as the date it stands for.
const MONTH_FIRST_RE = /^(\d{0,2}\p{L}+)\.?[ -](\d{1,2})(?:st|nd|rd|th)?(?:,?[ -](\d{2,4}))?$/u;
const DAY_FIRST_RE = /^(\d{1,2})(?:st|nd|rd|th|\.)?(?: de)?[ -](\p{L}+)\.?(?: de)?(?:,?[ -](\d{2,4}))?(?: г\.| r\.)?$/u;
// The year-month-day of Japanese, Chinese and Korean (2023年3月15日, 2023년 3월 15일), and Korea's dotted 2023. 3. 15.
const CJK_DATE_RE = /^(\d{4})\s?[年년]\s?(\d{1,2})\s?[月월]\s?(\d{1,2})\s?[日일]$/;
const YEAR_DOTTED_RE = /^(\d{4})\.\s?(\d{1,2})\.\s?(\d{1,2})\.?$/;
// The time half of a date and time is a clock reading, or an hour with its half of the day and no minutes at
// all ("9/15/2026 3 PM"), the form a time on its own has read since HOUR_MERIDIEM_RE; a bare a or p there
// counts only after a space, as it does on its own.
const DATETIME_SPLIT_RE = /^(.+?)(?:[ T]|,\s*)(\d{1,2}:\d{1,2}(?::\d{1,2}(?:\.\d+)?)?\s*(?:[AaPp][Mm]?)?|\d{1,2}(?:\s*[AaPp][Mm]|\s+[AaPp]))$/;

function validYMD(y, m, d) {
  if (y === 1900 && m === 2 && d === 29) return true;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * "Aug", "Sept", "august", "März", "mars", "марта" → 1-12, or 0: a month name of the regional format's language,
 * in any of its forms, or an English one, whole or three letters or more of its opening. English is read in
 * every regional format, so a sheet typed in one still reads in another.
 */
function monthNumber(word, loc = locale) {
  const w = word.replace(/\.$/, '').toLowerCase();
  if (w.length < 2) return 0;
  const { months } = dateNames(loc);
  const forms = (i) => [months.long[i], months.short[i], months.inDate[i], months.shortInDate[i]].map((m) => m.replace(/\.$/, '').toLowerCase());
  let i = months.long.findIndex((_, k) => forms(k).includes(w));
  if (i < 0 && w.length >= 3) i = ENGLISH_MONTHS.findIndex((m) => m.toLowerCase().startsWith(w) || (w === 'sept' && m === 'September'));
  if (i < 0 && w.length >= 3) i = months.long.findIndex((_, k) => forms(k).some((m) => m.startsWith(w)));
  return i + 1;
}

/**
 * A typed calendar date as { serial, style }, or null when it is not a valid
 * spreadsheet date or falls before January 1900: such input stays
 * text rather than a serial no date format can show.
 */
function typedDate(y, m, d, style = null) {
  // Explicit pre-1900 years stay text, including 0–99 which Date.UTC
  // would otherwise interpret as 1900–1999.
  if (y < 1900 || !validYMD(y, m, d)) return null;
  const serial = ymdToSerial(y, m, d);
  return serial < 0 ? null : { serial, style };
}

/**
 * The last year a two-digit year can mean: 2029 reads 00–29 as 2000–2029 and 30–99 as 1930–1999. The app's
 * options set it (Edit ▸ two-digit years); it is the person's, not the workbook's.
 */
let yearCutoff = 2029;
export function setTwoDigitYearCutoff(year) {
  const n = Math.round(Number(year));
  yearCutoff = Number.isFinite(n) && n >= 2000 && n <= 2099 ? n : 2029;
}
export const twoDigitYearCutoff = () => yearCutoff;

/** A year typed with two digits, as a full year inside the hundred years that end at the cutoff. */
export function expandTwoDigitYear(n, cutoff = yearCutoff) {
  const tail = cutoff % 100;
  return n <= tail ? cutoff - tail + n : cutoff - tail - 100 + n;
}

/** Short years: inside the hundred years up to the cutoff (00–29 → 2000s, 30–99 → 1900s by default), and a single digit like the 03 it stands for. */
function fullYear(text, now) {
  if (text == null) return now.getFullYear();
  if (text.length <= 2) return expandTwoDigitYear(Number(text));
  return text.length === 4 ? Number(text) : NaN;
}

/**
 * Typed dates: ISO, month/day/year (day first when the first number cannot be
 * a month: 28/8/2026), year-first with slashes, two-digit years, a month and
 * day without a year (this year), and written-out months ("Aug 28, 2026",
 * "28 Aug 2026", "28-Aug-26", "August 28", and in the regional format's language
 * "5. März 2026", "15 mars 2023", "2023年3月15日"). Returns { serial, style } or null.
 */
export function parseDate(text, now = new Date(), loc = locale) {
  // The presets write a no-break space before a month or a year in some languages; typed text has a plain one.
  // Repeated ordinary spaces separate date components too (including text
  // assembled from a month format that already ends with a space).
  const t = normalizeNumberDigits(String(text).trim()).replace(/[  ]/g, ' ').replace(/ +/g, ' ');
  const info = localeInfo(loc);
  let m = ISO_DATE_RE.exec(t) || CJK_DATE_RE.exec(t) || YEAR_DOTTED_RE.exec(t);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return typedDate(y, mo, d, CJK_DATE_RE.test(t) ? 'long' : null);
  }
  m = (info.decimal === ',' ? DOTTED_DATE_RE : SLASH_DATE_RE).exec(t);
  if (m) {
    let y, mo, d;
    // Year-first locales (ja-JP, zh-CN, ko-KR) read 24/1/1 as 2024-01-01 when that is a date; otherwise the usual order below applies.
    if (info.yearFirst && m[1].length <= 2 && m[3] != null && m[3].length <= 2) {
      const hit = typedDate(fullYear(m[1], now), Number(m[2]), Number(m[3]));
      if (hit) return hit;
    }
    if (m[1].length === 4 && m[3] != null) { [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]; }
    else if (m[1].length <= 2 && (m[3] == null || m[3].length <= 2 || m[3].length === 4)) {
      const a = Number(m[1]); const b = Number(m[2]);
      // Month/day in the US, day/month most everywhere else; a number that cannot be a month settles it either way.
      [mo, d] = info.dayFirst ? [b, a] : [a, b];
      if (mo > 12 && d <= 12) [mo, d] = [d, mo];
      y = fullYear(m[3], now);
      if (m[3] == null && t.includes('-')) return null; // "1-2" stays text
    } else return null;
    return typedDate(y, mo, d);
  }
  const monthFirst = MONTH_FIRST_RE.exec(t);
  m = monthFirst || DAY_FIRST_RE.exec(t);
  if (m) {
    const dayFirst = !monthFirst;
    const mo = monthNumber(dayFirst ? m[2] : m[1], loc);
    const d = Number(dayFirst ? m[1] : m[2]);
    const y = fullYear(m[3], now);
    if (mo) return typedDate(y, mo, d, 'medium');
  }
  return null;
}

// A month and a year ("Feb 2024", "February 2024", "Feb-2024", "März 2024", "2月-2024"): the first of that
// month, shown as Feb-24.
const MONTH_YEAR_RE = /^(\d{0,2}\p{L}+)\.?(?:[ \u00a0\u202f]+|-)(\d{2}|\d{4})$/u;
const MONTH_YEAR_CODE = 'mmm-yy';

/** "Feb 2024" → the serial of 2024-02-01, or null. */
function parseMonthYear(t, loc = locale) {
  const m = MONTH_YEAR_RE.exec(t);
  if (!m) return null;
  // A two-digit number after a month name is the day wherever it could be one, so Feb 24 is the
  // twenty-fourth; only one no day could be is the year, so Feb 99 is February 1999.
  if (m[2].length === 2 && Number(m[2]) <= 31) return null;
  const mo = monthNumber(m[1], loc);
  return mo ? typedDate(fullYear(m[2]), mo, 1)?.serial ?? null : null;
}

/** Were seconds typed? "9:05:30" and "2024-01-15 13:45:30" show them; "13:45" does not. */
function typedSeconds(text) {
  return /\d:\d{1,2}:\d/.test(normalizeNumberDigits(String(text ?? '')));
}

/**
 * The seven error spellings read as error values when typed or found in delimited
 * text; the errors of dynamic arrays (#SPILL!, #CALC!) and this app's own stay text.
 */
export const TYPED_ERRORS = new Set(['#N/A', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#NULL!']);

/**
 * Typed text → { v, f, fmt }. `f` is the formula body (without "="), `fmt`
 * a number format the input implies (typing "12%" makes a percent cell,
 * typing a date makes a date cell; a written-out date also carries
 * `dateStyle: 'medium'` so it reads back the way it was typed, a time typed
 * with seconds carries `sec: true`, and a fraction like "1 1/2", a month
 * and year like "Feb 2024", or an elapsed time like "25:30" carries the
 * `code` of its custom format). A leading apostrophe forces text.
 */
export function parseInput(text, loc = locale) {
  if (text == null) return { v: null, f: null, fmt: null };
  const raw = String(text);
  if (raw === '') return { v: null, f: null, fmt: null };
  if (raw.startsWith("'")) return { v: raw.slice(1), f: null, fmt: 'text' };
  if (raw.startsWith('=') && raw.length > 1) return { v: null, f: raw.slice(1), fmt: null };

  const info = localeInfo(loc);
  const t = normalizeNumberDigits(raw.trim()).replace(/−/g, '-');
  const upper = t.toUpperCase();
  if (upper === 'TRUE') return { v: true, f: null, fmt: null };
  if (upper === 'FALSE') return { v: false, f: null, fmt: null };
  // A typed #N/A is the error value, so ISNA sees it and SUM stops at it; an apostrophe keeps the text.
  if (TYPED_ERRORS.has(upper)) return { v: { error: upper }, f: null, fmt: null };

  // The sign may lead, as Turkish writes %12,5 (and -%12,5), and a typed %50 reads in any regional format.
  if (t.endsWith('%') || /^[-+]?%/.test(t)) {
    const body = (t.endsWith('%') ? t.slice(0, -1) : t.replace('%', '')).trim();
    const n = body !== '' && /\d/.test(body) ? localeNumber(body, info) : null;
    if (n != null) return { v: n / 100, f: null, fmt: 'percent' };
  }

  if (/\d/.test(t)) {
    let body = t;
    let currency = null;
    let negative = false;
    // Accounting style: a number in parentheses is negative.
    if (/^\(.*\)$/.test(body)) { negative = true; body = body.slice(1, -1).trim(); }
    // The currency before or after the amount, as the regional format writes it (US$1,234.50, 1 234,50 kr,
    // 1.234,50 €, USD 1,234.50), so that the Currency format's own display reads back in every regional format.
    const labelled = stripCurrencyLabel(body, loc);
    if (labelled) ({ body, currency } = labelled);
    const n = localeNumber(body, info);
    // Typed thousands separators ask for the grouped Number format, so a typed 1,000 takes #,##0.
    const grouped = info.decimal === ',' ? /\d[.\s  ']\d/.test(body) : /\d,\d/.test(body);
    // A number typed in E notation asks for the Scientific format, so a typed 1e5 takes 0.00E+00.
    const exponent = /\d[eE][-+]?\d+$/.test(body);
    if (n != null && !(negative && n < 0)) return {
      v: negative ? -n : n, f: null, fmt: currency ? 'currency' : grouped ? 'number' : exponent ? 'scientific' : null,
      ...(currency ? { cur: currency } : {}),
    };
  }

  const fraction = parseFraction(t);
  if (fraction) return { v: fraction.v, f: null, fmt: 'custom', code: fraction.code };

  const time = parseTime(t, { elapsed: true });
  // A day or more (24:00, 25:30) is an elapsed time, shown with its hours counting on rather than as a time of day.
  if (time != null && time >= 1) return { v: time, f: null, fmt: 'custom', code: ELAPSED_TIME_CODE };
  if (time != null) return { v: time, f: null, fmt: 'time', ...(typedSeconds(t) ? { sec: true } : {}) };
  const date = parseDate(t, new Date(), loc);
  if (date) return { v: date.serial, f: null, fmt: 'date', ...(date.style ? { dateStyle: date.style } : {}) };
  const monthYear = parseMonthYear(t, loc);
  if (monthYear != null) return { v: monthYear, f: null, fmt: 'custom', code: MONTH_YEAR_CODE };
  const m = DATETIME_SPLIT_RE.exec(t);
  if (m) {
    const day = parseDate(m[1], new Date(), loc);
    const tod = parseTime(m[2]);
    if (day && tod != null) return { v: day.serial + tod, f: null, fmt: 'datetime', ...(typedSeconds(m[2]) ? { sec: true } : {}) };
  }

  return { v: raw, f: null, fmt: null };
}

/**
 * Decimal places a typed number implies for its format: none when none were
 * typed, otherwise two: 0% or 0.00% on a typed percent,
 * #,##0 or #,##0.00 on a number typed with separators and $#,##0 or
 * $#,##0.00 on a typed currency. The fraction digits follow the locale's
 * decimal mark, so "5,5%" in German keeps its half.
 */
export function typedDecimals(text, loc = locale) {
  const t = normalizeNumberDigits(String(text ?? ''));
  const i = t.indexOf(localeInfo(loc).decimal);
  return i >= 0 && /\d/.test(t[i + 1] ?? '') ? 2 : 0;
}

/** The style keys that detail a number format (decimals, currency, date style, seconds, grouping, code) and mean nothing without one. */
export const FORMAT_DETAIL_KEYS = ['dec', 'cur', 'dateStyle', 'sec', 'group', 'code'];
/** The coupled fields represented by one native number-format code. */
export const NUMBER_FORMAT_KEYS = ['fmt', ...FORMAT_DETAIL_KEYS];
/**
 * The patch that returns a cell to the Automatic format: no format, and none of the details one carries. A
 * detail left behind would otherwise pass for the cell's own choice when a later entry implies a format, so
 * that "1 1/2" typed after a Duration was reset showed 36:00:00 through the duration code that stayed.
 */
export const AUTOMATIC_FORMAT = Object.freeze({ fmt: null, ...Object.fromEntries(FORMAT_DETAIL_KEYS.map((k) => [k, null])) });

/**
 * The details typed text adds to the number format it implied, once the
 * cell's own format has had its say: a percent, a currency or a grouped number
 * shows the decimals it was typed with, a time the seconds it was typed with, a
 * fraction gets its custom code. `fmt` is the format parseInput implied; a
 * cell that kept a different format keeps it whole, so "5%" typed into a
 * currency cell only changes the value. Callers refine only a format the
 * entry itself applied: a cell the user set to Percent or Time keeps its
 * own decimals and seconds whatever is typed. Returns the style.
 */
export function refineImpliedFormat(style, fmt, text) {
  if (!style || !fmt || style.fmt !== fmt) return style;
  // A typed amount keeps the decimals it was typed with (the yen too: ¥12.50 keeps two, ¥1,000 none, its own default).
  if ((fmt === 'percent' || fmt === 'number' || fmt === 'currency') && style.dec == null) style.dec = typedDecimals(text);
  else if ((fmt === 'time' || fmt === 'datetime') && style.sec == null && typedSeconds(text)) style.sec = true;
  else if (fmt === 'custom' && style.code == null) {
    // Callers carry only the format name; the code comes from the same text.
    const { code } = parseInput(text);
    if (code) style.code = code;
  }
  return style;
}

/** Scientific notation within an unsigned field; General defaults to eleven characters. */
function generalScientific(abs, width = 11) {
  // Round in the fifteen-digit decimal space, including half-way carries.
  const [mantissa, power] = abs.toExponential(14).split('e');
  let exponent = Number(power);
  // Reserve an exponent digit at a decade boundary so a carry still fits.
  const exponentWidth = Math.max(2, String(Math.abs(exponent) + 1).length);
  const decimals = width - 4 - exponentWidth; // leading digit, point, E and sign
  const factor = 10 ** decimals;
  let rounded = Math.round(Number((Number(mantissa) * factor).toPrecision(15))) / factor;
  if (rounded === 10) { rounded = 1; exponent++; }
  const text = rounded.toFixed(decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return `${text}E${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
}

export function formatGeneral(n) {
  if (!Number.isFinite(n)) return '#NUM!';
  const abs = Math.abs(n);
  if (Number.isInteger(n) && abs < 1e11) return String(n);
  let s;
  if (abs >= 1e11 || abs < 1e-9) s = generalScientific(abs);
  else {
    const exponent = Number(abs.toExponential().split('e')[1]);
    if (abs < 1e-4) {
      // Small decimals stay fixed only when their fifteen-digit value fits
      // without display rounding; otherwise General selects scientific notation.
      const exact = Number(abs.toPrecision(15)).toFixed(14 - exponent).replace(/\.?0+$/, '');
      s = exact.length <= 11 ? exact : generalScientific(abs);
    } else {
      // The leading zero and decimal point count toward the width. Eleven
      // integer digits fit; a decimal value has at most ten significant digits.
      const decimals = Math.max(0, 9 - Math.max(0, exponent));
      const factor = 10 ** decimals;
      const rounded = Math.round(Number((abs * factor).toPrecision(15))) / factor;
      s = rounded >= 1e11 ? generalScientific(abs)
        : rounded.toFixed(decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    }
  }
  if (n < 0) s = `-${s}`;
  const { decimal } = localeInfo(locale);
  return decimal === '.' ? s : s.replace('.', decimal);
}

/**
 * A number turned into text by a formula (A1&"", CONCAT, TEXTJOIN): the 15
 * significant digits kept in a 20-character field, excluding the sign.
 * Use fixed notation when those digits fit; scientific notation reserves room
 * for the exponent and a possible carry. Native worksheet controls cover both
 * boundaries. Cell display and editing have their own formatting policies.
 */
export function formatNumberText(n) {
  if (!Number.isFinite(n)) return '#NUM!';
  const abs = Math.abs(n);
  // Text conversion flushes subnormal magnitudes but retains their
  // sign. Actual negative zero, in contrast, is written as ordinary zero.
  if (abs < 2 ** -1022) return n < 0 ? '-0' : '0';
  const width = 20;
  const [mantissa, exponent] = abs.toExponential(14).split('e');
  const digits = mantissa.replace('.', '').replace(/0+$/, '');
  const point = Number(exponent) + 1;
  const length = point <= 0 ? 2 - point + digits.length : point >= digits.length ? point : digits.length + 1;
  let text;
  if (length > width) text = generalScientific(abs, width);
  // Expand the rounded decimal digits directly. toFixed would expose extra
  // binary integer digits, and String(number) chooses JavaScript's notation.
  else if (point <= 0) text = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length) text = digits + '0'.repeat(point - digits.length);
  else text = `${digits.slice(0, point)}.${digits.slice(point)}`;
  if (n < 0) text = `-${text}`;
  const { decimal } = localeInfo(locale);
  return decimal === '.' ? text : text.replace('.', decimal);
}

/** Editing keeps the existing 15-digit input representation, including enough
 * digits to read the largest doubles back without overflowing.
 */
function formatInputNumber(n) {
  if (!Number.isFinite(n)) return '#NUM!';
  // The largest doubles round past Number.MAX_VALUE at 15 digits; their exponent form is exact enough.
  const sig = Number(n.toPrecision(15));
  let s;
  if (!Number.isFinite(sig)) s = n.toExponential(16);
  // Keep large editing values compact; formula text conversion is independent.
  else if (Math.abs(sig) >= 1e15) s = sig.toExponential(14).replace(/\.?0+e/, 'e');
  else s = String(sig);
  const m = /^(-?[\d.]+)e([+-])(\d+)$/.exec(s);
  if (m) s = `${m[1]}E${m[2]}${m[3].padStart(2, '0')}`;
  const { decimal } = localeInfo(locale);
  return decimal === '.' ? s : s.replace('.', decimal);
}

const fmtCache = new Map();
function numberFormatter(opts) {
  const key = locale + JSON.stringify(opts);
  let f = fmtCache.get(key);
  if (!f) {
    // The automatic minus is suppressed when display rounding produces
    // zero. Let Intl decide after percentage scaling and currency rounding;
    // the underlying negative value must remain available for calculations.
    f = new Intl.NumberFormat(locale, { ...opts, signDisplay: 'negative' });
    fmtCache.set(key, f);
  }
  return f;
}

// Building an Intl.DateTimeFormat costs about fifty formats' worth of time; a column of
// medium or long dates shares one per locale and style, as the number formats do.
const dateFmtCache = new Map();
function dateFormatter(dateStyle) {
  const key = `${locale} ${dateStyle}`;
  let f = dateFmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { dateStyle, timeZone: 'UTC' });
    dateFmtCache.set(key, f);
  }
  return f;
}

/** Clock fields round in serial space to whole seconds, even when
 * seconds are hidden. Keep this separate from serialToYMD: date arithmetic
 * such as EDATE truncates the original day instead. Adding the half second
 * before splitting also keeps the floating-point tie behavior workbooks expect. */
export function serialClock(serial) {
  const rounded = serial + 0.5 / 86400;
  const day = Math.floor(rounded);
  return { day, seconds: Math.floor((rounded - day) * 86400) };
}

export function formatDate(serial, dateStyle = 'iso') {
  if (!Number.isFinite(serial)) return '#NUM!';
  if (serial < 0) return '#####'; // before the calendar's day zero
  const { day: shownDay } = serialClock(serial);
  const { y, m, d } = serialToYMD(shownDay);
  if (!Number.isFinite(y) || y > 9999) return '#####';
  if (!dateStyle || dateStyle === 'iso') return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const formatter = dateFormatter(dateStyle === 'long' ? 'long' : 'medium');
  if (shownDay !== 0 && shownDay !== 60) return formatter.format(serialToDate(shownDay));
  // Intl handles localized order, month names and punctuation. Give it a
  // representable day in the same month, then replace only the day field for
  // The serial calendar's January 0 and February 29 (1900), including localized digits.
  const dt = new Date(Date.UTC(y, m - 1, Math.min(28, Math.max(1, d))));
  const day = new Intl.NumberFormat(locale, { useGrouping: false }).format(d);
  return formatter.formatToParts(dt)
    .map(part => part.type === 'day' ? day : part.value).join('');
}

/** The time-of-day part of a serial as HH:MM (or HH:MM:SS when `seconds`). */
export function formatTime(serial, seconds = false) {
  if (!Number.isFinite(serial)) return '#NUM!';
  if (serial < 0) return '#####'; // a negative time has no clock reading
  const { day, seconds: total } = serialClock(serial);
  if (day >= CALENDAR_END) return '#####'; // including a carry past the final day
  const h = Math.floor(total / 3600);
  const mi = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const base = `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
  return seconds ? `${base}:${String(sec).padStart(2, '0')}` : base;
}

// Styles may come from imported metadata or another app's clipboard.
// Keep options within the range supported by every target browser's Intl.
function decimalPlaces(value) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : 2;
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_DECIMAL_PLACES, Math.trunc(n))) : 2;
}
const currencyCode = (value) => typeof value === 'string' && /^[a-z]{3}$/i.test(value) ? value.toUpperCase() : 'USD';

const currencyLabelCache = new Map();
/** A distinct currency label, including spacing, for portable number-format codes. */
export function currencyFormatLabel(value) {
  const currency = currencyCode(value);
  if (!currencyLabelCache.has(currency)) {
    // Portable format codes need distinct labels (CA$, CN¥, etc.), even
    // where the current locale uses the same local symbol for several currencies.
    const parts = new Intl.NumberFormat('en-US', { style: 'currency', currency }).formatToParts(0);
    currencyLabelCache.set(currency, parts.filter((p) => p.type === 'currency' || p.type === 'literal').map((p) => p.value).join(''));
  }
  return currencyLabelCache.get(currency);
}

/** A currency label without the spacing baked into it, so the regional format's own spacing can go beside it. */
const bareLabel = (label) => String(label).replace(/^[\s  ]+|[\s  ]+$/g, '');

const currencyAffixCache = new Map();
/**
 * Where a currency's label sits in a regional format, as the affixes of a number-format code:
 * a frozen { prefix, suffix }, one of them always empty. Every code this app writes for an amount in a
 * currency — the Currency format, the Accounting preset, the negative-style codes of Format cells — puts
 * the label through here, so they all lay a cell out the same way and a cell keeps its layout through a
 * save, a paste and a reload. Build a section by quoting whichever affix is there:
 *
 *   const { prefix, suffix } = currencyAffixes(cur);
 *   `${prefix ? `"${prefix}"` : ''}#,##0.00${suffix ? `"${suffix}"` : ''}`
 *   // en-US: "$"#,##0.00      de-DE: #,##0.00" €"      nl-NL: "€ "#,##0.00
 *
 * Two things that look like details and are not:
 *
 * - **The spacing is the regional format's own, and is rarely an ordinary space.** It comes from the
 *   literals Intl.NumberFormat writes between the amount and the symbol: a no-break space (U+00A0) in
 *   German, Dutch and most of Europe, a narrow one (U+202F) in a few, nothing at all in American English.
 *   These are indistinguishable from U+0020 in a log or a diff, so never substitute one; take the affix
 *   as it comes and quote it whole.
 * - **The label's own spacing is stripped before the format's is applied.** currencyFormatLabel bakes in
 *   the space a prefix needs ("NOK "), which flipped to the suffix side would read 1.234,50 NOK␣ with
 *   a stray space at the end. Only the bare label crosses sides; the gap is then taken from the regional
 *   format, and a label of letters keeps a separator even where the format writes its own symbol tight
 *   against the digits, since TRY1.234,50 would read as one word.
 *
 * The label stays the **portable** one (currencyFormatLabel: "$", "CA$", "SEK") rather than the one the
 * regional format renders. This is deliberate and should not be "fixed": rendered labels are ambiguous —
 * kr is the Swedish, Danish and Norwegian krone, ¥ and ￥ the yen and the yuan — so a code written under
 * one regional format would name a different currency when another read it back, and losing a cell's
 * currency is a worse defect than a foreign amount reading $1,234.50 where the cell shows US$1,234.50.
 * Workbook files keep identity the same way, with an [$…-409] tag rather than a rendered label.
 *
 * So what a code is held to is the **side and the spacing**, not the glyph: the label goes where the
 * regional format puts it, with the space that format uses, and the glyph stays the portable one whatever
 * the cell renders. The two agree in about half the regional formats (a euro is € in German, a dollar $ in
 * American English) and differ in the rest, where Swedish shows kr for the SEK a code names and Turkish ₺
 * for TRY — that difference is the paragraph above at work, not a bug to chase. The invariant worth testing
 * is that a section built from these affixes is character for character what styleToNumFmt writes for the
 * same style, so two codes for one cell can never disagree. A German euro cell that reads 1.234,50 € in
 * the grid exports and copies with its label after the digits, as German currency formats write
 * it, rather than in front of them, which opened that sheet in Excel as €1.234,50.
 */
export function currencyAffixes(value, loc = locale) {
  const currency = currencyCode(value);
  const key = `${loc} ${currency}`;
  let affixes = currencyAffixCache.get(key);
  if (affixes) return affixes;
  const portable = currencyFormatLabel(currency);
  const label = bareLabel(portable);
  // A label of letters (CHF, SEK, TRY) keeps the space that holds it off the digits even where the regional
  // format writes its own symbol tight against them, since TRY1.234,50 would read as one word.
  const keptApart = portable.slice(label.length);
  let leading = true;
  let spacing = '';
  try {
    const parts = new Intl.NumberFormat(loc, { style: 'currency', currency }).formatToParts(1);
    const at = parts.findIndex((p) => p.type === 'currency');
    const digits = parts.findIndex((p) => p.type === 'integer');
    if (at >= 0 && digits >= 0) {
      leading = at < digits;
      spacing = (leading ? parts.slice(at + 1, digits) : parts.slice(digits, at)).filter((p) => p.type === 'literal').map((p) => p.value).join('');
    }
  } catch { /* an Intl that does not know the currency keeps the label in front, as before */ }
  const gap = spacing || keptApart;
  // Frozen: one object is shared by every caller for a currency and a regional format.
  affixes = Object.freeze(leading ? { prefix: label + gap, suffix: '' } : { prefix: '', suffix: gap + label });
  currencyAffixCache.set(key, affixes);
  return affixes;
}

const currencyDecimalsCache = new Map();
/**
 * Decimal places a currency is written with when its style names none: two for most, none for one without
 * a minor unit (the yen, the won, the dong), so the yen is written
 * ¥1,000. Read from the Intl data the display formats with.
 */
export function currencyDecimals(value) {
  const currency = currencyCode(value);
  if (!currencyDecimalsCache.has(currency)) currencyDecimalsCache.set(currency, new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits);
  return currencyDecimalsCache.get(currency);
}

export function formatScientific(n, dec = 2) {
  if (!Number.isFinite(n)) return '#NUM!';
  // The custom-code path rounds on the value's 15 significant decimal digits,
  // as the Number format does (1.005 → 1.01E+00, not the binary 1.00E+00),
  // and prints a two-digit exponent: 1.23E+03.
  const places = decimalPlaces(dec);
  return formatWithCode(n, `0${places ? `.${'0'.repeat(places)}` : ''}E+00`);
}

/**
 * Display text for a value under a style. Errors are { error } objects;
 * booleans use TRUE/FALSE in a custom code's text section; null is empty.
 */
export function formatValue(value, style) {
  if (value == null) return '';
  if (typeof value === 'object') return value.error || (value.sparkline || value.image ? '' : '#VALUE!');
  const fmt = style?.fmt || 'general';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return fmt === 'custom' && style?.code ? formatWithCode(value, style.code) : typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : value;
  }
  if (!Number.isFinite(value)) return '#NUM!';
  if (value === 0) value = 0; // -0 (from =-A1 or a rounding) reads 0.00, not -0.00

  // A currency without a minor unit (the yen, the won) is written without decimals unless the style asks for some.
  const dec = decimalPlaces(style?.dec ?? (fmt === 'currency' ? currencyDecimals(style?.cur) : undefined));
  switch (fmt) {
    case 'number':
      return numberFormatter({ minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: style?.group !== false }).format(value);
    case 'currency':
      return numberFormatter({ style: 'currency', currency: currencyCode(style?.cur), minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: style?.group !== false }).format(value);
    case 'percent':
      return numberFormatter({ style: 'percent', minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: style?.group !== false }).format(value);
    case 'date':
      return formatDate(value, style?.dateStyle);
    case 'time':
      return formatTime(value, !!style?.sec);
    case 'datetime': {
      const day = formatDate(value, style?.dateStyle);
      return day === '#####' ? day : `${day} ${formatTime(value, !!style?.sec)}`;
    }
    case 'scientific':
      return formatScientific(value, dec);
    case 'text':
      return formatGeneral(value);
    case 'custom':
      return style?.code ? formatWithCode(value, style.code) : formatGeneral(value);
    default:
      return formatGeneral(value);
  }
}

/**
 * What the editor shows when a cell is opened for editing: the formula
 * with its "=", or the raw value. Percent cells edit as "12%" so the number
 * the user sees is the number they typed.
 */
export function editText(cell) {
  if (!cell) return '';
  if (cell.f != null) return `=${cell.f}`;
  const v = cell.v;
  if (v == null) return '';
  // An error constant edits as its code, which a commit reads back as the error, as the formula bar shows
  // it; one a typed cell cannot spell (#SPILL!, #CYCLE!) needs a formula literal to stay an error, not text.
  if (typeof v === 'object' && v.error) return TYPED_ERRORS.has(v.error) ? v.error : `=${v.error}`;
  // A picture placed in the cell has no text to edit; an entry left as it is keeps the picture.
  if (typeof v === 'object' && typeof v.image === 'string') return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'string') {
    // A Plain text cell shows its text as it is; elsewhere an apostrophe marks
    // text that would otherwise read back as a number, date, or formula.
    if (cell.s?.fmt === 'text') return /^[=']/.test(v) ? `'${v}` : v;
    return /^[=']/.test(v) || parseInput(v).v !== v ? `'${v}` : v;
  }
  const fmt = cell.s?.fmt;
  if (fmt === 'custom') {
    // Only a selected section that scales by percent edits as a percentage.
    // Scientific percent signs do not turn a raw 2.75 into an editable 275%.
    if (codeScalesPercent(v, cell.s.code)) return editText({ ...cell, s: { ...cell.s, fmt: 'percent' } });
    const kind = dateTimeKind(cell.s, v);
    if (kind) {
      // Keep the raw serial when readable input would lose hidden time,
      // fractional seconds, or elapsed days; the clock reading falls back to the
      // number itself, which is no answer here.
      const text = editText({ ...cell, s: { fmt: kind } });
      if (text !== formatInputNumber(v) && parseInput(text).v === v) return text;
      // Where a clock reading cannot hold the value, the code's own text can: a Duration cell edits as the
      // 25:30:00 it shows, which a typed elapsed time reads back exactly, not as the 1.0625 days it stores.
      const shown = formatWithCode(v, cell.s.code);
      if (parseInput(shown).v === v) return shown;
    }
  }
  // Editing shows the number to 15 significant digits, so opening a cell
  // and pressing Enter does not round its value.
  // Readable date and time text shows only what the format shows; when that
  // would drop a hidden time of day, fractional seconds, or whole days from a
  // time, the raw serial is edited instead so Enter leaves the value alone.
  if (fmt === 'percent') return `${formatInputNumber(v * 100)}%`;
  let text = null;
  if (fmt === 'date') text = formatDate(v, 'iso');
  else if (fmt === 'time') text = formatTime(v, true);
  else if (fmt === 'datetime') text = `${formatDate(v, 'iso')} ${formatTime(v, true)}`;
  if (text != null) {
    const back = parseInput(text).v;
    // Within a tenth of a millisecond is the same moment; floating-point noise must not force the serial.
    if (typeof back === 'number' && Math.abs(back - v) < 1e-9) return text;
  }
  return formatInputNumber(v);
}

/** Alignment a value gets when the style does not force one. */
export function defaultAlign(value) {
  if (typeof value === 'number') return 'right';
  if (typeof value === 'boolean') return 'center';
  if (value && typeof value === 'object') return 'center';
  return 'left';
}

/** Extra aligned offset, in addition to ordinary padding; centered cells ignore it. */
export function indentWidth(value, style, unit = 12) {
  return (style?.align || defaultAlign(value)) === 'center' ? 0 : (style?.indent || 0) * unit;
}

/* ---------- Number-format codes (file interchange) ---------- */

/** Date/time semantics for both named styles and custom format sections. */
export function dateTimeKind(style, value = 0) {
  if (style?.fmt === 'custom') return codeDateKind(value, style.code);
  return ['date', 'time', 'datetime'].includes(style?.fmt) ? style.fmt : null;
}

/**
 * A piece of a date code's text, quoted where it holds a letter that would otherwise read as a date letter.
 * A narrow no-break space is written as a plain one, the space Intl's own formatter puts there (the Russian
 * " г." after the year), so the code prints the date exactly as the cell shows it.
 */
const dateLiteral = (text) => {
  const plain = text.replace(/ /g, ' ');
  return /\p{L}/u.test(plain) ? `"${plain.replace(/"/g, '')}"` : plain;
};

const dateCodeCache = new Map();
/**
 * The format code for a date style: the order, separators and padding the regional format writes, behind
 * the [$-…] tag that tells another reader whose month names to print. So a British 15 Mar 2023 exports and
 * copies as [$-809]d mmm yyyy and stays the fifteenth of March in Excel, instead of the American mmm d,
 * yyyy that reordered it to Mar 15, 2023. The American codes keep the bare spelling they always had, and
 * the plain Date style stays ISO, as it shows in every regional format.
 */
function dateFormatCode(dateStyle, loc = locale) {
  if (dateStyle !== 'medium' && dateStyle !== 'long') return 'yyyy-mm-dd';
  const key = `${loc} ${dateStyle}`;
  let code = dateCodeCache.get(key);
  if (code === undefined) dateCodeCache.set(key, code = buildDateFormatCode(dateStyle, loc));
  return code;
}

function buildDateFormatCode(dateStyle, loc) {
  const american = dateStyle === 'long' ? 'mmmm d, yyyy' : 'mmm d, yyyy';
  let parts;
  try {
    // A day and a month below ten show whether the regional format pads them: 05.03.2023 against 5.3.2023.
    parts = new Intl.DateTimeFormat(loc, { dateStyle, timeZone: 'UTC' }).formatToParts(new Date(Date.UTC(2023, 2, 5)));
  } catch { return american; }
  let out = '';
  for (const part of parts) {
    const digits = part.type === 'literal' ? '' : /^\d+/.exec(part.value)?.[0] ?? '';
    if (part.type === 'month' && !digits) { out += dateStyle === 'long' ? 'mmmm' : 'mmm'; continue; }
    if (!digits) { out += dateLiteral(part.value); continue; }
    out += part.type === 'year' ? (digits.length === 2 ? 'yy' : 'yyyy')
      : part.type === 'day' ? (digits.length === 2 ? 'dd' : 'd')
        : part.type === 'month' ? (digits.length === 2 ? 'mm' : 'm') : dateLiteral(digits);
    // A part may carry its own unit after the number, as Korean writes the month 3월.
    const rest = part.value.slice(digits.length);
    if (rest) out += dateLiteral(rest);
  }
  return out ? localeTag(loc) + out : american;
}

/** Our style → an Excel number format code, as the regional format `loc` writes dates and currency. */
export function styleToNumFmt(style, loc = locale) {
  const fmt = style?.fmt || 'general';
  const dec = decimalPlaces(style?.dec ?? (fmt === 'currency' ? currencyDecimals(style?.cur) : undefined));
  const zeros = dec > 0 ? `.${'0'.repeat(dec)}` : '';
  const digits = `${style?.group === false ? '0' : '#,##0'}${zeros}`;
  switch (fmt) {
    case 'number': return digits;
    case 'currency': {
      const { prefix, suffix } = currencyAffixes(style?.cur, loc);
      return `${prefix ? `"${prefix}"` : ''}${digits}${suffix ? `"${suffix}"` : ''}`;
    }
    case 'percent': return `${digits}%`;
    case 'date': return dateFormatCode(style?.dateStyle, loc);
    case 'time': return style?.sec ? 'hh:mm:ss' : 'hh:mm';
    case 'datetime': return `${dateFormatCode(style?.dateStyle, loc)} ${style?.sec ? 'hh:mm:ss' : 'hh:mm'}`;
    case 'scientific': return `0${zeros}E+00`;
    case 'text': return '@';
    case 'custom': return style?.code || 'General';
    default: return 'General';
  }
}

const DATE_STYLES = [
  { fmt: 'date' }, { fmt: 'date', dateStyle: 'medium' }, { fmt: 'date', dateStyle: 'long' },
  { fmt: 'time' }, { fmt: 'time', sec: true }, { fmt: 'datetime' }, { fmt: 'datetime', sec: true },
  { fmt: 'datetime', dateStyle: 'medium' }, { fmt: 'datetime', dateStyle: 'medium', sec: true },
  { fmt: 'datetime', dateStyle: 'long' }, { fmt: 'datetime', dateStyle: 'long', sec: true },
];
const dateFormatStylesCache = new Map();
/**
 * The named date and time styles by the code each of them writes in a regional format. Where two styles
 * write the same code — Chinese spells a written-out date and a long one alike — the first of them stands,
 * since both show the date the same way.
 */
function dateFormatStyles(loc) {
  let map = dateFormatStylesCache.get(loc);
  if (!map) {
    map = new Map();
    for (const style of DATE_STYLES) {
      const code = styleToNumFmt(style, loc).toLowerCase();
      if (!map.has(code)) map.set(code, style);
    }
    dateFormatStylesCache.set(loc, map);
  }
  return map;
}
const CURRENCIES_BY_FORMAT_LABEL = new Map(CURRENCIES.map(([cur]) => [bareLabel(currencyFormatLabel(cur)), cur]));
const SPACING_RE = /[\s  ]/;
/**
 * The currency a format code's quoted label names, or undefined. The label is the portable, distinct one,
 * with whatever spacing the regional format that wrote the code put between it and the digits — none in
 * "€"#,##0.00, a no-break space in #,##0.00" €", both of them euros. A label of letters keeps the space
 * that holds it off the digits ("CHF "#,##0.00, #,##0.00" CHF"), since a bare "CHF"0.00 is a code this app
 * never writes and cannot show that way.
 */
function currencyForLabel(label, leading) {
  const cur = CURRENCIES_BY_FORMAT_LABEL.get(bareLabel(label));
  if (!cur) return undefined;
  const needsSpace = currencyFormatLabel(cur) !== bareLabel(currencyFormatLabel(cur));
  const spaced = SPACING_RE.test(leading ? label.at(-1) : label[0]);
  return !needsSpace || spaced ? cur : undefined;
}

/** Codes this app can express as one of its named formats; anything else stays a custom code. */
const SIMPLE_CODES = [
  /^General$/i,
  /^#,##0(\.0+)?$/, /^0(\.0+)?$/,
  /^(#,##)?0(\.0+)?%$/,
  /^"[$€£¥]"(#,##)?0(\.0+)?$/, /^[$€£¥](#,##)?0(\.0+)?$/,
  /^0(\.0+)?E\+00$/,
  /^@$/,
];

/** An Excel number format code → the closest style fields, or null for General (and for a code longer than the file format allows). */
export function numFmtToStyle(z) {
  if (!z || z === 'General') return null;
  const code = String(z);
  // Excel refuses a code past 255 characters, so a longer one comes from another producer or by
  // design; showing a number through it costs milliseconds a cell, enough to freeze the grid.
  if (code.length > MAX_FORMAT_CODE_LENGTH) return null;
  // Other writers (ODF) quote the separators of a date code: yyyy"-"mm"-"dd is the same date.
  // Only the preset lookup sees the unquoted form; any other code keeps its quotes, so a
  // custom 00"-"000 is exported exactly as it came in.
  const spelled = code.replace(/"([-/:. ])"/g, '$1').toLowerCase();
  // A date code written in a regional format carries that format's [$-…] tag, so the order it spells is read
  // back as the named style it stood for: a German [$-407]dd.mm.yyyy is the same Date preset as mmm d, yyyy.
  const tagged = LOCALES.some(([name]) => name === codeLocale(code)) ? codeLocale(code) : null;
  const dateStyle = dateFormatStyles('en-US').get(spelled) || (tagged ? dateFormatStyles(tagged).get(spelled) : null);
  if (dateStyle) return { ...dateStyle };
  // The label may lead the digits or trail them, as the regional formats write it ("€"#,##0.00 and
  // #,##0.00" €" are the same Currency format, the second the way German and French sheets export it).
  const leadingCurrency = /^"([^"]+)"((?:#,##)?0)(?:\.(0+))?$/.exec(code);
  const trailingCurrency = leadingCurrency ? null : /^((?:#,##)?0)(?:\.(0+))?"([^"]+)"$/.exec(code);
  const currency = leadingCurrency ? { cur: currencyForLabel(leadingCurrency[1], true), digits: leadingCurrency[2], dec: leadingCurrency[3] }
    : trailingCurrency ? { cur: currencyForLabel(trailingCurrency[3], false), digits: trailingCurrency[1], dec: trailingCurrency[2] } : null;
  if (currency?.cur && (currency.dec?.length || 0) <= MAX_DECIMAL_PLACES) {
    return { fmt: 'currency', cur: currency.cur, dec: currency.dec?.length || 0, ...(currency.digits.includes(',') ? {} : { group: false }) };
  }
  // Preserve sections, currency labels, exponent widths, and spacing that
  // the named styles cannot represent.
  if (!SIMPLE_CODES.some((re) => re.test(code))) return { fmt: 'custom', code };
  const decimals = (() => {
    const m = /0\.(0+)/.exec(code);
    return m ? m[1].length : 0;
  })();
  if (decimals > MAX_DECIMAL_PLACES) return { fmt: 'custom', code };
  if (code.includes('@')) return { fmt: 'text' };
  if (/E[+-]/i.test(code)) return { fmt: 'scientific', dec: decimals };
  const grouping = code.includes(',') ? {} : { group: false };
  if (code.includes('%')) return { fmt: 'percent', dec: decimals, ...grouping };
  if (/[$€£¥]/.test(code) || /\[\$/.test(code)) {
    const cur = code.includes('€') ? 'EUR' : code.includes('£') ? 'GBP' : code.includes('¥') ? 'JPY' : 'USD';
    return { fmt: 'currency', dec: decimals, cur, ...grouping };
  }
  const stripped = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
  if (/[#0]/.test(stripped)) return { fmt: 'number', dec: decimals, group: stripped.includes(',') };
  return null;
}
