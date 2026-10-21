/**
 * Acrobat's number and percent formats (AFNumber_Format and AFPercent_Format in a text field's
 * format action). The value keeps what was typed; viewers show it formatted. No document
 * JavaScript runs: the calls are read as data.
 */
import {
  PDFDict,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFString,
  decodePDFRawStream,
} from 'pdf-lib';

function formatScript(field) {
  const actions = field.acroField.dict.lookup(PDFName.of('AA'));
  const action = actions instanceof PDFDict ? actions.lookup(PDFName.of('F')) : undefined;
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
  const script = formatScript(field);
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
      currency: number[4]
        .slice(1, -1)
        .replace(/\\u([\da-fA-F]{4})|\\(.)/g, (_, code, char) =>
          code ? String.fromCharCode(parseInt(code, 16)) : char,
        ),
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

/** The number typed, with either decimal mark and no grouping, or null when it is none. */
export function typedNumber(text) {
  const value = String(text).trim();
  return /^[+-]?(\d+([.,]\d*)?|[.,]\d+)$/.test(value) ? Number(value.replace(',', '.')) : null;
}

/** Acrobat's separator styles: thousands groups and decimal mark. */
const SEPARATORS = [
  [',', '.'],
  ['', '.'],
  ['.', ','],
  ['', ','],
  ["'", '.'],
];

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
