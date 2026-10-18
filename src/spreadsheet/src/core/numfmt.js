/**
 * Number format codes (the SpreadsheetML numFmt syntax): "#,##0.00", "0%", "yyyy-mm-dd",
 * "[Red]-0.0;0.0", "0.00E+00", "$#,##0_);($#,##0)", "@", ...
 *
 * formatWithCode(value, code) → width-independent text. Up to four sections
 * separated by ";" (positive; negative; zero; text), quoted literals,
 * backslash escapes, "_x" padding (rendered as a space), "*x" fill
 * (dropped), digits 0 # ?, thousands separators, trailing-comma scaling,
 * percent, scientific notation, dates and times (including elapsed [h]),
 * and text with "@". Bracketed conditions select numeric sections;
 * codeColor resolves the selected section's named or indexed color.
 * formatCodeParts retains padding/fill instructions for measured cell layout.
 */

import { formatGeneral, serialToYMD, ymdToSerial, localeInfo, dateNames, getLocale, CALENDAR_END } from './format.js';
import { hijriDate, hijriNames } from './hijri.js';
import { sakaDate, sakaNames } from './saka.js';
import { persianDate, persianNames } from './persian.js';
import { umalquraDate } from './umalqura.js';
import { hebrewDate, hebrewNames, hebrewLegacyWeekday, HEBREW_NAME_YEAR_END } from './hebrew.js';
import { isLunisolarCalendar, lunisolarDate, lunisolarNames, lunisolarLegacyWeekday } from './lunisolar.js';
import { DEFAULT_COLOR_PALETTE } from './font-color.js';
import { numberShape, shapeDigits, shapeDateField, expandedGeneral, shapeGeneral, normalizeNumberDigits } from './number-shape.js';

/** The most characters a format code may have (the .xlsx limit); a longer one is refused wherever codes come in. */
export const MAX_FORMAT_CODE_LENGTH = 255;
// Keep an unrepresentable value distinct from literal hash signs in a format.
// Cells display hashes, while TEXT must return a formula error.
const FORMAT_OVERFLOW = Symbol('format overflow');
const UNSIGNED_ZERO = Symbol('rounded unsigned zero');
// The legacy B2 initial-weekday name path accepts Hijri years through 8999.
// Numeric-first and month-first paths do not have this name-service limit.
const LEGACY_HIJRI_WEEKDAY_YEAR_END = 9000;
// Solar calendars with the Gregorian month/day structure and a shifted epoch.
const CALENDAR_YEAR_OFFSETS = { 5: 2333, 7: 543 };
// The eras of the Japanese calendar, latest first, each from its first Gregorian
// day: g prints the initial, gg the first character, ggg the name, and e the year within the era.
// Built on first use, since format.js imports this module and its day arithmetic is not ready at load.
let japaneseEras = null;
function japaneseEra(serial) {
  japaneseEras ??= [[2019, 5, 1, 'R', '令', '令和'], [1989, 1, 8, 'H', '平', '平成'], [1926, 12, 25, 'S', '昭', '昭和'], [1912, 7, 30, 'T', '大', '大正'], [1868, 9, 8, 'M', '明', '明治']]
    .map(([y, m, d, initial, short, name]) => ({ from: ymdToSerial(y, m, d), year: y, initial, short, name }));
  return japaneseEras.find((era) => serial >= era.from) || null;
}
// The non-era year field switches to a short-year form below four
// digits. Digit alphabets retain only the leading decimal digit, prefixed by
// zero; CJK unit alphabets spell the last two digits. This also affects bbbb
// after B2 conversion, independently of the calendar selecting the year.
function calendarYearText(year, shape) {
  const text = String(year);
  if (year >= 1000) return shapeDigits(text, shape);
  return shape?.dateUnits
    ? shapeDateField(String(year % 100).padStart(2, '0'), shape)
    : shapeDigits(`0${text[0]}`, shape);
}
/** Whether a [$-…] locale tag names Japanese: the LCID's low word 0x411, or a ja language tag. */
function isJapaneseTag(inner) {
  const tag = inner.slice(1).split('-').slice(1).join('-');
  if (/^[0-9a-f]+$/i.test(tag)) return (parseInt(tag, 16) & 0xffff) === 0x411;
  return /^ja(-|$)/i.test(tag);
}
// The locales of the Windows LCIDs a [$-…] tag may carry: the low word names language and region, its low ten
// bits the language alone, which stands in for a region not listed. Calendar bits are read separately.
const LCID_LOCALES = new Map([
  [0x409, 'en-US'], [0x809, 'en-GB'], [0x4009, 'en-IN'], [0xc09, 'en-AU'], [0x407, 'de-DE'], [0x40c, 'fr-FR'], [0x40a, 'es-ES'], [0xc0a, 'es-ES'],
  [0x410, 'it-IT'], [0x413, 'nl-NL'], [0x416, 'pt-BR'], [0x816, 'pt-PT'], [0x41d, 'sv-SE'], [0x406, 'da-DK'], [0x414, 'nb-NO'], [0x40b, 'fi-FI'],
  [0x415, 'pl-PL'], [0x405, 'cs-CZ'], [0x41f, 'tr-TR'], [0x419, 'ru-RU'], [0x411, 'ja-JP'], [0x804, 'zh-CN'], [0x404, 'zh-TW'], [0x412, 'ko-KR'],
  [0xc04, 'zh-HK'], [0x1004, 'zh-SG'], [0x1404, 'zh-MO'],
  // The obsolete Johab language ID keeps names of its own.
  [0x812, 'ko-KR-x-johab'],
  [0x401, 'ar-SA'], [0x801, 'ar-IQ'], [0xc01, 'ar-EG'], [0x1001, 'ar-LY'],
  [0x1401, 'ar-DZ'], [0x1801, 'ar-MA'], [0x1c01, 'ar-TN'], [0x2001, 'ar-OM'],
  [0x2401, 'ar-YE'], [0x2801, 'ar-SY'], [0x2c01, 'ar-JO'], [0x3001, 'ar-LB'],
  [0x3401, 'ar-KW'], [0x3801, 'ar-AE'], [0x3c01, 'ar-BH'], [0x4001, 'ar-QA'],
]);
const LCID_LANGUAGES = {
  0x01: 'ar', 0x02: 'bg', 0x03: 'ca', 0x04: 'zh', 0x05: 'cs', 0x06: 'da', 0x07: 'de', 0x08: 'el', 0x09: 'en', 0x0a: 'es', 0x0b: 'fi', 0x0c: 'fr',
  0x0d: 'he', 0x0e: 'hu', 0x0f: 'is', 0x10: 'it', 0x11: 'ja', 0x12: 'ko', 0x13: 'nl', 0x14: 'nb', 0x15: 'pl', 0x16: 'pt', 0x18: 'ro', 0x19: 'ru',
  0x1a: 'hr', 0x1b: 'sk', 0x1c: 'sq', 0x1d: 'sv', 0x1e: 'th', 0x1f: 'tr', 0x21: 'id', 0x22: 'uk', 0x24: 'sl', 0x25: 'et', 0x26: 'lv', 0x27: 'lt',
  0x20: 'ur', 0x29: 'fa', 0x2a: 'vi', 0x39: 'hi', 0x45: 'bn', 0x49: 'ta', 0x4a: 'te', 0x4e: 'mr',
};
/** The locale a [$-407], [$€-407] or [$-de-DE] tag names, whose month and weekday names the code prints, or null ([$-F800] names none). */
function tagLocale(inner) {
  const tag = inner.slice(1).split('-').slice(1).join('-');
  if (/^[0-9a-f]+$/i.test(tag)) {
    const lcid = parseInt(tag, 16) & 0xffff;
    // Korean defines neutral, Wansung and legacy Johab IDs only. An unknown
    // sublanguage must not accidentally select the Korean calendar resources.
    if ((lcid & 0x3ff) === 0x12 && (lcid >>> 10) > 2) return null;
    return LCID_LOCALES.get(lcid) || LCID_LANGUAGES[lcid & 0x3ff] || null;
  }
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(tag) ? tag : null;
}

function tagCalendar(inner) {
  const tag = inner.slice(1).split('-').slice(1).join('-');
  return /^[0-9a-f]+$/i.test(tag) ? (parseInt(tag, 16) >>> 16) & 0xff : 0;
}

function tagNumeral(inner) {
  const tag = inner.slice(1).split('-').slice(1).join('-');
  return /^[0-9a-f]+$/i.test(tag) ? (parseInt(tag, 16) >>> 24) & 0xff : 0;
}

function formatShapedGeneral(value, shape) {
  if (!shape) return formatGeneral(value);
  const text = shape.expanded ? expandedGeneral(value) : formatGeneral(value);
  if (text == null) return formatGeneral(value);
  return shapeGeneral(shape.expanded ? text.replace('.', localeInfo().decimal) : text, shape, localeInfo().decimal);
}

function tagSystemFormat(inner) {
  const tag = inner.slice(1).split('-').slice(1).join('-');
  const id = /^[0-9a-f]+$/i.test(tag) ? parseInt(tag, 16) & 0xffff : 0;
  return id === 0xf800 ? 'date' : id === 0xf400 ? 'time' : null;
}

/** The locale a code's own leading [$-…] tag names, or null when it opens with anything else. */
export function codeLocale(code) {
  const m = /^\[(\$[^\]]*)\]/.exec(String(code || ''));
  return m ? tagLocale(m[1]) : null;
}

/**
 * The [$-…] tag a code carries so that another reader prints its month and weekday names in a locale's
 * language, or '' for American English, whose codes this app has always written bare.
 */
export function localeTag(loc) {
  if (!loc || loc === 'en-US') return '';
  for (const [lcid, name] of LCID_LOCALES) if (name === loc) return `[$-${lcid.toString(16)}]`;
  return '';
}
/** Directive prefixes are recognized, but unknown brackets are never treated as text. */
function bracketDirective(inner) {
  if (/^(h+|m+|s+)$/i.test(inner)) return { kind: 'elapsed' };
  if (inner.startsWith('$')) return { kind: 'locale' };
  const color = /^(black|blue|cyan|green|magenta|red|white|yellow)/i.exec(inner);
  if (color) return { kind: 'color', name: color[1].toLowerCase() };
  const indexed = /^color\s*(\d+)/i.exec(inner);
  if (indexed && Number(indexed[1]) >= 1 && Number(indexed[1]) <= 56) return { kind: 'color', index: Number(indexed[1]) };
  const shape = /^DBNum([1-4])/i.exec(inner);
  if (shape) return { kind: 'number shape', mode: Number(shape[1]) };
  const condition = /^(<=|>=|<>|=|<|>)/.exec(inner);
  if (condition) {
    // Native conditions read a numeric prefix; absent digits mean zero.
    const number = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))([eE][+-]?\d*)?/.exec(inner.slice(condition[0].length));
    const exponent = number?.[2];
    if (exponent && !/^[eE][+-]?\d+$/.test(exponent)) return null;
    let limit = 0;
    if (number) {
      const mantissa = number[1].replace(/^[+-]/, ''), point = mantissa.indexOf('.');
      const digits = mantissa.replace('.', ''), leading = /^0*/.exec(digits)[0].length;
      // Format-condition literals retain their first 15 significant decimal
      // digits, independently of the full-precision cell value being compared.
      // The value normalizes to 0.digits * 10^power. Its power must fit a finite
      // IEEE double; subnormal results then flush to zero, as in cell values.
      const power = Number(exponent?.slice(1) || 0) + (point < 0 ? digits.length : point) - leading;
      if (Math.abs(power) > Math.floor(Math.log10(Number.MAX_VALUE))) return null;
      limit = Number(`0.${digits.slice(leading, leading + 15) || '0'}e${power}`);
      if (Math.abs(limit) < 2 ** -1022) limit = 0;
      if (number[1].startsWith('-')) limit = -limit;
    }
    return { kind: 'condition', op: condition[0], limit };
  }
  return null;
}

/** Split on ";" outside quotes and escaped, padding, or fill characters. */
function splitSections(code) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"') { quoted = !quoted; cur += ch; continue; }
    if ((ch === '\\' || (!quoted && (ch === '_' || ch === '*'))) && i + 1 < code.length) { cur += ch + code[++i]; continue; }
    if (ch === ';' && !quoted) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Tokenize one section into { type, text } items. */
function tokenize(section) {
  const tokens = [];
  const directives = new Set();
  let i = 0;
  let fractionDenominator = false, fixedDenominator = false, hasDigits = false, hasDate = false;
  let selectorPrefix = true, selectorEnd = null;
  let hasFieldLocale = false;
  const s = section;
  while (i < s.length) {
    const ch = s[i];
    const selector = /^[bB][12]/.test(s.slice(i));
    if (ch !== '[' && !selector) selectorPrefix = false;
    if (ch === '"') {
      let j = i + 1;
      let text = '';
      while (j < s.length && s[j] !== '"') text += s[j++];
      tokens.push({ type: 'lit', text });
      i = j + 1;
      continue;
    }
    if (ch === '\\') { tokens.push({ type: 'lit', text: s[i + 1] ?? '' }); i += 2; continue; }
    if (ch === '_' || ch === '*') {
      const char = String.fromCodePoint(s.codePointAt(i + 1) ?? 32);
      tokens.push({ type: 'lit', text: ch === '_' ? ' ' : '', spacing: { type: ch === '_' ? 'pad' : 'fill', char } });
      i += 1 + char.length; continue;
    }
    if (ch === '[') {
      const j = s.indexOf(']', i);
      const inner = j < 0 ? s.slice(i + 1) : s.slice(i + 1, j);
      const directive = bracketDirective(inner);
      if (j < 0) tokens.bracketError ||= 'Close the bracket: a directive goes between a pair, like [Red] or [>100]';
      else if (!directive) tokens.bracketError ||= `Invalid code in brackets: [${inner}]`;
      else if (directive.kind !== 'elapsed' && directives.has(directive.kind)) tokens.bracketError ||= `Use only one ${directive.kind} directive in each section`;
      if (directive) directives.add(directive.kind);
      if (directive?.kind === 'condition') tokens.condition ||= { op: directive.op, limit: directive.limit };
      if (directive?.kind === 'number shape') tokens.numberShape = directive.mode;
      if (directive?.kind === 'elapsed') { tokens.push({ type: 'elapsed', text: inner.toLowerCase() }); hasDate = true; selectorPrefix = false; }
      else if (directive?.kind === 'locale') {
        tokens.locale = true;
        tokens.push({ type: 'lit', text: inner.slice(1).split('-')[0] }); // [$€-407] → €
        hasFieldLocale = true;
      }
      i = j < 0 ? s.length : j + 1;
      continue;
    }
    if (/[AaPp]/.test(ch) && /^(AM\/PM|A\/P)/i.test(s.slice(i))) {
      // A contiguous meridiem run is one field. As with other date fields,
      // longer runs use the long spelling (even A/PA/P prints AM or PM).
      const m = /^(?:AM\/PM|A\/P)+/i.exec(s.slice(i));
      tokens.push({ type: 'ampm', text: m[0] });
      hasDate = true;
      i += m[0].length;
      continue;
    }
    // General is a field, distinct from quoted text and calendar letters.
    if (/^general/i.test(s.slice(i))) {
      tokens.general = (tokens.general || 0) + 1;
      tokens.push({ type: 'general', text: s.slice(i, i + 7) });
      i += 7;
      continue;
    }
    if (/[eE]/.test(ch) && /^[eE][+-]/.test(s.slice(i))) {
      // Keep the exponent's placeholders as individual tokens. They can span
      // labels, optional digits and alignment slots just like integer fields.
      tokens.push({ type: 'exp', text: s.slice(i, i + 2) });
      i += 2;
      continue;
    }
    // Calendar selectors precede content. Identical adjacent selectors are
    // accepted, but switching calendars or inserting content between them is not.
    if (selector) {
      const calendar = s[i + 1] === '1' ? 'gregorian' : 'hijri';
      if (!selectorPrefix || (selectorEnd != null && (selectorEnd !== i || tokens.selector !== calendar))) {
        tokens.calendarError ||= 'Place one calendar selector (B1 or B2) before the format content';
      }
      tokens.selector = calendar;
      if (calendar === 'hijri' && !hasFieldLocale) tokens.hijri = true;
      tokens.push({ type: 'calendar', text: calendar });
      hasDate = true;
      i += 2;
      selectorEnd = i;
      continue;
    }
    // The aaa/aaaa weekday fields share ddd/dddd's locale/calendar
    // semantics. Short a/aa runs remain literal, and quoted/escaped text and
    // AM/PM have already been handled above. Keep the authored spelling.
    if (/^a{3}/i.test(s.slice(i))) {
      let raw = /^a+/i.exec(s.slice(i))[0];
      if (/^(AM\/PM|A\/P)/i.test(s.slice(i + raw.length - 1))) raw = raw.slice(0, -1);
      if (raw.length >= 3) {
        tokens.push({ type: 'date', text: raw.length === 3 ? 'ddd' : 'dddd', raw });
        hasDate = true;
        i += raw.length;
        continue;
      }
    }
    // g and b are date fields even alone or inside an unquoted label. Unit
    // labels containing any date letter must be quoted or escaped.
    if (/[ymdhsegb]/i.test(ch)) {
      let j = i;
      while (j < s.length && s[j].toLowerCase() === ch.toLowerCase()
        && (j === i || !/^general/i.test(s.slice(j)))) j++;
      const text = s.slice(i, j).toLowerCase();
      // A locale declaration enables calendar-specific year fields from here
      // onward. The first section supplies the calendar, even when another
      // section carries a different locale/calendar declaration.
      tokens.push({ type: 'date', text, raw: s.slice(i, j), localizedYear: hasFieldLocale });
      hasDate = true;
      i = j;
      continue;
    }
    // A denominator can follow spaces or quoted/escaped literals after the
    // slash. Its first numeric field determines whether it is fixed or variable.
    if ((fractionDenominator && /[1-9]/.test(ch)) || (fixedDenominator && /[1-9]/.test(ch))) {
      const denominator = /^\d+/.exec(s.slice(i))[0];
      tokens.push({ type: 'denominator', text: denominator });
      fractionDenominator = false; fixedDenominator = true;
      i += denominator.length;
      continue;
    }
    if ('0#?'.includes(ch)) { tokens.push({ type: 'digit', text: ch }); fractionDenominator = false; hasDigits = true; i++; continue; }
    if (ch === '.') {
      // After a date/time field, .0 through .000 are fractions of a second,
      // even after hours, elapsed totals or intervening literal text.
      const fraction = hasDate && /^\.0+/.exec(s.slice(i));
      if (fraction) { tokens.push({ type: 'subsecond', text: fraction[0] }); i += fraction[0].length; continue; }
      tokens.push({ type: 'point', text: ch }); i++; continue;
    }
    if (ch === ',') {
      let end = i + 1;
      while (s[end] === ',') end++;
      // Commas are numeric operators only immediately after numeric syntax.
      // A label (even an empty one), padding, fill or percent starts a literal
      // comma run. That run prints as one comma regardless of its length.
      if (['digit', 'denominator', 'point', 'exp'].includes(tokens.at(-1)?.type)) {
        for (; i < end; i++) tokens.push({ type: 'comma', text: ',' });
      } else { tokens.push({ type: 'lit', text: ',' }); i = end; }
      continue;
    }
    if (ch === '%') { tokens.push({ type: 'percent', text: ch }); i++; continue; }
    if (ch === '@') { tokens.push({ type: 'at', text: ch }); i++; continue; }
    if (ch === '/' && hasDigits && !hasDate) {
      tokens.push({ type: 'slash', text: ch });
      fractionDenominator = true; fixedDenominator = false;
      i++;
      continue;
    }
    tokens.push({ type: 'lit', text: ch, unquotedDigit: /[1-9]/.test(ch), unquotedSlash: ch === '/' });
    i++;
  }
  if (!hasDate) return tokens;
  // Resolve ambiguous m/mm once, while compiling the section. Hours start a
  // new clock group; seconds (including a fraction alone) establish one too.
  // Its first minute field consumes that context. A field immediately before
  // seconds is minutes independently, so a later calendar month stays a month.
  const beforeSeconds = new Array(tokens.length);
  for (let j = tokens.length - 1, next = null; j >= 0; j--) {
    beforeSeconds[j] = next === 's';
    const t = tokens[j];
    if (t.type === 'date' || t.type === 'elapsed') next = t.text[0];
    else if (t.type === 'subsecond') next = 's';
  }
  let clock = false, minutesUsed = false;
  for (let j = 0; j < tokens.length; j++) {
    const t = tokens[j];
    if ((t.type === 'date' || t.type === 'elapsed') && t.text[0] === 'h') { clock = true; minutesUsed = false; }
    else if (t.type === 'subsecond' || ((t.type === 'date' || t.type === 'elapsed') && t.text[0] === 's')) clock = true;
    else if (t.type === 'elapsed' && t.text[0] === 'm') minutesUsed = true;
    else if (t.type === 'date' && /^m{1,2}$/.test(t.text)) {
      t.minutes = (clock && !minutesUsed) || beforeSeconds[j];
      if (t.minutes) minutesUsed = true;
    }
  }
  let elapsed = false, elapsedUnit = null;
  for (const t of tokens) {
    t.unit = t.type === 'elapsed' ? t.text[0] : t.type === 'date'
      ? /^[hs]/.test(t.text) ? t.text[0] : t.minutes ? 'm' : null : null;
    elapsed ||= t.type === 'elapsed';
    if (t.unit && (elapsedUnit == null || 'hms'.indexOf(t.unit) < 'hms'.indexOf(elapsedUnit))) elapsedUnit = t.unit;
  }
  tokens.elapsedUnit = elapsed ? elapsedUnit : null;
  tokens.needsClock = tokens.some(t => t.type === 'subsecond' ||
    (['date', 'elapsed', 'ampm'].includes(t.type) && (!tokens.elapsedUnit || t.unit !== tokens.elapsedUnit)));
  return tokens;
}

function isDateSection(tokens) {
  return tokens.some((t) => t.type === 'date' || t.type === 'elapsed' || t.type === 'ampm' || t.type === 'subsecond') && !tokens.some((t) => t.type === 'digit');
}

/** Date/time fields cannot mix with numeric placeholders. Fractional seconds
 * have their own precision, and elapsed fields permit one total per section. */
function dateTimeCodeError(tokens) {
  if (tokens.calendarError) return tokens.calendarError;
  let fields = 0, meridiem = false, date = false, digits = false;
  const precedingUnits = new Set();
  for (const token of tokens) {
    if (token.type === 'elapsed') {
      fields++;
      if ([...precedingUnits].some(unit => 'hms'.indexOf(unit) <= 'hms'.indexOf(token.text[0]))) return 'Place the elapsed-time field before ordinary fields of the same or larger unit';
    }
    else if (token.type === 'ampm') meridiem = true;
    else if (token.type === 'date') {
      date = true;
      if (/^[hs]/.test(token.text) || token.minutes) precedingUnits.add(token.minutes ? 'm' : token.text[0]);
    }
    else if (token.type === 'digit') {
      if (meridiem) return 'Place numeric placeholders before AM/PM or A/P';
      digits = true;
    }
    else if (token.type === 'subsecond' && token.text.length > 4) return 'Use one to three zeros for fractional seconds, such as ss.000';
  }
  if (digits && tokens.some(t => t.type === 'subsecond')) return 'Use fractional seconds only with clock fields';
  if ((date || fields) && tokens.some(t => t.type === 'percent')) return 'Quote a literal percent sign in a date/time format';
  if (digits && (date || fields || tokens.selector)) return 'Quote text among digits, like 0 "days": d, m, y, h, s, e, g and b are date letters';
  if ((date || fields || meridiem || tokens.selector) && tokens.some(t => t.unquotedDigit)) return 'Quote literal digits in a date/time format, such as yyyy"1"';
  if (fields > 1) return 'Use one elapsed-time field per section, such as [h]:mm:ss';
  if (fields && meridiem) return 'Remove AM/PM or A/P from an elapsed-time format';
  return null;
}

/** @ designates a final text section; the fourth section is text even without
 * @. Only text, General, meridiem labels and nonnumeric directives belong there. */
function textSectionError(tokens, index, count) {
  const at = tokens.some(t => t.type === 'at');
  if (at && index !== count - 1) return 'Place the text section last in the format';
  if (!at && index !== 3) return null;
  if (tokens.condition) return 'Use conditions only in numeric sections';
  if (at && tokens.general) return 'Use either @ or General in a text section, not both';
  if (tokens.some(t => !['lit', 'at', 'general', 'calendar', 'ampm'].includes(t.type) || t.unquotedDigit || t.unquotedSlash)) {
    return 'Quote numeric and date characters in a text section';
  }
  return null;
}

function dateSectionKind(tokens) {
  if (!isDateSection(tokens)) return null;
  const time = tokens.some((t) => t.type === 'elapsed' || t.type === 'ampm' || t.type === 'subsecond' || (t.type === 'date' && (/^[hs]/.test(t.text) || t.minutes)));
  const calendar = tokens.some((t) => t.type === 'date' && /^[ydebg]/.test(t.text))
    || tokens.some((t) => t.type === 'date' && /^m/.test(t.text) && !t.minutes);
  return calendar ? (time ? 'datetime' : 'date') : 'time';
}

/** The selected section's date/time meaning, ignoring literals and directives. */
export function codeDateKind(value, code) {
  if (typeof value !== 'number') return null;
  const parsed = parseCode(String(code || 'General'));
  if (parsed.syntaxError) return null;
  const { section } = pickSection(parsed, value);
  return section == null ? null : systemSectionKind(parsed, section) || dateSectionKind(parsed.tokensOf(section));
}

/** Whether the selected section applies percentage scaling, rather than
 * displaying percent signs as part of scientific notation. */
export function codeScalesPercent(value, code) {
  const parsed = parseCode(String(code || 'General'));
  if (parsed.syntaxError) return false;
  const { section } = pickSection(parsed, value);
  if (section == null) return false;
  if (systemSectionKind(parsed, section)) return false;
  const tokens = parsed.tokensOf(section);
  return tokens.some(t => t.type === 'percent') && !tokens.some(t => t.type === 'exp');
}

/** Whether the selected numeric section represents a fraction. Shared with
 * input/clipboard parsing so literal spacing does not change its meaning. */
export function codeIsFraction(value, code) {
  const parsed = parseCode(String(code || 'General'));
  if (parsed.syntaxError) return false;
  const { section } = pickSection(parsed, value);
  if (section == null) return false;
  if (systemSectionKind(parsed, section)) return false;
  const tokens = parsed.tokensOf(section);
  return tokens.some((t) => t.type === 'slash') && !fractionCodeError(tokens);
}

// System formats follow the app's regional setting.
// Derive a field pattern from locale data, then use spreadsheet
// serial arithmetic (including day zero and February 29, 1900) to render it.
const systemPatterns = new Map();
function systemDateTokens(kind) {
  const locale = getLocale(), key = `${locale}:${kind}`;
  if (systemPatterns.has(key)) return systemPatterns.get(key);
  const formatter = new Intl.DateTimeFormat(locale, {
    ...(kind === 'date' ? { dateStyle: 'full' } : { timeStyle: 'medium' }),
    calendar: 'gregory', numberingSystem: 'latn', timeZone: 'UTC',
  });
  const sample = new Date(Date.UTC(2001, 0, 2, 3, 4, 5));
  const fields = { year: 'yyyy', weekday: 'dddd', minute: 'mm', second: 'ss', dayPeriod: 'AM/PM' };
  const quote = text => `"${text.replaceAll('"', '"\\""')}"`;
  const code = formatter.formatToParts(sample).map(({ type, value }) => {
    if (fields[type]) return fields[type];
    if (type === 'month') return /^\d+$/.test(value) ? 'm'.repeat(value.length) : 'mmmm';
    if (type === 'day') return 'd'.repeat(value.length);
    if (type === 'hour') return 'h'.repeat(value.length);
    // System patterns use ordinary spaces, including before AM/PM.
    return quote(value.replace(/[\u00a0\u202f]/g, ' '));
  }).join('');
  const tokens = tokenize(code);
  const period = tokens.find(t => t.type === 'ampm');
  if (period) period.names = [3, 15].map(hour => formatter.formatToParts(new Date(Date.UTC(2001, 0, 2, hour))).find(p => p.type === 'dayPeriod').value);
  systemPatterns.set(key, tokens);
  return tokens;
}

function systemSectionKind(parsed, section) {
  return parsed.system && parsed.tokensOf(section).locale ? parsed.system : null;
}

function clockParts(value, fractionDigits = 0) {
  // Native controls establish this effective half-unit for millisecond clocks
  // in serial-day space. It differs from arithmetic 0.0005 / 86400; numeric
  // formats and ROUND do not share it. Clock/elapsed controls across both
  // date systems and independent magnitudes establish this common unit.
  const roundingDays = fractionDigits === 3
    ? 5.787037037037248e-9
    : (0.5 / 10 ** fractionDigits) / 86400;
  const clockValue = value + roundingDays;
  const shownDay = Math.floor(clockValue);
  const secondsExact = (clockValue - shownDay) * 86400;
  const total = Math.floor(secondsExact);
  const H = Math.floor(total / 3600);
  const M = Math.floor((total % 3600) / 60);
  const S = Math.floor(total % 60);
  const hours = (clockValue - shownDay) * 24;
  const minutes = (hours - Math.floor(hours)) * 60;
  const clockSeconds = (minutes - Math.floor(minutes)) * 60;
  const factor = 10 ** fractionDigits;
  // Fractional fields read the successively decomposed clock workspace, then
  // convert its scaled remainder at 15-digit numeric precision. Keep
  // only the field's digits: a remainder converted to 10/100/1000 wraps to
  // zero without carrying into the independently extracted whole seconds.
  const units = fractionDigits ? Math.floor(Number(((clockSeconds % 1) * factor).toPrecision(15))) : 0;
  const fraction = String(units % factor).padStart(fractionDigits, '0');
  return { roundingDays, shownDay, secondsExact, clockSeconds, H, M, S, fraction };
}

// The period names differ from CLDR's in these locales. These are
// language resources, shared by clock fields and numeric meridiem suffixes.
const OFFICE_PERIOD_NAMES = { 'en-IN': ['AM', 'PM'], nl: ['AM', 'PM'], 'pt-PT': ['AM', 'PM'], nb: ['am', 'pm'] };
const periodNames = new Map();
function meridiemText(token, hour, locale) {
  if (token.names) return token.names[hour >= 12 ? 1 : 0];
  // An explicit supported locale uses its complete period name even for A/P.
  // Untagged A/P instead retains the case of its own letters.
  if (locale) {
    if (!periodNames.has(locale)) {
      let names = null;
      try {
        if (Intl.DateTimeFormat.supportedLocalesOf(locale).length) {
          const formatter = new Intl.DateTimeFormat(locale, { hour: 'numeric', hour12: true, timeZone: 'UTC' });
          const resolved = formatter.resolvedOptions().locale;
          names = OFFICE_PERIOD_NAMES[resolved] || OFFICE_PERIOD_NAMES[resolved.split('-')[0]]
            || [3, 15].map(h => formatter.formatToParts(new Date(Date.UTC(2001, 0, 1, h))).find(p => p.type === 'dayPeriod').value);
        }
      } catch { /* An unrecognized locale declaration retains the untagged spelling. */ }
      if (periodNames.size >= PARSED_CODES_MAX) periodNames.clear();
      periodNames.set(locale, names);
    }
    const names = periodNames.get(locale);
    if (names) return names[hour >= 12 ? 1 : 0];
  }
  return token.text.length > 3 ? (hour >= 12 ? 'PM' : 'AM') : token.text[hour >= 12 ? 2 : 0];
}

// Some calendars select their own vocabulary independently of the
// language used for numerals and meridiems. Cache the complete name resources
// so rendering a column does not rebuild these language tables per cell.
const calendarNames = new Map();
const CALENDAR_NAME_LOCALES = { 2: 'en-US', 4: 'zh-TW', 5: 'en-US', 7: 'th-TH' };
function calendarDateNames(calendar, locale, legacyMonth = false) {
  // Neutral solar-calendar tags keep ordinary names indexed by the converted month;
  // an explicit language chooses the calendar's own name resources.
  if (calendar === 8) return hebrewNames(locale, true, legacyMonth);
  if (isLunisolarCalendar(calendar)) return lunisolarNames(calendar, locale);
  if (calendar === 16 && locale) return sakaNames(locale);
  if (calendar === 22 && locale) return persianNames(locale);
  // B2's month-name path can switch Thai Buddhist names to Arabic. The
  // English, Taiwanese and Korean calendars retain their fixed vocabularies.
  const fixedLanguage = calendar === 7 && legacyMonth ? null : CALENDAR_NAME_LOCALES[calendar];
  const language = fixedLanguage || locale || getLocale();
  const arabic = /^ar(?:-|$)/i.test(language);
  const arabicModern = (calendar === 3 || calendar === 7) && arabic;
  const arabicGregorian = (calendar === 0 || calendar === 1) && arabic;
  if (calendar !== 4 && calendar !== 7 && !arabicModern && !arabicGregorian) return dateNames(language);
  const key = `${calendar}:${language}`;
  if (!calendarNames.has(key)) {
    if (calendarNames.size >= PARSED_CODES_MAX) calendarNames.clear();
    const base = dateNames(language);
    if (arabicGregorian) {
      // The legacy Arabic Gregorian calendar uses full names at both widths.
      // The Levant retains its month vocabulary, joined with nonbreaking spaces;
      // other regions share the standard Arabic names, including the Maghreb.
      const source = dateNames(/^ar-(?:IQ|SY|JO|LB)(?:-|$)/i.test(language) ? language : 'ar-EG');
      const months = source.months.long.map(name => name.replaceAll(' ', '\u00a0'));
      const days = [...source.days.long];
      days[1] = 'الإثنين';
      calendarNames.set(key, { months: { long: months, short: months, inDate: months, shortInDate: months }, days: { long: days, short: days } });
    } else if (calendar === 4) {
      const months = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
      calendarNames.set(key, { ...base, months: { long: months, short: months, inDate: months, shortInDate: months } });
    } else {
      const short = arabicModern ? ['أحد', 'اثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت']
        : ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
      // Arabic month names do not inflect beside a numeric day. The same
      // names are used there, spacing included.
      let months = arabicModern ? { ...base.months, inDate: base.months.long, shortInDate: base.months.short } : base.months;
      if (arabicModern && /^ar-(?:JO|LB)(?:-|$)/i.test(language)) {
        // Office abbreviates the paired Levantine month names with ordinal digits.
        const abbreviated = [...months.short];
        abbreviated[0] = 'كانون ٢'; abbreviated[9] = 'تشرين ١';
        abbreviated[10] = 'تشرين ٢'; abbreviated[11] = 'كانون ١';
        months = { ...months, short: abbreviated, shortInDate: abbreviated };
      }
      calendarNames.set(key, { ...base, months, days: { ...base.days, short } });
    }
  }
  return calendarNames.get(key);
}

function formatDateSection(value, tokens, japanese = false, locale = null, calendar = 0, shape = null) {
  if (!Number.isFinite(value) || value < 0) return FORMAT_OVERFLOW;
  const hasAmPm = tokens.some((t) => t.type === 'ampm');
  // Month and weekday names in the language of the code's [$-…] tag, else of the regional format; beside a day
  // number a month takes the form the language writes there (Russian "15 марта", where the month alone is "март").
  // Explicit Hijri, Hebrew, lunisolar, Saka, Persian and Umm al-Qura calendars convert without B2. Legacy B2
  // also requests conversion using the first section's selected calendar.
  // Each field records whether a locale tag has enabled year conversion.
  const lunisolar = isLunisolarCalendar(calendar);
  const alternate = tokens.hijri || lunisolar || [6, 8, 16, 22, 23].includes(calendar);
  const hijri = alternate && (calendar === 0 || calendar === 6);
  const islamicNames = hijri || calendar === 23;
  // Neutral B2 tags for the localized Gregorian and era calendars use the
  // calendar's default name lookup. They are distinct from both an explicit
  // language and the built-in English/Hijri/Buddhist name tables.
  const neutralLegacy = tokens.hijri && !locale && (lunisolar || [1, 3, 4, 5, 8, 16, 22].includes(calendar));
  const nameCalendar = calendar === 4 && !locale && !tokens.hijri ? 0 : calendar;
  const ordinaryNames = calendarDateNames(nameCalendar, neutralLegacy ? 'ar' : locale, neutralLegacy);
  let names = islamicNames ? hijriNames(locale, false, ordinaryNames, calendar === 23) : ordinaryNames;
  if (neutralLegacy) {
    // This path uses full Arabic weekdays even for other calendar dates.
    // There are no neutral Korean/ETO weekday names; month names remain valid.
    names = { ...names, days: [5, 17, 18].includes(calendar) ? null : hijriNames(null, false, ordinaryNames).days };
  }
  const hasDay = tokens.some((t) => t.type === 'date' && /^d{1,2}$/.test(t.text));
  let legacyWeekday = null, legacyWeekdayText = null, legacyInitialMonth = false;
  const monthName = (month, len) => {
    // An initial untagged B2 weekday supplies a shared name result, including
    // for later full/narrow month fields. mmm explicitly replaces that result.
    if (legacyWeekdayText !== null && len > 3) return legacyWeekdayText;
    if (len === 3) legacyWeekdayText = null;
    if (tokens.hijri && !neutralLegacy && (len === 3 || (!locale && calendar === 0 && legacyInitialMonth))) {
      // Legacy B2's Arabic month-name path also changes the subsequent weekday
      // lookup to the month ordinal, saturating at the last weekday name. An
      // explicit locale enters that path at mmm; untagged B2 also enters when
      // its initial date field is a full/narrow month. Keep this state apart from the
      // actual calendar date. An explicit calendar without B2 does not enter
      // this path; with B2 it still chooses its own calendar-name resources.
      names = islamicNames ? hijriNames(null, true, ordinaryNames, calendar === 23) : calendarDateNames(calendar, 'ar', true);
      legacyWeekday = Math.min(month, names.days.long.length) - 1;
    }
    if (calendar === 8 && locale && legacyWeekday === null &&
      (date.y >= HEBREW_NAME_YEAR_END || (/^he(?:-|$)/i.test(locale) && date.y % 1000 === 0))) return FORMAT_OVERFLOW;
    return (len === 3 ? (hasDay ? names.months.shortInDate : names.months.short)
      : len === 4 ? (hasDay ? names.months.inDate : names.months.long) : (names.months.narrow || names.months.long.map((m) => Array.from(m)[0])))[month - 1];
  };
  const fractionDigits = tokens.reduce((n, t) => t.type === 'subsecond' ? Math.max(n, t.text.length - 1) : n, 0);
  const { roundingDays, shownDay, secondsExact, clockSeconds, H, M, S, fraction } = clockParts(value, fractionDigits);
  // General reads the numeric workspace left after successive hour/minute
  // decomposition. Preserve that operation order at subsecond boundaries.
  let generalClock;
  if (tokens.general && tokens.needsClock) {
    generalClock = fractionDigits ? (clockSeconds % 1) * 10 ** fractionDigits : clockSeconds;
  }
  const gregorian = serialToYMD(shownDay);
  let date = gregorian;
  // A section with an elapsed directive accumulates its largest displayed time
  // unit. Repeated fields share the total; smaller fields are clock remainders.
  // The compiler resolves units and calendar dependencies once per format.
  const { elapsedUnit, needsClock } = tokens;
  if (needsClock && (shownDay >= CALENDAR_END || !Number.isFinite(date.y))) return FORMAT_OVERFLOW;
  if (needsClock && alternate) {
    // Calendar conversion has no day zero. The Taiwan era starts in 1912;
    // pure elapsed totals bypass calendar conversion and its validity range.
    if (shownDay === 60 || (calendar === 4 && gregorian.y < 1912)) return FORMAT_OVERFLOW;
    date = { ...date, d: Math.max(1, date.d) };
    if (neutralLegacy && (calendar === 1 || calendar === 3 || calendar === 16 || calendar === 22)) {
      // Neutral Gregorian/solar-calendar names use the real weekday. Japanese names read the
      // converted era year in the current era, normalizing overflowing days
      // (including February 29), independently of the displayed numeric date.
      const year = calendar === 3
        ? japaneseEra(CALENDAR_END - 1).year + gregorian.y - japaneseEra(shownDay).year
        : gregorian.y;
      date.weekday = new Date(Date.UTC(year, gregorian.m - 1, date.d)).getUTCDay();
    }
    if (hijri) date = hijriDate(date);
    else if (lunisolar) date = lunisolarDate(date, calendar);
    else if (calendar === 8) date = hebrewDate(date);
    else if (calendar === 23) date = umalquraDate(date);
    else if (calendar === 16) date = sakaDate(date);
    else if (calendar === 22) date = persianDate(date);
    else if (calendar === 3) date = { ...date, y: date.y - japaneseEra(shownDay).year + 1 };
    // Taiwan's era year 1 begins on January 1, 1912.
    else if (calendar === 4) date = { ...date, y: date.y - 1911 };
    else if (CALENDAR_YEAR_OFFSETS[calendar]) date = { ...date, y: date.y + CALENDAR_YEAR_OFFSETS[calendar] };
  }
  if (needsClock && calendar === 8 && neutralLegacy) date = { ...date, weekday: hebrewLegacyWeekday(date) };
  if (needsClock && lunisolar && neutralLegacy) date = { ...date, weekday: lunisolarLegacyWeekday(date, calendar) };
  if (calendar === 8 && !neutralLegacy) names = hebrewNames(locale, date.leap);
  let workingValue = value, clockRead = false;
  const elapsedText = (unit, width) => {
    // Rounding is in serial-day space, then the value scales by 60 for each smaller
    // time unit and by 24 LAST. Combining these factors or starting with hours
    // changes adjacent floating-point values at half-second boundaries.
    let n = workingValue + roundingDays;
    if (unit === 's') n *= 60;
    if (unit !== 'h') n *= 60;
    n = Math.floor(n * 24);
    return (n >= 1e15 ? fifteenDigitInteger(n) : String(n)).padStart(width, '0');
  };
  // An explicit calendar takes precedence over the language. Calendar 3 uses
  // Japanese eras even with an English locale; another explicit calendar must
  // not inherit them from Japanese. Without a calendar, the locale selects g/e.
  // B2 first converts a Japanese date to its era year. The format then resolves
  // y/e/g against that year as a Gregorian date, falling back to its oldest
  // era before Meiji. Keep the converted date separate from this second era
  // lookup: month/day and the legacy weekday-name path still use their own
  // calendar state. Negative era years are emitted as unsigned 32-bit values.
  const era = calendar === 3
    ? alternate
      ? japaneseEra(ymdToSerial(date.y, date.m, date.d)) || japaneseEras.at(-1)
      : japaneseEra(shownDay)
    : !alternate && calendar === 0 && (japanese || /^ja(-|$)/i.test(locale || getLocale()))
      ? japaneseEra(shownDay) : null;
  const eraYear = era ? (date.y - era.year + 1) >>> 0 : null;
  let out = '';
  for (const t of tokens) {
    const unit = t.unit;
    if (elapsedUnit && unit === elapsedUnit) { out += shapeGeneral(elapsedText(unit, t.text.length), shape); continue; }
    // Field evaluation reuses one numeric workspace after decomposing a
    // clock, and again when scaling a fractional-second field. Later elapsed
    // fields use that workspace, while ordinary fields keep the original clock.
    if (!clockRead && ['date', 'elapsed', 'ampm', 'subsecond'].includes(t.type)) {
      legacyInitialMonth = t.type === 'date' && /^m{3,}$/.test(t.text);
      if (tokens.hijri && !locale && calendar === 0 && t.type === 'date' && /^d{3,}$/.test(t.text)) {
        // This name path uses the real Gregorian weekday (day zero is clamped
        // to January 1), then retains its result across later numeric fields.
        // It must not change the ordinary pre-March-1900 weekday sequence.
        if (date.y >= LEGACY_HIJRI_WEEKDAY_YEAR_END) return FORMAT_OVERFLOW;
        const weekday = new Date(Date.UTC(gregorian.y, gregorian.m - 1, Math.max(1, gregorian.d))).getUTCDay();
        legacyWeekdayText = names.days.long[weekday];
      }
      workingValue = secondsExact % 60;
      clockRead = true;
    }
    switch (t.type) {
      case 'lit': out += t.rendered ?? t.text; break;
      // General reads the decomposed seconds workspace, including
      // its decimal scaling, wherever the field occurs. Pure elapsed totals
      // do not decompose a clock and leave the original serial available.
      case 'general': out += formatShapedGeneral(needsClock ? generalClock : value, shape); break;
      // AM/PM prints upper case however the code writes it; A/P follows the case of its own letters.
      case 'ampm': out += meridiemText(t, H, locale); break;
      case 'elapsed': {
        const n = unit === 'h' ? H : unit === 'm' ? M : S;
        out += shapeDateField(String(n).padStart(t.text.length, '0'), shape);
        break;
      }
      case 'date': {
        const k = t.text[0];
        const len = t.text.length;
        if (k === 'd' && len >= 3 && !names.days) return FORMAT_OVERFLOW;
        if (k === 'd' && len >= 3 && calendar === 8 && neutralLegacy && date.y >= HEBREW_NAME_YEAR_END) return FORMAT_OVERFLOW;
        if (k === 'y' || k === 'b') {
          // Explicit Japanese-calendar y fields use the full era year, with a
          // minimum of two digits for every field width. The locale-only form
          // keeps Gregorian y fields, and b retains its own year semantics.
          if (k === 'y' && calendar === 3 && era) {
            out += shapeDateField(String(eraYear).padStart(2, '0'), shape);
            break;
          }
          // Taiwan y/e always print the full calendar year, regardless of
          // field width. B2 controls epoch conversion, not the y/e writer.
          if (k === 'y' && calendar === 4) {
            out += calendarYearText(date.y, shape);
            break;
          }
          const offset = t.localizedYear
            ? (k === 'y' ? CALENDAR_YEAR_OFFSETS[calendar] || 0 : calendar === 7 ? 543 : 0)
            : k === 'b' ? 543 : 0;
          // CJK/Hangul short y fields spell the underlying year with units;
          // full years and digit-only short years apply the calendar offset.
          const year = String(date.y + (k === 'y' && len <= 2 && shape?.dateUnits ? 0 : offset));
          // The legacy short Buddhist-year field reads positions three and
          // four even beyond year 9999; locale-tagged yy uses the last two.
          // The digit-only b/bb path reads fixed positions from the unpadded
          // decimal buffer, including its NUL terminator for short years.
          const shortYear = k === 'b' && !shape?.dateUnits
            ? year.slice(2, 4).padEnd(2, '\0')
            : k === 'b' ? year.padStart(4, '0').slice(2, 4) : year.slice(-2);
          out += len <= 2 ? shapeDateField(shortYear, shape) : calendarYearText(Number(year), shape);
        }
        else if (k === 'e') out += era ? shapeDateField(String(eraYear).padStart(Math.min(len, 2), '0'), shape) : calendarYearText(date.y, shape);
        else if (k === 'g') out += era ? (len === 1 ? era.initial : len === 2 ? era.short : era.name) : '';
        else if (k === 'd') out += len <= 2 ? shapeDateField(String(date.d).padStart(len, '0'), shape) : legacyWeekdayText ?? (len === 3 ? names.days.short[legacyWeekday ?? date.weekday] : names.days.long[legacyWeekday ?? date.weekday]);
        else if (k === 'h') { const h = hasAmPm ? (H % 12 || 12) : H; out += shapeDateField(String(h).padStart(Math.min(len, 2), '0'), shape); }
        else if (k === 's') out += shapeDateField(String(S).padStart(Math.min(len, 2), '0'), shape);
        else if (k === 'm') {
          if (t.minutes) out += shapeDateField(String(M).padStart(len === 1 ? 1 : 2, '0'), shape);
          else {
            const text = len <= 2 ? shapeDateField(String(date.m).padStart(len, '0'), shape) : monthName(date.m, Math.min(len, 5));
            if (text === FORMAT_OVERFLOW) return FORMAT_OVERFLOW;
            out += text;
          }
        }
        break;
      }
      // The code is written with a period; the fraction of a second uses the locale's decimal mark, like any other decimal.
      case 'subsecond':
        out += `${localeInfo().decimal}${shapeDigits(fraction.slice(0, t.text.length - 1), shape)}`;
        workingValue = (secondsExact % 1) * 10 ** fractionDigits;
        break;
      case 'point': out += '.'; break;
      case 'comma': out += ','; break;
      case 'slash': case 'percent': case 'at': out += t.text; break;
      default: break;
    }
  }
  return out;
}

function fractionFor(value, maxDen) {
  // The fraction is the last continued-fraction convergent that fits the denominator
  // placeholders, not the nearest fraction (or a bounded semiconvergent).
  // For example, ?/? displays 0.06 as 0/1 and 0.7 as 2/3, not 1/9 and 5/7.
  // Continued fractions also avoid a loop per possible denominator. Codes from
  // files can contain hundreds of placeholders; keep arithmetic finite and
  // within JavaScript's integer precision regardless of their length.
  maxDen = Math.min(maxDen, Number.MAX_SAFE_INTEGER);
  // Each coefficient multiplication is bounded by the signed 32-bit limit,
  // before adding the previous numerator. The resulting sum can exceed it.
  // A value already at that limit cannot produce even the first convergent.
  const limit = 2 ** 31 - 1;
  if (!Number.isFinite(value) || value >= limit) return null;
  if (Number.isInteger(value)) return [value, 1];
  let p0 = 0, q0 = 1, p1 = 1, q1 = 0, rest = value;
  for (let i = 0; i < 100; i++) {
    const a = Math.floor(rest);
    const product = a * p1;
    const p2 = p0 + product, q2 = q0 + a * q1;
    if (product >= limit || q2 > maxDen || !Number.isSafeInteger(p2) || !Number.isSafeInteger(q2)) break;
    [p0, q0, p1, q1] = [p1, q1, p2, q2];
    if (value === p1 / q1) return [p1, q1];
    rest = 1 / (rest - a);
  }
  if (q1 <= 1) return [Math.round(value), 1];
  return [p1, q1];
}

function fractionCodeError(tokens) {
  const slashes = tokens.filter((t) => t.type === 'slash');
  if (!slashes.length) return null;
  if (slashes.length !== 1) return 'A fraction format has one slash between its numerator and denominator';
  const after = tokens.slice(tokens.indexOf(slashes[0]) + 1);
  if (!after.some((t) => t.type === 'digit' || t.type === 'denominator')) return 'A fraction needs a denominator, like ?/? or ?/16';
  const slash = tokens.indexOf(slashes[0]);
  const numeratorEnd = tokens.findLastIndex((t, i) => i < slash && t.type === 'digit');
  const denominatorStart = after.findIndex(t => t.type === 'digit' || t.type === 'denominator');
  const denominatorEnd = after.findIndex((t, i) => i > denominatorStart && (t.type === 'lit' || t.type === 'percent'));
  // A point may trail the numerator as literal punctuation, or appear after
  // a label following the denominator. It cannot make either field decimal.
  if (tokens.slice(0, numeratorEnd).some(t => t.type === 'point')
    || after.slice(0, denominatorEnd < 0 ? after.length : denominatorEnd).some(t => t.type === 'point')) return 'Fraction fields need integer digits; quote a literal decimal point';
  if (after.some((t) => t.type === 'denominator' && t.text.length > 5)) return 'A literal fraction denominator can have at most five digits';
  if (after.some((t, i) => t.type === 'denominator' && after[i + 1]?.type === 'digit')) return 'Use either placeholders or a fixed number for the denominator, like ?/?? or ?/16';
  return null;
}

function scientificCodeError(tokens) {
  const index = tokens.findIndex(t => t.type === 'exp');
  if (index < 0) return null;
  const before = tokens.slice(0, index), after = tokens.slice(index + 1);
  if (tokens[index].text[0] !== 'E') return 'Use uppercase E for scientific notation, like 0.00E+00';
  if (after.some(t => t.type === 'exp')) return 'A scientific format has one exponent';
  if (!before.some(t => t.type === 'digit') || !after.some(t => t.type === 'digit')) return 'An exponent needs digits on both sides, like 0.00E+00';
  if (tokens.some(t => t.type === 'slash')) return 'Use a decimal mantissa with an exponent, like 0.00E+00';
  // Trailing exponent commas are accepted. Between exponent digits, numeric
  // commas are valid only after a decimal point (in either numeric field).
  const lastDigit = after.findLastIndex(t => t.type === 'digit');
  const point = tokens.findIndex(t => t.type === 'point');
  if (after.some((t, i) => t.type === 'comma' && i < lastDigit && (point < 0 || i + index + 1 < point))) return 'Remove commas between integer exponent digits, like 0E+000';
  return null;
}

/** The integer digits of a magnitude at or above 1e15: fifteen significant digits, then zeros. */
function fifteenDigitInteger(n) {
  const [mantissa, power] = n.toExponential(14).split('e');
  return mantissa.replace('.', '').padEnd(Number(power) + 1, '0');
}

/**
 * Date letters, elapsed brackets, and AM/PM mean nothing among digit
 * placeholders (such a code is refused when typed); printing them as written keeps
 * every letter of "0 days" rather than silently dropping the d, y, and s.
 */
function asWritten(t) {
  return t.type === 'date' ? t.raw : t.type === 'elapsed' ? `[${t.text}]` : t.rendered ?? t.text;
}


/** Render denominator fields without flattening their placeholder runs. The
 * first field consumes denominator digits; later fields retain the remaining
 * digit/padding count across literals. Later 0/# runs are integer
 * fields, while ? runs continue consuming individual digits and alignment. */
function formatFractionDenominator(value, tokens, shape = null) {
  let digits = String(value), position = 0, remaining = digits.length;
  let out = '', first = true;
  const take = (count) => {
    let text = '';
    for (let i = 0; i < count; i++) text += digits[position++] ?? '0';
    return text;
  };
  for (let i = 0; i < tokens.length;) {
    const token = tokens[i];
    if (token.type === 'denominator') {
      const width = token.text.length, used = Math.min(width, remaining);
      out += shapeDigits(token.text.slice(0, used).padEnd(width), shape);
      position += used; remaining -= width; first = false; i++;
      continue;
    }
    if (token.type !== 'digit') {
      out += token.type === 'comma' ? '' : asWritten(token);
      i++;
      continue;
    }
    let end = i + 1;
    if (first) {
      while (tokens[end]?.type === 'digit') end++;
      const field = tokens.slice(i, end), used = Math.min(remaining, field.length);
      const text = take(used), leftAligned = field[0].text === '?';
      const padding = (leftAligned ? field.slice(used) : field.slice(0, field.length - used))
        .map((t) => t.text === '?' ? ' ' : t.text === '0' ? '0' : '').join('');
      out += shapeDigits(leftAligned ? text + padding : padding + text, shape);
      remaining -= field.length; first = false;
    } else if (token.text === '?') {
      while (tokens[end]?.type === 'digit' && tokens[end].text === '?') end++;
      // A preceding field's unused alignment becomes the available zero
      // digits for the next field, rather than disappearing with the literal.
      remaining = Math.abs(remaining);
      const used = Math.min(remaining, end - i);
      out += shapeDigits(take(used), shape) + ' '.repeat(end - i - used);
      remaining -= end - i;
    } else {
      while (tokens[end]?.type === 'digit' && tokens[end].text !== '?') end++;
      const required = tokens.slice(i, end).filter((t) => t.text === '0').length;
      out += shapeDigits(remaining >= 0 ? take(remaining) + '0'.repeat(end - i) : '0'.repeat(Math.max(1, required)), shape);
      digits = '0'; position = 0; remaining = 1;
    }
    i = end;
  }
  return out;
}

/** Fill integer slots from right to left, keeping each slot's own padding rule. */
function placeIntegerDigits(digits, tokens) {
  const slots = new Array(tokens.length);
  let position = digits.length;
  for (let i = tokens.length - 1; i >= 0; i--) {
    slots[i] = position > 0 ? digits[--position]
      : tokens[i].text === '0' ? '0' : tokens[i].text === '?' ? ' ' : '';
  }
  if (slots.length) slots[0] = digits.slice(0, position) + slots[0];
  return slots;
}

function formatNumberSection(value, tokens, autoMinus = false, locale = null, calendar = 0, onUnsignedZero = null, shape = null) {
  const hasMeridiem = tokens.some(t => t.type === 'ampm');
  let periodHour;
  const prepareMeridiem = unsignedZero => {
    if (!hasMeridiem) return true;
    // Numeric rounding may remove a negative zero. Its meridiem still reads
    // the magnitude of the original serial, independently of scaling/rounding.
    if (value < 0 && !(unsignedZero && autoMinus)) return false;
    const { shownDay, H } = clockParts(Math.abs(value));
    if (!Number.isFinite(shownDay) || shownDay >= CALENDAR_END || ((isLunisolarCalendar(calendar) || [6, 8, 16, 22, 23].includes(calendar)) && shownDay === 60)) return false;
    periodHour = H;
    return true;
  };
  const written = token => token.type === 'ampm' ? meridiemText(token, periodHour, locale) : asWritten(token);
  let n = Math.abs(value);
  const percentCount = tokens.filter((t) => t.type === 'percent').length;
  const expIdx = tokens.findIndex((t) => t.type === 'exp');
  const exp = expIdx < 0 ? null : tokens[expIdx];
  const mantissa = exp ? tokens.slice(0, expIdx) : tokens;
  const pointIdx = mantissa.findIndex((t) => t.type === 'point');
  const intTokens = (pointIdx < 0 ? mantissa : mantissa.slice(0, pointIdx)).filter((t) => t.type === 'digit');
  // The fraction's placeholders run from the point to the exponent, if any: a slice, so a long fraction costs its length.
  const fracTokens = pointIdx < 0 ? [] : mantissa.slice(pointIdx + 1).filter((t) => t.type === 'digit');
  const slash = tokens.find((t) => t.type === 'slash');
  // A comma run directly between integer placeholders groups. Other numeric
  // commas are ignored unless they follow the last placeholder/decimal point,
  // where each divides by 1000. Scientific formats ignore comma scaling.
  let grouping = false;
  let scale = 0;
  const lastNumeric = tokens.findLastIndex(t => t.type === 'digit' || t.type === 'point');
  for (let i = 0; i < mantissa.length; i++) {
    if (tokens[i].type !== 'comma') continue;
    const start = i;
    while (tokens[i + 1]?.type === 'comma') i++;
    if (tokens[start - 1]?.type === 'digit' && tokens[i + 1]?.type === 'digit'
      && (pointIdx < 0 || i < pointIdx)) grouping = true;
    if (!exp && start > lastNumeric) scale += i - start + 1;
  }
  let exponent = 0;
  if (exp && n !== 0) {
    const intDigits = Math.max(1, intTokens.length);
    // Decimal decomposition avoids dividing by underflowed powers of ten.
    const [mantissa, power] = n.toExponential(17).split('e');
    // Scientific formats retain percent symbols and comma syntax,
    // but neither changes the magnitude represented by the exponent.
    const shifted = Number(power);
    // Every integer placeholder contributes to the exponent's step, including
    // mandatory zeros and alignment spaces. "000.0E+0" therefore prints
    // 2.75 as 002.8E+0, just as "##0.0E+0" prints 2.8E+0.
    const step = Math.floor(shifted / intDigits) * intDigits;
    exponent = step;
    n = Number(mantissa) * 10 ** (shifted - step);
    // Rounding may carry into a new digit.
    if (Math.round(Number((n * 10 ** fracTokens.length).toPrecision(15))) / 10 ** fracTokens.length >= 10 ** intDigits) {
      n /= 10 ** intDigits; exponent += intDigits;
    }
  } else {
    // Each placeholder scales by 100; multiplying separately keeps zero and
    // tiny inputs finite when the combined multiplier would overflow.
    for (let i = 0; i < percentCount; i++) n *= 100;
    // Fraction commas are grouping/literal syntax, not decimal scaling.
    // Unsupported commas after the denominator are handled in that branch.
    if (!slash) n /= 1000 ** scale;
  }

  let intStr;
  let fracStr = '';
  if (slash) {
    // Fractions: ?/? style. Whole part when integer digits precede the fraction.
    const numTokens = tokens.slice(0, tokens.indexOf(slash)).filter((t) => t.type === 'digit');
    const denTokens = tokens.slice(tokens.indexOf(slash) + 1).filter((t) => t.type === 'digit');
    const fixedDen = tokens.findLast((t) => t.type === 'denominator');
    // Literal denominators are encoded as negated signed 16-bit values.
    // Wrapped nonnegative codes select variable precision (zero means seven
    // places), while the original literal still supplies the displayed text.
    // Keep this native TEXT behavior even for literals that wrap its encoding.
    const variableAfterLiteral = fixedDen && tokens.slice(tokens.indexOf(fixedDen) + 1).some((t) => t.type === 'digit');
    const denominatorCode = fixedDen ? (variableAfterLiteral ? 0 : (-Number(fixedDen.text) << 16) >> 16) : null;
    const denominator = denominatorCode < 0 ? -denominatorCode : null;
    const slashIndex = tokens.indexOf(slash);
    const firstDenominator = tokens.findIndex((t, i) => i > slashIndex && (t.type === 'digit' || t.type === 'denominator'));
    if (fractionCodeError(tokens)) return FORMAT_OVERFLOW;
    const denominatorComma = tokens.findIndex((t, i) => i > firstDenominator && t.type === 'comma');
    // Zero can take a trailing scale comma, but that cannot represent
    // a nonzero fraction this way. A comma within its digits is invalid even at zero.
    if (denominatorComma >= 0 && (n !== 0 || tokens.slice(denominatorComma + 1).some((t) => t.type === 'digit' || t.type === 'denominator'))) return FORMAT_OVERFLOW;
    const firstDigit = tokens.indexOf(numTokens[0]);
    const lastNumeratorDigit = tokens.indexOf(numTokens[numTokens.length - 1]);
    // Empty labels, fill instructions and percent signs still separate whole
    // and numerator fields. Prefix labels remain outside this range.
    const blank = text => {
      // Blanking a fraction hides glyphs, not its explicit spacing operations.
      // Layout markers remain attached to their original padding/fill token.
      const operations = new Set(tokens.filter(t => t.spacing && t.rendered != null).map(t => t.rendered));
      if (!operations.size) return ' '.repeat(text.length);
      return Array.from(text, char => operations.has(char) ? char : ' ').join('');
    };
    const separatorIndex = tokens.findLastIndex((t, i) => i > firstDigit && i < lastNumeratorDigit && (t.type === 'lit' || t.type === 'percent'));
    const hasWhole = separatorIndex >= 0;
    const wholeEnd = hasWhole ? tokens.findLastIndex((t, i) => i < separatorIndex && t.type === 'digit') : -1;
    const numeratorStart = hasWhole ? tokens.findIndex((t, i) => i > separatorIndex && t.type === 'digit') : firstDigit;
    let whole = hasWhole ? Math.floor(n) : 0;
    const rem = n - whole;
    // At most seven denominator digits are used for the approximation.
    // Further placeholders still control padding, not numerical precision.
    // Only the first contiguous placeholder field selects precision. A literal
    // followed by placeholders switches back to the default variable precision.
    let firstWidth = 0;
    for (let j = firstDenominator; tokens[j]?.type === 'digit'; j++) firstWidth++;
    const maxDen = 10 ** Math.min(fixedDen ? denominatorCode || 7 : firstWidth, 7) - 1;
    const fraction = denominator ? [0, denominator] : fractionFor(rem, maxDen);
    if (!fraction) return FORMAT_OVERFLOW;
    let [bestN, bestD] = fraction;
    if (denominator) {
      // The binary remainder rounds directly: 1.15 with # ?/10 is
      // 1 1/10, while 1.25 is 1 3/10. Rounding the whole scaled number first
      // or applying decimal significant-digit rounding changes these ties.
      bestN = Math.round(rem * denominator);
      // The fixed numerator has a signed 16-bit limit, checked before carry
      // into a mixed fraction's whole part (including a carry to exactly one).
      if (!Number.isFinite(bestN) || bestN >= 2 ** 15) return FORMAT_OVERFLOW;
    }
    if (hasWhole && bestN >= bestD) {
      whole += Math.floor(bestN / bestD);
      bestN %= bestD;
    }
    const numeratorTokens = tokens.slice(numeratorStart, slashIndex).filter((t) => t.type === 'digit');
    const mandatoryNumerator = numeratorTokens.some((t) => t.text === '0');
    const alignNumerator = numeratorTokens.find((t) => t.text !== '#')?.text === '?';
    let wholeText = '';
    const wholeLast = hasWhole ? tokens[wholeEnd].text : null;
    const retainWholeZero = whole === 0 && bestN === 0 && (numeratorTokens[0]?.text !== '0' || wholeLast === '?');
    const wholeDigitVisible = hasWhole && (whole !== 0 || retainWholeZero || wholeLast === '0');
    if (hasWhole) {
      // The value is already scaled. Keep percentage markers as literal text
      // while applying integer grouping, placeholder padding, and labels.
      const wholeFormat = tokens.slice(firstDigit, wholeEnd + 1).map((t) => t.type === 'percent' ? { type: 'lit', text: t.text } : t);
      // Retain zero in the final integer slot, preserving preceding optional
      // digits, alignment and literals instead of replacing the whole label.
      if (retainWholeZero) wholeFormat[wholeFormat.length - 1] = { type: 'digit', text: '0' };
      // The implicit zero of an otherwise empty mixed fraction is ordinary
      // Latin text; actual whole-number digits use the numeral system.
      wholeText = formatNumberSection(whole, wholeFormat, false, locale, calendar, null, retainWholeZero ? null : shape);
    }
    // "?" reserves a space for each digit it does not print, so a column of
    // fractions lines up: numerators pad on the left,
    // denominators on the right, and a whole number blanks its fraction and
    // slash to the same width (2 with "# ?/?" reads "2    ").
    const blanks = (placeholders) => placeholders.map((t) => (t.text === '?' ? ' ' : t.text === '0' ? '0' : '')).join('');
    const padded = (digits, placeholders, alignRight) => {
      const unused = Math.max(0, placeholders.length - digits.length);
      const fill = blanks(alignRight ? placeholders.slice(0, unused) : placeholders.slice(placeholders.length - unused));
      return alignRight ? fill + digits : digits + fill;
    };
    if (value < 0 && autoMinus && !hasWhole && bestN === 0 && onUnsignedZero) return onUnsignedZero();
    if (!prepareMeridiem(!hasWhole && bestN === 0)) return FORMAT_OVERFLOW;
    const affix = (part) => part.filter((t) => ['lit', 'percent', 'point', 'date', 'elapsed', 'ampm', 'denominator'].includes(t.type)).map(written).join('');
    const numeratorSuffix = affix(tokens.slice(lastNumeratorDigit + 1, slashIndex));
    const denominatorStart = fixedDen ? tokens.indexOf(fixedDen) : firstDenominator;
    // A fixed denominator can have several runs separated by labels. Only
    // the first run is localized; subsequent fixed runs retain their literal digits.
    const denominatorPrefix = tokens.slice(slashIndex + 1, denominatorStart).map((t) => t.type === 'comma' ? ',' : t.type === 'digit' ? (t.text === '?' ? ' ' : '0')
      : t === tokens[firstDenominator] ? shapeDigits(affix([t]), shape) : affix([t])).join('');
    let frac;
    const lastDenominatorIndex = tokens.findLastIndex((t) => t.type === 'denominator' || t.type === 'digit');
    const denominatorText = formatFractionDenominator(bestD, tokens.slice(denominatorStart, lastDenominatorIndex + 1), denominatorStart === firstDenominator ? shape : null);
    const reserveFraction = alignNumerator || tokens[firstDenominator]?.text.startsWith('?');
    const fractionBody = `${shapeDigits(padded(String(bestN), numeratorTokens, true), shape)}${numeratorSuffix}/${denominatorPrefix}${denominatorText}`;
    const showFraction = bestN !== 0 || !hasWhole || mandatoryNumerator;
    const blankEnd = denTokens.length ? tokens.indexOf(denTokens.at(-1)) : lastDenominatorIndex;
    if (showFraction) frac = fractionBody;
    else if (reserveFraction) frac = blank(fractionBody.slice(0, fractionBody.length - affix(tokens.slice(blankEnd + 1, lastDenominatorIndex + 1)).length));
    else frac = denTokens.map((t) => t.text === '?' ? ' ' : '').join('');
    const lastDigit = showFraction ? lastDenominatorIndex : blankEnd;
    let separator = '';
    if (hasWhole) {
      const label = affix(tokens.slice(wholeEnd + 1, numeratorStart));
      if (showFraction && wholeDigitVisible) separator = label;
      else if (showFraction ? wholeLast === '?' || numeratorTokens[0]?.text === '?' : reserveFraction) separator = blank(label);
    }
    // A mixed fraction keeps its signed whole zero, but an improper
    // fraction whose numerator rounds to zero has no automatic minus.
    const sign = value < 0 && autoMinus && (hasWhole || bestN !== 0) ? '-' : '';
    return `${sign}${affix(tokens.slice(0, firstDigit))}${wholeText}${separator}${frac}${affix(tokens.slice(lastDigit + 1))}`;
  }
  const decimals = fracTokens.length;
  const precision = Math.min(decimals, 100);
  const factor = 10 ** precision;
  // Integers need no rounding: multiplying and dividing can change their
  // digits at large magnitudes even when neither operation overflows. Other
  // values round half away from zero on their 15 significant decimal digits,
  // as ROUND does, so 1.005 with "0.00" reads 1.01 rather than 1.00.
  const rounded = !Number.isInteger(n) && Number.isFinite(n * factor)
    ? Math.sign(n) * Math.round(Number((Math.abs(n) * factor).toPrecision(15))) / factor
    : n;
  if (value < 0 && autoMinus && rounded === 0 && onUnsignedZero) return onUnsignedZero();
  if (!prepareMeridiem(rounded === 0)) return FORMAT_OVERFLOW;
  // From 1e15 on, toFixed prints the double's binary expansion (2^60 reads
  // 1152921504606846976) and switches to exponent notation at 1e21. Keep
  // fixed formats in decimal notation with the fifteen significant digits
  // a cell keeps, then zeros: 2^60 reads 1152921504606850000 and 1E23 reads
  // 100000000000000000000000, not 99999999999999991611392.
  let fixed = Number.isFinite(rounded) && rounded >= 1e15
    ? `${fifteenDigitInteger(rounded)}${precision ? `.${'0'.repeat(precision)}` : ''}`
    : rounded.toFixed(precision);
  // Below that, past 15 significant digits toFixed still prints the binary expansion (0.3 → 0.29999999999999999); zeros are padded instead.
  if (Number.isFinite(rounded) && rounded !== 0 && rounded < 1e15) {
    const digits = Math.abs(rounded).toPrecision(15);
    if (!digits.includes('e') && digits.replace('.', '').replace(/^0+/, '').length < fixed.replace(/^-/, '').replace('.', '').replace(/^0+/, '').length) {
      const [whole, frac = ''] = digits.split('.');
      fixed = `${rounded < 0 ? '-' : ''}${whole}${precision ? `.${frac.padEnd(precision, '0').slice(0, precision)}` : ''}`;
    }
  }
  const parts = fixed.split('.');
  intStr = parts[0];
  fracStr = parts.length > 1 ? parts[1].padEnd(decimals, '0') : '';
  // Trailing "#" in the fraction drops trailing zeros; "?" pads with spaces.
  // Keep a slot per placeholder so removing one does not erase later padding
  // or move a space across an embedded literal.
  const fractionalDigits = Array.from(fracStr);
  for (let i = fracTokens.length - 1; i >= 0; i--) {
    if (fractionalDigits[i] !== '0') break;
    if (fracTokens[i].text === '#') fractionalDigits[i] = '';
    else if (fracTokens[i].text === '?') fractionalDigits[i] = ' ';
    else break;
  }
  fracStr = fractionalDigits.join('');
  // Fill integer placeholders from the right. Missing digits use each slot's
  // own rule: 0 emits a zero, ? emits a space, and # emits nothing.
  // Zero fills every scientific integer slot, even # and ? slots.
  if (intStr === '0') intStr = exp ? '0'.repeat(intTokens.length) : '';
  const integerSlots = placeIntegerDigits(intStr, intTokens);
  // The code is written in file syntax (comma groups, period point); the output uses the locale's marks.
  const marks = localeInfo();
  if (grouping) {
    // Count every placeholder from the first displayed digit or padding slot.
    // A separator after an unused slot reserves a space to preserve alignment.
    // Indian grouping puts two-digit groups before the last three (12,34,567), as the Number format does.
    const groupAfter = (places) => (marks.lakh ? places === 3 || (places > 3 && (places - 3) % 2 === 0) : places % 3 === 0);
    const firstSlot = integerSlots.findIndex((slot) => slot !== '');
    let places = 0;
    for (let i = integerSlots.length - 1; firstSlot >= 0 && i >= firstSlot; i--) {
      let grouped = '';
      for (let j = Math.max(1, integerSlots[i].length) - 1; j >= 0; j--) {
        const ch = integerSlots[i][j] ?? '';
        const digit = /\d/.test(ch);
        if (digit || ch === '' || ch === ' ') {
          if (places && groupAfter(places)) grouped = (digit ? marks.group : ' ') + grouped;
          places++;
        } else places = 0;
        grouped = ch + grouped;
      }
      integerSlots[i] = grouped;
    }
  }
  if (integerSlots.length) intStr = integerSlots.join('');

  // Keep each slot attached to its token so embedded literals stay in place.
  const integerOutput = new Map(intTokens.map((t, i) => [t, integerSlots[i]]));
  const fractionalOutput = new Map(fracTokens.map((t, i) => [t,
    i === fracTokens.length - 1 ? fractionalDigits.slice(i).join('') : fractionalDigits[i] ?? '',
  ]));
  let exponentOutput = null;
  if (exp) {
    const body = tokens.slice(expIdx + 1);
    const point = body.findIndex(t => t.type === 'point');
    const integers = (point < 0 ? body : body.slice(0, point)).filter(t => t.type === 'digit');
    const fraction = point < 0 ? [] : body.slice(point + 1).filter(t => t.type === 'digit');
    const digits = String(Math.abs(exponent));
    const slots = placeIntegerDigits(digits, integers);
    const sign = exponent < 0 ? '-' : exp.text[1] === '+' ? '+' : '';
    exponentOutput = new Map(integers.map((t, i) => [t, (i === 0 ? sign : '') + slots[i]]));
    // An exponent is an integer: fractional placeholders contribute only their
    // own zero/padding, with # remaining empty even before a mandatory zero.
    fraction.forEach(t => exponentOutput.set(t, t.text === '0' ? '0' : t.text === '?' ? ' ' : ''));
    if (!integers.length && point >= 0) exponentOutput.set(body[point], sign + digits);
  }

  // Walk the tokens, emitting the number where its digits sit.
  let out = '';
  let intDone = false;
  tokens.forEach((t) => {
    switch (t.type) {
      case 'digit':
        if (integerOutput.has(t)) { out += shapeDigits(integerOutput.get(t), shape); intDone = true; }
        else out += shapeDigits(fractionalOutput.get(t) ?? exponentOutput?.get(t) ?? '', shape);
        break;
      case 'point':
        if (!intDone) { out += shapeDigits(intStr, shape); intDone = true; }
        out += shapeDigits(exponentOutput?.get(t) ?? '', shape);
        // The point prints whenever the code has one: 5 with "0.#" reads "5.".
        out += marks.decimal;
        break;
      case 'exp': {
        out += t.text[0];
        break;
      }
      case 'percent': out += '%'; break;
      case 'comma': break;
      case 'lit': out += t.rendered ?? t.text; break;
      case 'date': case 'elapsed': case 'ampm': out += written(t); break;
      default: break;
    }
  });
  if (!intDone) out = shapeDigits(intStr, shape) + out;
  // Only the automatic sign follows display rounding. Explicit negative
  // section literals (such as parentheses) still use the original value.
  return value < 0 && autoMinus && rounded !== 0 ? `-${out}` : out;
}

/** Read bracket directives outside quoted, escaped, padding, and fill literals. */
function* sectionDirectives(section = '') {
  if (!section.includes('[')) return;
  const parts = /"[^"]*(?:"|$)|\\.|_.|\*.|\[([^\]]*)\]/g;
  for (const part of section.matchAll(parts)) {
    if (part[1] !== undefined) yield part[1];
  }
}

function matchesCondition(value, { op, limit }) {
  switch (op) {
    case '<': return value < limit;
    case '<=': return value <= limit;
    case '>': return value > limit;
    case '>=': return value >= limit;
    case '=': return value === limit;
    case '<>': return value !== limit;
    default: return false;
  }
}

// Format codes as parsed, by code. A custom format is applied to every cell of its column on each
// render, export and search, and splitting and tokenizing the code cost more than printing the
// number; parsed once, a code is looked up here. Bounded, and cleared whole when full, like the
// module caches elsewhere; a code seen again after that is parsed again.
const parsedCodes = new Map();
const PARSED_CODES_MAX = 512;

/**
 * A code's sections, the tokens of each (tokensOf, as they are asked for) and what choosing a section
 * needs: its trailing text section if it has one, the numeric sections that remain, the conditions of
 * the first two, and whether a [$-ja-JP] tag puts the whole code in the Japanese calendar.
 */
function parseCode(code) {
  let parsed = parsedCodes.get(code);
  if (parsed) return parsed;
  const sections = splitSections(code);
  const tokens = new Map();
  const tokensOf = (section) => {
    let t = tokens.get(section);
    if (!t) tokens.set(section, t = tokenize(section));
    return t;
  };
  const last = sections[sections.length - 1];
  const trailingText = last.includes('@') && tokensOf(last).some((t) => t.type === 'at');
  // A trailing text section does not consume a numeric section. With no
  // numeric sections at all, numbers retain their General display.
  const numeric = sections.length < 4 && trailingText ? (sections.length === 1 ? ['General'] : sections.slice(0, -1)) : sections;
  const conditions = numeric.slice(0, 2).map(s => tokensOf(s).condition || null);
  // A Japanese locale tag in the first section puts the whole code in that calendar: the built-in era format tags its first
  // section only, [<=43585][$-ja-JP]ggge"年"m"月"d"日";[>=43831]ggge"年"m"月"d"日";ggg"元年"m"月"d"日".
  const localeTag = [...sectionDirectives(sections[0])].find(d => /^\$/.test(d));
  const japanese = !!localeTag && isJapaneseTag(localeTag);
  // The first locale tag names the language of the code's month and weekday names; without one they follow the regional format.
  const locale = localeTag ? tagLocale(localeTag) : null;
  const calendar = localeTag ? tagCalendar(localeTag) : 0;
  const numeral = localeTag ? tagNumeral(localeTag) : 0;
  // A text-only format has an implicit General numeric section. Otherwise the
  // first section's system format replaces any selected locale-bearing section.
  const system = localeTag && numeric[0] === sections[0] ? tagSystemFormat(localeTag) : null;
  // Invalid directive/date syntax invalidates the entire code, including unused
  // sections and text/Boolean values in TEXT. Cache this grammar check with
  // the parse rather than rescanning a whole column on every render.
  const syntaxError = sections.map((s, i) => {
    const t = tokensOf(s);
    return t.bracketError || (i > 1 && t.condition ? 'Use conditions only in the first two sections' : dateTimeCodeError(t))
      || textSectionError(t, i, sections.length)
      || (t.general > 1 ? 'Use General only once in each section' : null)
      || (t.general && t.some(token => token.type === 'digit') ? 'Use either General or numeric placeholders in a section' : null)
      || (system && (scientificCodeError(t) || fractionCodeError(t)));
  }).find(Boolean);
  // A lone General field (also implied by directives alone) has no implicit
  // fallback section and retains its sign. Decorated General is an ordinary
  // custom section, using the same fallback/sign rules as numeric fields.
  const generalOnly = numeric.length === 1 && numeric[0].trim() !== ''
    && tokensOf(numeric[0]).every(t => t.type === 'general');
  parsed = { sections, last, trailingText, numeric, conditions, japanese, locale, calendar, numeral, system, tokensOf, syntaxError, generalOnly };
  if (parsedCodes.size >= PARSED_CODES_MAX) parsedCodes.clear();
  parsedCodes.set(code, parsed);
  return parsed;
}

/** Select the section of a parsed code and whether a negative number needs an automatic minus. */
function pickInitialSection(parsed, value) {
  const { sections, last, trailingText } = parsed;
  if (typeof value === 'string' || typeof value === 'boolean') {
    return { section: sections.length === 4 || trailingText ? last : null };
  }
  const numeric = parsed.numeric;
  const conditions = parsed.conditions;
  if (conditions.some(Boolean)) {
    const first = conditions[0] || { op: '>', limit: 0 };
    let index = 0;
    if (!matchesCondition(value, first)) index = !conditions[1] || matchesCondition(value, conditions[1]) ? 1 : 2;
    const section = numeric[index] ?? (numeric.length === 1 && !parsed.generalOnly ? 'General' : null);
    const condition = index === 0 ? first : conditions[index];
    // Sections restricted to negative values supply their own sign. The
    // fallback of a one/two-section condition follows the first comparison.
    const minus = parsed.generalOnly || (condition
      ? !(condition.limit < 0 && ['<', '<=', '='].includes(condition.op) || condition.limit === 0 && condition.op === '<')
      : numeric.length >= 3 || first.op === '=' || first.limit > 0 && ['>', '>='].includes(first.op));
    return { section, minus, conditional: true };
  }
  const n = value;
  const index = numeric.length === 1 ? 0 : n < 0 ? 1 : n > 0 || numeric.length === 2 ? 0 : 2;
  return { section: numeric[index], minus: numeric.length === 1 };
}

function pickSection(parsed, value) {
  const selected = pickInitialSection(parsed, value);
  if (parsed.syntaxError || !(value < 0) || !selected.conditional || !selected.minus || selected.section == null) return selected;
  const positive = pickInitialSection(parsed, -value);
  if (positive.section === selected.section) return selected;
  const tokens = parsed.tokensOf(selected.section);
  if (!tokens.some(t => t.type === 'digit')) return selected;
  // Rounding away an automatic minus can reselect the conditional section.
  // Use the original magnitude, not zero, for the comparison and rendering.
  // Resolve here so the display, color and format classification agree.
  const result = formatNumberSection(value, tokens, true, parsed.locale, parsed.calendar, () => UNSIGNED_ZERO);
  return result === UNSIGNED_ZERO ? { ...positive, value: -value } : selected;
}

/**
 * Format a value with a code. Numbers use the number/date sections; text
 * uses the text section (or is returned as is). Booleans print TRUE/FALSE.
 */
// Callers such as TEXT can choose a distinct overflow result without mistaking
// a literal "#####" for an unrepresentable value.
function textTokenContent(t, value, locale) {
  return t.type === 'at' || t.type === 'general' ? value : t.type === 'lit' ? t.rendered ?? t.text
    : t.type === 'ampm' ? meridiemText(t, 0, locale) : '';
}

function formatCode(value, code, { overflow = '#####', textFunction = false, spacing = null } = {}) {
  if (value == null) return '';
  const parsed = parseCode(String(code || 'General'));
  if (parsed.syntaxError) return overflow;
  // Layout callers can retain padding/fill instructions in the rendered output.
  // Keep token text and semantic flags unchanged: literals also delimit numeric
  // fields, and the cached parse must stay reusable by TEXT and other cells.
  const tokensFor = sec => {
    const tokens = parsed.tokensOf(sec);
    if (!spacing || !tokens.some(t => t.spacing)) return tokens;
    const copy = Object.assign([], tokens);
    for (let i = 0; i < tokens.length; i++) if (tokens[i].spacing) copy[i] = { ...tokens[i], rendered: spacing(tokens[i].spacing) };
    return copy;
  };
  const logical = typeof value === 'boolean';
  if (logical) value = value ? 'TRUE' : 'FALSE';
  if (typeof value === 'string') {
    const { section: sec } = pickSection(parsed, value);
    if (sec == null) return value;
    // TEXT substitutes the system pattern even for its text
    // section; cell display keeps that section's @ and literals for strings.
    if ((textFunction || logical) && systemSectionKind(parsed, sec)) return '';
    // General in the text section shows the text the General way, which is the text itself: it stands where @ would.
    const textTokens = tokensFor(sec);
    if (!textTokens.length && sec.trim() !== '') return value;
    return textTokens.map(t => textTokenContent(t, value, parsed.numeric[0] === parsed.sections[0] ? parsed.locale : null)).join('');
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return '#NUM!';
  const selected = pickSection(parsed, value);
  const { section: sec, minus, conditional } = selected;
  value = selected.value ?? value;
  if (sec == null) return conditional ? overflow : formatGeneral(value);
  const system = systemSectionKind(parsed, sec);
  if (system) {
    const body = formatDateSection(value, systemDateTokens(system));
    return body === FORMAT_OVERFLOW ? overflow : body;
  }
  const generalValue = !minus ? Math.abs(value) : value;
  const sectionTokens = tokensFor(sec);
  const shape = numberShape(sectionTokens.numberShape, parsed.locale || getLocale(), parsed.numeral);
  if (sectionTokens.length === 1 && sectionTokens[0].type === 'general') return formatShapedGeneral(generalValue, shape);
  const tokens = sectionTokens;
  if (scientificCodeError(tokens)) return overflow;
  // A section made only of directives ('[Blue]', '[>=100][Red]') shows the number the General way in that colour.
  if (!tokens.length && sec.trim() !== '') return formatShapedGeneral(generalValue, shape);
  if (isDateSection(tokens)) {
    // Pure elapsed totals are signed quantities, not calendar serials. Render
    // their magnitude and apply the selected section's sign once, even when
    // rounding makes the total zero. Clock/calendar fields still reject negatives.
    const negativeElapsed = value < 0 && tokens.elapsedUnit && !tokens.needsClock;
    const body = formatDateSection(negativeElapsed ? -value : value, tokens, parsed.japanese, parsed.locale, parsed.calendar, shape);
    return body === FORMAT_OVERFLOW ? overflow : negativeElapsed && minus ? `-${body}` : body;
  }
  if (!tokens.some((t) => t.type === 'digit')) {
    // A section with no digits ("n/a", a General literal, a lone percent sign): print the literal parts and any
    // percent sign, with the automatic minus a single section gives a negative number (-n/a); a
    // code with a negative section of its own ("Yes";"No") supplies the sign itself.
    const text = tokens.map((t) => t.type === 'general' ? formatShapedGeneral(Math.abs(value), shape)
      : t.type === 'lit' || t.type === 'percent' ? t.rendered ?? t.text : '').join('');
    return value < 0 && minus ? `-${text}` : text;
  }
  const body = formatNumberSection(value, tokens, minus, parsed.locale, parsed.calendar, null, shape);
  if (body === FORMAT_OVERFLOW) return overflow;
  if (body == null) return '#NUM!';
  return body;
}

/** Width-independent strings used by formulas, editing and clipboard data. */
export function formatWithCode(value, code, options) {
  return formatCode(value, code, options);
}

/** Read displayed clock components when external HTML omits its raw serial.
 * Missing components are zero; neither hidden dates nor rounded-away precision
 * can be recovered. Only accept a serial whose format reproduces the display.
 * The normal input parser cannot distinguish seconds from days, or mm:ss from
 * hh:mm. Reuse the formatter's resolved minute fields and literal vocabulary.
 * Null means a clock display could not be recovered; undefined means the code
 * has no supported clock section, so ordinary input parsing can still apply.
 */
export function unformatTimeWithCode(text, code) {
  if (typeof text !== 'string' || !code || code.length > MAX_FORMAT_CODE_LENGTH) return undefined;
  const parsed = parseCode(code);
  if (parsed.syntaxError) return undefined;
  const normalize = s => normalizeNumberDigits(s).replace(/[\u00a0\u202f]/g, ' ');
  const escape = s => normalize(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const display = normalize(text);
  let clock = false;
  for (const section of parsed.numeric.slice(0, 3)) {
    const system = systemSectionKind(parsed, section);
    const tokens = system ? systemDateTokens(system) : parsed.tokensOf(section);
    if (dateSectionKind(tokens) !== 'time') continue;
    clock = true;
    const fields = [];
    let pattern = '^', variableDigits = false, supported = true;
    for (const t of tokens) {
      if (t.type === 'lit') {
        pattern += escape(t.text);
        if (/[^0-9]/.test(t.text)) variableDigits = false;
        continue;
      }
      let key, part, names;
      if (t.type === 'date' || t.type === 'elapsed') {
        // A contiguous run with at most one variable-width field is uniquely
        // separable (hmmss, hhmm, [h]mmss). Two variable fields such as hs can
        // name different times and also cause regexp backtracking; keep text.
        const variable = t.type === 'elapsed' || t.text.length === 1;
        if (variable && variableDigits) { supported = false; break; }
        variableDigits ||= variable;
        key = t.type === 'elapsed' ? `elapsed-${t.text[0]}` : t.minutes ? 'm' : t.text[0];
        part = t.type === 'elapsed' ? `(\\d{${Math.min(t.text.length, 2)},15})` : variable ? '(\\d{1,2})' : '(\\d{2})';
      } else if (t.type === 'subsecond') {
        key = 'fraction';
        part = escape(localeInfo().decimal) + `(\\d{${t.text.length - 1}})`;
        variableDigits = false;
      } else if (t.type === 'ampm') {
        key = 'period';
        names = [0, 12].map(h => normalize(meridiemText(t, h, parsed.locale)));
        part = `(${names.map(escape).join('|')})`;
        variableDigits = false;
      } else { supported = false; break; }
      fields.push({ key, names });
      pattern += part;
    }
    if (!supported || !fields.length) continue;
    const match = new RegExp(pattern + '$').exec(display);
    if (!match) continue;
    const values = new Map();
    let valid = true;
    fields.forEach(({ key, names }, i) => {
      const raw = match[i + 1];
      const n = names ? names.indexOf(raw) : key === 'fraction' ? Number(`0.${raw}`) : Number(raw);
      if (values.has(key) && values.get(key) !== n) valid = false;
      values.set(key, n);
    });
    let h = values.get('h') ?? 0;
    const m = values.get('m') ?? 0, s = values.get('s') ?? 0;
    if (!valid || m > 59 || s > 59 || h > 23) continue;
    if (values.has('period')) {
      if (!values.has('h') || h < 1 || h > 12) continue;
      h = h % 12 + values.get('period') * 12;
    }
    const elapsed = [...values].find(([key]) => key.startsWith('elapsed-'));
    const unit = elapsed ? { h: 3600, m: 60, s: 1 }[elapsed[0].at(-1)] : 86400;
    const seconds = (elapsed ? elapsed[1] * unit : h * 3600)
      + (unit > 60 ? m * 60 : 0) + (unit > 1 ? s : 0) + (values.get('fraction') ?? 0);
    const serial = seconds / 86400;
    if (Number.isFinite(serial) && normalize(formatWithCode(serial, code)) === display) return serial;
  }
  return clock ? null : undefined;
}

/** Recover text from a width-independent formatted string, only when every
 * placeholder identifies the same unique value. This is not numeric parsing:
 * rounded numbers and text hidden by a literal-only section cannot be recovered.
 * Sharing the formatter's tokens preserves quoted/escaped literals and treats
 * padding as one space and fill as empty, just like TEXT and clipboard TSV.
 */
export function unformatTextWithCode(text, code) {
  const parsed = parseCode(String(code || 'General'));
  if (parsed.syntaxError) return undefined;
  const { section } = pickInitialSection(parsed, '');
  if (section == null) return text;
  const tokens = parsed.tokensOf(section);
  if (!tokens.length && section.trim() !== '') return text;
  const locale = parsed.numeric[0] === parsed.sections[0] ? parsed.locale : null;
  const parts = tokens.map(t => t.type === 'at' || t.type === 'general' ? null : textTokenContent(t, '', locale));
  const count = parts.filter(p => p === null).length;
  if (!count) return undefined;
  const length = (text.length - parts.reduce((n, p) => n + (p?.length || 0), 0)) / count;
  if (length < 0 || !Number.isInteger(length)) return undefined;
  let offset = 0, value;
  for (const part of parts) {
    if (part === null) value ??= text.slice(offset, offset + length);
    const next = part ?? value;
    if (!text.startsWith(next, offset)) return undefined;
    offset += next.length;
  }
  return value;
}

/** Preserve selected-section spacing for layout without changing numeric evaluation.
 * Private markers carry literal operations through the existing field writer.
 * They are chosen outside the input alphabet and decoded here; no marker enters
 * a cell value, formula result, serialized workbook, DOM or cached parse.
 */
export function formatCodeParts(value, code) {
  if (value == null || !/[_*]/.test(code || '') || !['number', 'string', 'boolean'].includes(typeof value)) return null;
  const source = String(value) + String(code), markers = new Map();
  let next = 0xe000;
  const spacing = operation => {
    while (next <= 0xf8ff && source.includes(String.fromCharCode(next))) next++;
    let marker;
    if (next <= 0xf8ff) marker = String.fromCharCode(next++);
    else {
      // A text value can itself contain the entire private-use block. Numeric
      // sections have a bounded format code, so their markers stay one unit.
      let prefix = '\ue000';
      while (source.includes(prefix)) prefix += '\ue000';
      marker = prefix + markers.size + '\ue001';
    }
    markers.set(marker, operation);
    return marker;
  };
  const output = formatCode(value, code, { spacing });
  if (!markers.size) return null;
  const pattern = new RegExp('(' + [...markers.keys()].join('|') + ')', 'g');
  return output.split(pattern).filter(Boolean).map(text => markers.has(text) ? { ...markers.get(text) } : { type: 'text', text });
}

/** Keep the identity of text substitutions for character formatting. A literal
 * equal to the cell's value is still a literal; repeated @ tokens each carry
 * the complete value and its character formats. */
export function formatTextParts(value, code) {
  const parsed = parseCode(String(code || 'General'));
  if (parsed.syntaxError) return [{ type: 'text', text: '#####' }];
  const { section } = pickSection(parsed, value);
  if (section == null) return [{ type: 'text', text: value, value: true }];
  const tokens = parsed.tokensOf(section);
  if (!tokens.length && section.trim() !== '') return [{ type: 'text', text: value, value: true }];
  const locale = parsed.numeric[0] === parsed.sections[0] ? parsed.locale : null;
  return tokens.map(token => token.spacing ? { ...token.spacing }
    : { type: 'text', text: textTokenContent(token, value, locale),
      ...(token.type === 'at' || token.type === 'general' ? { value: true } : {}) });
}

/**
 * Why a format code cannot be used, or null when it is
 * well formed: a quotation mark or bracket left open, more than four sections, a bracket code that is
 * no colour, condition, locale, elapsed time or number-shape directive, an exponent without digits, or
 * date letters among digit placeholders. A code that hides numbers on purpose (";;;", '"n/a"') is well formed.
 */
export function formatCodeError(code) {
  if (typeof code !== 'string' || !code.trim()) return 'Enter a format code';
  if (code.length > MAX_FORMAT_CODE_LENGTH) return `A format code can have at most ${MAX_FORMAT_CODE_LENGTH} characters`;
  let quoted = false;
  let bracket = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (quoted) { if (ch === '"') quoted = false; continue; }
    if (bracket) { if (ch === ']') bracket = false; continue; }
    if (ch === '"') quoted = true;
    else if (ch === '[') bracket = true;
    else if (ch === '\\' || ch === '_' || ch === '*') i++;
  }
  if (quoted) return 'Close the quotation mark: text goes between a pair, like "kg"';
  if (bracket) return 'Close the bracket: a colour or condition goes between a pair, like [Red] or [>100]';
  const sections = splitSections(code);
  if (sections.length > 4) return 'A format code has at most four sections: positive;negative;zero;text';
  const parsed = parseCode(code);
  if (parsed.syntaxError) return parsed.syntaxError;
  for (const section of sections) {
    const tokens = parsed.tokensOf(section);
    const fractionError = fractionCodeError(tokens);
    if (fractionError) return fractionError;
    const scientificError = scientificCodeError(tokens);
    if (scientificError) return scientificError;
    const dateTimeError = dateTimeCodeError(tokens);
    if (dateTimeError) return dateTimeError;
  }
  return null;
}

export const isValidFormatCode = (code) => formatCodeError(code) == null;

const SECTION_COLORS = { black: '#000000', blue: '#0000ff', cyan: '#00ffff', green: '#00ff00', magenta: '#ff00ff', red: '#ff0000', white: '#ffffff', yellow: '#ffff00' };

/** A section's text color as CSS, resolving numbered colors in the workbook palette. */
export function codeColor(value, code, palette = null) {
  if (!['number', 'string', 'boolean'].includes(typeof value) || !code || !/\[/.test(code)) return null;
  const parsed = parseCode(String(code));
  if (parsed.syntaxError) return null;
  const { section: sec } = pickSection(parsed, value);
  if (sec == null) return null;
  // Read once per section of a code, as the grid asks for every rendered cell of a column.
  parsed.colors ??= new Map();
  let color = parsed.colors.get(sec);
  if (color === undefined) parsed.colors.set(sec, color = sectionColor(sec));
  if (!color) return null;
  // Named colors are fixed values. Numbered colors
  // address the mutable legacy palette after its eight reserved entries.
  if (color.name) return SECTION_COLORS[color.name];
  const index = color.index + 7;
  const custom = palette?.indexed?.[index];
  return typeof custom === 'string' && /^#[0-9a-f]{6}$/i.test(custom)
    ? custom.toLowerCase() : DEFAULT_COLOR_PALETTE.indexed[index];
}

/** Cache the directive, not its resolved paint: parsed codes span workbooks. */
function sectionColor(section) {
  for (const directive of sectionDirectives(section)) {
    const color = bracketDirective(directive);
    if (color?.kind !== 'color') continue;
    return color;
  }
  return null;
}

/**
 * A custom code with one decimal place more (`step` 1) or fewer (-1) in each section that shows a number, as
 * Excel's Increase and Decrease Decimal buttons change it: #,##0.00_);(#,##0.00) → #,##0.000_);(#,##0.000),
 * 0% → 0.0%, 0.00E+00 → 0.000E+00. Quoted text, escapes, padding and [directives] are kept as written; a
 * section of a date, a time, a fraction, text or General is left alone, and one whose digits are all ? and
 * have no decimal point (the "-"?? an Accounting zero is padded with) widens or narrows by one ? to keep in
 * line. Null when no section changes, including fewer places on a code that already shows none.
 */
export function stepCodeDecimals(code, step) {
  if (typeof code !== 'string' || !code || code.length > MAX_FORMAT_CODE_LENGTH || !step || parseCode(code).syntaxError) return null;
  const up = step > 0;
  const sections = [];
  let current = '', quoted = false, bracket = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (quoted) { current += ch; if (ch === '"') quoted = false; continue; }
    if (bracket) { current += ch; if (ch === ']') bracket = false; continue; }
    if (ch === '\\' || ch === '_' || ch === '*') { current += ch + (code[i + 1] ?? ''); i++; continue; }
    if (ch === '"') quoted = true;
    else if (ch === '[') bracket = true;
    else if (ch === ';') { sections.push(current); current = ''; continue; }
    current += ch;
  }
  sections.push(current);
  let changed = false;
  const out = sections.map((section) => {
    // The characters that are code, not literal text: their positions in the section.
    const live = [];
    for (let i = 0; i < section.length; i++) {
      const ch = section[i];
      if (ch === '"') { const end = section.indexOf('"', i + 1); i = end < 0 ? section.length : end; continue; }
      if (ch === '[') { const end = section.indexOf(']', i + 1); i = end < 0 ? section.length : end; continue; }
      if (ch === '\\' || ch === '_' || ch === '*') { i++; continue; }
      live.push(i);
    }
    const text = live.map((i) => section[i]).join('');
    if (/general|[ymdhsgb@/]|a\/p|am\/pm/i.test(text)) return section;
    const exponent = live.findIndex((i, k) => /e/i.test(section[i]) && /[+-]/.test(section[live[k + 1]] ?? ''));
    const mantissa = exponent < 0 ? live : live.slice(0, exponent);
    const digits = mantissa.filter((i) => '0#?'.includes(section[i]));
    if (!digits.length) return section;
    const point = mantissa.find((i) => section[i] === '.');
    const last = digits[digits.length - 1];
    let next = null;
    if (point == null) {
      if (digits.every((i) => section[i] === '?')) next = up ? `${section.slice(0, last + 1)}?${section.slice(last + 1)}` : `${section.slice(0, last)}${section.slice(last + 1)}`;
      else if (up) next = `${section.slice(0, last + 1)}.0${section.slice(last + 1)}`;
    } else if (up) {
      // Excel shows at most thirty decimal places.
      if (digits.filter((i) => i > point).length >= 30) return section;
      const at = Math.max(point, last);
      next = `${section.slice(0, at + 1)}0${section.slice(at + 1)}`;
    } else {
      const places = digits.filter((i) => i > point);
      const cut = places.length ? places[places.length - 1] : point;
      next = section.slice(0, cut) + section.slice(cut + 1);
      if (places.length === 1) next = next.slice(0, point) + next.slice(point + 1);
    }
    if (next == null || next === section) return section;
    changed = true;
    return next;
  });
  const stepped = out.join(';');
  return changed && stepped.length <= MAX_FORMAT_CODE_LENGTH ? stepped : null;
}

/** A short list of codes to offer in the custom-format dialog. */
export const CUSTOM_FORMAT_PRESETS = [
  ['#,##0.00', 'Number with separators'],
  ['0.0', 'One decimal'],
  ['#,##0;[Red](#,##0)', 'Negatives in parentheses'],
  ['#,##0,"K"', 'Thousands as K'],
  ['0.0%', 'Percent, one decimal'],
  ['0.00E+00', 'Scientific'],
  ['# ?/?', 'Fraction'],
  ['yyyy-mm-dd', 'ISO date'],
  ['d mmm yyyy', 'Day month year'],
  ['dddd, mmmm d', 'Weekday, month day'],
  ['h:mm AM/PM', '12-hour time'],
  ['[h]:mm', 'Elapsed hours'],
  ['"$"#,##0.00;"-$"#,##0.00', 'Currency with minus'],
  ['@ "units"', 'Text with a suffix'],
];
