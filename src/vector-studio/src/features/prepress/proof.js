/**
 * Proof Colors filters from the color settings.
 *
 * The canvas shows a proof through an SVG filter (see workspace/view.js),
 * which can only apply per-channel curves and a color matrix. RGB device
 * proofs are exactly that (decode the device curve, convert primaries,
 * encode for the display). Press proofs are not, so a filter of the form
 * matrix -> per-channel curves is fitted to the press simulation by least
 * squares over a grid of colors.
 */
import { RGB_SPACES, rgbToXyzMatrix, convertRgb, proofCmyk, documentCmykProfile, documentRgbSpace, colorSettings, cmykProfile } from './color-management.js';

const num = (v) => String(Number(v.toFixed(5)));

/** Default custom proof: the document's CMYK press with the color settings' intent. */
export const DEFAULT_PROOF = Object.freeze({ device: 'cmyk:document', preserve: true, intent: 'relative', paper: false, black: false });

export function proofSettings(app) {
  const v = app?.prefs?.get('proofCustom') || {};
  return { ...DEFAULT_PROOF, intent: colorSettings(app).intent, ...v };
}

function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

function mul3x3(a, b) {
  const out = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) out[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return out;
}

const table = (fn, n = 33) => Array.from({ length: n }, (_, i) => fn(i / (n - 1)));

function transferMarkup(tables) {
  const f = (tag, t) => `<${tag} type="table" tableValues="${t.map((v) => num(Math.max(0, Math.min(1, v)))).join(' ')}"/>`;
  return `<feComponentTransfer>${f('feFuncR', tables[0])}${f('feFuncG', tables[1])}${f('feFuncB', tables[2])}</feComponentTransfer>`;
}

/** feColorMatrix values for a 3x3 matrix plus offsets. */
function matrixMarkup(m, offset = [0, 0, 0]) {
  const v = [m[0], m[1], m[2], 0, offset[0], m[3], m[4], m[5], 0, offset[1], m[6], m[7], m[8], 0, offset[2], 0, 0, 0, 1, 0];
  return `<feColorMatrix type="matrix" values="${v.map(num).join(' ')}"/>`;
}

/** Exact filter showing numbers of RGB space `from` on an sRGB display. */
export function rgbProofBody(from) {
  if (!RGB_SPACES[from] || from === 'srgb' || from === 'monitor') return '<feColorMatrix type="identity"/>';
  const src = RGB_SPACES[from];
  const m = mul3x3(inv3(rgbToXyzMatrix('srgb')), rgbToXyzMatrix(from));
  const dec = table((v) => src.trc.decode(v));
  const enc = table((v) => RGB_SPACES.srgb.trc.encode(v), 65);
  return `${transferMarkup([dec, dec, dec])}${matrixMarkup(m)}${transferMarkup([enc, enc, enc])}`;
}

/** Solve A x = b (n x n, Gaussian elimination with partial pivoting). */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

/**
 * Fit matrix -> per-channel curves to fn([r, g, b]) -> [r, g, b] (all 0..1).
 * Returns { matrix (3x3), offset, tables, apply(rgb) }.
 */
export function fitColorTransform(fn, steps = 9, tableSize = 17) {
  const xs = [];
  const ys = [];
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) {
      for (let k = 0; k < steps; k++) {
        const x = [i / (steps - 1), j / (steps - 1), k / (steps - 1)];
        xs.push(x);
        ys.push(fn(x));
      }
    }
  }
  const matrix = [];
  const offset = [];
  for (let ch = 0; ch < 3; ch++) {
    const A = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
    const b = [0, 0, 0, 0];
    xs.forEach((x, n) => {
      const v = [x[0], x[1], x[2], 1];
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) A[r][c] += v[r] * v[c];
        b[r] += v[r] * ys[n][ch];
      }
    });
    const s = solve(A, b);
    matrix.push(s[0], s[1], s[2]);
    offset.push(s[3]);
  }
  const predict = (x) => [0, 1, 2].map((ch) => Math.max(0, Math.min(1, matrix[ch * 3] * x[0] + matrix[ch * 3 + 1] * x[1] + matrix[ch * 3 + 2] * x[2] + offset[ch])));
  const tables = [0, 1, 2].map((ch) => {
    const sum = new Array(tableSize).fill(0);
    const wsum = new Array(tableSize).fill(0);
    xs.forEach((x, n) => {
      const p = predict(x)[ch] * (tableSize - 1);
      const i0 = Math.floor(p);
      const t = p - i0;
      for (const [i, w] of [[i0, 1 - t], [i0 + 1, t]]) {
        if (i < 0 || i >= tableSize || w <= 0) continue;
        sum[i] += w * ys[n][ch];
        wsum[i] += w;
      }
    });
    const out = sum.map((s, i) => (wsum[i] > 1e-6 ? s / wsum[i] : null));
    // Fill bins no sample reached by interpolating their neighbors; keep the curve rising.
    for (let i = 0; i < tableSize; i++) {
      if (out[i] != null) continue;
      let a = i - 1;
      while (a >= 0 && out[a] == null) a--;
      let b = i + 1;
      while (b < tableSize && out[b] == null) b++;
      const va = a >= 0 ? out[a] : b < tableSize ? out[b] : i / (tableSize - 1);
      const vb = b < tableSize ? out[b] : va;
      out[i] = a >= 0 && b < tableSize ? va + ((vb - va) * (i - a)) / (b - a) : a >= 0 ? va : vb;
    }
    for (let i = 1; i < tableSize; i++) out[i] = Math.max(out[i], out[i - 1]);
    return out;
  });
  const lookup = (t, v) => {
    const p = Math.max(0, Math.min(1, v)) * (t.length - 1);
    const i = Math.min(t.length - 2, Math.floor(p));
    return t[i] + (t[i + 1] - t[i]) * (p - i);
  };
  return { matrix, offset, tables, apply: (x) => predict(x).map((v, ch) => lookup(tables[ch], v)) };
}

const fitCache = new Map();

/** Filter primitives proofing a press: separate with the profile, simulate with the options. */
export function cmykProofBody(profile, opts = {}) {
  const key = `${profile}|${opts.intent}|${opts.bpc}|${opts.paper}|${opts.black}`;
  let fit = fitCache.get(key);
  if (!fit) {
    fit = fitColorTransform((rgb) => proofCmyk(rgb, profile, opts));
    fitCache.set(key, fit);
  }
  return `${matrixMarkup(fit.matrix, fit.offset)}${transferMarkup(fit.tables)}`;
}

/** Resolve a proof device ('cmyk:<id>' | 'rgb:<id>', 'document' for the document's own) for a document. */
export function proofDevice(app, doc, device) {
  const [kind, id] = String(device || 'cmyk:document').split(':');
  if (kind === 'rgb') return { kind: 'rgb', id: id === 'document' ? documentRgbSpace(app, doc) : id };
  return { kind: 'cmyk', id: id === 'document' || !id ? documentCmykProfile(app, doc) : id };
}

/** Filter body for a proof kind of view.js's PROOFS, or null to keep the built-in filter. */
export function proofBody(app, kind) {
  const doc = app.editor?.doc;
  const cs = colorSettings(app);
  if (kind === 'cmyk') return cmykProofBody(documentCmykProfile(app, doc), { intent: cs.intent, bpc: cs.bpc });
  if (kind === 'mac18' || kind === 'srgb' || kind === 'monitor') return rgbProofBody(kind);
  if (kind === 'custom') {
    const p = proofSettings(app);
    const dev = proofDevice(app, doc, p.device);
    if (dev.kind === 'rgb') {
      if (p.preserve) return rgbProofBody(dev.id);
      // Converted colors keep their look; only colors outside the device gamut change.
      const from = documentRgbSpace(app, doc);
      const fit = fitColorTransform((rgb) => convertRgb(convertRgb(rgb, 'srgb', dev.id), dev.id, 'srgb'), 7);
      return from === dev.id ? '<feColorMatrix type="identity"/>' : `${matrixMarkup(fit.matrix, fit.offset)}${transferMarkup(fit.tables)}`;
    }
    return cmykProofBody(dev.id, { intent: p.intent, bpc: cs.bpc, paper: p.paper, black: p.black });
  }
  return null;
}

/** Menu label of the document CMYK proof. */
export function documentCmykLabel(app) {
  return `Document CMYK: ${cmykProfile(documentCmykProfile(app, app.editor?.doc)).label}`;
}
