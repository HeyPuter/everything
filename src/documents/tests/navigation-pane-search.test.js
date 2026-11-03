// @vitest-environment jsdom
import { afterEach, it, expect, vi } from 'vitest';
import { createNavigationPane } from '../src/views/navigation-pane.js';

afterEach(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); document.body.replaceChildren(); });

// A small document the pane searches: `text` changes with each edit, and `revision` with it.
function documentPane() {
  const state = { text: Array.from({ length: 40 }, (_, i) => `Line ${i} holds the plan here.`).join('\n'), revision: 1 };
  const find = query => [...state.text.matchAll(new RegExp(query, 'g'))].map(m => ({ start: m.index, end: m.index + query.length }));
  const api = { navigate: vi.fn(), close: vi.fn(), focusEditor: vi.fn(), highlight: vi.fn(), selectMatch: vi.fn(), pages: () => [], currentPage: () => 0,
    search: vi.fn(find), text: () => state.text, version: () => [state.revision] };
  const pane = createNavigationPane(api);
  document.body.append(pane.node); pane.open({ focus: false });
  const edit = (at, typed) => { state.text = state.text.slice(0, at) + typed + state.text.slice(at); state.revision++; };
  return { state, api, pane, edit };
}
const searchFor = (pane, text) => { const box = pane.node.querySelector('.nav-search'); box.value = text; box.dispatchEvent(new Event('input')); };
const rows = pane => [...pane.node.querySelectorAll('.nav-results li')];

it('searches again only when the document or the search changes, and keeps the result rows whose words did not change', () => {
  const { state, api, pane, edit } = documentPane();
  searchFor(pane, 'plan');
  expect(rows(pane)).toHaveLength(40);
  const before = rows(pane);
  // A caret move: nothing to search again or redraw.
  api.search.mockClear();
  pane.refresh([], 5); pane.refresh([], 9);
  expect(api.search).not.toHaveBeenCalled();
  expect(rows(pane)).toEqual(before);
  // Typing in line 3 moves every match after it; only line 3's row has new words.
  edit(state.text.indexOf('Line 3 ') + 4, 'x');
  pane.refresh([], 5);
  expect(api.search).toHaveBeenCalledTimes(1);
  const after = rows(pane);
  expect(after.filter((row, i) => row !== before[i]).map(row => row.textContent)).toEqual(['Linex 3 holds the plan here.']);
  // The list reads as a newly opened pane's would.
  const fresh = documentPane();
  fresh.state.text = state.text;
  searchFor(fresh.pane, 'plan');
  expect(fresh.pane.node.querySelector('.nav-results').innerHTML).toBe(pane.node.querySelector('.nav-results').innerHTML);
  // A kept row chooses its match where it is now.
  after[20].querySelector('button').click();
  expect(api.selectMatch).toHaveBeenLastCalledWith({ start: state.text.indexOf('plan', state.text.indexOf('Line 20 ')), end: state.text.indexOf('plan', state.text.indexOf('Line 20 ')) + 4 });
  expect(after[20].querySelector('button').getAttribute('aria-current')).toBe('true');
  expect(pane.node.querySelector('.nav-status').textContent).toBe('Result 21 of 40');
  // Another search searches.
  searchFor(pane, 'holds');
  expect(api.search).toHaveBeenLastCalledWith('holds');
  expect(rows(pane)[0].textContent).toBe('Line 0 holds the plan here.');
});

it('shows each result’s context without cutting an emoji or other character in half', () => {
  const { state, pane } = documentPane();
  // 40 characters before the match start inside the 😀 (two UTF-16 units), and 60 after its end inside the 🎉.
  state.text = `${'x'.repeat(20)}😀${'y'.repeat(39)}plan${'z'.repeat(59)}🎉 tail`; state.revision++;
  searchFor(pane, 'plan');
  const [row] = rows(pane);
  expect(row.textContent.isWellFormed()).toBe(true);
  expect(row.textContent).toBe(`…😀${'y'.repeat(39)}plan${'z'.repeat(59)}🎉`);
});

it('searches what an input method commits, not each partial composition', () => {
  const { api, pane } = documentPane();
  const box = pane.node.querySelector('.nav-search');
  // Pinyin for 计划 ("plan") is typed as letters, then committed as characters.
  box.dispatchEvent(new CompositionEvent('compositionstart'));
  for (const partial of ['j', 'ji', 'jih', 'jihua']) { box.value = partial; box.dispatchEvent(new InputEvent('input', { isComposing: true })); }
  expect(api.search).not.toHaveBeenCalled();
  expect(pane.node.querySelector('.nav-results')?.textContent || '').not.toMatch(/couldn't find/);
  box.value = 'plan';
  box.dispatchEvent(new InputEvent('input', { isComposing: true }));
  box.dispatchEvent(new CompositionEvent('compositionend', { data: 'plan' }));
  expect(api.search).toHaveBeenCalledWith('plan');
  expect(rows(pane)).toHaveLength(40);
});
