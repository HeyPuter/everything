import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderApp } from '../src/ui/app.js';
import { createSampleMailbox } from '../src/lib/sample.js';

/**
 * A search runs over the folder's catalog. An Undo dropped that catalog, so
 * the search held a list nothing kept up to date any more, and what was
 * archived after the undo stayed in the results.
 */

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));
let root;
const mount = () => {
  const sample = createSampleMailbox();
  renderApp(root, { ...sample, sample: true, account: { username: 'sample' } });
};
const search = async (text) => {
  const input = root.querySelector('.search-input');
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle(400);
};
const rows = () => [...root.querySelectorAll('.row')].filter((row) => !row.hidden);
const undo = () => [...document.querySelectorAll('.toast button')].find((b) => b.textContent === 'Undo').click();
beforeEach(() => {
  root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
});
afterEach(() => {
  root.remove();
  document.querySelectorAll('.toast').forEach((node) => node.remove());
});

describe('search results after an undo', () => {
  it('a result archived after an earlier undo leaves the results', async () => {
    mount();
    await settle(200);
    await search('subject:Q3 from:petrova');
    expect(root.querySelector('.list-meta').textContent).toBe('1 result in 14 messages');
    rows()[0].querySelector('[aria-label^="Archive"]').click();
    await settle(200);
    undo();
    await settle(200);
    expect(root.querySelector('.list-meta').textContent).toBe('1 result in 14 messages');
    // Archive it again, for good this time.
    rows()[0].querySelector('[aria-label^="Archive"]').click();
    await settle(200);
    expect(root.querySelector('.list-meta').textContent).toBe('0 results in 13 messages');
    expect(rows()).toHaveLength(0);
  });

  it('any other result archived after an undo leaves the results too', async () => {
    mount();
    await settle(200);
    await search('a');
    const before = rows().length;
    rows()[0].querySelector('[aria-label^="Archive"]').click();
    await settle(200);
    undo();
    await settle(200);
    expect(rows()).toHaveLength(before);
    const second = rows()[1].querySelector('.row-subject').textContent;
    rows()[1].querySelector('[aria-label^="Archive"]').click();
    await settle(200);
    expect(rows().map((r) => r.querySelector('.row-subject').textContent)).not.toContain(second);
    expect(rows()).toHaveLength(before - 1);
    expect(root.querySelector('.list-meta').textContent).toBe(`${before - 1} results in 13 messages`);
  });
});
