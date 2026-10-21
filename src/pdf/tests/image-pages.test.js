import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { prepareImageOrientation } from '../src/core/image-orientation.js';
import {
  PAPER_SIZES,
  addImagePages,
  defaultPaper,
  imagesToPdf,
  jpegOrientation,
} from '../src/core/image-pages.js';

async function picture(width, height, fill, format = 'png') {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = fill;
  context.fillRect(0, 0, width, height);
  return new Uint8Array(
    await (format === 'png' ? canvas.encode('png') : canvas.encode('jpeg', 90)),
  );
}
async function view(bytes, number = 1) {
  const task = pdfjs.getDocument({ data: bytes.slice() });
  try {
    const page = await (await task.promise).getPage(number);
    const viewport = page.getViewport({ scale: 0.5 });
    const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
    const context = canvas.getContext('2d');
    await page.render({ canvasContext: context, viewport }).promise;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const at = (x, y) =>
      Array.from(data.subarray((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 3));
    return { width: canvas.width, height: canvas.height, at };
  } finally {
    await task.destroy();
  }
}
/** A minimal JPEG header carrying an EXIF orientation tag. */
function exifJpeg(orientation, little = false) {
  const tiff = [
    ...(little ? [0x49, 0x49, 0x2a, 0x00, 0x08, 0, 0, 0] : [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 0x08]),
    ...(little ? [0x02, 0x00] : [0x00, 0x02]),
    // A padding entry first, then the orientation entry.
    ...(little
      ? [0x0f, 0x01, 0x02, 0x00, 4, 0, 0, 0, 0x41, 0x42, 0x43, 0x00]
      : [0x01, 0x0f, 0x00, 0x02, 0, 0, 0, 4, 0x41, 0x42, 0x43, 0x00]),
    ...(little
      ? [0x12, 0x01, 0x03, 0x00, 1, 0, 0, 0, orientation, 0, 0, 0]
      : [0x01, 0x12, 0x00, 0x03, 0, 0, 0, 1, 0, orientation, 0, 0]),
    0,
    0,
    0,
    0,
  ];
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const length = app1.length + 2;
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00, // an APP0 segment first, as cameras write
    0xff,
    0xe1,
    length >> 8,
    length & 0xff,
    ...app1,
    0xff,
    0xda,
    0x00,
    0x02,
  ]);
}

describe('pictures as pages', () => {
  it('releases decoded PNG pixels before the rest of a picture batch is saved', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { fileURLToPath } = await import('node:url');
    // A fresh process with explicit collection measures live buffers, independent of
    // other tests and their canvas/PDF.js caches. Twelve 1 MP PNGs decode to 48 MB.
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--expose-gc',
        fileURLToPath(new URL('./fixtures/picture-batch-memory.mjs', import.meta.url)),
      ],
      { timeout: 15000 },
    );
    const result = JSON.parse(stdout);
    expect(result.pages).toBe(12);
    expect(result.pdfBytes).toBeGreaterThan(0);
    expect(result.peakRetainedBytes).toBeLessThan(8 * 1024 * 1024);
    expect(result.retainedBytes).toBeLessThan(8 * 1024 * 1024);
  });

  it('preserves PNG transparency, placement, and pixels through save and reopen', async () => {
    const bytes = await imagesToPdf(
      [await picture(100, 50, 'rgba(255,0,0,0.5)'), await picture(50, 100, 'rgba(0,0,255,0.5)')],
      { paper: 'letter' },
    );
    const reopened = await PDFDocument.load(bytes);
    expect(reopened.getPage(0).getSize()).toEqual({ width: 792, height: 612 });
    expect(reopened.getPage(1).getSize()).toEqual({ width: 612, height: 792 });
    const first = await view(await reopened.save(), 1);
    const second = await view(await reopened.save(), 2);
    expect(first.at(first.width / 2, first.height / 2)).toEqual([255, 128, 128]);
    expect(second.at(second.width / 2, second.height / 2)).toEqual([128, 128, 255]);
    expect(first.at(first.width / 2, 2)).toEqual([255, 255, 255]);
    expect(second.at(2, second.height / 2)).toEqual([255, 255, 255]);
  });

  it('fits each picture on a sheet turned to match it, in order, at the chosen position', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    doc.addPage([300, 300]);
    const wide = await picture(300, 200, '#ff0000');
    const tall = await picture(200, 300, '#0000ff', 'jpeg');
    const indices = await addImagePages(doc, [wide, tall], { after: 0, paper: 'a4' });
    expect(indices).toEqual([1, 2]);
    expect(doc.getPageCount()).toBe(4);
    const [w, h] = PAPER_SIZES.a4;
    expect(doc.getPage(1).getSize()).toEqual({ width: h, height: w });
    expect(doc.getPage(2).getSize()).toEqual({ width: w, height: h });
    expect(doc.getPage(3).getSize()).toEqual({ width: 300, height: 300 });
    const bytes = await doc.save();
    const landscape = await view(bytes, 2);
    // The wide picture spans the full width with white bands above and below.
    expect(landscape.at(Math.round(landscape.width / 2), Math.round(landscape.height / 2))).toEqual(
      [255, 0, 0],
    );
    expect(landscape.at(2, Math.round(landscape.height / 2))).toEqual([255, 0, 0]);
    expect(landscape.at(Math.round(landscape.width / 2), 2)).toEqual([255, 255, 255]);
    const portrait = await view(bytes, 3);
    // The tall picture is a JPEG, so its blue is approximate.
    const blue = (pixel) => expect(pixel.map((c) => Math.round(c / 8) * 8)).toEqual([0, 0, 256]);
    blue(portrait.at(Math.round(portrait.width / 2), Math.round(portrait.height / 2)));
    expect(portrait.at(2, Math.round(portrait.height / 2))).toEqual([255, 255, 255]);
    blue(portrait.at(Math.round(portrait.width / 2), 2));
  });
  it('makes a new PDF from pictures on Letter paper and appends after the last page by default', async () => {
    const bytes = await imagesToPdf([await picture(100, 100, '#00ff00')], { paper: 'letter' });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    const more = await addImagePages(doc, [await picture(50, 20, '#000000')], { paper: 'letter' });
    expect(more).toEqual([1]);
    expect(doc.getPage(1).getSize()).toEqual({ width: 792, height: 612 });
    expect((await view(await doc.save(), 1)).at(150, 200)).toEqual([0, 255, 0]);
  });
  it('picks Letter for regions that print on it and A4 elsewhere', () => {
    expect(defaultPaper('en-US')).toBe('letter');
    expect(defaultPaper('en')).toBe('letter');
    expect(defaultPaper('fr-CA')).toBe('letter');
    expect(defaultPaper('en-GB')).toBe('a4');
    expect(defaultPaper('de-DE')).toBe('a4');
    expect(defaultPaper('ja')).toBe('a4');
    expect(defaultPaper('')).toBe('a4');
    expect(defaultPaper('not a locale')).toBe('a4');
  });
  it('clears the decoder orientation without mutating input bytes in either byte order', () => {
    for (const little of [false, true]) {
      for (const orientation of [2, 3, 4, 5, 6, 7, 8]) {
        // Buffer.slice() is a shared view: callers that pass a Buffer still own their bytes.
        const source = Buffer.from(exifJpeg(orientation, little));
        const before = Buffer.from(source);
        const prepared = prepareImageOrientation(source);
        expect(source).toEqual(before);
        expect(prepared.orientation).toBe(orientation);
        expect(jpegOrientation(prepared.bytes)).toBe(1);
        expect(prepared.bytes).toHaveLength(source.length);
        expect(prepared.bytes.filter((value, i) => value !== source[i])).toHaveLength(1);
      }
    }
  });
  it('reads the EXIF orientation of JPEGs in either byte order and defaults to upright', async () => {
    expect(jpegOrientation(exifJpeg(6))).toBe(6);
    expect(jpegOrientation(exifJpeg(8, true))).toBe(8);
    expect(jpegOrientation(exifJpeg(1))).toBe(1);
    expect(jpegOrientation(exifJpeg(9))).toBe(1);
    expect(jpegOrientation(await picture(20, 20, '#fff', 'jpeg'))).toBe(1);
    expect(jpegOrientation(await picture(20, 20, '#fff'))).toBe(1);
    expect(jpegOrientation(exifJpeg(6).subarray(0, 20))).toBe(1);
    expect(jpegOrientation(new Uint8Array())).toBe(1);
  });
  it('rejects missing, invalid, or too many pictures before changing the document', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    await expect(addImagePages(doc, [])).rejects.toThrow('at least one');
    await expect(addImagePages(doc, [new Uint8Array([1, 2, 3])])).rejects.toThrow(
      'valid PNG or JPEG',
    );
    await expect(
      addImagePages(doc, [await picture(10, 10, '#000')], { paper: 'tabloid' }),
    ).rejects.toThrow('paper');
    const one = await picture(10, 10, '#000');
    await expect(
      addImagePages(
        doc,
        Array.from({ length: 1000 }, () => one),
      ),
    ).rejects.toThrow('1,000 pages');
    expect(doc.getPageCount()).toBe(1);
  });
});

it('refuses a small PNG that would unpack into an enormous picture, without unpacking it', async () => {
  const { deflateSync } = await import('node:zlib');
  const { crc32 } = await import('../src/lib/crc32.js');
  const { embedImage } = await import('../src/core/document.js');
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(
      crc32(new Uint8Array(out.subarray(4, 8 + data.length))) >>> 0,
      8 + data.length,
    );
    return out;
  };
  const png = (width, height) => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 1; // one bit of grey per pixel, all of it zeros: it compresses to almost nothing
    const raw = Buffer.alloc((1 + Math.ceil(width / 8)) * height);
    return new Uint8Array(
      Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
      ]),
    );
  };
  const huge = png(20000, 20000);
  expect(huge.length).toBeLessThan(100 * 1024);
  const doc = await PDFDocument.create();
  const started = performance.now();
  await expect(embedImage(doc, huge)).rejects.toThrow('at most 50 megapixels');
  expect(performance.now() - started).toBeLessThan(2000);
  // An ordinary large picture still goes in.
  expect((await embedImage(doc, png(4000, 3000))).width).toBe(4000);
}, 120000);
