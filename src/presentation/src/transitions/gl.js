// A small WebGL renderer for the transitions that move slides in depth:
// textured meshes, each vertex placed by the effect every frame, seen through
// a fixed perspective camera so that the slide plane at z = 0 exactly fills
// the view.
//
// World space: x runs from -aspect to +aspect (left to right), y from -1 to 1
// (bottom to top), z towards the viewer. Texture space: u from 0 to 1 (left to
// right) and v from 0 to 1 (top to bottom) across a slide picture.

const VERTEX = `
attribute vec3 position;
attribute vec2 uv;
attribute float shade;
uniform float aspect;
uniform float distance;
varying vec2 vUv;
varying float vShade;
void main() {
  float w = distance - position.z;
  gl_Position = vec4(position.x / aspect * distance, position.y * distance,
    -position.z * 0.02 * w, w);
  vUv = uv;
  vShade = shade;
}`;
const FRAGMENT = `
precision mediump float;
uniform sampler2D image;
uniform float alpha;
uniform float tint;
varying vec2 vUv;
varying float vShade;
void main() {
  vec4 color = texture2D(image, vUv);
  vec3 rgb = mix(color.rgb, vec3(color.a), tint) * vShade;
  gl_FragColor = vec4(rgb, color.a) * alpha;
}`;

/** The camera's distance from the slide plane, in slide half-heights. */
export const CAMERA = 3.2;

export function createGl(canvas) {
  let gl;
  try {
    gl = canvas.getContext("webgl", {
      premultipliedAlpha: true,
      alpha: false,
      antialias: true,
      preserveDrawingBuffer: false,
    });
  } catch {
    gl = null;
  }
  if (!gl) return null;
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(shader) || "shader");
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);
  const loc = {
    position: gl.getAttribLocation(program, "position"),
    uv: gl.getAttribLocation(program, "uv"),
    shade: gl.getAttribLocation(program, "shade"),
    aspect: gl.getUniformLocation(program, "aspect"),
    distance: gl.getUniformLocation(program, "distance"),
    alpha: gl.getUniformLocation(program, "alpha"),
    tint: gl.getUniformLocation(program, "tint"),
    image: gl.getUniformLocation(program, "image"),
  };
  const buffers = {
    position: gl.createBuffer(),
    uv: gl.createBuffer(),
    shade: gl.createBuffer(),
  };
  for (const name of ["position", "uv", "shade"])
    gl.enableVertexAttribArray(loc[name]);
  gl.uniform1i(loc.image, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.depthFunc(gl.LEQUAL);
  // Grids run u right and v down, so their triangles wind clockwise.
  gl.frontFace(gl.CW);
  let aspect = 16 / 9;
  const textures = new Map();

  function texture(source) {
    let t = textures.get(source);
    if (t) return t;
    t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    // Throws for a picture the page may not read; the caller falls back.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    textures.set(source, t);
    return t;
  }

  function begin(width, height, background = [0, 0, 0]) {
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    aspect = width / height;
    gl.viewport(0, 0, width, height);
    gl.uniform1f(loc.aspect, aspect);
    gl.uniform1f(loc.distance, CAMERA);
    gl.clearColor(background[0], background[1], background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  // Draws triangles: positions (xyz), uvs (uv) and shades, one per vertex.
  function triangles(source, positions, uvs, shades, options = {}) {
    const { alpha = 1, depth = false, cull = null, tint = 0 } = options;
    if (alpha <= 0 || !positions.length) return;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture(source));
    gl.uniform1f(loc.alpha, Math.min(1, alpha));
    gl.uniform1f(loc.tint, tint);
    if (depth) gl.enable(gl.DEPTH_TEST);
    else gl.disable(gl.DEPTH_TEST);
    if (cull) {
      gl.enable(gl.CULL_FACE);
      gl.cullFace(cull === "front" ? gl.FRONT : gl.BACK);
    } else gl.disable(gl.CULL_FACE);
    const upload = (name, data, size) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers[name]);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
      gl.vertexAttribPointer(loc[name], size, gl.FLOAT, false, 0, 0);
    };
    upload("position", positions, 3);
    upload("uv", uvs, 2);
    upload("shade", shades, 1);
    gl.drawArrays(gl.TRIANGLES, 0, positions.length / 3);
  }

  /**
   * Draws a deformed slide (or part of one) as a grid. `place(u, v)` returns
   * the world position [x, y, z] of the picture point (u, v); `uv` limits the
   * part of the picture drawn and `mapUv` can remap what is sampled.
   */
  function grid(source, place, options = {}) {
    const {
      cols = 24,
      rows = 14,
      uv = [0, 0, 1, 1],
      light = 1,
      mapUv = null,
    } = options;
    const [u0, v0, u1, v1] = uv;
    const points = new Float32Array((cols + 1) * (rows + 1) * 3);
    for (let j = 0; j <= rows; j++)
      for (let i = 0; i <= cols; i++) {
        const p = place(
          u0 + ((u1 - u0) * i) / cols,
          v0 + ((v1 - v0) * j) / rows,
        );
        const k = (j * (cols + 1) + i) * 3;
        points[k] = p[0];
        points[k + 1] = p[1];
        points[k + 2] = p[2];
      }
    // Light each vertex by how squarely its surface faces the viewer.
    const shadeAt = new Float32Array((cols + 1) * (rows + 1));
    for (let j = 0; j <= rows; j++)
      for (let i = 0; i <= cols; i++) {
        const at = (ii, jj) => (jj * (cols + 1) + ii) * 3;
        const a = at(Math.max(0, i - 1), j),
          b = at(Math.min(cols, i + 1), j);
        const c = at(i, Math.max(0, j - 1)),
          d = at(i, Math.min(rows, j + 1));
        const du = [
          points[b] - points[a],
          points[b + 1] - points[a + 1],
          points[b + 2] - points[a + 2],
        ];
        const dv = [
          points[d] - points[c],
          points[d + 1] - points[c + 1],
          points[d + 2] - points[c + 2],
        ];
        const n = [
          du[1] * dv[2] - du[2] * dv[1],
          du[2] * dv[0] - du[0] * dv[2],
          du[0] * dv[1] - du[1] * dv[0],
        ];
        const length = Math.hypot(n[0], n[1], n[2]) || 1;
        const facing = Math.abs(n[2] / length);
        // A soft key light from the upper left adds shape to curls.
        const side = (-n[0] * 0.35 + n[1] * 0.3) / length;
        shadeAt[j * (cols + 1) + i] = Math.max(
          0.18,
          Math.min(1.08, (0.42 + 0.58 * facing - side * 0.18) * light),
        );
      }
    const count = cols * rows * 6;
    const positions = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);
    const shades = new Float32Array(count);
    let n = 0;
    const push = (i, j) => {
      const k = j * (cols + 1) + i;
      positions[n * 3] = points[k * 3];
      positions[n * 3 + 1] = points[k * 3 + 1];
      positions[n * 3 + 2] = points[k * 3 + 2];
      let u = u0 + ((u1 - u0) * i) / cols,
        v = v0 + ((v1 - v0) * j) / rows;
      if (mapUv) [u, v] = mapUv(u, v);
      uvs[n * 2] = u;
      uvs[n * 2 + 1] = v;
      shades[n] = shadeAt[k];
      n++;
    };
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        push(i, j);
        push(i + 1, j);
        push(i, j + 1);
        push(i + 1, j);
        push(i + 1, j + 1);
        push(i, j + 1);
      }
    triangles(source, positions, uvs, shades, options);
  }

  /** Flat slide point for (u, v). */
  const flat = (u, v) => [(2 * u - 1) * aspect, 1 - 2 * v, 0];

  function dispose() {
    for (const t of textures.values()) gl.deleteTexture(t);
    textures.clear();
    for (const b of Object.values(buffers)) gl.deleteBuffer(b);
    gl.deleteProgram(program);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  return {
    gl,
    begin,
    grid,
    triangles,
    texture,
    flat,
    get aspect() {
      return aspect;
    },
    dispose,
  };
}

// Rotation helpers on [x, y, z] points.
export const rotateY = ([x, y, z], angle, cx = 0, cz = 0) => {
  const c = Math.cos(angle),
    s = Math.sin(angle);
  const dx = x - cx,
    dz = z - cz;
  return [cx + dx * c + dz * s, y, cz - dx * s + dz * c];
};
export const rotateX = ([x, y, z], angle, cy = 0, cz = 0) => {
  const c = Math.cos(angle),
    s = Math.sin(angle);
  const dy = y - cy,
    dz = z - cz;
  return [x, cy + dy * c - dz * s, cz + dy * s + dz * c];
};
export const rotateZ = ([x, y, z], angle, cx = 0, cy = 0) => {
  const c = Math.cos(angle),
    s = Math.sin(angle);
  const dx = x - cx,
    dy = y - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c, z];
};
