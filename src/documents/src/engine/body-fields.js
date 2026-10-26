import { inlineSegments } from './images.js';
import { fieldInstructionTokens } from './docx-page-fields.js';
const length = p => p.runs.reduce((n, r) => n + r.text.length, 0);
/** Fields without a visible result: index (XE), authority (TA) and contents (TC) entries. */
export const ENTRY_FIELDS = new Set(['XE', 'TA', 'TC']);
// An empty entry stays before text typed at its position instead of growing a result.
const emptyEntry = r => ENTRY_FIELDS.has(r.field.type) && r.start === r.end;

// Field boundaries are zero-width document markers, not metadata on result
// runs. Empty results and results spanning paragraph marks retain both ends.
export function bodyFieldRanges(paragraphs) {
  const ranges = [], ids = new Set(), stack = []; let at = 0;
  for (const p of paragraphs) {
    const size = length(p);
    const text=p.fieldMarkers?.length?p.runs.map(r=>r.text).join(''):null;
    const boundaries=text===null?null:new Set([...inlineSegments(text)].map(s=>s.index).concat(size));
    for (const marker of [...(p.fieldMarkers || [])].sort((a,b) => a.offset-b.offset || (a.order??0)-(b.order??0))) {
      if (!Number.isInteger(marker.offset) || marker.offset < 0 || marker.offset > size) throw new Error('Invalid body field position.');
      if(!boundaries.has(marker.offset))throw new Error('Body field boundaries inside grapheme clusters are not supported.');
      if (marker.type === 'start') {
        if (ids.has(marker.field.id)) throw new Error('Duplicated body fields are not supported.');
        ids.add(marker.field.id);
        const active = { field: marker.field, start: at+marker.offset, cellId: p.cellId, startParagraph: p.id, startOrder:marker.order };
        if(marker.contentControlId)active.contentControlId=marker.contentControlId;
        if(marker.link)active.startLink=marker.link;
        if(stack.length)active.parentId=stack.at(-1).field.id;
        stack.push(active); ranges.push(active);
      } else {
        const active=stack.at(-1);
        if (!active || marker.field.id !== active.field.id || marker.type !== 'end') throw new Error('Unmatched body field boundary.');
        if (active.cellId !== p.cellId) throw new Error('Body fields crossing table cells are not supported.');
        if(active.contentControlId!==marker.contentControlId)throw new Error('Body fields crossing inline content controls are not supported.');
        if(active.field.type==='XE'&&active.start!==at+marker.offset)throw new Error('An index entry cannot contain visible result text.');
        Object.assign(active,{ end: at+marker.offset, endParagraph: p.id, endOrder:marker.order }); stack.pop();
        if(active.field.type==='MACROBUTTON' && (active.startParagraph!==p.id || text.slice(active.start-at,marker.offset)!==active.field.instruction.slice(active.field.labelStart)))throw new Error('A MACROBUTTON must retain its complete instruction label in one paragraph.');
        if(marker.link)active.endLink=marker.link;
      }
    }
    // Complex field results can span section breaks (for example, a cached
    // multi-column INDEX). Section properties belong to paragraphs and survive
    // independently of these zero-width field markers. Cell ownership remains
    // bounded because whole-cell mutations remove their owned paragraphs.
    if (stack.some(active=>active.cellId !== p.cellId)) throw new Error('Body fields crossing table cells are not supported.');
    at += size+1;
  }
  if (stack.length) throw new Error('An unterminated body field cannot be edited.');
  return ranges;
}

// A hidden sequence field (SEQ … \h, a chapter's numbering reset) never shows a result: text typed where it
// stands is the reader's own, and taking it as the field's result let Update Fields delete it.
const hiddenResult = r => /^\s*SEQ\b/i.test(r.field.instruction || '') && /\\h\b/i.test(r.field.instruction || '');

export function replacedBodyFields(ranges, start, end, inserted, discardContained = false) {
  const delta = inserted-(end-start), result = [];
  // Refilling an empty nested result also grows its enclosing results, even
  // when they share its start/end position. Order distinguishes adjacent fields.
  const growing = new Set();
  // Ranges are in opening order. Walk children before parents without scanning
  // every field against every empty result on each keystroke. Of empty results
  // side by side, the last is filled; growing two siblings made them cross.
  if(start===end)for(let i=ranges.length-1;i>=0;i--){
    const r=ranges[i];
    if(!emptyEntry(r)&&!hiddenResult(r)&&(r.start===start&&r.end===start&&!growing.size||growing.has(r.field.id))){
      growing.add(r.field.id);if(r.parentId)growing.add(r.parentId);
    }
  }
  for (const r of ranges) {
    if (start === end) {
      if((emptyEntry(r)||hiddenResult(r)&&r.start===r.end||r.end===start&&!growing.has(r.field.id))&&r.start===start)result.push(r);
      else if (growing.has(r.field.id)) result.push({ ...r, end: r.end+inserted });
      else if (start <= r.start) result.push({ ...r, start:r.start+inserted, end:r.end+inserted });
      else result.push(start < r.end ? { ...r, end:r.end+inserted } : r);
    } else if (end <= r.start) result.push({ ...r, start:r.start+delta, end:r.end+delta });
    else if (start >= r.end) result.push(r);
    else if (start <= r.start && end >= r.end && (r.field.type==='MACROBUTTON' || discardContained || start < r.start || end > r.end)) continue;
    else if (r.start <= start && end <= r.end) result.push({ ...r, end:r.end+delta });
    else throw new Error('Editing across part of a body field boundary is not supported yet.');
  }
  return inTextOrder(ranges, result);
}

// Markers at one position are ordered by their `order`, which follows the order fields were inserted in,
// not their order in the text. Field boundaries an edit brings together (deleting the text between two
// fields) keep the order they had in the text: the order values they hold are handed out again in it.
function inTextOrder(before, after) {
  const old = new Map(before.map(r => [r.field.id, r])), atPosition = new Map();
  for (const [index, r] of after.entries()) for (const key of ['start', 'end']) {
    const was = old.get(r.field.id), marker = { index, key: key + 'Order', order: r[key + 'Order'] ?? 0, was: [was[key], was[key + 'Order'] ?? 0] };
    if (!atPosition.has(r[key])) atPosition.set(r[key], []);
    atPosition.get(r[key]).push(marker);
  }
  for (const group of atPosition.values()) {
    if (group.length < 2) continue;
    const orders = group.map(m => m.order).sort((a, b) => a - b);
    group.sort((a, b) => a.was[0] - b.was[0] || a.was[1] - b.was[1]).forEach((m, i) => {
      if (m.order !== orders[i]) after[m.index] = { ...after[m.index], [m.key]: orders[i] };
    });
  }
  return after;
}

export function macroButtonSelection(ranges, start, end) {
  for(const r of ranges)if(r.field.type==='MACROBUTTON' && (start===end ? r.start<start&&start<r.end : start<r.end&&end>r.start)){
    start=Math.min(start,r.start);end=Math.max(end,r.end);
  }
  return [start,end];
}

export function placeBodyFields(paragraphs, ranges) {
  const output = paragraphs.map(p => { const copy = { ...p }; delete copy.fieldMarkers; return copy; });
  const events = ranges.flatMap(r => [{ position:r.start, type:'start', field:r.field, order:r.startOrder, link:r.startLink, contentControlId:r.contentControlId }, { position:r.end, type:'end', field:r.field, order:r.endOrder, link:r.endLink, contentControlId:r.contentControlId }]).sort((a,b)=>a.position-b.position || (a.order??0)-(b.order??0));
  let index = 0, at = 0;
  for (const event of events) {
    while (index < output.length-1 && event.position > at+length(output[index])) at += length(output[index++])+1;
    if (event.position > at+length(output[index])) throw new Error('Body field position exceeds document contents.');
    (output[index].fieldMarkers ||= []).push({ type:event.type, field:event.field, offset:event.position-at, order:event.order, ...(event.link?{link:event.link}:{}), ...(event.contentControlId?{contentControlId:event.contentControlId}:{}) });
  }
  bodyFieldRanges(output);
  return output;
}

/**
 * The order of a new field's end marker at `offset` in paragraph p, after its result was inserted: before
 * the field markers already there. Those were at the insertion point and moved past the new result (the
 * start of a field the new one was inserted before), or end an empty field the result filled.
 */
export const newFieldEndOrder = (p, offset, order) => Math.min(order, ...(p.fieldMarkers || []).filter(m => m.offset === offset).map(m => (m.order ?? 0) - 1));
/**
 * The order of a new field's start marker at `offset` in paragraph p: after the field markers already there, which
 * end the fields just before it. Ordered before them, the new field began inside the field before it.
 */
export const newFieldStartOrder = (p, offset, order) => Math.max(order, ...(p.fieldMarkers || []).filter(m => m.offset === offset).map(m => (m.order ?? 0) + 1));

// Whole-cell/row deletion removes its field markers with the owned paragraphs.
// New blank cells must never inherit those markers from a formatting template.

// A cross-reference (REF, NOTEREF) names its bookmark as its first argument: [start, end] in the instruction.
function referenceArgument(field){
  if(field.bookmarkCodeRange||!/^\s*(?:REF|NOTEREF)\s/i.test(field.instruction||''))return null;
  let args;try{args=fieldInstructionTokens(field.instruction,true);}catch{return null;}
  return args[1]&&!args[1].value.startsWith('\\')?{bookmark:args[1].value,range:[args[1].start,args[1].end]}:null;
}

export function renameBodyFieldBookmarks(paragraphs,oldName,newName){
  const seen=new Set();
  for(const p of paragraphs)for(const marker of p.fieldMarkers||[]){
    if(marker.link?.anchor===oldName)marker.link={...marker.link,anchor:newName};
    const field=marker.field;if(seen.has(field))continue;seen.add(field);
    // Cross-references follow the bookmark too: left with the old name, the next update showed
    // "Error! Reference source not found."
    const reference=referenceArgument(field);
    if(reference){
      if(reference.bookmark!==oldName)continue;
      const [start,end]=reference.range,replacement=field.instruction[start]==='"'?`"${newName}"`:newName;
      field.originalInstruction??=field.instruction;
      field.instruction=field.instruction.slice(0,start)+replacement+field.instruction.slice(end);
      continue;
    }
    if(field.bookmark!==oldName||!field.bookmarkCodeRange)continue;
    const [start,end]=field.bookmarkCodeRange,quoted=field.instruction[start]==='"',replacement=quoted?`"${newName}"`:newName;
    field.originalInstruction??=field.instruction;
    field.instruction=field.instruction.slice(0,start)+replacement+field.instruction.slice(end);
    field.bookmarkCodeRange=[start,start+replacement.length];field.bookmark=newName;
    if(field.hyperlink)field.hyperlink={...field.hyperlink,anchor:newName};
    if(field.resultLink)field.resultLink={...field.resultLink,anchor:newName};
  }
}
