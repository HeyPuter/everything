/**
 * Watermarks and page numbers: text drawn upright for the reader on every chosen page, marked
 * as pagination artifacts so assistive technology skips them, and made of ordinary text so the
 * Text tool can still revise or remove them one page at a time.
 */
import { PDFName, PDFOperator, PDFOperatorNames, degrees } from 'pdf-lib';
import { assertSupportedText, color, embedFont, visibleBox } from './document.js';
import { pageRotation, pageUserUnit } from './structure.js';

/** Watermark width as a fraction of the page's span (its width, or its diagonal when tilted). */
export const WATERMARK_SIZES = { small: 0.4, medium: 0.55, large: 0.7 };
export const WATERMARK_LAYOUTS = { diagonal: 45, horizontal: 0 };
export const NUMBER_FORMATS = {
  plain: '{n}',
  page: 'Page {n}',
  of: 'Page {n} of {N}',
  slash: '{n} / {N}',
  dashes: '- {n} -',
};
export const NUMBER_POSITIONS = [
  'bottom-center',
  'bottom-left',
  'bottom-right',
  'top-center',
  'top-left',
  'top-right',
];
export const HEADER_SLOTS = [
  'topLeft',
  'topCenter',
  'topRight',
  'bottomLeft',
  'bottomCenter',
  'bottomRight',
];
export const MAX_HEADER_TEXT = 200;
/** Height of a capital letter in Noto Sans, as a fraction of the font size. */
const CAP_HEIGHT = 0.714;

/** The drawn glyph bounds and advance, including overhangs, accents, and descenders. */
function textInk(font, text, size) {
  // These marks use our embedded Noto face. Match the glyphs pdf-lib encodes;
  // its text drawing uses glyph advances without fontkit's positioning offsets.
  const face = font.embedder.font;
  const glyphs = face.layout(assertSupportedText(font, text), font.embedder.fontFeatures).glyphs;
  let advance = 0,
    left = 0,
    right = 0,
    bottom = 0,
    top = 0;
  for (const glyph of glyphs) {
    const box = glyph.bbox;
    if (Number.isFinite(box.minX) && Number.isFinite(box.maxX)) {
      left = Math.min(left, advance + box.minX);
      right = Math.max(right, advance + box.maxX);
    }
    if (Number.isFinite(box.minY) && Number.isFinite(box.maxY)) {
      bottom = Math.min(bottom, box.minY);
      top = Math.max(top, box.maxY);
    }
    advance += glyph.advanceWidth;
  }
  const scale = size / face.unitsPerEm;
  return {
    advance: advance * scale,
    left: left * scale,
    right: Math.max(right, advance) * scale,
    bottom: bottom * scale,
    top: top * scale,
  };
}

/**
 * The page as the reader sees it: its width and height once the page rotation is applied, the
 * quarter turn text needs to read upright, and maps between reader coordinates (origin at the
 * displayed bottom-left corner) and PDF user space on the crop box.
 */
export function uprightFrame(page) {
  const box = visibleBox(page);
  const rotation = pageRotation(page);
  const x0 = box.x,
    y0 = box.y,
    x1 = box.x + box.width,
    y1 = box.y + box.height;
  const sideways = rotation === 90 || rotation === 270;
  const toPdf =
    rotation === 90
      ? (u, v) => ({ x: x1 - v, y: y0 + u })
      : rotation === 180
        ? (u, v) => ({ x: x1 - u, y: y1 - v })
        : rotation === 270
          ? (u, v) => ({ x: x0 + v, y: y1 - u })
          : (u, v) => ({ x: x0 + u, y: y0 + v });
  const toReader =
    rotation === 90
      ? (x, y) => ({ u: y - y0, v: x1 - x })
      : rotation === 180
        ? (x, y) => ({ u: x1 - x, v: y1 - y })
        : rotation === 270
          ? (x, y) => ({ u: y1 - y, v: x - x0 })
          : (x, y) => ({ u: x - x0, v: y - y0 });
  return {
    width: sideways ? box.height : box.width,
    height: sideways ? box.width : box.height,
    rotation,
    toPdf,
    toReader,
  };
}

/** Draw one line of text at reader coordinates (u, v), tilted by `angle` degrees for the reader. */
function drawUpright(page, frame, font, { text, size, hex, opacity, u, v, angle = 0 }, artifact) {
  const { x, y } = frame.toPdf(u, v);
  const properties = page.doc.context.obj({ Type: 'Pagination', Subtype: artifact });
  page.pushOperators(
    PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [
      PDFName.of('Artifact'),
      properties,
    ]),
  );
  page.drawText(text, {
    x,
    y,
    size,
    font,
    color: color(hex),
    opacity,
    rotate: degrees(frame.rotation + angle),
  });
  page.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent, []));
}

const uniquePages = (indices) => {
  const pages = [...new Set(indices)].sort((a, b) => a - b);
  if (!pages.length) throw new Error('Choose at least one page.');
  return pages;
};

/**
 * Center `text` on each page in `indices`, tilted along the diagonal or laid flat, sized
 * relative to the page so mixed page sizes get proportionate marks, and kept inside the page.
 */
export async function addWatermark(
  doc,
  indices,
  { text, layout = 'diagonal', size = 'medium', hex = '#000000', opacity = 0.25 } = {},
) {
  const label = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!label) throw new Error('Enter the watermark text.');
  if (label.length > 200) throw new Error('Keep the watermark under 200 characters.');
  const fraction = WATERMARK_SIZES[size];
  if (!fraction) throw new Error('Choose a watermark size.');
  const angle = WATERMARK_LAYOUTS[layout];
  if (angle === undefined) throw new Error('Choose a watermark layout.');
  const alpha = Number(opacity);
  if (!(alpha > 0 && alpha <= 1)) throw new Error('Choose an opacity between 1% and 100%.');
  const pages = uniquePages(indices);
  // Korean text takes the Korean face, as it does in the Text tool.
  const font = await embedFont(doc, 'regular', label);
  assertSupportedText(font, label);
  const ink = textInk(font, label, 1);
  const unitWidth = ink.right - ink.left;
  const unitHeight = ink.top - ink.bottom;
  const radians = (angle * Math.PI) / 180,
    cos = Math.cos(radians),
    sin = Math.sin(radians);
  for (const index of pages) {
    const page = doc.getPage(index);
    const frame = uprightFrame(page);
    const { width, height } = frame;
    const span = angle ? Math.hypot(width, height) : width;
    // The mark's footprint along each page axis stays within 90% of the page.
    const fit = (limit, along, across) => limit / (unitWidth * along + unitHeight * across);
    const fontSize = Math.min(
      (fraction * span) / unitWidth,
      fit(0.9 * width, cos, sin),
      fit(0.9 * height, sin, cos),
    );
    const centerX = (fontSize * (ink.left + ink.right)) / 2,
      centerY = (fontSize * (ink.top + ink.bottom)) / 2;
    // Center the full ink box, including glyphs that extend beyond their advance width.
    const u = width / 2 - centerX * cos + centerY * sin;
    const v = height / 2 - centerX * sin - centerY * cos;
    drawUpright(
      page,
      frame,
      font,
      { text: label, size: fontSize, hex, opacity: alpha, u, v, angle },
      'Watermark',
    );
  }
}

/** Replace {page}, {pages}, {date}, {title}, and {file} in a header or footer template. */
/** The date as the reader's locale writes it, in Latin digits. */
export const localeDate = (date) =>
  date.toLocaleDateString(undefined, { dateStyle: 'medium', numberingSystem: 'latn' });
/** The date as digits alone, for a font that lacks the locale's month names or script. */
export const plainDate = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
/**
 * A Bates number: an optional prefix and suffix around a number padded to `digits`, counted
 * from `start` across the stamped pages, as legal document productions label every page.
 */
export function batesLabel({ prefix = '', suffix = '', start = 1, digits = 6 } = {}, offset = 0) {
  const first = Number(start),
    width = Number(digits);
  if (!Number.isInteger(first) || first < 0 || first > 999999999)
    throw new Error('Start Bates numbers between 0 and 999,999,999.');
  if (!Number.isInteger(width) || width < 1 || width > 15)
    throw new Error('Use between 1 and 15 digits for Bates numbers.');
  return `${prefix}${String(first + offset).padStart(width, '0')}${suffix}`;
}
export function fillTokens(
  template,
  { page, pages, date, title = '', file = '', bates = '', formatDate = localeDate },
) {
  const when = date instanceof Date && !Number.isNaN(date.getTime()) ? formatDate(date) : '';
  return String(template ?? '').replace(/\{(page|pages|date|title|file|bates)\}/gi, (_, token) => {
    switch (token.toLowerCase()) {
      case 'bates':
        return bates;
      case 'page':
        return String(page);
      case 'pages':
        return String(pages);
      case 'date':
        return when;
      case 'title':
        return title;
      default:
        return file;
    }
  });
}

/**
 * Put text in any of six places on each page in `indices`: the corners and centers of the
 * top and bottom edges, with the tokens fillTokens knows. Empty slots are skipped.
 */
export async function addHeaderFooter(
  doc,
  indices,
  {
    slots = {},
    size = 10,
    hex = '#000000',
    margin = 28,
    title = '',
    file = '',
    date = new Date(),
    bates = null,
  } = {},
) {
  const fontSize = Number(size);
  if (!(fontSize >= 6 && fontSize <= 36)) throw new Error('Choose a size between 6 and 36 points.');
  if (bates) batesLabel(bates);
  const used = HEADER_SLOTS.filter((slot) => String(slots[slot] ?? '').trim());
  if (!used.length) throw new Error('Enter text for at least one header or footer position.');
  for (const slot of used)
    if (String(slots[slot]).trim().length > MAX_HEADER_TEXT)
      throw new Error(`Keep each header or footer under ${MAX_HEADER_TEXT} characters.`);
  const pages = uniquePages(indices);
  const total = doc.getPageCount();
  // Korean text, typed or from the title or file name, takes the Korean face.
  const font = await embedFont(
    doc,
    'regular',
    used.map((slot) => fillTokens(slots[slot], { page: 1, pages: total, title, file })).join(' '),
  );
  const placements = [];
  for (const [order, index] of pages.entries()) {
    const page = doc.getPage(index);
    const frame = uprightFrame(page);
    const unit = pageUserUnit(page);
    const userSize = fontSize / unit;
    const inset = Math.min(margin / unit, frame.width / 4, frame.height / 4);
    const occupied = [];
    const batesNumber = bates ? batesLabel(bates, order) : '';
    for (const slot of used) {
      const fill = (formatDate) =>
        fillTokens(String(slots[slot]).trim(), {
          page: index + 1,
          pages: total,
          date,
          title,
          file,
          bates: batesNumber,
          formatDate,
        })
          .replace(/\s+/g, ' ')
          .trim();
      let label = fill(localeDate);
      if (!label) continue;
      try {
        assertSupportedText(font, label);
      } catch (error) {
        // A locale whose month names the font cannot write falls back to digits; anything
        // else unsupported is the person's own text, and the error stands.
        const digits = fill(plainDate);
        if (digits === label) throw error;
        assertSupportedText(font, digits);
        label = digits;
      }
      assertSupportedText(font, label);
      const top = slot.startsWith('top');
      const horizontal = slot.replace(/^(top|bottom)/, '').toLowerCase();
      const ink = textInk(font, label, userSize);
      const w = ink.advance,
        h = userSize * CAP_HEIGHT;
      const u =
        horizontal === 'left'
          ? inset
          : horizontal === 'right'
            ? frame.width - inset - w
            : (frame.width - w) / 2;
      const v = top ? frame.height - inset - h : inset;
      if (u + ink.left < -1e-7 || u + ink.right > frame.width + 1e-7)
        throw new Error(
          `The ${top ? 'header' : 'footer'} is too wide for page ${index + 1}. Use shorter text or a smaller size.`,
        );
      if (v + ink.bottom < -1e-7 || v + ink.top > frame.height + 1e-7)
        throw new Error(
          `The ${top ? 'header' : 'footer'} is too tall for page ${index + 1}. Choose a smaller size.`,
        );
      const bounds = [u + ink.left, v + ink.bottom, u + ink.right, v + ink.top];
      if (
        occupied.some(
          (other) =>
            Math.min(bounds[2], other[2]) - Math.max(bounds[0], other[0]) > 1e-7 &&
            Math.min(bounds[3], other[3]) - Math.max(bounds[1], other[1]) > 1e-7,
        )
      )
        throw new Error(
          `Header and footer entries overlap on page ${index + 1}. Use shorter text, a smaller size, or fewer positions.`,
        );
      occupied.push(bounds);
      placements.push([
        page,
        frame,
        font,
        { text: label, size: userSize, hex, u, v },
        top ? 'Header' : 'Footer',
      ]);
    }
  }
  // Validate every page before adding any content to the document.
  for (const placement of placements) drawUpright(...placement);
}

/**
 * Number the pages in `indices` in ascending order from `start`, in one of NUMBER_FORMATS at one
 * of NUMBER_POSITIONS; `{N}` is the last number given, so a numbered range reads "1 of 9".
 */
export async function addPageNumbers(
  doc,
  indices,
  {
    format = 'of',
    position = 'bottom-center',
    start = 1,
    size = 11,
    hex = '#000000',
    margin = 28,
  } = {},
) {
  const template = NUMBER_FORMATS[format];
  if (!template) throw new Error('Choose a page number format.');
  if (!NUMBER_POSITIONS.includes(position)) throw new Error('Choose where the page numbers go.');
  const first = Number(start);
  if (!Number.isInteger(first) || first < 0 || first > 99999)
    throw new Error('Start numbering between 0 and 99,999.');
  const fontSize = Number(size);
  if (!(fontSize >= 6 && fontSize <= 72)) throw new Error('Choose a size between 6 and 72 points.');
  const pages = uniquePages(indices);
  const font = await embedFont(doc);
  const last = first + pages.length - 1;
  const [vertical, horizontal] = position.split('-');
  const placements = pages.map((index, k) => {
    const label = template.replace('{n}', String(first + k)).replace('{N}', String(last));
    const page = doc.getPage(index);
    const frame = uprightFrame(page);
    const unit = pageUserUnit(page);
    const userSize = fontSize / unit;
    const ink = textInk(font, label, userSize);
    const w = ink.advance,
      h = userSize * CAP_HEIGHT;
    const inset = Math.min(margin / unit, frame.width / 4, frame.height / 4);
    const u =
      horizontal === 'left'
        ? inset
        : horizontal === 'right'
          ? frame.width - inset - w
          : (frame.width - w) / 2;
    const v = vertical === 'top' ? frame.height - inset - h : inset;
    if (u + ink.left < -1e-7 || u + ink.right > frame.width + 1e-7)
      throw new Error(
        `The page number is too wide for page ${index + 1}. Choose a smaller size or shorter format.`,
      );
    if (v + ink.bottom < -1e-7 || v + ink.top > frame.height + 1e-7)
      throw new Error(`The page number is too tall for page ${index + 1}. Choose a smaller size.`);
    return [
      page,
      frame,
      font,
      { text: label, size: userSize, hex, u, v },
      vertical === 'top' ? 'Header' : 'Footer',
    ];
  });
  for (const placement of placements) drawUpright(...placement);
}
