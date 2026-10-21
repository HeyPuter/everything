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
  MeasureTool,
  MatchTypeTool,
  ZoomRegionTool,
} from './editor/modify.js';
import { deleteElements } from './core/ops.js';
import { PlaceGroupTool, GroupMemberTool } from './editor/groups.js';
import { CurtainGridTool } from './editor/curtain.js';
import { AngularDimTool, RadialDimTool, SpotTool, InsulationTool, DetailItemTool, ArcTool, SymbolTool, LegendTool, LegendComponentTool } from './editor/annotate.js';

const tool = (Cls, opts = {}) => (app, args) => app.startTool(Cls, { ...opts, ...(args || {}) });
const hasSel = (app) => app.selection.size > 0;

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
  sharedWithMe: { label: 'Shared With Me', icon: 'users', run: (app) => app.openDialog('shared') },

  // Edit
  undo: { label: 'Undo', icon: 'undo', accel: 'Ctrl+Z', run: (app) => app.undo(), enabled: (app) => app.doc?.canUndo },
  redo: { label: 'Redo', icon: 'redo', accel: 'Ctrl+Y', run: (app) => app.redo(), enabled: (app) => app.doc?.canRedo },
  copyClip: { label: 'Copy to Clipboard', icon: 'copy', accel: 'Ctrl+C', run: (app) => app.copyToClipboard(), enabled: hasSel },
  cutClip: { label: 'Cut to Clipboard', icon: 'scissors', accel: 'Ctrl+X', run: (app) => app.copyToClipboard(true), enabled: hasSel },
  paste: { label: 'Paste', icon: 'paste', accel: 'Ctrl+V', run: (app) => app.paste(), enabled: (app) => !!app.clipboard },
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
  projectInfo: { label: 'Project Information', icon: 'info', run: (app) => app.projectInfoDialog() },
  units: { label: 'Project Units', icon: 'units', keys: 'UN', run: (app) => app.unitsDialog() },
  materials: { label: 'Materials', icon: 'material', run: (app) => app.materialsDialog() },
  levels: { label: 'Levels', icon: 'level', run: (app) => app.levelsDialog() },
  types: { label: 'Types', icon: 'types', run: (app) => app.typesDialog() },
  snaps: { label: 'Snaps', icon: 'snaps', keys: 'SN', run: (app) => app.snapsDialog() },
  purge: { label: 'Purge Unused', icon: 'purge', run: (app) => app.purgeDialog() },
  shortcuts: { label: 'Keyboard Shortcuts', icon: 'keyboard', run: (app) => app.shortcutsDialog() },
  help: { label: 'Help', icon: 'help', accel: 'F1', run: (app) => app.helpDialog() },
  about: { label: 'About', icon: 'info', run: (app) => app.aboutDialog() },
  search: { label: 'Search Commands', icon: 'search', accel: 'Ctrl+K', run: (app) => app.commandPalette() },
  theme: { label: 'Theme', icon: 'monitor', run: (app, args) => app.setTheme(args?.value) },
  signIn: { label: 'Sign In', icon: 'log-in', run: (app) => app.signIn() },

  // Actions used by property buttons
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
