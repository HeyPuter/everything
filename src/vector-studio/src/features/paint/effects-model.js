/**
 * Effect records and their parameters. Effects are stored on a node as
 * node.effects = [{ type, hidden?, ...params }] in stacking order and
 * rendered by src/render/effects.js (raster effects) and
 * src/model/round-corners.js (Round Corners, a live geometry effect applied
 * at render time; the path's own anchors are never changed).
 *
 * Lengths are in document units (points).
 *
 * Feature modules add effect types with registerEffectType(type, def):
 *   { label, command, defaults,
 *     ranges?: { key: [min, max] }     numbers are clamped to these
 *     enums?: { key: [values] }        strings must be one of these
 *     normalize?(out, e) -> out        final say over the cleaned record
 *     init?(params) -> params          fill in per-instance values (seeds)
 *     describe?(e) -> string           Appearance panel label ("Warp: Arc")
 *     openDialog?(app, { params, edit }) a custom dialog for the Effect menu,
 *                                      Last Effect and the Appearance panel }
 * Other keys (booleans, arrays) follow the type of their default.
 */

export const EFFECTS = {
  dropShadow: {
    label: 'Drop Shadow',
    command: 'effect.dropShadow',
    // shadowFrom 'color' paints the shadow in `color`; 'darkness' mixes the artwork's own colors with `darkness` black.
    defaults: { mode: 'multiply', opacity: 0.75, x: 7, y: 7, blur: 5, color: '#000000', shadowFrom: 'color', darkness: 1 },
    enums: { shadowFrom: ['color', 'darkness'] },
    ranges: { darkness: [0, 1] },
  },
  innerGlow: {
    label: 'Inner Glow',
    command: 'effect.innerGlow',
    defaults: { mode: 'screen', opacity: 0.75, blur: 5, color: '#ffffff', source: 'edge' },
  },
  outerGlow: {
    label: 'Outer Glow',
    command: 'effect.outerGlow',
    defaults: { mode: 'screen', opacity: 0.75, blur: 5, color: '#ffff00' },
  },
  blur: {
    label: 'Gaussian Blur',
    command: 'effect.gaussianBlur',
    defaults: { radius: 5 },
  },
  feather: {
    label: 'Feather',
    command: 'effect.feather',
    defaults: { radius: 10 },
  },
  roundCorners: {
    label: 'Round Corners',
    command: 'effect.roundCorners',
    defaults: { radius: 10 },
  },
};

export const EFFECT_TYPES = Object.keys(EFFECTS);

/** Add an effect type (see the module comment). */
export function registerEffectType(type, def) {
  EFFECTS[type] = def;
  if (!EFFECT_TYPES.includes(type)) EFFECT_TYPES.push(type);
}

const NUM = {
  opacity: [0, 1],
  x: [-1000, 1000],
  y: [-1000, 1000],
  blur: [0, 1000],
  radius: [0, 1000],
};
const MODES = new Set(['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'colorDodge', 'colorBurn', 'hardLight', 'softLight', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity']);

/**
 * A clean, JSON-safe effect record: known params only (missing ones take
 * defaults), numbers clamped, colors as '#rrggbb', hidden kept when true.
 * Returns null for unknown types.
 */
export function normalizeEffect(e) {
  const def = e && EFFECTS[e.type];
  if (!def) return null;
  const out = { type: e.type };
  for (const [k, dv] of Object.entries(def.defaults)) {
    let v = e[k] ?? dv;
    if (typeof dv === 'number') {
      v = Number(v);
      if (!Number.isFinite(v)) v = dv;
      const r = def.ranges?.[k] || NUM[k];
      if (r) v = Math.min(r[1], Math.max(r[0], v));
    } else if (def.enums?.[k]) {
      v = def.enums[k].includes(v) ? v : dv;
    } else if (typeof dv === 'boolean') {
      v = Boolean(v);
    } else if (Array.isArray(dv)) {
      v = Array.isArray(v) ? structuredClone(v) : structuredClone(dv);
    } else if (k === 'color') {
      v = /^#[0-9a-f]{6}$/i.test(String(v)) ? String(v).toLowerCase() : dv;
    } else if (k === 'mode') {
      v = MODES.has(v) ? v : dv;
    } else if (k === 'source') {
      v = v === 'center' ? 'center' : 'edge';
    }
    out[k] = v;
  }
  if (e.hidden) out.hidden = true;
  return def.normalize ? def.normalize(out, e) : out;
}

export function createEffect(type, params = {}) {
  const def = EFFECTS[type];
  const p = { type, ...def?.defaults, ...params };
  return normalizeEffect(def?.init ? def.init(p) : p);
}

export function effectLabel(e) {
  const def = EFFECTS[e.type];
  return def?.describe?.(e) || def?.label || e.type;
}

/** Serialize/parse an effect list (graphic styles, clipboard, files). */
export function serializeEffects(list) {
  return JSON.stringify((list || []).map(normalizeEffect).filter(Boolean));
}

export function parseEffects(json) {
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.map(normalizeEffect).filter(Boolean) : [];
  } catch {
    return [];
  }
}
