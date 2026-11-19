// The video track lane of the multitrack editor: a row above the audio tracks
// with the session's video clip drawn as a strip of thumbnails. The clip
// moves with a drag, trims at its edges (it previews like an audio clip drag
// and commits one undo step on release), nudges with the arrow keys and has
// a context menu. Clicks outside the clip move the playhead.

import { h, announce } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { cssVar, CANVAS_FONT, resolvedTheme } from '../ui/theme.js';
import { contextMenu } from '../ui/menubar.js';
import { videoClip, videoPool, moveVideoClip, trimVideoClip, videoSourceFrames, thumbnailTiles } from '../model/session-video.js';
import { Thumbnailer } from './thumbs.js';

const EDGE = 6;
const HEADER_BAR = 14;
/** Clip color: a neutral slate that reads as "picture" next to the track colors. */
const VIDEO_COLOR = '#6f7fa0';

export const VIDEO_CONTEXT = ['video.toPlayhead', 'video.toStart', 'video.lock', '-', 'video.remove', '-', 'video.showPanel'];

const thumbnailers = new WeakMap(); // pool entry -> Thumbnailer (shared by every view of a session)

export class VideoLane {
  /** @param {import('../editor/multitrack-view.js').MultitrackView} view */
  constructor(view) {
    this.view = view;
    this.app = view.app;
    this.doc = view.doc;
    this.selected = false;
    this.drag = null;
    this.last = null;
    this.width = 0;
    this.height = 0;
    this.canvas = h('canvas.mt-video-canvas', { 'aria-hidden': 'true' });
    this.playheadEl = h('div.playhead', { 'aria-hidden': 'true' });
    // Where a dragged audio clip starts (or the trimmed edge), while the Video panel shows that frame.
    this.spotEl = h('div.mt-video-spot', { 'aria-hidden': 'true', hidden: true });
    this.spot = null;
    this.lane = h('div.mt-video-lane', { tabindex: '0', role: 'group', 'aria-roledescription': 'video track', 'aria-label': 'Video track' }, this.canvas, this.spotEl, this.playheadEl);
    this.offSpot = this.app.on?.('clip-spot', (doc, frame) => {
      if (doc !== this.doc) return;
      this.spot = frame !== null && frame !== undefined && this.app.prefs.get('videoSpot') !== false ? frame : null;
      this.app.requestRender?.();
    });
    this.nameEl = h('span.mt-video-name');
    this.panelBtn = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Show Video Panel', title: 'Show Video Panel', onclick: () => this.app.commands.run('video.showPanel') }, icon('monitor-play', 14));
    this.head = h('div.mt-video-head', h('span.mt-video-glyph', icon('film', 14)), h('span.mt-video-label', 'Video'), this.nameEl, this.panelBtn);
    this.el = h('div.mt-video-row', { hidden: true }, this.head, h('div.mt-video-gap'), this.lane, h('div.mt-video-corner'));
    this.#bind();
    this.resizeObserver = new ResizeObserver(() => this.#measure());
    this.resizeObserver.observe(this.lane);
    this.offDoc = this.doc.on('change', (e) => {
      // Picking an audio clip moves the selection away from the video clip.
      if (e.kind === 'clip-selection' && this.doc.selectedClips.size && this.selected) this.#select(false);
    });
    this.sync();
  }

  get clip() {
    return videoClip(this.doc.viewState);
  }

  get source() {
    const v = this.clip;
    return v ? videoPool(this.doc).get(v.sourceId) || null : null;
  }

  /** Shows or hides the row to match the session; returns true when that changed. */
  sync() {
    const v = this.clip;
    const show = Boolean(v);
    const changed = this.el.hidden === show;
    this.el.hidden = !show;
    this.view.el?.classList.toggle('has-video', show);
    if (!show && this.selected) this.selected = false;
    const name = v ? v.name : '';
    if (this.nameEl.textContent !== name) {
      this.nameEl.textContent = name;
      this.nameEl.title = name;
    }
    this.lane.setAttribute('aria-label', v ? `Video track: ${v.name}${v.locked ? ', locked' : ''}` : 'Video track');
    return changed;
  }

  #measure() {
    const r = this.lane.getBoundingClientRect();
    this.width = Math.max(0, r.width);
    this.height = Math.max(0, r.height);
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.last = null;
    this.app.requestRender?.();
  }

  #thumbnailer(src) {
    if (!src?.blob) return null;
    let t = thumbnailers.get(src);
    if (!t) {
      t = new Thumbnailer(src, () => {
        for (const fn of t.listeners) fn();
      });
      t.listeners = new Set();
      thumbnailers.set(src, t);
    }
    if (!this.onThumb) {
      this.onThumb = () => {
        this.last = null;
        this.app.requestRender?.();
      };
    }
    t.listeners.add(this.onThumb);
    this.thumbs = t;
    return t;
  }

  /** Called from the view's frame(): redraws when anything the lane shows changed. */
  frame() {
    if (this.sync()) this.view.layout();
    if (this.el.hidden || !this.width) return;
    const doc = this.doc;
    const v = doc.view;
    const sel = doc.selection;
    const key = [v.start, v.end, this.width, this.height, this.clip, this.source, this.selected, resolvedTheme(), sel.start, sel.end, this.view.width];
    if (!this.last || key.some((x, i) => x !== this.last[i])) {
      this.last = key;
      this.#draw();
    }
    const p = this.app.active === doc ? this.app.playhead : doc.cursor;
    const x = this.view.xOf(p);
    this.playheadEl.style.transform = `translateX(${Math.round(x)}px)`;
    this.playheadEl.style.display = x >= -1 && x <= this.width + 1 ? '' : 'none';
    const sx = this.spot === null ? -1 : this.view.xOf(this.spot);
    this.spotEl.hidden = this.spot === null || sx < -1 || sx > this.width + 1;
    if (!this.spotEl.hidden) this.spotEl.style.transform = `translateX(${Math.round(sx)}px)`;
  }

  #rect() {
    const v = this.clip;
    if (!v) return null;
    const x0 = this.view.xOf(v.start);
    const x1 = this.view.xOf(v.start + v.length);
    return { x0, x1, y: 2, h: Math.max(4, this.height - 4) };
  }

  #draw() {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const dpr = this.dpr || 1;
    const W = this.width;
    const H = this.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = cssVar('--bg-track');
    ctx.fillRect(0, 0, W, H);
    const doc = this.doc;
    const sel = doc.selection;
    if (sel.end > sel.start) {
      const a = Math.max(0, this.view.xOf(sel.start));
      const b = Math.min(W, this.view.xOf(sel.end));
      if (b > a) {
        ctx.fillStyle = cssVar('--accent-soft');
        ctx.fillRect(a, 0, b - a, H);
      }
    }
    const r = this.#rect();
    if (r && r.x1 > -2 && r.x0 < W + 2) this.#drawClip(ctx, r, W);
    ctx.fillStyle = cssVar('--border');
    ctx.fillRect(0, H - 1, W, 1);
  }

  #drawClip(ctx, r, W) {
    const v = this.clip;
    const src = this.source;
    const dark = resolvedTheme() === 'dark';
    const x0 = Math.max(-2, r.x0);
    const x1 = Math.min(W + 2, r.x1);
    const hb = r.h >= 30 ? HEADER_BAR : 0;
    const offline = !src?.blob;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, r.y, x1 - x0, r.h);
    ctx.clip();
    ctx.fillStyle = offline ? cssVar('--text-faint') : VIDEO_COLOR;
    ctx.globalAlpha = this.selected ? 0.5 : dark ? 0.32 : 0.26;
    ctx.fillRect(x0, r.y, x1 - x0, r.h);
    ctx.globalAlpha = 1;
    // Thumbnails under the name bar.
    const ty = r.y + hb;
    const th = r.h - hb;
    const thumbs = offline ? null : this.#thumbnailer(src);
    if (thumbs && th > 6 && !thumbs.failed) {
      const aspect = src.width > 0 && src.height > 0 ? src.width / src.height : 16 / 9;
      thumbs.setHeight(th * (this.dpr || 1));
      const tileWidth = Math.max(16, th * aspect);
      const { tiles, step } = thumbnailTiles({ clip: v, viewStart: this.doc.view.start, fpp: this.view.fpp, width: W, tileWidth, rate: this.doc.sampleRate, duration: src.duration });
      const want = [];
      for (const t of tiles) {
        let img = thumbs.get(t.time);
        if (!img) {
          want.push(t.time);
          img = thumbs.nearest(t.time, Math.max(step * 8, 2));
        }
        if (img) ctx.drawImage(img, t.x, ty, tileWidth, th);
        // A hairline between tiles keeps the strip readable at any zoom.
        ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
        ctx.fillRect(Math.round(t.x), ty, 1, th);
      }
      if (want.length) thumbs.request(want);
    }
    if (offline) {
      ctx.strokeStyle = cssVar('--danger');
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      for (let x = x0 - (x0 % 12); x < x1; x += 12) {
        ctx.moveTo(x, r.y + r.h);
        ctx.lineTo(x + Math.min(r.h, 40), r.y + r.h - Math.min(r.h, 40));
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (hb) {
      ctx.fillStyle = offline ? cssVar('--text-faint') : VIDEO_COLOR;
      ctx.globalAlpha = this.selected ? 0.95 : 0.75;
      ctx.fillRect(x0, r.y, x1 - x0, hb);
      ctx.globalAlpha = 1;
      ctx.font = CANVAS_FONT;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      const label = `${v.name}${v.locked ? ' (locked)' : ''}${offline ? ' (media offline)' : ''}`;
      ctx.fillText(label, Math.max(x0, 0) + 5, r.y + hb / 2 + 0.5, Math.max(10, x1 - Math.max(x0, 0) - 10));
    } else if (offline) {
      ctx.font = CANVAS_FONT;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = cssVar('--text');
      ctx.fillText('Media offline', Math.max(x0, 0) + 5, r.y + r.h / 2);
    }
    ctx.restore();
    ctx.strokeStyle = this.selected ? cssVar('--accent-strong') : 'rgba(0, 0, 0, 0.45)';
    ctx.lineWidth = this.selected ? 2 : 1;
    ctx.strokeRect(r.x0 + 0.5, r.y + 0.5, r.x1 - r.x0 - 1, r.h - 1);
    ctx.lineWidth = 1;
  }

  // ------------------------------------------------------------ interaction

  #select(on) {
    if (this.selected === on) return;
    this.selected = on;
    this.last = null;
    this.app.requestRender?.();
  }

  #hit(x) {
    const r = this.#rect();
    if (!r || x < r.x0 - 2 || x > r.x1 + 2) return null;
    const w = r.x1 - r.x0;
    const edge = Math.min(EDGE, w / 4);
    if (x - r.x0 <= edge) return 'in';
    if (r.x1 - x <= edge) return 'out';
    return 'body';
  }

  #local(e) {
    const r = this.lane.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  #bind() {
    const lane = this.lane;
    lane.addEventListener('pointermove', (e) => {
      if (this.drag) return this.#dragMove(e);
      const part = this.#hit(this.#local(e).x);
      lane.style.cursor = this.clip?.locked ? '' : part === 'in' || part === 'out' ? 'ew-resize' : part === 'body' ? 'grab' : '';
    });
    lane.addEventListener('pointerdown', (e) => {
      lane.focus({ preventScroll: true });
      if (e.button !== 0) return;
      const { x } = this.#local(e);
      const part = this.#hit(x);
      if (!part) {
        this.#select(false);
        this.view.seek(this.view.snap(Math.max(0, this.view.frameAt(x))));
        return;
      }
      if (this.doc.selectedClips.size) this.doc.selectClips([]);
      this.#select(true);
      if (this.clip.locked) return;
      e.preventDefault();
      try {
        lane.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic pointers cannot be captured; the drag still works inside the lane.
      }
      this.drag = { part, x0: x, state: this.doc.state, moved: false };
    });
    const end = (e, cancel) => {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      const doc = this.doc;
      if (cancel || !d.moved || !doc.previewState) {
        doc.preview(null);
        return;
      }
      const label = d.part === 'body' ? 'Move Video Clip' : 'Trim Video Clip';
      doc.apply(label, doc.previewState);
      announce(`${label}: starts at ${this.app.formatTime(this.clip.start, doc.sampleRate)}`);
    };
    lane.addEventListener('pointerup', (e) => end(e, false));
    lane.addEventListener('pointercancel', (e) => end(e, true));
    lane.addEventListener('lostpointercapture', (e) => end(e, false));
    lane.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const part = this.#hit(this.#local(e).x);
      if (!part) return;
      this.#select(true);
      contextMenu(this.app, VIDEO_CONTEXT, e.clientX, e.clientY, 'Video clip context menu');
    });
    lane.addEventListener('keydown', (e) => this.#key(e));
    lane.addEventListener('focus', () => this.app.requestRender?.());
    lane.addEventListener('blur', () => this.app.requestRender?.());
    // Files dropped on the video track insert like files dropped on the tracks.
    lane.addEventListener('dragover', (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    lane.addEventListener('drop', async (e) => {
      const files = [...(e.dataTransfer?.files || [])];
      if (!files.length) return;
      e.preventDefault();
      const at = this.view.snap(Math.max(0, this.view.frameAt(this.#local(e).x)));
      await this.app.multitrack.insertFiles(this.doc, files, { at });
    });
  }

  #dragMove(e) {
    const d = this.drag;
    const { x } = this.#local(e);
    if (!d.moved && Math.abs(x - d.x0) < 3) return;
    d.moved = true;
    const view = this.view;
    const dt = (x - d.x0) * view.fpp;
    const c = videoClip(d.state);
    let next;
    if (d.part === 'body') {
      const s = view.snapDelta([c.start + dt, c.start + c.length + dt], new Set(), e.altKey);
      next = moveVideoClip(d.state, Math.round(dt + s.delta));
    } else {
      const src = videoPool(this.doc).get(c.sourceId);
      const edge = d.part === 'in' ? c.start : c.start + c.length;
      next = trimVideoClip(d.state, d.part, view.snap(edge + dt, { off: e.altKey }), videoSourceFrames(src, this.doc.sampleRate));
    }
    this.doc.preview(next);
  }

  #key(e) {
    const v = this.clip;
    if (!v) return;
    const doc = this.doc;
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) {
      e.preventDefault();
      e.stopPropagation();
      this.app.commands.run('video.remove');
      return;
    }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    this.#select(true);
    // One frame (or a second with Shift) per press.
    const fps = this.source?.fps || 25;
    const step = e.shiftKey ? doc.sampleRate : doc.sampleRate / fps;
    const next = moveVideoClip(doc.state, Math.round((e.key === 'ArrowLeft' ? -1 : 1) * step));
    if (doc.apply('Nudge Video Clip', next)) announce(`Video starts at ${this.app.formatTime(this.clip.start, doc.sampleRate)}`);
  }

  destroy() {
    this.resizeObserver.disconnect();
    this.offDoc();
    this.offSpot?.();
    if (this.thumbs && this.onThumb) this.thumbs.listeners.delete(this.onThumb);
  }
}

/** Frees the thumbnail video of a pool entry (when its session closes). */
export function releaseThumbnails(src) {
  const t = thumbnailers.get(src);
  if (!t) return;
  t.dispose();
  thumbnailers.delete(src);
}
