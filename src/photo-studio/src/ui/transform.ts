import type { Editor } from '../editor';
import { selectedRoots, assertEditable } from '../model/layers';
import { hitLayer } from './hit-test';
import { snapMove, smartGuidesSvg, snapOptions, type MoveGuides } from '../features/view-extras';
import { expandLinked, followLinkedMasks } from '../model/links';
import { setLayerPixels } from '../model/pixel-layer';
import { hexRgb } from '../features/pixels';
import { hideReadout, lengthText, showReadout } from '../features/preferences/readouts';
import {
  findLayer,
  localPoint,
  type Layer,
  type PhotoDocument,
  type Transform,
} from '../model/document';
import type { Assets } from '../model/assets';
import { gridDocBounds, gridFromImage, gridTileIds, readMask, type TileGrid } from '../model/tiles';
import { applySelection, selectionGrid } from '../model/selection';
import { layerLock } from '../model/locks';
import { tileHolders } from '../app/session';
import { dropFloat, floatingDocument, floatPart, liftSelection, type FloatingPixels } from '../features/transform/float';
import {
  closestSnap,
  handles,
  normalizeAngle,
  resizeTransform,
  snapTargets,
  worldPoint,
  selectionFrame,
  transformSelection,
  type Point,
  type ResizeHandle,
} from '../model/transform';

// Features adjust a document after layers move (artboards adopt layers dropped
// on them) and supply layers to pick where no pixel was hit (an artboard's
// empty area, an empty frame).
export const layerMoveHooks: ((doc: PhotoDocument, ids: ReadonlySet<string>) => void)[] = [];
export const pickFallbacks: ((doc: PhotoDocument, x: number, y: number) => Layer | undefined)[] = [];
const afterMove = (doc: PhotoDocument, ids: ReadonlySet<string>) => {
  for (const hook of layerMoveHooks) hook(doc, ids);
};
type Drag = {
  pointer: number;
  start: Point;
  transform: Transform;
  handle: ResizeHandle | 'rotate' | 'move';
  before: PhotoDocument;
  automatic: boolean;
  // The frame of the latest pointer position.
  next?: Transform;
};
// Dragging selected pixels with the Move tool: they float above the rest of
// the layer and are put back, moved by whole pixels, when the button is released.
type FloatMove = {
  pointer: number;
  start: Point;
  layer: Layer;
  float: FloatingPixels;
  grid: TileGrid;
  ids: { group: string; rest: string; float: string };
  before: PhotoDocument;
  hideEdges: unknown;
  dx: number;
  dy: number;
};
type Pick = {
  event: PointerEvent;
  point: Point;
  handle?: Drag['handle'];
  needsHit: boolean;
  document: PhotoDocument;
  assets: Assets;
  abort: AbortController;
  latest?: { event: PointerEvent; point: Point };
  ended?: 'up' | 'cancel';
  cancelled?: boolean;
};
export class FreeTransform {
  private session?: {
    ids: Set<string>;
    before: PhotoDocument;
    draft: PhotoDocument;
    frame: Transform;
  };
  private drag?: Drag;
  private floatMove?: FloatMove;
  private pending: Pick[] = [];
  private replayingPick = false;
  private abortPicks?: () => void;
  private guides: MoveGuides = {};
  snapping = true;
  proportional = true;
  constructor(private e: Editor) {
    // Tiles of pixels being moved survive tile cleanup until they are put back.
    tileHolders.push(() => {
      const f = this.floatMove;
      return f ? [...Object.values(f.float.remaining.tiles), ...Object.values(f.grid.tiles)] : [];
    });
  }
  get active() {
    return !!this.session;
  }
  get changed() {
    return (
      !!this.session && JSON.stringify(this.session.before) !== JSON.stringify(this.session.draft)
    );
  }
  get dragging() {
    return !!this.drag || !!this.floatMove || this.pending.length > 0;
  }
  get document() {
    return this.session?.draft;
  }
  get shared() {
    const roots = this.roots();
    return roots.length > 1 || roots[0]?.kind === 'group';
  }
  private roots(doc = this.document ?? this.e.doc) {
    // Linked layers move and transform with the selection.
    return selectedRoots(doc.layers, expandLinked(doc.layers, this.session?.ids ?? this.e.selectedIds));
  }
  private editable() {
    try {
      assertEditable(this.e.doc, this.roots(), 'position');
      return this.roots().length > 0;
    } catch {
      return false;
    }
  }
  private frame(doc = this.document ?? this.e.doc) {
    return this.session?.frame ?? selectionFrame(this.roots(doc));
  }
  begin() {
    if (!this.replayingPick) this.abortPicks?.();
    if (this.active) return true;
    const frame = this.frame();
    if (!frame) {
      this.e.message('Select layers with content to transform.');
      return false;
    }
    if (!this.editable()) {
      this.e.message('Unlock the selected layers and their groups before transforming.');
      return false;
    }
    this.session = {
      ids: new Set(this.e.selectedIds),
      before: this.e.doc,
      draft: structuredClone(this.e.doc),
      frame,
    };
    this.e.tool = 'move';
    this.e.update();
    this.e.el('#viewport').focus({ preventScroll: true });
    return true;
  }
  apply() {
    if (!this.replayingPick) this.abortPicks?.();
    if (this.floatMove) this.endFloat(false);
    const session = this.session;
    if (!session) return;
    this.stopDrag();
    this.session = undefined;
    this.moving = undefined;
    this.guides = {};
    // All pointer gestures and nudges in one session become one history entry.
    if (this.e.doc === session.before) {
      this.e.history.execute('Free transform', (doc) => {
        Object.assign(doc, session.draft);
        afterMove(doc, session.ids);
      });
    }
    this.e.update();
  }
  cancel() {
    if (!this.replayingPick) this.abortPicks?.();
    if (this.floatMove) {
      this.endFloat(true);
      return;
    }
    if (!this.session && !this.drag) return;
    this.stopDrag();
    this.session = undefined;
    this.moving = undefined;
    this.guides = {};
    this.e.update();
  }
  private stopDrag() {
    hideReadout();
    const pointer = this.drag?.pointer;
    this.drag = undefined;
    const viewport = this.e.el('#viewport');
    if (pointer !== undefined && viewport.hasPointerCapture(pointer))
      viewport.releasePointerCapture(pointer);
  }
  /** Move the selected layers by whole pixels; with `pixels`, an active
   * selection on a pixel layer moves the selected pixels instead. */
  nudge(dx: number, dy: number, opts: { pixels?: boolean } = {}) {
    this.abortPicks?.();
    if (opts.pixels && !this.session && this.selectedPixelLayer()) {
      const f = this.lift(false);
      if (!f) return;
      const store = this.e.assets.tiles;
      const grid = dropFloat(store, f.float, f.float.image, f.float.rect.x + dx, f.float.rect.y + dy);
      const sel = selectionGrid(this.e.doc, store);
      const id = f.layer.id;
      this.e.command('Nudge Selection', (d) => {
        const l = findLayer(d.layers, id);
        if (!l) return;
        setLayerPixels(l, grid, d);
        applySelection(d, sel && { ...sel, x: sel.x + dx, y: sel.y + dy });
      });
      return;
    }
    if (!this.editable()) return;
    const before = this.frame();
    if (!before) return;
    const after = { ...before, x: before.x + dx, y: before.y + dy };
    try {
      if (this.session) {
        const doc = structuredClone(this.session.draft);
        transformSelection(this.roots(doc), before, after);
        followLinkedMasks(this.session.draft, doc);
        this.session.draft = doc;
        this.session.frame = after;
        this.guides = {};
        this.preview();
      } else {
        const ids = new Set(this.e.selectedIds);
        this.e.command('Nudge layers', (doc) => {
          transformSelection(this.roots(doc), before, after);
          afterMove(doc, ids);
        });
      }
    } catch (error) {
      this.e.message((error as Error).message);
    }
  }
  private preview(doc = this.session?.draft) {
    if (!doc) return;
    this.e.preview(doc);
    this.e.overlay(doc);
    const l = findLayer(doc.layers, this.e.selected);
    if (l && l.kind !== 'group')
      for (const [key, value] of Object.entries(l.transform)) {
        const field = this.e.root.querySelector<HTMLInputElement>(`[data-property="${key}"]`);
        if (field && document.activeElement !== field)
          field.value = String(Math.round(value * 100) / 100);
      }
  }
  /** The single selected pixel layer while a selection is active. */
  private selectedPixelLayer(): Layer | undefined {
    const doc = this.e.doc;
    if (!doc.selection && !doc.selectionMask) return;
    const l = this.e.selectedIds.size === 1 ? this.e.layer : undefined;
    return l?.kind === 'pixel' && l.pixels && l.visible ? l : undefined;
  }
  /** Lift the selected pixels of the selected pixel layer (`copy` leaves them
   * in place too). Undefined after explaining why not. */
  private lift(copy: boolean): { layer: Layer; float: FloatingPixels } | undefined {
    const e = this.e,
      l = this.selectedPixelLayer();
    if (!l) return;
    if (layerLock(e.doc.layers, l.id, 'pixels')) {
      e.message('Unlock the layer before moving its pixels.');
      return;
    }
    const float = liftSelection(e.doc, e.assets.tiles, l, { preserveAlpha: !!l.background || layerLock(e.doc.layers, l.id, 'transparency'), background: hexRgb(e.background) });
    if (!float) {
      e.message('The selected area is empty. Select some of the layer’s pixels to move them.');
      return;
    }
    if (copy) float.remaining = l.pixels!;
    return { layer: l, float };
  }
  /** Show the floating pixels moved by (dx, dy). */
  private previewFloat() {
    const m = this.floatMove!;
    const plain = floatPart(m.layer);
    const restBounds = gridDocBounds(m.float.remaining);
    const rest: Layer = restBounds ? { ...plain, id: m.ids.rest, pixels: m.float.remaining, transform: { ...restBounds, rotation: 0 } } : { ...plain, id: m.ids.rest, visible: false };
    const r = m.float.rect;
    // The layer transform places the unchanged tiles (no new upload per move).
    const lifted: Layer = { ...plain, id: m.ids.float, pixels: m.grid, transform: { x: r.x + m.dx, y: r.y + m.dy, width: r.width, height: r.height, rotation: 0 } };
    this.e.preview(floatingDocument(m.before, m.layer, m.ids.group, rest, lifted));
    this.e.overlay();
  }
  /** Put floating pixels back (or, cancelled, leave the layer as it was). */
  private endFloat(cancel: boolean) {
    const m = this.floatMove;
    if (!m) return;
    this.floatMove = undefined;
    hideReadout();
    this.e.settings.hideSelectionEdges = m.hideEdges;
    const viewport = this.e.el('#viewport');
    if (viewport.hasPointerCapture(m.pointer)) viewport.releasePointerCapture(m.pointer);
    const store = this.e.assets.tiles;
    let keep = new Set<string>();
    if (!cancel && (m.dx || m.dy) && this.e.doc === m.before) {
      const grid = dropFloat(store, m.float, m.float.image, m.float.rect.x + m.dx, m.float.rect.y + m.dy);
      keep = gridTileIds(grid);
      const sel = selectionGrid(m.before, store);
      const { dx, dy } = m;
      this.e.command(m.float.remaining === m.layer.pixels ? 'Duplicate Selection' : 'Move Selection', (d) => {
        const l = findLayer(d.layers, m.layer.id);
        if (!l) return;
        setLayerPixels(l, grid, d);
        applySelection(d, sel && { ...sel, x: sel.x + dx, y: sel.y + dy });
      });
    }
    // Tiles made for the move that the layer does not keep, once no render
    // of the preview reads them any more.
    const base = gridTileIds(m.layer.pixels);
    const unused = [...Object.values(m.float.remaining.tiles), ...Object.values(m.grid.tiles)].filter((id) => !base.has(id) && !keep.has(id));
    const done = () => {
      for (const id of unused) store.delete(id);
    };
    const r = this.e.renderer;
    if (r) void r.settle().then(() => requestAnimationFrame(() => void r.settle().then(done)));
    else done();
    this.e.update();
  }
  bind() {
    const viewport = this.e.el('#viewport');
    const point = (event: PointerEvent): Point => this.e.docPoint(event.clientX, event.clientY);
    const start = (request: Pick, picked?: Layer) => {
      const { event, point: p, handle } = request;
      let hit = picked;
      if (request.needsHit) {
        for (const pick of pickFallbacks) hit ??= pick(request.document, ...p);
        const found = hit;
        if (event.shiftKey && hit) {
          this.e.selectLayer(hit.id, true);
          event.preventDefault();
          return;
        }
        // Keep an existing multi-selection or selected parent when dragging its content.
        const covered =
          found &&
          this.roots().some((root) => root.id === found.id || findLayer(root.children, found.id));
        if (hit && !covered) this.e.selectLayer(hit.id);
        if (!hit) {
          this.e.selectLayers([]);
          this.e.update();
          return;
        }
      }
      // With a selection, dragging inside it moves the selected pixels
      // (Alt moves a copy).
      if (!handle && !this.active && this.selectedPixelLayer()) {
        const sel = selectionGrid(this.e.doc, this.e.assets.tiles);
        const inside = sel && readMask(this.e.assets.tiles, sel, { x: Math.floor(p[0]), y: Math.floor(p[1]), width: 1, height: 1 }).data[0] > 0;
        if (inside) {
          event.preventDefault();
          const lifted = this.lift(event.altKey);
          if (!lifted) return;
          const store = this.e.assets.tiles;
          this.floatMove = {
            pointer: event.pointerId,
            start: p,
            layer: lifted.layer,
            float: lifted.float,
            grid: gridFromImage(store, lifted.float.image, lifted.float.rect.x, lifted.float.rect.y),
            ids: { group: crypto.randomUUID(), rest: crypto.randomUUID(), float: crypto.randomUUID() },
            before: this.e.doc,
            hideEdges: this.e.settings.hideSelectionEdges,
            dx: 0,
            dy: 0,
          };
          this.e.settings.hideSelectionEdges = true;
          if (!request.ended) viewport.setPointerCapture(event.pointerId);
          viewport.focus({ preventScroll: true });
          this.previewFloat();
          return;
        }
      }
      if (!this.editable()) return;
      const t = this.frame();
      if (!t) return;
      if (!handle) {
        const [x, y] = localPoint(t, ...p);
        if (x < 0 || x > 1 || y < 0 || y > 1) return;
      }
      event.preventDefault();
      if (handle && !this.begin()) return;
      const before = structuredClone(this.document ?? this.e.doc);
      this.moving = undefined;
      this.drag = {
        pointer: event.pointerId,
        start: p,
        transform: { ...t },
        handle: handle ?? 'move',
        before,
        automatic: !this.active,
      };
      if (!request.ended) viewport.setPointerCapture(event.pointerId);
      viewport.focus({ preventScroll: true });
    };
    const move = (event: PointerEvent, p = point(event)) => {
      const m = this.floatMove;
      if (m && m.pointer === event.pointerId) {
        let dx = Math.round(p[0] - m.start[0]),
          dy = Math.round(p[1] - m.start[1]);
        // Shift keeps the move horizontal or vertical.
        if (event.shiftKey) {
          if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        if (dx === m.dx && dy === m.dy) return;
        m.dx = dx;
        m.dy = dy;
        showReadout(this.e, event.clientX, event.clientY, [`ΔX: ${lengthText(this.e, dx, 'x')}`, `ΔY: ${lengthText(this.e, dy, 'y')}`]);
        this.previewFloat();
        return;
      }
      const drag = this.drag;
      if (!drag || drag.pointer !== event.pointerId) return;
      const delta: Point = [p[0] - drag.start[0], p[1] - drag.start[1]];
      const doc = structuredClone(drag.before);
      const targets = snapTargets(drag.before, this.roots(drag.before), snapOptions(this.e)),
        threshold = 6 / this.e.zoom;
      let next = { ...drag.transform };
      this.guides = {};
      if (drag.handle === 'move') {
        next.x += delta[0];
        next.y += delta[1];
        // Alignment guides and View > Snap To targets; Alt moves freely.
        if (!event.altKey) {
          const snapped = snapMove(this.e, drag.before, this.roots(drag.before), next, this.snapping);
          next = snapped.transform;
          this.guides = snapped.guides;
        }
      } else if (drag.handle === 'rotate') {
        const t = drag.transform,
          cx = t.x + t.width / 2,
          cy = t.y + t.height / 2;
        const angle =
          t.rotation +
          ((Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(drag.start[1] - cy, drag.start[0] - cx)) *
            180) /
            Math.PI;
        next.rotation = normalizeAngle(event.shiftKey ? Math.round(angle / 15) * 15 : angle);
      } else {
        const [sx, sy] = handles[drag.handle];
        let x: number | undefined, y: number | undefined;
        // Axis-aligned resize edges can snap; rotated resizing stays on its local axes.
        if (
          this.snapping &&
          !event.altKey &&
          Math.abs(normalizeAngle(drag.transform.rotation)) < 0.001
        ) {
          const h = worldPoint(drag.transform, (sx + 1) / 2, (sy + 1) / 2);
          const snapX = sx ? closestSnap([h[0] + delta[0]], targets.x, threshold) : undefined;
          const snapY = sy ? closestSnap([h[1] + delta[1]], targets.y, threshold) : undefined;
          delta[0] += snapX?.delta ?? 0;
          delta[1] += snapY?.delta ?? 0;
          x = snapX?.target;
          y = snapY?.target;
        }
        const constrain =
          this.shared || (sx && sy ? this.proportional !== event.shiftKey : event.shiftKey);
        next = resizeTransform(drag.transform, drag.handle, delta, constrain);
        const actual = worldPoint(next, (sx + 1) / 2, (sy + 1) / 2);
        this.guides = {
          x: x !== undefined && Math.abs(actual[0] - x) < 0.01 ? x : undefined,
          y: y !== undefined && Math.abs(actual[1] - y) < 0.01 ? y : undefined,
        };
      }
      // Tools → Snap vector tools and transforms to pixel grid (unrotated frames).
      if (this.e.preferences.snapPixelGrid && Math.abs(normalizeAngle(next.rotation)) < 0.001) {
        if (drag.handle === 'move') next = { ...next, x: Math.round(next.x), y: Math.round(next.y) };
        else if (drag.handle !== 'rotate') {
          const x0 = Math.round(next.x),
            y0 = Math.round(next.y);
          next = { ...next, x: x0, y: y0, width: Math.max(1, Math.round(next.x + next.width) - x0), height: Math.max(1, Math.round(next.y + next.height) - y0) };
        }
      }
      showReadout(
        this.e,
        event.clientX,
        event.clientY,
        drag.handle === 'move'
          ? [`ΔX: ${lengthText(this.e, next.x - drag.transform.x, 'x')}`, `ΔY: ${lengthText(this.e, next.y - drag.transform.y, 'y')}`]
          : drag.handle === 'rotate'
            ? [`${Math.round(normalizeAngle(next.rotation) * 10) / 10}°`]
            : [`W: ${lengthText(this.e, Math.abs(next.width), 'x')}`, `H: ${lengthText(this.e, Math.abs(next.height), 'y')}`],
      );
      try {
        transformSelection(this.roots(doc), drag.transform, next);
        followLinkedMasks(drag.before, doc);
      } catch (error) {
        this.e.message((error as Error).message);
        return;
      }
      drag.next = next;
      if (this.session) {
        this.session.draft = doc;
        this.session.frame = next;
      }
      // Store the latest draft for ordinary moves, which commit on pointer release.
      this.moving = doc;
      this.preview(doc);
    };
    const finish = (event: PointerEvent, cancel = false) => {
      if (this.floatMove?.pointer === event.pointerId) {
        this.endFloat(cancel);
        return;
      }
      const drag = this.drag;
      if (!drag || drag.pointer !== event.pointerId) return;
      this.stopDrag();
      this.guides = {};
      if (cancel) {
        if (this.session) {
          this.session.draft = drag.before;
          this.session.frame = drag.transform;
        }
      } else if (this.session && drag.next && drag.handle !== 'move') {
        // Group masks follow a scale or rotation once the drag ends (too
        // costly to resample on every pointer move).
        const doc = structuredClone(drag.before);
        try {
          transformSelection(this.roots(doc), drag.transform, drag.next, this.e.assets.tiles);
          followLinkedMasks(drag.before, doc);
          this.session.draft = doc;
        } catch (error) {
          this.e.message((error as Error).message);
        }
      } else if (drag.automatic && this.moving) {
        const doc = this.moving;
        const ids = new Set(this.e.selectedIds);
        this.e.command('Move layers', (d) => {
          Object.assign(d, doc);
          afterMove(d, ids);
        });
      }
      this.moving = undefined;
      this.e.update();
    };
    let reading: Pick | undefined;
    this.abortPicks = () => {
      const requests = this.pending.splice(0);
      // Obsolete GPU work still owns its renderer resources, but must not
      // hold up new handles or clicks while its readback finishes.
      reading = undefined;
      for (const request of requests) {
        request.cancelled = true;
        request.abort.abort();
        if (viewport.hasPointerCapture(request.event.pointerId))
          viewport.releasePointerCapture(request.event.pointerId);
      }
    };
    const valid = (request: Pick) =>
      !request.cancelled &&
      request.document === this.e.doc &&
      request.assets === this.e.assets &&
      this.e.tool === 'move' &&
      !this.e.busy;
    const replay = (request: Pick, hit?: Layer) => {
      if (!valid(request)) return;
      const before = this.e.doc;
      this.replayingPick = true;
      try {
        start(request, hit);
        if (request.latest) move(request.latest.event, request.latest.point);
        if (request.ended) finish(request.event, request.ended === 'cancel');
        // Later clicks belong to the document after earlier buffered gestures.
        for (const queued of this.pending)
          if (queued.document === before) queued.document = this.e.doc;
      } finally {
        this.replayingPick = false;
      }
    };
    const read = (request: Pick) =>
      request.needsHit
        ? hitLayer(request.document, request.assets, ...request.point, (l, parents, x, y) =>
            this.e.renderer.pickCoverage(
              request.document,
              request.assets,
              l,
              parents,
              x,
              y,
              request.abort.signal,
            ),
          )
        : undefined;
    const complete = (request: Pick, hit?: Layer) => {
      if (this.pending[0] === request) this.pending.shift();
      replay(request, hit);
    };
    const failed = (request: Pick, error: unknown) => {
      if (this.pending[0] === request) this.pending.shift();
      if (valid(request)) this.e.message((error as Error).message);
    };
    const drain = () => {
      if (reading) return;
      while (this.pending.length) {
        const request = this.pending[0];
        try {
          const hit = valid(request) ? read(request) : undefined;
          if (hit instanceof Promise) {
            reading = request;
            void hit
              .then((result) => complete(request, result))
              .catch((error) => failed(request, error))
              .finally(() => {
                if (reading === request) {
                  reading = undefined;
                  drain();
                }
              });
            return;
          }
          complete(request, hit);
        } catch (error) {
          failed(request, error);
        }
      }
    };
    viewport.addEventListener('pointerdown', (event) => {
      if (
        event.button !== 0 ||
        this.drag ||
        this.pending.some((p) => !p.ended) ||
        this.e.busy ||
        !this.e.renderer ||
        this.e.tool !== 'move' ||
        (event.target as Element).closest('button')
      )
        return;
      const handle = (event.target as Element).closest<SVGElement>('[data-transform-handle]')
        ?.dataset.transformHandle as Drag['handle'] | undefined;
      const request: Pick = {
        event,
        point: point(event),
        handle,
        needsHit: !handle && !this.active && (this.e.autoSelect || event.metaKey || event.ctrlKey),
        document: this.e.doc,
        assets: this.e.assets,
        abort: new AbortController(),
      };
      event.preventDefault();
      viewport.focus({ preventScroll: true });
      this.pending.push(request);
      viewport.setPointerCapture(event.pointerId);
      drain();
    });
    viewport.addEventListener('pointermove', (event) => {
      const request = [...this.pending]
        .reverse()
        .find((p) => !p.ended && p.event.pointerId === event.pointerId);
      if (request) request.latest = { event, point: point(event) };
      else move(event);
    });
    const end = (event: PointerEvent, cancel = false) => {
      const request = [...this.pending]
        .reverse()
        .find((p) => p.event.pointerId === event.pointerId);
      if (request) {
        if (!request.ended) {
          request.ended = cancel ? 'cancel' : 'up';
          request.cancelled = cancel;
          if (cancel) {
            request.abort.abort();
            this.pending.splice(this.pending.indexOf(request), 1);
            if (reading === request) reading = undefined;
            drain();
          }
        }
      } else finish(event, cancel);
    };
    viewport.addEventListener('pointerup', (event) => end(event));
    viewport.addEventListener('pointercancel', (event) => end(event, true));
    viewport.addEventListener('lostpointercapture', (event) => end(event, true));
    window.addEventListener('blur', () => {
      if (this.dragging) this.cancel();
    });
  }
  private moving?: PhotoDocument;
  overlay(doc: PhotoDocument) {
    const e = this.e,
      l = findLayer(doc.layers, e.selected),
      z = e.zoom;
    let html = '';
    if (this.guides.x !== undefined)
      html += `<line class="snap-guide" x1="${this.guides.x}" x2="${this.guides.x}" y1="0" y2="${doc.height}" stroke-width="${1 / z}"/>`;
    if (this.guides.y !== undefined)
      html += `<line class="snap-guide" x1="0" x2="${doc.width}" y1="${this.guides.y}" y2="${this.guides.y}" stroke-width="${1 / z}"/>`;
    if (this.guides.smart) html += smartGuidesSvg(e, this.guides.smart);
    // Adjustment layers have no bounds of their own to transform.
    if (e.tool !== 'move' || !l || !l.visible || l.kind === 'adjustment' || !this.editable()) return html;
    const t = this.frame(doc);
    if (!t) return html;
    const corners = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]
      .map(([x, y]) => worldPoint(t, x, y).join(','))
      .join(' ');
    html += `<polygon class="transform-frame" points="${corners}" fill="none" stroke-width="${1 / z}"/>`;
    // While transforming, guides divide the frame into thirds (Edit > Transform > Show Transform Guides).
    if (this.active && e.settings.transformGuides !== false) {
      let d = '';
      for (const f of [1 / 3, 2 / 3]) {
        const a = worldPoint(t, f, 0),
          b = worldPoint(t, f, 1),
          c = worldPoint(t, 0, f),
          g = worldPoint(t, 1, f);
        d += `M${a[0]} ${a[1]}L${b[0]} ${b[1]}M${c[0]} ${c[1]}L${g[0]} ${g[1]}`;
      }
      html += `<path class="ts-guides" d="${d}" stroke-width="${1 / z}"/>`;
    }
    for (const [handle, [x, y]] of Object.entries(handles)) {
      const [cx, cy] = worldPoint(t, (x + 1) / 2, (y + 1) / 2);
      html += `<g class="transform-handle handle-${handle}" data-transform-handle="${handle}"><circle class="handle-hit" cx="${cx}" cy="${cy}" r="${9 / z}"/><rect x="${cx - 3.5 / z}" y="${cy - 3.5 / z}" width="${7 / z}" height="${7 / z}" stroke-width="${1 / z}"/></g>`;
    }
    // Artboards and frames keep axis-aligned rectangles: no rotation handle.
    if (this.roots(doc).some((r) => r.artboard || r.frame)) return html;
    const top = worldPoint(t, 0.5, 0),
      a = (t.rotation * Math.PI) / 180;
    const rx = top[0] + (Math.sin(a) * 26) / z,
      ry = top[1] - (Math.cos(a) * 26) / z;
    html += `<line class="transform-frame" x1="${top[0]}" y1="${top[1]}" x2="${rx}" y2="${ry}" stroke-width="${1 / z}"/><g class="transform-handle handle-rotate" data-transform-handle="rotate"><circle class="handle-hit" cx="${rx}" cy="${ry}" r="${10 / z}"/><circle cx="${rx}" cy="${ry}" r="${4 / z}" stroke-width="${1 / z}"/></g>`;
    return html;
  }
}
