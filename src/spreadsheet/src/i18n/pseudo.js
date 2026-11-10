/**
 * Pseudo-localization (?lang=en-XA): every catalog message is shown accented, about a third longer,
 * and between ⟦ ⟧, while its arguments, plurals and tags keep working. Text on screen that is still
 * plain English did not come from a catalog; text cut off or overlapping will be in a longer
 * language too; a ⟦ without its ⟧ was truncated.
 */
import { IntlMessageFormat } from 'intl-messageformat';

const ACCENTED = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'í', j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ɱ',
  n: 'ñ', o: 'ö', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ', u: 'ú', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'Á', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Í', J: 'Ĵ', K: 'Ķ', L: 'Ļ', M: 'Ṁ',
  N: 'Ñ', O: 'Ö', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Ú', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
};

const accent = (s) => s.replace(/[a-zA-Z]/g, (c) => ACCENTED[c]);

// The parser's element types (intl-messageformat's TYPE) that hold text: literal, select, plural, tag.
const LITERAL = 0, SELECT = 5, PLURAL = 6, TAG = 8;

function literalSpans(elements, out = []) {
  for (const e of elements) {
    if (e.type === LITERAL) out.push(e.location);
    else if (e.type === SELECT || e.type === PLURAL) for (const o of Object.values(e.options)) literalSpans(o.value, out);
    else if (e.type === TAG) literalSpans(e.children, out);
  }
  return out;
}

/**
 * `message` pseudo-localized, still valid ICU MessageFormat (or as given, when it does not parse).
 * Only the letters of its literal text change, each for one accented letter, so the arguments,
 * plural keywords and tag names around them stay where they are.
 */
export function pseudoLocalize(message) {
  let ast;
  for (const ignoreTag of [false, true]) {
    try { ast = IntlMessageFormat.__parse(message, { ignoreTag, captureLocation: true }); break; } catch { /* try without tags */ }
  }
  if (!ast) return message;
  const chars = message.split('');
  for (const { start, end } of literalSpans(ast)) {
    for (let i = start.offset; i < end.offset; i++) chars[i] = accent(chars[i]);
  }
  const pad = '·'.repeat(Math.ceil(message.length * 0.3));
  return `⟦${chars.join('')}${pad ? ` ${pad}` : ''}⟧`;
}
