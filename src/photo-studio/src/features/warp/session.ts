// Shared plumbing for the on-canvas warp workspaces (Pin Warp, Perspective
// Warp, Context Scale): choosing and preparing the target layer, the modal
// lifecycle (Enter commits, Escape cancels, any other edit commits first),
// a session-local undo stack, and live previews drawn as a temporary pixel
// layer in place of the target.
import type { Editor } from '../../editor';
import type { CanvasPointer } from '../../app/pointer';
import { registerTool } from '../../app/registry';
import { isMac } from '../../app/shortcuts';
import { findLayer, type Layer, type PhotoDocument } from '../../model/document';
import { layerLock } from '../../model/locks';
import { gridDocBounds, gridFromImage, readRGBA } from '../../model/tiles';
import type { IRect, RGBA8 } from '../../imaging/types';
import { resize } from '../../imaging/filters/resample';
import { replaceLayer } from '../transform/replace';
import { rasterizeLayer } from '../pixels';
import { refocusAfterChoice } from '../transform/focus';

let active: WarpSession | undefined;
export const currentWarp = () => active;

/** Pixels a session edits: a pixel layer's content in document space, or an
 * embedded image layer's source (placed by its layer transform). */
export type WarpTarget = { layer: Layer; kind: 'pixel'; rect: IRect; source: RGBA8 } | { layer: Layer; kind: 'image' };

/** Resolve the single selected layer for a warp. Type, shapes and fill
 * layers (and embedded images unless `allowImage`) are rasterized after the
 * user agrees. Returns undefined after explaining why not. */
export async function warpTarget(e: Editor, feature: string, allowImage: boolean): Promise<WarpTarget | undefined> {
  let l = e.selectedIds.size === 1 ? e.layer : undefined;
  if (!l) {
    e.message(`Select a single layer to use ${feature}.`);
    return;
  }
  if (l.kind === 'group' || l.kind === 'adjustment') {
    e.message(`${feature} works on pixel, image, type and shape layers, not on ${l.kind === 'group' ? 'groups' : 'adjustment layers'}.`);
    return;
  }
  if (!l.visible) {
    e.message(`Show the layer before using ${feature}.`);
    return;
  }
  if (layerLock(e.doc.layers, l.id, 'position') || layerLock(e.doc.layers, l.id, 'pixels')) {
    e.message(`Unlock the layer before using ${feature}.`);
    return;
  }
  if (l.kind === 'image' && allowImage) return { layer: l, kind: 'image' };
  if (l.kind !== 'pixel') {
    const what = l.kind === 'text' ? 'type layer' : l.kind === 'vector' ? 'shape layer' : l.kind === 'image' ? 'embedded image' : 'layer';
    const { formDialog } = await import('../../ui/dialog');
    const ok = await formDialog(`Rasterize “${l.name}”?`, [], 'Rasterize', `${feature} edits pixels. The ${what} will be converted to a pixel layer and its content will no longer be editable as before.`);
    if (!ok) return;
    await rasterizeLayer(e, l.id);
    l = e.layer;
    if (!l || l.kind !== 'pixel') return;
  }
  const b = l.pixels ? gridDocBounds(l.pixels) : null;
  if (!b) {
    e.message('The layer is empty.');
    return;
  }
  if (l.liveFilters) e.message('Warping pixels rasterizes this layer’s Live Filters (undo restores them).');
  return { layer: l, kind: 'pixel', rect: b, source: readRGBA(e.assets.tiles, l.pixels!, b) };
}

/** Reduced copy for interactive previews (`factor` = small / full). */
export function previewCopy(src: RGBA8, maxSide = 1400): { image: RGBA8; factor: number } {
  const f = Math.min(1, maxSide / Math.max(src.width, src.height));
  if (f >= 1) return { image: src, factor: 1 };
  const w = Math.max(1, Math.round(src.width * f)),
    h = Math.max(1, Math.round(src.height * f));
  return { image: resize(src, w, h, 'bilinear'), factor: w / src.width };
}

export abstract class WarpSession<S = unknown> {
  readonly base: PhotoDocument;
  protected ended = false;
  private previewDoc?: PhotoDocument;
  private previewTiles: string[] = [];
  private raf = 0;
  private settleTimer = 0;
  private previousTool: string;
  private undoStack: S[] = [];
  private redoStack: S[] = [];
  // Whether anything was changed during the session.
  protected edited = false;

  constructor(
    protected e: Editor,
    readonly tool: string,
    readonly layerId: string,
  ) {
    this.base = e.doc;
    this.previousTool = tools.has(e.tool) ? 'move' : e.tool;
  }
  get isEnded() {
    return this.ended;
  }
  get layer(): Layer | undefined {
    return findLayer(this.base.layers, this.layerId);
  }
  /** Shown on the canvas while the session runs (Editor.modal). */
  get document() {
    return this.previewDoc;
  }

  // ----- Lifecycle -----
  begin() {
    active?.apply();
    // Leave a session tool first so its deactivation cannot end this session.
    if (tools.has(this.e.tool)) this.e.setTool('move');
    active = this;
    this.e.modal = this;
    this.e.setTool(this.tool);
    this.schedule(true);
    this.e.update();
    this.e.el('#viewport').focus({ preventScroll: true });
  }
  protected end(restoreTool = true) {
    if (this.ended) return;
    this.ended = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.settleTimer);
    if (active === this) active = undefined;
    if (this.e.modal === this) this.e.modal = undefined;
    this.previewDoc = undefined;
    this.retire();
    this.dispose();
    if (restoreTool && this.e.tool === this.tool) this.e.setTool(this.previousTool);
  }
  /** Release workers and other resources when the session ends. */
  protected dispose() {}
  cancel(restoreTool = true) {
    this.end(restoreTool);
    this.e.update();
  }
  /** Commit the result as one history step (or cancel if nothing changed). */
  abstract apply(restoreTool?: boolean): void | Promise<void>;

  // ----- Session undo -----
  protected abstract snapshot(): S;
  protected abstract restore(s: S): void;
  /** Record the state before a change. */
  protected push() {
    this.edited = true;
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }
  /** Drop the last recorded state (a gesture that changed nothing). */
  protected discardPush() {
    this.undoStack.pop();
  }
  undo() {
    const s = this.undoStack.pop();
    if (!s) return false;
    this.redoStack.push(this.snapshot());
    this.restore(s);
    this.refresh(true);
    this.e.options();
    return true;
  }
  redo() {
    const s = this.redoStack.pop();
    if (!s) return false;
    this.undoStack.push(this.snapshot());
    this.restore(s);
    this.refresh(true);
    this.e.options();
    return true;
  }

  // ----- Input (overridden by sessions) -----
  pointerDown(_p: CanvasPointer) {}
  pointerMove(_p: CanvasPointer) {}
  pointerUp(_p: CanvasPointer) {}
  hover(_p: CanvasPointer): string {
    return '';
  }
  /** Session keys; return true when handled. */
  keyDown(_ev: KeyboardEvent): boolean {
    return false;
  }
  abstract options(): string;
  abstract bindOptions(el: HTMLElement): void;
  abstract overlay(): string;

  // ----- Preview -----
  /** Redraw overlay and preview; `settled` adds a sharper render shortly after. */
  protected refresh(settled: boolean) {
    this.e.overlay();
    this.schedule(settled);
  }
  protected schedule(settled: boolean) {
    if (this.ended) return;
    clearTimeout(this.settleTimer);
    if (!this.raf)
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.updatePreview(false);
      });
    if (settled) this.settleTimer = window.setTimeout(() => this.updatePreview(true), 120);
  }
  /** The preview image and the document rectangle it covers; undefined
   * shows the layer unchanged, null hides it. */
  protected abstract renderPreview(settled: boolean): { image: RGBA8; rect: IRect; alreadyFiltered?: boolean } | null | undefined;
  /** Pixels per document pixel for previews at the current zoom. */
  protected previewScale(area: number, settled: boolean) {
    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    let s = Math.min(1, this.e.zoom * dpr * (settled ? 1 : 0.75));
    const budget = settled ? 4e6 : 6e5;
    if (area * s * s > budget) s *= Math.sqrt(budget / (area * s * s));
    return Math.max(s, 0.02);
  }
  private updatePreview(settled: boolean) {
    if (this.ended) return;
    const l = this.layer;
    if (!l) return;
    const r = this.renderPreview(settled);
    const old = this.previewTiles;
    this.previewTiles = [];
    let next: Layer = l;
    if (r === null) next = { ...l, visible: false };
    else if (r) {
      const grid = gridFromImage(this.e.assets.tiles, r.image);
      this.previewTiles = Object.values(grid.tiles);
      const b = gridDocBounds(grid);
      const sx = r.rect.width / Math.max(1, r.image.width),
        sy = r.rect.height / Math.max(1, r.image.height);
      next = b
        ? {
            ...l,
            kind: 'pixel',
            pixels: grid,
            asset: undefined,
            liveSource: undefined,
            liveFilters: undefined,
            // The preview source of an embedded image already has its filters.
            filters: r.alreadyFiltered ? { brightness: 0, contrast: 0, saturation: 0, blur: 0 } : l.filters,
            transform: { x: r.rect.x + b.x * sx, y: r.rect.y + b.y * sy, width: b.width * sx, height: b.height * sy, rotation: 0 },
          }
        : { ...l, visible: false };
    }
    this.retireTiles(old);
    this.previewDoc = next === l ? undefined : replaceLayer(this.base, l.id, next);
    this.e.preview(this.previewDoc ?? this.base);
  }
  private retire() {
    this.retireTiles(this.previewTiles);
    this.previewTiles = [];
  }
  private retireTiles(ids: string[]) {
    if (!ids.length) return;
    const store = this.e.assets.tiles;
    // A render of an older preview may still be reading these tiles.
    const done = () => {
      for (const id of ids) store.delete(id);
    };
    const r = this.e.renderer;
    if (r) void r.settle().then(() => requestAnimationFrame(() => void r.settle().then(done)));
    else done();
  }
  /** Bind a `change` listener on an options bar control. */
  protected on(el: HTMLElement, id: string, fn: (value: string, target: HTMLInputElement) => void, event = 'change') {
    el.querySelector<HTMLInputElement>(`#${id}`)?.addEventListener(event, (ev) => fn((ev.target as HTMLInputElement).value, ev.target as HTMLInputElement));
  }
}

const tools = new Set<string>();
/** Register the modal tool a session kind runs under. It has no toolbar slot
 * and forwards input to the active session. */
export function registerSessionTool(id: string, label: string, icon: string) {
  tools.add(id);
  registerTool({
    id,
    label,
    icon,
    group: 'warp-session',
    options: () => currentWarp()?.options() ?? '',
    bindOptions: ({ e, el }) => {
      refocusAfterChoice(e, el);
      currentWarp()?.bindOptions(el);
    },
    activate: (e) => {
      if (!currentWarp()) queueMicrotask(() => e.tool === id && e.setTool('move'));
    },
    deactivate: () => currentWarp()?.apply(false),
    pointerDown: (_e, p) => currentWarp()?.pointerDown(p),
    pointerMove: (_e, p) => currentWarp()?.pointerMove(p),
    pointerUp: (_e, p) => currentWarp()?.pointerUp(p),
    hover: (e, p) => {
      const s = currentWarp();
      e.el('#viewport').style.cursor = s ? s.hover(p) : '';
    },
    keyDown: (_e, ev) => {
      const s = currentWarp();
      if (!s || document.querySelector('.context-menu') || (ev.target as Element).closest?.('.context-menu,.menu-pop')) return false;
      const mod = isMac ? ev.metaKey : ev.ctrlKey;
      if (s.keyDown(ev)) return true;
      if (ev.key === 'Enter') s.apply();
      else if (ev.key === 'Escape') s.cancel();
      else if (mod && ev.key.toLowerCase() === 'z') {
        if (ev.shiftKey) s.redo();
        else if (!s.undo()) s.cancel();
      } else return false;
      return true;
    },
    overlay: () => currentWarp()?.overlay() ?? '',
  });
}

/** Cancel a session whose base document changed underneath it (undo from
 * the menu, another document). */
export function watchSessions(e: Editor) {
  e.onUpdate((e) => {
    const s = currentWarp();
    if (s && e.doc !== s.base) s.cancel();
  });
}
