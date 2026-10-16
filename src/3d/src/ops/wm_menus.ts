// Window-manager operators for menus and tools: named pie menus (wm.call_menu_pie), searching a
// single menu or only operators, setting tools by toolbar position or brush type, the select-tool
// pie (Alt W) and the tool shortcut prompt.
import { app, operators, registerOperators, type OpContext } from '../app/app';
import { activeTools } from '../app/prefs';
import { addKeys, keymaps, shortcutLabel, type KeyItem } from '../app/keymap';
import { openMenu, openPie, openSearch, type PieItem, type SearchEntry } from '../ui/menu';
import { NAMED_MENUS } from '../ui/topbar';
import { toolsFor, setActiveTool, type ToolDef } from '../editors/view3d/toolbar';
import { BRUSH_LISTS, isBrushMode } from '../paint/brushes';
import { falloffPie, orientationPie } from '../app/keys_extra';
import { menuEntries } from './screen';

// ---------------------------------------------------------------------------
// named pie menus

/** Pie menus wm.call_menu_pie can open by name. Modules may add theirs. */
export const NAMED_PIES: Record<string, () => void> = {
  VIEW3D_MT_orientations_pie: orientationPie,
  VIEW3D_MT_proportional_editing_falloff_pie: falloffPie,
};

/** Pies opened by an operator of their own. */
const PIE_OPS: Record<string, string> = {
  VIEW3D_MT_view_pie: 'view3d.pie_view',
  VIEW3D_MT_shading_pie: 'view3d.pie_shading',
  VIEW3D_MT_pivot_pie: 'view3d.pie_pivot',
  VIEW3D_MT_snap_pie: 'view3d.pie_snap',
  VIEW3D_MT_object_mode_pie: 'view3d.pie_mode',
};

/** Pies bound to a key in an editor's keymap: [keymap, key, modifiers]. */
const PIE_KEYS: Record<string, [string, string, ('shift' | 'ctrl' | 'alt')[]]> = {
  OUTLINER_MT_view_pie: ['Outliner', 'ACCENT_GRAVE', []],
  NODE_MT_view_pie: ['Node Editor', 'ACCENT_GRAVE', []],
  GRAPH_MT_view_pie: ['Graph Editor', 'ACCENT_GRAVE', []],
  GRAPH_MT_snap_pie: ['Graph Editor', 'S', ['shift']],
  GRAPH_MT_pivot_pie: ['Graph Editor', 'PERIOD', []],
  DOPESHEET_MT_view_pie: ['Dopesheet', 'ACCENT_GRAVE', []],
  DOPESHEET_MT_snap_pie: ['Dopesheet', 'S', ['shift']],
  NLA_MT_view_pie: ['NLA Editor', 'ACCENT_GRAVE', []],
  NLA_MT_snap_pie: ['NLA Editor', 'S', ['shift']],
  IMAGE_MT_view_pie: ['Image Generic', 'ACCENT_GRAVE', []],
  IMAGE_MT_pivot_pie: ['Image', 'PERIOD', []],
  IMAGE_MT_uvs_snap_pie: ['UV Editor', 'S', ['shift']],
  SEQUENCER_MT_view_pie: ['Sequencer', 'ACCENT_GRAVE', []],
  SEQUENCER_MT_preview_view_pie: ['SequencerPreview', 'ACCENT_GRAVE', []],
  SEQUENCER_MT_pivot_pie: ['SequencerPreview', 'PERIOD', []],
  CLIP_MT_view_pie: ['Clip', 'ACCENT_GRAVE', []],
  CLIP_MT_tracking_pie: ['Clip', 'E', []],
  CLIP_MT_solving_pie: ['Clip', 'S', ['shift']],
  CLIP_MT_marker_pie: ['Clip', 'E', ['shift']],
  CLIP_MT_reconstruction_pie: ['Clip', 'W', ['shift']],
  CLIP_MT_pivot_pie: ['Clip Editor', 'PERIOD', []],
  FILEBROWSER_MT_view_pie: ['File Browser', 'ACCENT_GRAVE', []],
  VIEW3D_MT_sculpt_mask_edit_pie: ['Sculpt', 'A', []],
  VIEW3D_MT_sculpt_automasking_pie: ['Sculpt', 'A', ['alt']],
  VIEW3D_MT_sculpt_face_sets_edit_pie: ['Sculpt', 'W', ['alt']],
  VIEW3D_MT_wpaint_vgroup_lock_pie: ['Weight Paint', 'K', []],
  GREASE_PENCIL_MT_snap_pie: ['Grease Pencil', 'S', ['shift']],
};

function keyItemFor(name: string): KeyItem | undefined {
  const k = PIE_KEYS[name];
  if (!k) return undefined;
  const [km, key, mods] = k;
  const items = (keymaps[km] ?? []).filter((it) => it.key === key && !it.inactive && !!it.shift === mods.includes('shift') && !!it.ctrl === mods.includes('ctrl') && !!it.alt === mods.includes('alt'));
  return items.find((it) => !it.when || it.when()) ?? undefined;
}

/** Open a pie menu by name; false when it is unknown or not available here. */
export function callPie(name: string, ctx?: OpContext): boolean {
  const fn = NAMED_PIES[name];
  if (fn) {
    fn();
    return true;
  }
  const op = PIE_OPS[name];
  if (op) {
    if (!app.poll(op, ctx?.area)) return false;
    app.run(op, {}, { area: ctx?.area });
    return true;
  }
  const k = keyItemFor(name);
  if (!k) return false;
  if (k.action) k.action();
  else if (k.menu) openMenu(k.menu(), { x: app.pointer.x, y: app.pointer.y }, { title: k.menuTitle });
  else if (k.op && app.poll(k.op)) app.run(k.op, k.props ?? {});
  else return false;
  return true;
}

/** Names wm.call_menu_pie knows. */
export function pieNames(): string[] {
  return [...new Set([...Object.keys(NAMED_PIES), ...Object.keys(PIE_OPS), ...Object.keys(PIE_KEYS)])].sort();
}

// ---------------------------------------------------------------------------
// tools

/** The selection tools (they share one toolbar slot). */
const SELECT_TOOLS: [string, string, string][] = [
  ['builtin.select', 'Tweak', 'select_tweak'],
  ['builtin.select_box', 'Select Box', 'select_box'],
  ['builtin.select_circle', 'Select Circle', 'select_circle'],
  ['builtin.select_lasso', 'Select Lasso', 'select_lasso'],
];
const selectIds = SELECT_TOOLS.map((t) => t[0]);

/** Toolbar tools of the current mode in order (separators dropped, alternates expanded when asked). */
function toolList(expand: boolean): ToolDef[] {
  const out: ToolDef[] = [];
  for (const t of toolsFor(app.doc.mode)) {
    if (!t) continue;
    if (expand && t.alternates) out.push(...t.alternates);
    else out.push(t);
  }
  return out;
}

function hasToolbar(ctx: OpContext) {
  return !ctx.area || ctx.area.type === 'VIEW_3D';
}

registerOperators([
  {
    idname: 'wm.call_menu_pie',
    label: 'Call Pie Menu',
    description: 'Open a pie menu by name at the pointer',
    undo: false,
    internal: true,
    props: [{ id: 'name', label: 'Name', type: 'string', default: '' }],
    exec: (ctx, p) => {
      if (callPie(String(p.name ?? ''), ctx)) return;
      app.report('WARNING', `Pie menu not available here: ${p.name}`);
      return 'CANCELLED';
    },
  },
  {
    idname: 'wm.search_single_menu',
    label: 'Search Single Menu',
    description: 'Search the entries of one menu (and its submenus)',
    undo: false,
    props: [
      { id: 'menu_idname', label: 'Menu Name', type: 'string', default: '' },
      { id: 'initial_query', label: 'Initial Query', type: 'string', default: '' },
    ],
    exec: (_c, p) => {
      const m = NAMED_MENUS[String(p.menu_idname ?? '')];
      if (!m) {
        app.report('WARNING', `Unknown menu: ${p.menu_idname}`);
        return 'CANCELLED';
      }
      openSearch(() => menuEntries([{ label: m[0], items: m[1] }]), undefined, undefined, `Search ${m[0]}…`, String(p.initial_query ?? ''));
    },
  },
  {
    idname: 'wm.search_operator',
    label: 'Operator Search',
    description: 'Search all operators by name and run one',
    undo: false,
    exec: (ctx) => {
      const area = ctx.area;
      openSearch(
        () => {
          const out: SearchEntry[] = [];
          for (const op of operators.values()) {
            if (op.internal) continue;
            out.push({ label: op.label, path: op.idname, shortcut: shortcutLabel(op.idname), disabled: !app.poll(op.idname, area), run: () => app.run(op.idname, {}, { area }) });
          }
          return out.sort((a, b) => a.label.localeCompare(b.label));
        },
        undefined,
        undefined,
        'Search operators…',
      );
    },
  },
  {
    idname: 'wm.tool_set_by_index',
    label: 'Set Tool by Index',
    description: 'Make the tool at a position in the toolbar the active one',
    undo: false,
    props: [
      { id: 'index', label: 'Index', type: 'int', default: 0, min: -100, max: 100 },
      { id: 'cycle', label: 'Cycle', type: 'bool', default: false },
      { id: 'expand', label: 'Expand', type: 'bool', default: true },
      { id: 'as_fallback', label: 'Set Fallback', type: 'bool', default: false, hidden: true },
      { id: 'space_type', label: 'Type', type: 'string', default: 'VIEW_3D', hidden: true },
    ],
    poll: hasToolbar,
    exec: (_c, p) => {
      const tools = toolList(!!p.expand);
      if (!tools.length) return 'CANCELLED';
      let i = Number(p.index);
      if (i < 0) i += tools.length;
      if (p.cycle) {
        // step from the active tool
        const cur = tools.findIndex((t) => t.id === activeTools[app.doc.mode]);
        i = cur < 0 ? 0 : (cur + (Number(p.index) < 0 ? -1 : 1) + tools.length) % tools.length;
      }
      const t = tools[i];
      if (!t) {
        app.report('WARNING', `The toolbar has no tool ${Number(p.index) + 1}`);
        return 'CANCELLED';
      }
      setActiveTool(t.id);
    },
  },
  {
    idname: 'wm.tool_set_by_brush_type',
    label: 'Set Tool by Brush Type',
    description: 'Make the brush of a given kind the active tool (e.g. DRAW, SMOOTH, MASK)',
    undo: false,
    props: [
      { id: 'brush_type', label: 'Brush Type', type: 'string', default: '' },
      { id: 'space_type', label: 'Type', type: 'string', default: 'VIEW_3D', hidden: true },
    ],
    poll: () => isBrushMode(app.doc.mode),
    exec: (_c, p) => {
      const mode = app.doc.mode;
      if (!isBrushMode(mode)) return 'CANCELLED';
      const want = String(p.brush_type ?? '').toUpperCase();
      const b = BRUSH_LISTS[mode].find((x) => x?.tool === want);
      if (!b) {
        app.report('WARNING', `No ${want.toLowerCase().replace(/_/g, ' ')} brush in this mode`);
        return 'CANCELLED';
      }
      if (b.pick) b.pick();
      else app.run('paint.brush_select', { brush: b.id });
    },
  },
  {
    idname: 'wm.toolbar_fallback_pie',
    label: 'Fallback Tool Pie Menu',
    description: 'Choose the selection tool from a pie menu',
    undo: false,
    poll: (ctx) => hasToolbar(ctx) && toolList(true).some((t) => selectIds.includes(t.id)),
    invoke: () => {
      const cur = activeTools[app.doc.mode];
      const item = (t: [string, string, string]): PieItem => ({ label: t[1], icon: t[2], active: t[0] === cur, action: () => setActiveTool(t[0]) });
      const by = (id: string) => item(SELECT_TOOLS.find((t) => t[0] === id)!);
      openPie('Fallback Tool', [by('builtin.select'), by('builtin.select_box'), by('builtin.select_lasso'), by('builtin.select_circle'), null, null, null, null], app.pointer.x, app.pointer.y, 'W');
      return 'CANCELLED';
    },
    exec: () => 'CANCELLED',
  },
  {
    idname: 'wm.toolbar_prompt',
    label: 'Toolbar Prompt',
    description: 'Press the letter of a tool to make it active (the status bar lists them)',
    undo: false,
    poll: hasToolbar,
    invoke: () => {
      const tools = toolList(true);
      const keyed = tools.filter((t) => t.shortcut && /^[A-Z]$/.test(t.shortcut));
      app.startModal({
        label: 'Toolbar Prompt',
        header: () => 'Press a tool key, Esc to cancel',
        status: () => keyed.map((t) => [t.shortcut!, t.label] as [string, string]),
        onKey: (e) => {
          if (e.type !== 'keydown') return true;
          if (e.key === 'Escape') return 'CANCELLED';
          const letter = e.code.startsWith('Key') ? e.code.slice(3) : '';
          const t = keyed.find((x) => x.shortcut === letter);
          if (t) {
            // switching tools is not an undo step: end the prompt as cancelled
            setActiveTool(t.id);
            return 'CANCELLED';
          }
          return true;
        },
        onPointerDown: () => 'CANCELLED',
        cancel: () => {},
      });
      return 'RUNNING_MODAL';
    },
    exec: () => 'CANCELLED',
  },
]);

addKeys('Window', [{ key: 'W', alt: true, op: 'wm.toolbar_fallback_pie' }]);
