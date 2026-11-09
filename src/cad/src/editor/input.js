/**
 * Parsing of typed coordinate input.
 *
 *   x,y        absolute point            #x,y   absolute (explicit)
 *   @dx,dy     relative to the last point
 *   d<a        polar from the origin     @d<a   polar from the last point
 *   d          direct distance along the cursor direction from the base point
 *   <a         lock the angle for the next pick
 *
 * Lengths and angles use the drawing's unit formats (see core/units.js).
 */
import { parseLength, parseAngle } from '../core/units.js';

/**
 * @returns {{kind:'point', x, y} | {kind:'distance', d} | {kind:'angle', a} | {kind:'option', option} | {kind:'empty'} | {kind:'invalid'}}
 */
export function parsePointInput(raw, { last, header, options } = {}) {
  const s = raw.trim();
  if (!s) return { kind: 'empty' };
  const opt = matchOption(s, options);
  if (opt) return { kind: 'option', option: opt };
  let rel = false;
  let body = s;
  if (body[0] === '@') {
    rel = true;
    body = body.slice(1).trim();
    if (!body) return last ? { kind: 'point', x: last.x, y: last.y } : { kind: 'invalid' };
  } else if (body[0] === '#') body = body.slice(1).trim();
  if (body[0] === '<') {
    const a = parseAngle(body.slice(1), header);
    return Number.isFinite(a) ? { kind: 'angle', a } : { kind: 'invalid' };
  }
  const lt = body.indexOf('<');
  if (lt > 0) {
    const d = parseLength(body.slice(0, lt), header);
    const a = parseAngle(body.slice(lt + 1), header);
    if (!Number.isFinite(d) || !Number.isFinite(a)) return { kind: 'invalid' };
    const ox = rel && last ? last.x : 0,
      oy = rel && last ? last.y : 0;
    return { kind: 'point', x: ox + d * Math.cos(a), y: oy + d * Math.sin(a) };
  }
  const comma = splitComma(body);
  if (comma) {
    const x = parseLength(comma[0], header),
      y = parseLength(comma[1], header);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { kind: 'invalid' };
    if (rel && last) return { kind: 'point', x: last.x + x, y: last.y + y };
    return { kind: 'point', x, y };
  }
  const d = parseLength(body, header);
  if (Number.isFinite(d)) return { kind: 'distance', d };
  return { kind: 'invalid' };
}

/** Split "a,b" (the first top-level comma; a third ",z" is ignored). */
function splitComma(s) {
  const i = s.indexOf(',');
  if (i < 0) return null;
  const rest = s.slice(i + 1);
  const j = rest.indexOf(',');
  return [s.slice(0, i), j >= 0 ? rest.slice(0, j) : rest];
}

/**
 * Match typed text to a keyword option. Options are { key, label } where key
 * is the shortcut (often the capitalised letters of the label). Matches the
 * key exactly, or a unique prefix of the label, case-insensitively.
 */
export function matchOption(s, options) {
  if (!options || !options.length) return null;
  const t = s.trim().toLowerCase();
  if (!t) return null;
  for (const o of options) if (o.key.toLowerCase() === t) return o.value ?? o.key;
  // A whole label wins over labels it starts ("Middle" vs "Middle left").
  for (const o of options) if (o.label.toLowerCase() === t) return o.value ?? o.key;
  const hits = options.filter((o) => o.label.toLowerCase().startsWith(t));
  if (hits.length === 1) return hits[0].value ?? hits[0].key;
  return null;
}

/** Build options from labels like 'Close', 'Undo', 'Arc': key = first letter unless given as 'lAbel'. */
export function opts(...labels) {
  return labels.map((l) => {
    if (typeof l === 'object') return l;
    // Labels starting with a digit ("3P") keep their case and use both characters as the key.
    if (/^\d/.test(l)) return { key: l.slice(0, 2).toUpperCase(), label: l.toUpperCase(), value: l.toLowerCase() };
    // An uppercase letter after position 0 marks the key ("eXit" -> X).
    const m = /[A-Z]/.exec(l.slice(1));
    const key = m && l[0] === l[0].toLowerCase() ? m[0] : l[0].toUpperCase();
    const label = l[0].toUpperCase() + l.slice(1).toLowerCase();
    return { key, label, value: label.toLowerCase() };
  });
}

/** Parse a plain number (also accepts the drawing's length formats). */
export function parseNumber(raw, header) {
  const v = parseLength(String(raw).trim(), header);
  return Number.isFinite(v) ? v : NaN;
}
