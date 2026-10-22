import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { Workbook } from '../src/core/workbook.js';

// Excel writes the location of a linked workbook it has no path for (one copied from before it was
// saved, or the template a workbook came from) with the relationship type xlPathMissing, and one in its
// startup or library folder as xlStartup, xlLibrary or xlAlternateStartup [MS-XLSX 2.1.4]. The readers
// of external links and PivotTable sources took only the standard type, so such a file did not open at
// all ("could not be read"), as Microsoft's own expense report template did not.

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
function file(type) {
  const parts = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/externalLinks/externalLink1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${MAIN}" xmlns:r="${R}"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets><externalReferences><externalReference r:id="rId2"/></externalReferences></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${R}/externalLink" Target="externalLinks/externalLink1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${MAIN}"><sheetData><row r="1"><c r="A1"><f>[1]Rates!B2*2</f><v>110</v></c></row></sheetData></worksheet>`,
    'xl/externalLinks/externalLink1.xml': `<?xml version="1.0" encoding="UTF-8"?><externalLink xmlns="${MAIN}" xmlns:r="${R}"><externalBook r:id="rId1"><sheetNames><sheetName val="Rates"/></sheetNames><sheetDataSet><sheetData sheetId="0"><row r="2"><cell r="B2"><v>55</v></cell></row></sheetData></sheetDataSet></externalBook></externalLink>`,
    'xl/externalLinks/_rels/externalLink1.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${type}" Target="Rates.xlsx" TargetMode="External"/></Relationships>`,
  };
  const zip = X.CFB.utils.cfb_new();
  for (const [name, text] of Object.entries(parts)) X.CFB.utils.cfb_add(zip, name, new TextEncoder().encode(text));
  return new Uint8Array(X.CFB.write(zip, { type: 'array', fileType: 'zip' }));
}

it.each(['xlPathMissing', 'xlStartup', 'xlLibrary', 'xlAlternateStartup'])('opens a workbook linked to another through %s', async (kind) => {
  const wb = await workbookFromFile(file(`http://schemas.microsoft.com/office/2006/relationships/xlExternalLinkPath/${kind}`), 'linked.xlsx');
  const id = wb.activeSheetId;
  expect(wb.getValue(id, 0, 0)).toBe(110);
  expect(wb.externalWorkbooks.books[0].target).toBe('Rates.xlsx');
  const again = await workbookFromFile(await workbookToXlsx(wb), 'saved.xlsx');
  expect(again.getValue(again.activeSheetId, 0, 0)).toBe(110);
});

it('still refuses a link whose location has some other relationship type', async () => {
  await expect(workbookFromFile(file(`${R}/hyperlink`), 'linked.xlsx')).rejects.toThrow();
});

const tag = (name, body = '', attrs = '') => `<${name} xmlns="${MAIN}" xmlns:r="${R}" ${attrs}>${body}</${name}>`;
async function pivotFile() {
  const wb = new Workbook({ sheets: [{ name: 'Input', cells: { '0,0': { v: 'Sales' }, '1,0': { v: 17 } } }, { name: 'Report' }] });
  wb.nativePivots = { version: 1,
    caches: [{ key: 'shared', scope: 'main', sourceSheetId: wb.sheets[0].id, records: tag('pivotCacheRecords', '<r><n v="17"/></r>', 'count="1"'),
      xml: tag('pivotCacheDefinition', '<cacheSource type="worksheet"><worksheetSource sheet="Input" ref="A1:A2"/></cacheSource><cacheFields count="1"><cacheField name="Sales"><sharedItems count="1"><n v="17"/></sharedItems></cacheField></cacheFields>', 'r:id="oldRecords" recordCount="1"') }],
    tables: [{ name: 'Summary', cache: 'shared', owner: wb.sheets[1].id, xml: tag('pivotTableDefinition', '<location ref="B3:C4" firstHeaderRow="0" firstDataRow="1" firstDataCol="1"/><pivotFields count="1"><pivotField dataField="1"/></pivotFields><dataFields count="1"><dataField name="Total" fld="0"/></dataFields>', 'name="Summary" cacheId="1" dataCaption="Values"') }],
  };
  const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
  const get = (path) => new TextDecoder().decode(X.CFB.find(zip, path)?.content || new Uint8Array());
  const set = (path, text) => X.CFB.utils.cfb_add(zip, path, new TextEncoder().encode(text));
  const path = '/xl/pivotCache/pivotCacheDefinition1.xml', rels = '/xl/pivotCache/_rels/pivotCacheDefinition1.xml.rels';
  set(path, get(path).replace('<worksheetSource ', '<worksheetSource r:id="template" '));
  set(rels, get(rels).replace('</Relationships>', '<Relationship Id="template" Type="http://schemas.microsoft.com/office/2006/relationships/xlExternalLinkPath/xlPathMissing" Target="Expenses.xltx" TargetMode="External"/></Relationships>'));
  set('/xl/workbook.xml', get('/xl/workbook.xml').replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, ''));
  return X.CFB.write(zip, { type: 'array', fileType: 'zip' });
}

it('opens a PivotTable whose source workbook has no path', async () => {
  const wb = await workbookFromFile(await pivotFile(), 'report.xlsx');
  expect(wb.nativePivots.caches[0].sourceWorkbook).toBe('Expenses.xltx');
  expect(wb.nativePivots.tables.map((t) => t.name)).toEqual(['Summary']);
  const again = await workbookFromFile(await workbookToXlsx(wb), 'saved.xlsx');
  expect(again.nativePivots.caches[0].sourceWorkbook).toBe('Expenses.xltx');
});
