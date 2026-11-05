/**
 * RSVP + booking endpoint — a Puter serverless worker deployed into the
 * calendar user's own account (see src/js/rsvp-links.js for the deploy/sync
 * side, and src/js/booking.js for the booking side).
 *
 * Guests hold capability URLs: /rsvp/<token>, one unguessable 160-bit token per
 * guest per event. Only a SHA-256 hash of each token is stored, so a leak of
 * this worker's KV reveals no usable links; the raw token exists only in the
 * link itself (and in the host's private link cache in the calendar app).
 *
 * This worker serves NO HTML — it is a JSON API plus redirects (Puter
 * guidance: workers as API-like endpoints). All human-facing UI lives on the
 * calendar app's own static hosting at PAGE_URL (public/rsvp.html), which
 * calls this API from the guest's browser.
 *
 *   JSON API (the only data surface):
 *     GET  /api/rsvp/<token>        -> invitation details + current answer
 *                                      (+ this guest's own pending suggestions)
 *     POST /api/rsvp/<token>        -> { status, comment? } records an answer
 *     PUT  /api/rsvp/<token>        -> same as POST (idempotent set)
 *     POST /api/rsvp/<token>/guests -> { email, name? } suggests adding a
 *       guest. Suggestions are proposals, not invitations: the organizer
 *       reviews them in the calendar app and only their approval puts anyone
 *       on the guest list (which is also what mails the actual invitation).
 *   Errors are JSON with machine-readable codes (not_found, event_ended,
 *   invalid_status, invalid_email, already_invited, suggestion_limit) and
 *   matching HTTP statuses (404 / 410 / 400 / 409 / 429).
 *
 *   Human links (both 303-redirect to PAGE_URL#w=<worker>&t=<token>):
 *     GET /rsvp/<token>                       — just redirects; the page
 *       fetches the invitation over the API and renders the buttons.
 *     GET /rsvp/<token>/accept|decline|maybe  — self-contained one-click:
 *       records the answer FIRST, then redirects (with &s=1 so the page shows
 *       "Response saved"). Because a GET that mutates is exactly what email
 *       scanners and chat unfurlers (Slack, SafeLinks, iMessage previews…)
 *       trip over, requests that look like prefetchers — bot user-agents,
 *       missing user-agent, or an explicit prefetch/preview Purpose header —
 *       are redirected WITHOUT recording. Same tradeoff and mitigation
 *       Google Calendar's emailed one-click RSVP links use.
 *
 * The calendar app manages this worker over /admin/* routes, authenticated
 * with `Authorization: Bearer <secret>`. Only SHA-256(secret) is baked into
 * this source (below), so the deployed file itself contains no credential.
 *
 * KV layout (this worker's own namespace):
 *   rsvpw:tok:<sha256(token)>       -> { eventId, email }
 *   rsvpw:evt:<eventId>             -> { snapshot, guests: { [email]:
 *                                        { name, tokenHash } }, updatedAt }
 *   rsvpw:resp:<eventId>:<email>    -> { status, comment, respondedAt }
 *   rsvpw:sug:<eventId>:<email>     -> { email, name, by, at } — a pending
 *                                      guest suggestion, keyed by the PROPOSED
 *                                      address (re-suggesting is idempotent)
 *
 * Responses live in per-guest keys ON PURPOSE: a guest's POST writes only
 * their own key, so it can never race an /admin/sync (which rewrites the
 * membership record) or another guest's answer — no shared read-modify-write.
 * Suggestions get the same treatment for the same reason; a suggestion is
 * settled the moment its address shows up in membership (the organizer
 * approved, or invited them independently) — every read filters settled
 * entries out, and their keys are deleted on the next /admin/sync (the one
 * path that grows membership) or by /admin/suggestions/dismiss.
 *
 * This worker ALSO serves the calendar's Calendly-style booking pages — the
 * second half of this file. Same account, same admin secret, same deploy
 * pipeline; see the "Booking" banner comment below for its routes and KV.
 */

/* Placeholders replaced at deploy time by rsvp-links.js. */
const ADMIN_SECRET_HASH = '__RSVP_ADMIN_SECRET_HASH__';
const WORKER_VERSION = '__RSVP_WORKER_VERSION__';
const PAGE_URL = '__RSVP_PAGE_URL__'; // the app-hosted RSVP page (public/rsvp.html)
// A booking page id is the last segment of the link its host hands out, so it
// is held to what reads and travels well: 4-32 of [a-z0-9], hyphens inside.
// Kept in step with PAGE_ID_RE in src/js/booking.js and public/book.html.
const PAGE_ID_RE = /^[a-z0-9][a-z0-9-]{2,30}[a-z0-9]$/;

const TOK_PREFIX = 'rsvpw:tok:';
const EVT_PREFIX = 'rsvpw:evt:';
const RESP_PREFIX = 'rsvpw:resp:';
const SUG_PREFIX = 'rsvpw:sug:';
const RESPONSE_STATUSES = ['accepted', 'declined', 'tentative'];
const MAX_COMMENT = 500;
// Pending guest suggestions per event. Guests are semi-trusted (they hold a
// real capability link) but this still bounds what one prankster can queue up
// for the organizer to wade through.
const MAX_SUGGESTIONS = 10;

/* ---- Small utilities --------------------------------------------------- */

/** The puter.js build the platform baked into this deploy (its preamble's
 *  first line). Null under the test harness, which has no preamble. */
function workerRuntime() {
  return typeof __PUTER_PREAMBLE_VERSION__ === 'string' ? __PUTER_PREAMBLE_VERSION__ : null;
}

function kvOf(ctx) {
  const owner = (ctx && ctx.me) || (typeof me !== 'undefined' ? me : null);
  return owner.puter.kv;
}

function respKey(eventId, email) {
  return `${RESP_PREFIX}${eventId}:${email}`;
}

function sugKey(eventId, email) {
  return `${SUG_PREFIX}${eventId}:${email}`;
}

/** puter.kv values may come back as parsed objects or JSON strings. */
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

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  let out = '';
  for (const b of new Uint8Array(buf)) out += b.toString(16).padStart(2, '0');
  return out;
}

/** 20 crypto-random bytes as 40 hex chars (160 bits — unguessable). */
function newToken() {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * The value if it is exactly a Puter Meetings room link, else ''. The RSVP
 * page and the booking emails render this as a clickable "Join" link, and
 * meeting URLs reach this worker from outside (the app pushes whatever an
 * imported ICS carried) — held to the exact room-link shape so a foreign URL
 * can never be served or mailed under the calendar's name. Both live code
 * forms: 3-4-3 (classic) and 4-4-4 (open — what mintMeetingUrl makes).
 * (meetings.js and email-worker.js keep their own copies of this test: the
 * workers deploy as single files and cannot import it.)
 */
function meetingLink(value) {
  if (typeof value !== 'string' || value.length > 100) return '';
  return /^https:\/\/meetings\.puter\.com\/#\/m\/(?:[a-z]{3}-[a-z]{4}-[a-z]{3}|[a-z]{4}-[a-z]{4}-[a-z]{4})$/.test(value)
    ? value
    : '';
}

/**
 * Mint an open Puter Meetings room link — the same stateless recipe the app's
 * meetings.js follows (see its header): 12 crypto-random lowercase letters,
 * grouped abcd-efgh-ijkl, wrapped in the Meetings URL. Nothing exists anywhere
 * until someone opens the link and starts the meeting, so minting here is
 * synchronous and free, and a cancelled booking's link simply never was.
 * Rejection sampling: 256 % 26 !== 0, so a bare modulo would skew the letters.
 */
function mintMeetingUrl() {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const limit = 256 - (256 % letters.length);
  const out = [];
  while (out.length < 12) {
    const bytes = crypto.getRandomValues(new Uint8Array(12 - out.length));
    for (const byte of bytes) {
      if (byte < limit) out.push(letters[byte % letters.length]);
    }
  }
  const code = `${out.slice(0, 4).join('')}-${out.slice(4, 8).join('')}-${out.slice(8, 12).join('')}`;
  return `https://meetings.puter.com/#/m/${code}`;
}

/**
 * Every key under a prefix. puter.kv.list silently truncates large result
 * sets (observed ~1k entries), so when the flat result is big enough to be
 * suspect, fan out one sub-list per hex char and merge — every event id from
 * the app starts with a lowercase hex char.
 */
async function listAllKeys(kv, prefix) {
  const flat = (await kv.list(`${prefix}*`)) || [];
  if (flat.length < 400) return flat;
  const merged = new Set(flat);
  for (const c of '0123456789abcdef') {
    for (const key of (await kv.list(`${prefix}${c}*`)) || []) merged.add(key);
  }
  return [...merged];
}

// The cut point of a truncated list scales with the size of the values, not
// only their number (store.js documents the live observation): a few hundred
// booking records carrying 2,000-character notes weigh what a couple of
// thousand bare keys do. So a value-carrying list is suspect by bytes as
// well as by count — the same guard the app applies to its own calendar.
const LIST_SUSPECT_BYTES = 512 * 1024;

function looksTruncated(entries) {
  if (entries.length >= 400) return true;
  let bytes = 0;
  for (const e of entries) {
    const v = e && e.value;
    bytes += new TextEncoder().encode(typeof v === 'string' ? v : v ? JSON.stringify(v) : '').length;
    if (bytes >= LIST_SUSPECT_BYTES) return true;
  }
  return false;
}

/** listAllKeys for value-carrying lists: same truncation fan-out, same
 *  hex-first-char assumption, deduped by key — suspect by payload size too,
 *  since a missing booking record is a slot offered twice. */
async function listAllEntries(kv, prefix) {
  const flat = (await kv.list(`${prefix}*`, true)) || [];
  if (!looksTruncated(flat)) return flat;
  const merged = new Map();
  for (const entry of flat) {
    if (entry && typeof entry.key === 'string') merged.set(entry.key, entry);
  }
  for (const c of '0123456789abcdef') {
    for (const entry of (await kv.list(`${prefix}${c}*`, true)) || []) {
      if (entry && typeof entry.key === 'string') merged.set(entry.key, entry);
    }
  }
  return [...merged.values()];
}

function lowerEmail(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254 ? s : '';
}

function str(v, cap) {
  return typeof v === 'string' ? v.slice(0, cap) : '';
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      // Invitation payloads carry personal data and are keyed by capability
      // URLs — nothing here may be cached by proxies or the browser.
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

/** Send the visitor to the app-hosted RSVP page. The worker origin + token
 *  travel in the URL FRAGMENT, which browsers never send over the wire — the
 *  capability token stays out of server logs and referrer headers. */
function redirectToPage(ctx, token, saved) {
  // Belt and braces: if a botched deploy left PAGE_URL non-absolute (e.g. the
  // raw placeholder), a relative Location would resolve back onto this very
  // route and redirect-loop forever. Fall back to the production page.
  const page = /^https?:\/\//i.test(PAGE_URL) ? PAGE_URL : 'https://calendar.puter.com/rsvp.html';
  const params = new URLSearchParams({ w: new URL(ctx.request.url).origin, t: token });
  if (saved) params.set('s', '1');
  return new Response(null, {
    status: 303,
    headers: {
      location: `${page}#${params.toString()}`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}

/* ---- Admin auth --------------------------------------------------------- */

async function isAdmin(request) {
  const header = request.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+(\S+)$/i);
  if (!match) return false;
  // Hash-then-compare: the plaintext secret is never in this file, and the
  // comparison leaks nothing useful about it.
  return (await sha256Hex(match[1])) === ADMIN_SECRET_HASH;
}

/* ---- Event snapshot (what the guest page may show) ---------------------- */

// Beyond ±8.64e15 (±100M days) `new Date(ms)` is invalid and date formatting
// throws — clamp stored instants so a poisoned snapshot can't make every
// guest's later read of it blow up instead of rendering.
const MAX_INSTANT_MS = 8.64e15;

function instant(value, fallback) {
  return Number.isFinite(value) && Math.abs(value) <= MAX_INSTANT_MS ? Math.round(value) : fallback;
}

function sanitizeSnapshot(event) {
  return {
    title: str(event.title, 500),
    start: instant(event.start, 0),
    end: instant(event.end, 0),
    allDay: Boolean(event.allDay),
    location: str(event.location, 500),
    description: str(event.description, 2000),
    meetingUrl: meetingLink(event.meetingUrl),
    organizerName: str(event.organizerName, 200),
    organizerEmail: lowerEmail(event.organizerEmail),
    recurLabel: str(event.recurLabel, 200),
    // Links answer until the event (or the series' last occurrence) ends;
    // null = no known end (an endless series) — the link never expires.
    expiresAt: instant(event.expiresAt, null),
    tz: str(event.tz, 100),
    hour12: event.hour12 !== false,
  };
}

function hasEnded(snapshot) {
  return snapshot.expiresAt != null && Date.now() > snapshot.expiresAt;
}

function cleanResponse(value) {
  const r = coerce(value);
  if (!r || !RESPONSE_STATUSES.includes(r.status)) return null;
  return {
    status: r.status,
    respondedAt: Number.isFinite(r.respondedAt) ? r.respondedAt : 0,
    comment: typeof r.comment === 'string' ? r.comment : '',
  };
}

/** Membership + per-guest response keys, merged into the shape the app pulls
 *  ({ email: { status, respondedAt, comment, name } } — never tokenHash). */
async function responsesFor(kv, eventId, membership) {
  const entries = (await kv.list(`${respKey(eventId, '')}*`, true)) || [];
  const byEmail = {};
  for (const entry of entries) {
    if (!entry || typeof entry.key !== 'string') continue;
    const r = cleanResponse(entry.value);
    if (r) byEmail[entry.key.slice(respKey(eventId, '').length)] = r;
  }
  return mergeResponses(byEmail, membership);
}

/** Every guest's answer for every event, in ONE list call — what the
 *  per-minute /admin/responses pull uses instead of a list per event. Event
 *  ids carry no ':' (validated at sync), so the first one after the prefix
 *  ends the id; the rest is the guest's address, ':' and all. */
async function allResponses(kv) {
  const byEvent = new Map();
  for (const entry of await listAllEntries(kv, RESP_PREFIX)) {
    if (!entry || typeof entry.key !== 'string') continue;
    const rest = entry.key.slice(RESP_PREFIX.length);
    const cut = rest.indexOf(':');
    if (cut < 1) continue;
    const r = cleanResponse(entry.value);
    if (!r) continue;
    const id = rest.slice(0, cut);
    if (!byEvent.has(id)) byEvent.set(id, {});
    byEvent.get(id)[rest.slice(cut + 1)] = r;
  }
  return byEvent;
}

/** One event's membership laid over its guests' answers (`byEmail`, as the
 *  two readers above collect it): every current guest, answered or not. */
function mergeResponses(byEmail, membership) {
  byEmail = byEmail || {};
  const out = {};
  for (const [email, g] of Object.entries(membership || {})) {
    const r = byEmail[email];
    out[email] = {
      status: r ? r.status : 'needs-action',
      respondedAt: r ? r.respondedAt : 0,
      comment: r ? r.comment : '',
      name: (g && g.name) || '',
    };
  }
  return out;
}

function cleanSuggestion(value) {
  const s = coerce(value);
  const email = s ? lowerEmail(s.email) : '';
  if (!email) return null;
  return {
    email,
    name: str(s.name, 200),
    by: lowerEmail(s.by),
    at: Number.isFinite(s.at) ? s.at : 0,
  };
}

/** Suggestions whose address reached `membership` are settled — approved, or
 *  the organizer invited them independently. Every read filters them out;
 *  only /admin/sync (the one path that grows membership) deletes their keys. */
function pendingOf(list, membership) {
  return (Array.isArray(list) ? list : [])
    .filter((s) => !(membership && membership[s.email]))
    .sort((a, b) => a.at - b.at);
}

/**
 * One event's pending suggestions, oldest first. With `settle`, the entries
 * membership has since absorbed are also deleted — passed by /admin/sync so
 * approval needs no route of its own; plain reads must stay reads (a guest
 * opening their page shouldn't pay for the organizer's cleanup).
 */
async function suggestionsFor(kv, eventId, membership, settle = false) {
  const entries = (await kv.list(`${sugKey(eventId, '')}*`, true)) || [];
  const all = [];
  const settled = [];
  for (const entry of entries) {
    if (!entry || typeof entry.key !== 'string') continue;
    const s = cleanSuggestion(entry.value);
    if (!s) continue;
    if (settle && membership && membership[s.email]) settled.push(entry.key);
    all.push(s);
  }
  if (settled.length) await Promise.all(settled.map((key) => kv.del(key)));
  return pendingOf(all, membership);
}

/** Every pending suggestion, grouped by event, in ONE list call — what the
 *  per-minute /admin/responses pull uses instead of a list per event (almost
 *  always empty). Event ids carry no ':' (validated at sync), so the first
 *  one after the prefix ends the id. */
async function allSuggestions(kv) {
  const entries = await listAllEntries(kv, SUG_PREFIX);
  const byEvent = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.key !== 'string') continue;
    const rest = entry.key.slice(SUG_PREFIX.length);
    const cut = rest.indexOf(':');
    if (cut < 1) continue;
    const s = cleanSuggestion(entry.value);
    if (!s) continue;
    const id = rest.slice(0, cut);
    if (!byEvent.has(id)) byEvent.set(id, []);
    byEvent.get(id).push(s);
  }
  return byEvent;
}

/* ---- Admin routes -------------------------------------------------------- */

router.get('/admin/ping', async (ctx) => {
  if (!(await isAdmin(ctx.request))) return json({ error: 'unauthorized' }, 401);
  return json({ ok: true, version: WORKER_VERSION, runtime: workerRuntime() });
});

/**
 * Upsert an event: refresh its snapshot, issue tokens for new (or reissue-
 * listed) guests, and revoke tokens of guests no longer on the list. Raw
 * tokens are returned ONLY here, only for the guests that just got one —
 * they are not recoverable later (only their hash is stored).
 */
router.post('/admin/sync', async (ctx) => {
  if (!(await isAdmin(ctx.request))) return json({ error: 'unauthorized' }, 401);
  let body = null;
  try {
    body = await ctx.request.json();
  } catch {
    /* handled below */
  }
  const event = body && body.event;
  // Ids become KV-key segments and glob-pattern prefixes — restrict them to
  // the app's uid() alphabet so a stray '*', ':' or whitespace can never
  // corrupt key parsing or list patterns. Guests are capped to the app's own
  // MAX_GUESTS so a runaway payload can't mint thousands of tokens.
  if (!event || typeof event.id !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(event.id)) {
    return json({ error: 'event with id required' }, 400);
  }
  const incoming = (Array.isArray(body.guests) ? body.guests : []).slice(0, 200);
  const reissue = new Set(
    (Array.isArray(body.reissue) ? body.reissue : []).map(lowerEmail).filter(Boolean),
  );

  const kv = kvOf(ctx);
  const record = coerce(await kv.get(EVT_PREFIX + event.id)) || { guests: {} };
  const prev = record.guests || {};
  const next = {};
  const links = {};
  const writes = [];
  const stale = [];

  for (const g of incoming) {
    const email = lowerEmail(g && g.email);
    if (!email || next[email]) continue;
    const known = prev[email];
    if (known && known.tokenHash && !reissue.has(email)) {
      next[email] = { name: str(g && g.name, 200) || known.name || '', tokenHash: known.tokenHash };
      continue;
    }
    if (known && known.tokenHash) stale.push(TOK_PREFIX + known.tokenHash);
    const token = newToken();
    const tokenHash = await sha256Hex(token);
    next[email] = { name: str(g && g.name, 200), tokenHash };
    writes.push({ key: TOK_PREFIX + tokenHash, value: { eventId: event.id, email } });
    links[email] = token;
  }

  // Guests removed from the event: their capability — and their stored
  // answer — die with their entry.
  for (const [email, g] of Object.entries(prev)) {
    if (next[email]) continue;
    if (g && g.tokenHash) stale.push(TOK_PREFIX + g.tokenHash);
    stale.push(respKey(event.id, email));
  }

  writes.push({
    key: EVT_PREFIX + event.id,
    value: { snapshot: sanitizeSnapshot(event), guests: next, updatedAt: Date.now() },
  });
  await kv.set(writes);
  for (const key of stale) await kv.del(key);

  return json({
    ok: true,
    links,
    guests: await responsesFor(kv, event.id, next),
    suggestions: await suggestionsFor(kv, event.id, next, true), // settles approved ones
  });
});

/** Current responses (and pending guest suggestions) for every synced event
 *  — the app merges these back. */
router.get('/admin/responses', async (ctx) => {
  if (!(await isAdmin(ctx.request))) return json({ error: 'unauthorized' }, 401);
  const kv = kvOf(ctx);
  // Three value-carrying lists for the whole account, not a read and a list
  // per event: this route is polled every minute for as long as the calendar
  // is open, and an event stays synced (and so listed here) for as long as it
  // has guests — a host's list only ever grows.
  const [records, responses, suggestions] = await Promise.all([
    listAllEntries(kv, EVT_PREFIX),
    allResponses(kv),
    allSuggestions(kv),
  ]);
  const events = {};
  for (const entry of records) {
    if (!entry || typeof entry.key !== 'string') continue;
    const id = entry.key.slice(EVT_PREFIX.length);
    const record = coerce(entry.value);
    if (!record || typeof record !== 'object') continue;
    events[id] = {
      guests: mergeResponses(responses.get(id), record.guests),
      suggestions: pendingOf(suggestions.get(id), record.guests),
      updatedAt: record.updatedAt || 0,
    };
  }
  return json({ ok: true, events });
});

/** The organizer turned a suggestion down: drop it. (Approvals need no route
 *  — adding the guest settles the suggestion on the next read, see
 *  suggestionsFor.) Idempotent: dismissing what's already gone is ok:true. */
router.post('/admin/suggestions/dismiss', async (ctx) => {
  if (!(await isAdmin(ctx.request))) return json({ error: 'unauthorized' }, 401);
  let body = null;
  try {
    body = await ctx.request.json();
  } catch {
    /* handled below */
  }
  const eventId = body && typeof body.eventId === 'string' ? body.eventId : '';
  const email = lowerEmail(body && body.email);
  // The del below is exact-key, so a metacharacter is harmless here — the id
  // alphabet is enforced anyway so every admin route speaks the same rule.
  if (!eventId || !/^[A-Za-z0-9._-]{1,200}$/.test(eventId) || !email) {
    return json({ error: 'eventId and email required' }, 400);
  }
  await kvOf(ctx).del(sugKey(eventId, email));
  return json({ ok: true });
});

/** Drop an event and kill every guest link (and answer) that pointed at it. */
router.post('/admin/revoke', async (ctx) => {
  if (!(await isAdmin(ctx.request))) return json({ error: 'unauthorized' }, 401);
  let body = null;
  try {
    body = await ctx.request.json();
  } catch {
    /* handled below */
  }
  const eventId = body && typeof body.eventId === 'string' ? body.eventId : '';
  // Same alphabet /admin/sync enforces, for the same reason: the id becomes a
  // glob-pattern prefix below, where a stray '*' or ':' would sweep up every
  // event's answers instead of this one's. Nothing outside this alphabet can
  // ever have been synced, so there is nothing to revoke for such an id.
  if (!eventId || !/^[A-Za-z0-9._-]{1,200}$/.test(eventId)) {
    return json({ error: 'eventId required' }, 400);
  }
  const kv = kvOf(ctx);
  const record = coerce(await kv.get(EVT_PREFIX + eventId));
  if (record && record.guests) {
    for (const g of Object.values(record.guests)) {
      if (g && g.tokenHash) await kv.del(TOK_PREFIX + g.tokenHash);
    }
  }
  for (const key of (await kv.list(`${respKey(eventId, '')}*`)) || []) await kv.del(key);
  for (const key of (await kv.list(`${sugKey(eventId, '')}*`)) || []) await kv.del(key);
  await kv.del(EVT_PREFIX + eventId);
  return json({ ok: true });
});

/* ---- Guest-facing routes -------------------------------------------------- */

/** Resolve a token to its event, guest entry, and stored answer — or null. */
async function lookupToken(ctx, token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{40}$/.test(token)) return null;
  const kv = kvOf(ctx);
  const tokenHash = await sha256Hex(token);
  const ref = coerce(await kv.get(TOK_PREFIX + tokenHash));
  if (!ref || typeof ref.eventId !== 'string' || typeof ref.email !== 'string') return null;
  const record = coerce(await kv.get(EVT_PREFIX + ref.eventId));
  const guest = record && record.guests ? record.guests[ref.email] : null;
  // The guest entry must still exist AND still point at this token — a token
  // whose guest was since reissued or removed is dead even if its tok key
  // somehow lingered.
  if (!guest || guest.tokenHash !== tokenHash) return null;
  const response = cleanResponse(await kv.get(respKey(ref.eventId, ref.email)));
  return {
    eventId: ref.eventId,
    email: ref.email,
    record,
    answer: response || { status: 'needs-action', respondedAt: 0, comment: '' },
  };
}

/** Parse a guest-facing form POST (urlencoded from the page — which keeps the
 *  cross-origin request CORS-simple — JSON also accepted). */
async function readResponseBody(request) {
  const type = (request.headers.get('content-type') || '').toLowerCase();
  try {
    if (type.includes('application/json')) {
      const body = await request.json();
      return body && typeof body === 'object' ? body : {};
    }
    return Object.fromEntries(new URLSearchParams(await request.text()));
  } catch {
    return {};
  }
}

/** Validate + store an answer in the guest's own key — this write can never
 *  clobber an /admin/sync or another guest's response. Null = bad status. */
async function recordAnswer(ctx, found, body) {
  const status = String((body && body.status) || '');
  if (!RESPONSE_STATUSES.includes(status)) return null;
  const comment =
    body && typeof body.comment === 'string' ? body.comment.trim().slice(0, MAX_COMMENT) : '';
  const answer = { status, comment, respondedAt: Date.now() };
  await kvOf(ctx).set(respKey(found.eventId, found.email), answer);
  const previous = found.answer;
  found.answer = answer;
  if (status !== previous.status || (comment && comment !== previous.comment)) {
    const sending = notifyHost(ctx, found, answer);
    if (sending) await sending;
  }
  return answer;
}

const ANSWER_VERBS = { accepted: 'accepted', declined: 'declined', tentative: 'said maybe to' };

/**
 * Tells the host — this worker's owner — that a guest answered, through the
 * calendar's `calendar` notification channel. Only works while the worker runs
 * as the app (`forbidden` otherwise), and is rate limited per host; either way
 * the guest's answer is already saved. Returns a promise only when the runtime
 * has no waitUntil to finish it after the response.
 */
function notifyHost(ctx, found, answer) {
  const owner = (ctx && ctx.me) || (typeof me !== 'undefined' ? me : null);
  const notifications = owner && owner.puter && owner.puter.notifications;
  if (!notifications || typeof notifications.notify !== 'function') return null;
  const sending = (async () => {
    const s = found.record.snapshot || {};
    const guest = (found.record.guests || {})[found.email] || {};
    const title = `${guest.name || found.email} ${ANSWER_VERBS[answer.status]} ${s.title || 'your event'}`;
    const text = answer.comment ? `“${answer.comment}”` : fmtWhen(s);
    await notifications.notify({
      title: Array.from(title).slice(0, 120).join(''),
      ...(text ? { text: Array.from(text).slice(0, 240).join('') } : {}),
      target: `/?event=${encodeURIComponent(found.eventId)}`,
      data: { eventId: found.eventId },
      // One per guest per event, so a changed answer replaces the last one.
      group: `rsvp:${await sha256Hex(found.eventId + '\n' + found.email)}`,
      channel: 'calendar',
    });
  })().catch(() => {});
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(sending);
    return null;
  }
  return sending;
}

/* ---- Guest-facing JSON API ------------------------------------------------ */

/** The invitation as a machine-readable object (what GET /api/rsvp returns). */
function inviteView(found) {
  const s = found.record.snapshot || {};
  const membership = (found.record.guests || {})[found.email] || {};
  return {
    ok: true,
    event: {
      title: s.title || '',
      start: s.start,
      end: s.end,
      allDay: Boolean(s.allDay),
      when: fmtWhen(s),
      timezone: s.tz || '',
      location: s.location || '',
      meetingUrl: s.meetingUrl || '',
      description: s.description || '',
      organizer: s.organizerName || s.organizerEmail || '',
      recurrence: s.recurLabel || '',
      ended: hasEnded(s),
      expiresAt: s.expiresAt,
    },
    guest: { email: found.email, name: membership.name || '' },
    response: found.answer,
    allowedStatuses: RESPONSE_STATUSES,
  };
}

router.get('/api/rsvp/:token', async (ctx) => {
  const found = await lookupToken(ctx, ctx.params.token);
  if (!found) return json({ error: 'not_found' }, 404);
  const view = inviteView(found);
  // Only THIS guest's pending suggestions ride along (so the page can show
  // "waiting for the organizer") — whom other guests proposed is between
  // them and the organizer.
  const pending = await suggestionsFor(kvOf(ctx), found.eventId, found.record.guests || {});
  view.suggestions = pending
    .filter((s) => s.by === found.email)
    .map(({ email, name, at }) => ({ email, name, at }));
  return json(view);
});

async function apiRespond(ctx) {
  const found = await lookupToken(ctx, ctx.params.token);
  if (!found) return json({ error: 'not_found' }, 404);
  if (hasEnded(found.record.snapshot || {})) return json({ error: 'event_ended' }, 410);
  const answer = await recordAnswer(ctx, found, await readResponseBody(ctx.request));
  if (!answer) return json({ error: 'invalid_status', allowedStatuses: RESPONSE_STATUSES }, 400);
  return json({ ok: true, response: answer });
}

// POST and PUT are equivalent: both SET the guest's current answer.
router.post('/api/rsvp/:token', apiRespond);
router.put('/api/rsvp/:token', apiRespond);

/**
 * A guest suggests adding someone. This never touches the guest list and
 * never mints a token — it queues a proposal the ORGANIZER approves in the
 * calendar app (approval is what invites the person, from the organizer, so
 * the host's calendar is never bypassed the way a mail-client forward is).
 * Keyed by the proposed address: re-suggesting the same person (by anyone)
 * updates the one entry instead of stacking duplicates, and keeps the
 * original `at` so the app's "new suggestion" notice doesn't re-fire.
 */
router.post('/api/rsvp/:token/guests', async (ctx) => {
  const found = await lookupToken(ctx, ctx.params.token);
  if (!found) return json({ error: 'not_found' }, 404);
  if (hasEnded(found.record.snapshot || {})) return json({ error: 'event_ended' }, 410);
  const body = await readResponseBody(ctx.request);
  const email = lowerEmail(body.email);
  if (!email) return json({ error: 'invalid_email' }, 400);
  const membership = found.record.guests || {};
  const organizer = lowerEmail((found.record.snapshot || {}).organizerEmail);
  if (membership[email] || email === organizer) return json({ error: 'already_invited' }, 409);
  const kv = kvOf(ctx);
  const pending = await suggestionsFor(kv, found.eventId, membership);
  const existing = pending.find((s) => s.email === email);
  if (!existing && pending.length >= MAX_SUGGESTIONS) {
    return json({ error: 'suggestion_limit' }, 429);
  }
  const suggestion = {
    email,
    name: str(body.name, 200).trim(),
    by: found.email,
    at: existing ? existing.at : Date.now(),
  };
  await kv.set(sugKey(found.eventId, email), suggestion);
  return json({
    ok: true,
    suggestion: { email: suggestion.email, name: suggestion.name, at: suggestion.at },
  });
});

/* ---- One-click links (GET records — with prefetcher protection) ----------- */

/** Friendly action words (plus the canonical statuses as aliases). */
const ACTION_STATUS = {
  accept: 'accepted',
  yes: 'accepted',
  accepted: 'accepted',
  decline: 'declined',
  no: 'declined',
  declined: 'declined',
  maybe: 'tentative',
  tentative: 'tentative',
};

/**
 * True when the request smells like an email scanner, link unfurler, or
 * browser prefetch rather than a human click. Those must never record an
 * answer — they'd RSVP on the guest's behalf the moment the link is pasted
 * into Slack or scanned by Outlook. Erring toward "prefetch" is safe: the
 * guest still lands on the page and can confirm with one more click.
 */
function looksLikePrefetch(request) {
  const ua = request.headers.get('user-agent') || '';
  if (!ua) return true; // real browsers always send one
  if (
    /bot|crawl|spider|preview|prefetch|scan|probe|monitor|validator|expand|unfurl|embed|proxy|slack|discord|telegram|whatsapp|facebookexternalhit|skype|teams|linkedin|bingpreview|curl|wget|python-requests|go-http-client|okhttp|headless/i.test(
      ua,
    )
  ) {
    return true;
  }
  const purpose =
    request.headers.get('sec-purpose') ||
    request.headers.get('purpose') ||
    request.headers.get('x-purpose') ||
    request.headers.get('x-moz') ||
    '';
  return /pre(fetch|view|render)/i.test(purpose);
}

router.get('/rsvp/:token/:action', async (ctx) => {
  // Own keys only: the action comes off the URL, and `constructor` or
  // `__proto__` would otherwise read a truthy "status" off Object.prototype,
  // record nothing, and still redirect with the "Response saved" flag.
  const action = String(ctx.params.action || '').toLowerCase();
  const status = Object.prototype.hasOwnProperty.call(ACTION_STATUS, action) ? ACTION_STATUS[action] : null;
  // Prefetchers/unfurlers never record — they land on the page like any
  // visitor; a dead token or ended event also just redirects, and the page
  // reports the state it gets from the API.
  if (status && !looksLikePrefetch(ctx.request)) {
    const found = await lookupToken(ctx, ctx.params.token);
    if (found && !hasEnded(found.record.snapshot || {})) {
      // A one-click answer keeps any note the guest left earlier.
      await recordAnswer(ctx, found, { status, comment: found.answer.comment });
      return redirectToPage(ctx, ctx.params.token, true);
    }
  }
  return redirectToPage(ctx, ctx.params.token, false);
});

// The plain link in an email/chat: hand the human straight to the app page,
// which renders the invitation from GET /api/rsvp/<token>.
router.get('/rsvp/:token', async (ctx) => redirectToPage(ctx, ctx.params.token, false));

/* ---- Formatting (the API's human-readable `when` string) ---------------- */

function fmtWhen(s) {
  const base = {};
  if (s.tz) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: s.tz });
      base.timeZone = s.tz;
    } catch {
      /* unknown zone — fall back to UTC-less default */
    }
  }
  const start = new Date(s.start);
  const end = new Date(s.end);
  const dayFmt = new Intl.DateTimeFormat('en-US', {
    ...base,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  if (s.allDay) {
    const a = dayFmt.format(start);
    const b = dayFmt.format(end);
    return a === b ? a : `${a} – ${b}`;
  }
  const timeFmt = new Intl.DateTimeFormat('en-US', {
    ...base,
    hour: 'numeric',
    minute: '2-digit',
    hour12: s.hour12 !== false,
  });
  const zoneFmt = new Intl.DateTimeFormat('en-US', {
    ...base,
    hour: 'numeric',
    timeZoneName: 'short',
  });
  const zonePart = (zoneFmt.formatToParts(end).find((p) => p.type === 'timeZoneName') || {}).value;
  const zone = zonePart ? ` (${zonePart})` : '';
  if (dayFmt.format(start) === dayFmt.format(end)) {
    return `${dayFmt.format(start)} · ${timeFmt.format(start)} – ${timeFmt.format(end)}${zone}`;
  }
  return `${dayFmt.format(start)}, ${timeFmt.format(start)} – ${dayFmt.format(end)}, ${timeFmt.format(end)}${zone}`;
}

/* ==========================================================================
 * Booking — Calendly-style "book time with me" pages.
 *
 * The calendar app (src/js/booking.js) pushes this worker the host's booking
 * pages plus a merged list of BUSY intervals derived from their calendar; the
 * worker is then the single authority guests talk to. It computes bookable
 * slots (availability windows in the host's time zone, minus busy times,
 * existing bookings, buffers, minimum notice, and the rolling horizon),
 * records bookings, and mints each booking an unguessable manage token so the
 * guest can cancel — the same capability-URL pattern as RSVP links, and like
 * them only the token's hash is stored.
 *
 * Slot truth lives HERE, not in the page: POST /api/book re-runs the exact
 * slot computation the guest page listed from, so the two can never disagree,
 * and a stale page simply gets slot_taken. Two guests racing for one slot are
 * resolved with a claim key (write-then-read-back on bookw:slot:<start>) plus
 * a final overlap re-check across all bookings — puter.kv has no transactions,
 * so this narrows the race to KV round-trip time rather than eliminating it in
 * theory; in practice both guests are staring at the same slot grid, and the
 * exact-start claim catches that case outright.
 *
 * Confirmation emails are sent from the worker itself (me.puter.email — the
 * host's own account sends and pays, exactly like their invitations) and are
 * strictly best-effort: a booking whose email fails is still a booking, and
 * the API says which mails actually went out so the page never promises one
 * that didn't. Guests are anonymous, so sends are capped per day, and the only
 * links a mail carries point back at this worker's own origin.
 *
 *   JSON API (guest-facing):
 *     GET  /api/book/<page>            -> page details + first available slot
 *     GET  /api/book/<page>/slots      -> bookable slot starts (?from=&to=)
 *     POST /api/book/<page>            -> { start, name, email, notes, tz }
 *     GET  /api/booking/<token>        -> one booking (the guest's manage view)
 *     POST /api/booking/<token>/cancel -> guest cancels (until the start time)
 *   Human links (303-redirect to the app-hosted book.html, params in the
 *   URL FRAGMENT so tokens stay out of logs):
 *     GET /book/<page>       GET /booking/<token>
 *   Admin (Bearer <secret>, like the RSVP admin routes):
 *     POST /admin/booking/sync    push pages + busy + organizer
 *     GET  /admin/booking/list    every booking (the app merges these back)
 *     POST /admin/booking/cancel  host cancels; optionally emails the guest
 *
 * KV layout (booking half):
 *   bookw:cfg                 -> { pages, busy, organizerName, organizerEmail,
 *                                  organizerPicture, hour12, updatedAt }
 *   bookw:bkg:<id>            -> the booking record (incl. tokenHash)
 *   bookw:tok:<sha256(token)> -> { bookingId }
 *   bookw:slot:<startMs>      -> { bookingId }   (the claim key)
 *   bookw:mail:<YYYY-MM-DD>   -> emails sent today (cap)
 *   bookw:new:<pageId>:<YYYY-MM-DD> -> bookings created today (per-page cap)
 * ========================================================================== */

const BOOK_CFG_KEY = 'bookw:cfg';
const BOOK_PREFIX = 'bookw:bkg:';
const BOOK_TOK_PREFIX = 'bookw:tok:';
const BOOK_SLOT_PREFIX = 'bookw:slot:';
const BOOK_MAIL_PREFIX = 'bookw:mail:';
const BOOK_NEW_PREFIX = 'bookw:new:';

const BOOK_MAX_PAGES = 25;
const BOOK_MAX_BUSY = 20000;
const BOOK_MAX_ADVANCE_DAYS = 90;
const BOOK_SLOT_QUERY_MAX_DAYS = 45;
const BOOK_MAX_PER_PAGE_PER_DAY = 50; // anti-abuse: new bookings per page per day
const BOOK_MAX_MAILS_PER_DAY = 200;
// The host's profile picture rides in the config every public request reads, so
// what it may cost is capped here. The app publishes a copy well under this
// (see fetchSharePicture in src/js/profile.js); the headroom is for a client
// whose idea of "small" is a little different, not for an unbounded one.
const BOOK_MAX_PICTURE_CHARS = 96 * 1024;
const BOOK_COUNTER_TTL = 3 * 24 * 60 * 60; // seconds
const MIN_MS = 60_000;
const BOOK_DAY_MS = 86_400_000;

/* ---- Booking: small helpers --------------------------------------------- */

function bookOwner(ctx) {
  return (ctx && ctx.me) || (typeof me !== 'undefined' ? me : null);
}

/**
 * The platform's transactional send under whichever name this runtime's SDK
 * carries: `sendTransactional` now, `send` before the rename (still served
 * until every caller has moved). Null when the runtime grants no mailer.
 */
function bookMailer(email) {
  if (!email) return null;
  if (typeof email.sendTransactional === 'function') {
    return (message) => email.sendTransactional(message);
  }
  if (typeof email.send === 'function') return (message) => email.send(message);
  return null;
}

/**
 * The host's mail transport, in every arrangement the platform has been seen
 * to accept (the same duality email-worker.js negotiates — observed live,
 * 2026-08: a bare owner send is REJECTED; the payer must be named via
 * requesterToken). Booking guests are anonymous, so unlike the invites worker
 * there is no caller to bill: the host's own token fills BOTH halves — their
 * account authorizes the send and pays for it, which is exactly this
 * feature's deal. Null means the runtime grants no mailer at all; bookings
 * still work — they just aren't announced by email.
 */
function bookSendForms(ctx) {
  const owner = bookOwner(ctx);
  const send = bookMailer(owner && owner.puter && owner.puter.email);
  if (!send) return null;
  const token = owner.puter.authToken;
  const forms = [(message) => send(message)];
  if (token) {
    forms.unshift((message) => send({ ...message, requesterToken: token }));
    forms.push((message) => send({ ...message, emailAccessToken: token }));
  }
  return forms;
}

/** Which send form this runtime last accepted — remembered so later mails
 *  skip straight to it instead of re-probing. */
let bookSendFormIndex = 0;

/* Same gating as email-worker.js: only an error that reads as a rejected
 * REQUEST (bad parameter, bad token) may fall through to another form.
 * Anything the transport said about the message itself — or anything
 * unrecognizable — is final, because the message may already have been
 * accepted and a retry would double-send it. */
const BOOK_DELIVERY_ERROR = /deliver|recipient|suppress|unsubscrib|mailbox|smtp|bounce|spam|quota|rate|limit/i;
const BOOK_REQUEST_ERROR = /token|auth|unauthor|forbidden|permission|denied|unknown|unrecognized|unsupported|invalid|missing|required|not a function|undefined/i;

function bookValidTz(tz) {
  if (!tz || typeof tz !== 'string' || tz.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * One wall-clock formatter per zone, reused. Constructing an
 * Intl.DateTimeFormat costs roughly eight times what formatting with it does,
 * and the slot engine converts every candidate start individually: a month
 * query on a page with 15-minute increments is ~1000 conversions, on a public
 * endpoint anyone holding the link can hit. Zones only ever come from the
 * host's own (validated) pages, so the map is bounded by their page count —
 * the cap is belt and braces for a long-lived worker instance.
 */
const bookZoneFmts = new Map();

function bookZoneFmt(tz) {
  const known = bookZoneFmts.get(tz);
  if (known) return known;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  if (bookZoneFmts.size >= 64) bookZoneFmts.clear();
  bookZoneFmts.set(tz, fmt);
  return fmt;
}

/** Calendar-date fields (and wall clock) of an instant in `tz`. Some engines
 *  render midnight as hour "24" of the PRIOR day — normalize that back to
 *  00:00 of the correct date, or a midnight booking would count against the
 *  wrong day's caps. */
function bookZonedDate(ms, tz) {
  const parts = bookZoneFmt(tz).formatToParts(new Date(ms));
  const get = (t) => Number((parts.find((p) => p.type === t) || {}).value);
  let y = get('year');
  let m = get('month');
  let d = get('day');
  let hour = get('hour');
  const minute = get('minute');
  if (hour === 24) {
    const rolled = new Date(Date.UTC(y, m - 1, d + 1));
    y = rolled.getUTCFullYear();
    m = rolled.getUTCMonth() + 1;
    d = rolled.getUTCDate();
    hour = 0;
  }
  return { y, m, d, hour, minute };
}

/** How far `tz` runs ahead of UTC at the instant `ms`. */
function bookZoneOffset(ms, tz) {
  const p = bookZonedDate(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute) - ms;
}

/**
 * UTC instant of a wall-clock (date + minutes-since-midnight) in `tz`.
 *
 * The offset that matters is the one in force AT THE ANSWER, not at the first
 * guess — and treating the wall clock as UTC puts that guess a whole offset
 * away from the answer, so within |offset| hours of a DST change the two
 * disagree and a single pass lands an hour off. That is not a fringe hour: a
 * Los Angeles page offering 08:00 on the spring-forward Sunday listed it at
 * 09:00 (and so listed 09:00 twice, losing a slot), and a Berlin page's 01:00
 * became 00:00, an hour before the host said they were free. So: guess, then
 * re-resolve with the offset that guess landed in.
 *
 * A nonexistent spring-forward wall clock has no instant at all; it resolves
 * to the instant just past the gap (the usual "spring forward" convention) —
 * in every zone — rather than NaN, which the busy/overlap checks then judge
 * on its merits. An ambiguous fall-back wall clock resolves to its first
 * (pre-transition) occurrence, again in every zone.
 */
function bookZonedToUtc(y, m, d, minutes, tz) {
  // Hour "24" rolls into the next day via Date.UTC — no clamping (see the
  // same reasoning in the app's zonedTimeToUTC).
  const guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  // Try every offset in force around this day (at most two: before and after
  // a transition) and keep the candidates that reproduce the wall clock.
  // Symmetric by construction — the old two-pass guess resolved a
  // nonexistent hour BACKWARD in zones east of UTC (a Berlin page offered
  // 01:00 for a window that opened at 02:00) and an ambiguous one to its
  // second occurrence there, while doing the opposite west of UTC.
  const offsets = new Set([
    bookZoneOffset(guess - BOOK_DAY_MS, tz),
    bookZoneOffset(guess, tz),
    bookZoneOffset(guess + BOOK_DAY_MS, tz),
  ]);
  const all = [];
  const valid = [];
  for (const off of offsets) {
    const ts = guess - off;
    all.push(ts);
    if (bookZoneOffset(ts, tz) === off) valid.push(ts);
  }
  // An ambiguous fall-back wall clock is its first occurrence; a nonexistent
  // spring-forward one is the instant just past the gap.
  return valid.length ? Math.min(...valid) : Math.max(...all);
}

function bookInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Sorted, merged minute-intervals ({ start, end } within one day). */
function bookMergeMinutes(intervals) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ start: iv.start, end: iv.end });
  }
  return out;
}

/** True when [s, e) intersects any of the sorted, merged [start, end] pairs. */
function bookOverlaps(intervals, s, e) {
  for (const iv of intervals) {
    if (iv[0] >= e) break;
    if (iv[1] > s) return true;
  }
  return false;
}

/**
 * The host's profile picture, as it may be published. Inline image data only,
 * base64 only, and small: the page renders this straight into an <img src>, so
 * an http(s) URL (a tracker, a dead host), a percent-encoded SVG (markup we
 * would be handing a guest's browser), or a picture too big to belong in a
 * config are all answered the same way — no picture. Applied on the way IN and
 * again on the way OUT, like meetingLink.
 */
function bookPicture(value) {
  if (typeof value !== 'string') return '';
  const v = value.trim();
  if (!v || v.length > BOOK_MAX_PICTURE_CHARS) return '';
  // Case-insensitive on the scheme and type only (a media type is), which is
  // what the app's own check is — the two must agree, or a picture the host can
  // see in the editor would silently never reach their page.
  return /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/]+={0,2}$/i.test(v) ? v : '';
}

/**
 * True when an existing confirmed booking makes [slotStart, slotEnd)
 * unbookable. The gap between the two meetings must fit the adjacent buffer
 * of EACH — the candidate slot's own, and the booked meeting's (from its
 * page's config; a meeting whose page is gone keeps no buffer). max, not sum:
 * one shared gap serves as both meetings' breathing room. Padding only the
 * candidate would let a new booking start the minute an existing one ends,
 * ignoring that booking's after-buffer.
 */
function bookingBlocks(cfg, page, other, slotStart, slotEnd) {
  const otherPage = (cfg.pages || {})[other.pageId];
  const gapBefore =
    Math.max(page.bufferBeforeMin, otherPage ? otherPage.bufferAfterMin : 0) * MIN_MS;
  const gapAfter =
    Math.max(page.bufferAfterMin, otherPage ? otherPage.bufferBeforeMin : 0) * MIN_MS;
  return other.start < slotEnd + gapAfter && other.end > slotStart - gapBefore;
}

/* ---- Booking: config sanitizing ------------------------------------------ */

function sanitizeBookingHours(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (let day = 0; day < 7; day++) {
    const raw = input[day] != null ? input[day] : input[String(day)];
    if (!Array.isArray(raw)) continue;
    const intervals = [];
    for (const iv of raw.slice(0, 6)) {
      if (!iv || typeof iv !== 'object') continue;
      const start = bookInt(iv.start, 0, 1439, NaN);
      const end = bookInt(iv.end, 1, 1440, NaN);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      intervals.push({ start, end });
    }
    if (intervals.length) out[day] = bookMergeMinutes(intervals);
  }
  return out;
}

function sanitizeBookingPage(input) {
  if (!input || typeof input !== 'object') return null;
  const id = typeof input.id === 'string' && PAGE_ID_RE.test(input.id) ? input.id : '';
  if (!id) return null;
  const durationMin = bookInt(input.durationMin, 5, 720, 30);
  return {
    id,
    title: str(input.title, 200).trim() || 'Meeting',
    description: str(input.description, 2000),
    location: str(input.location, 500).trim(),
    durationMin,
    // 0 / absent means "same as the duration" (see the app's normalizePage) —
    // resolved via the falsy check, never clamped up to the 5-minute floor.
    incrementMin: bookInt(input.incrementMin || durationMin, 5, 720, durationMin),
    bufferBeforeMin: bookInt(input.bufferBeforeMin, 0, 240, 0),
    bufferAfterMin: bookInt(input.bufferAfterMin, 0, 240, 0),
    minNoticeMin: bookInt(input.minNoticeMin, 0, 40320, 120),
    maxAdvanceDays: bookInt(input.maxAdvanceDays, 1, BOOK_MAX_ADVANCE_DAYS, 60),
    maxPerDay: bookInt(input.maxPerDay, 0, 50, 0),
    tz: bookValidTz(input.tz) ? input.tz : 'UTC',
    hours: sanitizeBookingHours(input.hours),
    // Mint a Puter Meetings link for each booking. Defaults ON (absent =
    // true, matching the app's normalizePage) so pages pushed by an app that
    // predates the field get video links the moment this worker does.
    meet: input.meet !== false,
    // Show the host's profile picture to guests. Defaults OFF (absent =
    // false, matching the app's normalizePage): publishing a face is the
    // host's call, so a page that has never said yes doesn't.
    avatar: input.avatar === true,
    enabled: input.enabled !== false,
  };
}

function sanitizeBookingSync(body) {
  const src = body && typeof body === 'object' ? body : {};
  const pages = {};
  for (const raw of (Array.isArray(src.pages) ? src.pages : []).slice(0, BOOK_MAX_PAGES)) {
    const page = sanitizeBookingPage(raw);
    if (page) pages[page.id] = page;
  }
  const busy = [];
  for (const iv of (Array.isArray(src.busy) ? src.busy : []).slice(0, BOOK_MAX_BUSY)) {
    const s = Array.isArray(iv) ? Number(iv[0]) : NaN;
    const e = Array.isArray(iv) ? Number(iv[1]) : NaN;
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) busy.push([Math.round(s), Math.round(e)]);
  }
  busy.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const iv of busy) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push(iv);
  }
  return {
    pages,
    busy: merged,
    organizerName: str(src.organizerName, 200).trim(),
    organizerEmail: lowerEmail(src.organizerEmail),
    organizerPicture: bookPicture(src.organizerPicture),
    hour12: src.hour12 !== false,
    updatedAt: Date.now(),
  };
}

async function loadBookingCfg(kv) {
  const cfg = coerce(await kv.get(BOOK_CFG_KEY));
  if (!cfg || typeof cfg !== 'object') {
    return { pages: {}, busy: [], organizerName: '', organizerEmail: '', organizerPicture: '', hour12: true };
  }
  return {
    pages: cfg.pages && typeof cfg.pages === 'object' ? cfg.pages : {},
    busy: Array.isArray(cfg.busy) ? cfg.busy : [],
    organizerName: typeof cfg.organizerName === 'string' ? cfg.organizerName : '',
    organizerEmail: typeof cfg.organizerEmail === 'string' ? cfg.organizerEmail : '',
    organizerPicture: typeof cfg.organizerPicture === 'string' ? cfg.organizerPicture : '',
    hour12: cfg.hour12 !== false,
  };
}

/** Every booking record, from ONE value-carrying list. Every public booking
 *  route runs this (a page's slots, a POST twice over), and records are kept
 *  for months after their meeting, so a read per record would make each
 *  anonymous request cost as many round-trips as the page has ever had
 *  bookings. */
async function loadBookings(kv) {
  const out = [];
  for (const entry of await listAllEntries(kv, BOOK_PREFIX)) {
    const b = coerce(entry && entry.value);
    if (b && typeof b === 'object' && typeof b.id === 'string' && Number.isFinite(b.start)) out.push(b);
  }
  return out;
}

/* ---- Booking: the slot engine --------------------------------------------- */

/**
 * Bookable slot starts (UTC ms, sorted) for `page` intersecting [fromMs, toMs).
 * Every rule lives here — availability windows walked in the page's own time
 * zone (each slot converted individually, so DST days are right), minimum
 * notice, the rolling horizon, buffers against the host's busy intervals and
 * against confirmed bookings, and the per-day booking cap. POST /api/book
 * re-runs this same function to validate the requested start, so the listed
 * grid and the accepted set can never drift apart.
 */
function bookableSlots(cfg, page, bookings, fromMs, toMs, now, { ignoreConflicts = false } = {}) {
  const tz = bookValidTz(page.tz) ? page.tz : 'UTC';
  const durMs = page.durationMin * MIN_MS;
  const stepMin = Math.max(5, page.incrementMin || page.durationMin);
  const notBefore = now + page.minNoticeMin * MIN_MS;
  const horizonEnd = now + page.maxAdvanceDays * BOOK_DAY_MS;
  const busy = ignoreConflicts ? [] : cfg.busy || [];
  const active = ignoreConflicts
    ? []
    : bookings.filter((b) => b && b.status === 'confirmed' && Number.isFinite(b.start) && Number.isFinite(b.end));
  const out = new Set();

  const first = bookZonedDate(Math.max(fromMs, 0), tz);
  const cursor = new Date(Date.UTC(first.y, first.m - 1, first.d));
  for (let i = 0; i <= BOOK_MAX_ADVANCE_DAYS + BOOK_SLOT_QUERY_MAX_DAYS + 2; i++) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth() + 1;
    const d = cursor.getUTCDate();
    const dayStart = bookZonedToUtc(y, m, d, 0, tz);
    if (dayStart >= toMs || dayStart > horizonEnd) break;
    // The weekday of the calendar DATE (zone-independent once we hold y/m/d).
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const windows = (page.hours && (page.hours[weekday] || page.hours[String(weekday)])) || [];

    let dayFull = false;
    if (!ignoreConflicts && page.maxPerDay > 0 && windows.length) {
      let count = 0;
      for (const b of active) {
        if (b.pageId !== page.id) continue;
        const bd = bookZonedDate(b.start, tz);
        if (bd.y === y && bd.m === m && bd.d === d) count++;
      }
      dayFull = count >= page.maxPerDay;
    }

    if (!dayFull) {
      for (const w of windows) {
        for (let t = w.start; t + page.durationMin <= w.end; t += stepMin) {
          const slotStart = bookZonedToUtc(y, m, d, t, tz);
          if (!Number.isFinite(slotStart)) continue;
          const slotEnd = slotStart + durMs;
          if (slotStart < notBefore) continue;
          if (slotStart > horizonEnd) continue;
          if (slotStart < fromMs || slotStart >= toMs) continue;
          const padS = slotStart - page.bufferBeforeMin * MIN_MS;
          const padE = slotEnd + page.bufferAfterMin * MIN_MS;
          if (bookOverlaps(busy, padS, padE)) continue;
          let clash = false;
          for (const b of active) {
            if (bookingBlocks(cfg, page, b, slotStart, slotEnd)) {
              clash = true;
              break;
            }
          }
          if (clash) continue;
          out.add(slotStart);
        }
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return [...out].sort((a, b) => a - b);
}

/** The first bookable slot from `now`, or null. Scans week by week so a mostly
 *  free calendar answers after one small pass instead of a full-horizon walk. */
function firstBookableSlot(cfg, page, bookings, now) {
  const horizonEnd = now + page.maxAdvanceDays * BOOK_DAY_MS;
  for (let from = now; from < horizonEnd; from += 7 * BOOK_DAY_MS) {
    const to = Math.min(from + 7 * BOOK_DAY_MS, horizonEnd + BOOK_DAY_MS);
    const slots = bookableSlots(cfg, page, bookings, from, to, now);
    if (slots.length) return slots[0];
  }
  return null;
}

/* ---- Booking: views -------------------------------------------------------- */

function publicPageView(cfg, page) {
  return {
    id: page.id,
    title: page.title,
    description: page.description,
    location: page.location,
    durationMin: page.durationMin,
    minNoticeMin: page.minNoticeMin,
    maxAdvanceDays: page.maxAdvanceDays,
    // The host's name only — their email is shared in the confirmation, not on
    // the public page.
    organizer: cfg.organizerName || '',
    // …and their picture, only where the page asked for it. Re-validated here
    // because this is what a guest's browser renders.
    organizerPicture: page.avatar ? bookPicture(cfg.organizerPicture) : '',
    timeZone: page.tz,
  };
}

/** A booking as the guest may see it (their manage view / POST reply). */
function guestBookingView(cfg, booking, now = Date.now()) {
  return {
    id: booking.id,
    pageId: booking.pageId,
    title: booking.pageTitle || 'Meeting',
    start: booking.start,
    end: booking.end,
    location: booking.location || '',
    // Validated on the way OUT too: booking records are worker-authored, but
    // this view is what the public page turns into a clickable link.
    meetingUrl: meetingLink(booking.meetingUrl),
    organizer: cfg.organizerName || '',
    name: booking.name || '',
    email: booking.email,
    notes: booking.notes || '',
    status: booking.status,
    cancelledBy: booking.status === 'cancelled' ? booking.cancelledBy || '' : '',
    canCancel: booking.status === 'confirmed' && booking.start > now,
  };
}

/** A booking as the app pulls it (admin view — everything but the token hash,
 *  and the transient `pending` mark a reservation carries mid-request). */
function adminBookingView(booking) {
  const { tokenHash, pending, ...rest } = booking;
  return rest;
}

/**
 * True while `b` may still be inside the request that reserved it. A
 * reservation is written BEFORE its request checks the slot (see POST
 * /api/book/:page) and carries `pending: true` until that check passes, so a
 * concurrent request can tell a booking that exists from one that is still
 * deciding whether it does. The mark is trusted only for as long as a request
 * can plausibly run; a `pending` older than that was left by a request that
 * died before clearing it, and the record stands as the booking it says it is
 * — exactly as it did before the mark existed.
 */
const BOOK_SETTLE_MAX_MS = 2 * MIN_MS;
function bookingSettling(b, now) {
  return Boolean(b && b.pending) && now - (Number(b.createdAt) || 0) < BOOK_SETTLE_MAX_MS;
}

/* ---- Booking: emails (strictly best-effort) -------------------------------- */

function bookEscapeHtml(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function bookEscapeBlock(v) {
  return bookEscapeHtml(v).replace(/\r?\n/g, '<br>');
}

/** Header-safe single line (a stray CR/LF in a subject is header injection). */
function bookLine(v, cap) {
  return str(v, cap).replace(/[\r\n]+/g, ' ').trim();
}

const BOOK_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bookBase64Utf8(value) {
  const bytes = new TextEncoder().encode(String(value));
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += BOOK_B64[a >> 2];
    out += BOOK_B64[((a & 3) << 4) | ((b || 0) >> 4)];
    out += b === undefined ? '=' : BOOK_B64[((b & 15) << 2) | ((c || 0) >> 6)];
    out += c === undefined ? '=' : BOOK_B64[c & 63];
  }
  return out;
}

function bookIcsEscape(v) {
  // Normalize every line-break form — CRLF, lone LF, and lone CR — to an
  // escaped \n. A bare CR left raw is treated as a line split by lenient
  // parsers, orphaning the tail into a line with no ':' that gets dropped
  // (silently truncating the value) or re-parsed as an injected property.
  return String(v)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * `;CN="…"` parameter for a display name, or '' when absent. QUOTED, because a
 * bare param value ends at the next ':' or ';' — a guest called
 * "Eve:mailto:evil@example.com" typed their own address out of the ATTENDEE
 * line and someone else's in. Quotes and control characters are dropped
 * instead (an RFC 5545 param value cannot hold a DQUOTE at all, and a newline
 * would break the property mid-line). Same routine as the app's ics.js
 * cnParam, for the same reasons — the worker deploys as one file and cannot
 * import it.
 */
function bookCnParam(name) {
  const n =
    typeof name === 'string'
      ? name.replace(/["\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
      : '';
  return n ? `;CN="${n}"` : '';
}

function bookIcsDate(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * RFC 5545 line folding: at most 75 octets per line, counted in UTF-8 and
 * broken only between whole code points. Slicing by UTF-16 units instead
 * splits an astral character's surrogate pair across the fold, and the two
 * orphaned halves encode as U+FFFD — an emoji landing on the boundary of a
 * page title reached the guest's .ics as a pair of replacement characters.
 * (Same routine as the app's ics.js foldLine, for the same reason.)
 */
function bookIcsFold(line) {
  const octets = (cp) => (cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4);
  let out = '';
  let lineBytes = 0;
  for (const ch of line) {
    const b = octets(ch.codePointAt(0));
    if (lineBytes + b > 75) {
      out += '\r\n ';
      lineBytes = 1; // the leading space of the continuation line
    }
    out += ch;
    lineBytes += b;
  }
  return out;
}

/** A minimal, valid .ics for the confirmed booking so the guest can put it on
 *  their own calendar. METHOD:REQUEST (with the host as organizer) when we
 *  know the host's address — that's what makes mail clients treat it as a
 *  real invitation; PUBLISH otherwise. */
function bookingIcs(cfg, booking) {
  const method = cfg.organizerEmail ? 'REQUEST' : 'PUBLISH';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Puter Calendar//Booking//EN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${booking.id}@calendar.puter.com`,
    `DTSTAMP:${bookIcsDate(Date.now())}`,
    `DTSTART:${bookIcsDate(booking.start)}`,
    `DTEND:${bookIcsDate(booking.end)}`,
    `SUMMARY:${bookIcsEscape(booking.pageTitle || 'Meeting')}`,
  ];
  // The meeting link rides in the four places clients look (same reasoning as
  // the app's ics.js): URL (Apple), X-GOOGLE-CONFERENCE (Google Calendar /
  // Gmail render a conference row), CONFERENCE (RFC 7986), and a trailing
  // "Join:" description line (Outlook.com). Never LOCATION — Gmail draws a
  // location as a mappable place, sending guests to Google Maps. The
  // properties are URI values, emitted raw: meetingLink() only ever passes an
  // exact Meetings room URL, which has no TEXT-special characters anyway.
  const joinUrl = meetingLink(booking.meetingUrl);
  const description = joinUrl
    ? `${booking.notes ? `${booking.notes}\n\n` : ''}Join: ${joinUrl}`
    : booking.notes;
  if (booking.location) lines.push(`LOCATION:${bookIcsEscape(booking.location)}`);
  if (description) lines.push(`DESCRIPTION:${bookIcsEscape(description)}`);
  if (joinUrl) {
    lines.push(`URL:${joinUrl}`);
    lines.push(`X-GOOGLE-CONFERENCE:${joinUrl}`);
    lines.push(`CONFERENCE;VALUE=URI;FEATURE=VIDEO:${joinUrl}`);
  }
  if (cfg.organizerEmail) {
    lines.push(`ORGANIZER${bookCnParam(cfg.organizerName)}:mailto:${cfg.organizerEmail}`);
    lines.push(
      `ATTENDEE${bookCnParam(booking.name)};PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT:mailto:${booking.email}`,
    );
  }
  lines.push('STATUS:CONFIRMED', 'END:VEVENT', 'END:VCALENDAR');
  return lines.map(bookIcsFold).join('\r\n') + '\r\n';
}

/** The when-line for booking emails, in whichever zone the reader lives. */
function bookWhen(booking, tz, hour12) {
  return fmtWhen({
    start: booking.start,
    end: booking.end,
    allDay: false,
    tz: bookValidTz(tz) ? tz : '',
    hour12: hour12 !== false,
  });
}

async function bookMailBudget(kv) {
  const key = `${BOOK_MAIL_PREFIX}${new Date().toISOString().slice(0, 10)}`;
  const used = Number(coerce(await kv.get(key))) || 0;
  return { key, remaining: Math.max(0, BOOK_MAX_MAILS_PER_DAY - used) };
}

async function bookBumpCounter(kv, key, n = 1) {
  try {
    if (typeof kv.incr === 'function') await kv.incr(key, n);
    else await kv.set(key, (Number(coerce(await kv.get(key))) || 0) + n);
    if (typeof kv.expire === 'function') await kv.expire(key, BOOK_COUNTER_TTL);
  } catch {
    /* counters are guard rails, never a reason to fail the booking */
  }
}

/**
 * Send one booking email, counted against the daily cap. Returns true only
 * when the transport accepted it. Every failure mode — no mailer in this
 * runtime, cap reached, transport error — lands on `false`, and the caller
 * reports that honestly instead of promising mail that never left.
 */
async function sendBookingMail(ctx, message) {
  const forms = bookSendForms(ctx);
  if (!forms) return false;
  const kv = kvOf(ctx);
  let budget;
  try {
    budget = await bookMailBudget(kv);
  } catch {
    return false;
  }
  if (!budget.remaining) return false;
  // Try the form that last worked first, then the rest in declared order.
  const order = forms.map((_, i) => i);
  if (bookSendFormIndex > 0 && bookSendFormIndex < forms.length) {
    order.splice(order.indexOf(bookSendFormIndex), 1);
    order.unshift(bookSendFormIndex);
  }
  for (const index of order) {
    try {
      await forms[index](message);
      bookSendFormIndex = index;
      await bookBumpCounter(kv, budget.key, 1);
      return true;
    } catch (err) {
      const reason = String((err && err.message) || err || '');
      if (BOOK_DELIVERY_ERROR.test(reason) || !BOOK_REQUEST_ERROR.test(reason)) return false;
    }
  }
  return false;
}

function bookFooterHtml() {
  return `<p style="margin:20px 0 0;font-size:12px;color:#6b7280">Scheduled with Puter Calendar</p>`;
}

/** The mark that leads a booking mail: a white check in a green disc beside
 *  the heading, so "this went through" reads at a glance — before a word of
 *  the body does, and in the preview pane. It is markup, not an image: mail
 *  clients block remote images by default and drop <style> blocks, so the
 *  disc is an inline-styled table cell around a Unicode check — the one
 *  rendering Gmail, Apple Mail and Outlook all show (Outlook ignores the
 *  border-radius and draws a green square, which still reads as a check).
 *  The glyph is decorative; the heading beside it carries the meaning, so
 *  screen readers announce the words and not "check mark". The green is the
 *  app's --success token, the same one the booking page's own badge uses. */
function bookStatusHtml(heading) {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 16px">` +
    `<tr>` +
    `<td aria-hidden="true" style="width:40px;height:40px;border-radius:20px;background:#2fa66b;color:#ffffff;` +
    `font-size:22px;font-weight:700;line-height:40px;text-align:center;vertical-align:middle">&#10003;</td>` +
    `<td style="padding:0 0 0 12px;vertical-align:middle">` +
    `<h1 style="margin:0;color:#111827;font-size:20px;line-height:1.3">${heading}</h1>` +
    `</td>` +
    `</tr></table>`
  );
}

/** Guest confirmation mail (with the .ics and their private manage link). */
async function sendGuestConfirmMail(ctx, cfg, booking, token, origin) {
  const host = cfg.organizerName || 'the organizer';
  const when = bookWhen(booking, booking.tz, true);
  const manageUrl = `${origin}/booking/${token}`;
  const joinUrl = meetingLink(booking.meetingUrl);
  const subject = bookLine(`Confirmed: ${booking.pageTitle} with ${host} — ${when}`, 200);
  const text = [
    `Hi ${booking.name || 'there'},`,
    '',
    `\u2713 You're scheduled. Your booking is confirmed.`,
    '',
    booking.pageTitle,
    `When: ${when}`,
    ...(booking.location ? [`Where: ${booking.location}`] : []),
    ...(joinUrl ? [`Join: ${joinUrl}`] : []),
    `With: ${cfg.organizerName || cfg.organizerEmail || 'the organizer'}`,
    ...(booking.notes ? ['', `Your notes: ${booking.notes}`] : []),
    '',
    `Need to cancel? ${manageUrl}`,
  ].join('\n');
  const row = (label, value) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;font-size:14px;vertical-align:top">${label}</td>` +
    `<td style="padding:4px 0;color:#111827;font-size:14px">${value}</td></tr>`;
  const html =
    `<div style="background:#f6f7f9;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">` +
    `<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px">` +
    bookStatusHtml('You&rsquo;re scheduled') +
    `<p style="margin:0 0 16px;color:#6b7280;font-size:14px">Your booking is confirmed.</p>` +
    `<h2 style="margin:0 0 12px;color:#111827;font-size:17px;font-weight:600;line-height:1.3">${bookEscapeHtml(booking.pageTitle)}</h2>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse">` +
    row('When', bookEscapeHtml(when)) +
    (booking.location ? row('Where', bookEscapeHtml(booking.location)) : '') +
    (joinUrl
      ? row('Join', `<a href="${bookEscapeHtml(joinUrl)}" style="color:#2563eb">${bookEscapeHtml(joinUrl)}</a>`)
      : '') +
    row('With', bookEscapeHtml(cfg.organizerName || cfg.organizerEmail || 'the organizer')) +
    `</table>` +
    (booking.notes
      ? `<p style="margin:16px 0 0;color:#374151;font-size:14px;white-space:pre-wrap">${bookEscapeBlock(booking.notes)}</p>`
      : '') +
    `<p style="margin:24px 0 0;font-size:13px;color:#6b7280">Need to cancel? ` +
    `<a href="${bookEscapeHtml(manageUrl)}" style="color:#2563eb">${bookEscapeHtml(manageUrl)}</a></p>` +
    bookFooterHtml() +
    `</div></div>`;
  const ics = bookingIcs(cfg, booking);
  const method = /^METHOD:([A-Za-z-]+)\s*$/m.exec(ics);
  return sendBookingMail(ctx, {
    to: booking.email,
    subject,
    text,
    html,
    replyTo: cfg.organizerEmail || undefined,
    attachments: [
      {
        filename: 'meeting.ics',
        content: bookBase64Utf8(ics),
        contentType: `text/calendar; charset=utf-8${method ? `; method=${method[1].toUpperCase()}` : ''}`,
      },
    ],
  });
}

/** New-booking notice to the host (their calendar shows it on next open; this
 *  is the "someone booked you" ping in between). */
async function sendHostBookedMail(ctx, cfg, page, booking) {
  if (!cfg.organizerEmail) return false;
  const when = bookWhen(booking, page.tz, cfg.hour12);
  const who = booking.name ? `${booking.name} (${booking.email})` : booking.email;
  const joinUrl = meetingLink(booking.meetingUrl);
  const subject = bookLine(`New booking: ${booking.name || booking.email} — ${when}`, 200);
  const text = [
    `\u2713 New booking`,
    '',
    `${who} booked "${booking.pageTitle}".`,
    '',
    `When: ${when}`,
    ...(booking.location ? [`Where: ${booking.location}`] : []),
    ...(joinUrl ? [`Join: ${joinUrl}`] : []),
    ...(booking.notes ? ['', `Notes: ${booking.notes}`] : []),
    '',
    'It will appear on your calendar the next time you open it.',
  ].join('\n');
  const html =
    `<div style="background:#f6f7f9;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">` +
    `<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px">` +
    bookStatusHtml('New booking') +
    `<p style="margin:0 0 8px;color:#111827;font-size:14px"><strong>${bookEscapeHtml(who)}</strong> booked &ldquo;${bookEscapeHtml(booking.pageTitle)}&rdquo;.</p>` +
    `<p style="margin:0 0 8px;color:#111827;font-size:14px">${bookEscapeHtml(when)}</p>` +
    (booking.location ? `<p style="margin:0 0 8px;color:#111827;font-size:14px">${bookEscapeHtml(booking.location)}</p>` : '') +
    (joinUrl
      ? `<p style="margin:0 0 8px;font-size:14px">Join: <a href="${bookEscapeHtml(joinUrl)}" style="color:#2563eb">${bookEscapeHtml(joinUrl)}</a></p>`
      : '') +
    (booking.notes ? `<p style="margin:16px 0 0;color:#374151;font-size:14px;white-space:pre-wrap">${bookEscapeBlock(booking.notes)}</p>` : '') +
    `<p style="margin:16px 0 0;font-size:13px;color:#6b7280">It will appear on your calendar the next time you open it.</p>` +
    bookFooterHtml() +
    `</div></div>`;
  return sendBookingMail(ctx, { to: cfg.organizerEmail, subject, text, html, replyTo: booking.email });
}

/** Cancellation notice to the host, including a receipt for their own cancellation. */
async function sendHostCancelMail(ctx, cfg, booking, cancelledBy) {
  if (!cfg.organizerEmail) return false;
  const who = booking.name ? `${booking.name} (${booking.email})` : booking.email;
  const hostWhen = bookWhen(booking, (cfg.pages[booking.pageId] || {}).tz || booking.tz, cfg.hour12);
  const hostCancelled = cancelledBy === 'host';
  const reason = booking.cancelReason ? `\n\n${hostCancelled ? 'Your' : 'Their'} note: ${booking.cancelReason}` : '';
  const intro = hostCancelled
    ? `You cancelled the "${booking.pageTitle}" booking with ${who}.`
    : `${who} cancelled their "${booking.pageTitle}" booking.`;
  return sendBookingMail(ctx, {
    to: cfg.organizerEmail,
    subject: bookLine(`Cancelled: ${booking.name || booking.email} — ${hostWhen}`, 200),
    text: `${intro}\n\nWhen: ${hostWhen}${reason}\n\nThe time is open again, and the event will leave your calendar the next time you open it.`,
    html:
      `<div style="background:#f6f7f9;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">` +
      `<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px">` +
      `<h1 style="margin:0 0 16px;color:#111827;font-size:20px;line-height:1.3">Booking cancelled</h1>` +
      `<p style="margin:0 0 8px;color:#111827;font-size:14px">${hostCancelled
        ? `You cancelled the &ldquo;${bookEscapeHtml(booking.pageTitle)}&rdquo; booking with <strong>${bookEscapeHtml(who)}</strong>.`
        : `<strong>${bookEscapeHtml(who)}</strong> cancelled &ldquo;${bookEscapeHtml(booking.pageTitle)}&rdquo;.`}</p>` +
      `<p style="margin:0 0 8px;color:#111827;font-size:14px">${bookEscapeHtml(hostWhen)}</p>` +
      (booking.cancelReason
        ? `<p style="margin:16px 0 0;color:#374151;font-size:14px;white-space:pre-wrap">${bookEscapeBlock(booking.cancelReason)}</p>`
        : '') +
      bookFooterHtml() +
      `</div></div>`,
    replyTo: booking.email,
  });
}

/** Guest cancellation notifies the host; a host cancellation offers the guest a rebook link. */
async function sendCancelMail(ctx, cfg, booking, cancelledBy, origin) {
  if (cancelledBy === 'guest') return sendHostCancelMail(ctx, cfg, booking, cancelledBy);
  const when = bookWhen(booking, booking.tz, true);
  // Host cancelled — tell the guest, and offer the page again if it's live.
  const page = cfg.pages[booking.pageId];
  const rebook = page && page.enabled ? `${origin}/book/${page.id}` : '';
  return sendBookingMail(ctx, {
    to: booking.email,
    subject: bookLine(`Cancelled: ${booking.pageTitle} — ${when}`, 200),
    text:
      `Hi ${booking.name || 'there'},\n\n${cfg.organizerName || 'The organizer'} cancelled your booking.\n\n${booking.pageTitle}\nWhen: ${when}` +
      (rebook ? `\n\nPick a new time: ${rebook}` : ''),
    html:
      `<div style="background:#f6f7f9;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">` +
      `<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px">` +
      `<h1 style="margin:0 0 16px;color:#111827;font-size:20px;line-height:1.3">Booking cancelled</h1>` +
      `<p style="margin:0 0 8px;color:#111827;font-size:14px">${bookEscapeHtml(cfg.organizerName || 'The organizer')} cancelled your booking.</p>` +
      `<p style="margin:0 0 4px;color:#111827;font-size:14px"><strong>${bookEscapeHtml(booking.pageTitle)}</strong></p>` +
      `<p style="margin:0 0 8px;color:#111827;font-size:14px">${bookEscapeHtml(when)}</p>` +
      (rebook
        ? `<p style="margin:16px 0 0;font-size:13px;color:#6b7280">Pick a new time: <a href="${bookEscapeHtml(rebook)}" style="color:#2563eb">${bookEscapeHtml(rebook)}</a></p>`
        : '') +
      bookFooterHtml() +
      `</div></div>`,
    replyTo: cfg.organizerEmail || undefined,
  });
}

/* ---- Booking: shared route plumbing ---------------------------------------- */

/** Parse a guest POST body — urlencoded (the page's format: it keeps the
 *  cross-origin POST a CORS "simple request", exactly like the RSVP page) or
 *  JSON. Returns a plain { field: string } object. */
async function bookReadBody(request) {
  const type = (request.headers.get('content-type') || '').toLowerCase();
  try {
    if (type.includes('application/json')) {
      const body = await request.json();
      return body && typeof body === 'object' ? body : {};
    }
    const params = new URLSearchParams(await request.text());
    const out = {};
    for (const [key, value] of params) out[key] = value;
    return out;
  } catch {
    return {};
  }
}

/** Send the visitor to the app-hosted booking page (public/book.html), params
 *  in the fragment like the RSVP redirect — tokens never hit logs/referrers. */
function bookPageUrl() {
  const base = /^https?:\/\//i.test(PAGE_URL) ? PAGE_URL : 'https://calendar.puter.com/rsvp.html';
  try {
    return new URL('book.html', base).toString();
  } catch {
    return 'https://calendar.puter.com/book.html';
  }
}

function redirectToBookPage(ctx, params) {
  const search = new URLSearchParams({ w: new URL(ctx.request.url).origin, ...params });
  return new Response(null, {
    status: 303,
    headers: {
      location: `${bookPageUrl()}#${search.toString()}`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}

function validBookingPageId(id) {
  return typeof id === 'string' && PAGE_ID_RE.test(id);
}

/** The page `id` names in `cfg`, or null. Own keys only: `cfg.pages` is a
 *  parsed JSON object, so a URL asking for `constructor` would otherwise find
 *  Object's — a "page" with `enabled` undefined, answered 410 "page off" with
 *  the host's name attached, for a page that never existed. */
function bookingPageOf(cfg, id) {
  if (!validBookingPageId(id) || !Object.prototype.hasOwnProperty.call(cfg.pages, id)) return null;
  const page = cfg.pages[id];
  return page && typeof page === 'object' ? page : null;
}

/** Resolve a manage token to its booking, or null. Mirrors the RSVP token
 *  lookup: hash the token, follow the pointer, and require the booking to
 *  still carry this very hash. */
async function lookupBookingToken(ctx, token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{40}$/.test(token)) return null;
  const kv = kvOf(ctx);
  const tokenHash = await sha256Hex(token);
  const ref = coerce(await kv.get(BOOK_TOK_PREFIX + tokenHash));
  if (!ref || typeof ref.bookingId !== 'string') return null;
  const booking = coerce(await kv.get(BOOK_PREFIX + ref.bookingId));
  if (!booking || booking.tokenHash !== tokenHash) return null;
  return booking;
}

async function markBookingCancelled(kv, booking, by, reason) {
  booking.status = 'cancelled';
  booking.cancelledAt = Date.now();
  booking.cancelledBy = by;
  booking.updatedAt = Date.now();
  const note = str(reason, 500).trim();
  if (note) booking.cancelReason = note;
  await kv.set(BOOK_PREFIX + booking.id, booking);
  // Free the slot claim — but only if it is still ours. The record above is
  // what actually frees the time; the claim is a backstop, and a stale one
  // blocks nothing, so it must not be able to fail the cancellation.
  try {
    const claim = coerce(await kv.get(BOOK_SLOT_PREFIX + booking.start));
    if (claim && claim.bookingId === booking.id) await kv.del(BOOK_SLOT_PREFIX + booking.start);
  } catch {
    /* leave it; nothing consults a claim without also checking the record */
  }
}

/* ---- Booking: admin routes -------------------------------------------------- */

router.post('/admin/booking/sync', async (ctx) => {
  if (!(await isAdmin(ctx.request))) return json({ error: 'unauthorized' }, 401);
  let body = null;
  try {
    body = await ctx.request.json();
  } catch {
    /* refused below */
  }
  // A body that isn't an object is a broken request, not an instruction to
  // publish no pages and no busy time. Writing the sanitizer's empty config
  // over the live one answered 200 — so the app recorded the push as done
  // and every booking link 404ed until something else changed. (An intended
  // clearing still arrives as an object with `pages: []`.)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'booking config required' }, 400);
  }
  const cfg = sanitizeBookingSync(body);
  await kvOf(ctx).set(BOOK_CFG_KEY, cfg);
  return json({ ok: true, pages: Object.keys(cfg.pages).length, busy: cfg.busy.length });
});

router.get('/admin/booking/list', async (ctx) => {
  if (!(await isAdmin(ctx.request))) return json({ error: 'unauthorized' }, 401);
  const kv = kvOf(ctx);
  const bookings = await loadBookings(kv);
  const keep = [];
  for (const b of bookings) {
    // A reservation still inside the request that wrote it is not a booking
    // yet: that request may roll it back (a storage error, the both-racers-
    // yield case), and an event the app created from it would then outlive
    // it for good — the app only adopts and cancels what is LISTED. It is
    // listed on the next pull, once committed (or once the settle window has
    // lapsed and the mark is no longer trusted).
    if (bookingSettling(b, Date.now())) continue;
    // Records long past their meeting are dead weight in the host's storage;
    // 200 days comfortably outlives every "what was that meeting?" question.
    if (Number.isFinite(b.end) && Date.now() - b.end > 200 * BOOK_DAY_MS) {
      // Housekeeping, not the job: a delete that will not go through must not
      // fail this route. It is the app's only way to learn about bookings at
      // all, so one undeletable record from last year would otherwise stop
      // every future booking from ever reaching the calendar. Skip it and try
      // again on the next pull.
      try {
        await kv.del(BOOK_PREFIX + b.id);
        if (b.tokenHash) await kv.del(BOOK_TOK_PREFIX + b.tokenHash);
        const claim = coerce(await kv.get(BOOK_SLOT_PREFIX + b.start));
        if (claim && claim.bookingId === b.id) await kv.del(BOOK_SLOT_PREFIX + b.start);
      } catch {
        /* leave it for next time */
      }
      continue;
    }
    keep.push(adminBookingView(b));
  }
  return json({ ok: true, bookings: keep });
});

router.post('/admin/booking/cancel', async (ctx) => {
  if (!(await isAdmin(ctx.request))) return json({ error: 'unauthorized' }, 401);
  let body = null;
  try {
    body = await ctx.request.json();
  } catch {
    /* handled below */
  }
  const id = body && typeof body.id === 'string' ? body.id : '';
  if (!/^[0-9a-f]{6,64}$/.test(id)) return json({ error: 'id required' }, 400);
  const kv = kvOf(ctx);
  const booking = coerce(await kv.get(BOOK_PREFIX + id));
  if (!booking || typeof booking !== 'object') return json({ error: 'not_found' }, 404);
  if (booking.status === 'cancelled') return json({ ok: true, booking: adminBookingView(booking) });
  await markBookingCancelled(kv, booking, 'host', body && body.reason);
  let emailed = false;
  if (!body || body.notify !== false) {
    // The cancellation is recorded by now; notifying both people is best-effort,
    // and a throw here would answer 500 to an app that has just cancelled
    // successfully, leaving the event on the host's calendar until a later
    // pull happened to clean it up.
    emailed = await loadBookingCfg(kv)
      .then(async (cfg) => {
        const guestEmailed = await sendCancelMail(ctx, cfg, booking, 'host', new URL(ctx.request.url).origin).catch(() => false);
        await sendHostCancelMail(ctx, cfg, booking, 'host').catch(() => false);
        return guestEmailed;
      })
      .catch(() => false);
  }
  return json({ ok: true, booking: adminBookingView(booking), emailed });
});

/* ---- Booking: guest-facing JSON API ------------------------------------------ */

router.get('/api/book/:page', async (ctx) => {
  if (!validBookingPageId(ctx.params.page)) return json({ error: 'not_found' }, 404);
  const kv = kvOf(ctx);
  const cfg = await loadBookingCfg(kv);
  const page = bookingPageOf(cfg, ctx.params.page);
  if (!page) return json({ error: 'not_found' }, 404);
  if (!page.enabled) return json({ error: 'page_off', organizer: cfg.organizerName || '' }, 410);
  const bookings = await loadBookings(kv);
  return json({
    ok: true,
    page: publicPageView(cfg, page),
    firstAvailable: firstBookableSlot(cfg, page, bookings, Date.now()),
    now: Date.now(),
  });
});

router.get('/api/book/:page/slots', async (ctx) => {
  if (!validBookingPageId(ctx.params.page)) return json({ error: 'not_found' }, 404);
  const kv = kvOf(ctx);
  const cfg = await loadBookingCfg(kv);
  const page = bookingPageOf(cfg, ctx.params.page);
  if (!page) return json({ error: 'not_found' }, 404);
  if (!page.enabled) return json({ error: 'page_off' }, 410);
  const now = Date.now();
  const url = new URL(ctx.request.url);
  // Absent params must fall to the defaults — Number(null) is 0, which would
  // "pass" isFinite and turn a missing ?to= into an empty result.
  const fromRaw = url.searchParams.get('from');
  const toRaw = url.searchParams.get('to');
  let from = fromRaw == null || fromRaw === '' ? NaN : Number(fromRaw);
  let to = toRaw == null || toRaw === '' ? NaN : Number(toRaw);
  if (!Number.isFinite(from)) from = now;
  if (!Number.isFinite(to)) to = from + 31 * BOOK_DAY_MS;
  // Clamp to what can possibly hold slots, and bound the work per request.
  from = Math.max(from, now - BOOK_DAY_MS);
  to = Math.min(to, now + (page.maxAdvanceDays + 2) * BOOK_DAY_MS);
  to = Math.min(to, from + BOOK_SLOT_QUERY_MAX_DAYS * BOOK_DAY_MS);
  if (to <= from) return json({ ok: true, slots: [], durationMin: page.durationMin });
  const bookings = await loadBookings(kv);
  return json({
    ok: true,
    slots: bookableSlots(cfg, page, bookings, from, to, now),
    durationMin: page.durationMin,
  });
});

router.post('/api/book/:page', async (ctx) => {
  if (!validBookingPageId(ctx.params.page)) return json({ error: 'not_found' }, 404);
  const kv = kvOf(ctx);
  const cfg = await loadBookingCfg(kv);
  const page = bookingPageOf(cfg, ctx.params.page);
  if (!page) return json({ error: 'not_found' }, 404);
  if (!page.enabled) return json({ error: 'page_off' }, 410);

  const body = await bookReadBody(ctx.request);
  const name = bookLine(body.name, 200);
  const email = lowerEmail(body.email);
  const notes = str(body.notes, 2000).trim();
  const guestTz = bookValidTz(body.tz) ? body.tz : '';
  const start = Number(body.start);
  if (!name) return json({ error: 'name_required' }, 400);
  if (!email) return json({ error: 'email_required' }, 400);
  if (!Number.isFinite(start)) return json({ error: 'invalid_slot' }, 400);

  // A start outside what the slot engine could possibly offer is a bad
  // request. Checking the range here (the same bounds the GET route clamps to)
  // also keeps a finite-but-absurd value — e.g. 9e15, beyond Date's ±8.64e15
  // range — from reaching Intl inside bookableSlots, where it would throw a
  // RangeError instead of answering 400.
  const now = Date.now();
  if (start < now - BOOK_DAY_MS || start > now + (page.maxAdvanceDays + 2) * BOOK_DAY_MS) {
    return json({ error: 'invalid_slot' }, 400);
  }

  // Is this start on the page's grid AT ALL — right weekday, inside a window,
  // on the increment, within notice and horizon? Pure computation over the
  // config we already hold, so a malformed or stale start is answered without
  // touching storage, and only a start that could really be booked goes on to
  // reserve keys below.
  const scheduled = bookableSlots(cfg, page, [], start, start + 1, now, { ignoreConflicts: true });
  if (!scheduled.includes(start)) return json({ error: 'invalid_slot' }, 400);

  // Anti-abuse: the page is public, so cap how many bookings a day it accepts.
  const newKey = `${BOOK_NEW_PREFIX}${page.id}:${new Date(now).toISOString().slice(0, 10)}`;
  const createdToday = Number(coerce(await kv.get(newKey))) || 0;
  if (createdToday >= BOOK_MAX_PER_PAGE_PER_DAY) return json({ error: 'too_many' }, 429);

  const id = newToken().slice(0, 32); // 128 bits, hex — also the calendar event id
  const token = newToken();
  const tokenHash = await sha256Hex(token);
  const booking = {
    id,
    pageId: page.id,
    pageTitle: page.title,
    location: page.location,
    // Each booking gets its own room (different guests must never share one).
    // Minted before the record is written so the confirmation email, the .ics,
    // the manage page, and the host's pulled event all carry the same link.
    ...(page.meet ? { meetingUrl: mintMeetingUrl() } : {}),
    durationMin: page.durationMin,
    start,
    end: start + page.durationMin * MIN_MS,
    name,
    email,
    notes,
    tz: guestTz,
    status: 'confirmed',
    createdAt: now,
    updatedAt: now,
    tokenHash,
  };

  /**
   * RESERVE, then check — the order is what makes the race safe.
   *
   * puter.kv has no transactions, so two guests can only be separated by what
   * each can SEE of the other. Writing the record before the (storage-heavy)
   * availability check means every request's own check runs against a store
   * that already holds its reservation, and that is enough to prove no pair
   * can both survive: for racers A and B, A surviving needs B's record to
   * arrive after A's check, and B surviving needs A's record to arrive after
   * B's check — and since each record is written before that same request's
   * check, the two conditions chain into a contradiction. (Validating first,
   * as this route used to, left the opposite: a slower older request could
   * finish behind a faster younger one, and both were confirmed for the same
   * minute.) Two exactly-simultaneous racers can now both yield, which is a
   * "pick another time" on a slot that is in fact free — the safe direction,
   * and one more press settles it.
   */
  const rollback = async () => {
    // Best effort, each key on its own: a reservation that cannot be deleted
    // must at least stop blocking the slot and stop reaching the host's
    // calendar, so fall back to marking it cancelled.
    try {
      await kv.del(BOOK_PREFIX + id);
    } catch {
      try {
        await kv.set(BOOK_PREFIX + id, { ...booking, status: 'cancelled', cancelledBy: 'system' });
      } catch {
        /* nothing else to try */
      }
    }
    try {
      await kv.del(BOOK_TOK_PREFIX + tokenHash);
    } catch {
      /* an orphan token points at a cancelled/absent booking — harmless */
    }
    try {
      const held = coerce(await kv.get(BOOK_SLOT_PREFIX + start));
      if (held && held.bookingId === id) await kv.del(BOOK_SLOT_PREFIX + start);
    } catch {
      /* the claim is only ever a backstop; a stale one blocks nothing */
    }
  };

  // `pending` marks a reservation that has not yet passed its own check, so
  // a concurrent request can tell it from a committed booking (see
  // bookingSettling). Cleared — by rewriting the record — once settle() lets
  // this booking stand.
  try {
    await kv.set(BOOK_PREFIX + id, { ...booking, pending: true });
    await kv.set(BOOK_TOK_PREFIX + tokenHash, { bookingId: id });
  } catch {
    // The record may have landed without its token pointer. Left there it is
    // the worst of both: the admin view strips `pending`, so the host's
    // calendar adopts a booking whose guest was told it failed, who holds no
    // link to cancel it — and once the settle window lapses it blocks the slot
    // for everyone else. Take it back, best-effort, and say the request
    // failed; the guest's retry starts clean.
    await rollback().catch(() => {});
    return json({ error: 'unavailable' }, 503);
  }

  /** Everything between the reservation and the commit. Resolves to the reply
   *  to send when the reservation must be given up, or null to go ahead. */
  const settle = async () => {
    // Everything but our own reservation — which must not be allowed to block
    // the very slot it is reserving (nor count against the per-day cap).
    const others = (await loadBookings(kv)).filter((b) => b && b.id !== id);
    if (!bookableSlots(cfg, page, others, start, start + 1, now).includes(start)) {
      await rollback();
      // A resubmit — the guest pressed Schedule again after a reply went
      // missing — is not a lost slot: they already hold this booking, so hand
      // it back instead of telling them to pick another time they cannot have.
      //
      // ...provided it IS a booking. A same-guest record still inside its own
      // settle() is the other half of a double-submit racing us — two tabs, or
      // a retry overtaking a slow first request — and it yields on seeing OUR
      // reservation exactly as we yield on seeing its, so both would answer
      // "you already hold this" while both records vanish: a confirmation
      // for a meeting that does not exist, that the host never hears of. Have
      // that guest press again instead. By then the other request has either
      // committed (and this branch hands its booking back) or rolled back
      // (and the slot is simply free) — the same one-more-press the
      // different-guest race settles with.
      const mine = others.find(
        (b) =>
          b.status === 'confirmed' &&
          b.start === start &&
          b.pageId === page.id &&
          b.email === email,
      );
      if (mine && !bookingSettling(mine, now)) {
        return json({
          ok: true,
          duplicate: true,
          booking: guestBookingView(cfg, mine, now),
          emailed: { guest: false, host: false },
        });
      }
      return json({ error: 'slot_taken' }, 409);
    }

    // Backstop for the exact-start case: claim the minute and read it back —
    // whoever's id is there wins. Written only now that the slot has been won,
    // so a request on its way to yielding can never overwrite (and then, on
    // rollback, delete) the claim of the booking that beat it.
    await kv.set(BOOK_SLOT_PREFIX + start, { bookingId: id });
    const claim = coerce(await kv.get(BOOK_SLOT_PREFIX + start));
    if (claim && claim.bookingId !== id) {
      await rollback();
      return json({ error: 'slot_taken' }, 409);
    }

    // Second backstop, against a fresh read: a booking that arrived since the
    // check above. Deterministic loser, so a pair that reaches here still
    // settles to one — the later (or lexicographically larger) booking yields.
    for (const other of await loadBookings(kv)) {
      if (!other || other.id === id || other.status !== 'confirmed') continue;
      if (bookingBlocks(cfg, page, other, booking.start, booking.end)) {
        if (other.createdAt < booking.createdAt || (other.createdAt === booking.createdAt && other.id < id)) {
          await rollback();
          return json({ error: 'slot_taken' }, 409);
        }
      }
    }
    return null;
  };

  let verdict;
  try {
    verdict = await settle();
  } catch (err) {
    // Storage went wrong somewhere in there. The reservation is already
    // written, so doing nothing would leave a booking on the host's calendar
    // that its guest was told had failed — the one outcome worse than
    // failing. Give it up and say so; the guest's retry starts clean, and if
    // the rollback itself could not land, their retry is recognised as the
    // resubmit it is.
    await rollback().catch(() => {});
    return json({ error: 'unavailable' }, 503);
  }
  if (verdict) return verdict;

  // The booking stands: clear the reservation's `pending` mark. Best-effort —
  // the booking is committed by now, and bookingSettling() stops trusting a
  // stale mark on its own, so a failed rewrite costs nothing but a resubmit
  // within the next two minutes being asked to press once more.
  await kv.set(BOOK_PREFIX + id, booking).catch(() => {});

  await bookBumpCounter(kv, newKey, 1);
  const origin = new URL(ctx.request.url).origin;
  // Mail is best-effort by design, and that has to include THROWING: the
  // booking is committed by now, so a formatting or transport surprise must
  // cost the announcement, not the guest's reply.
  const emailedGuest = await sendGuestConfirmMail(ctx, cfg, booking, token, origin).catch(() => false);
  const emailedHost = await sendHostBookedMail(ctx, cfg, page, booking).catch(() => false);

  return json({
    ok: true,
    token,
    booking: guestBookingView(cfg, booking, now),
    emailed: { guest: emailedGuest, host: emailedHost },
  });
});

router.get('/api/booking/:token', async (ctx) => {
  const booking = await lookupBookingToken(ctx, ctx.params.token);
  if (!booking) return json({ error: 'not_found' }, 404);
  const cfg = await loadBookingCfg(kvOf(ctx));
  const page = cfg.pages[booking.pageId];
  return json({
    ok: true,
    booking: guestBookingView(cfg, booking),
    page: page ? { id: page.id, enabled: Boolean(page.enabled) } : null,
  });
});

router.post('/api/booking/:token/cancel', async (ctx) => {
  const booking = await lookupBookingToken(ctx, ctx.params.token);
  if (!booking) return json({ error: 'not_found' }, 404);
  const kv = kvOf(ctx);
  const cfg = await loadBookingCfg(kv);
  if (booking.status === 'cancelled') {
    return json({ ok: true, booking: guestBookingView(cfg, booking) });
  }
  if (booking.start <= Date.now()) return json({ error: 'started' }, 410);
  const body = await bookReadBody(ctx.request);
  await markBookingCancelled(kv, booking, 'guest', body.reason);
  // Same reasoning as the host route: the cancellation is already recorded, so
  // a mail failure must not answer 500 and tell the guest it didn't happen.
  await sendCancelMail(ctx, cfg, booking, 'guest', new URL(ctx.request.url).origin).catch(() => false);
  return json({ ok: true, booking: guestBookingView(cfg, booking) });
});

/* ---- Booking: human links ------------------------------------------------- */

// The link the host shares. Nothing here mutates, so prefetchers are harmless.
router.get('/book/:page', async (ctx) =>
  redirectToBookPage(ctx, validBookingPageId(ctx.params.page) ? { p: ctx.params.page } : {}),
);

// The guest's private manage link (from their confirmation email/page).
router.get('/booking/:token', async (ctx) =>
  redirectToBookPage(
    ctx,
    /^[0-9a-f]{40}$/.test(String(ctx.params.token || '')) ? { t: ctx.params.token } : {},
  ),
);
