/**
 * Teamchat's one shared, app-owned email worker (see src/lib/email.js for the
 * calling side).
 *
 * Unlike the workspace worker — one per workspace owner, deployed into their
 * own account — this one is deployed ONCE, by the app's developer account:
 * outbound mail has to be authorized by a worker's own token, and that
 * capability must not be minted per user, so it lives somewhere the app
 * controls. The cost does not: the app calls this worker with
 * puter.workers.exec(), which forwards the signed-in user's Puter token, and
 * each message is sent with that token in hand — so every send is billed to,
 * and rate-limited as, the person who asked for it, never the app owner.
 *
 *   POST /invites  email an invitation: a workspace invite, a guest invite to
 *                  one channel, or a channel share for another workspace's
 *                  admin. One private mail per recipient.
 *   GET  /health   liveness + deployed version (no auth)
 *   GET  /whoami   what the worker can see of your session (names only) —
 *                  the deployment self-test for "why am I getting a 401"
 *
 * An app-owned relay that forwarded whatever it was handed would be a spam
 * cannon wearing Teamchat's sending reputation, so it never does:
 *   - no Puter session, no send. `user` is only populated for callers that
 *     come through puter.workers.exec(); everyone else gets 401.
 *   - the caller supplies the PARTS of an invitation (server, code, names, a
 *     note), never a message. Subject, body, and above all the link are
 *     composed here: the one URL a mail carries is `app`/#/join/... or
 *     /#/connect/..., where `app` must pass appOrigin() below — puter.com,
 *     *.puter.site/work/com, or localhost — so the worker cannot be pointed
 *     at a look-alike site. Names and the note are HTML-escaped.
 *   - recipients are capped per request (MAX_RECIPIENTS) and per user per
 *     day (DAILY_LIMIT).
 *
 * KV here belongs to the APP OWNER, so it holds nothing personal: the only
 * keys are daily send counters under a SHA-256 hash of the caller's id.
 *
 *   tcmail:rate:<sha256(callerId)>:<YYYY-MM-DD> -> count  (expires: RATE_TTL)
 *
 * Deploy with:  puter worker deploy worker/email.js teamchat-email
 */

// '2': redeployed to pick up the current worker runtime (puter.js with
//      email.sendTransactional); /health and /whoami now report it as runtime.
const WORKER_VERSION = '2';

const RATE_PREFIX = 'tcmail:rate:';
const RATE_TTL = 2 * 24 * 60 * 60; // seconds — yesterday's counter is dead weight

const MAX_RECIPIENTS = 10; // per request
const DAILY_LIMIT = 100; // per user per UTC day

/** Where the app lives when the caller does not say (or says somewhere untrusted). */
const DEFAULT_APP = 'https://teamchat.puter.com';

/* ---- Small utilities ------------------------------------------------------ */

/** The worker owner's context (the `me` global). */
function ownerOf(ctx) {
  return (ctx && ctx.me) || (typeof me !== 'undefined' ? me : null);
}

/** The puter.js build the platform baked into this deploy (its preamble's
 *  first line). Null under the test harness, which has no preamble. */
function workerRuntime() {
  return typeof __PUTER_PREAMBLE_VERSION__ === 'string' ? __PUTER_PREAMBLE_VERSION__ : null;
}

/** The signed-in caller. The runtime has called this both `user` and `requestor`. */
function callerOf(ctx) {
  return (ctx && (ctx.user || ctx.requestor)) || null;
}

/**
 * A stable id for the caller — it keys the daily-cap records. The live
 * platform hands over a caller whose only own property may be `puter`, so
 * try the documented names first, then the nested ones, then getUser().
 * '' means "could not tell", which is refused rather than guessed at.
 */
async function callerIdOf(caller) {
  if (!caller) return '';
  const own = caller.uuid || caller.uid || caller.user_uuid || caller.username;
  if (typeof own === 'string' && own) return own;
  const p = caller.puter;
  const nested = p && (p.uuid || p.uid || p.username);
  if (typeof nested === 'string' && nested) return nested;
  try {
    const who = p && p.auth && typeof p.auth.getUser === 'function' ? await p.auth.getUser() : null;
    const id = who && (who.uuid || who.uid || who.username);
    return typeof id === 'string' ? id : '';
  } catch {
    return '';
  }
}

function kvOf(ctx) {
  const owner = ownerOf(ctx);
  return owner && owner.puter && owner.puter.kv;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(String(text));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function lowerEmail(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  // No control character reaches a `to:` header, the C1 block (U+0080-U+009F) included.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(s)) return '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254 ? s : '';
}

/** One line of caller text: control characters out (a newline in a subject is
 *  how header injection starts) - the C1 block (U+0080-U+009F) too, a raw
 *  U+0085 being a line break to some parsers that JS \s misses - clamped. '' when nothing usable is left. */
function line(v, max) {
  if (typeof v !== 'string') return '';
  return whole(v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max));
}

/** The note keeps its paragraph breaks; every other control character goes. */
function block(v, max) {
  if (typeof v !== 'string') return '';
  return whole(v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, max));
}

/**
 * A clamp counts UTF-16 units, and a character written as two of them (an
 * emoji) can straddle the cut: the half left behind goes with the half
 * taken, as the app's own clamps have it. Kept, it was no character at all,
 * in a subject line and a body no encoder and no mail client agree on.
 */
function whole(s) {
  return /[\uD800-\uDBFF]$/.test(s) ? s.slice(0, -1).trimEnd() : s;
}

function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * The origin (plus optional path) the join link points at. Only places the
 * app actually lives are accepted — puter.com, a *.puter.site/work/com
 * subdomain, or localhost for development — anything else falls back to the
 * canonical app URL, so this worker cannot be made to mail out links to a
 * look-alike host.
 */
function appOrigin(v) {
  try {
    const u = new URL(String(v || ''));
    const host = u.hostname.toLowerCase();
    const local = host === 'localhost' || host === '127.0.0.1';
    const ok = (u.protocol === 'https:' && (
      host === 'puter.com'
      || host.endsWith('.puter.site') || host.endsWith('.puter.work') || host.endsWith('.puter.com')
    )) || (u.protocol === 'http:' && local);
    if (!ok) return DEFAULT_APP;
    if (!/^[A-Za-z0-9._~/-]*$/.test(u.pathname)) return DEFAULT_APP;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return DEFAULT_APP;
  }
}

/* ---- What an invitation is ------------------------------------------------ */

const KINDS = {
  workspace: {
    subject: (r) => `${r.inviter} invited you to ${r.workspace} on Teamchat`,
    heading: (r) => `${r.inviter} invited you to join ${r.workspace}`,
    lead: (r) => `Teamchat is where ${r.workspace} talks: channels, threads, and direct messages. Use the button below to join.`,
    button: 'Join the workspace',
    hash: (r) => `#/join/${r.server}/${r.code}`,
  },
  guest: {
    subject: (r) => `${r.inviter} invited you to #${r.channel} in ${r.workspace}`,
    heading: (r) => `${r.inviter} invited you to #${r.channel}`,
    lead: (r) => `You are invited as a guest of ${r.workspace} on Teamchat: you will see the #${r.channel} channel and the people in it, nothing else.`,
    button: 'Join the channel',
    hash: (r) => `#/join/${r.server}/${r.code}`,
  },
  connect: {
    subject: (r) => `${r.inviter} wants to share the #${r.channel} channel with your workspace`,
    heading: (r) => `${r.workspace} is sharing #${r.channel} with you`,
    lead: (r) => `${r.inviter} from ${r.workspace} uses Teamchat and is sharing the #${r.channel} channel with your organization. If you administer a Teamchat workspace, open the link and pick which of your workspaces to add it to; your members can then join it and post.`,
    button: 'Open the shared channel',
    hash: (r) => `#/connect/${r.server}/${r.code}`,
  },
};

/**
 * Validate one request into the parts every mail is composed from. Returns
 * { error, reason } or the request. The names travel into subjects, so they
 * are single lines, clamped to the app's own limits.
 */
function readRequest(body) {
  if (!body || typeof body !== 'object') return { error: 'invalid', reason: 'body' };
  // Own entries only: 'constructor', '__proto__' and 'toString' are truthy on
  // any object but are not kinds, and one reaching KINDS[req.kind].subject()
  // below would throw an unhandled 500 after the daily budget was reserved.
  const kind = Object.hasOwn(KINDS, body.kind) ? body.kind : '';
  if (!kind) return { error: 'invalid', reason: 'kind' };
  const server = typeof body.server === 'string' && /^[a-z0-9][a-z0-9.-]{0,90}$/.test(body.server.toLowerCase())
    ? body.server.toLowerCase() : '';
  if (!server) return { error: 'invalid', reason: 'server' };
  const code = typeof body.code === 'string' && /^[a-z0-9][a-z0-9-]{2,40}$/i.test(body.code) ? body.code.toUpperCase() : '';
  if (!code) return { error: 'invalid', reason: 'code' };
  const workspace = line(body.workspace, 60);
  const inviter = line(body.inviter, 60);
  if (!workspace || !inviter) return { error: 'invalid', reason: 'names' };
  const channel = line(body.channel, 40);
  if ((kind === 'guest' || kind === 'connect') && !channel) return { error: 'invalid', reason: 'channel' };
  const raw = Array.isArray(body.emails) ? body.emails : [];
  if (raw.length > MAX_RECIPIENTS) return { error: 'too_many_recipients', reason: String(MAX_RECIPIENTS) };
  const emails = [...new Set(raw.map(lowerEmail))].filter(Boolean);
  if (!emails.length) return { error: 'invalid', reason: 'emails' };
  const exp = Number.isFinite(body.exp) && body.exp > Date.now() && body.exp < Date.now() + 366 * 86400000
    ? Math.floor(body.exp) : 0;
  return {
    kind, server, code, workspace, inviter, channel, emails, exp,
    note: block(body.note, 400),
    app: appOrigin(body.app),
  };
}

/* ---- Composition ----------------------------------------------------------- */

function expiryLine(req) {
  if (!req.exp) return '';
  const date = new Date(req.exp).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return `This invitation works until ${date}.`;
}

function linkFor(req) {
  return `${req.app}${KINDS[req.kind].hash(req)}`;
}

function textBody(req) {
  const k = KINDS[req.kind];
  const expiry = expiryLine(req);
  // '' is a blank line to keep; an absent piece drops out through the spread,
  // so the two never collide (an earlier filter that removed every '' ran the
  // heading, lead, link and closing together as one wall of text).
  return [
    k.heading(req),
    '',
    k.lead(req),
    ...(req.note ? ['', `${req.inviter} added a note:`, req.note] : []),
    '',
    `${k.button}: ${linkFor(req)}`,
    ...(expiry ? [expiry] : []),
    '',
    'If you were not expecting this, you can ignore this email.',
  ].join('\n');
}

function htmlBody(req) {
  const k = KINDS[req.kind];
  const link = linkFor(req);
  const expiry = expiryLine(req);
  return (
    `<div style="background:#f4f4f7;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">` +
    `<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px 28px;border:1px solid #e5e7eb">` +
    `<p style="margin:0 0 4px;font-size:13px;font-weight:700;letter-spacing:.04em;color:#6d28d9">TEAMCHAT</p>` +
    `<h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;color:#111827">${escapeHtml(k.heading(req))}</h1>` +
    `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#374151">${escapeHtml(k.lead(req))}</p>` +
    (req.note
      ? `<div style="margin:0 0 16px;padding:12px 14px;background:#f9fafb;border-radius:8px;border:1px solid #e5e7eb">` +
        `<p style="margin:0 0 4px;font-size:12px;color:#6b7280">${escapeHtml(req.inviter)} added a note</p>` +
        `<p style="margin:0;font-size:14px;line-height:1.6;color:#111827;white-space:pre-wrap">${escapeHtml(req.note)}</p></div>`
      : '') +
    `<div style="margin:20px 0"><a href="${escapeHtml(link)}" ` +
    `style="display:inline-block;background:#6d28d9;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 22px;border-radius:8px">${escapeHtml(k.button)}</a></div>` +
    `<p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:#6b7280">Or paste this link into your browser:<br>` +
    `<a href="${escapeHtml(link)}" style="color:#6d28d9;word-break:break-all">${escapeHtml(link)}</a></p>` +
    (expiry ? `<p style="margin:10px 0 0;font-size:12px;color:#6b7280">${escapeHtml(expiry)}</p>` : '') +
    `<p style="margin:18px 0 0;font-size:12px;color:#9ca3af">If you were not expecting this, you can ignore this email.</p>` +
    `</div></div>`
  );
}

/* ---- Sending --------------------------------------------------------------- */

/**
 * A send has two halves — who pays (the caller) and what authorizes it (this
 * worker) — and the platform accepts them in either arrangement:
 *
 *   me.puter.email.sendTransactional({ …, requesterToken: user.puter.authToken })
 *   user.puter.email.sendTransactional({ …, emailAccessToken: me.puter.authToken })
 *
 * Both bill the caller; which name a given runtime knows has moved, and a
 * worker that only spoke one of them would silently stop sending. So try the
 * first, fall back to the second, and remember which one answered. The
 * fallback is gated on the error looking like a rejected REQUEST (bad
 * parameter, bad token) rather than a rejected DELIVERY — retrying a message
 * the transport already accepted would double-send it.
 */
let preferredForm = 0;

/** Prefer the current SDK method; older worker runtimes still expose `send`. */
function mailerOf(puter) {
  const email = puter && puter.email;
  if (email && typeof email.sendTransactional === 'function') {
    return (message) => email.sendTransactional(message);
  }
  // A missing method is a request failure, allowing the other token form.
  return (message) => email.send(message);
}

function hasMailer(puter) {
  const email = puter && puter.email;
  return Boolean(email && (typeof email.sendTransactional === 'function' || typeof email.send === 'function'));
}

const DELIVERY_ERROR = /deliver|recipient|suppress|unsubscrib|mailbox|smtp|bounce|spam|quota|rate|limit/i;
const REQUEST_ERROR = /token|auth|unauthor|forbidden|permission|denied|unknown|unrecognized|unsupported|invalid|missing|required|not a function|undefined/i;

function sendForms(ctx) {
  const owner = ownerOf(ctx);
  const caller = callerOf(ctx);
  return [
    (message) => mailerOf(owner.puter)({ ...message, requesterToken: caller.puter && caller.puter.authToken }),
    (message) => mailerOf(caller.puter)({ ...message, emailAccessToken: owner.puter && owner.puter.authToken }),
  ];
}

async function sendMail(ctx, message) {
  const forms = sendForms(ctx);
  const order = preferredForm === 0 ? [0, 1] : [1, 0];
  let lastErr = null;
  for (const index of order) {
    try {
      const result = await forms[index](message);
      preferredForm = index;
      return result || {};
    } catch (err) {
      lastErr = err;
      const reason = String((err && err.message) || err || '');
      // Anything the transport said about THIS message is final.
      if (DELIVERY_ERROR.test(reason) || !REQUEST_ERROR.test(reason)) throw err;
    }
  }
  throw lastErr;
}

/* ---- Daily cap -------------------------------------------------------------- */

async function quotaKey(callerId) {
  return `${RATE_PREFIX}${await sha256Hex(callerId)}:${new Date().toISOString().slice(0, 10)}`;
}

function coerce(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value;
}

async function quotaUsed(kv, key) {
  const value = coerce(await kv.get(key));
  const used = typeof value === 'number' ? value : parseInt(value, 10);
  return Number.isFinite(used) && used > 0 ? used : 0;
}

/** Grant up to `n` sends from today's budget, reserving them upfront. */
async function reserveQuota(kv, key, n) {
  try {
    if (typeof kv.incr === 'function') {
      // Reserve atomically, THEN measure how much landed under the cap. Two
      // requests in flight each get their own running total, so the cap holds
      // under concurrency — a read-then-write let both read the same low count
      // and each send its whole batch, so one account could get 10×concurrency
      // mails past a 100/day limit.
      const after = Number(await kv.incr(key, n));
      if (typeof kv.expire === 'function') await kv.expire(key, RATE_TTL).catch(() => {});
      // A counter that answers with no number (a store handing back nothing,
      // or the document) is a cap that cannot be read, and reads as not
      // reached: measured all the same, the difference was NaN, no send was
      // granted, and every invitation was refused as over the day's limit.
      if (!Number.isFinite(after)) return n;
      const over = after - DAILY_LIMIT;
      return over <= 0 ? n : Math.max(0, n - over);
    }
    // No atomic counter: best-effort read-modify-write.
    const used = await quotaUsed(kv, key);
    const granted = Math.max(0, Math.min(n, DAILY_LIMIT - used));
    if (granted) {
      await kv.set(key, used + granted);
      if (typeof kv.expire === 'function') await kv.expire(key, RATE_TTL).catch(() => {});
    }
    return granted;
  } catch {
    // The cap is a guard rail, not a ledger — never fail a send over it.
    return n;
  }
}

/* ---- Routes ------------------------------------------------------------------ */

router.get('/health', async () => json({ ok: true, version: WORKER_VERSION, runtime: workerRuntime() }));

/** Deployment self-test: what this worker can see of the caller — NAMES and
 *  presence only, never a value, a token, or an address. */
router.get('/whoami', async (ctx) => {
  const caller = callerOf(ctx);
  const p = caller && caller.puter;
  const owner = ownerOf(ctx);
  return json({
    ok: true,
    version: WORKER_VERSION,
    runtime: workerRuntime(),
    sawAuthHeader: Boolean(ctx.request.headers.get('puter-auth')),
    boundAs: ctx.user ? 'user' : ctx.requestor ? 'requestor' : null,
    has: {
      puter: Boolean(p),
      authToken: Boolean(p && p.authToken),
      email: hasMailer(p),
    },
    identified: Boolean(await callerIdOf(caller)),
    owner: {
      email: Boolean(owner && owner.puter && owner.puter.email),
      authToken: Boolean(owner && owner.puter && owner.puter.authToken),
    },
  });
});

router.post('/invites', async (ctx) => {
  // A caller context exists only for requests that came through
  // puter.workers.exec(), which forwards their Puter session. No session, no
  // send — and no way to bill anyone for one either.
  const caller = callerOf(ctx);
  if (!caller || !caller.puter) return json({ error: 'sign_in_required', detail: 'no_caller' }, 401);
  const callerId = await callerIdOf(caller);
  if (!callerId) return json({ error: 'sign_in_required', detail: 'no_identity' }, 401);

  let body = null;
  try {
    body = await ctx.request.json();
  } catch {
    /* readRequest refuses a null body */
  }
  const req = readRequest(body);
  if (req.error) return json({ error: req.error, reason: req.reason }, 400);

  const kv = kvOf(ctx);
  const budget = await reserveQuota(kv, await quotaKey(callerId), req.emails.length);
  if (!budget) return json({ error: 'daily_limit', limit: DAILY_LIMIT }, 429);

  const subject = line(KINDS[req.kind].subject(req), 160);
  const text = textBody(req);
  const html = htmlBody(req);
  const results = [];
  let sent = 0;
  let used = 0;

  for (const email of req.emails) {
    if (used >= budget) {
      results.push({ email, status: 'skipped', reason: 'daily_limit' });
      continue;
    }
    try {
      used += 1;
      const out = (await sendMail(ctx, { to: email, subject, text, html })) || {};
      // One recipient per send, so these arrays name this recipient or nobody.
      if ((out.suppressed || []).includes(email)) {
        results.push({ email, status: 'suppressed' });
        continue;
      }
      if ((out.failed || []).includes(email)) {
        results.push({ email, status: 'failed' });
        continue;
      }
      sent += 1;
      results.push({ email, status: 'sent' });
    } catch (err) {
      results.push({ email, status: 'failed', reason: line(String((err && err.message) || err), 200) });
    }
  }

  return json({
    ok: true,
    sent,
    failed: results.filter((r) => r.status === 'failed').length,
    suppressed: results.filter((r) => r.status === 'suppressed').length,
    capped: results.filter((r) => r.reason === 'daily_limit').length,
    results,
  });
});
