/**
 * Mockup commands: Object > Mockup > Make, Release, Edit Art and Detect
 * Surface, plus the helpers the panel and the canvas widgets share.
 */
import { UserError } from '../../lib/errors.js';
import { invert, apply } from '../../lib/matrix.js';
import { nodeBounds } from '../../model/geometry.js';
import { isEnvelope } from '../envelope/envelope-model.js';
import { assetPixels } from '../trace/trace-runner.js';
import { isMockup, mockupOf, mockupParts, mockupCorners, makeMockup, releaseMockup, setEditingArt, editingArt, setMockupCorners, fitOf } from './mockup-model.js';
import { perspectiveMesh, quadBounds, rectQuad, isConvexQuad } from './perspective.js';
import { detectSurface } from './detect.js';

/** Mockups the commands act on: selected ones, or the ones holding the selection. */
export function targetMockups(editor) {
  if (!editor) return [];
  const out = new Map();
  for (const id of editor.selection) {
    const m = mockupOf(editor.doc, id);
    if (m && !editor.doc.isLocked(m.id)) out.set(m.id, m);
  }
  return [...out.values()];
}

/** The single target mockup, or null. */
export function singleMockup(editor) {
  const ms = targetMockups(editor);
  return ms.length === 1 ? ms[0] : null;
}

/**
 * What Make would use: { photo, art } with the largest selected placed
 * image as the photo and every other selected object as the art, or null.
 */
export function makeTargets(editor) {
  if (!editor) return null;
  const doc = editor.doc;
  const top = editor.topSelection().filter((id) => {
    const n = doc.get(id);
    return n && n.type !== 'layer' && !doc.isLocked(id) && !isMockup(n) && !mockupOf(doc, id);
  });
  let photo = null;
  let best = -1;
  for (const id of top) {
    const n = doc.get(id);
    if (n.type !== 'image') continue;
    const b = nodeBounds(doc, n);
    const a = b ? b.w * b.h : 0;
    if (a > best) {
      best = a;
      photo = n;
    }
  }
  const art = top.filter((id) => id !== photo?.id);
  return photo && art.length ? { photo, art } : null;
}

/** Corners shown and edited for a mockup in the perspective fit, or null. */
export function editableCorners(doc, node) {
  if (!isMockup(node) || effectiveFit(doc, node) !== 'perspective' || editingArt(doc, node)) return null;
  return mockupCorners(doc, node);
}

/**
 * The fit in effect: 'perspective' only while the art's mesh still is the
 * perspective mesh of its corners (dragging single mesh points with Direct
 * Selection bends it into a free mesh).
 */
export function effectiveFit(doc, node) {
  if (fitOf(node) === 'mesh') return 'mesh';
  const { art } = mockupParts(doc, node);
  const mesh = art?.live?.mesh;
  if (!mesh) return 'perspective';
  const q = mockupCorners(doc, node);
  const ref = q && isConvexQuad(q) ? perspectiveMesh(q, mesh.rows === mesh.cols ? mesh.rows : null) : null;
  if (!ref || ref.rows !== mesh.rows || ref.cols !== mesh.cols) return 'mesh';
  const b = quadBounds(q);
  const tol = Math.max(1e-3, Math.hypot(b.w, b.h) * 1e-4);
  for (let i = 0; i < mesh.points.length; i++) {
    const p = mesh.points[i];
    const r = ref.points[i];
    if (Math.abs(p.x - r.x) > tol || Math.abs(p.y - r.y) > tol) return 'mesh';
  }
  return 'perspective';
}

// ---- commands ----

export function makeCommand(app) {
  const ed = app.editor;
  const t = makeTargets(ed);
  if (!t) throw new UserError('Select artwork and a placed photo to make a mockup.');
  let id = null;
  ed.doc.transact('Make Mockup', () => {
    id = makeMockup(ed.doc, t.photo.id, t.art);
  });
  if (!id) throw new UserError('The artwork could not be placed on the photo.');
  ed.select([id]);
  app.notify('Drag the corner handles to place the art on the photo, or use Detect Surface.', { polite: true });
  return id;
}

export function releaseCommand(app) {
  const ed = app.editor;
  const out = [];
  ed.doc.transact('Release Mockup', () => {
    for (const m of targetMockups(ed)) out.push(...releaseMockup(ed.doc, m.id));
  });
  ed.select(out.filter((id) => ed.doc.has(id)));
  return out;
}

/** Start or stop editing the art in place (isolated, so the Selection tool reaches it). */
export function toggleEditArt(app, { on = null } = {}) {
  const ed = app.editor;
  const m = singleMockup(ed);
  if (!m) return false;
  const doc = ed.doc;
  const next = on ?? !editingArt(doc, m);
  let envId = null;
  doc.transact(next ? 'Edit Mockup Art' : 'Finish Editing Mockup Art', () => {
    envId = setEditingArt(doc, m.id, next);
  });
  if (!envId) return false;
  if (next) {
    app.commands.run('object.isolate', { id: envId });
    ed.select(doc.get(envId).children.slice());
    app.notify('Editing the mockup art. Press Escape or choose Finish Editing when done.', { polite: true });
  } else {
    if (ed.isolation && (ed.isolation === envId || doc.isAncestor(envId, ed.isolation))) app.commands.run('object.exitIsolation');
    ed.select([m.id]);
  }
  return true;
}

/** Stop editing the art of mockups whose isolation ended (Escape, Exit Isolation Mode). */
export function finishEditingOutsideIsolation(editor) {
  const doc = editor.doc;
  const stale = [];
  doc.walk((n) => {
    if (isEnvelope(n) && n.live.editing === 'contents' && isMockup(doc.get(n.parent))) {
      const inside = editor.isolation && (editor.isolation === n.id || doc.isAncestor(n.id, editor.isolation));
      if (!inside) stale.push(n.parent);
    }
  });
  if (!stale.length) return;
  doc.transact('Finish Editing Mockup Art', () => {
    for (const id of stale) setEditingArt(doc, id, false);
  });
}

/**
 * Detect Surface: snap the art's corners to the flat region of the photo
 * under the art's center. Resolves to the new corners, or throws a
 * readable error when no clear surface is there.
 */
export async function detectCommand(app, { tolerance = 0.5 } = {}) {
  const ed = app.editor;
  const m = singleMockup(ed);
  if (!m) throw new UserError('Select a mockup.');
  const doc = ed.doc;
  const { photo } = mockupParts(doc, m);
  if (!photo) throw new UserError('This mockup has no photo.');
  const q0 = mockupCorners(doc, m) || rectQuad(nodeBounds(doc, photo));
  const center = q0.reduce((s, p) => ({ x: s.x + p.x / 4, y: s.y + p.y / 4 }), { x: 0, y: 0 });
  const px = await assetPixels(doc, photo.asset, null);
  const sx = px.width / photo.width;
  const sy = px.height / photo.height;
  const local = apply(invert(photo.transform || [1, 0, 0, 1, 0, 0]), center.x, center.y);
  const found = detectSurface(px, local.x * sx, local.y * sy, { tolerance });
  if (!found) throw new UserError('No clear flat surface was found under the art. Place the corners by hand, or move the art over the surface and try again.');
  const cur = doc.get(m.id);
  const ph = mockupParts(doc, cur).photo;
  if (!ph || ph.asset !== photo.asset) return null; // changed meanwhile
  const T = ph.transform || [1, 0, 0, 1, 0, 0];
  const quad = found.quad.map((p) => apply(T, p.x / sx, p.y / sy));
  let ok = false;
  doc.transact('Detect Surface', () => {
    ok = setMockupCorners(doc, m.id, quad);
  });
  if (!ok) throw new UserError('The detected surface could not be used.');
  app.notify('The art now sits on the detected surface.', { polite: true });
  return quad;
}

/** Put the art over the whole photo. */
export function fitToPhoto(app) {
  const ed = app.editor;
  const m = singleMockup(ed);
  if (!m) return;
  const { photo } = mockupParts(ed.doc, m);
  if (!photo) return;
  const T = photo.transform || [1, 0, 0, 1, 0, 0];
  const quad = rectQuad({ x: 0, y: 0, w: photo.width, h: photo.height }).map((p) => apply(T, p.x, p.y));
  ed.doc.transact('Fit Art to Photo', () => setMockupCorners(ed.doc, m.id, quad));
}

export { editingArt };
