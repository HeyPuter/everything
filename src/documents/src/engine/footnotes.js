// Original footnote and endnote model (ECMA-376 Part 1 §17.11). A body
// reference is one object character carrying `noteMark = { kind:
// 'footnoteReference' | 'endnoteReference', id }`; each note is a story keyed
// `<part>#<id>` whose own number is a footnoteRef/endnoteRef mark. Numbers are
// derived from reference order and the note settings, never stored as text.
import { formatPageNumber } from './page-numbering.js';
import { OBJECT } from './images.js';

/** The two note kinds and their mark, part and element names. */
export const NOTE_KINDS = {
  footnote: { reference: 'footnoteReference', own: 'footnoteRef', element: 'footnote', part: 'footnotes', label: 'Footnote', defaultFormat: 'decimal' },
  endnote: { reference: 'endnoteReference', own: 'endnoteRef', element: 'endnote', part: 'endnotes', label: 'Endnote', defaultFormat: 'lowerRoman' },
};
const referenceKinds = new Map(Object.entries(NOTE_KINDS).map(([kind, k]) => [k.reference, kind]));
/** 'footnote' or 'endnote' for a body reference run, else null. */
export const noteKindOf = run => referenceKinds.get(run?.noteMark?.kind) ?? null;
export const isFootnoteReference = run => run?.noteMark?.kind === 'footnoteReference';
export const isNoteReference = run => referenceKinds.has(run?.noteMark?.kind);
export const footnoteStoryPath = (part, id) => `${part}#${id}`;
export const footnoteStoryId = path => /#(-?\d+)$/.exec(path || '')?.[1] ?? null;
/** Whether a page-story kind is a note (edited in place in its page area). */
export const isNoteStoryKind = kind => kind === 'footnote' || kind === 'endnote';

/** Body references of `kind` in document order: [{ id, position, paragraphId, section, custom }]. */
export function noteReferences(paragraphs, kind = 'footnote') {
  const name = NOTE_KINDS[kind].reference, refs = []; let at = 0, section = 0;
  for (const p of paragraphs) {
    let offset = at;
    for (const run of p.runs) {
      if (run.noteMark?.kind === name) refs.push({ id: run.noteMark.id, position: offset, paragraphId: p.id, section, custom: !!run.noteMark.custom });
      offset += run.text.length;
    }
    at = offset + 1;
    if (p.sectionEnd) section++;
  }
  return refs;
}

/** Body footnote references in document order: [{ id, position, paragraphId }]. */
export function footnoteReferences(paragraphs) { return noteReferences(paragraphs, 'footnote'); }

/**
 * Displayed number for each referenced note id. `restart` is continuous, eachSect or eachPage (the latter
 * needs `pages`: Map(id -> page)). Custom-marked notes show no number and take none.
 */
export function noteNumbers(paragraphs, { format = 'decimal', start = 1, restart = 'continuous' } = {}, kind = 'footnote', pages = null) {
  const numbers = new Map(); let n = start, group = null;
  for (const ref of noteReferences(paragraphs, kind)) {
    if (numbers.has(ref.id)) continue;
    if (ref.custom) { numbers.set(ref.id, ''); continue; }
    const key = restart === 'eachSect' ? ref.section : restart === 'eachPage' && pages ? pages.get(ref.id) ?? group : null;
    if (key !== group) { if (group !== null || key !== null) n = start; group = key; }
    numbers.set(ref.id, formatPageNumber(n++, format));
  }
  return numbers;
}

/** Displayed number for each referenced footnote id, in reference order. */
export function footnoteNumbers(paragraphs, settings = {}) { return noteNumbers(paragraphs, settings, 'footnote'); }

/**
 * Copies of paragraphs whose note marks show `numbers` (body references) or `own` (a note's own mark).
 * `numbers` is a Map for footnotes, or { footnote: Map, endnote: Map }.
 */
export function numberedParagraphs(paragraphs, numbers, own = null) {
  const lookup = numbers instanceof Map ? { footnote: numbers, endnote: new Map() } : { footnote: numbers?.footnote || new Map(), endnote: numbers?.endnote || new Map() };
  return paragraphs.map(p => p.runs.some(r => r.noteMark?.display !== undefined) ? { ...p, runs: p.runs.map(r => {
    if (r.noteMark?.display === undefined) return r;
    const kind = noteKindOf(r);
    const display = kind ? lookup[kind].get(r.noteMark.id) : own;
    return { ...r, noteMark: { ...r.noteMark, display: display ?? '?' } };
  }) } : p);
}

/** A new body reference run, formatted from `base` (the typing run), as superscript. */
export function footnoteReferenceRun(base, id, kind = 'footnote') {
  const run = { ...base, text: OBJECT, noteMark: { kind: NOTE_KINDS[kind].reference, id, text: OBJECT, display: '' }, verticalAlign: 'superscript', overrides: { ...base.overrides, verticalAlign: 'superscript' } };
  delete run.revision; delete run.link;
  return run;
}

/** The runs a new note starts with: its own number mark (superscript) and a space, both from `base`. */
export function footnoteOpeningRuns(base, referenceStyle = null, kind = 'footnote') {
  const mark = { ...base, text: OBJECT, noteMark: { kind: NOTE_KINDS[kind].own, text: OBJECT, display: '' }, verticalAlign: 'superscript', overrides: { ...base.overrides, verticalAlign: 'superscript' } };
  if (referenceStyle) { mark.styleId = referenceStyle; mark.styleChanged = true; }
  delete mark.revision; delete mark.link;
  const space = { ...base, text: ' ' };
  delete space.revision; delete space.link;
  return [mark, space];
}

/** A note story's paragraphs converted to the other kind: its own marks change kind. */
export function convertedNoteParagraphs(paragraphs, to) {
  const own = NOTE_KINDS[to].own, from = NOTE_KINDS[to === 'footnote' ? 'endnote' : 'footnote'].own;
  return paragraphs.map(p => ({ ...structuredClone(p), runs: p.runs.map(r => r.noteMark?.kind === from && r.noteMark.display !== undefined ? { ...structuredClone(r), noteMark: { ...r.noteMark, kind: own } } : structuredClone(r)) }));
}
