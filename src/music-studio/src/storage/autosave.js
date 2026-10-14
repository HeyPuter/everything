// Autosave. Two independent schedules driven by store changes:
//
//   draft: the whole session (project, file, dirty flag) to this device's
//          IndexedDB about 2 s after the last edit. Cheap and local, so a
//          reload or a crash never loses work. Restored on the next start.
//   cloud: when the project has a Puter path and the preference is on, the
//          project file itself, 60 s after the last edit (at most 5 min after
//          the first unsaved one), and when the page is hidden. Never per
//          keystroke: Puter writes cost the user's allowance.
//
// Gesture previews (drags in progress) are skipped; their commit follows.

export class Autosave {
  constructor({ store, writeDraft, writeCloud, cloudEnabled = () => false, delay = 2000, cloudDelay = 60000, cloudMaxWait = 300000, timers = globalThis, now = () => Date.now() }) {
    this.store = store;
    this.writeDraft = writeDraft;
    this.writeCloud = writeCloud;
    this.cloudEnabled = cloudEnabled;
    this.delay = delay;
    this.cloudDelay = cloudDelay;
    this.cloudMaxWait = cloudMaxWait;
    this.timers = timers;
    this.now = now;
    this.draftTimer = null;
    this.cloudTimer = null;
    this.cloudFirst = null;
    this.writing = null; // the draft write in flight
    this.again = false;
    this.cloudWriting = null;
    this.lastError = null;
    this.offs = [];
  }

  start() {
    this.offs.push(
      this.store.on('change', (_p, _prev, info) => {
        if (info?.source === 'preview') return;
        this.scheduleDraft();
        if (info?.source !== 'load') this.scheduleCloud();
      }),
      this.store.on('saved', () => this.scheduleDraft()),
    );
    return this;
  }

  stop() {
    for (const off of this.offs) off();
    this.offs = [];
    this.timers.clearTimeout(this.draftTimer);
    this.timers.clearTimeout(this.cloudTimer);
    this.draftTimer = this.cloudTimer = null;
  }

  /** Whether session changes are not in the draft yet. */
  get pending() {
    return this.draftTimer !== null || Boolean(this.writing) || this.lastError !== null;
  }

  scheduleDraft() {
    this.timers.clearTimeout(this.draftTimer);
    this.draftTimer = this.timers.setTimeout(() => {
      this.draftTimer = null;
      this.flushDraft();
    }, this.delay);
  }

  /** Writes the draft now. Concurrent calls coalesce into one more write. */
  async flushDraft() {
    if (this.draftTimer !== null) {
      this.timers.clearTimeout(this.draftTimer);
      this.draftTimer = null;
    }
    if (this.writing) {
      this.again = true;
      return this.writing;
    }
    this.writing = (async () => {
      try {
        await this.writeDraft();
        this.lastError = null;
      } catch (err) {
        this.lastError = err;
        console.warn('Music Studio: could not autosave the session.', err);
      }
    })();
    await this.writing;
    this.writing = null;
    if (this.again) {
      this.again = false;
      return this.flushDraft();
    }
    return undefined;
  }

  scheduleCloud() {
    if (!this.cloudEnabled()) return;
    const now = this.now();
    this.cloudFirst ??= now;
    const wait = Math.max(0, Math.min(this.cloudDelay, this.cloudFirst + this.cloudMaxWait - now));
    this.timers.clearTimeout(this.cloudTimer);
    this.cloudTimer = this.timers.setTimeout(() => {
      this.cloudTimer = null;
      this.flushCloud();
    }, wait);
  }

  /** Saves to the cloud now if enabled and there are unsaved changes. */
  async flushCloud() {
    this.timers.clearTimeout(this.cloudTimer);
    this.cloudTimer = null;
    this.cloudFirst = null;
    if (!this.cloudEnabled() || !this.store.dirty || this.cloudWriting) return;
    this.cloudWriting = Promise.resolve()
      .then(() => this.writeCloud())
      .catch((err) => console.warn('Music Studio: cloud autosave failed.', err))
      .finally(() => {
        this.cloudWriting = null;
      });
    await this.cloudWriting;
  }

  /** Page hidden or closing: write everything that is waiting. */
  async flushAll() {
    const draft = this.draftTimer !== null || this.again ? this.flushDraft() : this.writing;
    const cloud = this.cloudTimer !== null ? this.flushCloud() : null;
    await Promise.all([draft, cloud]);
  }
}
