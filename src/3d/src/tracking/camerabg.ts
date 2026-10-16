// Camera background images: footage (a movie clip) or an image shown behind (or in front of) the
// scene when looking through a camera, used to line up a camera solve with its footage. Drawn by
// the 3D viewport's scene pass inside the camera frame; edited in Properties ▸ Camera data.
import { Mesh, MeshBasicMaterial, OrthographicCamera, PlaneGeometry, Scene, SRGBColorSpace, Texture, LinearFilter } from 'three';
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app } from '../app/app';
import { panel, checkbox, enumMenu } from '../ui/widgets';
import { num, splitRow, enumProp, bool } from '../ui/props';
import { drawHooks, type DrawView } from '../editors/view3d/draw';
import { renderContext } from '../render/context';
import { imageTexture } from '../render/images';
import type { CameraData, ID, ObjectData, Vec2 } from '../data/types';
import { clipTable, clipFrameToSourceIndex, sceneToClipFrame } from './types';
import { readySource, clipSource } from './source';
import { cameraExtraPanels } from '../render/final/props/camera';

export interface CameraBackgroundImage {
  source: 'IMAGE' | 'MOVIE_CLIP';
  image: ID | null;
  clip: ID | null;
  /** use the scene's active clip */
  use_camera_clip: boolean;
  show_background_image: boolean;
  show_expanded: boolean;
  alpha: number;
  display_depth: 'BACK' | 'FRONT';
  frame_method: 'STRETCH' | 'FIT' | 'CROP';
  offset: Vec2;
  rotation: number;
  scale: number;
  use_flip_x: boolean;
  use_flip_y: boolean;
}

declare module '../data/types' {
  interface CameraData {
    show_background_images?: boolean;
    background_images?: CameraBackgroundImage[];
  }
}

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
  if (bg.source === 'IMAGE') {
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

// ---------------------------------------------------------------------------
// Properties ▸ Camera data panel

const commit = (label: string) => {
  app.pushUndo(label);
  app.changed('doc');
};

export function backgroundImagesPanel(_o: ObjectData, ca: CameraData): Child {
  const list = (ca.background_images ??= []);
  return panel(
    'ca-bgimages',
    'Background Images',
    () => [
      h('div', { class: 'btn-col ca-bg-add' }, h('button', { class: 'btn', onclick: () => (list.push(newBackgroundImage()), (ca.show_background_images = true), commit('Add Background Image')) }, icon('add'), 'Add Image')),
      list.map((bg, i) =>
        h(
          'div',
          { key: `bg${i}`, class: 'ca-bg-item' },
          h(
            'div',
            { class: 'ca-bg-head' },
            h('button', { class: 'icon-btn', onclick: () => ((bg.show_expanded = !bg.show_expanded), app.changed('ui')) }, icon(bg.show_expanded ? 'disclosure_tri_down' : 'disclosure_tri_right')),
            checkbox(`ca-bg-show-${i}`, bg.source === 'MOVIE_CLIP' ? (bg.use_camera_clip ? 'Active Clip' : (clipTable(app.doc)[bg.clip ?? '']?.name ?? 'Movie Clip')) : (app.doc.images[bg.image ?? '']?.name ?? 'Image'), bg.show_background_image, (v) => ((bg.show_background_image = v), commit('Show Background Image'))),
            h('button', { class: 'icon-btn', 'data-tip': 'Remove this background image', onclick: () => (list.splice(i, 1), commit('Remove Background Image')) }, icon('x')),
          ),
          bg.show_expanded
            ? [
                enumProp(bg, 'source', 'Source', [
                  ['IMAGE', 'Image'],
                  ['MOVIE_CLIP', 'Movie Clip'],
                ]),
                bg.source === 'IMAGE'
                  ? splitRow('Image', enumMenu(`ca-bg-img-${i}`, [{ value: '', label: '—' }, ...Object.values(app.doc.images).map((im) => ({ value: im.id, label: im.name, icon: 'image' }))], bg.image ?? '', (v) => ((bg.image = v || null), commit('Background Image'))))
                  : [
                      bool(bg, 'use_camera_clip', 'Camera Clip', { tip: "Use the scene's active movie clip" }),
                      bg.use_camera_clip ? null : splitRow('Clip', enumMenu(`ca-bg-clip-${i}`, [{ value: '', label: '—' }, ...Object.values(clipTable(app.doc)).map((c) => ({ value: c.id, label: c.name, icon: 'clip_editor' }))], bg.clip ?? '', (v) => ((bg.clip = v || null), commit('Background Clip')))),
                    ],
                num(bg, 'alpha', 'Opacity', { min: 0, max: 1, slider: true }),
                enumProp(bg, 'display_depth', 'Depth', [
                  ['BACK', 'Back'],
                  ['FRONT', 'Front'],
                ]),
                enumProp(bg, 'frame_method', 'Frame Method', [
                  ['STRETCH', 'Stretch'],
                  ['FIT', 'Fit'],
                  ['CROP', 'Crop'],
                ]),
                num(bg, 'rotation', 'Rotation', { unit: 'angle' }),
                num(bg, 'scale', 'Scale', { min: 0, max: 10 }),
                bool(bg, 'use_flip_x', 'Flip Horizontally'),
                bool(bg, 'use_flip_y', 'Flip Vertically'),
              ]
            : null,
        ),
      ),
    ],
    { closed: !list.length, header: h('span', { class: 'panel-check', onpointerdown: (e: PointerEvent) => e.stopPropagation() }, checkbox('ca-bg-on', '', !!ca.show_background_images, (v) => ((ca.show_background_images = v), commit('Show Background Images')))) },
  );
}

/** Show a movie clip behind a camera (replacing an existing clip background). */
export function setClipBackground(ca: CameraData, clipId: string) {
  const list = (ca.background_images ??= []);
  const existing = list.find((b) => b.source === 'MOVIE_CLIP');
  if (existing) Object.assign(existing, { clip: clipId, use_camera_clip: false, show_background_image: true });
  else list.push(newBackgroundImage({ source: 'MOVIE_CLIP', clip: clipId, use_camera_clip: false }));
  ca.show_background_images = true;
}

cameraExtraPanels.push(backgroundImagesPanel);
