import {beforeAll,afterAll,it,expect} from 'vitest';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {unzipSync} from 'fflate';
import {DocxPackage,createDocx,WRITING_STYLES} from '../src/engine/docx.js';
import {TextDocument,paragraph} from '../src/engine/model.js';
import {pictureFragment} from '../src/engine/picture-insert.js';
import {layoutDocument,imageAtPoint} from '../src/engine/layout.js';
import {pageGeometry} from '../src/engine/page-settings.js';
let dom;
beforeAll(()=>{dom=new JSDOM();globalThis.DOMParser=dom.window.DOMParser;globalThis.XMLSerializer=dom.window.XMLSerializer;});
afterAll(()=>{dom.window.close();delete globalThis.DOMParser;delete globalThis.XMLSerializer;});
const source=readFileSync('tests/fixtures/image-interaction/control.docx');
const setup=async()=>{const pkg=await DocxPackage.open(source);return {pkg,model:new TextDocument(pkg.paragraphs,pkg.pageSettings,pkg.numbering,pkg.styles,pkg.tables,pkg.assets)};};
const images=model=>{let offset=0;const out=[];for(const p of model.paragraphs){for(const r of p.runs){if(r.image)out.push({image:r.image,start:offset});offset+=r.text.length;}offset++;}return out;};
const save=async(pkg,model)=>new Uint8Array(await pkg.export(model.paragraphs,model.pageSettings,model.numbering,model.styles,model.tables,model.assets).arrayBuffer());
it('lets text win over behind-text pictures but keeps explicit picture picking and front layers',async()=>{
  const {model}=await setup(),measure=(text,style)=>({width:text.length*style.fontSize*.6,ascent:style.fontSize,descent:style.fontSize*.2});
  const layout=layoutDocument(model.paragraphs,measure,pageGeometry(model.pageSettings),model.numbering,model.tables);
  const line=layout.lines.find(l=>l.fragments.some(f=>f.text==='Editable text')),f=line.fragments.find(f=>f.text==='Editable text');
  expect(imageAtPoint(layout,0,f.x+5,line.y+5)).toBeNull();
  const picture=imageAtPoint(layout,0,f.x+5,line.y+5,{includeBehindText:true});expect(picture.image.anchor.behind).toBe(true);
  picture.image.anchor.behind=false;
  expect(imageAtPoint(layout,0,f.x+5,line.y+5)).toBe(picture);
});
it('exports position and layer changes, preserving unrelated package bytes, with exact undo',async()=>{
  const {pkg,model}=await setup(),first=images(model)[0];model.select(first.start,first.start+1);
  model.setImageProperties({anchor:{x:127000,y:254000,behind:false,order:5}});
  const output=await save(pkg,model),reopened=await DocxPackage.open(output);
  expect(images(reopened)[0].image.anchor).toMatchObject({x:127000,y:254000,behind:false,order:5});
  const original=unzipSync(source),parts=unzipSync(output);
  for(const name of Object.keys(original)) if(name!=='word/document.xml') expect(parts[name]).toEqual(original[name]);
  model.undo();expect(unzipSync(await save(pkg,model))).toEqual(original);
});
it('orders floating siblings and retains the original text and image content',async()=>{
  const {pkg,model}=await setup(),first=images(model)[0],text=model.text;model.select(first.start,first.start+1);
  model.arrangeImage('front');
  expect(images(model)[0].image.anchor.order).toBeGreaterThan(images(model)[1].image.anchor.order);
  const reopened=await DocxPackage.open(await save(pkg,model));
  expect(images(reopened)[0].image.anchor.order).toBeGreaterThan(images(reopened)[1].image.anchor.order);
  expect(model.text).toBe(text);model.undo();expect(unzipSync(await save(pkg,model))).toEqual(unzipSync(source));
});
it('moves inline pictures through text without losing assets, cropping or IDs',async()=>{
  const {pkg,model}=await setup(),inline=images(model)[2];model.select(inline.start,inline.start+1);
  const id=inline.image.id,asset=inline.image.assetId;
  model.moveImage(model.text.length);
  expect(model.text.endsWith('\ufffc')).toBe(true);
  const moved=images(model).find(x=>x.image.id===id);expect(moved.image.assetId).toBe(asset);
  const reopened=await DocxPackage.open(await save(pkg,model));expect(images(reopened)).toHaveLength(3);
  model.undo();expect(unzipSync(await save(pkg,model))).toEqual(unzipSync(source));
});
it('moves an inline picture with Track Changes on into a file that opens again, with distinct drawing IDs',async()=>{
  // A picture in a document saved and opened again, then dragged to the end of the text with tracking on.
  const created=createDocx([paragraph()],undefined,undefined,undefined,[],{},WRITING_STYLES),first=new TextDocument(created.paragraphs,created.pageSettings,created.numbering,created.styles,created.tables,created.assets);
  first.replace('Picture: after');
  first.select('Picture: '.length);
  const fragment=await pictureFragment(first,created.parts,{png:readFileSync('icon-128.png'),width:914400,height:914400,id:1,name:'Picture 1'});
  Object.assign(first.assets,fragment.assets);const {assetId,id:_,...properties}=fragment.image;first.insertImage(assetId,properties);
  const pkg=await DocxPackage.open(await save(created,first)),model=new TextDocument(pkg.paragraphs,pkg.pageSettings,pkg.numbering,pkg.styles,pkg.tables,pkg.assets);
  const inline=images(model)[0],id=inline.image.id;model.select(inline.start,inline.start+1);
  model.trackChanges=true;model.revisionAuthor='Reviewer';
  model.moveImage(model.text.length);
  // The picture stays as a deletion where it was and is inserted at the end: two drawings, two IDs.
  const runs=model.paragraphs.flatMap(p=>p.runs).filter(r=>r.image);
  expect(runs.map(r=>r.revision?.type)).toEqual(['del','ins']);
  expect(runs[0].image.id).toBe(id);expect(runs[1].image.id).not.toBe(id);
  const reopened=await DocxPackage.open(await save(pkg,model));
  expect(reopened.readOnly).toBeFalsy();expect(images(reopened)).toHaveLength(2);
  // Moving it again (an arrow-key nudge) removes that insertion and inserts it anew: still distinct IDs.
  model.moveImage(0);
  expect(new Set(images(model).map(x=>x.image.id)).size).toBe(images(model).length);
});
it('rejects invalid positions and retains authored alignment on unchanged axes',async()=>{
  const {pkg,model}=await setup(),first=images(model)[0];model.select(first.start,first.start+1);
  expect(()=>model.setImageProperties({anchor:{x:20116801}})).toThrow(/22 inches/);
  model.setImageProperties({anchor:{behind:false}});
  const reopened=await DocxPackage.open(await save(pkg,model));expect(images(reopened)[0].image.anchor).toMatchObject({x:0,y:0,behind:false});
});
