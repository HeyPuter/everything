import { it, expect, vi } from 'vitest';
import { Autosave } from '../src/storage/autosave.js';
import { Store } from '../src/model/store.js';
import { newProject } from '../src/model/demo.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

it('all draft flush callers wait for the newest queued write', async () => {
  const writes = [deferred(), deferred()];
  const write = vi.fn().mockReturnValueOnce(writes[0].promise).mockReturnValueOnce(writes[1].promise);
  const a = new Autosave({ store: new Store(newProject()), writeDraft: write });
  const first = a.flushDraft();
  await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  let secondDone = false;
  const second = a.flushDraft().then(() => { secondDone = true; });
  let allDone = false;
  const all = a.flushAll().then(() => { allDone = true; });
  writes[0].resolve();
  await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
  const finishedEarly = { second: secondDone, all: allDone };
  writes[1].resolve();
  await Promise.all([first, second, all]);
  expect(finishedEarly).toEqual({ second: false, all: false });
  expect(a.pending).toBe(false);
});

it('does not lose a flush requested in the microtask that completes a draft write', async () => {
  const gate = deferred();
  const write = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue(undefined);
  const a = new Autosave({ store: new Store(newProject()), writeDraft: write });
  const first = a.flushDraft();
  await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  const next = gate.promise.then(() => a.flushDraft());
  gate.resolve();
  await Promise.all([first, next]);
  expect(write).toHaveBeenCalledTimes(2);
  expect(a.pending).toBe(false);
});

it('flushAll waits for a cloud write already in progress', async () => {
  const gate = deferred();
  const store = new Store(newProject());
  store.dirty = true;
  const a = new Autosave({ store, writeDraft: async () => {}, writeCloud: () => gate.promise, cloudEnabled: () => true });
  const cloud = a.flushCloud();
  let allDone = false;
  const all = a.flushAll().then(() => { allDone = true; });
  await new Promise((r) => setTimeout(r, 0));
  const finishedEarly = allDone;
  gate.resolve();
  await Promise.all([cloud, all]);
  expect(finishedEarly).toBe(false);
});

it('flushAll drains a newer cloud save queued behind an active write', async () => {
  const gates = [deferred(), deferred()];
  const store = new Store(newProject());
  store.dirty = true;
  const write = vi.fn().mockReturnValueOnce(gates[0].promise).mockImplementationOnce(async () => { await gates[1].promise; store.markSaved(); });
  const timers = { setTimeout: () => 1, clearTimeout() {} };
  const a = new Autosave({ store, writeDraft: async () => {}, writeCloud: write, cloudEnabled: () => true, timers });
  const first = a.flushCloud();
  a.scheduleCloud();
  let done = false;
  const all = a.flushAll().then(() => { done = true; });
  gates[0].resolve();
  await new Promise((r) => setTimeout(r, 0));
  const whileSecondPending = { writes: write.mock.calls.length, done };
  gates[1].resolve();
  await Promise.all([first, all]);
  expect(whileSecondPending).toEqual({ writes: 2, done: false });
});
