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
import { normalizePrintSettings } from '../core/print-settings.js';
import { drawRibbonGroups } from './ink.js';
import { equationGalleryItems } from './equation.js';
import { queryForTable } from '../core/queries.js';
import { pasteGalleryItems } from './pastespecialdialog.js';
import { chartInsertGroup, chartDesignGroups, chartFormatGroups } from './chart-ribbon.js';
import { pictureFormatGroups, activePicture } from './picture-ribbon.js';
import { activeChart } from './chart-actions.js';
import { GROUP_BLOCKED_COMMANDS, GROUP_BLOCKED_HINT } from '../core/sheet-group.js';
import { arrangeGroup } from './arrange-ribbon.js';
import { activeSmartArt, smartArtDesignGroups, smartArtFormatGroups } from './smartart.js';
import { ribbonLayoutStore, parseCommandId } from '../lib/customize.js';
import { tabsIn } from '../core/ribbon-layout.js';
import { commandCatalog } from './command-catalog.js';
import { ribbonButtonMenuItems } from './quick-access.js';

/** The menus' commands, flattened once for each set of menus however many buttons look in them. */
const leavesOf = new WeakMap();
const command = (cmd, arg) => menus => {
  let items = leavesOf.get(menus);
  if (!items) leavesOf.set(menus, items = menus.flatMap(m => menuLeaves(m.items)));
  return items.find(it => it.cmd === cmd && (arg === undefined || JSON.stringify(it.arg) === JSON.stringify(arg)));
};
const submenu = (menu, label) => menus => {
  const find = items => {
    for (const item of items) {
      if (item.label === label && item.submenu) return item;
      const nested = item.submenu && find(item.submenu);
      if (nested) return nested;
    }
  };
  return find(menus.find(m => m.id === menu)?.items || []);
};
const COMMAND_LABELS = { link: 'Insert link', insertChart: 'Insert chart', functionMenu: 'Insert function' };
const c = (label, glyph, cmd, arg) => ({ label, glyph, ariaLabel: COMMAND_LABELS[cmd], resolve: command(cmd, arg) });
const m = (label, glyph, menu, name) => ({ label, glyph, resolve: submenu(menu, name) });
const combined = (label, glyph, ...resolve) => ({ label, glyph, resolve: menus => ({ label, submenu: resolve.map(fn => fn(menus)).filter(Boolean) }) });
const unsupported = (label, glyph, reason) => ({ label, glyph, unsupported: true, reason });
/** A command with an argument chosen here; it is available whenever the menus offer the command itself. */
const a = (label, glyph, cmd, arg, extra = {}) => ({ label, glyph, ariaLabel: extra.ariaLabel || label, ...extra, resolve: menus => {
  const item = command(cmd)(menus);
  return item && { ...item, label, arg, checked: undefined, shortcut: extra.shortcut };
} });
/** A menu built when it opens (and on every refresh) from the workbook and editor state. */
const dyn = (label, glyph, build, extra = {}) => ({ label, glyph, ...extra, resolve: (menus, ctx) => lazySubmenu({ label }, () => build(menus, ctx)) });
/** A command that is not in the menus: available unless a cell is being edited. */
const direct = (label, glyph, cmd, arg, extra = {}) => ({ label, glyph, ariaLabel: extra.ariaLabel || label, ...extra,
  resolve: (menus, ctx) => {
    const f = ctx?.flags?.() || {};
    // Grouped sheets: a command for one sheet's objects waits, as the menus' does.
    const grouped = !!f.grouped && GROUP_BLOCKED_COMMANDS.has(cmd);
    return { label, cmd, arg, disabled: !!f.editing || grouped, hint: grouped ? GROUP_BLOCKED_HINT : undefined, checked: extra.isChecked?.(ctx) };
  } });
const large = descriptor => ({ ...descriptor, large: true });
/** A threaded-comment command (see ui/comments.js): greyed while a cell is edited, or without the thread `needs` names. */
const threadCmd = (label, glyph, cmd, { needs = null, toggle = false, ...extra } = {}) => ({ label, glyph, ariaLabel: extra.ariaLabel || label, ...extra,
  resolve: (menus, ctx) => {
    const f = ctx?.flags?.() || {};
    return { label, cmd, disabled: !toggle && (!!f.editing || !!f.chartSheet || (needs ? !f[needs] : false)), checked: toggle ? !!f.commentsPane : undefined, shortcut: extra.shortcut };
  } });
const NEW_COMMENT_KEY = `${MOD_KEY}+Shift+F2`;
/** Commands that open a menu of their own, anchored on the button that ran them; those buttons announce the menu. */
export const MENU_COMMANDS = new Set(['functionMenu', 'cellStylesMenu', 'shapesMenu', 'formatAsTableMenu', 'themesMenu', 'themeColorsMenu', 'themeFontsMenu', 'themeEffectsMenu', 'wordArtMenu']);
/** A split button: the face runs the command, the arrow beside it opens related choices. */
const split = (descriptor, menu) => ({ ...descriptor, split: menu });

const fnItem = name => ({ label: name, cmd: 'functionArgs', arg: name });
const fnList = names => [...names.map(fnItem), { separator: true }, { label: 'Insert Function…', icon: 'fx', cmd: 'insertFunctionDialog' }];
const category = (label, glyph) => dyn(label, glyph, () => fnList(functionCategories().get(label) || []), { ariaLabel: `${label} functions` });
const moreFunctions = dyn('More Functions', 'moreFunctions', () => MORE_CATEGORIES.map(name => ({ label: name, submenu: functionCategories().get(name).map(fnItem) }))
  .filter(item => item.submenu.length));
const recentFunctions = dyn('Recently Used', 'history', () => fnList(recentFunctionNames().filter(n => FUNCTION_NAMES.includes(n))));
const autoSumMenu = () => [
  { label: 'Sum', icon: 'sigma', cmd: 'autosum' },
  { label: 'Average', cmd: 'insertFunction', arg: 'AVERAGE' },
  { label: 'Count Numbers', cmd: 'insertFunction', arg: 'COUNT' },
  { label: 'Max', cmd: 'insertFunction', arg: 'MAX' },
  { label: 'Min', cmd: 'insertFunction', arg: 'MIN' },
  { separator: true },
  { label: 'More Functions…', icon: 'fx', cmd: 'insertFunctionDialog' },
];
/** Names a formula can use here: workbook names and this sheet's own, then tables. */
const useInFormula = dyn('Use in Formula', 'tag', (menus, ctx) => {
  const sheet = ctx.wb.sheet(ctx.sheetId())?.name;
  const names = (ctx.wb.names || []).filter(n => !n.hidden && (!n.sheet || n.sheet === sheet)).map(n => n.name);
  const tables = (ctx.wb.sheets || []).flatMap(sh => sh.tables || []).map(t => t.name).filter(Boolean);
  const items = [...new Set([...names, ...tables])].slice(0, 200).map(name => ({ label: name, cmd: 'useName', arg: name }));
  return items.length ? items : [{ label: 'No names defined', disabled: true }];
});
const printSettingsOf = ctx => ctx.wb.sheet(ctx.sheetId())?.printSettings || null;
/** The settings in force: a sheet without its own page setup prints with the defaults (Normal margins, Letter, portrait). */
const effectiveSettings = ctx => printSettingsOf(ctx) || normalizePrintSettings({});
const pageSetupItem = (label, patch, isChecked, extra = {}) => (menus, ctx) => ({ label, cmd: 'pageSetup', arg: patch, radio: true, checked: !!isChecked(effectiveSettings(ctx)), ...extra });
const MARGIN_PRESETS = [
  ['Normal', { top: 0.75, bottom: 0.75, left: 0.7, right: 0.7, header: 0.3, footer: 0.3 }, 'Top 0.75″ · Bottom 0.75″ · Left 0.7″ · Right 0.7″'],
  ['Wide', { top: 1, bottom: 1, left: 1, right: 1, header: 0.5, footer: 0.5 }, 'Top 1″ · Bottom 1″ · Left 1″ · Right 1″'],
  ['Narrow', { top: 0.75, bottom: 0.75, left: 0.25, right: 0.25, header: 0.3, footer: 0.3 }, 'Top 0.75″ · Bottom 0.75″ · Left 0.25″ · Right 0.25″'],
];
const PAPER_PRESETS = [['Letter', 1, '8.5″ × 11″'], ['Legal', 5, '8.5″ × 14″'], ['Tabloid', 3, '11″ × 17″'], ['A4', 9, '210 × 297 mm'], ['A3', 8, '297 × 420 mm']];
const sameMargins = (p, preset) => !!p.margins && Object.entries(preset).every(([k, v]) => Math.abs((p.margins[k] ?? -1) - v) < 1e-6);
const pageMenu = (label, glyph, build) => dyn(label, glyph, (menus, ctx) => build(ctx).map(fn => typeof fn === 'function' ? fn(menus, ctx) : fn)
  .map(item => (ctx.flags?.()?.editing && item.cmd ? { ...item, disabled: true } : item)));
/** Width or height in pages; 0 is Automatic, and both Automatic is no fitting at all. */
const fitChoices = (key, label) => pageMenu(label, key === 'fitWidth' ? 'fitWidth' : 'fitHeight', ctx => {
  const p = printSettingsOf(ctx) || {}, other = key === 'fitWidth' ? 'fitHeight' : 'fitWidth';
  const pages = p.fitToPage ? p[key] ?? 1 : 0, otherPages = p.fitToPage ? p[other] ?? 1 : 0;
  const choice = n => ({ label: n ? `${n} page${n === 1 ? '' : 's'}` : 'Automatic', cmd: 'pageSetup', radio: true, checked: pages === n,
    arg: n || otherPages ? { fitToPage: true, [key]: n, [other]: otherPages } : { fitToPage: false } });
  return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(choice);
});
const scaleChoices = pageMenu('Scale', 'scaling', ctx => {
  const p = printSettingsOf(ctx) || {};
  return [400, 200, 150, 125, 100, 90, 85, 75, 50, 25, 10].map(n => ({ label: `${n}%`, cmd: 'pageSetup', arg: { fitToPage: false, scale: n }, radio: true,
    checked: !p.fitToPage && (p.scale ?? 100) === n }));
});
const printOption = (label, key, glyph) => ({ label, glyph, ariaLabel: label, resolve: (menus, ctx) => {
  const on = !!printSettingsOf(ctx)?.[key];
  return { label, cmd: 'pageSetup', arg: { [key]: !on }, disabled: !!ctx?.flags?.()?.editing, checked: on };
} });
const disabledItem = (label, reason) => ({ label, hint: reason, disabled: true });
/** A View ▸ Sheet View button; `unavailable(flags)` greys it (Keep needs a temporary view, Exit any view). */
const sheetViewButton = (label, glyph, action, unavailable) => ({ label, glyph, ariaLabel: `${label} sheet view`,
  resolve: (menus, ctx) => {
    const f = ctx?.flags?.() || {};
    return { label, cmd: 'sheetView', arg: action, disabled: !!f.editing || !!f.chartSheet || unavailable(f) };
  } });

/** Home ▸ Cells ▸ Format: cell size, visibility, sheet organization and protection, then Format Cells. */
const formatMenu = dyn('Format', 'formatCells', menus => {
  const pick = (label, cmd, arg) => { const item = command(cmd, arg)(menus); return item && { ...item, label }; };
  const hide = submenu('view', 'Hide and unhide')(menus);
  return [
    { header: 'Cell Size' },
    pick('Row Height…', 'resizeRows'), pick('AutoFit Row Height', 'fitRows'), pick('Column Width…', 'resizeCols'), pick('AutoFit Column Width', 'autofit'),
    { header: 'Visibility' },
    hide && { ...hide, label: 'Hide & Unhide' },
    { header: 'Organize Sheets' },
    pick('Rename Sheet…', 'renameSheet'), pick('Move or Copy Sheet…', 'moveOrCopySheet'), pick('Tab Color…', 'sheetColor'),
    { header: 'Protection' },
    command('protectSheet')(menus), pick('Format Cells…', 'formatCells'),
  ].filter(Boolean);
}, { ariaLabel: 'Format' });
/** Home ▸ Cells ▸ Insert and Delete; each entry is the menus' own command, so availability follows them. */
const cellsMenu = (label, glyph, entries) => dyn(label, glyph, (menus, ctx) => entries.map(([text, cmd, arg, icon]) => {
  if (!cmd) return { separator: true };
  if (typeof cmd === 'function') return cmd(menus, ctx);
  const item = command(cmd, arg)(menus);
  return item && { ...item, label: text, icon };
}).filter(Boolean), { ariaLabel: label });
const dialogItem = (label, cmd) => (menus, ctx) => ({ label, icon: cmd === 'insertDialog' ? 'insertCells' : 'deleteCells', cmd, disabled: !!ctx?.flags?.()?.editing });
const insertMenu = cellsMenu('Insert', 'insertCells', [
  ['Insert Cells…', dialogItem('Insert Cells…', 'insertDialog')],
  ['Insert Copied Cells…', (menus, ctx) => (ctx?.flags?.()?.copiedCells ? { label: 'Insert Copied Cells…', icon: 'paste', cmd: 'insertCopiedCells', disabled: !!ctx.flags().editing } : null)], [],
  ['Insert Sheet Rows', 'insertRows', 'above', 'insertRows'], ['Insert Sheet Columns', 'insertCols', 'left', 'insertCols'], [],
  ['Insert Sheet', 'newSheet', undefined, 'insertSheet'],
]);
const deleteMenu = cellsMenu('Delete', 'deleteCells', [
  ['Delete Cells…', dialogItem('Delete Cells…', 'deleteDialog')], [],
  ['Delete Sheet Rows', 'deleteRows', undefined, 'deleteRows'], ['Delete Sheet Columns', 'deleteCols', undefined, 'deleteCols'], [],
  ['Delete Sheet', 'deleteSheet', undefined, 'deleteSheet'],
]);
/** Home ▸ Editing ▸ Clear; Clear Formats stays live mid-entry, as the Format menu's is. */
const clearMenu = dyn('Clear', 'eraser', (menus, ctx) => {
  const editing = !!ctx?.flags?.()?.editing;
  const formats = command('clearFormat')(menus);
  return [
    { label: 'Clear All', icon: 'eraser', cmd: 'clearAll', disabled: editing },
    formats && { ...formats, label: 'Clear Formats', icon: 'clearFormat' },
    { label: 'Clear Contents', cmd: 'clear', shortcut: 'Delete', disabled: editing },
    { label: 'Clear Comments and Notes', icon: 'deleteNote', cmd: 'clearNotes', disabled: editing },
    { label: 'Clear Hyperlinks', icon: 'unlink', cmd: 'clearLinks', disabled: editing },
  ].filter(Boolean);
}, { ariaLabel: 'Clear' });
/** Home ▸ Editing ▸ Find & Select. */
const findAndSelect = dyn('Find & Select', 'find', menus => {
  const pick = (label, cmd, arg, extra = {}) => { const item = command(cmd)(menus); return item && { ...item, label, arg, shortcut: extra.shortcut ?? item.shortcut }; };
  const special = kind => command('selectSpecial', kind)(menus);
  return [
    pick('Find…', 'find', null), pick('Replace…', 'find', 'replace', { shortcut: null }), pick('Go To…', 'goTo', null),
    { label: 'Go To Special', icon: 'check', submenu: Object.keys(SPECIAL_KINDS).map(special).filter(Boolean) },
    { separator: true },
    special('formulas') && { ...special('formulas'), label: 'Formulas' }, special('notes') && { ...special('notes'), label: 'Notes' },
    special('constants') && { ...special('constants'), label: 'Constants' },
  ].filter(Boolean);
});

/** Data ▸ Get Data: the sources by kind, then the Power Query Editor. */
const getDataMenu = dyn('Get Data', 'database', (menus, ctx) => {
  const editing = !!ctx?.flags?.()?.editing;
  const item = (label, cmd, glyph) => ({ label, cmd, icon: glyph, disabled: editing });
  return [
    { label: 'From File', icon: 'fromFile', submenu: [item('From Workbook', 'getDataWorkbook', 'sheet'), item('From Text/CSV', 'getDataText', 'fromText')] },
    { label: 'From Other Sources', icon: 'database', submenu: [item('From Table/Range', 'getDataTable', 'fromTable'), item('From Web', 'getDataWeb', 'fromWeb'),
      { separator: true }, item('Blank Query', 'blankQuery', 'blankQuery')] },
    { separator: true },
    item('Launch Power Query Editor…', 'powerQueryEditor', 'powerQuery'),
  ];
}, { ariaLabel: 'Get Data' });
/** Data ▸ Refresh All's arrow: every query, or the one behind the table at the selection. */
const refreshMenu = (menus, ctx) => {
  const f = ctx?.flags?.() || {};
  return [
    { label: 'Refresh All', icon: 'refresh', cmd: 'refreshAll', disabled: !!f.editing },
    { label: 'Refresh', cmd: 'refreshQuery', disabled: !!f.editing || !f.table || !f.hasQueries },
  ];
};

export const RIBBON_TABS = ['Home', 'Insert', 'Draw', 'Page Layout', 'Formulas', 'Data', 'Review', 'View', 'Automate'];

/** References are resolved again on every refresh AND when a menu is opened. */
const groupsFor = name => ({
  Table: [
    ['Properties', c('Table Properties', 'formatTable', 'editTable'), c('Resize Table', 'resizeTable', 'tableResize')],
    ['Tools', c('Summarize with PivotTable', 'pivot', 'tableSource', 'pivot'), c('Remove Duplicates', 'dedupe', 'tableSource', 'dedupe'), c('Convert to Range', 'convertToRange', 'tableConvert'), c('Insert Slicer', 'slicer', 'insertSlicer')],
    // Refresh runs the query that loaded the table again; a table holding its own data has nothing to refresh.
    ['External Table Data', { label: 'Refresh', glyph: 'refresh', ariaLabel: 'Refresh', resolve: (menus, ctx) => {
      const f = ctx?.flags?.() || {};
      const table = f.table, sheetId = ctx?.sheetId?.();
      const loaded = !!table && !!ctx?.wb && queryForTable(ctx.wb, sheetId, table.id);
      return { label: 'Refresh', cmd: 'refreshQuery', disabled: !!f.editing || !loaded, hint: loaded ? null : 'Refresh updates a table loaded by a query; this table holds its own data' };
    } }],
    ['Table Style Options', c('Header Row', 'headerRow', 'tableOption', 'headerRow'), c('Total Row', 'subtotal', 'tableTotals'),
      c('Banded Rows', 'bandedRows', 'tableOption', 'banded'), c('First Column', 'firstColumn', 'tableOption', 'firstColumn'),
      c('Last Column', 'lastColumn', 'tableOption', 'lastColumn'), c('Banded Columns', 'bandedColumns', 'tableOption', 'bandedColumns'), c('Filter Button', 'filterButton', 'tableOption', 'filterButton')],
    ['Table Styles', ...TABLE_STYLES.map(([key, label, look]) => ({ ...c(`${label} table style`, 'table', 'tableStyle', key), look }))],
  ],
  Insert: [
    ['Tables', large(c('PivotTable', 'pivot', 'pivot')), large(direct('Recommended PivotTables', 'pivotRecommend', 'recommendedPivots', null)), large(c('Table', 'table', 'insertTable'))],
    ['Illustrations', large(m('Pictures', 'pictures', 'insert', 'Image')), direct('Shapes', 'shapes', 'shapesMenu', null), direct('Icons', 'icons', 'iconsDialog', null),
      { label: 'SmartArt', glyph: 'smartArt', ariaLabel: 'Insert SmartArt graphic', resolve: (menus, ctx) => {
        const f = ctx?.flags?.() || {};
        return { label: 'SmartArt', cmd: 'smartArt', arg: { action: 'insertDialog' }, disabled: !!f.editing || !!f.chartSheet || !!f.grouped };
      } }],
    chartInsertGroup(),
    ['Sparklines', a('Line', 'sparkLine', 'insertSparklines', 'line', { ariaLabel: 'Insert line sparklines' }),
      a('Column', 'sparkColumn', 'insertSparklines', 'column', { ariaLabel: 'Insert column sparklines' }),
      a('Win/Loss', 'sparkWinLoss', 'insertSparklines', 'stacked', { ariaLabel: 'Insert win/loss sparklines' })],
    ['Filters', large(c('Slicer', 'slicer', 'insertSlicer')), large(c('Timeline', 'timeline', 'insertTimeline'))],
    ['Links', large(c('Link', 'link', 'link'))],
    ['Comments', large(c('Note', 'note', 'note')), large(threadCmd('Comment', 'comment', 'newComment', { shortcut: NEW_COMMENT_KEY }))],
    ['Text', c('Text Box', 'textBox', 'insertTextBox'), a('Header & Footer', 'headerFooter', 'print', null, { ariaLabel: 'Header & Footer' }), direct('WordArt', 'wordArt', 'wordArtMenu', null)],
    ['Cells', c('Checkbox', 'checkbox', 'insertCheckbox'), c('Dropdown', 'dropdown', 'insertDropdown'), c('Date Picker', 'calendar', 'datePicker')],
    ['Symbols', large(split(direct('Equation', 'math', 'insertEquation', null), (menus, ctx) => equationGalleryItems(ctx))), large(direct('Symbol', 'symbol', 'symbolDialog', null))],
    ['Sheets', c('New Sheet', 'newSheet', 'newSheet')],
  ],
  Draw: drawRibbonGroups(),
  'Chart Design': chartDesignGroups(),
  Format: chartFormatGroups(),
  'Picture Format': pictureFormatGroups(),
  'SmartArt Design': smartArtDesignGroups(),
  'SmartArt Format': smartArtFormatGroups(),
  'Page Layout': [
    ['Themes', large(direct('Themes', 'palette', 'themesMenu', null)), direct('Colors', 'themeColors', 'themeColorsMenu', null, { ariaLabel: 'Theme Colors' }),
      direct('Fonts', 'themeFonts', 'themeFontsMenu', null, { ariaLabel: 'Theme Fonts' }), direct('Effects', 'themeEffects', 'themeEffectsMenu', null)],
    ['Page Setup',
      large(pageMenu('Margins', 'margins', () => [
        ...MARGIN_PRESETS.map(([label, preset, detail]) => pageSetupItem(label, { margins: preset }, p => sameMargins(p, preset), { hint: detail })),
        { separator: true }, { label: 'Custom Margins…', cmd: 'print', icon: 'margins' }])),
      large(pageMenu('Orientation', 'swap', () => [
        pageSetupItem('Portrait', { orientation: 'portrait' }, p => (p.orientation || 'portrait') === 'portrait'),
        pageSetupItem('Landscape', { orientation: 'landscape' }, p => p.orientation === 'landscape')])),
      large(pageMenu('Size', 'fileText', () => [
        ...PAPER_PRESETS.map(([label, code, detail]) => pageSetupItem(label, { paperSize: code }, p => (p.paperSize ?? 1) === code, { hint: detail })),
        { separator: true }, { label: 'More Paper Sizes…', cmd: 'print', icon: 'sliders' }])),
      large(pageMenu('Print Area', 'printArea', () => [
        { label: 'Set Print Area', cmd: 'printArea', arg: 'set' },
        { label: 'Add to Print Area', cmd: 'printArea', arg: 'add' },
        { label: 'Clear Print Area', cmd: 'printArea', arg: 'clear' }])),
      large(pageMenu('Breaks', 'breaks', ctx => {
        const p = printSettingsOf(ctx) || {};
        const any = !!(p.rowBreaks?.length || p.colBreaks?.length);
        return [
          { label: 'Insert Page Break', icon: 'breaks', cmd: 'pageBreak', arg: 'insert', hint: 'Above and left of the selected cell' },
          { label: 'Remove Page Break', cmd: 'pageBreak', arg: 'remove' },
          { label: 'Reset All Page Breaks', cmd: 'pageBreak', arg: 'reset', disabled: !any },
          { separator: true },
          { label: 'Page Break Preview', icon: 'pageBreak', cmd: 'viewMode', arg: 'pageBreak' },
        ];
      })),
      large(dyn('Background', 'background', (menus, ctx) => {
        const has = !!ctx.wb.sheet(ctx.sheetId())?.background, editing = !!ctx.flags?.()?.editing;
        return [
          { label: has ? 'Replace Background…' : 'Background Picture…', icon: 'background', cmd: 'sheetBackground', arg: 'pick', disabled: editing },
          { label: 'Delete Background', icon: 'deleteItem', cmd: 'sheetBackground', arg: 'delete', disabled: editing || !has },
        ];
      }, { ariaLabel: 'Sheet Background' })),
      a('Print Titles', 'printTitles', 'print', null, { ariaLabel: 'Print Titles' }), c('Page Setup', 'pageSetup', 'print'), c('Export PDF', 'fileDown', 'exportPdf')],
    ['Scale to Fit', fitChoices('fitWidth', 'Width'), fitChoices('fitHeight', 'Height'), scaleChoices],
    ['Sheet Options', c('Gridlines', 'gridlines', 'gridlines'), printOption('Print Gridlines', 'gridlines', 'printGridlines'), c('Headings', 'headings', 'toggleHeaders'), printOption('Print Headings', 'headings', 'printHeadings')],
    arrangeGroup(),
  ],
  Formulas: [
    ['Function Library', large({ ...c('Insert Function', 'fx', 'functionMenu'), ariaLabel: 'Insert function' }),
      large(split(c('AutoSum', 'autosum', 'autosum'), () => autoSumMenu())), recentFunctions,
      category('Financial', 'financial'), category('Logical', 'logical'), category('Text', 'text'),
      category('Date & Time', 'dateTime'), category('Lookup & Reference', 'lookup'), category('Math & Trig', 'mathTrig'), moreFunctions],
    ['Defined Names', large(c('Name Manager', 'nameManager', 'names')), c('Define Name', 'defineName', 'defineName'), useInFormula, c('Create from Selection', 'createNames', 'createNames')],
    ['Formula Auditing', c('Trace Precedents', 'precedents', 'trace', 'precedents'), c('Trace Dependents', 'dependents', 'trace', 'dependents'),
      c('Remove Arrows', 'clearTrace', 'clearTrace'), c('Show Formulas', 'showFormulas', 'showFormulas'), split(a('Error Checking', 'errorCheck', 'selectSpecial', 'errors', { ariaLabel: 'Error Checking' }), () => [
        { label: 'Error Checking…', icon: 'errorCheck', cmd: 'selectSpecial', arg: 'errors' },
        { label: 'Trace Error', icon: 'precedents', cmd: 'trace', arg: 'precedents' },
        { separator: true },
        { label: 'Error Checking Options…', cmd: 'errorCheckingOptions' },
      ]),
      c('Evaluate Formula', 'evaluate', 'evaluateFormula'), direct('Watch Window', 'watch', 'watchWindow', null)],
    ['Calculation', large(dyn('Calculation Options', 'calculator', (menus, ctx) => {
      const mode = ctx.wb.calcMode || 'automatic', editing = !!ctx.flags?.()?.editing;
      return [
        { label: 'Automatic', cmd: 'calcMode', arg: 'automatic', radio: true, checked: mode === 'automatic', disabled: editing },
        { label: 'Automatic Except for Data Tables', cmd: 'calcMode', arg: 'automatic', radio: true, checked: false, disabled: editing, hint: 'There are no data tables to leave out, so this calculates as Automatic does' },
        { label: 'Manual', cmd: 'calcMode', arg: 'manual', radio: true, checked: mode === 'manual', disabled: editing },
      ];
    }, { ariaLabel: 'Calculation Options' })),
      c('Calculate Now', 'calcNow', 'recalc'), a('Calculate Sheet', 'calcSheet', 'recalc', 'sheet', { ariaLabel: 'Calculate Sheet', shortcut: 'Shift+F9' }), c('Formulas to Values', 'toValues', 'toValues')],
  ],
  Data: [
    ['Get & Transform Data', large(getDataMenu), direct('From Text/CSV', 'fromText', 'getDataText', null), direct('From Web', 'fromWeb', 'getDataWeb', null),
      direct('From Table/Range', 'fromTable', 'getDataTable', null)],
    ['Queries & Connections', large(split(direct('Refresh All', 'refresh', 'refreshAll', null), refreshMenu)),
      direct('Queries & Connections', 'queriesPane', 'queriesPane', null, { isChecked: ctx => !!ctx.flags?.()?.queriesPane }), c('Edit Links', 'editLinks', 'editLinks')],
    ['Sort & Filter', c('Sort A to Z', 'sortAsc', 'sort', 'asc'), c('Sort Z to A', 'sortDesc', 'sort', 'desc'), large(c('Sort', 'sortCustom', 'sortDialog')), large(c('Filter', 'filter', 'filter')),
      direct('Clear', 'filterClear', 'clearFilters', null, { ariaLabel: 'Clear filter' }), direct('Reapply', 'filterReapply', 'reapplyFilters', null), direct('Advanced', 'filterAdvanced', 'advancedFilter', null, { ariaLabel: 'Advanced filter' })],
    ['Data Tools', c('Text to Columns', 'textToColumns', 'splitTextDialog'), direct('Flash Fill', 'flashFill', 'flashFill', null, { shortcut: `${MOD_KEY}+E` }), c('Remove Duplicates', 'dedupe', 'dedupe'),
      split(c('Data Validation', 'validation', 'validation'), () => [
        { label: 'Data Validation…', icon: 'validation', cmd: 'validation' },
        { label: 'Circle Invalid Data', icon: 'validation', cmd: 'circleInvalid' },
        { label: 'Clear Validation Circles', cmd: 'clearCircles' },
      ]), direct('Consolidate', 'consolidate', 'consolidate', null), c('Form', 'dataForm', 'dataForm'), m('Data Cleanup', 'clearFormat', 'data', 'Data cleanup')],
    ['Forecast', large(dyn('What-If Analysis', 'whatIf', menus => [command('goalSeek')(menus) && { ...command('goalSeek')(menus), label: 'Goal Seek…' },
      command('scenarioManager')(menus) && { ...command('scenarioManager')(menus), label: 'Scenario Manager…' }, command('dataTable')(menus) && { ...command('dataTable')(menus), label: 'Data Table…' }].filter(Boolean))),
      c('Goal Seek', 'goalSeek', 'goalSeek'), large(direct('Forecast Sheet', 'forecast', 'forecastSheet', null)), c('Column Stats', 'columnStats', 'columnStats')],
    ['Analyze', large(c('Data Analysis', 'dataAnalysis', 'dataAnalysis')), large(c('Solver', 'solver', 'solver'))],
    ['Outline', m('Group', 'group', 'view', 'Group'), a('Ungroup Rows', 'ungroup', 'ungroup', 'row', { ariaLabel: 'Ungroup Rows' }), c('Subtotal', 'subtotal', 'subtotal'),
      direct('Show Detail', 'showDetail', 'showDetail', null), direct('Hide Detail', 'hideDetail', 'hideDetail', null),
      c('Auto Outline', 'autoOutline', 'autoOutline'), c('Clear Outline', 'clearOutline', 'clearOutline'), c('Outline Settings', 'outlineSettings', 'outlineSettings')],
  ],
  Review: [
    ['Proofing', large(c('Spelling', 'spellCheck', 'spelling')), c('Thesaurus', 'thesaurus', 'thesaurus'), c('Spelling as You Type', 'spell', 'toggleSpellcheck'),
      c('AutoCorrect Options', 'autoCorrect', 'autoCorrectOptions'), a('Workbook Statistics', 'stats', 'docInfo', null, { ariaLabel: 'Workbook Statistics' })],
    ['Language', large(c('Translate', 'translate', 'translatePane'))],
    ['Accessibility', large(direct('Check Accessibility', 'accessibility', 'accessibility', null))],
    ['Comments', large(threadCmd('New Comment', 'comment', 'newComment', { shortcut: NEW_COMMENT_KEY })), threadCmd('Delete', 'deleteComment', 'deleteComment', { ariaLabel: 'Delete Comment', needs: 'hasComments' }),
      threadCmd('Previous Comment', 'prevComment', 'prevComment', { needs: 'hasComments' }), threadCmd('Next Comment', 'nextComment', 'nextComment', { needs: 'hasComments' }),
      large(threadCmd('Show Comments', 'showComments', 'toggleComments', { toggle: true }))],
    ['Notes', large(c('Note', 'note', 'note')), c('Delete Note', 'deleteNote', 'deleteNote'), a('Notes on This Sheet', 'notes', 'selectSpecial', 'notes', { ariaLabel: 'Select notes on this sheet' })],
    ['Changes', large(direct('Show Changes', 'showChanges', 'showChanges', null, { isChecked: ctx => !!ctx.flags?.()?.changesPane }))],
    ['Protection', large(c('Protect Sheet', 'protectSheet', 'protectSheet')), direct('Protect Workbook', 'protectBook', 'protectWorkbook', null, { isChecked: ctx => !!ctx.wb.structureProtected }), c('Protected Ranges', 'protectRanges', 'protectRanges')],
    ['Collaboration', c('Share', 'share', 'share'), c('Send a Copy', 'sendCopy', 'sendCopy'), c('Version History', 'versions', 'versions')],
  ],
  View: [
    ['Workbook Views', large(direct('Normal', 'normalView', 'viewMode', 'normal', { ariaLabel: 'Normal view', isChecked: ctx => (ctx.viewMode?.() || 'normal') === 'normal' })),
      large(direct('Page Break Preview', 'pageBreak', 'viewMode', 'pageBreak', { isChecked: ctx => ctx.viewMode?.() === 'pageBreak' })),
      large(direct('Page Layout', 'pageLayout', 'viewMode', 'pageLayout', { ariaLabel: 'Page Layout view', isChecked: ctx => ctx.viewMode?.() === 'pageLayout' })),
      large(c('Custom Views', 'customViews', 'customViews'))],
    ['Sheet View', large(dyn('Sheet View', 'sheetView', (menus, ctx) => {
      const f = ctx.flags?.() || {}, sheet = ctx.wb.sheet(ctx.sheetId()), off = !!f.editing || !!f.chartSheet;
      const views = (sheet?.sheetViews || []).filter((v) => !v.temporary || v.id === f.sheetView?.id);
      return [
        { label: 'Default', cmd: 'sheetView', arg: { action: 'switch', id: null }, radio: true, checked: !f.sheetView, disabled: off },
        ...views.map((v) => ({ label: v.name, cmd: 'sheetView', arg: { action: 'switch', id: v.id }, radio: true, checked: f.sheetView?.id === v.id, disabled: off })),
        { separator: true },
        { label: 'New', icon: 'sheetView', cmd: 'sheetView', arg: 'new', disabled: off },
        { label: 'Keep…', cmd: 'sheetView', arg: 'keep', disabled: off || !f.sheetView?.temporary },
        { label: 'Exit', cmd: 'sheetView', arg: 'exit', disabled: off || !f.sheetView },
        { label: 'Options…', icon: 'sliders', cmd: 'sheetView', arg: 'options', disabled: off },
      ];
    }, { ariaLabel: 'Sheet View' })),
      sheetViewButton('New', 'filePlus', 'new', () => false), sheetViewButton('Keep', 'save', 'keep', f => !f.sheetView || !f.sheetView.temporary),
      sheetViewButton('Exit', 'exitView', 'exit', f => !f.sheetView), sheetViewButton('Options', 'sliders', 'options', () => false)],
    ['Show', c('Gridlines', 'gridlines', 'gridlines'), c('Formula Bar', 'fx', 'formulaBar'), c('Headings', 'headings', 'toggleHeaders'), c('Show Zeros', 'number', 'zeros'), c('Show Formulas', 'showFormulas', 'showFormulas'),
      c('Page Breaks', 'pageBreak', 'showPageBreaks')],
    ['Zoom', large(c('Zoom', 'zoomIn', 'zoomCustom')), large(c('100%', 'zoom100', 'zoom', 'reset')), large(direct('Zoom to Selection', 'zoomSelection', 'zoomSelection', null))],
    ['Window', large(m('Freeze Panes', 'freeze', 'view', 'Freeze')), c('Split', 'split', 'split'),
      m('Hide & Unhide', 'hideEye', 'view', 'Hide and unhide'), c('Focus Mode', 'focus', 'focusMode'), c('Full Screen', 'fullscreen', 'fullscreen')],
    ['Assistant', c('AI Assistant', 'sparkle', 'aiPanel')],
  ],
  // Scripts (ui/automate.js): record, write, browse and run them; the samples run in one click, undone in one.
  Automate: [
    ['Scripting Tools', large(direct('Record Actions', 'recordActions', 'recordActions', null, { isChecked: ctx => !!ctx.flags?.()?.recording })),
      large(direct('New Script', 'newScript', 'newScript', null)),
      large(direct('All Scripts', 'allScripts', 'scriptGallery', null)),
      large(direct('Code Editor', 'codeEditor', 'scriptsPane', null, { isChecked: ctx => !!ctx.flags?.()?.scriptsPane })),
      large(dyn('Run Script', 'runScript', (menus, ctx) => ctx.automate?.menuItems?.() || [], { ariaLabel: 'Run a script' }))],
    ['Controls', large(dyn('Script Button', 'scriptButton', (menus, ctx) => ctx.automate?.buttonItems?.() || [], { ariaLabel: 'Insert a button that runs a script' }))],
    ['Sample Scripts', ...SAMPLE_BUTTONS.map(([id, label, glyph]) => direct(label, glyph, 'runScript', { sample: id }, { ariaLabel: `Run the ${label} sample script` }))],
    ['Help', large(direct('Script Reference', 'scriptReference', 'scriptReference', null))],
  ],
}[name] || []);
/** The sample scripts on the Automate tab, each run by its button. */
const SAMPLE_BUTTONS = [
  ['highlight-duplicates', 'Highlight Duplicates', 'highlightDuplicates'], ['unhide-everything', 'Unhide Everything', 'unhideAll'],
  ['sum-each-column', 'Sum Each Column', 'sumColumns'], ['table-of-contents', 'Table of Contents', 'tableOfContents'],
  ['header-row', 'Style Header Row', 'styleHeaderRow'], ['remove-blank-rows', 'Remove Blank Rows', 'removeBlankRows'],
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
  const tabs = el('div.ribbon-tabs', { role: 'tablist', 'aria-label': 'Ribbon' });
  const names = [...RIBBON_TABS, 'Table', 'Chart Design', 'Format', 'SmartArt Design', 'SmartArt Format', 'Picture Format'];
  const CHART_TABS = ['Chart Design', 'Format'];
  // A selected SmartArt graphic offers its own two tabs; the second is called Format, as a chart's is.
  const SMARTART_TABS = ['SmartArt Design', 'SmartArt Format'];
  // A selected picture offers Picture Format, as a selected chart offers its two tabs.
  const PICTURE_TABS = ['Picture Format'];
  const tabLabel = name => (name === 'SmartArt Format' ? 'Format' : name);
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
  const makeButton = descriptor => {
    if (descriptor.split) {
      const face = makeButton({ ...descriptor, split: null });
      const arrow = makeButton({ label: `${descriptor.label} options`, glyph: 'chevD', ariaLabel: `${descriptor.label} options`, arrow: true,
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
        else if (item.cmd) ctx.run(item.cmd, MENU_COMMANDS.has(item.cmd) ? button : item.arg);
      },
    }, descriptor.arrow ? null : el('span.ribbon-button-label', {}, descriptor.label));
    if (descriptor.large) button.classList.add('ribbon-large');
    if (descriptor.arrow) button.classList.add('ribbon-split-arrow');
    if (descriptor.look) {
      button.classList.add('ribbon-table-style');
      button.querySelector('.ribbon-button-label').textContent = descriptor.label.replace(' table style', '');
      button.querySelector('svg')?.remove();
      button.prepend(el('span.ribbon-table-sample', { 'aria-hidden': 'true', style: { '--table-head': descriptor.look.header, '--table-band': descriptor.look.band } },
        ...Array.from({ length: 12 }, (_, i) => el('span', { dataset: { row: Math.floor(i / 3) } }))));
    }
    dynamic.push({ button, descriptor });
    return button;
  };
  const extras = {
    clipboard: [large(split(c('Paste', 'paste', 'paste'), (menus, context) => pasteGalleryItems({ disabled: !!context?.flags?.()?.editing }))),
      c('Cut', 'cut', 'cut'), c('Copy', 'copy', 'copy')].map(makeButton),
    styles: [large({ ...direct('Format as Table', 'formatTable', 'formatAsTableMenu', null), ariaLabel: 'Format as Table' })].map(makeButton),
    cells: [insertMenu, deleteMenu, formatMenu].map(makeButton),
    editing: [split(c('AutoSum', 'autosum', 'autosum'), () => autoSumMenu()), m('Fill', 'fillDown', 'edit', 'Fill'), clearMenu, large(findAndSelect)].map(makeButton),
  };
  const toolbar = createToolbar(ctx, { ribbon: true, ribbonExtras: extras });
  toolbar.el.classList.remove('toolbar');
  const tableNameError = el('span.ribbon-table-error', { id: `${id}-table-error`, role: 'alert', hidden: true });
  const tableName = el('input.input.ribbon-table-name.ribbon-control', {
    type: 'text', 'aria-label': 'Table Name', 'aria-describedby': tableNameError.id,
    title: 'Rename the table with Enter; Escape cancels', spellcheck: false, autocomplete: 'off', tabindex: -1,
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
  /** A tab and its (empty) panel; `name` is the tab's id, a built-in tab's name or a custom tab's id. */
  function makeTab(name, text = name) {
    const panelId = `${id}-${name.replaceAll(' ', '-').toLowerCase()}`;
    const tab = el('button.ribbon-tab', {
      type: 'button', role: 'tab', id: `${panelId}-tab`, 'aria-controls': panelId,
      'aria-selected': String(name === active), tabindex: name === active ? 0 : -1,
      ...(name === 'SmartArt Format' ? { 'aria-label': 'SmartArt Format' } : {}),
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
    }, text === name ? tabLabel(name) : text);
    const panel = el('div.ribbon-panel', { id: panelId, role: 'tabpanel', 'aria-labelledby': tab.id, hidden: name !== active });
    return { tab, panel };
  }
  /** A panel's row of groups, moved along by the arrows; Escape goes back up to the tab. */
  function makeTools(name, panel, tab) {
    const tools = el('div.ribbon-panel-tools', { role: 'toolbar', 'aria-label': `${name} commands` });
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
    if (name === 'Home') {
      panel.append(toolbar.el);
      // Escape from a Home command goes back up to the Home tab, as it does from every other tab's commands.
      toolbar.el.addEventListener('keydown', e => {
        if (e.key !== 'Escape' || isComposing(e) || e.altKey || e.ctrlKey || e.metaKey || !e.target.matches?.('.tb-btn')) return;
        e.preventDefault(); tab.focus();
      });
    } else {
      const tools = makeTools(name, panel, tab);
      for (const [label, ...descriptors] of groupsFor(name)) {
        // A control built in place (a field, a picker) refreshes with the ribbon through its own `refresh`.
        const controls = el('div.ribbon-group-controls', {}, ...descriptors.map(d => (d.element ? (built => { builtControls.push(built); return built; })(d.element(ctx)) : makeButton(d))));
        if (name === 'Table' && label === 'Properties') controls.classList.add('ribbon-table-properties');
        if (name === 'Table' && label === 'Properties') controls.prepend(el('label.ribbon-table-name-field', {}, el('span', {}, 'Table Name:'), tableName));
        if (name === 'Table' && label === 'Table Styles') controls.classList.add('ribbon-table-gallery');
        // Each sheet option stands over its print counterpart: Gridlines over Print gridlines, Headings over Print headings.
        if (name === 'Page Layout' && label === 'Sheet Options') controls.classList.add('ribbon-two-rows');
        tools.append(el('div.ribbon-group', { role: 'group', 'aria-label': label }, controls, el('span.ribbon-group-label', {}, label)));
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
  const scrollLeft = scrollButton(-1, 'Scroll ribbon left', 'chevL');
  const scrollRight = scrollButton(1, 'Scroll ribbon right', 'chevR');
  const scrollControls = el('div.ribbon-scroll-controls', { role: 'group', 'aria-label': 'Scroll ribbon commands', hidden: true }, scrollLeft, scrollRight);
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
        // The menus word it in sentence case; the ribbon names commands in title case.
        const label = item.label.replace(/ sheet$/, ' Sheet');
        const span = button.querySelector('.ribbon-button-label');
        if (button.classList.contains('ribbon-large')) twoLineLabel(span, label); else span.textContent = label;
        button.setAttribute('aria-label', label);
      }
      button.disabled = descriptor.unsupported || !item || !!item.disabled || (button.closest('[data-table-panel]') && (!!flags.editing || !!flags.sheet?.protected));
      button.title = descriptor.unsupported ? descriptor.reason || `${descriptor.label}: not supported yet` : !item ? `${descriptor.label}: unavailable in this session`
        : item.disabled && item.hint ? `${descriptor.label}: ${item.hint}` : `${descriptor.label}${item.shortcut ? ` (${item.shortcut})` : ''}`;
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
    toggle.setAttribute('aria-label', collapsed ? 'Expand ribbon' : 'Collapse ribbon');
    toggle.title = `${collapsed ? 'Expand' : 'Collapse'} ribbon (double-click a tab)`;
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
        return { label, cmd, arg, disabled: !!f.editing || grouped, hint: grouped ? GROUP_BLOCKED_HINT : undefined };
      } };
  };
  function customGroup(g, catalog) {
    const made = g.commands.map(cid => makeButton(customDescriptor(cid, catalog.find(e => e.id === cid))));
    for (const b of made) customButtons.add(b);
    return el('div.ribbon-group.ribbon-custom-group', { role: 'group', 'aria-label': g.name, dataset: { customGroup: g.id } },
      el('div.ribbon-group-controls', {}, ...(made.length ? made : [el('span.ribbon-group-empty', {}, 'No commands yet')])),
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
    for (const t of layout.tabs) {
      const { tab, panel } = makeTab(t.id, t.name);
      tab.classList.add('ribbon-custom-tab');
      makeTools(t.name, panel, tab);
      customTabs.add(t.id);
      names.push(t.id); buttons.push(tab); panels.push(panel);
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
    for (const t of order) {
      const at = names.indexOf(t.id);
      if (at < 0) continue;
      if (t.builtin) buttons[at].textContent = t.name;
      tabs.append(buttons[at]);
    }
    for (const name of CONTEXT_TABS) tabs.append(buttons[names.indexOf(name)]);
    userHidden = new Set(order.filter(t => t.hidden).map(t => t.id));
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
    openMenu({ anchor: target, label: 'Ribbon', minWidth: 250,
      items: ribbonButtonMenuItems(ctx, commandOf, { collapsed, toggleCollapsed: () => setCollapsed(!collapsed) }),
      onClose: reason => { if (reason === 'select') ctx.grid?.focus?.(); } });
  });

  const unsubscribe = ctx.subscribe(refresh);
  const unsubscribeLayout = ribbonLayoutStore.subscribe(layout => applyLayout(layout));
  applyLayout();
  for (const span of root.querySelectorAll('.ribbon-large .ribbon-button-label')) twoLineLabel(span, span.textContent);
  return { el: root, refresh, select, applyLayout, toggleCollapsed() { setCollapsed(!collapsed); }, destroy() { observer?.disconnect(); unsubscribe(); unsubscribeLayout(); toolbar.destroy(); } };
}
