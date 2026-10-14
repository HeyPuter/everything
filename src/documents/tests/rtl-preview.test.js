import {beforeAll,afterAll,it,expect} from 'vitest';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {unzipSync,zipSync,strFromU8,strToU8} from 'fflate';
import {DocxPackage} from '../src/engine/docx.js';
import {TextDocument} from '../src/engine/model.js';
import {checkedRunFormat,RUN_FORMAT} from '../src/engine/formatting.js';
let dom;
beforeAll(()=>{dom=new JSDOM('');globalThis.DOMParser=dom.window.DOMParser;globalThis.XMLSerializer=dom.window.XMLSerializer;});
afterAll(()=>{dom.window.close();delete globalThis.DOMParser;delete globalThis.XMLSerializer;});
it.each(['rtl-runs','bidi-layout','rtl-font-context','complex-script-formatting'])('retains resolved script formatting in the editable %s import',async name=>{
  const source=readFileSync(`tests/fixtures/${name}/control.docx`);
  const pkg=await DocxPackage.open(source,{bestEffort:true});
  expect(pkg.readOnly).not.toBe(true);
  expect(pkg.paragraphs.some(p=>p.runs.some(r=>r.rtl||r.cs))).toBe(true);
  expect(pkg.paragraphs.every(p=>p.resolvedStyleId!==undefined)).toBe(true);
  const doc=new TextDocument(pkg.paragraphs,pkg.pageSettings,pkg.numbering,pkg.styles,pkg.tables,pkg.assets,{displayOnly:true});
  expect(doc.paragraphs.flatMap(p=>p.runs).filter(r=>r.rtl||r.cs).map(r=>[r.text,r.rtl,r.cs,r.fontCs,r.fontSizeCs])).toEqual(pkg.paragraphs.flatMap(p=>p.runs).filter(r=>r.rtl||r.cs).map(r=>[r.text,r.rtl,r.cs,r.fontCs,r.fontSizeCs]));
  expect(pkg.parts).toEqual(unzipSync(source));
  expect(unzipSync(new Uint8Array(await pkg.export(doc.paragraphs).arrayBuffer()))).toEqual(pkg.parts);
  expect(()=>new TextDocument(pkg.paragraphs,pkg.pageSettings,pkg.numbering,pkg.styles,pkg.tables,pkg.assets)).not.toThrow();
});
it('keeps malformed sizes rejected and hidden text marked in display validation',()=>{
  expect(checkedRunFormat({...RUN_FORMAT,rtl:true,vanish:true},{displayOnly:true}).vanish).toBe(true);
  expect(()=>checkedRunFormat({...RUN_FORMAT,rtl:true,fontSizeCs:0},{displayOnly:true})).toThrow();
  expect(checkedRunFormat({...RUN_FORMAT,rtl:true},{displayOnly:true}).rtl).toBe(true);
});

it('keeps the enclosing table when a cell contains active RTL text',async()=>{
  const parts=unzipSync(readFileSync('tests/fixtures/rtl-font-context/control.docx'));
  const xml=strFromU8(parts['word/document.xml']);
  const paragraph=xml.match(/<w:p>.*?<\/w:p>/gs)[1];
  const table='<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="9360"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="9360" w:type="dxa"/></w:tcPr>'+paragraph+'</w:tc></w:tr></w:tbl>';
  parts['word/document.xml']=strToU8(xml.replace(paragraph,table));
  const pkg=await DocxPackage.open(zipSync(parts),{bestEffort:true});
  expect(pkg.readOnly).not.toBe(true);expect(pkg.tables).toHaveLength(1);
  const cell=pkg.paragraphs.find(p=>p.cellId);
  expect(cell.runs.some(r=>r.rtl&&r.text==='012')).toBe(true);
  expect(cell.runs.find(r=>r.rtl)).toMatchObject({fontCs:'Courier New',fontSizeCs:16,boldCs:true});
  expect(pkg.parts).toEqual(parts);
});
it.each(['bidi'])('keeps unsupported paragraph %s guarded independently of run direction',async feature=>{
 const parts=unzipSync(readFileSync('tests/fixtures/rtl-font-context/control.docx'));
 const xml=new DOMParser().parseFromString(strFromU8(parts['word/document.xml']),'application/xml');
 const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main',p=xml.getElementsByTagNameNS(W,'p')[0];
 let properties=[...p.children].find(n=>n.localName==='pPr');if(!properties){properties=xml.createElementNS(W,'w:pPr');p.prepend(properties);}
 properties.append(xml.createElementNS(W,'w:'+feature));parts['word/document.xml']=strToU8(new XMLSerializer().serializeToString(xml));
 await expect(DocxPackage.open(zipSync(parts))).rejects.toMatchObject({name:'UnsupportedDocumentError'});
 const preview=await DocxPackage.open(zipSync(parts),{bestEffort:true});expect(preview.readOnly).toBe(true);expect(preview.parts).toEqual(parts);
});
