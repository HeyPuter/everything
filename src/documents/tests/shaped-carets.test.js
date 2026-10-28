import {it,expect} from 'vitest';
import {paragraph} from '../src/engine/model.js';
import {RUN_FORMAT} from '../src/engine/formatting.js';
import {layoutDocument,caretRect,selectionRects,hitTest} from '../src/engine/layout.js';
import {measureTextGeometry} from '../src/engine/text-geometry.js';

it('requests full-fragment caret advances once and preserves source offsets around hidden soft hyphens',()=>{
  const p=paragraph('');p.runs=[{...RUN_FORMAT,rtl:true,text:'א\u00adב'}];
  const requests=[];
  const layout=layoutDocument([p],(text,style)=>{
    if(style.caretOffsets) requests.push({text,offsets:style.caretOffsets});
    return {width:text.length*4,ascent:12,descent:3,...(style.caretOffsets?{caretAdvances:style.caretOffsets.map(i=>i*4)}:{})};
  });
  expect(requests).toEqual([{text:'אב',offsets:[0,1,1,2]}]);
  expect(caretRect(layout,1).x).toBe(caretRect(layout,2).x);
  expect(selectionRects(layout,0,1)[0].width).toBe(4);
  expect(p.runs[0].text).toBe('א\u00adב');
});

it('uses context advances for ligature selections instead of reshaped prefix widths',()=>{
  const p=paragraph('');p.runs=[{...RUN_FORMAT,rtl:true,text:'لا'}];
  const layout=layoutDocument([p],(text,style)=>({width:text.length?text.length===1?3.8:4:0,ascent:12,descent:3,...(style.caretOffsets?{caretAdvances:[0,2,4]}:{})}));
  const right=caretRect(layout,0).x;
  expect(caretRect(layout,1).x).toBe(right-2);
  expect(selectionRects(layout,0,1)[0].width).toBe(2);
  expect(selectionRects(layout,1,2)[0].width).toBe(2);
});

it('does not request shaped caret geometry for ordinary unmarked text',()=>{
  let requests=0;
  layoutDocument([paragraph('ordinary text')],(text,style)=>{if(style.caretOffsets)requests++;return {width:text.length*4,ascent:12,descent:3};});
  expect(requests).toBe(0);
});

it('scales context advances with glyph geometry without changing their source indices',()=>{
  const offsets=[0,1,2],style={...RUN_FORMAT,fontFamily:'Arial',rtl:true,caretOffsets:offsets,textScale:150};
  const metrics=measureTextGeometry('لا',style,()=>({width:4,ascent:12,descent:3,caretAdvances:[0,2,4]}));
  expect(metrics.caretAdvances).toEqual([0,3,6]);expect(metrics.width).toBe(6);
  expect(offsets).toEqual([0,1,2]);
});

it('uses complete LTR ligature carets for pointer hits, selection and hidden source characters',()=>{
  const p=paragraph('');p.runs=[{...RUN_FORMAT,ligatures:'standardContextual',text:'f\u00adfi'}];
  const requests=[];
  const layout=layoutDocument([p],(text,style)=>{
    if(style.caretOffsets)requests.push({text,offsets:style.caretOffsets});
    return {width:text.length?text.length===1?3.8:4:0,ascent:12,descent:3,
      ...(style.caretOffsets?{caretAdvances:style.caretOffsets.map(i=>i*4/3)}:{})};
  });
  expect(requests).toEqual([{text:'ffi',offsets:[0,1,1,2,3]}]);
  const first=caretRect(layout,0).x;
  expect(caretRect(layout,1).x-first).toBeCloseTo(4/3);
  expect(caretRect(layout,2).x).toBe(caretRect(layout,1).x);
  expect(selectionRects(layout,2,3)[0].width).toBeCloseTo(4/3);
  const caret=caretRect(layout,3);
  expect(hitTest(layout,caret.page,caret.x,caret.y+caret.height/2)).toBe(3);
  expect(p.runs[0].text).toBe('f\u00adfi');
});

it('reuses complete shaping within a layout without retaining stale positions across layouts',()=>{
  const paragraphs=Array.from({length:20},()=>{const p=paragraph('');p.runs=[{...RUN_FORMAT,ligatures:'standard',text:'ffi'}];return p;});
  let requests=0;
  const measure=(text,style)=>{
    if(style.caretOffsets)requests++;
    return {width:text.length*4,ascent:12,descent:3,...(style.caretOffsets?{caretAdvances:style.caretOffsets.map(i=>i*4)}:{})};
  };
  const first=layoutDocument(paragraphs,measure);expect(first.lines).toHaveLength(20);expect(requests).toBe(1);
  layoutDocument(paragraphs,measure);expect(requests).toBe(2);
});

it('keeps a long clipped space tail out of complete-run caret requests',()=>{
  const p=paragraph('');p.runs=[{...RUN_FORMAT,ligatures:'standardContextual',text:'ffi'+' '.repeat(2000)}];
  const requests=[];
  const layout=layoutDocument([p],(text,style)=>{
    if(style.caretOffsets)requests.push({text,offsets:style.caretOffsets});
    return {width:text.length*4,ascent:12,descent:3,...(style.caretOffsets?{caretAdvances:style.caretOffsets.map(i=>i*4)}:{})};
  });
  expect(requests).toEqual([{text:'ffi ',offsets:[0,1,2,3,4]}]);
  expect(layout.lines.flatMap(l=>l.fragments.map(f=>f.text)).join('')).toBe(p.runs[0].text);
  expect(layout.lines[0].stops.at(-1).offset).toBe(p.runs[0].text.length);
});

it('does not apply an LTR override to unmarked strong RTL text',()=>{
  const p=paragraph('');p.runs=[{...RUN_FORMAT,ligatures:'standard',text:'אבג'}];
  const requests=[];
  layoutDocument([p],(text,style)=>{if(style.caretOffsets)requests.push(style.bidiDirection);return {width:text.length*4,ascent:12,descent:3};});
  // Its carets are shaped right to left, as an RTL fragment, never as left-to-right text.
  expect(requests).toEqual(['rtl']);
});

it('keeps cached prefix metrics separate by font style and refreshes them for a new layout',()=>{
  const paragraphs=[[12,false],[18,false],[12,true]].map(([fontSize,bold])=>{
    const p=paragraph('');p.runs=[{...RUN_FORMAT,ligatures:'standard',fontSize,bold,text:'ffi'}];return p;
  });
  let scale=1;const prefixes=[];
  const measure=(text,style)=>{
    const advance=style.fontSize*(style.bold?2:1)*scale;
    if(text==='ffi'&&!style.caretOffsets)prefixes.push([style.fontSize,style.bold]);
    return {width:text.length*advance,ascent:12,descent:3,...(style.caretOffsets?{caretAdvances:style.caretOffsets.map(i=>i*advance)}:{})};
  };
  const first=layoutDocument(paragraphs,measure);
  expect(first.lines.map(l=>l.fragments[0].width)).toEqual([36,54,72]);
  expect(prefixes).toEqual([[12,false],[18,false],[12,true]]);
  scale=2;const second=layoutDocument(paragraphs,measure);
  expect(second.lines.map(l=>l.fragments[0].width)).toEqual([72,108,144]);
});
