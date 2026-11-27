// CAM in the interface: the CAM tab of the CommandManager, its commands,
// the CAM rows of the design tree and their menus.

import type { CamOperation, CamSetup, CamOpType } from '../../model/cam';
import { CAM_OP_ICONS, CAM_OP_LABELS, findOp, newCamDoc, nextCamName } from '../../model/cam';
import { allocateId } from '../../model/document';
import type { Id } from '../../model/types';
import { addIcons } from '../../ui/icons';
import { type MenuItem, openMenu as showMenu } from '../../ui/menu';
import { confirmDialog, promptDialog, toast } from '../../ui/overlay';
import type { App, AppHooks } from '../app';
import type { Command } from '../commands';
import type { RibbonTab } from '../shell';
import { postDialog, toolLibraryDialog } from './dialogs';
import { CamPanel, OperationPanel, SetupPanel, defaultTool, newOperation } from './panels';
import { SimulationPanel } from './simulate-panel';
import { CamWorkspace } from './workspace';

const P = (d: string, cls?: string): [string, Record<string, string>] => (cls ? ['path', { d, class: cls }] : ['path', { d }]);
const C = (cx: number, cy: number, r: number, cls?: string): [string, Record<string, string | number>] => (cls ? ['circle', { cx, cy, r, class: cls }] : ['circle', { cx, cy, r }]);
const DASH = (d: string, dash = '2.5 2'): [string, Record<string, string>] => ['path', { d, 'stroke-dasharray': dash }];

addIcons({
  // An end mill over a block.
  cam: [P('M3 16l9-4 9 4-9 4z', 's'), P('M3 16v3l9 4 9-4v-3'), P('M10 2h4v4h-4z'), P('M10.5 6v5l1.5 1 1.5-1V6', 'a')],
  camSetup: [P('M3 15l9-4 9 4-9 4z', 's'), P('M3 15v3l9 4 9-4v-3'), P('M12 14V3'), P('M10 5l2-2 2 2'), C(12, 15, 1.2, 'f')],
  camStock: [P('M3 8l9-4 9 4-9 4z', 's'), P('M3 8v8l9 4 9-4V8'), P('M12 12v8')],
  camTool: [P('M9 2h6v6H9z'), P('M10 8v9l2 3 2-3V8', 'a'), P('M10 11l4-2M10 14l4-2', 'thin')],
  camTools: [P('M4 3h4v4H4zM10 3h4v4h-4zM16 3h4v4h-4z'), P('M5 7v9l1 2 1-2V7M11 7v11l1 2 1-2V7M17 7v7l1 2 1-2V7', 'a')],
  camFace: [P('M3 13l9-4 9 4-9 4z', 'a'), P('M3 13v4l9 4 9-4v-4'), P('M10 2h4v3h-4zM10.5 5v4h3V5'), DASH('M5 12l8 3.5M8 10.5l8 3.5')],
  camContour: [P('M5 9l7-3 7 3v7l-7 3-7-3z', 's'), P('M3 9.5l9-4.5 9 4.5v7.5l-9 4.5-9-4.5z'), P('M12 1v4', 'thin'), C(3, 10, 1.3, 'f')],
  camPocket: [P('M3 10l9-4 9 4v6l-9 4-9-4z', 's'), P('M7 11l5-2 5 2-5 2z', 'a'), P('M7 11v2l5 2 5-2v-2'), DASH('M9 11.2l3 1.2 3-1.2')],
  camDrill: [P('M3 15l9-4 9 4-9 4z', 's'), P('M3 15v3l9 4 9-4v-3'), P('M10.5 2h3v8l-1.5 3-1.5-3z', 'a'), P('M10.5 5l3-1.5M10.5 8l3-1.5', 'thin')],
  camBore: [P('M3 15l9-4 9 4-9 4z', 's'), P('M3 15v3l9 4 9-4v-3'), ['ellipse', { cx: 12, cy: 15, rx: 4, ry: 1.8 }], P('M14 3v7a2 2 0 0 1-2 2'), DASH('M8 6c0 2 8 2 8 0M8 9c0 2 8 2 8 0')],
  camRough: [P('M3 17l9-4 9 4-9 4z', 's'), P('M6 13l6-3 6 3M8 9l4-2 4 2', 'a'), P('M3 17v1l9 4 9-4v-1')],
  camParallel: [P('M3 18c4-9 14-9 18 0', 's'), P('M5 17c3-6 11-6 14 0'), DASH('M7 12l10 0M5.5 15h13M9 9.5h6')],
  camWaterline: [P('M5 20c0-8 3-16 7-16s7 8 7 16', 's'), P('M6.3 16h11.4M7.5 12h9M9.4 8h5.2', 'a')],
  camGenerate: [P('M4 18c3-8 6-8 8-4s5 4 8-6'), P('M16 8l4 0 0 4'), C(4, 18, 1.4, 'f')],
  camSimulate: [P('M3 15l9-4 9 4-9 4z', 's'), P('M3 15v3l9 4 9-4v-3'), P('M15 2v7l-1.5 2.5L12 9V2', 'a'), P('M7 13.5l3 1.5', 'thick-a')],
  camPost: [P('M6 2h9l4 4v16H6z'), P('M15 2v4h4'), P('M9 10h7M9 13h5M9 16h7', 'thin'), P('M2 13h3M4 11l2 2-2 2')],
  play: [P('M7 4l13 8-13 8z', 'a')],
  pause: [P('M7 4h3v16H7zM14 4h3v16h-3z', 'a')],
});

/** The setup new operations go in: the one focused, else the last one. */
function currentSetup(ws: CamWorkspace): CamSetup | null {
  const cam = ws.cam;
  if (!cam?.setups.length) return null;
  if (ws.focus) {
    const s = cam.setups.find((x) => x.id === ws.focus || x.ops.some((o) => o.id === ws.focus));
    if (s) return s;
  }
  return cam.setups[cam.setups.length - 1];
}

function newSetup(app: App, ws: CamWorkspace): CamSetup {
  const cam = ws.cam;
  const inch = app.store.doc.units === 'IPS';
  // A second setup usually machines the other side.
  const prev = cam?.setups[cam.setups.length - 1];
  const flip: Record<string, CamSetup['axis']> = { '+X': '-X', '-X': '+X', '+Y': '-Y', '-Y': '+Y', '+Z': '-Z', '-Z': '+Z' };
  return {
    id: '', name: nextCamName(cam?.setups.map((s) => s.name) ?? [], 'Setup'),
    axis: prev ? flip[prev.axis] : '+Y', rotation: 0, origin: 'topFrontLeft',
    stock: prev ? structuredClone(prev.stock) : { mode: 'offset', side: inch ? 2.54 : 2, top: inch ? 1.27 : 1, bottom: 0, size: [0, 0, 0] },
    clearance: inch ? 12.7 : 10, retract: inch ? 2.54 : 3, workOffset: prev ? Math.min(59, prev.workOffset + 1) : 54, ops: [],
  };
}

export function installCam(app: App, hooks: AppHooks): CamWorkspace {
  const ws = new CamWorkspace(app);
  app.cam = ws;
  const c = app.commands;
  const partOnly = () => !app.assembly && !app.inDrawing;
  const hasOps = () => partOnly() && !!ws.cam?.setups.some((s) => s.ops.length);

  const startSetup = () => {
    if (!partOnly()) return;
    const why = ws.ready();
    if (why) { toast({ kind: 'info', message: why }); return; }
    void ws.mesh().then(() => {
      const s = newSetup(app, ws);
      s.id = allocateId(app.store.doc, 's');
      app.exitModes();
      void app.openPanel(new SetupPanel(app, ws, s, true));
    });
  };

  const startOp = (type: CamOpType) => {
    if (!partOnly()) return;
    const why = ws.ready();
    if (why) { toast({ kind: 'info', message: why }); return; }
    let setup = currentSetup(ws);
    if (!setup) {
      // A first operation comes with the tool library and a setup from the top (one undo step).
      const s = newSetup(app, ws);
      app.store.change(ws.cam ? 'New setup' : 'Start CAM', (d) => {
        d.cam ??= newCamDoc((p) => allocateId(d, p), d.units === 'IPS');
        s.id = allocateId(d, 's');
        d.cam.setups.push(s);
      });
      setup = ws.cam!.setups[ws.cam!.setups.length - 1];
    }
    const cam = ws.cam!;
    const tool = defaultTool(cam.tools, type, cam.setups);
    if (!tool) { toast({ kind: 'warning', message: 'Add a tool to the tool library first.' }); void toolLibraryDialog(app, ws); return; }
    const op = newOperation(type, allocateId(app.store.doc, 'op'), nextCamName(cam.setups.flatMap((s) => s.ops.map((o) => o.name)), CAM_OP_LABELS[type].replace(/^\d+D /, '').replace(/\s+/g, '')), tool);
    // Pocket floors and holes picked beforehand go in.
    const faces = app.selection.ofKind('face').map((it) => app.faces[it.index]).filter(Boolean);
    if (op.type === 'pocket') op.faces = faces.filter((f) => f.type === 'plane').map((f) => ({ name: f.name, sig: { type: f.type, c: f.center, n: f.normal, area: f.area } }));
    if (op.type === 'drill' || op.type === 'bore') op.holes = faces.filter((f) => f.type === 'cylinder').map((f) => ({ face: { name: f.name, sig: { type: f.type, c: f.center, n: f.normal, area: f.area } } }));
    app.exitModes();
    void ws.mesh().then(() => app.openPanel(new OperationPanel(app, ws, setup.id, op, true)));
  };

  const opCommand = (type: CamOpType, desc: string, keywords: string): Command => ({
    id: `cam:${type}`, label: CAM_OP_LABELS[type], icon: CAM_OP_ICONS[type], description: desc, keywords: `cam machining cnc toolpath ${keywords}`,
    enabled: partOnly, run: () => startOp(type),
  });

  const commands: Command[] = [
    { id: 'cam:setup', label: 'Setup', icon: 'camSetup', keywords: 'cam machining cnc stock work origin wcs g54 fixture', description: 'Set how the part sits on the machine: the tool direction, the stock and the work origin.', enabled: partOnly, run: startSetup },
    { id: 'cam:tools', label: 'Tool Library', icon: 'camTools', keywords: 'cam end mill drill cutter feeds speeds', description: 'The cutting tools: end mills, ball and bull nose mills, drills and chamfer mills, with their feeds and speeds.', enabled: partOnly, run: () => void toolLibraryDialog(app, ws) },
    opCommand('face', 'Face the top of the stock down to the top of the part.', 'facing'),
    opCommand('contour', 'Cut round the outside of the part, with tabs to hold it.', 'profile 2d outside cutout'),
    opCommand('pocket', 'Clear pockets down to picked floors.', '2d pocketing clear'),
    opCommand('drill', 'Drill holes with a drilling cycle.', 'holes peck g81 g83'),
    opCommand('bore', 'Mill holes larger than the tool along a helix.', 'helical boring circular'),
    opCommand('rough', 'Remove the stock around the part in levels (3D roughing).', '3d adaptive clearing roughing'),
    opCommand('parallel', 'Finish surfaces with parallel passes (3D).', '3d finishing raster scallop'),
    opCommand('waterline', 'Finish walls with constant-height passes (3D).', '3d finishing contour z-level'),
    {
      id: 'cam:generate', label: 'Generate', icon: 'camGenerate', keywords: 'cam toolpath calculate regenerate', description: 'Generate the toolpaths that are not up to date.',
      enabled: hasOps, run: () => void ws.generate(),
    },
    {
      id: 'cam:simulate', label: 'Simulate', icon: 'camSimulate', keywords: 'cam simulation stock material removal verify collision gouge', description: 'Watch the stock being cut by the setup\'s operations, and check for gouges and collisions.',
      enabled: hasOps, checked: () => app.panel instanceof SimulationPanel,
      run: () => {
        if (app.panel instanceof SimulationPanel) { void app.closePanel(false); return; }
        const s = currentSetup(ws);
        if (!s) return;
        const why = ws.ready();
        if (why) { toast({ kind: 'info', message: why }); return; }
        app.exitModes();
        void app.openPanel(new SimulationPanel(app, ws, s.id));
      },
    },
    { id: 'cam:post', label: 'Post Process', icon: 'camPost', keywords: 'cam gcode g-code nc export cnc program fanuc haas grbl linuxcnc mach3', description: 'Write the toolpaths as G-code for a machine.', enabled: hasOps, run: () => void postDialog(app, ws) },
  ];
  c.register(...commands);

  const tab: RibbonTab = {
    id: 'cam', label: 'CAM',
    groups: [
      [{ cmd: 'cam:setup' }, { cmd: 'cam:tools' }],
      [{ cmd: 'cam:face' }, { stack: [{ cmd: 'cam:contour' }, { cmd: 'cam:pocket' }] }, { stack: [{ cmd: 'cam:drill' }, { cmd: 'cam:bore' }] }],
      [{ cmd: 'cam:rough' }, { stack: [{ cmd: 'cam:parallel' }, { cmd: 'cam:waterline' }] }],
      [{ cmd: 'cam:generate' }, { cmd: 'cam:simulate' }, { cmd: 'cam:post' }],
    ],
    labels: ['Setup', '2D', '3D', 'Program'],
  };
  // After Weldments, before Drafting.
  const at = hooks.ribbonTabs.findIndex((t) => t.id === 'drawing');
  hooks.ribbonTabs.splice(at < 0 ? hooks.ribbonTabs.length : at, 0, tab);

  // Undo, redo and edits may remove operations: their toolpaths go.
  app.store.on(() => {
    const cam = ws.cam;
    const ids = new Set(cam?.setups.flatMap((s) => s.ops.map((o) => o.id)) ?? []);
    ws.prune(ids);
    if (ws.focus && !ids.has(ws.focus) && !cam?.setups.some((s) => s.id === ws.focus)) ws.focus = null;
    // A setup or operation deleted while its panel is open: OK would bring it back.
    const p = app.panel;
    if ((p instanceof SetupPanel || p instanceof OperationPanel) && !p.present) void app.closePanel(false);
  });
  ws.listeners.add(() => app.renderTrees());
  return ws;
}

// ---------- design tree ----------

export interface CamRow {
  key: string;
  label: string;
  icon: string;
  depth: number;
  children?: boolean;
  expanded?: boolean;
  muted?: string;
  badge?: { kind: 'error' | 'warn'; text: string };
  selected?: boolean;
  suppressed?: boolean;
  action: () => void;
  open: () => void;
  menu: (x: number, y: number) => void;
}

export function camTreeRows(app: App, expanded: (key: string) => boolean): CamRow[] {
  const ws = app.cam;
  const cam = ws?.cam;
  if (!ws || !cam || !cam.setups.length || app.assembly) return [];
  const rows: CamRow[] = [];
  const show = (id: Id | null) => {
    ws.focus = id;
    if (app.ribbonTabId !== 'cam') app.setRibbonTab('cam');
    ws.changed();
  };
  const camOpen = expanded('cam');
  rows.push({
    key: 'cam', label: 'CAM', icon: 'cam', depth: 1, children: true, expanded: camOpen, selected: false,
    action: () => show(null), open: () => app.setRibbonTab('cam'),
    menu: (x, y) => app.openCommandMenu(['cam:setup', 'cam:tools', 'cam:generate', 'cam:post'], x, y, 'CAM menu'),
  });
  if (!camOpen) return rows;
  for (const s of cam.setups) {
    const key = `cam:${s.id}`;
    const open = expanded(key);
    rows.push({
      key, label: s.name, icon: 'camSetup', depth: 2, children: s.ops.length > 0, expanded: open, selected: ws.focus === s.id,
      action: () => show(s.id), open: () => editSetup(app, ws, s.id), menu: (x, y) => setupMenu(app, ws, s.id, x, y),
    });
    if (!open) continue;
    for (const o of s.ops) {
      const st = ws.state(s, o);
      const r = ws.result(o.id);
      const busy = ws.busy?.id === o.id ? ` ${Math.round(ws.busy.progress * 100)}%` : '';
      rows.push({
        key: `cam:${o.id}`, label: o.name, icon: CAM_OP_ICONS[o.type], depth: 3, selected: ws.focus === o.id, suppressed: !!o.suppressed,
        muted: st === 'busy' ? ` generating${busy}` : st === 'none' ? ' (not generated)' : '',
        badge: st === 'error' ? { kind: 'error', text: r?.error ?? 'Error' } : st === 'stale' ? { kind: 'warn', text: 'Out of date: generate it again' } : r?.toolpath?.warnings.length && st === 'ok' ? { kind: 'warn', text: r.toolpath.warnings.join(' ') } : undefined,
        action: () => show(o.id), open: () => editOp(app, ws, o.id), menu: (x, y) => opMenu(app, ws, o.id, x, y),
      });
    }
  }
  return rows;
}

function editSetup(app: App, ws: CamWorkspace, id: Id) {
  const s = ws.cam?.setups.find((x) => x.id === id);
  if (!s) return;
  app.exitModes();
  void ws.mesh().then(() => app.openPanel(new SetupPanel(app, ws, s, false)));
}

function editOp(app: App, ws: CamWorkspace, id: Id) {
  const f = ws.cam && findOp(ws.cam, id);
  if (!f) return;
  app.exitModes();
  void ws.mesh().then(() => app.openPanel(new OperationPanel(app, ws, f.setup.id, f.op, false)));
}

function openMenu(_app: App, items: MenuItem[], x: number, y: number, label: string) {
  showMenu(items, x, y, { label });
}

function setupMenu(app: App, ws: CamWorkspace, id: Id, x: number, y: number) {
  const s = ws.cam?.setups.find((v) => v.id === id);
  if (!s) return;
  const add = (type: CamOpType): MenuItem => ({ label: CAM_OP_LABELS[type], icon: CAM_OP_ICONS[type], run: () => { ws.focus = id; app.commands.run(`cam:${type}`); } });
  openMenu(app, [
    { label: 'Edit Setup', icon: 'edit', run: () => editSetup(app, ws, id) },
    { label: 'New Operation', icon: 'plus', submenu: () => (['face', 'contour', 'pocket', 'drill', 'bore', 'rough', 'parallel', 'waterline'] as CamOpType[]).map(add) },
    { separator: true },
    { label: 'Generate', icon: 'camGenerate', disabled: !s.ops.length, run: () => void ws.generate([id]) },
    { label: 'Simulate', icon: 'camSimulate', disabled: !s.ops.length, run: () => { ws.focus = id; app.commands.run('cam:simulate'); } },
    { label: 'Post Process...', icon: 'camPost', disabled: !s.ops.length, run: () => app.commands.run('cam:post') },
    { separator: true },
    { label: 'Rename', icon: 'text', run: () => void rename(app, s.name, (name) => app.store.change('Rename setup', (d) => { const v = d.cam?.setups.find((q) => q.id === id); if (v) v.name = name; })) },
    { label: 'Delete', icon: 'trash', run: () => void deleteSetup(app, ws, id) },
  ], x, y, 'Setup menu');
}

function opMenu(app: App, ws: CamWorkspace, id: Id, x: number, y: number) {
  const f = ws.cam && findOp(ws.cam, id);
  if (!f) return;
  const { setup, op } = f;
  const i = setup.ops.indexOf(op);
  const move = (d: number) => app.store.change(`Move ${op.name}`, (doc) => {
    const s = doc.cam?.setups.find((v) => v.id === setup.id);
    if (!s) return;
    const k = s.ops.findIndex((v) => v.id === id);
    const j = k + d;
    if (k < 0 || j < 0 || j >= s.ops.length) return;
    [s.ops[k], s.ops[j]] = [s.ops[j], s.ops[k]];
  });
  openMenu(app, [
    { label: 'Edit Operation', icon: 'edit', run: () => editOp(app, ws, id) },
    { label: 'Generate', icon: 'camGenerate', disabled: !!op.suppressed, run: () => { ws.forget([id]); void ws.generate([id]); } },
    { label: 'Tool Library...', icon: 'camTools', run: () => void toolLibraryDialog(app, ws, op.tool) },
    { separator: true },
    { label: 'Move Up', icon: 'chevronUp', disabled: i <= 0, run: () => move(-1) },
    { label: 'Move Down', icon: 'chevronDown', disabled: i >= setup.ops.length - 1, run: () => move(1) },
    { label: 'Duplicate', icon: 'copy', run: () => app.store.change(`Duplicate ${op.name}`, (d) => {
      const s = d.cam?.setups.find((v) => v.id === setup.id);
      if (!s) return;
      const copy: CamOperation = { ...structuredClone(op), id: allocateId(d, 'op'), name: nextCamName(d.cam!.setups.flatMap((v) => v.ops.map((o) => o.name)), op.name.replace(/\d+$/, '')) };
      s.ops.splice(s.ops.findIndex((v) => v.id === id) + 1, 0, copy);
    }) },
    { label: op.suppressed ? 'Unsuppress' : 'Suppress', icon: op.suppressed ? 'eye' : 'eyeOff', run: () => app.store.change(op.suppressed ? 'Unsuppress' : 'Suppress', (d) => {
      const o = d.cam && findOp(d.cam, id)?.op;
      if (o) o.suppressed = !o.suppressed || undefined;
    }) },
    { label: 'Rename', icon: 'text', run: () => void rename(app, op.name, (name) => app.store.change('Rename operation', (d) => { const o = d.cam && findOp(d.cam, id)?.op; if (o) o.name = name; })) },
    { separator: true },
    { label: 'Delete', icon: 'trash', run: () => app.store.change(`Delete ${op.name}`, (d) => { const s = d.cam?.setups.find((v) => v.id === setup.id); if (s) s.ops = s.ops.filter((v) => v.id !== id); }) },
  ], x, y, 'Operation menu');
}

async function rename(app: App, current: string, apply: (name: string) => void) {
  const name = await promptDialog('Rename', 'Name', current, (v) => (v.trim() ? null : 'Enter a name'), app.documentSignal);
  if (name && name.trim() !== current) apply(name.trim());
}

async function deleteSetup(app: App, ws: CamWorkspace, id: Id) {
  const s = ws.cam?.setups.find((v) => v.id === id);
  if (!s) return;
  if (s.ops.length && !(await confirmDialog('Delete setup', `Delete ${s.name} and its ${s.ops.length} operation${s.ops.length === 1 ? '' : 's'}?`, 'Delete', true, app.documentSignal))) return;
  if (app.panel instanceof CamPanel) await app.closePanel(false);
  app.store.change(`Delete ${s.name}`, (d) => { if (d.cam) d.cam.setups = d.cam.setups.filter((v) => v.id !== id); });
}
