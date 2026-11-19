// Ogg Opus muxer (RFC 3533 pages, RFC 7845 Opus mapping). Packets come from
// the WebCodecs Opus encoder; this file only frames them.

import { ascii, concatBytes } from './sink.js';
import { vorbisComment } from '../audio/meta.js';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

export function oggCrc(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 255]) >>> 0;
  return crc >>> 0;
}

/**
 * Builds one Ogg page. `segments` are lacing values; `body` the concatenated
 * segment data. `granule` -1 means no packet ends on this page.
 */
export function oggPage({ serial, sequence, granule, flags, segments, body }) {
  const head = new Uint8Array(27 + segments.length);
  const dv = new DataView(head.buffer);
  head.set(ascii('OggS'));
  head[4] = 0;
  head[5] = flags;
  dv.setBigInt64(6, BigInt(granule), true);
  dv.setUint32(14, serial, true);
  dv.setUint32(18, sequence, true);
  head[26] = segments.length;
  head.set(segments, 27);
  const page = concatBytes([head, body]);
  new DataView(page.buffer).setUint32(22, oggCrc(page), true);
  return page;
}

export function opusHead({ channels, preSkip = 312, inputRate = 48000 }) {
  const b = new Uint8Array(19);
  const dv = new DataView(b.buffer);
  b.set(ascii('OpusHead'));
  b[8] = 1;
  b[9] = channels;
  dv.setUint16(10, preSkip, true);
  dv.setUint32(12, inputRate, true);
  dv.setInt16(16, 0, true);
  b[18] = 0; // mapping family 0: mono or stereo
  return b;
}

/**
 * Muxes Opus packets into an Ogg stream.
 * @param {{ channels, preSkip, inputRate, packets: { data: Uint8Array, samples: number }[], totalSamples, meta, serial? }} o
 *   samples are per packet at 48 kHz; totalSamples is the real audio length at 48 kHz (end trimming).
 * @returns {Uint8Array[]} pages
 */
export function muxOggOpus({ channels, preSkip = 312, inputRate = 48000, packets, totalSamples, meta = {}, chapters = [], serial = 0x41534f50 }) {
  const pages = [];
  let sequence = 0;
  pages.push(oggPage({ serial, sequence: sequence++, granule: 0, flags: 0x02, segments: [19], body: opusHead({ channels, preSkip, inputRate }) }));
  const tags = concatBytes([ascii('OpusTags'), vorbisComment(meta, 'Audio Studio', chapters)]);
  pushPacketPages(pages, tags, () => sequence++, serial, 0, false);
  // Audio: group packets into pages of about 4 KB (or 255 lacing values).
  // Granules count every decoded sample, pre-skip included (RFC 7845 4.1),
  // so a stream starting at zero ends at pre-skip + real length.
  const finalGranule = preSkip + totalSamples;
  let granule = 0;
  let segs = [];
  let parts = [];
  let size = 0;
  let pageGranule = -1;
  const flush = (last) => {
    if (!segs.length && !last) return;
    pages.push(oggPage({ serial, sequence: sequence++, granule: last ? finalGranule : pageGranule, flags: last ? 0x04 : 0, segments: segs, body: concatBytes(parts) }));
    segs = [];
    parts = [];
    size = 0;
    pageGranule = -1;
  };
  packets.forEach((p, i) => {
    const lacing = laceValues(p.data.length);
    if (segs.length + lacing.length > 255 || size > 4096) flush(false);
    segs.push(...lacing);
    parts.push(p.data);
    size += p.data.length;
    granule += p.samples;
    pageGranule = Math.min(granule, finalGranule);
    if (i === packets.length - 1) flush(true);
  });
  if (!packets.length) flush(true);
  return pages;
}

function laceValues(len) {
  const out = [];
  for (let n = len; ; n -= 255) {
    if (n >= 255) out.push(255);
    else {
      out.push(n);
      break;
    }
  }
  return out;
}

/** Writes one (possibly long) packet across pages with continuation flags. */
function pushPacketPages(pages, data, nextSeq, serial, granule, bos) {
  const lacing = laceValues(data.length);
  let off = 0;
  let first = true;
  for (let i = 0; i < lacing.length; i += 255) {
    const segs = lacing.slice(i, i + 255);
    const bytes = segs.reduce((s, v) => s + v, 0);
    const done = i + 255 >= lacing.length;
    pages.push(oggPage({ serial, sequence: nextSeq(), granule: done ? granule : -1, flags: (first ? 0 : 0x01) | (bos && first ? 0x02 : 0), segments: segs, body: data.subarray(off, off + bytes) }));
    off += bytes;
    first = false;
  }
}
