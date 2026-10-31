// Client replica costs on the big-trip fixture (architecture §18): path A load, cached open, syncing 100 changes,
// a local edit, and selector costs, with the real store and sync over IndexedDB (fake-indexeddb in Node).
// Run: node tools/perf/store.mjs [--json]
import { indexedDB } from 'fake-indexeddb';
import { createHarness, WORKER } from '../../tests/worker/harness.js';
import { loadLargeTrip } from '../../dev/fixtures/harness.js';
import { FIXTURE_MEMBERS } from '../../dev/fixtures/large-trip.js';
import { openDatabase } from '../../src/lib/idb.js';
import { openSpace } from '../../src/lib/store/index.js';
import { kb, median, ms, printTable, timed } from './report.mjs';

const h = await createHarness({ shareHandles: true });
const { space: sid, fixture, callers, clients } = await loadLargeTrip(h);
const BOB = FIXTURE_MEMBERS[1].uuid;
const ref = { w: WORKER, s: sid, k: 'trip' };
const { handles } = await callers.bob('open', { space: sid });
const puter = h.world.client(BOB);
const rows = [];
const memberCalls = () => h.world.counters().byUser[BOB]?.calls ?? {};
const features = { pathA: true, directFiles: false };
let dbSeq = 0;
const freshDb = () => openDatabase(BOB, { indexedDB, name: `perf-${++dbSeq}` });
const open = (db, options = {}) => openSpace({ ref, db, api: clients.bob.api, puter, personal: null, handles, role: 'editor', features, view: 'plan', setTimer: () => 0, clearTimer: () => {}, ...options });

// Path A initial load into an empty replica.
const loads = [];
let loaded;
for (let i = 0; i < 3; i++) {
  const db = await freshDb();
  h.world.resetCounters();
  const start = performance.now();
  const opened = await open(db);
  loads.push(performance.now() - start);
  if (i < 2) { opened.close(); db.close(); } else loaded = { db, space: opened };
}
const listCalls = memberCalls();
const entities = Object.keys((await loaded.db.get(`space:${WORKER}:${sid}`)).confirmed).length;
const recordBytes = JSON.stringify(await loaded.db.get(`space:${WORKER}:${sid}`)).length;
rows.push({ area: 'Replica', metric: `Path A first load, ${entities} entities`, budget: '—', value: `${ms(median(loads))} (list×${listCalls['kv.list'] ?? 0}, get×${listCalls['kv.get'] ?? 0}, member-paid)` });
rows.push({ area: 'Replica', metric: 'Replica record size (one IndexedDB record)', budget: '—', value: kb(recordBytes) });
loaded.space.close();

// Cached open: the replica is already local (what a trip route waits for before rendering).
const cached = await timed(async () => { const s = await open(loaded.db, { autoStart: false }); s.close(); }, { runs: 5 });
rows.push({ area: 'Replica', metric: 'Cached open (IndexedDB read + view)', budget: '< 300 ms to interactive', value: ms(cached), ok: cached < 300 });

const placeIds = fixture.ops.filter((op) => op.t === 'place').map((op) => op.id);
// Syncing 100 changes another member made while this trip was closed: one catch-up when it opens again.
const syncs = [];
let syncCalls;
for (let round = 0; round < 3; round++) {
  for (let i = 0; i < 100; i++) {
    await callers.alice('commit', { space: sid, ops: [{ opId: `sync${round}${String(i).padStart(11, '0')}`, t: 'place', id: placeIds[300 + i], set: { notes: `r${round}-${i}` } }] });
    h.advance(700);
  }
  await h.settle();
  const reopened = await open(loaded.db, { autoStart: false });
  h.world.resetCounters();
  const start = performance.now();
  await reopened.start();
  syncs.push(performance.now() - start);
  syncCalls = memberCalls();
  reopened.close();
}
rows.push({ area: 'Replica', metric: 'Sync 100 changes (path A catch-up)', budget: '< 300 ms', value: `${ms(median(syncs))} (get×${syncCalls['kv.get'] ?? 0}, member-paid)`, ok: median(syncs) < 300 });

const space = await open(loaded.db);
// One local edit: validate, persist the record, rebuild the view, notify.
const edit = await timed((i) => space.store.apply([space.ops.patch('place', placeIds[i], { set: { notes: `edit ${i}` } })]), { runs: 7 });
rows.push({ area: 'Replica', metric: 'Local edit (apply one patch)', budget: '—', value: ms(edit) });
// A remote record applied on its own (an event while the trip is open).
let eventRev = space.store.rev;
const one = await timed(async (i) => {
  const place = space.get('place', placeIds[500 + i]);
  await space.store.receive([{ rev: ++eventRev, at: Date.now(), by: FIXTURE_MEMBERS[0].uuid, ents: [{ ...place, t: 'place', notes: `event ${i}`, v: `${(Date.now() + i).toString(36).padStart(10, '0')}:000000:0000000000000000`, rev: eventRev }], del: [] }]);
}, { runs: 7 });
rows.push({ area: 'Replica', metric: 'Remote change applied from an event (one record)', budget: '—', value: ms(one) });

// Selectors on the loaded replica.
const select = space.select;
const touch = async (type) => {
  const id = space.select[type].all()[0].id;
  await space.store.apply([space.ops.patch(type, id, { set: { [type === 'exp' ? 'note' : 'notes']: String(Math.random()) } })]);
};
const cold = async (type, fn) => {
  const times = [];
  for (let i = 0; i < 5; i++) { await touch(type); const start = performance.now(); fn(); times.push(performance.now() - start); }
  return median(times);
};
rows.push({ area: 'Selectors', metric: 'place.all() after a place edit (1,000)', budget: '—', value: ms(await cold('place', () => select.place.all())) });
rows.push({ area: 'Selectors', metric: 'place.all() unchanged (cached)', budget: '—', value: ms(await timed(() => select.place.all(), { runs: 20 })) });
rows.push({ area: 'Selectors', metric: 'visit.groupBy(dayId) after a visit edit', budget: '—', value: ms(await cold('visit', () => select.visit.groupBy('dayId'))) });
rows.push({ area: 'Selectors', metric: 'exp.all() after an expense edit (300)', budget: '—', value: ms(await cold('exp', () => select.exp.all())) });
rows.push({ area: 'Selectors', metric: 'place.all() after an unrelated edit', budget: '—', value: ms(await cold('exp', () => select.place.all())) });
rows.push({ area: 'Selectors', metric: 'msg.all() (2,000)', budget: '—', value: ms(await timed(() => select.msg.all(), { runs: 5 })) });
// View models the plan and costs tabs compute from the selectors.
const { timelineOf } = await import('../../src/views/trip/plan/ops.js');
const { computeBalances } = await import('../../src/lib/costs/ledger.js');
rows.push({ area: 'Selectors', metric: 'Plan timeline after a visit edit (60 days, 600 visits, 80 bookings)', budget: '—', value: ms(await cold('visit', () => timelineOf(space))) });
rows.push({ area: 'Selectors', metric: 'Plan timeline unchanged (cached)', budget: '—', value: ms(await timed(() => timelineOf(space), { runs: 20 })) });
rows.push({ area: 'Selectors', metric: 'Cost balances (300 expenses)', budget: '—', value: ms(await timed(() => computeBalances({ expenses: select.exp.all(), settlements: select.settle.all(), tripCurrency: 'EUR' }), { runs: 5 })) });

space.close();
printTable('Client replica on the big-trip fixture', rows);
process.exit(0);
