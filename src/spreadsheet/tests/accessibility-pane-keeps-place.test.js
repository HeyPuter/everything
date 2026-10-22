// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { createAccessibilityPane } from '../src/ui/accessibility-pane.js';

// The Accessibility pane follows the workbook while it is open, drawing its results again after every change. It
// drew them afresh: a tier the user had folded away opened again, the rules they had opened closed, and the item or
// heading they had reached with the keyboard was taken away, focus and all, at each edit, theirs or a co-author's.
afterEach(() => { document.body.replaceChildren(); });

function mount() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.addSheet();
  wb.setCells(id, [{ r: 0, c: 0, cell: { v: 'Title' } }, { r: 5, c: 0, cell: { v: 'Note' } }]);
  wb.mergeCells(id, { r1: 0, c1: 0, r2: 0, c2: 2 });
  wb.mergeCells(id, { r1: 5, c1: 0, r2: 5, c2: 2 });
  let refresh = () => {};
  const pane = createAccessibilityPane({ wb, subscribe: (fn) => { refresh = fn; return () => {}; }, grid: { focus() {} }, reveal() {} });
  document.body.append(pane.el);
  pane.show();
  const change = () => { wb.setInput(id, 10, 0, String(Math.random())); refresh(); };
  return { pane, change };
}
const tier = (pane, name) => [...pane.el.querySelectorAll('details.a11y-tier')].find((d) => d.querySelector('summary').textContent.startsWith(name));
const rule = (pane, name) => [...pane.el.querySelectorAll('details.a11y-rule')].find((d) => d.querySelector('summary').textContent.startsWith(name));

it('keeps the tiers and rules folded or opened as the user left them', () => {
  const { pane, change } = mount();
  expect(tier(pane, 'Warnings').open).toBe(true);
  tier(pane, 'Tips').open = false;
  rule(pane, 'Cells are merged').open = true;
  change();
  expect(tier(pane, 'Tips').open).toBe(false);
  expect(tier(pane, 'Warnings').open).toBe(true);
  expect(rule(pane, 'Cells are merged').open).toBe(true);
});

it('keeps focus on the item the user is on', () => {
  const { pane, change } = mount();
  rule(pane, 'Cells are merged').open = true;
  const item = [...pane.el.querySelectorAll('.a11y-item')].find((b) => b.textContent.startsWith('A6:C6'));
  item.focus();
  change();
  expect(document.activeElement?.classList.contains('a11y-item')).toBe(true);
  expect(document.activeElement.textContent).toBe(item.textContent);
  expect(document.activeElement.isConnected).toBe(true);
  tier(pane, 'Tips').querySelector('summary').focus();
  change();
  expect(document.activeElement.textContent).toMatch(/^Tips/);
});
