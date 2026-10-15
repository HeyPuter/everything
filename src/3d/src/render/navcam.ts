// Viewport camera (view matrix from pivot, distance and orientation): orbit around a
// pivot, dolly, pan, numpad views.
import { PerspectiveCamera, OrthographicCamera, Quaternion, Vector3, Matrix4, Euler } from 'three';
import { prefs } from '../app/prefs';

export type ViewName = 'USER' | 'FRONT' | 'BACK' | 'LEFT' | 'RIGHT' | 'TOP' | 'BOTTOM' | 'CAMERA';

export class NavCamera {
  pivot = new Vector3(0, 0, 0);
  distance = 17.986;
  /** orientation of the view (camera looks along its local -Z, up = local +Y) */
  rot = new Quaternion();
  ortho = false;
  /** automatic ortho in axis views (preference: Auto Perspective) */
  autoPersp = true;
  lens = 50;
  sensor = 72;
  clipStart = 0.01;
  clipEnd = 1000;
  view: ViewName = 'USER';
  persp = new PerspectiveCamera(50, 1, 0.01, 1000);
  orthoCam = new OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  aspect = 1;
  width = 1;
  height = 1;

  constructor() {
    this.persp.up.set(0, 0, 1);
    this.orthoCam.up.set(0, 0, 1);
    // default "User Perspective" of the startup scene
    this.setViewQuat([0.71238, 0.44106, 0.28736, 0.46412]);
    this.distance = 18.388;
    this.pivot.set(-0.0207, -0.046, 0.0007);
  }

  /** Set orientation from tilt (around X, 0 = looking down) and spin around world Z. */
  setFromAngles(tilt: number, spin: number) {
    const q = new Quaternion().setFromEuler(new Euler(tilt, 0, spin, 'ZYX'));
    this.rot.copy(q);
  }

  /** Set from a view rotation quaternion (w, x, y, z). */
  setViewQuat(q: [number, number, number, number]) {
    this.rot.set(q[1], q[2], q[3], q[0]).normalize();
  }

  get camera() {
    return this.ortho ? this.orthoCam : this.persp;
  }

  get eye(): Vector3 {
    return new Vector3(0, 0, this.distance).applyQuaternion(this.rot).add(this.pivot);
  }

  get forward(): Vector3 {
    return new Vector3(0, 0, -1).applyQuaternion(this.rot);
  }

  get right(): Vector3 {
    return new Vector3(1, 0, 0).applyQuaternion(this.rot);
  }

  get up(): Vector3 {
    return new Vector3(0, 1, 0).applyQuaternion(this.rot);
  }

  resize(w: number, h: number) {
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
    this.aspect = this.width / this.height;
  }

  /** horizontal FOV from lens & sensor */
  get fovY(): number {
    const fovX = 2 * Math.atan(this.sensor / 2 / this.lens);
    // the sensor applies to the larger dimension
    if (this.aspect >= 1) return 2 * Math.atan(Math.tan(fovX / 2) / this.aspect);
    return fovX;
  }

  update() {
    const eye = this.eye;
    for (const cam of [this.persp, this.orthoCam]) {
      cam.position.copy(eye);
      cam.quaternion.copy(this.rot);
      cam.updateMatrixWorld(true);
    }
    this.persp.fov = (this.fovY * 180) / Math.PI;
    this.persp.aspect = this.aspect;
    this.persp.near = this.clipStart;
    this.persp.far = this.clipEnd;
    this.persp.updateProjectionMatrix();
    // ortho scale matching the perspective size at the pivot distance
    const halfH = Math.tan(this.fovY / 2) * this.distance;
    this.orthoCam.left = -halfH * this.aspect;
    this.orthoCam.right = halfH * this.aspect;
    this.orthoCam.top = halfH;
    this.orthoCam.bottom = -halfH;
    this.orthoCam.near = -this.clipEnd / 2;
    this.orthoCam.far = this.clipEnd / 2;
    this.orthoCam.position.copy(this.pivot).addScaledVector(this.forward, -this.distance);
    this.orthoCam.updateProjectionMatrix();
    this.orthoCam.updateMatrixWorld(true);
  }

  orbit(dx: number, dy: number) {
    // turntable: yaw around world Z, pitch around view X (trackball preference: yaw around view Y)
    const yawAxis = prefs.orbit_method === 'TRACKBALL' ? new Vector3().crossVectors(this.right, this.forward).normalize() : new Vector3(0, 0, 1);
    const yaw = new Quaternion().setFromAxisAngle(yawAxis, -dx);
    const pitch = new Quaternion().setFromAxisAngle(this.right, -dy);
    this.rot.premultiply(pitch).premultiply(yaw).normalize();
    this.leaveAxisView();
  }

  /** Orbit around an arbitrary world point (orbit around selection) keeping it fixed on screen. */
  orbitAround(point: Vector3, dx: number, dy: number) {
    const before = this.rot.clone();
    this.orbit(dx, dy);
    const delta = this.rot.clone().multiply(before.invert());
    const off = this.pivot.clone().sub(point).applyQuaternion(delta);
    this.pivot.copy(point).add(off);
  }

  roll(angle: number) {
    const q = new Quaternion().setFromAxisAngle(this.forward, angle);
    this.rot.premultiply(q).normalize();
  }

  leaveAxisView() {
    if (this.view !== 'USER' && this.view !== 'CAMERA') {
      this.view = 'USER';
      if (this.autoPersp && this.wasAutoOrtho) {
        this.ortho = false;
        this.wasAutoOrtho = false;
      }
    }
    if (this.view === 'CAMERA') this.view = 'USER';
  }
  wasAutoOrtho = false;

  /** Pan by pixels. */
  pan(dxPx: number, dyPx: number) {
    const halfH = Math.tan(this.fovY / 2) * this.distance;
    const perPx = (halfH * 2) / this.height;
    this.pivot.addScaledVector(this.right, -dxPx * perPx).addScaledVector(this.up, dyPx * perPx);
  }

  zoom(factor: number) {
    this.distance = Math.max(1e-4, Math.min(1e6, this.distance * factor));
  }

  /** Zoom keeping the world point under the cursor fixed (zoom to mouse position). */
  zoomAt(factor: number, ndcX: number, ndcY: number) {
    const halfH = Math.tan(this.fovY / 2) * this.distance;
    const off = this.right.multiplyScalar(ndcX * halfH * this.aspect).add(this.up.multiplyScalar(ndcY * halfH));
    this.pivot.addScaledVector(off, 1 - factor);
    this.zoom(factor);
  }

  setAxisView(view: ViewName, opposite = false) {
    const views: Record<string, [number, number]> = {
      FRONT: [Math.PI / 2, 0],
      BACK: [Math.PI / 2, Math.PI],
      RIGHT: [Math.PI / 2, Math.PI / 2],
      LEFT: [Math.PI / 2, -Math.PI / 2],
      TOP: [0, 0],
      BOTTOM: [Math.PI, 0],
    };
    let v = view;
    if (opposite) v = ({ FRONT: 'BACK', BACK: 'FRONT', RIGHT: 'LEFT', LEFT: 'RIGHT', TOP: 'BOTTOM', BOTTOM: 'TOP' } as Record<string, ViewName>)[view] ?? view;
    const a = views[v];
    if (!a) return;
    this.setFromAngles(a[0], a[1]);
    this.view = v;
    if (this.autoPersp && !this.ortho) {
      this.ortho = true;
      this.wasAutoOrtho = true;
    }
  }

  /** Rotate the view by 15° steps (numpad 4/6/8/2). */
  step(axis: 'yaw' | 'pitch', angle: number) {
    if (axis === 'yaw') this.rot.premultiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), angle));
    else this.rot.premultiply(new Quaternion().setFromAxisAngle(this.right, angle));
    this.rot.normalize();
    this.leaveAxisView();
  }

  /** Fit a bounding sphere in view. */
  frame(center: Vector3, radius: number) {
    this.pivot.copy(center);
    const r = Math.max(radius, 0.01);
    const fov = Math.min(this.fovY, 2 * Math.atan(Math.tan(this.fovY / 2) * this.aspect));
    this.distance = (r / Math.sin(fov / 2)) * 1.05;
  }

  /** Match a scene camera's world matrix. */
  alignToMatrix(m: Matrix4) {
    const p = new Vector3(),
      q = new Quaternion(),
      s = new Vector3();
    m.decompose(p, q, s);
    this.rot.copy(q);
    this.pivot.copy(p).addScaledVector(this.forward, this.distance);
  }

  serialize() {
    return { pivot: this.pivot.toArray(), distance: this.distance, rot: this.rot.toArray(), ortho: this.ortho, view: this.view, lens: this.lens, clipStart: this.clipStart, clipEnd: this.clipEnd };
  }

  load(s: Partial<ReturnType<NavCamera['serialize']>>) {
    if (s.pivot) this.pivot.fromArray(s.pivot);
    if (s.distance) this.distance = s.distance;
    if (s.rot) this.rot.fromArray(s.rot);
    if (s.ortho !== undefined) this.ortho = s.ortho;
    if (s.view) this.view = s.view as ViewName;
    if (s.lens) this.lens = s.lens;
    if (s.clipStart) this.clipStart = s.clipStart;
    if (s.clipEnd) this.clipEnd = s.clipEnd;
  }

  /** world → client pixel (relative to viewport) */
  project(p: Vector3): { x: number; y: number; z: number } {
    const v = p.clone().project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * this.width, y: (-v.y * 0.5 + 0.5) * this.height, z: v.z };
  }

  /** pixel → world ray */
  ray(x: number, y: number): { origin: Vector3; dir: Vector3 } {
    const ndc = new Vector3((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1, -1);
    const cam = this.camera;
    if (this.ortho) {
      const origin = ndc.clone().unproject(cam);
      return { origin, dir: this.forward };
    }
    const origin = cam.position.clone();
    const far = new Vector3(ndc.x, ndc.y, 0.5).unproject(cam);
    return { origin, dir: far.sub(origin).normalize() };
  }

  /** world-space units per pixel at a given point */
  pixelSize(p: Vector3): number {
    const halfH = this.ortho ? Math.tan(this.fovY / 2) * this.distance : Math.tan(this.fovY / 2) * Math.max(1e-4, p.clone().sub(this.camera.position).dot(this.forward));
    return (halfH * 2) / this.height;
  }

  /** point on the view plane through `depthPoint` under pixel (x, y) */
  unprojectAtDepth(x: number, y: number, depthPoint: Vector3): Vector3 {
    const { origin, dir } = this.ray(x, y);
    const n = this.forward;
    const t = depthPoint.clone().sub(origin).dot(n) / dir.dot(n);
    return origin.addScaledVector(dir, t);
  }
}
