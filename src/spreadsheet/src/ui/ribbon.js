/** Ribbon groups over the editor's existing command and menu model.
 * No workbook, IO, storage or integration logic lives in this component.
 */
import { el, fieldId, isComposing, MOD_KEY } from './dom.js';
import { icon } from './icons.js';
import { openMenu, ariaKeyShortcuts, lazySubmenu } from './menu.js';
import { menubarMenus, menuLeaves, toMenuItems, SPECIAL_KINDS } from './menubar.js';
import { createToolbar } from './toolbar.js';
import { TABLE_STYLES } from '../core/tables.js';
import { FUNCTION_NAMES } from '../core/formula/functions.js';
import { functionCategories, MORE_CATEGORIES } from '../core/formula/categories.js';
import { recentFunctionNames } from './recent-functions.js';
import { effectivePrintSettings } from './print.js';
import { drawRibbonGroups } from './ink.js';
import { equationGalleryItems } from './equation.js';
import { queryForTable } from '../core/queries.js';
import { pasteGalleryItems } from './pastespecialdialog.js';
import { chartInsertGroup, chartDesignGroups, chartFormatGroups } from './chart-ribbon.js';
import { pictureFormatGroups, activePicture } from './picture-ribbon.js';
import { activeChart } from './chart-actions.js';
import { GROUP_BLOCKED_COMMANDS, groupBlockedHint } from '../core/sheet-group.js';
import { arrangeGroup } from './arrange-ribbon.js';
import { activeSmartArt, smartArtDesignGroups, smartArtFormatGroups } from './smartart.js';
import { ribbonLayoutStore, parseCommandId } from '../lib/customize.js';
import { tabsIn, builtinTabLabel, builtinTabSourceLabel } from '../core/ribbon-layout.js';
import { commandCatalog } from './command-catalog.js';
import { ribbonButtonMenuItems } from './quick-access.js';
import { t, tSource } from '../i18n/index.js';

/**
 * A label in the interface language with its English beside it. A descriptor's `keytip` is the English of its
 * accessible name: key tips are worked out from it (see keytips.js), so they are the same letters in every
 * language, as Excel's are. `values` may hold labels of their own, given in English for the English.
 */
const phrase = (key, values, sourceValues = values) => ({ text: t(key, values), source: tSource(key, sourceValues) });
const asPhrase = (label) => (typeof label === 'string' ? phrase(label) : label);
/** A descriptor's names from catalog keys (or phrases): `label` shown, `ariaLabel` when the name differs, and `keytip`. */
const naming = (label, aria) => {
  const l = asPhrase(label), a = aria ? asPhrase(aria) : null;
  return { label: l.text, ...(a ? { ariaLabel: a.text } : {}), keytip: (a || l).source };
};

/** The menus' commands, flattened once for each set of menus however many buttons look in them. */
const leavesOf = new WeakMap();
const command = (cmd, arg) => menus => {
  let items = leavesOf.get(menus);
  if (!items) leavesOf.set(menus, items = menus.flatMap(m => menuLeaves(m.items)));
  return items.find(it => it.cmd === cmd && (arg === undefined || JSON.stringify(it.arg) === JSON.stringify(arg)));
};
/**
 * A submenu of one of the menus, found by a command among its own items (the menus' labels are in the
 * interface language, so they cannot name it): Insert ▸ Image is the submenu that runs insertImage.
 */
const submenu = (menu, cmd) => menus => {
  const find = items => {
    for (const item of items) {
      if (item.submenu && item.submenu.some(child => child?.cmd === cmd)) return item;
      const nested = item.submenu && find(item.submenu);
      if (nested) return nested;
    }
  };
  return find(menus.find(m => m.id === menu)?.items || []);
};
/** The commands whose ribbon buttons are named apart from their labels. */
const COMMAND_LABELS = { link: 'ribbon.insertLinkName', insertChart: 'ribbon.insertChartName', functionMenu: 'ribbon.insertFunctionName' };
const c = (label, glyph, cmd, arg) => ({ ...naming(label, COMMAND_LABELS[cmd]), glyph, resolve: command(cmd, arg) });
const m = (label, glyph, menu, inside) => ({ ...naming(label), glyph, resolve: submenu(menu, inside) });
const combined = (label, glyph, ...resolve) => { const n = naming(label); return { ...n, glyph, resolve: menus => ({ label: n.label, submenu: resolve.map(fn => fn(menus)).filter(Boolean) }) }; };
const unsupported = (label, glyph, reason) => ({ ...naming(label), glyph, unsupported: true, reason });
/** A command with an argument chosen here; it is available whenever the menus offer the command itself. */
const a = (label, glyph, cmd, arg, { ariaLabel, ...extra } = {}) => {
  const n = naming(label, ariaLabel);
  return { ...n, glyph, ...extra, resolve: menus => {
    const item = command(cmd)(menus);
    return item && { ...item, label: n.label, arg, checked: undefined, shortcut: extra.shortcut };
  } };
};
/** A menu built when it opens (and on every refresh) from the workbook and editor state. */
const dyn = (label, glyph, build, { ariaLabel, ...extra } = {}) => {
  const n = naming(label, ariaLabel);
  return { ...n, glyph, ...extra, resolve: (menus, ctx) => lazySubmenu({ label: n.label }, () => build(menus, ctx)) };
};
/** A command that is not in the menus: available unless a cell is being edited. */
const direct = (label, glyph, cmd, arg, { ariaLabel, ...extra } = {}) => {
  const n = naming(label, ariaLabel);
  return { ...n, glyph, ...extra,
    resolve: (menus, ctx) => {
      const f = ctx?.flags?.() || {};
      // Grouped sheets: a command for one sheet's objects waits, as the menus' does.
      const grouped = !!f.grouped && GROUP_BLOCKED_COMMANDS.has(cmd);
      return { label: n.label, cmd, arg, disabled: !!f.editing || grouped, hint: grouped ? groupBlockedHint() : undefined, checked: extra.isChecked?.(ctx) };
    } };
};
const large = descriptor => ({ ...descriptor, large: true });
/** A threaded-comment command (see ui/comments.js): greyed while a cell is edited, or without the thread `needs` names. */
const threadCmd = (label, glyph, cmd, { needs = null, toggle = false, ariaLabel, ...extra } = {}) => {
  const n = naming(label, ariaLabel);
  return { ...n, glyph, ...extra,
    resolve: (menus, ctx) => {
      const f = ctx?.flags?.() || {};
      // Grouped sheets: a comment belongs to one sheet's cell, so adding or deleting one waits, as the menus' does.
      const grouped = !!f.grouped && GROUP_BLOCKED_COMMANDS.has(cmd);
      return { label: n.label, cmd, disabled: !toggle && (!!f.editing || !!f.chartSheet || grouped || (needs ? !f[needs] : false)), hint: grouped ? groupBlockedHint() : undefined, checked: toggle ? !!f.commentsPane : undefined, shortcut: extra.shortcut };
    } };
};
const NEW_COMMENT_KEY = `${MOD_KEY}+Shift+F2`;
/** Commands that open a menu of their own, anchored on the button that ran them; those buttons announce the menu. */
export const MENU_COMMANDS = new Set(['functionMenu', 'cellStylesMenu', 'shapesMenu', 'formatAsTableMenu', 'themesMenu', 'themeColorsMenu', 'themeFontsMenu', 'themeEffectsMenu', 'wordArtMenu']);
/** A split button: the face runs the command, the arrow beside it opens related choices. */
const split = (descriptor, menu) => ({ ...descriptor, split: menu });

const fnItem = name => ({ label: name, cmd: 'functionArgs', arg: name });
const fnList = names => [...names.map(fnItem), { separator: true }, { label: t('ribbon.insertFunctionDialog'), icon: 'fx', cmd: 'insertFunctionDialog' }];
/** A Function Library category: `id` is the category's own (English) name, which functionCategories keys them by. */
const category = (id, label, ariaLabel, glyph) => dyn(label, glyph, () => fnList(functionCategories().get(id) || []), { ariaLabel });
/** The names More Functions shows for the categories it lists, by their ids. */
const MORE_CATEGORY_LABELS = {
  Statistical: 'ribbon.category.statistical', Engineering: 'ribbon.category.engineering', Information: 'ribbon.category.information',
  Cube: 'ribbon.category.cube', Compatibility: 'ribbon.category.compatibility', Web: 'ribbon.category.web', Database: 'ribbon.category.database',
  Additional: 'ribbon.category.additional',
};
const moreFunctions = () => dyn('ribbon.moreFunctions', 'moreFunctions', () => MORE_CATEGORIES.map(name => ({ label: MORE_CATEGORY_LABELS[name] ? t(MORE_CATEGORY_LABELS[name]) : name, submenu: functionCategories().get(name).map(fnItem) }))
  .filter(item => item.submenu.length));
const recentFunctions = () => dyn('ribbon.recentlyUsed', 'history', () => fnList(recentFunctionNames().filter(n => FUNCTION_NAMES.includes(n))));
const autoSumMenu = () => [
  { label: t('ribbon.autoSumMenu.sum'), icon: 'sigma', cmd: 'autosum' },
  { label: t('ribbon.autoSumMenu.average'), cmd: 'insertFunction', arg: 'AVERAGE' },
  { label: t('ribbon.autoSumMenu.countNumbers'), cmd: 'insertFunction', arg: 'COUNT' },
  { label: t('ribbon.autoSumMenu.max'), cmd: 'insertFunction', arg: 'MAX' },
  { label: t('ribbon.autoSumMenu.min'), cmd: 'insertFunction', arg: 'MIN' },
  { separator: true },
  { label: t('ribbon.autoSumMenu.moreFunctions'), icon: 'fx', cmd: 'insertFunctionDialog' },
];
/** Names a formula can use here: workbook names and this sheet's own, then tables. */
const useInFormula = () => dyn('ribbon.useInFormula', 'tag', (menus, ctx) => {
  // Mid-entry, the entry's own sheet: another may be showing to pick references on.
  const sheet = ctx.wb.sheet(ctx.grid?.editState?.sheetId ?? ctx.sheetId())?.name;
  const names = (ctx.wb.names || []).filter(n => !n.hidden && (!n.sheet || n.sheet === sheet)).map(n => n.name);
  const tables = (ctx.wb.sheets || []).flatMap(sh => sh.tables || []).map(table => table.name).filter(Boolean);
  const items = [...new Set([...names, ...tables])].slice(0, 200).map(name => ({ label: name, cmd: 'useName', arg: name }));
  return items.length ? items : [{ label: t('ribbon.noNamesDefined'), disabled: true }];
});
/** The settings in force: a sheet without its own page setup shows the one it prints with (see effectivePrintSettings). */
const effectiveSettings = ctx => effectivePrintSettings(ctx.wb.sheet(ctx.sheetId()));
const printSettingsOf = effectiveSettings;
const pageSetupItem = (label, patch, isChecked, extra = {}) => (menus, ctx) => ({ label, cmd: 'pageSetup', arg: patch, radio: true, checked: !!isChecked(effectiveSettings(ctx)), ...extra });
const MARGIN_PRESETS = [
  ['ribbon.marginPreset.normal', { top: 0.75, bottom: 0.75, left: 0.7, right: 0.7, header: 0.3, footer: 0.3 }, 'ribbon.marginPreset.normalDetail'],
  ['ribbon.marginPreset.wide', { top: 1, bottom: 1, left: 1, right: 1, header: 0.5, footer: 0.5 }, 'ribbon.marginPreset.wideDetail'],
  ['ribbon.marginPreset.narrow', { top: 0.75, bottom: 0.75, left: 0.25, right: 0.25, header: 0.3, footer: 0.3 }, 'ribbon.marginPreset.narrowDetail'],
];
/** Paper sizes: [catalog key of the name, or the name itself where every language says it so (A4), code, size]. */
const PAPER_PRESETS = [['ribbon.paper.letter', 1, '8.5″ × 11″'], ['ribbon.paper.legal', 5, '8.5″ × 14″'], ['ribbon.paper.tabloid', 3, '11″ × 17″'], ['A4', 9, '210 × 297 mm'], ['A3', 8, '297 × 420 mm']];
const paperName = name => (name.startsWith('ribbon.') ? t(name) : name);
const sameMargins = (p, preset) => !!p.margins && Object.entries(preset).every(([k, v]) => Math.abs((p.margins[k] ?? -1) - v) < 1e-6);
const pageMenu = (label, glyph, build, extra) => dyn(label, glyph, (menus, ctx) => build(ctx).map(fn => typeof fn === 'function' ? fn(menus, ctx) : fn)
  .map(item => (ctx.flags?.()?.editing && item.cmd ? { ...item, disabled: true } : item)), extra);
/** Width or height in pages; 0 is Automatic, and both Automatic is no fitting at all. */
const fitChoices = (key, label) => pageMenu(label, key === 'fitWidth' ? 'fitWidth' : 'fitHeight', ctx => {
  const p = printSettingsOf(ctx) || {}, other = key === 'fitWidth' ? 'fitHeight' : 'fitWidth';
  const pages = p.fitToPage ? p[key] ?? 1 : 0, otherPages = p.fitToPage ? p[other] ?? 1 : 0;
  const choice = n => ({ label: n ? t('ribbon.fitPages', { n }) : t('common.automatic'), cmd: 'pageSetup', radio: true, checked: pages === n,
    arg: n || otherPages ? { fitToPage: true, [key]: n, [other]: otherPages } : { fitToPage: false } });
  return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(choice);
});
const scaleChoices = () => pageMenu('ribbon.scale', 'scaling', ctx => {
  const p = printSettingsOf(ctx) || {};
  return [400, 200, 150, 125, 100, 90, 85, 75, 50, 25, 10].map(n => ({ label: `${n}%`, cmd: 'pageSetup', arg: { fitToPage: false, scale: n }, radio: true,
    checked: !p.fitToPage && (p.scale ?? 100) === n }));
});
const printOption = (label, key, glyph) => {
  const n = naming(label);
  return { ...n, glyph, resolve: (menus, ctx) => {
    const on = !!printSettingsOf(ctx)?.[key];
    return { label: n.label, cmd: 'pageSetup', arg: { [key]: !on }, disabled: !!ctx?.flags?.()?.editing, checked: on };
  } };
};
const disabledItem = (label, reason) => ({ label, hint: reason, disabled: true });
/** A View ▸ Sheet View button; `unavailable(flags)` greys it (Keep needs a temporary view, Exit any view). */
const sheetViewButton = (label, ariaLabel, glyph, action, unavailable) => {
  const n = naming(label, ariaLabel);
  return { ...n, glyph,
    resolve: (menus, ctx) => {
      const f = ctx?.flags?.() || {};
      return { label: n.label, cmd: 'sheetView', arg: action, disabled: !!f.editing || !!f.chartSheet || unavailable(f) };
    } };
};

/** Home ▸ Cells ▸ Format: cell size, visibility, sheet organization and protection, then Format Cells. */
const formatMenu = () => dyn('ribbon.format', 'formatCells', menus => {
  const pick = (label, cmd, arg) => { const item = command(cmd, arg)(menus); return item && { ...item, label }; };
  const hide = submenu('view', 'hide')(menus);
  return [
    { header: t('ribbon.formatMenu.cellSize') },
    pick(t('ribbon.formatMenu.rowHeight'), 'resizeRows'), pick(t('ribbon.formatMenu.autoFitRowHeight'), 'fitRows'), pick(t('ribbon.formatMenu.columnWidth'), 'resizeCols'), pick(t('ribbon.formatMenu.autoFitColumnWidth'), 'autofit'),
    { header: t('ribbon.formatMenu.visibility') },
    hide && { ...hide, label: t('ribbon.hideUnhide') },
    { header: t('ribbon.formatMenu.organizeSheets') },
    pick(t('ribbon.formatMenu.renameSheet'), 'renameSheet'), pick(t('ribbon.formatMenu.moveOrCopySheet'), 'moveOrCopySheet'), pick(t('ribbon.formatMenu.tabColor'), 'sheetColor'),
    { header: t('ribbon.formatMenu.protection') },
    command('protectSheet')(menus), pick(t('ribbon.formatMenu.formatCells'), 'formatCells'),
  ].filter(Boolean);
}, { ariaLabel: 'ribbon.format' });
/** Home ▸ Cells ▸ Insert and Delete; each entry is the menus' own command, so availability follows them. */
const cellsMenu = (label, glyph, entries) => dyn(label, glyph, (menus, ctx) => entries().map(([text, cmd, arg, icon]) => {
  if (!cmd) return { separator: true };
  if (typeof cmd === 'function') return cmd(menus, ctx);
  const item = command(cmd, arg)(menus);
  return item && { ...item, label: text, icon };
}).filter(Boolean), { ariaLabel: label });
const dialogItem = (label, cmd) => (menus, ctx) => ({ label, icon: cmd === 'insertDialog' ? 'insertCells' : 'deleteCells', cmd, disabled: !!ctx?.flags?.()?.editing });
const insertMenu = () => cellsMenu('common.insert', 'insertCells', () => [
  [t('ribbon.cells.insertCells'), dialogItem(t('ribbon.cells.insertCells'), 'insertDialog')],
  [t('ribbon.cells.insertCopiedCells'), (menus, ctx) => (ctx?.flags?.()?.copiedCells ? { label: t('ribbon.cells.insertCopiedCells'), icon: 'paste', cmd: 'insertCopiedCells', disabled: !!ctx.flags().editing } : null)], [],
  [t('ribbon.cells.insertSheetRows'), 'insertRows', 'above', 'insertRows'], [t('ribbon.cells.insertSheetColumns'), 'insertCols', 'left', 'insertCols'], [],
  [t('ribbon.cells.insertSheet'), 'newSheet', undefined, 'insertSheet'],
]);
const deleteMenu = () => cellsMenu('common.delete', 'deleteCells', () => [
  [t('ribbon.cells.deleteCells'), dialogItem(t('ribbon.cells.deleteCells'), 'deleteDialog')], [],
  [t('ribbon.cells.deleteSheetRows'), 'deleteRows', undefined, 'deleteRows'], [t('ribbon.cells.deleteSheetColumns'), 'deleteCols', undefined, 'deleteCols'], [],
  [t('ribbon.cells.deleteSheet'), 'deleteSheet', undefined, 'deleteSheet'],
]);
/** Home ▸ Editing ▸ Clear; Clear Formats stays live mid-entry, as the Format menu's is. */
const clearMenu = () => dyn('common.clear', 'eraser', (menus, ctx) => {
  const editing = !!ctx?.flags?.()?.editing;
  const formats = command('clearFormat')(menus);
  return [
    { label: t('ribbon.clearMenu.clearAll'), icon: 'eraser', cmd: 'clearAll', disabled: editing },
    formats && { ...formats, label: t('ribbon.clearMenu.clearFormats'), icon: 'clearFormat' },
    { label: t('ribbon.clearMenu.clearContents'), cmd: 'clear', shortcut: 'Delete', disabled: editing },
    { label: t('ribbon.clearMenu.clearCommentsAndNotes'), icon: 'deleteNote', cmd: 'clearNotes', disabled: editing },
    { label: t('ribbon.clearMenu.clearHyperlinks'), icon: 'unlink', cmd: 'clearLinks', disabled: editing },
  ].filter(Boolean);
}, { ariaLabel: 'common.clear' });
/** Home ▸ Editing ▸ Find & Select. */
const findAndSelect = () => dyn('ribbon.findAndSelect', 'find', menus => {
  const pick = (label, cmd, arg, extra = {}) => { const item = command(cmd)(menus); return item && { ...item, label, arg, shortcut: extra.shortcut ?? item.shortcut }; };
  const special = kind => command('selectSpecial', kind)(menus);
  return [
    pick(t('ribbon.findMenu.find'), 'find', null), pick(t('ribbon.findMenu.replace'), 'find', 'replace', { shortcut: null }), pick(t('ribbon.findMenu.goTo'), 'goTo', null),
    { label: t('ribbon.findMenu.goToSpecial'), icon: 'check', submenu: Object.keys(SPECIAL_KINDS).map(special).filter(Boolean) },
    { separator: true },
    special('formulas') && { ...special('formulas'), label: t('ribbon.findMenu.formulas') }, special('notes') && { ...special('notes'), label: t('ribbon.findMenu.notes') },
    special('constants') && { ...special('constants'), label: t('ribbon.findMenu.constants') },
  ].filter(Boolean);
});

/** Data ▸ Get Data: the sources by kind, then the Power Query Editor. */
const getDataMenu = () => dyn('ribbon.getData', 'database', (menus, ctx) => {
  const editing = !!ctx?.flags?.()?.editing;
  const item = (label, cmd, glyph) => ({ label, cmd, icon: glyph, disabled: editing });
  return [
    { label: t('ribbon.getDataMenu.fromFile'), icon: 'fromFile', submenu: [item(t('ribbon.getDataMenu.fromWorkbook'), 'getDataWorkbook', 'sheet'), item(t('ribbon.fromTextCsv'), 'getDataText', 'fromText')] },
    { label: t('ribbon.getDataMenu.fromOtherSources'), icon: 'database', submenu: [item(t('ribbon.fromTableRange'), 'getDataTable', 'fromTable'), item(t('ribbon.fromWeb'), 'getDataWeb', 'fromWeb'),
      { separator: true }, item(t('ribbon.getDataMenu.blankQuery'), 'blankQuery', 'blankQuery')] },
    { separator: true },
    item(t('ribbon.getDataMenu.launchPowerQueryEditor'), 'powerQueryEditor', 'powerQuery'),
  ];
}, { ariaLabel: 'ribbon.getData' });
/** Data ▸ Refresh All's arrow: every query and pivot table, or the one behind the table at the selection, or the pivot table on this sheet. */
const refreshMenu = (menus, ctx) => {
  const f = ctx?.flags?.() || {};
  return [
    { label: t('ribbon.refreshAll'), icon: 'refresh', cmd: 'refreshAll', disabled: !!f.editing },
    { label: t('common.refresh'), cmd: 'refreshQuery', disabled: !!f.editing || !((f.table && f.hasQueries) || (!f.table && f.pivotRefreshable)) },
  ];
};

/** The built-in tabs' ids, in English in every language (a layout keeps them); see builtinTabLabel for their names. */
export const RIBBON_TABS = ['Home', 'Insert', 'Draw', 'Page Layout', 'Formulas', 'Data', 'Review', 'View', 'Automate'];

/**
 * The names the built-in groups show, by their English names. A group's English name is its id: the ribbon
 * keeps it as data-group-name, and Options ▸ Customize Ribbon names it by that. A group from elsewhere may give
 * its name and label itself, as { name, label }.
 */
const GROUP_LABELS = {
  Properties: 'ribbon.group.properties', Tools: 'ribbon.group.tools', 'External Table Data': 'ribbon.group.externalTableData',
  'Table Style Options': 'ribbon.group.tableStyleOptions', 'Table Styles': 'ribbon.group.tableStyles', Tables: 'ribbon.group.tables',
  Illustrations: 'ribbon.group.illustrations', Charts: 'ribbon.group.charts', Sparklines: 'ribbon.group.sparklines', Filters: 'ribbon.group.filters',
  Links: 'ribbon.group.links', Comments: 'ribbon.group.comments', Text: 'ribbon.group.text', Cells: 'ribbon.group.cells', Symbols: 'ribbon.group.symbols',
  Sheets: 'ribbon.group.sheets', Themes: 'ribbon.group.themes', 'Page Setup': 'ribbon.group.pageSetup', 'Scale to Fit': 'ribbon.group.scaleToFit',
  'Sheet Options': 'ribbon.group.sheetOptions', Arrange: 'ribbon.group.arrange', 'Function Library': 'ribbon.group.functionLibrary',
  'Defined Names': 'ribbon.group.definedNames', 'Formula Auditing': 'ribbon.group.formulaAuditing', Calculation: 'ribbon.group.calculation',
  'Get & Transform Data': 'ribbon.group.getTransformData', 'Queries & Connections': 'ribbon.group.queriesConnections', 'Sort & Filter': 'ribbon.group.sortFilter',
  'Data Tools': 'ribbon.group.dataTools', Forecast: 'ribbon.group.forecast', Analyze: 'ribbon.group.analyze', Outline: 'ribbon.group.outline',
  Proofing: 'ribbon.group.proofing', Language: 'ribbon.group.language', Accessibility: 'ribbon.group.accessibility', Notes: 'ribbon.group.notes',
  Changes: 'ribbon.group.changes', Protection: 'ribbon.group.protection', Collaboration: 'ribbon.group.collaboration', 'Workbook Views': 'ribbon.group.workbookViews',
  'Sheet View': 'ribbon.group.sheetView', Show: 'ribbon.group.show', Zoom: 'ribbon.group.zoom', Window: 'ribbon.group.window', Assistant: 'ribbon.group.assistant',
  'Scripting Tools': 'ribbon.group.scriptingTools', Controls: 'ribbon.group.controls', 'Sample Scripts': 'ribbon.group.sampleScripts', Help: 'ribbon.group.help',
  // Chart Design, Format and Picture Format (chart-ribbon.js, picture-ribbon.js).
  'Chart Layouts': 'ribbon.group.chartLayouts', 'Chart Styles': 'ribbon.group.chartStyles', Data: 'ribbon.group.data', Type: 'ribbon.group.type',
  Location: 'ribbon.group.location', 'Current Selection': 'ribbon.group.currentSelection', 'Shape Styles': 'ribbon.group.shapeStyles', Size: 'ribbon.group.size',
  Adjust: 'ribbon.group.adjust', 'Picture Styles': 'ribbon.group.pictureStyles',
  // Draw (ink.js) and the SmartArt tabs (smartart.js).
  'Drawing Tools': 'ribbon.group.drawingTools', Touch: 'ribbon.group.touch', Convert: 'ribbon.group.convert', 'Create Graphic': 'ribbon.group.createGraphic',
  Layouts: 'ribbon.group.layouts', 'SmartArt Styles': 'ribbon.group.smartArtStyles', Reset: 'ribbon.group.reset', Shapes: 'ribbon.group.shapes',
};
/** A group's id (its English name) and the name it shows. */
export function groupNaming(group) {
  if (group && typeof group === 'object') return { name: group.name, label: group.label ?? group.name };
  return { name: group, label: Object.hasOwn(GROUP_LABELS, group) ? t(GROUP_LABELS[group]) : group };
}

/** The table styles' names on the Table tab, by their keys (TABLE_STYLES). */
const TABLE_STYLE_LABELS = {
  blue: 'ribbon.tableStyle.blue', gray: 'ribbon.tableStyle.gray', green: 'ribbon.tableStyle.green', orange: 'ribbon.tableStyle.orange',
  purple: 'ribbon.tableStyle.purple', red: 'ribbon.tableStyle.red', light: 'ribbon.tableStyle.light', none: 'ribbon.tableStyle.none',
};
const tableStyleButton = ([key, label, look]) => {
  const own = TABLE_STYLE_LABELS[key];
  const name = own ? t(own) : label;
  return { ...c(phrase('ribbon.tableStyleNamed', { name }, { name: own ? tSource(own) : label }), 'table', 'tableStyle', key), look, shortLabel: name };
};

/** References are resolved again on every refresh AND when a menu is opened. */
const groupsFor = name => ({
  Table: [
    ['Properties', c('ribbon.tableProperties', 'formatTable', 'editTable'), c('ribbon.resizeTable', 'resizeTable', 'tableResize')],
    ['Tools', c('ribbon.summarizeWithPivotTable', 'pivot', 'tableSource', 'pivot'), c('ribbon.removeDuplicates', 'dedupe', 'tableSource', 'dedupe'), c('ribbon.convertToRange', 'convertToRange', 'tableConvert'), c('ribbon.insertSlicer', 'slicer', 'insertSlicer')],
    // Refresh runs the query that loaded the table again; a table holding its own data has nothing to refresh.
    ['External Table Data', { ...naming('common.refresh'), glyph: 'refresh', resolve: (menus, ctx) => {
      const f = ctx?.flags?.() || {};
      const table = f.table, sheetId = ctx?.sheetId?.();
      const loaded = !!table && !!ctx?.wb && queryForTable(ctx.wb, sheetId, table.id);
      return { label: t('common.refresh'), cmd: 'refreshQuery', disabled: !!f.editing || !loaded, hint: loaded ? null : t('ribbon.refreshTableHint') };
    } }],
    ['Table Style Options', c('ribbon.headerRow', 'headerRow', 'tableOption', 'headerRow'), c('ribbon.totalRow', 'subtotal', 'tableTotals'),
      c('ribbon.bandedRows', 'bandedRows', 'tableOption', 'banded'), c('ribbon.firstColumn', 'firstColumn', 'tableOption', 'firstColumn'),
      c('ribbon.lastColumn', 'lastColumn', 'tableOption', 'lastColumn'), c('ribbon.bandedColumns', 'bandedColumns', 'tableOption', 'bandedColumns'), c('ribbon.filterButton', 'filterButton', 'tableOption', 'filterButton')],
    ['Table Styles', ...TABLE_STYLES.map(tableStyleButton)],
  ],
  Insert: [
    ['Tables', large(c('ribbon.pivotTable', 'pivot', 'pivot')), large(direct('ribbon.recommendedPivotTables', 'pivotRecommend', 'recommendedPivots', null)), large(c('ribbon.table', 'table', 'insertTable'))],
    ['Illustrations', large(m('ribbon.pictures', 'pictures', 'insert', 'insertImage')), direct('ribbon.shapes', 'shapes', 'shapesMenu', null), direct('ribbon.icons', 'icons', 'iconsDialog', null),
      { ...naming('ribbon.smartArt', 'ribbon.insertSmartArtName'), glyph: 'smartArt', resolve: (menus, ctx) => {
        const f = ctx?.flags?.() || {};
        return { label: t('ribbon.smartArt'), cmd: 'smartArt', arg: { action: 'insertDialog' }, disabled: !!f.editing || !!f.chartSheet || !!f.grouped };
      } }],
    chartInsertGroup(),
    ['Sparklines', a('ribbon.sparkline.line', 'sparkLine', 'insertSparklines', 'line', { ariaLabel: 'ribbon.sparkline.lineName' }),
      a('ribbon.sparkline.column', 'sparkColumn', 'insertSparklines', 'column', { ariaLabel: 'ribbon.sparkline.columnName' }),
      a('ribbon.sparkline.winLoss', 'sparkWinLoss', 'insertSparklines', 'stacked', { ariaLabel: 'ribbon.sparkline.winLossName' })],
    ['Filters', large(c('ribbon.slicer', 'slicer', 'insertSlicer')), large(c('ribbon.timeline', 'timeline', 'insertTimeline'))],
    ['Links', large(c('ribbon.link', 'link', 'link'))],
    ['Comments', large(c('ribbon.note', 'note', 'note')), large(threadCmd('ribbon.comment', 'comment', 'newComment', { shortcut: NEW_COMMENT_KEY }))],
    ['Text', c('ribbon.textBox', 'textBox', 'insertTextBox'), a('ribbon.headerFooter', 'headerFooter', 'print', null), direct('ribbon.wordArt', 'wordArt', 'wordArtMenu', null)],
    ['Cells', c('ribbon.checkbox', 'checkbox', 'insertCheckbox'), c('ribbon.dropdown', 'dropdown', 'insertDropdown'), c('ribbon.datePicker', 'calendar', 'datePicker')],
    ['Symbols', large(split(direct('ribbon.equation', 'math', 'insertEquation', null), (menus, ctx) => equationGalleryItems(ctx))), large(direct('ribbon.symbol', 'symbol', 'symbolDialog', null))],
    ['Sheets', c('ribbon.newSheet', 'newSheet', 'newSheet')],
  ],
  Draw: drawRibbonGroups(),
  'Chart Design': chartDesignGroups(),
  Format: chartFormatGroups(),
  'Picture Format': pictureFormatGroups(),
  'SmartArt Design': smartArtDesignGroups(),
  'SmartArt Format': smartArtFormatGroups(),
  'Page Layout': [
    ['Themes', large(direct('ribbon.themes', 'palette', 'themesMenu', null)), direct('ribbon.themeColors', 'themeColors', 'themeColorsMenu', null, { ariaLabel: 'ribbon.themeColorsName' }),
      direct('ribbon.themeFonts', 'themeFonts', 'themeFontsMenu', null, { ariaLabel: 'ribbon.themeFontsName' }), direct('ribbon.themeEffects', 'themeEffects', 'themeEffectsMenu', null)],
    ['Page Setup',
      large(pageMenu('ribbon.margins', 'margins', () => [
        ...MARGIN_PRESETS.map(([label, preset, detail]) => pageSetupItem(t(label), { margins: preset }, p => sameMargins(p, preset), { hint: t(detail) })),
        { separator: true }, { label: t('ribbon.customMargins'), cmd: 'print', icon: 'margins' }])),
      large(pageMenu('ribbon.orientation', 'swap', () => [
        pageSetupItem(t('ribbon.portrait'), { orientation: 'portrait' }, p => (p.orientation || 'portrait') === 'portrait'),
        pageSetupItem(t('ribbon.landscape'), { orientation: 'landscape' }, p => p.orientation === 'landscape')])),
      large(pageMenu('ribbon.size', 'fileText', () => [
        ...PAPER_PRESETS.map(([label, code, detail]) => pageSetupItem(paperName(label), { paperSize: code }, p => (p.paperSize ?? 1) === code, { hint: detail })),
        { separator: true }, { label: t('ribbon.morePaperSizes'), cmd: 'print', icon: 'sliders' }])),
      large(pageMenu('ribbon.printArea', 'printArea', () => [
        { label: t('ribbon.setPrintArea'), cmd: 'printArea', arg: 'set' },
        { label: t('ribbon.addToPrintArea'), cmd: 'printArea', arg: 'add' },
        { label: t('ribbon.clearPrintArea'), cmd: 'printArea', arg: 'clear' }])),
      large(pageMenu('ribbon.breaks', 'breaks', ctx => {
        const p = printSettingsOf(ctx) || {};
        const any = !!(p.rowBreaks?.length || p.colBreaks?.length);
        return [
          { label: t('ribbon.insertPageBreak'), icon: 'breaks', cmd: 'pageBreak', arg: 'insert', hint: t('ribbon.insertPageBreakHint') },
          { label: t('ribbon.removePageBreak'), cmd: 'pageBreak', arg: 'remove' },
          { label: t('ribbon.resetAllPageBreaks'), cmd: 'pageBreak', arg: 'reset', disabled: !any },
          { separator: true },
          { label: t('ribbon.pageBreakPreview'), icon: 'pageBreak', cmd: 'viewMode', arg: 'pageBreak' },
        ];
      })),
      large(dyn('ribbon.background', 'background', (menus, ctx) => {
        const has = !!ctx.wb.sheet(ctx.sheetId())?.background, editing = !!ctx.flags?.()?.editing;
        return [
          { label: has ? t('ribbon.replaceBackground') : t('ribbon.backgroundPicture'), icon: 'background', cmd: 'sheetBackground', arg: 'pick', disabled: editing },
          { label: t('ribbon.deleteBackground'), icon: 'deleteItem', cmd: 'sheetBackground', arg: 'delete', disabled: editing || !has },
        ];
      }, { ariaLabel: 'ribbon.backgroundName' })),
      a('ribbon.printTitles', 'printTitles', 'print', null), c('ribbon.pageSetup', 'pageSetup', 'print'), c('ribbon.exportPdf', 'fileDown', 'exportPdf')],
    ['Scale to Fit', fitChoices('fitWidth', 'ribbon.fitWidth'), fitChoices('fitHeight', 'ribbon.fitHeight'), scaleChoices()],
    ['Sheet Options', c('ribbon.gridlines', 'gridlines', 'gridlines'), printOption('ribbon.printGridlines', 'gridlines', 'printGridlines'), c('ribbon.headings', 'headings', 'toggleHeaders'), printOption('ribbon.printHeadings', 'headings', 'printHeadings')],
    arrangeGroup(),
  ],
  Formulas: [
    ['Function Library', large(c('ribbon.insertFunction', 'fx', 'functionMenu')),
      large(split(c('ribbon.autoSum', 'autosum', 'autosum'), () => autoSumMenu())), recentFunctions(),
      category('Financial', 'ribbon.category.financial', 'ribbon.category.financialName', 'financial'), category('Logical', 'ribbon.category.logical', 'ribbon.category.logicalName', 'logical'),
      category('Text', 'ribbon.category.text', 'ribbon.category.textName', 'text'), category('Date & Time', 'ribbon.category.dateTime', 'ribbon.category.dateTimeName', 'dateTime'),
      category('Lookup & Reference', 'ribbon.category.lookupReference', 'ribbon.category.lookupReferenceName', 'lookup'),
      category('Math & Trig', 'ribbon.category.mathTrig', 'ribbon.category.mathTrigName', 'mathTrig'), moreFunctions()],
    ['Defined Names', large(c('ribbon.nameManager', 'nameManager', 'names')), c('ribbon.defineName', 'defineName', 'defineName'), useInFormula(), c('ribbon.createFromSelection', 'createNames', 'createNames')],
    ['Formula Auditing', c('ribbon.tracePrecedents', 'precedents', 'trace', 'precedents'), c('ribbon.traceDependents', 'dependents', 'trace', 'dependents'),
      c('ribbon.removeArrows', 'clearTrace', 'clearTrace'), c('ribbon.showFormulas', 'showFormulas', 'showFormulas'), split(a('ribbon.errorChecking', 'errorCheck', 'selectSpecial', 'errors'), () => [
        { label: t('ribbon.errorCheckingDialog'), icon: 'errorCheck', cmd: 'selectSpecial', arg: 'errors' },
        { label: t('ribbon.traceError'), icon: 'precedents', cmd: 'trace', arg: 'precedents' },
        { separator: true },
        { label: t('ribbon.errorCheckingOptions'), cmd: 'errorCheckingOptions' },
      ]),
      c('ribbon.evaluateFormula', 'evaluate', 'evaluateFormula'), direct('ribbon.watchWindow', 'watch', 'watchWindow', null)],
    ['Calculation', large(dyn('ribbon.calculationOptions', 'calculator', (menus, ctx) => {
      const mode = ctx.wb.calcMode || 'automatic', editing = !!ctx.flags?.()?.editing;
      return [
        { label: t('common.automatic'), cmd: 'calcMode', arg: 'automatic', radio: true, checked: mode === 'automatic', disabled: editing },
        { label: t('ribbon.automaticExceptTables'), cmd: 'calcMode', arg: 'autoNoTable', radio: true, checked: mode === 'autoNoTable', disabled: editing, hint: t('ribbon.automaticExceptTablesHint') },
        { label: t('ribbon.manual'), cmd: 'calcMode', arg: 'manual', radio: true, checked: mode === 'manual', disabled: editing },
      ];
    }, { ariaLabel: 'ribbon.calculationOptions' })),
      c('ribbon.calculateNow', 'calcNow', 'recalc'), a('ribbon.calculateSheet', 'calcSheet', 'recalc', 'sheet', { shortcut: 'Shift+F9' }), c('ribbon.formulasToValues', 'toValues', 'toValues')],
  ],
  Data: [
    ['Get & Transform Data', large(getDataMenu()), direct('ribbon.fromTextCsv', 'fromText', 'getDataText', null), direct('ribbon.fromWeb', 'fromWeb', 'getDataWeb', null),
      direct('ribbon.fromTableRange', 'fromTable', 'getDataTable', null)],
    ['Queries & Connections', large(split(direct('ribbon.refreshAll', 'refresh', 'refreshAll', null), refreshMenu)),
      direct('ribbon.queriesConnections', 'queriesPane', 'queriesPane', null, { isChecked: ctx => !!ctx.flags?.()?.queriesPane }), c('ribbon.editLinks', 'editLinks', 'editLinks')],
    ['Sort & Filter', c('ribbon.sortAToZ', 'sortAsc', 'sort', 'asc'), c('ribbon.sortZToA', 'sortDesc', 'sort', 'desc'), large(c('ribbon.sort', 'sortCustom', 'sortDialog')), large(c('ribbon.filter', 'filter', 'filter')),
      direct('common.clear', 'filterClear', 'clearFilters', null, { ariaLabel: 'ribbon.clearFilterName' }), direct('ribbon.reapply', 'filterReapply', 'reapplyFilters', null), direct('ribbon.advanced', 'filterAdvanced', 'advancedFilter', null, { ariaLabel: 'ribbon.advancedFilterName' })],
    ['Data Tools', c('ribbon.textToColumns', 'textToColumns', 'splitTextDialog'), direct('ribbon.flashFill', 'flashFill', 'flashFill', null, { shortcut: `${MOD_KEY}+E` }), c('ribbon.removeDuplicates', 'dedupe', 'dedupe'),
      split(c('ribbon.dataValidation', 'validation', 'validation'), () => [
        { label: t('ribbon.dataValidationDialog'), icon: 'validation', cmd: 'validation' },
        { label: t('ribbon.circleInvalidData'), icon: 'validation', cmd: 'circleInvalid' },
        { label: t('ribbon.clearValidationCircles'), cmd: 'clearCircles' },
      ]), direct('ribbon.consolidate', 'consolidate', 'consolidate', null), c('ribbon.form', 'dataForm', 'dataForm'), m('ribbon.dataCleanup', 'clearFormat', 'data', 'removeEmptyRows')],
    ['Forecast', large(dyn('ribbon.whatIfAnalysis', 'whatIf', menus => [command('goalSeek')(menus) && { ...command('goalSeek')(menus), label: t('ribbon.goalSeekDialog') },
      command('scenarioManager')(menus) && { ...command('scenarioManager')(menus), label: t('ribbon.scenarioManagerDialog') }, command('dataTable')(menus) && { ...command('dataTable')(menus), label: t('ribbon.dataTableDialog') }].filter(Boolean))),
      c('ribbon.goalSeek', 'goalSeek', 'goalSeek'), large(direct('ribbon.forecastSheet', 'forecast', 'forecastSheet', null)), c('ribbon.columnStats', 'columnStats', 'columnStats')],
    ['Analyze', large(c('ribbon.dataAnalysis', 'dataAnalysis', 'dataAnalysis')), large(c('ribbon.solver', 'solver', 'solver'))],
    ['Outline', m('ribbon.groupCommand', 'group', 'view', 'group'), a('ribbon.ungroupRows', 'ungroup', 'ungroup', 'row'), c('ribbon.subtotal', 'subtotal', 'subtotal'),
      direct('ribbon.showDetail', 'showDetail', 'showDetail', null), direct('ribbon.hideDetail', 'hideDetail', 'hideDetail', null),
      c('ribbon.autoOutline', 'autoOutline', 'autoOutline'), c('ribbon.clearOutline', 'clearOutline', 'clearOutline'), c('ribbon.outlineSettings', 'outlineSettings', 'outlineSettings')],
  ],
  Review: [
    ['Proofing', large(c('ribbon.spelling', 'spellCheck', 'spelling')), c('ribbon.thesaurus', 'thesaurus', 'thesaurus'), c('ribbon.spellingAsYouType', 'spell', 'toggleSpellcheck'),
      c('ribbon.autoCorrectOptions', 'autoCorrect', 'autoCorrectOptions'), a('ribbon.workbookStatistics', 'stats', 'docInfo', null)],
    ['Language', large(c('ribbon.translate', 'translate', 'translatePane'))],
    ['Accessibility', large(direct('ribbon.checkAccessibility', 'accessibility', 'accessibility', null))],
    ['Comments', large(threadCmd('ribbon.newComment', 'comment', 'newComment', { shortcut: NEW_COMMENT_KEY })), threadCmd('common.delete', 'deleteComment', 'deleteComment', { ariaLabel: 'ribbon.deleteCommentName', needs: 'hasComments' }),
      threadCmd('ribbon.previousComment', 'prevComment', 'prevComment', { needs: 'hasComments' }), threadCmd('ribbon.nextComment', 'nextComment', 'nextComment', { needs: 'hasComments' }),
      large(threadCmd('ribbon.showComments', 'showComments', 'toggleComments', { toggle: true }))],
    ['Notes', large(c('ribbon.note', 'note', 'note')), c('ribbon.deleteNote', 'deleteNote', 'deleteNote'), a('ribbon.notesOnThisSheet', 'notes', 'selectSpecial', 'notes', { ariaLabel: 'ribbon.notesOnThisSheetName' })],
    ['Changes', large(direct('ribbon.showChanges', 'showChanges', 'showChanges', null, { isChecked: ctx => !!ctx.flags?.()?.changesPane }))],
    ['Protection', large(c('ribbon.protectSheet', 'protectSheet', 'protectSheet')), direct('ribbon.protectWorkbook', 'protectBook', 'protectWorkbook', null, { isChecked: ctx => !!ctx.wb.structureProtected }), c('ribbon.protectedRanges', 'protectRanges', 'protectRanges')],
    ['Collaboration', c('ribbon.share', 'share', 'share'), c('ribbon.sendCopy', 'sendCopy', 'sendCopy'), c('ribbon.versionHistory', 'versions', 'versions')],
  ],
  View: [
    ['Workbook Views', large(direct('ribbon.normalView', 'normalView', 'viewMode', 'normal', { ariaLabel: 'ribbon.normalViewName', isChecked: ctx => (ctx.viewMode?.() || 'normal') === 'normal' })),
      large(direct('ribbon.pageBreakPreview', 'pageBreak', 'viewMode', 'pageBreak', { isChecked: ctx => ctx.viewMode?.() === 'pageBreak' })),
      large(direct('ribbon.pageLayoutView', 'pageLayout', 'viewMode', 'pageLayout', { ariaLabel: 'ribbon.pageLayoutViewName', isChecked: ctx => ctx.viewMode?.() === 'pageLayout' })),
      large(c('ribbon.customViews', 'customViews', 'customViews'))],
    ['Sheet View', large(dyn('ribbon.sheetView', 'sheetView', (menus, ctx) => {
      const f = ctx.flags?.() || {}, sheet = ctx.wb.sheet(ctx.sheetId()), off = !!f.editing || !!f.chartSheet;
      const views = (sheet?.sheetViews || []).filter((v) => !v.temporary || v.id === f.sheetView?.id);
      return [
        { label: t('common.default'), cmd: 'sheetView', arg: { action: 'switch', id: null }, radio: true, checked: !f.sheetView, disabled: off },
        ...views.map((v) => ({ label: v.name, cmd: 'sheetView', arg: { action: 'switch', id: v.id }, radio: true, checked: f.sheetView?.id === v.id, disabled: off })),
        { separator: true },
        { label: t('ribbon.sheetViewMenu.new'), icon: 'sheetView', cmd: 'sheetView', arg: 'new', disabled: off },
        { label: t('ribbon.sheetViewMenu.keep'), cmd: 'sheetView', arg: 'keep', disabled: off || !f.sheetView?.temporary },
        { label: t('ribbon.sheetViewMenu.exit'), cmd: 'sheetView', arg: 'exit', disabled: off || !f.sheetView },
        { label: t('ribbon.sheetViewMenu.options'), icon: 'sliders', cmd: 'sheetView', arg: 'options', disabled: off },
      ];
    }, { ariaLabel: 'ribbon.sheetView' })),
      sheetViewButton('ribbon.sheetViewNew', 'ribbon.sheetViewNewName', 'filePlus', 'new', () => false),
      sheetViewButton('ribbon.sheetViewKeep', 'ribbon.sheetViewKeepName', 'save', 'keep', f => !f.sheetView || !f.sheetView.temporary),
      sheetViewButton('ribbon.sheetViewExit', 'ribbon.sheetViewExitName', 'exitView', 'exit', f => !f.sheetView),
      sheetViewButton('common.options', 'ribbon.sheetViewOptionsName', 'sliders', 'options', () => false)],
    ['Show', c('ribbon.gridlines', 'gridlines', 'gridlines'), c('ribbon.formulaBar', 'fx', 'formulaBar'), c('ribbon.headings', 'headings', 'toggleHeaders'), c('ribbon.showZeros', 'number', 'zeros'), c('ribbon.showFormulas', 'showFormulas', 'showFormulas'),
      c('ribbon.pageBreaks', 'pageBreak', 'showPageBreaks')],
    ['Zoom', large(c('ribbon.zoom', 'zoomIn', 'zoomCustom')), large(c({ text: '100%', source: '100%' }, 'zoom100', 'zoom', 'reset')), large(direct('ribbon.zoomToSelection', 'zoomSelection', 'zoomSelection', null))],
    ['Window', large(m('ribbon.freezePanes', 'freeze', 'view', 'freeze')), c('ribbon.split', 'split', 'split'),
      m('ribbon.hideUnhide', 'hideEye', 'view', 'hide'), c('ribbon.focusMode', 'focus', 'focusMode'), c('ribbon.fullScreen', 'fullscreen', 'fullscreen')],
    ['Assistant', c('ribbon.aiAssistant', 'sparkle', 'aiPanel')],
  ],
  // Scripts (ui/automate.js): record, write, browse and run them; the samples run in one click, undone in one.
  Automate: [
    ['Scripting Tools', large(direct('ribbon.recordActions', 'recordActions', 'recordActions', null, { isChecked: ctx => !!ctx.flags?.()?.recording })),
      large(direct('ribbon.newScript', 'newScript', 'newScript', null)),
      large(direct('ribbon.allScripts', 'allScripts', 'scriptGallery', null)),
      large(direct('ribbon.codeEditor', 'codeEditor', 'scriptsPane', null, { isChecked: ctx => !!ctx.flags?.()?.scriptsPane })),
      large(dyn('ribbon.runScript', 'runScript', (menus, ctx) => ctx.automate?.menuItems?.() || [], { ariaLabel: 'ribbon.runScriptName' }))],
    ['Controls', large(dyn('ribbon.scriptButton', 'scriptButton', (menus, ctx) => ctx.automate?.buttonItems?.() || [], { ariaLabel: 'ribbon.scriptButtonName' }))],
    ['Sample Scripts', ...SAMPLE_BUTTONS.map(([id, label, glyph]) => direct(label, glyph, 'runScript', { sample: id },
      { ariaLabel: phrase('ribbon.runSampleName', { name: t(label) }, { name: tSource(label) }) }))],
    ['Help', large(direct('ribbon.scriptReference', 'scriptReference', 'scriptReference', null))],
  ],
}[name] || []);
/** The sample scripts on the Automate tab, each run by its button: [sample id, catalog key of its name, glyph]. */
const SAMPLE_BUTTONS = [
  ['highlight-duplicates', 'ribbon.sample.highlightDuplicates', 'highlightDuplicates'], ['unhide-everything', 'ribbon.sample.unhideEverything', 'unhideAll'],
  ['sum-each-column', 'ribbon.sample.sumEachColumn', 'sumColumns'], ['table-of-contents', 'ribbon.sample.tableOfContents', 'tableOfContents'],
  ['header-row', 'ribbon.sample.styleHeaderRow', 'styleHeaderRow'], ['remove-blank-rows', 'ribbon.sample.removeBlankRows', 'removeBlankRows'],
];

/** A large button's name on two lines ("Sort &" over "Filter"), split where the longer line is shortest. */
function twoLineLabel(span, text) {
  const words = String(text).split(' ');
  if (words.length < 2) { span.textContent = text; return; }
  let best = 1;
  const longer = (at) => Math.max(words.slice(0, at).join(' ').length, words.slice(at).join(' ').length);
  for (let at = 2; at < words.length; at++) if (longer(at) < longer(best)) best = at;
  span.replaceChildren(el('span.ribbon-label-line', {}, `${words.slice(0, best).join(' ')} `), el('span.ribbon-label-line', {}, words.slice(best).join(' ')));
}

export function createRibbon(ctx) {
  const root = el('div.ribbon.toolbar');
  const id = fieldId('ribbon');
  const tabs = el('div.ribbon-tabs', { role: 'tablist', 'aria-label': t('ribbon.ribbon') });
  const names = [...RIBBON_TABS, 'Table', 'Chart Design', 'Format', 'SmartArt Design', 'SmartArt Format', 'Picture Format'];
  const CHART_TABS = ['Chart Design', 'Format'];
  // A selected SmartArt graphic offers its own two tabs; the second is called Format, as a chart's is.
  const SMARTART_TABS = ['SmartArt Design', 'SmartArt Format'];
  // A selected picture offers Picture Format, as a selected chart offers its two tabs.
  const PICTURE_TABS = ['Picture Format'];
  // The name a built-in tab shows, and its English, which its key tip is worked out from.
  const tabLabel = name => builtinTabLabel(name === 'SmartArt Format' ? 'Format' : name);
  const tabKeytip = name => builtinTabSourceLabel(name === 'SmartArt Format' ? 'Format' : name);
  const contextualTab = name => name === 'Table' || CHART_TABS.includes(name) || SMARTART_TABS.includes(name) || PICTURE_TABS.includes(name);
  const CONTEXT_TABS = ['Table', ...CHART_TABS, ...SMARTART_TABS, ...PICTURE_TABS];
  let userHidden = new Set(); // tabs the person hid (applyLayout)
  let chartId = null;
  let smartArtId = null;
  let pictureId = null;
  const panels = [];
  const buttons = [];
  const dynamic = [];
  const builtControls = [];
  let active = 'Home';
  let lastRegular = 'Home';
  let tableId = null;
  let contextualScrollPending = false;
  // In the order on screen, which the person's arrangement of the tabs decides (see applyLayout).
  const visibleTabs = () => [...tabs.children].filter(b => !b.hidden);
  let collapsed = false;
  try { collapsed = localStorage.getItem('spreadsheet:ribbon') === 'collapsed'; } catch { /* optional storage */ }
  // A double-click's first click already expands a collapsed ribbon; the double-click then leaves it expanded.
  let clickExpanded = false;
  const menus = () => menubarMenus(ctx.flags?.() || {});
  /**
   * A command run from the ribbon hands the keyboard back to the sheet once it is done, as Excel's ribbon does,
   * unless it put the focus somewhere itself (a pane, a dialog, a menu): Show Formulas, Error Checking with
   * nothing to report or a Paste with nothing to paste left it on the button, and the next arrow key roamed the
   * ribbon instead of moving the active cell.
   */
  const backToSheet = (button, result) => {
    Promise.resolve(result).finally(() => { if (document.activeElement === button && button.isConnected) ctx.grid?.focus?.(); });
  };
  const makeButton = descriptor => {
    if (descriptor.split) {
      const face = makeButton({ ...descriptor, split: null });
      const arrowLabel = t('ribbon.splitOptions', { label: descriptor.label });
      const arrow = makeButton({ label: arrowLabel, glyph: 'chevD', ariaLabel: arrowLabel, arrow: true,
        keytip: tSource('ribbon.splitOptions', { label: descriptor.keytip ?? descriptor.label }),
        resolve: (menus, context) => {
          const face = descriptor.resolve?.(menus, context);
          return lazySubmenu({ label: descriptor.label, disabled: !face || !!face.disabled }, () => descriptor.split(menus, context));
        } });
      const wrap = el('span.ribbon-split', { role: 'group', 'aria-label': descriptor.label }, face, arrow);
      if (descriptor.large) wrap.classList.add('ribbon-split-large');
      return wrap;
    }
    const button = el('button.tb-btn.ribbon-command', {
      type: 'button', tabindex: -1, 'aria-label': descriptor.ariaLabel || descriptor.label,
      html: icon(descriptor.glyph, descriptor.large ? 32 : descriptor.arrow ? 12 : 20),
      onclick: () => {
        const item = descriptor.resolve?.(menus(), ctx);
        if (!item || item.disabled || descriptor.unsupported) return;
        if (item.submenu) openMenu({ anchor: button, label: descriptor.label, minWidth: 230,
          items: toMenuItems(item.submenu, ctx.run), onClose: reason => { if (reason === 'select') ctx.grid.focus(); } });
        else if (item.fn) item.fn();
        else if (item.cmd) backToSheet(button, ctx.run(item.cmd, MENU_COMMANDS.has(item.cmd) ? button : item.arg));
      },
    }, descriptor.arrow ? null : el('span.ribbon-button-label', {}, descriptor.label));
    // Key tips are worked out from the English name (keytips.js); a descriptor without one keeps its name's.
    if (descriptor.keytip) button.dataset.keytipLabel = descriptor.keytip;
    if (descriptor.large) button.classList.add('ribbon-large');
    if (descriptor.arrow) button.classList.add('ribbon-split-arrow');
    if (descriptor.look) {
      button.classList.add('ribbon-table-style');
      button.querySelector('.ribbon-button-label').textContent = descriptor.shortLabel ?? descriptor.label;
      button.querySelector('svg')?.remove();
      button.prepend(el('span.ribbon-table-sample', { 'aria-hidden': 'true', style: { '--table-head': descriptor.look.header, '--table-band': descriptor.look.band } },
        ...Array.from({ length: 12 }, (_, i) => el('span', { dataset: { row: Math.floor(i / 3) } }))));
    }
    dynamic.push({ button, descriptor });
    return button;
  };
  const extras = {
    clipboard: [large(split(c('common.paste', 'paste', 'paste'), (menus, context) => pasteGalleryItems({ disabled: !!context?.flags?.()?.editing }))),
      c('common.cut', 'cut', 'cut'), c('common.copy', 'copy', 'copy')].map(makeButton),
    styles: [large(direct('ribbon.formatAsTable', 'formatTable', 'formatAsTableMenu', null))].map(makeButton),
    cells: [insertMenu(), deleteMenu(), formatMenu()].map(makeButton),
    editing: [split(c('ribbon.autoSum', 'autosum', 'autosum'), () => autoSumMenu()), m('ribbon.fill', 'fillDown', 'edit', 'fillDown'), clearMenu(), large(findAndSelect())].map(makeButton),
  };
  const toolbar = createToolbar(ctx, { ribbon: true, ribbonExtras: extras });
  toolbar.el.classList.remove('toolbar');
  const tableNameError = el('span.ribbon-table-error', { id: `${id}-table-error`, role: 'alert', hidden: true });
  const tableName = el('input.input.ribbon-table-name.ribbon-control', {
    type: 'text', 'aria-label': t('ribbon.tableName'), 'aria-describedby': tableNameError.id, dataset: { keytipLabel: tSource('ribbon.tableName') },
    title: t('ribbon.tableNameTip'), spellcheck: false, autocomplete: 'off', tabindex: -1,
    oninput: () => { tableNameError.hidden = true; tableName.removeAttribute('aria-invalid'); },
    onkeydown: async e => {
      if (isComposing(e)) return;
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        tableName.value = ctx.flags?.().table?.name || '';
        tableNameError.hidden = true; tableName.removeAttribute('aria-invalid');
        buttons[names.indexOf('Table')].focus();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation();
        enabled(panels[names.indexOf('Table')]).find(b => b !== tableName)?.focus();
      } else if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        const targetId = tableId;
        const problem = await ctx.run('tableRename', { id: targetId, name: tableName.value });
        if (targetId !== tableId) return;
        if (problem) {
          tableNameError.textContent = problem; tableNameError.hidden = false; tableName.setAttribute('aria-invalid', 'true');
        } else {
          tableName.value = ctx.flags?.().table?.name || '';
          tableNameError.hidden = true; tableName.removeAttribute('aria-invalid');
          ctx.grid.focus();
        }
      }
    },
  });
  /** A tab and its (empty) panel; `name` is the tab's id, a built-in tab's English name or a custom tab's id. */
  function makeTab(name, text = null) {
    const panelId = `${id}-${name.replaceAll(' ', '-').toLowerCase()}`;
    const tab = el('button.ribbon-tab', {
      type: 'button', role: 'tab', id: `${panelId}-tab`, 'aria-controls': panelId,
      'aria-selected': String(name === active), tabindex: name === active ? 0 : -1,
      ...(name === 'SmartArt Format' ? { 'aria-label': builtinTabLabel('SmartArt Format') } : {}),
      // A built-in tab's key tip comes from its English name, the same in every language.
      ...(text === null ? { dataset: { keytipLabel: tabKeytip(name) } } : {}),
      onclick: e => { if (e.detail <= 1) clickExpanded = collapsed; select(name); },
      ondblclick: () => { if (clickExpanded) clickExpanded = false; else setCollapsed(!collapsed); },
      onkeydown: e => {
        if (isComposing(e) || e.altKey || e.ctrlKey || e.metaKey) return;
        const list = visibleTabs(), index = list.indexOf(tab);
        const next = e.key === 'ArrowRight' ? (index + 1) % list.length : e.key === 'ArrowLeft' ? (index - 1 + list.length) % list.length : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : null;
        // Moving along the tabs chooses one without expanding a collapsed ribbon; Enter, a click or ArrowDown opens it.
        if (next !== null) { e.preventDefault(); select(names[buttons.indexOf(list[next])], { expand: false }); list[next].focus(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); setCollapsed(false); enabled(panels[names.indexOf(name)])[0]?.focus(); }
      },
    }, text === null ? tabLabel(name) : text);
    const panel = el('div.ribbon-panel', { id: panelId, role: 'tabpanel', 'aria-labelledby': tab.id, hidden: name !== active });
    return { tab, panel };
  }
  /** A panel's row of groups, moved along by the arrows; Escape goes back up to the tab. */
  function makeTools(name, panel, tab) {
    const tools = el('div.ribbon-panel-tools', { role: 'toolbar', 'aria-label': t('ribbon.tabCommands', { tab: name }) });
    panel.append(tools);
    tools.addEventListener('focusin', e => { if (enabled(panel).includes(e.target)) rove(panel, e.target); });
    tools.addEventListener('keydown', e => {
      if (isComposing(e) || e.altKey || e.ctrlKey || e.metaKey || e.target === tableName) return;
      const list = enabled(panel), at = list.indexOf(document.activeElement);
      if (at < 0) return;
      const next = e.key === 'ArrowRight' ? list[(at + 1) % list.length] : e.key === 'ArrowLeft' ? list[(at - 1 + list.length) % list.length] : e.key === 'Home' ? list[0] : e.key === 'End' ? list.at(-1) : null;
      if (next) { e.preventDefault(); rove(panel, next); next.focus(); }
      if (e.key === 'Escape') { e.preventDefault(); tab.focus(); }
    });
    return tools;
  }
  for (const name of names) {
    const { tab, panel } = makeTab(name);
    tab.dataset.builtinName = name;
    // Its own name in the interface language, whatever the person renamed it to (Options and the command catalog show it).
    tab.dataset.builtinLabel = tabLabel(name);
    if (name === 'Home') {
      panel.append(toolbar.el);
      // Escape from a Home command goes back up to the Home tab, as it does from every other tab's commands.
      toolbar.el.addEventListener('keydown', e => {
        if (e.key !== 'Escape' || isComposing(e) || e.altKey || e.ctrlKey || e.metaKey || !e.target.matches?.('.tb-btn')) return;
        e.preventDefault(); tab.focus();
      });
    } else {
      const tools = makeTools(tabLabel(name), panel, tab);
      for (const [group, ...descriptors] of groupsFor(name)) {
        // The group is known by its English name (data-group-name, which Customize Ribbon reads) and shows its own.
        const { name: label, label: shown } = groupNaming(group);
        // A control built in place (a field, a picker) refreshes with the ribbon through its own `refresh`.
        const controls = el('div.ribbon-group-controls', {}, ...descriptors.map(d => (d.element ? (built => { builtControls.push(built); return built; })(d.element(ctx)) : makeButton(d))));
        if (name === 'Table' && label === 'Properties') controls.classList.add('ribbon-table-properties');
        if (name === 'Table' && label === 'Properties') controls.prepend(el('label.ribbon-table-name-field', {}, el('span', {}, t('ribbon.tableNameLabel')), tableName));
        if (name === 'Table' && label === 'Table Styles') controls.classList.add('ribbon-table-gallery');
        // Each sheet option stands over its print counterpart: Gridlines over Print gridlines, Headings over Print headings.
        if (name === 'Page Layout' && label === 'Sheet Options') controls.classList.add('ribbon-two-rows');
        tools.append(el('div.ribbon-group', { role: 'group', 'aria-label': shown, dataset: { groupName: label } }, controls, el('span.ribbon-group-label', {}, shown)));
      }
    }
    if (name === 'Table') { tab.classList.add('ribbon-context-tab'); panel.dataset.tablePanel = ''; }
    if (CHART_TABS.includes(name) || PICTURE_TABS.includes(name)) tab.classList.add('ribbon-context-tab', 'ribbon-chart-tab');
    if (SMARTART_TABS.includes(name)) tab.classList.add('ribbon-context-tab', 'ribbon-smartart-tab');
    // Its key tip is its own (J for the picture tools, then P), leaving Page Layout its single P.
    if (PICTURE_TABS.includes(name)) tab.dataset.keytip = 'JP';
    buttons.push(tab); panels.push(panel); tabs.append(tab);
  }
  const toggle = el('button.ribbon-collapse', { type: 'button', 'aria-controls': `${id}-panels`, onclick: () => setCollapsed(!collapsed) });
  const content = el('div.ribbon-panels', { id: `${id}-panels` }, ...panels);
  const scrollButton = (direction, label, glyph) => el('button.ribbon-scroll', {
    type: 'button', 'aria-label': label, title: label, html: icon(glyph, 16),
    onclick: () => {
      const tools = activeTools();
      if (!tools) return;
      tools.scrollLeft += direction * Math.max(100, tools.clientWidth * 0.6);
      updateOverflow();
    },
  });
  const scrollLeft = scrollButton(-1, t('ribbon.scrollLeft'), 'chevL');
  const scrollRight = scrollButton(1, t('ribbon.scrollRight'), 'chevR');
  const scrollControls = el('div.ribbon-scroll-controls', { role: 'group', 'aria-label': t('ribbon.scrollCommands'), hidden: true }, scrollLeft, scrollRight);
  root.append(el('div.ribbon-tab-row', {}, tabs, scrollControls, toggle), content, tableNameError);
  function activeTools() { return panels[names.indexOf(active)]?.querySelector('.ribbon-home, .ribbon-panel-tools'); }
  function updateOverflow() {
    const tools = activeTools();
    const overflow = !collapsed && tools?.clientWidth > 0 && tools.scrollWidth > tools.clientWidth + 1;
    if (!overflow && scrollControls.contains(document.activeElement)) buttons[names.indexOf(active)].focus({ preventScroll: true });
    scrollControls.hidden = !overflow;
    scrollLeft.setAttribute('aria-disabled', String(!overflow || tools.scrollLeft <= 1));
    scrollRight.setAttribute('aria-disabled', String(!overflow || tools.scrollLeft >= tools.scrollWidth - tools.clientWidth - 1));
  }
  /**
   * Ribbon scaling: when a tab's commands do not fit, its groups shrink from the right, each one's small
   * buttons keeping their icons but dropping their names (shown as tooltips instead), until the tab fits. What
   * still does not fit scrolls, as before.
   */
  let fitWidth = -1, fitTab = null;
  function fitGroups() {
    const tools = activeTools();
    if (!tools || collapsed || !(tools.clientWidth > 0)) return;
    if (tools.clientWidth === fitWidth && fitTab === active) return;
    fitWidth = tools.clientWidth; fitTab = active;
    const groups = [...tools.querySelectorAll('.ribbon-group')];
    // A compact group shows its small commands as icons, their names moved to tooltips.
    const setCompact = (group, on) => {
      group.classList.toggle('ribbon-compact', on);
      if (on) for (const b of group.querySelectorAll('.tb-btn:not(.ribbon-large):not([title])')) { b.title = b.getAttribute('aria-label') || ''; b.dataset.fitTitle = ''; }
      else for (const b of group.querySelectorAll('[data-fit-title]')) { b.removeAttribute('title'); delete b.dataset.fitTitle; }
    };
    for (const group of groups) setCompact(group, false);
    const fits = () => tools.scrollWidth <= tools.clientWidth + 1;
    const compacted = [];
    for (let i = groups.length - 1; i >= 0 && !fits(); i--) {
      const group = groups[i];
      // Only names on screen can be dropped: a group whose names are already hidden (Home's Editing) would only widen.
      if (![...group.querySelectorAll('.tb-btn:not(.ribbon-large) .ribbon-button-label')].some(label => label.getClientRects().length)) continue;
      setCompact(group, true); compacted.push(group);
    }
    // The last group compacted may have freed enough room on its own: give back the names of any earlier one that fits again.
    for (const group of compacted.slice(0, -1)) {
      setCompact(group, false);
      if (!fits()) setCompact(group, true);
    }
  }
  for (const panel of panels) panel.querySelector('.ribbon-home, .ribbon-panel-tools')?.addEventListener('scroll', updateOverflow, { passive: true });
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    // Keep the selected context discoverable when a narrower layout clips the tab strip.
    buttons[names.indexOf(active)]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    fitGroups();
    updateOverflow();
  }) : null;
  observer?.observe(root);
  observer?.observe(tabs);
  for (const panel of panels) observer?.observe(panel);

  const enabled = panel => [...panel.querySelectorAll('.tb-btn, .ribbon-control')].filter(b => !b.disabled && !b.closest('[hidden], [inert]'));
  const rove = (panel, target) => { for (const b of panel.querySelectorAll('.tb-btn, .ribbon-control')) b.tabIndex = b === target ? 0 : -1; };
  function select(name, { expand = true } = {}) {
    if (!names.includes(name) || (name === 'Table' && !tableId) || (CHART_TABS.includes(name) && !chartId) || (SMARTART_TABS.includes(name) && !smartArtId)
      || (PICTURE_TABS.includes(name) && !pictureId)) return;
    active = name;
    tableNameError.hidden = true;
    if (!contextualTab(name)) lastRegular = name;
    if (collapsed && expand) setCollapsed(false);
    refresh();
  }
  function setCollapsed(on) {
    if (on && content.contains(document.activeElement)) buttons[names.indexOf(active)].focus();
    collapsed = !!on;
    try { localStorage.setItem('spreadsheet:ribbon', collapsed ? 'collapsed' : 'expanded'); } catch { /* optional storage */ }
    refresh();
  }
  function refresh() {
    const focused = root.contains(document.activeElement) ? document.activeElement : null;
    const flags = ctx.flags?.() || {};
    const currentTable = flags.chartSheet || flags.away ? null : flags.table;
    const nextTableId = currentTable?.id || null;
    const contextChanged = nextTableId !== tableId;
    if (contextChanged) {
      tableId = nextTableId;
      // New context offers its tools; a user can choose another tab while staying in the table.
      if (tableId && !flags.editing && !collapsed) active = 'Table';
      else if (!tableId && active === 'Table') active = lastRegular;
      if (tableId) contextualScrollPending = true;
      tableNameError.hidden = true; tableName.removeAttribute('aria-invalid');
    }
    // A selected chart offers Chart Design and Format, and opens on Chart Design.
    const nextChartId = flags.editing ? chartId : activeChart(ctx)?.id || null;
    if (nextChartId !== chartId) {
      const fresh = !chartId && nextChartId;
      chartId = nextChartId;
      if (fresh && !collapsed && !flags.editing) active = 'Chart Design';
      else if (!chartId && CHART_TABS.includes(active)) active = tableId ? 'Table' : lastRegular;
    }
    const nextPictureId = flags.editing ? pictureId : activePicture(ctx)?.id || null;
    if (nextPictureId !== pictureId) {
      const fresh = !pictureId && nextPictureId;
      pictureId = nextPictureId;
      if (fresh && !collapsed && !flags.editing) active = 'Picture Format';
      else if (!pictureId && PICTURE_TABS.includes(active)) active = tableId ? 'Table' : lastRegular;
    }
    for (const name of CHART_TABS) buttons[names.indexOf(name)].hidden = !chartId;
    // A selected SmartArt graphic offers SmartArt Design and Format, and opens on SmartArt Design.
    const nextSmartArtId = flags.editing ? smartArtId : activeSmartArt(ctx)?.id || null;
    if (nextSmartArtId !== smartArtId) {
      const fresh = !smartArtId && nextSmartArtId;
      smartArtId = nextSmartArtId;
      if (fresh && !collapsed && !flags.editing) active = 'SmartArt Design';
      else if (!smartArtId && SMARTART_TABS.includes(active)) active = tableId ? 'Table' : lastRegular;
    }
    for (const name of SMARTART_TABS) buttons[names.indexOf(name)].hidden = !smartArtId;
    for (const name of PICTURE_TABS) buttons[names.indexOf(name)].hidden = !pictureId;
    const contextual = buttons[names.indexOf('Table')];
    contextual.hidden = !tableId || !!chartId || !!smartArtId || !!pictureId;
    // Tabs the person hid (Options ▸ Customize Ribbon) stay hidden.
    for (let i = 0; i < names.length; i++) if (!CONTEXT_TABS.includes(names[i])) buttons[i].hidden = userHidden.has(names[i]);
    // A chart chosen over a collapsed ribbon hides the Table tab without opening Chart Design: never leave a hidden tab selected.
    if (buttons[names.indexOf(active)].hidden) active = !buttons[names.indexOf(lastRegular)]?.hidden ? lastRegular : firstShown();
    if (contextualScrollPending && active === 'Table') {
      contextual.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      contextualScrollPending = false;
    }
    if (contextChanged || focused !== tableName) tableName.value = currentTable?.name || '';
    tableName.disabled = !tableId || !!flags.editing || !!flags.sheet?.protected;
    const definitions = menus();
    for (const { button, descriptor } of dynamic) {
      const item = descriptor.resolve?.(definitions, ctx);
      if (item?.cmd === 'protectSheet') {
        // Protect Sheet, or Unprotect Sheet on a protected sheet, as the menus' item says (in sentence case there).
        const said = flags.sheet?.protected ? phrase('ribbon.unprotectSheet') : phrase('ribbon.protectSheet');
        const span = button.querySelector('.ribbon-button-label');
        if (button.classList.contains('ribbon-large')) twoLineLabel(span, said.text); else span.textContent = said.text;
        button.setAttribute('aria-label', said.text);
        button.dataset.keytipLabel = said.source;
      }
      button.disabled = descriptor.unsupported || !item || !!item.disabled || (button.closest('[data-table-panel]') && (!!flags.editing || !!flags.sheet?.protected));
      const label = descriptor.label;
      button.title = descriptor.unsupported ? descriptor.reason || t('ribbon.tip.notSupported', { label }) : !item ? t('ribbon.tip.unavailable', { label })
        : item.disabled && item.hint ? t('ribbon.tip.withHint', { label, hint: item.hint }) : item.shortcut ? t('ribbon.tip.withShortcut', { label, shortcut: item.shortcut }) : label;
      button.setAttribute('aria-keyshortcuts', ariaKeyShortcuts(item?.shortcut) || '');
      if ((item && 'submenu' in item) || MENU_COMMANDS.has(item?.cmd)) button.setAttribute('aria-haspopup', 'menu'); else button.removeAttribute('aria-haspopup');
      if ((item?.checked ?? descriptor.checked) !== undefined) button.setAttribute('aria-pressed', String(!!(item?.checked ?? descriptor.checked))); else button.removeAttribute('aria-pressed');
      if (item?.cmd) button.dataset.cmd = item.cmd;
      // What the button runs, for Add to Quick Access Toolbar and the person's own tabs (see command-catalog.js).
      button._command = item?.cmd && !('submenu' in item) && !descriptor.arrow
        ? { cmd: item.cmd, arg: MENU_COMMANDS.has(item.cmd) ? null : item.arg ?? null, label: descriptor.label, glyph: descriptor.glyph } : null;
      descriptor.decorate?.(button, item, ctx);
    }
    for (const control of builtControls) control.refresh?.();
    content.hidden = collapsed;
    for (let i = 0; i < panels.length; i++) panels[i].hidden = names[i] !== active;
    toolbar.refresh();
    root.classList.toggle('ribbon-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? t('ribbon.expand') : t('ribbon.collapse'));
    toggle.title = collapsed ? t('ribbon.expandTip') : t('ribbon.collapseTip');
    toggle.innerHTML = icon(collapsed ? 'chevD' : 'chevU', 16);
    for (let i = 0; i < buttons.length; i++) {
      const selected = names[i] === active;
      buttons[i].setAttribute('aria-selected', String(selected)); buttons[i].tabIndex = selected && !buttons[i].hidden ? 0 : -1;
      panels[i].hidden = !selected;
      if (i) {
        const available = enabled(panels[i]);
        rove(panels[i], available.includes(focused) ? focused : available.find(b => b.tabIndex === 0) || available[0]);
      }
    }
    fitGroups();
    updateOverflow();
    if (focused && (focused.disabled || focused.closest('[hidden]'))) {
      (enabled(panels[names.indexOf(active)])[0] || buttons[names.indexOf(active)]).focus({ preventScroll: true });
    }
  }
  /** The first tab shown that is not contextual. */
  function firstShown() {
    return names[buttons.indexOf(visibleTabs().find(b => !CONTEXT_TABS.includes(names[buttons.indexOf(b)])))] || 'Home';
  }

  /*
   * The person's arrangement (Options ▸ Customize Ribbon, kept in lib/customize.js): tabs shown or hidden,
   * renamed and reordered, tabs of their own, and groups of their own on any tab, each button running any
   * command. Applied at start and again whenever it changes.
   */
  const customButtons = new Set();
  const customTabs = new Set();
  /** A button for a command by its id, named and drawn as the catalog has it. */
  const customDescriptor = (commandId, entry) => {
    const { cmd, arg } = parseCommandId(commandId);
    const label = entry?.label || cmd;
    return { label, glyph: entry?.icon || 'sliders', ariaLabel: label,
      resolve: (menus, context) => {
        const f = context?.flags?.() || {};
        const item = command(cmd, arg === null ? undefined : arg)(menus);
        if (item && JSON.stringify(item.arg ?? null) === JSON.stringify(arg)) return { ...item, label };
        const grouped = !!f.grouped && GROUP_BLOCKED_COMMANDS.has(cmd);
        return { label, cmd, arg, disabled: !!f.editing || grouped, hint: grouped ? groupBlockedHint() : undefined };
      } };
  };
  function customGroup(g, catalog) {
    const made = g.commands.map(cid => makeButton(customDescriptor(cid, catalog.find(e => e.id === cid))));
    for (const b of made) customButtons.add(b);
    return el('div.ribbon-group.ribbon-custom-group', { role: 'group', 'aria-label': g.name, dataset: { customGroup: g.id } },
      el('div.ribbon-group-controls', {}, ...(made.length ? made : [el('span.ribbon-group-empty', {}, t('ribbon.noCommandsYet'))])),
      el('span.ribbon-group-label', {}, g.name));
  }
  function applyLayout(layout = ribbonLayoutStore.get()) {
    // Take away what the last arrangement added.
    for (const node of root.querySelectorAll('[data-custom-group]')) node.remove();
    for (const name of customTabs) {
      const at = names.indexOf(name);
      if (at < 0) continue;
      buttons[at].remove(); panels[at].remove();
      names.splice(at, 1); buttons.splice(at, 1); panels.splice(at, 1);
    }
    customTabs.clear();
    for (let i = dynamic.length - 1; i >= 0; i--) if (customButtons.has(dynamic[i].button)) dynamic.splice(i, 1);
    customButtons.clear();
    // The buttons on screen learn what they run as they refresh; the catalog reads it from them. Only a
    // layout with groups of its own needs it, to name and draw their buttons.
    const owned = Object.values(layout.groups).some(list => list.some(g => g.commands.length));
    if (owned) refresh();
    const catalog = owned ? commandCatalog(ctx.flags?.() || {}, root) : [];
    for (const own of layout.tabs) {
      const { tab, panel } = makeTab(own.id, own.name);
      tab.classList.add('ribbon-custom-tab');
      makeTools(own.name, panel, tab);
      customTabs.add(own.id);
      names.push(own.id); buttons.push(tab); panels.push(panel);
      content.append(panel);
      panel.querySelector('.ribbon-panel-tools')?.addEventListener('scroll', updateOverflow, { passive: true });
      observer?.observe(panel);
    }
    for (const [tabId, groups] of Object.entries(layout.groups)) {
      const at = names.indexOf(tabId);
      if (at < 0) continue;
      const tools = panels[at].querySelector('.ribbon-home, .ribbon-panel-tools');
      for (const g of groups) tools?.append(customGroup(g, catalog));
    }
    // Order, names and visibility of the regular tabs; the contextual tabs keep their place at the end.
    const order = tabsIn(layout, RIBBON_TABS);
    for (const shown of order) {
      const at = names.indexOf(shown.id);
      if (at < 0) continue;
      if (shown.builtin) {
        buttons[at].textContent = shown.name;
        // A tab the person renamed takes its key tip from the name they gave it, as one of their own does.
        if (shown.renamed) delete buttons[at].dataset.keytipLabel; else buttons[at].dataset.keytipLabel = tabKeytip(shown.id);
      }
      tabs.append(buttons[at]);
    }
    for (const name of CONTEXT_TABS) tabs.append(buttons[names.indexOf(name)]);
    userHidden = new Set(order.filter(shown => shown.hidden).map(shown => shown.id));
    if (!names.includes(active)) active = firstShown();
    if (!names.includes(lastRegular) || userHidden.has(lastRegular)) lastRegular = firstShown();
    fitWidth = -1;
    refresh();
  }

  // Right-click a command: put it on the Quick Access Toolbar (or take it off), or customize the ribbon.
  root.addEventListener('contextmenu', e => {
    if (e.defaultPrevented) return;
    const target = e.target.closest?.('.tb-btn, .ribbon-tab');
    if (!target || !root.contains(target)) return;
    e.preventDefault();
    const commandOf = target.classList.contains('ribbon-tab') ? null : target._command || null;
    openMenu({ anchor: target, label: t('ribbon.ribbon'), minWidth: 250,
      items: ribbonButtonMenuItems(ctx, commandOf, { collapsed, toggleCollapsed: () => setCollapsed(!collapsed) }),
      onClose: reason => { if (reason === 'select') ctx.grid?.focus?.(); } });
  });

  const unsubscribe = ctx.subscribe(refresh);
  const unsubscribeLayout = ribbonLayoutStore.subscribe(layout => applyLayout(layout));
  applyLayout();
  for (const span of root.querySelectorAll('.ribbon-large .ribbon-button-label')) twoLineLabel(span, span.textContent);
  return { el: root, refresh, select, applyLayout, toggleCollapsed() { setCollapsed(!collapsed); }, destroy() { observer?.disconnect(); unsubscribe(); unsubscribeLayout(); toolbar.destroy(); } };
}
