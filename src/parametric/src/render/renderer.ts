// WebGL2 renderer specialised for CAD: shaded B-rep meshes with per-face
// state (hover/selection/colour) from a data texture, screen-space thick
// edges and overlay lines (instanced quads), points, translucent planes,
// section clipping, five display styles and GPU picking that returns both the
// entity id and the depth under the cursor. Frames are rendered on demand.

import type { MeshData } from '../kernel/protocol';
import { type Vec3, add, scale, toF32 } from '../math/vec';
import { Camera } from './camera';

export type DisplayStyle = 'shadedEdges' | 'shaded' | 'hiddenRemoved' | 'hiddenVisible' | 'wireframe';

export interface PickWant { face?: boolean; edge?: boolean; vertex?: boolean }
interface PickRegion { x0: number; y0: number; w: number; h: number; px: number; py: number }

export type PickKind = 'face' | 'edge' | 'vertex' | 'overlay';

export interface PickHit {
  kind: PickKind;
  index: number;
  /** World position under the cursor (when depth is available). */
  point: Vec3 | null;
}

export const STATE_NONE = 0;
export const STATE_HOVER = 1;
export const STATE_SELECTED = 2;
export const STATE_HIDDEN = 4;

const MESH_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in float aFace;
uniform mat4 uViewProj;
uniform mat4 uView;
out vec3 vN;
out vec3 vPosV;
out vec3 vWorld;
flat out int vFace;
void main() {
  vec4 w = vec4(aPos, 1.0);
  gl_Position = uViewProj * w;
  vN = mat3(uView) * aNormal;
  vPosV = (uView * w).xyz;
  vWorld = aPos;
  vFace = int(aFace + 0.5);
}`;

const MESH_FS = `#version 300 es
precision highp float;
precision highp int;
in vec3 vN;
in vec3 vPosV;
in vec3 vWorld;
flat in int vFace;
uniform vec3 uColor;
uniform float uAlpha;
uniform int uUseState;
uniform sampler2D uState;
uniform sampler2D uFaceColor;
uniform vec4 uClip;
uniform int uClipOn;
uniform int uOrtho;
uniform int uFlat;
uniform vec3 uFlatColor;
uniform vec3 uSelColor;
uniform vec3 uHoverColor;
uniform vec3 uCapColor;
out vec4 outColor;
void main() {
  if (uClipOn == 1 && dot(vec4(vWorld, 1.0), uClip) > 0.0) discard;
  vec3 base = uColor;
  int st = 0;
  if (uUseState == 1) {
    ivec2 tc = ivec2(vFace % 2048, vFace / 2048);
    vec4 fc = texelFetch(uFaceColor, tc, 0);
    if (fc.a > 0.0) base = fc.rgb;
    st = int(texelFetch(uState, tc, 0).r * 255.0 + 0.5);
    if ((st & 4) != 0) discard;
  }
  if (uFlat != 0) {
    // Line styles: faces hide what is behind them in the background colour
    // (1) or are not drawn at all (2, wireframe); a selected or hovered face
    // still gets a light tint of the shaded style's colour.
    if (uFlat == 2 && (st & 3) == 0) discard;
    vec3 tint = (st & 2) != 0 ? uSelColor : uHoverColor;
    float k = (st & 2) != 0 ? 0.3 : (st & 1) != 0 ? 0.18 : 0.0;
    outColor = uFlat == 2 ? vec4(tint, k) : vec4(mix(uFlatColor, tint, k), 1.0);
    return;
  }
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  vec3 v = uOrtho == 1 ? vec3(0.0, 0.0, 1.0) : normalize(-vPosV);
  vec3 l1 = normalize(vec3(0.35, 0.55, 1.0));
  vec3 l2 = normalize(vec3(-0.6, -0.25, 0.55));
  float d1 = max(dot(n, l1), 0.0);
  float d2 = max(dot(n, l2), 0.0);
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  vec3 h = normalize(l1 + v);
  float sp = pow(max(dot(n, h), 0.0), 60.0);
  float hemi = 0.5 + 0.5 * n.y;
  vec3 col = base * (0.36 + 0.16 * hemi + 0.48 * d1 + 0.12 * d2) + vec3(0.2) * sp + base * rim * 0.06;
  if ((st & 2) != 0) col = mix(col, uSelColor, 0.62);
  else if ((st & 1) != 0) col = mix(col, uHoverColor, 0.45);
  if (!gl_FrontFacing && uClipOn == 1) col = uCapColor;
  outColor = vec4(col, uAlpha);
}`;

// Thick screen-space segments. Each instance is one segment; the 4 quad
// corners come from aCorner (x: start/end, y: side).
const SEG_VS = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec3 aA;
layout(location=2) in vec3 aB;
layout(location=3) in float aId;
layout(location=4) in vec4 aColor;
uniform mat4 uViewProj;
uniform vec2 uViewport;
uniform float uWidth;
uniform float uDepthBias;
out vec4 vColor;
out float vDist;
out vec3 vWorld;
flat out int vId;
void main() {
  vec4 ca = uViewProj * vec4(aA, 1.0);
  vec4 cb = uViewProj * vec4(aB, 1.0);
  vec2 sa = ca.xy / ca.w * uViewport * 0.5;
  vec2 sb = cb.xy / cb.w * uViewport * 0.5;
  vec2 d = sb - sa;
  float l = length(d);
  vec2 dir = l > 1e-6 ? d / l : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  vec4 c = mix(ca, cb, aCorner.x);
  vec2 off = nrm * aCorner.y * uWidth * 0.5 + dir * (aCorner.x * 2.0 - 1.0) * uWidth * 0.5;
  c.xy += off / (uViewport * 0.5) * c.w;
  c.z -= uDepthBias * c.w;
  gl_Position = c;
  vColor = aColor;
  vDist = aCorner.x * l;
  vWorld = mix(aA, aB, aCorner.x);
  vId = int(aId + 0.5);
}`;

const SEG_FS = `#version 300 es
precision highp float;
precision highp int;
in vec4 vColor;
in float vDist;
in vec3 vWorld;
flat in int vId;
uniform int uUseColor;
uniform vec4 uColor;
uniform int uUseState;
uniform sampler2D uState;
uniform vec3 uSelColor;
uniform vec3 uHoverColor;
uniform float uDash;
uniform vec4 uClip;
uniform int uClipOn;
out vec4 outColor;
void main() {
  if (uClipOn == 1 && dot(vec4(vWorld, 1.0), uClip) > 0.0) discard;
  if (uDash > 0.0 && mod(vDist, uDash * 2.0) > uDash) discard;
  vec4 c = uUseColor == 1 ? vColor : uColor;
  if (uUseState == 1) {
    int st = int(texelFetch(uState, ivec2(vId % 2048, vId / 2048), 0).r * 255.0 + 0.5);
    if ((st & 4) != 0) discard;
    if ((st & 2) != 0) c = vec4(uSelColor, 1.0);
    else if ((st & 1) != 0) c = vec4(uHoverColor, 1.0);
  }
  outColor = c;
}`;

const PT_VS = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec3 aPos;
layout(location=2) in vec4 aColor;
layout(location=3) in vec2 aSizeStyle;
uniform mat4 uViewProj;
uniform vec2 uViewport;
uniform float uDepthBias;
out vec4 vColor;
out vec2 vUv;
flat out int vStyle;
void main() {
  vec4 c = uViewProj * vec4(aPos, 1.0);
  c.xy += aCorner * aSizeStyle.x * 0.5 / (uViewport * 0.5) * c.w;
  c.z -= uDepthBias * c.w;
  gl_Position = c;
  vColor = aColor;
  vUv = aCorner;
  vStyle = int(aSizeStyle.y + 0.5);
}`;

const PT_FS = `#version 300 es
precision highp float;
in vec4 vColor;
in vec2 vUv;
flat in int vStyle;
out vec4 outColor;
void main() {
  float r = length(vUv);
  if (vStyle == 1 && r > 1.0) discard;
  if (vStyle == 2 && (r > 1.0 || r < 0.55)) discard;
  outColor = vColor;
}`;

const TRI_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aColor;
uniform mat4 uViewProj;
out vec4 vColor;
void main() { gl_Position = uViewProj * vec4(aPos, 1.0); vColor = aColor; }`;

const TRI_FS = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() { outColor = vColor; }`;

// Picking: id in an R32UI target and eye distance in an R32F target.
const PICK_MESH_FS = `#version 300 es
precision highp float;
precision highp int;
flat in int vFace;
in vec3 vPosV;
in vec3 vWorld;
in vec3 vN;
uniform vec4 uClip;
uniform int uClipOn;
uniform sampler2D uState;
uniform int uUseState;
layout(location=0) out uint outId;
layout(location=1) out float outDepth;
void main() {
  if (uClipOn == 1 && dot(vec4(vWorld, 1.0), uClip) > 0.0) discard;
  if (uUseState == 1) {
    int st = int(texelFetch(uState, ivec2(vFace % 2048, vFace / 2048), 0).r * 255.0 + 0.5);
    if ((st & 4) != 0) discard;
  }
  outId = (1u << 28) | uint(vFace);
  outDepth = -vPosV.z;
}`;

const PICK_SEG_FS = `#version 300 es
precision highp float;
precision highp int;
flat in int vId;
in vec3 vWorld;
uniform uint uKind;
uniform mat4 uView;
uniform vec4 uClip;
uniform int uClipOn;
layout(location=0) out uint outId;
layout(location=1) out float outDepth;
void main() {
  if (uClipOn == 1 && dot(vec4(vWorld, 1.0), uClip) > 0.0) discard;
  outId = (uKind << 28) | uint(vId);
  outDepth = -(uView * vec4(vWorld, 1.0)).z;
}`;

const PICK_PT_VS = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec3 aPos;
uniform mat4 uViewProj;
uniform vec2 uViewport;
uniform float uSize;
flat out int vId;
out vec3 vWorld;
void main() {
  vec4 c = uViewProj * vec4(aPos, 1.0);
  c.xy += aCorner * uSize * 0.5 / (uViewport * 0.5) * c.w;
  c.z -= 0.0005 * c.w;
  gl_Position = c;
  vId = gl_InstanceID;
  vWorld = aPos;
}`;

const PICK_PT_FS = `#version 300 es
precision highp float;
precision highp int;
flat in int vId;
in vec3 vWorld;
uniform mat4 uView;
uniform vec4 uClip;
uniform int uClipOn;
layout(location=0) out uint outId;
layout(location=1) out float outDepth;
void main() {
  if (uClipOn == 1 && dot(vec4(vWorld, 1.0), uClip) > 0.0) discard;
  outId = (3u << 28) | uint(vId);
  outDepth = -(uView * vec4(vWorld, 1.0)).z;
}`;

type Prog = { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };

type Box = [number, number, number, number, number, number];

/** Axis-aligned box of xyz triples, or null when there are none. */
function boxOf(positions: Float32Array): Box | null {
  if (positions.length < 3) return null;
  const b: Box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < b[k]) b[k] = v;
      if (v > b[k + 3]) b[k + 3] = v;
    }
  }
  return b.every(Number.isFinite) ? b : null;
}

export interface LineBatch {
  /** Pairs of points (6 floats per segment). */
  positions: Float32Array;
  /** RGBA per segment (normalised 0..255). */
  colors: Uint8Array;
  width: number;
  depth: 'test' | 'always';
  dash?: number;
  bias?: number;
  /** Overlay ids per segment for picking (optional). */
  ids?: Float32Array;
  order?: number;
}

export interface PointBatch {
  positions: Float32Array;
  colors: Uint8Array;
  /** size (px) and style (0 square, 1 disc, 2 ring) per point */
  sizeStyle: Float32Array;
  depth: 'test' | 'always';
  order?: number;
}

export interface TriBatch {
  positions: Float32Array;
  colors: Uint8Array;
  depth: 'test' | 'always';
  order?: number;
}

interface GpuSegs {
  vao: WebGLVertexArrayObject;
  bufs: WebGLBuffer[];
  count: number;
}

interface GpuMesh {
  vao: WebGLVertexArrayObject;
  bufs: WebGLBuffer[];
  indexCount: number;
  edges: GpuSegs | null;
  verts: { vao: WebGLVertexArrayObject; buf: WebGLBuffer; count: number } | null;
  faceCount: number;
  edgeCount: number;
}

export interface Theme {
  background: [number, number, number];
  model: [number, number, number];
  edge: [number, number, number];
  /** Visible edges where faces are not shaded (line styles). */
  wire: [number, number, number];
  hiddenEdge: [number, number, number];
  selection: [number, number, number];
  hover: [number, number, number];
  preview: [number, number, number];
  previewCut: [number, number, number];
  cap: [number, number, number];
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly camera = new Camera();
  displayStyle: DisplayStyle = 'shadedEdges';
  modelColor: [number, number, number] | null = null;
  section: { normal: Vec3; offset: number } | null = null;
  showEdges = true;
  theme: Theme;
  private progs: Record<string, Prog> = {};
  private model: GpuMesh | null = null;
  private preview: GpuMesh | null = null;
  /** CPU copies of the meshes, re-uploaded when a lost context is restored. */
  private modelMesh: MeshData | null = null;
  private previewMesh: MeshData | null = null;
  private previewKind: 'tool' | 'body' = 'tool';
  previewCut = false;
  /** Segment corners: x along the segment (0 start, 1 end), y across it. */
  private quad!: WebGLBuffer;
  /** Point sprite corners, centred on the point. */
  private ptQuad!: WebGLBuffer;
  private faceState!: WebGLTexture;
  private faceColor!: WebGLTexture;
  private edgeState!: WebGLTexture;
  private faceStateData: Uint8Array = new Uint8Array(0);
  private edgeStateData: Uint8Array = new Uint8Array(0);
  private faceColorData: Uint8Array = new Uint8Array(0);
  private lines = new Map<string, LineBatch & { gpu?: GpuSegs }>();
  private points = new Map<string, PointBatch & { gpu?: { vao: WebGLVertexArrayObject; bufs: WebGLBuffer[]; count: number } }>();
  private tris = new Map<string, TriBatch & { gpu?: { vao: WebGLVertexArrayObject; bufs: WebGLBuffer[]; count: number } }>();
  private pickFbo: WebGLFramebuffer | null = null;
  private pickTex: WebGLTexture | null = null;
  private pickDepthTex: WebGLTexture | null = null;
  private pickRb: WebGLRenderbuffer | null = null;
  private pickSize = [0, 0];
  private canFloat = false;
  private raf = 0;
  private dirty = true;
  dpr = 1;
  onFrame: () => void = () => {};
  /**
   * Called before drawing a frame in which the camera moved, zoomed or the
   * viewport was resized, so pixel-sized overlays and screen-positioned DOM
   * labels can follow the view in the same frame.
   */
  onCamera: () => void = () => {};
  private camSig = new Float64Array(12);
  /** Bounding boxes of what is drawn, by source, for the camera's clip range. */
  private boxes = new Map<string, Box | null>();
  lost = false;

  constructor(readonly canvas: HTMLCanvasElement, theme: Theme) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance', premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL 2 is not available in this browser');
    this.gl = gl;
    this.theme = theme;
    this.initGl();
    this.camera.onChange = () => this.requestRender();
    // The browser may drop the context (GPU reset, driver update, too many
    // contexts). Everything is re-created from the CPU copies on restore.
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => this.restore());
  }

  /** Creates programs and the shared buffers and textures. */
  private initGl() {
    const gl = this.gl;
    this.canFloat = !!gl.getExtension('EXT_color_buffer_float');
    this.progs.mesh = this.program(MESH_VS, MESH_FS);
    this.progs.seg = this.program(SEG_VS, SEG_FS);
    this.progs.pt = this.program(PT_VS, PT_FS);
    this.progs.tri = this.program(TRI_VS, TRI_FS);
    this.progs.pickMesh = this.program(MESH_VS, PICK_MESH_FS);
    this.progs.pickSeg = this.program(SEG_VS, PICK_SEG_FS);
    this.progs.pickPt = this.program(PICK_PT_VS, PICK_PT_FS);
    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.ptQuad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ptQuad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.faceState = this.dataTexture();
    this.faceColor = this.dataTexture();
    this.edgeState = this.dataTexture();
  }

  private restore() {
    this.initGl();
    this.pickFbo = this.pickTex = this.pickDepthTex = this.pickRb = null;
    this.pickSize = [0, 0];
    this.pbo = null;
    this.cut = null;
    this.lost = false;
    this.model = this.modelMesh ? this.meshToGpu(this.modelMesh) : null;
    this.preview = this.previewMesh ? this.meshToGpu(this.previewMesh) : null;
    this.uploadData(this.faceState, this.faceStateData, this.faceStateData.length, 1);
    this.uploadData(this.edgeState, this.edgeStateData, this.edgeStateData.length, 1);
    this.uploadData(this.faceColor, this.faceColorData, this.faceColorData.length / 4, 4);
    // Old GPU handles belong to the lost context; drop them before re-uploading.
    for (const [k, b] of [...this.lines]) { b.gpu = undefined; this.setLines(k, b); }
    for (const [k, b] of [...this.points]) { b.gpu = undefined; this.setPoints(k, b); }
    for (const [k, b] of [...this.tris]) { b.gpu = undefined; this.setTris(k, b); }
    this.requestRender();
  }

  private program(vs: string, fs: string): Prog {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader error');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link error');
    const u: Record<string, WebGLUniformLocation | null> = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i)!;
      u[info.name] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
  }

  private dataTexture(): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    return t;
  }

  private uploadData(tex: WebGLTexture, data: Uint8Array, n: number, channels: 1 | 4) {
    const gl = this.gl;
    const w = Math.max(1, Math.min(2048, n));
    const h = Math.max(1, Math.ceil(n / 2048));
    const rgba = new Uint8Array(w * h * 4);
    if (channels === 4) rgba.set(data.subarray(0, Math.min(data.length, rgba.length)));
    else for (let i = 0; i < n; i++) rgba[i * 4] = data[i];
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  }

  // ---- resources ----

  private segVao(positions: Float32Array, ids?: Float32Array, colors?: Uint8Array): GpuSegs {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const pos = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, pos);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 24, 12);
    gl.vertexAttribDivisor(2, 1);
    const bufs = [pos];
    const idb = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, idb);
    gl.bufferData(gl.ARRAY_BUFFER, ids ?? new Float32Array(positions.length / 6), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(3, 1);
    bufs.push(idb);
    const cb = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, cb);
    gl.bufferData(gl.ARRAY_BUFFER, colors ?? new Uint8Array((positions.length / 6) * 4), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 4, gl.UNSIGNED_BYTE, true, 0, 0);
    gl.vertexAttribDivisor(4, 1);
    bufs.push(cb);
    gl.bindVertexArray(null);
    return { vao, bufs, count: positions.length / 6 };
  }

  private meshToGpu(m: MeshData): GpuMesh {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const mk = (data: Float32Array, loc: number, size: number) => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      return b;
    };
    const bufs = [mk(m.positions, 0, 3), mk(m.normals, 1, 3), mk(m.vertexFace, 2, 1)];
    const ib = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.indices, gl.STATIC_DRAW);
    bufs.push(ib);
    gl.bindVertexArray(null);
    // Edge polylines come as point pairs; convert to segment instances.
    let edges: GpuSegs | null = null;
    if (m.edgePositions.length >= 6) {
      const nseg = m.edgePositions.length / 6;
      const ids = new Float32Array(nseg);
      for (let i = 0; i < nseg; i++) ids[i] = m.edgeIds[i * 2];
      edges = this.segVao(m.edgePositions, ids);
    }
    let verts: GpuMesh['verts'] = null;
    if (m.vertices.length) {
      const vvao = gl.createVertexArray()!;
      gl.bindVertexArray(vvao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.ptQuad);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      const vb = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, m.vertices, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(1, 1);
      gl.bindVertexArray(null);
      verts = { vao: vvao, buf: vb, count: m.vertices.length / 3 };
    }
    let faceCount = 0;
    for (let i = 0; i < m.vertexFace.length; i++) if (m.vertexFace[i] + 1 > faceCount) faceCount = m.vertexFace[i] + 1;
    let edgeCount = 0;
    for (let i = 0; i < m.edgeIds.length; i++) if (m.edgeIds[i] + 1 > edgeCount) edgeCount = m.edgeIds[i] + 1;
    return { vao, bufs, indexCount: m.indices.length, edges, verts, faceCount, edgeCount };
  }

  private freeMesh(g: GpuMesh | null) {
    if (!g) return;
    const gl = this.gl;
    gl.deleteVertexArray(g.vao);
    g.bufs.forEach((b) => gl.deleteBuffer(b));
    if (g.edges) { gl.deleteVertexArray(g.edges.vao); g.edges.bufs.forEach((b) => gl.deleteBuffer(b)); }
    if (g.verts) { gl.deleteVertexArray(g.verts.vao); gl.deleteBuffer(g.verts.buf); }
  }

  /** Records the box of one source of geometry and updates the camera's scene bounds. */
  private setBox(key: string, positions: Float32Array | null) {
    // The origin marker is pixel-sized: far from the model it would only cost depth precision.
    if (key.endsWith(':origin')) return;
    this.boxes.set(key, positions ? boxOf(positions) : null);
    const u: Box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const b of this.boxes.values()) if (b) for (let k = 0; k < 3; k++) { u[k] = Math.min(u[k], b[k]); u[k + 3] = Math.max(u[k + 3], b[k + 3]); }
    this.camera.sceneBounds = u[0] <= u[3]
      ? { center: [(u[0] + u[3]) / 2, (u[1] + u[4]) / 2, (u[2] + u[5]) / 2], radius: Math.hypot(u[3] - u[0], u[4] - u[1], u[5] - u[2]) / 2 }
      : null;
  }

  setModel(m: MeshData | null, faceCount: number, edgeCount: number) {
    this.freeMesh(this.model);
    this.modelMesh = m && m.indices.length ? m : null;
    this.setBox('model', this.modelMesh?.positions ?? null);
    this.model = this.modelMesh ? this.meshToGpu(this.modelMesh) : null;
    this.faceStateData = new Uint8Array(faceCount);
    this.edgeStateData = new Uint8Array(edgeCount);
    this.faceColorData = new Uint8Array(faceCount * 4);
    this.uploadData(this.faceState, this.faceStateData, faceCount, 1);
    this.uploadData(this.edgeState, this.edgeStateData, edgeCount, 1);
    this.uploadData(this.faceColor, this.faceColorData, faceCount, 4);
    this.requestRender();
  }

  setPreview(m: MeshData | null, kind: 'tool' | 'body' = 'tool', isCut = false) {
    this.freeMesh(this.preview);
    this.previewMesh = m && m.indices.length ? m : null;
    this.setBox('preview', this.previewMesh?.positions ?? null);
    this.preview = this.previewMesh ? this.meshToGpu(this.previewMesh) : null;
    this.previewKind = kind;
    this.previewCut = isCut;
    this.requestRender();
  }

  get hasPreviewBody(): boolean {
    return !!this.preview && this.previewKind === 'body';
  }

  setStates(face: Uint8Array, edge: Uint8Array) {
    this.faceStateData = face;
    this.edgeStateData = edge;
    this.uploadData(this.faceState, face, face.length, 1);
    this.uploadData(this.edgeState, edge, edge.length, 1);
    this.requestRender();
  }

  setFaceColors(rgba: Uint8Array) {
    this.faceColorData = rgba;
    this.uploadData(this.faceColor, rgba, rgba.length / 4, 4);
    this.requestRender();
  }

  setLines(key: string, batch: LineBatch | null) {
    const old = this.lines.get(key);
    if (old?.gpu) { this.gl.deleteVertexArray(old.gpu.vao); old.gpu.bufs.forEach((b) => this.gl.deleteBuffer(b)); }
    this.setBox(`lines:${key}`, batch?.positions ?? null);
    if (!batch || !batch.positions.length) this.lines.delete(key);
    else this.lines.set(key, { ...batch, gpu: this.segVao(batch.positions, batch.ids, batch.colors) });
    this.requestRender();
  }

  setPoints(key: string, batch: PointBatch | null) {
    const gl = this.gl;
    const old = this.points.get(key);
    if (old?.gpu) { gl.deleteVertexArray(old.gpu.vao); old.gpu.bufs.forEach((b) => gl.deleteBuffer(b)); }
    this.setBox(`points:${key}`, batch?.positions ?? null);
    if (!batch || !batch.positions.length) { this.points.delete(key); this.requestRender(); return; }
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ptQuad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const bufs: WebGLBuffer[] = [];
    const attr = (data: ArrayBufferView, loc: number, size: number, type: number, norm: boolean) => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, type, norm, 0, 0);
      gl.vertexAttribDivisor(loc, 1);
      bufs.push(b);
    };
    attr(batch.positions, 1, 3, gl.FLOAT, false);
    attr(batch.colors, 2, 4, gl.UNSIGNED_BYTE, true);
    attr(batch.sizeStyle, 3, 2, gl.FLOAT, false);
    gl.bindVertexArray(null);
    this.points.set(key, { ...batch, gpu: { vao, bufs, count: batch.positions.length / 3 } });
    this.requestRender();
  }

  setTris(key: string, batch: TriBatch | null) {
    const gl = this.gl;
    const old = this.tris.get(key);
    if (old?.gpu) { gl.deleteVertexArray(old.gpu.vao); old.gpu.bufs.forEach((b) => gl.deleteBuffer(b)); }
    this.setBox(`tris:${key}`, batch?.positions ?? null);
    if (!batch || !batch.positions.length) { this.tris.delete(key); this.requestRender(); return; }
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const pb = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, pb);
    gl.bufferData(gl.ARRAY_BUFFER, batch.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const cb = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, cb);
    gl.bufferData(gl.ARRAY_BUFFER, batch.colors, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 0, 0);
    gl.bindVertexArray(null);
    this.tris.set(key, { ...batch, gpu: { vao, bufs: [pb, cb], count: batch.positions.length / 3 } });
    this.requestRender();
  }

  // ---- frame ----

  resize(cssW: number, cssH: number, dpr: number) {
    this.dpr = Math.min(dpr, 2);
    const w = Math.max(1, Math.round(cssW * this.dpr));
    const h = Math.max(1, Math.round(cssH * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.camera.width = cssW;
    this.camera.height = cssH;
    this.requestRender();
  }

  requestRender() {
    this.dirty = true;
    if (!this.raf) this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  /**
   * Draws a frame now and returns it as a JPEG data URL, scaled so its longer
   * side is at most maxSide pixels. The drawing buffer is read in the same
   * task as the draw, so it does not need to be preserved.
   */
  capture(maxSide = 1024): string | null {
    if (this.lost) return null;
    this.draw();
    const src = this.canvas;
    const s = Math.min(1, maxSide / Math.max(src.width, src.height));
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(src.width * s));
    out.height = Math.max(1, Math.round(src.height * s));
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(src, 0, 0, out.width, out.height);
    return out.toDataURL('image/jpeg', 0.85);
  }

  private frame(now: number) {
    this.raf = 0;
    const animating = this.camera.tick(now);
    if (this.cameraMoved()) {
      this.onCamera();
      // Overlays updated by the hook are drawn in this frame, not the next.
      if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
      this.dirty = true;
    }
    if (this.dirty || animating) {
      this.dirty = false;
      this.draw();
      this.onFrame();
    }
    if (animating) this.requestRender();
  }

  /** True when the view changed since the last check. */
  private cameraMoved(): boolean {
    const c = this.camera, s = this.camSig;
    const v = [c.target[0], c.target[1], c.target[2], c.distance, c.rot[0], c.rot[1], c.rot[2], c.rot[3], c.ortho ? 1 : 0, c.width, c.height, c.fov];
    let changed = false;
    for (let i = 0; i < v.length; i++) if (s[i] !== v[i]) { s[i] = v[i]; changed = true; }
    return changed;
  }

  private clipVec(): [number, number, number, number] | null {
    if (!this.section) return null;
    const n = this.section.normal;
    return [n[0], n[1], n[2], -this.section.offset];
  }

  private draw() {
    if (this.lost) return;
    const gl = this.gl;
    const cam = this.camera;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const bg = this.theme.background;
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    const vp = toF32(cam.viewProj());
    const view = toF32(cam.view());
    const viewport = [cam.width, cam.height];
    const clip = this.clipVec();
    const style = this.displayStyle;
    const showBody = !this.hasPreviewBody;
    const body = showBody ? this.model : this.preview;

    const ordered = <T extends { order?: number; depth: 'test' | 'always' }>(m: Map<string, T>, depth: 'test' | 'always') =>
      [...m.values()].filter((b) => b.depth === depth).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    // Translucent and depth-tested overlays that should sit behind geometry edges.
    if (body) {
      const flat = style === 'hiddenRemoved' || style === 'hiddenVisible';
      if (style !== 'wireframe') {
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(1, 1);
        this.drawMesh(body, vp, view, clip, { flat: flat ? 1 : 0, alpha: 1, useState: showBody, color: this.modelColor ?? this.theme.model });
        gl.disable(gl.POLYGON_OFFSET_FILL);
      } else if (showBody && this.faceStateData.some((s) => s & 3)) {
        // Wireframe draws no faces: tint just the selected and hovered ones.
        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        this.drawMesh(body, vp, view, clip, { flat: 2, alpha: 1, useState: true, color: this.theme.model });
        gl.disable(gl.BLEND);
        gl.enable(gl.DEPTH_TEST);
      }
      if (style !== 'shaded' || !showBody) {
        if (style === 'hiddenVisible' && body.edges) {
          gl.depthFunc(gl.GREATER);
          gl.depthMask(false);
          this.drawSegs(body.edges, vp, viewport, clip, { width: 1, color: [...this.theme.hiddenEdge, 1], dash: 4, useState: showBody, bias: 0 });
          gl.depthMask(true);
          gl.depthFunc(gl.LEQUAL);
        }
        const wire = style === 'wireframe';
        const ec = flat || wire ? this.theme.wire : this.theme.edge;
        if (wire) gl.disable(gl.DEPTH_TEST);
        if (body.edges) this.drawSegs(body.edges, vp, viewport, clip, { width: 1.25, color: [...ec, 1], useState: showBody, bias: 2e-5 });
        // Where the section plane cuts the body, like an edge (line styles show no cap colour).
        const cut = this.sectionOutline(showBody ? this.modelMesh : this.previewMesh);
        if (cut) this.drawSegs(cut, vp, viewport, null, { width: 1.25, color: [...ec, 1], useState: false, bias: 2e-5 });
        if (wire) gl.enable(gl.DEPTH_TEST);
      } else if (body.edges && this.edgeStateData.some((s) => s & 3)) {
        // Shaded mode still shows hovered/selected edges.
        this.drawSegs(body.edges, vp, viewport, clip, { width: 1.25, color: [0, 0, 0, 0], useState: true, bias: 2e-5, onlyStates: true });
      }
    }

    for (const b of ordered(this.lines, 'test')) this.drawLineBatch(b, vp, viewport, clip);
    for (const b of ordered(this.points, 'test')) this.drawPointBatch(b, vp, viewport);

    // Translucent geometry: tool preview and plane fills, without depth writes.
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    if (this.preview && this.previewKind === 'tool') {
      const c = this.previewCut ? this.theme.previewCut : this.theme.preview;
      this.drawMesh(this.preview, vp, view, null, { flat: 0, alpha: 0.5, useState: false, color: c });
      if (this.preview.edges) this.drawSegs(this.preview.edges, vp, viewport, null, { width: 1, color: [c[0] * 0.6, c[1] * 0.6, c[2] * 0.6, 0.9], useState: false, bias: 2e-5 });
    }
    for (const b of ordered(this.tris, 'test')) this.drawTriBatch(b, vp);
    gl.disable(gl.DEPTH_TEST);
    for (const b of ordered(this.tris, 'always')) this.drawTriBatch(b, vp);
    gl.depthMask(true);
    for (const b of ordered(this.lines, 'always')) this.drawLineBatch(b, vp, viewport, null);
    for (const b of ordered(this.points, 'always')) this.drawPointBatch(b, vp, viewport);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
  }

  private cut: { mesh: MeshData; key: string; gpu: GpuSegs | null } | null = null;

  /** Segments where the section plane cuts a mesh, cached until the plane or mesh changes. */
  private sectionOutline(m: MeshData | null): GpuSegs | null {
    const sec = this.section;
    const key = sec ? `${sec.normal.join()},${sec.offset}` : '';
    if (this.cut && this.cut.mesh === m && this.cut.key === key) return this.cut.gpu;
    if (this.cut?.gpu) { this.gl.deleteVertexArray(this.cut.gpu.vao); this.cut.gpu.bufs.forEach((b) => this.gl.deleteBuffer(b)); }
    this.cut = null;
    if (!m || !sec) return null;
    const P = m.positions, I = m.indices, [nx, ny, nz] = sec.normal;
    const d = new Float32Array(P.length / 3);
    for (let i = 0; i < d.length; i++) d[i] = P[i * 3] * nx + P[i * 3 + 1] * ny + P[i * 3 + 2] * nz - sec.offset;
    const out: number[] = [];
    for (let t = 0; t + 2 < I.length; t += 3) {
      let found = 0;
      for (let e = 0; e < 3; e++) {
        const u = I[t + e], v = I[t + ((e + 1) % 3)];
        if (d[u] > 0 === d[v] > 0) continue;
        const k = d[u] / (d[u] - d[v]);
        for (let j = 0; j < 3; j++) out.push(P[u * 3 + j] + k * (P[v * 3 + j] - P[u * 3 + j]));
        found++;
      }
      if (found === 1) out.length -= 3;
    }
    const gpu = out.length ? this.segVao(new Float32Array(out)) : null;
    this.cut = { mesh: m, key, gpu };
    return gpu;
  }

  /** `flat`: 0 shaded, 1 background fill (line styles), 2 only selected/hovered faces, translucent (wireframe). */
  private drawMesh(m: GpuMesh, vp: Float32Array, view: Float32Array, clip: number[] | null, o: { flat: 0 | 1 | 2; alpha: number; useState: boolean; color: number[] }) {
    const gl = this.gl;
    const { p, u } = this.progs.mesh;
    gl.useProgram(p);
    gl.uniformMatrix4fv(u.uViewProj, false, vp);
    gl.uniformMatrix4fv(u.uView, false, view);
    gl.uniform3fv(u.uColor, o.color);
    gl.uniform1f(u.uAlpha, o.alpha);
    gl.uniform1i(u.uUseState, o.useState ? 1 : 0);
    gl.uniform1i(u.uOrtho, this.camera.ortho ? 1 : 0);
    gl.uniform1i(u.uFlat, o.flat);
    gl.uniform3fv(u.uFlatColor, this.theme.background);
    gl.uniform3fv(u.uSelColor, this.theme.selection);
    gl.uniform3fv(u.uHoverColor, this.theme.hover);
    gl.uniform3fv(u.uCapColor, this.theme.cap);
    gl.uniform1i(u.uClipOn, clip ? 1 : 0);
    if (clip) gl.uniform4fv(u.uClip, clip);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.faceState);
    gl.uniform1i(u.uState, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.faceColor);
    gl.uniform1i(u.uFaceColor, 1);
    gl.bindVertexArray(m.vao);
    gl.drawElements(gl.TRIANGLES, m.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  private drawSegs(s: GpuSegs, vp: Float32Array, viewport: number[], clip: number[] | null, o: { width: number; color: number[]; dash?: number; useState: boolean; bias: number; useColor?: boolean; onlyStates?: boolean }) {
    const gl = this.gl;
    const { p, u } = this.progs.seg;
    gl.useProgram(p);
    gl.uniformMatrix4fv(u.uViewProj, false, vp);
    gl.uniform2fv(u.uViewport, viewport);
    gl.uniform1f(u.uWidth, o.width * (o.useState ? 1 : 1));
    gl.uniform1f(u.uDepthBias, o.bias);
    gl.uniform1i(u.uUseColor, o.useColor ? 1 : 0);
    gl.uniform4fv(u.uColor, o.color);
    gl.uniform1i(u.uUseState, o.useState ? 1 : 0);
    gl.uniform3fv(u.uSelColor, this.theme.selection);
    gl.uniform3fv(u.uHoverColor, this.theme.hover);
    gl.uniform1f(u.uDash, o.dash ?? 0);
    gl.uniform1i(u.uClipOn, clip ? 1 : 0);
    if (clip) gl.uniform4fv(u.uClip, clip);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.edgeState);
    gl.uniform1i(u.uState, 0);
    if (o.onlyStates) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }
    // Wider lines for selected/hovered edges are drawn via the state colour.
    gl.bindVertexArray(s.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, s.count);
    gl.bindVertexArray(null);
    if (o.onlyStates) gl.disable(gl.BLEND);
  }

  private drawLineBatch(b: LineBatch & { gpu?: GpuSegs }, vp: Float32Array, viewport: number[], clip: number[] | null) {
    if (!b.gpu) return;
    this.drawSegs(b.gpu, vp, viewport, clip, { width: b.width, color: [0, 0, 0, 1], dash: b.dash, useState: false, bias: b.bias ?? 4e-5, useColor: true });
  }

  private drawPointBatch(b: PointBatch & { gpu?: { vao: WebGLVertexArrayObject; count: number } }, vp: Float32Array, viewport: number[]) {
    if (!b.gpu) return;
    const gl = this.gl;
    const { p, u } = this.progs.pt;
    gl.useProgram(p);
    gl.uniformMatrix4fv(u.uViewProj, false, vp);
    gl.uniform2fv(u.uViewport, viewport);
    gl.uniform1f(u.uDepthBias, 1e-4);
    gl.bindVertexArray(b.gpu.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.gpu.count);
    gl.bindVertexArray(null);
  }

  private drawTriBatch(b: TriBatch & { gpu?: { vao: WebGLVertexArrayObject; count: number } }, vp: Float32Array) {
    if (!b.gpu) return;
    const gl = this.gl;
    const { p, u } = this.progs.tri;
    gl.useProgram(p);
    gl.uniformMatrix4fv(u.uViewProj, false, vp);
    gl.bindVertexArray(b.gpu.vao);
    gl.drawArrays(gl.TRIANGLES, 0, b.gpu.count);
    gl.bindVertexArray(null);
  }

  // ---- picking ----

  private ensurePickTarget() {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    if (this.pickFbo && this.pickSize[0] === w && this.pickSize[1] === h) return;
    if (this.pickFbo) {
      gl.deleteFramebuffer(this.pickFbo);
      gl.deleteTexture(this.pickTex);
      gl.deleteTexture(this.pickDepthTex);
      gl.deleteRenderbuffer(this.pickRb);
    }
    this.pickFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    this.pickTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.pickTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32UI, w, h);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pickTex, 0);
    if (this.canFloat) {
      this.pickDepthTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.pickDepthTex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, w, h);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.pickDepthTex, 0);
    }
    this.pickRb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.pickRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.pickRb);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.pickSize = [w, h];
  }

  /**
   * Draws ids into the offscreen pick target. It never touches the canvas's
   * drawing buffer, and WebGL only presents (or clears) that buffer after
   * draws to it, so a pick needs no redraw of the visible frame.
   */
  private renderPick(x: number, y: number, want: PickWant, radius: number): PickRegion | null {
    const m = this.model;
    if (!m || this.lost) return null;
    const gl = this.gl;
    this.ensurePickTarget();
    const dpr = this.dpr;
    const R = Math.ceil(radius * dpr);
    const size = R * 2 + 1;
    // The device pixel whose area contains the CSS point (GL rows count up).
    const px = Math.floor(x * dpr), py = Math.floor(this.canvas.height - y * dpr);
    if (px < 0 || py < 0 || px >= this.canvas.width || py >= this.canvas.height) return null;
    const x0 = Math.max(0, px - R), y0 = Math.max(0, py - R);
    const w = Math.min(size, this.canvas.width - x0), h = Math.min(size, this.canvas.height - y0);
    if (w <= 0 || h <= 0) return null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.drawBuffers(this.canFloat ? [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1] : [gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x0, y0, w, h);
    gl.clearBufferuiv(gl.COLOR, 0, new Uint32Array([0, 0, 0, 0]));
    if (this.canFloat) gl.clearBufferfv(gl.COLOR, 1, new Float32Array([0, 0, 0, 0]));
    gl.clearBufferfi(gl.DEPTH_STENCIL, 0, 1, 0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    const cam = this.camera;
    const vp = toF32(cam.viewProj());
    const view = toF32(cam.view());
    const viewport = [cam.width, cam.height];
    const clip = this.clipVec();
    const wire = this.displayStyle === 'wireframe';
    // Faces always write depth so hidden edges are not picked (except wireframe).
    if (!wire) {
      const { p, u } = this.progs.pickMesh;
      gl.useProgram(p);
      gl.uniformMatrix4fv(u.uViewProj, false, vp);
      gl.uniformMatrix4fv(u.uView, false, view);
      gl.uniform1i(u.uClipOn, clip ? 1 : 0);
      if (clip) gl.uniform4fv(u.uClip, clip);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.faceState);
      gl.uniform1i(u.uState, 0);
      gl.uniform1i(u.uUseState, 1);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1, 1);
      if (!want.face) gl.colorMask(false, false, false, false);
      gl.bindVertexArray(m.vao);
      gl.drawElements(gl.TRIANGLES, m.indexCount, gl.UNSIGNED_INT, 0);
      gl.colorMask(true, true, true, true);
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }
    if (want.edge && m.edges) {
      const { p, u } = this.progs.pickSeg;
      gl.useProgram(p);
      gl.uniformMatrix4fv(u.uViewProj, false, vp);
      gl.uniformMatrix4fv(u.uView, false, view);
      gl.uniform2fv(u.uViewport, viewport);
      gl.uniform1f(u.uWidth, 7);
      gl.uniform1f(u.uDepthBias, 2e-4);
      gl.uniform1ui(u.uKind, 2);
      gl.uniform1i(u.uClipOn, clip ? 1 : 0);
      if (clip) gl.uniform4fv(u.uClip, clip);
      if (wire) gl.disable(gl.DEPTH_TEST);
      gl.bindVertexArray(m.edges.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, m.edges.count);
      gl.enable(gl.DEPTH_TEST);
    }
    if (want.vertex && m.verts) {
      const { p, u } = this.progs.pickPt;
      gl.useProgram(p);
      gl.uniformMatrix4fv(u.uViewProj, false, vp);
      gl.uniformMatrix4fv(u.uView, false, view);
      gl.uniform2fv(u.uViewport, viewport);
      gl.uniform1f(u.uSize, 11);
      gl.uniform1i(u.uClipOn, clip ? 1 : 0);
      if (clip) gl.uniform4fv(u.uClip, clip);
      gl.bindVertexArray(m.verts.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, m.verts.count);
    }
    gl.bindVertexArray(null);
    return { x0, y0, w, h, px, py };
  }

  /**
   * Picks at CSS pixel (x, y). `want` filters entity kinds; vertices and
   * edges win over faces within `radius` pixels. Reads back synchronously.
   */
  pick(x: number, y: number, want: PickWant = { face: true, edge: true, vertex: true }, radius = 6): PickHit | null {
    const gl = this.gl;
    const r = this.renderPick(x, y, want, radius);
    if (!r) return null;
    const ids = new Uint32Array(r.w * r.h * 4);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(r.x0, r.y0, r.w, r.h, gl.RGBA_INTEGER, gl.UNSIGNED_INT, ids);
    let depths: Float32Array | null = null;
    if (this.canFloat) {
      depths = new Float32Array(r.w * r.h * 4);
      gl.readBuffer(gl.COLOR_ATTACHMENT1);
      gl.readPixels(r.x0, r.y0, r.w, r.h, gl.RGBA, gl.FLOAT, depths);
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.decodePick(ids, depths, r, x, y);
  }

  private pbo: { ids: WebGLBuffer; depth: WebGLBuffer; size: number } | null = null;
  private asyncSeq = 0;

  /**
   * Same as pick() but reads back through pixel-pack buffers and a fence so
   * the CPU never waits for the GPU (used for hover pre-selection).
   * Superseded requests resolve to undefined.
   */
  pickAsync(x: number, y: number, want: PickWant = { face: true, edge: true, vertex: true }, radius = 6): Promise<PickHit | null | undefined> {
    const gl = this.gl;
    const seq = ++this.asyncSeq;
    const r = this.renderPick(x, y, want, radius);
    if (!r) return Promise.resolve(null);
    const bytes = r.w * r.h * 16;
    if (!this.pbo || this.pbo.size < bytes) {
      if (this.pbo) { gl.deleteBuffer(this.pbo.ids); gl.deleteBuffer(this.pbo.depth); }
      const mk = () => { const buf = gl.createBuffer()!; gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf); gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ); return buf; };
      this.pbo = { ids: mk(), depth: mk(), size: bytes };
    }
    const pbo = this.pbo;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo.ids);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(r.x0, r.y0, r.w, r.h, gl.RGBA_INTEGER, gl.UNSIGNED_INT, 0);
    if (this.canFloat) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo.depth);
      gl.readBuffer(gl.COLOR_ATTACHMENT1);
      gl.readPixels(r.x0, r.y0, r.w, r.h, gl.RGBA, gl.FLOAT, 0);
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!;
    gl.flush();
    return new Promise((resolve) => {
      const poll = () => {
        if (seq !== this.asyncSeq || this.lost) { gl.deleteSync(sync); resolve(undefined); return; }
        const st = gl.clientWaitSync(sync, 0, 0);
        if (st === gl.TIMEOUT_EXPIRED) { setTimeout(poll, 1); return; }
        gl.deleteSync(sync);
        const ids = new Uint32Array(r.w * r.h * 4);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo.ids);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, ids);
        let depths: Float32Array | null = null;
        if (this.canFloat) {
          depths = new Float32Array(r.w * r.h * 4);
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo.depth);
          gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, depths);
        }
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        resolve(this.decodePick(ids, depths, r, x, y));
      };
      setTimeout(poll, 0);
    });
  }

  private decodePick(ids: Uint32Array, depths: Float32Array | null, r: PickRegion, x: number, y: number): PickHit | null {
    const { w, h } = r;
    const rank = (k: number) => (k === 3 ? 0 : k === 2 ? 1 : 2);
    // Choose: vertex > edge > face, nearest to the centre.
    let best: { kind: number; idx: number; d: number; depth: number } | null = null;
    const cx = r.px - r.x0, cy = r.py - r.y0;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const v = ids[(j * w + i) * 4];
        if (!v) continue;
        const kind = v >>> 28;
        const idx = v & 0x0fffffff;
        const d = Math.hypot(i - cx, j - cy);
        if (kind === 1 && d > 0.5) continue;
        const pr = rank(kind);
        if (!best || pr < rank(best.kind) || (pr === rank(best.kind) && d < best.d)) best = { kind, idx, d, depth: depths ? depths[(j * w + i) * 4] : 0 };
      }
    }
    if (!best) return null;
    const cam = this.camera;
    const kind: PickKind = best.kind === 1 ? 'face' : best.kind === 2 ? 'edge' : 'vertex';
    let point: Vec3 | null = null;
    // Any depth is valid with a depth target: an orthographic view zoomed in
    // past a face draws it behind the eye, at a negative eye distance.
    if (depths && Number.isFinite(best.depth)) {
      const ray = cam.ray(x, y);
      if (cam.ortho) {
        // Move the ray origin onto the eye plane; depth is measured from it.
        const eye = cam.eye, back = cam.back;
        const s2 = (ray.o[0] - eye[0]) * back[0] + (ray.o[1] - eye[1]) * back[1] + (ray.o[2] - eye[2]) * back[2];
        point = add(add(ray.o, scale(ray.d, s2)), scale(ray.d, best.depth));
      } else point = add(cam.eye, scale(ray.d, best.depth / Math.max(1e-9, -(ray.d[0] * cam.back[0] + ray.d[1] * cam.back[1] + ray.d[2] * cam.back[2]))));
    }
    return { kind, index: best.idx, point };
  }

  get modelFaceCount(): number {
    return this.model?.faceCount ?? 0;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.freeMesh(this.model);
    this.freeMesh(this.preview);
  }
}
