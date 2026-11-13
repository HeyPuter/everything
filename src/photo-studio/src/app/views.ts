import type { Editor } from '../editor';
import type { DocumentSession } from './session';
import type { PhotoDocument } from '../model/document';
import { escapeXML } from '../model/assets';
import { svg } from './icons';
import { cascade, cellRect, clampFloat, distribute, layoutCells, type LayoutKind, type Rect } from './view-layout';
import { viewMatrix, type ViewState } from './view-transform';

/** One window onto a document. A document can have several views (Window →
 * Arrange → New Window), each with its own zoom, scroll position and rotation. */
export class DocumentView {
  readonly id = crypto.randomUUID();
  zoom = 1;
  pan = { x: 0, y: 0 };
  rotation = 0;
  flip = false;
  // Position inside the canvas area while floating (in-app document window).
  floating?: Rect;
  // Most-recent-use stamp: frames show their most recently used view.
  used = 0;
  constructor(public session: DocumentSession) {}
  state(aspect = 1): ViewState {
    return { zoom: this.zoom, pan: this.pan, rotation: this.rotation, flip: this.flip, aspect };
  }
}

const modeLabels: Record<string, string> = { rgb: 'RGB', grayscale: 'Gray', cmyk: 'CMYK', lab: 'Lab', indexed: 'Index', bitmap: 'Bitmap', duotone: 'Duotone', multichannel: 'Multichannel' };
// Preview canvases of inactive views are capped so many windows stay cheap.
const SNAPSHOT_MAX = 4096;
type Snapshot = { canvas: HTMLCanvasElement; doc: PhotoDocument };

/** Document windows in the canvas area: the classic tab strip, tiled and
 * n-up layouts (each cell a tab group) and floating windows. Only the active
 * view hosts the live canvas, rulers and overlays; other visible views show a
 * copy of their document's last rendered frame, drawn with their own view. */
export class WindowManager {
  kind: LayoutKind = 'tabs';
  private frames: DocumentView[][] = [];
  private snapshots = new WeakMap<DocumentSession, Snapshot>();
  private drawQueued = false;
  private capturing?: Promise<void>;
  private host: HTMLElement;
  private area: HTMLElement;
  private workspace: HTMLElement;
  constructor(private e: Editor) {
    this.workspace = e.el('.workspace');
    this.area = e.el('.canvas-area');
    this.host = document.createElement('div');
    this.host.className = 'view-frames';
    this.host.hidden = true;
    // Before the bottom dock, which stays under the canvas in every layout.
    this.workspace.insertBefore(this.host, this.workspace.querySelector('.bottom-dock'));
    this.bind();
    new ResizeObserver(() => {
      if (!this.multi) return;
      this.position();
      this.queueDraw();
    }).observe(this.host);
  }
  /** True when the canvas area shows more than the classic tab strip. */
  get multi() {
    return this.kind !== 'tabs' || this.e.views.some((v) => v.floating);
  }
  /** Views placed in a docked frame (not floating), in tab order. */
  private get docked() {
    return this.e.views.filter((v) => !v.floating);
  }
  frameOf(v: DocumentView) {
    return this.frames.findIndex((f) => f.includes(v));
  }
  /** The view a frame currently shows (its most recently used). */
  shown(frame: DocumentView[]) {
    return frame.reduce<DocumentView | undefined>((best, v) => (!best || v.used > best.used ? v : best), undefined);
  }
  /** Views visible on screen right now. */
  get visible(): DocumentView[] {
    if (!this.multi) return [this.e.activeView];
    return [...this.frames.map((f) => this.shown(f)!).filter(Boolean), ...this.e.views.filter((v) => v.floating)];
  }
  setKind(kind: LayoutKind) {
    this.kind = kind;
    // Tiling docks every floating window.
    if (kind !== 'tabs') for (const v of this.e.views) v.floating = undefined;
    this.e.preferences.windowLayout = kind;
    this.e.savePreferences();
    this.refresh();
  }
  consolidate() {
    for (const v of this.e.views) v.floating = undefined;
    this.kind = 'tabs';
    this.e.preferences.windowLayout = 'tabs';
    this.e.savePreferences();
    this.refresh();
  }
  float(views: DocumentView[]) {
    const area = this.areaSize();
    let i = this.e.views.filter((v) => v.floating).length;
    for (const v of views) if (!v.floating) v.floating = cascade(i++, area);
    this.refresh();
  }
  /** Size a floating window to show its whole image at the current zoom
   * (within the workspace), keeping its top-left corner. */
  fitFloating(v: DocumentView) {
    if (!v.floating) return;
    const doc = v.session.doc;
    const rulers = this.e.preferences.showRulers ? 19 : 0,
      title = 24;
    const area = this.areaSize();
    const width = Math.round(doc.width * v.zoom * this.e.viewAspect(v.session)) + rulers + 2,
      height = Math.round(doc.height * v.zoom) + rulers + title + 2;
    v.floating = clampFloat({ ...v.floating, width: Math.max(160, Math.min(area.width, width)), height: Math.max(120, Math.min(area.height, height)) }, area);
    v.pan = { x: 0, y: 0 };
    this.position();
    this.e.view();
    this.e.overlay();
    this.queueDraw();
  }
  /** Re-layout and redraw. Views keep their zoom; the document point at a
   * window's center stays there when the window changes size. */
  refresh() {
    this.layout();
    this.e.view();
    this.e.overlay();
    void this.ensureSnapshots();
  }
  /** Build the window DOM and move the live canvas area into the active view. */
  layout() {
    const e = this.e;
    const multi = this.multi;
    this.workspace.classList.toggle('multi-view', multi);
    this.host.hidden = !multi;
    if (!multi) {
      this.frames = [this.e.views];
      if (this.area.parentElement !== this.workspace || this.area.previousElementSibling !== e.el('.document-tabs')) e.el('.document-tabs').after(this.area);
      this.host.innerHTML = '';
      return;
    }
    const docked = this.docked;
    const cells = layoutCells(this.kind, docked.length);
    this.frames = docked.length ? distribute(docked, cells.length) : [];
    this.area.remove();
    const floats = e.views.filter((v) => v.floating).sort((a, b) => a.used - b.used);
    this.host.innerHTML =
      this.frames.map((_, i) => `<section class="view-frame" data-frame="${i}"><div class="frame-tabs" role="tablist" aria-label="Documents"></div><div class="frame-body"></div></section>`).join('') +
      floats
        .map((v) => `<section class="view-frame view-float" data-float="${v.id}" role="dialog" aria-label="${escapeXML(v.session.doc.name)}"><div class="frame-tabs float-title" role="tablist" aria-label="Document"></div><div class="frame-body"></div><div class="float-resize" data-float-resize="${v.id}" aria-hidden="true"></div></section>`)
        .join('');
    for (const v of this.visible) {
      const body = this.bodyOf(v);
      if (!body) continue;
      if (v === e.activeView) body.append(this.area);
      else body.innerHTML = `<canvas class="view-preview" data-preview="${v.id}" aria-label="${escapeXML(v.session.doc.name)} (inactive window)"></canvas>`;
      body.closest('.view-frame')!.classList.toggle('active', v === e.activeView);
    }
    // An active view hidden behind another tab of its frame cannot happen:
    // activation always makes the view its frame's most recent one.
    this.position();
    this.renderTabs();
    this.queueDraw();
  }
  private bodyOf(v: DocumentView) {
    if (v.floating) return this.host.querySelector<HTMLElement>(`[data-float="${v.id}"] .frame-body`);
    const i = this.frameOf(v);
    return i < 0 ? null : this.host.querySelector<HTMLElement>(`[data-frame="${i}"] .frame-body`);
  }
  private position() {
    const size = this.areaSize();
    const cells = layoutCells(this.kind, this.docked.length);
    this.host.querySelectorAll<HTMLElement>('[data-frame]').forEach((el) => {
      const r = cellRect(cells[Number(el.dataset.frame)] ?? cells[0], size);
      Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px` });
    });
    for (const v of this.e.views) {
      if (!v.floating) continue;
      v.floating = clampFloat(v.floating, size);
      const el = this.host.querySelector<HTMLElement>(`[data-float="${v.id}"]`);
      if (el)
        Object.assign(el.style, { left: `${v.floating.x}px`, top: `${v.floating.y}px`, width: `${v.floating.width}px`, height: `${v.floating.height}px`, zIndex: String(10 + this.e.views.filter((o) => o.floating && o.used < v.used).length) });
    }
  }
  /** Size of the area that document windows share (the whole workspace column). */
  areaSize() {
    if (this.multi && this.host.clientWidth) return { width: this.host.clientWidth, height: this.host.clientHeight };
    return { width: this.workspace.clientWidth, height: this.workspace.clientHeight };
  }
  /** Size of the image area of a view's window (rulers excluded for the active one). */
  viewportSize(v: DocumentView) {
    if (v === this.e.activeView || !this.multi) {
      const vp = this.e.el('#viewport');
      return { width: vp.clientWidth || 800, height: vp.clientHeight || 600 };
    }
    const body = this.bodyOf(v);
    return { width: body?.clientWidth || 800, height: body?.clientHeight || 600 };
  }
  // ----- Tabs -----
  tabHTML(v: DocumentView) {
    const e = this.e,
      s = v.session,
      active = v === e.activeView;
    const mode = modeLabels[s.doc.mode ?? 'rgb'] ?? 'RGB';
    const badges = e.tabBadges.map((f) => f(s)).filter(Boolean);
    const siblings = e.views.filter((o) => o.session === s);
    const name = siblings.length > 1 ? `${s.doc.name} : ${siblings.indexOf(v) + 1}` : s.doc.name;
    const meta = `(${mode}/${s.doc.bitsPerChannel ?? 8}${badges.map((b) => `, ${escapeXML(b)}`).join('')})`;
    const label = `${escapeXML(name)} @ ${Math.round(v.zoom * 100)}% ${meta}`;
    const dirty = s.dirty || s.hasPendingEdits || e.hasPendingChanges(s);
    const shown = !this.multi ? active : this.visible.includes(v);
    return `<div class="document-tab ${shown ? 'active' : ''} ${active ? 'focused' : ''}" role="tab" aria-selected="${shown}" data-session="${s.id}" data-view="${v.id}" tabindex="${active ? 0 : -1}" title="${label}">${svg('image', 13)}<span ${active ? 'id="document-name"' : ''} class="tab-name">${escapeXML(s.doc.name)}</span>${siblings.length > 1 ? `<span class="tab-window">:${siblings.indexOf(v) + 1}</span>` : ''}<span class="tab-meta" ${active ? 'id="tab-zoom"' : ''}>@ ${Math.round(v.zoom * 100)}%</span><span class="document-mode">${meta}</span><span ${active ? 'id="dirty"' : ''} class="dirty-dot" aria-label="Unsaved changes" ${dirty ? '' : 'hidden'}>*</span><button class="tab-close" data-close-view="${v.id}" aria-label="Close ${label}" title="Close">${svg('x', 12)}</button></div>`;
  }
  /** Update only the marker: previews must not replace focused tab controls. */
  updateDirtyIndicators(s: DocumentSession = this.e.session) {
    const dirty = s.dirty || s.hasPendingEdits || this.e.hasPendingChanges(s);
    for (const tab of this.e.root.querySelectorAll<HTMLElement>('.document-tab')) {
      if (tab.dataset.session !== s.id) continue;
      const marker = tab.querySelector<HTMLElement>('.dirty-dot');
      if (marker && marker.hidden === dirty) marker.hidden = !dirty;
    }
  }
  renderTabs() {
    const e = this.e;
    if (!this.multi) {
      e.el('.document-tabs').innerHTML = e.views.map((v) => this.tabHTML(v)).join('');
      return;
    }
    e.el('.document-tabs').innerHTML = '';
    this.frames.forEach((frame, i) => {
      const bar = this.host.querySelector<HTMLElement>(`[data-frame="${i}"] .frame-tabs`);
      if (bar) bar.innerHTML = frame.map((v) => this.tabHTML(v)).join('');
    });
    for (const v of e.views) {
      const bar = v.floating && this.host.querySelector<HTMLElement>(`[data-float="${v.id}"] .frame-tabs`);
      if (bar) bar.innerHTML = this.tabHTML(v);
    }
  }
  // ----- Previews of inactive views -----
  /** Copy the active document's frame for its other visible views. */
  frame(canvas: HTMLCanvasElement, doc: PhotoDocument) {
    if (!this.multi) return;
    const s = this.e.session;
    if (doc.width !== s.doc.width || doc.height !== s.doc.height) return;
    this.capture(s, canvas);
    if (this.visible.some((v) => v.session === s && v !== this.e.activeView)) this.queueDraw();
  }
  private capture(s: DocumentSession, source: HTMLCanvasElement) {
    let snap = this.snapshots.get(s);
    const k = Math.min(1, SNAPSHOT_MAX / Math.max(source.width, source.height));
    const w = Math.max(1, Math.round(source.width * k)),
      h = Math.max(1, Math.round(source.height * k));
    if (!snap) {
      snap = { canvas: document.createElement('canvas'), doc: s.doc };
      this.snapshots.set(s, snap);
    }
    if (snap.canvas.width !== w || snap.canvas.height !== h) {
      snap.canvas.width = w;
      snap.canvas.height = h;
    }
    const c = snap.canvas.getContext('2d')!;
    c.clearRect(0, 0, w, h);
    c.drawImage(source, 0, 0, w, h);
    snap.doc = s.doc;
  }
  /** Render documents of visible inactive views that have no current frame. */
  async ensureSnapshots() {
    if (!this.multi || !this.e.renderer) return;
    if (this.capturing) return this.capturing;
    this.capturing = (async () => {
      try {
        const stale = [...new Set(this.visible.map((v) => v.session))].filter((s) => s !== this.e.session && this.snapshots.get(s)?.doc !== s.doc && s.hasDocument);
        for (const s of stale) await this.e.renderer.drawFrame(s.doc, s.assets, (canvas) => this.capture(s, canvas));
        if (stale.length) await this.e.render(this.e.displayDoc);
      } catch (error) {
        console.error(error);
      }
      this.queueDraw();
    })().finally(() => {
      // Even a no-op pass finishes after the promise has been installed.
      this.capturing = undefined;
    });
    return this.capturing;
  }
  queueDraw() {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.drawPreviews();
    });
  }
  private drawPreviews() {
    if (!this.multi) return;
    for (const canvas of this.host.querySelectorAll<HTMLCanvasElement>('canvas[data-preview]')) {
      const v = this.e.views.find((x) => x.id === canvas.dataset.preview);
      if (v) this.drawPreview(v, canvas);
    }
  }
  private drawPreview(v: DocumentView, canvas: HTMLCanvasElement) {
    const body = canvas.parentElement!;
    const dpr = devicePixelRatio || 1;
    const W = body.clientWidth,
      H = body.clientHeight;
    if (!W || !H) return;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    const c = canvas.getContext('2d')!;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, canvas.width, canvas.height);
    const doc = v.session.doc;
    if (!v.session.hasDocument) return;
    const m = viewMatrix(v.state(this.e.viewAspect(v.session)), doc, { width: W, height: H });
    c.setTransform(m[0] * dpr, m[1] * dpr, m[2] * dpr, m[3] * dpr, m[4] * dpr, m[5] * dpr);
    // Drop shadow, transparency checkerboard, then the document.
    c.shadowColor = 'rgba(0,0,0,0.45)';
    c.shadowBlur = 14 * dpr;
    c.fillStyle = '#fff';
    c.fillRect(0, 0, doc.width, doc.height);
    c.shadowColor = 'transparent';
    c.fillStyle = checker(c);
    c.fillRect(0, 0, doc.width, doc.height);
    const snap = this.snapshots.get(v.session);
    if (snap) {
      c.imageSmoothingEnabled = v.zoom * (doc.width / snap.canvas.width) < 2;
      c.imageSmoothingQuality = 'high';
      c.drawImage(snap.canvas, 0, 0, doc.width, doc.height);
    }
  }
  // ----- Input -----
  private bind() {
    // Pressing inside an inactive window makes it active (the press does not
    // reach the tool). Tabs and buttons are handled by the editor.
    this.host.addEventListener(
      'pointerdown',
      (ev) => {
        const t = ev.target as HTMLElement;
        const resize = t.closest<HTMLElement>('[data-float-resize]');
        const frame = t.closest<HTMLElement>('.view-frame');
        if (!frame) return;
        const floatId = frame.dataset.float;
        const owner = floatId ? this.e.views.find((v) => v.id === floatId) : this.shown(this.frames[Number(frame.dataset.frame)] ?? []);
        if (resize && owner?.floating) return this.dragFloat(ev, owner, 'resize');
        if (floatId && owner && t.closest('.float-title') && !t.closest('button')) {
          if (owner !== this.e.activeView) void this.e.showView(owner);
          return this.dragFloat(ev, owner, 'move');
        }
        if (owner && owner !== this.e.activeView && !t.closest('.document-tab,button')) {
          ev.preventDefault();
          ev.stopPropagation();
          void this.e.showView(owner);
        }
      },
      true,
    );
  }
  private dragFloat(ev: PointerEvent, v: DocumentView, mode: 'move' | 'resize') {
    ev.preventDefault();
    const start = { x: ev.clientX, y: ev.clientY, rect: { ...v.floating! } };
    const target = ev.target as HTMLElement;
    target.setPointerCapture(ev.pointerId);
    // Workspace → Enable floating document window docking: dropping the title
    // bar on a tab bar docks the window as a tab.
    const dockBar = (m: PointerEvent) => {
      if (mode !== 'move' || !this.e.preferences.floatDocking) return undefined;
      const bars = [this.e.el('.document-tabs'), ...this.host.querySelectorAll<HTMLElement>('.view-frame:not(.view-float) > .frame-tabs')];
      return bars.find((b) => {
        const r = b.getBoundingClientRect();
        return r.height > 0 && m.clientX >= r.left && m.clientX <= r.right && m.clientY >= r.top - 4 && m.clientY <= r.bottom + 4;
      });
    };
    let target0: HTMLElement | undefined;
    const move = (m: PointerEvent) => {
      const bar = dockBar(m);
      if (bar !== target0) {
        target0?.classList.remove('dock-drop-target');
        bar?.classList.add('dock-drop-target');
        target0 = bar;
      }
      const dx = m.clientX - start.x,
        dy = m.clientY - start.y;
      v.floating =
        mode === 'move'
          ? { ...start.rect, x: start.rect.x + dx, y: start.rect.y + dy }
          : { ...start.rect, width: start.rect.width + dx, height: start.rect.height + dy };
      this.position();
      if (mode === 'resize') {
        if (v === this.e.activeView) this.e.view();
        else this.queueDraw();
      }
    };
    const up = (m: PointerEvent) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      target0?.classList.remove('dock-drop-target');
      if (m.type === 'pointerup' && dockBar(m)) {
        v.floating = undefined;
        this.refresh();
        return;
      }
      this.e.view();
      this.e.overlay();
      this.queueDraw();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }
}

let checkerPattern: { ctx: CanvasRenderingContext2D; key: string; pattern: CanvasPattern } | undefined;
// Transparency grid colors follow Preferences → Transparency & Gamut.
function checker(c: CanvasRenderingContext2D) {
  const css = getComputedStyle(document.documentElement);
  const a = css.getPropertyValue('--checker-a').trim() || '#fff',
    b = css.getPropertyValue('--checker-b').trim() || '#ccc';
  if (checkerPattern?.ctx === c && checkerPattern.key === a + b) return checkerPattern.pattern;
  const tile = document.createElement('canvas');
  tile.width = tile.height = 20;
  const t = tile.getContext('2d')!;
  t.fillStyle = a;
  t.fillRect(0, 0, 20, 20);
  t.fillStyle = b;
  t.fillRect(10, 0, 10, 10);
  t.fillRect(0, 10, 10, 10);
  const pattern = c.createPattern(tile, 'repeat')!;
  checkerPattern = { ctx: c, key: a + b, pattern };
  return pattern;
}
