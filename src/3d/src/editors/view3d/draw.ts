// Viewport drawing: scene pass (per shading mode), grid & overlays, ID pass,
// selection outline compositing.
import { applyStudioLighting, hdriEnvironment } from '../../render/studiolights';
import {
  Color,
  Scene,
  Mesh,
  LineSegments,
  LineBasicMaterial,
  MeshBasicMaterial,
  PlaneGeometry,
  DataTexture,
  RedFormat,
  UnsignedByteType,
  NearestFilter,
  OrthographicCamera,
  Vector3,
  Matrix4,
  type Camera,
  type Material,
  type WebGLRenderTarget,
  Points,
  PointsMaterial,
  BufferGeometry,
  Float32BufferAttribute,
  InstancedMesh,
  MeshPhysicalMaterial,
  FrontSide,
  DoubleSide,
  PerspectiveCamera,
} from 'three';
import type { RenderContext } from '../../render/context';
import { createGrid } from '../../render/grid';
import { solidMaterial, idMaterial, outlineMaterial, decodeId } from '../../render/materials';
import { viewportMaterial } from '../../render/pbr';
import { makeIdTarget } from '../../render/engine';
import type { Shading, Overlay } from './state';
import type { NavCamera } from '../../render/navcam';
import type { App } from '../../app/app';
import type { DocumentData, ObjectData, WorldData } from '../../data/types';
import type { SyncedObject } from '../../render/scene';
import { evaluateWorldForViewport } from '../../render/world';
import { drawEnvironmentBackground, drawLookdevSpheres } from './lookdev';

export interface DrawView {
  nav: NavCamera;
  shading: Shading;
  overlay: Overlay;
  /** scene camera used when looking through the camera */
  sceneCamera: Camera | null;
  /** objects hidden by local view */
  localView: Set<string> | null;
  /** per-viewport object type filters (header "Selectability & Visibility") */
  hiddenTypes?: Set<string>;
  unselectableTypes?: Set<string>;
  idTarget: WebGLRenderTarget | null;
  idDirty: boolean;
  width: number;
  height: number;
  extraOverlays: ((scene: Scene, camera: Camera) => void)[];
  /** room kept free at the right edge (sidebar) for corner overlays such as the preview spheres */
  lookdevInset?: number;
  /** progressive renderer for path-traced view (optional) */
  pathTracer?: { render(camera: Camera, w: number, h: number): boolean } | null;
}

/**
 * Extension hooks for sculpt/paint displays: `materials` may replace entries of `mats` for an
 * object's main mesh (e.g. weight heat map, vertex colors, mask overlay); `skipOutline` hides the
 * selection outline of an object (e.g. the object being sculpted/painted).
 */
export const drawHooks = {
  materials: [] as ((so: SyncedObject, mode: 'SOLID' | 'MATERIAL' | 'RENDERED' | 'WIREFRAME', view: DrawView, mats: Material[]) => void)[],
  skipOutline: [] as ((ob: ObjectData) => boolean)[],
  /** called before the scene / overlay / ID pass renders the synced scene; the returned function runs after it */
  passes: [] as ((pass: 'SCENE' | 'OVERLAY' | 'ID', view: DrawView, camera: Camera) => (() => void) | void)[],
};

function runPassHooks(pass: 'SCENE' | 'OVERLAY' | 'ID', view: DrawView, camera: Camera) {
  const after: (() => void)[] = [];
  for (const hk of drawHooks.passes) {
    const f = hk(pass, view, camera);
    if (f) after.push(f);
  }
  return () => after.forEach((f) => f());
}

const theme = {
  bg: new Color().setRGB(0.229, 0.232, 0.239),
  wire: new Color(0, 0, 0),
  wireEdit: new Color(0, 0, 0),
  selected: new Color().setRGB(0.884, 0.376, 0.013),
  active: new Color().setRGB(0.987, 0.645, 0.115),
};
// three.js colors are linear; theme values above are display values → convert
for (const c of Object.values(theme)) c.convertSRGBToLinear();

export function setThemeBackground(srgb: [number, number, number]) {
  theme.bg.setRGB(srgb[0], srgb[1], srgb[2]).convertSRGBToLinear();
}

const grid = createGrid();
/** Colour tables of the viewport (Preferences ▸ Themes writes them). */
export const viewportTheme = theme;
export const gridMaterial = grid.mat;
const overlayScene = new Scene();
overlayScene.add(grid.mesh);
overlayScene.matrixWorldAutoUpdate = false;

let selTex: DataTexture | null = null;
const selData = new Uint8Array(4096 * 64);
const fsQuad = new Mesh(new PlaneGeometry(2, 2), outlineMaterial);
fsQuad.frustumCulled = false;
const fsScene = new Scene();
fsScene.add(fsQuad);
const fsCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

const originGeo = new BufferGeometry();
const originPts = new Points(originGeo, new PointsMaterial({ size: 6, sizeAttenuation: false, color: 0xfca41d, depthTest: false, transparent: true }));
originPts.renderOrder = 10;
const originGeoSel = new BufferGeometry();
const originPtsSel = new Points(originGeoSel, new PointsMaterial({ size: 6, sizeAttenuation: false, color: 0xe16003, depthTest: false, transparent: true }));
const originGeoAll = new BufferGeometry();
const originPtsAll = new Points(originGeoAll, new PointsMaterial({ size: 5, sizeAttenuation: false, color: 0xbbbcbe, depthTest: false, transparent: true }));
const relLines = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4 }));
const originScene = new Scene();
originScene.add(originPtsAll, originPtsSel, originPts, relLines);

function objectColorState(app: App, ob: ObjectData): 0 | 1 | 2 {
  if (app.doc.scene.active_object === ob.id && ob.select) return 2;
  return ob.select ? 1 : 0;
}

function solidColor(doc: DocumentData, ob: ObjectData, shading: Shading, slot: number, so: SyncedObject): [number, number, number] {
  switch (shading.color_type) {
    case 'SINGLE':
      return shading.single_color;
    case 'OBJECT':
      return [ob.color[0], ob.color[1], ob.color[2]];
    case 'RANDOM': {
      let h = 0;
      for (let i = 0; i < ob.name.length; i++) h = (h * 31 + ob.name.charCodeAt(i)) >>> 0;
      const hue = (h % 360) / 360;
      const c = new Color().setHSL(hue, 0.5, 0.55);
      return [c.r, c.g, c.b];
    }
    default: {
      const mats = materialSlots(doc, ob);
      const ma = mats[slot] ? doc.materials[mats[slot]!] : undefined;
      void so;
      return ma ? [ma.diffuse_color[0], ma.diffuse_color[1], ma.diffuse_color[2]] : [0.8, 0.8, 0.8];
    }
  }
}

export function materialSlots(doc: DocumentData, ob: ObjectData): (string | null)[] {
  const data = ob.data ? ((doc.meshes[ob.data] ?? doc.curves[ob.data] ?? doc.metaballs?.[ob.data] ?? doc.hair_curves?.[ob.data]) as { materials?: (string | null)[] } | undefined) : undefined;
  const base = data?.materials ?? [];
  if (!ob.object_materials) return base;
  return base.map((m, i) => (ob.material_slots_link?.[i] === 'OBJECT' ? ob.object_materials![i] ?? null : m));
}

/** Assign per-mode materials to synced meshes. */
function assignMaterials(app: App, ctx: RenderContext, view: DrawView, mode: 'SOLID' | 'MATERIAL' | 'RENDERED' | 'WIREFRAME' | 'ID') {
  const doc = app.doc;
  const sh = view.shading;
  for (const so of ctx.sync.objects.values()) {
    const ob = so.ev.ob;
    const meshes: Mesh[] = [];
    if (so.mesh) meshes.push(so.mesh);
    so.instances?.children.forEach((c) => meshes.push(c as Mesh));
    so.duplis?.children.forEach((c) => meshes.push(c as Mesh));
    const xray = (sh.type === 'SOLID' || sh.type === 'WIREFRAME') && sh.show_xray;
    for (const mesh of meshes) {
      // instances of other objects use those objects' materials
      const ob = (mesh.userData.source && doc.objects[mesh.userData.source as string]) || so.ev.ob;
      const groups = mesh.geometry.groups;
      const slotsCount = Math.max(1, ...groups.map((g) => (g.materialIndex ?? 0) + 1));
      const mats: Material[] = [];
      for (let s = 0; s < slotsCount; s++) {
        if (mode === 'ID') mats.push(idMaterial(ctx.sync.objectIndex(so.ev.ob.id)));
        else if (mode === 'SOLID') {
          const hasColors = !!mesh.geometry.getAttribute('color');
          mats.push(
            solidMaterial({
              color: solidColor(doc, ob, sh, s, so),
              alpha: xray ? sh.xray_alpha : 1,
              lighting: sh.light,
              vertexColors: sh.color_type === 'VERTEX' && hasColors,
              backfaceCulling: sh.show_backface_culling,
              specular: sh.show_specular_highlight,
            }),
          );
        } else {
          const slots = materialSlots(doc, ob);
          const m = viewportMaterial(doc, slots[s] ?? null);
          mats.push(m);
        }
      }
      if (mode !== 'ID' && mesh === so.mesh) for (const hk of drawHooks.materials) hk(so, mode, view, mats);
      mesh.material = mats.length === 1 ? mats[0] : mats;
      if (mesh instanceof InstancedMesh) mesh.material = mats[0];
    }
    if (so.mesh) {
      const wire = ob.display_type === 'WIRE' || ob.display_type === 'BOUNDS';
      so.mesh.visible = mode === 'ID' ? true : sh.type !== 'WIREFRAME' && !wire;
    }
  }
}

function helperColor(app: App, ob: ObjectData, base: Color) {
  const st = objectColorState(app, ob);
  return st === 2 ? theme.active : st === 1 ? theme.selected : base;
}

export function drawViewport(app: App, ctx: RenderContext, view: DrawView, x: number, y: number, w: number, h: number) {
  const engine = ctx.engine;
  const r = engine.renderer;
  const doc = app.doc;
  ctx.ensureSynced();
  view.width = w;
  view.height = h;
  const nav = view.nav;
  nav.resize(w, h);
  nav.update();
  const camera: Camera = view.sceneCamera ?? nav.camera;
  const sh = view.shading;
  const ov = view.overlay;
  const scene = ctx.sync.scene;
  const editing = doc.mode === 'EDIT';

  // visibility (local view)
  const orthoView = nav.ortho && !view.sceneCamera;
  for (const so of ctx.sync.objects.values()) {
    so.root.visible = so.ev.visible && (!view.localView || view.localView.has(so.id)) && !view.hiddenTypes?.has(so.ev.ob.type);
    if (so.imagePlane) so.imagePlane.visible = imageEmptyVisible(so.ev.ob, so.ev.world, camera, orthoView, view.nav.view !== 'USER');
  }

  // --- background & environment
  let bg: Color = theme.bg;
  // the studio light / matcap this view uses (shared shader uniforms)
  applyStudioLighting(sh);
  const rendered = sh.type === 'RENDERED';
  const material = sh.type === 'MATERIAL';
  const world = doc.scene.world ? doc.worlds[doc.scene.world] : null;
  scene.environment = null;
  scene.background = null;
  const useWorld = (rendered && sh.use_scene_world_render) || (material && sh.use_scene_world);
  const useLights = (rendered && sh.use_scene_lights_render) || (material && sh.use_scene_lights);
  if (rendered || material) {
    if (useWorld && world) {
      scene.environment = ctx.world(world, (wd: WorldData) => evaluateWorldForViewport(doc, wd));
      if (rendered && !doc.scene.render.film_transparent) {
        const b = ctx.worldBackground;
        if (b instanceof Color) bg = b;
        else if (b) scene.background = b;
      }
    } else {
      scene.environment = hdriEnvironment(r, engine.pmrem, sh.studio_hdri) ?? ctx.studio();
      scene.environmentIntensity = sh.studiolight_intensity;
    }
  }
  // the studio HDRI rotates around the world Z axis (scene worlds keep their own orientation)
  const studioEnv = (rendered || material) && !useWorld;
  scene.environmentRotation.set(0, 0, studioEnv ? (sh.studiolight_rotate_z ?? 0) : 0);
  if (sh.background_type === 'VIEWPORT' && !rendered) bg = new Color().setRGB(...sh.background_color);
  if (sh.background_type === 'WORLD' && !rendered && world) bg = new Color(world.color[0], world.color[1], world.color[2]);
  if (rendered && doc.scene.render.film_transparent) bg = new Color(0.107, 0.11, 0.117);

  // lights on only when scene lights are used
  for (const so of ctx.sync.objects.values()) if (so.light) so.light.visible = useLights && so.root.visible && !so.ev.ob.hide_render;
  r.shadowMap.enabled = rendered || (material && useLights);

  // tone mapping
  if (rendered || material) engine.setToneMapping(doc.scene.render.view_transform, doc.scene.render.exposure);
  else engine.setToneMapping('STANDARD', 0);

  engine.clear(bg, 1);
  // Material Preview / Rendered with the studio HDRI: the HDRI can show behind the scene
  if (studioEnv && scene.environment && (sh.studiolight_background_alpha ?? 0) > 0)
    drawEnvironmentBackground(r, camera, scene.environment, bg, { alpha: sh.studiolight_background_alpha, blur: sh.studiolight_background_blur ?? 0.5, intensity: sh.studiolight_intensity, rotation: sh.studiolight_rotate_z ?? 0 });

  // --- rendered view drawn by the attached render engine (render/final); it returns false to
  // fall back to the built-in pass (e.g. for the Solid render engine)
  if (rendered && view.pathTracer && view.pathTracer.render(camera, w, h)) {
    // drawn by the render engine
  } else {
    // --- scene pass
    assignMaterials(app, ctx, view, sh.type === 'WIREFRAME' ? 'WIREFRAME' : sh.type === 'SOLID' ? 'SOLID' : 'MATERIAL');
    // helpers and wires are drawn in the overlay step
    const hiddenForScene: { o: { visible: boolean }; v: boolean }[] = [];
    const hide = (o: { visible: boolean } | undefined) => {
      if (o) {
        hiddenForScene.push({ o, v: o.visible });
        o.visible = false;
      }
    };
    for (const so of ctx.sync.objects.values()) {
      hide(so.wire);
      hide(so.helper);
      hide(so.helperFill);
      hide(so.bones);
      hide(so.ground);
      hide(so.points);
    }
    const afterScene = runPassHooks('SCENE', view, camera);
    r.render(scene, camera);
    afterScene();
    for (const hdn of hiddenForScene) hdn.o.visible = hdn.v;
  }

  // preview spheres showing the lighting on a matte and a mirror surface
  if (ov.show_overlays && ov.show_look_dev && (material || rendered) && scene.environment)
    drawLookdevSpheres(r, camera, scene.environment, { x, y, w, h }, { intensity: studioEnv ? sh.studiolight_intensity : 1, rotation: studioEnv ? (sh.studiolight_rotate_z ?? 0) : 0, right: view.lookdevInset ?? 0 });

  // reset tone mapping for overlays
  engine.setToneMapping('STANDARD', 0);

  if (ov.show_overlays) {
    drawOverlays(app, ctx, view, camera, editing);
  }

  // --- ID pass (also used for picking)
  if (ov.show_overlays && ov.show_outline_selected && sh.show_object_outline !== false) drawOutline(app, ctx, view, camera, x, y, w, h);
  else view.idDirty = true;
}

function drawOverlays(app: App, ctx: RenderContext, view: DrawView, camera: Camera, editing: boolean) {
  const r = ctx.engine.renderer;
  const doc = app.doc;
  const sh = view.shading;
  const ov = view.overlay;
  const nav = view.nav;
  // grid
  const ortho = nav.ortho && !view.sceneCamera;
  const axisView = ortho && nav.view !== 'USER';
  if ((axisView ? ov.show_ortho_grid : ov.show_floor || ov.show_axis_x || ov.show_axis_y) && !view.sceneCamera) {
    const u = grid.mat.uniforms;
    let plane = 0;
    if (axisView && (nav.view === 'FRONT' || nav.view === 'BACK')) plane = 1;
    else if (axisView && (nav.view === 'LEFT' || nav.view === 'RIGHT')) plane = 2;
    u.uPlane.value = plane;
    const cam = (camera as PerspectiveCamera).position;
    const eye = ortho ? nav.pivot.clone() : cam.clone();
    // snap grid origin to avoid precision issues
    const snap = (v: number) => Math.round(v / 100) * 100;
    u.uCam.value.set(snap(eye.x), snap(eye.y), snap(eye.z));
    u.uOrtho.value = ortho ? 1 : 0;
    u.uFade.value = ortho ? Math.max(50, nav.distance * 10) : Math.max(40, Math.min(1000, nav.distance * 8 + Math.abs(cam.z) * 6));
    u.uScale.value = ov.grid_scale;
    u.uShowAxes.value.set(axisView ? 1 : ov.show_axis_x ? 1 : 0, axisView ? 1 : ov.show_axis_y ? 1 : 0, axisView ? 1 : ov.show_axis_z ? 1 : 0);
    u.uShowFloor.value = axisView || ov.show_floor ? 1 : 0;
    grid.mesh.matrixWorld.identity();
    r.render(overlayScene, camera);
  }
  // wires, helpers & bones (depth-tested against the scene)
  const s = ctx.sync.scene;
  const visible: { o: { visible: boolean }; v: boolean }[] = [];
  const set = (o: { visible: boolean } | undefined, v: boolean) => {
    if (!o) return;
    visible.push({ o, v: o.visible });
    o.visible = v;
  };
  for (const so of ctx.sync.objects.values()) {
    const ob = so.ev.ob;
    const shown = so.root.visible;
    set(so.mesh, false);
    so.instances && set(so.instances, false);
    so.duplis && set(so.duplis, false);
    if (so.light) set(so.light, so.light.visible);
    const col = helperColor(app, ob, theme.wire);
    const inEdit = editing && app.graph.editObjects.has(ob.id);
    // the camera being looked through is not drawn (only its frame, as the passepartout)
    const lookingThrough = !!view.sceneCamera && ob.id === ((view as { activeCameraId?: () => string | null }).activeCameraId?.() ?? doc.scene.camera);
    const showWire =
      shown &&
      // curves keep their wire while editing (the control points are an overlay on top)
      (!inEdit || ob.type !== 'MESH') &&
      !!so.wire &&
      (sh.type === 'WIREFRAME' || ob.display_type === 'WIRE' || ob.display_type === 'BOUNDS' || ob.show_wire || ov.show_wireframes || (ob.type !== 'MESH' && !so.mesh?.geometry.index?.count));
    if (so.wire) {
      set(so.wire, showWire);
      const m = so.wire.material as LineBasicMaterial;
      const st = objectColorState(app, ob);
      if (inEdit) {
        m.color.copy(theme.wire);
        m.opacity = 1;
      } else if (sh.type === 'WIREFRAME' || ob.display_type === 'WIRE' || ob.type !== 'MESH') {
        m.color.copy(st ? col : sh.type === 'WIREFRAME' ? new Color(0, 0, 0) : theme.wire);
        m.opacity = st ? 1 : sh.type === 'WIREFRAME' ? 0.85 : 1;
      } else {
        m.color.copy(st ? col : theme.wire);
        m.opacity = st ? 0.8 : 0.35 * ov.wireframe_opacity;
      }
      m.transparent = true;
      m.depthTest = !(sh.show_xray && sh.type !== 'MATERIAL' && sh.type !== 'RENDERED');
    }
    if (so.points) {
      set(so.points, shown);
      (so.points.material as PointsMaterial).color.copy(objectColorState(app, ob) ? col : new Color(0, 0, 0));
    }
    if (so.helper) {
      set(so.helper, shown && ov.show_extras && !lookingThrough);
      (so.helper.material as LineBasicMaterial).color.copy(col);
    }
    if (so.helperFill) {
      set(so.helperFill, shown && ov.show_extras && !lookingThrough);
      (so.helperFill.material as MeshBasicMaterial).color.copy(col);
    }
    if (so.ground) set(so.ground, shown && ov.show_extras);
    if (so.bones) {
      set(so.bones, shown && ov.show_bones);
      const pose = doc.mode === 'POSE' && app.activeObject?.id === ob.id;
      const armEdit = doc.mode === 'EDIT' && app.activeObject?.id === ob.id;
      const arm = ob.data ? doc.armatures[ob.data] : undefined;
      for (const c of so.bones.children) {
        const bname = c.userData.bone as string;
        const bone = arm?.bones.find((b) => b.name === bname);
        const pb = ob.pose?.[bname];
        const selected = pose ? !!pb?.select : false;
        const active = pose && arm?.active_bone === bname;
        if (c.userData.boneFill) {
          const mm = (c as Mesh).material as MeshBasicMaterial;
          mm.color.set(pose ? (active ? 0xa2f9fe : selected ? 0x44ccfc : 0x7b8999) : 0x8b8c8e);
          mm.opacity = sh.type === 'WIREFRAME' ? 0 : 0.85;
          mm.depthTest = !arm?.show_in_front;
        } else {
          const lm = (c as LineSegments).material as LineBasicMaterial;
          const eSel = armEdit && !!bone?.select,
            eAct = armEdit && arm?.active_bone === bname;
          lm.color.copy(pose ? (active ? new Color(1, 1, 1) : selected ? new Color(0.268, 0.798, 0.989) : new Color(0, 0, 0)) : armEdit ? (eSel ? (eAct ? new Color(0.992, 0.818, 0.493) : new Color(0.96, 0.554, 0.015)) : new Color(0, 0, 0)) : col);
          lm.depthTest = !arm?.show_in_front;
        }
      }
    }
  }
  // overlays must not repaint a texture background over the shaded scene
  const overlayBg = s.background;
  s.background = null;
  const afterOverlay = runPassHooks('OVERLAY', view, camera);
  r.render(s, camera);
  afterOverlay();
  s.background = overlayBg;
  for (const v of visible) v.o.visible = v.v;

  // extra overlays (edit mesh, sculpt cursor, etc)
  for (const fn of view.extraOverlays) fn(s, camera);

  // origins & relationship lines (no depth test)
  if (ov.show_object_origins || ov.show_relationship_lines) {
    const act: number[] = [],
      sel: number[] = [],
      all: number[] = [],
      rel: number[] = [];
    for (const so of ctx.sync.objects.values()) {
      if (!so.root.visible) continue;
      const ob = so.ev.ob;
      const p = new Vector3().setFromMatrixPosition(so.ev.world);
      if (ov.show_relationship_lines && ob.parent) {
        const parent = app.graph.get(ob.parent);
        if (parent) {
          const pp = new Vector3().setFromMatrixPosition(parent.world);
          rel.push(p.x, p.y, p.z, pp.x, pp.y, pp.z);
        }
      }
      if (ov.show_relationship_lines) {
        for (const c of ob.constraints) {
          const t = c.target ? app.graph.get(c.target as string) : undefined;
          if (t) {
            const tp = new Vector3().setFromMatrixPosition(t.world);
            rel.push(p.x, p.y, p.z, tp.x, tp.y, tp.z);
          }
        }
      }
      if (!ov.show_object_origins || editing) continue;
      const st = objectColorState(app, ob);
      if (st === 2) act.push(p.x, p.y, p.z);
      else if (st === 1) sel.push(p.x, p.y, p.z);
      else if (ov.show_object_origins_all) all.push(p.x, p.y, p.z);
    }
    originGeo.setAttribute('position', new Float32BufferAttribute(act, 3));
    originGeoSel.setAttribute('position', new Float32BufferAttribute(sel, 3));
    originGeoAll.setAttribute('position', new Float32BufferAttribute(all, 3));
    relLines.geometry.setAttribute('position', new Float32BufferAttribute(rel, 3));
    relLines.geometry.setDrawRange(0, rel.length / 3);
    originScene.updateMatrixWorld(true);
    r.render(originScene, camera);
  }
}

function drawOutline(app: App, ctx: RenderContext, view: DrawView, camera: Camera, x: number, y: number, w: number, h: number) {
  const r = ctx.engine.renderer;
  const dpr = ctx.engine.dpr;
  const W = Math.round(w * dpr),
    H = Math.round(h * dpr);
  renderIdPass(app, ctx, view, camera, W, H);
  // selection state texture
  if (!selTex) {
    selTex = new DataTexture(selData, 4096, 64, RedFormat, UnsignedByteType);
    selTex.minFilter = selTex.magFilter = NearestFilter;
  }
  selData.fill(0);
  const editing = app.doc.mode === 'EDIT';
  for (const so of ctx.sync.objects.values()) {
    const ob = so.ev.ob;
    const idx = ctx.sync.objectIndex(ob.id);
    if (idx >= selData.length) continue;
    // objects in edit mode do not get an outline
    if (editing && app.graph.editObjects.has(ob.id)) continue;
    if (drawHooks.skipOutline.some((f) => f(ob))) continue;
    selData[idx] = objectColorState(app, ob);
  }
  selTex.needsUpdate = true;
  const u = outlineMaterial.uniforms;
  u.tId.value = view.idTarget!.texture;
  u.tSel.value = selTex;
  u.uSize.value.set(W, H, 1);
  u.uWidth.value = Math.max(1, dpr * 0.9);
  r.setRenderTarget(null);
  r.setViewport(x, y, w, h);
  r.setScissor(x, y, w, h);
  r.setScissorTest(true);
  r.render(fsScene, fsCam);
}

/** Render object ids into the viewport's ID target (cached until the next draw). */
export function renderIdPass(app: App, ctx: RenderContext, view: DrawView, camera: Camera, W: number, H: number) {
  const r = ctx.engine.renderer;
  if (!view.idTarget) view.idTarget = makeIdTarget(W, H);
  if (view.idTarget.width !== W || view.idTarget.height !== H) view.idTarget.setSize(W, H);
  const scene = ctx.sync.scene;
  assignMaterials(app, ctx, view, 'ID');
  const saved: { o: { visible: boolean; material?: unknown }; v: boolean; m?: unknown }[] = [];
  const bg = scene.background,
    env = scene.environment;
  scene.background = null;
  scene.environment = null;
  for (const so of ctx.sync.objects.values()) {
    const ob = so.ev.ob;
    const vis = so.root.visible && so.ev.selectable && !view.unselectableTypes?.has(ob.type);
    const idm = idMaterial(ctx.sync.objectIndex(ob.id));
    const swap = (o: { visible: boolean; material?: unknown } | undefined, visible: boolean) => {
      if (!o) return;
      saved.push({ o, v: o.visible, m: o.material });
      o.visible = visible;
      if (visible) o.material = idm;
    };
    if (so.mesh) {
      const wireOnly = view.shading.type === 'WIREFRAME' || ob.display_type === 'WIRE';
      swap(so.mesh, vis && !wireOnly);
    }
    if (so.wire) swap(so.wire, vis && (view.shading.type === 'WIREFRAME' || ob.display_type === 'WIRE' || (ob.type !== 'MESH' && !!so.ev.mesh?.curves)));
    swap(so.helper, vis && view.overlay.show_extras);
    swap(so.helperFill, vis && view.overlay.show_extras);
    swap(so.imagePlane, vis && so.imagePlane?.visible !== false);
    swap(so.points, vis);
    if (so.bones) {
      saved.push({ o: so.bones, v: so.bones.visible });
      so.bones.visible = vis;
      for (const c of so.bones.children) swap(c as unknown as { visible: boolean; material?: unknown }, vis);
    }
    if (so.ground) swap(so.ground, false);
    if (so.light) swap(so.light, false);
  }
  r.setRenderTarget(view.idTarget);
  r.setScissorTest(false);
  r.setViewport(0, 0, W / ctx.engine.dpr, H / ctx.engine.dpr);
  r.setClearColor(0x000000, 0);
  r.clear(true, true, true);
  const afterId = runPassHooks('ID', view, camera);
  r.render(scene, camera);
  afterId();
  r.setRenderTarget(null);
  for (const s of saved.reverse()) {
    s.o.visible = s.v;
    if (s.m !== undefined) s.o.material = s.m;
  }
  scene.background = bg;
  scene.environment = env;
  view.idDirty = false;
}

/** Read object ids in a pixel rectangle of the ID target (client px relative to the viewport). */
export function readIds(ctx: RenderContext, view: DrawView, x0: number, y0: number, x1: number, y1: number, filter?: (x: number, y: number) => boolean): Map<string, number> {
  const out = new Map<string, number>();
  if (!view.idTarget) return out;
  const dpr = ctx.engine.dpr;
  const W = view.idTarget.width,
    H = view.idTarget.height;
  const ax = Math.max(0, Math.floor(Math.min(x0, x1) * dpr)),
    bx = Math.min(W, Math.ceil(Math.max(x0, x1) * dpr)),
    ay = Math.max(0, Math.floor(Math.min(y0, y1) * dpr)),
    by = Math.min(H, Math.ceil(Math.max(y0, y1) * dpr));
  const w = bx - ax,
    h = by - ay;
  if (w <= 0 || h <= 0) return out;
  const buf = new Uint8Array(w * h * 4);
  ctx.engine.renderer.readRenderTargetPixels(view.idTarget, ax, H - by, w, h, buf);
  for (let i = 0; i < w * h; i++) {
    // rows come bottom-up; test the pixel centre in viewport (CSS) coordinates
    if (filter && !filter((ax + (i % w) + 0.5) / dpr, (by - 1 - Math.floor(i / w) + 0.5) / dpr)) continue;
    const id = decodeId(buf[i * 4], buf[i * 4 + 1], buf[i * 4 + 2]);
    if (id < 0) continue;
    const ob = ctx.sync.idToObject[id];
    if (ob) out.set(ob, (out.get(ob) ?? 0) + 1);
  }
  return out;
}

/** Pick the object closest to (x,y) within a radius from the ID target. */
export function pickId(ctx: RenderContext, view: DrawView, x: number, y: number, radius = 6): { id: string; order: string[] } | null {
  if (!view.idTarget) return null;
  const dpr = ctx.engine.dpr;
  const W = view.idTarget.width,
    H = view.idTarget.height;
  const R = Math.round(radius * dpr);
  const cx = Math.round(x * dpr),
    cy = Math.round(y * dpr);
  const ax = Math.max(0, cx - R),
    ay = Math.max(0, cy - R),
    bx = Math.min(W, cx + R + 1),
    by = Math.min(H, cy + R + 1);
  const w = bx - ax,
    h = by - ay;
  if (w <= 0 || h <= 0) return null;
  const buf = new Uint8Array(w * h * 4);
  ctx.engine.renderer.readRenderTargetPixels(view.idTarget, ax, H - by, w, h, buf);
  const dist = new Map<string, number>();
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const k = ((h - 1 - j) * w + i) * 4;
      const id = decodeId(buf[k], buf[k + 1], buf[k + 2]);
      if (id < 0) continue;
      const ob = ctx.sync.idToObject[id];
      if (!ob) continue;
      const d = Math.hypot(ax + i - cx, ay + j - cy);
      if (d <= R && d < (dist.get(ob) ?? Infinity)) dist.set(ob, d);
    }
  if (!dist.size) return null;
  const order = [...dist.entries()].sort((a, b) => a[1] - b[1]).map((e) => e[0]);
  return { id: order[0], order };
}

export { Matrix4, MeshPhysicalMaterial, FrontSide, DoubleSide };

/** Image empties can be limited to orthographic/perspective views and to views facing them. */
function imageEmptyVisible(ob: ObjectData, world: Matrix4, camera: Camera, ortho: boolean, axisView: boolean): boolean {
  if (ortho ? ob.show_empty_image_orthographic === false : ob.show_empty_image_perspective === false) return false;
  if (ob.show_empty_image_only_axis_aligned) {
    if (!ortho || !axisView) return false;
    const n = new Vector3(0, 0, 1).transformDirection(world);
    const d = new Vector3(0, 0, -1).transformDirection(camera.matrixWorld);
    if (Math.abs(n.dot(d)) < 0.999) return false;
  }
  return true;
}
