// Draw Face Sets brush: paints a new face set over the faces under the brush (Ctrl: grows the face
// set the stroke starts on instead).
import { BufferAttribute } from 'three';
import { app } from '../app/app';
import type { View3D } from '../editors/view3d/view3d';
import type { PaintBrush } from './brushes';
import { meshSession, activeMeshData } from './session';
import { runStroke } from './stroke';
import { brushRadiusPx } from './vgather';
import { faceCount, faceSetColor, faceSetsOf, maxFaceSet } from './fsdata';
import { faceSetsChanged, invalidatePaintAttributes } from './display';

export function faceSetStroke(v: View3D, e: PointerEvent, b: PaintBrush): boolean {
  const am = activeMeshData();
  const s = meshSession();
  if (!am || !s) return false;
  const { me } = am;
  const p0 = v.local(e);
  const first = s.raycast(v, p0.x, p0.y);
  if (!first) return false;
  const old = faceSetsOf(me);
  const fs = old ? old.slice() : new Int32Array(faceCount(me)).fill(1);
  const id = e.ctrlKey || e.metaKey ? fs[first.face] : maxFaceSet(old) + 1;
  me.sculpt_face_set = fs;
  invalidatePaintAttributes();
  const mask = me.sculpt_mask && me.sculpt_mask.length === s.nv ? me.sculpt_mask : null;
  const hf = s.hiddenF;
  const color = faceSetColor(id, me.face_sets_color_seed ?? 0, me.face_sets_color_default ?? 1);
  const P = s.positions;
  let changedFaces: number[] = [];
  const dab = (x: number, y: number) => {
    const hit = s.raycast(v, x, y);
    if (!hit) return;
    const R = s.pixelsToLocal(v, hit.world, brushRadiusPx(b, s, v, hit.world));
    const c = hit.point;
    // vertices in range → their faces → faces whose center is in range
    const verts: number[] = [];
    for (let i = 0; i < s.nv; i++) {
      const dx = P[i * 3] - c.x,
        dy = P[i * 3 + 1] - c.y,
        dz = P[i * 3 + 2] - c.z;
      if (dx * dx + dy * dy + dz * dz <= R * R * 1.5) verts.push(i);
    }
    for (const f of s.facesOf(verts, verts.length)) {
      if (fs[f] === id || hf?.[f]) continue;
      let x0 = 0,
        y0 = 0,
        z0 = 0,
        m = 0;
      const n = s.offsets[f + 1] - s.offsets[f];
      for (let k = s.offsets[f]; k < s.offsets[f + 1]; k++) {
        const vi = s.indices[k];
        x0 += P[vi * 3];
        y0 += P[vi * 3 + 1];
        z0 += P[vi * 3 + 2];
        if (mask) m += mask[vi];
      }
      if (mask && m / n > 0.5) continue;
      const d = Math.hypot(x0 / n - c.x, y0 / n - c.y, z0 / n - c.z);
      if (d > R) continue;
      fs[f] = id;
      changedFaces.push(f);
    }
  };
  const flushColors = () => {
    if (!changedFaces.length) return;
    // live update of the face set colors on the GPU (the full refresh happens after the stroke)
    const g = s.syncedMesh()?.geometry;
    const a = g?.getAttribute('paintFaceSet') as BufferAttribute | undefined;
    if (a && a.count === s.nc) {
      const arr = a.array as Float32Array;
      let lo = Infinity,
        hi = -1;
      for (const f of changedFaces)
        for (let k = s.offsets[f]; k < s.offsets[f + 1]; k++) {
          arr.set(color, k * 3);
          lo = Math.min(lo, k);
          hi = Math.max(hi, k);
        }
      s.markAttrDirty('paintFaceSet', lo, hi);
      s.flush();
    } else {
      faceSetsChanged(fs);
      invalidatePaintAttributes();
      s.flush();
    }
    changedFaces = [];
    app.changed('ui');
  };
  runStroke(v, e, {
    spacing: () => Math.max(1, b.spacing || 10),
    radiusPx: () => b.radius,
    settings: () => b,
    dab: (d) => dab(d.x, d.y),
    update: flushColors,
    end: () => {
      // a fresh array so the display (cached per array) picks up every change
      me.sculpt_face_set = fs.slice();
      invalidatePaintAttributes();
      app.pushUndo(b.name);
      app.changed('doc');
    },
  });
  return true;
}
