// Object ▸ Viewport Display extras: the object's name next to its origin, its local axes, and
// its bounds (box, sphere, cylinder, cone or capsule around the geometry) and its texture space.
import { Box3, BufferGeometry, Float32BufferAttribute, LineBasicMaterial, LineDashedMaterial, LineSegments, Vector3 } from 'three';
import { h, type VNode } from '../../ui/h';
import { app } from '../../app/app';
import { renderContext } from '../../render/context';
import { sceneSyncHooks } from '../../render/scene';
import { drawHooks, viewportTheme } from './draw';
import { editModeHooks } from './hooks';
import type { ObjectData } from '../../data/types';

export type BoundsType = 'BOX' | 'SPHERE' | 'CYLINDER' | 'CONE' | 'CAPSULE';
type ObExt = ObjectData & { show_bounds?: boolean; display_bounds_type?: BoundsType; show_texture_space?: boolean };

const AXIS_COLORS = ['#ff3352', '#8bdc00', '#2890ff'];

/** Line segments (flat xyz pairs) of a bounds shape around a local bounding box. */
export function boundsShape(type: BoundsType, min: [number, number, number], max: [number, number, number]): number[] {
  const out: number[] = [];
  const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const hs = [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2];
  const line = (a: number[], b: number[]) => out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  const ring = (r: number, z: number, n = 32, plane: 'xy' | 'xz' | 'yz' = 'xy') => {
    for (let i = 0; i < n; i++) {
      const p = (k: number) => {
        const a = (k / n) * Math.PI * 2,
          u = Math.cos(a) * r,
          v = Math.sin(a) * r;
        return plane === 'xy' ? [c[0] + u, c[1] + v, z] : plane === 'xz' ? [c[0] + u, c[1], c[2] + v] : [c[0], c[1] + u, c[2] + v];
      };
      line(p(i), p(i + 1));
    }
  };
  if (type === 'BOX') {
    const xs = [min[0], max[0]],
      ys = [min[1], max[1]],
      zs = [min[2], max[2]];
    for (const y of ys) for (const z of zs) line([xs[0], y, z], [xs[1], y, z]);
    for (const x of xs) for (const z of zs) line([x, ys[0], z], [x, ys[1], z]);
    for (const x of xs) for (const y of ys) line([x, y, zs[0]], [x, y, zs[1]]);
  } else if (type === 'SPHERE') {
    const r = Math.max(hs[0], hs[1], hs[2]);
    ring(r, c[2], 32, 'xy');
    ring(r, 0, 32, 'xz');
    ring(r, 0, 32, 'yz');
  } else {
    // round shapes stand along Z with the larger of the X / Y extents as radius
    const r = Math.max(hs[0], hs[1]);
    const z0 = min[2],
      z1 = max[2];
    if (type === 'CYLINDER') {
      ring(r, z0);
      ring(r, z1);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        line([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r, z0], [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r, z1]);
      }
    } else if (type === 'CONE') {
      ring(r, z0);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        line([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r, z0], [c[0], c[1], z1]);
      }
    } else {
      // capsule: a cylinder with half-sphere caps
      const za = Math.min(z0 + r, c[2]),
        zb = Math.max(z1 - r, c[2]);
      ring(r, za);
      ring(r, zb);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        const x = Math.cos(a),
          y = Math.sin(a);
        line([c[0] + x * r, c[1] + y * r, za], [c[0] + x * r, c[1] + y * r, zb]);
        // quarter arcs over the caps
        for (let k = 0; k < 8; k++) {
          const t0 = (k / 8) * (Math.PI / 2),
            t1 = ((k + 1) / 8) * (Math.PI / 2);
          line([c[0] + x * r * Math.cos(t0), c[1] + y * r * Math.cos(t0), zb + r * Math.sin(t0)], [c[0] + x * r * Math.cos(t1), c[1] + y * r * Math.cos(t1), zb + r * Math.sin(t1)]);
          line([c[0] + x * r * Math.cos(t0), c[1] + y * r * Math.cos(t0), za - r * Math.sin(t0)], [c[0] + x * r * Math.cos(t1), c[1] + y * r * Math.cos(t1), za - r * Math.sin(t1)]);
        }
      }
    }
  }
  return out;
}

const BOUNDS = 'boundsLines';
const TEXSPACE = 'texspaceLines';

/** Texture space box of an object's data (its own settings, or the geometry bounds when automatic). */
function texspaceBox(ob: ObjectData, P: ArrayLike<number> | undefined): Box3 | null {
  const data = ob.data ? ((app.doc.meshes[ob.data] ?? app.doc.curves[ob.data]) as { use_auto_texspace?: boolean; texspace_location?: number[]; texspace_size?: number[] } | undefined) : undefined;
  if (data && data.use_auto_texspace === false && data.texspace_location && data.texspace_size) {
    const c = new Vector3(...data.texspace_location),
      sz = new Vector3(...data.texspace_size);
    return new Box3(c.clone().sub(sz), c.clone().add(sz));
  }
  if (!P || !P.length) return null;
  return new Box3().setFromArray(P as unknown as number[]);
}

sceneSyncHooks.push((_doc, ev, so) => {
  const ob = ev.ob as ObExt;
  const old = so.root.userData[BOUNDS] as LineSegments | undefined;
  let key = '';
  let box: Box3 | null = null;
  if (ob.show_bounds) {
    box = new Box3();
    const P = ev.mesh?.positions;
    if (P && P.length) box.setFromArray(P as unknown as number[]);
    else box.set(new Vector3(-1, -1, -1).multiplyScalar(ob.empty_display_size || 1), new Vector3(1, 1, 1).multiplyScalar(ob.empty_display_size || 1));
    key = `${ob.display_bounds_type ?? 'BOX'}|${box.min.toArray().join(',')}|${box.max.toArray().join(',')}`;
  }
  if (old && old.userData.key === key) return;
  if (old) {
    so.root.remove(old);
    old.geometry.dispose();
    delete so.root.userData[BOUNDS];
  }
  if (!box) return;
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(boundsShape(ob.display_bounds_type ?? 'BOX', box.min.toArray() as [number, number, number], box.max.toArray() as [number, number, number]), 3));
  const l = new LineSegments(g, new LineBasicMaterial({ color: 0x000000 }));
  l.matrixAutoUpdate = false;
  l.visible = false;
  l.userData.key = key;
  so.root.add(l);
  so.root.userData[BOUNDS] = l;
});

sceneSyncHooks.push((_doc, ev, so) => {
  const ob = ev.ob as ObExt;
  const old = so.root.userData[TEXSPACE] as LineSegments | undefined;
  const box = ob.show_texture_space ? texspaceBox(ob, ev.mesh?.positions) : null;
  const key = box ? `${box.min.toArray().join(',')}|${box.max.toArray().join(',')}` : '';
  if (old && old.userData.key === key) return;
  if (old) {
    so.root.remove(old);
    old.geometry.dispose();
    delete so.root.userData[TEXSPACE];
  }
  if (!box) return;
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(boundsShape('BOX', box.min.toArray() as [number, number, number], box.max.toArray() as [number, number, number]), 3));
  const l = new LineSegments(g, new LineDashedMaterial({ color: 0x000000, dashSize: 0.08, gapSize: 0.06 }));
  l.computeLineDistances();
  l.matrixAutoUpdate = false;
  l.visible = false;
  l.userData.key = key;
  so.root.add(l);
  so.root.userData[TEXSPACE] = l;
});

// bounds draw in the overlay pass only, in the object's wire colour
drawHooks.passes.push((pass, view) => {
  if (!renderContext) return;
  const shown: LineSegments[] = [];
  for (const so of renderContext.sync.objects.values()) {
    const t = so.root.userData[TEXSPACE] as LineSegments | undefined;
    if (t) {
      t.visible = pass === 'OVERLAY' && view.overlay.show_overlays;
      shown.push(t);
    }
    const l = so.root.userData[BOUNDS] as LineSegments | undefined;
    if (!l) continue;
    l.visible = pass === 'OVERLAY' && view.overlay.show_overlays;
    const ob = so.ev.ob;
    const st = app.doc.scene.active_object === ob.id && ob.select ? 2 : ob.select ? 1 : 0;
    (l.material as LineBasicMaterial).color.copy(st === 2 ? viewportTheme.active : st === 1 ? viewportTheme.selected : viewportTheme.wire);
    shown.push(l);
  }
  return () => shown.forEach((l) => (l.visible = false));
});

// names and axes on the SVG overlay
editModeHooks.svg.push((v) => {
  if (!v.overlay.show_overlays) return null;
  const parts: VNode[] = [];
  for (const ev of app.graph.objects.values()) {
    const ob = ev.ob;
    if (!ev.visible || (!ob.show_name && !ob.show_axis)) continue;
    if (v.localView && !v.localView.has(ob.id)) continue;
    const o = new Vector3().setFromMatrixPosition(ev.world);
    const p = v.project(o);
    if (p.z > 1 || p.z < -1) continue;
    if (ob.show_axis) {
      ['X', 'Y', 'Z'].forEach((label, i) => {
        const tip = v.project(new Vector3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0).applyMatrix4(ev.world));
        if (tip.z > 1) return;
        parts.push(h('line', { x1: p.x, y1: p.y, x2: tip.x, y2: tip.y, stroke: AXIS_COLORS[i], 'stroke-width': 1.5 }));
        const dx = tip.x - p.x,
          dy = tip.y - p.y,
          l = Math.hypot(dx, dy);
        if (l > 6) parts.push(h('text', { x: tip.x + (dx / l) * 9, y: tip.y + (dy / l) * 9 + 4, 'text-anchor': 'middle', class: 'ob-axis-label', fill: AXIS_COLORS[i] }, label));
      });
    }
    if (ob.show_name) parts.push(h('text', { x: p.x + 10, y: p.y - 6, class: { 'ob-name-label': true, sel: ob.select } }, ob.name));
  }
  return parts.length ? h('g', { class: 'ob-display' }, parts) : null;
});
