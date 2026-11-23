// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strFromU8, strToU8, unzlibSync, zlibSync } from 'fflate';
import { imageFormat, imageResource, imageSize, imageCrop } from '../src/lib/hwp/image.js';
import { checkPixels, tiffDirectory, decodeTiff } from '../src/lib/hwp/tiff.js';
import { checkMetafile, metafileSvg } from '../src/lib/hwp/metafile.js';
import { prepareHanwordImages, adjustPixels } from '../src/lib/hwp/prepare-images.js';
import { decodeBmp, encodePng } from '../src/lib/hwp/bitmap.js';
import { binaryPictureTail } from '../src/lib/hwp/picture-effects.js';
import { Reader } from '../src/lib/hwp/binary.js';
import { parseHwpx } from '../src/lib/hwp/hwpx.js';
import { parseHwp5 } from '../src/lib/hwp/hwp5.js';
import { modelToDocx } from '../src/lib/hwp/docx.js';
import { png, bmp, tiff, wmf, emf, picture, imageHwpx } from './helpers/image-fixtures.js';
import { concat, u16, u32, record, hwp, paragraph, string, controlText } from './helpers/hwp-fixtures.js';

const parts = (model) => unzipSync(modelToDocx(model));
const doc = (model) => new DOMParser().parseFromString(strFromU8(parts(model)['word/document.xml']), 'application/xml');
const elements = (doc, name) => [...doc.getElementsByTagNameNS('*', name)];
const first = (model) => model.sections[0].blocks[0].runs[0];

describe('Hanword image metadata', () => {
  it.each([['png', png], ['bmp', bmp], ['tif', tiff], ['wmf', wmf], ['emf', emf]])('detects %s from bytes despite a misleading extension', (ext, make) => {
    const bytes = make(); expect(imageFormat(bytes)).toBe(ext); expect(imageResource(bytes, 'dat', 'image/jpeg').ext).toBe(ext);
    const embedded = new Uint8Array(bytes.length + 6); embedded.set(bytes, 3); expect(imageFormat(embedded.subarray(3, bytes.length + 3))).toBe(ext);
  });
  it.each([png, bmp, tiff, () => tiff({ little: false })])('reads raster dimensions (case %#)', (make) => expect(imageSize(make())).toEqual({ width: 2, height: 1 }));
  it.each(['VP8 ', 'VP8L', 'VP8X'])('reads %s WebP dimensions', (type) => {
    const data = type === 'VP8 ' ? concat([0, 0, 0, 0x9d, 1, 0x2a], u16(300), u16(150)) : type === 'VP8L' ? concat([0x2f], u32(299 | 149 << 14), [0]) : concat(u32(0), [43, 1, 0, 149, 0, 0]);
    const bytes = concat(strToU8('RIFF'), u32(12 + data.length), strToU8('WEBP' + type), u32(type === 'VP8L' ? 5 : data.length), data);
    expect(imageSize(bytes)).toEqual({ width: 300, height: 150 }); expect(imageSize(bytes.subarray(0, 22))).toBeNull();
  });
  it('keeps the no-crop sentinel and preserves outsets', () => {
    const warnings = new Set(), size = { width: 100, height: 50 };
    expect(imageCrop({ left: -1, top: -1, right: -1, bottom: -1 }, size, warnings)).toBeNull();
    expect(imageCrop({ left: -10, top: 0, right: 110, bottom: 50 }, size, warnings)).toEqual({ l: -10000, t: 0, r: -10000, b: 0 });
    expect(imageCrop({ left: 20, top: 0, right: 10, bottom: 50 }, size, warnings)).toBeNull(); expect([...warnings].join()).toMatch(/complete image/);
  });
});

describe('Hanword picture fidelity', () => {
  it('stops converting pictures once the document\'s time budget is spent, keeping what was done', async () => {
    const model = parseHwpx(imageHwpx(picture('<hp:shapeComment>one</hp:shapeComment>', '', 'image1') + picture('<hp:shapeComment>two</hp:shapeComment>', '', 'image2'), { 'a.bmp': bmp(), 'b.bmp': bmp() }));
    let clock = 0;
    await prepareHanwordImages(model, { now: () => (clock += 70000), budgetMs: 100000 });
    const runs = model.sections[0].blocks[0].runs;
    expect(runs[0].kind).toBe('image');
    expect(runs[1].text).toBe('[Picture unavailable: two]');
    expect([...model.warnings].join()).toMatch(/took too long/);
  });

  it('does not embed a picture whose header declares an absurd size, even when it needs no conversion', async () => {
    // A real 2 × 1 PNG whose header claims a million pixels a side.
    const huge = png(); const view = new DataView(huge.buffer, huge.byteOffset); view.setUint32(16, 1000000); view.setUint32(20, 1000000);
    const model = parseHwpx(imageHwpx(picture('<hp:shapeComment>huge</hp:shapeComment>'), { 'image.png': huge }));
    await prepareHanwordImages(model);
    expect(first(model).text).toBe('[Picture unavailable: huge]');
    expect([...model.warnings].join()).toMatch(/PNG picture could not be imported/);
  });
  it('uses intrinsic dimensions and preserves aspect ratio when one dimension is absent', () => {
    const model = parseHwpx(imageHwpx(picture() + picture('<hp:sz width="7200"/>')));
    expect(model.sections[0].blocks[0].runs.map(({ width, height }) => [width, height])).toEqual([[150, 75], [7200, 3600]]);
    expect(elements(doc(model), 'extent').map((n) => [n.getAttribute('cx'), n.getAttribute('cy')])).toEqual([['19050', '9525'], ['914400', '457200']]);
  });
  it('uses signed crop coordinates and intrinsic dimensions when imgDim is missing', () => {
    const model = parseHwpx(imageHwpx(picture('<hp:imgClip left="-15" top="0" right="165" bottom="75"/>')));
    expect(first(model).crop).toEqual({ l: -10000, t: 0, r: -10000, b: 0 });
  });
  it('retains links, alt text, wrap side, overlap, stacking, flips and bounded rotation', () => {
    const model = parseHwpx(imageHwpx(picture('<hp:sz width="7200" height="3600"/><hp:pos treatAsChar="0" allowOverlap="0" flowWithText="0"/><hp:rotationInfo angle="-90"/><hp:flip horizontal="1"/><hp:shapeComment>한글 &amp; photo</hp:shapeComment>', 'href="https://example.com/image" textWrap="SQUARE" textFlow="LEFT_ONLY" zOrder="42"')));
    const d = doc(model), anchor = elements(d, 'anchor')[0];
    expect(anchor.getAttribute('relativeHeight')).toBe('42'); expect(anchor.getAttribute('allowOverlap')).toBe('1'); expect(anchor.getAttribute('layoutInCell')).toBe('0');
    expect(elements(d, 'wrapSquare')[0].getAttribute('wrapText')).toBe('left'); expect(elements(d, 'docPr')[0].getAttribute('descr')).toBe('한글 & photo');
    expect(elements(d, 'xfrm')[0].getAttribute('rot')).toBe('16200000'); expect(elements(d, 'xfrm')[0].getAttribute('flipH')).toBe('1'); expect(elements(d, 'hyperlink')).toHaveLength(1);
    // "Allow overlap" off is kept for an object text does not wrap around, which the editor reads; a wrapped one is
    // written where Hanword placed it, overlap allowed, or the file opens read-only.
    const front = doc(parseHwpx(imageHwpx(picture('<hp:sz width="7200" height="3600"/><hp:pos treatAsChar="0" allowOverlap="0"/>', 'textWrap="IN_FRONT_OF_TEXT"'))));
    expect(elements(front, 'anchor')[0].getAttribute('allowOverlap')).toBe('0');
  });
  it('maps picture adjustments and borders into native DrawingML', () => {
    const input = picture('<hp:lineShape color="#123456" width="100" style="DASH" alpha="0.25"/>').replace('<hp:img ', '<hp:img bright="20" contrast="-30" effect="GRAY_SCALE" alpha="0.5" ');
    const model = parseHwpx(imageHwpx(input)), d = doc(model);
    expect(elements(d, 'grayscl')).toHaveLength(1); expect(elements(d, 'lum')[0].getAttribute('bright')).toBe('20000'); expect(elements(d, 'lum')[0].getAttribute('contrast')).toBe('-30000');
    expect(elements(d, 'alphaModFix')[0].getAttribute('amt')).toBe('50000'); expect(elements(d, 'ln')[0].getAttribute('w')).toBe('12700'); expect(elements(d, 'alpha')[0].getAttribute('val')).toBe('75000');
  });
  it('uses explicit binary source size rather than the DPI estimate and reads color adjustments', () => {
    const ctrl = record(71, 1, concat(Buffer.from('gso ').reverse(), u32(1), new Uint8Array(8), u32(7200), u32(3600)));
    const pic = record(85, 2, concat(u32(0x00563412), u32(100), u32(2), new Uint8Array(32), u32(50), u32(10), u32(150), u32(90), new Uint8Array(8), [20, 226, 1], u16(1), [0], u32(1), u32(0), u32(200), u32(100), [128]));
    const model = parseHwp5(hwp({ compressed: false, sections: [paragraph(controlText(11, 'gso '), { children: [concat(ctrl, pic)] })], infoExtra: [record(18, 1, concat(u16(1), u16(1), string('png')))], streams: { 'BinData/BIN0001.png': png() } }));
    expect(first(model).crop).toEqual({ l: 25000, t: 10000, r: 25000, b: 10000 }); expect(first(model).adjustments).toMatchObject({ brightness: 20, contrast: -30, effect: 'GRAY_SCALE', transparency: 128 / 255 });
    expect(first(model).line).toMatchObject({ color: '123456', width: 100, style: 'DASH' });
  });
  it('retains binary picture wrap sides, stacking and overlap flags', () => {
    const flags = 2 << 24 | 16384;
    const ctrl = record(71, 1, concat(Buffer.from('gso ').reverse(), u32(flags), u32(0), u32(0), u32(7200), u32(3600), u32(42), new Uint8Array(8)));
    const pic = record(85, 2, concat(new Uint8Array(71), u16(1)));
    const model = parseHwp5(hwp({ compressed: false, sections: [paragraph(controlText(11, 'gso '), { children: [concat(ctrl, pic)] })], infoExtra: [record(18, 1, concat(u16(1), u16(1), string('png')))], streams: { 'BinData/BIN0001.png': png() } }));
    expect(first(model).layout).toMatchObject({ wrapText: 'right', zOrder: 42, overlap: true });
  });
  it('deduplicates binary aliases before decompression and embedding', () => {
    const ctrl = record(71, 1, concat(Buffer.from('gso ').reverse(), u32(1), new Uint8Array(8), u32(7200), u32(3600)));
    const pic = (id) => concat(ctrl, record(85, 2, concat(new Uint8Array(71), u16(id))));
    const model = parseHwp5(hwp({ compressed: false, sections: [concat(...[1, 2].map((id) => paragraph(controlText(11, 'gso '), { children: [pic(id)] })))], infoExtra: [1, 2].map(() => record(18, 1, concat(u16(1), u16(1), string('png')))), streams: { 'BinData/BIN0001.png': png() } }));
    expect(model.images.size).toBe(1); expect(Object.keys(parts(model)).filter((p) => p.startsWith('word/media/'))).toHaveLength(1);
  });
  it('preserves an independently authored Hanword picture fixture', () => {
    const model = parseHwpx(readFileSync('tests/fixtures/hwpx/SimplePicture.hwpx')), d = doc(model);
    // The shadow is the picture's own outer shadow, 600 units to the left with its blur, beside its other effects: as a
    // shadow-colored rectangle grouped with the picture, the blur was lost and the file opened read-only.
    expect(elements(d, 'pic')).toHaveLength(1); expect(elements(d, 'wgp')).toHaveLength(0); expect(elements(d, 'extent')[0].getAttribute('cx')).toBe('3294634'); expect(elements(d, 'docPr')[0].getAttribute('descr')).toContain('544pixel');
    const shadow = elements(d, 'outerShdw')[0];
    expect([shadow.getAttribute('dist'), shadow.getAttribute('dir'), shadow.getAttribute('blurRad')]).toEqual(['76200', '10800000', '76200']); expect(elements(d, 'wsp')).toHaveLength(0); expect(elements(d, 'glow')[0].getAttribute('rad')).toBe('63500'); expect(elements(d, 'satMod')[0].getAttribute('val')).toBe('175000');
    expect(elements(d, 'softEdge')[0].getAttribute('rad')).toBe('38100'); expect(elements(d, 'reflection')[0].getAttribute('endA')).toBe('300');
  });
  it('reads binary effect tails before explicit crop dimensions', () => {
    const f = (n) => { const b = Buffer.alloc(4); b.writeFloatLE(n); return b; };
    const tail = concat(u32(1), u32(6), f(0.5), f(500), u32(0), u32(0xe9ae2b), u32(1), u32(16), f(1.75), f(300), u32(400), u32(200), [64]);
    const result = binaryPictureTail(new Reader(tail), new Set());
    expect(result.dimensions).toEqual({ width: 400, height: 200 }); expect(result.effects.glow.color).toEqual({ value: 'e9ae2b', transforms: [{ name: 'satMod', value: 1.75 }] }); expect(result.effects.softEdge.radius).toBe(300); expect(result.transparency).toBe(64 / 255);
  });
  it('resolves URI-escaped media paths', () => {
    const archive = unzipSync(imageHwpx(picture(), { '한글 image.dat': png() }));
    archive['Contents/content.hpf'] = strToU8(strFromU8(archive['Contents/content.hpf']).replace('한글 image.dat', '%ED%95%9C%EA%B8%80%20image.dat'));
    expect(first(parseHwpx(zipSync(archive))).image.ext).toBe('png');
  });
  it('keeps importing when a picture\'s archive entry is damaged, leaving a labeled gap', () => {
    // Store the archive uncompressed and flip a byte of the picture so its checksum no longer matches.
    const files = unzipSync(imageHwpx(`${picture('<hp:shapeComment>chart</hp:shapeComment>')}<hp:t>after</hp:t>`, { 'image.png': png() }));
    const stored = zipSync(files, { level: 0 });
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    const at = stored.findIndex((_, i) => signature.every((byte, k) => stored[i + k] === byte));
    expect(at).toBeGreaterThan(0);
    stored[at + 20] ^= 0xff;
    const model = parseHwpx(stored);
    expect(doc(model).documentElement.textContent).toContain('[Missing picture: chart]after');
    expect([...model.warnings]).toContain('An embedded picture could not be read.');
  });

  it('preserves captions and descriptions when a picture is missing', () => {
    const input = picture('<hp:shapeComment>figure</hp:shapeComment><hp:caption><hp:subList><hp:p><hp:run><hp:t>Caption</hp:t></hp:run></hp:p></hp:subList></hp:caption>', '', 'missing');
    expect(doc(parseHwpx(imageHwpx(input))).documentElement.textContent).toContain('[Missing picture: figure]Caption');
  });
  it('normalizes one shared bitmap across body, headers, footnotes and text boxes with local relationships', async () => {
    const model = parseHwpx(imageHwpx(picture(), { 'image.bmp': bmp() })), image = first(model).image;
    const p = () => ({ kind: 'p', runs: [{ kind: 'image', image, width: 7200, height: 3600 }] });
    model.sections[0].headers = [{ type: 'default', blocks: [p()] }];
    model.sections[0].blocks[0].runs.push({ kind: 'note', blocks: [p()] }, { kind: 'shape', shape: 'rect', width: 14400, height: 7200, blocks: [p()] });
    await prepareHanwordImages(model); const output = parts(model);
    expect(Object.keys(output).filter((p) => p.startsWith('word/media/'))).toEqual(['word/media/image1.png']);
    for (const name of ['document', 'header1', 'footnotes']) expect(strFromU8(output[`word/_rels/${name}.xml.rels`])).toContain('Target="media/image1.png"');
  });
});

describe('image decoders and resource limits', () => {
  it('converts BMP and bare DIB pixels into a valid lossless PNG', () => {
    const bytes = bmp(), decoded = decodeBmp(bytes), resource = imageResource(bytes.subarray(14), 'dib');
    expect(resource.ext).toBe('bmp'); expect(decodeBmp(resource.bytes)).toEqual(decoded);
    expect([...decoded.pixels]).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
    const pngBytes = encodePng(decoded); expect(imageSize(pngBytes)).toEqual({ width: 2, height: 1 });
    const v = new DataView(pngBytes.buffer); let pos = 8; const chunks = [];
    while (pos < pngBytes.length) { const length = v.getUint32(pos); if (strFromU8(pngBytes.subarray(pos + 4, pos + 8)) === 'IDAT') chunks.push(pngBytes.subarray(pos + 8, pos + 8 + length)); pos += 12 + length; }
    expect([...unzlibSync(concat(...chunks))]).toEqual([0, 255, 0, 0, 255, 0, 0, 255, 255]);
  });
  it.each([1, 4, 8])('decodes indexed %s-bit BMP pixels and top-down rows', (bits) => {
    const colors = 2 ** bits, offset = 54 + colors * 4, b = Buffer.alloc(offset + 4); bmp().copy(b); b.writeUInt32LE(b.length, 2); b.writeUInt32LE(offset, 10); b.writeInt32LE(-1, 22); b.writeUInt16LE(bits, 28); b.set([0, 0, 255, 0, 255, 0, 0, 0], 54); b.set(bits === 8 ? [0, 1] : [bits === 4 ? 1 : 64], offset);
    expect([...decodeBmp(b).pixels]).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
  });
  it.each([4, 8])('decodes RLE%s bitmap runs and rejects overflowing runs', (bits) => {
    const colors = 2 ** bits, offset = 54 + colors * 4, rle = bits === 8 ? [1, 0, 1, 1, 0, 1] : [2, 1, 0, 1], b = Buffer.alloc(offset + rle.length); bmp().copy(b); b.writeUInt32LE(b.length, 2); b.writeUInt32LE(offset, 10); b.writeUInt16LE(bits, 28); b.writeUInt32LE(bits === 8 ? 1 : 2, 30); b.set([0, 0, 255, 0, 255, 0, 0, 0], 54); b.set(rle, offset);
    expect([...decodeBmp(b).pixels]).toEqual([255, 0, 0, 255, 0, 0, 255, 255]); b[offset] = 255; expect(() => decodeBmp(b)).toThrow();
  });
  it('rejects compressed TIFF strips that inflate beyond their pixel buffer', async () => {
    const packed = zlibSync(new Uint8Array(100000)), b = Buffer.alloc(152 + packed.length); tiff().copy(b); b.writeUInt16LE(8, 10 + 12 * 3 + 8); b.writeUInt32LE(packed.length, 10 + 12 * 9 + 8); b.set(packed, 152);
    await expect(decodeTiff(b)).rejects.toThrow(/expands beyond/);
  });
  it.each([true, false])('decodes a real %s-endian TIFF into the expected pixels', async (little) => {
    const result = await decodeTiff(tiff({ little })); expect([result.width, result.height]).toEqual([2, 1]); expect([...result.pixels]).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
  });
  it('does not follow cyclic TIFF page chains and detects oversized or truncated tags', () => {
    const bytes = tiff(); bytes.writeUInt32LE(8, 142); expect(tiffDirectory(bytes).multiplePages).toBe(true);
    bytes.writeUInt32LE(0xffffffff, 10 + 12 * 2 + 4); expect(() => tiffDirectory(bytes)).toThrow();
    expect(() => tiffDirectory(tiff().subarray(0, 100))).toThrow(); expect(() => checkPixels(100000, 100000)).toThrow(/megapixel/);
  });
  it.each([['wmf', wmf], ['emf', emf]])('renders %s using the real decoder and rejects truncated records', async (ext, make) => {
    const bytes = make(); expect(() => checkMetafile(bytes, ext)).not.toThrow(); expect(() => checkMetafile(bytes.subarray(0, bytes.length - 1), ext)).toThrow();
    const blob = await metafileSvg(imageResource(bytes), 200, 100); const text = await new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(blob); }); expect(text).toContain('<svg'); expect(text).toMatch(/<(rect|polygon)/); expect(text).not.toMatch(/<script|foreignObject/);
  });
  it.each(['car.wmf', 'drawing.emf'])('renders independent vector fixture %s', async (name) => {
    const resource = imageResource(readFileSync(`tests/fixtures/images/${name}`));
    const blob = await metafileSvg(resource, 600, 400); expect(blob.size).toBeGreaterThan(1000);
  });
  it('rejects forged metafile point counts before allocating geometry', () => {
    const bytes = Buffer.from(emf()); bytes.writeUInt32LE(0xffffffff, 88 + 16 + 24);
    expect(() => checkMetafile(bytes, 'emf')).toThrow(/point data/);
  });
  it('applies grayscale, threshold and alpha without changing source bytes', () => {
    const bytes = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 128]); adjustPixels(bytes, { effect: 'GRAY_SCALE', transparency: 0.5 });
    expect([...bytes]).toEqual([76, 76, 76, 128, 29, 29, 29, 64]);
    const bw = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]); adjustPixels(bw, { effect: 'BLACK_WHITE' }); expect([...bw]).toEqual([255, 255, 255, 255, 0, 0, 0, 255]);
  });
  it('retains a readable placeholder for failed codecs without discarding adjacent text', async () => {
    const model = parseHwpx(imageHwpx(picture('<hp:shapeComment>scanned page</hp:shapeComment>') + '<hp:t>본문</hp:t>', { 'scan.tif': new Uint8Array([0, 1, 2]) }));
    await prepareHanwordImages(model); expect(first(model).text).toBe('[Picture unavailable: scanned page]'); expect(doc(model).documentElement.textContent).toContain('본문'); expect([...model.warnings].join()).toMatch(/TIFF|TIF/);
  });
});

describe('pictures whose stream cannot be read', () => {
  const ctrl = record(71, 1, concat(Buffer.from('gso ').reverse(), u32(1), new Uint8Array(8), u32(7200), u32(3600)));
  const pic = record(85, 2, concat(u32(0x00563412), u32(100), u32(2), new Uint8Array(32), u32(50), u32(10), u32(150), u32(90), new Uint8Array(8), [20, 226, 1], u16(1), [0], u32(1), u32(0), u32(200), u32(100), [128]));
  const withPicture = (bytes) => parseHwp5(hwp({ compressed: true, sections: [concat(paragraph(controlText(11, 'gso '), { children: [concat(ctrl, pic)] }), paragraph('After'))], infoExtra: [record(18, 1, concat(u16(1), u16(1), string('png')))], streams: { 'BinData/BIN0001.png': bytes } }));
  it('takes a picture stored raw in a compressed file as it is', () => {
    const model = withPicture(png());
    expect(first(model).kind).toBe('image');
    expect(model.sections[0].blocks).toHaveLength(2);
  });
  it('leaves a placeholder for a damaged picture instead of failing the import', () => {
    const model = withPicture(new Uint8Array([1, 2, 3, 4, 5]));
    expect(first(model)).toMatchObject({ kind: 'text', text: '[Missing picture]' });
    expect([...model.warnings]).toContain('An embedded picture could not be read.');
    expect(model.sections[0].blocks).toHaveLength(2);
  });
});

describe('the pictures in the converted package', () => {
  it('are stored without deflating them again', async () => {
    const model = parseHwpx(imageHwpx(picture()));
    await prepareHanwordImages(model);
    const bytes = modelToDocx(model);
    const find = (text) => { const needle = new TextEncoder().encode(text); outer: for (let i = 0; i <= bytes.length - needle.length; i++) { for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer; return i; } return -1; };
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const media = find('word/media/image1.png');
    expect(media).toBeGreaterThanOrEqual(30);
    expect(view.getUint32(media - 30, true)).toBe(0x04034b50);
    // Compression method 0: stored.
    expect(view.getUint16(media - 30 + 8, true)).toBe(0);
    // The document part is still deflated.
    const doc = find('word/document.xml');
    expect(view.getUint16(doc - 30 + 8, true)).toBe(8);
  });
});

describe('picture conversion notes', () => {
  it('name the format as the user knows it and keep a codec\'s internals out of the note', async () => {
    const model = parseHwpx(imageHwpx(picture() + '<hp:t>본문</hp:t>', { 'drawing.emf': new Uint8Array([1, 0, 0, 0, 2, 3]) }));
    await prepareHanwordImages(model);
    const notes = [...model.warnings].join(' | ');
    expect(notes).toMatch(/An EMF picture (?:could not be converted|has unrecognized or damaged image data)/);
    expect(notes).not.toMatch(/is not defined|Cannot read properties|undefined/);
  });
});

describe('flattening inline drawings', () => {
  it('leaves a shape with a picture fill or a shadow as a shape, since a raster would lose them', async () => {
    const { flattenInlineDrawings } = await import('../src/lib/hwp/prepare-images.js');
    const shape = (extra = {}) => ({ kind: 'shape', shape: 'rect', width: 1200, height: 600, fill: 'FF0000', line: { style: 'SOLID', width: 33, color: '000000' }, blocks: [], ...extra });
    const model = { warnings: new Set(), sections: [{ blocks: [{ kind: 'p', runs: [{ kind: 'text', text: 'Icons ' }, shape(), shape({ pictureFill: { kind: 'image' } }), shape({ shadow: { color: '808080', x: 100, y: 100 } })] }] }] };
    const rasterized = [];
    flattenInlineDrawings(model, (run) => { rasterized.push(run); return { bytes: new Uint8Array([1]), ext: 'png' }; });
    expect(rasterized).toHaveLength(1);
    expect(model.sections[0].blocks[0].runs.map((r) => r.kind)).toEqual(['text', 'image', 'shape', 'shape']);
  });
});
