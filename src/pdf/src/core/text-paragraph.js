import { groupTextRuns } from './text-group.js';
import { paragraphVector } from './paragraph-data.js';
import { hasRightToLeft } from './bidi.js';

const parts = (line) => line.parts || [line];
// A line that starts a list item: a bullet symbol (Word's symbol-font bullets included), a dash
// or star, or a number, letter, or roman numeral with "." or ")", or in brackets. A bullet may
// stand alone, its item text kept apart beyond a tab.
const LIST_ITEM =
  /^\s*(?:[•·◦▪▫■□●○‣⁃∙➢➤►▶✓✔❖♦◆◇\uf0a7\uf0b7\uf0d8\uf0fc](?:\s*\S|\s*$)|[-–—*]\s|\(?(?:\d+|[a-zA-Z]|[ivxlcIVXLC]{1,6})[.)]\s)/u;
const pathKey = (run) => run.path.map((call) => call.start).join(':');
const height = (line) => Math.hypot(line.transform[2], line.transform[3]);
const width = (line) => (line.advance / line.state.size) * height(line);

function glyphWidth(run, char) {
  const glyph = run.widths.get(char);
  return glyph
    ? ((glyph.width * run.state.size + run.state.charSpacing) / run.state.size) * height(run)
    : NaN;
}

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

/**
 * A line's glyphs at their own widths, without word spacing, kerning or the jumps between
 * words, and the width of the spaces it ends with: NaN where a glyph cannot be measured.
 */
function naturalWidth(line) {
  let total = 0,
    trailing = 0;
  for (const run of parts(line))
    for (const char of run.text) {
      const width = glyphWidth(run, char);
      total += width;
      trailing = /\s/.test(char) ? trailing + width : 0;
    }
  return { total, trailing };
}

/**
 * Whether a paragraph's lines are justified: every line but the last ends at the same right
 * edge, and at least one of them spaces its words wider than the last line does (a ragged
 * paragraph's lines rarely end together, and never by stretching their spaces).
 */
function justified(paragraph, reach) {
  const { lines } = paragraph.paragraph,
    h = height(paragraph);
  if (lines.length < 2) return 0;
  const measured = lines.map((line) => {
    const { total, trailing } = naturalWidth(line);
    const spaces = (line.text.trim().match(/\s/g) || []).length;
    return {
      edge: reach(line) - trailing,
      stretch: spaces ? (width(line) - total) / spaces : null,
    };
  });
  const body = measured.slice(0, -1),
    last = measured.at(-1);
  const right = Math.max(...body.map((m) => m.edge));
  if (
    !Number.isFinite(right) ||
    body.some((m) => !Number.isFinite(m.edge) || right - m.edge > h * 0.04) ||
    last.edge > right + h * 0.04 ||
    (last.stretch === null && body.length < 2)
  )
    return 0;
  const base = Number.isFinite(last.stretch) ? last.stretch : 0;
  // Kerning tightens a line's spaces as often as it loosens them: only spaces wider than
  // their glyphs, and wider than the last line's, say the line was stretched.
  return body.some(
    (m) => m.stretch !== null && m.stretch > h * 0.015 && m.stretch - base > h * 0.015,
  )
    ? right
    : 0;
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
    ...(data.line
      ? {}
      : {
          paragraph: {
            lines,
            width: column,
            leading,
            stored: true,
            indent: (data.indent || 0) * column,
            ...(data.justify && { align: 'justify' }),
          },
        }),
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
    let leading, indent;
    if (
      previous &&
      !block.paragraph?.stored &&
      !line.paragraph?.stored &&
      parts(previous).every((r) => r.groupable) &&
      parts(line).every((r) => r.groupable) &&
      parts(previous).at(-1).barrier === parts(line)[0].barrier &&
      pathKey(parts(previous)[0]) === pathKey(parts(line)[0]) &&
      !LIST_ITEM.test(line.text) &&
      // A tagged PDF says which paragraph each line is in: lines of two paragraphs stay apart.
      !(
        parts(previous).at(-1).block &&
        parts(line)[0].block &&
        parts(previous).at(-1).block !== parts(line)[0].block
      ) &&
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
      // A paragraph's first line may start further in than the lines that follow it.
      const first = !block.paragraph && x <= -0.3 && x >= -6 ? -x * h : 0;
      const lead = block.paragraph ? (block.paragraph.indent / block.state.size) * h : first;
      const reach = (l) => width(l) + (l === (block.paragraph?.lines[0] ?? block) ? lead : 0);
      if (
        shared &&
        a.slice(0, 4).every((v, i) => Math.abs(v - b[i]) < h * 0.025) &&
        (Math.abs(x) < 0.3 || first) &&
        -y >= 0.95 &&
        -y <= 1.8 &&
        (!block.paragraph || Math.abs(-y - block.paragraph.leading) < 0.15) &&
        width(line) <= reach(previous) * 1.4 + h * 2 &&
        previous.text.trim().split(/\s+/).length >= 3 &&
        // A line wraps early only when the next word would not fit after it. Where that word
        // would have fit within the widest line, the break is a hard one: a paragraph ends.
        // A line ending mid-word in a hyphen wrapped because the whole word did not fit, so
        // the fragment after it says nothing about the break.
        (/\p{L}[-\u00ad\u2010]\s*$/u.test(previous.text) ||
          reach(previous) + h * 0.28 + wordWidth(line) >=
            Math.max(width(line), ...(block.paragraph?.lines ?? [block]).map(reach)) - h * 0.1)
      ) {
        leading = -y;
        indent = { first, x, reach };
      }
    }
    if (!leading) {
      blocks.push(line);
      continue;
    }
    let paragraph = block;
    if (!block.paragraph) {
      const t = block.transform;
      paragraph = {
        ...block,
        // An indented paragraph's frame starts where its other lines do.
        transform: indent.first
          ? [...t.slice(0, 4), t[4] + indent.x * t[0], t[5] + indent.x * t[1]]
          : t,
        parts: [...parts(block)],
        segments: (block.segments || [{ text: block.text, part: 0 }]).map((s) => ({ ...s })),
        paragraph: {
          lines: [block],
          leading,
          width: 0,
          upper: Infinity,
          indent: (indent.first / height(block)) * block.state.size,
        },
      };
      blocks[blocks.length - 1] = paragraph;
    }
    const data = paragraph.paragraph,
      { reach } = indent;
    data.upper = Math.min(data.upper, reach(previous) + height(previous) * 0.28 + wordWidth(line));
    const offset = paragraph.parts.length;
    const last = paragraph.segments.at(-1);
    // A word hyphenated where the line broke goes on after its hyphen, with no space inside it.
    last.text = last.text.trimEnd();
    if (!/\p{L}[-\u00ad\u2010]$/u.test(paragraph.text.trimEnd())) last.text += ' ';
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
    const widest = Math.max(...data.lines.map(reach));
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
  for (const block of blocks) {
    const data = block.paragraph;
    if (!data || data.stored) continue;
    const lead = (data.indent / block.state.size) * height(block);
    const right = justified(block, (l) => width(l) + (l === data.lines[0] ? lead : 0));
    // A justified paragraph's lines end at its column's edge, which is its exact width.
    if (right) {
      data.align = 'justify';
      data.width = block.advance = (right / height(block)) * block.state.size;
    }
  }
  return blocks;
}
