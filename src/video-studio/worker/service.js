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
 *   vsr:r:<rid>:m:<uuid>             { uuid, username, role, joined, invite, removed? }
 *   vsr:r:<rid>:mseq / :mi:<n>       join order -> uuid (the member list)
 *   vsr:invite:<sha256(token)>       { review, id, role, created, expires, revoked, uses }
 *   vsr:r:<rid>:iseq / :ii:<n>       invite order -> token hash (the invite list)
 *   vsr:r:<rid>:seq                  change counter for comments
 *   vsr:r:<rid>:log:<n>              { at, comment } comment snapshot saved as change n
 *   vsr:r:<rid>:c:<commentId>        latest snapshot of a comment
 *   vsr:rate:<rid>:<uuid>:<minute>   comments posted this minute (expires)
 *   vsr:joinfail:<uuid>:<window>     failed joins in a 10 minute window (expires)
 */
import {
  ID, TOKEN, LIMITS, DAY, GUEST_ROLES, canComment, canResolve, hash, randomId, inviteToken,
  validateComment, textProblem, cleanText, cleanTitle, inviteDays,
} from '../src/review/protocol.js';

/** How long a video read link lives, and how much of that is left when a new one is made. */
export const VIDEO_LINK_HOURS = 4;
export const VIDEO_LINK_RENEW_MS = 30 * 60_000;
/** A missing change older than this (judged by a later one) was lost, not in flight. */
export const LOST_CHANGE_MS = 60_000;

const VIDEO_MIME = ['video/mp4', 'video/webm', 'video/quicktime'];

export function fail(status, message) {
  throw Object.assign(new Error(message), { status });
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
    const member = await this.kv.get(`vsr:r:${rid}:m:${user.uuid}`);
    if (!member || member.removed) fail(403, 'You do not have access to this review. Ask the owner for an invite link.');
    return { meta, role: member.role, member };
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
    if (count >= LIMITS.versions) fail(409, `A review can have at most ${LIMITS.versions} versions. Share as a new project to start over.`);
    const n = await this.kv.incr(`vsr:r:${rid}:vseq`);
    await this.kv.set(`vsr:r:${rid}:v:${n}`, { n, ...video, size: file.size, title, created: now });
    meta = { ...meta, title, updated: now };
    await this.kv.set(`vsr:r:${rid}`, meta);
    await this.kv.set(`vsr:pub:${input.clientId}`, { review: rid, version: n });
    return { review: await this.view(rid, 'owner', user, meta), version: n };
  }

  /* Joining and access --------------------------------------------------------- */

  async join(user, input) {
    const rid = reviewId(input.review);
    const meta = await this.kv.get(`vsr:r:${rid}`);
    if (!meta) fail(404, 'This review no longer exists.');
    const owner = await this.owner();
    if (user.uuid === owner.uuid) return { review: await this.view(rid, 'owner', user, meta) };
    const existing = await this.kv.get(`vsr:r:${rid}:m:${user.uuid}`);
    const validToken = typeof input.token === 'string' && TOKEN.test(input.token);
    const tokenHash = validToken ? await hash(input.token) : null;
    if (existing && !existing.removed) {
      // A member is let in with any link, even the one they joined with after it
      // expired or was turned off. A link never lowers a role; a working commenter link raises a viewer.
      if (validToken && existing.role === 'viewer') {
        const invite = await this.kv.get(`vsr:invite:${tokenHash}`);
        if (invite?.review === rid && invite.role === 'commenter' && !invite.revoked && invite.expires > this.now()) {
          const next = { ...existing, role: 'commenter', username: user.username };
          await this.kv.set(`vsr:r:${rid}:m:${user.uuid}`, next);
          return { review: await this.view(rid, next.role, user, meta) };
        }
      }
      return { review: await this.view(rid, existing.role, user, meta) };
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
    if (existing?.removed && invite.created <= existing.removed) fail(403, 'The owner removed you from this review. Ask them for a new link.');
    if (!existing) {
      const count = (await this.kv.get(`vsr:r:${rid}:mseq`)) || 0;
      if (count >= LIMITS.members) fail(403, 'This review has reached its limit of people.');
    }
    const member = { uuid: user.uuid, username: user.username, role: invite.role, joined: this.now(), invite: invite.id };
    await this.kv.set(`vsr:r:${rid}:m:${user.uuid}`, member);
    if (!existing) {
      const n = await this.kv.incr(`vsr:r:${rid}:mseq`);
      await this.kv.set(`vsr:r:${rid}:mi:${n}`, user.uuid);
    }
    await this.kv.set(`vsr:invite:${tokenHash}`, { ...invite, uses: (invite.uses || 0) + 1 }).catch(() => {});
    return { review: await this.view(rid, member.role, user, meta) };
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
    const invite = { review: rid, id: tokenHash.slice(0, 16), role, created: now, expires: now + inviteDays(input.days) * DAY, revoked: false, uses: 0 };
    await this.kv.set(`vsr:invite:${tokenHash}`, invite);
    const n = await this.kv.incr(`vsr:r:${rid}:iseq`);
    await this.kv.set(`vsr:r:${rid}:ii:${n}`, tokenHash);
    return { token, invite: this.inviteView(invite) };
  }

  inviteView(i) {
    return { id: i.id, role: i.role, created: i.created, expires: i.expires, revoked: Boolean(i.revoked), expired: i.expires <= this.now(), uses: i.uses || 0 };
  }

  async inviteRecords(rid) {
    const count = (await this.kv.get(`vsr:r:${rid}:iseq`)) || 0;
    const hashes = (await this.many(range(1, count).map((n) => `vsr:r:${rid}:ii:${n}`))).filter((x) => typeof x === 'string');
    const invites = await this.many(hashes.map((x) => `vsr:invite:${x}`));
    return hashes.map((h, i) => ({ hash: h, invite: invites[i] })).filter((x) => x.invite);
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
    const next = { ...found.invite, revoked: true };
    await this.kv.set(`vsr:invite:${found.hash}`, next);
    return { invite: this.inviteView(next) };
  }

  async memberRecords(rid) {
    const count = (await this.kv.get(`vsr:r:${rid}:mseq`)) || 0;
    const uuids = [...new Set((await this.many(range(1, count).map((n) => `vsr:r:${rid}:mi:${n}`))).filter((x) => typeof x === 'string'))];
    return (await this.many(uuids.map((u) => `vsr:r:${rid}:m:${u}`))).filter(Boolean);
  }

  async members(user, input) {
    await this.requireOwner(user);
    const rid = reviewId(input.review);
    const list = (await this.memberRecords(rid)).filter((m) => !m.removed);
    return { members: list.map((m) => ({ uuid: m.uuid, username: m.username, role: m.role, joined: m.joined })) };
  }

  async setRole(user, input) {
    await this.requireOwner(user);
    const rid = reviewId(input.review);
    const role = GUEST_ROLES.includes(input.role) ? input.role : fail(400, 'Invalid role.');
    const key = `vsr:r:${rid}:m:${input.uuid}`;
    const m = typeof input.uuid === 'string' && input.uuid.length <= 64 ? await this.kv.get(key) : null;
    if (!m || m.removed) fail(404, 'That person is not in this review.');
    await this.kv.set(key, { ...m, role });
    return { member: { uuid: m.uuid, username: m.username, role, joined: m.joined } };
  }

  async removeMember(user, input) {
    await this.requireOwner(user);
    const rid = reviewId(input.review);
    const key = `vsr:r:${rid}:m:${input.uuid}`;
    const m = typeof input.uuid === 'string' && input.uuid.length <= 64 ? await this.kv.get(key) : null;
    if (!m) fail(404, 'That person is not in this review.');
    if (!m.removed) await this.kv.set(key, { ...m, removed: this.now() });
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
   * later change is old enough to show it was lost.
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
      const e = entries[i];
      if (!e) {
        const later = entries.slice(i + 1).find(Boolean);
        if (later && this.now() - later.at > LOST_CHANGE_MS) {
          cursor = since + i + 1;
          continue;
        }
        blocked = true;
        break;
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
      await this.kv.set(`vsr:r:${rid}:log:${n}`, { at: this.now(), comment: saved });
    } catch (err) {
      // Keep the change log without holes others would wait on.
      await this.kv.set(`vsr:r:${rid}:log:${n}`, { at: this.now(), skip: true }).catch(() => {});
      throw err;
    }
    return saved;
  }

  async roomForChange(rid) {
    const seq = (await this.kv.get(`vsr:r:${rid}:seq`)) || 0;
    if (seq >= LIMITS.changesPerReview) fail(409, 'This review has reached its limit of comments.');
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
      if (existing.author?.uuid === user.uuid) return { comment: existing };
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
      if (text === c.text) return { comment: c };
      await this.roomForChange(rid);
      return { comment: await this.record(rid, { ...c, text, edited: this.now() }) };
    }
    if (input.op === 'comment.delete') {
      if (!(mine && canComment(role)) && role !== 'owner') fail(403, 'You can only delete your own comments.');
      if (c.deleted) return { comment: c };
      await this.roomForChange(rid);
      return { comment: await this.record(rid, { ...c, text: '', deleted: true, edited: this.now() }) };
    }
    if (!canResolve(role)) fail(403, 'You can watch this review but not resolve comments.');
    if (c.parent) fail(400, 'Only whole threads can be resolved.');
    const resolved = input.resolved !== false;
    if (Boolean(c.resolved) === resolved) return { comment: c };
    await this.roomForChange(rid);
    return { comment: await this.record(rid, { ...c, resolved, resolvedBy: resolved ? { uuid: user.uuid, username: user.username } : null }) };
  }
}

