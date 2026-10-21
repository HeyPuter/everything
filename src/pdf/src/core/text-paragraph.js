import { groupTextRuns } from './text-group.js';
import { paragraphVector } from './paragraph-data.js';
import { hasRightToLeft } from './bidi.js';

const parts = (line) => line.parts || [line];
const pathKey = (run) => run.path.map((call) => call.start).join(':');
const height = (line) => Math.hypot(line.transform[2], line.transform[3]);
const width = (line) => (line.advance / line.state.size) * height(line);

function wordWidth(line) {
  let total = 0;
  for (const run of parts(line)) {
    const text = run.text.match(/^\s*\S+/)?.[0] || '';
    for (const char of text) {
      const glyph = run.widths.get(char);
      if (!glyph) return height(line) * text.length * 0.6;
      total +=
        ((glyph.width * run.state.size +
          run.state.charSpacing +
          (glyph.space ? run.state.wordSpacing : 0)) /
          run.state.size) *
        height(run);
    }
    if (text.length < run.text.length) break;
  }
  return total;
}

function restoreParagraph(lines, data) {
  const runs = lines.flatMap(parts),
    first = runs[0];
  if (
    runs.some(
      (r) =>
        !(r.groupable || (data.line && r.editable && !r.state.customColor)) ||
        r.paragraphData !== data ||
        r.barrier !== first.barrier,
    ) ||
    data.items.filter((n) => [0, 1, 2].includes(n)).length !== runs.length
  )
    return null;
  const vector = (start) => paragraphVector(first.state.ctm, data.frame.slice(start, start + 2));
  const origin = vector(0),
    across = vector(2),
    down = vector(4);
  const project = (v, axis) => {
    const basis = first.transform.slice(axis, axis + 2),
      square = basis[0] ** 2 + basis[1] ** 2;
    const amount = (v[0] * basis[0] + v[1] * basis[1]) / square;
    return amount > 0 &&
      Math.hypot(v[0] - amount * basis[0], v[1] - amount * basis[1]) < Math.hypot(...v) * 1e-5
      ? amount
      : NaN;
  };
  const column = project(across, 0) * first.state.size,
    leading = project(down, 2);
  const transform = first.transform.map((n, i) => (i < 4 ? n : n + origin[i - 4]));
  const det = transform[0] * transform[3] - transform[1] * transform[2];
  if (!Number.isFinite(column) || !Number.isFinite(leading) || !det) return null;
  const segments = [];
  const add = (text, part, gap) => {
    const last = segments.at(-1);
    if (last && last.part === part && !last.gap && !gap) last.text += text;
    else segments.push({ text, part, ...(gap ? { gap } : {}) });
  };
  let index = 0;
  for (const item of data.items) {
    if ([0, 1, 2].includes(item)) {
      if (item !== 1 && runs[index].text) return null;
      if (item !== 2) add(item === 0 ? '\n' : runs[index].text, index);
      index++;
    } else if (item === -1) add('\n', Math.max(0, index - 1));
    else if (Array.isArray(item))
      add(' ', Math.max(0, index - 1), paragraphVector(first.state.ctm, item));
  }
  const text = segments.map((s) => s.text).join('');
  if (text.length > 5000) return null;
  const paragraph = {
    ...first,
    parts: runs,
    segments,
    text,
    transform,
    advance: column,
    ...(data.line ? {} : { paragraph: { lines, width: column, leading, stored: true } }),
  };
  for (const run of runs) {
    const dx = run.transform[4] - transform[4],
      dy = run.transform[5] - transform[5];
    const y = (transform[0] * dy - transform[1] * dx) / det,
      ratio = height(run) / height(paragraph);
    paragraph.ascent = Math.max(paragraph.ascent, y + run.ascent * ratio);
    paragraph.descent = Math.min(paragraph.descent, y + run.descent * ratio);
  }
  return paragraph;
}

function savedParagraphs(lines) {
  const output = [];
  for (let i = 0; i < lines.length;) {
    const data = parts(lines[i])[0].paragraphData;
    if (!data) {
      output.push(lines[i++]);
      continue;
    }
    const start = i++;
    while (i < lines.length && parts(lines[i])[0].paragraphData === data) i++;
    const batch = lines.slice(start, i),
      paragraph = restoreParagraph(batch, data);
    if (paragraph) output.push(paragraph);
    else output.push(...groupTextRuns(batch.flatMap(parts).filter((r) => r.text)));
  }
  return output;
}

/** Combine compatible, consecutive lines while retaining every original source occurrence. */
export function groupTextParagraphs(lines) {
  const blocks = [];
  for (const line of savedParagraphs(lines)) {
    const block = blocks.at(-1),
      previous = block?.paragraph?.lines.at(-1) || block;
    let leading;
    if (
      previous &&
      !block.paragraph?.stored &&
      !line.paragraph?.stored &&
      parts(previous).every((r) => r.groupable) &&
      parts(line).every((r) => r.groupable) &&
      parts(previous).at(-1).barrier === parts(line)[0].barrier &&
      pathKey(parts(previous)[0]) === pathKey(parts(line)[0]) &&
      !/^\s*(?:[•*\-]|\d+[.)])\s/.test(line.text) &&
      // Each line of right-to-left text is drawn in its own visual order, so the lines are
      // reordered for editing one by one and stay separate.
      !hasRightToLeft(previous.text) &&
      !hasRightToLeft(line.text) &&
      block.text.length + line.text.length + 1 < 5000
    ) {
      const a = previous.transform,
        b = line.transform,
        h = height(previous),
        det = a[0] * a[3] - a[1] * a[2];
      const dx = b[4] - a[4],
        dy = b[5] - a[5];
      const x = (a[3] * dx - a[2] * dy) / det,
        y = (a[0] * dy - a[1] * dx) / det;
      const shared = parts(previous).some((p) => parts(line).some((n) => p.fontKey === n.fontKey));
      if (
        shared &&
        a.slice(0, 4).every((v, i) => Math.abs(v - b[i]) < h * 0.025) &&
        Math.abs(x) < 0.3 &&
        -y >= 0.95 &&
        -y <= 1.8 &&
        (!block.paragraph || Math.abs(-y - block.paragraph.leading) < 0.15) &&
        width(line) <= width(previous) * 1.4 + h * 2 &&
        previous.text.trim().split(/\s+/).length >= 3
      )
        leading = -y;
    }
    if (!leading) {
      blocks.push(line);
      continue;
    }
    let paragraph = block;
    if (!block.paragraph) {
      paragraph = {
        ...block,
        parts: [...parts(block)],
        segments: (block.segments || [{ text: block.text, part: 0 }]).map((s) => ({ ...s })),
        paragraph: { lines: [block], leading, width: 0, upper: Infinity },
      };
      blocks[blocks.length - 1] = paragraph;
    }
    const data = paragraph.paragraph;
    data.upper = Math.min(data.upper, width(previous) + height(previous) * 0.28 + wordWidth(line));
    const offset = paragraph.parts.length;
    const last = paragraph.segments.at(-1);
    last.text = last.text.trimEnd() + ' ';
    // A paragraph boundary is ordinary editable whitespace, not an explicit hard line break.
    delete last.gap;
    const next = (line.segments || [{ text: line.text, part: 0 }]).map((s) => ({
      ...s,
      part: s.part + offset,
    }));
    next[0].text = next[0].text.trimStart();
    paragraph.segments.push(...next);
    paragraph.parts.push(...parts(line));
    data.lines.push(line);
    const widest = Math.max(...data.lines.map(width));
    data.width =
      ((widest + Math.max(widest, Math.min(data.upper, widest + height(line)))) /
        2 /
        height(paragraph)) *
      paragraph.state.size;
    paragraph.advance = data.width;
    paragraph.text = paragraph.segments.map((s) => s.text).join('');
    const a = paragraph.transform,
      b = line.transform,
      det = a[0] * a[3] - a[1] * a[2];
    const down = (a[0] * (b[5] - a[5]) - a[1] * (b[4] - a[4])) / det;
    paragraph.descent = Math.min(paragraph.descent, down + line.descent);
  }
  return blocks;
}
