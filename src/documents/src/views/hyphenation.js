/**
 * Hyphenation: automatic, manual and none, with the document's hyphenation options.
 * Every change goes through the editor's transactions, so undo, saving and read-only rules apply.
 */
export function createHyphenation({ editor, pkg, error, onChange = () => {}, commands: base = {} }) {
  const ready = () => { const engine = editor(); return engine && !pkg()?.readOnly ? engine : null; };
  const commands = {};
  /** Ribbon groups for a tab (see canvas-chrome.js: after / replaces). */
  function extendTab(tabId, kit) { return []; }
  /** Items for the menu bar's menus: 'file' | 'edit' | 'view' | 'insert' | 'format' | 'tools' | 'table' | 'window' | 'help'. */
  function extendMenu(menuId, kit) { return []; }
  /** Items appended to the document context menu for 'text' | 'table' | 'image' | 'shape' | 'field' | 'list' | 'link'. */
  function contextMenuItems(context, kit) { return []; }
  return { commands, extendTab, extendMenu, contextMenuItems, destroy() {} };
}
