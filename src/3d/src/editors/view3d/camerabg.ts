// Camera background images: operators to add and remove the reference pictures or footage placed
// in the camera frame while looking through the camera.
import { app, registerOperators } from '../../app/app';
import type { CameraData } from '../../data/types';

export { newBackgroundImage, backgroundImagePlacement } from './camerabgplace';
import { newBackgroundImage } from './camerabgplace';
// drawing (images and movie clips) lives in tracking/camerabg.ts
import '../../tracking/camerabg';

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
