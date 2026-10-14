// Standard MIDI File reading and writing (formats 0 and 1).
//
//   readMidi(arrayBuffer) -> {
//     format, ppq,
//     tracks: [{ name, notes: [{ ch, key, tick, len, vel (1..127) }], programs: { [ch]: program } }],
//     tempos: [{ tick, bpm }], sigs: [{ tick, num, den }],
//   }
//   writeMidi({ ppq, bpm, sig, name, tracks: [{ name, channel, program, notes }] }) -> Uint8Array
//
// The reader handles running status, note on with velocity 0 as note off,
// overlapping notes on the same key (first in, first out), sysex and meta
// events, and notes left open at the end of a track. Ticks stay in the file's
// resolution; the importer converts them to the app's PPQ.

// ------------------------------------------------------------------ reader

class Reader {
  constructor(bytes, start = 0, end = bytes.length) {
    this.b = bytes;
    this.p = start;
    this.end = end;
  }

  get done() {
    return this.p >= this.end;
  }

  u8() {
    if (this.p >= this.end) throw new Error('The MIDI file is truncated.');
    return this.b[this.p++];
  }

  u16() {
    return (this.u8() << 8) | this.u8();
  }

  u32() {
    return ((this.u8() << 24) >>> 0) + (this.u8() << 16) + (this.u8() << 8) + this.u8();
  }

  str(n) {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8());
    return s;
  }

  /** Variable-length quantity (at most 4 bytes). */
  vlq() {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const c = this.u8();
      v = (v << 7) | (c & 0x7f);
      if (!(c & 0x80)) return v;
    }
    return v;
  }
}

// Text events are UTF-8 or Latin-1; only the start of a long one is kept.
const latin1 = (r, n) => {
  const bytes = r.b.subarray(r.p, Math.min(r.end, r.p + n, r.p + 1024));
  r.p += n;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    let s = '';
    for (const c of bytes) s += String.fromCharCode(c);
    return s;
  }
};

export function readMidi(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const r = new Reader(bytes);
  if (bytes.length < 14 || r.str(4) !== 'MThd') throw new Error('The file is not a Standard MIDI File.');
  const hdrLen = r.u32();
  const format = r.u16();
  const ntrks = r.u16();
  const division = r.u16();
  r.p = 8 + hdrLen;
  if (division & 0x8000) throw new Error('MIDI files with SMPTE timing are not supported.');
  if (format > 1) throw new Error('Only MIDI file formats 0 and 1 are supported.');
  const ppq = division || 96;
  const tracks = [];
  const tempos = [];
  const sigs = [];
  for (let t = 0; t < ntrks && r.p + 8 <= bytes.length; t++) {
    const id = r.str(4);
    const len = r.u32();
    const end = Math.min(bytes.length, r.p + len);
    if (id !== 'MTrk') {
      r.p = end;
      t--;
      continue;
    }
    tracks.push(readTrack(new Reader(bytes, r.p, end), tempos, sigs));
    r.p = end;
  }
  tempos.sort((a, b) => a.tick - b.tick);
  sigs.sort((a, b) => a.tick - b.tick);
  return { format, ppq, tracks, tempos, sigs };
}

function readTrack(r, tempos, sigs) {
  const track = { name: '', notes: [], programs: {} };
  const open = new Map(); // (ch << 7 | key) -> [{ tick, vel }]
  let tick = 0;
  let status = 0;
  // Each queue is { items, head }: a head index instead of shift() keeps
  // thousands of stacked note-ons on one key linear.
  const close = (ch, key, at) => {
    const q = open.get((ch << 7) | key);
    if (!q || q.head >= q.items.length) return;
    const n = q.items[q.head++];
    track.notes.push({ ch, key, tick: n.tick, len: Math.max(1, at - n.tick), vel: n.vel });
  };
  while (!r.done) {
    tick += r.vlq();
    let b = r.u8();
    if (b === 0xff) {
      const type = r.u8();
      const len = r.vlq();
      const at = r.p;
      if (type === 0x03 && !track.name) track.name = latin1(r, len).trim();
      else if (type === 0x51 && len >= 3) {
        const us = (r.u8() << 16) | (r.u8() << 8) | r.u8();
        if (us > 0) tempos.push({ tick, bpm: 60000000 / us });
      }
      else if (type === 0x58 && len >= 2) sigs.push({ tick, num: r.u8(), den: 2 ** r.u8() });
      r.p = at + len;
      if (type === 0x2f) break;
      continue;
    }
    if (b === 0xf0 || b === 0xf7) {
      const len = r.vlq();
      r.p += len;
      continue;
    }
    if (b & 0x80) {
      status = b;
      b = r.u8();
    } else if (!status) {
      throw new Error('The MIDI file is damaged (data without a status byte).');
    }
    // `b` is now the first data byte (running status reuses the last status).
    const type = status & 0xf0;
    const ch = status & 0x0f;
    if (type === 0xc0 || type === 0xd0) {
      if (type === 0xc0 && track.programs[ch] === undefined) track.programs[ch] = b & 0x7f;
      continue;
    }
    const d2 = r.u8();
    if (type === 0x90 && d2 > 0) {
      const k = (ch << 7) | (b & 0x7f);
      if (!open.has(k)) open.set(k, { items: [], head: 0 });
      open.get(k).items.push({ tick, vel: d2 });
    } else if (type === 0x80 || type === 0x90) {
      close(ch, b & 0x7f, tick);
    }
    // 0xa0 aftertouch, 0xb0 controllers, 0xe0 pitch bend: skipped.
  }
  // Notes still held at the end of the track end there.
  for (const [k, q] of open) while (q.head < q.items.length) close(k >> 7, k & 0x7f, tick);
  track.notes.sort((a, b) => a.tick - b.tick || a.key - b.key);
  return track;
}

// ------------------------------------------------------------------ writer

class Writer {
  constructor() {
    this.bytes = [];
  }

  u8(...v) {
    for (const x of v) this.bytes.push(x & 0xff);
  }

  u16(v) {
    this.u8(v >> 8, v);
  }

  u32(v) {
    this.u8(v >>> 24, v >>> 16, v >>> 8, v);
  }

  str(s) {
    for (const c of s) this.u8(c.charCodeAt(0));
  }

  vlq(v) {
    const out = [v & 0x7f];
    v >>>= 7;
    while (v > 0) {
      out.unshift((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    this.u8(...out);
  }

  text(type, s) {
    const enc = new TextEncoder().encode(s);
    this.u8(0xff, type);
    this.vlq(enc.length);
    for (const x of enc) this.bytes.push(x);
  }
}

function chunk(w, id, body) {
  w.str(id);
  w.u32(body.length);
  // A loop, not a spread: tracks can be far longer than the argument limit.
  for (const x of body) w.bytes.push(x & 0xff);
}

/** Writes a format 1 file: a tempo track, then one track per entry of `tracks`. */
export function writeMidi({ ppq = 96, bpm = 120, sig = [4, 4], name = '', tracks = [] }) {
  const out = new Writer();
  const ntrks = Math.min(0xffff, tracks.length + 1);
  chunk(out, 'MThd', [0, 1, (ntrks >> 8) & 0xff, ntrks & 0xff, (ppq >> 8) & 0xff, ppq & 0xff]);

  const meta = new Writer();
  meta.u8(0);
  meta.text(0x03, name);
  const us = Math.round(60000000 / bpm);
  meta.u8(0, 0xff, 0x51, 3, us >> 16, us >> 8, us);
  meta.u8(0, 0xff, 0x58, 4, sig[0], Math.round(Math.log2(sig[1])), 24, 8);
  meta.u8(0, 0xff, 0x2f, 0);
  chunk(out, 'MTrk', meta.bytes);

  for (const t of tracks) {
    const w = new Writer();
    const ch = t.channel & 0x0f;
    w.u8(0);
    w.text(0x03, t.name || '');
    if (t.program !== undefined && t.program !== null && ch !== 9) w.u8(0, 0xc0 | ch, t.program & 0x7f);
    // Offs sort before ons at the same tick so repeated notes retrigger.
    const events = [];
    for (const n of t.notes) {
      const vel = Math.max(1, Math.min(127, Math.round(n.vel)));
      events.push({ tick: Math.max(0, Math.round(n.tick)), on: true, key: n.key, vel });
      events.push({ tick: Math.max(0, Math.round(n.tick + Math.max(1, n.len))), on: false, key: n.key, vel: 0 });
    }
    events.sort((a, b) => a.tick - b.tick || a.on - b.on || a.key - b.key);
    let last = 0;
    for (const e of events) {
      w.vlq(e.tick - last);
      last = e.tick;
      w.u8(e.on ? 0x90 | ch : 0x80 | ch, e.key & 0x7f, e.on ? e.vel : 0x40);
    }
    w.u8(0, 0xff, 0x2f, 0);
    chunk(out, 'MTrk', w.bytes);
  }
  return new Uint8Array(out.bytes);
}

/** Whether bytes start like a MIDI file. */
export function isMidi(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return b.length >= 4 && b[0] === 0x4d && b[1] === 0x54 && b[2] === 0x68 && b[3] === 0x64;
}
