/**
 * Signing endpoint, a Puter serverless worker deployed into the document
 * owner's own account (see src/lib/signlinks.js for the deploy/sync side).
 *
 * Signers hold capability URLs: /sign/<token>, one unguessable 160-bit token
 * per signer per document. Only a SHA-256 hash of each token is stored, so a
 * leak of this worker's KV reveals no usable links; the raw token exists only
 * in the link itself (and in the owner's document record in the app).
 *
 * This worker serves NO HTML. It is a JSON API plus a redirect (Puter
 * guidance: workers as API-like endpoints). The human-facing signing page is
 * the app's own sign.html at PAGE_URL, which calls this API from the signer's
 * browser. The worker origin and token travel in the URL FRAGMENT, which
 * browsers never send over the wire, keeping tokens out of logs and referrers.
 *
 * With sequential signing on, every signer route is gated on the signers
 * ahead of this one having signed: the worker answers `not_yet` and serves
 * neither the document nor its file, so the order holds even against a
 * hand-rolled request.
 *
 * A signer may also need an ACCESS CODE, the second factor for a link that
 * leaked (a forwarded mail, a shared inbox, a mistyped address). Only a
 * salted hash is stored, attempts are rate-limited and lock out, and a
 * correct code buys a short-lived session for that one token so the signer is
 * not asked again mid-signing.
 *
 *   JSON API (the only data surface):
 *     GET  /api/sign/<token>       -> document view: fields, values, statuses
 *                                     (marks the signer as having viewed)
 *     GET  /api/sign/<token>/pdf   -> the original PDF bytes
 *     POST /api/sign/<token>       -> { action: 'unlock' | 'consent' | 'sign'
 *                                     | 'decline' }. With an access code set,
 *                                     'unlock' comes first and returns the
 *                                     session every other call carries in
 *                                     x-sign-session. Consent comes before a
 *                                     signature: one without a recorded
 *                                     agreement is refused.
 *
 *   Human link:
 *     GET  /sign/<token>           -> 303 to PAGE_URL#w=<origin>&t=<token>
 *
 * The app manages this worker over /admin/* routes, authenticated with
 * `Authorization: Bearer <secret>`. Only SHA-256(secret) is baked into this
 * source, so the deployed file itself contains no credential.
 *
 * The owner also gets told. This worker runs inside their own Puter account
 * and is the only piece that is awake when the app is closed, so when a
 * signer signs, declines, or a document completes it mails the owner from
 * their own account (see notifyOwner). Every attempt is recorded, success or
 * failure, so the app can fall back to sending it from the app instead.
 *
 * KV layout (this worker's own namespace):
 *   sigw:tok:<sha256(token)>       -> { docId, signerId }
 *   sigw:notif:<docId>:<kind>:<signerId>  -> { at, ok, error } one owner
 *                                            notification, attempted once
 *   sigw:sess:<sha256(session)>    -> { docId, signerId, exp } an unlocked
 *                                     signer's short-lived session
 *   sigw:doc:<docId>               -> { doc, signers: { [id]: { name, email,
 *                                       kind, signed, tokenHash } }, fields,
 *                                       values, voided, expiresAt, signOrder,
 *                                       order, channel, notify, updatedAt }
 *   sigw:resp:<docId>:<signerId>   -> { status, viewedAt, signedAt,
 *                                       declinedAt, declineReason, values,
 *                                       acked, consentAt, consentVersion,
 *                                       view/consent/sign: { at, ip, ua,
 *                                       tzOffset, tzName } }
 *
 * Responses live in per-signer keys ON PURPOSE: a signer's POST writes only
 * their own key, so it can never race an /admin/sync (which rewrites the
 * membership record) or another signer's answer.
 */

/* Placeholders replaced at deploy time by signlinks.js. */
const ADMIN_SECRET_HASH = '__SIGN_ADMIN_SECRET_HASH__';
const WORKER_VERSION = '__SIGN_WORKER_VERSION__';
const PAGE_URL = '__SIGN_PAGE_URL__'; // the app-hosted signing page (sign.html)

const TOK_PREFIX = 'sigw:tok:';
const DOC_PREFIX = 'sigw:doc:';
const RESP_PREFIX = 'sigw:resp:';
const NOTIF_PREFIX = 'sigw:notif:';
const SESS_PREFIX = 'sigw:sess:';

/* Access codes: a link that leaked is worth one guess in five, then a wait. */
const MAX_CODE_FAILS = 5;
const CODE_LOCK_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

const MAX_SIGNERS = 20;
const MAX_FIELDS = 200;
const MAX_TEXT = 2000;
const MAX_REASON = 500;
const MAX_IMAGE_CHARS = 300_000; // one signature PNG as a data URL
const MAX_VALUES_CHARS = 900_000; // everything one signer submits

/* ---- Small utilities ----------------------------------------------------- */

function ownerOf(ctx) {
  return (ctx && ctx.me) || (typeof me !== 'undefined' ? me : null);
}

function kvOf(ctx) {
  return ownerOf(ctx).puter.kv;
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

/** 20 crypto-random bytes as 40 hex chars (160 bits, unguessable). */
function newToken() {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function str(v, cap) {
  return typeof v === 'string' ? v.slice(0, cap) : '';
}

/**
 * The signer's IP as the edge saw it. Every one of these headers is set by
 * the proxy in front of this worker, not by the client, and the first entry
 * of a forwarded chain is the original caller.
 */
function clientIp(ctx) {
  const headers = ctx.request.headers;
  for (const name of ['cf-connecting-ip', 'true-client-ip', 'x-real-ip', 'x-forwarded-for']) {
    const value = headers.get(name);
    if (typeof value === 'string' && value.trim()) return value.split(',')[0].trim().slice(0, 60);
  }
  return '';
}

/**
 * The technical context of one act: when it happened by this worker's clock,
 * where from, on what, and (when the page tells us) the signer's own clock.
 * This is the evidence the certificate prints.
 */
function evidence(ctx, body) {
  const src = body && typeof body === 'object' ? body : {};
  const offset = Number(src.tzOffset);
  return {
    at: Date.now(),
    ip: clientIp(ctx),
    ua: str(ctx.request.headers.get('user-agent') || '', 300),
    // Minutes east of UTC. Anything outside the real range is not a clock.
    tzOffset: Number.isFinite(offset) && Math.abs(offset) <= 840 ? Math.round(offset) : undefined,
    tzName: str(src.tzName, 60),
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      // Payloads carry personal data and are keyed by capability URLs;
      // nothing here may be cached by proxies or the browser.
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

async function requireAdmin(ctx) {
  const header = ctx.request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  return (await sha256Hex(match[1].trim())) === ADMIN_SECRET_HASH;
}

async function readJson(ctx) {
  try {
    return await ctx.request.json();
  } catch {
    return null;
  }
}

/* ---- Records --------------------------------------------------------------- */

function respKey(docId, signerId) {
  return `${RESP_PREFIX}${docId}:${signerId}`;
}

async function loadByToken(ctx, token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{40}$/.test(token)) return null;
  const kv = kvOf(ctx);
  const ref = coerce(await kv.get(TOK_PREFIX + (await sha256Hex(token))));
  if (!ref || !ref.docId || !ref.signerId) return null;
  const record = coerce(await kv.get(DOC_PREFIX + ref.docId));
  if (!record || !record.signers || !record.signers[ref.signerId]) return null;
  return { kv, docId: ref.docId, signerId: ref.signerId, record };
}

async function loadResponses(kv, docId, signerIds) {
  const out = {};
  for (const signerId of signerIds) {
    const resp = coerce(await kv.get(respKey(docId, signerId)));
    if (resp) out[signerId] = resp;
  }
  return out;
}

/**
 * One signer's status. Self signers (the owner signing in the app) carry
 * theirs in the snapshot; external signers carry theirs in their own
 * response record.
 */
function statusOf(record, resps, signerId) {
  const signer = record.signers[signerId];
  if (!signer) return 'pending';
  if (signer.kind === 'self') return signer.signed ? 'signed' : 'pending';
  return (resps[signerId] && resps[signerId].status) || 'pending';
}

/**
 * The document's overall state as this worker can see it.
 */
function docState(record, resps) {
  if (record.voided) return 'voided';
  let allSigned = true;
  for (const signerId of Object.keys(record.signers)) {
    const status = statusOf(record, resps, signerId);
    if (status === 'declined') return 'declined';
    if (status !== 'signed') allSigned = false;
  }
  // Everyone signing beats the clock: a document finished before its deadline
  // is completed, not expired.
  if (allSigned) return 'completed';
  if (record.expiresAt && record.expiresAt <= Date.now()) return 'expired';
  return 'open';
}

/**
 * Sequential signing: is it this signer's turn? Only once every signer ahead
 * of them in `order` has signed. Without the toggle, or for a signer the
 * order does not mention, the answer is always yes.
 */
function turnState(record, resps, signerId) {
  if (!record.signOrder) return { ok: true };
  const order = Array.isArray(record.order) && record.order.length
    ? record.order
    : Object.keys(record.signers);
  const index = order.indexOf(signerId);
  if (index <= 0) return { ok: true };
  for (const earlier of order.slice(0, index)) {
    if (!record.signers[earlier]) continue;
    if (statusOf(record, resps, earlier) !== 'signed') {
      return {
        ok: false,
        waitingFor: record.signers[earlier].name || '',
        position: index + 1,
        total: order.length,
      };
    }
  }
  return { ok: true };
}

/**
 * The 410 a signer gets when there is nothing left to do here: the sender
 * withdrew the document, or its deadline passed. Enforced in the worker so it
 * holds whether or not the app is open.
 *
 * Decided from the document's STATE, not from the clock alone: docState puts
 * everyone-signed ahead of the deadline, and so does the app. Reading the
 * clock by itself here shut a completed document the moment its deadline went
 * by - a signer coming back for the completed copy the page had just offered
 * them was told the request had expired.
 */
function closedResponse(record, state) {
  if (state === 'voided') return json({ error: 'voided' }, 410);
  if (state === 'expired') return json({ error: 'expired', expiredAt: record.expiresAt }, 410);
  return null;
}

/**
 * The 409 a signer gets when their turn has not come around yet - unless it
 * never will: a decline anywhere on the document closes signing for
 * everyone, and a signer parked behind it must hear that, not "wait for
 * Ava", who is the one who declined. The page offered them an email that was
 * never going to come. Still nothing about the document is served.
 *
 * `channel` is how the sender hands links out ('email', 'link', or '' when
 * unknown): the page's promise of an email when the turn comes was empty
 * for a sender who copies each link by hand.
 */
function notYet(turn, state, record) {
  if (state === 'declined') return json({ error: 'declined' }, 410);
  return json({
    error: 'not_yet',
    waitingFor: turn.waitingFor,
    position: turn.position,
    total: turn.total,
    channel: (record && record.channel) || '',
  }, 409);
}

/* ---- Access codes ----------------------------------------------------------- */

/** Codes are shared out loud and typed back in: case and spacing are noise. */
function normalizeCode(value) {
  return typeof value === 'string' ? value.trim().toUpperCase().replace(/\s+/g, '').slice(0, 64) : '';
}

async function codeHashOf(salt, code) {
  return sha256Hex(`${salt}:${normalizeCode(code)}`);
}

/** A session that has run its course, or one nothing can read any more. */
function sessionDead(session) {
  return !session || !session.exp || session.exp < Date.now();
}

/**
 * Ask the store to drop a key on its own once it has outlived its use, where
 * the platform offers that. Best effort: a key that lingers is swept up by
 * the scans below, and an unlocked session is never trusted past its `exp`
 * either way.
 */
async function expireKey(kv, key, seconds) {
  try {
    if (typeof kv.expire === 'function') await kv.expire(key, seconds);
  } catch {
    /* swept up later */
  }
}

/**
 * Does this request carry an unlocked session for this signer? Sessions are
 * stored by HASH, like the tokens, and expire on their own. One that has run
 * out is deleted the moment it is seen: every unlock left a key behind that
 * nothing removed, and the scans that find sessions by value (a replaced
 * code, a reissued link, a revoked document) walked all of them, forever.
 */
async function sessionOk(ctx, kv, docId, signerId) {
  const raw = ctx.request.headers.get('x-sign-session') || '';
  if (!/^[0-9a-f]{40}$/.test(raw)) return false;
  const key = SESS_PREFIX + (await sha256Hex(raw));
  const record = coerce(await kv.get(key));
  if (sessionDead(record)) {
    if (record) await kv.del(key).catch(() => {});
    return false;
  }
  return record.docId === docId && record.signerId === signerId;
}

/**
 * Forget every unlocked session for one signer. Sessions are keyed by their
 * own hash, so they can only be found by value (the scan /admin/revoke does).
 * Dead sessions met along the way go too, whoever they belonged to.
 *
 * Called whenever the second factor changes: replacing a code that leaked has
 * to shut the door NOW. Without this, whoever already traded the old code for
 * a session kept walking straight past the gate until it expired on its own,
 * which is exactly the person the owner was locking out.
 */
async function dropSessions(kv, docId, signerId) {
  for (const key of (await kv.list(`${SESS_PREFIX}*`)) || []) {
    const session = coerce(await kv.get(key));
    if (sessionDead(session) || (session.docId === docId && session.signerId === signerId)) {
      await kv.del(key).catch(() => {});
    }
  }
}

/**
 * The access-code gate, in front of everything a signer can reach. Returns
 * null when the way is clear, or the response to send back.
 */
async function codeGate(ctx, kv, docId, signerId, signer) {
  if (!signer.codeHash) return null;
  if (await sessionOk(ctx, kv, docId, signerId)) return null;
  const lock = coerce(await kv.get(respKey(docId, signerId))) || {};
  if (lock.codeLockedUntil && lock.codeLockedUntil > Date.now()) {
    return json({ error: 'locked', until: lock.codeLockedUntil }, 429);
  }
  return json({ error: 'code_required' }, 401);
}

/* ---- Telling the owner ------------------------------------------------------ */

function notifKey(docId, kind, signerId) {
  return `${NOTIF_PREFIX}${docId}:${kind}:${signerId || '-'}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** What the owner is told, per event. Composed here; nothing is forwarded. */
function ownerMessage(record, kind, signerName) {
  const title = record.doc.title || 'Untitled document';
  const who = signerName || 'A signer';
  if (kind === 'complete') {
    return {
      subject: `Completed: "${title}" has been signed by everyone`,
      line: `Everyone has signed "${title}". The completed copy, with the signature certificate, is ready.`,
    };
  }
  if (kind === 'decline') {
    return {
      subject: `Declined: ${who} will not sign "${title}"`,
      line: `${who} declined to sign "${title}", which closes signing for everyone.`,
    };
  }
  return {
    subject: `Signed: ${who} signed "${title}"`,
    line: `${who} signed "${title}".`,
  };
}

/**
 * Mail the owner about their own document, from their own account.
 *
 * Every attempt is recorded once per (document, event, signer) — success or
 * failure — so a retry never double-sends, and so the app can see that the
 * platform refused own-account mail and send it from the app instead. A mail
 * failure must never fail the signer's request, so nothing here throws.
 */
async function notifyOwner(ctx, kv, record, docId, kind, signerName, signerId) {
  try {
    const notify = record.notify || {};
    if (!notify.email || notify[kind] !== true) return;
    const key = notifKey(docId, kind, signerId);
    if (coerce(await kv.get(key))) return;
    const { subject, line } = ownerMessage(record, kind, signerName);
    const link = kind === 'complete' && notify.docUrl ? notify.docUrl : '';
    const text = [line, '', link ? `Open the document: ${link}` : 'Open Signatures to see it.'].join('\n');
    const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#111827">`
      + `<p style="margin:0 0 14px">${escapeHtml(line)}</p>`
      + (link
        ? `<p style="margin:0"><a href="${escapeHtml(link)}" style="color:#4f46e5">Open the document</a></p>`
        : `<p style="margin:0;color:#6b7280">Open Signatures to see it.</p>`)
      + `</div>`;
    const record_ = { at: Date.now(), kind, signerId: signerId || '', ok: false, error: '' };
    try {
      const owner = ownerOf(ctx);
      const email = owner && owner.puter && owner.puter.email;
      if (!email || typeof email.send !== 'function') throw new Error('email_unavailable');
      await email.send({ to: notify.email, subject, text, html });
      record_.ok = true;
    } catch (err) {
      record_.error = String((err && err.message) || err || 'send_failed').slice(0, 200);
    }
    await kv.set(key, record_);
  } catch {
    /* the signer's answer is recorded either way; the app can still tell them */
  }
}

/* ---- Field/value validation -------------------------------------------------- */

function isDataImage(v) {
  return typeof v === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v)
    && v.length <= MAX_IMAGE_CHARS;
}

/**
 * Does this text fit the type the sender asked for? The app validates the
 * same rules as you type (isValidInput in src/lib/model.js); this is the copy
 * that a hand-rolled POST also has to satisfy. Kept in sync by hand: a worker
 * imports nothing.
 */
function validForType(inputType, text) {
  const value = String(text).trim();
  if (!value) return true;
  if (inputType === 'number') return /^-?(\d+\.?\d*|\.\d+)$/.test(value.replace(/[,\s]/g, ''));
  if (inputType === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
  if (inputType === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
  return true;
}

/** Validate one submitted value against its field; returns the clean value
 *  or undefined when the value is malformed. */
function cleanValue(field, value) {
  // Read-only means the sender owns this value: whatever a submission says,
  // the answer is the sender's own.
  if (field.readOnly) return field.preset === undefined ? undefined : field.preset;
  if (field.type === 'signature' || field.type === 'initials') {
    if (value && value.kind === 'image' && isDataImage(value.data)) {
      return { kind: 'image', data: value.data };
    }
    return undefined;
  }
  if (field.type === 'checkbox') return value === true ? true : value === false ? false : undefined;
  if (field.type === 'date') return typeof value === 'string' && value ? value.slice(0, 40) : undefined;
  if (typeof value !== 'string') return undefined;
  const text = value.slice(0, MAX_TEXT);
  return validForType(field.inputType, text) ? text : undefined;
}

function fieldComplete(field, value) {
  // Nothing is ever owed on a read-only field.
  if (field.readOnly) return true;
  if (field.type === 'checkbox') return !field.required || value === true;
  if (field.type === 'signature' || field.type === 'initials') return Boolean(value && value.kind === 'image');
  return Boolean(typeof value === 'string' ? value.trim() : value);
}

/* ---- Admin routes -------------------------------------------------------------- */

router.get('/health', async () => json({ ok: true, version: WORKER_VERSION }));

router.get('/admin/ping', async (ctx) => {
  if (!(await requireAdmin(ctx))) return json({ error: 'unauthorized' }, 401);
  return json({ ok: true, version: WORKER_VERSION });
});

/**
 * Push a document snapshot. Existing signers keep their token (their link
 * survives a re-sync); new signers and those in `reissue` get a fresh one.
 * Signers removed from the document lose token and response. Returns tokens
 * ONLY for links minted by this call.
 */
router.post('/admin/sync', async (ctx) => {
  if (!(await requireAdmin(ctx))) return json({ error: 'unauthorized' }, 401);
  const body = await readJson(ctx);
  const src = body && typeof body === 'object' ? body : {};
  const doc = src.doc && typeof src.doc === 'object' ? src.doc : {};
  if (typeof doc.id !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(doc.id)) {
    return json({ error: 'doc_id_required' }, 400);
  }
  const signersIn = Array.isArray(src.signers) ? src.signers.slice(0, MAX_SIGNERS) : [];
  const signOrder = src.signOrder === true;
  const channel = src.channel === 'email' || src.channel === 'link' ? src.channel : '';
  // Which events the owner wants mailed to them, and where. The address is
  // the owner's own: this worker will never mail anyone else.
  const notifyIn = src.notify && typeof src.notify === 'object' ? src.notify : {};
  const notify = {
    email: str(notifyIn.email, 254).toLowerCase(),
    sign: notifyIn.sign === true,
    decline: notifyIn.decline === true,
    complete: notifyIn.complete === true,
    docUrl: /^https:\/\/[^\s"'<>]{1,300}$/.test(String(notifyIn.docUrl || '')) ? String(notifyIn.docUrl) : '',
  };
  const fieldsIn = Array.isArray(src.fields) ? src.fields.slice(0, MAX_FIELDS) : [];
  const reissue = new Set(Array.isArray(src.reissue) ? src.reissue.map(String) : []);

  const kv = kvOf(ctx);
  const existing = coerce(await kv.get(DOC_PREFIX + doc.id));
  const prevSigners = (existing && existing.signers) || {};

  const signers = {};
  const links = {};
  for (const s of signersIn) {
    if (typeof s.id !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(s.id)) continue;
    const kind = s.kind === 'self' ? 'self' : 'external';
    const prev = prevSigners[s.id] || {};
    const entry = {
      name: str(s.name, 200),
      email: str(s.email, 254).toLowerCase(),
      kind,
      signed: s.signed === true,
      tokenHash: prev.tokenHash || null,
      // Access code: a string SETS it, null CLEARS it, absent keeps whatever
      // is already there (every re-sync would otherwise drop it).
      codeSalt: prev.codeSalt || null,
      codeHash: prev.codeHash || null,
    };
    if (typeof s.code === 'string' && normalizeCode(s.code).length >= 4) {
      entry.codeSalt = newToken();
      entry.codeHash = await codeHashOf(entry.codeSalt, s.code);
      // A new code invalidates the sessions the old one bought, and any lockout.
      await dropSessions(kv, doc.id, s.id);
      const stale = coerce(await kv.get(respKey(doc.id, s.id)));
      if (stale && (stale.codeFails || stale.codeLockedUntil)) {
        await kv.set(respKey(doc.id, s.id), { ...stale, codeFails: 0, codeLockedUntil: 0 });
      }
    } else if (s.code === null) {
      entry.codeSalt = null;
      entry.codeHash = null;
      await dropSessions(kv, doc.id, s.id);
    }
    if (kind === 'external' && (!entry.tokenHash || reissue.has(s.id))) {
      const token = newToken();
      const hash = await sha256Hex(token);
      if (entry.tokenHash) await kv.del(TOK_PREFIX + entry.tokenHash).catch(() => {});
      await kv.set(TOK_PREFIX + hash, { docId: doc.id, signerId: s.id });
      entry.tokenHash = hash;
      links[s.id] = token;
      if (reissue.has(s.id)) {
        // A reissue exists to take the document away from whoever held the old
        // link; their unlocked session must not outlive it.
        await dropSessions(kv, doc.id, s.id);
        // Nor may what that holder DID carry over to the new one. The consent
        // matters most: the signing page skips the disclosure entirely once a
        // consent is on record, so a leftover one let the new holder sign
        // without ever agreeing, under a timestamp, IP, and browser that were
        // someone else's - and the certificate printed it as theirs.
        // An answer that is already final is evidence, and is never deleted.
        const held = coerce(await kv.get(respKey(doc.id, s.id)));
        if (held && held.status !== 'signed' && held.status !== 'declined') {
          await kv.del(respKey(doc.id, s.id)).catch(() => {});
        }
      }
    }
    signers[s.id] = entry;
  }

  // Signers no longer on the document: revoke their token and answer.
  for (const [signerId, prev] of Object.entries(prevSigners)) {
    if (signers[signerId]) continue;
    if (prev.tokenHash) await kv.del(TOK_PREFIX + prev.tokenHash).catch(() => {});
    await kv.del(respKey(doc.id, signerId)).catch(() => {});
  }

  const fields = [];
  for (const f of fieldsIn) {
    if (typeof f.id !== 'string' || !signers[String(f.signerId)]) continue;
    fields.push({
      id: str(f.id, 200),
      signerId: String(f.signerId),
      type: ['signature', 'initials', 'date', 'text', 'checkbox'].includes(f.type) ? f.type : 'text',
      page: Number.isInteger(f.page) && f.page >= 0 ? f.page : 0,
      x: Number(f.x) || 0,
      y: Number(f.y) || 0,
      w: Number(f.w) || 0.1,
      h: Number(f.h) || 0.04,
      required: f.required !== false,
      label: str(f.label, 100),
      help: str(f.help, 200),
      readOnly: f.readOnly === true,
      inputType: ['text', 'number', 'email', 'date'].includes(f.inputType) ? f.inputType : 'text',
      // The value the sender filled in. Text keeps its string; a checkbox is
      // a boolean; anything else has no sender-filled form.
      preset: typeof f.preset === 'string' ? f.preset.slice(0, MAX_TEXT)
        : f.preset === true ? true : f.preset === false ? false : undefined,
    });
  }

  // Values the app pushed for self signers (the owner's own signatures), so
  // external signers see them on the document.
  const values = {};
  if (src.values && typeof src.values === 'object') {
    for (const field of fields) {
      const clean = cleanValue(field, src.values[field.id]);
      if (clean !== undefined) values[field.id] = clean;
    }
  }

  // The order the app sent, filtered to signers this record actually has.
  const order = (Array.isArray(src.order) ? src.order.map(String) : signersIn.map((sx) => String(sx.id)))
    .filter((id) => signers[id]);

  await kv.set(DOC_PREFIX + doc.id, {
    doc: {
      id: doc.id,
      title: str(doc.title, 300) || 'Untitled document',
      note: str(doc.note, 2000),
      ownerName: str(doc.ownerName, 200),
      ownerEmail: str(doc.ownerEmail, 254).toLowerCase(),
      pageCount: Number.isInteger(doc.pageCount) && doc.pageCount > 0 ? doc.pageCount : 1,
      pdfPath: str(doc.pdfPath, 1000),
    },
    // A deadline the worker enforces itself, so it holds with the app closed.
    // Extending is the same field moving forward.
    expiresAt: Number.isFinite(src.expiresAt) && src.expiresAt > 0 ? Math.round(src.expiresAt) : 0,
    signers,
    fields,
    values,
    signOrder,
    order,
    channel,
    notify,
    voided: existing ? Boolean(existing.voided) : false,
    updatedAt: Date.now(),
  });

  return json({ ok: true, version: WORKER_VERSION, links });
});

/**
 * Everything signers have done, for the app to merge. Submitted values ride
 * along until the app acknowledges them; after that only statuses repeat.
 *
 * `?docs=a,b,c` names the documents the app still has out for signature, and
 * only those are walked: every other document here is finished (completed,
 * declined, voided, expired) and nothing can arrive on it. Without the
 * filter each pull - one a minute while anything is out - read every
 * document ever synced and every response and notification under each,
 * growing with the owner's whole history rather than with their open work.
 * No parameter still means everything, for an app that does not send one.
 */
router.get('/admin/responses', async (ctx) => {
  if (!(await requireAdmin(ctx))) return json({ error: 'unauthorized' }, 401);
  const kv = kvOf(ctx);
  const wanted = new URL(ctx.request.url).searchParams.get('docs');
  const only = wanted === null ? null : new Set(wanted.split(',').filter(Boolean));
  const keys = ((await kv.list(`${DOC_PREFIX}*`)) || [])
    .filter((key) => !only || only.has(key.slice(DOC_PREFIX.length)));
  const docs = {};
  const notified = {};
  for (const key of keys) {
    const record = coerce(await kv.get(key));
    if (!record || !record.doc) continue;
    const docId = record.doc.id;
    const resps = await loadResponses(kv, docId, Object.keys(record.signers || {}));
    const out = {};
    for (const [signerId, resp] of Object.entries(resps)) {
      out[signerId] = {
        status: resp.status,
        viewedAt: resp.viewedAt || null,
        signedAt: resp.signedAt || null,
        declinedAt: resp.declinedAt || null,
        declineReason: resp.declineReason || '',
        consentAt: resp.consentAt || null,
        consentVersion: resp.consentVersion || '',
        // What happened at the access-code gate, for the owner's audit trail.
        code: {
          fails: resp.codeFails || 0,
          lastFailAt: resp.codeLastFailAt || 0,
          lockedUntil: resp.codeLockedUntil || 0,
          unlockedAt: resp.codeUnlockedAt || 0,
          unlockCount: resp.codeUnlockCount || 0,
        },
        // What the certificate prints: the context of each act.
        evidence: {
          view: resp.view || null,
          consent: resp.consent || null,
          sign: resp.sign || null,
          decline: resp.decline || null,
        },
        values: resp.acked ? undefined : resp.values,
      };
    }
    docs[docId] = out;
    // What the owner has already been told, so the app neither repeats it nor
    // leaves them uninformed when this worker could not send.
    const notifKeys = (await kv.list(`${NOTIF_PREFIX}${docId}:*`)) || [];
    const told = {};
    for (const key of notifKeys) {
      const value = coerce(await kv.get(key));
      if (value) told[key.slice(NOTIF_PREFIX.length + docId.length + 1)] = value;
    }
    if (Object.keys(told).length) notified[docId] = told;
  }
  return json({ ok: true, version: WORKER_VERSION, docs, notified });
});

/** The app merged these signers' values; stop re-sending them on every pull.
 *  Values stay stored: the signing page shows co-signers' signatures and
 *  builds the completed copy from them. */
router.post('/admin/ack', async (ctx) => {
  if (!(await requireAdmin(ctx))) return json({ error: 'unauthorized' }, 401);
  const body = await readJson(ctx);
  const docId = body && typeof body.docId === 'string' ? body.docId : '';
  const signerIds = Array.isArray(body && body.signerIds) ? body.signerIds.map(String) : [];
  if (!docId || !signerIds.length) return json({ error: 'bad_request' }, 400);
  const kv = kvOf(ctx);
  for (const signerId of signerIds) {
    const key = respKey(docId, signerId);
    const resp = coerce(await kv.get(key));
    if (resp && !resp.acked) {
      resp.acked = true;
      await kv.set(key, resp);
    }
  }
  return json({ ok: true });
});

/** Void: links stop working but records stay for the audit trail. */
router.post('/admin/void', async (ctx) => {
  if (!(await requireAdmin(ctx))) return json({ error: 'unauthorized' }, 401);
  const body = await readJson(ctx);
  const docId = body && typeof body.docId === 'string' ? body.docId : '';
  if (!docId) return json({ error: 'bad_request' }, 400);
  const kv = kvOf(ctx);
  const record = coerce(await kv.get(DOC_PREFIX + docId));
  if (record) {
    record.voided = true;
    await kv.set(DOC_PREFIX + docId, record);
  }
  return json({ ok: true });
});

/** Revoke: the document is deleted from the worker entirely. */
router.post('/admin/revoke', async (ctx) => {
  if (!(await requireAdmin(ctx))) return json({ error: 'unauthorized' }, 401);
  const body = await readJson(ctx);
  const docId = body && typeof body.docId === 'string' ? body.docId : '';
  if (!docId) return json({ error: 'bad_request' }, 400);
  const kv = kvOf(ctx);
  const record = coerce(await kv.get(DOC_PREFIX + docId));
  if (record) {
    for (const [signerId, signer] of Object.entries(record.signers || {})) {
      if (signer.tokenHash) await kv.del(TOK_PREFIX + signer.tokenHash).catch(() => {});
      await kv.del(respKey(docId, signerId)).catch(() => {});
    }
    for (const key of (await kv.list(`${NOTIF_PREFIX}${docId}:*`)) || []) {
      await kv.del(key).catch(() => {});
    }
    // Sessions are keyed by their own hash, so they have to be found by
    // value; dead ones met on the way go too.
    for (const key of (await kv.list(`${SESS_PREFIX}*`)) || []) {
      const session = coerce(await kv.get(key));
      if (sessionDead(session) || session.docId === docId) await kv.del(key).catch(() => {});
    }
    await kv.del(DOC_PREFIX + docId);
  }
  return json({ ok: true });
});

/* ---- Signer routes ---------------------------------------------------------------- */

/** Send the visitor to the app-hosted signing page. */
router.get('/sign/:token', async (ctx) => {
  const page = /^https?:\/\//i.test(PAGE_URL) ? PAGE_URL : 'https://sign.puter.com/sign.html';
  const params = new URLSearchParams({
    w: new URL(ctx.request.url).origin,
    t: String(ctx.params.token || ''),
  });
  return new Response(null, {
    status: 303,
    headers: {
      location: `${page}#${params.toString()}`,
      'cache-control': 'no-store',
    },
  });
});

/** The signer's view of the document. Marks first contact as "viewed". */
router.get('/api/sign/:token', async (ctx) => {
  const hit = await loadByToken(ctx, ctx.params.token);
  if (!hit) return json({ error: 'not_found' }, 404);
  const { kv, docId, signerId, record } = hit;
  const resps = await loadResponses(kv, docId, Object.keys(record.signers));
  const state = docState(record, resps);
  const closed = closedResponse(record, state);
  if (closed) return closed;

  const locked = await codeGate(ctx, kv, docId, signerId, record.signers[signerId]);
  if (locked) return locked;

  // Their turn has not come: nothing about the document is served, and the
  // visit is NOT recorded as a view (they have not seen it).
  const turn = turnState(record, resps, signerId);
  if (!turn.ok) return notYet(turn, state, record);

  let mine = resps[signerId];
  // A record can already exist without a status: failed code attempts write
  // their counter before this signer has ever seen the document.
  if (!mine || !mine.status) {
    // First contact: the view itself is evidence, so it is captured with the
    // same shape as the consent and the signature.
    const seen = evidence(ctx, null);
    mine = {
      ...(mine || {}),
      status: 'viewed',
      viewedAt: (mine && mine.viewedAt) || seen.at,
      view: (mine && mine.view) || seen,
    };
    await kv.set(respKey(docId, signerId), mine);
    resps[signerId] = mine;
  }

  const fields = record.fields.map((f) => {
    const owner = record.signers[f.signerId];
    const respValue = resps[f.signerId] && resps[f.signerId].values
      ? resps[f.signerId].values[f.id]
      : undefined;
    const snapValue = record.values ? record.values[f.id] : undefined;
    const value = respValue !== undefined ? respValue : snapValue;
    // Nobody has answered yet, so what the sender filled in stands.
    const shown = value !== undefined && value !== null ? value : f.preset;
    return {
      id: f.id,
      type: f.type,
      page: f.page,
      x: f.x, y: f.y, w: f.w, h: f.h,
      required: f.required,
      label: f.label,
      help: f.help,
      readOnly: f.readOnly === true,
      inputType: f.inputType,
      mine: f.signerId === signerId,
      signerName: (owner && owner.name) || '',
      value: shown,
    };
  });

  const signer = record.signers[signerId];
  return json({
    ok: true,
    version: WORKER_VERSION,
    state,
    // How the sender hands things out, so the page can say what happens once
    // everyone has signed: a completed copy by email, or this link.
    channel: record.channel || '',
    doc: {
      title: record.doc.title,
      note: record.doc.note,
      ownerName: record.doc.ownerName,
      pageCount: record.doc.pageCount,
    },
    signer: {
      name: signer.name,
      email: signer.email,
      status: mine.status || 'viewed',
      declineReason: mine.declineReason || '',
      consentAt: mine.consentAt || null,
      consentVersion: mine.consentVersion || '',
      codeRequired: Boolean(record.signers[signerId].codeHash),
    },
    fields,
  });
});

/** The original PDF, streamed from the owner's own cloud storage. */
router.get('/api/sign/:token/pdf', async (ctx) => {
  const hit = await loadByToken(ctx, ctx.params.token);
  if (!hit) return json({ error: 'not_found' }, 404);
  const pdfResps = await loadResponses(hit.kv, hit.docId, Object.keys(hit.record.signers));
  const pdfState = docState(hit.record, pdfResps);
  const pdfClosed = closedResponse(hit.record, pdfState);
  if (pdfClosed) return pdfClosed;
  const pdfLocked = await codeGate(ctx, hit.kv, hit.docId, hit.signerId, hit.record.signers[hit.signerId]);
  if (pdfLocked) return pdfLocked;
  const pdfTurn = turnState(hit.record, pdfResps, hit.signerId);
  if (!pdfTurn.ok) return notYet(pdfTurn, pdfState, hit.record);
  const path = hit.record.doc.pdfPath;
  if (!path) return json({ error: 'file_unavailable' }, 404);
  try {
    const blob = await ownerOf(ctx).puter.fs.read(path);
    const bytes = blob && typeof blob.arrayBuffer === 'function' ? await blob.arrayBuffer() : blob;
    return new Response(bytes, {
      headers: {
        'content-type': 'application/pdf',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch {
    return json({ error: 'file_unavailable' }, 404);
  }
});

/** Sign or decline. */
router.post('/api/sign/:token', async (ctx) => {
  const hit = await loadByToken(ctx, ctx.params.token);
  if (!hit) return json({ error: 'not_found' }, 404);
  const { kv, docId, signerId, record } = hit;
  const resps = await loadResponses(kv, docId, Object.keys(record.signers));
  const postClosed = closedResponse(record, docState(record, resps));
  if (postClosed) return postClosed;

  const signerEntry = record.signers[signerId];
  const existing = resps[signerId] || {};
  const attempt = await readJson(ctx);

  /**
   * Trade the access code for a short-lived session. Rate-limited and locked
   * out after MAX_CODE_FAILS, and every failure is written where the owner
   * can see it. Answered before the already-signed checks below: a locked-out
   * guesser must learn nothing about the document, not even its state.
   */
  if (attempt && attempt.action === 'unlock') {
    if (!signerEntry.codeHash) return json({ error: 'no_code_needed' }, 400);
    const now = Date.now();
    if (existing.codeLockedUntil && existing.codeLockedUntil > now) {
      return json({ error: 'locked', until: existing.codeLockedUntil }, 429);
    }
    const given = normalizeCode(attempt.code);
    const ok = given.length >= 4
      && (await codeHashOf(signerEntry.codeSalt, given)) === signerEntry.codeHash;
    if (!ok) {
      // A lock that has run its course took the earlier failures with it:
      // five guesses, then a wait, then five more. Carrying the count over
      // made every wrong guess after the first wait a fresh fifteen minutes,
      // which is a signer who fumbled the code once being told "too many
      // attempts" on their next try, for as long as they keep trying.
      const lapsed = existing.codeLockedUntil && existing.codeLockedUntil <= now;
      const fails = (lapsed ? 0 : existing.codeFails || 0) + 1;
      const lockedUntil = fails >= MAX_CODE_FAILS ? now + CODE_LOCK_MS : 0;
      await kv.set(respKey(docId, signerId), {
        ...existing,
        codeFails: fails,
        codeLastFailAt: now,
        codeLockedUntil: lockedUntil,
      });
      if (lockedUntil) return json({ error: 'locked', until: lockedUntil }, 429);
      return json({ error: 'bad_code', remaining: MAX_CODE_FAILS - fails }, 401);
    }
    const session = newToken();
    const exp = now + SESSION_TTL_MS;
    const sessKey = SESS_PREFIX + (await sha256Hex(session));
    await kv.set(sessKey, { docId, signerId, exp });
    await expireKey(kv, sessKey, Math.ceil(SESSION_TTL_MS / 1000));
    await kv.set(respKey(docId, signerId), {
      ...existing,
      codeFails: 0,
      codeLockedUntil: 0,
      codeUnlockedAt: existing.codeUnlockedAt || now,
      codeUnlockCount: (existing.codeUnlockCount || 0) + 1,
    });
    return json({ ok: true, session, expiresAt: exp });
  }

  const gated = await codeGate(ctx, kv, docId, signerId, signerEntry);
  if (gated) return gated;

  if (existing.status === 'signed') return json({ error: 'already_signed' }, 409);
  if (existing.status === 'declined') return json({ error: 'already_declined' }, 409);

  const state = docState(record, resps);
  if (state === 'declined') return json({ error: 'declined' }, 410);
  // Defence in depth: the page hides the document, and the worker refuses the
  // submission too.
  const turn = turnState(record, resps, signerId);
  if (!turn.ok) return notYet(turn, state, record);

  const body = attempt;
  const action = body && body.action;

  /**
   * Agreeing to sign electronically. Recorded before any field is filled in,
   * with the version of the disclosure the page actually showed, so the
   * certificate can state what was agreed to and when.
   */
  if (action === 'consent') {
    const seen = evidence(ctx, body);
    const resp = {
      ...existing,
      status: existing.status || 'viewed',
      viewedAt: existing.viewedAt || seen.at,
      // The first agreement is the one that counts; reopening the page must
      // not restamp it.
      consentAt: existing.consentAt || seen.at,
      consentVersion: existing.consentVersion || str(body.disclosureVersion, 20) || '1',
      consent: existing.consent || seen,
    };
    await kv.set(respKey(docId, signerId), resp);
    return json({ ok: true, consentAt: resp.consentAt, consentVersion: resp.consentVersion });
  }

  if (action === 'decline') {
    const seen = evidence(ctx, body);
    const resp = {
      ...existing,
      status: 'declined',
      declinedAt: seen.at,
      declineReason: str(body.reason, MAX_REASON),
      decline: seen,
    };
    await kv.set(respKey(docId, signerId), resp);
    await notifyOwner(ctx, kv, record, docId, 'decline', record.signers[signerId].name, signerId);
    return json({ ok: true, status: 'declined' });
  }

  if (action !== 'sign') return json({ error: 'bad_action' }, 400);

  // No agreement, no signature: a signature whose consent was never recorded
  // is exactly the one that cannot be defended later.
  if (!existing.consentAt) return json({ error: 'consent_required' }, 409);

  const myFields = record.fields.filter((f) => f.signerId === signerId);
  const submitted = body && body.values && typeof body.values === 'object' ? body.values : {};
  if (JSON.stringify(submitted).length > MAX_VALUES_CHARS) {
    return json({ error: 'too_large' }, 413);
  }
  const values = {};
  for (const field of myFields) {
    const clean = cleanValue(field, submitted[field.id]);
    if (clean !== undefined) values[field.id] = clean;
  }
  const missing = myFields.filter((f) => f.required && !fieldComplete(f, values[f.id]));
  if (missing.length) {
    return json({ error: 'missing_required', fields: missing.map((f) => f.id) }, 400);
  }

  const seen = evidence(ctx, body);
  const resp = {
    ...existing,
    status: 'signed',
    signedAt: seen.at,
    sign: seen,
    values,
    acked: false,
  };
  await kv.set(respKey(docId, signerId), resp);
  const after = docState(record, { ...resps, [signerId]: resp });
  const signerName = record.signers[signerId].name;
  // A completion is the event the owner asked about; the individual signature
  // is only mailed when they asked for those too.
  await notifyOwner(ctx, kv, record, docId, 'sign', signerName, signerId);
  if (after === 'completed') await notifyOwner(ctx, kv, record, docId, 'complete', signerName, '');
  return json({ ok: true, status: 'signed', state: after });
});
