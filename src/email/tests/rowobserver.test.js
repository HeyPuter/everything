import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderApp } from '../src/ui/app.js';
import { createSampleMailbox } from '../src/lib/sample.js';

const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Rows the list takes away leave the IntersectionObserver too: a row that
 * never scrolled into view was still observed, and held, after it had gone.
 */

let root;
let watched;
let Real;
beforeEach(() => {
  Real = window.IntersectionObserver;
  watched = new Set();
  window.IntersectionObserver = class {
    constructor() {}
    observe(t) { watched.add(t); }
    unobserve(t) { watched.delete(t); }
    disconnect() { watched.clear(); }
  };
  root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
});
afterEach(() => {
  window.IntersectionObserver = Real;
  root.remove();
  document.querySelectorAll('.toast').forEach((node) => node.remove());
});

describe('rows taken off the list', () => {
  it('are no longer observed once archived', async () => {
    const { fs, mailPath, objectsPath } = createSampleMailbox();
    renderApp(root, { fs, mailPath, objectsPath, sample: true, account: { username: 'sample' } });
    await settle(400);
    const box = root.querySelector('.select-all');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    root.querySelector('.list-actions [aria-label="Archive"]').click();
    await settle(600);
    expect(root.querySelectorAll('.row')).toHaveLength(0);
    expect([...watched].filter((target) => !target.isConnected)).toHaveLength(0);
    // Undo puts the rows back, and they still fill in.
    [...document.querySelectorAll('.toast button')].find((button) => button.textContent === 'Undo').click();
    await settle(600);
    expect(root.querySelectorAll('.row').length).toBeGreaterThan(0);
    const senders = [...root.querySelectorAll('.row-sender')].map((sender) => sender.textContent);
    expect(senders.length).toBeGreaterThan(0);
    expect(senders.filter((sender) => !sender || sender === '…')).toEqual([]);
  });
});
