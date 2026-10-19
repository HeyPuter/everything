import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

// LibreOffice keeps a sheet's conditional formatting in a calcext:conditional-formats block (its own extension:
// ODF has none), which the .ods reader skipped, so every highlight rule of a LibreOffice file was gone on opening
// it here, and from the .xlsx saved from it. The conditions, colour scales, data bars and icon sets now come in
// as the rules Excel would have for them, painted with their cell styles.
const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:calcext="urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0"';
function lodsFile(styles, table) {
  const files = {
    mimetype: 'application/vnd.oasis.opendocument.spreadsheet',
    'META-INF/manifest.xml': '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>',
    'styles.xml': `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NS} office:version="1.3"><office:styles>${styles}</office:styles></office:document-styles>`,
    'content.xml': `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS} office:version="1.3"><office:body><office:spreadsheet>${table}</office:spreadsheet></office:body></office:document-content>`,
  };
  const zip = X.CFB.utils.cfb_new();
  for (const [name, text] of Object.entries(files)) X.CFB.utils.cfb_add(zip, name, new TextEncoder().encode(text));
  return new Uint8Array(X.CFB.write(zip, { type: 'array', fileType: 'zip' }));
}
const STYLES = `<style:style style:name="Default" style:family="table-cell"/>
  <style:style style:name="Accent" style:family="table-cell" style:parent-style-name="Default"><style:text-properties fo:font-weight="bold"/></style:style>
  <style:style style:name="Bad" style:family="table-cell" style:parent-style-name="Default"><style:table-cell-properties fo:background-color="#ffcccc"/><style:text-properties fo:color="#cc0000"/></style:style>
  <style:style style:name="Good" style:family="table-cell" style:parent-style-name="Default"><style:table-cell-properties fo:background-color="#ccffcc"/><style:text-properties fo:color="#006600"/></style:style>`;
const values = [1, 5, 12, 'apple', 20, 7];
const rows = values.map((v) => `<table:table-row><table:table-cell ${typeof v === 'number' ? `office:value-type="float" office:value="${v}"` : 'office:value-type="string"'}><text:p>${v}</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="10"><text:p>10</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="${values.indexOf(v)}"/></table:table-row>`).join('');
const TABLE = `<table:table table:name="Data">${rows}
<calcext:conditional-formats>
 <calcext:conditional-format calcext:target-range-address="Data.A1:Data.A6">
  <calcext:condition calcext:apply-style-name="Bad" calcext:value="&gt;10" calcext:base-cell-address="Data.A1"/>
  <calcext:condition calcext:apply-style-name="Good" calcext:value="between(1,5)" calcext:base-cell-address="Data.A1"/>
 </calcext:conditional-format>
 <calcext:conditional-format calcext:target-range-address="Data.A2:Data.A6">
  <calcext:condition calcext:apply-style-name="Accent" calcext:value="formula-is([.A1]&lt;[.B1])" calcext:base-cell-address="Data.A1"/>
 </calcext:conditional-format>
 <calcext:conditional-format calcext:target-range-address="Data.B1:Data.B6">
  <calcext:color-scale><calcext:color-scale-entry calcext:value="0" calcext:type="minimum" calcext:color="#ff0000"/><calcext:color-scale-entry calcext:value="50" calcext:type="percentile" calcext:color="#ffff00"/><calcext:color-scale-entry calcext:value="0" calcext:type="maximum" calcext:color="#00a933"/></calcext:color-scale>
 </calcext:conditional-format>
 <calcext:conditional-format calcext:target-range-address="Data.C1:Data.C6">
  <calcext:data-bar calcext:max-length="100" calcext:negative-color="#ff0000" calcext:positive-color="#2a6099" calcext:axis-color="#000000"><calcext:formatting-entry calcext:value="0" calcext:type="auto-minimum"/><calcext:formatting-entry calcext:value="0" calcext:type="auto-maximum"/></calcext:data-bar>
 </calcext:conditional-format>
 <calcext:conditional-format calcext:target-range-address="Data.C1:Data.C6">
  <calcext:icon-set calcext:icon-set-type="3Arrows"><calcext:formatting-entry calcext:value="0" calcext:type="percent"/><calcext:formatting-entry calcext:value="33" calcext:type="percent"/><calcext:formatting-entry calcext:value="67" calcext:type="percent"/></calcext:icon-set>
 </calcext:conditional-format>
</calcext:conditional-formats></table:table>`;
const look = (wb, r, c) => wb.conditionalStyle(wb.activeSheetId, r, c, wb.getValue(wb.activeSheetId, r, c));

it('opens a LibreOffice file\'s conditional formats as rules', async () => {
  const wb = await workbookFromFile(lodsFile(STYLES, TABLE), 'rules.ods');
  const rules = wb.activeSheet.rules;
  expect(rules.map((r) => r.type)).toEqual(['formula', 'formula', 'formula', 'scale', 'databar', 'icons']);
  // The formula is written from its base cell A1 for targets that start at A2: it moves with them.
  expect(rules[2]).toMatchObject({ value: 'A2<B2', range: { r1: 1, c1: 0, r2: 5, c2: 0 } });
  expect(rules[3]).toMatchObject({ from: '#ff0000', mid: '#ffff00', to: '#00a933' });
  expect(rules[4]).toMatchObject({ barColor: '#2a6099' });
  expect(rules[5]).toMatchObject({ iconSet: '3Arrows' });
  // The first condition a cell meets gives it its style, as in LibreOffice.
  expect(look(wb, 0, 0)).toMatchObject({ bg: '#ccffcc', color: '#006600' });
  expect(look(wb, 2, 0)).toMatchObject({ bg: '#ffcccc', color: '#cc0000' });
  expect(look(wb, 5, 0)).toMatchObject({ bold: true });
  expect(look(wb, 5, 0)?.bg).toBeUndefined();
  // And they travel on into an .xlsx, as Excel's own Cell Value and formula rules.
  const back = await workbookFromFile(await workbookToXlsx(wb), 'rules.xlsx');
  expect(back.activeSheet.rules.map((r) => r.type)).toEqual(['formula', 'formula', 'formula', 'scale', 'databar', 'icons']);
  expect(look(back, 2, 0)).toMatchObject({ bg: '#ffcccc' });
});

it('leaves out a condition it cannot read and keeps the rest', async () => {
  const table = TABLE.replace('between(1,5)', 'some-future-condition(1)');
  const wb = await workbookFromFile(lodsFile(STYLES, table), 'rules.ods');
  expect(wb.activeSheet.rules.map((r) => r.type)).toEqual(['formula', 'formula', 'scale', 'databar', 'icons']);
});
