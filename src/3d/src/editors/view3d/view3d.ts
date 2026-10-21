// 3D Viewport editor.
import { Vector3, Matrix4, PerspectiveCamera, OrthographicCamera, Box3, Quaternion, type Camera } from 'three';
import { h, patch, type Child } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app, type ChangeKind } from '../../app/app';
import type { Area, Editor } from '../../ui/screen';
import { NavCamera } from '../../render/navcam';
import { renderContext } from '../../render/context';
import type { ViewportRenderer, RenderEngine } from '../../render/engine';
import { defaultOverlay, defaultShading, type Overlay, type Shading } from './state';
import { drawViewport, pickId, readIds, renderIdPass, type DrawView } from './draw';
import { prefs, activeTools } from '../../app/prefs';
import { playbackFpsLabel } from '../../app/fps';
import { viewHeader } from './header';
import { toolbar, toolHeaderRow } from './toolbar';
import { sidebar } from './sidebar';
import { navGizmo } from './navgizmo';
import { selectObjects, selectPick } from './select';
import { transformGizmo, gizmoPointerDown } from './gizmo';
import { openMenu } from '../../ui/menu';
import { objectContextMenu } from './menus';
import { lastOpPanel } from '../../ui/redo';
import { editModeHooks, viewportExtensions, viewportUIHooks } from './hooks';
import { circlePaint, lassoDrag, modeFromEvent } from './selectshapes';
import { applyMatrixToObject } from '../../eval/transform';
import { altMiddle, snapViewToAxis } from './navextra';
import { placeCursor, cursorToolSettings } from '../../ops/view3d';
import { TOOL_KIND, toolDragAction } from './transformtool';

export class View3D implements Editor, ViewportRenderer, DrawView {
  el: HTMLElement;
  keymaps = ['3D View', 'Object Mode', 'Mesh', 'Curve', 'Armature', 'Font', 'Lattice', 'Metaball', 'Pose', 'Sculpt', 'Vertex Paint', 'Weight Paint', 'Image Paint', 'Frames', 'Object Non-modal', 'Window', 'Screen'];
  nav = new NavCamera();
  shading: Shading = defaultShading();
  overlay: Overlay = defaultOverlay();
  sceneCamera: Camera | null = null;
  cameraView = false;
  lockCameraToView = false;
  /** camera view framing: zoom of the camera frame (1 = fit) and offset in NDC units */
  camZoom = 1;
  /** object whose origin the view follows (View Lock to Active) */
  lockObject: string | null = null;
  /** Local Camera: this viewport looks through its own camera instead of the scene camera */
  useLocalCamera = false;
  localCamera: string | null = null;
  /** the view follows the 3D cursor (Lock to 3D Cursor) */
  lockCursor = false;
  /** offset of a locked view's centre from its lock target (panning a locked view) */
  lockOffset = new Vector3();
  private lockOffsetKey = '';
  /** Clipping Region planes (world space [nx, ny, nz, constant], inward normals) */
  clipPlanes: number[][] | null = null;
  /** the view direction cannot be changed (the fixed views of Quad View) */
  lockRotation = false;
  /** Quad View group this viewport belongs to, and its place in it */
  quad: { group: string; role: 'USER' | 'TOP' | 'FRONT' | 'RIGHT' } | null = null;
  /** Quad View: panning / zooming one fixed view moves the other fixed views too */
  quadSync = false;
  camOffset = { x: 0, y: 0 };
  localView: Set<string> | null = null;
  hiddenTypes = new Set<string>();
  unselectableTypes = new Set<string>();
  localViewSaved: ReturnType<NavCamera['serialize']> | null = null;
  idTarget = null;
  idDirty = true;
  width = 1;
  height = 1;
  extraOverlays: DrawView['extraOverlays'] = [];
  pathTracer: DrawView['pathTracer'] = null;
  showToolbar = true;
  showSidebar = false;
  showGizmos = true;
  /** gizmo of the active transform tool (Active Tools) */
  showToolGizmo = true;
  /** transform handles shown whatever tool is active (Object Gizmos) */
  objectGizmos = { translate: false, rotate: false, scale: false };
  /** gizmos of the active object's data (lights, cameras, image empties; editors/view3d/datagizmos.ts) */
  dataGizmos = { activeObject: true, light_size: true, light_look_at: true, camera_lens: true, camera_focus_distance: true, empty_image: true, empty_force_field: true };
  showNavGizmo = true;
  sidebarTab = 'Item';
  overlapHeader = true;
  showToolHeader = true;
  /** overlay svg for gizmos, box select etc */
  svg: SVGSVGElement;
  ui: HTMLElement;
  boxEl: HTMLElement;
  private infoEl: HTMLElement;
  private regionEl: HTMLElement;
  private drawnRevision = -1;
  private disposeFns: (() => void)[] = [];
  /** temporary drawing hooks (brush cursor, knife lines...) */
  overlayHooks = new Set<(svg: SVGSVGElement) => void>();

  constructor(
    public area: Area,
    state?: unknown,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'view3d';
    this.el.tabIndex = -1;
    this.regionEl = document.createElement('div');
    this.regionEl.className = 'v3d-region';
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.classList.add('v3d-svg');
    this.ui = document.createElement('div');
    this.ui.className = 'v3d-ui';
    this.boxEl = document.createElement('div');
    this.boxEl.className = 'select-box';
    this.boxEl.hidden = true;
    this.infoEl = document.createElement('div');
    this.infoEl.className = 'v3d-info';
    this.el.append(this.regionEl, this.svg, this.infoEl, this.ui, this.boxEl);
    const st = (state ?? {}) as { shading?: string | Partial<Shading>; matcap?: boolean; camera?: boolean; camZoom?: number; camOffset?: { x: number; y: number }; nav?: ReturnType<NavCamera['serialize']>; overlay?: Partial<Overlay>; toolbar?: boolean; sidebar?: boolean; clip?: number[][]; lockObject?: string; lockCursor?: boolean; localCamera?: string; lockRotation?: boolean; quad?: View3D['quad']; quadSync?: boolean; toolGizmo?: boolean; objectGizmos?: View3D['objectGizmos']; dataGizmos?: Partial<View3D['dataGizmos']> };
    if (typeof st.shading === 'string') this.shading.type = st.shading as Shading['type'];
    else if (st.shading) Object.assign(this.shading, st.shading);
    if (st.matcap) this.shading.light = 'MATCAP';
    if (st.overlay) Object.assign(this.overlay, st.overlay);
    if (st.nav) this.nav.load(st.nav);
    if (st.camera) this.cameraView = true;
    if (st.camZoom) this.camZoom = st.camZoom;
    if (st.camOffset) this.camOffset = { ...st.camOffset };
    if (st.toolbar !== undefined) this.showToolbar = st.toolbar;
    if (st.sidebar !== undefined) this.showSidebar = st.sidebar;
    if (Array.isArray(st.clip) && st.clip.length) this.clipPlanes = st.clip;
    if (st.lockObject) this.lockObject = st.lockObject;
    if (st.lockCursor) this.lockCursor = true;
    if (st.localCamera) {
      this.useLocalCamera = true;
      this.localCamera = st.localCamera;
    }
    if (st.lockRotation) this.lockRotation = true;
    if (st.quad) this.quad = { ...st.quad };
    if (st.quadSync) this.quadSync = true;
    if (st.toolGizmo === false) this.showToolGizmo = false;
    if (st.objectGizmos) Object.assign(this.objectGizmos, st.objectGizmos);
    if (st.dataGizmos) Object.assign(this.dataGizmos, st.dataGizmos);
    this.nav.lens = prefs.view_lens;
    this.nav.autoPersp = prefs.use_auto_perspective;
    this.bindInput();
    renderContext?.engine.viewports.add(this);
    this.disposeFns.push(() => renderContext?.engine.viewports.delete(this));
    editModeHooks.attach?.(this);
    for (const ext of viewportExtensions) {
      const cleanup = ext(this);
      if (cleanup) this.disposeFns.push(cleanup);
    }
  }

  // ---------------------------------------------------------------------
  // ViewportRenderer

  rect() {
    return this.el.isConnected ? this.el.getBoundingClientRect() : null;
  }

  visible() {
    return this.el.isConnected && this.area.el.style.display !== 'none';
  }

  animating() {
    return !!this.pathTracer && this.shading.type === 'RENDERED' && app.doc.scene.render.engine === 'PATHTRACE';
  }

  draw(_engine: RenderEngine, x: number, y: number, w: number, h: number) {
    if (!renderContext) return;
    // View Lock to Object: keep the locked object's origin as the view pivot
    const lockAt = this.lockTarget();
    if (lockAt) this.nav.pivot.copy(lockAt).add(this.lockOffset);
    const hadCamera = !!this.sceneCamera;
    this.updateSceneCamera();
    // the navigation gizmo follows the scene camera once camera view is first resolved
    if (!hadCamera && this.sceneCamera) this.drawUI();
    drawViewport(app, renderContext, this, x, y, w, h);
    this.drawnRevision = app.revision;
    this.drawSvg();
  }

  /** Scene camera when in camera view */
  updateSceneCamera() {
    if (!this.cameraView) {
      this.sceneCamera = null;
      return;
    }
    const camId = this.activeCameraId();
    const camOb = camId ? app.graph.get(camId) : undefined;
    const ca = camOb?.ob.data ? app.doc.cameras[camOb.ob.data] : undefined;
    if (!camOb || !ca) {
      this.sceneCamera = null;
      return;
    }
    const r = app.doc.scene.render;
    const renderAspect = (r.resolution_x * r.pixel_aspect_x) / (r.resolution_y * r.pixel_aspect_y);
    const viewAspect = this.width / this.height;
    // fit the camera frame inside the viewport with a margin (passepartout area)
    const margin = 1.1 / this.camZoom;
    let cam: PerspectiveCamera | OrthographicCamera;
    if (ca.type === 'ORTHO') {
      const o = new OrthographicCamera();
      const halfW = (ca.ortho_scale / 2) * (renderAspect >= 1 ? 1 : renderAspect);
      const halfFrameH = halfW / renderAspect;
      let hh = halfFrameH * margin;
      if (halfW * margin > hh * viewAspect) hh = (halfW * margin) / viewAspect;
      // lens shift moves the frame by a fraction of the larger frame dimension
      const sx = ca.shift_x * ca.ortho_scale,
        sy = ca.shift_y * ca.ortho_scale;
      o.top = hh + sy;
      o.bottom = -hh + sy;
      o.left = -hh * viewAspect + sx;
      o.right = hh * viewAspect + sx;
      o.near = ca.clip_start;
      o.far = ca.clip_end;
      cam = o;
    } else {
      const p = new PerspectiveCamera();
      const horizontal = ca.sensor_fit === 'HORIZONTAL' || (ca.sensor_fit === 'AUTO' && renderAspect >= 1);
      const sensor = ca.sensor_fit === 'VERTICAL' ? ca.sensor_height : ca.sensor_width;
      const halfTan = sensor / 2 / ca.lens; // along fitted axis
      const frameHalfH = horizontal ? halfTan / renderAspect : halfTan;
      const frameHalfW = frameHalfH * renderAspect;
      let tanH = frameHalfH * margin;
      if (frameHalfW * margin > tanH * viewAspect) tanH = (frameHalfW * margin) / viewAspect;
      p.fov = (2 * Math.atan(tanH) * 180) / Math.PI;
      p.aspect = viewAspect;
      p.near = ca.clip_start;
      p.far = ca.clip_end;
      p.updateProjectionMatrix();
      // lens shift
      if (ca.shift_x || ca.shift_y) {
        const s = Math.max(frameHalfW, frameHalfH) * 2;
        p.projectionMatrix.elements[8] = (ca.shift_x * s) / (tanH * viewAspect);
        p.projectionMatrix.elements[9] = (ca.shift_y * s) / tanH;
        p.projectionMatrixInverse.copy(p.projectionMatrix).invert();
      }
      cam = p;
    }
    if (cam instanceof OrthographicCamera) cam.updateProjectionMatrix();
    // camera view zoom/pan offset
    if (this.camOffset.x || this.camOffset.y) {
      const e = cam.projectionMatrix.elements;
      if (cam instanceof OrthographicCamera) {
        e[12] += this.camOffset.x;
        e[13] += this.camOffset.y;
      } else {
        e[8] -= this.camOffset.x;
        e[9] -= this.camOffset.y;
      }
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    }
    camOb.world.decompose(cam.position, cam.quaternion, new Vector3());
    cam.updateMatrixWorld(true);
    this.sceneCamera = cam;
  }

  /** Camera frame rectangle in viewport pixels (for the passepartout). */
  cameraFrame(): { x: number; y: number; w: number; h: number } | null {
    if (!this.sceneCamera) return null;
    const r = app.doc.scene.render;
    const renderAspect = (r.resolution_x * r.pixel_aspect_x) / (r.resolution_y * r.pixel_aspect_y);
    const viewAspect = this.width / this.height;
    let fw: number, fh: number;
    if (renderAspect > viewAspect) {
      fw = (this.width / 1.1) * this.camZoom;
      fh = fw / renderAspect;
    } else {
      fh = (this.height / 1.1) * this.camZoom;
      fw = fh * renderAspect;
    }
    const cx = this.width / 2 + (this.camOffset.x * this.width) / 2,
      cy = this.height / 2 - (this.camOffset.y * this.height) / 2;
    return { x: cx - fw / 2, y: cy - fh / 2, w: fw, h: fh };
  }

  /** Camera this viewport looks through: its local camera when enabled, else the scene camera. */
  activeCameraId(): string | null {
    if (this.useLocalCamera && this.localCamera && app.doc.objects[this.localCamera]?.type === 'CAMERA') return this.localCamera;
    return app.doc.scene.camera;
  }

  get camera(): Camera {
    return this.sceneCamera ?? this.nav.camera;
  }

  // ---------------------------------------------------------------------
  // Editor

  header(): Child {
    return viewHeader(this);
  }

  /** room the sidebar takes at the right edge (corner overlays keep clear of it) */
  get lookdevInset() {
    return this.showSidebar ? ((this.ui.querySelector('.v3d-sidebar') as HTMLElement | null)?.offsetWidth ?? 0) : 0;
  }

  toolHeader(): Child {
    return toolHeaderRow(this);
  }

  update(kinds: Set<ChangeKind>) {
    renderContext?.engine.requestDraw();
    this.drawUI();
    void kinds;
  }

  drawUI() {
    patch(this.ui, [
      this.showToolbar ? toolbar(this) : null,
      this.showSidebar ? sidebar(this) : null,
      this.showNavGizmo ? navGizmo(this) : null,
      lastOpPanel(this),
      ...viewportUIHooks.map((f) => f(this)),
    ]);
    this.drawInfo();
  }

  private drawInfo() {
    const doc = app.doc;
    const ob = app.activeObject;
    const nav = this.nav;
    let viewName: string;
    if (this.cameraView && this.sceneCamera) viewName = 'Camera Perspective';
    else if (nav.view !== 'USER') viewName = `${nav.view[0] + nav.view.slice(1).toLowerCase()} ${nav.ortho ? 'Orthographic' : 'Perspective'}`;
    else viewName = `User ${nav.ortho ? 'Orthographic' : 'Perspective'}`;
    if (this.localView) viewName += ' (Local)';
    const col = ob ? Object.values(doc.collections).find((c) => c.objects.includes(ob.id) && c.id !== doc.scene.collection) : undefined;
    const lines = [viewName, `(${doc.scene.frame_current}) ${col ? col.name + ' | ' : 'Scene Collection | '}${ob?.name ?? ''}${doc.mode === 'POSE' && ob?.data ? ' : ' + (doc.armatures[ob.data]?.active_bone ?? '') : ''}`];
    const kf = ob?.animation_data?.action ? doc.actions[ob.animation_data.action]?.fcurves.some((f) => f.keyframe_points.some((k) => Math.abs(k.co[0] - doc.scene.frame_current) < 0.5)) : false;
    const stats = this.overlay.show_stats ? statsLines({ selected: true }) : [];
    const fps = app.playing && prefs.show_playback_fps ? playbackFpsLabel() : '';
    patch(this.infoEl, this.overlay.show_overlays && this.overlay.show_text
      ? [fps ? h('div', { class: { 'v3d-info-line': true, 'v3d-fps': true, slow: fps.startsWith('!') } }, fps.replace(/^!/, '')) : null, prefs.show_view_name ? h('div', { class: 'v3d-info-line' }, lines[0]) : null, prefs.show_object_info ? h('div', { class: { 'v3d-info-line': true, keyed: !!kf } }, lines[1]) : null, stats.length ? h('div', { class: 'v3d-stats' }, stats.flatMap(([k, v]) => [h('span', { class: 'v3d-stat-k' }, k), h('span', { class: 'v3d-stat-v' }, v)])) : null, app.modal?.header ? null : null]
      : []);
    this.infoEl.style.left = this.showToolbar ? '52px' : '10px';
  }

  resize() {
    renderContext?.engine.requestDraw();
  }

  serialize() {
    return { nav: this.nav.serialize(), shading: { ...this.shading }, overlay: { ...this.overlay }, camera: this.cameraView, camZoom: this.camZoom, camOffset: { ...this.camOffset }, toolbar: this.showToolbar, sidebar: this.showSidebar, toolGizmo: this.showToolGizmo ? undefined : false, objectGizmos: Object.values(this.objectGizmos).some(Boolean) ? { ...this.objectGizmos } : undefined, dataGizmos: Object.values(this.dataGizmos).every(Boolean) ? undefined : { ...this.dataGizmos }, clip: this.clipPlanes ?? undefined, lockObject: this.lockObject ?? undefined, lockCursor: this.lockCursor || undefined, localCamera: this.useLocalCamera && this.localCamera ? this.localCamera : undefined, lockRotation: this.lockRotation || undefined, quad: this.quad ?? undefined, quadSync: this.quadSync || undefined };
  }

  dispose() {
    this.disposeFns.forEach((f) => f());
    editModeHooks.detach?.(this);
  }

  // ---------------------------------------------------------------------
  // SVG overlays: 3D cursor, transform gizmo, passepartout

  drawSvg() {
    const ov = this.overlay;
    const parts: Child[] = [];
    const frame = this.cameraFrame();
    if (frame && this.cameraView) {
      const camId = this.activeCameraId();
      const ca = camId ? app.doc.cameras[app.doc.objects[camId]?.data ?? ''] : undefined;
      const alpha = ca?.show_passepartout ? ca.passepartout_alpha : 0;
      const W = this.width,
        H = this.height;
      parts.push(
        h('path', {
          d: `M0 0H${W}V${H}H0Z M${frame.x} ${frame.y}V${frame.y + frame.h}H${frame.x + frame.w}V${frame.y}Z`,
          fill: `rgba(0, 0, 0,${alpha})`,
          'fill-rule': 'evenodd',
        }),
        h('rect', { x: frame.x, y: frame.y, width: frame.w, height: frame.h, fill: 'none', stroke: '#000000', 'stroke-width': 1, 'stroke-dasharray': '0', opacity: 0.8 }),
      );
    }
    if (ov.show_overlays && ov.show_cursor) {
      const c = app.doc.scene.cursor.location;
      const p = this.project(new Vector3(...c));
      if (p.z < 1)
        parts.push(
          h(
            'g',
            { class: 'cursor3d', transform: `translate(${p.x} ${p.y})` },
            h('circle', { r: 10, fill: 'none', stroke: '#ffffff', 'stroke-width': 1.5, 'stroke-dasharray': '3.93 3.93' }),
            h('circle', { r: 10, fill: 'none', stroke: '#d00d03', 'stroke-width': 1.5, 'stroke-dasharray': '3.93 3.93', 'stroke-dashoffset': 3.93 }),
            h('path', { d: 'M-18 0h6M12 0h6M0 -18v6M0 12v6', stroke: '#000000', 'stroke-width': 1.5 }),
          ),
        );
    }
    if (ov.show_overlays && this.showGizmos) parts.push(transformGizmo(this));
    for (const hook of editModeHooks.svg) {
      const r = hook(this);
      if (r) parts.push(r);
    }
    patch(this.svg, parts);
    for (const f of this.overlayHooks) f(this.svg);
  }

  // ---------------------------------------------------------------------
  // projections

  project(p: Vector3) {
    const v = p.clone().project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * this.width, y: (-v.y * 0.5 + 0.5) * this.height, z: v.z };
  }

  ray(x: number, y: number) {
    if (!this.sceneCamera) return this.nav.ray(x, y);
    const cam = this.sceneCamera;
    const ndc = new Vector3((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1, -1);
    if (cam instanceof OrthographicCamera) {
      const origin = ndc.clone().unproject(cam);
      const dir = new Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
      return { origin, dir };
    }
    const origin = cam.position.clone();
    const far = new Vector3(ndc.x, ndc.y, 0.5).unproject(cam);
    return { origin, dir: far.sub(origin).normalize() };
  }

  /** world point on the plane through `depth` facing the viewer, under pixel */
  unproject(x: number, y: number, depth: Vector3): Vector3 {
    const { origin, dir } = this.ray(x, y);
    const n = new Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const t = depth.clone().sub(origin).dot(n) / dir.dot(n);
    return origin.addScaledVector(dir, t);
  }

  local(e: { clientX: number; clientY: number }) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** Make sure the ID buffer reflects the current frame before picking. */
  ensureIds() {
    if (!renderContext) return;
    if (!this.idDirty && this.drawnRevision === app.revision && this.idTarget) return;
    renderContext.ensureSynced();
    this.updateSceneCamera();
    this.nav.resize(this.width, this.height);
    this.nav.update();
    const dpr = renderContext.engine.dpr;
    renderIdPass(app, renderContext, this, this.camera, Math.round(this.width * dpr), Math.round(this.height * dpr));
  }

  pick(x: number, y: number, radius = 6) {
    if (!renderContext) return null;
    this.ensureIds();
    return pickId(renderContext, this, x, y, radius);
  }

  idsInRect(x0: number, y0: number, x1: number, y1: number, filter?: (x: number, y: number) => boolean) {
    if (!renderContext) return new Map<string, number>();
    this.ensureIds();
    return readIds(renderContext, this, x0, y0, x1, y1, filter);
  }

  // ---------------------------------------------------------------------
  // view operations

  leaveCamera() {
    if (this.cameraView) {
      // keep the current camera framing as the starting user view
      const camId = this.activeCameraId();
    const camOb = camId ? app.graph.get(camId) : undefined;
      if (camOb) this.nav.alignToMatrix(camOb.world);
      this.cameraView = false;
      this.sceneCamera = null;
    }
  }

  frameBox(box: Box3, smooth = true) {
    if (box.isEmpty()) return;
    const c = box.getCenter(new Vector3()),
      r = box.getSize(new Vector3()).length() / 2;
    this.leaveCamera();
    if (smooth) this.animateTo(c, Math.max(r, 0.05));
    else this.nav.frame(c, Math.max(r, 0.05));
    app.changed('view');
  }

  private anim = 0;
  animateTo(center: Vector3, radius: number) {
    const fromP = this.nav.pivot.clone(),
      fromD = this.nav.distance;
    const tmp = new NavCamera();
    tmp.rot.copy(this.nav.rot);
    tmp.resize(this.width, this.height);
    tmp.lens = this.nav.lens;
    tmp.frame(center, radius);
    const toP = tmp.pivot.clone(),
      toD = tmp.distance;
    const t0 = performance.now();
    cancelAnimationFrame(this.anim);
    // Preferences ▸ Navigation ▸ Smooth View (0 or Reduce Motion: jump)
    const ms = prefs.use_reduce_motion ? 0 : prefs.smooth_view;
    const step = () => {
      const t = ms > 0 ? Math.min(1, (performance.now() - t0) / ms) : 1;
      const e = t * t * (3 - 2 * t);
      this.nav.pivot.lerpVectors(fromP, toP, e);
      this.nav.distance = fromD + (toD - fromD) * e;
      renderContext?.engine.requestDraw();
      this.drawSvg();
      if (t < 1) this.anim = requestAnimationFrame(step);
    };
    step();
  }

  // ---------------------------------------------------------------------
  // input

  private bindInput() {
    const el = this.el;
    el.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    el.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('.v3d-ui')) return;
    });
    el.addEventListener('pointermove', (e) => {
      if (app.modal) return;
      for (const hk of editModeHooks.hover) hk(this, e);
    });
  }

  private onWheel(e: WheelEvent) {
    if ((e.target as HTMLElement).closest('.v3d-sidebar, .v3d-toolbar, .redo-panel')) return;
    e.preventDefault();
    if (app.modal) {
      app.modal.onWheel?.(e);
      return;
    }
    for (const hk of editModeHooks.wheel) if (hk(this, e)) return;
    const p = this.local(e);
    // pinch zoom (trackpad) reports ctrlKey
    const isTrackpad = !e.ctrlKey && (e.deltaMode === 0 && (Math.abs(e.deltaX) > 0 || (Math.abs(e.deltaY) < 50 && !Number.isInteger(e.deltaY))));
    // in camera view, zoom/pan move the camera frame; orbiting leaves the camera
    if (this.cameraView && !this.lockCameraToView && !(isTrackpad && prefs.trackpad_orbit && !e.shiftKey && !e.altKey)) {
      if (isTrackpad && e.shiftKey) this.panCameraFrame(-e.deltaX, -e.deltaY);
      else if (e.ctrlKey && !e.metaKey) this.zoomCameraFrame(Math.exp(-e.deltaY * 0.01));
      else if (isTrackpad && e.altKey) this.zoomCameraFrame(Math.exp(-e.deltaY * 0.005));
      else {
        const dir = (e.deltaY > 0 ? 1 : -1) * (prefs.invert_zoom_wheel ? -1 : 1);
        if (e.shiftKey) this.panCameraFrame(0, -dir * 30);
        else this.zoomCameraFrame(dir > 0 ? 1 / 1.2 : 1.2);
      }
      return;
    }
    this.leaveCameraIfNeeded();
    if (e.ctrlKey && !e.metaKey) {
      const f = Math.exp(e.deltaY * 0.01);
      this.zoomBy(f, p);
    } else if (isTrackpad && prefs.trackpad_orbit) {
      if (e.shiftKey) this.nav.pan(-e.deltaX, -e.deltaY);
      else if (e.altKey) this.zoomBy(Math.exp(e.deltaY * 0.005), p);
      else if (this.lockRotation) this.nav.pan(-e.deltaX, -e.deltaY);
      else {
        const s = 0.005 * orbitScale() * (prefs.touchpad_scroll_direction === 'NATURAL' ? -1 : 1);
        this.nav.orbit(e.deltaX * s, e.deltaY * s);
      }
    } else {
      const dir = (e.deltaY > 0 ? 1 : -1) * (prefs.invert_zoom_wheel ? -1 : 1);
      if (e.shiftKey) this.nav.pan(0, -dir * 30);
      else if (e.ctrlKey) this.nav.pan(dir * 30, 0);
      else this.zoomBy(dir > 0 ? 1.2 : 1 / 1.2, p);
    }
    this.afterNav();
  }

  /** Zoom the camera frame in camera view (factor > 1 enlarges it). */
  zoomCameraFrame(f: number) {
    const z = Math.max(0.05, Math.min(40, this.camZoom * f));
    const k = z / this.camZoom;
    this.camZoom = z;
    this.camOffset.x *= k;
    this.camOffset.y *= k;
    this.updateSceneCamera();
    this.afterNav();
  }

  panCameraFrame(dxPx: number, dyPx: number) {
    this.camOffset.x += (dxPx * 2) / this.width;
    this.camOffset.y -= (dyPx * 2) / this.height;
    this.updateSceneCamera();
    this.afterNav();
  }

  resetCameraFrame() {
    this.camZoom = 1;
    this.camOffset = { x: 0, y: 0 };
    this.updateSceneCamera();
  }

  zoomBy(f: number, p: { x: number; y: number }) {
    if (prefs.use_zoom_to_mouse) this.nav.zoomAt(f, (p.x / this.width) * 2 - 1, -(p.y / this.height) * 2 + 1);
    else this.nav.zoom(f);
  }

  private leaveCameraIfNeeded() {
    if (!this.cameraView) return;
    if (!this.lockCameraToView) this.leaveCamera();
    else {
      const camId = this.activeCameraId();
    const camOb = camId ? app.graph.get(camId) : undefined;
      if (camOb) {
        const dist = this.nav.distance;
        this.nav.alignToMatrix(camOb.world);
        this.nav.distance = dist;
      }
    }
  }

  /** Where a locked view is centred (View Lock to object / 3D cursor), or null. */
  lockTarget(): Vector3 | null {
    if (this.cameraView) return null;
    // a new lock target starts centred
    const key = this.lockObject ?? (this.lockCursor ? '\u0000cursor' : '');
    if (key !== this.lockOffsetKey) {
      this.lockOffsetKey = key;
      this.lockOffset.set(0, 0, 0);
    }
    if (this.lockObject) {
      const ev = app.graph.get(this.lockObject);
      if (ev) return new Vector3().setFromMatrixPosition(ev.world);
      this.lockObject = null;
      return null;
    }
    return this.lockCursor ? new Vector3().fromArray(app.doc.scene.cursor.location) : null;
  }

  afterNav() {
    // panning a locked view keeps an offset from the lock target (View Lock Center clears it)
    const lockAt = this.lockTarget();
    if (lockAt) this.lockOffset.copy(this.nav.pivot).sub(lockAt);
    if (this.cameraView && this.lockCameraToView) this.applyViewToCamera();
    if (this.quad && this.quadSync && this.quad.role !== 'USER') this.syncQuad();
    renderContext?.engine.requestDraw();
    this.drawSvg();
    this.drawUI();
  }

  /** Quad View sync: the other fixed views share this view's center and zoom. */
  private syncQuad() {
    for (const a of this.area.screen.areas) {
      const o = a.editor as unknown as View3D;
      if (o === this || !(o instanceof View3D) || o.quad?.group !== this.quad!.group || o.quad.role === 'USER') continue;
      o.nav.pivot.copy(this.nav.pivot);
      o.nav.distance = this.nav.distance;
      o.drawSvg();
    }
    renderContext?.engine.requestDraw();
  }

  /** Lock Camera to View: write navigation back to the scene camera. */
  applyViewToCamera() {
    const camId = this.activeCameraId();
    const ob = camId ? app.doc.objects[camId] : undefined;
    if (!ob) return;
    this.nav.update();
    const world = new Matrix4().compose(this.nav.eye, this.nav.rot, new Vector3(1, 1, 1));
    // Camera Parent Lock: the camera's parent moves instead, carrying the camera along
    const pob = ob.parent ? app.doc.objects[ob.parent] : undefined;
    const camEv = app.graph.get(ob.id);
    if ((ob as { use_camera_lock_parent?: boolean }).use_camera_lock_parent && pob && camEv && app.graph.get(pob.id)) {
      const camWorld = camEv.world.clone();
      const sc = new Vector3().setFromMatrixScale(camWorld);
      const want = world.clone().scale(sc);
      const delta = want.multiply(camWorld.invert());
      const pw = delta.multiply(app.graph.get(pob.id)!.world);
      const gp = pob.parent ? app.graph.get(pob.parent) : undefined;
      applyMatrixToObject(pob, gp ? gp.world.clone().multiply(new Matrix4().fromArray(pob.matrix_parent_inverse)).invert().multiply(pw) : pw);
      app.changed('doc');
      clearTimeout(this.lockTimer);
      this.lockTimer = window.setTimeout(() => app.pushUndo('Camera Lock to View'), 400);
      return;
    }
    const parent = ob.parent ? app.graph.get(ob.parent) : undefined;
    const local = parent ? parent.world.clone().multiply(new Matrix4().fromArray(ob.matrix_parent_inverse)).invert().multiply(world) : world;
    applyMatrixToObject(ob, local);
    app.changed('doc');
    clearTimeout(this.lockTimer);
    this.lockTimer = window.setTimeout(() => app.pushUndo('Camera Lock to View'), 400);
  }
  private lockTimer = 0;

  private onPointerDown(e: PointerEvent) {
    const t = e.target as HTMLElement;
    if (t.closest('.v3d-ui')) return;
    this.el.focus({ preventScroll: true });
    if (app.modal) {
      const r = app.modal.onPointerDown?.(e);
      if (r) app.endModal(r);
      e.preventDefault();
      return;
    }
    const p = this.local(e);
    const emulate3 = prefs.emulate_3_button_mouse && emulateModifier(e) && e.button === 0;
    if (e.button === 3) {
      // the "back" mouse button frames the selection
      e.preventDefault();
      app.run('view3d.view_selected');
      return;
    }
    if (e.button === 1 && e.altKey && !emulate3) {
      // Alt+MMB: click centers the view on the surface, drag snaps to the axis view in that direction
      e.preventDefault();
      altMiddle(this, e);
      return;
    }
    if (e.button === 1 || emulate3) {
      e.preventDefault();
      this.navDrag(e, e.shiftKey && e.ctrlKey ? 'dolly' : e.shiftKey ? 'pan' : e.ctrlKey ? 'zoom' : 'orbit');
      return;
    }
    if (e.button === 2 && e.ctrlKey && !app.modal) {
      e.preventDefault();
      const s = { x: e.clientX, y: e.clientY };
      const mv = (ev: PointerEvent) => {
        if (Math.hypot(ev.clientX - s.x, ev.clientY - s.y) <= prefs.drag_threshold_mouse) return;
        cleanup();
        lassoDrag(this, e, e.shiftKey ? 'SUB' : 'ADD');
      };
      const upFn = () => {
        cleanup();
        for (const hk of editModeHooks.context) if (hk(this, e)) return;
        if (app.doc.mode === 'EDIT' && app.activeObject?.type === 'MESH') app.run('mesh.dupli_extrude_cursor', {}, { event: { x: e.clientX, y: e.clientY } });
        else if (app.doc.mode === 'EDIT' && app.activeObject?.type === 'ARMATURE') app.run('armature.click_extrude', {}, { event: { x: e.clientX, y: e.clientY } });
      };
      const cleanup = () => {
        removeEventListener('pointermove', mv);
        removeEventListener('pointerup', upFn);
      };
      addEventListener('pointermove', mv);
      addEventListener('pointerup', upFn);
      return;
    }
    if (e.button === 2) {
      e.preventDefault();
      if (e.shiftKey) {
        // place the 3D cursor
        app.run('view3d.cursor3d', { ...cursorToolSettings }, { event: { x: e.clientX, y: e.clientY } });
        return;
      }
      for (const hk of editModeHooks.context) if (hk(this, e)) return;
      openMenu(objectContextMenu(), { x: e.clientX, y: e.clientY }, { title: app.doc.mode === 'EDIT' ? undefined : 'Object' });
      return;
    }
    if (e.button !== 0) return;
    // gizmo handles first
    if (gizmoPointerDown(this, e)) return;
    // mode-specific (sculpt strokes, paint, edit tools)
    for (const hk of editModeHooks.pointer) if (hk(this, e)) return;
    const tool = activeTools[app.doc.mode] ?? 'builtin.select_box';
    if (tool === 'builtin.cursor') {
      // click places the cursor, dragging moves it along the surfaces under the mouse
      placeCursor(this, p.x, p.y);
      const mv = (ev: PointerEvent) => {
        const q = this.local(ev);
        placeCursor(this, q.x, q.y);
      };
      const upFn = () => {
        removeEventListener('pointermove', mv);
        removeEventListener('pointerup', upFn);
        app.pushUndo('Set 3D Cursor');
      };
      addEventListener('pointermove', mv);
      addEventListener('pointerup', upFn);
      return;
    }
    // the transform tools' Drag setting: what dragging away from the gizmo does
    const drag = TOOL_KIND[tool] ? toolDragAction(tool) : null;
    if (tool === 'builtin.select_circle' || drag === 'SELECT_CIRCLE') {
      circlePaint(this, e, modeFromEvent(e));
      return;
    }
    // click-or-drag: tweak/box select
    const start = { ...p };
    let dragging = false;
    const move = (ev: PointerEvent) => {
      const q = this.local(ev);
      if (!dragging && Math.hypot(q.x - start.x, q.y - start.y) > prefs.drag_threshold_mouse) {
        dragging = true;
        if (tool === 'builtin.select_lasso' || drag === 'SELECT_LASSO') {
          removeEventListener('pointermove', move);
          removeEventListener('pointerup', up);
          lassoDrag(this, e, modeFromEvent(ev));
          return;
        }
        if (tool === 'builtin.select' || drag === 'TWEAK') {
          // tweak: select under cursor then move
          removeEventListener('pointermove', move);
          removeEventListener('pointerup', up);
          // dragging an object that is already selected moves the whole selection
          const under = app.doc.mode === 'OBJECT' ? this.pick(start.x, start.y, 8)?.id : null;
          if (!(under && app.doc.objects[under]?.select)) selectPick(this, start.x, start.y, { extend: false, deselectAll: true, toggle: false });
          // Preferences ▸ Input ▸ Release Confirms: letting go of the button ends the move
          app.run('transform.translate', { release_confirm: prefs.use_drag_immediately }, { event: { x: ev.clientX, y: ev.clientY } });
          return;
        }
      }
      if (dragging) this.showBox(start.x, start.y, q.x, q.y, 'box');
    };
    const up = (ev: PointerEvent) => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      const q = this.local(ev);
      this.boxEl.hidden = true;
      const mode = modeFromEvent(ev);
      if (dragging) selectObjects(this, start.x, start.y, q.x, q.y, mode as 'SET');
      else selectPick(this, q.x, q.y, { extend: ev.shiftKey, deselectAll: !ev.shiftKey, toggle: ev.shiftKey, deselect: ev.ctrlKey && !ev.shiftKey, cycle: ev.altKey });
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  showBox(x0: number, y0: number, x1: number, y1: number, kind: 'box' | 'circle' = 'box') {
    this.boxEl.hidden = false;
    this.boxEl.className = `select-box ${kind}`;
    Object.assign(this.boxEl.style, { left: `${Math.min(x0, x1)}px`, top: `${Math.min(y0, y1)}px`, width: `${Math.abs(x1 - x0)}px`, height: `${Math.abs(y1 - y0)}px` });
  }

  navDrag(e: PointerEvent, kind: 'orbit' | 'pan' | 'zoom' | 'dolly') {
    const start = this.local(e);
    let last = { x: e.clientX, y: e.clientY };
    // in camera view, panning and zooming move the camera frame instead of leaving the camera
    if (this.cameraView && !this.lockCameraToView && (kind === 'pan' || kind === 'zoom' || (kind === 'orbit' && (e.shiftKey || e.ctrlKey)))) {
      const zoom = kind === 'zoom' || (kind === 'orbit' && e.ctrlKey && !e.shiftKey);
      const mv = (ev: PointerEvent) => {
        const dx = ev.clientX - last.x,
          dy = ev.clientY - last.y;
        last = { x: ev.clientX, y: ev.clientY };
        if (zoom) this.zoomCameraFrame(Math.exp(-dy * 0.01));
        else this.panCameraFrame(dx, dy);
      };
      const upFn = () => {
        removeEventListener('pointermove', mv);
        removeEventListener('pointerup', upFn);
      };
      addEventListener('pointermove', mv);
      addEventListener('pointerup', upFn);
      return;
    }
    this.leaveCameraIfNeeded();
    // orbit around selection (preference)
    let around: Vector3 | null = null;
    if (prefs.use_rotate_around_active && kind === 'orbit') around = selectionCenter();
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    // free rotation while Alt snaps the displayed view to the nearest axis view
    let freeRot: Quaternion | null = null;
    // the right button cancels the navigation: the view goes back to where the drag started
    const startState = { pivot: this.nav.pivot.clone(), rot: this.nav.rot.clone(), distance: this.nav.distance, view: this.nav.view, ortho: this.nav.ortho };
    // (a second button pressed during a drag arrives as a pointer move with the button set)
    const cancel = (ev: PointerEvent) => {
      if (ev.button !== 2 || !(ev.buttons & 2)) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.nav.pivot.copy(startState.pivot);
      this.nav.rot.copy(startState.rot);
      this.nav.distance = startState.distance;
      this.nav.view = startState.view;
      this.nav.ortho = startState.ortho;
      up();
      this.afterNav();
    };
    addEventListener('pointerdown', cancel, true);
    addEventListener('pointermove', cancel, true);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - last.x,
        dy = ev.clientY - last.y;
      last = { x: ev.clientX, y: ev.clientY };
      if (kind === 'orbit' && !ev.shiftKey && !ev.ctrlKey && this.lockRotation) this.nav.pan(dx, dy);
      else if (kind === 'orbit' && !ev.shiftKey && !ev.ctrlKey) {
        const s = 0.0075 * orbitScale();
        if (freeRot) this.nav.rot.copy(freeRot);
        if (around) this.nav.orbitAround(around, dx * s, dy * s);
        else this.nav.orbit(dx * s, dy * s);
        const snap = ev.altKey && !(prefs.emulate_3_button_mouse && emulateModifier(ev) && (ev.buttons & 1));
        freeRot = snap ? this.nav.rot.clone() : null;
        if (snap) snapViewToAxis(this, this.nav.rot);
      } else if (kind === 'dolly') this.nav.pivot.addScaledVector(this.nav.forward, -dy * this.nav.distance * 0.005);
      else if (kind === 'pan' || (kind === 'orbit' && ev.shiftKey)) this.nav.pan(dx, dy);
      else {
        // Preferences ▸ Navigation ▸ Zoom: drag axis and direction
        const d = (prefs.view_zoom_axis === 'HORIZONTAL' ? -dx : dy) * (prefs.invert_mouse_zoom ? -1 : 1);
        this.zoomBy(Math.exp(d * 0.01), start);
      }
      this.afterNav();
    };
    const up = () => {
      this.el.removeEventListener('pointermove', move);
      this.el.removeEventListener('pointerup', up);
      this.el.removeEventListener('pointercancel', up);
      removeEventListener('pointerdown', cancel, true);
      removeEventListener('pointermove', cancel, true);
    };
    this.el.addEventListener('pointermove', move);
    this.el.addEventListener('pointerup', up);
    this.el.addEventListener('pointercancel', up);
  }

  onKey(e: KeyboardEvent): boolean {
    void e;
    return false;
  }
}

/** Median of selected object origins (or edit selection via hooks). */
export function selectionCenter(): Vector3 | null {
  const sel = app.selectedObjects();
  if (!sel.length) return null;
  const c = new Vector3();
  for (const ob of sel) c.add(new Vector3().setFromMatrixPosition(app.graph.get(ob.id)!.world));
  return c.multiplyScalar(1 / sel.length);
}

/** Unique edge count of a polygon mesh, cached per index array (arrays are replaced, never mutated, after edits). */
const edgeCountCache = new WeakMap<object, number>();
function edgeCount(offsets: ArrayLike<number>, indices: ArrayLike<number> & object): number {
  const hit = edgeCountCache.get(indices);
  if (hit !== undefined) return hit;
  const seen = new Set<number>();
  const n = offsets.length - 1;
  for (let f = 0; f < n; f++) {
    const a0 = offsets[f],
      a1 = offsets[f + 1];
    for (let c = a0; c < a1; c++) {
      const u = indices[c],
        v = indices[c + 1 < a1 ? c + 1 : a0];
      seen.add(u < v ? u * 0x200000 + v : v * 0x200000 + u);
    }
  }
  edgeCountCache.set(indices, seen.size);
  return seen.size;
}

/** Edit Mode counts of one mesh (vertices, selected, edges, selected, faces, selected, triangles), cached until its arrays change. */
const editStatsCache = new WeakMap<object, { refs: unknown[]; out: number[] }>();
function editStats(me: { positions: ArrayLike<number>; offsets: ArrayLike<number>; indices: ArrayLike<number>; select_vert?: Uint8Array }): number[] {
  const refs = [me.positions, me.offsets, me.indices, me.select_vert];
  const hit = editStatsCache.get(me);
  if (hit && hit.refs.every((r, i) => r === refs[i])) return hit.out;
  const sel = me.select_vert;
  const nf = me.offsets.length - 1;
  let vs = 0,
    e = 0,
    es = 0,
    fs = 0,
    tris = 0;
  if (sel) for (let i = 0; i < sel.length; i++) if (sel[i]) vs++;
  const seen = new Set<number>();
  for (let fi = 0; fi < nf; fi++) {
    const a0 = me.offsets[fi],
      a1 = me.offsets[fi + 1];
    tris += a1 - a0 - 2;
    let all = !!sel;
    for (let c = a0; c < a1; c++) {
      const a = me.indices[c],
        b = me.indices[c + 1 < a1 ? c + 1 : a0];
      if (sel && !sel[a]) all = false;
      const k = a < b ? a * 0x200000 + b : b * 0x200000 + a;
      if (!seen.has(k)) {
        seen.add(k);
        e++;
        if (sel && sel[a] && sel[b]) es++;
      }
    }
    if (all) fs++;
  }
  const out = [me.positions.length / 3, vs, e, es, nf, fs, tris];
  editStatsCache.set(me, { refs, out });
  return out;
}

/** Statistics overlay rows for the current mode: [label, value] (also shown in the status bar). */
export function statsLines(opts: { selected?: boolean } = {}): [string, string][] {
  const doc = app.doc;
  const fmt = (n: number) => n.toLocaleString();
  const mode = doc.mode;
  const active = app.activeObject;
  // sculpt and paint modes describe the active mesh only
  if (mode === 'SCULPT' || mode === 'VERTEX_PAINT' || mode === 'WEIGHT_PAINT' || mode === 'TEXTURE_PAINT') {
    const me = active ? app.graph.get(active.id)?.mesh : undefined;
    return me ? [['Vertices', fmt(me.positions.length / 3)], ['Faces', fmt(me.offsets.length - 1)]] : [];
  }
  if (mode === 'EDIT' && active?.type === 'MESH') {
    let v = 0,
      vs = 0,
      e = 0,
      es = 0,
      f = 0,
      fs = 0,
      tris = 0;
    for (const ob of app.selectedObjects().filter((o) => o.type === 'MESH' && o.data)) {
      const me = doc.meshes[ob.data!];
      if (!me) continue;
      const st = editStats(me);
      v += st[0];
      vs += st[1];
      e += st[2];
      es += st[3];
      f += st[4];
      fs += st[5];
      tris += st[6];
    }
    return [
      ['Objects', `${app.selectedObjects().length} / ${[...app.graph.objects.values()].filter((x) => x.visible).length}`],
      ['Vertices', `${fmt(vs)} / ${fmt(v)}`],
      ['Edges', `${fmt(es)} / ${fmt(e)}`],
      ['Faces', `${fmt(fs)} / ${fmt(f)}`],
      ['Triangles', fmt(tris)],
    ];
  }
  // Object Mode: geometry of the selected objects / of everything visible
  let objects = 0,
    sel = 0;
  const all = [0, 0, 0, 0],
    chosen = [0, 0, 0, 0];
  for (const ev of app.graph.objects.values()) {
    if (!ev.visible) continue;
    objects++;
    if (ev.ob.select) sel++;
    if (ev.mesh) {
      let tris = 0;
      for (let f = 0; f < ev.mesh.offsets.length - 1; f++) tris += ev.mesh.offsets[f + 1] - ev.mesh.offsets[f] - 2;
      const c = [ev.mesh.positions.length / 3, edgeCount(ev.mesh.offsets, ev.mesh.indices as ArrayLike<number> & object), ev.mesh.offsets.length - 1, tris];
      for (let i = 0; i < 4; i++) {
        all[i] += c[i];
        if (ev.ob.select) chosen[i] += c[i];
      }
    }
  }
  // the viewport overlay shows "selected / total", the status bar the totals
  const pair = (i: number) => (opts.selected ? `${fmt(chosen[i])} / ${fmt(all[i])}` : fmt(all[i]));
  return [
    ['Objects', `${sel} / ${objects}`],
    ['Vertices', pair(0)],
    ['Edges', pair(1)],
    ['Faces', pair(2)],
    ['Triangles', pair(3)],
  ];
}

/** Orbit speed relative to the default 0.43° per pixel (Preferences ▸ Navigation). */
function orbitScale() {
  return Math.max(0.05, prefs.view_rotate_sensitivity) / 0.43;
}

/** The key that turns the left button into the middle one when emulating a 3-button mouse. */
function emulateModifier(e: { altKey: boolean; metaKey: boolean }) {
  return prefs.mouse_emulate_3_button_modifier === 'OSKEY' ? e.metaKey : e.altKey;
}

export function activeView3D(): View3D | null {
  const a = app.hoverArea ?? app.activeArea;
  if (a && (a.editor as unknown) instanceof View3D) return a.editor as View3D;
  return lastView3D;
}

export let lastView3D: View3D | null = null;
export function setLastView3D(v: View3D) {
  lastView3D = v;
}

export function worldBounds(ids: string[]): Box3 {
  const box = new Box3();
  for (const id of ids) {
    const ev = app.graph.get(id);
    if (!ev) continue;
    if (ev.mesh && ev.mesh.positions.length) {
      const P = ev.mesh.positions;
      const v = new Vector3();
      const step = Math.max(1, Math.floor(P.length / 3 / 20000));
      for (let i = 0; i < P.length / 3; i += step) box.expandByPoint(v.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]).applyMatrix4(ev.world));
    } else {
      const p = new Vector3().setFromMatrixPosition(ev.world);
      const s = ev.ob.type === 'EMPTY' ? ev.ob.empty_display_size : 1;
      box.expandByPoint(p.clone().addScalar(-s * 0.5));
      box.expandByPoint(p.clone().addScalar(s * 0.5));
    }
  }
  return box;
}

export { Matrix4, icon };
