/**
 * One open review, from the app's side: the review's details, the caller's
 * role, and its comments kept current by polling the worker for changes
 * since a cursor (the worker's change counter). Polling pauses while the
 * page is hidden and backs off after errors.
 */
import { Emitter } from '../lib/emitter.js';
import { call as callWorker } from './api.js';
import { randomId } from './protocol.js';
import { applyChanges, pendingComment } from './comments.js';

export class ReviewSession extends Emitter {
  constructor({ puter, server, review, call = callWorker, interval = 8000 }) {
    super();
    this.puter = puter;
    this.server = server;
    this.id = review;
    this._call = call;
    this.interval = interval;
    this.review = null;
    this.comments = new Map();
    this.cursor = 0;
    this.versionCount = 0;
    this.error = null;
    this.lastSync = 0;
    this._timer = null;
    this._pollRun = 0;
    this._syncing = null;
    this._failures = 0;
    this._links = new Map();
    this._onVisible = () => {
      if (typeof document !== 'undefined' && !document.hidden && this._timer !== null) this.sync().catch(() => {});
    };
  }

  get role() {
    return this.review?.role || null;
  }

  get me() {
    return this.review?.me || null;
  }

  /** The newest version number. */
  get latest() {
    return this.review?.versions?.at(-1)?.n || 0;
  }

  version(n) {
    return this.review?.versions?.find((v) => v.n === n) || null;
  }

  call(op, fields = {}) {
    return this._call(this.puter, this.server, { op, review: this.id, ...fields });
  }

  /** Join with an invite token (or check membership without one) and load the review. */
  async open({ token = null } = {}) {
    const r = token ? await this.call('join', { token }) : await this.call('review.get');
    this._setReview(r.review);
    await this.sync();
    return this.review;
  }

  _setReview(review) {
    this.review = review;
    this.versionCount = review.versions.length;
    this.emit('review', review);
    this.emit('change');
  }

  async refreshReview() {
    const r = await this.call('review.get');
    this._setReview(r.review);
  }

  /** Fetch every change since the cursor. Concurrent calls share one run. */
  sync() {
    if (!this._syncing) {
      this._syncing = this._sync().finally(() => (this._syncing = null));
    }
    return this._syncing;
  }

  async _sync() {
    try {
      let changed = false;
      for (let i = 0; i < 50; i++) {
        const r = await this.call('sync', { since: this.cursor });
        if (applyChanges(this.comments, r.changes)) changed = true;
        this.cursor = Math.max(this.cursor, r.cursor);
        if (this.review && r.role !== this.review.role) await this.refreshReview();
        else if (this.review && r.versions !== this.versionCount) await this.refreshReview();
        if (!r.more) break;
      }
      this.error = null;
      this._failures = 0;
      this.lastSync = Date.now();
      if (changed) this.emit('change');
      this.emit('synced');
    } catch (err) {
      this.error = err;
      this._failures++;
      this.emit('error', err);
      throw err;
    }
  }

  /** Poll while started. */
  start(interval = this.interval) {
    this.interval = interval;
    if (this._timer !== null) return;
    const run = ++this._pollRun;
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this._onVisible);
    const tick = () => {
      // Back off after failures (up to 8 times the interval); skip while hidden.
      const delay = this.interval * Math.min(8, 2 ** this._failures);
      this._timer = setTimeout(async () => {
        if (run !== this._pollRun) return;
        if (typeof document === 'undefined' || !document.hidden) await this.sync().catch(() => {});
        if (run === this._pollRun) tick();
      }, delay);
    };
    tick();
  }

  stop() {
    this._pollRun++;
    clearTimeout(this._timer);
    this._timer = null;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this._onVisible);
  }

  get polling() {
    return this._timer !== null;
  }

  async _send(op, fields) {
    try {
      return await this.call(op, fields);
    } catch (err) {
      // A lost answer is retried once: every write is safe to repeat.
      if (err.status) throw err;
      return this.call(op, fields);
    }
  }

  /** Post a comment or reply. It shows at once and is replaced by the saved copy. */
  async addComment({ version, parent = null, text, t = null, end = null }) {
    const id = randomId('c');
    const local = pendingComment({ id, version, parent, text, t, end }, this.me || { uuid: '', username: '' });
    this.comments.set(id, local);
    this.emit('change');
    try {
      const r = await this._send('comment.add', { id, version, parent, text, t, end });
      this.comments.set(id, r.comment);
      this.emit('change');
      return r.comment;
    } catch (err) {
      if (this.comments.get(id)?.pending) this.comments.delete(id);
      this.emit('change');
      throw err;
    }
  }

  async _change(op, fields) {
    const r = await this._send(op, fields);
    applyChanges(this.comments, [r.comment]);
    this.emit('change');
    return r.comment;
  }

  editComment(id, text) {
    return this._change('comment.edit', { id, text });
  }

  deleteComment(id) {
    return this._change('comment.delete', { id });
  }

  resolve(id, resolved = true) {
    return this._change('comment.resolve', { id, resolved });
  }

  /** A read link for a version's video, reused until shortly before it expires. */
  async videoLink(version, { fresh = false } = {}) {
    const cached = this._links.get(version);
    if (!fresh && cached && cached.expires - 5 * 60_000 > Date.now()) return cached;
    const r = await this.call('video.url', { version });
    this._links.set(version, r);
    return r;
  }

  dispose() {
    this.stop();
  }
}
