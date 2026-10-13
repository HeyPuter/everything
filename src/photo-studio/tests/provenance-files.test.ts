// Provenance in image files: XMP packets and signed C2PA manifests attached
// to PNG, JPEG, WebP and TIFF exports, read back and checked for changes.
import { beforeAll, describe, expect, it } from 'vitest';
import { attachProvenance, createSigner, inspectProvenance, provenanceFormat, type ProvenanceSigner } from '../src/imaging/provenance';
import { readStore, readXmpPacket, writeXmpPacket } from '../src/imaging/provenance/containers';
import { pixelHash } from '../src/imaging/provenance/hash';
import { buildXmpPacket, parseXmpPacket } from '../src/imaging/provenance/xmp';
import { encodePng } from '../src/features/files/png';
import { buildPng, insertPngChunks, makeTextChunk, readPngChunks, readPngText } from '../src/imaging/codecs/png-chunks';
import { readJpegSegments } from '../src/imaging/codecs/jpeg-markers';
import { readWebpChunks } from '../src/imaging/codecs/webp-anim';
import { decodeTiff, encodeTiff } from '../src/imaging/codecs/tiff';
import { addStep } from '../src/model/provenance';
import { NOW, sampleRecord } from './provenance-fixtures';

let signer: ProvenanceSigner;
beforeAll(async () => {
  signer = await createSigner('Photo Studio test key', NOW);
});

function rgba(w: number, h: number, seed = 0) {
  const d = new Uint8Array(w * h * 4);
  for (let i = 0; i < d.length; i++) d[i] = (i * 37 + seed) & 255;
  return d;
}
const png = (level = 6, seed = 0) => encodePng({ width: 5, height: 4, data: rgba(5, 4, seed), channels: 4 }, { level });
const hex = (h: string) => Uint8Array.from(h.replace(/\s+/g, '').match(/../g)!, (x) => parseInt(x, 16));
// A structurally valid baseline JPEG (it is never decoded here).
const jpeg = () =>
  hex(
    'ffd8' +
      'ffe000104a46494600010100000100010000' +
      'ffdb004300' + '01'.repeat(64) +
      'ffc0000b080008000801011100' +
      'ffc4001400' + '01' + '00'.repeat(15) + '00' +
      'ffda000801010000 3f00' +
      '1234ff0056ffd0789a' +
      'ffd9',
  );
// A still lossless WebP: 'VP8L' signature 0x2f, 14-bit width-1 and height-1,
// alpha bit, then (opaque here) bitstream bytes.
function webp(alpha = false) {
  const v = 2 | (1 << 14) | ((alpha ? 1 : 0) << 28);
  const vp8l = Uint8Array.of(0x2f, v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255, 9, 8, 7);
  const out = new Uint8Array(12 + 8 + vp8l.length);
  const dv = new DataView(out.buffer);
  out.set(new TextEncoder().encode('RIFF'));
  dv.setUint32(4, out.length - 8, true);
  out.set(new TextEncoder().encode('WEBPVP8L'), 8);
  dv.setUint32(16, vp8l.length, true);
  out.set(vp8l, 20);
  return out;
}
const tiff = () => encodeTiff({ width: 3, height: 2, data: rgba(3, 2), channels: 4 }, { compression: 'lzw', predictor: true });
const opts = () => ({ title: 'Kite', signer, now: NOW });

describe('pixel hashes', () => {
  it('follow the image data, not its compression or metadata', async () => {
    const a = await pixelHash(png(1), 'png');
    expect(a.method).toBe('png-samples-v1');
    expect(a.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((await pixelHash(png(9), 'png')).hash).toBe(a.hash);
    expect((await pixelHash(insertPngChunks(png(), [makeTextChunk('Comment', 'hello')]), 'png')).hash).toBe(a.hash);
    expect((await pixelHash(png(6, 1), 'png')).hash).not.toBe(a.hash);
    const j = await pixelHash(jpeg(), 'jpeg');
    expect(j.method).toBe('jpeg-scan-v1');
    const changed = jpeg();
    changed[changed.length - 6] ^= 1;
    expect((await pixelHash(changed, 'jpeg')).hash).not.toBe(j.hash);
    expect((await pixelHash(webp(), 'webp')).method).toBe('webp-bitstream-v1');
    expect((await pixelHash(tiff(), 'tiff')).method).toBe('tiff-samples-v1');
  });
});

describe('XMP packet', () => {
  it('round trips its fields and escapes markup', () => {
    const record = sampleRecord();
    record.steps[0].label = 'A <b>&"quoted"</b> step';
    const packet = buildXmpPacket({ format: 'png', title: 'Fish & <Chips>', pixelHash: 'sha256:00', pixelHashMethod: 'png-samples-v1', record, manifest: { a: '</pstudio:manifest>' } });
    expect(packet.startsWith('<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>')).toBe(true);
    expect(packet.endsWith('<?xpacket end="r"?>')).toBe(true);
    const x = parseXmpPacket(packet);
    expect(x).toMatchObject({ format: 'image/png', title: 'Fish & <Chips>', pixelHash: 'sha256:00', pixelHashMethod: 'png-samples-v1', manifest: { a: '</pstudio:manifest>' }, errors: [] });
    expect(x.record).toEqual(record);
  });
  it('sits where the XMP specification puts it, so other XMP readers find it', async () => {
    const packet = buildXmpPacket({ format: 'png', title: 'Kite', pixelHash: 'sha256:00', pixelHashMethod: 'png-samples-v1', record: sampleRecord() });
    // PNG: an uncompressed iTXt chunk with the standard XMP keyword.
    const p = writeXmpPacket(await png(), 'png', packet);
    expect(readPngText(p)['XML:com.adobe.xmp']).toBe(packet);
    // JPEG: an APP1 segment starting with the standard XMP namespace identifier.
    const j = writeXmpPacket(jpeg(), 'jpeg', packet);
    const id = new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0');
    const app1 = readJpegSegments(j).segments.filter((x) => x.marker === 0xe1 && id.every((v, i) => x.data[i] === v));
    expect(app1).toHaveLength(1);
    expect(new TextDecoder().decode(app1[0].data.subarray(id.length))).toBe(packet);
    // Writing again replaces the packet rather than adding a second one.
    expect(readJpegSegments(writeXmpPacket(j, 'jpeg', packet)).segments.filter((x) => x.marker === 0xe1)).toHaveLength(1);
  });
});

describe('attach and inspect', () => {
  it('PNG: XMP and a signed C2PA store that verify', async () => {
    const src = png();
    const out = await attachProvenance(src, 'png', sampleRecord(), opts());
    expect(out.signed).toBe(true);
    expect(out.pixelHash).toBe((await pixelHash(src, 'png')).hash);
    const chunks = readPngChunks(out.bytes);
    // caBX right after IHDR, as the C2PA specification places it.
    expect(chunks.map((c) => c.type).slice(0, 2)).toEqual(['IHDR', 'caBX']);
    const r = await inspectProvenance(out.bytes);
    expect(r.errors).toEqual([]);
    expect(r.format).toBe('png');
    expect(r.xmp).toMatchObject({ pixelHashMatches: true, title: 'Kite', recordedPixelHash: out.pixelHash });
    expect(r.xmp!.record).toEqual(sampleRecord());
    expect((r.xmp!.manifest as { 'pstudio:editCount': number })['pstudio:editCount']).toBe(3);
    const m = r.c2pa!.manifests[0];
    expect(m.errors).toEqual([]);
    expect(m).toMatchObject({ dataHashValid: true, assertionHashesValid: true, format: 'image/png', title: 'Kite' });
    expect(m.signature).toMatchObject({ valid: true, selfSigned: true });
    // The exclusion is exactly the caBX chunk.
    const loc = readStore(out.bytes, 'png')!;
    expect(loc.start).toBe(33);
  });
  it('PNG: re-attaching replaces the earlier provenance', async () => {
    const once = (await attachProvenance(png(), 'png', sampleRecord(), opts())).bytes;
    const record = sampleRecord();
    addStep(record, { label: 'Crop', command: 'image.crop', when: '2026-01-02T04:00:00.000Z' });
    const twice = (await attachProvenance(once, 'png', record, opts())).bytes;
    const types = readPngChunks(twice).map((c) => c.type);
    expect(types.filter((t) => t === 'caBX')).toHaveLength(1);
    expect(types.filter((t) => t === 'iTXt')).toHaveLength(1);
    const r = await inspectProvenance(twice);
    expect(r.errors).toEqual([]);
    expect(r.xmp!.record!.steps.at(-1)!.label).toBe('Crop');
    expect(r.c2pa!.manifests[0].dataHashValid).toBe(true);
  });
  it('PNG: metadata edits break the signature binding but not the pixel hash; pixel edits break both', async () => {
    const out = (await attachProvenance(png(), 'png', sampleRecord(), opts())).bytes;
    const commented = insertPngChunks(out, [makeTextChunk('Comment', 'edited elsewhere')]);
    let r = await inspectProvenance(commented);
    expect(r.xmp!.pixelHashMatches).toBe(true);
    expect(r.c2pa!.manifests[0].dataHashValid).toBe(false);
    expect(r.c2pa!.manifests[0].signature.valid).toBe(true);
    // Same pixels recompressed: still the same image.
    const other = readPngChunks(png(9)).find((c) => c.type === 'IDAT')!.data;
    const recompressed = buildPng(readPngChunks(out).map((c) => (c.type === 'IDAT' ? { type: 'IDAT', data: other } : c)));
    r = await inspectProvenance(recompressed);
    expect(r.xmp!.pixelHashMatches).toBe(true);
    // Different pixels.
    const changed = readPngChunks(png(6, 3)).find((c) => c.type === 'IDAT')!.data;
    const edited = buildPng(readPngChunks(out).map((c) => (c.type === 'IDAT' ? { type: 'IDAT', data: changed } : c)));
    r = await inspectProvenance(edited);
    expect(r.xmp!.pixelHashMatches).toBe(false);
    expect(r.c2pa!.manifests[0].dataHashValid).toBe(false);
  });
  it('PNG: without a signer only XMP is written', async () => {
    const out = await attachProvenance(png(), 'png', sampleRecord(), { title: 'Kite', now: NOW });
    expect(out.signed).toBe(false);
    const r = await inspectProvenance(out.bytes);
    expect(r.c2pa).toBeUndefined();
    expect(r.xmp!.pixelHashMatches).toBe(true);
  });
  it('JPEG: APP1 packet and APP11 store, across several segments for long records', async () => {
    const record = sampleRecord();
    for (let i = 0; i < 4000; i++) addStep(record, { label: `Step ${i} ${'x'.repeat(20)}`, command: `cmd.${i % 7}`, when: new Date(NOW.getTime() + i * 1000).toISOString() });
    const out = await attachProvenance(jpeg(), 'jpeg', record, opts());
    expect(out.signed).toBe(true);
    const segs = readJpegSegments(out.bytes).segments;
    const app11 = segs.filter((s) => s.marker === 0xeb);
    expect(app11.length).toBeGreaterThan(1);
    // CI "JP", one box instance, sequence numbers 1..n.
    expect(app11.map((s) => new DataView(s.data.buffer, s.data.byteOffset).getUint32(4))).toEqual(app11.map((_, i) => i + 1));
    expect(segs.map((s) => s.marker).slice(0, 4)).toEqual([0xd8, 0xe0, 0xe1, 0xeb]);
    const r = await inspectProvenance(out.bytes);
    expect(r.errors).toEqual([]);
    expect(r.xmp!.pixelHashMatches).toBe(true);
    // The packet had to shed the full record to fit one segment.
    expect(r.xmp!.record).toBeUndefined();
    expect((r.xmp!.manifest as { 'pstudio:stepsOmitted'?: number })['pstudio:stepsOmitted']).toBeGreaterThan(0);
    const m = r.c2pa!.manifests[0];
    expect(m).toMatchObject({ dataHashValid: true, assertionHashesValid: true });
    expect(m.signature.valid).toBe(true);
    expect((m.record as { steps: unknown[] }).steps).toHaveLength(record.steps.length);
    // Re-attaching keeps one store.
    const again = await attachProvenance(out.bytes, 'jpeg', sampleRecord(), opts());
    const r2 = await inspectProvenance(again.bytes);
    expect(r2.c2pa!.manifests).toHaveLength(1);
    expect(r2.c2pa!.manifests[0].dataHashValid).toBe(true);
    expect(readJpegSegments(again.bytes).segments.filter((s) => s.marker === 0xe1)).toHaveLength(1);
  });
  it('JPEG: a comment keeps the pixel hash, a scan byte does not', async () => {
    const out = (await attachProvenance(jpeg(), 'jpeg', sampleRecord(), opts())).bytes;
    const sos = out.length - 2 - 9;
    const comment = Uint8Array.of(0xff, 0xfe, 0, 5, 0x68, 0x69, 0x21);
    const withComment = new Uint8Array(out.length + comment.length);
    const dqt = readJpegSegments(out).segments.find((s) => s.marker === 0xdb)!.offset;
    withComment.set(out.subarray(0, dqt));
    withComment.set(comment, dqt);
    withComment.set(out.subarray(dqt), dqt + comment.length);
    let r = await inspectProvenance(withComment);
    expect(r.xmp!.pixelHashMatches).toBe(true);
    expect(r.c2pa!.manifests[0].dataHashValid).toBe(false);
    const scan = out.slice();
    scan[sos + 2] ^= 0x10;
    r = await inspectProvenance(scan);
    expect(r.xmp!.pixelHashMatches).toBe(false);
    expect(r.c2pa!.manifests[0].dataHashValid).toBe(false);
  });
  it('WebP: an XMP chunk in the extended layout', async () => {
    const out = await attachProvenance(webp(true), 'webp', sampleRecord(), opts());
    expect(out.signed).toBe(false);
    const chunks = readWebpChunks(out.bytes);
    expect(chunks.map((c) => c.fourcc)).toEqual(['VP8X', 'VP8L', 'XMP ']);
    const x = chunks[0].data;
    expect(x[0]).toBe(0x14); // alpha and XMP flags
    expect([x[4] | (x[5] << 8), x[7] | (x[8] << 8)]).toEqual([2, 1]); // width-1, height-1
    const r = await inspectProvenance(out.bytes);
    expect(r.errors).toEqual([]);
    expect(r.xmp).toMatchObject({ pixelHashMatches: true, title: 'Kite' });
    expect(r.c2pa).toBeUndefined();
    // The RIFF size covers the file.
    expect(new DataView(out.bytes.buffer).getUint32(4, true)).toBe(out.bytes.length - 8);
    const again = await attachProvenance(out.bytes, 'webp', sampleRecord(), opts());
    expect(readWebpChunks(again.bytes).filter((c) => c.fourcc === 'XMP ')).toHaveLength(1);
  });
  it('TIFF: tag 700 in a rewritten first IFD', async () => {
    const src = tiff();
    const out = await attachProvenance(src, 'tiff', sampleRecord(), opts());
    const page = decodeTiff(out.bytes).pages[0];
    expect(page.xmp).toBe(readXmpPacket(out.bytes, 'tiff'));
    expect(Array.from(page.rgba8.data)).toEqual(Array.from(decodeTiff(src).pages[0].rgba8.data));
    const r = await inspectProvenance(out.bytes);
    expect(r.errors).toEqual([]);
    expect(r.xmp!.pixelHashMatches).toBe(true);
    expect(r.xmp!.record).toEqual(sampleRecord());
    const again = await attachProvenance(out.bytes, 'tiff', sampleRecord(), opts());
    expect((await inspectProvenance(again.bytes)).xmp!.pixelHashMatches).toBe(true);
  });
  it('never throws on malformed or foreign files', async () => {
    const out = (await attachProvenance(png(), 'png', sampleRecord(), opts())).bytes;
    const cases = [
      new Uint8Array(0),
      Uint8Array.of(1, 2, 3),
      out.subarray(0, 60),
      out.subarray(0, out.length - 30),
      buildPng(readPngChunks(out).map((c) => (c.type === 'caBX' ? { type: 'caBX', data: Uint8Array.of(0, 0, 0, 9, 1, 2, 3, 4, 5) } : c))),
      buildPng(readPngChunks(out).map((c) => (c.type === 'caBX' ? { type: 'caBX', data: c.data.slice(0, c.data.length - 40) } : c))),
      jpeg().subarray(0, 30),
      webp().subarray(0, 14),
      tiff().subarray(0, 10),
    ];
    for (const b of cases) {
      const r = await inspectProvenance(b);
      expect(r.errors.length + (r.c2pa?.errors.length ?? 0) + (r.c2pa?.manifests.flatMap((m) => m.errors).length ?? 0)).toBeGreaterThan(0);
    }
    expect(provenanceFormat(png())).toBe('png');
    expect(provenanceFormat(jpeg())).toBe('jpeg');
    expect(provenanceFormat(webp())).toBe('webp');
    expect(provenanceFormat(tiff())).toBe('tiff');
    // A plain file has nothing to report and no errors.
    expect(await inspectProvenance(png())).toMatchObject({ format: 'png', errors: [] });
  });
});
