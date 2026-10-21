// Screen-facing parts of light objects: the centre marker (constant pixel size), the light
// radius circle and the spot cone's silhouette lines. They are children of the light's helper
// lines so they share its visibility, colour and selection id.
import { BufferGeometry, Float32BufferAttribute, LineSegments, Matrix4, OrthographicCamera, PerspectiveCamera, Vector3, type Camera, type Material } from 'three';
import { app } from '../../app/app';
import { renderContext } from '../../render/context';
import { sceneSyncHooks, type SyncedObject } from '../../render/scene';
import { drawHooks, type DrawView } from './draw';
import { lightMarkerShape, spotCircle, spotSilhouette, unitCircle } from './lightshapes';
import type { LightData } from '../../data/types';

interface LightParts {
  marker: LineSegments;
  radius: LineSegments | null;
  cone: LineSegments | null;
}

const PARTS = 'lightParts';

function geom(seg: number[]) {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(seg, 3));
  return g;
}

const markerGeo: Record<string, BufferGeometry> = {};
const circleGeo = geom(unitCircle(40));

function child(g: BufferGeometry, parent: LineSegments) {
  const l = new LineSegments(g, parent.material as Material);
  l.matrixAutoUpdate = false;
  l.matrixWorldAutoUpdate = false;
  l.userData.id = parent.userData.id;
  l.userData.base = parent.material;
  l.frustumCulled = false;
  parent.add(l);
  return l;
}

sceneSyncHooks.push((doc, ev, so) => {
  if (ev.ob.type !== 'LIGHT' || !ev.ob.data || !so.helper) return;
  const la = doc.lights[ev.ob.data];
  if (!la) return;
  const h = so.helper;
  const key = `${la.type}`;
  if (h.userData[PARTS] && h.userData.lightPartsKey === key) return;
  for (const c of [...h.children]) h.remove(c);
  const marker = child((markerGeo[la.type] ??= geom(lightMarkerShape(la.type))), h);
  const radius = la.type === 'POINT' || la.type === 'SPOT' ? child(circleGeo, h) : null;
  const cone = la.type === 'SPOT' ? child(geom([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), h) : null;
  h.userData[PARTS] = { marker, radius, cone } satisfies LightParts;
  h.userData.lightPartsKey = key;
});

const tmp = new Vector3();
const right = new Vector3(),
  up = new Vector3(),
  back = new Vector3();

/** World size of one pixel at a world position. */
function pixelSize(view: DrawView, camera: Camera, at: Vector3): number {
  const hgt = Math.max(1, view.height);
  if ((camera as OrthographicCamera).isOrthographicCamera) {
    const c = camera as OrthographicCamera;
    return (c.top - c.bottom) / c.zoom / hgt;
  }
  const c = camera as PerspectiveCamera;
  const fwd = new Vector3(0, 0, -1).applyQuaternion(c.quaternion);
  const depth = Math.max(1e-4, tmp.copy(at).sub(c.position).dot(fwd));
  return (2 * depth * Math.tan(((c.fov * Math.PI) / 180) / 2)) / c.zoom / hgt;
}

function update(so: SyncedObject, view: DrawView, camera: Camera) {
  const h = so.helper;
  const parts = h?.userData[PARTS] as LightParts | undefined;
  if (!h || !parts || !so.ev.ob.data) return;
  const la = app.doc.lights[so.ev.ob.data] as LightData | undefined;
  if (!la) return;
  const world = so.ev.world;
  const pos = new Vector3().setFromMatrixPosition(world);
  camera.updateMatrixWorld();
  right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
  back.setFromMatrixColumn(camera.matrixWorld, 2).normalize();
  const px = pixelSize(view, camera, pos);
  const bill = (s: number) => new Matrix4().makeBasis(right.clone().multiplyScalar(s), up.clone().multiplyScalar(s), back.clone().multiplyScalar(s)).setPosition(pos);
  parts.marker.matrixWorld.copy(bill(px));
  parts.marker.material = h.material;
  if (parts.radius) {
    // the radius is in world units (scaled with the object), never smaller than the marker's centre
    const sc = new Vector3().setFromMatrixScale(world);
    const r = Math.max(la.shadow_soft_size * Math.max(sc.x, sc.y, sc.z), 0);
    parts.radius.visible = r > px * 1.5;
    parts.radius.matrixWorld.copy(bill(r));
    parts.radius.material = h.material;
  }
  if (parts.cone) {
    const half = Math.min(Math.PI / 2 - 1e-4, la.spot_size / 2);
    const c = spotCircle(half);
    const inv = world.clone().invert();
    const ortho = !!(camera as OrthographicCamera).isOrthographicCamera;
    const eye = ortho ? back.clone().transformDirection(inv) : new Vector3().setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inv);
    const seg = spotSilhouette([eye.x, eye.y, eye.z], c.z, c.r, ortho);
    const attr = parts.cone.geometry.getAttribute('position') as Float32BufferAttribute;
    for (let i = 0; i < 12; i++) attr.array[i] = seg[i] ?? 0;
    attr.needsUpdate = true;
    parts.cone.visible = seg.length > 0;
    parts.cone.matrixWorld.copy(world);
    parts.cone.material = h.material;
  }
}

drawHooks.passes.push((pass, view, camera) => {
  if (pass === 'SCENE' || !renderContext) return;
  const touched: SyncedObject[] = [];
  for (const so of renderContext.sync.objects.values()) {
    if (so.ev.ob.type !== 'LIGHT' || !so.helper?.userData[PARTS]) continue;
    update(so, view, camera);
    touched.push(so);
  }
  if (pass !== 'ID') return;
  // the ID pass swaps the helper's material; put the children back on its own one afterwards
  return () => {
    for (const so of touched) {
      const parts = so.helper?.userData[PARTS] as LightParts | undefined;
      if (!parts) continue;
      for (const p of [parts.marker, parts.radius, parts.cone]) if (p) p.material = p.userData.base as Material;
    }
  };
});
