import { describe, it, expect, beforeEach, vi } from 'vitest';
import source from '../src/workers/notify-handler.js?raw';
import { clickedMessage } from '../src/lib/notify.js';

/**
 * The published new-mail handler, rebuilt from its source the way the events
 * worker does, so it runs with nothing around it. `user` is stubbed at the
 * three calls it makes.
 */

const handler = new Function(`return (\n${source}\n)`)();

const ID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const b64url = (text) => Buffer.from(text, 'utf8').toString('base64url');
const pathFor = (subject, id = ID) => `/tester/.mail/objects/2026-10-30/${id}--${b64url(subject)}`;

const HEAD = [
  'Received: from mx.example.com',
  'From: =?utf-8?Q?Ana_Petrovi=C4=87?= <Ana@Example.com>',
  'To: tester@puter.email',
  'Subject: Quarterly numbers',
  '',
  'The body, which is never needed.',
].join('\r\n');

let kv;
let notify;
let read;
let user;

const run = (event, ctx = { previews: true, self: ['tester@puter.email'] }) =>
  handler({ event, ctx: Object.freeze(ctx), user });

const add = (subject = 'Quarterly numbers', id = ID) => ({
  id: `evt-${id}`, op: 'add', uid: `uid-${id}`, path: pathFor(subject, id),
});

beforeEach(() => {
  kv = new Map();
  notify = vi.fn(async () => 'notif-uid');
  read = vi.fn(async () => new Blob([HEAD]));
  user = {
    kv: { get: async (key) => kv.get(key) ?? null, set: async (key, value) => { kv.set(key, value); return true; } },
    fs: { read },
    notifications: { notify },
  };
});

describe('the new-mail handler', () => {
  it('names the sender and the subject, from the head of the message alone', async () => {
    await run(add());
    expect(read).toHaveBeenCalledWith(`uid-${ID}`, { offset: 0, byte_count: 16384 });
    expect(notify).toHaveBeenCalledWith({
      title: 'Ana Petrović',
      text: 'Quarterly numbers',
      target: `/?message=${ID}`,
      data: { id: ID },
      group: 'inbox',
      channel: 'mail',
    });
    expect(clickedMessage(notify.mock.calls[0][0])).toBe(ID);
  });

  it('reads a quoted name, a bare address and an encoded subject', async () => {
    read.mockResolvedValueOnce(new Blob(['From: "Doe, Jane" <jane@example.com>\r\n\r\n']));
    await run(add('Café ☕', '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51'));
    read.mockResolvedValueOnce(new Blob(['From:\r\n leo@example.com\r\n\r\n']));
    kv.clear();
    await run(add('=?utf-8?B?SGVsbG8=?=', '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a52'));
    expect(notify.mock.calls.map(([n]) => [n.title, n.text])).toEqual([
      ['Doe, Jane', 'Café ☕'],
      ['leo@example.com', 'Hello'],
    ]);
  });

  it('falls back to the subject when the head cannot be read', async () => {
    read.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'subject_does_not_exist' }));
    await run(add());
    expect(notify.mock.calls[0][0]).toMatchObject({ title: 'New message', text: 'Quarterly numbers' });
  });

  it('runs for nothing but a delivered message', async () => {
    await run({ op: 'gap', reason: 'reconnect' });
    await run({ ...add(), op: 'write' });
    await run({ op: 'add', uid: 'u', path: '/tester/.mail/objects/2026-10-31' });
    expect(notify).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps sender and subject out of pushes when previews are off', async () => {
    await run(add(), { previews: false, self: [] });
    expect(notify.mock.calls[0][0]).toMatchObject({ sensitive: true, data: { id: ID } });
  });

  it('does not announce mail the user sent themselves', async () => {
    read.mockResolvedValueOnce(new Blob(['From: Tester <TESTER@puter.email>\r\n\r\n']));
    await run(add());
    expect(notify).not.toHaveBeenCalled();
  });

  it('announces a redelivered message once', async () => {
    await run(add());
    await run(add());
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('holds back a burst and counts it into the next notification', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await run(add('First', '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01'));
    now.mockReturnValue(1_005_000);
    await run(add('Second', '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a02'));
    await run(add('Third', '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a03'));
    expect(notify).toHaveBeenCalledTimes(1);
    // Held messages are not read either.
    expect(read).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_030_000);
    await run(add('Fourth', '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a04'));
    now.mockRestore();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0]).toMatchObject({ title: '3 new messages', text: 'Ana Petrović: Fourth' });
  });

  it('swallows a refusal and the cap, and asks for a retry only when it may pass', async () => {
    notify.mockRejectedValueOnce(Object.assign(new Error('slow down'), { code: 'too_many_requests' }));
    await expect(run(add())).resolves.toBeUndefined();

    kv.clear();
    notify.mockRejectedValueOnce(Object.assign(new Error('bad'), { code: 'bad_request' }));
    await expect(run(add())).resolves.toBeUndefined();

    kv.clear();
    notify.mockRejectedValueOnce(Object.assign(new Error('down'), { status: 503 }));
    await expect(run(add())).rejects.toMatchObject({ retry: true });
    // Not counted as announced, so the retry announces it.
    await run(add());
    expect(notify).toHaveBeenCalledTimes(4);
  });
});
