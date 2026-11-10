import { expect, it } from 'vitest';
import { PDFDocument, PDFName, degrees, rgb, BlendMode } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  inspectImages,
  editImage,
  imagePreview,
  constrainImage,
  rotateAroundCenter,
  replaceImage,
  MAX_IMAGE_SIZE,
  point,
} from '../src/core/image-edit.js';
import { PdfSession } from '../src/core/document.js';
import { pageSource } from '../src/core/text-edit.js';

function imagePng() {
  const canvas = createCanvas(40, 30),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = '#cc2200';
  ctx.fillRect(0, 0, 20, 30);
  ctx.fillStyle = '#0088ff';
  ctx.fillRect(20, 0, 20, 15);
  return canvas.toBuffer('image/png');
}
async function fixture() {
  const doc = await PDFDocument.create(),
    image = await doc.embedPng(imagePng());
  const page = doc.addPage([400, 400]);
  page.drawRectangle({ x: 0, y: 0, width: 400, height: 400, color: rgb(0.8, 0.9, 0.7) });
  page.drawImage(image, { x: 40, y: 240, width: 80, height: 60 });
  page.drawImage(image, { x: 240, y: 240, width: 80, height: 60 });
  page.drawText('Unchanged caption', { x: 40, y: 330, size: 18 });
  return PDFDocument.load(await doc.save());
}
async function raster(bytes, index = 0, transparent = false) {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
      .pathname,
  });
  try {
    const page = await (await task.promise).getPage(index + 1),
      viewport = page.getViewport({ scale: 1 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height)),
      ctx = canvas.getContext('2d');
    await page.render({
      canvasContext: ctx,
      viewport,
      ...(transparent ? { background: 'rgba(0,0,0,0)' } : {}),
    }).promise;
    return {
      pixels: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
      text: (await page.getTextContent()).items.map((i) => i.str).join(''),
      width: canvas.width,
      height: canvas.height,
    };
  } finally {
    await task.destroy();
  }
}

it('moves and resizes one reused image without changing any pixels outside its old/new placements', async () => {
  const doc = await fixture(),
    before = await raster(await doc.save());
  const entries = inspectImages(doc, 0);
  expect(entries).toHaveLength(2);
  expect(entries.every((i) => i.editable)).toBe(true);
  const imageData = entries[0].object.getContents().slice();
  editImage(doc, 0, entries[0], { transform: [120, 0, 0, 90, 60, 110] });
  const bytes = await doc.save(),
    after = await raster(bytes),
    reopened = await PDFDocument.load(bytes);
  const images = inspectImages(reopened, 0);
  images[0].transform.forEach((n, i) => expect(n).toBeCloseTo([120, 0, 0, 90, 60, 110][i], 8));
  expect(images[1].transform).toEqual(entries[1].transform);
  expect(images[0].object.getContents()).toEqual(imageData);
  expect(after.text).toBe(before.text);
  let changed = 0,
    outside = 0;
  for (let y = 0; y < 400; y++)
    for (let x = 0; x < 400; x++) {
      const i = (y * 400 + x) * 4;
      if (before.pixels.slice(i, i + 4).some((n, j) => n !== after.pixels[i + j])) {
        changed++;
        if (!(
          (x >= 40 && x < 120 && y >= 100 && y < 160) ||
          (x >= 60 && x < 180 && y >= 200 && y < 290)
        ))
          outside++;
      }
    }
  expect(changed).toBeGreaterThan(8000);
  expect(outside).toBe(0);
});

it('isolates one placement inside nested shared Form XObjects and keeps other pages identical', async () => {
  const doc = await fixture(),
    image = inspectImages(doc, 0)[0].object;
  const inner = doc.context.register(
    doc.context.flateStream('q 80 0 0 60 40 140 cm /Picture Do Q', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 400, 400],
      Resources: { XObject: { Picture: doc.context.getObjectRef(image) } },
    }),
  );
  const outer = doc.context.register(
    doc.context.flateStream('/Inner Do', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 400, 400],
      Resources: { XObject: { Inner: inner } },
    }),
  );
  doc.getPage(0).node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { Shared: outer } }));
  doc
    .getPage(0)
    .node.set(
      PDFName.of('Contents'),
      doc.context.register(
        doc.context.flateStream('q /Shared Do Q q 1 0 0 1 200 0 cm /Shared Do Q'),
      ),
    );
  const second = doc.addPage([400, 400]);
  second.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { Shared: outer } }));
  second.node.set(
    PDFName.of('Contents'),
    doc.context.register(doc.context.flateStream('/Shared Do')),
  );
  const before = await doc.save(),
    other = await raster(before, 1),
    original = inspectImages(doc, 0);
  editImage(doc, 0, original[0], { transform: [100, 0, 0, 75, 60, 220] });
  const bytes = await doc.save(),
    reopened = await PDFDocument.load(bytes),
    entries = inspectImages(reopened, 0);
  expect(entries[0].transform).toEqual([100, 0, 0, 75, 60, 220]);
  expect(entries[1].transform).toEqual(original[1].transform);
  expect((await raster(bytes, 1)).pixels).toEqual(other.pixels);
  expect(inspectImages(reopened, 1)[0].transform).toEqual(original[0].transform);
});

it('supports skewed and mirrored placements, deletion, repeat editing, and exact undo without stale edits', async () => {
  const doc = await fixture();
  editImage(doc, 0, inspectImages(doc, 0)[0], { transform: [-80, 20, 15, 60, 140, 240] });
  const bytes = await doc.save(),
    session = new PdfSession(bytes),
    entry = inspectImages(await PDFDocument.load(bytes), 0)[0];
  await session.change((d) =>
    editImage(d, 0, entry, { transform: [-100, 25, 18.75, 75, 160, 120] }),
  );
  const changed = session.bytes.slice();
  await expect(session.change((d) => editImage(d, 0, entry, { remove: true }))).rejects.toThrow(
    'changed',
  );
  expect(session.bytes).toEqual(changed);
  const next = inspectImages(await PDFDocument.load(changed), 0)[0];
  await session.change((d) => editImage(d, 0, next, { remove: true }));
  expect(inspectImages(await PDFDocument.load(session.bytes), 0)).toHaveLength(1);
  session.undo();
  session.undo();
  expect(session.bytes).toEqual(bytes);
  session.redo();
  expect(session.bytes).toEqual(changed);
});

it('honors clipping frames and avoids edits to partially clipped or stencil images', async () => {
  const doc = await fixture(),
    page = doc.getPage(0),
    image = inspectImages(doc, 0)[0].object;
  page.node.set(
    PDFName.of('Resources'),
    doc.context.obj({ XObject: { Image: doc.context.getObjectRef(image) } }),
  );
  page.node.set(
    PDFName.of('Contents'),
    doc.context.register(
      doc.context.flateStream(
        'q 30 200 160 120 re W n 80 0 0 60 40 240 cm /Image Do Q q 30 200 20 20 re W n 80 0 0 60 40 240 cm /Image Do Q',
      ),
    ),
  );
  const entries = inspectImages(doc, 0);
  expect(entries.map((i) => i.editable)).toEqual([true, false]);
  const desired = [80, 0, 0, 60, 200, 240],
    constrained = constrainImage(entries[0], desired);
  expect(constrained).toEqual([80, 0, 0, 60, 110, 240]);
  expect(() => editImage(doc, 0, entries[0], { transform: desired })).toThrow('original frame');
  expect(() => editImage(doc, 0, entries[1], { remove: true })).toThrow('cannot yet');
  editImage(doc, 0, entries[0], { transform: constrained });
  image.dict.set(PDFName.of('ImageMask'), doc.context.obj(true));
  expect(inspectImages(doc, 0).every((i) => !i.editable)).toBe(true);
});

it('creates transparent image previews and treats unchanged geometry as a no-op', async () => {
  const doc = await fixture(),
    bytes = await doc.save(),
    entry = inspectImages(doc, 0)[0];
  const preview = await raster(await imagePreview(doc, entry), 0, true);
  expect([preview.width, preview.height]).toEqual([40, 30]);
  const pixel = (x, y) => [...preview.pixels.slice((y * 40 + x) * 4, (y * 40 + x) * 4 + 4)];
  expect(pixel(5, 5)).toEqual([204, 34, 0, 255]);
  expect(pixel(35, 25)[3]).toBe(0);
  const session = new PdfSession(bytes);
  await session.change((d) => editImage(d, 0, entry, { transform: entry.transform }));
  expect(session.past).toHaveLength(0);
  expect(session.bytes).toEqual(bytes);
});

it('rotates a reused image around its center with reference pixels, unchanged neighbors, and exact undo', async () => {
  const doc = await fixture(),
    bytes = await doc.save(),
    session = new PdfSession(bytes);
  const original = inspectImages(doc, 0)[0],
    imageBytes = original.object.getContents().slice();
  await session.change((d) =>
    editImage(d, 0, inspectImages(d, 0)[0], {
      transform: rotateAroundCenter(original.transform, -90),
    }),
  );
  const reference = await PDFDocument.load(bytes),
    entry = inspectImages(reference, 0)[0];
  const image = await reference.embedPng(imagePng());
  editImage(reference, 0, entry, { remove: true });
  reference
    .getPage(0)
    .drawImage(image, { x: 50, y: 310, width: 80, height: 60, rotate: degrees(-90) });
  expect(
    Buffer.from((await raster(session.bytes)).pixels).equals(
      Buffer.from((await raster(await reference.save())).pixels),
    ),
  ).toBe(true);
  const reopened = await PDFDocument.load(session.bytes),
    paths = inspectImages(reopened, 0);
  expect(paths[0].object.getContents()).toEqual(imageBytes);
  expect(paths[1].transform).toEqual(inspectImages(doc, 0)[1].transform);
  expect(point(paths[0].transform, 0.5, 0.5)).toEqual(point(original.transform, 0.5, 0.5));
  for (let i = 0; i < 3; i++)
    await session.change((d) => {
      const item = inspectImages(d, 0)[0];
      editImage(d, 0, item, { transform: rotateAroundCenter(item.transform, -90) });
    });
  expect(
    Buffer.from((await raster(session.bytes)).pixels).equals(
      Buffer.from((await raster(bytes)).pixels),
    ),
  ).toBe(true);
  for (let i = 0; i < 4; i++) session.undo();
  expect(session.bytes).toEqual(bytes);
});

it.each([
  [80, 0, 0, 60, 40, 100],
  [-80, 0, 0, 60, 120, 100],
  [80, 15, 12, 60, 40, 100],
])(
  'arbitrary rotation preserves center, dimensions, skew, and reflection for %j',
  (...transform) => {
    const next = rotateAroundCenter(transform, 37.5);
    point(next, 0.5, 0.5).forEach((n, i) =>
      expect(n).toBeCloseTo(point(transform, 0.5, 0.5)[i], 10),
    );
    for (const axis of [0, 2])
      expect(Math.hypot(next[axis], next[axis + 1])).toBeCloseTo(
        Math.hypot(transform[axis], transform[axis + 1]),
        10,
      );
    expect(next[0] * next[2] + next[1] * next[3]).toBeCloseTo(
      transform[0] * transform[2] + transform[1] * transform[3],
      10,
    );
    expect(next[0] * next[3] - next[1] * next[2]).toBeCloseTo(
      transform[0] * transform[3] - transform[1] * transform[2],
      10,
    );
    rotateAroundCenter(next, -37.5).forEach((n, i) => expect(n).toBeCloseTo(transform[i], 10));
    expect(rotateAroundCenter(transform, 360)).toEqual(transform);
  },
);

it('rejects rotation outside a clipping frame without changing the PDF or distorting the image', async () => {
  const doc = await fixture(),
    image = inspectImages(doc, 0)[0].object;
  doc
    .getPage(0)
    .node.set(
      PDFName.of('Resources'),
      doc.context.obj({ XObject: { Picture: doc.context.getObjectRef(image) } }),
    );
  doc
    .getPage(0)
    .node.set(
      PDFName.of('Contents'),
      doc.context.register(
        doc.context.flateStream('q 40 220 80 60 re W n 80 0 0 60 40 220 cm /Picture Do Q'),
      ),
    );
  const entry = inspectImages(doc, 0)[0],
    bytes = await doc.save();
  expect(() =>
    editImage(doc, 0, entry, { transform: rotateAroundCenter(entry.transform, 90) }),
  ).toThrow('frame');
  expect(await doc.save()).toEqual(bytes);
  expect(() => rotateAroundCenter(entry.transform, NaN)).toThrow('angle');
});

function replacementFile(type = 'png') {
  const canvas = createCanvas(30, 60),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(0,170,68,0.45)';
  ctx.fillRect(0, 0, 20, 60);
  ctx.fillStyle = '#ff8800';
  ctx.fillRect(0, 0, 8, 12);
  return canvas.toBuffer(`image/${type}`);
}

it.each(['png', 'jpeg'])(
  'replaces one %s image with exact reference pixels, aspect fit, transparency, blend settings, and undo',
  async (type) => {
    const doc = await fixture(),
      page = doc.getPage(0),
      original = inspectImages(doc, 0)[0];
    page.node
      .Resources()
      .set(PDFName.of('ExtGState'), doc.context.obj({ Paint: { ca: 0.6, BM: 'Multiply' } }));
    page.node
      .Resources()
      .lookup(PDFName.of('XObject'))
      .set(PDFName.of('ReplacementImage1'), doc.context.getObjectRef(original.object));
    page.node.set(
      PDFName.of('Contents'),
      doc.context.register(
        doc.context.flateStream(
          pageSource(page).replace(original.source, `/Paint gs ${original.source}`),
        ),
      ),
    );
    // Foreground content must stay above the replacement, including transparent PNGs.
    page.drawRectangle({ x: 75, y: 255, width: 10, height: 10, color: rgb(0, 0, 1) });
    const bytes = await doc.save(),
      session = new PdfSession(bytes),
      file = replacementFile(type);
    await session.change((d) => replaceImage(d, 0, inspectImages(d, 0)[0], file));
    const reference = await PDFDocument.load(bytes),
      entry = inspectImages(reference, 0)[0];
    editImage(reference, 0, entry, { remove: true });
    const image = type === 'png' ? await reference.embedPng(file) : await reference.embedJpg(file);
    reference.getPage(0).drawImage(image, {
      x: 65,
      y: 240,
      width: 30,
      height: 60,
      opacity: 0.6,
      blendMode: BlendMode.Multiply,
    });
    reference
      .getPage(0)
      .drawRectangle({ x: 75, y: 255, width: 10, height: 10, color: rgb(0, 0, 1) });
    expect(
      Buffer.from((await raster(session.bytes)).pixels).equals(
        Buffer.from((await raster(await reference.save())).pixels),
      ),
    ).toBe(true);
    const reopened = await PDFDocument.load(session.bytes),
      images = inspectImages(reopened, 0);
    expect(images[0].transform).toEqual([30, 0, 0, 60, 65, 240]);
    expect(images[0].opacity).toBe(0.6);
    expect(images[0].blend).toBe('Multiply');
    expect(images[0].editable).toBe(true);
    expect(images[0].object).not.toBe(images[1].object);
    expect(images[1].object.getContents()).toEqual(original.object.getContents());
    expect(images[1].transform).toEqual(inspectImages(doc, 0)[1].transform);
    if (type === 'png') {
      expect(images[0].object.dict.has(PDFName.of('SMask'))).toBe(true);
      const preview = await raster(await imagePreview(reopened, images[0]), 0, true);
      expect(preview.pixels.some((v, i) => i % 4 === 3 && v > 0 && v < 255)).toBe(true);
    } else expect(images[0].object.dict.lookup(PDFName.of('Filter')).toString()).toBe('/DCTDecode');
    const replaced = session.bytes;
    session.undo();
    expect(session.bytes).toEqual(bytes);
    session.redo();
    expect(session.bytes).toEqual(replaced);
  },
);

it('replaces only one occurrence through nested shared forms and preserves all pixels on the other page', async () => {
  const doc = await fixture(),
    image = inspectImages(doc, 0)[0].object;
  const inner = doc.context.register(
    doc.context.flateStream('80 0 0 60 40 240 cm /Picture Do', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 400, 400],
      Resources: { XObject: { Picture: doc.context.getObjectRef(image) } },
    }),
  );
  const outer = doc.context.register(
    doc.context.flateStream('/Inner Do', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 400, 400],
      Resources: { XObject: { Inner: inner } },
    }),
  );
  const resources = doc.context.obj({ XObject: { Outer: outer } });
  doc.getPage(0).node.set(PDFName.of('Resources'), resources);
  doc
    .getPage(0)
    .node.set(
      PDFName.of('Contents'),
      doc.context.register(doc.context.flateStream('/Outer Do q 1 0 0 1 200 0 cm /Outer Do Q')),
    );
  const other = doc.addPage([400, 400]);
  other.node.set(PDFName.of('Resources'), resources);
  other.node.set(
    PDFName.of('Contents'),
    doc.context.register(doc.context.flateStream('/Outer Do')),
  );
  const before = await raster(await doc.save(), 1);
  await replaceImage(doc, 0, inspectImages(doc, 0)[0], replacementFile());
  const result = await PDFDocument.load(await doc.save()),
    images = inspectImages(result, 0);
  expect(images[0].object.getContents()).not.toEqual(image.getContents());
  expect(images[1].object.getContents()).toEqual(image.getContents());
  expect(images[0].path[0].name).not.toBe(images[1].path[0].name);
  expect(
    Buffer.from((await raster(await result.save(), 1)).pixels).equals(Buffer.from(before.pixels)),
  ).toBe(true);
});

it.each([
  [80, 0, 0, 60, 40, 240],
  [-80, 0, 0, 60, 120, 240],
  [60, 40, -30, 60, 60, 200],
])(
  'replacement fits and preserves a transformed image center, skew, and reflection for %j',
  async (...transform) => {
    const doc = await fixture();
    editImage(doc, 0, inspectImages(doc, 0)[0], { transform });
    const entry = inspectImages(doc, 0)[0];
    await replaceImage(doc, 0, entry, replacementFile());
    const next = inspectImages(await PDFDocument.load(await doc.save()), 0)[0].transform;
    point(next, 0.5, 0.5).forEach((n, i) =>
      expect(n).toBeCloseTo(point(transform, 0.5, 0.5)[i], 8),
    );
    const width = Math.hypot(next[0], next[1]),
      height = Math.hypot(next[2], next[3]);
    expect(width / height).toBeCloseTo(0.5, 8);
    expect(width).toBeLessThanOrEqual(Math.hypot(transform[0], transform[1]) + 1e-8);
    expect(height).toBeLessThanOrEqual(Math.hypot(transform[2], transform[3]) + 1e-8);
    for (const axis of [0, 2])
      for (const component of [0, 1])
        expect(next[axis + component] / Math.hypot(next[axis], next[axis + 1])).toBeCloseTo(
          transform[axis + component] / Math.hypot(transform[axis], transform[axis + 1]),
          8,
        );
  },
);

it('rejects invalid replacements and stale selections without writing any target PDF bytes', async () => {
  const doc = await fixture(),
    entry = inspectImages(doc, 0)[0],
    bytes = await doc.save();
  for (const file of [
    new Uint8Array(),
    new Uint8Array([1, 2, 3]),
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    new Uint8Array([255, 216, 255]),
    new Uint8Array(MAX_IMAGE_SIZE + 1),
  ]) {
    await expect(replaceImage(doc, 0, entry, file)).rejects.toThrow(/PNG|20 MB/);
    expect(await doc.save()).toEqual(bytes);
  }
  editImage(doc, 0, entry, { transform: [80, 0, 0, 60, 50, 240] });
  const moved = await doc.save();
  await expect(replaceImage(doc, 0, entry, replacementFile())).rejects.toThrow('changed');
  expect(await doc.save()).toEqual(moved);
});

it('keeps indexing images when another block of the page is drawn under a singular matrix', async () => {
  // A zero matrix around some hidden content is a common pattern; it must not take the page's
  // images with it, wherever it sits and whatever rectangle it draws.
  const contents = [
    'q 0 0 0 0 0 0 cm 0 0 10 10 re f Q q 100 0 0 80 50 50 cm /Im Do Q',
    'q 100 0 0 80 50 50 cm /Im Do Q q 0 0 0 0 0 0 cm 0 0 10 10 re f Q',
    'q 1 0 0 0 0 0 cm 0 0 10 10 re f Q q 100 0 0 80 50 50 cm /Im Do Q',
    // A clip drawn under a singular matrix cannot be trusted, so the image inside it is not editable.
    'q 0 0 0 0 0 0 cm 0 0 10 10 re W n 100 0 0 80 50 50 cm /Im Do Q',
  ];
  for (const [k, content] of contents.entries()) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    const image = await doc.embedPng(imagePng());
    await image.embed();
    page.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { Im: image.ref } }));
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content)));
    const images = inspectImages(doc, 0);
    expect(images, content).toHaveLength(1);
    expect(images[0].editable, content).toBe(k < 3);
  }
});

it('finds the images of a page whose content ends with a stray Q, as readers draw it', async () => {
  const doc = await fixture(),
    page = doc.getPage(0);
  const contents = page.node.Contents();
  const stray = doc.context.register(doc.context.flateStream('Q'));
  page.node.set(
    PDFName.of('Contents'),
    doc.context.obj([
      ...(contents.asArray ? contents.asArray() : [page.node.get(PDFName.of('Contents'))]),
      stray,
    ]),
  );
  const entries = inspectImages(doc, 0);
  expect(entries).toHaveLength(2);
  expect(entries.every((i) => i.editable)).toBe(true);
});
