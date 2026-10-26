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
it('opens paragraphs and sections that state left-to-right direction explicitly for editing',async()=>{
 const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
 const parts=unzipSync(readFileSync('public/fixtures/two-paragraphs.docx'));
 const xml=strFromU8(parts['word/document.xml']);
 parts['word/document.xml']=strToU8(xml.replace('<w:p>','<w:p><w:pPr><w:bidi w:val="0"/></w:pPr>').replace('<w:docGrid','<w:bidi w:val="off"/><w:docGrid'));
 const pkg=await DocxPackage.open(zipSync(parts),{bestEffort:true});
 expect(pkg.readOnly).not.toBe(true);
 const doc=new TextDocument(pkg.paragraphs,pkg.pageSettings,pkg.numbering,pkg.styles,pkg.tables,pkg.assets);
 doc.select(0);doc.setParagraphFormat({alignment:'center'});doc.replace('Z');
 const saved=unzipSync(new Uint8Array(await pkg.export(doc.paragraphs).arrayBuffer()));
 const out=new DOMParser().parseFromString(strFromU8(saved['word/document.xml']),'application/xml');
 const flags=[...out.getElementsByTagNameNS(W,'bidi')].map(n=>[n.parentNode.localName,n.getAttributeNS(W,'val')]);
 expect(flags).toEqual([['pPr','0'],['sectPr','off']]);
 const reopened=await DocxPackage.open(zipSync(saved),{bestEffort:true});
 expect(reopened.readOnly).not.toBe(true);expect(reopened.paragraphs[0].runs.map(r=>r.text).join('')).toMatch(/^Z/);
});
it('opens list levels that state left-to-right direction explicitly for editing',async()=>{
 const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
 const numbering=`<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:bidi w:val="0"/><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
 const files={
  '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>',
  '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/_rels/document.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>',
  'word/numbering.xml':numbering,
  'word/document.xml':`<w:document xmlns:w="${W}"><w:body><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Item</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
 };
 const parts=Object.fromEntries(Object.entries(files).map(([k,v])=>[k,strToU8(v)]));
 const pkg=await DocxPackage.open(zipSync(parts),{bestEffort:true});
 expect(pkg.readOnly).not.toBe(true);
 const doc=new TextDocument(pkg.paragraphs,pkg.pageSettings,pkg.numbering,pkg.styles,pkg.tables,pkg.assets);
 expect(doc.paragraphs[0].list).toMatchObject({numId:'1',level:0});
 doc.select(0);doc.replace('First ');
 const saved=unzipSync(new Uint8Array(await pkg.export(doc.paragraphs,doc.pageSettings,doc.numbering).arrayBuffer()));
 expect(saved['word/numbering.xml']).toEqual(parts['word/numbering.xml']);
 // An enabled direction on a level still opens read-only.
 parts['word/numbering.xml']=strToU8(numbering.replace('<w:bidi w:val="0"/>','<w:bidi/>'));
 expect((await DocxPackage.open(zipSync(parts),{bestEffort:true})).readOnly).toBe(true);
});
