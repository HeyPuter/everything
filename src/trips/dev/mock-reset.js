const fixtureAccount = /^00000000-0000-4000-8000-00000000000[123]$/;

export async function resetMockAccount(account, options = {}) {
  if (!fixtureAccount.test(account)) throw new Error('invalid_mock_account');
  let indexedDB;
  try { indexedDB = Object.hasOwn(options, 'indexedDB') ? options.indexedDB : globalThis.indexedDB; }
  catch { return { cleared: 0, blocked: 0, unavailable: true }; }
  if (!indexedDB) return { cleared: 0, blocked: 0, unavailable: true };
  const results = await Promise.all(['trips-v1:', 'trips-services:'].map((prefix) => new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(prefix + account);
    request.onsuccess = () => resolve('cleared');
    request.onblocked = () => resolve('blocked');
    request.onerror = () => resolve('blocked');
  }).catch(() => 'blocked')));
  return { cleared: results.filter((value) => value === 'cleared').length, blocked: results.filter((value) => value === 'blocked').length };
}
