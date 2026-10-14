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
  RoomTool,
  DimensionTool,
  TextTool,
  TagTool,
  SectionTool,
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
  sample: { label: 'Open Sample Project', icon: 'house', run: (app) => app.openSample() },
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
  door: { label: 'Door', icon: 'door', keys: 'DR', run: tool(HostedTool, { kind: 'door' }), desc: 'Place doors in walls' },
  window: { label: 'Window', icon: 'window', keys: 'WN', run: tool(HostedTool, { kind: 'window' }), desc: 'Place windows in walls' },
  shaft: { label: 'Shaft Opening', icon: 'shaft', run: tool(SketchTool, { kind: 'shaft' }), desc: 'Cut an opening through the floor above and the ceiling of this level' },
  opening: { label: 'Wall Opening', icon: 'opening', run: tool(HostedTool, { kind: 'opening' }), desc: 'Cut a rectangular opening in a wall' },
  component: { label: 'Component', icon: 'component', keys: 'CM', run: tool(ComponentTool, { kind: 'component' }), desc: 'Place furniture, fixtures and equipment' },
  column: { label: 'Column', icon: 'column', keys: 'CL', run: tool(ComponentTool, { kind: 'column' }) },
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
  dimension: { label: 'Aligned Dimension', icon: 'dimAligned', keys: 'DI', run: tool(DimensionTool) },
  text: { label: 'Text', icon: 'text', keys: 'TX', run: tool(TextTool) },
  detailLine: { label: 'Detail Line', icon: 'detailLine', keys: 'DL', run: tool(LineTool, { kind: 'detailLine' }) },
  tag: { label: 'Tag by Category', icon: 'tag', keys: 'TG', run: tool(TagTool) },
  tagAll: { label: 'Tag All Not Tagged', icon: 'tagAll', run: (app) => tagAll(app) },

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
  editType: { label: 'Edit Type', icon: 'types', run: (app) => app.editTypeDialog() },
  editBoundary: { label: 'Edit Boundary', icon: 'boundary', run: (app) => app.editBoundary() },
  selectSimilar: { label: 'Select All Instances', icon: 'pointer', keys: 'SA', enabled: hasSel, run: (app, args) => app.selectSimilar(args?.scope || 'view') },

  // View
  visibility: { label: 'Visibility/Graphics', icon: 'visibility', keys: 'VV', run: (app) => app.visibilityDialog() },
  thinLines: { label: 'Thin Lines', icon: 'thinLines', keys: 'TL', run: (app) => app.toggleSetting('thinLines') },
  view3d: { label: 'Default 3D View', icon: 'view3d', run: (app) => app.open3D() },
  newView3d: { label: 'New 3D View', icon: 'view3d', run: (app) => app.new3DView() },
  section: { label: 'Section', icon: 'section', run: tool(SectionTool) },
  elevation: { label: 'Elevation', icon: 'elevation', run: tool(ElevationTool) },
  levelInElevation: { label: 'Level', icon: 'level', run: tool(LevelTool) },
  planViews: { label: 'Floor Plan', icon: 'planView', run: (app) => app.planViewDialog() },
  duplicateView: { label: 'Duplicate View', icon: 'duplicate', run: (app, args) => app.duplicateView(args?.id) },
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
