import { IDBFactory } from 'fake-indexeddb';
import { expect, it } from 'vitest';
import { resetMockAccount } from '../../dev/mock-reset.js';

const account = '00000000-0000-4000-8000-000000000001';
const open = (factory, name) => new Promise((resolve) => {
  const request = factory.open(name, 1);
  request.onsuccess = () => resolve(request.result);
});
it('resets only the selected synthetic account and preserves other account databases', async () => {
  const indexedDB = new IDBFactory();
  const mine = await open(indexedDB, `trips-v1:${account}`); mine.close();
  const other = await open(indexedDB, 'trips-v1:00000000-0000-4000-8000-000000000002'); other.close();
  const real = await open(indexedDB, 'trips-v1:11111111-1111-4111-8111-111111111111'); real.close();
  expect(await resetMockAccount(account, { indexedDB })).toEqual({ cleared: 2, blocked: 0 });
  expect((await indexedDB.databases()).map((item) => item.name)).toEqual([
    'trips-v1:00000000-0000-4000-8000-000000000002', 'trips-v1:11111111-1111-4111-8111-111111111111',
  ]);
  await expect(resetMockAccount('11111111-1111-4111-8111-111111111111', { indexedDB })).rejects.toThrow('invalid_mock_account');
});
it('reports a blocked fixture reset so bootstrap can show a recovery screen', async () => {
  const indexedDB = new IDBFactory();
  const connection = await open(indexedDB, `trips-v1:${account}`);
  const result = await resetMockAccount(account, { indexedDB });
  expect(result).toEqual({ cleared: 1, blocked: 1 });
  connection.close();
});
it('converts synchronous blocked-storage failures into reset status', async () => {
  const options = { get indexedDB() { throw new DOMException('Denied', 'SecurityError'); } };
  expect(await resetMockAccount(account, options)).toMatchObject({ cleared: 0, unavailable: true });
  const indexedDB = { deleteDatabase() { throw new DOMException('Denied', 'SecurityError'); } };
  expect(await resetMockAccount(account, { indexedDB })).toEqual({ cleared: 0, blocked: 2 });
});
