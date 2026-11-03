// Headless Chromium on `mock.html?fixture=large` (architecture §18): cold start, the dashboard, the first and the
// cached trip open, every trip tab, and remote edits while a tab is open.
// A view is measured from navigation until its content shows (a per-view selector) and the DOM has been quiet for
// 300 ms. "Interactive" is when the content showed and no long task (> 50 ms) followed; "blocked" sums long tasks.
// The fixture's worker runs in the page (dev/fake-puter), so seeding and worker work also block this main thread.
// Run: TRIPS_E2E_PORT_BASE=<base> PLAYWRIGHT_BROWSERS_PATH=… node tools/perf/browser.mjs [--phone] [--json]
//   --phone                        390×844 viewport, 4× CPU throttling (a mid phone)
//   --profile=<view>[:msg|place|drag]  CPU profile and trace of a cached open of <view> (a tab, or `dashboard` for
//                                  the boot), of a remote edit while it is open, or of a visit drag on the plan tab;
//                                  read them with profile-summary.mjs and long-tasks.mjs. Builds without minifying.
// Serves a fresh mock build on TRIPS_E2E_PORT_BASE + 6. On macOS Chromium uses the GPU (Metal); elsewhere WebGL is
// software and the map dominates frame commits. TRIPS_PERF_CHROMIUM_ARGS overrides the launch flags;
// TRIPS_PERF_CONSOLE=<text> prints the page's console lines that contain <text>.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import { chromium } from '@playwright/test';
import { E2E_PORTS } from '../e2e-ports.mjs';
import { args, median, ms, printTable } from './report.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const phone = args.has('--phone');
const [profileView, profileEvent] = ([...args].find((arg) => arg.startsWith('--profile='))?.slice(10) ?? '').split(':');
const READY = {
  dashboard: '.trip-card', plan: '.plan-day', bookings: '.bookings-group', costs: '.costs-entry', lists: '.list-group',
  files: '.file-row', collab: '.chat-msg', members: '.members-section', settings: '.trip-settings-section',
};
const TABS = ['plan', 'bookings', 'costs', 'lists', 'files', 'collab', 'members', 'settings'];
const output = await mkdtemp(join(tmpdir(), 'trips-perf-'));
let server;
let browser;
try {
  await build({ root, configFile: join(root, 'vite.worker.config.js'), logLevel: 'error' });
  await build({ root, configFile: join(root, 'vite.config.js'), mode: 'mock', logLevel: 'error', build: { outDir: output, emptyOutDir: true, minify: !profileView } });
  server = await preview({ root, configFile: join(root, 'vite.config.js'), mode: 'mock', logLevel: 'error', build: { outDir: output }, preview: { host: '127.0.0.1', port: E2E_PORTS.perf, strictPort: true } });
  const gpu = process.platform === 'darwin' ? '--use-angle=metal --ignore-gpu-blocklist --enable-gpu' : '';
  browser = await chromium.launch({ args: (process.env.TRIPS_PERF_CHROMIUM_ARGS ?? gpu).split(' ').filter(Boolean) });
  const rows = await run(`http://127.0.0.1:${E2E_PORTS.perf}`);
  if (rows.length) printTable(`Browser (${phone ? 'mid phone: 390×844, 4× CPU' : 'desktop: 1280×800'}) on mock.html?fixture=large`, rows);
} finally {
  await browser?.close();
  await new Promise((resolve) => (server?.httpServer ? server.httpServer.close(resolve) : resolve()));
  await rm(output, { recursive: true, force: true });
}

async function newPage(context) {
  const page = await context.newPage();
  if (phone) await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 4 });
  if (process.env.TRIPS_PERF_CONSOLE) page.on('console', (message) => { if (message.text().includes(process.env.TRIPS_PERF_CONSOLE)) console.log(message.text()); });
  await page.addInitScript(() => {
    const state = { last: 0, longTasks: [] };
    globalThis.__perf = state;
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) state.longTasks.push([entry.startTime, entry.duration]); }).observe({ type: 'longtask', buffered: true });
    const watch = () => new MutationObserver(() => { state.last = performance.now(); }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    if (document.documentElement) watch(); else addEventListener('DOMContentLoaded', watch);
    /**
     * Waits for `ready` (a selector) to match, then for `quiet` ms without DOM changes. Resolves
     * `{shown, rendered, interactive, blocked, nodes}` in ms from `start`; without `ready`, no change at all also counts.
     */
    state.settle = (start, { ready = null, quiet = 300, timeout = 30_000 } = {}) => new Promise((resolve) => {
      let shown = ready ? null : start;
      const check = () => {
        const now = performance.now();
        if (shown === null && document.querySelector(ready)) shown = now;
        const settled = shown !== null && now - Math.max(state.last, shown) >= quiet;
        if (settled || now - start > timeout) {
          const end = Math.max(state.last, shown ?? now);
          const tasks = state.longTasks.filter(([at]) => at >= start && at <= end);
          const busy = Math.max(shown ?? now, ...tasks.map(([at, duration]) => at + duration));
          resolve({ shown: (shown ?? now) - start, rendered: end - start, interactive: busy - start, blocked: tasks.reduce((sum, [, duration]) => sum + duration, 0),
            nodes: document.getElementsByTagName('*').length, timedOut: !settled });
        } else requestAnimationFrame(() => setTimeout(check, 10));
      };
      check();
    });
    state.go = (hash, ready) => { const start = performance.now(); location.hash = hash; return state.settle(start, { ready }); };
    /** `count` commits by another member, one op each: chat messages (`msg`) or place edits (`place`). */
    state.remote = async (type, count = 1) => {
      const loaded = globalThis.__TRIPS_FIXTURE__;
      const places = loaded.fixture.ops.filter((op) => op.t === 'place');
      const start = performance.now();
      for (let i = 0; i < count; i++) {
        const n = (state.seq = (state.seq ?? 0) + 1);
        const id = `perf${String(n).padStart(12, '0')}`;
        const ops = type === 'msg' ? [{ opId: id, t: 'msg', id, put: { text: `Remote message ${n}` } }] : [{ opId: id, t: 'place', id: places[n % places.length].id, set: { notes: `Remote edit ${n}` } }];
        await loaded.callers.bob('commit', { space: loaded.ref.s, ops });
      }
      return state.settle(start, { quiet: 500 });
    };
  });
  return page;
}

function go(page, hash, view) { return page.evaluate(([target, ready]) => globalThis.__perf.go(target, ready), [hash, READY[view] ?? null]); }
function summary(result) {
  return `${ms(result.interactive)} interactive, content ${ms(result.shown)}, settled ${ms(result.rendered)} (${ms(result.blocked)} blocked, ${result.nodes} nodes)${result.timedOut ? ', timed out' : ''}`;
}

/** Drags a visit by its grip down the day list for about a second, then cancels with Escape; frame times from rAF. */
async function dragVisit(page, base) {
  await go(page, `${base}/plan`, 'plan');
  const grip = await page.evaluate(() => {
    const node = document.querySelector('.plan-row[data-movable] [data-drag-handle]');
    node?.scrollIntoView({ block: 'center' });
    const box = node?.getBoundingClientRect();
    return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
  });
  if (!grip) return null;
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.evaluate(() => {
    const times = [];
    globalThis.__perf.frames = { times, on: true };
    const loop = (at) => { times.push(at); if (globalThis.__perf.frames.on) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  });
  for (let i = 1; i <= 60; i++) await page.mouse.move(grip.x, grip.y + i * 6);
  const frames = await page.evaluate(() => { globalThis.__perf.frames.on = false; return globalThis.__perf.frames.times; });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  const gaps = frames.slice(1).map((at, index) => at - frames[index]).sort((a, b) => a - b);
  return { fps: gaps.length ? (gaps.length / (frames.at(-1) - frames[0])) * 1000 : 0, worst: gaps.at(-1) ?? 0, p95: gaps[Math.floor(gaps.length * 0.95)] ?? 0 };
}

/** Opens the fixture page; `before(page)` runs once the page exists, before navigation. */
async function openFixture(context, origin, before) {
  const page = await newPage(context);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await before?.(page);
  await page.goto(`${origin}/mock.html?as=alice&reset=1&fixture=large`);
  await page.waitForFunction(() => ['ready', 'failed'].includes(document.documentElement.dataset.fixture), null, { timeout: 120_000 });
  const fixture = await page.evaluate(() => ({ state: document.documentElement.dataset.fixture, ref: globalThis.__TRIPS_FIXTURE__?.ref, ms: globalThis.__TRIPS_FIXTURE__?.ms }));
  if (fixture.state !== 'ready') throw new Error(`fixture_failed: ${errors.join(' | ')}`);
  const dashboard = await page.evaluate((ready) => globalThis.__perf.settle(performance.now(), { ready }), READY.dashboard);
  return { page, errors, fixture, dashboard, base: `#/t/${fixture.ref.w}/${fixture.ref.s}` };
}

/** CPU profile plus a main-thread trace of `action()`, written to the temp dir. */
async function record(context, page, name, action) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'toplevel', 'v8', 'IndexedDB'] });
  await cdp.send('Profiler.start');
  const result = await action();
  const { profile } = await cdp.send('Profiler.stop');
  const trace = await browser.stopTracing();
  const files = [join(tmpdir(), `trips-${name}.cpuprofile`), join(tmpdir(), `trips-${name}.trace.json`)];
  await writeFile(files[0], JSON.stringify(profile));
  await writeFile(files[1], trace);
  console.log(`${name}: ${result ? summary(result) : ''}\n${files.join('\n')}`);
}

async function run(origin) {
  const rows = [];
  const viewport = phone ? { width: 390, height: 844 } : { width: 1280, height: 800 };
  const context = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone });

  if (profileView === 'dashboard') {
    let recording;
    await openFixture(context, origin, (page) => {
      recording = record(context, page, 'dashboard', () => page.waitForFunction(() => document.documentElement.dataset.fixture === 'ready', null, { timeout: 120_000 })
        .then(() => page.evaluate((ready) => globalThis.__perf.settle(performance.now(), { ready }), READY.dashboard)));
    });
    await recording;
    await context.close();
    return [];
  }
  if (profileView) {
    const { page, base } = await openFixture(context, origin);
    await go(page, `${base}/${profileView}`, profileView);
    if (!profileEvent) await go(page, '#/', 'dashboard');
    const action = profileEvent === 'drag' ? () => dragVisit(page, base).then(() => null)
      : profileEvent ? () => page.evaluate((type) => globalThis.__perf.remote(type), profileEvent) : () => go(page, `${base}/${profileView}`, profileView);
    await record(context, page, `${profileView}${profileEvent ? `-${profileEvent}` : ''}`, action);
    await context.close();
    return [];
  }

  const starts = [];
  for (let i = 0; i < 3; i++) {
    const page = await newPage(context);
    await page.goto(`${origin}/mock.html?as=bob&reset=1`);
    await page.waitForFunction(() => document.documentElement.dataset.boot === 'ready');
    starts.push((await page.evaluate(() => globalThis.__perf.settle(0))).rendered);
    await page.close();
  }
  rows.push({ area: 'Startup', metric: 'Cold start, empty account (navigation → settled dashboard)', budget: '< 1.5 s', value: ms(median(starts)), ok: median(starts) < 1500 });

  const { page, errors, fixture, dashboard, base } = await openFixture(context, origin);
  rows.push({ area: 'Fixture', metric: 'Seed in the page (60 days, 1,000 places, 2,000 messages)', budget: '—', value: ms(fixture.ms) });
  rows.push({ area: 'Startup', metric: 'Dashboard right after seeding, trip not cached', budget: '—', value: summary(dashboard) });
  rows.push({ area: 'Trip', metric: 'First open, plan tab (loads the replica from KV)', budget: '—', value: summary(await go(page, `${base}/plan`, 'plan')) });
  for (const tab of TABS.slice(1)) rows.push({ area: 'Tabs', metric: `${tab} tab`, budget: '—', value: summary(await go(page, `${base}/${tab}`, tab)) });
  rows.push({ area: 'Startup', metric: 'Dashboard with the big trip cached', budget: '—', value: summary(await go(page, '#/', 'dashboard')) });
  const reopen = [];
  for (let i = 0; i < 3; i++) { reopen.push(await go(page, `${base}/plan`, 'plan')); await go(page, '#/', 'dashboard'); }
  const cached = median(reopen.map((item) => item.interactive));
  rows.push({ area: 'Trip', metric: 'Cached open, plan tab (to interactive)', budget: '< 300 ms', ok: cached < 300,
    value: `${ms(cached)} (content ${ms(median(reopen.map((item) => item.shown)))}, settled ${ms(median(reopen.map((item) => item.rendered)))}, ${ms(median(reopen.map((item) => item.blocked)))} blocked)` });

  for (const tab of ['plan', 'collab']) {
    await go(page, `${base}/${tab}`, tab);
    for (const kind of ['msg', 'place']) {
      const results = [];
      for (let i = 0; i < 3; i++) results.push(await page.evaluate((type) => globalThis.__perf.remote(type), kind));
      rows.push({ area: 'Events', metric: `Remote ${kind === 'msg' ? 'chat message' : 'place edit'} on the ${tab} tab`, budget: '—', value: `${ms(median(results.map((item) => item.blocked)))} blocked` });
    }
  }
  await go(page, `${base}/plan`, 'plan');
  const burst = await page.evaluate(() => globalThis.__perf.remote('place', 100));
  rows.push({ area: 'Events', metric: '100 remote place edits, one commit each, on the plan tab', budget: '—', value: `${ms(burst.blocked)} blocked over ${ms(burst.rendered)}` });
  // A local edit through the store on the big replica (validate, persist the record, rebuild the view).
  const edit = await page.evaluate(async (ref) => {
    const trips = globalThis.trips;
    await trips.open(ref, { path: 'C' });
    const place = globalThis.__TRIPS_FIXTURE__.fixture.ops.find((op) => op.t === 'place').id;
    const times = [];
    for (let i = 0; i < 7; i++) { const start = performance.now(); await trips.patch(ref, 'place', place, { notes: `Local edit ${i}` }); times.push(performance.now() - start); }
    trips.close(ref);
    return times.sort((a, b) => a - b)[3];
  }, fixture.ref);
  rows.push({ area: 'Replica', metric: 'Local edit (apply one patch to the 1.6 MB replica)', budget: '—', value: ms(edit) });

  const drag = await dragVisit(page, base);
  if (drag) rows.push({ area: 'Plan', metric: 'Dragging a visit (60 pointer moves)', budget: '60 fps', value: `${Math.round(drag.fps)} fps, worst frame ${ms(drag.worst)}, p95 ${ms(drag.p95)}` });
  if (errors.length) rows.push({ area: 'Errors', metric: 'Page errors', budget: '0', value: errors.slice(0, 3).join(' | '), ok: false });
  await context.close();
  return rows;
}
