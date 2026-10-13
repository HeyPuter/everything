/**
 * Mockups: artwork placed onto a photo, kept live and editable.
 *
 *   { type: 'group', live: { kind: 'mockup', fit: 'perspective' | 'mesh' },
 *     children: [photo (a placed image), art (an envelope)] }
 *
 * The art is an ordinary mesh envelope (features/envelope) around the
 * original artwork, so it stays editable and every consumer (rendering,
 * hit testing, export, Expand) already understands it. With the
 * 'perspective' fit its mesh is generated from four corners (a projective
 * mapping, see perspective.js) and the corners are what the user edits;
 * with the 'mesh' fit the mesh points are edited freely with Direct
 * Selection to follow curved surfaces.
 *
 * The photo's shading is carried onto the art by the 'mockupLighting'
 * raster effect on the envelope (lighting.js): it reads the image painted
 * below it in the same group, so it survives copying, Expand and export.
 */
import { createGroup } from '../../model/nodes.js';
import { registerLive } from '../../model/live.js';
import { nodeBounds } from '../../model/geometry.js';
import { isEnvelope } from '../envelope/envelope-model.js';
import { makeEnvelope, releaseEnvelope, expandEnvelope, resetWithMesh, setEditingContents } from '../envelope/envelope-ops.js';
import { perspectiveMesh, meshQuad, isConvexQuad, rectQuad } from './perspective.js';

export const KIND = 'mockup';
export const LIGHTING = 'mockupLighting';

export const LIGHTING_DEFAULTS = Object.freeze({ strength: 0.6, displace: 0 });

export const isMockup = (n) => Boolean(n && n.type === 'group' && n.live?.kind === KIND);

/** The mockup a node belongs to (itself or its closest mockup ancestor), or null. */
export function mockupOf(doc, id) {
  let n = doc.get(id);
  while (n && n.type !== 'layer' && n.type !== 'root') {
    if (isMockup(n)) return n;
    n = n.parent ? doc.get(n.parent) : null;
  }
  return null;
}

/** The photo (first image child) and art (first envelope child) of a mockup. */
export function mockupParts(doc, node) {
  let photo = null;
  let art = null;
  for (const c of node?.children || []) {
    const k = doc.get(c);
    if (!photo && k?.type === 'image') photo = k;
    else if (!art && isEnvelope(k)) art = k;
  }
  return { photo, art };
}

/** The four corners of a mockup's art, [TL, TR, BR, BL], or null. */
export function mockupCorners(doc, node) {
  const { art } = mockupParts(doc, node);
  const mesh = art?.live?.mesh;
  return mesh ? meshQuad(mesh) : null;
}

export const fitOf = (node) => (node?.live?.fit === 'mesh' ? 'mesh' : 'perspective');

/** The lighting effect record of the art, or null. */
export function lightingOf(art) {
  return (art?.effects || []).find((e) => e?.type === LIGHTING) || null;
}

export function normalizeLighting(e = {}) {
  const s = Number(e.strength);
  const d = Number(e.displace);
  const out = {
    type: LIGHTING,
    strength: Number.isFinite(s) ? Math.max(0, Math.min(1, s)) : LIGHTING_DEFAULTS.strength,
    displace: Number.isFinite(d) ? Math.max(0, Math.min(50, d)) : LIGHTING_DEFAULTS.displace,
  };
  if (e.hidden) out.hidden = true;
  return out;
}

/**
 * Where the art goes first: its own bounds when they sit on the photo
 * (nothing jumps), otherwise centered on the photo at half its size with
 * the art's proportions.
 */
export function initialQuad(artBox, photoBox) {
  if (!artBox || !photoBox) return null;
  const cx = artBox.x + artBox.w / 2;
  const cy = artBox.y + artBox.h / 2;
  const inside = cx >= photoBox.x && cx <= photoBox.x + photoBox.w && cy >= photoBox.y && cy <= photoBox.y + photoBox.h;
  if (inside && artBox.w > 0 && artBox.h > 0) return rectQuad(artBox);
  const aspect = artBox.w > 0 && artBox.h > 0 ? artBox.w / artBox.h : 1;
  let w = photoBox.w * 0.5;
  let h = w / aspect;
  if (h > photoBox.h * 0.5) {
    h = photoBox.h * 0.5;
    w = h * aspect;
  }
  return rectQuad({ x: photoBox.x + (photoBox.w - w) / 2, y: photoBox.y + (photoBox.h - h) / 2, w, h });
}

/**
 * Make a mockup from a photo and artwork (inside a transaction). The
 * mockup takes the stacking place of the topmost of them. Returns its id,
 * or null when there is no art.
 */
export function makeMockup(doc, photoId, artIds, { quad = null, lighting = LIGHTING_DEFAULTS } = {}) {
  const photo = doc.get(photoId);
  const ids = artIds.filter((id) => id !== photoId && doc.get(id));
  if (!photo || photo.type !== 'image' || !ids.length) return null;
  const all = doc.sortByPaintOrder([photoId, ...ids]);
  const top = doc.get(all[all.length - 1]);
  const parentId = top.parent;
  const index = doc.get(parentId).children.indexOf(top.id) + 1;
  let artBox = null;
  for (const id of ids) {
    const b = nodeBounds(doc, doc.get(id));
    if (!b) continue;
    artBox = artBox ? union(artBox, b) : b;
  }
  const q = quad && isConvexQuad(quad) ? quad : initialQuad(artBox, nodeBounds(doc, photo));
  const mockup = createGroup([], { live: { kind: KIND, fit: 'perspective' }, name: '' });
  doc.insert(mockup, parentId, index);
  doc.move(photoId, mockup.id);
  const envId = makeEnvelope(doc, ids, { mode: 'mesh', rows: 1, cols: 1 });
  if (!envId) {
    doc.move(photoId, parentId, index);
    doc.remove(mockup.id);
    return null;
  }
  doc.move(envId, mockup.id);
  const env = doc.get(envId);
  const mesh = q ? perspectiveMesh(q) : null;
  doc.update(envId, { name: 'Art', live: { ...env.live, ...(mesh ? { mesh } : {}) }, effects: [...(env.effects || []), normalizeLighting(lighting)] });
  return mockup.id;
}

function union(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Put the art on new corners (perspective fit). Returns false for a quad that cannot be mapped. */
export function setMockupCorners(doc, id, quad) {
  const node = doc.get(id);
  const { art } = mockupParts(doc, node);
  if (!art || !isConvexQuad(quad)) return false;
  const mesh = perspectiveMesh(quad);
  if (!mesh) return false;
  doc.update(art.id, { live: { ...art.live, mode: 'mesh', mesh } });
  if (fitOf(node) !== 'perspective') doc.update(id, { live: { ...node.live, fit: 'perspective' } });
  return true;
}

/**
 * Switch the fit. 'mesh' keeps the current shape as a rows x cols mesh to
 * bend further; 'perspective' goes back to the plane through the mesh's
 * four corners.
 */
export function setMockupFit(doc, id, fit, { rows = 4, cols = 4 } = {}) {
  const node = doc.get(id);
  const { art } = mockupParts(doc, node);
  if (!isMockup(node) || !art) return;
  if (fit === 'mesh') {
    resetWithMesh(doc, art.id, rows, cols, { maintain: true });
    doc.update(id, { live: { ...node.live, fit: 'mesh' } });
    return;
  }
  const q = mockupCorners(doc, node);
  doc.update(id, { live: { ...node.live, fit: 'perspective' } });
  if (q && isConvexQuad(q)) setMockupCorners(doc, id, q);
}

/** Change the art's lighting (the effect is added when missing). */
export function setMockupLighting(doc, id, patch) {
  const { art } = mockupParts(doc, doc.get(id));
  if (!art) return;
  const cur = lightingOf(art);
  const next = normalizeLighting({ ...(cur || LIGHTING_DEFAULTS), ...patch });
  const effects = cur ? art.effects.map((e) => (e === cur ? next : e)) : [...(art.effects || []), next];
  doc.update(art.id, { effects });
}

/** Change the art's opacity or blending mode. */
export function setMockupArtStyle(doc, id, patch) {
  const { art } = mockupParts(doc, doc.get(id));
  if (!art) return;
  const p = {};
  if (patch.opacity !== undefined) p.opacity = Math.max(0, Math.min(1, Number(patch.opacity) || 0));
  if (patch.blendMode !== undefined) p.blendMode = patch.blendMode || 'normal';
  doc.update(art.id, p);
}

/** True while the mockup's art is being edited in place. */
export function editingArt(doc, node) {
  const { art } = mockupParts(doc, node);
  return Boolean(art?.live?.editing === 'contents');
}

/** Start or stop editing the art in place (its contents become reachable). */
export function setEditingArt(doc, id, on) {
  const { art } = mockupParts(doc, doc.get(id));
  if (art) setEditingContents(doc, art.id, on);
  return art?.id || null;
}

/**
 * Release: the photo and the original, undistorted artwork return to the
 * mockup's place (in that stacking order). Returns their ids.
 */
export function releaseMockup(doc, id) {
  const node = doc.get(id);
  if (!isMockup(node)) return [];
  const parentId = node.parent;
  let index = doc.get(parentId).children.indexOf(id);
  const out = [];
  for (const c of node.children.slice()) {
    const k = doc.get(c);
    doc.move(c, parentId, index++);
    if (isEnvelope(k)) {
      const released = releaseEnvelope(doc, c);
      // The envelope's shape stays behind as a gray object: a mockup has no use for it.
      const shape = released[released.length - 1];
      const contents = released.slice(0, -1);
      if (shape && !k.children.includes(shape)) doc.remove(shape);
      else contents.push(shape);
      out.push(...contents.filter((x) => doc.has(x)));
      index = doc.get(parentId).children.indexOf(out[out.length - 1]) + 1;
    } else out.push(c);
  }
  doc.remove(id);
  return out;
}

/**
 * Expand: a plain group of the photo and the distorted art as ordinary
 * objects. The lighting stays a live effect of the art (it reads the photo
 * below it). Returns the group's id.
 */
export function expandMockup(doc, id) {
  const node = doc.get(id);
  if (!isMockup(node)) return null;
  const { art } = mockupParts(doc, node);
  if (art) {
    const effects = art.effects || [];
    const g = expandEnvelope(doc, art.id);
    // The expanded art keeps opacity, blending and raster effects (the lighting) of the envelope.
    if (g && effects.length && !doc.get(g).effects?.length) doc.update(g, { effects });
  }
  doc.update(id, { live: undefined, name: node.name || 'Mockup' });
  return id;
}

registerLive(KIND, {
  label: '<Mockup>',
  test: isMockup,
  // The photo and the art draw as themselves (the art is a live envelope).
  generate: (doc, node) => ({ items: node.children.slice() }),
  expand: (doc, node) => {
    const gid = expandMockup(doc, node.id);
    return gid ? doc.get(gid) : null;
  },
});
