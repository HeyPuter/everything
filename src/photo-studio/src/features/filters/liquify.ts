// Liquify workspace: a full-screen view of the layer (or selection region)
// with warp brushes acting on a displacement field, plus face-aware editing:
// face guides (found by the browser's detector, by AI on request, or placed by
// hand) whose sliders and on-canvas handles drive landmark-anchored warps.
// Brush strokes and face warps are baked into one rendered field, so strokes
// act on the face-edited image and frozen areas protect both. Strokes
// re-render only the screen area they changed, from a reduced copy of the
// image when zoomed out; OK renders the field at full resolution in the worker
// as one history step.
import type { Editor } from '../../editor';
import { LiquifyField, type LiquifyTool } from '../../imaging/filters/liquify';
import {
  EYE_SLIDERS,
  LANDMARKS,
  LANDMARK_LABELS,
  SLIDER_GROUPS,
  SLIDER_LABELS,
  bakeFaces,
  cloneFace,
  decodeMesh,
  encodeMesh,
  faceFrame,
  faceFromBox,
  faceWarp,
  faceWarpBounds,
  forwardPoint,
  isNeutral,
  newFace,
  parseFaceAnswer,
  resampleField,
  scaleFaces,
  setSlider,
  sliderValue,
  templateFace,
  toFrame,
  unionRect,
  type EyeSlider,
  type Face,
  type FaceLandmarks,
  type FaceSlider,
  type FaceWarp,
  type LandmarkId,
  type Pt,
  type SliderKey,
} from '../../imaging/filters/liquify-face';
import { rgba8, type IRect, type Mask8, type RGBA8 } from '../../imaging/types';
import { allLayers, type Layer } from '../../model/document';
import { toRGBA8 } from '../pixels';
import { readMask, readRect } from '../../model/tiles';
import { svg } from '../../app/icons';
import { formatShortcut } from '../../app/shortcuts';
import { escapeXML } from '../../model/assets';
import { download } from '../../persistence/puter';
import {
  closeSession,
  commitSession,
  isLiveLayer,
  openSession,
  resultGrid,
  setRegion,
  type Session,
} from './apply';
import { Lane, isCancel } from './client';
import { halveRGBA, maskToRGBA } from './stack';
import './liquify.css';

type Tool = LiquifyTool | 'face' | 'freeze' | 'thaw' | 'hand' | 'zoom';
const toolList: { id: Tool; label: string; key: string; icon: string }[] = [
  { id: 'forward-warp', label: 'Forward Warp', key: 'W', icon: 'liquify-forward' },
  { id: 'reconstruct', label: 'Reconstruct', key: 'R', icon: 'history-brush' },
  { id: 'smooth', label: 'Smooth', key: 'E', icon: 'waves' },
  {
    id: 'twirl-cw',
    label: 'Twirl Clockwise (Alt: counterclockwise)',
    key: 'C',
    icon: 'rotate-cw',
  },
  { id: 'pucker', label: 'Pucker', key: 'S', icon: 'liquify-pucker' },
  { id: 'bloat', label: 'Bloat', key: 'B', icon: 'liquify-bloat' },
  { id: 'push-left', label: 'Push Left', key: 'O', icon: 'arrow-left-right' },
  { id: 'freeze', label: 'Freeze Mask', key: 'F', icon: 'lock' },
  { id: 'thaw', label: 'Thaw Mask', key: 'D', icon: 'lock-open' },
  { id: 'face', label: 'Face', key: 'A', icon: 'scan-face' },
  { id: 'hand', label: 'Hand', key: 'H', icon: 'hand' },
  { id: 'zoom', label: 'Zoom (Alt: zoom out)', key: 'Z', icon: 'zoom-in' },
];
const applyLane = new Lane('liquify');
const MESH_STEP = { small: 16, medium: 28, large: 48 } as const;
type MeshSize = keyof typeof MESH_STEP;

/** The last mesh applied with OK (brush field and face settings), for Load
 * Last Mesh. Kept for the browser session. */
let lastMesh: { field: LiquifyField; faces: Face[] } | undefined;
/** Brush and view options, remembered between openings this session. */
type Remembered = Pick<
  LiquifyWorkspace,
  | 'size'
  | 'density'
  | 'pressure'
  | 'rate'
  | 'stylus'
  | 'pinEdges'
  | 'showMesh'
  | 'meshSize'
  | 'meshColor'
  | 'showMask'
  | 'maskColor'
  | 'showFaces'
  | 'backdropFront'
  | 'backdropOpacity'
>;
let remembered: Partial<Remembered> = {};
/** For tests: forget the last mesh. */
export function resetLastMesh() {
  lastMesh = undefined;
  remembered = {};
}

export async function liquify(e: Editor) {
  if (isLiveLayer(e.layer) && !e.editingMask && !e.settings.quickMask) {
    e.message(
      'Liquify edits pixels. Rasterize the layer’s Live Filters first (paint on it or use Layer → Rasterize).',
    );
    return;
  }
  const s = await openSession(e, 'liquify', {});
  if (!s) return;
  if (s.selBounds) setRegion(s, s.selBounds);
  const raw = readRect(e.assets.tiles, s.base, s.rect);
  const src: RGBA8 = s.base.channels === 1 ? maskToRGBA(raw as Mask8) : (raw as RGBA8);
  try {
    await new LiquifyWorkspace(e, s, src).run();
  } finally {
    closeSession(s);
  }
}

/** A face handle: dragging it changes sliders along its axes (or turns, for
 * tilt). Positions are source-image points. */
type Handle = {
  id: string;
  at: Pt;
  label: string;
  axes: { key: SliderKey; dir: Pt; sens: number }[];
  /** Tilt: turning around this point changes `key` (sign: +1 or -1). */
  turn?: { center: Pt; key: SliderKey; sign: number };
};
type FaceDrag =
  | { kind: 'handle'; face: number; handle: Handle; start: Pt; values: number[]; center?: Pt }
  | { kind: 'point'; face: number; id: LandmarkId; grab: Pt; at: Pt }
  | { kind: 'move-face'; face: number; start: Pt; orig: FaceLandmarks }
  | { kind: 'similar'; face: number; id: 'eyeL' | 'eyeR'; orig: FaceLandmarks }
  | { kind: 'new'; start: Pt; cur: Pt; sx: number; sy: number };
type Snapshot = {
  dx: Float32Array;
  dy: Float32Array;
  freeze?: Uint8Array;
  faces: Face[];
  face: number;
};

class LiquifyWorkspace {
  /** Brush strokes. */
  private field: LiquifyField;
  /** What is rendered: brush strokes composed with the face warps. */
  private out: LiquifyField;
  private levels: RGBA8[];
  private freeze?: Mask8;
  private tool: Tool = 'forward-warp';
  size = 100;
  density = 50;
  pressure = 100;
  rate = 80;
  stylus = true;
  pinEdges = false;
  showMesh = false;
  meshSize: MeshSize = 'medium';
  meshColor = '#78aaff';
  showMask = true;
  maskColor = '#e62828';
  private showImage = true;
  showFaces = true;
  private backdrop?: RGBA8[];
  private showBackdrop = false;
  backdropFront = false;
  backdropOpacity = 50;
  private faces: Face[] = [];
  private faceIndex = -1;
  private nextFaceId = 1;
  private editGuide = false;
  private warp: FaceWarp = [];
  private warpBounds: IRect | null = null;
  private faceDrag?: FaceDrag;
  private hoverFace = -1;
  private hoverHandle?: string;
  private faceEditKey?: string;
  private zoom = 1;
  private ox = 0;
  private oy = 0;
  private history: Snapshot[] = [];
  private dialog!: HTMLDialogElement;
  private canvas!: HTMLCanvasElement;
  private overlay!: HTMLCanvasElement;
  private cursor!: HTMLElement;
  private image?: ImageData;
  private dirty: IRect | null = null;
  private frame = 0;
  private spaceHand = false;
  private altDown = false;
  private busy = false;
  /** Where the last brush stroke ended (Shift-click continues from it). */
  private lastDab?: { x: number; y: number; tool: Tool };
  constructor(
    private e: Editor,
    private s: Session,
    private src: RGBA8,
  ) {
    const px = src.width * src.height;
    this.field = new LiquifyField(src.width, src.height, px > 8e6 ? 6 : 4);
    this.out = this.field.clone();
    this.levels = [src];
    this.size = Math.max(10, Math.min(400, Math.round(Math.min(src.width, src.height) / 8)));
    Object.assign(this, remembered);
  }
  private level(k: number) {
    while (this.levels.length <= k)
      this.levels.push(halveRGBA(this.levels[this.levels.length - 1]));
    return this.levels[k];
  }
  run(): Promise<void> {
    this.build();
    return new Promise((resolve) => {
      const close = () => {
        const {
          size,
          density,
          pressure,
          rate,
          stylus,
          pinEdges,
          showMesh,
          meshSize,
          meshColor,
          showMask,
          maskColor,
          showFaces,
          backdropFront,
          backdropOpacity,
        } = this;
        remembered = {
          size,
          density,
          pressure,
          rate,
          stylus,
          pinEdges,
          showMesh,
          meshSize,
          meshColor,
          showMask,
          maskColor,
          showFaces,
          backdropFront,
          backdropOpacity,
        };
        cancelAnimationFrame(this.frame);
        applyLane.cancel();
        window.removeEventListener('resize', this.onResize);
        this.dialog.close();
        this.dialog.remove();
        this.e.update();
        resolve();
      };
      this.dialog.querySelector('.lq-cancel')!.addEventListener('click', close);
      this.dialog.addEventListener('cancel', (ev) => {
        ev.preventDefault();
        if (this.faceDrag) {
          // Escape abandons the drag: handle and guide drags took an undo step.
          const kind = this.faceDrag.kind;
          this.faceDrag = undefined;
          if (kind !== 'new') this.undo();
          else this.drawOverlay();
          return;
        }
        close();
      });
      this.dialog.querySelector('.lq-ok')!.addEventListener('click', async (ev) => {
        const ok = ev.currentTarget as HTMLButtonElement;
        if (this.editGuide) this.setEditGuide(false);
        if (this.out.isIdentity()) return close();
        ok.disabled = true;
        const bar = this.dialog.querySelector<HTMLElement>('.lq-progress')!;
        bar.hidden = false;
        try {
          const res = await applyLane.run(
            {
              type: 'liquify',
              job: 0,
              key: this.s.key,
              field: this.out.serialize(),
              useSelection: !!this.s.selection,
              keepAlpha: !!this.s.keepAlpha,
            },
            [this.s.key],
            (f) => bar.querySelector('progress')!.setAttribute('value', String(f)),
          );
          commitSession(this.s, resultGrid(this.s, res.tiles!), 'liquify', {}, 'Liquify');
          lastMesh = { field: this.field.clone(), faces: this.faces.map(cloneFace) };
          close();
        } catch (error) {
          ok.disabled = false;
          bar.hidden = true;
          if (!isCancel(error))
            this.e.message(error instanceof Error ? error.message : String(error));
        }
      });
      this.dialog
        .querySelector('.lq-progress button')!
        .addEventListener('click', () => applyLane.cancel());
    });
  }
  private build() {
    const d = document.createElement('dialog');
    d.className = 'liquify-dialog lq-liquify';
    d.setAttribute('aria-label', 'Liquify');
    const num = (key: string, label: string, min: number, max: number, value: number) =>
      `<div class="fp-row fp-number"><label for="lq-${key}">${label}</label><input id="lq-${key}" type="number" data-opt="${key}" min="${min}" max="${max}" value="${value}"><input type="range" data-opt="${key}" min="${min}" max="${max}" value="${value}" aria-label="${label}"></div>`;
    const faceRow = (key: FaceSlider) =>
      `<div class="fp-row fp-number"><label for="lq-f-${key}">${SLIDER_LABELS[key]}</label><input id="lq-f-${key}" type="number" data-face="${key}" min="-100" max="100" value="0"><input type="range" data-face="${key}" min="-100" max="100" value="0" aria-label="${SLIDER_LABELS[key]}"></div>`;
    const eyeRow = (key: EyeSlider) => {
      const label = SLIDER_LABELS[key],
        lower = label.toLowerCase();
      const side = (s: 'L' | 'R') => {
        const name = `${s === 'L' ? 'Left' : 'Right'} ${lower}`;
        return `<div class="lq-eye-side"><span aria-hidden="true">${s}</span><input type="range" data-face="${key}${s}" min="-100" max="100" value="0" aria-label="${name}"><input type="number" data-face="${key}${s}" min="-100" max="100" value="0" aria-label="${name} value"></div>`;
      };
      return `<div class="lq-eye-row"><div class="lq-eye-head"><span>${label}</span><button type="button" class="icon-button" data-link="${key}" aria-pressed="true" aria-label="Link left and right ${lower}" title="Link left and right">${svg('link', 13)}</button></div><div class="lq-eye-pair">${side('L')}${side('R')}</div></div>`;
    };
    const groups = SLIDER_GROUPS.map(
      (g) =>
        `<details class="lq-group" open><summary>${g.title}</summary>${g.keys.map((k) => ((EYE_SLIDERS as readonly string[]).includes(k) ? eyeRow(k as EyeSlider) : faceRow(k as FaceSlider))).join('')}</details>`,
    ).join('');
    const hasDetector = typeof (window as { FaceDetector?: unknown }).FaceDetector === 'function';
    d.innerHTML = `<div class="lq-head"><h2>Liquify</h2><span class="lq-hint" aria-live="polite"></span><div class="lq-actions"><button type="button" class="lq-cancel">Cancel</button><button type="button" class="primary lq-ok">OK</button></div></div>
<div class="lq-body">
  <div class="lq-tools" role="toolbar" aria-label="Liquify tools" aria-orientation="vertical">${toolList.map((t) => `<button type="button" class="icon-button" data-tool="${t.id}" aria-pressed="${t.id === this.tool}" title="${escapeXML(t.label)} (${t.key})" aria-label="${escapeXML(t.label)}" aria-keyshortcuts="${t.key}">${svg(t.icon, 18)}</button>`).join('')}</div>
  <div class="lq-stage"><canvas class="lq-canvas" aria-label="Liquify preview"></canvas><canvas class="lq-overlay"></canvas><div class="lq-cursor" hidden></div></div>
  <aside class="lq-props" aria-label="Liquify options">
    <section><h3>Brush Tool Options</h3>${num('size', 'Size', 1, 1500, this.size)}${num('density', 'Density', 0, 100, this.density)}${num('pressure', 'Pressure', 1, 100, this.pressure)}${num('rate', 'Rate', 0, 100, this.rate)}<label class="lq-check"><input type="checkbox" data-opt="stylus" ${this.stylus ? 'checked' : ''}> Stylus Pressure</label><label class="lq-check" title="Keep the image edges in place"><input type="checkbox" data-opt="pin" ${this.pinEdges ? 'checked' : ''}> Pin Edges</label></section>
    <section class="lq-face-section"><h3>Face-Aware Liquify</h3>
      <div class="fp-row"><label for="lq-face">Face</label><select id="lq-face" disabled><option>No faces</option></select></div>
      <div class="lq-row">${hasDetector ? '<button type="button" data-act="face-find" title="Find faces with the browser’s built-in detector (works offline)">Find Faces</button>' : ''}<button type="button" data-act="face-ai" title="Send a reduced copy of the image to the AI service to place face guides">${svg('sparkles', 13)} Find with AI</button><button type="button" data-act="face-add" title="Place a face guide by hand: drag from one eye to the other with the Face tool">Add Face</button></div>
      <p class="lq-ai-note">Find with AI sends a reduced copy of the image (at most 1024 px) to Puter’s AI service. It needs a Puter account and may use credits.</p>
      <p class="lq-face-empty">Add a face guide, then drag its handles with the Face tool (A) or use the sliders.</p>
      <label class="lq-check"><input type="checkbox" data-opt="edit-guide" disabled> Adjust Face Guide</label>
      <div class="lq-row"><button type="button" data-act="face-reset" disabled>Reset</button><button type="button" data-act="face-reset-all" disabled>Reset All</button><button type="button" data-act="face-remove" disabled>Remove Face</button></div>
      ${groups}
    </section>
    <section><h3>Load Mesh Options</h3><div class="lq-row"><button type="button" data-act="mesh-load">Load Mesh…</button><button type="button" data-act="mesh-last" ${lastMesh ? '' : 'disabled'}>Load Last Mesh</button><button type="button" data-act="mesh-save">Save Mesh…</button></div></section>
    <section><h3>Mask Options</h3>${this.maskSourceRow()}<div class="lq-row"><button type="button" data-act="mask-none">None</button><button type="button" data-act="mask-all">Mask All</button><button type="button" data-act="mask-invert">Invert All</button></div></section>
    <section><h3>View Options</h3>
      <label class="lq-check"><input type="checkbox" data-opt="image" checked> Show Image</label>
      <label class="lq-check"><input type="checkbox" data-opt="faces" ${this.showFaces ? 'checked' : ''}> Show Face Overlay</label>
      <label class="lq-check"><input type="checkbox" data-opt="mesh" ${this.showMesh ? 'checked' : ''}> Show Mesh</label>
      <div class="fp-row"><label for="lq-mesh-size">Mesh Size</label><select id="lq-mesh-size" data-opt="mesh-size">${(['small', 'medium', 'large'] as const).map((m) => `<option value="${m}" ${m === this.meshSize ? 'selected' : ''}>${m[0].toUpperCase() + m.slice(1)}</option>`).join('')}</select></div>
      <div class="fp-row"><label for="lq-mesh-color">Mesh Color</label><input id="lq-mesh-color" type="color" data-opt="mesh-color" value="${this.meshColor}"></div>
      <label class="lq-check"><input type="checkbox" data-opt="mask" ${this.showMask ? 'checked' : ''}> Show Mask</label>
      <div class="fp-row"><label for="lq-mask-color">Mask Color</label><input id="lq-mask-color" type="color" data-opt="mask-color" value="${this.maskColor}"></div>
      <label class="lq-check" title="Show the document’s other layers with the layer being liquified"><input type="checkbox" data-opt="backdrop" ${this.canBackdrop() ? '' : 'disabled'}> Show Backdrop</label>
      <div class="fp-row"><label for="lq-backdrop-mode">Backdrop</label><select id="lq-backdrop-mode" data-opt="backdrop-mode" disabled><option value="behind">Behind</option><option value="front" ${this.backdropFront ? 'selected' : ''}>In Front</option></select></div>
      <div class="fp-row fp-number"><label for="lq-backdrop-opacity">Backdrop Opacity</label><input id="lq-backdrop-opacity" type="number" data-opt="backdrop-opacity" min="0" max="100" value="${this.backdropOpacity}" disabled><input type="range" data-opt="backdrop-opacity" min="0" max="100" value="${this.backdropOpacity}" aria-label="Backdrop opacity" disabled></div>
      <div class="lq-row lq-zoom"><button type="button" class="icon-button" data-act="zoom-out" aria-label="Zoom out">${svg('minus', 14)}</button><span class="lq-zoom-label"></span><button type="button" class="icon-button" data-act="zoom-in" aria-label="Zoom in">${svg('plus', 14)}</button><button type="button" data-act="fit">Fit</button><button type="button" data-act="undo" title="Undo (${formatShortcut('Mod+Z')})">Undo</button></div>
    </section>
    <section><h3>Brush Reconstruct Options</h3><div class="lq-row"><button type="button" data-act="reconstruct">Reconstruct…</button><button type="button" data-act="restore" title="Undo every stroke and face edit">Restore All</button></div><div class="lq-reconstruct" hidden><div class="fp-row fp-number"><label for="lq-amount">Amount</label><input id="lq-amount" type="number" min="0" max="100" value="100"><input type="range" id="lq-amount-range" min="0" max="100" value="100" aria-label="Reconstruct amount"></div><div class="lq-row"><button type="button" data-act="reconstruct-cancel">Cancel</button><button type="button" class="primary" data-act="reconstruct-ok">OK</button></div></div></section>
  </aside>
</div>
<div class="lq-progress" hidden><span>Liquify…</span><progress max="1" value="0"></progress><button type="button">Cancel</button></div>`;
    document.body.append(d);
    this.dialog = d;
    this.canvas = d.querySelector('.lq-canvas')!;
    this.overlay = d.querySelector('.lq-overlay')!;
    this.cursor = d.querySelector('.lq-cursor')!;
    d.showModal();
    this.resize();
    this.fit();
    window.addEventListener('resize', this.onResize);
    this.bind();
    this.syncFaceUI();
    this.hint();
  }
  private onResize = () => {
    this.resize();
    this.redraw();
  };
  private resize() {
    const stage = this.dialog.querySelector<HTMLElement>('.lq-stage')!;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(stage.clientWidth * dpr)),
      h = Math.max(1, Math.round(stage.clientHeight * dpr));
    for (const c of [this.canvas, this.overlay]) {
      c.width = w;
      c.height = h;
    }
    this.image = undefined;
  }
  private get dpr() {
    return window.devicePixelRatio || 1;
  }
  private fit() {
    const W = this.canvas.width / this.dpr,
      H = this.canvas.height / this.dpr;
    this.zoom = Math.min(1, (W - 40) / this.src.width, (H - 40) / this.src.height);
    this.ox = this.src.width / 2 - W / 2 / this.zoom;
    this.oy = this.src.height / 2 - H / 2 / this.zoom;
    this.redraw();
  }
  private zoomAt(z: number, cx?: number, cy?: number) {
    const W = this.canvas.width / this.dpr,
      H = this.canvas.height / this.dpr;
    const sx = cx ?? W / 2,
      sy = cy ?? H / 2;
    const ix = this.ox + sx / this.zoom,
      iy = this.oy + sy / this.zoom;
    this.zoom = Math.max(1 / 32, Math.min(32, z));
    this.ox = ix - sx / this.zoom;
    this.oy = iy - sy / this.zoom;
    this.redraw();
  }
  private hint(text?: string) {
    const t = toolList.find((x) => x.id === this.tool)!;
    let msg = text;
    if (!msg && this.tool === 'face') {
      msg = this.editGuide
        ? 'Adjust Face Guide · drag a point onto its feature · drag inside the face to move the guide · Shift-drag an eye to turn and scale it · face edits are paused'
        : this.faces.length
          ? 'Face · drag a handle to reshape · click a face to select it · drag from one eye to the other to add a face'
          : 'Face · drag from one eye to the other to place a face guide';
    }
    this.dialog.querySelector('.lq-hint')!.textContent =
      msg ??
      `${t.label.replace(/ \(.*\)/, '')} · brush ${Math.round(this.size)} px · [ ] change size · Shift-click: straight line`;
    this.dialog.querySelector('.lq-zoom-label')!.textContent =
      `${Math.round(this.zoom * 1000) / 10}%`;
    for (const b of this.dialog.querySelectorAll<HTMLElement>('[data-tool]'))
      b.setAttribute('aria-pressed', String(b.dataset.tool === this.tool));
  }
  private setTool(tool: Tool) {
    this.tool = tool;
    this.hint();
    this.drawOverlay();
  }
  private setOpt(key: string, v: number) {
    if (key === 'size') this.size = Math.max(1, Math.min(1500, v));
    else if (key === 'density') this.density = Math.max(0, Math.min(100, v));
    else if (key === 'pressure') this.pressure = Math.max(1, Math.min(100, v));
    else if (key === 'rate') this.rate = Math.max(0, Math.min(100, v));
    else if (key === 'backdrop-opacity') {
      this.backdropOpacity = Math.max(0, Math.min(100, v));
      this.redraw();
    }
    for (const i of this.dialog.querySelectorAll<HTMLInputElement>(`[data-opt="${key}"]`))
      if (document.activeElement !== i)
        i.value = String(Math.round(key === 'size' ? this.size : v));
    this.hint();
  }
  // ----- Coordinates -----
  private toImage(clientX: number, clientY: number) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: this.ox + (clientX - r.left) / this.zoom,
      y: this.oy + (clientY - r.top) / this.zoom,
      sx: clientX - r.left,
      sy: clientY - r.top,
    };
  }
  /** Screen position (CSS pixels in the stage) of a source-image point. */
  private toScreen(p: Pt): Pt {
    const q = forwardPoint(this.out, p);
    return { x: (q.x - this.ox) * this.zoom, y: (q.y - this.oy) * this.zoom };
  }
  /** Source-image point shown at image point q. */
  private sourceAt(q: Pt): Pt {
    const t = this.out.displacementAt(q.x, q.y);
    return { x: q.x + t[0], y: q.y + t[1] };
  }
  // ----- Rendering -----
  private redraw() {
    this.dirty = { x: -1e9, y: -1e9, width: 2e9, height: 2e9 };
    this.schedule();
    this.hint();
  }
  private invalidate(r: IRect | null) {
    if (!r) return;
    const d = this.dirty;
    if (!d) this.dirty = r;
    else {
      const x = Math.min(d.x, r.x),
        y = Math.min(d.y, r.y);
      this.dirty = {
        x,
        y,
        width: Math.max(d.x + d.width, r.x + r.width) - x,
        height: Math.max(d.y + d.height, r.y + r.height) - y,
      };
    }
    this.schedule();
  }
  private schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }
  /** Bake brush strokes and face warps into the rendered field for `rect`
   * (everything when null) and repaint it. */
  private bake(rect: IRect | null) {
    bakeFaces(this.field, this.warp, this.out, rect, this.freeze, this.pinEdges);
    if (!rect) return this.redraw();
    const m = this.field.cellSize * 2;
    this.invalidate({
      x: rect.x - m,
      y: rect.y - m,
      width: rect.width + 2 * m,
      height: rect.height + 2 * m,
    });
  }
  /** Recompute the face warps after a face change and re-bake what moved. */
  private refreshFaces(all = false) {
    const old = this.warpBounds;
    this.warp = this.editGuide ? [] : faceWarp(this.faces);
    this.warpBounds = faceWarpBounds(this.warp);
    if (all) this.bake(null);
    else {
      const r = unionRect(old, this.warpBounds);
      if (r) this.bake(r);
    }
    this.drawOverlay();
  }
  /** Render the dirty image rectangle at screen resolution. */
  private paint() {
    const d = this.dirty;
    this.dirty = null;
    if (!d) return;
    const W = this.canvas.width,
      H = this.canvas.height;
    const scr = this.zoom * this.dpr;
    if (!this.image || this.image.width !== W || this.image.height !== H)
      this.image = new ImageData(W, H);
    let sx0 = Math.max(0, Math.floor((d.x - this.ox) * scr) - 2),
      sy0 = Math.max(0, Math.floor((d.y - this.oy) * scr) - 2),
      sx1 = Math.min(W, Math.ceil((d.x + d.width - this.ox) * scr) + 2),
      sy1 = Math.min(H, Math.ceil((d.y + d.height - this.oy) * scr) + 2);
    if (sx1 <= sx0 || sy1 <= sy0) return this.drawOverlay();
    // Displacement is sampled every G screen pixels and interpolated between,
    // on a grid fixed to the canvas so partial repaints match full ones.
    const G = 4;
    sx0 -= sx0 % G;
    sy0 -= sy0 % G;
    const k = Math.max(0, Math.min(8, Math.floor(Math.log2(1 / scr) + 1e-9)));
    const lv = this.level(k),
      f = 2 ** -k;
    const lw = lv.width,
      lh = lv.height,
      ld = lv.data;
    const out = this.image.data;
    const field = this.out;
    const iw = this.src.width,
      ih = this.src.height;
    const freeze = this.showMask ? this.freeze : undefined;
    const [mr, mg, mb] = hexRGB(this.maskColor);
    const showImage = this.showImage;
    const keep = !!this.s.keepAlpha;
    const bdl = this.showBackdrop && this.backdrop ? this.backdropLevel(k) : undefined;
    const bd = bdl?.data,
      bw = bdl?.width ?? 0,
      bh = bdl?.height ?? 0,
      bop = this.backdropOpacity / 100,
      front = this.backdropFront;
    const t = new Float64Array(2);
    const cols = Math.ceil((sx1 - sx0) / G) + 2;
    const rowA = new Float32Array(cols * 2),
      rowB = new Float32Array(cols * 2);
    const sampleRow = (row: Float32Array, sy: number) => {
      const qy = this.oy + (sy + 0.5) / scr;
      for (let c = 0; c < cols; c++) {
        field.displacementAt(this.ox + (sx0 + c * G + 0.5) / scr, qy, t);
        row[c * 2] = t[0];
        row[c * 2 + 1] = t[1];
      }
    };
    const smooth = scr > 1.5;
    for (let gy = sy0; gy < sy1; gy += G) {
      sampleRow(rowA, gy);
      sampleRow(rowB, gy + G);
      const yEnd = Math.min(sy1, gy + G);
      for (let sy = gy; sy < yEnd; sy++) {
        const fy = (sy - gy) / G;
        const qy = this.oy + (sy + 0.5) / scr;
        let o = (sy * W + sx0) * 4;
        for (let sx = sx0; sx < sx1; sx++, o += 4) {
          const qx = this.ox + (sx + 0.5) / scr;
          if (qx < 0 || qy < 0 || qx >= iw || qy >= ih) {
            out[o + 3] = 0;
            continue;
          }
          let r = 0,
            g = 0,
            b = 0,
            al = 0;
          if (showImage) {
            const c = ((sx - sx0) / G) | 0,
              fx = (sx - sx0 - c * G) / G;
            const a0 = rowA[c * 2] + (rowA[c * 2 + 2] - rowA[c * 2]) * fx,
              b0 = rowB[c * 2] + (rowB[c * 2 + 2] - rowB[c * 2]) * fx;
            const a1 = rowA[c * 2 + 1] + (rowA[c * 2 + 3] - rowA[c * 2 + 1]) * fx,
              b1 = rowB[c * 2 + 1] + (rowB[c * 2 + 3] - rowB[c * 2 + 1]) * fx;
            let px = (qx + a0 + (b0 - a0) * fy) * f - 0.5,
              py = (qy + a1 + (b1 - a1) * fy) * f - 0.5;
            px = px < 0 ? 0 : px > lw - 1 ? lw - 1 : px;
            py = py < 0 ? 0 : py > lh - 1 ? lh - 1 : py;
            if (smooth) {
              const x0 = px | 0,
                y0 = py | 0,
                x1 = x0 + 1 < lw ? x0 + 1 : x0,
                y1 = y0 + 1 < lh ? y0 + 1 : y0,
                ax = px - x0,
                ay = py - y0;
              const i00 = (y0 * lw + x0) * 4,
                i10 = (y0 * lw + x1) * 4,
                i01 = (y1 * lw + x0) * 4,
                i11 = (y1 * lw + x1) * 4;
              const w00 = (1 - ax) * (1 - ay),
                w10 = ax * (1 - ay),
                w01 = (1 - ax) * ay,
                w11 = ax * ay;
              r = ld[i00] * w00 + ld[i10] * w10 + ld[i01] * w01 + ld[i11] * w11;
              g = ld[i00 + 1] * w00 + ld[i10 + 1] * w10 + ld[i01 + 1] * w01 + ld[i11 + 1] * w11;
              b = ld[i00 + 2] * w00 + ld[i10 + 2] * w10 + ld[i01 + 2] * w01 + ld[i11 + 2] * w11;
              al = ld[i00 + 3] * w00 + ld[i10 + 3] * w10 + ld[i01 + 3] * w01 + ld[i11 + 3] * w11;
            } else {
              const i = ((py + 0.5) | 0) * lw * 4 + ((px + 0.5) | 0) * 4;
              r = ld[i];
              g = ld[i + 1];
              b = ld[i + 2];
              al = ld[i + 3];
            }
          }
          if (keep && showImage) {
            // Locked transparency: the warp moves colors, not coverage.
            const j = (Math.min(lh - 1, (qy * f) | 0) * lw + Math.min(lw - 1, (qx * f) | 0)) * 4;
            if (al === 0 || ld[j + 3] === 0) {
              r = ld[j];
              g = ld[j + 1];
              b = ld[j + 2];
            }
            al = ld[j + 3];
          }
          if (bd) {
            // The other layers, unwarped, behind or in front at an opacity.
            const j = (Math.min(bh - 1, (qy * f) | 0) * bw + Math.min(bw - 1, (qx * f) | 0)) * 4;
            const ba = (bd[j + 3] / 255) * bop,
              la = al / 255;
            const top = front ? ba : la,
              under = front ? la : ba;
            const oa = top + under * (1 - top);
            if (oa > 0) {
              const wt = top / oa,
                wu = (under * (1 - top)) / oa;
              r = front ? bd[j] * wt + r * wu : r * wt + bd[j] * wu;
              g = front ? bd[j + 1] * wt + g * wu : g * wt + bd[j + 1] * wu;
              b = front ? bd[j + 2] * wt + b * wu : b * wt + bd[j + 2] * wu;
            }
            al = oa * 255;
          }
          if (freeze) {
            const m = freeze.data[(qy | 0) * iw + (qx | 0)];
            if (m) {
              // Frozen areas show a translucent tint (opaque over transparency).
              const k2 = (m / 255) * 0.5;
              r = r * (1 - k2) + mr * k2;
              g = g * (1 - k2) + mg * k2;
              b = b * (1 - k2) + mb * k2;
              al = al + (255 - al) * k2;
            }
          }
          out[o] = r;
          out[o + 1] = g;
          out[o + 2] = b;
          out[o + 3] = al;
        }
      }
    }
    this.canvas.getContext('2d')!.putImageData(this.image, 0, 0, sx0, sy0, sx1 - sx0, sy1 - sy0);
    this.drawOverlay();
  }
  private drawOverlay() {
    const ctx = this.overlay.getContext('2d')!;
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    if (this.showMesh) this.drawMesh(ctx);
    if (this.showFaces && (this.tool === 'face' || this.editGuide)) this.drawFaces(ctx);
  }
  private drawMesh(ctx: CanvasRenderingContext2D) {
    const scr = this.zoom * this.dpr;
    const cs = this.field.cellSize;
    const step = cs * Math.max(1, Math.ceil((MESH_STEP[this.meshSize] * this.dpr) / (cs * scr)));
    const t = new Float64Array(2);
    const iw = this.src.width,
      ih = this.src.height;
    const x0 = Math.max(0, Math.floor(this.ox / step) * step),
      y0 = Math.max(0, Math.floor(this.oy / step) * step);
    const x1 = Math.min(iw, this.ox + this.overlay.width / scr),
      y1 = Math.min(ih, this.oy + this.overlay.height / scr);
    // Mesh lines are drawn where the source grid moved to (approximately q - d(q)).
    const pt = (x: number, y: number): [number, number] => {
      this.out.displacementAt(x, y, t);
      return [(x - t[0] - this.ox) * scr, (y - t[1] - this.oy) * scr];
    };
    ctx.strokeStyle = this.meshColor;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const fine = Math.max(1, step / 4);
    for (let y = y0; y <= y1; y += step) {
      let first = true;
      for (let x = x0; x <= x1 + fine; x += fine) {
        const [px, py] = pt(Math.min(x, iw), y);
        if (first) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
        first = false;
      }
    }
    for (let x = x0; x <= x1; x += step) {
      let first = true;
      for (let y = y0; y <= y1 + fine; y += fine) {
        const [px, py] = pt(x, Math.min(y, ih));
        if (first) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
        first = false;
      }
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  // ----- Faces -----
  private get face(): Face | undefined {
    return this.faces[this.faceIndex];
  }
  /** On-canvas handles of a face (positions in the source image). */
  private handles(face: Face): Handle[] {
    const lm = face.landmarks;
    const { u, v, D } = faceFrame(lm);
    const at = (p: Pt, a: number, b: number): Pt => ({
      x: p.x + (u.x * a + v.x * b) * D,
      y: p.y + (u.y * a + v.y * b) * D,
    });
    const dir = (a: number, b: number): Pt => ({ x: u.x * a + v.x * b, y: u.y * a + v.y * b });
    const out: Handle[] = [];
    for (const [s, S, eye] of [
      [-1, 'L', lm.eyeL],
      [1, 'R', lm.eyeR],
    ] as const) {
      const side = S === 'L' ? 'left' : 'right';
      out.push(
        {
          id: `eye${S}`,
          at: eye,
          label: `Move ${side} eye (height and distance)`,
          axes: [
            { key: `eyeHeight${S}`, dir: dir(0, -1), sens: 0.12 * D },
            { key: `eyeDistance${S}`, dir: dir(s, 0), sens: 0.1 * D },
          ],
        },
        {
          id: `eyeSize${S}`,
          at: at(eye, 0, -0.28),
          label: `${side} eye size`,
          axes: [{ key: `eyeSize${S}`, dir: dir(0, -1), sens: 0.2 * D }],
        },
        {
          id: `eyeWidth${S}`,
          at: at(eye, s * 0.34, 0),
          label: `${side} eye width`,
          axes: [{ key: `eyeWidth${S}`, dir: dir(s, 0), sens: 0.2 * D }],
        },
        {
          id: `eyeTilt${S}`,
          at: at(eye, s * 0.3, -0.24),
          label: `${side} eye tilt`,
          axes: [],
          turn: { center: eye, key: `eyeTilt${S}`, sign: -s },
        },
        {
          id: `nose${S}`,
          at: at(lm.nose, s * 0.2, -0.04),
          label: 'Nose width',
          axes: [{ key: 'noseWidth', dir: dir(s, 0), sens: 0.12 * D }],
        },
        {
          id: `mouth${S}`,
          at: S === 'L' ? lm.mouthL : lm.mouthR,
          label: 'Smile and mouth width',
          axes: [
            { key: 'smile', dir: dir(0, -1), sens: 0.09 * D },
            { key: 'mouthWidth', dir: dir(s, 0), sens: 0.15 * D },
          ],
        },
        {
          id: `jaw${S}`,
          at: S === 'L' ? lm.jawL : lm.jawR,
          label: 'Jawline',
          axes: [{ key: 'jawline', dir: dir(s, 0), sens: 0.12 * D }],
        },
        {
          id: `cheek${S}`,
          at: at(lm.nose, s * (Math.abs(faceCoord(lm, lm.jawR)[0]) + 0.08), -0.25),
          label: 'Face width',
          axes: [{ key: 'faceWidth', dir: dir(s, 0), sens: 0.15 * D }],
        },
      );
    }
    out.push(
      {
        id: 'nose',
        at: lm.nose,
        label: 'Nose height',
        axes: [{ key: 'noseHeight', dir: dir(0, -1), sens: 0.1 * D }],
      },
      {
        id: 'lipTop',
        at: lm.lipTop,
        label: 'Upper lip',
        axes: [{ key: 'upperLip', dir: dir(0, -1), sens: 0.06 * D }],
      },
      {
        id: 'lipBottom',
        at: lm.lipBottom,
        label: 'Lower lip',
        axes: [{ key: 'lowerLip', dir: dir(0, 1), sens: 0.06 * D }],
      },
      {
        id: 'forehead',
        at: lm.forehead,
        label: 'Forehead',
        axes: [{ key: 'forehead', dir: dir(0, -1), sens: 0.2 * D }],
      },
      {
        id: 'chin',
        at: lm.chin,
        label: 'Chin height',
        axes: [{ key: 'chinHeight', dir: dir(0, 1), sens: 0.15 * D }],
      },
    );
    return out;
  }
  /** Outline ellipse of a face in source coordinates. */
  private outline(face: Face) {
    const lm = face.landmarks;
    const f = faceFrame(lm);
    const top = faceCoord(lm, lm.forehead)[1],
      bottom = faceCoord(lm, lm.chin)[1];
    const half =
      Math.max(0.7, Math.abs(faceCoord(lm, lm.jawR)[0] - faceCoord(lm, lm.jawL)[0]) / 2) * 1.12;
    const cy = (top + bottom) / 2;
    return { f, cy, rx: half, ry: Math.max(0.8, (bottom - top) / 2) * 1.04 };
  }
  private faceAt(q: Pt): number {
    const p = this.sourceAt(q);
    for (let i = this.faces.length - 1; i >= 0; i--) {
      const { f, cy, rx, ry } = this.outline(this.faces[i]);
      const dx = p.x - f.o.x,
        dy = p.y - f.o.y;
      const a = (dx * f.u.x + dy * f.u.y) / f.D,
        b = (dx * f.v.x + dy * f.v.y) / f.D - cy;
      if ((a / rx) ** 2 + (b / ry) ** 2 <= 1) return i;
    }
    return -1;
  }
  /** Handle (or guide point) under screen point (sx, sy) of the shown face. */
  private hitHandle(
    sx: number,
    sy: number,
  ): { face: number; handle?: Handle; point?: LandmarkId } | undefined {
    const order = [this.hoverFace, this.faceIndex].filter(
      (i, k, a) => i >= 0 && a.indexOf(i) === k,
    );
    for (const fi of order) {
      const face = this.faces[fi];
      if (!face) continue;
      if (this.editGuide) {
        for (const id of [...LANDMARKS].reverse()) {
          const s = this.toScreen(face.landmarks[id]);
          if (Math.hypot(s.x - sx, s.y - sy) <= 8) return { face: fi, point: id };
        }
      } else
        for (const h of this.handles(face)) {
          const s = this.toScreen(h.at);
          if (Math.hypot(s.x - sx, s.y - sy) <= 8) return { face: fi, handle: h };
        }
    }
    return undefined;
  }
  private drawFaces(ctx: CanvasRenderingContext2D) {
    const dpr = this.dpr;
    ctx.save();
    ctx.scale(dpr, dpr);
    const accent = getComputedStyle(this.dialog).getPropertyValue('--accent').trim() || '#3d8bfd';
    const scr = (p: Pt) => this.toScreen(p);
    const dot = (p: Pt, r: number, fill: string, square = false) => {
      ctx.beginPath();
      if (square) ctx.rect(p.x - r, p.y - r, 2 * r, 2 * r);
      else ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#000';
      ctx.stroke();
    };
    this.faces.forEach((face, fi) => {
      const active = fi === this.faceIndex || fi === this.hoverFace;
      const { f, cy, rx, ry } = this.outline(face);
      // Face outline (sampled ellipse, drawn where the warp moved it).
      ctx.beginPath();
      for (let n = 0; n <= 48; n++) {
        const t = (n / 48) * Math.PI * 2;
        const a = Math.cos(t) * rx,
          b = cy + Math.sin(t) * ry;
        const p = scr({
          x: f.o.x + (f.u.x * a + f.v.x * b) * f.D,
          y: f.o.y + (f.u.y * a + f.v.y * b) * f.D,
        });
        if (n) ctx.lineTo(p.x, p.y);
        else ctx.moveTo(p.x, p.y);
      }
      ctx.setLineDash(active ? [] : [5, 4]);
      ctx.lineWidth = active ? 1.5 : 1;
      ctx.strokeStyle = active ? accent : 'rgba(255,255,255,0.75)';
      ctx.stroke();
      ctx.setLineDash([]);
      // Face number, for the face picker.
      const label = scr({ x: face.landmarks.forehead.x, y: face.landmarks.forehead.y });
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 3;
      ctx.strokeText(`${fi + 1}`, label.x + 6, label.y - 6);
      ctx.fillText(`${fi + 1}`, label.x + 6, label.y - 6);
      if (!active) return;
      if (this.editGuide) {
        const lm = face.landmarks;
        ctx.beginPath();
        const line = (a: LandmarkId, b: LandmarkId) => {
          const p = scr(lm[a]),
            q = scr(lm[b]);
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(q.x, q.y);
        };
        line('eyeL', 'eyeR');
        line('mouthL', 'mouthR');
        line('lipTop', 'lipBottom');
        line('jawL', 'chin');
        line('chin', 'jawR');
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 1;
        ctx.stroke();
        for (const id of LANDMARKS)
          dot(scr(lm[id]), id === 'eyeL' || id === 'eyeR' ? 5 : 4, '#ffd34d');
        return;
      }
      for (const h of this.handles(face)) {
        const p = scr(h.at);
        const hot = this.hoverHandle === `${fi}:${h.id}`;
        dot(p, hot ? 5.5 : 4, hot ? accent : '#fff', !!h.turn || h.axes.length > 1);
      }
    });
    const nd = this.faceDrag;
    if (nd?.kind === 'new') {
      const a = { x: (nd.start.x - this.ox) * this.zoom, y: (nd.start.y - this.oy) * this.zoom },
        b = { x: (nd.cur.x - this.ox) * this.zoom, y: (nd.cur.y - this.oy) * this.zoom };
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      const r = Math.hypot(b.x - a.x, b.y - a.y) * 0.18;
      for (const p of [a, b]) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(3, r), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  private addFace(lm: FaceLandmarks, source: Face['source']) {
    const face = newFace(this.nextFaceId++, lm, source);
    this.faces.push(face);
    this.faceIndex = this.faces.length - 1;
  }
  private syncFaceUI() {
    const d = this.dialog;
    const face = this.face;
    const sel = d.querySelector<HTMLSelectElement>('#lq-face')!;
    sel.innerHTML = this.faces.length
      ? this.faces.map((_, i) => `<option value="${i}">Face ${i + 1}</option>`).join('')
      : '<option>No faces</option>';
    sel.disabled = !this.faces.length;
    if (face) sel.value = String(this.faceIndex);
    d.querySelector<HTMLElement>('.lq-face-empty')!.hidden = !!this.faces.length;
    const guide = d.querySelector<HTMLInputElement>('[data-opt="edit-guide"]')!;
    guide.disabled = !face;
    guide.checked = this.editGuide;
    for (const act of ['face-reset', 'face-remove'])
      d.querySelector<HTMLButtonElement>(`[data-act="${act}"]`)!.disabled = !face;
    d.querySelector<HTMLButtonElement>('[data-act="face-reset-all"]')!.disabled = !this.faces.some(
      (f) => !isNeutral(f),
    );
    for (const i of d.querySelectorAll<HTMLInputElement>('[data-face]')) {
      i.disabled = !face || this.editGuide;
      if (document.activeElement !== i || i.type === 'range')
        i.value = String(face ? sliderValue(face, i.dataset.face as SliderKey) : 0);
    }
    for (const b of d.querySelectorAll<HTMLButtonElement>('[data-link]')) {
      const key = b.dataset.link as EyeSlider;
      const on = face ? face.linked[key] : true;
      b.disabled = !face || this.editGuide;
      b.setAttribute('aria-pressed', String(on));
      b.innerHTML = svg(on ? 'link' : 'unlink', 13);
    }
    for (const g of d.querySelectorAll<HTMLElement>('.lq-group'))
      g.setAttribute('aria-disabled', String(!face || this.editGuide));
    if (!this.busy) this.hint();
  }
  private setEditGuide(on: boolean) {
    if (this.editGuide === on) return;
    this.editGuide = on;
    if (on && this.tool !== 'face') this.tool = 'face';
    this.refreshFaces();
    this.syncFaceUI();
    this.hint();
  }
  /** Built-in (offline) face detection, where the browser provides it. */
  private async findFaces() {
    type Detected = {
      boundingBox: DOMRectReadOnly;
      landmarks?: { type: 'eye' | 'mouth' | 'nose'; locations: { x: number; y: number }[] }[];
    };
    const FD = (
      window as unknown as {
        FaceDetector?: new (o: object) => { detect(i: ImageBitmap): Promise<Detected[]> };
      }
    ).FaceDetector;
    if (!FD) return;
    const k = this.levelFor(2048);
    const img = this.level(k),
      scale = 2 ** k;
    await this.busyWhile('Finding faces…', async () => {
      const bmp = await createImageBitmap(
        new ImageData(new Uint8ClampedArray(img.data), img.width, img.height),
      );
      const found = await new FD({ fastMode: false, maxDetectedFaces: 12 }).detect(bmp);
      bmp.close();
      const list = found.map((r) => {
        const pts = (r.landmarks ?? []).flatMap((l) => {
          const n = l.locations.length || 1;
          const x = l.locations.reduce((s, p) => s + p.x, 0) / n,
            y = l.locations.reduce((s, p) => s + p.y, 0) / n;
          return [{ kind: l.type, x: x * scale, y: y * scale }];
        });
        const b = r.boundingBox;
        return faceFromBox(
          { x: b.x * scale, y: b.y * scale, width: b.width * scale, height: b.height * scale },
          pts,
        );
      });
      this.addFound(list, 'detected');
    });
  }
  /** Ask the AI service for face landmarks (explicit user command only). */
  private async findFacesWithAI() {
    const k = this.levelFor(2048);
    const img = this.level(k),
      scale = 2 ** k;
    await this.busyWhile('Finding faces with AI…', async () => {
      const [{ ensureSignedIn }, { locateFaces }] = await Promise.all([
        import('../retouch/ai'),
        import('../../imaging/ai/puter-ai'),
      ]);
      await ensureSignedIn();
      const answer = await locateFaces(img);
      const list = parseFaceAnswer(answer, img.width, img.height).map((lm) => {
        for (const id of LANDMARKS) lm[id] = { x: lm[id].x * scale, y: lm[id].y * scale };
        return lm;
      });
      this.addFound(list, 'ai');
    });
  }
  /** Freeze-mask sources this session offers. */
  private maskSources(): { id: 'selection' | 'transparency' | 'layer-mask'; label: string }[] {
    const out: { id: 'selection' | 'transparency' | 'layer-mask'; label: string }[] = [];
    if (this.s.selection) out.push({ id: 'selection', label: 'Selection' });
    if (this.s.target.kind === 'pixels') {
      out.push({ id: 'transparency', label: 'Layer Transparency' });
      if (this.s.target.layer.maskGrid) out.push({ id: 'layer-mask', label: 'Layer Mask' });
    }
    return out;
  }
  private maskSourceRow() {
    const list = this.maskSources();
    if (!list.length) return '';
    const ops = [
      ['replace', 'Replace', 'Freeze exactly the source'],
      ['add', 'Add', 'Add the source to the freeze mask'],
      ['subtract', 'Subtract', 'Thaw where the source is'],
      ['intersect', 'Intersect', 'Keep the freeze mask only where the source is'],
    ];
    return `<div class="fp-row"><label for="lq-mask-src">Freeze From</label><select id="lq-mask-src">${list.map((m) => `<option value="${m.id}">${m.label}</option>`).join('')}</select></div><div class="lq-row" role="group" aria-label="Combine with the freeze mask">${ops.map(([id, label, title]) => `<button type="button" data-act="mask-${id}" title="${title}">${label}</button>`).join('')}</div>`;
  }
  /** Coverage (0..255) of a freeze-mask source over the workspace image. */
  private maskSource(id: string): Uint8Array | undefined {
    const { src, s } = this;
    const store = this.e.assets.tiles;
    if (id === 'selection' && s.selection) return readMask(store, s.selection, s.rect).data;
    if (id === 'transparency') {
      const out = new Uint8Array(src.width * src.height);
      for (let i = 0; i < out.length; i++) out[i] = src.data[i * 4 + 3];
      return out;
    }
    if (id === 'layer-mask' && s.target.kind === 'pixels' && s.target.layer.maskGrid) {
      const m = readMask(store, s.target.layer.maskGrid, s.rect).data;
      if (s.target.layer.maskInverted) for (let i = 0; i < m.length; i++) m[i] = 255 - m[i];
      return m;
    }
  }
  private combineMask(op: string) {
    const id = this.dialog.querySelector<HTMLSelectElement>('#lq-mask-src')?.value;
    const m = id ? this.maskSource(id) : undefined;
    if (!m) return;
    this.snapshot();
    const n = this.src.width * this.src.height;
    const cur = this.freeze?.data ?? new Uint8Array(n);
    for (let i = 0; i < n; i++)
      cur[i] =
        op === 'replace'
          ? m[i]
          : op === 'add'
            ? Math.max(cur[i], m[i])
            : op === 'subtract'
              ? Math.max(0, cur[i] - m[i])
              : Math.min(cur[i], m[i]);
    this.freeze = { width: this.src.width, height: this.src.height, data: cur };
    this.bake(null);
  }
  /** Backdrop: other layers exist and the target is a layer's pixels. */
  private canBackdrop() {
    const doc = this.e.doc;
    return (
      this.s.target.kind === 'pixels' && allLayers(doc.layers).filter((l) => l.visible).length > 1
    );
  }
  private backdropLevel(k: number) {
    const lv = this.backdrop!;
    while (lv.length <= k) lv.push(halveRGBA(lv[lv.length - 1]));
    return lv[k];
  }
  private async setBackdrop(on: boolean) {
    for (const el of this.dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      '[data-opt="backdrop-mode"], [data-opt="backdrop-opacity"]',
    ))
      el.disabled = !on;
    this.showBackdrop = on;
    if (on && !this.backdrop) {
      const target = this.s.target;
      if (target.kind !== 'pixels') return;
      const id = target.layer.id;
      const doc = this.e.doc;
      const hide = (layers: Layer[]): Layer[] =>
        layers.map((l) =>
          l.id === id
            ? { ...l, visible: false }
            : l.children.length
              ? { ...l, children: hide(l.children) }
              : l,
        );
      const samples = await this.e.renderer.documentPixels(
        { ...doc, selection: null, layers: hide(doc.layers) },
        this.e.assets,
      );
      this.backdrop = [cropRGBA(toRGBA8(samples, doc.width, doc.height), this.s.rect)];
    }
    this.redraw();
  }
  private levelFor(maxSide: number) {
    let k = 0;
    while (Math.max(this.src.width, this.src.height) / 2 ** k > maxSide) k++;
    return k;
  }
  private async busyWhile(label: string, fn: () => Promise<void>) {
    if (this.busy) return;
    this.busy = true;
    this.dialog.classList.add('lq-busy');
    const btns = this.dialog.querySelectorAll<HTMLButtonElement>(
      '[data-act="face-find"], [data-act="face-ai"]',
    );
    for (const b of btns) b.disabled = true;
    this.hint(label);
    try {
      await fn();
    } catch (error) {
      // A search still running when Liquify closed reports nothing.
      if (this.dialog.isConnected)
        this.e.message(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy = false;
      this.dialog.classList.remove('lq-busy');
      for (const b of btns) b.disabled = false;
      this.hint();
    }
  }
  /** Add found faces that are not already guided. */
  private addFound(list: FaceLandmarks[], source: Face['source']) {
    // Faces that arrive after Liquify closed (Cancel during Find with AI)
    // belong to no workspace any more.
    if (!this.dialog.isConnected) return;
    let added = 0;
    for (const lm of list) {
      const c = { x: (lm.eyeL.x + lm.eyeR.x) / 2, y: (lm.eyeL.y + lm.eyeR.y) / 2 };
      const D = Math.hypot(lm.eyeR.x - lm.eyeL.x, lm.eyeR.y - lm.eyeL.y);
      const dup = this.faces.some((f) => {
        const o = faceFrame(f.landmarks).o;
        return Math.hypot(o.x - c.x, o.y - c.y) < D * 0.6;
      });
      if (dup) continue;
      if (!added) this.snapshot();
      this.addFace(lm, source);
      added++;
    }
    if (added) {
      if (this.tool !== 'face') this.tool = 'face';
      this.refreshFaces();
      this.syncFaceUI();
    }
    const msg = added
      ? `Found ${added} face${added > 1 ? 's' : ''}. Check each guide with Adjust Face Guide.`
      : list.length
        ? 'Every face found already has a guide.'
        : 'No faces were found. Use Add Face to place a guide by hand.';
    this.e.message(msg);
  }
  private faceDown(ev: PointerEvent, p: { x: number; y: number; sx: number; sy: number }) {
    const hit = this.hitHandle(p.sx, p.sy);
    if (hit) {
      this.endReconstruct();
      this.snapshot();
      this.faceIndex = hit.face;
      const face = this.faces[hit.face];
      if (hit.point) {
        if (ev.shiftKey && (hit.point === 'eyeL' || hit.point === 'eyeR'))
          this.faceDrag = {
            kind: 'similar',
            face: hit.face,
            id: hit.point,
            orig: cloneFace(face).landmarks,
          };
        else
          this.faceDrag = {
            kind: 'point',
            face: hit.face,
            id: hit.point,
            grab: { x: p.x, y: p.y },
            at: { ...face.landmarks[hit.point] },
          };
      } else if (hit.handle) {
        const h = hit.handle;
        const keys = h.turn ? [h.turn.key] : h.axes.map((a) => a.key);
        const center = h.turn ? forwardPoint(this.out, h.turn.center) : undefined;
        this.faceDrag = {
          kind: 'handle',
          face: hit.face,
          handle: h,
          start: { x: p.x, y: p.y },
          values: keys.map((k) => sliderValue(face, k)),
          center,
        };
      }
      this.syncFaceUI();
      this.drawOverlay();
      return;
    }
    const fi = this.faceAt(p);
    if (fi >= 0) {
      this.faceIndex = fi;
      if (this.editGuide) {
        this.snapshot();
        this.faceDrag = {
          kind: 'move-face',
          face: fi,
          start: { x: p.x, y: p.y },
          orig: cloneFace(this.faces[fi]).landmarks,
        };
      }
      this.syncFaceUI();
      this.drawOverlay();
      return;
    }
    this.faceDrag = {
      kind: 'new',
      start: { x: p.x, y: p.y },
      cur: { x: p.x, y: p.y },
      sx: p.sx,
      sy: p.sy,
    };
  }
  private faceMove(p: { x: number; y: number; sx: number; sy: number }, shift: boolean) {
    const drag = this.faceDrag!;
    if (drag.kind === 'new') {
      drag.cur = { x: p.x, y: p.y };
      this.drawOverlay();
      return;
    }
    const face = this.faces[drag.face];
    if (!face) return;
    if (drag.kind === 'handle') {
      const h = drag.handle;
      if (h.turn && drag.center) {
        const a0 = Math.atan2(drag.start.y - drag.center.y, drag.start.x - drag.center.x),
          a1 = Math.atan2(p.y - drag.center.y, p.x - drag.center.x);
        let da = a1 - a0;
        if (da > Math.PI) da -= 2 * Math.PI;
        if (da < -Math.PI) da += 2 * Math.PI;
        setSlider(face, h.turn.key, drag.values[0] + ((h.turn.sign * da) / 0.25) * 100);
      } else {
        const dx = p.x - drag.start.x,
          dy = p.y - drag.start.y;
        h.axes.forEach((a, i) => {
          // Only the dominant axis of a two-way handle moves, unless Shift is held.
          if (h.axes.length > 1 && !shift) {
            const other = h.axes[1 - i];
            if (
              Math.abs(dx * a.dir.x + dy * a.dir.y) / a.sens <
              Math.abs(dx * other.dir.x + dy * other.dir.y) / other.sens
            ) {
              setSlider(face, a.key, drag.values[i]);
              return;
            }
          }
          setSlider(face, a.key, drag.values[i] + ((dx * a.dir.x + dy * a.dir.y) / a.sens) * 100);
        });
      }
      this.refreshFaces();
      this.syncFaceUI();
      return;
    }
    // Guide editing: faces are paused, so the shown image is the brush result.
    const src = this.sourceAt(p);
    if (drag.kind === 'point') {
      const g = this.sourceAt(drag.grab);
      face.landmarks[drag.id] = { x: drag.at.x + src.x - g.x, y: drag.at.y + src.y - g.y };
    } else if (drag.kind === 'move-face') {
      const s0 = this.sourceAt(drag.start);
      for (const id of LANDMARKS)
        face.landmarks[id] = {
          x: drag.orig[id].x + src.x - s0.x,
          y: drag.orig[id].y + src.y - s0.y,
        };
    } else if (drag.kind === 'similar') {
      // Turn and scale the whole guide around the other eye.
      const pivot = drag.orig[drag.id === 'eyeL' ? 'eyeR' : 'eyeL'],
        from = drag.orig[drag.id];
      const ax = from.x - pivot.x,
        ay = from.y - pivot.y,
        bx = src.x - pivot.x,
        by = src.y - pivot.y;
      const l2 = ax * ax + ay * ay;
      if (l2 < 1e-6 || bx * bx + by * by < 4) return;
      const c = (ax * bx + ay * by) / l2,
        s = (ax * by - ay * bx) / l2;
      for (const id of LANDMARKS) {
        const ox = drag.orig[id].x - pivot.x,
          oy = drag.orig[id].y - pivot.y;
        face.landmarks[id] = { x: pivot.x + ox * c - oy * s, y: pivot.y + ox * s + oy * c };
      }
    }
    // Keep left and right in picture order.
    const lm = face.landmarks;
    if (lm.eyeR.x < lm.eyeL.x && drag.kind !== 'similar') {
      const t = lm.eyeL;
      lm.eyeL = lm.eyeR;
      lm.eyeR = t;
      if (drag.kind === 'point' && (drag.id === 'eyeL' || drag.id === 'eyeR'))
        drag.id = drag.id === 'eyeL' ? 'eyeR' : 'eyeL';
    }
    this.drawOverlay();
  }
  private faceUp() {
    const drag = this.faceDrag;
    this.faceDrag = undefined;
    if (!drag) return;
    if (drag.kind === 'new') {
      const len = Math.hypot(drag.cur.x - drag.start.x, drag.cur.y - drag.start.y) * this.zoom;
      if (len >= 12) {
        this.endReconstruct();
        this.snapshot();
        this.addFace(templateFace(this.sourceAt(drag.start), this.sourceAt(drag.cur)), 'manual');
        this.refreshFaces();
        this.syncFaceUI();
        this.e.message(
          'Face guide placed. Turn on Adjust Face Guide to fit its points to the face.',
        );
      } else this.drawOverlay();
      return;
    }
    this.refreshFaces();
    this.syncFaceUI();
  }
  // ----- Masks -----
  private dabMask(x: number, y: number, add: boolean, strength: number) {
    const iw = this.src.width,
      ih = this.src.height;
    if (!this.freeze) {
      if (!add) return null;
      this.freeze = { width: iw, height: ih, data: new Uint8Array(iw * ih) };
    }
    const R = this.size / 2,
      hard = this.density / 100;
    const x0 = Math.max(0, Math.floor(x - R)),
      x1 = Math.min(iw - 1, Math.ceil(x + R)),
      y0 = Math.max(0, Math.floor(y - R)),
      y1 = Math.min(ih - 1, Math.ceil(y + R));
    const m = this.freeze.data;
    for (let py = y0; py <= y1; py++)
      for (let px = x0; px <= x1; px++) {
        const dist = Math.hypot(px + 0.5 - x, py + 0.5 - y) / R;
        if (dist >= 1) continue;
        const w =
          ((1 - hard) * 0.5 * (1 + Math.cos(Math.PI * dist)) + hard * Math.min(1, (1 - dist) * 4)) *
          strength;
        const i = py * iw + px;
        m[i] = add ? Math.max(m[i], Math.round(255 * w)) : Math.max(0, Math.round(m[i] - 255 * w));
      }
    return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  }
  private snapshot() {
    // Steps that leave the field or the mask alone (face edits) share the
    // previous step's copies; snapshots are never written to.
    const prev = this.history[this.history.length - 1];
    const f = this.field;
    const freeze = this.freeze?.data;
    this.history.push({
      dx: prev && sameArray(prev.dx, f.dx) ? prev.dx : new Float32Array(f.dx),
      dy: prev && sameArray(prev.dy, f.dy) ? prev.dy : new Float32Array(f.dy),
      freeze: !freeze
        ? undefined
        : prev?.freeze && sameArray(prev.freeze, freeze)
          ? prev.freeze
          : new Uint8Array(freeze),
      faces: this.faces.map(cloneFace),
      face: this.faceIndex,
    });
    // Field snapshots can be large; keep the most recent few.
    if (this.history.length > 10) this.history.shift();
  }
  private undo() {
    this.endReconstruct();
    const h = this.history.pop();
    if (!h) return;
    this.field.dx.set(h.dx);
    this.field.dy.set(h.dy);
    // The step may have removed the mask (Mask None), so restore it as a whole.
    this.freeze = h.freeze && {
      width: this.src.width,
      height: this.src.height,
      data: new Uint8Array(h.freeze),
    };
    this.faces = h.faces;
    this.faceIndex = Math.min(h.face, this.faces.length - 1);
    if (!this.faces.length && this.editGuide) this.editGuide = false;
    this.refreshFaces(true);
    this.syncFaceUI();
  }
  // ----- Input -----
  private activeTool(): Tool {
    if (this.spaceHand) return 'hand';
    if (this.tool === 'twirl-cw' && this.altDown) return 'twirl-ccw';
    return this.tool;
  }
  private bind() {
    const d = this.dialog;
    d.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement;
      const tool = t.closest<HTMLElement>('[data-tool]')?.dataset.tool as Tool | undefined;
      if (tool) {
        this.setTool(tool);
        return;
      }
      const link = t.closest<HTMLButtonElement>('[data-link]');
      if (link && this.face) {
        const key = link.dataset.link as EyeSlider;
        this.snapshot();
        this.face.linked[key] = !this.face.linked[key];
        // Linking makes the right eye follow the left.
        if (this.face.linked[key])
          setSlider(this.face, `${key}L`, sliderValue(this.face, `${key}L`));
        this.refreshFaces();
        this.syncFaceUI();
        return;
      }
      const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act) void this.action(act);
    });
    d.addEventListener('change', (ev) => {
      const t = ev.target as HTMLInputElement | HTMLSelectElement;
      if (t.id === 'lq-face') {
        this.faceIndex = Number(t.value);
        this.syncFaceUI();
        this.drawOverlay();
      } else if (t.dataset.opt === 'backdrop-mode') {
        this.backdropFront = t.value === 'front';
        this.redraw();
      } else if (t.dataset.opt === 'mesh-size') {
        this.meshSize = t.value as MeshSize;
        this.drawOverlay();
      } else if (t.dataset.face) this.faceEditKey = undefined;
    });
    d.addEventListener('input', (ev) => {
      const t = ev.target as HTMLInputElement;
      const key = t.dataset.opt;
      const faceKey = t.dataset.face as SliderKey | undefined;
      if (faceKey) {
        const face = this.face;
        if (!face || t.value === '' || !Number.isFinite(Number(t.value))) return;
        if (this.faceEditKey !== faceKey) {
          this.endReconstruct();
          this.snapshot();
          this.faceEditKey = faceKey;
        }
        setSlider(face, faceKey, Number(t.value));
        this.refreshFaces();
        this.syncFaceUI();
        return;
      }
      if (key === 'stylus') this.stylus = t.checked;
      else if (key === 'pin') {
        this.pinEdges = t.checked;
        this.bake(null);
      } else if (key === 'mesh') {
        this.showMesh = t.checked;
        this.drawOverlay();
      } else if (key === 'mesh-color') {
        this.meshColor = t.value;
        this.drawOverlay();
      } else if (key === 'mask') {
        this.showMask = t.checked;
        this.redraw();
      } else if (key === 'mask-color') {
        this.maskColor = t.value;
        this.redraw();
      } else if (key === 'image') {
        this.showImage = t.checked;
        this.redraw();
      } else if (key === 'backdrop') void this.setBackdrop(t.checked);
      else if (key === 'faces') {
        this.showFaces = t.checked;
        this.drawOverlay();
      } else if (key === 'edit-guide') this.setEditGuide(t.checked);
      else if (key && key !== 'mesh-size' && key !== 'backdrop-mode' && t.value !== '')
        this.setOpt(key, Number(t.value));
      else if (t.id === 'lq-amount' || t.id === 'lq-amount-range') {
        const v = Math.max(0, Math.min(100, Number(t.value) || 0));
        d.querySelector<HTMLInputElement>(
          t.id === 'lq-amount' ? '#lq-amount-range' : '#lq-amount',
        )!.value = String(v);
        this.previewReconstruct(v / 100);
      }
    });
    d.addEventListener('keydown', (ev) => this.key(ev, true));
    d.addEventListener('keyup', (ev) => this.key(ev, false));
    const c = this.canvas;
    let stroke:
      | {
          x: number;
          y: number;
          tool: Tool;
          sx: number;
          sy: number;
          ox: number;
          oy: number;
          pressure: number;
          timer: number;
          last: number;
        }
      | undefined;
    // Stationary tools (twirl, pucker, bloat, reconstruct, smooth) work at a
    // rate in time: one full dab per interval whether the pointer rests or moves.
    const INTERVAL = 33;
    const pressureOf = (ev: PointerEvent) =>
      (this.pressure / 100) *
      (this.stylus && ev.pointerType === 'pen' ? Math.max(0.05, ev.pressure) : 1);
    c.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      c.setPointerCapture(ev.pointerId);
      const p = this.toImage(ev.clientX, ev.clientY);
      const tool = this.activeTool();
      if (tool === 'zoom') {
        this.zoomAt(this.zoom * (ev.altKey ? 0.5 : 2), p.sx, p.sy);
        return;
      }
      if (tool === 'face') {
        this.faceDown(ev, p);
        return;
      }
      if (tool !== 'hand') {
        this.endReconstruct();
        this.snapshot();
      }
      const from = this.lastDab;
      stroke = {
        x: p.x,
        y: p.y,
        tool,
        sx: ev.clientX,
        sy: ev.clientY,
        ox: this.ox,
        oy: this.oy,
        pressure: pressureOf(ev),
        timer: 0,
        last: performance.now(),
      };
      if (tool !== 'hand' && ev.shiftKey && from && from.tool === tool) {
        // Shift-click: a straight stroke from the last brush point.
        const dx = p.x - from.x,
          dy = p.y - from.y;
        const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / Math.max(1, this.size * 0.1)));
        for (let i = 1; i <= n; i++)
          this.dab(
            tool,
            from.x + (dx * i) / n,
            from.y + (dy * i) / n,
            dx / n,
            dy / n,
            stroke.pressure,
          );
      } else if (tool !== 'hand') {
        this.dab(stroke.tool, p.x, p.y, 0, 0, stroke.pressure);
        // Stationary tools keep working while the button is held.
        if (!['forward-warp', 'push-left'].includes(tool))
          stroke.timer = window.setTimeout(tick, INTERVAL);
      }
    });
    const tick = () => {
      if (!stroke) return;
      this.dab(stroke.tool, stroke.x, stroke.y, 0, 0, stroke.pressure);
      stroke.last = performance.now();
      stroke.timer = window.setTimeout(tick, INTERVAL);
    };
    c.addEventListener('pointermove', (ev) => {
      this.moveCursor(ev);
      if (this.activeTool() === 'face' && !stroke) {
        const p = this.toImage(ev.clientX, ev.clientY);
        if (this.faceDrag) this.faceMove(p, ev.shiftKey);
        else this.faceHover(p);
        return;
      }
      if (!stroke) return;
      if (stroke.tool === 'hand') {
        this.ox = stroke.ox - (ev.clientX - stroke.sx) / this.zoom;
        this.oy = stroke.oy - (ev.clientY - stroke.sy) / this.zoom;
        this.redraw();
        return;
      }
      const events = typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : [ev];
      for (const ce of events.length ? events : [ev]) {
        const p = this.toImage(ce.clientX, ce.clientY);
        stroke.pressure = pressureOf(ce);
        const dx = p.x - stroke.x,
          dy = p.y - stroke.y;
        const dist = Math.hypot(dx, dy);
        // Dabs every ~10% of the brush keep strokes even at any speed.
        const spacing = Math.max(1, this.size * 0.1);
        const push = ['forward-warp', 'push-left'].includes(stroke.tool);
        if (dist < spacing && push) continue;
        const n = Math.max(1, Math.ceil(dist / spacing));
        // Stationary tools spread the time since their last dab along the move.
        let strength = 1;
        // (Freeze and Thaw paint the mask along the stroke like a brush.)
        if (!push && stroke.tool !== 'freeze' && stroke.tool !== 'thaw') {
          const now = performance.now();
          strength = Math.min(1, (now - stroke.last) / INTERVAL) / n;
          stroke.last = now;
          clearTimeout(stroke.timer);
          stroke.timer = window.setTimeout(tick, INTERVAL);
        }
        for (let i = 1; i <= n; i++) {
          const x = stroke.x + (dx * i) / n,
            y = stroke.y + (dy * i) / n;
          this.dab(stroke.tool, x, y, dx / n, dy / n, stroke.pressure * strength);
        }
        stroke.x = p.x;
        stroke.y = p.y;
      }
    });
    const end = () => {
      if (stroke) clearTimeout(stroke.timer);
      if (stroke && stroke.tool !== 'hand')
        this.lastDab = { x: stroke.x, y: stroke.y, tool: stroke.tool };
      stroke = undefined;
      if (this.faceDrag) this.faceUp();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      this.cursor.hidden = true;
      if (this.hoverFace >= 0 && !this.faceDrag) {
        this.hoverFace = -1;
        this.hoverHandle = undefined;
        this.drawOverlay();
      }
    });
    c.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        const p = this.toImage(ev.clientX, ev.clientY);
        if (ev.ctrlKey || ev.metaKey || ev.altKey)
          this.zoomAt(this.zoom * (ev.deltaY < 0 ? 1.25 : 0.8), p.sx, p.sy);
        else {
          this.ox += ev.deltaX / this.zoom;
          this.oy += ev.deltaY / this.zoom;
          this.redraw();
        }
      },
      { passive: false },
    );
  }
  private faceHover(p: { x: number; y: number; sx: number; sy: number }) {
    const hit = this.hitHandle(p.sx, p.sy);
    const fi = hit ? hit.face : this.faceAt(p);
    const hh = hit ? `${hit.face}:${hit.handle?.id ?? hit.point}` : undefined;
    const label = hit?.handle?.label ?? (hit?.point ? LANDMARK_LABELS[hit.point] : undefined);
    this.canvas.style.cursor = hit
      ? 'grab'
      : fi >= 0
        ? this.editGuide
          ? 'move'
          : 'pointer'
        : 'crosshair';
    this.canvas.title = label ? label[0].toUpperCase() + label.slice(1) : '';
    if (fi !== this.hoverFace || hh !== this.hoverHandle) {
      this.hoverFace = fi;
      this.hoverHandle = hh;
      this.drawOverlay();
    }
  }
  private moveCursor(ev: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    const tool = this.activeTool();
    const brush = tool !== 'hand' && tool !== 'zoom' && tool !== 'face';
    this.cursor.hidden = !brush;
    if (tool !== 'face') {
      this.canvas.style.cursor = tool === 'hand' ? 'grab' : tool === 'zoom' ? 'zoom-in' : 'none';
      this.canvas.title = '';
    }
    if (!brush) return;
    const dpx = this.size * this.zoom;
    Object.assign(this.cursor.style, {
      width: `${dpx}px`,
      height: `${dpx}px`,
      left: `${ev.clientX - r.left - dpx / 2}px`,
      top: `${ev.clientY - r.top - dpx / 2}px`,
    });
  }
  private dab(tool: Tool, x: number, y: number, dx: number, dy: number, pressure: number) {
    if (tool === 'freeze' || tool === 'thaw') {
      const r = this.dabMask(x, y, tool === 'freeze', pressure);
      // The mask also weights face edits, so re-bake under it.
      if (r && this.warp.length) this.bake(r);
      else this.invalidate(r);
      return;
    }
    if (tool === 'hand' || tool === 'zoom' || tool === 'face') return;
    const r = this.field.applyBrush(
      tool,
      x,
      y,
      dx,
      dy,
      this.size,
      pressure,
      this.density,
      this.rate,
      this.freeze,
    );
    if (r) this.bake(r);
  }
  private key(ev: KeyboardEvent, down: boolean) {
    this.altDown = ev.altKey;
    const target = ev.target as HTMLElement;
    if (
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLInputElement && target.type !== 'checkbox' && target.type !== 'range')
    )
      return;
    if (ev.code === 'Space') {
      this.spaceHand = down;
      ev.preventDefault();
      return;
    }
    if (!down) return;
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      this.undo();
      return;
    }
    if ((ev.metaKey || ev.ctrlKey) && (ev.key === '=' || ev.key === '+' || ev.key === '-')) {
      ev.preventDefault();
      this.zoomAt(this.zoom * (ev.key === '-' ? 0.5 : 2));
      return;
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.key === '0') {
      ev.preventDefault();
      this.fit();
      return;
    }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    // Arrow keys belong to range sliders.
    if (target instanceof HTMLInputElement && target.type === 'range' && ev.key.startsWith('Arrow'))
      return;
    if (ev.key === '[' || ev.key === ']') {
      this.setOpt('size', this.size * (ev.key === ']' ? 1.15 : 1 / 1.15));
      ev.preventDefault();
      return;
    }
    if (ev.key === 'Enter' && !(target instanceof HTMLButtonElement)) {
      ev.preventDefault();
      this.dialog.querySelector<HTMLButtonElement>('.lq-ok')!.click();
      return;
    }
    const t = toolList.find((x) => x.key === ev.key.toUpperCase());
    if (t) {
      this.setTool(t.id);
      ev.preventDefault();
    }
  }
  private reconstructBase?: { dx: Float32Array; dy: Float32Array };
  /** Keep the reconstruction being previewed (its OK): later edits build on
   * it, so the Amount slider can no longer rewind them. */
  private endReconstruct() {
    if (!this.reconstructBase) return;
    this.reconstructBase = undefined;
    this.dialog.querySelector<HTMLElement>('.lq-reconstruct')!.hidden = true;
  }
  private async action(act: string) {
    const box = this.dialog.querySelector<HTMLElement>('.lq-reconstruct')!;
    if (!act.startsWith('reconstruct-') && !act.startsWith('zoom') && act !== 'fit')
      this.endReconstruct();
    const face = this.face;
    switch (act) {
      case 'reconstruct':
        this.snapshot();
        this.reconstructBase = {
          dx: new Float32Array(this.field.dx),
          dy: new Float32Array(this.field.dy),
        };
        box.hidden = false;
        this.previewReconstruct(
          Number(this.dialog.querySelector<HTMLInputElement>('#lq-amount')!.value) / 100,
        );
        break;
      case 'reconstruct-ok':
        this.endReconstruct();
        break;
      case 'reconstruct-cancel':
        if (this.reconstructBase) {
          this.field.dx.set(this.reconstructBase.dx);
          this.field.dy.set(this.reconstructBase.dy);
          this.history.pop();
        }
        this.reconstructBase = undefined;
        box.hidden = true;
        this.bake(null);
        break;
      case 'restore':
        this.snapshot();
        this.field.dx.fill(0);
        this.field.dy.fill(0);
        for (const f of this.faces) f.sliders = {};
        this.refreshFaces(true);
        this.syncFaceUI();
        break;
      case 'mask-replace':
      case 'mask-add':
      case 'mask-subtract':
      case 'mask-intersect':
        this.combineMask(act.slice(5));
        break;
      case 'mask-none':
        this.snapshot();
        this.freeze = undefined;
        this.bake(null);
        break;
      case 'mask-all':
        this.snapshot();
        this.freeze = {
          width: this.src.width,
          height: this.src.height,
          data: new Uint8Array(this.src.width * this.src.height).fill(255),
        };
        this.bake(null);
        break;
      case 'mask-invert':
        this.snapshot();
        if (!this.freeze)
          this.freeze = {
            width: this.src.width,
            height: this.src.height,
            data: new Uint8Array(this.src.width * this.src.height).fill(255),
          };
        else
          for (let i = 0; i < this.freeze.data.length; i++)
            this.freeze.data[i] = 255 - this.freeze.data[i];
        this.bake(null);
        break;
      case 'face-find':
        await this.findFaces();
        break;
      case 'face-ai':
        await this.findFacesWithAI();
        break;
      case 'face-add':
        this.setTool('face');
        this.hint('Face · drag from one eye to the other to place a face guide');
        this.canvas.focus();
        break;
      case 'face-reset':
        if (!face || isNeutral(face)) break;
        this.snapshot();
        face.sliders = {};
        this.refreshFaces();
        this.syncFaceUI();
        break;
      case 'face-reset-all':
        this.snapshot();
        for (const f of this.faces) f.sliders = {};
        this.refreshFaces();
        this.syncFaceUI();
        break;
      case 'face-remove':
        if (!face) break;
        this.snapshot();
        this.faces.splice(this.faceIndex, 1);
        this.faceIndex = Math.min(this.faceIndex, this.faces.length - 1);
        if (!this.faces.length) this.editGuide = false;
        this.refreshFaces();
        this.syncFaceUI();
        this.hint();
        break;
      case 'mesh-save':
        download(
          new Blob([encodeMesh(this.field, this.faces) as BlobPart], {
            type: 'application/octet-stream',
          }),
          `${(this.e.doc.name || 'Untitled').replace(/\.[^.]+$/, '')}.lqmesh`,
        );
        break;
      case 'mesh-load':
        this.pickMesh();
        break;
      case 'mesh-last':
        if (lastMesh) this.loadMesh(lastMesh.field, lastMesh.faces);
        break;
      case 'zoom-in':
        this.zoomAt(this.zoom * 2);
        break;
      case 'zoom-out':
        this.zoomAt(this.zoom / 2);
        break;
      case 'fit':
        this.fit();
        break;
      case 'undo':
        this.undo();
        break;
    }
  }
  private pickMesh() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.lqmesh';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const { field, faces } = decodeMesh(new Uint8Array(await file.arrayBuffer()));
        this.loadMesh(field, faces);
      } catch (error) {
        this.e.message(error instanceof Error ? error.message : String(error));
      }
    });
    input.click();
  }
  /** Replace strokes and faces with a saved mesh (scaled to this image). */
  private loadMesh(field: LiquifyField, faces: Face[]) {
    this.endReconstruct();
    this.snapshot();
    const W = this.src.width,
      H = this.src.height;
    const same = field.width === W && field.height === H && field.cellSize === this.field.cellSize;
    const f = same ? field : resampleField(field, W, H, this.field.cellSize);
    this.field.dx.set(f.dx);
    this.field.dy.set(f.dy);
    const scaled = same
      ? faces.map(cloneFace)
      : scaleFaces(faces, W / field.width, H / field.height);
    this.faces = scaled.map((x) => ({ ...x, id: this.nextFaceId++ }));
    this.faceIndex = this.faces.length ? 0 : -1;
    this.editGuide = false;
    this.refreshFaces(true);
    this.syncFaceUI();
  }
  /** Reconstruct toward the original by `amount`, sparing frozen areas. */
  private previewReconstruct(amount: number) {
    const base = this.reconstructBase;
    if (!base) return;
    this.field.dx.set(base.dx);
    this.field.dy.set(base.dy);
    let region: Mask8 | undefined;
    if (this.freeze) {
      region = {
        width: this.freeze.width,
        height: this.freeze.height,
        data: new Uint8Array(this.freeze.data.length),
      };
      for (let i = 0; i < region.data.length; i++) region.data[i] = 255 - this.freeze.data[i];
    }
    this.field.reconstruct(amount, region);
    this.bake(null);
  }
}

/** Frame coordinates of a landmark (in eye distances). */
const faceCoord = (lm: FaceLandmarks, p: Pt) => toFrame(faceFrame(lm), p);
function cropRGBA(img: RGBA8, r: IRect): RGBA8 {
  if (r.x === 0 && r.y === 0 && r.width === img.width && r.height === img.height) return img;
  const out = rgba8(r.width, r.height);
  for (let y = 0; y < r.height; y++) {
    const sy = r.y + y;
    if (sy < 0 || sy >= img.height) continue;
    const x0 = Math.max(0, r.x),
      x1 = Math.min(img.width, r.x + r.width);
    if (x1 > x0)
      out.data.set(
        img.data.subarray((sy * img.width + x0) * 4, (sy * img.width + x1) * 4),
        (y * r.width + x0 - r.x) * 4,
      );
  }
  return out;
}
function sameArray(a: ArrayLike<number>, b: ArrayLike<number>) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function hexRGB(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const n = m ? parseInt(m[1], 16) : 0xe62828;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
