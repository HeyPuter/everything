// The Quick Compare view. The stored state is composited once into a canvas
// of its own (cached per document until the state or the display changes)
// and placed inside the stage, so zoom, scrolling, rotation and mirroring
// apply to it exactly as to the live canvas without recompositing anything.
// A split clips it with a screen-space half plane mapped into document
// space; side by side narrows the live window and shows the stored state in
// a pane with the same view; holding shows it whole while pressed.
import './compare.css';
import type { Editor } from '../../editor';
import type { DocumentSession } from '../../app/session';
import type { PhotoDocument } from '../../model/document';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';
import { onActivity } from '../../app/activity';
import { sessionSnapshots } from '../history-tools';
import {
  beforePlacement,
  cacheSize,
  clipPathCss,
  dividerKey,
  splitClip,
  type Orientation,
} from './geometry';
import {
  compareActive,
  compareState,
  loadLayout,
  saveLayout,
  setCompareState,
  type CompareMode,
  type CompareRef,
  type CompareState,
} from './state';

/** Options a script or test can pass: which stored state and how to show it. */
export type CompareOptions = {
  ref?: 'opened' | 'saved' | { snapshot: string } | { history: number };
  mode?: CompareMode;
  orientation?: Orientation;
  position?: number;
};

let view: CompareView | undefined;
const viewFor = (e: Editor) => (view ??= new CompareView(e));

/** View → Quick Compare: start comparing the active document, or stop. With
 * options, start or change the comparison without toggling it off. */
export async function quickCompare(e: Editor, arg?: unknown) {
  if (!e.hasDocument) return;
  const s = e.session;
  const current = compareState(s);
  const opts = arg && typeof arg === 'object' ? (arg as CompareOptions) : undefined;
  if (current && !opts) return exitCompare(e);
  const v = viewFor(e);
  const state: CompareState = current ?? {
    ref: { kind: 'opened' },
    ...loadLayout(),
    holding: false,
  };
  if (opts) {
    if (opts.mode && ['split', 'side', 'hold'].includes(opts.mode)) state.mode = opts.mode;
    if (opts.orientation === 'vertical' || opts.orientation === 'horizontal')
      state.orientation = opts.orientation;
    if (Number.isFinite(opts.position))
      state.position = Math.max(0, Math.min(1, Number(opts.position)));
    if (opts.ref) state.ref = v.refFrom(s, opts.ref) ?? state.ref;
  }
  if (!current) v.retain(s);
  setCompareState(s, state);
  v.sync();
  await v.ready(s);
}

/** Stop comparing a document (the active one by default). */
export function exitCompare(e: Editor, s: DocumentSession = e.session) {
  if (!compareState(s)) return;
  setCompareState(s, undefined);
  view?.forget(s);
  view?.sync();
}

/** The document state a comparison shows as "before". */
export function compareDoc(e: Editor, s: DocumentSession = e.session): PhotoDocument | undefined {
  const st = compareState(s);
  return st && resolve(e, s, st);
}
function resolve(e: Editor, s: DocumentSession, st: CompareState): PhotoDocument {
  const ref = st.ref;
  if (ref.kind === 'saved') return s.saved ?? s.history.opened;
  if (ref.kind === 'snapshot')
    return sessionSnapshots(e, s).find((x) => x.id === ref.id)?.doc ?? s.history.opened;
  if (ref.kind === 'history') return ref.doc;
  return s.history.opened;
}
function refName(e: Editor, s: DocumentSession, ref: CompareRef): string {
  if (ref.kind === 'saved') return s.saved ? 'Last saved' : 'Opened state';
  if (ref.kind === 'snapshot')
    return sessionSnapshots(e, s).find((x) => x.id === ref.id)?.name ?? 'Opened state';
  if (ref.kind === 'history') return ref.label;
  return 'Opened state';
}

type Cached = { doc: PhotoDocument; canvas: HTMLCanvasElement };
// Labels sit under the comparison bar, clear of the quick actions bar at the bottom.
const BELOW_BAR = 52;
// Commands that change how documents are displayed: the stored state is drawn again.
const DISPLAY_COMMANDS = /^view\.(proof|gamut|hdr)|^edit\.color-settings/;

class CompareView {
  private cache = new WeakMap<DocumentSession, Cached>();
  private jobs = new WeakMap<DocumentSession, Promise<void>>();
  private retained = new WeakSet<DocumentSession>();
  private bar: HTMLElement;
  private select: HTMLSelectElement;
  private status: HTMLElement;
  private divider: HTMLElement;
  private surface: HTMLElement;
  private beforeLabel: HTMLElement;
  private afterLabel: HTMLElement;
  private pane: HTMLElement;
  private paneStage: HTMLElement;
  private paneLabel: HTMLElement;
  private shown?: Cached;
  private optionsKey = '';
  private sideOn = '';
  constructor(private e: Editor) {
    const vp = e.el('#viewport');
    this.bar = document.createElement('div');
    this.bar.className = 'compare-bar canvas-ui';
    this.bar.setAttribute('role', 'toolbar');
    this.bar.setAttribute('aria-label', 'Quick Compare');
    this.bar.hidden = true;
    const mode = (m: CompareMode, icon: string, label: string, title: string) =>
      `<button type="button" class="icon-button" role="radio" data-mode="${m}" aria-label="${label}" title="${title}">${svg(icon, 16)}</button>`;
    this.bar.innerHTML = `<label class="compare-ref"><span>Compare with</span><select aria-label="Compare with"></select></label>
<span class="compare-sep" aria-hidden="true"></span>
<div class="compare-modes" role="radiogroup" aria-label="Comparison view">${mode('split', 'compare-split', 'Split', 'Split: drag the divider')}${mode('side', 'compare-side', 'Side by side', 'Side by side, with the same zoom and position')}${mode('hold', 'eye', 'Press and hold', 'Press and hold the image to see the stored state')}</div>
<button type="button" class="icon-button compare-orient" aria-pressed="false" aria-label="Top and bottom" title="Arrange top and bottom">${svg('compare-split-h', 16)}</button>
<button type="button" class="compare-hold" title="Hold to show the stored state over the whole image (or hold \\)">${svg('eye', 14)}<span>Hold</span></button>
<span class="compare-status" role="status" aria-live="polite"></span>
<button type="button" class="compare-done" title="Finish comparing (Esc or \\)">Done</button>`;
    this.select = this.bar.querySelector('select')!;
    this.status = this.bar.querySelector('.compare-status')!;
    this.divider = document.createElement('div');
    this.divider.className = 'compare-divider canvas-ui';
    this.divider.tabIndex = 0;
    this.divider.setAttribute('role', 'slider');
    this.divider.setAttribute(
      'aria-label',
      'Divider between the stored state and the current image',
    );
    this.divider.setAttribute('aria-valuemin', '0');
    this.divider.setAttribute('aria-valuemax', '100');
    this.divider.title = 'Drag to compare; double-click to center';
    this.divider.innerHTML = `<span class="compare-line"></span><span class="compare-knob">${svg('arrow-left-right', 14)}</span>`;
    this.divider.hidden = true;
    this.surface = document.createElement('div');
    this.surface.className = 'compare-surface canvas-ui';
    this.surface.title = 'Press and hold to see the stored state';
    this.surface.hidden = true;
    const label = () => {
      const el = document.createElement('div');
      el.className = 'compare-label canvas-ui';
      el.hidden = true;
      return el;
    };
    this.beforeLabel = label();
    this.afterLabel = label();
    vp.append(this.surface, this.divider, this.beforeLabel, this.afterLabel, this.bar);
    this.pane = document.createElement('div');
    this.pane.className = 'compare-pane';
    this.pane.setAttribute('aria-label', 'Stored state');
    this.pane.hidden = true;
    this.paneStage = document.createElement('div');
    this.paneStage.className = 'compare-stage';
    this.paneLabel = label();
    this.paneLabel.classList.remove('canvas-ui');
    this.pane.append(this.paneStage, this.paneLabel);
    e.el('.canvas-area').append(this.pane);
    this.bind();
    e.onUpdate(() => this.sync());
    e.viewHooks.push(() => this.layout());
    onActivity((a) => {
      if (a.kind === 'command' && DISPLAY_COMMANDS.test(a.id)) this.redraw();
    });
  }
  /** Keep a chosen history state's tiles while it is compared, also after
   * History drops it. */
  retain(s: DocumentSession) {
    if (this.retained.has(s)) return;
    this.retained.add(s);
    s.retained.push(() => {
      const st = compareState(s);
      return st?.ref.kind === 'history' ? [st.ref.doc] : [];
    });
  }
  forget(s: DocumentSession) {
    const c = this.cache.get(s);
    if (c && c === this.shown) {
      c.canvas.remove();
      this.shown = undefined;
    }
    this.cache.delete(s);
  }
  refFrom(s: DocumentSession, ref: NonNullable<CompareOptions['ref']>): CompareRef | undefined {
    if (ref === 'opened') return { kind: 'opened' };
    if (ref === 'saved') return s.saved ? { kind: 'saved' } : undefined;
    if (typeof ref === 'object' && 'snapshot' in ref)
      return sessionSnapshots(this.e, s).some((x) => x.id === ref.snapshot)
        ? { kind: 'snapshot', id: ref.snapshot }
        : undefined;
    if (typeof ref === 'object' && 'history' in ref) {
      const entry = s.history.entries[Math.floor(ref.history)];
      return entry
        ? { kind: 'history', doc: entry.doc, label: this.historyLabel(s, Math.floor(ref.history)) }
        : undefined;
    }
    return undefined;
  }
  private historyLabel(s: DocumentSession, i: number) {
    const entry = s.history.entries[i];
    if (!entry) return '';
    return i === 0 ? entry.label || `${s.doc.name} (opened)` : entry.label;
  }
  /** Resolves once the stored state of `s` is drawn. */
  async ready(s: DocumentSession) {
    while (this.jobs.get(s)) await this.jobs.get(s);
  }
  private redraw() {
    const s = this.e.session;
    if (!compareState(s)) return;
    this.forget(s);
    this.sync();
  }

  // ----- State → DOM -----
  sync() {
    const e = this.e,
      s = e.session;
    const st = e.hasDocument ? compareState(s) : undefined;
    if (!st) return this.hide();
    // A deleted snapshot or a save that has not happened falls back to the opened state.
    const ref = st.ref;
    if (
      (ref.kind === 'snapshot' && !sessionSnapshots(e, s).some((x) => x.id === ref.id)) ||
      (ref.kind === 'saved' && !s.saved)
    )
      st.ref = { kind: 'opened' };
    this.bar.hidden = false;
    this.options(s, st);
    const doc = resolve(e, s, st);
    if (this.cache.get(s)?.doc !== doc) this.render(s, doc);
    this.layout();
  }
  private hide() {
    for (const el of [this.bar, this.divider, this.surface, this.beforeLabel, this.afterLabel])
      el.hidden = true;
    this.shown?.canvas.remove();
    this.shown = undefined;
    this.setSide('');
  }
  /** Narrow the live window for side by side ('' turns it off). */
  private setSide(side: '' | Orientation) {
    if (side === this.sideOn) return;
    this.sideOn = side;
    const area = this.e.el('.canvas-area');
    area.classList.toggle('compare-side-vertical', side === 'vertical');
    area.classList.toggle('compare-side-horizontal', side === 'horizontal');
    this.pane.hidden = !side;
    // The viewport changed size: lay the view out again now (the resize
    // observer follows a frame later).
    this.e.view();
    this.e.overlay();
  }
  private options(s: DocumentSession, st: CompareState) {
    const e = this.e;
    const entries = s.history.entries,
      position = s.history.position;
    const opt = (value: string, label: string, disabled = false) =>
      `<option value="${escapeXML(value)}" ${disabled ? 'disabled' : ''}>${escapeXML(label)}</option>`;
    const snaps = sessionSnapshots(e, s);
    const history = entries
      .map((entry, i) => {
        // The first state is offered above while it is the opened document.
        if (i === 0 && entry.doc === s.history.opened) return '';
        const mark = i === position ? ' (current)' : i > position ? ' (undone)' : '';
        return opt(`history:${i}`, `${this.historyLabel(s, i)}${mark}`);
      })
      .join('');
    const ref = st.ref;
    const kept =
      ref.kind === 'history' && !entries.some((x) => x.doc === ref.doc)
        ? opt('history:kept', `${ref.label} (no longer in History)`)
        : '';
    const html =
      opt('opened', 'Opened state') +
      opt('saved', s.saved ? 'Last saved' : 'Last saved (not saved yet)', !s.saved) +
      (snaps.length
        ? `<optgroup label="Snapshots">${snaps.map((x) => opt(`snapshot:${x.id}`, x.name)).join('')}</optgroup>`
        : '') +
      (history || kept ? `<optgroup label="History">${history}${kept}</optgroup>` : '');
    if (html !== this.optionsKey) {
      this.optionsKey = html;
      this.select.innerHTML = html;
    }
    let value = ref.kind === 'snapshot' ? `snapshot:${ref.id}` : ref.kind;
    if (ref.kind === 'history') {
      const i = entries.findIndex((x) => x.doc === ref.doc);
      // The opened document listed as the first history state is the opened state.
      value =
        i < 0
          ? 'history:kept'
          : i === 0 && ref.doc === s.history.opened
            ? 'opened'
            : `history:${i}`;
    }
    this.select.value = value;
    for (const b of this.bar.querySelectorAll<HTMLButtonElement>('[data-mode]'))
      b.setAttribute('aria-checked', String(b.dataset.mode === st.mode));
    const orient = this.bar.querySelector<HTMLButtonElement>('.compare-orient')!;
    orient.setAttribute('aria-pressed', String(st.orientation === 'horizontal'));
    orient.disabled = st.mode === 'hold';
    this.bar.querySelector<HTMLButtonElement>('.compare-hold')!.hidden = st.mode === 'side';
  }
  /** Composite the stored state once into a canvas of its own. */
  private render(s: DocumentSession, doc: PhotoDocument) {
    const e = this.e;
    const previous = this.jobs.get(s) ?? Promise.resolve();
    const job: Promise<void> = previous
      .then(async () => {
        const st = compareState(s);
        // Superseded while waiting, or already drawn.
        if (!st || resolve(e, s, st) !== doc || this.cache.get(s)?.doc === doc) return;
        this.status.textContent = 'Drawing the stored state…';
        const canvas = document.createElement('canvas');
        canvas.className = 'compare-before';
        canvas.setAttribute('aria-hidden', 'true');
        await e.renderer.drawFrame(doc, s.assets, (src) => {
          const size = cacheSize(src.width, src.height);
          canvas.width = size.width;
          canvas.height = size.height;
          const g = canvas.getContext('2d')!;
          g.imageSmoothingQuality = 'high';
          g.drawImage(src, 0, 0, size.width, size.height);
        });
        // The live canvas showed the stored state for that frame: draw the shown document again.
        await e.render(e.shownDoc);
        if (compareState(s) !== st) return;
        const old = this.cache.get(s);
        if (old && old === this.shown) {
          old.canvas.remove();
          this.shown = undefined;
        }
        this.cache.set(s, { doc, canvas });
      })
      .catch((error) => {
        console.error(error);
        e.message(
          `Quick Compare could not draw the stored state: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        if (this.jobs.get(s) === job) {
          this.jobs.delete(s);
          this.status.textContent = '';
        }
        this.layout();
      });
    this.jobs.set(s, job);
  }
  /** Place the stored state, the divider and the labels for the current view. */
  layout() {
    const e = this.e,
      s = e.session;
    const st = e.hasDocument ? compareState(s) : undefined;
    if (!st || this.bar.hidden) return;
    const vp = e.el('#viewport'),
      stage = e.el('#stage');
    this.setSide(st.mode === 'side' ? st.orientation : '');
    const size = { width: vp.clientWidth, height: vp.clientHeight };
    const cached = this.cache.get(s);
    if (this.shown !== cached) {
      this.shown?.canvas.remove();
      this.shown = cached;
    }
    const split = st.mode === 'split',
      side = st.mode === 'side';
    const place = cached ? beforePlacement(cached.doc, e.doc) : undefined;
    if (cached && place) {
      const c = cached.canvas;
      Object.assign(c.style, {
        left: `${place.x}px`,
        top: `${place.y}px`,
        width: `${place.width}px`,
        height: `${place.height}px`,
      });
      if (side) {
        if (c.parentElement !== this.paneStage) this.paneStage.append(c);
        c.style.clipPath = '';
        c.hidden = false;
      } else {
        if (c.parentElement !== stage) stage.querySelector('#canvas')!.after(c);
        c.hidden = !split && !st.holding;
        c.style.clipPath =
          split && !st.holding
            ? clipPathCss(splitClip(e.viewMatrix(), size, st.orientation, st.position, place))
            : '';
      }
    }
    if (side) {
      // The pane has the window's size, so the stage's transform applies as is.
      Object.assign(this.paneStage.style, {
        width: stage.style.width,
        height: stage.style.height,
        transform: stage.style.transform,
      });
      this.paneStage.classList.toggle('pixelated', stage.classList.contains('pixelated'));
    }
    // Divider
    const vertical = st.orientation === 'vertical';
    this.divider.hidden = !split || st.holding;
    this.divider.classList.toggle('horizontal', !vertical);
    this.divider.setAttribute('aria-orientation', vertical ? 'horizontal' : 'vertical');
    this.divider.setAttribute('aria-valuenow', String(Math.round(st.position * 100)));
    this.divider.setAttribute('aria-valuetext', `${Math.round(st.position * 100)}% stored state`);
    if (vertical)
      Object.assign(this.divider.style, { left: `${st.position * size.width}px`, top: '0px' });
    else Object.assign(this.divider.style, { top: `${st.position * size.height}px`, left: '0px' });
    this.surface.hidden = st.mode !== 'hold';
    this.surface.classList.toggle('holding', st.holding);
    // Labels
    const name = refName(e, s, st.ref);
    const drawing = !cached || cached.doc !== resolve(e, s, st);
    const before = `<b>Before</b> ${escapeXML(name)}${drawing ? ' …' : ''}`,
      after = '<b>After</b> Current';
    const put = (
      el: HTMLElement,
      html: string,
      at: Partial<Record<'left' | 'right' | 'top' | 'bottom', number>> | null,
    ) => {
      el.hidden = !at;
      if (!at) return;
      if (el.innerHTML !== html) el.innerHTML = html;
      el.style.left = at.left !== undefined ? `${at.left}px` : '';
      el.style.right = at.right !== undefined ? `${at.right}px` : '';
      el.style.top = at.top !== undefined ? `${at.top}px` : '';
      el.style.bottom = at.bottom !== undefined ? `${at.bottom}px` : '';
    };
    const room = 120;
    this.paneLabel.hidden = true;
    if (split && !st.holding) {
      const p = st.position;
      if (vertical) {
        put(
          this.beforeLabel,
          before,
          p * size.width > room
            ? { right: size.width - p * size.width + 12, top: BELOW_BAR }
            : null,
        );
        put(
          this.afterLabel,
          after,
          (1 - p) * size.width > room ? { left: p * size.width + 12, top: BELOW_BAR } : null,
        );
      } else {
        put(
          this.beforeLabel,
          before,
          p * size.height > 80
            ? { left: 12, top: Math.max(BELOW_BAR, p * size.height - 36) }
            : null,
        );
        put(
          this.afterLabel,
          after,
          (1 - p) * size.height > 48 ? { left: 12, top: p * size.height + 12 } : null,
        );
      }
    } else if (side) {
      put(this.beforeLabel, '', null);
      put(this.afterLabel, after, { left: 12, top: BELOW_BAR });
      put(this.paneLabel, before, { left: 12, top: BELOW_BAR });
    } else {
      put(this.beforeLabel, '', null);
      put(
        this.afterLabel,
        st.holding
          ? before
          : `${after}<span class="compare-hint"> · press and hold to see ${escapeXML(name.toLowerCase())}</span>`,
        { left: 12, top: BELOW_BAR },
      );
    }
  }

  // ----- Input -----
  private state() {
    return this.e.hasDocument ? compareState(this.e.session) : undefined;
  }
  private setHolding(on: boolean) {
    const st = this.state();
    if (!st || st.holding === on) return;
    st.holding = on;
    this.layout();
  }
  private remember(st: CompareState) {
    saveLayout(st);
  }
  private bind() {
    const e = this.e;
    this.bar.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    this.bar.addEventListener('click', (ev) => {
      const st = this.state();
      if (!st) return;
      const t = ev.target as HTMLElement;
      const mode = t.closest<HTMLElement>('[data-mode]')?.dataset.mode as CompareMode | undefined;
      if (mode) {
        st.mode = mode;
        st.holding = false;
        this.remember(st);
        this.sync();
      } else if (t.closest('.compare-orient')) {
        st.orientation = st.orientation === 'vertical' ? 'horizontal' : 'vertical';
        this.remember(st);
        this.sync();
      } else if (t.closest('.compare-done')) {
        exitCompare(e);
        e.el('#viewport').focus({ preventScroll: true });
      }
    });
    this.select.addEventListener('change', () => {
      const st = this.state();
      if (!st) return;
      const s = e.session,
        v = this.select.value;
      if (v === 'history:kept') return;
      const colon = v.indexOf(':');
      const kind = colon < 0 ? v : v.slice(0, colon),
        id = v.slice(colon + 1);
      const ref: CompareRef | undefined =
        v === 'opened' || v === 'saved'
          ? this.refFrom(s, v)
          : kind === 'snapshot'
            ? this.refFrom(s, { snapshot: id })
            : kind === 'history'
              ? this.refFrom(s, { history: Number(id) })
              : undefined;
      if (ref) st.ref = ref;
      this.sync();
    });
    // Hold button (pointer, Space or Enter).
    const hold = this.bar.querySelector<HTMLButtonElement>('.compare-hold')!;
    hold.addEventListener('pointerdown', (ev) => {
      hold.setPointerCapture(ev.pointerId);
      this.setHolding(true);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur'])
      hold.addEventListener(type, () => this.setHolding(false));
    hold.addEventListener('keydown', (ev) => {
      if ((ev.key === ' ' || ev.key === 'Enter') && !ev.repeat) {
        ev.preventDefault();
        this.setHolding(true);
      }
    });
    hold.addEventListener('keyup', (ev) => {
      if (ev.key === ' ' || ev.key === 'Enter') this.setHolding(false);
    });
    // Press and hold on the image.
    this.surface.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.surface.setPointerCapture(ev.pointerId);
      this.setHolding(true);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
      this.surface.addEventListener(type, () => this.setHolding(false));
    // Divider: drag, keys, double-click to center.
    const d = this.divider;
    d.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      d.focus({ preventScroll: true });
      d.setPointerCapture(ev.pointerId);
      d.classList.add('dragging');
      const vp = e.el('#viewport');
      const move = (m: PointerEvent) => {
        const st = this.state();
        if (!st) return;
        const r = vp.getBoundingClientRect();
        const p =
          st.orientation === 'vertical'
            ? (m.clientX - r.left) / r.width
            : (m.clientY - r.top) / r.height;
        st.position = Math.max(0, Math.min(1, p));
        this.layout();
      };
      const up = () => {
        d.classList.remove('dragging');
        d.removeEventListener('pointermove', move);
        d.removeEventListener('pointerup', up);
        d.removeEventListener('pointercancel', up);
        const st = this.state();
        if (st) this.remember(st);
      };
      d.addEventListener('pointermove', move);
      d.addEventListener('pointerup', up);
      d.addEventListener('pointercancel', up);
    });
    d.addEventListener('dblclick', () => {
      const st = this.state();
      if (!st) return;
      st.position = 0.5;
      this.remember(st);
      this.layout();
    });
    d.addEventListener('keydown', (ev) => {
      const st = this.state();
      if (!st) return;
      const next = dividerKey(st.position, ev.key, ev.shiftKey);
      if (next === undefined) return;
      ev.preventDefault();
      ev.stopPropagation();
      st.position = next;
      this.remember(st);
      this.layout();
    });
    // Scrolling over the side pane zooms and scrolls the shared view.
    this.pane.addEventListener(
      'wheel',
      (ev) => {
        const vp = e.el('#viewport');
        const a = this.pane.getBoundingClientRect(),
          b = vp.getBoundingClientRect();
        ev.preventDefault();
        vp.dispatchEvent(
          new WheelEvent('wheel', {
            clientX: ev.clientX - a.left + b.left,
            clientY: ev.clientY - a.top + b.top,
            deltaX: ev.deltaX,
            deltaY: ev.deltaY,
            deltaMode: ev.deltaMode,
            ctrlKey: ev.ctrlKey,
            metaKey: ev.metaKey,
            altKey: ev.altKey,
            shiftKey: ev.shiftKey,
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      { passive: false },
    );
    // Esc finishes, after tools and dialogs had their turn (this listener is
    // on the window, so it runs after the editor's own key handling).
    window.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape' || ev.defaultPrevented || !compareActive(e)) return;
      const t = ev.target as HTMLElement;
      if (
        t.closest('dialog,.menubar,.menu,[role="menu"]') ||
        document.querySelector('dialog[open]')
      )
        return;
      if (t.closest('input,textarea,select,[contenteditable="true"]') && !t.closest('.compare-bar'))
        return;
      if (e.transform.active || e.toolBusy || e.modal || e.menubar?.isOpen) return;
      ev.preventDefault();
      exitCompare(e);
    });
  }
}
