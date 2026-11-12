// Color dialogs that load profile files and long color conversions: the
// choices made before "Load profile file…" survive the file picker, and a
// conversion never lands in a document the user switched to meanwhile.
import { test, expect, type Page } from '@playwright/test';
import { boot, idle, openImage } from './helpers';

const openForm = (page: Page) => page.locator('#dialog[open] form');
const formValues = (page: Page) =>
  page.evaluate(() => {
    const f = document.querySelector<HTMLFormElement>('#dialog[open] form');
    return f ? Object.fromEntries([...new FormData(f)].map(([k, v]) => [k, String(v)])) : null;
  });
/** ICC bytes of a CMYK profile named `name`. */
const profileBytes = (page: Page, name: string) =>
  page.evaluate(async (name) => {
    const { serializeIcc, builtinProfile } = await import('/src/color/color-management.ts');
    return Array.from(serializeIcc({ ...builtinProfile('generic-uncoated-cmyk'), name }));
  }, name);

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 120, 90, '#c04020', 'a.png');
});

test('Color Settings keeps the choices made before loading a profile', async ({ page }) => {
  const bytes = await profileBytes(page, 'Test Press');
  // A dismissed file picker (headless Chromium dismisses it) returns to the
  // dialog; it used to leave the editor busy with no dialog at all.
  await page.evaluate(() => void window.photoStudio.runCommand('edit.color-settings'));
  await expect(openForm(page).locator('select[name=intent]')).toBeVisible();
  await page.selectOption('#dialog select[name=intent]', 'saturation');
  await page.selectOption('#dialog select[name=cmyk]', { label: 'Load CMYK profile…' });
  await page.locator('#dialog button[type=submit]').click();
  await expect(openForm(page).locator('select[name=intent]')).toBeVisible();
  expect(await formValues(page)).toMatchObject({ intent: 'saturation', cmyk: 'builtin:generic-coated-cmyk' });
  await page.locator('#dialog #cancel-dialog').click();
  await page.waitForFunction(() => !window.photoStudio.busy);
  page.once('filechooser', (fc) => fc.setFiles({ name: 'press.icc', mimeType: 'application/vnd.iccprofile', buffer: Buffer.from(bytes) }));
  await page.evaluate(() => void window.photoStudio.runCommand('edit.color-settings'));
  await expect(openForm(page).locator('select[name=intent]')).toBeVisible();
  await page.selectOption('#dialog select[name=intent]', 'perceptual');
  await page.locator('#dialog input[type=checkbox][name=bpc]').uncheck();
  await page.selectOption('#dialog select[name=cmyk]', { label: 'Load CMYK profile…' });
  await page.locator('#dialog button[type=submit]').click();
  // The dialog comes back with the loaded profile and the earlier choices.
  await expect(openForm(page).locator('select[name=cmyk] option:checked')).toHaveText('Test Press (loaded)');
  const v = await formValues(page);
  expect(v).toMatchObject({ intent: 'perceptual', bpc: 'no' });
  await page.locator('#dialog #cancel-dialog').click();
});

test('Customize Proof Condition keeps its choices and the current proof while loading a profile', async ({ page }) => {
  const bytes = await profileBytes(page, 'Proof Press');
  await page.evaluate(() => void window.photoStudio.runCommand('view.proof-custom'));
  await expect(openForm(page).locator('select[name=intent]')).toBeVisible();
  await page.selectOption('#dialog select[name=intent]', 'absolute');
  await page.selectOption('#dialog select[name=ref]', { label: 'Load profile file…' });
  page.once('filechooser', (fc) => fc.setFiles({ name: 'proof.icc', mimeType: 'application/vnd.iccprofile', buffer: Buffer.from(bytes) }));
  await page.locator('#dialog button[type=submit]').click();
  await expect(openForm(page).locator('select[name=ref] option:checked')).toHaveText('Proof Press (loaded)');
  expect(await formValues(page)).toMatchObject({ intent: 'absolute' });
  // Cancelling leaves the document's proof setup as it was.
  await page.locator('#dialog #cancel-dialog').click();
  const setup = await page.evaluate(async () => {
    const { proofState } = await import('/src/features/color/proof.ts');
    const s = proofState(window.photoStudio.session).setup;
    return { kind: s.kind, intent: s.intent };
  });
  expect(setup.kind).toBe('cmyk');
  expect(setup.intent).not.toBe('absolute');
});

test('a mode conversion does not land in a document opened while it was prepared', async ({ page }) => {
  await openImage(page, 120, 90, '#20a040', 'b.png');
  const result = await page.evaluate(async () => {
    const e = window.photoStudio;
    const view = (name: string) => e.views.find((v) => v.session.fileName === name)!;
    await e.activateView(view('a.png'));
    // The CMYK profile is built in a worker the first time; switch documents meanwhile.
    const running = e.runCommand('image.mode-cmyk');
    const status = document.querySelector('#status')!;
    while (!status.textContent?.includes('Preparing the CMYK profile')) await new Promise((r) => setTimeout(r, 1));
    await e.activateView(view('b.png'));
    await running;
    const b = { mode: e.doc.mode ?? 'rgb', steps: e.session.history.canUndo };
    await e.activateView(view('a.png'));
    return { b, a: e.doc.mode ?? 'rgb' };
  });
  await idle(page);
  expect(result.b).toEqual({ mode: 'rgb', steps: false });
  expect(result.a).toBe('rgb');
  await expect(page.locator('#status')).toContainText('nothing was converted');
});

test('Assign Profile previews profiles but not the "Load profile file…" entry', async ({ page }) => {
  await page.evaluate(() => void window.photoStudio.runCommand('edit.assign-profile'));
  await expect(openForm(page).locator('select[name=profile]')).toBeVisible();
  await page.selectOption('#dialog select[name=profile]', 'builtin:display-p3');
  await page.selectOption('#dialog select[name=profile]', { label: 'Load profile file…' });
  await page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await window.photoStudio.renderer.settle();
  });
  // Choosing the entry used to preview a profile named "load" and report a damaged embedded profile.
  expect(await page.locator('#status').textContent()).not.toContain('cannot be used');
  await page.locator('#dialog #cancel-dialog').click();
  await page.waitForFunction(() => !window.photoStudio.busy);
  expect(await page.evaluate(() => window.photoStudio.doc.iccProfile)).toBeUndefined();
});
