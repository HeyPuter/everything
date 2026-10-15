// Light probe objects: Sphere (reflection cubemap captured at the probe), Plane (realtime
// planar reflection) and Volume (grid of baked irradiance). Settings live on the object
// (`ob.lightprobe`); this file adds the object type: Add menu operator, viewport helper and the
// Object Data properties. Capturing and baking are in capture.ts / bake.ts.
import { BufferGeometry, Float32BufferAttribute, LineBasicMaterial, LineSegments } from 'three';
import { registerOperators, type OpContext } from '../../../app/app';
import { newObject } from '../../../data/defaults';
import type { ObjectData } from '../../../data/types';
import type { LightProbeSettings } from '../types';
import { addObjectToScene } from '../../../ops/object';
import { sceneSyncHooks } from '../../scene';
import { registerIcons } from '../../../ui/icons';

export type ProbeType = LightProbeSettings['type'];

export function defaultLightProbe(type: ProbeType): LightProbeSettings {
  const common = { show_influence: true, show_clip: false, show_parallax: false, visibility_collection: null, invert_visibility_collection: false, baked: null };
  if (type === 'PLANE') return { ...common, type, influence_distance: 0.1, falloff: 0.5, clip_start: 0.001, clip_end: 20 };
  if (type === 'VOLUME')
    return {
      ...common,
      type,
      influence_distance: 0.3,
      falloff: 0.2,
      clip_start: 0.01,
      clip_end: 20,
      intensity: 1,
      resolution_x: 4,
      resolution_y: 4,
      resolution_z: 4,
      capture_distance: 20,
      capture_world: false,
      capture_indirect: true,
      capture_emission: true,
    };
  return { ...common, type, influence_distance: 2.5, influence_type: 'ELIPSOID', falloff: 0.2, clip_start: 0.8, clip_end: 20, use_custom_parallax: false, parallax_type: 'ELIPSOID', parallax_distance: 2.5 };
}

export const probeOf = (ob: ObjectData | null | undefined): LightProbeSettings | null => (ob?.type === 'LIGHT_PROBE' ? ob.lightprobe ?? null : null);

export const PROBE_TYPES: [ProbeType, string, string][] = [
  ['SPHERE', 'Sphere', 'lightprobe_sphere'],
  ['PLANE', 'Plane', 'lightprobe_plane'],
  ['VOLUME', 'Volume', 'lightprobe_volume'],
];

registerIcons({
  // probes: a ringed sphere, a mirror plane with its normal, a dotted volume grid (original drawings)
  outliner_ob_lightprobe: '<circle class="c-ob s" cx="8" cy="8" r="5" fill="none" stroke-width="1.3"/><ellipse class="c-ob s" cx="8" cy="8" rx="5" ry="1.8" fill="none" stroke-width="1.1"/><circle class="c-ob f" cx="8" cy="8" r="1.3"/>',
  lightprobe_sphere: '<circle class="s" cx="8" cy="8" r="5.5" fill="none" stroke-width="1.3"/><ellipse class="s" cx="8" cy="8" rx="5.5" ry="2" fill="none" stroke-width="1"/><circle class="f" cx="8" cy="8" r="1.4"/>',
  lightprobe_plane: '<path class="s" d="M2 11.5l4-3.5h8l-4 3.5z" fill="none" stroke-width="1.2" stroke-linejoin="round"/><path class="s" d="M8 9.7V2.5M6.2 4.3L8 2.5l1.8 1.8" fill="none" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>',
  lightprobe_volume: '<rect class="s" x="2.5" y="2.5" width="11" height="11" rx="1" fill="none" stroke-width="1.2"/><circle class="f" cx="5.5" cy="5.5" r="1"/><circle class="f" cx="10.5" cy="5.5" r="1"/><circle class="f" cx="5.5" cy="10.5" r="1"/><circle class="f" cx="10.5" cy="10.5" r="1"/>',
});

const objectMode = (ctx: OpContext) => ctx.doc.mode === 'OBJECT';

registerOperators([
  {
    idname: 'object.lightprobe_add',
    label: 'Add Light Probe',
    description: 'Add a light probe: captures reflections or indirect lighting for the realtime engine',
    props: [
      { id: 'type', label: 'Type', type: 'enum', default: 'SPHERE', items: PROBE_TYPES.map(([v, l]) => [v, l]) },
      { id: 'radius', label: 'Radius', type: 'float', default: 1, min: 0.001, subtype: 'distance' },
      { id: 'align', label: 'Align', type: 'enum', default: 'WORLD', items: [['WORLD', 'World'], ['VIEW', 'View'], ['CURSOR', '3D Cursor']] },
      { id: 'location', label: 'Location', type: 'vec3', default: null, subtype: 'distance' },
      { id: 'rotation', label: 'Rotation', type: 'vec3', default: null, subtype: 'angle' },
    ],
    poll: objectMode,
    exec: (ctx, p) => {
      const type = (p.type as ProbeType) ?? 'SPHERE';
      const label = PROBE_TYPES.find((t) => t[0] === type)?.[1] ?? 'Sphere';
      const ob = newObject(label, 'LIGHT_PROBE', null);
      ob.lightprobe = defaultLightProbe(type);
      const r = Math.max(0.001, Number(p.radius ?? 1));
      ob.scale = [r, r, r];
      if (p.location === null) p.location = [...ctx.doc.scene.cursor.location];
      if (p.rotation === null) delete p.rotation;
      addObjectToScene(ctx.doc, ob, p);
    },
  },
]);

/** Add ▸ Light Probe sub-menu entries. */
export function lightProbeAddMenu() {
  return PROBE_TYPES.map(([type, label, ic]) => ({ label, icon: ic, op: 'object.lightprobe_add', props: { type } }));
}

// ---------------------------------------------------------------------------
// viewport helper (object space; the object's scale sizes the probe)

function circle(seg: number[], r: number, axis: 'x' | 'y' | 'z', n = 32, ox = 0, oy = 0, oz = 0) {
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2,
      a1 = ((i + 1) / n) * Math.PI * 2;
    const p = (a: number): [number, number, number] => {
      const c = Math.cos(a) * r,
        s = Math.sin(a) * r;
      return axis === 'z' ? [c + ox, s + oy, oz] : axis === 'y' ? [c + ox, oy, s + oz] : [ox, c + oy, s + oz];
    };
    seg.push(...p(a0), ...p(a1));
  }
}

function box(seg: number[], hx: number, hy: number, hz: number) {
  const c = [-1, 1];
  for (const y of c) for (const z of c) seg.push(-hx, y * hy, z * hz, hx, y * hy, z * hz);
  for (const x of c) for (const z of c) seg.push(x * hx, -hy, z * hz, x * hx, hy, z * hz);
  for (const x of c) for (const y of c) seg.push(x * hx, y * hy, -hz, x * hx, y * hy, hz);
}

function sphereOrBox(seg: number[], r: number, shape: 'ELIPSOID' | 'BOX' | undefined) {
  if (shape === 'BOX') box(seg, r, r, r);
  else {
    circle(seg, r, 'x', 48);
    circle(seg, r, 'y', 48);
    circle(seg, r, 'z', 48);
  }
}

/** Line segments drawn for a probe in its object space. */
export function probeHelperSegments(p: LightProbeSettings): number[] {
  const seg: number[] = [];
  if (p.type === 'SPHERE') {
    // the probe itself: a small ringed sphere
    circle(seg, 0.2, 'x', 16);
    circle(seg, 0.2, 'y', 16);
    circle(seg, 0.2, 'z', 16);
    if (p.show_influence !== false) {
      sphereOrBox(seg, p.influence_distance, p.influence_type);
      if (p.falloff > 0) sphereOrBox(seg, p.influence_distance * (1 - p.falloff), p.influence_type);
    }
    if (p.show_clip) {
      circle(seg, p.clip_start, 'z', 24);
      circle(seg, p.clip_end, 'z', 64);
    }
    if (p.show_parallax && p.use_custom_parallax) sphereOrBox(seg, p.parallax_distance ?? 2.5, p.parallax_type);
  } else if (p.type === 'PLANE') {
    // the mirror plane and its normal
    seg.push(-1, -1, 0, 1, -1, 0, 1, -1, 0, 1, 1, 0, 1, 1, 0, -1, 1, 0, -1, 1, 0, -1, -1, 0);
    seg.push(0, 0, 0, 0, 0, 0.5, 0, 0, 0.5, 0.08, 0, 0.4, 0, 0, 0.5, -0.08, 0, 0.4);
    if (p.show_influence !== false) {
      const d = p.influence_distance;
      for (const z of [-d, d]) seg.push(-1, -1, z, 1, -1, z, 1, -1, z, 1, 1, z, 1, 1, z, -1, 1, z, -1, 1, z, -1, -1, z);
    }
  } else {
    box(seg, 1, 1, 1);
    // sample points of the grid
    const nx = Math.max(1, p.resolution_x ?? 4),
      ny = Math.max(1, p.resolution_y ?? 4),
      nz = Math.max(1, p.resolution_z ?? 4);
    const at = (i: number, n: number) => (n > 1 ? -1 + (2 * i) / (n - 1) : 0);
    const s = 0.03;
    if (nx * ny * nz <= 4096)
      for (let i = 0; i < nx; i++)
        for (let j = 0; j < ny; j++)
          for (let k = 0; k < nz; k++) {
            const x = at(i, nx),
              y = at(j, ny),
              z = at(k, nz);
            seg.push(x - s, y, z, x + s, y, z, x, y - s, z, x, y + s, z, x, y, z - s, x, y, z + s);
          }
  }
  return seg;
}

sceneSyncHooks.push((_doc, ev, so) => {
  const p = probeOf(ev.ob);
  if (!p) return;
  const key = JSON.stringify({ ...p, baked: null });
  if (so.helper && so.root.userData.probeKey === key) return;
  so.root.userData.probeKey = key;
  if (so.helper) {
    so.root.remove(so.helper);
    so.helper.geometry.dispose();
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(probeHelperSegments(p), 3));
  so.helper = new LineSegments(g, new LineBasicMaterial({ color: 0x000000 }));
  so.helper.userData.id = ev.id;
  so.helper.matrixAutoUpdate = false;
  so.root.add(so.helper);
});
