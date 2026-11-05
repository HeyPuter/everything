#!/usr/bin/env node
/**
 * Deploy step for the scheduled-delivery handler (handlers/due.js); see
 * README's "Scheduled delivery". Run by the account that owns the app.
 *
 * Plain Node, zero dependencies: reads the handler source, checks it against
 * the platform's own publish-time constraints, and calls the raw Events API.
 *
 *   PUTER_TOKEN=<token> PUTER_APP_UID=<app uid> npm run publish:handlers
 *   optional: PUTER_API_ORIGIN (default https://api.puter.com), --replace
 *
 * REST contract (backend/controllers/events/EventsController.ts):
 *   - GET  {origin}/events/handlers/list?appUid=<uid>
 *     -> { handlers: [{ name, hash, updatedAt, subscriptions }] }
 *   - POST {origin}/events/handlers/publish, flat body:
 *     { appUid, name, source, ifHash?, replace? }
 *     -> { name, hash, updatedAt, outcome, resumed }
 *   - a non-200 answer carries { message | error, code }.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
// The name the client schedules under.
import { DUE_HANDLER as HANDLER_NAME } from '../src/shared/events.js';

const MAX_SOURCE_BYTES = 64 * 1024;
const HANDLER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../handlers/due.js');

class PublishError extends Error {}

function readSource() {
  let raw;
  try {
    raw = readFileSync(HANDLER_PATH, 'utf8');
  } catch {
    throw new PublishError(
      `could not read ${HANDLER_PATH} — is handlers/due.js there?`,
    );
  }
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes > MAX_SOURCE_BYTES) {
    throw new PublishError(`source is ${bytes} bytes, over the platform's ${MAX_SOURCE_BYTES}-byte handler limit`);
  }
  // The server bakes this string into `__puterEvents.register(name, (\n<source>\n))` —
  // it must be exactly one function expression, nothing else. Same check the
  // platform runs at publish time; failing it here is cheaper than a 400.
  try {
    // eslint-disable-next-line no-new-func
    new Function('return (\n' + raw + '\n)')();
  } catch (err) {
    throw new PublishError(`source is not a single function expression: ${err.message}`);
  }
  return raw;
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function findExistingHash(origin, headers, appUid) {
  try {
    const res = await fetch(`${origin}/events/handlers/list?appUid=${encodeURIComponent(appUid)}`, { headers });
    if (!res.ok) return null; // best-effort — an older/different server just skips the "already published" shortcut
    const data = await res.json().catch(() => null);
    const list = Array.isArray(data && data.handlers) ? data.handlers : [];
    const existing = list.find((h) => h && h.name === HANDLER_NAME);
    return existing || null;
  } catch {
    return null;
  }
}

async function main() {
  const token = process.env.PUTER_TOKEN;
  const appUid = process.env.PUTER_APP_UID;
  const origin = process.env.PUTER_API_ORIGIN || 'https://api.puter.com';
  const replace = process.argv.includes('--replace');

  if (!token) throw new PublishError('PUTER_TOKEN is required (a Puter auth token for the account that owns this app).');
  if (!appUid) throw new PublishError('PUTER_APP_UID is required (the app uid to publish the handler under).');

  const source = readSource();
  const hash = sha256Hex(source);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const existing = await findExistingHash(origin, headers, appUid);
  if (existing && existing.hash === hash && !replace) {
    console.log(`publish-handlers: ${HANDLER_NAME} already published (${hash.slice(0, 12)}…) — nothing to do.`);
    return;
  }
  if (!existing) {
    console.log('publish-handlers: first publish for this app — this stands up a standing events worker for it.');
  }

  const body = { appUid, name: HANDLER_NAME, source };
  // ifHash claims to be updating a specific prior version; only send it when
  // we actually read one, and never alongside a forced --replace.
  if (existing && existing.hash && !replace) body.ifHash = existing.hash;
  if (replace) body.replace = true;

  const res = await fetch(`${origin}/events/handlers/publish`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (data && (data.message || data.error)) || res.statusText;
    const code = data && data.code;
    throw new PublishError(`publish failed (${res.status}): ${message}${code ? ` [${code}]` : ''}`);
  }

  console.log(`publish-handlers: published ${HANDLER_NAME} (${(data && data.hash) || hash}).`);
  if (data) {
    if (data.updatedAt) console.log(`  updatedAt: ${data.updatedAt}`);
    if (data.outcome) console.log(`  outcome: ${data.outcome}`);
    if (data.resumed != null) console.log(`  resumed: ${data.resumed}`);
  }
}

main().catch((err) => {
  console.error(`publish-handlers: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
