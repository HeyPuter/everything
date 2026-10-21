// Movie Clip Editor (CLIP_EDITOR): footage view with markers (pattern/search areas, paths),
// Graph and Dope Sheet views of the tracks, header menus, toolbar (T) and sidebar (N).
import { canvasGrey, canvasTextGrey } from '../ui/canvastheme';
import { h, patch, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, type ChangeKind } from '../app/app';
import { registerEditor, type Area, type Editor } from '../ui/screen';
import { openMenu, type MenuItem } from '../ui/menu';
import { enumMenu, textField } from '../ui/widgets';
import { shortcutLabel, addKeys } from '../app/keymap';
import { View2D } from '../animation/view2d';
import {
  activeTrack,
  clipFrameToSourceIndex,
  clipTable,
  cloneMarker,
  enabledMarkerAt,
  insertMarker,
  markerAt,
  markerExact,
  sceneToClipFrame,
  clipToSceneFrame,
  tobj,
  normalizeTracking,
  type MovieClipData,
  type MovieTrackingMarker,
  type MovieTrackingTrack,
} from './types';
import { readySource } from './source';
import { stabilizationMatrix, autoscaleFactor, type Affine2 } from './stabilize';
import { drawToolbar, drawSidebar, drawPatternPreviews } from './panels';
import { solveErrorText } from './solvepanels';
import { reprojectBundle, clipIntrinsics, undistortPixelWith, distortPixelWith } from './reconstruction';
import { hasDistortion, type Intrinsics } from './solve/intrinsics';
import { proxySource, type ProxyRenderSize } from './proxy';
import { drawPlaneTracks, planeCornerDown, planeBodyDown } from './planeops';
import { drawGraph, drawDopesheet, graphPointer, dopesheetPointer, frameGraphAll, frameDopesheetAll } from './graphs';
import { jobState } from './jobs';
import { lastOpPanel } from '../ui/redo';
import { drawMask, drawMaskMatte, drawSelectShape, maskPointerDown, hostMask, type MaskHost, type MaskDisplayType } from '../mask/clipmask';
import { clipLasso } from './graphops';
import { maskSelectMenu, maskAddMenu, maskMenu, maskBrowse, maskToolbar, maskSidebar, maskProportionalHeader } from '../mask/maskui';
import { maskTable } from '../mask/types';
import { navGizmo2D } from '../render/final/navgizmo2d';
import { annotatePointerDown, annotateKeyHeld, annotateModeOf, drawAnnotations2D, type AnnotateTool, type Annotation2DOwner } from '../mask/annotate2d';

export type ClipView = 'CLIP' | 'GRAPH' | 'DOPESHEET';

export interface ClipOverlays {
  show_marker_pattern: boolean;
  show_marker_search: boolean;
  show_track_path: boolean;
  path_length: number;
  show_disabled: boolean;
  show_names: boolean;
  show_info: boolean;
  show_stable: boolean;
  use_mute_footage: boolean;
  show_cache: boolean;
  /** reprojected bundles of the camera solve ("3D markers") */
  show_bundles?: boolean;
  /** show the footage (and markers) with the lens distortion removed */
  render_undistorted?: boolean;
  /** grid of straight lines showing the lens distortion */
  show_grid?: boolean;
  /** mask mode: draw splines, and show the mask as a matte over (or instead of) the footage */
  show_mask_spline?: boolean;
  mask_overlay_mode?: 'NONE' | 'COMBINED' | 'ALPHACHANNEL';
  /** how splines are drawn, and how dark the outside of a Combined overlay gets */
  mask_display_type?: MaskDisplayType;
  blend_factor?: number;
  /** master switch of everything drawn over the footage (Shift Alt Z) */
  show_overlays?: boolean;
  /** footage channels shown, and a black-and-white display */
  show_red_channel?: boolean;
  show_green_channel?: boolean;
  show_blue_channel?: boolean;
  use_grayscale_preview?: boolean;
  /** markers without the dark outline */
  show_tiny_markers?: boolean;
  /** the 2D cursor */
  show_cursor?: boolean;
  /** notes drawn on the clip */
  show_annotation?: boolean;
}

export const COLORS = {
  outline: '#000000',
  marker: '#7a8102',
  active: '#ffffff',
  selected: '#f0fb18',
  disabled: '#7c0802',
  locked: '#7e7f81',
  pathBefore: '#fb1104',
  pathAfter: '#1004fa',
  pathKeyBefore: '#fec8c5',
  pathKeyAfter: '#c9c6fe',
};

type Handle = { track: MovieTrackingTrack; kind: 'move' | 'corner' | 'search'; index: number };

let lastClipEditor: ClipEditor | null = null;
/** Most recently used clip editor (for operators invoked outside an area). */
export function currentClipEditor(): ClipEditor | null {
  const a = app.hoverArea ?? app.activeArea;
  const ed = (a as Area | null)?.editor;
  if (ed instanceof ClipEditor) return ed;
  return lastClipEditor && lastClipEditor.el.isConnected ? lastClipEditor : null;
}

export class ClipEditor implements Editor {
  el: HTMLElement;
  clipId: string | null = null;
  view: ClipView = 'CLIP';
  zoom = 1;
  offX = 0;
  offY = 0;
  fitted = false;
  showToolbar = true;
  showSidebar = true;
  toolbarTab = 'Track';
  sidebarTab = 'Track';
  lockSelection = false;
  overlays: ClipOverlays = { show_marker_pattern: true, show_marker_search: false, show_track_path: true, path_length: 20, show_disabled: true, show_names: false, show_info: false, show_stable: false, use_mute_footage: false, show_cache: true };
  /** graph / dope sheet view */
  v2 = new View2D();
  v2Fitted = false;
  graphShow = { motion: true, speed_x: true, speed_y: true, error: true, frames: true };
  dopesheetSort: 'NAME' | 'LONGEST' | 'TOTAL' | 'AVERAGE_ERROR' | 'START' | 'END' = 'NAME';
  dopesheetInvert = false;
  dopesheetScroll = 0;
  /** navigation buttons of the clip view (Ctrl `) */
  showGizmo = true;
  /** Annotation toolbar tool in use (left button draws notes instead of editing markers) */
  annotateTool: AnnotateTool | null = null;
  /** graph: only the selected tracks' curves; graph / dope sheet: also hidden tracks */
  graphOnlySelected = true;
  showHiddenTracks = false;
  /** graph / dope sheet: keep the current frame centred while it changes */
  lockTimeCursor = false;
  boxPending = false;
  /** proxy size the footage is displayed at (when the clip uses proxies) */
  proxyRenderSize: ProxyRenderSize = 'FULL';
  /** Tracking (markers) or Mask (editing masks over the footage) */
  mode: 'TRACKING' | 'MASK' = 'TRACKING';
  /** mask edited in mask mode */
  maskId: string | null = null;
  /** 2D cursor (frame space 0..1, y up): new mask shapes and the cursor pivot use it */
  cursor: [number, number] = [0.5, 0.5];
  private cursorPlaced = false;
  /** pivot of mask point rotation / scaling */
  pivot: 'MEDIAN_POINT' | 'BOUNDING_BOX_CENTER' | 'CURSOR' = 'MEDIAN_POINT';
  /** circle / lasso / box outline while selecting mask points */
  shapeOverlay: MaskHost['shapeOverlay'] = null;
  boxRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
  canvas: HTMLCanvasElement;
  ui: HTMLElement;
  private autoscaleCache: { key: string; value: number } | null = null;
  private loading = new Set<number>();
  private ro: ResizeObserver;

  constructor(
    public area: Area,
    state?: unknown,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'clip-root';
    this.el.tabIndex = -1;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'clip-canvas';
    this.ui = document.createElement('div');
    this.ui.className = 'clip-ui';
    this.el.append(this.canvas, this.ui);
    const st = (state ?? {}) as Partial<{ clip: string | null; view: ClipView; zoom: number; off: [number, number]; toolbar: boolean; sidebar: boolean; sidebarTab: string; overlays: Partial<ClipOverlays>; lock: boolean; mode: 'TRACKING' | 'MASK'; mask: string | null }>;
    if (st.view) this.view = st.view;
    if (st.clip !== undefined) this.clipId = st.clip;
    if (st.zoom) {
      this.zoom = st.zoom;
      this.fitted = true;
    }
    if (st.off) [this.offX, this.offY] = st.off;
    if (st.toolbar !== undefined) this.showToolbar = st.toolbar;
    if (st.sidebar !== undefined) this.showSidebar = st.sidebar;
    else if (this.view !== 'CLIP') this.showSidebar = false;
    if (this.view !== 'CLIP' && st.toolbar === undefined) this.showToolbar = false;
    if (st.sidebarTab) this.sidebarTab = st.sidebarTab;
    if (st.overlays) Object.assign(this.overlays, st.overlays);
    if (st.lock) this.lockSelection = st.lock;
    if (st.mode === 'MASK') this.mode = 'MASK';
    if (st.mask !== undefined) this.maskId = st.mask;
    const ext = state as { cursor?: [number, number]; pivot?: 'MEDIAN_POINT'; lockTime?: boolean; onlySelected?: boolean; showHidden?: boolean } | undefined;
    if (ext?.onlySelected === false) this.graphOnlySelected = false;
    if (ext?.showHidden) this.showHiddenTracks = true;
    if (ext?.lockTime) this.lockTimeCursor = true;
    if (ext?.cursor) this.cursor = ext.cursor;
    if (ext?.pivot) this.pivot = ext.pivot;
    const px = (state as { proxy?: ProxyRenderSize } | undefined)?.proxy;
    if (px) this.proxyRenderSize = px;
    if (!this.clipId) this.clipId = app.doc.scene.active_clip ?? Object.keys(clipTable(app.doc))[0] ?? null;
    this.bind();
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.el);
    lastClipEditor = this;
  }

  get keymaps() {
    if (this.view === 'CLIP' && this.mode === 'MASK') return ['Mask Editing', 'Clip Mask View', 'Clip'];
    return this.view === 'GRAPH' ? ['Clip Graph Editor', 'Clip'] : this.view === 'DOPESHEET' ? ['Clip Dopesheet Editor', 'Clip'] : ['Clip Editor', 'Clip'];
  }

  // ---------------------------------------------------------------------------
  // data

  get clip(): MovieClipData | null {
    const c = (this.clipId && clipTable(app.doc)[this.clipId]) || null;
    // clips from older files get the camera-solve fields
    if (c && !c.tracking.reconstruction) normalizeTracking(c.tracking);
    return c;
  }

  setClip(id: string | null) {
    this.clipId = id;
    this.fitted = false;
    this.v2Fitted = false;
    // a clip shown in an editor becomes the scene's active clip if none is set
    if (id && !app.doc.scene.active_clip) app.doc.scene.active_clip = id;
    lastClipEditor = this;
    this.redrawAll();
    app.changed('ui');
  }

  get clipFrame(): number {
    const c = this.clip;
    return c ? sceneToClipFrame(c, app.doc.scene.frame_current) : 1;
  }

  /** Visible tracks (not hidden). */
  tracks(): MovieTrackingTrack[] {
    const c = this.clip;
    return c ? tobj(c).tracks.filter((t) => !t.hide) : [];
  }

  // ---------------------------------------------------------------------------
  // view transforms (footage pixels: origin top-left, y down)

  /** Size of the shown frame: the clip's, or the render size when editing a mask without footage. */
  frameSize(): [number, number] {
    const c = this.clip;
    if (c?.size[0]) return [c.size[0], c.size[1]];
    const r = app.doc.scene.render;
    return [Math.max(1, r.resolution_x), Math.max(1, r.resolution_y)];
  }

  viewSize() {
    return { w: Math.max(1, this.el.clientWidth), h: Math.max(1, this.el.clientHeight) };
  }

  /** stabilization (bottom-left pixel space) for display, or null */
  stab(): Affine2 | null {
    const c = this.clip;
    if (!c || !this.overlays.show_stable || !c.tracking.stabilization.use_2d_stabilization || !c.size[0]) return null;
    let z = 1;
    if (c.tracking.stabilization.use_autoscale) {
      const key = JSON.stringify([c.tracking.stabilization, c.tracking.tracks.map((t) => [t.use_2d_stabilization, t.use_2d_stabilization_rotation, t.weight_stab, t.markers.length, t.markers[t.markers.length - 1]?.co])]);
      if (this.autoscaleCache?.key !== key) this.autoscaleCache = { key, value: autoscaleFactor(c) };
      z = this.autoscaleCache.value;
    }
    return stabilizationMatrix(c, this.clipFrame, z);
  }

  /** Lens model when the footage is shown undistorted (Render Undistorted), else null. */
  undistortLens(): Intrinsics | null {
    const c = this.clip;
    if (!c || !this.overlays.render_undistorted || !c.size[0] || this.mode === 'MASK') return null;
    const I = clipIntrinsics(c);
    return hasDistortion(I) ? I : null;
  }

  /** footage pixel → screen (editor-local CSS px); shown undistorted when Render Undistorted is on */
  toScreen(x: number, y: number, T: Affine2 | null = this.stab()): [number, number] {
    const L = this.undistortLens();
    if (L) {
      const H = this.frameSize()[1];
      const u = undistortPixelWith(L, x, H - y);
      return this.viewScreen(u[0], H - u[1], T);
    }
    return this.viewScreen(x, y, T);
  }

  /** displayed (possibly undistorted) footage pixel → screen */
  viewScreen(x: number, y: number, T: Affine2 | null = this.stab()): [number, number] {
    const [W, H] = this.frameSize();
    if (T) {
      const by = H - y;
      const nx = T[0] * x + T[2] * by + T[4],
        ny = T[1] * x + T[3] * by + T[5];
      x = nx;
      y = H - ny;
    }
    const { w, h: hh } = this.viewSize();
    return [w / 2 + (x - W / 2 + this.offX) * this.zoom, hh / 2 + (y - H / 2 + this.offY) * this.zoom];
  }

  toImage(sx: number, sy: number, T: Affine2 | null = this.stab()): [number, number] {
    const [W, H] = this.frameSize();
    const { w, h: hh } = this.viewSize();
    let x = (sx - w / 2) / this.zoom + W / 2 - this.offX,
      y = (sy - hh / 2) / this.zoom + H / 2 - this.offY;
    if (T) {
      const det = T[0] * T[3] - T[1] * T[2];
      const bx = x - T[4],
        by = H - y - T[5];
      x = (T[3] * bx - T[2] * by) / det;
      y = H - (-T[1] * bx + T[0] * by) / det;
    }
    const L = this.undistortLens();
    if (L) {
      const d = distortPixelWith(L, x, H - y);
      return [d[0], H - d[1]];
    }
    return [x, y];
  }

  /** marker → footage pixel data */
  markerGeom(m: MovieTrackingMarker) {
    const c = this.clip!;
    const [W, H] = c.size;
    const x = m.co[0] * W,
      y = (1 - m.co[1]) * H;
    return {
      x,
      y,
      corners: m.pattern_corners.map((p) => [x + p[0] * W, y - p[1] * H] as [number, number]),
      search: [
        [x + m.search_min[0] * W, y - m.search_min[1] * H],
        [x + m.search_max[0] * W, y - m.search_min[1] * H],
        [x + m.search_max[0] * W, y - m.search_max[1] * H],
        [x + m.search_min[0] * W, y - m.search_max[1] * H],
      ] as [number, number][],
    };
  }

  frameAll(fit = false) {
    const c = this.clip;
    if ((!c || !c.size[0]) && this.mode !== 'MASK') return;
    const [FW, FH] = this.frameSize();
    const { w, h: hh } = this.viewSize();
    const availW = w - (this.showToolbar ? 230 : 0) - (this.showSidebar ? 290 : 0) - 20;
    const z = Math.min(Math.max(40, availW) / FW, (hh - 40) / FH);
    // "Frame All" uses the largest power-of-two zoom that fits; "Fit" fills the region
    this.zoom = fit ? z : Math.max(1 / 64, Math.min(64, Math.pow(2, Math.floor(Math.log2(z)))));
    this.offX = ((this.showSidebar ? 290 : 0) - (this.showToolbar ? 230 : 0)) / 2 / this.zoom;
    this.offY = 0;
    this.fitted = true;
    this.draw();
  }

  frameSelected() {
    const c = this.clip;
    if (!c) return;
    const pts: [number, number][] = [];
    for (const t of this.tracks())
      if (t.select) {
        const m = markerAt(t, this.clipFrame);
        if (m) pts.push(...this.markerGeom(m).corners);
      }
    if (!pts.length) return;
    const xs = pts.map((p) => p[0]),
      ys = pts.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2,
      cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const { w, h: hh } = this.viewSize();
    const sz = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 20);
    this.zoom = Math.max(1 / 64, Math.min(64, Math.min(w, hh) / (sz * 3)));
    this.offX = c.size[0] / 2 - cx;
    this.offY = c.size[1] / 2 - cy;
    this.fitted = true;
    this.draw();
  }

  zoomAt(factor: number, sx?: number, sy?: number) {
    const c = this.clip;
    if (!c) return;
    const { w, h: hh } = this.viewSize();
    const px = sx ?? w / 2,
      py = sy ?? hh / 2;
    const [ix, iy] = this.toImage(px, py, null);
    this.zoom = Math.max(1 / 64, Math.min(256, this.zoom * factor));
    this.offX = (px - w / 2) / this.zoom + c.size[0] / 2 - ix;
    this.offY = (py - hh / 2) / this.zoom + c.size[1] / 2 - iy;
    this.fitted = true;
    this.draw();
  }

  setRatio(z: number) {
    this.zoom = z;
    this.fitted = true;
    this.draw();
  }

  // ---------------------------------------------------------------------------
  // drawing

  redrawAll() {
    this.draw();
    this.drawUI();
    this.area.drawHeader();
  }

  draw() {
    const { w, h: hh } = this.viewSize();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cv = this.canvas;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hh * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(hh * dpr);
      cv.style.width = `${w}px`;
      cv.style.height = `${hh}px`;
    }
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.view === 'GRAPH') return drawGraph(this, ctx, w, hh);
    if (this.view === 'DOPESHEET') return drawDopesheet(this, ctx, w, hh);
    this.drawClip(ctx, w, hh, dpr);
  }

  private drawClip(ctx: CanvasRenderingContext2D, w: number, hh: number, dpr: number) {
    ctx.fillStyle = canvasGrey(0x30);
    ctx.fillRect(0, 0, w, hh);
    const c = this.clip;
    if (!c && this.mode === 'MASK') return this.drawMaskFrame(ctx, w, hh);
    if (!c) {
      ctx.fillStyle = canvasTextGrey(0x8a);
      ctx.font = '12px var(--font, sans-serif)';
      ctx.textAlign = 'center';
      ctx.fillText('No movie clip: open one with Clip ▸ Open… (Alt O)', w / 2, hh / 2);
      return;
    }
    const src = readySource(c);
    if (!c.size[0]) {
      if (src) {
        c.size = [src.width, src.height];
        c.frame_duration ||= src.frameCount;
      } else return void this.retryLater();
    }
    if (!this.fitted) this.frameAll();
    const [W, H] = c.size;
    const T = this.stab();
    // footage
    const cf = this.clipFrame;
    const idx = clipFrameToSourceIndex(c, cf);
    const inRange = cf >= 1 && cf <= c.frame_duration && idx >= 0;
    const shown = (src && this.displaySource()) || src;
    const bmp = inRange && shown ? shown.peek(idx) : null;
    // canvas affine for footage → screen (with stabilization)
    const p0 = this.viewScreen(0, 0, T),
      px = this.viewScreen(1, 0, T),
      py = this.viewScreen(0, 1, T);
    ctx.save();
    ctx.setTransform(dpr * (px[0] - p0[0]), dpr * (px[1] - p0[1]), dpr * (py[0] - p0[0]), dpr * (py[1] - p0[1]), dpr * p0[0], dpr * p0[1]);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, W, H);
    const lens = this.undistortLens();
    if (bmp && !this.overlays.use_mute_footage && !lens) {
      const filter = c.tracking.stabilization.filter_type;
      ctx.imageSmoothingEnabled = T ? filter !== 'NEAREST' : this.zoom < 1;
      ctx.imageSmoothingQuality = filter === 'BICUBIC' ? 'high' : 'low';
      if (this.overlays.use_grayscale_preview) ctx.filter = 'grayscale(1)';
      ctx.drawImage(bmp, 0, 0, W, H);
      ctx.filter = 'none';
      this.maskChannels(ctx, W, H);
    }
    ctx.restore();
    if (bmp && !this.overlays.use_mute_footage && lens) this.drawUndistorted(ctx, bmp, lens, T);
    if (this.overlays.show_grid) this.drawLensGrid(ctx, T);
    if (inRange && src && !bmp) this.request(idx);
    if (inRange && src) this.prefetchAround(idx);
    // frame outline
    ctx.strokeStyle = 'rgba(0, 0, 0,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const fc = [this.viewScreen(0, 0, T), this.viewScreen(W, 0, T), this.viewScreen(W, H, T), this.viewScreen(0, H, T)];
    fc.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    ctx.stroke();
    if (this.overlays.show_overlays === false) {
      if (this.mode === 'MASK') drawMaskMatte(this, ctx, this.overlays.mask_overlay_mode ?? 'NONE', this.overlays.blend_factor ?? 0.5);
    } else if (this.mode === 'MASK') {
      drawMaskMatte(this, ctx, this.overlays.mask_overlay_mode ?? 'NONE', this.overlays.blend_factor ?? 0.5);
      drawMask(this, ctx, this.overlays.show_mask_spline !== false, this.overlays.mask_display_type ?? 'OUTLINE');
      this.drawCursor(ctx);
    } else {
      drawPlaneTracks(this, ctx, T);
      if (this.overlays.show_annotation !== false) drawAnnotations2D(this, ctx);
      this.drawMarkers(ctx, T);
      if (this.overlays.show_bundles !== false) this.drawBundles(ctx, T);
      drawSelectShape(ctx, this.shapeOverlay);
      this.drawCursor(ctx);
    }
    if (this.boxRect) {
      const b = this.boxRect;
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#ffffff';
      ctx.strokeRect(Math.min(b.x0, b.x1) + 0.5, Math.min(b.y0, b.y1) + 0.5, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      ctx.setLineDash([]);
    }
    if (this.overlays.show_cache) this.drawCacheLine(ctx, w, hh);
    // info text
    ctx.font = '11px var(--mono, monospace)';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#e8e9ea';
    ctx.shadowColor = 'rgba(0, 0, 0,0.9)';
    ctx.shadowBlur = 2;
    const left = this.showToolbar ? 238 : 8;
    const info = `Frame: ${cf} / ${c.frame_duration}${src ? `  ${W}×${H}  ${src.fps} fps  [${src.kind === 'webcodecs' ? 'WebCodecs' : src.kind === 'video' ? 'Video element' : 'Image sequence'}]` : '  Loading…'}${!inRange ? '  (outside of the clip)' : ''}`;
    ctx.fillText(info, left, 16);
    const job = jobState.get();
    if (job) ctx.fillText(`${job.label}… ${Math.round(job.progress * 100)}%${job.detail ? `  ${job.detail}` : ''}  (Esc to stop)`, left, 32);
    ctx.shadowBlur = 0;
  }

  /** Footage with the lens distortion removed: a grid of triangles, each mapped affinely. */
  private drawUndistorted(ctx: CanvasRenderingContext2D, bmp: CanvasImageSource & { width: number; height: number }, L: Intrinsics, T: Affine2 | null) {
    const [W, H] = this.frameSize();
    const N = 12;
    const src: [number, number][][] = [],
      dst: [number, number][][] = [];
    for (let j = 0; j <= N; j++) {
      src.push([]);
      dst.push([]);
      for (let i = 0; i <= N; i++) {
        const ux = (i / N) * W,
          uy = (j / N) * H;
        const d = distortPixelWith(L, ux, H - uy);
        src[j].push([(d[0] / W) * bmp.width, ((H - d[1]) / H) * bmp.height]);
        dst[j].push(this.viewScreen(ux, uy, T));
      }
    }
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    const tri = (s: [number, number][], p: [number, number][]) => {
      const [sa, sb, sc] = s,
        [pa, pb, pc] = p;
      const den = (sb[0] - sa[0]) * (sc[1] - sa[1]) - (sc[0] - sa[0]) * (sb[1] - sa[1]);
      if (Math.abs(den) < 1e-9) return;
      const m11 = ((pb[0] - pa[0]) * (sc[1] - sa[1]) - (pc[0] - pa[0]) * (sb[1] - sa[1])) / den;
      const m12 = ((pc[0] - pa[0]) * (sb[0] - sa[0]) - (pb[0] - pa[0]) * (sc[0] - sa[0])) / den;
      const m21 = ((pb[1] - pa[1]) * (sc[1] - sa[1]) - (pc[1] - pa[1]) * (sb[1] - sa[1])) / den;
      const m22 = ((pc[1] - pa[1]) * (sb[0] - sa[0]) - (pb[1] - pa[1]) * (sc[0] - sa[0])) / den;
      const cx = (pa[0] + pb[0] + pc[0]) / 3,
        cy = (pa[1] + pb[1] + pc[1]) / 3;
      ctx.save();
      ctx.beginPath();
      for (const [k, q] of [pa, pb, pc].entries()) {
        const x = q[0] + (q[0] - cx) * 0.03,
          y = q[1] + (q[1] - cy) * 0.03;
        if (k) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.clip();
      ctx.transform(m11, m21, m12, m22, pa[0] - m11 * sa[0] - m12 * sa[1], pa[1] - m21 * sa[0] - m22 * sa[1]);
      ctx.drawImage(bmp, 0, 0);
      ctx.restore();
    };
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        tri([src[j][i], src[j][i + 1], src[j + 1][i + 1]], [dst[j][i], dst[j][i + 1], dst[j + 1][i + 1]]);
        tri([src[j][i], src[j + 1][i + 1], src[j + 1][i]], [dst[j][i], dst[j + 1][i + 1], dst[j + 1][i]]);
      }
    ctx.restore();
  }

  /** Grid of straight lines in the undistorted image, drawn where the lens shows them. */
  private drawLensGrid(ctx: CanvasRenderingContext2D, T: Affine2 | null) {
    const c = this.clip;
    if (!c?.size[0]) return;
    const [W, H] = c.size;
    const I = clipIntrinsics(c);
    const undistorted = !!this.undistortLens();
    const at = (ux: number, uy: number) => {
      if (undistorted || !hasDistortion(I)) return this.viewScreen(ux, uy, T);
      const d = distortPixelWith(I, ux, H - uy);
      return this.viewScreen(d[0], H - d[1], T);
    };
    const N = 10,
      S = 40;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 64, 64, 0.65)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 0; k <= N; k++)
      for (const vertical of [false, true]) {
        for (let s = 0; s <= S; s++) {
          const a = (k / N) * (vertical ? W : H),
            b = (s / S) * (vertical ? H : W);
          const p = vertical ? at(a, b) : at(b, a);
          if (s) ctx.lineTo(p[0], p[1]);
          else ctx.moveTo(p[0], p[1]);
        }
      }
    ctx.stroke();
    ctx.restore();
  }

  /** Hide footage channels switched off in Clip Display (multiplies the drawn frame). */
  private maskChannels(ctx: CanvasRenderingContext2D, W: number, H: number) {
    const ov = this.overlays;
    const r = ov.show_red_channel !== false,
      g = ov.show_green_channel !== false,
      b = ov.show_blue_channel !== false;
    if (r && g && b) return;
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = `rgb(${r ? 255 : 0}, ${g ? 255 : 0}, ${b ? 255 : 0})`;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  /** Graph / dope sheet header: refine, clear and track the selected tracks without the clip view. */
  private trackingButtons(): Child {
    const ib = (op: string, ic: string, props: Record<string, unknown>, tip: string) =>
      h('button', { key: `${op}-${ic}`, class: 'hdr-toggle', disabled: !app.poll(op), 'data-tip': tip, onclick: () => app.run(op, props, { area: this.area }) }, icon(ic));
    return h(
      'div',
      { class: 'hdr-group clip-track-buttons', key: 'clip-track-buttons' },
      ib('clip.refine_markers', 'tracking_refine_backwards', { backwards: true }, 'Refine Markers\nRefine markers from the next keyframe'),
      ib('clip.clear_track_path', 'tracking_clear_backwards', { action: 'UPTO' }, 'Clear Track Path\nClear the path up to the current frame'),
      ib('clip.track_markers', 'tracking_backwards_single', { backwards: true, sequence: false }, 'Track Markers\nTrack one frame backwards'),
      ib('clip.track_markers', 'tracking_backwards', { backwards: true, sequence: true }, 'Track Markers\nTrack backwards'),
      ib('clip.track_markers', 'tracking_forwards', { backwards: false, sequence: true }, 'Track Markers\nTrack forwards'),
      ib('clip.track_markers', 'tracking_forwards_single', { backwards: false, sequence: false }, 'Track Markers\nTrack one frame forwards'),
      ib('clip.clear_track_path', 'tracking_clear_forwards', { action: 'REMAINED' }, 'Clear Track Path\nClear the path after the current frame'),
      ib('clip.refine_markers', 'tracking_refine_forwards', { backwards: false }, 'Refine Markers\nRefine markers from the previous keyframe'),
    );
  }

  toggleLockTime() {
    this.lockTimeCursor = !this.lockTimeCursor;
    if (this.lockTimeCursor) this.v2.centerOnFrame(app.doc.scene.frame_current);
    this.draw();
    app.changed('ui');
  }

  toggleOverlays() {
    this.overlays.show_overlays = this.overlays.show_overlays === false;
    this.draw();
    this.drawUI();
    this.area.drawHeader();
  }

  /** The 2D cursor (Shift right click places it). */
  private drawCursor(ctx: CanvasRenderingContext2D) {
    if (this.overlays.show_cursor === false) return;
    const [W, H] = this.frameSize();
    const [x, y] = this.toScreen(this.cursor[0] * W, (1 - this.cursor[1]) * H);
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineDashOffset = 3;
    ctx.strokeStyle = '#dc433b';
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(0, 0, 0,0.8)';
    ctx.beginPath();
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      ctx.moveTo(x + dx * 11, y + dy * 11);
      ctx.lineTo(x + dx * 16, y + dy * 16);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** Mask mode without footage: an empty frame of the render size with the mask. */
  private drawMaskFrame(ctx: CanvasRenderingContext2D, w: number, hh: number) {
    if (!this.fitted) this.frameAll();
    const [W, H] = this.frameSize();
    const a = this.toScreen(0, 0, null),
      b = this.toScreen(W, H, null);
    ctx.fillStyle = '#161719';
    ctx.fillRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
    ctx.strokeStyle = 'rgba(0, 0, 0,0.6)';
    ctx.strokeRect(a[0] + 0.5, a[1] + 0.5, b[0] - a[0], b[1] - a[1]);
    drawMaskMatte(this, ctx, this.overlays.mask_overlay_mode ?? 'NONE', this.overlays.blend_factor ?? 0.5);
    drawMask(this, ctx, this.overlays.show_mask_spline !== false, this.overlays.mask_display_type ?? 'OUTLINE');
    this.drawCursor(ctx);
    ctx.font = '11px var(--mono, monospace)';
    ctx.fillStyle = '#9a9b9c';
    ctx.textAlign = 'left';
    ctx.fillText(`Mask frame ${W}×${H} (no footage)`, this.showToolbar ? 238 : 8, 16);
    void w;
    void hh;
  }

  /** Source the footage is shown from: a built proxy of the chosen size, else the footage. */
  displaySource() {
    const c = this.clip;
    if (!c) return null;
    return proxySource(c, this.proxyRenderSize) ?? readySource(c);
  }

  private retryLater() {
    setTimeout(() => this.el.isConnected && this.draw(), 100);
  }

  private request(idx: number) {
    const c = this.clip;
    const src = c && this.displaySource();
    if (!src || this.loading.has(idx)) return;
    this.loading.add(idx);
    void src.get(idx).finally(() => {
      this.loading.delete(idx);
      if (this.el.isConnected) this.draw();
    });
  }

  /** decode a few frames ahead during playback / scrubbing */
  private prefetchAround(idx: number) {
    const c = this.clip;
    const src = c && this.displaySource();
    if (!src) return;
    const n = app.playing ? 6 : 1;
    for (let k = 1; k <= n; k++) if (idx + k < src.frameCount && !src.peek(idx + k) && !this.loading.has(idx + k)) {
      this.loading.add(idx + k);
      void src.get(idx + k).finally(() => this.loading.delete(idx + k));
    }
  }

  /** Horizontal extent of the frame strip at the bottom of the clip view. */
  private scrubRange(w: number) {
    return { x0: this.showToolbar ? 230 : 0, x1: w - (this.showSidebar ? 290 : 0) };
  }

  /** Whether a local point is on the frame strip (it scrubs frames). */
  scrubStripAt(x: number, y: number) {
    const { w, h: hh } = this.viewSize();
    const { x0, x1 } = this.scrubRange(w);
    return y >= hh - 14 && x >= x0 && x <= x1;
  }

  /** Drag along the frame strip to change the frame. */
  private scrubStrip(e: PointerEvent) {
    e.preventDefault();
    const c = this.clip!;
    const n = Math.max(1, c.frame_duration);
    const go = (ev: { clientX: number }) => {
      const { w } = this.viewSize();
      const { x0, x1 } = this.scrubRange(w);
      const x = this.local({ clientX: ev.clientX, clientY: 0 }).x;
      const cf = Math.max(1, Math.min(n, Math.floor(1 + ((x - x0) / Math.max(1, x1 - x0)) * n)));
      const f = clipToSceneFrame(c, cf);
      if (f !== app.doc.scene.frame_current) app.setFrame(f);
    };
    go(e);
    const up = () => (removeEventListener('pointermove', go), removeEventListener('pointerup', up));
    addEventListener('pointermove', go);
    addEventListener('pointerup', up);
  }

  private drawCacheLine(ctx: CanvasRenderingContext2D, w: number, hh: number) {
    const c = this.clip!;
    const src = readySource(c);
    const n = Math.max(1, c.frame_duration);
    const { x0, x1 } = this.scrubRange(w);
    const y = hh - 8;
    const fx = (f: number) => x0 + ((f - 1) / n) * (x1 - x0);
    ctx.fillStyle = 'rgba(0, 0, 0,0.4)';
    ctx.fillRect(x0, y, x1 - x0, 8);
    if (src) {
      ctx.fillStyle = '#5e7dbf';
      for (const i of src.cached()) {
        const f = i + 1 - c.frame_offset;
        ctx.fillRect(fx(f), y + 4, Math.max(1, fx(f + 1) - fx(f)), 4);
      }
    }
    const t = activeTrack(c);
    if (t) {
      for (const m of t.markers) {
        ctx.fillStyle = m.mute ? '#7c0802' : m.is_keyed ? '#f0fb18' : '#9ca223';
        ctx.fillRect(fx(m.frame), y, Math.max(1, fx(m.frame + 1) - fx(m.frame)), 4);
      }
    }
    ctx.fillStyle = '#4b70b5';
    const cf = this.clipFrame;
    ctx.fillRect(fx(cf), y - 2, Math.max(2, fx(cf + 1) - fx(cf)), 10);
  }

  trackColor(t: MovieTrackingTrack, m: MovieTrackingMarker | null, isActive: boolean): string {
    if (t.use_custom_color) {
      const cc = t.color.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255));
      if (!t.select) return `rgb(${cc[0]},${cc[1]},${cc[2]})`;
    }
    if (m?.mute) return COLORS.disabled;
    if (t.lock) return COLORS.locked;
    if (isActive && t.select) return COLORS.active;
    if (t.select) return COLORS.selected;
    if (t.use_custom_color) {
      const cc = t.color.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255));
      return `rgb(${cc[0]},${cc[1]},${cc[2]})`;
    }
    return COLORS.marker;
  }

  private drawMarkers(ctx: CanvasRenderingContext2D, T: Affine2 | null) {
    const c = this.clip!;
    const f = this.clipFrame;
    const act = activeTrack(c);
    const ov = this.overlays;
    const S = (p: [number, number]) => this.toScreen(p[0], p[1], T);
    const tracks = this.tracks().slice().sort((a, b) => Number(a.select) - Number(b.select) || Number(a === act) - Number(b === act));
    // paths
    if (ov.show_track_path && ov.path_length > 0)
      for (const t of tracks) {
        if (!t.select) continue;
        const pts = (from: number, to: number, dir: number) => {
          const out: { p: [number, number]; key: boolean }[] = [];
          for (let k = from; dir > 0 ? k <= to : k >= to; k += dir) {
            const m = markerExact(t, k);
            if (!m || m.mute) break;
            const g = this.markerGeom(m);
            out.push({ p: S([g.x, g.y]), key: m.is_keyed });
          }
          return out;
        };
        const cur = enabledMarkerAt(t, f);
        if (!cur) continue;
        const before = pts(f, f - ov.path_length, -1),
          after = pts(f, f + ov.path_length, 1);
        for (const [list, col, kcol] of [
          [before, COLORS.pathBefore, COLORS.pathKeyBefore],
          [after, COLORS.pathAfter, COLORS.pathKeyAfter],
        ] as const) {
          if (list.length < 2) continue;
          ctx.lineWidth = 3;
          ctx.strokeStyle = '#000000';
          ctx.beginPath();
          list.forEach((q, i) => (i ? ctx.lineTo(q.p[0], q.p[1]) : ctx.moveTo(q.p[0], q.p[1])));
          ctx.stroke();
          ctx.lineWidth = 1;
          ctx.strokeStyle = col;
          ctx.stroke();
          for (const q of list) {
            ctx.fillStyle = q.key ? kcol : col;
            ctx.fillRect(q.p[0] - (q.key ? 2 : 1), q.p[1] - (q.key ? 2 : 1), q.key ? 4 : 2, q.key ? 4 : 2);
          }
        }
      }
    for (const t of tracks) {
      const m = markerAt(t, f);
      if (!m || f < t.markers[0].frame) continue;
      if (m.mute && !ov.show_disabled) continue;
      const g = this.markerGeom(m);
      const isActive = t === act;
      const col = this.trackColor(t, m, isActive);
      const anchor = S([g.x, g.y]);
      const quad = g.corners.map(S);
      const stroke = (pts: [number, number][], color: string, dash: number[] = [], closed = true) => {
        ctx.setLineDash(dash);
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
        if (closed) ctx.closePath();
        if (!ov.show_tiny_markers) {
          ctx.lineWidth = 3;
          ctx.strokeStyle = COLORS.outline;
          ctx.stroke();
        }
        ctx.lineWidth = 1;
        ctx.strokeStyle = color;
        ctx.stroke();
        ctx.setLineDash([]);
      };
      // anchor cross
      const cr = 4;
      stroke([[anchor[0] - cr, anchor[1]], [anchor[0] + cr, anchor[1]]], col, [], false);
      stroke([[anchor[0], anchor[1] - cr], [anchor[0], anchor[1] + cr]], col, [], false);
      if (ov.show_marker_pattern) stroke(quad, col, m.mute ? [3, 3] : []);
      if (ov.show_marker_search && t.select) stroke(g.search.map(S), col, [5, 4]);
      // handles on selected markers
      if (t.select && !t.lock && ov.show_marker_pattern) {
        ctx.fillStyle = col;
        for (const q of quad) ctx.fillRect(q[0] - 2.5, q[1] - 2.5, 5, 5);
        if (ov.show_marker_search) {
          const sq = g.search.map(S);
          for (const q of sq) ctx.strokeRect(q[0] - 3, q[1] - 3, 6, 6);
        }
      }
      if (ov.show_names || (ov.show_info && t.select)) {
        const lines = [t.name];
        if (ov.show_info && t.select) {
          lines.push(m.mute ? 'Disabled' : m.frame === f ? (m.is_keyed ? 'Keyframed' : 'Tracked') : 'Estimated');
          if (t.last_correlation !== undefined && !m.mute) lines.push(`Correlation: ${t.last_correlation.toFixed(3)}`);
          if (t.has_bundle) lines.push(`Average Error: ${(t.average_error ?? 0).toFixed(3)} px`);
          if (t.lock) lines.push('Locked');
        }
        const bx = Math.max(...quad.map((q) => q[0])) + 4,
          by = Math.max(...quad.map((q) => q[1])) + 12;
        ctx.font = '11px var(--font, sans-serif)';
        ctx.textAlign = 'left';
        lines.forEach((l, i) => {
          ctx.lineWidth = 3;
          ctx.strokeStyle = '#000000';
          ctx.strokeText(l, bx, by + i * 13);
          ctx.fillStyle = col === COLORS.marker ? '#cad403' : col;
          ctx.fillText(l, bx, by + i * 13);
        });
      }
    }
  }

  /** Reprojected bundles: where the solved camera sees each reconstructed track, joined to its marker. */
  private drawBundles(ctx: CanvasRenderingContext2D, T: Affine2 | null) {
    const c = this.clip!;
    const o = tobj(c);
    if (!o.reconstruction?.is_valid) return;
    const f = this.clipFrame;
    const [W, H] = c.size;
    for (const t of this.tracks()) {
      if (!t.has_bundle || !t.bundle) continue;
      const m = enabledMarkerAt(t, f);
      if (!m || m.frame !== f) continue;
      const q = reprojectBundle(c, o, t.bundle, f);
      if (!q) continue;
      const a = this.toScreen((m.co[0] + t.offset[0]) * W, (1 - m.co[1] - t.offset[1]) * H, T);
      const b = this.toScreen(q[0], H - q[1], T);
      const err = Math.hypot((m.co[0] + t.offset[0]) * W - q[0], (m.co[1] + t.offset[1]) * H - q[1]);
      const col = err < 1 ? '#4fd06b' : err < 3 ? '#f0c419' : '#f0483e';
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
      ctx.fillStyle = '#000000';
      ctx.beginPath();
      ctx.arc(b[0], b[1], 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(b[0], b[1], 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---------------------------------------------------------------------------
  // hit testing

  hit(sx: number, sy: number): Handle | null {
    const c = this.clip;
    if (!c) return null;
    const f = this.clipFrame;
    const T = this.stab();
    const act = activeTrack(c);
    const list = this.tracks()
      .slice()
      .sort((a, b) => Number(b === act) - Number(a === act) || Number(b.select) - Number(a.select));
    // handles of selected markers first
    for (const t of list) {
      if (!t.select || t.lock) continue;
      const m = markerAt(t, f);
      if (!m || f < t.markers[0].frame) continue;
      const g = this.markerGeom(m);
      if (this.overlays.show_marker_pattern)
        for (let i = 0; i < 4; i++) {
          const q = this.toScreen(g.corners[i][0], g.corners[i][1], T);
          if (Math.abs(q[0] - sx) <= 5 && Math.abs(q[1] - sy) <= 5) return { track: t, kind: 'corner', index: i };
        }
      if (this.overlays.show_marker_search)
        for (let i = 0; i < 4; i++) {
          const q = this.toScreen(g.search[i][0], g.search[i][1], T);
          if (Math.abs(q[0] - sx) <= 5 && Math.abs(q[1] - sy) <= 5) return { track: t, kind: 'search', index: i };
        }
    }
    for (const t of list) {
      const m = markerAt(t, f);
      if (!m || f < t.markers[0].frame || (m.mute && !this.overlays.show_disabled)) continue;
      const g = this.markerGeom(m);
      const quad = g.corners.map((p) => this.toScreen(p[0], p[1], T));
      const a = this.toScreen(g.x, g.y, T);
      if (pointInQuad(sx, sy, quad) || Math.hypot(a[0] - sx, a[1] - sy) < 6) return { track: t, kind: 'move', index: -1 };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // input

  local(e: { clientX: number; clientY: number }) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private bind() {
    const el = this.canvas;
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const p = this.local(e);
        if (this.view !== 'CLIP') return this.wheel2D(e, p);
        const trackpad = e.deltaMode === 0 && (Math.abs(e.deltaX) > 0 || !Number.isInteger(e.deltaY));
        if (e.ctrlKey) this.zoomAt(Math.exp(-e.deltaY * 0.01), p.x, p.y);
        else if (trackpad) {
          this.offX -= e.deltaX / this.zoom;
          this.offY -= e.deltaY / this.zoom;
          this.draw();
        } else this.zoomAt(e.deltaY > 0 ? 0.8 : 1.25, p.x, p.y);
      },
      { passive: false },
    );
    el.addEventListener('pointerdown', (e) => this.pointerDown(e));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // Ctrl+click is "add marker" (macOS reports it as a context click too)
      if (e.ctrlKey && e.button === 0) return;
      // Shift right click placed the 2D cursor (on press)
      if (this.cursorPlaced) {
        this.cursorPlaced = false;
        return;
      }
      if (this.view === 'CLIP') openMenu(contextMenu(), { x: e.clientX, y: e.clientY }, { title: 'Context Menu' });
    });
  }

  private wheel2D(e: WheelEvent, p: { x: number; y: number }) {
    const trackpad = e.deltaMode === 0 && (Math.abs(e.deltaX) > 0 || !Number.isInteger(e.deltaY));
    if (this.view === 'DOPESHEET' && !e.ctrlKey && !trackpad) {
      this.dopesheetScroll = Math.max(0, this.dopesheetScroll + e.deltaY * 0.5);
      return this.draw();
    }
    if (e.ctrlKey || !trackpad) {
      const f = Math.exp(-(e.deltaY || e.deltaX) * (trackpad ? 0.01 : 0.002));
      if (e.shiftKey && this.view === 'GRAPH') this.v2.zoomY(f, p.y - 24);
      else this.v2.zoomX(f, p.x - (this.view === 'DOPESHEET' ? 200 : 0));
    } else {
      this.v2.panPx(-e.deltaX, this.view === 'GRAPH' ? -e.deltaY : 0);
      if (this.view === 'DOPESHEET') this.dopesheetScroll = Math.max(0, this.dopesheetScroll + e.deltaY);
    }
    this.draw();
  }

  private pointerDown(e: PointerEvent) {
    this.el.focus({ preventScroll: true });
    lastClipEditor = this;
    const start = this.local(e);
    const el = this.canvas;
    // pan / zoom with the middle button (or Alt+LMB emulation)
    if (e.button === 1 || (e.button === 0 && e.altKey && !e.ctrlKey && !annotateKeyHeld())) {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      let last = start;
      const zoomDrag = e.ctrlKey;
      const move = (ev: PointerEvent) => {
        const q = this.local(ev);
        if (this.view !== 'CLIP') {
          if (zoomDrag) this.v2.zoomX(Math.exp((q.x - last.x) * 0.01), start.x);
          else this.v2.panPx(q.x - last.x, this.view === 'GRAPH' ? q.y - last.y : 0);
          if (this.view === 'DOPESHEET') this.dopesheetScroll = Math.max(0, this.dopesheetScroll - (q.y - last.y));
          this.draw();
        } else if (zoomDrag) this.zoomAt(Math.exp((q.x - last.x - (q.y - last.y)) * 0.01), start.x, start.y);
        else {
          this.offX += (q.x - last.x) / this.zoom;
          this.offY += (q.y - last.y) / this.zoom;
          this.draw();
        }
        last = q;
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      return;
    }
    if (this.view === 'CLIP' && this.clip && ((annotateKeyHeld() && (e.button === 0 || e.button === 2)) || (e.button === 0 && this.annotateTool && !e.altKey))) {
      if (e.button === 2) this.cursorPlaced = true; // no context menu after erasing
      const mode = annotateKeyHeld() ? (e.button === 2 ? 'ERASER' : e.altKey ? (e.shiftKey ? 'DRAW_POLY' : 'DRAW_STRAIGHT') : 'DRAW') : annotateModeOf(this.annotateTool!);
      annotatePointerDown(this, e, mode);
      return;
    }
    if (e.button === 2 && e.shiftKey && this.view === 'CLIP') {
      // Shift right click places the 2D cursor
      const [W, H] = this.frameSize();
      const [ix, iy] = this.toImage(start.x, start.y);
      this.cursor = [ix / W, 1 - iy / H];
      this.cursorPlaced = true;
      this.draw();
      app.changed('ui');
      return;
    }
    if (e.button !== 0) return;
    if (this.view === 'CLIP' && this.clip && this.overlays.show_cache && this.scrubStripAt(start.x, start.y)) return this.scrubStrip(e);
    if (this.view === 'CLIP' && this.mode === 'MASK') {
      e.preventDefault();
      if (!hostMask(this)) return;
      maskPointerDown(this, e);
      return;
    }
    if (this.view === 'GRAPH') return graphPointer(this, e, start);
    if (this.view === 'DOPESHEET') return dopesheetPointer(this, e, start);
    const c = this.clip;
    if (!c || jobState.get()) return;
    e.preventDefault();
    if (this.boxPending) return this.boxSelect(e, start, true);
    if ((e.ctrlKey || e.metaKey) && e.altKey) return clipLasso(this, e, e.shiftKey ? 'SUB' : 'ADD');
    if (e.ctrlKey || e.metaKey) {
      // add marker and slide it
      const [ix, iy] = this.toImage(start.x, start.y);
      app.run('clip.add_marker', { location: [ix / c.size[0], 1 - iy / c.size[1]] }, { area: this.area });
      const t = activeTrack(this.clip!);
      if (t) this.slide(e, { track: t, kind: 'move', index: -1 }, start, 'Add Marker');
      return;
    }
    if (planeCornerDown(this, e, start)) return;
    const hit = this.hit(start.x, start.y);
    if (!hit && planeBodyDown(this, e, start)) return void this.drawUI();
    if (hit) {
      const t = hit.track;
      if (e.shiftKey && hit.kind === 'move') {
        if (t.select && tobj(c).active_track === t.name) t.select = false;
        else {
          t.select = true;
          tobj(c).active_track = t.name;
        }
      } else {
        if (!t.select) {
          for (const o of tobj(c).tracks) o.select = false;
          for (const p of tobj(c).plane_tracks ?? []) p.select = false;
        }
        t.select = true;
        tobj(c).active_track = t.name;
      }
      app.changed('doc');
      this.drawUI();
      if (t.lock || !t.select) {
        app.pushUndo('Select');
        return;
      }
      this.slide(e, hit, start, 'Slide Marker');
      return;
    }
    // empty space: click deselects, drag box-selects
    this.boxSelect(e, start, false);
  }

  /** Drag a marker (move), a pattern corner or a search area corner. */
  private slide(e: PointerEvent, hd: Handle, start: { x: number; y: number }, label: string) {
    const c = this.clip!;
    const el = this.canvas;
    el.setPointerCapture(e.pointerId);
    const f = this.clipFrame;
    const t = hd.track;
    const held = markerAt(t, f);
    if (!held) return;
    const orig = cloneMarker(held, f);
    const hadExact = markerExact(t, f);
    const before = hadExact ? cloneMarker(hadExact) : null;
    let moved = false;
    const [W, H] = c.size;
    const [ix0, iy0] = this.toImage(start.x, start.y);
    // moving every selected marker together
    const others = hd.kind === 'move' ? this.tracks().filter((o) => o !== t && o.select && !o.lock) : [];
    const otherOrig = others.map((o) => ({ o, m: markerAt(o, f) ? cloneMarker(markerAt(o, f)!, f) : null, exact: markerExact(o, f) ? cloneMarker(markerExact(o, f)!) : null }));
    const move = (ev: PointerEvent) => {
      const q = this.local(ev);
      const [ix, iy] = this.toImage(q.x, q.y);
      const precision = ev.shiftKey ? 0.2 : 1;
      const du = ((ix - ix0) * precision) / W,
        dv = (-(iy - iy0) * precision) / H;
      if (!moved && Math.hypot(q.x - start.x, q.y - start.y) < 3) return;
      moved = true;
      const m = cloneMarker(orig, f);
      m.is_keyed = true;
      m.mute = false;
      if (hd.kind === 'move') {
        m.co = [orig.co[0] + du, orig.co[1] + dv];
        for (const { o, m: om } of otherOrig) {
          if (!om) continue;
          const nm = cloneMarker(om, f);
          nm.co = [om.co[0] + du, om.co[1] + dv];
          nm.is_keyed = true;
          insertMarker(o, nm);
        }
      } else if (hd.kind === 'corner') {
        const pc = orig.pattern_corners[hd.index];
        m.pattern_corners[hd.index] = [pc[0] + du, pc[1] + dv];
        if (ev.ctrlKey || t.motion_model === 'Loc' || t.motion_model === 'LocScale') {
          // keep the pattern axis aligned for translation-style models: scale symmetric
          const sx = Math.abs(pc[0] + du) / Math.max(1e-9, Math.abs(pc[0])),
            sy = Math.abs(pc[1] + dv) / Math.max(1e-9, Math.abs(pc[1]));
          m.pattern_corners = orig.pattern_corners.map((p) => [p[0] * sx, p[1] * sy]) as MovieTrackingMarker['pattern_corners'];
        }
      } else {
        // search corner: resize symmetric around the marker
        const cx = hd.index === 1 || hd.index === 2 ? orig.search_max[0] : orig.search_min[0];
        const cy = hd.index >= 2 ? orig.search_max[1] : orig.search_min[1];
        const nx = Math.max(Math.abs(cx + du), 4 / W),
          ny = Math.max(Math.abs(cy + dv), 4 / H);
        m.search_min = [-nx, -ny];
        m.search_max = [nx, ny];
      }
      insertMarker(t, m);
      app.changed('doc');
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
      if (moved) app.pushUndo(label);
      else if (label === 'Add Marker') app.changed('doc');
      else app.pushUndo('Select');
    };
    const cancel = () => {
      // restore
      if (before) insertMarker(t, before);
      else t.markers = t.markers.filter((x) => x.frame !== f);
      for (const { o, exact } of otherOrig) {
        if (exact) insertMarker(o, exact);
        else o.markers = o.markers.filter((x) => x.frame !== f);
      }
      up();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
  }

  boxSelect(e: PointerEvent, start: { x: number; y: number }, fromKey: boolean) {
    const c = this.clip;
    if (!c) return;
    const el = this.canvas;
    el.setPointerCapture(e.pointerId);
    const extend = e.shiftKey || fromKey;
    const sub = e.ctrlKey && fromKey;
    let dragged = false;
    this.boxRect = null;
    const move = (ev: PointerEvent) => {
      const q = this.local(ev);
      if (!dragged && Math.hypot(q.x - start.x, q.y - start.y) < 4) return;
      dragged = true;
      this.boxRect = { x0: start.x, y0: start.y, x1: q.x, y1: q.y };
      this.draw();
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      this.boxPending = false;
      this.canvas.style.cursor = '';
      const b = this.boxRect;
      this.boxRect = null;
      if (!dragged || !b) {
        if (!fromKey) {
          let any = false;
          for (const t of tobj(c).tracks) if (t.select) ((t.select = false), (any = true));
          for (const p of tobj(c).plane_tracks ?? []) if (p.select) ((p.select = false), (any = true));
          if (any) app.pushUndo('Select');
          app.changed('doc');
        }
        this.draw();
        return;
      }
      const x0 = Math.min(b.x0, b.x1),
        x1 = Math.max(b.x0, b.x1),
        y0 = Math.min(b.y0, b.y1),
        y1 = Math.max(b.y0, b.y1);
      const T = this.stab();
      const f = this.clipFrame;
      for (const t of this.tracks()) {
        const m = enabledMarkerAt(t, f) ?? (this.overlays.show_disabled ? markerAt(t, f) : null);
        const g = m ? this.markerGeom(m) : null;
        const p = g ? this.toScreen(g.x, g.y, T) : null;
        const inside = !!p && p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
        if (inside) t.select = !sub;
        else if (!extend) t.select = false;
      }
      const act = activeTrack(c);
      if (!act?.select) tobj(c).active_track = tobj(c).tracks.find((t) => t.select)?.name ?? tobj(c).active_track;
      app.pushUndo('Box Select');
      app.changed('doc');
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  }

  onKey(e: KeyboardEvent): boolean {
    if (e.type !== 'keydown') return false;
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl && !e.altKey && !e.shiftKey) {
      if (e.code === 'KeyN') return this.toggleSidebar(), true;
      if (e.code === 'KeyT') return this.toggleToolbar(), true;
    }
    if (e.code === 'Backquote' && ctrl && !e.altKey && !e.shiftKey && this.view === 'CLIP') return ((this.showGizmo = !this.showGizmo), this.drawUI()), true;
    if (e.code === 'Escape' && this.annotateTool) {
      this.annotateTool = null;
      this.drawUI();
      return true;
    }
    if (e.code === 'Escape' && (this.boxPending || this.boxRect)) {
      this.boxPending = false;
      this.boxRect = null;
      this.canvas.style.cursor = '';
      this.draw();
      return true;
    }
    return false;
  }

  toggleSidebar() {
    this.showSidebar = !this.showSidebar;
    this.drawUI();
    this.draw();
  }
  toggleToolbar() {
    this.showToolbar = !this.showToolbar;
    this.drawUI();
    this.draw();
  }

  // ---------------------------------------------------------------------------
  // header

  header(): Child {
    const c = this.clip;
    const menu = (label: string, items: () => MenuItem[]) =>
      h(
        'button',
        {
          key: `m-${label}`,
          class: 'hdr-menu',
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            openMenu(items(), e.currentTarget as HTMLElement);
          },
          onpointerenter: (e: PointerEvent) => {
            if (document.querySelector('.hdr-menu.menu-open') && !(e.currentTarget as HTMLElement).classList.contains('menu-open')) openMenu(items(), e.currentTarget as HTMLElement);
          },
        },
        label,
      );
    const clips = Object.values(clipTable(app.doc));
    return h(
      'div',
      { class: 'hdr-row clip-header' },
      enumMenu(
        'clip-view',
        [
          { value: 'CLIP', label: 'Clip', icon: 'clip_editor', description: 'Show editing clip preview' },
          { value: 'GRAPH', label: 'Graph', icon: 'graph', description: 'Show graph view for active element' },
          { value: 'DOPESHEET', label: 'Dope Sheet', icon: 'action', description: 'Dope Sheet view for tracking data' },
        ],
        this.view,
        (v) => this.setView(v as ClipView),
        { iconOnly: true, tip: 'View\nType of the clip editor view', title: 'View' },
      ),
      this.view === 'CLIP'
        ? enumMenu(
            'clip-mode',
            [
              { value: 'TRACKING', label: 'Tracking', icon: 'anim_data', description: 'Show tracking and solving tools' },
              { value: 'MASK', label: 'Mask', icon: 'mod_mask', description: 'Show mask editing tools' },
            ],
            this.mode,
            (v) => this.setMode(v as 'TRACKING'),
            { tip: 'Mode\nEditing context being displayed (Tab)' },
          )
        : null,
      menu('View', () => viewMenu(this)),
      this.view === 'CLIP' && this.mode === 'MASK'
        ? [menu('Select', () => maskSelectMenu()), menu('Add', () => maskAddMenu()), menu('Mask', () => maskMenu())]
        : [this.view === 'GRAPH' ? menu('Select', () => graphSelectMenu()) : this.view !== 'DOPESHEET' ? menu('Select', () => selectMenu()) : null, this.view === 'CLIP' ? [menu('Clip', () => clipMenu()), menu('Track', () => trackMenu()), menu('Reconstruction', () => reconstructionMenu())] : null],
      h('div', { class: 'hdr-spacer' }),
      c && this.view === 'CLIP' && this.mode !== 'MASK' && solveErrorText(c) ? h('span', { class: 'clip-header-error', 'data-tip': 'Average reprojection error of the solution' }, solveErrorText(c)) : null,
      this.view === 'CLIP' && this.mode === 'MASK' ? [maskBrowse(this), maskProportionalHeader()] : null,
      h(
        'div',
        { class: 'clip-browse' },
        h(
          'button',
          {
            class: 'hdr-icondrop',
            'data-tip': 'Browse Movie Clip to be linked',
            onpointerdown: (e: PointerEvent) => {
              e.preventDefault();
              openMenu(
                clips.length ? clips.map((x) => ({ label: x.name, icon: 'clip_editor', active: x.id === this.clipId, action: () => this.setClip(x.id) })) : [{ label: 'No movie clips', disabled: true }],
                e.currentTarget as HTMLElement,
              );
            },
          },
          icon('clip_editor'),
          icon('down_arrow_hlt', 'tiny'),
        ),
        c
          ? [
              textField(`clip-name-${c.id}`, c.name, (v) => {
                if (!v || v === c.name) return;
                c.name = v;
                app.pushUndo('Rename Movie Clip');
                app.changed('doc');
              }),
              h('button', { class: 'hdr-toggle', 'data-tip': 'Unlink Data-Block\nStop showing this clip in the editor', onclick: () => this.setClip(null) }, icon('x')),
            ]
          : h('button', { class: 'btn clip-open', onclick: () => app.run('clip.open', {}, { area: this.area }) }, icon('file_folder'), 'Open'),
      ),
      this.view === 'DOPESHEET'
        ? enumMenu(
            'clip-ds-sort',
            [
              { value: 'NAME', label: 'Name', description: 'Sort channels by their names' },
              { value: 'LONGEST', label: 'Longest', description: 'Sort channels by longest tracked segment' },
              { value: 'TOTAL', label: 'Total', description: 'Sort channels by overall amount of tracked segments' },
              { value: 'AVERAGE_ERROR', label: 'Average Error', description: 'Sort channels by the average reprojection error of their tracks after a solve' },
              { value: 'START', label: 'Start Frame', description: 'Sort channels by the first frame they are tracked on' },
              { value: 'END', label: 'End Frame', description: 'Sort channels by the last frame they are tracked on' },
            ],
            this.dopesheetSort,
            (v) => ((this.dopesheetSort = v as 'NAME'), this.draw(), this.area.drawHeader()),
            { tip: 'Sort Method\nMethod to be used to sort channels in dopesheet view' },
          )
        : null,
      this.view !== 'CLIP' ? this.trackingButtons() : null,
      this.view !== 'CLIP'
        ? h(
            'div',
            { class: 'hdr-group', key: 'clip-graph-filter' },
            h('button', { class: { 'hdr-toggle': true, on: this.graphOnlySelected }, 'data-tip': 'Only Show Selected\nShow selected tracks only', onclick: () => ((this.graphOnlySelected = !this.graphOnlySelected), this.draw(), this.area.drawHeader()) }, icon('restrict_select_off')),
            h('button', { class: { 'hdr-toggle': true, on: this.showHiddenTracks }, 'data-tip': 'Show Hidden\nInclude hidden tracks', onclick: () => ((this.showHiddenTracks = !this.showHiddenTracks), this.draw(), this.area.drawHeader()) }, icon(this.showHiddenTracks ? 'hide_off' : 'hide_on')),
          )
        : null,
      this.view === 'GRAPH'
        ? h(
            'div',
            { class: 'hdr-group', key: 'clip-graph-show' },
            (
              [
                ['frames', 'Show Frames\nThe average reprojection error of each frame (after solving the camera)', 'clip_error_frames'],
                ['motion', 'Show Tracks Motion\nThe speed curves of the tracks', 'graph'],
                ['error', 'Show Tracks Error\nThe reprojection error of the tracks over time (after solving the camera)', 'clip_error_tracks'],
              ] as const
            ).map(([k, tip, ic]) => h('button', { key: k, class: { 'hdr-toggle': true, on: this.graphShow[k] }, 'data-tip': tip, onclick: () => ((this.graphShow[k] = !this.graphShow[k]), this.draw(), this.area.drawHeader()) }, icon(ic))),
          )
        : null,
      this.view === 'DOPESHEET' ? h('button', { class: { 'hdr-toggle': true, on: this.dopesheetInvert }, 'data-tip': 'Invert Dopesheet Sort\nInvert sort order of dopesheet channels', onclick: () => ((this.dopesheetInvert = !this.dopesheetInvert), this.draw(), this.area.drawHeader()) }, icon('sort')) : null,
      this.view === 'CLIP'
        ? h('button', { class: { 'hdr-toggle': true, on: this.lockSelection }, 'data-tip': 'Lock to Selection (L)\nLock viewport to selected markers during playback', onclick: () => app.run('clip.lock_selection_toggle', {}, { area: this.area }) }, icon(this.lockSelection ? 'locked' : 'unlocked'))
        : null,
      this.view === 'CLIP' ? h('button', { class: { 'hdr-toggle': true, on: this.overlays.show_overlays !== false }, 'data-tip': 'Show Overlays (Shift Alt Z)', onclick: () => this.toggleOverlays() }, icon('overlay')) : null,
      this.view === 'CLIP'
        ? h(
            'button',
            {
              class: 'hdr-icondrop clip-overlays',
              'data-tip': 'Overlays\nMarker display, guides and clip display settings',
              onpointerdown: (e: PointerEvent) => {
                e.preventDefault();
                openMenu(overlayMenu(this), e.currentTarget as HTMLElement, { title: 'Overlays' });
              },
            },
            icon('down_arrow_hlt', 'tiny'),
          )
        : null,
    );
  }

  redrawHeader() {
    this.area.drawHeader();
  }

  // 2D annotations (kept on the movie clip)
  annToScreen(u: number, v: number): [number, number] {
    const [W, H] = this.frameSize();
    return this.toScreen(u * W, (1 - v) * H);
  }
  annFromClient(clientX: number, clientY: number): [number, number] {
    const q = this.local({ clientX, clientY });
    const [W, H] = this.frameSize();
    const [x, y] = this.toImage(q.x, q.y);
    return [x / W, 1 - y / H];
  }
  annotationOwner(): Annotation2DOwner | null {
    return this.view === 'CLIP' ? ((this.clip as unknown as Annotation2DOwner | null) ?? null) : null;
  }

  setMode(m: 'TRACKING' | 'MASK') {
    if (m === this.mode) return;
    this.mode = m;
    // a mask to edit: the only one, or a new one is offered in the header
    if (m === 'MASK' && !hostMask(this)) {
      const ids = Object.keys(maskTable(app.doc));
      if (ids.length) this.maskId = ids[0];
    }
    this.redrawAll();
    app.changed('ui');
  }

  setView(v: ClipView) {
    if (v === this.view) return;
    this.view = v;
    this.v2Fitted = false;
    this.redrawAll();
  }

  // ---------------------------------------------------------------------------
  // toolbar + sidebar

  drawUI() {
    if (!this.el.isConnected) return;
    const children: Child[] = [];
    const mask = this.view === 'CLIP' && this.mode === 'MASK';
    if (this.view === 'CLIP' && this.showToolbar) children.push(mask ? maskToolbar(this) : drawToolbar(this));
    if (this.view === 'CLIP' && this.showSidebar) children.push(mask ? h('div', { key: 'sidebar', class: 'clip-sidebar' }, h('div', { class: 'sb-body' }, maskSidebar(this)), h('div', { class: 'sb-tabs' }, h('button', { class: 'sb-tab on' }, 'Mask'))) : drawSidebar(this));
    // Adjust Last Operation for clip and mask operators (beside the toolbar)
    const last = app.lastOp;
    if (this.view === 'CLIP' && last && (last.idname.startsWith('clip.') || last.idname.startsWith('mask.'))) {
      const panel = lastOpPanel(this);
      if (panel) children.push(h('div', { key: 'redo', class: 'clip-redo', style: { left: `${this.showToolbar ? 236 : 6}px` } }, panel));
    }
    if (this.view === 'CLIP') children.push(navGizmo2D(this, this.showSidebar ? 290 : 0, this.showGizmo));
    patch(this.ui, children);
    drawPatternPreviews(this);
  }

  /** Pan the clip view by screen pixels. */
  panBy(dx: number, dy: number) {
    this.offX += dx / this.zoom;
    this.offY += dy / this.zoom;
    this.fitted = true;
    this.draw();
  }

  frameAllView() {
    if (this.view === 'GRAPH') frameGraphAll(this);
    else if (this.view === 'DOPESHEET') frameDopesheetAll(this);
    else this.frameAll(true);
    this.draw();
  }

  // ---------------------------------------------------------------------------
  // Editor

  update(kinds: Set<ChangeKind>) {
    if (this.clipId && !clipTable(app.doc)[this.clipId]) this.clipId = null;
    if (!this.clipId) {
      const first = app.doc.scene.active_clip ?? Object.keys(clipTable(app.doc))[0];
      if (first && clipTable(app.doc)[first]) this.clipId = first;
    }
    if (this.lockSelection && (kinds.has('frame') || kinds.has('doc'))) this.followSelection();
    if (this.lockTimeCursor && this.view !== 'CLIP' && kinds.has('frame')) this.v2.centerOnFrame(app.doc.scene.frame_current);
    if (kinds.has('doc') || kinds.has('ui') || kinds.has('frame') || kinds.has('select')) {
      this.draw();
      if (!kinds.has('frame') || kinds.size > 1 || this.showSidebar) this.drawUI();
    }
  }

  /** keep the selected markers at the same screen position (Lock to Selection) */
  private followSelection() {
    const c = this.clip;
    if (!c) return;
    let sx = 0,
      sy = 0,
      n = 0;
    for (const t of this.tracks())
      if (t.select) {
        const m = enabledMarkerAt(t, this.clipFrame);
        if (!m) continue;
        sx += m.co[0] * c.size[0];
        sy += (1 - m.co[1]) * c.size[1];
        n++;
      }
    if (!n) return;
    this.offX = c.size[0] / 2 - sx / n;
    this.offY = c.size[1] / 2 - sy / n;
  }

  resize() {
    this.draw();
  }

  serialize() {
    return { clip: this.clipId, view: this.view, zoom: this.zoom, off: [this.offX, this.offY], toolbar: this.showToolbar, sidebar: this.showSidebar, sidebarTab: this.sidebarTab, overlays: this.overlays, lock: this.lockSelection, lockTime: this.lockTimeCursor, onlySelected: this.graphOnlySelected, showHidden: this.showHiddenTracks, mode: this.mode, mask: this.maskId, cursor: this.cursor, pivot: this.pivot, proxy: this.proxyRenderSize };
  }

  dispose() {
    this.ro.disconnect();
    if (lastClipEditor === this) lastClipEditor = null;
  }
}

function pointInQuad(x: number, y: number, q: [number, number][]) {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const [xi, yi] = q[i],
      [xj, yj] = q[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------
// menus (only operators that exist are listed)

const sc = (op: string, props?: Record<string, unknown>) => shortcutLabel(op, props) || undefined;
const opItem = (label: string, op: string, props?: Record<string, unknown>, extra: Partial<MenuItem> = {}): MenuItem => ({ label, op, props, shortcut: sc(op, props), ...extra });

function viewMenu(ed: ClipEditor): MenuItem[] {
  const items: MenuItem[] = [];
  if (ed.view === 'CLIP') {
    items.push(
      { label: 'Toolbar', checked: ed.showToolbar, shortcut: 'T', action: () => ed.toggleToolbar() },
      { label: 'Sidebar', checked: ed.showSidebar, shortcut: 'N', action: () => ed.toggleSidebar() },
      { separator: true },
      opItem('Frame All', 'clip.view_all'),
      opItem('Frame All Fit', 'clip.view_all', { fit_view: true }),
      opItem('Frame Selected', 'clip.view_selected'),
      opItem('Center View to Cursor', 'clip.view_center_cursor'),
      { label: 'Zoom', submenu: () => [opItem('Zoom In', 'clip.view_zoom_in'), opItem('Zoom Out', 'clip.view_zoom_out'), { separator: true }, ...[8, 4, 2, 1, 0.5, 0.25, 0.125].map((r) => opItem(`Zoom ${r >= 1 ? `${r}:1` : `1:${1 / r}`}`, 'clip.view_zoom_ratio', { ratio: r }))] },
      { separator: true },
      { label: 'Lock to Selection', checked: ed.lockSelection, shortcut: 'L', op: 'clip.lock_selection_toggle' },
    );
  } else {
    items.push(
      { label: 'Frame All', shortcut: 'Home', action: () => ed.frameAllView() },
      { label: 'Center View to Current Frame', shortcut: 'Numpad 0', action: () => (ed.v2.centerOnFrame(app.doc.scene.frame_current), ed.draw()) },
      { label: 'Lock Time Cursor', checked: ed.lockTimeCursor, shortcut: 'L', description: 'Keep the current frame in the middle of the view while it changes', action: () => ed.toggleLockTime() },
    );
    if (ed.view === 'GRAPH')
      items.push(
        { separator: true },
        { label: 'Show Motion', checked: ed.graphShow.motion, keepOpen: true, action: () => ((ed.graphShow.motion = !ed.graphShow.motion), ed.draw()) },
        { label: 'Show X Speed', checked: ed.graphShow.speed_x, keepOpen: true, action: () => ((ed.graphShow.speed_x = !ed.graphShow.speed_x), ed.draw()) },
        { label: 'Show Y Speed', checked: ed.graphShow.speed_y, keepOpen: true, action: () => ((ed.graphShow.speed_y = !ed.graphShow.speed_y), ed.draw()) },
      );
  }
  items.push({ separator: true }, { label: 'Area', submenu: () => ed.area.areaMenu() });
  return items;
}

function selectMenu(): MenuItem[] {
  return [
    opItem('All', 'clip.select_all', { action: 'SELECT' }),
    opItem('None', 'clip.select_all', { action: 'DESELECT' }),
    opItem('Inverse', 'clip.select_all', { action: 'INVERT' }),
    { separator: true },
    opItem('Box Select', 'clip.select_box'),
    opItem('Circle Select', 'clip.select_circle'),
    {
      label: 'Lasso Select',
      submenu: () =>
        (
          [
            ['SET', 'Set'],
            ['ADD', 'Extend'],
            ['SUB', 'Subtract'],
          ] as const
        ).map(([mode, l]) => opItem(l, 'clip.select_lasso', { mode })),
    },
    { separator: true },
    {
      label: 'Select Grouped',
      submenu: () =>
        (
          [
            ['KEYFRAMED', 'Keyframed Tracks'],
            ['ESTIMATED', 'Estimated Tracks'],
            ['TRACKED', 'Tracked Tracks'],
            ['LOCKED', 'Locked Tracks'],
            ['DISABLED', 'Disabled Tracks'],
            ['COLOR', 'Tracks with Same Color'],
            ['FAILED', 'Failed Tracks'],
          ] as const
        ).map(([g, l]) => opItem(l, 'clip.select_grouped', { group: g })),
    },
    { separator: true },
    opItem('Stabilization Tracks', 'clip.stabilize_2d_select'),
    opItem('Stabilization Rotation Tracks', 'clip.stabilize_2d_rotation_select'),
  ];
}

function graphSelectMenu(): MenuItem[] {
  return [
    opItem('All', 'clip.graph_select_all_markers', { action: 'SELECT' }),
    opItem('None', 'clip.graph_select_all_markers', { action: 'DESELECT' }),
    opItem('Invert', 'clip.graph_select_all_markers', { action: 'INVERT' }),
    { separator: true },
    opItem('Box Select', 'clip.graph_select_box'),
    { separator: true },
    opItem('Delete Knots', 'clip.graph_delete_knot'),
    opItem('Delete Curve', 'clip.graph_delete_curve'),
    opItem('Toggle Disabled Knots', 'clip.graph_disable_markers', { action: 'TOGGLE' }),
  ];
}

function clipMenu(): MenuItem[] {
  return [
    opItem('Open…', 'clip.open', undefined, { icon: 'file_folder' }),
    { separator: true },
    opItem('Set Scene Frames', 'clip.set_scene_frames'),
    opItem('Set Active Clip', 'clip.set_active_clip'),
    opItem('Prefetch Frames', 'clip.prefetch'),
    opItem('Reload Clip', 'clip.reload'),
    { label: 'Proxy', submenu: () => [opItem('Rebuild Proxy', 'clip.rebuild_proxy'), opItem('Delete Proxy', 'clip.delete_proxy')] },
    { separator: true },
    opItem('Export Stabilized Footage…', 'clip.export_stabilized_footage'),
    opItem('Export Stabilization Data…', 'clip.export_stabilization_data'),
  ];
}

function trackMenu(): MenuItem[] {
  return [
    { label: 'Transform', submenu: () => [opItem('Move', 'clip.transform', { mode: 'TRANSLATE' }), opItem('Rotate', 'clip.transform', { mode: 'ROTATE' }), opItem('Scale', 'clip.transform', { mode: 'RESIZE' })] },
    {
      label: 'Track Motion',
      submenu: () => [
        opItem('Backwards', 'clip.track_markers', { backwards: true, sequence: true }),
        opItem('Frame Backwards', 'clip.track_markers', { backwards: true, sequence: false }),
        opItem('Forwards', 'clip.track_markers', { backwards: false, sequence: true }),
        opItem('Frame Forwards', 'clip.track_markers', { backwards: false, sequence: false }),
      ],
    },
    {
      label: 'Clear',
      submenu: () => [
        opItem('Before', 'clip.clear_track_path', { action: 'UPTO', clear_active: false }),
        opItem('After', 'clip.clear_track_path', { action: 'REMAINED', clear_active: false }),
        opItem('Track Path', 'clip.clear_track_path', { action: 'ALL', clear_active: false }),
        { separator: true },
        opItem('Solution', 'clip.clear_solution'),
      ],
    },
    { label: 'Refine', submenu: () => [opItem('Backwards', 'clip.refine_markers', { backwards: true }), opItem('Forwards', 'clip.refine_markers', { backwards: false })] },
    { label: 'Clean Up', submenu: () => [opItem('Clean Tracks', 'clip.clean_tracks'), opItem('Filter Tracks', 'clip.filter_tracks')] },
    { separator: true },
    opItem('Add Marker', 'clip.add_marker_at_click'),
    opItem('Detect Features', 'clip.detect_features'),
    { separator: true },
    opItem('Create Plane Track', 'clip.create_plane_track'),
    opItem('New Image from Plane Marker', 'clip.new_image_from_plane_marker'),
    opItem('Update Image from Plane Marker', 'clip.update_image_from_plane_marker'),
    { separator: true },
    opItem('Join Tracks', 'clip.join_tracks'),
    opItem('Average Tracks', 'clip.average_tracks'),
    { separator: true },
    opItem('Copy Tracks', 'clip.copy_tracks'),
    opItem('Paste Tracks', 'clip.paste_tracks'),
    { separator: true },
    opItem('Copy Settings to Defaults', 'clip.track_settings_as_default'),
    opItem('Apply Default Settings', 'clip.track_settings_to_track'),
    { separator: true },
    { label: 'Animation', submenu: () => [opItem('Insert Keyframe', 'clip.keyframe_insert'), opItem('Delete Keyframe', 'clip.keyframe_delete')] },
    { separator: true },
    { label: 'Show/Hide', submenu: () => [opItem('Show Hidden', 'clip.hide_tracks_clear'), opItem('Hide Selected', 'clip.hide_tracks', { unselected: false }), opItem('Hide Unselected', 'clip.hide_tracks', { unselected: true })] },
    { separator: true },
    opItem('Delete Track', 'clip.delete_track'),
    opItem('Delete Marker', 'clip.delete_marker'),
  ];
}

/** The Distance setting of the shown clip (used by Set Scale / Apply Solution Scale). */
export function sceneDistance(): number {
  return currentClipEditor()?.clip?.tracking.settings.distance ?? 1;
}

function reconstructionMenu(): MenuItem[] {
  return [
    opItem('Set Origin', 'clip.set_origin'),
    opItem('Set Floor', 'clip.set_plane', { plane: 'FLOOR' }),
    opItem('Set Wall', 'clip.set_plane', { plane: 'WALL' }),
    opItem('Set X Axis', 'clip.set_axis', { axis: 'X' }),
    opItem('Set Y Axis', 'clip.set_axis', { axis: 'Y' }),
    opItem('Set Scale', 'clip.set_scale', { distance: sceneDistance() }),
    opItem('Apply Solution Scale', 'clip.apply_solution_scale', { distance: sceneDistance() }),
    { separator: true },
    opItem('Link Empty to Track', 'clip.track_to_empty'),
    opItem('3D Markers to Mesh', 'clip.bundles_to_mesh'),
  ];
}

export function contextMenu(): MenuItem[] {
  return [
    opItem('Apply Default Settings', 'clip.track_settings_to_track'),
    opItem('Copy Settings to Defaults', 'clip.track_settings_as_default'),
    opItem('Copy Color', 'clip.track_copy_color'),
    { separator: true },
    opItem('Copy Tracks', 'clip.copy_tracks'),
    opItem('Paste Tracks', 'clip.paste_tracks'),
    { separator: true },
    opItem('Disable Markers', 'clip.disable_markers', { action: 'DISABLE' }),
    opItem('Enable Markers', 'clip.disable_markers', { action: 'ENABLE' }),
    { separator: true },
    opItem('Hide Tracks', 'clip.hide_tracks', { unselected: false }),
    opItem('Show Tracks', 'clip.hide_tracks_clear'),
    { separator: true },
    opItem('Lock Tracks', 'clip.lock_tracks', { action: 'LOCK' }),
    opItem('Unlock Tracks', 'clip.lock_tracks', { action: 'UNLOCK' }),
    { separator: true },
    opItem('Join Tracks', 'clip.join_tracks'),
    opItem('Average Tracks', 'clip.average_tracks'),
    { separator: true },
    opItem('Delete Track', 'clip.delete_track'),
  ];
}

function overlayMenu(ed: ClipEditor): MenuItem[] {
  const ov = ed.overlays;
  const tog = (label: string, key: keyof ClipOverlays, shortcut?: string): MenuItem => ({
    label,
    checked: !!ov[key],
    keepOpen: true,
    shortcut,
    action: () => {
      (ov as unknown as Record<string, unknown>)[key] = !ov[key];
      ed.draw();
      ed.drawUI();
    },
  });
  // options that are on unless switched off
  const togOn = (label: string, key: keyof ClipOverlays): MenuItem => ({
    label,
    checked: ov[key] !== false,
    keepOpen: true,
    action: () => {
      (ov as unknown as Record<string, unknown>)[key] = ov[key] === false;
      ed.draw();
      ed.drawUI();
    },
  });
  const maskModes: [NonNullable<ClipOverlays['mask_overlay_mode']>, string][] = [
    ['NONE', 'None'],
    ['COMBINED', 'Combined (darken outside)'],
    ['ALPHACHANNEL', 'Alpha Channel (matte only)'],
  ];
  if (ed.mode === 'MASK')
    return [
      { heading: 'Mask Display' },
      { label: 'Spline', checked: ov.show_mask_spline !== false, keepOpen: true, action: () => ((ov.show_mask_spline = ov.show_mask_spline === false), ed.draw()) },
      {
        label: 'Spline Display',
        submenu: () => (['OUTLINE', 'DASH', 'BLACK', 'WHITE'] as const).map((v) => ({ label: v[0] + v.slice(1).toLowerCase(), active: (ov.mask_display_type ?? 'OUTLINE') === v, action: () => ((ov.mask_display_type = v), ed.draw()) })),
      },
      { label: 'Overlay', submenu: () => maskModes.map(([v, l]) => ({ label: l, active: (ov.mask_overlay_mode ?? 'NONE') === v, action: () => ((ov.mask_overlay_mode = v), ed.draw()) })) },
      { label: 'Blending Factor', submenu: () => [0.25, 0.5, 0.75, 1].map((v) => ({ label: `${Math.round(v * 100)}%`, active: (ov.blend_factor ?? 0.5) === v, action: () => ((ov.blend_factor = v), ed.draw()) })) },
      { separator: true },
      { heading: 'Clip Display' },
      tog('Mute', 'use_mute_footage', 'Ctrl H'),
    ];
  return [
    { heading: 'Marker Display' },
    tog('Pattern', 'show_marker_pattern'),
    tog('Search', 'show_marker_search', 'Alt S'),
    tog('Path', 'show_track_path'),
    {
      label: 'Path Length',
      submenu: () => [5, 10, 20, 40, 80].map((n) => ({ label: `${n} frames`, active: ov.path_length === n, action: () => ((ov.path_length = n), ed.draw()) })),
    },
    tog('Disabled', 'show_disabled', 'Alt D'),
    tog('Info', 'show_info'),
    tog('Names', 'show_names'),
    togOn('3D Markers', 'show_bundles'),
    tog('Display Thin', 'show_tiny_markers'),
    { separator: true },
    { heading: 'Guides' },
    tog('Distortion Grid', 'show_grid'),
    togOn('Cursor', 'show_cursor'),
    togOn('Annotations', 'show_annotation'),
    { separator: true },
    { heading: 'Clip Display' },
    togOn('Red Channel', 'show_red_channel'),
    togOn('Green Channel', 'show_green_channel'),
    togOn('Blue Channel', 'show_blue_channel'),
    tog('Black and White', 'use_grayscale_preview'),
    tog('Mute', 'use_mute_footage', 'Ctrl H'),
    { separator: true },
    tog('Show Stable', 'show_stable'),
    tog('Render Undistorted', 'render_undistorted'),
    tog('Cache Line', 'show_cache'),
  ];
}

registerEditor({
  id: 'CLIP_EDITOR',
  label: 'Movie Clip Editor',
  icon: 'clip_editor',
  group: 'General',
  create: (area, state) => new ClipEditor(area, state),
});


addKeys('Clip', [{ key: 'Z', shift: true, alt: true, when: () => currentClipEditor()?.view === 'CLIP', action: () => currentClipEditor()?.toggleOverlays() }]);
addKeys('Clip Graph Editor', [{ key: 'L', action: () => currentClipEditor()?.toggleLockTime() }]);
addKeys('Clip Dopesheet Editor', [{ key: 'L', action: () => currentClipEditor()?.toggleLockTime() }]);
