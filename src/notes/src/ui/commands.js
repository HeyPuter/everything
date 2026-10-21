import { h } from '../lib/dom.js';
import { icon, hasIcon } from '../lib/icons.js';
import { FONT_COLORS, HIGHLIGHT_COLORS, PAGE_COLORS } from '../data/colors.js';
import { TAGS, TAG_BY_ID } from '../data/tags.js';
import * as fmt from '../editor/format.js';
import * as table from '../editor/table.js';
import { toggleTag, removeAllTags, activeTags } from '../editor/tag-edit.js';
import { PENS, SHAPES, INK_COLORS, INK_WIDTHS } from '../editor/ink.js';
import { getTheme, setTheme, prefs, setPref } from './prefs.js';

/*
 * Every user-facing action, keyed by id. Ribbon buttons, menus, Tell Me and
 * keyboard shortcuts all run commands from here:
 *   { id, label, short, icon, key, desc, run(app, arg), active(app), enabled(app), menu(app), color(app), dynamicIcon(app) }
 */

const editable = (app) => Boolean(app.editor && app.editor.page && !app.editor.readOnly);
const inText = (app) => editable(app) && Boolean(app.format.editable);
const inBody = (app) => editable(app) && Boolean(app.format.inBody);
const inTable = (app) => inBody(app) && Boolean(app.format.inTable);

/** Runs a formatting action on the note's selection, restoring it if a ribbon control took focus. */
function onSelection(app, fn) {
  if (!app.editor) return;
  if (!app.format.editable || !document.activeElement?.closest?.('.outline-body, .page-title')) app.editor.restoreRange();
  fn();
  app.editor.markActiveDirty?.();
  app.updateFormatState();
}

function bodyAction(fn) {
  return (app, arg) => {
    if (!app.editor) return;
    if (!document.activeElement?.closest?.('.outline-body')) app.editor.ensureCaret();
    fn(app, arg);
    app.editor.markActiveDirty();
    app.updateFormatState();
  };
}

function lastColor(key, fallback) {
  return prefs()[key] || fallback;
}

export function buildCommands() {
  const list = [
    // ------------------------------------------------------------ clipboard
    { id: 'paste', label: 'Paste', icon: 'paste', key: 'Mod+V', desc: 'Add content from the Clipboard.', enabled: editable, run: (app) => app.paste() },
    { id: 'cut', label: 'Cut', icon: 'cut', key: 'Mod+X', desc: 'Remove the selection and put it on the Clipboard.', enabled: inText, run: (app) => app.clipboard('cut') },
    { id: 'copy', label: 'Copy', icon: 'copy', key: 'Mod+C', desc: 'Put a copy of the selection on the Clipboard.', enabled: (app) => Boolean(app.editor?.page), run: (app) => app.clipboard('copy') },
    { id: 'formatPainter', label: 'Format Painter', short: 'Format', icon: 'formatPainter', key: 'Mod+Shift+C', desc: 'Copy the formatting at the cursor, then select text to apply it.', enabled: inText, active: (app) => Boolean(app.painter), run: (app) => app.toggleFormatPainter() },

    // ------------------------------------------------------------ font
    { id: 'bold', label: 'Bold', icon: 'bold', key: 'Mod+B', enabled: inText, active: (app) => app.format.bold, run: (app) => onSelection(app, () => fmt.toggleInline('bold')) },
    { id: 'italic', label: 'Italic', icon: 'italic', key: 'Mod+I', enabled: inText, active: (app) => app.format.italic, run: (app) => onSelection(app, () => fmt.toggleInline('italic')) },
    { id: 'underline', label: 'Underline', icon: 'underline', key: 'Mod+U', enabled: inText, active: (app) => app.format.underline, run: (app) => onSelection(app, () => fmt.toggleInline('underline')) },
    { id: 'strike', label: 'Strikethrough', icon: 'strike', key: 'Mod+Minus', enabled: inText, active: (app) => app.format.strike, run: (app) => onSelection(app, () => fmt.toggleInline('strikeThrough')) },
    { id: 'subscript', label: 'Subscript', icon: 'subscript', key: 'Mod+Equal', enabled: inBody, active: (app) => app.format.subscript, run: (app) => onSelection(app, () => fmt.toggleInline('subscript')) },
    { id: 'superscript', label: 'Superscript', icon: 'superscript', key: 'Mod+Shift+Equal', enabled: inBody, active: (app) => app.format.superscript, run: (app) => onSelection(app, () => fmt.toggleInline('superscript')) },
    {
      id: 'highlight', label: 'Text Highlight Color', short: 'Highlight', icon: 'highlight', key: 'Mod+Shift+H', enabled: inBody,
      color: () => lastColor('highlightColor', HIGHLIGHT_COLORS[0]),
      run: (app, color) => onSelection(app, () => fmt.setHighlight(color === undefined ? lastColor('highlightColor', HIGHLIGHT_COLORS[0]) : color)),
      menu: (app) => [
        { type: 'swatches', label: 'Highlight colors', colors: HIGHLIGHT_COLORS, selected: lastColor('highlightColor', HIGHLIGHT_COLORS[0]), run: (c) => { setPref('highlightColor', c); app.runCommand('highlight', c); } },
        { type: 'sep' },
        { label: 'No Color', icon: 'x', run: () => app.runCommand('highlight', null) },
      ],
    },
    {
      id: 'fontColor', label: 'Font Color', short: 'Font Color', icon: 'fontColor', enabled: inBody,
      color: () => lastColor('fontColor', '#c00000'),
      run: (app, color) => onSelection(app, () => fmt.setColor(color === undefined ? lastColor('fontColor', '#c00000') : color)),
      menu: (app) => [
        { label: 'Automatic', icon: 'fontColor', run: () => app.runCommand('fontColor', null) },
        { type: 'sep' },
        { type: 'swatches', label: 'Font colors', colors: FONT_COLORS, selected: lastColor('fontColor', '#c00000'), run: (c) => { setPref('fontColor', c); app.runCommand('fontColor', c); } },
      ],
    },
    { id: 'clearFormat', label: 'Clear All Formatting', short: 'Clear', icon: 'clearFormat', key: 'Mod+Shift+N', enabled: inText, run: (app) => onSelection(app, () => fmt.clearFormatting()) },
    { id: 'growFont', label: 'Increase Font Size', icon: 'grow', key: 'Mod+Shift+Period', enabled: inBody, run: (app) => onSelection(app, () => fmt.stepFontSize(1)) },
    { id: 'shrinkFont', label: 'Decrease Font Size', icon: 'shrink', key: 'Mod+Shift+Comma', enabled: inBody, run: (app) => onSelection(app, () => fmt.stepFontSize(-1)) },

    // ------------------------------------------------------------ paragraph
    {
      id: 'bullets', label: 'Bullets', icon: 'bullets', key: 'Mod+Period', enabled: inBody, active: (app) => app.format.bullets,
      run: bodyAction(() => fmt.toggleList(false)),
      menu: (app) => [
        { type: 'header', label: 'Bullet Library' },
        ...[['disc', 'Filled Round Bullet'], ['circle', 'Hollow Round Bullet'], ['square', 'Filled Square Bullet'], ['"– "', 'Dash Bullet'], ['"→ "', 'Arrow Bullet'], ['"✓ "', 'Check Mark Bullet']].map(([type, label]) => ({ label, run: () => bodyAction(() => fmt.setListStyle(type, false))(app) })),
        { type: 'sep' },
        { label: 'None', run: () => app.format.bullets && app.runCommand('bullets') },
      ],
    },
    {
      id: 'numbering', label: 'Numbering', icon: 'numbering', key: 'Mod+Slash', enabled: inBody, active: (app) => app.format.numbering,
      run: bodyAction(() => fmt.toggleList(true)),
      menu: (app) => [
        { type: 'header', label: 'Numbering Library' },
        ...[['decimal', '1. 2. 3.'], ['lower-alpha', 'a. b. c.'], ['upper-alpha', 'A. B. C.'], ['lower-roman', 'i. ii. iii.'], ['upper-roman', 'I. II. III.']].map(([type, label]) => ({ label, run: () => bodyAction(() => fmt.setListStyle(type, true))(app) })),
        { type: 'sep' },
        { label: 'None', run: () => app.format.numbering && app.runCommand('numbering') },
      ],
    },
    { id: 'outdent', label: 'Decrease Indent Position', icon: 'outdent', key: 'Alt+Shift+ArrowLeft', enabled: inBody, run: bodyAction(() => fmt.indent(-1)) },
    { id: 'indent', label: 'Increase Indent Position', icon: 'indent', key: 'Alt+Shift+ArrowRight', enabled: inBody, run: bodyAction(() => fmt.indent(1)) },
    {
      id: 'align', label: 'Paragraph Alignment', short: 'Align', icon: 'alignLeft', enabled: inBody,
      dynamicIcon: (app) => (app.format.align === 'center' ? 'alignCenter' : ['right', 'end'].includes(app.format.align) ? 'alignRight' : 'alignLeft'),
      menu: (app) => [
        { label: 'Align Left', icon: 'alignLeft', shortcut: 'Mod+L', checked: !['center', 'right', 'end'].includes(app.format.align), run: () => app.runCommand('alignLeft') },
        { label: 'Center', icon: 'alignCenter', shortcut: 'Mod+Shift+E', checked: app.format.align === 'center', run: () => app.runCommand('alignCenter') },
        { label: 'Align Right', icon: 'alignRight', shortcut: 'Mod+R', checked: ['right', 'end'].includes(app.format.align), run: () => app.runCommand('alignRight') },
      ],
    },
    { id: 'alignLeft', label: 'Align Left', icon: 'alignLeft', key: 'Mod+L', enabled: inBody, run: (app) => onSelection(app, () => fmt.align('left')) },
    { id: 'alignCenter', label: 'Center', icon: 'alignCenter', key: 'Mod+Shift+E', enabled: inBody, run: (app) => onSelection(app, () => fmt.align('center')) },
    { id: 'alignRight', label: 'Align Right', icon: 'alignRight', key: 'Mod+R', enabled: inBody, run: (app) => onSelection(app, () => fmt.align('right')) },
    { id: 'moveUp', label: 'Move Paragraph Up', icon: 'paraUp', key: 'Alt+Shift+ArrowUp', enabled: inBody, run: bodyAction(() => fmt.moveBlock(-1)) },
    { id: 'moveDown', label: 'Move Paragraph Down', icon: 'paraDown', key: 'Alt+Shift+ArrowDown', enabled: inBody, run: bodyAction(() => fmt.moveBlock(1)) },

    // ------------------------------------------------------------ styles and tags
    ...fmt.STYLES.map((s) => ({ id: `style:${s.id}`, label: s.label, key: s.key, enabled: inBody, active: (app) => app.format.styleId === s.id, run: bodyAction(() => fmt.setBlockStyle(s.id)) })),
    ...TAGS.map((t) => ({ id: `tag:${t.id}`, label: `${t.label} Tag`, key: t.key ? `Mod+${t.key}` : undefined, enabled: inBody, active: (app) => app.activeTags.has(t.id), run: bodyAction(() => app_announceTag(t.id)) })),
    { id: 'todo', label: 'To Do Tag', short: 'To Do', icon: 'todoDone', desc: 'Add a check box to the paragraph.', key: 'Mod+1', enabled: inBody, active: (app) => app.activeTags.has('todo'), run: (app) => app.runCommand('tag:todo') },
    { id: 'removeTags', label: 'Remove Tag', icon: 'x', key: 'Mod+0', enabled: inBody, run: bodyAction(() => removeAllTags()) },
    { id: 'findTags', label: 'Find Tags', icon: 'findTags', desc: 'See every tagged note in one place.', enabled: (app) => Boolean(app.store), active: (app) => app.taskPaneKind === 'tags', run: (app) => app.toggleTaskPane('tags') },

    // ------------------------------------------------------------ voice, assist, email
    { id: 'dictate', label: 'Dictate', icon: 'dictate', desc: 'Type with your voice.', enabled: (app) => editable(app) && app.dictation.supported, active: (app) => app.dictation.active, run: (app) => app.dictation.toggle() },
    { id: 'assist', label: 'Assist', icon: 'sparkles', desc: 'Summarize, find action items or rewrite with AI.', enabled: (app) => Boolean(app.editor?.page) && app.ai.available(), active: (app) => app.taskPaneKind === 'assist', run: (app) => app.toggleTaskPane('assist') },
    { id: 'emailPage', label: 'Email Page', short: 'Email Page', icon: 'mail', desc: 'Send this page in an email message.', enabled: (app) => Boolean(app.editor?.page), run: (app) => app.emailPage() },

    // ------------------------------------------------------------ insert
    {
      id: 'insertTable', label: 'Table', icon: 'table', desc: 'Insert a table to organize information.', enabled: editable,
      menu: (app) => [{ type: 'custom', render: (close) => app.tablePicker(close) }, { type: 'sep' }, { label: 'Insert Table...', icon: 'table', run: () => app.insertTableDialog() }],
    },
    {
      id: 'insertFile', label: 'Attach File', short: 'File', icon: 'file', desc: 'Attach a file to the page.', enabled: editable, run: (app) => app.pickFiles({ attach: true }),
      menu: (app) => [
        { label: 'From This Device...', icon: 'upload', run: () => app.pickFiles({ attach: true }) },
        { label: 'From Puter...', icon: 'cloud', disabled: !app.cloudPicker(), run: () => app.pickFromCloud({ attach: true }) },
      ],
    },
    { id: 'insertPrintout', label: 'File Printout', short: 'Printout', icon: 'printout', desc: 'Insert the pages of a PDF as pictures, with the file attached.', enabled: editable, run: (app) => app.insertPrintout() },
    {
      id: 'insertPicture', label: 'Pictures', short: 'Picture', icon: 'picture', desc: 'Insert pictures from your device or your Puter files.', enabled: editable, run: (app) => app.pickFiles({ accept: 'image/*' }),
      menu: (app) => [
        { label: 'From This Device...', icon: 'upload', run: () => app.pickFiles({ accept: 'image/*' }) },
        { label: 'From Puter...', icon: 'cloud', disabled: !app.cloudPicker(), run: () => app.pickFromCloud({ accept: 'image/*' }) },
      ],
    },
    { id: 'insertScreenshot', label: 'Screenshot', icon: 'screenshot', desc: 'Capture a window or screen and insert it.', enabled: (app) => editable(app) && Boolean(navigator.mediaDevices?.getDisplayMedia), run: (app) => app.insertScreenshot() },
    { id: 'insertLink', label: 'Link', icon: 'link', key: 'Mod+K', desc: 'Add a link to a web page, file or another page in your notebooks.', enabled: editable, run: (app) => app.linkDialog() },
    { id: 'insertEquation', label: 'Equation', icon: 'equation', desc: 'Insert a math equation.', enabled: editable, run: (app) => app.equationDialog() },
    { id: 'insertDate', label: 'Date', icon: 'date', key: 'Alt+Shift+D', enabled: editable, run: bodyAction(() => fmt.insertText(new Date().toLocaleDateString())) },
    { id: 'insertTime', label: 'Time', icon: 'time', key: 'Alt+Shift+T', enabled: editable, run: bodyAction(() => fmt.insertText(new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))) },
    { id: 'insertDateTime', label: 'Date & Time', icon: 'dateTime', key: 'Alt+Shift+F', enabled: editable, run: bodyAction(() => fmt.insertText(`${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`)) },
    { id: 'insertAudio', label: 'Audio Recording', short: 'Audio Recording', icon: 'recordAudio', desc: 'Record audio and add it to the page.', enabled: (app) => editable(app) && Boolean(window.MediaRecorder), active: (app) => app.recorder?.kind === 'audio', run: (app) => app.record('audio') },
    { id: 'insertVideo', label: 'Video Recording', short: 'Video Recording', icon: 'recordVideo', desc: 'Record video and add it to the page.', enabled: (app) => editable(app) && Boolean(window.MediaRecorder), active: (app) => app.recorder?.kind === 'video', run: (app) => app.record('video') },
    { id: 'pageTemplates', label: 'Page Templates', short: 'Page Templates', icon: 'template', desc: 'Start a new page from a template.', enabled: (app) => Boolean(app.state.sectionId), run: (app) => app.templatesDialog() },
    { id: 'insertLine', label: 'Horizontal Line', icon: 'hrLine', enabled: editable, run: bodyAction(() => fmt.insertHtml('<hr><p><br></p>')) },

    // ------------------------------------------------------------ table (contextual)
    { id: 'tableAbove', label: 'Insert Above', icon: 'rowAbove', enabled: inTable, run: bodyAction(() => table.insertRow('above')) },
    { id: 'tableBelow', label: 'Insert Below', icon: 'rowBelow', enabled: inTable, run: bodyAction(() => table.insertRow('below')) },
    { id: 'tableLeft', label: 'Insert Left', icon: 'colLeft', enabled: inTable, run: bodyAction(() => table.insertColumn('left')) },
    { id: 'tableRight', label: 'Insert Right', icon: 'colRight', enabled: inTable, run: bodyAction(() => table.insertColumn('right')) },
    {
      id: 'tableDelete', label: 'Delete', icon: 'trash', enabled: inTable,
      menu: (app) => [
        { label: 'Delete Table', run: () => bodyAction(() => table.deleteTable())(app) },
        { label: 'Delete Columns', run: () => bodyAction(() => table.deleteColumn())(app) },
        { label: 'Delete Rows', run: () => bodyAction(() => table.deleteRow())(app) },
      ],
    },
    {
      id: 'tableSelect', label: 'Select', icon: 'pointer', enabled: inTable,
      menu: (app) => ['table', 'column', 'row', 'cell'].map((part) => ({ label: `Select ${part[0].toUpperCase()}${part.slice(1)}`, run: () => { app.editor.restoreRange(); table.selectTablePart(part); } })),
    },
    { id: 'tableBorders', label: 'Hide Borders', icon: 'grid', enabled: inTable, active: () => table.bordersHidden(), run: bodyAction(() => table.toggleBorders()) },
    { id: 'tableHeader', label: 'Header Row', icon: 'headerRow', enabled: inTable, active: () => table.hasHeaderRow(), run: bodyAction(() => table.toggleHeaderRow()) },
    {
      id: 'tableShading', label: 'Shading', icon: 'pageColor', enabled: inTable,
      menu: (app) => [
        { type: 'swatches', label: 'Shading colors', colors: [...HIGHLIGHT_COLORS, '#f2f2f2', '#d9d9d9', '#dce9f8', '#fde7d6', '#e0f2e0', '#ece2f6'], run: (c) => bodyAction(() => table.shadeCells(c))(app) },
        { type: 'sep' },
        { label: 'No Color', run: () => bodyAction(() => table.shadeCells(null))(app) },
      ],
    },
    {
      id: 'tableAlign', label: 'Cell Alignment', short: 'Align', icon: 'alignLeft', enabled: inTable,
      menu: (app) => [['left', 'Align Left', 'alignLeft'], ['center', 'Center', 'alignCenter'], ['right', 'Align Right', 'alignRight']].map(([w, label, ic]) => ({ label, icon: ic, run: () => bodyAction(() => table.alignCells(w))(app) })),
    },
    {
      id: 'tableSort', label: 'Sort', icon: 'sortAZ', enabled: inTable,
      menu: (app) => [
        { label: 'Sort Ascending', run: () => bodyAction(() => table.sortTable(false))(app) },
        { label: 'Sort Descending', run: () => bodyAction(() => table.sortTable(true))(app) },
      ],
    },
    { id: 'tableToText', label: 'Convert to Text', icon: 'tableToText', enabled: inTable, run: bodyAction(() => table.tableToText()) },

    // ------------------------------------------------------------ draw
    { id: 'toolType', label: 'Type', icon: 'type', desc: 'Type and select text.', enabled: editable, active: (app) => app.editor?.ink.tool === 'type', run: (app) => app.setTool('type') },
    { id: 'toolLasso', label: 'Lasso Select', short: 'Lasso Select', icon: 'lasso', desc: 'Draw around ink and containers to select them.', enabled: editable, active: (app) => app.editor?.ink.tool === 'lasso', run: (app) => app.setTool('lasso') },
    { id: 'toolSpace', label: 'Insert Space', short: 'Insert Space', icon: 'insertSpace', desc: 'Drag down to add space, or up to remove it.', enabled: editable, active: (app) => app.editor?.ink.tool === 'space', run: (app) => app.setTool('space') },
    { id: 'toolEraser', label: 'Eraser', icon: 'eraser', desc: 'Erase ink strokes and shapes.', enabled: editable, active: (app) => app.editor?.ink.tool === 'eraser', run: (app) => app.setTool('eraser') },
    {
      id: 'penSettings', label: 'Color & Thickness', short: 'Color & Thickness', icon: 'palette', desc: 'Choose the pen color and thickness.', enabled: editable,
      menu: (app) => {
        const pen = app.editor?.ink.pen || PENS[0];
        return [
          { type: 'header', label: 'Color' },
          { type: 'swatches', label: 'Ink colors', colors: INK_COLORS, selected: pen.color, run: (c) => app.setPen({ ...pen, color: c, id: 'custom' }, { color: c }) },
          { type: 'sep' },
          { type: 'header', label: 'Thickness' },
          ...INK_WIDTHS.map((w) => ({ label: `${w} pt`, radio: true, checked: pen.width === w, run: () => app.setPen({ ...pen, width: w, id: 'custom' }, { width: w }) })),
          { type: 'sep' },
          { label: 'Highlighter', checked: Boolean(pen.highlighter), run: () => app.setPen({ ...pen, highlighter: !pen.highlighter, id: 'custom' }, { highlighter: !pen.highlighter }) },
        ];
      },
    },
    { id: 'inkToShape', label: 'Ink to Shape', short: 'Ink to Shape', icon: 'inkToShape', desc: 'Turn lines, circles, rectangles and triangles you draw into neat shapes.', enabled: editable, active: (app) => Boolean(app.editor?.ink.inkToShape), run: (app) => {
      const ink = app.editor.ink;
      ink.inkToShape = !ink.inkToShape;
      setPref('inkToShape', ink.inkToShape);
      if (ink.inkToShape && ink.tool !== 'pen') app.setTool('pen', { pen: ink.pen });
      app.ribbon.refresh();
    } },
    { id: 'deleteInk', label: 'Delete', icon: 'trash', desc: 'Delete the selected ink or containers.', enabled: (app) => editable(app) && Boolean(app.editor.ink.selected.size || app.editor.selectedOutlines.size), run: (app) => app.editor.deleteSelectedOutlines() },

    // ------------------------------------------------------------ view
    { id: 'toggleNav', label: 'Navigation Pane', short: 'Navigation', icon: 'panel', key: 'Mod+Shift+G', desc: 'Show or hide the notebook navigation.', active: (app) => app.state.navVisible, run: (app) => app.toggleNav() },
    {
      id: 'navPanes', label: 'Navigation Panes', short: 'Navigation Panes', icon: 'panel',
      menu: (app) => [
        { label: 'Navigation Pane', checked: app.state.navVisible, run: () => app.toggleNav() },
        { label: 'Page List', checked: app.state.pagesVisible, run: () => app.togglePages() },
      ],
    },
    { id: 'reader', label: 'Immersive Reader', short: 'Immersive Reader', icon: 'reader', desc: 'Read the page with adjustable text and read-aloud.', enabled: (app) => Boolean(app.editor?.page), run: (app) => app.openReader() },
    {
      id: 'pageColor', label: 'Page Color', icon: 'pageColor', enabled: editable,
      menu: (app) => [
        { label: 'No Color', checked: !app.editor.page.color, run: () => app.setPageColor(null) },
        { type: 'sep' },
        { type: 'swatches', label: 'Page colors', colors: PAGE_COLORS.map((c) => ({ value: c.light, label: c.label })), selected: PAGE_COLORS.find((c) => c.id === app.editor.page.color)?.light, run: (v) => app.setPageColor(PAGE_COLORS.find((c) => c.light === v)?.id || null) },
      ],
    },
    {
      id: 'ruleLines', label: 'Rule Lines', icon: 'ruleLines', enabled: editable,
      menu: (app) => {
        const r = app.editor.page.rules;
        const opt = (id, label) => ({ label, radio: true, checked: r === id, run: () => app.setRules(id) });
        return [
          { type: 'header', label: 'Rule Lines' },
          opt('narrow', 'Narrow Ruled'),
          opt('college', 'College Ruled'),
          opt('standard', 'Standard Ruled'),
          opt('wide', 'Wide Ruled'),
          { type: 'header', label: 'Grid Lines' },
          opt('grid-small', 'Small Grid'),
          opt('grid-medium', 'Medium Grid'),
          opt('grid-large', 'Large Grid'),
          opt('grid-xl', 'Very Large Grid'),
          { type: 'sep' },
          { label: 'None', radio: true, checked: !r, run: () => app.setRules(null) },
          { type: 'sep' },
          { label: 'Always Create Pages with Rule Lines', checked: Boolean(prefs().defaultRules), run: () => setPref('defaultRules', prefs().defaultRules ? null : r || 'college') },
        ];
      },
    },
    { id: 'deletedNotes', label: 'Deleted Notes', short: 'Deleted Notes', icon: 'trash', desc: 'See deleted pages and sections and restore them.', run: (app) => app.openDeletedNotes() },
    { id: 'pageVersions', label: 'Page Versions', short: 'Page Versions', icon: 'history', desc: 'See and restore earlier versions of this page.', enabled: editable, active: (app) => app.taskPaneKind === 'versions', run: (app) => app.toggleTaskPane('versions') },
    { id: 'zoomOut', label: 'Zoom Out', icon: 'zoomOut', key: 'Mod+Alt+Minus', enabled: (app) => Boolean(app.editor?.page), run: (app) => app.editor.stepZoom(-1) },
    { id: 'zoomIn', label: 'Zoom In', icon: 'zoomIn', key: 'Mod+Alt+Equal', enabled: (app) => Boolean(app.editor?.page), run: (app) => app.editor.stepZoom(1) },
    { id: 'zoom100', label: '100%', icon: 'zoom100', enabled: (app) => Boolean(app.editor?.page), run: (app) => app.editor.setZoom(1) },
    { id: 'pageWidth', label: 'Page Width', icon: 'pageWidth', enabled: (app) => Boolean(app.editor?.page), run: (app) => app.editor.fitWidth() },
    { id: 'fullPage', label: 'Full Page View', short: 'Full Page View', icon: 'fullPage', key: 'F11', desc: 'Hide the ribbon and navigation to focus on the page.', active: (app) => app.state.fullPage, run: (app) => app.toggleFullPage() },
    { id: 'switchBackground', label: 'Switch Background', short: 'Switch Background', icon: 'switchBackground', desc: 'Show the page with a light background while the app is dark.', enabled: () => document.documentElement.dataset.themeResolved === 'dark', active: (app) => app.editor?.surface === 'light', run: (app) => app.switchBackground() },
    { id: 'newWindow', label: 'New Window', icon: 'external', desc: 'Open this page in another window.', enabled: (app) => Boolean(app.state.pageId), run: (app) => app.newWindow() },
    {
      id: 'theme', label: 'App Theme', short: 'Theme', icon: 'sun', desc: 'Use light, dark or your system setting.',
      dynamicIcon: () => ({ system: 'monitor', dark: 'moon' }[getTheme()] || 'sun'),
      menu: (app) => [['system', 'Use System Setting', 'monitor'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']].map(([id, label, ic]) => ({ label, icon: ic, radio: true, checked: getTheme() === id, run: () => { setTheme(id); app.themeChanged(); } })),
    },

    // ------------------------------------------------------------ notebook / app
    { id: 'newPage', label: 'New Page', icon: 'newPage', key: 'Mod+Alt+N', run: (app) => app.newPage() },
    { id: 'newSubpage', label: 'New Subpage', icon: 'subpage', key: 'Mod+Shift+Alt+N', run: (app) => app.newPage({ sub: true }) },
    { id: 'newSection', label: 'New Section', icon: 'newSection', key: 'Mod+Alt+T', run: (app) => app.newSection() },
    { id: 'newSectionGroup', label: 'New Section Group', icon: 'sectionGroup', run: (app) => app.newSectionGroup() },
    { id: 'newNotebook', label: 'New Notebook', icon: 'notebook', run: (app) => app.newNotebook() },
    { id: 'makeSubpage', label: 'Make Subpage', icon: 'subpage', key: 'Mod+Alt+BracketRight', enabled: (app) => Boolean(app.state.pageId), run: (app) => app.setPageLevel(1) },
    { id: 'promoteSubpage', label: 'Promote Subpage', icon: 'promote', key: 'Mod+Alt+BracketLeft', enabled: (app) => Boolean(app.state.pageId), run: (app) => app.setPageLevel(-1) },
    { id: 'lockAll', label: 'Lock All Protected Sections', icon: 'lock', key: 'Mod+Alt+L', run: (app) => app.lockAll() },
    { id: 'deletePage', label: 'Delete Page', icon: 'trash', enabled: (app) => Boolean(app.state.pageId), run: (app) => app.deletePage(app.state.pageId) },
    { id: 'movePage', label: 'Move or Copy Page...', icon: 'folderOpen', enabled: (app) => Boolean(app.state.pageId), run: (app) => app.moveDialog('page', app.state.pageId) },
    { id: 'copyPageLink', label: 'Copy Link to Page', icon: 'link', enabled: (app) => Boolean(app.state.pageId), run: (app) => app.copyLink('page', app.state.pageId) },
    { id: 'nextPage', label: 'Next Page', icon: 'down', key: 'Ctrl+PageDown', run: (app) => app.stepPage(1) },
    { id: 'prevPage', label: 'Previous Page', icon: 'up', key: 'Ctrl+PageUp', run: (app) => app.stepPage(-1) },
    { id: 'search', label: 'Search Notebooks', icon: 'search', key: 'Mod+E', desc: 'Search all your notebooks.', active: (app) => app.state.railView === 'search', run: (app) => app.setRailView('search', { focus: true }) },
    { id: 'searchAlt', label: 'Search Notebooks', icon: 'search', key: 'Mod+Alt+F', hidden: () => true, run: (app) => app.setRailView('search', { focus: true }) },
    { id: 'recent', label: 'Recent Notes', icon: 'recent', active: (app) => app.state.railView === 'recent', run: (app) => app.setRailView('recent') },
    { id: 'notebooks', label: 'Notebooks', icon: 'notebooks', active: (app) => app.state.railView === 'notebooks', run: (app) => app.setRailView('notebooks') },
    { id: 'findOnPage', label: 'Find on Page', icon: 'search', key: 'Mod+F', enabled: (app) => Boolean(app.editor?.page), run: (app) => app.find.open() },
    { id: 'undo', label: 'Undo', icon: 'undo', key: 'Mod+Z', enabled: (app) => Boolean(app.editor?.history.canUndo() || app.editor?.commitSoon.pending()), run: (app) => app.editor.undo() },
    { id: 'redo', label: 'Redo', icon: 'redo', key: 'Mod+Y', enabled: (app) => Boolean(app.editor?.history.canRedo()), run: (app) => app.editor.redo() },
    { id: 'print', label: 'Print', icon: 'print', key: 'Mod+P', enabled: (app) => Boolean(app.editor?.page), run: () => window.print() },
    {
      id: 'export', label: 'Export', icon: 'download', enabled: (app) => Boolean(app.store),
      menu: (app) => [
        { type: 'header', label: 'This page' },
        { label: 'Web Page (.html)', icon: 'globe', disabled: !app.state.pageId, run: () => app.exportPage('html') },
        { label: 'Markdown (.md)', icon: 'fileText', disabled: !app.state.pageId, run: () => app.exportPage('md') },
        { label: 'Plain Text (.txt)', icon: 'fileGeneric', disabled: !app.state.pageId, run: () => app.exportPage('txt') },
        { label: 'PDF (Print)', icon: 'print', disabled: !app.state.pageId, run: () => window.print() },
        { type: 'sep' },
        { type: 'header', label: 'Backup' },
        { label: 'Export Section (.html)', icon: 'download', disabled: !app.state.sectionId, run: () => app.exportSection() },
        { label: 'Export Notebook Backup (.json)', icon: 'download', run: () => app.exportNotebook() },
      ],
    },
    { id: 'import', label: 'Import', icon: 'upload', desc: 'Import Markdown, HTML, text or a notebook backup.', run: (app) => app.importFiles() },
    { id: 'share', label: 'Share', icon: 'share', enabled: (app) => Boolean(app.editor?.page), run: (app) => app.shareDialog() },
    { id: 'syncNow', label: 'Sync Now', icon: 'sync', key: 'Mod+S', run: (app) => app.syncNow() },
    { id: 'shortcuts', label: 'Keyboard Shortcuts', icon: 'keyboard', key: 'Mod+Shift+Slash', run: (app) => app.shortcutsDialog() },
    { id: 'about', label: 'About Notes', icon: 'info', run: (app) => app.aboutDialog() },
    { id: 'help', label: 'Help', icon: 'question', key: 'F1', run: (app) => app.helpDialog() },
    { id: 'collapseRibbon', label: 'Collapse the Ribbon', icon: 'chevUp', key: 'Mod+F1', run: (app) => app.ribbon.toggleCollapsed() },
    { id: 'tellMe', label: 'Tell Me', icon: 'tellMe', key: 'Alt+Q', run: (app) => app.focusTellMe() },
  ];
  return new Map(list.map((c) => [c.id, c]));
}

// Tag shortcuts cycle: add, mark done, remove.
function app_announceTag(id) {
  toggleTag(id, { cycle: true });
}

/** Galleries rendered in the ribbon (and as dropdowns when space is short). */
export function buildGalleries() {
  return {
    styles: {
      label: 'Styles',
      short: 'Styles',
      icon: 'pilcrow',
      items: (app) => fmt.STYLES.slice(0, 6).concat(fmt.STYLES.slice(-1)).map((s) => ({
        label: s.label,
        key: s.key,
        id: s.id,
        render: () => h(`span.style-preview.${s.id}`, s.label),
        run: () => app.runCommand(`style:${s.id}`),
      })),
      active: (app, entry) => app.format.styleId === entry.id,
      enabled: inBody,
      menu: (app) => fmt.STYLES.map((s) => ({ label: s.label, shortcut: s.key, radio: true, checked: app.format.styleId === s.id, disabled: !inBody(app), run: () => app.runCommand(`style:${s.id}`) })),
    },
    tags: {
      label: 'Tags',
      short: 'Tags',
      icon: 'flag',
      items: (app) => TAGS.slice(0, 6).map((t) => ({
        label: t.label,
        key: t.key ? `Mod+${t.key}` : undefined,
        id: t.id,
        render: () => [tagGlyph(t), h('span', t.label)],
        run: () => app.runCommand(`tag:${t.id}`),
      })),
      active: (app, entry) => app.activeTags.has(entry.id),
      enabled: inBody,
      menu: (app) => [
        ...TAGS.map((t) => ({
          label: t.label,
          icon: hasIcon(`tag:${t.id}`) ? `tag:${t.id}` : undefined,
          shortcut: t.key ? `Mod+${t.key}` : undefined,
          checked: app.activeTags.has(t.id),
          disabled: !inBody(app),
          run: () => app.runCommand(`tag:${t.id}`),
        })),
        { type: 'sep' },
        { label: 'Remove Tag', icon: 'x', shortcut: 'Mod+0', disabled: !inBody(app), run: () => app.runCommand('removeTags') },
        { label: 'Find Tags', icon: 'findTags', run: () => app.runCommand('findTags') },
      ],
    },
    pens: {
      label: 'Pens',
      short: 'Pens',
      icon: 'pen',
      items: (app) => PENS.map((p) => ({
        label: p.label,
        id: p.id,
        render: () => penGlyph(p),
        run: () => app.setPen(p),
      })),
      active: (app, entry) => app.editor?.ink.tool === 'pen' && app.editor.ink.pen.id === entry.id,
      enabled: editable,
      menu: (app) => PENS.map((p) => ({ label: p.label, swatch: p.color, radio: true, checked: app.editor?.ink.tool === 'pen' && app.editor.ink.pen.id === p.id, run: () => app.setPen(p) })),
    },
    shapes: {
      label: 'Shapes',
      short: 'Shapes',
      icon: 'shapes',
      items: (app) => SHAPES.map((s) => ({
        label: s.label,
        id: s.kind,
        render: () => icon(s.icon, 16),
        run: () => app.setTool('shape', { shape: s.kind }),
      })),
      active: (app, entry) => app.editor?.ink.tool === 'shape' && app.editor.ink.shape === entry.id,
      enabled: editable,
      menu: (app) => SHAPES.map((s) => ({ label: s.label, icon: s.icon, run: () => app.setTool('shape', { shape: s.kind }) })),
    },
  };
}

/** A tag's glass drawing for the ribbon, or its masked line icon in the tag's colour. */
function tagGlyph(t) {
  if (hasIcon(`tag:${t.id}`)) return icon(`tag:${t.id}`, 16);
  return h('span.tag-glyph', { style: { '--tag-color': t.color, '--tag-icon': `var(--tagicon-${t.id})` } });
}

/** A pen or highlighter drawn in glass, its tip or band in the pen's ink. */
function penGlyph(p) {
  const s = icon(p.highlighter ? 'inkHighlighter' : 'inkPen', 22);
  s.classList.add('pen-glyph');
  s.style.setProperty('--pen-color', p.color);
  return s;
}


export { TAG_BY_ID, activeTags, icon };
