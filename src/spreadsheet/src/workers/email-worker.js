/**
 * Email from the spreadsheet: the app's one shared, app-owned Puter worker (deployed to
 * https://spreadsheet-email.puter.work; src/lib/mail.js is the calling side). Adapted from the Calendar
 * app's invitation worker (src/calendar/src/workers/email-worker.js), whose sending arrangement it keeps.
 *
 * Outbound mail has to be authorized by a worker's own token, so the sending capability lives here, in a
 * worker the app owner deployed once. The cost does not: the app calls this worker through
 * puter.workers.exec(), which forwards the signed-in user's Puter session, and each message is sent with
 * that session in hand, so every send is billed to, and rate-limited as, the person who asked for it.
 * The browser never hands over a token of its own; the worker never returns one.
 *
 *   POST /copies    a copy of a workbook (.xlsx, .pdf or .csv) as an attachment, with a subject and a message
 *   POST /links     a link that opens a workbook, with what the link lets them do and a message
 *   POST /mentions  "you were mentioned in a comment": the comment, its cell, and a link to that cell
 *   GET  /health    liveness and the deployed version (no auth)
 *   GET  /whoami    what the worker can see of the caller's session (names and presence only)
 *
 * An app-owned relay that forwarded whatever it was handed would be a spam cannon wearing the app's
 * sending reputation, so it never does:
 *   - no Puter session, no send: `user` is only populated for callers that come through
 *     puter.workers.exec(); everyone else gets 401.
 *   - the sender is the caller: the mail names them by their own Puter username (read from their
 *     session, never from the request) and replies go to their own address when Puter can tell it.
 *   - the body is composed here. Text the caller supplies (workbook name, subject, message, comment) is
 *     HTML-escaped and length-capped, and the only links written are ones this worker checked: https, on
 *     a Puter host, in the shape the app's own links take.
 *   - an attachment must be a workbook: an .xlsx (a zip), a PDF or a CSV, recognized by its first bytes
 *     and named with the matching extension, no larger than MAX_ATTACHMENT_BYTES.
 *   - recipients are capped per request (MAX_RECIPIENTS) and per user per day (DAILY_LIMIT); each gets a
 *     message of their own, so nobody sees the others' addresses.
 *   - a mention is mailed once per comment and person (a retry after a lost reply sends nothing again).
 *
 * KV here belongs to the APP OWNER, so it holds nothing personal: keys are SHA-256 hashes, values counts
 * or timestamps.
 *
 *   mail:rate:<sha256(callerId)>:<YYYY-MM-DD>               -> count  (expires: RATE_TTL)
 *   mail:mention:<sha256(callerId|commentId|email)>         -> { at }  (expires: SENT_TTL)
 *
 * Deploy with:  npm run deploy:email-worker
 */

const WORKER_VERSION = '1';

const RATE_PREFIX = 'mail:rate:';
const MENTION_PREFIX = 'mail:mention:';
const RATE_TTL = 2 * 24 * 60 * 60; // seconds: yesterday's counter is dead weight
const SENT_TTL = 90 * 24 * 60 * 60; // seconds

const MAX_RECIPIENTS = 20; // per request
const DAILY_LIMIT = 100; // messages per user per UTC day
const MAX_ATTACHMENT_BYTES = 7 * 1024 * 1024; // decoded; base64 adds a third on the wire
const MAX_MESSAGE = 2000;
const MAX_COMMENT = 2000;

/* ---- Small utilities ---------------------------------------------------- */

/** The worker owner's context (the `me` global; ctx.me in tests). */
function ownerOf(ctx) {
  return (ctx && ctx.me) || (typeof me !== 'undefined' ? me : null);
}

/** The signed-in caller. The runtime has called this both `user` and `requestor`. */
function callerOf(ctx) {
  return (ctx && (ctx.user || ctx.requestor)) || null;
}

/** Who the caller is, from their own session: { id, username, email }. id '' when it cannot be told. */
async function identityOf(caller) {
  const out = { id: '', username: '', email: '' };
  if (!caller) return out;
  const pick = (o) => {
    if (!o || typeof o !== 'object') return;
    const id = o.uuid || o.uid || o.user_uuid;
    if (!out.id && typeof id === 'string' && id) out.id = id;
    if (!out.username && typeof o.username === 'string' && o.username) out.username = o.username;
    if (!out.email && typeof o.email === 'string') out.email = lowerEmail(o.email);
  };
  pick(caller);
  pick(caller.puter);
  const p = caller.puter;
  if (!out.id || !out.username || !out.email) {
    try {
      pick(p && p.auth && typeof p.auth.getUser === 'function' ? await p.auth.getUser() : null);
    } catch {
      /* an unreachable whoami is not an identity */
    }
  }
  if (!out.id && out.username) out.id = out.username;
  return out;
}

function kvOf(ctx) {
  return ownerOf(ctx).puter.kv;
}

function coerce(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
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

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

function lowerEmail(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return /^[^\s@<>()",;:\\[\]]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(s) && s.length <= 254 ? s : '';
}

/** Body text: control characters stripped, newlines kept, length capped. */
function text(v, cap) {
  return typeof v === 'string' ? v.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').slice(0, cap) : '';
}

/** Header-safe text: as above, folded to one line (a stray CR/LF in a subject is how header injection starts). */
function line(v, cap) {
  return text(v, cap).replace(/[\r\n]+/g, ' ').trim();
}

function escapeHtml(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeBlock(v) {
  return escapeHtml(v).replace(/\r?\n/g, '<br>');
}

/* ---- Request validation --------------------------------------------------- */

/** Origins a development harness adds (dev/email-mock.js runs this file in the page); none when deployed. */
const DEV_ORIGINS = [];

/** The Puter hosts a link in a mail may point at: the app's own pages and Puter itself. */
function puterHost(hostname) {
  return /^(?:[a-z0-9-]+\.)*(?:puter\.com|puter\.site|puter\.app)$/i.test(hostname);
}

/**
 * A workbook link, or ''. https, on a Puter host, and with the app's own route shapes when it carries
 * one in its fragment: #/file/<id>[?range=…], #/edit/<path>[?range=…] or #/live/<room>?server=… with
 * an optional invitation. Anything else is refused rather than mailed under the app's name.
 */
function workbookLink(value) {
  if (typeof value !== 'string' || value.length > 2000) return '';
  let url = null;
  try {
    url = new URL(value);
  } catch {
    return '';
  }
  const dev = DEV_ORIGINS.includes(url.origin);
  if (!dev && (url.protocol !== 'https:' || url.port || !puterHost(url.hostname))) return '';
  if (url.username || url.password) return '';
  const hash = url.hash;
  if (hash && !/^#\/(?:file|edit|live)\/[^\s<>"`]+$/.test(hash)) return '';
  return url.href;
}

/** Recipients as one list of distinct, well-formed addresses (capped), or { error }. */
function readRecipients(list, { withName = false } = {}) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(list) ? list : []) {
    const email = lowerEmail(typeof r === 'string' ? r : r && r.email);
    if (!email) return { error: 'invalid_recipient' };
    if (seen.has(email)) continue;
    seen.add(email);
    out.push(withName ? { email, name: line(r && r.name, 120) } : { email });
  }
  if (!out.length) return { error: 'recipients_required' };
  if (out.length > MAX_RECIPIENTS) return { error: 'too_many_recipients', limit: MAX_RECIPIENTS };
  return { recipients: out };
}

const ATTACHMENT_KINDS = {
  xlsx: { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: [0x50, 0x4b, 0x03, 0x04] },
  pdf: { type: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  csv: { type: 'text/csv; charset=utf-8', magic: null },
};

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** The first `n` bytes of a base64 string (enough to recognize a file by its signature). */
function base64Head(b64, n) {
  const bytes = [];
  let bits = 0;
  let acc = 0;
  for (let i = 0; i < b64.length && bytes.length < n; i++) {
    const v = B64.indexOf(b64[i]);
    if (v < 0) break;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  return bytes;
}

/** The attachment, normalized, or { error }: a workbook file of a known kind, its name and bytes checked. */
function readAttachment(a) {
  if (!a || typeof a !== 'object') return { error: 'attachment_required' };
  const content = typeof a.content === 'string' ? a.content.replace(/\s+/g, '') : '';
  if (!content || content.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(content)) return { error: 'invalid_attachment' };
  const bytes = (content.length / 4) * 3 - (content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0);
  if (bytes > MAX_ATTACHMENT_BYTES) return { error: 'attachment_too_large', limit: MAX_ATTACHMENT_BYTES };
  const name = line(a.filename, 150).replace(/[\\/:*?"<>|]+/g, '-');
  const ext = (/\.([a-z0-9]+)$/i.exec(name) || [])[1];
  const kind = ext && ATTACHMENT_KINDS[ext.toLowerCase()];
  if (!kind) return { error: 'invalid_attachment', reason: 'type' };
  const head = base64Head(content, 8);
  if (kind.magic && !kind.magic.every((b, i) => head[i] === b)) return { error: 'invalid_attachment', reason: 'content' };
  // A CSV is text: a NUL among its first bytes says it is something else under a .csv name.
  if (!kind.magic && head.includes(0)) return { error: 'invalid_attachment', reason: 'content' };
  return { filename: name, contentType: kind.type, content, bytes };
}

function readWorkbook(src) {
  const wb = src && typeof src.workbook === 'object' && src.workbook ? src.workbook : {};
  return { name: line(wb.name, 200) || 'Untitled spreadsheet' };
}

/* ---- The messages --------------------------------------------------------- */

const FRAME_OPEN =
  `<div style="background:#f6f7f9;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">` +
  `<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px">`;
const FRAME_CLOSE =
  `<p style="margin:24px 0 0;font-size:12px;color:#9ca3af">Sent from Spreadsheet on Puter at the request of the person named above.</p></div></div>`;

function button(href, label) {
  return (
    `<a href="${escapeHtml(href)}" style="display:inline-block;margin:20px 0 4px;padding:10px 20px;border-radius:8px;` +
    `background:#356d49;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none">${escapeHtml(label)}</a>`
  );
}

function intro(textHtml) {
  return `<p style="margin:0 0 16px;color:#374151;font-size:14px">${textHtml}</p>`;
}

function title(t) {
  return `<h1 style="margin:0 0 12px;color:#111827;font-size:20px;line-height:1.3">${escapeHtml(t)}</h1>`;
}

function note(message) {
  return message
    ? `<p style="margin:16px 0 0;padding:12px 14px;border-left:3px solid #356d49;background:#f6f7f9;color:#111827;font-size:14px;white-space:pre-wrap">${escapeBlock(message)}</p>`
    : '';
}

function compose(kind, req, sender) {
  const who = sender.username || 'Someone';
  const wb = req.workbook.name;
  if (kind === 'copy') {
    const what = `a copy of “${wb}”`;
    return {
      subject: req.subject || line(`${who} sent you ${what}`, 200),
      text: [`${who} sent you ${what}. It is attached to this email (${req.attachment.filename}).`, req.message ? `\n${req.message}` : ''].join('\n'),
      html: FRAME_OPEN + intro(`<strong>${escapeHtml(who)}</strong> sent you a copy of a spreadsheet.`) + title(wb) +
        `<p style="margin:0;color:#6b7280;font-size:13px">Attached: ${escapeHtml(req.attachment.filename)}</p>` + note(req.message) + FRAME_CLOSE,
    };
  }
  if (kind === 'link') {
    const can = req.access === 'edit' ? 'edit' : 'view';
    return {
      subject: line(`${who} shared “${wb}” with you`, 200),
      text: [`${who} shared a spreadsheet with you: you can ${can} it.`, '', wb, req.message ? `\n${req.message}\n` : '', `Open it: ${req.link}`].join('\n'),
      html: FRAME_OPEN + intro(`<strong>${escapeHtml(who)}</strong> shared a spreadsheet with you. You can ${can} it.`) + title(wb) +
        note(req.message) + button(req.link, 'Open the spreadsheet') + FRAME_CLOSE,
    };
  }
  // A mention, or an assignment.
  const where = req.comment.cell ? ` on ${req.comment.cell}` : '';
  const did = req.assigned ? 'assigned you a comment' : 'mentioned you in a comment';
  return {
    subject: line(req.assigned ? `${who} assigned you a comment in “${wb}”` : `${who} mentioned you in “${wb}”`, 200),
    text: [`${who} ${did}${where} in “${wb}”:`, '', req.comment.text, '',
      req.assigned ? 'Resolve the comment when it is done.' : '', `Open the comment: ${req.link}`].filter((l, i, a) => l || a[i - 1] !== '').join('\n'),
    html: FRAME_OPEN + intro(`<strong>${escapeHtml(who)}</strong> ${did}${escapeHtml(where)}${req.assigned ? '. Resolve it when it is done' : ''}.`) + title(wb) +
      note(req.comment.text) + button(req.link, 'Open the comment') + FRAME_CLOSE,
  };
}

/* ---- Sending (the Calendar worker's arrangement) -------------------------- */

/**
 * A send has two halves, who pays (the caller) and what authorizes it (this worker), and the platform
 * accepts them in either arrangement:
 *
 *   me.puter.email.sendTransactional({ …, requesterToken: user.puter.authToken })
 *   user.puter.email.sendTransactional({ …, emailAccessToken: me.puter.authToken })
 *
 * Both bill the caller. Try the first, fall back to the second, and remember which one answered. The
 * fallback is only taken for an error that reads as a rejected request, never a rejected delivery:
 * retrying a message the transport already accepted would send it twice.
 */
let preferredForm = 0;

function mailerOf(puter) {
  const email = puter && puter.email;
  if (email && typeof email.sendTransactional === 'function') return (message) => email.sendTransactional(message);
  return (message) => email.send(message);
}

function hasMailer(puter) {
  const email = puter && puter.email;
  return Boolean(email && (typeof email.sendTransactional === 'function' || typeof email.send === 'function'));
}

const DELIVERY_ERROR = /deliver|recipient|suppress|unsubscrib|mailbox|smtp|bounce|spam|quota|rate|limit|size|large/i;
const REQUEST_ERROR = /token|auth|unauthor|forbidden|permission|denied|unknown|unrecognized|unsupported|invalid|missing|required|not a function|undefined/i;

async function sendMail(ctx, message) {
  const owner = ownerOf(ctx);
  const caller = callerOf(ctx);
  const forms = [
    (m) => mailerOf(owner.puter)({ ...m, requesterToken: caller.puter.authToken }),
    (m) => mailerOf(caller.puter)({ ...m, emailAccessToken: owner.puter.authToken }),
  ];
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
      if (DELIVERY_ERROR.test(reason) || !REQUEST_ERROR.test(reason)) throw err;
    }
  }
  throw lastErr;
}

/* ---- Daily cap -------------------------------------------------------------- */

async function expire(kv, key, seconds) {
  try {
    if (typeof kv.expire === 'function') await kv.expire(key, seconds);
  } catch {
    /* a key that outlives its welcome is harmless */
  }
}

async function quotaUsed(kv, key) {
  const value = coerce(await kv.get(key));
  const used = typeof value === 'number' ? value : parseInt(value, 10);
  return Number.isFinite(used) && used > 0 ? used : 0;
}

/** Reserve `want` sends against today's cap (atomically where the store can) and say how many may go. */
async function reserveQuota(kv, key, want) {
  if (typeof kv.incr !== 'function') {
    const used = await quotaUsed(kv, key);
    return { granted: Math.min(want, Math.max(0, DAILY_LIMIT - used)), reserved: false };
  }
  const res = await kv.incr(key, want);
  const after = Number.isFinite(Number(res)) && res !== null ? Number(res) : await quotaUsed(kv, key);
  await expire(kv, key, RATE_TTL);
  const granted = Math.max(0, Math.min(want, DAILY_LIMIT - (after - want)));
  if (granted < want) await releaseQuota(kv, key, want - granted);
  return { granted, reserved: true };
}

async function releaseQuota(kv, key, n) {
  if (!n) return;
  try {
    if (typeof kv.decr === 'function') await kv.decr(key, n);
    else await kv.incr(key, -n);
  } catch {
    /* a lost refund only makes the cap stricter */
  }
}

async function settleQuota(kv, key, quota, sent) {
  if (quota.reserved) {
    await releaseQuota(kv, key, quota.granted - sent);
    return;
  }
  if (!sent) return;
  try {
    await kv.set(key, (await quotaUsed(kv, key)) + sent);
    await expire(kv, key, RATE_TTL);
  } catch {
    /* the cap is a guard rail, not a ledger */
  }
}

/* ---- Routes ---------------------------------------------------------------- */

router.get('/health', async () => json({ ok: true, version: WORKER_VERSION }));

router.get('/whoami', async (ctx) => {
  const caller = callerOf(ctx);
  const p = caller && caller.puter;
  const who = await identityOf(caller);
  return json({
    ok: true,
    version: WORKER_VERSION,
    sawAuthHeader: Boolean(ctx.request.headers.get('puter-auth')),
    boundAs: ctx.user ? 'user' : ctx.requestor ? 'requestor' : null,
    has: { puter: Boolean(p), authToken: Boolean(p && p.authToken), email: hasMailer(p) },
    identified: Boolean(who.id),
  });
});

/** Read the request for a route: { req } normalized, or { error, status }. */
function readRequest(kind, body) {
  const src = body && typeof body === 'object' ? body : {};
  const people = readRecipients(src.recipients, { withName: kind === 'mention' });
  if (people.error) return { status: 400, body: people };
  const req = { workbook: readWorkbook(src), recipients: people.recipients };
  if (kind === 'copy') {
    const attachment = readAttachment(src.attachment);
    if (attachment.error) return { status: attachment.error === 'attachment_too_large' ? 413 : 400, body: attachment };
    req.attachment = attachment;
    req.subject = line(src.subject, 200);
    req.message = text(src.message, MAX_MESSAGE);
  } else if (kind === 'link') {
    req.link = workbookLink(src.link);
    if (!req.link) return { status: 400, body: { error: 'invalid_link' } };
    req.access = src.access === 'edit' ? 'edit' : 'view';
    req.message = text(src.message, MAX_MESSAGE);
  } else {
    req.link = workbookLink(src.link);
    if (!req.link) return { status: 400, body: { error: 'invalid_link' } };
    const c = src.comment && typeof src.comment === 'object' ? src.comment : {};
    // The id keys the once-per-person record: the GUID shape comments carry, nothing that could smuggle a separator.
    if (typeof c.id !== 'string' || !/^\{?[0-9A-Fa-f-]{36}\}?$/.test(c.id)) return { status: 400, body: { error: 'comment_required' } };
    const commentText = text(c.text, MAX_COMMENT).trim();
    if (!commentText) return { status: 400, body: { error: 'comment_required' } };
    req.comment = { id: c.id.toUpperCase(), text: commentText, cell: line(c.cell, 120) };
    // The thread was also assigned to the people written to: a task for them, which the mail says.
    req.assigned = src.assigned === true;
  }
  return { req };
}

/** The one send pipeline: auth, the cap, one private message per recipient, a result per recipient. */
async function deliver(ctx, kind) {
  const caller = callerOf(ctx);
  if (!caller || !caller.puter) return json({ error: 'sign_in_required', detail: 'no_caller' }, 401);
  const sender = await identityOf(caller);
  if (!sender.id) return json({ error: 'sign_in_required', detail: 'no_identity' }, 401);

  let body = null;
  try {
    body = await ctx.request.json();
  } catch {
    /* handled by readRequest */
  }
  const read = readRequest(kind, body);
  if (!read.req) return json(read.body, read.status);
  const req = read.req;
  const kv = kvOf(ctx);

  const results = [];
  const due = [];
  for (const person of req.recipients) {
    if (kind === 'mention') {
      const key = MENTION_PREFIX + (await sha256Hex(`${sender.id}|${req.comment.id}|${person.email}`));
      const previous = coerce(await kv.get(key));
      if (previous) {
        results.push({ email: person.email, status: 'skipped', reason: 'already_sent', at: previous.at || 0 });
        continue;
      }
      due.push({ person, key });
    } else due.push({ person, key: null });
  }

  const rateKey = `${RATE_PREFIX}${await sha256Hex(sender.id)}:${new Date().toISOString().slice(0, 10)}`;
  const quota = due.length ? await reserveQuota(kv, rateKey, due.length) : { granted: 0, reserved: false };
  if (!quota.granted && due.length) return json({ error: 'daily_limit', limit: DAILY_LIMIT }, 429);
  let budget = quota.granted;

  const message = compose(kind, req, sender);
  const attachments = kind === 'copy'
    ? [{ filename: req.attachment.filename, content: req.attachment.content, contentType: req.attachment.contentType }]
    : undefined;
  let sent = 0;
  for (const { person, key } of due) {
    if (!budget) {
      results.push({ email: person.email, status: 'skipped', reason: 'daily_limit' });
      continue;
    }
    try {
      const out = (await sendMail(ctx, {
        to: person.email,
        subject: message.subject,
        text: message.text,
        html: message.html,
        replyTo: sender.email || undefined,
        attachments,
      })) || {};
      if ((out.suppressed || []).includes(person.email)) {
        results.push({ email: person.email, status: 'suppressed' });
        continue;
      }
      if ((out.failed || []).includes(person.email)) {
        results.push({ email: person.email, status: 'failed', reason: 'delivery_failed' });
        continue;
      }
      budget -= 1;
      sent += 1;
      const at = Date.now();
      results.push({ email: person.email, status: 'sent', at });
      if (key) {
        try {
          await kv.set(key, { at });
          await expire(kv, key, SENT_TTL);
        } catch {
          /* sent but unrecorded: a retry can at worst duplicate, never lose */
        }
      }
    } catch (err) {
      results.push({ email: person.email, status: 'failed', reason: line((err && err.message) || 'send_failed', 200) });
    }
  }
  await settleQuota(kv, rateKey, quota, sent);

  return json({
    ok: true,
    version: WORKER_VERSION,
    sent,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
    suppressed: results.filter((r) => r.status === 'suppressed').length,
    results,
  });
}

router.post('/copies', (ctx) => deliver(ctx, 'copy'));
router.post('/links', (ctx) => deliver(ctx, 'link'));
router.post('/mentions', (ctx) => deliver(ctx, 'mention'));
