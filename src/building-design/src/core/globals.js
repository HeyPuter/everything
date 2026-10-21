/**
 * Global parameters: named project values (a ceiling height, a module
 * width) that element parameters can be associated with. Changing a global
 * parameter updates every associated element. Values can be formulas of
 * other global parameters.
 *
 *   globalParam  { name, type: 'length' | 'number', value, formula? }
 *   el.bindings  { [parameterKey]: globalParamId }
 *
 * Formulas use + - * / ^, parentheses, numbers (lengths in millimetres),
 * other parameters by name, and min, max, abs, round, floor, ceil, sqrt.
 */

const FUNCS = { min: Math.min, max: Math.max, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil, sqrt: Math.sqrt };

function tokenize(src) {
  const out = [];
  const re = /\s*(?:(\d+(?:\.\d+)?(?:e[+-]?\d+)?)|([A-Za-z_][\w ]*?[\w]|[A-Za-z_])(?=\s*[-+*/^(),]|\s*$)|([-+*/^(),]))/iy;
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < src.length) {
    const at = re.lastIndex;
    m = re.exec(src);
    if (!m) {
      if (/^\s*$/.test(src.slice(at))) break;
      throw new Error(`Cannot read "${src.slice(at).trim().slice(0, 12)}"`);
    }
    if (m[1] != null) out.push({ t: 'num', v: +m[1] });
    else if (m[2] != null) out.push({ t: 'id', v: m[2].trim() });
    else out.push({ t: 'op', v: m[3] });
  }
  return out;
}

/** Evaluate a formula. `lookup(name)` returns the value of a parameter (or throws). */
export function evaluate(src, lookup) {
  const toks = tokenize(String(src));
  let i = 0;
  const peek = () => toks[i];
  const take = (v) => {
    const t = toks[i];
    if (!t || (v && t.v !== v)) throw new Error(v ? `Expected "${v}"` : 'Unexpected end');
    i++;
    return t;
  };
  const primary = () => {
    const t = take();
    if (t.t === 'num') return t.v;
    if (t.t === 'op' && t.v === '(') {
      const v = expr();
      take(')');
      return v;
    }
    if (t.t === 'op' && t.v === '-') return -power();
    if (t.t === 'op' && t.v === '+') return power();
    if (t.t === 'id') {
      const f = FUNCS[t.v.toLowerCase()];
      if (f && peek()?.v === '(') {
        take('(');
        const args = [expr()];
        while (peek()?.v === ',') {
          take(',');
          args.push(expr());
        }
        take(')');
        return f(...args);
      }
      return lookup(t.v);
    }
    throw new Error(`Unexpected "${t.v}"`);
  };
  const power = () => {
    const b = primary();
    if (peek()?.v === '^') {
      take('^');
      return b ** power();
    }
    return b;
  };
  const term = () => {
    let v = power();
    while (peek()?.v === '*' || peek()?.v === '/') {
      const op = take().v;
      const r = power();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const expr = () => {
    let v = term();
    while (peek()?.v === '+' || peek()?.v === '-') {
      const op = take().v;
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const v = expr();
  if (i < toks.length) throw new Error(`Unexpected "${toks[i].v}"`);
  if (!Number.isFinite(v)) throw new Error('The result is not a number');
  return v;
}

/** Values of all global parameters: Map id -> { value, error }. */
export function globalValues(doc) {
  const params = doc.all('globalParam');
  const byName = new Map(params.map((p) => [p.name.toLowerCase(), p]));
  const out = new Map();
  const visiting = new Set();
  const resolve = (p) => {
    if (out.has(p.id)) return out.get(p.id);
    if (visiting.has(p.id)) throw new Error(`${p.name} refers to itself`);
    visiting.add(p.id);
    let r;
    try {
      if (p.formula) {
        const value = evaluate(p.formula, (name) => {
          const q = byName.get(name.toLowerCase());
          if (!q) throw new Error(`No parameter named "${name}"`);
          const qv = resolve(q);
          if (qv.error) throw new Error(`${q.name}: ${qv.error}`);
          return qv.value;
        });
        r = { value };
      } else r = { value: +p.value || 0 };
    } catch (err) {
      r = { value: +p.value || 0, error: err.message };
    }
    visiting.delete(p.id);
    out.set(p.id, r);
    return r;
  };
  for (const p of params) resolve(p);
  return out;
}

/**
 * Push global parameter values into associated element parameters (inside
 * a transaction). With `drivers`, only runs when a global parameter or an
 * associated element changed. Returns the ids updated.
 */
export function applyGlobals(doc, drivers = null) {
  const changed = new Set();
  if (!doc.count('globalParam')) return changed;
  if (drivers) {
    let relevant = false;
    for (const id of drivers) {
      const it = doc.get(id);
      if (it?.kind === 'globalParam' || it?.bindings) relevant = true;
    }
    if (!relevant) return changed;
  }
  const values = globalValues(doc);
  for (const el of doc.filter((x) => x.bindings)) {
    const patch = {};
    for (const [key, gid] of Object.entries(el.bindings)) {
      const v = values.get(gid);
      if (!v || v.error) continue;
      if (el[key] !== v.value) patch[key] = v.value;
    }
    if (Object.keys(patch).length) {
      doc.update(el.id, patch);
      changed.add(el.id);
    }
  }
  return changed;
}

/** Remove a global parameter; associated elements keep their current values. */
export function deleteGlobal(doc, id) {
  for (const el of doc.filter((x) => x.bindings && Object.values(x.bindings).includes(id))) {
    const b = Object.fromEntries(Object.entries(el.bindings).filter(([, g]) => g !== id));
    doc.update(el.id, { bindings: Object.keys(b).length ? b : null });
  }
  doc.remove(id);
}
