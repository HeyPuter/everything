// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { addComment, getThread } from '../src/core/comments.js';
import { findMentions, mentionedPeople } from '../src/core/mentions.js';
import { createMentionNotifier } from '../src/ui/mention-notify.js';
import * as P from '../src/lib/puter.js';
import * as T from '../src/ui/toast.js';

// Someone a shared workbook was shared with has no file of it. Mentioning anyone in a comment there asked "This
// spreadsheet is not saved to Puter yet, so ana cannot open the comment. Save it and share it with them?", for a
// workbook everyone in it has open, and "Save, share and notify" failed with "Save the spreadsheet first".
afterEach(() => { vi.restoreAllMocks(); });

const ME = { username: 'demo' };

function setup() {
  const wb = new Workbook();
  const members = [{ username: 'alice', role: 'owner' }, { username: 'demo', role: 'editor' }, { username: 'ana', role: 'editor' }];
  const doc = { wb, name: 'Plan', path: null, uid: null, save: vi.fn(), collab: { room: 'r1', people: new Map(), request: vi.fn(async () => ({ members })) } };
  vi.spyOn(P, 'canShare').mockReturnValue(true);
  vi.spyOn(P, 'shareFile').mockResolvedValue({});
  const toast = vi.spyOn(T, 'toast').mockImplementation(() => {});
  const mailer = { available: () => true, sendMentions: vi.fn(async () => ({ sent: 0, failed: 0, results: [] })) };
  const ask = vi.fn(async () => ({ action: 'share', mode: 'write' }));
  const notifier = createMentionNotifier({ doc, wb, mailer, me: () => ME, ask, location: { origin: 'https://spreadsheet.puter.com', pathname: '/' } });
  return { wb, doc, notifier, ask, toast };
}

function posted(wb, text, people) {
  const id = wb.activeSheetId;
  addComment(wb, id, 3, 1, text, 'demo', null, { mentions: findMentions(text, people) });
  const item = getThread(wb, id, 3, 1).items.at(-1);
  return { sheetId: id, r: 3, c: 1, item, people: mentionedPeople(item.mentions) };
}

it('does not ask a member of a shared workbook to save and share it before telling another member', async () => {
  const { wb, doc, notifier, ask, toast } = setup();
  await notifier.notify(posted(wb, '@ana have a look', [{ name: 'ana', user: 'ana' }]));
  expect(ask).not.toHaveBeenCalled();
  expect(doc.save).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith('ana will see the mention when they open this spreadsheet', expect.anything());
});

it('says that someone outside the shared workbook needs its owner to invite them', async () => {
  const { wb, notifier, ask, toast } = setup();
  await notifier.notify(posted(wb, '@bo and @ana have a look', [{ name: 'bo', user: 'bo' }, { name: 'ana', user: 'ana' }]));
  expect(ask).not.toHaveBeenCalled();
  expect(P.shareFile).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith('bo cannot open this shared workbook. Ask its owner to invite them', expect.anything());
  expect(toast).toHaveBeenCalledWith('ana will see the mention when they open this spreadsheet', expect.anything());
});
