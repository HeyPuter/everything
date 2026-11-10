/**
 * RSVP links — self-serve guest responses over a per-user Puter worker.
 *
 * The calendar's only backend is puter.kv, which guests (who may have no Puter
 * account at all) can't touch. So each calendar user gets their own serverless
 * worker (`https://cal-<username>.puter.work`, deployed here on first use from
 * the template in src/workers/rsvp-worker.js) that runs under THEIR account and
 * serves per-guest capability URLs: unguessable tokenized links a guest opens
 * to answer Yes / No / Maybe — the industry-standard link-RSVP pattern.
 *
 * Division of state:
 *   - The app's KV keeps the worker config (`cal:rsvp:cfg` — name, url, admin
 *     secret) and, per event, the host's copy of the raw links + a sync digest
 *     (`cal:rsvp:links:<eventId>`). Raw tokens live ONLY here, in the host's
 *     own storage.
 *   - The worker's KV keeps token HASHES and the guests' responses. The app
 *     and the worker share no KV namespace; they talk over the worker's
 *     /admin/* HTTP routes, authenticated with `Bearer <secret>` (the worker
 *     stores only SHA-256(secret)).
 *
 * This module is deliberately hands-off with the rest of the app: it
 * subscribes to the store and diffs — any path that changes a hosted event's
 * guest list or details (editor, series ops, import) triggers a debounced
 * sync; deleted events get their links revoked. Guests' answers are pulled
 * back and merged via store.applyRsvpResponses (newer-timestamp-wins), which
 * is offline-gated like every other write: while offline this module does
 * nothing at all.
 *
 * Guests can also SUGGEST adding someone from their RSVP page. Suggestions
 * live only on the worker (every device pulls the same pending list); this
 * module carries them to the details card (suggestionsFor + onUpdate), toasts
 * ones the host hasn't seen (a KV-kept seen-stamp keeps re-pulls quiet), and
 * settles them — approval is just the host adding the guest (the worker
 * retires the suggestion when the address appears in membership), dismissal
 * goes through dismissSuggestion.
 */
import workerSource from '../workers/rsvp-worker.js?raw';
import { describeRecurrence, expandOccurrences } from './recurrence.js';
import { getUser } from './auth.js';
import { isBlocked } from './offline.js';
import { toast as defaultToast } from './toast.js';

// Bump when src/workers/rsvp-worker.js changes shape: ensureWorker() then
// rewrites the deployed source in place (same URL — sent links survive).
// '2': added the JSON API surface (/api/rsvp/<token>).
// '3': added one-click GET links (/rsvp/<token>/accept|decline|maybe).
// '4': worker serves no HTML — human links redirect to the app's rsvp.html,
//      which renders over the JSON API.
// '5': redirect loop-guard in the worker; deploys are now VERIFIED (see
//      verifyDeployed) before being stamped — also re-heals any worker that
//      shipped with an unsubstituted PAGE_URL during the v4 window.
// '6': hardening — no-store on API responses, event-id alphabet validation,
//      guest-list cap, snapshot guards.
// '7': booking pages — Calendly-style self-serve scheduling served from this
//      same worker (/api/book/*, /api/booking/*, /admin/booking/*); the app
//      side lives in src/js/booking.js and reuses this module's admin channel.
// '8': booking buffers honored against existing bookings' own buffers too
//      (not just the candidate slot's), so no meeting can land inside another
//      booking's protected before/after gap.
// '9': booking emails actually send on the live platform — the bare
//      me.puter.email.send() call is rejected there (the payer must be named
//      via requesterToken); the worker now negotiates the same send forms as
//      email-worker.js, with the host's own token as the self requester.
// '10': meeting links — the RSVP snapshot carries the event's Puter Meetings
//      link (guest page shows a Join row), and booking pages mint one per
//      booking (page.meet), carried through the confirmation email, the .ics,
//      the guest pages, and the admin pull onto the host's calendar event.
// '11': guest suggestions — an invited guest can propose adding someone from
//      their RSVP page (POST /api/rsvp/<token>/guests). Pending suggestions
//      ride back on /admin/sync and /admin/responses; the host approves by
//      simply adding the guest (the worker settles the suggestion on the next
//      read) or turns it down via /admin/suggestions/dismiss.
// '12': admin route event ids held to the same alphabet /admin/sync accepts.
// '13': booking .ics lines fold on whole code points (UTF-8 octet counted), so
//      an emoji on a fold boundary no longer reaches the guest as U+FFFD.
// '14': booking page ids may carry hyphens, so a page can be reached at a
//      readable slug (/book/intro-call) instead of ten random hex digits.
// '15': booking slot times are right ON a DST transition day — the wall-clock
//      conversion re-resolves with the offset in force at the answer, so a
//      page's configured hours are no longer slid an hour (and a slot no
//      longer lost) on the two days a year its zone changes.
// '16': booking .ics quotes its CN params, so a name carrying a colon (or a
//      quote) can no longer close the params early and rewrite the ATTENDEE
//      or ORGANIZER address — matching the app's own ics.js.
// '17': POST /api/book reserves its record BEFORE checking availability, so
//      two guests racing for one slot can no longer both be confirmed, and an
//      off-grid start is refused without writing anything.
// '18': a resubmit by the same guest for the same slot hands their existing
//      booking back instead of "that time was just booked".
// '19': a booking POST that fails partway gives its reservation back, so the
//      host never keeps a booking its guest was told had failed; and a throw
//      on the mail path costs the announcement, not the booking.
// '20': housekeeping and notices can no longer fail the operation they hang
//      off — one undeletable old record stops blocking the whole booking
//      list, and a cancellation stays recorded when its email cannot go.
// '21': a booking page can show the host's profile picture (pushed with the
//      config, served to guests only where that page asked for it).
// '22': a reservation is marked pending until its own slot check passes, so a
//      same-guest double-submit is never answered with "you already hold this
//      booking" pointing at a record the other request is rolling back.
// '23': bookings and RSVP answers are read in one value-carrying list each,
//      not a read per record — a slots request, or the per-minute responses
//      pull, no longer costs as many round-trips as the account has records.
// '24': a URL naming an Object.prototype key — /api/book/constructor, or
//      /rsvp/<token>/constructor — is not found, rather than answered off a
//      plain object's prototype (a "page off" with the host's name, or a
//      "response saved" that saved nothing).
// '25': the booking confirmation mails — the guest's "You're scheduled" and
//      the host's "New booking" — lead with a check in a green disc, so the
//      outcome reads at a glance and in the preview pane, not only in prose.
// '26': a booking sync whose body is not an object is refused (400) instead
//      of being written over the live config as "no pages, no busy time".
// '27': a value-carrying list is re-read in shards when it is heavy by bytes,
//      not only when it is long — puter.kv.list truncates by payload too, and
//      a booking record it dropped is a slot offered twice.
// '28': booking mails go through puter.email.sendTransactional — the send
//      API's current name — falling back to send() on a runtime that still
//      only knows the old one.
// '29': host cancellations email the host a receipt as well as notifying the guest.
// '30': forces each user's RSVP worker to redeploy onto the current runtime
//      (puter.js with email.sendTransactional); /admin/ping reports it as runtime.
// '31': a guest's answer notifies the host through puter.notifications.
export const RSVP_WORKER_VERSION = '32';

const CFG_KEY = 'cal:rsvp:cfg';
const LINKS_PREFIX = 'cal:rsvp:links:';
// Suggestions the host has already been TOLD about ({ "<eventId>:<email>":
// at }) — so a pull that re-delivers the same pending suggestion (they stay
// pending until acted on) doesn't re-toast it on every boot.
const SUGGESTED_SEEN_KEY = 'cal:rsvp:suggestions-seen';
const PULL_MIN_MS = 60_000; // at most one full response pull per minute
// Guests answer from their inbox, so nothing in this app announces a new
// reply — the pull is the only thing that can, and the floor above is a
// floor, not a cadence. Poll gently while the tab is visible (booking.js
// does the same for bookings), and pull when the calendar comes back to
// the front.
const POLL_MS = 60_000;
const USER_RETRY_MS = 5 * 60_000; // how often to re-ask getUser() for a still-missing email
const REFRESH_MIN_MS = 30_000; // per-event card-open refresh throttle
const FAR_FUTURE_MS = 200 * 365 * 86_400_000; // expansion horizon for count-bound series

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

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = '';
  for (const b of buf) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * Subdomain labels to try for this host's worker, best first.
 *
 * The name fronts every booking link the host hands out, so it leads with
 * theirs: `calendar.puter.com/#/nj/intro-call` (the label minus its `cal-`
 * prefix — see linkFor in booking.js) rather than ten random digits. Worker
 * names are global across Puter and immutable once taken, hence the fallbacks
 * — a name someone else holds must cost a nicer URL, never the deploy. A
 * username with nothing usable in it (no Latin letters or digits at all) gets
 * the old random form, which is also what every worker deployed before this
 * keeps: renaming one would strand the links it has already issued.
 */
export function workerNameCandidates(username) {
  const base = String(username == null ? '' : username)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, ''); // the slice can land mid-separator
  const names = [];
  if (base.length >= 2) names.push(`cal-${base}`, `cal-${base}-${randomHex(2)}`);
  names.push(`cal-rsvp-${randomHex(5)}`);
  return names;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  let out = '';
  for (const b of new Uint8Array(buf)) out += b.toString(16).padStart(2, '0');
  return out;
}

function localTz() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

/** When the last chance to respond passes: event end, or the LATEST end of
 *  any occurrence in a bounded series; null for an endless series (the link
 *  never expires). Bounded series are expanded (count is capped at 999 by
 *  normalizeRecurrence) rather than derived from until/count arithmetic,
 *  because a per-occurrence override can move an occurrence PAST the last
 *  scheduled slot — expiring on the schedule alone would lock guests out of
 *  a meeting that is still in the future. */
export function computeExpiresAt(ev) {
  if (!ev.recurrence) return ev.end;
  const rule = ev.recurrence;
  if (rule.until == null && rule.count == null) return null; // endless
  const occs = expandOccurrences(ev, ev.start, ev.start + FAR_FUTURE_MS);
  let latest = ev.end;
  for (const occ of occs) {
    if (Number.isFinite(occ.end) && occ.end > latest) latest = occ.end;
  }
  return latest;
}

export function createRsvpLinks({
  kv,
  store,
  user,
  getPuter = () => (typeof puter !== 'undefined' ? puter : null),
  fetchFn = (...args) => fetch(...args),
  blocked = isBlocked,
  requestUser = getUser,
  toast = defaultToast,
  syncDelayMs = 1500,
  pollMs = POLL_MS,
  pullMinMs = PULL_MIN_MS,
  // The propagation window these poll through is 5–30s wide, so the cadence
  // decides how much of it is spent waiting on a worker that is ALREADY live —
  // and until it lands, every booking share link reads "Preparing your link…".
  // Front-loaded (1.5s, then a widening ramp): a fast propagation is caught
  // within ~1.5s instead of being missed until the 7.5s mark, and the extra
  // attempt keeps the last ping past the 30s tail rather than short of it.
  verifyAttempts = 7,
  verifyDelayMs = 1500,
  createRetryMs = 400,
  // Every admin call runs on a queue that serializes the whole sync pass (see
  // `chain` here and in booking.js), and `fetch` has no timeout of its own: a
  // request that neither answers nor errors — a connection black-holed by a
  // network change, a worker that accepted the socket and went quiet — leaves
  // that queue pending FOREVER. Nothing later in the session runs, so a host
  // watching for a booking to arrive waits for a pass that will never come and
  // has to restart the app. A deadline turns that into one failed pass, which
  // the caller already retries.
  adminTimeoutMs = 25_000,
  // Shorter, because this one is a liveness probe on a ramp of its own: a ping
  // still unanswered after 8s has told us what the next attempt would.
  verifyPingTimeoutMs = 8_000,
  source = workerSource,
  // Where the worker sends humans for UI (it serves none itself). Frozen into
  // the worker at deploy; a version bump redeploys with the current origin.
  pageUrl = (typeof location !== 'undefined' && location.origin && location.origin !== 'null'
    ? location.origin
    : 'https://calendar.puter.com') + '/rsvp.html',
}) {
  let cfg = null;
  let selfEmail = user && typeof user.email === 'string' ? user.email.trim().toLowerCase() : '';
  let started = false;
  let timer = null;
  let pollTimer = null;
  let userAskedAt = -Infinity; // see pass()
  let unsubStore = () => {};
  let chain = Promise.resolve(); // serializes every network pass
  let lastPullAt = 0;
  const links = new Map(); // eventId -> { email: url }
  const digests = new Map(); // eventId -> last-synced digest
  const refreshedAt = new Map(); // eventId -> last targeted refresh
  const suggested = new Map(); // eventId -> [{ email, name, by, at }] pending
  let suggestedSeen = {}; // "<eventId>:<email>" -> at already toasted (in KV)
  let seenLoaded = false; // suggestedSeen persists ONLY once the KV copy was read
  let seenLoading = null;
  // Locally-dismissed suggestions ("<eventId>:<email>" -> when): a pull that
  // was already in flight when the host dismissed still carries the entry and
  // would resurrect the row; the tombstone outlives any such stale response
  // (and the pull throttle), then expires so the worker's truth rules again.
  const dismissedSug = new Map();
  const DISMISS_TOMBSTONE_MS = 5 * 60_000;
  const updateCbs = new Set();

  const offline = () =>
    blocked() || (typeof navigator !== 'undefined' && navigator.onLine === false);

  function notify(eventId) {
    for (const cb of updateCbs) {
      try {
        cb(eventId);
      } catch {
        /* a listener bug must not break syncing */
      }
    }
  }

  /**
   * Adopt a config and announce it if the share links just became mintable.
   * The booking sidebar's copy buttons are gated on workerOrigin(), which is
   * knowable the moment the stored config is read (one KV get at boot) or the
   * moment a deploy verifies — neither of which used to tell anyone. Waiting
   * for the next booking sync POST to carry the news left those buttons sitting
   * on "Preparing your link…" for a full round trip after the link worked, and
   * for up to a poll interval when that POST happened to fail.
   * Listeners take an eventId; this one is about no event in particular, so
   * they see `undefined` and the per-event ones (details card, invites) ignore
   * it exactly as they ignore any other event's id.
   */
  function setCfg(next) {
    const had = Boolean(originOf(cfg));
    cfg = next;
    if (!had && originOf(cfg)) notify();
  }

  /* ---- Which events get links ----------------------------------------- */

  /** Guests who need a link: everyone but the host themself. */
  function linkableGuests(ev) {
    const organizerEmail = ev.organizer ? ev.organizer.email : selfEmail;
    return (Array.isArray(ev.guests) ? ev.guests : []).filter(
      (g) => g.email && g.email !== organizerEmail && g.email !== selfEmail,
    );
  }

  /** An event I host with at least one other guest. Events with a foreign
   *  organizer are invitations TO me — never create links for those. */
  function isHosted(ev) {
    if (!ev || ev.isTask || ev.ooo) return false;
    // A mail-detected REQUEST with no ORGANIZER would otherwise read as ours
    // (organizer === null passes the check below) — minting RSVP links, and
    // spinning up this user's RSVP worker, for a meeting a stranger called.
    if (ev.invite) return false;
    if (ev.organizer && (!selfEmail || ev.organizer.email !== selfEmail)) return false;
    return linkableGuests(ev).length > 0;
  }

  /** What a sync writes to the worker; when unchanged (and no link is
   *  missing) the event is skipped. Guest STATUSES are deliberately absent —
   *  the worker owns those; the app only pushes membership + details. The
   *  display tz / clock format ARE included: they're part of the snapshot,
   *  so changing them must resync the guest pages. */
  function digestOf(ev, guests) {
    return JSON.stringify([
      ev.title,
      ev.start,
      ev.end,
      ev.allDay,
      ev.location,
      ev.description,
      (ev.meeting && ev.meeting.url) || '',
      ev.organizer || null,
      ev.recurrence || null,
      ev.exdates || null,
      localTz(),
      store.getSettings().hour12 !== false,
      guests.map((g) => [g.email, g.name || '']),
    ]);
  }

  /* ---- Worker deployment ------------------------------------------------ */

  function buildSource(secretHash) {
    return source
      .replace('__RSVP_ADMIN_SECRET_HASH__', secretHash)
      .replace('__RSVP_WORKER_VERSION__', RSVP_WORKER_VERSION)
      .replace('__RSVP_PAGE_URL__', pageUrl);
  }

  // Whether the in-memory cfg has definitely reached KV. A cfg that only
  // exists in memory would deploy a duplicate worker after reload — always
  // heal a failed persist before treating the worker as ready.
  let cfgSaved = false;

  async function persistCfg() {
    await kv.set(CFG_KEY, cfg);
    cfgSaved = true;
  }

  async function loadCfg() {
    const stored = coerce(await kv.get(CFG_KEY));
    if (stored && stored.secret) {
      setCfg(stored);
      cfgSaved = true;
    }
    return cfg;
  }

  /**
   * A deploy is not done until the LIVE worker reports the expected version.
   * Never stamp cfg.version from the constant alone: a deploy from a stale
   * module mix once shipped a broken source and stamped itself healthy, which
   * made the (version-gated) upgrade path unable to ever repair it. Polls
   * through the platform's 5–30s propagation window; throws if the worker
   * never comes up on the right version, leaving cfg un-stamped so the next
   * pass rewrites the source again.
   */
  // After a failed verify, hold off redeploy attempts for a cooldown: without
  // it, EVERY admin() call in a pass re-enters the (unstamped) upgrade branch
  // and pays another fs.write + full ping cycle — minutes of churn per pass.
  let verifyBlockedUntil = 0;

  async function verifyDeployed(url, secret) {
    let delay = verifyDelayMs;
    for (let attempt = 0; attempt < verifyAttempts; attempt++) {
      try {
        // Deadline per attempt: this loop is the only thing standing between a
        // half-propagated worker and a deploy that never returns, and it holds
        // the single-flight ensureWorker() promise every admin call awaits.
        const res = await fetchFn(`${url}/admin/ping`, {
          headers: { authorization: `Bearer ${secret}` },
          signal: deadline(verifyPingTimeoutMs),
        });
        if (res.ok) {
          const data = await res.json();
          if (data && data.version === RSVP_WORKER_VERSION) {
            verifyBlockedUntil = 0;
            return;
          }
        }
      } catch {
        /* not propagated yet */
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(8000, delay + 2000);
    }
    verifyBlockedUntil = Date.now() + 120_000;
    throw new Error('rsvp: deployed worker did not come up on the expected version');
  }

  // Single-flight: the RSVP sync chain and the booking module (booking.js)
  // both funnel through admin() → ensureWorker(), and two concurrent
  // first-ever calls must not race two workers into existence from within the
  // same process. (The cross-tab race is handled inside, via adoptWinner.)
  let ensuring = null;

  function ensureWorker() {
    if (!ensuring) {
      ensuring = ensureWorkerInner().finally(() => {
        ensuring = null;
      });
    }
    return ensuring;
  }

  /** The origin to build guest links on, or null while none is serveable. */
  function originOf(c) {
    return c && c.url && workerVersionOk(c.version) ? c.url : null;
  }

  /** True when the deployed worker already serves everything this bundle
   *  needs: our exact version, or a NEWER one (numerically). A newer client
   *  owns the worker — rewriting it from here would delete routes its links
   *  depend on, and the two bundles would flap the deployment between
   *  versions on every sync pass. */
  function workerVersionOk(version) {
    if (version === RSVP_WORKER_VERSION) return true;
    const deployed = Number(version);
    const ours = Number(RSVP_WORKER_VERSION);
    return Number.isFinite(deployed) && Number.isFinite(ours) && deployed > ours;
  }

  async function ensureWorkerInner(depth = 0) {
    // Never trust a missing in-memory copy: deploying a second worker would
    // orphan every link the first one issued. Re-read the config first.
    if (!cfg) await loadCfg();
    if (cfg && cfg.secret && cfg.url && workerVersionOk(cfg.version)) {
      if (!cfgSaved) await persistCfg();
      return cfg;
    }

    const p = getPuter();
    if (!p || !p.workers || !p.fs) throw new Error('rsvp: Puter workers are unavailable');

    if (cfg && cfg.secret && cfg.name) {
      // Version upgrade: overwrite the source file in place — the worker keeps
      // its URL, so every link already sent out survives.
      if (Date.now() < verifyBlockedUntil) {
        throw new Error('rsvp: worker deploy pending (cooling down after a failed verify)');
      }
      const code = buildSource(await sha256Hex(cfg.secret));
      let path = 'rsvp-worker.js';
      try {
        const info = await p.workers.get(cfg.name);
        if (info && info.file_path) path = info.file_path;
      } catch {
        /* fall back to the original path */
      }
      await p.fs.write(path, code, { createMissingParents: true });
      await verifyDeployed(cfg.url, cfg.secret);
      setCfg({ ...cfg, version: RSVP_WORKER_VERSION });
      await persistCfg();
      return cfg;
    }

    // First use: mint the admin secret; only its hash goes into the source.
    if (Date.now() < verifyBlockedUntil) {
      throw new Error('rsvp: worker deploy pending (cooling down after a failed verify)');
    }
    const secret = randomHex(32);
    const code = buildSource(await sha256Hex(secret));
    const filePath = 'rsvp-worker.js';
    await p.fs.write(filePath, code, { createMissingParents: true });
    let lastErr = null;
    const names = workerNameCandidates(user && user.username);
    for (let attempt = 0; attempt < names.length; attempt++) {
      // Another tab/device may have deployed while we prepared — adopt theirs
      // rather than racing a second worker into existence.
      if (depth < 2 && (await loadCfg().catch(() => null))) return ensureWorkerInner(depth + 1);
      const name = names[attempt];
      let dep;
      try {
        dep = await p.workers.create(name, filePath);
      } catch (err) {
        // The platform doesn't say WHY a create failed, and the first name is
        // the one worth having — a worker can never be renamed, so a blip that
        // is read as "taken" costs the host their own name for good. One retry
        // tells the two apart: a name someone else holds fails both times, a
        // blip usually doesn't.
        await new Promise((resolve) => setTimeout(resolve, createRetryMs));
        try {
          dep = await p.workers.create(name, filePath);
        } catch (err2) {
          lastErr = err2; // taken (or down) — fall to the next candidate
          continue;
        }
      }
      const url = String((dep && dep.url) || `https://${name}.puter.work`).replace(/\/+$/, '');
      // Persist BEFORE verifying, with a null version: the worker must never
      // be orphaned (a re-run would deploy a duplicate), and a null version
      // routes the next ensureWorker() into the self-healing upgrade branch.
      cfg = { name, url, secret, version: null, createdAt: Date.now() };
      cfgSaved = false;
      try {
        await persistCfg();
      } catch {
        /* healed by the cfgSaved check on the next ensureWorker() */
      }
      // Close the race window: if another tab's cfg won the KV write, adopt
      // it and drop our just-created (still linkless) worker. Checked twice —
      // here, and again after the (5–30s) verify wait, so a tab that started
      // deploying inside that window is also detected before we stamp ours
      // over its config.
      const adoptWinner = async () => {
        const winner = coerce(await kv.get(CFG_KEY));
        if (!winner || !winner.secret || !winner.name || winner.name === name) return false;
        if (typeof p.workers.delete === 'function') {
          await p.workers.delete(name).catch(() => {});
        }
        setCfg(winner);
        cfgSaved = true;
        return true;
      };
      try {
        if (await adoptWinner()) return cfg;
      } catch {
        /* keep ours */
      }
      await verifyDeployed(url, secret);
      try {
        if (await adoptWinner()) return cfg;
      } catch {
        /* keep ours */
      }
      setCfg({ ...cfg, version: RSVP_WORKER_VERSION });
      await persistCfg();
      return cfg;
    }
    throw lastErr || new Error('rsvp: could not deploy the RSVP worker');
  }

  /** A deadline for one request, or undefined where the environment has no
   *  AbortSignal to give (then the call is simply unbounded, as before). */
  function deadline(ms) {
    if (!(ms > 0)) return undefined;
    try {
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        return AbortSignal.timeout(ms);
      }
      if (typeof AbortController === 'function') {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), ms);
        return ac.signal;
      }
    } catch {
      /* fall through — no signal is better than no request */
    }
    return undefined;
  }

  async function admin(path, body) {
    const c = await ensureWorker();
    const res = await fetchFn(c.url + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${c.secret}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: deadline(adminTimeoutMs),
    });
    if (!res.ok) {
      // The status rides on the error too: some callers need to tell "the
      // worker has no such record" (404 — nothing to do, stop asking) from a
      // transport failure (retry).
      const err = new Error(`rsvp: ${path} failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  /* ---- Sync passes ------------------------------------------------------- */

  async function applyResponses(eventId, guestMap) {
    const responses = Object.entries(guestMap || {}).map(([email, r]) => ({
      email,
      status: r && r.status,
      respondedAt: r && r.respondedAt,
      comment: r && r.comment,
    }));
    if (!responses.length) return;
    const updated = await Promise.resolve(store.applyRsvpResponses(eventId, responses)).catch(
      () => null,
    );
    if (updated) notify(eventId);
  }

  /**
   * Take the worker's word on an event's pending guest suggestions. The
   * worker is the source of truth (suggestions never live in the app's own
   * KV — every device pulls the same list); this keeps a filtered in-memory
   * copy for the details card and toasts the ones the host hasn't been told
   * about yet. Notifies only on a real change, like syncEvent — a pull that
   * re-delivers the same pending list must not rebuild the open card.
   */
  function applySuggestions(eventId, list) {
    const ev = store.getEvent(eventId);
    if (!ev) return;
    const members = new Set((Array.isArray(ev.guests) ? ev.guests : []).map((g) => g.email));
    const organizerEmail = ev.organizer ? ev.organizer.email : selfEmail;
    const seen = new Set();
    const clean = [];
    for (const s of Array.isArray(list) ? list : []) {
      const email = s && typeof s.email === 'string' ? s.email.trim().toLowerCase() : '';
      // Already-member entries can slip through when this pull raced the
      // approval's own sync; they're settled, not pending.
      if (!email || seen.has(email)) continue;
      if (members.has(email) || email === organizerEmail || email === selfEmail) continue;
      // Just dismissed here: a response computed before the dismissal reached
      // the worker must not resurrect the row.
      if (Date.now() - (dismissedSug.get(`${eventId}:${email}`) || -Infinity) < DISMISS_TOMBSTONE_MS) {
        continue;
      }
      seen.add(email);
      clean.push({
        email,
        name: typeof s.name === 'string' ? s.name.trim().slice(0, 200) : '',
        by: typeof s.by === 'string' ? s.by.trim().toLowerCase() : '',
        at: Number.isFinite(s.at) ? s.at : 0,
      });
    }
    const before = suggested.get(eventId) || [];
    if (JSON.stringify(clean) === JSON.stringify(before)) return;
    if (clean.length) suggested.set(eventId, clean);
    else suggested.delete(eventId);
    announceSuggestions(eventId, ev.title, clean); // async, self-contained
    notify(eventId);
  }

  /** Read the seen-stamps from KV (once — single-flight), merging them under
   *  any stamps this session already made and dropping entries of deleted
   *  events. Only a SUCCESSFUL read arms persistence: overwriting the stored
   *  map from a session that never saw it would discard every prior stamp. */
  function loadSeenOnce() {
    if (seenLoaded) return Promise.resolve();
    if (!seenLoading) {
      seenLoading = (async () => {
        const stored = coerce(await kv.get(SUGGESTED_SEEN_KEY));
        // An empty store may just mean "not loaded" (offline boot) — only a
        // store that really loaded may declare an event's stamps stale.
        const canPrune = store.revision() !== null;
        if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
          for (const [key, at] of Object.entries(stored)) {
            if (!Number.isFinite(at) || key in suggestedSeen) continue;
            // Event ids carry no ':' (uid() alphabet), so the first one ends the id.
            if (canPrune && !store.getEvent(key.slice(0, key.indexOf(':')))) continue;
            suggestedSeen[key] = at;
          }
        }
        seenLoaded = true;
      })().finally(() => {
        seenLoading = null;
      });
    }
    return seenLoading;
  }

  /** Toast the suggestions this account has never been shown (tracked in KV,
   *  so a suggestion that arrived while the app was closed still announces
   *  itself once — and only once — after the next boot's pull). */
  async function announceSuggestions(eventId, title, list) {
    // The boot read may have failed (offline start); retry before judging
    // freshness. If KV stays unreadable, still announce — a repeat toast
    // beats a silent one — but never persist over the stored map.
    await loadSeenOnce().catch(() => {});
    const fresh = list.filter((s) => s.at > (suggestedSeen[`${eventId}:${s.email}`] || 0));
    if (!fresh.length) return;
    for (const s of fresh) suggestedSeen[`${eventId}:${s.email}`] = s.at;
    if (seenLoaded) kv.set(SUGGESTED_SEEN_KEY, suggestedSeen).catch(() => {});
    const name = title ? `“${title}”` : 'your event';
    toast(
      fresh.length === 1
        ? `${fresh[0].by || 'A guest'} suggested adding ${fresh[0].email} to ${name} — open the event to review.`
        : `${fresh.length} guest suggestions for ${name} — open the event to review.`,
    );
  }

  async function pull() {
    const data = await admin('/admin/responses');
    lastPullAt = Date.now();
    for (const [id, entry] of Object.entries(data.events || {})) {
      if (!store.getEvent(id)) continue;
      await applyResponses(id, entry.guests);
      applySuggestions(id, entry.suggestions);
    }
  }

  async function syncEvent(ev, guests, digest) {
    const c = await ensureWorker();
    // Reissue a guest's link ONLY when it is missing from both the in-memory
    // cache and a fresh point-read of the KV copy. A flat kv.list can silently
    // drop keys (see store.js), and a reissue kills the link the host already
    // sent out — never let a lossy cache load trigger that. Two hard rules:
    //   - A FAILED read aborts the sync (throw → retried later). Treating
    //     "couldn't read" as "nothing stored" would authorize a mass reissue.
    //   - On divergence the STORED copy wins: KV is shared across devices, so
    //     a difference means another device wrote (e.g. reissued) after this
    //     one last looked — its links are the live ones.
    let have = links.get(ev.id) || {};
    const linksBefore = JSON.stringify(have);
    const stored = coerce(await kv.get(LINKS_PREFIX + ev.id));
    if (stored && stored.links) have = { ...have, ...stored.links };
    const reissue = guests.filter((g) => !have[g.email]).map((g) => g.email);
    const data = await admin('/admin/sync', {
      event: {
        id: ev.id,
        title: ev.title,
        start: ev.start,
        end: ev.end,
        allDay: ev.allDay,
        location: ev.location,
        description: ev.description,
        // The guest page's Join row. Pushed as-is; the worker holds it to the
        // exact Puter Meetings shape (an imported foreign URL is dropped there,
        // same policy as the email worker).
        meetingUrl: (ev.meeting && ev.meeting.url) || '',
        organizerName: (ev.organizer && ev.organizer.name) || '',
        organizerEmail: (ev.organizer && ev.organizer.email) || selfEmail,
        recurLabel: ev.recurrence ? describeRecurrence(ev.recurrence, ev.start) : '',
        expiresAt: computeExpiresAt(ev),
        tz: localTz(),
        hour12: store.getSettings().hour12 !== false,
      },
      guests: guests.map((g) => ({ email: g.email, name: g.name || '' })),
      reissue,
    });
    const map = { ...have };
    for (const [email, token] of Object.entries(data.links || {})) {
      map[email] = `${c.url}/rsvp/${token}`;
    }
    for (const email of Object.keys(map)) {
      if (!guests.some((g) => g.email === email)) delete map[email];
    }
    // Persist the host's only copy of the raw links BEFORE marking the event
    // synced: if this write fails, the event stays dirty and the whole sync
    // (including the token mint) is redone — a digest marked early would leave
    // the fresh links memory-only and dead after reload.
    const linksChanged = JSON.stringify(map) !== linksBefore;
    if (linksChanged || digests.get(ev.id) !== digest) {
      await kv.set(LINKS_PREFIX + ev.id, { links: map, digest });
    }
    links.set(ev.id, map);
    digests.set(ev.id, digest);
    await applyResponses(ev.id, data.guests);
    applySuggestions(ev.id, data.suggestions);
    // Notify ONLY on a real link change — applyResponses and applySuggestions
    // already notify when something merged. An unconditional notify here made
    // the details card rebuild (visible flicker) on every open, since opening
    // triggers a refresh that usually changes nothing.
    if (linksChanged) notify(ev.id);
  }

  async function revoke(eventId) {
    await admin('/admin/revoke', { eventId });
    links.delete(eventId);
    digests.delete(eventId);
    suggested.delete(eventId);
    await kv.del(LINKS_PREFIX + eventId).catch(() => {});
    notify(eventId);
  }

  /** One full reconcile: revoke links of gone events, pull fresh responses,
   *  push every hosted event whose membership/details changed. Returns the
   *  number of operations that failed (a fresh worker takes 5–30s to
   *  propagate, so the first sync after a deploy often needs the retry). */
  async function pass() {
    if (offline()) return 0;
    let failed = 0;
    // The organizer stamp on my own events needs my email; if Puter's grant
    // landed since boot, getUser() now includes it (no prompt is triggered).
    // A network call, and passes now run every minute — re-ask every few
    // minutes rather than on every pass for the whole session.
    if (!selfEmail && Date.now() - userAskedAt >= USER_RETRY_MS) {
      userAskedAt = Date.now();
      const fresh = await Promise.resolve(requestUser()).catch(() => null);
      if (fresh && typeof fresh.email === 'string' && fresh.email) {
        selfEmail = fresh.email.trim().toLowerCase();
      }
    }
    const hosted = store.getAllEvents().filter(isHosted);
    const liveIds = new Set(hosted.map((ev) => ev.id));

    // Revoking destroys guest links AND their stored answers on the worker, so
    // it takes positive evidence: the event is gone, can't carry links, or is
    // verifiably mine with nobody left to invite. "Not hosted" alone is NOT
    // enough — on a boot where my email is unknown, every organizer-stamped
    // event fails isHosted, and treating that as deletion would mass-revoke
    // every link ever sent.
    function shouldRevoke(id) {
      const ev = store.getEvent(id);
      if (!ev) return true; // deleted
      if (ev.isTask || ev.ooo) return true; // can never carry guest links
      if (ev.organizer && (!selfEmail || ev.organizer.email !== selfEmail)) return false;
      return linkableGuests(ev).length === 0; // mine, all guests removed
    }

    if (cfg || links.size) {
      for (const id of [...links.keys()]) {
        if (liveIds.has(id) || !shouldRevoke(id)) continue;
        try {
          await revoke(id);
        } catch (err) {
          failed += 1;
          console.warn('rsvp: revoke failed', err);
        }
      }
    }

    // Pulling requires an already-deployed worker; never deploy just to pull.
    if (!cfg) await loadCfg().catch(() => null);
    if (cfg && hosted.length && Date.now() - lastPullAt >= pullMinMs) {
      try {
        await pull();
      } catch (err) {
        failed += 1;
        console.warn('rsvp: pull failed', err);
      }
    }

    for (const ev of hosted) {
      const guests = linkableGuests(ev);
      const digest = digestOf(ev, guests);
      const have = links.get(ev.id) || {};
      const missingLink = guests.some((g) => !have[g.email]);
      if (digests.get(ev.id) === digest && !missingLink) continue;
      try {
        await syncEvent(ev, guests, digest);
      } catch (err) {
        failed += 1;
        console.warn('rsvp: sync failed for event', ev.id, err);
      }
    }
    return failed;
  }

  let failStreak = 0;
  let retryTimer = null;

  function run() {
    chain = chain
      .then(async () => {
        const failed = await pass();
        if (!failed) {
          failStreak = 0;
          return;
        }
        // Bounded backoff so a just-deployed worker's propagation window (or
        // a flaky connection) heals without waiting for the next user action.
        if (failStreak >= 6) return;
        failStreak += 1;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          retryTimer = null;
          run();
        }, Math.min(30_000, 5_000 * failStreak));
      })
      .catch(() => {});
    return chain;
  }

  function schedule() {
    // A fresh store change deserves a fresh retry budget — otherwise one
    // permanently-failing event exhausts the streak and unrelated NEW events
    // never get their transient failures retried.
    failStreak = 0;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      run();
    }, syncDelayMs);
  }

  /** Coming back to the calendar is the moment to have the latest answers. */
  function onVisible() {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (offline()) return;
    run();
  }

  /* ---- Public API ------------------------------------------------------- */

  async function start() {
    if (started) return;
    started = true;
    try {
      await loadCfg();
      const entries = (await kv.list(`${LINKS_PREFIX}*`, true)) || [];
      for (const entry of entries) {
        if (!entry || typeof entry.key !== 'string') continue;
        const value = coerce(entry.value);
        if (!value || typeof value !== 'object') continue;
        const id = entry.key.slice(LINKS_PREFIX.length);
        links.set(id, value.links || {});
        if (typeof value.digest === 'string') digests.set(id, value.digest);
      }
    } catch {
      /* offline boot — ensureWorker re-reads the config before ever deploying */
    }
    // Separate from the block above: a cfg/link-cache failure must not skip
    // this, and its own failure re-tries lazily at announce time.
    await loadSeenOnce().catch(() => {});
    unsubStore = store.subscribe(schedule);
    // Answers arrive from outside: poll while the tab is visible, and pull on
    // coming back to the calendar (visibilitychange for a hidden tab, focus
    // for the app's own window inside the Puter desktop, where switching
    // windows never hides the tab). The pull floor bounds what these can ask.
    pollTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (offline()) return;
      run();
    }, pollMs);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    if (typeof window !== 'undefined') window.addEventListener('focus', onVisible);
    schedule();
  }

  /** The host's copy of this event's links ({ email: url }), or null.
   *  A defensive copy — callers must never be able to mutate the cache. */
  function linksFor(eventId) {
    const map = links.get(eventId);
    return map ? { ...map } : null;
  }

  /** Card-open hook: push/refresh one event now (throttled) so the open card
   *  shows fresh guest answers and newly-prepared links. */
  function refreshEvent(eventId) {
    if (offline()) return Promise.resolve();
    const ev = store.getEvent(eventId);
    if (!ev || !isHosted(ev)) return Promise.resolve();
    const last = refreshedAt.get(ev.id) || 0;
    if (Date.now() - last < REFRESH_MIN_MS) return Promise.resolve();
    refreshedAt.set(ev.id, Date.now());
    chain = chain
      .then(() => syncEvent(ev, linkableGuests(ev), digestOf(ev, linkableGuests(ev))))
      .catch((err) => console.warn('rsvp: refresh failed', err));
    return chain;
  }

  function onUpdate(cb) {
    updateCbs.add(cb);
    return () => updateCbs.delete(cb);
  }

  /** Pending guest suggestions for this event's details card, re-filtered
   *  against the CURRENT guest list: the instant an approval saves, the row
   *  disappears — without waiting for the worker sync to settle the key. */
  function suggestionsFor(eventId) {
    const list = suggested.get(eventId);
    if (!list || !list.length) return [];
    const ev = store.getEvent(eventId);
    const members = new Set(
      ev && Array.isArray(ev.guests) ? ev.guests.map((g) => g.email) : [],
    );
    return list.filter((s) => !members.has(s.email)).map((s) => ({ ...s }));
  }

  /** The host turned a suggestion down: settle it on the worker, then drop it
   *  locally. Throws a toast-ready message when the worker can't be reached —
   *  a dismissal that only happened locally would resurrect on the next pull. */
  async function dismissSuggestion(eventId, email) {
    if (offline()) throw new Error("You're offline — reconnect to make changes.");
    await admin('/admin/suggestions/dismiss', { eventId, email });
    // Tombstone AFTER the worker confirmed: a pull that left before the
    // dismissal landed would otherwise re-insert the row (see applySuggestions).
    dismissedSug.set(`${eventId}:${email}`, Date.now());
    const rest = (suggested.get(eventId) || []).filter((s) => s.email !== email);
    if (rest.length) suggested.set(eventId, rest);
    else suggested.delete(eventId);
    notify(eventId);
  }

  function stop() {
    if (timer) clearTimeout(timer);
    if (retryTimer) clearTimeout(retryTimer);
    if (pollTimer) clearInterval(pollTimer);
    timer = retryTimer = pollTimer = null;
    unsubStore();
    unsubStore = () => {};
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    if (typeof window !== 'undefined') window.removeEventListener('focus', onVisible);
    started = false;
  }

  return {
    start,
    stop,
    isHosted,
    linkableGuests,
    linksFor,
    refreshEvent,
    onUpdate,
    suggestionsFor,
    dismissSuggestion,
    /** The worker's admin channel, shared with the booking module: an
     *  authenticated request to the per-user worker, deploying/upgrading it
     *  first when needed. POST when `body` is given, GET otherwise. */
    adminRequest: admin,
    /** The deployed worker's origin (`https://cal-rsvp-….puter.work`), or null
     *  until one exists ON A VERSION that serves the booking routes — booking
     *  share links are built on it, and handing one out while an older
     *  deployment is still being upgraded in place would 404 every guest. */
    workerOrigin: () => originOf(cfg),
    /** Tests: resolves when every queued network pass has settled. */
    whenIdle: () => chain,
  };
}
