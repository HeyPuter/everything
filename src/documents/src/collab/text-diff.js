/**
 * A shortest edit script between two strings (the O(ND) greedy algorithm with a
 * bounded number of differences). The co-editing layer uses it to turn the
 * paragraphs a local edit changed into character insertions and deletions, so
 * a concurrent edit by someone else elsewhere in those paragraphs survives.
 *
 * Returns segments in order: { type: 'equal' | 'insert' | 'delete', length }
 * where insert lengths count characters of `b` and the others characters of `a`.
 * When the strings differ in more than `limit` places the middle is replaced
 * wholesale (one delete and one insert), which is still correct, only coarser.
 */
export function diffText(a, b, { limit = 2000 } = {}) {
  let start = 0;
  const shortest = Math.min(a.length, b.length);
  while (start < shortest && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) { endA--; endB--; }
  const out = [];
  const push = (type, length) => {
    if (!length) return;
    const last = out.at(-1);
    if (last?.type === type) last.length += length; else out.push({ type, length });
  };
  push('equal', start);
  const middle = middleDiff(a.slice(start, endA), b.slice(start, endB), limit);
  for (const segment of middle) push(segment.type, segment.length);
  push('equal', a.length - endA);
  return out;
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
      while (x < n && y < m && a.charCodeAt(x) === b.charCodeAt(y)) { x++; y++; }
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
