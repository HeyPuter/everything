import { expect, it } from 'vitest';
import { DocumentSession } from '../src/app/session';

it('waits for asset edits in their own document without blocking another document', async () => {
  const first = new DocumentSession(), second = new DocumentSession();
  let finish!: () => void;
  first.trackEdit(new Promise<void>((resolve) => { finish = resolve; }));
  let finished = false;
  const waiting = first.waitForEdits().then(() => { finished = true; });
  await second.waitForEdits();
  expect(finished).toBe(false);
  finish();
  await waiting;
  expect(finished).toBe(true);
});

it('reports a failed pending edit and permits later edits to finish', async () => {
  const session = new DocumentSession();
  let fail!: (error: Error) => void;
  session.trackEdit(new Promise<void>((_, reject) => { fail = reject; }));
  const failed = expect(session.waitForEdits()).rejects.toThrow('Asset failed');
  fail(new Error('Asset failed'));
  await failed;
  let applied = false;
  session.trackEdit(Promise.resolve().then(() => { applied = true; }));
  await session.waitForEdits();
  expect(applied).toBe(true);
});
