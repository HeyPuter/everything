// 2D Animation: workspace templates ("+" ▸ 2D Animation) and the File ▸ New ▸ 2D Animation
// application template (camera + a grease pencil object ready to draw in Draw Mode).
import { app, operators } from '../app/app';
import { registerWorkspaceTemplate, A, H, V, type Workspace } from '../ui/screen';
import { shell, fileNewTemplates } from '../ui/shell';
import { startupDocument, newObject } from '../data/defaults';
import { setMode } from '../ops/object';
import { activeTools } from '../app/prefs';
import type { DocumentData } from '../data/types';
import { gpTable, newGreasePencil, newLayer, newGPMaterial, setKeyframe, emptyDrawing, gpTS, gpBrush, DRAW_PRESETS } from './data';

const BG: [number, number, number] = [0.951, 0.951, 0.951];

function canvasView() {
  return A('VIEW_3D', {
    camera: true,
    shading: {
      type: 'MATERIAL',
      background_type: 'VIEWPORT',
      background_color: BG,
      use_scene_world: true,
    },
    overlay: { show_axis_x: false, show_axis_y: false, show_cursor: false },
  });
}

export function animation2DWorkspace(): Workspace {
  return {
    name: '2D Animation',
    layout: H(0.826, V(0.83, canvasView(), A('DOPESHEET', { mode: 'GPENCIL' })), V(0.174, A('OUTLINER'), A('PROPERTIES', { tab: 'TOOL' }))),
    mode: 'PAINT_GREASE_PENCIL',
  };
}

export function fullCanvasWorkspace(): Workspace {
  return {
    name: '2D Full Canvas',
    layout: V(0.915, canvasView(), A('DOPESHEET', { mode: 'GPENCIL' })),
    mode: 'PAINT_GREASE_PENCIL',
  };
}

registerWorkspaceTemplate('2D Animation', animation2DWorkspace);
registerWorkspaceTemplate('2D Animation', fullCanvasWorkspace);

/** Document of the 2D Animation template: a front-facing camera and an empty "Stroke" object. */
export function animation2DDocument(): DocumentData {
  const doc = startupDocument();
  // keep only the camera
  for (const ob of Object.values(doc.objects)) {
    if (ob.type === 'CAMERA') continue;
    delete doc.objects[ob.id];
    doc.object_order = doc.object_order.filter((id) => id !== ob.id);
    for (const c of Object.values(doc.collections)) c.objects = c.objects.filter((id) => id !== ob.id);
    if (ob.data) {
      delete doc.meshes[ob.data];
      delete doc.lights[ob.data];
    }
  }
  doc.materials = {};
  const cam = Object.values(doc.objects).find((o) => o.type === 'CAMERA')!;
  cam.location = [0, -12, 0];
  cam.rotation_euler = [Math.PI / 2, 0, 0];
  const ca = doc.cameras[cam.data!];
  ca.lens = 50;
  ca.show_passepartout = true;
  ca.passepartout_alpha = 0.5;
  cam.select = false;
  const world = doc.scene.world ? doc.worlds[doc.scene.world] : null;
  if (world) {
    world.color = [...BG];
    const bg = world.tree.nodes.find((n) => n.type === 'ShaderNodeBackground');
    if (bg) bg.inputs.Color = [...BG, 1];
  }
  doc.scene.tool_settings.use_keyframe_insert_auto = true;
  doc.scene.frame_start = 1;
  doc.scene.frame_end = 250;
  doc.scene.render.fps = 24;

  const gp = newGreasePencil('Stroke');
  gp.use_ghost_custom_colors = true;
  gpTable(doc)[gp.id] = gp;
  const mats = [
    newGPMaterial('Solid Stroke', {
      color: [0, 0, 0, 1],
      fill_color: [0.5, 0.5, 0.5, 1],
    }),
    newGPMaterial('Squares Stroke', {
      color: [1, 0, 0, 1],
      mode: 'BOX',
      fill_color: [0, 0, 0, 0],
    }),
    newGPMaterial('Solid Fill', {
      show_stroke: false,
      show_fill: true,
      color: [0.216, 0.216, 0.216, 1],
      fill_color: [0.214, 0.214, 0.214, 1],
    }),
    newGPMaterial('Dots Stroke', {
      color: [0, 0, 0, 1],
      mode: 'DOTS',
      fill_color: [0, 0, 0, 0],
    }),
  ];
  for (const m of mats) {
    doc.materials[m.id] = m;
    gp.materials.push(m.id);
  }
  const fills = newLayer('Fills'),
    lines = newLayer('Lines');
  gp.layers.push(fills, lines);
  setKeyframe(gp, fills, 1, emptyDrawing());
  setKeyframe(gp, lines, 1, emptyDrawing());
  gp.active_layer_index = 1;
  const ob = newObject('Stroke', 'GREASEPENCIL', gp.id);
  ob.select = true;
  doc.objects[ob.id] = ob;
  doc.object_order.push(ob.id);
  const col = doc.collections[doc.scene.collection].children[0] ?? doc.scene.collection;
  doc.collections[col].objects.push(ob.id);
  doc.scene.active_object = ob.id;

  const ts = gpTS(doc);
  ts.gpencil_stroke_placement_view3d = 'ORIGIN';
  ts.gpencil_lock_axis = 'AXIS_Y';
  ts.gpencil_selectmode_edit = 'STROKE';
  const pencil = DRAW_PRESETS[0];
  ts.gpencil_draw_brush = pencil.id;
  Object.assign(gpBrush(doc, 'builtin.brush.Draw'), {
    size: pencil.size,
    strength: pencil.strength,
    use_pressure_size: pencil.use_pressure_size,
    use_pressure_strength: pencil.use_pressure_strength,
    pen_smooth_factor: pencil.smooth,
  });
  return doc;
}

/** Load the 2D Animation template: document, workspaces and Draw Mode. */
export function load2DAnimation() {
  app.setDocument(animation2DDocument());
  app.filename = 'untitled.blend';
  app.dirty = false;
  app.flush();
  if (shell) {
    shell.workspaces = [animation2DWorkspace(), fullCanvasWorkspace()];
    shell.layouts.clear();
    shell.active = '';
    shell.setWorkspace('2D Animation', false);
  }
  activeTools.PAINT_GREASE_PENCIL = 'builtin.brush.Draw';
  if (setMode(app.doc, 'PAINT_GREASE_PENCIL')) app.changed('mode');
  app.undo.reset(app.doc);
}

// File ▸ New ▸ 2D Animation
fileNewTemplates.push({
  label: '2D Animation',
  icon: 'outliner_ob_greasepencil',
  template: '2D_Animation',
});
const homefile = operators.get('wm.read_homefile');
if (homefile) {
  homefile.props = [
    ...(homefile.props ?? []),
    {
      id: 'app_template',
      label: 'Template',
      type: 'string',
      default: '',
      hidden: true,
    },
  ];
  const exec = homefile.exec;
  homefile.exec = (ctx, p) => {
    if (p.app_template === '2D_Animation') {
      load2DAnimation();
      return 'FINISHED';
    }
    return exec?.(ctx, p);
  };
}
