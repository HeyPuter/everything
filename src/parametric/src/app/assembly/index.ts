// Sets up assemblies in the app: the New Assembly command, the Assembly
// ribbon tab and commands, switching the interface between part and
// assembly documents, and the context menus of components and mates.

import { Boxes, Expand, ListOrdered, Magnet, Move3d, PackagePlus, RefreshCw, SquaresIntersect, SquareArrowOutUpRight } from 'lucide';
import { type AssemblyDocument, MATE_LABELS, asAssembly, mateComps } from '../../model/assembly';
import type { Id } from '../../model/types';
import { type Location, sameLocation } from '../../platform/files';
import { addIcons, type IconNode } from '../../ui/icons';
import type { MenuItem } from '../../ui/menu';
import { toast } from '../../ui/overlay';
import type { App, AppHooks } from '../app';
import type { Command } from '../commands';
import type { FileOps } from '../fileops';
import type { RibbonTab } from '../shell';
import { AssemblyMode } from './mode';
import { ASSEMBLY_SOURCE, EXPLODED_SOURCE, assemblySource } from '../drawing-sources';
import { ExplodePanel, InterferencePanel, MatePanel, MovePanel, assemblyMassDialog, bomDialog, insertComponent, pickPart, updateParts } from './panels';

addIcons({
  assembly: Boxes as unknown as IconNode,
  insertComponent: PackagePlus as unknown as IconNode,
  mate: Magnet as unknown as IconNode,
  moveComponent: Move3d as unknown as IconNode,
  rotateComponent: 'rotate',
  explode: Expand as unknown as IconNode,
  interference: SquaresIntersect as unknown as IconNode,
  bom: ListOrdered as unknown as IconNode,
  updateParts: RefreshCw as unknown as IconNode,
  openPart: SquareArrowOutUpRight as unknown as IconNode,
  angle: [['path', { d: 'M4 20h16M4 20L15 5' }], ['path', { d: 'M11 20a7 7 0 0 0-2.4-5.3' }]],
  'mate:coincident': [['rect', { x: 6, y: 4, width: 12, height: 8, rx: 0.5, class: 'a' }], ['rect', { x: 4, y: 12, width: 16, height: 8, rx: 0.5 }]],
  'mate:parallel': [['path', { d: 'M4 17L14 7M10 21L20 11' }]],
  'mate:perpendicular': [['path', { d: 'M4 20h16M12 20V4' }], ['path', { d: 'M12 16h4v4' }]],
  'mate:tangent': [['circle', { cx: 12, cy: 10, r: 6, class: 'a' }], ['path', { d: 'M3 16h18' }]],
  'mate:concentric': [['circle', { cx: 12, cy: 12, r: 8 }], ['circle', { cx: 12, cy: 12, r: 3.5, class: 'a' }]],
  'mate:distance': 'smartDimension',
  'mate:angle': [['path', { d: 'M4 20h16M4 20L15 5' }], ['path', { d: 'M11 20a7 7 0 0 0-2.4-5.3' }]],
  'mate:lock': 'lock',
});

/** The tabs an assembly shows; part tabs (sketch, features...) are hidden. */
const ASSEMBLY_TABS = ['assembly', 'evaluate', 'view', 'drawing', 'annotation'];

export const ASSEMBLY_TAB: RibbonTab = {
  id: 'assembly', label: 'Assembly',
  groups: [
    [{ cmd: 'insertComponent' }, { cmd: 'mate' }],
    [{ stack: [{ cmd: 'moveComponent' }, { cmd: 'rotateComponent' }] }, { stack: [{ cmd: 'explodedView' }, { cmd: 'toggleExplode' }] }],
    [{ cmd: 'interference' }, { cmd: 'billOfMaterials' }],
    [{ stack: [{ cmd: 'updateParts' }, { cmd: 'openPart' }] }],
  ],
};

/**
 * Commands of parts that also work in an assembly (files, history, the view,
 * measuring...). Every other command is disabled while an assembly is open.
 */
const SHARED = new Set([
  'new', 'newAssembly', 'open', 'openDevice', 'save', 'saveAs', 'downloadPart', 'exportStep', 'exportStl', 'rename', 'share', 'properties', 'assistant',
  'undo', 'redo', 'redo2', 'rebuild', 'forceRebuild', 'repeat', 'delete', 'equations', 'options', 'measure', 'massProperties', 'sectionView',
  'zoomFit', 'zoomIn', 'zoomOut', 'previousView', 'normalTo', 'viewOrientation', 'displayStyle', 'toggleVisibility', 'perspective', 'showPlanes', 'showOrigin',
  'toggleTree', 'shortcutBar', 'shortcuts', 'shortcutsF1', 'github', 'about', 'openDrawing', 'backToModel',
]);
const sharedCommand = (id: string) => SHARED.has(id) || /^(view[A-Z]|style:|theme:|asm:|drawing:)/.test(id);

export function installAssembly(app: App, files: FileOps, hooks: AppHooks) {
  const c = app.commands;
  const mode = () => app.assembly;
  const asm = () => !!app.assembly;
  const doc = (): AssemblyDocument | null => (app.assembly ? asAssembly(app.store.doc) : null);
  /** Components the selection names: rows in the tree, or faces and edges in the graphics area. */
  const selectedComps = (): Id[] => {
    const m = mode();
    if (!m) return [];
    const out = new Set<Id>();
    for (const it of app.selection.items) {
      if (it.kind === 'feature' && m.component(it.id)) out.add(it.id);
      if (it.kind === 'face') { const x = m.faceComponent(it.index); if (x) out.add(x.id); }
      if (it.kind === 'edge') { const x = m.edgeComponent(it.index); if (x) out.add(x.id); }
    }
    return [...out];
  };
  const hasComps = () => !!doc()?.components.length;
  const openPanelWhenBuilt = (make: () => import('../pm').PropertyPanel | null) => {
    void app.whenBuilt().then(() => { const p = mode() ? make() : null; if (p) void app.openPanel(p); });
  };

  // Part commands are disabled in an assembly, with the reason in the status bar when one is tried.
  for (const cmd of c.all()) {
    if (sharedCommand(cmd.id)) continue;
    const enabled = cmd.enabled;
    cmd.enabled = () => !app.assembly && (enabled ? enabled() : true);
  }
  // Mass properties of an assembly weigh each component with its own material.
  const mass = c.get('massProperties');
  if (mass) {
    const run = mass.run;
    mass.run = () => (app.assembly ? assemblyMassDialog(app.assembly) : run());
  }

  const commands: Command[] = [
    { id: 'newAssembly', label: 'New Assembly', icon: 'assembly', keywords: 'assembly components mates new', description: 'Start a new assembly of parts.', run: () => files.newAssembly() },
    {
      id: 'insertComponent', label: 'Insert Components', icon: 'insertComponent', keywords: 'assembly add part component place instance', description: 'Place a part (or another instance of one) in the assembly.',
      enabled: asm,
      run: async () => {
        const m = mode();
        if (!m) return;
        const picked = await pickPart(app);
        if (picked && app.assembly === m) insertComponent(m, picked);
      },
    },
    {
      id: 'mate', label: 'Mate', icon: 'mate', keywords: 'constraint coincident concentric distance angle parallel assembly', description: 'Position components relative to each other with mates.',
      enabled: () => asm() && hasComps(),
      run: () => openPanelWhenBuilt(() => new MatePanel(mode()!)),
    },
    { id: 'moveComponent', label: 'Move Component', icon: 'moveComponent', keywords: 'drag translate', description: 'Drag components to move them within their mates.', enabled: () => asm() && hasComps(), run: () => openPanelWhenBuilt(() => new MovePanel(mode()!, false)) },
    { id: 'rotateComponent', label: 'Rotate Component', icon: 'rotateComponent', keywords: 'drag turn', description: 'Drag components to turn them within their mates.', enabled: () => asm() && hasComps(), run: () => openPanelWhenBuilt(() => new MovePanel(mode()!, true)) },
    { id: 'explodedView', label: 'Exploded View', icon: 'explode', keywords: 'explode step', description: 'Add a step that moves components apart to show how they fit.', enabled: () => asm() && hasComps(), run: () => openPanelWhenBuilt(() => new ExplodePanel(mode()!)) },
    {
      id: 'toggleExplode', label: 'Explode/Collapse', icon: 'explode', keywords: 'exploded view collapse', description: 'Switch between the exploded and the assembled view.',
      enabled: () => !!doc()?.explode.length, checked: () => !!doc()?.exploded,
      run: () => { const m = mode(); if (m) m.commit(m.doc.exploded ? 'Collapse' : 'Explode', (d) => { d.exploded = !d.exploded; }, false); },
    },
    { id: 'interference', label: 'Interference Detection', icon: 'interference', keywords: 'clash overlap collision check', description: 'Find components that overlap, and by how much.', enabled: () => asm() && hasComps(), run: () => openPanelWhenBuilt(() => new InterferencePanel(mode()!)) },
    { id: 'billOfMaterials', label: 'Bill of Materials', icon: 'bom', keywords: 'bom parts list quantity', description: 'The parts of the assembly with their quantities and materials.', enabled: asm, run: () => { const m = mode(); if (m) void bomDialog(m); } },
    {
      id: 'updateParts', label: 'Update Parts', icon: 'updateParts', keywords: 'reload refresh rebuild references', description: 'Read the part files again and take their latest saved versions.',
      enabled: () => asm() && !!doc()?.parts.some((p) => p.source),
      run: async () => {
        const m = mode();
        if (!m) return;
        const r = await updateParts(m);
        const parts = (n: string[]) => n.join(', ');
        if (r.updated.length) toast({ kind: 'success', message: `Updated ${parts(r.updated)}.` });
        else if (!r.missing.length) toast({ message: 'All parts are up to date.' });
        if (r.missing.length) toast({ kind: 'warning', message: `The part files of ${parts(r.missing)} could not be read: the copies kept in the assembly are used.`, timeout: 9000 });
      },
    },
    {
      id: 'openPart', label: 'Open Part', icon: 'openPart', keywords: 'edit part component', description: 'Open the part of the selected component to edit it. Save it, then come back: the assembly takes the change.',
      enabled: () => asm() && selectedComps().length === 1,
      run: () => void openPart(selectedComps()[0]),
    },
    {
      id: 'fixComponent', label: 'Fix', icon: 'lock', keywords: 'ground anchor', description: 'Fix the selected components where they are.',
      enabled: () => selectedComps().some((id) => !mode()!.component(id)?.fixed),
      run: () => { const ids = selectedComps(); mode()?.commit('Fix', (d) => { for (const x of d.components) if (ids.includes(x.id)) x.fixed = true; }); },
    },
    {
      id: 'floatComponent', label: 'Float', icon: 'unlock', keywords: 'unfix free', description: 'Let the selected components move.',
      enabled: () => selectedComps().some((id) => mode()!.component(id)?.fixed),
      run: () => { const ids = selectedComps(); mode()?.commit('Float', (d) => { for (const x of d.components) if (ids.includes(x.id)) x.fixed = false; }); },
    },
  ];
  c.register(...commands);

  // ---------- Open Part ----------

  /** The assembly the user came from, while one of its parts is open. */
  let returnTo: { location: Location; name: string } | null = null;
  async function openPart(compId: Id) {
    const m = mode();
    const comp = m?.component(compId);
    const part = comp && m!.doc.parts.find((p) => p.id === comp.part);
    if (!m || !part) return;
    const from = app.location ? { location: app.location, name: m.doc.name } : null;
    // No part file (an inserted STEP model), or its file was not found: the copy kept in the assembly opens.
    if (!part.source || m.missingParts.has(part.id)) {
      const pd = m.partDoc(part.id);
      if (!pd) return;
      if (!(await files.confirmDiscard('open the part'))) return;
      app.loadDocument(structuredClone(pd), null);
      app.store.dirty = true;
      const why = part.source ? `The part file of ${part.name} was not found (moved or deleted?): the copy kept in the assembly opened.` : `${part.name} has no part file of its own: it opened as a copy.`;
      toast({ message: `${why} Save it, then insert the saved part in the assembly to use your changes.`, timeout: 10000 });
      return;
    }
    if (!(await files.confirmDiscard('open the part'))) return;
    await files.openLocation(part.source as Location, part.name);
    if (asAssembly(app.store.doc) || !from) return;
    returnTo = from;
    toast({
      message: `Editing ${part.name} from ${from.name}. Save the part, then go back: the assembly takes the change.`, timeout: 0,
      actions: [{ label: `Back to ${from.name}`, primary: true, run: () => { const r = returnTo; returnTo = null; if (r) void files.openLocation(r.location, r.name); } }],
    });
  }

  // ---------- switching between part and assembly mode ----------

  let partTree = app.tree, partFlyout = app.flyout;
  app.assemblyTabs = new Set(ASSEMBLY_TABS);
  app.assemblyOnlyTabs = new Set(['assembly']);
  hooks.ribbonTabs.unshift(ASSEMBLY_TAB);
  const assistantNote = document.createElement('div');
  assistantNote.className = 'pm-msg info';
  assistantNote.setAttribute('role', 'status');
  assistantNote.textContent = 'The assistant works on parts. Open a part (Open Part on a component) to use it.';

  /** Part Properties is named for the open document. */
  const properties = c.get('properties');
  const partPropertiesLabel = properties?.label ?? '';
  const enter = () => {
    if (properties) properties.label = 'Assembly Properties...';
    const m = new AssemblyMode(app);
    m.onEdit = (id) => {
      const mt = m.doc.mates.find((x) => x.id === id);
      if (mt) { openPanelWhenBuilt(() => new MatePanel(m, mt)); return; }
      const st = m.doc.explode.find((x) => x.id === id);
      if (st) openPanelWhenBuilt(() => new ExplodePanel(m, st));
    };
    if (!app.assembly) { partTree = app.tree; partFlyout = app.flyout; }
    app.assembly = m;
    app.tree = m.tree;
    if (app.flyout !== m.flyout) { app.flyout.el.replaceWith(m.flyout.el); app.flyout = m.flyout; }
    app.viewport.tool = m.dragTool;
    // Drawings of the assembly show its components collapsed, or exploded (see drawing-sources.ts).
    app.drawing.sources.set(ASSEMBLY_SOURCE, assemblySource(app, m, false));
    app.drawing.sources.set(EXPLODED_SOURCE, assemblySource(app, m, true));
    m.onShow = () => { if (app.inDrawing) void app.drawing.refresh(); };
    app.setRibbonTab('assembly');
    // The assistant edits parts: in an assembly it says so instead of taking messages.
    const composer = document.querySelector<HTMLElement>('.assistant .as-composer');
    if (composer) { composer.inert = true; composer.before(assistantNote); }
    void checkPartsOnOpen(m);
  };
  const exit = () => {
    const m = app.assembly;
    if (!m) return;
    if (properties) properties.label = partPropertiesLabel;
    m.dispose();
    app.assembly = null;
    app.drawing.sources.delete(ASSEMBLY_SOURCE);
    app.drawing.sources.delete(EXPLODED_SOURCE);
    if (app.viewport.tool === m.dragTool) app.viewport.tool = null;
    app.tree = partTree;
    if (app.flyout === m.flyout) { m.flyout.el.replaceWith(partFlyout.el); app.flyout = partFlyout; }
    for (const el of app.shell.root.querySelectorAll<HTMLElement>('.sheet-tabs')) el.hidden = false;
    app.shell.statusSketch.hidden = true;
    app.setRibbonTab('features');
    const composer = document.querySelector<HTMLElement>('.assistant .as-composer');
    if (composer) composer.inert = false;
    assistantNote.remove();
    void app.kernel.assembly({ op: 'drop', keep: [] }).catch(() => undefined);
  };
  app.syncDocumentKind = () => {
    if (asAssembly(app.store.doc)) {
      if (app.assembly) exit();
      enter();
      // Back in the assembly a part was opened from: nothing more to go back to.
      if (returnTo && sameLocation(returnTo.location, app.location)) returnTo = null;
    } else exit();
  };

  /** On open, parts whose files were saved since the assembly took its copy are taken again. */
  async function checkPartsOnOpen(m: AssemblyMode) {
    if (!m.doc.parts.some((p) => p.source)) return;
    const wasDirty = app.store.dirty;
    const r = await updateParts(m).catch(() => null);
    if (!r || app.assembly !== m) return;
    if (r.updated.length) {
      toast({ kind: 'info', message: `${r.updated.join(', ')} changed since the assembly was saved: the assembly now uses the latest version. Save it to keep this.`, timeout: 9000 });
      // The update is a change to save, unless nothing else changed and the user undoes it.
      void wasDirty;
    }
    if (r.missing.length) toast({ kind: 'warning', message: `The part files of ${r.missing.join(', ')} were not found (moved or deleted?): the copies kept in the assembly are used.`, timeout: 9000 });
  }

  // ---------- context menus ----------

  const contextItems = hooks.contextItems;
  hooks.contextItems = (target, id) => (app.assembly ? assemblyContext(target, id) : contextItems(target, id));
  const quickActions = hooks.quickActions;
  hooks.quickActions = () => (app.assembly ? (selectedComps().length ? [{ cmd: 'mate' }, { cmd: 'openPart' }, { cmd: 'measure' }] : []) : quickActions());

  function assemblyContext(target: 'viewport' | 'feature' | 'reference', id?: Id): MenuItem[] {
    const m = mode()!;
    const d = m.doc;
    const sep: MenuItem = { separator: true };
    const cmd = (cid: string, extra: Partial<MenuItem> = {}): MenuItem => {
      const x = c.get(cid)!;
      return { label: x.label, icon: x.icon, shortcut: x.shortcut, disabled: !c.isEnabled(cid), run: () => c.run(cid), ...extra };
    };
    const view: MenuItem[] = [cmd('zoomFit'), { label: 'View Orientation', icon: 'viewOrientation', submenu: () => app.viewMenuItems() }, { label: 'Display Style', icon: 'shadedEdges', submenu: () => app.displayMenuItems() }];
    const mate = id ? d.mates.find((x) => x.id === id) : undefined;
    if (mate) {
      const ids = app.tree.targets(mate.id).filter((x) => d.mates.some((y) => y.id === x));
      return [
        { label: 'Edit Mate', icon: 'edit', run: () => m.edit(mate.id) },
        { label: 'Rename', icon: 'text', shortcut: 'F2', run: () => app.startRename(mate.id) },
        ...(mate.type !== 'perpendicular' && mate.type !== 'lock' && mate.type !== 'tangent' ? [{ label: 'Flip Mate Alignment', icon: 'reset', run: () => m.commit('Flip alignment', (x) => { for (const y of x.mates) if (y.id === mate.id) y.aligned = !y.aligned; }) } as MenuItem] : []),
        { label: mate.suppressed ? 'Unsuppress' : 'Suppress', icon: mate.suppressed ? 'eye' : 'eyeOff', run: () => m.commit(mate.suppressed ? 'Unsuppress' : 'Suppress', (x) => { for (const y of x.mates) if (ids.includes(y.id)) y.suppressed = mate.suppressed ? undefined : true; }) },
        sep,
        { label: 'Delete', icon: 'trash', shortcut: 'Delete', run: () => void m.deleteItems(ids) },
      ];
    }
    const step = id ? d.explode.find((x) => x.id === id) : undefined;
    if (step) {
      return [
        { label: 'Edit Step', icon: 'edit', run: () => m.edit(step.id) },
        { label: 'Rename', icon: 'text', shortcut: 'F2', run: () => app.startRename(step.id) },
        cmd('toggleExplode'), sep,
        { label: 'Delete', icon: 'trash', shortcut: 'Delete', run: () => void m.deleteItems([step.id]) },
      ];
    }
    const comps = id && m.component(id) ? app.tree.targets(id).filter((x) => m.component(x)) : selectedComps();
    if (comps.length) {
      const first = m.component(comps[0])!;
      const set = (label: string, f: (x: AssemblyDocument['components'][number]) => void, solve = true) => () => m.commit(label, (x) => { for (const y of x.components) if (comps.includes(y.id)) f(y); }, solve);
      const mates = d.mates.filter((x) => mateComps(x).includes(first.id));
      return [
        ...(target === 'viewport' ? [cmd('mate'), sep] : []),
        cmd('openPart', { label: `Open ${d.parts.find((p) => p.id === first.part)?.name ?? 'Part'}`, disabled: comps.length !== 1 }),
        { label: 'Rename', icon: 'text', shortcut: 'F2', disabled: comps.length !== 1, run: () => app.startRename(first.id) },
        sep,
        first.hidden ? { label: 'Show', icon: 'eye', run: set('Show', (y) => { delete y.hidden; }, false) } : { label: 'Hide', icon: 'eyeOff', run: set('Hide', (y) => { y.hidden = true; }, false) },
        first.suppressed ? { label: 'Unsuppress', icon: 'eye', run: set('Unsuppress', (y) => { delete y.suppressed; }) } : { label: 'Suppress', icon: 'eyeOff', run: set('Suppress', (y) => { y.suppressed = true; }) },
        first.fixed ? { label: 'Float', icon: 'unlock', run: set('Float', (y) => { y.fixed = false; }) } : { label: 'Fix', icon: 'lock', run: set('Fix', (y) => { y.fixed = true; }) },
        { label: 'Insert Another Instance', icon: 'insertComponent', disabled: comps.length !== 1, run: () => insertAnother(first.id) },
        ...(mates.length ? [{ label: 'Mates', icon: 'mate', submenu: () => mates.map((x) => ({ label: `${x.name} (${MATE_LABELS[x.type]})`, icon: `mate:${x.type}`, run: () => m.edit(x.id) })) } as MenuItem] : []),
        sep,
        { label: 'Delete', icon: 'trash', shortcut: 'Delete', run: () => void m.deleteItems(comps) },
        ...(target === 'viewport' ? [sep, ...view] : []),
      ];
    }
    const items: MenuItem[] = [cmd('insertComponent'), cmd('mate'), sep, ...view];
    if (target === 'reference') items.unshift({ label: 'Show/Hide Planes', icon: 'plane', run: () => c.run('showPlanes') }, sep);
    return items;
  }

  function insertAnother(compId: Id) {
    const m = mode();
    const comp = m?.component(compId);
    const pd = comp && m!.partDoc(comp.part);
    const part = comp && m!.doc.parts.find((p) => p.id === comp.part);
    if (!m || !pd || !part) return;
    insertComponent(m, { doc: pd, source: part.source, version: part.version, partId: part.id });
  }
}
