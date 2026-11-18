/** Ribbon layout: tabs, their groups and which commands sit where. */
export const RIBBON_TABS = [
  {
    id: 'home',
    label: 'Home',
    groups: [
      { label: 'Clipboard', items: [{ cmd: 'paste', size: 'big' }, { stack: [[{ cmd: 'cut', label: true }], [{ cmd: 'copy', label: true }], [{ cmd: 'formatPainter', label: true }]] }] },
      {
        label: 'Font',
        items: [{
          stack: [
            [{ combo: 'fontName' }, { combo: 'fontSize' }, { cmd: 'growFont' }, { cmd: 'shrinkFont' }],
            [{ cmd: 'bold' }, { cmd: 'italic' }, { cmd: 'underline' }, { cmd: 'strike' }, { cmd: 'subscript' }, { cmd: 'superscript' }, { cmd: 'highlight', split: true }, { cmd: 'fontColor', split: true }, { cmd: 'clearFormat' }],
          ],
        }],
      },
      {
        label: 'Paragraph',
        items: [{
          stack: [
            [{ cmd: 'bullets', split: true }, { cmd: 'numbering', split: true }, { cmd: 'outdent' }, { cmd: 'indent' }],
            [{ cmd: 'align', dropdown: true }, { cmd: 'moveUp' }, { cmd: 'moveDown' }],
          ],
        }],
      },
      { label: 'Styles', items: [{ gallery: 'styles', rows: 2, visible: 6 }] },
      { label: 'Tags', items: [{ cmd: 'todo', size: 'big' }, { gallery: 'tags', visible: 6 }, { cmd: 'findTags', size: 'big' }] },
      { label: 'Voice', items: [{ cmd: 'dictate', size: 'big' }] },
      { label: 'Assist', items: [{ cmd: 'assist', size: 'big' }] },
      { label: 'Email', items: [{ cmd: 'emailPage', size: 'big' }] },
    ],
  },
  {
    id: 'insert',
    label: 'Insert',
    groups: [
      { label: 'Tables', items: [{ cmd: 'insertTable', size: 'big', dropdown: true }] },
      { label: 'Files', items: [{ cmd: 'insertFile', size: 'big', split: true }, { cmd: 'insertPrintout', size: 'big' }] },
      { label: 'Images', items: [{ cmd: 'insertPicture', size: 'big', split: true }, { cmd: 'insertScreenshot', size: 'big' }] },
      { label: 'Links', items: [{ cmd: 'insertLink', size: 'big' }] },
      { label: 'Symbols', items: [{ cmd: 'insertEquation', size: 'big' }] },
      { label: 'Time Stamp', items: [{ stack: [[{ cmd: 'insertDate', label: true }], [{ cmd: 'insertTime', label: true }], [{ cmd: 'insertDateTime', label: true }]] }] },
      { label: 'Shapes', items: [{ gallery: 'shapes', visible: 7 }, { cmd: 'insertLine', size: 'big' }] },
      { label: 'Recording', items: [{ cmd: 'insertAudio', size: 'big' }, { cmd: 'insertVideo', size: 'big' }] },
      { label: 'Pages', items: [{ cmd: 'pageTemplates', size: 'big' }, { cmd: 'toolSpace', size: 'big' }] },
    ],
  },
  {
    id: 'draw',
    label: 'Draw',
    groups: [
      { label: 'Tools', items: [{ cmd: 'toolType', size: 'big' }, { cmd: 'toolLasso', size: 'big' }, { cmd: 'toolSpace', size: 'big' }, { cmd: 'toolEraser', size: 'big' }] },
      { label: 'Pens', items: [{ gallery: 'pens', rows: 2, visible: 8 }, { cmd: 'penSettings', size: 'big', dropdown: true }] },
      { label: 'Shapes', items: [{ gallery: 'shapes', visible: 7 }, { cmd: 'inkToShape', size: 'big' }] },
      { label: 'Edit', items: [{ cmd: 'deleteInk', size: 'big' }] },
    ],
  },
  {
    id: 'view',
    label: 'View',
    groups: [
      { label: 'Views', items: [{ cmd: 'navPanes', size: 'big', dropdown: true }, { cmd: 'reader', size: 'big' }, { cmd: 'fullPage', size: 'big' }] },
      { label: 'Page Setup', items: [{ cmd: 'pageColor', size: 'big', dropdown: true }, { cmd: 'ruleLines', size: 'big', dropdown: true }, { cmd: 'switchBackground', size: 'big' }] },
      { label: 'History', items: [{ cmd: 'deletedNotes', size: 'big' }, { cmd: 'pageVersions', size: 'big' }] },
      { label: 'Zoom', items: [{ cmd: 'zoomOut', size: 'big' }, { cmd: 'zoomIn', size: 'big' }, { stack: [[{ cmd: 'zoom100', label: true }], [{ cmd: 'pageWidth', label: true }]] }] },
      { label: 'Window', items: [{ cmd: 'newWindow', size: 'big' }, { cmd: 'theme', size: 'big', dropdown: true }] },
    ],
  },
  {
    id: 'help',
    label: 'Help',
    groups: [
      { label: 'Help', items: [{ cmd: 'help', size: 'big' }, { cmd: 'shortcuts', size: 'big' }, { cmd: 'about', size: 'big' }] },
    ],
  },
  {
    id: 'table',
    label: 'Table',
    contextual: true,
    groups: [
      { label: 'Select', items: [{ cmd: 'tableSelect', size: 'big', dropdown: true }] },
      { label: 'Delete', items: [{ cmd: 'tableDelete', size: 'big', dropdown: true }] },
      { label: 'Insert', items: [{ cmd: 'tableAbove', size: 'big' }, { cmd: 'tableBelow', size: 'big' }, { cmd: 'tableLeft', size: 'big' }, { cmd: 'tableRight', size: 'big' }] },
      { label: 'Format', items: [{ cmd: 'tableBorders', size: 'big' }, { cmd: 'tableHeader', size: 'big' }, { cmd: 'tableShading', size: 'big', dropdown: true }, { cmd: 'tableAlign', size: 'big', dropdown: true }] },
      { label: 'Data', items: [{ cmd: 'tableSort', size: 'big', dropdown: true }, { cmd: 'tableToText', size: 'big' }] },
    ],
  },
];

/** Items of the File menu (the first tab opens this menu instead of a panel). */
export function fileMenu(app) {
  return [
    { label: 'New Page', icon: 'newPage', shortcut: 'Mod+Alt+N', run: () => app.runCommand('newPage') },
    { label: 'New Section', icon: 'newSection', shortcut: 'Mod+Alt+T', run: () => app.runCommand('newSection') },
    { label: 'New Section Group', icon: 'sectionGroup', run: () => app.runCommand('newSectionGroup') },
    { label: 'New Notebook...', icon: 'notebook', run: () => app.runCommand('newNotebook') },
    { type: 'sep' },
    { label: 'Import', icon: 'upload', submenu: () => app.commands.get('import').menu(app) },
    { label: 'Export', icon: 'download', submenu: () => app.commands.get('export').menu(app) },
    { label: 'Share...', icon: 'share', disabled: !app.editor?.page, run: () => app.runCommand('share') },
    { label: 'Print...', icon: 'print', shortcut: 'Mod+P', disabled: !app.editor?.page, run: () => app.runCommand('print') },
    { type: 'sep' },
    { label: 'Sync Now', icon: 'sync', shortcut: 'Mod+S', run: () => app.runCommand('syncNow') },
    { label: 'Deleted Notes', icon: 'trash', run: () => app.runCommand('deletedNotes') },
    { label: 'Lock All Protected Sections', icon: 'lock', shortcut: 'Mod+Alt+L', run: () => app.runCommand('lockAll') },
    { label: 'Theme', icon: app.commands.get('theme').dynamicIcon(), submenu: () => app.commands.get('theme').menu(app) },
    { type: 'sep' },
    { label: 'Keyboard Shortcuts', icon: 'keyboard', shortcut: 'Mod+Shift+Slash', run: () => app.runCommand('shortcuts') },
    { label: 'About Notes', icon: 'info', run: () => app.runCommand('about') },
  ];
}
