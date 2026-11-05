import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderApp } from '../src/ui/app.js';
import { createSampleMailbox } from '../src/lib/sample.js';
import { createSnooze, localDateTime } from '../src/lib/snooze.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 160));
const THREAD = 'Thursday walkthrough';
const SUBJECT = 'Welcome to your Puter mailbox';
let root;
let mailbox;
const rowFor = (subject) => [...root.querySelectorAll('.row')]
  .find((row) => row.querySelector('.row-subject').textContent === subject);
const action = (subject, label) => [...rowFor(subject).querySelectorAll('.row-action')]
  .find((button) => button.title === label).click();
const folder = async (name) => {
  [...root.querySelectorAll('.nav-item')].find((node) => node.textContent.includes(name)).click();
  await settle();
};
const choose = async () => {
  [...document.querySelectorAll('.snooze-preset')].find((node) => node.textContent.includes('Tomorrow 08:00')).click();
  await settle();
};
const undo = async () => { [...document.querySelectorAll('.toast-action')].at(-1).click(); await settle(); };
const lastToast = () => [...document.querySelectorAll('.toast')].at(-1)?.textContent;

beforeEach(async () => {
  root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
  mailbox = createSampleMailbox();
  renderApp(root, { ...mailbox, sample: true, account: { username: 'sample' } });
  await settle();
});
afterEach(() => {
  vi.restoreAllMocks();
  document.querySelectorAll('.modal-root [aria-label="Close dialog"]').forEach((button) => button.click());
  root.remove();
  document.querySelectorAll('.toast').forEach((node) => node.remove());
});

describe('snooze actions', () => {
  it('snoozes a whole conversation, shows its time, and can undo from Snoozed', async () => {
    action(THREAD, 'Snooze');
    await choose();
    expect(rowFor(THREAD)).toBeUndefined();
    expect(lastToast()).toContain('It will come back when Mail is open.');
    await folder('Snoozed');
    expect(rowFor(THREAD).querySelector('.row-count').textContent).toBe('3');
    expect(rowFor(THREAD).textContent).toContain('Until ');
    const dayFolders = await mailbox.fs.readdir(`${mailbox.mailPath}/snoozed`);
    const files = (await Promise.all(dayFolders.map((day) => mailbox.fs.readdir(day.path)))).flat();
    expect(files).toHaveLength(3);
    await undo();
    expect(rowFor(THREAD)).toBeUndefined();
    await folder('Inbox');
    expect(rowFor(THREAD)).toBeTruthy();
  });

  it('changes a time, undoes it, unsnoozes to the top, then undoes that', async () => {
    action(SUBJECT, 'Snooze');
    await choose();
    await folder('Snoozed');
    const original = rowFor(SUBJECT).querySelector('.row-snippet').textContent;
    action(SUBJECT, 'Change snooze time');
    const custom = [...document.querySelectorAll('.snooze-picker button')].find((node) => node.textContent === 'Pick date & time');
    custom.click();
    const input = document.querySelector('[type="datetime-local"]');
    input.value = localDateTime(Date.now() + 7 * 86400000);
    document.querySelector('.snooze-custom').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(rowFor(SUBJECT).querySelector('.row-snippet').textContent).not.toBe(original);
    await undo();
    expect(rowFor(SUBJECT).querySelector('.row-snippet').textContent).toBe(original);
    action(SUBJECT, 'Unsnooze');
    await settle();
    await folder('Inbox');
    expect(root.querySelector('.row .row-subject').textContent).toBe(SUBJECT);
    await undo();
    expect(rowFor(SUBJECT)).toBeUndefined();
    await folder('Snoozed');
    expect(rowFor(SUBJECT).textContent).toContain('Until ');
  });

  it('offers Snooze on the reader, selection toolbar, and keyboard sheet', async () => {
    rowFor(SUBJECT).click();
    await settle();
    expect(root.querySelector('.msg-actions-bar [aria-label="Snooze"]')).toBeTruthy();
    root.querySelector('[aria-label="Back to list"]').click();
    const row = rowFor(SUBJECT);
    row.querySelector('.row-check').click();
    expect(root.querySelector('.bulk-actions [aria-label="Snooze"]')
      ?? root.querySelector('.list-toolbar [aria-label="Snooze"]')).toBeTruthy();
    row.focus();
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
    expect(document.querySelector('[aria-label="Snooze until"]')).toBeTruthy();
    document.querySelector('[aria-label="Close dialog"]').click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
    expect(document.querySelector('.shortcuts').textContent).toContain('Snooze or change wake time');
    expect(document.querySelector('.shortcuts').textContent).toContain('Go to Snoozed');
  });

  it('wakes overdue account records on load before listing and only notifies once', async () => {
    const box = new Map();
    const kv = {
      get: async (key) => box.get(key) ?? null,
      set: async (key, value) => { box.set(key, value); },
      del: async (key) => { box.delete(key); },
      list: async ({ pattern }) => ({ items: [...box].filter(([key]) => key.startsWith(pattern))
        .map(([key, value]) => ({ key, value })) }),
    };
    const store = createSnooze({ ...mailbox, kv, scope: 'tester', storage: localStorage });
    const days = await mailbox.fs.readdir(mailbox.objectsPath);
    const files = (await Promise.all(days.map((day) => mailbox.fs.readdir(day.path)))).flat();
    const file = files.find((entry) => Buffer.from(entry.name.split('--')[1], 'base64url').toString() === SUBJECT);
    const message = { ...file, box: 'inbox', day: file.path.split('/').at(-2) };
    await store.snooze(message, Date.now() + 3600000);
    [...box.entries()].find(([key]) => key.startsWith('snooze:'))[1].until = Date.now() - 1000;
    const notify = vi.fn(async () => {});
    renderApp(root, { ...mailbox, kv, notifications: { notify }, account: { username: 'tester' } });
    await settle();
    expect(root.querySelector('.row .row-subject').textContent).toBe(SUBJECT);
    expect(notify).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(notify).toHaveBeenCalledTimes(1);
    await folder('Snoozed');
    expect(rowFor(SUBJECT)).toBeUndefined();
  });

  it('does not accept a past custom time', () => {
    action(SUBJECT, 'Snooze');
    document.querySelector('.snooze-custom input').value = '2020-01-01T08:00';
    document.querySelector('.snooze-custom').dispatchEvent(new Event('submit', { cancelable: true }));
    expect(document.querySelector('.snooze-custom [role="alert"]').textContent).toContain('future');
    expect(rowFor(SUBJECT)).toBeTruthy();
  });
});
