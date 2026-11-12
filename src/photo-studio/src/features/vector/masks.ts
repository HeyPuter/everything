import type { Editor } from '../../editor';
import { findLayer, type Layer } from '../../model/document';
import type { VectorMask } from '../../model/vector';
import { layerLock } from '../../model/locks';
import { hasMask } from '../../model/masks';
import { maskToGrid } from './raster';
import { activeKey, setActive, targetLocked, targetPath, writeTarget, type PathTarget } from './state';
import { cleanMask } from './geometry';

// Vector mask commits rasterize asynchronously; commits are queued so they land
// in order, and tools wait for them before reading path state again.
let inflight = 0;
let chain: Promise<unknown> = Promise.resolve();
export function commitsSettled(): Promise<unknown> | undefined {
  return inflight ? chain : undefined;
}
/** Commit edited knots to a target as one history step. Vector masks are
 * rasterized into the layer mask first so both change together. Resolves to
 * false when nothing was committed (a locked layer, a removed mask). */
export function commitPathEdit(e: Editor, t: PathTarget, mask: VectorMask, label: string): Promise<boolean> {
  inflight++;
  const run = chain.then(() => applyPathEdit(e, t, mask, label));
  chain = run.catch(() => undefined);
  return run.finally(() => inflight--);
}
async function applyPathEdit(e: Editor, t: PathTarget, mask: VectorMask, label: string): Promise<boolean> {
  // Every path tool commits here, so a locked layer's path stays as it is.
  if (targetLocked(e, t)) return false;
  if (t.kind === 'vmask') {
    const l = findLayer(e.doc.layers, t.id);
    if (!l?.vectorMask) return false;
    const clean = cleanMask(structuredClone(mask));
    const grid = await maskToGrid(e, { ...l.vectorMask.mask, paths: clean.paths });
    e.command(label, (d) => {
      writeTarget(d, t, clean);
      const x = findLayer(d.layers, t.id);
      if (x) x.maskGrid = grid;
    });
    return true;
  }
  e.command(label, (d) => writeTarget(d, t, mask));
  if (t.kind === 'work' || t.kind === 'saved') setActive(e, activeKey(t));
  return true;
}

// ----- Vector masks -----
// The renderer has a single scalar mask input, so a vector mask is stored as
// editable geometry (`layer.vectorMask`) and rasterized into `layer.maskGrid`.
// A layer that already has a pixel mask must apply or delete it first.
export function canAddVectorMask(e: Editor, l: Layer | undefined): l is Layer {
  if (!l || e.selectedIds.size !== 1) return false;
  if (l.kind === 'group' && l.children.length === 0) return false;
  return !l.vectorMask;
}
export async function addVectorMask(e: Editor, mask: VectorMask, label: string) {
  const l = e.layer;
  if (!canAddVectorMask(e, l)) return;
  if (layerLock(e.doc.layers, l.id, 'all')) {
    e.message('Unlock this layer to add a vector mask.');
    return;
  }
  if (l.maskGrid || hasMask(l)) {
    e.message('This layer already has a layer mask. Apply or delete it before adding a vector mask; vector masks are stored as a rasterized layer mask in this version.');
    return;
  }
  const clean = structuredClone(mask);
  const grid = await maskToGrid(e, clean);
  const id = l.id;
  e.command(label, (d) => {
    const x = findLayer(d.layers, id)!;
    x.vectorMask = { mask: clean };
    x.maskGrid = grid;
    x.maskDisabled = false;
  });
  setActive(e, `vmask:${id}`);
  e.update();
}
export function deleteVectorMask(e: Editor) {
  const l = e.layer;
  if (!l?.vectorMask) return;
  const id = l.id;
  e.command('Delete Vector Mask', (d) => {
    const x = findLayer(d.layers, id)!;
    delete x.vectorMask;
    delete x.maskGrid;
    delete x.maskDisabled;
  });
  if (e.maskTarget === id) e.maskTarget = '';
  setActive(e, undefined);
  e.update();
}
export function toggleVectorMask(e: Editor) {
  const l = e.layer;
  if (!l?.vectorMask) return;
  const id = l.id;
  e.command(l.vectorMask.disabled ? 'Enable Vector Mask' : 'Disable Vector Mask', (d) => {
    const x = findLayer(d.layers, id)!;
    const off = !x.vectorMask!.disabled;
    x.vectorMask!.disabled = off;
    x.maskDisabled = off;
  });
}
/** Keep the editable geometry's raster honest after an undo-free edit elsewhere. */
export function rasterizeVectorMask(e: Editor) {
  const l = e.layer;
  if (!l?.vectorMask) return;
  const id = l.id;
  e.command('Rasterize Vector Mask', (d) => {
    const x = findLayer(d.layers, id)!;
    delete x.vectorMask;
  });
  setActive(e, undefined);
  e.update();
}
export function currentPathForMask(e: Editor): VectorMask | undefined {
  const t = targetPath(e);
  const mask = t && t.kind !== 'vmask' ? t.mask : e.doc.workPath;
  return mask?.paths.length ? mask : undefined;
}
