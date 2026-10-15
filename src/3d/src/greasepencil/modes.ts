// Grease Pencil object modes: Draw (PAINT_GREASE_PENCIL), Edit (EDIT), Sculpt (SCULPT_GREASE_PENCIL).
import { app, operators } from '../app/app';
import { modeHandlers } from '../ops/modes';
import { MODE_ITEMS } from '../editors/view3d/header';
import { activeTools } from '../app/prefs';
import { gpOf, gpTS, normalizeDrawing } from './data';

export const GP_MODES = ['PAINT_GREASE_PENCIL', 'SCULPT_GREASE_PENCIL'] as const;

export const DEFAULT_TOOLS: Record<string, string> = {
  PAINT_GREASE_PENCIL: 'builtin.brush.Draw',
  SCULPT_GREASE_PENCIL: 'builtin.brush.Smooth',
};

function enterGP(mode: string) {
  return (ob: Parameters<NonNullable<(typeof modeHandlers)[string]['enter']>>[0]) => {
    const gp = gpOf(app.doc, ob);
    if (!gp) {
      app.report('WARNING', `${mode === 'PAINT_GREASE_PENCIL' ? 'Draw Mode' : 'Sculpt Mode'} is only available for Grease Pencil objects`);
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
);

// object.mode_set accepts the new modes
const modeProp = operators.get('object.mode_set')?.props?.find((p) => p.id === 'mode');
if (modeProp?.items) modeProp.items.push(['PAINT_GREASE_PENCIL', 'Draw Mode'], ['SCULPT_GREASE_PENCIL', 'Sculpt Mode (Grease Pencil)']);

export const inGPMode = (mode = app.doc.mode) => mode === 'PAINT_GREASE_PENCIL' || mode === 'SCULPT_GREASE_PENCIL' || (mode === 'EDIT' && app.activeObject?.type === 'GREASEPENCIL');
