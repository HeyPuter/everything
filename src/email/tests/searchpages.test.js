import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderApp } from '../src/ui/app.js';
import { createSampleMailbox } from '../src/lib/sample.js';
import { mailFilename } from '../src/lib/mailbox.js';

/** Each folder's search results start on their first page. */

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));
let root;
beforeEach(() => {
  root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
});
afterEach(() => {
  root.remove();
  document.querySelectorAll('.toast').forEach((node) => node.remove());
});
const openFolder = async (label) => {
  [...root.querySelectorAll('.nav-item')].find((item) => item.textContent.includes(label)).click();
  await settle(800);
};
const raw = (subject) => `From: a@b.c\r\nSubject: ${subject}\r\nDate: Mon, 17 Aug 2026 10:30:00 GMT\r\n\r\nbody`;

describe('switching folder while on page 2 of search results', () => {
  it('starts the new folder on its first page', async () => {
    const mailbox = createSampleMailbox();
    for (const box of ['objects', 'archive']) {
      for (let i = 0; i < 130; i++) {
        const name = mailFilename(`Report ${box} ${i}`, new Date(Date.UTC(2026, 7, 10, 0, i)));
        await mailbox.fs.write(`${mailbox.mailPath}/${box}/2026-08-10/${name}`, new Blob([raw(`Report ${box} ${i}`)]));
      }
    }
    renderApp(root, { ...mailbox, sample: true, account: { username: 'sample' } });
    await settle(800);
    const input = root.querySelector('.search-input');
    input.value = 'report';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(900);
    [...root.querySelectorAll('.result-pages button')].find((button) => button.textContent === 'Next results').click();
    await settle(300);
    expect(root.querySelector('.result-pages span')?.textContent).toMatch(/^61/);
    await openFolder('Archive');
    expect(input.value).toBe('report');
    expect(root.querySelector('.result-pages span')?.textContent).toMatch(/^1\D/);
  });
});
