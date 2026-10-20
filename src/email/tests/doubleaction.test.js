import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderApp } from '../src/ui/app.js';
import { createSampleMailbox } from '../src/lib/sample.js';

/**
 * A second press of Archive or Delete lands while the first move is still in
 * flight. It must not move the same file again: that failed, said "Could not
 * archive" under "Archived", and asked for write permission nobody needed.
 */

const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

let root;
let asked;
let moves;

const mount = () => {
  const { fs, mailPath, objectsPath } = createSampleMailbox();
  asked = 0;
  moves = 0;
  const slow = {
    ...fs,
    move: async (...args) => {
      moves++;
      await settle(150);
      return fs.move(...args);
    },
  };
  renderApp(root, {
    fs: slow, mailPath, objectsPath, sample: true, account: { username: 'sample' },
    requestWrite: async () => {
      asked++;
      return true;
    },
  });
};

const rows = () => [...root.querySelectorAll('.row')].filter((row) => !row.hidden);
const toasts = () => [...document.querySelectorAll('.toast')].map((t) => t.textContent);
const press = (key) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

beforeEach(() => {
  root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
});

afterEach(() => {
  root.remove();
  document.querySelectorAll('.toast, .modal-root').forEach((node) => node.remove());
});

describe('pressing Archive twice', () => {
  it('archives a row once when its button is clicked twice', async () => {
    mount();
    await settle(400);
    const row = rows()[1];
    const button = [...row.querySelectorAll('.row-action')].find((b) => b.title === 'Archive');
    button.click();
    button.click();
    await settle(800);
    expect(toasts().some((text) => text.startsWith('Could not'))).toBe(false);
    expect(toasts().some((text) => text.startsWith('Archived'))).toBe(true);
    expect(asked).toBe(0);
    expect(row.isConnected).toBe(false);
  });

  it('archives the open message once on e e', async () => {
    mount();
    await settle(400);
    rows()[1].click();
    await settle(400);
    const before = moves;
    press('e');
    press('e');
    await settle(800);
    expect(toasts().some((text) => text.startsWith('Could not'))).toBe(false);
    expect(asked).toBe(0);
    expect(moves - before).toBeGreaterThan(0);
  });
});
