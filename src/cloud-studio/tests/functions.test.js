import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../src/storage/db.js';
import { ensureBootstrapAdmin, authenticate } from '../src/storage/auth.js';
import {
  putFunction,
  invokeFunction,
  listFunctions,
  listLogs,
  deleteFunction,
  FunctionError,
} from '../src/compute/functions.js';

async function admin() {
  const boot = await ensureBootstrapAdmin();
  return authenticate(boot.accessKeyId, boot.secretAccessKey);
}

describe('function runtime', () => {
  beforeEach(async () => {
    await resetDb();
    await ensureBootstrapAdmin();
  });

  it('deploys, invokes, and logs a handler', async () => {
    const key = await admin();
    await putFunction(
      key,
      'greeter',
      `exports.handler = async (event) => ({ msg: 'hi ' + event.who });`,
    );
    const listed = await listFunctions(key);
    expect(listed.some((f) => f.name === 'greeter')).toBe(true);

    const out = await invokeFunction(key, 'greeter', { who: 'puter' });
    expect(out.payload).toEqual({ msg: 'hi puter' });
    expect(out.statusCode).toBe(200);

    const logs = await listLogs(key, 'greeter');
    expect(logs[0].status).toBe('ok');
  });

  it('times out a slow function', async () => {
    const key = await admin();
    // Yielding loop (not a single long timer) so the invoke timeout can fire,
    // and abandoning the handler does not leave a 5s timer blocking resetDb.
    await putFunction(
      key,
      'slow',
      `exports.handler = async () => {
  const end = Date.now() + 3000;
  while (Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return 1;
};`,
      { timeoutMs: 80 },
    );
    await expect(invokeFunction(key, 'slow', {})).rejects.toMatchObject({ code: 'Timeout' });
    const logs = await listLogs(key, 'slow');
    expect(logs[0].status).toBe('timeout');
  }, 15000);

  it('rejects missing handlers and deletes functions', async () => {
    const key = await admin();
    await expect(putFunction(key, 'bad', 'const x = 1;')).rejects.toBeInstanceOf(FunctionError);
    await putFunction(key, 'temp', `exports.handler = async () => 1;`);
    await deleteFunction(key, 'temp');
    await expect(invokeFunction(key, 'temp', {})).rejects.toMatchObject({
      code: 'ResourceNotFoundException',
    });
  });
});
