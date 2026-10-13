/**
 * Preview media: <video>/<audio> elements (hardware decoded by the browser)
 * and decoded images. Elements are assigned to clips each frame and reused
 * across clips of the same file, so a clip split in two plays through
 * without a re-seek.
 */
let nextId = 1;

export class MediaPool {
  /** urlFor(asset): object URL for an element (default the library's file; the player passes proxies). */
  constructor({ library, onReady, urlFor }) {
    this.library = library;
    this.onReady = onReady;
    this.urlFor = urlFor || ((asset) => library.mediaURL(asset));
    this.elements = []; // { id, el, assetId, kind, clipId, lastUsed, gain, src }
    this.images = new Map(); // assetId -> ImageBitmap | 'loading' | 'error'
    this.urls = new Map(); // assetId -> url | Promise
    this.audioCtx = null;
    this.master = null;
    this.frame = 0;
  }

  /** Audio routing is created lazily on the first user-initiated play. */
  ensureAudio() {
    if (this.audioCtx) {
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {});
      return this.audioCtx;
    }
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctx) return null;
    this.audioCtx = new Ctx({ latencyHint: 'interactive' });
    this.master = this.audioCtx.createGain();
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.master.connect(this.analyser);
    this.analyser.connect(this.audioCtx.destination);
    for (const e of this.elements) this._route(e);
    return this.audioCtx;
  }

  _route(entry) {
    if (!this.audioCtx || entry.gain) return;
    try {
      const src = this.audioCtx.createMediaElementSource(entry.el);
      entry.src = src; // kept so engine/audio-graph.js can insert clip effects
      entry.gain = this.audioCtx.createGain();
      entry.gain.gain.value = 0;
      src.connect(entry.gain).connect(this.master);
      entry.el.muted = false;
    } catch {
      entry.el.muted = true;
    }
  }

  _url(asset) {
    let u = this.urls.get(asset.id);
    if (u) return u;
    u = Promise.resolve(this.urlFor(asset)).then((url) => {
      this.urls.set(asset.id, url);
      return url;
    });
    this.urls.set(asset.id, u);
    return u;
  }

  _create(asset, kind) {
    const el = document.createElement(kind);
    el.preload = 'auto';
    el.playsInline = true;
    el.crossOrigin = 'anonymous';
    el.muted = !this.audioCtx;
    el.disablePictureInPicture = true;
    if ('preservesPitch' in el) el.preservesPitch = true;
    const entry = { id: nextId++, el, assetId: asset.id, kind, clipId: null, lastUsed: this.frame, gain: null, pendingSeek: null };
    const kick = () => this.onReady?.();
    el.addEventListener('loadeddata', kick);
    el.addEventListener('seeked', () => {
      if (entry.pendingSeek !== null) {
        const t = entry.pendingSeek;
        entry.pendingSeek = null;
        if (Math.abs(el.currentTime - t) > 0.001) el.currentTime = t;
      }
      kick();
    });
    const url = this._url(asset);
    if (typeof url === 'string') el.src = url;
    else url.then((u) => (el.src = u)).catch(() => {});
    this._route(entry);
    this.elements.push(entry);
    return entry;
  }

  /** Begin a frame of assignments. */
  beginFrame() {
    this.frame++;
    for (const e of this.elements) e.claimed = false;
  }

  /**
   * Element for a clip at source time (seconds). Prefers the element already
   * serving this clip, then a free element of the same file near that time.
   */
  claim(clip, asset, kind, sourceSec) {
    // Same file only: a clip can switch files (its proxy, or the original again).
    let best = this.elements.find((e) => e.clipId === clip.id && !e.claimed && e.kind === kind && e.assetId === asset.id);
    if (!best) {
      let bestD = Infinity;
      for (const e of this.elements) {
        if (e.claimed || e.assetId !== asset.id || e.kind !== kind) continue;
        if (e.clipId && e.lastUsed === this.frame) continue;
        const d = Math.abs(e.el.currentTime - sourceSec);
        if (d < bestD) {
          best = e;
          bestD = d;
        }
      }
    }
    if (!best) best = this._create(asset, kind);
    best.claimed = true;
    best.clipId = clip.id;
    best.lastUsed = this.frame;
    return best;
  }

  /** Move an element to a time without piling up seeks while one is in flight. */
  seek(entry, sec) {
    const el = entry.el;
    if (el.seeking) {
      entry.pendingSeek = sec;
      return;
    }
    el.currentTime = sec;
  }

  /** Pause and silence everything not claimed this frame; drop long-idle elements. */
  endFrame() {
    for (const e of this.elements) {
      if (e.claimed) continue;
      if (!e.el.paused) e.el.pause();
      if (e.gain) e.gain.gain.value = 0;
    }
    if (this.frame % 300 === 0 && this.elements.length > 12) {
      const idle = this.elements.filter((e) => !e.claimed && this.frame - e.lastUsed > 600);
      for (const e of idle) this._destroy(e);
    }
  }

  _destroy(entry) {
    entry.el.pause();
    entry.el.removeAttribute('src');
    entry.el.load();
    try {
      entry.gain?.disconnect();
      entry.fx?.node.disconnect();
    } catch {
      /* already disconnected */
    }
    this.elements = this.elements.filter((x) => x !== entry);
  }

  pauseAll() {
    for (const e of this.elements) {
      if (!e.el.paused) e.el.pause();
      if (e.gain) e.gain.gain.value = 0;
    }
  }

  /** Decoded image for an asset, or null while it loads. */
  image(asset) {
    const have = this.images.get(asset.id);
    if (have && have !== 'loading' && have !== 'error') return have;
    if (have) return null;
    this.images.set(asset.id, 'loading');
    // WebGL ignores UNPACK_FLIP_Y for ImageBitmap sources, so flip while decoding (EXIF orientation still applies).
    this.library
      .mediaBlob(asset)
      .then((blob) => createImageBitmap(blob, { imageOrientation: 'flipY' }))
      .then((bmp) => {
        this.images.set(asset.id, bmp);
        this.onReady?.();
      })
      .catch(() => this.images.set(asset.id, 'error'));
    return null;
  }

  /** Forget media for assets that were replaced (relink). */
  forgetAsset(assetId) {
    for (const e of [...this.elements]) if (e.assetId === assetId) this._destroy(e);
    const img = this.images.get(assetId);
    if (img && img.close) img.close();
    this.images.delete(assetId);
    this.urls.delete(assetId);
  }

  dispose() {
    for (const e of [...this.elements]) this._destroy(e);
    for (const img of this.images.values()) img?.close?.();
    this.images.clear();
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
  }
}
