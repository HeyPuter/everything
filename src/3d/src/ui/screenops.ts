// Screen editing operators: split, join, swap and close areas, header region toggles,
// fullscreen exit, and the generic "Rename Active Item" panel.
import { app, registerOperators, type OpContext } from '../app/app';
import { addKeys } from '../app/keymap';
import { promptText } from './menu';
import type { Area, Side } from './screen';

/** The area an operator acts on: the one under the pointer (or the last active one). */
function areaOf(ctx: OpContext): Area | null {
  const a = (ctx.area ?? app.hoverArea ?? app.activeArea) as Area | null;
  return a && 'screen' in a ? a : null;
}

/** Sidebar (UI) and toolbar (TOOLS) toggles of the editors. */
const REGION_OPS: Record<string, Partial<Record<'UI' | 'TOOLS', string>>> = {
  VIEW_3D: { UI: 'view3d.toggle_sidebar', TOOLS: 'view3d.toggle_toolbar' },
  TEXT: { UI: 'text.toggle_sidebar' },
  FILE_BROWSER: { TOOLS: 'file.sidebar_toggle' },
};

const SIDES: [Side, string][] = [
  ['LEFT', 'Left'],
  ['RIGHT', 'Right'],
  ['UP', 'Up'],
  ['DOWN', 'Down'],
];

registerOperators([
  {
    idname: 'screen.area_split',
    label: 'Split Area',
    description: 'Split the area into two; the new area shows the same editor',
    undo: false,
    props: [
      { id: 'direction', label: 'Direction', type: 'enum', default: 'VERTICAL', items: [['HORIZONTAL', 'Horizontal', 'One area above the other'], ['VERTICAL', 'Vertical', 'Two areas side by side']] },
      { id: 'factor', label: 'Factor', type: 'float', default: 0.5, min: 0, max: 1, subtype: 'factor' },
    ],
    poll: (ctx) => !!areaOf(ctx),
    invoke: (ctx, p) => {
      const a = areaOf(ctx)!;
      a.screen.interactiveSplit(a, p.direction === 'HORIZONTAL' ? 'v' : 'h');
      return 'CANCELLED';
    },
    exec: (ctx, p) => {
      const a = areaOf(ctx)!;
      return a.screen.split(a, p.direction === 'HORIZONTAL' ? 'v' : 'h', p.factor as number) ? 'FINISHED' : 'CANCELLED';
    },
  },
  {
    idname: 'screen.area_join',
    label: 'Join Areas',
    description: 'Grow the area over a neighbour that shares a whole edge with it (the neighbour is removed)',
    undo: false,
    props: [{ id: 'direction', label: 'Direction', type: 'enum', default: 'PICK', items: [['PICK', 'Pick', 'Click the neighbour to remove'], ...SIDES] }],
    poll: (ctx) => !!areaOf(ctx) && areaOf(ctx)!.screen.areas.length > 1,
    invoke: (ctx, p) => {
      const a = areaOf(ctx)!;
      if (p.direction !== 'PICK') return app.run('screen.area_join', p, { invoke: false, area: a });
      a.screen.interactivePick(a, 'join');
      return 'CANCELLED';
    },
    exec: (ctx, p) => {
      const a = areaOf(ctx)!;
      const n = p.direction === 'PICK' ? null : a.screen.neighbour(a, p.direction as Side);
      if (!n) {
        app.report('WARNING', 'No neighbouring area shares that whole edge');
        return 'CANCELLED';
      }
      return a.screen.join(a, n) ? 'FINISHED' : 'CANCELLED';
    },
  },
  {
    idname: 'screen.area_swap',
    label: 'Swap Areas',
    description: 'Exchange the place of this area with another one',
    undo: false,
    props: [{ id: 'direction', label: 'Direction', type: 'enum', default: 'PICK', items: [['PICK', 'Pick', 'Click the area to swap with'], ...SIDES] }],
    poll: (ctx) => !!areaOf(ctx) && areaOf(ctx)!.screen.areas.length > 1,
    invoke: (ctx, p) => {
      const a = areaOf(ctx)!;
      if (p.direction !== 'PICK') return app.run('screen.area_swap', p, { invoke: false, area: a });
      a.screen.interactivePick(a, 'swap');
      return 'CANCELLED';
    },
    exec: (ctx, p) => {
      const a = areaOf(ctx)!;
      const n = p.direction === 'PICK' ? null : a.screen.neighbour(a, p.direction as Side);
      if (!n) return 'CANCELLED';
      a.screen.swapAreas(a, n);
    },
  },
  {
    idname: 'screen.area_close',
    label: 'Close Area',
    description: 'Remove the area; a neighbour takes its room',
    undo: false,
    poll: (ctx) => !!areaOf(ctx) && areaOf(ctx)!.screen.areas.length > 1,
    exec: (ctx) => areaOf(ctx)!.screen.close(areaOf(ctx)!),
  },
  {
    idname: 'screen.region_toggle',
    label: 'Toggle Region',
    description: 'Show or hide a region of the area (header or tool settings)',
    undo: false,
    props: [{ id: 'region_type', label: 'Region', type: 'enum', default: 'HEADER', items: [['HEADER', 'Header'], ['TOOL_HEADER', 'Tool Settings'], ['UI', 'Sidebar'], ['TOOLS', 'Toolbar']] }],
    poll: (ctx) => !!areaOf(ctx),
    exec: (ctx, p) => {
      const a = areaOf(ctx)!;
      if (p.region_type === 'TOOL_HEADER') {
        if (!a.editor.toolHeader) return 'CANCELLED';
        a.toggleToolHeader();
      } else if (p.region_type === 'UI' || p.region_type === 'TOOLS') {
        // editors toggle their side regions with their own operators
        const op = REGION_OPS[a.type]?.[p.region_type];
        if (!op || !app.poll(op, a)) return 'CANCELLED';
        app.run(op, {}, { area: a });
      } else a.setHeaderVisible(!a.showHeader);
    },
  },
  {
    idname: 'screen.header_toggle_menus',
    label: 'Show Menus',
    description: 'Show the header menus expanded, or collapsed into a single menu button',
    undo: false,
    poll: (ctx) => !!areaOf(ctx),
    exec: (ctx) => areaOf(ctx)!.setMenusShown(!areaOf(ctx)!.showMenus),
  },
  {
    idname: 'screen.region_flip',
    label: 'Flip Region',
    description: 'Move the header to the other side of the area',
    undo: false,
    poll: (ctx) => !!areaOf(ctx),
    exec: (ctx) => areaOf(ctx)!.flipHeaderSide(),
  },
  {
    idname: 'screen.back_to_previous',
    label: 'Back to Previous',
    description: 'Return from a maximized or fullscreen area to the full layout',
    undo: false,
    poll: (ctx) => !!areaOf(ctx)?.screen.maximized,
    exec: (ctx) => {
      const sc = areaOf(ctx)!.screen;
      sc.toggleMaximize(sc.maximized!);
    },
  },
  {
    idname: 'wm.call_panel',
    label: 'Call Panel',
    description: 'Open a popup panel (Rename Active Item: TOPBAR_PT_name)',
    undo: false,
    internal: true,
    props: [
      { id: 'name', label: 'Name', type: 'string', default: 'TOPBAR_PT_name' },
      { id: 'keep_open', label: 'Keep Open', type: 'bool', default: true, hidden: true },
    ],
    exec: (ctx, p) => {
      if (p.name !== 'TOPBAR_PT_name') {
        app.report('WARNING', `Unknown panel: ${p.name}`);
        return 'CANCELLED';
      }
      return renameActiveItem(ctx);
    },
  },
]);

/** F2: rename whatever is active in the editor under the pointer. */
function renameActiveItem(ctx: OpContext): 'CANCELLED' {
  const area = areaOf(ctx);
  const type = area?.type ?? 'VIEW_3D';
  const tryOp = (id: string) => (app.poll(id, area) ? (app.run(id, {}, { area }), true) : false);
  if (['SHADER', 'GEOMETRY', 'COMPOSITOR', 'TEXTURE_NODES'].includes(type) && tryOp('node.rename')) return 'CANCELLED';
  if (type === 'TEXT' || type === 'CONSOLE' || type === 'INFO') {
    const t = type === 'TEXT' ? (area!.editor as { text?: { name: string; id: string } | null }).text : null;
    if (t) {
      promptText('Rename Text', t.name, (name) => {
        if (!name || name === t.name) return;
        const taken = new Set(Object.values(app.doc.texts).filter((x) => x.id !== t.id).map((x) => x.name));
        let n = name;
        for (let i = 1; taken.has(n); i++) n = `${name}.${String(i).padStart(3, '0')}`;
        app.doc.texts[t.id].name = n;
        app.pushUndo('Rename Text');
        app.changed('doc');
      });
      return 'CANCELLED';
    }
  }
  if ((ctx.doc.mode === 'POSE' || (ctx.doc.mode === 'EDIT' && app.activeObject?.type === 'ARMATURE')) && tryOp('armature.rename')) return 'CANCELLED';
  if (tryOp('object.rename')) return 'CANCELLED';
  app.report('INFO', 'Nothing active to rename');
  return 'CANCELLED';
}

addKeys('Window', [
  { key: 'F2', op: 'wm.call_panel', props: { name: 'TOPBAR_PT_name' } },
]);
