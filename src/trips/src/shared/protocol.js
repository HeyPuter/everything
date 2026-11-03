import { invariant } from './errors.js';
import { isId } from './ids.js';

export const PROTOCOL = 1;
export const KINDS = Object.freeze(['trip', 'collection', 'journey']);
export const WORKER_PATTERN = /^trips-[a-z0-9]{10}$/;
export const API_PATH = '/api';
export const OPS = Object.freeze([
  'hello', 'space.create', 'space.list', 'heads', 'open', 'sync', 'snapshot', 'repair', 'pres', 'commit', 'chat.page',
  'invite.create', 'invite.list', 'invite.revoke', 'join.preview', 'join', 'invite.decline',
  'member.role', 'member.remove', 'leave', 'share.set', 'feed.set', 'file.put', 'file.del', 'space.export', 'space.delete', 'link.unfurl', 'feed.all',
  'transfer.offer', 'transfer.cancel', 'transfer.accept', 'transfer.export', 'transfer.complete', 'transfer.import', 'transfer.join',
]);
export const DOMAIN_OPS = Object.freeze(['day.remove', 'trip.redate', 'visit.move', 'costs.settleAll', 'res.moveToTrip']);

export function workerOrigin(name) {
  invariant(typeof name === 'string' && WORKER_PATTERN.test(name), 'untrusted_worker');
  return `https://${name}.puter.work`;
}

export function trustedWorkerURL(value) {
  invariant(typeof value === 'string' && value.length <= 2048 && !/[\u0000-\u0020\\]/.test(value), 'untrusted_worker');
  let url;
  try { url = new URL(value); } catch { invariant(false, 'untrusted_worker'); }
  invariant(url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.hash, 'untrusted_worker');
  invariant(url.hostname.endsWith('.puter.work') && WORKER_PATTERN.test(url.hostname.slice(0, -'.puter.work'.length)), 'untrusted_worker');
  return url;
}

export function validateSpaceRef(value) {
  invariant(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 3 && Object.hasOwn(value, 'w') && Object.hasOwn(value, 's') && Object.hasOwn(value, 'k'), 'invalid_space_ref');
  workerOrigin(value.w);
  invariant(isId(value.s) && KINDS.includes(value.k), 'invalid_space_ref');
  return value;
}

export function spaceRoute(ref) {
  validateSpaceRef(ref);
  return `#/${{ trip: 't', collection: 'c', journey: 'j' }[ref.k]}/${ref.w}/${ref.s}`;
}

export function entityKey(space, type, id) {
  invariant(isId(space) && typeof type === 'string' && /^[a-z][a-zA-Z0-9]{0,31}$/.test(type), 'invalid_key');
  invariant(typeof id === 'string' && /^(?:[0-9a-z]{16}|[0-9a-f-]{36}|meta)$/i.test(id), 'invalid_key');
  return `shared:${space}:${type === 'msg' ? `m:${id}` : `e:${type}:${id}`}`;
}
