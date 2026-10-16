// Camera background images: reference pictures placed in the camera frame while looking through
// the camera, behind the scene (Back) or over it (Front), with fit, offset, rotation and scale.
import { Scene, Mesh, PlaneGeometry, MeshBasicMaterial, OrthographicCamera, DoubleSide, type Camera } from 'three';
import { app, registerOperators } from '../../app/app';
import { drawHooks, type DrawView } from './draw';
import { imageTexture } from '../../render/images';
import { renderContext } from '../../render/context';
import type { CameraData, ObjectData } from '../../data/types';

export { newBackgroundImage, backgroundImagePlacement } from './camerabgplace';
import { backgroundImagePlacement, newBackgroundImage, type Rect } from './camerabgplace';

const scene = new Scene();
const quad = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false, side: DoubleSide }));
scene.add(quad);
const cam = new OrthographicCamera(0, 1, 0, -1, -1, 1);

interface BgView extends DrawView {
  cameraView?: boolean;
  cameraFrame?: () => Rect | null;
  activeCameraId?: () => string | null;
}

function viewCamera(v: BgView): CameraData | null {
  if (!v.cameraView || !v.cameraFrame || !v.activeCameraId) return null;
  const id = v.activeCameraId();
  const ob: ObjectData | undefined = id ? app.doc.objects[id] : undefined;
  const ca = ob?.type === 'CAMERA' && ob.data ? app.doc.cameras[ob.data] : undefined;
  return ca?.show_background_images && ca.background_images?.length ? ca : null;
}

function drawImages(v: BgView, ca: CameraData, depth: 'BACK' | 'FRONT') {
  const frame = v.cameraFrame!();
  const r = renderContext?.engine.renderer;
  if (!frame || !r) return;
  cam.right = v.width;
  cam.bottom = -v.height;
  cam.updateProjectionMatrix();
  const mat = quad.material as MeshBasicMaterial;
  for (const bg of ca.background_images ?? []) {
    if (!bg.show_background_image || bg.display_depth !== depth || !bg.image) continue;
    const img = app.doc.images[bg.image];
    if (!img) continue;
    const p = backgroundImagePlacement(frame, img.width, img.height, bg);
    mat.map = imageTexture(img);
    mat.opacity = bg.alpha;
    mat.needsUpdate = true;
    quad.position.set(p.cx, -p.cy, 0);
    quad.scale.set(p.w * (bg.use_flip_x ? -1 : 1), p.h * (bg.use_flip_y ? -1 : 1), 1);
    quad.rotation.set(0, 0, p.rotation);
    r.render(scene, cam);
  }
}

drawHooks.passes.push((pass, view: BgView, _camera: Camera) => {
  if (pass !== 'SCENE') return;
  const ca = viewCamera(view);
  if (!ca) return;
  drawImages(view, ca, 'BACK');
  return () => drawImages(view, ca, 'FRONT');
});

function activeCameraData(): CameraData | null {
  const ob = app.activeObject;
  return ob?.type === 'CAMERA' && ob.data ? (app.doc.cameras[ob.data] ?? null) : null;
}

registerOperators([
  {
    idname: 'view3d.camera_background_image_add',
    label: 'Add Camera Background Image',
    description: 'Add a reference image shown in the camera view of the active camera',
    props: [{ id: 'image', label: 'Image', type: 'string', default: '', hidden: true }],
    poll: () => !!activeCameraData(),
    exec: (_ctx, p) => {
      const ca = activeCameraData()!;
      const id = (p.image as string) || null;
      (ca.background_images ??= []).push(newBackgroundImage(id && app.doc.images[id] ? id : null));
      ca.show_background_images = true;
    },
  },
  {
    idname: 'view3d.camera_background_image_remove',
    label: 'Remove Camera Background Image',
    description: 'Remove a reference image from the active camera',
    props: [{ id: 'index', label: 'Index', type: 'int', default: 0, min: 0 }],
    poll: () => !!activeCameraData()?.background_images?.length,
    exec: (_ctx, p) => {
      const list = activeCameraData()!.background_images!;
      const i = p.index as number;
      if (i < 0 || i >= list.length) return 'CANCELLED';
      list.splice(i, 1);
    },
  },
  {
    idname: 'view3d.camera_background_image_clear',
    label: 'Remove All Camera Background Images',
    description: 'Remove every reference image from the active camera',
    poll: () => !!activeCameraData()?.background_images?.length,
    exec: () => {
      activeCameraData()!.background_images = [];
    },
  },
]);
