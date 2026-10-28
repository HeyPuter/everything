import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { parseXml } from '../src/engine/docx-xml.js';
import { pageFieldSegments, pageFieldInstruction, pageFieldValue } from '../src/engine/docx-page-fields.js';
const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
let dom;
beforeAll(()=>{dom=new JSDOM();globalThis.DOMParser=dom.window.DOMParser;globalThis.XMLSerializer=dom.window.XMLSerializer;});
afterAll(()=>{dom.window.close();delete globalThis.DOMParser;delete globalThis.XMLSerializer;});
const paragraph=body=>parseXml(`<w:p xmlns:w="${W}">${body}</w:p>`).documentElement;
const r=body=>`<w:r>${body}</w:r>`;
const delimiter=type=>`<w:fldChar w:fldCharType="${type}"/>`;
it('reads the independently authored complex PAGE fields without rewriting their cache or XML',()=>{
  const parts=unzipSync(readFileSync('tests/fixtures/page-stories/footer-variants.docx'));
  for(const variant of ['first','even','default']) {
    const p=parseXml(parts[`word/footer-${variant}.xml`]).getElementsByTagNameNS(W,'p')[0];
    const before=new XMLSerializer().serializeToString(p),segments=pageFieldSegments(p);
    expect(segments).toHaveLength(2);expect(segments[1].field).toMatchObject({type:'PAGE',mergeFormat:true,locked:false});
    expect(segments[1].resultNodes.map(n=>n.textContent).join('')).toBe('99');
    expect(pageFieldValue(segments[1].field,{pageNumber:2,pageCount:3,sectionPageCount:3})).toBe('2');
    expect(new XMLSerializer().serializeToString(p)).toBe(before);
    const retained=paragraph(segments[1].field.source);
    expect(pageFieldSegments(retained)[0].field.type).toBe('PAGE');
  }
});
it('handles shared runs and split instruction text while retaining surrounding text',()=>{
  const p=paragraph(r('<w:t>Before </w:t>'+delimiter('begin')+'<w:instrText> PA</w:instrText>')+r('<w:instrText>GE </w:instrText>'+delimiter('separate')+'<w:t>99</w:t>'+delimiter('end')+'<w:t> after</w:t>'));
  const segments=pageFieldSegments(p);
  expect(segments).toHaveLength(3);expect(segments[0].node.textContent).toBe('Before ');expect(segments[2].node.textContent).toBe(' after');
  expect(segments[1].field.type).toBe('PAGE');expect(segments[1].resultNodes[0].textContent).toBe('99');
});
it.each(['PAGE','NUMPAGES','SECTIONPAGES'])('reads simple %s fields with retained formatting',type=>{
  const p=paragraph(`<w:fldSimple w:instr="${type}">${r('<w:rPr><w:b/></w:rPr><w:t>99</w:t>')}</w:fldSimple>`);
  const [segment]=pageFieldSegments(p);
  expect(segment.field.type).toBe(type);expect(segment.resultNodes[0].getElementsByTagNameNS(W,'b')).toHaveLength(1);
  expect(pageFieldValue(segment.field,{pageNumber:2,pageCount:8,sectionPageCount:3})).toBe({PAGE:'2',NUMPAGES:'8',SECTIONPAGES:'3'}[type]);
});
it('retains locked results and supports an uncached complex field',()=>{
  const [locked]=pageFieldSegments(paragraph('<w:fldSimple w:instr="PAGE" w:fldLock="true"><w:r><w:t>99</w:t></w:r></w:fldSimple>'));
  expect(pageFieldValue(locked.field,{pageNumber:2})).toBeNull();
  const [empty]=pageFieldSegments(paragraph(r(delimiter('begin')+'<w:instrText>PAGE</w:instrText>'+delimiter('end'))));
  expect(empty.resultNodes).toEqual([]);expect(pageFieldValue(empty.field,{pageNumber:0})).toBe('0');
});
it.each([
  r(delimiter('begin')+'<w:instrText>PAGE</w:instrText>'),
  r(delimiter('separate')),
  r(delimiter('begin')+delimiter('begin')),
  r('<w:instrText>PAGE</w:instrText>'),
  r(delimiter('begin')+'<w:instrText>PAGE</w:instrText>'+delimiter('separate')+delimiter('separate')+delimiter('end')),
  '<w:fldSimple w:instr="PAGE" w:fldLock="yes"/>',
])('rejects malformed field sequences before editing',xml=>expect(()=>pageFieldSegments(paragraph(xml))).toThrow());
it.each(['COMPARE 1 = 1','PAGE \\#','PAGE \\* Unknown','PAGE \\* MERGEFORMAT \\* MERGEFORMAT'])('does not silently approximate %s',code=>expect(()=>pageFieldInstruction(code)).toThrow());
it('retains DATE with its cached result instead of approximating it',()=>{const field=pageFieldInstruction('DATE \\@ "MMMM d"');expect(field).toMatchObject({type:'DATE',retained:true});expect(pageFieldValue(field,{pageNumber:1,pageCount:1,sectionPageCount:1})).toBeNull();});

it('applies explicit general numeric formats before section numbering and pictures before general formats',()=>{
 const context={pageNumber:27,pageCount:5,sectionPageCount:1,pageNumbering:{format:'upperRoman'}};
 for(const [format,result] of [['Arabic','27'],['ArabicDash','- 27 -'],['ROMAN','XXVII'],['roman','xxvii'],['ALPHABETIC','AA'],['alphabetic','aa']]){
  expect(pageFieldValue(pageFieldInstruction(`PAGE \\* ${format}`),context)).toBe(result);
 }
 for(const instruction of ['PAGE \\* ROMAN \\# 0000','PAGE \\# 0000 \\* ROMAN'])expect(pageFieldValue(pageFieldInstruction(instruction),context)).toBe('0027');
 expect(pageFieldValue(pageFieldInstruction('PAGE \\* Arabic \\* roman'),context)).toBe('xxvii');
 expect(pageFieldValue(pageFieldInstruction('PAGE \\* roman \\* Arabic'),context)).toBe('27');
 expect(pageFieldValue(pageFieldInstruction('NUMPAGES \\* ROMAN'),context)).toBe('V');
 expect(pageFieldValue(pageFieldInstruction('SECTIONPAGES \\* Arabic'),context)).toBe('1');
});
it('retains a locked general field cache and handles zero without discarding its format',()=>{
 const f=pageFieldInstruction('PAGE \\* roman');
 expect(pageFieldValue(f,{pageNumber:0})).toBe(' ');
 expect(pageFieldValue({...f,locked:true},{pageNumber:12})).toBeNull();
 expect(pageFieldValue({...f,locked:true},{pageNumber:12,pageStory:true})).toBe('xii');
});
it('reads the Arabic switch in any letter case, as LibreOffice writes it (PAGE \\* ARABIC)',()=>{
 const context={pageNumber:27,pageCount:5,sectionPageCount:1,pageNumbering:{format:'upperRoman'}};
 for(const format of ['ARABIC','arabic','ARABICDASH','arabicdash']){
  const field=pageFieldInstruction(` PAGE \\* ${format} `);
  expect(field.instruction).toBe(` PAGE \\* ${format} `);
  expect(pageFieldValue(field,context)).toBe(/dash/i.test(format)?'- 27 -':'27');
 }
 expect(pageFieldValue(pageFieldInstruction('NUMPAGES \\* ARABIC'),context)).toBe('5');
 // The case of roman and alphabetic chooses the case of the result, so only the two exact spellings are read.
 expect(()=>pageFieldInstruction('PAGE \\* Roman')).toThrow();
});
