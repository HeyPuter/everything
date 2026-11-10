// Command definitions. Shortcuts avoid keys the browser reserves (Ctrl+W,
// Ctrl+N, Ctrl+T) and the menu accelerator letters (F E V C P D T U R W H),
// which open menus for two-key chords such as P then W for a wire.

import { applyTheme, currentTheme } from './theme.js';
import { mil, GRID_PRESETS, SCH_GRID_PRESETS, formatLength, parseLength } from '../core/units.js';
import { promptDialog } from '../ui/dialog.js';
import { bboxUnion, bboxEmpty } from '../core/geom.js';
import { schBounds, translateSch } from '../model/sch.js';
import { pcbBounds, translatePcb } from '../model/pcb.js';

export function registerCommands(app) {
  const c = app.commands;
  const ed = () => app.activeEditor;
  const is = (k) => () => ed()?.kind === k;
  const hasProject = () => !!app.project;
  const hasSel = () => (ed()?.selection?.size || 0) > 0;
  const hasEditor = () => !!ed()?.doc;
  // A sheet or board, which can be drawn as SVG; the component editor cannot.
  const hasDrawing = () => ed()?.kind === 'sch' || ed()?.kind === 'pcb';

  c.registerAll([
    // ---- File ----
    { id: 'file.new', label: 'New project', menuLabel: '&Project...', icon: 'new', run: () => app.newProject() },
    { id: 'file.open', label: 'Open project', menuLabel: '&Open...', icon: 'open', shortcut: 'Mod+O', anywhere: true, run: () => app.openProjectDialog() },
    { id: 'file.openExample', label: 'Open example project', menuLabel: 'Open e&xample', icon: 'chip', run: () => app.openExample() },
    { id: 'file.save', label: 'Save', menuLabel: '&Save', icon: 'save', shortcut: 'Mod+S', anywhere: true, enabled: hasProject, run: () => (ed()?.kind === 'lib' ? ed().save() : app.save()) },
    { id: 'file.saveAs', label: 'Save as', menuLabel: 'Save &as...', shortcut: 'Mod+Shift+S', anywhere: true, enabled: hasProject, run: () => app.saveAs() },
    { id: 'file.download', label: 'Download project file', menuLabel: '&Download project file', icon: 'download', enabled: hasProject, run: () => app.downloadProject() },
    { id: 'file.import', label: 'Open a project file from this device', menuLabel: 'Open from this &device...', icon: 'upload', run: () => app.importFromDevice() },
    { id: 'file.importKicad', label: 'Import KiCad files', menuLabel: '&KiCad schematic and board files...', icon: 'upload', run: () => app.importKicad() },
    { id: 'file.share', label: 'Share project', menuLabel: 'S&hare...', icon: 'share', enabled: hasProject, run: () => app.share() },
    { id: 'file.history', label: 'Version history', menuLabel: '&Version history...', icon: 'history', enabled: hasProject, run: () => app.history() },
    { id: 'file.print', label: 'Print', menuLabel: '&Print...', icon: 'print', shortcut: 'Mod+P', anywhere: true, enabled: hasDrawing, run: () => app.print() },
    { id: 'file.close', label: 'Close project', menuLabel: '&Close project', enabled: hasProject, run: () => app.closeProject() },

    // ---- Export ----
    { id: 'export.fabrication', label: 'Export fabrication package', menuLabel: '&Fabrication package (Gerber, drill, BOM)...', icon: 'gerber', enabled: () => !!app.project?.boards.length, run: () => app.exportFabrication() },
    { id: 'export.gerber', label: 'Export Gerber files', menuLabel: '&Gerber files', enabled: () => !!app.project?.boards.length, run: () => app.exportGerbers() },
    { id: 'export.drill', label: 'Export drill files', menuLabel: '&Drill files', enabled: () => !!app.project?.boards.length, run: () => app.exportDrill() },
    { id: 'export.bom', label: 'Bill of materials', menuLabel: '&Bill of materials (CSV)', icon: 'bom', enabled: hasProject, run: () => app.exportBom() },
    { id: 'export.pnp', label: 'Pick and place file', menuLabel: '&Pick and place (CSV)', enabled: () => !!app.project?.boards.length, run: () => app.exportPnp() },
    { id: 'export.netlist', label: 'Netlist', menuLabel: '&Netlist', icon: 'network', enabled: hasProject, run: () => app.exportNetlist() },
    { id: 'export.svg', label: 'Export current document as SVG', menuLabel: '&SVG image of this document', icon: 'image', enabled: hasDrawing, run: () => app.exportSvg() },

    // ---- Edit ----
    { id: 'edit.undo', label: 'Undo', menuLabel: '&Undo', icon: 'undo', shortcut: 'Mod+Z', enabled: () => !!ed()?.doc?.store.canUndo, run: () => app.undo() },
    { id: 'edit.redo', label: 'Redo', menuLabel: '&Redo', icon: 'redo', shortcut: ['Mod+Y', 'Mod+Shift+Z'], enabled: () => !!ed()?.doc?.store.canRedo, run: () => app.redo() },
    { id: 'edit.cut', label: 'Cut', menuLabel: 'Cu&t', icon: 'cut', shortcut: 'Mod+X', enabled: hasSel, run: () => app.cut() },
    { id: 'edit.copy', label: 'Copy', menuLabel: '&Copy', icon: 'copy', shortcut: 'Mod+C', enabled: hasSel, run: () => app.copy() },
    { id: 'edit.paste', label: 'Paste', menuLabel: '&Paste', icon: 'paste', shortcut: 'Mod+V', enabled: hasEditor, run: () => app.paste() },
    { id: 'edit.duplicate', label: 'Duplicate', menuLabel: 'Dupl&icate', shortcut: 'Mod+D', enabled: hasSel, run: () => app.duplicate() },
    { id: 'edit.delete', label: 'Delete', menuLabel: '&Delete', icon: 'trash', shortcut: ['Delete', 'Backspace'], enabled: hasSel, run: () => ed().deleteSelection() },
    { id: 'edit.selectAll', label: 'Select all', menuLabel: 'Select &all', shortcut: 'Mod+A', enabled: hasEditor, run: () => ed().selectAll() },
    { id: 'edit.find', label: 'Find', menuLabel: '&Find...', icon: 'search', shortcut: 'Mod+F', anywhere: true, enabled: hasEditor, run: () => app.find() },
    { id: 'edit.properties', label: 'Properties', menuLabel: 'P&roperties', icon: 'settings', run: () => app.showPanel('properties', true) },
    { id: 'edit.alignLeft', label: 'Align left', menuLabel: 'Align &left', enabled: () => (ed()?.selection?.size || 0) > 1, run: () => align('left') },
    { id: 'edit.alignRight', label: 'Align right', menuLabel: 'Align &right', enabled: () => (ed()?.selection?.size || 0) > 1, run: () => align('right') },
    { id: 'edit.alignTop', label: 'Align top', menuLabel: 'Align &top', enabled: () => (ed()?.selection?.size || 0) > 1, run: () => align('top') },
    { id: 'edit.alignBottom', label: 'Align bottom', menuLabel: 'Align &bottom', enabled: () => (ed()?.selection?.size || 0) > 1, run: () => align('bottom') },
    { id: 'edit.distributeH', label: 'Distribute horizontally', menuLabel: 'Distribute &horizontally', enabled: () => (ed()?.selection?.size || 0) > 2, run: () => distribute('x') },
    { id: 'edit.distributeV', label: 'Distribute vertically', menuLabel: 'Distribute &vertically', enabled: () => (ed()?.selection?.size || 0) > 2, run: () => distribute('y') },
    { id: 'app.preferences', label: 'Preferences', menuLabel: 'Pr&eferences...', icon: 'settings', shortcut: 'Mod+,', anywhere: true, run: () => app.preferences() },

    // ---- View ----
    { id: 'view.fit', label: 'Fit document', menuLabel: 'Fit &document', icon: 'fit', shortcut: ['Mod+PageDown', 'Home'], enabled: hasEditor, run: () => ed().fitAll() },
    { id: 'view.fitContent', label: 'Fit all objects', menuLabel: 'Fit all &objects', enabled: hasEditor, run: () => ed().fitContent() },
    { id: 'view.fitSelection', label: 'Fit selection', menuLabel: 'Fit &selection', shortcut: 'Mod+Shift+PageDown', enabled: hasSel, run: () => ed().fitSelection() },
    { id: 'view.zoomIn', label: 'Zoom in', menuLabel: 'Zoom &in', icon: 'zoom-in', shortcut: ['PageUp', 'Mod+='], enabled: hasEditor, run: () => ed().zoomBy(1.4) },
    { id: 'view.zoomOut', label: 'Zoom out', menuLabel: 'Zoom &out', icon: 'zoom-out', shortcut: ['PageDown', 'Mod+-'], enabled: hasEditor, run: () => ed().zoomBy(1 / 1.4) },
    { id: 'view.cycleGrid', label: 'Next grid size', menuLabel: '&Next grid size', icon: 'grid', shortcut: 'G', enabled: hasEditor, run: () => cycleGrid(1) },
    { id: 'view.cycleGridBack', label: 'Previous grid size', shortcut: 'Shift+G', enabled: hasEditor, run: () => cycleGrid(-1) },
    { id: 'view.setGrid', label: 'Set grid', menuLabel: 'Set &grid...', shortcut: 'Mod+G', enabled: hasEditor, run: () => setGrid() },
    { id: 'view.toggleUnits', label: 'Toggle units (mm / mil)', menuLabel: 'Toggle &units', shortcut: 'Q', run: () => { app.settings.set('units', app.settings.get('units') === 'mm' ? 'mil' : 'mm'); app.toast(`Units: ${app.settings.get('units')}`, { timeout: 1500 }); } },
    { id: 'view.hud', label: 'Heads-up display', menuLabel: '&Heads-up display', shortcut: 'Shift+H', checked: () => app.settings.get('showHud'), run: () => { app.settings.set('showHud', !app.settings.get('showHud')); ed()?._updateHud?.(); } },
    { id: 'panel.projects', label: 'Projects panel', menuLabel: '&Projects', checked: () => app.isPanelVisible('projects'), run: () => app.togglePanel('projects') },
    { id: 'panel.navigator', label: 'Navigator panel', menuLabel: '&Navigator', checked: () => app.isPanelVisible('navigator'), run: () => app.togglePanel('navigator') },
    { id: 'panel.properties', label: 'Properties panel', menuLabel: 'P&roperties', checked: () => app.isPanelVisible('properties'), run: () => app.togglePanel('properties') },
    { id: 'panel.components', label: 'Components panel', menuLabel: '&Components', checked: () => app.isPanelVisible('components'), run: () => app.togglePanel('components') },
    { id: 'panel.layers', label: 'Layers panel', menuLabel: '&Layers', checked: () => app.isPanelVisible('layers'), run: () => app.togglePanel('layers') },
    { id: 'panel.messages', label: 'Messages panel', menuLabel: '&Messages', checked: () => app.bottomOpen, run: () => app.setBottomDock(!app.bottomOpen) },
    { id: 'theme.system', label: 'Theme: match system', menuLabel: '&System', checked: () => currentTheme() === 'system', run: () => setTheme('system') },
    { id: 'theme.light', label: 'Theme: light', menuLabel: '&Light', checked: () => currentTheme() === 'light', run: () => setTheme('light') },
    { id: 'theme.dark', label: 'Theme: dark', menuLabel: '&Dark', checked: () => currentTheme() === 'dark', run: () => setTheme('dark') },

    // ---- Project ----
    { id: 'project.compile', label: 'Compile and check the schematic', menuLabel: 'C&ompile (electrical rules check)', icon: 'erc', enabled: hasProject, run: () => app.compile() },
    { id: 'project.updateBoard', label: 'Update board from schematic', menuLabel: '&Update board from schematic...', icon: 'sync', enabled: hasProject, run: () => app.updateBoard() },
    { id: 'project.addSheet', label: 'Add schematic sheet', menuLabel: '&Schematic sheet', icon: 'symbol', enabled: hasProject, run: () => app.addDoc('sch') },
    { id: 'project.addBoard', label: 'Add board', menuLabel: '&Board', icon: 'board', enabled: hasProject, run: () => app.addDoc('pcb') },
    { id: 'project.rename', label: 'Rename project', menuLabel: '&Rename project...', icon: 'pencil', enabled: hasProject, run: () => app.renameProject() },
    { id: 'lib.manage', label: 'Project component library', menuLabel: 'Component &library...', icon: 'library', enabled: hasProject, run: () => app.manageLibrary() },
    { id: 'lib.newComponent', label: 'New component', menuLabel: 'New &component...', icon: 'package', enabled: hasProject, run: () => app.newComponent() },
    { id: 'lib.footprintWizard', label: 'Footprint wizard', menuLabel: '&Footprint wizard...', icon: 'wand', enabled: hasProject, run: () => app.newComponent({ start: 'footprint' }) },
    { id: 'lib.blankComponent', label: 'New blank component in the editor', menuLabel: 'New component in the &editor', icon: 'pencil', enabled: hasProject, run: () => app.newComponentInEditor() },

    // ---- Component editor ----
    { id: 'libed.place.pin', context: 'lib', label: 'Place pin', menuLabel: '&Pin', icon: 'pin', run: () => ed().startTool('pin') },
    { id: 'libed.place.pad', context: 'lib', label: 'Place pad', menuLabel: 'Pa&d', icon: 'pad', run: () => ed().startTool('pad') },
    { id: 'libed.padArray', context: 'lib', label: 'Pad array', menuLabel: 'Pad arra&y...', icon: 'layout-grid', run: () => ed().padArrayDialog() },
    { id: 'libed.place.line', context: 'lib', label: 'Draw line', menuLabel: '&Line', icon: 'line-tool', run: () => ed().startTool('line') },
    { id: 'libed.place.rect', context: 'lib', label: 'Draw rectangle', menuLabel: '&Rectangle', icon: 'square', run: () => ed().startTool('rect') },
    { id: 'libed.place.circle', context: 'lib', label: 'Draw circle', menuLabel: '&Circle', icon: 'circle', run: () => ed().startTool('circle') },
    { id: 'libed.place.arc', context: 'lib', label: 'Draw arc', menuLabel: '&Arc', icon: 'arc-tool', run: () => ed().startTool('arc') },
    { id: 'libed.place.poly', context: 'lib', label: 'Draw polygon', menuLabel: 'P&olygon', icon: 'region', run: () => ed().startTool('poly') },
    { id: 'libed.place.text', context: 'lib', label: 'Place text', menuLabel: '&Text', icon: 'text', run: () => ed().startTool('text') },
    { id: 'libed.rotate', context: 'lib', label: 'Rotate selection', menuLabel: '&Rotate', icon: 'rotate-ccw', shortcut: 'Space', enabled: hasSel, run: () => ed().rotateSelection(90) },
    { id: 'libed.rotateCw', context: 'lib', label: 'Rotate selection clockwise', shortcut: 'Shift+Space', enabled: hasSel, run: () => ed().rotateSelection(270) },
    { id: 'libed.mirrorX', context: 'lib', label: 'Mirror horizontally', menuLabel: 'Mirror &horizontally', icon: 'flip-h', shortcut: 'X', enabled: hasSel, run: () => ed().mirrorSelection('x') },
    { id: 'libed.mirrorY', context: 'lib', label: 'Mirror vertically', menuLabel: 'Mirror &vertically', icon: 'flip-v', shortcut: 'Y', enabled: hasSel, run: () => ed().mirrorSelection('y') },
    { id: 'libed.mode.symbol', context: 'lib', label: 'Edit the symbol', menuLabel: '&Symbol', icon: 'symbol', checked: () => ed()?.mode === 'symbol', run: () => ed().setMode('symbol') },
    { id: 'libed.mode.footprint', context: 'lib', label: 'Edit the footprint', menuLabel: '&Footprint', icon: 'footprint', checked: () => ed()?.mode === 'footprint', run: () => ed().setMode('footprint') },
    { id: 'libed.pinTable', context: 'lib', label: 'Pin table', menuLabel: 'Pin &table...', icon: 'table', run: () => ed().pinTableDialog() },
    { id: 'libed.courtyard', context: 'lib', label: 'Fit courtyard to pads', menuLabel: 'Fit &courtyard', icon: 'select-rect', run: () => ed().fitCourtyard() },
    { id: 'libed.save', context: 'lib', label: 'Save component to the project', menuLabel: '&Save to project', icon: 'save', run: () => ed().save() },
    { id: 'libed.validate', context: 'lib', label: 'Check the component', menuLabel: 'C&heck component', icon: 'list-checks', run: () => {
      const e = ed();
      const list = e.validate().map((m) => ({ ...m, severity: m.severity === 'info' ? 'warning' : m.severity, docId: e.doc.id }));
      app.panels.messages.set(list, `Component check: ${e.doc.name}`);
      app.setBottomDock(true);
      app.updateStatus();
    } },

    // ---- Schematic ----
    { id: 'sch.place.part', context: 'sch', label: 'Place part', menuLabel: '&Part...', icon: 'part', run: () => app.showPanel('components', true, true) },
    { id: 'sch.place.wire', context: 'sch', label: 'Place wire', menuLabel: '&Wire', icon: 'wire', shortcut: 'Shift+W', run: () => ed().startTool('wire') },
    { id: 'sch.place.bus', context: 'sch', label: 'Place bus', menuLabel: '&Bus', icon: 'bus', run: () => ed().startTool('bus') },
    { id: 'sch.place.label', context: 'sch', label: 'Place net label', menuLabel: 'Net &label', icon: 'net-label', run: () => ed().startTool('label') },
    { id: 'sch.place.power', context: 'sch', label: 'Place power port', menuLabel: 'P&ower port', icon: 'power', run: () => ed().startTool('power') },
    { id: 'sch.place.ground', context: 'sch', label: 'Place ground', menuLabel: '&Ground', icon: 'ground', run: () => ed().startTool('ground') },
    { id: 'sch.place.port', context: 'sch', label: 'Place port', menuLabel: 'Po&rt', icon: 'port', run: () => ed().startTool('port') },
    { id: 'sch.place.junction', context: 'sch', label: 'Place junction', menuLabel: '&Junction', icon: 'junction', run: () => ed().startTool('junction') },
    { id: 'sch.place.noerc', context: 'sch', label: 'Place no ERC marker', menuLabel: '&No ERC marker', icon: 'no-erc', run: () => ed().startTool('noerc') },
    { id: 'sch.place.text', context: 'sch', label: 'Place text', menuLabel: '&Text', icon: 'text', run: () => ed().startTool('text') },
    { id: 'sch.place.line', context: 'sch', label: 'Draw line', menuLabel: '&Line', icon: 'line-tool', run: () => ed().startTool('line') },
    { id: 'sch.place.rect', context: 'sch', label: 'Draw rectangle', menuLabel: '&Rectangle', icon: 'square', run: () => ed().startTool('rect') },
    { id: 'sch.place.circle', context: 'sch', label: 'Draw circle', menuLabel: '&Circle', icon: 'circle', run: () => ed().startTool('circle') },
    { id: 'sch.rotate', context: 'sch', label: 'Rotate selection', menuLabel: '&Rotate', icon: 'rotate-ccw', shortcut: 'Space', enabled: hasSel, run: () => ed().rotateSelection(90) },
    { id: 'sch.rotateCw', context: 'sch', label: 'Rotate selection clockwise', shortcut: 'Shift+Space', enabled: hasSel, run: () => ed().rotateSelection(270) },
    { id: 'sch.mirrorX', context: 'sch', label: 'Mirror horizontally', menuLabel: 'Mirror &horizontally', icon: 'flip-h', shortcut: 'X', enabled: hasSel, run: () => ed().mirrorSelection('x') },
    { id: 'sch.mirrorY', context: 'sch', label: 'Mirror vertically', menuLabel: 'Mirror &vertically', icon: 'flip-v', shortcut: 'Y', enabled: hasSel, run: () => ed().mirrorSelection('y') },
    { id: 'sch.annotate', label: 'Annotate schematics', menuLabel: '&Annotate schematics...', icon: 'annotate', enabled: () => !!app.project?.sheets.length, run: () => app.annotate() },
    { id: 'sch.sheetOptions', context: 'sch', label: 'Sheet options', menuLabel: '&Sheet options', icon: 'settings', run: () => { ed().setSelection([]); app.showPanel('properties', true); } },
    { id: 'sch.clearHighlight', context: 'sch', label: 'Clear net highlight', menuLabel: '&Clear highlight', shortcut: 'Shift+C', run: () => ed().clearHighlight() },

    // ---- Board ----
    { id: 'pcb.place.component', context: 'pcb', label: 'Place component', menuLabel: '&Component...', icon: 'component', run: () => app.showPanel('components', true, true) },
    { id: 'pcb.route', context: 'pcb', label: 'Interactive routing', menuLabel: '&Interactive routing', icon: 'route', shortcut: 'Shift+W', run: () => ed().startTool('route') },
    { id: 'pcb.place.via', context: 'pcb', label: 'Place via', menuLabel: '&Via', icon: 'via', run: () => ed().startTool('via') },
    { id: 'pcb.place.pad', context: 'pcb', label: 'Place pad', menuLabel: 'P&ad', icon: 'pad', run: () => ed().startTool('pad') },
    { id: 'pcb.place.pour', context: 'pcb', label: 'Place polygon pour', menuLabel: 'Polygon &pour', icon: 'pour', run: () => ed().startTool('pour') },
    { id: 'pcb.place.fill', context: 'pcb', label: 'Place fill', menuLabel: '&Fill', icon: 'fill', run: () => ed().startTool('fill') },
    { id: 'pcb.place.region', context: 'pcb', label: 'Place solid region', menuLabel: 'Solid &region', icon: 'region', run: () => ed().startTool('region') },
    { id: 'pcb.place.keepout', context: 'pcb', label: 'Place keep-out region', menuLabel: '&Keep-out region', icon: 'keepout', run: () => ed().startTool('keepout') },
    { id: 'pcb.place.line', context: 'pcb', label: 'Draw line on current layer', menuLabel: '&Line', icon: 'line-tool', run: () => ed().startTool('line') },
    { id: 'pcb.place.text', context: 'pcb', label: 'Place text', menuLabel: '&Text', icon: 'text', run: () => ed().startTool('text') },
    { id: 'pcb.place.dimension', context: 'pcb', label: 'Place dimension', menuLabel: '&Dimension', icon: 'dimension', run: () => ed().startTool('dim') },
    { id: 'pcb.measure', context: 'pcb', label: 'Measure distance', menuLabel: '&Measure distance', icon: 'measure', shortcut: 'Mod+M', run: () => ed().startTool('measure') },
    { id: 'pcb.rotate', context: 'pcb', label: 'Rotate selection', menuLabel: '&Rotate 90 degrees', icon: 'rotate-ccw', shortcut: 'Space', enabled: hasSel, run: () => ed().rotateSelection(90) },
    { id: 'pcb.rotateCw', context: 'pcb', label: 'Rotate selection clockwise', shortcut: 'Shift+Space', enabled: hasSel, run: () => ed().rotateSelection(270) },
    { id: 'pcb.flip', context: 'pcb', label: 'Flip to other side', menuLabel: '&Flip to other side', icon: 'flip', shortcut: 'L', enabled: () => ed()?.selectedObjects?.().some((o) => o.t === 'comp'), run: () => ed().flipSelection() },
    { id: 'pcb.nextLayer', context: 'pcb', label: 'Next layer', menuLabel: '&Next layer', icon: 'layer-up', shortcut: ['+', 'Num+'], run: () => ed().stepLayer(1) },
    { id: 'pcb.prevLayer', context: 'pcb', label: 'Previous layer', menuLabel: '&Previous layer', shortcut: ['-', 'Num-'], run: () => ed().stepLayer(-1) },
    { id: 'pcb.nextCopper', context: 'pcb', label: 'Next copper layer', shortcut: ['*', 'Num*'], run: () => ed().stepLayer(1, true) },
    { id: 'pcb.singleLayer', context: 'pcb', label: 'Single layer mode', menuLabel: 'Single &layer mode', icon: 'single-layer', shortcut: 'Shift+S', run: () => ed().cycleSingleLayer() },
    { id: 'pcb.view2d', context: 'pcb', label: '2D view', menuLabel: '&2D view', icon: 'view-2d', shortcut: '2', run: () => app.set3d(false) },
    { id: 'pcb.toggle3d', context: 'pcb', label: '3D view', menuLabel: '&3D view', icon: 'cube', shortcut: '3', checked: () => !!app.view3dOpen, run: () => app.set3d(!app.view3dOpen) },
    { id: 'pcb.fitBoard', context: 'pcb', label: 'Fit board', menuLabel: 'Fit &board', run: () => ed().fitBoard() },
    { id: 'pcb.clearHighlight', context: 'pcb', label: 'Clear net highlight', menuLabel: '&Clear highlight', shortcut: 'Shift+C', run: () => ed().clearHighlight() },
    { id: 'pcb.drc', context: 'pcb', label: 'Design rule check', menuLabel: '&Design rule check', icon: 'drc', run: () => app.runDrc() },
    { id: 'pcb.repour', context: 'pcb', label: 'Repour all polygons', menuLabel: '&Repour polygons', icon: 'pour', run: () => ed().repour() },
    { id: 'pcb.rules', context: 'pcb', label: 'Design rules', menuLabel: '&Rules...', icon: 'ruler', run: () => app.editRules() },
    { id: 'pcb.layerStack', context: 'pcb', label: 'Layer stack', menuLabel: 'Layer &stack...', icon: 'layers', run: () => app.editLayerStack() },
    { id: 'pcb.boardSize', context: 'pcb', label: 'Set board size', menuLabel: 'Set &rectangular size...', icon: 'board', run: () => app.boardSize() },
    { id: 'pcb.redefineBoard', context: 'pcb', label: 'Redraw board shape', menuLabel: '&Draw board shape', run: () => ed().startTool('board') },
    { id: 'pcb.addCutout', context: 'pcb', label: 'Add board cutout', menuLabel: 'Add &cutout', run: () => ed().startTool('cutout') },
    { id: 'pcb.setOrigin', context: 'pcb', label: 'Set origin', menuLabel: 'Set &origin at cursor', run: () => app.setOriginAtCursor() },
    { id: 'pcb.boardOptions', context: 'pcb', label: 'Board options', menuLabel: '&Board options', icon: 'settings', run: () => { ed().setSelection([]); app.showPanel('properties', true); } },
    { id: 'pcb.setCopper', context: 'pcb', label: 'Set copper layer count', visible: () => false, run: (n) => app.setCopperLayers(n) },
    { id: 'pcb.autorouteAll', context: 'pcb', label: 'Autoroute all nets', menuLabel: 'Auto&route all', icon: 'autoroute', run: () => app.autoroute() },
    { id: 'pcb.autorouteNet', context: 'pcb', label: 'Autoroute highlighted net', menuLabel: 'Autoroute &net', enabled: () => !!ed()?.highlight, run: () => app.autoroute([ed().highlight.net]) },
    { id: 'pcb.unrouteAll', context: 'pcb', label: 'Remove all tracks and vias', menuLabel: '&Unroute all', run: () => app.unroute(null) },
    { id: 'pcb.unrouteNet', context: 'pcb', label: 'Unroute highlighted net', menuLabel: 'Unroute &highlighted net', enabled: () => !!ed()?.highlight, run: () => app.unroute(ed().highlight.net) },
    { id: 'pcb.routingMode', context: 'pcb', label: 'Stop routing at obstacles', menuLabel: '&Stop at obstacles', shortcut: 'Shift+R', checked: () => app.settings.get('routingMode') === 'stop', run: () => app.settings.set('routingMode', app.settings.get('routingMode') === 'stop' ? 'ignore' : 'stop') },
    { id: 'report.boardInfo', label: 'Board information', menuLabel: 'Board &information', icon: 'info', enabled: () => !!app.project?.boards.length, run: () => app.boardInfo() },

    // ---- Window and help ----
    { id: 'window.nextTab', label: 'Next document', menuLabel: '&Next document', shortcut: 'Alt+PageDown', anywhere: true, run: () => app.cycleTab(1) },
    { id: 'window.prevTab', label: 'Previous document', shortcut: 'Alt+PageUp', anywhere: true, run: () => app.cycleTab(-1) },
    { id: 'window.closeTab', label: 'Close document', menuLabel: '&Close document', shortcut: 'Alt+W', anywhere: true, enabled: () => !!app.activeDocId, run: () => app.closeTab(app.activeDocId) },
    { id: 'window.closeAll', label: 'Close all documents', menuLabel: 'Close &all documents', run: () => app.closeAllTabs() },
    { id: 'window.resetLayout', label: 'Reset panel layout', menuLabel: '&Reset layout', run: () => app.resetLayout() },
    { id: 'help.gettingStarted', label: 'Getting started', menuLabel: '&Getting started', icon: 'help', run: () => app.gettingStarted() },
    { id: 'help.shortcuts', label: 'Keyboard shortcuts', menuLabel: '&Keyboard shortcuts', icon: 'keyboard', shortcut: ['?', 'F1'], anywhere: true, run: () => app.showShortcuts() },
    { id: 'help.commands', label: 'Search commands', menuLabel: '&Search commands...', icon: 'command', shortcut: ['Mod+K', 'Mod+Shift+P'], anywhere: true, run: () => app.commandPalette() },
    { id: 'help.github', label: 'Source code on GitHub', menuLabel: 'Source code on &GitHub', icon: 'github', run: () => window.open('https://github.com/heyputer/everything', '_blank', 'noopener,noreferrer') },
    { id: 'help.about', label: 'About Circuits', menuLabel: '&About Circuits', icon: 'info', run: () => app.about() },
  ]);

  function setTheme(t) { app.settings.set('theme', t); applyTheme(t); }

  function cycleGrid(dir) {
    const e = ed();
    if (!e) return;
    if (e.kind === 'sch' || e.mode === 'symbol') {
      const list = SCH_GRID_PRESETS, cur = app.settings.get('schGrid');
      const next = list[(list.indexOf(cur) + dir + list.length) % list.length] || mil(100);
      app.settings.set('schGrid', next);
      app.toast(`Grid ${formatLength(next, 'mil')}`, { timeout: 1200 });
    } else {
      const u = app.settings.get('units');
      const list = GRID_PRESETS[u];
      const cur = app.settings.get('pcbGrid');
      let i = list.indexOf(cur);
      if (i < 0) i = list.findIndex((g) => g > cur) - 1;
      const next = list[(i + dir + list.length) % list.length];
      app.settings.set('pcbGrid', next);
      app.toast(`Grid ${formatLength(next, u)}`, { timeout: 1200 });
    }
    e.requestRender(true);
    app.updateStatus();
  }

  async function setGrid() {
    const e = ed();
    const schLike = e.kind === 'sch' || e.mode === 'symbol';
    const u = schLike ? 'mil' : app.settings.get('units');
    const key = schLike ? 'schGrid' : 'pcbGrid';
    const v = await promptDialog({ title: 'Snap grid', label: `Grid (${u})`, value: formatLength(app.settings.get(key), u, { suffix: false }), validate: (s) => { const n = parseLength(s, u); return n > 0 ? null : 'Enter a positive size'; } });
    if (v) { app.settings.set(key, parseLength(v, u)); e.requestRender(true); app.updateStatus(); }
  }

  function boundsOf(o) { return ed().kind === 'sch' ? schBounds(o, ed().lib) : pcbBounds(o, ed().lib); }
  function moveBy(o, dx, dy) { return ed().kind === 'sch' ? translateSch(o, dx, dy) : translatePcb(o, dx, dy); }

  function align(side) {
    const e = ed();
    const objs = e.selectedObjects();
    const boxes = objs.map(boundsOf);
    const all = boxes.reduce(bboxUnion, bboxEmpty());
    e.doc.store.transact('Align', (s) => {
      objs.forEach((o, i) => {
        const b = boxes[i];
        const dx = side === 'left' ? all.minX - b.minX : side === 'right' ? all.maxX - b.maxX : 0;
        const dy = side === 'bottom' ? all.minY - b.minY : side === 'top' ? all.maxY - b.maxY : 0;
        const g = e.grid || 1;
        if (dx || dy) s.update(o.id, moveBy(o, Math.round(dx / g) * g, Math.round(dy / g) * g));
      });
    });
  }

  function distribute(axis) {
    const e = ed();
    const objs = e.selectedObjects().map((o) => ({ o, b: boundsOf(o) }));
    const key = axis === 'x' ? 'minX' : 'minY';
    objs.sort((a, b) => a.b[key] - b.b[key]);
    const first = objs[0].b[key], last = objs[objs.length - 1].b[key];
    const step = (last - first) / (objs.length - 1);
    const g = e.grid || 1;
    e.doc.store.transact('Distribute', (s) => {
      objs.forEach(({ o, b }, i) => {
        const target = Math.round((first + step * i) / g) * g;
        const d = target - b[key];
        if (d) s.update(o.id, moveBy(o, axis === 'x' ? d : 0, axis === 'y' ? d : 0));
      });
    });
  }
}
