/**
 * Sheets: paper layout in millimetres with an original title block and
 * viewports showing views at their scale. Plan views are placed as
 * vectors (their plan graphics transformed to paper space); 3D views,
 * elevations and sections are placed as rendered images.
 */
import { PlanBuilder, W, INK, BG } from './plan.js';
import { SHEET_SIZES } from './props.js';
import { bboxUnion } from './geom.js';
import { scaleLabel } from './units.js';
import { revisionsOnSheet } from './revisions.js';

export function sheetSize(sheet) {
  return SHEET_SIZES.find((s) => s.id === sheet.size) || SHEET_SIZES[2];
}

/** Title block and border graphics in paper millimetres. */
export function titleBlock(doc, sheet) {
  const { w, h: H } = sheetSize(sheet);
  const b = new PlanBuilder();
  const m = 10;
  const strip = Math.min(130, w * 0.18);
  // Paper and surroundings.
  b.fill(
    [
      [-5000, -5000],
      [w + 5000, -5000],
      [w + 5000, H + 5000],
      [-5000, H + 5000],
    ],
    [
      [
        [0, 0],
        [0, H],
        [w, H],
        [w, 0],
      ],
    ],
    INK(22),
  );
  b.poly(
    [
      [0, 0],
      [w, 0],
      [w, H],
      [0, H],
    ],
    true,
    W.thin,
  );
  b.poly(
    [
      [m, m],
      [w - m, m],
      [w - m, H - m],
      [m, H - m],
    ],
    true,
    W.heavy,
  );
  const x0 = w - m - strip;
  b.line([x0, m], [x0, H - m], W.medium);
  const p = doc.project;
  const rows = [
    { label: 'PROJECT', value: p.name, size: 4.2, h: 26 },
    { label: 'PROJECT NUMBER', value: p.number, size: 3, h: 14 },
    { label: 'CLIENT', value: p.client, size: 3, h: 14 },
    { label: 'ADDRESS', value: p.address, size: 2.6, h: 14 },
    { label: 'DRAWN BY', value: sheet.drawnBy || p.author, size: 2.6, h: 12 },
    { label: 'CHECKED BY', value: sheet.checkedBy, size: 2.6, h: 12 },
    { label: 'DATE', value: sheet.issueDate || new Date().toISOString().slice(0, 10), size: 2.6, h: 12 },
    { label: 'STATUS', value: p.status, size: 2.6, h: 12 },
  ];
  let y = H - m;
  for (const r of rows) {
    y -= r.h;
    b.line([x0, y], [w - m, y], W.thin);
    b.text([x0 + 3, y + r.h - 3.2], r.label, { size: 1.8, align: 'left', baseline: 'middle', color: INK(150) });
    b.text([x0 + 3, y + r.h * 0.42], r.value || '', { size: r.size, align: 'left', baseline: 'middle', bold: r.size > 3.5 });
  }
  // Revisions clouded on this sheet, newest at the bottom, just above the sheet name.
  const revs = revisionsOnSheet(doc, sheet).slice(-8);
  if (revs.length) {
    const rh = 6;
    const top = m + 62 + (revs.length + 1) * rh + 6;
    const cx = [x0 + 3, x0 + 14, x0 + strip - 26];
    b.line([x0, top], [w - m, top], W.medium);
    b.text([x0 + 3, top - 3], 'REVISIONS', { size: 1.8, align: 'left', color: INK(150) });
    revs.forEach((r, i) => {
      const yy = top - rh * (i + 1) - 3;
      b.line([x0, yy - rh / 2], [w - m, yy - rh / 2], W.thin, 0, INK(90));
      b.text([cx[0], yy], String(r.number ?? r.seq), { size: 2.2, align: 'left', bold: true });
      b.text([cx[1], yy], clip(r.description || '', Math.floor((strip - 42) / 1.4)), { size: 2.2, align: 'left' });
      b.text([cx[2], yy], r.date || '', { size: 2, align: 'left' });
    });
  }
  // Sheet name and number at the bottom of the strip.
  const nb = m + 34;
  b.line([x0, nb], [w - m, nb], W.medium);
  b.text([x0 + 3, nb + 20], 'SHEET NAME', { size: 1.8, align: 'left', color: INK(150) });
  b.text([x0 + 3, nb + 12], sheet.name || '', { size: 3.6, align: 'left', bold: true });
  b.line([x0, nb + 28], [w - m, nb + 28], W.thin);
  b.text([x0 + 3, m + 30], 'SHEET', { size: 1.8, align: 'left', color: INK(150) });
  b.text([x0 + strip / 2, m + 15], sheet.number || '', { size: 10, bold: true });
  return { builder: b, area: { x0: m + 5, y0: m + 5, x1: x0 - 5, y1: H - m - 5 } };
}

function clip(s, n) {
  return s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s;
}

/**
 * Paper-space graphics for a plan viewport: every element of the placed
 * view transformed by p' = at + (p - center) / scale.
 */
export function planViewportGraphics(scene, view, viewport, pc) {
  const els = scene.planCandidates(view);
  const parts = [];
  let bounds = null;
  for (const el of els) {
    if (el.kind === 'section' || el.kind === 'elevation') continue;
    const g = scene.planOf(view, el, pc);
    if (!g) continue;
    parts.push({ el, g });
    bounds = bboxUnion(bounds, scene.planBounds(view, el.id));
  }
  const s = +view.scale || 100;
  const center = viewport.center || (bounds ? [(bounds.x0 + bounds.x1) / 2, (bounds.y0 + bounds.y1) / 2] : [0, 0]);
  const at = viewport.at;
  const T = (p) => [at[0] + (p[0] - center[0]) / s, at[1] + (p[1] - center[1]) / s];
  // One transformed builder per element keeps the draw order of plans.
  const items = [];
  for (const { el, g } of parts) {
    const b = new PlanBuilder();
    for (const l of g.lines) b.lines.push({ ...l, a: T(l.a), b: T(l.b) });
    for (const f of g.fills) b.fills.push({ ...f, poly: f.poly.map(T), holes: (f.holes || []).map((hh) => hh.map(T)) });
    for (const t of g.texts) b.texts.push({ ...t, at: T(t.at), size: t.size / s });
    items.push({ key: `${viewport.id}:${el.id}`, kind: el.kind, builder: b });
  }
  const size = bounds ? [(bounds.x1 - bounds.x0) / s, (bounds.y1 - bounds.y0) / s] : [100, 80];
  const rect = { x0: at[0] - size[0] / 2, y0: at[1] - size[1] / 2, x1: at[0] + size[0] / 2, y1: at[1] + size[1] / 2 };
  const frame = new PlanBuilder();
  viewportTitle(frame, view, rect, scene.doc);
  frame.pick([
    [rect.x0, rect.y0],
    [rect.x1, rect.y0],
    [rect.x1, rect.y1],
    [rect.x0, rect.y1],
  ]);
  return { builder: frame, items, rect, center };
}

/** Viewport title: a bubble with the view number, the name and the scale. */
export function viewportTitle(b, view, rect, doc) {
  const y = rect.y0 - 8;
  const x = rect.x0;
  const circle = [];
  for (let i = 0; i < 28; i++) circle.push([x + 4.5 + Math.cos((i / 28) * Math.PI * 2) * 4.5, y + Math.sin((i / 28) * Math.PI * 2) * 4.5]);
  b.fill(circle, [], BG);
  b.poly(circle, true, W.light);
  b.text([x + 4.5, y], String(view.sheetNumber || '1'), { size: 3 });
  b.text([x + 12, y + 1.6], view.name, { size: 3.2, align: 'left', bold: true });
  b.line([x + 10.5, y - 0.8], [Math.max(x + 60, x + 12 + view.name.length * 2.2), y - 0.8], W.medium);
  b.text([x + 12, y - 3.6], view.kind === 'view3d' ? '' : `Scale ${scaleLabel(+view.scale || 100, doc.units)}`, { size: 2.2, align: 'left' });
}
