/**
 * PDF content draws right-to-left words in visual order: their glyphs run left to right across
 * the page, the last letter first. Editing shows and takes text in reading order, so a line is
 * reordered with the Unicode bidirectional algorithm (without explicit embeddings) both ways.
 */

const RIGHT_TO_LEFT =
  /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}]/u;

function type(char) {
  if (/\p{M}/u.test(char)) return 'NSM';
  if (/[0-9\u06f0-\u06f9]/.test(char)) return 'EN';
  if (/[\u0660-\u0669\u066b\u066c]/.test(char)) return 'AN';
  if (/[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}]/u.test(char)) return 'AL';
  if (RIGHT_TO_LEFT.test(char)) return 'R';
  if (/[+\-\u2212]/.test(char)) return 'ES';
  if (/[#$%\u00a2-\u00a5\u00b0\u2030\u20a0-\u20cf]/.test(char)) return 'ET';
  if (/[,.:/\u00a0\u060c]/.test(char)) return 'CS';
  if (/[\p{L}\p{N}]/u.test(char)) return 'L';
  return 'ON';
}

/** The direction a line is laid out in, or null when it has no right-to-left letters at all. */
export function textDirection(text) {
  let rtl = 0,
    ltr = 0;
  for (const char of text) {
    const t = type(char);
    if (t === 'R' || t === 'AL') rtl++;
    else if (t === 'L') ltr++;
  }
  return rtl ? (rtl >= ltr ? 'rtl' : 'ltr') : null;
}

/** The order to read the characters (code points) of one line in, by the algorithm's levels. */
function lineOrder(chars, rtl) {
  // Combining marks stay with the letter they follow, as one unit.
  const units = [];
  for (const [i, char] of chars.entries()) {
    if (units.length && type(char) === 'NSM') units.at(-1).indices.push(i);
    else units.push({ indices: [i], type: type(char) });
  }
  const types = units.map((unit) => unit.type);
  const edge = rtl ? 'R' : 'L';
  const n = types.length;
  for (let i = 0; i < n; i++) if (types[i] === 'NSM') types[i] = i ? types[i - 1] : edge; // W1
  let strong = edge;
  for (let i = 0; i < n; i++) {
    if (['L', 'R', 'AL'].includes(types[i])) strong = types[i];
    else if (types[i] === 'EN' && strong === 'AL') types[i] = 'AN'; // W2
  }
  for (let i = 0; i < n; i++) if (types[i] === 'AL') types[i] = 'R'; // W3
  for (let i = 1; i < n - 1; i++) {
    // W4: one separator between two numbers of a kind joins them.
    const [before, after] = [types[i - 1], types[i + 1]];
    if (types[i] === 'ES' && before === 'EN' && after === 'EN') types[i] = 'EN';
    else if (types[i] === 'CS' && before === after && (before === 'EN' || before === 'AN'))
      types[i] = before;
  }
  for (let i = 0; i < n; i++) {
    // W5: currency and percent signs beside European digits belong to the number.
    if (types[i] !== 'ET') continue;
    let end = i;
    while (end < n && types[end] === 'ET') end++;
    const number = types[i - 1] === 'EN' || types[end] === 'EN';
    for (let k = i; k < end; k++) types[k] = number ? 'EN' : 'ON';
    i = end - 1;
  }
  for (let i = 0; i < n; i++) if (['ES', 'CS', 'ET'].includes(types[i])) types[i] = 'ON'; // W6
  strong = edge;
  for (let i = 0; i < n; i++) {
    if (types[i] === 'L' || types[i] === 'R') strong = types[i];
    else if (types[i] === 'EN' && strong === 'L') types[i] = 'L'; // W7
  }
  // N1/N2: neutrals between two of one direction take it (numbers count as right-to-left);
  // any others take the line's own direction.
  const direction = (t) => (t === 'L' ? 'L' : 'R');
  for (let i = 0; i < n; i++) {
    if (types[i] !== 'ON') continue;
    let end = i;
    while (end < n && types[end] === 'ON') end++;
    const before = i ? direction(types[i - 1]) : edge,
      after = end < n ? direction(types[end]) : edge;
    for (let k = i; k < end; k++) types[k] = before === after ? before : edge;
    i = end - 1;
  }
  // I1/I2 and L2: resolve levels, then reverse each run at or above every odd level.
  const levels = types.map((t) => (rtl ? (t === 'R' ? 1 : 2) : t === 'L' ? 0 : t === 'R' ? 1 : 2));
  const order = units.map((_, i) => i);
  for (let level = Math.max(0, ...levels); level >= 1; level--)
    for (let i = 0; i < n; i++) {
      if (levels[order[i]] < level) continue;
      let end = i;
      while (end < n && levels[order[end]] >= level) end++;
      order.splice(i, end - i, ...order.slice(i, end).reverse());
      i = end - 1;
    }
  return order.flatMap((u) => units[u].indices);
}

/**
 * Reorder `segments` ({ text, part, gap? } fragments) between visual and reading order, line by
 * line. Each character keeps the fragment it came from; neighbouring characters of the same
 * fragment kind join again, as an editing surface reports them.
 */
export function reorderSegments(segments, direction) {
  const chars = segments.flatMap((segment) => Array.from(segment.text, (char) => [char, segment]));
  const ordered = [];
  for (let start = 0; start <= chars.length;) {
    let end = start;
    while (end < chars.length && chars[end][0] !== '\n') end++;
    const line = chars.slice(start, end);
    for (const i of lineOrder(
      line.map(([char]) => char),
      direction === 'rtl',
    ))
      ordered.push(line[i]);
    if (end < chars.length) ordered.push(chars[end]);
    start = end + 1;
  }
  const output = [];
  for (const [char, { part, gap }] of ordered) {
    const last = output.at(-1);
    if (last && last.part === part && !last.gap && !gap) last.text += char;
    else output.push({ text: char, part, ...(gap ? { gap } : {}) });
  }
  return output;
}

export const reorderText = (text, direction) =>
  reorderSegments([{ text, part: 0 }], direction)
    .map((segment) => segment.text)
    .join('');

export const hasRightToLeft = (text) => RIGHT_TO_LEFT.test(text);

/**
 * A run's text and fragments in reading order, with the direction to edit them in; null when
 * it has no right-to-left letters, or when reordering back would not restore what is drawn.
 */
export function readingOrder(text, segments = [{ text, part: 0 }]) {
  const direction = hasRightToLeft(text) && textDirection(text);
  if (!direction) return null;
  const shown = reorderSegments(segments, direction);
  if (JSON.stringify(reorderSegments(shown, direction)) !== JSON.stringify(segments)) return null;
  return { direction, text: shown.map((segment) => segment.text).join(''), segments: shown };
}
