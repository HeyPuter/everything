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
