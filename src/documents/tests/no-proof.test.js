import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { proofingText, wordsToCheck } from '../src/lib/spelling.js';
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const source = readFileSync('tests/fixtures/no-proof/control.docx');
const parts = unzipSync(source);
const native = JSON.parse(readFileSync('tests/fixtures/no-proof/reference.json', 'utf8'));
const model = pkg => new TextDocument(pkg.paragraphs,pkg.pageSettings,pkg.numbering,pkg.styles,pkg.tables,pkg.assets);
const save = async (pkg, doc) => new Uint8Array(await pkg.export(doc.paragraphs,doc.pageSettings,doc.numbering,doc.styles,doc.tables,doc.assets).arrayBuffer());
const checked = doc => wordsToCheck(proofingText(doc.text,doc.paragraphs));

it('matches the native inherited, explicit-reset and mixed-run proofing ranges', async () => {
  expect(createHash('sha256').update(source).digest('hex')).toBe(native.sourceSha256);
  const doc = model(await DocxPackage.open(source));
  expect(doc.paragraphs.slice(0,9).map(p => p.runs.map(r => r.noProof))).toEqual([[false],[true],[true],[true],[false],[true,false],[false,false],[true],[false]]);
  expect(checked(doc).map(w => ({start:w.start,end:w.end,word:w.word}))).toEqual(native.rows.flatMap(row => row.errors.map(error => ({start:error.start,end:error.end,word:error.text}))));
  expect(proofingText(doc.text,doc.paragraphs).length).toBe(doc.text.length);
});

it('retains exemptions through neighboring edits, inherited typing, export/reopen and exact undo', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg);
  expect(unzipSync(await save(pkg,doc))).toEqual(parts);
  doc.select(9,17); doc.replace('Teh');
  expect(checked(doc).some(w => w.word === 'Teh')).toBe(false);
  const edited = await save(pkg,doc), reopened = model(await DocxPackage.open(edited));
  expect(checked(reopened)).toEqual(checked(doc));
  for (const name of Object.keys(parts).filter(name => name !== 'word/document.xml')) expect(unzipSync(edited)[name]).toEqual(parts[name]);
  doc.undo(); expect(unzipSync(await save(pkg,doc))).toEqual(parts);
});

it('serializes proofing property edits and restores the inherited state with undo', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg);
  doc.select(0,8); doc.setRunFormat({noProof:true});
  expect(checked(doc).some(w => w.start === 0)).toBe(false);
  expect(checked(model(await DocxPackage.open(await save(pkg,doc)))).some(w => w.start === 0)).toBe(false);
  doc.undo(); expect(unzipSync(await save(pkg,doc))).toEqual(parts);
  doc.select(18,26); doc.setRunFormat({noProof:false});
  expect(checked(model(await DocxPackage.open(await save(pkg,doc)))).some(w => w.start === 18)).toBe(true);
});

it('keeps Unicode source offsets and ordinary run boundaries while masking exempt text', () => {
  const paragraphs = [{runs:[{text:'😀',noProof:true},{text:'Zorblax '},{text:'Teh',noProof:true},{text:' jumpd'}]}];
  const text = paragraphs[0].runs.map(r=>r.text).join('');
  expect(wordsToCheck(proofingText(text,paragraphs))).toEqual([{start:2,end:9,word:'Zorblax'},{start:14,end:19,word:'jumpd'}]);
  expect(proofingText('whole', [{runs:[{text:'who'},{text:'le'}]}])).toBe('whole');
});

it.each(['<w:noProof w:val="invalid"/>','<w:noProof/><w:noProof/>','<w:noProof><w:b/></w:noProof>'])('rejects malformed exemptions rather than silently skipping proofing: %s', async invalid => {
  const changed = {...parts,'word/document.xml':strToU8(strFromU8(parts['word/document.xml']).replace('<w:noProof/>',invalid))};
  await expect(DocxPackage.open(zipSync(changed))).rejects.toThrow(/noProof/);
});

it.each([[' true ',true],['\t1\n',true],[' on ',true],[' false ',false],['\r0\t',false],[' off ',false]])('uses XML Schema whitespace normalization for noProof value %s',async(value,expected)=>{
  const changed={...parts,'word/document.xml':strToU8(strFromU8(parts['word/document.xml']).replace('<w:noProof/>',`<w:noProof w:val="${value}"/>`))};
  const doc=model(await DocxPackage.open(zipSync(changed)));
  expect(doc.paragraphs[1].runs[0].noProof).toBe(expected);
});

it('leaves text tracked as deleted out of spelling', () => {
  const runs = [{ text: 'Teh cat ' }, { text: 'Teh dog', revision: { type: 'del', author: 'A' } }, { text: ' sat' }];
  const text = runs.map(r => r.text).join('');
  const checked = wordsToCheck(proofingText(text, [{ runs }])).map(w => w.word);
  expect(checked).toEqual(['Teh', 'cat', 'sat']);
});
