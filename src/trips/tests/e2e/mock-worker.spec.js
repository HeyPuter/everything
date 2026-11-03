import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { createTestBridgeHost } from '../../dev/fake-puter/bridge-host.js';
import { attachFakePuterContext } from '../../dev/fake-puter/bridge-playwright.js';
import { registerMockWorkers } from '../../dev/mock-worker.js';

test('mock.html deploys each owner\'s worker from the built bundle through the real deployer', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'Protocol flow without UI; one project is enough.');
  for (const as of ['alice', 'bob']) {
    await page.goto(`/mock.html?as=${as}`);
    await expect(page.locator('html')).toHaveAttribute('data-worker', 'ready');
    const result = await page.evaluate(async () => {
      const before = await puter.workers.list();
      const ref = await trips.createTrip({ title: 'Lisbon' });
      const health = await (await puter.workers.exec(`https://${ref.w}.puter.work/health`, { headers: { 'x-puter-no-auth': '1' } })).json();
      const second = await trips.createTrip({ title: 'Porto' });
      return {
        before, ref, second, health,
        after: (await puter.workers.list()).map((item) => item.name),
        banner: (await (await fetch('./worker/trips-worker.js')).text()).split('\n')[0],
        record: await puter.kv.get('me:worker'),
        spaces: (await puter.kv.get('me:spaces')).map((entry) => [entry.ref.s, entry.role, entry.title]),
        listed: await trips.call(ref, 'space.list'),
        uuid: await trips.uuid(),
      };
    });
    const [, build, builtAt, protocol] = /build=([0-9a-z]+) at=(\d+) protocol=(\d+)/.exec(result.banner);
    expect(result.before).toEqual([]);
    expect(result.ref.w).toMatch(/^trips-[a-z0-9]{10}$/);
    expect(result.after).toEqual([result.ref.w]);
    expect(result.second.w).toBe(result.ref.w);
    expect(result.health).toEqual({ ok: true, build, builtAt: Number(builtAt), protocol: Number(protocol) });
    expect(result.record).toMatchObject({ name: result.ref.w, build, builtAt: Number(builtAt) });
    expect(result.spaces).toEqual([[result.ref.s, 'owner', 'Lisbon'], [result.second.s, 'owner', 'Porto']]);
    expect(result.listed.spaces.map((item) => item.id).sort()).toEqual([result.ref.s, result.second.s].sort());
    expect(result.uuid).toBe(`00000000-0000-4000-8000-00000000000${as === 'alice' ? 1 : 2}`);
  }
});

test('bridge fixtures register the bundle on the shared Node world', async ({ browser, baseURL }, testInfo) => {
  const alice = { uuid: '00000000-0000-4000-8000-000000000001', username: 'alice' };
  const world = createFakePuter({ users: [alice] });
  const source = readFileSync(new URL('../../dist-mock/worker/trips-worker.js', import.meta.url), 'utf8');
  const { names, build } = await registerMockWorkers(world, [alice], source);
  const host = createTestBridgeHost(world);
  const { colorScheme, viewport } = testInfo.project.use;
  const context = await browser.newContext({ colorScheme, viewport });
  try {
    await attachFakePuterContext(host, context, { as: 'alice' });
    const page = await context.newPage();
    await page.goto(`${baseURL}/mock.html`);
    await expect(page.locator('html')).toHaveAttribute('data-runtime', 'mock-bridge');
    const response = await page.evaluate(async (name) => (await puter.workers.exec(`https://${name}.puter.work/health`, { headers: { 'x-puter-no-auth': '1' } })).json(), names[alice.uuid]);
    expect(response).toMatchObject({ ok: true, build, protocol: 1 });
  } finally { await context.close(); await host.close(); }
});
