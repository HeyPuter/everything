// Synchronises the evaluated depsgraph into a three.js scene graph.
import { boneVisible } from '../modes/armature/armkernels';
import { boneShape } from '../modes/armature/boneshapes';
import {
  Scene,
  Group,
  Mesh,
  LineSegments,
  LineBasicMaterial,
  Object3D,
  PointLight,
  DirectionalLight,
  SpotLight,
  RectAreaLight,
  Color,
  Matrix4,
  MeshBasicMaterial,
  DoubleSide,
  FrontSide,
  BackSide,
  Float32BufferAttribute,
  BufferGeometry,
  Points,
  PointsMaterial,
  InstancedMesh,
  type Material,
  Vector3,
  Quaternion,
  Euler,
} from 'three';
import type { App } from '../app/app';
import type { EvalObject } from '../eval/depsgraph';
import type { DocumentData, ObjectData } from '../data/types';
import { meshGeometry, wireGeometry, pointGeometry } from './geometry';
import { imageTexture } from './images';
import { cameraWire, cameraTriangle, lightWire, emptyWire, geom, boneOctahedron, latticeWire, groundLine } from './helpers';

export interface SyncedObject {
  id: string;
  root: Group;
  mesh?: Mesh;
  wire?: LineSegments;
  helper?: LineSegments;
  helperFill?: Mesh;
  /** textured plane of an image empty */
  imagePlane?: Mesh;
  light?: PointLight | DirectionalLight | SpotLight | RectAreaLight;
  ground?: LineSegments;
  bones?: Group;
  points?: Points;
  instances?: Group;
  /** collection / vertex / face instances of other objects (src/object/instancing.ts) */
  duplis?: Group;
  geomVersion: number;
  helperKey: string;
  ev: EvalObject;
}

const helperMat = () => new LineBasicMaterial({ color: 0x000000 });

/** Extra per-object content (e.g. grease pencil strokes): called for every synced object. */
export const sceneSyncHooks: ((doc: DocumentData, ev: EvalObject, so: SyncedObject) => void)[] = [];

export class SceneSync {
  scene = new Scene();
  objects = new Map<string, SyncedObject>();
  /** stable small integer ids for the ID pass */
  ids = new Map<string, number>();
  idToObject: string[] = [];
  private nextId = 0;

  constructor(private app: App) {
    this.scene.matrixWorldAutoUpdate = false;
  }

  objectIndex(id: string) {
    let i = this.ids.get(id);
    if (i === undefined) {
      i = this.nextId++;
      this.ids.set(id, i);
      this.idToObject[i] = id;
    }
    return i;
  }

  sync() {
    const doc = this.app.doc;
    const graph = this.app.graph;
    const seen = new Set<string>();
    for (const ev of graph.objects.values()) {
      seen.add(ev.id);
      let so = this.objects.get(ev.id);
      if (!so) {
        const root = new Group();
        root.matrixAutoUpdate = false;
        root.userData.id = ev.id;
        this.scene.add(root);
        so = { id: ev.id, root, geomVersion: -1, helperKey: '', ev };
        this.objects.set(ev.id, so);
        this.objectIndex(ev.id);
      }
      so.ev = ev;
      so.root.visible = ev.visible;
      so.root.matrix.copy(ev.world);
      so.root.matrixWorld.copy(ev.world);
      this.syncData(doc, ev, so);
      for (const hk of sceneSyncHooks) hk(doc, ev, so);
    }
    for (const [id, so] of this.objects)
      if (!seen.has(id)) {
        this.scene.remove(so.root);
        this.disposeObject(so);
        this.objects.delete(id);
      }
    this.scene.updateMatrixWorld(true);
  }

  private disposeObject(so: SyncedObject) {
    so.helper?.geometry.dispose();
    so.helperFill?.geometry.dispose();
    if (so.ground) this.scene.remove(so.ground);
    so.ground?.geometry.dispose();
    so.light?.dispose();
  }

  private syncData(doc: DocumentData, ev: EvalObject, so: SyncedObject) {
    const ob = ev.ob;
    // geometry
    if (ev.mesh) {
      if (so.geomVersion !== ev.geomVersion) {
        so.geomVersion = ev.geomVersion;
        const info = meshGeometry(ev.mesh);
        if (!so.mesh) {
          so.mesh = new Mesh(info.geometry);
          so.mesh.matrixAutoUpdate = false;
          so.mesh.userData.id = ev.id;
          so.root.add(so.mesh);
        } else so.mesh.geometry = info.geometry;
        so.mesh.userData.triFace = info.triFace;
        const wg = wireGeometry(ev.mesh);
        if (!so.wire) {
          so.wire = new LineSegments(wg, new LineBasicMaterial({ color: 0x000000 }));
          so.wire.matrixAutoUpdate = false;
          so.root.add(so.wire);
        } else so.wire.geometry = wg;
        // loose points (point clouds / vertices without faces)
        const loose = ev.mesh.indices.length === 0 && !ev.mesh.curves?.length && ev.mesh.positions.length > 0;
        if (loose) {
          if (!so.points) {
            so.points = new Points(pointGeometry(ev.mesh), new PointsMaterial({ color: 0x000000, size: 3, sizeAttenuation: false }));
            so.root.add(so.points);
          } else so.points.geometry = pointGeometry(ev.mesh);
        } else if (so.points) {
          so.root.remove(so.points);
          so.points = undefined;
        }
        this.syncInstances(doc, ev, so);
      }
      so.mesh!.castShadow = !ob.hide_render && ob.visible_shadow !== false;
      so.mesh!.receiveShadow = true;
    } else if (so.mesh) {
      so.root.remove(so.mesh);
      if (so.wire) so.root.remove(so.wire);
      so.mesh = undefined;
      so.wire = undefined;
      so.geomVersion = -1;
    }
    // helpers (cameras, lights, empties, armatures, lattices)
    let key = '';
    const r = doc.scene.render;
    const aspect = (r.resolution_x * r.pixel_aspect_x) / (r.resolution_y * r.pixel_aspect_y);
    if (ob.type === 'CAMERA' && ob.data) key = 'C' + JSON.stringify(doc.cameras[ob.data]) + aspect;
    else if (ob.type === 'LIGHT' && ob.data) key = 'L' + JSON.stringify(doc.lights[ob.data]);
    else if (ob.type === 'EMPTY') key = `E${ob.empty_display_type}${ob.empty_display_size}` + (ob.empty_display_type === 'IMAGE' ? imageEmptyKey(doc, ob) : '');
    else if (ob.type === 'LATTICE' && ob.data) key = 'T' + doc.lattices[ob.data]?.points.join(',');
    else if (ob.type === 'ARMATURE' && ob.data) {
      const arm = doc.armatures[ob.data];
      key = 'A' + (ev.pose?.signature ?? '') + arm?.display_type + arm?.bones.length + (arm?.bones.map((b) => (boneVisible(arm, b) ? 1 : 0) + (b.show_wire ? 2 : 0)).join('') ?? '') + (arm?.display_type === 'ENVELOPE' || arm?.display_type === 'BBONE' ? arm.bones.map((b) => `${b.head_radius},${b.tail_radius},${b.bbone_segments},${b.bbone_x},${b.bbone_z}`).join(';') : '');
    }
    if (key !== so.helperKey) {
      so.helperKey = key;
      if (so.helper) {
        so.root.remove(so.helper);
        so.helper.geometry.dispose();
        so.helper = undefined;
      }
      if (so.helperFill) {
        so.root.remove(so.helperFill);
        so.helperFill = undefined;
      }
      if (so.bones) {
        so.root.remove(so.bones);
        // geometries / materials are built per rebuild: free them
        const geos = new Set<{ dispose(): void }>();
        so.bones.traverse((c) => {
          const o = c as unknown as { geometry?: { dispose(): void }; material?: { dispose(): void } };
          if (o.geometry) geos.add(o.geometry);
          o.material?.dispose();
        });
        geos.forEach((g) => g.dispose());
        so.bones = undefined;
      }
      if (so.imagePlane) {
        so.root.remove(so.imagePlane);
        so.imagePlane.geometry.dispose();
        (so.imagePlane.material as Material).dispose();
        so.imagePlane = undefined;
      }
      let seg: number[] | null = null;
      if (ob.type === 'CAMERA' && ob.data) {
        seg = cameraWire(doc.cameras[ob.data], aspect);
        const tri = new BufferGeometry();
        tri.setAttribute('position', geom(cameraTriangle(doc.cameras[ob.data], aspect)).getAttribute('position'));
        so.helperFill = new Mesh(tri, new MeshBasicMaterial({ color: 0x000000, side: DoubleSide }));
        so.helperFill.userData.id = ev.id;
        so.root.add(so.helperFill);
      } else if (ob.type === 'LIGHT' && ob.data) seg = lightWire(doc.lights[ob.data], 0);
      else if (ob.type === 'EMPTY' && ob.empty_display_type === 'IMAGE') seg = this.buildImageEmpty(doc, ev, so);
      else if (ob.type === 'EMPTY') seg = emptyWire(ob);
      else if (ob.type === 'LATTICE' && ob.data) seg = latticeWire(doc.lattices[ob.data]);
      else if (ob.type === 'ARMATURE' && ev.pose) this.buildBones(doc, ev, so);
      if (seg) {
        so.helper = new LineSegments(geom(seg), helperMat());
        so.helper.userData.id = ev.id;
        so.helper.matrixAutoUpdate = false;
        so.root.add(so.helper);
      }
    }
    // light ground line (world space): rebuilt cheaply each sync
    if (ob.type === 'LIGHT' && ob.data && doc.lights[ob.data].type !== 'SUN') {
      const p = new Vector3().setFromMatrixPosition(ev.world);
      if (so.ground) {
        this.scene.remove(so.ground);
        so.ground.geometry.dispose();
      }
      so.ground = new LineSegments(geom(groundLine(p.x, p.y, p.z)), new LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.5 }));
      so.ground.matrixAutoUpdate = false;
      so.ground.visible = ev.visible;
      so.ground.userData.overlay = true;
      this.scene.add(so.ground);
    }
    // actual light sources (used in material preview with scene lights / rendered mode)
    if (ob.type === 'LIGHT' && ob.data) this.syncLight(doc, ev, so);
    else if (so.light) {
      so.root.remove(so.light);
      so.light.dispose();
      so.light = undefined;
    }
  }

  /** Image empty: a textured quad plus its frame (returned as line segments). */
  private buildImageEmpty(doc: DocumentData, ev: EvalObject, so: SyncedObject): number[] {
    const ob = ev.ob;
    const img = ob.data ? doc.images[ob.data] : undefined;
    const [w, hgt] = imageEmptySize(ob, img);
    const off = ob.empty_image_offset ?? [-0.5, -0.5];
    const x0 = off[0] * w,
      y0 = off[1] * hgt,
      x1 = x0 + w,
      y1 = y0 + hgt;
    if (img) {
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute([x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0], 3));
      g.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      const side = ob.empty_image_side === 'FRONT' ? FrontSide : ob.empty_image_side === 'BACK' ? BackSide : DoubleSide;
      const alpha = ob.use_empty_image_alpha ? ob.color[3] : 1;
      const m = new MeshBasicMaterial({ map: imageTexture(img), side, transparent: true, opacity: alpha, toneMapped: false });
      const depth = ob.empty_image_depth ?? 'DEFAULT';
      if (depth === 'FRONT') {
        m.depthTest = false;
        m.depthWrite = false;
      } else if (depth === 'BACK') m.depthWrite = false;
      so.imagePlane = new Mesh(g, m);
      so.imagePlane.renderOrder = depth === 'FRONT' ? 10 : depth === 'BACK' ? -10 : 0;
      so.imagePlane.matrixAutoUpdate = false;
      so.imagePlane.userData.id = ev.id;
      so.imagePlane.userData.imageEmpty = true;
      so.root.add(so.imagePlane);
    }
    const seg: number[] = [];
    const pts = [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
    for (let i = 0; i < 4; i++) {
      const a = pts[i],
        b = pts[(i + 1) % 4];
      seg.push(a[0], a[1], 0, b[0], b[1], 0);
    }
    return seg;
  }

  private buildBones(doc: DocumentData, ev: EvalObject, so: SyncedObject) {
    const arm = doc.armatures[ev.ob.data!];
    const g = new Group();
    g.matrixAutoUpdate = false;
    const oct = boneOctahedron();
    const lineGeo = geom(oct.lines),
      triGeo = geom(oct.tris);
    triGeo.computeVertexNormals();
    for (const name of ev.pose!.order) {
      const b = ev.pose!.bones.get(name)!;
      const bone = arm.bones.find((x) => x.name === name);
      // display type (octahedral uses the shared geometry)
      const shape = boneShape(arm.display_type, bone, b.length);
      const m = shape && !shape.unit ? b.pose.clone() : b.pose.clone().multiply(new Matrix4().makeScale(b.length, b.length, b.length));
      let lg = lineGeo,
        tg = triGeo;
      if (shape) {
        lg = geom(shape.lines);
        tg = geom(shape.tris);
        tg.computeVertexNormals();
      }
      const l = new LineSegments(lg, new LineBasicMaterial({ color: 0x000000 }));
      l.matrixAutoUpdate = false;
      l.matrix.copy(m);
      l.userData.bone = name;
      l.userData.id = ev.id;
      const f = new Mesh(tg, new MeshBasicMaterial({ color: 0x8c8c8c, transparent: true, opacity: arm.display_type === 'ENVELOPE' ? 0.35 : 0.85 }));
      f.matrixAutoUpdate = false;
      f.matrix.copy(m);
      f.userData.bone = name;
      f.userData.id = ev.id;
      f.userData.boneFill = true;
      if (bone && !boneVisible(arm, bone)) {
        l.visible = f.visible = false;
      }
      if (bone?.show_wire || arm.display_type === 'WIRE') f.visible = false;
      g.add(f, l);
    }
    so.bones = g;
    so.root.add(g);
  }

  private syncLight(doc: DocumentData, ev: EvalObject, so: SyncedObject) {
    const la = doc.lights[ev.ob.data!];
    const want = la.type === 'POINT' ? 'PointLight' : la.type === 'SUN' ? 'DirectionalLight' : la.type === 'SPOT' ? 'SpotLight' : 'RectAreaLight';
    if (so.light && so.light.type !== want) {
      so.root.remove(so.light);
      so.light.dispose();
      so.light = undefined;
    }
    if (!so.light) {
      if (la.type === 'POINT') so.light = new PointLight();
      else if (la.type === 'SUN') {
        const d = new DirectionalLight();
        d.target.position.set(0, 0, -1);
        d.add(d.target);
        so.light = d;
      } else if (la.type === 'SPOT') {
        const s = new SpotLight();
        s.target.position.set(0, 0, -1);
        s.add(s.target);
        so.light = s;
      } else so.light = new RectAreaLight();
      so.root.add(so.light);
    }
    const L = so.light;
    L.color = new Color(la.color[0], la.color[1], la.color[2]);
    // radiometric watts → three.js photometric-style units (see docs/rendering.md)
    if (L instanceof PointLight) {
      L.intensity = la.energy / (4 * Math.PI);
      L.distance = 0;
      L.decay = 2;
    } else if (L instanceof SpotLight) {
      L.intensity = la.energy / (4 * Math.PI);
      L.angle = Math.min(Math.PI / 2, la.spot_size / 2);
      L.penumbra = la.spot_blend;
      L.decay = 2;
      L.distance = 0;
    } else if (L instanceof DirectionalLight) L.intensity = la.energy;
    else if (L instanceof RectAreaLight) {
      const w = la.size,
        h = la.shape === 'RECTANGLE' || la.shape === 'ELLIPSE' ? la.size_y : la.size;
      L.width = w;
      L.height = h;
      L.intensity = la.energy / (Math.PI * Math.max(1e-4, w * h)) / 4;
      L.lookAt(new Vector3(0, 0, -1));
    }
    if (!(L instanceof RectAreaLight)) {
      L.castShadow = la.use_shadow;
      if (L.shadow) {
        L.shadow.mapSize.set(doc.scene.render.shadow_cube_size * 2, doc.scene.render.shadow_cube_size * 2);
        L.shadow.bias = -0.0005;
        L.shadow.normalBias = 0.02;
        L.shadow.radius = 3;
        if (L instanceof DirectionalLight) {
          const cam = L.shadow.camera;
          cam.left = cam.bottom = -15;
          cam.right = cam.top = 15;
          cam.near = 0.1;
          cam.far = 200;
          L.shadow.mapSize.set(doc.scene.render.shadow_cascade_size * 2, doc.scene.render.shadow_cascade_size * 2);
          // place the sun far along its direction so the ortho shadow camera covers the scene
          L.position.set(0, 0, 0);
        }
      }
    }
  }

  private syncInstances(doc: DocumentData, ev: EvalObject, so: SyncedObject) {
    if (so.instances) {
      so.root.remove(so.instances);
      so.instances = undefined;
    }
    const inst = ev.mesh?.instances;
    if (!inst?.length) return;
    const g = new Group();
    g.matrixAutoUpdate = false;
    // group identical meshes into InstancedMesh batches
    const batches = new Map<unknown, { geo: BufferGeometry; mats: Matrix4[] }>();
    for (const it of inst) {
      let geo: BufferGeometry | null = null;
      let keyObj: unknown = it.mesh;
      if (it.mesh) geo = meshGeometry(it.mesh).geometry;
      else if (it.objectId) {
        const src = this.app.graph.get(it.objectId);
        if (src?.mesh) {
          geo = meshGeometry(src.mesh).geometry;
          keyObj = src.mesh;
        }
      }
      if (!geo) continue;
      let b = batches.get(keyObj);
      if (!b) {
        b = { geo, mats: [] };
        batches.set(keyObj, b);
      }
      b.mats.push(new Matrix4().fromArray(it.matrix));
    }
    for (const b of batches.values()) {
      const im = new InstancedMesh(b.geo, undefined as unknown as Material, b.mats.length);
      b.mats.forEach((m, i) => im.setMatrixAt(i, m));
      im.instanceMatrix.needsUpdate = true;
      im.userData.id = ev.id;
      im.userData.instanced = true;
      im.castShadow = true;
      im.receiveShadow = true;
      g.add(im);
    }
    so.instances = g;
    so.root.add(g);
    void doc;
  }
}

export function worldPosition(m: Matrix4) {
  return new Vector3().setFromMatrixPosition(m);
}

export function worldRotation(m: Matrix4) {
  const q = new Quaternion();
  m.decompose(new Vector3(), q, new Vector3());
  return new Euler().setFromQuaternion(q);
}

export type { Object3D, ObjectData };

/** Width/height of an image empty: the larger side equals the display size. */
export function imageEmptySize(ob: ObjectData, img: { width: number; height: number } | undefined): [number, number] {
  const s = ob.empty_display_size;
  if (!img || !img.width || !img.height) return [s, s];
  const m = Math.max(img.width, img.height);
  return [(s * img.width) / m, (s * img.height) / m];
}

function imageEmptyKey(doc: DocumentData, ob: ObjectData) {
  const img = ob.data ? doc.images[ob.data] : undefined;
  return `|${ob.data}|${img?.width}x${img?.height}|${img?.revision ?? 0}|${ob.empty_image_offset ?? ''}|${ob.empty_image_depth}|${ob.empty_image_side}|${ob.use_empty_image_alpha ? ob.color[3] : 1}`;
}
