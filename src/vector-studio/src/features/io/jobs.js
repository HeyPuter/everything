/**
 * Export jobs: turn a format + region + options into a Blob. Shared by the
 * Export As, Export for Screens and Export Selection dialogs and by
 * `app.exporters`.
 */
import { editorSVG } from './svg-export.js';
import { writePDF } from './pdf.js';
import { rasterExport, exportRegion } from './raster.js';
import { collectTextOutlines } from './outlines.js';
import { selectionBounds } from '../../model/geometry.js';
import { applySvgOptions } from './svg-styling.js';

export const FORMATS = {
  svg: { label: 'SVG (svg)', ext: 'svg', mime: 'image/svg+xml' },
  pdf: { label: 'PDF (pdf)', ext: 'pdf', mime: 'application/pdf' },
  png: { label: 'PNG (png)', ext: 'png', mime: 'image/png' },
  jpeg: { label: 'JPEG (jpg)', ext: 'jpg', mime: 'image/jpeg' },
  webp: { label: 'WebP (webp)', ext: 'webp', mime: 'image/webp' },
};

/** Parse "1-3, 5" into zero-based indices (validated against count). Returns null when invalid. */
export function parseRange(text, count) {
  const out = [];
  const s = String(text || '').trim();
  if (!s) return null;
  for (const part of s.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < 1 || a > count || b > count) return null;
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    for (let i = lo; i <= hi; i++) if (!out.includes(i - 1)) out.push(i - 1);
  }
  return out.length ? out : null;
}

/** Union of the visual bounds of every visible layer (export without artboards). */
export function artworkBounds(doc) {
  const ids = doc.root.children.filter((id) => {
    const l = doc.get(id);
    return l && !l.hidden && !l.template;
  });
  return selectionBounds(doc, ids, true);
}

/** Text outlines Map for a region when the user wants outlines and the type module supports it. */
export async function outlinesFor(app, editor, ids, wanted) {
  if (!wanted || !app.textOutlines) return null;
  const roots = ids || editor.doc.root.children;
  const map = await collectTextOutlines(app, editor.doc, roots);
  return map.size ? map : null;
}

/** PDF bleed for export options: the document's bleed with "Use Document Bleed Settings", else the user's value. */
export function pdfBleed(doc, options = {}) {
  if (options.useDocBleed === true && doc.root.bleed != null) return doc.root.bleed;
  return options.bleed || 0;
}

/**
 * Render one file.
 *   format   key of FORMATS
 *   region   { artboard } | { selection: true, ids } | { rect, ids }
 *   options  format options (see the dialogs)
 */
export async function renderFile(app, editor, format, region, options = {}) {
  const doc = editor.doc;
  if (format === 'svg') {
    const { rect, ids } = exportRegion(editor, region);
    const outlines = await outlinesFor(app, editor, ids, options.textMode === 'outlines');
    const raw = editorSVG(editor, { rect, ids, precision: options.precision ?? 3, minify: options.minify, responsive: options.responsive, symbols: options.symbols, textMode: outlines ? 'outlines' : 'text', outlines, title: options.title, writeIds: options.objectIds !== 'minimal' });
    const text = applySvgOptions(raw, { styling: options.styling, objectIds: options.objectIds, minify: options.minify });
    return new Blob([text], { type: 'image/svg+xml' });
  }
  if (format === 'pdf') {
    const rects = region.rects || [exportRegion(editor, region).rect];
    const ids = region.ids || (region.selection ? exportRegion(editor, region).ids : null);
    const outlines = await outlinesFor(app, editor, ids, options.textOutlines !== false);
    const { bytes, warnings } = await writePDF(doc, rects, { bleed: pdfBleed(doc, options), ids, outlines, outlinesWanted: options.textOutlines !== false && Boolean(app.textOutlines), title: options.title || doc.name });
    if (warnings.length) app.notify?.(warnings.join(' '), { timeout: 6000 });
    return new Blob([bytes], { type: 'application/pdf' });
  }
  if (FORMATS[format]) {
    return rasterExport(editor, { ...region, format, scale: options.scale || (options.ppi ? options.ppi / 72 : 1), background: options.background, antialias: options.antialias !== false, quality: options.quality, colorModel: options.colorModel });
  }
  throw new Error(`Unknown format ${format}`);
}
