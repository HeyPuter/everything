/**
 * Command registry: every command by name and alias.
 */
import * as draw from './draw.js';
import * as modify from './modify.js';
import * as annotate from './annotate.js';
import * as misc from './misc.js';

/** Commands implemented by the application shell (files, panels, dialogs). */
const app = (name, label, icon, method, aliases = [], extra = {}) => ({
  name,
  label,
  icon,
  aliases,
  noRepeat: true,
  immediate: true,
  ...extra,
  run: (ed, args) => ed.app[method](args ?? extra.args),
});

const APP_COMMANDS = [
  app('NEW', 'New drawing', 'file-plus', 'newDrawing', ['QNEW'], { needsDoc: false }),
  app('OPEN', 'Open', 'folder-open', 'open', [], { needsDoc: false }),
  app('SAVE', 'Save', 'save', 'save', ['QSAVE']),
  app('SAVEAS', 'Save as', 'save-all', 'saveAs'),
  app('EXPORT', 'Export', 'download', 'exportDialog', ['EXP']),
  app('DXFOUT', 'Export DXF', 'download', 'exportDxf'),
  app('DWGOUT', 'Export DWG', 'download', 'exportDwg'),
  app('IMPORT', 'Import DXF or DWG', 'upload', 'importFile', ['DXFIN', 'DWGIN'], { needsDoc: false }),
  app('PLOT', 'Plot', 'printer', 'plotDialog', ['PRINT']),
  app('CLOSE', 'Close drawing', 'x', 'closeDrawing'),
  app('LAYER', 'Layer properties', 'layer-props', 'toggleLayers', ['LA', 'LAYERS']),
  app('PROPERTIES', 'Properties', 'sliders', 'toggleProperties', ['PR', 'PROPS', 'CH']),
  app('UNITS', 'Drawing units', 'units', 'unitsDialog', ['UN']),
  app('OPTIONS', 'Settings', 'settings', 'settingsDialog', ['OP', 'SETTINGS'], { needsDoc: false }),
  app('DSETTINGS', 'Drafting settings', 'osnap', 'draftingDialog', ['DS', 'OSNAP', 'SE']),
  app('STYLE', 'Text styles', 'text-style', 'textStylesDialog', ['ST']),
  app('DIMSTYLE', 'Dimension styles', 'dim-style', 'dimStylesDialog', ['D', 'DST']),
  app('LINETYPE', 'Linetypes', 'lineweight', 'linetypesDialog', ['LT', 'LTYPE']),
  app('LTSCALE', 'Linetype scale', 'lineweight', 'ltscalePrompt', ['LTS'], { immediate: false }),
  app('PURGE', 'Purge unused', 'trash', 'purge', ['PU']),
  app('HELP', 'Help', 'help', 'help', ['?'], { needsDoc: false }),
  app('SHORTCUTS', 'Keyboard shortcuts', 'keyboard', 'shortcuts', [], { needsDoc: false }),
  app('QSELECT', 'Quick select', 'quick-select', 'quickSelect'),
  app('BLOCKS', 'Blocks palette', 'block-insert', 'toggleBlocks', ['BLOCKSPALETTE']),
  app('CLEANSCREEN', 'Clean screen', 'clean-screen', 'toggleCleanScreen', ['CLEANSCREENON']),
  app('GRID', 'Grid display', 'grid', 'toggleSetting', [], { args: 'grid' }),
];

/** Build the name/alias -> command map. */
export function buildRegistry() {
  const map = new Map();
  const all = [...Object.values(draw), ...Object.values(modify), ...Object.values(annotate), ...Object.values(misc), ...APP_COMMANDS].filter(
    (c) => c && typeof c === 'object' && c.name && typeof c.run === 'function',
  );
  for (const c of all) {
    map.set(c.name, c);
    for (const a of c.aliases || []) if (!map.has(a)) map.set(a, c);
  }
  return map;
}

/** Unique command list (for search and autocomplete). */
export function commandList(map) {
  return [...new Set(map.values())];
}
