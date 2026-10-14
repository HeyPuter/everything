import {beforeAll,afterAll,it,expect} from 'vitest';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {unzipSync,zipSync,strToU8,strFromU8} from 'fflate';
import {DocxPackage} from '../src/engine/docx.js';
import {TextDocument} from '../src/engine/model.js';
const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const path='config/settings2.xml',rels='word/_rels/document.xml.rels';
let dom;
beforeAll(()=>{dom=new JSDOM();globalThis.DOMParser=dom.window.DOMParser;globalThis.XMLSerializer=dom.window.XMLSerializer;});
afterAll(()=>dom.window.close());
const source=()=>unzipSync(readFileSync('public/fixtures/settings-location.docx'));
const model=p=>new TextDocument(p.paragraphs,p.pageSettings,p.numbering,p.styles,p.tables,p.assets);
const save=async(p,d)=>unzipSync(new Uint8Array(await p.export(d.paragraphs,d.pageSettings,d.numbering,d.styles,d.tables,d.assets).arrayBuffer()));
it.each(['../config/settings2.xml','/config/settings2.xml','../config/./settings2.xml'])('uses %s for import, edits and exact undo',async target=>{
 const parts=source();parts[rels]=strToU8(strFromU8(parts[rels]).replace('../config/settings2.xml',target));
 parts['word/settings.xml']=strToU8(`<w:settings xmlns:w="${W}"><w:defaultTabStop w:val="300"/></w:settings>`);
 const p=await DocxPackage.open(zipSync(parts)),d=model(p);
 expect(p.pageSettings).toMatchObject({compatibilityMode:15,defaultTabStop:1440});expect(await save(p,d)).toEqual(parts);
 d.select(0);d.replace('Edited ');d.setPageSettings({defaultTabStop:1080});
 const out=await save(p,d),again=await DocxPackage.open(zipSync(out));
 expect(again.pageSettings.defaultTabStop).toBe(1080);expect(model(again).text).toBe('Edited A\tB\nLabel\nValue\nAfter table');
 expect(Object.keys(out).sort()).toEqual(Object.keys(parts).sort());
 for(const name of Object.keys(parts)) if(![path,'word/document.xml'].includes(name)) expect(out[name]).toEqual(parts[name]);
 d.undo();d.undo();expect(await save(p,d)).toEqual(parts);
});
it('creates a separate Settings part without overwriting an unreferenced conventional file',async()=>{
 const parts=source();parts[rels]=strToU8(strFromU8(parts[rels]).replace(/<Relationship Id="settings"[^>]*\/>/,''));
 parts['word/settings.xml']=strToU8('<unrelated/>');
 const p=await DocxPackage.open(zipSync(parts)),d=model(p);expect(p.pageSettings.defaultTabStop).toBe(720);
 d.setPageSettings({defaultTabStop:1080});const out=await save(p,d);
 expect(out['word/settings.xml']).toEqual(parts['word/settings.xml']);expect(out[path]).toEqual(parts[path]);
 expect(out['word/settings1.xml']).toBeDefined();expect((await DocxPackage.open(zipSync(out))).pageSettings.defaultTabStop).toBe(1080);
});
it('honors documentProtection in the relocated part',async()=>{
 const parts=source();parts[path]=strToU8(`<w:settings xmlns:w="${W}"><w:documentProtection w:edit="readOnly" w:enforcement="1"/></w:settings>`);
 const p=await DocxPackage.open(zipSync(parts));
 expect(p.readOnly).toBeFalsy();expect(p.reviewSettings.protection).toMatchObject({edit:'readOnly',enforcement:true,formatting:false});
 expect(await save(p,model(p))).toEqual(parts);
});
it('honors trackRevisions in the relocated part',async()=>{
 const parts=source();parts[path]=strToU8(`<w:settings xmlns:w="${W}"><w:trackRevisions/></w:settings>`);
 const p=await DocxPackage.open(zipSync(parts));expect(p.readOnly).toBeFalsy();expect(p.trackRevisions).toBe(true);
});
it.each(['missing','external','duplicate','root'])('rejects %s settings before editable attachment',async mode=>{
 const parts=source();
 if(mode==='missing')delete parts[path];
 if(mode==='root')parts[path]=strToU8(`<w:document xmlns:w="${W}"/>`);
 if(mode==='external')parts[rels]=strToU8(strFromU8(parts[rels]).replace('Target="../config/settings2.xml"','TargetMode="External" Target="https://example.invalid/settings.xml"'));
 if(mode==='duplicate')parts[rels]=strToU8(strFromU8(parts[rels]).replace('</Relationships>','<Relationship Id="other" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="../config/settings2.xml"/></Relationships>'));
 await expect(DocxPackage.open(zipSync(parts))).rejects.toThrow(/settings/);
});
it.each(['text-colors','font-families'])('retains %s theme settings when the part moves',async name=>{
 const parts=unzipSync(readFileSync(`public/fixtures/${name}.docx`));
 if(name==='text-colors') {
  const xml=new DOMParser().parseFromString(strFromU8(parts['word/settings.xml']),'application/xml');
  xml.getElementsByTagNameNS(W,'clrSchemeMapping')[0].setAttributeNS(W,'w:accent1','accent3');
  parts['word/settings.xml']=strToU8(new XMLSerializer().serializeToString(xml));
 }
 else parts['word/settings.xml']=strToU8(strFromU8(parts['word/settings.xml']).replace('w:val="en-US"','w:val="ja-JP"'));
 const before=await DocxPackage.open(zipSync(parts));
 parts[path]=parts['word/settings.xml'];delete parts['word/settings.xml'];
 parts[rels]=strToU8(strFromU8(parts[rels]).replace('Target="settings.xml"','Target="../config/settings2.xml"'));
 parts['[Content_Types].xml']=strToU8(strFromU8(parts['[Content_Types].xml']).replace('/word/settings.xml','/config/settings2.xml'));
 const after=await DocxPackage.open(zipSync(parts));
 expect(after.paragraphs.map(p=>p.runs)).toEqual(before.paragraphs.map(p=>p.runs));
 expect(after.pageSettings).toEqual(before.pageSettings);expect(await save(after,model(after))).toEqual(parts);
},15000);
it('reads even-page story selection from relocated settings',async()=>{
 const parts=unzipSync(readFileSync('tests/fixtures/page-stories/footer-variants.docx'));
 parts[path]=parts['word/settings.xml'];delete parts['word/settings.xml'];
 parts[rels]=strToU8(strFromU8(parts[rels]).replace('Target="settings.xml"','Target="../config/settings2.xml"'));
 parts['[Content_Types].xml']=strToU8(strFromU8(parts['[Content_Types].xml']).replace('/word/settings.xml','/config/settings2.xml'));
 const p=await DocxPackage.open(zipSync(parts),{bestEffort:true});
 expect(p.pageStories.evenAndOdd).toBe(true);
});
