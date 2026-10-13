/**
 * CCITT fax decoding (ITU-T T.4 and T.6): Group 3 one-dimensional
 * (modified Huffman), Group 3 two-dimensional (mixed, every K-th line
 * 1-D) and Group 4 (pure 2-D), with optional end-of-line codes, byte
 * alignment and end-of-block marks, as the PDF CCITTFaxDecode filter uses
 * them.
 *
 *   decodeCCITT(bytes, { K, columns, rows, blackIs1, byteAlign, endOfBlock })
 *     -> { data: Uint8Array (1 bit per pixel, rows padded to bytes), rows, columns, consumed (bytes) }
 *
 * With blackIs1 false (the default) black pixels are 0 bits, so the result
 * reads as 1-bit DeviceGray. Damaged data ends the image: rows that could
 * not be decoded stay white.
 */

// Run-length codes as [run, code bits]. Terminating codes (0-63), make-up codes (64-1728)
// and the extended make-up codes shared by both colors (1792-2560).
const WHITE = [
  [0, '00110101'], [1, '000111'], [2, '0111'], [3, '1000'], [4, '1011'], [5, '1100'], [6, '1110'], [7, '1111'], [8, '10011'], [9, '10100'],
  [10, '00111'], [11, '01000'], [12, '001000'], [13, '000011'], [14, '110100'], [15, '110101'], [16, '101010'], [17, '101011'], [18, '0100111'],
  [19, '0001100'], [20, '0001000'], [21, '0010111'], [22, '0000011'], [23, '0000100'], [24, '0101000'], [25, '0101011'], [26, '0010011'],
  [27, '0100100'], [28, '0011000'], [29, '00000010'], [30, '00000011'], [31, '00011010'], [32, '00011011'], [33, '00010010'], [34, '00010011'],
  [35, '00010100'], [36, '00010101'], [37, '00010110'], [38, '00010111'], [39, '00101000'], [40, '00101001'], [41, '00101010'], [42, '00101011'],
  [43, '00101100'], [44, '00101101'], [45, '00000100'], [46, '00000101'], [47, '00001010'], [48, '00001011'], [49, '01010010'], [50, '01010011'],
  [51, '01010100'], [52, '01010101'], [53, '00100100'], [54, '00100101'], [55, '01011000'], [56, '01011001'], [57, '01011010'], [58, '01011011'],
  [59, '01001010'], [60, '01001011'], [61, '00110010'], [62, '00110011'], [63, '00110100'],
  [64, '11011'], [128, '10010'], [192, '010111'], [256, '0110111'], [320, '00110110'], [384, '00110111'], [448, '01100100'], [512, '01100101'],
  [576, '01101000'], [640, '01100111'], [704, '011001100'], [768, '011001101'], [832, '011010010'], [896, '011010011'], [960, '011010100'],
  [1024, '011010101'], [1088, '011010110'], [1152, '011010111'], [1216, '011011000'], [1280, '011011001'], [1344, '011011010'], [1408, '011011011'],
  [1472, '010011000'], [1536, '010011001'], [1600, '010011010'], [1664, '011000'], [1728, '010011011'],
];
const BLACK = [
  [0, '0000110111'], [1, '010'], [2, '11'], [3, '10'], [4, '011'], [5, '0011'], [6, '0010'], [7, '00011'], [8, '000101'], [9, '000100'],
  [10, '0000100'], [11, '0000101'], [12, '0000111'], [13, '00000100'], [14, '00000111'], [15, '000011000'], [16, '0000010111'], [17, '0000011000'],
  [18, '0000001000'], [19, '00001100111'], [20, '00001101000'], [21, '00001101100'], [22, '00000110111'], [23, '00000101000'], [24, '00000010111'],
  [25, '00000011000'], [26, '000011001010'], [27, '000011001011'], [28, '000011001100'], [29, '000011001101'], [30, '000001101000'],
  [31, '000001101001'], [32, '000001101010'], [33, '000001101011'], [34, '000011010010'], [35, '000011010011'], [36, '000011010100'],
  [37, '000011010101'], [38, '000011010110'], [39, '000011010111'], [40, '000001101100'], [41, '000001101101'], [42, '000011011010'],
  [43, '000011011011'], [44, '000001010100'], [45, '000001010101'], [46, '000001010110'], [47, '000001010111'], [48, '000001100100'],
  [49, '000001100101'], [50, '000001010010'], [51, '000001010011'], [52, '000000100100'], [53, '000000110111'], [54, '000000111000'],
  [55, '000000100111'], [56, '000000101000'], [57, '000001011000'], [58, '000001011001'], [59, '000000101011'], [60, '000000101100'],
  [61, '000001011010'], [62, '000001100110'], [63, '000001100111'],
  [64, '0000001111'], [128, '000011001000'], [192, '000011001001'], [256, '000001011011'], [320, '000000110011'], [384, '000000110100'],
  [448, '000000110101'], [512, '0000001101100'], [576, '0000001101101'], [640, '0000001001010'], [704, '0000001001011'], [768, '0000001001100'],
  [832, '0000001001101'], [896, '0000001110010'], [960, '0000001110011'], [1024, '0000001110100'], [1088, '0000001110101'], [1152, '0000001110110'],
  [1216, '0000001110111'], [1280, '0000001010010'], [1344, '0000001010011'], [1408, '0000001010100'], [1472, '0000001010101'], [1536, '0000001011010'],
  [1600, '0000001011011'], [1664, '0000001100100'], [1728, '0000001100101'],
];
const EXTENDED = [
  [1792, '00000001000'], [1856, '00000001100'], [1920, '00000001101'], [1984, '000000010010'], [2048, '000000010011'], [2112, '000000010100'],
  [2176, '000000010101'], [2240, '000000010110'], [2304, '000000010111'], [2368, '000000011100'], [2432, '000000011101'], [2496, '000000011110'],
  [2560, '000000011111'],
];

// Two-dimensional mode codes.
const P = 'P';
const H = 'H';
const EXT = 'X';
const MODES = [[P, '0001'], [H, '001'], [0, '1'], [1, '011'], [2, '000011'], [3, '0000011'], [-1, '010'], [-2, '000010'], [-3, '0000010'], [EXT, '0000001']];

export const CCITT_TABLES = { WHITE, BLACK, EXTENDED, MODES };

const LOOK = 13;

/** A lookup table indexed by the next LOOK bits: entries (value, length) or length 0 for invalid codes. */
function table(codes) {
  const len = new Uint8Array(1 << LOOK);
  const val = new Array(1 << LOOK).fill(null);
  for (const [v, bits] of codes) {
    const n = bits.length;
    const code = parseInt(bits, 2);
    const from = code << (LOOK - n);
    const to = (code + 1) << (LOOK - n);
    for (let i = from; i < to; i++) {
      len[i] = n;
      val[i] = v;
    }
  }
  return { len, val };
}

let tables = null;
function getTables() {
  if (!tables) tables = { white: table([...WHITE, ...EXTENDED]), black: table([...BLACK, ...EXTENDED]), modes: table(MODES) };
  return tables;
}

class BitReader {
  constructor(data) {
    this.data = data;
    this.pos = 0; // bit position
    this.end = data.length * 8;
  }

  peek(n) {
    let v = 0;
    let p = this.pos;
    for (let i = 0; i < n; i++, p++) v = (v << 1) | (p < this.end ? (this.data[p >> 3] >> (7 - (p & 7))) & 1 : 0);
    return v;
  }

  skip(n) {
    this.pos += n;
  }

  align() {
    this.pos = (this.pos + 7) & ~7;
  }

  get done() {
    return this.pos >= this.end;
  }
}

class CCITTError extends Error {}

/** One run of a color: make-up codes then a terminating code. */
function readRun(br, tab) {
  let total = 0;
  for (let guard = 0; guard < 64; guard++) {
    const i = br.peek(LOOK);
    const n = tab.len[i];
    if (!n || br.done) throw new CCITTError('Bad run code');
    br.skip(n);
    const v = tab.val[i];
    total += v;
    if (v < 64) return total;
  }
  throw new CCITTError('Run too long');
}

/** Skip fill bits and an end-of-line code if one follows; true when one was found. */
function skipEOL(br) {
  const save = br.pos;
  let zeros = 0;
  while (!br.done && br.peek(1) === 0) {
    br.skip(1);
    zeros++;
  }
  if (zeros >= 11 && !br.done) {
    br.skip(1);
    return true;
  }
  br.pos = save;
  return false;
}

/** Fill pixels [from, to) of a row (0 = white bits set as 1 unless blackIs1) as black. */
function paintBlack(row, from, to) {
  for (let x = from; x < to; x++) row[x >> 3] ^= 0x80 >> (x & 7);
}

export function decodeCCITT(bytes, opts = {}) {
  const K = opts.K ?? 0;
  const columns = Math.max(1, opts.columns ?? 1728);
  const maxRows = opts.rows > 0 ? opts.rows : Infinity;
  const blackIs1 = Boolean(opts.blackIs1);
  const byteAlign = Boolean(opts.byteAlign);
  const endOfBlock = opts.endOfBlock !== false;
  const { white, black, modes } = getTables();
  const br = new BitReader(bytes);
  const rowBytes = (columns + 7) >> 3;
  const rows = [];
  // Changing elements of the reference line (positions where the color flips), with two sentinels.
  let ref = [columns, columns];
  let cur = [];
  for (let y = 0; y < maxRows; y++) {
    if (br.done) break;
    if (byteAlign && K < 0) br.align();
    let twoD = K < 0;
    if (K >= 0) {
      // End-of-line codes (and the fill before them) are optional; six in a row end the data.
      // With byte alignment an end-of-line code ends on a byte boundary, else the line starts on one.
      let eols = 0;
      while (skipEOL(br)) eols++;
      if (eols >= 2 && endOfBlock) break;
      if (!eols && byteAlign) br.align();
      if (br.done) break;
      if (K > 0) {
        twoD = br.peek(1) === 0;
        br.skip(1);
      }
    } else if (endOfBlock && br.peek(24) === 0x001001) {
      br.skip(24);
      break;
    } else if (br.peek(12) === 1) {
      // An end-of-line code in Group 4 data.
      br.skip(12);
      if (br.peek(12) === 1) {
        br.skip(12);
        break;
      }
    }
    cur = [];
    try {
      if (twoD) decode2D(br, ref, cur, columns, white, black, modes);
      else decode1D(br, cur, columns, white, black);
    } catch (err) {
      if (!(err instanceof CCITTError)) throw err;
      break;
    }
    // Paint the row from its changing elements.
    const row = new Uint8Array(rowBytes).fill(0xff);
    for (let k = 0; k < cur.length; k += 2) paintBlack(row, Math.min(cur[k], columns), Math.min(cur[k + 1] ?? columns, columns));
    // Clear the pad bits past the last column (they stay white).
    if (columns & 7) row[rowBytes - 1] |= 0xff >> (columns & 7);
    rows.push(row);
    ref = [...cur, columns, columns];
  }
  const n = Number.isFinite(maxRows) ? maxRows : rows.length;
  const out = new Uint8Array(rowBytes * n).fill(0xff);
  rows.forEach((r, i) => out.set(r, i * rowBytes));
  if (blackIs1) for (let i = 0; i < out.length; i++) out[i] ^= 0xff;
  return { data: out, rows: n, columns, consumed: Math.min(bytes.length, Math.ceil(br.pos / 8)) };
}

function decode1D(br, cur, columns, white, black) {
  let a0 = 0;
  let color = 0;
  while (a0 < columns) {
    const run = readRun(br, color ? black : white);
    a0 = Math.min(columns, a0 + run);
    cur.push(a0);
    color ^= 1;
  }
  while (cur.length && cur[cur.length - 1] >= columns) cur.pop();
}

function decode2D(br, ref, cur, columns, white, black, modes) {
  let a0 = -1;
  let color = 0;
  let k = 0; // search start in ref
  while (a0 < columns) {
    // b1: the first changing element on the reference line right of a0 with the opposite color.
    const from = a0 < 0 ? 0 : a0 + 1;
    while (k > 0 && ref[k - 1] >= from) k--;
    while (ref[k] < from || (k & 1) !== color) k++;
    const b1 = ref[k];
    const b2 = ref[k + 1] ?? columns;
    const i = br.peek(LOOK);
    const n = modes.len[i];
    if (!n || br.done) throw new CCITTError('Bad mode code');
    br.skip(n);
    const mode = modes.val[i];
    if (mode === P) {
      // The coding line keeps its color up to b2.
      a0 = b2;
      continue;
    }
    if (mode === H) {
      const start = a0 < 0 ? 0 : a0;
      const r1 = readRun(br, color ? black : white);
      const r2 = readRun(br, color ? white : black);
      const a1 = Math.min(columns, start + r1);
      const a2 = Math.min(columns, a1 + r2);
      cur.push(a1, a2);
      a0 = a2;
      continue;
    }
    if (mode === EXT) throw new CCITTError('Uncompressed mode is not supported');
    const a1 = Math.max(0, Math.min(columns, b1 + mode));
    if (a1 < (a0 < 0 ? 0 : a0)) throw new CCITTError('Bad vertical code');
    cur.push(a1);
    a0 = a1;
    color ^= 1;
  }
  while (cur.length && cur[cur.length - 1] >= columns) cur.pop();
}
