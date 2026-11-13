// Non-destructive skew, distort, perspective and warp for embedded objects.
// A framed instance draws a cached render of its content through the frame;
// the cache is derived data, re-rendered from the content whenever it is
// stale (content edited, layer scaled or rotated), so quality never degrades
// however often the object is transformed.
import type { Editor } from '../../editor';
import type { DocumentSession } from '../../app/session';
import { findLayer, type Layer, type PhotoDocument } from '../../model/document';
import { contentsOf } from '../../model/embedded';
import type { Assets } from '../../model/assets';
import type { RGBA8 } from '../../imaging/types';
import type { MeshGrid } from '../../imaging/filters/mesh';
import { renderFrame } from '../transform/render';
import type { Quad } from '../transform/math';
import { addRGBA, assetRGBA } from './render';
import { ensureEmbed } from './contents';
import { effectiveFrame, fromMesh, fromQuad, pendingFrame, plainPlacement, rescaleFrame, staleFrames } from './frame-math';

export { staleFrames } from './frame-math';
import { renderPinFrame } from '../warp/pin-render';

/** What an image layer draws from: its content composite (not a frame cache). */
export function contentSource(doc: PhotoDocument, l: Layer) {
  const c = contentsOf(doc, l);
  if (c) return { asset: c.composite, colorSpace: c.colorSpace, width: c.width, height: c.height };
  return { asset: l.asset!, colorSpace: l.assetColorSpace ?? 'document', width: Math.max(1, Math.round(l.sourceWidth)), height: Math.max(1, Math.round(l.sourceHeight)) };
}
/** The layer drawn straight from its content (for rotated-rectangle previews). */
export function unframed(doc: PhotoDocument, l: Layer): Partial<Layer> {
  if (!l.embed?.frame) return {};
  const s = contentSource(doc, l);
  return { asset: s.asset, assetColorSpace: s.colorSpace, sourceWidth: s.width, sourceHeight: s.height, embed: { contents: l.embed.contents } };
}

// The most recent native-resolution content, reused by sessions and refreshes.
let cached: { key: string; image: RGBA8 } | undefined;
/** Content pixels at their own resolution in the document's color space. */
export async function contentRGBA(e: Editor, l: Layer, doc: PhotoDocument = e.doc, assets: Assets = e.assets): Promise<RGBA8> {
  const s = contentSource(doc, l);
  const key = JSON.stringify([s.asset, doc.iccProfile ?? '', doc.iccUntaggedProfile ?? false, doc.bitsPerChannel ?? 8]);
  if (cached?.key === key) return cached.image;
  const image = await assetRGBA(e, doc, assets, s.asset, s.colorSpace, s.width, s.height);
  cached = { key, image };
  return image;
}

const transparent = (): RGBA8 => ({ width: 1, height: 1, data: new Uint8ClampedArray(4) });
type Rendered = { image: RGBA8; rect: { x: number; y: number; width: number; height: number } };
/** Keep a render within the whole pixels its frame covers: resampling adds a
 * margin, and a cache rectangle wider than the frame would move the pivot of
 * later flips and rotations. */
function trimToFrame(r: Rendered | undefined, quad: Quad, mesh: MeshGrid | undefined): Rendered | undefined {
  if (!r) return r;
  const xs: number[] = [],
    ys: number[] = [];
  if (mesh) for (let i = 0; i < mesh.points.length; i += 2) xs.push(mesh.points[i]), ys.push(mesh.points[i + 1]);
  else for (const p of quad) xs.push(p.x), ys.push(p.y);
  const x0 = Math.max(r.rect.x, Math.floor(Math.min(...xs) + 1e-6)),
    y0 = Math.max(r.rect.y, Math.floor(Math.min(...ys) + 1e-6));
  const x1 = Math.min(r.rect.x + r.image.width, Math.ceil(Math.max(...xs) - 1e-6)),
    y1 = Math.min(r.rect.y + r.image.height, Math.ceil(Math.max(...ys) - 1e-6));
  if (x1 <= x0 || y1 <= y0) return undefined;
  if (x0 === r.rect.x && y0 === r.rect.y && x1 - x0 === r.image.width && y1 - y0 === r.image.height) return r;
  const w = x1 - x0,
    h = y1 - y0;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((y + y0 - r.rect.y) * r.image.width + (x0 - r.rect.x)) * 4;
    data.set(r.image.data.subarray(from, from + w * 4), y * w * 4);
  }
  return { image: { width: w, height: h, data }, rect: { x: x0, y: y0, width: w, height: h } };
}
const near = (a: Quad, b: Quad) => a.every((p, i) => Math.abs(p.x - b[i].x) < 1e-6 && Math.abs(p.y - b[i].y) < 1e-6);

/** Commit a transform of an image layer as one undo step: a rotated
 * rectangle stays a plain transform, anything else becomes a frame. */
export function commitFrame(e: Editor, id: string, quad: Quad, mesh: MeshGrid | undefined, label: string, rendered?: Rendered): Promise<void> {
  const session = e.session;
  return session.trackEdit(storeFrame(e, session, id, quad, mesh, label, rendered));
}
async function storeFrame(e: Editor, session: DocumentSession, id: string, quad: Quad, mesh: MeshGrid | undefined, label: string, rendered?: Rendered) {
  const doc = session.doc, assets = session.assets;
  const l = findLayer(doc.layers, id);
  if (!l || l.kind !== 'image') return;
  const before = effectiveFrame(l);
  if (before && !mesh && !before.mesh && near(before.quad, quad)) return;
  const plain = plainPlacement(quad, mesh);
  if (plain) {
    e.command(label, (d) => {
      const t = findLayer(d.layers, id);
      if (!t) return;
      ensureEmbed(d, t, assets);
      const s = contentSource(d, t);
      if (t.embed) delete t.embed.frame;
      Object.assign(t, { asset: s.asset, assetColorSpace: s.colorSpace, sourceWidth: s.width, sourceHeight: s.height, transform: plain });
    }, { session });
    return;
  }
  const source = contentSource(doc, l);
  const r = trimToFrame(rendered ?? renderFrame(await contentRGBA(e, l, doc, assets), { x: 0, y: 0, width: source.width, height: source.height }, quad, mesh, { method: 'bicubic', doc }), quad, mesh);
  const image = r?.image ?? transparent();
  const rect = r ? { x: r.rect.x, y: r.rect.y, width: image.width, height: image.height } : { ...quadRect(quad), width: 1, height: 1 };
  const asset = await addRGBA(assets, image);
  e.command(label, (d) => {
    const t = findLayer(d.layers, id);
    if (!t) return;
    ensureEmbed(d, t, assets);
    const s = contentSource(d, t);
    // The cache was rendered from `source`, even if contents were saved while
    // its image was being stored. Keep it stale and carry any content resize
    // through the frame, just as saving contents after the transform would.
    t.embed!.frame = rescaleFrame({ quad: fromQuad(quad), mesh: mesh && fromMesh(mesh), rect, source: source.asset }, source, s);
    Object.assign(t, { asset, assetColorSpace: 'document', sourceWidth: image.width, sourceHeight: image.height, transform: { ...rect, rotation: 0 } });
  }, { session });
}
const quadRect = (q: Quad) => ({ x: Math.min(...q.map((p) => p.x)), y: Math.min(...q.map((p) => p.y)) });

/** Give an image layer (in a draft) a new placement: a plain transform when
 * the quad is a rotated rectangle, otherwise a frame whose cache is rendered
 * by the refresh that follows the edit. */
export function setFrame(d: PhotoDocument, l: Layer, quad: Quad, mesh: MeshGrid | undefined, assets: Assets) {
  // Pins stay with the content through moves, turns and flips of the quad;
  // a new mesh replaces them.
  const pins = mesh ? undefined : l.embed?.frame?.pins;
  ensureEmbed(d, l, assets);
  const plain = pins ? undefined : plainPlacement(quad, mesh);
  if (plain) {
    const s = contentSource(d, l);
    delete l.embed!.frame;
    Object.assign(l, { asset: s.asset, assetColorSpace: s.colorSpace, sourceWidth: s.width, sourceHeight: s.height, transform: plain });
    return;
  }
  const { frame, rect } = pendingFrame(quad, mesh);
  l.embed!.frame = pins ? { ...frame, pins } : frame;
  l.transform = { ...rect, rotation: 0 };
}
let running: Promise<void> | undefined;
let again = false;
/** Re-render stale frame caches of the active document. The cache is derived
 * from the content and frame, so it is replaced in place: the document's
 * meaning is unchanged and no history step is added. */
export function scheduleRefresh(e: Editor) {
  if (running) {
    again = true;
    return;
  }
  if (e.modal || e.transform.active || !staleFrames(e.doc).length) return;
  running = refresh(e)
    .catch((error) => e.message(error instanceof Error ? error.message : String(error)))
    .finally(() => {
      running = undefined;
      if (again) {
        again = false;
        setTimeout(() => scheduleRefresh(e), 50);
      }
    });
}
/** Wait until the active document's frame caches are current, so readbacks
 * (exports, merging, rasterizing) right after a flip or warp see its result. */
export async function framesReady(e: Editor) {
  for (let i = 0; i < 4; i++) {
    if (running) await running;
    if (e.modal || e.transform.active || !staleFrames(e.doc).length) return;
    scheduleRefresh(e);
    if (!running) return;
  }
}
async function refresh(e: Editor) {
  const session = e.session,
    doc = session.doc;
  let changed = false;
  for (const l of staleFrames(doc)) {
    const c = contentsOf(doc, l)!;
    const eff = effectiveFrame(l)!;
    const pins = l.embed!.frame!.pins;
    const src = await contentRGBA(e, l, doc, session.assets);
    // A pin warp reaches past its quad, so its render is not trimmed to it.
    const r = pins ? renderPinFrame(src, eff.quad, pins, doc) : trimToFrame(renderFrame(src, { x: 0, y: 0, width: c.width, height: c.height }, eff.quad, eff.mesh, { method: 'bicubic', doc }), eff.quad, eff.mesh);
    const image = r?.image ?? transparent();
    const asset = await addRGBA(session.assets, image);
    if (session.doc !== doc || !e.sessions.includes(session)) {
      again = true;
      break;
    }
    const rect = r ? { x: r.rect.x, y: r.rect.y, width: image.width, height: image.height } : { ...quadRect(eff.quad), width: 1, height: 1 };
    l.embed!.frame = { quad: fromQuad(eff.quad), mesh: eff.mesh && fromMesh(eff.mesh), rect, source: c.composite, ...(pins ? { pins } : {}) };
    Object.assign(l, { asset, assetColorSpace: 'document', sourceWidth: image.width, sourceHeight: image.height, transform: { ...rect, rotation: 0 } });
    changed = true;
  }
  if (changed && e.session === session) e.update();
}
