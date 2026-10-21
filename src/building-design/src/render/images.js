/**
 * Raster images placed in 2D views (scanned drawings, site photos, logos):
 * textured quads drawn under the view's linework. Textures load
 * asynchronously and are cached per element and source.
 */
import { createProgram } from './gl.js';

const VS = /* glsl */ `#version 300 es
precision highp float;
layout(location=0) in vec2 aUV;
uniform mat3 uMat;
uniform vec2 uAt;
uniform vec2 uSize;
uniform float uRot;
out vec2 vUV;
void main() {
  vUV = vec2(aUV.x, 1.0 - aUV.y);
  vec2 p = aUV * uSize;
  float c = cos(uRot);
  float s = sin(uRot);
  vec2 q = uAt + vec2(p.x * c - p.y * s, p.x * s + p.y * c);
  vec3 clip = uMat * vec3(q, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}`;

const FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform float uOpacity;
uniform vec3 uBg;
uniform float uHalftone;
out vec4 o;
void main() {
  vec4 c = texture(uTex, vUV);
  vec3 rgb = mix(c.rgb, uBg, uHalftone);
  o = vec4(rgb, c.a * uOpacity);
}`;

export class ImageRenderer {
  constructor(gl, onLoad) {
    this.gl = gl;
    this.onLoad = onLoad;
    this.prog = createProgram(gl, VS, FS, 'images');
    this.cache = new Map();
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  texture(el) {
    const key = `${el.id}:${el.src?.length || 0}:${el.src?.slice(-32)}`;
    let t = this.cache.get(el.id);
    if (t && t.key === key) return t.ready ? t.tex : null;
    if (t?.tex) this.gl.deleteTexture(t.tex);
    t = { key, tex: null, ready: false };
    this.cache.set(el.id, t);
    const img = new Image();
    img.onload = () => {
      if (this.cache.get(el.id) !== t) return;
      const gl = this.gl;
      t.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      t.ready = true;
      this.onLoad?.();
    };
    img.src = el.src;
    return null;
  }

  /** Draw images (elements with at, w, h, src, opacity) with a model-to-clip matrix. */
  draw(images, matrix, theme, flagsOf) {
    if (!images.length) return;
    const gl = this.gl;
    const p = this.prog;
    gl.useProgram(p.program);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.uniformMatrix3fv(p.u.uMat, false, matrix);
    gl.uniform3fv(p.u.uBg, theme.bg);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(p.u.uTex, 0);
    for (const el of images) {
      const tex = this.texture(el);
      if (!tex) continue;
      const f = flagsOf?.(el.id) || 0;
      if (f & 4) continue;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform2f(p.u.uAt, el.at[0], el.at[1]);
      gl.uniform2f(p.u.uSize, +el.w || 1000, +el.h || 1000);
      gl.uniform1f(p.u.uRot, ((+el.rotation || 0) * Math.PI) / 180);
      gl.uniform1f(p.u.uOpacity, el.opacity ?? 1);
      gl.uniform1f(p.u.uHalftone, f & 8 ? 0.55 : 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.bindVertexArray(null);
  }

  /** Forget textures of elements that are gone. */
  retain(ids) {
    for (const [id, t] of this.cache)
      if (!ids.has(id)) {
        if (t.tex) this.gl.deleteTexture(t.tex);
        this.cache.delete(id);
      }
  }
}
