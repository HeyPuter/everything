import { describe, expect, it } from 'vitest';
import { ApngWriter, decodeApng, encodeApng, isApng } from '../src/imaging/codecs/apng';
import { decodeGif, encodeGif } from '../src/imaging/codecs/gif';
import { readPngChunks, verifyPngCrcs } from '../src/imaging/codecs/png-chunks';
import { muxAnimatedWebp, readAnimatedWebp, stillBitstream } from '../src/imaging/codecs/webp-anim';
import { ebmlIds, muxWebm, readEbml, vint, type EbmlNode } from '../src/imaging/codecs/webm';
import { gifLoop } from '../src/model/animation';
import type { RGBA8 } from '../src/imaging/types';

/** A frame with a colored square at (x, y) over a background. */
function frame(w: number, h: number, x: number, y: number, color: number[], bg = [20, 40, 60, 255]): RGBA8 {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) data.set(i >= x && i < x + 6 && j >= y && j < y + 6 ? color : bg, (j * w + i) * 4);
  return { width: w, height: h, data };
}
const frames = [frame(32, 24, 2, 2, [255, 0, 0, 255]), frame(32, 24, 12, 8, [0, 255, 0, 255]), frame(32, 24, 22, 14, [0, 0, 255, 255])];

describe('animated GIF', () => {
  it('round-trips frames, delays and the loop count', () => {
    const bytes = encodeGif(frames.map((rgba, i) => ({ rgba, delayMs: [100, 250, 1000][i] })), { loop: gifLoop(3), palette: 'local' });
    const d = decodeGif(bytes);
    expect(d.frames).toHaveLength(3);
    expect(d.frames.map((f) => f.delayMs)).toEqual([100, 250, 1000]);
    expect(d.loopCount).toBe(2);
    d.frames.forEach((f, i) => expect(Array.from(f.rgba.data)).toEqual(Array.from(frames[i].data)));
    // Later frames are cropped to what changed.
    expect(d.frames[1].rect.width).toBeLessThan(32);
  });
  it('plays once without a looping extension and forever with count 0', () => {
    expect(decodeGif(encodeGif(frames.map((rgba) => ({ rgba })), { loop: gifLoop(1) })).loopCount).toBeUndefined();
    expect(decodeGif(encodeGif(frames.map((rgba) => ({ rgba })), { loop: gifLoop(0) })).loopCount).toBe(0);
  });
});

describe('APNG', () => {
  it('round-trips opaque frames as RGB with cropped later frames', () => {
    const bytes = encodeApng(frames.map((rgba, i) => ({ rgba, delayMs: (i + 1) * 100 })), { plays: 2 });
    expect(verifyPngCrcs(bytes)).toBe(true);
    expect(isApng(bytes)).toBe(true);
    const chunks = readPngChunks(bytes);
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT', 'fcTL', 'fdAT', 'IEND']);
    expect(chunks[0].data[9]).toBe(2);
    const d = decodeApng(bytes);
    expect(d.plays).toBe(2);
    expect(d.frames.map((f) => f.delayMs)).toEqual([100, 200, 300]);
    expect(d.frames[1].rect).toEqual({ x: 2, y: 2, width: 16, height: 12 });
    d.frames.forEach((f, i) => expect(Array.from(f.rgba.data)).toEqual(Array.from(frames[i].data)));
    // Sequence numbers run across fcTL and fdAT chunks.
    const seq = chunks.filter((c) => c.type === 'fcTL' || c.type === 'fdAT').map((c) => new DataView(c.data.buffer, c.data.byteOffset).getUint32(0));
    expect(seq).toEqual([0, 1, 2, 3, 4]);
  });
  it('keeps transparency and long delays', () => {
    const clear = [frame(10, 10, 0, 0, [9, 9, 9, 128], [0, 0, 0, 0]), frame(10, 10, 4, 4, [200, 100, 50, 255], [0, 0, 0, 0])];
    const d = decodeApng(encodeApng(clear.map((rgba) => ({ rgba, delayMs: 70_000 }))));
    expect(d.plays).toBe(0);
    expect(d.frames[0].delayMs).toBe(70_000);
    d.frames.forEach((f, i) => expect(Array.from(f.rgba.data)).toEqual(Array.from(clear[i].data)));
  });
  it('encodes one frame at a time, switching to alpha when a later frame is transparent', () => {
    // Exports add frames as they render; frames stored as RGB before the
    // first transparent one are stored again with alpha, exactly as if the
    // whole animation had been seen first.
    const late = [...frames, frame(32, 24, 5, 5, [10, 200, 10, 90])];
    const writer = new ApngWriter({ plays: 1 });
    for (const rgba of late) writer.add({ rgba, delayMs: 40 });
    const bytes = writer.finish();
    expect(verifyPngCrcs(bytes)).toBe(true);
    expect(readPngChunks(bytes)[0].data[9]).toBe(6);
    const d = decodeApng(bytes);
    expect(d.frames).toHaveLength(4);
    d.frames.forEach((f, i) => expect(Array.from(f.rgba.data)).toEqual(Array.from(late[i].data)));
    expect(d.frames[1].rect).toEqual({ x: 2, y: 2, width: 16, height: 12 });
    // Opaque frames alone stay RGB, and the writer matches encodeApng.
    const opaque = new ApngWriter({ plays: 2 });
    frames.forEach((rgba, i) => opaque.add({ rgba, delayMs: (i + 1) * 100 }));
    const whole = encodeApng(
      frames.map((rgba, i) => ({ rgba, delayMs: (i + 1) * 100 })),
      { plays: 2 },
    );
    expect(Array.from(opaque.finish())).toEqual(Array.from(whole));
  });
  it('is not mistaken for a still PNG and rejects bad input', () => {
    expect(isApng(new Uint8Array([1, 2, 3]))).toBe(false);
    expect(() => encodeApng([])).toThrow();
    expect(() => encodeApng([{ rgba: frames[0], delayMs: 1 }, { rgba: frame(8, 8, 0, 0, [0, 0, 0, 255]), delayMs: 1 }])).toThrow();
  });
});

// A still WebP built from raw chunks; the muxer copies bitstreams unchanged.
function stillWebp(chunks: [string, number[]][]) {
  const parts: number[] = [];
  for (const [fourcc, data] of chunks) {
    parts.push(...[...fourcc].map((c) => c.charCodeAt(0)), data.length & 255, (data.length >> 8) & 255, 0, 0, ...data);
    if (data.length & 1) parts.push(0);
  }
  const size = 4 + parts.length;
  return new Uint8Array([...'RIFF'].map((c) => c.charCodeAt(0)).concat([size & 255, size >> 8, 0, 0], [...'WEBP'].map((c) => c.charCodeAt(0)), parts));
}

describe('animated WebP container', () => {
  it('wraps still bitstreams into ANMF frames', () => {
    const lossy = stillWebp([['VP8 ', [1, 2, 3, 4, 5]]]);
    const alpha = stillWebp([['VP8X', [0x10, 0, 0, 0, 3, 0, 0, 3, 0, 0]], ['ALPH', [7, 7]], ['VP8 ', [9, 9, 9]]]);
    expect(stillBitstream(alpha).map((c) => c.fourcc)).toEqual(['ALPH', 'VP8 ']);
    const bytes = muxAnimatedWebp(
      [
        { webp: lossy, width: 4, height: 4, delayMs: 120 },
        { webp: alpha, x: 2, y: 4, width: 2, height: 2, delayMs: 40, blend: false, dispose: true },
      ],
      { width: 4, height: 8, plays: 3, background: [10, 20, 30, 255] },
    );
    expect(new DataView(bytes.buffer).getUint32(4, true)).toBe(bytes.length - 8);
    const info = readAnimatedWebp(bytes);
    expect(info).toMatchObject({ width: 4, height: 8, plays: 3, background: [10, 20, 30, 255] });
    expect(info.frames).toEqual([
      { x: 0, y: 0, width: 4, height: 4, delayMs: 120, blend: true, dispose: false, chunks: ['VP8 '] },
      { x: 2, y: 4, width: 2, height: 2, delayMs: 40, blend: false, dispose: true, chunks: ['ALPH', 'VP8 '] },
    ]);
    // The alpha flag is set because a frame has an ALPH chunk.
    expect(bytes[20] & 0x10).toBe(0x10);
  });
  it('rejects odd offsets and frames outside the canvas', () => {
    const still = stillWebp([['VP8L', [0x2f, 0, 0, 0, 0]]]);
    expect(() => muxAnimatedWebp([{ webp: still, x: 1, width: 1, height: 1, delayMs: 1 }], { width: 4, height: 4 })).toThrow();
    expect(() => muxAnimatedWebp([{ webp: still, width: 5, height: 1, delayMs: 1 }], { width: 4, height: 4 })).toThrow();
  });
});

describe('WebM writer', () => {
  const find = (nodes: EbmlNode[], id: number) => nodes.find((n) => n.id === id)!;
  const uintOf = (n: EbmlNode) => n.data.reduce((v, b) => v * 256 + b, 0);
  it('encodes EBML sizes in the shortest form', () => {
    expect(Array.from(vint(5))).toEqual([0x85]);
    expect(Array.from(vint(127))).toEqual([0x40, 0x7f]);
    expect(Array.from(vint(300))).toEqual([0x41, 0x2c]);
  });
  it('writes a track, clusters at key frames and cues pointing at them', () => {
    const chunk = (n: number) => new Uint8Array(n).fill(n);
    const vf = [
      { data: chunk(10), timestampMs: 0, key: true },
      { data: chunk(4), timestampMs: 40, key: false },
      { data: chunk(12), timestampMs: 80, key: true },
      { data: chunk(3), timestampMs: 120, key: false },
    ];
    const bytes = muxWebm(vf, { width: 64, height: 48, codec: 'V_VP9', frameRate: 25 });
    const [ebml, segment] = readEbml(bytes);
    expect(new TextDecoder().decode(find(ebml.children!, ebmlIds.DocType).data)).toBe('webm');
    const seg = segment.children!;
    const info = find(seg, ebmlIds.Info);
    expect(new DataView(find(info.children!, ebmlIds.Duration).data.buffer, find(info.children!, ebmlIds.Duration).data.byteOffset).getFloat64(0)).toBe(160);
    const entry = find(find(seg, ebmlIds.Tracks).children!, ebmlIds.TrackEntry);
    expect(new TextDecoder().decode(find(entry.children!, ebmlIds.CodecID).data)).toBe('V_VP9');
    const video = find(entry.children!, ebmlIds.Video).children!;
    expect([uintOf(find(video, ebmlIds.PixelWidth)), uintOf(find(video, ebmlIds.PixelHeight))]).toEqual([64, 48]);
    const clusters = seg.filter((n) => n.id === ebmlIds.Cluster);
    expect(clusters.map((c) => uintOf(find(c.children!, ebmlIds.Timestamp)))).toEqual([0, 80]);
    const blocks = clusters.flatMap((c) => c.children!.filter((n) => n.id === ebmlIds.SimpleBlock));
    expect(blocks.map((b) => [b.data[0], new DataView(b.data.buffer, b.data.byteOffset).getInt16(1), b.data[3], b.data.length - 4])).toEqual([
      [0x81, 0, 0x80, 10],
      [0x81, 40, 0, 4],
      [0x81, 0, 0x80, 12],
      [0x81, 40, 0, 3],
    ]);
    // Cue positions are offsets of the clusters from the segment data start.
    const dataStart = segment.offset + 4 + vint(segment.size).length;
    const cues = find(seg, ebmlIds.Cues).children!.map((p) => uintOf(find(find(p.children!, ebmlIds.CueTrackPositions).children!, ebmlIds.CueClusterPosition)));
    expect(cues).toEqual(clusters.map((c) => c.offset - dataStart));
  });
  it('requires a key frame first', () => {
    expect(() => muxWebm([{ data: new Uint8Array(1), timestampMs: 0, key: false }], { width: 2, height: 2, codec: 'V_VP8' })).toThrow();
  });
});
