import { bidiVisualOrder } from './bidi-text.js';

// Reorder within a tab field after its complete logical shaping. Coordinates
// here remain relative to the field; page/table/column translation is unchanged.
export function reorderBidiField(field, measure) {
  if (!field.fragments.some(g => g.bidiLevel !== undefined)) return false;
  const logical=field.fragments, originalStops=field.stops, entries=[];
  let x=0;
  for(const g of bidiVisualOrder(logical)) {
    const oldX=g.x, reverse=g.bidiDirection==='rtl';
    const shaped=reverse && !g.image && !g.textParts && g.textOffsets && measure?.(g.text,{...g,caretOffsets:g.textOffsets.map(s=>s.index)}).caretAdvances;
    const advances=shaped ? new Map(g.textOffsets.map((s,i)=>[s.offset,shaped[i]])) : null;
    const stops=originalStops.filter(s=>s.offset>=g.start && s.offset<=g.end).map(s=>{
      const advance=advances?.get(s.offset) ?? Math.max(0,Math.min(g.width,s.x-oldX));
      const side=s.offset===g.start ? (reverse?'right':'left') : s.offset===g.end ? (reverse?'left':'right') : 'both';
      return {...s,x:reverse?g.width-advance:advance,bidiSide:side,
        ...(s.offset===g.start?{affinity:'forward'}:s.offset===g.end?{affinity:'backward'}:{})};
    });
    entries.push({g,oldX,x,reverse});
    g.x=x;g.caretStops=stops;
    if(reverse && g.colors) g.colors=g.colors.map(c=>({...c,x:g.width-c.x-c.width})).sort((a,b)=>a.x-b.x);
    x+=g.width;
  }
  const moveSpans = spans => spans.flatMap(span => entries.flatMap(({g,oldX,x,reverse})=>{
    // Decorations cover logical characters, whose final contextual advances
    // can differ from every incrementally measured prefix (e.g. lam-alef).
    if (span.start !== undefined) {
      const start = Math.max(span.start, g.start), end = Math.min(span.end, g.end);
      if (end <= start) return [];
      const a = g.caretStops.find(s => s.offset === start), b = g.caretStops.find(s => s.offset === end);
      if (a && b) return [{ ...span, x: x + Math.min(a.x, b.x), width: Math.abs(b.x - a.x),
        ...(span.phase === undefined ? {} : { phase: span.phase + Math.max(0, oldX - span.x) }) }];
    }
    const left=Math.max(span.x,oldX),right=Math.min(span.x+span.width,oldX+g.width);
    if(right<=left) return [];
    return [{...span,x:x+(reverse?g.width-(right-oldX):left-oldX),width:right-left,
      ...(span.phase===undefined?{}:{phase:span.phase+left-span.x})}];
  })).sort((a,b)=>a.x-b.x);
  field.fragments=entries.map(e=>e.g);
  field.stops=entries.flatMap(({g})=>g.caretStops.map(s=>({...s,x:g.x+s.x}))).sort((a,b)=>a.offset-b.offset);
  // A tab boundary has two valid positions when its following logical text
  // starts at the right of an RTL group. Retain the tab's trailing affinity.
  // In a right-to-left paragraph the field starts at its right end.
  if(field.tab) field.stops.unshift({...originalStops[0],x:logical[0]?.bidiBase ? x : 0,affinity:'backward'});
  for(const key of ['backgrounds','underlines','strikes']) field[key]=moveSpans(field[key]);
  return true;
}
