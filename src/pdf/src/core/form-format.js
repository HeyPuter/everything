/**
 * Acrobat's number and percent formats (AFNumber_Format and AFPercent_Format in a text field's
 * format action), and its simple calculations (AFSimple_Calculate). The value keeps what was
 * typed; viewers show it formatted. No document JavaScript runs: the calls are read as data.
 */
import {
  PDFDict,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFString,
  decodePDFRawStream,
} from 'pdf-lib';

const jsString = (literal) =>
  literal
    .slice(1, -1)
    .replace(/\\u([\da-fA-F]{4})|\\(.)/g, (_, code, char) =>
      code ? String.fromCharCode(parseInt(code, 16)) : char,
    );
const STRING = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;

/** The script of a field's format (F) or calculation (C) action. */
function actionScript(field, key = 'F') {
  const actions = field.acroField.dict.lookup(PDFName.of('AA'));
  const action = actions instanceof PDFDict ? actions.lookup(PDFName.of(key)) : undefined;
  const script = action instanceof PDFDict ? action.lookup(PDFName.of('JS')) : undefined;
  if (script instanceof PDFString || script instanceof PDFHexString) return script.decodeText();
  if (script instanceof PDFRawStream)
    try {
      return new TextDecoder().decode(decodePDFRawStream(script).decode());
    } catch {
      return '';
    }
  return '';
}

/** The field's number format, or null when it has none. */
export function numberFormat(field) {
  const script = actionScript(field);
  const number = script.match(
    /AFNumber_Format\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*\d+\s*,\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*,\s*(true|false)/,
  );
  if (number)
    return {
      percent: false,
      decimals: Number(number[1]),
      separators: Number(number[2]),
      parentheses: Number(number[3]) >= 2,
      // A JavaScript string: \u20AC is the euro sign.
      currency: jsString(number[4]),
      prepend: number[5] === 'true',
    };
  const percent = script.match(/AFPercent_Format\(\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*(true|false))?/);
  if (percent)
    return {
      percent: true,
      decimals: Number(percent[1]),
      separators: Number(percent[2]),
      prepend: percent[3] === 'true',
    };
  return null;
}

/**
 * Acrobat's special formats (AFSpecial_Format): the digits each takes, the pattern its value
 * shows in (9 stands for a digit), and an example for people.
 */
const SPECIAL = [
  { name: 'a ZIP Code', digits: [5], example: '12345' },
  { name: 'a ZIP+4 code', digits: [9], example: '12345-6789' },
  { name: 'a phone number', digits: [10, 7], example: '(555) 123-4567' },
  { name: 'a Social Security number', digits: [9], example: '123-45-6789' },
];
const SPECIAL_PATTERNS = {
  5: ['99999'],
  9: ['99999-9999', '999-99-9999'],
  10: ['(999) 999-9999'],
  7: ['999-9999'],
};

/** The field's special format (ZIP Code, ZIP+4, phone, or Social Security number), or null. */
export function specialFormat(field) {
  const match = actionScript(field).match(/AFSpecial_Format\(\s*([0-3])\s*\)/);
  return match ? { ...SPECIAL[match[1]], style: Number(match[1]) } : null;
}

/** The digits of a value in a special format, or null when it is not one: 123-45-6789. */
export function specialDigits(text, format) {
  const value = String(text).trim();
  if (!/^[\d\s().-]*$/.test(value)) return null;
  const digits = value.replace(/\D/g, '');
  return format.digits.includes(digits.length) ? digits : null;
}

/** The value as its special format shows it, (555) 123-4567; other text shows as it is. */
export function formattedSpecial(text, format) {
  const digits = format && specialDigits(text, format);
  if (!digits) return text;
  const pattern = SPECIAL_PATTERNS[digits.length][format.style === 3 ? 1 : 0];
  let next = 0;
  return pattern.replace(/9/g, () => digits[next++]);
}

/** AFDate_Format's numbered formats, older than AFDate_FormatEx's patterns. */
const DATE_FORMATS = [
  'm/d',
  'm/d/yy',
  'mm/dd/yy',
  'mm/yy',
  'd-mmm',
  'd-mmm-yy',
  'dd-mmm-yy',
  'yy-mm-dd',
  'mmm-yy',
  'mmmm-yy',
  'mmm d, yyyy',
  'mmmm d, yyyy',
  'm/d/yy h:MM tt',
  'm/d/yy HH:MM',
];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** A date pattern's parts: letters of one kind (mm, yyyy, HH) or literal text. */
const DATE_TOKEN = /(\\.|y+|m+|d+|H+|h+|M+|s+|t+)/;
const datePart = (token) =>
  // ddd and dddd are the day's name, which a date is not read from.
  token.startsWith('ddd')
    ? null
    : ({ y: 'year', m: 'month', d: 'day', H: 'hour', h: 'hour', M: 'minute', s: 'second' }[
        token[0]
      ] ?? null);

/** AFTime_Format's numbered formats. */
const TIME_FORMATS = ['HH:MM', 'h:MM tt', 'HH:MM:ss', 'h:MM:ss tt'];
/**
 * The field's date or time pattern (AFDate_FormatEx and AFTime_FormatEx, or the numbered ones
 * of AFDate_Format and AFTime_Format), or null.
 */
export const dateFormat = (field) => datePattern(actionScript(field));
/** The date or time pattern a format script writes values in, or null. */
export function datePattern(script) {
  const pattern = script.match(
    /AF(?:Date|Time)_FormatEx\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\)/,
  );
  if (pattern) return jsString(pattern[1]) || null;
  const numbered = script.match(/AF(Date|Time)_Format\(\s*(\d+)\s*\)/);
  return (numbered && (numbered[1] === 'Date' ? DATE_FORMATS : TIME_FORMATS)[numbered[2]]) || null;
}

/** Whether a date pattern writes a time alone, such as h:MM tt. */
export const timeOnly = (pattern) =>
  !pattern
    .split(DATE_TOKEN)
    .some((token, i) => i % 2 && ['year', 'month', 'day'].includes(datePart(token)));

/**
 * The date typed, read in the order the pattern gives its parts (3/15/26 for mm/dd/yyyy,
 * 15.3.2026 for dd.mm.yyyy), or null when it is no date: Acrobat's lenient reading. A month
 * may be written as its name, a four-digit year stands anywhere, two-digit years are 1950 to
 * 2049, and a missing year is this year. Times read the same way, with am or pm.
 */
export function typedDate(text, pattern, today = new Date()) {
  const tokens = pattern.split(DATE_TOKEN).filter((token, i) => i % 2 && !token.startsWith('\\'));
  const parts = [...new Set(tokens.map(datePart).filter(Boolean))];
  const words =
    String(text)
      .toLowerCase()
      .match(/\p{L}+/gu) ?? [];
  const numbers = String(text).match(/\d+/g) ?? [];
  if (!parts.length || !numbers.length) return null;
  const found = {};
  for (const word of words) {
    const month = MONTHS.findIndex(
      (name) => word.length >= 3 && name.toLowerCase().startsWith(word),
    );
    if (month >= 0 && found.month === undefined) found.month = month + 1;
    else if (['am', 'a', 'pm', 'p'].includes(word)) found.half = word[0];
    else if (!DAYS.some((day) => word.length >= 3 && day.toLowerCase().startsWith(word)))
      return null;
  }
  const year = numbers.findIndex((number) => number.length === 4);
  if (year >= 0 && parts.includes('year')) found.year = Number(numbers.splice(year, 1)[0]);
  for (const part of parts) {
    if (found[part] !== undefined || !numbers.length) continue;
    const number = numbers.shift();
    if (number.length > (part === 'year' ? 4 : 2)) return null;
    found[part] = Number(number);
  }
  if (numbers.length) return null;
  if (found.year === undefined) {
    // Day and month without a year are this year's; a date needs its other parts.
    if (parts.includes('year') && !(parts.includes('month') && found.month !== undefined))
      return null;
    found.year = today.getFullYear();
  } else if (found.year < 100) found.year += found.year < 50 ? 2000 : 1900;
  if (parts.includes('month') && found.month === undefined) return null;
  if (parts.includes('day') && found.day === undefined) return null;
  let { month = 1, day = 1, hour = 0, minute = 0, second = 0 } = found;
  if (found.half) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (found.half === 'p' ? 12 : 0);
  }
  // In UTC, where no clock change skips an hour.
  const date = new Date(Date.UTC(found.year, month - 1, day, hour, minute, second));
  return date.getUTCFullYear() === found.year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    hour < 24 &&
    minute < 60 &&
    second < 60
    ? date
    : null;
}

/** The date (in UTC, as typedDate reads it) as the pattern writes it: mm/dd/yyyy, h:MM tt. */
export function printedDate(date, pattern) {
  const pad = (number, size) => String(number).padStart(size, '0');
  const values = {
    y: (n) => (n > 2 ? pad(date.getUTCFullYear(), 4) : pad(date.getUTCFullYear() % 100, 2)),
    m: (n) =>
      n > 3
        ? MONTHS[date.getUTCMonth()]
        : n > 2
          ? MONTHS[date.getUTCMonth()].slice(0, 3)
          : pad(date.getUTCMonth() + 1, n),
    d: (n) =>
      n > 3
        ? DAYS[date.getUTCDay()]
        : n > 2
          ? DAYS[date.getUTCDay()].slice(0, 3)
          : pad(date.getUTCDate(), n),
    H: (n) => pad(date.getUTCHours(), n),
    h: (n) => pad(date.getUTCHours() % 12 || 12, n),
    M: (n) => pad(date.getUTCMinutes(), n),
    s: (n) => pad(date.getUTCSeconds(), n),
    t: (n) => (date.getUTCHours() < 12 ? 'am' : 'pm').slice(0, n),
  };
  return pattern
    .split(DATE_TOKEN)
    .map((token, i) =>
      i % 2
        ? token.startsWith('\\')
          ? token[1]
          : values[token[0]](Math.min(token.length, 4))
        : token,
    )
    .join('');
}

/** The value as its date pattern writes it; text that is no date shows as it is. */
export function formattedDate(text, pattern) {
  const date = pattern && String(text).trim() ? typedDate(text, pattern) : null;
  return date ? printedDate(date, pattern) : text;
}

/** The value as the field's number, date, or special format shows it. */
export const formattedValue = (text, field) =>
  formattedSpecial(
    formattedDate(formattedNumber(text, numberFormat(field)), dateFormat(field)),
    specialFormat(field),
  );

/**
 * The field's calculation when it is one of Acrobat's own ("Value is the sum of the following
 * fields", AFSimple_Calculate): the operation and the names of the fields, or null.
 */
export function simpleCalculation(field) {
  const call = actionScript(field, 'C').match(
    /AFSimple_Calculate\(\s*["'](SUM|PRD|AVG|MIN|MAX)["']\s*,\s*(new\s+Array\s*\(([^)]*)\)|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\)/,
  );
  if (!call) return null;
  const names =
    call[3] !== undefined
      ? (call[3].match(STRING) ?? []).map(jsString)
      : jsString(call[2]).split(',');
  return { operation: call[1], names: names.map((name) => name.trim()).filter(Boolean) };
}

/**
 * The field's calculation when it is written in Acrobat's simplified field notation (Qty *
 * Price, (Subtotal - Discount) * 1.08), which Acrobat keeps between BVCALC and EVCALC in its
 * script: the names of the fields it reads and a function working it out from their numbers,
 * or null. Names escape spaces and operators with a backslash, as Acrobat writes them.
 */
export function formulaCalculation(field) {
  const formula = actionScript(field, 'C').match(/\bBVCALC\b([\s\S]*?)\bEVCALC\b/)?.[1];
  if (formula === undefined) return null;
  const tokens = [];
  for (let i = 0; i < formula.length;) {
    const char = formula[i];
    const number = formula.slice(i).match(/^(\d+\.?\d*|\.\d+)/)?.[0];
    if (/\s/.test(char)) i++;
    else if ('+-*/()'.includes(char)) {
      tokens.push({ op: char });
      i++;
    } else if (number) {
      tokens.push({ number: Number(number) });
      i += number.length;
    } else {
      // A name runs to the next space or operator; a backslash keeps the next character.
      let name = '';
      for (; i < formula.length && !/[\s+\-*/()]/.test(formula[i]); i++)
        name += formula[i] === '\\' ? (formula[++i] ?? '') : formula[i];
      tokens.push({ name });
    }
  }
  const names = new Set();
  let at = 0;
  const peek = (op) => tokens[at]?.op === op;
  const expression = () => {
    let node = term();
    while (peek('+') || peek('-')) {
      const [op, left, right] = [tokens[at++].op, node, term()];
      node = (values) => (op === '+' ? left(values) + right(values) : left(values) - right(values));
    }
    return node;
  };
  const term = () => {
    let node = factor();
    while (peek('*') || peek('/')) {
      const [op, left, right] = [tokens[at++].op, node, factor()];
      node = (values) => (op === '*' ? left(values) * right(values) : left(values) / right(values));
    }
    return node;
  };
  const factor = () => {
    const token = tokens[at++];
    if (!token) throw new Error('incomplete');
    if (token.op === '-' || token.op === '+') {
      const inner = factor();
      return token.op === '-' ? (values) => -inner(values) : inner;
    }
    if (token.op === '(') {
      const inner = expression();
      if (!peek(')')) throw new Error('unclosed');
      at++;
      return inner;
    }
    if (token.number !== undefined) return () => token.number;
    if (token.name) {
      names.add(token.name);
      return (values) => values.get(token.name);
    }
    throw new Error('unexpected');
  };
  try {
    const evaluate = expression();
    return at === tokens.length && names.size ? { names: [...names], evaluate } : null;
  } catch {
    return null;
  }
}

/**
 * The field's range check (AFRange_Validate: "Value must be greater than or equal to 0 and
 * less than or equal to 100"): its least and greatest numbers, either null when unchecked.
 */
export function rangeValidation(field) {
  const check = actionScript(field, 'V').match(
    /AFRange_Validate\(\s*(true|false)\s*,\s*([-+]?(?:\d+\.?\d*|\.\d+))\s*,\s*(true|false)\s*,\s*([-+]?(?:\d+\.?\d*|\.\d+))\s*\)/,
  );
  if (!check || (check[1] === 'false' && check[3] === 'false')) return null;
  return {
    min: check[1] === 'true' ? Number(check[2]) : null,
    max: check[3] === 'true' ? Number(check[4]) : null,
  };
}

/** Whether the field checks for an email address, as Prepare a form's Email format does. */
export const emailValidation = (field) => actionScript(field, 'V').includes('valid email');
/** The address check of the Email format's script. */
export const isEmailAddress = (text) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(text).trim());

/** Acrobat's separator styles: thousands groups and decimal mark. */
const SEPARATORS = [
  [',', '.'],
  ['', '.'],
  ['.', ','],
  ['', ','],
  ["'", '.'],
];

const separators = (format) => SEPARATORS[format.separators] ?? SEPARATORS[0];
/** The decimal mark of a number format: a point, or a comma for its comma styles. */
export const decimalMark = (format) => separators(format)[1];

/**
 * The number typed, with either decimal mark and no grouping, or null when it is none. Given
 * a field's `format`, the mark it groups thousands with is not taken for a decimal mark: 1,234
 * typed in a dollar field showing 1,234.00 is not 1.234.
 */
export function typedNumber(text, format) {
  const value = String(text).trim();
  const marks = format ? '.,'.replace(separators(format)[0], '') : '.,';
  return new RegExp(`^[+-]?(\\d+([${marks}]\\d*)?|[${marks}]\\d+)$`).test(value)
    ? Number(value.replace(',', '.'))
    : null;
}

/** The value as the format shows it; text that is not a number shows as it is. */
export function formattedNumber(text, format) {
  if (!format || !String(text).trim()) return text;
  let number = typedNumber(text);
  if (number === null) return text;
  if (format.percent) number *= 100;
  const [group, mark] = SEPARATORS[format.separators] ?? SEPARATORS[0];
  const decimals = Math.min(format.decimals, 20);
  const [whole, fraction] = Math.abs(number).toFixed(decimals).split('.');
  const digits =
    whole.replace(/\B(?=(\d{3})+(?!\d))/g, group) + (fraction ? `${mark}${fraction}` : '');
  const negative = number < 0 && Number(Math.abs(number).toFixed(decimals)) !== 0;
  if (format.percent) {
    const shown = format.prepend ? `%${digits}` : `${digits}%`;
    return negative ? `-${shown}` : shown;
  }
  const shown = format.prepend ? `${format.currency}${digits}` : `${digits}${format.currency}`;
  if (!negative) return shown;
  return format.parentheses ? `(${shown})` : `-${shown}`;
}
