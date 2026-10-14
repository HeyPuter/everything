import { beforeAll, afterAll, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { layoutDocument, caretRect, hitTest } from '../src/engine/layout.js';
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const folder = 'tests/fixtures/book-fold/';
const cases = JSON.parse(readFileSync(folder + 'cases.json', 'utf8'));
const reference = JSON.parse(readFileSync(folder + 'reference.json', 'utf8'));
const measure = text => ({ width: text.length * 8, ascent: 13, descent: 3 });
const layout = d => layoutDocument(d.paragraphs, measure, pageGeometry(d.pageSettings));
const save = async (p,d) => new Uint8Array(await p.export(d.paragraphs,d.pageSettings).arrayBuffer());

it.each(cases)('imports and lays out $name at the native reading-page margins', async c => {
  const p = await DocxPackage.open(readFileSync(folder + c.name + '.docx'));
  const d = new TextDocument(p.paragraphs,p.pageSettings), result = layout(d);
  expect(result.pageCount).toBe(4);
  for (let i = 0; i < 4; i++) {
    const native = reference.cases.find(n=>n.name===c.name).pages[i];
    const line = result.lines.find(l=>l.page===i);
    // PDF ink starts 0.948 pt after the Arial P origin; our unit measurer is
    // intentionally synthetic, so compare the line origin, not its glyph ink.
    expect(Math.abs(line.stops[0].x * .75 - (native.left - .948))).toBeLessThan(.03);
    const rect = caretRect(result,line.start);
    expect(hitTest(result,i,rect.x,rect.y+rect.height/2)).toBe(line.start);
  }
  expect(unzipSync(await save(p,d))).toEqual(p.parts);
  d.select(0);d.replace('Edited ');
  const out=await save(p,d),again=await DocxPackage.open(out);
  expect(again.pageSettings).toEqual(p.pageSettings);
  expect(unzipSync(out)['word/settings.xml']).toEqual(p.parts['word/settings.xml']);
  d.undo();expect(unzipSync(await save(p,d))).toEqual(p.parts);
});

it('recomputes booklet margins after page setup edits and preserves print metadata', async()=>{
  const p=await DocxPackage.open(readFileSync(folder+'forward.docx'));
  const d=new TextDocument(p.paragraphs,p.pageSettings);
  d.setPageSettings({right:900,gutter:180});
  expect(layout(d).pages.map(p=>p.left)).toEqual([72,96,72,96]);
  const out=await save(p,d),again=await DocxPackage.open(out);
  expect(again.pageSettings).toEqual(d.pageSettings);
  expect(unzipSync(out)['word/settings.xml']).toEqual(p.parts['word/settings.xml']);
  // Turning booklet printing off is a document setting: it is written to the settings part and undone in one step.
  expect(d.setPageSettings({bookFoldPrinting:false})).toBe(true);
  const unfolded=await save(p,d);
  expect(new TextDecoder().decode(unzipSync(unfolded)['word/settings.xml'])).not.toContain('bookFoldPrinting');
  expect((await DocxPackage.open(unfolded)).pageSettings.bookFoldPrinting).toBe(false);
  d.undo();d.undo();expect(unzipSync(await save(p,d))).toEqual(p.parts);
});
