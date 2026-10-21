import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import {
  COMPRESSION_LEVELS,
  compressDocument,
  compressPdf,
  sweepUnreferenced,
} from '../src/core/compress.js';
import {
  PdfSession,
  samplePdf,
  embedOrientedImage,
  drawOrientedImage,
} from '../src/core/document.js';
import { inspectImages } from '../src/core/image-edit.js';

const STANDARD_FONTS = new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
  .pathname;
/** The browser codec's Node twin: PDF.js legacy build plus a native canvas. */
const codec = {
  async render(pdfBytes, width, height) {
    const task = pdfjs.getDocument({ data: pdfBytes.slice(), standardFontDataUrl: STANDARD_FONTS });
    try {
      const page = await (await task.promise).getPage(1);
      const canvas = createCanvas(width, height);
      const context = canvas.getContext('2d');
      await page.render({
        canvasContext: context,
        viewport: page.getViewport({ scale: 1 }),
        background: 'rgba(0,0,0,0)',
      }).promise;
      return context.getImageData(0, 0, width, height);
    } finally {
      await task.destroy();
    }
  },
  async encodeJpeg({ data, width, height }, quality) {
    const canvas = createCanvas(width, height);
    canvas.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
    return new Uint8Array(await canvas.encode('jpeg', Math.round(quality * 100)));
  },
};
/** Render page `number` of `bytes` at `scale` and return its RGBA pixels. */
async function view(bytes, number = 1, scale = 0.5) {
  const task = pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl: STANDARD_FONTS });
  try {
    const page = await (await task.promise).getPage(number);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
    const context = canvas.getContext('2d');
    await page.render({ canvasContext: context, viewport }).promise;
    return {
      width: canvas.width,
      height: canvas.height,
      pixels: context.getImageData(0, 0, canvas.width, canvas.height).data,
      text: (await page.getTextContent()).items.map((item) => item.str).join(''),
    };
  } finally {
    await task.destroy();
  }
}
/** Mean absolute channel difference between two renders of the same size. */
function difference(a, b) {
  let sum = 0;
  for (let i = 0; i < a.pixels.length; i += 4)
    for (let c = 0; c < 3; c++) sum += Math.abs(a.pixels[i + c] - b.pixels[i + c]);
  return sum / ((a.pixels.length / 4) * 3);
}
/** A photo-like picture: smooth gradients with texture, so JPEG and downsampling both matter. */
function picture(width, height, { alpha = false } = {}) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#ff8040');
  gradient.addColorStop(0.5, '#40a0ff');
  gradient.addColorStop(1, '#40ff80');
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  for (let i = 0; i < 400; i++) {
    context.fillStyle = `hsl(${(i * 37) % 360} 70% ${40 + (i % 5) * 10}%)`;
    context.beginPath();
    context.arc(
      ((i * 7919) % width) | 0,
      ((i * 104729) % height) | 0,
      5 + (i % 40),
      0,
      Math.PI * 2,
    );
    context.fill();
  }
  if (alpha) {
    // The right half fades out, the corner is fully transparent.
    context.globalCompositeOperation = 'destination-out';
    const fade = context.createLinearGradient(width / 2, 0, width, 0);
    fade.addColorStop(0, 'rgba(0,0,0,0)');
    fade.addColorStop(1, 'rgba(0,0,0,1)');
    context.fillStyle = fade;
    context.fillRect(width / 2, 0, width / 2, height);
    context.fillStyle = '#000';
    context.fillRect(0, 0, width / 4, height / 4);
  }
  return canvas;
}
const image = (dict) => dict.lookup(PDFName.of('Width')).asNumber();
function pageImage(doc, index = 0) {
  const xobjects = doc.getPage(index).node.Resources().lookup(PDFName.of('XObject'));
  const [, ref] = xobjects.entries()[0];
  return doc.context.lookup(ref);
}

// Each case renders pictures through PDF.js several times, which takes longer on a busy machine.
describe('reducing file size', { timeout: 60000 }, () => {
  it.each([2, 6])(
    'keeps photo orientation %s and measures compression along its pixel axes',
    async (orientation) => {
      const doc = await PDFDocument.create();
      const jpeg = await picture(2400, 1200).encode('jpeg', 95);
      const tag = Buffer.from(
        'ffe1002245786966000049492a0008000000010012010300010000000600000000000000',
        'hex',
      );
      tag[28] = orientation;
      const image = await embedOrientedImage(
        doc,
        new Uint8Array(Buffer.concat([jpeg.subarray(0, 2), tag, jpeg.subarray(2)])),
      );
      drawOrientedImage(doc.addPage([400, 500]), image, {
        x: 50,
        y: 100,
        width: orientation === 6 ? 144 : 288,
        height: orientation === 6 ? 288 : 144,
      });
      const original = await doc.save();
      const placement = inspectImages(doc, 0)[0].transform;
      const result = await compressPdf(original, { level: 'balanced', codec });
      expect(result.images).toBe(1);
      const compressed = await PDFDocument.load(result.bytes);
      const after = inspectImages(compressed, 0)[0];
      // The raw 2:1 pixels occupy 288 by 144 points even when the photo is turned upright.
      expect.soft(after.object.dict.lookup(PDFName.of('Width')).asNumber()).toBe(600);
      expect.soft(after.object.dict.lookup(PDFName.of('Height')).asNumber()).toBe(300);
      expect.soft(after.orientation).toBe(orientation);
      after.transform.forEach((value, i) => expect.soft(value).toBeCloseTo(placement[i], 6));
      expect(difference(await view(original), await view(result.bytes))).toBeLessThan(6);
    },
  );
  it('downsamples a large photo to the resolution it is printed at and keeps the page looking the same', async () => {
    const doc = await PDFDocument.create();
    const jpeg = await doc.embedJpg(await picture(2400, 1800).encode('jpeg', 95));
    const page = doc.addPage([400, 500]);
    page.drawImage(jpeg, { x: 50, y: 150, width: 300, height: 225 });
    page.drawText('Caption under the photo', { x: 50, y: 120, size: 14 });
    const original = await doc.save();
    const before = await view(original);
    const result = await compressPdf(original, { level: 'balanced', codec });
    expect(result.images).toBe(1);
    expect(result.after).toBeLessThan(result.before / 3);
    const shrunk = await PDFDocument.load(result.bytes);
    // 300 pt at 150 dpi is 625 pixels.
    expect(image(pageImage(shrunk).dict)).toBe(625);
    expect(pageImage(shrunk).dict.lookup(PDFName.of('Height')).asNumber()).toBe(469);
    const after = await view(result.bytes);
    expect(after.text).toBe(before.text);
    expect(difference(before, after)).toBeLessThan(6);
    // Every level keeps the picture at a size that fits its box.
    for (const [level, { dpi }] of Object.entries(COMPRESSION_LEVELS)) {
      const at = await PDFDocument.load((await compressPdf(original, { level, codec })).bytes);
      expect(image(pageImage(at).dict)).toBe(Math.round((300 / 72) * dpi));
    }
  });
  it('re-encodes a lossless picture as JPEG when that is smaller, and leaves small or 1-bit ones alone', async () => {
    const doc = await PDFDocument.create();
    const png = await doc.embedPng(await picture(800, 600).encode('png'));
    const small = await doc.embedPng(await picture(100, 80).encode('png'));
    const page = doc.addPage([700, 700]);
    page.drawImage(png, { x: 50, y: 200, width: 600, height: 450 });
    page.drawImage(small, { x: 50, y: 50, width: 100, height: 80 });
    const bilevel = doc.context.register(
      doc.context.flateStream(new Uint8Array((400 * 400) / 8).fill(0xaa), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 400,
        Height: 400,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 1,
      }),
    );
    page.node.Resources().lookup(PDFName.of('XObject')).set(PDFName.of('Scan'), bilevel);
    // An uncompressed content stream paints the scan; it should come out deflated.
    const raw = new TextEncoder().encode('q 200 0 0 200 400 20 cm /Scan Do Q '.repeat(4));
    const contents = page.node.Contents();
    page.node.set(
      PDFName.of('Contents'),
      doc.context.obj([
        ...(contents.constructor.name === 'PDFArray' ? contents.asArray() : [contents]),
        doc.context.register(doc.context.stream(raw)),
      ]),
    );
    const original = await doc.save();
    const result = await compressPdf(original, { level: 'quality', codec });
    expect(result.images).toBe(1);
    // The uncompressed content stream was deflated too.
    expect(result.streams).toBeGreaterThanOrEqual(1);
    const shrunk = await PDFDocument.load(result.bytes);
    const xobjects = shrunk.getPage(0).node.Resources().lookup(PDFName.of('XObject'));
    const kinds = xobjects
      .entries()
      .map(([, ref]) => shrunk.context.lookup(ref).dict)
      .map((dict) => [
        dict.lookup(PDFName.of('Width')).asNumber(),
        dict.lookup(PDFName.of('Filter'))?.decodeText(),
        dict.lookup(PDFName.of('BitsPerComponent')).asNumber(),
      ]);
    // 600 pt at 220 dpi is 1833 pixels: wider than the picture, so its size stays.
    expect(kinds).toContainEqual([800, 'DCTDecode', 8]);
    expect(kinds).toContainEqual([100, 'FlateDecode', 8]);
    expect(kinds).toContainEqual([400, 'FlateDecode', 1]);
    expect(result.after).toBeLessThan(result.before);
    expect(difference(await view(original), await view(result.bytes))).toBeLessThan(6);
  });
  it('keeps transparency as a soft mask when a picture has one', async () => {
    const doc = await PDFDocument.create();
    const png = await doc.embedPng(await picture(1600, 1200, { alpha: true }).encode('png'));
    const page = doc.addPage([400, 400]);
    page.drawRectangle({ x: 0, y: 0, width: 400, height: 400, color: rgb(1, 1, 0) });
    page.drawImage(png, { x: 50, y: 100, width: 300, height: 225 });
    const original = await doc.save();
    const result = await compressPdf(original, { level: 'balanced', codec });
    expect(result.images).toBe(1);
    const shrunk = await PDFDocument.load(result.bytes);
    const replaced = pageImage(shrunk);
    expect(replaced.dict.lookup(PDFName.of('Filter')).decodeText()).toBe('DCTDecode');
    const mask = replaced.dict.lookup(PDFName.of('SMask'));
    expect(mask.dict.lookup(PDFName.of('Width')).asNumber()).toBe(625);
    const before = await view(original),
      after = await view(result.bytes);
    expect(difference(before, after)).toBeLessThan(6);
    // The transparent corner still shows the yellow page behind it.
    const corner = ((100 / 2 + 5) * after.width + 50 / 2 + 5) * 4;
    expect([after.pixels[corner], after.pixels[corner + 1], after.pixels[corner + 2]]).toEqual([
      255, 255, 0,
    ]);
  });
  it.each(['page', 'form'])(
    'shrinks a shared picture once, to its largest use in a %s',
    async (via) => {
      const doc = await PDFDocument.create();
      const jpeg = await doc.embedJpg(await picture(2000, 2000).encode('jpeg', 92));
      doc.addPage([300, 300]).drawImage(jpeg, { x: 0, y: 0, width: 100, height: 100 });
      const larger = doc.addPage([300, 300]);
      if (via === 'page') larger.drawImage(jpeg, { x: 0, y: 0, width: 288, height: 288 });
      else {
        const form = doc.context.register(
          doc.context.flateStream('q 288 0 0 288 0 0 cm /Im Do Q', {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [0, 0, 300, 300],
            Resources: { XObject: { Im: jpeg.ref } },
          }),
        );
        larger.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { F0: form } }));
        larger.node.set(
          PDFName.of('Contents'),
          doc.context.register(doc.context.flateStream('/F0 Do')),
        );
      }
      const result = await compressPdf(await doc.save(), { level: 'balanced', codec });
      expect(result.images).toBe(1);
      const shrunk = await PDFDocument.load(result.bytes);
      expect(image(pageImage(shrunk, 0).dict)).toBe(600);
      expect(pageImage(shrunk, 0)).toBe(inspectImages(shrunk, 1)[0].object);
      expect((await view(result.bytes, 2)).pixels.length).toBeGreaterThan(0);
    },
  );
  it.each(['pattern', 'nested pattern', 'stamp'])(
    'keeps an image used large in a %s, even when a page uses it small',
    async (via) => {
      const doc = await PDFDocument.create();
      const jpeg = await doc.embedJpg(await picture(1600, 1600).encode('jpeg', 95));
      const p1 = doc.addPage([600, 600]);
      const p2 = doc.addPage([600, 600]);
      // A small direct use on page 1 would, on its own, shrink the image to about 100 px.
      p1.drawImage(jpeg, { x: 50, y: 50, width: 50, height: 50 });
      if (via.includes('pattern')) {
        const pattern = doc.context.register(
          doc.context.stream('q 500 0 0 500 0 0 cm /Im Do Q', {
            Type: 'Pattern',
            PatternType: 1,
            PaintType: 1,
            TilingType: 1,
            BBox: [0, 0, 500, 500],
            XStep: 500,
            YStep: 500,
            Resources: { XObject: { Im: jpeg.ref } },
          }),
        );
        p2.node.set(
          PDFName.of('Resources'),
          doc.context.obj({ Pattern: { P0: pattern }, XObject: {} }),
        );
        p2.node.set(
          PDFName.of('Contents'),
          doc.context.register(
            doc.context.flateStream('q /Pattern cs /P0 scn 50 50 500 500 re f Q'),
          ),
        );
        if (via === 'nested pattern') {
          const form = doc.context.register(
            doc.context.flateStream('q /Pattern cs /P0 scn 50 50 500 500 re f Q', {
              Type: 'XObject',
              Subtype: 'Form',
              BBox: [0, 0, 600, 600],
              Resources: p2.node.Resources(),
            }),
          );
          p2.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { F0: form } }));
          p2.node.set(
            PDFName.of('Contents'),
            doc.context.register(doc.context.flateStream('/F0 Do')),
          );
        }
      } else {
        const ap = doc.context.register(
          doc.context.stream('q 500 0 0 500 0 0 cm /Im Do Q', {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [0, 0, 500, 500],
            Resources: { XObject: { Im: jpeg.ref } },
          }),
        );
        p2.node.set(
          PDFName.of('Annots'),
          doc.context.obj([
            doc.context.obj({
              Type: 'Annot',
              Subtype: 'Stamp',
              Rect: [50, 50, 550, 550],
              F: 4,
              AP: { N: ap },
            }),
          ]),
        );
      }
      const original = await doc.save();
      const result = await compressPdf(original, { level: 'balanced', codec });
      // The image keeps its resolution; only lossless steps may run.
      expect.soft(result.images).toBe(0);
      const kept = await PDFDocument.load(result.bytes);
      expect.soft(image(pageImage(kept).dict)).toBe(1600);
      expect(difference(await view(original, 2), await view(result.bytes, 2))).toBe(0);
    },
  );
  it.each(['missing', 'empty', 'partial', 'own images'])(
    'preserves pattern resolution with %s pattern resources',
    async (resourcesMode) => {
      const doc = await PDFDocument.create();
      const jpegBytes = await picture(800, 800).encode('jpeg', 95);
      const small = await doc.embedJpg(jpegBytes);
      const independent = resourcesMode === 'own images';
      const large = independent ? await doc.embedJpg(jpegBytes) : small;
      const page = doc.addPage([600, 600]);
      const resources = {
        empty: {},
        partial: { Font: {} },
        'own images': { XObject: { Im: large.ref } },
      }[resourcesMode];
      const pattern = doc.context.register(
        doc.context.stream('q 500 0 0 500 0 0 cm /Im Do Q', {
          Type: 'Pattern',
          PatternType: 1,
          PaintType: 1,
          TilingType: 1,
          BBox: [0, 0, 500, 500],
          XStep: 500,
          YStep: 500,
          ...(resources && { Resources: resources }),
        }),
      );
      page.node.set(
        PDFName.of('Resources'),
        doc.context.obj({
          Pattern: { P0: pattern },
          XObject: { Im: small.ref },
        }),
      );
      page.node.set(
        PDFName.of('Contents'),
        doc.context.register(
          doc.context.flateStream(
            'q 50 0 0 50 0 0 cm /Im Do Q q /Pattern cs /P0 scn 50 50 500 500 re f Q',
          ),
        ),
      );
      const original = await doc.save();
      const result = await compressPdf(original, { codec });
      expect.soft(result.images).toBe(independent ? 1 : 0);
      const saved = await PDFDocument.load(result.bytes);
      const pageResources = saved.getPage(0).node.Resources();
      const direct = pageResources.lookup(PDFName.of('XObject')).lookup(PDFName.of('Im'));
      expect.soft(image(direct.dict)).toBe(independent ? 104 : 800);
      if (independent) {
        const own = pageResources
          .lookup(PDFName.of('Pattern'))
          .lookup(PDFName.of('P0'))
          .dict.lookup(PDFName.of('Resources'))
          .lookup(PDFName.of('XObject'))
          .lookup(PDFName.of('Im'));
        expect(image(own.dict)).toBe(800);
      } else expect(difference(await view(original), await view(result.bytes))).toBe(0);
    },
  );

  it.each(['page', 'form'])('keeps shared images used by a soft mask in a %s', async (via) => {
    const doc = await PDFDocument.create();
    const jpeg = await doc.embedJpg(await picture(1600, 1600).encode('jpeg', 95));
    doc.addPage([600, 600]).drawImage(jpeg, { x: 50, y: 50, width: 50, height: 50 });
    const page = doc.addPage([600, 600]);
    const mask = doc.context.register(
      doc.context.flateStream('q 500 0 0 500 50 50 cm /Im Do Q', {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 600, 600],
        Group: { S: 'Transparency', CS: 'DeviceRGB' },
        Resources: { XObject: { Im: jpeg.ref } },
      }),
    );
    const resources = doc.context.obj({
      ExtGState: { GS: { SMask: { S: 'Luminosity', G: mask } } },
    });
    const content = 'q /GS gs 1 0 0 rg 50 50 500 500 re f Q';
    if (via === 'page') {
      page.node.set(PDFName.of('Resources'), resources);
      page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content)));
    } else {
      const form = doc.context.register(
        doc.context.flateStream(content, {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 600, 600],
          Resources: resources,
        }),
      );
      page.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { F0: form } }));
      page.node.set(
        PDFName.of('Contents'),
        doc.context.register(doc.context.flateStream('/F0 Do')),
      );
    }
    const original = await doc.save();
    const result = await compressPdf(original, { codec });
    expect.soft(result.images).toBe(0);
    expect.soft(image(pageImage(await PDFDocument.load(result.bytes)).dict)).toBe(1600);
    expect(difference(await view(original, 2), await view(result.bytes, 2))).toBe(0);
  });
  it.each(['deep', 'unbalanced'])(
    'keeps shared images when a %s form cannot be fully inspected',
    async (kind) => {
      const doc = await PDFDocument.create();
      const jpeg = await doc.embedJpg(await picture(1600, 1600).encode('jpeg', 95));
      const page = doc.addPage([600, 600]);
      page.drawImage(jpeg, { x: 10, y: 10, width: 50, height: 50 });
      let form = doc.context.register(
        doc.context.flateStream(
          `${kind === 'unbalanced' ? 'Q ' : ''}q 500 0 0 500 50 50 cm /Im Do Q`,
          {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [0, 0, 600, 600],
            Resources: { XObject: { Im: jpeg.ref } },
          },
        ),
      );
      if (kind === 'deep')
        for (let i = 0; i < 24; i++)
          form = doc.context.register(
            doc.context.flateStream('/F0 Do', {
              Type: 'XObject',
              Subtype: 'Form',
              BBox: [0, 0, 600, 600],
              Resources: { XObject: { F0: form } },
            }),
          );
      page.node.Resources().lookup(PDFName.of('XObject')).set(PDFName.of('Large'), form);
      page.node.Contents().push(doc.context.register(doc.context.flateStream('/Large Do')));
      const original = await doc.save();
      const result = await compressPdf(original, { codec });
      expect.soft(result.images).toBe(0);
      expect.soft(image(pageImage(await PDFDocument.load(result.bytes)).dict)).toBe(1600);
      expect(difference(await view(original), await view(result.bytes))).toBe(0);
    },
  );
  it.each([true, false])(
    'keeps grayscale compression safe when its image is also a mask: %s',
    async (shared) => {
      const doc = await PDFDocument.create();
      const photo = picture(800, 800);
      const rgba = photo.getContext('2d').getImageData(0, 0, 800, 800).data;
      const samples = Uint8Array.from({ length: 800 * 800 }, (_, i) => rgba[i * 4]);
      const mask = doc.context.register(
        doc.context.flateStream(samples, {
          Type: 'XObject',
          Subtype: 'Image',
          Width: 800,
          Height: 800,
          ColorSpace: 'DeviceGray',
          BitsPerComponent: 8,
        }),
      );
      const small = doc.addPage([600, 600]);
      small.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { Im: mask } }));
      small.node.set(
        PDFName.of('Contents'),
        doc.context.register(doc.context.flateStream('q 50 0 0 50 10 10 cm /Im Do Q')),
      );
      const jpeg = await doc.embedJpg(await photo.encode('jpeg', 95));
      doc.addPage([600, 600]).drawImage(jpeg, { x: 50, y: 50, width: 500, height: 500 });
      await doc.flush();
      if (shared) doc.context.lookup(jpeg.ref).dict.set(PDFName.of('SMask'), mask);
      const original = await doc.save();
      const result = await compressPdf(original, { codec });
      expect.soft(result.images).toBe(shared ? 0 : 1);
      const kept = await PDFDocument.load(result.bytes);
      const gray = pageImage(kept);
      expect.soft(image(gray.dict)).toBe(shared ? 800 : 104);
      expect
        .soft(gray.dict.lookup(PDFName.of('ColorSpace')))
        .toBe(PDFName.of(shared ? 'DeviceGray' : 'DeviceRGB'));
      if (shared) expect(pageImage(kept, 1).dict.lookup(PDFName.of('SMask'))).toBe(gray);
      expect(difference(await view(original, 2), await view(result.bytes, 2))).toBe(0);
    },
  );
  it.each(['own', 'inherited'])(
    'preserves image glyphs in Type 3 fonts with %s resources',
    async (resourcesMode) => {
      const doc = await PDFDocument.create();
      const jpeg = await doc.embedJpg(await picture(1600, 1600).encode('jpeg', 95));
      const page = doc.addPage([600, 600]);
      page.drawImage(jpeg, { x: 10, y: 10, width: 50, height: 50 });
      const glyph = doc.context.register(
        doc.context.flateStream('1000 0 d0 q 1000 0 0 1000 0 0 cm /Im Do Q'),
      );
      const font = doc.context.register(
        doc.context.obj({
          Type: 'Font',
          Subtype: 'Type3',
          FontBBox: [0, 0, 1000, 1000],
          FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
          CharProcs: { A: glyph },
          Encoding: { Type: 'Encoding', Differences: [65, 'A'] },
          FirstChar: 65,
          LastChar: 65,
          Widths: [1000],
          ...(resourcesMode === 'own' ? { Resources: { XObject: { Im: jpeg.ref } } } : {}),
        }),
      );
      page.node.Resources().set(PDFName.of('Font'), doc.context.obj({ F3: font }));
      if (resourcesMode === 'inherited')
        page.node.Resources().lookup(PDFName.of('XObject')).set(PDFName.of('Im'), jpeg.ref);
      page.node
        .Contents()
        .push(
          doc.context.register(
            doc.context.flateStream('BT /F3 500 Tf 1 0 0 1 50 50 Tm <41> Tj ET'),
          ),
        );
      const original = await doc.save();
      const result = await compressPdf(original, { codec });
      expect.soft(result.images).toBe(0);
      expect.soft(image(pageImage(await PDFDocument.load(result.bytes)).dict)).toBe(1600);
      expect(difference(await view(original), await view(result.bytes))).toBe(0);
    },
  );
  it.each(['page', 'form', 'own empty resources'])(
    'preserves images inherited by a soft mask from %s',
    async (via) => {
      const doc = await PDFDocument.create();
      const jpeg = await doc.embedJpg(await picture(800, 800).encode('jpeg', 95));
      const page = doc.addPage([600, 600]);
      const ownEmpty = via === 'own empty resources';
      const mask = doc.context.register(
        doc.context.flateStream('q 500 0 0 500 50 50 cm /Im Do Q', {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 600, 600],
          Group: { S: 'Transparency', CS: 'DeviceRGB' },
          ...(ownEmpty && { Resources: {} }),
        }),
      );
      const resources = doc.context.obj({
        XObject: { Im: jpeg.ref },
        ExtGState: { GS: { SMask: { S: 'Luminosity', G: mask } } },
      });
      const content = 'q 50 0 0 50 0 0 cm /Im Do Q q /GS gs 1 0 0 rg 50 50 500 500 re f Q';
      if (via === 'form') {
        const form = doc.context.register(
          doc.context.flateStream(content, {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [0, 0, 600, 600],
            Resources: resources,
          }),
        );
        page.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { F0: form } }));
        page.node.set(
          PDFName.of('Contents'),
          doc.context.register(doc.context.flateStream('/F0 Do')),
        );
      } else {
        page.node.set(PDFName.of('Resources'), resources);
        page.node.set(
          PDFName.of('Contents'),
          doc.context.register(doc.context.flateStream(content)),
        );
      }
      const original = await doc.save();
      const result = await compressPdf(original, { codec });
      expect.soft(result.images).toBe(ownEmpty ? 1 : 0);
      const saved = await PDFDocument.load(result.bytes);
      expect.soft(image(saved.context.lookup(jpeg.ref).dict)).toBe(ownEmpty ? 104 : 800);
      if (!ownEmpty) expect(difference(await view(original), await view(result.bytes))).toBe(0);
    },
  );

  it.each(['render', 'encode'])(
    'stops cancelled compression after its current %s',
    async (stage) => {
      const doc = await PDFDocument.create();
      const bytes = await picture(800, 800).encode('jpeg', 95);
      for (let i = 0; i < 2; i++) {
        const image = await doc.embedJpg(bytes);
        doc.addPage([200, 200]).drawImage(image, { x: 0, y: 0, width: 100, height: 100 });
      }
      const controller = new AbortController();
      let renders = 0,
        encodes = 0;
      const cancelledCodec = {
        async render(...args) {
          renders++;
          const result = await codec.render(...args);
          if (stage === 'render') controller.abort();
          return result;
        },
        async encodeJpeg(...args) {
          encodes++;
          const result = await codec.encodeJpeg(...args);
          if (stage === 'encode') controller.abort();
          return result;
        },
      };
      await expect(
        compressPdf(await doc.save(), { codec: cancelledCodec, signal: controller.signal }).then(
          ({ images }) => ({ images }),
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(renders).toBe(1);
      expect(encodes).toBe(stage === 'render' ? 0 : 1);
    },
  );
  it.each([0.5, 2])(
    'measures pictures on a UserUnit %s page at the size they print',
    async (unit) => {
      const doc = await PDFDocument.create();
      const jpeg = await doc.embedJpg(await picture(2400, 2400).encode('jpeg', 95));
      const page = doc.addPage([300, 300]);
      // Each PDF coordinate unit occupies `unit` physical points on paper.
      page.node.set(PDFName.of('UserUnit'), PDFNumber.of(unit));
      page.drawImage(jpeg, { x: 25, y: 25, width: 250, height: 250 });
      const original = await doc.save();
      const result = await compressPdf(original, { level: 'balanced', codec });
      expect(result.images).toBe(1);
      expect(result.after).toBeLessThan(result.before / 3);
      expect(difference(await view(original), await view(result.bytes))).toBeLessThan(6);
      expect(image(pageImage(await PDFDocument.load(result.bytes)).dict)).toBe(
        Math.round(((250 * unit) / 72) * 150),
      );
    },
  );
  it('passes over content entries that are not streams', async () => {
    const doc = await PDFDocument.create();
    const jpeg = await doc.embedJpg(await picture(2400, 1800).encode('jpeg', 95));
    const page = doc.addPage([400, 500]);
    page.drawImage(jpeg, { x: 50, y: 150, width: 300, height: 225 });
    // Some writers leave a reference to a missing object, or to a dictionary, in Contents.
    const stray = doc.context.register(doc.context.obj({ Type: 'Stray' }));
    page.node.set(
      PDFName.of('Contents'),
      doc.context.obj([...page.node.Contents().asArray(), PDFRef.of(9999), stray]),
    );
    const original = await doc.save();
    const before = await view(original);
    const result = await compressPdf(original, { level: 'balanced', codec });
    expect(result.images).toBe(1);
    expect(difference(before, await view(result.bytes))).toBeLessThan(6);
  });
  it('drops objects left behind by earlier edits and page thumbnails', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    page.drawText('Kept text', { x: 20, y: 200, size: 20 });
    // Incompressible leftovers, like an image an edit replaced.
    const noise = Uint8Array.from({ length: 50000 }, (_, i) => (i * 2654435761) >>> 24);
    const orphan = doc.context.register(doc.context.stream(noise, { Filter: 'DCTDecode' }));
    const thumb = doc.context.register(
      doc.context.flateStream(new Uint8Array(3000).fill(1), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 50,
        Height: 60,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 8,
      }),
    );
    page.node.set(PDFName.of('Thumb'), thumb);
    expect(doc.context.lookup(orphan)).toBeInstanceOf(PDFRawStream);
    const original = await doc.save();
    const result = await compressPdf(original, { level: 'balanced', codec });
    expect(result.thumbnails).toBe(1);
    expect(result.removed).toBeGreaterThanOrEqual(2);
    expect(result.after).toBeLessThan(result.before - 40000);
    const shrunk = await PDFDocument.load(result.bytes);
    expect(shrunk.getPage(0).node.has(PDFName.of('Thumb'))).toBe(false);
    expect((await view(result.bytes)).text).toBe('Kept text');
    // Sweeping alone never touches a reachable object.
    const intact = await PDFDocument.load(await samplePdf());
    const count = intact.context.enumerateIndirectObjects().length;
    sweepUnreferenced(intact.context);
    expect(intact.context.enumerateIndirectObjects().length).toBe(count);
  });
  it('keeps a PDF/A-1 file free of object streams', async () => {
    const { convertToPdfA, pdfaSaveOptions, preflightPdfA } = await import('../src/core/pdfa.js');
    const { readFileSync } = await import('node:fs');
    const assets = new URL('../node_modules/pdfjs-dist/', import.meta.url);
    const source = await PDFDocument.create();
    source.setTitle('Archive');
    const page = source.addPage([300, 300]);
    page.drawText('Kept text', { x: 20, y: 200, size: 20 });
    page.node.set(PDFName.of('Thumb'), source.context.register(source.context.stream('thumb')));
    const doc = await PDFDocument.load(await source.save());
    const report = await convertToPdfA(doc, {
      part: 1,
      conformance: 'b',
      loadAsset: async (path) => new Uint8Array(readFileSync(new URL(path, assets))),
    });
    expect(report.compliant).toBe(true);
    const result = await compressPdf(await doc.save(pdfaSaveOptions(1)), {
      level: 'balanced',
      codec,
    });
    expect(result.thumbnails).toBe(1);
    const shrunk = await PDFDocument.load(result.bytes, { updateMetadata: false });
    const issues = preflightPdfA(shrunk, { part: 1, conformance: 'b', bytes: result.bytes })
      .issues.filter((issue) => issue.severity === 'error')
      .map((issue) => issue.message);
    expect(issues).toEqual([]);
  });
  it('reports when nothing worth saving is left and rejects unknown levels', async () => {
    const compact = (await compressPdf(await samplePdf(), { level: 'balanced', codec })).bytes;
    const again = await compressPdf(compact, { level: 'balanced', codec });
    expect(again.images).toBe(0);
    expect(again.after).toBeGreaterThan(again.before * 0.97);
    await expect(compressPdf(compact, { level: 'tiny', codec })).rejects.toThrow('how much');
    // Without a codec the lossless steps still run.
    const doc = await PDFDocument.load(compact);
    const stats = await compressDocument(doc, { level: 'smallest' });
    expect(stats.images).toBe(0);
  });
  it('becomes one undoable step in a session', async () => {
    const doc = await PDFDocument.create();
    const jpeg = await doc.embedJpg(await picture(2400, 1800).encode('jpeg', 95));
    doc.addPage([400, 500]).drawImage(jpeg, { x: 50, y: 150, width: 300, height: 225 });
    const session = new PdfSession(await doc.save());
    const before = session.bytes;
    const result = await compressPdf(session.bytes, { level: 'balanced', codec });
    session.adopt(result.bytes);
    expect(session.bytes).toBe(result.bytes);
    expect(session.dirty).toBe(true);
    expect(session.undo()).toBe(true);
    expect(session.bytes).toBe(before);
    expect(session.redo()).toBe(true);
    expect(session.bytes).toBe(result.bytes);
  });
});
