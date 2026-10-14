import { MOD_KEY, IS_MAC } from '../ui/dom.js';
import { openMenu } from '../ui/menu.js';

/**
 * The classic menu bar's menus — File, Edit, View, Insert, Format, Tools, Table, Window and Help — laid
 * out the way desktop word processors arrange them and wired to the commands the editor has. An entry
 * whose command no module provides is left out rather than shown dead; one that does not apply to the
 * current selection is disabled. Feature modules add their own entries through
 * `commands.extendMenu(menuId, kit)`.
 *
 * classicMenus(ctx) -> [{ id, label, items() }]
 */
export const MENU_IDS = ['file', 'edit', 'view', 'insert', 'format', 'tools', 'table', 'window', 'help'];
const LABELS = { file: 'File', edit: 'Edit', view: 'View', insert: 'Insert', format: 'Format', tools: 'Tools', table: 'Table', window: 'Window', help: 'Help' };
export const DOCUMENT_VIEWS = [['read', 'Read Mode', 'readMode'], ['print', 'Print Layout', 'printLayout'], ['web', 'Web Layout', 'webLayout'], ['outline', 'Outline', 'outlineView'], ['draft', 'Draft', 'draft']];

export function classicMenus(ctx) {
  const { w, c, a, local, kit, shortcut = () => null } = ctx;
  const sep = { separator: true };
  const ready = () => !!a.hasDocument?.();
  const editable = () => ctx.engineReady();
  const sc = (id, fallback = null) => shortcut(id) ?? fallback;
  /** A menu entry for an editor control: its label, its state and its click. */
  const control = (node, label, extra = {}) => node ? { label, disabled: !!node.disabled, onSelect: () => node.click(), ...extra } : null;
  /** An entry for an optional command: left out when no module provides it. */
  const opt = (fn, label, extra = {}) => typeof fn === 'function' ? { label, onSelect: () => fn(), ...extra } : null;
  const sub = (label, items, extra = {}) => { const list = tidy(items); return list.some(i => i && !i.separator && !i.header) ? { label, items: list, ...extra } : null; };
  const anchor = () => ctx.menuAnchor?.() || document.activeElement;
  const ext = id => { try { return tidy(w.extendMenu?.(id, kit) || []); } catch (e) { console.error(e); return []; } };
  // A module's entry takes the place of the built-in entry with the same name (it owns that command);
  // its other entries follow after a separator, each name once.
  const withExt = (id, items) => {
    const key = item => item && !item.separator && item.label ? String(item.label).replace(/…$/, '').trim().toLowerCase() : null;
    const base = tidy(items), positions = new Map(base.map((item, i) => [key(item), i]).filter(([k]) => k));
    const extra = [], seen = new Set();
    for (const item of ext(id)) {
      const k = key(item);
      if (k && seen.has(k)) continue;
      if (k) seen.add(k);
      if (k && positions.has(k)) base[positions.get(k)] = item; else extra.push(item);
    }
    return tidy([...base, ...(extra.some(item => !item.separator) ? [sep, ...extra] : [])]);
  };

  const file = () => withExt('file', [
    { label: 'New Document', icon: 'filePlus', onSelect: () => a.newDocument?.() },
    opt(w.openBackstage && (() => w.openBackstage('new')), 'New from Template…', { icon: 'template' }),
    { label: 'Open…', icon: 'folderOpen', shortcut: sc('file.open', `${MOD_KEY}+O`), onSelect: () => a.openDocument?.() },
    w.recentDocuments && { label: 'Open Recent', icon: 'history', submenu: (from, { focusFirst } = {}) => recentMenu(from, focusFirst) },
    sep,
    { label: 'Close', icon: 'close', onSelect: () => a.goHome?.() },
    !local ? control(c.saveButton, 'Save', { icon: 'save', shortcut: `${MOD_KEY}+S` }) : control(c.exportButton, 'Download .docx', { icon: 'download' }),
    !local && opt(w.saveAs, 'Save As…', { shortcut: sc('file.saveAs', `${MOD_KEY}+Shift+S`), disabled: !ready() }),
    opt(w.saveCopy, 'Download a Copy', { icon: 'download', disabled: !ready() }),
    !local ? control(c.templateButton, 'Save as Template…', { icon: 'template' }) : null,
    !local && opt(w.renameDocument, 'Rename…', { icon: 'rename' }),
    sep,
    opt(w.versionHistory, 'Browse Version History', { icon: 'history' }),
    sub('Share', [
      opt(w.share, 'Invite People…', { icon: 'invitePeople', disabled: !ready() }),
      opt(w.publishWeb, 'Publish to the Web…', { icon: 'share', disabled: !ready() }),
      opt(w.sendCopy, 'Send a Copy (.docx)', { disabled: !ready() }),
      opt(w.savePdf, 'Send as PDF', { icon: 'pdf', disabled: !ready() }),
    ]),
    sub('Export', [
      { label: 'Word Document (.docx)', icon: 'download', disabled: c.exportButton.disabled, onSelect: () => c.exportButton.click() },
      opt(w.savePdf, 'PDF (.pdf)', { icon: 'pdf', disabled: !ready() }),
      opt(w.exportAs && (() => w.exportAs('html')), 'Web Page (.html)', { disabled: !ready() }),
      opt(w.exportAs && (() => w.exportAs('markdown')), 'Markdown (.md)', { disabled: !ready() }),
      opt(w.exportAs && (() => w.exportAs('text')), 'Plain Text (.txt)', { disabled: !ready() }),
    ]),
    sep,
    control(c.pageSetup, 'Page Setup…', { icon: 'pageSetup' }),
    control(c.printButton, 'Print…', { icon: 'print', shortcut: `${MOD_KEY}+P` }),
    sep,
    opt(w.openBackstage && (() => w.openBackstage('info')), 'Properties…', { icon: 'info' }),
    opt(w.preferences, 'Preferences…', { icon: 'preferences', shortcut: sc('app.preferences', `${MOD_KEY}+,`) }),
  ]);

  async function recentMenu(from, focusFirst) {
    let list = [];
    try { list = await w.recentDocuments(); } catch { list = []; }
    if (!from.isConnected) return;
    openMenu({ anchor: from, label: 'Open Recent', focusFirst, minWidth: 220, items: list.length
      ? [...list.map(doc => ({ label: doc.name, icon: 'filePlus', hint: doc.when || '', onSelect: () => w.openRecent(doc.path) })), sep, { label: 'More…', onSelect: () => w.openBackstage?.('open') }]
      : [{ note: 'No recent documents.' }] });
  }

  const edit = () => {
    const engine = ctx.engine?.();
    const undoLabel = w.undoLabel?.();
    const canRedo = !!engine?.session.future.length && editable();
    const repeatLabel = w.repeatLabel?.();
    const clipboard = a.clipboardState?.() || {};
    return withExt('edit', [
      { label: !c.undo.disabled ? `Undo${undoLabel ? ` ${undoLabel}` : ''}` : 'Can’t Undo', icon: 'undo', shortcut: `${MOD_KEY}+Z`, disabled: c.undo.disabled, onSelect: () => c.undo.click() },
      canRedo ? { label: 'Redo', icon: 'redo', shortcut: `${MOD_KEY}+Y`, onSelect: () => c.redo.click() }
        : { label: w.canRepeat?.() ? `Repeat ${repeatLabel}` : 'Can’t Repeat', icon: 'redo', shortcut: sc('edit.repeat', `${MOD_KEY}+Y`), disabled: !w.canRepeat?.(), onSelect: () => w.repeat?.() },
      sep,
      { label: 'Cut', icon: 'cut', shortcut: `${MOD_KEY}+X`, disabled: !clipboard.cut, onSelect: () => a.cut?.() },
      { label: 'Copy', icon: 'copy', shortcut: `${MOD_KEY}+C`, disabled: !clipboard.copy, onSelect: () => a.copy?.() },
      opt(w.copyFormat, 'Copy Formatting', { icon: 'formatPainter', shortcut: sc('edit.copyFormat'), disabled: !ready() }),
      sep,
      { label: 'Paste', icon: 'paste', shortcut: `${MOD_KEY}+V`, disabled: !clipboard.paste, onSelect: () => a.paste?.() },
      opt(w.pasteSpecial, 'Paste Special…', { shortcut: sc('edit.pasteSpecial'), disabled: !clipboard.paste }),
      { label: 'Paste and Match Formatting', icon: 'pasteText', shortcut: sc('edit.pasteMatch'), disabled: !clipboard.paste, onSelect: () => a.pastePlain?.() },
      opt(w.pasteFormat, 'Paste Formatting', { shortcut: sc('edit.pasteFormat'), disabled: !w.hasCopiedFormat?.() || !editable() }),
      sep,
      sub('Clear', [
        opt(w.clearFormatting, 'Clear Formatting', { icon: 'clearFormat', disabled: !editable() }),
        opt(w.clearContents, 'Contents', { shortcut: 'Delete', disabled: !w.canClearContents?.() }),
      ]),
      { label: 'Select All', icon: 'selectAll', shortcut: `${MOD_KEY}+A`, disabled: !ready(), onSelect: () => a.selectAll?.() },
      ...(w.selectItems ? [sub('Select', w.selectItems() || [])] : []),
      sep,
      sub('Find', [
        { label: 'Find…', icon: 'find', shortcut: `${MOD_KEY}+F`, disabled: c.find.disabled, onSelect: () => a.openSearch?.() },
        opt(w.findNext && (() => w.findNext(1)), 'Find Next', { shortcut: sc('edit.findNext'), disabled: !ready() }),
        opt(w.findNext && (() => w.findNext(-1)), 'Find Previous', { shortcut: sc('edit.findPrevious'), disabled: !ready() }),
        sep,
        opt(w.openReplace, 'Replace…', { icon: 'replace', shortcut: IS_MAC ? 'Cmd+Shift+H' : 'Ctrl+H', disabled: c.find.disabled }),
        opt(w.goTo, 'Go To…', { icon: 'goTo', shortcut: sc('edit.goTo', `${MOD_KEY}+G`), disabled: !ready() }),
        { label: 'Advanced Find and Replace…', disabled: c.find.disabled, onSelect: () => (w.advancedFind ? w.advancedFind() : c.find.click()) },
      ]),
      sep,
      opt(w.editLinks, 'Links…', { icon: 'link', disabled: !ready() }),
      control(c.bookmarks, 'Bookmarks…', { icon: 'bookmark' }),
    ]);
  };

  const view = () => {
    const modes = w.documentViewModes?.() || ['print'];
    const current = w.documentView?.() || 'print';
    const ribbonMode = ctx.ribbonMode?.() || 'always';
    return withExt('view', [
      ...DOCUMENT_VIEWS.filter(([mode]) => mode === 'print' || modes.includes(mode)).map(([mode, label, icon]) => ({ label, icon, radio: true, checked: current === mode,
        onSelect: () => (w.setDocumentView ? w.setDocumentView(mode) : ctx.focusEditor()) })),
      sep,
      opt(w.focusMode, 'Focus', { icon: 'focus', shortcut: sc('view.focus'), disabled: !ready() }),
      sep,
      ctx.setRibbonMode && { label: 'Ribbon', items: [
        { label: 'Always Show', radio: true, checked: ribbonMode === 'always', onSelect: () => ctx.setRibbonMode('always') },
        { label: 'Show Tabs Only', radio: true, checked: ribbonMode === 'tabs', onSelect: () => ctx.setRibbonMode('tabs') },
        { label: 'Auto-hide', radio: true, checked: ribbonMode === 'auto', onSelect: () => ctx.setRibbonMode('auto') },
        sep, { label: 'Collapse or Expand the Ribbon', shortcut: sc('view.ribbon'), onSelect: () => ctx.toggleRibbon() }] },
      sub('Sidebar', [
        control(c.outline, 'Navigation', { icon: 'navigationPane', checked: c.outline.getAttribute('aria-expanded') === 'true' }),
        opt(w.toggleReviewingPane, 'Reviewing', { icon: 'reviewingPane', checked: !!w.reviewingPaneShown?.() }),
        opt(w.spelling, 'Spelling', { icon: 'spelling' }),
        { label: 'Search', icon: 'find', onSelect: () => a.openSearch?.() },
        ctx.toggleFormattingPane && { label: 'Formatting Pane', icon: 'formattingPane', checked: !!ctx.formattingPaneShown?.(), onSelect: () => ctx.toggleFormattingPane() },
        opt(w.stylesPane, 'Styles', { icon: 'stylesPane' }),
      ]),
      ctx.setStatusBarShown && { label: 'Status Bar', checked: ctx.statusBarShown(), onSelect: () => ctx.setStatusBarShown(!ctx.statusBarShown()) },
      sep,
      ctx.rulers && { label: 'Ruler', checked: ctx.rulers.visible, onSelect: () => ctx.rulers.toggle() },
      opt(w.toggleMarks, 'Formatting Marks', { icon: 'pilcrow', shortcut: `${MOD_KEY}+8`, checked: !!w.marksVisible?.(), disabled: !ready() }),
      opt(w.editHeader && (() => w.editHeader('header')), 'Header and Footer', { icon: 'header', disabled: !w.canEditHeader?.('header') }),
      w.setMarkupView && w.markupViews && sub('Markup', w.markupViews().map(([mode, label]) => ({ label, radio: true, checked: w.markupView?.() === mode, onSelect: () => w.setMarkupView(mode) }))),
      sep,
      opt(w.zoomDialog, 'Zoom…', { icon: 'zoom', disabled: !ready() }),
      sub('Zoom To', [
        opt(w.setZoom && (() => w.setZoom(1)), '100%', { icon: 'zoom100', disabled: !ready() }),
        opt(w.zoomTo && (() => w.zoomTo('width')), 'Page Width', { icon: 'pageWidth', disabled: !ready() }),
        opt(w.zoomTo && (() => w.zoomTo('page')), 'One Page', { icon: 'onePage', disabled: !ready() }),
        opt(w.multiplePages, 'Multiple Pages', { icon: 'multiplePages', checked: !!w.multiplePagesActive?.(), disabled: !ready() }),
      ]),
      ctx.rulers && sub('Units', [['in', 'Inches'], ['cm', 'Centimeters']].map(([id, label]) => ({ label, radio: true, checked: ctx.rulers.unit === id, onSelect: () => ctx.rulers.setUnit(id) }))),
      sep,
      fullScreenItem(),
    ]);
  };

  function fullScreenItem() {
    if (!document.fullscreenEnabled) return null;
    const on = !!document.fullscreenElement;
    return { label: on ? 'Exit Full Screen' : 'Enter Full Screen', shortcut: sc('view.fullScreen'), onSelect: () => (on ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}) };
  }

  const insert = () => withExt('insert', [
    control(c.insertImage, 'Pictures…', { icon: 'pictures' }),
    opt(w.openShapes && (() => w.openShapes(anchor(), null)), 'Shapes…', { icon: 'shapes', disabled: !editable() }),
    c.insertTable && { label: 'Table…', icon: 'table', disabled: c.insertTable.disabled, onSelect: () => c.insertTable.openPalette(anchor()) },
    sep,
    control(c.hyperlink, 'Link…', { icon: 'link', shortcut: `${MOD_KEY}+K` }),
    control(c.bookmarks, 'Bookmark…', { icon: 'bookmark' }),
    opt(w.crossReference, 'Cross-reference…', { icon: 'crossReference', disabled: !editable() }),
    sep,
    opt(w.newComment, 'Comment', { icon: 'newComment', shortcut: IS_MAC ? 'Cmd+Option+A' : 'Ctrl+Alt+M', disabled: !w.canComment?.() }),
    sep,
    sub('Break', [
      control(c.pageBreak, 'Page Break', { icon: 'pageBreak', shortcut: `${MOD_KEY}+Enter` }),
      opt(w.insertColumnBreak, 'Column Break', { shortcut: `${MOD_KEY}+Shift+Enter`, disabled: !editable() }),
      opt(w.insertLineBreak, 'Text Wrapping Break', { shortcut: 'Shift+Enter', disabled: !editable() }),
      ...(w.sectionBreakItems?.() || []),
    ]),
    opt(w.insertBlankPage, 'Blank Page', { icon: 'blankPage', disabled: c.pageBreak.disabled }),
    w.coverPageItems && sub('Cover Page', w.coverPageItems() || []),
    sep,
    opt(w.insertFootnote, 'Footnote', { icon: 'footnote', shortcut: IS_MAC ? 'Cmd+Option+F' : 'Ctrl+Alt+F', disabled: !w.canInsertFootnote?.() }),
    opt(w.insertCaption, 'Caption…', { icon: 'caption', disabled: !editable() }),
    w.tocItems && sub('Table of Contents', w.tocItems() || []),
    w.pageNumberItems && sub('Page Numbers', w.pageNumberItems() || []),
    opt(w.editHeader && (() => w.editHeader('header')), 'Header', { icon: 'header', disabled: !w.canEditHeader?.('header') }),
    opt(w.editHeader && (() => w.editHeader('footer')), 'Footer', { icon: 'footer', disabled: !w.canEditHeader?.('footer') }),
    sep,
    opt(w.insertTextBox, 'Text Box', { icon: 'textBox', disabled: !editable() }),
    opt(w.insertDateTime, 'Date and Time…', { icon: 'dateTime', disabled: !editable() }),
    opt(w.insertSymbol, 'Symbol…', { icon: 'symbol', disabled: !editable() }),
  ]);

  const format = () => withExt('format', [
    { label: 'Font…', icon: 'fontDialog', shortcut: `${MOD_KEY}+D`, disabled: !editable(), onSelect: () => (w.fontDialog ? w.fontDialog() : ctx.toggleFormattingPane?.()) },
    w.textEffectItems && sub('Text Effects', w.textEffectItems() || []),
    control(c.paragraphGeometry, 'Paragraph…', { icon: 'paragraphDialog', shortcut: sc('format.paragraph') }),
    control(c.pageSetup, 'Document…', { icon: 'pageSetup' }),
    sep,
    w.bulletsAndNumbering ? opt(w.bulletsAndNumbering, 'Bullets and Numbering…', { icon: 'numbers', disabled: !editable() }) : sub('Bullets and Numbering', [
      control(c.bullets, 'Bulleted List', { icon: 'bullets', checked: c.bullets.getAttribute('aria-pressed') === 'true' }),
      control(c.numbers, 'Numbered List', { icon: 'numbers', checked: c.numbers.getAttribute('aria-pressed') === 'true' }),
      ...(w.multilevelItems ? [{ header: 'Multilevel List' }, ...(w.multilevelItems() || [])] : []),
      control(c.restart, 'Restart Numbering at 1', { icon: 'restartNumbering' }),
    ]),
    w.bordersAndShading ? opt(w.bordersAndShading, 'Borders and Shading…', { icon: 'borders', disabled: !editable() }) : control(c.paragraphBorders, 'Borders…', { icon: 'borders' }),
    c.paragraphShading && { label: 'Shading…', icon: 'shading', disabled: c.paragraphShading.disabled, onSelect: () => c.paragraphShading.openPalette(anchor()) },
    sep,
    w.columnItems && sub('Columns', w.columnItems() || []),
    w.tabsDialog ? opt(w.tabsDialog, 'Tabs…', { icon: 'tabStop', disabled: !editable() }) : control(c.paragraphGeometry, 'Tabs…', { icon: 'tabStop' }),
    opt(w.dropCap, 'Drop Cap…', { icon: 'dropCap', disabled: !editable() }),
    w.changeCase && sub('Change Case', [['Sentence case.', 'sentence'], ['lowercase', 'lower'], ['UPPERCASE', 'upper'], ['Capitalize Each Word', 'title'], ['tOGGLE cASE', 'toggle']]
      .map(([label, mode]) => ({ label, disabled: !editable(), onSelect: () => w.changeCase(mode) }))),
    sub('Line Spacing', [1, 1.15, 1.5, 2, 2.5, 3].map(value => ({ label: `${value}`, disabled: !editable(), shortcut: { 1: `${MOD_KEY}+1`, 1.5: `${MOD_KEY}+5`, 2: `${MOD_KEY}+2` }[value] || null,
      onSelect: () => { c.lineSpacing.value = String(value); c.lineSpacing.dispatchEvent(new Event('change', { bubbles: true })); } })).concat([sep, control(c.lineSpacingOptions, 'Line Spacing Options…')])),
    w.paragraphSpacingItems && sub('Paragraph Spacing', w.paragraphSpacingItems() || []),
    sep,
    w.stylesPane ? opt(w.stylesPane, 'Style…', { icon: 'stylesPane', shortcut: sc('format.styles') }) : control(c.editStyle, 'Modify Style…', { icon: 'editStyle' }),
    control(c.newStyle, 'New Style…', { icon: 'newStyle' }),
    opt(w.revealFormatting, 'Reveal Formatting…'),
    sep,
    w.pageColorItems && sub('Page Color', w.pageColorItems() || []),
    w.pageBorderItems && sub('Page Borders', w.pageBorderItems() || []),
    sep,
    w.wrapItems && sub('Wrap Text', w.wrapItems() || []),
    opt(w.arrange && (() => w.arrange('forward')), 'Bring Forward', { icon: 'bringForward', disabled: !w.canArrange?.() }),
    opt(w.arrange && (() => w.arrange('backward')), 'Send Backward', { icon: 'sendBackward', disabled: !w.canArrange?.() }),
    control(c.imageProperties, 'Picture…', { icon: 'pictures' }),
    sep,
    { label: 'Document Fonts…', icon: 'documentFonts', disabled: !ready(), onSelect: () => a.loadFontFiles?.() },
  ]);

  const tools = () => withExt('tools', [
    sub('Spelling and Grammar', w.spellingItems?.() || []),
    opt(w.wordCount, 'Word Count…', { icon: 'wordCount', disabled: !ready() }),
    opt(w.languageDialog, 'Language…', { icon: 'language', disabled: !ready() }),
    opt(w.preferences && (() => w.preferences('typing')), 'AutoCorrect Options…'),
    sep,
    w.toggleTracking && sub('Track Changes', [
      { label: 'Track Changes', icon: 'trackChanges', shortcut: `${MOD_KEY}+Shift+E`, checked: !!w.isTracking?.(), disabled: !w.canTrack?.(), onSelect: () => w.toggleTracking() },
      sep,
      opt(w.resolveChanges && (() => w.resolveChanges(true, 'all')), 'Accept All Changes', { icon: 'accept', disabled: !w.hasRevisions?.() }),
      opt(w.resolveChanges && (() => w.resolveChanges(false, 'all')), 'Reject All Changes', { icon: 'reject', disabled: !w.hasRevisions?.() }),
      opt(w.goChange && (() => w.goChange(1)), 'Next Change', { disabled: !w.hasRevisions?.() }),
      opt(w.goChange && (() => w.goChange(-1)), 'Previous Change', { disabled: !w.hasRevisions?.() }),
    ]),
    opt(w.readAloud, 'Read Aloud', { icon: 'readAloud', disabled: !ready() }),
    sep,
    opt(w.updateFields, 'Update Fields', { icon: 'updateFields', shortcut: 'F9', disabled: !w.canUpdateFields?.() }),
    sep,
    opt(w.customizeKeyboard, 'Customize Keyboard…', { icon: 'keyboard' }),
    opt(w.customizeQuickAccess, 'Customize Quick Access…'),
    opt(w.preferences, 'Preferences…', { icon: 'preferences' }),
  ]);

  const tableItem = (value, label, icon) => {
    const option = ctx.tableOption(value);
    return option ? { label, icon, disabled: c.tableActions.disabled || option.disabled, onSelect: ctx.tableAction(value) } : null;
  };
  // The table tools (views/table-tools.js), when present, provide the whole Table menu.
  const table = () => w.tableRibbon ? withExt('table', []) : withExt('table', [
    c.insertTable && { label: 'Insert Table…', icon: 'table', disabled: c.insertTable.disabled, onSelect: () => c.insertTable.openPalette(anchor()) },
    opt(w.drawTable, 'Draw Table'),
    sep,
    sub('Insert', [tableItem('addRow', 'Rows Below', 'insertBelow'), tableItem('addColumn', 'Columns to the Right', 'insertRight'), sep,
      tableItem('before', 'Paragraph Before Table', 'paragraphBefore'), tableItem('after', 'Paragraph After Table', 'paragraphAfter')]),
    sub('Delete', [tableItem('row', 'Rows', 'deleteRow'), tableItem('column', 'Columns', 'deleteColumn'), tableItem('table', 'Table', 'deleteTable')]),
    tableItem('mergeCells', 'Merge Cells', 'mergeCells'),
    tableItem('mergeBelow', 'Merge with Cell Below', 'mergeBelow'),
    tableItem('splitCell', 'Split Cells', 'splitCells'),
    sep,
    sub('AutoFit', [tableItem('fitContents', 'AutoFit to Contents', 'autofit'), tableItem('fitPage', 'AutoFit to Window', 'autofit')]),
    { label: 'Repeat Header Rows', icon: 'repeatHeader', disabled: c.tableActions.disabled || (ctx.tableOption('repeatHeader')?.disabled && ctx.tableOption('clearHeader')?.disabled),
      checked: !!ctx.tableOption('clearHeader') && !ctx.tableOption('clearHeader').disabled,
      onSelect: () => ctx.tableAction(ctx.tableOption('clearHeader') && !ctx.tableOption('clearHeader').disabled ? 'clearHeader' : 'repeatHeader')() },
    sep,
    control(c.tableProperties, 'Table Properties…', { icon: 'tableProperties' }),
    control(c.rowHeight, 'Row Height…', { icon: 'rowHeight' }),
    control(c.cellAlignment, 'Cell Alignment…', { icon: 'cellAlignment' }),
    control(c.cellMargins, 'Cell Margins…', { icon: 'cellMargins' }),
    control(c.cellShading, 'Cell Shading…', { icon: 'cellShading' }),
    control(c.cellBorders, 'Cell Borders…', { icon: 'cellBorders' }),
  ]);

  const windowMenu = () => withExt('window', [
    { label: 'New Window', onSelect: () => window.open(location.href, '_blank', 'noopener') },
    fullScreenItem(),
    sep,
    control(c.outline, 'Navigation Pane', { icon: 'navigationPane', checked: c.outline.getAttribute('aria-expanded') === 'true' }),
    opt(w.toggleReviewingPane, 'Reviewing Pane', { icon: 'reviewingPane', checked: !!w.reviewingPaneShown?.() }),
    ctx.toggleFormattingPane && { label: 'Formatting Pane', icon: 'formattingPane', checked: !!ctx.formattingPaneShown?.(), onSelect: () => ctx.toggleFormattingPane() },
    sep,
    { label: 'All Documents', icon: 'home', onSelect: () => a.goHome?.() },
  ]);

  const help = () => withExt('help', [
    ctx.focusSearch && { label: 'Search for a Command…', icon: 'find', shortcut: sc('app.search'), onSelect: () => ctx.focusSearch() },
    { label: 'Keyboard Shortcuts', icon: 'keyboard', shortcut: `${MOD_KEY}+/`, onSelect: () => ctx.openShortcuts() },
    ctx.showKeyTips && { label: 'Show KeyTips', hint: IS_MAC ? 'Option' : 'Alt', onSelect: () => ctx.showKeyTips() },
  ]);

  const builders = { file, edit, view, insert, format, tools, table, window: windowMenu, help };
  return MENU_IDS.map(id => ({ id, label: LABELS[id], items: () => ctx.inDocument(builders[id]()) }));
}

/** Drop missing entries, and separators at the ends or doubled. */
export function tidy(items) {
  const out = [];
  for (const item of items) {
    if (!item) continue;
    if (item.separator && (!out.length || out.at(-1).separator)) continue;
    out.push(item);
  }
  while (out.at(-1)?.separator) out.pop();
  return out;
}
