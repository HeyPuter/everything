// Solid shading Cavity (screen space): convex edges (ridges) get lighter and concave ones
// (valleys) darker, found from how the view-space normals change between neighbouring pixels.
import { Color, AddEquation, CustomBlending, DstColorFactor, Mesh, MeshNormalMaterial, NearestFilter, OneFactor, OrthographicCamera, PlaneGeometry, Scene, ShaderMaterial, Vector3, WebGLRenderTarget, ZeroFactor, type Camera, type WebGLRenderer } from 'three';

const normalMaterial = new MeshNormalMaterial();
let target: WebGLRenderTarget | null = null;

const FRAG = /* glsl */ `
  uniform sampler2D tN;
  uniform vec3 uSize;
  uniform float uRidge;
  uniform float uValley;
  uniform int uPass; // 0 darken valleys (multiply), 1 lighten ridges (add)
  varying vec2 vUv;
  vec4 at(vec2 uv) { return texture2D(tN, uv); }
  vec3 nrm(vec4 s, vec3 fallback) { return s.a < 0.5 ? fallback : normalize(s.xyz * 2.0 - 1.0); }
  void main() {
    vec4 c = at(vUv);
    if (c.a < 0.5) discard;
    vec3 n0 = normalize(c.xyz * 2.0 - 1.0);
    // curvature from the normals one and two pixels away (softer than single-pixel edges)
    float curv = 0.0;
    for (int k = 1; k <= 2; k++) {
      vec2 px = float(k) * uSize.z / uSize.xy;
      float cx = nrm(at(vUv + vec2(px.x, 0.0)), n0).x - nrm(at(vUv - vec2(px.x, 0.0)), n0).x;
      float cy = nrm(at(vUv + vec2(0.0, px.y)), n0).y - nrm(at(vUv - vec2(0.0, px.y)), n0).y;
      curv += (cx + cy) * 0.25 / float(k);
    }
    if (uPass == 0) {
      float v = clamp(-curv * uValley * 1.2, 0.0, 0.8);
      if (v < 0.004) discard;
      gl_FragColor = vec4(vec3(1.0 - v), 1.0);
    } else {
      float r = clamp(curv * uRidge * 0.3, 0.0, 0.35);
      if (r < 0.004) discard;
      gl_FragColor = vec4(vec3(r), 1.0);
    }
  }
`;

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

function pass(kind: 0 | 1) {
  return new ShaderMaterial({
    uniforms: { tN: { value: null }, uSize: { value: new Vector3(1, 1, 1) }, uRidge: { value: 1 }, uValley: { value: 1 }, uPass: { value: kind } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    blending: CustomBlending,
    blendEquation: AddEquation,
    // valleys multiply the colour already drawn, ridges add to it
    blendSrc: kind === 0 ? DstColorFactor : OneFactor,
    blendDst: kind === 0 ? ZeroFactor : OneFactor,
  });
}
const darken = pass(0);
const lighten = pass(1);
const quad = new Mesh(new PlaneGeometry(2, 2), darken);
quad.frustumCulled = false;
const quadScene = new Scene();
quadScene.add(quad);
const quadCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

/**
 * Darken valleys / lighten ridges of what `scene` shows (call after the shaded scene was drawn
 * into the viewport rectangle; x, y, w, h in CSS pixels).
 */
export function drawCavity(r: WebGLRenderer, scene: Scene, camera: Camera, rect: { x: number; y: number; w: number; h: number }, dpr: number, ridge: number, valley: number) {
  const W = Math.max(1, Math.round(rect.w * dpr)),
    H = Math.max(1, Math.round(rect.h * dpr));
  if (!target) {
    target = new WebGLRenderTarget(W, H, { minFilter: NearestFilter, magFilter: NearestFilter });
  } else if (target.width !== W || target.height !== H) target.setSize(W, H);
  // view-space normals of the visible surfaces
  const bg = scene.background,
    env = scene.environment,
    over = scene.overrideMaterial;
  scene.background = null;
  scene.environment = null;
  scene.overrideMaterial = normalMaterial;
  const clear = r.getClearColor(new Color()),
    clearA = r.getClearAlpha();
  r.setRenderTarget(target);
  r.setScissorTest(false);
  r.setViewport(0, 0, W / dpr, H / dpr);
  r.setClearColor(0x000000, 0);
  r.clear(true, true, true);
  r.render(scene, camera);
  r.setClearColor(clear, clearA);
  scene.overrideMaterial = over;
  scene.background = bg;
  scene.environment = env;
  r.setRenderTarget(null);
  r.setViewport(rect.x, rect.y, rect.w, rect.h);
  r.setScissor(rect.x, rect.y, rect.w, rect.h);
  r.setScissorTest(true);
  for (const m of [darken, lighten]) {
    m.uniforms.tN.value = target.texture;
    m.uniforms.uSize.value.set(W, H, Math.max(1, Math.round(dpr)));
    m.uniforms.uRidge.value = ridge;
    m.uniforms.uValley.value = valley;
    quad.material = m;
    r.render(quadScene, quadCam);
  }
}
