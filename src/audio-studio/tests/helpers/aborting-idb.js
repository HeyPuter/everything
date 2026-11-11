/**
 * An indexedDB stand-in whose transactions abort (as a quota error does):
 * the transaction fires `abort` without an `error` event first.
 */
export function abortingIndexedDB() {
  const store = { getAll: () => ({}), put: () => ({}), delete: () => ({}) };
  const db = {
    close() {},
    transaction() {
      const t = {
        error: Object.assign(new Error('Quota exceeded'), { name: 'QuotaExceededError' }),
        objectStore: () => store,
      };
      setTimeout(() => t.onabort?.({ target: t }), 0);
      return t;
    },
  };
  return {
    open() {
      const req = { result: db };
      setTimeout(() => req.onsuccess?.(), 0);
      return req;
    },
  };
}

/** Resolves `promise`, or 'hung' after `ms`. */
export const settleWithin = (promise, ms = 200) =>
  Promise.race([
    promise.then(
      (v) => ({ value: v }),
      (e) => ({ error: e }),
    ),
    new Promise((r) => setTimeout(() => r('hung'), ms)),
  ]);
