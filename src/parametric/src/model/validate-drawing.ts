import type { DrawingDoc } from './types';

const sheets = new Set(['A4', 'A3', 'A2', 'A1', 'Letter', 'Tabloid', 'ANSI C', 'ANSI D']);
const kinds = new Set(['front', 'back', 'left', 'right', 'top', 'bottom', 'isometric']);
const types = new Set(['model', 'projected', 'section', 'detail', 'auxiliary', 'flat']);
const sides = new Set(['left', 'right', 'above', 'below']);
const dimKinds = new Set(['horizontal', 'vertical', 'aligned', 'radius', 'diameter', 'angle']);
const refAts = new Set(['edge', 'start', 'end', 'center']);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const optional = (v: unknown, check: (x: unknown) => boolean) => v === undefined || check(v);
const str = (v: unknown) => typeof v === 'string';
const bool = (v: unknown) => typeof v === 'boolean';
const nums = (v: unknown, n: number) => Array.isArray(v) && v.length === n && v.every(finite);
const point = (v: unknown) => nums(v, 2);
const ref = (v: unknown) => object(v) && typeof v.edge === 'string' && typeof v.at === 'string' && refAts.has(v.at);

/** Check the sheet, every view and every annotation before a file can replace the open document. */
export function validDrawing(value: unknown): value is DrawingDoc {
  if (!object(value) || typeof value.sheet !== 'string' || !sheets.has(value.sheet)
    || typeof value.landscape !== 'boolean' || !finite(value.scale) || value.scale <= 0
    || typeof value.title !== 'string' || typeof value.drawnBy !== 'string' || typeof value.notes !== 'string'
    || !Array.isArray(value.views)) return false;
  if (!optional(value.projection, (p) => p === 'third' || p === 'first')
    || !optional(value.titleBlock, (t) => t === 'basic' || t === 'full')
    || !optional(value.revision, str)) return false;
  const ids = new Set<string>();
  for (const v of value.views) {
    if (!object(v) || typeof v.id !== 'string' || !v.id || ids.has(v.id)
      || typeof v.kind !== 'string' || !kinds.has(v.kind) || !finite(v.x) || !finite(v.y)
      || typeof v.hidden !== 'boolean' || typeof v.dims !== 'boolean') return false;
    if (!optional(v.type, (t) => typeof t === 'string' && types.has(t))
      || !optional(v.parent, (p) => typeof p === 'string' && !!p)
      || !optional(v.side, (s) => typeof s === 'string' && sides.has(s))
      || !optional(v.line, (l) => nums(l, 4) && ((l as number[])[0] !== (l as number[])[2] || (l as number[])[1] !== (l as number[])[3]))
      || !optional(v.circle, (c) => nums(c, 3) && (c as number[])[2] > 0)
      || !optional(v.scale, (s) => finite(s) && s > 0)
      || !optional(v.label, str) || !optional(v.tangent, bool) || !optional(v.centerMarks, bool) || !optional(v.source, str)) return false;
    // A flat pattern view stands alone (its geometry is the flat pattern, not a direction).
    if (v.type === 'flat' && v.parent !== undefined) return false;
    // A view made from another names it, and what defines it.
    if (v.type && v.type !== 'model' && v.type !== 'flat') {
      if (typeof v.parent !== 'string') return false;
      if ((v.type === 'section' || v.type === 'auxiliary') && !v.line) return false;
      if (v.type === 'detail' && !v.circle) return false;
    }
    ids.add(v.id);
  }
  // Parents exist (a view whose parent is missing could not be drawn or edited).
  for (const v of value.views as Record<string, unknown>[]) if (typeof v.parent === 'string' && (!ids.has(v.parent) || v.parent === v.id)) return false;
  // Only a detail view can be made from a flat pattern view (it has no direction to project from).
  const flat = new Set((value.views as Record<string, unknown>[]).filter((v) => v.type === 'flat').map((v) => v.id));
  for (const v of value.views as Record<string, unknown>[]) if (typeof v.parent === 'string' && flat.has(v.parent) && v.type !== 'detail') return false;
  if (value.annotations !== undefined) {
    if (!Array.isArray(value.annotations)) return false;
    const aids = new Set<string>();
    for (const a of value.annotations) {
      if (!object(a) || typeof a.id !== 'string' || !a.id || aids.has(a.id)) return false;
      aids.add(a.id);
      if (!optional(a.view, (v) => typeof v === 'string' && ids.has(v))) return false;
      switch (a.type) {
        case 'dimension':
          if (typeof a.view !== 'string' || typeof a.kind !== 'string' || !dimKinds.has(a.kind) || !Array.isArray(a.refs) || a.refs.length < 1 || a.refs.length > 2
            || !a.refs.every(ref) || !point(a.at) || !optional(a.decimals, (n) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 8) || !optional(a.prefix, str)) return false;
          break;
        case 'note':
          if (typeof a.text !== 'string' || !point(a.at) || !optional(a.leader, point) || !optional(a.size, (n) => finite(n) && (n as number) > 0)) return false;
          break;
        case 'centerMark':
          if (typeof a.view !== 'string' || !ref(a.ref)) return false;
          break;
        case 'centerline':
          if (typeof a.view !== 'string' || !Array.isArray(a.refs) || a.refs.length !== 2 || !a.refs.every(ref)) return false;
          break;
        case 'holeCallout':
        case 'balloon':
          if (typeof a.view !== 'string' || !ref(a.ref) || !point(a.at) || !optional(a.item, (n) => Number.isInteger(n) && (n as number) > 0)) return false;
          break;
        case 'bom':
          if (!point(a.at) || !optional(a.source, str) || !optional(a.anchor, (x) => x === 'bottomRight')) return false;
          break;
        case 'cutList':
          if (!point(a.at) || !optional(a.anchor, (x) => x === 'bottomRight')) return false;
          break;
        default:
          return false;
      }
    }
  }
  return true;
}
