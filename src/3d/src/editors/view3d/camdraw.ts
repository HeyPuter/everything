// Camera display extras (camera data ▸ Viewport Display ▸ Show): the clipping limits along the
// camera axis with the focus distance cross, the world mist range, and the sensor area in camera
// view.
import { BufferGeometry, Float32BufferAttribute, LineBasicMaterial, LineSegments, Points, PointsMaterial } from 'three';
import { h } from '../../ui/h';
import { app } from '../../app/app';
import { renderContext } from '../../render/context';
import { sceneSyncHooks, type SyncedObject } from '../../render/scene';
import { drawHooks } from './draw';
import { editModeHooks } from './hooks';
import type { CameraData } from '../../data/types';

type CamExtras = CameraData & { show_mist?: boolean; show_sensor?: boolean };

const LIMITS_COLOR = 0xfff3a6;
const MIST_COLOR = 0xffffff;

/** Points along the camera axis (camera looks down its local -Z) for the drawn extras. */
export function cameraExtrasGeometry(ca: CamExtras, mist: { start: number; depth: number } | null) {
  const lines: number[] = [];
  const dots: number[] = [];
  const dotColors: number[] = [];
  const yellow = [1, 0.953, 0.651],
    white = [1, 1, 1];
  if (ca.show_limits) {
    lines.push(0, 0, -ca.clip_start, 0, 0, -ca.clip_end);
    dots.push(0, 0, -ca.clip_start, 0, 0, -ca.clip_end);
    dotColors.push(...yellow, ...yellow);
    if (ca.dof?.use_dof && !ca.dof.focus_object) {
      // a cross in the plane of focus
      const d = ca.dof.focus_distance,
        s = Math.max(0.05, d * 0.18);
      lines.push(-s, 0, -d, s, 0, -d, 0, -s, -d, 0, s, -d);
    }
  }
  const mistLines: number[] = [];
  if (ca.show_mist && mist) {
    mistLines.push(0, 0, -mist.start, 0, 0, -(mist.start + mist.depth));
    dots.push(0, 0, -mist.start, 0, 0, -(mist.start + mist.depth));
    dotColors.push(...white, ...white);
  }
  return { lines, mistLines, dots, dotColors };
}

interface CamParts {
  key: string;
  limits: LineSegments;
  mist: LineSegments;
  dots: Points;
}
const PARTS = 'cameraExtras';

function geo(a: number[], colors?: number[]) {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(a, 3));
  if (colors) g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return g;
}

sceneSyncHooks.push((doc, ev, so) => {
  if (ev.ob.type !== 'CAMERA' || !ev.ob.data) return;
  const ca = doc.cameras[ev.ob.data] as CamExtras | undefined;
  const root = so.root;
  const old = root.userData[PARTS] as CamParts | undefined;
  const world = doc.scene.world ? doc.worlds[doc.scene.world] : undefined;
  const mist = world ? { start: world.mist_start ?? 5, depth: world.mist_depth ?? 25 } : { start: 5, depth: 25 };
  const want = !!ca && (!!ca.show_limits || !!ca.show_mist);
  const key = want ? JSON.stringify([ca!.show_limits, ca!.show_mist, ca!.clip_start, ca!.clip_end, ca!.dof?.use_dof, ca!.dof?.focus_distance, ca!.dof?.focus_object, mist]) : '';
  if (old && old.key === key) return;
  if (old) {
    for (const o of [old.limits, old.mist, old.dots]) {
      root.remove(o);
      o.geometry.dispose();
    }
    delete root.userData[PARTS];
  }
  if (!want) return;
  const g = cameraExtrasGeometry(ca!, mist);
  const limits = new LineSegments(geo(g.lines), new LineBasicMaterial({ color: LIMITS_COLOR }));
  const mistL = new LineSegments(geo(g.mistLines), new LineBasicMaterial({ color: MIST_COLOR, transparent: true, opacity: 0.6 }));
  const dots = new Points(geo(g.dots, g.dotColors), new PointsMaterial({ size: 5, sizeAttenuation: false, vertexColors: true }));
  for (const o of [limits, mistL, dots]) {
    o.matrixAutoUpdate = false;
    o.userData.overlay = true;
    o.frustumCulled = false;
    // drawn only in the viewport's overlay pass
    o.visible = false;
    root.add(o);
  }
  root.userData[PARTS] = { key, limits, mist: mistL, dots } satisfies CamParts;
});

// shown with the extras in the overlay pass only (hidden in the shaded scene and the selection IDs)
drawHooks.passes.push((pass, view) => {
  if (!renderContext) return;
  const changed: [SyncedObject, boolean][] = [];
  for (const so of renderContext.sync.objects.values()) {
    const parts = so.root.userData[PARTS] as CamParts | undefined;
    if (!parts) continue;
    const lookingThrough = !!view.sceneCamera && so.id === ((view as { activeCameraId?: () => string | null }).activeCameraId?.() ?? app.doc.scene.camera);
    const show = pass === 'OVERLAY' && view.overlay.show_extras && !lookingThrough;
    changed.push([so, parts.limits.visible]);
    for (const o of [parts.limits, parts.mist, parts.dots]) o.visible = show;
  }
  return () => {
    for (const [so] of changed) {
      const parts = so.root.userData[PARTS] as CamParts | undefined;
      if (parts) for (const o of [parts.limits, parts.mist, parts.dots]) o.visible = false;
    }
  };
});

