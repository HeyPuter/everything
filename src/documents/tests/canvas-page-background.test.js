import {beforeAll,afterAll,it,expect} from 'vitest';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {unzipSync,zipSync,strToU8,strFromU8} from 'fflate';
import {DocxPackage,createDocx} from '../src/engine/docx.js';
import {TextDocument,paragraph} from '../src/engine/model.js';
import {pageGeometry,validatePageSettings} from '../src/engine/page-settings.js';
import {paragraphBackgrounds} from '../src/engine/paragraph-backgrounds.js';
import {foregroundBackground,runBackground} from '../src/engine/backgrounds.js';
let dom;beforeAll(()=>{dom=new JSDOM();globalThis.DOMParser=dom.window.DOMParser;globalThis.XMLSerializer=dom.window.XMLSerializer;});afterAll(()=>{dom.window.close();delete globalThis.DOMParser;delete globalThis.XMLSerializer;});
const source=readFileSync('public/fixtures/page-background-dark.docx');
const model=p=>new TextDocument(p.paragraphs,p.pageSettings,p.numbering,p.styles,p.tables,p.assets);
const save=async(p,d)=>new Uint8Array(await p.export(d.paragraphs,d.pageSettings,d.numbering,d.styles,d.tables,d.assets).arrayBuffer());
const revise=(replace,bytes=source)=>{const p=unzipSync(bytes);p['word/document.xml']=strToU8(replace(strFromU8(p['word/document.xml'])));return zipSync(p);};
it('preserves page background through body edits, page edits, reopen and undo',async()=>{
 const p=await DocxPackage.open(source),d=model(p);expect(p.pageSettings.background).toBe('0A3556');expect(pageGeometry(d.pageSettings).background).toBe('#0A3556');
 expect(unzipSync(await save(p,d))).toEqual(p.parts);d.select(0);d.replace('Edited ');const edited=await save(p,d);expect((await DocxPackage.open(edited)).pageSettings.background).toBe('0A3556');
 d.undo();expect(unzipSync(await save(p,d))).toEqual(p.parts);d.setPageSettings({background:'abcdef'});expect((await DocxPackage.open(await save(p,d))).pageSettings.background).toBe('ABCDEF');d.undo();expect(unzipSync(await save(p,d))).toEqual(p.parts);
 d.setPageSettings({background:'auto'});const removed=await save(p,d);expect(strFromU8(unzipSync(removed)['word/document.xml'])).not.toContain('<w:background');expect((await DocxPackage.open(removed)).pageSettings.background).toBe('auto');
});
it('serializes backgrounds in new packages and validates color edits',async()=>{
 const p=createDocx([paragraph('New')],{background:'112233'}),d=model(p);expect((await DocxPackage.open(await save(p,d))).pageSettings.background).toBe('112233');
 for(const value of [null,1,'#112233','red','12345'])expect(()=>validatePageSettings({background:value})).toThrow();
});
it('turns on displayBackgroundShape when a page color is written, so Word shows it in Print Layout',async()=>{
 // A new package has no settings part: one is added with the setting (§17.15.1.25).
 const p=createDocx([paragraph('New')]),d=model(p);d.setPageSettings({background:'E2EFD9'});
 const parts=unzipSync(await save(p,d));expect(strFromU8(parts['word/settings.xml'])).toContain('<w:displayBackgroundShape/>');
 expect(strFromU8(parts['word/_rels/document.xml.rels'])).toMatch(/relationships\/settings" Target="settings.xml"/);
 expect((await DocxPackage.open(zipSync(parts))).pageSettings.background).toBe('E2EFD9');
 // An existing settings part keeps the rest of its settings and gets the setting in schema order.
 const opened=await DocxPackage.open(readFileSync('public/fixtures/page-settings.docx')),edit=model(opened);edit.setPageSettings({background:'abcdef'});
 const settings=strFromU8(unzipSync(await save(opened,edit))['word/settings.xml']);
 expect(settings.match(/<w:displayBackgroundShape\/>/g)).toHaveLength(1);expect(settings).toMatch(/<w:zoom [^>]*\/><w:displayBackgroundShape\/><w:proofState /);
 const before=strFromU8(opened.parts['word/settings.xml']).replace(/<w:displayBackgroundShape\/>/,'').replace(/<\?xml[^>]*>/,'').match(/<w:\w+/g);
 expect(settings.replace(/<w:displayBackgroundShape\/>/,'').replace(/<\?xml[^>]*>/,'').match(/<w:\w+/g)).toEqual(before);
 // Taking the color off leaves the settings as they are.
 const plain=createDocx([paragraph('New')]),none=model(plain);none.setPageSettings({background:'auto'});
 expect(unzipSync(await save(plain,none))['word/settings.xml']).toBeUndefined();
});
it('resolves theme background tint and preserves its declaration',async()=>{
 const base=readFileSync('public/fixtures/text-colors.docx');const bytes=revise(xml=>xml.replace(/<w:body>/,'<w:background w:color="FF0000" w:themeColor="accent1" w:themeTint="99"/><w:body>'),base);
 const p=await DocxPackage.open(bytes),d=model(p);expect(p.pageSettings.background).toBe('D99594');d.select(0);d.replace('X');const xml=strFromU8(unzipSync(await save(p,d))['word/document.xml']);expect(xml).toContain('w:themeColor="accent1"');expect(xml).toContain('w:themeTint="99"');
});
it('rejects malformed and non-solid backgrounds before editable open',async()=>{
 for(const background of ['<w:background w:color="oops"/>','<w:background w:color="FFFFFF" w:themeTint="xyz"/>','<w:background w:color="FFFFFF"><w:drawing/></w:background>','<w:background/><w:background/>']){
  const bytes=revise(xml=>xml.replace(/<w:background[^>]*\/>/,background));const error=await DocxPackage.open(bytes).then(()=>null,e=>e);expect(error?.name).toBe('UnsupportedDocumentError');expect((await DocxPackage.open(bytes,{bestEffort:true})).readOnly).toBe(true);
 }
});
it('uses page fill beneath transparent cells and honors explicit cell and paragraph fills',()=>{
 const page={width:600,height:800,top:50,bottom:50,background:'#0A3556'},a={page:0,paragraphId:'a',cellId:'clear'},b={page:0,paragraphId:'b',cellId:'white'},c={page:0,paragraphId:'c',y:60,height:20,paragraphBackground:{x:50,width:200,before:0,after:0,value:'foreground'}};
 const result=paragraphBackgrounds([a,b,c],page,[{id:'clear',page:0},{id:'white',page:0,fill:'#FFFFFF'}]);expect(result.get(a).base).toBe('#0A3556');expect(result.get(b).base).toBe('#FFFFFF');expect(result.get(c).rect.color).toBe('#000000');
});
it('ignores highlight when resolving automatic ink but keeps run shading',()=>{
 const style={highlight:'yellow',shading:'auto'};expect(runBackground(style,'#0A3556')).toBe('#FFFF00');expect(foregroundBackground(style,'#0A3556')).toBe('#0A3556');expect(foregroundBackground({...style,shading:'FFFFFF'},'#0A3556')).toBe('#FFFFFF');
});
