import { expect, it } from 'vitest';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { textFreePages } from '../src/core/slide-backgrounds.js';

async function texts(bytes) {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  const pdf = await task.promise;
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++)
    out.push((await (await pdf.getPage(i)).getTextContent()).items.map((t) => t.str).join('|'));
  await task.destroy();
  return out;
}

it('takes the shown text out of the chosen pages, in forms too, and keeps what draws nothing', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = [doc.addPage([300, 300]), doc.addPage([300, 300])];
  for (const page of pages) page.drawText('Shown', { x: 20, y: 250, size: 12, font });
  const ctx = doc.context;
  const fontName = [...pages[0].node.Resources().lookup(PDFName.of('Font')).keys()][0].asString();
  const form = ctx.register(
    ctx.flateStream(`BT ${fontName} 12 Tf 20 150 Td (Letterhead) Tj ET`, {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 300, 300],
      Resources: pages[0].node.Resources(),
    }),
  );
  pages[0].node.Resources().set(PDFName.of('XObject'), ctx.obj({ Fm0: form }));
  pages[0].node.set(
    PDFName.of('Contents'),
    ctx.register(
      ctx.flateStream(
        [
          `BT ${fontName} 12 Tf 20 250 Td (Shown) Tj ET`,
          '/Fm0 Do',
          `BT 3 Tr ${fontName} 12 Tf 20 200 Td (Recognized) Tj ET`,
          `q BT 7 Tr ${fontName} 40 Tf 20 100 Td (Clip) Tj ET 0 0 1 rg 0 0 300 300 re f Q`,
        ].join('\n'),
      ),
    ),
  );
  const bytes = await textFreePages(await PDFDocument.load(await doc.save()), [0]);
  const [first, second] = await texts(bytes);
  expect(first).not.toContain('Shown');
  expect(first).not.toContain('Letterhead');
  // Invisible text and text that only clips draw no letters of their own.
  expect(first).toContain('Recognized');
  expect(first).toContain('Clip');
  // Pages not chosen are left as they are.
  expect(second).toContain('Shown');
});
