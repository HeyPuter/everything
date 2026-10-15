// Shaped key selection for the Dope Sheet and Graph Editor: box (with axis range and
// handle options), circle (C) and lasso (Ctrl+right-drag) selection.
import { app, registerOperators, type OpContext, type Operator } from '../app/app';
import { addKeys } from '../app/keymap';
import type { SelectRegion } from '../editors/view3d/hooks';
import { AnimEditor, RULER_H, overMain } from './animeditor';
import type { Prefix } from './menus';

type Mode = 'SET' | 'ADD' | 'SUB';

function keyEd(ctx: OpContext, p: Prefix): AnimEditor | null {
  const ed = ctx.area?.editor;
  return ed instanceof AnimEditor && (ed as unknown as { prefix?: string }).prefix === p ? ed : null;
}

export function inSelectRegion(r: SelectRegion, x: number, y: number) {
  if (r.kind === 'box') return x >= Math.min(r.x0, r.x1) && x <= Math.max(r.x0, r.x1) && y >= Math.min(r.y0, r.y1) && y <= Math.max(r.y0, r.y1);
  if (r.kind === 'circle') return Math.hypot(x - r.x, y - r.y) <= r.r;
  let inside = false;
  const p = r.pts;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) if (p[i].y > y !== p[j].y > y && x < ((p[j].x - p[i].x) * (y - p[i].y)) / (p[j].y - p[i].y) + p[i].x) inside = !inside;
  return inside;
}

/** Select the editor's selectable points inside a region. */
export function regionSelect(ed: AnimEditor, region: SelectRegion, mode: Mode, includeHandles = true): number {
  const pts = ed.selectables(includeHandles);
  if (mode === 'SET') for (const p of ed.selectables(true)) p.set(false);
  let n = 0;
  for (const p of pts)
    if (inSelectRegion(region, p.x, p.y)) {
      p.set(mode !== 'SUB');
      n++;
    }
  return n;
}

const modeProp = {
  id: 'mode',
  label: 'Mode',
  type: 'enum' as const,
  default: 'SET',
  items: [
    ['SET', 'Set'],
    ['ADD', 'Extend'],
    ['SUB', 'Subtract'],
  ] as [string, string][],
};

/** Start a lasso gesture at a pointer event (used by the operator and Ctrl+right-drag). */
export function lassoGesture(ed: AnimEditor, e: { clientX: number; clientY: number }, mode: Mode, includeHandles = true, p?: Prefix) {
  const pts = [ed.local(e)];
  ed.overlay = { lasso: pts };
  ed.draw();
  const move = (ev: PointerEvent) => {
    const q = ed.local(ev);
    const last = pts[pts.length - 1];
    if (Math.hypot(q.x - last.x, q.y - last.y) > 2) pts.push(q);
    ed.draw();
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    ed.overlay = null;
    if (pts.length >= 3) {
      const prefix = p ?? ((ed as unknown as { prefix?: Prefix }).prefix as Prefix);
      app.run(`${prefix}.select_lasso`, { path: pts.map((q) => [Math.round(q.x), Math.round(q.y)]), mode, include_handles: includeHandles }, { area: ed.area, invoke: false });
    }
    ed.draw();
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}

function selectOps(p: Prefix): Operator[] {
  const poll = (ctx: OpContext) => !!keyEd(ctx, p);
  const graph = p === 'graph';
  return [
    {
      idname: `${p}.select_circle`,
      label: 'Circle Select',
      description: 'Paint a selection with a circular brush (LMB selects, Shift or MMB deselects, wheel resizes, RMB/Esc/Enter finishes)',
      props: [
        { id: 'x', label: 'X', type: 'int', default: 0, hidden: true },
        { id: 'y', label: 'Y', type: 'int', default: 0, hidden: true },
        { id: 'radius', label: 'Radius', type: 'int', default: 25, min: 1 },
        { ...modeProp, default: 'ADD' },
        ...(graph ? [{ id: 'include_handles', label: 'Include Handles', type: 'bool' as const, default: true }] : []),
      ],
      poll,
      exec: (ctx, pr) => {
        const ed = keyEd(ctx, p)!;
        regionSelect(ed, { kind: 'circle', x: pr.x as number, y: pr.y as number, r: pr.radius as number }, pr.mode as Mode, pr.include_handles !== false);
      },
      invoke: (ctx, pr) => {
        const ed = keyEd(ctx, p)!;
        let pos = ed.local({ clientX: app.pointer.x, clientY: app.pointer.y });
        let radius = (pr.radius as number) || 25;
        let painting: Mode | null = null;
        const show = () => {
          ed.overlay = { circle: { x: pos.x, y: pos.y, r: radius } };
          ed.draw();
        };
        const apply = () => {
          if (!painting) return;
          if (regionSelect(ed, { kind: 'circle', x: pos.x, y: pos.y, r: radius }, painting, pr.include_handles !== false)) app.changed('doc');
        };
        show();
        app.startModal({
          label: 'Circle Select',
          cursor: 'crosshair',
          header: () => 'Circle Select',
          status: () => [
            ['LMB', 'Select'],
            ['Shift/MMB', 'Deselect'],
            ['Wheel', 'Radius'],
            ['RMB/Esc', 'Finish'],
          ],
          onPointerMove(e) {
            pos = ed.local(e);
            show();
            apply();
          },
          onPointerDown(e) {
            if (e.button === 2) return 'FINISHED';
            painting = e.button === 1 || e.shiftKey || e.ctrlKey ? 'SUB' : 'ADD';
            apply();
            return undefined;
          },
          onPointerUp() {
            painting = null;
          },
          onWheel(e) {
            radius = Math.max(2, Math.min(500, radius * (e.deltaY > 0 ? 1 / 1.15 : 1.15)));
            show();
          },
          onKey(e) {
            if (e.type !== 'keydown') return true;
            if (e.key === 'Escape' || e.key === 'Enter') return 'FINISHED';
            if (e.key === '+' || e.key === '=') radius = Math.min(500, radius * 1.15);
            if (e.key === '-') radius = Math.max(2, radius / 1.15);
            show();
            return true;
          },
          cancel() {
            ed.overlay = null;
            ed.draw();
          },
          finish() {
            ed.overlay = null;
            ed.draw();
          },
        });
        return 'RUNNING_MODAL';
      },
    },
    {
      idname: `${p}.select_lasso`,
      label: 'Lasso Select',
      description: 'Select keyframes inside a freehand outline',
      props: [
        { id: 'path', label: 'Path', type: 'string', default: [], hidden: true },
        modeProp,
        ...(graph ? [{ id: 'include_handles', label: 'Include Handles', type: 'bool' as const, default: true }] : []),
      ],
      poll,
      invoke: (ctx, pr) => {
        const ed = keyEd(ctx, p)!;
        // wait for a left drag
        app.startModal({
          label: 'Lasso Select',
          cursor: 'crosshair',
          header: () => 'Lasso Select: drag to draw the outline',
          onPointerDown: (ev) => {
            if (ev.button === 0) lassoGesture(ed, ev, (pr.mode as Mode) === 'SET' && (ev.shiftKey || ev.ctrlKey) ? (ev.shiftKey ? 'ADD' : 'SUB') : (pr.mode as Mode), pr.include_handles !== false, p);
            return 'CANCELLED';
          },
          onKey: (ev) => (ev.key === 'Escape' ? 'CANCELLED' : true),
          cancel: () => {},
        });
        return 'RUNNING_MODAL';
      },
      exec: (ctx, pr) => {
        const ed = keyEd(ctx, p)!;
        const path = (pr.path as [number, number][]) ?? [];
        if (path.length < 3) return 'CANCELLED';
        regionSelect(ed, { kind: 'lasso', pts: path.map(([x, y]) => ({ x, y })) }, pr.mode as Mode, pr.include_handles !== false);
      },
    },
  ];
}

registerOperators([...selectOps('action'), ...selectOps('graph')]);

for (const [p, km] of [
  ['action', 'Dopesheet'],
  ['graph', 'Graph Editor'],
] as const)
  addKeys(km, [
    { key: 'C', op: `${p}.select_circle`, when: overMain },
    { key: 'B', alt: true, op: `${p}.select_box`, props: { axis_range: true }, when: overMain },
  ]);
addKeys('Dopesheet', [
  { key: 'L', op: 'action.select_linked', when: overMain },
  { key: 'T', shift: true, op: 'action.transform', props: { mode: 'TIME_SLIDE' }, when: overMain },
]);

/** Box selection with options (axis range covers all channels/values, handles optional). */
export function boxRegionSelect(ed: AnimEditor, r: { x0: number; y0: number; x1: number; y1: number }, mode: Mode, axisRange: boolean, includeHandles: boolean) {
  const box = axisRange ? { kind: 'box' as const, x0: r.x0, x1: r.x1, y0: RULER_H - 1e6, y1: 1e6 } : { kind: 'box' as const, ...r };
  regionSelect(ed, box, mode, includeHandles);
}
