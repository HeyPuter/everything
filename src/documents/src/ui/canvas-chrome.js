import { el, isComposing, MOD_KEY } from './dom.js';
import { iconEl } from './icons.js';
import { openMenu, closeMenu } from './menu.js';
import { openShortcuts } from './shortcuts.js';
import { createRibbon, large, small, split, command, rows, divider, commandIconEl, setControlIcon } from './ribbon.js';
import { openListLibrary } from './list-library-menu.js';
import { recallUnit } from '../lib/units.js';
import { classicMenus } from '../views/classic-menus.js';
import { createTitleBar } from '../views/title-bar.js';
import { ribbonEntries, menuEntries } from './command-index.js';
import { createRibbonModes } from './ribbon-modes.js';

// Keep the user's pane and tab choices when opening another document in this tab.
let expandedTools = false;
let pageToolsExpanded = false;
let rememberedTab = 'home';

/**
 * The editor's chrome in a desktop word-processor layout: a title bar with quick-access commands, a
 * row of ribbon tabs over a card of command groups, and a formatting pane for the rarer settings.
 * It arranges the editor's own controls (their state and handlers stay in the editor view) and adds
 * ribbon commands that call the editor's actions.
 */
export function createCanvasChrome({ title, status, account, local, controls: c, actions: a, commands: w = {}, focusEditor, rulers }) {
  const field = (label, control) => el('label.canvas-tool-field', {}, el('span', {}, label), control);
  const section = (label, ...items) => el('section.canvas-advanced-section', { 'aria-label': label },
    el('h2', {}, label), el('div.canvas-advanced-controls', {}, ...items));

  /* ---- Formatting pane: the settings of the Font, Paragraph and Style dialogs ---- */
  const textSection = section('Text', field('Character style', c.characterStyle), c.editCharacterStyle, c.newCharacterStyle,
    c.caps, c.smallCaps, c.doubleStrike, c.baselineShift, c.characterSpacing, c.textWidth, c.kerning);
  // With the Paragraph and Borders and Shading dialogs on the ribbon, the older direct editors stay here.
  const paragraphSection = section('Paragraph', field('Paragraph style', c.paragraphStyle), c.editStyle, c.newStyle, c.clearParagraphFormatting,
    field('Line spacing', c.lineSpacing), c.lineSpacingOptions, c.restart, ...(w.paragraphDialog ? [c.paragraphGeometry, c.paragraphBorders] : []));
  const tableSection = section('Table', field('Rows & columns', c.tableActions));
  const pageSection = el('details.canvas-inspector-details', { open: pageToolsExpanded, ontoggle: () => { pageToolsExpanded = pageSection.open; } }, el('summary', {}, 'Page & document'),
    section('Page & document settings', c.pageBreakBefore, c.insertTab, ...c.paginationTools, field('Outline level', c.outlineLevel), c.unlink));
  const heading = el('h2', {}, 'Paragraph formatting');
  const pane = el('aside.canvas-advanced.canvas-inspector', { id: 'canvas-advanced-tools', 'aria-label': 'Formatting Pane', hidden: !expandedTools },
    el('div.canvas-panel-heading', {}, heading, el('button.icon-btn', { type: 'button', 'aria-label': 'Close Formatting Pane', onclick: () => { setExpanded(false); focusEditor(); } }, iconEl('x', 18))),
    el('div.canvas-panel-scroll', {}, tableSection, paragraphSection, textSection, pageSection));
  const more = command('Formatting Pane', 'formattingPane', () => setExpanded(!expandedTools), { size: 'large', text: 'Formatting Pane', attrs: { 'aria-expanded': String(expandedTools), 'aria-controls': pane.id } });
  function setExpanded(value) {
    expandedTools = value;
    pane.hidden = !value;
    more.setAttribute('aria-expanded', String(value));
    paneToggle.setAttribute('aria-pressed', String(value));
    if (value && compact.matches) { a.closeOutline?.(); a.closeFind?.(); }
    refresh();
    if (value) pane.querySelector('button, select')?.focus();
  }
  pane.addEventListener('keydown', e => { if (e.key === 'Escape' && !e.defaultPrevented && !isComposing(e)) { e.preventDefault(); setExpanded(false); focusEditor(); } });
  for (const button of pane.querySelectorAll('button.canvas-tool')) button.append(el('span.inspector-label', {}, button.getAttribute('aria-label')));
  const compact = window.matchMedia('(max-width: 700px)');

  /* ---- Shared building blocks ---- */
  const noFocusSteal = (...buttons) => { for (const b of buttons) b.addEventListener('mousedown', e => e.preventDefault()); };
  // A menu the mouse opened closes back into the document; one the keyboard opened returns to its button.
  const menuButton = (label, icon, items, { size = 'large', text = label } = {}) => {
    const button = command(label, icon, e => openMenu({ anchor: button, label, items: inDocument(items()), minWidth: 220, pointer: !!e?.detail, onClose: e?.detail ? focusEditor : null }),
      { size, text, caret: true, attrs: { 'aria-haspopup': 'menu' } });
    noFocusSteal(button);
    button.menuItems = items; // command search lists what the menu offers
    return button;
  };
  // A command chosen from a ribbon menu acts on the document: the keyboard goes back to it first.
  const inDocument = list => list.map(item => !item ? item
    : item.onSelect ? { ...item, onSelect: () => { focusEditor(); w.noteCommand?.(item.label, item.onSelect); item.onSelect(); } }
    : item.items ? { ...item, items: inDocument(item.items) } : item);
  const engineReady = () => !c.bold.disabled;
  const separator = { separator: true };
  const tableAction = value => () => { c.tableActions.value = value; c.tableActions.dispatchEvent(new Event('change', { bubbles: true })); };
  const tableOption = value => c.tableActions.querySelector(`option[value="${value}"]`);
  const optionItems = (select, filter = () => true) => [...select.options].filter(o => o.value && !o.disabled && filter(o)).map(o => ({
    label: o.textContent, onSelect: () => { select.value = o.value; select.dispatchEvent(new Event('change', { bubbles: true })); } }));
  // Ribbon commands without an editor control follow these predicates on every refresh.
  const states = [];
  const when = (control, enabled, pressed) => { states.push({ control, enabled, pressed }); return control; };

  /* ---- Home ---- */
  const paste = command('Paste', 'paste', () => a.paste?.(), { size: 'large', shortcut: `${MOD_KEY}+V` });
  const pasteSplit = split(paste, { label: 'Paste options', size: 'large', open: (anchor, e) => openMenu({ anchor, label: 'Paste options', pointer: !!e?.detail, onClose: e?.detail ? focusEditor : null, items: inDocument(w.pasteItems?.() || [
    { label: 'Keep Source Formatting', icon: 'paste', shortcut: `${MOD_KEY}+V`, onSelect: () => a.paste?.() },
    { label: 'Keep Text Only', icon: 'pasteText', shortcut: `${MOD_KEY}+Shift+V`, onSelect: () => a.pastePlain?.() }]) }) });
  const cut = command('Cut', 'cut', () => a.cut?.(), { shortcut: `${MOD_KEY}+X` });
  const copy = command('Copy', 'copy', () => a.copy?.(), { shortcut: `${MOD_KEY}+C` });
  const painter = command('Format Painter', 'formatPainter', e => w.formatPainter?.(e), { attrs: { 'aria-pressed': 'false' } });
  noFocusSteal(paste, cut, copy, painter);
  when(paste, () => a.clipboardState?.().paste); when(pasteSplit.arrow, () => a.clipboardState?.().paste);
  when(cut, () => a.clipboardState?.().cut); when(copy, () => a.clipboardState?.().copy);
  when(painter, () => engineReady() && !!w.formatPainter, () => w.formatPainterActive?.() ? 'true' : 'false');

  const grow = command('Increase Font Size', 'fontGrow', () => w.growFont?.(1), { shortcut: `${MOD_KEY}+Shift+.` });
  const shrink = command('Decrease Font Size', 'fontShrink', () => w.growFont?.(-1), { shortcut: `${MOD_KEY}+Shift+,` });
  const changeCase = menuButton('Change Case', 'changeCase', () => [
    ['Sentence case.', 'sentence'], ['lowercase', 'lower'], ['UPPERCASE', 'upper'], ['Capitalize Each Word', 'title'], ['tOGGLE cASE', 'toggle'],
  ].map(([label, mode]) => ({ label, onSelect: () => w.changeCase?.(mode) })), { size: 'small', text: null });
  noFocusSteal(grow, shrink, changeCase);
  for (const control of [grow, shrink]) when(control, engineReady);
  when(changeCase, () => engineReady() && !!w.changeCase);
  small(c.clearTextFormatting, { icon: 'clearFormat' });
  c.clearTextFormatting.setAttribute('aria-label', 'Clear All Formatting');
  c.clearTextFormatting.title = `Clear All Formatting (${MOD_KEY}+Space). Clears direct text formatting and keeps styles and links.`;
  small(c.bold, { icon: 'bold' }); small(c.italic, { icon: 'italic' }); small(c.underline, { icon: 'underline' });
  small(c.strike, { icon: 'strike' }); small(c.subscript, { icon: 'sub' }); small(c.superscript, { icon: 'sup' });
  // The underline options dialog is the underline command's arrow, next to the underline styles.
  c.underlineOptions.className = 'ribbon-split-arrow';
  c.underlineOptions.replaceChildren(el('span.ribbon-caret', { 'aria-hidden': 'true' }));
  const underlineSplit = el('span.ribbon-split.is-small', {}, c.underline, c.underlineOptions);
  for (const [control, name] of [[c.textColor, 'textColor'], [c.highlight, 'highlight']]) {
    control.classList.add('ribbon-small', 'ribbon-color');
    const svg = control.querySelector('.canvas-color-icon > svg');
    svg?.replaceWith(commandIconEl(name, 16));
    control.querySelector(':scope > svg')?.replaceWith(el('span.ribbon-caret', { 'aria-hidden': 'true' }));
  }
  c.fontFamily.classList.add('ribbon-font');
  c.fontSize.classList.add('ribbon-size');
  const textEffects = menuButton('Text Effects', 'textEffects', () => w.textEffectItems?.() || [], { size: 'small', text: null });
  when(textEffects, () => engineReady() && !!w.textEffectItems);
  const fontLauncher = command('Font Settings', 'fontDialog', () => (w.fontDialog ? w.fontDialog() : setExpanded(true)), { shortcut: `${MOD_KEY}+D` });
  when(fontLauncher, engineReady);
  const fontGroup = [rows(
    [c.fontFamily, c.fontSize, grow, shrink, divider(), changeCase, divider(), c.clearTextFormatting],
    [c.bold, c.italic, underlineSplit, c.strike, c.subscript, c.superscript, divider(), textEffects, c.highlight, c.textColor, divider(), fontLauncher])];

  small(c.bullets, { icon: 'bullets' }); small(c.numbers, { icon: 'numbers' });
  // The list buttons' arrows open the bullet and numbering libraries.
  const listSplit = (control, kind) => {
    const wrap = split(control, { label: kind === 'bullet' ? 'Bullet Library' : 'Numbering Library', open: (anchor, e) => openListLibrary({ anchor, kind, current: w.listLibraryIndex?.(kind) ?? -1, extra: inDocument(w.listLibraryExtras?.(kind) || []),
      apply: index => { focusEditor(); w.applyListLibrary?.(kind, index); }, none: () => { focusEditor(); w.removeList?.(kind); }, pointer: !!e?.detail, onClose: e?.detail ? focusEditor : null }) });
    when(wrap.arrow, () => engineReady() && !!w.applyListLibrary && !control.disabled);
    return wrap;
  };
  const bulletSplit = listSplit(c.bullets, 'bullet'), numberSplit = listSplit(c.numbers, 'number');
  const multilevel = menuButton('Multilevel List', 'multilevel', () => [{ header: 'List Library' }, ...(w.multilevelItems?.() || [])], { size: 'small', text: null });
  when(multilevel, () => engineReady() && !!w.multilevelItems);
  small(c.outdent, { icon: 'outdent' }); small(c.indent, { icon: 'indent' });
  c.outdent.setAttribute('aria-label', 'Decrease Indent'); c.indent.setAttribute('aria-label', 'Increase Indent');
  c.outdent.title = 'Decrease Indent'; c.indent.title = 'Increase Indent';
  const sort = command('Sort', 'sort', () => w.sortParagraphs?.());
  const marks = command('Show Formatting Marks', 'pilcrow', () => w.toggleMarks?.(), { shortcut: `${MOD_KEY}+8`, attrs: { 'aria-pressed': 'false' } });
  noFocusSteal(sort, marks, multilevel);
  when(sort, () => engineReady() && !!w.sortParagraphs);
  when(marks, () => !!w.toggleMarks && !!a.hasDocument?.(), () => w.marksVisible?.() ? 'true' : 'false');
  const [alignLeft, alignCenter, alignRight, justify] = c.alignmentButtons;
  for (const [control, name] of [[alignLeft, 'alignLeft'], [alignCenter, 'alignCenter'], [alignRight, 'alignRight'], [justify, 'alignJustify']]) small(control, { icon: name });
  small(c.lineSpacingMenu, { icon: 'lineSpacing' });
  c.lineSpacingMenu.setAttribute('aria-label', 'Line and Paragraph Spacing'); c.lineSpacingMenu.title = 'Line and Paragraph Spacing';
  c.lineSpacingMenu.append(el('span.ribbon-caret', { 'aria-hidden': 'true' }));
  small(c.paragraphShading, { icon: 'shading' });
  // Borders: the last border choice, with the border presets and Borders and Shading on its arrow.
  let bordersControl = c.paragraphBorders;
  if (w.paragraphBorderItems) {
    const main = command('Borders', 'borders', () => w.applyLastBorder?.());
    noFocusSteal(main); when(main, engineReady);
    bordersControl = split(main, { label: 'Border options', open: (anchor, e) => openMenu({ anchor, label: 'Borders', pointer: !!e?.detail, onClose: e?.detail ? focusEditor : null, items: inDocument(w.paragraphBorderItems()) }) });
    when(bordersControl.arrow, engineReady);
  } else small(c.paragraphBorders, { icon: 'borders' });
  const paragraphLauncher = w.paragraphDialog ? command('Paragraph Settings', 'paragraphDialog', () => w.paragraphDialog(), { shortcut: MOD_KEY === 'Cmd' ? 'Cmd+Option+M' : null }) : small(c.paragraphGeometry, { icon: 'paragraphDialog' });
  if (w.paragraphDialog) { noFocusSteal(paragraphLauncher); when(paragraphLauncher, () => !!a.hasDocument?.()); }
  const paragraphGroup = [rows(
    [bulletSplit, numberSplit, multilevel, divider(), c.outdent, c.indent, divider(), sort, divider(), marks],
    [alignLeft, alignCenter, alignRight, justify, divider(), c.lineSpacingMenu, divider(), c.paragraphShading, bordersControl, divider(), paragraphLauncher])];

  // The quick style gallery shows the document's paragraph styles in their own formatting.
  const gallery = el('div.ribbon-gallery', { role: 'listbox', 'aria-label': 'Styles', 'aria-orientation': 'horizontal', dataset: { shrinkMin: '1', shrinkMax: '620' } });
  const galleryMore = command('More Styles', 'more', e => {
    if (c.paragraphStyle.disabled) return;
    openMenu({ anchor: galleryMore, label: 'Styles', minWidth: 240, pointer: !!e?.detail, onClose: focusEditor, items: inDocument([
      ...optionItems(c.paragraphStyle).map(item => ({ ...item, radio: true, checked: c.paragraphStyle.value === [...c.paragraphStyle.options].find(o => o.textContent === item.label)?.value })),
      separator, { label: 'Create a Style…', icon: 'newStyle', disabled: c.newStyle.disabled, onSelect: () => c.newStyle.click() },
      { label: 'Modify Style…', icon: 'editStyle', disabled: c.editStyle.disabled, onSelect: () => c.editStyle.click() },
      { label: 'Clear Formatting', icon: 'clearFormat', disabled: c.clearParagraphFormatting.disabled, onSelect: () => c.clearParagraphFormatting.click() }]) });
  });
  galleryMore.classList.add('ribbon-gallery-more');
  noFocusSteal(galleryMore);
  let gallerySignature = '';
  function refreshGallery() {
    const options = [...c.paragraphStyle.options].filter(o => o.value && o.value !== '__mixed' && !o.disabled);
    const preferred = ['normal', 'no spacing', 'heading 1', 'heading 2', 'heading 3', 'title', 'subtitle', 'quote', 'list paragraph'];
    const ranked = [...options].sort((x, y) => {
      const ix = preferred.indexOf(x.textContent.toLowerCase()), iy = preferred.indexOf(y.textContent.toLowerCase());
      return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy);
    }).slice(0, 8);
    // A style's look is part of the signature, so modifying a style redraws its sample.
    const looks = ranked.map(option => w.stylePreview?.(option.value) || {});
    const signature = JSON.stringify([ranked.map(o => [o.value, o.textContent]), looks, c.paragraphStyle.value, c.paragraphStyle.disabled]);
    if (signature === gallerySignature) return;
    const count = gallery.children.length;
    gallerySignature = signature;
    gallery.replaceChildren(...ranked.map((option, index) => {
      const look = looks[index];
      const item = el('button.ribbon-style', { type: 'button', role: 'option', 'aria-selected': String(c.paragraphStyle.value === option.value), disabled: c.paragraphStyle.disabled,
        title: option.textContent, onclick: () => { c.paragraphStyle.value = option.value; c.paragraphStyle.dispatchEvent(new Event('change', { bubbles: true })); },
        oncontextmenu: e => { e.preventDefault(); openMenu({ anchor: item, x: e.clientX, y: e.clientY, label: option.textContent, onClose: focusEditor, items: inDocument([
          { label: 'Apply', onSelect: () => item.click() }, { label: 'Modify…', icon: 'editStyle', onSelect: () => { item.click(); queueMicrotask(() => c.editStyle.click()); } }]) }); } },
      el('span.ribbon-style-sample', { 'aria-hidden': 'true', style: { fontFamily: look.fontFamily || '', fontWeight: look.bold ? '700' : '', fontStyle: look.italic ? 'italic' : '', color: look.color || '', fontSize: look.size ? `${Math.max(10, Math.min(14, look.size * 0.8))}px` : '' } }, 'AaBbCcDdEe'),
      el('span.ribbon-style-name', {}, option.textContent));
      item.addEventListener('mousedown', e => e.preventDefault());
      return item;
    }));
    // The ribbon sizes the gallery to whole items: refit when the number of styles changes.
    if (gallery.children.length !== count) queueMicrotask(() => ribbon?.fit());
  }
  const styleGroup = [el('div.ribbon-gallery-frame', {}, gallery, galleryMore), ...(w.styleGroupItems?.({ command, when }) || []), more];

  // Find searches from the Navigation pane; its menu also offers the Find and Replace panel and Go To.
  const findButton = command('Find', 'find', () => a.openSearch?.(), { text: 'Find', shortcut: `${MOD_KEY}+F` });
  const findSplit = split(findButton, { label: 'Find options', open: (anchor, e) => openMenu({ anchor, label: 'Find options', pointer: !!e?.detail, onClose: e?.detail ? focusEditor : null, items: inDocument([
    { label: 'Find', icon: 'search', shortcut: `${MOD_KEY}+F`, onSelect: () => a.openSearch?.() },
    { label: 'Advanced Find…', onSelect: () => (w.advancedFind ? w.advancedFind() : c.find.click()) },
    { label: 'Go To…', shortcut: MOD_KEY === 'Cmd' ? 'Cmd+Option+G' : 'Ctrl+G', onSelect: () => w.goTo?.() }]) }) });
  noFocusSteal(findButton);
  when(findButton, () => !c.find.disabled); when(findSplit.arrow, () => !c.find.disabled);
  const replace = command('Replace', 'replace', () => w.openReplace?.(), { text: 'Replace', shortcut: MOD_KEY === 'Cmd' ? 'Cmd+Shift+H' : 'Ctrl+H' });
  const selectMenu = menuButton('Select', 'select', () => [
    { label: 'Select All', shortcut: `${MOD_KEY}+A`, icon: 'selectAll', onSelect: a.selectAll }, ...(w.selectItems?.() || [])], { size: 'small', text: 'Select' });
  noFocusSteal(replace);
  when(replace, () => !c.find.disabled); when(selectMenu, engineReady);
  const editingGroup = [rows([findSplit], [replace], [selectMenu])];

  const home = { id: 'home', label: 'Home', groups: [
    { id: 'clipboard', label: 'Clipboard', icon: 'paste', priority: 7, items: [pasteSplit, rows([cut], [copy], [painter])] },
    { id: 'font', label: 'Font', icon: 'fontDialog', priority: 9, items: fontGroup },
    { id: 'paragraph', label: 'Paragraph', icon: 'paragraphDialog', priority: 8, items: paragraphGroup },
    { id: 'styles', label: 'Styles', icon: 'stylesPane', priority: 6, items: styleGroup },
    { id: 'editing', label: 'Editing', icon: 'find', priority: 2, items: editingGroup },
  ] };

  /* ---- Insert ---- */
  const coverPage = menuButton('Cover Page', 'coverPage', () => w.coverPageItems?.() || [], { text: 'Cover Page' });
  when(coverPage, () => engineReady() && !!w.coverPageItems);
  const blankPage = command('Blank Page', 'blankPage', () => w.insertBlankPage?.(), { size: 'large' });
  when(blankPage, () => !c.pageBreak.disabled);
  large(c.pageBreak, { label: 'Page Break', icon: 'pageBreak' });
  large(c.insertTable, { label: 'Table', icon: 'table', caret: true });
  large(c.insertImage, { label: 'Pictures', icon: 'pictures' });
  const shapesButton = command('Shapes', 'shapes', e => w.openShapes?.(shapesButton, e), { size: 'large', caret: true, attrs: { 'aria-haspopup': 'menu' } });
  noFocusSteal(shapesButton);
  when(shapesButton, () => engineReady() && !!w.openShapes);
  large(c.hyperlink, { label: 'Link', icon: 'link' });
  large(c.bookmarks, { label: 'Bookmark', icon: 'bookmark' });
  const headerButton = command('Header', 'header', () => w.editHeader?.('header'), { size: 'large' });
  const footerButton = command('Footer', 'footer', () => w.editHeader?.('footer'), { size: 'large' });
  const pageNumber = command('Page Number', 'pageNumber', e => w.insertPageNumber?.(e, pageNumber), { size: 'large', caret: true, attrs: { 'aria-haspopup': 'menu' } });
  noFocusSteal(pageNumber);
  when(headerButton, () => !!w.canEditHeader?.('header')); when(footerButton, () => !!w.canEditHeader?.('footer'));
  when(pageNumber, () => !!w.canInsertPageNumber?.());
  const textBox = command('Text Box', 'textBox', () => w.insertTextBox?.(), { size: 'large', text: 'Text Box' });
  noFocusSteal(textBox);
  when(textBox, () => engineReady() && !!w.insertTextBox);
  const dateTime = command('Date & Time', 'dateTime', () => w.insertDateTime?.(), { size: 'large', text: 'Date & Time' });
  const symbol = command('Symbol', 'symbol', () => w.insertSymbol?.(), { size: 'large' });
  for (const control of [dateTime, symbol]) when(control, engineReady);
  noFocusSteal(blankPage, c.pageBreak);
  // Galleries and dialogs come from the editor's Insert commands (views/insert-tab.js); without them the basic commands remain.
  const ins = w.insertRibbon?.({ command, menuButton, split, rows, divider, when, engineReady, focusEditor, inDocument, pageBreak: c.pageBreak }) || {};
  const insert = { id: 'insert', label: 'Insert', groups: [
    { id: 'pages', label: 'Pages', icon: 'blankPage', priority: 4, items: ins.pages || [coverPage, blankPage, c.pageBreak] },
    { id: 'tables', label: 'Tables', icon: 'table', priority: 9, items: [c.insertTable] },
    { id: 'illustrations', label: 'Illustrations', icon: 'pictures', priority: 8, items: ins.illustrations || [c.insertImage, shapesButton] },
    { id: 'links', label: 'Links', icon: 'link', priority: 7, items: [c.hyperlink, c.bookmarks] },
    { id: 'headerFooter', label: 'Header & Footer', icon: 'header', priority: 5, items: ins.headerFooter || [headerButton, footerButton, pageNumber] },
    { id: 'text', label: 'Text', icon: 'textBox', priority: 3, items: ins.text || [textBox, dateTime] },
    { id: 'symbols', label: 'Symbols', icon: 'symbol', priority: 2, items: ins.symbols || [symbol] },
  ] };

  /* ---- Design ---- */
  const paragraphSpacing = menuButton('Paragraph Spacing', 'paragraphSpacing', () => w.paragraphSpacingItems?.() || [], { text: 'Paragraph Spacing' });
  when(paragraphSpacing, () => !!w.paragraphSpacingItems && engineReady());
  const pageColor = menuButton('Page Color', 'pageColor', () => w.pageColorItems?.() || [], { text: 'Page Color' });
  const pageBorders = menuButton('Page Borders', 'pageBorders', () => w.pageBorderItems?.() || [], { text: 'Page Borders' });
  when(pageColor, () => !!w.pageColorItems && !c.pageSetup.disabled);
  when(pageBorders, () => !!w.pageBorderItems && !c.pageSetup.disabled);
  const design = { id: 'design', label: 'Design', groups: [
    { id: 'formatting', label: 'Document Formatting', icon: 'paragraphSpacing', priority: 4, items: [paragraphSpacing] },
    { id: 'background', label: 'Page Background', icon: 'pageColor', priority: 5, items: [pageColor, pageBorders] },
  ] };

  /* ---- Layout ---- */
  const margins = menuButton('Margins', 'margins', () => [...(w.marginItems?.() || []), separator, { label: 'Custom Margins…', onSelect: () => c.pageSetup.click() }]);
  const orientation = menuButton('Orientation', 'orientation', () => w.orientationItems?.() || []);
  const size = menuButton('Size', 'size', () => [...(w.sizeItems?.() || []), separator, { label: 'More Paper Sizes…', onSelect: () => c.pageSetup.click() }]);
  const columns = menuButton('Columns', 'columns', () => w.columnItems?.() || []);
  const breaks = menuButton('Breaks', 'breaks', () => [
    { header: 'Page Breaks' },
    { label: 'Page', icon: 'pageBreak', shortcut: `${MOD_KEY}+Enter`, disabled: c.pageBreak.disabled, onSelect: () => c.pageBreak.click() },
    { label: 'Column', shortcut: `${MOD_KEY}+Shift+Enter`, disabled: !engineReady() || !w.insertColumnBreak, onSelect: () => w.insertColumnBreak() },
    { label: 'Text Wrapping', shortcut: 'Shift+Enter', disabled: !engineReady(), onSelect: () => w.insertLineBreak?.() },
    ...(w.sectionBreakItems?.() || [])]);
  for (const control of [margins, orientation, size, breaks]) when(control, () => !c.pageSetup.disabled);
  when(columns, () => !!w.columnItems && !c.pageSetup.disabled);
  small(c.pageSetup, { icon: 'pageSetup' });
  const spin = (label, icon, input, unit) => el('label.ribbon-spin', { title: label }, commandIconEl(icon, 16), el('span.ribbon-spin-label', {}, label), input, el('span.ribbon-spin-unit', {}, unit));
  c.spaceBefore.classList.add('ribbon-number'); c.spaceAfter.classList.add('ribbon-number');
  // Indents follow the measurement unit chosen on the View tab.
  const indentInput = (key, label) => {
    const input = el('input.canvas-spacing.ribbon-number', { type: 'number', step: 0.1, min: -56, max: 56, disabled: true, 'aria-label': `${label} (${recallUnit()})`, placeholder: 'Mixed',
      // The arrows step by tenths; any typed value in range is kept (2.54 cm is an inch).
      onchange: () => { const v = input.validity; if (input.value === '' || v.badInput || v.rangeOverflow || v.rangeUnderflow) { input.reportValidity(); refresh(); return; } w.setIndent?.(key, Number(input.value), recallUnit()); },
      onkeydown: e => { if (e.key === 'Enter' && !isComposing(e)) { e.preventDefault(); input.dispatchEvent(new Event('change')); focusEditor(); } } });
    states.push({ control: input, enabled: () => engineReady() && !!w.setIndent, value: () => w.indentValue?.(key, recallUnit()), unit: label });
    return input;
  };
  const indentLeft = indentInput('indentLeft', 'Indent left'), indentRight = indentInput('indentRight', 'Indent right');
  const wrapText = menuButton('Wrap Text', 'wrapText', () => w.wrapItems?.() || []);
  const forward = command('Bring Forward', 'bringForward', () => w.arrange?.('forward'), { size: 'large' });
  const backward = command('Send Backward', 'sendBackward', () => w.arrange?.('backward'), { size: 'large' });
  when(wrapText, () => !!(w.canWrap || w.canArrange)?.()); for (const control of [forward, backward]) when(control, () => !!w.canArrange?.());
  const layout = { id: 'layout', label: 'Layout', groups: [
    { id: 'pageSetup', label: 'Page Setup', icon: 'margins', priority: 9, items: [margins, orientation, size, columns, breaks, el('div.ribbon-launcher', {}, c.pageSetup)] },
    { id: 'layoutParagraph', label: 'Paragraph', icon: 'paragraphDialog', priority: 6, items: [
      el('div.ribbon-spin-group', {}, el('span.ribbon-spin-title', {}, 'Indent'), spin('Left', 'indentLeft', indentLeft, recallUnit()), spin('Right', 'indentRight', indentRight, recallUnit())),
      divider(),
      el('div.ribbon-spin-group', {}, el('span.ribbon-spin-title', {}, 'Spacing'), spin('Before', 'spaceBefore', c.spaceBefore, 'pt'), spin('After', 'spaceAfter', c.spaceAfter, 'pt'))] },
    { id: 'arrange', label: 'Arrange', icon: 'wrapText', priority: 3, items: [wrapText, forward, backward] },
  ] };

  /* ---- References ---- */
  const toc = menuButton('Table of Contents', 'toc', () => w.tocItems?.(focusEditor) || [], { text: 'Table of Contents' });
  const addText = menuButton('Add Text', 'addText', () => w.addTextItems?.() || [], { size: 'small', text: 'Add Text' });
  const updateTable = command('Update Table', 'updateTable', () => (w.updateTocDialog ? w.updateTocDialog() : w.updateFields?.()), { text: 'Update Table' });
  const updateFields = command('Update Fields', 'updateFields', () => w.updateAllFields?.(), { text: 'Update Fields', shortcut: 'F9' });
  when(toc, () => !!w.tocItems && engineReady()); when(addText, () => !!w.addTextItems && engineReady()); when(updateTable, () => !!w.canUpdateFields?.()); when(updateFields, () => !!w.updateAllFields && engineReady());
  const footnote = command('Insert Footnote', 'footnote', () => w.insertFootnote?.(), { size: 'large', text: 'Insert Footnote', shortcut: MOD_KEY === 'Cmd' ? 'Cmd+Option+F' : 'Ctrl+Alt+F' });
  const endnote = command('Insert Endnote', 'endnote', () => w.insertEndnote?.(), { text: 'Insert Endnote', shortcut: MOD_KEY === 'Cmd' ? 'Cmd+Option+E' : 'Ctrl+Alt+D' });
  const nextNote = menuButton('Next Footnote', 'nextFootnote', () => w.nextNoteItems?.() || [], { size: 'small', text: 'Next Footnote' });
  const showNotes = command('Show Notes', 'showNotes', () => w.showNotes?.(), { text: 'Show Notes' });
  const notesLauncher = command('Footnote and Endnote Settings', 'noteSettings', () => w.notesDialog?.());
  when(footnote, () => !!w.insertFootnote && engineReady()); when(endnote, () => !!w.insertEndnote && engineReady()); when(nextNote, () => !!w.nextNoteItems && engineReady());
  when(showNotes, () => !!w.showNotes && engineReady()); when(notesLauncher, () => !!w.notesDialog && engineReady());
  noFocusSteal(updateFields, endnote, showNotes, notesLauncher);
  const references = { id: 'references', label: 'References', groups: [
    { id: 'toc', label: 'Table of Contents', icon: 'toc', priority: 7, items: [toc, rows([addText], [updateTable], [updateFields])] },
    { id: 'footnotes', label: 'Footnotes', icon: 'footnote', priority: 5, items: [footnote, rows([endnote], [nextNote], [showNotes]), el('div.ribbon-launcher', {}, notesLauncher)] },
  ] };

  /* ---- Review ---- */
  const spellingButton = command('Editor', 'spelling', () => w.spelling?.(), { size: 'large', text: 'Editor', shortcut: 'F7' });
  const spelling = split(spellingButton, { label: 'Spelling options', size: 'large', open: (anchor, e) => openMenu({ anchor, label: 'Spelling options', pointer: !!e?.detail, onClose: e?.detail ? focusEditor : null, items: inDocument(w.spellingItems?.() || []) }) });
  const wordCount = command('Word Count', 'wordCount', () => w.wordCount?.(), { text: 'Word Count' });
  const thesaurus = command('Thesaurus', 'thesaurus', () => w.thesaurus?.(), { text: 'Thesaurus', shortcut: MOD_KEY === 'Cmd' ? 'Option+Cmd+R' : 'Shift+F7' });
  when(spellingButton, () => !!w.spelling && !!a.hasDocument?.()); when(spelling.arrow, () => !!w.spellingItems && !!a.hasDocument?.()); when(wordCount, () => !!a.hasDocument?.()); when(thesaurus, () => !!w.thesaurus && !!a.hasDocument?.());
  const review = { id: 'review', label: 'Review', groups: [
    { id: 'proofing', label: 'Proofing', icon: 'spelling', priority: 7, items: [spelling, rows([thesaurus], [wordCount])] },
  ] };

  /* ---- View ---- */
  // The document views (views/document-views.js): each button shows whether it is the current view.
  const viewButton = (label, icon, kind, size = 'large') => {
    const button = command(label, icon, () => (w.setDocumentView ? w.setDocumentView(kind) : focusEditor()), { size, text: label, attrs: { 'aria-pressed': String(kind === 'print') } });
    noFocusSteal(button);
    when(button, () => kind === 'print' || (!!w.setDocumentView && !!a.hasDocument?.()), () => String((w.documentView?.() ?? 'print') === kind));
    return button;
  };
  const readMode = viewButton('Read Mode', 'readMode', 'read'), printLayout = viewButton('Print Layout', 'printLayout', 'print'), webLayout = viewButton('Web Layout', 'webLayout', 'web');
  const outlineView = viewButton('Outline', 'outlineView', 'outline', 'small'), draftView = viewButton('Draft', 'draft', 'draft', 'small');
  const focusMode = command('Focus', 'focus', () => w.focusMode?.(), { size: 'large' });
  when(focusMode, () => !!w.focusMode && !!a.hasDocument?.());
  const check = (label, get, set) => {
    const input = el('input', { type: 'checkbox', onchange: () => set(input.checked) });
    states.push({ control: input, enabled: () => true, checked: get });
    return el('label.ribbon-check', {}, input, label);
  };
  const rulerCheck = check('Ruler', () => rulers?.visible ?? true, value => { if ((rulers?.visible ?? true) !== value) rulers?.toggle(); });
  const gridCheck = check('Gridlines', () => !!w.gridlinesVisible?.(), value => w.setGridlines?.(value));
  small(c.outline, { icon: 'navigationPane', label: 'Navigation Pane' });
  c.outline.setAttribute('aria-label', 'Navigation Pane'); c.outline.title = `Navigation Pane (${MOD_KEY === 'Cmd' ? 'Cmd+Option+O' : 'Ctrl+Alt+O'})`;
  const paneToggle = command('Formatting Pane', 'formattingPane', () => setExpanded(!expandedTools), { text: 'Formatting Pane', attrs: { 'aria-pressed': String(expandedTools) } });
  paneToggle.setAttribute('aria-label', 'Show Formatting Pane');
  const zoomDialog = command('Zoom', 'zoom', () => w.zoomDialog?.(), { size: 'large' });
  const zoom100 = command('100%', 'zoom100', () => w.setZoom?.(1), { size: 'large' });
  const onePage = command('One Page', 'onePage', () => w.zoomTo?.('page'), { text: 'One Page' });
  const pageWidth = command('Page Width', 'pageWidth', () => w.zoomTo?.('width'), { text: 'Page Width' });
  const multiplePages = command('Multiple Pages', 'multiplePages', () => w.multiplePages?.(), { text: 'Multiple Pages', attrs: { 'aria-pressed': 'false' } });
  when(multiplePages, () => !!w.multiplePages && !!a.hasDocument?.(), () => w.multiplePagesActive?.() ? 'true' : 'false');
  for (const control of [zoomDialog, zoom100, onePage, pageWidth]) when(control, () => !!a.hasDocument?.());
  const units = menuButton('Units', 'units', () => [['in', 'Inches'], ['cm', 'Centimeters']].map(([id, label]) => ({ label, radio: true, checked: rulers?.unit === id, onSelect: () => rulers?.setUnit(id) })), { size: 'small', text: 'Units' });
  const fonts = command('Document Fonts', 'documentFonts', () => a.loadFontFiles?.(), { text: 'Document Fonts…' });
  when(fonts, () => !!a.hasDocument?.());
  const view = { id: 'view', label: 'View', groups: [
    { id: 'views', label: 'Views', icon: 'printLayout', priority: 8, items: [readMode, printLayout, webLayout, rows([outlineView], [draftView])] },
    { id: 'immersive', label: 'Immersive', icon: 'focus', priority: 4, items: [focusMode] },
    { id: 'show', label: 'Show', icon: 'ruler', priority: 7, items: [rows([rulerCheck], [gridCheck], [c.outline]), rows([paneToggle])] },
    { id: 'zoom', label: 'Zoom', icon: 'zoom', priority: 5, items: [zoomDialog, zoom100, rows([onePage], [multiplePages], [pageWidth])] },
    { id: 'options', label: 'Options', icon: 'units', priority: 3, items: [rows([units], [fonts])] },
  ] };

  /* ---- Contextual: tables ---- */
  // The table tabs come from the table tools (views/table-tools.js); `designs` also refreshes them.
  const designs = w.tableRibbon?.({ command, menuButton, split, rows, divider, large, small, when, check, spin, inDocument, engineReady, focusEditor, separator, commandIconEl, controls: c });
  const tableDesign = { id: 'tableDesign', label: 'Table Design', contextual: 'table', groups: designs?.design || [] };
  const tableLayout = { id: 'tableLayout', label: 'Table Layout', contextual: 'table', groups: designs?.layout || [] };

  /* ---- Contextual: pictures ---- */
  large(c.imageProperties, { label: 'Image Properties', icon: 'pictures' });
  const pictureWrap = menuButton('Wrap Text', 'wrapText', () => w.wrapItems?.() || []);
  const pictureForward = command('Bring Forward', 'bringForward', () => w.arrange?.('forward'), { size: 'large', text: 'Bring Forward' });
  const pictureBackward = command('Send Backward', 'sendBackward', () => w.arrange?.('backward'), { size: 'large', text: 'Send Backward' });
  when(pictureWrap, () => !!(w.canWrap || w.canArrange)?.()); for (const control of [pictureForward, pictureBackward]) when(control, () => !!w.canArrange?.());
  const drawingText = menuButton('Drawing Text', 'drawingText', () => w.drawingTextItems?.() || [], { text: 'Edit Drawing Text' });
  when(drawingText, () => (w.drawingTextItems?.() || []).length > 0);
  const deletePicture = command('Delete Image', 'deletePicture', () => w.deleteSelection?.(), { size: 'large', text: 'Delete' });
  when(deletePicture, () => !c.imageProperties.disabled);
  const rotate = menuButton('Rotate', 'rotate', () => w.rotateItems?.() || [], { text: 'Rotate' });
  when(rotate, () => !!w.pictureSelected?.());
  const pictureSizeInput = (key, label) => {
    const input = el('input.canvas-spacing.ribbon-number', { type: 'number', step: 0.01, min: 0.01, max: 22, 'aria-label': `Picture ${label.toLowerCase()} (in)`,
      onchange: () => { if (!input.checkValidity() || input.value === '') { input.reportValidity(); refresh(); return; } w.setPictureSize?.(key, Number(input.value)); },
      onkeydown: e => { if (e.key === 'Enter' && !isComposing(e)) { e.preventDefault(); input.dispatchEvent(new Event('change')); } } });
    states.push({ control: input, enabled: () => !!w.pictureSelected?.(), value: () => w.pictureSize?.(key) });
    return spin(label, key === 'height' ? 'shapeHeight' : 'shapeWidth', input, 'in');
  };
  const picture = { id: 'picture', label: 'Picture Format', contextual: 'image', groups: [
    { id: 'pictureArrange', label: 'Arrange', icon: 'wrapText', priority: 5, items: [pictureWrap, pictureForward, pictureBackward, rotate] },
    { id: 'size', label: 'Size', icon: 'pictures', priority: 6, items: [el('div.ribbon-spin-group', {}, pictureSizeInput('height', 'Height'), pictureSizeInput('width', 'Width')), c.imageProperties] },
    { id: 'pictureText', label: 'Text', icon: 'drawingText', priority: 3, items: [drawingText, deletePicture] },
  ] };

  /* ---- Contextual: shapes ---- */
  const shapeFill = command('Shape Fill', 'shapeFill', () => w.shapeColorMenu?.(shapeFill, 'fill'), { caret: true, text: 'Shape Fill', attrs: { 'aria-haspopup': 'menu' } });
  const shapeOutline = command('Shape Outline', 'shapeOutline', () => w.shapeColorMenu?.(shapeOutline, 'line'), { caret: true, text: 'Shape Outline', attrs: { 'aria-haspopup': 'menu' } });
  const shapeWeight = menuButton('Weight', 'lineWeight', () => w.shapeWeightItems?.() || [], { size: 'small', text: 'Weight' });
  noFocusSteal(shapeFill, shapeOutline);
  for (const control of [shapeFill, shapeOutline, shapeWeight]) when(control, () => !!w.shapeSelected?.());
  const shapeSizeInput = (key, label) => {
    const input = el('input.canvas-spacing.ribbon-number', { type: 'number', step: 0.01, min: 0.01, max: 22, 'aria-label': `Shape ${label.toLowerCase()} (in)`,
      onchange: () => { if (!input.checkValidity() || input.value === '') { input.reportValidity(); refresh(); return; } w.setShapeSize?.(key, Number(input.value)); },
      onkeydown: e => { if (e.key === 'Enter' && !isComposing(e)) { e.preventDefault(); input.dispatchEvent(new Event('change')); } } });
    states.push({ control: input, enabled: () => !!w.shapeSelected?.() && (key === 'width' || w.shapeSize?.('height') > 0), value: () => w.shapeSize?.(key) });
    return spin(label, key === 'height' ? 'shapeHeight' : 'shapeWidth', input, 'in');
  };
  const shapeWrap = menuButton('Wrap Text', 'wrapText', () => w.wrapItems?.() || []);
  const shapeForward = command('Bring Forward', 'bringForward', () => w.arrange?.('forward'), { size: 'large', text: 'Bring Forward' });
  const shapeBackward = command('Send Backward', 'sendBackward', () => w.arrange?.('backward'), { size: 'large', text: 'Send Backward' });
  when(shapeWrap, () => !!(w.canWrap || w.canArrange)?.()); for (const control of [shapeForward, shapeBackward]) when(control, () => !!w.canArrange?.());
  const deleteShape = command('Delete Shape', 'deleteShape', () => w.deleteSelection?.(), { size: 'large', text: 'Delete' });
  const editShapeText = command('Edit Text', 'drawingText', () => w.editShapeText?.(), { size: 'large', text: 'Edit Text' });
  when(editShapeText, () => (w.drawingTextItems?.() || []).some(item => !item.disabled));
  when(deleteShape, () => !!w.shapeSelected?.());
  const shapeFormat = { id: 'shapeFormat', label: 'Shape Format', contextual: 'shape', groups: [
    { id: 'shapeStyles', label: 'Shape Styles', icon: 'shapeFill', priority: 7, items: [rows([shapeFill], [shapeOutline], [shapeWeight])] },
    { id: 'shapeArrange', label: 'Arrange', icon: 'wrapText', priority: 5, items: [shapeWrap, shapeForward, shapeBackward] },
    { id: 'shapeSize', label: 'Size', icon: 'shapeHeight', priority: 6, items: [el('div.ribbon-spin-group', {}, shapeSizeInput('height', 'Height'), shapeSizeInput('width', 'Width'))] },
    { id: 'shapeEdit', label: 'Edit', icon: 'drawingText', priority: 4, items: [editShapeText, deleteShape] },
  ] };

  /* ---- File ---- */
  const fileItems = () => [
    { label: 'New Document', icon: 'filePlus', onSelect: a.newDocument },
    { label: 'Open .docx…', icon: 'folderOpen', shortcut: `${MOD_KEY}+O`, onSelect: a.openDocument },
    separator, ...(!local ? [fileCommand(c.saveButton, { icon: 'save', shortcut: `${MOD_KEY}+S` })] : []),
    fileCommand(c.exportButton, { icon: 'download' }),
    ...(!local ? [fileCommand(c.templateButton, { icon: 'template' })] : []),
    fileCommand(c.printButton, { icon: 'print', shortcut: `${MOD_KEY}+P` }),
    ...(w.fileItems?.() || []),
    { label: 'Rename…', icon: 'rename', onSelect: () => { title.focus(); title.select(); } },
    separator, { label: 'Page Setup…', icon: 'pageSetup', disabled: c.pageSetup.disabled, onSelect: () => c.pageSetup.click() },
    { label: 'Document Fonts…', icon: 'documentFonts', disabled: !a.hasDocument?.(), onSelect: a.loadFontFiles },
    separator, { label: 'Keyboard Shortcuts', icon: 'keyboard', shortcut: `${MOD_KEY}+/`, onSelect: openShortcuts },
    { label: 'All Documents', icon: 'back', onSelect: a.goHome },
  ];
  const fileCommand = (control, overrides) => ({ label: control.getAttribute('aria-label') || control.textContent, disabled: control.disabled, onSelect: () => control.click(), ...overrides });
  const fileButton = el('button.ribbon-file', { type: 'button', 'aria-haspopup': w.openBackstage ? 'dialog' : 'menu', 'aria-expanded': 'false', onclick: e => {
    if (w.openBackstage) { w.openBackstage(); return; }
    const opened = openMenu({ anchor: fileButton, label: 'File', minWidth: 250, items: inDocument(fileItems()), pointer: !!e.detail, onClose: e.detail ? focusEditor : null });
    if (!opened.menu && e.detail) focusEditor();
  } }, 'File');
  fileButton.addEventListener('mousedown', e => { if (document.activeElement?.matches?.('.canvas-input')) e.preventDefault(); });

  // Feature modules add their own groups: w.extendTab(tabId, kit) returns groups, each optionally
  // placed `after` an existing group id (otherwise appended), or taking the place of the group it `replaces`.
  const kit = { command, menuButton, split, rows, divider, large, small, when, check, inDocument, engineReady, focusEditor, separator, commandIconEl };
  // Picture Format, Shape Format and the Layout tab's Arrange group from the drawing module (views/pictures.js).
  const drawingTabs = w.drawingTabs?.(kit);
  if (drawingTabs) {
    picture.groups = drawingTabs.picture; shapeFormat.groups = drawingTabs.shape;
    const at = layout.groups.findIndex(g => g.id === 'arrange');
    if (at >= 0) layout.groups.splice(at, 1, drawingTabs.layoutArrange);
  }
  // Standard tabs from feature modules ({ id, label, groups, after }), placed after the tab named by `after`.
  const standardTabs = [home, insert, design, layout, references, review, view];
  for (const tab of w.extraTabs?.(kit) || []) { const at = standardTabs.findIndex(t => t.id === tab.after); standardTabs.splice(at < 0 ? standardTabs.length : at + 1, 0, tab); }
  for (const tab of [...standardTabs, tableDesign, tableLayout, picture, shapeFormat]) {
    const placed = new Map();
    for (const group of w.extendTab?.(tab.id, kit) || []) {
      const replaced = group.replaces ? tab.groups.findIndex(g => g.id === group.replaces) : -1;
      if (replaced >= 0) { tab.groups[replaced] = group; continue; }
      const at = group.after ? tab.groups.findIndex(g => g.id === (placed.get(group.after) ?? group.after)) : -1;
      if (at >= 0) { tab.groups.splice(at + 1, 0, group); placed.set(group.after, group.id); } else tab.groups.push(group);
    }
  }
  // Contextual tabs from feature modules: [{ id, label, contextual, groups }], shown by setContext's extra contexts.
  const moduleTabs = w.contextTabs?.(kit) || [];
  const ribbon = createRibbon({ tabs: [...standardTabs, tableDesign, tableLayout, picture, shapeFormat, ...moduleTabs], fileButton, focusEditor,
    onSelect: id => { if (!['tableDesign', 'tableLayout', 'picture', 'shapeFormat', ...moduleTabs.map(t => t.id)].includes(id)) rememberedTab = id; } });
  if (rememberedTab !== 'home') ribbon.select(rememberedTab);

  // Clicking a ribbon button leaves the keyboard in the document: a dialog it
  // opens then hands focus back to the text when it closes. Fields (font name, size) still take focus.
  ribbon.card.addEventListener('mousedown', e => { if (e.target.closest?.('button') && document.activeElement?.matches?.('.canvas-input')) e.preventDefault(); });
  // A ribbon command that changes the document becomes the one Repeat runs again, and names its undo step.
  ribbon.card.addEventListener('click', e => {
    const button = e.target.closest?.('button');
    if (!button || button.disabled || button.getAttribute('aria-haspopup') || button.classList.contains('ribbon-split-arrow') || button.classList.contains('ribbon-collapsed')) return;
    const label = button.getAttribute('aria-label') || button.title || button.textContent.trim();
    w.noteCommand?.(label, () => { if (button.isConnected && !button.disabled) button.click(); });
  }, true);

  /* ---- Title bar: quick access, menu bar, document name, command search, modes, comments, share ---- */
  if (local) {
    c.exportButton.className = 'canvas-download';
    c.exportButton.setAttribute('aria-label', 'Download .docx');
    c.exportButton.title = 'Download .docx';
    c.exportButton.replaceChildren(commandIconEl('download', 16), el('span', {}, 'Download .docx'));
  }
  const allTabs = [home, insert, design, layout, references, review, view, tableDesign, tableLayout, picture, shapeFormat, ...moduleTabs];
  let modes = null, titleBar = null;
  const menuContext = { w, c, a, local, kit, focusEditor, inDocument, engineReady, rulers, engine: () => a.engine?.(),
    tableAction, tableOption, shortcut: id => w.shortcutFor?.(id) ?? null, menuAnchor: () => document.activeElement,
    toggleFormattingPane: () => setExpanded(!expandedTools), formattingPaneShown: () => expandedTools,
    ribbonMode: () => modes?.mode ?? 'always', setRibbonMode: m => modes?.setMode(m), toggleRibbon: () => modes?.toggle(),
    statusBarShown: () => w.statusBarShown?.() ?? true, setStatusBarShown: w.setStatusBarShown ? on => w.setStatusBarShown(on) : null,
    openShortcuts: () => (w.openShortcuts ? w.openShortcuts() : openShortcuts()), focusSearch: () => titleBar?.focusSearch(), showKeyTips: () => modes?.showKeyTips() };
  const menus = classicMenus(menuContext);
  /** Every command in the window, for search, KeyTips and Customize Keyboard. */
  const entries = () => [...ribbonEntries({ ribbon, tabs: allTabs, beforeRun: () => modes?.beforeRun() }), ...menuEntries(menus)];
  titleBar = createTitleBar({ w, c, a, local, title, status, account, menus, focusEditor, entries,
    openShortcuts: menuContext.openShortcuts, keymapShortcut: id => w.shortcutFor?.(id) ?? null });
  const header = el('header.canvas-header.ed-header', {}, titleBar.el, ribbon.tablist);
  const toolbar = el('div.ed-ribbon', {}, ribbon.card);
  const navigation = el('div.canvas-navigation', { hidden: true });

  function setContext(context = 'paragraph', extra = []) {
    heading.textContent = context === 'image' || context === 'shape' ? 'Formatting' : `${context[0].toUpperCase() + context.slice(1)} formatting`;
    tableSection.hidden = context !== 'table';
    paragraphSection.hidden = textSection.hidden = context === 'image' || context === 'shape';
    const appeared = ribbon.setContexts([...(context === 'table' ? ['table'] : context === 'image' ? ['image'] : context === 'shape' ? ['shape'] : []), ...extra]) || [];
    // Selecting a picture or shape brings up its format tab.
    if (appeared.includes('image')) ribbon.select('picture');
    if (appeared.includes('shape')) ribbon.select('shapeFormat');
    for (const tab of moduleTabs) if (appeared.includes(tab.contextual) && tab.selectOnAppear) ribbon.select(tab.id);
  }

  function refresh() {
    for (const { control, enabled, pressed, checked, value, unit } of states) {
      const disabled = !enabled();
      if (unit && control.getAttribute('aria-label') !== `${unit} (${recallUnit()})`) {
        control.setAttribute('aria-label', `${unit} (${recallUnit()})`);
        const label = control.closest('.ribbon-spin')?.querySelector('.ribbon-spin-unit'); if (label) label.textContent = recallUnit();
      }
      if (control.disabled !== disabled) control.disabled = disabled;
      if (pressed) { const state = pressed(); if (control.getAttribute('aria-pressed') !== state) control.setAttribute('aria-pressed', state); }
      if (checked) control.checked = !!checked();
      if (value && document.activeElement !== control) { const v = String(value() ?? ''); if (control.value !== v) control.value = v; }
    }
    if (!pane.hidden) for (const control of pane.querySelectorAll('button, select, input')) if (control.tabIndex !== 0) control.tabIndex = 0;
    refreshGallery();
    designs?.refresh();
    ribbon.refresh();
    titleBar.refresh();
  }

  // Keyboard chords for the ribbon's own commands, while the keyboard is in the document.
  const keyAbort = new AbortController();
  // Narrow windows hide some quick access commands, which may hold its tab stop.
  compact.addEventListener('change', () => titleBar.refreshQuickStop(), { signal: keyAbort.signal });
  window.addEventListener('keydown', e => {
    if (e.defaultPrevented || isComposing(e) || !e.target?.matches?.('.canvas-input')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey && !e.shiftKey && e.code === 'Digit8' && w.toggleMarks) { e.preventDefault(); w.toggleMarks(); }
    else if (e.shiftKey && !mod && !e.altKey && e.key === 'F3' && w.changeCase) { e.preventDefault(); w.changeCase('cycle'); }
    else if (mod && !e.altKey && !e.shiftKey && (e.code === 'BracketRight' || e.code === 'BracketLeft')) { e.preventDefault(); w.growFont?.(e.code === 'BracketRight' ? 1 : -1, 1); }
    else if (mod && !e.altKey && !e.shiftKey && e.code === 'KeyD' && w.fontDialog) { e.preventDefault(); w.fontDialog(); }
  }, { signal: keyAbort.signal });

  setContext();
  refresh();
  return { header, toolbar, navigation, inspector: pane, refresh, setContext, ribbon, titleBar, menus, entries,
    get ribbonModes() { return modes; },
    /** Ribbon display modes and KeyTips need the workspace the chrome sits in. */
    attach(workspace) { modes ??= createRibbonModes({ workspace, header, toolbar, ribbon, tabs: allTabs, titleBar: titleBar.el, focusEditor }); },
    focusSearch: () => titleBar.focusSearch(), focusMenubar: () => titleBar.focusMenubar(), showKeyTips: () => modes?.showKeyTips(),
    toggleFormattingPane: () => setExpanded(!expandedTools),
    closeInspector: () => setExpanded(false), destroy() { keyAbort.abort(); ribbon.destroy(); titleBar.destroy(); modes?.destroy(); closeMenu(); } };
}
