import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, expect, it, vi } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

afterEach(() => vi.unstubAllGlobals());

/** A workbook whose File ▸ Info properties Excel filled in, standard and custom. */
function excelFile() {
  const book = X.utils.book_new();
  X.utils.book_append_sheet(book, X.utils.aoa_to_sheet([[1]]), 'Data');
  book.Props = { Title: 'Budget & plan 2027', Subject: 'Plan', Author: 'Ana', Keywords: 'budget, plan', Comments: 'Draft <v2>',
    Category: 'Finance', Company: 'Acme', Manager: 'Bo', CreatedDate: new Date('2026-03-01T09:30:00Z') };
  book.Custprops = { Project: 'Atlas', Approved: true, Budget: 1250.5 };
  return X.write(book, { type: 'array', bookType: 'xlsx' });
}
const part = (zip, path) => new TextDecoder().decode(X.CFB.find(zip, path).content);

// Opening a file kept none of its document properties (title, subject, author, tags, comments, category, company,
// manager, created date and custom properties), so saving it again wrote an empty docProps/core.xml.
it('keeps a workbook\'s document properties, standard and custom, through opening and saving', async () => {
  vi.stubGlobal('Blob', NodeBlob);
  const wb = await workbookFromFile(excelFile(), 'budget.xlsx');
  const copy = new Workbook(wb.toJSON());
  const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(copy)).arrayBuffer()), { type: 'array' });
  const core = part(zip, '/docProps/core.xml');
  for (const text of ['<dc:title>Budget &amp; plan 2027</dc:title>', '<dc:subject>Plan</dc:subject>', '<dc:creator>Ana</dc:creator>',
    '<cp:keywords>budget, plan</cp:keywords>', '<dc:description>Draft &lt;v2&gt;</dc:description>', '<cp:category>Finance</cp:category>',
    '<dcterms:created xsi:type="dcterms:W3CDTF">2026-03-01T09:30:00Z</dcterms:created>']) expect(core).toContain(text);
  const app = part(zip, '/docProps/app.xml');
  expect(app).toContain('<Company>Acme</Company>');
  expect(app).toContain('<Manager>Bo</Manager>');
  const back = X.read(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), { type: 'array' });
  expect(back.Custprops).toEqual({ Project: 'Atlas', Approved: true, Budget: 1250.5 });
});

it('writes no properties for a workbook that has none', async () => {
  vi.stubGlobal('Blob', NodeBlob);
  const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(new Workbook())).arrayBuffer()), { type: 'array' });
  expect(part(zip, '/docProps/core.xml')).not.toMatch(/<dc:title>|<dc:creator>/);
});
