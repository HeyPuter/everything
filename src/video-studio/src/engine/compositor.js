/**
 * WebGL2 compositor. Draws the layer list from scene.evaluate() into a canvas:
 * background, media and text layers with per-layer grading, blend modes,
 * transitions, then global filter, adjustment and effect passes. Works the
 * same for the on-screen player and the offscreen exporter.
 */
import {
  QUAD_VS, FULL_VS, LAYER_FS, COPY_FS, BLUR_FS, GRADE_FS, BLEND_FS, BLEND_MODE_INDEX,
  transitionShader,
} from './shaders.js';
import { FILTERS } from '../model/catalog.js';
import { packGrade, effectiveAdjust, bakeCurves } from '../model/color.js';
import { getLut } from './luts.js';
import { bindLayerMask, drawLayerWithExtras } from './layer-extras.js';
import { bindLayerMatte } from './cutout.js';
import { effectPass, drawLayerWithEffects, freeClipFx } from './fx-render.js';
import { withFilterLook } from '../model/filter-looks.js';
import { betweenTexture } from './slow-motion.js';
import { processSource } from './source-fx.js';

const FILTER_BY_ID = new Map(FILTERS.map((f) => [f.id, f]));
const GRADE_KEYS = ['brightness', 'contrast', 'saturation', 'exposure', 'temperature', 'tint', 'highlights', 'shadows', 'fade', 'vignette', 'grain', 'sharpen', 'vibrance', 'whites', 'blacks', 'brilliance', 'clarity'];
/** Texture units of the grading lookups (layers use 0, blends and transitions 0 and 1). */
const CURVES_UNIT = 4;
const LUT_UNIT = 5;

function hexToRgb(hex) {
  const n = parseInt(String(hex || '#000000').slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * Combined grading parameters for an Adjust set plus an optional filter at
 * an intensity and the clip's optional grade (section bypass, HSL, curves,
 * wheels, LUT: packed into ext, null when none of it is active).
 */
export function gradeParams(adjust, filter, grade = null) {
  const out = { mono: 0, splitAmount: 0, shadowTint: [0, 0, 0], highlightTint: [1, 1, 1], ext: packGrade(grade) };
  const a = effectiveAdjust(adjust, grade);
  for (const k of GRADE_KEYS) out[k] = a?.[k] || 0;
  if (filter) {
    const f = FILTER_BY_ID.get(filter.id);
    const amt = (filter.intensity ?? 100) / 100;
    if (f) {
      for (const k of GRADE_KEYS) if (f.p[k]) out[k] += f.p[k] * amt;
      if (f.p.mono) out.mono = f.p.mono * amt;
      if (f.p.splitAmount) {
        out.splitAmount = f.p.splitAmount * amt;
        if (f.p.shadowTint) out.shadowTint = hexToRgb(f.p.shadowTint);
        if (f.p.highlightTint) out.highlightTint = hexToRgb(f.p.highlightTint);
      }
      if (f.hsl || f.curves) out.ext = withFilterLook(out.ext, f, amt);
    }
  }
  return out;
}

const NEUTRAL = gradeParams(null, null);

export class Compositor {
  /**
   * @param canvas HTMLCanvasElement or OffscreenCanvas
   * @param resolve (layer) => { key, source, width, height, version?, dynamic?, natural?, between? } | null
   */
  constructor(canvas, { resolve, preserveDrawingBuffer = false } = {}) {
    this.canvas = canvas;
    this.resolve = resolve;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.programs = new Map();
    this.textures = new Map();
    this.frame = 0;
    this.lost = false;
    this.width = 0;
    this.height = 0;
    this.projW = 1920;
    this.projH = 1080;
    if (canvas.addEventListener) {
      canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.lost = true;
      });
      canvas.addEventListener('webglcontextrestored', () => {
        this.lost = false;
        this.programs.clear();
        this.textures.clear();
        this.targets = null;
        freeClipFx(this, { lost: true });
        this._init();
      });
    }
    this._init();
  }

  _init() {
    const gl = this.gl;
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
    this.curveTextures = new Map(); // curves key -> { tex, used }
    this.lutTextures = new Map(); // lut id -> { tex, version, used }
    // Placeholders so the lookup samplers always have a texture of their type on their unit.
    this.blankCurves = this._floatTexture2D(new Float32Array([0, 0, 0, 0, 1, 1, 1, 1]), 2);
    this.blankLut = this._floatTexture3D(new Float32Array(8 * 4).fill(0), 2);
    this._bindLookups(this.blankCurves, this.blankLut);
  }

  /** Upload with the 2D image unpack flags off (they are invalid for 3D and float arrays). */
  _rawUpload(fn) {
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    try {
      fn();
    } finally {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    }
  }

  _floatTexture2D(data, width, tex = null) {
    const gl = this.gl;
    tex ||= gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + CURVES_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    this._rawUpload(() => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, 1, 0, gl.RGBA, gl.FLOAT, data));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  _floatTexture3D(data, size, tex = null) {
    const gl = this.gl;
    tex ||= gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + LUT_UNIT);
    gl.bindTexture(gl.TEXTURE_3D, tex);
    this._rawUpload(() => gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, size, size, size, 0, gl.RGBA, gl.FLOAT, data));
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    return tex;
  }

  _bindLookups(curves, lut) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + CURVES_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, curves);
    gl.activeTexture(gl.TEXTURE0 + LUT_UNIT);
    gl.bindTexture(gl.TEXTURE_3D, lut);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** Baked curves texture for a packed grade (cached by the curve points). */
  _curvesTexture(ext) {
    let e = this.curveTextures.get(ext.curvesKey);
    if (!e) {
      if (this.curveTextures.size >= 32) {
        const oldest = [...this.curveTextures.entries()].sort((a, b) => a[1].used - b[1].used)[0];
        this.gl.deleteTexture(oldest[1].tex);
        this.curveTextures.delete(oldest[0]);
      }
      e = { tex: this._floatTexture2D(bakeCurves(ext.curves), 256), used: 0 };
      this.curveTextures.set(ext.curvesKey, e);
    }
    e.used = this.frame;
    return e.tex;
  }

  /** 3D texture for a loaded LUT, or null while it is not loaded. */
  _lutTexture(lut) {
    let e = this.lutTextures.get(lut.id);
    if (e && e.version === lut.version) {
      e.used = this.frame;
      return e.tex;
    }
    const tex = this._floatTexture3D(lut.data, lut.size, e?.tex);
    e = { tex, version: lut.version, used: this.frame };
    this.lutTextures.set(lut.id, e);
    return tex;
  }

  /** Set output size (pixels) and the project size (layout units). */
  resize(width, height, projW, projH) {
    width = Math.max(2, Math.round(width));
    height = Math.max(2, Math.round(height));
    this.projW = projW;
    this.projH = projH;
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this._freeTargets();
  }

  _freeTargets() {
    if (!this.targets) return;
    const gl = this.gl;
    for (const t of Object.values(this.targets)) {
      gl.deleteFramebuffer(t.fb);
      gl.deleteTexture(t.tex);
    }
    this.targets = null;
  }

  _target(name, scale = 1) {
    this.targets ||= {};
    const w = Math.max(2, Math.round(this.width * scale));
    const h = Math.max(2, Math.round(this.height * scale));
    let t = this.targets[name];
    if (t && t.w === w && t.h === h) return t;
    const gl = this.gl;
    if (t) {
      gl.deleteFramebuffer(t.fb);
      gl.deleteTexture(t.tex);
    }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    t = { fb, tex, w, h };
    this.targets[name] = t;
    return t;
  }

  _program(key, vs, fs) {
    let p = this.programs.get(key);
    if (p) return p;
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new Error(`Shader ${key}: ${log}`);
      }
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(prog, 0, 'a_pos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`Program ${key}: ${gl.getProgramInfoLog(prog)}`);
    const uniforms = new Map();
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(prog, i);
      uniforms.set(info.name.replace(/\[0\]$/, ''), gl.getUniformLocation(prog, info.name));
    }
    p = { prog, u: uniforms };
    this.programs.set(key, p);
    return p;
  }

  _use(p) {
    this.gl.useProgram(p.prog);
    return p;
  }

  _set(p, name, ...v) {
    const loc = p.u.get(name);
    if (loc === undefined || loc === null) return;
    const gl = this.gl;
    const val = v[0];
    if (Array.isArray(val) || val instanceof Float32Array) {
      if (val.length === 9) gl.uniformMatrix3fv(loc, false, val);
      else if (val.length === 4) gl.uniform4fv(loc, val);
      else if (val.length === 3) gl.uniform3fv(loc, val);
      else if (val.length === 2) gl.uniform2fv(loc, val);
      return;
    }
    if (v.length === 2) gl.uniform2f(loc, v[0], v[1]);
    else if (typeof val === 'boolean') gl.uniform1i(loc, val ? 1 : 0);
    else gl.uniform1f(loc, val);
  }

  _seti(p, name, v) {
    const loc = p.u.get(name);
    if (loc !== undefined && loc !== null) this.gl.uniform1i(loc, v);
  }

  _bindTex(unit, tex) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  _draw() {
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
  }

  _into(target) {
    const gl = this.gl;
    this._bound = target || null;
    this.bound = this._bound; // per-clip effects return to the caller's target
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, target ? target.w : this.width, target ? target.h : this.height);
  }

  /** Upload (or reuse) the texture for a resolved source. */
  _texture(info) {
    // A slowed clip between two source frames: the in-between frame (slow-motion.js).
    if (info.between) return betweenTexture(this, info);
    const gl = this.gl;
    let entry = this.textures.get(info.key);
    const needsUpload = !entry || info.dynamic || entry.version !== info.version;
    if (!entry) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      entry = { tex, version: null, w: 0, h: 0, used: 0 };
      this.textures.set(info.key, entry);
    }
    gl.bindTexture(gl.TEXTURE_2D, entry.tex);
    if (needsUpload) {
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, info.source);
        entry.version = info.version;
        entry.w = info.width;
        entry.h = info.height;
        entry.ok = true;
      } catch (err) {
        // A frame that is not ready yet (or a tainted source) keeps the last good upload.
        if (!entry.ok) return null;
      }
    }
    entry.used = this.frame;
    return entry;
  }

  /** Drop textures not used for a while (sources that left the timeline). */
  _gcTextures() {
    if (this.frame % 120 !== 0) return;
    for (const [key, e] of this.textures) {
      if (this.frame - e.used > 240) {
        this.gl.deleteTexture(e.tex);
        this.textures.delete(key);
      }
    }
  }

  releaseTexture(key) {
    const e = this.textures.get(key);
    if (e) {
      this.gl.deleteTexture(e.tex);
      this.textures.delete(key);
    }
  }

  /** mat3 (column major) placing a unit quad at the layer's box in clip space. */
  _matrix(cx, cy, w, h, rotationDeg) {
    const W = this.projW;
    const H = this.projH;
    const a = (rotationDeg * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    return new Float32Array([
      (2 * w * c) / W, (-2 * w * s) / H, 0,
      (2 * h * s) / W, (2 * h * c) / H, 0,
      (2 * cx) / W - 1, 1 - (2 * cy) / H, 1,
    ]);
  }

  /** Layer box in project pixels. */
  layerBox(layer, info) {
    const W = this.projW;
    const H = this.projH;
    let bw;
    let bh;
    if (layer.kind === 'media') {
      const crop = layer.crop || { l: 0, t: 0, r: 0, b: 0 };
      const sw = (info?.width || layer.width) * (1 - crop.l - crop.r);
      const sh = (info?.height || layer.height) * (1 - crop.t - crop.b);
      const fit = Math.min(W / sw, H / sh);
      bw = sw * fit;
      bh = sh * fit;
    } else {
      bw = info?.projW || 100;
      bh = info?.projH || 100;
    }
    return { cx: W / 2 + layer.x * W, cy: H / 2 + layer.y * H, w: bw * layer.scale * (layer.sx ?? 1), h: bh * layer.scale * (layer.sy ?? 1) };
  }

  _setGrade(p, g, time) {
    for (const k of GRADE_KEYS) this._set(p, `u_${k}`, g[k]);
    this._set(p, 'u_mono', g.mono);
    this._set(p, 'u_splitAmount', g.splitAmount);
    this._set(p, 'u_shadowTint', g.shadowTint);
    this._set(p, 'u_highlightTint', g.highlightTint);
    this._set(p, 'u_time', time);
    // Lookup samplers live on their own units; they must never share unit 0 with u_tex.
    this._seti(p, 'u_curves', CURVES_UNIT);
    this._seti(p, 'u_lut', LUT_UNIT);
    const x = g.ext;
    this._seti(p, 'u_hslOn', x?.hsl ? 1 : 0);
    if (x?.hsl) {
      const loc = p.u.get('u_hsl');
      if (loc) this.gl.uniform3fv(loc, x.hsl);
    }
    this._seti(p, 'u_wheelsOn', x?.wheels ? 1 : 0);
    if (x?.wheels) {
      this._set(p, 'u_lift', x.wheels.lift);
      this._set(p, 'u_gamma', x.wheels.gamma);
      this._set(p, 'u_gain', x.wheels.gain);
      this._set(p, 'u_offset', x.wheels.offset);
    }
    const lut = x?.lut ? getLut(x.lut.id) : null;
    this._seti(p, 'u_curvesOn', x?.curves ? 1 : 0);
    this._seti(p, 'u_lutOn', lut ? 1 : 0);
    if (!x?.curves && !lut) return;
    const curvesTex = x.curves ? this._curvesTexture(x) : this.blankCurves;
    const lutTex = lut ? this._lutTexture(lut) : this.blankLut;
    if (lut) {
      this._set(p, 'u_lutSize', lut.size);
      this._set(p, 'u_lutMix', x.lut.mix);
      this._set(p, 'u_lutMin', lut.domainMin);
      this._set(p, 'u_lutMax', lut.domainMax);
    }
    this._bindLookups(curvesTex, lutTex);
  }

  /** Draw one visual layer into the bound target (premultiplied output). */
  _drawLayer(layer, time) {
    // Motion blur, noise reduction, relight and the clip's canvas fill (layer-extras.js).
    if (layer.extras && !layer.inner) return drawLayerWithExtras(this, layer, time);
    const info = this.resolve(layer);
    if (!info || !info.source) return false;
    let entry = this._texture(info);
    if (!entry) return false;
    // Object removal and enhance work on the source picture itself (source-fx.js).
    if (layer.removal || layer.enhance) entry = processSource(this, layer, info, entry, time);
    const gl = this.gl;
    const p = this._use(this._program('layer', QUAD_VS, LAYER_FS));
    const box = this.layerBox(layer, info);
    this._set(p, 'u_matrix', this._matrix(box.cx, box.cy, box.w, box.h, layer.rotation));
    const crop = layer.kind === 'media' && layer.crop ? layer.crop : { l: 0, t: 0, r: 0, b: 0 };
    this._set(p, 'u_uvRect', [crop.l, crop.b, 1 - crop.l - crop.r, 1 - crop.t - crop.b]);
    this._set(p, 'u_flip', layer.flipH ? 1 : 0, layer.flipV ? 1 : 0);
    this._set(p, 'u_opacity', layer.opacity);
    this._set(p, 'u_texel', 1 / Math.max(1, entry.w), 1 / Math.max(1, entry.h));
    this._set(p, 'u_blur', layer.blur > 0 ? layer.blur * 4 * Math.max(1, entry.w / 640) : 0);
    this._seti(p, 'u_premultiplied', 0);
    const g = layer.kind === 'media' ? gradeParams(layer.adjust, layer.filter, layer.grade) : NEUTRAL;
    this._setGrade(p, g, time);
    const ch = layer.chroma;
    this._seti(p, 'u_chroma', ch && ch.strength > 0 ? 1 : 0);
    if (ch) {
      this._set(p, 'u_keyColor', hexToRgb(ch.color));
      this._set(p, 'u_keyStrength', ch.strength);
      this._set(p, 'u_keySpill', ch.spill || 0);
    }
    bindLayerMask(this, p, layer, box);
    bindLayerMatte(this, p, layer, info);
    this._bindTex(0, entry.tex);
    this._seti(p, 'u_tex', 0);
    gl.bindVertexArray(this.vao);
    this._draw();
    return true;
  }

  /** Transition program; a dissolve stands in (with one warning) if one fails to build. */
  _transitionProgram(id) {
    this.brokenTransitions ||= new Set();
    if (!this.brokenTransitions.has(id)) {
      try {
        return this._program(`tr:${id}`, FULL_VS, transitionShader(id));
      } catch (err) {
        this.brokenTransitions.add(id);
        console.warn(`Transition ${id} is unavailable:`, err?.message || err);
      }
    }
    return this._program('tr:mix', FULL_VS, transitionShader('mix'));
  }

  /** Draw a visual layer, through its own effect stack when it has one (see fx-render.js). */
  _drawVisual(layer, time) {
    return layer.effects?.length ? drawLayerWithEffects(this, layer, time) : this._drawLayer(layer, time);
  }

  _fullPass(p) {
    this.gl.bindVertexArray(this.vao);
    this._draw();
    return p;
  }

  /** Copy (blend) a texture over the bound target. */
  _copy(tex, opacity = 1) {
    const p = this._use(this._program('copy', FULL_VS, COPY_FS));
    this._bindTex(0, tex);
    this._seti(p, 'u_tex', 0);
    this._set(p, 'u_opacity', opacity);
    this._fullPass(p);
  }

  _blurInto(srcTex, a, b, radius) {
    const gl = this.gl;
    const p = this._use(this._program('blur', FULL_VS, BLUR_FS));
    this._seti(p, 'u_tex', 0);
    let from = srcTex;
    for (let i = 0; i < 3; i++) {
      this._into(a);
      gl.disable(gl.BLEND);
      this._bindTex(0, from);
      this._set(p, 'u_dir', radius / a.w, 0);
      this._fullPass(p);
      this._into(b);
      this._bindTex(0, a.tex);
      this._set(p, 'u_dir', 0, radius / a.h);
      this._fullPass(p);
      from = b.tex;
    }
    return b;
  }

  _background(layers, settings, time) {
    const gl = this.gl;
    const bg = settings.background || { type: 'color', color: '#000000' };
    const acc = this._target('acc0');
    this._into(acc);
    const [r, g, b] = hexToRgb(bg.color);
    if (bg.type !== 'blur') {
      gl.clearColor(r, g, b, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // Blur the bottom-most media layer scaled to cover the frame.
    const first = layers.find((l) => l.kind === 'media') || layers.find((l) => l.kind === 'transition')?.from;
    if (!first) return;
    const small = this._target('bgSmall', 0.25);
    this._into(small);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);
    const info = this.resolve(first);
    if (!info?.source) return;
    const W = this.projW;
    const H = this.projH;
    const cover = Math.max(W / info.width, H / info.height);
    const fake = { ...first, x: 0, y: 0, rotation: 0, opacity: 1, blur: 0, scale: 1, sx: 1, sy: 1, masks: null, extras: null, crop: { l: 0, t: 0, r: 0, b: 0 } };
    const fit = Math.min(W / info.width, H / info.height);
    fake.scale = cover / fit;
    this._drawLayer(fake, time);
    const blurred = this._blurInto(small.tex, this._target('bgA', 0.25), this._target('bgB', 0.25), 1 + (bg.blur ?? 0.5) * 3);
    this._into(acc);
    gl.disable(gl.BLEND);
    this._copy(blurred.tex);
  }

  /**
   * Render a frame. layers come from scene.evaluate (bottom to top).
   * Returns false if the context is lost.
   */
  render(layers, { settings, time = 0 } = {}) {
    if (this.lost) return false;
    const gl = this.gl;
    this.frame++;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.DEPTH_TEST);
    this._background(layers, settings, time);
    let acc = this._target('acc0');
    let alt = this._target('acc1');
    const swap = () => {
      const t = acc;
      acc = alt;
      alt = t;
    };
    for (const layer of layers) {
      if (layer.kind === 'media' || layer.kind === 'text' || layer.kind === 'sticker' || layer.kind === 'avatar') {
        const mode = BLEND_MODE_INDEX[layer.blend] || 0;
        if (mode === 0) {
          this._into(acc);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          this._drawVisual(layer, time);
        } else {
          const tmp = this._target('layer');
          this._into(tmp);
          gl.disable(gl.BLEND);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          this._drawVisual(layer, time);
          gl.disable(gl.BLEND);
          this._into(alt);
          const p = this._use(this._program('blend', FULL_VS, BLEND_FS));
          this._bindTex(0, acc.tex);
          this._bindTex(1, tmp.tex);
          this._seti(p, 'u_dst', 0);
          this._seti(p, 'u_src', 1);
          this._seti(p, 'u_mode', mode);
          this._fullPass(p);
          swap();
        }
      } else if (layer.kind === 'transition') {
        const ta = this._target('trA');
        const tb = this._target('trB');
        for (const [t, l] of [[ta, layer.from], [tb, layer.to]]) {
          this._into(t);
          gl.disable(gl.BLEND);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          this._drawVisual(l, time);
        }
        this._into(acc);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        const p = this._use(this._transitionProgram(layer.id));
        this._bindTex(0, ta.tex);
        this._bindTex(1, tb.tex);
        this._seti(p, 'u_from', 0);
        this._seti(p, 'u_to', 1);
        this._set(p, 'u_progress', layer.progress);
        this._set(p, 'u_res', this.width, this.height);
        this._fullPass(p);
      } else if (layer.kind === 'filter' || layer.kind === 'adjust') {
        this._into(alt);
        gl.disable(gl.BLEND);
        const p = this._use(this._program('grade', FULL_VS, GRADE_FS));
        const g = layer.kind === 'filter' ? gradeParams(null, { id: layer.filter, intensity: layer.intensity }) : gradeParams(layer.adjust, null, layer.grade);
        this._setGrade(p, g, time);
        this._set(p, 'u_mix', 1);
        this._set(p, 'u_texel', 1 / acc.w, 1 / acc.h);
        this._bindTex(0, acc.tex);
        this._seti(p, 'u_tex', 0);
        this._fullPass(p);
        swap();
      } else if (layer.kind === 'effect') {
        const duration = layer.duration ?? layer.clip?.duration ?? 0;
        if (effectPass(this, layer.effect, layer.params, acc, alt, { time: layer.local / 1e6, duration: duration / 1e6 })) swap();
      }
    }
    // Present.
    this._into(null);
    gl.disable(gl.BLEND);
    this._copy(acc.tex);
    this._gcTextures();
    return true;
  }

  /**
   * RGBA8 pixels of the last rendered frame (top row first). Call in the same
   * task as render(): without preserveDrawingBuffer the canvas is cleared
   * once it has been shown.
   */
  readPixels() {
    const gl = this.gl;
    const w = this.width;
    const hgt = this.height;
    const raw = new Uint8Array(w * hgt * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, hgt, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    // GL rows run bottom-up.
    const out = new Uint8ClampedArray(raw.length);
    const row = w * 4;
    for (let y = 0; y < hgt; y++) out.set(raw.subarray((hgt - 1 - y) * row, (hgt - y) * row), y * row);
    return { width: w, height: hgt, data: out };
  }

  dispose() {
    const gl = this.gl;
    this._freeTargets();
    freeClipFx(this);
    this._matteCache?.dispose();
    this._removalRaster?.dispose();
    this.srcFxCache = null;
    this._faceCache?.dispose();
    this._hairCache?.dispose();
    this._poseCache?.dispose();
    for (const e of [...this.curveTextures.values(), ...this.lutTextures.values()]) gl.deleteTexture(e.tex);
    this.curveTextures.clear();
    this.lutTextures.clear();
    for (const e of this.textures.values()) gl.deleteTexture(e.tex);
    this.textures.clear();
    for (const p of this.programs.values()) gl.deleteProgram(p.prog);
    this.programs.clear();
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
