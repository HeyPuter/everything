import { bidiCharacterType, bidiEmbeddingLevels, bidiClosingBracket, bidiOpeningBracket } from './bidi-text.js';

// Native reference input classification is distinct from Unicode bidi ordering.
// These LTR scripts receive w:cs when typing in an active script context.
const complex = /[\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Thai}\p{Script=Lao}\p{Script=Tibetan}\p{Script=Myanmar}\p{Script=Khmer}\p{Script=Mongolian}]/u;
// Phoenician uses ordinary input formatting, including with a font
// that contains its glyphs. Do not change its Unicode R class during layout.
const ordinaryScript = /\p{Script=Phoenician}/u;
const representatives = { L:'A', R:'א', AL:'ا', EN:'0', AN:'٠', NSM:'\u0300', ON:'\ufffc', BN:'\u00ad', WS:' ', ES:'+', ET:'$', CS:',', B:'\u2029', S:'\t' };
const strongType = type => type === 'L' || type === 'R' || type === 'AL';

function neutralBracketItems(chars, types) {
  const prefix = [0], stack = [], delta = new Int32Array(chars.length + 1);
  for (let i = 0; i < chars.length; i++) {
    prefix.push(prefix[i] + (strongType(types[i]) ? 1 : 0));
    const close = bidiClosingBracket(chars[i]);
    if (close) {
      // Use the UAX #9 bracket-stack bound, including for pathological input.
      if (stack.length < 63) stack.push({ index:i, close });
    } else if (bidiOpeningBracket(chars[i])) {
      const at = stack.findLastIndex(item => item.close === chars[i]);
      if (at >= 0) {
        const start = stack[at].index; stack.length = at;
        // A bracketed number/neutral sequence is itemized as one neutral
        // item; surrounding strong text or the input context gives its script.
        if (prefix[i + 1] === prefix[start]) { delta[start]++; delta[i + 1]--; }
      }
    }
  }
  let depth = 0;
  return chars.map((_, i) => { depth += delta[i]; return depth > 0; });
}

// Forced cs on ordinary Latin is not a complex-script input context. Find
// the preceding strong script, retaining context across neutral characters.
function precedingComplexScript(text) {
  for (let i = text.length; i > 0;) {
    const end = i--;
    if (i > 0 && /[\uDC00-\uDFFF]/.test(text[i]) && /[\uD800-\uDBFF]/.test(text[i - 1])) i--;
    const c = text.slice(i, end);
    const type = bidiCharacterType(c);
    if (strongType(type)) return complex.test(c) || c === '\u200e';
    if (type === 'B') return false;
  }
  return false;
}

export function typedScriptRuns(text, format, precedingText = '') {
  // Ordinary text and inserted objects keep their existing path and metadata.
  if (!text || !(format.cs || format.rtl) || format.image || format.vml || format.noteMark || format.bodySymbol) return [{ ...format, text }];
  const chars = [...text], types = chars.map(c => ordinaryScript.test(c) ? 'L' : bidiCharacterType(c));
  // The preceding complex script carries into leading neutral input,
  // but a following ordinary LTR character in this batch takes those neutrals.
  const firstStrong = types.findIndex(strongType);
  const continuesComplex = !!format.cs && precedingComplexScript(precedingText)
    && !(firstStrong >= 0 && types[firstStrong] === 'L' && !complex.test(chars[firstStrong]) && chars[firstStrong] !== '\u200e');
  const neutral = neutralBracketItems(chars, types);
  // One proxy code unit per code point; actual text and UTF-16 offsets are kept.
  const proxy = chars.map((c,i) => neutral[i] ? '\ufffc' : c.length === 1 ? c : representatives[types[i]] || 'A').join('');
  const levels = bidiEmbeddingLevels(proxy, format.rtl ? 'rtl' : 'ltr');
  const runs = []; let strong = format.rtl ? 'R' : 'L', lastCs = false;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i], type = types[i]; let cs = false, rtl = false;
    if (continuesComplex && (firstStrong < 0 || i < firstStrong) && type !== 'AN') { cs = true; }
    else if (neutral[i] && (!lastCs || format.rtl)) { rtl = !!(levels[i] % 2); strong = rtl ? 'R' : 'L'; lastCs = false; }
    else if (type === 'L') { cs = complex.test(c) || c === '\u200e'; strong = 'L'; lastCs = cs; }
    // In cs input, retain the LTR script for a closing bracket after RTL text.
    // Batch digits end that context; sequential leading digits use it above.
    else if (type === 'R' || type === 'AL') { rtl = true; strong = 'R'; if (format.rtl) lastCs = false; }
    else if (type === 'EN' || type === 'AN') { rtl = type === 'AN' || strong === 'R'; if (!format.rtl) lastCs = false; }
    else if (type === 'BN') rtl = i > 0 && strong === 'R';
    else { rtl = !!(levels[i] % 2); cs = !rtl && lastCs; }
    const previous = runs.at(-1);
    if (previous && previous.cs === cs && previous.rtl === rtl) previous.text += c;
    else runs.push({ ...format, text:c, cs, rtl, overrides:{ ...format.overrides, cs, rtl } });
  }
  return runs;
}

const BREAKS = /[\t\v\f\u000e\n]/;
const plainText = run => !(run.image || run.vml || run.noteMark || run.bodySymbol || run.positionalTab || run.math);

/**
 * Run direction for text edited in a right-to-left paragraph (§17.3.1.6 bidi, §17.3.2.30 rtl).
 *
 * In such a paragraph a run without w:rtl is a left-to-right island (bidi-text.js): Hebrew or Arabic
 * typed into one would read correctly, but the period ending its sentence would stay on the right and
 * a space typed before it on the wrong side of the preceding Latin word. The reference application
 * marks typed text by keyboard language, which a web page cannot see. Here the text decides, so that
 * the paragraph reads as plain Unicode ordering (UAX #9) with a right-to-left base shows it:
 *
 * - a left-to-right phrase (Latin letters with the spaces, punctuation and numbers UAX #9 resolves
 *   with them, such as "abc def, 12") is left without w:rtl;
 * - everything else is w:rtl: right-to-left letters, the spaces and punctuation that read with them
 *   or with the paragraph, and numbers that do not follow a Latin letter.
 *
 * Only the text in [from, to) (the inserted text; an empty range is a deletion point) and the digits,
 * spaces and punctuation directly beside it are decided: they are what an edit can change the reading
 * of. Letters outside the range, tabs, breaks and inline objects keep the direction they have. A
 * changed run states cs and rtl together, as typedScriptRuns does, so it joins the text typed beside
 * it, and keeps its visible size, weight and slant (shownFormat). Returns `runs` itself when nothing
 * changes.
 */
// A right-to-left run is drawn with its complex-script size, weight and slant (§17.3.2.39 szCs, §17.3.2.2
// bCs, §17.3.2.17 iCs), which a document written left to right often leaves at their defaults. Text that
// becomes right-to-left keeps the look it was typed with: those three take the values it was shown in.
function shownFormat(run) {
  const look = {};
  if (run.fontSize !== undefined && run.fontSizeCs !== run.fontSize) look.fontSizeCs = run.fontSize;
  if (!!run.boldCs !== !!run.bold) look.boldCs = !!run.bold;
  if (!!run.italicCs !== !!run.italic) look.italicCs = !!run.italic;
  return look;
}

export function directedRuns(runs, from, to) {
  const text = runs.map(r => r.text).join('');
  if (!text) return runs;
  const points = [];
  for (let i = 0; i < text.length;) {
    const c = String.fromCodePoint(text.codePointAt(i));
    points.push({ start: i, text: c, type: ordinaryScript.test(c) ? 'L' : bidiCharacterType(c) });
    i += c.length;
  }
  const fixed = p => strongType(p.type) || BREAKS.test(p.text);
  const insertedFrom = points.findIndex(p => p.start >= from), first = insertedFrom < 0 ? points.length : insertedFrom;
  let last = first; while (last < points.length && points[last].start < to) last++;
  let lo = first, hi = last;
  while (lo > 0 && !fixed(points[lo - 1])) lo--;
  while (hi < points.length && !fixed(points[hi])) hi++;
  if (lo === hi) return runs;
  const levels = bidiEmbeddingLevels(points.map(p => p.text.length === 1 ? p.text : representatives[p.type] || 'A').join(''), 'rtl');
  // An even level is a left-to-right phrase when a Latin letter is in it, and otherwise a number
  // standing in right-to-left text, which stays with that text.
  const phrase = new Map();
  const leftToRight = i => {
    let a = i; while (a > 0 && levels[a - 1] % 2 === 0) a--;
    if (!phrase.has(a)) { let found = false; for (let b = a; b < points.length && levels[b] % 2 === 0; b++) if (points[b].type === 'L') { found = true; break; } phrase.set(a, found); }
    return phrase.get(a);
  };
  const wanted = new Map();
  for (let i = lo; i < hi; i++) if (!BREAKS.test(points[i].text)) wanted.set(points[i].start, levels[i] % 2 === 1 || !leftToRight(i));
  let changed = false, offset = 0;
  const result = [];
  for (const run of runs) {
    const start = offset; offset += run.text.length;
    if (!run.text || !plainText(run)) { result.push(run); continue; }
    let piece = null, pieceRtl;
    for (let i = 0; i < run.text.length;) {
      const c = String.fromCodePoint(run.text.codePointAt(i)), rtl = wanted.get(start + i) ?? !!run.rtl;
      if (piece && pieceRtl === rtl) piece.text += c;
      else {
        const look = rtl && !run.rtl && !run.cs ? shownFormat(run) : null;
        result.push(piece = rtl === !!run.rtl ? { ...run, text: c } : { ...run, ...look, text: c, rtl, overrides: { ...run.overrides, ...look, cs: !!run.cs, rtl } }); pieceRtl = rtl;
      }
      if (rtl !== !!run.rtl) changed = true;
      i += c.length;
    }
  }
  return changed ? result : runs;
}
