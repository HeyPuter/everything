import { describe, it, expect } from 'vitest';
import {
  workerURL, trustedServer, reviewLink, parseReviewHash, tokenClaims, cleanText, cleanTitle, textProblem, validateComment,
  inviteToken, randomId, TOKEN, ID, hash, keyPair, sign, verify, canComment, canResolve, canManage, inviteDays, LIMITS,
} from '../src/review/protocol.js';
import {
  frameAt, frameStart, snapToFrame, stepFrames, seekSeconds, reviewTimecode, pinLabel, toEditorTime, fromEditorTime,
  stripMarkers, lastFrame, reviewFps, fromSeconds,
} from '../src/review/time.js';
import { applyChanges, threadsFor, threadCounts, pendingComment, canEditComment, canDeleteComment, relativeTime, threadOf } from '../src/review/comments.js';

describe('review protocol', () => {
  it('trusts only https puter.work worker origins', () => {
    expect(workerURL('https://video-review-abc.puter.work')).toBe('https://video-review-abc.puter.work');
    expect(workerURL('video-review-abc.puter.work')).toBe('https://video-review-abc.puter.work');
    for (const bad of ['http://a.puter.work', 'https://a.puter.work.evil.com', 'https://evil.com', 'https://a.b.puter.work', 'https://a.puter.work:444', 'https://a.puter.work/x', 'https://u:p@a.puter.work', 'javascript:alert(1)', '', null]) {
      expect(trustedServer(bad), String(bad)).toBe(false);
    }
  });

  it('builds and parses review links', () => {
    const token = inviteToken();
    expect(TOKEN.test(token)).toBe(true);
    const link = reviewLink('https://video-studio.puter.app/?x=1#project=p1', 'https://w-1.puter.work', 'r_abcdefgh', token);
    expect(link).toBe(`https://video-studio.puter.app/?x=1#review=r_abcdefgh&server=w-1.puter.work&invite=${token}`);
    expect(parseReviewHash(new URL(link).hash)).toEqual({ review: 'r_abcdefgh', server: 'https://w-1.puter.work', token });
    expect(parseReviewHash('#review=r_abcdefgh&server=w-1.puter.work')).toEqual({ review: 'r_abcdefgh', server: 'https://w-1.puter.work', token: null });
    expect(parseReviewHash('#project=p1')).toBe(null);
    expect(parseReviewHash('')).toBe(null);
    expect(() => parseReviewHash('#review=r_abcdefgh&server=evil.com')).toThrow(/unknown server/);
    expect(() => parseReviewHash('#review=<x>&server=w.puter.work')).toThrow(/not complete/);
    expect(() => parseReviewHash('#review=r_abcdefgh&server=w.puter.work&invite=short')).toThrow(/invite link/);
  });

  it('reads compressed and plain token claims', () => {
    const enc = (o) => `h.${btoa(JSON.stringify(o)).replace(/=+$/, '')}.s`;
    const packed = btoa(String.fromCharCode(...'11111111111141118111111111111111'.match(/../g).map((x) => parseInt(x, 16))));
    expect(tokenClaims(enc({ t: 't', uu: packed, exp: 5 }))).toMatchObject({ type: 'access-token', user_uid: '11111111-1111-4111-8111-111111111111', exp: 5 });
    expect(tokenClaims(enc({ type: 'session', user_uid: '11111111-1111-4111-8111-111111111111' }))).toMatchObject({ type: 'session' });
    expect(tokenClaims(enc({ t: 't', type: 'session' }))).toEqual({});
    expect(tokenClaims('nonsense')).toEqual({});
    expect(tokenClaims(null)).toEqual({});
  });

  it('ids are url safe', () => {
    const id = randomId('c');
    expect(id).toMatch(/^c_[A-Za-z0-9_-]+$/);
    expect(ID.test(id)).toBe(true);
  });

  it('signs and verifies', async () => {
    const k = await keyPair();
    const s = await sign(k.privateKey, ['a', 1]);
    expect(await verify(k.publicKey, ['a', 1], s)).toBe(true);
    expect(await verify(k.publicKey, ['a', 2], s)).toBe(false);
    expect(await verify(k.publicKey, ['a', 1], 'garbage')).toBe(false);
    expect(await hash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('cleans comment text and titles', () => {
    expect(cleanText('  hi\r\nthere\u0000‮ ')).toBe('hi\nthere');
    expect(cleanTitle('  My\ncut  ')).toBe('My cut');
    expect(cleanTitle('')).toBe('Untitled');
    expect(cleanTitle('x'.repeat(500)).length).toBe(LIMITS.title);
    expect(textProblem('')).toMatch(/Write/);
    expect(textProblem('x'.repeat(LIMITS.text + 1))).toMatch(/2000/);
    expect(textProblem('fine')).toBe(null);
  });

  it('validates comments against a version', () => {
    const v = { n: 2, duration: 5_000_000 };
    expect(validateComment({ id: 'c_abcdef', text: ' a ', t: 100 }, v)).toEqual({ ok: true, value: { id: 'c_abcdef', version: 2, parent: null, text: 'a', t: 100, end: null } });
    expect(validateComment({ id: 'c_abcdef', text: 'a', t: 100, parent: 'c_parent1' }, v).value).toMatchObject({ parent: 'c_parent1', t: null, end: null });
    expect(validateComment({ id: 'c_abcdef', text: 'a', t: 100, end: 100 }, v).ok).toBe(false);
    expect(validateComment({ id: 'c_abcdef', text: 'a', t: 0, end: 5_000_001 }, v).ok).toBe(false);
    expect(validateComment({ id: 'c_abcdef', text: 'a', t: 0 }, null).error).toMatch(/version/);
    expect(validateComment({ id: 'c_abcdef', text: 'a', t: 0, end: 4_000_000 }, { n: 1, duration: 3_600_000_000 }).ok).toBe(true);
    expect(validateComment({ id: 'c_abcdef', text: 'a', t: 0, end: LIMITS.rangeUs + 1 }, { n: 1, duration: 3_600_000_000 }).error).toMatch(/10 minutes/);
    expect(validateComment('x', v).ok).toBe(false);
  });

  it('role helpers', () => {
    expect([canComment('owner'), canComment('commenter'), canComment('viewer')]).toEqual([true, true, false]);
    expect([canResolve('viewer'), canManage('commenter'), canManage('owner')]).toEqual([false, false, true]);
    expect([inviteDays(1), inviteDays(30), inviteDays(3), inviteDays('x')]).toEqual([1, 30, 7, 7]);
  });
});

describe('review time', () => {
  it('maps times to frames and back', () => {
    expect(reviewFps(0)).toBe(30);
    expect(frameAt(0, 30)).toBe(0);
    expect(frameAt(33_332, 30)).toBe(0);
    // Frame 1 starts at 33333.3 us, stored rounded as 33333.
    expect(frameAt(33_333, 30)).toBe(1);
    expect(frameStart(30, 30)).toBe(1_000_000);
    expect(snapToFrame(1_020_000, 25)).toBe(1_000_000);
    expect(lastFrame(1_000_000, 30)).toBe(29);
    expect(stepFrames(0, -1, 30, 1_000_000)).toBe(0);
    expect(stepFrames(0, 1, 30, 1_000_000)).toBe(33_333);
    expect(stepFrames(990_000, 5, 30, 1_000_000)).toBe(frameStart(29, 30));
    expect(seekSeconds(1_000_000, 30)).toBeCloseTo(30.5 / 30, 9);
    expect(fromSeconds(1.5)).toBe(1_500_000);
    // 29.97 fps
    const f = 30000 / 1001;
    for (let i = 0; i < 2000; i += 37) expect(frameAt(frameStart(i, f), f)).toBe(i);
  });

  it('formats frame-accurate timecodes at the review fps', () => {
    expect(reviewTimecode(0, 30)).toBe('00:00:00:00');
    expect(reviewTimecode(1_040_000, 25)).toBe('00:00:01:01');
    expect(reviewTimecode(61_500_000, 24)).toBe('00:01:01:12');
    expect(pinLabel({ t: 1_000_000, end: 2_000_000 }, 30)).toBe('00:00:01:00 to 00:00:02:00');
    expect(pinLabel({ t: null }, 30)).toBe('');
  });

  it('maps review times to the editor through the range a version was made from', () => {
    const whole = { duration: 10_000_000, range: null };
    const ranged = { duration: 4_000_000, range: { in: 6_000_000, out: 10_000_000 } };
    expect(toEditorTime(2_000_000, whole)).toBe(2_000_000);
    expect(toEditorTime(20_000_000, whole)).toBe(10_000_000);
    expect(toEditorTime(1_500_000, ranged)).toBe(7_500_000);
    expect(toEditorTime(9_000_000, ranged)).toBe(10_000_000);
    expect(fromEditorTime(7_500_000, ranged)).toBe(1_500_000);
    expect(fromEditorTime(1_000_000, ranged)).toBe(null);
    expect(fromEditorTime(3_000_000, whole)).toBe(3_000_000);
  });

  it('lays out strip markers, merging close ones', () => {
    const cs = [{ id: 'a', t: 0 }, { id: 'b', t: 5_000_000, end: 6_000_000, resolved: true }, { id: 'c', t: 5_050_000 }, { id: 'd', t: null }];
    const m = stripMarkers(cs, 10_000_000);
    expect(m.map((x) => [x.ids, x.at, x.count, x.resolved])).toEqual([[['a'], 0, 1, false], [['b', 'c'], 0.5, 2, false]]);
    expect(m[1].width).toBeCloseTo(0.1, 6);
    expect(stripMarkers(cs, 0)).toEqual([]);
    // Points merged together stay a point, not a range bar between them.
    const points = stripMarkers([{ id: 'p', t: 2_000_000 }, { id: 'q', t: 2_100_000 }], 10_000_000);
    expect(points.map((x) => [x.ids, x.width])).toEqual([[['p', 'q'], 0]]);
    // A point after a range ends no earlier than the range does.
    const after = stripMarkers([{ id: 'r', t: 2_000_000, end: 4_000_000 }, { id: 's', t: 2_050_000 }], 10_000_000);
    expect(after[0].width).toBeCloseTo(0.2, 6);
  });
});

describe('review comments state', () => {
  const me = { uuid: 'u1', username: 'bob' };
  const c = (id, f = {}) => ({ id, version: 1, parent: null, text: id, t: 0, end: null, author: me, created: 1, seq: 1, resolved: false, deleted: false, ...f });

  it('keeps the newest snapshot of each comment', () => {
    const map = new Map();
    expect(applyChanges(map, [c('a', { seq: 2, text: 'new' })])).toBe(true);
    expect(applyChanges(map, [c('a', { seq: 1, text: 'old' })])).toBe(false);
    expect(map.get('a').text).toBe('new');
    // A pending local copy is always replaced by the saved one.
    map.set('p', pendingComment({ id: 'p', version: 1, text: 'x', t: 0 }, me, 5));
    expect(applyChanges(map, [c('p', { seq: 0 })])).toBe(true);
    expect(map.get('p').pending).toBeUndefined();
  });

  it('groups threads by version and time with replies oldest first', () => {
    const map = new Map();
    applyChanges(map, [
      c('late', { t: 9 }), c('early', { t: 1 }), c('r2', { parent: 'early', created: 3, t: null }), c('r1', { parent: 'early', created: 2, t: null }),
      c('gone', { t: 2, deleted: true }), c('kept', { t: 3, deleted: true }), c('kr', { parent: 'kept', t: null }),
      c('done', { t: 4, resolved: true }), c('v2', { version: 2 }), c('deadreply', { parent: 'late', deleted: true }),
    ]);
    const t = threadsFor(map, 1);
    expect(t.map((x) => x.id)).toEqual(['early', 'kept', 'done', 'late']);
    expect(t[0].replies.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(t[3].replies).toEqual([]);
    expect(threadsFor(map, 1, { showResolved: false }).map((x) => x.id)).toEqual(['early', 'kept', 'late']);
    expect(threadCounts(map, 1)).toEqual({ open: 2, resolved: 1, total: 3 });
    expect(threadOf(map, 'r1').id).toBe('early');
  });

  it('permissions for editing and deleting', () => {
    const mine = c('a');
    const theirs = c('b', { author: { uuid: 'u2', username: 'carol' } });
    expect(canEditComment(mine, me)).toBe(true);
    expect(canEditComment(theirs, me)).toBe(false);
    expect(canDeleteComment(theirs, me, 'commenter')).toBe(false);
    expect(canDeleteComment(theirs, me, 'owner')).toBe(true);
    expect(canEditComment({ ...mine, deleted: true }, me)).toBe(false);
  });

  it('relative times', () => {
    const now = Date.UTC(2026, 5, 1, 12);
    expect(relativeTime(now - 10_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(relativeTime(now - 3 * 86_400_000, now)).toMatch(/May/);
  });
});
