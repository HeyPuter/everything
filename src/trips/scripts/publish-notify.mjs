// Publishes the `tripsNotify` events handler for the Trips app (architecture §7). Run from the app owner's account:
//   npm run build:notify
//   PUTER_TOKEN=<owner token> PUTER_APP_UID=<Trips app uid> npm run publish:notify [-- --replace]
// `npm run publish:notify -- --check` validates the built handler without any network call.
// Optional PUTER_API_ORIGIN (default https://api.puter.com). An unchanged handler is skipped unless --replace is
// given; republishing also resumes subscriptions the platform suspended. REST shapes as in
// src/calendar/scripts/publish-mail-handler.mjs.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { HANDLER_NAME } from '../src/lib/notify-out/model.js';

const SOURCE = new URL('../worker-notify/dist/trips-notify-handler.js', import.meta.url);
const MAX_SOURCE_BYTES = 64 * 1024;

function fail(message) {
  console.error(`publish-notify: ${message}`);
  process.exit(1);
}

function readSource() {
  let source;
  try { source = readFileSync(SOURCE, 'utf8'); } catch { fail('worker-notify/dist/trips-notify-handler.js is missing; run `npm run build:notify` first.'); }
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > MAX_SOURCE_BYTES) fail(`the handler is ${bytes} bytes, over the platform's ${MAX_SOURCE_BYTES}-byte limit.`);
  // The platform wraps the source as one function expression; refuse anything else before it does.
  try {
    if (typeof new Function(`return (\n${source}\n)`)() !== 'function') throw new Error('not a function');
  } catch (error) {
    fail(`the handler is not a single function expression: ${error.message}`);
  }
  return source;
}

async function published(origin, headers, appUid) {
  try {
    const response = await fetch(`${origin}/events/handlers/list?appUid=${encodeURIComponent(appUid)}`, { headers });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    return (Array.isArray(data?.handlers) ? data.handlers : []).find((handler) => handler?.name === HANDLER_NAME) ?? null;
  } catch {
    return null;
  }
}

if (process.argv.includes('--check')) {
  const source = readSource();
  console.log(`publish-notify: ${HANDLER_NAME} is valid (${Buffer.byteLength(source, 'utf8')} bytes).`);
  process.exit(0);
}

const token = process.env.PUTER_TOKEN;
const appUid = process.env.PUTER_APP_UID;
const origin = process.env.PUTER_API_ORIGIN || 'https://api.puter.com';
const replace = process.argv.includes('--replace');
if (!token) fail('PUTER_TOKEN is required (a token for the account that owns the Trips app).');
if (!appUid) fail('PUTER_APP_UID is required (the Trips app uid).');

const source = readSource();
const hash = createHash('sha256').update(source, 'utf8').digest('hex');
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const existing = await published(origin, headers, appUid);
if (existing?.hash === hash && !replace) {
  console.log(`publish-notify: ${HANDLER_NAME} is already published (${hash.slice(0, 12)}); pass --replace to publish it again.`);
  process.exit(0);
}

const body = { appUid, name: HANDLER_NAME, source };
if (replace) body.replace = true;
else if (existing?.hash) body.ifHash = existing.hash;
const response = await fetch(`${origin}/events/handlers/publish`, { method: 'POST', headers, body: JSON.stringify(body) });
const data = await response.json().catch(() => null);
if (!response.ok) fail(`publish failed (${response.status}): ${data?.message || data?.error || response.statusText}${data?.code ? ` [${data.code}]` : ''}`);
console.log(`publish-notify: published ${HANDLER_NAME} (${data?.hash || hash}); outcome ${data?.outcome ?? 'unknown'}, resumed ${data?.resumed ?? 'unknown'}.`);
