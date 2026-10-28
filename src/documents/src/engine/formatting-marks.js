import { enterCellText } from './canvas-cell-text.js';
import { revisionView } from './revisions.js';

/**
 * Show/Hide ¶: the nonprinting marks a word processor draws over laid-out text. Marks are computed from
 * each line's caret stops, so they follow the text exactly, and are painted on screen only: they never
 * reach print, export or the document.
 */
export const MARK_COLOR = '#4A78B0';

const BREAK_LABELS = { page: 'Page Break', column: 'Column Break' };
const SECTION_LABELS = { nextPage: 'Section Break (Next Page)', continuous: 'Section Break (Continuous)', evenPage: 'Section Break (Even Page)', oddPage: 'Section Break (Odd Page)', nextColumn: 'Section Break (Next Column)' };

/**
 * The label of each section break, by the id of the paragraph that ends the section, as paragraphRoles
 * gives it: a break shows how the following section starts.
 */
export function sectionBreakLabels(paragraphs, pageSettings) {
  const labels = new Map();
  let following = pageSettings;
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const end = paragraphs[i].sectionEnd;
    if (!end) continue;
    labels.set(paragraphs[i].id, SECTION_LABELS[following?.sectionType] || SECTION_LABELS.nextPage);
    following = end;
  }
  return labels;
}

/** The paragraphs ending a table cell show the end-of-cell mark instead of a pilcrow. */
function paragraphRoles(paragraphs, pageSettings) {
  const roles = new Map();
  paragraphs.forEach((p, i) => {
    const next = paragraphs[i + 1];
    let section = null;
    if (p.sectionEnd) {
      // A break shows how the following section starts.
      const following = paragraphs.slice(i + 1).find(q => q.sectionEnd)?.sectionEnd || pageSettings;
      section = SECTION_LABELS[following?.sectionType] || SECTION_LABELS.nextPage;
    }
    roles.set(p.id, { cellEnd: !!p.cellId && next?.cellId !== p.cellId, section });
  });
  return roles;
}

/**
 * The marks for one page's lines: [{ kind, x, y, width?, size, text? }]. `y` is the baseline. Lines carry
 * their caret stops; offsets index `text`, the story's paragraphs joined by '\n'.
 */
/** Hidden entry fields (XE, TA, TC) by paragraph: [{ offset, label }] with document offsets. */
function entryFields(paragraphs) {
  const entries = new Map(); let at = 0;
  for (const p of paragraphs) {
    for (const marker of p.fieldMarkers || []) {
      if (marker.type !== 'start' || !ENTRY_CODES.has(marker.field.type)) continue;
      const instruction = marker.field.instruction.trim();
      const label = `{${instruction.length > 40 ? `${instruction.slice(0, 38)}…` : instruction}}`;
      if (!entries.has(p.id)) entries.set(p.id, []);
      entries.get(p.id).push({ offset: at + marker.offset, label });
    }
    at += p.runs.reduce((n, r) => n + r.text.length, 0) + 1;
  }
  return entries;
}
const ENTRY_CODES = new Set(['XE', 'TA', 'TC']);

export function formattingMarks(lines, text, paragraphs, pageSettings, page) {
  const roles = paragraphRoles(paragraphs, pageSettings), marks = [];
  // Index, authority and contents entries are hidden text: shown as their field code while marks are on.
  const entries = paragraphs.some(p => p.fieldMarkers?.length) ? entryFields(paragraphs) : null;
  for (const line of lines) {
    if (line.virtual) continue;
    const local = line.cellText?.line || line;
    const stops = new Map((local.stops || []).map(stop => [stop.offset, stop.x]));
    const size = Math.max(6, (local.ascent || 12) * 1.05), baseline = local.baseline;
    const xAt = offset => stops.get(offset);
    for (let offset = local.start; offset < local.end; offset++) {
      const ch = text[offset], x = xAt(offset), next = xAt(offset + 1);
      if (x === undefined || next === undefined) continue;
      if (ch === ' ' || ch === '　') marks.push({ kind: 'space', x: (x + next) / 2, y: baseline, size, cell: line });
      else if (ch === ' ') marks.push({ kind: 'nbsp', x: (x + next) / 2, y: baseline, size, cell: line });
      else if (ch === '\t') marks.push({ kind: 'tab', x, width: next - x, y: baseline, size, cell: line });
      // An optional hyphen shows as ¬ where it does not break the line; where it does, its hyphen is drawn.
      else if (ch === '\u00ad' && !(offset === local.end - 1 && !local.paragraphEnd && !local.hardBreak)) marks.push({ kind: 'optionalHyphen', x, y: baseline, size, cell: line });
    }
    for (const entry of entries?.get(line.paragraphId) || []) {
      if (entry.offset < local.start || entry.offset > local.end || (entry.offset === local.end && !local.paragraphEnd)) continue;
      const x = xAt(entry.offset);
      if (x !== undefined) marks.push({ kind: 'fieldCode', x, y: baseline, size, text: entry.label, cell: line });
    }
    const endX = xAt(local.end) ?? (local.stops?.at(-1)?.x ?? 0);
    const right = Math.max(endX + 40, page.width - page.right);
    if (local.hardBreak === 'line') marks.push({ kind: 'lineBreak', x: endX, y: baseline, size, cell: line });
    else if (BREAK_LABELS[local.hardBreak]) marks.push({ kind: 'break', x: endX, width: right - endX, y: baseline, size, text: BREAK_LABELS[local.hardBreak], cell: line });
    if (local.paragraphEnd) {
      const role = roles.get(line.paragraphId) || {};
      if (role.section) marks.push({ kind: 'section', x: endX, width: right - endX, y: baseline, size, text: role.section, cell: line });
      else marks.push({ kind: role.cellEnd ? 'cell' : 'paragraph', x: endX, y: baseline, size, cell: line });
    }
  }
  return marks;
}

/**
 * Only the page, column and section break marks of formattingMarks, as it gives them (Draft view labels
 * its breaks with these): without the marks of every space and line end, they take a fraction of the
 * time. `sections` is sectionBreakLabels of the story's paragraphs.
 */
export function breakMarks(lines, page, sections) {
  const marks = [];
  for (const line of lines) {
    if (line.virtual) continue;
    const local = line.cellText?.line || line;
    const label = BREAK_LABELS[local.hardBreak], section = local.paragraphEnd ? sections.get(line.paragraphId) : undefined;
    if (!label && !section) continue;
    const size = Math.max(6, (local.ascent || 12) * 1.05), baseline = local.baseline, stops = local.stops || [];
    // The x of the line's last caret stop at its end, as formattingMarks reads it.
    let at = stops.length - 1;
    while (at >= 0 && stops[at].offset !== local.end) at--;
    const endX = (at >= 0 ? stops[at].x : undefined) ?? (local.stops?.at(-1)?.x ?? 0);
    const right = Math.max(endX + 40, page.width - page.right);
    if (label) marks.push({ kind: 'break', x: endX, width: right - endX, y: baseline, size, text: label, cell: line });
    if (section) marks.push({ kind: 'section', x: endX, width: right - endX, y: baseline, size, text: section, cell: line });
  }
  return marks;
}

function dottedRule(ctx, x, y, width, label, size) {
  ctx.save();
  ctx.font = `${Math.round(size * 0.62)}px system-ui, sans-serif`;
  const textWidth = ctx.measureText(label).width + 8, middle = x + width / 2;
  const gapStart = middle - textWidth / 2, gapEnd = middle + textWidth / 2;
  const dash = (from, to, dy) => { for (let at = from; at < to; at += 3) ctx.fillRect(at, y + dy, 1, 1); };
  const double = label.startsWith('Section');
  const lineY = -size * 0.3;
  for (const dy of double ? [lineY - 1.5, lineY + 1.5] : [lineY]) {
    if (textWidth < width - 8) { dash(x + 2, gapStart, dy); dash(gapEnd, x + width, dy); }
    else dash(x + 2, x + width, dy);
  }
  if (textWidth < width - 8) { ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(label, middle, y + lineY); }
  ctx.restore();
}

export function paintFormattingMarks(ctx, marks, geometry) {
  ctx.save();
  ctx.fillStyle = MARK_COLOR; ctx.strokeStyle = MARK_COLOR; ctx.textBaseline = 'alphabetic';
  for (const mark of marks) {
    ctx.save();
    if (mark.cell.cellText) enterCellText(ctx, mark.cell, geometry);
    const { x, y, size } = mark;
    if (mark.kind === 'space') ctx.fillRect(x - size * 0.06, y - size * 0.36, Math.max(1, size * 0.12), Math.max(1, size * 0.12));
    else if (mark.kind === 'nbsp') { ctx.font = `${size * 0.7}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.fillText('°', x, y - size * 0.05); }
    // The hyphen has no width of its own and the text is not reflowed around it: the mark is drawn
    // small and raised between its letters, over a hairline at their join, so it stays legible.
    else if (mark.kind === 'optionalHyphen') {
      ctx.fillRect(x - 0.25, y - size * 0.62, 0.5, size * 0.62);
      ctx.font = `bold ${size * 0.55}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.fillText('¬', x, y - size * 0.72);
    }
    else if (mark.kind === 'tab') {
      // An arrow centered in the tab's gap, as long as fits.
      const length = Math.min(mark.width - 2, size * 0.75), left = x + (mark.width - length) / 2, mid = y - size * 0.32, head = Math.min(size * 0.22, length / 2);
      if (length > 2) {
        ctx.lineWidth = Math.max(0.75, size * 0.06);
        ctx.beginPath(); ctx.moveTo(left, mid); ctx.lineTo(left + length, mid);
        ctx.moveTo(left + length - head, mid - head * 0.8); ctx.lineTo(left + length, mid); ctx.lineTo(left + length - head, mid + head * 0.8); ctx.stroke();
      }
    } else if (mark.kind === 'paragraph') { ctx.font = `${size}px system-ui, sans-serif`; ctx.textAlign = 'left'; ctx.fillText('¶', x + 1, y); }
    else if (mark.kind === 'cell') { ctx.font = `${size}px system-ui, sans-serif`; ctx.textAlign = 'left'; ctx.fillText('¤', x + 1, y); }
    else if (mark.kind === 'lineBreak') { ctx.font = `${size}px system-ui, sans-serif`; ctx.textAlign = 'left'; ctx.fillText('↵', x + 1, y); }
    else if (mark.kind === 'break' || mark.kind === 'section') dottedRule(ctx, x, y, mark.width, mark.text, size);
    else if (mark.kind === 'fieldCode') {
      // A hidden entry's code, drawn small above the line with a dotted underline, as hidden text appears.
      ctx.font = `${Math.max(7, Math.round(size * 0.55))}px system-ui, sans-serif`; ctx.textAlign = 'left';
      const top = y - size * 0.92, width = ctx.measureText(mark.text).width;
      ctx.globalAlpha = 0.9; ctx.fillText(mark.text, x, top);
      for (let at = x; at < x + width; at += 2.5) ctx.fillRect(at, top + 1.5, 1, 0.75);
    }
    ctx.restore();
  }
  ctx.restore();
}

/** Toggle the marks over an editor's body text. Returns whether they are now shown. */
export function setFormattingMarks(editor, visible) {
  const current = editor.overlays.find(overlay => overlay.formattingMarks);
  if (!!current === visible) return visible;
  if (current) editor.overlays.splice(editor.overlays.indexOf(current), 1);
  else {
    let cache = null;
    const overlay = (ctx, index, geometry) => {
      const layout = editor.layout, body = editor.session.body;
      if (cache?.layout !== layout) cache = { layout, pages: new Map() };
      if (!cache.pages.has(index)) {
        const lines = layout.lines.filter(line => line.page === index && !line.pageStory);
        cache.pages.set(index, formattingMarks(lines, body.text, body.paragraphs, body.pageSettings, geometry));
      }
      paintFormattingMarks(ctx, cache.pages.get(index), geometry);
    };
    overlay.formattingMarks = true;
    editor.overlays.push(overlay);
  }
  // Hidden text (w:vanish) is laid out while the marks are shown, as desktop word processors display it.
  const hiddenChanged = revisionView.showHidden !== visible;
  revisionView.showHidden = visible;
  if (hiddenChanged && hasHiddenText(editor)) editor.relayout(); else editor.paint();
  return visible;
}
const hasHiddenText = editor => [editor.session?.body, ...Object.values(editor.pageStories?.stories || {})].some(story => story?.paragraphs?.some(p => p.runs.some(r => r.vanish)));
export const formattingMarksVisible = editor => !!editor?.overlays.some(overlay => overlay.formattingMarks);
