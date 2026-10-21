// Line drawing in final renders (Render ▸ Freestyle): runs after every engine's frame, then
// composites the strokes over the image or stores them as the Freestyle pass.
import { app } from '../app/app';
import { frameLineHooks, type FrameLineContext } from '../render/final/job';
import { freestyleSettings } from './defaults';
import { linestyleTable } from './types';
import { drawingSets, prepareLines, drawLineSets, type LineRenderInput } from './core/pipeline';
import { visibilityPieces, type Piece } from './core/visibility';
import { compositeOver } from './core/raster';
import { lineCamera, lineObjects, materialAttrs, inCollection } from './scene';
import { compileModules, shadeStrokes } from './modules';

/** Pixels per line style thickness unit for a frame height. */
export function thicknessScale(r: { line_thickness_mode?: string; line_thickness?: number }, frameHeight: number): number {
  return r.line_thickness_mode === 'RELATIVE' ? frameHeight / 480 : Math.max(0, r.line_thickness ?? 1);
}

/** Line layer of the current scene state (premultiplied RGBA, rows top-down); null when off. */
export async function renderLineLayer(f: Pick<FrameLineContext, 'camera' | 'width' | 'height' | 'frameHeight'> & { phase?: FrameLineContext['phase'] }): Promise<Float32Array | null> {
  const doc = app.doc;
  const r = doc.scene.render;
  if (!r.use_freestyle) return null;
  const fs = freestyleSettings(doc);
  if (!fs.use_freestyle) return null;
  const input: LineRenderInput = {
    objects: lineObjects(app),
    camera: lineCamera(f.camera, f.width, f.height),
    settings: fs,
    linestyles: linestyleTable(doc),
    thicknessScale: thicknessScale(r, f.frameHeight),
    material: (id) => materialAttrs(doc, id),
    objectLocation: (id) => {
      const ev = app.graph.get(id);
      return ev ? [ev.world.elements[12], ev.world.elements[13], ev.world.elements[14]] : null;
    },
    inCollection: (id, col) => inCollection(doc, id, col),
    seed: doc.scene.frame_current,
  };
  let sets = drawingSets(input);
  if (fs.mode === 'SCRIPT') {
    // style modules declare their own line sets, styles and stroke shaders
    const c = compileModules(fs, (id) => doc.texts[id] ?? null);
    for (const e of c.errors) app.report('ERROR', e);
    input.linestyles = { ...input.linestyles, ...c.styles };
    sets = c.sets;
    let reported = false;
    input.shade = (set, strokes) => {
      const fn = c.shaders.get(set);
      const err = fn ? shadeStrokes(strokes, fn) : null;
      if (err && !reported) {
        reported = true;
        app.report('ERROR', `Style module shader: ${err}`);
      }
    };
  }
  const layer = new Float32Array(f.width * f.height * 4);
  if (!sets.length || !input.objects.length) return layer;
  await f.phase?.('Freestyle: edges');
  const prep = prepareLines(input, sets);
  // visibility in chunks so the interface keeps updating (and Esc cancels)
  const pieces: Piece[] = [];
  const chunk = 1500;
  for (let i = 0; i < prep.edges.length; i += chunk) {
    for (const p of visibilityPieces(prep.edges.slice(i, i + chunk), input.camera, prep.occlusion, prep.visibility)) pieces.push(p);
    if (i + chunk < prep.edges.length) await f.phase?.(`Freestyle: visibility ${Math.round(((i + chunk) / prep.edges.length) * 100)}%`);
  }
  await f.phase?.('Freestyle: strokes');
  drawLineSets(input, sets, { pieces, objects: input.objects, edges: prep.edges.length }, layer);
  return layer;
}

frameLineHooks.push(async (f) => {
  const layer = await renderLineLayer(f);
  if (!layer) return;
  const fs = freestyleSettings(app.doc);
  if (fs.as_render_pass) f.passes.Freestyle = layer;
  else compositeOver(layer, f.combined);
});
