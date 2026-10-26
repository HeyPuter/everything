import {beforeAll,afterAll,it,expect} from 'vitest';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {unzipSync,strFromU8} from 'fflate';
import {DocxPackage} from '../src/engine/docx.js';
import {TextDocument} from '../src/engine/model.js';
import {blockControlGroups} from '../src/engine/block-controls.js';
let dom;beforeAll(()=>{dom=new JSDOM();globalThis.DOMParser=dom.window.DOMParser;globalThis.XMLSerializer=dom.window.XMLSerializer;mkdirSync('test-results',{recursive:true});});afterAll(()=>dom.window.close());
const model=p=>new TextDocument(p.paragraphs,p.pageSettings,p.numbering,p.styles,p.tables,p.assets);
const save=async(p,d)=>new Uint8Array(await p.export(d.paragraphs,d.pageSettings,d.numbering,d.styles,d.tables,d.assets).arrayBuffer());
for(const location of ['body','cell'])it(`retains ${location} block bookmark paragraph boundaries through formatting, editing and undo`,async()=>{
  const source=readFileSync(`public/fixtures/block-bookmark-${location}.docx`),pkg=await DocxPackage.open(source),d=model(pkg);
  const range=d.bookmarks[0];expect(d.text.slice(range.start,range.end)).toBe('Control alpha\nControl beta\n');
  d.select(range.start,range.start+7);d.toggleBold();
  let bytes=await save(pkg,d),reopened=model(await DocxPackage.open(bytes));
  expect(reopened.text.slice(reopened.bookmarks[0].start,reopened.bookmarks[0].end)).toBe('Control alpha\nControl beta\n');
  expect(blockControlGroups(reopened.paragraphs)).toHaveLength(1);
  d.select(range.start+2);d.replace('X');bytes=await save(pkg,d);reopened=model(await DocxPackage.open(bytes));
  expect(reopened.text.slice(reopened.bookmarks[0].start,reopened.bookmarks[0].end)).toBe('CoXntrol alpha\nControl beta\n');
  expect(blockControlGroups(reopened.paragraphs)).toHaveLength(0);
  writeFileSync(`test-results/block-bookmark-${location}.docx`,bytes);
  const xml=new DOMParser().parseFromString(strFromU8(unzipSync(bytes)['word/document.xml']),'application/xml');
  expect(xml.getElementsByTagNameNS('*','bookmarkEnd')[0].parentElement.localName).toBe(location==='body'?'body':'tc');
  d.undo();d.undo();expect(unzipSync(await save(pkg,d))).toEqual(unzipSync(source));
});
it('preserves a bookmark after the final paragraph without adding a visible empty paragraph',async()=>{
  const source=readFileSync('public/fixtures/block-bookmark-final.docx'),parts=unzipSync(source);
  const pkg=await DocxPackage.open(source),d=model(pkg);
  expect(d.bookmarks[0].end).toBe(d.text.length+1);expect(d.paragraphs).toHaveLength(3);
  d.select(d.bookmarks[0].start+2);d.replace('X');
  const bytes=await save(pkg,d),reopened=model(await DocxPackage.open(bytes));
  writeFileSync('test-results/block-bookmark-final.docx',bytes);
  expect(reopened.bookmarks[0].end).toBe(reopened.text.length+1);expect(reopened.paragraphs).toHaveLength(3);
  d.undo();expect(unzipSync(await save(pkg,d))).toEqual(parts);
});

it.each(['rename','remove','split','search','row','table deletion'])('preserves valid cell bookmark ranges after %s',async operation=>{
  const source=readFileSync('public/fixtures/block-bookmark-cell.docx'),pkg=await DocxPackage.open(source),d=model(pkg);
  const bookmark=d.bookmarks[0];d.select(bookmark.start+2);
  if(operation==='rename')d.renameBookmark(bookmark.id,'Renamed');
  if(operation==='remove')d.removeBookmark(bookmark.id);
  if(operation==='split')d.replace('\n');
  if(operation==='search')d.replaceMatches('Control','Changed',{},true);
  if(operation==='row')d.insertTableRow();
  if(operation==='table deletion')d.deleteTablePart('table');
  const bytes=await save(pkg,d),reopened=model(await DocxPackage.open(bytes));
  expect(reopened.text).toBe(d.text);
  if(['remove','table deletion'].includes(operation))expect(reopened.bookmarks).toHaveLength(0);
  else {
    const current=reopened.bookmarks[0];
    const expected=operation==='split'?'Co\nntrol alpha\nControl beta\n':operation==='search'?'Changed alpha\nChanged beta\n':'Control alpha\nControl beta\n';
    expect(reopened.text.slice(current.start,current.end)).toBe(expected);
    expect(current.name).toBe(operation==='rename'?'Renamed':'WholeBlock');
  }
  d.undo();expect(unzipSync(await save(pkg,d))).toEqual(unzipSync(source));
});

it.each(['row','column'])('keeps a bookmark around a whole table consistent when inserting a %s',async operation=>{
  const source=readFileSync('public/fixtures/block-bookmark-table.docx'),parts=unzipSync(source);
  const pkg=await DocxPackage.open(source),d=model(pkg);
  const previousEnd=d.bookmarks[0].end;
  d.select(d.text.indexOf('Control alpha'));if(operation==='row')d.insertTableRow();else d.insertTableColumn();
  expect(d.bookmarks[0].end).toBe(previousEnd+1);
  const reopened=model(await DocxPackage.open(await save(pkg,d)));
  expect(reopened.text).toBe(d.text);
  expect(reopened.bookmarks.map(b=>[b.start,b.end])).toEqual(d.bookmarks.map(b=>[b.start,b.end]));
  d.deleteTablePart(operation);
  expect(d.bookmarks[0].end).toBe(previousEnd);
  expect(model(await DocxPackage.open(await save(pkg,d))).bookmarks[0].end).toBe(previousEnd);
  d.undo();d.undo();expect(unzipSync(await save(pkg,d))).toEqual(parts);
});
it.each([
  ['Delete Table',d=>d.deleteTablePart('table')],
  ['Delete Rows',d=>{d.setCellBlock({tableId:d.tables[0].id,top:0,bottom:0,left:0,right:1});return d.deleteTablePart('row');}],
  ['a selection around it',d=>{d.select(d.text.indexOf('block')+2,d.text.indexOf('After block')+3);return d.replace('');}],
])('keeps a document saveable after %s removes a table a bookmark encloses',async(name,remove)=>{
  const source=readFileSync('public/fixtures/block-bookmark-table.docx'),parts=unzipSync(source);
  const pkg=await DocxPackage.open(source),d=model(pkg);
  d.select(d.text.indexOf('Control alpha'));
  expect(remove(d)).toBe(true);
  expect(d.tables).toHaveLength(0);
  // The bookmark stays, empty, where the table was.
  expect(d.bookmarks.map(b=>b.name)).toEqual(['WholeBlock']);
  expect(d.bookmarks[0].end).toBe(d.bookmarks[0].start);
  const reopened=await DocxPackage.open(await save(pkg,d));
  expect(reopened.readOnly).toBeFalsy();
  expect(model(reopened).text).toBe(d.text);
  expect(model(reopened).bookmarks.map(b=>b.name)).toEqual(['WholeBlock']);
  d.undo();expect(unzipSync(await save(pkg,d))).toEqual(parts);
});
it('moves block bookmark placement to the surviving cell when merging cells',async()=>{
  const source=readFileSync('public/fixtures/block-bookmark-merged.docx'),pkg=await DocxPackage.open(source),d=model(pkg);
  d.select(d.text.indexOf('First cell'),d.text.indexOf('After cell control')+3);d.mergeCells();
  const reopened=model(await DocxPackage.open(await save(pkg,d)));
  expect(reopened.bookmarks).toHaveLength(1);
  expect(blockControlGroups(reopened.paragraphs)).toHaveLength(1);
  const bookmark=reopened.bookmarks[0];expect(reopened.text.slice(bookmark.start,bookmark.end)).toBe('Control alpha\nControl beta\n');
  d.undo();expect(unzipSync(await save(pkg,d))).toEqual(unzipSync(source));
});
