import { PDFName, PDFNumber, StandardFontEmbedder } from 'pdf-lib';
import { assertSupportedText, embedFont, textVariant } from './document.js';
import {
  matrix,
  parseContent,
  pageSource,
  decode,
  prepareText,
  originalGlyphs,
  replaceText,
  deleteRuns,
  uniqueName,
  fallbackVariant,
} from './text-edit.js';
import { inverse, rewriteOccurrence } from './image-edit.js';
import { paragraphVector, validateParagraphLayout, writeParagraphData } from './paragraph-data.js';
import { textDecorationQuads } from './text-decoration.js';
const get = (dict, key) => dict?.lookup(PDFName.of(key));
const num = (n) => PDFNumber.of(n).toString();
const pathKey = (r) => r.path.map((p) => p.start).join(':');

/** Join nearby, compatible baselines without crossing graphic/marked-content boundaries. */
export function groupTextRuns(runs) {
  const groups = [];
  for (const run of runs) {
    if (!run.text && !(run.paragraphData && run.op === 'Tj')) continue;
    const last = groups.at(-1),
      parts = last?.parts || (last ? [last] : []),
      previous = parts.at(-1);
    let gap;
    if (
      previous?.groupable &&
      run.groupable &&
      previous.barrier === run.barrier &&
      previous.paragraphData === run.paragraphData &&
      pathKey(previous) === pathKey(run)
    ) {
      const a = previous.transform,
        b = run.transform,
        scale = Math.hypot(a[0], a[1]),
        height = Math.hypot(a[2], a[3]);
      const ratio = Math.hypot(b[2], b[3]) / height;
      const matching = a.slice(0, 4).every((n, i) => Math.abs(b[i] / ratio - n) < height * 0.005);
      const end = [
        a[4] + (a[0] * previous.advance) / previous.state.size,
        a[5] + (a[1] * previous.advance) / previous.state.size,
      ];
      const dx = b[4] - end[0],
        dy = b[5] - end[1],
        across = (dx * a[0] + dy * a[1]) / scale,
        vertical = (dy * a[0] - dx * a[1]) / scale;
      if (
        matching &&
        ratio > 0.5 &&
        ratio < 2 &&
        Math.abs(vertical) < height * 0.04 &&
        across >= -height * 0.08 &&
        across <= height * 0.65 &&
        last.text.length + run.text.length < 5000
      )
        gap = [dx, dy, across, height];
    }
    if (!gap) {
      groups.push(run);
      continue;
    }
    if (!last.parts) {
      const group = { ...last, parts: [last], segments: [{ text: last.text, part: 0 }] };
      groups[groups.length - 1] = group;
    }
    const group = groups.at(-1);
    if (gap[2] > gap[3] * 0.12 && !/\s$/.test(group.text) && !/^\s/.test(run.text))
      group.segments.push({ text: ' ', part: group.parts.length - 1, gap: [gap[0], gap[1]] });
    group.segments.push({ text: run.text, part: group.parts.length });
    group.parts.push(run);
    group.text = group.segments.map((s) => s.text).join('');
    const end = [
      run.transform[4] + (run.transform[0] * run.advance) / run.state.size,
      run.transform[5] + (run.transform[1] * run.advance) / run.state.size,
    ];
    const first = group.transform,
      base = Math.hypot(first[0], first[1]);
    group.advance =
      (((end[0] - first[4]) * first[0] + (end[1] - first[5]) * first[1]) / (base * base)) *
      group.state.size;
    group.ascent = Math.max(
      group.ascent,
      (run.ascent * Math.hypot(run.transform[2], run.transform[3])) /
        Math.hypot(first[2], first[3]),
    );
    group.descent = Math.min(
      group.descent,
      (run.descent * Math.hypot(run.transform[2], run.transform[3])) /
        Math.hypot(first[2], first[3]),
    );
  }
  return groups;
}

/**
 * Locate a run in the current page content (following its form path), or, given `range`, the
 * larger block around it that an earlier edit wrote, which is then replaced as one.
 */
function occurrence(doc, index, run, range = null) {
  let source = pageSource(doc.getPage(index)),
    resources = doc.getPage(index).node.Resources();
  const path = [];
  for (const original of run.path) {
    const c = parseContent(source, { inlineImages: true }).find((c) => c.start === original.start);
    if (c?.op !== 'Do') throw new Error('The text changed. Select it again.');
    const form = get(get(resources, 'XObject'), c.args[0].value);
    path.push({
      start: c.start,
      end: c.end,
      name: c.args[0].value,
      source: source.slice(c.start, c.end),
    });
    source = decode(form);
    resources = get(form.dict, 'Resources') || resources;
  }
  const commands = parseContent(source, { inlineImages: true });
  const command = commands.find((c) => c.start === run.start && c.end === run.end);
  if (!command || JSON.stringify(command.args) !== JSON.stringify(run.args))
    throw new Error('The text changed. Select it again.');
  if (range) {
    const opens = commands.find((c) => c.start === range.start),
      closes = commands.find((c) => c.end === range.end);
    if (opens?.op !== 'q' || !closes || range.start > run.start || run.end > range.end)
      throw new Error('The text changed. Select it again.');
    return {
      ...run,
      start: range.start,
      end: range.end,
      source: source.slice(range.start, range.end),
      path,
      resources,
    };
  }
  return { ...run, source: source.slice(run.start, run.end), path, resources };
}
function advance(run, text, size, font, encoded) {
  const factor = size / run.state.size;
  if (font) {
    text = assertSupportedText(font, text);
    const composite = !(font.embedder instanceof StandardFontEmbedder);
    const count = (encoded.length - 2) / (composite ? 4 : 2);
    // A plain Tj applies glyph widths, not the standard-font helper’s pair kerning.
    // Tw applies only to a single-byte space, never an Identity-H glyph code.
    return (
      (composite
        ? font.widthOfTextAtSize(text, size)
        : [...text].reduce(
            (width, character) => width + font.widthOfTextAtSize(character, size),
            0,
          )) +
      count * run.state.charSpacing * factor +
      (composite ? 0 : [...text].filter((c) => c === ' ').length) * run.state.wordSpacing * factor
    );
  }
  const keys = originalGlyphs(run.map, text);
  if (!keys) throw new Error('This font cannot yet be measured for line editing.');
  let total = 0;
  for (const key of keys) {
    const glyph = run.widths.get(key);
    if (!glyph) throw new Error('This font cannot yet be measured for line editing.');
    total +=
      glyph.width * size +
      run.state.charSpacing * factor +
      (glyph.space ? run.state.wordSpacing * factor : 0);
  }
  return total;
}

/** Default leading in units of the first fragment's visual font size. */
export function groupLineHeight(group, fragments) {
  const base = Math.hypot(group.transform[2], group.transform[3]);
  return (
    1.35 *
    Math.max(
      1,
      ...fragments
        .filter((fragment) => fragment.text)
        .map((fragment) => {
          const run = group.parts[fragment.part];
          return Math.hypot(run.transform[2], run.transform[3]) / base;
        }),
    )
  );
}

export async function replaceTextGroup(
  doc,
  index,
  group,
  text,
  {
    size = group.state.size,
    hex,
    offset = [0, 0],
    segments,
    lineOffsets,
    reflow = false,
    paragraph = group.paragraph && {
      width: group.paragraph.width,
      leading: group.paragraph.leading,
      softBreaks: [],
    },
    variant,
    fontStyle,
    underline = group.underline || false,
    strikethrough = group.strikethrough || false,
  } = {},
) {
  const variantFor = (run) => {
    if (variant || !fontStyle) return variant;
    const original = fallbackVariant(run);
    return textVariant(
      fontStyle.bold ?? original.startsWith('bold'),
      fontStyle.italic ?? original.toLowerCase().includes('italic'),
    );
  };
  if (!group.parts && (underline || strikethrough))
    group = { ...group, parts: [group], segments: [{ text: group.text, part: 0 }] };
  if (!group.parts)
    return replaceText(doc, index, group, text, { size, hex, offset, variant: variantFor(group) });
  const styled =
    underline ||
    strikethrough ||
    group.parts[0].paragraphData?.line ||
    group.underline ||
    group.strikethrough;
  const decorationChanged =
    underline !== Boolean(group.underline) || strikethrough !== Boolean(group.strikethrough);
  const softBreaks = validateParagraphLayout(paragraph, text);
  if (text.length - softBreaks.size > 5000 || text.length > 10000)
    throw new Error('Keep text edits under 5,000 characters.');
  if (
    !Number.isFinite(size) ||
    size <= 0 ||
    size > 10000 ||
    offset.length !== 2 ||
    !offset.every(Number.isFinite)
  )
    throw new Error('Choose a valid text size and position.');
  const factor = size / group.state.size,
    color = hex && hex !== group.fillColor ? hex : null;
  if (color && !/^#[0-9a-f]{6}$/i.test(color)) throw new Error('Choose a valid color.');
  const fragments = segments || (text === group.text ? group.segments : [{ text, part: 0 }]);
  if (fragments.map((s) => s.text).join('') !== text || fragments.some((s) => !group.parts[s.part]))
    throw new Error('The text formatting changed. Select it again.');
  if (
    lineOffsets !== undefined &&
    (!Array.isArray(lineOffsets) ||
      lineOffsets.length !== text.split('\n').length ||
      lineOffsets[0] !== 0 ||
      lineOffsets.some((n, i) => !Number.isFinite(n) || (i > 0 && n <= lineOffsets[i - 1])))
  )
    throw new Error('The line spacing changed. Select the text again.');
  const leading = paragraph?.leading ?? groupLineHeight(group, fragments);
  // Runs an earlier paragraph edit wrote sit in one q … BDC … EMC Q block; editing them again
  // replaces that block instead of nesting a new one inside it and leaving its dead commands.
  const wrapper =
    group.parts[0].wrapper?.end != null &&
    group.parts.every((part) => part.wrapper === group.parts[0].wrapper)
      ? group.parts[0].wrapper
      : null;
  const same = text === group.text && JSON.stringify(fragments) === JSON.stringify(group.segments);
  if (same && factor === 1 && !color && !reflow && !variant && !fontStyle && !decorationChanged) {
    if (offset.every((n) => Math.abs(n) < 1e-8)) return false;
    // A block an earlier edit wrote moves as one piece; loose runs move one by one.
    if (wrapper) return translateBlock();
    let changed = false;
    for (const part of [...group.parts].reverse())
      if (
        (await replaceText(doc, index, part, part.text, { offset, hex: color || undefined })) !==
        false
      )
        changed = true;
    return changed ? undefined : false;
  }
  return rewriteGroup();
  /**
   * Shift every text matrix of the saved block by the offset. Rebuilding the block from its
   * restored text would lose what the file alone knows: where its soft wraps fall and how far
   * apart lines of mixed sizes were measured to be.
   */
  function translateBlock() {
    const first = group.parts[0],
      entry = occurrence(doc, index, first, wrapper),
      trailer = wrapper.trailer || '',
      shift = paragraphVector(inverse(first.state.ctm), offset);
    let block = entry.source.slice(0, entry.source.length - trailer.length);
    for (const command of parseContent(block).reverse()) {
      if (!['Tm', 'm', 'l'].includes(command.op)) continue;
      const values = command.args.map((arg) => arg.value);
      const start = command.op === 'Tm' ? 4 : 0;
      values[start] += shift[0];
      values[start + 1] += shift[1];
      block =
        block.slice(0, command.start) +
        `${values.map(num).join(' ')} ${command.op}` +
        block.slice(command.end);
    }
    rewriteOccurrence(doc, index, entry, block + trailer);
  }
  async function rewriteGroup() {
    // Encode and measure before modifying source, so unsupported characters cannot leave a partial edit.
    // Empty text commands retain the base font and the formatting of explicit breaks.
    // They paint nothing, but let reopening reconstruct native editable style spans.
    const formatting = async (run, marker) => ({
      run,
      marker,
      size: run.state.size * factor,
      width: 0,
      encoded: ['<>'],
      font: variantFor(run) ? await embedFont(doc, variantFor(run), text) : null,
    });
    const prepared =
      paragraph && text.replaceAll('\n', '') ? [await formatting(group.parts[0], 2)] : [];
    let position = 0;
    for (const fragment of fragments) {
      const run = group.parts[fragment.part];
      for (const [i, line] of fragment.text.split('\n').entries()) {
        if (i) {
          const soft = softBreaks.has(position);
          if (paragraph && !soft) prepared.push(await formatting(run, 0));
          prepared.push({ newline: true, soft });
          position++;
        }
        position += line.length;
        if (!line) continue;
        if (fragment.gap && line === ' ') {
          prepared.push({ gap: fragment.gap.map((n) => n * factor) });
          continue;
        }
        const original = line === run.text && !variantFor(run);
        const data = original
          ? { encoded: [run.source], font: null }
          : await prepareText(doc, run, line, variantFor(run));
        prepared.push({
          run,
          text: line,
          size: run.state.size * factor,
          original,
          ...data,
          width: original
            ? run.advance * factor
            : advance(run, line, run.state.size * factor, data.font, data.encoded[0]),
        });
      }
    }
    if (!wrapper) await deleteRuns(doc, index, group.parts.slice(1));
    const first = group.parts[0],
      entry = occurrence(doc, index, first, wrapper),
      fonts = get(entry.resources, 'Font'),
      added = [];
    const used = fonts.clone(doc.context);
    const baseline = [group.transform[4] + offset[0], group.transform[5] + offset[1]],
      pen = [...baseline];
    let line = 0;
    const inverseCtm = inverse(first.state.ctm),
      commands = ['q', ...(wrapper?.textObject ? ['BT'] : [])];
    const items = [];
    const decorations = [];
    let maxAdvance = 0;
    let firstGlyph;
    for (const item of prepared) {
      if (item.newline) {
        if (item.soft || !paragraph) items.push(item.soft ? -2 : -1);
        line++;
        pen[0] =
          baseline[0] - group.transform[2] * factor * (lineOffsets?.[line] ?? leading * line);
        pen[1] =
          baseline[1] - group.transform[3] * factor * (lineOffsets?.[line] ?? leading * line);
        continue;
      }
      if (item.gap) {
        items.push(paragraphVector(inverseCtm, item.gap));
        pen[0] += item.gap[0];
        pen[1] += item.gap[1];
        continue;
      }
      const { run, size, width } = item,
        s = run.state;
      firstGlyph ||= [...pen];
      items.push(item.marker ?? 1);
      let fontName = PDFName.of(s.font);
      if (item.font) {
        fontName = uniqueName(used, 'LineFont');
        used.set(fontName, item.font.ref);
        added.push([fontName, item.font.ref]);
      }
      const t = run.transform;
      const tm = matrix(inverseCtm, [
        t[0] / (s.size * s.hScale),
        t[1] / (s.size * s.hScale),
        t[2] / s.size,
        t[3] / s.size,
        ...pen,
      ]);
      const ink = color
        ? `${[1, 3, 5].map((i) => num(parseInt(color.slice(i, i + 2), 16) / 255)).join(' ')} rg`
        : s.fillCommand;
      const strokeInk = (color || run.strokeColor || run.fillColor)
        .slice(1)
        .match(/../g)
        .map((value) => num(parseInt(value, 16) / 255))
        .join(' ');
      let show = item.encoded[0] + ' Tj';
      if (item.original) {
        if (run.op === 'Tj' || run.op === 'TJ') show = run.source;
        else {
          const value = run.args.at(-1);
          show = run.source.slice(value.start - run.start, value.end - run.start) + ' Tj';
        }
      }
      commands.push(
        `${fontName} ${num(size)} Tf`,
        `${num(s.charSpacing * factor)} Tc`,
        `${num(s.wordSpacing * factor)} Tw`,
        `${num(s.hScale * 100)} Tz`,
        '0 Ts',
        ink,
        ...(s.mode ? [`${strokeInk} RG`] : []),
        `${tm.map(num).join(' ')} Tm`,
        show,
      );
      if (width && (underline || strikethrough)) {
        const quads = textDecorationQuads(
          pen,
          [(t[0] / s.size) * width, (t[1] / s.size) * width],
          [(t[2] / s.size) * size, (t[3] / s.size) * size],
          { underline, strikethrough },
        );
        decorations.push('q', s.mode === 1 ? `${strokeInk} rg` : ink);
        for (const quad of quads) {
          const points = quad.map((point) => {
            const transformed = matrix(inverseCtm, [1, 0, 0, 1, ...point]);
            return transformed.slice(4).map(num).join(' ');
          });
          decorations.push(`${points[0]} m`, ...points.slice(1).map((p) => `${p} l`), 'h f');
        }
        decorations.push('Q');
      }
      pen[0] += (t[0] / s.size) * width;
      pen[1] += (t[1] / s.size) * width;
      const a = group.transform;
      maxAdvance = Math.max(
        maxAdvance,
        (((pen[0] - baseline[0]) * a[0] + (pen[1] - baseline[1]) * a[1]) /
          (a[0] ** 2 + a[1] ** 2)) *
          group.state.size,
      );
    }
    const s = first.state,
      tm = matrix(s.tm, [1, 0, 0, 1, s.lineX, s.lineY]);
    const prefix =
      first.op === '"'
        ? `${num(s.wordSpacing)} Tw ${num(s.charSpacing)} Tc T*\n`
        : first.op === "'"
          ? 'T*\n'
          : '';
    if ((paragraph || styled) && firstGlyph) {
      const origin = paragraphVector(
        inverseCtm,
        baseline.map((n, i) => n - firstGlyph[i]),
      );
      const width = paragraphVector(
        inverseCtm,
        group.transform
          .slice(0, 2)
          .map((n) => (n * (paragraph?.width || Math.max(1, maxAdvance))) / group.state.size),
      );
      const spacing = paragraphVector(
        inverseCtm,
        group.transform.slice(2, 4).map((n) => n * factor * leading),
      );
      commands.splice(
        1,
        0,
        writeParagraphData(
          [...origin, ...width, ...spacing],
          items,
          styled ? { underline, strikethrough, line: !paragraph } : undefined,
        ),
      );
      if (decorations.length)
        commands.push('ET', '/PuterTextDecoration BMC', ...decorations, 'EMC', 'BT');
      if (wrapper?.textObject) commands.push('ET');
      commands.push('EMC');
    } else if (wrapper?.textObject) commands.push('ET');
    commands.push('Q');
    // The commands after Q put the text position back where the content that follows expects
    // it. A replaced block keeps the ones its first edit wrote, which measured the original text.
    if (wrapper?.trailer) commands.push(wrapper.trailer.trim());
    else if (!wrapper?.textObject)
      commands.push(
        `${tm.map(num).join(' ')} Tm`,
        '0 Tc',
        `[${num((-((s.x - s.lineX) / s.hScale + first.advance) * 1000) / s.size)}] TJ`,
        `${num(s.charSpacing)} Tc`,
      );
    rewriteOccurrence(doc, index, entry, prefix + commands.join('\n'), (resources) => {
      const target = get(resources, 'Font');
      for (const [name, ref] of added) target.set(name, ref);
    });
  }
}
