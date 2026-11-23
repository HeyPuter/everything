import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import { fillFields, listFields } from '../src/core/document.js';

afterEach(() => vi.restoreAllMocks());

// A value a file holds past its field's character limit can be shortened by a character at a
// time; saving one still too long said "Attempted to set text with length=5 for TextField…".
it('asks for a value within the field’s limit, naming the field', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url))),
  );
  const source = await PDFDocument.create();
  const code = source.getForm().createTextField('Code');
  code.addToPage(source.addPage(), { x: 40, y: 300, width: 200, height: 24 });
  code.setText('abcdef');
  code.acroField.dict.set(PDFName.of('MaxLen'), PDFNumber.of(3));
  const doc = await PDFDocument.load(await source.save());
  await expect(fillFields(doc, { Code: 'abcde' })).rejects.toMatchObject({
    message: 'Enter at most 3 characters in Code.',
    field: 'Code',
  });
  await fillFields(doc, { Code: 'abc' });
  expect(listFields(doc)[0].value).toBe('abc');
});
