import { invariant } from '../shared/errors.js';
import { isUuid } from '../shared/ids.js';

export function getPuter(injected = globalThis.puter) {
  invariant(injected?.auth && injected?.kv && injected?.fs && injected?.workers, 'sdk_unavailable');
  return injected;
}

export async function accountIdentity(puter) {
  const user = await getPuter(puter).auth.getUser();
  invariant(user && isUuid(user.uuid), 'invalid_account');
  return { uuid: user.uuid, username: user.username ?? '' };
}
