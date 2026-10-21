/**
 * Scope boxes: named extents (a wing, a phase of the site) that views can
 * use as their crop region (plans) or section box (3D). Views using a scope
 * box follow it when it is moved or resized.
 *
 *   scopeBox     { name, x0, y0, x1, y1, z0, z1 }
 *   view.scopeBoxId
 */
import { W } from './plan.js';

const SCOPE = [196, 72, 150, 255];

export function scopeRect(box) {
  return { x0: Math.min(box.x0, box.x1), y0: Math.min(box.y0, box.y1), x1: Math.max(box.x0, box.x1), y1: Math.max(box.y0, box.y1) };
}

/** What a view gets from its scope box (a patch), or null. */
function viewPatch(view, box) {
  const r = scopeRect(box);
  if (view.kind === 'view3d') {
    const sb = { min: [r.x0, r.y0, +box.z0 || 0], max: [r.x1, r.y1, +box.z1 || 10000] };
    return JSON.stringify(view.sectionBox) === JSON.stringify(sb) ? null : { sectionBox: sb };
  }
  if (JSON.stringify(view.crop) === JSON.stringify(r) && view.cropOn) return null;
  return { crop: r, cropOn: true };
}

/**
 * Bring views in line with their scope boxes (inside a transaction). Runs
 * when a scope box or a view's scope box changed. Returns the ids updated.
 */
export function applyScopeBoxes(doc, drivers = null) {
  const changed = new Set();
  if (!doc.count('scopeBox')) return changed;
  if (drivers) {
    let relevant = false;
    for (const id of drivers) {
      const it = doc.get(id);
      if (it?.kind === 'scopeBox' || it?.scopeBoxId) relevant = true;
    }
    if (!relevant) return changed;
  }
  for (const v of doc.filter((x) => x.scopeBoxId)) {
    const box = doc.get(v.scopeBoxId);
    if (box?.kind !== 'scopeBox') continue;
    const patch = viewPatch(v, box);
    if (patch) {
      doc.update(v.id, patch);
      changed.add(v.id);
    }
  }
  return changed;
}

/** Plans of levels the box spans show it as a dashed outline with its name. */
export function planScopeBox(pc, el, b) {
  const z = pc.level?.elevation;
  if (z == null || z < (+el.z0 || 0) - 1 || z > (+el.z1 || 0) + 1) return;
  const r = scopeRect(el);
  const pts = [
    [r.x0, r.y0],
    [r.x1, r.y0],
    [r.x1, r.y1],
    [r.x0, r.y1],
  ];
  b.poly(pts, true, W.medium, 1, SCOPE);
  const sz = 2.5 * pc.scale;
  b.text([r.x0 + sz * 0.5, r.y1 - sz * 1.1], el.name || 'Scope Box', { size: sz, align: 'left', color: SCOPE });
  // Picked by its outline only, so it does not cover what is inside.
  const t = 1.5 * pc.scale;
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const c = pts[(i + 1) % 4];
    const x0 = Math.min(a[0], c[0]) - t;
    const x1 = Math.max(a[0], c[0]) + t;
    const y0 = Math.min(a[1], c[1]) - t;
    const y1 = Math.max(a[1], c[1]) + t;
    b.pick([
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ]);
  }
}
