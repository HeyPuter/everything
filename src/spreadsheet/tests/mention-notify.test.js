// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { addComment, getThread, replyToThread, setThreadAssignee, readComments, commentsJSON, setThreadResolved } from '../src/core/comments.js';
import { findMentions, mentionedPeople, assignmentsOfPerson } from '../src/core/mentions.js';
import { withoutAccess, createMentionNotifier, createMentionAlerts, mentionCandidates } from '../src/ui/mention-notify.js';
import * as P from '../src/lib/puter.js';
import * as T from '../src/ui/toast.js';

const ANA = { name: 'ana', user: 'ana' };
const KIM = { name: 'kim@example.org', email: 'kim@example.org' };
const ME = { username: 'demo', email: 'demo@example.com' };

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

function posted(wb, text, people, author = 'demo') {
  const id = wb.activeSheetId;
  addComment(wb, id, 3, 1, text, author, null, { mentions: findMentions(text, people) });
  const item = getThread(wb, id, 3, 1).items.at(-1);
  return { sheetId: id, r: 3, c: 1, item, people: mentionedPeople(item.mentions) };
}

describe('who cannot open the workbook', () => {
  it('is everyone mentioned but the user, those the file is shared with and the members of a shared workbook', () => {
    const people = [ANA, KIM, { name: 'bo', user: 'bo' }, { name: 'demo', user: 'demo' }];
    const rows = [{ who: 'user', recipient: 'ana' }, { who: 'invite', recipient: 'kim@example.org' }];
    expect(withoutAccess(people, { rows, members: [], me: ME }).map((p) => p.name)).toEqual(['bo']);
    expect(withoutAccess(people, { rows: [], members: ['bo', 'ana'], me: ME }).map((p) => p.name)).toEqual(['kim@example.org']);
    expect(withoutAccess(people, { rows: [{ who: 'anyone' }], me: ME })).toEqual([]);
    // Access that could not be read (someone else's file) is not taken for no access.
    expect(withoutAccess(people, { rows: null, me: ME })).toEqual([]);
    expect(withoutAccess(people, { unsaved: true, me: ME }).map((p) => p.name)).toEqual(['ana', 'kim@example.org', 'bo']);
  });
});

describe('telling the people mentioned', () => {
  function setup({ rows = [], available = true, ask = vi.fn(async () => ({ action: 'share', mode: 'write' })) } = {}) {
    const wb = new Workbook();
    const doc = { wb, name: 'Plan', path: 'Spreadsheets/Plan.xlsx', uid: 'uid-7', collab: null, save: vi.fn() };
    vi.spyOn(P, 'canShare').mockReturnValue(true);
    vi.spyOn(P, 'shareAccess').mockResolvedValue(rows);
    vi.spyOn(P, 'shareFile').mockResolvedValue({});
    const toast = vi.spyOn(T, 'toast').mockImplementation(() => {});
    const mailer = {
      available: () => available,
      sendMentions: vi.fn(async ({ recipients }) => ({ sent: recipients.length, failed: 0, results: recipients.map((r) => ({ email: r.email, status: 'sent' })) })),
    };
    const notifier = createMentionNotifier({ doc, wb, mailer, me: () => ME, ask, location: { origin: 'https://spreadsheet.puter.com', pathname: '/' } });
    return { wb, doc, mailer, notifier, ask, toast };
  }

  it('offers to share with whoever cannot open it, shares, then emails each with a link to the cell', async () => {
    const { wb, mailer, notifier, ask } = setup({ rows: [{ who: 'user', recipient: 'ana' }] });
    const out = await notifier.notify(posted(wb, '@ana and @kim@example.org please check', [ANA]));
    expect(ask).toHaveBeenCalledWith([KIM], { unsaved: false });
    expect(P.shareFile).toHaveBeenCalledTimes(1);
    expect(P.shareFile).toHaveBeenCalledWith('Spreadsheets/Plan.xlsx', 'kim@example.org', 'write');
    expect(out.sent).toBe(2);
    const [req] = mailer.sendMentions.mock.calls[0];
    expect(req.recipients).toEqual([{ email: 'ana@puter.email', name: 'ana' }, { email: 'kim@example.org', name: 'kim@example.org' }]);
    expect(req.link).toBe('https://spreadsheet.puter.com/#/file/uid-7?range=Sheet1!B4');
    expect(req.comment).toMatchObject({ text: '@ana and @kim@example.org please check', cell: 'Sheet1!B4' });
    expect(req.comment.id).toMatch(/^\{[0-9A-F-]+\}$/);
    expect(req.assigned).toBe(false);
  });

  it('asks nothing when everyone can open it, and tells nobody when the user says not to', async () => {
    const all = setup({ rows: [{ who: 'user', recipient: 'ana' }] });
    await all.notifier.notify(posted(all.wb, '@ana hi', [ANA]));
    expect(all.ask).not.toHaveBeenCalled();
    expect(all.mailer.sendMentions).toHaveBeenCalledTimes(1);

    const no = setup({ ask: vi.fn(async () => null) });
    const out = await no.notifier.notify(posted(no.wb, '@ana hi', [ANA]));
    expect(out.skipped).toBe(true);
    expect(no.mailer.sendMentions).not.toHaveBeenCalled();
    expect(P.shareFile).not.toHaveBeenCalled();
  });

  it('may tell them without sharing', async () => {
    const { wb, mailer, notifier } = setup({ ask: vi.fn(async () => ({ action: 'notify' })) });
    await notifier.notify(posted(wb, '@ana hi', [ANA]));
    expect(P.shareFile).not.toHaveBeenCalled();
    expect(mailer.sendMentions).toHaveBeenCalledTimes(1);
  });

  it('writes to the person assigned apart, saying so', async () => {
    const { wb, mailer, notifier } = setup({ rows: [{ who: 'user', recipient: 'ana' }, { who: 'invite', recipient: 'kim@example.org' }] });
    const p = posted(wb, '@ana do this, cc @kim@example.org', [ANA]);
    await notifier.notify({ ...p, assigned: ANA });
    const calls = mailer.sendMentions.mock.calls.map(([req]) => [req.recipients.map((r) => r.email), req.assigned]);
    expect(calls).toEqual([[['kim@example.org'], false], [['ana@puter.email'], true]]);
  });

  it('says the mention will be seen in the workbook when email cannot be sent from here', async () => {
    const { wb, mailer, notifier, toast } = setup({ rows: [{ who: 'user', recipient: 'ana' }], available: false });
    await notifier.notify(posted(wb, '@ana hi', [ANA]));
    expect(mailer.sendMentions).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('ana will see the mention when they open this spreadsheet', expect.anything());
  });

  it('lists the people who can be mentioned: shared with, commenters, never the user', async () => {
    const { wb, doc } = setup({ rows: [{ who: 'user', recipient: 'ana' }, { who: 'invite', recipient: 'kim@example.org' }] });
    addComment(wb, wb.activeSheetId, 0, 0, 'hello', 'bo');
    addComment(wb, wb.activeSheetId, 1, 0, 'mine', 'demo');
    const people = await mentionCandidates({ doc, wb, me: ME });
    expect(people.map((p) => [p.name, p.user || p.email])).toEqual([['ana', 'ana'], ['kim@example.org', 'kim@example.org'], ['bo', 'bo']]);
  });
});

describe('assigning a thread', () => {
  it('is undoable, kept through replies and resolving, and serialized', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    addComment(wb, id, 0, 0, '@ana please', 'demo', null, { mentions: findMentions('@ana please', [ANA]) });
    expect(setThreadAssignee(wb, id, 0, 0, ANA)).toBe(true);
    expect(getThread(wb, id, 0, 0).assignee).toEqual({ name: 'ana', user: 'ana' });
    replyToThread(wb, id, 0, 0, 'On it', 'ana');
    expect(getThread(wb, id, 0, 0).assignee).toEqual({ name: 'ana', user: 'ana' });
    expect(readComments(commentsJSON(wb.sheet(id).comments)).get('0,0').assignee).toEqual({ name: 'ana', user: 'ana' });
    expect(assignmentsOfPerson(wb, { username: 'ana' })).toHaveLength(1);
    setThreadResolved(wb, id, 0, 0, true);
    expect(assignmentsOfPerson(wb, { username: 'ana' })).toHaveLength(0);
    wb.undo(); wb.undo();
    expect(getThread(wb, id, 0, 0).items).toHaveLength(1);
    wb.undo();
    expect(getThread(wb, id, 0, 0).assignee).toBeUndefined();
    expect(setThreadAssignee(wb, id, 0, 0, { name: 'nobody' })).toBe(false);
  });
});

describe('telling the user they were mentioned', () => {
  function alerts(wb) {
    const toast = vi.spyOn(T, 'toast').mockImplementation(() => {});
    const goTo = vi.fn();
    const a = createMentionAlerts({ wb, me: () => ({ username: 'ana' }), fileKey: () => 'uid-1', goTo, storage: memoryStorage(), delay: 0 });
    return { a, toast, goTo };
  }

  it('says what was not seen yet, once, and goes to it', () => {
    const wb = new Workbook();
    posted(wb, '@ana look here', [ANA]);
    const { a, toast, goTo } = alerts(wb);
    expect(a.check()).toHaveLength(1);
    expect(toast).toHaveBeenCalledWith('demo mentioned you on Sheet1!B4', expect.objectContaining({ action: expect.anything() }));
    toast.mock.calls[0][1].action.onClick();
    expect(goTo).toHaveBeenCalledWith(wb.activeSheetId, 3, 1);
    expect(a.check()).toHaveLength(0);
    replyToThread(wb, wb.activeSheetId, 3, 1, '@ana and again', 'bo', null, { mentions: findMentions('@ana and again', [ANA]) });
    expect(a.check()).toHaveLength(1);
    expect(toast).toHaveBeenLastCalledWith('bo mentioned you on Sheet1!B4', expect.anything());
  });

  it('counts several on opening, says an assignment as one, and leaves out the user’s own', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    posted(wb, '@ana one', [ANA]);
    addComment(wb, id, 0, 0, '@ana two', 'bo', null, { mentions: findMentions('@ana two', [ANA]) });
    setThreadAssignee(wb, id, 0, 0, ANA);
    addComment(wb, id, 5, 5, '@ana note to self', 'ana', null, { mentions: findMentions('@ana note to self', [ANA]) });
    const { a, toast } = alerts(wb);
    expect(a.check()).toHaveLength(2);
    expect(toast).toHaveBeenCalledWith('You have 2 comments that mention you or are assigned to you', expect.anything());
  });

  it('watches the workbook for comments as they arrive', async () => {
    vi.useFakeTimers();
    try {
      const wb = new Workbook();
      const { a, toast } = alerts(wb);
      a.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(toast).not.toHaveBeenCalled();
      posted(wb, '@ana new', [ANA], 'kim');
      await vi.advanceTimersByTimeAsync(1);
      expect(toast).toHaveBeenCalledWith('kim mentioned you on Sheet1!B4', expect.anything());
      a.stop();
    } finally { vi.useRealTimers(); }
  });
});
