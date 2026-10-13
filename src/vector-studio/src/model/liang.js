/**
 * Pattern hyphenation (F. M. Liang's method, as TeX uses it).
 *
 * A pattern is a letter string with digits between the letters, like
 * "hy3ph" or ".ex5am"; "." marks a word boundary. To hyphenate a word, every
 * pattern that occurs in ".word." puts its digits at the gaps it covers,
 * each gap keeps the highest digit any pattern gave it, and odd digits allow
 * a break there. Exception words list their breaks outright ("as-so-ciate").
 *
 * Pattern files are TeX sources: the patterns are the contents of
 * \patterns{...} and the exceptions of \hyphenation{...}; "%" starts a
 * comment.
 */

/** The braced body after a TeX command (`\patterns`), or ''. Comments are already gone. */
function block(src, cmd) {
  const at = src.indexOf(`\\${cmd}`);
  if (at < 0) return '';
  const open = src.indexOf('{', at);
  if (open < 0) return '';
  const close = src.indexOf('}', open);
  return src.slice(open + 1, close < 0 ? src.length : close);
}

/** Break offsets of an exception entry ("as-so-ciate" -> { word: 'associate', points: [2, 4] }). */
export function parseException(entry) {
  const parts = String(entry).trim().toLowerCase().split(/[-­‐]/);
  const points = [];
  let word = '';
  for (let i = 0; i < parts.length; i++) {
    word += parts[i];
    if (i < parts.length - 1 && parts[i] && parts[i + 1]) points.push(word.length);
  }
  return { word, points };
}

/**
 * Compile a TeX pattern file into a hyphenator: (lowercase word) -> sorted
 * break offsets k (a break between word[k-1] and word[k]).
 */
export function compilePatterns(src) {
  const text = String(src).replace(/%[^\n\r]*/g, '');
  const patterns = new Map();
  let maxLen = 0;
  for (const tok of block(text, 'patterns').split(/\s+/)) {
    if (!tok) continue;
    const chars = [...tok];
    let letters = '';
    const digits = [0];
    for (const c of chars) {
      if (c >= '0' && c <= '9') digits[digits.length - 1] = c.charCodeAt(0) - 48;
      else {
        letters += c;
        digits.push(0);
      }
    }
    if (!letters) continue;
    patterns.set(letters.toLowerCase(), digits);
    if (letters.length > maxLen) maxLen = letters.length;
  }
  const exceptions = new Map();
  for (const tok of block(text, 'hyphenation').split(/\s+/)) {
    if (!tok) continue;
    const { word, points } = parseException(tok);
    if (word) exceptions.set(word, points);
  }
  const cache = new Map();
  const hyphenate = (word) => {
    const w = String(word).toLowerCase();
    let hit = cache.get(w);
    if (hit) return hit;
    const ex = exceptions.get(w);
    if (ex) return ex;
    const s = `.${w}.`;
    const n = s.length;
    const score = new Uint8Array(n + 1);
    for (let i = 0; i < n; i++) {
      const top = Math.min(n, i + maxLen);
      for (let j = i + 1; j <= top; j++) {
        const p = patterns.get(s.slice(i, j));
        if (!p) continue;
        for (let k = 0; k < p.length; k++) if (p[k] > score[i + k]) score[i + k] = p[k];
      }
    }
    // Gap before s[i] is the gap before w[i - 1].
    hit = [];
    for (let k = 1; k < w.length; k++) if (score[k + 1] % 2 === 1) hit.push(k);
    if (cache.size > 5000) cache.clear();
    cache.set(w, hit);
    return hit;
  };
  hyphenate.size = patterns.size;
  hyphenate.exceptions = exceptions;
  return hyphenate;
}
