// Find and Replace Text: matching in plain text and style-preserving
// replacement in text content (each replacement takes the style of the
// first character it replaces).
import { plainText, replaceRange, type TextContent } from './model';

export type FindOptions = { caseSensitive?: boolean; wholeWord?: boolean };
const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}_'’]/u.test(c);

/** All non-overlapping matches of `query` in `text`, as [start, end) ranges. */
export function findMatches(text: string, query: string, opts: FindOptions = {}): [number, number][] {
  if (!query) return [];
  const hay = opts.caseSensitive ? text : text.toLocaleLowerCase();
  const needle = opts.caseSensitive ? query : query.toLocaleLowerCase();
  // Lowercasing can change lengths (rare); fall back to exact search then.
  const fold = hay.length === text.length && needle.length === query.length;
  const h = fold ? hay : text,
    n = fold ? needle : query;
  const out: [number, number][] = [];
  for (let i = h.indexOf(n); i >= 0; ) {
    const end = i + n.length;
    // A rejected candidate may overlap a whole-word match just after it.
    if (opts.wholeWord && (isWordChar(text[i - 1]) || isWordChar(text[end]))) {
      i = h.indexOf(n, i + 1);
      continue;
    }
    out.push([i, end]);
    i = h.indexOf(n, i + Math.max(1, n.length));
  }
  return out;
}
/** Next match at or after `from` (wrapping to the start), or undefined. */
export function nextMatch(text: string, query: string, from: number, opts: FindOptions = {}, wrap = true): [number, number] | undefined {
  const all = findMatches(text, query, opts);
  return all.find(([a]) => a >= from) ?? (wrap ? all[0] : undefined);
}
/** Replace every match; returns the new content and the count. */
export function replaceAll(content: TextContent, query: string, replacement: string, opts: FindOptions = {}): { content: TextContent; count: number } {
  const matches = findMatches(plainText(content), query, opts);
  let out = content;
  // From the end, so earlier offsets stay valid.
  for (let k = matches.length - 1; k >= 0; k--) out = replaceRange(out, matches[k][0], matches[k][1], replacement);
  return { content: out, count: matches.length };
}
