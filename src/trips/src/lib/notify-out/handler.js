// The events handler's work, run as the subscriber (who pays for every read, write, fetch and email here).
// worker-notify/ bundles this into the closure-free function the events worker runs.
// Context (`ctx`, set by the app when it subscribes): `{v: 1, k: 'trip'|'sched', u: <uuid>, o: <app origin>,
// s?: <spaceId>, w?: <worker>, h?: <read handle>}`. Trip subscriptions watch the space's `sig`; the schedule
// subscription watches `me:notify:sched`. Every run also delivers due reminders, a pending test and due retries.
import table from '../i18n/en/notifyOut.js';
import { KEYS, cleanNotifyPrefs, cleanSecret, readyChannels, channelsFor } from './model.js';
import { REMINDER_KINDS, changeItems, changeNote, reminderNote, testNote, noteCategories, narrowNote, webhookBody, ntfyBody, digestEmail, storedNote, readNote } from './payload.js';
import { urlProblem } from './guard.js';
import { signatureHeader } from './sign.js';
import { INLINE_DELAYS, MAX_INLINE_WAIT, SEND_TIMEOUT, classify, retryAfterMs, nextAttempt } from './retry.js';

const HOUR = 3_600_000;
export const RUN_BUDGET = 22_000;
export const PUSH_PER_HOUR = 30;
// Emails (digests and tests) and test notifications per account per hour.
export const EMAIL_PER_HOUR = 5;
export const TESTS_PER_HOUR = 5;
// Links in notifications always point here; the subscription context is written by the client.
export const APP_ORIGIN = 'https://trips.puter.com';
export const MAX_REVS = 20;
const REMINDER_GRACE = 36 * HOUR;
const TEST_GRACE = 10 * 60_000;
const BUCKET_TTL = 48 * 3600;
const NOTES_PER_RUN = 10;
const RETRY_MAX = 20;
const RETRY_PER_RUN = 5;
const DIGEST_MAX = 50;
const DIGEST_AGE = 7 * 24 * HOUR;
const WINDOWS = { hour: HOUR, day: 24 * HOUR };
const USER_AGENT = 'Trips-Notify/1 (+https://trips.puter.com)';

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const pathSafe = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const spaceId = (value) => typeof value === 'string' && /^[a-z0-9]{16}$/.test(value);
const pathValue = (object, path) => path.split('.').reduce((value, part) => (plain(value) ? value[part] : undefined), object);
/** UTC hour bucket `YYYYMMDDHH` for the claim keys. */
export const hourBucket = (ms) => new Date(ms).toISOString().slice(0, 13).replace(/[-T]/g, '');

export function translator(strings = table) {
  return (key, values = {}) => (Object.hasOwn(strings, key) ? strings[key] : key).replace(/\{(\w+)\}/g, (match, name) => (Object.hasOwn(values, name) ? String(values[name]) : match));
}

/**
 * Claims each `{at, path}` once across runs and devices: one `incr` per hour bucket, and a path whose count comes
 * back as 1 is ours. A bucket expires 48 h after its first claim. Returns the claimed paths.
 */
export async function claim(kv, entries) {
  const groups = new Map();
  for (const entry of entries) {
    const bucket = hourBucket(entry.at);
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(entry.path);
  }
  const won = new Set();
  for (const [bucket, paths] of groups) {
    const key = KEYS.bucket(bucket);
    const result = await kv.incr(key, { ...Object.fromEntries(paths.map((path) => [path, 1])), n: 1 });
    // Without a readable result, deliver rather than lose the notification.
    for (const path of paths) if (!plain(result) || pathValue(result, path) === 1) won.add(path);
    if (plain(result) && result.n === 1) await kv.expire(key, BUCKET_TTL).catch(() => {});
  }
  return won;
}

/** Change records after the last rev this account was notified about for the space, at most `MAX_REVS`. */
async function tripRecords(run, ctx, event, revs) {
  const read = (keys) => (ctx.h ? run.kv.get(keys, { handle: ctx.h }) : run.kv.get(keys.map((key) => `shared:${ctx.s}:${key}`)));
  let sig = event?.op === 'set' && plain(event.value) ? event.value : null;
  if (!sig) [sig] = await read(['sig']);
  if (!plain(sig) || !Number.isSafeInteger(sig.rev) || sig.rev < 1) return { records: [], read };
  const last = Number.isSafeInteger(revs?.[ctx.s]) ? revs[ctx.s] : 0;
  if (sig.rev <= last) return { records: [], read };
  const from = last > 0 ? Math.max(last + 1, sig.rev - MAX_REVS + 1) : sig.rev;
  const records = [];
  const missing = [];
  for (let rev = from; rev <= sig.rev; rev++) {
    if (rev === sig.rev && Array.isArray(sig.sum)) records.push(sig); else missing.push(rev);
  }
  if (missing.length) {
    const values = await read(missing.map((rev) => `ch:${rev}:0`));
    values.forEach((value, index) => { if (plain(value) && value.rev === missing[index]) records.push(value); });
  }
  await run.kv.update(KEYS.rev, { [ctx.s]: sig.rev });
  return { records, read };
}

async function tripNote(run, ctx, event, revs) {
  if (!spaceId(ctx.s)) return null;
  const { records, read } = await tripRecords(run, ctx, event, revs);
  const at = (record) => (Number.isFinite(record.at) ? record.at : run.now());
  const won = records.length ? await claim(run.kv, records.map((record) => ({ at: at(record), path: `c.${ctx.s}.${record.rev}` }))) : new Set();
  const fresh = records.filter((record) => won.has(`c.${ctx.s}.${record.rev}`));
  const items = changeItems(fresh, ctx.u);
  if (!items.length) return null;
  const people = [...new Set(items.map((item) => item.by).filter((uuid) => typeof uuid === 'string' && /^[0-9a-f-]{36}$/i.test(uuid)))].slice(0, 10);
  const [meta, ...members] = await read(['e:meta:meta', ...people.map((uuid) => `e:member:${uuid}`)]).catch(() => []);
  const names = new Map(people.map((uuid, index) => [uuid, typeof members[index]?.name === 'string' ? members[index].name : '']));
  const last = fresh.at(-1);
  return changeNote({
    space: ctx.s, worker: ctx.w, title: meta?.title ?? '', origin: APP_ORIGIN, rev: last.rev, at: at(last),
    items: items.map((item) => ({ ...item, who: names.get(item.by) ?? '' })),
  });
}

/** Counts `amount` against `rl.<name>` in this hour's bucket; true while the count stays within `limit`. */
async function hourly(run, name, limit, amount = 1) {
  const key = KEYS.bucket(hourBucket(run.now()));
  const result = await run.kv.incr(key, { [`rl.${name}`]: amount, n: 1 });
  if (plain(result) && result.n === 1) await run.kv.expire(key, BUCKET_TTL).catch(() => {});
  return !plain(result) || (Number(pathValue(result, `rl.${name}`)) || 0) <= limit;
}

/** Due reminders and a pending test from `me:notify:sched`, claimed. */
async function scheduleNotes(run, ctx, sched) {
  if (!plain(sched)) return [];
  const now = run.now();
  const candidates = [];
  const test = sched.test;
  if (plain(test) && pathSafe(test.id) && Number.isFinite(test.at) && now - test.at <= TEST_GRACE && test.at - now <= 60_000) {
    candidates.push({ at: test.at, path: `t.${test.id}`, note: testNote(test.id, test.at) });
  }
  for (const [id, item] of Object.entries(plain(sched.items) ? sched.items : {})) {
    if (!pathSafe(id) || !plain(item) || !Number.isFinite(item.at) || !REMINDER_KINDS.includes(item.kind) || !spaceId(item.space)) continue;
    if (item.at > now || now - item.at > REMINDER_GRACE) continue;
    candidates.push({ at: item.at, path: `r.${id}`, note: reminderNote({ ...item, id }, { origin: APP_ORIGIN, now }) });
  }
  const chosen = candidates.sort((a, b) => a.at - b.at).slice(0, NOTES_PER_RUN);
  if (!chosen.length) return [];
  const won = await claim(run.kv, chosen);
  const notes = chosen.filter((entry) => won.has(entry.path)).map((entry) => entry.note);
  // Anyone can write a test with a fresh id, so tests have an hourly cap of their own.
  const testing = notes.find((note) => note.kind === 'test');
  if (testing && !(await hourly(run, 'test', TESTS_PER_HOUR))) notes.splice(notes.indexOf(testing), 1);
  return notes;
}

function request(run, channel, note) {
  if (channel === 'webhook') {
    if (urlProblem(run.secret.webhookUrl)) return null;
    const body = JSON.stringify(webhookBody(note, run.prefs.channels.webhook.format, run.t));
    return {
      url: run.secret.webhookUrl, body,
      headers: async () => ({
        'Content-Type': 'application/json', 'User-Agent': USER_AGENT, 'Trips-Event': note.kind, 'Trips-Delivery': note.id,
        'Trips-Signature': await signatureHeader(run.secret.webhookSecret, body, run.now(), run.subtle),
      }),
    };
  }
  const server = run.prefs.channels.ntfy.server;
  if (urlProblem(server)) return null;
  const body = JSON.stringify(ntfyBody(note, { topic: run.secret.ntfyTopic, priority: run.prefs.channels.ntfy.priority }, run.t));
  return {
    url: `${server}/`, body,
    headers: async () => ({
      'Content-Type': 'application/json', 'User-Agent': USER_AGENT,
      ...(run.secret.ntfyToken ? { Authorization: `Bearer ${run.secret.ntfyToken}` } : {}),
    }),
  };
}

/** One POST with inline retries. Resolves `{verdict: 'ok'|'retry'|'fail', status, retryAfter}`. */
export async function send(run, channel, note, delays = INLINE_DELAYS) {
  const target = request(run, channel, note);
  if (!target) return { verdict: 'fail', status: 0, code: 'url' };
  let outcome = { verdict: 'retry', status: 0, retryAfter: null };
  for (const delay of delays) {
    if (run.now() + delay + SEND_TIMEOUT > run.deadline) break;
    if (delay) await run.sleep(delay);
    let status = 0;
    let retryAfter = null;
    try {
      const response = await run.fetch(target.url, {
        method: 'POST', headers: await target.headers(), body: target.body, redirect: 'manual', signal: AbortSignal.timeout(SEND_TIMEOUT),
      });
      // Redirects are never followed; a runtime that hides them reports an opaque redirect.
      status = response.type === 'opaqueredirect' ? 302 : response.status;
      retryAfter = retryAfterMs(response.headers?.get?.('retry-after'), run.now());
      response.body?.cancel?.().catch?.(() => {});
    } catch { status = 0; }
    const verdict = classify(status);
    outcome = { verdict, status, retryAfter };
    if (verdict !== 'retry' || (retryAfter ?? 0) > MAX_INLINE_WAIT) break;
  }
  return outcome;
}

function record(run, channel, outcome, note) {
  run.status[channel] = { at: run.now(), ok: outcome.verdict === 'ok', ...(outcome.status ? { status: outcome.status } : {}), ...(outcome.code ? { code: outcome.code } : {}), ...(outcome.verdict === 'retry' ? { queued: true } : {}) };
  if (note?.kind === 'test') run.test[channel] = outcome.verdict;
}

async function persist(run, channel, note, outcome, retries) {
  if (Object.keys(retries).length >= RETRY_MAX) { record(run, channel, { ...outcome, verdict: 'fail', code: 'retry_full' }, note); return; }
  const now = run.now();
  const next = nextAttempt(0, { first: now, now, retryAfter: outcome.retryAfter });
  if (next == null) return;
  const id = `${note.id}_${channel}`;
  retries[id] = true;
  await run.kv.update(KEYS.retry, { [id]: { ch: channel, note: storedNote(note), n: 0, first: now, next } });
}

/** Email goes only to the account's own address, once Puter has confirmed it; anything else could mail strangers. */
async function ownAddress(run) {
  if (run.ownAddress === undefined) {
    let account = null;
    try { account = await (run.user.auth?.getUser ? run.user.auth.getUser() : run.user.getUser?.()); } catch { /* treated as unconfirmed */ }
    const address = typeof account?.email === 'string' ? account.email.trim().toLowerCase() : '';
    run.ownAddress = account?.email_confirmed === true && address === run.secret.email.trim().toLowerCase();
  }
  return run.ownAddress;
}

async function sendEmail(run, notes) {
  if (!(await ownAddress(run))) return { verdict: 'fail', status: 0, code: 'unverified' };
  // Over the hourly cap a digest waits for a later hour; a test is dropped.
  if (!(await hourly(run, 'email', EMAIL_PER_HOUR))) return { verdict: 'retry', status: 0, code: 'limit' };
  const { subject, text, html } = digestEmail(notes, run.t);
  try {
    await run.user.email.sendTransactional({ to: run.secret.email, subject, text, html });
    return { verdict: 'ok', status: 200 };
  } catch (error) {
    const status = Number(error?.status) || 0;
    if (status === 402) return { verdict: 'fail', status, code: 'plan' };
    return { verdict: status && status < 500 && status !== 429 ? 'fail' : 'retry', status, code: typeof error?.code === 'string' ? error.code.slice(0, 60) : undefined };
  }
}

async function route(run, notes, retries) {
  const jobs = [];
  const digest = [];
  for (const note of notes) {
    for (const channel of run.ready) {
      let narrowed = note;
      if (note.kind !== 'test') {
        const categories = noteCategories(note).filter((category) => channelsFor(run.prefs, run.ready, category, note.trip?.id).includes(channel));
        narrowed = categories.length ? narrowNote(note, categories) : null;
      }
      if (!narrowed) continue;
      if (channel === 'email' && note.kind !== 'test') digest.push(narrowed);
      else jobs.push({ channel, note: narrowed });
    }
  }
  const counts = {};
  for (const job of jobs) if (job.channel !== 'email') counts[job.channel] = (counts[job.channel] ?? 0) + 1;
  const allowed = { email: Infinity };
  if (Object.keys(counts).length) {
    const key = KEYS.bucket(hourBucket(run.now()));
    const result = await run.kv.incr(key, { ...Object.fromEntries(Object.entries(counts).map(([channel, count]) => [`rl.${channel}`, count])), n: 1 });
    if (plain(result) && result.n === 1) await run.kv.expire(key, BUCKET_TTL).catch(() => {});
    for (const [channel, count] of Object.entries(counts)) {
      const used = plain(result) ? Number(pathValue(result, `rl.${channel}`)) || count : count;
      allowed[channel] = Math.max(0, PUSH_PER_HOUR - (used - count));
    }
  }
  for (const job of jobs) {
    if (allowed[job.channel] <= 0) { run.dropped[job.channel] = (run.dropped[job.channel] ?? 0) + 1; continue; }
    allowed[job.channel] -= 1;
    const outcome = job.channel === 'email' ? await sendEmail(run, [job.note]) : await send(run, job.channel, job.note);
    record(run, job.channel, outcome, job.note);
    if (outcome.verdict === 'retry' && job.channel !== 'email') await persist(run, job.channel, job.note, outcome, retries);
  }
  return digest;
}

async function drainRetries(run, raw) {
  const entries = Object.entries(plain(raw) ? raw : {}).filter(([id, entry]) => pathSafe(id) && plain(entry) && Number.isFinite(entry.next) && Number.isInteger(entry.n));
  const due = entries.filter(([, entry]) => entry.next <= run.now()).sort((a, b) => a[1].next - b[1].next).slice(0, RETRY_PER_RUN);
  for (const [id, entry] of due) {
    if (run.now() + SEND_TIMEOUT > run.deadline) break;
    const claimed = await run.kv.incr(KEYS.retry, { [`${id}.n`]: 1 });
    if (plain(claimed) && pathValue(claimed, `${id}.n`) !== entry.n + 1) {
      // Another run took it, or it was removed meanwhile and the claim left a stub behind.
      if (!Number.isFinite(pathValue(claimed, `${id}.next`))) await run.kv.remove(KEYS.retry, id);
      continue;
    }
    const note = readNote(entry.note);
    if (!note || !run.ready.includes(entry.ch) || entry.ch === 'email') { await run.kv.remove(KEYS.retry, id); continue; }
    const outcome = await send(run, entry.ch, note, [0]);
    const next = outcome.verdict === 'retry' ? nextAttempt(entry.n + 1, { first: entry.first, now: run.now(), retryAfter: outcome.retryAfter }) : null;
    record(run, entry.ch, next == null && outcome.verdict === 'retry' ? { ...outcome, verdict: 'fail', code: 'gave_up' } : outcome, note);
    if (next == null) await run.kv.remove(KEYS.retry, id);
    else await run.kv.update(KEYS.retry, { [`${id}.next`]: next });
  }
}

/** Adds email notes to `me:notify:digest` and sends it once its oldest note is a window old (or it is full). */
async function digestEmails(run, raw, added) {
  if (!run.ready.includes('email')) return;
  const stored = Object.entries(plain(raw) ? raw : {}).map(([id, value]) => [id, readNote(value)]).filter(([id, note]) => pathSafe(id) && note);
  const fresh = added.filter((note) => pathSafe(note.id));
  if (fresh.length) await run.kv.update(KEYS.digest, Object.fromEntries(fresh.map((note) => [note.id, storedNote(note)])));
  const all = new Map([...stored, ...fresh.map((note) => [note.id, note])]);
  const now = run.now();
  const stale = [...all].filter(([, note]) => now - note.at > DIGEST_AGE).map(([id]) => id);
  for (const id of stale) all.delete(id);
  const notes = [...all.values()].sort((a, b) => a.at - b.at);
  const overflow = notes.length > DIGEST_MAX ? notes.splice(0, notes.length - DIGEST_MAX).map((note) => note.id) : [];
  if (stale.length || overflow.length) await run.kv.remove(KEYS.digest, ...stale, ...overflow);
  if (!notes.length || (now - notes[0].at < WINDOWS[run.prefs.channels.email.every] && notes.length < DIGEST_MAX)) return;
  // One send attempt per hour for a given digest, so a failed send is tried again by a later run.
  const path = `e.${notes[0].id}_${hourBucket(now)}`;
  if (!(await claim(run.kv, [{ at: now, path }])).has(path)) return;
  const outcome = await sendEmail(run, notes);
  record(run, 'email', outcome);
  if (outcome.verdict !== 'retry') await run.kv.remove(KEYS.digest, ...notes.map((note) => note.id));
}

async function writeStatus(run) {
  const paths = { ...run.status };
  for (const [channel, count] of Object.entries(run.dropped)) {
    if (paths[channel]) paths[channel] = { ...paths[channel], dropped: count }; else paths[`${channel}.dropped`] = count;
  }
  if (Object.keys(run.test).length) paths.test = { id: run.testId, at: run.now(), results: run.test };
  if (Object.keys(paths).length) await run.kv.update(KEYS.status, paths).catch(() => {});
}

export async function runHandler({ event, ctx, user, fetch, now = () => Date.now(), sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }), subtle = globalThis.crypto?.subtle, t = translator() }) {
  if (!plain(ctx) || ctx.v !== 1 || typeof ctx.u !== 'string' || !['trip', 'sched'].includes(ctx.k)) return { reason: 'context' };
  if (event?.op === 'del' || event?.op === 'expire') return { reason: 'op' };
  // The handler's own writes never land on a watched key, but a loop would cost the user, so skip them anyway.
  if (ctx.k === 'sched' && event?.self && event?.viaWorker) return { reason: 'self' };
  const kv = user.kv;
  const [prefsRaw, secretRaw, sched, revs, retries, digest] = await kv.get([KEYS.prefs, KEYS.secret, KEYS.sched, KEYS.rev, KEYS.retry, KEYS.digest]);
  const prefs = cleanNotifyPrefs(prefsRaw);
  const secret = cleanSecret(secretRaw);
  const ready = readyChannels(prefs, secret);
  if (!ready.length) return { reason: 'off' };
  const run = { kv, user, fetch, now, sleep, subtle, t, prefs, secret, ready, deadline: now() + RUN_BUDGET, status: {}, dropped: {}, test: {}, testId: null };
  const notes = [];
  if (ctx.k === 'trip') { const note = await tripNote(run, ctx, event, revs); if (note) notes.push(note); }
  notes.push(...await scheduleNotes(run, ctx, sched));
  run.testId = notes.find((note) => note.kind === 'test')?.id.slice(2) ?? null;
  const known = Object.fromEntries(Object.keys(plain(retries) ? retries : {}).map((id) => [id, true]));
  const forDigest = await route(run, notes, known);
  await drainRetries(run, retries);
  await digestEmails(run, digest, forDigest);
  await writeStatus(run);
  return { notes: notes.map((note) => note.id), status: run.status, dropped: run.dropped };
}
