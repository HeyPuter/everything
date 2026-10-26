// Account-level Vacay data operations for "download all my data" and "delete all my data".
import { INDEX, PREFIX, SHARES, vacayKeys } from './keys.js';
import { cleanIndex, readRecord } from './model.js';
import { errorCode } from './errors.js';

export { INDEX as VACAY_INDEX, vacayKeys } from './keys.js';

// Without the `kvShare` consent the app cannot revoke; the keys are deleted below, so those shares read nothing.
async function unshareQuiet(puter, handle) {
  try { await puter.kv.unshare(handle); } catch (error) { if (!['gone', 'disabled', 'consent'].includes(errorCode(error))) throw error; }
}

/**
 * Ends every Vacay share this user made or holds, then deletes every Vacay key, the index last so an interrupted
 * run can be repeated. Never lists KV; grants are found through `listSharedByMe`.
 */
export async function deleteVacayData(puter) {
  const [index, shares] = await puter.kv.get([INDEX, SHARES]);
  let cursor = null;
  let pages = 0;
  try {
    do {
      const page = await puter.kv.listSharedByMe({ limit: 100, ...(cursor ? { cursor } : {}) });
      for (const item of Array.isArray(page?.items) ? page.items : []) if (item?.prefix === PREFIX && !item.revokedAt && typeof item.handle === 'string') await unshareQuiet(puter, item.handle);
      cursor = typeof page?.cursor === 'string' && page.cursor ? page.cursor : null;
    } while (cursor && ++pages < 50);
  } catch (error) { if (errorCode(error) !== 'disabled') throw error; }
  for (const share of Object.values(readRecord('shares', shares))) await unshareQuiet(puter, share.handle);
  const keys = vacayKeys(cleanIndex(index)).filter((key) => key !== INDEX);
  for (const key of keys) await puter.kv.del(key);
  await puter.kv.del(INDEX);
  return { keys: keys.length + 1 };
}
