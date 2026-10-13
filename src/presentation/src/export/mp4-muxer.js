// An MP4 writer for one H.264 video track, as WebCodecs' VideoEncoder
// produces it in "avc" format (length-prefixed NAL units, with the decoder
// configuration record as `description`). The movie box comes before the
// media data so playback can start while the file downloads.
//
//   const mp4 = new Mp4Muxer({ width, height, avcC });
//   mp4.addFrame(bytes, timestampMs, isKey);
//   const bytes = mp4.finish(durationMs);

const TIMESCALE = 90000;

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
const u8 = (n) => Uint8Array.of(n & 0xff);
const u16 = (n) => Uint8Array.of((n >> 8) & 0xff, n & 0xff);
const u32 = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
};
const zeros = (n) => new Uint8Array(n);
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const box = (type, ...children) => {
  const body = concat(children);
  return concat([u32(body.length + 8), ascii(type), body]);
};
const fullBox = (type, version, flags, ...children) =>
  box(
    type,
    u8(version),
    Uint8Array.of((flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff),
    ...children,
  );
const MATRIX = concat(
  [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(u32),
);

export class Mp4Muxer {
  constructor({ width, height, avcC }) {
    this.width = width;
    this.height = height;
    this.avcC = new Uint8Array(avcC);
    this.frames = [];
  }
  addFrame(data, timestampMs, key) {
    this.frames.push({ data: new Uint8Array(data), time: timestampMs, key });
  }
  finish(durationMs) {
    const frames = [...this.frames].sort((a, b) => a.time - b.time);
    if (!frames.length) throw new Error("No video frames were encoded.");
    const ticks = (ms) => Math.round((ms * TIMESCALE) / 1000);
    const end = Math.max(durationMs || 0, frames.at(-1).time + 1);
    const deltas = frames.map((f, i) =>
      Math.max(
        1,
        ticks(i + 1 < frames.length ? frames[i + 1].time : end) - ticks(f.time),
      ),
    );
    const mediaDuration = deltas.reduce((a, b) => a + b, 0);
    const movieDuration = Math.round((mediaDuration / TIMESCALE) * 1000);
    // Runs of equal sample durations.
    const stts = [];
    for (const d of deltas) {
      const run = stts.at(-1);
      if (run && run[1] === d) run[0]++;
      else stts.push([1, d]);
    }
    const sync = frames.flatMap((f, i) => (f.key ? [i + 1] : []));
    const ftyp = box(
      "ftyp",
      ascii("isom"),
      u32(0x200),
      ascii("isom"),
      ascii("iso2"),
      ascii("avc1"),
      ascii("mp41"),
    );
    const moovFor = (chunkOffset) =>
      box(
        "moov",
        fullBox(
          "mvhd",
          0,
          0,
          u32(0),
          u32(0),
          u32(1000),
          u32(movieDuration),
          u32(0x00010000),
          u16(0x0100),
          zeros(10),
          MATRIX,
          zeros(24),
          u32(2),
        ),
        box(
          "trak",
          fullBox(
            "tkhd",
            0,
            3,
            u32(0),
            u32(0),
            u32(1),
            u32(0),
            u32(movieDuration),
            zeros(8),
            u16(0),
            u16(0),
            u16(0),
            u16(0),
            MATRIX,
            u32(this.width * 65536),
            u32(this.height * 65536),
          ),
          box(
            "mdia",
            fullBox(
              "mdhd",
              0,
              0,
              u32(0),
              u32(0),
              u32(TIMESCALE),
              u32(mediaDuration),
              u16(0x55c4), // "und"
              u16(0),
            ),
            fullBox(
              "hdlr",
              0,
              0,
              u32(0),
              ascii("vide"),
              zeros(12),
              ascii("VideoHandler\0"),
            ),
            box(
              "minf",
              fullBox("vmhd", 0, 1, zeros(8)),
              box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1))),
              box(
                "stbl",
                fullBox(
                  "stsd",
                  0,
                  0,
                  u32(1),
                  box(
                    "avc1",
                    zeros(6),
                    u16(1),
                    zeros(16),
                    u16(this.width),
                    u16(this.height),
                    u32(0x00480000),
                    u32(0x00480000),
                    u32(0),
                    u16(1),
                    zeros(32),
                    u16(0x0018),
                    u16(0xffff),
                    box("avcC", this.avcC),
                    box("pasp", u32(1), u32(1)),
                  ),
                ),
                fullBox(
                  "stts",
                  0,
                  0,
                  u32(stts.length),
                  ...stts.flatMap(([count, delta]) => [u32(count), u32(delta)]),
                ),
                fullBox("stss", 0, 0, u32(sync.length), ...sync.map(u32)),
                fullBox(
                  "stsc",
                  0,
                  0,
                  u32(1),
                  u32(1),
                  u32(frames.length),
                  u32(1),
                ),
                fullBox(
                  "stsz",
                  0,
                  0,
                  u32(0),
                  u32(frames.length),
                  ...frames.map((f) => u32(f.data.length)),
                ),
                fullBox("stco", 0, 0, u32(1), u32(chunkOffset)),
              ),
            ),
          ),
        ),
      );
    const mdatSize = frames.reduce((n, f) => n + f.data.length, 0) + 8;
    if (mdatSize > 0xffffffff)
      throw new Error("The video is too large for this exporter.");
    const moovLength = moovFor(0).length;
    const moov = moovFor(ftyp.length + moovLength + 8);
    return concat([
      ftyp,
      moov,
      u32(mdatSize),
      ascii("mdat"),
      ...frames.map((f) => f.data),
    ]);
  }
}
