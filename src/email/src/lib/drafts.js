/**
 * Draft storage. A draft is a saved set of compose fields and nothing more:
 * the send path still runs buildMessage() over them at send time, so nothing
 * here knows about MIME.
 *
 * The store is a pure function over an injectable storage, like readstate.js
 * -- localStorage in the app, a Map in the tests. That is also
 * what makes the move to `puter.kv` (app-scoped per user, so a draft started
 * on a phone can be finished on a desktop) a change of one argument rather
 * than a change to the dialog.
 *
 * Attachment bytes are stored separately in IndexedDB by draftfiles.js. Text
 * autosave stays synchronous and small; file snapshots change only when the
 * attachment list changes. The count detects unavailable or older files.
 *
 * Everything here is a string, including the body markup, and every field is
 * re-read as one on the way out: a store this app does not own the only copy
 * of is a place where a field can come back as a number, an object, or
 * missing.
 */

import { parseAddressList } from './mime.js';
import { cleanSnippet } from './format.js';
import { createDraftFileStore } from './draftfiles.js';

/**
 * inReplyTo and references travel with the draft: a reply that is closed and
 * resumed must still thread with the message it answers.
 *
 * `body` and `html` are the same message twice -- the text of it and the
 * markup of it. Both are kept because they answer different questions: the
 * editor is refilled from `html`, while `body` is what the drafts folder shows
 * as a preview line and what decides whether a draft is empty. Keeping only
 * the markup would mean parsing HTML to render a list of rows; keeping only
 * the text would mean losing the formatting on every close. A draft stored
 * before there was an editor has no `html`, which is exactly the case the
 * dialog handles by rebuilding one from `body`.
 */
const FIELDS = ['domain', 'to', 'cc', 'subject', 'body', 'html', 'inReplyTo', 'references'];
const TEXT_FIELDS = ['to', 'cc', 'subject', 'body'];
const MAX_DRAFTS = 50;

/** A draft with nothing in it is not worth keeping, or restoring. */
export const isEmptyDraft = (draft = {}) =>
  !draft.attachments && !TEXT_FIELDS.some((field) => (draft[field] ?? '').trim());

const clean = (draft) => {
  if (!draft || typeof draft !== 'object' || typeof draft.id !== 'string') return null;
  const entry = { id: draft.id, updated: Number(draft.updated) || 0, attachments: Number(draft.attachments) || 0 };
  for (const field of FIELDS) entry[field] = typeof draft[field] === 'string' ? draft[field] : '';
  return entry;
};

export function createDraftStore(scope, storage = window.localStorage, now = () => Date.now()) {
  const key = `puter-mail:drafts:${scope}`;
  const files = createDraftFileStore(scope);

  const load = () => {
    try {
      const value = JSON.parse(storage.getItem(key) || '[]');
      return Array.isArray(value) ? value.map(clean).filter(Boolean) : [];
    } catch {
      return [];
    }
  };

  let drafts = load();
  // Another window of the app writes the same entry, and saving already
  // merges against it -- but reads answered from memory, so Drafts (Refresh
  // included) never showed a draft written there, and opening one it had
  // changed loaded the old text, which the next autosave then wrote back over
  // the new. Reads follow the stored entry, parsing it again only when it has
  // changed.
  const readRaw = () => {
    try {
      return storage.getItem(key);
    } catch {
      return seen;
    }
  };
  let seen = readRaw();
  const current = () => {
    const raw = readRaw();
    if (raw !== seen) {
      seen = raw;
      drafts = load();
    }
    return drafts;
  };

  // Returns whether the write went through: a quota error means the draft is
  // only in the dialog, and the dialog has to say so before it closes.
  const persist = () => {
    try {
      storage.setItem(key, JSON.stringify(drafts));
      return true;
    } catch {
      return false;
    }
  };

  const newestFirst = (a, b) => b.updated - a.updated;

  return {
    loadAttachments: files.load,
    saveAttachments: files.save,
    /** Newest first, which is the order the folder lists them in. */
    list: () => [...current()].sort(newestFirst),
    get: (id) => current().find((draft) => draft.id === id) ?? null,
    get count() { return current().length; },

    /** Upsert by id, stamping the time. Returns whether it was stored. */
    save(draft) {
      const entry = clean({ ...draft, updated: now() });
      if (!entry) return false;
      // Merge against disk at mutation time so two open app windows do not
      // overwrite each other's unrelated drafts with an old in-memory list.
      const previous = load();
      drafts = [...previous];
      const at = drafts.findIndex((d) => d.id === entry.id);
      if (at === -1) drafts.push(entry);
      else drafts[at] = entry;
      const evicted = drafts.sort(newestFirst).slice(MAX_DRAFTS);
      drafts = drafts.slice(0, MAX_DRAFTS);
      if (!persist()) { drafts = previous; return false; }
      evicted.forEach((entry) => files.remove(entry.id).catch(() => {}));
      return true;
    },

    remove(id) {
      drafts = load();
      const at = drafts.findIndex((draft) => draft.id === id);
      if (at === -1) {
        // Attachment bytes are written as soon as a file is read, before the
        // debounced text save has made a row for them: with no row, they
        // still go.
        files.remove(id).catch(() => {});
        return false;
      }
      const [removed] = drafts.splice(at, 1);
      if (!persist()) { drafts.splice(at, 0, removed); return false; }
      files.remove(id).catch(() => {});
      return true;
    },
  };
}

/**
 * A draft in the shape the message list renders: the folder needs a row per
 * draft, and rows are built from mailbox messages. There is no file behind
 * one, so there is no path and nothing to enrich -- everything the row shows
 * is already here.
 */
export const draftToMessage = (draft) => ({
  name: draft.id,
  box: 'drafts',
  draft,
  day: new Date(draft.updated || 0).toISOString().slice(0, 10),
  date: new Date(draft.updated || 0),
  subject: (draft.subject ?? '').trim(),
  to: parseAddressList(draft.to ?? ''),
  snippet: cleanSnippet(draft.body ?? ''),
  hasAttachments: Boolean(draft.attachments),
});
