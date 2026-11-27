// Stress analysis in the interface: the Analysis tab of the CommandManager,
// its commands and the study's rows in the design tree. This module is small
// and loaded with the app; the panels, the plots and the analysis worker are
// loaded the first time a command needs them, so a part without a study
// costs nothing more to open.

import { FIXTURE_ICONS, FIXTURE_LABELS, LOAD_ICONS, type FixtureType, type FeaLoadType, type StaticStudy } from '../../model/fea';
import type { FaceRef } from '../../model/types';
import { addIcons } from '../../ui/icons';
import { toast } from '../../ui/overlay';
import type { App, AppHooks } from '../app';
import type { CamRow } from '../cam';
import type { Command } from '../commands';
import type { RibbonTab } from '../shell';
import type { FeaWorkspace } from './workspace';

const P = (d: string, cls?: string): [string, Record<string, string>] => (cls ? ['path', { d, class: cls }] : ['path', { d }]);
const C = (cx: number, cy: number, r: number, cls?: string): [string, Record<string, string | number>] => (cls ? ['circle', { cx, cy, r, class: cls }] : ['circle', { cx, cy, r }]);

addIcons({
  // A bracket with a stress gradient.
  feaStudy: [P('M4 20V6h5v9h11v5z', 's'), P('M4 20V6h5v9h11v5z'), P('M6 8v2M6 12v2M11 17h2M15 17h2', 'a'), P('M14 3l3 3 3-3', 'thin')],
  feaFixed: [P('M7 4h12v10H7z', 's'), P('M7 4h12v10H7z'), P('M4 3v14'), P('M1 6l3-3M1 10l3-3M1 14l3-3M1 18l3-3', 'thin')],
  feaRoller: [P('M7 4h12v10H7z', 's'), P('M7 4h12v10H7z'), C(5, 7, 1.6, 'a'), C(5, 12, 1.6, 'a'), P('M2 3v14', 'thin')],
  feaHinge: [C(12, 10, 6, 's'), C(12, 10, 6), C(12, 10, 2, 'a'), P('M5 21h14M12 16v5', 'thin')],
  feaForce: [P('M4 15h16v5H4z', 's'), P('M4 15h16v5H4z'), P('M12 2v11', 'thick-a'), P('M9 10l3 3 3-3', 'a')],
  feaPressure: [P('M4 15h16v5H4z', 's'), P('M4 15h16v5H4z'), P('M6 4v8M12 4v8M18 4v8', 'a'), P('M4.5 10l1.5 2 1.5-2M10.5 10l1.5 2 1.5-2M16.5 10l1.5 2 1.5-2', 'a')],
  feaGravity: [P('M7 3h10v8H7z', 's'), P('M7 3h10v8H7z'), P('M12 12v9', 'thick-a'), P('M9 18l3 3 3-3', 'a'), P('M10 7h4', 'thin')],
  feaMesh: [P('M3 20L12 4l9 16z', 's'), P('M3 20L12 4l9 16z'), P('M7.5 12h9M12 20l-4.5-8M12 20l4.5-8', 'thin')],
  feaRun: [P('M6 4l14 8-14 8z', 'a'), P('M6 4l14 8-14 8z')],
  feaResults: [['rect', { x: 4, y: 3, width: 6, height: 18, rx: 1, class: 's' }], P('M4 7h6M4 11h6M4 15h6', 'thin'), P('M13 5h7M13 12h7M13 19h7')],
  feaReport: [P('M6 2h9l4 4v16H6z'), P('M15 2v4h4'), P('M9 18v-4M12 18v-7M15 18v-5', 'a')],
  feaProbe: [P('M3 21l6-6'), C(13, 11, 6, 's'), C(13, 11, 6), P('M11 11h4M13 9v4', 'thin')],
});

let loading: Promise<typeof import('./workspace')> | null = null;
let workspace: FeaWorkspace | null = null;

/** The analysis workspace, loaded (with the panels and the worker) the first time it is needed. */
export async function feaWorkspace(app: App): Promise<FeaWorkspace> {
  // A failed load (offline, an update replaced the files) is tried again by the next command.
  loading ??= import('./workspace').catch((e: unknown) => { loading = null; throw e; });
  const m = await loading;
  workspace ??= new m.FeaWorkspace(app);
  return workspace;
}

/** Runs fn with the workspace, loading it first; a failure to load or to start is told in a toast. */
export function withWorkspace(app: App, fn: (ws: FeaWorkspace) => unknown) {
  void feaWorkspace(app).then(
    (ws) => Promise.resolve().then(() => fn(ws)).catch((e) => toast({ kind: 'error', message: `The analysis could not start: ${(e as Error).message}` })),
    () => toast({ kind: 'error', message: 'The analysis could not be loaded. Check your connection and try again.' }),
  );
}

/** The workspace if it has been loaded (the design tree shows results only then). */
export function loadedFeaWorkspace(): FeaWorkspace | null {
  return workspace;
}

/** Index of a referenced face in the current part (by name, else the nearest face of the same kind and size), or -1. */
export function faceIndexOf(app: App, ref: FaceRef): number {
  const faces = app.faces;
  const i = faces.findIndex((f) => f.name === ref.name && !f.body);
  if (i >= 0) return i;
  let best = -1, bd = Infinity;
  faces.forEach((f, k) => {
    if (f.body || f.type !== ref.sig.type) return;
    const d = Math.hypot(f.center[0] - ref.sig.c[0], f.center[1] - ref.sig.c[1], f.center[2] - ref.sig.c[2]) + Math.abs(f.area - ref.sig.area) * 1e-3;
    if (d < bd) { bd = d; best = k; }
  });
  return bd < 1e-3 ? best : -1;
}

export function installFea(app: App, hooks: AppHooks) {
  const partOnly = () => !app.assembly && !app.inDrawing;
  const withWs = (fn: (ws: FeaWorkspace) => void | Promise<void>) => () => {
    if (!partOnly()) return;
    withWorkspace(app, fn);
  };
  const hasStudy = () => partOnly() && !!app.store.doc.study;
  const fixture = (type: FixtureType, desc: string, keywords: string): Command => ({
    id: `fea:${type}`, label: FIXTURE_LABELS[type], icon: FIXTURE_ICONS[type], description: desc, keywords: `fea analysis simulation fixture restraint support ${keywords}`,
    enabled: partOnly, run: withWs((ws) => ws.newFixture(type)),
  });
  const load = (type: FeaLoadType, label: string, desc: string, keywords: string): Command => ({
    id: `fea:${type}`, label, icon: LOAD_ICONS[type], description: desc, keywords: `fea analysis simulation load ${keywords}`,
    enabled: partOnly, run: withWs((ws) => ws.newLoad(type)),
  });
  const commands: Command[] = [
    {
      id: 'fea:study', label: 'Static Study', icon: 'feaStudy', keywords: 'fea finite element analysis stress simulation static linear',
      description: 'Set up a linear static stress analysis of the part: material, fixtures, loads and mesh.', enabled: partOnly, run: withWs((ws) => ws.openStudy()),
    },
    fixture('fixed', 'Hold faces so they cannot move.', 'fixed clamp encastre'),
    fixture('roller', 'Let faces slide along themselves but not move off them.', 'roller slider symmetry sliding'),
    fixture('hinge', 'Let a cylindrical face (a pin hole) only turn about its axis.', 'hinge pin pivot bearing'),
    load('force', 'Force', 'A total force on faces, normal to them or along a direction.', 'force newton push pull'),
    load('pressure', 'Pressure', 'A pressure on faces, normal to them.', 'pressure psi pascal'),
    load('gravity', 'Gravity', 'The part\'s own weight, from its material\'s density.', 'gravity weight self acceleration'),
    { id: 'fea:mesh', label: 'Mesh', icon: 'feaMesh', keywords: 'fea mesh element size tetrahedra coarse fine', description: 'Set the element size and mesh the part.', enabled: hasStudy, run: withWs((ws) => ws.openMesh()) },
    { id: 'fea:run', label: 'Run', icon: 'feaRun', keywords: 'fea solve run calculate analysis', description: 'Mesh the part and solve the study.', enabled: hasStudy, run: withWs((ws) => ws.run()) },
    {
      id: 'fea:results', label: 'Results', icon: 'feaResults', keywords: 'fea results stress displacement strain factor of safety plot von mises', description: 'Show the stress, displacement, strain and factor of safety plots.',
      enabled: hasStudy, run: withWs((ws) => ws.showResults()),
    },
    { id: 'fea:report', label: 'Report', icon: 'feaReport', keywords: 'fea report export csv print summary', description: 'Export the results summary as a CSV file or a printable report.', enabled: hasStudy, run: withWs((ws) => ws.report()) },
  ];
  app.commands.register(...commands);

  const tab: RibbonTab = {
    id: 'analysis', label: 'Analysis',
    groups: [
      [{ cmd: 'fea:study' }, { cmd: 'material' }],
      [{ cmd: 'fea:fixed' }, { stack: [{ cmd: 'fea:roller' }, { cmd: 'fea:hinge' }] }],
      [{ cmd: 'fea:force' }, { stack: [{ cmd: 'fea:pressure' }, { cmd: 'fea:gravity' }] }],
      [{ cmd: 'fea:mesh' }, { cmd: 'fea:run' }],
      [{ cmd: 'fea:results' }, { cmd: 'fea:report' }],
    ],
    labels: ['Study', 'Fixtures', 'Loads', 'Solve', 'Results'],
  };
  // After CAM, before Drafting.
  const at = hooks.ribbonTabs.findIndex((t) => t.id === 'drawing');
  hooks.ribbonTabs.splice(at < 0 ? hooks.ribbonTabs.length : at, 0, tab);
  // A part opened with a study shows its symbols when the tab is chosen (the workspace loads then).
  app.ribbonTabListeners.push((id) => { if (id === 'analysis' && app.store.doc.study && partOnly()) withWorkspace(app, (ws) => ws.redraw()); });
  // ...and when it is opened while the tab is shown (the symbols follow its first build).
  app.store.on((reason) => { if (reason === 'load' && app.ribbonTabId === 'analysis' && app.store.doc.study && partOnly()) withWorkspace(app, (ws) => ws.redraw()); });
}

// ---------- design tree ----------

export function feaTreeRows(app: App, expanded: (key: string) => boolean): CamRow[] {
  const s: StaticStudy | null | undefined = app.store.doc.study;
  if (!s || app.assembly) return [];
  const ws = loadedFeaWorkspace();
  const run = (fn: (ws: FeaWorkspace) => void) => () => withWorkspace(app, fn);
  const open = expanded('fea');
  const state = ws?.state() ?? 'none';
  const rows: CamRow[] = [{
    key: 'fea', label: s.name, icon: 'feaStudy', depth: 1, children: true, expanded: open, selected: false,
    muted: state === 'busy' ? ` ${ws?.progressText() ?? 'running'}` : '',
    action: () => { if (app.ribbonTabId !== 'analysis') app.setRibbonTab('analysis'); },
    open: run((w) => w.openStudy()),
    menu: (x, y) => app.openCommandMenu(['fea:run', 'fea:mesh', 'fea:results', 'fea:report', 'material'], x, y, 'Study menu'),
  }];
  if (!open) return rows;
  const missing = (faces: FaceRef[]) => (app.faces.length && faces.some((f) => faceIndexOf(app, f) < 0) ? { kind: 'error' as const, text: 'A face it uses is no longer in the part. Edit it and pick the faces again.' } : !faces.length ? { kind: 'error' as const, text: 'No faces picked' } : undefined);
  for (const f of s.fixtures) {
    rows.push({
      key: `fea:${f.id}`, label: f.name, icon: FIXTURE_ICONS[f.type], depth: 2, selected: ws?.focus === f.id, suppressed: !!f.suppressed, badge: missing(f.faces),
      action: run((w) => w.focusItem(f.id)), open: run((w) => w.editItem(f.id)), menu: (x, y) => withWorkspace(app, (w) => w.itemMenu(f.id, x, y)),
    });
  }
  for (const l of s.loads) {
    rows.push({
      key: `fea:${l.id}`, label: l.name, icon: LOAD_ICONS[l.type], depth: 2, selected: ws?.focus === l.id, suppressed: !!l.suppressed, badge: l.type === 'gravity' ? undefined : missing(l.faces),
      action: run((w) => w.focusItem(l.id)), open: run((w) => w.editItem(l.id)), menu: (x, y) => withWorkspace(app, (w) => w.itemMenu(l.id, x, y)),
    });
  }
  const mesh = ws?.meshText() ?? '';
  rows.push({
    key: 'fea:mesh', label: 'Mesh', icon: 'feaMesh', depth: 2, muted: mesh ? ` ${mesh}` : ' (not meshed)', selected: false,
    action: run((w) => w.openMesh()), open: run((w) => w.openMesh()), menu: (x, y) => app.openCommandMenu(['fea:mesh', 'fea:run'], x, y, 'Mesh menu'),
  });
  rows.push({
    key: 'fea:results', label: 'Results', icon: 'feaResults', depth: 2, selected: false,
    muted: state === 'none' ? ' (not run)' : state === 'busy' ? ' (running)' : '',
    badge: state === 'stale' ? { kind: 'warn', text: 'Out of date: the part or the study changed since it was run. Run it again.' } : state === 'error' ? { kind: 'error', text: ws?.errorText() ?? 'The study could not be solved' } : undefined,
    // Shows the results panel (with Run when there are none): a click in the tree does not start a solve.
    action: run((w) => void w.openResults()), open: run((w) => void w.openResults()), menu: (x, y) => app.openCommandMenu(['fea:results', 'fea:run', 'fea:report'], x, y, 'Results menu'),
  });
  return rows;
}

