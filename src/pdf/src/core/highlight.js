import { PDFDict, PDFName, PDFNumber, PDFHexString, PDFString } from 'pdf-lib';
import {
  annotationForEdit,
  annotationList,
  annotationsOf,
  removeAnnotationThread,
} from './structure.js';

const name = PDFName.of;
const numbers = (array) => array?.asArray?.().map((_, i) => array.lookup(i)?.asNumber?.());
const number = (value) => PDFNumber.of(value).toString();

/** The three text markups and how each paints its quads. */
export const MARKUP_KINDS = {
  highlight: { subtype: 'Highlight', opacity: 0.32, label: 'highlight' },
  underline: { subtype: 'Underline', opacity: 1, label: 'underline' },
  strikeout: { subtype: 'StrikeOut', opacity: 1, label: 'strikethrough' },
};
const kindOf = (subtype) =>
  Object.keys(MARKUP_KINDS).find((kind) => MARKUP_KINDS[kind].subtype === subtype);

function orderedQuad(q) {
  // PDFs use both counterclockwise and Z-order corners. Keep the first edge and
  // align the opposite edge with it before drawing or building a hit target.
  const dot = (q[6] - q[4]) * (q[2] - q[0]) + (q[7] - q[5]) * (q[3] - q[1]);
  return dot < 0 ? [...q.slice(0, 4), ...q.slice(6, 8), ...q.slice(4, 6)] : q;
}

/**
 * The band of a quad between two fractions of its height, measured up from the lower edge:
 * an underline sits just above the bottom of the glyph box, a strike through its middle.
 * Bands follow the quad's own edges, so oblique text keeps oblique lines.
 */
function band(q, from, to) {
  const rise = [q[0] - q[4], q[1] - q[5], q[2] - q[6], q[3] - q[7]];
  const at = (f) => [
    q[4] + rise[0] * f,
    q[5] + rise[1] * f,
    q[6] + rise[2] * f,
    q[7] + rise[3] * f,
  ];
  const lower = at(from),
    upper = at(to);
  return [upper[0], upper[1], upper[2], upper[3], lower[0], lower[1], lower[2], lower[3]];
}
const BANDS = { underline: [0.05, 0.12], strikeout: [0.42, 0.49] };

function appearance(doc, dict, quads, hex, kind, opacity = MARKUP_KINDS[kind].opacity) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error('Choose a valid color.');
  if (!quads.length || quads.some((q) => q.length !== 8 || !q.every(Number.isFinite)))
    throw new Error('Select text or an area to mark.');
  quads = quads.map(orderedQuad);
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const points = quads.flat();
  const xs = points.filter((_, i) => i % 2 === 0),
    ys = points.filter((_, i) => i % 2 === 1);
  const rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  if (rect[2] <= rect[0] || rect[3] <= rect[1]) throw new Error('The selection has no area.');
  const shapes = BANDS[kind] ? quads.map((q) => band(q, ...BANDS[kind])) : quads;
  // One path avoids dark seams between adjoining text fragments. An explicit appearance
  // preserves oblique quadrilaterals in readers that otherwise normalize QuadPoints.
  const paths = shapes.map(
    (q) =>
      [0, 2, 6, 4]
        .map((i, j) => `${number(q[i])} ${number(q[i + 1])} ${j ? 'l' : 'm'}`)
        .join('\n') + '\nh',
  );
  const stream = doc.context.flateStream(
    `q\n/GS gs\n${rgb.map(number).join(' ')} rg\n${paths.join('\n')}\nf\nQ`,
    {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: rect,
      Resources: {
        ExtGState: {
          GS: {
            Type: 'ExtGState',
            BM: kind === 'highlight' ? 'Multiply' : 'Normal',
            ca: opacity,
            CA: opacity,
          },
        },
      },
    },
  );
  dict.set(name('Rect'), doc.context.obj(rect));
  dict.set(name('QuadPoints'), doc.context.obj(points));
  dict.set(name('C'), doc.context.obj(rgb));
  dict.set(name('CA'), PDFNumber.of(opacity));
  dict.set(name('AP'), doc.context.obj({ N: doc.context.register(stream) }));
}

/** Rebuild supported legacy text markups only when no custom appearance was supplied. */
export function ensureMarkupAppearance(doc, dict) {
  if (dict.has(name('AP'))) return false;
  const kind = kindOf(dict.lookup(name('Subtype'))?.decodeText?.());
  if (!kind) return false;
  const points = numbers(dict.lookup(name('QuadPoints')));
  if (!points?.length || points.length % 8 || !points.every(Number.isFinite)) return false;
  const color = numbers(dict.lookup(name('C'))) || [1, 1, 0];
  if (![1, 3, 4].includes(color.length) || !color.every(Number.isFinite)) return false;
  const rgb =
    color.length === 1
      ? [color[0], color[0], color[0]]
      : color.length === 4
        ? color.slice(0, 3).map((c) => 1 - Math.min(1, c + color[3]))
        : color;
  const hex =
    '#' +
    rgb
      .map((c) =>
        Math.round(Math.max(0, Math.min(1, c)) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('');
  const opacity = dict.lookup(name('CA'))?.asNumber?.() ?? 1;
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) return false;
  const quads = [];
  for (let i = 0; i < points.length; i += 8) quads.push(points.slice(i, i + 8));
  appearance(doc, dict, quads, hex, kind, opacity);
  return true;
}

/** randomUUID exists only in secure contexts; plain-http deployments still need unique names. */
function annotationName() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

/** PDF dates look like D:20260914120000Z. */
function pdfDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

/**
 * Add a highlight, underline, or strikethrough (`kind`) over the given quads, recording its
 * author and when it was made, as for every other comment.
 */
export function addHighlight(
  doc,
  index,
  { quads, hex = '#f2c438', text = '', kind = 'highlight', author = '' },
) {
  if (!MARKUP_KINDS[kind]) throw new Error('Choose a highlight, underline, or strikethrough.');
  const page = doc.getPage(index);
  const date = pdfDate();
  const dict = doc.context.obj({
    Type: 'Annot',
    Subtype: MARKUP_KINDS[kind].subtype,
    P: page.ref,
    F: 4,
    NM: PDFHexString.fromText(annotationName()),
    T: PDFHexString.fromText(String(author ?? '')),
    Contents: PDFHexString.fromText(text),
    M: PDFString.of(date),
    CreationDate: PDFString.of(date),
  });
  appearance(doc, dict, quads, hex, kind);
  annotationList(page).push(doc.context.register(dict));
}

/** Every editable text markup on the page: highlights, underlines, and strikethroughs. */
export function listHighlights(doc, index) {
  return (annotationsOf(doc.getPage(index))?.asArray() || []).flatMap((ref) => {
    const dict = doc.context.lookup(ref);
    if (!(dict instanceof PDFDict)) return [];
    const kind = kindOf(dict.lookup(name('Subtype'))?.decodeText?.());
    if (!kind) return [];
    const flags = dict.lookup(name('F'))?.asNumber?.() || 0;
    // Invisible applies only to unknown annotation types; these standard markups
    // remain visible unless Hidden or NoView is set, matching the PDF renderer.
    if (flags & (2 | 32)) return [];
    const points = numbers(dict.lookup(name('QuadPoints')));
    if (!points?.length || points.length % 8 || !points.every(Number.isFinite)) return [];
    const color = numbers(dict.lookup(name('C'))) || [1, 1, 0];
    const rgb =
      color.length === 1
        ? [color[0], color[0], color[0]]
        : color.length === 4
          ? color.slice(0, 3).map((c) => 1 - Math.min(1, c + color[3]))
          : color;
    const hex =
      '#' +
      (rgb.length === 3 ? rgb : [1, 1, 0])
        .map((c) =>
          Math.round(Math.max(0, Math.min(1, c)) * 255)
            .toString(16)
            .padStart(2, '0'),
        )
        .join('');
    const quads = [];
    for (let i = 0; i < points.length; i += 8) quads.push(orderedQuad(points.slice(i, i + 8)));
    return [
      {
        id: ref.toString(),
        kind,
        quads,
        hex,
        text: dict.lookup(name('Contents'))?.decodeText?.() || '',
        // LockedContents does not prohibit recoloring or deletion; neither edits the text.
        readOnly: !!(flags & (64 | 128)),
        opacity: dict.lookup(name('CA'))?.asNumber?.() ?? 1,
      },
    ];
  });
}

/** Recoloring returns the current annotation ID, which can change when a shared one is split. */
export function editHighlight(doc, index, id, { hex, remove = false } = {}) {
  const entry = listHighlights(doc, index).find((h) => h.id === id);
  if (!entry || entry.readOnly) throw new Error('This markup cannot be edited.');
  const annots = annotationsOf(doc.getPage(index));
  const position = annots.asArray().findIndex((ref) => ref.toString() === id);
  if (remove) {
    removeAnnotationThread(doc.getPage(index), id);
    return;
  }
  if (hex === entry.hex) return false;
  // Recoloring keeps the imported transparency, including fully transparent marks.
  // Invalid source values retain the existing recolor fallback to the kind's default.
  const opacity = entry.opacity >= 0 && entry.opacity <= 1 ? entry.opacity : undefined;
  const dict = annotationForEdit(doc.getPage(index), doc.context.lookup(annots.get(position)));
  appearance(doc, dict, entry.quads, hex, entry.kind, opacity);
  return annotationsOf(doc.getPage(index)).get(position).toString();
}

export function rectQuad({ x, y, width, height }) {
  return [x, y + height, x + width, y + height, x, y, x + width, y];
}
