import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Doc, setAutoSaveEnabled } from '../src/lib/doc.js';
import { addComment, getThread } from '../src/core/comments.js';
import { findMentions, mentionedPeople } from '../src/core/mentions.js';
import { createMentionNotifier } from '../src/ui/mention-notify.js';
import { workbookFromFile } from '../src/core/io.js';
import * as P from '../src/lib/puter.js';
import * as T from '../src/ui/toast.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { installMockPuter } from './helpers/mock-puter.js';

const ANA = { name: 'ana', user: 'ana' };
const ME = { username: 'demo', email: 'demo@example.com' };

let mock;
// SheetJS is loaded on first use with a real dynamic import; warm it up so no test waits on it.
beforeAll(async () => { await Doc.blank().toXlsxBlob(); });
beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
  mock = installMockPuter();
  vi.spyOn(P, 'canShare').mockReturnValue(true);
  vi.spyOn(P, 'shareAccess').mockResolvedValue([{ who: 'user', recipient: 'ana' }]);
});
afterEach(() => { vi.restoreAllMocks(); delete globalThis.puter; });

async function savedFile() {
  const doc = Doc.blank();
  doc.wb.setInput(doc.wb.activeSheetId, 0, 0, 'plan');
  await doc.rename('Plan');
  expect(await doc.save()).toBe(true);
  return doc;
}

function post(doc, text) {
  const { wb } = doc;
  addComment(wb, wb.activeSheetId, 3, 1, text, 'demo', null, { mentions: findMentions(text, [ANA]) });
  const item = getThread(wb, wb.activeSheetId, 3, 1).items.at(-1);
  return { sheetId: wb.activeSheetId, r: 3, c: 1, item, people: mentionedPeople(item.mentions) };
}

/** Does the file on the drive hold the comment? */
async function fileHasComment(doc) {
  const wb = await workbookFromFile(await P.readFile(doc.path), 'Plan.xlsx');
  return !!getThread(wb, wb.activeSheetId, 3, 1);
}

// With AutoSave off, the mail went out as soon as the comment was posted, while the comment was only on
// screen: the person mentioned followed its link to a file that held no such comment.
it('emails the people mentioned once a save has put the comment in the file, with AutoSave off', async () => {
  setAutoSaveEnabled(false);
  const doc = await savedFile();
  const toast = vi.spyOn(T, 'toast').mockImplementation(() => {});
  const sent = [];
  const mailer = { available: () => true, sendMentions: vi.fn(async ({ recipients }) => { sent.push(await fileHasComment(doc)); return { sent: recipients.length, failed: 0, results: [] }; }) };
  const notifier = createMentionNotifier({ doc, wb: doc.wb, mailer, me: () => ME, location: { origin: 'https://spreadsheet.puter.com', pathname: '/' } });
  try {
    const notified = notifier.notify(post(doc, '@ana please check'));
    await new Promise((r) => setTimeout(r, 50));
    expect(mailer.sendMentions).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('ana will be emailed when you save'), expect.anything());
    // More typing after the comment does not hold the mail back past the save that writes the comment.
    doc.wb.setInput(doc.wb.activeSheetId, 0, 1, 'more');
    expect(await doc.save()).toBe(true);
    const out = await notified;
    expect(out.sent).toBe(1);
    expect(sent).toEqual([true]);
  } finally { doc.destroy(); }
});

it('emails at once when the file holds the comment already', async () => {
  setAutoSaveEnabled(false);
  const doc = await savedFile();
  vi.spyOn(T, 'toast').mockImplementation(() => {});
  const mailer = { available: () => true, sendMentions: vi.fn(async ({ recipients }) => ({ sent: recipients.length, failed: 0, results: [] })) };
  const notifier = createMentionNotifier({ doc, wb: doc.wb, mailer, me: () => ME, location: { origin: 'https://spreadsheet.puter.com', pathname: '/' } });
  try {
    const posted = post(doc, '@ana please check');
    expect(await doc.save()).toBe(true);
    expect((await notifier.notify(posted)).sent).toBe(1);
  } finally { doc.destroy(); }
});

// Waiting for the save, the mail went out for whatever the comment had been when it was posted: one undone or
// deleted meanwhile was still mailed (to someone the author had just taken back), and one moved by rows inserted
// above it was mailed with a link to the cell it had left.
describe('a mention mailed after the save', () => {
  async function pending() {
    setAutoSaveEnabled(false);
    const doc = await savedFile();
    vi.spyOn(T, 'toast').mockImplementation(() => {});
    const mails = [];
    const mailer = { available: () => true, sendMentions: vi.fn(async (mail) => { mails.push(mail); return { sent: mail.recipients.length, failed: 0, results: [] }; }) };
    const notifier = createMentionNotifier({ doc, wb: doc.wb, mailer, me: () => ME, location: { origin: 'https://spreadsheet.puter.com', pathname: '/' } });
    return { doc, mails, mailer, notified: notifier.notify(post(doc, '@ana please check')) };
  }

  it('is not sent for a comment undone before the save', async () => {
    const { doc, mailer, notified } = await pending();
    try {
      await new Promise((r) => setTimeout(r, 20));
      doc.wb.undo();
      expect(getThread(doc.wb, doc.wb.activeSheetId, 3, 1)).toBeNull();
      expect(await doc.save()).toBe(true);
      expect((await notified).sent).toBe(0);
      expect(mailer.sendMentions).not.toHaveBeenCalled();
    } finally { doc.destroy(); }
  });

  it('links to the cell the comment has moved to by the save', async () => {
    const { doc, mails, notified } = await pending();
    try {
      await new Promise((r) => setTimeout(r, 20));
      doc.wb.insertRows(doc.wb.activeSheetId, 0, 2);
      expect(await doc.save()).toBe(true);
      expect((await notified).sent).toBe(1);
      expect(mails[0].comment.cell).toBe(`${doc.wb.sheet(doc.wb.activeSheetId).name}!B6`);
    } finally { doc.destroy(); }
  });
});

// With AutoSave off the mail waits for the save that puts the comment in the file. The tab closed first, the edits
// stayed on this device in a draft, but the mail was in that tab alone: the save that later wrote the draft sent
// nothing, and the person mentioned never heard of the comment. The mail waits in this browser with the draft now.
describe('a mention whose tab was closed before the save', () => {
  const mailerFor = (mails) => ({ available: () => true, sendMentions: vi.fn(async (mail) => { mails.push(mail); return { sent: mail.recipients.length, failed: 0, results: [] }; }) });
  const LOC = { origin: 'https://spreadsheet.puter.com', pathname: '/' };

  async function closedBeforeSave() {
    setAutoSaveEnabled(false);
    const doc = await savedFile();
    vi.spyOn(T, 'toast').mockImplementation(() => {});
    const mails = [];
    const notifier = createMentionNotifier({ doc, wb: doc.wb, mailer: mailerFor(mails), me: () => ME, location: LOC });
    notifier.notify(post(doc, '@ana please check'));
    await new Promise((r) => setTimeout(r, 20));
    expect(doc.writeDraft()).toBe(true);
    doc.destroy(); // the tab is closed: the edits are in the draft, the save never came
    expect(mails).toEqual([]);
    return doc.path;
  }

  it('is sent once the draft, opened again, is saved', async () => {
    const path = await closedBeforeSave();
    const doc = await Doc.fromPath(path);
    const mails = [];
    const notifier = createMentionNotifier({ doc, wb: doc.wb, mailer: mailerFor(mails), me: () => ME, location: LOC });
    const stop = notifier.resume();
    try {
      expect(doc.recoverable).toBeTruthy();
      await new Promise((r) => setTimeout(r, 20));
      expect(mails).toEqual([]);
      expect(doc.restoreDraft()).toBe(true);
      await new Promise((r) => setTimeout(r, 20));
      expect(mails).toEqual([]);
      expect(await doc.save()).toBe(true);
      await new Promise((r) => setTimeout(r, 20));
      expect(mails).toHaveLength(1);
      expect(mails[0].recipients).toEqual([{ email: 'ana@puter.email', name: 'ana' }]);
      expect(mails[0].comment.cell).toBe(`${doc.wb.sheet(doc.wb.activeSheetId).name}!B4`);
      expect(mails[0].link).toContain(doc.uid);
      // Sent once: another visit sends it no more.
      expect(await doc.save()).toBe(true);
      const again = [];
      createMentionNotifier({ doc, wb: doc.wb, mailer: mailerFor(again), me: () => ME, location: LOC }).resume()();
      await new Promise((r) => setTimeout(r, 20));
      expect(mails).toHaveLength(1);
      expect(again).toEqual([]);
    } finally { stop(); doc.destroy(); }
  });

  it('is not sent when the draft is discarded', async () => {
    const path = await closedBeforeSave();
    const doc = await Doc.fromPath(path);
    const mails = [];
    const stop = createMentionNotifier({ doc, wb: doc.wb, mailer: mailerFor(mails), me: () => ME, location: LOC }).resume();
    try {
      doc.discardDraft();
      doc.wb.setInput(doc.wb.activeSheetId, 0, 1, 'other work');
      expect(await doc.save()).toBe(true);
      await new Promise((r) => setTimeout(r, 20));
      expect(mails).toEqual([]);
    } finally { stop(); doc.destroy(); }
  });
});

// Saved as a copy before the save of the file, the comment reached the copy, and the mail linked the copy: but who
// could open it had been asked of the file, and the copy is shared with nobody. Access is asked of the copy now.
it('asks again who can open a copy saved before the mail went, rather than linking a copy nobody was given', async () => {
  setAutoSaveEnabled(false);
  const doc = await savedFile();
  vi.spyOn(T, 'toast').mockImplementation(() => {});
  const original = doc.path;
  P.shareAccess.mockImplementation(async (path) => (path === original ? [{ who: 'user', recipient: 'ana' }] : []));
  const ask = vi.fn(async () => null);
  const mailer = { available: () => true, sendMentions: vi.fn(async ({ recipients }) => ({ sent: recipients.length, failed: 0, results: [] })) };
  const notifier = createMentionNotifier({ doc, wb: doc.wb, mailer, me: () => ME, ask, location: { origin: 'https://spreadsheet.puter.com', pathname: '/' } });
  try {
    const notified = notifier.notify(post(doc, '@ana please check'));
    await new Promise((r) => setTimeout(r, 20));
    expect(ask).not.toHaveBeenCalled();
    expect(await doc.saveAs('Plan copy')).toBeNull();
    expect(doc.path).not.toBe(original);
    await notified;
    expect(ask).toHaveBeenCalledTimes(1);
    expect(mailer.sendMentions).not.toHaveBeenCalled();
  } finally { doc.destroy(); }
});
