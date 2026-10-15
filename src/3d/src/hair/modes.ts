// Interaction modes of Curves objects: Edit Mode and Sculpt Mode (SCULPT_CURVES).
import { app, onAppReady, operators, registerOperator, registerOperators } from '../app/app';
import { modeHandlers } from '../ops/modes';
import { MODE_ITEMS } from '../editors/view3d/header';
import { activeTools } from '../app/prefs';
import { hairOf } from './data';
import { toolsByMode, COMMON_TOOLS } from '../editors/view3d/toolbar';

export const DEFAULT_SCULPT_TOOL = 'builtin_brush.Comb';

// Edit Mode: chain onto the existing handlers (mesh / curve / armature / lattice / grease pencil…)
const prevEdit = modeHandlers.EDIT;
modeHandlers.EDIT = {
  ...prevEdit,
  enter(ob) {
    if (ob.type === 'CURVES') return !!hairOf(app.doc, ob);
    return prevEdit?.enter ? prevEdit.enter(ob) : true;
  },
  exit() {
    prevEdit?.exit?.();
  },
};

modeHandlers.SCULPT_CURVES = {
  enter(ob) {
    if (!hairOf(app.doc, ob)) {
      app.report('WARNING', 'Sculpt Curves mode is only available for hair curves objects');
      return false;
    }
    if (!activeTools.SCULPT_CURVES?.startsWith('builtin_brush.')) activeTools.SCULPT_CURVES = DEFAULT_SCULPT_TOOL;
    return true;
  },
};

const edit = MODE_ITEMS.find((m) => m.mode === 'EDIT');
if (edit && !edit.types.includes('CURVES')) edit.types.push('CURVES');
const sculptAt = MODE_ITEMS.findIndex((m) => m.mode === 'SCULPT');
MODE_ITEMS.splice(sculptAt + 1, 0, { mode: 'SCULPT_CURVES', label: 'Sculpt Mode', icon: 'sculptmode_hlt', types: ['CURVES'] });

const modeProp = operators.get('object.mode_set')?.props?.find((p) => p.id === 'mode');
if (modeProp?.items && !modeProp.items.some((i) => i[0] === 'SCULPT_CURVES')) modeProp.items.push(['SCULPT_CURVES', 'Sculpt Mode (Curves)']);

registerOperators([
  {
    idname: 'curves.sculptmode_toggle',
    label: 'Curve Sculpt Mode Toggle',
    description: 'Enter or leave Sculpt Mode of hair curves',
    poll: () => !!hairOf(app.doc, app.activeObject),
    exec: () => {
      if (app.run('object.mode_set', { mode: app.doc.mode === 'SCULPT_CURVES' ? 'OBJECT' : 'SCULPT_CURVES' }, { invoke: false }) !== 'FINISHED') return 'CANCELLED';
    },
    undo: false,
  },
]);

// Tab toggles Edit Mode of Curves objects too
onAppReady(() => {
  const prev = operators.get('object.editmode_toggle');
  if (!prev) return;
  registerOperator({ ...prev, poll: (ctx) => app.activeObject?.type === 'CURVES' || !prev.poll || prev.poll(ctx) });
});

// Edit Mode toolbar of Curves objects: the common selection / transform tools
toolsByMode.EDIT_CURVES = [...COMMON_TOOLS];
