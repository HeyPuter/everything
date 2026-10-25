/**
 * Collaborative (multi-writer) lists.
 *
 * Two transports, same merge rules (id/updatedAt/tombstones, merge.js):
 *
 * KV shares (current). The owner keeps the list under its own KV prefix
 * (`tasks:collab:<id>:`): `meta`, one `t:<taskId>` key per task and one
 * `d:<taskId>` per deletion. That prefix is shared at `write` with each
 * invited Puter username. Invitees find it with kv.listShared() and read and
 * write the same keys through the share's handle. Revoking or leaving is
 * kv.unshare(); a member whose handle stops working keeps a private copy.
 *
 * Linked replicas (legacy, and the fallback where KV shares are missing or
 * turned off). Every participant publishes a *replica* of the list as a
 * public-URL file in their own drive, and a *manifest* in the owner's drive
 * names the members and where their replicas live. Each app fetches the
 * others' replicas, merges, and republishes its own. Membership is a
 * two-link handshake (invite out, confirmation back). Revoking drops the
 * member from the manifest, but URLs they already hold stay readable until
 * they expire.
 *
 * Collaborations started on linked replicas stay on them; an owner who
 * wants username invites stops collaborating and invites again.
 */

export const MANIFEST_KIND = 'tasks.collab-manifest';
export const REPLICA_KIND = 'tasks.collab-replica';
export const COLLAB_VERSION = 1;

const COLLAB_DIR = 'tasks-data/collab';

/* The list id comes from a foreign manifest when joining; encode both path
   components so a crafted invite ('../../apps/x' as listId) cannot point
   the joiner's replica write outside the app's directory in their drive. */
const fsName = (s) => encodeURIComponent(String(s));
export const manifestPath = (listId) => `${COLLAB_DIR}/${fsName(listId)}.manifest.json`;
export const replicaPath = (listId, memberId) => `${COLLAB_DIR}/${fsName(listId)}.${fsName(memberId)}.replica.json`;

function cleanMember(m) {
  if (!m || !m.id || !m.replicaUrl) return null;
  return {
    id: String(m.id).slice(0, 80),
    name: String(m.name || m.id).slice(0, 80),
    replicaUrl: String(m.replicaUrl),
    addedAt: Number(m.addedAt) || 0,
  };
}

export function buildManifest(list, owner, members, { updatedAt = Date.now() } = {}) {
  return {
    kind: MANIFEST_KIND,
    v: COLLAB_VERSION,
    listId: list.id,
    name: list.name,
    icon: list.icon,
    slot: list.slot,
    owner,
    members,
    updatedAt,
  };
}

export function parseManifest(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  if (!data || data.kind !== MANIFEST_KIND) throw new Error('Not a shared-list invite');
  if (Number(data.v) > COLLAB_VERSION) throw new Error('This invite needs a newer app version');
  const owner = cleanMember(data.owner);
  if (!data.listId || !owner) throw new Error('Malformed invite');
  return {
    listId: String(data.listId),
    name: String(data.name || 'Shared list').slice(0, 80),
    icon: String(data.icon || 'list'),
    // Clamp to the real slot range: this styles var(--slot-N) lookups.
    slot: Math.min(8, Math.max(1, Math.floor(Number(data.slot)) || 1)),
    owner,
    members: (Array.isArray(data.members) ? data.members : []).map(cleanMember).filter(Boolean),
    updatedAt: Number(data.updatedAt) || 0,
  };
}

/** Everyone who publishes a replica: the owner plus approved members. */
export function participantsOf(manifest) {
  const seen = new Set();
  return [manifest.owner, ...manifest.members].filter((m) => {
    if (!m || seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

export function buildReplica(list, tasks, deleted, member, { updatedAt = Date.now() } = {}) {
  return {
    kind: REPLICA_KIND,
    v: COLLAB_VERSION,
    listId: list.id,
    member: { id: member.id, name: member.name },
    updatedAt,
    tasks,
    deleted,
  };
}

export function parseReplica(json, listId) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  if (!data || data.kind !== REPLICA_KIND) throw new Error('Not a list replica');
  if (Number(data.v) > COLLAB_VERSION) throw new Error('Replica needs a newer app version');
  if (listId && data.listId !== listId) throw new Error('Replica is for a different list');
  return {
    listId: String(data.listId),
    member: data.member || null,
    updatedAt: Number(data.updatedAt) || 0,
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
    deleted: Array.isArray(data.deleted) ? data.deleted : [],
  };
}

/* ---------- links ---------- */

const appUrl = () => location.origin + location.pathname;

export function inviteLink(manifestUrl) {
  return `${appUrl()}#/join?m=${encodeURIComponent(manifestUrl)}`;
}

export function confirmLink(payload) {
  return `${appUrl()}#/approve?d=${encodeURIComponent(JSON.stringify(payload))}`;
}

function safeUrl(u) {
  try {
    const url = new URL(u);
    // blob: covers the dev mock; real URLs are always https.
    return ['https:', 'http:', 'blob:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function parseJoinHash(hash) {
  const q = (hash || '').split('?')[1];
  const m = q ? new URLSearchParams(q).get('m') : null;
  return m ? safeUrl(m) : null;
}

export function parseConfirmHash(hash) {
  const q = (hash || '').split('?')[1];
  const d = q ? new URLSearchParams(q).get('d') : null;
  if (!d) return null;
  try {
    const data = JSON.parse(d);
    const member = cleanMember(data.member);
    if (!data.listId || !member || !safeUrl(member.replicaUrl)) return null;
    return { listId: String(data.listId), member };
  } catch {
    return null;
  }
}

/* ---------- KV shares ---------- */

export const KV_COLLAB_ROOT = 'tasks:collab:';
export const META_KIND = 'tasks.collab-meta';

/** Share prefix for a collaboration id (lowercase a-z, 0-9, `_.-` only). */
export const kvPrefixFor = (collabId) => `${KV_COLLAB_ROOT}${collabId}:`;
export const isKvPrefix = (p) => /^tasks:collab:[a-z0-9_.-]{1,64}:$/.test(String(p || ''));
export const taskKey = (id) => `t:${id}`;
export const tombKey = (id) => `d:${id}`;

/** Codes meaning this deployment won't make KV shares at all. */
export const SHARING_OFF = new Set([
  'kv_handles_disabled', 'events_kv_handles_disabled', 'events_disabled',
]);

/**
 * A member's local id for a shared list, derived from the handle so every
 * device of that account lands on the same list.
 */
export function memberListId(handle) {
  return `kv-${String(handle).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 64)}`;
}

export function buildMeta(list, owner) {
  return { kind: META_KIND, v: COLLAB_VERSION, name: list.name, icon: list.icon, slot: list.slot, owner };
}

/** Any write holder can change `meta`: display only, vetted like a manifest. */
export function parseMeta(raw) {
  if (!raw || typeof raw !== 'object' || raw.kind !== META_KIND) return null;
  return {
    name: String(raw.name || 'Shared list').slice(0, 80),
    icon: String(raw.icon || 'list'),
    slot: Math.min(8, Math.max(1, Math.floor(Number(raw.slot)) || 1)),
    owner: raw.owner ? String(raw.owner).slice(0, 80) : null,
  };
}

/** Split a prefix listing (keys relative to the prefix) into meta, tasks and tombstones. */
export function readKvEntries(entries) {
  const out = { meta: null, rawMeta: null, tasks: new Map(), deleted: new Map() };
  for (const { key, value } of Array.isArray(entries) ? entries : []) {
    if (typeof key !== 'string') continue;
    if (key === 'meta') {
      out.rawMeta = value;
      out.meta = parseMeta(value);
    } else if (key.startsWith('t:') && value && typeof value === 'object') {
      out.tasks.set(key.slice(2), value);
    } else if (key.startsWith('d:') && value && typeof value === 'object') {
      out.deleted.set(key.slice(2), { id: key.slice(2), at: Number(value.at) || 0 });
    }
  }
  return out;
}

/**
 * The list name as a share label: no control or invisible formatting
 * characters, one line, at most 3 combining marks per character, and
 * within 128 characters / 512 UTF-8 bytes. Null when nothing is left.
 */
export function shareLabel(name) {
  const chars = [...String(name || '')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/(\p{M}{3})\p{M}+/gu, '$1')
    .trim()].slice(0, 128);
  const enc = new TextEncoder();
  while (chars.length && enc.encode(chars.join('')).length > 512) chars.pop();
  return chars.join('').trim() || null;
}

/** What to tell the owner when an invite fails. */
export function shareErrorMessage(err, username = 'that user') {
  switch (err?.code) {
    case 'subject_does_not_exist': return `No Puter user is named "${username}"`;
    case 'invalid_recipient': return 'Enter a Puter username, not an email address';
    case 'recipient_not_accepting_shares': return `${username} is not accepting shared lists`;
    case 'account_is_not_verified': return 'Confirm your email address on Puter to share lists';
    case 'events_kv_handle_requires_account': return 'Save your Puter account to share lists';
    case 'events_kv_handle_limit_reached': return 'You have reached the limit of people you can share with';
    case 'events_kv_handle_not_delegated': return 'Tasks needs your permission to share lists';
    case 'too_many_requests': return 'Too many invites at once. Try again in a moment';
    default: return 'Could not invite. Check your connection';
  }
}
