import bidiFactory from 'bidi-js';
import { rtlFontCharacters } from './rtl-font-context.js';

const bidi = bidiFactory();
export const bidiCharacterType = text => bidi.getBidiCharTypeName(text);
export const bidiEmbeddingLevels = (text, direction) => bidi.getEmbeddingLevels(text, direction).levels;
export const bidiClosingBracket = text => bidi.openingToClosingBracket(text);
export const bidiOpeningBracket = text => bidi.closingToOpeningBracket(text);
// The package resolves UTF-16 units. Give each supplementary code point one
// BMP representative of its bidi class, then map levels back to graphemes.
// Actual text and UTF-16 document offsets never pass through this proxy.
const representatives = { L:'A', R:'א', AL:'ا', EN:'0', AN:'٠', NSM:'\u0300', ON:'\ufffc', BN:'\u00ad', WS:' ', ES:'+', ET:'$', CS:',', B:'\u2029', S:'\t' };
const formatting = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const trailingTypes = new Set(['WS','S','B','BN','LRE','RLE','LRO','RLO','PDF','LRI','RLI','FSI','PDI']);
const trailing = text => [...text].every(c=>trailingTypes.has(bidi.getBidiCharTypeName(c)));
// w:rtl supplies a higher-level R classification for neutral spaces (Part 1
// 17.3.2.30). Such a space is part of the reversed text, not an L1 line tail.
// In a right-to-left paragraph (style.bidiBase) every line-end space is at the paragraph level and hangs
// past the trailing (left) edge, as a trailing space does in a left-to-right paragraph.
export const bidiRtlSpace = c => c.text === ' ' && c.style.rtl && !c.style.bidiBase && c.style.bidiLevel % 2 === 1;

/**
 * Resolve embedding levels (UAX #9). `rtl` is the paragraph's base direction (§17.3.1.6 bidi).
 *
 * w:rtl gives a run's characters a direction of their own (§17.3.2.30): in a left-to-right paragraph
 * consecutive rtl runs form one right-to-left embedding. A right-to-left paragraph is the mirror case,
 * as the reference application lays it out: consecutive runs without w:rtl form one left-to-right
 * embedding, so "Hello world." in such a run keeps its period on the right, while rtl runs are resolved
 * at the paragraph's own right-to-left level. A tab ends an embedding and starts the next.
 */
export function bidiCharacters(chars, rtl = false) {
  if (!chars.length) return chars;
  chars=rtlFontCharacters(chars,text=>bidi.getBidiCharTypeName(text));
  const open = rtl ? '\u202a' : '\u202b';
  let proxy = '', embedded = false;
  const indices = [];
  for (const c of chars) {
    const next = !!c.style.rtl !== rtl;
    if (next !== embedded) { proxy += next ? open : '\u202c'; embedded = next; }
    indices.push(proxy.length);
    if(c.bidiType) proxy+=representatives[c.bidiType];
    else for (const codePoint of c.text) proxy += codePoint.length === 1 ? codePoint : representatives[bidi.getBidiCharTypeName(codePoint)] || 'A';
    if(embedded && c.text==='\t') proxy+='\u202c'+open;
  }
  if (embedded) proxy += '\u202c';
  const {levels} = bidi.getEmbeddingLevels(proxy, rtl ? 'rtl' : 'ltr');
  return chars.map((c,i) => ({...c, style:{...c.style,bidiLevel:levels[indices[i]],bidiDirection:levels[indices[i]]%2 ? 'rtl' : 'ltr',...(rtl ? {bidiBase:1} : {})}}));
}

// UAX #9 L1 applies after line breaking, including whitespace before tabs.
// Keep the character formatting even when its directional level resets.
export function bidiLineCharacters(chars) {
  if (!chars.some(c => c.style.bidiLevel !== undefined)) return chars;
  const result = chars.slice();
  // The paragraph level: 1 in a right-to-left paragraph, whose line tail is at the left.
  const reset = c => { const level = c.style.bidiBase ? 1 : 0; return {...c,style:{...c.style,bidiLevel:level,bidiDirection:level ? 'rtl' : 'ltr'}}; };
  for (let end = 0; end <= chars.length; end++) if (end === chars.length || chars[end].text === '\t') {
    if (end < chars.length) result[end] = reset(chars[end]);
    for (let i=end-1;i>=0 && trailing(chars[i].text);i--) {
      if(end===chars.length && bidiRtlSpace(chars[i])) break;
      result[i] = reset(chars[i]);
    }
  }
  return result;
}

// UAX #9 L2: reverse contiguous ranges at each level, deepest first. Items
// may be graphemes or already-shaped fragments; neither is split here.
export function bidiVisualOrder(items, level = item => item.bidiLevel) {
  const result = items.slice(), levels = result.map(level);
  const odd = levels.filter(n => n%2);
  if (!odd.length) return result;
  for (let threshold=Math.max(...levels);threshold>=Math.min(...odd);threshold--) {
    let start=0;
    while (start<result.length) {
      if (level(result[start])<threshold) {start++;continue;}
      let end=start+1;
      while(end<result.length && level(result[end])>=threshold) end++;
      for(let a=start,b=end-1;a<b;a++,b--) [result[a],result[b]]=[result[b],result[a]];
      start=end;
    }
  }
  return result;
}

export function bidiPaintText(text, style) {
  if (!style.bidiDirection || !text) return text;
  // Ordering has already resolved each fragment's direction. Override native
  // reclassification so neutral-only fragments and explicit Unicode overrides
  // retain that resolution. The native shaper still joins/ligates actual text.
  return (style.bidiDirection==='rtl' ? '\u202e' : '\u202d') + text.replace(formatting,'') + '\u202c';
}

export const bidiMirroredCharacter = text => bidi.getMirroredCharacter(text) || text;
