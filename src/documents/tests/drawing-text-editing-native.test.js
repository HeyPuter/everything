import {beforeAll,afterAll,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {unzipSync,zipSync,strToU8,strFromU8} from 'fflate';
import {JSDOM} from 'jsdom';
import {DocxPackage} from '../src/engine/docx.js';
import {TextDocument} from '../src/engine/model.js';
import {StorySession} from '../src/engine/story-session.js';
const root='tests/fixtures/drawing-text-editing/';
const read=name=>readFileSync(root+name);
const hashes=JSON.parse(read('hashes.json'));
const reference=JSON.parse(read('native-edits.json').toString('utf8').replace(/^\uFEFF/,''));
let dom;
beforeAll(()=>{dom=new JSDOM();globalThis.DOMParser=dom.window.DOMParser;globalThis.XMLSerializer=dom.window.XMLSerializer;});
afterAll(()=>{dom.window.close();delete globalThis.DOMParser;delete globalThis.XMLSerializer;});
const frames=pkg=>{
  const result=[];
  const visit=node=>{if(node.text)result.push(node.text.paragraphs);for(const child of node.children||[])visit(child);};
  for(const asset of Object.values(pkg.assets))if(asset.scene)visit(asset.scene);
  return result;
};
it('binds the native observations and separate saved copy to the original authored fixture',()=>{
  for(const [name,digest] of Object.entries(hashes))expect(createHash('sha256').update(read(name)).digest('hex')).toBe(digest);
  expect(reference.sourceSha256).toBe(hashes['control.docx']);expect(reference.sourceUnchanged).toBe(true);
  const capture=JSON.parse(read('native-page-capture.json').toString('utf8').replace(/^\uFEFF/,''));
  expect(capture.sourceSha256).toBe(reference.sourceSha256);expect(capture.savedBefore&&capture.savedAfter).toBe(true);
  expect(capture.captures[0].sha256).toBe(hashes['native-before.emf']);
  expect(reference.frames.map(f=>[f.firstParagraphBold,f.afterFirstParagraphBold,f.secondParagraphBold,f.afterSecondParagraphBold])).toEqual([[-1,-1,0,0],[-1,-1,0,0],[-1,-1,0,0]]);
});
for(const name of ['control.docx','native-edited.docx'])it(`retains drawing text and native formatting through no-edit round trip: ${name}`,async()=>{
  const pkg=await DocxPackage.open(read(name));
  expect(pkg.readOnly).toBeFalsy();const textFrames=frames(pkg);expect(textFrames).toHaveLength(3);
  expect(textFrames.map(ps=>ps.map(p=>p.runs.map(r=>r.text).join('')).join('\r')+'\r')).toEqual(reference.frames.map(f=>name==='control.docx'?f.before:f.after));
  for(const ps of textFrames){expect(ps[0].runs.filter(r=>r.text).every(r=>r.bold)).toBe(true);expect(ps[1].runs.filter(r=>r.text).every(r=>!r.bold)).toBe(true);}
  const original=unzipSync(read(name));
  expect(Object.keys(original).some(part=>part.startsWith('word/fonts/'))).toBe(false);
  const output=new Uint8Array(await pkg.export().arrayBuffer());expect(unzipSync(output)).toEqual(original);
},30000);
it('edits standalone and grouped titles like the native edits, with one chronological undo per frame',async()=>{
  const pkg=await DocxPackage.open(read('control.docx'));
  const model=new TextDocument(pkg.paragraphs,pkg.pageSettings,pkg.numbering,pkg.styles,pkg.tables,pkg.assets);
  const session=new StorySession(model);
  const positions=[];let at=0;for(const p of model.paragraphs){for(const r of p.runs){if(r.image)positions.push(at);at+=r.text.length;}at++;}
  for(const [step,position] of positions.entries()){
    model.select(position,position+1);const image=model.selectedImage;
    const frame=pkg.drawingTextFrames(image,model.assets)[0];expect(frame.reason).toBeNull();
    const draft=new TextDocument(frame.paragraphs,undefined,pkg.numbering,pkg.styles);
    draft.select(0,step?4:10);draft.replace(step?'Revised':'Updated');
    const prepared=pkg.prepareDrawingTextEdit(image,0,draft.paragraphs,model.assets);
    const id=`edit:${step}`;model.assets[id]=prepared.asset;
    session.run(()=>model.replaceDrawingText(image,id,prepared.shell));
  }
  const output=new Uint8Array(await session.export(pkg).arrayBuffer());
  const reopened=await DocxPackage.open(output),textFrames=frames(reopened);
  expect(textFrames.map(ps=>ps.map(p=>p.runs.map(r=>r.text).join('')).join('\r')+'\r')).toEqual(reference.frames.map(f=>f.after));
  expect(model.text).toBe(pkg.paragraphs.map(p=>p.runs.map(r=>r.text).join('')).join('\n'));
  for(const ps of textFrames){expect(ps[0].runs.filter(r=>r.text).every(r=>r.bold)).toBe(true);expect(ps[1].runs.filter(r=>r.text).every(r=>!r.bold)).toBe(true);}
  const source=unzipSync(read('control.docx')),saved=unzipSync(output);
  for(const part of Object.keys(source).filter(p=>p!=='word/document.xml'))expect(saved[part]).toEqual(source[part]);
  expect(session.history).toHaveLength(2);session.undo();session.undo();
  expect(unzipSync(new Uint8Array(await session.export(pkg).arrayBuffer()))).toEqual(source);
  session.redo();session.redo();expect(unzipSync(new Uint8Array(await session.export(pkg).arrayBuffer()))).toEqual(saved);
},30000);
it('keeps new paragraphs and mixed formatting without flattening the text frame',async()=>{
  const pkg=await DocxPackage.open(read('control.docx')),image=pkg.paragraphs.flatMap(p=>p.runs).find(r=>r.image).image;
  const draft=new TextDocument(pkg.drawingTextFrames(image)[0].paragraphs,undefined,pkg.numbering,pkg.styles);
  draft.select(draft.text.length,draft.text.length);draft.replace('\nThird paragraph');
  const start=draft.text.indexOf('Third');draft.select(start,start+5);draft.setRunFormat({italic:true});
  const edit=pkg.prepareDrawingTextEdit(image,0,draft.paragraphs);
  expect(edit.asset.scene.text.paragraphs).toHaveLength(3);
  const last=edit.asset.scene.text.paragraphs[2];expect(last.runs.find(r=>r.text==='Third').italic).toBe(true);
  expect(last.runs.find(r=>r.text.includes('paragraph')).italic).toBe(false);
  expect(pkg.prepareDrawingTextEdit(image,0,pkg.drawingTextFrames(image)[0].paragraphs)).toBeNull();
  // Underlined text is laid out and painted as body text is (decorated-text-box fixture).
  draft.select(0,5);draft.setRunFormat({underline:true});
  const underlined=pkg.prepareDrawingTextEdit(image,0,draft.paragraphs);
  expect(underlined.asset.scene.text.paragraphs[0].runs[0].underline).toBeTruthy();
  expect(underlined.shell).toContain('<w:u w:val="single" w:color="auto"/></w:rPr><w:t xml:space="preserve">Stand</w:t>');
},30000);
it('retains a supported controlled frame and leaves its plain grouped sibling editable',async()=>{
  const parts=unzipSync(read('control.docx'));
  let document=strFromU8(parts['word/document.xml']);
  // A structural holdout, deliberately containing the same visible words.
  // Rendering projects the control; editing must retain its ownership.
  document=document.replace(/(<wps:txbx><w:txbxContent>)([\s\S]*?)(<\/w:txbxContent>)/,(all,start,content,end)=>`${start}<w:sdt><w:sdtPr><w:id w:val="42"/></w:sdtPr><w:sdtContent>${content}</w:sdtContent></w:sdt>${end}`);
  parts['word/document.xml']=strToU8(document);
  const pkg=await DocxPackage.open(zipSync(parts)),images=pkg.paragraphs.flatMap(p=>p.runs).filter(r=>r.image).map(r=>r.image);
  const controlled=pkg.drawingTextFrames(images[0])[0];expect(controlled.reason).toBeNull();
  expect(controlled.paragraphs.every(p=>p.blockControls?.[0]?.persistent)).toBe(true);
  expect(pkg.prepareDrawingTextEdit(images[0],0,controlled.paragraphs)).toBeNull();
  expect(pkg.drawingTextFrames(images[1]).map(f=>f.reason)).toEqual([null,null]);
  const draft=new TextDocument(pkg.drawingTextFrames(images[1])[1].paragraphs,undefined,pkg.numbering,pkg.styles);
  draft.select(0,5);draft.replace('Changed');
  const prepared=pkg.prepareDrawingTextEdit(images[1],1,draft.paragraphs);
  expect(prepared.asset.scene.children[0].text).toEqual(pkg.assets[images[1].assetId].scene.children[0].text);
  expect(unzipSync(new Uint8Array(await pkg.export().arrayBuffer()))).toEqual(parts);
},30000);
it('retains alternative representations and rejects drawing text edits without source correspondence',async()=>{
  const pkg=await DocxPackage.open(read('control.docx')),image=pkg.paragraphs.flatMap(p=>p.runs).find(r=>r.image).image;
  const alternate={...image,shell:`<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><mc:Choice Requires="wps">${image.shell}</mc:Choice><mc:Fallback><legacy/></mc:Fallback></mc:AlternateContent>`};
  expect(pkg.drawingTextFrames(alternate)[0].reason).toContain('no corresponding text frames');
  expect(()=>pkg.prepareDrawingTextEdit(alternate,0,pkg.drawingTextFrames(alternate)[0].paragraphs)).toThrow('no corresponding text frames');
  const missing={...image,shell:'<drawing/>'};
  expect(pkg.drawingTextFrames(missing)[0].reason).toContain('source mapping');
  expect(()=>pkg.prepareDrawingTextEdit(missing,0,pkg.drawingTextFrames(missing)[0].paragraphs)).toThrow('source mapping');
  const draft=new TextDocument(pkg.drawingTextFrames(image)[0].paragraphs,undefined,pkg.numbering,pkg.styles);
  draft.select(0,1);draft.replace('X');
  expect(()=>pkg.prepareDrawingTextEdit(image,0,draft.paragraphs,pkg.assets,{...pkg.styles,defaultParagraph:'changed'})).toThrow('style changes');
},30000);
it('writes a header drawing edit only to its owning part and restores it through shared undo',async()=>{
  const parts=unzipSync(read('control.docx')),source=strFromU8(parts['word/document.xml']);
  const drawing=source.match(/<w:drawing>[\s\S]*?<\/w:drawing>/)[0];
  const opening=source.match(/<w:document\b[^>]*>/)[0].replace('<w:document','<w:hdr');
  parts['word/header1.xml']=strToU8(`${opening}<w:p><w:r>${drawing}</w:r></w:p></w:hdr>`);
  parts['word/document.xml']=strToU8(source.replace('<w:sectPr>','<w:sectPr><w:headerReference w:type="default" r:id="rHeader" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>'));
  parts['word/_rels/document.xml.rels']=strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>');
  parts['[Content_Types].xml']=strToU8(strFromU8(parts['[Content_Types].xml']).replace('</Types>','<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>'));
  const pkg=await DocxPackage.open(zipSync(parts));
  const body=new TextDocument(pkg.paragraphs,pkg.pageSettings,pkg.numbering,pkg.styles,pkg.tables,pkg.assets),session=new StorySession(body,pkg.pageStories);
  const model=session.activate('word/header1.xml');model.select(0,1);const image=model.selectedImage;
  const draft=new TextDocument(pkg.drawingTextFrames(image)[0].paragraphs,undefined,pkg.numbering,pkg.styles);draft.select(0,10);draft.replace('Header');
  const prepared=pkg.prepareDrawingTextEdit(image,0,draft.paragraphs);model.assets['header-edit']=prepared.asset;
  session.run(()=>model.replaceDrawingText(image,'header-edit',prepared.shell));
  const output=new Uint8Array(await session.export(pkg).arrayBuffer()),saved=unzipSync(output);
  expect(saved['word/document.xml']).toEqual(parts['word/document.xml']);
  const reopened=await DocxPackage.open(output),header=reopened.pageStories.stories['word/header1.xml'].paragraphs[0].runs[0].image;
  expect(reopened.drawingTextFrames(header)[0].paragraphs[0].runs.map(r=>r.text).join('')).toBe('Header title');
  session.undo();expect(unzipSync(new Uint8Array(await session.export(pkg).arrayBuffer()))).toEqual(parts);
},30000);
