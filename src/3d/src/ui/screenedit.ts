// Screen editing operators driven by the pointer (area edges, corner action zones, region edges,
// header context menu) and the screen-level helpers (screens / workspaces cycling, playback step
// and pause, the Info log window), plus the "Screen Editing" keymap entries.
import { app, registerOperators, type OpContext } from '../app/app';
import { openMenu } from './menu';
import { areaOfElement, newAreaId, type Area, type Screen } from './screen';
import { startRegionScale, regionEdgeAt } from './regionscale';
import { stopPlayback } from '../ops/screen';
import { shell } from './shell';
import { openAreaWindow } from './areawindow';

/** The screen (main window or area window) under a client point. */
function screenAt(x: number, y: number): Screen | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const areaEl = el?.closest<HTMLElement>('.area');
  if (areaEl) return areaOfElement.get(areaEl)?.screen ?? null;
  // on a divider: the screen whose element contains it
  const scr = el?.closest<HTMLElement>('.screen');
  if (!scr) return null;
  for (const a of scr.querySelectorAll<HTMLElement>(':scope > .area')) {
    const ar = areaOfElement.get(a);
    if (ar) return ar.screen;
  }
  return null;
}

const pointerOf = (ctx: OpContext) => ctx.event ?? app.pointer;
const areaOf = (ctx: OpContext): Area | null => {
  const a = (ctx.area ?? app.hoverArea ?? app.activeArea) as Area | null;
  return a && 'screen' in a ? a : null;
};

/** Window coordinates from the bottom-left corner (as scripts give them) → client coordinates. */
const fromWindow = (x: number, y: number) => ({ x, y: innerHeight - y });

let pausedDirection: false | 'forward' | 'reverse' = false;

registerOperators([
  {
    idname: 'screen.area_move',
    label: 'Move Area Edges',
    description: 'Move the edge between areas; dragging moves it with the pointer, Ctrl snaps to common proportions',
    undo: false,
    props: [
      { id: 'x', label: 'X', type: 'int', default: 0 },
      { id: 'y', label: 'Y', type: 'int', default: 0 },
      { id: 'delta', label: 'Delta', type: 'int', default: 0 },
      { id: 'snap', label: 'Snapping', type: 'bool', default: false },
    ],
    invoke: (ctx, p) => {
      if (p.delta) return app.run('screen.area_move', p, { invoke: false });
      const pt = pointerOf(ctx);
      const sc = screenAt(pt.x, pt.y);
      const e = sc?.edgeAtClient(pt.x, pt.y, 4);
      if (!sc || !e) return 'PASS_THROUGH';
      sc.dragEdge(e);
      return 'CANCELLED';
    },
    exec: (_ctx, p) => {
      const pt = fromWindow(Number(p.x), Number(p.y));
      const sc = screenAt(pt.x, pt.y);
      const e = sc?.edgeAtClient(pt.x, pt.y, 6);
      if (!sc || !e) {
        app.report('WARNING', 'No area edge at that position');
        return 'CANCELLED';
      }
      // positive deltas move vertical edges right and horizontal edges up
      sc.moveEdge(e, e.dir === 'h' ? Number(p.delta) : -Number(p.delta), !!p.snap);
    },
  },
  {
    idname: 'screen.actionzone',
    label: 'Handle Area Action Zones',
    description: 'Drag an area corner: inwards splits the area, into a neighbour joins them, Ctrl swaps, Shift opens a new window',
    undo: false,
    internal: true,
    props: [{ id: 'modifier', label: 'Modifier', type: 'int', default: 0, min: 0, max: 2 }],
    invoke: (ctx) => {
      const pt = pointerOf(ctx);
      const sc = screenAt(pt.x, pt.y);
      const a = sc?.cornerAt(pt.x, pt.y);
      if (!sc || !a) return 'PASS_THROUGH';
      sc.cornerGesture(a, new PointerEvent('pointerdown', { clientX: pt.x, clientY: pt.y }));
      return 'CANCELLED';
    },
  },
  {
    idname: 'screen.area_options',
    label: 'Area Edge Options',
    description: 'Options for the edge under the pointer: split, join the areas on either side, swap them',
    undo: false,
    invoke: (ctx) => {
      const pt = pointerOf(ctx);
      const sc = screenAt(pt.x, pt.y);
      const e = sc?.edgeAtClient(pt.x, pt.y, 4);
      if (!sc || !e) return 'PASS_THROUGH';
      openMenu(sc.areaOptions(e.dir, pt.x, pt.y), { x: pt.x, y: pt.y }, { title: 'Area Options' });
      return 'CANCELLED';
    },
  },
  {
    idname: 'screen.edge_merge',
    label: 'Merge Area Edge',
    description: 'Join the two areas on either side of the edge under the pointer (the larger one stays)',
    undo: false,
    props: [{ id: 'cursor', label: 'Cursor', type: 'vec2', default: [0, 0], hidden: true }],
    invoke: (ctx, p) => {
      const pt = pointerOf(ctx);
      return app.run('screen.edge_merge', { ...p, cursor: [pt.x, innerHeight - pt.y] }, { invoke: false });
    },
    exec: (_ctx, p) => {
      const c = p.cursor as number[];
      const pt = fromWindow(c[0], c[1]);
      const sc = screenAt(pt.x, pt.y);
      const e = sc?.edgeAtClient(pt.x, pt.y, 6);
      if (!sc || !e) return 'CANCELLED';
      const d = 6;
      const before = e.dir === 'h' ? sc.areaAt(pt.x - d, pt.y) : sc.areaAt(pt.x, pt.y - d);
      const after = e.dir === 'h' ? sc.areaAt(pt.x + d, pt.y) : sc.areaAt(pt.x, pt.y + d);
      if (!before || !after || before === after) return 'CANCELLED';
      const [keep, drop] = before.rect.w * before.rect.h >= after.rect.w * after.rect.h ? [before, after] : [after, before];
      if (!sc.canJoin(keep, drop)) {
        app.report('WARNING', 'Only areas that share a whole edge can be joined');
        return 'CANCELLED';
      }
      return sc.join(keep, drop) ? 'FINISHED' : 'CANCELLED';
    },
  },
  {
    idname: 'screen.region_scale',
    label: 'Scale Region Size',
    description: 'Drag the edge of a side region to resize it; dragging it nearly closed hides the region',
    undo: false,
    invoke: (ctx) => {
      const pt = pointerOf(ctx);
      return startRegionScale(pt.x, pt.y, (el) => areaOfElement.get(el) ?? null) ? 'CANCELLED' : 'PASS_THROUGH';
    },
    poll: () => true,
  },
  {
    idname: 'screen.region_context_menu',
    label: 'Region',
    description: 'Display the context menu of the region under the pointer (header: show header, tool settings, menus, flip)',
    undo: false,
    poll: (ctx) => !!areaOf(ctx),
    invoke: (ctx) => {
      const a = areaOf(ctx)!;
      const pt = pointerOf(ctx);
      openMenu(a.headerMenu(), { x: pt.x, y: pt.y }, { title: 'Header' });
      return 'CANCELLED';
    },
  },
  {
    idname: 'screen.new',
    label: 'New Screen',
    description: 'Add a copy of the current workspace layout as a new workspace',
    undo: false,
    poll: () => !!shell,
    exec: () => shell.duplicateWorkspace(shell.active),
  },
  {
    idname: 'screen.delete',
    label: 'Delete Screen',
    description: 'Remove the current workspace layout',
    undo: false,
    poll: () => !!shell && shell.workspaces.length > 1,
    exec: () => shell.deleteWorkspace(shell.active),
  },
  {
    idname: 'screen.screen_set',
    label: 'Set Screen',
    description: 'Switch to the next (or previous, negative delta) workspace layout',
    undo: false,
    props: [{ id: 'delta', label: 'Delta', type: 'int', default: 1 }],
    poll: () => !!shell,
    exec: (_ctx, p) => {
      const n = shell.workspaces.length;
      const i = shell.workspaces.findIndex((w) => w.name === shell.active);
      const d = Number(p.delta) || 0;
      shell.setWorkspace(shell.workspaces[(((i + d) % n) + n) % n].name);
    },
  },
  {
    idname: 'screen.animation_step',
    label: 'Animation Step',
    description: 'Advance playback by one frame (wrapping at the end of the frame range)',
    undo: false,
    exec: () => {
      const s = app.doc.scene;
      const [a, b] = s.use_preview_range ? [s.frame_preview_start ?? s.frame_start, s.frame_preview_end ?? s.frame_end] : [s.frame_start, s.frame_end];
      const dir = app.playing === 'reverse' ? -1 : 1;
      let f = s.frame_current + dir;
      if (f > b) f = a;
      if (f < a) f = b;
      app.setFrame(f);
    },
  },
  {
    idname: 'screen.animation_pause',
    label: 'Pause Animation',
    description: 'Pause playback at the current frame; run again to continue',
    undo: false,
    exec: () => {
      if (app.playing) {
        pausedDirection = app.playing;
        stopPlayback(false);
      } else if (pausedDirection) {
        const reverse = pausedDirection === 'reverse';
        pausedDirection = false;
        app.run('screen.animation_play', { reverse });
      } else return 'CANCELLED';
    },
  },
  {
    idname: 'screen.info_log_show',
    label: 'Show Info Log',
    description: 'Open the Info editor with the log of reports and operators in a new window',
    undo: false,
    exec: () => void openAreaWindow({ id: newAreaId(), type: 'INFO' }, { width: 640, height: 320, x: innerWidth / 2 - 320, y: innerHeight / 2 - 160 }),
  },
]);

/** Whether a client point is on a region edge (for status hints and tests). */
export const onRegionEdge = (x: number, y: number) => !!regionEdgeAt(x, y);
