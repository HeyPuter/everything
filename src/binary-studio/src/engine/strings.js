/**
 * Extract printable ASCII / UTF-16LE strings from a binary blob.
 */
export function findStrings(bytes, { minLength = 4, maxResults = 5000 } = {}) {
  const out = [];
  // ASCII runs
  let start = -1;
  for (let i = 0; i <= bytes.length; i += 1) {
    const c = i < bytes.length ? bytes[i] : 0;
    const ok = c >= 0x20 && c <= 0x7e;
    if (ok) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      const len = i - start;
      if (len >= minLength) {
        out.push({
          offset: start,
          length: len,
          encoding: 'ascii',
          value: String.fromCharCode(...bytes.subarray(start, i)),
        });
        if (out.length >= maxResults) return out;
      }
      start = -1;
    }
  }

  // UTF-16LE (simple)
  start = -1;
  for (let i = 0; i + 1 <= bytes.length; i += 2) {
    const lo = bytes[i];
    const hi = bytes[i + 1];
    const ok = hi === 0 && lo >= 0x20 && lo <= 0x7e;
    if (ok) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      const len = i - start;
      const chars = len / 2;
      if (chars >= minLength) {
        let value = '';
        for (let j = start; j < i; j += 2) value += String.fromCharCode(bytes[j]);
        out.push({ offset: start, length: len, encoding: 'utf16le', value });
        if (out.length >= maxResults) return out;
      }
      start = -1;
    }
  }
  return out;
}

export function findBytePattern(bytes, pattern) {
  if (!pattern.length || pattern.length > bytes.length) return [];
  const hits = [];
  outer: for (let i = 0; i <= bytes.length - pattern.length; i += 1) {
    for (let j = 0; j < pattern.length; j += 1) {
      if (bytes[i + j] !== pattern[j]) continue outer;
    }
    hits.push(i);
    if (hits.length >= 1000) break;
  }
  return hits;
}
