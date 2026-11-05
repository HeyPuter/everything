/** Direct Puter notifications from the workspace owner's worker. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { boot, as, USERS, workspaceWith, fakeAuthToken } from './helpers/harness.js';
import { KEYS, threadConvId } from '../src/shared/blocks.js';

const { alice, bob, carol } = USERS;
let rt;
afterEach(() => vi.restoreAllMocks());

async function setup(others = [bob]) {
  rt = await boot({ authToken: fakeAuthToken('app-teamchat-test') });
  const ws = await workspaceWith(alice, others);
  const dm = (await as(alice).post(`/api/ws/${ws.wsId}/dms`, { members: others.map((u) => u.uuid) })).data.conv;
  return { ...ws, dm };
}
const register = (wsId, u = bob, body = {}) => as(u).post(`/api/ws/${wsId}/pn`, body);
const post = (wsId, conv, text, u = alice) => as(u).post(`/api/ws/${wsId}/conv/${conv}/messages`, { text });
const sent = () => rt.notifications.sent;

describe('direct Puter notifications', () => {
  it('uses a share for a member, and no to for the worker owner', async () => {
    const { wsId, dm } = await setup();
    expect((await register(wsId)).data).toEqual({ ok: true });
    await register(wsId, alice);
    const handle = (await rt.kv.get(KEYS.member(wsId, bob.uuid))).ev.h;
    await post(wsId, dm, 'lunch at noon?');
    expect(sent()[0]).toMatchObject({ title: 'alice', text: 'lunch at noon?', channel: 'chat', to: { handle }, group: expect.stringMatching(/^tc\./) });
    expect(sent()[0].target).toBe(`/#/ws/${wsId}@teamchat-api.test/c/${dm}/m/1`);
    expect(sent()[0].data).toEqual({ r: sent()[0].target.slice(1), g: `${wsId}@teamchat-api.test:message-${dm}` });
    await post(wsId, dm, 'yes', bob);
    expect(sent()[1].to).toBeUndefined();
    expect(sent()[1].text).toBe('yes');
    expect((await as(bob).get(`/api/ws/${wsId}/pn/0`)).status).toBe(404);
    expect(rt.kv._calls.log.some(({ key }) => /:ev:p/.test(key))).toBe(false);
  });

  it('rings a call in a direct message at high priority, briefly kept, and flags it for the push handler', async () => {
    const { wsId, dm } = await setup();
    await register(wsId);
    expect((await as(alice).post(`/api/ws/${wsId}/conv/${dm}/huddle`, { invite: 'NJ-AAA111' })).ok).toBe(true);
    await vi.waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toMatchObject({ text: 'started a huddle', priority: 'high', ttl: 60, data: { c: 1 } });
    await post(wsId, dm, 'hello');
    expect(sent()[1].priority).toBeUndefined();
    expect(sent()[1].data.c).toBeUndefined();
  });

  it('marks previews off as sensitive, keeping the app notification content', async () => {
    const { wsId, dm } = await setup();
    await register(wsId, bob, { preview: false });
    await post(wsId, dm, 'the secret plan');
    expect(sent()[0]).toMatchObject({ sensitive: true, text: 'the secret plan' });
  });

  it('upgrades an old share with notify once, preserving the handle', async () => {
    const { wsId } = await setup();
    const key = KEYS.member(wsId, bob.uuid);
    const handle = (await rt.kv.get(key)).ev.h;
    await rt.kv.update(key, { ev: { h: handle } });
    const share = vi.spyOn(rt.kv, 'share');
    await as(bob).get(`/api/ws/${wsId}`);
    await as(bob).get(`/api/ws/${wsId}`);
    expect(share).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ prefix: `tc:ws:${wsId}:ev:`, recipient: { uid: bob.uuid }, access: 'watch', notify: true }));
    expect((await rt.kv.get(key)).ev).toEqual({ h: handle, notify: true });
  });

  it('skips unregistered and opted-out members, and lets Puter check page presence', async () => {
    const { wsId, dm } = await setup();
    await post(wsId, dm, 'no opt-in');
    await register(wsId);
    await as(bob).get(`/api/ws/${wsId}/sync?since=0&hb=1`);
    await post(wsId, dm, 'present');
    expect(sent()).toHaveLength(1);
    expect(sent()[0].text).toBe('present');
    await rt.kv.remove(KEYS.activity(wsId), `p.${bob.uuid}`);
    await as(bob).del(`/api/ws/${wsId}/pn`);
    await post(wsId, dm, 'off');
    expect(sent()).toHaveLength(1);
  });

  it('honors mute, levels, pause, quiet hours, and channel membership', async () => {
    const { wsId, dm, general } = await setup([bob, carol]);
    await register(wsId);
    await as(bob).put(`/api/ws/${wsId}/conv/${dm}/notify`, { mute: true });
    await post(wsId, dm, '@bob muted');
    await as(bob).put(`/api/ws/${wsId}/conv/${dm}/notify`, { mute: false, level: 'nothing' });
    await post(wsId, dm, '@bob nothing');
    await as(bob).put(`/api/ws/${wsId}/conv/${dm}/notify`, { level: 'mentions' });
    await post(wsId, dm, '@carol only');
    await post(wsId, dm, '@bob yes');
    expect(sent()).toHaveLength(1);
    await register(wsId, bob, { prefs: { pauseUntil: Date.now() + 60_000 } });
    await post(wsId, dm, '@bob paused');
    await register(wsId, bob, { prefs: { tzOffset: 0, dnd: { enabled: true, from: new Date().getUTCHours() * 60, to: (new Date().getUTCHours() * 60 + 60) % 1440 } } });
    await post(wsId, dm, '@bob quiet');
    await register(wsId);
    const ch = (await as(alice).post(`/api/ws/${wsId}/channels`, { name: 'private', private: true })).data.channel;
    await post(wsId, ch.id, '@bob cannot read');
    await post(wsId, general.id, 'plain channel post');
    expect(sent()).toHaveLength(1);
    await post(wsId, general.id, '@bob mentioned');
    expect(sent()).toHaveLength(2);
  });

  it('keeps the thread route and group shape', async () => {
    const { wsId, dm } = await setup();
    await register(wsId);
    const root = await post(wsId, dm, 'root');
    const thread = threadConvId(dm, root.data.message.seq);
    await post(wsId, thread, 'reply');
    expect(sent().at(-1).target).toBe(`/#/ws/${wsId}@teamchat-api.test/c/${dm}/t/1/m/1`);
    expect(sent().at(-1).data.g).toBe(`${wsId}@teamchat-api.test:reply-${thread}`);
  });

  it.each(['too_many_requests', 'recipient_not_accepting_shares', 'service_unavailable'])('drops %s for one recipient and continues', async (code) => {
    const { wsId, dm } = await setup([bob, carol]);
    await register(wsId); await register(wsId, carol);
    const notify = vi.spyOn(rt.notifications, 'notify').mockRejectedValueOnce({ code });
    expect((await post(wsId, dm, 'hello')).ok).toBe(true);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(sent()).toHaveLength(1);
  });

  it('re-enables notify on a disabled share and drops this notification', async () => {
    const { wsId, dm } = await setup(); await register(wsId);
    const share = vi.spyOn(rt.kv, 'share');
    const notify = vi.spyOn(rt.notifications, 'notify').mockRejectedValueOnce({ code: 'kv_share_notify_not_enabled' });
    expect((await post(wsId, dm, 'first')).ok).toBe(true);
    expect(share).toHaveBeenCalledTimes(1);
    expect((await rt.kv.get(KEYS.member(wsId, bob.uuid))).ev.notify).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    await post(wsId, dm, 'second');
    expect(share).toHaveBeenCalledTimes(1);
    expect(sent()).toHaveLength(1);
  });

  it('forgets a dead handle so the next bootstrap can mint a new one', async () => {
    const { wsId, dm } = await setup(); await register(wsId);
    vi.spyOn(rt.notifications, 'notify').mockRejectedValueOnce({ code: 'subject_does_not_exist' });
    await post(wsId, dm, 'dead handle');
    expect((await rt.kv.get(KEYS.member(wsId, bob.uuid))).ev).toBeUndefined();
    const share = vi.spyOn(rt.kv, 'share').mockResolvedValue({ handle: 'kvh-new' });
    await as(bob).get(`/api/ws/${wsId}`);
    expect(share).toHaveBeenCalledTimes(1);
    expect((await rt.kv.get(KEYS.member(wsId, bob.uuid))).ev.h).toBe('kvh-new');
  });

  it('sends to each recipient at once, and one refused send fails neither the post nor the others', async () => {
    const { wsId, dm } = await setup([bob, carol]);
    await register(wsId); await register(wsId, carol);
    const notify = vi.spyOn(rt.notifications, 'notify').mockRejectedValueOnce({ code: 'forbidden' });
    expect((await post(wsId, dm, 'hello')).ok).toBe(true);
    expect(notify).toHaveBeenCalledTimes(2);
    await post(wsId, dm, 'next request');
    expect(notify).toHaveBeenCalledTimes(4);
  });

  it('caps a broadcast fan-out at fifty recipients', async () => {
    const people = Array.from({ length: 53 }, (_, i) => ({ uuid: `u-member-${i}`, username: `member${i}` }));
    const { wsId, general } = await setup(people.slice(0, 1));
    const code = (await as(alice).get(`/api/ws/${wsId}`)).data.workspace.invite;
    for (const u of people.slice(1)) await as(u).post('/api/join', { code });
    for (const u of people) await register(wsId, u);
    const posted = await post(wsId, general.id, '@channel hello everyone');
    expect(posted.ok).toBe(true);
    expect(sent()).toHaveLength(50);
  });

  it('leaves sends behind the response with waitUntil', async () => {
    const { wsId, dm } = await setup(); await register(wsId);
    let answered = false;
    rt.setStores({ onAnswered: () => { answered = true; } });
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    vi.spyOn(rt.notifications, 'notify').mockImplementation(async () => { await pending; });
    const posting = post(wsId, dm, 'background');
    await vi.waitFor(() => expect(answered).toBe(true));
    release();
    expect((await posting).ok).toBe(true);
    rt.setStores({ onAnswered: null });
  });
});
