// WebGL2 viewer for meshes from mesh3d.js. Renders on demand only: a frame is
// drawn when the camera, scene, theme or size changes. The camera orbits a
// target with z up.

const VS = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
uniform mat4 uViewProj;
out vec3 vPos;
out vec3 vNormal;
void main() {
  vPos = aPos;
  vNormal = aNormal;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vPos;
in vec3 vNormal;
out vec4 outColor;
uniform vec3 uColor;
uniform float uMetal;
uniform float uRough;
uniform vec3 uCamPos;
uniform vec3 uSky;
uniform vec3 uGround;
uniform vec3 uL0;
uniform vec3 uC0;
uniform vec3 uL1;
uniform vec3 uC1;
uniform float uSide;

vec3 N; vec3 V; vec3 diff; vec3 F0; float shin;

vec3 light(vec3 L, vec3 C) {
  float ndl = max(dot(N, L), 0.0);
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), shin) * (shin + 8.0) / 25.13;
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - max(dot(H, V), 0.0), 5.0);
  return C * ndl * (diff + F * spec);
}

void main() {
  N = normalize(vNormal);
  V = normalize(uCamPos - vPos);
  if (dot(N, V) < 0.0) N = -N;
  diff = uColor * (1.0 - uMetal);
  F0 = mix(vec3(0.04), uColor, uMetal);
  shin = exp2(mix(10.0, 2.0, uRough));
  float hemi = 0.5 + 0.5 * N.z * uSide;
  vec3 col = mix(uGround, uSky, hemi) * (diff + F0 * 0.6);
  col += light(uL0, uC0) + light(uL1, uC1);
  outColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}`;

const THEMES = {
  dark: { bg: '#1c1d20', sky: [0.42, 0.44, 0.48], ground: [0.12, 0.12, 0.13] },
  light: { bg: '#e6e7ea', sky: [0.55, 0.56, 0.6], ground: [0.2, 0.2, 0.21] },
};

const FOV = (35 * Math.PI) / 180;
const DEG = Math.PI / 180;
const VIEWS = {
  top: { yaw: -90, pitch: 89.5 },
  // Seen from below with the board turned over left to right, so bottom
  // silkscreen reads the right way round (as in KiCad and Altium).
  bottom: { yaw: 90, pitch: -89.5 },
  front: { yaw: -90, pitch: 8 },
  iso: { yaw: -60, pitch: 35 },
};

const toLinear = (c) => c.map((v) => Math.pow(v, 2.2));

function hexRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// Column-major 4x4 matrix helpers.
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function normalize(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

function lookAt(eye, target, up) {
  const z = normalize(sub(eye, target));
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}

function multiply(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}

function invert(m) {
  const inv = new Float64Array(16);
  inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
  inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
  inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
  inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
  inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
  inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
  inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
  inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
  inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
  inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
  inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
  inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
  inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
  inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
  inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
  inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
  const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
  if (!det) return null;
  for (let k = 0; k < 16; k++) inv[k] /= det;
  return inv;
}

function transformPoint(m, x, y, z) {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w, (m[2] * x + m[6] * y + m[10] * z + m[14]) / w];
}

const ease = (t) => 1 - Math.pow(1 - t, 3);
const clampPitch = (p) => Math.max(-89.5, Math.min(89.5, p));
const lerpAngle = (a, b, t) => a + ((((b - a) % 360) + 540) % 360 - 180) * t;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(`Shader compile failed: ${log}`);
  }
  return s;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{background?: string, theme?: 'light'|'dark'}} [opts]
 */
export function createViewer3D(canvas, opts = {}) {
  let gl = null;
  try {
    gl = canvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  } catch { gl = null; }

  let theme = opts.theme === 'light' ? 'light' : 'dark';
  let scene = null;
  let gpu = { program: null, uniforms: null, meshes: [] };
  let lost = false;
  let rafId = 0;
  let anim = null;
  let disposed = false;
  const cam = { target: [0, 0, 0], dist: 100, yaw: VIEWS.iso.yaw, pitch: VIEWS.iso.pitch };
  let viewProj = null;
  let eye = [0, 0, 0];
  const listeners = [];
  let ro = null;

  const supported = !!gl;

  const on = (el, type, fn, o) => { el.addEventListener(type, fn, o); listeners.push([el, type, fn, o]); };

  function initGL() {
    const vs = compile(gl, gl.VERTEX_SHADER, VS);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FS);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`);
    const u = {};
    for (const name of ['uViewProj', 'uColor', 'uMetal', 'uRough', 'uCamPos', 'uSky', 'uGround', 'uL0', 'uC0', 'uL1', 'uC1', 'uSide']) u[name] = gl.getUniformLocation(program, name);
    gpu.program = program;
    gpu.uniforms = u;
  }

  function freeMeshes() {
    if (!gl) return;
    for (const m of gpu.meshes) {
      gl.deleteVertexArray(m.vao);
      for (const b of m.buffers) gl.deleteBuffer(b);
    }
    gpu.meshes = [];
  }

  function upload() {
    freeMeshes();
    if (!scene || lost) return;
    for (const mesh of scene.meshes) {
      if (!mesh.indices.length) continue;
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const pos = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, pos);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      const nrm = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, nrm);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
      const idx = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      gpu.meshes.push({
        vao, buffers: [pos, nrm, idx], count: mesh.indices.length,
        color: toLinear(mesh.color), metal: mesh.metal || 0, rough: mesh.roughness ?? 0.6,
      });
    }
  }

  function sceneRadius() {
    if (!scene) return 50;
    const { min, max } = scene.bounds;
    return Math.max(Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2, 1);
  }

  function sceneCenter() {
    if (!scene) return [0, 0, 0];
    const { min, max } = scene.bounds;
    return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  }

  function size() {
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round((canvas.clientWidth || canvas.width || 1) * dpr));
    const h = Math.max(1, Math.round((canvas.clientHeight || canvas.height || 1) * dpr));
    return { w, h, dpr };
  }

  function updateMatrices() {
    const { w, h } = size();
    const yaw = cam.yaw * DEG, pitch = cam.pitch * DEG;
    eye = [
      cam.target[0] + cam.dist * Math.cos(pitch) * Math.cos(yaw),
      cam.target[1] + cam.dist * Math.cos(pitch) * Math.sin(yaw),
      cam.target[2] + cam.dist * Math.sin(pitch),
    ];
    const r = sceneRadius();
    const near = Math.max(cam.dist * 0.01, 0.01);
    const far = cam.dist + r * 4 + 10;
    viewProj = multiply(perspective(FOV, w / h, near, far), lookAt(eye, cam.target, [0, 0, 1]));
  }

  function draw() {
    rafId = 0;
    if (!gl || lost || disposed) return;
    if (anim) stepAnim(performance.now());
    const { w, h } = size();
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    updateMatrices();
    const t = THEMES[theme];
    const bg = hexRgb(opts.background || t.bg);
    gl.viewport(0, 0, w, h);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!gpu.meshes.length) return;
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(gpu.program);
    const u = gpu.uniforms;
    gl.uniformMatrix4fv(u.uViewProj, false, viewProj);
    gl.uniform3fv(u.uCamPos, eye);
    gl.uniform3fv(u.uSky, toLinear(t.sky));
    gl.uniform3fv(u.uGround, toLinear(t.ground));
    // Key light and sky follow the camera loosely so the visible side is
    // always lit: from below the board they come from below, blending
    // smoothly while the camera passes the board's edge.
    const yaw = (cam.yaw + 35) * DEG;
    const side = Math.max(-1, Math.min(1, cam.pitch / 8));
    gl.uniform1f(u.uSide, side);
    gl.uniform3fv(u.uL0, normalize([Math.cos(yaw) * 0.6, Math.sin(yaw) * 0.6, 0.8 * side]));
    gl.uniform3fv(u.uC0, [1.05, 1.0, 0.95]);
    gl.uniform3fv(u.uL1, normalize([-Math.cos(yaw) * 0.5, -Math.sin(yaw) * 0.5, -0.4 * side]));
    gl.uniform3fv(u.uC1, [0.3, 0.32, 0.36]);
    for (const m of gpu.meshes) {
      gl.uniform3fv(u.uColor, m.color);
      gl.uniform1f(u.uMetal, m.metal);
      gl.uniform1f(u.uRough, m.rough);
      gl.bindVertexArray(m.vao);
      gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_INT, 0);
    }
    gl.bindVertexArray(null);
    if (anim) request();
  }

  function request() {
    if (!rafId && !disposed && gl) rafId = requestAnimationFrame(draw);
  }

  function animateTo(goal, ms = 200) {
    if (ms <= 0) {
      Object.assign(cam, { target: goal.target.slice(), dist: goal.dist, yaw: goal.yaw, pitch: goal.pitch });
      anim = null;
      request();
      return;
    }
    anim = { from: { target: cam.target.slice(), dist: cam.dist, yaw: cam.yaw, pitch: cam.pitch }, to: goal, start: performance.now(), ms };
    request();
  }

  function stepAnim(now) {
    const k = Math.min(1, (now - anim.start) / anim.ms);
    const e = ease(k);
    const { from, to } = anim;
    cam.target = from.target.map((v, i) => v + (to.target[i] - v) * e);
    cam.dist = from.dist * Math.pow(to.dist / from.dist, e);
    cam.yaw = lerpAngle(from.yaw, to.yaw, e);
    cam.pitch = from.pitch + (to.pitch - from.pitch) * e;
    if (k >= 1) anim = null;
  }

  function fitGoal(view) {
    const v = view ? VIEWS[view] : { yaw: cam.yaw, pitch: cam.pitch };
    const { w, h } = size();
    const aspect = w / h;
    const halfFov = Math.min(FOV / 2, Math.atan(Math.tan(FOV / 2) * aspect));
    return { target: sceneCenter(), dist: (sceneRadius() / Math.sin(halfFov)) * 1.08, yaw: v.yaw, pitch: v.pitch };
  }

  function cancelAnim() { anim = null; }

  // Picks the world point under a canvas position on the board mid plane.
  function pickPlane(clientX, clientY) {
    updateMatrices();
    const rect = canvas.getBoundingClientRect();
    const nx = ((clientX - rect.left) / (rect.width || 1)) * 2 - 1;
    const ny = 1 - ((clientY - rect.top) / (rect.height || 1)) * 2;
    const inv = invert(viewProj);
    if (!inv) return null;
    const a = transformPoint(inv, nx, ny, -1), b = transformPoint(inv, nx, ny, 1);
    const z = scene ? (scene.thickness || 0) / 2 : 0;
    const dz = b[2] - a[2];
    if (Math.abs(dz) < 1e-9) return null;
    const t = (z - a[2]) / dz;
    if (t < 0) return null;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, z];
  }

  function zoomAt(factor, clientX, clientY) {
    cancelAnim();
    const r = sceneRadius();
    const next = Math.max(r * 0.02, Math.min(r * 40, cam.dist * factor));
    const hit = clientX !== undefined ? pickPlane(clientX, clientY) : null;
    if (hit) {
      const k = 1 - next / cam.dist;
      cam.target = cam.target.map((v, i) => v + (hit[i] - v) * k);
    }
    cam.dist = next;
    request();
  }

  function orbit(dx, dy) {
    cancelAnim();
    cam.yaw -= dx * 0.4;
    cam.pitch = clampPitch(cam.pitch + dy * 0.4);
    request();
  }

  function pan(dx, dy) {
    cancelAnim();
    const { h, dpr } = size();
    const perPx = (2 * cam.dist * Math.tan(FOV / 2)) / (h / dpr);
    const yaw = cam.yaw * DEG, pitch = cam.pitch * DEG;
    const fwd = [-Math.cos(pitch) * Math.cos(yaw), -Math.cos(pitch) * Math.sin(yaw), -Math.sin(pitch)];
    const right = normalize(cross(fwd, [0, 0, 1]));
    const up = cross(right, fwd);
    cam.target = cam.target.map((v, i) => v - right[i] * dx * perPx + up[i] * dy * perPx);
    request();
  }

  // Input handling.
  const pointers = new Map();
  let mode = null;
  let pinch = null;

  function onPointerDown(e) {
    if (!supported) return;
    canvas.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (e.pointerType === 'touch') {
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        mode = 'pinch';
      } else mode = 'orbit';
    } else {
      mode = e.button === 2 || e.button === 1 || (e.button === 0 && e.shiftKey) ? 'pan' : e.button === 0 ? 'orbit' : null;
    }
    e.preventDefault();
  }

  function onPointerMove(e) {
    const p = pointers.get(e.pointerId);
    if (!p || !mode) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (mode === 'pinch' && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (pinch.d > 0 && d > 0) zoomAt(pinch.d / d, mx, my);
      pan(mx - pinch.mx, my - pinch.my);
      pinch = { d, mx, my };
    } else if (mode === 'orbit') orbit(dx, dy);
    else if (mode === 'pan') pan(dx, dy);
  }

  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    canvas.releasePointerCapture?.(e.pointerId);
    if (pointers.size === 1 && mode === 'pinch') mode = 'orbit';
    else if (!pointers.size) { mode = null; pinch = null; }
  }

  function onWheel(e) {
    e.preventDefault();
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    zoomAt(Math.exp(e.deltaY * scale * 0.0015), e.clientX, e.clientY);
  }

  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft': orbit(-25, 0); break;
      case 'ArrowRight': orbit(25, 0); break;
      case 'ArrowUp': orbit(0, 25); break;
      case 'ArrowDown': orbit(0, -25); break;
      case '+': case '=': zoomAt(0.8); break;
      case '-': case '_': zoomAt(1.25); break;
      case '0': case 'Home': api.fit(); break;
      case 't': case 'T': api.setView('top'); break;
      case 'b': case 'B': api.setView('bottom'); break;
      case 'f': case 'F': api.setView('front'); break;
      case 'i': case 'I': api.setView('iso'); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  }

  function onLost(e) { e.preventDefault(); lost = true; gpu.meshes = []; gpu.program = null; }
  function onRestored() {
    lost = false;
    try { initGL(); upload(); } catch { /* stays blank */ }
    request();
  }

  if (supported) {
    try { initGL(); } catch { gl = null; }
  }

  if (gl) {
    if (!canvas.hasAttribute('tabindex')) canvas.tabIndex = 0;
    on(canvas, 'pointerdown', onPointerDown);
    on(canvas, 'pointermove', onPointerMove);
    on(canvas, 'pointerup', onPointerUp);
    on(canvas, 'pointercancel', onPointerUp);
    on(canvas, 'wheel', onWheel, { passive: false });
    on(canvas, 'contextmenu', (e) => e.preventDefault());
    on(canvas, 'dblclick', () => api.fit());
    on(canvas, 'keydown', onKey);
    on(canvas, 'webglcontextlost', onLost);
    on(canvas, 'webglcontextrestored', onRestored);
    canvas.style.touchAction = 'none';
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => request());
      ro.observe(canvas);
    }
  }

  const api = {
    get supported() { return !!gl; },

    setScene(next) {
      const first = !scene;
      scene = next;
      if (!gl) return;
      upload();
      if (first) animateTo(fitGoal('iso'), 0);
      else request();
    },

    setTheme(next) {
      theme = next === 'light' ? 'light' : 'dark';
      request();
    },

    resize() { request(); },

    setView(view) {
      if (!VIEWS[view]) return;
      animateTo(fitGoal(view));
    },

    fit() { animateTo(fitGoal()); },

    render() {
      if (!gl) return;
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      draw();
    },

    /** Current camera, for persistence and tests. */
    get camera() { return { target: cam.target.slice(), dist: cam.dist, yaw: cam.yaw, pitch: cam.pitch }; },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      for (const [el, type, fn, o] of listeners) el.removeEventListener(type, fn, o);
      listeners.length = 0;
      ro?.disconnect();
      if (gl && !lost) {
        freeMeshes();
        if (gpu.program) gl.deleteProgram(gpu.program);
      }
      gpu = { program: null, uniforms: null, meshes: [] };
      scene = null;
    },
  };

  return api;
}
