// Cameras of the views of a multi-view render: stereo eyes (offset, off-axis shift or toe-in of
// the scene camera) and custom views that use the camera named with the view's suffix.
import type { Camera, OrthographicCamera, PerspectiveCamera } from 'three';
import type { App } from '../../app/app';
import { renderCamera } from './camera';
import { cameraStereo, eyeTransform, multiview, type RenderViewPlan } from './stereo';

/** Object id of the camera of a suffixed view ("Camera" + "_L" → "Camera_L"), if it exists. */
export function suffixedCamera(app: App, suffix: string): string | null {
  const id = app.doc.scene.camera;
  const base = id ? app.doc.objects[id] : null;
  if (!base || !suffix) return null;
  const want = `${base.name}${suffix}`;
  const ob = Object.values(app.doc.objects).find((o) => o.type === 'CAMERA' && o.name === want);
  return ob?.id ?? null;
}

/** Shift a camera sideways (local X) and turn / skew its frustum for one eye. */
export function applyEye(cam: Camera, offset: number, shift: number, yaw: number) {
  cam.translateX(offset);
  if (yaw) cam.rotateY(yaw);
  const p = cam as PerspectiveCamera;
  if (shift && !(cam as OrthographicCamera).isOrthographicCamera) {
    const e = p.projectionMatrix.elements;
    e[8] += shift * e[0];
    p.projectionMatrixInverse.copy(p.projectionMatrix).invert();
  }
  cam.updateMatrixWorld(true);
}

/** Camera of a render view for an image of w×h pixels. */
export function viewCamera(app: App, w: number, h: number, view: RenderViewPlan): Camera | null {
  const r = app.doc.scene.render;
  const mv = multiview(r);
  // multi-view: the camera with the view's suffix (the scene camera when there is none)
  if (mv.views_format === 'MULTIVIEW' || !view.eye) return renderCamera(app, w, h, suffixedCamera(app, view.suffix) ?? app.doc.scene.camera);
  const cam = renderCamera(app, w, h);
  const id = app.doc.scene.camera;
  const ob = id ? app.doc.objects[id] : null;
  const ca = ob?.type === 'CAMERA' && ob.data ? app.doc.cameras[ob.data] : null;
  if (!cam || !ca) return cam;
  const t = eyeTransform(cameraStereo(ca), view.eye);
  // the camera's scale does not scale the eye distance
  applyEye(cam, t.offset, t.shift, t.yaw);
  return cam;
}
