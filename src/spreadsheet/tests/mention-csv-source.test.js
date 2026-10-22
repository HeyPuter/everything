// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { addComment, getThread } from '../src/core/comments.js';
import { findMentions, mentionedPeople } from '../src/core/mentions.js';
import { createMentionNotifier } from '../src/ui/mention-notify.js';
import * as P from '../src/lib/puter.js';
import * as T from '../src/ui/toast.js';

// A .csv opened from the drive keeps no comments, and its edits go to an .xlsx made at the first save (inside the
// Puter desktop, where the user picks it). Mentioning someone in a comment there, before that save, shared the .csv
// with them and mailed a link to it: they opened a file without the comment, or without any of the edits.
afterEach(() => { vi.restoreAllMocks(); });

const ANA = { name: 'ana', user: 'ana' };

function setup({ saveTo = 'Desktop/data.xlsx' } = {}) {
  const wb = new Workbook();
  const doc = {
    wb, name: 'data', path: 'Desktop/data.csv', uid: 'uid-csv', collab: null,
    save: vi.fn(async () => { if (saveTo) { doc.path = saveTo; doc.uid = 'uid-xlsx'; } return !!saveTo; }),
  };
  vi.spyOn(P, 'canShare').mockReturnValue(true);
  vi.spyOn(P, 'shareAccess').mockResolvedValue([{ who: 'user', recipient: 'ana' }]);
  vi.spyOn(P, 'shareFile').mockResolvedValue({});
  vi.spyOn(T, 'toast').mockImplementation(() => {});
  const mailer = { available: () => true, sendMentions: vi.fn(async ({ recipients }) => ({ sent: recipients.length, failed: 0, results: recipients.map((r) => ({ email: r.email, status: 'sent' })) })) };
  const ask = vi.fn(async () => ({ action: 'share', mode: 'write' }));
  const notifier = createMentionNotifier({ doc, wb, mailer, me: () => ({ username: 'demo' }), ask, location: { origin: 'https://spreadsheet.puter.com', pathname: '/' } });
  return { wb, doc, notifier, ask, mailer };
}

function posted(wb) {
  const id = wb.activeSheetId;
  addComment(wb, id, 3, 1, '@ana have a look', 'demo', null, { mentions: findMentions('@ana have a look', [ANA]) });
  const item = getThread(wb, id, 3, 1).items.at(-1);
  return { sheetId: id, r: 3, c: 1, item, people: mentionedPeople(item.mentions) };
}

it('saves the .xlsx first, and shares and links to it rather than the .csv', async () => {
  const { wb, doc, notifier, ask, mailer } = setup();
  await notifier.notify(posted(wb));
  expect(ask).toHaveBeenCalledWith([ANA], { unsaved: true, file: 'data.csv' });
  expect(doc.save).toHaveBeenCalledOnce();
  expect(P.shareFile).toHaveBeenCalledWith('Desktop/data.xlsx', 'ana', 'write');
  expect(mailer.sendMentions.mock.calls[0][0].link).toContain('uid-xlsx');
});

it('shares nothing when the .xlsx was not saved (its Save dialog cancelled)', async () => {
  const { wb, notifier, mailer } = setup({ saveTo: null });
  await notifier.notify(posted(wb));
  expect(P.shareFile).not.toHaveBeenCalled();
  expect(mailer.sendMentions).not.toHaveBeenCalled();
});
