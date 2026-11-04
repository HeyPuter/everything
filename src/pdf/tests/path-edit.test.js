import { expect, it } from 'vitest';
import { PDFDocument, PDFName, rgb } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { inspectPaths, editPath, pathPreview, pathColorHex } from '../src/core/path-edit.js';
import { PdfSession, drawMark } from '../src/core/document.js';

async function raw(source) {
  const doc = await PDFDocument.create(),
    page = doc.addPage([400, 400]);
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(source)));
  return doc;
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
      width: canvas.width,
      height: canvas.height,
      text: (await page.getTextContent()).items.map((i) => i.str).join(''),
    };
  } finally {
    await task.destroy();
  }
}

it('moves and resizes native paths while every pixel outside their old/new bounds stays unchanged', async () => {
  const doc = await PDFDocument.create(),
    page = doc.addPage([400, 400]);
  page.drawRectangle({ x: 0, y: 0, width: 400, height: 400, color: rgb(0.8, 0.9, 0.7) });
  page.drawRectangle({
    x: 40,
    y: 240,
    width: 80,
    height: 60,
    color: rgb(0.9, 0.1, 0.1),
    borderColor: rgb(0, 0, 0),
    borderWidth: 2,
  });
  page.drawText('Unchanged caption', { x: 40, y: 330, size: 18 });
  page.drawRectangle({
    x: 240,
    y: 240,
    width: 80,
    height: 60,
    borderColor: rgb(0, 0, 1),
    borderWidth: 2,
  });
  const entries = inspectPaths(doc, 0),
    before = await raster(await doc.save());
  expect(entries).toHaveLength(3);
  expect(entries[1].bounds).toEqual([-1, -1, 81, 61]);
  const target = [123, 0, 0, 93, 60, 110];
  editPath(doc, 0, entries[1], { transform: target });
  const bytes = await doc.save(),
    after = await raster(bytes),
    next = inspectPaths(await PDFDocument.load(bytes), 0);
  next[1].transform.forEach((v, i) => expect(v).toBeCloseTo(target[i], 8));
  expect(next[2].transform).toEqual(entries[2].transform);
  expect(after.text).toBe(before.text);
  let changed = 0,
    outside = 0;
  for (let y = 0; y < 400; y++)
    for (let x = 0; x < 400; x++) {
      const i = (y * 400 + x) * 4;
      if (before.pixels.slice(i, i + 4).some((v, j) => v !== after.pixels[i + j])) {
        changed++;
        if (!(
          (x >= 39 && x < 121 && y >= 99 && y < 161) ||
          (x >= 60 && x < 183 && y >= 197 && y < 290)
        ))
          outside++;
      }
    }
  expect(changed).toBeGreaterThan(10000);
  expect(outside).toBe(0);
});

it('isolates paths in nested shared Forms without changing other placements or pages', async () => {
  const doc = await raw('q /Shared Do Q q 1 0 0 1 200 0 cm /Shared Do Q');
  const inner = doc.context.register(
    doc.context.flateStream('1 0 0 rg 40 140 80 60 re f', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 400, 400],
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
  const resources = doc.context.obj({ XObject: { Shared: outer } });
  doc.getPage(0).node.set(PDFName.of('Resources'), resources);
  const page = doc.addPage([400, 400]);
  page.node.set(PDFName.of('Resources'), resources);
  page.node.set(
    PDFName.of('Contents'),
    doc.context.register(doc.context.flateStream('/Shared Do')),
  );
  const before = await raster(await doc.save(), 1),
    entries = inspectPaths(doc, 0);
  expect(entries).toHaveLength(2);
  editPath(doc, 0, entries[0], { transform: [100, 0, 0, 75, 60, 220] });
  const bytes = await doc.save(),
    reopened = await PDFDocument.load(bytes),
    next = inspectPaths(reopened, 0);
  expect(next[0].transform).toEqual([100, 0, 0, 75, 60, 220]);
  expect(next[1].transform).toEqual(entries[1].transform);
  expect((await raster(bytes, 1)).pixels).toEqual(before.pixels);
  expect(inspectPaths(reopened, 1)[0].transform).toEqual(entries[0].transform);
});

it('keeps persistent graphics state and following paths intact through move, delete, undo and reopen', async () => {
  const doc = await raw(
    '1 0 0 RG 3 w 1 J 1 j 40 220 m 80 260 l 120 220 l S 200 220 m 240 260 l 280 220 l S',
  );
  const bytes = await doc.save(),
    session = new PdfSession(bytes),
    entries = inspectPaths(doc, 0);
  expect(entries.every((e) => e.kind === 'drawing' && e.editable)).toBe(true);
  expect(editPath(doc, 0, entries[0])).toBe(false);
  const target = [...entries[0].transform];
  target[4] += 20;
  target[5] -= 80;
  await session.change((d) => editPath(d, 0, entries[0], { transform: target }));
  const changed = session.bytes.slice(),
    reopened = await PDFDocument.load(changed),
    next = inspectPaths(reopened, 0);
  expect(next[1].state.stroke).toBe('1 0 0 RG');
  expect(next[1].state.width).toBe(3);
  expect(next[1].transform).toEqual(entries[1].transform);
  await expect(session.change((d) => editPath(d, 0, entries[0], { remove: true }))).rejects.toThrow(
    'changed',
  );
  expect(session.bytes).toEqual(changed);
  await session.change((d) => editPath(d, 0, next[0], { remove: true }));
  expect(inspectPaths(await PDFDocument.load(session.bytes), 0)).toHaveLength(1);
  session.undo();
  session.undo();
  expect(session.bytes).toEqual(bytes);
  session.redo();
  expect(session.bytes).toEqual(changed);
});

it('excludes clipping paths, partially clipped shapes and interleaved path state without hiding supported neighbors', async () => {
  const doc = await raw(
    'q 0 0 100 100 re W n 10 10 20 20 re f 80 80 40 40 re f Q q 0 0 m 100 0 l 100 100 l W n 20 20 20 20 re f Q 20 20 m 2 w 40 40 l S 140 140 30 30 re f',
  );
  const entries = inspectPaths(doc, 0);
  expect(entries).toHaveLength(4);
  expect(entries.map((e) => e.editable)).toEqual([true, false, false, true]);
  expect(() => editPath(doc, 0, entries[0], { transform: [20, 0, 0, 20, 90, 90] })).toThrow(
    'frame',
  );
  expect(() => editPath(doc, 0, entries[1], { remove: true })).toThrow('cannot yet');
});

it('previews curves, even-odd fills, dash patterns and opacity using their original path appearance', async () => {
  const doc = await raw(
    'q /Fade gs 0 0 1 RG 1 0 0 rg 4 w 1 J 1 j [4 2] 1 d 40 40 m 40 120 120 120 120 40 c S 180 40 100 100 re 200 60 60 60 re f* Q',
  );
  doc
    .getPage(0)
    .node.set(
      PDFName.of('Resources'),
      doc.context.obj({ ExtGState: { Fade: { ca: 0.5, CA: 0.75 } } }),
    );
  const entries = inspectPaths(doc, 0);
  expect(entries[0].svg).toContain('C 40 120 120 120 120 40');
  expect(entries[1].fillRule).toBe('evenodd');
  for (const entry of entries) {
    const preview = await raster(await pathPreview(doc, entry), 0, true);
    expect([...preview.pixels].filter((v, i) => i % 4 === 3 && v > 0)).not.toHaveLength(0);
    expect(Math.max(...preview.pixels.filter((v, i) => i % 4 === 3))).toBeLessThan(255);
  }
  const preview = await raster(await pathPreview(doc, entries[1]), 0, true);
  expect(preview.pixels[((preview.height / 2) * preview.width + preview.width / 2) * 4 + 3]).toBe(
    0,
  );
});

it('saves a new freehand stroke as one connected editable path after reopening', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  drawMark(doc, 0, {
    type: 'ink',
    hex: '#0099ff',
    width: 4,
    points: [
      { x: 40, y: 40 },
      { x: 80, y: 90 },
      { x: 120, y: 40 },
      { x: 160, y: 90 },
    ],
  });
  const reopened = await PDFDocument.load(await doc.save()),
    paths = inspectPaths(reopened, 0);
  expect(paths).toHaveLength(1);
  expect(paths[0].kind).toBe('drawing');
  expect(paths[0].editable).toBe(true);
  expect(paths[0].state.cap).toBe(1);
  expect(paths[0].state.join).toBe(1);
  expect(paths[0].source.match(/ l/g)).toHaveLength(3);
  editPath(reopened, 0, paths[0], { remove: true });
  expect(inspectPaths(await PDFDocument.load(await reopened.save()), 0)).toHaveLength(0);
});

it('changes fill, stroke and width only on the selected native path without leaking graphics state', async () => {
  const doc = await raw('1 0 0 rg 0 0 1 RG 2 w 40 220 80 60 re B 240 220 80 60 re B');
  const original = inspectPaths(doc, 0),
    before = await raster(await doc.save());
  editPath(doc, 0, original[0], { style: { fill: '#00ff00', stroke: '#ff00ff', width: 8 } });
  const bytes = await doc.save(),
    paths = inspectPaths(await PDFDocument.load(bytes), 0),
    after = await raster(bytes);
  expect(pathColorHex(paths[0].state.fill)).toBe('#00ff00');
  expect(pathColorHex(paths[0].state.stroke)).toBe('#ff00ff');
  expect(paths[0].state.width).toBe(8);
  expect(paths[1].state.fill).toBe(original[1].state.fill);
  expect(paths[1].state.stroke).toBe(original[1].state.stroke);
  expect(paths[1].state.width).toBe(2);
  expect(paths[0].ctm).toEqual(original[0].ctm);
  let changed = 0,
    outside = 0;
  for (let y = 0; y < 400; y++)
    for (let x = 0; x < 400; x++) {
      const i = (y * 400 + x) * 4;
      if (before.pixels.slice(i, i + 4).some((v, j) => v !== after.pixels[i + j])) {
        changed++;
        if (!(x >= 36 && x < 124 && y >= 116 && y < 184)) outside++;
      }
    }
  expect(changed).toBeGreaterThan(5000);
  expect(outside).toBe(0);
});
it('validates styling, preserves no-op CMYK/gray colors, and rejects strokes outside a clip frame', async () => {
  const doc = await raw('q 0 0 100 100 re W n .4 G 0 1 1 0 k 2 w 2 2 40 40 re B Q');
  const entry = inspectPaths(doc, 0)[0];
  expect(editPath(doc, 0, entry, { style: { stroke: '#666666', fill: '#ff0000', width: 2 } })).toBe(
    false,
  );
  expect(() => editPath(doc, 0, entry, { style: { width: 8 } })).toThrow('frame');
  expect(() => editPath(doc, 0, entry, { style: { width: NaN } })).toThrow('width');
  expect(() => editPath(doc, 0, entry, { style: { stroke: 'bogus' } })).toThrow('color');
  expect(inspectPaths(doc, 0)[0].source).toBe(entry.source);
  editPath(doc, 0, entry, { style: { width: 0 } });
  expect(inspectPaths(doc, 0)[0].state.width).toBe(0);
});
it('restyles one shared Form occurrence and retains exact history through repeated edits', async () => {
  const doc = await raw('/Shared Do q 1 0 0 1 200 0 cm /Shared Do Q');
  const form = doc.context.register(
    doc.context.flateStream('0 0 1 RG 2 w 40 140 80 60 re S', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 400, 400],
    }),
  );
  doc.getPage(0).node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { Shared: form } }));
  const bytes = await doc.save(),
    session = new PdfSession(bytes),
    original = inspectPaths(doc, 0);
  await session.change((d) =>
    editPath(d, 0, original[0], { style: { stroke: '#009900', width: 4 } }),
  );
  const paths = inspectPaths(await PDFDocument.load(session.bytes), 0);
  expect(pathColorHex(paths[0].state.stroke)).toBe('#009900');
  expect(paths[1].state.stroke).toBe(original[1].state.stroke);
  const transformed = [...paths[0].transform];
  transformed[4] += 20;
  await session.change((d) => editPath(d, 0, paths[0], { transform: transformed }));
  expect(inspectPaths(await PDFDocument.load(session.bytes), 0)[0].state.width).toBe(4);
  const beforeHide = inspectPaths(await PDFDocument.load(session.bytes), 0);
  await session.change((d) => editPath(d, 0, beforeHide[0], { style: { stroked: false } }));
  const hidden = inspectPaths(await PDFDocument.load(session.bytes), 0);
  expect(hidden).toHaveLength(2);
  expect(hidden[0].invisible).toBe(true);
  expect(hidden[1].source).toBe(beforeHide[1].source);
  expect(hidden[1].transform).toEqual(beforeHide[1].transform);
  session.undo();
  session.undo();
  session.undo();
  expect(session.bytes).toEqual(bytes);
});

it.each(['S', 's', 'f', 'f*', 'B', 'B*', 'b', 'b*'])(
  'toggles %s painting without changing closure, fill rules, neighbors, or reopened editability',
  async (operator) => {
    const geometry = operator.includes('*')
        ? '40 220 80 60 re 55 235 50 30 re '
        : '40 220 m 120 220 l 80 280 l ',
      state = '0.8 0.2 0.1 rg 0.1 0.2 0.8 RG 2 w 1 j ',
      neighbor = '240 220 80 60 re B';
    let doc = await raw(state + geometry + operator + ' ' + neighbor);
    const original = inspectPaths(doc, 0)[0];
    const closure = ['s', 'b', 'b*'].includes(operator) ? 'h ' : '';
    for (const [filled, stroked] of [
      [true, false],
      [true, true],
      [false, true],
      [false, false],
      [true, true],
    ]) {
      const entry = inspectPaths(doc, 0)[0];
      editPath(doc, 0, entry, { style: { filled, stroked } });
      const bytes = await doc.save();
      doc = await PDFDocument.load(bytes);
      const next = inspectPaths(doc, 0);
      expect(next).toHaveLength(2);
      expect(next[0].filled).toBe(filled);
      expect(next[0].stroked).toBe(stroked);
      expect(next[0].kind).toBe(original.kind);
      expect(next[0].editable).toBe(true);
      expect(next[0].fillRule).toBe(original.fillRule);
      const paint = filled
        ? (stroked ? 'B' : 'f') + (operator.includes('*') ? '*' : '')
        : stroked
          ? 'S'
          : 'n';
      const reference = await raw(state + geometry + closure + paint + ' ' + neighbor);
      expect(
        Buffer.from((await raster(bytes)).pixels).equals(
          Buffer.from((await raster(await reference.save())).pixels),
        ),
      ).toBe(true);
      expect(editPath(doc, 0, next[0], { style: { filled, stroked } })).toBe(false);
    }
  },
);

it('retains unpainted degenerate drawings and ignores ordinary or invalid unpainted paths', async () => {
  let doc = await raw('2 w 1 J 1 j 40 220 m 120 220 l S 40 100 m 120 100 l n');
  editPath(doc, 0, inspectPaths(doc, 0)[0], { style: { stroked: false } });
  doc = await PDFDocument.load(await doc.save());
  let entries = inspectPaths(doc, 0);
  expect(entries).toHaveLength(1);
  expect(entries[0].invisible).toBe(true);
  expect(entries[0].editable).toBe(true);
  const moved = [...entries[0].transform];
  moved[5] -= 40;
  editPath(doc, 0, entries[0], { transform: moved });
  entries = inspectPaths(doc, 0);
  editPath(doc, 0, entries[0], { style: { stroked: true } });
  const expected = await raw('2 w 1 J 1 j 40 180 m 120 180 l S');
  expect((await raster(await doc.save())).pixels).toEqual(
    (await raster(await expected.save())).pixels,
  );
  editPath(doc, 0, inspectPaths(doc, 0)[0], { style: { stroked: false } });
  editPath(doc, 0, inspectPaths(doc, 0)[0], { remove: true });
  expect(inspectPaths(doc, 0)).toEqual([]);
  for (const hint of [
    '/V 2 /Kind /Shape /Rule /EvenOdd',
    '/V 1 /Kind /Bad /Rule /NonZero',
    '/V 1 /Kind /Shape /Rule /Bad',
  ]) {
    expect(inspectPaths(await raw(`/PuterPath << ${hint} >> BDC 40 40 30 30 re n EMC`), 0)).toEqual(
      [],
    );
  }
});

it('validates new outlines against clipping and keeps invalid toggle writes atomic', async () => {
  const doc = await raw('q 0 0 100 100 re W n 4 w 1 1 30 30 re f Q');
  const entry = inspectPaths(doc, 0)[0],
    bytes = await doc.save();
  expect(() => editPath(doc, 0, entry, { style: { stroked: true } })).toThrow('frame');
  expect(() => editPath(doc, 0, entry, { style: { filled: 0 } })).toThrow('enabled');
  expect(await doc.save()).toEqual(bytes);
  editPath(doc, 0, entry, { style: { stroked: true, width: 1, stroke: '#009900' } });
  expect(inspectPaths(doc, 0)[0].stroked).toBe(true);
});

it('changes fill and stroke opacity independently while preserving blend settings and neighboring pixels', async () => {
  const source = '/Shared gs 1 0 0 rg 0 0 1 RG 4 w 40 220 80 60 re B 240 220 80 60 re B';
  const states = {
    Shared: { Type: 'ExtGState', ca: 0.8, CA: 0.6, BM: 'Multiply' },
    PathOpacity1: { ca: 0.3 },
  };
  let doc = await raw(source);
  doc.getPage(0).node.set(PDFName.of('Resources'), doc.context.obj({ ExtGState: states }));
  const original = await raster(await doc.save());
  for (const [fillOpacity, strokeOpacity] of [
    [0.25, 0.6],
    [0.25, 0.75],
    [0, 0],
    [0.8, 0.6],
  ]) {
    const entry = inspectPaths(doc, 0)[0];
    editPath(doc, 0, entry, { style: { fillOpacity, strokeOpacity } });
    const bytes = await doc.save();
    doc = await PDFDocument.load(bytes);
    const paths = inspectPaths(doc, 0);
    expect(paths[0].state.alpha).toBe(fillOpacity);
    expect(paths[0].state.strokeAlpha).toBe(strokeOpacity);
    expect(paths[0].state.blend).toBe('Multiply');
    expect(paths[0].editable).toBe(true);
    expect(paths[0].invisible).toBe(fillOpacity === 0 && strokeOpacity === 0);
    expect(paths[1].state.alpha).toBe(0.8);
    expect(paths[1].state.strokeAlpha).toBe(0.6);
    const reference = await raw(
      source.replace('40 220 80 60 re B', 'q /Expected gs 40 220 80 60 re B Q'),
    );
    reference.getPage(0).node.set(
      PDFName.of('Resources'),
      reference.context.obj({
        ExtGState: { ...states, Expected: { ca: fillOpacity, CA: strokeOpacity } },
      }),
    );
    expect(
      Buffer.from((await raster(bytes)).pixels).equals(
        Buffer.from((await raster(await reference.save())).pixels),
      ),
    ).toBe(true);
    const unchanged = await doc.save();
    expect(editPath(doc, 0, paths[0], { style: { fillOpacity, strokeOpacity } })).toBe(false);
    expect(await doc.save()).toEqual(unchanged);
    if (!fillOpacity && !strokeOpacity) {
      const preview = await raster(await pathPreview(doc, paths[0]), 0, true);
      expect(preview.pixels.some((v, i) => i % 4 === 3 && v > 0)).toBe(false);
    }
  }
  expect(
    Buffer.from((await raster(await doc.save())).pixels).equals(Buffer.from(original.pixels)),
  ).toBe(true);
});

it('isolates opacity resources in nested shared forms and preserves other occurrences, pages, and undo', async () => {
  const doc = await raw('/Outer Do q 1 0 0 1 200 0 cm /Outer Do Q');
  const inner = doc.context.register(
    doc.context.flateStream('/Original gs 1 0 0 rg 0 0 1 RG 2 w 40 140 80 60 re B', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 400, 400],
      Resources: { ExtGState: { Original: { ca: 0.9, CA: 0.7 }, PathOpacity1: { ca: 0.4 } } },
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
  const page = doc.addPage([400, 400]);
  page.node.set(PDFName.of('Resources'), resources);
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream('/Outer Do')));
  const bytes = await doc.save(),
    before = await raster(bytes, 1),
    session = new PdfSession(bytes);
  await session.change((d) =>
    editPath(d, 0, inspectPaths(d, 0)[0], { style: { fillOpacity: 0.2, strokeOpacity: 0 } }),
  );
  const result = await PDFDocument.load(session.bytes),
    paths = inspectPaths(result, 0);
  expect(paths[0].state.alpha).toBe(0.2);
  expect(paths[0].state.strokeAlpha).toBe(0);
  expect(paths[1].state.alpha).toBe(0.9);
  expect(paths[1].state.strokeAlpha).toBe(0.7);
  expect(
    Buffer.from((await raster(session.bytes, 1)).pixels).equals(Buffer.from(before.pixels)),
  ).toBe(true);
  expect(paths[0].resources.lookup(PDFName.of('ExtGState'))).not.toBe(
    paths[1].resources.lookup(PDFName.of('ExtGState')),
  );
  session.undo();
  expect(session.bytes).toEqual(bytes);
});

it('rejects invalid opacity atomically and preserves unchanged source precision', async () => {
  const doc = await raw('/Original gs 40 40 80 60 re f');
  doc
    .getPage(0)
    .node.set(
      PDFName.of('Resources'),
      doc.context.obj({ ExtGState: { Original: { ca: 0.123456789 } } }),
    );
  const entry = inspectPaths(doc, 0)[0],
    bytes = await doc.save();
  for (const fillOpacity of [-0.1, 1.1, NaN, Infinity, null, '0.5'])
    expect(() => editPath(doc, 0, entry, { style: { fillOpacity } })).toThrow('opacity');
  expect(() => editPath(doc, 0, entry, { style: { strokeOpacity: 0.5 } })).toThrow('opacity');
  expect(editPath(doc, 0, entry, { style: { fillOpacity: 0.12345679 } })).toBe(false);
  expect(await doc.save()).toEqual(bytes);
});

it('keeps large drawings and their neighboring shapes editable', async () => {
  const geometry = Array.from(
    { length: 150000 },
    (_, i) => `${40 + (i % 80)} ${40 + (i % 60)} l`,
  ).join('\n');
  const doc = await raw(`1 J 1 j 2 w 10 10 20 20 re f 40 40 m\n${geometry}\nS 240 240 40 40 re f`);
  const paths = inspectPaths(doc, 0);
  expect(paths).toHaveLength(3);
  expect(paths.every((entry) => entry.editable)).toBe(true);
  expect(paths[1].bounds).toEqual([39, 39, 120, 100]);
  editPath(doc, 0, paths[1], { remove: true });
  const remaining = inspectPaths(await PDFDocument.load(await doc.save()), 0);
  expect(remaining).toHaveLength(2);
  expect(remaining.map((entry) => entry.source)).toEqual([paths[0].source, paths[2].source]);
});

it.each(['clip', 'form'])(
  'ignores a singular %s without disabling surrounding paths',
  async (kind) => {
    const singular = kind === 'clip' ? '0 0 100 100 re W n 10 10 20 20 re f' : '/Collapsed Do';
    const doc = await raw(`10 10 20 20 re f q 0 0 0 0 0 0 cm ${singular} Q 240 240 40 40 re f`);
    if (kind === 'form') {
      const form = doc.context.register(
        doc.context.flateStream('10 10 20 20 re f', {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 100, 100],
        }),
      );
      doc
        .getPage(0)
        .node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { Collapsed: form } }));
    }
    const paths = inspectPaths(doc, 0).filter((entry) => entry.editable);
    expect(paths).toHaveLength(2);
    editPath(doc, 0, paths[0], { style: { fill: '#ff0000' } });
    const next = inspectPaths(await PDFDocument.load(await doc.save()), 0).filter(
      (entry) => entry.editable,
    );
    expect(pathColorHex(next[0].state.fill)).toBe('#ff0000');
    expect(next[1].source).toBe(paths[1].source);
    expect(next[1].transform).toEqual(paths[1].transform);
  },
);

it('saves long freehand strokes without exceeding the JavaScript argument limit', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  const points = Array.from({ length: 150000 }, (_, i) => ({ x: 40 + (i % 80), y: 40 + (i % 60) }));
  drawMark(doc, 0, { type: 'ink', hex: '#0099ff', width: 2, points });
  const reopened = await PDFDocument.load(await doc.save());
  const paths = inspectPaths(reopened, 0);
  expect(paths).toHaveLength(1);
  expect(paths[0].editable).toBe(true);
  expect(paths[0].source.match(/ l/g)).toHaveLength(points.length - 1);
  expect(paths[0].state.cap).toBe(1);
  expect(paths[0].state.join).toBe(1);
});

it('finds the paths of a page whose content ends with a stray Q, as readers draw it', async () => {
  const doc = await raw('q 1 0 0 rg 10 10 50 50 re f Q Q');
  expect(inspectPaths(doc, 0)).toHaveLength(1);
});
