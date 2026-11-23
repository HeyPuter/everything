import {it,expect,beforeAll,afterAll} from 'vitest';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {unzipSync,zipSync,strFromU8,strToU8} from 'fflate';
import {DocxPackage,W} from '../src/engine/docx.js';
import {TextDocument} from '../src/engine/model.js';
import {layoutShapeText} from '../src/engine/shape-text-layout.js';
let dom;
beforeAll(()=>{dom=new JSDOM('');globalThis.DOMParser=dom.window.DOMParser;globalThis.XMLSerializer=dom.window.XMLSerializer;});
afterAll(()=>{dom.window.close();delete globalThis.DOMParser;delete globalThis.XMLSerializer;});
const source=readFileSync('tests/fixtures/shape-text-transform/noAutofit.docx');
const leaf=node=>node.type==='group'?leaf(node.children[0]):node;
const measure=(text,style)=>({width:text.length*style.fontSize*.6,ascent:style.fontSize,descent:style.fontSize*.2});
it('retains script, signed positions and text width through standalone and grouped text layout',async()=>{
 const pkg=await DocxPackage.open(source),shapes=Object.values(pkg.assets).filter(a=>a.scene).map(a=>leaf(a.scene));
 expect(shapes).toHaveLength(16);
 const formats=[{verticalAlign:'superscript'},{verticalAlign:'subscript'},{baselineShift:7},{baselineShift:-7},{verticalAlign:'superscript',baselineShift:7},{verticalAlign:'superscript',baselineShift:7,characterSpacing:6},{textScale:50},{textScale:150}];
 for(const[i,node]of shapes.entries()){
  const run=node.text.paragraphs[0].runs[1];expect(run).toMatchObject({...formats[i%8],fontSize:20});
  const before=JSON.stringify(node),l=layoutShapeText(node,measure,i<8?{x:1,y:1}:{x:2,y:2}).layout;
  const fragment=l.lines[0].fragments.find(f=>f.verticalAlign===run.verticalAlign&&f.baselineShift===run.baselineShift&&f.textScale===run.textScale);
  expect(fragment.textTransform).toBeDefined();expect(fragment.fontSize).toBe(20);expect(JSON.stringify(node)).toBe(before);
  if(i%8>=6)expect(fragment.textTransform.scaleX).toBe(run.textScale/100);
 }
});
it('preserves retained transformed drawings through edits, reopen and exact undo',async()=>{
 const pkg=await DocxPackage.open(source),doc=new TextDocument(pkg.paragraphs,pkg.pageSettings,pkg.numbering,pkg.styles,pkg.tables,pkg.assets);
 const save=async()=>new Uint8Array(await pkg.export(doc.paragraphs,doc.pageSettings,doc.numbering,doc.styles,doc.tables,doc.assets).arrayBuffer());
 const same=b=>{const parts=unzipSync(b);expect(Object.keys(parts).sort()).toEqual(Object.keys(pkg.parts).sort());for(const[n,b]of Object.entries(pkg.parts))expect(Buffer.from(parts[n]).equals(Buffer.from(b)),n).toBe(true);};
 same(await save());doc.select(0);doc.replace('Edited ');const bytes=await save(),reopened=await DocxPackage.open(bytes);
 expect(new TextDocument(reopened.paragraphs).text).toBe(doc.text);
 const formats=p=>Object.values(p.assets).filter(a=>a.scene).map(a=>leaf(a.scene).text.paragraphs.map(({id,...p})=>p));expect(formats(reopened)).toEqual(formats(pkg));
 const drawings=b=>[...new DOMParser().parseFromString(strFromU8(unzipSync(b)['word/document.xml']),'application/xml').getElementsByTagNameNS(W,'drawing')].map(n=>new XMLSerializer().serializeToString(n));
 expect(drawings(bytes)).toEqual(drawings(source));doc.undo();same(await save());
});
// Underline, strikethrough and highlight are painted as in body text (tests/decorated-text-box.test.js).
it.each([['u','single','underline'],['strike','1','strikethrough'],['highlight','yellow','highlight']])('reads shape run %s=%s',async(tag,value,key)=>{
 const parts=unzipSync(source),xml=new DOMParser().parseFromString(strFromU8(parts['word/document.xml']),'application/xml');
 const text=xml.getElementsByTagNameNS(W,'txbxContent')[0],rp=text.getElementsByTagNameNS(W,'rPr')[0],n=xml.createElementNS(W,'w:'+tag);n.setAttributeNS(W,'w:val',value);rp.append(n);
 parts['word/document.xml']=strToU8(new XMLSerializer().serializeToString(xml));const pkg=await DocxPackage.open(zipSync(parts));
 const image=pkg.paragraphs.flatMap(p=>p.runs).find(r=>r.image).image,runs=[];
 const walk=node=>{if(node.text)runs.push(...node.text.paragraphs.flatMap(p=>p.runs));node.children?.forEach(walk);};walk(pkg.assets[image.assetId].scene);
 expect(runs.some(r=>r[key]&&r[key]!=='none')).toBe(true);
});
it.each([['u','notAStyle'],['vertAlign','wrong'],['position','401'],['w','0']])('still rejects unsupported or malformed shape run %s=%s',async(tag,value)=>{
 const parts=unzipSync(source),xml=new DOMParser().parseFromString(strFromU8(parts['word/document.xml']),'application/xml');
 const text=xml.getElementsByTagNameNS(W,'txbxContent')[0],rp=text.getElementsByTagNameNS(W,'rPr')[0],n=xml.createElementNS(W,'w:'+tag);n.setAttributeNS(W,'w:val',value);rp.append(n);
 parts['word/document.xml']=strToU8(new XMLSerializer().serializeToString(xml));await expect(DocxPackage.open(zipSync(parts))).rejects.toThrow();
});
