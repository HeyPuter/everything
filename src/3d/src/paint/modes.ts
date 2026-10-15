// Mode handlers: enter/exit Sculpt, Vertex Paint, Weight Paint and Texture Paint.
import { app } from '../app/app';
import type { ObjectData } from '../data/types';
import { modeHandlers } from '../ops/modes';
import { activeTools } from '../app/prefs';
import { ensureBrushes, BRUSH_LISTS, type BrushMode } from './brushes';
import { dropSession } from './session';
import { ensureColorAttribute } from './vpaint';
import { addPaintSlot, meshHasUVs, paintImage, pendingImageSaves } from './tpaint';
import { paintDisplay, invalidatePaintAttributes } from './display';
import { armatureWeightsFor } from './armweights';
import { cursorState } from './cursor';
import { syncHiddenFromVerts } from './fsdata';

function meshOf(ob: ObjectData, mode: string) {
  const me = ob.type === 'MESH' && ob.data ? app.doc.meshes[ob.data] : undefined;
  if (!me) {
    app.report('WARNING', `${mode} is only available for mesh objects`);
    return null;
  }
  return me;
}

function prepare(mode: BrushMode) {
  ensureBrushes(app.doc);
  // keep the active tool valid for this mode (a brush of the mode or one of its builtin tools)
  const cur = activeTools[mode];
  const valid = BRUSH_LISTS[mode].some((b) => b?.id === cur) || (cur?.startsWith('builtin.') && mode === 'SCULPT');
  if (!valid) activeTools[mode] = BRUSH_LISTS[mode].find((b) => !!b)!.id;
  dropSession();
  invalidatePaintAttributes();
}

function leave() {
  dropSession();
  cursorState.hit = null;
  cursorState.inside = false;
  invalidatePaintAttributes();
}

modeHandlers.SCULPT = {
  enter: (ob) => {
    const me = meshOf(ob, 'Sculpt Mode');
    if (!me) return false;
    if (!me.indices.length) {
      app.report('WARNING', 'Sculpt Mode needs a mesh with faces');
      return false;
    }
    syncHiddenFromVerts(me);
    prepare('SCULPT');
    return true;
  },
  exit: leave,
};

modeHandlers.VERTEX_PAINT = {
  enter: (ob) => {
    const me = meshOf(ob, 'Vertex Paint');
    if (!me) return false;
    prepare('VERTEX_PAINT');
    ensureColorAttribute(me);
    return true;
  },
  exit: leave,
};

modeHandlers.WEIGHT_PAINT = {
  ...(modeHandlers.WEIGHT_PAINT ?? {}),
  enter: (ob) => {
    const me = meshOf(ob, 'Weight Paint');
    if (!me) return false;
    prepare('WEIGHT_PAINT');
    return true;
  },
  exit: leave,
  armatureWeights: armatureWeightsFor,
};

modeHandlers.TEXTURE_PAINT = {
  enter: (ob) => {
    const me = meshOf(ob, 'Texture Paint');
    if (!me) return false;
    prepare('TEXTURE_PAINT');
    let img = paintImage(ob);
    if (!img) img = addPaintSlot(ob);
    paintDisplay.image = img?.id ?? null;
    if (!meshHasUVs(me)) app.report('WARNING', 'Missing UVs: use Paint ▸ Add Simple UVs, or unwrap the mesh in Edit Mode');
    return true;
  },
  exit: () => {
    // painted pixels are stored into the image bytes after each stroke; wait for the last one
    void pendingImageSaves().then(() => app.changed('doc'));
    paintDisplay.image = null;
    leave();
  },
};
