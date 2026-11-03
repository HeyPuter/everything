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
