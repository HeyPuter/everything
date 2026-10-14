// A WebM (Matroska) writer for one video track of VP8 or VP9 frames, as
// WebCodecs' VideoEncoder produces them. Frames are kept in memory and the
// file is written in one go, so every size is known: clusters start at each
// key frame, and cues point at them so players can seek.
//
//   const webm = new WebmMuxer({ codec: "V_VP9", width, height });
//   webm.addFrame(bytes, timestampMs, isKey);
//   const blobParts = webm.finish(durationMs);

const ids = {
  EBML: 0x1a45dfa3,
  EBMLVersion: 0x4286,
  EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  FlagLacing: 0x9c,
  CodecID: 0x86,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
};

const concat = (parts) => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

function idBytes(id) {
  const out = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return Uint8Array.from(out);
}

// EBML variable-length size, in the fewest bytes.
export function vint(n) {
  for (let len = 1; len <= 8; len++) {
    if (n < 2 ** (7 * len) - 1) {
      const out = new Uint8Array(len);
      let v = n;
      for (let i = len - 1; i >= 0; i--) {
        out[i] = v % 256;
        v = Math.floor(v / 256);
      }
      out[0] |= 1 << (8 - len);
      return out;
    }
  }
  throw new RangeError("element too large");
}

function uint(n) {
  const out = [];
  let v = Math.max(0, Math.round(n));
  do {
    out.unshift(v % 256);
    v = Math.floor(v / 256);
  } while (v > 0);
  return Uint8Array.from(out);
}

const element = (id, data) => concat([idBytes(id), vint(data.length), data]);
const master = (id, ...children) => element(id, concat(children));
const u = (id, n) => element(id, uint(n));
const str = (id, s) => element(id, new TextEncoder().encode(s));
const f64 = (id, n) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, n);
  return element(id, b);
};

export class WebmMuxer {
  constructor({ codec = "V_VP9", width, height, app = "Presentation" }) {
    this.codec = codec;
    this.width = width;
    this.height = height;
    this.app = app;
    this.frames = [];
  }
  addFrame(data, timestampMs, key) {
    this.frames.push({ data: new Uint8Array(data), time: timestampMs, key });
  }
  finish(durationMs) {
    const frames = [...this.frames].sort((a, b) => a.time - b.time);
    const header = master(
      ids.EBML,
      u(ids.EBMLVersion, 1),
      u(ids.EBMLReadVersion, 1),
      u(ids.EBMLMaxIDLength, 4),
      u(ids.EBMLMaxSizeLength, 8),
      str(ids.DocType, "webm"),
      u(ids.DocTypeVersion, 4),
      u(ids.DocTypeReadVersion, 2),
    );
    const last = frames.at(-1);
    const duration = Math.max(durationMs || 0, last ? last.time + 1 : 0);
    const info = master(
      ids.Info,
      u(ids.TimecodeScale, 1_000_000),
      f64(ids.Duration, duration),
      str(ids.MuxingApp, this.app),
      str(ids.WritingApp, this.app),
    );
    const tracks = master(
      ids.Tracks,
      master(
        ids.TrackEntry,
        u(ids.TrackNumber, 1),
        u(ids.TrackUID, 1),
        u(ids.TrackType, 1),
        u(ids.FlagLacing, 0),
        str(ids.CodecID, this.codec),
        master(
          ids.Video,
          u(ids.PixelWidth, this.width),
          u(ids.PixelHeight, this.height),
        ),
      ),
    );
    // Clusters: a new one at each key frame, and before a block's time
    // relative to its cluster would overflow 16 bits.
    const clusters = [];
    let current = null;
    frames.forEach((frame, i) => {
      if (!current || frame.key || frame.time - current.time > 30000)
        clusters.push((current = { time: frame.time, blocks: [] }));
      const relative = frame.time - current.time;
      const head = new Uint8Array(4);
      head[0] = 0x81; // track 1
      new DataView(head.buffer).setInt16(1, relative);
      if (i === frames.length - 1) {
        // The last frame says how long it shows, so the file's length is
        // the presentation's rather than its last frame's start.
        head[3] = 0;
        current.blocks.push(
          master(
            ids.BlockGroup,
            element(ids.Block, concat([head, frame.data])),
            u(ids.BlockDuration, Math.max(1, duration - frame.time)),
          ),
        );
      } else {
        head[3] = frame.key ? 0x80 : 0;
        current.blocks.push(
          element(ids.SimpleBlock, concat([head, frame.data])),
        );
      }
    });
    const clusterBytes = clusters.map((c) =>
      master(ids.Cluster, u(ids.Timecode, c.time), ...c.blocks),
    );
    // Cues sit before the clusters; their positions are measured from the
    // start of the segment's data, and their own size depends on those
    // positions, so settle it in two passes.
    const cuesFor = (offset) => {
      let at = offset;
      const points = clusters.map((c, i) => {
        const point = master(
          ids.CuePoint,
          u(ids.CueTime, c.time),
          master(
            ids.CueTrackPositions,
            u(ids.CueTrack, 1),
            u(ids.CueClusterPosition, at),
          ),
        );
        at += clusterBytes[i].length;
        return point;
      });
      return master(ids.Cues, ...points);
    };
    const before = info.length + tracks.length;
    let cues = cuesFor(before);
    for (let pass = 0; pass < 3; pass++) {
      const next = cuesFor(before + cues.length);
      if (next.length === cues.length) {
        cues = next;
        break;
      }
      cues = next;
    }
    const body = concat([info, tracks, cues, ...clusterBytes]);
    const segment = concat([idBytes(ids.Segment), vint(body.length), body]);
    return concat([header, segment]);
  }
}
