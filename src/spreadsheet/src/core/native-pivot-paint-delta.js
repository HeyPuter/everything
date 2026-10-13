import { styleToNumFmt, NUMBER_FORMAT_KEYS } from './format.js';
import { STYLE_KEYS } from './style-resets.js';
import { cloneStyle } from './style-values.js';
import { writeNativePivotPaint } from './native-pivot-paint-xml.js';
import { normalizeNativeFill, nativeFillPaintKind } from './native-fill.js';

const flags = new Set(['bold', 'italic', 'underline', 'strike', 'wrap', 'shrink']);
const edges = ['bl', 'br', 'bt', 'bb', 'bv', 'bh'];
const edgeKeys = new Set(edges.flatMap(key => [key, `${key}Border`]));
const numberKeys = new Set(NUMBER_FORMAT_KEYS);
const formats = new Set(['general', 'number', 'currency', 'percent', 'date', 'time', 'datetime', 'scientific', 'text', 'custom']);
const fail = reason => { throw new Error(`Cannot resolve native pivot paint: ${reason}`); };

/** Project only explicitly edited properties from the effective post-edit style.
 * The caller must apply its UI patch and resolve line/spill inheritance first.
 * `changedKeys` is the patch's provenance, not every key in that resulting style.
 * A resolved number-format group becomes one complete native code; other groups
 * remain independent. Missing font/size resets require the caller's actual
 * rendered defaults rather than guessing a face or pixel size from an old XF.
 */
export function nativePivotPaintDelta(after, changedKeys, { defaultFont = null, defaultSize = null, locale } = {}) {
  if (!after || typeof after !== 'object' || Array.isArray(after) || !Array.isArray(changedKeys)) fail('style or changed keys');
  const out = {}, borderSides = new Set();
  let number = false, sharedPen = false;
  const keys = new Set(changedKeys);
  if (keys.has('font') && after.scheme != null) keys.add('scheme');
  for (const key of keys) {
    if (key === 'nativeFill') {
      // XF resource ownership is not a DXF paint attribute. A color/No fill
      // edit is represented by bg; unsupported geometry must not become a
      // transparent region merely because it has no single display color.
      if (after.nativeFill) {
        const fill = normalizeNativeFill(after.nativeFill);
        if (!fill.paint && nativeFillPaintKind(fill) !== 'none') fail('pattern/gradient fill');
      }
      continue;
    }
    // Cell protection belongs to the cell's own XF, which the format edit
    // writes beside the report paint; it is not part of the report's look.
    if (key === 'locked' || key === 'formulaHidden') continue;
    // The named cell style a format came from is the cell's link to it, not paint.
    if (key === 'cellStyle') continue;
    if (numberKeys.has(key)) { number = true; continue; }
    if (edgeKeys.has(key)) { borderSides.add(key.replace(/Border$/, '')); continue; }
    if (key === 'bs' || key === 'bc') { sharedPen = true; continue; }
    const value = after[key];
    if (flags.has(key)) {
      if (value != null && typeof value !== 'boolean') fail(key);
      out[key] = value ?? false;
    } else if (key === 'bg') out.bg = value ?? 'transparent';
    else if (key === 'color') out.color = value ?? 'windowtext';
    else if (key === 'align') out.align = value ?? null;
    else if (key === 'valign') out.valign = value ?? 'middle';
    else if (key === 'clip') {
      // CT_CellAlignment has no clip flag. Disabling the app-only clip mode
      // restores native default behavior; active clipping has no faithful DXF.
      if (value != null && value !== false) fail('clipping');
    }
    else if (key === 'rot') out.rot = value ?? 0;
    else if (key === 'indent') out.indent = value ?? 0;
    else if (key === 'font') {
      if (value != null && typeof value !== 'string') fail('font');
      out.font = value == null || value === 'default' ? defaultFont : value;
      if (!out.font) fail('unresolved default font');
    }
    else if (key === 'scheme') {
      if (value != null && !['major', 'minor', 'none'].includes(value)) fail('font scheme');
      out.scheme = value ?? 'none';
    }
    else if (key === 'size') { out.size = value ?? defaultSize; if (out.size == null) fail('unresolved default size'); }
    else fail(`unsupported ${String(key)}`);
  }
  if (number) {
    if (after.fmt != null && !formats.has(after.fmt)) fail('number format');
    out.fmt = 'custom'; out.code = styleToNumFmt(after, locale);
  }
  if (sharedPen) for (const key of edges) if (after[key]) borderSides.add(key);
  for (const key of borderSides) {
    if (after[key] != null && typeof after[key] !== 'boolean') fail('border flag');
    out[key] = after[key] ?? false;
    if (out[key]) {
      const pen = after[`${key}Border`];
      if (pen != null && (typeof pen !== 'object' || Array.isArray(pen) || Object.keys(pen).some(k => !['bs', 'bc'].includes(k)))) fail('border pen');
      out[`${key}Border`] = { bs: pen?.bs ?? after.bs ?? 'thin', bc: pen && Object.hasOwn(pen, 'bc') ? pen.bc : after.bc ?? null };
    }
  }
  // The serializer owns the representable paint vocabulary and validation. The
  // provisional ID is used only to validate a code; no registry/XML is persisted.
  writeNativePivotPaint(out, { numberFormatId: number ? 0 : null });
  return cloneStyle(out);
}

/** Clear formats restores worksheet defaults, not row/column or report paint. */
export function nativePivotClearPaint(wb, sheet, options = {}) {
  return nativePivotPaintDelta(wb.defaultStyle(sheet) || {}, STYLE_KEYS, options);
}
