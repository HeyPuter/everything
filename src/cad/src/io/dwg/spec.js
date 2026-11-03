/**
 * Field-by-field descriptions shared by the DWG reader and writer.
 *
 * A spec function calls methods on an `io` object named after the DWG data
 * types (B, BS, BD, T, H, ...), passing the field name. SpecReader reads the
 * value and stores it under that name; SpecWriter writes the stored value
 * (or the given default). Both return the value, so specs can branch on
 * counts and flags the same way in either direction.
 *
 * Objects have up to three streams: data, strings (R2007+) and handles.
 * `T` goes to the string stream, `H` to the handle stream.
 */
import { R2007 } from './bits.js';

export class SpecReader {
  constructor(data, strings, handles, ref = 0) {
    this.d = data;
    this.s = strings || data;
    this.h = handles || data;
    this.ver = data.ver;
    this.o = {};
    this.ref = ref;
  }

  put(k, v) {
    if (k) this.o[k] = v;
    return v;
  }

  B(k) {
    return this.put(k, this.d.B());
  }
  BB(k) {
    return this.put(k, this.d.BB());
  }
  B3(k) {
    return this.put(k, this.d.B3());
  }
  BS(k) {
    return this.put(k, this.d.BS());
  }
  BSs(k) {
    return this.put(k, this.d.BSs());
  }
  BL(k) {
    return this.put(k, this.d.BL());
  }
  BLL(k) {
    return this.put(k, this.d.BLL());
  }
  BD(k) {
    return this.put(k, this.d.BD());
  }
  DD(k, def) {
    return this.put(k, this.d.DD(def));
  }
  RC(k) {
    return this.put(k, this.d.RC());
  }
  RS(k) {
    return this.put(k, this.d.RS());
  }
  RL(k) {
    return this.put(k, this.d.RL());
  }
  RD(k) {
    return this.put(k, this.d.RD());
  }
  RD2(k) {
    return this.put(k, this.d.RD2());
  }
  RD3(k) {
    return this.put(k, this.d.RD3());
  }
  BD2(k) {
    return this.put(k, this.d.BD2());
  }
  BD3(k) {
    return this.put(k, this.d.BD3());
  }
  DD2(k, def) {
    return this.put(k, this.d.DD2(def));
  }
  BE(k) {
    return this.put(k, this.d.BE());
  }
  BT(k) {
    return this.put(k, this.d.BT());
  }
  CMC(k) {
    return this.put(k, this.d.CMC());
  }
  ENC(k) {
    return this.put(k, this.d.ENC());
  }
  /** A run of non-zero bytes ended by a zero byte; the value is the run length. */
  RUN(k) {
    let n = 0;
    while (this.d.RC() !== 0) n++;
    return this.put(k, n);
  }
  /** A text field: in the string stream for R2007+. */
  T(k) {
    return this.put(k, this.s.T());
  }
  /** A text field that stays in the data stream. */
  TV(k) {
    return this.put(k, this.d.TV());
  }
  /** A handle in the handle stream, resolved to an absolute value. */
  H(k) {
    return this.put(k, this.h.HR(this.ref));
  }
  /** A handle in the data stream (HANDSEED). */
  HD(k) {
    return this.put(k, this.d.H().value);
  }
  /** Julian date: day and milliseconds. */
  TIME(k) {
    return this.put(k, [this.d.BL(), this.d.BL()]);
  }
  /** Raw bytes. */
  X(k, n) {
    return this.put(k, this.d.bytes(n));
  }
}

export class SpecWriter {
  /**
   * @param {BitWriter} data
   * @param {BitWriter|null} strings separate string stream (R2007+)
   * @param {BitWriter|null} handles separate handle stream
   * @param {object} values field values by name
   */
  constructor(data, strings, handles, values) {
    this.d = data;
    this.s = strings || data;
    this.h = handles || data;
    this.ver = data.ver;
    this.o = values || {};
  }

  get(k, def) {
    const v = k ? this.o[k] : undefined;
    return v === undefined ? def : v;
  }

  B(k, def = 0) {
    const v = this.get(k, def) ? 1 : 0;
    this.d.B(v);
    return v;
  }
  BB(k, def = 0) {
    const v = this.get(k, def);
    this.d.BB(v);
    return v;
  }
  B3(k, def = 0) {
    const v = this.get(k, def);
    this.d.B3(v);
    return v;
  }
  BS(k, def = 0) {
    const v = this.get(k, def);
    this.d.BS(v);
    return v;
  }
  BSs(k, def = 0) {
    return this.BS(k, def);
  }
  BL(k, def = 0) {
    const v = this.get(k, def);
    this.d.BL(v);
    return v;
  }
  BLL(k, def = 0) {
    const v = this.get(k, def);
    this.d.BLL(v);
    return v;
  }
  BD(k, def = 0) {
    const v = this.get(k, def);
    this.d.BD(v);
    return v;
  }
  DD(k, def) {
    const v = this.get(k, def);
    this.d.DD(v, def);
    return v;
  }
  RC(k, def = 0) {
    const v = this.get(k, def);
    this.d.RC(v);
    return v;
  }
  RS(k, def = 0) {
    const v = this.get(k, def);
    this.d.RS(v);
    return v;
  }
  RL(k, def = 0) {
    const v = this.get(k, def);
    this.d.RL(v);
    return v;
  }
  RD(k, def = 0) {
    const v = this.get(k, def);
    this.d.RD(v);
    return v;
  }
  RD2(k, def = [0, 0]) {
    const v = this.get(k, def);
    this.d.RD2(v);
    return v;
  }
  RD3(k, def = [0, 0, 0]) {
    const v = this.get(k, def);
    this.d.RD3(v);
    return v;
  }
  BD2(k, def = [0, 0]) {
    const v = this.get(k, def);
    this.d.BD2(v);
    return v;
  }
  BD3(k, def = [0, 0, 0]) {
    const v = this.get(k, def);
    this.d.BD3(v);
    return v;
  }
  DD2(k, def) {
    const v = this.get(k, def);
    this.d.DD2(v, def);
    return v;
  }
  BE(k, def = [0, 0, 1]) {
    const v = this.get(k, def);
    this.d.BE(v);
    return v;
  }
  BT(k, def = 0) {
    const v = this.get(k, def);
    this.d.BT(v);
    return v;
  }
  CMC(k, def = { index: 256, rgb: null }) {
    const v = this.get(k, def);
    const c = typeof v === 'number' ? { index: v, rgb: null } : v;
    this.d.CMC(c.index ?? 256, c.rgb ?? null);
    return c;
  }
  ENC(k, def = { index: 256, rgb: null, alpha: null }) {
    const v = this.get(k, def);
    const c = typeof v === 'number' ? { index: v, rgb: null, alpha: null } : v;
    this.d.ENC(c.index ?? 256, c.rgb ?? null, c.alpha ?? null);
    return c;
  }
  RUN(k, def = 0) {
    const n = this.get(k, def);
    for (let i = 0; i < n; i++) this.d.RC(1);
    this.d.RC(0);
    return n;
  }
  T(k, def = '') {
    const v = this.get(k, def);
    this.s.T(v);
    return v;
  }
  TV(k, def = '') {
    const v = this.get(k, def);
    this.d.TV(v);
    return v;
  }
  /**
   * Handle: values are numbers (written with code 5, a hard pointer) or
   * { code, value }.
   */
  H(k, def = 0) {
    const v = this.get(k, def);
    if (typeof v === 'number') this.h.H(5, v);
    else this.h.H(v.code, v.value);
    return typeof v === 'number' ? v : v.value;
  }
  HD(k, def = 0) {
    const v = this.get(k, def);
    this.d.H(0, v);
    return v;
  }
  TIME(k, def = [0, 0]) {
    const v = this.get(k, def);
    this.d.BL(v[0]);
    this.d.BL(v[1]);
    return v;
  }
  X(k, n) {
    const v = this.get(k, null) || new Uint8Array(n);
    for (let i = 0; i < n; i++) this.d.RC(v[i] || 0);
    return v;
  }
}

/** True for R2007+ where strings live in their own stream. */
export const splitStrings = (ver) => ver >= R2007;
