import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderApp } from '../src/ui/app.js';
import { createSampleMailbox } from '../src/lib/sample.js';

const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * The phone layout's folder drawer covers the list and makes the top bar
 * inert while it is open. A shortcut that leads somewhere else puts it away.
 */

let root;
let composed;
let real;
beforeEach(() => {
  real = window.matchMedia;
  window.matchMedia = (q) => ({ matches: q.includes('max-width: 800px'), media: q,
    addEventListener() {}, removeEventListener() {} });
  root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
});
afterEach(() => {
  window.matchMedia = real;
  root.remove();
  document.querySelectorAll('.toast, .modal-root').forEach((node) => node.remove());
});

describe('shortcuts with the phone drawer open', () => {
  it('c closes the drawer, as the Compose pill does', async () => {
    const { fs, mailPath, objectsPath } = createSampleMailbox();
    composed = [];
    renderApp(root, { fs, mailPath, objectsPath, sample: true, account: { username: 'sample' },
      onCompose: (p) => composed.push(p ?? {}) });
    await settle();
    const frame = root.querySelector('.app-frame');
    root.querySelector('.topbar .icon-btn').click(); // hamburger
    expect(frame.classList.contains('nav-open')).toBe(true);
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true }));
    expect(composed).toHaveLength(1);
    expect(frame.classList.contains('nav-open')).toBe(false);
  });
  it('/ reaches the search field', async () => {
    const { fs, mailPath, objectsPath } = createSampleMailbox();
    renderApp(root, { fs, mailPath, objectsPath, sample: true, account: { username: 'sample' } });
    await settle();
    root.querySelector('.topbar .icon-btn').click();
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(root.querySelector('.search-input'));
  });
});
