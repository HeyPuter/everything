// Markers in compressed formats, as chapters:
//   FLAC, Ogg Opus/Vorbis  Vorbis comments CHAPTER001=HH:MM:SS.mmm and CHAPTER001NAME=name
//                          (the convention media players read), written with the other tags;
//   MP4 (.m4a)             a "chpl" chapter list box in moov/udta: start times in 100 ns
//                          units and names.
// Chapters carry a start and a name, so range markers come back as cue markers.

const enc = new TextEncoder();
const utf8 = new TextDecoder();
const latin1 = (b) => String.fromCharCode(...b);
const MAX_CHAPTERS = 999;

/** "01:02:03.456" for seconds. */
export function chapterTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
}

/** Seconds from "HH:MM:SS(.fff)", "MM:SS(.fff)" or seconds; NaN when unreadable. */
export function parseChapterTime(text) {
  const parts = String(text).trim().split(':');
  if (!parts.length || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return NaN;
  return parts.reduce((s, p) => s * 60 + Number(p), 0);
}

const sorted = (markers, rate) =>
  markers
    .filter((m) => Number.isFinite(m.start) && m.start >= 0)
    .slice()
    .sort((a, b) => a.start - b.start)
    .slice(0, MAX_CHAPTERS)
    .map((m, i) => ({ name: String(m.name || `Marker ${String(i + 1).padStart(2, '0')}`), seconds: m.start / rate }));

/** Vorbis comment entries ("KEY=value") for markers whose starts are in frames at `rate`. */
export function vorbisChapterEntries(markers = [], rate) {
  return sorted(markers, rate).flatMap((c, i) => {
    const n = String(i + 1).padStart(3, '0');
    return [`CHAPTER${n}=${chapterTime(c.seconds)}`, `CHAPTER${n}NAME=${c.name}`];
  });
}

/** Chapters ({ name, seconds }) in a Vorbis comment block (vendor string, count, entries). */
export function chaptersFromVorbis(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const times = new Map();
  const names = new Map();
  try {
    let o = 4 + dv.getUint32(0, true);
    const n = dv.getUint32(o, true);
    o += 4;
    for (let i = 0; i < n && o + 4 <= bytes.length; i++) {
      const len = dv.getUint32(o, true);
      const s = utf8.decode(bytes.subarray(o + 4, o + 4 + len));
      o += 4 + len;
      const m = /^CHAPTER(\d{1,3})(NAME)?=(.*)$/is.exec(s);
      if (!m) continue;
      if (m[2]) names.set(Number(m[1]), m[3]);
      else times.set(Number(m[1]), parseChapterTime(m[3]));
    }
  } catch {
    // A truncated block keeps what was read.
  }
  return [...times]
    .filter(([, t]) => Number.isFinite(t))
    .sort((a, b) => a[0] - b[0])
    .map(([n, seconds]) => ({ name: names.get(n) || `Chapter ${n}`, seconds }));
}

/** The "chpl" box (version 1) for markers whose starts are in frames at `rate`, or null. */
export function chplBox(markers = [], rate) {
  const list = sorted(markers, rate).slice(0, 255);
  if (!list.length) return null;
  const entries = list.map((c) => {
    const title = enc.encode(c.name).subarray(0, 255);
    const e = new Uint8Array(9 + title.length);
    new DataView(e.buffer).setBigUint64(0, BigInt(Math.round(c.seconds * 1e7)));
    e[8] = title.length;
    e.set(title, 9);
    return e;
  });
  const size = 8 + 4 + 4 + 1 + entries.reduce((n, e) => n + e.length, 0);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, size);
  out.set(enc.encode('chpl'), 4);
  dv.setUint32(8, 0x01000000); // version 1, no flags
  dv.setUint32(12, 0); // reserved
  out[16] = list.length;
  let o = 17;
  for (const e of entries) {
    out.set(e, o);
    o += e.length;
  }
  return out;
}

/** Chapters in the body of a "chpl" box (after its 8-byte header). */
export function chaptersFromChpl(body) {
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const version = body[0];
  let o = 4 + (version ? 4 : 0);
  const n = body[o++] ?? 0;
  const out = [];
  for (let i = 0; i < n && o + 9 <= body.length; i++) {
    const t = Number(dv.getBigUint64(o)) / 1e7;
    const len = body[o + 8];
    out.push({ name: utf8.decode(body.subarray(o + 9, o + 9 + len)) || `Chapter ${i + 1}`, seconds: t });
    o += 9 + len;
  }
  return out;
}

/**
 * ID3v2.3 chapter frames for markers whose starts are in frames at `rate`: a table of contents
 * (CTOC) and one CHAP per marker with its name in a TIT2 subframe. Each chapter ends where the
 * next starts (the last at `total` frames). Returns [{ id, body }].
 */
export function id3ChapterFrames(markers = [], rate, total) {
  const list = sorted(markers, rate).slice(0, 255);
  if (!list.length) return [];
  const ms = (s) => Math.max(0, Math.min(0xfffffffe, Math.round(s * 1000)));
  const end = Math.max(0, total / rate);
  const join = (parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };
  const u32 = (v) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0);
    return b;
  };
  const ids = list.map((_, i) => enc.encode(`chp${i}\0`));
  const toc = { id: 'CTOC', body: join([enc.encode('toc\0'), Uint8Array.of(0x03, list.length), ...ids]) };
  const chaps = list.map((c, i) => {
    const title = join([Uint8Array.of(3), enc.encode(c.name)]); // UTF-8 text
    const tit2 = join([enc.encode('TIT2'), u32(title.length), new Uint8Array(2), title]);
    const stop = i + 1 < list.length ? list[i + 1].seconds : Math.max(c.seconds, end);
    return { id: 'CHAP', body: join([ids[i], u32(ms(c.seconds)), u32(ms(stop)), u32(0xffffffff), u32(0xffffffff), tit2]) };
  });
  return [toc, ...chaps];
}

/** Chapters in an ID3v2 tag at the start of `b` (CHAP frames with their TIT2 names). */
export function id3Chapters(b) {
  if (b.length < 10 || latin1(b.subarray(0, 3)) !== 'ID3') return [];
  const version = b[3];
  const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
  const end = Math.min(b.length, 10 + size);
  // Frame sizes: plain in ID3v2.3, syncsafe in 2.4.
  const sizeIn = (x, o) => (version >= 4 ? ((x[o] & 0x7f) << 21) | ((x[o + 1] & 0x7f) << 14) | ((x[o + 2] & 0x7f) << 7) | (x[o + 3] & 0x7f) : new DataView(x.buffer, x.byteOffset + o, 4).getUint32(0));
  const frameSize = (o) => sizeIn(b, o);
  const text = (body) => {
    const e = body[0];
    const t = body.subarray(1);
    if (e === 3) return utf8.decode(t).replace(/\0+$/, '');
    if (e === 0) return latin1(t).replace(/\0+$/, '');
    // UTF-16 with or without a byte order mark.
    let le = e === 1;
    let s = t;
    if (s[0] === 0xff && s[1] === 0xfe) (le = true), (s = s.subarray(2));
    else if (s[0] === 0xfe && s[1] === 0xff) (le = false), (s = s.subarray(2));
    let out = '';
    for (let i = 0; i + 1 < s.length; i += 2) out += String.fromCharCode(le ? s[i] | (s[i + 1] << 8) : (s[i] << 8) | s[i + 1]);
    return out.replace(/\0+$/, '');
  };
  const out = [];
  let o = 10 + (b[5] & 0x40 ? 4 + frameSize(10) : 0);
  while (o + 10 <= end && b[o]) {
    const id = latin1(b.subarray(o, o + 4));
    const len = frameSize(o + 4);
    const body = b.subarray(o + 10, o + 10 + len);
    if (id === 'CHAP') {
      const z = body.indexOf(0);
      const dv = new DataView(body.buffer, body.byteOffset + z + 1, 16);
      const start = dv.getUint32(0) / 1000;
      let name = '';
      for (let p = z + 17; p + 10 <= body.length; ) {
        const sid = latin1(body.subarray(p, p + 4));
        const slen = sizeIn(body, p + 4);
        if (sid === 'TIT2') name = text(body.subarray(p + 10, p + 10 + slen));
        p += 10 + slen;
      }
      out.push({ name: name || `Chapter ${out.length + 1}`, seconds: start });
    }
    o += 10 + len;
  }
  return out.sort((a, c) => a.seconds - c.seconds);
}

function flacComment(b) {
  let o = 4;
  while (o + 4 <= b.length) {
    const last = b[o] & 0x80;
    const type = b[o] & 0x7f;
    const len = (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
    if (type === 4) return b.subarray(o + 4, o + 4 + len);
    if (last) break;
    o += 4 + len;
  }
  return null;
}

function oggComment(b) {
  // The second packet of the first logical stream is its comment header.
  const packets = [];
  let current = [];
  let o = 0;
  while (o + 27 <= b.length && packets.length < 2) {
    if (latin1(b.subarray(o, o + 4)) !== 'OggS') break;
    const segs = b[o + 26];
    let p = o + 27 + segs;
    for (let i = 0; i < segs && packets.length < 2; i++) {
      const len = b[o + 27 + i];
      current.push(b.subarray(p, p + len));
      p += len;
      if (len < 255) {
        const total = current.reduce((n, c) => n + c.length, 0);
        const pkt = new Uint8Array(total);
        let at = 0;
        for (const c of current) {
          pkt.set(c, at);
          at += c.length;
        }
        packets.push(pkt);
        current = [];
      }
    }
    o = p;
  }
  const pkt = packets[1];
  if (!pkt) return null;
  if (latin1(pkt.subarray(0, 8)) === 'OpusTags') return pkt.subarray(8);
  if (pkt[0] === 3 && latin1(pkt.subarray(1, 7)) === 'vorbis') return pkt.subarray(7);
  return null;
}

function mp4Chapters(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let found = [];
  const walk = (start, end) => {
    let o = start;
    while (o + 8 <= end && !found.length) {
      let size = dv.getUint32(o);
      const type = latin1(b.subarray(o + 4, o + 8));
      let head = 8;
      if (size === 1) {
        size = Number(dv.getBigUint64(o + 8));
        head = 16;
      } else if (size === 0) size = end - o;
      if (size < head || o + size > end) break;
      if (type === 'moov' || type === 'udta') walk(o + head, o + size);
      else if (type === 'chpl') found = chaptersFromChpl(b.subarray(o + head, o + size));
      o += size;
    }
  };
  walk(0, b.length);
  return found;
}

/** Chapters ({ name, seconds }) of a FLAC, Ogg or MP4 file. Never throws. */
export function readChapters(buffer) {
  try {
    const b = new Uint8Array(buffer);
    const head = latin1(b.subarray(0, 4));
    if (head === 'fLaC' || head === 'OggS') {
      const c = head === 'fLaC' ? flacComment(b.subarray(0, Math.min(b.length, 16 << 20))) : oggComment(b.subarray(0, Math.min(b.length, 4 << 20)));
      return c ? chaptersFromVorbis(c) : [];
    }
    if (latin1(b.subarray(4, 8)) === 'ftyp') return mp4Chapters(b);
    if (head.startsWith('ID3')) return id3Chapters(b);
  } catch {
    // Unreadable chapters never block opening the audio.
  }
  return [];
}
