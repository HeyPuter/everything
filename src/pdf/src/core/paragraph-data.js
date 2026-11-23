import { PDFNumber } from 'pdf-lib';

const finite = (n) => Number.isFinite(n) && Math.abs(n) <= 1e7;
export const paragraphVector = (m, [x, y]) => [m[0] * x + m[2] * y, m[1] * x + m[3] * y];

/**
 * Private, non-rendering marked content; decoded PDF glyphs remain authoritative.
 * Frame: origin delta, width vector, leading vector, all relative to the first run's CTM.
 * Items: 1 consumes a glyph run, 2 an empty base-font run, 0 an empty hard-break run;
 * -1 is a legacy unformatted hard break, -2 an automatic wrap, [x,y] a geometric space.
 * Optional Style bits: underline (1), strikethrough (2), and an unwrapped text box (4).
 * Optional Indent: how far in the first line starts, as a fraction of the width.
 */
export function readParagraphData(args) {
  if (args[0]?.type !== 'name' || args[0]?.value !== 'PuterParagraph' || args[1]?.type !== 'dict')
    return null;
  const tokens = args[1].value,
    values = Object.create(null);
  if (![6, 8, 10].includes(tokens.length)) return null;
  for (let i = 0; i < tokens.length; i += 2) {
    if (
      tokens[i].type !== 'name' ||
      !['V', 'Frame', 'Items', 'Style', 'Indent'].includes(tokens[i].value) ||
      Object.hasOwn(values, tokens[i].value)
    )
      return null;
    values[tokens[i].value] = tokens[i + 1];
  }
  if (
    values.V?.type !== 'number' ||
    values.V.value !== 1 ||
    values.Frame?.type !== 'array' ||
    values.Items?.type !== 'array'
  )
    return null;
  if (
    values.Style &&
    (values.Style.type !== 'number' ||
      !Number.isInteger(values.Style.value) ||
      values.Style.value < 0 ||
      values.Style.value > 7)
  )
    return null;
  if (
    values.Indent &&
    (values.Indent.type !== 'number' || !(values.Indent.value >= 0 && values.Indent.value < 1))
  )
    return null;
  const numbers = (token, length) =>
    token?.type === 'array' &&
    token.value.length === length &&
    token.value.every((t) => t.type === 'number' && finite(t.value))
      ? token.value.map((t) => t.value)
      : null;
  const frame = numbers(values.Frame, 6);
  if (!frame || !Math.hypot(...frame.slice(2, 4)) || !Math.hypot(...frame.slice(4))) return null;
  if (!values.Items.value.length || values.Items.value.length > 15000) return null;
  const items = [];
  for (const token of values.Items.value) {
    const value =
      token.type === 'number' && [0, 1, 2, -1, -2].includes(token.value)
        ? token.value
        : numbers(token, 2);
    if (value === null || value === false) return null;
    items.push(value);
  }
  if (!items.includes(1) || items.filter((item) => item === 1).length > 5000) return null;
  return {
    frame,
    items,
    ...(values.Style && {
      underline: Boolean(values.Style.value & 1),
      strikethrough: Boolean(values.Style.value & 2),
      line: Boolean(values.Style.value & 4),
    }),
    ...(values.Indent?.value && { indent: values.Indent.value }),
  };
}

export function textStyleBits({ underline, strikethrough, line }) {
  return (underline ? 1 : 0) | (strikethrough ? 2 : 0) | (line ? 4 : 0);
}

export function writeParagraphData(frame, items, style, indent = 0) {
  const encode = (value) =>
    Array.isArray(value) ? `[${value.map(encode).join(' ')}]` : PDFNumber.of(value).toString();
  return `/PuterParagraph << /V 1 /Frame ${encode(frame)} /Items ${encode(items)}${style ? ` /Style ${textStyleBits(style)}` : ''}${indent ? ` /Indent ${encode(indent)}` : ''} >> BDC`;
}

export function validateParagraphLayout(layout, text) {
  if (!layout) return new Set();
  if (
    !finite(layout.width) ||
    layout.width <= 0 ||
    !finite(layout.leading) ||
    layout.leading <= 0 ||
    !Array.isArray(layout.softBreaks) ||
    layout.softBreaks.some(
      (n, i, list) => !Number.isInteger(n) || n < 0 || text[n] !== '\n' || (i && n <= list[i - 1]),
    )
  )
    throw new Error('The paragraph layout changed. Select the text again.');
  return new Set(layout.softBreaks);
}
