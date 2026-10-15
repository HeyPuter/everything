// Grease Pencil object modes: Draw (PAINT_GREASE_PENCIL), Edit (EDIT), Sculpt (SCULPT_GREASE_PENCIL).
import { app, operators, registerOperators } from '../app/app';
import { modeHandlers } from '../ops/modes';
import { MODE_ITEMS } from '../editors/view3d/header';
import { activeTools } from '../app/prefs';
import { gpOf, gpTS, normalizeDrawing } from './data';

export const GP_MODES = ['PAINT_GREASE_PENCIL', 'SCULPT_GREASE_PENCIL', 'VERTEX_GREASE_PENCIL', 'WEIGHT_GREASE_PENCIL'] as const;

export const DEFAULT_TOOLS: Record<string, string> = {
  PAINT_GREASE_PENCIL: 'builtin.brush.Draw',
  SCULPT_GREASE_PENCIL: 'builtin.brush.Smooth',
  VERTEX_GREASE_PENCIL: 'builtin.brush.VertexDraw',
  WEIGHT_GREASE_PENCIL: 'builtin.brush.WeightDraw',
};

const MODE_NAMES: Record<string, string> = {
  PAINT_GREASE_PENCIL: 'Draw Mode',
  SCULPT_GREASE_PENCIL: 'Sculpt Mode',
  VERTEX_GREASE_PENCIL: 'Vertex Paint',
  WEIGHT_GREASE_PENCIL: 'Weight Paint',
};

function enterGP(mode: string) {
  return (ob: Parameters<NonNullable<(typeof modeHandlers)[string]['enter']>>[0]) => {
    const gp = gpOf(app.doc, ob);
    if (!gp) {
      app.report('WARNING', `${MODE_NAMES[mode]} is only available for Grease Pencil objects`);
      return false;
    }
    gpTS(app.doc);
    for (const d of gp.drawings) normalizeDrawing(d);
    if (!activeTools[mode] || !activeTools[mode].startsWith('builtin')) activeTools[mode] = DEFAULT_TOOLS[mode];
    return true;
  };
}

modeHandlers.PAINT_GREASE_PENCIL = { enter: enterGP('PAINT_GREASE_PENCIL') };
modeHandlers.SCULPT_GREASE_PENCIL = { enter: enterGP('SCULPT_GREASE_PENCIL') };
modeHandlers.VERTEX_GREASE_PENCIL = { enter: enterGP('VERTEX_GREASE_PENCIL') };
modeHandlers.WEIGHT_GREASE_PENCIL = { enter: enterGP('WEIGHT_GREASE_PENCIL') };

// Edit Mode: chain onto the existing handler (mesh / curve / armature / lattice)
const prevEdit = modeHandlers.EDIT;
modeHandlers.EDIT = {
  ...prevEdit,
  enter(ob) {
    const gp = gpOf(app.doc, ob);
    if (gp) {
      gpTS(app.doc);
      for (const d of gp.drawings) normalizeDrawing(d);
      return true;
    }
    return prevEdit?.enter ? prevEdit.enter(ob) : true;
  },
  exit() {
    prevEdit?.exit?.();
  },
};

// header mode menu: Edit / Sculpt / Draw for grease pencil objects
const edit = MODE_ITEMS.find((m) => m.mode === 'EDIT');
if (edit && !edit.types.includes('GREASEPENCIL')) edit.types.push('GREASEPENCIL');
const sculptAt = MODE_ITEMS.findIndex((m) => m.mode === 'SCULPT');
MODE_ITEMS.splice(
  sculptAt + 1,
  0,
  {
    mode: 'SCULPT_GREASE_PENCIL',
    label: 'Sculpt Mode',
    icon: 'sculptmode_hlt',
    types: ['GREASEPENCIL'],
  },
  {
    mode: 'PAINT_GREASE_PENCIL',
    label: 'Draw Mode',
    icon: 'greasepencil',
    types: ['GREASEPENCIL'],
  },
  {
    mode: 'WEIGHT_GREASE_PENCIL',
    label: 'Weight Paint',
    icon: 'wpaint_hlt',
    types: ['GREASEPENCIL'],
  },
  {
    mode: 'VERTEX_GREASE_PENCIL',
    label: 'Vertex Paint',
    icon: 'vpaint_hlt',
    types: ['GREASEPENCIL'],
  },
);

// object.mode_set accepts the new modes
const modeProp = operators.get('object.mode_set')?.props?.find((p) => p.id === 'mode');
if (modeProp?.items) modeProp.items.push(['PAINT_GREASE_PENCIL', 'Draw Mode'], ['SCULPT_GREASE_PENCIL', 'Sculpt Mode (Grease Pencil)'], ['VERTEX_GREASE_PENCIL', 'Vertex Paint (Grease Pencil)'], ['WEIGHT_GREASE_PENCIL', 'Weight Paint (Grease Pencil)']);

// mode toggles (back to Object Mode when already there)
registerOperators(
  (
    [
      ['grease_pencil.paintmode_toggle', 'Strokes Paint Mode Toggle', 'PAINT_GREASE_PENCIL'],
      ['grease_pencil.sculptmode_toggle', 'Strokes Sculpt Mode Toggle', 'SCULPT_GREASE_PENCIL'],
      ['grease_pencil.vertexmode_toggle', 'Strokes Vertex Mode Toggle', 'VERTEX_GREASE_PENCIL'],
      ['grease_pencil.weightmode_toggle', 'Strokes Weight Mode Toggle', 'WEIGHT_GREASE_PENCIL'],
    ] as const
  ).map(([idname, label, mode]) => ({
    idname,
    label,
    description: `Enter or leave ${MODE_NAMES[mode]}`,
    poll: () => !!gpOf(app.doc, app.activeObject),
    exec: () => {
      if (app.run('object.mode_set', { mode: app.doc.mode === mode ? 'OBJECT' : mode }, { invoke: false }) !== 'FINISHED') return 'CANCELLED';
    },
    undo: false,
  })),
);

export const inGPMode = (mode = app.doc.mode) => (GP_MODES as readonly string[]).includes(mode) || (mode === 'EDIT' && app.activeObject?.type === 'GREASEPENCIL');
