import { expect, test } from '@playwright/test';
import { canvasCenter, openApp } from './helpers';

test('damaged saved preferences still allow sketching with valid units', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('parametric:settings', JSON.stringify({
    defaultUnits: 'unknown', showRelations: 'false', showPlanes: true, quality: 2,
  })));
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.getByRole('treeitem', { name: 'Front Plane' }).click();
  await page.getByRole('tab', { name: 'Sketch' }).click();
  await page.locator('[data-cmd="sketch"]').first().click();
  await expect(page.locator('.view-label')).toHaveText('Front');
  const { x, y } = await canvasCenter(page);
  await page.locator('[data-cmd="tool:rectangle"]').click();
  await page.mouse.click(x - 100, y + 60);
  await page.mouse.click(x + 100, y - 60);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
  await expect(page.locator('.statusbar')).toContainText('MMGS');
  expect(await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.settings))
    .toMatchObject({ defaultUnits: 'MMGS', showRelations: true, showPlanes: true, quality: 2 });
});

type SettingsWindow = {
  __parametric: import('../../src/app/app').App;
  releaseSettings: () => void;
  settingsRequested: boolean;
};

for (const fails of [false, true]) test(`later preference changes remain saved when an earlier account write ${fails ? 'fails' : 'is slow'}`, async ({ page }) => {
  await page.route(/js\.puter\.com/, (r) => r.fulfill({ body: '', contentType: 'text/javascript' }));
  await page.addInitScript((fails) => {
    const w = window as unknown as {
      puter: unknown; releaseWrite: () => void; writes: string[]; writeStarted: boolean; accountPreferences: unknown;
    };
    const gate = new Promise<void>((resolve) => { w.releaseWrite = resolve; });
    w.writes = [];
    w.writeStarted = false;
    let calls = 0;
    w.puter = {
      env: 'web',
      auth: { isSignedIn: () => true, getUser: async () => ({ username: 'tester', uuid: 'u1' }) },
      fs: { readdir: async () => [], mkdir: async () => ({}) },
      kv: {
        get: async () => w.accountPreferences,
        set: async (_key: string, value: { defaultUnits: string }) => {
          const snapshot = structuredClone(value);
          // Delay applying the first write, not just returning its response.
          if (++calls === 1) {
            w.writeStarted = true;
            await gate;
            if (fails) { w.writes.push('failed'); throw new Error('Offline'); }
          }
          w.accountPreferences = snapshot;
          w.writes.push(snapshot.defaultUnits);
          return true;
        },
      },
    };
  }, fails);
  const errors = await openApp(page);
  const units = page.getByLabel('Units for the new part', { exact: true });
  await units.selectOption('IPS');
  await page.waitForFunction(() => (window as unknown as { writeStarted: boolean }).writeStarted);
  await units.selectOption('MKS');
  await page.evaluate(() => (window as unknown as { releaseWrite: () => void }).releaseWrite());
  await page.waitForFunction(() => (window as unknown as { writes: string[] }).writes.length === 2);
  const saved = await page.evaluate(() => ({
    account: (window as unknown as { accountPreferences: unknown }).accountPreferences,
    browser: JSON.parse(localStorage.getItem('parametric:settings')!),
  }));
  expect(saved.browser.defaultUnits).toBe('MKS');
  expect(saved.account).toEqual(saved.browser);
  await page.evaluate(async () => (window as unknown as SettingsWindow).__parametric.loadRemoteSettings());
  await expect(units).toHaveValue('MKS');
  expect(errors).toEqual([]);
});

async function delayedAccountSettings(page: import('@playwright/test').Page) {
  await page.route(/js\.puter\.com/, (r) => r.fulfill({ body: '', contentType: 'text/javascript' }));
  await page.addInitScript(() => {
    const w = window as unknown as SettingsWindow & { puter: unknown };
    const gate = new Promise<void>((resolve) => { w.releaseSettings = resolve; });
    w.puter = {
      env: 'web',
      auth: { isSignedIn: () => true, getUser: async () => ({ username: 'tester', uuid: 'u1' }) },
      fs: { readdir: async () => [], mkdir: async () => ({}) },
      kv: { get: async () => { w.settingsRequested = true; await gate; return { defaultUnits: 'CGS', quality: 0, invertZoom: true }; }, set: async () => true },
    };
  });
}

for (const timing of ['before', 'after', 'back to original'] as const) test(`Options edits ${timing} a delayed account response remain applied and saved`, async ({ page }) => {
  await delayedAccountSettings(page);
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.waitForFunction(() => (window as unknown as SettingsWindow).settingsRequested);
  await page.evaluate(() => (window as unknown as SettingsWindow).__parametric.commands.run('options'));
  const dialog = page.getByRole('dialog', { name: 'Options' });
  const units = dialog.getByLabel('Default units for new parts');
  if (timing !== 'after') await units.selectOption('IPS');
  if (timing === 'back to original') await units.selectOption('MMGS');
  await page.evaluate(() => (window as unknown as SettingsWindow).releaseSettings());
  await expect.poll(() => page.evaluate(() => (window as unknown as SettingsWindow).__parametric.settings.quality)).toBe(0);
  await expect(dialog.getByLabel('Image quality')).toHaveValue('0');
  await expect(dialog.getByLabel('Reverse mouse wheel zoom direction')).toBeChecked();
  if (timing === 'after') await units.selectOption('IPS');
  await dialog.getByRole('button', { name: 'Done' }).click();
  const saved = await page.evaluate(() => ({
    active: (window as unknown as SettingsWindow).__parametric.settings,
    persisted: JSON.parse(localStorage.getItem('parametric:settings')!),
  }));
  expect(saved.active).toMatchObject({ defaultUnits: timing === 'back to original' ? 'MMGS' : 'IPS', quality: 0, invertZoom: true });
  expect(saved.persisted).toEqual(saved.active);
  expect(errors).toEqual([]);
});

test('an earlier account-settings response cannot replace a later load', async ({ page }) => {
  await delayedAccountSettings(page);
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.waitForFunction(() => (window as unknown as SettingsWindow).settingsRequested);
  await page.evaluate(async () => {
    const w = window as unknown as SettingsWindow & { puter: { kv: { get: () => Promise<unknown> } } };
    w.puter.kv.get = async () => ({ defaultUnits: 'IPS', quality: 2, invertZoom: false });
    await w.__parametric.loadRemoteSettings();
    w.releaseSettings();
  });
  expect(await page.evaluate(() => (window as unknown as SettingsWindow).__parametric.settings))
    .toMatchObject({ defaultUnits: 'IPS', quality: 2, invertZoom: false });
  expect(errors).toEqual([]);
});

test('the start screen reflects account units that arrive after it opens', async ({ page }) => {
  await delayedAccountSettings(page);
  const errors = await openApp(page);
  const units = page.getByLabel('Units for the new part', { exact: true });
  await expect(units).toHaveValue('MMGS');
  await page.evaluate(() => (window as unknown as SettingsWindow).releaseSettings());
  await expect(units).toHaveValue('CGS');
  await page.getByRole('button', { name: /New part/ }).click();
  await expect(page.locator('.statusbar')).toContainText('CGS');
  expect(errors).toEqual([]);
});

test('account image quality retessellates the visible body without editing the part', async ({ page }) => {
  await delayedAccountSettings(page);
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  const indexCount = () => page.evaluate(async () => {
    const a = (window as unknown as SettingsWindow).__parametric;
    await a.whenBuilt();
    return (a.renderer as unknown as { modelMesh: { indices: Uint32Array } | null }).modelMesh?.indices.length ?? 0;
  });
  const original = await indexCount();
  expect(original).toBeGreaterThan(0);
  await page.evaluate(() => (window as unknown as SettingsWindow).releaseSettings());
  await expect.poll(() => page.evaluate(() => (window as unknown as SettingsWindow).__parametric.settings.quality)).toBe(0);
  await expect.poll(indexCount).toBeLessThan(original);
  expect(await indexCount()).toBeGreaterThan(0);
  await page.evaluate(() => (window as unknown as SettingsWindow).__parametric.commands.run('options'));
  const options = page.getByRole('dialog', { name: 'Options' });
  await options.getByLabel('Image quality').selectOption('2');
  await expect.poll(indexCount).toBeGreaterThan(original);
  await options.getByRole('button', { name: 'Done' }).click();
  expect(await page.evaluate(() => (window as unknown as SettingsWindow).__parametric.store.dirty)).toBe(false);
  expect(errors).toEqual([]);
});

test('preferences and the theme changed in another tab apply here and are not overwritten by this tab', async ({ context }) => {
  type W = { __parametric: import('../../src/app/app').App };
  const open = async () => {
    const page = await context.newPage();
    const errors = await openApp(page);
    await page.waitForFunction(() => (window as unknown as Partial<W>).__parametric);
    return { page, errors };
  };
  const a = await open(), b = await open();
  await a.page.evaluate(async (url) => {
    (window as unknown as W).__parametric.commands.run('showPlanes');
    (await import(url)).setThemeChoice('dark');
  }, '/src/platform/theme.ts');
  await expect(b.page.locator('html')).toHaveAttribute('data-theme-resolved', 'dark');
  await expect.poll(() => b.page.evaluate(() => (window as unknown as W).__parametric.settings.showPlanes)).toBe(true);
  // A change made here keeps the other tab's change.
  await b.page.evaluate(() => (window as unknown as W).__parametric.commands.run('showOrigin'));
  expect(await b.page.evaluate(() => JSON.parse(localStorage.getItem('parametric:settings')!))).toMatchObject({ showPlanes: true, showOrigin: true });
  expect([...a.errors, ...b.errors]).toEqual([]);
});
