/**
 * Named cell styles a workbook defines for itself, beside the built-in presets of cellstyles.js.
 *
 * A definition is { name, parts, style, borders, builtin? }:
 *   - `parts` says which of the six kinds of formatting the style carries (number, alignment, font, border,
 *     fill, protection). Applying a style changes only those; a part left out keeps what the cell has.
 *   - `style` holds the style keys of the included parts (see Workbook.applyStyle), and `borders` the edges a
 *     cell in this style has, each { side: 'top' | 'bottom' | 'left' | 'right', style, color }.
 *   - `builtin` names the preset the definition stands in for, when a built-in style was modified for this
 *     workbook: the gallery shows it in the preset's place.
 *
 * Cells formatted with a named style carry its name in their style (`cellStyle`), so modifying the style
 * reformats them, and an .xlsx file links them to the named style record.
 */

import { CELL_STYLES } from './cellstyles.js';
import { NUMBER_FORMAT_KEYS, AUTOMATIC_FORMAT, fontName } from './format.js';
import { themedCellStyles } from './workbook-theme.js';

export const STYLE_PARTS = [['number', 'Number'], ['alignment', 'Alignment'], ['font', 'Font'], ['border', 'Border'], ['fill', 'Fill'], ['protection', 'Protection']];
const PART_NAMES = STYLE_PARTS.map(([key]) => key);

/** The style keys each part covers; borders are kept as edges of their own. */
export const PART_KEYS = {
  number: NUMBER_FORMAT_KEYS,
  alignment: ['align', 'valign', 'wrap', 'clip', 'shrink', 'indent', 'rot'],
  font: ['font', 'scheme', 'size', 'color', 'bold', 'italic', 'underline', 'strike'],
  fill: ['bg', 'nativeFill'],
  protection: ['locked', 'formulaHidden'],
  border: [],
};
const SIDES = [['top', 'bt'], ['bottom', 'bb'], ['left', 'bl'], ['right', 'br']];
const BORDER_STYLES = ['thin', 'medium', 'thick', 'dashed', 'dotted', 'double'];
const MAX_STYLES = 500;
const MAX_NAME = 255;

const hexColor = (v) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null);

/** Every built-in style's name, the presets' and the themed ones', in lower case: a custom style may not take one. */
export function builtinStyleNames() {
  return new Set([...CELL_STYLES.map((s) => s.label), ...themedCellStyles().map((s) => s.label)].map((n) => n.toLowerCase()));
}

/** A built-in preset by its label (as a cell's `cellStyle` or a file's style name spells it), or null. */
export const presetByLabel = (name) => CELL_STYLES.find((s) => s.label.toLowerCase() === String(name || '').toLowerCase()) || null;

/** A stored definition made safe: a name, six part switches, the included parts' keys and four edges at most. */
export function normalizeCustomStyle(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, MAX_NAME) : '';
  if (!name) return null;
  const parts = Object.fromEntries(PART_NAMES.map((p) => [p, raw.parts?.[p] !== false]));
  const style = {};
  const src = raw.style && typeof raw.style === 'object' && !Array.isArray(raw.style) ? raw.style : {};
  for (const p of PART_NAMES) {
    if (!parts[p]) continue;
    for (const key of PART_KEYS[p]) if (Object.hasOwn(src, key) && src[key] !== undefined && !(key in Object.prototype)) style[key] = src[key];
  }
  const borders = [];
  if (parts.border) {
    for (const b of Array.isArray(raw.borders) ? raw.borders : []) {
      if (!b || !SIDES.some(([side]) => side === b.side) || borders.some((o) => o.side === b.side)) continue;
      borders.push({ side: b.side, style: BORDER_STYLES.includes(b.style) ? b.style : 'thin', color: hexColor(b.color) });
    }
  }
  const builtin = typeof raw.builtin === 'string' && CELL_STYLES.some((s) => s.key === raw.builtin) ? raw.builtin : null;
  return { name: builtin ? CELL_STYLES.find((s) => s.key === builtin).label : name, parts, style, borders, ...(builtin ? { builtin } : {}) };
}

/** A workbook's list of definitions: each normalized, names unique (case aside), at most one per built-in. */
export function normalizeCellStyles(list) {
  const out = [];
  const names = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const def = normalizeCustomStyle(raw);
    if (!def || names.has(def.name.toLowerCase())) continue;
    names.add(def.name.toLowerCase());
    out.push(def);
    if (out.length >= MAX_STYLES) break;
  }
  return out;
}

/** Why a name cannot be given to a custom style (null when it can). `except` is the style being renamed. */
export function styleNameProblem(wb, name, except = null) {
  const text = String(name || '').trim();
  if (!text) return 'Enter a name for the style';
  if (text.length > MAX_NAME) return `A style name can be at most ${MAX_NAME} characters`;
  const lower = text.toLowerCase();
  if (except?.toLowerCase() === lower) return null;
  if (builtinStyleNames().has(lower)) return `${text} is a built-in style. Choose another name, or modify the built-in style`;
  if ((wb.cellStyles || []).some((s) => s.name.toLowerCase() === lower)) return `There is already a style named ${text}`;
  return null;
}

/** The edges a cell style records, read from a cell's style (the four outer edges of one cell). */
export function edgesOfStyle(s = {}) {
  const out = [];
  for (const [side, flag] of SIDES) {
    if (!s[flag]) continue;
    const pen = s[`${flag}Border`] || s;
    out.push({ side, style: BORDER_STYLES.includes(pen.bs) ? pen.bs : 'thin', color: hexColor(pen.bc) });
  }
  return out;
}

/**
 * A definition from a cell's formatting ("by example"): every part included, holding what the cell has.
 * The name is the caller's.
 */
export function styleFromCell(name, s = {}) {
  const style = {};
  for (const p of PART_NAMES) for (const key of PART_KEYS[p]) if (s[key] != null) style[key] = s[key];
  return normalizeCustomStyle({ name, style, borders: edgesOfStyle(s) });
}

/**
 * A built-in preset as a definition, for Modify and Duplicate: the parts its patch and borders touch, or every part
 * for Normal (which resets them all).
 */
export function styleFromPreset(preset, name = preset.label) {
  const patch = preset.patch || {};
  const touched = (p) => PART_KEYS[p].some((k) => Object.hasOwn(patch, k));
  const all = preset.key === 'normal';
  const parts = Object.fromEntries(PART_NAMES.map((p) => [p, all || (p === 'border' ? !!preset.borders?.length : touched(p))]));
  const style = Object.fromEntries(Object.entries(patch).filter(([, v]) => v != null));
  const borders = [];
  for (const b of preset.borders || []) {
    const sides = b.kind === 'outer' || b.kind === 'all' ? ['top', 'bottom', 'left', 'right'] : SIDES.some(([side]) => side === b.kind) ? [b.kind] : [];
    for (const side of sides) borders.push({ side, style: b.style || 'thin', color: b.color ?? null });
  }
  return normalizeCustomStyle({ name, parts, style, borders });
}

/** The definition in force for a built-in preset key: the workbook's modified copy, or the preset itself. */
export function builtinOverride(wb, key) {
  return (wb?.cellStyles || []).find((s) => s.builtin === key) || null;
}

/** A custom definition (not a modified built-in) by name, case aside. */
export function customStyleNamed(wb, name) {
  const lower = String(name || '').toLowerCase();
  return (wb?.cellStyles || []).find((s) => !s.builtin && s.name.toLowerCase() === lower) || null;
}

/**
 * What applying a definition writes: a style patch (included parts only; a key the style leaves unset in an
 * included part is reset, so the cell takes the style's look rather than a mix) and the border actions for
 * Workbook.applyBorders. Each cell in the range gets the style's edges, as a style is a cell's format: a bottom
 * edge on a block draws under every row of it.
 */
export function stylePatch(def) {
  const patch = {};
  for (const p of PART_NAMES) {
    if (!def.parts[p] || p === 'border') continue;
    for (const key of PART_KEYS[p]) patch[key] = Object.hasOwn(def.style, key) ? def.style[key] : null;
  }
  if (def.parts.number && def.style.fmt == null) Object.assign(patch, AUTOMATIC_FORMAT);
  patch.cellStyle = def.builtin === 'normal' ? null : def.name;
  const borders = [];
  if (def.parts.border) {
    borders.push({ kind: 'none' });
    for (const b of def.borders) {
      const pen = { style: b.style || 'thin', color: b.color ?? null };
      borders.push({ kind: b.side, ...pen });
      borders.push({ kind: b.side === 'top' || b.side === 'bottom' ? 'horizontal' : 'vertical', ...pen });
    }
  }
  return { patch, borders };
}

/** A definition's look as a cell style, for samples and for the style dialog's Format… (a scratch cell). */
export function styleAsCell(def) {
  const s = { ...def.style };
  for (const b of def.borders || []) {
    const flag = SIDES.find(([side]) => side === b.side)[1];
    s[flag] = true;
    s[`${flag}Border`] = { bs: b.style, bc: b.color };
  }
  return s;
}

/**
 * Fold a Format Cells result ({ patch, border | borders }) into a scratch cell style: keys set to null are
 * removed, and border actions on the one cell turn its edges on or off.
 */
export function foldFormat(s, { patch = {}, border = null, borders = null } = {}) {
  const out = { ...s };
  for (const [k, v] of Object.entries(patch)) { if (v == null) delete out[k]; else out[k] = v; }
  const actions = Array.isArray(borders) ? borders : border ? [border] : [];
  const setSide = (flag, on, pen) => {
    if (on) { out[flag] = true; out[`${flag}Border`] = { bs: pen.style || 'thin', bc: pen.color ?? null }; }
    else { delete out[flag]; delete out[`${flag}Border`]; }
  };
  for (const a of actions) {
    const flags = a.kind === 'none' || a.kind === 'outer' || a.kind === 'all' ? SIDES.map(([, f]) => f)
      : SIDES.filter(([side]) => side === a.kind).map(([, f]) => f);
    for (const flag of flags) setSide(flag, a.kind !== 'none' && !a.remove, a);
  }
  delete out.bs; delete out.bc;
  return out;
}

const CAP = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const NUMBER_NAMES = { number: 'Number', currency: 'Currency', percent: 'Percentage', date: 'Date', time: 'Time', datetime: 'Date and time', scientific: 'Scientific', text: 'Text' };

/** One line saying what a part of a definition holds, for the style dialog. */
export function partSummary(def, part) {
  const s = def.style;
  switch (part) {
    case 'number': {
      if (s.fmt == null) return 'General';
      if (s.fmt === 'custom') return `Custom: ${s.code || '0'}`;
      const name = NUMBER_NAMES[s.fmt] || CAP(String(s.fmt));
      return s.dec != null ? `${name}, ${s.dec} decimal place${s.dec === 1 ? '' : 's'}` : name;
    }
    case 'alignment': {
      const bits = [`${CAP(s.align || 'automatic')} horizontally`, `${s.valign || 'middle'} vertically`];
      if (s.wrap) bits.push('wrapped'); else if (s.clip) bits.push('clipped');
      if (s.shrink) bits.push('shrink to fit');
      if (s.indent) bits.push(`indent ${s.indent}`);
      if (s.rot) bits.push(`rotated ${s.rot}°`);
      return bits.join(', ');
    }
    case 'font': {
      const bits = [s.font ? fontName(s.font) || s.font : 'Default font', `${s.size ? Math.round(s.size * 3 / 4 * 10) / 10 : 10} pt`];
      for (const k of ['bold', 'italic', 'underline', 'strike']) if (s[k]) bits.push(k === 'strike' ? 'strikethrough' : k);
      if (hexColor(s.color)) bits.push(`text ${hexColor(s.color)}`);
      return bits.join(', ');
    }
    case 'border': {
      if (!def.borders.length) return 'No borders';
      return def.borders.map((b) => `${CAP(b.side)} ${b.style}${b.color ? ` ${b.color}` : ''}`).join('; ');
    }
    case 'fill': return hexColor(s.bg) ? `Shaded ${hexColor(s.bg)}` : s.bg ? 'Shaded' : 'No shading';
    case 'protection': return `${s.locked === false ? 'Unlocked' : 'Locked'}${s.formulaHidden ? ', formula hidden' : ''}`;
    default: return '';
  }
}

/**
 * Merge the definitions of another workbook into this one's list: each new name is added; one already here is
 * replaced when `replace` is set, else kept. Returns { list, added, replaced, kept }.
 */
export function mergeStyleLists(mine, theirs, { replace = false } = {}) {
  const list = mine.map((s) => ({ ...s }));
  let added = 0, replaced = 0, kept = 0;
  for (const def of normalizeCellStyles(theirs)) {
    const at = list.findIndex((s) => s.name.toLowerCase() === def.name.toLowerCase());
    if (at < 0) { list.push(def); added++; } else if (replace) { list[at] = def; replaced++; } else kept++;
  }
  return { list: normalizeCellStyles(list), added, replaced, kept };
}

/** The names of `theirs` that `mine` already has. */
export const clashingStyleNames = (mine, theirs) => normalizeCellStyles(theirs).filter((d) => mine.some((s) => s.name.toLowerCase() === d.name.toLowerCase())).map((d) => d.name);

/**
 * The style an editor command names: `{ custom: name }` for a custom style, or a built-in preset key whose
 * workbook-modified copy is in force. Null when the command names a built-in left as it is.
 */
export function definitionFor(wb, arg) {
  if (arg && typeof arg === 'object' && typeof arg.custom === 'string') return customStyleNamed(wb, arg.custom);
  return typeof arg === 'string' ? builtinOverride(wb, arg) : null;
}

/** Every cell linked to the style named `name` (case aside), on every sheet: [{ sheetId, r, c }]. */
export function cellsWithStyle(wb, name) {
  const lower = String(name || '').toLowerCase();
  const out = [];
  for (const sheet of wb.sheets) {
    for (const [key, cell] of sheet.cells) {
      if (typeof cell.s?.cellStyle !== 'string' || cell.s.cellStyle.toLowerCase() !== lower) continue;
      const [r, c] = key.split(',').map(Number);
      out.push({ sheetId: sheet.id, r, c });
    }
  }
  return out;
}

/**
 * Format again the cells linked to the style once named `name`, now that its definition is `def` (a modified
 * style, perhaps renamed): each run of such cells along a row takes the style's included parts. To be called
 * inside the transaction that changed the definition. Returns how many cells were reformatted.
 */
export function restyleCells(wb, name, def) {
  const cells = cellsWithStyle(wb, name);
  if (!cells.length) return 0;
  const { patch, borders } = stylePatch(def);
  const runs = [];
  for (const cell of cells.sort((a, b) => String(a.sheetId).localeCompare(String(b.sheetId)) || a.r - b.r || a.c - b.c)) {
    const last = runs.at(-1);
    if (last && last.sheetId === cell.sheetId && last.r1 === cell.r && last.c2 === cell.c - 1) last.c2 = cell.c;
    else runs.push({ sheetId: cell.sheetId, r1: cell.r, r2: cell.r, c1: cell.c, c2: cell.c });
  }
  for (const { sheetId, ...range } of runs) {
    wb.applyStyle(sheetId, range, patch);
    for (const b of borders) wb.applyBorders(sheetId, range, b.kind, b);
  }
  return cells.length;
}

/** Unlink the cells of a deleted style: they keep their formatting, without the style's name. */
export function unlinkCells(wb, name) {
  const cells = cellsWithStyle(wb, name);
  for (const { sheetId, r, c } of cells) wb.applyStyle(sheetId, { r1: r, c1: c, r2: r, c2: c }, { cellStyle: null });
  return cells.length;
}
