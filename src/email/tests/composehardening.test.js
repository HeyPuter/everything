import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openCompose, closeComposers } from '../src/ui/compose.js';
import { createDraftStore, isEmptyDraft } from '../src/lib/drafts.js';
import { memoryStorage } from '../src/lib/readstate.js';
import { ADDRESS_RE, buildMessage, mentionsAttachment, MAX_ATTACHMENT_BYTES } from '../src/lib/compose.js';
import { normalizeLink, hasFormatting } from '../src/lib/richtext.js';

let drafts;
let modals;
const ready = (extra = {}) => {
  const modal = openCompose({ username: 'test', mailPath: '/test/.mail', drafts,
    prefill: { to: 'a@example.com', subject: 'Report', body: 'Here are the figures.' }, ...extra });
  modals.push(modal);
  return modal;
};
const submit = (modal) => modal.panel.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
// Something typed into the message: a dialog closed with its prefill untouched
// has had nothing written in it, and leaves no draft to find.
const write = (modal, text) => {
  const body = modal.panel.querySelector('.rte-body');
  body.innerHTML = `<div>${text}</div>`;
  body.dispatchEvent(new Event('input', { bubbles: true }));
};
const drop = (modal, files) => {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  event.dataTransfer = { types: ['Files'], files };
  modal.panel.querySelector('form').dispatchEvent(event);
};
const attachment = { name: 'report.txt', size: 3, type: 'text/plain', arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };

beforeEach(() => {
  modals = [];
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('puter', { ui: {}, APIOrigin: 'https://api.example', authToken: 'test', fs: { write: async () => {} } });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
  drafts = createDraftStore('test', memoryStorage());
});
afterEach(() => {
  modals.forEach((modal) => modal.close(true));
  document.querySelectorAll('.modal-root, .toast').forEach((node) => node.remove());
  vi.unstubAllGlobals();
});

describe('composer lifecycle', () => {
  it('closes minimized composers before signing out without losing saved text', () => {
    const modal = ready();
    write(modal, 'Figures attached.');
    modal.minimize();
    expect(document.querySelector('.compose-dock')).not.toBeNull();
    expect(closeComposers()).toBe(true);
    expect(modal.panel.isConnected).toBe(false);
    expect(document.querySelector('.compose-dock')).toBeNull();
    expect(drafts.list()[0].subject).toBe('Report');
  });

  it('marks the page while the dock is showing, so the list leaves room for it', () => {
    const docked = () => document.documentElement.classList.contains('has-compose-dock');
    const first = ready();
    const second = ready();
    first.minimize();
    second.minimize();
    expect(docked()).toBe(true);
    first.restore();
    expect(docked()).toBe(true);
    second.restore();
    expect(docked()).toBe(false);
  });

  it('restores a minimized composer and blocks sign-out if closing would lose unsaved work', () => {
    drafts.save = () => false;
    const modal = ready();
    write(modal, 'Figures attached.');
    modal.minimize();
    expect(closeComposers()).toBe(false);
    expect(modal.panel.closest('.modal-root').hidden).toBe(false);
    expect(modal.panel.querySelector('.compose-status').textContent).toContain('could not be saved');
    expect(closeComposers()).toBe(true);
  });

  it('saves attachments and restores their bytes when a draft is reopened', async () => {
    const modal = ready();
    drop(modal, [attachment]);
    await vi.waitFor(() => expect(modal.panel.querySelector('.compose-save-state').textContent).toBe('Draft saved on this device'));
    modal.close();
    expect(modal.panel.isConnected).toBe(false);
    const draft = drafts.list()[0];
    expect(draft.attachments).toBe(1);
    const reopened = ready({ draft });
    await vi.waitFor(() => expect(reopened.panel.querySelector('.compose-attachments').textContent).toContain('3 B'));
    expect(reopened.panel.querySelector('.compose-note')).toBeNull();
    submit(reopened);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch.mock.calls[0][1].body).toContain('AQID');
  });

  it('treats a file-only draft as work worth preserving', async () => {
    expect(isEmptyDraft({ attachments: 1 })).toBe(false);
    const modal = ready({ prefill: {} });
    drop(modal, [attachment]);
    await vi.waitFor(() => expect(drafts.count).toBe(1));
    modal.close();
    expect(drafts.list()[0].attachments).toBe(1);
  });

  it('saves immediately on pagehide, including the last undebounced edit', () => {
    const modal = ready();
    const subject = modal.panel.querySelector('#compose-subject');
    subject.value = 'Last edit';
    subject.dispatchEvent(new Event('input'));
    window.dispatchEvent(new Event('pagehide'));
    expect(drafts.list()[0].subject).toBe('Last edit');
  });

  it('rejects duplicate submit events and freezes the message during delivery', async () => {
    let finish;
    fetch.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const modal = ready();
    submit(modal);
    submit(modal);
    expect(fetch).toHaveBeenCalledOnce();
    expect(drafts.count).toBe(1);
    expect(modal.panel.querySelector('#compose-subject').disabled).toBe(true);
    expect(modal.panel.querySelector('.rte-body').getAttribute('contenteditable')).toBe('false');
    finish({ ok: false, status: 500, json: async () => ({ message: 'Try again' }) });
    await vi.waitFor(() => expect(modal.panel.querySelector('#compose-subject').disabled).toBe(false));
    expect(drafts.count).toBe(1);
  });

  it('deduplicates recipients across To and Cc before delivery', () => {
    const modal = ready({ prefill: { to: 'a@example.com', cc: 'A@example.com, b@example.com', subject: 'Hello' } });
    submit(modal);
    const message = fetch.mock.calls[0][1].body;
    expect(message).toContain('To: a@example.com');
    expect(message).toContain('Cc: b@example.com');
    expect(message).not.toContain('A@example.com');
  });

  it('warns about missing attachments and requires a deliberate second send', () => {
    const modal = ready({ prefill: { to: 'a@example.com', subject: 'Report', body: 'Please see attached.' } });
    submit(modal);
    expect(fetch).not.toHaveBeenCalled();
    expect(modal.panel.querySelector('.compose-status').textContent).toContain('mentions an attachment');
    submit(modal);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('does not consume IME Enter or send while composing a character', () => {
    const modal = ready();
    const input = modal.panel.querySelector('#compose-to');
    input.value = 'unfinished';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    expect(input.value).toBe('unfinished');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects oversized local files before reading their bytes', () => {
    const read = vi.fn();
    const modal = ready();
    drop(modal, [{ ...attachment, size: MAX_ATTACHMENT_BYTES + 1, arrayBuffer: read }]);
    expect(read).not.toHaveBeenCalled();
    expect(modal.panel.querySelector('.compose-status').textContent).toContain('exceed');
    submit(modal);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps a failed attachment save visible and warns before close', async () => {
    drafts.saveAttachments = async () => { throw new Error('Quota'); };
    const modal = ready();
    drop(modal, [attachment]);
    await vi.waitFor(() => expect(modal.panel.querySelector('.compose-save-state').textContent).toContain('attachments not saved'));
    modal.close();
    expect(modal.panel.isConnected).toBe(true);
    modal.close();
    expect(modal.panel.isConnected).toBe(false);
  });

  it('an old attachment save cannot mark a newly added pending file as saved', async () => {
    let finishSave;
    drafts.saveAttachments = () => new Promise((resolve) => { finishSave = resolve; });
    const modal = ready();
    drop(modal, [attachment]);
    await vi.waitFor(() => expect(finishSave).toBeTypeOf('function'));
    drop(modal, [{ ...attachment, name: 'pending.txt', arrayBuffer: () => new Promise(() => {}) }]);
    finishSave(true);
    await Promise.resolve();
    modal.close();
    expect(modal.panel.isConnected).toBe(true);
    expect(modal.panel.querySelector('.compose-status').textContent).toContain('could not be saved');
  });

  it('blocks send while draft files are loading and warns if they cannot be recovered', async () => {
    let loaded;
    drafts.loadAttachments = () => new Promise((resolve) => { loaded = resolve; });
    const modal = ready({ draft: { id: 'missing', to: 'a@example.com', subject: 'Files', attachments: 1 } });
    submit(modal);
    expect(fetch).not.toHaveBeenCalled();
    expect(modal.panel.querySelector('.compose-status').textContent).toContain('Wait');
    loaded([]);
    await vi.waitFor(() => expect(modal.panel.querySelector('.compose-save-state').textContent).not.toContain('Loading'));
    submit(modal);
    expect(fetch).not.toHaveBeenCalled();
    expect(modal.panel.querySelector('.compose-status').textContent).toContain('missing attachments');
  });

  it('late attachment completion cannot overwrite text edited after closing a draft', async () => {
    let finishSave;
    drafts.saveAttachments = () => new Promise((resolve) => { finishSave = resolve; });
    const modal = ready();
    drop(modal, [attachment]);
    await vi.waitFor(() => expect(finishSave).toBeTypeOf('function'));
    modal.close(true);
    const entry = drafts.list()[0];
    drafts.save({ ...entry, subject: 'Newer edit' });
    finishSave(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(drafts.get(entry.id).subject).toBe('Newer edit');
  });
});

describe('outgoing content boundaries', () => {
  it.each(['a..b@example.com', 'a@-example.com', 'a@exam_ple.com', 'a@example.com<', 'a\u0000@example.com'])('rejects malformed mailbox %s', (address) => {
    expect(ADDRESS_RE.test(address)).toBe(false);
  });
  it('rejects header injection from reply metadata', () => {
    expect(() => buildMessage({ from: 'a@example.com', to: ['b@example.com'], subject: 'Hello', body: '',
      messageId: '<test@example.com>', date: new Date(), inReplyTo: '<original@example.com>\r\nBcc: secret@example.com' })).toThrow('headers');
  });
  it('ignores attachment language in quotes, signatures and forwarded content', () => {
    expect(mentionsAttachment('Thanks!\n> Please see attached.')).toBe(false);
    expect(mentionsAttachment('Thanks!\n-- \nPlease see attached.')).toBe(false);
    expect(mentionsAttachment('For reference:\n---------- Forwarded message ----------\nI attached the file.')).toBe(false);
    expect(mentionsAttachment("I've attached our proposal.")).toBe(true);
  });
  it('normalizes web and email links while rejecting dangerous schemes', () => {
    expect(normalizeLink('example.com/report')).toBe('https://example.com/report');
    expect(normalizeLink('alice@example.com')).toBe('mailto:alice@example.com');
    expect(normalizeLink('javascript:alert(1)')).toBe('');
    expect(normalizeLink('data:text/html,hi')).toBe('');
    expect(normalizeLink('https://user:pass@example.com')).toBe('');
    expect(hasFormatting('<a href="https://example.com">Our report</a>')).toBe(true);
  });
});
