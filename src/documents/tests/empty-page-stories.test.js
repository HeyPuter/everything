import {beforeAll,afterAll,it,expect} from 'vitest';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {unzipSync,zipSync,strFromU8,strToU8} from 'fflate';
import {DocxPackage} from '../src/engine/docx.js';
import {TextDocument} from '../src/engine/model.js';
import {layoutDocument} from '../src/engine/layout.js';
import {pageGeometry} from '../src/engine/page-settings.js';
import {layoutPageStories} from '../src/engine/page-story-layout.js';
let dom;beforeAll(()=>{dom=new JSDOM();globalThis.DOMParser=dom.window.DOMParser;globalThis.XMLSerializer=dom.window.XMLSerializer;});afterAll(()=>{dom.window.close();delete globalThis.DOMParser;delete globalThis.XMLSerializer;});
const source=readFileSync('public/fixtures/empty-page-stories.docx');
const model=p=>new TextDocument(p.paragraphs,p.pageSettings,p.numbering,p.styles,p.tables,p.assets);
const save=async(p,d)=>new Uint8Array(await p.export(d.paragraphs,d.pageSettings,d.numbering,d.styles,d.tables,d.assets).arrayBuffer());
const measure=(text,style)=>({width:text.length*style.fontSize*.5,ascent:12,descent:3});
const stories=(p,d)=>layoutPageStories(layoutDocument(d.paragraphs,measure,pageGeometry(d.pageSettings),d.numbering,d.tables,p.pageStories),p.pageStories,[d.pageSettings],measure,d.numbering,{styles:d.styles});
it('opens retained empty variants for body editing and preserves every story part',async()=>{
 const p=await DocxPackage.open(source),d=model(p);expect(p.readOnly).not.toBe(true);expect(Object.keys(p.pageStories.stories)).toHaveLength(6);expect(stories(p,d).lines).toHaveLength(6);
 d.select(0);d.replace('Edited ');const bytes=await save(p,d),parts=unzipSync(bytes);for(const [n,b]of Object.entries(p.parts))if(n!=='word/document.xml')expect(Buffer.from(parts[n]).equals(Buffer.from(b)),n).toBe(true);expect((await DocxPackage.open(bytes)).readOnly).not.toBe(true);d.undo();expect(unzipSync(await save(p,d))).toEqual(p.parts);
});
it('refreshes shared style shading without mutating the source stories and preserves it on reopen',async()=>{
 const p=await DocxPackage.open(source),d=model(p),before=structuredClone(p.pageStories);d.editParagraphStyle('Shared',{paragraph:{paragraphShading:'22AA88'}});const resolved=stories(p,d);expect(resolved.lines.every(l=>l.paragraphBackground?.value==='22AA88')).toBe(true);expect(p.pageStories).toEqual(before);
 const bytes=await save(p,d),again=await DocxPackage.open(bytes);expect(stories(again,model(again)).lines.every(l=>l.paragraphBackground?.value==='22AA88')).toBe(true);for(const path of Object.keys(p.pageStories.stories))expect(unzipSync(bytes)[path]).toEqual(p.parts[path]);d.undo();expect(stories(p,d).lines.every(l=>!l.paragraphBackground)).toBe(true);expect(unzipSync(await save(p,d))).toEqual(p.parts);
});
it.each(['<w:r><w:object/></w:r>','<w:bookmarkStart w:id="0" w:name="Here"/>'])('keeps unsupported structural story content guarded: %s',async markup=>{
 const parts=unzipSync(source);parts['word/footer-default.xml']=strToU8(strFromU8(parts['word/footer-default.xml']).replace('</w:p>',markup+'</w:p>'));const bytes=zipSync(parts);const error=await DocxPackage.open(bytes).then(()=>null,e=>e);expect(error?.name).toBe('UnsupportedDocumentError');expect((await DocxPackage.open(bytes,{bestEffort:true})).readOnly).toBe(true);
});
// An empty hyperlink shows nothing (docs/conformance.md, Empty hyperlinks): the story opens, and saving keeps it.
it('opens a story holding an empty hyperlink and preserves its XML',async()=>{
 const parts=unzipSync(source);parts['word/footer-default.xml']=strToU8(strFromU8(parts['word/footer-default.xml']).replace('</w:p>','<w:hyperlink/></w:p>'));const bytes=zipSync(parts);
 const p=await DocxPackage.open(bytes),d=model(p);expect(p.readOnly).not.toBe(true);
 d.select(0);d.replace('Edited ');const saved=unzipSync(await save(p,d));expect(Buffer.from(saved['word/footer-default.xml']).equals(Buffer.from(parts['word/footer-default.xml']))).toBe(true);
});
it('resolves changed shared run formatting in retained nonempty stories and preserves their XML',async()=>{
 const parts=unzipSync(source);parts['word/footer-default.xml']=strToU8(strFromU8(parts['word/footer-default.xml']).replace('</w:p>','<w:r><w:t>Footer</w:t></w:r></w:p>'));
 const p=await DocxPackage.open(zipSync(parts)),d=model(p),initial=structuredClone(p.pageStories);
 d.editParagraphStyle('Shared',{run:{fontSize:18}});
 const footer=stories(p,d).lines.filter(l=>l.pageStory==='word/footer-default.xml');
 expect(footer.length).toBeGreaterThan(0);expect(footer.flatMap(l=>l.fragments).filter(f=>f.text==='Footer').every(f=>f.fontSize===18)).toBe(true);
 expect(p.pageStories).toEqual(initial);const bytes=await save(p,d);expect(unzipSync(bytes)['word/footer-default.xml']).toEqual(parts['word/footer-default.xml']);
 const again=await DocxPackage.open(bytes);expect(stories(again,model(again)).lines.filter(l=>l.pageStory==='word/footer-default.xml').flatMap(l=>l.fragments).find(f=>f.text==='Footer').fontSize).toBe(18);
 d.undo();expect(unzipSync(await save(p,d))).toEqual(parts);
});
it('rejects a missing retained story relationship target instead of silently dropping the footer',async()=>{
 const parts=unzipSync(source);delete parts['word/footer-default.xml'];const error=await DocxPackage.open(zipSync(parts)).then(()=>null,e=>e);expect(error?.name).toBe('UnsupportedDocumentError');
});
