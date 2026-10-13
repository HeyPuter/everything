/**
 * The MQ adaptive binary arithmetic decoder shared by JBIG2 and JPEG 2000
 * (ITU-T T.88 Annex E, T.800 Annex C). Contexts are bytes holding the
 * probability state index (bits 1-7) and the more probable symbol (bit 0).
 */

// Probability estimation: [Qe, next index after MPS, next index after LPS, switch MPS].
const STATES = [
  [0x5601, 1, 1, 1], [0x3401, 2, 6, 0], [0x1801, 3, 9, 0], [0x0ac1, 4, 12, 0], [0x0521, 5, 29, 0], [0x0221, 38, 33, 0],
  [0x5601, 7, 6, 1], [0x5401, 8, 14, 0], [0x4801, 9, 14, 0], [0x3801, 10, 14, 0], [0x3001, 11, 17, 0], [0x2401, 12, 18, 0],
  [0x1c01, 13, 20, 0], [0x1601, 29, 21, 0], [0x5601, 15, 14, 1], [0x5401, 16, 14, 0], [0x5101, 17, 15, 0], [0x4801, 18, 16, 0],
  [0x3801, 19, 17, 0], [0x3401, 20, 18, 0], [0x3001, 21, 19, 0], [0x2801, 22, 19, 0], [0x2401, 23, 20, 0], [0x2201, 24, 21, 0],
  [0x1c01, 25, 22, 0], [0x1801, 26, 23, 0], [0x1601, 27, 24, 0], [0x1401, 28, 25, 0], [0x1201, 29, 26, 0], [0x1101, 30, 27, 0],
  [0x0ac1, 31, 28, 0], [0x09c1, 32, 29, 0], [0x08a1, 33, 30, 0], [0x0521, 34, 31, 0], [0x0441, 35, 32, 0], [0x02a1, 36, 33, 0],
  [0x0221, 37, 34, 0], [0x0141, 38, 35, 0], [0x0111, 39, 36, 0], [0x0085, 40, 37, 0], [0x0049, 41, 38, 0], [0x0025, 42, 39, 0],
  [0x0015, 43, 40, 0], [0x0009, 44, 41, 0], [0x0005, 45, 42, 0], [0x0001, 45, 43, 0], [0x5601, 46, 46, 0],
];
const QE = Int32Array.from(STATES, (s) => s[0]);
const NMPS = Uint8Array.from(STATES, (s) => s[1]);
const NLPS = Uint8Array.from(STATES, (s) => s[2]);
const SWITCH = Uint8Array.from(STATES, (s) => s[3]);

export const MQ_STATES = STATES;

export class MQDecoder {
  /** Decode data[start, end). */
  constructor(data, start = 0, end = data.length) {
    this.data = data;
    this.end = end;
    this.bp = start;
    this.c = ((start < end ? data[start] : 0xff) << 16) >>> 0;
    this.byteIn();
    this.c = (this.c << 7) >>> 0;
    this.ct -= 7;
    this.a = 0x8000;
  }

  byteIn() {
    const d = this.data;
    const next = this.bp + 1 < this.end ? d[this.bp + 1] : 0xff;
    if ((this.bp < this.end ? d[this.bp] : 0xff) === 0xff) {
      if (next > 0x8f) {
        this.c = (this.c + 0xff00) >>> 0;
        this.ct = 8;
      } else {
        this.bp++;
        this.c = (this.c + (next << 9)) >>> 0;
        this.ct = 7;
      }
    } else {
      this.bp++;
      this.c = (this.c + (next << 8)) >>> 0;
      this.ct = 8;
    }
  }

  /** Decode one decision with context cx of the context array cxs. */
  decode(cxs, cx) {
    const s = cxs[cx];
    let i = s >> 1;
    let mps = s & 1;
    const qe = QE[i];
    let d;
    // The less probable symbol owns the bottom Qe of the interval (unless exchanged).
    this.a -= qe;
    if (this.c >>> 16 < qe) {
      if (this.a < qe) {
        d = mps;
        i = NMPS[i];
      } else {
        d = 1 - mps;
        if (SWITCH[i]) mps = 1 - mps;
        i = NLPS[i];
      }
      this.a = qe;
    } else {
      this.c = (this.c - (qe << 16)) >>> 0;
      if (this.a & 0x8000) return mps;
      if (this.a < qe) {
        d = 1 - mps;
        if (SWITCH[i]) mps = 1 - mps;
        i = NLPS[i];
      } else {
        d = mps;
        i = NMPS[i];
      }
    }
    cxs[cx] = (i << 1) | mps;
    // Renormalize.
    do {
      if (this.ct === 0) this.byteIn();
      this.a <<= 1;
      this.c = (this.c << 1) >>> 0;
      this.ct--;
    } while (!(this.a & 0x8000));
    return d;
  }
}
