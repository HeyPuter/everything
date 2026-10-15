// Infinite editor grid with adaptive subdivisions and colored axis lines.
import { Mesh, PlaneGeometry, ShaderMaterial, Color, DoubleSide, Vector3, SRGBColorSpace } from 'three';

export function createGrid() {
  const mat = new ShaderMaterial({
    uniforms: {
      uColor: { value: new Color(0.329, 0.329, 0.329) },
      // theme axis colors (sRGB) at the viewport's axis intensity; the shader works in linear space
      uAxisX: { value: new Color().setRGB(0.85, 0.17, 0.274, SRGBColorSpace) },
      uAxisY: { value: new Color().setRGB(0.463, 0.734, 0.0, SRGBColorSpace) },
      uAxisZ: { value: new Color().setRGB(0.133, 0.48, 0.85, SRGBColorSpace) },
      uScale: { value: 1.0 },
      uFade: { value: 60.0 },
      uPlane: { value: 0 }, // 0 xy, 1 xz, 2 yz
      uCam: { value: new Vector3() },
      uOrtho: { value: 0 },
      uShowAxes: { value: new Vector3(1, 1, 0) },
      uShowFloor: { value: 1 },
      uPixel: { value: 0.01 },
    },
    vertexShader: /* glsl */ `
      uniform int uPlane;
      uniform vec3 uCam;
      uniform float uFade;
      varying vec3 vWorld;
      void main() {
        vec3 p = position * uFade * 2.0;
        vec3 w;
        if (uPlane == 0) w = vec3(p.x + uCam.x, p.y + uCam.y, 0.0);
        else if (uPlane == 1) w = vec3(p.x + uCam.x, 0.0, p.y + uCam.z);
        else w = vec3(0.0, p.x + uCam.y, p.y + uCam.z);
        vWorld = w;
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform vec3 uAxisX;
      uniform vec3 uAxisY;
      uniform vec3 uAxisZ;
      uniform float uScale;
      uniform float uFade;
      uniform int uPlane;
      uniform vec3 uCam;
      uniform int uOrtho;
      uniform vec3 uShowAxes;
      uniform int uShowFloor;
      uniform float uPixel;
      varying vec3 vWorld;
      float gridLine(vec2 c, float size, float width) {
        vec2 g = abs(fract(c / size - 0.5) - 0.5) / (fwidth(c / size));
        float l = min(g.x, g.y);
        return 1.0 - min(l / width, 1.0);
      }
      float axisLine(float d, float width) {
        float w = fwidth(d);
        return 1.0 - min(abs(d) / (w * width), 1.0);
      }
      void main() {
        vec2 c = uPlane == 0 ? vWorld.xy : (uPlane == 1 ? vWorld.xz : vWorld.yz);
        float dist = uOrtho == 1 ? 0.0 : length(vWorld - uCam);
        float fade = uOrtho == 1 ? 1.0 : 1.0 - smoothstep(uFade * 0.25, uFade, dist);
        // level of detail: choose a power-of-ten spacing based on screen footprint
        float lod = max(fwidth(c.x), fwidth(c.y));
        float s0 = uScale;
        float s1 = uScale * 10.0;
        float s2 = uScale * 100.0;
        float t0 = clamp(1.0 - lod / s0 * 6.0, 0.0, 1.0);
        float t1 = clamp(1.0 - lod / s1 * 6.0, 0.0, 1.0);
        float a = 0.0;
        if (uShowFloor == 1) {
          a = max(a, gridLine(c, s0, 1.0) * t0 * 0.45);
          a = max(a, gridLine(c, s1, 1.0) * max(t1, 0.0) * 0.75);
          a = max(a, gridLine(c, s2, 1.0) * 0.9);
        }
        vec3 col = uColor;
        // axis lines
        float ax = 0.0, ay = 0.0;
        if (uPlane == 0) {
          ax = axisLine(vWorld.y, 1.5) * uShowAxes.x;
          ay = axisLine(vWorld.x, 1.5) * uShowAxes.y;
        } else if (uPlane == 1) {
          ax = axisLine(vWorld.z, 1.5) * uShowAxes.x;
          ay = axisLine(vWorld.x, 1.5) * uShowAxes.z;
        } else {
          ax = axisLine(vWorld.z, 1.5) * uShowAxes.y;
          ay = axisLine(vWorld.y, 1.5) * uShowAxes.z;
        }
        vec3 colA = uPlane == 2 ? uAxisY : uAxisX;
        vec3 colB = uPlane == 0 ? uAxisY : uAxisZ;
        if (ax > 0.01) { col = mix(col, colA, ax); a = max(a, ax); }
        if (ay > 0.01) { col = mix(col, colB, ay); a = max(a, ay); }
        a *= fade;
        if (a < 0.01) discard;
        gl_FragColor = vec4(col, a);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    extensions: { derivatives: true } as never,
  });
  const mesh = new Mesh(new PlaneGeometry(1, 1), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  mesh.userData.overlay = true;
  return { mesh, mat };
}
