// Camera background images: footage (a movie clip) or an image shown behind (or in front of) the
// scene when looking through a camera, used to line up a camera solve with its footage. Drawn by
// the 3D viewport's scene pass inside the camera frame; edited in Properties ▸ Camera data
// (editors/properties/more/camera.ts).
import { Mesh, MeshBasicMaterial, OrthographicCamera, PlaneGeometry, Scene, SRGBColorSpace, Texture, LinearFilter } from 'three';
import { app } from '../app/app';
import { drawHooks, type DrawView } from '../editors/view3d/draw';
import { renderContext } from '../render/context';
import { imageTexture } from '../render/images';
import type { CameraBackgroundImage, CameraData } from '../data/types';
import { clipTable, clipFrameToSourceIndex, sceneToClipFrame } from './types';
import { readySource, clipSource } from './source';

export function newBackgroundImage(over: Partial<CameraBackgroundImage> = {}): CameraBackgroundImage {
  return { source: 'IMAGE', image: null, clip: null, use_camera_clip: true, show_background_image: true, show_expanded: true, alpha: 1, display_depth: 'BACK', frame_method: 'STRETCH', offset: [0, 0], rotation: 0, scale: 1, use_flip_x: false, use_flip_y: false, ...over };
}

// ---------------------------------------------------------------------------
// drawing

const quadScene = new Scene();
const quadCam = new OrthographicCamera(-1, 1, 1, -1, -1, 1);
const quadMat = new MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
const quad = new Mesh(new PlaneGeometry(2, 2), quadMat);
quad.frustumCulled = false;
quadScene.add(quad);
const clipTextures = new Map<string, { key: string; tex: Texture }>();
const pending = new Set<string>();

interface CamView {
  cameraFrame?: () => { x: number; y: number; w: number; h: number } | null;
  activeCameraId?: () => string | null;
}

/** Texture and pixel size of a background entry at the current frame (null while loading). */
function bgTexture(bg: CameraBackgroundImage): { tex: Texture; w: number; h: number; flip?: boolean } | null {
  const doc = app.doc;
  if (bg.source !== 'MOVIE_CLIP') {
    const img = bg.image ? doc.images[bg.image] : null;
    if (!img) return null;
    const tex = imageTexture(img, 'Linear', 'sRGB');
    const im = tex.image as { width?: number; height?: number } | null;
    if (!im?.width) return null;
    return { tex, w: im.width, h: im.height ?? 1 };
  }
  const clipId = bg.use_camera_clip ? doc.scene.active_clip : bg.clip;
  const clip = clipId ? clipTable(doc)[clipId] : null;
  if (!clip) return null;
  const src = readySource(clip);
  if (!src) {
    if (!pending.has(clip.id)) {
      pending.add(clip.id);
      void clipSource(clip)?.then(() => (pending.delete(clip.id), renderContext?.engine.requestDraw()));
    }
    return null;
  }
  const idx = clipFrameToSourceIndex(clip, sceneToClipFrame(clip, doc.scene.frame_current));
  if (idx < 0 || idx >= src.frameCount) return null;
  const bmp = src.peek(idx);
  if (!bmp) {
    const k = src.key + idx;
    if (!pending.has(k)) {
      pending.add(k);
      void src.get(idx).then(() => (pending.delete(k), renderContext?.engine.requestDraw()));
    }
    // keep showing the previous frame while the next one decodes
    const prev = clipTextures.get(clip.id);
    return prev ? { tex: prev.tex, w: (prev.tex.image as ImageBitmap).width, h: (prev.tex.image as ImageBitmap).height, flip: true } : null;
  }
  const key = src.key + idx;
  let e = clipTextures.get(clip.id);
  if (!e || e.key !== key) {
    e?.tex.dispose();
    const tex = new Texture(bmp);
    tex.colorSpace = SRGBColorSpace;
    tex.minFilter = LinearFilter;
    tex.generateMipmaps = false;
    // image bitmaps cannot be flipped on upload: the quad is mirrored instead
    tex.flipY = false;
    tex.needsUpdate = true;
    e = { key, tex };
    clipTextures.set(clip.id, e);
  }
  return { tex: e.tex, w: bmp.width, h: bmp.height, flip: true };
}

function drawBackgrounds(view: DrawView, depth: 'BACK' | 'FRONT') {
  const v = view as unknown as CamView;
  const frame = v.cameraFrame?.();
  const camId = v.activeCameraId?.() ?? app.doc.scene.camera;
  const ob = camId ? app.doc.objects[camId] : null;
  const ca = ob?.type === 'CAMERA' && ob.data ? app.doc.cameras[ob.data] : null;
  if (!frame || !ca?.show_background_images || !ca.background_images?.length) return;
  const r = renderContext?.engine.renderer;
  if (!r) return;
  for (const bg of ca.background_images) {
    if (!bg.show_background_image || bg.display_depth !== depth) continue;
    const t = bgTexture(bg);
    if (!t) continue;
    // fit the picture into the camera frame
    const frameAspect = frame.w / frame.h;
    const picAspect = t.w / t.h;
    let w = frame.w,
      hh = frame.h;
    if (bg.frame_method === 'FIT') {
      if (picAspect > frameAspect) hh = w / picAspect;
      else w = hh * picAspect;
    } else if (bg.frame_method === 'CROP') {
      if (picAspect > frameAspect) w = hh * picAspect;
      else hh = w / picAspect;
    }
    w *= bg.scale * (bg.use_flip_x ? -1 : 1);
    hh *= bg.scale * (bg.use_flip_y ? -1 : 1);
    const cx = frame.x + frame.w / 2 + bg.offset[0] * frame.w,
      cy = frame.y + frame.h / 2 - bg.offset[1] * frame.w;
    // viewport pixels → NDC
    const W = view.width,
      H = view.height;
    quad.position.set((cx / W) * 2 - 1, 1 - (cy / H) * 2, 0);
    quad.rotation.set(0, 0, bg.rotation);
    quad.scale.set(w / W, ((t.flip ? -1 : 1) * hh) / H, 1);
    quad.updateMatrixWorld(true);
    quadMat.map = t.tex;
    quadMat.opacity = bg.alpha;
    quadMat.needsUpdate = true;
    r.render(quadScene, quadCam);
  }
}

drawHooks.passes.push((pass, view) => {
  if (pass !== 'SCENE' || !view.sceneCamera) return;
  drawBackgrounds(view, 'BACK');
  return () => drawBackgrounds(view, 'FRONT');
});

/** Show a movie clip behind a camera (replacing an existing clip background). */
export function setClipBackground(ca: CameraData, clipId: string) {
  const list = (ca.background_images ??= []);
  const existing = list.find((b) => b.source === 'MOVIE_CLIP');
  if (existing) Object.assign(existing, { clip: clipId, use_camera_clip: false, show_background_image: true });
  else list.push(newBackgroundImage({ source: 'MOVIE_CLIP', clip: clipId, use_camera_clip: false }));
  ca.show_background_images = true;
}

