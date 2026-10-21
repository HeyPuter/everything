// Solid shading "Outline": a thin line in one colour around every object, found from the
// viewport's ID buffer (pixels whose neighbour belongs to another object or to the background).
import { Color, DataTexture, Mesh, NearestFilter, OrthographicCamera, PlaneGeometry, RedFormat, Scene, ShaderMaterial, UnsignedByteType, Vector3, type Texture, type WebGLRenderer } from 'three';

/** Which object indices get an outline (surfaces only, not wires or helper lines). */
const maskData = new Uint8Array(4096 * 64);
const maskTex = new DataTexture(maskData, 4096, 64, RedFormat, UnsignedByteType);
maskTex.minFilter = maskTex.magFilter = NearestFilter;

const material = new ShaderMaterial({
  uniforms: {
    tId: { value: null as Texture | null },
    tMask: { value: maskTex },
    uSize: { value: new Vector3(1, 1, 1) },
    uColor: { value: new Color(0, 0, 0) },
    uWidth: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tId;
    uniform sampler2D tMask;
    uniform vec3 uSize;
    uniform vec3 uColor;
    uniform float uWidth;
    varying vec2 vUv;
    float idAt(vec2 uv) {
      vec4 c = texture2D(tId, uv);
      return floor(c.r * 255.0 + 0.5) + floor(c.g * 255.0 + 0.5) * 256.0 + floor(c.b * 255.0 + 0.5) * 65536.0;
    }
    float outlined(float id) {
      float i = id - 1.0;
      float w = 4096.0;
      return texture2D(tMask, vec2((mod(i, w) + 0.5) / w, (floor(i / w) + 0.5) / 64.0)).r;
    }
    void main() {
      vec2 px = uWidth / uSize.xy;
      float c = idAt(vUv);
      // drawn on the object side of each silhouette, and on the nearer object between two objects
      if (c < 0.5 || outlined(c) < 0.5) discard;
      float edge = 0.0;
      edge = max(edge, float(idAt(vUv + vec2(px.x, 0.0)) != c));
      edge = max(edge, float(idAt(vUv - vec2(px.x, 0.0)) != c));
      edge = max(edge, float(idAt(vUv + vec2(0.0, px.y)) != c));
      edge = max(edge, float(idAt(vUv - vec2(0.0, px.y)) != c));
      if (edge < 0.5) discard;
      gl_FragColor = vec4(uColor, 1.0);
      #include <colorspace_fragment>
    }
  `,
  depthTest: false,
  depthWrite: false,
  transparent: true,
});

const quad = new Mesh(new PlaneGeometry(2, 2), material);
quad.frustumCulled = false;
const scene = new Scene();
scene.add(quad);
const cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

/** Draw the object outlines over the viewport rectangle (CSS px) from an ID texture of W×H pixels; `ids` are the outlined objects' ID-pass indices. */
export function drawObjectOutlines(r: WebGLRenderer, ids: Iterable<number>, idTexture: Texture, W: number, H: number, rect: { x: number; y: number; w: number; h: number }, color: [number, number, number], dpr: number) {
  maskData.fill(0);
  for (const i of ids) if (i >= 0 && i < maskData.length) maskData[i] = 255;
  maskTex.needsUpdate = true;
  const u = material.uniforms;
  u.tId.value = idTexture;
  u.uSize.value.set(W, H, 1);
  // the shading colour is a display colour
  u.uColor.value.setRGB(color[0], color[1], color[2]).convertSRGBToLinear();
  u.uWidth.value = Math.max(1, Math.round(dpr * 0.75));
  r.setRenderTarget(null);
  r.setViewport(rect.x, rect.y, rect.w, rect.h);
  r.setScissor(rect.x, rect.y, rect.w, rect.h);
  r.setScissorTest(true);
  r.render(scene, cam);
}
