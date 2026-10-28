/**
 * A shortest edit script between two strings (the O(ND) greedy algorithm with a
 * bounded number of differences). The co-editing layer uses it to turn the
 * paragraphs a local edit changed into character insertions and deletions, so
 * a concurrent edit by someone else elsewhere in those paragraphs survives.
 *
 * Returns segments in order: { type: 'equal' | 'insert' | 'delete', length }
 * where insert lengths count UTF-16 code units of `b` and the others those of
 * `a`; no segment boundary falls inside a surrogate pair.
 * When the strings differ in more than `limit` places the middle is replaced
 * wholesale (one delete and one insert), which is still correct, only coarser.
 */
export function diffText(a, b, { limit = 2000, symbolsA = null, symbolsB = null } = {}) {
  // The script works on code points: a boundary between the halves of a
  // surrogate pair would make the shared text replace both with U+FFFD.
  // `symbolsA`/`symbolsB` (per UTF-16 index: a number above U+10FFFF, or 0 for none) tell apart characters that read
  // alike but are not the same: such a character matches only one with the same symbol.
  const [pointsA, wideA] = codePoints(a, symbolsA), [pointsB, wideB] = codePoints(b, symbolsB);
  let start = 0;
  const shortest = Math.min(pointsA.length, pointsB.length);
  while (start < shortest && pointsA[start] === pointsB[start]) start++;
  let endA = pointsA.length, endB = pointsB.length;
  while (endA > start && endB > start && pointsA[endA - 1] === pointsB[endB - 1]) { endA--; endB--; }
  const out = [];
  let atA = 0, atB = 0;
  // Segment lengths count UTF-16 code units, as callers index the strings.
  const units = (wide, from, count) => { let n = 0; for (let i = from; i < from + count; i++) n += wide[i] ? 2 : 1; return n; };
  const push = (type, count) => {
    if (!count) return;
    const length = units(type === 'insert' ? wideB : wideA, type === 'insert' ? atB : atA, count);
    if (type !== 'insert') atA += count;
    if (type !== 'delete') atB += count;
    const last = out.at(-1);
    if (last?.type === type) last.length += length; else out.push({ type, length });
  };
  push('equal', start);
  const middle = middleDiff(pointsA.subarray(start, endA), pointsB.subarray(start, endB), limit);
  for (const segment of middle) push(segment.type, segment.length);
  push('equal', pointsA.length - endA);
  return out;
}

function codePoints(text, symbols = null) {
  const points = new Float64Array(text.length), wide = new Uint8Array(text.length);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i);
    wide[n] = code > 0xffff ? 1 : 0;
    points[n++] = symbols?.[i] || code;
    if (code > 0xffff) i++;
  }
  return [points.subarray(0, n), wide.subarray(0, n)];
}

function middleDiff(a, b, limit) {
  const n = a.length, m = b.length;
  if (!n && !m) return [];
  if (!n) return [{ type: 'insert', length: m }];
  if (!m) return [{ type: 'delete', length: n }];
  const max = Math.min(n + m, limit);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, v, n, m, d, offset, a, b);
    }
  }
  // Too different to be worth a fine-grained script.
  return [{ type: 'delete', length: n }, { type: 'insert', length: m }];
}

function backtrack(trace, last, n, m, depth, offset) {
  const steps = [];
  let x = n, y = m;
  for (let d = depth; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = v[offset + prevK], prevY = prevX - prevK;
    while (x > prevX && y > prevY) { steps.push('equal'); x--; y--; }
    steps.push(down ? 'insert' : 'delete');
    x = prevX; y = prevY;
  }
  while (x > 0 && y > 0) { steps.push('equal'); x--; y--; }
  steps.reverse();
  const out = [];
  for (const type of steps) {
    const lastSegment = out.at(-1);
    if (lastSegment?.type === type) lastSegment.length++; else out.push({ type, length: 1 });
  }
  return out;
}
