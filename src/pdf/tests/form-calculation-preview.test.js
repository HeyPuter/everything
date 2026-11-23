import { afterEach, expect, it, vi } from 'vitest';
import { PDFDict, PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import { previewCalculations } from '../src/core/document.js';

afterEach(() => vi.restoreAllMocks());

/** `pages` pages of 20 quantities, each with a total of its page's group and a formula. */
async function order(pages) {
  const source = await PDFDocument.create();
  const form = source.getForm();
  const calc = (field, js) =>
    field.acroField.dict.set(
      PDFName.of('AA'),
      source.context.obj({ C: { S: 'JavaScript', JS: PDFHexString.fromText(js) } }),
    );
  const sequence = [];
  for (let p = 0; p < pages; p++) {
    const page = source.addPage();
    for (let i = 0; i < 20; i++)
      form.createTextField(`p${p}.Qty.${i}`).addToPage(page, { x: 20, y: 20 + i * 20 });
    const total = form.createTextField(`p${p}.Total`);
    total.addToPage(page, { x: 300, y: 20 });
    calc(total, `AFSimple_Calculate("SUM", new Array ("p${p}.Qty"));`);
    const twice = form.createTextField(`p${p}.Twice`);
    twice.addToPage(page, { x: 300, y: 60 });
    calc(twice, `/*** BVCALC p${p}.Total * 2 EVCALC ***/`);
    sequence.push(total.ref, twice.ref);
  }
  form.acroForm.dict.set(PDFName.of('CO'), source.context.obj(sequence));
  return PDFDocument.load(await source.save());
}

it('previews a group’s total and a formula that reads it', async () => {
  const doc = await order(2);
  expect(previewCalculations(doc, { 'p0.Qty.1': '2', 'p0.Qty.7': '3.5' })).toEqual(
    new Map([
      ['p0.Total', '5.5'],
      ['p0.Twice', '11'],
      ['p1.Total', '0'],
      ['p1.Twice', '0'],
    ]),
  );
  expect(previewCalculations(doc, { 'p1.Qty.0': '4' }).get('p1.Twice')).toBe('8');
});

// Each key typed in a large form worked out every total by reading every calculation's script
// and looking its fields up one by one: 0.6 s a key for 50 pages of 20 fields and 2 totals.
it('reads a form’s calculation scripts once, not on every key typed', async () => {
  const doc = await order(50);
  previewCalculations(doc, { 'p0.Qty.1': '1' });
  const lookup = vi.spyOn(PDFDict.prototype, 'lookup');
  const result = previewCalculations(doc, { 'p0.Qty.1': '12', 'p9.Qty.3': '4' });
  expect(result.get('p0.Twice')).toBe('24');
  expect(result.get('p9.Total')).toBe('4');
  const scripts = lookup.mock.calls.filter(([key]) => key === PDFName.of('AA'));
  expect(scripts).toHaveLength(0);
});
