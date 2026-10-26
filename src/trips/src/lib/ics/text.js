// RFC 5545 value and content-line helpers.

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const octets = (code) => (code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4);

/**
 * TEXT value: line breaks become `\n`, `\ ; ,` are escaped, and other control characters are dropped, since a bare CR
 * could start a new property in some parsers. `max` truncates to that many characters with an ellipsis.
 */
export function escapeText(value, max = Infinity) {
  let text = String(value ?? '').replace(LONE_SURROGATE, '\uFFFD').replace(/\r\n|\r/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  const chars = [...text];
  if (chars.length > max) text = `${chars.slice(0, Math.max(0, max - 1)).join('').trimEnd()}…`;
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

/** Folds a content line to at most 75 octets per line, never inside a UTF-8 sequence. */
export function foldLine(line) {
  let out = '';
  let size = 0;
  for (const char of line) {
    const width = octets(char.codePointAt(0));
    if (size + width > 75) { out += '\r\n '; size = 1; }
    out += char;
    size += width;
  }
  return out;
}

/** `2027-05-01` → `20270501`. */
export const dateValue = (date) => date.replaceAll('-', '');
/** Local date-time without zone: `20270501T083000`. */
export const localValue = (date, time) => `${dateValue(date)}T${time.replace(':', '')}00`;
/** UTC date-time: `20270501T073000Z`. */
export const utcValue = (epoch) => new Date(epoch).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Signed minutes as a DURATION: `-90` → `-PT1H30M`, `2340` → `P1DT15H`, `0` → `PT0S`. */
export function durationValue(minutes) {
  const total = Math.round(Math.abs(minutes));
  if (!total) return 'PT0S';
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const rest = total % 60;
  const time = `${hours ? `${hours}H` : ''}${rest ? `${rest}M` : ''}`;
  return `${minutes < 0 ? '-' : ''}P${days ? `${days}D` : ''}${time ? `T${time}` : ''}`;
}

/** UTC offset in minutes as `+hhmm`/`-hhmm`. */
export function offsetValue(minutes) {
  const total = Math.abs(Math.round(minutes));
  return `${minutes < 0 ? '-' : '+'}${String(Math.floor(total / 60)).padStart(2, '0')}${String(total % 60).padStart(2, '0')}`;
}
