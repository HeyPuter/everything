import { keyReferences } from './thread.js';

/**
 * Search over a mailbox listing.
 *
 * Two things make this possible without downloading every message. The
 * filename carries the subject (`<uuidv7>--<base64url subject>`), so a
 * complete subject search needs no reads at all. Everything else -- sender
 * and preview line -- comes from the 8 KB head read the list already does per
 * row, kept in an index so it is paid for once per message rather than once
 * per search.
 *
 * Matching is a pure function over an entry and its flags, so the awkward
 * cases are tested here rather than in the DOM.
 */

// Query text may name an Object property such as "constructor". Only the
// operators defined here are syntax; inherited names remain literal words.
const FIELDS = { __proto__: null, from: 'from', to: 'to', subject: 'subject', body: 'body' };

/**
 * A date the way it is typed into a search -- `2026-08-01` or `2026/08/01`,
 * the two forms Gmail takes -- normalised to the ISO form the day folders are
 * named in, so a date term is a string comparison against the folder a message
 * is filed under. Anything else is not a date, and the term is searched as
 * the text it is.
 */
const DATE_FIELDS = { __proto__: null, before: 'before', after: 'after' };
const asDay = (value = '') => {
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00Z`);
  // Date normalizes some impossible days, such as February 30, into the
  // next month. Only accept it when the parsed calendar day is unchanged.
  return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== iso ? null : iso;
};

const FLAGS = {
  __proto__: null,
  'has:attachment': 'attachment',
  'has:attachments': 'attachment',
  'has:file': 'attachment',
  'is:unread': 'unread',
  'is:read': 'read',
  'is:starred': 'starred',
  'is:unstarred': 'unstarred',
};

/**
 * Split a query into terms and flags. Quoted phrases stay whole, a `field:`
 * prefix narrows the term, and an unknown prefix is treated as ordinary text
 * rather than silently dropping what the user typed.
 *
 * A quoted phrase may follow a field prefix: matching the quotes on their own
 * broke `subject:"usage report"` at the space, leaving a term looking for a
 * literal `"usage` -- which nothing has ever matched -- and a stray `report"`
 * beside it.
 */
export const parseQuery = (raw = '') => {
  const terms = [];
  const flags = [];

  for (const token of raw.match(/(?:[a-z]+:)?"[^"]*"|\S+/gi) ?? []) {
    const flag = FLAGS[token.toLowerCase()];
    if (flag) {
      flags.push(flag);
      continue;
    }
    const prefixed = /^([a-z]+):(.*)$/i.exec(token);
    const dated = prefixed && DATE_FIELDS[prefixed[1].toLowerCase()];
    if (dated) {
      // `before:2026-08-01`: a day, not a word. Where what follows is not a
      // day, the whole token is searched as the text it is, like any other
      // prefix this parser does not know.
      const day = asDay(prefixed[2].replace(/^"(.*)"$/, '$1'));
      if (day) {
        terms.push({ field: dated, value: day });
        continue;
      }
    }
    const field = prefixed && FIELDS[prefixed[1].toLowerCase()];
    const value = (field ? prefixed[2] : token).replace(/^"(.*)"$/, '$1').trim().toLowerCase();
    if (!value) continue;
    terms.push({ field: field ?? 'any', value });
  }

  return { terms, flags, empty: terms.length === 0 && flags.length === 0 };
};

/**
 * Whether answering this query needs the header index. A subject-only query
 * is answered by the filenames alone, so it is complete the moment the
 * mailbox has been listed; anything else has to wait for the reads, which is
 * what the "searching 240 of 1,320" line is about.
 */
export const needsIndex = (query) =>
  query.flags.some((flag) => flag === 'attachment')
  || query.terms.some((term) => term.field === 'any' || term.field === 'from'
    || term.field === 'to' || term.field === 'body');

const has = (value, needle) => Boolean(value) && value.toLowerCase().includes(needle);

/**
 * The day a message belongs to, for a date term: the folder it is filed under,
 * which every listed message has before anything is read, so a date query is
 * complete the moment the folder is listed. The header's own date is used
 * where it has been read, because the folder is named in UTC and a message
 * that arrived late in the evening is filed under tomorrow.
 */
const dayOf = (entry) => {
  if (entry.date instanceof Date && !Number.isNaN(entry.date.valueOf())) {
    const d = entry.date;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return entry.day ?? '';
};

const matchesTerm = (term, entry) => {
  // A failed read supplies a display label, not a sender from the message.
  // The subject is still real metadata and remains searchable below.
  const sender = entry.unreadable ? [] : [entry.from?.name, entry.from?.email];
  switch (term.field) {
    case 'from':
      return sender.some((value) => has(value, term.value));
    case 'to':
      return (entry.to ?? []).some((address) =>
        has(address.name, term.value) || has(address.email, term.value));
    case 'subject':
      return has(entry.subject, term.value);
    case 'body':
      return has(entry.snippet, term.value);
    // `after:` includes the day named and `before:` excludes it, which is how
    // Gmail reads them: `after:2026-08-01 before:2026-09-01` is August.
    case 'after':
      return dayOf(entry) >= term.value;
    case 'before': {
      const day = dayOf(entry);
      return Boolean(day) && day < term.value;
    }
    default:
      return has(entry.subject, term.value)
        || sender.some((value) => has(value, term.value))
        || has(entry.snippet, term.value)
        // Recipients matter in Sent and Drafts, where they are what the row
        // shows.
        || (entry.to ?? []).some((address) =>
          has(address.name, term.value) || has(address.email, term.value));
  }
};

const matchesFlag = (flag, entry, state) => {
  switch (flag) {
    case 'attachment': return Boolean(entry.hasAttachments);
    case 'unread': return !state.isRead;
    case 'read': return Boolean(state.isRead);
    case 'starred': return Boolean(state.isStarred);
    case 'unstarred': return !state.isStarred;
    default: return true;
  }
};

/**
 * Every term and flag has to match. An entry whose header has not been read
 * yet simply has no sender or preview to match against, so it does not match
 * -- and the caller says the search is still running rather than reporting a
 * complete result.
 */
export const matchesQuery = (query, entry, state = {}) =>
  query.terms.every((term) => matchesTerm(term, entry))
  && query.flags.every((flag) => matchesFlag(flag, entry, state));

// Only reject on immutable filename metadata. Missing subjects can be filled
// by headers; dates can differ from the filing day, and read/star flags change.
export const mayMatchSubject = (query, entry) =>
  !query.terms.some(term => term.field === 'subject' && entry.subject
    && !has(entry.subject, term.value));

export const needsSearchRead = (query, entry) => needsIndex(query) && mayMatchSubject(query, entry);

// -- the header index -----------------------------------------------------------

// Stored as a tuple per message rather than an object, because the key names
// would otherwise be most of the payload:
//   [sender name, sender address, snippet, has attachment, date in seconds,
//    recipients as [name, address] pairs, own message id, references,
//    1 where the message is one this account sent]
const SNIPPET_CAP = 160;
// Recipients kept per message: a row shows the first and a count, and search
// matches any of them. A mailing list can carry hundreds, which have no
// business in a cache that has to fit in a single key-value entry.
const RECIPIENT_CAP = 20;
// A message id long enough to be one is well under this; anything longer is a
// header that got away from its sender.
const ID_CAP = 200;

/**
 * Sender, preview and attachment flag per filename, cached so the mailbox is
 * read once rather than on every search. Filenames are stable unique ids and
 * a delivered message never changes, so an entry never goes stale -- it is
 * only ever missing.
 *
 * Storage is injectable, like every other store here: localStorage in the
 * app, a Map in tests. Keep this disposable cache local: remote KV would
 * add network reads/writes and is not a queryable mail index.
 */
export function createSearchIndex(scope, storage = window.localStorage, { cap = 4000 } = {}) {
  const key = `puter-mail:index:${scope}`;

  const load = () => {
    try {
      const value = JSON.parse(storage.getItem(key) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  };

  let entries = load();
  let count = Object.keys(entries).length;
  let dirty = false;

  /**
   * How far back a trim goes. Dropping a single entry per message meant
   * rebuilding the whole cache once per message read, thousands of times over
   * while a large folder is being indexed -- which is exactly when the app is
   * busiest. Trimming a batch at a time pays that cost once per batch, at the
   * price of the cache sitting a little under `cap` rather than exactly at it.
   */
  const trimTo = Math.max(1, cap - Math.max(1, Math.ceil(cap / 10)));

  return {
    get size() { return count; },
    has: (name) => Array.isArray(entries[name]),

    /**
     * Fill in a listed message from the cache. Returns whether it could.
     *
     * `needsRecipients` is for the folders whose rows show who a message went
     * to rather than who sent it. Filling in everything *except* the
     * recipients still counted as a hit, so a Sent row hydrated from an entry
     * that has none showed '…' where the address belongs -- and nothing ever
     * read the header again to correct it. Such an entry is no answer for
     * those folders, so the header is read instead.
     *
     * `needsThread` is the same question for the conversation view: an entry
     * written before threading existed carries no message id, and grouping a
     * folder from those would put every message in a conversation of its own.
     * An id that is recorded as empty is an answer -- the message has none --
     * which is what stops such a message being read again for ever.
     */
    hydrate(message, { needsRecipients = false, needsThread = false } = {}) {
      const entry = entries[message.name];
      if (!Array.isArray(entry)) return false;
      const [name, email, snippet, attachment, seconds, recipients, id, references, outgoing] = entry;
      // A Sent row also needs its recipients marked as the account's own.
      // An entry written before that mark existed holds recipients nobody
      // can tell from the To line of received mail, so it is read again,
      // once, and written back with the mark.
      if (needsRecipients && (!recipients || !outgoing)) return false;
      if (needsThread && id === undefined) return false;
      if (needsThread && (id?.length >= ID_CAP || references?.some(ref => ref.length >= ID_CAP)
        || (recipients?.length ?? 0) >= RECIPIENT_CAP)) return false;
      message.from = { name: name || email || '(unknown sender)', email: email || '' };
      message.snippet = snippet || '';
      // Older cache tuples do not record whether these caps discarded data.
      // They remain useful for rows, but cannot prove a complete search.
      message.searchIncomplete = (snippet?.length ?? 0) >= SNIPPET_CAP
        || (recipients?.length ?? 0) >= RECIPIENT_CAP;
      message.hasAttachments = Boolean(attachment);
      if (seconds) message.date = new Date(seconds * 1000);
      if (recipients) {
        message.to = recipients.map(([who, address]) => ({ name: who, email: address }));
      }
      if (id !== undefined) {
        message.messageId = id;
        message.references = references ?? [];
      }
      return true;
    },

    /**
     * Every address the index has seen, flat and undeduped: each message's
     * sender, and -- where the entry has them -- its recipients, each carrying
     * that message's date. One entry per person is `mergeContacts()`'s job in
     * contacts.js; keeping the merge out of here is what lets the ranking be
     * tested without a storage behind it.
     *
     * `written` marks a recipient of mail this account sent. Received mail
     * has recipients too -- the account's own address on every message, and
     * whoever else was on the To line -- and they are offered, but not as
     * people written to: counting them as that put the reader's own address
     * at the top of every completion, with a count to match, and a colleague
     * copied on a thread ahead of the people actually being written to.
     */
    addresses() {
      const out = [];
      for (const entry of Object.values(entries)) {
        if (!Array.isArray(entry)) continue;
        const [name, email, , , seconds, recipients, , , outgoing] = entry;
        const when = seconds || 0;
        if (email) out.push({ name: name || '', email, seconds: when, written: false });
        if (!Array.isArray(recipients)) continue;
        for (const recipient of recipients) {
          if (!Array.isArray(recipient)) continue;
          const [who, address] = recipient;
          if (address) out.push({ name: who || '', email: address, seconds: when, written: outgoing === 1 });
        }
      }
      return out;
    },

    /**
     * Record what a header read found. `outgoing` says the message is one this
     * account sent, which is what makes its recipients people written to.
     */
    add(message, { outgoing = false } = {}) {
      if (!message.name || !message.from) return;
      const entry = [
        message.from.name ?? '',
        message.from.email ?? '',
        (message.snippet ?? '').slice(0, SNIPPET_CAP),
        message.hasAttachments ? 1 : 0,
        message.date instanceof Date && !Number.isNaN(message.date.valueOf())
          ? Math.floor(message.date.getTime() / 1000)
          : 0,
      ];
      // Who it went to: what a Sent or Drafts row shows in place of a sender,
      // and what search matches in those folders. An empty list is recorded
      // too -- it is the honest answer for a Cc-only message, and telling it
      // apart from "never recorded" is what keeps the row from being read
      // again for ever.
      // The slots below are positional, so an absent one still has to occupy
      // its place: an entry with threading but no recipients would otherwise
      // hand its message id back as the recipient list.
      const recipients = Array.isArray(message.to)
        ? message.to.slice(0, RECIPIENT_CAP).map((address) => [address.name ?? '', address.email ?? ''])
        : null;
      if (message.messageId !== undefined) {
        entry.push(
          recipients,
          String(message.messageId).slice(0, ID_CAP),
          keyReferences(message.references ?? []).map((id) => String(id).slice(0, ID_CAP)),
        );
        // Present or absent, never a zero: an entry without the mark reads
        // as received mail, which is also what every entry written before
        // the mark existed is taken for.
        if (outgoing) entry.push(1);
      } else if (recipients) {
        entry.push(recipients);
      }
      if (!(message.name in entries)) count++;
      entries[message.name] = entry;
      dirty = true;
      if (count > cap) {
        // The newest messages are kept: what each folder shows first after a
        // reload. Filenames start with a uuid v7, so they sort by when the
        // message was filed. Trimming by insertion order dropped exactly
        // those, because a search reads a folder newest first -- one search
        // over a big inbox evicted its first page and every Sent entry.
        // Mail this account sent is what the address book ranks on, so it
        // is kept first, up to half of what is kept.
        const newest = Object.keys(entries).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
        const keep = new Set(newest.filter((name) => entries[name][8] === 1).slice(0, Math.floor(trimTo / 2)));
        for (const name of newest) {
          if (keep.size >= trimTo) break;
          keep.add(name);
        }
        entries = Object.fromEntries(newest.filter((name) => keep.has(name)).map((name) => [name, entries[name]]));
        count = keep.size;
      }
    },

    /** Write through. The caller batches this: indexing writes thousands. */
    flush() {
      if (!dirty) return true;
      try {
        storage.setItem(key, JSON.stringify(entries));
        dirty = false;
        return true;
      } catch {
        // A full quota is not a reason to stop searching; the index simply
        // does not survive the reload.
        return false;
      }
    },
  };
}
