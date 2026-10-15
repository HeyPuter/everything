// Sculpt Mode toolbar tools beyond the brushes: gesture tools (mask, hide, face set, trim, line
// project), filters and face set editing, with their tool header settings.
import { app } from '../app/app';
import { h, type Child } from '../ui/h';
import { checkbox, enumMenu, numberField } from '../ui/widgets';
import type { ToolDef } from '../editors/view3d/toolbar';
import type { View3D } from '../editors/view3d/view3d';
import { startGesture, type GestureShape } from './gesture';

type Target = 'mask' | 'hide' | 'face_set' | 'trim';

interface GestureToolInfo {
  target: Target;
  kind: GestureShape;
  op: string;
  label: string;
}

const SHAPE_LABEL: Record<GestureShape, string> = { BOX: 'Box', LASSO: 'Lasso', LINE: 'Line', POLYLINE: 'Polyline' };
const SHAPE_ICON: Record<GestureShape, string> = { BOX: 'box', LASSO: 'lasso', LINE: 'line', POLYLINE: 'polyline' };
const TARGET_LABEL: Record<Target, string> = { mask: 'Mask', hide: 'Hide', face_set: 'Face Set', trim: 'Trim' };
const OPS: Record<Target, Record<GestureShape, string>> = {
  mask: { BOX: 'paint.mask_box_gesture', LASSO: 'paint.mask_lasso_gesture', LINE: 'paint.mask_line_gesture', POLYLINE: 'paint.mask_polyline_gesture' },
  hide: { BOX: 'paint.hide_show', LASSO: 'paint.hide_show_lasso_gesture', LINE: 'paint.hide_show_line_gesture', POLYLINE: 'paint.hide_show_polyline_gesture' },
  face_set: { BOX: 'sculpt.face_set_box_gesture', LASSO: 'sculpt.face_set_lasso_gesture', LINE: 'sculpt.face_set_line_gesture', POLYLINE: 'sculpt.face_set_polyline_gesture' },
  trim: { BOX: 'sculpt.trim_box_gesture', LASSO: 'sculpt.trim_lasso_gesture', LINE: 'sculpt.trim_line_gesture', POLYLINE: 'sculpt.trim_polyline_gesture' },
};
const TIPS: Record<Target, string> = {
  mask: 'Mask the part of the mesh inside the shape (Ctrl: unmask)',
  hide: 'Hide the faces inside the shape (Ctrl: show)',
  face_set: 'Put the faces inside the shape into a new face set',
  trim: 'Cut the volume of the shape out of the mesh (or add it, depending on the trim mode)',
};

/** Gesture tool by toolbar id. */
export const gestureTools: Record<string, GestureToolInfo> = {};

/** Settings shared by the tools of each target (operator props). */
export const gestureSettings: Record<Target, Record<string, unknown>> = {
  mask: { mode: 'VALUE', value: 1, use_front_faces_only: false },
  hide: { area: 'INSIDE', use_front_faces_only: false },
  face_set: { use_front_faces_only: false },
  trim: { trim_mode: 'DIFFERENCE', trim_solver: 'MANIFOLD', trim_orientation: 'VIEW', trim_extrude_mode: 'FIXED', trim_location: 'DEPTH_SURFACE', use_cursor_depth: false },
};

function slot(target: Target, shapes: GestureShape[], available: (t: Target, k: GestureShape) => boolean): ToolDef | null {
  const alts: ToolDef[] = [];
  for (const kind of shapes) {
    if (!available(target, kind)) continue;
    const id = `builtin.${SHAPE_ICON[kind]}_${target}`;
    const label = `${SHAPE_LABEL[kind]} ${TARGET_LABEL[target]}`;
    gestureTools[id] = { target, kind, op: OPS[target][kind], label };
    alts.push({ id, label, icon: `${SHAPE_ICON[kind]}_${target}`, description: TIPS[target] });
  }
  if (!alts.length) return null;
  return { ...alts[0], alternates: alts.length > 1 ? alts : undefined };
}

const TRANSFORM_TOOLS: ToolDef[] = [
  { id: 'builtin.move', label: 'Move', icon: 'transform_move', description: 'Move the unmasked part of the mesh with the gizmo' },
  { id: 'builtin.rotate', label: 'Rotate', icon: 'transform_rotate', description: 'Rotate the unmasked part of the mesh around the pivot' },
  { id: 'builtin.scale', label: 'Scale', icon: 'transform_scale', description: 'Scale the unmasked part of the mesh around the pivot' },
  { id: 'builtin.transform', label: 'Transform', icon: 'transform', description: 'Move, rotate and scale with one gizmo' },
];

export const lineProjectTool: ToolDef = { id: 'builtin.line_project', label: 'Line Project', icon: 'line_project', description: 'Flatten the mesh on one side of a line onto the line' };
export const meshFilterTool: ToolDef = { id: 'builtin.mesh_filter', label: 'Mesh Filter', icon: 'mesh_filter', description: 'Deform the whole unmasked mesh: drag left or right to set the strength' };
export const faceSetEditTool: ToolDef = { id: 'builtin.face_set_edit', label: 'Edit Face Set', icon: 'face_set_edit', description: 'Click on a face set to grow or shrink it' };
export const maskByColorTool: ToolDef = { id: 'builtin.mask_by_color', label: 'Mask by Color', icon: 'mask_by_color', description: 'Click on the mesh to mask the vertices with a similar color' };

/** Sculpt toolbar entries after the brushes. */
export function sculptToolSlots(available: (op: string) => boolean): (ToolDef | null)[] {
  const all: GestureShape[] = ['BOX', 'LASSO', 'LINE', 'POLYLINE'];
  const has = (t: Target, k: GestureShape) => available(OPS[t][k]);
  const out: (ToolDef | null)[] = [slot('mask', all, has), slot('hide', all, has), slot('face_set', all, has), slot('trim', all, has)];
  if (available('sculpt.project_line_gesture')) {
    gestureTools[lineProjectTool.id] = { target: 'mask', kind: 'LINE', op: 'sculpt.project_line_gesture', label: 'Line Project' };
    out.push(lineProjectTool);
  }
  out.push(null);
  if (available('sculpt.mesh_filter')) out.push(meshFilterTool);
  if (available('sculpt.cloth_filter')) out.push({ id: 'builtin.cloth_filter', label: 'Cloth Filter', icon: 'cloth_filter', description: 'Deform the mesh like cloth: drag left / right to set the strength' });
  if (available('sculpt.color_filter')) out.push({ id: 'builtin.color_filter', label: 'Color Filter', icon: 'color_filter', description: 'Adjust the colors of the mesh: drag left / right to set the strength' });
  if (available('sculpt.face_set_edit')) out.push(faceSetEditTool);
  if (available('sculpt.mask_by_color')) out.push(maskByColorTool);
  // transform tools act on the unmasked mesh around the sculpt pivot
  out.push(null, ...TRANSFORM_TOOLS);
  return out.filter((t, i, a) => t || (i > 0 && a[i - 1]));
}

/** Pointer handlers of non-gesture sculpt tools (filters, face set editing). */
export const sculptToolHooks = {
  pointer: [] as ((v: View3D, e: PointerEvent, tool: string) => boolean)[],
};

/** LMB with a gesture tool active: start drawing the shape. */
export function gestureToolPointer(v: View3D, e: PointerEvent, toolId: string): boolean {
  const t = gestureTools[toolId];
  if (!t) return false;
  const isProject = toolId === lineProjectTool.id;
  const props = isProject ? { use_front_faces_only: false } : { ...gestureSettings[t.target] };
  const ctrlProps = t.target === 'mask' ? { value: 0 } : t.target === 'hide' ? { action: 'SHOW' } : undefined;
  return startGesture(v, { op: t.op, kind: t.kind, props, ctrlProps: isProject ? undefined : ctrlProps, label: t.label }, e);
}

// ---------------------------------------------------------------------------
// tool header settings

function changed() {
  app.changed('ui');
}

function settingsFor(toolId: string): Child {
  const t = gestureTools[toolId];
  if (!t) return null;
  if (toolId === lineProjectTool.id) return h('span', { class: 'th-label' }, 'Drag a line · F flips the side');
  const st = gestureSettings[t.target];
  const set = (k: string) => (x: unknown) => ((st[k] = x), changed());
  const front = checkbox(`th-g-front`, 'Front Faces Only', !!st.use_front_faces_only, set('use_front_faces_only'), { tip: 'Only affect faces facing the viewer' });
  const box = (w: number, c: Child) => h('div', { style: { width: `${w}px`, flex: 'none' } }, c);
  const hint = h('span', { class: 'th-label' }, t.kind === 'POLYLINE' ? 'Click points, click the first point to apply' : t.kind === 'LINE' ? 'Drag a line · F flips the side' : '');
  if (t.target === 'mask')
    return [
      box(
        120,
        enumMenu(
          'th-g-mode',
          [
            { value: 'VALUE', label: 'Value' },
            { value: 'VALUE_INVERSE', label: 'Value Inverted' },
            { value: 'INVERT', label: 'Invert' },
          ],
          String(st.mode),
          set('mode'),
          { tip: 'How the mask inside the shape changes' },
        ),
      ),
      box(130, numberField({ id: 'th-g-val', label: 'Value', value: st.value as number, min: 0, max: 1, slider: true, set: set('value') })),
      front,
      hint,
    ];
  if (t.target === 'hide')
    return [
      box(
        120,
        enumMenu(
          'th-g-area',
          [
            { value: 'INSIDE', label: 'Inside' },
            { value: 'OUTSIDE', label: 'Outside' },
          ],
          String(st.area),
          set('area'),
          { tip: 'Hide the faces inside or outside the shape' },
        ),
      ),
      front,
      hint,
    ];
  if (t.target === 'trim')
    return [
      box(
        120,
        enumMenu(
          'th-g-tmode',
          [
            { value: 'DIFFERENCE', label: 'Difference' },
            { value: 'UNION', label: 'Union' },
            { value: 'JOIN', label: 'Join' },
          ],
          String(st.trim_mode),
          set('trim_mode'),
          { tip: 'Cut the shape out of the mesh, add it to the mesh, or add it as separate geometry' },
        ),
      ),
      box(
        110,
        enumMenu(
          'th-g-torient',
          [
            { value: 'VIEW', label: 'View' },
            { value: 'SURFACE', label: 'Surface' },
          ],
          String(st.trim_orientation),
          set('trim_orientation'),
          { tip: 'Extrude the shape along the view or along the surface normal under the shape' },
        ),
      ),
      box(
        130,
        enumMenu(
          'th-g-tloc',
          [
            { value: 'DEPTH_SURFACE', label: 'Depth Surface' },
            { value: 'DEPTH_VOLUME', label: 'Depth Volume' },
          ],
          String(st.trim_location),
          set('trim_location'),
          { tip: 'Place the shape at the surface under it, or through the whole volume' },
        ),
      ),
      hint,
    ];
  return [front, hint];
}

export function registerToolSettings(renderers: Record<string, () => Child>) {
  for (const id of Object.keys(gestureTools)) renderers[id] = () => settingsFor(id);
}
