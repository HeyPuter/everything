// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isEmoji } from '../../worker/ops/trip/msg.js';
import { USERS, createHarness, expectError, id } from './harness.js';

const put = (t, fields, eid = id(t)) => ({ opId: id('o'), t, id: eid, put: fields });
const set = (t, eid, fields) => ({ opId: id('o'), t, id: eid, set: fields });
const unset = (t, eid, paths) => ({ opId: id('o'), t, id: eid, unset: paths });
const { alice: A, bob: B, carol: C } = Object.fromEntries(Object.entries(USERS).map(([name, user]) => [name, user.uuid]));

async function setup(options = {}) {
  const h = await createHarness(options);
  const space = await h.team({ bob: 'editor', carol: 'viewer' });
  const clients = Object.fromEntries(await Promise.all(['alice', 'bob', 'carol'].map(async (name) => [name, await h.client(name)])));
  const as = (name) => (ops) => clients[name].in(space).call('commit', { ops });
  return { h, space, alice: as('alice'), bob: as('bob'), carol: as('carol') };
}

describe('collab type hooks', () => {
  it('accepts only the caller as author and never lets it change', async () => {
    const { alice, bob } = await setup();
    await expectError(bob([put('msg', { text: 'Hi', author: A })]), 403, 'invalid_author');
    const note = id('n');
    expect((await bob([put('note', { title: 'Ideas', author: B }, note)])).ents[0].author).toBe(B);
    await expectError(alice([set('note', note, { author: A })]), 403, 'invalid_author');
    await expectError(bob([unset('note', note, ['author'])]), 403, 'invalid_author');
    expect((await alice([set('note', note, { title: 'Owner edit' })])).ents[0]).toMatchObject({ author: B, by: A });
    const link = id('l');
    await bob([put('link', { title: 'Guide', url: 'https://example.com/', author: B }, link)]);
    await expectError(bob([set('link', link, { author: A })]), 403, 'invalid_author');
    const legacy = id('l');
    await bob([put('link', { title: 'Old', url: 'https://example.com/' }, legacy)]);
    await expectError(bob([set('link', legacy, { author: B })]), 403, 'invalid_author');
  });

  it('keeps the author through reactions and soft deletes', async () => {
    const { alice, bob } = await setup();
    const msg = id('m');
    await bob([put('msg', { text: 'Hello', author: B }, msg)]);
    const reacted = (await alice([set('msg', msg, { [`react.👍.${A}`]: 1 })])).ents[0];
    expect(reacted).toMatchObject({ author: B, by: A });
    expect((await alice([{ opId: id('o'), t: 'msg', id: msg, del: true }])).ents[0]).toMatchObject({ author: B, deleted: true, text: '' });
  });

  it('allows only single emoji as reaction keys', async () => {
    const { alice, bob } = await setup();
    const msg = id('m');
    await expectError(bob([put('msg', { text: 'Hi', react: { ok: { [B]: 1 } } })]), 400, 'invalid_reaction');
    await bob([put('msg', { text: 'Hi', react: { '🎉': { [B]: 1 } } }, msg)]);
    await expectError(alice([set('msg', msg, { [`react.lol.${A}`]: 1 })]), 400, 'invalid_reaction');
    await expectError(alice([set('msg', msg, { [`react.👍👍.${A}`]: 1 })]), 400, 'invalid_reaction');
    const result = await alice([set('msg', msg, { [`react.👍🏽.${A}`]: 1 })]);
    expect(result.ents[0].react).toEqual({ '🎉': { [B]: 1 }, '👍🏽': { [A]: 1 } });
  });

  it('refuses a reply to itself', async () => {
    const { bob } = await setup();
    const msg = id('m');
    await expectError(bob([put('msg', { text: 'Loop', reply: msg }, msg)]), 400, 'invalid_reply');
  });

  it('keeps every member’s reactions and votes on their own paths', async () => {
    const { h, alice, bob } = await setup();
    const msg = id('m');
    const poll = id('q');
    await bob([put('msg', { text: 'Dinner?', author: B }, msg), put('poll', { question: 'Where?', options: ['Fish', 'Pasta'], multi: true, author: B }, poll)]);
    await Promise.all([
      alice([set('msg', msg, { [`react.👍.${A}`]: 1 }), set('poll', poll, { [`votes.${A}`]: [0] })]),
      bob([set('msg', msg, { [`react.👍.${B}`]: 1 }), set('poll', poll, { [`votes.${B}`]: [0, 1] })]),
    ]);
    const kv = h.kv();
    const key = (t, eid) => Object.keys(kv).find((k) => k.endsWith(`:e:${t}:${eid}`) || k.endsWith(`:m:${eid}`));
    expect(kv[key('msg', msg)].react['👍']).toEqual({ [A]: 1, [B]: 1 });
    expect(kv[key('poll', poll)].votes).toEqual({ [A]: [0], [B]: [0, 1] });
  });

  it('validates poll options and deadlines', async () => {
    const { h, bob } = await setup();
    await expectError(bob([put('poll', { question: 'Q', options: ['Fish', ' fish '] })]), 400, 'duplicate_options');
    await expectError(bob([put('poll', { question: 'Q', options: ['A', 'B'], deadline: h.now() - 1 })]), 400, 'invalid_deadline');
    const poll = id('q');
    await bob([put('poll', { question: 'Q', options: ['A', 'B'], deadline: h.now() + 60_000 }, poll)]);
    await expectError(bob([set('poll', poll, { options: ['A', 'a'] })]), 400, 'duplicate_options');
    expect((await bob([set('poll', poll, { options: ['A', 'B', 'C'] })])).ents[0].options).toHaveLength(3);
    // Moving the deadline into the past closes the poll early.
    expect((await bob([set('poll', poll, { deadline: h.now() - 1 })])).ents[0].deadline).toBeLessThan(h.now());
  });

  it('refuses viewer posts and votes unless the owner allows them', async () => {
    const { h, alice, bob, carol } = await setup();
    const poll = id('q');
    await bob([put('poll', { question: 'Q', options: ['A', 'B'] }, poll)]);
    await expectError(carol([set('poll', poll, { [`votes.${C}`]: [1] })]), 403, 'forbidden');
    await expectError(carol([put('msg', { text: 'Hi', author: C })]), 403, 'forbidden');
    await alice([set('meta', 'meta', { perms: { 'collab.post': 'viewer' } })]);
    h.advance(6000);
    expect((await carol([set('poll', poll, { [`votes.${C}`]: [1] })])).ents[0].votes).toEqual({ [C]: [1] });
    expect((await carol([put('msg', { text: 'Hi', author: C })])).ents[0].author).toBe(C);
  });

  it('replays a retried message commit without writing twice', async () => {
    const { h, bob } = await setup();
    const ops = [put('msg', { text: 'Once', author: B })];
    const first = await bob(ops);
    h.world.resetCounters();
    const again = await bob(ops);
    expect(again.rev).toBe(first.rev);
    expect(again.ents[0]).toMatchObject({ id: ops[0].id, text: 'Once' });
    expect(h.world.counters().byUser[A]?.calls?.['kv.incr'] ?? 0).toBe(0);
  });

  it('costs one batched read and one rev claim per chat message', async () => {
    const { h, bob, space } = await setup({ onlyIfAbsent: true });
    await bob([put('msg', { text: 'warm', author: B })]);
    await (await h.client('bob')).in(space).call('sync', { since: 0 });
    h.world.resetCounters();
    await bob([put('msg', { text: 'Hello', author: B })]);
    const calls = h.world.counters().byUser[A].calls;
    expect(calls['kv.get']).toBe(1);
    expect(calls['kv.incr']).toBe(1);
    const kv = Object.entries(calls).filter(([method]) => method.startsWith('kv.')).reduce((n, [, count]) => n + count, 0);
    expect(kv).toBeLessThanOrEqual(6);
  });
});

describe('isEmoji', () => {
  it.each(['👍', '❤️', '❤', '👍🏽', '🇵🇹', '#️⃣', '👨‍👩‍👧', '🧑🏽‍🚀'])('accepts %s', (value) => expect(isEmoji(value)).toBe(true));
  it.each(['', 'a', 'ok', '👍👍', ' 👍', '👍 ', '1'])('refuses %j', (value) => expect(isEmoji(value)).toBe(false));
});
