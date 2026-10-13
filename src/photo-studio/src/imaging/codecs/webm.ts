// Minimal WebM (Matroska) writer for one video track of encoded VP8 or VP9
// frames and an optional Opus audio track, following the Matroska/EBML
// specifications (IETF RFC 8794 and draft-ietf-cellar-matroska) and the
// Opus-in-Matroska mapping: EBML header, Segment with Info, Tracks,
// Clusters of SimpleBlocks (both tracks interleaved in time order) and Cues
// for seeking. Timestamps are milliseconds.
import { CodecError } from './bytes';

export type WebmFrame = { data: Uint8Array; timestampMs: number; key: boolean };
/** An audio track: encoded Opus packets (every packet is a key frame). */
export type WebmAudio = {
  codec: 'A_OPUS';
  sampleRate: number;
  channels: number;
  // The Opus identification header ("OpusHead"); built when absent.
  codecPrivate?: Uint8Array;
  // Samples the decoder discards at the start (Opus pre-skip, 48 kHz).
  preSkip?: number;
  frames: WebmFrame[];
};
export type WebmOptions = {
  width: number;
  height: number;
  codec: 'V_VP8' | 'V_VP9';
  audio?: WebmAudio;
  // Total duration in milliseconds (defaults to the last timestamp).
  durationMs?: number;
  frameRate?: number;
  app?: string;
};

const ID = {
  EBML: 0x1a45dfa3, EBMLVersion: 0x4286, EBMLReadVersion: 0x42f7, EBMLMaxIDLength: 0x42f2, EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282, DocTypeVersion: 0x4287, DocTypeReadVersion: 0x4285,
  Segment: 0x18538067, Info: 0x1549a966, TimestampScale: 0x2ad7b1, Duration: 0x4489, MuxingApp: 0x4d80, WritingApp: 0x5741,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackUID: 0x73c5, TrackType: 0x83, FlagLacing: 0x9c, CodecID: 0x86,
  DefaultDuration: 0x23e383, Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba,
  CodecPrivate: 0x63a2, CodecDelay: 0x56aa, SeekPreRoll: 0x56bb, Audio: 0xe1, SamplingFrequency: 0xb5, Channels: 0x9f,
  Cluster: 0x1f43b675, Timestamp: 0xe7, SimpleBlock: 0xa3,
  Cues: 0x1c53bb6b, CuePoint: 0xbb, CueTime: 0xb3, CueTrackPositions: 0xb7, CueTrack: 0xf7, CueClusterPosition: 0xf1,
} as const;

function idBytes(id: number) {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 255);
  return out;
}
/** EBML variable-length size with the shortest encoding. */
export function vint(n: number): Uint8Array {
  for (let len = 1; len <= 8; len++) {
    // All-ones is reserved for "unknown size".
    if (n < 2 ** (7 * len) - 1) {
      const out = new Uint8Array(len);
      let v = n;
      for (let i = len - 1; i >= 0; i--) {
        out[i] = v & 255;
        v = Math.floor(v / 256);
      }
      out[0] |= 0x80 >> (len - 1);
      return out;
    }
  }
  throw new CodecError('EBML element is too large.');
}
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
function el(id: number, ...body: Uint8Array[]) {
  const data = concat(body);
  return concat([new Uint8Array(idBytes(id)), vint(data.length), data]);
}
function uint(id: number, v: number) {
  const bytes: number[] = [];
  for (let x = Math.max(0, Math.round(v)); bytes.length === 0 || x > 0; x = Math.floor(x / 256)) bytes.unshift(x & 255);
  return el(id, new Uint8Array(bytes));
}
const str = (id: number, s: string) => el(id, new TextEncoder().encode(s));
function float(id: number, v: number) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v);
  return el(id, b);
}

export function muxWebm(frames: WebmFrame[], opts: WebmOptions): Uint8Array {
  if (!frames.length) throw new CodecError('No video frames to write.');
  if (!frames[0].key) throw new CodecError('The first video frame must be a key frame.');
  const header = el(ID.EBML, uint(ID.EBMLVersion, 1), uint(ID.EBMLReadVersion, 1), uint(ID.EBMLMaxIDLength, 4), uint(ID.EBMLMaxSizeLength, 8), str(ID.DocType, 'webm'), uint(ID.DocTypeVersion, 4), uint(ID.DocTypeReadVersion, 2));
  const last = Math.max(frames.at(-1)!.timestampMs, opts.audio?.frames.at(-1)?.timestampMs ?? 0);
  const duration = opts.durationMs ?? last + (opts.frameRate ? 1000 / opts.frameRate : 0);
  const app = opts.app ?? 'Photo Studio';
  const info = el(ID.Info, uint(ID.TimestampScale, 1_000_000), float(ID.Duration, duration), str(ID.MuxingApp, app), str(ID.WritingApp, app));
  const track = el(
    ID.TrackEntry,
    uint(ID.TrackNumber, 1),
    uint(ID.TrackUID, 1),
    uint(ID.TrackType, 1),
    uint(ID.FlagLacing, 0),
    str(ID.CodecID, opts.codec),
    ...(opts.frameRate ? [uint(ID.DefaultDuration, 1e9 / opts.frameRate)] : []),
    el(ID.Video, uint(ID.PixelWidth, opts.width), uint(ID.PixelHeight, opts.height)),
  );
  const a = opts.audio;
  const audioTrack = a
    ? el(
        ID.TrackEntry,
        uint(ID.TrackNumber, 2),
        uint(ID.TrackUID, 2),
        uint(ID.TrackType, 2),
        uint(ID.FlagLacing, 0),
        str(ID.CodecID, a.codec),
        el(ID.CodecPrivate, a.codecPrivate ?? opusHead(a.channels, a.sampleRate, a.preSkip ?? 0)),
        uint(ID.CodecDelay, Math.round(((a.preSkip ?? 0) / 48000) * 1e9)),
        uint(ID.SeekPreRoll, 80_000_000),
        el(ID.Audio, float(ID.SamplingFrequency, a.sampleRate), uint(ID.Channels, a.channels)),
      )
    : undefined;
  const tracks = el(ID.Tracks, track, ...(audioTrack ? [audioTrack] : []));
  // Blocks of both tracks in time order (video first at equal times). A
  // cluster starts at every video key frame (so cues can point at it) and
  // before the int16 block timestamp would overflow.
  const blocks = [...frames.map((f) => ({ f, track: 1 })), ...(a?.frames ?? []).map((f) => ({ f, track: 2 }))];
  blocks.sort((x, y) => Math.round(x.f.timestampMs) - Math.round(y.f.timestampMs) || x.track - y.track);
  const clusters: { time: number; blocks: Uint8Array[] }[] = [];
  for (const { f, track: n } of blocks) {
    const cur = clusters.at(-1);
    const t = Math.round(f.timestampMs);
    if (!cur || (n === 1 && f.key) || t - cur.time > 32000) clusters.push({ time: t, blocks: [] });
    const c = clusters.at(-1)!;
    const head = new Uint8Array(4);
    head[0] = 0x80 | n;
    new DataView(head.buffer).setInt16(1, t - c.time);
    head[3] = f.key || n === 2 ? 0x80 : 0;
    c.blocks.push(el(ID.SimpleBlock, head, f.data));
  }
  const clusterBytes = clusters.map((c) => el(ID.Cluster, uint(ID.Timestamp, c.time), ...c.blocks));
  // Cue positions are relative to the start of the Segment's data.
  let pos = info.length + tracks.length;
  const cuePoints: Uint8Array[] = [];
  clusters.forEach((c, i) => {
    cuePoints.push(el(ID.CuePoint, uint(ID.CueTime, c.time), el(ID.CueTrackPositions, uint(ID.CueTrack, 1), uint(ID.CueClusterPosition, pos))));
    pos += clusterBytes[i].length;
  });
  const segment = el(ID.Segment, info, tracks, ...clusterBytes, el(ID.Cues, ...cuePoints));
  return concat([header, segment]);
}

/** The Opus identification header for channel mapping family 0 (mono or
 * stereo), as stored in Matroska CodecPrivate. */
export function opusHead(channels: number, inputRate: number, preSkip: number) {
  const b = new Uint8Array(19);
  b.set(new TextEncoder().encode('OpusHead'));
  const v = new DataView(b.buffer);
  b[8] = 1;
  b[9] = channels;
  v.setUint16(10, preSkip, true);
  v.setUint32(12, Math.round(inputRate), true);
  v.setInt16(16, 0, true);
  b[18] = 0;
  return b;
}
/** Pre-skip of an Opus identification header (0 when it is not one). */
export function opusPreSkip(head: Uint8Array | undefined) {
  if (!head || head.length < 19 || new TextDecoder().decode(head.subarray(0, 8)) !== 'OpusHead') return 0;
  return head[10] | (head[11] << 8);
}

// ----- Reading (structure only, for checks and tests) -----

export type EbmlNode = { id: number; size: number; offset: number; data: Uint8Array; children?: EbmlNode[] };
const masters = new Set<number>([ID.EBML, ID.Segment, ID.Info, ID.Tracks, ID.TrackEntry, ID.Video, ID.Audio, ID.Cluster, ID.Cues, ID.CuePoint, ID.CueTrackPositions]);
export function readEbml(bytes: Uint8Array, start = 0, end = bytes.length): EbmlNode[] {
  const out: EbmlNode[] = [];
  let p = start;
  const readVint = (keepMarker: boolean) => {
    const first = bytes[p];
    let len = 1;
    while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
    if (len > 8) throw new CodecError('Invalid EBML number.');
    let v = keepMarker ? first : first & (0xff >> len);
    for (let i = 1; i < len; i++) v = v * 256 + bytes[p + i];
    p += len;
    return v;
  };
  while (p < end) {
    const offset = p;
    const id = readVint(true);
    const size = readVint(false);
    const data = bytes.subarray(p, p + size);
    if (p + size > end) throw new CodecError('Truncated EBML element.');
    const node: EbmlNode = { id, size, offset, data };
    if (masters.has(id)) node.children = readEbml(bytes, p, p + size);
    out.push(node);
    p += size;
  }
  return out;
}
export const ebmlIds = ID;
