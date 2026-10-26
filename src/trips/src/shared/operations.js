import { invariant } from './errors.js';
import { isId, isUuid } from './ids.js';
import { isHlc } from './hlc.js';
import { LIMITS } from './limits.js';
import { DOMAIN_OPS } from './protocol.js';
import { can } from './perms.js';
import { entitySchema, validateEntity, SERVER_FIELDS } from './schema/index.js';
import { plainObject, safeKey, schemaAt, validate } from './schema/dsl.js';

const CONFLICT_TYPES = new Set(['place', 'visit', 'res', 'exp', 'pack', 'note', 'saved', 'bookPage']);
const SELF = Object.freeze({ place: ['rating', 'tags', 'visited'], saved: ['rating', 'tags', 'visited'], pack: ['doneBy', 'bring'], poll: ['votes'], msg: ['react'] });
const COSTS = new Set(['exp', 'settle', 'splitPreset', 'costCat', 'budget']);
const LISTS = new Set(['pack', 'bag', 'todo', 'listMeta']);
const COLLAB = new Set(['note', 'link', 'poll', 'msg']);

function parts(path) {
  invariant(typeof path === 'string' && path.length <= 1024, 'invalid_path');
  const segments = path.split('.');
  invariant(segments.length <= LIMITS.pathDepth && segments.every(safeKey), 'invalid_path');
  invariant(!SERVER_FIELDS.includes(segments[0]), 'server_field');
  return segments;
}

function jsonSafe(value, depth = 0) {
  invariant(depth <= LIMITS.pathDepth, 'invalid_depth');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') { invariant(Number.isFinite(value), 'invalid_number'); return; }
  if (Array.isArray(value)) { for (const item of value) jsonSafe(item, depth + 1); return; }
  invariant(plainObject(value), 'invalid_object');
  for (const [key, item] of Object.entries(value)) {
    invariant(safeKey(key), 'invalid_key');
    jsonSafe(item, depth + 1);
  }
}

export function validateOperation(op, { kind = 'trip' } = {}) {
  invariant(plainObject(op) && isId(op.opId), 'invalid_operation');
  if (Object.hasOwn(op, 'do')) {
    invariant(Object.keys(op).every((key) => ['opId', 'do', 'args'].includes(key)) && DOMAIN_OPS.includes(op.do) && plainObject(op.args), 'invalid_domain_op');
    jsonSafe(op.args);
    invariant(new TextEncoder().encode(JSON.stringify(op)).length <= LIMITS.bodyBytes, 'body_too_large', 413);
    return op;
  }
  invariant(Object.keys(op).every((key) => ['opId', 't', 'id', 'put', 'set', 'unset', 'del', 'base'].includes(key)), 'unknown_field');
  const schema = entitySchema(kind, op.t);
  invariant(op.t === 'meta' ? op.id === 'meta' : op.t === 'member' ? isUuid(op.id) : isId(op.id), 'invalid_id');
  const create = Object.hasOwn(op, 'put');
  const remove = Object.hasOwn(op, 'del');
  const patch = Object.hasOwn(op, 'set') || Object.hasOwn(op, 'unset');
  invariant(Number(create) + Number(remove) + Number(patch) === 1, 'invalid_operation');
  if (Object.hasOwn(op, 'base')) invariant(CONFLICT_TYPES.has(op.t) && isHlc(op.base) && !create, 'invalid_base');
  if (create) validateEntity(kind, op.t, op.put);
  if (remove) invariant(op.del === true, 'invalid_delete');
  if (patch) {
    invariant(op.set === undefined || plainObject(op.set), 'invalid_patch');
    invariant(op.unset === undefined || (Array.isArray(op.unset) && op.unset.every((path) => typeof path === 'string')), 'invalid_patch');
    const paths = [...Object.keys(op.set ?? {}), ...(op.unset ?? [])];
    invariant(paths.length > 0 && paths.length <= LIMITS.commitWrites && new Set(paths).size === paths.length, 'invalid_patch');
    const sorted = [...paths].sort();
    sorted.forEach((path, index) => {
      const segments = parts(path);
      invariant(index === 0 || !path.startsWith(`${sorted[index - 1]}.`), 'overlapping_paths');
      const field = schemaAt(schema, segments);
      invariant(field, 'unknown_field');
      if (Object.hasOwn(op.set ?? {}, path)) validate(field, op.set[path]);
      else invariant(field.optional || schemaAt(schema, segments.slice(0, -1))?.kind === 'record', 'required_field');
    });
  }
  invariant(new TextEncoder().encode(JSON.stringify(op)).length <= LIMITS.bodyBytes, 'body_too_large', 413);
  return op;
}

export function validateCommit(ops, options) {
  invariant(Array.isArray(ops) && ops.length > 0 && ops.length <= LIMITS.commitWrites, 'invalid_commit');
  invariant(new TextEncoder().encode(JSON.stringify(ops)).length <= LIMITS.bodyBytes, 'body_too_large', 413);
  const seen = new Set();
  for (const op of ops) {
    validateOperation(op, options);
    invariant(!seen.has(op.opId), 'duplicate_op');
    seen.add(op.opId);
  }
  return ops;
}

function action(type) {
  if (COSTS.has(type)) return 'costs.edit';
  if (LISTS.has(type)) return 'lists.edit';
  if (COLLAB.has(type)) return 'collab.post';
  if (type === 'res') return 'res.edit';
  if (type === 'file') return 'files.edit';
  return 'plan.edit';
}

function selfPath(type, path, uid) {
  const segments = path.split('.');
  if (!SELF[type]?.includes(segments[0])) return false;
  return type === 'msg' ? segments.length === 3 && segments[2] === uid : segments.length === 2 && segments[1] === uid;
}

function checkSelfCreation(type, put, uid) {
  for (const field of SELF[type] ?? []) {
    const value = put[field];
    if (!value) continue;
    const userMaps = type === 'msg' ? Object.values(value) : [value];
    invariant(userMaps.every((map) => Object.keys(map).every((key) => key === uid)), 'forbidden', 403);
  }
}

export function authorizeOperation(op, { kind = 'trip', role, uid, creator, entity, pollHasVoted, perms = {}, now = Date.now() } = {}) {
  validateOperation(op, { kind });
  invariant(['owner', 'editor', 'viewer'].includes(role) && isUuid(uid), 'forbidden', 403);
  // Domain ops need their own state-aware validators and budget checks.
  invariant(!op.do, 'domain_authorization_required', 403);
  const type = op.t;
  invariant(type !== 'member', 'worker_only', 403);
  if (op.put) {
    invariant(!['meta', 'file'].includes(type), 'worker_only', 403);
    invariant(can(role, action(type), perms), 'forbidden', 403);
    checkSelfCreation(type, op.put, uid);
    invariant(type !== 'msg' || op.put.deleted !== true, 'forbidden', 403);
    return true;
  }
  invariant(entity && entity.id === op.id && !entity.deleted, 'gone', 409);
  if (op.base !== undefined) invariant(entity.v === op.base, 'stale', 409);
  if (op.del) {
    invariant(type !== 'meta' && type !== 'file', 'domain_operation_required', 403);
    const allowed = type === 'msg' || ['note', 'link', 'poll'].includes(type)
      ? role === 'owner' || creator === uid : can(role, action(type), perms);
    invariant(allowed, 'forbidden', 403);
    return true;
  }
  const paths = [...Object.keys(op.set ?? {}), ...(op.unset ?? [])];
  for (const path of paths) {
    const field = path.split('.')[0];
    if (SELF[type]?.includes(field)) {
      invariant(selfPath(type, path, uid), 'forbidden', 403);
      if (['msg', 'poll'].includes(type)) {
        invariant(can(role, 'collab.post', perms), 'forbidden', 403);
        if (type === 'poll') invariant(!entity.closed && (entity.deadline == null || now < entity.deadline), 'poll_closed', 409);
      }
      continue;
    }
    if (type === 'meta') {
      invariant(field !== 'transfer' && field !== 'movedTo', 'worker_only', 403);
      const permission = { perms: 'perms.edit', share: 'share.manage', cover: 'trip.cover', archived: 'trip.archive' }[field] ?? 'trip.edit';
      invariant(can(role, permission, perms), 'forbidden', 403);
    } else if (type === 'file') {
      invariant(['desc', 'star', 'links', 'linked'].includes(field) && can(role, 'files.edit', perms), 'forbidden', 403);
    } else if (type === 'msg') {
      invariant(field === 'text' && creator === uid && Number.isSafeInteger(entity.cr)
        && now >= entity.cr && now - entity.cr <= 15 * 60_000 && can(role, 'collab.post', perms), 'forbidden', 403);
    } else if (['note', 'link', 'poll'].includes(type)) {
      invariant(role === 'owner' || creator === uid, 'forbidden', 403);
      if (type === 'poll') {
        invariant(['question', 'options', 'closed', 'deadline'].includes(field), 'forbidden', 403);
        if (['question', 'options'].includes(field)) invariant(pollHasVoted === false
          && !Object.values(entity.votes ?? {}).some((votes) => votes.length > 0), 'poll_has_votes', 409);
      }
    } else invariant(can(role, action(type), perms), 'forbidden', 403);
  }
  return true;
}

export function applyPatch(kind, type, entity, op) {
  const data = structuredClone(entity);
  for (const [path, value] of Object.entries(op.set ?? {})) {
    const segments = parts(path);
    let parent = data;
    for (const segment of segments.slice(0, -1)) {
      if (!Object.hasOwn(parent, segment)) parent[segment] = {};
      invariant(plainObject(parent[segment]), 'invalid_patch');
      parent = parent[segment];
    }
    parent[segments.at(-1)] = structuredClone(value);
  }
  for (const path of op.unset ?? []) {
    const segments = parts(path);
    let parent = data;
    for (const segment of segments.slice(0, -1)) {
      parent = Object.hasOwn(parent, segment) ? parent[segment] : undefined;
      if (parent === undefined) break;
      invariant(plainObject(parent), 'invalid_patch');
    }
    if (parent) delete parent[segments.at(-1)];
  }
  validateEntity(kind, type, data, { server: Object.hasOwn(data, 'id') });
  return data;
}
