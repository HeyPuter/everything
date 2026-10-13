// Fractional order keys for layers in a shared document: a layer's place
// among its siblings is a string that sorts between its neighbors, so moving
// or inserting a layer writes one key and concurrent moves of different layers
// merge. Equal keys (two people inserting at the same place) are ordered by
// layer ID, which every participant does the same way.

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const digit = (c: string | undefined) => (c === undefined ? 0 : DIGITS.indexOf(c));

// Fractions in (0, 1) written as base-62 digits without trailing zeros.
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = digit(a[0]),
    db = b !== null ? digit(b[0]) : DIGITS.length;
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)];
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[da] + midpoint(a.slice(1), null);
}
const valid = (k: string) => /^[0-9A-Za-z]*[1-9A-Za-z]$/.test(k);

/** A key strictly between `a` and `b` (either may be absent). */
export function keyBetween(a: string | null | undefined, b: string | null | undefined): string {
  const lo = a && valid(a) ? a : '';
  const hi = b && valid(b) && (!lo || b > lo) ? b : null;
  return midpoint(lo, hi);
}

/** Keys for `ids` in this order, keeping the existing keys of as many as
 * already sort correctly (the longest increasing run) and giving the others
 * new keys between their neighbors. Returns only the keys to write. */
export function orderKeys(ids: string[], current: (id: string) => string | undefined): Map<string, string> {
  const keys = ids.map((id) => current(id));
  // Longest strictly increasing subsequence of existing keys (n log n).
  const tails: number[] = [],
    prev = new Array<number>(ids.length).fill(-1);
  keys.forEach((k, i) => {
    if (!k || !valid(k)) return;
    let lo = 0,
      hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (keys[tails[mid]]! < k) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  });
  const keep = new Set<number>();
  for (let i = tails.at(-1) ?? -1; i >= 0; i = prev[i]) keep.add(i);
  const out = new Map<string, string>();
  const final = keys.slice();
  for (let i = 0; i < ids.length; i++) {
    if (keep.has(i)) continue;
    // The next kept key after i bounds this one from above.
    let next: string | undefined;
    for (let j = i + 1; j < ids.length; j++)
      if (keep.has(j)) {
        next = final[j];
        break;
      }
    const key = keyBetween(i > 0 ? final[i - 1] : null, next ?? null);
    final[i] = key;
    out.set(ids[i], key);
  }
  return out;
}
