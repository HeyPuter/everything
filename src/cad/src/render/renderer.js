/**
 * WebGL2 drawing renderer.
 *
 * Model space is split into chunks of up to CHUNK_SIZE entities. Each chunk
 * owns one instanced segment buffer and one triangle buffer; an edit only
 * rebuilds the chunks it touches. Curves are tessellated for the zoom level
 * a chunk was built at, and visible chunks are rebuilt in the background
 * (within a per-frame time budget) when the zoom changes enough to matter.
 *
 * Frames are drawn on demand only: call invalidate() after any change.
 */
import { SEG_VS, SEG_FS, TRI_VS, TRI_FS, GRID_VS, GRID_FS } from './shaders.js';
import { Batch, SEG_STRIDE, TRI_STRIDE, F_HIGHLIGHT } from './batch.js';
import { makeContext, emitEntity } from '../core/tessellate.js';
import { drawBands, nextBand } from '../core/display.js';
import { LINEWEIGHTS } from '../core/schema.js';

const CHUNK_SIZE = 1024;
const PATTERN_W = 18;
const PATTERN_ROWS = 64;
const TOL_PX = 0.25;
const LOD_UP = 3;
const LOD_DOWN = 8;
const FRAME_BUDGET_MS = 8;
/** Header values that change how existing objects look. */
const DRAWN_HEADER_KEYS = new Set(['ltscale', 'pdmode', 'pdsize', 'linearFormat', 'linearPrecision', 'angularFormat', 'angularPrecision', 'units']);

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'Shader compile failed');
  return sh;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'Program link failed');
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    const name = info.name.replace(/\[0\]$/, '');
    u[name] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}

function split(v) {
  const hi = Math.fround(v);
  return [hi, v - hi];
}

const IDENTITY2 = new Float32Array([1, 0, 0, 1]);
const ZERO2 = new Float32Array([0, 0]);

class GpuBatch {
  constructor(gl) {
    this.gl = gl;
    this.segBuf = gl.createBuffer();
    this.triBuf = gl.createBuffer();
    this.segVao = gl.createVertexArray();
    this.triVao = gl.createVertexArray();
    this.segCount = 0;
    this.vertCount = 0;
    gl.bindVertexArray(this.segVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.segBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, SEG_STRIDE, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, SEG_STRIDE, 16);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, SEG_STRIDE, 32);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, SEG_STRIDE, 40);
    gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribIPointer(4, 4, gl.UNSIGNED_BYTE, SEG_STRIDE, 44);
    gl.vertexAttribDivisor(4, 1);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 1, gl.FLOAT, false, SEG_STRIDE, 48);
    gl.vertexAttribDivisor(5, 1);
    gl.bindVertexArray(this.triVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.triBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, TRI_STRIDE, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, TRI_STRIDE, 16);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, TRI_STRIDE, 20);
    gl.bindVertexArray(null);
  }

  upload(batch) {
    const gl = this.gl;
    this.segCount = batch.segCount;
    this.vertCount = batch.vertCount;
    this.translucent = batch.translucent;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.segBuf);
    gl.bufferData(gl.ARRAY_BUFFER, batch.segU.subarray(0, batch.segCount * SEG_STRIDE), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.triBuf);
    gl.bufferData(gl.ARRAY_BUFFER, batch.triU.subarray(0, batch.vertCount * TRI_STRIDE), gl.STATIC_DRAW);
  }

  dispose() {
    const gl = this.gl;
    gl.deleteBuffer(this.segBuf);
    gl.deleteBuffer(this.triBuf);
    gl.deleteVertexArray(this.segVao);
    gl.deleteVertexArray(this.triVao);
  }
}

class Chunk {
  constructor() {
    this.ids = new Set();
    this.gpu = null;
    this.dirty = true;
    this.bounds = null;
    this.builtScale = 0;
  }
}

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./camera.js').Camera} camera
   */
  constructor(canvas, camera) {
    this.canvas = canvas;
    this.camera = camera;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.dpr = 1;
    this.drawing = null;
    this.chunks = [];
    this.chunkOf = new Map();
    /** Chunk an erased object was drawn in, so undo can put it back without a full rebuild. */
    this.homeOf = new Map();
    this.infinite = new Set();
    /** Draw-order bands (see drawBands): drawn in order, each band's fills beneath its lines. */
    this.bands = drawBands([]);
    this.selection = new Set();
    this.hover = null;
    this.hidden = new Set();
    this.previewEntities = [];
    this.dragMatrix = null;
    this.options = { grid: true, lwDisplay: false, gridSpacing: 10, gridMajor: 5, lwScale: 1 };
    this.theme = {
      bg: [0.13, 0.15, 0.18],
      fg: [255, 255, 255],
      gridMinor: [1, 1, 1, 0.045],
      gridMajor: [1, 1, 1, 0.09],
      axisX: [0.85, 0.35, 0.35, 0.55],
      axisY: [0.35, 0.75, 0.4, 0.55],
      highlight: [0.27, 0.56, 1, 1],
      hover: [0.27, 0.56, 1, 0.75],
    };
    /** Problems found while drawing (e.g. 'hatch-dense'); each is passed to onWarning once per drawing. */
    this.warnings = new Set();
    this.reported = new Set();
    this.onWarning = null;
    this.patternRows = new Map();
    this.infiniteBlocks = new WeakMap();
    this.patternData = new Float32Array(PATTERN_W * PATTERN_ROWS);
    this.patternDirty = true;
    this.batch = new Batch((p) => this._patternRow(p), 65536, 4096);
    this.stats = { segments: 0, triangles: 0, chunks: 0, frameMs: 0 };
    this._raf = 0;
    this._lost = false;
    this._init();
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this._lost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this._lost = false;
      this._init();
      this.rebuildAll();
    });
  }

  _init() {
    const gl = this.gl;
    this.segProg = program(gl, SEG_VS, SEG_FS);
    this.triProg = program(gl, TRI_VS, TRI_FS);
    this.gridProg = program(gl, GRID_VS, GRID_FS);
    this.gridVao = gl.createVertexArray();
    this.patternTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.patternTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.patternDirty = true;
    this.selGpu = new GpuBatch(gl);
    this.selInfGpu = new GpuBatch(gl);
    this.hoverGpu = new GpuBatch(gl);
    this.previewGpu = new GpuBatch(gl);
    this.infGpu = new GpuBatch(gl);
    for (const c of this.chunks) {
      c.gpu = null;
      c.dirty = true;
    }
    this.selDirty = this.hoverDirty = this.previewDirty = this.infDirty = true;
  }

  /** Texture row for a linetype pattern, shared by every pattern with the same values. */
  _patternRow(p) {
    const key = p.join(',');
    let row = this.patternRows.get(key);
    if (row !== undefined) return row;
    row = this.patternRows.size + 1;
    if (row >= PATTERN_ROWS) return 0;
    this.patternRows.set(key, row);
    const o = row * PATTERN_W;
    const n = Math.min(p.length, PATTERN_W - 2);
    let total = 0;
    for (let i = 0; i < n; i++) {
      this.patternData[o + 2 + i] = p[i];
      total += Math.abs(p[i]);
    }
    this.patternData[o] = n;
    this.patternData[o + 1] = total;
    this.patternDirty = true;
    return row;
  }

  _resetPatterns() {
    this.patternRows = new Map();
    this.patternData.fill(0);
    this.patternDirty = true;
  }

  // Scene management ----------------------------------------------------

  setDrawing(drawing) {
    this.drawing = drawing;
    this.warnings.clear();
    this.reported = new Set();
    this.hover = null;
    this.hidden = new Set();
    this.selection = new Set();
    this.previewEntities = [];
    this.dragMatrix = null;
    this.rebuildAll();
  }

  /** Throw away every chunk and re-partition the drawing. */
  rebuildAll() {
    // Block definitions may have changed (a nested block can gain an xline).
    this.infiniteBlocks = new WeakMap();
    for (const c of this.chunks) c.gpu?.dispose();
    this.chunks = [];
    this.chunkOf = new Map();
    this.homeOf = new Map();
    this.infinite = new Set();
    this._resetPatterns();
    this.bands = drawBands(this.drawing ? this.drawing.entities.values() : []);
    if (this.drawing) for (const id of this.drawing.entities.keys()) this._place(id);
    this.selDirty = this.hoverDirty = this.previewDirty = this.infDirty = true;
    this.invalidate();
  }

  /** True for objects whose extent depends on the view (construction lines, and blocks holding them). */
  _isInfinite(ent) {
    if (ent.type === 'xline' || ent.type === 'ray') return true;
    if (ent.type !== 'insert') return false;
    return this._blockHasInfinite(ent.name, 0);
  }

  _blockHasInfinite(name, depth) {
    const block = this.drawing.blocks.get(name);
    if (!block || depth > 16) return false;
    let v = this.infiniteBlocks.get(block);
    if (v === undefined) {
      this.infiniteBlocks.set(block, false);
      v = block.entities.some((e) => e.type === 'xline' || e.type === 'ray' || (e.type === 'insert' && this._blockHasInfinite(e.name, depth + 1)));
      this.infiniteBlocks.set(block, v);
    }
    return v;
  }

  _place(id) {
    const ent = this.drawing.entities.get(id);
    if (!ent) return;
    if (this._isInfinite(ent)) {
      this.infinite.add(id);
      this.infDirty = true;
      return;
    }
    let c = this.chunks.at(-1);
    if (!c || c.ids.size >= CHUNK_SIZE) {
      c = new Chunk();
      this.chunks.push(c);
    }
    c.ids.add(id);
    c.dirty = true;
    this.chunkOf.set(id, c);
  }

  _unplace(id) {
    const c = this.chunkOf.get(id);
    if (c) {
      c.ids.delete(id);
      c.dirty = true;
      this.chunkOf.delete(id);
      this.homeOf.set(id, c);
    }
    if (this.infinite.delete(id)) this.infDirty = true;
  }

  /** True once any object has its own draw order, so bands must be kept apart. */
  _banded() {
    return this.bands.band > 0 || this.bands.key != null;
  }

  /** Apply a change record from Drawing (see drawing.js). */
  applyChange(change) {
    // Draw order changes, and block redefinitions (which may add or remove
    // construction lines inside references), re-partition everything; so do
    // objects coming back in a drawing with draw-order bands.
    const ents = this.drawing.entities;
    const back =
      change.resort &&
      (this._banded() ||
        [...change.ids].some((id) => ents.get(id)?.orderGroup != null) ||
        !this._restoreHomes(change));
    if (change.order || change.blocks.size || back) {
      this.rebuildAll();
      return;
    }
    const drawn = change.headerKeys && [...change.headerKeys].some((k) => DRAWN_HEADER_KEYS.has(k));
    const names = change.tableNames ?? new Set();
    if (names.has('linetypes')) this._resetPatterns();
    if (drawn || names.has('linetypes') || names.has('textStyles') || names.has('dimStyles')) {
      this._dirtyAll();
    } else if (names.has('layers')) {
      // Only chunks that use a changed layer (or hold block references) need rebuilding.
      const layers = new Set([...change.tableKeys].filter((k) => k.startsWith('layers:')).map((k) => k.slice(7)));
      for (const c of this.chunks) if (c.hasInsert || !c.layers || [...layers].some((l) => c.layers.has(l))) c.dirty = true;
      this.infDirty = this.selDirty = this.hoverDirty = true;
    }
    for (const id of change.ids) {
      const ent = this.drawing.entities.get(id);
      const c = this.chunkOf.get(id);
      if (!ent) this._unplace(id);
      else if (this._isInfinite(ent) !== this.infinite.has(id)) {
        // New objects are appended to the draw order (construction lines too).
        if (!c) this._appendBand(id, ent);
        this._unplace(id);
        this._place(id);
      } else if (c) c.dirty = true;
      else if (this.infinite.has(id)) this.infDirty = true;
      else {
        this._appendBand(id, ent);
        this._place(id);
      }
      if (this.selection.has(id)) this.selDirty = true;
      if (this.hover === id) this.hoverDirty = true;
    }
    // Drop chunks that became empty.
    if (this.chunks.some((c) => !c.ids.size)) {
      this.chunks = this.chunks.filter((c) => {
        if (c.ids.size) return true;
        c.gpu?.dispose();
        return false;
      });
    }
    this.invalidate();
  }

  /** Give a new object the draw-order band after the last one. */
  _appendBand(id, ent) {
    const band = nextBand(this.bands, ent);
    if (band) this.bands.of.set(id, band);
  }

  /**
   * Objects coming back (undo of an erase) go back into the chunk they were
   * drawn in, re-sorted into draw order, so only that chunk is rebuilt.
   * False when a home chunk is gone and everything must be re-partitioned.
   */
  _restoreHomes(change) {
    const back = [];
    let live = null;
    for (const id of change.ids) {
      const ent = this.drawing.entities.get(id);
      if (!ent || this.chunkOf.has(id) || this.infinite.has(id) || this._isInfinite(ent)) continue;
      const home = this.homeOf.get(id);
      live ??= new Set(this.chunks);
      if (!home || !live.has(home)) return false;
      back.push([id, home]);
    }
    for (const [id, home] of back) {
      home.ids.add(id);
      home.dirty = true;
      home.unsorted = true;
      this.chunkOf.set(id, home);
      this.homeOf.delete(id);
    }
    return true;
  }

  _dirtyAll() {
    for (const c of this.chunks) c.dirty = true;
    this.infDirty = this.selDirty = this.hoverDirty = true;
  }
  setSelection(ids) {
    this.selection = ids;
    this.selDirty = true;
    this.invalidate();
  }

  setHover(id) {
    if (this.hover === id) return;
    this.hover = id;
    this.hoverDirty = true;
    this.invalidate();
  }

  /** Entities hidden from normal drawing (e.g. while grip-editing). */
  setHidden(ids) {
    const prev = this.hidden;
    this.hidden = ids;
    for (const id of prev) this.chunkOf.get(id) && (this.chunkOf.get(id).dirty = true);
    for (const id of ids) this.chunkOf.get(id) && (this.chunkOf.get(id).dirty = true);
    if (prev.size || ids.size) this.infDirty = true;
    this.invalidate();
  }

  /** Transient entities drawn on top (rubber-band previews). */
  setPreview(entities) {
    this.previewEntities = entities || [];
    this.previewDirty = true;
    this.invalidate();
  }

  /**
   * Draw the selection highlight through an affine transform (move, rotate,
   * scale and mirror previews). m = [a, b, c, d, e, f] in world space, or null.
   */
  setDragMatrix(m) {
    this.dragMatrix = m;
    this.invalidate();
  }

  setOptions(opts) {
    const relayout = opts.lwDisplay !== undefined && opts.lwDisplay !== this.options.lwDisplay;
    Object.assign(this.options, opts);
    if (relayout) this.invalidate();
    this.invalidate();
  }

  setTheme(theme) {
    const fgChanged = theme.fg && theme.fg.join() !== this.theme.fg.join();
    Object.assign(this.theme, theme);
    if (fgChanged) {
      for (const c of this.chunks) c.dirty = true;
      this.selDirty = this.hoverDirty = this.previewDirty = this.infDirty = true;
    }
    this.invalidate();
  }

  resize(cssW, cssH, dpr) {
    this.dpr = dpr;
    const w = Math.max(1, Math.round(cssW * dpr)),
      h = Math.max(1, Math.round(cssH * dpr));
    const changed = this.canvas.width !== w || this.canvas.height !== h;
    if (changed) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.camera.setSize(cssW, cssH);
    this.infDirty = true;
    // Resizing clears the canvas; draw now so the next paint is not blank.
    if (changed && this.drawing && !this._lost) this.frame();
    else this.invalidate();
  }

  invalidate() {
    if (this._raf || this._lost) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.frame();
    });
  }

  // Building -------------------------------------------------------------

  _ctx(extra) {
    const cam = this.camera;
    return makeContext(this.drawing, {
      fg: this.theme.fg,
      tol: TOL_PX / cam.scale,
      view: cam.bounds(),
      pointSize: 6 / cam.scale,
      warnings: this.warnings,
      patterns: false,
      ...extra,
    });
  }

  _buildChunk(c, ctx) {
    const b = this.batch;
    b.reset();
    b.flags = 0;
    const ents = this.drawing.entities;
    const hidden = this.hidden;
    const bands = this._banded() ? this.bands.of : null;
    const layers = new Set();
    let hasInsert = false;
    if (c.unsorted) {
      const key = this.drawing.orderKey;
      c.ids = new Set([...c.ids].sort((a, b) => key.get(a) - key.get(b)));
      c.unsorted = false;
    }
    for (const id of c.ids) {
      const e = ents.get(id);
      if (!e) continue;
      layers.add(e.layer);
      if (e.type === 'insert') hasInsert = true;
      if (hidden.size && hidden.has(id)) continue;
      if (bands) b.band = bands.get(id) ?? 0;
      emitSafe(e, b, ctx);
    }
    b.band = 0;
    c.layers = layers;
    c.hasInsert = hasInsert;
    if (!c.gpu) c.gpu = new GpuBatch(this.gl);
    c.gpu.upload(b);
    c.bounds = b.bounds;
    c.dirty = false;
    c.builtScale = this.camera.scale;
    b.shrink();
  }

  _buildIds(gpu, ids, flags, ctx, bands = null) {
    const b = this.batch;
    b.reset();
    b.flags = flags;
    const ents = this.drawing.entities;
    for (const id of ids) {
      const e = ents.get(id);
      if (bands) b.band = bands.get(id) ?? 0;
      if (e) emitSafe(e, b, ctx);
    }
    b.flags = 0;
    b.band = 0;
    gpu.upload(b);
    b.shrink();
  }

  _buildEntities(gpu, list, ctx) {
    const b = this.batch;
    b.reset();
    b.flags = 0;
    for (const e of list) emitSafe(e, b, ctx);
    gpu.upload(b);
    b.shrink();
  }

  // Frame -------------------------------------------------------------------

  frame() {
    if (!this.drawing || this._lost) return;
    const t0 = performance.now();
    const gl = this.gl;
    const cam = this.camera;
    const ctx = this._ctx();
    const view = cam.bounds(4 / cam.scale);

    // Rebuild dirty chunks: visible (or never built) ones now, the rest
    // within the frame budget; then refresh the level of detail of visible
    // chunks after big zoom changes, also within budget.
    let pending = false;
    for (const c of this.chunks) {
      if (c.dirty && (!c.bounds || overlaps(c.bounds, view))) this._buildChunk(c, ctx);
    }
    for (const c of this.chunks) {
      if (!c.dirty) continue;
      if (performance.now() - t0 < FRAME_BUDGET_MS) this._buildChunk(c, ctx);
      else pending = true;
    }
    for (const c of this.chunks) {
      if (c.dirty || !c.bounds || !overlaps(c.bounds, view)) continue;
      if (lodStale(cam.scale, c.builtScale)) {
        if (performance.now() - t0 < FRAME_BUDGET_MS) this._buildChunk(c, ctx);
        else pending = true;
      }
    }
    // Construction lines are clipped to the view, so they follow every frame.
    if (this.infDirty || this.infinite.size) {
      const ids = this.hidden.size ? [...this.infinite].filter((id) => !this.hidden.has(id)) : this.infinite;
      this._buildIds(this.infGpu, ids, 0, ctx, this._banded() ? this.bands.of : null);
      this.infDirty = false;
    }
    // Selected construction lines follow the view on their own, so panning
    // does not rebuild the rest of a large selection every frame.
    const selInf = [];
    if (this.selection.size) {
      for (const id of this.infinite) if (this.selection.has(id)) selInf.push(id);
    }
    const selStale = this.selection.size < 5000 && lodStale(cam.scale, this.selScale);
    if (this.selDirty || (this.selection.size && selStale)) {
      const ids = selInf.length
        ? [...this.selection].filter((id) => !this.infinite.has(id))
        : this.selection;
      this._buildIds(this.selGpu, ids, F_HIGHLIGHT, ctx);
      this.selDirty = false;
      this.selScale = cam.scale;
    }
    if (selInf.length || this.selInfGpu.segCount || this.selInfGpu.vertCount) {
      this._buildIds(this.selInfGpu, selInf, F_HIGHLIGHT, ctx);
    }
    if (this.hoverDirty || (this.hover != null && (this.infinite.has(this.hover) || lodStale(cam.scale, this.hoverScale)))) {
      this._buildIds(this.hoverGpu, this.hover != null ? [this.hover] : [], F_HIGHLIGHT, ctx);
      this.hoverDirty = false;
      this.hoverScale = cam.scale;
    }
    if (this.previewDirty || this.previewEntities.length) {
      this._buildEntities(this.previewGpu, this.previewEntities, ctx);
      this.previewDirty = false;
    }
    if (this.patternDirty) {
      gl.bindTexture(gl.TEXTURE_2D, this.patternTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, PATTERN_W, PATTERN_ROWS, 0, gl.RED, gl.FLOAT, this.patternData);
      this.patternDirty = false;
    }

    // Draw.
    const W = this.canvas.width,
      H = this.canvas.height;
    gl.viewport(0, 0, W, H);
    const bg = this.theme.bg;
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    this._drawGrid();

    const ppu = cam.scale * this.dpr;
    const [cxh, cxl] = split(cam.cx);
    const [cyh, cyl] = split(cam.cy);
    const lwPx = new Float32Array(24);
    for (let i = 0; i < LINEWEIGHTS.length; i++) {
      lwPx[i] = this.options.lwDisplay ? Math.max(1, (LINEWEIGHTS[i] / 100) * (96 / 25.4) * this.options.lwScale) * this.dpr : this.dpr;
    }
    const common = { cxh, cyh, cxl, cyl, ppu, W, H, lwPx };

    let segs = 0,
      tris = 0;
    // Draw-order bands: fills go in first and record their band as depth;
    // lines then only show where no fill of a later band covers them.
    const banded = this._banded();
    if (banded) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
    }
    this._useTri(common, IDENTITY2, ZERO2, ZERO2, null, 1);
    const fills = this.triProg.u.u_fills;
    for (const c of this.chunks) {
      if (!c.gpu || !c.gpu.vertCount || !c.bounds || !overlaps(c.bounds, view)) continue;
      gl.bindVertexArray(c.gpu.triVao);
      if (banded && c.gpu.translucent) {
        // Translucent fills tint what lies beneath and must not hide it: only
        // opaque fills record their band.
        gl.uniform1i(fills, 1);
        gl.drawArrays(gl.TRIANGLES, 0, c.gpu.vertCount);
        gl.depthMask(false);
        gl.uniform1i(fills, 2);
        gl.drawArrays(gl.TRIANGLES, 0, c.gpu.vertCount);
        gl.depthMask(true);
        gl.uniform1i(fills, 0);
      } else gl.drawArrays(gl.TRIANGLES, 0, c.gpu.vertCount);
      tris += c.gpu.vertCount / 3;
    }
    if (banded) gl.depthMask(false);
    this._useSeg(common, IDENTITY2, ZERO2, ZERO2, 1);
    for (const c of this.chunks) {
      if (!c.gpu || !c.gpu.segCount || !c.bounds || !overlaps(c.bounds, view)) continue;
      gl.bindVertexArray(c.gpu.segVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, c.gpu.segCount);
      segs += c.gpu.segCount;
    }
    this._drawGpu(this.infGpu, common, false);
    if (banded) {
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(true);
    }

    // Highlights and previews.
    const hl = this.theme.highlight;
    if (this.hover != null && !this.selection.has(this.hover)) {
      this._drawGpu(this.hoverGpu, common, true, this.theme.hover, 1);
    }
    if (this.selection.size) {
      this._drawGpu(this.selGpu, common, true, hl, 1);
      this._drawGpu(this.selInfGpu, common, true, hl, 1);
      if (this.dragMatrix) {
        const m = this.dragMatrix;
        // Express the world-space affine map relative to the camera.
        const xm = new Float32Array([m[0], m[1], m[2], m[3]]);
        const px = cam.cx,
          py = cam.cy;
        const tx = m[0] * px + m[2] * py + m[4] - px,
          ty = m[1] * px + m[3] * py + m[5] - py;
        const xt = new Float32Array([tx, ty]);
        this._drawGpu(this.selGpu, common, true, hl, 1, xm, xt);
        this._drawGpu(this.selInfGpu, common, true, hl, 1, xm, xt);
      }
    }
    this._drawGpu(this.previewGpu, common, false);
    gl.bindVertexArray(null);

    this.stats = { segments: segs, triangles: tris, chunks: this.chunks.length, frameMs: performance.now() - t0 };
    for (const w of this.warnings) {
      if (this.reported.has(w)) continue;
      this.reported.add(w);
      this.onWarning?.(w);
    }
    if (pending) this.invalidate();
    this.onFrame?.();
  }

  _useSeg(c, xm, xt, xp, alpha, hl) {
    const gl = this.gl,
      s = this.segProg;
    gl.useProgram(s.p);
    gl.uniform2f(s.u.u_camHi, c.cxh, c.cyh);
    gl.uniform2f(s.u.u_camLo, c.cxl, c.cyl);
    gl.uniform2f(s.u.u_half, c.W / 2, c.H / 2);
    gl.uniform1f(s.u.u_ppu, c.ppu);
    gl.uniform1fv(s.u.u_lwPx, c.lwPx);
    gl.uniform1f(s.u.u_minPx, this.dpr);
    gl.uniform1f(s.u.u_hlExtra, Math.max(1, this.dpr));
    gl.uniformMatrix2fv(s.u.u_xm, false, xm);
    gl.uniform2fv(s.u.u_xt, xt);
    gl.uniform2fv(s.u.u_xp, xp);
    const h = hl || this.theme.highlight;
    gl.uniform4f(s.u.u_hlColor, h[0], h[1], h[2], h[3]);
    gl.uniform1f(s.u.u_alpha, alpha);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.patternTex);
    gl.uniform1i(s.u.u_patterns, 0);
  }

  _useTri(c, xm, xt, xp, override, alpha) {
    const gl = this.gl,
      t = this.triProg;
    gl.useProgram(t.p);
    gl.uniform2f(t.u.u_camHi, c.cxh, c.cyh);
    gl.uniform2f(t.u.u_camLo, c.cxl, c.cyl);
    gl.uniform2f(t.u.u_half, c.W / 2, c.H / 2);
    gl.uniform1f(t.u.u_ppu, c.ppu);
    gl.uniformMatrix2fv(t.u.u_xm, false, xm);
    gl.uniform2fv(t.u.u_xt, xt);
    gl.uniform2fv(t.u.u_xp, xp);
    const o = override || [0, 0, 0, 0];
    gl.uniform4f(t.u.u_override, o[0], o[1], o[2], o[3] * 0.35);
    gl.uniform1f(t.u.u_alpha, alpha);
  }

  _drawGpu(gpu, common, highlight, color, alpha = 1, xm = IDENTITY2, xt = ZERO2) {
    const gl = this.gl;
    if (gpu.vertCount) {
      this._useTri(common, xm, xt, ZERO2, highlight ? color : null, alpha);
      gl.bindVertexArray(gpu.triVao);
      gl.drawArrays(gl.TRIANGLES, 0, gpu.vertCount);
    }
    if (gpu.segCount) {
      this._useSeg(common, xm, xt, ZERO2, alpha, color);
      gl.bindVertexArray(gpu.segVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, gpu.segCount);
    }
  }

  _drawGrid() {
    const gl = this.gl,
      g = this.gridProg,
      cam = this.camera,
      th = this.theme;
    const dpr = this.dpr;
    const ppu = cam.scale * dpr;
    // Pick a minor spacing at least ~10 device px apart.
    let sp = this.options.gridSpacing || 10;
    const major = this.options.gridMajor || 5;
    while (sp * ppu < 10 * dpr) sp *= major;
    while (sp * ppu > 10 * dpr * major * major) sp /= major;
    const spMajor = sp * major;
    const fade = Math.min(1, Math.max(0, (sp * ppu - 10 * dpr) / (20 * dpr)));
    const mod = (v, m) => v - Math.floor(v / m) * m;
    gl.useProgram(g.p);
    gl.uniform2f(g.u.u_half, this.canvas.width / 2, this.canvas.height / 2);
    gl.uniform1f(g.u.u_ppu, ppu);
    gl.uniform2f(g.u.u_offMinor, mod(cam.cx, sp), mod(cam.cy, sp));
    gl.uniform2f(g.u.u_offMajor, mod(cam.cx, spMajor), mod(cam.cy, spMajor));
    gl.uniform1f(g.u.u_spMinor, sp);
    gl.uniform1f(g.u.u_spMajor, spMajor);
    gl.uniform1f(g.u.u_minorFade, fade);
    gl.uniform4fv(g.u.u_minorColor, th.gridMinor);
    gl.uniform4fv(g.u.u_majorColor, th.gridMajor);
    gl.uniform4fv(g.u.u_axisX, this.options.grid ? th.axisX : [0, 0, 0, 0]);
    gl.uniform4fv(g.u.u_axisY, this.options.grid ? th.axisY : [0, 0, 0, 0]);
    gl.uniform2f(g.u.u_originPx, -cam.cx * ppu, -cam.cy * ppu);
    gl.uniform1f(g.u.u_showGrid, this.options.grid ? 1 : 0);
    gl.uniform1f(g.u.u_dpr, Math.max(1, dpr * 0.75));
    gl.bindVertexArray(this.gridVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.gridSpacingShown = sp;
  }

  /** Union of all chunk bounds plus construction lines' base points. */
  extents() {
    let b = null;
    for (const c of this.chunks) {
      if (c.dirty) continue;
      if (c.bounds) b = b ? union(b, c.bounds) : c.bounds.slice();
    }
    return b;
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    for (const c of this.chunks) c.gpu?.dispose();
    this.chunks = [];
  }
}

function emitSafe(e, sink, ctx) {
  try {
    emitEntity(e, sink, ctx);
  } catch (err) {
    // A malformed entity must never take the whole view down.
    if (!emitSafe.warned) {
      emitSafe.warned = true;
      console.warn('Could not draw entity', e, err);
    }
  }
}

/** True when a buffer built at scale uilt is too coarse or too fine for scale. */
function lodStale(scale, built) {
  if (!built) return true;
  const r = scale / built;
  return r > LOD_UP || r < 1 / LOD_DOWN;
}

function overlaps(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function union(a, b) {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}
