// Worker costs on the big-trip fixture (architecture §15, §18): KV and FS operations per action from the fake
// runtime's counters, wall time per request in-process, and snapshot size and memory.
// Run: node tools/perf/worker.mjs [--json]
import { createHarness, WORKER } from '../../tests/worker/harness.js';
import { loadLargeTrip } from '../../dev/fixtures/harness.js';
import { FIXTURE_MEMBERS } from '../../dev/fixtures/large-trip.js';
import { gunzip, rebuild } from '../../worker/engine/snapshot.js';
import { createCredentialManager } from '../../src/lib/cred.js';
import { createWorkerClient } from '../../src/lib/api.js';
import { memoryDb } from '../../tests/worker/harness.js';
import { webcrypto } from 'node:crypto';
import { kb, median, ms, printTable, timed } from './report.mjs';

const OWNER = FIXTURE_MEMBERS[0].uuid;
const h = await createHarness({ shareHandles: true, onlyIfAbsent: true });
const seedStart = performance.now();
const { space, fixture, callers, clients } = await loadLargeTrip(h);
const seedMs = performance.now() - seedStart;
const w = h.workers[0];
const bob = (op, input = {}) => callers.bob(op, { space, ...input });
const alice = (op, input = {}) => callers.alice(op, { space, ...input });
let opSeq = 0;
const opId = () => `perf${String(++opSeq).padStart(12, '0')}`;

const ownerCalls = () => h.world.counters().byUser[OWNER] ?? { calls: {} };
function kvSummary(bucket) {
  const calls = Object.entries(bucket.calls ?? {});
  const kv = calls.filter(([m]) => m.startsWith('kv.') && !['kv.share', 'kv.unshare'].includes(m)).reduce((n, [, c]) => n + c, 0);
  const fs = calls.filter(([m]) => m.startsWith('fs.')).reduce((n, [, c]) => n + c, 0);
  const detail = calls.filter(([m]) => m.startsWith('kv.') || m.startsWith('fs.')).map(([m, c]) => `${m.replace(/^kv\.|^fs\./, (p) => (p === 'fs.' ? 'fs.' : ''))}×${c}`).join(' ');
  return { kv, fs, detail };
}
/** Owner ops during the request, as the budget tests count them; `waitUntil` work after it is `background`. */
async function measure(fn) {
  h.world.resetCounters();
  const start = performance.now();
  const result = await fn();
  const elapsed = performance.now() - start;
  const inline = kvSummary(ownerCalls());
  await h.settle();
  return { ...inline, background: kvSummary(ownerCalls()).kv - inline.kv, elapsed, result };
}

// A request that does no space work: its time is the signing, routing and fake-runtime overhead to subtract.
const baseline = await timed(() => callers.bob('hello'), { runs: 20, warm: 3 });
const cpu = (elapsed) => Math.max(0, elapsed - baseline);

const placeIds = fixture.ops.filter((op) => op.t === 'place').map((op) => op.id);
const dayIds = fixture.ops.filter((op) => op.t === 'day').map((op) => op.id);
// Warm the member cache the way the sync engine does (it pulls right before a flush).
await bob('sync', { since: 0 });

const rows = [];
const commitBudget = (n, creates) => 1 + 1 + 1 + n + 1 + 1 + (creates ? 1 : 0);
async function commitRow(label, ops, creates) {
  const samples = [];
  let last;
  for (let i = 0; i < 3; i++) {
    h.advance(1500);
    await bob('sync', { since: 0 }).catch(() => {});
    last = await measure(() => bob('commit', { ops: ops(i) }));
    samples.push(last.elapsed);
  }
  const budget = commitBudget(ops(0).length, creates);
  rows.push({ area: 'Worker', metric: `${label}: owner KV ops`, budget: `≤${budget}`, value: `${last.kv} (${last.detail})`, ok: last.kv <= budget });
  rows.push({ area: 'Worker', metric: `${label}: worker time`, budget: '—', value: ms(cpu(median(samples))) });
}
await commitRow('Commit, 1 patch', (i) => [{ opId: opId(), t: 'place', id: placeIds[i], set: { notes: `n${i}` } }], false);
await commitRow('Commit, 10 patches', (i) => placeIds.slice(10 + i * 10, 20 + i * 10).map((id) => ({ opId: opId(), t: 'place', id, set: { notes: `m${i}` } })), false);
await commitRow('Commit, 50 creates', () => Array.from({ length: 50 }, (_, n) => ({ opId: opId(), t: 'visit', id: `perfv${String(opSeq).padStart(7, '0')}${String(n).padStart(4, '0')}`, put: { dayId: dayIds[n % dayIds.length], placeId: placeIds[n], order: 'z' } })), true);
await commitRow('Commit, 200 creates', () => Array.from({ length: 200 }, (_, n) => ({ opId: opId(), t: 'todo', id: `perft${String(opSeq).padStart(7, '0')}${String(n).padStart(4, '0')}`, put: { name: `T${n}`, order: 'z' } })), true);

// Path C sync with no changes, cold (caches expired) and warm.
h.advance(10_000);
const rev = (await bob('sync', { since: 0 })).rev;
h.advance(10_000);
const cold = await measure(() => bob('sync', { since: rev }));
const warm = await measure(() => bob('sync', { since: rev }));
rows.push({ area: 'Worker', metric: 'Path C sync, no changes: owner KV ops (cold / warm)', budget: '≤2 / 0', value: `${cold.kv} / ${warm.kv}`, ok: cold.kv <= 2 && warm.kv === 0 });

// 100 single-op commits, then one path C sync over them.
for (let i = 0; i < 100; i++) { await alice('commit', { ops: [{ opId: opId(), t: 'place', id: placeIds[200 + i], set: { notes: `s${i}` } }] }); h.advance(50); }
h.advance(10_000);
const hundred = await measure(() => bob('sync', { since: rev }));
const changes = hundred.result.changes.length;
rows.push({ area: 'Worker', metric: `Path C sync, ${changes} changes: owner KV ops`, budget: `≤${2 + Math.ceil(changes / 100)}`, value: `${hundred.kv} (${hundred.detail})`, ok: hundred.kv <= 2 + Math.ceil(changes / 100) });
rows.push({ area: 'Worker', metric: `Path C sync, ${changes} changes: worker time`, budget: '—', value: ms(cpu(hundred.elapsed)) });

// Forced snapshot rebuild over the whole fixture.
const entityCount = Object.keys(h.kv()).filter((key) => key.startsWith(`shared:${space}:e:`)).length;
const rebuilt = await measure(() => rebuild(w, space, 'trip', { force: true }));
const json = await gunzip(w.snapshots.get(space).bytes);
const lists = h.world.counters().byUser[OWNER]?.calls['kv.list'] ?? 0;
const fsWrites = h.world.counters().byUser[OWNER]?.calls['fs.write'] ?? 0;
const pagesBudget = Math.ceil(entityCount / 1000) + 1;
rows.push({ area: 'Worker', metric: `Snapshot rebuild, ${entityCount} entities: list pages + FS writes`, budget: `≤${pagesBudget} pages (incl. chat) + 1 write`, value: `${lists} + ${fsWrites}`, ok: lists <= pagesBudget && fsWrites === 1 });
rows.push({ area: 'Worker', metric: 'Snapshot rebuild: worker time', budget: '—', value: ms(rebuilt.elapsed) });
rows.push({ area: 'Worker', metric: 'Snapshot size (gzip)', budget: 'LRU 16 MB', value: kb(rebuilt.result.bytes), ok: rebuilt.result.bytes < 16 * 1024 * 1024 });
rows.push({ area: 'Worker', metric: 'Snapshot JSON held during a rebuild or parse', budget: 'parsed cache 48 MB', value: kb(json.length), ok: json.length * 10 < 48 * 1024 * 1024 });

// Path C snapshot download (cached in the isolate) and the member `open`.
const snap = await measure(() => clients.bob.api.snapshot({ w: WORKER, s: space, k: 'trip' }));
rows.push({ area: 'Worker', metric: 'Snapshot download (cached): owner KV/FS ops', budget: '—', value: `${snap.kv} KV, ${snap.fs} FS` });
h.advance(10_000);
const opened = await measure(() => bob('open'));
rows.push({ area: 'Worker', metric: 'Open (member): owner KV ops', budget: '—', value: `${opened.kv} (${opened.detail})` });

// A seventh person joins the big trip.
const gina = { uuid: '00000000-0000-4000-8000-000000000007', username: 'gina' };
h.world.user(gina);
const ginaPuter = h.world.client(gina.uuid);
const ginaApi = createWorkerClient({ puter: ginaPuter, credentials: await createCredentialManager({ puter: ginaPuter, db: memoryDb(gina.uuid), crypto: webcrypto, now: h.now }) });
const { token } = await alice('invite.create', { role: 'editor' });
h.advance(5000);
// The hosted-space index (`idx`) is cached for 30 s; the §15 join budget assumes a warm isolate.
await callers.alice('heads', { spaces: [space] });
const joined = await measure(() => ginaApi.request(WORKER, JSON.stringify({ op: 'join', space, token })));
const shares = h.world.counters().byUser[OWNER]?.calls['kv.share'] ?? 0;
rows.push({ area: 'Worker', metric: 'Join: owner KV ops + handle mints', budget: '≤10 + 2', value: `${joined.kv} + ${shares} (${joined.detail}; +${joined.background} in waitUntil)`, ok: joined.kv <= 10 && shares <= 2 });

rows.unshift({ area: 'Fixture', metric: 'Seed through the worker (Node)', budget: '—', value: `${ms(seedMs)}, ${fixture.ops.length + fixture.messages.length + fixture.files.length} entities` });
rows.push({ area: 'Worker', metric: 'Request overhead subtracted (hello)', budget: '—', value: ms(baseline) });
printTable('Worker on the big-trip fixture', rows);
