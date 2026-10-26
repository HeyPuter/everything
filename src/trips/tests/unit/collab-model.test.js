// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  EDIT_WINDOW, authorOf, canEditMessage, canManage, chatTimeline, emojiOnly, feedAction, filesByLink, newEntryRevs, nextVote,
  normalizeURL, noteCategories, noteColorOf, percentages, pollView, reactionPatch, reactionsOf, linkToggle, votePatch,
} from '../../src/views/trip/collab/model.js';

const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const C = '00000000-0000-4000-8000-000000000003';
const T0 = Date.UTC(2027, 4, 1, 10, 0);
const msg = (id, by, cr, extra = {}) => ({ id, text: id, author: by, by, cr, v: id, ...extra });

describe('authorship', () => {
  it('prefers the immutable author over the last editor', () => {
    expect(authorOf({ author: A, by: B })).toBe(A);
    expect(authorOf({ by: B })).toBe(B);
    expect(canManage({ author: A, by: B }, { uid: B, role: 'editor' })).toBe(false);
    expect(canManage({ author: A, by: B }, { uid: B, role: 'owner' })).toBe(true);
  });
  it('allows editing own messages for 15 minutes only', () => {
    const own = msg('m1', A, T0);
    expect(canEditMessage(own, { uid: A, now: T0 + EDIT_WINDOW })).toBe(true);
    expect(canEditMessage(own, { uid: A, now: T0 + EDIT_WINDOW + 1 })).toBe(false);
    expect(canEditMessage(own, { uid: B, now: T0 })).toBe(false);
    expect(canEditMessage({ ...own, author: undefined, by: B }, { uid: A, now: T0 })).toBe(false);
  });
});

describe('chatTimeline', () => {
  it('adds day separators in the viewer zone and groups runs by author within 5 minutes', () => {
    const list = [
      msg('m1', A, T0), msg('m2', A, T0 + 60_000), msg('m3', A, T0 + 6 * 60_000), msg('m4', B, T0 + 7 * 60_000),
      msg('m5', B, T0 + 8 * 60_000, { reply: 'm1' }), msg('m6', B, Date.UTC(2027, 4, 1, 23, 30)),
    ];
    const items = chatTimeline(list, { zone: 'Europe/Lisbon' });
    expect(items.map((item) => (item.kind === 'day' ? item.date : `${item.msg.id}${item.grouped ? '+' : ''}`)))
      .toEqual(['2027-05-01', 'm1', 'm2+', 'm3', 'm4', 'm5', '2027-05-02', 'm6']);
    expect(chatTimeline(list, { zone: 'UTC', limit: 2 }).filter((item) => item.kind === 'msg').map((item) => item.msg.id)).toEqual(['m5', 'm6']);
  });
});

describe('emojiOnly', () => {
  it.each([['👍', true], ['🎉🎉🎉', true], ['❤️ 😂', true], ['👨‍👩‍👧', true], ['🇵🇹', true], ['1️⃣', true], ['🙂🙂🙂🙂🙂🙂🙂🙂🙂', false],
    ['ok 👍', false], ['1', false], ['', false], ['   ', false], ['#', false]])('%j → %s', (text, expected) => expect(emojiOnly(text)).toBe(expected));
});

describe('reactions', () => {
  it('lists non-empty reactions and toggles only the caller path', () => {
    const message = { react: { '👍': { [A]: 1, [B]: 1 }, '🎉': {} } };
    expect(reactionsOf(message, A)).toEqual([{ emoji: '👍', count: 2, mine: true, users: [A, B] }]);
    expect(reactionPatch(message, '👍', A)).toEqual({ unset: [`react.👍.${A}`] });
    expect(reactionPatch(message, '🎉', A)).toEqual({ set: { [`react.🎉.${A}`]: 1 } });
  });
});

describe('polls', () => {
  const poll = { question: 'Dinner?', options: ['Fish', 'Pasta', 'Rice'], votes: { [A]: [0], [B]: [1], [C]: [1], bogus: [0], [`${A.slice(0, -1)}9`]: [7] } };
  it('hides results until the caller votes or the poll closes', () => {
    expect(pollView(poll, { uid: 'none', now: T0 })).toMatchObject({ people: 3, voted: false, closed: false, showResults: false });
    expect(pollView(poll, { uid: A, now: T0 })).toMatchObject({ counts: [1, 2, 0], mine: [0], voted: true, showResults: true });
    expect(pollView({ ...poll, deadline: T0 }, { uid: 'none', now: T0 })).toMatchObject({ expired: true, closed: true, showResults: true });
    expect(pollView({ ...poll, closed: true }, { uid: 'none', now: T0 }).showResults).toBe(true);
  });
  it('computes the next vote list for single and multiple choice', () => {
    expect(nextVote(poll, A, 2)).toEqual([2]);
    expect(nextVote(poll, A, 0)).toEqual([]);
    const multi = { ...poll, multi: true, votes: { [A]: [2, 0] } };
    expect(nextVote(multi, A, 1)).toEqual([0, 1, 2]);
    expect(nextVote(multi, A, 0)).toEqual([2]);
    expect(votePatch(A, [])).toEqual({ unset: [`votes.${A}`] });
    expect(votePatch(A, [1])).toEqual({ set: { [`votes.${A}`]: [1] } });
  });
  it('rounds single-choice shares to 100 and multiple-choice shares per voter', () => {
    expect(percentages([1, 1, 1], 3)).toEqual([34, 33, 33]);
    expect(percentages([2, 1], 3)).toEqual([67, 33]);
    expect(percentages([0, 0], 0)).toEqual([0, 0]);
    expect(percentages([2, 2], 2)).toEqual([100, 100]);
  });
});

describe('notes', () => {
  it('merges categories from list entries and notes by name, keeping the first color', () => {
    const metas = [{ kind: 'note', name: 'Food', color: 2, order: 'b' }, { kind: 'pack', name: 'Clothes', order: 'a' }, { kind: 'note', name: 'Admin', order: 'a' }];
    const notes = [{ cat: 'food ', color: 5 }, { cat: 'Sights', color: 4 }, { cat: 'admin', color: 3 }, { cat: '' }];
    const cats = noteCategories(notes, metas);
    expect(cats.map((cat) => [cat.name, cat.color])).toEqual([['Admin', 3], ['Food', 2], ['Sights', 4]]);
    expect(noteColorOf({ cat: 'FOOD' }, cats)).toBe(2);
    expect(noteColorOf({ cat: 'Food', color: 6 }, cats)).toBe(6);
    expect(noteColorOf({ cat: 'Food', color: 8 }, cats)).toBe(2);
  });
});

describe('links and files', () => {
  it.each([['example.com/a', 'https://example.com/a'], ['http://x.org', 'http://x.org/'], ['javascript:alert(1)', null], ['ftp://x.org', null],
    ['https://user:pw@x.org', null], ['nodot', null], ['', null]])('normalizes %j', (value, expected) => expect(normalizeURL(value)).toBe(expected));
  it('indexes Files-tab files by linked entity and toggles one link', () => {
    const [n1, n2, m1] = ['0000000000000n01', '0000000000000n02', '0000000000000m01'];
    const files = [{ id: 'f1', kind: 'user', links: [{ t: 'note', id: n1 }, { t: 'msg', id: m1 }] }, { id: 'f2', kind: 'track', links: [{ t: 'note', id: n1 }] },
      { id: 'f3', kind: 'user', trashed: 5, links: [{ t: 'note', id: n1 }] }, { id: 'f4', kind: 'user', linked: { [`note_${n2}`]: true } }];
    expect([...filesByLink(files, 'note')].map(([id, list]) => [id, list.map((file) => file.id)])).toEqual([[n1, ['f1']], [n2, ['f4']]]);
    expect(linkToggle(files[0], 'note', n1, false)).toEqual({ set: { links: [{ t: 'msg', id: m1 }] } });
    expect(linkToggle(files[0], 'note', n2, true)).toEqual({ set: { [`linked.note_${n2}`]: true } });
    expect(linkToggle(files[3], 'note', n2, true)).toBeNull();
    expect(linkToggle(files[3], 'note', n2, false)).toEqual({ unset: [`linked.note_${n2}`] });
  });
});

describe('feed', () => {
  it('words chat and vote changes without exposing message text', () => {
    expect(feedAction({ t: 'msg', op: 'add', fields: [] })).toBe('msgSent');
    expect(feedAction({ t: 'msg', op: 'change', fields: ['react'] })).toBe('msgReacted');
    expect(feedAction({ t: 'msg', op: 'change', fields: ['deleted'] })).toBe('msgDeleted');
    expect(feedAction({ t: 'msg', op: 'change', fields: ['text'] })).toBe('msgEdited');
    expect(feedAction({ t: 'poll', op: 'change', fields: ['votes'] })).toBe('pollVoted');
    expect(feedAction({ t: 'poll', op: 'change', fields: ['closed'] })).toBe('change');
    expect(feedAction({ t: 'place', op: 'remove', fields: [] })).toBe('remove');
  });
  it('marks the newest unread entries by others as new', () => {
    const feed = [{ rev: 1, by: B }, { rev: 2, by: A }, { rev: 3, by: B }, { rev: 4, by: A }, { rev: 5, by: C }];
    expect([...newEntryRevs(feed, { unread: 2, uid: A })]).toEqual([5, 3]);
    expect(newEntryRevs(feed, { unread: 0, uid: A }).size).toBe(0);
  });
});
