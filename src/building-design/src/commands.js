/**
 * Command registry. Every ribbon button, menu item, keyboard shortcut and
 * command search entry runs a command by name.
 *
 *   { label, icon, run(app, args), enabled(app), keys: 'WA' (typed letters),
 *     accel: 'Ctrl+S', desc, search: extra search words }
 */
import {
  WallTool,
  HostedTool,
  ComponentTool,
  LineTool,
  SketchTool,
  StairTool,
  RampTool,
  AreaTool,
  LabelTool,
  RoomTool,
  DimensionTool,
  TextTool,
  TagTool,
  SectionTool,
  CalloutTool,
  ElevationTool,
  LevelTool,
  placeRoomsAutomatically,
  tagAll,
} from './editor/draw.js';
import {
  MoveTool,
  RotateTool,
  MirrorTool,
  ArrayTool,
  AlignTool,
  OffsetTool,
  TrimTool,
  SplitTool,
  ScaleTool,
  MeasureTool,
  MatchTypeTool,
  ZoomRegionTool,
} from './editor/modify.js';
import { deleteElements } from './core/ops.js';
import { PlaceGroupTool, GroupMemberTool } from './editor/groups.js';
import { CurtainGridTool } from './editor/curtain.js';
import { DemolishTool, RenumberTool } from './editor/manage.js';
import { FootingTool, WallFootingTool, BeamSystemTool, TopoTool, ByFaceTool } from './editor/site.js';
import * as manage from './ui/manage.js';
import * as collab from './ui/collab.js';
import * as links from './ui/links.js';
import * as dopts from './ui/designopts.js';
import { WallSweepTool } from './editor/sweep.js';
import * as curtainedit from './ui/curtainedit.js';
import * as renderui from './ui/render.js';
import { ScopeBoxTool } from './editor/scopebox.js';
import { ModelTextTool } from './editor/modeltext.js';
import * as sunui from './ui/sun.js';
import * as analyze from './ui/analyze.js';
import * as globalsui from './ui/globals.js';
import { SpaceTool, placeSpacesAutomatically } from './editor/analyze.js';
import { sunDirection } from './core/sun.js';
import { editingOption } from './core/designopts.js';
import { worksharingOn } from './core/worksets.js';
import { confirmDialog } from './ui/dialog.js';
import { AngularDimTool, RadialDimTool, SpotTool, InsulationTool, DetailItemTool, ArcTool, SymbolTool, LegendTool, LegendComponentTool, TreadNumberTool } from './editor/annotate.js';

const tool = (Cls, opts = {}) => (app, args) => app.startTool(Cls, { ...opts, ...(args || {}) });
const hasSel = (app) => app.selection.size > 0;

/** Place a component of a category, starting from a preferred type. */
const component = (category, preferred) => (app) => {
  const types = app.doc.all('componentType').filter((t) => t.category === category);
  const cur = app.doc.get(app.currentTypes.get('component'));
  const pick = cur?.category === category ? cur : types.find((t) => t.id === preferred) || types[0];
  if (!pick) return app.toast('This project has no types of that category.', { kind: 'error' });
  app.setCurrentType('component', pick.id);
  app.startTool(ComponentTool, { kind: 'component' });
};

/** A floor tool that starts with a type of a given flag (for example foundation slabs). */
const floorOfType = (match) => (app) => {
  const t = app.doc.all('floorType').find(match);
  if (t) app.setCurrentType('floor', t.id);
  app.startTool(SketchTool, { kind: 'floor' });
};

export const COMMANDS = {
  // Files
  new: { label: 'New Project', icon: 'file-plus', accel: 'Ctrl+N', run: (app) => app.newProjectDialog() },
  open: { label: 'Open', icon: 'folder-open', accel: 'Ctrl+O', run: (app) => app.openDialog() },
  save: { label: 'Save', icon: 'save', accel: 'Ctrl+S', run: (app) => app.save() },
  saveAs: { label: 'Save As', icon: 'save-all', accel: 'Ctrl+Shift+S', run: (app) => app.saveAs() },
  export: { label: 'Export', icon: 'download', run: (app, args) => app.exportDialog(args?.format) },
  print: { label: 'Print or Export PDF', icon: 'printer', accel: 'Ctrl+P', run: (app) => app.exportDialog('pdf') },
  home: { label: 'Home', icon: 'house', run: (app) => app.showHome() },
  sample: { label: 'Open Sample Project', icon: 'house', run: (app) => app.startProject('sample') },
  share: { label: 'Share Project', icon: 'share', run: (app) => app.shareDialog() },
  importDxf: { label: 'Import CAD (DXF)', icon: 'importCad', run: (app) => app.importDXF(), desc: 'Bring lines and text from a DXF drawing into the active view, to trace over' },
  linkProject: { label: 'Link Project', icon: 'linkProject', run: (app) => links.linkProject(app), desc: 'Show another project in this one, read-only, to coordinate with it' },
  modelText: { label: 'Model Text', icon: 'modelText', run: tool(ModelTextTool), desc: '3D lettering for signs and markings' },
  linkIFC: { label: 'Link IFC', icon: 'linkIfc', run: (app) => links.linkIFC(app), desc: 'Show a model from other BIM software (IFC file), read-only, to coordinate with it' },
  loadAsGroup: { label: 'Load as Group', icon: 'groupPlace', run: (app) => links.loadAsGroup(app), desc: 'Bring the first level of another project in as a model group and place it' },
  manageLinks: { label: 'Manage Links', icon: 'linkProject', run: (app) => links.manageLinksDialog(app), desc: 'Reload or remove linked projects' },
  reloadLinkFrom: { label: 'Reload Link From', icon: 'refresh', run: (app) => { const id = [...app.selection].find((x) => app.doc.get(x)?.kind === 'link'); if (id) links.reloadLink(app, id, true); } },
  importImage: { label: 'Image', icon: 'imageImport', run: (app) => app.importImage(), desc: 'Place a picture, such as a scanned drawing or site photo, in the active view' },
  syncNow: {
    label: 'Synchronize Now',
    icon: 'sync',
    keys: 'SY',
    run: async (app) => (await app.requireShared()) && app.sync.sync(),
    desc: 'Bring in changes others saved and share yours. Saving does the same.',
  },
  syncComment: { label: 'Synchronize with Comment', icon: 'sync', run: (app) => collab.syncWithCommentDialog(app), desc: 'Synchronize and note what you changed' },
  reloadLatest: {
    label: 'Reload Latest',
    icon: 'refresh',
    run: async (app) => {
      if (!(await app.requireShared())) return;
      if (app.doc.modified && !(await confirmDialog('Reload latest?', 'Your changes that are not synchronized yet will be lost.', { confirm: 'Reload', danger: true }))) return;
      app.sync.reloadLatest();
    },
    desc: 'Discard your unsynchronized changes and load the shared copy',
  },
  autoSync: {
    label: 'Live Updates',
    icon: 'live',
    toggle: (app) => app.settings.autoSync !== false,
    run: (app) => {
      const on = app.settings.autoSync === false;
      app.settingsStore.set('autoSync', on);
      app.ribbon.refresh();
      app.toast(on ? 'Changes others save will appear automatically.' : 'Live updates are off. Synchronize to see others\' changes.');
    },
    desc: 'Show changes others save while you work',
  },
  syncHistory: { label: 'History', icon: 'history', run: (app) => collab.syncHistoryDialog(app), desc: 'Who synchronized the project, when, and their comments' },
  worksets: { label: 'Worksets', icon: 'worksets', keys: 'WS', run: (app) => collab.worksetsDialog(app), desc: 'Divide the model into parts that people work on and views can turn off' },
  viewWorksets: { label: 'View Worksets', icon: 'worksets', run: (app) => collab.viewWorksetsDialog(app), desc: 'Which worksets the active view shows' },
  worksharingDisplay: {
    label: 'Colour by Workset',
    icon: 'wsDisplay',
    toggle: (app) => app.activeView?.wsDisplay === 'worksets',
    enabled: (app) => !!app.activeView && worksharingOn(app.doc) && ['plan', 'ceilingPlan', 'areaPlan', 'elevation', 'section'].includes(app.activeView.kind),
    run: (app) => {
      const v = app.activeView;
      app.commit('Worksharing display', () => app.doc.update(v.id, { wsDisplay: v.wsDisplay === 'worksets' ? 'off' : 'worksets' }));
    },
    desc: 'Colour elements by their workset in the active view',
  },
  sharedWithMe: { label: 'Shared With Me', icon: 'users', run: (app) => app.openDialog('shared') },

  // Edit
  undo: { label: 'Undo', icon: 'undo', accel: 'Ctrl+Z', run: (app) => app.undo(), enabled: (app) => app.doc?.canUndo },
  redo: { label: 'Redo', icon: 'redo', accel: 'Ctrl+Y', run: (app) => app.redo(), enabled: (app) => app.doc?.canRedo },
  copyClip: { label: 'Copy to Clipboard', icon: 'copy', accel: 'Ctrl+C', run: (app) => app.copyToClipboard(), enabled: hasSel },
  cutClip: { label: 'Cut to Clipboard', icon: 'scissors', accel: 'Ctrl+X', run: (app) => app.copyToClipboard(true), enabled: hasSel },
  paste: { label: 'Paste', icon: 'paste', accel: 'Ctrl+V', run: (app) => app.paste(), enabled: (app) => !!app.clipboard },
  pasteLevels: { label: 'Paste Aligned to Selected Levels', icon: 'paste', run: (app) => app.pasteToLevels(), enabled: (app) => !!app.clipboard, desc: 'Paste the copied elements onto other levels, in the same plan position' },
  createSimilar: { label: 'Create Similar', icon: 'createSimilar', keys: 'CS', enabled: hasSel, run: (app) => app.createSimilar(), desc: 'Place a new element of the same kind and type as the selected one' },
  selectionFilter: { label: 'Filter', icon: 'filter', enabled: hasSel, run: (app) => app.selectionFilterDialog(), desc: 'Keep only some categories of the selection' },
  selectAll: { label: 'Select All in View', icon: 'pointer', accel: 'Ctrl+A', run: (app) => app.selectAllInView() },
  delete: {
    label: 'Delete',
    icon: 'delete',
    keys: 'DE',
    accel: 'Delete',
    enabled: hasSel,
    run: (app) => {
      const ids = [...app.selection].filter((id) => !app.doc.get(id)?.pinned);
      if (!ids.length) return app.toast('Pinned elements cannot be deleted. Unpin them first.', { kind: 'error' });
      let n = 0;
      app.commit('Delete', () => (n = deleteElements(app.doc, ids).size));
      app.select([]);
      app.setPrompt(`Deleted ${n} element${n === 1 ? '' : 's'}.`);
    },
  },
  pin: { label: 'Pin', icon: 'pin', keys: 'PN', enabled: hasSel, run: (app) => app.commit('Pin', () => app.selection.forEach((id) => app.doc.update(id, { pinned: true }))) },
  unpin: { label: 'Unpin', icon: 'unpin', keys: 'UP', enabled: hasSel, run: (app) => app.commit('Unpin', () => app.selection.forEach((id) => app.doc.update(id, { pinned: false }))) },
  modify: { label: 'Modify', icon: 'modify', run: (app) => (app.cancelTool(), app.select([])), desc: 'Select and edit elements' },

  // Architecture
  wall: { label: 'Wall', icon: 'wall', keys: 'WA', run: tool(WallTool), desc: 'Draw walls' },
  wallStructural: { label: 'Structural Wall', icon: 'wallStructural', run: tool(WallTool, { structural: true }) },
  curtainWall: {
    label: 'Curtain Wall',
    icon: 'curtainWall',
    run: (app) => {
      const t = app.doc.all('wallType').find((x) => x.curtain);
      if (t) app.setCurrentType('wall', t.id);
      app.startTool(WallTool, {});
    },
  },
  curtainGrid: { label: 'Curtain Grid', icon: 'curtainGrid', run: tool(CurtainGridTool), desc: 'Add or remove grid lines on a curtain wall, in plans, elevations and sections' },
  door: { label: 'Door', icon: 'door', keys: 'DR', run: tool(HostedTool, { kind: 'door' }), desc: 'Place doors in walls' },
  window: { label: 'Window', icon: 'window', keys: 'WN', run: tool(HostedTool, { kind: 'window' }), desc: 'Place windows in walls' },
  shaft: { label: 'Shaft Opening', icon: 'shaft', run: tool(SketchTool, { kind: 'shaft' }), desc: 'Cut an opening through the floor above and the ceiling of this level' },
  opening: { label: 'Wall Opening', icon: 'opening', run: tool(HostedTool, { kind: 'opening' }), desc: 'Cut a rectangular opening in a wall' },
  component: { label: 'Component', icon: 'component', keys: 'CM', run: tool(ComponentTool, { kind: 'component' }), desc: 'Place furniture, fixtures and equipment' },
  column: { label: 'Column', icon: 'column', run: tool(ComponentTool, { kind: 'column' }), desc: 'Place architectural columns, such as column wraps and pilasters' },
  columnStructural: { label: 'Structural Column', icon: 'columnStructural', keys: 'CL', run: tool(ComponentTool, { kind: 'column', structural: true }), desc: 'Place load-bearing columns' },
  ramp: { label: 'Ramp', icon: 'ramp', run: tool(RampTool), desc: 'Place a straight ramp between levels at the slope of its type' },
  modelLine: { label: 'Model Line', icon: 'modelLine', keys: 'LI', run: tool(LineTool, { kind: 'modelLine' }), desc: 'Draw lines that belong to the model and show in every view' },
  refPlane: { label: 'Reference Plane', icon: 'refPlane', keys: 'RP', run: tool(LineTool, { kind: 'refPlane' }), desc: 'Draw a reference plane to snap to and align with' },
  workPlaneGrid: { label: 'Show Work Plane', icon: 'workPlane', run: (app) => app.toggleSetting('workPlaneGrid'), desc: 'Show a grid on the active level in plan views' },
  area: { label: 'Area', icon: 'area', run: tool(AreaTool), desc: 'Place an area inside area boundary lines (in an area plan)' },
  areaPlan: { label: 'Area Plan', icon: 'areaPlan', run: (app) => app.areaPlanDialog(), desc: 'Create area plans for gross or rentable areas' },
  areaBoundary: { label: 'Area Boundary', icon: 'areaBoundary', run: tool(LineTool, { kind: 'areaBoundary' }), desc: 'Draw or pick the lines that bound areas' },
  tagRoom: { label: 'Tag Room', icon: 'roomTag', keys: 'RT', run: tool(LabelTool), desc: 'Move the label of a room or area' },
  groupCreate: { label: 'Create Group', icon: 'group', keys: 'GP', enabled: hasSel, run: (app) => app.createGroup(), desc: 'Make a model group from the selection, to place and edit as one' },
  groupPlace: { label: 'Place Group', icon: 'groupPlace', run: tool(PlaceGroupTool), desc: 'Place another instance of a model group' },
  groupEdit: { label: 'Edit Group', icon: 'groupEdit', keys: 'EG', run: (app) => app.startGroupEdit(), desc: 'Edit the members of a group; every instance updates when you finish' },
  ungroup: { label: 'Ungroup', icon: 'ungroup', keys: 'UG', enabled: hasSel, run: (app) => app.ungroupSelection(), desc: 'Turn a group back into separate elements' },
  groupAdd: { label: 'Add', icon: 'plus', run: tool(GroupMemberTool), desc: 'Add elements to the group being edited' },
  groupRemove: { label: 'Remove', icon: 'minus', run: tool(GroupMemberTool, { remove: true }), desc: 'Take members out of the group being edited' },
  groupFinish: { label: 'Finish', icon: 'finish', run: (app) => app.finishGroupEdit(true), desc: 'Finish editing and update every instance' },
  groupCancel: { label: 'Cancel', icon: 'cancel', run: (app) => app.finishGroupEdit(false), desc: 'Discard the changes made to the group' },
  openingFace: { label: 'Opening by Face', icon: 'openingFace', run: tool(SketchTool, { kind: 'vopening' }), desc: 'Cut an opening through a floor, roof or ceiling' },
  beam: { label: 'Beam', icon: 'beam', keys: 'BM', run: tool(LineTool, { kind: 'beam' }) },
  editCurtain: { label: 'Mullions and Panels', icon: 'curtainWall', enabled: (app) => [...app.selection].some((id) => app.doc.get(app.doc.get(id)?.typeId)?.curtain), run: (app) => curtainedit.curtainEditDialog(app, [...app.selection].find((id) => app.doc.get(app.doc.get(id)?.typeId)?.curtain)), desc: 'Remove or restore mullion segments and change panels to solid, empty or door' },
  wallSweep: { label: 'Wall Sweep', icon: 'wallSweep', run: tool(WallSweepTool), desc: 'A cornice, skirting or band along a wall face' },
  wallReveal: { label: 'Wall Reveal', icon: 'wallReveal', run: tool(WallSweepTool, { reveal: true }), desc: 'A groove along a wall face' },
  truss: { label: 'Truss', icon: 'truss', keys: 'TS', run: tool(LineTool, { kind: 'truss' }), desc: 'A truss between two points: Pratt, Howe, Warren, Fink or king post' },
  brace: { label: 'Brace', icon: 'brace', keys: 'BR', run: tool(LineTool, { kind: 'brace' }), desc: 'A diagonal member from this level up to the level above' },
  beamSystem: { label: 'Beam System', icon: 'beamSystem', keys: 'BS', run: tool(BeamSystemTool), desc: 'Fill an area or a floor with parallel beams at a spacing' },
  footing: { label: 'Isolated', icon: 'footing', run: tool(FootingTool), desc: 'Pad footings, placed one by one or under every column' },
  wallFooting: { label: 'Wall Foundation', icon: 'wallFooting', keys: 'FT', run: tool(WallFootingTool), desc: 'Strip footings under walls' },
  slabFoundation: { label: 'Foundation Slab', icon: 'slabFoundation', run: floorOfType((t) => t.foundation), desc: 'A thick slab on grade' },
  duct: { label: 'Duct', icon: 'duct', keys: 'DT', run: tool(LineTool, { kind: 'duct' }), desc: 'Draw ducts at a height above the level' },
  pipe: { label: 'Pipe', icon: 'pipe', keys: 'PI', run: tool(LineTool, { kind: 'pipe' }), desc: 'Draw pipes at a height above the level' },
  cableTray: { label: 'Cable Tray', icon: 'cableTray', keys: 'CT', run: tool(LineTool, { kind: 'cableTray' }) },
  conduit: { label: 'Conduit', icon: 'conduit', keys: 'CN', run: tool(LineTool, { kind: 'conduit' }) },
  sprinkler: { label: 'Sprinkler', icon: 'sprinkler', run: component('sprinklers', 'cpt-sprinkler'), desc: 'Sprinkler heads at the ceiling' },
  wire: { label: 'Wire', icon: 'wire', run: tool(LineTool, { kind: 'wire' }), desc: 'Circuit wiring between devices and panels, drawn as arcs in plans' },
  airTerminal: { label: 'Air Terminal', icon: 'airTerminal', run: component('airTerminals', 'cpt-diffuser'), desc: 'Diffusers and grilles, shown in ceiling plans' },
  mechEquipment: { label: 'Mechanical Equipment', icon: 'mechEquipment', run: component('mechanical', 'cpt-ahu') },
  plumbingFixture: { label: 'Plumbing Fixture', icon: 'plumbing', run: component('plumbing', 'cpt-toilet') },
  lightingFixture: { label: 'Lighting Fixture', icon: 'lightingFixture', run: component('lighting', 'cpt-downlight') },
  electricalFixture: { label: 'Device', icon: 'device', run: component('electricalFixtures', 'cpt-receptacle'), desc: 'Receptacles and switches' },
  electricalEquipment: { label: 'Electrical Equipment', icon: 'elecEquipment', run: component('electricalEquipment', 'cpt-panel') },
  mass: { label: 'In-Place Mass', icon: 'mass', keys: 'MS', run: tool(SketchTool, { kind: 'mass' }), desc: 'A volume to study the form of a building before modeling it' },
  wallByFace: { label: 'Wall by Face', icon: 'wallByFace', run: tool(ByFaceTool, { what: 'wall' }), desc: 'Walls on every level along the sides of a mass' },
  floorByFace: { label: 'Floor by Face', icon: 'floorByFace', run: tool(ByFaceTool, { what: 'floor' }), desc: 'Floors at every level a mass crosses' },
  roofByFace: { label: 'Roof by Face', icon: 'roofByFace', run: tool(ByFaceTool, { what: 'roof' }), desc: 'A flat roof on top of a mass' },
  curtainByFace: { label: 'Curtain System by Face', icon: 'curtainWall', run: tool(ByFaceTool, { what: 'curtain' }), desc: 'Curtain walls around the sides of a mass' },
  topo: { label: 'Toposurface', icon: 'topo', run: tool(TopoTool), desc: 'Ground surface through points at their elevations' },
  propertyLine: { label: 'Property Line', icon: 'propertyLine', run: tool(SketchTool, { kind: 'propertyLine' }) },
  siteComponent: { label: 'Site Component', icon: 'siteComponent', run: component('site', 'cpt-bench') },
  parkingComponent: { label: 'Parking Component', icon: 'parking', run: component('parking', 'cpt-parking') },
  floor: { label: 'Floor', icon: 'floor', keys: 'SB', run: tool(SketchTool, { kind: 'floor' }), desc: 'Sketch a floor boundary' },
  ceiling: { label: 'Ceiling', icon: 'ceiling', run: tool(SketchTool, { kind: 'ceiling' }) },
  roof: { label: 'Roof', icon: 'roof', run: tool(SketchTool, { kind: 'roof' }), desc: 'Roof by footprint' },
  stair: { label: 'Stair', icon: 'stair', run: tool(StairTool) },
  railing: { label: 'Railing', icon: 'railing', run: tool(SketchTool, { kind: 'railing' }) },
  room: { label: 'Room', icon: 'room', keys: 'RM', run: tool(RoomTool) },
  roomSeparator: { label: 'Room Separator', icon: 'roomSeparator', run: tool(LineTool, { kind: 'roomSeparator' }) },
  'rooms-auto': { label: 'Place Rooms Automatically', icon: 'room', run: (app) => (app.requirePlan() ? placeRoomsAutomatically(app) : null) },
  roomFill: { label: 'Room Color Fill', icon: 'palette', run: (app) => app.toggleViewProp('roomFill') },
  level: { label: 'Level', icon: 'level', keys: 'LL', run: (app) => app.levelCommand() },
  grid: { label: 'Grid', icon: 'grid', keys: 'GR', run: tool(LineTool, { kind: 'grid' }) },

  // Annotate
  dimension: { label: 'Aligned Dimension', icon: 'dimAligned', keys: 'DI', run: tool(DimensionTool, { linear: false }), desc: 'Dimension between parallel references, measured square to them' },
  dimLinear: { label: 'Linear Dimension', icon: 'dimension', run: tool(DimensionTool, { linear: true }), desc: 'Horizontal or vertical dimension between points' },
  dimAngular: { label: 'Angular Dimension', icon: 'dimAngular', run: tool(AngularDimTool), desc: 'Angle between two lines, walls or edges' },
  dimRadial: { label: 'Radial Dimension', icon: 'dimRadial', run: tool(RadialDimTool), desc: 'Radius of a circle, arc or round column' },
  dimDiameter: { label: 'Diameter Dimension', icon: 'dimDiameter', run: tool(RadialDimTool, { diameter: true }), desc: 'Diameter of a circle, arc or round column' },
  spotElevation: { label: 'Spot Elevation', icon: 'spotElevation', run: tool(SpotTool, { mode: 'elevation' }), desc: 'Elevation of a point: the floor or roof under it in plans, its height in elevations and sections' },
  spotCoordinate: { label: 'Spot Coordinate', icon: 'spotCoordinate', run: tool(SpotTool, { mode: 'coordinate' }), desc: 'North and east coordinates of a point, from the project base point' },
  spotSlope: { label: 'Spot Slope', icon: 'spotSlope', run: tool(SpotTool, { mode: 'slope' }), desc: 'Slope arrow and angle of a roof face' },
  text: { label: 'Text', icon: 'text', keys: 'TX', run: tool(TextTool) },
  findReplace: { label: 'Find/Replace', icon: 'findReplace', run: (app) => app.findReplaceDialog(), desc: 'Find and replace words in the text notes of every view' },
  detailLine: { label: 'Detail Line', icon: 'detailLine', keys: 'DL', run: tool(LineTool, { kind: 'detailLine' }) },
  detailArc: { label: 'Detail Arc', icon: 'arc', run: tool(ArcTool), desc: 'Circles and arcs drawn in the view' },
  region: { label: 'Filled Region', icon: 'boundary', keys: 'FR', run: tool(SketchTool, { kind: 'region' }), desc: 'Sketch a hatched or solid area in the view' },
  detailItem: { label: 'Detail Component', icon: 'detailItem', run: tool(DetailItemTool), desc: 'Place 2D construction details: lumber, steel sections, block, brick, break lines' },
  revisionCloud: { label: 'Revision Cloud', icon: 'revisionCloud', keys: 'RC', run: tool(SketchTool, { kind: 'revisionCloud' }), desc: 'Mark what changed in a revision' },
  revisions: { label: 'Revisions', icon: 'revisions', run: (app) => app.revisionsDialog(), desc: 'Number, date and issue the revisions of the drawings' },
  insulation: { label: 'Insulation', icon: 'insulation', run: tool(InsulationTool), desc: 'Batt insulation symbol along a line' },
  tag: { label: 'Tag by Category', icon: 'tag', keys: 'TG', run: tool(TagTool) },
  tagMulti: { label: 'Multi-Category Tag', icon: 'tagMulti', run: tool(TagTool, { any: true }), desc: 'Tag an element of any model category with its mark' },
  treadNumber: { label: 'Tread Number', icon: 'treadNumber', run: tool(TreadNumberTool), desc: 'Number the treads of a stair in a plan' },
  dimArcLength: { label: 'Arc Length Dimension', icon: 'dimArc', run: tool(RadialDimTool, { arcLength: true }), desc: 'The length along an arc' },
  tagAll: { label: 'Tag All Not Tagged', icon: 'tagAll', run: (app) => tagAll(app) },
  tagMaterial: { label: 'Material Tag', icon: 'materialTag', run: tool(TagTool, { show: 'material' }), desc: 'Label the material of a wall, floor, roof or other element' },
  keynote: { label: 'Keynote', icon: 'keynote', run: tool(TagTool, { show: 'keynote' }), desc: 'Tag elements with the keynote of their type' },
  colorLegend: { label: 'Color Fill Legend', icon: 'colorLegend', run: tool(LegendTool), desc: 'A legend of the room colors in a plan' },
  symbol: { label: 'Symbol', icon: 'northArrow', run: tool(SymbolTool), desc: 'North arrows, graphic scales and other symbols' },
  northArrow: { label: 'North Arrow', icon: 'northArrow', run: tool(SymbolTool, { family: 'north' }) },
  scaleBar: { label: 'Graphic Scale', icon: 'scaleBar', run: tool(SymbolTool, { family: 'scale' }) },
  spanDirection: { label: 'Span Direction', icon: 'spanDirection', run: tool(SymbolTool, { family: 'span' }), desc: 'Show which way a floor or deck spans' },

  // Modify
  move: { label: 'Move', icon: 'move', keys: 'MV', enabled: hasSel, run: tool(MoveTool) },
  copy: { label: 'Copy', icon: 'copyEl', keys: 'CO', enabled: hasSel, run: tool(MoveTool, { copy: true }) },
  rotate: { label: 'Rotate', icon: 'rotate', keys: 'RO', enabled: hasSel, run: tool(RotateTool) },
  mirrorPick: { label: 'Mirror - Pick Axis', icon: 'mirror', keys: 'MM', enabled: hasSel, run: tool(MirrorTool) },
  mirrorDraw: { label: 'Mirror - Draw Axis', icon: 'mirrorDraw', keys: 'DM', enabled: hasSel, run: tool(MirrorTool, { draw: true }) },
  array: { label: 'Array', icon: 'array', keys: 'AR', enabled: hasSel, run: tool(ArrayTool) },
  align: { label: 'Align', icon: 'align', keys: 'AL', run: tool(AlignTool) },
  offset: { label: 'Offset', icon: 'offset', keys: 'OF', run: tool(OffsetTool) },
  trim: { label: 'Trim/Extend to Corner', icon: 'trim', keys: 'TR', run: tool(TrimTool, { mode: 'corner' }) },
  extend: { label: 'Trim/Extend Single Element', icon: 'trimSingle', run: tool(TrimTool, { mode: 'single' }) },
  split: { label: 'Split Element', icon: 'split', keys: 'SL', run: tool(SplitTool) },
  scaleEl: { label: 'Scale', icon: 'scale', keys: 'RE', enabled: hasSel, run: tool(ScaleTool), desc: 'Resize the selection about a base point' },
  measure: { label: 'Measure', icon: 'measure', keys: 'ME', run: tool(MeasureTool) },
  matchType: { label: 'Match Type', icon: 'matchType', keys: 'MA', run: tool(MatchTypeTool) },
  flip: { label: 'Flip', icon: 'flip', enabled: hasSel, run: (app) => app.flipSelection() },
  attachTop: { label: 'Attach Top to Roof', icon: 'roof', enabled: hasSel, run: (app) => app.attachTop(true), desc: 'Extend the selected walls up to the underside of the roof above them' },
  detachTop: { label: 'Detach Top', icon: 'wall', enabled: hasSel, run: (app) => app.attachTop(false) },
  editType: { label: 'Edit Type', icon: 'types', run: (app) => app.editTypeDialog() },
  editBoundary: { label: 'Edit Boundary', icon: 'boundary', run: (app) => app.editBoundary() },
  selectSimilar: { label: 'Select All Instances', icon: 'pointer', keys: 'SA', enabled: hasSel, run: (app, args) => app.selectSimilar(args?.scope || 'view') },

  // View
  visibility: { label: 'Visibility/Graphics', icon: 'visibility', keys: 'VV', run: (app) => app.visibilityDialog(), desc: 'Show, hide and restyle categories and filters in the view' },
  filters: { label: 'Filters', icon: 'filterRules', run: (app) => app.filtersDialog(), desc: 'Rules that select elements by category and parameters, to hide or restyle them in views' },
  viewTemplates: { label: 'View Templates', icon: 'viewTemplate', run: (app) => app.templatesDialog(), desc: 'Save view settings as templates and apply them to many views' },
  templateFromView: {
    label: 'Create Template from Current View',
    icon: 'viewTemplate',
    run: (app) => app.templateFromView(),
  },
  thinLines: { label: 'Thin Lines', icon: 'thinLines', keys: 'TL', run: (app) => app.toggleSetting('thinLines') },
  view3d: { label: 'Default 3D View', icon: 'view3d', run: (app) => app.open3D() },
  newView3d: { label: 'New 3D View', icon: 'view3d', run: (app) => app.new3DView() },
  section: { label: 'Section', icon: 'section', run: tool(SectionTool) },
  elevation: { label: 'Elevation', icon: 'elevation', run: tool(ElevationTool) },
  levelInElevation: { label: 'Level', icon: 'level', run: tool(LevelTool) },
  planViews: { label: 'Floor Plan', icon: 'planView', run: (app) => app.planViewDialog() },
  duplicateView: { label: 'Duplicate View', icon: 'duplicate', run: (app, args) => app.duplicateView(args?.id) },
  duplicateDetailing: { label: 'Duplicate with Detailing', icon: 'duplicate', run: (app, args) => app.duplicateView(args?.id, { detailing: true }), desc: 'Copy the view with its dimensions, text, tags and other annotations' },
  callout: { label: 'Callout', icon: 'callout', run: tool(CalloutTool), desc: 'Draw a rectangle to make an enlarged, cropped plan of that area' },
  draftingView: { label: 'Drafting View', icon: 'draftingView', run: (app) => app.newFlatView('drafting'), desc: 'A 2D view for details drawn with lines, regions and annotations' },
  legend: { label: 'Legend', icon: 'legend', run: (app) => app.newFlatView('legend'), desc: 'A view that explains symbols and types used in the drawings' },
  legendComponent: { label: 'Legend Component', icon: 'legendComponent', run: tool(LegendComponentTool), desc: 'Place a type, such as a wall or door type, in a legend' },
  cropView: { label: 'Crop View', icon: 'cropView', run: (app) => app.toggleCrop('cropOn'), desc: 'Hide the model outside the crop region' },
  cropShow: { label: 'Show Crop Region', icon: 'cropShow', run: (app) => app.toggleCrop('cropShow'), desc: 'Show the crop region, with handles to resize it' },
  schedule: { label: 'Schedule', icon: 'schedule', run: (app, args) => app.newScheduleDialog(args?.category) },
  sheet: { label: 'Sheet', icon: 'sheet', run: (app) => app.newSheet() },
  placeView: { label: 'Place View on Sheet', icon: 'sheet', run: (app) => app.placeViewDialog() },
  hideEl: { label: 'Hide Element in View', icon: 'hideEl', keys: 'EH', enabled: hasSel, run: (app) => app.hideInView('element') },
  overrideEl: { label: 'Override Graphics in View', icon: 'wsDisplay', keys: 'OG', enabled: hasSel, run: (app) => app.elementOverrideDialog(), desc: 'Colour, line weight or halftone for the selected elements in this view' },
  hideCat: { label: 'Hide Category in View', icon: 'hideEl', keys: 'VH', enabled: hasSel, run: (app) => app.hideInView('category') },
  tempHide: { label: 'Hide Temporarily', icon: 'hideEl', keys: 'HH', enabled: hasSel, run: (app) => app.temporary('hide') },
  tempIsolate: { label: 'Isolate Temporarily', icon: 'isolate', keys: 'HI', enabled: hasSel, run: (app) => app.temporary('isolate') },
  tempReset: { label: 'Reset Temporary Hide/Isolate', icon: 'refresh', keys: 'HR', run: (app) => app.temporary('reset') },
  revealHidden: { label: 'Reveal Hidden Elements', icon: 'reveal', keys: 'RH', run: (app) => app.toggleReveal() },
  unhideInView: { label: 'Unhide in View', icon: 'eye', run: (app) => app.unhideSelected() },
  sectionBox: { label: 'Section Box', icon: 'sectionBox', keys: 'BX', run: (app) => app.toggleSectionBox() },
  zoomFit: { label: 'Zoom to Fit', icon: 'zoomFit', keys: 'ZF', run: (app) => app.zoomFit() },
  zoomRegion: { label: 'Zoom in Region', icon: 'zoomRegion', keys: 'ZR', run: tool(ZoomRegionTool) },
  zoomIn: { label: 'Zoom In', icon: 'zoom-in', run: (app) => app.vc?.zoomBy?.(1.5) },
  zoomOut: { label: 'Zoom Out', icon: 'zoom-out', run: (app) => app.vc?.zoomBy?.(1 / 1.5) },
  closeInactive: { label: 'Close Inactive Views', icon: 'closeHidden', run: (app) => app.closeInactiveViews() },
  toggleProps: { label: 'Properties', icon: 'sliders', keys: 'PP', run: (app) => app.togglePane('props') },
  toggleBrowser: { label: 'Project Browser', icon: 'layers', run: (app) => app.togglePane('browser') },
  nextView: { label: 'Next View', icon: 'chevron-right', accel: 'Ctrl+Tab', run: (app) => app.cycleView(1) },

  // Manage
  objectStyles: { label: 'Object Styles', icon: 'objectStyles', run: (app) => manage.objectStylesDialog(app), desc: 'Default line colors and weights of each category' },
  projectParams: { label: 'Project Parameters', icon: 'projectParams', run: (app) => manage.projectParamsDialog(app), desc: 'Add your own parameters to categories of elements' },
  phases: { label: 'Phases', icon: 'phases', run: (app) => manage.phasesDialog(app), desc: 'The construction phases of the project, such as Existing and New Construction' },
  demolish: { label: 'Demolish', icon: 'demolish', run: tool(DemolishTool), desc: 'Mark elements as demolished in the phase of the view' },
  renumber: { label: 'Renumber', icon: 'renumber', run: tool(RenumberTool), desc: 'Give doors, windows, rooms or areas sequential numbers by clicking them in order' },
  selectionSave: { label: 'Save Selection', icon: 'selectionSave', enabled: hasSel, run: (app) => manage.saveSelection(app), desc: 'Save the selection to load it again later' },
  selectionLoad: { label: 'Load Selection', icon: 'selectionLoad', run: (app) => manage.loadSelection(app), desc: 'Select a saved selection, or add to it' },
  selectionIds: { label: 'IDs of Selection', icon: 'selectionIds', enabled: hasSel, run: (app) => manage.idsOfSelection(app) },
  selectById: { label: 'Select by ID', icon: 'selectById', run: (app) => manage.selectById(app) },
  warnings: { label: 'Warnings', icon: 'warning', run: (app) => manage.warningsDialog(app), desc: 'Problems in the model: overlapping walls, unenclosed rooms, duplicate marks' },
  space: { label: 'Space', icon: 'space', keys: 'SP', run: tool(SpaceTool), desc: 'A space for building services: area, volume, occupancy and loads' },
  spacesAuto: { label: 'Place Spaces Automatically', icon: 'space', run: (app) => (app.requirePlan() ? placeSpacesAutomatically(app) : null), desc: 'One space per room of the active level' },
  spaceSeparator: { label: 'Space Separator', icon: 'roomSeparator', run: (app) => app.run('roomSeparator'), desc: 'Divide an open area into spaces (shared with room separation lines)' },
  zones: { label: 'Zones', icon: 'zone', run: (app) => analyze.zonesDialog(app), desc: 'Group spaces served by one system or thermostat' },
  loads: { label: 'Heating and Cooling Loads', icon: 'loads', run: (app) => analyze.loadsDialog(app), desc: 'First estimates of heating and cooling for each space and zone' },
  checkSystems: { label: 'Check Systems', icon: 'checkSystems', run: (app) => analyze.checkSystemsDialog(app), desc: 'Find duct and pipe ends that connect to nothing' },
  ductLegend: { label: 'Duct Legend', icon: 'colorLegend', run: tool(LegendTool, { source: 'ducts' }), desc: 'A legend of the duct systems in a plan' },
  pipeLegend: { label: 'Pipe Legend', icon: 'colorLegend', run: tool(LegendTool, { source: 'pipes' }), desc: 'A legend of the pipe systems in a plan' },
  zoneLegend: { label: 'Zone Legend', icon: 'colorLegend', run: tool(LegendTool, { source: 'zones' }), desc: 'A legend of the zones of the spaces in a plan' },
  shadows: {
    label: 'Shadows',
    icon: 'shadows',
    toggle: (app) => !!app.activeView?.shadows,
    enabled: (app) => ['view3d', 'elevation', 'section'].includes(app.activeView?.kind),
    run: (app) => {
      const v = app.activeView;
      if (!v) return;
      app.commit(v.shadows ? 'Shadows off' : 'Shadows on', () => app.doc.update(v.id, { shadows: !v.shadows }));
      if (!v.shadows && sunDirection(app.doc.get('project')).altitude <= 0) app.toast('The sun is below the horizon at the set date and time. Change it in Sun Settings.');
    },
    desc: 'Cast shadows from the sun at the project location, date and time',
  },
  scopeBox: { label: 'Scope Box', icon: 'scopeBox', run: tool(ScopeBoxTool), desc: 'Named extents that views can crop to; the views follow when it changes' },
  render: { label: 'Render', icon: 'render', run: (app) => renderui.renderDialog(app), enabled: (app) => app.activeView?.kind === 'view3d', desc: 'A presentation image of the 3D view with materials, sun, shadows and sky' },
  sunSettings: { label: 'Sun Settings', icon: 'sun-l', run: (app) => sunui.sunSettingsDialog(app), desc: 'Project location, north angle, date and time for shadows' },
  designOptions: { label: 'Design Options', icon: 'designOptions', keys: 'DO', run: (app) => dopts.designOptionsDialog(app), desc: 'Explore alternatives for part of the design in one project' },
  addToOption: { label: 'Add to Option', icon: 'designOptions', enabled: hasSel, run: (app) => dopts.addToOption(app), desc: 'Move the selected elements into the design option being edited' },
  viewOptions: { label: 'View Design Options', icon: 'designOptions', run: (app) => dopts.viewOptionsDialog(app), desc: 'Which option of each set the active view shows' },
  finishOption: { label: 'Finish Editing Option', icon: 'check', enabled: () => !!editingOption(), run: (app) => app.editOption(null), desc: 'Go back to editing the main model' },
  showBasePoints: {
    label: 'Show Base Points',
    icon: 'basePoints',
    toggle: (app) => !!app.activeView?.showBasePoints,
    enabled: (app) => ['plan', 'ceilingPlan', 'areaPlan'].includes(app.activeView?.kind),
    run: (app) => {
      const v = app.activeView;
      app.commit('Base points', () => app.doc.update(v.id, { showBasePoints: !v.showBasePoints }));
      if (!v.showBasePoints) app.setPrompt('Drag the survey point to a known site point and set its northing, easting and elevation in Properties.');
    },
    desc: 'Show the project base point and the survey point in this plan, to move them or set site coordinates',
  },
  globalParams: { label: 'Global Parameters', icon: 'globalParams', run: (app) => globalsui.globalParamsDialog(app), desc: 'Named project values that element parameters can follow, with formulas' },
  transferStandards: { label: 'Transfer Project Standards', icon: 'transfer', run: (app) => manage.transferStandardsDialog(app), desc: 'Copy types, materials, view templates, filters and more from another project file' },
  startingView: { label: 'Starting View', icon: 'startingView', run: (app) => app.startingViewDialog(), desc: 'The view that opens first with the project' },
  projectInfo: { label: 'Project Information', icon: 'info', run: (app) => app.projectInfoDialog() },
  units: { label: 'Project Units', icon: 'units', keys: 'UN', run: (app) => app.unitsDialog() },
  materials: { label: 'Materials', icon: 'material', run: (app) => app.materialsDialog() },
  levels: { label: 'Levels', icon: 'level', run: (app) => app.levelsDialog() },
  types: { label: 'Types', icon: 'types', run: (app) => app.typesDialog() },
  snaps: { label: 'Snaps', icon: 'snaps', keys: 'SN', run: (app) => app.snapsDialog() },
  purge: { label: 'Purge Unused', icon: 'purge', run: (app) => app.purgeDialog() },
  tileViews: { label: 'Tile Views', icon: 'tileViews', keys: 'WT', toggle: (app) => app.viewport?.tiled, run: (app) => app.tileViews(), desc: 'Show the open views side by side' },
  tabViews: { label: 'Tab Views', icon: 'tabViews', keys: 'TW', run: (app) => app.tabViews(), desc: 'Show one view at a time, with tabs' },
  shortcuts: { label: 'Keyboard Shortcuts', icon: 'keyboard', run: (app) => app.shortcutsDialog(), desc: 'See and change the two-letter shortcuts' },
  options: { label: 'Options', icon: 'settings', run: (app) => app.optionsDialog(), desc: 'Your preferences: theme, tooltips, selection, navigation and more' },
  help: { label: 'Help', icon: 'help', accel: 'F1', run: (app) => app.helpDialog() },
  about: { label: 'About', icon: 'info', run: (app) => app.aboutDialog() },
  search: { label: 'Search Commands', icon: 'search', accel: 'Ctrl+K', run: (app) => app.commandPalette() },
  theme: { label: 'Theme', icon: 'monitor', run: (app, args) => app.setTheme(args?.value) },
  signIn: { label: 'Sign In', icon: 'log-in', run: (app) => app.signIn() },

  // Actions used by property buttons
  'topo-points': { label: 'Toposurface Points', icon: 'topo', run: (app) => manage.topoPointsDialog(app) },
  'schedule-fields': { label: 'Schedule Fields', icon: 'sliders', run: (app, args) => app.scheduleFieldsDialog(args?.id) },
  'section-box': { label: 'Section Box', icon: 'sectionBox', run: (app) => app.toggleSectionBox() },
  'toggle-persp': {
    label: 'Perspective',
    icon: 'view3d',
    run: (app) => {
      const c = app.vc;
      if (!c?.is3D) return;
      c.cam.persp = c.cam.persp === false;
      app.viewChanged();
      app.renderViewbar();
      app.props.render();
      app.requestRender();
    },
  },

  // Navigation modes (touch friendly)
  navPan: { label: 'Pan', icon: 'hand', run: (app) => app.setNavMode('pan') },
  navOrbit: { label: 'Orbit', icon: 'orbit', run: (app) => app.setNavMode('orbit') },
};

/** Apply the user's two-letter shortcuts ({ command: 'XY' | '' }) over the defaults. */
export function applyShortcuts(overrides) {
  for (const [name, d] of Object.entries(COMMANDS)) {
    if (!('defaultKeys' in d)) d.defaultKeys = d.keys ?? '';
    const k = overrides && name in overrides ? overrides[name] : d.defaultKeys;
    if (k) d.keys = k;
    else delete d.keys;
  }
}
