#!/usr/bin/env node
/**
 * Publishes the new-mail and snooze handlers under the
 * app, as its owner. See README, "Publishing the notification handler".
 *
 *   PUTER_TOKEN=<token> PUTER_APP_UID=<app uid> npm run publish:notify-handler
 *   optional: PUTER_API_ORIGIN (default https://api.puter.com), --replace
 *
 * Plain Node against the Events REST API, as `puter.events.handlers` calls it:
 *   GET  {origin}/events/handlers/list?appUid=<uid> -> { handlers: [{ name, hash }] }
 *   POST {origin}/events/handlers/publish { appUid, name, source, ifHash?, replace? }
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { NOTIFY_HANDLER } from '../src/lib/notify.js';
import { SNOOZE_HANDLER } from '../src/lib/snooze.js';

const MAX_SOURCE_BYTES = 64 * 1024;
const HANDLERS = [
  [NOTIFY_HANDLER, '../src/workers/notify-handler.js'],
  [SNOOZE_HANDLER, '../src/workers/snooze-handler.js'],
];

const fail = (message) => {
  console.error(`publish-notify-handler: ${message}`);
  process.exit(1);
};

function readSource(path) {
  const source = readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > MAX_SOURCE_BYTES) fail(`the handler is ${bytes} bytes, over the ${MAX_SOURCE_BYTES}-byte limit`);
  // The server wraps the source as `register(name, (\n<source>\n))`, so it
  // has to be exactly one function expression.
  try {
    if (typeof new Function(`return (\n${source}\n)`)() !== 'function') throw new Error('not a function');
  } catch (error) {
    fail(`the handler is not a single function expression: ${error.message}`);
  }
  return source;
}

async function main() {
  const token = process.env.PUTER_TOKEN;
  const appUid = process.env.PUTER_APP_UID;
  const origin = process.env.PUTER_API_ORIGIN || 'https://api.puter.com';
  const replace = process.argv.includes('--replace');
  if (!token) fail('PUTER_TOKEN is required: a token for the account that owns the app.');
  if (!appUid) fail('PUTER_APP_UID is required: the uid of the app to publish under.');

  const sources = HANDLERS.map(([name, path]) => ({ name, source: readSource(path) }));
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const listed = await fetch(`${origin}/events/handlers/list?appUid=${encodeURIComponent(appUid)}`, { headers });
  if (!listed.ok) fail(`could not list handlers (${listed.status}).`);
  const handlers = (await listed.json()).handlers ?? [];
  for (const { name, source } of sources) {
    const hash = createHash('sha256').update(source, 'utf8').digest('hex');
    const existing = handlers.find((handler) => handler.name === name);
    if (existing?.hash === hash) {
      console.log(`publish-notify-handler: ${name} is already published (${hash.slice(0, 12)}).`);
      continue;
    }
    const body = { appUid, name, source };
    // Says which version this replaces, so a publish made since is not overwritten.
    if (existing?.hash && !replace) body.ifHash = existing.hash;
    if (replace) body.replace = true;
    const res = await fetch(`${origin}/events/handlers/publish`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const code = data?.code ? ` [${data.code}]` : '';
      fail(`publish failed (${res.status}): ${data?.message || data?.error || res.statusText}${code}`);
    }
    console.log(`publish-notify-handler: ${data?.outcome ?? 'published'} ${name} (${(data?.hash ?? hash).slice(0, 12)}), `
      + `${data?.resumed ?? 0} suspended subscription(s) resumed.`);
  }
}

main().catch((error) => fail(error?.message ?? String(error)));
