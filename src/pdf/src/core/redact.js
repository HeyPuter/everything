import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  StandardFontEmbedder,
  StandardFonts,
} from 'pdf-lib';
import { pageSource, setPageSource } from './text-edit.js';
import {
  annotationList,
  annotationsOf,
  pageRotation,
  removeAnnotationThread,
} from './structure.js';
import { annotationId } from './links.js';
import { indexPageText, searchQuery } from './search.js';
import {
  contentReport,
  filterContent,
  formQuad,
  placementQuad,
  quadOverlapsRect,
  rectInside,
  unsafeContent,
} from './content-filter.js';
import { redactImageXObject, redactInlineImage } from './image-redact.js';

/**
 * Redaction in Acrobat's two steps. Marking adds standard /Redact annotations, which any reader
 * shows as outlines and which other tools can apply. Applying removes, for every mark, the text,
 * image pixels, vector art, annotations, and form fields under its areas from the file itself,
 * then paints the fill (and optional overlay text) into the page and deletes the marks.
 *
 * Choices worth knowing:
 *  - Text: every glyph whose box (advance by the font's ascent and descent) overlaps an area by
 *    more than 0.01 pt goes, in any render mode, including invisible OCR text and text inside
 *    Form XObjects. The rest keep their exact positions.
 *  - Paths: a painted path is removed only when it lies entirely inside one area (outlined text,
 *    icons). Partly covered paths stay and are hidden by the fill: cutting arbitrary geometry
 *    would change art outside the area, and paths rarely carry readable information.
 *  - Images: pixels under an area are overwritten in the image data (and its masks). An image
 *    that cannot be decoded here is removed entirely and reported.
 * Run inside `PdfSession.change`: its sweep then drops objects nothing refers to any more, such
 * as the unredacted originals of copied images and forms.
 */

const name = PDFName.of;
const get = (dict, key) => dict?.lookup(name(key));
const numbers = (value) =>
  value instanceof PDFArray ? value.asArray().map((_, i) => value.lookup(i)?.asNumber?.()) : null;
const num = (n) => PDFNumber.of(Math.round(n * 1000) / 1000).toString();

function parseHex(hex, label) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`Choose a valid ${label} color.`);
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
}
const toHex = (rgb) =>
  '#' +
  rgb
    .map((c) =>
      Math.round(Math.max(0, Math.min(1, c)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
/** Gray, RGB, or CMYK annotation colour components as RGB; null for none. */
function colorOf(components) {
  if (!components?.length || !components.every(Number.isFinite)) return null;
  if (components.length === 1) return [components[0], components[0], components[0]];
  if (components.length === 3) return components;
  if (components.length === 4)
    return components.slice(0, 3).map((c) => (1 - c) * (1 - components[3]));
  return null;
}

function normalize(rect) {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite))
    throw new Error('Select an area to redact.');
  const [x1, y1, x2, y2] = rect;
  const out = [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
  if (out[2] - out[0] < 0.1 || out[3] - out[1] < 0.1) throw new Error('Select an area to redact.');
  return out;
}

// ---------------------------------------------------------------------------------------------
// Marks.

/** The areas a Redact annotation covers: each QuadPoints quad's bounds, else its Rect. */
function markAreas(dict) {
  const points = numbers(get(dict, 'QuadPoints'));
  if (points?.length && points.length % 8 === 0 && points.every(Number.isFinite)) {
    const areas = [];
    for (let i = 0; i < points.length; i += 8) {
      const xs = [0, 2, 4, 6].map((k) => points[i + k]),
        ys = [1, 3, 5, 7].map((k) => points[i + k]);
      const area = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      if (area[2] > area[0] && area[3] > area[1]) areas.push(area);
    }
    if (areas.length) return areas;
  }
  const rect = numbers(get(dict, 'Rect'));
  if (rect?.length !== 4 || !rect.every(Number.isFinite)) return [];
  const area = [
    Math.min(rect[0], rect[2]),
    Math.min(rect[1], rect[3]),
    Math.max(rect[0], rect[2]),
    Math.max(rect[1], rect[3]),
  ];
  return area[2] > area[0] && area[3] > area[1] ? [area] : [];
}
/** Font size and colour from a default appearance string such as "/Helv 12 Tf 1 0 0 rg". */
function parseDA(da) {
  const size = da.match(/(-?[\d.]+)\s+Tf/);
  const rgb = da.match(/(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+rg/);
  const gray = da.match(/(?:^|\s)(-?[\d.]+)\s+g(?:\s|$)/);
  const cmyk = da.match(/(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+k/);
  return {
    fontSize: size ? Math.max(0, Number(size[1])) : 0,
    textColor: colorOf(
      rgb
        ? rgb.slice(1, 4).map(Number)
        : cmyk
          ? cmyk.slice(1, 5).map(Number)
          : gray
            ? [Number(gray[1])]
            : null,
    ) || [1, 0, 0],
  };
}
function readMark(doc, index, ref) {
  const dict = doc.context.lookup(ref);
  if (!(dict instanceof PDFDict) || get(dict, 'Subtype') !== name('Redact')) return null;
  const areas = markAreas(dict);
  if (!areas.length) return null;
  const da = get(dict, 'DA')?.decodeText?.() || '';
  const { fontSize, textColor } = parseDA(da);
  const fill = colorOf(numbers(get(dict, 'IC')));
  const align = get(dict, 'Q')?.asNumber?.();
  return {
    page: index,
    id: annotationId(ref),
    ref,
    dict,
    rects: areas,
    overlayText: get(dict, 'OverlayText')?.decodeText?.() || '',
    fill: fill ? toHex(fill) : null,
    fillRgb: fill,
    outline: toHex(colorOf(numbers(get(dict, 'C'))) || [1, 0, 0]),
    repeat: get(dict, 'Repeat')?.asBoolean?.() === true,
    fontSize,
    textColor: toHex(textColor),
    textRgb: textColor,
    align: [0, 1, 2].includes(align) ? align : 0,
  };
}
function pageMarks(doc, index) {
  const page = doc.getPage(index);
  return (annotationsOf(page)?.asArray() || [])
    .map((ref) => readMark(doc, index, ref))
    .filter(Boolean);
}

/**
 * Mark areas of a page for redaction with one Redact annotation (several rects make one mark,
 * as for a phrase that wraps). Returns the mark's id. Colours are #rrggbb; `fill: null` leaves
 * the area transparent after applying, as the PDF standard allows.
 */
export function addRedactionMarks(
  doc,
  pageIndex,
  rects,
  {
    overlayText = '',
    fill = '#000000',
    outline = '#ff0000',
    textColor = '#ffffff',
    repeat = false,
    fontSize = 0,
    align = 0,
  } = {},
) {
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= doc.getPageCount())
    throw new Error('Choose a page to redact.');
  if (!Array.isArray(rects) || !rects.length) throw new Error('Select an area to redact.');
  const areas = rects.map(normalize);
  const fillRgb = fill == null ? null : parseHex(fill, 'fill');
  const outlineRgb = parseHex(outline, 'outline');
  const textRgb = parseHex(textColor, 'text');
  if (!Number.isFinite(fontSize) || fontSize < 0 || fontSize > 1000)
    throw new Error('Choose a text size between 0 (automatic) and 1000.');
  if (typeof overlayText !== 'string' || overlayText.length > 1000)
    throw new Error('Keep overlay text under 1,000 characters.');
  const page = doc.getPage(pageIndex);
  const context = doc.context;
  const bounds = [
    Math.min(...areas.map((a) => a[0])),
    Math.min(...areas.map((a) => a[1])),
    Math.max(...areas.map((a) => a[2])),
    Math.max(...areas.map((a) => a[3])),
  ];
  // Before applying, readers show only an outline, so the content can still be reviewed.
  const outlineOps = areas
    .map(
      ([x1, y1, x2, y2]) =>
        `${num(x1 + 0.5)} ${num(y1 + 0.5)} ${num(x2 - x1 - 1)} ${num(y2 - y1 - 1)} re`,
    )
    .join('\n');
  const appearance = context.flateStream(
    `q\n1 w\n${outlineRgb.map(num).join(' ')} RG\n${outlineOps}\nS\nQ`,
    {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: bounds,
      Resources: {},
    },
  );
  const dict = context.obj({
    Type: 'Annot',
    Subtype: 'Redact',
    P: page.ref,
    F: 4,
    NM: PDFHexString.fromText(markName()),
    Rect: bounds,
    QuadPoints: areas.flatMap(([x1, y1, x2, y2]) => [x1, y2, x2, y2, x1, y1, x2, y1]),
    C: outlineRgb,
    DA: PDFHexString.fromText(`/Helv ${num(fontSize)} Tf ${textRgb.map(num).join(' ')} rg`),
    Q: align,
    AP: { N: context.register(appearance) },
  });
  if (fillRgb) dict.set(name('IC'), context.obj(fillRgb));
  if (overlayText) {
    dict.set(name('OverlayText'), PDFHexString.fromText(overlayText));
    dict.set(name('Repeat'), repeat ? PDFBool.True : PDFBool.False);
  }
  const ref = context.register(dict);
  annotationList(page).push(ref);
  return annotationId(ref);
}
function markName() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Every redaction mark in the document, whichever application wrote it. */
export function listRedactionMarks(doc) {
  const marks = [];
  for (let index = 0; index < doc.getPageCount(); index++)
    for (const mark of pageMarks(doc, index)) {
      const { page, id, rects, overlayText, fill, outline, repeat, fontSize, textColor, align } =
        mark;
      marks.push({
        page,
        id,
        rects,
        overlayText,
        fill,
        outline,
        repeat,
        fontSize,
        textColor,
        align,
      });
    }
  return marks;
}

/** Remove one mark (and its popup and replies) without applying it. False when absent. */
export function removeRedactionMark(doc, pageIndex, id) {
  const mark = pageMarks(doc, pageIndex).find((m) => m.id === id);
  if (!mark) return false;
  removeAnnotationThread(doc.getPage(pageIndex), mark.ref.toString());
}

// ---------------------------------------------------------------------------------------------
// Applying.

/** Remove a widget from the form tree; returns how many fields disappeared with it. */
function removeWidgetFromForm(doc, widget, widgetRef) {
  const acroForm = get(doc.catalog, 'AcroForm');
  let node = widget,
    ref = widgetRef,
    fields = 0;
  for (let guard = 0; guard < 64; guard++) {
    const parentRef = node.get(name('Parent'));
    const parent = doc.context.lookup(parentRef);
    const list = parent instanceof PDFDict ? get(parent, 'Kids') : get(acroForm, 'Fields');
    if (list instanceof PDFArray)
      for (let i = list.size() - 1; i >= 0; i--) {
        const entry = list.get(i);
        if (entry === ref || doc.context.lookup(entry) === node) list.remove(i);
      }
    // The first named node to go is the field itself: merged with its widget, or left without
    // widgets. Named ancestors that go with it are only containers.
    if (!fields && node.has(name('T'))) fields = 1;
    if (!(parent instanceof PDFDict)) break;
    const left = get(parent, 'Kids');
    if (left instanceof PDFArray && left.size()) break;
    node = parent;
    ref = parentRef;
  }
  const order = get(acroForm, 'CO');
  if (order instanceof PDFArray)
    for (let i = order.size() - 1; i >= 0; i--) {
      const entry = doc.context.lookup(order.get(i));
      if (order.get(i) === widgetRef || entry === widget || entry === node) order.remove(i);
    }
  return fields;
}

/** Drop structure references (OBJR) to removed annotations and their parent-tree entries. */
export function removeStructReferences(doc, removed, keys) {
  const root = get(doc.catalog, 'StructTreeRoot');
  if (!(root instanceof PDFDict) || (!removed.size && !keys.size)) return;
  const seen = new Set();
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    if (!(node instanceof PDFDict) || seen.has(node)) continue;
    seen.add(node);
    const kids = node.lookup(name('K'));
    const list = kids instanceof PDFArray ? kids.asArray() : kids ? [node.get(name('K'))] : [];
    const kept = list.filter((kid) => {
      const value = doc.context.lookup(kid);
      if (value instanceof PDFDict && get(value, 'Type') === name('OBJR')) {
        const target = value.get(name('Obj'));
        return !(removed.has(target) || removed.has(doc.context.lookup(target)));
      }
      if (value instanceof PDFDict) pending.push(value);
      return true;
    });
    if (kept.length !== list.length) {
      if (!kept.length) node.delete(name('K'));
      else node.set(name('K'), doc.context.obj(kept));
    }
  }
  pruneParentTree(doc, root, keys);
}
function pruneParentTree(doc, root, keys) {
  const parents = get(root, 'ParentTree');
  if (!keys.size || !(parents instanceof PDFDict)) return;
  const visited = new Set(),
    pending = [parents];
  while (pending.length) {
    const node = pending.pop();
    if (!(node instanceof PDFDict) || visited.has(node)) continue;
    visited.add(node);
    const nums = get(node, 'Nums');
    if (nums instanceof PDFArray) {
      const entries = nums.asArray(),
        kept = [];
      for (let i = 0; i + 1 < entries.length; i += 2) {
        const key = doc.context.lookup(entries[i])?.asNumber?.();
        if (!keys.has(key)) kept.push(entries[i], entries[i + 1]);
      }
      if (kept.length !== entries.length) node.set(name('Nums'), doc.context.obj(kept));
    }
    const kids = get(node, 'Kids');
    if (kids instanceof PDFArray)
      for (const kid of kids.asArray()) pending.push(doc.context.lookup(kid));
  }
}
/**
 * Structure elements describe their content with ActualText, Alt, and E. Clear them on elements
 * (and their ancestors) that own marked content which lost glyphs, so the tags cannot repeat it.
 */
function clearStructText(doc, pageRef, mcids) {
  const root = get(doc.catalog, 'StructTreeRoot');
  if (!(root instanceof PDFDict) || !mcids.size) return;
  const pending = [{ node: root, pg: undefined, chain: [] }];
  const seen = new Set();
  const clear = (chain) => {
    for (const element of chain)
      for (const key of ['ActualText', 'Alt', 'E']) element.delete(name(key));
  };
  while (pending.length) {
    const { node, pg, chain } = pending.pop();
    if (seen.has(node)) continue;
    seen.add(node);
    const own = node.get(name('Pg')) ?? pg;
    const kids = node.lookup(name('K'));
    const list =
      kids instanceof PDFArray ? kids.asArray() : kids != null ? [node.get(name('K'))] : [];
    const lineage = node === root ? chain : [...chain, node];
    for (const kid of list) {
      const value = doc.context.lookup(kid);
      if (value instanceof PDFNumber) {
        if (own === pageRef && mcids.has(value.asNumber())) clear(lineage);
      } else if (value instanceof PDFDict) {
        const type = get(value, 'Type');
        if (type === name('MCR')) {
          const mcid = get(value, 'MCID')?.asNumber?.();
          if (
            (value.get(name('Pg')) ?? own) === pageRef &&
            !value.has(name('Stm')) &&
            mcids.has(mcid)
          )
            clear(lineage);
        } else if (type !== name('OBJR')) pending.push({ node: value, pg: own, chain: lineage });
      }
    }
  }
}

const rectsOverlap = (a, b, epsilon = 0.01) =>
  Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > epsilon &&
  Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > epsilon;

/** Overlay text drawn into one area, fitted (or at the mark's size), upright on the screen. */
function overlayOps(text, area, mark, fontName, rotation) {
  const embedder = StandardFontEmbedder.for(StandardFonts.Helvetica);
  const usable = [...text.replace(/[\r\n\t]+/g, ' ')]
    .filter((c) => embedder.encoding.canEncodeUnicodeCodePoint(c.codePointAt(0)))
    .join('');
  if (!usable.trim()) return '';
  const [x1, y1, x2, y2] = area;
  const sideways = rotation === 90 || rotation === 270;
  const width = sideways ? y2 - y1 : x2 - x1,
    height = sideways ? x2 - x1 : y2 - y1;
  const frame = {
    0: [1, 0, 0, 1, x1, y1],
    90: [0, 1, -1, 0, x2, y1],
    180: [-1, 0, 0, -1, x2, y2],
    270: [0, -1, 1, 0, x1, y2],
  }[rotation];
  const pad = Math.min(2, width / 10);
  const unit = embedder.widthOfTextAtSize(usable, 1);
  const size =
    mark.fontSize > 0
      ? mark.fontSize
      : Math.max(1, Math.min(height * 0.8, (width - pad * 2) / unit, 72));
  const capHeight = 0.718;
  const lines = [];
  if (mark.repeat) {
    const piece = usable + ' ';
    const count = Math.max(
      1,
      Math.ceil(width / (embedder.widthOfTextAtSize(piece, size) || 1)) + 1,
    );
    const leading = size * 1.15;
    for (let y = height - size; y > -size * 0.3; y -= leading)
      lines.push({ text: piece.repeat(count), x: pad, y });
  } else {
    const w = embedder.widthOfTextAtSize(usable, size);
    const x = mark.align === 1 ? (width - w) / 2 : mark.align === 2 ? width - pad - w : pad;
    lines.push({ text: usable, x, y: (height - capHeight * size) / 2 });
  }
  const shows = lines
    .map((line) => `1 0 0 1 ${num(line.x)} ${num(line.y)} Tm ${embedder.encodeText(line.text)} Tj`)
    .join('\n');
  return [
    'q',
    `${frame.map(num).join(' ')} cm`,
    // Text never spills over neighbouring content.
    `0 0 ${num(width)} ${num(height)} re W n`,
    `${mark.textRgb.map(num).join(' ')} rg`,
    'BT',
    `${fontName} ${num(size)} Tf`,
    shows,
    'ET',
    'Q',
  ].join('\n');
}

/** Policy for filterContent: what lies under the areas goes. */
function redactionPolicy(doc, areas, { codec } = {}) {
  const hits = (quad) => areas.some(({ rect }) => quadOverlapsRect(quad, rect));
  // Pixels take the fill of the mark that covers them; overlapping marks apply in order.
  const groups = (quad) => {
    const byFill = new Map();
    for (const { rect, rgb } of areas)
      if (quadOverlapsRect(quad, rect)) {
        const key = rgb.join(',');
        if (!byFill.has(key)) byFill.set(key, { rgb, rects: [] });
        byFill.get(key).rects.push(rect);
      }
    return [...byFill.values()];
  };
  return {
    conservative: true,
    softMasks: true,
    glyph: (quad) => hits(quad),
    path: (bounds) => areas.some(({ rect }) => rectInside(bounds, rect)),
    async image({ object, ctm, resources }) {
      const quad = placementQuad(ctm);
      let stream = object,
        changed = false;
      for (const { rgb, rects } of groups(quad)) {
        const result = await redactImageXObject(doc, stream, resources, ctm, rects, rgb, { codec });
        if (!result) return { remove: true };
        if (result.stream) {
          stream = result.stream;
          changed = true;
        }
      }
      return changed ? { stream } : null;
    },
    async inlineImage({ header, data, ctm, resources }) {
      const quad = placementQuad(ctm);
      const matched = groups(quad);
      if (!matched.length) return null;
      // Inline images are small; one pass with every covering area is enough.
      const rects = matched.flatMap((g) => g.rects);
      const result = await redactInlineImage(
        doc,
        header,
        data,
        resources,
        ctm,
        rects,
        matched[0].rgb,
      );
      if (!result) return { remove: true };
      return result.source ? { source: result.source } : null;
    },
    form: () => 'descend',
    formFailed: ({ object, ctm }) => {
      const quad = formQuad(object, ctm);
      return !quad || hits(quad) ? 'remove' : 'keep';
    },
  };
}

const fontRefs = new WeakMap();
function overlayFont(doc) {
  let ref = fontRefs.get(doc.context);
  if (!ref) {
    ref = doc.context.register(
      doc.context.obj({
        Type: 'Font',
        Subtype: 'Type1',
        BaseFont: 'Helvetica',
        Encoding: 'WinAnsiEncoding',
      }),
    );
    fontRefs.set(doc.context, ref);
  }
  return ref;
}

/**
 * Apply every redaction mark (on `pages`, zero-based, or all pages). Resolves to false when
 * there is nothing to apply, else to a report:
 * `{ pages, text, images: { redacted, removed }, paths, annotations, fields, warnings }` where
 * `pages` lists the pages changed, `text` counts removed glyphs, `images.removed` counts image
 * placements removed whole because they could not be decoded, and `warnings` explains any
 * compromise. `codec.render` (as for file-size reduction) lets PDF.js decode JBIG2, CCITT, and
 * JPEG 2000 images so their pixels can be redacted rather than the whole image removed.
 */
export async function applyRedactions(doc, { pages, codec } = {}) {
  const count = doc.getPageCount();
  const indices = pages ?? Array.from({ length: count }, (_, i) => i);
  if (!Array.isArray(indices) || indices.some((i) => !Number.isInteger(i) || i < 0 || i >= count))
    throw new Error('Choose pages that exist in this PDF.');
  const filtered = contentReport();
  const report = {
    pages: [],
    text: 0,
    images: { redacted: 0, removed: 0 },
    paths: 0,
    annotations: 0,
    fields: 0,
    warnings: [],
  };
  const removedAnnotations = new Set(),
    structKeys = new Set();
  let formRemoved = false;
  for (const index of [...new Set(indices)].sort((a, b) => a - b)) {
    const marks = pageMarks(doc, index);
    if (!marks.length) continue;
    const page = doc.getPage(index);
    report.pages.push(index);
    const areas = marks.flatMap((mark) =>
      mark.rects.map((rect) => ({ rect, rgb: mark.fillRgb || [0, 0, 0] })),
    );
    const rects = areas.map((a) => a.rect);

    // 1. Content: text, images, paths, and forms under the areas.
    const original = page.node.Resources();
    let source;
    try {
      source = pageSource(page);
    } catch {
      throw unsafeContent();
    }
    const result = await filterContent(doc, {
      source,
      resources: original,
      policy: redactionPolicy(doc, areas, { codec }),
      report: filtered,
    });

    // 2. Annotations under the areas, with their popups, replies, and form fields.
    const markRefs = new Set(marks.map((m) => m.ref));
    for (const ref of [...(annotationsOf(page)?.asArray() || [])]) {
      if (markRefs.has(ref)) continue;
      const dict = doc.context.lookup(ref);
      if (!(dict instanceof PDFDict)) continue;
      const subtype = get(dict, 'Subtype');
      if (subtype === name('Popup') || subtype === name('Redact')) continue;
      const rect = numbers(get(dict, 'Rect'));
      if (rect?.length !== 4 || !rect.every(Number.isFinite)) continue;
      const bounds = [
        Math.min(rect[0], rect[2]),
        Math.min(rect[1], rect[3]),
        Math.max(rect[0], rect[2]),
        Math.max(rect[1], rect[3]),
      ];
      if (!rects.some((area) => rectsOverlap(bounds, area))) continue;
      if (subtype === name('Widget')) {
        const fields = removeWidgetFromForm(doc, dict, ref);
        report.fields += fields;
        formRemoved = true;
      }
      const key = get(dict, 'StructParent')?.asNumber?.();
      if (Number.isInteger(key)) structKeys.add(key);
      removedAnnotations.add(ref);
      removedAnnotations.add(dict);
      removeAnnotationThread(page, ref.toString());
      report.annotations++;
    }

    // 3. Paint the fills and overlay text over the cleaned content.
    const resources =
      (result.changed ? result.resources : original)?.clone(doc.context) || doc.context.obj({});
    const fonts = get(resources, 'Font');
    const fontDict = fonts instanceof PDFDict ? fonts.clone(doc.context) : doc.context.obj({});
    resources.set(name('Font'), fontDict);
    let fontName = null;
    const rotation = pageRotation(page);
    const paint = [];
    for (const mark of marks)
      for (const area of mark.rects) {
        const [x1, y1, x2, y2] = area;
        if (mark.fillRgb)
          paint.push(
            `q ${mark.fillRgb.map(num).join(' ')} rg ${num(x1)} ${num(y1)} ${num(x2 - x1)} ${num(y2 - y1)} re f Q`,
          );
        if (mark.overlayText) {
          if (!fontName) {
            let n = 1;
            while (fontDict.has(name(`RedactionFont${n}`))) n++;
            fontName = name(`RedactionFont${n}`);
            fontDict.set(fontName, overlayFont(doc));
          }
          const ops = overlayOps(mark.overlayText, area, mark, fontName.toString(), rotation);
          if (ops) paint.push(ops);
        }
      }
    // Isolate the original content: balance the states it leaves open or closes too often, so
    // the fills are painted in the page's own coordinates.
    const body = result.changed ? result.source : source;
    const content = `${'q\n'.repeat(1 + result.underflow)}${body}\n${'Q\n'.repeat(result.open + 1)}${paint.join('\n')}\n`;
    page.node.set(name('Resources'), resources);
    setPageSource(doc, page, content);

    // 4. The marks themselves, the page's stale thumbnail, and structure text that described
    // removed glyphs.
    for (const mark of marks) {
      const key = get(mark.dict, 'StructParent')?.asNumber?.();
      if (Number.isInteger(key)) structKeys.add(key);
      removedAnnotations.add(mark.ref);
      removedAnnotations.add(mark.dict);
      removeAnnotationThread(page, mark.ref.toString());
    }
    page.node.delete(name('Thumb'));
    clearStructText(doc, page.ref, result.mcids);
  }
  if (!report.pages.length) return false;
  removeStructReferences(doc, removedAnnotations, structKeys);
  // XFA keeps its own copy of every field value; it cannot stay once a field is redacted.
  if (formRemoved) get(doc.catalog, 'AcroForm')?.delete(name('XFA'));
  report.text = filtered.glyphs;
  report.images = filtered.images;
  report.paths = filtered.paths;
  report.warnings = [...filtered.warnings];
  if (filtered.forms)
    report.warnings.push(
      `${filtered.forms} unreadable drawing group(s) under the marks were removed.`,
    );
  if (filtered.images.removed)
    report.warnings.push(
      `${filtered.images.removed} image(s) could not be decoded and were removed entirely.`,
    );
  return report;
}

// ---------------------------------------------------------------------------------------------
// Find text & redact.

function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}
const MONTH =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

/** Patterns for "Find text & redact". Each has a global regex and an optional validator. */
export const REDACTION_PATTERNS = {
  phone: {
    label: 'Phone numbers',
    regex: /(?<![\w+])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})(?:[\s.-]?\d{2,4}){1,3}(?![\w])/g,
    validate: (text) => {
      const digits = text.replace(/\D/g, '');
      // Ten digits for North American numbers; up to fifteen (E.164) with a country code.
      return digits.length >= 10 && digits.length <= 15 && /[\s.()-]|^\+/.test(text);
    },
  },
  email: {
    label: 'Email addresses',
    regex: /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi,
  },
  creditCard: {
    label: 'Credit card numbers',
    regex: /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g,
    validate: (text) => {
      const digits = text.replace(/\D/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhn(digits);
    },
  },
  ssn: {
    label: 'US Social Security numbers',
    regex: /(?<![\d-])(?!000|666|9\d\d)\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}(?![\d-])/g,
  },
  date: {
    label: 'Dates',
    regex: new RegExp(
      [
        '\\b\\d{4}-\\d{1,2}-\\d{1,2}\\b',
        '\\b\\d{1,2}[/.-]\\d{1,2}[/.-](?:\\d{4}|\\d{2})\\b',
        `\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`,
        `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\.?,?\\s+\\d{4}\\b`,
      ].join('|'),
      'gi',
    ),
    validate: (text) => {
      const parts = text.match(/\d+/g)?.map(Number) || [];
      if (/^\d{4}-/.test(text))
        return parts[1] >= 1 && parts[1] <= 12 && parts[2] >= 1 && parts[2] <= 31;
      if (/^\d{1,2}[/.-]\d/.test(text))
        return (
          parts[0] >= 1 &&
          parts[1] >= 1 &&
          parts[0] <= 31 &&
          parts[1] <= 31 &&
          (parts[0] <= 12 || parts[1] <= 12)
        );
      return true;
    },
  },
};

/**
 * Rectangles in PDF user space for every match of `query` in a page's PDF.js text content
 * (`page.getTextContent()` items). `query` is a string (matched like Find: case-insensitive,
 * whitespace-insensitive), a RegExp, or one of REDACTION_PATTERNS. Positions inside a text item
 * are interpolated by character; pass `measure(text, item)` (e.g. canvas measureText in the
 * item's font) for proportional fonts, otherwise characters are taken as equally wide.
 * Each rect spans 0.2 em below the baseline to 0.8 em above it.
 * Returns `[{ text, rects: [[x1, y1, x2, y2], …] }]`, one rect per text item a match touches.
 */
export function findRedactionMatches(items, query, { measure, wholeWord = false } = {}) {
  const textItems = (items || []).filter((item) => typeof item?.str === 'string');
  const index = indexPageText(textItems);
  const matches = [];
  const ranges = [];
  if (typeof query === 'string') {
    const needle = searchQuery(query);
    if (!needle) return [];
    for (
      let at = index.text.indexOf(needle);
      at >= 0;
      at = index.text.indexOf(needle, at + needle.length)
    ) {
      const before = index.text[at - 1],
        after = index.text[at + needle.length];
      if (wholeWord && (/[\p{L}\p{N}]/u.test(before || '') || /[\p{L}\p{N}]/u.test(after || '')))
        continue;
      ranges.push([at, at + needle.length]);
    }
  } else {
    const pattern = query instanceof RegExp ? { regex: query } : query;
    if (!(pattern?.regex instanceof RegExp)) throw new Error('Choose text or a pattern to find.');
    const flags = pattern.regex.flags.includes('g')
      ? pattern.regex.flags
      : pattern.regex.flags + 'g';
    const regex = new RegExp(pattern.regex.source, flags.includes('i') ? flags : flags + 'i');
    for (const match of index.text.matchAll(regex)) {
      if (!match[0]) continue;
      const original = originalText(textItems, index, match.index, match.index + match[0].length);
      if (pattern.validate && !pattern.validate(original)) continue;
      ranges.push([match.index, match.index + match[0].length]);
    }
  }
  for (const [start, end] of ranges) {
    const rects = [];
    textItems.forEach((item, i) => {
      const range = index.ranges[i];
      const from = Math.max(start, range.start) - range.start,
        to = Math.min(end, range.end) - range.start;
      if (to <= from) return;
      const origin = index.origins[i];
      let c0 = origin[from],
        last = origin[to - 1];
      let c1 = last + (item.str.codePointAt(last) > 0xffff ? 2 : 1);
      while (c0 < c1 && /\s/.test(item.str[c0])) c0++;
      while (c1 > c0 && /\s/.test(item.str[c1 - 1])) c1--;
      if (c1 <= c0) return;
      const rect = itemRect(item, c0, c1, measure);
      if (rect) rects.push(rect);
    });
    if (rects.length) matches.push({ text: originalText(textItems, index, start, end), rects });
  }
  return matches;
}
/**
 * Exact "Find text & redact": search the page's own glyphs (in content order, through Form
 * XObjects, including invisible OCR text) and return one rectangle per matched line run, built
 * from the matched glyphs' boxes. Unlike interpolating PDF.js text items, this places marks on
 * the precise glyphs, whatever the font. `query` is as for `findRedactionMatches`. Text comes
 * from each font's ToUnicode map or glyph names; fonts without either cannot be searched.
 * Rects are drawn slightly inside the outer glyphs and their line, so applying them does not
 * reach kerned or tightly leaded neighbours. Returns `[{ text, rects }]`.
 */
export async function findTextRects(doc, pageIndex, query, { wholeWord = false } = {}) {
  const page = doc.getPage(pageIndex);
  const glyphs = [];
  await filterContent(doc, {
    source: pageSource(page),
    resources: page.node.Resources(),
    report: contentReport(),
    policy: {
      glyph(quad, { code, metrics, box }) {
        glyphs.push({ quad, text: metrics.unicode(code), box });
        return false;
      },
    },
  });
  // Lay the glyphs out as text, with a space wherever the pen jumps (words, lines, columns).
  let text = '',
    original = '';
  const owner = [],
    originalOwner = [];
  const sameLine = (a, b) => {
    const [x0, y0] = a.quad[0],
      [x1, y1] = a.quad[1],
      [, , , [x3, y3]] = a.quad;
    const length = Math.hypot(x1 - x0, y1 - y0) || 1,
      height = Math.hypot(x3 - x0, y3 - y0) || 1;
    const dx = (x1 - x0) / length,
      dy = (y1 - y0) / length;
    const ox = b.quad[0][0] - x1,
      oy = b.quad[0][1] - y1;
    const along = ox * dx + oy * dy,
      across = -ox * dy + oy * dx;
    return { line: Math.abs(across) < height * 0.5, gap: along > height * 0.2 || along < -height };
  };
  const push = (char, index) => {
    original += char;
    originalOwner.push(index);
    if (/\s/.test(char)) {
      if (text && !text.endsWith(' ')) {
        text += ' ';
        owner.push(index);
      }
      return;
    }
    for (const folded of searchQuery(char)) {
      text += folded;
      owner.push(index);
    }
  };
  glyphs.forEach((glyph, i) => {
    if (i) {
      const { line, gap } = sameLine(glyphs[i - 1], glyph);
      if (!line || gap) push(' ', -1);
    }
    for (const char of glyph.text) push(char, i);
  });
  const ranges = [];
  if (typeof query === 'string') {
    const needle = searchQuery(query);
    if (!needle) return [];
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
      const before = text[at - 1],
        after = text[at + needle.length];
      if (wholeWord && (/[\p{L}\p{N}]/u.test(before || '') || /[\p{L}\p{N}]/u.test(after || '')))
        continue;
      ranges.push([at, at + needle.length]);
    }
  } else {
    const pattern = query instanceof RegExp ? { regex: query } : query;
    if (!(pattern?.regex instanceof RegExp)) throw new Error('Choose text or a pattern to find.');
    const flags = pattern.regex.flags.includes('g')
      ? pattern.regex.flags
      : pattern.regex.flags + 'g';
    const regex = new RegExp(pattern.regex.source, flags.includes('i') ? flags : flags + 'i');
    for (const match of text.matchAll(regex)) {
      if (!match[0]) continue;
      ranges.push([match.index, match.index + match[0].length]);
    }
  }
  const matches = [];
  for (const [start, end] of ranges) {
    const indices = [...new Set(owner.slice(start, end).filter((i) => i >= 0))].sort(
      (a, b) => a - b,
    );
    if (!indices.length) continue;
    const first = originalOwner.indexOf(indices[0]),
      last = originalOwner.lastIndexOf(indices.at(-1));
    const matchedText = original
      .slice(first, last + 1)
      .replace(/\s+/g, ' ')
      .trim();
    if (typeof query !== 'string' && query.validate && !query.validate(matchedText)) continue;
    // Runs of glyphs that sit on one line.
    const runs = [];
    for (const index of indices) {
      const run = runs.at(-1);
      if (run && index === run.at(-1) + 1 && sameLine(glyphs[index - 1], glyphs[index]).line)
        run.push(index);
      else runs.push([index]);
    }
    const rects = runs.map((run) => runRect(run.map((i) => glyphs[i]))).filter(Boolean);
    if (rects.length) matches.push({ text: matchedText, rects });
  }
  return matches;
}
/** A point inside a glyph's box, at fractions (u across, v up) of the box. */
function boxPoint(glyph, u, v) {
  const [p0, p1, , p3] = glyph.quad;
  return [
    p0[0] + (p1[0] - p0[0]) * u + (p3[0] - p0[0]) * v,
    p0[1] + (p1[1] - p0[1]) * u + (p3[1] - p0[1]) * v,
  ];
}
function runRect(run) {
  const points = [];
  for (const [k, glyph] of run.entries()) {
    const [, y0, , y1] = glyph.box;
    const height = y1 - y0 || 1;
    // From 60 % of the descent to 85 % of the ascent: past every glyph's core, short of the
    // neighbouring lines' boxes.
    const bottom = (Math.min(0, y0) * 0.6 - y0) / height,
      top = (Math.max(0, y1) * 0.85 - y0) / height;
    const left = k === 0 ? 0.1 : 0,
      right = k === run.length - 1 ? 0.9 : 1;
    for (const u of [left, right])
      for (const v of [bottom, top]) points.push(boxPoint(glyph, u, v));
  }
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]);
  const rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  return rect[2] - rect[0] > 0.1 && rect[3] - rect[1] > 0.1 ? rect : null;
}
function originalText(items, index, start, end) {
  let text = '';
  items.forEach((item, i) => {
    const range = index.ranges[i];
    const from = Math.max(start, range.start) - range.start,
      to = Math.min(end, range.end) - range.start;
    if (to <= from) return;
    const last = index.origins[i][to - 1];
    if (text && !/\s$/.test(text)) text += ' ';
    text += item.str.slice(
      index.origins[i][from],
      last + (item.str.codePointAt(last) > 0xffff ? 2 : 1),
    );
  });
  return text.trim();
}
function itemRect(item, c0, c1, measure) {
  const t = item.transform;
  if (!Array.isArray(t) || t.length !== 6 || !t.every(Number.isFinite)) return null;
  const along = Math.hypot(t[0], t[1]) || 1;
  const ux = t[0] / along,
    uy = t[1] / along;
  const size = item.height > 0 ? item.height : Math.hypot(t[2], t[3]);
  // The up direction is perpendicular to the baseline (text is not sheared in practice).
  const vx = -uy,
    vy = ux;
  const fraction = (c) => {
    if (measure) {
      const whole = measure(item.str, item);
      if (whole > 0) return measure(item.str.slice(0, c), item) / whole;
    }
    const total = [...item.str].length;
    return total ? [...item.str.slice(0, c)].length / total : 0;
  };
  const width = item.width || 0;
  const x0 = fraction(c0) * width,
    x1 = fraction(c1) * width;
  const y0 = -0.2 * size,
    y1 = 0.8 * size;
  const corners = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ].map(([x, y]) => [t[4] + ux * x + vx * y, t[5] + uy * x + vy * y]);
  const xs = corners.map((p) => p[0]),
    ys = corners.map((p) => p[1]);
  const rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  return rect[2] - rect[0] > 0 && rect[3] - rect[1] > 0 ? rect : null;
}
