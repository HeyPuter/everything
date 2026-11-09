import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { inspectText, replaceText } from '../src/core/text-edit.js';

afterEach(() => vi.restoreAllMocks());

it.each([
  ['Bold', { FontWeight: 700 }, 'bold', 'normal'],
  ['Bold', { Flags: 262144 }, 'bold', 'normal'],
  ['Italic', { ItalicAngle: -12 }, 'normal', 'italic'],
  ['Italic', { Flags: 64, ItalicAngle: 0 }, 'normal', 'italic'],
  ['BoldItalic', { FontWeight: 700, ItalicAngle: -12 }, 'bold', 'italic'],
])('retains %s from a custom-named font descriptor %j', async (face, attributes, weight, style) => {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(
    await readFile(new URL(`../public/fonts/NotoSans-${face}.ttf`, import.meta.url)),
    {
      subset: true,
      customName: 'ReportFace',
    },
  );
  doc.addPage([400, 200]).drawText('Original', { font, x: 20, y: 120, size: 20 });
  await doc.flush();
  const descriptor = doc.context
    .lookup(font.ref)
    .lookup(PDFName.of('DescendantFonts'))
    .lookup(0)
    .lookup(PDFName.of('FontDescriptor'));
  for (const [key, value] of Object.entries(attributes))
    descriptor.set(PDFName.of(key), doc.context.obj(value));
  const bytes = await doc.save();
  const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false });
  try {
    const editable = await PDFDocument.load(bytes);
    const [run] = await inspectText(editable, 0, await (await task.promise).getPage(1), pdfjs.OPS);
    expect(run.fontWeight).toBe(weight);
    expect(run.fontStyle).toBe(style);
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (url) =>
        new Response(
          await readFile(
            new URL(`../public/fonts/${String(url).split('/fonts/').pop()}`, import.meta.url),
          ),
        ),
    );
    await replaceText(editable, 0, run, 'Quick zebra');
    const saved = await PDFDocument.load(await editable.save());
    const fonts = saved.getPage(0).node.Resources().lookup(PDFName.of('Font'));
    const replacement = fonts
      .entries()
      .find(([name]) => name.decodeText().startsWith('EditedFont'));
    expect(
      saved.context.lookup(replacement[1]).lookup(PDFName.of('BaseFont')).decodeText(),
    ).toMatch(new RegExp(`^NotoSans-${face}-`));
  } finally {
    await task.destroy();
  }
});
