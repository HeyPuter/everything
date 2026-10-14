/**
 * DXF import for tracing: reads lines, polylines (with arc segments),
 * arcs, circles and single-line text from the ENTITIES section, in model
 * space, converted to millimetres. Blocks are not expanded.
 */

const UNIT_MM = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 14: 100, 15: 10000 };

/** Parse DXF text into { unitsMM, lines: [[a, b]], texts: [{ at, text, height, rotation }] }. */
export function parseDXF(text, fallbackMM = 1) {
  const raw = text.split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([parseInt(raw[i].trim(), 10), raw[i + 1].trim()]);
  let insunits = null;
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i][0] === 9 && pairs[i][1] === '$INSUNITS') {
      const v = pairs.slice(i + 1, i + 4).find((p) => p[0] === 70);
      if (v) insunits = parseInt(v[1], 10);
      break;
    }
  }
  const k = UNIT_MM[insunits] ?? fallbackMM;
  const lines = [];
  const texts = [];
  // Entities section.
  let i = pairs.findIndex((p, j) => p[0] === 2 && p[1] === 'ENTITIES' && pairs[j - 1]?.[1] === 'SECTION');
  if (i < 0) return { unitsMM: k, lines, texts };
  i++;
  const P = (x, y) => [x * k, y * k];
  while (i < pairs.length) {
    const [code, val] = pairs[i];
    if (code === 0 && val === 'ENDSEC') break;
    if (code !== 0) {
      i++;
      continue;
    }
    const type = val;
    const props = [];
    i++;
    while (i < pairs.length && pairs[i][0] !== 0) props.push(pairs[i++]);
    const get = (c) => {
      const p = props.find((x) => x[0] === c);
      return p ? parseFloat(p[1]) : 0;
    };
    const space = props.find((x) => x[0] === 67);
    if (space && space[1] === '1') continue; // paper space
    if (type === 'LINE') lines.push([P(get(10), get(20)), P(get(11), get(21))]);
    else if (type === 'LWPOLYLINE') {
      const pts = [];
      const bulges = [];
      for (const [c, v] of props) {
        if (c === 10) pts.push([parseFloat(v), 0]);
        else if (c === 20 && pts.length) pts.at(-1)[1] = parseFloat(v);
        else if (c === 42 && pts.length) bulges[pts.length - 1] = parseFloat(v);
      }
      const closed = (get(70) & 1) === 1;
      polyline(pts, bulges, closed, lines, k);
    } else if (type === 'POLYLINE') {
      const closed = (get(70) & 1) === 1;
      const pts = [];
      const bulges = [];
      while (i < pairs.length && pairs[i][1] === 'VERTEX' && pairs[i][0] === 0) {
        i++;
        const vp = [];
        while (i < pairs.length && pairs[i][0] !== 0) vp.push(pairs[i++]);
        const g = (c) => parseFloat(vp.find((x) => x[0] === c)?.[1] ?? '0');
        pts.push([g(10), g(20)]);
        bulges.push(g(42));
      }
      if (pairs[i]?.[1] === 'SEQEND') {
        i++;
        while (i < pairs.length && pairs[i][0] !== 0) i++;
      }
      polyline(pts, bulges, closed, lines, k);
    } else if (type === 'ARC' || type === 'CIRCLE') {
      const c = [get(10), get(20)];
      const r = get(40);
      let a0 = type === 'ARC' ? (get(50) * Math.PI) / 180 : 0;
      let a1 = type === 'ARC' ? (get(51) * Math.PI) / 180 : Math.PI * 2;
      if (a1 <= a0) a1 += Math.PI * 2;
      arc(c, r, a0, a1, lines, k);
    } else if (type === 'TEXT' || type === 'MTEXT') {
      const str = props
        .filter((x) => x[0] === 1 || x[0] === 3)
        .map((x) => x[1])
        .join('')
        .replace(/\\P/g, '\n')
        .replace(/\\[A-Za-z][^;]*;/g, '')
        .replace(/[{}]/g, '');
      if (str.trim()) texts.push({ at: P(get(10), get(20)), text: str.trim(), height: get(40) * k, rotation: get(50) });
    }
  }
  return { unitsMM: k, lines, texts };
}

function arc(c, r, a0, a1, lines, k) {
  const n = Math.max(4, Math.ceil(((a1 - a0) / (Math.PI * 2)) * 48));
  let prev = null;
  for (let s = 0; s <= n; s++) {
    const a = a0 + ((a1 - a0) * s) / n;
    const p = [(c[0] + Math.cos(a) * r) * k, (c[1] + Math.sin(a) * r) * k];
    if (prev) lines.push([prev, p]);
    prev = p;
  }
}

function polyline(pts, bulges, closed, lines, k) {
  const n = pts.length;
  const segs = closed ? n : n - 1;
  for (let s = 0; s < segs; s++) {
    const a = pts[s];
    const b = pts[(s + 1) % n];
    const bulge = bulges[s] || 0;
    if (!bulge) {
      lines.push([
        [a[0] * k, a[1] * k],
        [b[0] * k, b[1] * k],
      ]);
      continue;
    }
    // Arc segment from the bulge (tan of a quarter of the included angle).
    const theta = 4 * Math.atan(bulge);
    const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const r = chord / (2 * Math.sin(theta / 2));
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const d = Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2)) * Math.sign(bulge) * (Math.abs(theta) > Math.PI ? -1 : 1);
    const nx = -(b[1] - a[1]) / chord;
    const ny = (b[0] - a[0]) / chord;
    const c = [m[0] + nx * d, m[1] + ny * d];
    let a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
    let a1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
    if (bulge > 0 && a1 < a0) a1 += Math.PI * 2;
    if (bulge < 0 && a1 > a0) a1 -= Math.PI * 2;
    const steps = Math.max(2, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 24)));
    let prev = [a[0] * k, a[1] * k];
    for (let i = 1; i <= steps; i++) {
      const t = a0 + ((a1 - a0) * i) / steps;
      const p = [(c[0] + Math.cos(t) * Math.abs(r)) * k, (c[1] + Math.sin(t) * Math.abs(r)) * k];
      lines.push([prev, p]);
      prev = p;
    }
  }
}
