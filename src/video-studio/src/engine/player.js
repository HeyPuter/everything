/**
 * Live preview: owns the compositor, the media pool and the playback clock.
 * Renders on demand while paused and every animation frame while playing.
 */
import { Emitter } from '../lib/emitter.js';
import { US } from '../lib/time.js';
import { Compositor } from './compositor.js';
import { MediaPool } from './media-pool.js';
import { AudioGraph } from './audio-graph.js';
import { TextCache } from './text.js';
import { FrameSource } from './frame-source.js';
import { evaluate, audibleClips, gainAt, upcomingVideoClips, trackAudible } from './scene.js';
import { sourceTimeAt } from '../model/timeline.js';
import { hasCurve, speedAt } from '../model/speed-curve.js';
import { framePosition, needsBetween, FRAME_SNAP } from '../model/slow-motion.js';
import { ensureLuts, onLutLoaded } from './luts.js';
import { onCutoutReady } from './cutout.js';

export class Player extends Emitter {
  constructor({ store, library, canvas }) {
    super();
    this.store = store;
    this.library = library;
    this.canvas = canvas;
    this.playing = false;
    this.previewTime = null; // hover preview position, or null
    this.renderScale = 1;
    this.raf = 0;
    this.dirty = true;
    this.pool = new MediaPool({ library, onReady: () => this.invalidate() });
    this.audioGraph = new AudioGraph(this.pool, { onReady: () => this.invalidate() });
    this.text = new TextCache({ onFontLoaded: () => this.invalidate() });
    this.frames = new FrameSource({ library, onFrame: () => this.invalidate() });
    try {
      this.compositor = new Compositor(canvas, { resolve: (layer) => this._resolve(layer) });
    } catch (err) {
      this.compositor = null;
      this.error = err;
    }
    this.offs = [
      store.on('change', () => this.invalidate()),
      store.on('time', () => {
        if (!this.playing) this.invalidate();
      }),
      // Color LUTs load in the background and redraw when ready.
      store.on('change', () => this._loadLuts()),
      onLutLoaded(() => this.invalidate()),
      onCutoutReady(() => this.invalidate()),
    ];
    this._loadLuts();
    this._tick = this._tick.bind(this);
  }

  _loadLuts() {
    ensureLuts(this.store.project, this.library).catch(() => {});
  }

  get supported() {
    return Boolean(this.compositor);
  }

  /** Fit the project frame in a CSS box; returns the CSS size of the frame. */
  layout(boxW, boxH, dpr = globalThis.devicePixelRatio || 1) {
    const { width: W, height: H } = this.store.project.settings;
    const fit = Math.min(boxW / W, boxH / H);
    const cssW = Math.max(1, Math.floor(W * fit));
    const cssH = Math.max(1, Math.floor(H * fit));
    // Render no larger than the project and at most ~2.2 MP so 4K projects stay smooth.
    let px = Math.min(1, (cssW * dpr) / W);
    if (this.quality === 'half') px *= 0.5;
    else if (this.quality === 'full') px = Math.min(1, Math.max(px, (cssW * dpr) / W));
    const maxPx = 2_200_000;
    if (W * H * px * px > maxPx) px = Math.sqrt(maxPx / (W * H));
    this.renderScale = px;
    this.compositor?.resize(W * px, H * px, W, H);
    this.invalidate();
    return { cssW, cssH };
  }

  invalidate() {
    this.dirty = true;
    if (!this.raf) this.raf = requestAnimationFrame(this._tick);
  }

  get time() {
    return this.previewTime ?? this.store.time;
  }

  setPreview(t) {
    if (this.playing) return;
    this.previewTime = t;
    this.invalidate();
  }

  /** Where playback stops (or loops): the out point when playing the range, else the end. */
  _stopAt() {
    const end = this.store.duration;
    const r = this.store.project.range;
    return this.playRange && r ? Math.min(r.out, end) : end;
  }

  _startAt() {
    const r = this.store.project.range;
    return this.playRange && r ? r.in : 0;
  }

  play({ range } = {}) {
    if (this.playing) return;
    if (range !== undefined) this.playRange = Boolean(range);
    const end = this._stopAt();
    if (end <= 0) return;
    const t = this.store.time;
    if (t >= end - 1000 || (this.playRange && t < this._startAt())) this.store.seek(this._startAt());
    this.previewTime = null;
    this.pool.ensureAudio();
    this.audioGraph.prepare();
    this.playing = true;
    this.clockStart = performance.now();
    this.timeStart = this.store.time;
    this.emit('play', { playing: true });
    this.invalidate();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.playRange = false;
    this.pool.pauseAll();
    this.emit('play', { playing: false });
    this.invalidate();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  _tick() {
    this.raf = 0;
    if (this.playing) {
      const t = this.timeStart + (performance.now() - this.clockStart) * 1000;
      const end = this._stopAt();
      if (t >= end && this.loop && end - this._startAt() > 50_000) {
        // Loop: start over from the beginning (or the in point).
        this.timeStart = this._startAt();
        this.clockStart = performance.now();
        this.store.seek(this.timeStart);
      } else if (t >= end) {
        this.store.seek(end);
        this.pause();
      } else {
        this.store.seek(t);
      }
    }
    if (this.dirty || this.playing) {
      this.dirty = false;
      this.renderFrame(this.time);
    }
    if (this.playing) this.raf = requestAnimationFrame(this._tick);
  }

  _resolve(layer) {
    if (layer.kind === 'text' || layer.kind === 'sticker' || layer.kind === 'avatar') return this.text.get(layer, this.renderScale);
    if (layer.kind !== 'media' || !layer.asset) return null;
    if (layer.clip.type === 'image') {
      const bmp = this.pool.image(layer.asset);
      return bmp ? { key: `img:${layer.asset.id}`, source: bmp, width: bmp.width, height: bmp.height, version: 1 } : null;
    }
    const entry = this._frameElements?.get(layer.clip.id);
    const sec = layer.sourceTime / US;
    if (layer.smoothSlow && !this.playing) {
      const info = this._betweenFrames(layer, sec);
      if (info) return info;
    }
    const tol = 0.5 / this.store.fps + 0.01;
    const el = entry?.el;
    const elReady = el && el.readyState >= 2;
    if (elReady && !el.seeking && (this.playing || Math.abs(el.currentTime - sec) <= tol)) {
      return { key: `vid:${entry.id}`, source: el, width: el.videoWidth, height: el.videoHeight, dynamic: true };
    }
    // The element is loading or still seeking: show an exact WebCodecs frame instead.
    this.frames.request(layer.asset, sec);
    const f = this.frames.get(layer.asset, sec, this.playing ? 0.25 : tol);
    if (f) return { key: `fs:${layer.asset.id}`, source: f.canvas, width: layer.asset.width || f.canvas.width, height: layer.asset.height || f.canvas.height, version: f.version };
    if (elReady) return { key: `vid:${entry.id}`, source: el, width: el.videoWidth, height: el.videoHeight, dynamic: true };
    const any = this.frames.any(layer.asset);
    return any ? { key: `fs:${layer.asset.id}`, source: any.canvas, width: layer.asset.width || any.canvas.width, height: layer.asset.height || any.canvas.height, version: any.version } : null;
  }

  /**
   * Smooth slow motion while paused: the exact decoded frames around sec
   * with the in-between position, the same input the export draws from
   * (engine/slow-motion.js). Null until the pair is decoded; the plain frame
   * shows meanwhile. While playing, media elements only expose the current
   * frame, so slowed clips play their source frames as they are and the
   * in-between frames appear when paused and in the export.
   */
  _betweenFrames(layer, sec) {
    const { asset } = layer;
    const pair = this.frames.pair(asset, sec);
    if (!pair) return null;
    const width = asset.width || pair.a.canvas.width;
    const height = asset.height || pair.a.canvas.height;
    const info = { key: `fsa:${asset.id}`, source: pair.a.canvas, width, height, version: pair.version };
    const next = pair.b && { key: `fsb:${asset.id}`, source: pair.b.canvas, width, height, version: pair.version };
    const frac = pair.b ? framePosition(sec, pair.a.ts, pair.b.ts) : 0;
    // A hair before the next frame (whole-microsecond times): that frame, as it is (as the export does).
    if (frac >= 1 - FRAME_SNAP) return next;
    if (needsBetween(frac)) info.between = { mode: layer.smoothSlow, frac, next };
    return info;
  }

  /** Assign and sync media elements for time t; returns clipId -> element entry. */
  _syncMedia(t, layers) {
    const pool = this.pool;
    const project = this.store.project;
    const fps = project.settings.fps;
    pool.beginFrame();
    const map = new Map();
    // Clips by id, including the virtual ones of compound and multi-camera clips that are not in the project.
    const byId = new Map();
    const want = (layer) => {
      if (layer.kind === 'transition') {
        want(layer.from);
        want(layer.to);
        return;
      }
      if (layer.kind !== 'media' || layer.clip.type !== 'video' || !layer.asset) return;
      const sec = layer.sourceTime / US;
      const entry = pool.claim(layer.clip, layer.asset, 'video', sec);
      map.set(layer.clip.id, entry);
      byId.set(layer.clip.id, layer.clip);
      this._drive(entry, layer.clip, sec, fps, true, t);
    };
    for (const l of layers) want(l);
    // Sound: audio clips (and video clips whose picture is hidden) still play.
    for (const { clip, track } of audibleClips(project)) {
      if (t < clip.start || t >= clip.start + clip.duration) continue;
      const asset = project.assets[clip.assetId];
      if (!asset) continue;
      let entry = map.get(clip.id);
      const sec = sourceTimeAt(clip, t) / US;
      if (!entry) {
        entry = pool.claim(clip, asset, clip.type === 'video' ? 'video' : 'audio', sec);
        map.set(clip.id, entry);
        this._drive(entry, clip, sec, fps, false, t);
      }
      this.audioGraph.apply(entry, clip);
      if (entry.gain && this.playing) {
        const g = track.muted ? 0 : gainAt(clip, t);
        entry.gain.gain.setTargetAtTime(g, pool.audioCtx.currentTime, 0.015);
      }
    }
    // Silence picture-only elements (detached or muted audio).
    for (const [id, entry] of map) {
      const clip = entry.clipId === id ? byId.get(id) || this._clipById(id) : null;
      if (entry.gain && clip && (clip.audioDetached || clip.muted || clip.disabled || clip.freeze || !project.assets[clip.assetId]?.hasAudio || this._trackMuted(id))) entry.gain.gain.value = 0;
    }
    // Warm up clips about to start so the first frame is ready.
    if (this.playing) {
      for (const c of upcomingVideoClips(project, t, 1.5 * US)) {
        if (map.has(c.id) || !project.assets[c.assetId]) continue;
        const sec = c.in / US;
        const entry = pool.claim(c, project.assets[c.assetId], 'video', sec);
        if (!entry.el.paused) entry.el.pause();
        if (Math.abs(entry.el.currentTime - sec) > 0.05) pool.seek(entry, sec);
        if (entry.gain) entry.gain.gain.value = 0;
      }
    }
    pool.endFrame();
    return map;
  }

  _clipById(id) {
    for (const t of this.store.project.tracks) for (const c of t.clips) if (c.id === id) return c;
    return null;
  }

  /** Muted, or silenced because another track is soloed. */
  _trackMuted(id) {
    const project = this.store.project;
    for (const t of project.tracks) if (t.clips.some((c) => c.id === id)) return !trackAudible(project, t);
    return false;
  }

  _drive(entry, clip, sec, fps, visual, t = this.time) {
    const el = entry.el;
    if (this.playing && !clip.freeze && hasCurve(clip)) {
      this._driveCurve(entry, clip, sec, t);
      return;
    }
    if (this.playing && !clip.freeze) {
      const rate = Math.min(16, Math.max(0.0625, clip.speed || 1));
      if (el.playbackRate !== rate) el.playbackRate = rate;
      // Keep the pitch on speed changes unless the clip asks otherwise (the export matches).
      const keep = clip.keepPitch !== false;
      if ('preservesPitch' in el && el.preservesPitch !== keep) el.preservesPitch = keep;
      else if ('webkitPreservesPitch' in el && el.webkitPreservesPitch !== keep) el.webkitPreservesPitch = keep;
      if (el.paused) {
        if (Math.abs(el.currentTime - sec) > 0.03) this.pool.seek(entry, sec);
        el.play().catch(() => {});
      } else if (Math.abs(el.currentTime - sec) > 0.2 * rate) {
        this.pool.seek(entry, sec);
        this.audioGraph.reset(entry);
      }
    } else {
      if (!el.paused) el.pause();
      if (entry.gain) entry.gain.gain.value = 0;
      const tol = visual ? 0.5 / fps : 0.05;
      if (Math.abs(el.currentTime - sec) > tol || el.readyState < 2) {
        if (Math.abs(el.currentTime - sec) > tol) this.pool.seek(entry, sec);
      }
    }
  }

  /**
   * Play a clip with a speed curve: the element's rate follows the curve
   * every frame, nudged to cancel drift; a large drift seeks.
   */
  _driveCurve(entry, clip, sec, t) {
    const el = entry.el;
    const v = speedAt(clip, t - clip.start);
    const keep = clip.keepPitch !== false;
    if ('preservesPitch' in el && el.preservesPitch !== keep) el.preservesPitch = keep;
    else if ('webkitPreservesPitch' in el && el.webkitPreservesPitch !== keep) el.webkitPreservesPitch = keep;
    const drift = sec - el.currentTime; // > 0: the element is behind
    if (el.paused) {
      if (Math.abs(drift) > 0.03) this.pool.seek(entry, sec);
      el.playbackRate = Math.min(16, Math.max(0.0625, v));
      el.play().catch(() => {});
      return;
    }
    if (Math.abs(drift) > 0.25 * Math.max(1, v)) {
      this.pool.seek(entry, sec);
      this.audioGraph.reset(entry);
    }
    // Catch up over about half a second, within +-50% of the curve's speed.
    const nudge = Math.max(-0.5, Math.min(0.5, (drift * 2) / Math.max(0.1, v)));
    const rate = Math.min(16, Math.max(0.0625, v * (1 + nudge)));
    // Small changes are skipped so the element is not retuned every frame for nothing.
    if (Math.abs(el.playbackRate - rate) > 0.01 * rate) el.playbackRate = rate;
  }

  renderFrame(t) {
    if (!this.compositor) return;
    const project = this.store.project;
    const layers = evaluate(project, t);
    this._frameElements = this._syncMedia(t, layers);
    this.compositor.render(layers, { settings: project.settings, time: t / US });
    this.lastLayers = layers;
    this.emit('frame', { time: t });
  }

  /**
   * Render a variant of the frame at t and read it back (color analysis and
   * the eyedropper). pick(layers) returns the layers to draw (for example one
   * clip with its grading switched off). Returns { width, height, data,
   * layers } with RGBA8 rows top first, or null when there is no preview.
   * The visible preview is redrawn afterwards.
   */
  probe(t, pick) {
    if (!this.compositor) return null;
    const project = this.store.project;
    const all = evaluate(project, t);
    this._frameElements = this._syncMedia(t, all);
    const layers = pick(all);
    const settings = { ...project.settings, background: { type: 'color', color: '#000000' } };
    this.compositor.render(layers, { settings, time: t / US });
    const px = this.compositor.readPixels();
    this.invalidate();
    return { ...px, layers };
  }

  /** Whether the picture for a layer is available right now. */
  hasSource(layer) {
    return Boolean(this._resolve(layer)?.source);
  }

  /** Box of a visual clip in project pixels (for the transform overlay). */
  boxFor(layer) {
    if (!this.compositor) return null;
    let info = null;
    if (layer.kind === 'avatar') info = { projW: layer.frameW, projH: layer.frameH };
    else if (layer.kind === 'text' || layer.kind === 'sticker') info = this.text.measure(layer.clip);
    else if (layer.kind === 'media') {
      const a = layer.asset;
      info = { width: a?.width || layer.width, height: a?.height || layer.height };
    }
    return this.compositor.layerBox(layer, info);
  }

  /** Current frame as a JPEG blob (project covers). */
  async snapshot(maxW = 480) {
    if (!this.compositor) return null;
    this.renderFrame(this.time);
    const src = this.canvas;
    const scale = Math.min(1, maxW / src.width);
    const c = document.createElement('canvas');
    c.width = Math.round(src.width * scale);
    c.height = Math.round(src.height * scale);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.82));
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.offs.forEach((off) => off());
    this.pool.dispose();
    this.frames.dispose();
    this.text.dispose();
    this.compositor?.dispose();
  }
}
