import { openDatabase } from '../../src/lib/idb.js';
import { openSpaceStore } from '../../src/lib/store/space.js';
import { createSyncEngine } from '../../src/lib/sync/index.js';
import { ApiError } from '../../src/lib/api.js';

// Test-only protocol scripting. There is no server, worker engine or Puter SDK.
const accounts = { a: '00000000-0000-4000-8000-000000000001', b: '00000000-0000-4000-8000-000000000002' };
const ref = { w: 'trips-012345abcd', s: '0000000000000001', k: 'trip' };
let db;
let store;
let engine;
let clock = 1_000_000;
let notices = 0;
let rejectNextWrite = false;
let rejectNextRead = false;
let flight;
let flightResult;
const commits = [];
const calls = [];
const states = [];
const errors = [];
const timers = [];
const scripts = { commit: [], sync: [], repair: [], snapshot: [] };
const held = [];
const originalPut = IDBObjectStore.prototype.put;
const originalGet = IDBObjectStore.prototype.get;

// Abort a real Chromium transaction after queuing its write, before completion.
IDBObjectStore.prototype.put = function (...args) {
  const request = originalPut.apply(this, args);
  if (rejectNextWrite && this.name === 'records' && String(args[1]).startsWith('space:')) {
    rejectNextWrite = false;
    this.transaction.abort();
  }
  return request;
};
IDBObjectStore.prototype.get = function (...args) {
  const request = originalGet.apply(this, args);
  if (rejectNextRead && this.name === 'records') {
    rejectNextRead = false;
    const transaction = this.transaction;
    queueMicrotask(() => transaction.abort());
  }
  return request;
};

function respond(step) {
  if (step?.kind === 'error') throw new ApiError(step.status, step.code ?? 'fixture_scripted_error');
  if (step?.kind === 'reply') return structuredClone(step.data);
  throw new ApiError(502, 'fixture_missing_script');
}
const api = {
  async commit(_, body) {
    commits.push(body);
    if (!navigator.onLine) throw new ApiError(0, 'fixture_offline');
    const step = scripts.commit.shift();
    if (step?.kind === 'hold') return new Promise((resolve, reject) => held.push({ resolve, reject }));
    return respond(step ?? { kind: 'error', status: 402, code: 'fixture_unscripted_commit' });
  },
  async call(_, op, input) {
    calls.push({ op, input: structuredClone(input) });
    if (!navigator.onLine) throw new ApiError(0, 'fixture_offline');
    return respond(scripts[op]?.shift());
  },
  async snapshot() {
    calls.push({ op: 'snapshot' });
    return respond(scripts.snapshot.shift());
  },
};
function snapshot() {
  return {
    rev: store.rev, places: store.entities('place'), pending: store.pending,
    conflicts: store.conflicts, batch: store.batch, notices,
    commits: [...commits], calls: structuredClone(calls), states: [...states], errors: [...errors], timers: [...timers],
    flightResult: flightResult && { status: flightResult.status, code: flightResult.error?.code },
  };
}
function render() { document.getElementById('state').textContent = JSON.stringify(snapshot()); }
function dispose() { engine?.stop(); engine = null; store?.close(); db?.close(); }
async function boot({ as = 'a', leaseMs = 1000 } = {}) {
  dispose();
  if (!accounts[as]) throw new Error('fixture_unknown_account');
  clock = 1_000_000; notices = 0; rejectNextWrite = false; rejectNextRead = false;
  commits.length = 0; calls.length = 0; states.length = 0; errors.length = 0; timers.length = 0; held.length = 0;
  for (const queue of Object.values(scripts)) queue.length = 0;
  flight = undefined; flightResult = undefined;
  db = await openDatabase(accounts[as]);
  store = await openSpaceStore({ ref, db, api, now: () => clock, leaseMs });
  store.subscribe(() => { notices++; render(); });
  render();
}
window.clientData = {
  boot, snapshot,
  apply: (ops) => store.apply(ops),
  receive: (changes) => store.receive(changes),
  replace: (value) => store.replace(value),
  refresh: () => store.refresh(),
  failNextWrite() { rejectNextWrite = true; },
  async failRead() {
    rejectNextRead = true;
    try { await db.get(`space:${ref.w}:${ref.s}`); return null; }
    catch (error) { await new Promise(requestAnimationFrame); return { name: error.name, message: error.message }; }
  },
  advance(ms) { if (!Number.isFinite(ms) || ms < 0) throw new Error('fixture_invalid_clock'); clock += ms; },
  script(op, steps) { if (!Object.hasOwn(scripts, op)) throw new Error('fixture_invalid_script'); scripts[op].push(...structuredClone(steps)); },
  async flush() { const result = await store.flush(); return { status: result.status, code: result.error?.code }; },
  beginFlush() { flightResult = undefined; flight = store.flush().then((result) => { flightResult = result; return result; }); },
  async finishFlush() { await flight; return { status: flightResult.status, code: flightResult.error?.code }; },
  release(step) {
    const next = held.shift();
    if (!next) throw new Error('fixture_no_held_commit');
    try { next.resolve(respond(step)); } catch (error) { next.reject(error); }
  },
  async startSync() {
    engine?.stop();
    engine = createSyncEngine({
      store, api, now: () => clock,
      setTimer(_, delay) { timers.push(delay); return timers.length; }, clearTimer() {},
      onState: (state) => states.push(state), onError: (error) => errors.push(error.code ?? error.name),
    });
    await engine.start(); render();
  },
  async sync() { await engine.sync(); render(); },
  stopSync() { engine?.stop(); },
};
await boot({ as: new URL(location.href).searchParams.get('as') ?? 'a' });
document.documentElement.dataset.clientData = 'ready';
window.addEventListener('pagehide', () => { dispose(); IDBObjectStore.prototype.put = originalPut; IDBObjectStore.prototype.get = originalGet; }, { once: true });
