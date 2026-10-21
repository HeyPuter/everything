// Solid shading Shadow: the scene casts a shadow from a fixed light direction (a shadow map
// rendered along that direction, then the visible surfaces darkened where they are in shadow).
import { Box3, DepthTexture, Matrix4, NearestFilter, OrthographicCamera, ShaderMaterial, Vector3, WebGLRenderTarget, CustomBlending, DstColorFactor, ZeroFactor, AddEquation, MeshBasicMaterial, type Camera, type Scene, type WebGLRenderer } from 'three';
import type { RenderContext } from '../../render/context';

const SIZE = 2048;
let target: WebGLRenderTarget | null = null;
const depthOnly = new MeshBasicMaterial({ colorWrite: false });
const lightCam = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);

const shadowMaterial = new ShaderMaterial({
  uniforms: {
    tDepth: { value: null },
    uLightVP: { value: new Matrix4() },
    uIntensity: { value: 0.5 },
    uBias: { value: 0.002 },
    uTexel: { value: 1 / SIZE },
    uLightDir: { value: new Vector3(0, 0, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec4 vWorld;
    varying vec3 vNormal;
    void main() {
      mat4 m = modelMatrix;
      #ifdef USE_INSTANCING
        m = m * instanceMatrix;
      #endif
      vWorld = m * vec4(position, 1.0);
      vNormal = normalize(mat3(m) * normal);
      gl_Position = projectionMatrix * viewMatrix * vWorld;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDepth;
    uniform mat4 uLightVP;
    uniform float uIntensity;
    uniform float uBias;
    uniform float uTexel;
    uniform vec3 uLightDir;
    varying vec4 vWorld;
    varying vec3 vNormal;
    void main() {
      // surfaces turned away from the light are in their own shadow
      float facing = dot(normalize(vNormal), uLightDir);
      vec4 lp = uLightVP * vWorld;
      vec3 p = lp.xyz / lp.w * 0.5 + 0.5;
      float lit = 1.0;
      if (p.x > 0.0 && p.x < 1.0 && p.y > 0.0 && p.y < 1.0 && p.z < 1.0) {
        float bias = uBias * (1.0 + 4.0 * (1.0 - abs(facing)));
        float sum = 0.0;
        for (int i = -1; i <= 1; i++)
          for (int j = -1; j <= 1; j++) {
            float d = texture2D(tDepth, p.xy + vec2(float(i), float(j)) * uTexel).r;
            sum += p.z - bias > d ? 0.0 : 1.0;
          }
        lit = sum / 9.0;
      }
      if (gl_FrontFacing ? facing <= 0.0 : facing >= 0.0) lit = 0.0;
      float k = uIntensity * (1.0 - lit);
      if (k < 0.004) discard;
      gl_FragColor = vec4(vec3(1.0 - k), 1.0);
    }
  `,
  transparent: true,
  depthWrite: false,
  blending: CustomBlending,
  blendEquation: AddEquation,
  blendSrc: DstColorFactor,
  blendDst: ZeroFactor,
});

/** Bounds of the surfaces the shadow is made of. */
function sceneBounds(ctx: RenderContext): Box3 {
  const box = new Box3();
  for (const so of ctx.sync.objects.values()) {
    if (!so.root.visible || !so.mesh || !so.mesh.visible) continue;
    const g = so.mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    if (g.boundingBox && !g.boundingBox.isEmpty()) box.union(g.boundingBox.clone().applyMatrix4(so.mesh.matrixWorld));
  }
  return box;
}

/**
 * Darken what is in shadow, after the shaded scene was drawn into the viewport rectangle.
 * `dir` points towards the light.
 */
export function drawSolidShadow(r: WebGLRenderer, ctx: RenderContext, scene: Scene, camera: Camera, rect: { x: number; y: number; w: number; h: number }, dir: [number, number, number], intensity: number) {
  const box = sceneBounds(ctx);
  if (box.isEmpty()) return;
  const d = new Vector3(...dir);
  if (d.lengthSq() < 1e-8) return;
  d.normalize();
  if (!target) {
    target = new WebGLRenderTarget(SIZE, SIZE, { minFilter: NearestFilter, magFilter: NearestFilter });
    target.depthTexture = new DepthTexture(SIZE, SIZE);
  }
  // an orthographic camera along the light direction that fits the bounds
  const center = box.getCenter(new Vector3());
  const radius = Math.max(1e-3, box.getSize(new Vector3()).length() / 2);
  lightCam.position.copy(center).addScaledVector(d, radius * 2);
  if (Math.abs(d.z) > 0.99) lightCam.up.set(0, 1, 0);
  else lightCam.up.set(0, 0, 1);
  lightCam.lookAt(center);
  lightCam.left = lightCam.bottom = -radius;
  lightCam.right = lightCam.top = radius;
  lightCam.near = radius * 0.5;
  lightCam.far = radius * 3.5;
  lightCam.updateProjectionMatrix();
  lightCam.updateMatrixWorld();
  // shadow map: the depth of the surfaces seen from the light
  const bg = scene.background,
    env = scene.environment,
    over = scene.overrideMaterial;
  scene.background = null;
  scene.environment = null;
  scene.overrideMaterial = depthOnly;
  r.setRenderTarget(target);
  r.setScissorTest(false);
  r.setViewport(0, 0, SIZE / r.getPixelRatio(), SIZE / r.getPixelRatio());
  r.clear(false, true, false);
  r.render(scene, lightCam);
  r.setRenderTarget(null);
  // darken the visible surfaces that the light does not reach
  const u = shadowMaterial.uniforms;
  u.tDepth.value = target.depthTexture;
  u.uLightVP.value.multiplyMatrices(lightCam.projectionMatrix, lightCam.matrixWorldInverse);
  u.uIntensity.value = Math.max(0, Math.min(1, intensity));
  u.uBias.value = 0.0015;
  u.uTexel.value = 1 / SIZE;
  u.uLightDir.value.copy(d);
  r.setViewport(rect.x, rect.y, rect.w, rect.h);
  r.setScissor(rect.x, rect.y, rect.w, rect.h);
  r.setScissorTest(true);
  scene.overrideMaterial = shadowMaterial;
  r.render(scene, camera);
  scene.overrideMaterial = over;
  scene.background = bg;
  scene.environment = env;
}
