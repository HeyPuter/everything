// Image Editor: views image data-blocks and the Render Result (with passes), zoom/pan,
// channel display, pixel sampling, image data-block management and saving.
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
import { renderResult, passToRGBA8, samplePixel, encodeRGBA8, canvasBytes, download, toBW, EXT, virtualImages, onVirtualImageChange, RENDER_SLOTS, type PassName, type ChannelMode, type FileFormat, type RenderResult } from './result';
import { modifiedImages, type View2D } from './imageops';
import { scopesPanel } from './scopes';
import { lastOpPanel } from '../../ui/redo';
import { formatTime } from './units';
import type { ViewSettings } from './colormanage';

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

/** Render Result layer shown: the post-processed (composited) image or the raw view layer passes. */
export type ResultLayer = 'COMPOSITE' | 'VIEW_LAYER';
function resultLayer(r: RenderResult | null, layer: ResultLayer): RenderResult | null {
  if (!r?.viewLayer) return r;
  return layer === 'VIEW_LAYER' ? { ...r, passes: r.viewLayer } : { ...r, passes: { Combined: r.passes.Combined } };
}

function sceneView(r: RenderResult | null): ViewSettings {
  if (r?.view) return r.view;
  const s = app.doc.scene.render;
  return { view_transform: s.view_transform, exposure: s.exposure, gamma: s.gamma };
}

export class ImageEditor implements Editor, View2D {
  el: HTMLElement;
  keymaps = ['Image Generic', 'Image', 'Frames', 'Window', 'Screen'];
  imageId: string | null = null;
  pass: PassName = 'Combined';
  channel: ChannelMode = 'COLOR_ALPHA';
  layer: ResultLayer = 'COMPOSITE';
  zoom = 1;
  offX = 0;
  offY = 0;
  fitted = false;
  showSidebar = false;
  sidebarTab = 'Image';
  private canvas: HTMLCanvasElement;
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
    const st = (state ?? {}) as { render?: boolean; image?: string | null; pass?: PassName; channel?: ChannelMode; zoom?: number; off?: [number, number]; sidebar?: boolean; layer?: ResultLayer };
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
    return this.imageId && this.imageId !== RENDER_RESULT ? app.doc.images[this.imageId] ?? null : null;
  }

  get result(): RenderResult | null {
    if (this.imageId === RENDER_RESULT) return resultLayer(renderResult.get(), this.layer);
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
    return (['Combined', 'Depth', 'Normal', 'Mist'] as PassName[]).filter((p) => r.passes[p]);
  }

  private sourceKey(): string {
    const r = this.result;
    if (r) {
      const v = sceneView(r);
      return `R${this.imageId}|${this.imageId === RENDER_RESULT ? renderResult.slot : ''}|${r.version}|${this.layer}|${this.pass}|${this.channel}|${v.view_transform}|${v.exposure}|${v.gamma}|${r.width}x${r.height}`;
    }
    const img = this.image;
    if (!img) return '';
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
      const src = imageCanvas(img);
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

  /** Canvas with the pixels as displayed (for scopes). */
  displayCanvas(): HTMLCanvasElement | null {
    return this.source();
  }

  private imageSize(): [number, number] | null {
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
    const s = this.imageSize() ?? [1, 1];
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
    ctx.fillStyle = '#303030';
    ctx.fillRect(0, 0, w, hh);
    this.lastKey = this.sourceKey();
    const src = this.source();
    const size = this.imageSize();
    if (!src || !size) return;
    if (!this.fitted) {
      this.fitted = true;
      const z = Math.min((w - 20) / size[0], (hh - 20) / size[1]);
      // like the reference: start at 1:1 unless the image does not fit
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
    // sample cross-hair
    if (this.sample) {
      const sx = x + (Math.floor(this.sample.x) + 0.5) * this.zoom,
        sy = y + (Math.floor(this.sample.y) + 0.5) * this.zoom;
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx - 8, sy);
      ctx.lineTo(sx + 8, sy);
      ctx.moveTo(sx, sy - 8);
      ctx.lineTo(sx, sy + 8);
      ctx.stroke();
    }
  }

  drawUI() {
    const r = this.result;
    const info: Child[] = [];
    if (r) {
      const i = r.info;
      const text = i.status ?? [`Frame:${i.frame}`, `Time:${formatTime(i.time)}`, i.engine, i.samples && i.maxSamples && i.maxSamples > 1 ? `Samples:${i.samples}` : '', i.camera ? `Camera:${i.camera}` : ''].filter(Boolean).join(' | ');
      info.push(h('div', { class: 'ie-meta', key: 'meta' }, text));
    } else if (this.imageId === RENDER_RESULT) info.push(h('div', { class: 'ie-meta', key: 'meta' }, 'Render Result is empty: press F12 to render'));
    else if (this.imageId && virtualImages.has(this.imageId)) info.push(h('div', { class: 'ie-meta', key: 'meta' }, `${virtualImages.get(this.imageId)!.label} is empty`));
    patch(this.ui, [...info, this.sampleBar(), this.showSidebar ? this.sidebar() : null, this.host.area ? lastOpPanel(this) : null]);
  }

  private sampleBar(): Child {
    if (!this.sample) return null;
    const x = Math.floor(this.sample.x),
      y = Math.floor(this.sample.y);
    const f = (v: number) => v.toFixed(3);
    const r = this.result;
    let parts: Child[] = [];
    if (r) {
      const s = samplePixel(r, this.pass, x, y, sceneView(r));
      if (!s) return null;
      if (this.pass === 'Combined') {
        parts = [`R:${f(s.raw[0])}`, `G:${f(s.raw[1])}`, `B:${f(s.raw[2])}`, `A:${f(s.raw[3])}`];
        if (s.display) parts.push(h('span', { class: 'ie-cm' }, `CM R:${f(s.display[0])} G:${f(s.display[1])} B:${f(s.display[2])}`));
      } else if (this.pass === 'Normal') parts = [`X:${f(s.raw[0])}`, `Y:${f(s.raw[1])}`, `Z:${f(s.raw[2])}`];
      else parts = [`${this.pass === 'Depth' ? 'Z' : 'V'}:${s.raw[0] >= 1e9 ? '∞' : f(s.raw[0])}`];
      if (s.depth !== undefined && this.pass !== 'Depth') parts.push(`Z:${s.depth >= 1e9 ? '∞' : f(s.depth)}`);
    } else {
      const img = this.image;
      if (!img) return null;
      const c = imageCanvas(img);
      if (x < 0 || y < 0 || x >= c.width || y >= c.height) return null;
      const p = c.getContext('2d', { willReadFrequently: true })!.getImageData(x, y, 1, 1).data;
      parts = [`R:${p[0]}`, `G:${p[1]}`, `B:${p[2]}`, `A:${p[3]}`, h('span', { class: 'ie-cm' }, `${f(p[0] / 255)} ${f(p[1] / 255)} ${f(p[2] / 255)} ${f(p[3] / 255)}`)];
    }
    return h('div', { class: 'ie-sample', key: 'sample' }, h('span', null, `X:${x} Y:${y}`), ...parts.map((p) => h('span', null, p)));
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
    const passItems = this.passes().map((p) => ({ value: p, label: p }));
    return h(
      'div',
      { class: 'hdr-row ie-header' },
      menu('View', () => this.viewMenu()),
      menu('Image', () => this.imageMenu()),
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
      fullResult?.viewLayer
        ? enumMenu(
            'ie-layer',
            [
              { value: 'COMPOSITE', label: 'Composite', description: 'The post-processed (composited) image' },
              { value: 'VIEW_LAYER', label: 'View Layer', description: 'The render passes of the view layer' },
            ],
            this.layer,
            (v) => ((this.layer = v as ResultLayer), (this.cache = null), this.draw(), this.drawUI(), this.host.redrawHeader()),
            { tip: 'Render layer to display' },
          )
        : null,
      isRender
        ? enumMenu(
            'ie-slot',
            Array.from({ length: RENDER_SLOTS }, (_, i) => ({ value: String(i), label: `Slot ${i + 1}${renderResult.hasRender(i) ? '' : ' (empty)'}` })),
            String(renderResult.slot),
            (v) => (renderResult.setSlot(Number(v)), app.changed('ui')),
            { tip: 'Render Slot\nRenders go into the shown slot; keep earlier renders in other slots to compare them (J / Alt J, 1–8)' },
          )
        : null,
      r && passItems.length > 1 ? enumMenu('ie-pass', passItems, this.pass, (v) => ((this.pass = v as PassName), this.cache = null, this.draw(), this.drawUI(), this.host.redrawHeader()), { tip: 'Render pass to display' }) : null,
      h('div', { class: 'hdr-spacer' }),
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

  private viewMenu(): MenuItem[] {
    const items: MenuItem[] = [
      { label: 'Sidebar', checked: this.showSidebar, shortcut: 'N', action: () => this.toggleSidebar() },
      { separator: true },
      { label: 'Zoom In', op: 'image.view_zoom_in', shortcut: 'Numpad +' },
      { label: 'Zoom Out', op: 'image.view_zoom_out', shortcut: 'Numpad -' },
      { label: 'Fractional Zoom', submenu: () => RATIOS.map(([l, z]) => ({ label: `Zoom ${l}`, op: 'image.view_zoom_ratio', props: { ratio: z }, shortcut: z === 1 ? 'Numpad 1' : z < 1 ? `Numpad ${Math.round(1 / z)}` : `Ctrl Numpad ${z}` })) },
      { label: 'Zoom Region…', op: 'image.view_zoom_border', shortcut: 'Shift B' },
      { separator: true },
      { label: 'Frame All', op: 'image.view_all', props: { fit_view: false }, shortcut: 'Home' },
      { label: 'Frame All Fit', op: 'image.view_all', props: { fit_view: true }, shortcut: 'Shift Home' },
    ];
    if (this.imageId === RENDER_RESULT)
      items.push(
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
      ...(img
        ? [
            { label: 'Replace…', op: 'image.replace' },
            { label: 'Reload', shortcut: 'Alt R', action: () => this.reload() },
          ]
        : []),
      { separator: true },
      { label: 'Save', shortcut: 'Alt S', disabled: !hasPixels, action: () => this.save() },
      { label: 'Save As…', shortcut: 'Shift Alt S', disabled: !hasPixels, action: () => this.saveAsDialog() },
      { label: 'Save a Copy…', disabled: !hasPixels, action: () => this.saveAsDialog() },
      { label: 'Save All Images', op: 'image.save_all_modified' },
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

  open() {
    this.awaitingOpen = true;
    this.seenLastImage = lastImage;
    app.run('image.open');
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
      let px = passToRGBA8(r, this.pass, this.channel === 'Z' ? 'Z' : this.channel === 'ALPHA' ? 'ALPHA' : 'COLOR_ALPHA', sceneView(r), { keepAlpha: alpha && r.filmTransparent, dither: app.doc.scene.render.dither_intensity });
      if (colorMode === 'BW') px = toBW(px);
      return encodeRGBA8(px, r.width, r.height, format, { alpha, quality });
    }
    const img = this.image;
    if (!img) return null;
    const src = imageCanvas(img);
    if (colorMode === 'RGBA' && format !== 'JPEG') return canvasBytes(src, format, quality);
    const px = src.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, src.width, src.height).data;
    if (colorMode === 'BW') toBW(px);
    return encodeRGBA8(px, src.width, src.height, format, { alpha: false, quality });
  }

  private defaultName(format: FileFormat) {
    const base = this.image?.name.replace(/\.[a-z0-9]+$/i, '') ?? (this.result ? `render_${this.result.info.frame}${this.pass !== 'Combined' ? '_' + this.pass.toLowerCase() : ''}` : 'image');
    return `${base}.${EXT[format]}`;
  }

  private outputDefaults(): { format: FileFormat; colorMode: 'BW' | 'RGB' | 'RGBA' } {
    const r = app.doc.scene.render;
    if (this.result) return { format: r.file_format === 'WEBM' ? 'PNG' : r.file_format, colorMode: r.color_mode };
    const img = this.image;
    const format: FileFormat = img?.mime === 'image/jpeg' ? 'JPEG' : img?.mime === 'image/webp' ? 'WEBP' : 'PNG';
    return { format, colorMode: 'RGBA' };
  }

  async save() {
    const { format, colorMode } = this.outputDefaults();
    await this.saveWith(format, colorMode, 0.9, this.defaultName(format));
  }

  private async saveWith(format: FileFormat, colorMode: 'BW' | 'RGB' | 'RGBA', quality: number, name: string) {
    try {
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
              ],
              p.format,
              (v) => {
                p.format = v as FileFormat;
                p.name = p.name.replace(/\.[a-z0-9]+$/i, '') + '.' + EXT[p.format];
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
          p.format !== 'PNG' ? splitRow('Quality', numberField({ id: 'ie-save-q', value: p.quality, int: true, min: 1, max: 100, unit: 'percentage', slider: true, set: (v) => ((p.quality = v), pop.redraw()) })) : null,
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

  private sidebar(): Child {
    const img = this.image;
    const r = this.result;
    const body: Child[] = [];
    if (r) {
      const i = r.info;
      const row = (k: string, v: string) => splitRow(k, h('span', { class: 'ie-value' }, v));
      body.push(
        panel('ie-render', 'Image', () => [row('Source', this.sourceLabel() ?? 'Render Result'), row('Resolution', `${r.width} × ${r.height}`), row('Passes', this.passes().join(', '))]),
        ...(this.imageId === RENDER_RESULT
          ? [
              panel('ie-slots', 'Render Slots', () => [
                h(
                  'div',
                  { class: 'ie-slot-list' },
                  Array.from({ length: RENDER_SLOTS }, (_, i) =>
                    h(
                      'button',
                      { key: i, class: { 'ie-slot': true, on: renderResult.slot === i, empty: !renderResult.hasRender(i) }, onclick: () => (renderResult.setSlot(i), app.changed('ui')) },
                      `Slot ${i + 1}`,
                    ),
                  ),
                ),
                h('div', { class: 'btn-col' }, button('ie-slot-clear', 'Clear Slot', () => app.run('image.clear_render_slot', {}, { area: this.host.area ?? null }))),
              ]),
            ]
          : []),
        panel('ie-meta', 'Metadata', () => [row('Frame', String(i.frame)), row('Render Time', formatTime(i.time)), row('Engine', i.engine), i.samples ? row('Samples', `${i.samples}${i.maxSamples ? ' / ' + i.maxSamples : ''}`) : null, row('Camera', i.camera || '—'), row('Scene', i.scene)]),
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
          splitRow('Source', h('span', { class: 'ie-value' }, img.source === 'GENERATED' ? 'Generated' : img.source === 'FILE' ? 'Single Image' : img.source)),
          img.filepath ? splitRow('File', h('span', { class: 'ie-value' }, img.filepath)) : null,
          splitRow('Size', h('span', { class: 'ie-value' }, `${c.width} × ${c.height}, RGBA byte`)),
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
    const tabs = ['Image', 'Scopes'];
    const tab = tabs.includes(this.sidebarTab) ? this.sidebarTab : 'Image';
    return h(
      'div',
      { key: 'sidebar', class: 'v3d-sidebar ie-sidebar' },
      h('div', { class: 'sb-body' }, tab === 'Scopes' ? scopesPanel(this) : body),
      h(
        'div',
        { class: 'sb-tabs' },
        tabs.map((t) => h('button', { key: t, class: { 'sb-tab': true, on: t === tab }, onclick: () => ((this.sidebarTab = t), this.drawUI()) }, t)),
      ),
    );
  }

  // ---------------------------------------------------------------------
  // input

  private local(e: { clientX: number; clientY: number }) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private bind() {
    const el = this.canvas;
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
      if (e.button === 1 || (e.button === 0 && e.altKey)) {
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
      if (e.button === 0) {
        // sample the pixel under the cursor while the button is held
        el.setPointerCapture(e.pointerId);
        const update = (ev: PointerEvent) => {
          const q = this.local(ev);
          const [ix, iy] = this.toImage(q.x, q.y);
          this.sample = { x: ix, y: iy };
          this.draw();
          this.drawUI();
        };
        update(e);
        const up = () => {
          el.removeEventListener('pointermove', update);
          el.removeEventListener('pointerup', up);
          this.sample = null;
          this.draw();
          this.drawUI();
        };
        el.addEventListener('pointermove', update);
        el.addEventListener('pointerup', up);
      }
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu(this.imageMenu(), { x: e.clientX, y: e.clientY }, { title: 'Image' });
    });
  }

  onKey(e: KeyboardEvent): boolean {
    if (e.type !== 'keydown') return false;
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.code === 'KeyN' && !ctrl && !e.altKey && !e.shiftKey) return this.toggleSidebar(), true;

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
    }
  }

  resize() {
    this.draw();
  }

  serialize() {
    return { image: this.imageId, pass: this.pass, channel: this.channel, zoom: this.zoom, off: [this.offX, this.offY], sidebar: this.showSidebar, layer: this.layer };
  }

  dispose() {
    this.unsub();
    this.unsubVirtual();
    clearInterval(this.timer);
  }
}

/** The New Image popup; `done` receives the new image id. */
export function newImageDialog(anchor: HTMLElement | undefined, done: (id: string) => void) {
  const p = { name: 'Untitled', width: 1024, height: 1024, color: [0, 0, 0, 1] as number[], generated_type: 'BLANK', alpha: true };
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
            app.run('image.new', { name: p.name, width: p.width, height: p.height, color, generated_type: p.generated_type }, { invoke: false });
            if (lastImage) done(lastImage);
            pop.el.remove();
          }),
        ),
      ),
    { width: 260 },
  );
}

let checkerPattern: CanvasPattern | null = null;
function checker(ctx: CanvasRenderingContext2D): CanvasPattern | string {
  if (checkerPattern) return checkerPattern;
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const x = c.getContext('2d')!;
  x.fillStyle = '#666666';
  x.fillRect(0, 0, 16, 16);
  x.fillStyle = '#999999';
  x.fillRect(0, 0, 8, 8);
  x.fillRect(8, 8, 8, 8);
  checkerPattern = ctx.createPattern(c, 'repeat');
  return checkerPattern ?? '#777';
}

registerEditor({
  id: 'IMAGE_EDITOR',
  label: 'Image Editor',
  icon: 'image',
  group: 'General',
  create: (area, state) => new ImageEditor({ area, redrawHeader: () => area.drawHeader() }, state),
});
