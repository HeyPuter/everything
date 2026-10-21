// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { addComment, getThread } from '../src/core/comments.js';
import { findMentions, mentionedPeople } from '../src/core/mentions.js';
import { createMentionNotifier } from '../src/ui/mention-notify.js';
import { parseAppHash } from '../src/lib/links.js';
import * as P from '../src/lib/puter.js';
import * as T from '../src/ui/toast.js';

// A mention in a shared workbook was mailed with a link to the owner's file by its id: a member the file itself was
// not shared with was told "That spreadsheet does not exist, or has not been shared with you", and one it was shared
// with opened the file alone, outside the shared workbook, where what they changed was later written over by it. Members
// of the shared workbook other than its owner were not written to at all.
afterEach(() => { vi.restoreAllMocks(); });

const SERVER = 'https://spreadsheet-abc.puter.work';

function setup({ owner = true, fileShares = [] } = {}) {
  const wb = new Workbook();
  const members = [{ username: 'demo', role: owner ? 'owner' : 'editor' }, { username: 'ana', role: 'editor' }];
  const request = vi.fn(async ({ op }) => (op === 'members' ? { members } : { ok: true }));
  const doc = { wb, name: 'Plan', path: owner ? 'Spreadsheets/Plan.xlsx' : null, uid: owner ? 'uid-7' : null, save: vi.fn(),
    collab: { room: 'r1', o: { server: SERVER }, user: { uuid: 'me' }, owner: owner ? 'me' : 'someone', people: new Map(), request } };
  vi.spyOn(P, 'canShare').mockReturnValue(true);
  vi.spyOn(P, 'shareAccess').mockResolvedValue(fileShares);
  vi.spyOn(P, 'shareFile').mockResolvedValue({});
  vi.spyOn(T, 'toast').mockImplementation(() => {});
  const mailer = { available: () => true, sendMentions: vi.fn(async ({ recipients }) => ({ sent: recipients.length, failed: 0, results: recipients.map((r) => ({ email: r.email, status: 'sent' })) })) };
  const ask = vi.fn(async () => ({ action: 'share', mode: 'write' }));
  const notifier = createMentionNotifier({ doc, wb, mailer, me: () => ({ username: 'demo' }), ask, location: { origin: 'https://spreadsheet.puter.com', pathname: '/' } });
  return { wb, notifier, ask, mailer, request };
}

function posted(wb, text, people) {
  const id = wb.activeSheetId;
  addComment(wb, id, 3, 1, text, 'demo', null, { mentions: findMentions(text, people) });
  const item = getThread(wb, id, 3, 1).items.at(-1);
  return { sheetId: id, r: 3, c: 1, item, people: mentionedPeople(item.mentions) };
}

const ROOM_LINK = `https://spreadsheet.puter.com/#/live/r1?server=${encodeURIComponent(SERVER)}&range=${encodeURIComponent('Sheet1!B4')}`;

it('links a mention in a shared workbook to the shared workbook, at the comment\'s cell', async () => {
  for (const owner of [true, false]) {
    const { wb, notifier, mailer } = setup({ owner });
    await notifier.notify(posted(wb, '@ana have a look', [{ name: 'ana', user: 'ana' }]));
    expect(mailer.sendMentions).toHaveBeenCalledTimes(1);
    expect(mailer.sendMentions.mock.calls[0][0].link).toBe(ROOM_LINK);
  }
  expect(parseAppHash(new URL(ROOM_LINK).hash)).toEqual({ route: 'live', server: SERVER, room: 'r1', token: undefined, range: 'Sheet1!B4' });
});

it('offers the owner to bring in someone the file is shared with but who is not in the shared workbook', async () => {
  const { wb, notifier, ask, request } = setup({ fileShares: [{ who: 'user', recipient: 'bo' }] });
  await notifier.notify(posted(wb, '@bo have a look', [{ name: 'bo', user: 'bo' }]));
  expect(ask).toHaveBeenCalledWith([expect.objectContaining({ user: 'bo' })], { unsaved: false });
  expect(request).toHaveBeenCalledWith({ op: 'invite-user', username: 'bo', role: 'editor' });
});
