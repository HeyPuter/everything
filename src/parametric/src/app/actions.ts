// Command definitions and where they appear: CommandManager tabs, menus,
// context menus and the selection quick-action toolbar.

import type { Feature, Id, SkDimension } from '../model/types';
import { isDimension } from '../model/types';
import { VIEWS, type ViewName } from '../render/camera';
import type { DisplayStyle } from '../render/renderer';
import { UNIT_SYSTEMS } from '../model/units';
import { setThemeChoice, getThemeChoice } from '../platform/theme';
import type { MenuItem } from '../ui/menu';
import { toast } from '../ui/overlay';
import { REPO_URL, type RibbonTab } from './shell';
import type { App, AppHooks } from './app';
import type { Command } from './commands';
import { panelFor, startFeature } from './panels';
import { SketchPanel } from './sketch/panel';
import {
  MeasurePanel, OffsetPanel, SectionPanel, aboutDialog, convertEntities, equationsDialog, massPropertiesDialog, materialDialog,
  mirrorSketchEntities, optionsDialog, propertiesDialog, shortcutsDialog,
} from './dialogs';
import type { FileOps } from './fileops';
import { shareDialog } from './share';
import { PropertyPanel, section } from './pm';
import type { SketchEditor, SkTool } from './sketch/editor';
import {
  centerArcTool, circleTool, dimensionTool, extendTool, lineTool, perimeterCircleTool, pointTool, polygonTool, rectangleTool,
  sketchFilletTool, slotTool, splineTool, tangentArcTool, threePointArcTool, trimTool,
} from './sketch/tools';
import { h } from '../ui/dom';
import type { PlaneRef } from '../model/types';

const SKETCH_TOOLS: Record<string, { label: string; shortcut?: string; desc: string; make: (ed: SketchEditor) => SkTool }> = {
  line: { label: 'Line', shortcut: 'L', desc: 'Sketch straight lines.', make: (ed) => lineTool(ed) },
  centerline: { label: 'Centerline', desc: 'Sketch construction lines used as axes and for symmetry.', make: (ed) => lineTool(ed, true) },
  rectangle: { label: 'Corner Rectangle', shortcut: 'R', desc: 'Sketch a rectangle from two corners.', make: (ed) => rectangleTool(ed) },
  centerRectangle: { label: 'Center Rectangle', desc: 'Sketch a rectangle from its centre.', make: (ed) => rectangleTool(ed, true) },
  circle: { label: 'Circle', shortcut: 'C', desc: 'Sketch a circle from its centre and radius.', make: (ed) => circleTool(ed) },
  perimeterCircle: { label: 'Perimeter Circle', desc: 'Sketch a circle through three points.', make: (ed) => perimeterCircleTool(ed) },
  centerArc: { label: 'Centerpoint Arc', desc: 'Sketch an arc from its centre, start and end.', make: (ed) => centerArcTool(ed) },
  tangentArc: { label: 'Tangent Arc', shortcut: 'A', desc: 'Sketch an arc tangent to the end of a line or arc.', make: (ed) => tangentArcTool(ed) },
  arc3: { label: '3 Point Arc', desc: 'Sketch an arc through its ends and a point on it.', make: (ed) => threePointArcTool(ed) },
  polygon: { label: 'Polygon', desc: 'Sketch a regular polygon.', make: (ed) => polygonTool(ed) },
  slot: { label: 'Straight Slot', desc: 'Sketch a slot with rounded ends.', make: (ed) => slotTool(ed) },
  spline: { label: 'Spline', desc: 'Sketch a smooth curve through points.', make: (ed) => splineTool(ed) },
  point: { label: 'Point', desc: 'Sketch points, for example to place holes.', make: (ed) => pointTool(ed) },
  smartDimension: { label: 'Smart Dimension', shortcut: 'D', desc: 'Add a dimension; its type depends on what you select and where you place it.', make: (ed) => dimensionTool(ed) },
  sketchFillet: { label: 'Sketch Fillet', desc: 'Round the corner between two lines.', make: (ed) => sketchFilletTool(ed) },
  trim: { label: 'Trim Entities', shortcut: 'T', desc: 'Remove parts of curves up to their intersections.', make: (ed) => trimTool(ed) },
  extend: { label: 'Extend Entities', desc: 'Extend a line to the next curve.', make: (ed) => extendTool(ed) },
};

export function registerCommands(app: App, files: FileOps) {
  const c = app.commands;
  const inSketch = () => !!app.sketchEditor;
  const noModes = () => !app.panel;
  const hasBody = () => !!app.bbox;
  const feature = (type: Feature['type'], label: string, iconName: string, desc: string, opts: { cut?: boolean; needsBody?: boolean; shortcut?: string; keywords?: string } = {}): Command => ({
    id: opts.cut ? `${type}Cut` : type,
    label,
    icon: iconName,
    description: desc,
    shortcut: opts.shortcut,
    keywords: opts.keywords,
    enabled: () => !opts.needsBody || hasBody(),
    run: () => {
      if (app.sketchEditor) {
        // Finish the sketch first; it becomes the profile.
        const id = app.sketchEditor.sketchId;
        app.exitSketch(true);
        app.selection.set([{ kind: 'feature', id }]);
      }
      const needsSketch = (type === 'extrude' || type === 'revolve') && !hasUsableSketch(app);
      if (needsSketch) {
        // No profile yet: sketch first, then continue with this command.
        app.pendingAfterSketch = opts.cut ? `${type}Cut` : type;
        void c.run('sketch');
        return;
      }
      const p = startFeature(app, type, { cut: opts.cut });
      if (p) void app.openPanel(p);
    },
  });

  const view = (name: ViewName, label: string, iconName: string, shortcut?: string): Command => ({
    id: `view${name[0].toUpperCase()}${name.slice(1)}`, label, icon: iconName, shortcut, keywords: 'view orientation standard',
    run: () => app.viewport.setView(name),
  });

  const style = (s: DisplayStyle, label: string, iconName: string): Command => ({
    id: `style:${s}`, label, icon: iconName, keywords: 'display style render',
    checked: () => app.renderer.displayStyle === s,
    run: () => { app.renderer.displayStyle = s; app.renderer.requestRender(); c.changed(); },
  });

  const toggle = (id: string, label: string, get: () => boolean, set: (v: boolean) => void, desc?: string): Command => ({
    id, label, description: desc, keywords: 'show hide visibility',
    checked: get,
    run: () => { set(!get()); app.viewport.refreshStates(); app.sketchEditor?.render(); app.saveSettings(); c.changed(); },
  });

  const tool = (id: string): Command => {
    const t = SKETCH_TOOLS[id];
    return {
      id: `tool:${id}`, label: t.label, icon: id === 'smartDimension' ? 'smartDimension' : id, shortcut: t.shortcut, description: t.desc, keywords: 'sketch draw',
      checked: () => app.sketchEditor?.tool?.id === id || (id === 'line' && app.sketchEditor?.tool?.id === 'line'),
      enabled: () => true,
      run: () => {
        if (!app.sketchEditor) {
          // Start a sketch first, then pick the tool.
          pendingTool = id;
          void c.run('sketch');
          return;
        }
        if (app.panel) void app.closePanel(false);
        const ed = app.sketchEditor;
        if (ed.tool?.id === id) { ed.setTool(null); return; }
        ed.setTool(t.make(ed));
      },
    };
  };
  let pendingTool: string | null = null;

  c.register(
    // ---- file ----
    { id: 'new', label: 'New', icon: 'new', shortcut: 'Ctrl+N', description: 'Start a new part.', run: () => files.newPart() },
    { id: 'open', label: 'Open...', icon: 'open', shortcut: 'Ctrl+O', description: 'Open a saved part.', run: () => files.open() },
    { id: 'openDevice', label: 'Open from Device...', icon: 'upload', description: 'Open a part file, or a STEP or SolidWorks file, from this device.', run: () => files.openFromDevice() },
    { id: 'save', label: 'Save', icon: 'save', shortcut: 'Ctrl+S', description: 'Save the part.', run: () => { void files.save(); } },
    { id: 'saveAs', label: 'Save As...', icon: 'save', shortcut: 'Ctrl+Shift+S', run: () => files.saveAs() },
    { id: 'downloadPart', label: 'Download Part File', icon: 'download', description: 'Download the part file to this device.', run: () => files.exportAs('part') },
    { id: 'exportStep', label: 'Export STEP...', icon: 'export', keywords: 'stp export cad', description: 'Export the solid as a STEP file.', enabled: hasBody, run: () => files.exportAs('step') },
    { id: 'exportStl', label: 'Export STL...', icon: 'export', keywords: '3d print mesh', description: 'Export the solid as an STL mesh for 3D printing.', enabled: hasBody, run: () => files.exportAs('stl') },
    { id: 'importStep', label: 'Import...', icon: 'import', keywords: 'stp step sldprt solidworks import', description: 'Insert a STEP file or SolidWorks part as a solid body.', run: () => files.importStep() },
    { id: 'rename', label: 'Rename Part...', icon: 'edit', run: () => files.rename() },
    { id: 'share', label: 'Share...', icon: 'share', keywords: 'collaborate invite team access', description: 'Let other Puter users view or edit this part.', run: () => shareDialog(app, files) },
    { id: 'properties', label: 'Part Properties...', icon: 'part', keywords: 'units decimals', description: 'Name, units and precision.', run: () => propertiesDialog(app) },
    // ---- edit ----
    {
      id: 'undo', label: 'Undo', icon: 'undo', shortcut: 'Ctrl+Z', enabled: () => app.store.canUndo,
      run: () => { if (app.panel) void app.closePanel(false); app.store.undo(); },
    },
    { id: 'redo', label: 'Redo', icon: 'redo', shortcut: 'Ctrl+Y', enabled: () => app.store.canRedo, run: () => app.store.redo() },
    { id: 'redo2', label: 'Redo', hidden: true, shortcut: 'Ctrl+Shift+Z', enabled: () => app.store.canRedo, run: () => app.store.redo() },
    { id: 'rebuild', label: 'Rebuild', icon: 'rebuild', shortcut: 'Ctrl+B', description: 'Rebuild the model.', run: () => app.requestRebuild(true) },
    { id: 'forceRebuild', label: 'Force Rebuild', icon: 'rebuild', shortcut: 'Ctrl+Q', description: 'Rebuild every feature from scratch.', run: () => { app.forceRebuild(); } },
    { id: 'repeat', label: 'Repeat Last Command', shortcut: 'Enter', hidden: true, enabled: () => !!c.lastRun && !app.panel, run: () => { if (c.lastRun) c.run(c.lastRun); } },
    {
      id: 'delete', label: 'Delete', icon: 'trash', shortcut: 'Delete',
      enabled: () => app.selection.items.some((x) => x.kind === 'feature' || x.kind.startsWith('sk')),
      run: () => { if (!app.sketchEditor?.deleteSelection()) void app.deleteFeatures(app.selection.ofKind('feature').map((x) => x.id)); },
    },
    {
      id: 'editFeature', label: 'Edit Feature', icon: 'edit', enabled: () => !!selectedFeature(app),
      run: () => { const f = selectedFeature(app); if (f) app.editFeature(f.id); },
    },
    {
      id: 'suppress', label: 'Suppress', icon: 'eyeOff', enabled: () => !!selectedFeature(app),
      run: () => app.toggleSuppress(app.selection.ofKind('feature').map((x) => x.id), true),
    },
    {
      id: 'unsuppress', label: 'Unsuppress', icon: 'eye', enabled: () => !!selectedFeature(app)?.suppressed,
      run: () => app.toggleSuppress(app.selection.ofKind('feature').map((x) => x.id), false),
    },
    { id: 'rollToEnd', label: 'Roll to End', icon: 'downToLine', enabled: () => app.store.doc.rollback != null, run: () => app.setRollback(null) },
    { id: 'material', label: 'Edit Material...', icon: 'material', keywords: 'density steel aluminum', run: () => materialDialog(app) },
    { id: 'appearance', label: 'Appearance...', icon: 'appearance', keywords: 'color colour', run: () => app.openTaskPane('appearance') },
    { id: 'equations', label: 'Equations...', icon: 'equations', keywords: 'variables parameters global', description: 'Global variables and equations that drive dimensions.', run: () => equationsDialog(app) },
    { id: 'options', label: 'Options...', icon: 'settings', keywords: 'settings preferences theme', run: () => optionsDialog(app) },
    // ---- sketch ----
    {
      id: 'sketch', label: 'Sketch', icon: 'sketch', description: 'Create a new sketch on a plane or planar face, or edit the selected sketch.',
      checked: inSketch,
      run: () => {
        if (app.sketchEditor) { app.exitSketch(true); return; }
        const sel = app.selection.items[0];
        if (sel?.kind === 'feature' && app.store.feature(sel.id)?.type === 'sketch') { app.editSketch(sel.id); return; }
        const ref = app.selectedPlaneRef();
        const after = () => { if (pendingTool && app.sketchEditor) { const t = pendingTool; pendingTool = null; c.run(`tool:${t}`); } };
        if (ref) { app.startSketchOn(ref); after(); return; }
        void app.openPanel(app.hooks.planePickPanel((r) => { app.startSketchOn(r); after(); }));
      },
    },
    { id: 'exitSketch', label: 'Exit Sketch', icon: 'sketch', enabled: inSketch, run: () => app.exitSketch(true) },
    ...Object.keys(SKETCH_TOOLS).map(tool),
    { id: 'offset', label: 'Offset Entities', icon: 'offset', description: 'Copy selected sketch curves at a distance.', enabled: inSketch, run: () => { void app.openPanel(new OffsetPanel(app)); } },
    { id: 'mirrorEntities', label: 'Mirror Entities', icon: 'mirrorEntities', description: 'Mirror selected sketch entities about a line.', enabled: inSketch, run: () => mirrorSketchEntities(app) },
    { id: 'convertEntities', label: 'Convert Entities', icon: 'convertEntities', description: 'Project selected model edges into the sketch.', enabled: inSketch, run: () => convertEntities(app) },
    { id: 'construction', label: 'Construction Geometry', icon: 'construction', shortcut: 'Q', description: 'Toggle selected sketch entities between normal and construction geometry.', enabled: inSketch, run: () => app.sketchEditor?.toggleConstruction() },
    {
      id: 'addRelation', label: 'Add Relation', icon: 'relation', description: 'Add geometric relations between selected sketch entities.', enabled: inSketch,
      run: () => { app.sketchEditor?.setTool(null); app.refreshSketchPanel(); app.setStatus('Select entities; the available relations appear in the PropertyManager.'); },
    },
    // ---- features ----
    feature('extrude', 'Extruded Boss', 'extrude', 'Extrude a sketch to add material.', { shortcut: 'E', keywords: 'extrusion pad boss' }),
    feature('revolve', 'Revolved Boss', 'revolve', 'Revolve a sketch around an axis to add material.', { keywords: 'revolution lathe' }),
    feature('extrude', 'Extruded Cut', 'extrudeCut', 'Extrude a sketch to remove material.', { cut: true, needsBody: true, keywords: 'pocket cut' }),
    feature('revolve', 'Revolved Cut', 'revolveCut', 'Revolve a sketch to remove material.', { cut: true, needsBody: true }),
    feature('sweep', 'Swept Boss', 'sweep', 'Sweep a profile along a path.', { keywords: 'pipe' }),
    feature('sweep', 'Swept Cut', 'sweep', 'Sweep a profile along a path to remove material.', { cut: true, needsBody: true }),
    feature('loft', 'Lofted Boss', 'loft', 'Blend between two or more profiles.', { keywords: 'blend' }),
    feature('loft', 'Lofted Cut', 'loft', 'Blend between profiles to remove material.', { cut: true, needsBody: true }),
    feature('fillet', 'Fillet', 'fillet', 'Round selected edges.', { needsBody: true, keywords: 'round radius blend' }),
    feature('chamfer', 'Chamfer', 'chamfer', 'Bevel selected edges.', { needsBody: true, keywords: 'bevel' }),
    feature('shell', 'Shell', 'shell', 'Hollow out the part, optionally removing faces.', { needsBody: true, keywords: 'hollow thickness' }),
    feature('hole', 'Hole', 'hole', 'Simple, counterbored or countersunk holes on a face.', { needsBody: true, keywords: 'drill counterbore countersink' }),
    feature('draft', 'Draft', 'draft', 'Taper faces relative to a neutral plane.', { needsBody: true, keywords: 'taper mould' }),
    feature('linearPattern', 'Linear Pattern', 'linearPattern', 'Repeat features along one or two directions.', { needsBody: true, keywords: 'array repeat' }),
    feature('circularPattern', 'Circular Pattern', 'circularPattern', 'Repeat features around an axis.', { needsBody: true, keywords: 'polar array' }),
    feature('mirror', 'Mirror', 'mirror', 'Mirror features or the body about a plane.', { needsBody: true, keywords: 'symmetry' }),
    feature('plane', 'Plane', 'plane', 'Create a reference plane offset from a plane or face.', { keywords: 'reference geometry datum' }),
    // ---- evaluate ----
    { id: 'measure', label: 'Measure', icon: 'measure', keywords: 'distance length angle area', description: 'Measure distances, lengths, angles and areas.', enabled: hasBody, run: () => { void app.openPanel(new MeasurePanel(app)); } },
    { id: 'massProperties', label: 'Mass Properties', icon: 'massProperties', keywords: 'volume weight inertia center of mass', description: 'Volume, mass, centre of mass and inertia.', enabled: hasBody, run: () => massPropertiesDialog(app) },
    {
      id: 'sectionView', label: 'Section View', icon: 'sectionView', keywords: 'cut clip', description: 'Show the part cut by a plane.',
      checked: () => !!app.renderer.section,
      run: () => {
        if (app.renderer.section && !(app.panel instanceof SectionPanel)) { app.renderer.section = null; app.renderer.requestRender(); c.changed(); return; }
        void app.openPanel(new SectionPanel(app));
      },
    },
    // ---- view ----
    { id: 'zoomFit', label: 'Zoom to Fit', icon: 'zoomFit', shortcut: 'F', run: () => (app.inDrawing ? app.drawing.fit() : app.viewport.zoomToFit()) },
    // ---- drawing ----
    { id: 'openDrawing', label: 'Make Drawing', icon: 'file', keywords: 'drawing sheet 2d views print pdf', description: 'Open the 2D drawing of this part with standard views.', enabled: () => hasBody() || !!app.store.doc.drawing, run: () => app.openDrawing() },
    { id: 'backToModel', label: 'Back to Model', icon: 'part', enabled: () => app.inDrawing, run: () => app.closeDrawing() },
    { id: 'drawing:arrange', label: 'Standard Views', icon: 'viewOrientation', description: 'Arrange front, top, right and isometric views at a fitting scale.', enabled: () => app.inDrawing && hasBody(), run: () => app.drawing.relayout() },
    ...(['front', 'top', 'right', 'left', 'back', 'bottom', 'isometric'] as const).map((k): Command => ({
      id: `drawing:add:${k}`, label: `${k[0].toUpperCase()}${k.slice(1)} View`, icon: k === 'isometric' ? 'viewIso' : `view${k[0].toUpperCase()}${k.slice(1)}`, enabled: () => app.inDrawing && hasBody(), run: () => app.drawing.addView(k),
    })),
    { id: 'drawing:pdf', label: 'Export PDF', icon: 'download', keywords: 'print drawing', enabled: () => !!app.store.doc.drawing && app.inDrawing, run: () => app.drawing.exportPdf() },
    { id: 'drawing:svg', label: 'Export SVG', icon: 'download', enabled: () => !!app.store.doc.drawing && app.inDrawing, run: () => app.drawing.exportSvg() },
    { id: 'zoomIn', label: 'Zoom In', icon: 'zoomIn', shortcut: 'Shift+Z', run: () => app.viewport.zoomBy(0.8) },
    { id: 'zoomOut', label: 'Zoom Out', icon: 'zoomOut', shortcut: 'Z', run: () => app.viewport.zoomBy(1.25) },
    { id: 'previousView', label: 'Previous View', icon: 'previousView', shortcut: 'Ctrl+Shift+Z', run: () => app.viewport.previousView() },
    view('front', 'Front', 'viewFront', 'Ctrl+1'),
    view('back', 'Back', 'viewBack', 'Ctrl+2'),
    view('left', 'Left', 'viewLeft', 'Ctrl+3'),
    view('right', 'Right', 'viewRight', 'Ctrl+4'),
    view('top', 'Top', 'viewTop', 'Ctrl+5'),
    view('bottom', 'Bottom', 'viewBottom', 'Ctrl+6'),
    view('isometric', 'Isometric', 'viewIso', 'Ctrl+7'),
    view('trimetric', 'Trimetric', 'viewIso'),
    view('dimetric', 'Dimetric', 'viewIso'),
    {
      id: 'normalTo', label: 'Normal To', icon: 'normalTo', shortcut: 'Ctrl+8', description: 'Look straight at the selected plane, face or the sketch plane.',
      run: () => {
        const ref = app.selectedPlaneRef();
        const fr = ref ? app.frameOfPlane(ref) : app.sketchEditor?.frame ?? null;
        if (fr) app.viewport.normalTo(fr);
        else app.setStatus('Select a plane or planar face first.', true);
      },
    },
    { id: 'viewOrientation', label: 'View Orientation', icon: 'viewOrientation', shortcut: 'Space', run: () => app.openViewMenu() },
    { id: 'displayStyle', label: 'Display Style', icon: 'shadedEdges', run: () => app.cycleDisplayStyle() },
    { id: 'toggleVisibility', label: 'Hide/Show Items', icon: 'eye', run: () => app.openVisibilityMenu() },
    style('shadedEdges', 'Shaded With Edges', 'shadedEdges'),
    style('shaded', 'Shaded', 'shaded'),
    style('hiddenRemoved', 'Hidden Lines Removed', 'hiddenRemoved'),
    style('hiddenVisible', 'Hidden Lines Visible', 'hiddenVisible'),
    style('wireframe', 'Wireframe', 'wireframe'),
    {
      id: 'perspective', label: 'Perspective', icon: 'perspective', checked: () => !app.renderer.camera.ortho,
      run: () => { const cam = app.renderer.camera; cam.ortho = !cam.ortho; cam.onChange(); c.changed(); },
    },
    toggle('showPlanes', 'Planes', () => app.viewport.showPlanes, (v) => { app.viewport.showPlanes = v; app.settings.showPlanes = v; }),
    toggle('showOrigin', 'Origins', () => app.viewport.showOrigin, (v) => { app.viewport.showOrigin = v; app.settings.showOrigin = v; }),
    toggle('showSketches', 'Sketches', () => app.viewport.showSketches, (v) => { app.viewport.showSketches = v; app.settings.showSketches = v; }),
    toggle('showRelations', 'Sketch Relations', () => app.settings.showRelations, (v) => { app.settings.showRelations = v; if (app.sketchEditor) app.sketchEditor.showRelations = v; }),
    toggle('showDimensions', 'Sketch Dimensions', () => app.settings.showDimensions, (v) => { app.settings.showDimensions = v; if (app.sketchEditor) app.sketchEditor.showDimensions = v; }),
    { id: 'theme:system', label: 'System Theme', icon: 'system', checked: () => getThemeChoice() === 'system', run: () => { setThemeChoice('system'); c.changed(); } },
    { id: 'theme:light', label: 'Light Theme', icon: 'light', checked: () => getThemeChoice() === 'light', run: () => { setThemeChoice('light'); c.changed(); } },
    { id: 'theme:dark', label: 'Dark Theme', icon: 'dark', checked: () => getThemeChoice() === 'dark', run: () => { setThemeChoice('dark'); c.changed(); } },
    { id: 'toggleTree', label: 'Design Tree', icon: 'panelLeft', run: () => app.toggleLeftPane() },
    { id: 'shortcutBar', label: 'Shortcut Bar', icon: 'more', shortcut: 'S', description: 'Show the most used commands at the cursor.', run: () => app.openShortcutBar() },
    // ---- help ----
    { id: 'shortcuts', label: 'Keyboard Shortcuts', icon: 'keyboard', shortcut: 'Shift+?', run: () => shortcutsDialog(app) },
    { id: 'shortcutsF1', label: 'Keyboard Shortcuts', hidden: true, shortcut: 'F1', run: () => shortcutsDialog(app) },
    { id: 'github', label: 'Source Code on GitHub', icon: 'github', run: () => { window.open(REPO_URL, '_blank', 'noopener'); } },
    { id: 'about', label: 'About Parametric', icon: 'info', run: () => aboutDialog() },
  );
  void noModes;
  void VIEWS;
}

function hasUsableSketch(app: App): boolean {
  const sel = app.selection.items[0];
  if (sel?.kind === 'feature' && app.store.feature(sel.id)?.type === 'sketch') return true;
  const doc = app.store.doc;
  const used = new Set(doc.features.flatMap((f) => (f.type === 'extrude' || f.type === 'revolve' || f.type === 'hole' ? [f.sketch] : [])));
  return doc.features.slice(0, app.store.builtCount).some((f) => f.type === 'sketch' && !used.has(f.id) && f.entities.length > 0);
}

function selectedFeature(app: App): Feature | undefined {
  const it = app.selection.items.find((x) => x.kind === 'feature') as { id: Id } | undefined;
  if (it) return app.store.feature(it.id);
  const face = app.selection.items.find((x) => x.kind === 'face') as { index: number } | undefined;
  if (face) return app.store.feature(app.faces[face.index]?.feature ?? '');
  return undefined;
}

// ---------- layout ----------

export const RIBBON: RibbonTab[] = [
  {
    id: 'features', label: 'Features',
    groups: [
      [{ cmd: 'extrude' }, { cmd: 'revolve' }, { stack: [{ cmd: 'sweep' }, { cmd: 'loft' }] }],
      [{ cmd: 'extrudeCut' }, { cmd: 'revolveCut' }, { stack: [{ cmd: 'sweepCut' }, { cmd: 'loftCut' }] }],
      [{ cmd: 'hole' }, { cmd: 'fillet', menu: ['fillet', 'chamfer'] }, { cmd: 'linearPattern', menu: ['linearPattern', 'circularPattern', 'mirror'] }],
      [{ stack: [{ cmd: 'chamfer' }, { cmd: 'shell' }, { cmd: 'draft' }] }, { stack: [{ cmd: 'circularPattern' }, { cmd: 'mirror' }] }],
      [{ cmd: 'plane' }, { cmd: 'importStep' }],
    ],
  },
  {
    id: 'sketch', label: 'Sketch',
    groups: [
      [{ cmd: 'sketch' }, { cmd: 'tool:smartDimension' }],
      [
        { stack: [{ cmd: 'tool:line' }, { cmd: 'tool:centerline' }, { cmd: 'tool:point' }] },
        { stack: [{ cmd: 'tool:rectangle' }, { cmd: 'tool:centerRectangle' }, { cmd: 'tool:polygon' }] },
        { stack: [{ cmd: 'tool:circle' }, { cmd: 'tool:perimeterCircle' }, { cmd: 'tool:slot' }] },
        { stack: [{ cmd: 'tool:centerArc' }, { cmd: 'tool:tangentArc' }, { cmd: 'tool:arc3' }] },
        { stack: [{ cmd: 'tool:spline' }, { cmd: 'tool:sketchFillet' }] },
      ],
      [{ cmd: 'tool:trim' }, { stack: [{ cmd: 'tool:extend' }, { cmd: 'offset' }, { cmd: 'convertEntities' }] }, { stack: [{ cmd: 'mirrorEntities' }, { cmd: 'construction' }, { cmd: 'addRelation' }] }],
    ],
  },
  {
    id: 'evaluate', label: 'Evaluate',
    groups: [[{ cmd: 'measure' }, { cmd: 'massProperties' }, { cmd: 'sectionView' }], [{ cmd: 'equations' }, { cmd: 'material' }]],
  },
  {
    id: 'drawing', label: 'Drawing',
    groups: [
      [{ cmd: 'drawing:arrange' }, { stack: [{ cmd: 'drawing:add:front' }, { cmd: 'drawing:add:top' }, { cmd: 'drawing:add:right' }] }, { stack: [{ cmd: 'drawing:add:isometric' }, { cmd: 'drawing:add:left' }, { cmd: 'drawing:add:back' }] }],
      [{ cmd: 'drawing:pdf' }, { cmd: 'drawing:svg' }],
      [{ cmd: 'zoomFit' }, { cmd: 'backToModel' }],
    ],
  },
  {
    id: 'view', label: 'View',
    groups: [
      [{ cmd: 'zoomFit' }, { cmd: 'normalTo' }],
      [{ stack: [{ cmd: 'viewFront' }, { cmd: 'viewTop' }, { cmd: 'viewRight' }] }, { stack: [{ cmd: 'viewBack' }, { cmd: 'viewBottom' }, { cmd: 'viewLeft' }] }, { cmd: 'viewIsometric' }],
      [{ stack: [{ cmd: 'style:shadedEdges' }, { cmd: 'style:shaded' }, { cmd: 'style:wireframe' }] }, { stack: [{ cmd: 'style:hiddenRemoved' }, { cmd: 'style:hiddenVisible' }, { cmd: 'perspective' }] }],
    ],
  },
];

export function buildMenus(app: App): { label: string; items: () => MenuItem[] }[] {
  const c = app.commands;
  const m = (id: string, extra: Partial<MenuItem> = {}): MenuItem => {
    const cmd = c.get(id)!;
    return { label: cmd.label, icon: cmd.icon, shortcut: cmd.shortcut, disabled: !c.isEnabled(id), checked: cmd.checked ? c.isChecked(id) : undefined, run: () => c.run(id), ...extra };
  };
  const sep: MenuItem = { separator: true };
  return [
    {
      label: 'File', items: () => [
        m('new'), m('open'), m('openDevice'), { label: 'Recent', icon: 'files', submenu: () => app.recentMenu() }, sep,
        m('save'), m('saveAs'), m('downloadPart'), sep, m('importStep'), m('exportStep'), m('exportStl'), sep, m('openDrawing'), m('drawing:pdf'), sep, m('share'), m('rename'), m('properties'),
      ],
    },
    {
      label: 'Edit', items: () => [
        { ...m('undo'), label: app.store.canUndo ? `Undo ${app.store.undoLabel}` : 'Undo' },
        { ...m('redo'), label: app.store.canRedo ? `Redo ${app.store.redoLabel}` : 'Redo' }, sep,
        m('rebuild'), m('forceRebuild'), sep, m('editFeature'), m('delete'), m('suppress'), m('unsuppress'), m('rollToEnd'), sep, m('appearance'), m('material'),
      ],
    },
    {
      label: 'View', items: () => [
        { label: 'Display', icon: 'shadedEdges', submenu: () => ['shadedEdges', 'shaded', 'hiddenRemoved', 'hiddenVisible', 'wireframe'].map((s) => ({ ...m(`style:${s}`), radio: true })) },
        { label: 'Orientation', icon: 'viewOrientation', submenu: () => app.viewMenuItems() },
        m('zoomFit'), m('zoomIn'), m('zoomOut'), m('previousView'), m('perspective'), m('sectionView'), sep,
        { label: 'Hide/Show', icon: 'eye', submenu: () => ['showPlanes', 'showOrigin', 'showSketches', 'showRelations', 'showDimensions'].map((id) => m(id)) },
        { label: 'Theme', icon: 'system', submenu: () => [m('theme:system', { radio: true }), m('theme:light', { radio: true }), m('theme:dark', { radio: true })] },
        m('toggleTree'),
      ],
    },
    {
      label: 'Insert', items: () => [
        m('sketch'), sep,
        { label: 'Boss/Base', icon: 'extrude', submenu: () => [m('extrude'), m('revolve'), m('sweep'), m('loft')] },
        { label: 'Cut', icon: 'extrudeCut', submenu: () => [m('extrudeCut'), m('revolveCut'), m('sweepCut'), m('loftCut')] },
        { label: 'Features', icon: 'fillet', submenu: () => [m('fillet'), m('chamfer'), m('hole'), m('shell'), m('draft')] },
        { label: 'Pattern/Mirror', icon: 'linearPattern', submenu: () => [m('linearPattern'), m('circularPattern'), m('mirror')] },
        { label: 'Reference Geometry', icon: 'plane', submenu: () => [m('plane')] },
        sep, m('importStep'),
      ],
    },
    {
      label: 'Tools', items: () => [
        { label: 'Sketch Entities', icon: 'line', submenu: () => ['line', 'centerline', 'rectangle', 'centerRectangle', 'circle', 'perimeterCircle', 'centerArc', 'tangentArc', 'arc3', 'polygon', 'slot', 'spline', 'point'].map((t) => m(`tool:${t}`)) },
        { label: 'Sketch Tools', icon: 'trim', submenu: () => [m('tool:sketchFillet'), m('tool:trim'), m('tool:extend'), m('offset'), m('mirrorEntities'), m('convertEntities'), m('construction')] },
        { label: 'Dimensions and Relations', icon: 'smartDimension', submenu: () => [m('tool:smartDimension'), m('addRelation')] },
        { label: 'Evaluate', icon: 'measure', submenu: () => [m('measure'), m('massProperties'), m('sectionView')] },
        sep, m('equations'), m('material'), m('options'),
      ],
    },
    {
      label: 'Help', items: () => [m('shortcuts'), { label: 'Getting Started', icon: 'help', run: () => app.showGettingStarted() }, sep, m('github'), m('about')],
    },
  ];
}

/** Context menu items. */
export function contextItems(app: App, target: 'viewport' | 'feature' | 'reference', id?: Id): MenuItem[] {
  const c = app.commands;
  const m = (cid: string, extra: Partial<MenuItem> = {}): MenuItem => {
    const cmd = c.get(cid)!;
    return { label: cmd.label, icon: cmd.icon, shortcut: cmd.shortcut, disabled: !c.isEnabled(cid), run: () => c.run(cid), ...extra };
  };
  const sep: MenuItem = { separator: true };
  const ed = app.sketchEditor;
  if (ed && id) {
    // Dimension or relation in the sketch.
    const con = ed.sketch.constraints.find((x) => x.id === id);
    if (con && isDimension(con)) {
      const d = con as SkDimension;
      return [
        { label: 'Modify Value...', icon: 'edit', disabled: !!d.driven, run: () => ed.openModify(id) },
        { label: d.driven ? 'Make Driving' : 'Make Driven (reference)', icon: 'smartDimension', run: () => ed.edit('Toggle driven', (sk) => { const x = sk.constraints.find((k) => k.id === id) as SkDimension; x.driven = !x.driven || undefined; }) },
        sep, { label: 'Delete Dimension', icon: 'trash', run: () => ed.edit('Delete dimension', (sk) => { sk.constraints = sk.constraints.filter((k) => k.id !== id); }) },
      ];
    }
    if (con) return [{ label: 'Delete Relation', icon: 'trash', run: () => ed.edit('Delete relation', (sk) => { sk.constraints = sk.constraints.filter((k) => k.id !== id); }) }];
  }
  if (ed) {
    const items: MenuItem[] = [];
    const ids = ed.selectedIds();
    if (ids.length) items.push(m('construction'), m('delete'), sep);
    items.push(m('tool:smartDimension'), m('tool:line'), m('tool:rectangle'), m('tool:circle'), sep, m('convertEntities'), m('exitSketch'), sep, m('zoomFit'), m('normalTo'));
    return items;
  }
  if (target === 'feature' && id) {
    const f = app.store.feature(id)!;
    const idx = app.store.indexOf(id);
    return [
      f.type === 'sketch' ? { label: 'Edit Sketch', icon: 'sketch', run: () => app.editSketch(id) } : { label: 'Edit Feature', icon: 'edit', run: () => app.editFeature(id) },
      { label: 'Rename', icon: 'text', shortcut: 'F2', run: () => app.tree.startRename(id) },
      sep,
      ...(f.type === 'sketch' || f.type === 'plane' ? [{ label: f.hidden ? 'Show' : 'Hide', icon: f.hidden ? 'eye' : 'eyeOff', run: () => app.toggleHidden([id]) } as MenuItem] : []),
      { label: f.suppressed ? 'Unsuppress' : 'Suppress', icon: f.suppressed ? 'eye' : 'eyeOff', run: () => app.toggleSuppress([id]) },
      { label: 'Roll Back to Here', icon: 'upToLine', run: () => app.setRollback(idx) },
      { label: 'Roll to End', icon: 'downToLine', disabled: app.store.doc.rollback == null, run: () => app.setRollback(null) },
      ...(f.type === 'sketch' || f.type === 'plane' ? [{ label: 'Normal To', icon: 'normalTo', run: () => { const fr = f.type === 'sketch' ? app.frameOfSketch(f) : app.frameOfPlane({ kind: 'feature', id }); if (fr) app.viewport.normalTo(fr); } } as MenuItem] : []),
      sep,
      { label: 'Delete', icon: 'trash', shortcut: 'Delete', run: () => void app.deleteFeatures([id]) },
    ];
  }
  const sel = app.selection.items[0];
  const items: MenuItem[] = [];
  if (sel) {
    const plane = app.selectedPlaneRef();
    if (plane) items.push({ ...m('sketch'), label: 'Sketch on This' }, m('normalTo'), m('plane', { label: 'Offset Plane' }), sep);
    if (sel.kind === 'face') {
      const owner = app.store.feature(app.faces[sel.index]?.feature ?? '');
      if (owner) items.push({ label: `Edit ${owner.name}`, icon: 'edit', run: () => app.editFeature(owner.id) });
      const sk = owner && 'sketch' in owner ? app.store.feature((owner as { sketch: Id }).sketch) : null;
      if (sk) items.push({ label: `Edit ${sk.name}`, icon: 'sketch', run: () => app.editSketch(sk.id) });
      items.push(m('fillet'), m('chamfer'), m('shell'), m('measure'), sep);
    }
    if (sel.kind === 'edge') items.push(m('fillet'), m('chamfer'), m('measure'), sep);
  }
  items.push(m('zoomFit'), { label: 'View Orientation', icon: 'viewOrientation', submenu: () => app.viewMenuItems() }, { label: 'Display Style', icon: 'shadedEdges', submenu: () => app.displayMenuItems() });
  if (target === 'reference') items.unshift({ label: 'Show/Hide Planes', icon: 'plane', run: () => c.run('showPlanes') }, sep);
  return items;
}

export function quickActions(app: App): { cmd: string }[] {
  const it = app.selection.items[0];
  if (!it) return [];
  if (it.kind === 'face') {
    const f = app.faces[it.index];
    return f?.type === 'plane' ? [{ cmd: 'sketch' }, { cmd: 'normalTo' }, { cmd: 'editFeature' }, { cmd: 'extrudeCut' }, { cmd: 'hole' }, { cmd: 'fillet' }, { cmd: 'measure' }] : [{ cmd: 'editFeature' }, { cmd: 'fillet' }, { cmd: 'measure' }];
  }
  if (it.kind === 'edge') return [{ cmd: 'fillet' }, { cmd: 'chamfer' }, { cmd: 'measure' }];
  if (it.kind === 'plane') return [{ cmd: 'sketch' }, { cmd: 'normalTo' }, { cmd: 'plane' }];
  return [];
}

/** PropertyManager asking for a sketch plane. */
export class PlanePickPanel extends PropertyPanel {
  title = 'Sketch';
  icon = 'sketch';
  confirm = false;
  constructor(private app: App, private done: (ref: PlaneRef) => void) {
    super();
    app.setPlanePicking(true);
  }

  filter() {
    return { plane: true, planarOnly: true, face: true };
  }

  render() {
    return [section('Select a Plane', [
      h('p', { class: 'field-label' }, 'Select one of the planes shown, or a planar face of the model, to sketch on.'),
    ])];
  }

  onPick(item: import('./selection').SelItem): boolean {
    let ref: PlaneRef | null = null;
    if (item.kind === 'plane') ref = item.ref;
    else if (item.kind === 'face') {
      const f = this.app.faces[item.index];
      if (f?.type === 'plane') ref = { kind: 'face', face: { name: f.name, sig: { type: f.type, c: f.center, n: f.normal, area: f.area } } };
    }
    if (!ref) return false;
    const r = ref;
    void this.app.closePanel(false).then(() => this.done(r));
    return true;
  }

  ok() { return true; }

  dispose() {
    this.app.setPlanePicking(false);
  }
}

export function makeHooks(app: App): AppHooks {
  return {
    ribbonTabs: RIBBON,
    menus: buildMenus(app),
    sketchPanel: () => new SketchPanel(app),
    editFeaturePanel: (f) => panelFor(app, f, true),
    planePickPanel: (done) => new PlanePickPanel(app, done),
    contextItems: (t, id) => contextItems(app, t, id),
    quickActions: () => quickActions(app),
  };
}

export const unitLabel = (u: keyof typeof UNIT_SYSTEMS) => UNIT_SYSTEMS[u].label;
export { toast };
