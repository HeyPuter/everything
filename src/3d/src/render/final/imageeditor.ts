// Image Editor: views image data-blocks and the Render Result (with passes), zoom/pan,
// channel display, pixel sampling, image data-block management and saving.
import { canvasGrey } from '../../ui/canvastheme';
import { h, patch, type Child } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app, type ChangeKind } from '../../app/app';
import { registerEditor, type Area, type Editor } from '../../ui/screen';
import { openMenu, openPopover, type MenuItem } from '../../ui/menu';
import { panel, numberField, enumMenu, enumRow, colorSwatch, textField, button, checkbox, colorHex, srgbToLinear } from '../../ui/widgets';
import { splitRow } from '../../ui/props';
import { imageCanvas, imageTexture, touchImage, generatedPixels } from '../images';
import { lastImage } from '../../ops/data';
import type { ImageData as Img } from '../../data/types';
import { renderResult, passToRGBA8, samplePixel, encodeRGBA8, canvasBytes, download, toBW, EXT, virtualImages, onVirtualImageChange, PASS_ORDER, passLabel, type PassName, type ChannelMode, type FileFormat, type RenderResult } from './result';
import { stereoResult } from './stereo';
import { stereoDisplay } from './stereoops';
import { outputView } from './outputview';
import { activeLayerIndex, ensureViewLayers } from '../../scenes/viewlayers';
import { isExr, resultExr, type ExrFormat } from './renderexr';

/** Formats the Save As dialog offers (OpenEXR for render results). */
type SaveFormat = FileFormat | ExrFormat;
import { renderSize } from './units';
import { LOOKS, displayPixel } from './colormanage';
import { pngWithText, pngText } from './stamp';
import { num } from '../../ui/props';
import { modifiedImages, type View2D } from './imageops';
import { scopesPanel } from './scopes';
import { lastOpPanel } from '../../ui/redo';
import { uiList } from '../../editors/properties/uilist';
import { isTiled, tileName, tileView, atlasLayout, tileCell } from '../udim';
import { makeTiled, makeSingle, openImageFiles, saveTiles } from './udimops';
import { drawPaintOverlay, imagePaintRightDown, imagePaintStroke, paintBrush } from './imagepaint';
import { paintImage } from '../../paint/tpaint';
import { BRUSH_LISTS } from '../../paint/brushes';
import { imagePaintKey, paintToolPanels, toolHeaderSettings } from '../../paint/ui';
import { activeTools } from '../../app/prefs';
import { formatTime } from './units';
import type { ViewSettings } from './colormanage';
import { drawMask, drawMaskMatte, hostMask, type MaskHost, type MaskDisplayType } from '../../mask/clipmask';
import { maskSelectMenu, maskAddMenu, maskMenu, maskBrowse, maskSidebar, maskProportionalHeader } from '../../mask/maskui';
import { maskTable } from '../../mask/types';
import './imageextra';
import { imageMedia, mediaReady, mediaSource, mediaFrameIndex, openMediaFiles } from './imagemedia';
import { pickFiles } from '../../sequencer/add';
import { navGizmo2D } from './navgizmo2d';
import { annotatePointerDown, annotateKeyHeld, annotateModeOf, annotateToolSlot, annotationsPanel, drawAnnotations2D, isAnnotateTool, type AnnotateTool, type Annotate2DHost, type Annotation2DOwner } from '../../mask/annotate2d';
import { imageMaskToolbar, imageMaskPointerDown, imageMaskToolSettings, draw2DCursor, placeCursor, drawMaskStrip, maskStripRect, maskStripFrame, IMAGE_MASK_TOOLS, type ImageMaskTool } from '../../mask/imagemask';

export const RENDER_RESULT = '__render_result__';

export interface EditorHost {
  /** redraw the editor header */
  redrawHeader(): void;
  /** maximize toggle, when hosted in a screen area */
  area?: Area;
  /** close (floating render window) */
  close?(): void;
}

const CHANNELS: { value: ChannelMode; label: string; icon: string }[] = [
  { value: 'COLOR_ALPHA', label: 'Color & Alpha', icon: 'image' },
  { value: 'COLOR', label: 'Color', icon: 'shading_solid' },
  { value: 'ALPHA', label: 'Alpha', icon: 'shading_wire' },
  { value: 'Z', label: 'Z-Buffer', icon: 'view_camera' },
];

const RATIOS: [string, number][] = [
  ['1:8', 1 / 8],
  ['1:4', 1 / 4],
  ['1:2', 1 / 2],
  ['1:1', 1],
  ['2:1', 2],
  ['4:1', 4],
  ['8:1', 8],
];

/**
 * Render Result layer shown: the post-processed (composited) image, the raw view layer passes,
 * or one of several rendered view layers (`L:<scene>/<layer>`).
 */
export type ResultLayer = 'COMPOSITE' | 'VIEW_LAYER' | `L:${string}`;
const layerKey = (l: { scene: string; name: string }): ResultLayer => `L:${l.scene}/${l.name}`;
function resultLayer(r: RenderResult | null, layer: ResultLayer): RenderResult | null {
  if (r?.layers && layer.startsWith('L:')) {
    const l = r.layers.find((x) => layerKey(x) === layer);
    if (l) return { ...r, passes: l.passes };
  }
  if (!r?.viewLayer) return r;
  return layer === 'VIEW_LAYER' ? { ...r, passes: r.viewLayer } : { ...r, passes: { Combined: r.passes.Combined } };
}

const stereoCache = new WeakMap<RenderResult, { key: string; res: RenderResult }>();

/** View of a multi-view render shown: a view by name, or 'STEREO' for the combined eyes. */
function resultView(r: RenderResult | null, view: string): RenderResult | null {
  if (!r?.views?.length) return r;
  if (view === 'STEREO') {
    const key = `${r.version}|${JSON.stringify(stereoDisplay)}`;
    const c = stereoCache.get(r);
    if (c?.key === key) return c.res;
    const res = stereoResult(r, stereoDisplay);
    if (!res) return r;
    stereoCache.set(r, { key, res });
    return res;
  }
  const v = r.views.find((x) => x.name === view) ?? r.views[0];
  return v.passes === r.passes ? r : { ...r, passes: v.passes, viewLayer: v.viewLayer };
}

/** Entries of the view menu of a multi-view render result. */
function viewItems(r: RenderResult): { value: string; label: string; description?: string }[] {
  const out = r.views!.map((v) => ({ value: v.name, label: v.name === 'left' ? 'Left' : v.name === 'right' ? 'Right' : v.name, description: 'The image of this view' }));
  if (r.views!.length === 2 && r.stereo) out.push({ value: 'STEREO', label: 'Stereo 3D', description: 'Both eyes combined as set in Window ▸ Set Stereo 3D' });
  return out;
}

/** Entries of the layer menu of a render result. */
function layerItems(r: RenderResult): { value: string; label: string; description?: string }[] {
  const out: { value: string; label: string; description?: string }[] = [];
  if (r.viewLayer) out.push({ value: 'COMPOSITE', label: 'Composite', description: 'The post-processed (composited) image' });
  if (r.layers?.length) {
    const scenes = new Set(r.layers.map((l) => l.scene));
    for (const l of r.layers) out.push({ value: layerKey(l), label: scenes.size > 1 ? `${l.scene} ▸ ${l.name}` : l.name, description: 'The render passes of this view layer' });
  } else if (r.viewLayer) out.push({ value: 'VIEW_LAYER', label: 'View Layer', description: 'The render passes of the view layer' });
  return out;
}

function sceneView(r: RenderResult | null): ViewSettings {
  if (r?.view) return r.view;
  return app.doc.scene.render;
}

export class ImageEditor implements Editor, View2D, MaskHost, Annotate2DHost {
  el: HTMLElement;
  get keymaps() {
    return this.maskEditing() ? ['Mask Editing', 'Image Generic', 'Image', 'Frames', 'Window', 'Screen'] : ['Image Generic', 'Image', 'Frames', 'Window', 'Screen'];
  }
  imageId: string | null = null;
  pass: PassName = 'Combined';
  channel: ChannelMode = 'COLOR_ALPHA';
  layer: ResultLayer = 'COMPOSITE';
  /** view of a multi-view render ('' = the first, 'STEREO' = combined eyes) */
  view = '';
  zoom = 1;
  offX = 0;
  offY = 0;
  fitted = false;
  showSidebar = false;
  sidebarTab = 'Image';
  /** show the render info line over the image */
  showMetadata = true;
  /** View, Paint or Mask; unset follows the object mode (Paint while in Texture Paint mode) */
  uiMode: 'VIEW' | 'PAINT' | 'MASK' | null = null;
  /** Mask mode: the edited mask, active tool, 2D cursor (frame space 0..1, y up) and pivot */
  maskId: string | null = null;
  maskTool: ImageMaskTool = 'select_box';
  cursor: [number, number] = [0.5, 0.5];
  pivot: 'MEDIAN_POINT' | 'BOUNDING_BOX_CENTER' | 'CURSOR' = 'BOUNDING_BOX_CENTER';
  maskCircleRadius = 25;
  maskPrimitiveSize = 0.2;
  shapeOverlay: MaskHost['shapeOverlay'] = null;
  /** navigation buttons (Ctrl `) */
  showGizmo = true;
  /** View mode tool: Sample or one of the Annotate tools */
  viewTool: 'sample' | AnnotateTool = 'sample';
  private lastAnnotate: AnnotateTool = 'annotate';
  /** Overlays popover: master switch and the mask display */
  overlays = { show_overlays: true, show_mask_spline: true, mask_display_type: 'OUTLINE' as MaskDisplayType, mask_overlay_mode: 'NONE' as 'NONE' | 'COMBINED' | 'ALPHACHANNEL', blend_factor: 0.5 };
  /** a right-drag in Paint mode was used by the brush (no context menu on release) */
  private skipContextMenu = false;
  showToolbar = true;
  /** View mode: show the Sample tool's settings over the image */
  showToolSettings = true;
  /** width of the square averaged when sampling pixels */
  sampleSize = 1;
  private hover: { x: number; y: number } | null = null;
  private cursorPlaced = false;
  canvas: HTMLCanvasElement;
  private ui: HTMLElement;
  private cache: { key: string; canvas: HTMLCanvasElement } | null = null;
  private sample: { x: number; y: number } | null = null;
  private awaitingOpen = false;
  private seenLastImage: string | null = lastImage;
  private unsub: () => void;
  private unsubVirtual: () => void;
  private timer = 0;
  private lastKey = '';

  constructor(
    public host: EditorHost,
    state?: unknown,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'ie-root';
    this.el.tabIndex = -1;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ie-canvas';
    this.ui = document.createElement('div');
    this.ui.className = 'ie-ui';
    this.el.append(this.canvas, this.ui);
    const st = (state ?? {}) as { toolSettings?: boolean; sampleSize?: number; render?: boolean; image?: string | null; pass?: PassName; channel?: ChannelMode; zoom?: number; off?: [number, number]; sidebar?: boolean; layer?: ResultLayer; mode?: 'VIEW' | 'PAINT' | 'MASK'; toolbar?: boolean; mask?: string | null; maskTool?: ImageMaskTool; cursor?: [number, number]; pivot?: ImageEditor['pivot']; tab?: string };
    if (st.mode === 'VIEW' || st.mode === 'PAINT' || st.mode === 'MASK') this.uiMode = st.mode;
    if (st.mask !== undefined) this.maskId = st.mask;
    if (st.maskTool && IMAGE_MASK_TOOLS.includes(st.maskTool)) this.maskTool = st.maskTool;
    if (Array.isArray(st.cursor)) this.cursor = [Number(st.cursor[0]) || 0, Number(st.cursor[1]) || 0];
    if (st.pivot) this.pivot = st.pivot;
    if (st.tab) this.sidebarTab = st.tab;
    const vt = (state as { viewTool?: string } | undefined)?.viewTool;
    if (vt && isAnnotateTool(vt)) this.viewTool = vt;
    const ov = (state as { overlays?: Partial<ImageEditor['overlays']> } | undefined)?.overlays;
    if (ov) Object.assign(this.overlays, ov);
    if (st.toolbar === false) this.showToolbar = false;
    if (st.toolSettings === false) this.showToolSettings = false;
    if (st.sampleSize) this.sampleSize = st.sampleSize;
    if (st.render) this.imageId = RENDER_RESULT;
    if (st.image !== undefined) this.imageId = st.image;
    if (st.pass) this.pass = st.pass;
    if (st.channel) this.channel = st.channel;
    if (st.zoom) {
      this.zoom = st.zoom;
      this.fitted = true;
    }
    if (st.off) [this.offX, this.offY] = st.off;
    if (st.sidebar) this.showSidebar = st.sidebar;
    if (st.layer) this.layer = st.layer;
    this.bind();
    this.unsub = renderResult.subscribe((pixels) => {
      if (this.imageId !== RENDER_RESULT || !this.el.isConnected) return;
      if (pixels) this.draw();
      this.drawUI();
    });
    this.unsubVirtual = onVirtualImageChange((id) => {
      if (this.imageId !== id || !this.el.isConnected) return;
      this.draw();
      this.drawUI();
      this.host.redrawHeader();
    });
    new ResizeObserver(() => this.draw()).observe(this.el);
    // images decode asynchronously: poll cheaply for the source becoming ready
    this.timer = window.setInterval(() => {
      if (!this.el.isConnected || this.imageId === RENDER_RESULT || !this.imageId) return;
      if (this.sourceKey() !== this.lastKey) this.draw();
    }, 300);
  }

  // ---------------------------------------------------------------------
  // data

  get image(): Img | null {
    if (!this.imageId && this.paintMode()) return paintImage(app.activeObject);
    return this.imageId && this.imageId !== RENDER_RESULT ? app.doc.images[this.imageId] ?? null : null;
  }

  /** Painting on the image (instead of viewing and sampling it). */
  paintMode(): boolean {
    if (this.host.close) return false; // the render window only views
    return this.uiMode === 'PAINT' || (this.uiMode === null && app.doc.mode === 'TEXTURE_PAINT');
  }

  /** Editing a mask over the image (Mask mode). */
  maskEditing(): boolean {
    return !this.host.close && this.uiMode === 'MASK';
  }

  setMaskMode() {
    this.setMode('MASK');
  }

  setMode(m: 'VIEW' | 'PAINT' | 'MASK') {
    this.uiMode = m;
    // a mask to edit: the only one there is
    if (m === 'MASK' && !hostMask(this)) {
      const ids = Object.keys(maskTable(app.doc));
      if (ids.length === 1) this.maskId = ids[0];
    }
    this.fitted = false;
    this.draw();
    this.drawUI();
    this.host.redrawHeader();
    app.changed('ui');
  }

  redrawHeader() {
    this.host.redrawHeader();
  }

  /** Mask frame size in pixels: the image's, or the render size without an image. */
  frameSize(): [number, number] {
    const s = this.imageSize();
    if (s) return s;
    return renderSize(app.doc.scene.render) as [number, number];
  }

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

  /** Notes are kept on the shown image. */
  annotationOwner(): Annotation2DOwner | null {
    return (this.result ? null : (this.image as unknown as Annotation2DOwner | null)) ?? null;
  }

  /** image pixel (top-left origin) → editor-local screen pixel */
  toScreen(x: number, y: number): [number, number] {
    const s = this.frameSize();
    const { w, h: hh } = this.viewSize();
    return [(x - s[0] / 2 + this.offX) * this.zoom + w / 2, (y - s[1] / 2 + this.offY) * this.zoom + hh / 2];
  }

  get result(): RenderResult | null {
    if (this.imageId === RENDER_RESULT) return resultLayer(resultView(renderResult.get(), this.view), this.layer);
    const v = this.imageId ? virtualImages.get(this.imageId) : undefined;
    return v ? v.get() : null;
  }

  /** Label of a non-data-block image (Render Result / virtual images). */
  private sourceLabel(): string | null {
    if (this.imageId === RENDER_RESULT) return 'Render Result';
    return (this.imageId && virtualImages.get(this.imageId)?.label) || null;
  }

  showRenderResult() {
    if (this.imageId !== RENDER_RESULT) {
      this.imageId = RENDER_RESULT;
      this.fitted = false;
    }
    this.draw();
    this.drawUI();
    this.host.redrawHeader();
  }

  setImage(id: string | null) {
    this.imageId = id;
    this.fitted = false;
    this.cache = null;
    this.sample = null;
    this.draw();
    this.drawUI();
    this.host.redrawHeader();
    app.changed('ui');
  }

  private passes(): PassName[] {
    const r = this.result;
    if (!r) return [];
    return [...PASS_ORDER.filter((p) => r.passes[p]), ...(Object.keys(r.passes) as PassName[]).filter((p) => p.startsWith('AOV ') || p.startsWith('Combined_'))];
  }

  private sourceKey(): string {
    const r = this.result;
    if (r) {
      const v = sceneView(r);
      return `R${this.imageId}|${this.imageId === RENDER_RESULT ? renderResult.slot : ''}|${r.version}|${this.layer}|${this.view}:${this.view === 'STEREO' ? JSON.stringify(stereoDisplay) : ''}|${this.pass}|${this.channel}|${v.view_transform}|${v.exposure}|${v.gamma}|${v.look}|${v.use_white_balance ? `${v.white_balance_temperature},${v.white_balance_tint}` : ''}|${v.use_curve_mapping ? JSON.stringify(v.curve_mapping) : ''}|${r.width}x${r.height}|${r.overlay ? 'S' : ''}`;
    }
    const img = this.image;
    if (!img) return '';
    const m = imageMedia(img);
    if (m) {
      const idx = mediaFrameIndex(m, app.doc.scene.frame_current);
      const src = mediaReady(m);
      return `M${img.id}|${idx}|${src && idx !== null && src.peek(idx) ? 1 : 0}|${this.channel}`;
    }
    const tex = imageTexture(img);
    return `I${img.id}|${img.revision ?? 0}|${tex.version}|${img.width}x${img.height}|${this.channel}|${img.generated_type}|${img.generated_color?.join(',')}`;
  }

  /** Canvas with the displayed pixels (cached per source state). */
  private source(): HTMLCanvasElement | null {
    const key = this.sourceKey();
    if (!key) return null;
    if (this.cache?.key === key) return this.cache.canvas;
    const r = this.result;
    let canvas: HTMLCanvasElement;
    if (r) {
      if (!r.passes[this.pass]) this.pass = 'Combined';
      const channel = this.channel === 'Z' && !r.passes.Depth ? 'COLOR_ALPHA' : this.channel;
      const px = passToRGBA8(r, this.pass, channel, sceneView(r), { keepAlpha: true });
      if (channel === 'COLOR') for (let i = 3; i < px.length; i += 4) px[i] = 255;
      canvas = this.cache?.canvas ?? document.createElement('canvas');
      canvas.width = r.width;
      canvas.height = r.height;
      canvas.getContext('2d')!.putImageData(new ImageData(px as Uint8ClampedArray<ArrayBuffer>, r.width, r.height), 0, 0);
    } else {
      const img = this.image!;
      const m = imageMedia(img);
      const src = m ? this.mediaFrameCanvas(img.id, m) : imageCanvas(img);
      if (!src) return null;
      if (this.channel === 'COLOR_ALPHA') canvas = src;
      else {
        canvas = document.createElement('canvas');
        canvas.width = src.width;
        canvas.height = src.height;
        const c = canvas.getContext('2d')!;
        const d = src.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, src.width, src.height);
        const p = d.data;
        for (let i = 0; i < p.length; i += 4) {
          if (this.channel === 'ALPHA') p[i] = p[i + 1] = p[i + 2] = p[i + 3];
          p[i + 3] = 255;
        }
        c.putImageData(d, 0, 0);
      }
    }
    this.cache = { key, canvas };
    return canvas;
  }

  scopeKey() {
    return this.sourceKey();
  }

  private mediaCanvas: HTMLCanvasElement | null = null;

  /** The decoded frame of a movie / sequence image for the current scene frame (decodes it when needed). */
  private mediaFrameCanvas(id: string, m: NonNullable<ReturnType<typeof imageMedia>>): HTMLCanvasElement | null {
    const src = mediaReady(m);
    const idx = mediaFrameIndex(m, app.doc.scene.frame_current);
    const c = (this.mediaCanvas ??= document.createElement('canvas'));
    if (!src) {
      void mediaSource(m)?.then(() => this.draw());
      return null;
    }
    c.width = src.width;
    c.height = src.height;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    if (idx === null) return c; // outside the frames shown: transparent
    const bmp = src.peek(idx);
    if (bmp) g.drawImage(bmp, 0, 0);
    else
      void src.get(idx).then(() => {
        if (this.imageId === id) this.draw();
      });
    return c;
  }

  /** Canvas with the pixels as displayed (for scopes). */
  displayCanvas(): HTMLCanvasElement | null {
    return this.source();
  }

  imageSize(): [number, number] | null {
    const r = this.result;
    if (r) return [r.width, r.height];
    const img = this.image;
    if (!img) return null;
    const c = imageCanvas(img);
    return [c.width, c.height];
  }

  // ---------------------------------------------------------------------
  // view

  private viewSize() {
    return { w: Math.max(1, this.el.clientWidth), h: Math.max(1, this.el.clientHeight) };
  }

  /** screen (client px relative to the editor) → image pixel coordinates (top-left origin) */
  toImage(sx: number, sy: number): [number, number] {
    const s = this.imageSize() ?? (this.maskEditing() ? this.frameSize() : [1, 1]);
    const { w, h: hh } = this.viewSize();
    return [(sx - w / 2) / this.zoom + s[0] / 2 - this.offX, (sy - hh / 2) / this.zoom + s[1] / 2 - this.offY];
  }

  /** Show the whole image: at a power-of-two zoom, or (fit) filling the view. */
  frameAll(fit = false) {
    const s = this.imageSize();
    if (!s) return;
    const { w, h: hh } = this.viewSize();
    const z = Math.min((w - 20) / s[0], (hh - 20) / s[1]);
    this.zoom = Math.max(1 / 64, Math.min(64, fit ? z : Math.pow(2, Math.floor(Math.log2(z)))));
    this.offX = this.offY = 0;
    this.fitted = true;
    this.draw();
  }

  /** Zoom so the screen rectangle (editor pixels) fills the view. */
  zoomToRect(x0: number, y0: number, x1: number, y1: number) {
    const [ax, ay] = this.toImage(x0, y0),
      [bx, by] = this.toImage(x1, y1);
    const s = this.imageSize() ?? [1, 1];
    const { w, h: hh } = this.viewSize();
    this.zoom = Math.max(1 / 64, Math.min(256, Math.min(w / Math.max(1e-3, bx - ax), hh / Math.max(1e-3, by - ay))));
    this.offX = s[0] / 2 - (ax + bx) / 2;
    this.offY = s[1] / 2 - (ay + by) / 2;
    this.fitted = true;
    this.draw();
  }

  shownImage() {
    return this.image;
  }
  showImage(id: string | null) {
    this.setImage(id);
  }
  showsRender() {
    return this.imageId === RENDER_RESULT;
  }
  newImage() {
    this.newDialog();
  }
  openImage() {
    this.open();
  }

  /** Zoom keeping the image point under (sx, sy) fixed. */
  zoomAt(factor: number, sx?: number, sy?: number) {
    const { w, h: hh } = this.viewSize();
    const px = sx ?? w / 2,
      py = sy ?? hh / 2;
    const [ix, iy] = this.toImage(px, py);
    const s = this.imageSize() ?? [1, 1];
    this.zoom = Math.max(1 / 64, Math.min(256, this.zoom * factor));
    this.offX = (px - w / 2) / this.zoom + s[0] / 2 - ix;
    this.offY = (py - hh / 2) / this.zoom + s[1] / 2 - iy;
    this.fitted = true;
    this.draw();
  }

  /** Mask mode: put the 2D cursor in the middle of the view. */
  centerCursor() {
    const [W, H] = this.frameSize();
    this.offX = W / 2 - this.cursor[0] * W;
    this.offY = H / 2 - (1 - this.cursor[1]) * H;
    this.fitted = true;
    this.draw();
  }

  /** Mask mode: put the 2D cursor at the middle of the view. */
  cursorToCenter() {
    const { w, h: hh } = this.viewSize();
    const [W, H] = this.frameSize();
    const [x, y] = this.toImage(w / 2, hh / 2);
    this.cursor = [x / W, 1 - y / H];
    this.draw();
  }

  /** Pan by screen pixels. */
  panBy(dx: number, dy: number) {
    this.offX += dx / this.zoom;
    this.offY += dy / this.zoom;
    this.fitted = true;
    this.draw();
  }

  setRatio(z: number) {
    this.zoom = z;
    this.fitted = true;
    this.draw();
  }

  // ---------------------------------------------------------------------
  // drawing

  draw() {
    const { w, h: hh } = this.viewSize();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const c = this.canvas;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hh * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hh * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${hh}px`;
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = canvasGrey(0x30);
    ctx.fillRect(0, 0, w, hh);
    this.lastKey = this.sourceKey();
    const src = this.source();
    const size = this.imageSize();
    if (!src && this.imageId === RENDER_RESULT && !this.maskEditing()) return this.drawEmptyResult(ctx, w, hh);
    if ((!src || !size) && this.maskEditing()) return this.drawMaskOverlay(ctx, true);
    if (!src || !size) return;
    if (!this.fitted) {
      this.fitted = true;
      const z = Math.min((w - 20) / size[0], (hh - 20) / size[1]);
      // start at 1:1 unless the image does not fit
      this.zoom = Math.min(1, Math.max(1 / 64, z));
      this.offX = this.offY = 0;
    }
    const x = w / 2 + (-size[0] / 2 + this.offX) * this.zoom;
    const y = hh / 2 + (-size[1] / 2 + this.offY) * this.zoom;
    const dw = size[0] * this.zoom,
      dh = size[1] * this.zoom;
    if (this.channel === 'COLOR_ALPHA') {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, dw, dh);
      ctx.clip();
      ctx.fillStyle = checker(ctx);
      ctx.fillRect(x, y, dw, dh);
      ctx.restore();
    }
    ctx.imageSmoothingEnabled = this.zoom < 1;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, x, y, dw, dh);
    const shownImg = this.result ? null : this.image;
    if (isTiled(shownImg)) this.drawTiles(ctx, shownImg, x, y, dw, dh);
    if (this.paintMode()) this.drawUVOverlay(ctx, x, y, dw, dh);
    if (this.maskEditing() && this.overlays.show_overlays) this.drawMaskOverlay(ctx, false);
    // brush circle
    if (this.paintMode() && this.hover && this.image) {
      const b = paintBrush();
      if (b) {
        ctx.strokeStyle = 'rgba(255, 255, 255,0.85)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(this.hover.x, this.hover.y, b.radius, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    if (this.paintMode()) drawPaintOverlay(ctx, (ix, iy) => [x + ix * this.zoom, y + iy * this.zoom], this.image?.id ?? null, hh, () => this.draw());
    if (this.overlays.show_overlays && !this.host.close) drawAnnotations2D(this, ctx);
    // movies and sequences: the frames shown, along the bottom
    const media = imageMedia(shownImg);
    if (media && !this.maskEditing() && !this.paintMode()) drawMaskStrip(ctx, this.mediaRange(media), this.maskStrip(), app.doc.scene.frame_current);
    // sample cross-hair
    if (this.sample) {
      const sx = x + (Math.floor(this.sample.x) + 0.5) * this.zoom,
        sy = y + (Math.floor(this.sample.y) + 0.5) * this.zoom;
      ctx.strokeStyle = 'rgba(255, 255, 255,0.8)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx - 8, sy);
      ctx.lineTo(sx + 8, sy);
      ctx.moveTo(sx, sy - 8);
      ctx.lineTo(sx, sy + 8);
      ctx.stroke();
    }
  }

  /** Mask mode: the mask (matte and splines) and the 2D cursor; without an image, an empty frame first. */
  private drawMaskOverlay(ctx: CanvasRenderingContext2D, emptyFrame: boolean) {
    if (emptyFrame) {
      if (!this.fitted) {
        this.fitted = true;
        const [W, H] = this.frameSize();
        const { w, h: hh } = this.viewSize();
        this.zoom = Math.max(1 / 64, Math.min(1, (w - 40) / W, (hh - 40) / H));
        this.offX = this.offY = 0;
      }
      const [W, H] = this.frameSize();
      const [x0, y0] = this.toScreen(0, 0),
        [x1, y1] = this.toScreen(W, H);
      ctx.fillStyle = canvasGrey(0x26);
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(x0) - 0.5, Math.round(y0) - 0.5, Math.round(x1 - x0) + 1, Math.round(y1 - y0) + 1);
    }
    if (!this.overlays.show_overlays) return;
    const m = hostMask(this);
    if (m) {
      const mode = this.overlays.mask_overlay_mode;
      drawMaskMatte(this, ctx, mode, this.overlays.blend_factor);
      drawMask(this, ctx, this.overlays.show_mask_spline, this.overlays.mask_display_type);
    }
    const [W, H] = this.frameSize();
    const [cx, cy] = this.toScreen(this.cursor[0] * W, (1 - this.cursor[1]) * H);
    draw2DCursor(ctx, cx, cy);
    if (m) drawMaskStrip(ctx, m, this.maskStrip(), app.doc.scene.frame_current);
  }

  /** Frame range of a movie / sequence image as a strip range. */
  private mediaRange(m: NonNullable<ReturnType<typeof imageMedia>>) {
    return { frame_start: m.frame_start, frame_end: m.frame_start + Math.max(1, m.frame_duration) - 1, layers: [] as { shape_keys: { frame: number }[] }[] };
  }

  /** The mask frame strip along the bottom of the view (between the toolbar and the sidebar). */
  private maskStrip() {
    const { w, h: hh } = this.viewSize();
    return maskStripRect(w, hh, this.showToolbar ? 48 : 0, this.showSidebar ? 270 : 0);
  }

  /** UDIM tiles: outline each tile's cell, label it, and mark the active one. */
  private drawTiles(ctx: CanvasRenderingContext2D, img: Img, x: number, y: number, dw: number, dh: number) {
    const { cols, rows } = atlasLayout(img);
    const cw = dw / cols,
      chh = dh / rows;
    ctx.save();
    ctx.font = `${Math.max(9, Math.min(14, cw / 8))}px ${getComputedStyle(this.el).fontFamily || 'sans-serif'}`;
    ctx.textBaseline = 'top';
    img.tiles!.forEach((t, i) => {
      const [c, r] = tileCell(t.number);
      const tx = x + c * cw,
        ty = y + (rows - 1 - r) * chh;
      const active = i === (img.active_tile_index ?? 0);
      ctx.strokeStyle = active ? 'rgba(255, 255, 255, 0.85)' : 'rgba(255, 255, 255, 0.35)';
      ctx.lineWidth = active ? 1.5 : 1;
      ctx.strokeRect(Math.round(tx) + 0.5, Math.round(ty) + 0.5, Math.round(cw) - 1, Math.round(chh) - 1);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      const label = tileName(img, i);
      const tw = ctx.measureText(label).width;
      ctx.fillRect(tx + 3, ty + 3, tw + 8, 16);
      ctx.fillStyle = '#e8e9ea';
      ctx.fillText(label, tx + 7, ty + 5);
    });
    ctx.restore();
  }

  /** Empty Render Result: a transparent frame with the output's aspect ratio and a hint. */
  private drawEmptyResult(ctx: CanvasRenderingContext2D, w: number, hh: number) {
    const [W, H] = renderSize(app.doc.scene.render);
    const k = Math.min((w * 0.62) / W, (hh * 0.62) / H);
    const dw = Math.max(8, Math.round(W * k)),
      dh = Math.max(8, Math.round(H * k));
    const x = Math.round((w - dw) / 2),
      y = Math.round((hh - dh) / 2);
    ctx.fillStyle = emptyChecker(ctx);
    ctx.save();
    ctx.translate(x, y);
    ctx.fillRect(0, 0, dw, dh);
    ctx.restore();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x - 0.5, y - 0.5, dw + 1, dh + 1);
    const font = getComputedStyle(this.el).fontFamily || 'system-ui, sans-serif';
    const lines: [string, string, number][] = [
      ['Render Result', '#d9dadc', 15],
      [`Press F12 to render the scene camera · ${W} × ${H} px`, '#9a9b9c', 12],
    ];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cy = y + dh / 2;
    lines.forEach(([text, color, size], i) => {
      ctx.font = `${i === 0 ? 600 : 400} ${size}px ${font}`;
      ctx.fillStyle = color;
      ctx.fillText(text, x + dw / 2, cy + (i === 0 ? -11 : 11), Math.max(40, dw - 16));
    });
  }

  drawUI() {
    const r = this.result;
    const info: Child[] = [];
    if (r && !this.showMetadata) {
      // info line hidden (View ▸ Show Metadata)
    } else if (r) {
      const i = r.info;
      const text = i.status ?? [`Frame:${i.frame}`, `Time:${formatTime(i.time)}`, i.engine, i.samples && i.maxSamples && i.maxSamples > 1 ? `Samples:${i.samples}` : '', i.camera ? `Camera:${i.camera}` : ''].filter(Boolean).join(' | ');
      info.push(h('div', { class: 'ie-meta', key: 'meta' }, text));
    } else if (this.imageId === RENDER_RESULT) {
      // the empty result draws its own hint
    } else if (this.imageId && virtualImages.has(this.imageId)) info.push(h('div', { class: 'ie-meta', key: 'meta' }, `${virtualImages.get(this.imageId)!.label} is empty`));
    else if (this.showMetadata && this.overlays.show_overlays && !this.maskEditing()) {
      // text stored in the image file (e.g. renders saved with metadata)
      const meta = this.imageMetadata();
      if (meta.length) info.push(h('div', { class: 'ie-meta', key: 'meta' }, meta.map(([k, v]) => `${k}: ${v}`).join(' | ')));
    }
    const paint = this.paintMode();
    const mask = this.maskEditing();
    patch(this.ui, [
      ...info,
      paint
        ? h('div', { key: 'ie-toolhdr', class: 'hdr-row ie-toolhdr' }, toolHeaderSettings('TEXTURE_PAINT'))
        : mask
          ? this.showToolSettings
            ? h('div', { key: 'ie-maskhdr', class: 'hdr-row ie-toolhdr ie-samplehdr' }, imageMaskToolSettings(this))
            : null
          : this.showToolSettings && (this.image || this.result) && !this.host.close
            ? isAnnotateTool(this.viewTool)
              ? h('div', { key: 'ie-annhdr', class: 'hdr-row ie-toolhdr ie-samplehdr' }, h('span', { class: 'ie-tool-name' }, icon('annotate'), 'Annotate'), h('span', { class: 'ie-tool-label' }, 'D + drag draws with any tool; Ctrl erases'))
              : this.sampleToolHeader()
            : null,
      paint && this.showToolbar ? this.paintToolbar() : null,
      mask && this.showToolbar ? imageMaskToolbar(this) : null,
      !paint && !mask && this.showToolbar && !this.host.close ? this.viewToolbar() : null,
      this.sampleBar(),
      this.showSidebar ? this.sidebar() : null,
      navGizmo2D(this, this.showSidebar ? 270 : 0, this.showGizmo && !this.host.close, paint || (this.showToolSettings && (mask || this.image || this.result)) ? 36 : 8),
      this.host.area ? lastOpPanel(this) : null,
    ]);
  }

  /**
   * Pixel values averaged over the sample square around (x, y): raw values (render passes in
   * scene-linear, images as stored 0–1) plus colour-managed display values for renders.
   */
  sampleValues(x: number, y: number, size = this.sampleSize): { raw: number[]; display?: number[]; depth?: number } | null {
    const half = Math.floor((Math.max(1, size) - 1) / 2);
    const r = this.result;
    if (r) {
      let acc: number[] | null = null;
      let depth: number | undefined;
      let n = 0;
      for (let yy = y - half; yy < y - half + size; yy++)
        for (let xx = x - half; xx < x - half + size; xx++) {
          const s = samplePixel(r, this.pass, xx, yy, sceneView(r));
          if (!s) continue;
          acc = acc ? acc.map((v, k) => v + s.raw[k]) : s.raw.slice();
          if (xx === x && yy === y) depth = s.depth;
          n++;
        }
      if (!acc || !n) return null;
      const raw = acc.map((v) => v / n);
      const out: { raw: number[]; display?: number[]; depth?: number } = { raw, depth };
      if (this.pass === 'Combined') {
        const d = [0, 0, 0, 0];
        displayPixel(raw[0], raw[1], raw[2], raw[3] ?? 1, sceneView(r), d);
        out.display = d;
      }
      return out;
    }
    const img = this.image;
    if (!img) return null;
    const c = imageCanvas(img);
    const x0 = Math.max(0, x - half),
      y0 = Math.max(0, y - half);
    const x1 = Math.min(c.width, x - half + size),
      y1 = Math.min(c.height, y - half + size);
    if (x < 0 || y < 0 || x >= c.width || y >= c.height || x1 <= x0 || y1 <= y0) return null;
    const p = c.getContext('2d', { willReadFrequently: true })!.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    const acc = [0, 0, 0, 0];
    for (let i = 0; i < p.length; i += 4) for (let k = 0; k < 4; k++) acc[k] += p[i + k];
    const n = p.length / 4;
    return { raw: acc.map((v) => v / n / 255) };
  }

  private sampleBar(): Child {
    if (!this.sample) return null;
    const x = Math.floor(this.sample.x),
      y = Math.floor(this.sample.y);
    const f = (v: number) => v.toFixed(3);
    const s = this.sampleValues(x, y);
    if (!s) return null;
    let parts: Child[] = [];
    if (this.result) {
      if (this.pass === 'Combined') {
        parts = [`R:${f(s.raw[0])}`, `G:${f(s.raw[1])}`, `B:${f(s.raw[2])}`, `A:${f(s.raw[3])}`];
        if (s.display) parts.push(h('span', { class: 'ie-cm' }, `CM R:${f(s.display[0])} G:${f(s.display[1])} B:${f(s.display[2])}`));
      } else if (this.pass === 'Normal') parts = [`X:${f(s.raw[0])}`, `Y:${f(s.raw[1])}`, `Z:${f(s.raw[2])}`];
      else parts = [`${this.pass === 'Depth' ? 'Z' : 'V'}:${s.raw[0] >= 1e9 ? '∞' : f(s.raw[0])}`];
      if (s.depth !== undefined && this.pass !== 'Depth') parts.push(`Z:${s.depth >= 1e9 ? '∞' : f(s.depth)}`);
    } else {
      const b = s.raw.map((v) => Math.round(v * 255));
      parts = [`R:${b[0]}`, `G:${b[1]}`, `B:${b[2]}`, `A:${b[3]}`, h('span', { class: 'ie-cm' }, `${f(s.raw[0])} ${f(s.raw[1])} ${f(s.raw[2])} ${f(s.raw[3])}`)];
    }
    const size = this.sampleSize > 1 ? h('span', { class: 'ie-cm' }, `${this.sampleSize}×${this.sampleSize} px`) : null;
    return h('div', { class: 'ie-sample', key: 'sample' }, h('span', null, `X:${x} Y:${y}`), ...parts.map((p) => h('span', null, p)), size);
  }

  /** Tool settings of the Sample tool (View mode). */
  private sampleToolHeader(): Child {
    return h(
      'div',
      { key: 'ie-samplehdr', class: 'hdr-row ie-toolhdr ie-samplehdr' },
      h('span', { class: 'ie-tool-name', 'data-tip': 'Sample\nClick and drag over the image to read pixel values (Ctrl: set the display black point, Shift: the white point)' }, icon('eyedropper'), 'Sample'),
      h('span', { class: 'ie-tool-label' }, 'Sample Size'),
      numberField({ id: 'ie-sample-size', value: this.sampleSize, int: true, min: 1, max: 128, unit: 'pixel', tip: 'Width of the square of pixels averaged when sampling', set: (v) => ((this.sampleSize = Math.max(1, Math.round(v))), this.drawUI()) }),
    );
  }

  /** Set the display curve's black or white point to the sampled render color (Ctrl / Shift click). */
  setCurvePoint(point: 'BLACK_POINT' | 'WHITE_POINT', x: number, y: number): boolean {
    const r = this.result;
    if (!r || r.view) return false;
    const s = this.sampleValues(Math.floor(x), Math.floor(y));
    if (!s) return false;
    const cm = app.doc.scene.render;
    // the level is measured before the curve itself
    const d = [0, 0, 0, 0];
    displayPixel(s.raw[0], s.raw[1] ?? s.raw[0], s.raw[2] ?? s.raw[0], 1, { ...sceneView(r), use_curve_mapping: false }, d);
    const level = Math.max(0, Math.min(1, 0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2]));
    const pts = cm.use_curve_mapping && cm.curve_mapping?.length ? cm.curve_mapping : [[0, 0], [1, 1]] as [number, number][];
    let lo = pts[0][0],
      hi = pts[pts.length - 1][0];
    if (point === 'BLACK_POINT') lo = Math.min(level, hi - 1e-3);
    else hi = Math.max(level, lo + 1e-3);
    cm.curve_mapping = [[lo, 0], [hi, 1]];
    cm.use_curve_mapping = true;
    this.cache = null;
    return true;
  }

  // ---------------------------------------------------------------------
  // header

  header(): Child {
    const img = this.image;
    const r = this.result;
    const isRender = this.imageId === RENDER_RESULT;
    const virt = this.imageId ? virtualImages.get(this.imageId) : undefined;
    const fullResult = isRender ? renderResult.get() : null;
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
    const passItems = this.passes().map((p) => ({ value: p, label: passLabel(p) }));
    return h(
      'div',
      { class: 'hdr-row ie-header' },
      this.host.close
        ? null
        : enumMenu(
            'ie-mode',
            [
              { value: 'VIEW', label: 'View', icon: 'image', description: 'View and sample the image' },
              { value: 'PAINT', label: 'Paint', icon: 'tpaint_hlt', description: 'Paint on the image with the Texture Paint brushes' },
              { value: 'MASK', label: 'Mask', icon: 'mod_mask', description: 'Draw and edit masks over the image' },
            ],
            this.maskEditing() ? 'MASK' : this.paintMode() ? 'PAINT' : 'VIEW',
            (v) => this.setMode(v as 'VIEW'),
            { tip: 'Editing context of the Image Editor', className: 'ie-mode' },
          ),
      menu('View', () => this.viewMenu()),
      this.maskEditing() ? menu('Select', () => maskSelectMenu()) : null,
      menu('Image', () => this.imageMenu()),
      this.maskEditing() ? [menu('Add', () => maskAddMenu()), menu('Mask', () => maskMenu())] : null,
      h(
        'div',
        { class: 'ie-browse' },
        h(
          'button',
          {
            class: 'hdr-icondrop',
            'data-tip': 'Browse Image to be linked',
            onpointerdown: (e: PointerEvent) => {
              e.preventDefault();
              openMenu(this.browseMenu(), e.currentTarget as HTMLElement);
            },
          },
          icon(isRender ? 'render' : virt ? virt.icon : 'image'),
          icon('down_arrow_hlt', 'tiny'),
        ),
        img
          ? textField(`ie-name-${img.id}`, img.name, (v) => {
              if (!v || v === img.name) return;
              img.name = v;
              app.pushUndo('Rename Image');
              app.changed('doc');
            })
          : isRender || virt
            ? h('span', { class: 'ie-name' }, this.sourceLabel())
            : null,
        img || isRender || virt
          ? h('button', { class: 'hdr-toggle', 'data-tip': 'Unlink Data-Block\nStop showing this image in the editor', onclick: () => this.setImage(null) }, icon('x'))
          : [
              h('button', { class: 'btn ie-new', onclick: (e: MouseEvent) => this.newDialog(e.currentTarget as HTMLElement) }, icon('add'), 'New'),
              h('button', { class: 'btn ie-open', onclick: () => this.open() }, icon('file_folder'), 'Open'),
            ],
      ),
      fullResult && (fullResult.viewLayer || fullResult.layers)
        ? enumMenu(
            'ie-layer',
            layerItems(fullResult),
            layerItems(fullResult).some((i) => i.value === this.layer) ? this.layer : (fullResult.viewLayer ? 'COMPOSITE' : layerKey(fullResult.layers!.find((l) => l.passes.Combined === fullResult.passes.Combined) ?? fullResult.layers![0])),
            (v) => ((this.layer = v as ResultLayer), (this.cache = null), this.draw(), this.drawUI(), this.host.redrawHeader()),
            { tip: 'Render layer to display' },
          )
        : null,
      fullResult?.views?.length
        ? enumMenu(
            'ie-view',
            viewItems(fullResult),
            viewItems(fullResult).some((i) => i.value === this.view) ? this.view : fullResult.views[0].name,
            (v) => ((this.view = v), (this.cache = null), this.draw(), this.drawUI(), this.host.redrawHeader()),
            { tip: 'View of the multi-view render to display' },
          )
        : null,
      isRender
        ? enumMenu(
            'ie-slot',
            Array.from({ length: renderResult.count }, (_, i) => ({ value: String(i), label: `${renderResult.slotName(i)}${renderResult.hasRender(i) ? '' : ' (empty)'}` })),
            String(renderResult.slot),
            (v) => (renderResult.setSlot(Number(v)), app.changed('ui')),
            { tip: 'Render Slot\nRenders go into the shown slot; keep earlier renders in other slots to compare them (J / Alt J, 1–8)' },
          )
        : null,
      r && passItems.length > 1 ? enumMenu('ie-pass', passItems, this.pass, (v) => ((this.pass = v as PassName), this.cache = null, this.draw(), this.drawUI(), this.host.redrawHeader()), { tip: 'Render pass to display' }) : null,
      this.maskEditing() ? maskBrowse(this) : null,
      this.maskEditing()
        ? enumMenu(
            'ie-mask-pivot',
            [
              { value: 'BOUNDING_BOX_CENTER', label: 'Bounding Box Center', icon: 'pivot_boundbox' },
              { value: 'CURSOR', label: '2D Cursor', icon: 'pivot_cursor' },
              { value: 'MEDIAN_POINT', label: 'Median Point', icon: 'pivot_median' },
            ],
            this.pivot,
            (v) => ((this.pivot = v as 'CURSOR'), this.host.redrawHeader()),
            { iconOnly: true, tip: 'Pivot Point\nCenter for rotating and scaling mask points (.)', title: 'Pivot Point' },
          )
        : null,
      this.maskEditing() ? maskProportionalHeader() : null,
      h('div', { class: 'hdr-spacer' }),
      this.host.close
        ? null
        : h(
            'div',
            { class: 'hdr-group', key: 'ie-overlay' },
            h('button', { class: { 'hdr-toggle': true, on: this.overlays.show_overlays }, 'data-tip': 'Show Overlays (Shift Alt Z)', onclick: () => this.toggleOverlays() }, icon('overlay')),
            h(
              'button',
              {
                class: 'hdr-icondrop ie-overlays',
                'data-tip': 'Overlays',
                onpointerdown: (e: PointerEvent) => {
                  e.preventDefault();
                  openPopover(e.currentTarget as HTMLElement, () => this.overlayPopover(), { width: 240 });
                },
              },
              icon('down_arrow_hlt', 'tiny'),
            ),
          ),
      enumMenu(
        'ie-channels',
        CHANNELS.filter((c) => c.value !== 'Z' || !!r?.passes.Depth),
        this.channel,
        (v) => {
          this.channel = v as ChannelMode;
          this.draw();
          this.host.redrawHeader();
        },
        { iconOnly: true, tip: 'Display Channels\nChannels of the image to display', title: 'Display Channels' },
      ),
      this.host.close ? h('button', { class: 'hdr-toggle', 'data-tip': 'Close the render view (Esc)', onclick: () => this.host.close!() }, icon('panel_close')) : null,
    );
  }

  toggleOverlays() {
    this.overlays.show_overlays = !this.overlays.show_overlays;
    this.draw();
    this.drawUI();
    this.host.redrawHeader();
  }

  /** Header ▸ Overlays popover. */
  private overlayPopover(): Child {
    const ov = this.overlays;
    const redraw = () => (this.draw(), this.drawUI(), app.changed('ui'));
    return h(
      'div',
      { class: 'pop-panel' },
      h('div', { class: 'pop-title' }, 'Image'),
      checkbox('ie-ov-meta', 'Metadata', this.showMetadata, (v) => ((this.showMetadata = v), redraw()), { tip: 'Show the render information over render results' }),
      this.maskEditing()
        ? [
            h('div', { class: 'pop-title' }, 'Mask Display'),
            checkbox('ie-ov-spline', 'Spline', ov.show_mask_spline, (v) => ((ov.show_mask_spline = v), redraw())),
            enumRow(
              'ie-ov-mdisplay',
              [
                { value: 'OUTLINE', label: 'Outline', description: 'Light splines with a dark border' },
                { value: 'DASH', label: 'Dash', description: 'Dashed splines' },
                { value: 'BLACK', label: 'Black', description: 'Thin black splines' },
                { value: 'WHITE', label: 'White', description: 'Thin white splines' },
              ],
              ov.mask_display_type,
              (v) => ((ov.mask_display_type = v as MaskDisplayType), redraw()),
            ),
            splitRow(
              'Overlay',
              enumMenu(
                'ie-ov-maskmode',
                [
                  { value: 'NONE', label: 'None', description: 'Only the splines' },
                  { value: 'ALPHACHANNEL', label: 'Alpha Channel', description: 'Show the mask as a black and white matte instead of the image' },
                  { value: 'COMBINED', label: 'Combined', description: 'Darken the image outside the mask' },
                ],
                ov.mask_overlay_mode,
                (v) => ((ov.mask_overlay_mode = v as 'NONE'), redraw()),
              ),
            ),
            numberField({ id: 'ie-ov-blend', label: 'Blending Factor', value: ov.blend_factor, min: 0, max: 1, slider: true, unit: 'factor', set: (v) => ((ov.blend_factor = v), this.draw()) }),
          ]
        : null,
    );
  }

  private viewMenu(): MenuItem[] {
    const items: MenuItem[] = [
      ...(this.host.close ? [] : [{ label: 'Toolbar', checked: this.showToolbar, shortcut: 'T', action: () => ((this.showToolbar = !this.showToolbar), this.drawUI()) }]),
      { label: 'Sidebar', checked: this.showSidebar, shortcut: 'N', action: () => this.toggleSidebar() },
      ...(this.paintMode() || this.host.close ? [] : [{ label: 'Tool Settings', checked: this.showToolSettings, action: () => ((this.showToolSettings = !this.showToolSettings), this.drawUI()) }]),
      { separator: true },
      ...(this.host.close ? [] : [{ label: 'Show Metadata', checked: this.showMetadata, action: () => ((this.showMetadata = !this.showMetadata), this.drawUI()) }, { label: 'Navigation Gizmo', checked: this.showGizmo, shortcut: 'Ctrl `', action: () => ((this.showGizmo = !this.showGizmo), this.drawUI()) }]),
      { separator: true },
      { label: 'Zoom In', op: 'image.view_zoom_in', shortcut: 'Numpad +' },
      { label: 'Zoom Out', op: 'image.view_zoom_out', shortcut: 'Numpad -' },
      { label: 'Fractional Zoom', submenu: () => RATIOS.map(([l, z]) => ({ label: `Zoom ${l}`, op: 'image.view_zoom_ratio', props: { ratio: z }, shortcut: z === 1 ? 'Numpad 1' : z < 1 ? `Numpad ${Math.round(1 / z)}` : `Ctrl Numpad ${z}` })) },
      ...(this.maskEditing() ? [{ label: 'Center View to Cursor', op: 'image.view_center_cursor' }, { label: 'Cursor to Center View', op: 'image.view_cursor_center', shortcut: 'Shift C' }] : []),
      { label: 'Zoom Region…', op: 'image.view_zoom_border', shortcut: 'Shift B' },
      { separator: true },
      { label: 'Frame All', op: 'image.view_all', props: { fit_view: false }, shortcut: 'Home' },
      { label: 'Frame All Fit', op: 'image.view_all', props: { fit_view: true }, shortcut: 'Shift Home' },
    ];
    if (this.imageId === RENDER_RESULT)
      items.push(
        { separator: true },
        { label: 'Render Region…', op: 'image.render_border', shortcut: 'Ctrl B' },
        { label: 'Clear Render Region', op: 'image.clear_render_border', shortcut: 'Ctrl Alt B' },
        { separator: true },
        { label: 'Cycle Render Slot', op: 'image.cycle_render_slot', shortcut: 'J' },
        { label: 'Cycle Render Slot (Reverse)', op: 'image.cycle_render_slot', props: { reverse: true }, shortcut: 'Alt J' },
      );
    if (this.host.area) {
      const area = this.host.area;
      items.push({ separator: true }, { label: 'Area', submenu: () => area.areaMenu() });
    }
    return items;
  }

  private imageMenu(): MenuItem[] {
    const img = this.image;
    const hasPixels = !!img || !!this.result;
    return [
      { label: 'New', icon: 'add', shortcut: 'Alt N', action: () => this.newDialog() },
      { label: 'Open…', icon: 'file_folder', shortcut: 'Alt O', action: () => this.open() },
      { label: 'Open Image Sequence…', action: () => void this.openSequence() },
      { label: 'Open Cached Render', op: 'image.read_viewlayers', shortcut: 'Ctrl R' },
      ...(img
        ? [
            { label: 'Replace…', op: 'image.replace' },
            { label: 'Reload', shortcut: 'Alt R', action: () => this.reload() },
            ...(img.source !== 'TILED' ? [{ label: 'Edit Externally…', op: 'image.external_edit' }] : []),
          ]
        : []),
      { separator: true },
      { label: 'Save', shortcut: 'Alt S', disabled: !hasPixels, action: () => this.save() },
      { label: 'Save As…', shortcut: 'Shift Alt S', disabled: !hasPixels, action: () => this.saveAsDialog() },
      { label: 'Save a Copy…', disabled: !hasPixels, action: () => this.saveAsDialog() },
      { label: 'Save All Images', op: 'image.save_all_modified' },
      ...(imageMedia(img) ? [{ label: 'Save Sequence', op: 'image.save_sequence' }, { label: 'Match Movie Length', op: 'image.match_movie_length' }] : []),
      ...(img
        ? [
            { separator: true },
            {
              label: 'Invert',
              submenu: () => [
                { label: 'Invert Image Colors', op: 'image.invert', props: { invert_r: true, invert_g: true, invert_b: true } },
                { separator: true },
                { label: 'Invert Red Channel', op: 'image.invert', props: { invert_r: true } },
                { label: 'Invert Green Channel', op: 'image.invert', props: { invert_g: true } },
                { label: 'Invert Blue Channel', op: 'image.invert', props: { invert_b: true } },
                { label: 'Invert Alpha Channel', op: 'image.invert', props: { invert_a: true } },
              ],
            },
            { label: 'Resize', op: 'image.resize' },
            {
              label: 'Transform',
              submenu: () => [
                { label: 'Flip Horizontally', op: 'image.flip', props: { use_flip_x: true } },
                { label: 'Flip Vertically', op: 'image.flip', props: { use_flip_y: true } },
                { separator: true },
                { label: 'Rotate 90° Clockwise', op: 'image.rotate_orthogonal', props: { degrees: '90' } },
                { label: 'Rotate 90° Counter-Clockwise', op: 'image.rotate_orthogonal', props: { degrees: '270' } },
                { label: 'Rotate 180°', op: 'image.rotate_orthogonal', props: { degrees: '180' } },
              ],
            },
            ...(img.source === 'GENERATED' ? [{ separator: true }, { label: 'Pack', icon: 'package', op: 'image.pack' }] : []),
            { separator: true },
            { label: 'Copy', op: 'image.clipboard_copy' },
          ]
        : [{ separator: true }]),
      { label: 'Paste', op: 'image.clipboard_paste' },
    ];
  }

  private browseMenu(): MenuItem[] {
    const items: MenuItem[] = [{ label: 'Render Result', icon: 'render', active: this.imageId === RENDER_RESULT, action: () => this.setImage(RENDER_RESULT) }];
    for (const v of virtualImages.values()) items.push({ label: v.label, icon: v.icon, active: this.imageId === v.id, action: () => this.setImage(v.id) });
    const imgs = Object.values(app.doc.images).filter((i) => i.source !== 'RENDER');
    if (imgs.length) items.push({ separator: true });
    for (const i of imgs) items.push({ label: i.name, icon: 'image', active: i.id === this.imageId, action: () => this.setImage(i.id) });
    return items;
  }

  toggleSidebar() {
    this.showSidebar = !this.showSidebar;
    this.drawUI();
  }

  // ---------------------------------------------------------------------
  // image operations

  newDialog(anchor?: HTMLElement) {
    newImageDialog(anchor, (id) => {
      this.setImage(id);
      this.seenLastImage = id;
    });
  }

  /** Open image files (several files of one UDIM set become a tiled image) and show the first. */
  open() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/png,image/jpeg,image/webp,image/gif,image/bmp,.hdr,.exr,video/*,.mp4,.m4v,.mov,.webm,.mkv';
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      const video = (f: File) => f.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|mkv)$/i.test(f.name);
      const ids: string[] = [];
      // movies open as moving images, still images as images (or UDIM tiles)
      for (const f of files.filter(video)) {
        const id = await openMediaFiles([f]);
        if (id) ids.push(id);
      }
      ids.push(...(await openImageFiles(files.filter((f) => !video(f)))));
      this.seenLastImage = lastImage;
      if (ids[0]) this.setImage(ids[0]);
    };
    input.click();
  }

  /** Open several images as one image sequence (frames in name order). */
  async openSequence() {
    const files = await pickFiles('image/*,.png,.jpg,.jpeg,.webp,.bmp', true);
    if (!files.length) return;
    const id = await openMediaFiles(files);
    if (id) this.setImage(id);
  }

  reload() {
    const img = this.image;
    if (!img) return;
    if (img.source === 'GENERATED') {
      const c = imageCanvas(img);
      const ctx = c.getContext('2d')!;
      ctx.clearRect(0, 0, c.width, c.height);
      generatedPixels(img, ctx);
      touchImage(img);
    } else img.revision = (img.revision ?? 0) + 1; // re-decode from the stored file bytes
    this.cache = null;
    app.changed('doc');
    app.report('INFO', `Reloaded image "${img.name}"`);
    this.draw();
  }

  /** Encode the displayed image/pass (render results are saved colour-managed, "as render"). */
  async encode(format: FileFormat, colorMode: 'BW' | 'RGB' | 'RGBA', quality: number): Promise<Uint8Array | null> {
    const r = this.result;
    if (r) {
      const alpha = colorMode === 'RGBA' && format !== 'JPEG';
      // render results are written with the output's colour management (Output ▸ Color Management)
      const view = this.imageId === RENDER_RESULT ? outputView(app.doc.scene.render, r.view) : sceneView(r);
      let px = passToRGBA8(r, this.pass, this.channel === 'Z' ? 'Z' : this.channel === 'ALPHA' ? 'ALPHA' : 'COLOR_ALPHA', view, { keepAlpha: alpha && r.filmTransparent, dither: app.doc.scene.render.dither_intensity });
      if (colorMode === 'BW') px = toBW(px);
      const bytes = await encodeRGBA8(px, r.width, r.height, format, { alpha, quality });
      return format === 'PNG' && r.metadata?.length && this.pass === 'Combined' ? pngWithText(bytes, r.metadata.map((f) => [f.key, f.value])) : bytes;
    }
    const img = this.image;
    if (!img) return null;
    const src = imageCanvas(img);
    if (colorMode === 'RGBA' && format !== 'JPEG') return canvasBytes(src, format, quality);
    const px = src.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, src.width, src.height).data;
    if (colorMode === 'BW') toBW(px);
    return encodeRGBA8(px, src.width, src.height, format, { alpha: false, quality });
  }

  private defaultName(format: SaveFormat) {
    const base = this.image?.name.replace(/\.[a-z0-9]+$/i, '') ?? (this.result ? `render_${this.result.info.frame}${this.pass !== 'Combined' ? '_' + this.pass.toLowerCase() : ''}` : 'image');
    return `${base}.${isExr(format) ? 'exr' : EXT[format]}`;
  }

  private outputDefaults(): { format: SaveFormat; colorMode: 'BW' | 'RGB' | 'RGBA' } {
    const r = app.doc.scene.render;
    if (this.result) return { format: r.file_format === 'WEBM' ? 'PNG' : r.file_format, colorMode: r.color_mode };
    const img = this.image;
    const format: FileFormat = img?.mime === 'image/jpeg' ? 'JPEG' : img?.mime === 'image/webp' ? 'WEBP' : 'PNG';
    return { format, colorMode: 'RGBA' };
  }

  async save() {
    // UDIM images: every tile, named with the <UDIM> token
    if (isTiled(this.image)) return saveTiles(this.image);
    const { format, colorMode } = this.outputDefaults();
    await this.saveWith(format, colorMode, 0.9, this.defaultName(format));
  }

  private async saveWith(format: SaveFormat, colorMode: 'BW' | 'RGB' | 'RGBA', quality: number, name: string) {
    try {
      if (isExr(format)) {
        // render results as scene-linear OpenEXR (all passes for MultiLayer)
        const res = this.imageId === RENDER_RESULT ? resultView(renderResult.get(), this.view) : this.result;
        if (!res) return void app.report('ERROR', 'OpenEXR is available for render results');
        const sc = app.doc.scene;
        download(resultExr(res, { ...sc.render, color_mode: colorMode }, format, ensureViewLayers(sc)[activeLayerIndex(sc)]?.name), name, 'image/x-exr');
        app.report('INFO', `Saved "${name}"`);
        return;
      }
      const bytes = await this.encode(format, colorMode, quality);
      if (!bytes) return;
      download(bytes, name, `image/${EXT[format] === 'jpg' ? 'jpeg' : EXT[format]}`);
      if (this.image) modifiedImages.delete(this.image.id);
      app.report('INFO', `Saved "${name}"`);
    } catch (e) {
      app.report('ERROR', `Could not save the image: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  saveAsDialog(anchor?: HTMLElement) {
    if (isTiled(this.image)) return void saveTiles(this.image);
    const d = this.outputDefaults();
    const p = { format: d.format, colorMode: d.colorMode, quality: 90, name: this.defaultName(d.format) };
    const pop = openPopover(
      anchor ?? { x: app.pointer.x, y: app.pointer.y },
      () =>
        h(
          'div',
          { class: 'pop-panel ie-dialog' },
          h('div', { class: 'pop-title' }, 'Save As Image'),
          splitRow('File Name', textField('ie-save-name', p.name, (v) => (p.name = v), { live: true })),
          splitRow(
            'File Format',
            enumRow(
              'ie-save-fmt',
              [
                { value: 'PNG', label: 'PNG' },
                { value: 'JPEG', label: 'JPEG' },
                { value: 'WEBP', label: 'WebP' },
                ...(this.result ? [{ value: 'OPEN_EXR', label: 'EXR' }, { value: 'OPEN_EXR_MULTILAYER', label: 'EXR Layers', description: 'OpenEXR with every render pass' }] : []),
              ],
              p.format,
              (v) => {
                p.format = v as SaveFormat;
                p.name = p.name.replace(/\.[a-z0-9]+$/i, '') + '.' + (isExr(p.format) ? 'exr' : EXT[p.format]);
                if (p.format === 'JPEG' && p.colorMode === 'RGBA') p.colorMode = 'RGB';
                pop.redraw();
              },
            ),
          ),
          splitRow(
            'Color',
            enumRow(
              'ie-save-cm',
              [
                { value: 'BW', label: 'BW' },
                { value: 'RGB', label: 'RGB' },
                ...(p.format === 'JPEG' ? [] : [{ value: 'RGBA', label: 'RGBA' }]),
              ],
              p.colorMode,
              (v) => ((p.colorMode = v as 'RGB'), pop.redraw()),
            ),
          ),
          p.format !== 'PNG' && !isExr(p.format) ? splitRow('Quality', numberField({ id: 'ie-save-q', value: p.quality, int: true, min: 1, max: 100, unit: 'percentage', slider: true, set: (v) => ((p.quality = v), pop.redraw()) })) : null,
          h(
            'div',
            { class: 'ie-dialog-buttons' },
            button('ie-save-ok', 'Save As Image', () => {
              pop.el.remove();
              void this.saveWith(p.format, p.colorMode, p.quality / 100, p.name || this.defaultName(p.format));
            }),
          ),
        ),
      { width: 280 },
    );
  }

  // ---------------------------------------------------------------------
  // sidebar

  /** Sidebar ▸ Image ▸ UDIM Tiles: the tiles (active one highlighted), add / remove / fill. */
  private udimPanel(img: Img): Child {
    const area = this.host.area ?? null;
    const act = img.active_tile_index ?? 0;
    return panel('ie-udim', 'UDIM Tiles', () => [
      uiList(
        `ie-udim-${img.id}`,
        img.tiles!.map((t, i) => ({ key: String(t.number), label: tileName(img, i), icon: 'image' })),
        act,
        (i) => ((img.active_tile_index = i), app.changed('ui'), this.draw()),
        {
          add: () => app.run('image.tile_add', {}, { area }),
          remove: () => app.run('image.tile_remove', {}, { area, invoke: false }),
          rename: (i, name) => {
            img.tiles![i] = { ...img.tiles![i], label: name.replace(/^\d+\s*·?\s*/, '') || undefined };
            app.pushUndo('Rename Tile');
            app.changed('doc');
          },
          rows: 3,
        },
      ),
      splitRow('Size', h('span', { class: 'ie-value' }, (() => {
        const v = tileView(img, Math.min(act, img.tiles!.length - 1));
        return `${v.width} × ${v.height}${v.bytes ? '' : ' (generated)'}`;
      })())),
      h('div', { class: 'btn-col' }, button('ie-tile-fill', 'Fill Tile', () => app.run('image.tile_fill', {}, { area }), { tip: 'Fill the active tile with a color (Adjust Last Operation for the color, pattern and size)' })),
    ]);
  }

  private sidebar(): Child {
    const img = this.image;
    const r = this.result;
    const body: Child[] = [];
    if (r) {
      const row = (k: string, v: string) => splitRow(k, h('span', { class: 'ie-value' }, v));
      body.push(
        panel('ie-render', 'Image', () => [row('Source', this.sourceLabel() ?? 'Render Result'), row('Resolution', `${r.width} × ${r.height}`), row('Passes', this.passes().map((p) => passLabel(p)).join(', '))]),
        ...(this.imageId === RENDER_RESULT
          ? [
              panel('ie-slots', 'Render Slots', () => [
                uiList(
                  'ie-slot-list',
                  Array.from({ length: renderResult.count }, (_, i) => ({ key: String(i), label: renderResult.slotName(i), icon: renderResult.hasRender(i) ? 'render' : 'dot', right: renderResult.hasRender(i) ? null : h('span', { class: 'ie-slot-empty' }, 'empty') })),
                  renderResult.slot,
                  (i) => (renderResult.setSlot(i), app.changed('ui')),
                  {
                    add: () => app.run('image.add_render_slot', {}, { area: this.host.area ?? null }),
                    remove: () => app.run('image.remove_render_slot', {}, { area: this.host.area ?? null }),
                    rename: (i, name) => (renderResult.renameSlot(i, name), app.changed('ui')),
                    rows: 4,
                  },
                ),
                h('div', { class: 'btn-col' }, button('ie-slot-clear', 'Clear Slot', () => app.run('image.clear_render_slot', {}, { area: this.host.area ?? null }))),
              ]),
            ]
          : []),
      );
    } else if (img) {
      const set = (label: string) => {
        app.pushUndo(label);
        app.changed('doc');
        this.cache = null;
        this.draw();
      };
      const c = imageCanvas(img);
      body.push(
        panel('ie-image', 'Image', () => [
          splitRow(
            'Source',
            imageMedia(img)
              ? h('span', { class: 'ie-value' }, imageMedia(img)!.kind === 'MOVIE' ? 'Movie' : 'Image Sequence')
              : img.source === 'FILE' || img.source === 'GENERATED' || img.source === 'TILED'
              ? enumMenu(
                  `ie-src-${img.id}`,
                  [
                    img.bytes?.length || img.source === 'FILE' ? { value: 'FILE', label: 'Single Image', description: 'One image' } : { value: 'GENERATED', label: 'Generated', description: 'Pixels made from a color or pattern' },
                    { value: 'TILED', label: 'UDIM Tiles', description: 'Several tiles, each covering one unit square of UV space (1001, 1002, …)' },
                  ],
                  img.source,
                  (v) => {
                    if (v === 'TILED') makeTiled(img);
                    else makeSingle(img);
                    set(v === 'TILED' ? 'Image to UDIM Tiles' : 'Image to Single Image');
                  },
                  { tip: 'Where the image pixels come from' },
                )
              : h('span', { class: 'ie-value' }, img.source),
          ),
          img.source === 'FILE' && !imageMedia(img)
            ? splitRow(
                'File',
                h(
                  'div',
                  { class: 'ie-file-row' },
                  h('span', { class: 'ie-value', title: img.filepath ?? '' }, img.filepath || '—'),
                  h('button', { class: 'hdr-toggle', 'data-tip': 'Browse Image\nPick another file for this image', onclick: () => app.run('image.file_browse', {}, { area: this.host.area ?? null }) }, icon('file_folder')),
                  h('button', { class: 'hdr-toggle', 'data-tip': 'Reload Image (Alt R)', onclick: () => this.reload() }, icon('file_refresh')),
                ),
              )
            : img.filepath
              ? splitRow('File', h('span', { class: 'ie-value' }, img.filepath))
              : null,
          splitRow('Size', h('span', { class: 'ie-value' }, isTiled(img) ? `${img.tiles!.length} tile${img.tiles!.length > 1 ? 's' : ''}, RGBA byte` : `${c.width} × ${c.height}, RGBA byte`)),
          splitRow(
            'Color Space',
            enumMenu(
              `ie-cs-${img.id}`,
              [
                { value: 'sRGB', label: 'sRGB' },
                { value: 'Linear', label: 'Linear Rec.709' },
                { value: 'Non-Color', label: 'Non-Color' },
              ],
              img.colorspace,
              (v) => ((img.colorspace = v as 'sRGB'), set('Image Color Space')),
            ),
          ),
        ]),
        isTiled(img) ? this.udimPanel(img) : null,
        imageMedia(img) ? this.mediaPanel(img) : null,
        this.imageMetadata().length
          ? panel('ie-file-meta', 'Metadata', () => this.imageMetadata().map(([k, v]) => h('div', { key: k }, splitRow(k, h('span', { class: 'ie-value', title: v }, v)))), { closed: true })
          : null,
        img.source === 'GENERATED'
          ? panel('ie-gen', 'Generated', () => [
              splitRow('X', numberField({ id: `ie-gx-${img.id}`, value: img.width, int: true, min: 1, max: 16384, unit: 'pixel', set: (v, f) => ((img.width = v), f && set('Image Size'), app.changed('doc')) })),
              splitRow('Y', numberField({ id: `ie-gy-${img.id}`, value: img.height, int: true, min: 1, max: 16384, unit: 'pixel', set: (v, f) => ((img.height = v), f && set('Image Size'), app.changed('doc')) })),
              splitRow(
                'Type',
                enumMenu(
                  `ie-gt-${img.id}`,
                  [
                    { value: 'BLANK', label: 'Blank' },
                    { value: 'UV_GRID', label: 'UV Grid' },
                    { value: 'COLOR_GRID', label: 'Color Grid' },
                  ],
                  img.generated_type ?? 'BLANK',
                  (v) => ((img.generated_type = v as 'BLANK'), set('Generated Type')),
                ),
              ),
              img.generated_type === 'BLANK' || !img.generated_type ? splitRow('Color', colorSwatch(`ie-gc-${img.id}`, img.generated_color ?? [0, 0, 0, 1], (v, f) => ((img.generated_color = [v[0], v[1], v[2], v[3] ?? 1]), f ? set('Generated Color') : app.changed('doc')), { alpha: true })) : null,
            ])
          : null,
      );
    } else body.push(h('div', { class: 'sb-empty' }, 'No image'));
    const tabs = [...(this.host.close ? [] : ['Tool']), ...(this.maskEditing() ? ['Mask'] : []), 'Image', 'View', 'Scopes', ...(r ? ['Metadata'] : [])];
    const tab = tabs.includes(this.sidebarTab) ? this.sidebarTab : 'Image';
    return h(
      'div',
      { key: 'sidebar', class: 'v3d-sidebar ie-sidebar' },
      h('div', { class: 'sb-body' }, tab === 'Scopes' ? scopesPanel(this) : tab === 'View' ? this.viewTab() : tab === 'Metadata' && r ? this.metadataTab(r) : tab === 'Tool' ? (this.paintMode() ? paintToolPanels('TEXTURE_PAINT') : this.toolTab()) : tab === 'Mask' ? maskSidebar(this) : body),
      h(
        'div',
        { class: 'sb-tabs' },
        tabs.map((t) => h('button', { key: t, class: { 'sb-tab': true, on: t === tab }, onclick: () => ((this.sidebarTab = t), this.drawUI()) }, t)),
      ),
    );
  }

  /** Frames of a movie / sequence image (the editor's image user). */
  private mediaPanel(img: Img): Child {
    const m = imageMedia(img)!;
    const set = (label: string) => (app.pushUndo(label), app.changed('doc'), this.draw());
    return panel('ie-media', 'Frames', () => [
      splitRow('Length', h('span', { class: 'ie-value' }, `${m.frames} frames${m.kind === 'MOVIE' ? ` at ${Math.round(m.fps * 100) / 100} fps` : ''}`)),
      splitRow('Frames', numberField({ id: `ie-md-dur-${img.id}`, value: m.frame_duration, int: true, min: 1, max: 1048574, set: (v, f) => ((m.frame_duration = v), f ? set('Frames') : this.draw()) })),
      splitRow('Start Frame', numberField({ id: `ie-md-start-${img.id}`, value: m.frame_start, int: true, set: (v, f) => ((m.frame_start = v), f ? set('Start Frame') : this.draw()) })),
      splitRow('Offset', numberField({ id: `ie-md-off-${img.id}`, value: m.frame_offset, int: true, set: (v, f) => ((m.frame_offset = v), f ? set('Offset') : this.draw()) })),
      splitRow('', checkbox(`ie-md-cyc-${img.id}`, 'Cyclic', m.use_cyclic, (v) => ((m.use_cyclic = v), set('Cyclic')))),
      h('div', { class: 'btn-col' }, button('ie-md-match', 'Match Movie Length', () => app.run('image.match_movie_length', {}, { area: this.host.area ?? null }))),
    ]);
  }

  /** Text entries stored in the shown PNG file. */
  imageMetadata(): [string, string][] {
    const img = this.image;
    if (!img?.bytes?.length || !/png/i.test(img.mime)) return [];
    try {
      return pngText(img.bytes);
    } catch {
      return [];
    }
  }

  /** Sidebar ▸ Tool: the active tool and its settings. */
  private toolTab(): Child {
    if (this.paintMode()) return panel('ie-tool-active', 'Active Tool', () => [h('div', { class: 'ie-tool-row' }, toolHeaderSettings('TEXTURE_PAINT'))]);
    if (this.maskEditing()) return panel('ie-tool-active', 'Active Tool', () => [h('div', { class: 'ie-tool-row ie-samplehdr' }, imageMaskToolSettings(this))]);
    if (isAnnotateTool(this.viewTool)) return annotationsPanel('ie-tool', this);
    return panel('ie-tool-active', 'Active Tool', () => [
      h('div', { class: 'ie-tool-row ie-samplehdr' }, h('span', { class: 'ie-tool-name' }, icon('eyedropper'), 'Sample')),
      splitRow('Sample Size', numberField({ id: 'ie-tool-sample-size', value: this.sampleSize, int: true, min: 1, max: 128, unit: 'pixel', set: (v) => ((this.sampleSize = Math.max(1, Math.round(v))), this.drawUI()) })),
    ]);
  }

  /** Sidebar ▸ View: display options (and the scene's colour management for render results). */
  private viewTab(): Child {
    const r = this.result;
    const cm = app.doc.scene.render;
    const looks = LOOKS[cm.view_transform] ? Object.keys(LOOKS[cm.view_transform]) : [];
    const redraw = () => ((this.cache = null), this.draw(), this.drawUI(), this.host.redrawHeader());
    return [
      panel('ie-view-display', 'Display', () => [
        splitRow('Zoom', numberField({ id: 'ie-zoom', value: this.zoom * 100, unit: 'percentage', min: 100 / 64, max: 25600, set: (v) => this.setRatio(v / 100) })),
        splitRow('Channels', enumMenu('ie-view-channels', CHANNELS.filter((c) => c.value !== 'Z' || !!r?.passes.Depth), this.channel, (v) => ((this.channel = v as ChannelMode), redraw()))),
        r ? splitRow('', checkbox('ie-show-meta', 'Show Metadata', this.showMetadata, (v) => ((this.showMetadata = v), this.drawUI()), { tip: 'Show the render information over the image' })) : null,
        h('div', { class: 'btn-col' }, button('ie-frame-all', 'Frame All', () => this.frameAll(false)), button('ie-frame-fit', 'Frame All Fit', () => this.frameAll(true))),
      ]),
      !this.host.close && this.annotationOwner() ? annotationsPanel('ie', this) : null,
      this.maskEditing()
        ? panel('ie-view-cursor', '2D Cursor', () => {
            const [W, H] = this.frameSize();
            const set = (i: 0 | 1, v: number) => ((this.cursor[i] = v / (i ? H : W)), this.draw());
            return [
              splitRow('Location X', numberField({ id: 'ie-cur-x', value: this.cursor[0] * W, unit: 'pixel', precision: 1, set: (v) => set(0, v) })),
              splitRow('Y', numberField({ id: 'ie-cur-y', value: this.cursor[1] * H, unit: 'pixel', precision: 1, set: (v) => set(1, v) })),
            ];
          })
        : null,
      r && !r.view
        ? panel('ie-view-cm', 'Color Management', () => [
            splitRow(
              'View Transform',
              enumMenu('ie-cm-view', [['STANDARD', 'Standard'], ['KHRONOS_PBR_NEUTRAL', 'Khronos PBR Neutral'], ['AGX', 'AgX'], ['FILMIC', 'Filmic'], ['RAW', 'Raw']].map(([value, label]) => ({ value, label })), cm.view_transform, (v) => {
                cm.view_transform = v as typeof cm.view_transform;
                if (cm.look !== 'None' && !LOOKS[cm.view_transform]?.[cm.look]) cm.look = 'None';
                app.pushUndo('View Transform');
                app.changed('doc');
              }),
            ),
            splitRow(
              'Look',
              enumMenu('ie-cm-look', [{ value: 'None', label: 'None' }, ...looks.map((l) => ({ value: l, label: l.replace(/^AgX - /, '') }))], looks.includes(cm.look) ? cm.look : 'None', (v) => {
                cm.look = v;
                app.pushUndo('Look');
                app.changed('doc');
              }, { disabled: !looks.length }),
            ),
            num(cm, 'exposure', 'Exposure', { min: -32, max: 32, softMin: -10, softMax: 10 }),
            num(cm, 'gamma', 'Gamma', { min: 0, max: 5 }),
          ])
        : null,
    ];
  }

  /** Sidebar ▸ Metadata of a render result (as stored in saved files). */
  private metadataTab(r: RenderResult): Child {
    const i = r.info;
    const row = (k: string, v: string) => splitRow(k, h('span', { class: 'ie-value', title: v }, v));
    const fields = r.metadata ?? [];
    return [
      panel('ie-meta-render', 'Render', () => [
        row('Frame', String(i.frame)),
        row('Render Time', formatTime(i.time)),
        row('Engine', i.engine),
        i.samples ? row('Samples', `${i.samples}${i.maxSamples ? ' / ' + i.maxSamples : ''}`) : null,
        row('Camera', i.camera || '—'),
        row('Scene', i.scene),
        row('Resolution', `${r.width} × ${r.height}`),
      ]),
      panel('ie-meta-fields', 'Metadata', () =>
        fields.length ? fields.map((f) => h('div', { key: f.key }, row(f.label, f.value))) : h('div', { class: 'prop-note' }, 'Enable fields in Output ▸ Metadata; they are stored in saved PNG files.'),
      ),
    ];
  }

  // ---------------------------------------------------------------------
  // input

  local(e: { clientX: number; clientY: number }) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** View mode toolbar: the Sample tool. */
  private viewToolbar(): Child {
    return h(
      'div',
      { key: 'ie-view-toolbar', class: 'v3d-toolbar ie-toolbar' },
      h(
        'button',
        {
          key: 'sample',
          class: { 'tb-tool': true, on: this.viewTool === 'sample' },
          'data-tool': 'sample',
          'data-tip': 'Sample\nClick and drag over the image to read pixel values (Ctrl: set the display black point, Shift: the white point)',
          onpointerdown: (e: PointerEvent) => (e.preventDefault(), (this.viewTool = 'sample'), this.drawUI()),
        },
        icon('eyedropper'),
      ),
      h('div', { key: 'sep', class: 'tb-sep' }),
      annotateToolSlot(this.viewTool, this.lastAnnotate, (t) => ((this.viewTool = t), (this.lastAnnotate = t), this.drawUI())),
    );
  }

  /** Texture Paint brushes as a toolbar (shared with painting in the 3D Viewport). */
  private paintToolbar(): Child {
    const cur = paintBrush()?.id;
    return h(
      'div',
      { key: 'ie-toolbar', class: 'v3d-toolbar ie-toolbar' },
      BRUSH_LISTS.TEXTURE_PAINT.map((t, i) =>
        t
          ? h(
              'button',
              {
                key: t.id,
                class: { 'tb-tool': true, on: t.id === cur },
                'data-tool': t.id,
                'data-tip': `${t.name}\n${t.description}`,
                onpointerdown: (e: PointerEvent) => {
                  e.preventDefault();
                  activeTools.TEXTURE_PAINT = t.id;
                  app.changed('ui');
                },
              },
              icon(t.icon),
            )
          : h('div', { key: `sep${i}`, class: 'tb-sep' }),
      ),
    );
  }

  /** UV wireframe of the active mesh over the image (Paint mode). */
  private drawUVOverlay(ctx: CanvasRenderingContext2D, x: number, y: number, dw: number, dh: number) {
    const ob = app.activeObject;
    if (!ob || ob.type !== 'MESH' || !ob.data) return;
    const me = app.doc.meshes[ob.data];
    if (!me?.uvs?.length) return;
    const editSel = app.doc.mode === 'EDIT' ? me.select_vert : undefined;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let f = 0; f < me.offsets.length - 1; f++) {
      const s0 = me.offsets[f],
        e0 = me.offsets[f + 1];
      if (editSel) {
        let all = true;
        for (let c = s0; c < e0; c++) if (!editSel[me.indices[c]]) all = false;
        if (!all) continue;
      }
      for (let c = s0; c < e0; c++) {
        const px = x + me.uvs[c * 2] * dw,
          py = y + (1 - me.uvs[c * 2 + 1]) * dh;
        if (c === s0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    }
    ctx.stroke();
    ctx.restore();
  }

  /** Show pixel values under the pointer until the mouse button is released. */
  beginSample(clientX: number, clientY: number) {
    const update = (cx: number, cy: number) => {
      const q = this.local({ clientX: cx, clientY: cy });
      const [ix, iy] = this.toImage(q.x, q.y);
      this.sample = { x: ix, y: iy };
      this.draw();
      this.drawUI();
    };
    update(clientX, clientY);
    const move = (ev: PointerEvent) => update(ev.clientX, ev.clientY);
    const up = () => {
      removeEventListener('pointermove', move, true);
      removeEventListener('pointerup', up, true);
      this.sample = null;
      this.draw();
      this.drawUI();
    };
    addEventListener('pointermove', move, true);
    addEventListener('pointerup', up, true);
  }

  private bind() {
    const el = this.canvas;
    el.addEventListener('pointermove', (e) => {
      if (!this.paintMode()) return;
      this.hover = this.local(e);
      this.draw();
    });
    el.addEventListener('pointerleave', () => {
      if (!this.hover) return;
      this.hover = null;
      this.draw();
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = this.local(e);
      const trackpad = e.deltaMode === 0 && (Math.abs(e.deltaX) > 0 || !Number.isInteger(e.deltaY));
      if (e.ctrlKey) this.zoomAt(Math.exp(-e.deltaY * 0.01), p.x, p.y);
      else if (trackpad) {
        this.offX -= e.deltaX / this.zoom;
        this.offY -= e.deltaY / this.zoom;
        this.draw();
      } else this.zoomAt(e.deltaY > 0 ? 0.8 : 1.25, p.x, p.y);
    }, { passive: false });
    el.addEventListener('pointerdown', (e) => {
      this.el.focus({ preventScroll: true });
      const start = this.local(e);
      // Paint mode: right-drag moves the clone source of the Clone brush
      if (e.button === 2 && this.paintMode() && imagePaintRightDown(this, e)) {
        this.skipContextMenu = true;
        return;
      }
      if (e.button === 1 || (e.button === 0 && e.altKey && !annotateKeyHeld())) {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        let last = start;
        const zoomDrag = e.ctrlKey;
        const move = (ev: PointerEvent) => {
          const q = this.local(ev);
          if (zoomDrag) this.zoomAt(Math.exp((q.x - last.x - (q.y - last.y)) * 0.01), start.x, start.y);
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
      if (annotateKeyHeld() && (e.button === 0 || e.button === 2) && !this.host.close) {
        if (e.button === 2) this.cursorPlaced = true; // no context menu
        annotatePointerDown(this, e, e.button === 2 ? 'ERASER' : e.altKey ? (e.shiftKey ? 'DRAW_POLY' : 'DRAW_STRAIGHT') : 'DRAW');
        return;
      }
      const media = imageMedia(this.image);
      if (e.button === 0 && media && !this.paintMode() && !this.maskEditing() && !this.host.close) {
        const r = this.maskStrip();
        if (start.y >= r.y - 2 && start.x >= r.x0 && start.x <= r.x1) {
          // drag along the frame strip to change the frame
          const range = this.mediaRange(media);
          const go = (ev: { clientX: number; clientY: number }) => {
            const f = maskStripFrame(range, r, this.local(ev).x);
            if (f !== app.doc.scene.frame_current) app.run('image.change_frame', { frame: f }, { area: this.host.area ?? null });
          };
          go(e);
          const up = () => (removeEventListener('pointermove', go), removeEventListener('pointerup', up));
          addEventListener('pointermove', go);
          addEventListener('pointerup', up);
          return;
        }
      }
      if (e.button === 0 && !this.paintMode() && !this.maskEditing() && isAnnotateTool(this.viewTool) && !this.host.close) {
        annotatePointerDown(this, e, annotateModeOf(this.viewTool));
        return;
      }
      if (this.maskEditing() && e.button === 2 && e.shiftKey) {
        // Shift right click places the 2D cursor
        placeCursor(this, start.x, start.y);
        this.cursorPlaced = true;
        return;
      }
      if (e.button === 0 && this.maskEditing()) {
        e.preventDefault();
        const m = hostMask(this);
        const r = this.maskStrip();
        if (m && this.overlays.show_overlays && start.y >= r.y - 2 && start.x >= r.x0 && start.x <= r.x1) {
          // drag along the frame strip to change the frame
          const go = (ev: { clientX: number; clientY: number }) => {
            const f = maskStripFrame(m, r, this.local(ev).x);
            if (f !== app.doc.scene.frame_current) app.setFrame(f);
          };
          go(e);
          const up = () => (removeEventListener('pointermove', go), removeEventListener('pointerup', up));
          addEventListener('pointermove', go);
          addEventListener('pointerup', up);
          return;
        }
        imageMaskPointerDown(this, e);
        return;
      }
      if (e.button === 0 && this.paintMode()) {
        const img = this.image;
        if (!img) app.report('WARNING', 'No image to paint on: create or open one, or add a paint slot to the object');
        else if (isTiled(img)) app.report('WARNING', 'Painting on UDIM tiles is not supported yet: paint a single image');
        else imagePaintStroke(this, img, e);
        return;
      }
      if (e.button === 0) {
        const event = { x: e.clientX, y: e.clientY, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
        const area = this.host.area ?? null;
        // Ctrl / Shift click on a render: display black / white point; otherwise sample while held
        if ((e.ctrlKey || e.metaKey || e.shiftKey) && this.result && !this.result.view) app.run('image.curves_point_set', { point: e.shiftKey ? 'WHITE_POINT' : 'BLACK_POINT', size: this.sampleSize }, { area, event });
        else if (area) app.run('image.sample', { size: this.sampleSize }, { area, event });
        else this.beginSample(e.clientX, e.clientY);
      }
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.skipContextMenu) {
        this.skipContextMenu = false;
        return;
      }
      if (this.cursorPlaced) return void (this.cursorPlaced = false);
      if (this.maskEditing()) return void openMenu(maskContextMenu(), { x: e.clientX, y: e.clientY }, { title: 'Mask' });
      openMenu(this.imageMenu(), { x: e.clientX, y: e.clientY }, { title: 'Image' });
    });
  }

  onKey(e: KeyboardEvent): boolean {
    if (e.type !== 'keydown') return false;
    const ctrl = e.ctrlKey || e.metaKey;
    // Paint mode: brush keys (swap colors, brush size, stroke method, stabilizer...)
    if (this.paintMode() && imagePaintKey(e)) return true;
    if (e.code === 'KeyN' && !ctrl && !e.altKey && !e.shiftKey) return this.toggleSidebar(), true;
    if (e.code === 'KeyT' && !ctrl && !e.altKey && !e.shiftKey && !this.host.close) return ((this.showToolbar = !this.showToolbar), this.drawUI()), true;
    if (e.code === 'KeyZ' && !ctrl && e.altKey && e.shiftKey && !this.host.close) return this.toggleOverlays(), true;
    if (e.code === 'Backquote' && ctrl && !e.altKey && !e.shiftKey && !this.host.close) return ((this.showGizmo = !this.showGizmo), this.drawUI()), true;

    if (e.key === 'Escape' && this.host.close && !app.modal) return this.host.close(), true;
    return false;
  }

  // ---------------------------------------------------------------------
  // Editor

  update(kinds: Set<ChangeKind>) {
    if (this.awaitingOpen && lastImage !== this.seenLastImage && lastImage) {
      this.awaitingOpen = false;
      this.seenLastImage = lastImage;
      this.setImage(lastImage);
      return;
    }
    if (this.imageId && this.imageId !== RENDER_RESULT && !virtualImages.has(this.imageId) && !app.doc.images[this.imageId]) this.imageId = null;
    if (kinds.has('doc') || kinds.has('ui')) {
      this.draw();
      this.drawUI();
    } else if (kinds.has('frame') && (this.maskEditing() || imageMedia(this.image))) this.draw();
  }

  resize() {
    this.draw();
  }

  serialize() {
    return { image: this.imageId, pass: this.pass, channel: this.channel, zoom: this.zoom, off: [this.offX, this.offY], sidebar: this.showSidebar, layer: this.layer, mode: this.uiMode ?? undefined, toolbar: this.showToolbar, toolSettings: this.showToolSettings, sampleSize: this.sampleSize, mask: this.maskId, maskTool: this.maskTool, cursor: this.cursor, pivot: this.pivot, tab: this.sidebarTab, overlays: this.overlays, viewTool: this.viewTool };
  }

  dispose() {
    this.unsub();
    this.unsubVirtual();
    clearInterval(this.timer);
  }
}

/** The New Image popup; `done` receives the new image id. */
export function newImageDialog(anchor: HTMLElement | undefined, done: (id: string) => void) {
  const p = { name: 'Untitled', width: 1024, height: 1024, color: [0, 0, 0, 1] as number[], generated_type: 'BLANK', alpha: true, tiled: false };
  const at = anchor ?? { x: app.pointer.x, y: app.pointer.y };
  const pop = openPopover(
    at,
    () =>
      h(
        'div',
        { class: 'pop-panel ie-dialog' },
        h('div', { class: 'pop-title' }, 'New Image'),
        splitRow('Name', textField('ie-new-name', p.name, (v) => (p.name = v || 'Untitled'), { live: true })),
        splitRow('Width', numberField({ id: 'ie-new-w', value: p.width, int: true, min: 1, max: 16384, unit: 'pixel', set: (v) => ((p.width = v), pop.redraw()) })),
        splitRow('Height', numberField({ id: 'ie-new-h', value: p.height, int: true, min: 1, max: 16384, unit: 'pixel', set: (v) => ((p.height = v), pop.redraw()) })),
        // dialogs use inline controls: dropdown menus/pickers would close this popover
        splitRow(
          'Color',
          h('input', {
            type: 'color',
            class: 'ie-color',
            value: '#' + colorHex(p.color).toLowerCase(),
            oninput: (e: Event) => {
              const hex = (e.target as HTMLInputElement).value;
              p.color = [1, 3, 5].map((i) => srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255)).concat(p.color[3] ?? 1);
            },
          }),
        ),
        splitRow('Alpha', numberField({ id: 'ie-new-ca', value: p.color[3] ?? 1, min: 0, max: 1, slider: true, unit: 'factor', disabled: !p.alpha, set: (v) => ((p.color[3] = v), pop.redraw()) })),
        splitRow('', checkbox('ie-new-a', 'Alpha', p.alpha, (v) => ((p.alpha = v), pop.redraw()))),
        splitRow('', checkbox('ie-new-tiled', 'Tiled', p.tiled, (v) => ((p.tiled = v), pop.redraw()), { tip: 'Make a UDIM image: add more tiles in Sidebar ▸ Image ▸ UDIM Tiles' })),
        splitRow(
          'Generated Type',
          enumRow(
            'ie-new-t',
            [
              { value: 'BLANK', label: 'Blank' },
              { value: 'UV_GRID', label: 'UV Grid' },
              { value: 'COLOR_GRID', label: 'Color Grid' },
            ],
            p.generated_type,
            (v) => ((p.generated_type = v), pop.redraw()),
          ),
        ),
        h(
          'div',
          { class: 'ie-dialog-buttons' },
          button('ie-new-ok', 'OK', () => {
            const color = [...p.color.slice(0, 3), p.alpha ? (p.color[3] ?? 1) : 1];
            app.run('image.new', { name: p.name, width: p.width, height: p.height, color, generated_type: p.generated_type, tiled: p.tiled }, { invoke: false });
            if (lastImage) done(lastImage);
            pop.el.remove();
          }),
        ),
      ),
    { width: 260 },
  );
}

let checkerPattern: CanvasPattern | null = null;
let emptyPattern: CanvasPattern | null = null;
function emptyChecker(ctx: CanvasRenderingContext2D): CanvasPattern | string {
  if (emptyPattern) return emptyPattern;
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const x = c.getContext('2d')!;
  x.fillStyle = '#28292a';
  x.fillRect(0, 0, 32, 32);
  x.fillStyle = '#303133';
  x.fillRect(0, 0, 16, 16);
  x.fillRect(16, 16, 16, 16);
  emptyPattern = ctx.createPattern(c, 'repeat');
  return emptyPattern ?? '#2b2c2e';
}

function checker(ctx: CanvasRenderingContext2D): CanvasPattern | string {
  if (checkerPattern) return checkerPattern;
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const x = c.getContext('2d')!;
  x.fillStyle = '#646567';
  x.fillRect(0, 0, 16, 16);
  x.fillStyle = '#999a9b';
  x.fillRect(0, 0, 8, 8);
  x.fillRect(8, 8, 8, 8);
  checkerPattern = ctx.createPattern(c, 'repeat');
  return checkerPattern ?? '#767778';
}

registerEditor({
  id: 'IMAGE_EDITOR',
  label: 'Image Editor',
  icon: 'image',
  group: 'General',
  create: (area, state) => new ImageEditor({ area, redrawHeader: () => area.drawHeader() }, state),
});

/** Right-click menu of the Mask mode. */
function maskContextMenu(): MenuItem[] {
  return [
    { label: 'Set Handle Type', submenu: () => (['AUTO', 'VECTOR', 'ALIGNED', 'FREE'] as const).map((type) => ({ label: type[0] + type.slice(1).toLowerCase(), op: 'mask.handle_type_set', props: { type } })) },
    { label: 'Switch Direction', op: 'mask.switch_direction' },
    { label: 'Toggle Cyclic', op: 'mask.cyclic_toggle' },
    { separator: true },
    { label: 'Copy Splines', op: 'mask.copy_splines' },
    { label: 'Paste Splines', op: 'mask.paste_splines' },
    { separator: true },
    { label: 'Re-Key Shape Points', op: 'mask.shape_key_rekey' },
    { label: 'Clear Feather Weight', op: 'mask.feather_weight_clear' },
    { label: 'Reset Feather Animation', op: 'mask.shape_key_feather_reset' },
    { separator: true },
    { label: 'Delete', op: 'mask.delete' },
  ];
}
