import { createFakePuter } from './fake-puter/index.js';
import { AI_FAILURES, aiControls, createAiState, createFakeAi } from './fake-puter/ai.js';
import { resetMockAccount } from './mock-reset.js';
import { fetchWorkerSource } from './mock-worker.js';
import { parseBanner } from '../src/lib/deploy.js';
import '../src/styles/components.css';

const params = new URLSearchParams(location.search);
const users = ['alice', 'bob', 'carol'].map((username, index) => ({
  uuid: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  username,
  verified: params.get('files') === 'direct',
}));
const as = users.find((user) => user.username === params.get('as'))?.username ?? 'alice';
// Scripted puter.ai: `ai=off` hides it, `ai=credit|usage|auth|offline|failed` makes every AI call fail that way.
const aiMode = params.get('ai');
const bridge = Boolean(globalThis.__fakePuterBridgeReady);
// `fixture=large` seeds the 60-day, 1,000-place trip (dev/fixtures) owned by alice.
const fixture = !bridge && params.get('fixture') === 'large' ? await import('./fixtures/mock.js') : null;
if (bridge) await globalThis.__fakePuterBridgeReady;
else {
  const world = createFakePuter({
    users: fixture ? [...users, ...fixture.fixtureUsers(params.get('files') === 'direct')] : users,
    // Path A is the default; `state=C` models a platform without KV share handles.
    shareHandles: params.get('state') !== 'C',
    onlyIfAbsent: params.get('cas') === '1',
    regions: params.get('regions') === '2' ? 2 : 1,
    ai: aiMode !== 'off',
  });
  if (params.get('offline') === '1') world.setOffline(as, true);
  globalThis.puter = world.client(as);
  globalThis.__TRIPS_MOCK__ = world;
  globalThis.__TRIPS_AI__ = world.ai;
}
if (bridge && aiMode !== 'off') {
  // The bridge world has no AI; each page gets its own scripted one.
  const state = createAiState();
  globalThis.puter.ai = createFakeAi({ state, readFile: async (path) => (await globalThis.puter.fs.read(path)).text() });
  globalThis.__TRIPS_AI__ = aiControls(state);
}
if (AI_FAILURES.includes(aiMode)) globalThis.__TRIPS_AI__?.fail(aiMode);
let resetFailure;
let resetAfterSignIn = false;
if (params.get('reset') === '1') {
  if (bridge) {
    resetAfterSignIn = true;
    document.documentElement.dataset.reset = 'account-required';
  } else {
    const account = users.find((user) => user.username === as).uuid;
    const result = await resetMockAccount(account);
    document.documentElement.dataset.reset = result.cleared === 2 ? 'ready' : 'blocked';
    if (result.cleared !== 2) resetFailure = result;
  }
}
if (params.get('offline') === '1') {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
  if (bridge) dispatchEvent(new Event('offline'));
}
document.documentElement.dataset.runtime = bridge ? 'mock-bridge' : 'mock';
// Tests wait for `data-worker` and then call `trips`, so the hook is installed first.
globalThis.trips = (await import('./mock-trips.js')).createMockTrips(globalThis.puter);
// Owners deploy their worker on first use through the real deployer (`trips.createTrip`), so only check the bundle here.
try { parseBanner(await fetchWorkerSource()); document.documentElement.dataset.worker = 'ready'; }
catch { document.documentElement.dataset.worker = 'missing'; }
if (fixture && !resetFailure) {
  try {
    globalThis.__TRIPS_FIXTURE__ = await fixture.loadMockFixture(globalThis.__TRIPS_MOCK__);
    document.documentElement.dataset.fixture = 'ready';
  } catch (error) {
    console.error(error);
    document.documentElement.dataset.fixture = 'failed';
  }
}
if (resetFailure) {
  const [{ el }, { button }, { t }] = await Promise.all([
    import('../src/ui/dom.js'), import('../src/ui/bits.js'), import('../src/lib/i18n/index.js'),
  ]);
  document.getElementById('app').replaceChildren(el('main.empty', {},
    el('h1', {}, t('mock.resetTitle')),
    el('p', {}, t(resetFailure.unavailable ? 'app.storageError' : 'mock.resetBlocked')),
    button(t('mock.reload'), { onclick: () => location.reload() }),
  ));
  document.documentElement.dataset.boot = 'ready';
} else {
  const { bootApp } = await import('../src/main.js');
  const options = {};
  if (resetAfterSignIn) {
    const { openDatabase } = await import('../src/lib/idb.js');
    options.openDatabase = async (account) => {
      if (resetAfterSignIn) {
        const result = await resetMockAccount(account);
        document.documentElement.dataset.reset = result.cleared === 2 ? 'ready' : 'blocked';
        if (result.cleared !== 2) throw new Error('mock_reset_blocked');
        resetAfterSignIn = false;
      }
      return openDatabase(account);
    };
  }
  await bootApp(options);
}
