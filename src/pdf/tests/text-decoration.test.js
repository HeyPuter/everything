import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { addText } from '../src/core/document.js';
import { inspectText, pageSource } from '../src/core/text-edit.js';
import { groupTextRuns, replaceTextGroup } from '../src/core/text-group.js';
import { groupTextParagraphs } from '../src/core/text-paragraph.js';
import { inspectPaths } from '../src/core/path-edit.js';

const tasks = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tasks.splice(0).map((task) => task.destroy()));
});
async function read(bytes) {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    useSystemFonts: false,
    standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
      .pathname,
  });
  tasks.push(task);
  const page = await (await task.promise).getPage(1);
  const doc = await PDFDocument.load(bytes);
  const runs = await inspectText(doc, 0, page, pdfjs.OPS);
  return { doc, page, runs, groups: groupTextParagraphs(groupTextRuns(runs)) };
}
async function fixture(mixed = false, matrix = '1 0 0 1') {
  const doc = await PDFDocument.create(),
    page = doc.addPage([400, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F: font.ref } }));
  page.node.set(
    PDFName.of('Contents'),
    doc.context.register(
      doc.context.flateStream(
        `BT /F 20 Tf ${matrix} 70 220 Tm ${mixed ? '(Hello ) Tj (world) Tj' : '(Hello world) Tj'} 1 0 0 1 50 80 Tm (Neighbor) Tj ET`,
      ),
    ),
  );
  return doc.save();
}
async function pixels(parsed) {
  const canvas = createCanvas(400, 400),
    context = canvas.getContext('2d');
  await parsed.page.render({
    canvasContext: context,
    viewport: parsed.page.getViewport({ scale: 1 }),
  }).promise;
  return context.getImageData(0, 0, 400, 400).data;
}
function serveFonts() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (url) =>
      new Response(
        await readFile(
          new URL(`../public/fonts/${String(url).split('/fonts/').pop()}`, import.meta.url),
        ),
      ),
  );
}

for (const mixed of [false, true])
  for (const transform of ['1 0 0 1', '0 1 -1 0', '1.2 0.2 0.1 0.8'])
    it(`keeps decorations attached through move, resize, removal and reopening: mixed=${mixed}, ${transform}`, async () => {
      const before = await read(await fixture(mixed, transform));
      const group = before.groups[0];
      await replaceTextGroup(before.doc, 0, group, group.text, {
        underline: true,
        strikethrough: true,
      });
      const styled = await read(await before.doc.save());
      expect(styled.groups[0]).toMatchObject({
        text: 'Hello world',
        underline: true,
        strikethrough: true,
      });
      expect(styled.groups[0].paragraph).toBeUndefined();
      expect(styled.runs.at(-1).transform).toEqual(before.runs.at(-1).transform);
      expect(inspectPaths(styled.doc, 0)).toHaveLength(0);
      expect(await pixels(styled)).not.toEqual(await pixels(before));

      const saved = await styled.doc.save();
      await replaceTextGroup(styled.doc, 0, styled.groups[0], 'Hello world', { offset: [10, -15] });
      const moved = await read(await styled.doc.save());
      expect(moved.groups[0].transform[4]).toBeCloseTo(group.transform[4] + 10, 5);
      expect(moved.groups[0].transform[5]).toBeCloseTo(group.transform[5] - 15, 5);
      expect(moved.groups[0].underline).toBe(true);
      await replaceTextGroup(moved.doc, 0, moved.groups[0], 'Hello world', { size: 28 });
      const resized = await read(await moved.doc.save());
      expect(resized.groups[0].state.size).toBe(28);
      expect(resized.groups[0].strikethrough).toBe(true);

      const remove = await read(saved);
      await replaceTextGroup(remove.doc, 0, remove.groups[0], 'Hello world', {
        underline: false,
        strikethrough: false,
      });
      const plain = await read(await remove.doc.save());
      expect(plain.groups[0]).toMatchObject({ underline: false, strikethrough: false });
      expect(await pixels(plain)).toEqual(await pixels(before));
      await replaceTextGroup(resized.doc, 0, resized.groups[0], '');
      const deleted = await read(await resized.doc.save());
      expect(deleted.groups.map((g) => g.text)).toEqual(['Neighbor']);
      expect(pageSource(deleted.doc.getPage(0))).not.toContain('/PuterTextDecoration');
    });

it('restyles unchanged split text instead of treating the font change as a no-op', async () => {
  serveFonts();
  const parsed = await read(await fixture(true));
  await replaceTextGroup(parsed.doc, 0, parsed.groups[0], 'Hello world', {
    variant: 'boldItalic',
    underline: true,
  });
  const next = await read(await parsed.doc.save());
  expect(next.groups[0].parts.every((run) => run.fontName.includes('BoldItalic'))).toBe(true);
  expect(next.groups[0].underline).toBe(true);
  expect(next.runs.at(-1).transform).toEqual(parsed.runs.at(-1).transform);
});

it('new decorated multiline text can be edited and deleted without leaving lines behind', async () => {
  serveFonts();
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  await addText(doc, 0, {
    text: 'First\n\nLast',
    x: 50,
    y: 280,
    size: 20,
    underline: true,
    strikethrough: true,
    rotation: 15,
  });
  const saved = await read(await doc.save());
  expect(saved.groups).toHaveLength(1);
  expect(saved.groups[0]).toMatchObject({
    text: 'First\n\nLast',
    underline: true,
    strikethrough: true,
  });
  await replaceTextGroup(saved.doc, 0, saved.groups[0], 'Changed', { strikethrough: false });
  const edited = await read(await saved.doc.save());
  expect(edited.groups).toHaveLength(1);
  expect(edited.groups[0]).toMatchObject({
    text: 'Changed',
    underline: true,
    strikethrough: false,
  });
  await replaceTextGroup(edited.doc, 0, edited.groups[0], '');
  const deleted = await read(await edited.doc.save());
  expect(deleted.groups).toHaveLength(0);
  expect(pageSource(deleted.doc.getPage(0))).not.toContain('/PuterTextDecoration');
});

it('bold changes retain italic fragments instead of flattening their slant', async () => {
  serveFonts();
  const doc = await PDFDocument.create(),
    page = doc.addPage([400, 400]);
  const normal = await doc.embedFont(StandardFonts.Helvetica),
    italic = await doc.embedFont(StandardFonts.HelveticaOblique);
  page.node.set(
    PDFName.of('Resources'),
    doc.context.obj({ Font: { F: normal.ref, I: italic.ref } }),
  );
  page.node.set(
    PDFName.of('Contents'),
    doc.context.register(
      doc.context.flateStream('BT /F 20 Tf 50 250 Td (Normal ) Tj /I 20 Tf (italic) Tj ET'),
    ),
  );
  const parsed = await read(await doc.save());
  await replaceTextGroup(parsed.doc, 0, parsed.groups[0], 'Normal italic', {
    fontStyle: { bold: true },
  });
  const saved = await read(await parsed.doc.save());
  expect(
    saved.runs.filter((run) => run.text).map((run) => run.fontName.replace(/-\d+$/, '')),
  ).toEqual(['NotoSans-Bold', 'NotoSans-BoldItalic']);
});

for (const mode of [1, 2])
  it(`decorates and restores stroked text in paint mode ${mode}`, async () => {
    const doc = await PDFDocument.load(await fixture());
    const page = doc.getPage(0);
    page.node.set(
      PDFName.of('Contents'),
      doc.context.register(
        doc.context.flateStream(
          `0 0 1 rg 1 0 0 RG BT /F 20 Tf ${mode} Tr 50 250 Td (Outline) Tj ET`,
        ),
      ),
    );
    const parsed = await read(await doc.save());
    await replaceTextGroup(parsed.doc, 0, parsed.groups[0], 'Outline', { underline: true });
    const saved = await read(await parsed.doc.save());
    expect(saved.groups[0].underline).toBe(true);
    expect(saved.groups[0].state.mode).toBe(mode);
    await replaceTextGroup(saved.doc, 0, saved.groups[0], 'Outline', { underline: false });
    const plain = await read(await saved.doc.save());
    expect(await pixels(plain)).toEqual(await pixels(parsed));
  });

it('paragraph decorations retain logical text and follow reflow', async () => {
  const doc = await PDFDocument.create();
  doc
    .addPage([400, 400])
    .drawText('One two three\nfour five.', { x: 50, y: 280, size: 20, lineHeight: 24 });
  const parsed = await read(await doc.save());
  expect(parsed.groups[0].paragraph).toBeDefined();
  await replaceTextGroup(parsed.doc, 0, parsed.groups[0], parsed.groups[0].text, {
    underline: true,
  });
  const saved = await read(await parsed.doc.save());
  expect(saved.groups[0].paragraph.stored).toBe(true);
  await replaceTextGroup(saved.doc, 0, saved.groups[0], 'One two \nthree four \nfive.', {
    reflow: true,
    size: 24,
    lineOffsets: [0, 1.2, 2.4],
    paragraph: { width: 180, leading: 1.2, softBreaks: [8, 20] },
  });
  const reflowed = await read(await saved.doc.save());
  expect(reflowed.groups).toHaveLength(1);
  expect(reflowed.groups[0].underline).toBe(true);
  expect(reflowed.groups[0].text).toBe('One two three four five.');
  expect(reflowed.groups[0].paragraph.width).toBeCloseTo(180);
  expect(inspectPaths(reflowed.doc, 0)).toHaveLength(0);
});
