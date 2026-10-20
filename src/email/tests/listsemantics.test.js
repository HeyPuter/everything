import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderApp } from '../src/ui/app.js';
import { createSampleMailbox } from '../src/lib/sample.js';

/** The message list as a screen reader and the keyboard meet it. */

const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
let root;
const mount = async () => {
  const { fs, mailPath, objectsPath } = createSampleMailbox();
  renderApp(root, { fs, mailPath, objectsPath, sample: true, account: { username: 'sample' } });
  await settle();
};
const rows = () => [...root.querySelectorAll('.row')].filter((row) => !row.hidden);
beforeEach(() => {
  root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
});
afterEach(() => {
  root.remove();
  document.querySelectorAll('.toast, .modal-root').forEach((node) => node.remove());
});

describe('list semantics', () => {
  it('announces ticked rows as selected in a multi-select listbox', async () => {
    await mount();
    const check = rows()[1].querySelector('.row-check');
    check.checked = true;
    check.dispatchEvent(new Event('change'));
    expect(root.querySelector('[role="listbox"]').getAttribute('aria-multiselectable')).toBe('true');
    expect(rows()[1].getAttribute('aria-selected')).toBe('true');
    expect(rows()[0].getAttribute('aria-selected')).toBe('false');
  });
});
