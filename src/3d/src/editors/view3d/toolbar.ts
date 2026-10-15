// Left toolbar (T) and tool settings header.
import { h, type Child } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app } from '../../app/app';
import { activeTools, uiState } from '../../app/prefs';
import type { View3D } from './view3d';
import { enumRow } from '../../ui/widgets';
import { openMenu } from '../../ui/menu';

export interface ToolDef {
  id: string;
  label: string;
  icon: string;
  shortcut?: string;
  description?: string;
  /** alternates shown when long-pressing (e.g. select box / circle / lasso) */
  group?: string;
}

const SELECT_TOOLS: ToolDef[] = [
  { id: 'builtin.select', label: 'Tweak', icon: 'select_tweak', group: 'select', description: 'Select and move by dragging' },
  { id: 'builtin.select_box', label: 'Select Box', icon: 'select_box', group: 'select', shortcut: 'W', description: 'Select items using box selection' },
  { id: 'builtin.select_circle', label: 'Select Circle', icon: 'select_circle', group: 'select', description: 'Select items using circle selection' },
  { id: 'builtin.select_lasso', label: 'Select Lasso', icon: 'select_lasso', group: 'select', description: 'Select items using lasso selection' },
];

const COMMON: (ToolDef | null)[] = [
  null,
  { id: 'builtin.cursor', label: 'Cursor', icon: 'cursor', description: 'Set the cursor location, drag to transform' },
  null,
  { id: 'builtin.move', label: 'Move', icon: 'transform_move', shortcut: 'G', description: 'Move selected items' },
  { id: 'builtin.rotate', label: 'Rotate', icon: 'transform_rotate', shortcut: 'R', description: 'Rotate selected items' },
  { id: 'builtin.scale', label: 'Scale', icon: 'transform_scale', shortcut: 'S', description: 'Scale (resize) selected items' },
  { id: 'builtin.transform', label: 'Transform', icon: 'transform', description: 'Supports any combination of grab, rotate, and scale at once' },
  null,
  { id: 'builtin.annotate', label: 'Annotate', icon: 'annotate', description: 'Draw free-hand annotation' },
  { id: 'builtin.measure', label: 'Measure', icon: 'measure', description: 'Measure distance and angles' },
];

export const COMMON_TOOLS = COMMON;

export const toolsByMode: Record<string, (ToolDef | null)[]> = {
  OBJECT: [...COMMON, null, { id: 'builtin.add_cube', label: 'Add Cube', icon: 'add_cube', description: 'Add a cube interactively' }],
  EDIT: [
    ...COMMON,
    null,
    { id: 'builtin.add_cube', label: 'Add Cube', icon: 'add_cube' },
    null,
    { id: 'builtin.extrude_region', label: 'Extrude Region', icon: 'extrude', shortcut: 'E', description: 'Extrude region together along the average normal' },
    { id: 'builtin.inset_faces', label: 'Inset Faces', icon: 'inset', shortcut: 'I', description: 'Inset new faces into selected faces' },
    { id: 'builtin.bevel', label: 'Bevel', icon: 'bevel', shortcut: 'Ctrl B', description: 'Cut into selected items at an angle to create bevel or chamfer' },
    { id: 'builtin.loop_cut', label: 'Loop Cut', icon: 'loopcut', shortcut: 'Ctrl R', description: 'Add a loop cut' },
    { id: 'builtin.knife', label: 'Knife', icon: 'knife', shortcut: 'K', description: 'Cut new topology' },
    { id: 'builtin.spin', label: 'Spin', icon: 'spin', description: 'Extrude the selection around the 3D cursor' },
    { id: 'builtin.smooth', label: 'Smooth', icon: 'smooth', description: 'Smooth vertices' },
    { id: 'builtin.edge_slide', label: 'Edge Slide', icon: 'edge_slide' },
    { id: 'builtin.shrink_fatten', label: 'Shrink/Fatten', icon: 'shrink_fatten', shortcut: 'Alt S' },
  ],
  POSE: [...COMMON],
};

/** Tool lists that other modules (sculpt/paint) extend. */
export const extraToolLists: Record<string, () => (ToolDef | null)[]> = {};

/** Edit Mode tools depend on the object type (mesh, armature, curve…). */
function toolKey(mode: string) {
  const t = app.activeObject?.type;
  return mode === 'EDIT' && t && t !== 'MESH' && toolsByMode[`EDIT_${t}`] ? `EDIT_${t}` : mode;
}

export function toolsFor(mode: string): (ToolDef | null)[] {
  if (extraToolLists[mode]) return extraToolLists[mode]();
  const key = toolKey(mode);
  const list = toolsByMode[key] ?? toolsByMode.OBJECT;
  // text editing has its own selection tool instead of box / circle / lasso
  return mode === 'SCULPT' || mode.endsWith('PAINT') || key === 'EDIT_FONT' ? list : [selectSlot(), ...list];
}

function selectSlot(): ToolDef {
  const cur = activeTools[app.doc.mode];
  return SELECT_TOOLS.find((t) => t.id === cur) ?? lastSelectTool();
}

let lastSel = 'builtin.select_box';
function lastSelectTool() {
  return SELECT_TOOLS.find((t) => t.id === lastSel)!;
}

/** Last used tool of each tool group (other than select), shown in the group's toolbar slot. */
const lastInGroup: Record<string, string> = {};

export function setActiveTool(id: string) {
  activeTools[app.doc.mode] = id;
  if (SELECT_TOOLS.some((t) => t.id === id)) lastSel = id;
  const t = toolsFor(app.doc.mode).find((x) => x?.id === id);
  if (t?.group && t.group !== 'select') lastInGroup[t.group] = id;
  app.changed('ui');
}

/** Collapse grouped tools into one slot each (the active or last used member). */
function groupSlots(tools: (ToolDef | null)[], cur: string): (ToolDef | null)[] {
  const shown = new Set<string>();
  return tools.filter((t) => {
    if (!t || !t.group || t.group === 'select') return true;
    if (shown.has(t.group)) return false;
    const members = tools.filter((x) => x?.group === t.group) as ToolDef[];
    const rep = members.find((x) => x.id === cur) ?? members.find((x) => x.id === lastInGroup[t.group!]) ?? members[0];
    if (rep !== t) return false;
    shown.add(t.group);
    return true;
  });
}

export function toolbar(v: View3D): Child {
  const mode = app.doc.mode;
  const cur = activeTools[mode];
  const all = toolsFor(mode);
  const tools = groupSlots(all, cur);
  return h(
    'div',
    { key: 'toolbar', class: 'v3d-toolbar' },
    tools.map((t, i) => {
      if (!t) return h('div', { key: `sep${i}`, class: 'tb-sep' });
      const isSelectSlot = t.group === 'select';
      const members = t.group && !isSelectSlot ? (all.filter((x) => x?.group === t.group) as ToolDef[]) : [];
      const alternates = isSelectSlot ? SELECT_TOOLS : members.length > 1 ? members : null;
      const active = t.id === cur;
      return h(
        'button',
        {
          key: t.id + i,
          class: { 'tb-tool': true, on: active, 'has-alt': !!alternates },
          'data-tool': t.id,
          'data-tip': `${t.label}${t.shortcut ? `\nShortcut: ${t.shortcut}` : ''}${t.description ? `\n${t.description}` : ''}`,
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            if (alternates && (e.button === 2 || e.detail > 1)) {
              openMenu(alternates.map((s) => ({ label: s.label, icon: s.icon, active: s.id === cur, action: () => setActiveTool(s.id) })), e.currentTarget as HTMLElement);
              return;
            }
            setActiveTool(t.id);
            // long press opens alternates
            if (alternates) {
              const el = e.currentTarget as HTMLElement;
              const timer = setTimeout(() => openMenu(alternates.map((s) => ({ label: s.label, icon: s.icon, active: s.id === activeTools[mode], action: () => setActiveTool(s.id) })), el), 350);
              const up = () => {
                clearTimeout(timer);
                removeEventListener('pointerup', up);
              };
              addEventListener('pointerup', up);
            }
          },
        },
        icon(t.icon),
      );
    }),
  );
  void v;
}

export function toolHeader(v: View3D): Child {
  const mode = app.doc.mode;
  const cur = activeTools[mode];
  const all = [...SELECT_TOOLS, ...(toolsFor(mode).filter(Boolean) as ToolDef[])];
  const t = all.find((x) => x.id === cur);
  const settings = toolSettingsFor(cur);
  return h('div', { class: 'tool-header' }, t ? h('span', { class: 'th-tool' }, icon(t.icon), h('span', null, t.label)) : null, settings);
  void v;
}

export const toolSettingsRenderers: Record<string, () => Child> = {};

function toolSettingsFor(id: string): Child {
  if (toolSettingsRenderers[id]) return toolSettingsRenderers[id]();
  if (id.startsWith('builtin.select')) {
    return enumRow(
      'sel-mode',
      [
        { value: 'SET', label: '', icon: 'select_box', description: 'Set a new selection' },
        { value: 'ADD', label: '', icon: 'add', description: 'Extend existing selection' },
        { value: 'SUB', label: '', icon: 'remove', description: 'Subtract existing selection' },
        { value: 'XOR', label: '', icon: 'sort', description: 'Invert existing selection' },
        { value: 'AND', label: '', icon: 'collapsemenu', description: 'Intersect existing selection' },
      ],
      uiState.selectMode,
      (m) => {
        uiState.selectMode = m as typeof uiState.selectMode;
        app.changed('ui');
      },
      { iconOnly: true },
    );
  }
  if (id === 'builtin.move' || id === 'builtin.rotate' || id === 'builtin.scale' || id === 'builtin.transform') {
    return h('span', { class: 'th-label' }, 'Drag the gizmo handles to transform; drag elsewhere to select.');
  }
  return null;
}
