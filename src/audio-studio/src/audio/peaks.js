// Waveform reduction: per-block min/max levels (256 and 4096 frames per bucket)
// built lazily and cached on the immutable Block, then combined into per-pixel
// columns for the current view. Blocks never change, so the cache never goes
// stale; edits only create new blocks.

const L1 = 256;
const L2 = 4096;

function buildLevels(data) {
  const n1 = Math.ceil(data.length / L1);
  const l1 = new Float32Array(n1 * 2);
  for (let b = 0, i = 0; b < n1; b++) {
    const end = Math.min(data.length, i + L1);
    let lo = Infinity;
    let hi = -Infinity;
    for (; i < end; i++) {
      const v = data[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    l1[2 * b] = lo;
    l1[2 * b + 1] = hi;
  }
  const ratio = L2 / L1;
  const n2 = Math.ceil(n1 / ratio);
  const l2 = new Float32Array(n2 * 2);
  for (let b = 0; b < n2; b++) {
    let lo = Infinity;
    let hi = -Infinity;
    const end = Math.min(n1, (b + 1) * ratio);
    for (let j = b * ratio; j < end; j++) {
      if (l1[2 * j] < lo) lo = l1[2 * j];
      if (l1[2 * j + 1] > hi) hi = l1[2 * j + 1];
    }
    l2[2 * b] = lo;
    l2[2 * b + 1] = hi;
  }
  return { l1, l2 };
}

export function blockLevels(block) {
  if (!block.peaks) block.peaks = buildLevels(block.data);
  return block.peaks;
}

/** Min/max of block.data[x, y), using cached levels for long ranges. acc = [lo, hi]. */
function rangeMinMax(block, x, y, acc) {
  const data = block.data;
  if (y - x < L1 * 2) {
    for (let i = x; i < y; i++) {
      const v = data[i];
      if (v < acc[0]) acc[0] = v;
      if (v > acc[1]) acc[1] = v;
    }
    return;
  }
  const { l1, l2 } = blockLevels(block);
  const useL2 = y - x >= L2 * 2;
  const size = useL2 ? L2 : L1;
  const lv = useL2 ? l2 : l1;
  const first = Math.ceil(x / size);
  const last = Math.floor(y / size); // exclusive
  // Edges below one bucket go through the finer path.
  if (first * size > x) rangeMinMax(block, x, first * size, acc);
  for (let b = first; b < last; b++) {
    if (lv[2 * b] < acc[0]) acc[0] = lv[2 * b];
    if (lv[2 * b + 1] > acc[1]) acc[1] = lv[2 * b + 1];
  }
  if (last * size < y) rangeMinMax(block, Math.max(x, last * size), y, acc);
}

/**
 * Fills out[2 * c], out[2 * c + 1] with min and max of each pixel column
 * c in [0, columns), where column c spans frames [start + c * fpp, start + (c + 1) * fpp).
 * Columns outside the channel are NaN so renderers can skip them.
 *
 * `defer` ({ deadline, pending: Set }) spreads first-time level building over
 * several frames: once performance.now() passes the deadline, a column that
 * needs levels of a block without them is left NaN and the block goes into
 * `pending`, to be drawn on a later call.
 */
export function channelColumns(channel, start, fpp, columns, out = new Float32Array(columns * 2), defer = null) {
  const acc = [0, 0];
  for (let c = 0; c < columns; c++) {
    let a = Math.floor(start + c * fpp);
    let b = Math.floor(start + (c + 1) * fpp);
    if (b <= a) b = a + 1;
    if (b <= 0 || a >= channel.length) {
      out[2 * c] = NaN;
      out[2 * c + 1] = NaN;
      continue;
    }
    a = Math.max(0, a);
    b = Math.min(channel.length, b);
    acc[0] = Infinity;
    acc[1] = -Infinity;
    let i = channel.pieceIndex(a);
    let at = a;
    let missing = false;
    while (at < b) {
      const p = channel.pieces[i];
      const inPiece = at - channel.starts[i];
      const take = Math.min(p.length - inPiece, b - at);
      // Ranges this long read the block's levels (see rangeMinMax); each call builds at least one.
      const unbuilt = defer && !p.block.peaks && take >= L1 * 2;
      if (unbuilt && (defer.pending.size || (defer.built && performance.now() > defer.deadline))) {
        defer.pending.add(p.block);
        missing = true;
      } else if (!missing) {
        if (unbuilt) defer.built = (defer.built || 0) + 1;
        rangeMinMax(p.block, p.offset + inPiece, p.offset + inPiece + take, acc);
      }
      at += take;
      i++;
    }
    out[2 * c] = missing ? NaN : acc[0];
    out[2 * c + 1] = missing ? NaN : acc[1];
  }
  return out;
}

/** Peak absolute value over [start, end) of a channel. */
export function channelPeak(channel, start = 0, end = channel.length) {
  const acc = [Infinity, -Infinity];
  let i = start < channel.length ? channel.pieceIndex(Math.max(0, start)) : channel.pieces.length;
  let at = Math.max(0, start);
  end = Math.min(end, channel.length);
  while (at < end) {
    const p = channel.pieces[i];
    const inPiece = at - channel.starts[i];
    const take = Math.min(p.length - inPiece, end - at);
    rangeMinMax(p.block, p.offset + inPiece, p.offset + inPiece + take, acc);
    at += take;
    i++;
  }
  if (acc[0] === Infinity) return 0;
  return Math.max(Math.abs(acc[0]), Math.abs(acc[1]));
}
