// S-expression reader for KiCad files. Lists become arrays; unquoted atoms
// that look numeric become numbers; every other atom (quoted or not) is a
// string. The scanner works on char codes so multi-megabyte boards parse fast.

const LPAREN = 40, RPAREN = 41, QUOTE = 34, BACKSLASH = 92;

function isSpace(c) { return c === 32 || c === 9 || c === 10 || c === 13 || c === 12; }

const NUMERIC = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/** Parses text into the top-level list (the first complete expression). */
export function parseSexpr(text) {
  const n = text.length;
  const stack = [];
  let cur = null;
  let root = null;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (isSpace(c)) { i++; continue; }
    if (c === LPAREN) {
      const list = [];
      if (cur) { cur.push(list); stack.push(cur); }
      cur = list;
      i++;
      continue;
    }
    if (c === RPAREN) {
      if (!cur) { i++; continue; }
      if (!stack.length) { root = cur; cur = null; i++; break; }
      cur = stack.pop();
      i++;
      continue;
    }
    if (c === QUOTE) {
      let j = i + 1;
      let out = '';
      let start = j;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (d === BACKSLASH) {
          out += text.slice(start, j);
          const e = text[j + 1];
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '' : e ?? '';
          j += 2;
          start = j;
          continue;
        }
        if (d === QUOTE) break;
        j++;
      }
      if (j >= n) throw new Error('The file ends inside a quoted text (it looks cut off).');
      out += text.slice(start, j);
      if (cur) cur.push(out);
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < n) {
      const d = text.charCodeAt(j);
      if (isSpace(d) || d === LPAREN || d === RPAREN) break;
      j++;
    }
    const atom = text.slice(i, j);
    if (cur) {
      if (NUMERIC.test(atom)) {
        const v = Number(atom);
        // Keep the spelling of numbers that do not round-trip ("0402", "1.0")
        // for the places where an unquoted atom is really a name (KiCad 5).
        if (String(v) !== atom) (cur.raw ||= {})[cur.length] = atom;
        cur.push(v);
      } else cur.push(atom);
    }
    i = j;
  }
  if (!root && cur) {
    const open = stack.length + 1;
    throw new Error(`The file ends before ${open} of its lists ${open === 1 ? 'is' : 'are'} closed (it looks cut off).`);
  }
  if (!root) throw new Error('The file has no S-expression content.');
  return root;
}

export const isList = (x) => Array.isArray(x);

/** Child idx of a list as text, as spelled in the file (numbers too); '' when missing. */
export function atomText(list, idx) {
  const raw = list?.raw?.[idx];
  if (raw !== undefined) return raw;
  const v = list?.[idx];
  return v == null || Array.isArray(v) ? '' : String(v);
}

/** First child list whose head is `head`. */
export function find(list, head) {
  if (!list) return null;
  for (let i = 1; i < list.length; i++) {
    const c = list[i];
    if (Array.isArray(c) && c[0] === head) return c;
  }
  return null;
}

/** All child lists whose head is `head`. */
export function findAll(list, head) {
  const out = [];
  if (!list) return out;
  for (let i = 1; i < list.length; i++) {
    const c = list[i];
    if (Array.isArray(c) && c[0] === head) out.push(c);
  }
  return out;
}

/** Value at index idx of the child list `head`, or fallback. */
export function val(list, head, idx = 1, fallback = undefined) {
  const c = find(list, head);
  return c && c.length > idx ? c[idx] : fallback;
}

/** True when the list holds the bare atom `flag` or a child `(flag yes)`. */
export function hasFlag(list, flag) {
  if (!list) return false;
  for (let i = 1; i < list.length; i++) {
    const c = list[i];
    if (c === flag) return true;
    if (Array.isArray(c) && c[0] === flag && (c.length === 1 || c[1] === 'yes' || c[1] === true)) return true;
  }
  return false;
}

/** (xy x y) points of a (pts ...) child as [[x, y], ...] in file units. */
export function points(list) {
  const pts = find(list, 'pts');
  if (!pts) return [];
  const out = [];
  for (const p of findAll(pts, 'xy')) out.push([Number(p[1]) || 0, Number(p[2]) || 0]);
  return out;
}

/** Named property value: (property "Name" "Value" ...). */
export function property(list, name) {
  for (const p of findAll(list, 'property')) if (p[1] === name) return p;
  return null;
}
