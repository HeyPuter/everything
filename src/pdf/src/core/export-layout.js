/**
 * Layout analysis for exporting PDF pages to editable documents.
 *
 * PDF.js gives positioned text (`getTextContent`) and the page's drawing operations
 * (`getOperatorList`). From those this module rebuilds a reading-order document model:
 *
 *   readPage(pdf, page, { images, signal })  -> PageScan   (raw spans, rules, fills, images)
 *   buildDocument(scans)                     -> DocModel   (blocks in reading order)
 *
 * Coordinates are PDF points in the page's displayed orientation (rotation applied), with the
 * origin at the top left and y growing downwards.
 *
 * DocModel = { pages: PageModel[], body: { size, font }, fonts: string[] }
 * PageModel = { index, width, height, margins, header: Block[], footer: Block[], blocks: Block[],
 *               fills: Fill[], images: Placement[], background: Placement|null, hasText }
 * Block =
 *   { type: 'paragraph', x, y, w, h, runs: Run[], lines: number, heading: 0..6, align,
 *     indent, firstLine, spaceBefore, lineHeight, size, list?: ListInfo, tabs?: TabStop[],
 *     column?: { x0, x1 }, band?: { id, count, index, gap } }
 *   { type: 'table', x, y, w, h, columns: number[] (boundaries), ruled, rows: Row[] }
 *   { type: 'image', x, y, w, h, picture, wrap: 'inline' | 'square' | 'behind' }
 * Run = { text, font, size, bold, italic, underline, strike, color: 'RRGGBB', script?, tab? }
 * Row = { y, h, header, cells: Cell[] } ; Cell = { col, span, rowSpan?, merged?, align,
 *         fill?, paragraphs: { runs: Run[], align }[] }
 */

// PDF.js operator codes (pdfjs-dist 6.x; the test checks them against the installed build).
export const OPS = {
  setLineWidth: 2,
  save: 10,
  restore: 11,
  transform: 12,
  stroke: 20,
  closeStroke: 21,
  fill: 22,
  eoFill: 23,
  fillStroke: 24,
  eoFillStroke: 25,
  closeFillStroke: 26,
  closeEOFillStroke: 27,
  endPath: 28,
  setFont: 37,
  setTextRenderingMode: 38,
  showText: 44,
  showSpacedText: 45,
  nextLineShowText: 46,
  nextLineSetSpacingShowText: 47,
  setStrokeGray: 56,
  setFillGray: 57,
  setStrokeRGBColor: 58,
  setFillRGBColor: 59,
  setStrokeCMYKColor: 60,
  setFillCMYKColor: 61,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  beginGroup: 76,
  endGroup: 77,
  paintImageMaskXObject: 83,
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
  paintImageXObjectRepeat: 88,
  constructPath: 91,
  setStrokeTransparent: 92,
  setFillTransparent: 93,
};
const STROKES = new Set([20, 21, 24, 25, 26, 27]);
const FILLS = new Set([22, 23, 24, 25, 26, 27]);

const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
};

/* ---------------------------------------------------------------- fonts and colours */

const KNOWN_FONTS = new Map(
  [
    'Arial',
    'Arial Narrow',
    'Arial Black',
    'Times New Roman',
    'Courier New',
    'Calibri',
    'Calibri Light',
    'Cambria',
    'Candara',
    'Consolas',
    'Constantia',
    'Corbel',
    'Georgia',
    'Verdana',
    'Tahoma',
    'Trebuchet MS',
    'Segoe UI',
    'Garamond',
    'Book Antiqua',
    'Century Gothic',
    'Century Schoolbook',
    'Franklin Gothic Medium',
    'Gill Sans MT',
    'Lucida Sans',
    'Lucida Console',
    'Palatino Linotype',
    'Bookman Old Style',
    'Aptos',
    'Symbol',
    'Wingdings',
  ].map((name) => [name.toLowerCase().replace(/\s/g, ''), name]),
);
const FONT_ALIASES = {
  helvetica: 'Arial',
  liberationsans: 'Arial',
  arimo: 'Arial',
  nimbussans: 'Arial',
  nimbussansl: 'Arial',
  arialmt: 'Arial',
  times: 'Times New Roman',
  timesroman: 'Times New Roman',
  timesnewromanps: 'Times New Roman',
  liberationserif: 'Times New Roman',
  tinos: 'Times New Roman',
  nimbusroman: 'Times New Roman',
  nimbusromno9l: 'Times New Roman',
  courier: 'Courier New',
  couriernewps: 'Courier New',
  liberationmono: 'Courier New',
  cousine: 'Courier New',
  nimbusmono: 'Courier New',
  palatino: 'Palatino Linotype',
  bookantiqua: 'Book Antiqua',
  gillsans: 'Gill Sans MT',
  segoe: 'Segoe UI',
  zapfdingbats: 'Wingdings',
  helveticaneue: 'Arial',
  notoserif: 'Times New Roman',
  sourceserif: 'Times New Roman',
};

/** Font facts from a PDF font name such as "ABCDEF+TimesNewRomanPS-BoldItalicMT". */
export function describeFont(name = '', generic = 'sans-serif') {
  const raw = String(name).replace(/^[A-Z]{6}\+/, '');
  const style = raw.split(/[-,]/).slice(1).join('-') || raw;
  const bold =
    /bold|black|heavy|semibold|demi|extrabold|ultrabold|(?:^|[-,])(?:bd|sb)(?:$|it)/i.test(style);
  const italic = /italic|oblique|(?:^|[-,])(?:it|ital|bi|bdit|sbit)$|kursiv/i.test(style);
  const base = raw
    .split(/[-,]/)[0]
    .replace(/(PSMT|PS|MT|Std|Pro|LT|Regular|Bold|Italic)+$/g, '')
    .replace(/[^A-Za-z0-9]/g, '');
  const key = base.toLowerCase();
  let family = KNOWN_FONTS.get(key) || FONT_ALIASES[key];
  if (!family) {
    const words = base.replace(/([a-z])([A-Z])/g, '$1 $2').trim();
    family = KNOWN_FONTS.get(words.toLowerCase().replace(/\s/g, ''));
  }
  if (!family) {
    if (/mono|courier|consol|code/i.test(raw) || generic === 'monospace') family = 'Courier New';
    else if (/serif/i.test(generic) && !/sans/i.test(generic)) family = 'Times New Roman';
    else if (/times|roman|garamond|georgia|minion|book|serif|caslon|baskerville/i.test(raw))
      family = 'Times New Roman';
    else family = 'Arial';
  }
  return {
    family,
    bold,
    italic,
    symbolic: /symbol|dingbat|wingding|webding/i.test(raw),
  };
}

function hexColor(args) {
  const value = args?.[0];
  if (typeof value === 'string')
    return /^#?[0-9a-f]{6}$/i.test(value) ? value.replace('#', '').toUpperCase() : '000000';
  if (args?.length >= 3 && args.every(Number.isFinite)) {
    const scale = args.some((n) => n > 1) ? 1 : 255;
    return args
      .slice(0, 3)
      .map((n) =>
        Math.max(0, Math.min(255, Math.round(n * scale)))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
      .toUpperCase();
  }
  return '000000';
}
const grayHex = (g) => {
  const n = Math.max(0, Math.min(255, Math.round((g > 1 ? g / 255 : g) * 255)));
  return n.toString(16).padStart(2, '0').repeat(3).toUpperCase();
};
const cmykHex = ([c, m, y, k]) =>
  [c, m, y]
    .map((v) =>
      Math.round(255 * (1 - Math.min(1, v + k)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
    .toUpperCase();
const lightness = (hex) => {
  const n = parseInt(hex, 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
};

/* ---------------------------------------------------------------- page reading */

/** Walk the operator list for text colours, rules, filled boxes and image placements. */
function walkOperators(list, view) {
  const runs = [],
    rules = [],
    fills = [],
    images = [],
    vectors = [];
  let state = {
    ctm: [1, 0, 0, 1, 0, 0],
    fill: '000000',
    stroke: '000000',
    width: 1,
    font: null,
    mode: 0,
  };
  const stack = [];
  const { fnArray, argsArray } = list;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i],
      args = argsArray[i];
    switch (fn) {
      case OPS.save:
      case OPS.beginGroup:
        stack.push({ ...state });
        break;
      case OPS.restore:
      case OPS.endGroup:
        state = stack.pop() || state;
        break;
      case OPS.transform:
        if (args?.length === 6) state.ctm = mul(state.ctm, args);
        break;
      case OPS.paintFormXObjectBegin:
        stack.push({ ...state });
        if (args?.[0]?.length === 6) state.ctm = mul(state.ctm, Array.from(args[0]));
        break;
      case OPS.paintFormXObjectEnd:
        state = stack.pop() || state;
        break;
      case OPS.setLineWidth:
        state.width = args[0];
        break;
      case OPS.setFillRGBColor:
        state.fill = hexColor(args);
        break;
      case OPS.setStrokeRGBColor:
        state.stroke = hexColor(args);
        break;
      case OPS.setFillGray:
        state.fill = grayHex(args[0]);
        break;
      case OPS.setStrokeGray:
        state.stroke = grayHex(args[0]);
        break;
      case OPS.setFillCMYKColor:
        state.fill = cmykHex(args);
        break;
      case OPS.setStrokeCMYKColor:
        state.stroke = cmykHex(args);
        break;
      case OPS.setFillTransparent:
        state.fill = null;
        break;
      case OPS.setStrokeTransparent:
        state.stroke = null;
        break;
      case OPS.setFont:
        state.font = args[0];
        break;
      case OPS.setTextRenderingMode:
        state.mode = args[0];
        break;
      case OPS.showText:
      case OPS.showSpacedText:
      case OPS.nextLineShowText:
      case OPS.nextLineSetSpacingShowText: {
        const glyphs = args[args.length - 1];
        let text = '';
        if (Array.isArray(glyphs))
          for (const glyph of glyphs)
            if (glyph && typeof glyph === 'object') text += glyph.unicode || '';
        runs.push({
          text,
          fill: state.fill,
          stroke: state.stroke,
          mode: state.mode,
        });
        break;
      }
      case OPS.constructPath:
        if (args?.[0] !== OPS.endPath) addPath(args, state, view, rules, fills, vectors);
        break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageXObjectRepeat: {
        const m = mul(view, state.ctm);
        const corners = [apply(m, 0, 0), apply(m, 1, 0), apply(m, 0, 1), apply(m, 1, 1)];
        const xs = corners.map((p) => p[0]),
          ys = corners.map((p) => p[1]);
        images.push({
          id: fn === OPS.paintInlineImageXObject ? null : args[0],
          inline: fn === OPS.paintInlineImageXObject ? args[0] : null,
          x: Math.min(...xs),
          y: Math.min(...ys),
          w: Math.max(...xs) - Math.min(...xs),
          h: Math.max(...ys) - Math.min(...ys),
          rotated: Math.abs(m[1]) > 1e-3 * Math.abs(m[0]) || Math.abs(m[2]) > 1e-3 * Math.abs(m[3]),
          orientation: pictureOrientation(m),
        });
        break;
      }
    }
  }
  return { runs, rules, fills, images, vectors };
}

/**
 * How a picture is turned or mirrored where the page shows it, from its placement matrix (the
 * image's unit square onto the displayed page, y down): the directions on the page of its pixel
 * columns (`across`) and rows (`down`), or null when it is upright or turned by another angle.
 * Pages turned with /Rotate turn their pictures this way too.
 */
export function pictureOrientation(m) {
  const scale = Math.max(...m.slice(0, 4).map(Math.abs));
  const tiny = (v) => Math.abs(v) <= 1e-3 * scale;
  const straight = tiny(m[1]) && tiny(m[2]),
    sideways = tiny(m[0]) && tiny(m[3]);
  if (!scale || (!straight && !sideways)) return null;
  const sign = (v) => (v > 0 ? 1 : -1);
  // Rows run from the image's top (v = 1) down, against its v axis.
  const across = straight ? [sign(m[0]), 0] : [0, sign(m[1])];
  const down = straight ? [0, -sign(m[3])] : [-sign(m[2]), 0];
  return across[0] === 1 && down[1] === 1 ? null : { across, down };
}

/** Classify one constructed path into straight rules, filled boxes, or other vector art. */
function addPath(args, state, view, rules, fills, vectors) {
  const op = args[0],
    data = args[1]?.[0] ?? args[1];
  if (!data || typeof data.length !== 'number') return;
  const m = mul(view, state.ctm);
  const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
  const subpaths = [];
  let current = null;
  for (let i = 0; i < data.length;) {
    const code = data[i++];
    if (code === 0) {
      current = {
        points: [apply(m, data[i], data[i + 1])],
        curved: false,
        closed: false,
      };
      subpaths.push(current);
      i += 2;
    } else if (code === 1) {
      current?.points.push(apply(m, data[i], data[i + 1]));
      i += 2;
    } else if (code === 2) {
      if (current) {
        current.curved = true;
        current.points.push(apply(m, data[i + 4], data[i + 5]));
      }
      i += 6;
    } else if (code === 3) {
      if (current) {
        current.curved = true;
        current.points.push(apply(m, data[i + 2], data[i + 3]));
      }
      i += 4;
    } else if (code === 4) {
      if (current) current.closed = true;
    } else break;
  }
  const stroked = STROKES.has(op) && state.stroke,
    filled = FILLS.has(op) && state.fill;
  const lineWidth = Math.max(0.1, state.width * scale);
  for (const path of subpaths) {
    const pts = path.points;
    const xs = pts.map((p) => p[0]),
      ys = pts.map((p) => p[1]);
    const box = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    };
    const axisAligned =
      !path.curved &&
      pts.every((p, k) => {
        const q = pts[(k + 1) % pts.length];
        return Math.abs(p[0] - q[0]) < 0.5 || Math.abs(p[1] - q[1]) < 0.5;
      });
    const rect = axisAligned && pts.length >= 4 && pts.length <= 5;
    if (filled && rect) {
      if (box.h <= 2.5 && box.w > 3)
        rules.push({
          horizontal: true,
          x0: box.x,
          x1: box.x + box.w,
          y: box.y + box.h / 2,
          weight: box.h,
          color: state.fill,
        });
      else if (box.w <= 2.5 && box.h > 3)
        rules.push({
          horizontal: false,
          y0: box.y,
          y1: box.y + box.h,
          x: box.x + box.w / 2,
          weight: box.w,
          color: state.fill,
        });
      else if (box.w > 2.5 && box.h > 2.5)
        fills.push({
          ...box,
          color: state.fill,
          stroke: stroked ? state.stroke : null,
        });
    } else if (filled && !path.curved && box.w > 3 && box.h > 3) vectors.push(box);
    else if (filled && path.curved && box.w > 3 && box.h > 3) vectors.push(box);
    if (stroked && !path.curved) {
      const segments = pts.length;
      for (let k = 0; k < segments - (path.closed || rect ? 0 : 1); k++) {
        const p = pts[k],
          q = pts[(k + 1) % segments];
        if (Math.abs(p[1] - q[1]) < 0.5 && Math.abs(p[0] - q[0]) > 2)
          rules.push({
            horizontal: true,
            x0: Math.min(p[0], q[0]),
            x1: Math.max(p[0], q[0]),
            y: p[1],
            weight: lineWidth,
            color: state.stroke,
          });
        else if (Math.abs(p[0] - q[0]) < 0.5 && Math.abs(p[1] - q[1]) > 2)
          rules.push({
            horizontal: false,
            y0: Math.min(p[1], q[1]),
            y1: Math.max(p[1], q[1]),
            x: p[0],
            weight: lineWidth,
            color: state.stroke,
          });
      }
      if (rect && !filled && box.w > 2.5 && box.h > 2.5)
        fills.push({
          ...box,
          color: null,
          stroke: state.stroke,
          outline: true,
        });
    } else if (stroked && path.curved && box.w > 3 && box.h > 3) vectors.push(box);
  }
}

/**
 * Everything the exporter needs from one page: text spans with styles, ruling lines, filled
 * boxes and image placements (with their pictures).
 */
export async function readPage(pdf, page, { images, signal } = {}) {
  const viewport = page.getViewport({ scale: 1 });
  const view = viewport.transform;
  const content = await page.getTextContent();
  signal?.throwIfAborted();
  const list = await page.getOperatorList();
  signal?.throwIfAborted();
  const graphics = walkOperators(list, view);

  const fonts = new Map();
  const fontFor = (id) => {
    if (fonts.has(id)) return fonts.get(id);
    const style = content.styles?.[id] || {};
    let name = '';
    try {
      const object = page.commonObjs.has(id) ? page.commonObjs.get(id) : null;
      name = object?.name || object?.fallbackName || '';
    } catch {
      /* not loaded */
    }
    const info = {
      ...describeFont(name || style.fontFamily, style.fontFamily),
      style,
    };
    fonts.set(id, info);
    return info;
  };

  // Line text-content items up with the drawing runs to learn their colour and visibility.
  const norm = (s) => s.normalize('NFKC').replace(/\s+/g, '');
  let stream = '';
  const owners = [];
  graphics.runs.forEach((run, index) => {
    const text = norm(run.text);
    stream += text;
    for (let k = 0; k < text.length; k++) owners.push(index);
  });
  let cursor = 0;

  const spans = [];
  for (const item of content.items) {
    if (typeof item.str !== 'string' || !item.str) continue;
    const key = norm(item.str);
    let run = null;
    if (key) {
      const at = stream.indexOf(key, cursor);
      if (at >= 0 && at - cursor < 2000) {
        run = graphics.runs[owners[at]];
        cursor = at + key.length;
      }
    }
    if (!item.str.trim()) continue;
    const m = mul(view, item.transform);
    const size = Math.hypot(m[2], m[3]),
      scaleX = Math.hypot(m[0], m[1]);
    if (!(size > 0.5) || !(scaleX > 0)) continue;
    const font = fontFor(item.fontName);
    const ascent =
      Number.isFinite(font.style.ascent) && font.style.ascent > 0.4
        ? Math.min(1.1, font.style.ascent)
        : 0.8;
    const descent =
      Number.isFinite(font.style.descent) && font.style.descent < 0
        ? Math.min(0.4, -font.style.descent)
        : 0.2;
    const width = item.width;
    const upright =
      Math.abs(m[1]) < 0.02 * scaleX && Math.abs(m[2]) < 0.02 * size && m[0] > 0 && m[3] < 0;
    const mode = run?.mode ?? 0;
    const span = {
      text: item.str,
      size,
      font: font.family,
      bold: font.bold || mode === 2 || mode === 6,
      italic: font.italic,
      symbolic: font.symbolic,
      color: (mode === 1 || mode === 5 ? run?.stroke : run?.fill) || '000000',
      invisible: mode === 3 || mode === 7,
      rtl: item.dir === 'rtl',
      underline: false,
      strike: false,
    };
    if (upright) {
      span.x0 = m[4];
      span.x1 = m[4] + width;
      span.baseline = m[5];
      span.top = m[5] - ascent * size;
      span.bottom = m[5] + descent * size;
    } else {
      // Rotated text keeps its box and reading text; it is placed as its own paragraph.
      const dx = (m[0] / scaleX) * width,
        dy = (m[1] / scaleX) * width;
      const ux = (-m[2] / size) * size * ascent,
        uy = (-m[3] / size) * size * ascent;
      const pts = [
        [m[4], m[5]],
        [m[4] + dx, m[5] + dy],
        [m[4] + ux, m[5] + uy],
        [m[4] + dx + ux, m[5] + dy + uy],
      ];
      span.x0 = Math.min(...pts.map((p) => p[0]));
      span.x1 = Math.max(...pts.map((p) => p[0]));
      span.top = Math.min(...pts.map((p) => p[1]));
      span.bottom = Math.max(...pts.map((p) => p[1]));
      span.baseline = span.bottom;
      span.rotated = true;
    }
    spans.push(splitWideSpaces(span));
  }

  // Pictures: resolve each painted image to file bytes once.
  const placements = [];
  for (const image of graphics.images) {
    signal?.throwIfAborted();
    if (image.w < 4 || image.h < 4) continue;
    let picture = null;
    if (images) {
      try {
        picture = image.inline
          ? await images.inline(image.inline, image.orientation)
          : await images.resolve(page, image.id, image.orientation);
      } catch {
        picture = null;
      }
    }
    if (picture) placements.push({ ...image, picture });
  }
  return {
    index: page._pageIndex ?? page.pageNumber - 1,
    width: viewport.width,
    height: viewport.height,
    spans: spans.flat(),
    rules: graphics.rules,
    fills: graphics.fills,
    vectors: graphics.vectors,
    images: placements,
  };
}

/**
 * Split a text item where it spaces columns apart with runs of three or more spaces, or where
 * leader dots run to a page number ("Overview ........ 4").
 */
function splitWideSpaces(span) {
  if (span.rotated || !/\S\s{3,}\S|(?:\.\s?){4,}|…{2,}|_{4,}/.test(span.text)) return [span];
  const parts = [];
  const total = span.text.length,
    width = span.x1 - span.x0;
  const separator = /\s{3,}|\s*(?:\.\s?){4,}\s*|\s*…{2,}\s*|\s*_{4,}\s*/g;
  let at = 0,
    match,
    leader = false;
  const push = (end) => {
    const text = span.text.slice(at, end);
    const lead = text.length - text.trimStart().length;
    if (text.trim())
      parts.push({
        ...span,
        text: text.trim(),
        x0: span.x0 + (width * (at + lead)) / total,
        x1: span.x0 + (width * (at + lead + text.trim().length)) / total,
        afterLeader: leader,
      });
  };
  while ((match = separator.exec(span.text))) {
    if (match.index > 0) push(match.index);
    at = match.index + match[0].length;
    leader = /[._…]/.test(match[0]);
  }
  push(total);
  // A leader at the very end leads to whatever item comes next.
  if (parts.length && at >= total && leader) parts.at(-1).leaderAfter = true;
  return parts.length ? parts : [span];
}

/* ---------------------------------------------------------------- lines and chunks */

const LEADER = /(?:\s*[.·…_]){3,}\s*$/;
const CURRENCY = /^[$€£¥₹]$/;
const BULLETS = '•·◦▪▫■□●○‣⁃∙➢➤►▶✓✔❖♦◆◇-–—*';

/** Group spans into baseline-sharing lines, each split into chunks at wide gaps. */
export function buildLines(spans) {
  const sorted = [...spans].sort((a, b) => a.top - b.top || a.x0 - b.x0);
  const lines = [];
  for (const span of sorted) {
    if (span.rotated) {
      lines.push({ spans: [span], rotated: true });
      continue;
    }
    let home = null;
    for (let k = lines.length - 1; k >= 0 && k >= lines.length - 40; k--) {
      const line = lines[k];
      if (line.rotated) continue;
      const height = Math.min(line.bottom - line.top, span.bottom - span.top);
      const overlap = Math.min(line.bottom, span.bottom) - Math.max(line.top, span.top);
      if (overlap < 0.5 * height) continue;
      if (Math.abs(line.baseline - span.baseline) > 0.55 * Math.max(line.size, span.size)) continue;
      // Far apart on the line (another column), baselines must agree closely.
      const distance = Math.min(
        ...line.spans.map((other) => Math.max(other.x0 - span.x1, span.x0 - other.x1)),
      );
      if (
        distance > 1.5 * Math.max(line.size, span.size) &&
        Math.abs(line.baseline - span.baseline) > 0.12 * Math.max(line.size, span.size)
      )
        continue;
      const collides = line.spans.some((other) => {
        const across = Math.min(other.x1, span.x1) - Math.max(other.x0, span.x0);
        return across > 0.3 * Math.min(other.x1 - other.x0, span.x1 - span.x0) + 0.5;
      });
      if (collides) continue;
      home = line;
      break;
    }
    if (!home) {
      lines.push({
        spans: [span],
        top: span.top,
        bottom: span.bottom,
        baseline: span.baseline,
        size: span.size,
        weight: span.text.length,
      });
      continue;
    }
    home.spans.push(span);
    home.top = Math.min(home.top, span.top);
    home.bottom = Math.max(home.bottom, span.bottom);
    if (span.text.length > home.weight) {
      // The line's measure comes from its dominant (longest) text, not superscripts.
      if (span.size >= home.size * 0.8 || span.text.length > 3 * home.weight) {
        home.baseline = span.baseline;
        home.size = span.size;
      }
    }
    home.weight += span.text.length;
  }
  // Superscripts and subscripts that started lines of their own join the line they sit on.
  for (let k = lines.length - 1; k >= 0; k--) {
    const small = lines[k];
    if (small.rotated) continue;
    const size = Math.max(...small.spans.map((s) => s.size));
    const candidates = lines.filter(
      (line) =>
        line !== small &&
        !line.rotated &&
        line.size * 0.85 > size &&
        Math.min(line.bottom, small.bottom) - Math.max(line.top, small.top) >
          0.3 * (small.bottom - small.top) &&
        small.spans.every((s) =>
          line.spans.some((o) => Math.max(o.x0 - s.x1, s.x0 - o.x1) < 0.8 * line.size),
        ),
    );
    // Prefer the line it is raised above (a superscript), then the nearest baseline.
    const score = (line) =>
      Math.abs(small.baseline - (line.baseline - 0.35 * line.size)) / line.size;
    const home = candidates.sort((a, b) => score(a) - score(b))[0];
    if (!home) continue;
    home.spans.push(...small.spans);
    home.top = Math.min(home.top, small.top);
    home.bottom = Math.max(home.bottom, small.bottom);
    lines.splice(k, 1);
  }
  let id = 0;
  for (const line of lines) {
    line.id = id++;
    line.spans.sort((a, b) => a.x0 - b.x0);
    if (line.rotated) {
      const s = line.spans[0];
      Object.assign(line, {
        top: s.top,
        bottom: s.bottom,
        baseline: s.baseline,
        size: s.size,
      });
    }
    line.chunks = splitChunks(line);
    line.x0 = Math.min(...line.chunks.map((c) => c.x0));
    line.x1 = Math.max(...line.chunks.map((c) => c.x1));
  }
  return lines.filter((line) => line.chunks.length);
}

function splitChunks(line) {
  const chunks = [];
  let current = null;
  for (const span of line.spans) {
    const previous = current?.spans.at(-1);
    const gap = previous ? span.x0 - previous.x1 : 0;
    const size = previous ? Math.min(previous.size, span.size) : span.size;
    const leader =
      !!previous && (LEADER.test(previous.text) || previous.leaderAfter || span.afterLeader);
    // A currency sign after an amount starts the next column's amount ("615,404  $ 456,679").
    const currency =
      !!previous && CURRENCY.test(span.text.trim()) && !CURRENCY.test(previous.text.trim());
    if (!current || line.rotated || gap > 1.1 * size || leader || currency) {
      current = { spans: [span], line, leader: !!leader };
      chunks.push(current);
    } else current.spans.push(span);
  }
  for (const chunk of chunks) finishChunk(chunk);
  // Leader-only chunks ("......") vanish; the chunk after them remembers the leader.
  for (let k = 1; k < chunks.length; k++)
    if (!chunks[k - 1].text && chunks[k - 1].leaderOnly) chunks[k].leader = true;
  const kept = chunks.filter((c) => c.text);
  // A lone currency sign belongs with the amount after it ("$" + "615,404").
  for (let k = 0; k < kept.length - 1; k++) {
    if (CURRENCY.test(kept[k].text) && /^(?:[(\-−]?\d|[—–-]$)/.test(kept[k + 1].text)) {
      kept[k].spans.push(...kept[k + 1].spans);
      kept[k].currencyGap = true;
      kept.splice(k + 1, 1);
      finishChunk(kept[k]);
    }
  }
  return kept;
}

function finishChunk(chunk) {
  const runs = [];
  let text = '';
  const base = chunk.line.size;
  // Letter-spaced text ("Q U A R T E R") arrives one letter at a time; only the wider gaps
  // between its letters are word spaces.
  const gaps = chunk.spans.slice(1).map((span, k) => span.x0 - chunk.spans[k].x1);
  const letters = chunk.spans.filter((span) => span.text.trim().length === 1).length;
  const spaced = chunk.spans.length >= 4 && letters >= chunk.spans.length * 0.7;
  const letterGap = spaced ? median(gaps) : 0;
  // Words of right-to-left text, drawn one by one, read from the rightmost.
  const length = (spans) => spans.reduce((sum, span) => sum + span.text.trim().length, 0);
  const rtl = length(chunk.spans.filter((span) => span.rtl)) * 2 > length(chunk.spans);
  const order = rtl ? [...chunk.spans].reverse() : chunk.spans;
  for (let k = 0; k < order.length; k++) {
    const span = order[k];
    let piece = span.text.replace(/\s+/g, ' ');
    const previous = order[k - 1];
    if (previous) {
      const gap = rtl ? previous.x0 - span.x1 : span.x0 - previous.x1;
      if (
        gap - letterGap > 0.12 * Math.min(span.size, previous.size) &&
        !/\s$/.test(text) &&
        !/^\s/.test(piece)
      )
        piece = ' ' + piece;
    }
    text += piece;
    const script =
      span.size < base * 0.85 && span.baseline < chunk.line.baseline - base * 0.12
        ? 'superscript'
        : span.size < base * 0.85 && span.baseline > chunk.line.baseline + base * 0.12
          ? 'subscript'
          : null;
    const style = {
      font: span.font,
      size: Math.round((script ? base * 0.66 : span.size) * 2) / 2,
      bold: span.bold,
      italic: span.italic,
      underline: span.underline,
      strike: span.strike,
      color: span.color,
      script,
    };
    const last = runs.at(-1);
    if (last && sameStyle(last, style)) last.text += piece;
    else runs.push({ text: piece, ...style });
  }
  // Leader dots fill the way to the next column; they are layout, not content.
  if (LEADER.test(text)) {
    chunk.leaderOnly = !text.replace(LEADER, '').trim();
    let strip = text.match(LEADER)[0].length;
    text = text.slice(0, -strip);
    while (strip > 0 && runs.length) {
      const last = runs.at(-1);
      const cut = Math.min(strip, last.text.length);
      last.text = last.text.slice(0, last.text.length - cut);
      strip -= cut;
      if (!last.text) runs.pop();
    }
  }
  if (runs.length) {
    runs[0].text = runs[0].text.replace(/^\s+/, '');
    runs.at(-1).text = runs.at(-1).text.replace(/\s+$/, '');
  }
  chunk.runs = runs.filter((r) => r.text);
  chunk.text = text.trim();
  chunk.x0 = chunk.spans[0].x0;
  chunk.x1 = Math.max(...chunk.spans.map((s) => s.x1));
  chunk.top = Math.min(...chunk.spans.map((s) => s.top));
  chunk.bottom = Math.max(...chunk.spans.map((s) => s.bottom));
  chunk.size = chunk.line.size;
  chunk.bold = chunk.runs.length > 0 && chunk.runs.every((r) => r.bold || !r.text.trim());
}

const sameStyle = (a, b) =>
  a.font === b.font &&
  Math.abs(a.size - b.size) < 0.3 &&
  a.bold === b.bold &&
  a.italic === b.italic &&
  a.underline === b.underline &&
  a.strike === b.strike &&
  a.color === b.color &&
  a.script === b.script;

/** Thin horizontal rules hugging a span's baseline are underlines (or strike-throughs). */
function markDecorations(spans, rules) {
  const lines = rules.filter((r) => r.horizontal && r.weight <= 3);
  return lines.length ? spans.flatMap((span) => decorate(span, lines)) : spans;
}

/** Mark a span underlined or struck through, splitting it where a rule covers only part. */
function decorate(span, rules) {
  if (span.rotated) return [span];
  const size = span.size,
    width = span.x1 - span.x0;
  for (const rule of rules) {
    const below = rule.y - span.baseline;
    const kind =
      below >= -0.05 * size && below <= 0.3 * size
        ? 'underline'
        : below < -0.2 * size && below > -0.45 * size
          ? 'strike'
          : null;
    if (!kind || span[kind]) continue;
    const a = Math.max(rule.x0, span.x0),
      b = Math.min(rule.x1, span.x1);
    if (b - a < Math.min(width * 0.8, size * 0.5)) continue;
    // A rule running far past the text is a table or section rule, not an underline.
    if (rule.x1 - rule.x0 > width + 3 * size) continue;
    if (a <= span.x0 + width * 0.1 && b >= span.x1 - width * 0.1) {
      span[kind] = true;
      rule.used = true;
      continue;
    }
    // Part of the item: split at the nearest word boundaries (by character position).
    const n = span.text.length;
    const index = (x) => Math.max(0, Math.min(n, Math.round(((x - span.x0) / width) * n)));
    const snap = (k) => {
      for (const d of [0, 1, -1, 2, -2, 3, -3]) {
        const at = k + d;
        if (at <= 0 || at >= n) return Math.max(0, Math.min(n, at));
        if (span.text[at] === ' ' || span.text[at - 1] === ' ') return at;
      }
      return k;
    };
    const from = snap(index(a)),
      to = snap(index(b));
    if (to - from < 1) continue;
    rule.used = true;
    return [
      [0, from],
      [from, to],
      [to, n],
    ]
      .filter(([p, q]) => q > p && span.text.slice(p, q).trim())
      .map(([p, q]) => ({
        ...span,
        text: span.text.slice(p, q),
        x0: span.x0 + (width * p) / n,
        x1: span.x0 + (width * q) / n,
        [kind]: p === from && q === to,
      }))
      .flatMap((part) => decorate(part, rules));
  }
  return [span];
}

/* ---------------------------------------------------------------- ruled tables */

function cluster(values, tolerance) {
  const sorted = [...values].sort((a, b) => a - b);
  const groups = [];
  for (const v of sorted) {
    const last = groups.at(-1);
    if (last && v - last.at(-1) <= tolerance) last.push(v);
    else groups.push([v]);
  }
  return groups.map((g) => g.reduce((s, v) => s + v, 0) / g.length);
}

/** Grids of horizontal and vertical rules that enclose text become tables. */
function findRuledTables(rules, fills, spans) {
  const lines = rules.filter((r) => !r.used);
  // Outlines of filled boxes also delimit cells.
  const tol = 2;
  const parent = lines.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const touches = (h, v) =>
    v.x >= h.x0 - tol && v.x <= h.x1 + tol && h.y >= v.y0 - tol && h.y <= v.y1 + tol;
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i],
        b = lines[j];
      if (
        a.horizontal !== b.horizontal ? touches(a.horizontal ? a : b, a.horizontal ? b : a) : false
      )
        parent[find(i)] = find(j);
    }
  const groups = new Map();
  lines.forEach((line, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(line);
  });
  const tables = [];
  for (const group of groups.values()) {
    const hs = group.filter((r) => r.horizontal),
      vs = group.filter((r) => !r.horizontal);
    if (hs.length < 2 || vs.length < 2) continue;
    const ys = cluster(
      hs.map((r) => r.y),
      2.5,
    );
    const xs = cluster(
      vs.map((r) => r.x),
      2.5,
    );
    if (ys.length < 2 || xs.length < 2 || (ys.length - 1) * (xs.length - 1) < 2) continue;
    const box = { x0: xs[0], x1: xs.at(-1), y0: ys[0], y1: ys.at(-1) };
    if (box.x1 - box.x0 < 20 || box.y1 - box.y0 < 8) continue;
    const inside = spans.filter((s) => !s.rotated && contains(box, s));
    if (!inside.length) continue;
    const hasV = (x, y) =>
      vs.some((v) => Math.abs(v.x - x) <= tol + v.weight && y >= v.y0 - tol && y <= v.y1 + tol);
    const hasH = (y, x) =>
      hs.some((h) => Math.abs(h.y - y) <= tol + h.weight && x >= h.x0 - tol && x <= h.x1 + tol);
    const rows = [];
    const owner = [];
    for (let r = 0; r < ys.length - 1; r++) {
      const mid = (ys[r] + ys[r + 1]) / 2;
      owner.push([]);
      const cells = [];
      for (let c = 0; c < xs.length - 1;) {
        let end = c + 1;
        while (end < xs.length - 1 && !hasV(xs[end], mid)) end++;
        cells.push({
          col: c,
          span: end - c,
          x0: xs[c],
          x1: xs[end],
          y0: ys[r],
          y1: ys[r + 1],
        });
        c = end;
      }
      rows.push({ y: ys[r], h: ys[r + 1] - ys[r], cells });
    }
    // Vertically merged cells: no rule between a cell and the one below it.
    for (let r = 1; r < rows.length; r++) {
      for (const cell of rows[r].cells) {
        const above = rows[r - 1].cells.find((c) => c.col === cell.col && c.span === cell.span);
        if (!above) continue;
        if (!hasH(ys[r], (cell.x0 + cell.x1) / 2)) {
          const first = above.mergedInto || above;
          cell.mergedInto = first;
          first.rowSpan = (first.rowSpan || 1) + 1;
        }
      }
    }
    for (const span of inside) {
      const cx = (span.x0 + Math.min(span.x1, span.x0 + span.size * 2)) / 2,
        cy = (span.top + span.bottom) / 2;
      for (const row of rows) {
        if (cy < row.y || cy > row.y + row.h) continue;
        const cell = row.cells.find((c) => cx >= c.x0 && cx <= c.x1) || row.cells.at(-1);
        const target = cell.mergedInto || cell;
        (target.spans ||= []).push(span);
        break;
      }
      span.consumed = true;
    }
    for (const row of rows)
      for (const cell of row.cells) {
        const fill = fills.find(
          (f) =>
            f.color &&
            f.x <= cell.x0 + 2 &&
            f.x + f.w >= cell.x1 - 2 &&
            f.y <= cell.y0 + 2 &&
            f.y + f.h >= cell.y1 - 2 &&
            f.w * f.h < (box.x1 - box.x0) * (box.y1 - box.y0) * 0.9,
        );
        if (fill && fill.color !== 'FFFFFF') cell.fill = fill.color;
        cell.paragraphs = cellParagraphs(cell.spans || [], cell);
      }
    for (const rule of group) rule.used = true;
    tables.push({
      type: 'table',
      ruled: true,
      x: box.x0,
      y: box.y0,
      w: box.x1 - box.x0,
      h: box.y1 - box.y0,
      columns: xs,
      rows: rows.map((row, r) => ({
        y: row.y,
        h: row.h,
        header:
          r === 0 &&
          row.cells.every(
            (c) => !c.paragraphs.length || c.paragraphs.every((p) => p.runs.every((x) => x.bold)),
          ),
        cells: row.cells.map((c) => ({
          col: c.col,
          span: c.span,
          rowSpan: c.rowSpan,
          merged: !!c.mergedInto,
          fill: c.fill,
          align: c.paragraphs[0]?.align || 'left',
          paragraphs: c.mergedInto ? [] : c.paragraphs,
          x0: c.x0,
          x1: c.x1,
        })),
      })),
    });
  }
  return tables;
}

const contains = (box, s) => {
  const cx = (s.x0 + s.x1) / 2,
    cy = (s.top + s.bottom) / 2;
  return cx >= box.x0 - 1 && cx <= box.x1 + 1 && cy >= box.y0 - 1 && cy <= box.y1 + 1;
};

function cellParagraphs(spans, cell) {
  if (!spans.length) return [];
  const lines = buildLines(spans);
  const paragraphs = [];
  let current = null;
  for (const line of lines) {
    const runs = lineRuns(line);
    const startsList = listMarker(line.chunks[0].text);
    if (current && !startsList && line.top - current.bottom < line.size * 0.8) {
      const last = current.runs.at(-1);
      if (last && !/[\s-]$/.test(last.text)) last.text += ' ';
      current.runs.push(...runs);
      current.bottom = line.bottom;
      current.x1 = Math.max(current.x1, line.x1);
      current.x0 = Math.min(current.x0, line.x0);
    } else {
      current = {
        runs: [...runs],
        bottom: line.bottom,
        x0: line.x0,
        x1: line.x1,
      };
      paragraphs.push(current);
    }
  }
  return paragraphs.map((p) => {
    const left = p.x0 - cell.x0,
      right = cell.x1 - p.x1;
    const align =
      Math.abs(left - right) < 3 && left > 4
        ? 'center'
        : right < left - 4 && right < 8
          ? 'right'
          : 'left';
    return { runs: mergeRuns(p.runs), align };
  });
}

/* ---------------------------------------------------------------- lists */

const ROMAN = /^(?=[ivxlc]+$)c{0,3}(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/i;
function romanValue(s) {
  const map = { i: 1, v: 5, x: 10, l: 50, c: 100 };
  let total = 0;
  const t = s.toLowerCase();
  for (let k = 0; k < t.length; k++) {
    const v = map[t[k]],
      next = map[t[k + 1]] || 0;
    total += v < next ? -v : v;
  }
  return total;
}

/** The list marker a line begins with, if any. */
export function listMarker(text, symbolic = false) {
  const t = String(text || '');
  const bullet =
    /^([•·◦▪▫■□●○‣⁃∙➢➤►▶✓✔❖♦◆◇])\s*(?=\S)/u.exec(t) || /^([-–—*])\s+(?=\S)/.exec(t);
  if (bullet) return { kind: 'bullet', marker: bullet[1], length: bullet[0].length };
  if (symbolic && t.length && t.length <= 2)
    return { kind: 'bullet', marker: '•', length: t.length };
  const number =
    /^(\(?)(\d{1,3}|[a-zA-Z]|[ivxlcIVXLC]{1,6})([.)])\s+(?=\S)/.exec(t) ||
    /^(\()(\d{1,3}|[a-zA-Z]|[ivxlcIVXLC]{1,6})(\))\s+(?=\S)/.exec(t);
  if (number) {
    const [whole, open, value, close] = number;
    if (open && close !== ')') return null;
    let kind, n;
    if (/^\d+$/.test(value)) {
      kind = 'decimal';
      n = +value;
    } else if (value.length > 1 || /^[ivx]$/i.test(value)) {
      if (!ROMAN.test(value)) return null;
      kind = value === value.toLowerCase() ? 'lowerRoman' : 'upperRoman';
      n = romanValue(value);
    } else {
      kind = value === value.toLowerCase() ? 'lowerLetter' : 'upperLetter';
      n = value.toLowerCase().charCodeAt(0) - 96;
    }
    return {
      kind,
      value: n,
      pattern: `${open}%1${close}`,
      marker: whole.trim(),
      length: whole.length,
    };
  }
  return null;
}

/* ---------------------------------------------------------------- reading order */

const elementBox = (e) => ({ x0: e.x0, x1: e.x1, y0: e.top, y1: e.bottom });

/** Free x intervals inside [lo, hi] that no item of `items` covers, at least `min` wide. */
function xFree(items, lo, hi, min) {
  const spans = items.map((e) => [e.x0, e.x1]).sort((a, b) => a[0] - b[0]);
  const free = [];
  let reach = lo;
  for (const [a, b] of spans) {
    if (a - reach >= min) free.push([reach, a]);
    reach = Math.max(reach, b);
  }
  if (hi - reach >= min) free.push([reach, hi]);
  return free;
}

function proseSide(items, pageWidth) {
  const chunks = items.filter((e) => e.kind === 'chunk');
  const lines = new Set(chunks.map((c) => c.line.id));
  if (lines.size < 3) return false;
  return median(chunks.map((c) => c.x1 - c.x0)) >= pageWidth * 0.17;
}

/** Order page elements: column bands left to right, everything else top to bottom. */
function orderElements(items, column, pageWidth, bodySize, bands, depth = 0) {
  if (!items.length) return [];
  const leaf = (list) => ({ items: list, column, band: null });
  if (depth > 6 || items.length < 6) return [leaf(items)];
  const minGutter = Math.max(7, bodySize * 0.7);
  // Horizontal slices at vertical whitespace.
  const sorted = [...items].sort((a, b) => a.top - b.top);
  const slices = [];
  let reach = -Infinity;
  for (const item of sorted) {
    if (!slices.length || item.top > reach - 0.5) slices.push([item]);
    else slices.at(-1).push(item);
    reach = Math.max(reach, item.bottom);
  }
  const out = [];
  let pending = [];
  const flush = () => {
    if (pending.length) out.push(leaf(pending));
    pending = [];
  };
  for (let i = 0; i < slices.length;) {
    // Grow a band of slices that share a gutter, then check both sides read as prose.
    let gutters = items.length > 4000 ? [] : xFree(slices[i], column.x0, column.x1, minGutter);
    let j = i;
    while (gutters.length && j + 1 < slices.length) {
      const next = xFree(slices[j + 1], column.x0, column.x1, minGutter);
      const narrowed = gutters
        .map(([a, b]) => {
          const hit = next.find(([c, d]) => Math.min(b, d) - Math.max(a, c) >= minGutter);
          return hit ? [Math.max(a, hit[0]), Math.min(b, hit[1])] : null;
        })
        .filter(Boolean);
      if (!narrowed.length) break;
      gutters = narrowed;
      j++;
    }
    let best = null;
    if (gutters.length && j > i) {
      const band = slices.slice(i, j + 1).flat();
      for (const [a, b] of gutters) {
        const left = band.filter((e) => e.x1 <= a + 0.5),
          right = band.filter((e) => e.x0 >= b - 0.5);
        if (
          left.length + right.length === band.length &&
          proseSide(left, pageWidth) &&
          proseSide(right, pageWidth)
        )
          if (!best || b - a > best.gap[1] - best.gap[0]) best = { j, gap: [a, b], left, right };
      }
    }
    if (!best) {
      pending.push(...slices[i]);
      i++;
      continue;
    }
    flush();
    const id = bands.count++;
    const leftColumn = {
      x0: Math.min(...best.left.map((e) => e.x0)),
      x1: best.gap[0],
    };
    const rightColumn = {
      x0: best.gap[1],
      x1: Math.max(...best.right.map((e) => e.x1)),
    };
    const leftLeaves = orderElements(best.left, leftColumn, pageWidth, bodySize, bands, depth + 1);
    const rightLeaves = orderElements(
      best.right,
      rightColumn,
      pageWidth,
      bodySize,
      bands,
      depth + 1,
    );
    const gap = best.gap[1] - best.gap[0];
    for (const l of leftLeaves)
      l.band ||= {
        id,
        count: 2,
        index: 0,
        gap,
        left: leftColumn,
        right: rightColumn,
      };
    for (const l of rightLeaves)
      l.band ||= {
        id,
        count: 2,
        index: 1,
        gap,
        left: leftColumn,
        right: rightColumn,
      };
    out.push(...leftLeaves, ...rightLeaves);
    i = best.j + 1;
  }
  flush();
  return out;
}

/* ---------------------------------------------------------------- aligned tables */

const isMulti = (line) => line.chunks.length >= 2;

/** Rows of text whose chunks line up in columns become a table. */
function findAlignedTables(lines, column) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (!isMulti(lines[i]) || lines[i].rotated) {
      out.push(lines[i++]);
      continue;
    }
    // Extend over multi-chunk lines, allowing single label lines between them.
    let j = i,
      multi = 0,
      last = i;
    while (j < lines.length) {
      const line = lines[j];
      if (line.rotated) break;
      const prev = lines[j - 1];
      if (j > i && line.top - prev.bottom > Math.max(prev.size, line.size) * 2.2) break;
      if (isMulti(line)) {
        multi++;
        last = j;
      } else {
        // Label lines (section titles, wrapped row labels) may sit between rows when a row
        // follows within three lines.
        const chunk = line.chunks[0];
        const wide = chunk.x1 - chunk.x0 > (column.x1 - column.x0) * 0.7 && chunk.text.length > 60;
        if (wide) break;
        let k = j + 1,
          found = false;
        while (k < lines.length && k <= j + 3) {
          const next = lines[k];
          if (next.rotated || next.top - lines[k - 1].bottom > next.size * 2.2) break;
          if (isMulti(next)) {
            found = true;
            break;
          }
          const c = next.chunks[0];
          if (c.x1 - c.x0 > (column.x1 - column.x0) * 0.7 && c.text.length > 60) break;
          k++;
        }
        if (!found) break;
      }
      j++;
    }
    const rowsLines = lines.slice(i, last + 1);
    const table = multi >= 2 ? alignedTable(rowsLines, column) : null;
    if (table) {
      out.push(table);
      i = last + 1;
    } else out.push(lines[i++]);
  }
  return out;
}

function alignedTable(lines, column) {
  const multi = lines.filter(isMulti);
  const maxChunks = Math.max(...multi.map((l) => l.chunks.length));
  // Prose with justified gaps rarely aligns; long chunks in two columns are text columns.
  const allChunks = multi.flatMap((l) => l.chunks);
  const avgLength = allChunks.reduce((n, c) => n + c.text.length, 0) / allChunks.length;
  if (maxChunks === 2 && avgLength > 45) return null;
  if (multi.length < 3 && maxChunks < 3) return null;
  // Contents pages (leader dots) and lists with markers in their own column are not tables.
  const leaderRows = multi.filter((l) => l.chunks.some((c) => c.leader));
  if (leaderRows.length && Math.max(...leaderRows.map((l) => l.chunks.length)) <= 2) return null;
  const marked = multi.filter((l) => {
    const m = listMarker(l.chunks[0].text + ' x');
    return m && m.length >= l.chunks[0].text.length;
  });
  if (marked.length >= multi.length * 0.6) return null;
  // Two columns of entries and page numbers read better as a contents list with tab stops.
  if (
    maxChunks === 2 &&
    multi.length >= 3 &&
    multi.every((l) => l.chunks.length < 2 || /^\d{1,4}$/.test(l.chunks.at(-1).text))
  )
    return null;
  // Column intervals from the fullest rows, merged where they overlap.
  const body = multi.filter((l) => l.chunks.length >= Math.max(2, maxChunks - 1));
  let intervals = body.flatMap((l) => l.chunks.map((c) => [c.x0, c.x1]));
  intervals.sort((a, b) => a[0] - b[0]);
  const cols = [];
  for (const [a, b] of intervals) {
    const last = cols.at(-1);
    if (last && a <= last[1] - 0.5) last[1] = Math.max(last[1], b);
    else cols.push([a, b]);
  }
  if (cols.length < 2) return null;
  // Every chunk of every row must fit columns; too many straddlers means this is not a table.
  let straddle = 0,
    total = 0;
  const assign = (chunk) => {
    const hits = [];
    cols.forEach(([a, b], k) => {
      const overlap = Math.min(b, chunk.x1) - Math.max(a, chunk.x0);
      if (overlap > Math.min(2, (chunk.x1 - chunk.x0) / 2)) hits.push(k);
    });
    if (!hits.length) {
      // In a gap: nearest column by centre.
      const cx = (chunk.x0 + chunk.x1) / 2;
      let best = 0;
      cols.forEach(([a, b], k) => {
        if (Math.abs((a + b) / 2 - cx) < Math.abs((cols[best][0] + cols[best][1]) / 2 - cx))
          best = k;
      });
      hits.push(best);
    }
    return hits;
  };
  const rows = lines.map((line) => {
    const cells = [];
    for (const chunk of line.chunks) {
      const hits = assign(chunk);
      total++;
      if (hits.length > 1) straddle++;
      const col = hits[0],
        span = hits.at(-1) - hits[0] + 1;
      const existing = cells.find((c) => col < c.col + c.span && c.col < col + span);
      if (existing) {
        existing.chunks.push(chunk);
        const end = Math.max(existing.col + existing.span, col + span);
        existing.col = Math.min(existing.col, col);
        existing.span = end - existing.col;
      } else cells.push({ col, span, chunks: [chunk] });
    }
    cells.sort((a, b) => a.col - b.col);
    return { line, cells };
  });
  if (straddle > total * 0.25) return null;
  const columns = [Math.min(cols[0][0], ...lines.map((l) => l.x0)) - 2];
  for (let k = 1; k < cols.length; k++) columns.push((cols[k - 1][1] + cols[k][0]) / 2);
  columns.push(Math.max(cols.at(-1)[1], ...lines.map((l) => l.x1)) + 2);
  const x = columns[0],
    w = columns.at(-1) - x;
  const built = rows.map(({ line, cells }, r) => buildAlignedRow(line, cells, r, columns, cols));
  // A label that wraps onto the next row's first cell ("…attributable to common" /
  // "stockholders – basic") joins that cell.
  for (let r = built.length - 2; r >= 0; r--) {
    const row = built[r],
      next = built[r + 1];
    const only = row.cells.filter((c) => c.paragraphs.length);
    const first = next.cells[0];
    if (only.length !== 1 || only[0].col !== 0 || !first?.paragraphs.length || first.col !== 0)
      continue;
    const head = first.paragraphs[0].runs[0]?.text || '';
    const label = only[0].paragraphs[0].runs;
    const continues =
      /^[a-z(]/.test(head) ||
      /(?:\b(?:of|and|or|to|the|in|for|on|with|as|by)|[–-])$/i.test(
        label
          .map((x) => x.text)
          .join('')
          .trim(),
      );
    if (!continues || next.cells.filter((c) => c.paragraphs.length).length < 2) continue;
    const joined = mergeRuns([
      ...label.map((x) => ({ ...x })),
      { ...label.at(-1), text: ' ' },
      ...first.paragraphs[0].runs,
    ]);
    first.paragraphs[0] = { ...first.paragraphs[0], runs: joined };
    next.y = row.y;
    next.h += row.h;
    built.splice(r, 1);
  }
  return {
    type: 'table',
    ruled: false,
    x,
    y: lines[0].top,
    w,
    h: lines.at(-1).bottom - lines[0].top,
    columns,
    sourceLines: lines,
    rows: built,
  };
}

function buildAlignedRow(line, cells, r, columns, cols) {
  const filled = [];
  let at = 0;
  for (const cell of cells) {
    if (cell.col > at)
      filled.push({
        col: at,
        span: cell.col - at,
        paragraphs: [],
        align: 'left',
      });
    const x0 = columns[cell.col],
      x1 = columns[cell.col + cell.span];
    const c0 = Math.min(...cell.chunks.map((c) => c.x0)),
      c1 = Math.max(...cell.chunks.map((c) => c.x1));
    const left = c0 - x0,
      right = x1 - c1;
    const numeric = /^[\s$€£¥(\-−+]*[\d.,]+[)%]?\s*%?$/.test(
      cell.chunks.map((c) => c.text).join(' '),
    );
    const align =
      cell.span > 1 && Math.abs(left - right) < Math.max(6, (x1 - x0) * 0.15)
        ? 'center'
        : right < left || numeric
          ? 'right'
          : 'left';
    const runs = [];
    for (const chunk of cell.chunks) {
      if (runs.length) runs.push({ ...runs.at(-1), text: ' ' });
      runs.push(...chunk.runs.map((run) => ({ ...run })));
    }
    // Short leaders ("Lending..") left over from a dot run end the label.
    if (runs.length) runs[runs.length - 1].text = runs.at(-1).text.replace(/\s*\.{2,}$/, '');
    filled.push({
      col: cell.col,
      span: cell.span,
      align,
      paragraphs: [{ runs: mergeRuns(runs), align }],
    });
    at = cell.col + cell.span;
  }
  if (at < cols.length)
    filled.push({
      col: at,
      span: cols.length - at,
      paragraphs: [],
      align: 'left',
    });
  const nonEmpty = filled.filter((c) => c.paragraphs.length);
  return {
    y: line.top,
    h: line.bottom - line.top,
    header: r === 0 && nonEmpty.every((c) => c.paragraphs[0].runs.every((run) => run.bold)),
    cells: filled,
  };
}

/* ---------------------------------------------------------------- paragraphs */

const lineRuns = (line) => {
  const runs = [];
  line.chunks.forEach((chunk, k) => {
    if (k) runs.push({ ...chunk.runs[0], text: '\t', tab: true });
    runs.push(...chunk.runs.map((r) => ({ ...r })));
  });
  return runs;
};

function mergeRuns(runs) {
  const out = [];
  for (const run of runs) {
    const last = out.at(-1);
    if (last && !run.tab && !last.tab && !run.brk && sameStyle(last, run)) last.text += run.text;
    else out.push({ ...run });
  }
  return out.filter((r) => r.text);
}

const dominant = (line) => {
  const counts = new Map();
  for (const chunk of line.chunks)
    for (const run of chunk.runs) {
      const key = `${run.font}|${run.bold}|${run.italic}|${run.color}`;
      counts.set(key, (counts.get(key) || 0) + run.text.length);
    }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
};

/** Where the text after a list marker of `length` characters starts within a chunk. */
function markerEnd(chunk, length) {
  let left = length;
  for (let k = 0; k < chunk.spans.length; k++) {
    const span = chunk.spans[k];
    const text = span.text.replace(/\s+/g, ' ');
    const lead = k === 0 ? text.length - text.trimStart().length : 0;
    const usable = text.length - lead;
    if (left < usable) {
      // Inside this span: skip the marker and the spaces after it, then estimate by characters.
      const rest = text.slice(lead + left);
      const skip = rest.length - rest.trimStart().length;
      return span.x0 + ((span.x1 - span.x0) * (lead + left + skip)) / Math.max(1, text.length);
    }
    left -= usable;
    if (left <= 0) return chunk.spans[k + 1]?.x0 ?? span.x1;
    // A space between spans counts towards the marker match.
    left = Math.max(0, left - 1);
    if (left === 0) return chunk.spans[k + 1]?.x0 ?? span.x1;
  }
  return chunk.x1;
}

/** Join consecutive lines that read as one paragraph. */
function groupParagraphs(lines, column) {
  const paragraphs = [];
  let current = null;
  const width = column.x1 - column.x0;
  for (const line of lines) {
    const first = line.chunks[0];
    const symbolic = first.spans[0].symbolic && first.text.length <= 2;
    let marker = line.rotated ? null : listMarker(first.text, symbolic);
    if (!marker && !line.rotated && line.chunks.length > 1) {
      const alone = listMarker(first.text + ' x', symbolic);
      if (alone && alone.length >= first.text.length) marker = alone;
    }
    if (
      !marker &&
      !line.rotated &&
      first.spans[0].symbolic &&
      first.spans[0].text.trim().length <= 2 &&
      first.spans.length > 1
    )
      marker = {
        kind: 'bullet',
        marker: '•',
        length: first.spans[0].text.trim().length,
      };
    // A marker standing alone before a wide gap ("•      text") joins its text as a list item.
    let chunks = line.chunks;
    let textX = first.x0;
    if (marker && first.text.length <= marker.length + 1 && chunks.length > 1) {
      textX = chunks[1].x0;
      chunks = [{ ...chunks[1], runs: chunks[1].runs, x0: first.x0 }, ...chunks.slice(2)];
      marker = { ...marker, separate: true };
    } else if (marker) textX = markerEnd(first, marker.length);
    const tabbed = !marker && chunks.length > 1;
    const style = dominant(line);
    if (current) {
      const prev = current.lines.at(-1);
      const pitch = line.baseline - prev.baseline;
      const sameSize = Math.abs(line.size - current.size) < 0.6;
      const leading = current.leading;
      const leftEdge =
        current.lines.length > 1 ? current.lines[1].x0 : (current.textX ?? current.x0);
      const aligned =
        Math.abs(line.x0 - leftEdge) < Math.max(3, line.size * 0.5) ||
        (current.lines.length === 1 &&
          !current.list &&
          line.x0 < current.x0 - 1 &&
          current.x0 - line.x0 < line.size * 4) ||
        // Centred or right-aligned lines away from the column's left edge.
        (Math.min(line.x0, prev.x0) - column.x0 > width * 0.05 &&
          (Math.abs((line.x0 + line.x1) / 2 - (prev.x0 + prev.x1) / 2) < 4 ||
            Math.abs(line.x1 - prev.x1) < 3));
      const prevShort =
        prev.x1 < current.right - Math.max(line.size * 3, width * 0.12) && !current.centered;
      const endsSentence = /[.:!?)"”]$/.test(prev.chunks.at(-1).text);
      if (
        !marker &&
        !tabbed &&
        !current.tabbed &&
        !line.rotated &&
        !current.rotated &&
        sameSize &&
        style === current.style &&
        pitch > 0 &&
        pitch < line.size * 1.75 &&
        (!leading || Math.abs(pitch - leading) < line.size * 0.25) &&
        aligned &&
        !(prevShort && endsSentence)
      ) {
        current.lines.push(line);
        current.leading = current.leading
          ? (current.leading * (current.lines.length - 2) + pitch) / (current.lines.length - 1)
          : pitch;
        current.right = Math.max(current.right, line.x1);
        current.x0 = Math.min(current.x0, line.x0);
        continue;
      }
    }
    current = {
      lines: [line],
      chunks,
      marker,
      textX,
      tabbed,
      rotated: line.rotated,
      size: line.size,
      style,
      x0: line.x0,
      right: line.x1,
      leading: 0,
      list: marker ? marker : null,
      centered: false,
    };
    const center = (line.x0 + line.x1) / 2;
    current.centered =
      Math.abs(center - (column.x0 + column.x1) / 2) < Math.max(3, width * 0.03) &&
      line.x0 - column.x0 > width * 0.08;
    paragraphs.push(current);
  }
  return paragraphs.map((p) => finishParagraph(p, column));
}

function finishParagraph(p, column) {
  const runs = [];
  p.lines.forEach((line, k) => {
    let lineRunsList;
    if (k === 0) {
      lineRunsList = [];
      p.chunks.forEach((chunk, n) => {
        if (n) lineRunsList.push({ ...chunk.runs[0], text: '\t', tab: true });
        lineRunsList.push(...chunk.runs.map((r) => ({ ...r })));
      });
      if (p.marker && !p.marker.separate) {
        // Drop the marker characters from the text.
        let strip = p.marker.length;
        while (strip > 0 && lineRunsList.length) {
          const r = lineRunsList[0];
          const cut = Math.min(strip, r.text.length);
          r.text = r.text.slice(cut);
          strip -= cut;
          if (!r.text) lineRunsList.shift();
        }
        if (lineRunsList[0]) lineRunsList[0].text = lineRunsList[0].text.replace(/^\s+/, '');
      }
    } else {
      lineRunsList = lineRuns(line);
      // Remember where the PDF broke the line, for writers that keep line breaks.
      if (lineRunsList[0]) lineRunsList[0] = { ...lineRunsList[0], brk: true };
      const last = runs.at(-1);
      if (last) {
        // Rejoin words hyphenated across the line break; otherwise lines meet with a space.
        if (/[a-z]-$/.test(last.text) && /^[a-z]/.test(lineRunsList[0]?.text || '')) {
          last.text = last.text.slice(0, -1);
          lineRunsList[0].hyphen = true;
        } else if (!/\s$/.test(last.text)) last.text += ' ';
      }
    }
    runs.push(...lineRunsList);
  });
  const first = p.lines[0],
    lastLine = p.lines.at(-1);
  const x0 = Math.min(...p.lines.map((l) => l.x0)),
    x1 = Math.max(...p.lines.map((l) => l.x1));
  const width = column.x1 - column.x0;
  // Alignment.
  let align = 'left';
  const lefts = p.lines.map((l) => l.x0),
    rights = p.lines.map((l) => l.x1),
    centers = p.lines.map((l) => (l.x0 + l.x1) / 2);
  const spread = (v) => Math.max(...v) - Math.min(...v);
  const tol = Math.max(2, first.size * 0.25);
  if (p.tabbed || p.chunks.length > 1) align = 'left';
  else if (p.lines.length >= 2) {
    const body = p.lines.slice(0, -1);
    if (
      spread(lefts.slice(1)) < tol &&
      spread(body.map((l) => l.x1)) < tol &&
      body.length >= 1 &&
      column.x1 - body[0].x1 < width * 0.08 &&
      p.lines.length >= 3
    )
      align = 'justify';
    else if (spread(centers) < tol && spread(lefts) > tol * 2) align = 'center';
    else if (spread(rights) < tol && spread(lefts) > tol * 2) align = 'right';
  } else {
    const leftGap = x0 - column.x0,
      rightGap = column.x1 - x1;
    if (Math.abs(leftGap - rightGap) < Math.max(4, width * 0.04) && leftGap > width * 0.06)
      align = 'center';
    else if (rightGap < Math.max(3, width * 0.02) && leftGap > width * 0.3) align = 'right';
  }
  const textX = p.marker ? p.textX : p.lines.length > 1 ? p.lines[1].x0 : first.x0;
  const indent =
    align === 'left' || align === 'justify'
      ? Math.max(
          0,
          (p.marker ? textX : Math.min(...lefts.slice(p.lines.length > 1 ? 1 : 0))) - column.x0,
        )
      : 0;
  const firstLine =
    align === 'left' || align === 'justify'
      ? p.marker
        ? first.x0 - textX
        : first.x0 - (p.lines.length > 1 ? p.lines[1].x0 : first.x0)
      : 0;
  // Tab stops for lines spaced into columns ("Left text      Right text").
  let tabs;
  if (p.chunks.length > 1) {
    tabs = p.chunks.slice(1).map((chunk, k) => {
      const prevChunk = p.chunks[k];
      const isLast = k === p.chunks.length - 2;
      if (chunk.leader) return { pos: chunk.x1 - column.x0, kind: 'right', leader: 'dot' };
      if (isLast && column.x1 - chunk.x1 < 6) return { pos: chunk.x1 - column.x0, kind: 'right' };
      const center = (chunk.x0 + chunk.x1) / 2;
      if (Math.abs(center - (column.x0 + column.x1) / 2) < 6 && prevChunk.x1 < center)
        return { pos: center - column.x0, kind: 'center' };
      return { pos: chunk.x0 - column.x0, kind: 'left' };
    });
  }
  return {
    type: 'paragraph',
    x: x0,
    y: first.top,
    w: x1 - x0,
    h: lastLine.bottom - first.top,
    top: first.top,
    bottom: lastLine.bottom,
    firstBaseline: first.baseline,
    lastBaseline: lastLine.baseline,
    runs: mergeRuns(runs),
    lineCount: p.lines.length,
    leading: p.leading,
    size: p.size,
    align,
    indent: p.tabbed ? Math.max(0, first.x0 - column.x0) : indent,
    firstLine: p.tabbed ? 0 : firstLine,
    tabs,
    list: p.marker ? { ...p.marker, markerX: first.x0, textX } : null,
    rotated: p.rotated,
    heading: 0,
    column,
  };
}

/* ---------------------------------------------------------------- page assembly */

function textOf(block) {
  if (block.type === 'paragraph') return block.runs.map((r) => r.text).join('');
  return '';
}

function layoutPage(scan, context) {
  const { width, height } = scan;
  // Scanned pages with invisible (OCR) text export the recognised text; elsewhere hidden text
  // stays hidden.
  const ocr = scan.spans.length > 0 && scan.spans.every((s) => s.invisible);
  const visible = scan.spans.filter((s) => !s.consumed && (ocr || !s.invisible));
  // Background pictures: large images that lie under text.
  const placements = scan.images.map((img) => ({ ...img }));
  const textBox = visible.length
    ? {
        x0: Math.min(...visible.map((s) => s.x0)),
        x1: Math.max(...visible.map((s) => s.x1)),
        y0: Math.min(...visible.map((s) => s.top)),
        y1: Math.max(...visible.map((s) => s.bottom)),
      }
    : null;
  const flowImages = [],
    headerImages = [],
    footerImages = [];
  let background = null;
  for (const img of placements) {
    // Logos repeated at the page edge belong to the running head.
    if (context.furnitureImage(img, scan)) {
      img.wrap = 'furniture';
      (img.y < height / 2 ? headerImages : footerImages).push(img);
      continue;
    }
    const area = img.w * img.h;
    const covered = visible.filter((s) =>
      contains({ x0: img.x, x1: img.x + img.w, y0: img.y, y1: img.y + img.h }, s),
    ).length;
    if (area > width * height * 0.5 && (covered > 0 || scan.invisibleText)) {
      if (!background || area > background.w * background.h) background = img;
      img.wrap = 'behind';
    } else if (covered > 2) img.wrap = 'behind';
    else flowImages.push(img);
  }
  if (ocr && background) background.wrap = 'ocr';

  const lines = buildLines(visible);
  // Running headers and footers recognised across pages.
  const header = [],
    footer = [],
    rest = [];
  for (const line of lines) {
    if (context.furniture(line, scan)) (line.top < height / 2 ? header : footer).push(line);
    else rest.push(line);
  }
  const elements = [];
  for (const line of rest)
    for (const chunk of line.chunks)
      elements.push({
        kind: 'chunk',
        chunk,
        line,
        x0: chunk.x0,
        x1: chunk.x1,
        top: chunk.top,
        bottom: chunk.bottom,
      });
  for (const table of scan.tables)
    elements.push({
      kind: 'table',
      table,
      x0: table.x,
      x1: table.x + table.w,
      top: table.y,
      bottom: table.y + table.h,
    });
  for (const image of flowImages)
    elements.push({
      kind: 'image',
      image,
      x0: image.x,
      x1: image.x + image.w,
      top: image.y,
      bottom: image.y + image.h,
    });

  const allX0 = elements.length ? Math.min(...elements.map((e) => e.x0)) : 72;
  const allX1 = elements.length ? Math.max(...elements.map((e) => e.x1)) : width - 72;
  const pageColumn = { x0: allX0, x1: allX1 };
  const leaves = orderElements(elements, pageColumn, width, context.bodySize, context.bands);

  const blocks = [];
  for (const leaf of leaves) {
    const column = leaf.column;
    // Rebuild lines from the chunks this leaf holds.
    const byLine = new Map();
    const others = [];
    for (const e of leaf.items) {
      if (e.kind === 'chunk') {
        if (!byLine.has(e.line.id)) byLine.set(e.line.id, []);
        byLine.get(e.line.id).push(e.chunk);
      } else others.push(e);
    }
    const leafLines = [...byLine.values()].map((chunks) => {
      const line = chunks[0].line;
      chunks.sort((a, b) => a.x0 - b.x0);
      const part = { ...line, chunks, x0: chunks[0].x0, x1: Math.max(...chunks.map((c) => c.x1)) };
      if (chunks.length === line.chunks.length) return part;
      // Part of a line shared with another column: measure this part on its own.
      const main = chunks.reduce((a, b) => (b.text.length > a.text.length ? b : a));
      const span = main.spans.reduce((a, b) => (b.text.length > a.text.length ? b : a));
      return {
        ...part,
        top: Math.min(...chunks.map((c) => c.top)),
        bottom: Math.max(...chunks.map((c) => c.bottom)),
        baseline: span.baseline,
        size: span.size,
      };
    });
    leafLines.sort((a, b) => a.top - b.top || a.x0 - b.x0);
    // Tables and pictures interrupt runs of lines.
    const sequence = [...leafLines.map((l) => ({ kind: 'line', line: l, top: l.top })), ...others];
    sequence.sort((a, b) => a.top - b.top);
    const leafBlocks = [];
    let run = [];
    const flushLines = () => {
      if (!run.length) return;
      const items = findAlignedTables(run, column);
      let textLines = [];
      const flushText = () => {
        if (textLines.length) leafBlocks.push(...groupParagraphs(textLines, column));
        textLines = [];
      };
      for (const item of items) {
        if (item.type === 'table') {
          flushText();
          leafBlocks.push(item);
        } else textLines.push(item);
      }
      flushText();
      run = [];
    };
    for (const item of sequence) {
      if (item.kind === 'line') run.push(item.line);
      else {
        flushLines();
        if (item.kind === 'table') leafBlocks.push(item.table);
        else leafBlocks.push(imageBlock(item.image, column));
      }
    }
    flushLines();
    for (const block of leafBlocks) {
      block.column = column;
      block.band = leaf.band;
      block.top ??= block.y;
      block.bottom ??= block.y + block.h;
    }
    blocks.push(...leafBlocks);
  }
  // Vertical spacing between consecutive blocks of the same column.
  let previous = null;
  for (const block of blocks) {
    const above =
      previous && previous.bottom <= block.top + 1 && previous.band?.index === block.band?.index
        ? previous
        : null;
    block.gapAbove = above ? Math.max(0, block.top - above.bottom) : null;
    block.baselineGap =
      above && above.type === 'paragraph' && block.type === 'paragraph'
        ? block.firstBaseline - above.lastBaseline
        : null;
    previous = block;
  }
  const furnitureBlocks = (list) =>
    list.length
      ? groupParagraphs(
          list.sort((a, b) => a.top - b.top),
          {
            x0: Math.min(allX0, ...list.map((l) => l.x0)),
            x1: Math.max(allX1, ...list.map((l) => l.x1)),
          },
        )
      : [];
  const contentTop = elements.length ? Math.min(...elements.map((e) => e.top)) : 72;
  const contentBottom = elements.length ? Math.max(...elements.map((e) => e.bottom)) : height - 72;
  return {
    index: scan.index,
    width,
    height,
    margins: {
      left: Math.max(18, Math.min(allX0, width / 3)),
      right: Math.max(18, Math.min(width - allX1, width / 3) - 14),
      top: Math.max(18, Math.min(contentTop, height / 3)),
      bottom: Math.max(18, Math.min(height - contentBottom, height / 3)),
    },
    header: furnitureBlocks(header),
    footer: furnitureBlocks(footer),
    headerTop:
      header.length || headerImages.length
        ? Math.min(...header.map((l) => l.top), ...headerImages.map((i) => i.y))
        : null,
    footerBottom:
      footer.length || footerImages.length
        ? Math.max(...footer.map((l) => l.bottom), ...footerImages.map((i) => i.y + i.h))
        : null,
    headerImages,
    footerImages,
    blocks,
    fills: scan.fills.filter((f) => f.color && f.w * f.h < width * height * 0.95),
    images: placements,
    background,
    hasText: scan.spans.length > 0,
    textBox,
  };
}

function imageBlock(image, column) {
  const center = image.x + image.w / 2;
  const width = column.x1 - column.x0;
  const align =
    Math.abs(center - (column.x0 + column.x1) / 2) < width * 0.08
      ? 'center'
      : image.x + image.w > column.x1 - width * 0.05 && image.x > column.x0 + width * 0.3
        ? 'right'
        : 'left';
  return {
    type: 'image',
    x: image.x,
    y: image.y,
    w: image.w,
    h: image.h,
    top: image.y,
    bottom: image.y + image.h,
    picture: image.picture,
    align,
    indent: align === 'left' ? Math.max(0, image.x - column.x0) : 0,
    wrap: 'inline',
  };
}

/* ---------------------------------------------------------------- document */

const furnitureKey = (line) =>
  line.chunks
    .map((c) => c.text)
    .join(' ')
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();

/** Assemble page scans into a document model with headings, lists and running heads. */
export function buildDocument(scans) {
  // Prepare each page: ruled tables and decorations need the raw graphics.
  const sizes = new Map(),
    fontsUsed = new Map();
  for (const scan of scans) {
    scan.spans = markDecorations(scan.spans, scan.rules);
    scan.invisibleText = scan.spans.some((s) => s.invisible);
    scan.tables = findRuledTables(scan.rules, scan.fills, scan.spans);
    for (const span of scan.spans) {
      const n = span.text.replace(/\s/g, '').length;
      const key = Math.round(span.size * 2) / 2;
      sizes.set(key, (sizes.get(key) || 0) + n);
      fontsUsed.set(span.font, (fontsUsed.get(span.font) || 0) + n);
    }
  }
  const bodySize = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 11;
  const bodyFont = [...fontsUsed.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'Arial';

  // Running heads: the same text near the top or bottom edge on several pages.
  const counts = new Map();
  const edgeLines = new Map();
  for (const scan of scans) {
    const lines = buildLines(scan.spans.filter((s) => !s.consumed));
    const edges = lines.filter((l) => l.bottom < scan.height * 0.1 || l.top > scan.height * 0.9);
    edgeLines.set(scan, edges);
    const seen = new Set();
    for (const line of edges) {
      const key = furnitureKey(line) + '@' + (line.top < scan.height / 2 ? 'top' : 'bottom');
      if (seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const threshold = Math.max(2, Math.ceil(scans.length * 0.4));
  const furniture = (line, scan) => {
    if (scans.length < 2) return false;
    if (!(line.bottom < scan.height * 0.1 || line.top > scan.height * 0.9)) return false;
    const key = furnitureKey(line);
    const where = line.top < scan.height / 2 ? 'top' : 'bottom';
    return (
      (counts.get(key + '@' + where) || 0) >= threshold ||
      /^#$|^page # of #$|^- # -$|^page #$/.test(key)
    );
  };
  // Pictures repeated at the same place near the top or bottom edge (logos).
  const edgeImage = (img, scan) => img.y + img.h < scan.height * 0.15 || img.y > scan.height * 0.85;
  const imageKey = (img) => `${img.picture.key}@${Math.round(img.x / 6)},${Math.round(img.y / 6)}`;
  const imageCounts = new Map();
  for (const scan of scans) {
    const seen = new Set();
    for (const img of scan.images)
      if (edgeImage(img, scan) && !seen.has(imageKey(img))) {
        seen.add(imageKey(img));
        imageCounts.set(imageKey(img), (imageCounts.get(imageKey(img)) || 0) + 1);
      }
  }
  const furnitureImage = (img, scan) =>
    scans.length >= 2 && edgeImage(img, scan) && (imageCounts.get(imageKey(img)) || 0) >= threshold;
  const context = { bodySize, furniture, furnitureImage, bands: { count: 0 } };
  const pages = scans.map((scan) => layoutPage(scan, context));

  // Headings: noticeably larger text, or short bold lines standing alone.
  const headingSizes = new Set();
  for (const page of pages)
    for (const block of page.blocks)
      if (block.type === 'paragraph' && isHeadingCandidate(block, bodySize))
        headingSizes.add(Math.round(block.size));
  const ranked = [...headingSizes].sort((a, b) => b - a);
  for (const page of pages)
    for (const block of page.blocks) {
      if (block.type !== 'paragraph') continue;
      if (isHeadingCandidate(block, bodySize)) {
        block.heading = Math.min(6, ranked.indexOf(Math.round(block.size)) + 1);
        if (block.list) {
          block.runs = restoreMarker(block);
          block.list = null;
        }
      } else if (isBoldHeading(block, bodySize)) {
        block.heading = Math.min(6, ranked.length + 1);
        if (block.list) {
          block.runs = restoreMarker(block);
          block.list = null;
        }
      }
    }
  assignLists(pages);
  return { pages, body: { size: bodySize, font: bodyFont } };
}

/** Put a list marker back as text ("I.<tab>Overview") when the item is really a heading. */
function restoreMarker(block) {
  const runs = block.runs.map((r) => ({ ...r }));
  const { marker, markerX, textX } = block.list;
  const x0 = block.column?.x0 ?? markerX;
  if (!runs.length) return runs;
  if (textX - markerX > block.size * 0.8) {
    runs.unshift({ ...runs[0], text: marker }, { ...runs[0], text: '\t', tab: true });
    block.tabs = [{ kind: 'left', pos: textX - x0 }, ...(block.tabs || [])];
  } else runs.unshift({ ...runs[0], text: marker + ' ' });
  block.indent = Math.max(0, markerX - x0);
  block.firstLine = 0;
  return runs;
}

function isHeadingCandidate(block, bodySize) {
  const text = textOf(block).trim();
  return (
    !block.tabs &&
    !block.rotated &&
    block.size >= bodySize * 1.12 &&
    block.size - bodySize >= 1.5 &&
    block.lineCount <= 3 &&
    text.length >= 2 &&
    text.length < 200 &&
    /\p{L}/u.test(text)
  );
}

function isBoldHeading(block, bodySize) {
  const text = textOf(block).trim();
  return (
    block.lineCount === 1 &&
    !block.tabs &&
    !block.rotated &&
    block.size >= bodySize - 0.6 &&
    text.length >= 2 &&
    text.length < 90 &&
    /\p{L}/u.test(text) &&
    !/[.,;]$/.test(text) &&
    block.runs.every((r) => r.bold || !r.text.trim())
  );
}

/** Group list items into list instances with levels and consistent numbering. */
function assignLists(pages) {
  let current = null,
    nextId = 1;
  for (const page of pages)
    for (const block of page.blocks) {
      if (block.type !== 'paragraph') {
        if (block.type !== 'image') current = null;
        continue;
      }
      if (!block.list) {
        // Continuation text under a list item keeps the list going.
        if (current && Math.abs(block.x - current.textX) < 4) continue;
        current = null;
        continue;
      }
      const list = block.list;
      const type = list.kind === 'bullet' ? 'bullet' : `${list.kind}:${list.pattern}`;
      if (
        !current ||
        Math.abs(list.markerX - current.markerX) > 60 ||
        list.markerX < current.baseX - 4
      )
        current = null;
      let level = current
        ? Math.max(0, Math.min(8, Math.round((list.markerX - current.baseX) / 18)))
        : 0;
      if (current && current.levels[level] && current.levels[level].type !== type) {
        // A different marker kind at the same indentation starts a different list.
        if (level === 0) current = null;
      }
      if (!current) {
        current = {
          id: nextId++,
          baseX: list.markerX,
          markerX: list.markerX,
          textX: list.textX,
          levels: [],
        };
        level = 0;
      }
      const slot = current.levels[level];
      if (
        list.kind !== 'bullet' &&
        slot &&
        slot.type === type &&
        list.value !== slot.value + 1 &&
        list.value !== 1
      ) {
        // Numbering that does not continue still belongs to the list; Word renumbers anyway.
      }
      if (
        list.kind !== 'bullet' &&
        slot &&
        slot.type === type &&
        list.value === 1 &&
        slot.value >= 1 &&
        level === 0
      ) {
        current = {
          id: nextId++,
          baseX: list.markerX,
          markerX: list.markerX,
          textX: list.textX,
          levels: [],
        };
      }
      current.levels[level] = { type, value: list.value || 0 };
      current.levels.length = level + 1;
      current.markerX = list.markerX;
      current.textX = list.textX;
      list.level = level;
      list.instance = current.id;
      if (!current.start) current.start = {};
      current.start[level] ??= list.value || 1;
      list.start = current.start[level];
    }
}

export { textOf };
