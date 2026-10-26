import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage, createDocx, W } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { checkedHyperlinkTarget, hyperlinkRanges, openableHyperlink } from '../src/engine/hyperlinks.js';
import { hyperlinkAtPoint } from '../src/engine/hyperlink-hit.js';
import { showLink, LINK_COLOR } from '../src/engine/link-appearance.js';
import { layoutDocument, caretRect, hitTest, selectionRects } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { fontMetrics } from '../src/engine/font-metrics.js';
let dom;
beforeAll(() => { dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const source = readFileSync('public/fixtures/hyperlinks.docx'), R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const TARGET = 'https://example.com/guide?q=one%20two&lang=en#section';
const model = p => new TextDocument(p.paragraphs, p.pageSettings, p.numbering, p.styles, p.tables, p.assets);
const save = async (p, d) => new Uint8Array(await p.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer());
const select = (d, text, collapsed = false) => { const a = d.text.indexOf(text); expect(a).toBeGreaterThanOrEqual(0); d.select(a, collapsed ? a + 1 : a + text.length); if (collapsed) d.select(a + 1); };
const layout = d => layoutDocument(d.paragraphs, (text, style) => ({ ...fontMetrics(style), width: [...text].length * style.fontSize * 2 / 3 }), pageGeometry(d.pageSettings), d.numbering, d.tables);
function sameParts(a, b, except = []) { expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort()); for (const k in b) if (!except.includes(k)) expect(Buffer.from(a[k]).equals(Buffer.from(b[k])), k).toBe(true); }
function revise(part, change) { const parts = unzipSync(source), xml = new DOMParser().parseFromString(strFromU8(parts[part]), 'application/xml'); change(xml); parts[part] = strToU8(new XMLSerializer().serializeToString(xml)); return zipSync(parts); }
const links = xml => [...xml.getElementsByTagNameNS(W, 'hyperlink')];
const parsed = bytes => new DOMParser().parseFromString(strFromU8(unzipSync(bytes)['word/document.xml']), 'application/xml');

it('reads an independent fixture including mixed styles, pictures and table links with byte-exact no-edit preservation', async () => {
  const p = await DocxPackage.open(source), d = model(p), ranges = hyperlinkRanges(d.paragraphs);
  expect(ranges).toHaveLength(11); select(d, 'Read the guide á😀'); expect(d.hyperlink.link).toMatchObject({ target: TARGET, tooltip: 'Guide tip', history: true });
  const runs = d.paragraphs[1].runs; expect(runs.filter(r => r.link).map(r => [r.text, r.bold, r.color, r.underlineStyle])).toEqual([['Read ', false, '0563C1', 'single'], ['the guide á😀', true, '0563C1', 'single']]);
  expect(d.paragraphs.flatMap(p => p.runs).some(r => r.image && r.link.target.endsWith('/picture'))).toBe(true);
  sameParts(unzipSync(await save(p, d)), p.parts);
});

it('edits one shared relationship without changing other wrappers, attributes or unrelated package parts, and undoes exactly', async () => {
  const p = await DocxPackage.open(source), d = model(p); select(d, 'Read the guide', true); const before = d.snapshot();
  d.setHyperlink('https://example.com/edited#new'); expect(d.selection).toEqual(before.selection);
  const bytes = await save(p, d), out = model(await DocxPackage.open(bytes)); select(out, 'Read the guide', true); expect(out.hyperlink.link.target).toBe('https://example.com/edited#new');
  select(out, 'Same destination'); expect(out.hyperlink.link.target).toBe(TARGET);
  const wrapper = links(parsed(bytes))[0]; for (const [key,value] of [['tooltip','Guide tip'],['anchor','ignored'],['history','1'],['tgtFrame','_top']]) expect(wrapper.getAttributeNS(W,key)).toBe(value);
  sameParts(unzipSync(bytes), p.parts, ['word/document.xml','word/_rels/document.xml.rels']);
  d.undo(); expect(d.snapshot()).toEqual(before); sameParts(unzipSync(await save(p,d)),p.parts); d.redo(); expect(d.hyperlink.link.target).toBe('https://example.com/edited#new');
});

it('keeps differently formatted linked runs in one wrapper and adjacent equal-target wrappers distinct after editing', async () => {
  const p = await DocxPackage.open(source), d = model(p); select(d,'Read'); d.setRunFormat({ italic:true }); select(d,'First'); d.setRunFormat({bold:true});
  const output = links(parsed(await save(p,d))); expect(output).toHaveLength(11); expect(output[0].textContent).toBe('Read the guide á😀'); expect(output.slice(2,4).map(n=>n.textContent)).toEqual(['First','Second']);
  sameParts(unzipSync(await save(p,d)), p.parts, ['word/document.xml']);
});

it('partial unlink and partial target changes split wrappers while retaining character formatting', async () => {
  const p=await DocxPackage.open(source),d=model(p); select(d,'the guide'); d.removeHyperlink(); expect(d.hyperlink).toBeNull(); expect(d.runFormatting).toMatchObject({bold:true,color:'0563C1',underline:true});
  let out=model(await DocxPackage.open(await save(p,d))); select(out,'the guide'); expect(out.hyperlink).toBeNull(); select(out,'Read '); expect(out.hyperlink.link.target).toBe(TARGET);
  d.undo(); select(d,'the guide'); d.setHyperlink('mailto:other@example.com'); out=model(await DocxPackage.open(await save(p,d))); select(out,'the guide'); expect(out.hyperlink.link.target).toBe('mailto:other@example.com'); select(out,'Read '); expect(out.hyperlink.link.target).toBe(TARGET);
});

it('creates selected and inserted links with inherited styles, one undo step, and exact source text', async () => {
  const p=await DocxPackage.open(source),d=model(p); select(d,'End hyperlinks'); d.setHyperlink('https://example.com/end'); expect(d.runFormatting.underline).toBe(false);
  const end=d.text.length; d.select(end); const before=d.snapshot(),history=d.history.length; // At an existing link edge, editing the link is intentional.
  d.select(0); d.setHyperlink('mailto:new@example.com','New á😀 '); expect(d.history).toHaveLength(history+1); expect(d.text.startsWith('New á😀 External')).toBe(true);
  const out=model(await DocxPackage.open(await save(p,d))); select(out,'New á😀 '); expect(out.hyperlink.link.target).toBe('mailto:new@example.com');
  d.undo(); expect(d.text).toBe(before.paragraphs.map(p=>p.runs.map(r=>r.text).join('')).join('\n'));
});

it('extends interior typing, leaves boundary typing unlinked, and preserves replacement links only within one wrapper', async () => {
  const d=new TextDocument([paragraph('abcdef')]); d.select(1,5); d.setHyperlink(TARGET); d.select(3); d.replace('X'); expect(hyperlinkRanges(d.paragraphs).map(r=>d.text.slice(r.start,r.end))).toEqual(['bcXde']);
  d.select(1); d.replace('L'); d.select(7); d.replace('R'); expect(hyperlinkRanges(d.paragraphs).map(r=>d.text.slice(r.start,r.end))).toEqual(['bcXde']);
  d.select(2,7); d.replace('á😀'); expect(hyperlinkRanges(d.paragraphs).map(r=>d.text.slice(r.start,r.end))).toEqual(['á😀']);
  d.select(0,4); d.replace('outside'); expect(d.paragraphs[0].runs[0].link).toBeUndefined();
});

it('types plain-looking text after an existing link, in the formatting from before it', async () => {
  const d=new TextDocument([paragraph('Visit site now')]); d.select(6,10); d.setHyperlink(TARGET); showLink(d);
  // Typed straight after a link made earlier, the text was neither linked nor meant to look linked, but took the link's colour and underline.
  d.select(10); d.replace('X');
  const typed=d.paragraphs[0].runs.find(r=>r.text==='X');
  expect(typed.link).toBeUndefined(); expect(typed).toMatchObject({color:'auto',underlineStyle:'none'});
  expect(d.paragraphs[0].runs.find(r=>r.text==='site')).toMatchObject({color:LINK_COLOR,underlineStyle:'single'});
  // Inside the link typing still extends it in its look; a pending choice at the caret still applies after it.
  d.select(8); d.replace('Y'); expect(d.paragraphs[0].runs.find(r=>r.link).text).toBe('siYte');
  d.select(11); d.setRunFormat({underlineStyle:'double'}); d.replace('Z'); expect(d.paragraphs[0].runs.find(r=>r.text==='Z')).toMatchObject({underlineStyle:'double'});
  d.undo(); d.undo(); d.undo(); d.undo(); expect(d.text).toBe('Visit site now');
});

it('types plain-looking text before a link that starts its paragraph, in the formatting after it', async () => {
  const d=new TextDocument([paragraph('site now')]); d.select(0,4); d.setHyperlink(TARGET); showLink(d);
  d.select(0); d.replace('X');
  const typed=d.paragraphs[0].runs.find(r=>r.text==='X');
  expect(typed.link).toBeUndefined(); expect(typed).toMatchObject({color:'auto',underlineStyle:'none'});
  // A paragraph that is only the link keeps its look either side: there is no other text to follow.
  const only=new TextDocument([paragraph('site')]); only.select(0,4); only.setHyperlink(TARGET); showLink(only);
  only.select(4); only.replace('Y'); expect(only.paragraphs[0].runs.find(r=>r.text==='Y')).toMatchObject({color:LINK_COLOR});
});

it('splits and rejoins linked paragraphs, preserves source suffixes, and does not link inserted multiline text', async () => {
  const d=new TextDocument([paragraph('abcd')]),p=createDocx(d.paragraphs); d.select(0,4);d.setHyperlink(TARGET);d.select(2);d.insertParagraph();
  expect(hyperlinkRanges(d.paragraphs).map(r=>d.text.slice(r.start,r.end))).toEqual(['ab','cd']); const out=model(await DocxPackage.open(await save(p,d))); expect(hyperlinkRanges(out.paragraphs)).toHaveLength(2);
  d.delete(-1);expect(d.text).toBe('abcd');expect(hyperlinkRanges(d.paragraphs)).toHaveLength(1);d.select(2);d.replace('X\nY');expect(hyperlinkRanges(d.paragraphs).map(r=>d.text.slice(r.start,r.end))).toEqual(['ab','cd']);
});

it('supports links across paragraph/cell selections and removal without merging table structure', async () => {
  const p=await DocxPackage.open(source),d=model(p),table=structuredClone(d.tables);select(d,'Cell text');const start=d.range[0];select(d,'Last cell');const end=d.range[1];d.select(start,end);d.setHyperlink('https://example.com/table');expect(d.tables).toEqual(table);
  const out=model(await DocxPackage.open(await save(p,d)));select(out,'Last cell');expect(out.hyperlink.link.target).toBe('https://example.com/table');d.removeHyperlink();expect(d.tables).toEqual(table);d.undo();d.undo();sameParts(unzipSync(await save(p,d)),p.parts);
});

it('does not affect shaping, wrapping, caret stops, selection or table pagination; detects linked repeated headers only inside their rectangles', async () => {
  const p=await DocxPackage.open(source),d=model(p),before=layout(d);expect(before.repeatedLines.length).toBeGreaterThan(0);
  const ranges=hyperlinkRanges(d.paragraphs),header=ranges.find(r=>d.text.slice(r.start,r.end)==='Linked header'),rects=selectionRects(before,header.start,header.end);expect(new Set(rects.map(r=>r.page)).size).toBeGreaterThan(1);
  for(const r of rects){expect(hyperlinkAtPoint(before,d.paragraphs,r.page,r.x+r.width/2,r.y+r.height/2)?.link.target).toBe('https://example.com/header');expect(hyperlinkAtPoint(before,d.paragraphs,r.page,r.x-10,r.y+r.height/2)).toBeNull();}
  const pos=d.text.indexOf('á😀',d.text.indexOf('Read'))+2,c=caretRect(before,pos);expect(hitTest(before,c.page,c.x,c.y+c.height/2)).toBe(pos);
  d.select(0,d.text.length);d.removeHyperlink();expect(layout(d)).toEqual(before);
});

it('preserves character-style inheritance through link edits and reopening',async()=>{
  const p=await DocxPackage.open(source),d=model(p);select(d,'Read the guide');d.setHyperlink('https://example.com/other');const out=model(await DocxPackage.open(await save(p,d)));out.editCharacterStyle('Hyperlink',{run:{color:'A00000',underlineStyle:'double'}});select(out,'Read the guide');expect(out.runFormatting).toMatchObject({color:'A00000',underlineStyle:'double'});
});

it('composes new image and hyperlink relationships and preserves linked picture geometry',async()=>{
  const p=await DocxPackage.open(source),d=model(p),asset=Object.values(d.assets)[0];d.assets.newImage=asset;d.select(0);d.insertImage('newImage',{width:365760,height:365760});d.setHyperlink('https://example.com/new-picture');
  const out=model(await DocxPackage.open(await save(p,d)));expect(out.paragraphs[0].runs[0]).toMatchObject({image:{width:365760,height:365760},link:{target:'https://example.com/new-picture'}});expect(out.paragraphs.flatMap(p=>p.runs).filter(r=>r.image)).toHaveLength(2);
});

it('keeps combining marks and joined emoji in the link of the cluster leader through typing, deletion, undo and reopen',async()=>{
  const d=new TextDocument([paragraph('ab😀😀')]),p=createDocx(d.paragraphs);d.select(0,1);d.setHyperlink(TARGET);d.select(1);d.replace('\u0301');expect(hyperlinkRanges(d.paragraphs).map(r=>d.text.slice(r.start,r.end))).toEqual(['á']);d.undo();expect(d.text).toBe('ab😀😀');
  d.select(2,4);d.setHyperlink(TARGET);d.select(4);d.replace('\u200d');expect(hyperlinkRanges(d.paragraphs).map(r=>d.text.slice(r.start,r.end))).toEqual(['a','😀\u200d😀']);expect(d.selection).toEqual({anchor:7,focus:7});
  const out=model(await DocxPackage.open(await save(p,d)));expect(hyperlinkRanges(out.paragraphs).map(r=>out.text.slice(r.start,r.end))).toEqual(['a','😀\u200d😀']);
  const e=new TextDocument([paragraph('xá')]);e.select(1,3);e.setHyperlink(TARGET);e.select(1);e.replace('b');e.select(2,3);e.replace('');expect(hyperlinkRanges(e.paragraphs)).toHaveLength(0);expect(e.text).toBe('xb');
});

it('inserts link text that joins a preceding cluster as one atomic editable link and ignores unchanged targets',async()=>{
  const d=new TextDocument([paragraph('a')]),p=createDocx(d.paragraphs);d.select(1);d.setHyperlink(TARGET,'\u0301');expect(hyperlinkRanges(d.paragraphs).map(r=>d.text.slice(r.start,r.end))).toEqual(['á']);expect(d.selection).toEqual({anchor:2,focus:2});const history=d.history.length;expect(d.setHyperlink(TARGET)).toBe(false);expect(d.history).toHaveLength(history);await DocxPackage.open(await save(p,d));d.undo();expect(d.text).toBe('a');expect(hyperlinkRanges(d.paragraphs)).toHaveLength(0);
});

it('rejects imported links that split a combining sequence while accepting split runs in one link',async()=>{
  const malformed=revise('word/document.xml',xml=>{const link=links(xml)[0],run=link.getElementsByTagNameNS(W,'r')[0],text=run.getElementsByTagNameNS(W,'t')[0];text.textContent='\u0301Read ';});await expect(DocxPackage.open(malformed)).rejects.toThrow(/grapheme/);
  const valid=revise('word/document.xml',xml=>{const link=links(xml)[0],runs=link.getElementsByTagNameNS(W,'r');runs[0].getElementsByTagNameNS(W,'t')[0].textContent='a';runs[1].getElementsByTagNameNS(W,'t')[0].textContent='\u0301😀';});const out=model(await DocxPackage.open(valid));out.select(hyperlinkRanges(out.paragraphs)[0].start+2);expect(out.hyperlink.link.target).toBe(TARGET);
});

it.each(['https://example.com/a%20b#frag','HTTP://EXAMPLE.com/?x=1&y=2','mailto:a@example.com?subject=hello','tel:+15550100'])('preserves supported target spelling: %s',target=>expect(checkedHyperlinkTarget(target)).toBe(target));
it.each(['javascript:alert(1)','data:text/html,test','file:///tmp/test','ftp://example.com','/relative','//example.com','https:example.com','https://','https://example.com/a b','https://example.com/\\path','https://example.com/%bad%escape','https://example.com/\ud800','mailto:','tel:'])('rejects unsupported target without mutation: %s',target=>{const d=new TextDocument([paragraph('text')]),before=d.snapshot();d.select(0,4);expect(()=>d.setHyperlink(target)).toThrow();expect(d.paragraphs).toEqual(before.paragraphs);expect(d.history).toHaveLength(0);});

it.each([
  ['empty relationship',n=>n.setAttributeNS(R,'r:id','')],
  ['document location',n=>n.setAttributeNS(W,'w:docLocation','table')],
  ['invalid history',n=>n.setAttributeNS(W,'w:history','maybe')],
  ['unknown attribute',n=>n.setAttributeNS(W,'w:invalid','true')],
  ['nested link',n=>n.append(n.cloneNode(true))],
  ['empty link',n=>n.replaceChildren()],
  ['field content',n=>n.append(n.ownerDocument.createElementNS(W,'w:fldSimple'))],
  ['raw text',n=>n.append(n.ownerDocument.createTextNode('unmodelled'))],
  ['CDATA text',n=>n.append(n.ownerDocument.createCDATASection('unmodelled'))],
])('rejects unsupported %s before editable open',async(label,change)=>{await expect(DocxPackage.open(revise('word/document.xml',xml=>change(links(xml)[0])))).rejects.toThrow();});

it.each(['missing','duplicate','internal','wrong type'])('rejects %s hyperlink relationships',async kind=>{
  await expect(DocxPackage.open(revise('word/_rels/document.xml.rels',xml=>{const r=[...xml.documentElement.children].find(n=>n.getAttribute('Type')===R+'/hyperlink');if(kind==='missing')r.remove();if(kind==='duplicate')r.after(r.cloneNode(true));if(kind==='internal')r.removeAttribute('TargetMode');if(kind==='wrong type')r.setAttribute('Type',R+'/image');}))).rejects.toThrow(/hyperlink/);
});
it('keeps an unopenable relationship target as an editable, unopened link',async()=>{
  const p=await DocxPackage.open(revise('word/_rels/document.xml.rels',xml=>{for(const r of [...xml.documentElement.children].filter(n=>n.getAttribute('Type')===R+'/hyperlink'))r.setAttribute('Target','javascript:alert(1)');}));
  expect(p.readOnly).not.toBe(true);const d=model(p),link=hyperlinkRanges(d.paragraphs)[0].link;
  expect(link).toMatchObject({target:'javascript:alert(1)',retainedTarget:true});expect(openableHyperlink(link)).toBe(false);
});
