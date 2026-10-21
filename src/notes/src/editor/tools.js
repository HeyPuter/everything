import { uid } from '../lib/ids.js';
import { strokePath, shapePath, bounds, unionBounds, hitTest, insideLasso, translate, simplify, constrainShape, recognizeShape, PENS } from './ink.js';

const SVG = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/**
 * Drawing tools over the page: pens, highlighters, the stroke eraser, lasso
 * selection, shapes and insert space. Ink lives in page.ink and renders in
 * an SVG layer above the note containers.
 */
export class InkTools {
  constructor(editor) {
    this.editor = editor;
    this.tool = 'type';
    this.pen = { ...PENS[0] };
    this.shape = 'line';
    this.inkToShape = false;
    this.selected = new Set();
    this.layer = svg('svg', { class: 'ink-layer', 'aria-hidden': 'true' });
    this.overlay = document.createElement('div');
    this.overlay.className = 'tool-overlay';
    this.overlay.hidden = true;
    this.selBox = document.createElement('div');
    this.selBox.className = 'selection-box';
    this.selBox.hidden = true;
    editor.pageEl.append(this.layer, this.overlay, this.selBox);
    // The stroke, erase or drag in progress: { pointerType, cancel }.
    this.active = null;
    // Fingers on the overlay, for two-finger scrolling and zooming.
    this.touches = new Map();
    this.gesture = null;
    this.overlay.addEventListener('pointerdown', (e) => this.onDown(e));
    this.overlay.addEventListener('pointermove', (e) => this.onTouchMove(e));
    for (const type of ['pointerup', 'pointercancel']) {
      this.overlay.addEventListener(type, (e) => {
        if (!this.touches.delete(e.pointerId)) return;
        if (this.touches.size < 2) this.gesture = null;
      });
    }
    this.selBox.addEventListener('pointerdown', (e) => this.dragSelection(e));
  }

  get page() {
    return this.editor.page;
  }

  setTool(tool, opts = {}) {
    this.tool = tool;
    if (opts.pen) this.pen = { ...opts.pen };
    if (opts.shape) this.shape = opts.shape;
    this.overlay.hidden = tool === 'type';
    this.overlay.dataset.tool = tool;
    this.editor.pageEl.classList.toggle('tool-active', tool !== 'type');
    if (tool !== 'lasso' && tool !== 'type') this.clearSelection();
    // Keys like Delete and Escape go to the canvas while a tool is active.
    if (tool !== 'type') this.editor.scroller.focus({ preventScroll: true });
  }

  resize(w, h) {
    this.layer.setAttribute('width', w);
    this.layer.setAttribute('height', h);
    this.layer.setAttribute('viewBox', `0 0 ${w} ${h}`);
  }

  extent() {
    const items = this.page?.ink || [];
    return items.length ? unionBounds(items.map(bounds)) : null;
  }

  render() {
    this.layer.replaceChildren();
    for (const item of this.page?.ink || []) this.layer.append(this.itemEl(item));
    this.updateSelectionBox();
  }

  itemEl(item) {
    let el;
    if (item.type === 'shape') {
      el = svg('path', { d: shapePath(item), fill: 'none', stroke: item.color, 'stroke-width': item.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    } else {
      el = svg('path', { d: strokePath(item), fill: item.color });
      if (item.highlighter) {
        el.setAttribute('class', 'hl');
        el.setAttribute('opacity', '0.45');
      }
    }
    el.dataset.id = item.id;
    if (this.selected.has(item.id)) el.classList.add('ink-selected');
    return el;
  }

  replaceEl(item) {
    const old = this.layer.querySelector(`[data-id="${item.id}"]`);
    const el = this.itemEl(item);
    if (old) old.replaceWith(el);
    else this.layer.append(el);
  }

  point(e) {
    const p = this.editor.pagePoint(e);
    const pressure = e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5;
    return [p.x, p.y, pressure];
  }

  onDown(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (this.editor.readOnly) return;
    e.preventDefault();
    if (e.pointerType === 'touch') {
      // Palm rejection: a hand resting on the screen while a pen writes doesn't draw.
      if (this.active?.pointerType === 'pen') return;
      this.touches.set(e.pointerId, [e.clientX, e.clientY]);
      this.overlay.setPointerCapture(e.pointerId);
      if (this.gesture) return;
      if (this.touches.size >= 2) {
        // A second finger makes it a scroll or pinch: undo what the first one started.
        this.active?.cancel();
        this.startGesture();
        return;
      }
    } else if (this.active?.pointerType === 'touch' && e.pointerType === 'pen') {
      this.active.cancel(); // the palm landed before the pen
    }
    if (this.active) return;
    this.overlay.setPointerCapture(e.pointerId);
    // A pen's eraser end (or eraser button) erases whatever the tool.
    const tool = e.pointerType === 'pen' && (e.button === 5 || e.buttons & 32) ? 'eraser' : this.tool;
    const handlers = { pen: () => this.drawStroke(e), eraser: () => this.erase(e), lasso: () => this.lasso(e), shape: () => this.drawShape(e), space: () => this.insertSpace(e) };
    handlers[tool]?.();
  }

  startGesture() {
    const [a, b] = [...this.touches.values()];
    this.gesture = { mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], dist: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, zoom: this.editor.zoom };
  }

  /** Two fingers scroll the page and pinch to zoom, whatever the tool. */
  onTouchMove(e) {
    if (!this.touches.has(e.pointerId)) return;
    this.touches.set(e.pointerId, [e.clientX, e.clientY]);
    const g = this.gesture;
    if (!g) return;
    const [a, b] = [...this.touches.values()];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const scale = Math.hypot(a[0] - b[0], a[1] - b[1]) / g.dist;
    if (Math.abs(scale - 1) > 0.04 || this.editor.zoom !== g.zoom) this.editor.setZoom(g.zoom * scale, { clientX: mid[0], clientY: mid[1] });
    this.editor.scroller.scrollBy(g.mid[0] - mid[0], g.mid[1] - mid[1]);
    g.mid = mid;
  }

  /**
   * Follows one pointer until it lifts. onCancel undoes the action when it
   * is abandoned (a second finger turns it into a scroll, or a pen lands
   * after the palm).
   */
  track(e, onMove, onUp, onCancel) {
    const id = e.pointerId;
    const move = (ev) => {
      if (ev.pointerId !== id) return;
      const events = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
      for (const ce of events.length ? events : [ev]) onMove(ce);
    };
    const stop = () => {
      this.overlay.removeEventListener('pointermove', move);
      this.overlay.removeEventListener('pointerup', up);
      this.overlay.removeEventListener('pointercancel', up);
      this.overlay.removeEventListener('lostpointercapture', up);
      this.active = null;
    };
    const up = (ev) => {
      if (ev.pointerId !== id) return;
      stop();
      onUp(ev);
    };
    this.overlay.addEventListener('pointermove', move);
    this.overlay.addEventListener('pointerup', up);
    this.overlay.addEventListener('pointercancel', up);
    // If the overlay loses the pointer, its pointerup may land elsewhere:
    // finish now rather than glue the next stroke onto this one.
    this.overlay.addEventListener('lostpointercapture', up);
    this.active = {
      pointerType: e.pointerType,
      cancel: () => {
        stop();
        onCancel?.();
      },
    };
  }

  drawStroke(e) {
    const item = { id: uid('i'), type: 'stroke', color: this.pen.color, width: this.pen.width, highlighter: Boolean(this.pen.highlighter), points: [this.point(e)] };
    let el = this.itemEl(item);
    this.layer.append(el);
    let frame = null;
    this.track(e, (ev) => {
      item.points.push(this.point(ev));
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = null;
          el.setAttribute('d', strokePath(item));
        });
      }
    }, () => {
      cancelAnimationFrame(frame);
      item.points = simplify(item.points);
      const shape = this.inkToShape && !item.highlighter ? recognizeShape(item.points) : null;
      if (shape) {
        const round = (v) => Math.round(v * 10) / 10;
        const converted = { id: item.id, type: 'shape', kind: shape.kind, color: item.color, width: Math.max(1.5, Math.min(item.width, 8)), x1: round(shape.x1), y1: round(shape.y1), x2: round(shape.x2), y2: round(shape.y2) };
        const next = this.itemEl(converted);
        el.replaceWith(next);
        el = next;
        this.page.ink.push(converted);
      } else {
        el.setAttribute('d', strokePath(item));
        this.page.ink.push(item);
      }
      this.editor.layout();
      this.editor.changed();
    }, () => {
      cancelAnimationFrame(frame);
      el.remove();
    });
  }

  drawShape(e) {
    const [x, y] = this.point(e);
    const item = { id: uid('i'), type: 'shape', kind: this.shape, color: this.pen.color, width: Math.max(1.5, Math.min(this.pen.width, 8)), x1: x, y1: y, x2: x, y2: y };
    let el = this.itemEl(item);
    this.layer.append(el);
    this.track(e, (ev) => {
      let [x2, y2] = this.point(ev);
      if (ev.shiftKey) [x2, y2] = constrainShape(item.kind, item.x1, item.y1, x2, y2);
      item.x2 = x2;
      item.y2 = y2;
      el.setAttribute('d', shapePath(item));
    }, () => {
      if (Math.hypot(item.x2 - item.x1, item.y2 - item.y1) < 3) {
        el.remove();
        return;
      }
      for (const k of ['x1', 'y1', 'x2', 'y2']) item[k] = Math.round(item[k] * 10) / 10;
      this.page.ink.push(item);
      this.editor.layout();
      this.editor.changed();
    }, () => el.remove());
  }

  erase(e) {
    const r = 6 / this.editor.zoom;
    const start = this.page.ink;
    let removed = false;
    let last = null;
    const at = (ev) => {
      const [x, y] = this.point(ev);
      const from = last;
      last = [x, y];
      const before = this.page.ink.length;
      this.page.ink = this.page.ink.filter((item) => {
        if (!hitTest(item, x, y, r, from)) return true;
        this.layer.querySelector(`[data-id="${item.id}"]`)?.remove();
        return false;
      });
      if (this.page.ink.length !== before) removed = true;
    };
    at(e);
    this.track(e, at, () => {
      if (!removed) return;
      // The page shrinks back once the ink that grew it is gone, as drawing grows it.
      this.editor.layout();
      this.editor.changed();
    }, () => {
      if (!removed) return;
      this.page.ink = start;
      this.render();
    });
  }

  lasso(e) {
    this.clearSelection();
    const poly = [this.point(e).slice(0, 2)];
    const path = svg('path', { class: 'lasso-path' });
    this.layer.append(path);
    const draw = () => path.setAttribute('d', `M${poly.map((p) => p.join(' ')).join('L')}Z`);
    this.track(e, (ev) => {
      poly.push(this.point(ev).slice(0, 2));
      draw();
    }, () => {
      path.remove();
      if (poly.length < 3) return;
      const ids = this.page.ink.filter((item) => insideLasso(item, poly)).map((i) => i.id);
      const outlines = [...this.editor.outlinesEl.children].filter((el) => {
        const cx = el.offsetLeft + el.offsetWidth / 2;
        const cy = el.offsetTop + el.offsetHeight / 2;
        return insideLasso({ type: 'stroke', points: [[cx, cy]], width: 0 }, poly);
      });
      this.select(ids);
      this.editor.selectOutlines(outlines);
      this.editor.scroller.focus({ preventScroll: true });
    }, () => path.remove());
  }

  insertSpace(e) {
    const [, y0] = this.point(e);
    const line = document.createElement('div');
    line.className = 'space-line';
    line.style.top = `${y0}px`;
    const band = document.createElement('div');
    band.className = 'space-band';
    this.editor.pageEl.append(band, line);
    const outlines = [...this.editor.outlinesEl.children].filter((el) => el.offsetTop >= y0);
    const ink = this.page.ink.filter((item) => bounds(item).y >= y0);
    const inkEls = ink.map((item) => this.layer.querySelector(`[data-id="${item.id}"]`));
    let dy = 0;
    this.track(e, (ev) => {
      dy = this.point(ev)[1] - y0;
      // Removing space can only pull items up to the line.
      const minTop = Math.min(...outlines.map((el) => el.offsetTop), ...ink.map((i) => bounds(i).y), Infinity);
      if (minTop !== Infinity) dy = Math.max(dy, y0 - minTop);
      band.style.top = `${Math.min(y0, y0 + dy)}px`;
      band.style.height = `${Math.abs(dy)}px`;
      for (const el of outlines) el.style.transform = `translateY(${dy}px)`;
      inkEls.forEach((el) => el?.setAttribute('transform', `translate(0 ${dy})`));
    }, () => {
      line.remove();
      band.remove();
      for (const el of outlines) {
        el.style.transform = '';
        const model = this.editor.outlineModel(el);
        model.y = Math.max(0, Math.round(model.y + dy));
        el.style.top = `${model.y}px`;
      }
      for (const item of ink) translate(item, 0, dy);
      this.render();
      this.editor.layout();
      if (Math.abs(dy) > 1) this.editor.changed();
    }, () => {
      line.remove();
      band.remove();
      for (const el of outlines) el.style.transform = '';
      inkEls.forEach((el) => el?.removeAttribute('transform'));
    });
  }

  // ---------------------------------------------------------------- selection

  select(ids) {
    this.selected = new Set(ids);
    for (const el of this.layer.querySelectorAll('[data-id]')) el.classList.toggle('ink-selected', this.selected.has(el.dataset.id));
    this.updateSelectionBox();
    this.editor.emit('selection');
  }

  selectAll() {
    this.select((this.page?.ink || []).map((i) => i.id));
  }

  clearSelection() {
    if (!this.selected.size) {
      this.selBox.hidden = true;
      return;
    }
    this.select([]);
  }

  /** In typing mode, a click on ink selects that item. */
  pickAt(x, y) {
    const r = 4 / this.editor.zoom;
    const items = this.page?.ink || [];
    for (let i = items.length - 1; i >= 0; i--) {
      if (hitTest(items[i], x, y, r)) {
        this.select([items[i].id]);
        this.editor.scroller.focus({ preventScroll: true });
        return true;
      }
    }
    return false;
  }

  selectedItems() {
    return (this.page?.ink || []).filter((i) => this.selected.has(i.id));
  }

  updateSelectionBox() {
    const items = this.selectedItems();
    if (!items.length) {
      this.selBox.hidden = true;
      return;
    }
    const b = unionBounds(items.map(bounds));
    Object.assign(this.selBox.style, { left: `${b.x - 4}px`, top: `${b.y - 4}px`, width: `${b.w + 8}px`, height: `${b.h + 8}px` });
    this.selBox.hidden = false;
  }

  /** Moves the selected ink by arrow-key steps, stopping at the page's top and left edges. */
  nudge(dx, dy) {
    const items = this.selectedItems();
    if (!items.length) return false;
    const b = unionBounds(items.map(bounds));
    dx = Math.max(dx, -Math.max(0, b.x));
    dy = Math.max(dy, -Math.max(0, b.y));
    for (const item of items) {
      translate(item, dx, dy);
      this.replaceEl(item);
    }
    this.updateSelectionBox();
    return true;
  }

  beginMove() {
    const items = this.selectedItems();
    const els = items.map((i) => this.layer.querySelector(`[data-id="${i.id}"]`));
    let last = [0, 0];
    return {
      move: (dx, dy) => {
        last = [dx, dy];
        els.forEach((el) => el?.setAttribute('transform', `translate(${dx} ${dy})`));
        const b = unionBounds(items.map(bounds));
        Object.assign(this.selBox.style, { left: `${b.x - 4 + dx}px`, top: `${b.y - 4 + dy}px` });
      },
      end: () => {
        for (const item of items) translate(item, last[0], last[1]);
        this.render();
      },
    };
  }

  dragSelection(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    e.stopPropagation();
    const start = this.editor.pagePoint(e);
    const mover = this.beginMove();
    const outlines = [...this.editor.selectedOutlines].map((el) => ({ el, model: this.editor.outlineModel(el), x: el.offsetLeft, y: el.offsetTop }));
    let delta = [0, 0];
    const move = (ev) => {
      const p = this.editor.pagePoint(ev);
      delta = [p.x - start.x, p.y - start.y];
      mover.move(...delta);
      for (const o of outlines) {
        o.el.style.left = `${o.x + delta[0]}px`;
        o.el.style.top = `${o.y + delta[1]}px`;
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (Math.hypot(...delta) < 1) return;
      mover.end();
      for (const o of outlines) {
        o.model.x = Math.max(0, Math.round(o.x + delta[0]));
        o.model.y = Math.max(0, Math.round(o.y + delta[1]));
      }
      this.editor.layout();
      this.editor.changed();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  deleteSelection() {
    if (!this.selected.size) return false;
    this.page.ink = this.page.ink.filter((i) => !this.selected.has(i.id));
    this.selected.clear();
    this.render();
    return true;
  }

  /**
   * Restyles the selected ink (a pen, color or thickness picked while ink
   * is selected), as one undo step.
   */
  recolor({ color, width, highlighter } = {}) {
    const items = this.selectedItems();
    if (!items.length) return false;
    for (const item of items) {
      if (color) item.color = color;
      // Shapes keep the same width limits as when they're drawn.
      if (width) item.width = item.type === 'shape' ? Math.max(1.5, Math.min(width, 8)) : width;
      if (highlighter !== undefined && item.type === 'stroke') item.highlighter = Boolean(highlighter);
      this.replaceEl(item);
    }
    this.updateSelectionBox();
    this.editor.layout();
    this.editor.changed();
    return true;
  }
}
