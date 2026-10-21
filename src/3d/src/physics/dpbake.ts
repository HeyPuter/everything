// Dynamic Paint ▸ Bake Image Sequence (dpaint.bake): simulates an image-sequence surface over its
// frame range and writes its maps to images (created when missing). Afterwards the images follow
// the current frame, so materials using them show the paint animating.
import { app, onAppReady, registerOperators } from '../app/app';
import type { DocumentData, ImageData as Img, ObjectData } from '../data/types';
import { newImage } from '../data/defaults';
import { primeImage } from '../render/images';
import { writePixels } from '../render/final/imageops';
import { caches, frameOf, type FrameCache } from './common';
import { dpCacheKey, defaultSurface, type DPSurface, type DynamicPaintModifier, type Live } from './dynpaint';
import { activeSurface, dpOf } from './dpops';
import { outputPixels, surfaceOutputs, type DPImageKind } from './dpimage';

function imageNamed(doc: DocumentData, name: string): Img | undefined {
  return Object.values(doc.images).find((i) => i.name === name);
}

/** RGBA pixels (canvas rows: top first) of one output at a cache frame, or null. */
function framePixels(ob: ObjectData, m: DynamicPaintModifier, sf: DPSurface, kind: DPImageKind, frame: number): globalThis.ImageData | null {
  const c = caches.get(dpCacheKey(ob, m, sf)) as FrameCache<Float32Array, Live> | undefined;
  const st = c?.frames.get(frame) ?? c?.nearest(frame);
  // the texels the simulation ran on (of the mesh reaching the modifier)
  const t = c?.live?.texels;
  if (!st || !t || st.length % t.pix.length) return null;
  const res = t.res;
  const px = outputPixels(t, st, kind, { depthClamp: sf.depth_clamp });
  // image rows run top to bottom, UV v upwards
  const flipped = new Uint8ClampedArray(px.length);
  for (let y = 0; y < res; y++) flipped.set(px.subarray(y * res * 4, (y + 1) * res * 4), (res - 1 - y) * res * 4);
  return new ImageData(flipped, res, res);
}

/** Image-sequence surfaces of a document (with their object and modifier). */
function imageSurfaces(doc: DocumentData): { ob: ObjectData; m: DynamicPaintModifier; sf: DPSurface }[] {
  const out: { ob: ObjectData; m: DynamicPaintModifier; sf: DPSurface }[] = [];
  for (const id of doc.object_order) {
    const ob = doc.objects[id];
    const m = ob ? dpOf(ob) : undefined;
    if (!ob || !m || m.ui_type !== 'CANVAS') continue;
    for (const sf of m.canvas_settings?.canvas_surfaces ?? []) if (sf.is_active && sf.surface_format === 'IMAGE') out.push({ ob, m, sf: { ...defaultSurface(sf.surface_type), ...sf } as DPSurface });
  }
  return out;
}

registerOperators([
  {
    idname: 'dpaint.bake',
    label: 'Bake Dynamic Paint',
    description: 'Bake the image sequence of the active surface and write its maps to images',
    poll: () => activeSurface()?.surface_format === 'IMAGE',
    exec: (ctx) => {
      const ob = app.activeObject!;
      const m = dpOf(ob)!;
      const sf0 = activeSurface()!;
      const sf = { ...defaultSurface(sf0.surface_type), ...sf0 } as DPSurface;
      const me = ob.data ? ctx.doc.meshes[ob.data] : undefined;
      if (!me || !me.uvs.length) {
        app.report('ERROR', 'Image sequence surfaces need a UV map on the canvas mesh');
        return 'CANCELLED';
      }
      const key = dpCacheKey(ob, m, sf0);
      if (sf0.point_cache.is_baked) app.run('ptcache.free_bake', { cache: key });
      if (app.run('ptcache.bake', { cache: key }, { invoke: false }) !== 'FINISHED') return 'CANCELLED';
      const res = (caches.get(key) as FrameCache<Float32Array, Live> | undefined)?.live?.texels?.res ?? Math.max(16, Math.min(4096, Math.round(sf.image_resolution ?? 256)));
      const f = frameOf({ frame: ctx.doc.scene.frame_current });
      let made = 0;
      for (const o of surfaceOutputs(sf)) {
        let img = imageNamed(ctx.doc, o.name);
        if (!img) {
          img = newImage(o.name, res, res, 'BLANK', [0, 0, 0, 0]);
          // only the paint colours are colour data
          img.colorspace = o.kind === 'paintmap' ? 'sRGB' : 'Non-Color';
          ctx.doc.images[img.id] = img;
          made++;
        }
        const px = framePixels(ob, m, sf, o.kind, f);
        if (px) writePixels(img, px);
      }
      lastShown.clear();
      app.report('INFO', `Baked ${sf.name}: ${sf0.point_cache.frame_end - sf0.point_cache.frame_start + 1} frames${made ? `, ${made} image${made === 1 ? '' : 's'} added` : ''}`);
    },
  },
]);

/** frame and cache frame last written to each image */
const lastShown = new Map<string, { frame: number; data: Float32Array | undefined }>();

/** Show the current frame's maps in the surfaces' images (no undo step: the images follow time). */
function syncImages(): boolean {
  const doc = app.doc;
  let changed = false;
  for (const { ob, m, sf } of imageSurfaces(doc)) {
    const c = caches.get(dpCacheKey(ob, m, sf)) as FrameCache<Float32Array> | undefined;
    if (!c?.frames.size) continue;
    const f = Math.max(sf.point_cache.frame_start, Math.min(frameOf({ frame: doc.scene.frame_current }), sf.point_cache.frame_end));
    const data = c.frames.get(f) ?? c.nearest(f);
    for (const o of surfaceOutputs(sf)) {
      const img = imageNamed(doc, o.name);
      if (!img) continue;
      const k = `${img.id}:${sf.id}`;
      const last = lastShown.get(k);
      if (last && last.frame === f && last.data === data) continue;
      const px = framePixels(ob, m, sf, o.kind, f);
      if (!px) continue;
      primeImage(img, px);
      lastShown.set(k, { frame: f, data });
      changed = true;
    }
  }
  return changed;
}

let queued = false;
onAppReady(() => {
  app.subscribe((kinds) => {
    if (queued || !(kinds.has('frame') || kinds.has('doc'))) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      // redraw when an image changed
      if (syncImages()) app.changed('view');
    });
  });
});
