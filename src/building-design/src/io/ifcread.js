/**
 * Reading IFC files (STEP physical files, IFC2x3 and IFC4) into triangle
 * meshes, for showing another team's model as a reference.
 *
 * Supported geometry: extruded area solids (rectangle, circle and polyline
 * profiles, with voids ignored), faceted B-reps, triangulated and polygonal
 * face sets, and mapped items, placed by local placements. Colours come
 * from surface styles, else from the element type.
 */
import earcut from 'earcut';

// STEP parsing ------------------------------------------------------------------------------

/** Parse the DATA section: Map id -> { type, args }. */
export function parseStep(text) {
  const data = text.indexOf('DATA;');
  const body = data >= 0 ? text.slice(data + 5) : text;
  const out = new Map();
  let i = 0;
  const n = body.length;
  while (i < n) {
    const hash = body.indexOf('#', i);
    if (hash < 0) break;
    const eq = body.indexOf('=', hash);
    const id = parseInt(body.slice(hash + 1, eq), 10);
    if (!Number.isFinite(id)) {
      i = hash + 1;
      continue;
    }
    let j = eq + 1;
    while (body[j] === ' ') j++;
    const paren = body.indexOf('(', j);
    const type = body.slice(j, paren).trim().toUpperCase();
    const r = { pos: paren };
    const args = parseList(body, r);
    out.set(id, { type, args });
    i = body.indexOf(';', r.pos) + 1 || n;
  }
  return out;
}

function parseList(s, r) {
  // s[r.pos] === '('
  r.pos++;
  const items = [];
  for (;;) {
    while (s[r.pos] === ' ' || s[r.pos] === '\n' || s[r.pos] === '\r' || s[r.pos] === '\t') r.pos++;
    const c = s[r.pos];
    if (c === ')') {
      r.pos++;
      return items;
    }
    if (c === ',') {
      r.pos++;
      continue;
    }
    items.push(parseValue(s, r));
  }
}

function parseValue(s, r) {
  const c = s[r.pos];
  if (c === '(') return parseList(s, r);
  if (c === "'") {
    let j = r.pos + 1;
    let str = '';
    for (;;) {
      const k = s.indexOf("'", j);
      if (k < 0) break;
      str += s.slice(j, k);
      if (s[k + 1] === "'") {
        str += "'";
        j = k + 2;
        continue;
      }
      r.pos = k + 1;
      break;
    }
    return decodeStepString(str);
  }
  if (c === '#') {
    let j = r.pos + 1;
    while (s[j] >= '0' && s[j] <= '9') j++;
    const v = { ref: parseInt(s.slice(r.pos + 1, j), 10) };
    r.pos = j;
    return v;
  }
  if (c === '$' || c === '*') {
    r.pos++;
    return null;
  }
  if (c === '.') {
    const k = s.indexOf('.', r.pos + 1);
    const v = s.slice(r.pos + 1, k);
    r.pos = k + 1;
    return { enum: v };
  }
  // A typed value, IFCLABEL('x'), or a number.
  let j = r.pos;
  while (j < s.length && !',()'.includes(s[j])) j++;
  const token = s.slice(r.pos, j).trim();
  if (s[j] === '(' && /^[A-Z]/i.test(token)) {
    r.pos = j;
    const inner = parseList(s, r);
    return inner.length === 1 ? inner[0] : inner;
  }
  r.pos = j;
  const num = parseFloat(token);
  return Number.isFinite(num) ? num : token;
}

function decodeStepString(str) {
  return str.replace(/\\X2\\([0-9A-F]+)\\X0\\/gi, (_, hex) => {
    let o = '';
    for (let i = 0; i + 3 < hex.length; i += 4) o += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    return o;
  });
}

// Math ----------------------------------------------------------------------------------------

const I = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
const apply = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
const norm3 = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// Model -----------------------------------------------------------------------------------------

const TYPE_COLORS = {
  IFCWALL: [214, 208, 198, 255],
  IFCWALLSTANDARDCASE: [214, 208, 198, 255],
  IFCSLAB: [190, 190, 186, 255],
  IFCROOF: [120, 112, 108, 255],
  IFCWINDOW: [150, 190, 220, 110],
  IFCDOOR: [170, 130, 90, 255],
  IFCCOLUMN: [180, 180, 185, 255],
  IFCBEAM: [175, 175, 180, 255],
  IFCSTAIR: [200, 196, 190, 255],
  IFCSTAIRFLIGHT: [200, 196, 190, 255],
  IFCRAILING: [120, 125, 130, 255],
  IFCPLATE: [150, 190, 220, 110],
  IFCMEMBER: [130, 135, 140, 255],
  IFCCURTAINWALL: [150, 190, 220, 110],
  IFCFURNISHINGELEMENT: [170, 150, 120, 255],
  IFCFURNITURE: [170, 150, 120, 255],
  IFCCOVERING: [225, 222, 215, 255],
};
const SKIP = new Set(['IFCSPACE', 'IFCOPENINGELEMENT', 'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY', 'IFCPROJECT', 'IFCANNOTATION', 'IFCGRID']);

/**
 * Read an IFC file's text. Returns { name, parts: [{ type, name, color, tris }], count }
 * with triangles in millimetres (flat arrays of x, y, z per vertex).
 */
export function readIFC(text) {
  const E = parseStep(text);
  const get = (v) => (v && v.ref != null ? E.get(v.ref) : null);
  // Length unit.
  let scale = 1000;
  for (const e of E.values()) {
    if (e.type === 'IFCSIUNIT' && e.args[1]?.enum === 'LENGTHUNIT') {
      const prefix = e.args[2]?.enum;
      scale = prefix === 'MILLI' ? 1 : prefix === 'CENTI' ? 10 : prefix === 'DECI' ? 100 : 1000;
    }
    if (e.type === 'IFCCONVERSIONBASEDUNIT' && e.args[1]?.enum === 'LENGTHUNIT' && /FOOT/i.test(e.args[2] || '')) scale = 304.8;
    if (e.type === 'IFCCONVERSIONBASEDUNIT' && e.args[1]?.enum === 'LENGTHUNIT' && /INCH/i.test(e.args[2] || '')) scale = 25.4;
  }
  // Surface colours by representation item.
  const itemColor = new Map();
  for (const e of E.values()) {
    if (e.type !== 'IFCSTYLEDITEM') continue;
    const col = styleColor(E, e.args[1]);
    if (col && e.args[0]?.ref != null) itemColor.set(e.args[0].ref, col);
  }
  const point = (v) => {
    const p = get(v);
    const c = p?.args?.[0] || [0, 0, 0];
    return [+c[0] || 0, +c[1] || 0, +c[2] || 0];
  };
  const dir = (v, fb) => {
    const d = get(v);
    if (!d) return fb;
    const c = d.args[0];
    return norm3([+c[0] || 0, +c[1] || 0, +(c[2] ?? 0) || 0]);
  };
  const axis3 = (v) => {
    const a = get(v);
    if (!a) return I();
    const o = point(a.args[0]);
    const z = dir(a.args[1], [0, 0, 1]);
    let x = dir(a.args[2], Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]);
    const y = norm3(cross3(z, x));
    x = cross3(y, z);
    return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, o[0], o[1], o[2], 1];
  };
  const placements = new Map();
  const placement = (v) => {
    const p = get(v);
    if (!p) return I();
    if (placements.has(v.ref)) return placements.get(v.ref);
    let m = I();
    if (p.type === 'IFCLOCALPLACEMENT') m = mul(placement(p.args[0]), axis3(p.args[1]));
    placements.set(v.ref, m);
    return m;
  };
  const parts = [];
  let count = 0;
  for (const [, e] of E) {
    if (!/^IFC/.test(e.type) || SKIP.has(e.type)) continue;
    // Products have a placement (index 5) and a representation (index 6).
    const rep = get(e.args[6]);
    if (!rep || rep.type !== 'IFCPRODUCTDEFINITIONSHAPE') continue;
    const m = placement(e.args[5]);
    const tris = [];
    let color = null;
    for (const r of rep.args[2] || []) {
      const sr = get(r);
      if (!sr || sr.type !== 'IFCSHAPEREPRESENTATION') continue;
      const ident = String(sr.args[1] || '');
      if (ident && !/^(Body|Facetation|Mesh)$/i.test(ident)) continue;
      for (const it of sr.args[3] || []) {
        color ||= itemColor.get(it.ref) || null;
        addItem(E, get, it, m, tris, { point, dir, axis3, itemColor, setColor: (c) => (color ||= c) });
      }
    }
    if (!tris.length) continue;
    for (let i = 0; i < tris.length; i++) tris[i] = Math.round(tris[i] * scale * 10) / 10;
    parts.push({ type: e.type, name: typeof e.args[2] === 'string' ? e.args[2] : '', color: color || TYPE_COLORS[e.type] || [200, 200, 200, 255], tris });
    count++;
  }
  const project = [...E.values()].find((e) => e.type === 'IFCPROJECT');
  return { name: (typeof project?.args[2] === 'string' && project.args[2]) || 'IFC model', parts, count };
}

function styleColor(E, styles) {
  const get = (v) => (v && v.ref != null ? E.get(v.ref) : null);
  const walk = (v, depth = 0) => {
    if (depth > 6 || v == null) return null;
    if (Array.isArray(v)) {
      for (const x of v) {
        const c = walk(x, depth + 1);
        if (c) return c;
      }
      return null;
    }
    const e = get(v);
    if (!e) return null;
    if (e.type === 'IFCCOLOURRGB') return [Math.round(+e.args[1] * 255), Math.round(+e.args[2] * 255), Math.round(+e.args[3] * 255), 255];
    if (e.type === 'IFCSURFACESTYLERENDERING' || e.type === 'IFCSURFACESTYLESHADING') {
      const c = walk(e.args[0], depth + 1);
      const t = +(e.args[1] ?? 0) || 0;
      if (c) c[3] = Math.round(255 * (1 - Math.min(0.9, t)));
      return c;
    }
    return walk(e.args, depth + 1);
  };
  return walk(styles);
}

function addItem(E, get, ref, m, tris, h) {
  const e = get(ref);
  if (!e) return;
  const push = (p) => {
    const q = apply(m, p);
    tris.push(q[0], q[1], q[2]);
  };
  switch (e.type) {
    case 'IFCEXTRUDEDAREASOLID': {
      const prof = profileLoops(E, get, e.args[0], h);
      if (!prof) return;
      const mm = mul(m, h.axis3(e.args[1]));
      const d = h.dir(e.args[2], [0, 0, 1]);
      const depth = +e.args[3] || 0;
      const P = (p, top) => apply(mm, [p[0] + (top ? d[0] * depth : 0), p[1] + (top ? d[1] * depth : 0), top ? d[2] * depth : 0]);
      const pushP = (q) => tris.push(q[0], q[1], q[2]);
      const flat = [];
      const holes = [];
      for (const loop of [prof.outer, ...prof.holes]) {
        if (loop !== prof.outer) holes.push(flat.length / 2);
        for (const p of loop) flat.push(p[0], p[1]);
      }
      const idx = earcut(flat, holes);
      const pts = [];
      for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
      for (let i = 0; i < idx.length; i += 3) {
        pushP(P(pts[idx[i]], false));
        pushP(P(pts[idx[i + 2]], false));
        pushP(P(pts[idx[i + 1]], false));
        pushP(P(pts[idx[i]], true));
        pushP(P(pts[idx[i + 1]], true));
        pushP(P(pts[idx[i + 2]], true));
      }
      for (const loop of [prof.outer, ...prof.holes])
        for (let i = 0; i < loop.length; i++) {
          const a = loop[i];
          const b = loop[(i + 1) % loop.length];
          const A0 = P(a, false);
          const B0 = P(b, false);
          const A1 = P(a, true);
          const B1 = P(b, true);
          pushP(A0), pushP(B0), pushP(B1), pushP(A0), pushP(B1), pushP(A1);
        }
      return;
    }
    case 'IFCFACETEDBREP':
    case 'IFCFACETEDBREPWITHVOIDS': {
      const shell = get(e.args[0]);
      for (const f of shell?.args[0] || []) {
        const face = get(f);
        const loops = [];
        for (const bnd of face?.args[0] || []) {
          const b = get(bnd);
          const poly = get(b?.args[0]);
          if (!poly) continue;
          let pts = (poly.args[0] || []).map(h.point);
          if (b.args[1]?.enum === 'F') pts = pts.reverse();
          if (b.type === 'IFCFACEOUTERBOUND') loops.unshift(pts);
          else loops.push(pts);
        }
        triangulate3(loops, push);
      }
      return;
    }
    case 'IFCTRIANGULATEDFACESET': {
      const coords = get(e.args[0])?.args[0] || [];
      const index = e.args[3] || [];
      for (const t of index) for (const k of t) push(coords[k - 1] || [0, 0, 0]);
      return;
    }
    case 'IFCPOLYGONALFACESET': {
      const coords = get(e.args[0])?.args[0] || [];
      for (const fr of e.args[2] || []) {
        const f = get(fr);
        const loops = [(f?.args[0] || []).map((k) => coords[k - 1] || [0, 0, 0])];
        for (const inner of f?.args[1] || []) loops.push(inner.map((k) => coords[k - 1] || [0, 0, 0]));
        triangulate3(loops, push);
      }
      return;
    }
    case 'IFCMAPPEDITEM': {
      const map = get(e.args[0]);
      const target = get(e.args[1]);
      let t = I();
      if (target) {
        const o = h.point(target.args[3]);
        const sc = +target.args[4] || 1;
        const x = h.dir(target.args[0], [1, 0, 0]);
        const y = h.dir(target.args[1], [0, 1, 0]);
        const z = target.args[5] ? h.dir(target.args[5], [0, 0, 1]) : norm3(cross3(x, y));
        t = [x[0] * sc, x[1] * sc, x[2] * sc, 0, y[0] * sc, y[1] * sc, y[2] * sc, 0, z[0] * sc, z[1] * sc, z[2] * sc, 0, o[0], o[1], o[2], 1];
      }
      const origin = map ? h.axis3(map.args[0]) : I();
      const rep = get(map?.args[1]);
      const mm = mul(mul(m, t), origin);
      for (const it of rep?.args[3] || []) {
        const c = h.itemColor.get(it.ref);
        if (c) h.setColor(c);
        addItem(E, get, it, mm, tris, h);
      }
      return;
    }
    case 'IFCBOOLEANCLIPPINGRESULT':
    case 'IFCBOOLEANRESULT':
      // The first operand stands in for the clipped solid.
      addItem(E, get, e.args[1], m, tris, h);
      return;
    default:
  }
}

function profileLoops(E, get, ref, h) {
  const p = get(ref);
  if (!p) return null;
  const place2 = (v) => {
    const a = get(v);
    if (!a) return (q) => q;
    const o = h.point(a.args[0]);
    const x = a.args[1] ? h.dir(a.args[1], [1, 0, 0]) : [1, 0, 0];
    return (q) => [o[0] + x[0] * q[0] - x[1] * q[1], o[1] + x[1] * q[0] + x[0] * q[1]];
  };
  const curve = (v) => {
    const c = get(v);
    if (!c) return [];
    if (c.type === 'IFCPOLYLINE') {
      const pts = (c.args[0] || []).map((r) => h.point(r).slice(0, 2));
      if (pts.length > 1 && Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]) < 1e-9) pts.pop();
      return pts;
    }
    if (c.type === 'IFCINDEXEDPOLYCURVE') {
      const list = get(c.args[0])?.args[0] || [];
      return list.map((q) => [+q[0], +q[1]]);
    }
    if (c.type === 'IFCCIRCLE') {
      const tf = place2(c.args[0]);
      const r = +c.args[1] || 1;
      return Array.from({ length: 24 }, (_, i) => tf([Math.cos((i / 24) * Math.PI * 2) * r, Math.sin((i / 24) * Math.PI * 2) * r]));
    }
    return [];
  };
  switch (p.type) {
    case 'IFCRECTANGLEPROFILEDEF': {
      const tf = place2(p.args[2]);
      const x = (+p.args[3] || 0) / 2;
      const y = (+p.args[4] || 0) / 2;
      return { outer: [[-x, -y], [x, -y], [x, y], [-x, y]].map(tf), holes: [] };
    }
    case 'IFCCIRCLEPROFILEDEF': {
      const tf = place2(p.args[2]);
      const r = +p.args[3] || 1;
      return { outer: Array.from({ length: 24 }, (_, i) => tf([Math.cos((i / 24) * Math.PI * 2) * r, Math.sin((i / 24) * Math.PI * 2) * r])), holes: [] };
    }
    case 'IFCARBITRARYCLOSEDPROFILEDEF':
      return { outer: curve(p.args[2]), holes: [] };
    case 'IFCARBITRARYPROFILEDEFWITHVOIDS':
      return { outer: curve(p.args[2]), holes: (p.args[3] || []).map(curve) };
    default:
      return null;
  }
}

/** Triangulate a planar 3D polygon with holes by projecting onto its dominant plane. */
function triangulate3(loops, push) {
  const outer = loops[0];
  if (!outer || outer.length < 3) return;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i];
    const b = outer[(i + 1) % outer.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const ax = Math.abs(nx) > Math.abs(ny) ? (Math.abs(nx) > Math.abs(nz) ? 0 : 2) : Math.abs(ny) > Math.abs(nz) ? 1 : 2;
  const [u, v] = ax === 0 ? [1, 2] : ax === 1 ? [2, 0] : [0, 1];
  const flat = [];
  const holes = [];
  const all = [];
  loops.forEach((loop, k) => {
    if (k > 0) holes.push(all.length);
    for (const p of loop) {
      flat.push(p[u], p[v]);
      all.push(p);
    }
  });
  const idx = earcut(flat, holes);
  for (let i = 0; i < idx.length; i++) push(all[idx[i]]);
}
