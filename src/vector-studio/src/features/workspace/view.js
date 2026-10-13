/**
 * View menu features: Trim View, Presentation Mode, Proof Setup and Proof
 * Colors, Rotate View presets and Rotate View to Selection, saved views
 * (New View / Edit Views, stored in the document), Print Tiling with its
 * tool, global and video rulers, Show Template, Overprint Preview and the
 * Gradient Annotator / Corner Widget switches.
 */
import { h } from '../../lib/dom.js';
import { uid } from '../../lib/ids.js';
import { openDialog } from '../../ui/dialogs/dialog.js';
import { viewHooks } from '../../render/canvas-view.js';
import { overlayHooks } from '../../render/overlay.js';
import { Tool } from '../../tools/tool.js';
import { startPresentation } from './presentation.js';

// ---- proofing ----

/**
 * Proof setups. Each becomes a View > Proof Setup entry; its filter is an
 * SVG color matrix (rows of 5) unless a feature module supplies the filter
 * primitives with proofHooks.body (color-managed proofs built from the
 * color settings). `label` may be a function of the app.
 */
export const PROOFS = {
  cmyk: { label: 'Working CMYK (approximate press)', space: 'sRGB' },
  mac18: { label: 'Legacy Mac RGB (Gamma 1.8)', space: 'sRGB', needsHook: true },
  srgb: { label: 'Internet Standard RGB (sRGB)', space: 'sRGB', needsHook: true },
  monitor: { label: 'Monitor RGB', space: 'sRGB', needsHook: true },
  grayscale: { label: 'Grayscale', space: 'sRGB' },
  // Simulations of dichromacy at full severity (Machado, Oliveira and Fernandes, 2009), in linear RGB.
  protanopia: { label: 'Color Blindness: Protanopia', space: 'linearRGB', m: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998] },
  deuteranopia: { label: 'Color Blindness: Deuteranopia', space: 'linearRGB', m: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881] },
  tritanopia: { label: 'Color Blindness: Tritanopia', space: 'linearRGB', m: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039] },
  // Set up with View > Proof Setup > Customize (no menu entry of its own).
  custom: { label: 'Custom', space: 'sRGB', needsHook: true, menu: false },
};

/**
 * proofHooks.body(kind) -> filter primitives markup (or null for the built-in filter)
 * proofHooks.canvas(editor) -> true when the canvas proof is drawn by a canvas post-process instead
 */
export const proofHooks = { body: null, canvas: null };

const matrixValues = (m) => [m[0], m[1], m[2], 0, 0, m[3], m[4], m[5], 0, 0, m[6], m[7], m[8], 0, 0, 0, 0, 0, 1, 0].map((v) => Number(v.toFixed(6))).join(' ');

/** SVG filter markup for a proof. */
export function proofFilterMarkup(id, kind) {
  const p = PROOFS[kind];
  if (!p) return '';
  let body = proofHooks.body?.(kind) || null;
  if (body) return `<filter id="${id}" color-interpolation-filters="sRGB" x="0" y="0" width="100%" height="100%">${body}</filter>`;
  if (kind === 'grayscale') body = '<feColorMatrix type="saturate" values="0"/>';
  else if (kind === 'cmyk') {
    // Press gamut: saturated colors pull in, paper white and solid black do not reach the screen's extremes.
    body = '<feColorMatrix type="saturate" values="0.8"/><feComponentTransfer><feFuncR type="linear" slope="0.9" intercept="0.045"/><feFuncG type="linear" slope="0.9" intercept="0.04"/><feFuncB type="linear" slope="0.88" intercept="0.035"/></feComponentTransfer>';
  } else if (p.m) body = `<feColorMatrix type="matrix" values="${matrixValues(p.m)}"/>`;
  else body = '<feColorMatrix type="identity"/>';
  return `<filter id="${id}" color-interpolation-filters="${p.space}" x="0" y="0" width="100%" height="100%">${body}</filter>`;
}

let filtersHost = null;

/** Install the proof filters (an invisible SVG in the page); `refresh` rebuilds them after settings change. */
export function ensureProofFilters(refresh = false) {
  if (filtersHost?.isConnected && !refresh) return;
  if (!filtersHost?.isConnected) {
    filtersHost = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    filtersHost.setAttribute('aria-hidden', 'true');
    filtersHost.setAttribute('width', '0');
    filtersHost.setAttribute('height', '0');
    filtersHost.style.position = 'absolute';
    document.body.append(filtersHost);
  }
  filtersHost.innerHTML = `<defs>${Object.keys(PROOFS).map((k) => proofFilterMarkup(`vs-proof-${k}`, k)).join('')}</defs>`;
}

/** Apply the active editor's proof to its canvas and to the paint swatches in the panels. */
export function applyProof(app, { refresh = false } = {}) {
  const ed = app.editor;
  const on = Boolean(ed?.viewOptions.proofColors);
  const kind = ed?.viewOptions.proof || 'cmyk';
  if (on || refresh) ensureProofFilters(refresh);
  for (const [editor, view] of app.views) {
    const vOn = editor.viewOptions.proofColors && !proofHooks.canvas?.(editor);
    view.art.style.filter = vOn ? `url(#vs-proof-${editor.viewOptions.proof || 'cmyk'})` : '';
  }
  app.root.classList.toggle('proof-colors', on);
  if (on) app.root.style.setProperty('--proof-filter', `url(#vs-proof-${kind})`);
  else app.root.style.removeProperty('--proof-filter');
}

// ---- rotate view ----

export const ROTATE_PRESETS = [180, 150, 135, 120, 90, 60, 45, 30, 15, 0, -15, -30, -45, -60, -90, -120, -135, -150, -180];

/** View rotation in degrees (0..360) that levels the selection's bounding box. */
export function levelRotation(editor) {
  const f = editor.selectionFrame();
  if (!f) return null;
  return (((-f.angle % 360) + 360) % 360);
}

// ---- saved views ----

export function savedViews(doc) {
  return doc.root.views || [];
}

/** The current view as a saved view: zoom, the document point at the center, rotation. */
export function captureView(editor, name) {
  const v = editor.view;
  const c = v.toDoc(v.width / 2, v.height / 2);
  return { id: uid('vw'), name, zoom: v.zoom, cx: c.x, cy: c.y, rotation: v.rotation, artboard: editor.activeArtboard };
}

export function restoreView(editor, sv) {
  editor.view.set({ zoom: sv.zoom, rotation: sv.rotation || 0 });
  editor.view.centerOn(sv.cx, sv.cy);
  if (Number.isInteger(sv.artboard) && sv.artboard < editor.doc.artboards.length) editor.setActiveArtboard(sv.artboard);
  editor.viewChanged();
}

async function editViewsDialog(app, editor) {
  const doc = editor.doc;
  let views = savedViews(doc).map((v) => ({ ...v }));
  const list = h('ul.ev-list', { role: 'listbox', 'aria-label': 'Saved views' });
  const name = h('input#ev-name', { type: 'text', autocomplete: 'off', spellcheck: false });
  let sel = views[0]?.id || null;
  const render = () => {
    list.replaceChildren(
      ...views.map((v) =>
        h(
          'li.ev-item',
          { role: 'option', tabindex: v.id === sel ? '0' : '-1', 'aria-selected': String(v.id === sel), onclick: () => pick(v.id), onkeydown: (e) => keys(e, v.id) },
          h('span.ev-name', v.name),
          h('span.ev-meta', `${Math.round(v.zoom * 1000) / 10}%${v.rotation ? `, ${Math.round(v.rotation)}°` : ''}`),
        ),
      ),
    );
    if (!views.length) list.append(h('li.panel-empty', 'No saved views.'));
    const cur = views.find((v) => v.id === sel);
    name.value = cur?.name || '';
    name.disabled = del.disabled = !cur;
  };
  const pick = (id) => {
    sel = id;
    render();
    list.querySelector('[aria-selected="true"]')?.focus();
  };
  const keys = (e, id) => {
    const i = views.findIndex((v) => v.id === id);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = views[Math.max(0, Math.min(views.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (n) pick(n.id);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      remove();
    }
  };
  const remove = () => {
    const i = views.findIndex((v) => v.id === sel);
    if (i < 0) return;
    views.splice(i, 1);
    sel = views[Math.min(i, views.length - 1)]?.id || null;
    render();
  };
  name.addEventListener('input', () => {
    const cur = views.find((v) => v.id === sel);
    if (cur) {
      cur.name = name.value;
      list.querySelector('[aria-selected="true"] .ev-name').textContent = name.value;
    }
  });
  const del = h('button.btn.small', { type: 'button', onclick: remove }, 'Delete');
  render();
  const ok = await openDialog({
    title: 'Edit Views',
    body: h('div.form.edit-views', list, h('div.form-row', h('label', { for: 'ev-name' }, 'Name'), name), h('div.ev-actions', del)),
    buttons: [
      { label: 'Cancel', value: false },
      { label: 'OK', value: true, primary: true },
    ],
  });
  if (!ok) return;
  views = views.map((v) => ({ ...v, name: v.name.trim() || 'View' }));
  doc.transact('Edit Views', () => doc.updateRoot({ views }));
}

// ---- print tiling ----

export const PAPER_SIZES = [
  { value: 'letter', label: 'Letter (8.5 × 11 in)', w: 612, h: 792 },
  { value: 'legal', label: 'Legal (8.5 × 14 in)', w: 612, h: 1008 },
  { value: 'tabloid', label: 'Tabloid (11 × 17 in)', w: 792, h: 1224 },
  { value: 'a4', label: 'A4 (210 × 297 mm)', w: 595.28, h: 841.89 },
  { value: 'a3', label: 'A3 (297 × 420 mm)', w: 841.89, h: 1190.55 },
];

/** Page setup for tiling: { w, h, margin } in points (orientation applied). */
export function tilingPage(app) {
  const p = app.prefs.get('printTiling') || {};
  const paper = PAPER_SIZES.find((s) => s.value === p.paper) || PAPER_SIZES[0];
  const land = p.orientation === 'landscape';
  return { w: land ? paper.h : paper.w, h: land ? paper.w : paper.h, margin: p.margin ?? 18 };
}

/**
 * Page tiles covering the artboards: [{ x, y, w, h, n }] in document
 * space. Tiles line up from the tiling origin (the first artboard's
 * top-left unless moved with the Print Tiling tool).
 */
export function printTiles(doc, page) {
  const boards = doc.artboards;
  if (!boards.length) return [];
  const o = doc.root.printTiling || { x: boards[0].x, y: boards[0].y };
  const out = [];
  const seen = new Set();
  for (const a of boards) {
    const i0 = Math.floor((a.x - o.x) / page.w + 1e-9);
    const i1 = Math.ceil((a.x + a.w - o.x) / page.w - 1e-9);
    const j0 = Math.floor((a.y - o.y) / page.h + 1e-9);
    const j1 = Math.ceil((a.y + a.h - o.y) / page.h - 1e-9);
    for (let j = j0; j < j1; j++) {
      for (let i = i0; i < i1; i++) {
        const key = `${i},${j}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ x: o.x + i * page.w, y: o.y + j * page.h, w: page.w, h: page.h, i, j });
      }
    }
  }
  out.sort((p, q) => p.j - q.j || p.i - q.i);
  out.forEach((t, k) => (t.n = k + 1));
  return out;
}

function drawPrintTiles(ctx, editor, page) {
  const v = editor.view;
  ctx.save();
  ctx.font = '10px Inter, system-ui, sans-serif';
  ctx.lineWidth = 1;
  for (const t of printTiles(editor.doc, page)) {
    const quad = (r) => {
      const pts = [v.toScreen(r.x, r.y), v.toScreen(r.x + r.w, r.y), v.toScreen(r.x + r.w, r.y + r.h), v.toScreen(r.x, r.y + r.h)];
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      return pts;
    };
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = 'rgba(90, 90, 90, 0.85)';
    const pts = quad(t);
    ctx.stroke();
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = 'rgba(90, 90, 90, 0.6)';
    quad({ x: t.x + page.margin, y: t.y + page.margin, w: t.w - page.margin * 2, h: t.h - page.margin * 2 });
    ctx.stroke();
    ctx.fillStyle = 'rgba(70, 70, 70, 0.9)';
    ctx.fillText(String(t.n), pts[0].x + 4, pts[0].y + 12);
  }
  ctx.restore();
}

/** Print Tiling tool: drag to move the page grid; double-click resets it; options set the paper. */
export class PrintTilingTool extends Tool {
  static id = 'print-tiling';
  static label = 'Print Tiling Tool';
  static icon = 'tool-print-tiling';
  static hint = 'Drag to move the printed page tiles | Double-click to reset them | Double-click the tool for paper options';

  activate() {
    this.setCursor('move');
    this.status();
    if (this.editor && !this.editor.viewOptions.printTiling) this.editor.setViewOption('printTiling', true);
  }

  onPointerDown(e) {
    const doc = this.editor.doc;
    const a = doc.artboards[0];
    const o = doc.root.printTiling || (a ? { x: a.x, y: a.y } : { x: 0, y: 0 });
    this.drag = { x0: e.x, y0: e.y, o, tx: doc.begin('Move Print Tiling') };
  }

  onPointerMove(e) {
    const d = this.drag;
    if (!d) return;
    this.editor.doc.updateRoot({ printTiling: { x: d.o.x + (e.x - d.x0), y: d.o.y + (e.y - d.y0) } });
  }

  onPointerUp() {
    this.drag?.tx.commit();
    this.drag = null;
  }

  cancel() {
    this.drag?.tx.cancel();
    this.drag = null;
  }

  onDoubleClick() {
    const doc = this.editor.doc;
    if (doc.root.printTiling) doc.transact('Reset Print Tiling', () => doc.updateRoot({ printTiling: null }));
  }

  async openOptions() {
    const app = this.app;
    const p = app.prefs.get('printTiling') || {};
    const v = await app.dialogs.form({
      title: 'Print Tiling',
      fields: [
        { key: 'paper', label: 'Paper size', type: 'select', value: p.paper || 'letter', options: PAPER_SIZES },
        { key: 'orientation', label: 'Orientation', type: 'radio', value: p.orientation || 'portrait', options: [{ value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' }] },
        { key: 'margin', label: 'Printer margin', type: 'length', value: p.margin ?? 18, min: 0 },
      ],
    });
    if (!v) return;
    app.prefs.set('printTiling', v);
    app.editor?.emit('overlay');
  }
}

// ---- video rulers ----

/** Rulers along the active artboard's edges with its center and the 90% / 80% safe areas. */
function drawVideoRulers(ctx, editor) {
  const a = editor.artboard();
  if (!a) return;
  const v = editor.view;
  ctx.save();
  ctx.strokeStyle = 'rgba(0, 150, 200, 0.9)';
  ctx.fillStyle = 'rgba(0, 120, 170, 0.95)';
  ctx.font = '9px Inter, system-ui, sans-serif';
  ctx.lineWidth = 1;
  const line = (x1, y1, x2, y2) => {
    const p = v.toScreen(x1, y1);
    const q = v.toScreen(x2, y2);
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
  };
  const step = Math.max(1, 10 ** Math.ceil(Math.log10(8 / v.zoom)));
  ctx.beginPath();
  for (let d = 0; d <= a.w + 1e-6; d += step) {
    const major = Math.round(d / step) % 10 === 0;
    const len = (major ? 10 : Math.round(d / step) % 5 === 0 ? 6 : 3) / v.zoom;
    line(a.x + d, a.y, a.x + d, a.y + len);
  }
  for (let d = 0; d <= a.h + 1e-6; d += step) {
    const major = Math.round(d / step) % 10 === 0;
    const len = (major ? 10 : Math.round(d / step) % 5 === 0 ? 6 : 3) / v.zoom;
    line(a.x, a.y + d, a.x + len, a.y + d);
  }
  // Center cross.
  const cx = a.x + a.w / 2;
  const cy = a.y + a.h / 2;
  const c = 12 / v.zoom;
  line(cx - c, cy, cx + c, cy);
  line(cx, cy - c, cx, cy + c);
  ctx.stroke();
  for (let d = step * 10; d <= a.w; d += step * 10) {
    const p = v.toScreen(a.x + d, a.y);
    ctx.fillText(String(Math.round(d)), p.x + 2, p.y + 18);
  }
  // Action-safe (90%) and title-safe (80%) areas.
  ctx.setLineDash([4, 4]);
  for (const k of [0.9, 0.8]) {
    ctx.beginPath();
    const r = { x: cx - (a.w * k) / 2, y: cy - (a.h * k) / 2, w: a.w * k, h: a.h * k };
    const pts = [v.toScreen(r.x, r.y), v.toScreen(r.x + r.w, r.y), v.toScreen(r.x + r.w, r.y + r.h), v.toScreen(r.x, r.y + r.h)];
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();
}

// ---- commands ----

export function installView(app) {
  const ed = () => app.editor;
  const hasDoc = (a) => Boolean(a.editor);
  const toggle = (id, key, label, shortcut, after) => ({
    id,
    label,
    shortcut,
    enabled: hasDoc,
    checked: (a) => Boolean(a.editor?.viewOptions[key]),
    run: () => {
      ed().setViewOption(key, !ed().viewOptions[key]);
      after?.(ed());
    },
  });
  const proofOn = (a) => Boolean(a.editor?.viewOptions.proofColors);
  app.commands.register([
    toggle('view.trim', 'trim', 'Trim View'),
    toggle('view.overprint', 'overprint', 'Overprint Preview', 'Alt+Shift+Mod+Y'),
    { id: 'view.presentation', label: 'Presentation Mode', enabled: (a) => Boolean(a.editor?.doc.artboards.length), run: () => startPresentation(app, ed()) },
    ...Object.entries(PROOFS).filter(([, p]) => p.menu !== false).map(([k, p]) => ({
      id: `view.proof.${k}`,
      label: (a) => (typeof p.label === 'function' ? p.label(a) : p.label),
      // RGB device proofs need the color management module.
      enabled: (a) => hasDoc(a) && (!p.needsHook || Boolean(proofHooks.body)),
      checked: (a) => (a.editor?.viewOptions.proof || 'cmyk') === k,
      run: () => {
        // Choosing a proof turns proofing on, so the choice shows right away.
        ed().viewOptions = { ...ed().viewOptions, proof: k, proofColors: true };
        ed().emit('view-options');
        applyProof(app);
      },
    })),
    { ...toggle('view.proofColors', 'proofColors', 'Proof Colors', undefined, () => applyProof(app)), checked: proofOn },
    ...ROTATE_PRESETS.map((deg) => ({
      id: `view.rotate.${deg}`,
      label: `${deg}°`,
      enabled: hasDoc,
      checked: (a) => Boolean(a.editor) && Math.abs(((a.editor.view.rotation - deg) % 360 + 360) % 360) < 1e-6,
      run: () => {
        ed().view.rotateView((360 + deg) % 360);
        ed().viewChanged();
      },
    })),
    {
      id: 'view.rotateToSelection',
      label: 'Rotate View to Selection',
      enabled: (a) => Boolean(a.editor?.selection.size),
      run: () => {
        const e = ed();
        const deg = levelRotation(e);
        if (deg == null) return;
        const b = e.selectionBounds(false);
        e.view.rotateView(deg);
        if (b) e.view.centerOn(b.x + b.w / 2, b.y + b.h / 2);
        e.viewChanged();
      },
    },
    toggle('view.printTiling', 'printTiling', (a) => (a.editor?.viewOptions.printTiling ? 'Hide Print Tiling' : 'Show Print Tiling')),
    toggle('view.template', 'template', (a) => (a.editor?.viewOptions.template === false ? 'Show Template' : 'Hide Template'), 'Shift+Mod+W'),
    toggle('view.globalRulers', 'globalRulers', (a) => (a.editor?.viewOptions.globalRulers ? 'Change to Artboard Rulers' : 'Change to Global Rulers'), 'Alt+Mod+R'),
    toggle('view.videoRulers', 'videoRulers', (a) => (a.editor?.viewOptions.videoRulers ? 'Hide Video Rulers' : 'Show Video Rulers')),
    toggle('view.gradientAnnotator', 'gradientAnnotator', (a) => (a.editor?.viewOptions.gradientAnnotator === false ? 'Show Gradient Annotator' : 'Hide Gradient Annotator'), 'Alt+Mod+G'),
    toggle('view.cornerWidget', 'cornerWidget', (a) => (a.editor?.viewOptions.cornerWidget === false ? 'Show Corner Widget' : 'Hide Corner Widget')),
    {
      id: 'view.newView',
      label: 'New View...',
      enabled: hasDoc,
      run: async (a) => {
        const e = ed();
        const v = await a.dialogs.form({ title: 'New View', fields: [{ key: 'name', label: 'Name', type: 'text', value: `View ${savedViews(e.doc).length + 1}` }] });
        if (!v) return;
        const view = captureView(e, v.name.trim() || `View ${savedViews(e.doc).length + 1}`);
        e.doc.transact('New View', () => e.doc.updateRoot({ views: [...savedViews(e.doc), view] }));
      },
    },
    { id: 'view.editViews', label: 'Edit Views...', enabled: (a) => Boolean(a.editor && savedViews(a.editor.doc).length), run: () => editViewsDialog(app, ed()) },
  ]);
  app.menuSources.set('savedViews', (a) => (a.editor ? savedViews(a.editor.doc).map((v) => ({ label: v.name, run: () => restoreView(a.editor, v) })) : []));
  app.registerTool(PrintTilingTool);

  // View > Hide Template hides template layers; Overprint Preview reaches the renderer as an option.
  viewHooks.artOptions.push((editor, opts) => {
    let out = opts;
    if (editor.viewOptions.template === false) {
      const prev = out.layerFilter;
      out = { ...out, layerFilter: (l) => !l.template && (!prev || prev(l)) };
    }
    if (editor.viewOptions.overprint) out = { ...out, overprint: true };
    return out;
  });
  viewHooks.clipArt.push((editor) => {
    if (!editor.viewOptions.trim || !editor.doc.artboards.length) return null;
    const p = new Path2D();
    for (const a of editor.doc.artboards) p.rect(a.x, a.y, a.w, a.h);
    return p;
  });
  overlayHooks.add((ctx, editor) => {
    if (editor.viewOptions.printTiling) drawPrintTiles(ctx, editor, tilingPage(app));
    if (editor.viewOptions.videoRulers) drawVideoRulers(ctx, editor);
  });
  // Global rulers measure from the first artboard; artboard rulers from the active one.
  app.rulerOrigin = (editor) => {
    if (!editor?.viewOptions.globalRulers) return null;
    const a = editor.doc.artboards[0];
    return a ? { x: a.x, y: a.y } : { x: 0, y: 0 };
  };
  app.on('active-editor', () => applyProof(app));
  app.on('chrome', () => applyProof(app));
}
