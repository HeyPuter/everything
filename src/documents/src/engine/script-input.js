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
