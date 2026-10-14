/**
 * Exports: PDF and SVG drawings (vector for plans and sheets, images for
 * 3D views, elevations and sections), PNG images, DXF lines, and the model
 * as IFC, OBJ and glTF. Drawings are exported black on white.
 */
import { download } from './storage.js';
import { encodeProject, safeFileName, NATIVE_EXT } from './native.js';
import { PdfPage, buildPdf } from './pdf.js';
import { renderViewImage } from '../views/snapshot.js';
import { KIND_Z } from '../render/renderer2d.js';
import { clipLine } from '../core/plan.js';
import { bbox, bboxUnion } from '../core/geom.js';
import { MODEL_KINDS } from '../core/scene.js';
import { sheetSize } from '../core/sheet.js';
import { toast } from '../ui/dialog.js';
import { exportScheduleCSV } from './files.js';
import { writeIFC } from './ifc.js';

const WEIGHT_MM = [0.13, 0.13, 0.18, 0.25, 0.35, 0.5, 0.7, 1.0];
const DASH_MM = { 1: [3, 1.5], 2: [1.6, 1], 3: [8, 1.6, 1.6, 1.6], 4: [0.4, 1.2] };

function baseName(app) {
  const v = app.activeView;
  return safeFileName(`${app.file?.name || app.doc.project.name || 'Project'}${v ? ` - ${v.name}` : ''}`);
}

export async function exportAs(app, format) {
  const view = app.activeView;
  switch (format) {
    case 'bdp':
      return download(await encodeProject(app.doc), `${safeFileName(app.file?.name || app.doc.project.name)}${NATIVE_EXT}`);
    case 'csv':
      if (view?.kind !== 'schedule') return toast('Open a schedule to export it as CSV.', { kind: 'error' });
      return exportScheduleCSV(app, view.id);
    case 'png':
      return exportPNG(app);
    case 'pdf':
      return exportPDF(app);
    case 'svg':
      return exportSVG(app);
    case 'dxf':
      return exportDXF(app);
    case 'ifc':
      return download(new Blob([writeIFC(app)], { type: 'application/x-step' }), `${safeFileName(app.file?.name || app.doc.project.name)}.ifc`);
    case 'obj':
      return exportOBJ(app);
    case 'glb':
      return exportGLB(app);
    default:
      return null;
  }
}

function requireGraphical(app) {
  const c = app.vc;
  if (!c?.graphical) {
    toast('Open a plan, sheet, section, elevation or 3D view to export it.', { kind: 'error' });
    return null;
  }
  return c;
}

// Raster -------------------------------------------------------------------------------

async function exportPNG(app) {
  const c = requireGraphical(app);
  if (!c) return;
  const vp = app.viewport;
  const scale = 2;
  const { canvas } = renderViewImage(app, app.activeView, vp.width * scale, vp.height * scale, { fit: false, camera: scaleCamera(c, scale) });
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  download(blob, `${baseName(app)}.png`);
}

/** Camera for rendering the current view at a higher pixel density. */
function scaleCamera(c, k) {
  const cam = structuredClone(c.cam);
  if (cam && 'zoom' in cam) cam.zoom *= k;
  return cam;
}

// Vector graphics of 2D views -----------------------------------------------------------

/** Items of the active 2D layer (plan or sheet) sorted in draw order. */
function layerItems(c) {
  c.sync();
  return [...c.layer.items.values()].filter((it) => !(c.app.flagsOf(it.id ?? '') & 4)).sort((a, b) => a.z - b.z);
}

/** Hatches the vector exports draw as lines; other patterns print as a light gray. */
const HATCHED = new Set([1, 2, 5, 8]);

function blend(col, white = 1) {
  // Ink is black on paper; colours are blended over white by their alpha.
  if (!col) return { rgb: [0, 0, 0], a: 1 };
  const a = (col[3] ?? 255) / 255;
  if (col[0] === -1) return { rgb: [0, 0, 0], a };
  if (col[0] === -2) return { rgb: [white, white, white], a };
  return { rgb: [col[0] / 255, col[1] / 255, col[2] / 255], a };
}

/**
 * Walk the drawable primitives of a 2D view in paper millimetres.
 * cb: { fill(poly, holes, rgb, a, pattern), line(a, b, wMM, dash, rgb, a), text(t, at, sizeMM) }
 */
function walk2D(app, c, T, s, cb) {
  const entries = [...c.layer.items.entries()].filter(([id]) => !(app.flagsOf(id) & 4));
  entries.sort((a, b) => a[1].z - b[1].z);
  // Per draw layer: fills, then lines (the screen order); text last.
  const zs = [...new Set(entries.map((e) => e[1].z))];
  for (const z of zs) {
    const group = entries.filter((e) => e[1].z === z);
    for (const [, it] of group)
      for (const f of it.g.fills) {
        let { rgb, a } = blend(f.color);
        if (f.pattern && !HATCHED.has(f.pattern)) {
          rgb = [0.72, 0.72, 0.72];
          a = 1;
        }
        cb.fill(f.poly.map(T), (f.holes || []).map((hh) => hh.map(T)), rgb, a, f.pattern || 0);
      }
    for (const [, it] of group)
      for (const l of it.g.lines) {
        const { rgb, a } = blend(l.c);
        cb.line(T(l.a), T(l.b), WEIGHT_MM[l.w || 1] * (app.settings.thinLines ? 0.6 : 1), DASH_MM[l.d] || null, rgb, a);
      }
  }
  for (const [, it] of entries) for (const t of it.g.texts) cb.text(t, T(t.at), t.size / s);
}

/** Page setup for the active 2D view: { w, h, T (model -> paper mm), s } */
function pageFor(app, c) {
  const view = app.activeView;
  if (view.kind === 'sheet') {
    const { w, h } = sheetSize(view);
    return { w, h, T: (p) => p, s: 1 };
  }
  const imp = app.doc.units.system === 'imperial';
  const sizes = imp ? [[431.8, 279.4], [609.6, 457.2], [914.4, 609.6], [1219.2, 914.4]] : [[420, 297], [594, 420], [841, 594], [1189, 841]];
  const b = c.extents() || { x0: 0, y0: 0, x1: 10000, y1: 8000 };
  let s = +view.scale || 100;
  const need = [(b.x1 - b.x0) / s + 30, (b.y1 - b.y0) / s + 30];
  let page = sizes.find(([w, h]) => w >= need[0] && h >= need[1]);
  if (!page) {
    page = sizes.at(-1);
    s = Math.max((b.x1 - b.x0) / (page[0] - 30), (b.y1 - b.y0) / (page[1] - 30));
  }
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  return { w: page[0], h: page[1], T: (p) => [(p[0] - cx) / s + page[0] / 2, (p[1] - cy) / s + page[1] / 2], s };
}

async function exportPDF(app) {
  const c = requireGraphical(app);
  if (!c) return;
  const view = app.activeView;
  let page;
  if (c.is2D) {
    const P = pageFor(app, c);
    page = new PdfPage(P.w, P.h);
    let curDash = null;
    walk2D(app, c, P.T, P.s, {
      fill(poly, holes, rgb, a, pattern) {
        if (a < 0.01) return;
        if (a < 0.99) page.alpha(a);
        page.color(rgb, false);
        page.polygon(poly, holes);
        if (a < 0.99) page.alpha(1);
        if (pattern === 1 || pattern === 2 || pattern === 5 || pattern === 8) hatch(page, poly, pattern);
      },
      line(p, q, w, dash, rgb, a) {
        if (a < 0.99) page.alpha(a);
        page.color(rgb, true);
        page.lineWidth(w);
        if (String(dash) !== String(curDash)) {
          page.dash(dash);
          curDash = dash;
        }
        page.line(p, q);
        if (a < 0.99) page.alpha(1);
      },
      text(t, at, size) {
        const { rgb } = blend(t.color);
        page.color(rgb, false);
        page.text(at, t.text.split('\n')[0], size, t.rot || 0, t.align || 'center', t.bold);
      },
    });
    // Images of model viewports on sheets.
    for (const m of c.modelViewports || []) {
      const { canvas } = renderViewImage(app, m.view, (m.rect.x1 - m.rect.x0) * 8, (m.rect.y1 - m.rect.y0) * 8, { fit: true });
      const jpeg = await jpegBytes(canvas);
      page.image(jpeg, canvas.width, canvas.height, m.rect.x0, m.rect.y0, m.rect.x1 - m.rect.x0, m.rect.y1 - m.rect.y0);
    }
  } else {
    const imp = app.doc.units.system === 'imperial';
    const [w, h] = imp ? [431.8, 279.4] : [420, 297];
    page = new PdfPage(w, h);
    const aspect = app.viewport.width / app.viewport.height;
    let iw = w - 20;
    let ih = iw / aspect;
    if (ih > h - 30) {
      ih = h - 30;
      iw = ih * aspect;
    }
    const { canvas } = renderViewImage(app, view, iw * 8, ih * 8, { fit: false, camera: scaleCamera(c, (iw * 8) / app.viewport.width) });
    page.image(await jpegBytes(canvas), canvas.width, canvas.height, (w - iw) / 2, (h - ih) / 2 + 5, iw, ih);
    page.color([0, 0, 0], false);
    page.text([(w - iw) / 2, 10], view.name, 4, 0, 'left', true);
  }
  download(buildPdf([page], view.name), `${baseName(app)}.pdf`);
}

function hatch(page, poly, pattern) {
  const b = bbox(poly);
  const sp = pattern === 8 ? 0.35 : pattern === 5 ? 1.1 : 1.6;
  page.color([0, 0, 0], true);
  page.lineWidth(0.09);
  page.dash(null);
  const dirs = pattern === 2 ? [1, -1] : [1];
  for (const d of dirs) {
    const span = b.x1 - b.x0 + b.y1 - b.y0;
    for (let k = -span; k <= span; k += sp * Math.SQRT2) {
      const p = d > 0 ? [b.x0 + k, b.y0] : [b.x0 + k, b.y1];
      const q = d > 0 ? [b.x0 + k + span, b.y0 + span] : [b.x0 + k + span, b.y1 - span];
      for (const [a, c] of clipLine(p, q, poly)) page.line(a, c);
    }
  }
}

async function jpegBytes(canvas) {
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
  return new Uint8Array(await blob.arrayBuffer());
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

async function exportSVG(app) {
  const c = requireGraphical(app);
  if (!c) return;
  if (!c.is2D) return toast('SVG export works for plans and sheets. Use PNG or PDF for this view.', { kind: 'error' });
  const P = pageFor(app, c);
  const out = [];
  const F = (p) => `${(+p[0]).toFixed(3)},${(P.h - p[1]).toFixed(3)}`;
  const col = (rgb) => `rgb(${rgb.map((v) => Math.round(v * 255)).join(',')})`;
  walk2D(app, c, P.T, P.s, {
    fill(poly, holes, rgb, a) {
      if (a < 0.01) return;
      const d = [poly, ...holes].map((l) => `M${l.map(F).join('L')}Z`).join('');
      out.push(`<path d="${d}" fill="${col(rgb)}" fill-opacity="${a.toFixed(2)}" fill-rule="evenodd"/>`);
    },
    line(p, q, w, dash, rgb, a) {
      out.push(`<line x1="${F(p).split(',')[0]}" y1="${F(p).split(',')[1]}" x2="${F(q).split(',')[0]}" y2="${F(q).split(',')[1]}" stroke="${col(rgb)}" stroke-width="${w}"${a < 0.99 ? ` stroke-opacity="${a.toFixed(2)}"` : ''}${dash ? ` stroke-dasharray="${dash.join(' ')}"` : ''} stroke-linecap="square"/>`);
    },
    text(t, at, size) {
      const [x, y] = F(at).split(',');
      const rot = (-(t.rot || 0) * 180) / Math.PI;
      const anchor = t.align === 'left' ? 'start' : t.align === 'right' ? 'end' : 'middle';
      out.push(`<text x="${x}" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="${size.toFixed(3)}"${t.bold ? ' font-weight="600"' : ''} text-anchor="${anchor}" dominant-baseline="middle"${rot ? ` transform="rotate(${rot.toFixed(3)} ${x} ${y})"` : ''}>${esc(t.text)}</text>`);
    },
  });
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${P.w}mm" height="${P.h}mm" viewBox="0 0 ${P.w} ${P.h}">\n<rect width="100%" height="100%" fill="#fff"/>\n${out.join('\n')}\n</svg>\n`;
  download(new Blob([svg], { type: 'image/svg+xml' }), `${baseName(app)}.svg`);
}

// DXF ------------------------------------------------------------------------------------

async function exportDXF(app) {
  const c = requireGraphical(app);
  if (!c?.is2D || app.activeView.kind === 'sheet') return toast('DXF export works for plan views.', { kind: 'error' });
  c.sync();
  const out = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LTYPE', '70', '1', '0', 'LTYPE', '2', 'CONTINUOUS', '70', '0', '3', 'Solid line', '72', '65', '73', '0', '40', '0.0', '0', 'ENDTAB', '0', 'TABLE', '2', 'LAYER'];
  const layers = new Set();
  for (const it of c.layer.items.values()) layers.add(layerName(it.kind));
  out.push('70', String(layers.size));
  for (const l of layers) out.push('0', 'LAYER', '2', l, '70', '0', '62', '7', '6', 'CONTINUOUS');
  out.push('0', 'ENDTAB', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES');
  const f = (v) => (Math.round(v * 1000) / 1000).toString();
  for (const [id, it] of c.layer.items) {
    if (app.flagsOf(id) & 4) continue;
    const L = layerName(it.kind);
    for (const l of it.g.lines) out.push('0', 'LINE', '8', L, '10', f(l.a[0]), '20', f(l.a[1]), '30', '0', '11', f(l.b[0]), '21', f(l.b[1]), '31', '0');
    for (const t of it.g.texts) out.push('0', 'TEXT', '8', L, '10', f(t.at[0]), '20', f(t.at[1]), '30', '0', '40', f(t.size), '1', String(t.text).split('\n')[0].replace(/[\r\n]/g, ' '), '50', f(((t.rot || 0) * 180) / Math.PI), '72', t.align === 'left' ? '0' : t.align === 'right' ? '2' : '1', '11', f(t.at[0]), '21', f(t.at[1]), '31', '0');
  }
  out.push('0', 'ENDSEC', '0', 'EOF');
  download(new Blob([out.join('\r\n')], { type: 'application/dxf' }), `${baseName(app)}.dxf`);
}

function layerName(kind) {
  return `A-${String(kind || 'misc').replace(/[A-Z]/g, (m) => `-${m}`).toUpperCase()}`;
}

// Meshes ------------------------------------------------------------------------------------

function modelMeshes(app) {
  const out = [];
  for (const k of MODEL_KINDS)
    for (const el of app.doc.all(k)) {
      const m = app.scene.mesh(el);
      if (m && m.pos.length) out.push({ el, m });
    }
  return out;
}

async function exportOBJ(app) {
  const lines = ['# Building Design OBJ export (millimetres, Z up)', `o ${safeFileName(app.doc.project.name)}`];
  let base = 1;
  for (const { el, m } of modelMeshes(app)) {
    lines.push(`g ${el.kind}_${el.id}`);
    const n = m.pos.length / 3;
    for (let i = 0; i < n; i++) lines.push(`v ${m.pos[i * 3].toFixed(2)} ${m.pos[i * 3 + 1].toFixed(2)} ${m.pos[i * 3 + 2].toFixed(2)} ${(m.col[i * 4] / 255).toFixed(3)} ${(m.col[i * 4 + 1] / 255).toFixed(3)} ${(m.col[i * 4 + 2] / 255).toFixed(3)}`);
    for (let i = 0; i < n; i++) lines.push(`vn ${(m.nrm[i * 3] / 127).toFixed(3)} ${(m.nrm[i * 3 + 1] / 127).toFixed(3)} ${(m.nrm[i * 3 + 2] / 127).toFixed(3)}`);
    for (let t = 0; t < n; t += 3) lines.push(`f ${base + t}//${base + t} ${base + t + 1}//${base + t + 1} ${base + t + 2}//${base + t + 2}`);
    base += n;
  }
  download(new Blob([lines.join('\n')], { type: 'model/obj' }), `${safeFileName(app.doc.project.name)}.obj`);
}

/** glTF 2.0 binary: one mesh per element, metres, Y up, vertex colours. */
export function buildGLB(app) {
  const meshes = modelMeshes(app);
  const bufs = [];
  let byteLength = 0;
  const bufferViews = [];
  const accessors = [];
  const gMeshes = [];
  const nodes = [];
  const pushView = (arr, target) => {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    const pad = (4 - (byteLength % 4)) % 4;
    if (pad) {
      bufs.push(new Uint8Array(pad));
      byteLength += pad;
    }
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.length, target });
    bufs.push(bytes);
    byteLength += bytes.length;
    return bufferViews.length - 1;
  };
  for (const { el, m } of meshes) {
    const n = m.pos.length / 3;
    const pos = new Float32Array(n * 3);
    const nrm = new Float32Array(n * 3);
    const col = new Uint8Array(n * 4);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) {
      const x = m.pos[i * 3] / 1000;
      const y = m.pos[i * 3 + 2] / 1000;
      const z = -m.pos[i * 3 + 1] / 1000;
      pos.set([x, y, z], i * 3);
      const v = [x, y, z];
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], v[k]);
        max[k] = Math.max(max[k], v[k]);
      }
      const nx = m.nrm[i * 3] / 127;
      const ny = m.nrm[i * 3 + 2] / 127;
      const nz = -m.nrm[i * 3 + 1] / 127;
      const l = Math.hypot(nx, ny, nz) || 1;
      nrm.set([nx / l, ny / l, nz / l], i * 3);
      col.set([m.col[i * 4], m.col[i * 4 + 1], m.col[i * 4 + 2], m.col[i * 4 + 3]], i * 4);
    }
    const pv = pushView(pos, 34962);
    const nv = pushView(nrm, 34962);
    const cv = pushView(col, 34962);
    accessors.push({ bufferView: pv, componentType: 5126, count: n, type: 'VEC3', min, max });
    accessors.push({ bufferView: nv, componentType: 5126, count: n, type: 'VEC3' });
    accessors.push({ bufferView: cv, componentType: 5121, normalized: true, count: n, type: 'VEC4' });
    const a = accessors.length;
    const transparent = m.col.some((v, i) => i % 4 === 3 && v < 250);
    gMeshes.push({ name: `${el.kind} ${el.id}`, primitives: [{ attributes: { POSITION: a - 3, NORMAL: a - 2, COLOR_0: a - 1 }, material: transparent ? 1 : 0 }] });
    nodes.push({ mesh: gMeshes.length - 1, name: `${el.kind} ${el.id}` });
  }
  const gltf = {
    asset: { version: '2.0', generator: 'Building Design' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes: gMeshes,
    materials: [
      { name: 'Opaque', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.8 }, doubleSided: true },
      { name: 'Glass', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.1 }, alphaMode: 'BLEND', doubleSided: true },
    ],
    accessors,
    bufferViews,
    buffers: [{ byteLength }],
  };
  const enc = new TextEncoder();
  let json = enc.encode(JSON.stringify(gltf));
  const jpad = (4 - (json.length % 4)) % 4;
  if (jpad) {
    const j = new Uint8Array(json.length + jpad);
    j.set(json);
    j.fill(0x20, json.length);
    json = j;
  }
  const bpad = (4 - (byteLength % 4)) % 4;
  const total = 12 + 8 + json.length + 8 + byteLength + bpad;
  const head = new DataView(new ArrayBuffer(20));
  head.setUint32(0, 0x46546c67, true);
  head.setUint32(4, 2, true);
  head.setUint32(8, total, true);
  head.setUint32(12, json.length, true);
  head.setUint32(16, 0x4e4f534a, true);
  const bin = new DataView(new ArrayBuffer(8));
  bin.setUint32(0, byteLength + bpad, true);
  bin.setUint32(4, 0x004e4942, true);
  return new Blob([head.buffer, json, bin.buffer, ...bufs, new Uint8Array(bpad)], { type: 'model/gltf-binary' });
}

async function exportGLB(app) {
  download(buildGLB(app), `${safeFileName(app.doc.project.name)}.glb`);
}

export { layerItems, bboxUnion, KIND_Z };
