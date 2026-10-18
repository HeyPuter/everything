// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { attachKeyTips } from '../src/ui/keytips.js';
import { el } from '../src/ui/dom.js';

// With the assistant open beside the sheet, or in a small window, the ribbon is narrower than its commands and
// scrolls them sideways. Key tips (Alt or F10, then a tab's letter) were drawn for every command, so the tips
// of those scrolled out of sight floated over the assistant and past the window's edge, each beside nothing.
// Only the commands in sight now show a tip; typing the tip of one out of sight still runs it, scrolling it
// into view first so a menu it opens drops from where it is.
let keyTips;
const rects = new Map();
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('innerWidth', 1024);
  vi.stubGlobal('innerHeight', 768);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
    const [left, top, width, height] = rects.get(this) || [0, 0, 0, 0];
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
  });
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}]);
});
afterEach(() => { keyTips?.destroy(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); rects.clear(); });

const press = (key) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
const tips = () => [...document.querySelectorAll('.keytip')].map((t) => t.textContent);

function ribbon() {
  const tab = el('button.ribbon-tab', { type: 'button' }, 'Home');
  const bold = el('button.tb-btn', { type: 'button', 'aria-label': 'Bold' });
  const italic = el('button.tb-btn', { type: 'button', 'aria-label': 'Italic' });
  const conditional = el('button.tb-btn', { type: 'button', 'aria-label': 'Conditional formatting', 'aria-haspopup': 'menu' });
  const tools = el('div.ribbon-panel-tools', { style: { overflow: 'hidden' } }, bold, italic, conditional);
  const root = el('div.ribbon', {}, tab, el('div.ribbon-panel', {}, tools));
  document.body.append(root);
  // The ribbon's commands show from 0 to 640px; Conditional formatting lies at 780px, scrolled out of sight.
  rects.set(tab, [20, 44, 50, 24]);
  rects.set(tools, [0, 76, 640, 80]);
  rects.set(bold, [110, 120, 28, 28]);
  rects.set(italic, [140, 120, 28, 28]);
  rects.set(conditional, [760, 80, 70, 70]);
  return { root, conditional };
}

it('shows a key tip only for the ribbon commands in sight', async () => {
  const { root } = ribbon();
  keyTips = attachKeyTips({ ribbon: root });
  press('F10');
  expect(tips()).toEqual(['H']);
  press('h');
  await vi.advanceTimersByTimeAsync(1);
  expect(tips()).toEqual(['B', 'I']);
});

it('still runs a command out of sight by its tip, bringing it into view first', async () => {
  const { root, conditional } = ribbon();
  const order = [];
  conditional.scrollIntoView = vi.fn(() => order.push('scroll'));
  conditional.addEventListener('click', () => order.push('click'));
  keyTips = attachKeyTips({ ribbon: root });
  press('F10');
  press('h');
  await vi.advanceTimersByTimeAsync(1);
  press('c');
  expect(order).toEqual(['scroll', 'click']);
  expect(keyTips.active).toBe(false);
});
