// Shading ▸ Depth of Field: in camera view the shaded scene is blurred by the camera's depth of
// field (circle of confusion from aperture, focal length and focus distance, per pixel depth).
import { Color, FramebufferTexture, Mesh, MeshDepthMaterial, NearestFilter, LinearFilter, OrthographicCamera, PerspectiveCamera, PlaneGeometry, RGBADepthPacking, Scene, ShaderMaterial, Vector2, WebGLRenderTarget, type Camera, type WebGLRenderer } from 'three';

/** Circle of confusion diameter in sensor units for an object at `depth` (all distances in meters). */
export function circleOfConfusion(depth: number, focus: number, focalLength: number, apertureRadius: number): number {
  const f = focalLength,
    S = Math.max(focus, f * 1.0001),
    D = Math.max(depth, 1e-4);
  return Math.abs((2 * apertureRadius * f * (D - S)) / (D * (S - f)));
}

const depthMaterial = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
let depthTarget: WebGLRenderTarget | null = null;
let colorTex: FramebufferTexture | null = null;

const blurMaterial = new ShaderMaterial({
  uniforms: {
    tColor: { value: null },
    tDepth: { value: null },
    uNear: { value: 0.1 },
    uFar: { value: 100 },
    uFocus: { value: 10 },
    uScale: { value: 1 },
    uMaxR: { value: 16 },
    uSize: { value: new Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    #include <packing>
    uniform sampler2D tColor;
    uniform sampler2D tDepth;
    uniform float uNear;
    uniform float uFar;
    uniform float uFocus;
    uniform float uScale; // pixels of blur radius per unit of (1/focus - 1/depth)
    uniform float uMaxR;
    uniform vec2 uSize;
    varying vec2 vUv;
    float depthAt(vec2 uv) {
      float d = unpackRGBAToDepth(texture2D(tDepth, uv));
      if (d >= 0.9999) return uFar;
      return -perspectiveDepthToViewZ(d, uNear, uFar);
    }
    float cocAt(vec2 uv) {
      float z = depthAt(uv);
      return clamp(abs(1.0 / uFocus - 1.0 / z) * uScale, 0.0, uMaxR);
    }
    void main() {
      float c0 = cocAt(vUv);
      vec3 sum = texture2D(tColor, vUv).rgb;
      float wsum = 1.0;
      // golden angle spiral of samples out to the largest radius
      const int N = 48;
      for (int i = 1; i < N; i++) {
        float t = float(i) / float(N);
        float r = sqrt(t) * uMaxR;
        float a = float(i) * 2.39996323;
        vec2 o = vec2(cos(a), sin(a)) * r / uSize;
        float cs = cocAt(vUv + o);
        // a sample contributes when its own blur (or ours, for pixels in front) reaches this pixel
        float reach = min(cs, c0 + 1.0);
        float w = smoothstep(r - 1.0, r + 1.0, max(reach, 0.0));
        sum += texture2D(tColor, vUv + o).rgb * w;
        wsum += w;
      }
      gl_FragColor = vec4(sum / wsum, 1.0);
    }
  `,
  depthTest: false,
  depthWrite: false,
});
const quad = new Mesh(new PlaneGeometry(2, 2), blurMaterial);
quad.frustumCulled = false;
const quadScene = new Scene();
quadScene.add(quad);
const quadCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

/**
 * Blur the scene already drawn into the viewport rectangle (CSS px; `canvasH` is the canvas
 * height in CSS px) as the camera would focus it.
 */
export function drawViewportDof(r: WebGLRenderer, scene: Scene, camera: Camera, rect: { x: number; y: number; w: number; h: number }, dpr: number, p: { focus: number; lens: number; sensor: number; fstop: number }) {
  if (!(camera as PerspectiveCamera).isPerspectiveCamera) return;
  const cam = camera as PerspectiveCamera;
  const W = Math.max(1, Math.round(rect.w * dpr)),
    H = Math.max(1, Math.round(rect.h * dpr));
  // blur radius in pixels = CoC (sensor mm) / sensor width (mm) * image width (px) / 2
  const f = p.lens / 1000;
  const aperture = f / Math.max(0.1, p.fstop) / 2;
  const S = Math.max(p.focus, f * 1.0001);
  const scale = ((aperture * f * S) / (S - f) / (p.sensor / 1000)) * W;
  if (!(scale > 0.05)) return;
  if (!colorTex || colorTex.image.width !== W || colorTex.image.height !== H) {
    colorTex?.dispose();
    colorTex = new FramebufferTexture(W, H);
    colorTex.minFilter = colorTex.magFilter = LinearFilter;
  }
  r.copyFramebufferToTexture(colorTex, new Vector2(Math.round(rect.x * dpr), Math.round(rect.y * dpr)));
  if (!depthTarget) depthTarget = new WebGLRenderTarget(W, H, { minFilter: NearestFilter, magFilter: NearestFilter });
  else if (depthTarget.width !== W || depthTarget.height !== H) depthTarget.setSize(W, H);
  const bg = scene.background,
    env = scene.environment,
    over = scene.overrideMaterial;
  scene.background = null;
  scene.environment = null;
  scene.overrideMaterial = depthMaterial;
  r.setRenderTarget(depthTarget);
  r.setScissorTest(false);
  r.setViewport(0, 0, W / dpr, H / dpr);
  const clear = r.getClearColor(new Color()),
    clearA = r.getClearAlpha();
  // nothing drawn = far away
  r.setClearColor(0xffffff, 1);
  r.clear(true, true, true);
  r.render(scene, camera);
  r.setClearColor(clear, clearA);
  scene.overrideMaterial = over;
  scene.background = bg;
  scene.environment = env;
  r.setRenderTarget(null);
  const u = blurMaterial.uniforms;
  u.tColor.value = colorTex;
  u.tDepth.value = depthTarget.texture;
  u.uNear.value = cam.near;
  u.uFar.value = cam.far;
  u.uFocus.value = S;
  u.uScale.value = scale;
  u.uMaxR.value = Math.min(24, 12 * dpr);
  u.uSize.value.set(W, H);
  r.setViewport(rect.x, rect.y, rect.w, rect.h);
  r.setScissor(rect.x, rect.y, rect.w, rect.h);
  r.setScissorTest(true);
  r.render(quadScene, quadCam);
}
