/**
 * Basic CJK typesetting rules: line-break prohibitions (kinsoku), the
 * spacing of full-width punctuation (mojikumi) and punctuation that may
 * hang past the margin (burasagari).
 *
 * Kinsoku sets: characters that may not start a line (closing brackets,
 * commas and stops, iteration marks; the hard set also small kana and the
 * prolonged sound mark), characters that may not end a line (opening
 * brackets) and characters that may not be split when doubled (dashes,
 * leaders).
 */

const CLOSE = ')]}）］｝〕〉》」』】〙〗〟’”｠»';
const OPEN = '([{（［｛〔〈《「『【〘〖〝‘“｟«';
const STOPS = '、。，．,.';
const MIDDLE = '・：；:;';
const MARKS = '?!？！‼⁇⁈⁉';
const ITERATION = 'ヽヾゝゞ々〻';
const SMALL_KANA = 'ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ';
const PROLONGED = 'ー‐゠–〜～';
const INSEPARABLE = '—―…‥〳〴〵';

export const KINSOKU = {
  soft: { noStart: new Set(CLOSE + STOPS + MIDDLE + MARKS + ITERATION), noEnd: new Set(OPEN) },
  hard: { noStart: new Set(CLOSE + STOPS + MIDDLE + MARKS + ITERATION + SMALL_KANA + PROLONGED), noEnd: new Set(OPEN) },
};

/** Whether kinsoku `mode` lets a line break between characters a and b. */
export function kinsokuAllows(mode, a, b) {
  const k = KINSOKU[mode];
  if (!k) return true;
  if (b && k.noStart.has(b)) return false;
  if (a && k.noEnd.has(a)) return false;
  if (a && a === b && INSEPARABLE.includes(a)) return false;
  return true;
}

/** Punctuation that may hang past the right margin (burasagari). */
export function hangsOut(c) {
  return Boolean(c) && STOPS.includes(c);
}

export function isCJKChar(c) {
  if (!c) return false;
  const n = c.charCodeAt(0);
  return (n >= 0x2e80 && n <= 0x2fdf) || (n >= 0x3000 && n <= 0x30ff) || (n >= 0x3100 && n <= 0x31ff) || (n >= 0x3400 && n <= 0x4dbf) || (n >= 0x4e00 && n <= 0x9fff) || (n >= 0xac00 && n <= 0xd7af) || (n >= 0xf900 && n <= 0xfaff) || (n >= 0xfe30 && n <= 0xfe4f) || (n >= 0xff00 && n <= 0xffef);
}

/** Full-width punctuation classes for mojikumi: 'open' | 'close' | 'stop' | 'middle' | null. */
export function punctClass(c) {
  if (!c || !isCJKChar(c)) return null;
  if (OPEN.includes(c)) return 'open';
  if (CLOSE.includes(c)) return 'close';
  if (STOPS.includes(c)) return 'stop';
  if (MIDDLE.includes(c)) return 'middle';
  return null;
}

/** A Roman letter or digit (text that gets a quarter em from CJK text in the basic spacing set). */
export function isRoman(c) {
  return Boolean(c) && /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}0-9]/u.test(c) && !isCJKChar(c);
}

/**
 * Basic mojikumi over [start, end): full-width closing punctuation, commas
 * and stops followed by more punctuation give up the empty half of their em;
 * an opening bracket after punctuation gives up its empty half too; CJK and
 * Roman text get a quarter em between them. `adv`, `kern` and `size` are the
 * layout's per-character arrays (kern: space before a character). Returns
 * true when anything changed.
 */
export function applyMojikumi(text, start, end, adv, kern, size) {
  let changed = false;
  for (let i = start; i < end; i++) {
    const c = text[i];
    const n = i + 1 < end ? text[i + 1] : '';
    const pc = punctClass(c);
    const pn = punctClass(n);
    const em = size[i] || 0;
    if ((pc === 'close' || pc === 'stop') && pn && adv[i] > em * 0.6) {
      adv[i] -= em / 2;
      changed = true;
    }
    if (pn === 'open' && pc && i + 1 < end) {
      kern[i + 1] -= (size[i + 1] || em) / 2;
      changed = true;
    }
    if (i + 1 < end && ((isCJKChar(c) && !pc && isRoman(n)) || (isRoman(c) && isCJKChar(n) && !pn))) {
      kern[i + 1] += (size[i + 1] || em) / 4;
      changed = true;
    }
  }
  return changed;
}
