import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import { fillFields, listFields, PdfSession } from '../src/core/document.js';
import { inheritedTextLimitPdf } from './fixtures/inherited-text-limit.js';

beforeEach(async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url))),
  );
});
afterEach(() => vi.restoreAllMocks());

for (const comb of [false, true])
  for (const indirect of [false, true]) {
    it(`reads inherited text limits without mutation (comb=${comb}, indirect=${indirect})`, async () => {
      const { doc } = await inheritedTextLimitPdf({ comb, indirect });
      const snapshot = () =>
        doc.context.enumerateIndirectObjects().map(([ref, obj]) => [ref, obj.toString()]);
      const before = snapshot();
      expect(listFields(doc)[0]).toMatchObject({ maxLength: 5, value: '123' });
      expect(await fillFields(doc, { 'Address.Code': '123' })).toBe(false);
      expect(snapshot()).toEqual(before);
    });
    it(`rejects overlong edits transactionally and preserves valid edits (comb=${comb}, indirect=${indirect})`, async () => {
      const { doc } = await inheritedTextLimitPdf({ comb, indirect });
      const bytes = await doc.save();
      const session = new PdfSession(bytes);
      await expect(
        session.change((doc) => fillFields(doc, { 'Address.Code': '123456' })),
      ).rejects.toThrow(/at most 5 characters in Address\.Code/);
      expect(session.bytes).toEqual(bytes);
      expect(session.dirty).toBe(false);
      expect(session.past).toHaveLength(0);
      await session.change((doc) => fillFields(doc, { 'Address.Code': '54321' }));
      const saved = await PDFDocument.load(session.bytes);
      expect(listFields(saved)[0]).toMatchObject({ maxLength: 5, value: '54321' });
      expect(
        saved
          .getForm()
          .getTextField('Address.Code')
          .acroField.getParent()
          .dict.lookup(PDFName.of('MaxLen'))
          .asNumber(),
      ).toBe(5);
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const task = pdfjs.getDocument({ data: session.bytes.slice() });
      try {
        const page = await (await task.promise).getPage(1);
        expect((await page.getAnnotations())[0]).toMatchObject({
          fieldValue: '54321',
          maxLen: 5,
          comb,
        });
        const ops = await page.getOperatorList();
        const shown = ops.fnArray
          .flatMap((op, i) =>
            op === pdfjs.OPS.showText
              ? ops.argsArray[i][0].filter((g) => typeof g !== 'number').map((g) => g.unicode)
              : [],
          )
          .join('');
        expect(shown).toContain('54321');
        if (comb) expect(ops.fnArray.filter((op) => op === pdfjs.OPS.showText)).toHaveLength(5);
      } finally {
        await task.destroy();
      }
      expect(session.undo()).toBe(true);
      expect(session.bytes).toEqual(bytes);
      expect(session.redo()).toBe(true);
      expect(listFields(await PDFDocument.load(session.bytes))[0].value).toBe('54321');
    });
  }

it('lets a field override its parent limit and leaves unlimited fields unlimited', async () => {
  const { doc, field } = await inheritedTextLimitPdf();
  field.acroField.dict.set(PDFName.of('MaxLen'), PDFNumber.of(8));
  const unlimited = doc.getForm().createTextField('Unlimited');
  unlimited.addToPage(doc.getPage(0), { y: 100 });
  expect(listFields(doc).map((field) => field.maxLength)).toEqual([8, undefined]);
  await fillFields(doc, { 'Address.Code': '12345678', Unlimited: 'Longer than eight characters' });
  expect(field.getText()).toBe('12345678');
  expect(unlimited.getText()).toBe('Longer than eight characters');
});
