// @vitest-environment jsdom
import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {wordPosition,optionWordPosition} from '../src/engine/word-navigation.js';
import {wordBreaks} from '../src/engine/dictionary-breaks.js';
import {DocxPackage} from '../src/engine/docx.js';
import {TextDocument} from '../src/engine/model.js';
const root='tests/fixtures/native-navigation/';
const reference=JSON.parse(readFileSync(root+'native-ranges.json','utf8').replace(/^\uFEFF/,''));
const texts=JSON.parse(readFileSync(root+'cases.json','utf8'));
const source=readFileSync(root+'control.docx');
it('binds authored source and visible text to unchanged native reference range captures',async()=>{
 expect(createHash('sha256').update(source).digest('hex')).toBe(reference.sourceSha256);
 expect(reference).toMatchObject({savedBefore:true,savedAfter:true,sourceUnchanged:true});
 expect(reference.text).toBe(texts.join('\r')+'\r');
 const pkg=await DocxPackage.open(new Uint8Array(source)),doc=new TextDocument(pkg.paragraphs,pkg.pageSettings,pkg.numbering,pkg.styles,pkg.tables,pkg.assets);
 expect(doc.text).toBe(texts.join('\n'));
});
it('matches native word movement at every captured UTF-16 position in both directions',()=>{
 const text=texts.join('\n');
 const failures=[];
 for(const row of reference.positions)for(const move of row.moves){
  const actual=wordPosition(text,row.position,move.direction),expected=Math.min(text.length,move.position);
  if(actual!==expected)failures.push({position:row.position,direction:move.direction,expected,actual});
 }
 expect(failures).toEqual([]);
});
it('collapses a text selection to its containing word boundary without taking another unit',()=>{
 const text=texts.join('\n');
 for(const move of reference.selections){
  const edge=move.direction<0?move.start:move.end;
  expect(wordPosition(text,edge,move.direction,true)).toBe(move.position);
 }
});
it('moves Option word steps to word starts going left and word ends going right',()=>{
 const walk=(text,from,direction)=>{const stops=[];let at=from;while(direction<0?at>0:at<text.length){at=optionWordPosition(text,at,direction);stops.push(at);}return stops;};
 const text='Hello brave, new world. Second sentence here.';
 expect(walk(text,text.length,-1)).toEqual([44,40,31,24,22,17,13,11,6,0]);
 expect(walk(text,0,1)).toEqual([5,11,12,16,22,23,30,39,44,45]);
 // Adjacent punctuation is one stop; whitespace, tabs and paragraph breaks are skipped.
 const marks='Wait... what?!\nNext\tline';
 expect(walk(marks,marks.length,-1)).toEqual([20,15,12,8,4,0]);
 expect(walk(marks,0,1)).toEqual([4,7,12,14,19,24]);
 expect(optionWordPosition("It's done",0,1)).toBe(4);
});
it('steps Ctrl+Arrow through Thai, Lao, Khmer and Myanmar words by their dictionary boundaries',()=>{
 // These scripts put no spaces between words; a run of their letters was one word, crossed in a single step.
 const walk=(text,from,direction)=>{const stops=[];let at=from;while(direction<0?at>0:at<text.length){at=wordPosition(text,at,direction);stops.push(at);}return stops;};
 const text='ภาษาไทยง่ายนิดเดียว แต่ยาก. ខ្ញុំស្រលាញ់ ok';
 expect(walk(text,0,1)).toEqual([4,7,11,14,20,23,26,28,33,41,43]);
 expect(walk(text,text.length,-1)).toEqual([41,33,28,26,23,20,14,11,7,4,0]);
 // A selection inside a word collapses to that word's boundary; at a boundary it stays.
 expect(wordPosition(text,9,-1,true)).toBe(7); expect(wordPosition(text,9,1,true)).toBe(11);
 expect(wordPosition(text,7,1,true)).toBe(7); expect(wordPosition(text,7,-1,true)).toBe(7);
 // Latin, Greek and Chinese letter runs keep the native reference's units.
 expect(walk('Alpha beta 中文 words',0,1)).toEqual([6,11,14,19]);
});
it('finds word steps from the paragraphs around the caret, as from the whole text, and quickly in a long document',()=>{
 // The steps as they were found before, from the whole text.
 const whole=(text,position,direction,inclusive=false)=>{
  const units=/(?:[\p{L}\p{N}\p{M}]+(?:['’][\p{L}\p{N}\p{M}]+)*|[^\p{L}\p{N}\p{M}  \t\n\r\v\f\u000e￼]+)[  ]*|[  ]+|[\t\n\r\v\f\u000e￼]/gu;
  const starts=unit=>{const inside=wordBreaks(unit[0]);return inside?[unit.index,...[...inside].sort((a,b)=>a-b).map(o=>unit.index+o)]:[unit.index];};
  let previous=null;const back=()=>previous?starts(previous).findLast(s=>s<position||inclusive&&s===position):0;
  for(const unit of text.matchAll(units)){
   if(direction<0&&unit.index>=position)return inclusive&&unit.index===position?position:back();
   if(direction>0&&(unit.index>position||inclusive&&unit.index===position))return unit.index;
   if(direction>0&&unit.index+unit[0].length>position){const next=starts(unit).find(s=>s>position||inclusive&&s===position);if(next!==undefined)return next;}
   previous=unit;
  }
  return direction>0?text.length:back();
 };
 const wholeOption=(text,position,direction)=>{
  const units=[];
  for(const s of new Intl.Segmenter(undefined,{granularity:'word'}).segment(text)){if(!/\S/u.test(s.segment))continue;const end=s.index+s.segment.length,last=units.at(-1);if(!s.isWordLike&&last&&!last.word&&last.end===s.index)last.end=end;else units.push({start:s.index,end,word:!!s.isWordLike});}
  return direction<0?units.findLast(u=>u.start<position)?.start??0:units.find(u=>u.end>position)?.end??text.length;
 };
 const pieces=['word','Ab',' ',' ',' ','\t','\n','\n','\n\n','\v','\f','￼','.','?!','don’t',"it's",'-','ภาษาไทย','ง่าย','中文','é','😀','12'];
 let seed=7;const random=n=>(seed=(seed*1103515245+12345)%2147483648)%n;
 for(let round=0;round<120;round++){
  let text='';for(let i=random(24);i>=0;i--)text+=pieces[random(pieces.length)];
  for(let position=0;position<=text.length;position++)for(const direction of [-1,1]){
   for(const inclusive of [false,true])expect(wordPosition(text,position,direction,inclusive),JSON.stringify([text,position,direction,inclusive])).toBe(whole(text,position,direction,inclusive));
   expect(optionWordPosition(text,position,direction),JSON.stringify([text,position,direction])).toBe(wholeOption(text,position,direction));
  }
 }
 // Far from the caret, a long document's text is not read: each step takes a fraction of a millisecond.
 const long=Array.from({length:4000},(_,i)=>`Paragraph ${i} has a few words in it, and then some more of them.`).join('\n');
 const started=performance.now();
 for(let i=0;i<200;i++){wordPosition(long,long.length-40,-1);wordPosition(long,long.length-40,1);optionWordPosition(long,long.length-40,-1);optionWordPosition(long,long.length-40,1);}
 expect(performance.now()-started).toBeLessThan(400);
});
