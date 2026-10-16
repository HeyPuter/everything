// Look-development helpers of the 3D viewport: the studio HDRI drawn as a (blurred, faded)
// background in Material Preview, and the two preview spheres (matte and mirror) in the
// bottom-right corner that show how the current lighting falls on simple surfaces.
import { Scene, Mesh, SphereGeometry, PlaneGeometry, MeshStandardMaterial, MeshBasicMaterial, OrthographicCamera, Color, type Camera, type Texture, type WebGLRenderer } from 'three';

const bgScene = new Scene();
const fadeScene = new Scene();
const fadeMat = new MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
fadeScene.add(new Mesh(new PlaneGeometry(2, 2), fadeMat));
const flatCam = new OrthographicCamera(-1, 1, 1, -1, 0, 2);
flatCam.position.set(0, 0, 1);

/**
 * Draw an environment map behind the scene: `alpha` blends it over the theme background
 * (0 keeps the plain background), `blur` softens it (0 sharp … 1 very soft).
 */
export function drawEnvironmentBackground(r: WebGLRenderer, camera: Camera, env: Texture, bg: Color, opts: { alpha: number; blur: number; intensity: number; rotation: number }) {
  if (opts.alpha <= 0) return;
  bgScene.background = env;
  bgScene.backgroundBlurriness = Math.min(1, Math.max(0, opts.blur));
  bgScene.backgroundIntensity = opts.intensity;
  bgScene.backgroundRotation.set(0, 0, opts.rotation);
  r.render(bgScene, camera);
  if (opts.alpha < 1) {
    fadeMat.color.copy(bg);
    fadeMat.opacity = 1 - opts.alpha;
    r.render(fadeScene, flatCam);
  }
  // the background never writes depth, but keep the scene pass independent of it
  r.clearDepth();
}

const sphereScene = new Scene();
const sphereGeo = new SphereGeometry(1, 48, 32);
const matte = new MeshStandardMaterial({ color: new Color(0.8, 0.8, 0.8), roughness: 1, metalness: 0 });
const mirror = new MeshStandardMaterial({ color: new Color(1, 1, 1), roughness: 0, metalness: 1 });
const sphere = new Mesh(sphereGeo, matte);
sphereScene.add(sphere);
const sphereCam = new OrthographicCamera(-1.02, 1.02, 1.02, -1.02, 0.1, 10);

/** Size of a preview sphere in CSS pixels for a viewport of the given size. */
export function lookdevSphereSize(w: number, h: number) {
  return Math.round(Math.max(28, Math.min(64, Math.min(w, h) * 0.12)));
}

/**
 * Draw the matte and the mirror preview spheres in the bottom-right corner of the viewport
 * rectangle (x, y from the bottom-left of the canvas, CSS pixels). The spheres turn with the
 * view so their reflections follow the camera. `right` keeps room for a sidebar.
 */
export function drawLookdevSpheres(r: WebGLRenderer, camera: Camera, env: Texture | null, rect: { x: number; y: number; w: number; h: number }, opts: { intensity: number; rotation: number; right?: number }) {
  const size = lookdevSphereSize(rect.w, rect.h);
  if (rect.w < size * 3 || rect.h < size * 2) return;
  sphereScene.environment = env;
  sphereScene.environmentIntensity = opts.intensity;
  sphereScene.environmentRotation.set(0, 0, opts.rotation);
  sphereCam.quaternion.copy(camera.quaternion);
  sphereCam.position.set(0, 0, 4).applyQuaternion(camera.quaternion);
  sphereCam.updateMatrixWorld();
  const margin = Math.round(size * 0.18);
  const gap = Math.round(size * 0.3);
  const bottom = rect.y + margin;
  let left = rect.x + rect.w - (opts.right ?? 0) - margin - size;
  for (const m of [mirror, matte]) {
    sphere.material = m;
    r.setViewport(left, bottom, size, size);
    r.setScissor(left, bottom, size, size);
    r.clearDepth();
    r.render(sphereScene, sphereCam);
    left -= size + gap;
  }
  r.setViewport(rect.x, rect.y, rect.w, rect.h);
  r.setScissor(rect.x, rect.y, rect.w, rect.h);
}
