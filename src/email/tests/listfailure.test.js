import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderApp } from '../src/ui/app.js';
import { createSampleMailbox } from '../src/lib/sample.js';

/**
 * A folder whose listing failed says so and offers to try again. A mailbox
 * that has no folder yet -- nothing has ever been delivered to it -- is not a
 * failure, and is empty.
 */

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

const mountWith = (readdir) => {
  const { fs, mailPath, objectsPath } = createSampleMailbox();
  const wrapped = { ...fs, readdir: (...args) => readdir(fs, ...args) };
  renderApp(root, { fs: wrapped, mailPath, objectsPath, sample: true, account: { username: 'sample' } });
};
const listText = () => root.querySelector('.msglist').textContent;
const retry = () => [...root.querySelectorAll('.msglist button')].find((button) => button.textContent === 'Retry');

describe('a folder that could not be listed', () => {
  it('says so and retries, rather than reading as empty', async () => {
    let broken = true;
    mountWith((fs, ...args) => (broken ? Promise.reject(new Error('offline')) : fs.readdir(...args)));
    await settle(400);
    expect(listText()).toContain('Could not load this folder.');
    expect(listText()).not.toContain('No mail yet.');
    broken = false;
    retry().click();
    await settle(600);
    expect(root.querySelectorAll('.row').length).toBeGreaterThan(0);
  });

  it('is listed again when it is next opened', async () => {
    let broken = true;
    mountWith((fs, ...args) => (broken ? Promise.reject(new Error('offline')) : fs.readdir(...args)));
    await settle(400);
    expect(listText()).toContain('Could not load this folder.');
    broken = false;
    [...root.querySelectorAll('.nav-item')].find((item) => item.textContent.includes('Archive')).click();
    await settle();
    [...root.querySelectorAll('.nav-item')].find((item) => item.textContent.includes('Inbox')).click();
    await settle(600);
    expect(root.querySelectorAll('.row').length).toBeGreaterThan(0);
  });

  it('is still an empty mailbox when there is no folder yet', async () => {
    const missing = Object.assign(new Error('no such folder'), { code: 'subject_does_not_exist' });
    mountWith(() => Promise.reject(missing));
    await settle(400);
    expect(listText()).toContain('No mail yet.');
    expect(retry()).toBeUndefined();
  });
});
