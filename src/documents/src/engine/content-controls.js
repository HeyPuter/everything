import { inlineSegments } from './images.js';
// Inline controls are metadata on ordinary runs, not characters or independent
// layout objects. Temporary wrappers expire on content edits; persistent ones
// retain their identity while their runs and placeholder state change.
export function controlSignature(runs) {
  const segments = [];
  for (const run of runs) {
    // Tracked changes count: a deletion keeps the text, so a signature without them would reuse the source XML.
    const properties = JSON.stringify([run.properties, run.directFormat, run.overrides, run.styleId, !!run.styleChanged, run.link, run.image, run.revision, run.formatRevision]);
    if (segments.at(-1)?.properties === properties) segments.at(-1).text += run.text;
    else segments.push({ properties, text: run.text });
  }
  return JSON.stringify(segments);
}

// Temporary rich-text controls are retained after formatting-only edits.
// Compare their textual/structural contents separately from their run styling.
export function controlContentSignature(runs, control) {
  const segments = [];
  for (const run of runs) {
    // Picture geometry/description changes count as formatting, retaining
    // even a temporary wrapper. Insertion changes the identity/content sequence.
    const picture = control?.picture || run.contentControl?.picture;
    const structure = JSON.stringify([run.link, picture && run.image ? [run.image.id, run.image.assetId] : run.image]);
    if (segments.at(-1)?.structure === structure) segments.at(-1).text += run.text;
    else segments.push({ structure, text: run.text });
  }
  return JSON.stringify(segments);
}

export function contentControlRanges(paragraphs) {
  const ranges = []; let at = 0;
  for (const p of paragraphs) {
    let previous, localStart = 0;
    for (const run of p.runs) {
      if (run.contentControl) {
        if (previous?.control.id === run.contentControl.id) { previous.end += run.text.length; previous.runs.push(run); }
        else { previous = { control: run.contentControl, paragraph: p, start: at, end: at + run.text.length, localStart, runs: [run] }; ranges.push(previous); }
      } else previous = null;
      at += run.text.length;
      localStart += run.text.length;
    }
    at++;
  }
  return ranges;
}

export function changedContentControls(paragraphs) {
  const ranges = contentControlRanges(paragraphs), seen = new Set(), changed = new Set(), boundaries = new Map();
  for (const range of ranges) {
    const { control, paragraph, runs } = range;
    if (seen.has(control.id) || !control.persistent && control.contentSignature !== controlContentSignature(runs)) changed.add(control.id);
    seen.add(control.id);
    const { localStart } = range, localEnd = localStart + range.end - range.start;
    if (!boundaries.has(paragraph)) {
      const text = paragraph.runs.map(r => r.text).join('');
      boundaries.set(paragraph, new Set([...inlineSegments(text)].map(s => s.index).concat(text.length)));
    }
    if (!boundaries.get(paragraph).has(localStart) || !boundaries.get(paragraph).has(localEnd)) changed.add(control.id);
    if (!control.persistent && paragraph.bookmarks?.some(m => m.contentControlId !== control.id && m.offset > localStart && m.offset < localStart + range.end - range.start)) changed.add(control.id);
  }
  return changed;
}

export function unwrapChangedContentControls(paragraphs, protectPersistent = true) {
  const changed = changedContentControls(paragraphs);
  if (protectPersistent && changed.size && contentControlRanges(paragraphs).some(r => r.control.persistent && changed.has(r.control.id))) throw new Error('This edit would divide a persistent content control.');
  if (changed.size) for (const p of paragraphs) for (const run of p.runs) if (changed.has(run.contentControl?.id)) delete run.contentControl;
}

export function validatePersistentControls(paragraphs) {
  const ranges = contentControlRanges(paragraphs);
  if (!ranges.some(r => r.control.persistent)) return;
  const changed = changedContentControls(paragraphs);
  if (ranges.some(r => r.control.persistent && changed.has(r.control.id))) throw new Error('This edit would divide a persistent content control.');
}
