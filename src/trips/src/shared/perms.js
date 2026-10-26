import { invariant } from './errors.js';

const rule = (defaultRole, allowed) => Object.freeze({ default: defaultRole, allowed: Object.freeze(allowed) });
export const PERMISSIONS = Object.freeze({
  'trip.edit': rule('owner', ['owner', 'editor']),
  'trip.archive': rule('owner', ['owner', 'editor']),
  'trip.cover': rule('owner', ['owner', 'editor']),
  'trip.delete': rule('owner', ['owner']),
  'perms.edit': rule('owner', ['owner']),
  transfer: rule('owner', ['owner']),
  'members.manage': rule('owner', ['owner', 'editor']),
  'share.manage': rule('owner', ['owner', 'editor']),
  'files.upload': rule('editor', ['owner', 'editor']),
  'files.edit': rule('editor', ['owner', 'editor']),
  'files.delete': rule('editor', ['owner', 'editor']),
  'plan.edit': rule('editor', ['owner', 'editor']),
  'res.edit': rule('editor', ['owner', 'editor']),
  'costs.edit': rule('editor', ['owner', 'editor']),
  'lists.edit': rule('editor', ['owner', 'editor']),
  'collab.post': rule('editor', ['owner', 'editor', 'viewer']),
});

const rank = Object.freeze({ viewer: 0, editor: 1, owner: 2 });
export function validatePermissions(overrides) {
  invariant(overrides && typeof overrides === 'object' && !Array.isArray(overrides), 'invalid_permissions');
  for (const [action, role] of Object.entries(overrides)) {
    invariant(Object.hasOwn(PERMISSIONS, action) && PERMISSIONS[action].allowed.includes(role), 'invalid_permissions');
  }
  return true;
}

export function can(role, action, overrides = {}) {
  if (!Object.hasOwn(rank, role) || !Object.hasOwn(PERMISSIONS, action)) return false;
  const minimum = Object.hasOwn(overrides, action) ? overrides[action] : PERMISSIONS[action].default;
  return PERMISSIONS[action].allowed.includes(minimum) && rank[role] >= rank[minimum];
}

export function assertCan(role, action, overrides) {
  invariant(can(role, action, overrides), 'forbidden', 403);
}
