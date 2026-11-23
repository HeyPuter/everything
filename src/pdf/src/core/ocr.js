/**
 * OCR text layers: recognized words written onto a scanned page as invisible text (render mode
 * 3), the way Acrobat makes scans searchable. Each word starts at its box on the image and is
 * stretched with horizontal scaling to the box's width, so search hits and selections line up
 * with the picture. The layer sits in its own content stream inside a `/PuterOCR` marked-content
 * sequence, so running OCR again or removing it later touches nothing else on the page.
 *
 * The recognizer itself lives in `src/ocr-engine.js`; this module only needs its result:
 * `{ words: [{ text, bbox: { x0, y0, x1, y1 }, baseline? }], lines?, width?, height? }` with
 * boxes in image pixels (origin top-left) of a render of the page's visible box as displayed.
 */
import { PDFArray, PDFDict, PDFName, PDFStream } from 'pdf-lib';
import { assertSupportedText, embedFont, visibleBox } from './document.js';
import { pageRotation, pageUserUnit } from './structure.js';
import { pageSource, parseContent, setPageSource } from './text-edit.js';
import { contentReport, filterContent } from './content-filter.js';

/** Marked-content tag and stream-dictionary key that identify a layer this app wrote. */
export const OCR_TAG = 'PuterOCR';
const MARK = PDFName.of(OCR_TAG),
  CONTENTS = PDFName.of('Contents'),
  RESOURCES = PDFName.of('Resources'),
  FONT = PDFName.of('Font');
/** Words whose glyphs are shorter than this (in em) say little about the line's font size. */
const MIN_SIZING_INK = 0.4;

/**
 * Whether a page still needs OCR, judged from PDF.js `getTextContent()` like Acrobat's default
 * of skipping pages that already contain text. `pageArea` is the page's visible area in PDF user
 * units (the same units as the items). Text in pagination artifacts (headers, footers, page
 * numbers and watermarks) and in an OCR layer this app added does not count as real text; that
 * needs the content fetched with `{ includeMarkedContent: true }`. So a page OCR'd before reports
 * true, and running it again replaces the old layer. Text other producers made invisible cannot
 * be told apart here and counts as real text. `force` always returns true.
 */
export function pageNeedsOcr(
  textContent,
  pageArea,
  { force = false, minChars = 20, minCoverage = 0.02 } = {},
) {
  if (force) return true;
  let chars = 0,
    covered = 0;
  const stack = [];
  for (const item of textContent?.items || []) {
    if (item.type === 'beginMarkedContent' || item.type === 'beginMarkedContentProps') {
      stack.push(item.tag === 'Artifact' || item.tag === OCR_TAG || stack.at(-1) === true);
      continue;
    }
    if (item.type === 'endMarkedContent') {
      stack.pop();
      continue;
    }
    if (stack.at(-1) || typeof item.str !== 'string') continue;
    const visible = item.str.replace(/\s+/g, '').length;
    if (!visible) continue;
    chars += visible;
    covered += Math.abs(item.width * item.height) || 0;
  }
  if (chars >= minChars) return false;
  return !(chars && pageArea > 0 && covered / pageArea >= minCoverage);
}

/**
 * Maps from image pixels to the page: the reader's view of the visible box (rotation applied),
 * scaled to the image, then turned back into PDF user space. `along` and `up` are the user-space
 * directions of the image's x axis and of "up" on the image, one user unit long.
 */
function imageFrame(page, { imageWidth, imageHeight, renderScale }) {
  const box = visibleBox(page);
  const rotation = pageRotation(page);
  const sideways = rotation === 90 || rotation === 270;
  const width = sideways ? box.height : box.width,
    height = sideways ? box.width : box.height;
  // A render at `renderScale` is (user units x UserUnit x scale) pixels, as in PDF.js viewports.
  const pixel = renderScale > 0 ? 1 / (renderScale * pageUserUnit(page)) : null;
  const sx = imageWidth > 0 ? width / imageWidth : pixel;
  const sy = imageHeight > 0 ? height / imageHeight : pixel;
  if (!sx || !sy) throw new Error('OCR results need the image size or the render scale.');
  const x0 = box.x,
    y0 = box.y,
    x1 = box.x + box.width,
    y1 = box.y + box.height;
  // Reader coordinates (u right, v up from the displayed bottom-left corner) to user space.
  const toPdf =
    rotation === 90
      ? (u, v) => [x1 - v, y0 + u]
      : rotation === 180
        ? (u, v) => [x1 - u, y1 - v]
        : rotation === 270
          ? (u, v) => [x0 + v, y1 - u]
          : (u, v) => [x0 + u, y0 + v];
  const [ox, oy] = toPdf(0, 0);
  const [ax, ay] = toPdf(1, 0);
  const [ux, uy] = toPdf(0, 1);
  return {
    sx,
    sy,
    point: (px, py) => toPdf(px * sx, height - py * sy),
    along: [ax - ox, ay - oy],
    up: [ux - ox, uy - oy],
  };
}

/** The word with characters our font cannot draw dropped (OCR of English rarely produces any). */
function drawable(font, text) {
  let out = '';
  for (const char of String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()) {
    try {
      out += assertSupportedText(font, char);
    } catch {
      // Leave the character out; the rest of the word stays searchable.
    }
  }
  return out;
}

/** Advance width and vertical ink extent of `text` in em, as pdf-lib will encode it. */
function metrics(font, text) {
  const face = font.embedder.font;
  let bottom = 0,
    top = 0;
  for (const glyph of face.layout(text, font.embedder.fontFeatures).glyphs) {
    const box = glyph.bbox;
    if (!Number.isFinite(box.minY) || !Number.isFinite(box.maxY) || box.maxY <= box.minY) continue;
    bottom = Math.min(bottom, box.minY);
    top = Math.max(top, box.maxY);
  }
  return {
    advance: font.widthOfTextAtSize(text, 1),
    bottom: bottom / face.unitsPerEm,
    top: top / face.unitsPerEm,
  };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Words grouped into lines in reading order, using the recognizer's lines when it gave them. */
function resultLines(result) {
  if (Array.isArray(result.lines) && result.lines.some((line) => line.words?.length))
    return result.lines.filter((line) => line.words?.length);
  // Without lines, start a new one when a word does not overlap the previous one vertically
  // or steps back to the left.
  const lines = [];
  let last = null;
  for (const word of result.words || []) {
    const b = word.bbox;
    const overlap = last && Math.min(b.y1, last.y1) - Math.max(b.y0, last.y0);
    if (!last || b.x0 < last.x0 || overlap < 0.5 * Math.min(b.y1 - b.y0, last.y1 - last.y0))
      lines.push({ words: [] });
    lines.at(-1).words.push(word);
    last = b;
  }
  return lines;
}

const num = (n) => {
  const s = (Math.round(n * 1000) / 1000).toString();
  return s === '-0' ? '0' : s;
};

/**
 * Write `result` (see the module comment) onto page `pageIndex` as an invisible, searchable
 * text layer. `imageWidth`/`imageHeight` (default `result.width`/`result.height`) are the size
 * of the image OCR ran on, or give `renderScale`, the PDF.js viewport scale it was rendered at.
 * An earlier layer from this app is removed first unless `replaceExisting` is false; with
 * `replaceInvisible`, so is any other invisible text on the page, such as another program's
 * OCR layer, which recognizing the page again would otherwise leave beside the new one.
 * Returns the number of words and lines written.
 */
export async function addOcrTextLayer(
  doc,
  pageIndex,
  result,
  {
    imageWidth = result?.width,
    imageHeight = result?.height,
    renderScale,
    replaceExisting = true,
    replaceInvisible = false,
  } = {},
) {
  const page = doc.getPage(pageIndex);
  const frame = imageFrame(page, { imageWidth, imageHeight, renderScale });
  if (replaceExisting) removeOcrTextLayer(doc, pageIndex);
  if (replaceInvisible) await removeInvisibleText(doc, page);
  const font = await embedFont(doc);
  const space = metrics(font, ' ').advance;
  const [ax, ay] = frame.along,
    [nx, ny] = frame.up;
  const body = [];
  let words = 0,
    lines = 0,
    key = null;
  for (const line of resultLines(result || {})) {
    const items = line.words
      .map((word) => ({ word, text: drawable(font, word.text) }))
      .filter(({ word, text }) => text && word.bbox && word.bbox.x1 > word.bbox.x0)
      .map((item) => ({ ...item, ...metrics(font, item.text) }));
    if (!items.length) continue;
    // One font size per line, from the words' heights against their glyphs' ink in our font,
    // so a line of lowercase and a line of capitals both fill their boxes.
    const estimate = (item) =>
      (item.word.bbox.y1 - item.word.bbox.y0) / Math.max(item.top - item.bottom, 0.5);
    const sizing = items.filter((item) => item.top - item.bottom >= MIN_SIZING_INK);
    const sizePx = median((sizing.length ? sizing : items).map(estimate));
    if (!(sizePx > 0)) continue;
    const size = sizePx * frame.sy;
    const base = line.baseline || items[0].word.baseline;
    const baselineAt = (item) => {
      const { x0, x1, y1 } = item.word.bbox;
      if (base && Number.isFinite(base.y0) && Number.isFinite(base.y1) && base.x1 !== base.x0) {
        const x = (x0 + x1) / 2;
        const y = base.y0 + ((base.y1 - base.y0) * (x - base.x0)) / (base.x1 - base.x0);
        // Ignore a baseline the recognizer placed outside the word's own box.
        if (y >= item.word.bbox.y0 && y <= y1 + sizePx * 0.5) return y;
      }
      return y1 + item.bottom * sizePx;
    };
    key ??= fontKey(page, font);
    body.push(`/${key} ${num(size)} Tf`);
    for (const [i, item] of items.entries()) {
      const { x0, x1 } = item.word.bbox;
      const [x, y] = frame.point(x0, baselineAt(item));
      const width = (x1 - x0) * frame.sx;
      const scale = (100 * width) / (item.advance * size);
      // Each word gets its own marked-content span so PDF.js reports it as its own text item,
      // positioned and sized like the word on the image.
      body.push(
        `${num(ax)} ${num(ay)} ${num(nx)} ${num(ny)} ${num(x)} ${num(y)} Tm`,
        `${num(scale)} Tz`,
        `/Span BMC ${font.encodeText(item.text)} Tj EMC`,
      );
      const next = items[i + 1];
      if (next) {
        // A real space between words, stretched across the gap to the next word.
        const gap = Math.max((next.word.bbox.x0 - x1) * frame.sx, size * 0.01);
        body.push(`${num((100 * gap) / (space * size))} Tz ${font.encodeText(' ')} Tj`);
      }
      words++;
    }
    lines++;
  }
  if (!words) return { words: 0, lines: 0 };
  const source = [
    // Undo whatever graphics state the page's own content leaves behind (see the `q` below).
    'Q',
    `/${OCR_TAG} <</V 1>> BDC`,
    'BT',
    '3 Tr',
    ...body,
    'ET',
    'EMC',
    '',
  ].join('\n');
  const marker = { [OCR_TAG]: true };
  const start = doc.context.register(doc.context.stream(new TextEncoder().encode('q\n'), marker));
  const layer = doc.context.register(
    doc.context.flateStream(new TextEncoder().encode(source), marker),
  );
  // Set Contents directly: pdf-lib's own page helpers would also wrap the page in a q/Q pair
  // that removing the layer could not tell apart from the page's content.
  page.node.set(CONTENTS, doc.context.obj([start, ...contentRefs(page), layer]));
  return { words, lines };
}

/**
 * The page's resource name for our font, reusing the one an earlier layer added. Resources
 * shared with other pages are copied first, so removing this page's layer later cannot take
 * the font away from another page.
 */
function fontKey(page, font) {
  const { context } = page.doc;
  const own = (holder, name, dict) =>
    holder.get(name) instanceof PDFDict ? dict : dict ? dict.clone(context) : context.obj({});
  const resources = own(page.node, RESOURCES, page.node.Resources());
  page.node.set(RESOURCES, resources);
  const fonts = own(resources, FONT, resources.lookupMaybe(FONT, PDFDict));
  resources.set(FONT, fonts);
  for (const [key, value] of fonts.entries())
    if (key.asString().startsWith(`/${OCR_TAG}-`) && value === font.ref)
      return key.asString().slice(1);
  let n = 1;
  while (fonts.has(PDFName.of(`${OCR_TAG}-${n}`))) n++;
  fonts.set(PDFName.of(`${OCR_TAG}-${n}`), font.ref);
  return `${OCR_TAG}-${n}`;
}

/** The page's decoded content, or '' when a stream uses a filter we cannot decode. */
const sourceOf = (page) => {
  try {
    return pageSource(page);
  } catch {
    return '';
  }
};
const contentRefs = (page) => {
  const contents = page.node.Contents();
  return contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
};
const isOcrStream = (doc, ref) => {
  const stream = doc.context.lookup(ref);
  return stream instanceof PDFStream && stream.dict.has(MARK);
};

/** Whether page `pageIndex` carries an OCR layer this app wrote. */
export function hasOcrTextLayer(doc, pageIndex) {
  const page = doc.getPage(pageIndex);
  return (
    contentRefs(page).some((ref) => isOcrStream(doc, ref)) || sourceOf(page).includes(`/${OCR_TAG}`)
  );
}

/**
 * Remove the OCR layers this app wrote on page `pageIndex`, including one an edit has since
 * merged into the page's other content. Returns whether anything was removed.
 */
export function removeOcrTextLayer(doc, pageIndex) {
  const page = doc.getPage(pageIndex);
  const refs = contentRefs(page);
  let removed = false;
  if (refs.some((ref) => isOcrStream(doc, ref))) {
    page.node.set(CONTENTS, doc.context.obj(refs.filter((ref) => !isOcrStream(doc, ref))));
    removed = true;
  }
  // Text editing rewrites a page into a single stream; cut our marked sequence out of it.
  const source = sourceOf(page);
  if (source.includes(`/${OCR_TAG}`)) {
    let operations;
    try {
      operations = parseContent(source);
    } catch {
      operations = null;
    }
    const spans = [];
    let depth = 0,
      start = -1;
    for (const op of operations || []) {
      if (op.op === 'BDC' || op.op === 'BMC') {
        if (start < 0 && op.args[0]?.type === 'name' && op.args[0].value === OCR_TAG)
          ((start = op.start), (depth = 0));
        if (start >= 0) depth++;
      } else if (op.op === 'EMC' && start >= 0 && --depth === 0) {
        spans.push([start, op.end]);
        start = -1;
      }
    }
    if (spans.length) {
      let kept = '',
        at = 0;
      for (const [from, to] of spans) {
        kept += source.slice(at, from);
        at = to;
      }
      setPageSource(doc, page, kept + source.slice(at));
      removed = true;
    }
  }
  // Drop our font entries once no layer uses them, so a removed layer leaves no font behind.
  const resources = page.node.Resources();
  const fonts = resources?.lookup(FONT);
  if (removed && fonts instanceof PDFDict && !sourceOf(page).includes(`/${OCR_TAG}-`))
    for (const key of fonts.keys())
      if (key.asString().startsWith(`/${OCR_TAG}-`)) fonts.delete(key);
  return removed;
}

/**
 * Take the text drawn in render mode 3 (invisible: written to be searched, not seen) off a
 * page, as another program's OCR layer is. Text that clips (modes 4 to 7) stays. Returns
 * whether anything went; a page whose content cannot be read keeps it.
 */
async function removeInvisibleText(doc, page) {
  let result;
  try {
    result = await filterContent(doc, {
      source: pageSource(page),
      resources: page.node.Resources(),
      policy: {
        glyph: (quad, { mode }) => mode === 3,
        form: () => 'descend',
        formFailed: () => 'keep',
      },
      report: contentReport(),
      memo: new Map(),
    });
  } catch {
    return false;
  }
  if (!result.changed) return false;
  if (result.resources) page.node.set(RESOURCES, result.resources);
  setPageSource(doc, page, result.source);
  return true;
}
