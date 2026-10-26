// @vitest-environment jsdom
import { afterEach, it, expect, vi } from 'vitest';
import { openInsertTable } from '../src/views/insert-table.js';
import { openHyperlink } from '../src/views/hyperlink.js';
import { openParagraphShading } from '../src/views/paragraph-shading.js';
import { createNavigationPane } from '../src/views/navigation-pane.js';
import { closeMenu } from '../src/ui/menu.js';
const anchor = () => { const node = document.createElement('button'); document.body.append(node); node.focus(); return node; };
// jsdom has no CSS.escape; the navigation pane uses it to put focus back on a moved heading.
globalThis.CSS ??= { escape: value => String(value).replace(/[^\w-]/g, ch => `\\${ch}`) };
// Let frames the pane asked for run while the document still exists.
afterEach(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); closeMenu(); document.body.replaceChildren(); });
it('previews table dimensions with keyboard navigation and inserts exactly once', () => {
  const apply = vi.fn(), popup = openInsertTable(apply, { anchor: anchor() });
  const cell = popup.menu.querySelector('[aria-label="3 columns, 2 rows"]'); cell.focus();
  expect(popup.menu.querySelectorAll('.is-preview')).toHaveLength(6);
  cell.click(); cell.click(); expect(apply).toHaveBeenCalledExactlyOnceWith(2, 3);
});
it('names the table size cells in the singular for one row or column', () => {
  const popup = openInsertTable(vi.fn(), { anchor: anchor() });
  const names = [...popup.menu.querySelectorAll('.table-size-cell')].map(cell => cell.getAttribute('aria-label'));
  expect(names.slice(0, 2)).toEqual(['1 column, 1 row', '2 columns, 1 row']);
  expect(names[10]).toBe('1 column, 2 rows');
});
it('keeps links non-modal and leaves selected content unchanged on dismissal', () => {
  const apply = vi.fn(), opener = anchor();
  const popup = openHyperlink({ anchor: opener, apply, insert: false });
  expect(popup.menu.getAttribute('role')).toBe('dialog'); expect(popup.menu.hasAttribute('aria-modal')).toBe(false);
  expect(document.querySelector('.modal-root')).toBeNull();
  popup.menu.querySelector('input').value = 'https://example.com';
  popup.menu.querySelector('select').focus();
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  expect(document.activeElement.getAttribute('aria-label')).toBe('Close insert link');
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  expect(apply).not.toHaveBeenCalled(); expect(document.activeElement).toBe(opener);
});
it('preserves both OOXML automatic fill modes in the shading palette', () => {
  const apply = vi.fn();
  const first = openParagraphShading('auto', apply, { anchor: anchor() });
  [...first.menu.querySelectorAll('button')].find(b => b.textContent.includes('Automatic foreground')).click();
  expect(apply).toHaveBeenLastCalledWith('foreground');
  const second = openParagraphShading('foreground', apply, { anchor: anchor() });
  expect(second.menu.querySelector('[aria-checked="true"]').textContent).toContain('Automatic foreground');
  [...second.menu.querySelectorAll('button')].find(b => b.textContent.includes('No fill')).click();
  expect(apply).toHaveBeenLastCalledWith('auto');
});
it('keeps outline navigation open and refreshes headings and the active section', () => {
  const navigate = vi.fn(), panel = createNavigationPane({ navigate, close: vi.fn(), focusEditor: vi.fn(), search: () => [], highlight: vi.fn(), text: () => '', pages: () => [], currentPage: () => 0 });
  document.body.append(panel.node); panel.open({ focus: false });
  const entries = [{ id: 'first', text: 'First', level: 1, start: 0, page: 1 }, { id: 'second', text: 'Second', level: 2, start: 20, page: 2 }];
  panel.refresh(entries, 25); expect(panel.node.querySelector('[aria-current]').dataset.paragraph).toBe('second');
  panel.node.querySelector('[data-paragraph="first"]').click(); expect(navigate).toHaveBeenCalledWith('first'); expect(panel.node.hidden).toBe(false);
  panel.refresh([{ ...entries[0], text: 'Updated' }], 5); expect(panel.node.textContent).toContain('Updated'); expect(panel.node.querySelectorAll('.canvas-outline-entry')).toHaveLength(1);
  // A heading with a lower level under it collapses its children.
  panel.refresh(entries, 0); panel.node.querySelector('.nav-twisty').click();
  expect([...panel.node.querySelectorAll('[role="treeitem"]')].map(item => item.textContent)).toEqual(['First']);
});
it('offers no section commands for a heading in a table, and says why, rather than doing nothing', async () => {
  const { outlineEntries } = await import('../src/engine/outline.js');
  const { paragraph } = await import('../src/engine/model.js');
  const listed = outlineEntries([paragraph('Plan', { format: { outlineLevel: 0 } }), { ...paragraph('Costs', { format: { outlineLevel: 1 } }), cellId: 'c1' }]);
  expect(listed.map(e => [e.text, !!e.inTable])).toEqual([['Plan', false], ['Costs', true]]);
  const act = { canEdit: () => true, move: vi.fn(), promote: vi.fn(), demote: vi.fn(), remove: vi.fn(), insert: vi.fn(), select: vi.fn() };
  const panel = createNavigationPane({ navigate: vi.fn(), close: vi.fn(), focusEditor: vi.fn(), search: () => [], highlight: vi.fn(), text: () => '', pages: () => [], currentPage: () => 0, headingActions: () => act });
  document.body.append(panel.node); panel.open({ focus: false });
  panel.refresh([{ id: 'plan', text: 'Plan', level: 1, start: 0, page: 1 }, { id: 'costs', text: 'Costs', level: 2, start: 5, page: 1, inTable: true }, { id: 'next', text: 'Next', level: 2, start: 20, page: 1 }], 0);
  const heading = id => panel.node.querySelector(`[data-paragraph="${id}"]`);
  // An ordinary heading can be dragged and has its commands; the one in the table cannot.
  expect(heading('next').draggable).toBe(true);
  expect(heading('costs').draggable).toBe(false);
  heading('costs').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  const menu = document.querySelector('[role="menu"]');
  expect(menu.textContent).toContain('This heading is in a table');
  const item = label => [...menu.querySelectorAll('[role="menuitem"]')].find(b => b.textContent.startsWith(label));
  for (const label of ['Promote', 'Demote', 'New Heading Before', 'New Subheading', 'Select Heading and Content', 'Delete']) expect(item(label).disabled, label).toBe(true);
  closeMenu();
  // Alt+Shift+Arrow moves an ordinary section past the table's heading, never onto it.
  heading('next').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, shiftKey: true, bubbles: true }));
  expect(act.move).toHaveBeenCalledWith('next', 'plan', 'before');
  heading('costs').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, shiftKey: true, bubbles: true }));
  expect(act.move).toHaveBeenCalledTimes(1);
});
