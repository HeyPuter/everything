/**
 * Trust policy + iTIP state machine for mail-detected invitations.
 *
 * Reads the handler's `cal:mail:inv:*` records, classifies each sender as
 * authenticated and/or known, and either applies the change straight to the
 * store (REQUEST/PUBLISH/CANCEL from a trusted sender) or leaves it for the
 * user in the pending tray (`getPending()`). An unknown sender's record is
 * hidden entirely by default — only prior interaction (an allowed sender,
 * a contact, a host/guest relationship, or someone the user has emailed —
 * see isKnown) earns a place in the tray at all. It never sends mail (that
 * is mail-reply.js, downstream of an RSVP press) and never renders anything —
 * `getPending()` hands the UI plain view models, already parsed, so the
 * sidebar never touches `record.ical` or calls into ics.js itself.
 */
import { parseITIP } from './ics.js';
import { RECORD_VERSION } from './mailbox.js';
import { isBlocked } from './offline.js';
import { toast as defaultToast } from './toast.js';
import { describeWhen } from './invites.js';
import { expandOccurrences, isScheduledOccurrence } from './recurrence.js';

const INV_PREFIX = 'cal:mail:inv:';
const SENDERS_KEY = 'cal:mail:senders';
const CORR_KEY = 'cal:mail:corr';
const OWN_UID_SUFFIX = '@calendar.puter.com';
const DAY_MS = 86_400_000;

const MAX_TRACKED = 60; // newest records kept in memory at all
const TRAY_CAP = 50; // getPending() display cap
const PUMP_APPLY_CAP = 25; // auto-applies per pump()
const SESSION_APPLY_CAP = 60; // auto-applies per session
const MAX_BLOCKED = 100;
const MAX_ALLOWED = 200;
const VISIBILITY_PUMP_MS = 30_000;
const UNDO_DEPTH = 8; // recently-removed records an Undo can still restore

// Sent-folder correspondents index: bounded on every axis so it can
// never turn into an unbounded mail crawl.
const CORR_MAX_ADDRESSES = 500;
const CORR_MAX_MESSAGES = 100; // per pass
const CORR_MAX_MESSAGE_BYTES = 256 * 1024;
const CORR_REFRESH_MS = DAY_MS; // once per day (see corrAttempted for the per-session half)

function coerce(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

/** Keep only well-shaped, deduped, lowercase addresses, newest first, capped. */
function unionCap(list, cap) {
  const seen = new Set();
  const out = [];
  for (const raw of list || []) {
    const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
    if (out.length >= cap) break;
  }
  return out;
}

export function createMailIntake({
  kv,
  store,
  mailbox,
  contacts = null,
  user,
  toast = defaultToast,
  blocked = isBlocked,
  getPuter = () => (typeof puter !== 'undefined' ? puter : null),
  // Told how many invitations a pump newly put in the tray, so the app can say
  // so and offer a way to them. Never called for the first pump of a session:
  // a backlog that was already there is not news, and the tray shows it anyway.
  onDetected = null,
}) {
  // recordId (the "cal:mail:inv:" key) -> { record, item, method }, for every
  // record currently tracked in memory (both auto-applied-this-session, which
  // are removed once deleted, and pending ones).
  const cache = new Map();
  // recordId -> cached view model — parsed once, so a 50-row tray never
  // re-parses iCalendar on every render.
  const pendingViews = new Map();
  // Deleted this session: a `kv.list` racing our own delete must not bring a
  // row back to life.
  const tombstones = new Set();
  // recordId -> the entry a just-consumed record had, so Undo can re-file it.
  const undoable = new Map();

  let senders = { blocked: [], allowed: [], at: 0 };
  let blockedSet = new Set();
  let allowedSet = new Set();
  let corr = { v: 1, at: 0, watermark: '', addresses: [] };
  let corrSet = new Set();
  let corrAttempted = false; // ...and at most once per session, success or not
  let sessionApplied = 0;
  let lastVisPump = 0;
  let pumping = null;
  let pumpedOnce = false;
  let tickSub = null;

  const listeners = new Set();
  function notify() {
    for (const fn of listeners) {
      try {
        fn();
      } catch {
        /* a listener bug must not break intake */
      }
    }
  }

  function username() {
    return (user && user.username) || '';
  }
  function selfEmail() {
    return (user && typeof user.email === 'string' && user.email.trim().toLowerCase()) || '';
  }

  /* ---- sender lists (cal:mail:senders) ---------------------------------- */

  async function loadSenders() {
    const raw = coerce(await kv.get(SENDERS_KEY));
    return {
      blocked: unionCap(raw && raw.blocked, MAX_BLOCKED),
      allowed: unionCap(raw && raw.allowed, MAX_ALLOWED),
      at: (raw && raw.at) || 0,
    };
  }

  /** Read-merge-union-write: lay this device's own change over the freshest
   *  cloud copy, so two devices editing the lists don't clobber each other. */
  async function mutateSenders(mutate) {
    let cloud;
    try {
      cloud = await loadSenders();
    } catch {
      cloud = { blocked: senders.blocked, allowed: senders.allowed };
    }
    const base = {
      blocked: unionCap([...senders.blocked, ...cloud.blocked], MAX_BLOCKED),
      allowed: unionCap([...senders.allowed, ...cloud.allowed], MAX_ALLOWED),
    };
    const next = mutate(base);
    senders = {
      blocked: unionCap(next.blocked, MAX_BLOCKED),
      allowed: unionCap(next.allowed, MAX_ALLOWED),
      at: Date.now(),
    };
    blockedSet = new Set(senders.blocked);
    allowedSet = new Set(senders.allowed);
    await kv.set(SENDERS_KEY, senders);
    notify();
  }

  async function blockAddress(email) {
    const addr = String(email || '').trim().toLowerCase();
    if (!addr) return;
    await mutateSenders((base) => ({
      blocked: [addr, ...base.blocked.filter((e) => e !== addr)],
      allowed: base.allowed.filter((e) => e !== addr),
    }));
  }
  async function allowAddress(email) {
    const addr = String(email || '').trim().toLowerCase();
    if (!addr) return;
    await mutateSenders((base) => ({
      blocked: base.blocked,
      allowed: [addr, ...base.allowed.filter((e) => e !== addr)],
    }));
  }

  /* ---- trust classification (identity is the From header only) --------- */

  /**
   * Identity is the `From` header and nothing else. `Sender:` is carried on the
   * record for display, but it is never an identity: DKIM aligns against the
   * From domain only, so a message DKIM-signed for the attacker's own domain
   * can name any address at all in `Sender:` — which would otherwise satisfy
   * mayUpdate, canCancel and the auto-applied REPLY path.
   */
  function senderMatches(record, targetEmail) {
    const t = String(targetEmail || '').trim().toLowerCase();
    if (!t) return false;
    return Boolean(record.from && record.from.email === t);
  }

  /** The address a record speaks for, or '' when it names none. Never falls
   *  back to `Sender:` — see senderMatches. */
  function identityOf(record) {
    return (record && record.from && record.from.email) || '';
  }

  /** Whether a row may be surfaced at all. A CANCEL or COUNTER naming an event
   *  already on the calendar bears on the user's own data, so it shows even
   *  from a sender we cannot vouch for; one naming nothing we hold is just
   *  mail, and follows the prior-interaction rule like everything else. */
  function visibleFor(record, item, method) {
    if (isKnown(identityOf(record))) return true;
    if (method !== 'CANCEL' && method !== 'COUNTER') return false;
    return Boolean(item && item.uid && findByUid(item.uid));
  }

  /**
   * On an event the user created, every address on the guest list is one they
   * typed, so it counts. On an event that arrived by mail the guest list is the
   * sender's, not the user's — counting it would mean one auto-added invitation
   * silently promotes every co-attendee to "known", and any of them could then
   * auto-add invitations of their own. Only whoever sent it counts there.
   *
   * "Known" is prior interaction, full stop. The sent-
   * folder correspondents index (`corrSet`) adds one more route: anyone the
   * user has emailed themselves.
   */
  function isKnown(fromEmail) {
    if (!fromEmail) return false;
    if (allowedSet.has(fromEmail)) return true;
    if (corrSet.has(fromEmail)) return true;
    if (contacts && typeof contacts.knows === 'function' && contacts.knows(fromEmail)) return true;
    for (const ev of store.getAllEvents()) {
      // On an event that arrived by mail, neither the guest list nor the
      // ORGANIZER is evidence of anything: both are text the sender wrote. Only
      // whoever actually sent it counts, so one known correspondent's invite
      // cannot quietly promote whoever its ICS happens to name. On an event the
      // user created, every address on it is one they typed.
      if (ev.invite) {
        if (ev.invite.from === fromEmail) return true;
        continue;
      }
      if (ev.organizer && ev.organizer.email === fromEmail) return true;
      if (Array.isArray(ev.guests) && ev.guests.some((g) => g.email === fromEmail)) return true;
    }
    return false;
  }

  function isAuthenticated(record) {
    return Boolean(record.auth && (record.auth.internal || record.auth.dkimAligned));
  }

  /** Auto-add requires both authenticated AND (per setting) known — 'all' is
   *  gone, so `known` is the only way in. Never attempted while offline — see
   *  createMailIntake's `blocked` dependency. */
  function autoAllowed(record, known) {
    if (blocked()) return false;
    const mode = (store.getSettings() || {}).mailInvites || 'known';
    if (mode === 'never') return false;
    if (!isAuthenticated(record)) return false;
    return known;
  }

  /* ---- sent-folder correspondents index (cal:mail:corr) ------------------ */

  function collectAddresses(msg) {
    const out = [];
    for (const field of ['to', 'cc', 'bcc']) {
      for (const a of Array.isArray(msg && msg[field]) ? msg[field] : []) {
        const email = a && typeof a.address === 'string' ? a.address.trim().toLowerCase() : '';
        if (email) out.push(email);
      }
    }
    return out;
  }

  async function loadCorrespondents() {
    const raw = coerce(await kv.get(CORR_KEY));
    return {
      v: 1,
      at: (raw && raw.at) || 0,
      watermark: (raw && typeof raw.watermark === 'string') ? raw.watermark : '',
      addresses: unionCap(raw && raw.addresses, CORR_MAX_ADDRESSES),
    };
  }

  /**
   * Build (or top up) the index from the sent folder: anyone the user has
   * mailed counts as known. Strictly bounded — one page of at most 100
   * messages, oversized ones (>256 KB) skipped without a `get`, at most 500
   * addresses kept — and failure-tolerant: a rejected `list`/`get` leaves the
   * existing index exactly as it was. Gated to once per day AND at most once
   * per session (this flag), and only ever called from a non-boot pump (see
   * doPump's `isFirstPump`) — a cold boot never pays for a mailbox crawl.
   * uuidv7 ids sort chronologically as lowercase strings, so the greatest id
   * seen is a valid watermark.
   */
  async function refreshCorrespondents() {
    if (corrAttempted) return;
    corrAttempted = true;
    const p = getPuter();
    if (!p || !p.email || typeof p.email.list !== 'function' || typeof p.email.get !== 'function') return;
    if (Date.now() - (corr.at || 0) < CORR_REFRESH_MS) return;
    try {
      const res = await p.email.list({ folder: 'sent', limit: CORR_MAX_MESSAGES });
      const items = Array.isArray(res && res.items) ? res.items : [];
      const watermark = corr.watermark || '';
      let greatest = watermark;
      const found = [];
      for (const item of items) {
        if (!item || typeof item.id !== 'string') continue;
        if (watermark && item.id <= watermark) continue; // already indexed
        if (item.id > greatest) greatest = item.id;
        if (Number.isFinite(item.size) && item.size > CORR_MAX_MESSAGE_BYTES) continue; // skip the get
        try {
          found.push(...collectAddresses(await p.email.get({ id: item.id, folder: 'sent' })));
        } catch {
          /* one bad message must not abort the pass */
        }
      }
      const addresses = unionCap([...found, ...corr.addresses], CORR_MAX_ADDRESSES);
      corr = { v: 1, at: Date.now(), watermark: greatest, addresses };
      corrSet = new Set(addresses);
      await kv.set(CORR_KEY, corr);
    } catch {
      /* a rejected list leaves the existing index (and `at`) untouched */
    }
  }

  /* ---- matching a UID to a stored event ---------------------------------- */

  function findByUid(uid) {
    if (!uid) return null;
    if (uid.endsWith(OWN_UID_SUFFIX)) {
      const ev = store.getEvent(uid.slice(0, -OWN_UID_SUFFIX.length));
      if (ev) return ev;
    }
    return store.getAllEvents().find((e) => e.invite && e.invite.uid === uid) || null;
  }

  /* ---- iTIP item selection ------------------------------------------------ */

  function safeParseITIP(ical) {
    try {
      return parseITIP(String(ical || ''));
    } catch {
      return null;
    }
  }

  function effectiveMethod(record, item) {
    if (record.method) return record.method;
    if (item && item.organizer && item.attendees && item.attendees.length) return 'REQUEST';
    return '';
  }

  /* ---- which attendee address the invitation reached us by -------------- */

  function computeInviteAttendee(record) {
    const puterAddr = username() ? `${username()}@puter.email` : '';
    const list = Array.isArray(record.attendees) ? record.attendees : [];
    if (puterAddr && list.includes(puterAddr)) return puterAddr;
    const self = selfEmail();
    if (self && list.includes(self)) return self;
    return puterAddr;
  }

  function mergeGuestsKeepingStatus(existingGuests, attendees) {
    const byEmail = new Map((existingGuests || []).map((g) => [g.email, g]));
    const out = [];
    for (const a of attendees || []) {
      const prior = byEmail.get(a.email);
      if (prior) {
        out.push(a.name ? { ...prior, name: a.name } : prior);
      } else {
        const g = { email: a.email, status: a.status || 'needs-action' };
        if (a.name) g.name = a.name;
        out.push(g);
      }
    }
    return out;
  }

  /* ---- applying an item --------------------------------------------------- */

  /**
   * May this sender update the event their UID matched? Only the sender who
   * created it, and only when it came from mail in the first place. Without
   * this, a UID is a write capability: anyone authenticated could overwrite
   * another sender's invitation, and — because our own exports use
   * `<id>@calendar.puter.com` — could overwrite an event the USER hosts and
   * stamp `invite` on it, which silently takes it out of RSVP-link sync.
   */
  function mayUpdate(record, existing) {
    if (!existing || !existing.invite) return false;
    const owner = existing.invite.from || (existing.organizer && existing.organizer.email) || '';
    return Boolean(owner) && senderMatches(record, owner);
  }

  async function applyRequestOrPublish(record, item, method, recordId = '', { forceNew = false } = {}) {
    const uid = item.uid;
    if (!uid) return false;
    const fromEmail = identityOf(record);
    const inviteRef = {
      uid,
      seq: item.sequence,
      stamp: item.dtstamp,
      from: fromEmail,
      attendee: computeInviteAttendee(record),
    };
    const matched = findByUid(uid);
    // A UID that belongs to someone else's event (or to one the user hosts) is
    // not an update. An explicit Add still gets what the user asked for — a new
    // event of its own, with no UID link so it can never be updated by mail.
    let existing = matched && mayUpdate(record, matched) ? matched : null;
    if (matched && !existing && !forceNew) return null; // caller trays it

    const storedSeq = (existing && existing.invite && existing.invite.seq) || 0;
    const storedStamp = (existing && existing.invite && existing.invite.stamp) || 0;
    const newer = item.sequence > storedSeq || (item.sequence === storedSeq && item.dtstamp > storedStamp);

    if (existing && existing.recurrence && item.recurrenceId) {
      // One occurrence changed. Writing it onto the master would re-anchor the
      // whole series on that day, so it becomes an override on its slot.
      const slot = resolveOccurrenceSlot(existing, item.recurrenceId.ms);
      if (slot != null) {
        if (!newer) return existing;
        const res = await store.updateOccurrence(existing.id, slot, {
          title: item.event.title,
          description: item.event.description,
          location: item.event.location,
          allDay: item.event.allDay,
          start: item.event.start,
          end: item.event.end,
        });
        if (res) return res.event;
      }
      if (!forceNew) return null;
      existing = null; // explicit Add of an occurrence we can't place: a separate event
    }

    if (!existing) {
      const patch = {
        title: item.event.title,
        description: item.event.description,
        location: item.event.location,
        allDay: item.event.allDay,
        start: item.event.start,
        end: item.event.end,
        recurrence: item.event.recurrence || null,
        exdates: item.event.exdates || [],
      };
      // No UID link when this is a deliberate copy alongside a conflicting
      // event: two events answering to one UID would make the next REQUEST's
      // match arbitrary.
      if (!matched) patch.invite = inviteRef;
      if (method === 'REQUEST') {
        patch.organizer = item.organizer || null; // populate only — never an identity signal
        if (item.attendees && item.attendees.length) {
          patch.guests = item.attendees.map((a) => (a.name ? { email: a.email, name: a.name, status: a.status } : { email: a.email, status: a.status }));
        }
      } else {
        patch.organizer = null; // PUBLISH: read-only add, no organizer, no guests, no RSVP UI
        patch.guests = [];
      }
      const saved = await store.saveEvent(patch);
      toast(`Added "${saved.title || '(No title)'}" from ${fromEmail}`, {
        action: { label: 'Undo', onClick: () => undoAdd(saved.id, recordId) },
      });
      return saved;
    }

    if (!newer) return existing; // stale update — the record is still consumed by the caller

    const patch = {
      id: existing.id,
      title: item.event.title,
      description: item.event.description,
      location: item.event.location,
      allDay: item.event.allDay,
      start: item.event.start,
      end: item.event.end,
      invite: inviteRef,
      // color/reminders are deliberately absent: saveEvent merges onto the
      // existing record, so the user's own local preferences survive untouched.
    };
    // The organizer's message describes the whole series (the occurrence case
    // returned above), so its rule and exceptions replace the stored ones.
    if (!item.recurrenceId) {
      patch.recurrence = item.event.recurrence || null;
      patch.exdates = item.event.exdates || [];
    }
    if (method === 'REQUEST') {
      patch.organizer = item.organizer || existing.organizer;
      patch.guests = mergeGuestsKeepingStatus(existing.guests, item.attendees);
    }
    return store.saveEvent(patch);
  }

  /** Undo an add: the event goes, and the invitation goes back to the tray.
   *  Dropping the record instead would leave the user with no way to reach
   *  that invitation again — Undo would quietly discard it. */
  async function undoAdd(eventId, recordId) {
    if (eventId) await store.deleteEvent(eventId);
    const held = undoable.get(recordId);
    if (!held) return false;
    undoable.delete(recordId);
    tombstones.delete(recordId);
    cache.set(recordId, held);
    pendingViews.set(recordId, buildViewModel(recordId, held.record, held.item, held.method, held.known));
    try {
      await kv.set(recordId, held.record);
    } catch {
      /* the tray still holds it in memory for this session */
    }
    notify();
    return true;
  }

  function canCancel(record, stored) {
    if (!stored) return false;
    if (!isAuthenticated(record)) return false;
    const storedOrganizerEmail = (stored.organizer && stored.organizer.email) || (stored.invite && stored.invite.from) || '';
    if (!storedOrganizerEmail) return false;
    return senderMatches(record, storedOrganizerEmail);
  }

  /**
   * A foreign RECURRENCE-ID rarely lands exactly on one of the engine's own
   * scheduled slots (zone conversion, seconds, a producer's own rounding), so
   * `store.deleteOccurrence`/`deleteFuture` — which refuse anything that
   * isn't an EXACT slot — would silently no-op on the raw instant. Resolve it
   * to a real slot first: an exact match, else the unique scheduled slot
   * falling on the same LOCAL calendar day. `null` when neither holds,
   * so the caller can tray the cancellation instead of losing it.
   */
  function resolveOccurrenceSlot(master, targetMs) {
    if (!master || !master.recurrence || !Number.isFinite(targetMs)) return null;
    if (isScheduledOccurrence(master, targetMs)) return targetMs;
    const dayStart = new Date(targetMs);
    dayStart.setHours(0, 0, 0, 0);
    const dayFrom = dayStart.getTime();
    const dayTo = dayFrom + DAY_MS;
    // Widened window: recurrenceId is the RAW scheduled slot regardless of any
    // per-occurrence override, but expandOccurrences windows by the
    // occurrence's (possibly overridden) actual start — pad so a slot moved
    // just outside the day by its own override is still enumerated.
    const occs = expandOccurrences(master, dayFrom - DAY_MS, dayTo + DAY_MS);
    const rids = [...new Set(
      occs.map((o) => o.recurrenceId).filter((r) => Number.isFinite(r) && r >= dayFrom && r < dayTo),
    )];
    return rids.length === 1 ? rids[0] : null;
  }

  async function applyCancel(record, item) {
    if (blocked()) return false;
    const stored = item.uid ? findByUid(item.uid) : null;
    if (!canCancel(record, stored)) return false;

    if (item.recurrenceId && stored.recurrence) {
      const slot = resolveOccurrenceSlot(stored, item.recurrenceId.ms);
      if (slot == null) return false; // no matching occurrence — tray it, don't claim success
      const result =
        item.recurrenceRange === 'THISANDFUTURE'
          ? await store.deleteFuture(stored.id, slot)
          : await store.deleteOccurrence(stored.id, slot);
      if (!result) return false; // the store refused it (off-pattern, or the series changed under us)
      toast(`Cancelled an occurrence of "${stored.title || '(No title)'}"`, {
        action: { label: 'Undo', onClick: () => result.undo() },
      });
      return true;
    }
    const deleted = await store.deleteEvent(stored.id);
    if (!deleted) return false;
    toast(`Cancelled "${deleted.title || '(No title)'}"`, {
      action: { label: 'Undo', onClick: () => store.saveEvent(deleted) },
    });
    return true;
  }

  function findHostedByUid(uid) {
    const ev = findByUid(uid);
    if (!ev) return null;
    const self = selfEmail();
    const hosts = !ev.organizer || (self && ev.organizer.email === self);
    return hosts ? ev : null;
  }

  /**
   * Own-echo: a REQUEST whose UID resolves, via OUR OWN
   * `@calendar.puter.com` suffix, to an event the user hosts is our own
   * invitation coming back through a Puter mailbox — not a real inbound
   * invitation, from anyone. Deliberately narrower than `findHostedByUid`: it
   * only trusts the suffix's own id lookup, not the general invite.uid
   * fallback, since only OUR exports ever mint that suffix.
   */
  function resolveOwnEcho(uid) {
    if (!uid || !uid.endsWith(OWN_UID_SUFFIX)) return null;
    const ev = store.getEvent(uid.slice(0, -OWN_UID_SUFFIX.length));
    if (!ev) return null;
    const self = selfEmail();
    const hosts = !ev.organizer || (self && ev.organizer.email === self);
    return hosts ? ev : null;
  }

  async function applyReply(record, item) {
    if (blocked()) return false;
    if (!isAuthenticated(record)) return false;
    const hosted = item.uid ? findHostedByUid(item.uid) : null;
    if (!hosted) return false;
    const replyAttendee = (item.attendees || []).find((a) => senderMatches(record, a.email));
    if (!replyAttendee) return false;
    const onGuestList = (hosted.guests || []).some((g) => g.email === replyAttendee.email);
    if (!onGuestList) return false;
    await store.applyRsvpResponses(hosted.id, [
      { email: replyAttendee.email, status: replyAttendee.status, respondedAt: item.dtstamp || Date.now() },
    ]);
    return true;
  }

  /* ---- view models (parsed once, cached — never re-parsed for display) --- */

  function buildViewModel(id, record, item, method, known = true) {
    const kind = method === 'CANCEL' ? 'cancel' : method === 'COUNTER' ? 'counter' : method === 'PUBLISH' ? 'publish' : 'request';
    let hint = '';
    if (kind === 'cancel') hint = 'Cancellation';
    else if (kind === 'counter') hint = 'Proposed time';
    // Only reachable when mailInvitesShowUnknown surfaced this row at all
    // (see getPending) — the pill is how the tray says why it's asking.
    else if (!known) hint = 'Unknown sender';
    else if (record.auth && record.auth.internal) hint = 'Puter user';

    let whenText = '';
    try {
      if (item && item.event && Number.isFinite(item.event.start) && Number.isFinite(item.event.end)) {
        whenText = describeWhen(item.event, { hour12: (store.getSettings() || {}).hour12 !== false });
      }
    } catch {
      whenText = '';
    }

    // What the primary button does, and whether to offer it at all. A
    // cancellation is the one destructive row, and it is only actionable when
    // the sender really is the organizer the stored event names — otherwise
    // there is nothing safe for a click to mean, and the row says so instead.
    const stored = item.uid ? findByUid(item.uid) : null;
    const canApply = kind === 'cancel' ? Boolean(stored && canCancel(record, stored)) : true;
    // A REQUEST whose UID matches an event this sender may not update is not an
    // update — adding it makes a separate event, and the row says so rather
    // than looking like it will quietly change the one already there.
    const conflicts = kind !== 'cancel' && Boolean(stored) && !mayUpdate(record, stored);
    const action = kind === 'cancel' ? 'Remove event' : kind === 'counter' || conflicts ? 'Add as new' : 'Add';
    const blockedReason =
      kind === 'cancel' && !canApply
        ? stored
          ? 'Not from the organizer of that event.'
          : 'No matching event on this calendar.'
        : conflicts
          ? 'Conflicts with an existing event — this will be added separately.'
          : '';

    return {
      id,
      kind,
      action,
      canApply,
      blockedReason,
      title: (item && item.event && item.event.title) || record.summary || '',
      whenText,
      start: item && item.event ? item.event.start : null,
      end: item && item.event ? item.event.end : null,
      allDay: Boolean(item && item.event && item.event.allDay),
      fromEmail: identityOf(record),
      fromName: (record.from && record.from.name) || '',
      hint,
      authenticated: isAuthenticated(record),
      known: Boolean(known),
      at: record.at || 0,
    };
  }

  /* ---- record lifecycle --------------------------------------------------- */

  async function deleteRecord(id) {
    // Held so an Undo can put the invitation back where the user can see it.
    // Bounded: only the last few adds are ever undoable, and a toast is gone
    // long before that.
    const entry = cache.get(id);
    if (entry) {
      undoable.set(id, entry);
      if (undoable.size > UNDO_DEPTH) undoable.delete(undoable.keys().next().value);
    }
    cache.delete(id);
    pendingViews.delete(id);
    tombstones.add(id);
    try {
      await kv.del(id);
    } catch {
      /* best-effort — a stray leftover record is not worth failing pump() over */
    }
  }

  /** Returns true when this record was auto-applied (consumed the pump/session
   *  budget). With `autoApply` off — the budget is spent — nothing is written
   *  to the store; the record is classified and trayed exactly as it otherwise
   *  would be. */
  async function processRecord(id, record, { autoApply = true } = {}) {
    if (record && record.v !== RECORD_VERSION) {
      await deleteRecord(id);
      return false;
    }
    const fromEmail = identityOf(record);

    if (fromEmail && blockedSet.has(fromEmail)) {
      await deleteRecord(id);
      return false;
    }

    const parsed = safeParseITIP(record.ical);
    const items = (parsed && parsed.items) || [];
    // The series master when the file carries one, so an exception VEVENT
    // listed first can't stand in for the whole series.
    const item = items.find((it) => it.uid && !it.recurrenceId) || items.find((it) => it.uid) || items[0] || null;
    if (!item) {
      await deleteRecord(id);
      return false;
    }
    const method = effectiveMethod(record, item);

    if (method === 'REPLY') {
      try {
        await applyReply(record, item);
      } catch {
        /* the store write failed — the record is still noise either way */
      }
      await deleteRecord(id);
      return false;
    }
    if (!method || !['REQUEST', 'PUBLISH', 'CANCEL', 'COUNTER'].includes(method)) {
      await deleteRecord(id); // REFRESH, DECLINECOUNTER, or anything unrecognized
      return false;
    }

    if (method === 'COUNTER') {
      const shown = visibleFor(record, item, method);
      cache.set(id, { record, item, method, known: shown });
      pendingViews.set(id, buildViewModel(id, record, item, method, shown));
      return false;
    }

    if (method === 'CANCEL') {
      const applied = autoApply && (await applyCancel(record, item).catch(() => false));
      if (applied) {
        await deleteRecord(id);
        return true;
      }
      const shown = visibleFor(record, item, method);
      cache.set(id, { record, item, method, known: shown });
      pendingViews.set(id, buildViewModel(id, record, item, method, shown));
      return false;
    }

    // REQUEST / PUBLISH — own-echo rule: a REQUEST addressed to our
    // own UID scheme, for an event the user hosts, is our own invitation
    // reflected back through a Puter mailbox. Not a real invitation from
    // anyone — drop it silently, before any trust decision.
    if (method === 'REQUEST' && resolveOwnEcho(item.uid)) {
      await deleteRecord(id);
      return false;
    }

    const known = isKnown(fromEmail);
    if (autoApply && autoAllowed(record, known)) {
      try {
        // null = its UID matched an event this sender may not update; that is
        // a decision for the user, not an automatic overwrite.
        const applied = await applyRequestOrPublish(record, item, method, id);
        if (applied) {
          await deleteRecord(id);
          return true;
        }
      } catch {
        // A failed write (e.g. a rejected offline mutation slipping through a
        // race) leaves the record pending rather than silently dropping it.
      }
    }
    // Unknown senders are cached (so Block still works if shown later) and a
    // view model is always built (so toggling mailInvitesShowUnknown needs no
    // fresh pump), but getPending() filters them out unless the setting says
    // otherwise.
    cache.set(id, { record, item, method, known });
    pendingViews.set(id, buildViewModel(id, record, item, method, known));
    return false;
  }

  /* ---- pump(): list keys only, bounded gets, bounded auto-apply ---------- */

  async function pump() {
    if (blocked()) return; // never attempt a mutation while offline; records just wait
    if (pumping) return pumping;
    pumping = doPump().finally(() => {
      pumping = null;
    });
    return pumping;
  }

  function showUnknown() {
    return Boolean((store.getSettings() || {}).mailInvitesShowUnknown);
  }

  /** Ids currently surfaceable given the live setting. Recomputed from
   *  `pendingViews` on every call, so toggling mailInvitesShowUnknown takes
   *  effect without a fresh pump. */
  function visibleIds() {
    const show = showUnknown();
    const out = new Set();
    for (const [id, view] of pendingViews) if (view.known || show) out.add(id);
    return out;
  }

  async function doPump() {
    // Never on the boot pump (see refreshCorrespondents) — only a pump that
    // runs AFTER the app has already opened once triggers the mailbox crawl.
    const isFirstPump = !pumpedOnce;
    pumpedOnce = true;
    if (!isFirstPump) await refreshCorrespondents();

    const before = visibleIds();
    let keys;
    try {
      keys = await kv.list(INV_PREFIX + '*'); // keys ONLY — never flat-list with values
    } catch {
      return;
    }
    if (!Array.isArray(keys)) return;
    const ids = keys
      .filter((k) => typeof k === 'string' && !tombstones.has(k))
      .sort()
      .reverse() // newest first (ts36 prefix sorts lexically by arrival)
      .slice(0, MAX_TRACKED);

    let pumpApplied = 0;
    for (const id of ids) {
      // Already cached (pending in the tray): nothing to do until the user
      // acts on it.
      if (tombstones.has(id) || cache.has(id)) continue;
      let raw;
      try {
        raw = coerce(await kv.get(id));
      } catch {
        continue;
      }
      if (!raw) {
        tombstones.add(id); // gone already (trimmed, or deleted elsewhere)
        continue;
      }
      // Over budget: still classify and show it, just don't auto-apply this
      // pass. Same code path as under budget — a looser copy here was a way
      // past the prior-interaction gate for anyone whose backlog spent it.
      const overBudget = pumpApplied >= PUMP_APPLY_CAP || sessionApplied >= SESSION_APPLY_CAP;
      const applied = await processRecord(id, raw, { autoApply: !overBudget });
      if (applied) {
        pumpApplied++;
        sessionApplied++;
      }
    }

    // Only a newly VISIBLE row is "detected" — a hidden unknown-sender record
    // must raise no toast and no count.
    const added = [...visibleIds()].filter((id) => !before.has(id)).length;
    notify();
    if (added && !isFirstPump && typeof onDetected === 'function') {
      try {
        onDetected(added);
      } catch {
        /* a listener bug must not fail the pump */
      }
    }
  }

  /* ---- public actions on a pending row ----------------------------------- */

  function getPending() {
    const show = showUnknown();
    return [...pendingViews.values()]
      .filter((v) => v.known || show)
      .sort((a, b) => b.at - a.at)
      .slice(0, TRAY_CAP);
  }

  async function accept(recordId) {
    const entry = cache.get(recordId);
    if (!entry) return false;
    const { record, item, method } = entry;
    const fromEmail = identityOf(record);
    try {
      if (method === 'COUNTER') {
        await store.saveEvent({
          title: item.event.title || record.summary || '',
          description: item.event.description,
          location: item.event.location,
          allDay: item.event.allDay,
          start: item.event.start,
          end: item.event.end,
        });
      } else if (method === 'CANCEL') {
        const stored = item.uid ? findByUid(item.uid) : null;
        // A cancellation is destructive, so the identity check is re-run on the
        // press — not just on the automatic path. A row is only in the tray
        // because that check failed, and a click is not evidence the sender is
        // who they claim: the user is agreeing to a claim, not verifying it.
        if (stored && canCancel(record, stored)) {
          if (item.recurrenceId && stored.recurrence) {
            const slot = resolveOccurrenceSlot(stored, item.recurrenceId.ms);
            if (slot != null) {
              if (item.recurrenceRange === 'THISANDFUTURE') await store.deleteFuture(stored.id, slot);
              else await store.deleteOccurrence(stored.id, slot);
            }
          } else {
            await store.deleteEvent(stored.id);
          }
        }
      } else {
        // The user asked for this one explicitly, so a UID clash makes a
        // separate event rather than refusing (see mayUpdate).
        const saved = await applyRequestOrPublish(record, item, method, recordId, { forceNew: true });
        // A UID-less item writes nothing. Reporting success would take the row
        // away and leave the user with neither an event nor an invitation.
        if (!saved) return false;
      }
    } catch (err) {
      // Offline, or a store write the cloud refused: the invitation stays in
      // the tray and the sender is not added to the allow list. Dropping it in
      // a `finally` lost the invitation on every failed press.
      notify();
      throw err;
    }
    if (fromEmail) await allowAddress(fromEmail);
    await deleteRecord(recordId);
    notify();
    return true;
  }

  async function ignore(recordId) {
    if (!cache.has(recordId)) return false;
    await deleteRecord(recordId);
    notify();
    return true;
  }

  async function blockSender(recordId) {
    const entry = cache.get(recordId);
    if (!entry) return false;
    const fromEmail = identityOf(entry.record);
    if (fromEmail) await blockAddress(fromEmail);
    // Every pending record from that sender goes with it.
    for (const [id, e] of [...cache.entries()]) {
      const email = identityOf(e.record);
      if (email && email === fromEmail) await deleteRecord(id);
    }
    notify();
    return true;
  }

  async function unblock(email) {
    const addr = String(email || '').trim().toLowerCase();
    if (!addr) return;
    await mutateSenders((base) => ({ blocked: base.blocked.filter((e) => e !== addr), allowed: base.allowed }));
  }

  function getBlocked() {
    return [...senders.blocked];
  }

  /* ---- lifecycle ----------------------------------------------------------- */

  function onVisible() {
    if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
    const t = Date.now();
    if (t - lastVisPump < VISIBILITY_PUMP_MS) return;
    lastVisPump = t;
    pump();
  }

  /** Hold the `cal:mail:tick` subscription open exactly while the mailbox is
   *  connected in the background, and not a moment before. */
  function syncTick() {
    const mode = (mailbox && typeof mailbox.status === 'function' && mailbox.status().mode) || 'off';
    const want = mode === 'background';
    if (want === Boolean(tickSub)) return;
    if (!want) {
      try {
        tickSub.off();
      } catch {
        /* teardown is best-effort */
      }
      tickSub = null;
      return;
    }
    try {
      const p = getPuter();
      const appId = p && p.appID;
      if (!appId || !p.events || typeof p.events.onLocal !== 'function') return;
      const sub = p.events.onLocal(`kv:${appId}:cal:mail:tick`, () => pump());
      // onLocal resolves to the subscription; hold whichever form it hands back.
      tickSub = sub && typeof sub.then === 'function' ? { off: () => sub.then((s) => s.off()) } : sub;
    } catch {
      /* not fatal — the visibility pump and mailbox.rescan() still cover it */
    }
  }

  async function start() {
    try {
      senders = await loadSenders();
      blockedSet = new Set(senders.blocked);
      allowedSet = new Set(senders.allowed);
    } catch {
      /* start with empty lists rather than fail boot over a bad KV read */
    }
    try {
      // A local KV read, not a mailbox crawl — safe on the boot path. Makes a
      // correspondents index built in an earlier session available to isKnown()
      // immediately; refreshCorrespondents() (the actual mail scan) is what's
      // gated off boot, from the second pump onward.
      corr = await loadCorrespondents();
      corrSet = new Set(corr.addresses);
    } catch {
      /* start with an empty index rather than fail boot over a bad KV read */
    }

    // The tick subscription opens the events socket, so it is only worth
    // anything once the mailbox is actually connected in the background —
    // otherwise every user on every boot pays for a connection that can never
    // carry a delivery.
    syncTick();
    if (mailbox && typeof mailbox.onChange === 'function') {
      try {
        mailbox.onChange(() => {
          syncTick();
          pump();
        });
      } catch {
        /* best-effort */
      }
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisible);
    }

    await pump();
  }

  function available() {
    return Boolean(mailbox && typeof mailbox.available === 'function' && mailbox.available());
  }

  return {
    start,
    pump,
    getPending,
    accept,
    ignore,
    blockSender,
    unblock,
    undoAdd,
    getBlocked,
    findByUid,
    onChange(fn) {
      if (typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    available,
  };
}
