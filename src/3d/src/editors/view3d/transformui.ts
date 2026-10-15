// Transform tools in the viewport: Transform menus, the Shear / Bend / To Sphere / Push-Pull /
// Randomize tools of the edit toolbar, and their shortcuts.
import { app } from '../../app/app';
import { activeTools } from '../../app/prefs';
import { addKeys } from '../../app/keymap';
import { registerIcons } from '../../ui/icons';
import type { MenuItem } from '../../ui/menu';
import { h } from '../../ui/h';
import { editModeHooks } from './hooks';
import { toolsByMode, toolSettingsRenderers, type ToolDef } from './toolbar';

registerIcons({
  tosphere: '<rect class="s" x="2.5" y="2.5" width="11" height="11" rx="1" fill="none" stroke-width="1" stroke-dasharray="2 1.5" opacity=".7"/><circle class="s" cx="8" cy="8" r="5" fill="none" stroke-width="1.5"/>',
  push_pull: '<circle class="f" cx="8" cy="8" r="1.6"/><path class="s" d="M8 1.5v3.5M8 11v3.5M1.5 8H5M11 8h3.5" stroke-width="1.4"/><path class="f" d="M8 1l1.8 2.2H6.2zM8 15l1.8-2.2H6.2zM1 8l2.2-1.8v3.6zM15 8l-2.2-1.8v3.6z"/>',
  randomize: '<circle class="f" cx="3.5" cy="4" r="1.3"/><circle class="f" cx="9" cy="2.8" r="1.3"/><circle class="f" cx="13" cy="7" r="1.3"/><circle class="f" cx="6.5" cy="8.5" r="1.3"/><circle class="f" cx="3" cy="12.5" r="1.3"/><circle class="f" cx="10.5" cy="12" r="1.3"/>',
  bend: '<path class="s" d="M2 13.5h4.5a6 6 0 0 0 6-6V2" fill="none" stroke-width="2.4"/><path class="s" d="M2 13.5h4.5a6 6 0 0 0 6-6V2" fill="none" stroke-width="1" opacity=".35" transform="translate(-1 -1)"/>',
});

const isEdit = () => app.doc.mode === 'EDIT';
const isMeshEdit = () => isEdit() && app.activeObject?.type === 'MESH';
const isCurveEdit = () => isEdit() && app.activeObject?.type === 'CURVE';

/** Object ▸ Transform */
export function objectTransformMenu(): MenuItem[] {
  return [
    { label: 'Move', op: 'transform.translate', shortcut: 'G' },
    { label: 'Rotate', op: 'transform.rotate', shortcut: 'R' },
    { label: 'Scale', op: 'transform.resize', shortcut: 'S' },
    { separator: true },
    { label: 'To Sphere', op: 'transform.tosphere' },
    { label: 'Shear', op: 'transform.shear' },
    { label: 'Bend', op: 'transform.bend' },
    { label: 'Push/Pull', op: 'transform.push_pull' },
    { separator: true },
    { label: 'Align to Transform Orientation', op: 'transform.transform', props: { mode: 'ALIGN' } },
    { separator: true },
    { label: 'Randomize Transform', op: 'object.randomize_transform' },
    { label: 'Align Objects', op: 'object.align' },
  ];
}

/** Extra entries of the Mesh / Curve ▸ Transform menus (after Push/Pull). */
export function editTransformExtras(): MenuItem[] {
  return [
    { label: 'Shear', op: 'transform.shear', shortcut: 'Shift Ctrl Alt S' },
    { label: 'Bend', op: 'transform.bend', shortcut: 'Shift W' },
    { label: 'Warp', op: 'transform.vertex_warp' },
    { label: 'Randomize', op: 'transform.vertex_random' },
  ];
}

// ---------------------------------------------------------------------------
// tools

const TOOLS: ToolDef[] = [
  { id: 'builtin.push_pull', label: 'Push/Pull', icon: 'push_pull', description: 'Push selected items away from the pivot, or pull them towards it' },
  { id: 'builtin.shear', label: 'Shear', icon: 'shear', description: 'Slant selected items; drag sideways to shear along the view' },
  { id: 'builtin.to_sphere', label: 'To Sphere', icon: 'tosphere', description: 'Move selected items outward into a spherical shape' },
  { id: 'builtin.bend', label: 'Bend', icon: 'bend', description: 'Bend selected items between the 3D cursor and the mouse' },
  { id: 'builtin.randomize', label: 'Randomize', icon: 'randomize', description: 'Displace selected vertices by random amounts' },
];
const TOOL_OPS: Record<string, string> = {
  'builtin.push_pull': 'transform.push_pull',
  'builtin.shear': 'transform.shear',
  'builtin.to_sphere': 'transform.tosphere',
  'builtin.bend': 'transform.bend',
  'builtin.randomize': 'transform.vertex_random',
};

{
  const list = toolsByMode.EDIT;
  const at = list.findIndex((t) => t?.id === 'builtin.shrink_fatten');
  list.splice(at >= 0 ? at + 1 : list.length, 0, ...TOOLS);
}

// drag with one of these tools runs its operator (release confirms); a click still selects
editModeHooks.pointer.push((v, e) => {
  if (!isMeshEdit() || e.button !== 0 || e.altKey) return false;
  const op = TOOL_OPS[activeTools.EDIT];
  if (!op) return false;
  const sx = e.clientX,
    sy = e.clientY;
  const move = (ev: PointerEvent) => {
    if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
    cleanup();
    if (op === 'transform.vertex_random') app.run(op, {}, { invoke: false });
    else app.run(op, { release_confirm: true }, { event: { x: sx, y: sy } });
  };
  const up = () => {
    cleanup();
    const r = v.el.getBoundingClientRect();
    for (const hk of editModeHooks.pick) if (hk(v, sx - r.left, sy - r.top, { extend: e.shiftKey, toggle: e.shiftKey, deselectAll: !e.shiftKey })) break;
  };
  const cleanup = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  return true;
});

for (const t of TOOLS) toolSettingsRenderers[t.id] = () => h('span', { class: 'th-label' }, t.id === 'builtin.randomize' ? 'Drag to randomize the selection; adjust amount and seed in the Adjust Last Operation panel' : t.id === 'builtin.bend' ? 'Drag around the 3D cursor to bend; the distance sets the radius' : `Drag to ${t.label.toLowerCase()} the selection`);

// ---------------------------------------------------------------------------
// shortcuts

/** Curve ▸ Transform extras (shape tools and the control point radius). */
export function curveTransformExtras(): MenuItem[] {
  return [
    { separator: true },
    { label: 'To Sphere', op: 'transform.tosphere' },
    ...editTransformExtras(),
    { label: 'Push/Pull', op: 'transform.push_pull' },
    { separator: true },
    { label: 'Radius', op: 'transform.transform', props: { mode: 'CURVE_SHRINKFATTEN' }, shortcut: 'Alt S' },
  ];
}

addKeys('Mesh', [
  { key: 'T', ctrl: true, op: 'transform.tilt', when: isCurveEdit },
  { key: 'S', alt: true, op: 'transform.transform', props: { mode: 'CURVE_SHRINKFATTEN' }, when: isCurveEdit },
  { key: 'W', shift: true, op: 'transform.bend', when: () => isMeshEdit() || isCurveEdit() },
  { key: 'S', shift: true, ctrl: true, alt: true, op: 'transform.shear', when: () => isMeshEdit() || isCurveEdit() },
]);
