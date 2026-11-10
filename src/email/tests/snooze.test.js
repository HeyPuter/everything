import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSnooze, SNOOZE_HANDLER, snoozePresets, localDateTime } from '../src/lib/snooze.js';
import { createMailbox, dayFolder } from '../src/lib/mailbox.js';
import { memoryStorage, flagId } from '../src/lib/readstate.js';
import { createSampleMailbox } from '../src/lib/sample.js';
import handlerSource from '../src/workers/snooze-handler.js?raw';

const handler = new Function(`return (\n${handlerSource}\n)`)();
const NOW = +new Date('2026-11-04T20:00:00Z');
let mailbox;
let message;
let data;
let kv;
let events;
let perms;
let storage;
let snooze;
const make = () => createSnooze({ ...mailbox, scope: 'tester', storage, kv, events, perms });
const stored = () => data.get(`snooze:${flagId(message.name)}`);
const snoozedMessage = (result) => ({ ...message, path: result.path, box: 'snoozed' });

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  mailbox = createSampleMailbox(new Date(NOW));
  const box = createMailbox(mailbox);
  await box.open();
  message = box.messages.at(-1);
  data = new Map();
  kv = {
    get: vi.fn(async (key) => data.get(key) ?? null),
    set: vi.fn(async (key, value) => { data.set(key, structuredClone(value)); }),
    del: vi.fn(async (key) => { data.delete(key); }),
    list: vi.fn(async ({ pattern }) => ({ items: [...data].filter(([key]) => key.startsWith(pattern))
      .map(([key, value]) => ({ key, value })) })),
  };
  events = {
    onSchedule: vi.fn(async () => ({ scheduleId: 'schedule-1' })),
    removeSchedule: vi.fn(async () => {}),
  };
  perms = { check: vi.fn(async () => true), request: vi.fn(async () => true) };
  storage = memoryStorage();
  snooze = make();
});
afterEach(() => vi.restoreAllMocks());

describe('local snooze times', () => {
  it('offers future local mornings and hides passed presets', () => {
    const now = new Date(2026, 10, 6, 12, 25);
    const presets = snoozePresets(now);
    expect(presets.map((p) => p.label)).toEqual(['Later today', 'Tomorrow 08:00', 'This weekend', 'Next week']);
    for (const preset of presets.slice(1)) expect(new Date(preset.until).getHours()).toBe(8);
    expect(new Date(presets[2].until).getDay()).toBe(6);
    expect(new Date(presets[3].until).getDay()).toBe(1);
    expect(snoozePresets(new Date(2026, 10, 7, 19)).map((p) => p.label))
      .toEqual(['Tomorrow 08:00', 'Next week']);
    expect(snoozePresets(new Date(2026, 10, 8, 12)).some((p) => p.label === 'This weekend')).toBe(false);
    expect(localDateTime(new Date(2026, 10, 4, 8, 5))).toBe('2026-11-04T08:05');
  });

  it('keeps local 08:00 over both DST changes', () => {
    const url = pathToFileURL(resolve('src/lib/snooze.js')).href;
    const script = `import { snoozePresets } from ${JSON.stringify(url)};
      console.log(JSON.stringify([[2026,2,7],[2026,9,31]].map(parts => {
        const now = new Date(...parts,8);
        const at = new Date(snoozePresets(now).find(p => p.label === 'Tomorrow 08:00').until);
        return [at.getHours(), (at-now)/3600000];
      })));`;
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      // US rules: clocks change on 8 March and 1 November 2026. Vancouver's
      // rules differ between tzdata releases, so it can't be the fixture.
      env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8',
    });
    expect(JSON.parse(result)).toEqual([[8, 23], [8, 25]]);
  });
});

describe('snooze storage and schedules', () => {
  it('moves the original bytes and records an account schedule', async () => {
    const original = await (await mailbox.fs.read(message.path)).text();
    const until = NOW + 3600000;
    const result = await snooze.snooze(message, until, { background: true });
    expect(result.background).toBe(true);
    expect(await (await mailbox.fs.read(result.path)).text()).toBe(original);
    await expect(mailbox.fs.stat(message.path)).rejects.toThrow();
    expect(stored()).toMatchObject({ until, scheduleId: 'schedule-1',
      from: { box: 'inbox', path: message.path, day: message.day } });
    expect(events.onSchedule).toHaveBeenCalledWith({ at: until, handlerName: SNOOZE_HANDLER,
      context: { id: flagId(message.name), token: stored().token, mailPath: mailbox.mailPath } });
  });

  it('asks for consent only when missing, and never from a wake', async () => {
    expect(await snooze.consent()).toBe(true);
    expect(perms.request).not.toHaveBeenCalled();
    perms.check.mockResolvedValue(false);
    perms.request.mockResolvedValue(false);
    expect(await snooze.consent()).toBe(false);
    expect(perms.request).toHaveBeenCalledWith('backgroundEvents');
    await snooze.wakeDue();
    expect(perms.request).toHaveBeenCalledTimes(1);
  });

  it('does not ask again on this device after a decline, and takes a later grant', async () => {
    perms.check.mockResolvedValue(false);
    perms.request.mockResolvedValue(false);
    expect(await snooze.consent()).toBe(false);
    snooze = make();
    expect(await snooze.consent()).toBe(false);
    expect(perms.request).toHaveBeenCalledTimes(1);
    perms.check.mockResolvedValue(true);
    expect(await snooze.consent()).toBe(true);
  });

  it('honors a decline from another open tab before prompting', async () => {
    const other = make();
    perms.check.mockResolvedValue(false);
    perms.request.mockResolvedValue(false);
    expect(await other.consent()).toBe(false);
    expect(await snooze.consent()).toBe(false);
    expect(perms.request).toHaveBeenCalledTimes(1);
  });

  it('preserves another tab\'s decline when persisting snooze state', async () => {
    const other = make();
    perms.check.mockResolvedValue(false);
    perms.request.mockResolvedValue(false);
    expect(await other.consent()).toBe(false);
    await snooze.snooze(message, NOW + 3600000);
    expect(JSON.parse(storage.getItem('puter-mail:snooze:tester')).declined).toBe(true);
    expect(await snooze.consent()).toBe(false);
    expect(perms.request).toHaveBeenCalledTimes(1);
  });

  it('rolls back its own failed move', async () => {
    vi.spyOn(mailbox.fs, 'move').mockRejectedValueOnce({ code: 'network_error' });
    await expect(snooze.snooze(message, NOW + 3600000)).rejects.toMatchObject({ code: 'network_error' });
    expect(stored()).toBeUndefined();
  });

  it('keeps another tab\'s successful snooze when its own move fails', async () => {
    const other = make();
    let successful;
    vi.spyOn(mailbox.fs, 'move').mockImplementationOnce(async () => {
      successful = await other.snooze(message, NOW + 7200000, { background: true });
      throw { code: 'subject_does_not_exist' };
    });
    await expect(snooze.snooze(message, NOW + 3600000)).rejects.toMatchObject({ code: 'subject_does_not_exist' });
    expect(stored()).toMatchObject({ token: successful.record.token, until: NOW + 7200000, scheduleId: 'schedule-1' });
    expect(await mailbox.fs.stat(successful.path)).toBeTruthy();
  });

  it.each(['events_handler_not_found', 'events_disabled', 'events_schedule_app_required',
    'events_durable_requires_account', 'events_schedule_limit', 'events_background_consent_required'])(
    'keeps a client wake when the schedule fails: %s', async (code) => {
      events.onSchedule.mockRejectedValueOnce({ code });
      const result = await snooze.snooze(message, NOW + 3600000, { background: true });
      expect(result).toMatchObject({ background: false, reason: code });
      expect(stored().scheduleId).toBeUndefined();
      expect(await mailbox.fs.stat(result.path)).toBeTruthy();
    });

  it('works locally when schedules and KV are absent', async () => {
    kv = null; events = null; perms = null; snooze = make();
    expect(await snooze.consent()).toBe(false);
    const result = await snooze.snooze(message, NOW + 3600000);
    snooze = make();
    expect(snooze.get(message.name).until).toBe(NOW + 3600000);
    vi.mocked(Date.now).mockReturnValue(NOW + 3600001);
    const returned = await snooze.wakeDue();
    expect(returned).toHaveLength(1);
    expect(returned[0].path).toContain('/objects/');
    expect(snooze.get(message.name)).toBeNull();
    expect(result.background).toBe(false);
  });

  it('removes before rescheduling, with a fresh token and the original origin', async () => {
    const first = await snooze.snooze(message, NOW + 3600000, { background: true });
    const oldToken = stored().token;
    const second = await snooze.snooze(snoozedMessage(first), NOW + 7200000, { background: true });
    expect(events.removeSchedule).toHaveBeenCalledWith('schedule-1');
    expect(events.removeSchedule.mock.invocationCallOrder[0]).toBeLessThan(events.onSchedule.mock.invocationCallOrder[1]);
    expect(stored().token).not.toBe(oldToken);
    expect(second.record.from.box).toBe('inbox');
  });

  it('moves the earlier schedule to the new time and token when it can', async () => {
    events.updateSchedule = vi.fn(async (scheduleId) => ({ scheduleId }));
    const first = await snooze.snooze(message, NOW + 3600000, { background: true });
    const second = await snooze.snooze(snoozedMessage(first), NOW + 7200000, { background: true });
    expect(events.removeSchedule).not.toHaveBeenCalled();
    expect(events.onSchedule).toHaveBeenCalledTimes(1);
    expect(events.updateSchedule).toHaveBeenCalledWith('schedule-1', { at: NOW + 7200000,
      context: { id: flagId(message.name), token: second.record.token, mailPath: mailbox.mailPath } });
    expect(stored()).toMatchObject({ until: NOW + 7200000, scheduleId: 'schedule-1', token: second.record.token });
  });

  it('makes a new schedule when the earlier one already ended', async () => {
    events.updateSchedule = vi.fn(async () => { throw { code: 'events_schedule_not_found' }; });
    const first = await snooze.snooze(message, NOW + 3600000, { background: true });
    events.onSchedule.mockResolvedValueOnce({ scheduleId: 'schedule-2' });
    const second = await snooze.snooze(snoozedMessage(first), NOW + 7200000, { background: true });
    expect(second.background).toBe(true);
    expect(stored().scheduleId).toBe('schedule-2');
  });

  it('drops the earlier schedule when moving it fails otherwise, and wakes from the app', async () => {
    events.updateSchedule = vi.fn(async () => { throw { code: 'too_many_requests' }; });
    const first = await snooze.snooze(message, NOW + 3600000, { background: true });
    const second = await snooze.snooze(snoozedMessage(first), NOW + 7200000, { background: true });
    expect(events.removeSchedule).toHaveBeenCalledWith('schedule-1');
    expect(second).toMatchObject({ background: false, reason: 'too_many_requests' });
  });

  it.each(['archive', 'trash'])('cancels and clears before filing into %s', async (box) => {
    const first = await snooze.snooze(message, NOW + 3600000, { background: true });
    const next = snoozedMessage(first);
    events.removeSchedule.mockRejectedValueOnce({ code: 'events_schedule_not_found' });
    const { previous } = await snooze.leave(next, () => mailbox.fs.move(next.path, `${mailbox.mailPath}/${box}/${next.day}`));
    expect(previous.scheduleId).toBe('schedule-1');
    expect(stored()).toBeUndefined();
    expect(events.removeSchedule).toHaveBeenCalledWith('schedule-1');
  });

  it('does not lose the record or move when cancellation fails temporarily', async () => {
    const first = await snooze.snooze(message, NOW + 3600000, { background: true });
    events.removeSchedule.mockRejectedValueOnce({ code: 'network_error' });
    const operation = vi.fn();
    await expect(snooze.leave(snoozedMessage(first), operation)).rejects.toMatchObject({ code: 'network_error' });
    expect(operation).not.toHaveBeenCalled();
    expect(stored()).toBeTruthy();
  });

  it.each(['archive', 'trash', 'objects'])('restores the background wake after a failed move to %s', async (box) => {
    const first = await snooze.snooze(message, NOW + 3600000, { background: true });
    events.onSchedule.mockResolvedValueOnce({ scheduleId: 'schedule-2' });
    let invalidatedToken;
    vi.spyOn(mailbox.fs, 'move').mockImplementationOnce(async () => {
      invalidatedToken = stored().token;
      throw { code: 'network_error' };
    });
    await expect(snooze.leave(snoozedMessage(first), () =>
      mailbox.fs.move(first.path, `${mailbox.mailPath}/${box}/${message.day}`)))
      .rejects.toMatchObject({ code: 'network_error' });
    expect(stored()).toMatchObject({ ...first.record, token: expect.any(String), scheduleId: 'schedule-2' });
    expect(stored().token).not.toBe(first.record.token);
    expect(stored().token).not.toBe(invalidatedToken);
    expect(events.onSchedule).toHaveBeenLastCalledWith({ at: first.record.until, handlerName: SNOOZE_HANDLER,
      context: { id: flagId(message.name), token: stored().token, mailPath: mailbox.mailPath } });
    expect(await mailbox.fs.stat(first.path)).toBeTruthy();
  });

  it('restores a client-only snooze without requesting a schedule after a failed operation', async () => {
    const first = await snooze.snooze(message, NOW + 3600000);
    const error = new Error('move failed');
    await expect(snooze.leave(snoozedMessage(first), async () => { throw error; })).rejects.toBe(error);
    expect(stored()).toMatchObject({ until: first.record.until, scheduleId: undefined });
    expect(stored().token).not.toBe(first.record.token);
    expect(events.onSchedule).not.toHaveBeenCalled();
  });

  it('keeps the restored record if rescheduling fails, and rethrows the operation error', async () => {
    const first = await snooze.snooze(message, NOW + 3600000, { background: true });
    events.onSchedule.mockRejectedValueOnce({ code: 'events_disabled' });
    const error = new Error('move failed');
    await expect(snooze.leave(snoozedMessage(first), async () => { throw error; })).rejects.toBe(error);
    expect(stored()).toMatchObject({ until: first.record.until, scheduleId: undefined });
    vi.mocked(Date.now).mockReturnValue(NOW + 7200000);
    expect(await snooze.wakeDue()).toHaveLength(1);
  });

  it('restores the previous snooze record and schedule for Undo', async () => {
    const first = await snooze.snooze(message, NOW + 3600000, { background: true });
    const next = snoozedMessage(first);
    const { previous } = await snooze.leave(next, () => mailbox.fs.move(next.path, `${mailbox.objectsPath}/${next.day}`));
    await mailbox.fs.move(message.path, first.path.slice(0, first.path.lastIndexOf('/')));
    await snooze.restore(next, previous, true);
    expect(stored()).toMatchObject({ until: first.record.until, scheduleId: 'schedule-1' });
    expect(events.onSchedule).toHaveBeenCalledTimes(2);
  });
});

describe('client wake and worker overlap', () => {
  it('wakes once across concurrent checks and fresh clients, into today at the top', async () => {
    await snooze.snooze(message, NOW + 3600000, { background: true });
    const at = NOW + 7200000;
    vi.mocked(Date.now).mockReturnValue(at);
    const calls = await Promise.all([snooze.wakeDue(), snooze.wakeDue(), make().wakeDue()]);
    const results = calls.flat();
    expect(results).toHaveLength(1);
    expect(calls[1]).toEqual([]);
    const [returned] = results;
    expect(returned.day).toBe(dayFolder(new Date(at)));
    expect(stored()).toBeUndefined();
    expect(await snooze.wakeDue()).toEqual([]);
    const box = createMailbox({ ...mailbox, pageSize: 2, promotions: snooze.promotions });
    await box.open();
    expect(box.messages[0].name).toBe(message.name);
    expect(box.messages.filter((m) => m.name === message.name)).toHaveLength(1);
    const all = await box.listAll();
    expect(all[0].name).toBe(message.name);
  });

  it('returns results only to the caller that started the wake', async () => {
    await snooze.snooze(message, NOW + 3600000);
    vi.mocked(Date.now).mockReturnValue(NOW + 7200000);
    const [started, joined] = await Promise.all([snooze.wakeDue(), snooze.wakeDue()]);
    expect(started).toHaveLength(1);
    expect(joined).toEqual([]);
  });

  it('ignores a removed record and an old handler after a time change', async () => {
    const first = await snooze.snooze(message, NOW + 3600000, { background: true });
    const ctx = { id: flagId(message.name), token: first.record.token, mailPath: mailbox.mailPath };
    await snooze.snooze(snoozedMessage(first), NOW + 10800000, { background: true });
    vi.mocked(Date.now).mockReturnValue(NOW + 7200000);
    const notify = vi.fn();
    await handler({ event: { op: 'tick' }, ctx, user: { fs: mailbox.fs, kv, notifications: { notify } } });
    expect(notify).not.toHaveBeenCalled();
    expect(await snooze.wakeDue()).toEqual([]);
    expect(await mailbox.fs.stat(first.path)).toBeTruthy();
  });

  it('still wakes when removing a suspended schedule is unavailable', async () => {
    await snooze.snooze(message, NOW + 3600000, { background: true });
    vi.mocked(Date.now).mockReturnValue(NOW + 7200000);
    events.removeSchedule.mockRejectedValueOnce({ code: 'events_disabled' });
    expect(await snooze.wakeDue()).toHaveLength(1);
    expect(stored()).toBeUndefined();
  });

  it('a client seeing a completed background wake never resurrects it', async () => {
    const result = await snooze.snooze(message, NOW + 3600000, { background: true });
    vi.mocked(Date.now).mockReturnValue(NOW + 7200000);
    const notify = vi.fn();
    await handler({ event: { op: 'tick' }, ctx: { id: flagId(message.name), token: result.record.token, mailPath: mailbox.mailPath },
      user: { fs: mailbox.fs, kv, notifications: { notify } } });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(await snooze.wakeDue()).toEqual([]);
    expect(snooze.get(message.name)).toBeNull();
  });
});
