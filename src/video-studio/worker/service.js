/**
 * Review service: runs in the owner's Puter worker against the owner's KV
 * and files. Every operation is validated here; the app's own checks are
 * only for quick feedback.
 *
 * KV layout (no listing anywhere: every collection is numbered with incr
 * and read back by key, in batches):
 *   vsr:project:<projectId>          review id shared from that project
 *   vsr:pub:<clientId>               { review, version } of a finished publish (retries)
 *   vsr:r:<rid>                      { id, title, projectId, owner, created, updated }
 *   vsr:r:<rid>:vseq                 version counter
 *   vsr:r:<rid>:v:<n>                { n, path, size, mime, width, height, fps, duration, range, timelineId?, title, created }
 *   vsr:r:<rid>:url:<n>              { url, expires } read link for version n's video
 *   vsr:r:<rid>:m:<uuid>             base grant, grant_<invite> snapshots, blocked_<n> flags, scoped role/name overrides
 *   vsr:r:<rid>:mseq / :mi:<n>       legacy member list
 *   vsr:r:<rid>:mdir                 member_<escaped uuid> -> uuid (written before granting access)
 *   vsr:invite:<sha256(token)>       { review, id, n?, role, created, expires, revoked, uses }
 *   vsr:r:<rid>:iseq / :ii:<n>       invite order -> token hash (the invite list)
 *   vsr:r:<rid>:seq                  change counter for comments
 *   vsr:r:<rid>:log:<n>              { at, comment } comment snapshot saved as change n
 *   vsr:r:<rid>:c:<commentId>        latest snapshot of a comment
 *   vsr:rate:<rid>:<uuid>:<minute>   comments posted this minute (expires)
 *   vsr:wrate:<rid>:<uuid>:<minute>  comment edits, deletes and resolves this minute (expires)
 *   vsr:rrate:<rid>:<uuid>:<minute>  recovery deliveries this minute (expires)
 *   vsr:joinfail:<uuid>:<window>     failed joins in a 10 minute window (expires)
 */
import {
  ID, TOKEN, LIMITS, DAY, GUEST_ROLES, COMMENT_DELIVERY_PENDING, canComment, canResolve, hash, randomId, inviteToken,
  validateComment, textProblem, cleanText, cleanTitle, inviteDays,
} from '../src/review/protocol.js';

/** How long a video read link lives, and how much of that is left when a new one is made. */
export const VIDEO_LINK_HOURS = 4;
export const VIDEO_LINK_RENEW_MS = 30 * 60_000;
/** How long a later change must wait before sync can mark a missing slot skipped. */
export const LOST_CHANGE_MS = 60_000;
/** Bound resends if every delivery is so slow that sync skips its slot. */
export const LOG_DELIVERY_ATTEMPTS = 3;

/** Everyone who ever joined a review (removed people too) stays on its member list, up to this many times its limit. */
export const MEMBER_LIST_FACTOR = 5;

const VIDEO_MIME = ['video/mp4', 'video/webm', 'video/quicktime'];

export function fail(status, message, code) {
  throw Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

const range = (from, to) => {
  const out = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
};

const reviewId = (v) => {
  if (typeof v !== 'string' || !ID.test(v)) fail(400, 'Invalid review.');
  return v;
};

const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : NaN);

// A fresh invite grants a new membership. Delayed writes for the previous grant
// must not change its role or display name. Older records keep their base fields.
const memberField = (member, field) => `${field}_${member.invite || 'legacy'}`;
const memberValue = (member, field) => member[memberField(member, field)] ?? member[field];

const inviteBlocked = (member, invite) => Boolean(member && (
  member[`blocked_${invite.n}`] || ((!invite.n || invite.legacy) && member.blockLegacy)
  || (!member.blockLegacy && (member.removedAt || member.removed) && invite.created <= (member.removedAt || member.removed))
));

// Rejoins add a grant, never replace the record containing revocations and role
// overrides. At most LIMITS.invites grants can exist; removal retires their data.
function memberState(record) {
  if (!record?.hasGrants) return record;
  let grant = record;
  for (const field of Object.keys(record)) {
    if (field.startsWith('grant_') && record[field]?.inviteN > (grant.inviteN || 0)) grant = record[field];
  }
  if (grant === record) return record;
  return { ...record, ...grant, removedAt: record.removed,
    removed: record[`blocked_${grant.inviteN}`] || (grant.legacy && record.blockLegacy) ? record.removed || 1 : null };
}

/** Clean the video description the owner's app sends with a publish. */
export function validateVideo(video) {
  if (!video || typeof video !== 'object') fail(400, 'Invalid video.');
  const path = video.path;
  if (typeof path !== 'string' || !path || path.length > 1024 || path.includes('..')) fail(400, 'Invalid video file.');
  const mime = VIDEO_MIME.includes(video.mime) ? video.mime : fail(400, 'Unsupported video type.');
  const fps = Number(video.fps);
  if (!Number.isFinite(fps) || fps < 1 || fps > 240) fail(400, 'Invalid frame rate.');
  const duration = int(video.duration);
  if (!(duration > 0) || duration > DAY * 1000) fail(400, 'Invalid duration.');
  const width = int(video.width);
  const height = int(video.height);
  if (!(width > 0 && width <= 8192 && height > 0 && height <= 8192)) fail(400, 'Invalid size.');
  let r = null;
  if (video.range) {
    const a = int(video.range.in);
    const b = int(video.range.out);
    if (!(a >= 0 && b > a)) fail(400, 'Invalid range.');
    r = { in: a, out: b };
  }
  // The editor timeline it was made from (optional: older apps don't send it).
  const timelineId = typeof video.timelineId === 'string' && ID.test(video.timelineId) ? { timelineId: video.timelineId } : {};
  return { path, mime, fps, duration, width, height, range: r, ...timelineId };
}

export class ReviewService {
  /** puter: the owner's Puter client (me.puter in the worker). */
  constructor(puter, { now = () => Date.now() } = {}) {
    this.puter = puter;
    this.kv = puter.kv;
    this.now = now;
    this._owner = null;
    this._minting = new Map();
  }

  async owner() {
    this._owner ??= this.puter.auth.getUser().then(
      (u) => ({ uuid: u.uuid, username: u.username }),
      (err) => {
        this._owner = null;
        throw err;
      },
    );
    return this._owner;
  }

  /** Read many keys at once (in batches); missing keys come back null. */
  async many(keys) {
    const out = [];
    for (let i = 0; i < keys.length; i += LIMITS.syncBatch) {
      const part = keys.slice(i, i + LIMITS.syncBatch);
      if (!part.length) continue;
      const values = await this.kv.get(part);
      out.push(...(Array.isArray(values) ? values : part.map(() => null)));
    }
    return out;
  }

  /** Count an event in a window; true while within limit. The key expires with the window. */
  async bump(key, limit, seconds) {
    const n = await this.kv.incr(key);
    if (n === 1) {
      try {
        await this.kv.expire?.(key, seconds);
      } catch {
        /* the count still works; the key just stays */
      }
    }
    return n <= limit;
  }

  /** The caller's role in a review, or a 403/404. */
  async access(rid, user) {
    const meta = await this.kv.get(`vsr:r:${rid}`);
    if (!meta) fail(404, 'This review no longer exists.');
    const owner = await this.owner();
    if (user.uuid === owner.uuid) return { meta, role: 'owner' };
    const member = await this.ensureMemberIndexed(rid, memberState(await this.kv.get(`vsr:r:${rid}:m:${user.uuid}`)));
    if (!member || member.removed) fail(403, 'You do not have access to this review. Ask the owner for an invite link.');
    return { meta, role: memberValue(member, 'role'), member };
  }

  async versions(rid) {
    const count = (await this.kv.get(`vsr:r:${rid}:vseq`)) || 0;
    return (await this.many(range(1, count).map((n) => `vsr:r:${rid}:v:${n}`))).filter(Boolean);
  }

  /** What a member sees of a review. Paths stay with the worker; ranges and timelines only go to the owner. */
  async view(rid, role, user, meta = null) {
    meta ||= await this.kv.get(`vsr:r:${rid}`);
    const owner = await this.owner();
    const versions = (await this.versions(rid)).map((v) => ({
      n: v.n, title: v.title, created: v.created, fps: v.fps, duration: v.duration, width: v.width, height: v.height, size: v.size, mime: v.mime,
      ...(role === 'owner' ? { range: v.range, ...(v.timelineId ? { timelineId: v.timelineId } : {}) } : {}),
    }));
    return {
      id: rid, title: meta.title, created: meta.created, updated: meta.updated, owner: { username: owner.username },
      ...(role === 'owner' ? { projectId: meta.projectId } : {}),
      versions, role, me: { uuid: user.uuid, username: user.username },
    };
  }

  async call(user, input) {
    if (!input || typeof input !== 'object' || typeof input.op !== 'string') fail(400, 'Invalid request.');
    const op = input.op;
    switch (op) {
      case 'review.find': return this.find(user, input);
      case 'review.publish': return this.publish(user, input);
      case 'review.get': {
        const rid = reviewId(input.review);
        const { meta, role } = await this.access(rid, user);
        return { review: await this.view(rid, role, user, meta) };
      }
      case 'join': return this.join(user, input);
      case 'video.url': return this.videoURL(user, input);
      case 'sync': return this.sync(user, input);
      case 'comment.add': return this.addComment(user, input);
      case 'comment.edit':
      case 'comment.delete':
      case 'comment.resolve': return this.changeComment(user, input);
      case 'invite.create': return this.createInvite(user, input);
      case 'invite.list': return this.listInvites(user, input);
      case 'invite.revoke': return this.revokeInvite(user, input);
      case 'members': return this.members(user, input);
      case 'member.role': return this.setRole(user, input);
      case 'member.remove': return this.removeMember(user, input);
      default: return fail(400, 'Unknown operation.');
    }
  }

  async requireOwner(user) {
    const owner = await this.owner();
    if (user.uuid !== owner.uuid) fail(403, 'Only the owner can do that.');
    return owner;
  }

  /* Owner: publishing -------------------------------------------------------- */

  async find(user, input) {
    await this.requireOwner(user);
    if (typeof input.projectId !== 'string' || !ID.test(input.projectId)) fail(400, 'Invalid project.');
    const rid = await this.kv.get(`vsr:project:${input.projectId}`);
    if (!rid || !(await this.kv.get(`vsr:r:${rid}`))) return { review: null };
    return { review: await this.view(rid, 'owner', user) };
  }

  async publish(user, input) {
    await this.requireOwner(user);
    if (typeof input.clientId !== 'string' || !ID.test(input.clientId)) fail(400, 'Invalid request id.');
    if (typeof input.projectId !== 'string' || !ID.test(input.projectId)) fail(400, 'Invalid project.');
    const done = await this.kv.get(`vsr:pub:${input.clientId}`);
    if (done) return { review: await this.view(done.review, 'owner', user), version: done.version };
    const video = validateVideo(input.video);
    let file;
    try {
      file = await this.puter.fs.stat(video.path);
    } catch {
      fail(400, 'The review video could not be found in your files.');
    }
    if (!file || file.is_dir || !(file.size > 0)) fail(400, 'The review video could not be found in your files.');
    if (file.size > LIMITS.videoBytes) fail(413, 'Review videos can be at most 4 GB.');
    const now = this.now();
    const title = cleanTitle(input.title);
    let rid = await this.kv.get(`vsr:project:${input.projectId}`);
    let meta = rid ? await this.kv.get(`vsr:r:${rid}`) : null;
    if (!meta) {
      rid = randomId('r');
      meta = { id: rid, title, projectId: input.projectId, owner: user.uuid, created: now, updated: now };
      await this.kv.set(`vsr:r:${rid}`, meta);
      await this.kv.set(`vsr:project:${input.projectId}`, rid);
    }
    const count = (await this.kv.get(`vsr:r:${rid}:vseq`)) || 0;
    const full = () => fail(409, `A review can have at most ${LIMITS.versions} versions. Share as a new project to start over.`);
    if (count >= LIMITS.versions) full();
    const n = await this.kv.incr(`vsr:r:${rid}:vseq`);
    if (n > LIMITS.versions) {
      // No version uses this reservation. Return it so sync does not keep
      // announcing a nonexistent version after a concurrent limit rejection.
      await this.kv.incr(`vsr:r:${rid}:vseq`, -1).catch(() => {});
      full();
    }
    await this.kv.set(`vsr:r:${rid}:v:${n}`, { n, ...video, size: file.size, title, created: now });
    meta = { ...meta, title, updated: now };
    await this.kv.set(`vsr:r:${rid}`, meta);
    await this.kv.set(`vsr:pub:${input.clientId}`, { review: rid, version: n });
    return { review: await this.view(rid, 'owner', user, meta), version: n };
  }

  /* Joining and access --------------------------------------------------------- */

  async join(user, input, retried = false) {
    const rid = reviewId(input.review);
    const meta = await this.kv.get(`vsr:r:${rid}`);
    if (!meta) fail(404, 'This review no longer exists.');
    const owner = await this.owner();
    if (user.uuid === owner.uuid) return { review: await this.view(rid, 'owner', user, meta) };
    let existing = memberState(await this.kv.get(`vsr:r:${rid}:m:${user.uuid}`));
    existing = await this.ensureMemberIndexed(rid, existing);
    const validToken = typeof input.token === 'string' && TOKEN.test(input.token);
    const tokenHash = validToken ? await hash(input.token) : null;
    if (existing && !existing.removed) {
      // A member is let in with any link, even the one they joined with after it
      // expired or was turned off. A link never lowers a role; a working commenter link raises a viewer.
      if (validToken && memberValue(existing, 'role') === 'viewer') {
        const invite = await this.kv.get(`vsr:invite:${tokenHash}`);
        if (invite?.review === rid && invite.role === 'commenter' && !invite.revoked && invite.expires > this.now() && !inviteBlocked(existing, invite)) {
          const next = memberState(await this.kv.update(`vsr:r:${rid}:m:${user.uuid}`, {
            [memberField(existing, 'role')]: 'commenter',
            [memberField(existing, 'username')]: user.username,
          }));
          if (next.removed) fail(403, 'The owner removed you from this review. Ask them for a new link.');
          if (next.invite !== existing.invite) fail(409, 'Membership changed while joining. Try again.');
          return { review: await this.view(rid, memberValue(next, 'role'), user, meta) };
        }
      }
      return { review: await this.view(rid, memberValue(existing, 'role'), user, meta) };
    }
    const failKey = `vsr:joinfail:${user.uuid}:${Math.floor(this.now() / 600_000)}`;
    if (((await this.kv.get(failKey)) || 0) >= LIMITS.failedJoins) fail(429, 'Too many attempts with links that do not work. Try again in a few minutes.');
    const refuse = async (message) => {
      await this.bump(failKey, Infinity, 1200);
      fail(403, message);
    };
    if (!validToken) return refuse('This invite link is not valid. Ask the owner for a new one.');
    const invite = await this.kv.get(`vsr:invite:${tokenHash}`);
    if (!invite || invite.review !== rid) return refuse('This invite link is not valid. Ask the owner for a new one.');
    if (invite.revoked) return refuse('This invite link was turned off. Ask the owner for a new one.');
    if (invite.expires <= this.now()) return refuse('This invite link has expired. Ask the owner for a new one.');
    // Invites made by older workers lack their list ordinal. Recover it only
    // when such an invite is used to rejoin; normal polling needs no extra read.
    if (existing && !invite.n) {
      invite.legacy = true;
      invite.n = (await this.inviteRecords(rid)).find((entry) => entry.hash === tokenHash)?.n;
      if (!invite.n) fail(409, 'This invite is not ready. Try again.');
    }
    if (inviteBlocked(existing, invite)) fail(403, 'The owner removed you from this review. Ask them for a new link.');
    // People removed from the review don't count against its limit; someone removed coming back with a new link
    // does. Everyone who ever joined stays on the list, so the list itself is capped too.
    const index = await this.memberIndex(rid);
    const joinedEver = index.count + index.uuids.length;
    const full = () => fail(403, 'This review has reached its limit of people.');
    if (!existing && !index.uuids.includes(user.uuid) && joinedEver >= LIMITS.members * MEMBER_LIST_FACTOR) full();
    if (joinedEver >= LIMITS.members && (await this.memberRecords(rid)).filter((m) => !m.removed).length >= LIMITS.members) full();
    // Persist the directory first. Retrying either write reuses the same UUID
    // entry, and a failed membership write leaves no undiscoverable access.
    if (!existing) await this.indexMember(rid, user.uuid);
    let member = { uuid: user.uuid, username: user.username, indexed: true, role: invite.role, joined: this.now(), invite: invite.id, inviteN: invite.n || 0,
      ...(invite.legacy ? { legacy: true } : {}) };
    const key = `vsr:r:${rid}:m:${user.uuid}`;
    const written = existing
      ? await this.kv.update(key, { hasGrants: true, [`grant_${invite.id}`]: member })
      : await this.kv.set(key, member, { onlyIfAbsent: true });
    if (!written) {
      // Another tab joined first. Recheck membership, removals and the invite;
      // a stale first join must never replace that tab's saved membership.
      if (retried) fail(409, 'Membership changed while joining. Try again.');
      return this.join(user, input, true);
    }
    if (existing) {
      member = memberState(written);
      if (member.removed) fail(403, 'The owner removed you from this review. Ask them for a new link.');
    }
    await this.kv.incr(`vsr:invite:${tokenHash}`, { uses: 1 }).catch(() => {});
    return { review: await this.view(rid, memberValue(member, 'role'), user, meta) };
  }

  async createInvite(user, input) {
    await this.requireOwner(user);
    const rid = reviewId(input.review);
    if (!(await this.kv.get(`vsr:r:${rid}`))) fail(404, 'This review no longer exists.');
    const role = GUEST_ROLES.includes(input.role) ? input.role : fail(400, 'Invalid role.');
    const count = (await this.kv.get(`vsr:r:${rid}:iseq`)) || 0;
    if (count >= LIMITS.invites) fail(409, `A review can have at most ${LIMITS.invites} invite links.`);
    const token = inviteToken();
    const tokenHash = await hash(token);
    const now = this.now();
    const n = await this.kv.incr(`vsr:r:${rid}:iseq`);
    if (n > LIMITS.invites) fail(409, `A review can have at most ${LIMITS.invites} invite links.`);
    const invite = { review: rid, id: tokenHash.slice(0, 16), n, role, created: now, expires: now + inviteDays(input.days) * DAY, revoked: false, uses: 0 };
    await this.kv.set(`vsr:invite:${tokenHash}`, invite);
    await this.kv.set(`vsr:r:${rid}:ii:${n}`, tokenHash);
    return { token, invite: this.inviteView(invite) };
  }

  inviteView(i) {
    return { id: i.id, role: i.role, created: i.created, expires: i.expires, revoked: Boolean(i.revoked), expired: i.expires <= this.now(), uses: i.uses || 0 };
  }

  async inviteRecords(rid) {
    const count = (await this.kv.get(`vsr:r:${rid}:iseq`)) || 0;
    const indexed = (await this.many(range(1, count).map((n) => `vsr:r:${rid}:ii:${n}`)))
      .map((hash, i) => ({ hash, n: i + 1 })).filter((entry) => typeof entry.hash === 'string');
    const invites = await this.many(indexed.map((entry) => `vsr:invite:${entry.hash}`));
    return indexed.map((entry, i) => ({ ...entry, invite: invites[i] })).filter((entry) => entry.invite);
  }

  async listInvites(user, input) {
    await this.requireOwner(user);
    const rid = reviewId(input.review);
    return { invites: (await this.inviteRecords(rid)).map((x) => this.inviteView(x.invite)).reverse() };
  }

  async revokeInvite(user, input) {
    await this.requireOwner(user);
    const rid = reviewId(input.review);
    const found = (await this.inviteRecords(rid)).find((x) => x.invite.id === input.invite);
    if (!found) fail(404, 'That invite link no longer exists.');
    const next = await this.kv.update(`vsr:invite:${found.hash}`, { revoked: true });
    return { invite: this.inviteView(next) };
  }

  async ensureMemberIndexed(rid, member) {
    if (!member || member.indexed) return member;
    // Older workers granted access before writing the list entry. Repair it on
    // the caller's next visit, preserving concurrent permission changes.
    const index = await this.memberIndex(rid);
    const listed = index.uuids.includes(member.uuid) || (await this.legacyMemberIds(rid, index.count)).includes(member.uuid);
    if (!listed) await this.indexMember(rid, member.uuid);
    return memberState(await this.kv.update(`vsr:r:${rid}:m:${member.uuid}`, { indexed: true }));
  }

  async memberIndex(rid) {
    const [count, directory] = await this.kv.get([`vsr:r:${rid}:mseq`, `vsr:r:${rid}:mdir`]);
    return { count: count || 0, uuids: Object.values(directory || {}).filter((v) => typeof v === 'string') };
  }

  async legacyMemberIds(rid, count) {
    return (await this.many(range(1, count).map((n) => `vsr:r:${rid}:mi:${n}`))).filter((v) => typeof v === 'string');
  }

  async indexMember(rid, uuid) {
    // Escape underscores too, so punctuation cannot collide with an existing
    // escape or become a KV update path. This needs no extra cryptographic work.
    const field = `member_${uuid.replace(/[^a-zA-Z0-9]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`)}`;
    await this.kv.update(`vsr:r:${rid}:mdir`, { [field]: uuid });
  }

  async memberRecords(rid) {
    const index = await this.memberIndex(rid);
    const legacy = [...new Set(await this.legacyMemberIds(rid, index.count))];
    const seen = new Set(legacy);
    const uuids = [...legacy, ...index.uuids.filter((uuid) => !seen.has(uuid))];
    const records = await this.many(uuids.map((u) => `vsr:r:${rid}:m:${u}`));
    // Preserve the old list order. A KV map has no ordering guarantee, so new
    // entries use their base grant's join time, unchanged by later rejoins.
    const recent = records.slice(legacy.length).filter(Boolean)
      .sort((a, b) => a.joined - b.joined || a.uuid.localeCompare(b.uuid));
    return [...records.slice(0, legacy.length).filter(Boolean), ...recent].map(memberState);
  }

  async members(user, input) {
    await this.requireOwner(user);
    const rid = reviewId(input.review);
    const list = (await this.memberRecords(rid)).filter((m) => !m.removed);
    return { members: list.map((m) => ({ uuid: m.uuid, username: memberValue(m, 'username'), role: memberValue(m, 'role'), joined: m.joined })) };
  }

  async setRole(user, input) {
    await this.requireOwner(user);
    const rid = reviewId(input.review);
    const role = GUEST_ROLES.includes(input.role) ? input.role : fail(400, 'Invalid role.');
    const key = `vsr:r:${rid}:m:${input.uuid}`;
    const m = typeof input.uuid === 'string' && input.uuid.length <= 64 ? memberState(await this.kv.get(key)) : null;
    if (!m || m.removed) fail(404, 'That person is not in this review.');
    // Updating only the role cannot erase a removal saved since the read above.
    const saved = memberState(await this.kv.update(key, { [memberField(m, 'role')]: role }));
    if (saved.removed) fail(404, 'That person is not in this review.');
    if (saved.invite !== m.invite) fail(409, 'Membership changed. Refresh and try again.');
    return { member: { uuid: saved.uuid, username: memberValue(saved, 'username'), role: memberValue(saved, 'role'), joined: saved.joined } };
  }

  async removeMember(user, input) {
    await this.requireOwner(user);
    const rid = reviewId(input.review);
    const key = `vsr:r:${rid}:m:${input.uuid}`;
    const [record, count] = typeof input.uuid === 'string' && input.uuid.length <= 64
      ? await this.kv.get([key, `vsr:r:${rid}:iseq`]) : [null, 0];
    const m = memberState(record);
    if (!m) fail(404, 'That person is not in this review.');
    if (!m.removed) {
      const fields = { removed: this.now(), blockLegacy: true };
      for (let n = 1; n <= Math.min(count || 0, LIMITS.invites); n++) fields[`blocked_${n}`] = true;
      // Reclaim old grant payloads in this same write. A late rejoin may recreate
      // one, but its revocation flag remains and keeps it unusable.
      for (const field of Object.keys(record)) if (field.startsWith('grant_')) fields[field] = null;
      await this.kv.update(key, fields);
    }
    // Video links already handed out stop working at once where Puter lets the
    // worker revoke them; new links are made for everyone else on demand.
    await this.dropVideoLinks(rid);
    return { ok: true };
  }

  /* Video ------------------------------------------------------------------------ */

  async dropVideoLinks(rid) {
    const count = (await this.kv.get(`vsr:r:${rid}:vseq`)) || 0;
    const keys = range(1, count).map((n) => `vsr:r:${rid}:url:${n}`);
    const links = await this.many(keys);
    await Promise.all(links.map(async (link, i) => {
      if (!link) return;
      try {
        await this.puter.fs.revokeReadURL?.(link.url);
      } catch {
        /* expires on its own */
      }
      await this.kv.del(keys[i]).catch(() => {});
    }));
  }

  async videoURL(user, input) {
    const rid = reviewId(input.review);
    await this.access(rid, user);
    const n = int(input.version);
    const v = Number.isInteger(n) && n > 0 ? await this.kv.get(`vsr:r:${rid}:v:${n}`) : null;
    if (!v) fail(404, 'That version does not exist.');
    const key = `vsr:r:${rid}:url:${n}`;
    const cached = await this.kv.get(key);
    if (cached && cached.expires - VIDEO_LINK_RENEW_MS > this.now()) return { url: cached.url, expires: cached.expires, mime: v.mime };
    // Read links are rate limited by Puter, so one instance makes one at a time per video.
    let pending = this._minting.get(key);
    if (!pending) {
      pending = (async () => {
        const expires = this.now() + VIDEO_LINK_HOURS * 3_600_000;
        const url = await this.puter.fs.getReadURL(v.path, `${VIDEO_LINK_HOURS}h`);
        const link = { url, expires };
        await this.kv.set(key, link);
        return link;
      })().finally(() => this._minting.delete(key));
      this._minting.set(key, pending);
    }
    try {
      const link = await pending;
      return { url: link.url, expires: link.expires, mime: v.mime };
    } catch {
      return fail(503, 'The video is not available right now. Try again in a few minutes.');
    }
  }

  /* Comments ---------------------------------------------------------------------- */

  /**
   * Changes after `since`, in order. The cursor stops at a change still being
   * written (its number is taken but its record is not there yet) unless a
   * later change is old enough to skip it. Persisting that decision lets a
   * delayed writer detect it and deliver at a fresh cursor before succeeding.
   */
  async sync(user, input) {
    const rid = reviewId(input.review);
    const { meta, role } = await this.access(rid, user);
    const since = Math.max(0, int(input.since) || 0);
    const seq = (await this.kv.get(`vsr:r:${rid}:seq`)) || 0;
    const upto = Math.min(seq, since + LIMITS.syncBatch);
    const entries = upto > since ? await this.many(range(since + 1, upto).map((n) => `vsr:r:${rid}:log:${n}`)) : [];
    const changes = [];
    let cursor = since;
    let blocked = false;
    for (let i = 0; i < entries.length; i++) {
      let e = entries[i];
      if (!e) {
        const later = entries.slice(i + 1).find(Boolean);
        if (later && this.now() - later.at > LOST_CHANGE_MS) {
          // If the writer finished since our read, include its returned
          // snapshot. Otherwise it will see this marker when it finishes.
          e = await this.kv.update(`vsr:r:${rid}:log:${since + i + 1}`, { at: this.now(), skip: true });
        } else {
          blocked = true;
          break;
        }
      }
      cursor = since + i + 1;
      if (e.comment) changes.push(e.comment);
    }
    const versions = (await this.kv.get(`vsr:r:${rid}:vseq`)) || 0;
    return { changes, cursor, more: !blocked && cursor < seq, role, updated: meta.updated, versions };
  }

  async record(rid, comment) {
    const n = await this.kv.incr(`vsr:r:${rid}:seq`);
    const saved = { ...comment, seq: n };
    try {
      await this.kv.set(`vsr:r:${rid}:c:${comment.id}`, saved);
    } catch (err) {
      await this.skipChange(rid, n);
      throw err;
    }
    const delivered = await this.deliverComment(rid, saved, n);
    if (delivered !== n) await this.recoveredChange(rid, n, delivered);
    return saved;
  }

  async deliverComment(rid, comment, n) {
    for (let attempt = 0; attempt < LOG_DELIVERY_ATTEMPTS; attempt++) {
      let entry;
      try {
        entry = await this.kv.update(`vsr:r:${rid}:log:${n}`, { at: this.now(), comment });
      } catch (err) {
        await this.skipChange(rid, n);
        throw err;
      }
      if (!entry.skip) return n;
      // A reader already passed this slot. The original revision still wins
      // only over older snapshots, even when delivered at a newer cursor.
      if (attempt + 1 < LOG_DELIVERY_ATTEMPTS) n = await this.kv.incr(`vsr:r:${rid}:seq`);
    }
    fail(503, 'Your comment was saved, but some reviewers may not see it yet. Try again.', COMMENT_DELIVERY_PENDING);
  }

  async skipChange(rid, n) {
    // A write can succeed before its acknowledgement is lost. A partial marker
    // must not erase a snapshot (or recovery receipt) already stored here.
    await this.kv.update(`vsr:r:${rid}:log:${n}`, { at: this.now(), skip: true }).catch(() => {});
  }

  async recoverComment(rid, comment, user) {
    const key = `vsr:r:${rid}:log:${comment.seq}`;
    const logged = await this.kv.get(key);
    if (logged?.recovered || (!logged?.skip && logged?.comment?.id === comment.id && logged.comment.seq === comment.seq)) return comment;
    // Bound repeated deliveries if receipt writes keep failing. This separate
    // budget still lets the last permitted edit recover immediately.
    const minute = Math.floor(this.now() / 60_000);
    if (!(await this.bump(`vsr:rrate:${rid}:${user.uuid}:${minute}`, LIMITS.changesPerMinute, 120))) fail(429, 'You are retrying comments very quickly. Wait a moment and try again.');
    // Other clients may already have passed the missing/skipped entry. Deliver
    // the snapshot at a new cursor but retain its original revision, so it
    // cannot replace a newer edit/delete. Never rewrite the canonical comment.
    // Recovery of an accepted change is allowed even when new changes are full.
    const n = await this.deliverComment(rid, comment, await this.kv.incr(`vsr:r:${rid}:seq`));
    // Only acknowledge recovery after its delivery is durable. Failure to save
    // this receipt can cause a repeated delivery, which clients deduplicate.
    await this.recoveredChange(rid, comment.seq, n);
    return comment;
  }

  async recoveredChange(rid, revision, delivered) {
    await this.kv.update(`vsr:r:${rid}:log:${revision}`, { at: this.now(), skip: true, recovered: delivered }).catch(() => {});
  }

  async roomForChange(rid) {
    const seq = (await this.kv.get(`vsr:r:${rid}:seq`)) || 0;
    if (seq >= LIMITS.changesPerReview) fail(409, 'This review has reached its limit of comments.');
  }

  /** Room for one more change to a comment by this person this minute (a change that changes nothing is free). */
  async roomForEdit(rid, user) {
    await this.roomForChange(rid);
    const minute = Math.floor(this.now() / 60_000);
    if (!(await this.bump(`vsr:wrate:${rid}:${user.uuid}:${minute}`, LIMITS.changesPerMinute, 120))) fail(429, 'You are changing comments very quickly. Wait a moment and try again.');
  }

  async addComment(user, input) {
    const rid = reviewId(input.review);
    const { role } = await this.access(rid, user);
    if (!canComment(role)) fail(403, 'You can watch this review but not comment.');
    const n = int(input.version);
    const version = Number.isInteger(n) && n > 0 ? await this.kv.get(`vsr:r:${rid}:v:${n}`) : null;
    const check = validateComment(input, version);
    if (!check.ok) fail(version ? 400 : 404, check.error);
    const value = check.value;
    const existing = await this.kv.get(`vsr:r:${rid}:c:${value.id}`);
    if (existing) {
      // A retry of a comment that was saved: hand back what was saved.
      if (existing.author?.uuid === user.uuid) return { comment: await this.recoverComment(rid, existing, user) };
      fail(409, 'That comment id is taken.');
    }
    if (value.parent) {
      const parent = await this.kv.get(`vsr:r:${rid}:c:${value.parent}`);
      if (!parent || parent.parent || parent.version !== value.version) fail(404, 'The comment you replied to no longer exists.');
      if (parent.deleted) fail(409, 'The comment you replied to was deleted.');
    }
    await this.roomForChange(rid);
    const minute = Math.floor(this.now() / 60_000);
    if (!(await this.bump(`vsr:rate:${rid}:${user.uuid}:${minute}`, LIMITS.commentsPerMinute, 120))) fail(429, 'You are commenting very quickly. Wait a moment and try again.');
    const comment = {
      ...value,
      author: { uuid: user.uuid, username: user.username },
      created: this.now(),
      edited: null,
      resolved: false,
      resolvedBy: null,
      deleted: false,
    };
    return { comment: await this.record(rid, comment) };
  }

  async changeComment(user, input) {
    const rid = reviewId(input.review);
    const { role } = await this.access(rid, user);
    if (typeof input.id !== 'string' || !ID.test(input.id)) fail(400, 'Invalid comment.');
    const c = await this.kv.get(`vsr:r:${rid}:c:${input.id}`);
    if (!c) fail(404, 'That comment no longer exists.');
    const mine = c.author?.uuid === user.uuid;
    if (input.op === 'comment.edit') {
      if (!mine || !canComment(role)) fail(403, 'You can only edit your own comments.');
      if (c.deleted) fail(409, 'That comment was deleted.');
      const problem = textProblem(input.text);
      if (problem) fail(400, problem);
      const text = cleanText(input.text);
      if (text === c.text) return { comment: await this.recoverComment(rid, c, user) };
      await this.roomForEdit(rid, user);
      return { comment: await this.record(rid, { ...c, text, edited: this.now() }) };
    }
    if (input.op === 'comment.delete') {
      if (!(mine && canComment(role)) && role !== 'owner') fail(403, 'You can only delete your own comments.');
      if (c.deleted) return { comment: await this.recoverComment(rid, c, user) };
      await this.roomForEdit(rid, user);
      return { comment: await this.record(rid, { ...c, text: '', deleted: true, edited: this.now() }) };
    }
    if (!canResolve(role)) fail(403, 'You can watch this review but not resolve comments.');
    if (c.parent) fail(400, 'Only whole threads can be resolved.');
    const resolved = input.resolved !== false;
    if (Boolean(c.resolved) === resolved) return { comment: await this.recoverComment(rid, c, user) };
    await this.roomForEdit(rid, user);
    return { comment: await this.record(rid, { ...c, resolved, resolvedBy: resolved ? { uuid: user.uuid, username: user.username } : null }) };
  }
}

