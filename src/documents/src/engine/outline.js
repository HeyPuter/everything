// Outline entries are a projection of source paragraphs, never additional text.
// The OOXML levels 0–8 become user-facing levels 1–9; 9 is ordinary body text.
export const builtinOutlineLevel = id => /^Heading[1-9]$/.test(id || '') ? Number(id.slice(-1)) - 1 : null;

export function outlineEntries(paragraphs) {
  let start = 0;
  return paragraphs.flatMap(p => {
    const end = start + p.runs.reduce((n, r) => n + r.text.length, 0), level = p.format?.outlineLevel ?? 9;
    const entry = { id: p.id, start, end, level: level + 1,
      // A note reference, field or equation is an object character, which a heading's name does not show.
      text: p.runs.map(r => r.image ? r.image.alt || '[Image]' : r.math ? r.math.text || '' : r.text.replace(/\uFFFC/g, '')).join('').replace(/\s+/gu, ' ').trim() || '(Empty heading)' };
    // A heading in a table cell belongs to the table: it is listed, but the outline cannot move or delete it.
    if (p.cellId) entry.inTable = true;
    start = end + 1;
    return level < 9 ? [entry] : [];
  });
}
