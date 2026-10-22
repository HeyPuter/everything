import { borderCss } from './format.js';

const opposite = { bt: 'bb', bb: 'bt', bl: 'br', br: 'bl' };
const boundary = { bt: 'r1', bb: 'r2', bl: 'c1', br: 'c2' };
const rank = { dotted: 1, dashed: 2, solid: 3, double: 4 };
// Transient display provenance survives object spreads but cannot enter JSON,
// native style records or clipboard cell metadata.
export const DISPLAY_BORDER_PRIORITY = Symbol('displayBorderPriority');

/** Shared borders resolve by conditional formatting, direct formatting, table style, width, then
 * double/solid/dashed/dotted. Unlike CSS collapsed tables, equal rules use
 * the lower/right cell. Conditional "none" also overrides ordinary ink. */
export function compareBorderPaint(a, b) {
  return (a.priority || 0) - (b.priority || 0) || a.width - b.width
    || (rank[a.style] || 0) - (rank[b.style] || 0);
}

function sides(style, conditional, table) {
  const result = {};
  for (const key of Object.keys(opposite)) {
    const rule = conditional && Object.hasOwn(conditional, key);
    const direct = style && Object.hasOwn(style, key);
    const source = rule ? conditional : direct ? style : table;
    if (!source?.[key] && !rule) continue;
    const pen = source[key] ? source[`${key}Border`] || source : null;
    const css = pen ? borderCss(pen) : null;
    result[key] = { pen, priority: rule ? 2 : direct ? style[DISPLAY_BORDER_PRIORITY]?.[key] ?? 1 : 0, width: css ? parseFloat(css.width) : 0, style: css?.style };
  }
  return result;
}

/** One resolver per rendered view. Neighbors follow its visible row/column
 * geometry; clipped cells and hidden merge interiors cannot steal an edge.
 * Cache only queried cells, never expand a merge or whole-line format. */
export function createBorderResolver({ read, neighbor, mergeAt = () => null }) {
  const cache = new Map();
  const at = (r, c, side) => {
    const merge = mergeAt(r, c);
    if (merge && merge[boundary[side]] !== (side === 'bt' || side === 'bb' ? r : c)) return null;
    const key = `${r},${c}`;
    if (!cache.has(key)) {
      const { style, conditional, table } = read(r, c);
      cache.set(key, sides(style, conditional, table));
    }
    return cache.get(key)[side];
  };
  const wins = (edge, side, next) => {
    const other = next && at(next[0], next[1], opposite[side]);
    const order = other ? compareBorderPaint(edge, other) : 1;
    return !(order < 0 || order === 0 && (side === 'bb' || side === 'br'));
  };
  const resolve = (r, c, style, conditional, table) => {
    const own = sides(style, conditional, table), out = {};
    cache.set(`${r},${c}`, own);
    for (const [side, edge] of Object.entries(own)) {
      if (!edge.pen || !wins(edge, side, neighbor(r, c, side))) continue;
      out[side] = true;
      out[`${side}Border`] = edge.pen;
    }
    return out;
  };
  /** Whether the cell at (r, c), read as the resolver reads it, draws its `side` edge: it has a pen there that wins. */
  resolve.paints = (r, c, side) => {
    const edge = at(r, c, side);
    return !!edge?.pen && wins(edge, side, neighbor(r, c, side));
  };
  return resolve;
}
