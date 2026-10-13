import { test, expect, type Page } from '@playwright/test';
import { boot, idle, openImage, run, start } from './helpers';

type TypeModule = typeof import('../../src/features/type/session');
const textLayer = (page: Page) =>
  page.evaluate(() => {
    const l = window.photoStudio.doc.layers.find((l) => l.kind === 'text');
    const style = l?.textData?.content.paragraphs[0]?.runs[0]?.style;
    return l && style ? { id: l.id, family: style.family, weight: style.weight, italic: style.italic } : null;
  });

// A text layer set in one font is rasterized as the sample; the live text
// layer is switched to another font, hidden, and then matched back.
async function setup(page: Page, family: string) {
  await openImage(page, 900, 260, '#ffffff');
  await page.evaluate(() => window.photoStudio.runCommand('type.add'));
  await page.waitForFunction(() => !!(window as unknown as { photoStudioType: TypeModule }).photoStudioType.session);
  await page.keyboard.type('Quick Brown Fox');
  await page.evaluate(async (family) => {
    const t = (window as unknown as { photoStudioType: TypeModule }).photoStudioType;
    const e = window.photoStudio;
    t.setSelection(e, 0, 15);
    await t.applyChar(e, { family, size: 54 });
    await t.commit(e);
  }, family);
  await idle(page);
  const original = (await textLayer(page))!;
  expect(original.family).toBe(family);
  await run(page, 'layer.duplicate');
  await run(page, 'layer.rasterize-type');
  await page.evaluate((id) => window.photoStudio.selectLayer(id), original.id);
  await page.evaluate(async () => {
    const t = (window as unknown as { photoStudioType: TypeModule }).photoStudioType;
    await t.applyChar(window.photoStudio, { family: 'Inter' });
  });
  await run(page, 'layer.hide');
  await page.evaluate((id) => window.photoStudio.selectLayer(id), original.id);
  await idle(page);
  expect((await textLayer(page))!.family).toBe('Inter');
  return original.id;
}

test('Match Font finds the font of boxed text and applies it to the text layer', async ({ page }) => {
  await boot(page);
  await setup(page, 'Bebas Neue');
  await start(page, 'type.match-font');
  const dialog = page.locator('dialog.match-font[open]');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#mf-apply')).toBeDisabled();
  // Box the whole image (the text sits in the middle on white).
  const canvas = dialog.locator('.mf-view canvas');
  const r = (await canvas.boundingBox())!;
  await page.mouse.move(r.x + r.width * 0.05, r.y + r.height * 0.15);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.5, r.y + r.height * 0.5, { steps: 4 });
  await page.mouse.move(r.x + r.width * 0.95, r.y + r.height * 0.85, { steps: 4 });
  await page.mouse.up();
  const matches = dialog.locator('.mf-match');
  await expect(matches.first()).toBeVisible({ timeout: 60_000 });
  const families = await matches.evaluateAll((list) => list.map((b) => (b as HTMLElement).dataset.family));
  expect(families.slice(0, 3)).toContain('Bebas Neue');
  // Typing the text refines the comparison; Bebas Neue comes first.
  await dialog.locator('#mf-text').fill('Quick Brown Fox');
  await dialog.locator('#mf-find').click();
  await expect(dialog.locator('#mf-status')).toContainText('compared', { timeout: 60_000 });
  await expect(matches.first()).toHaveAttribute('data-family', 'Bebas Neue');
  await expect(matches.first()).toHaveAttribute('aria-checked', 'true');
  await dialog.locator('#mf-apply').click();
  await expect(dialog).toHaveCount(0);
  await idle(page);
  expect((await textLayer(page))!.family).toBe('Bebas Neue');
  expect(await page.evaluate(() => window.photoStudio.history.labels.at(-1))).toBe('Match Font');
});

test('Ask AI re-ranks matches only when pressed', async ({ page }) => {
  await boot(page, 'default', 'window.puter={env:"app",auth:{isSignedIn:()=>true},ai:{calls:[],txt2img:async()=>({src:""}),chat:async(prompt,file)=>{window.puter.ai.calls.push({prompt,type:file&&file.type});return {message:{content:window.aiAnswer}};}}};');
  await setup(page, 'Crimson Pro');
  await page.evaluate(() => window.photoStudio.runCommand('select.all'));
  await idle(page);
  await start(page, 'type.match-font');
  const dialog = page.locator('dialog.match-font[open]');
  // The selection is the box, so matching starts at once.
  const matches = dialog.locator('.mf-match');
  await expect(matches.first()).toBeVisible({ timeout: 60_000 });
  const calls = () => page.evaluate(() => (window as unknown as { puter: { ai: { calls: unknown[] } } }).puter.ai.calls.length);
  expect(await calls()).toBe(0);
  const before = await matches.evaluateAll((list) => list.map((b) => (b as HTMLElement).dataset.family));
  expect(before).toContain('Crimson Pro');
  // The service names another listed family (answers may carry extra words).
  const other = before.find((f) => f !== before[0])!;
  await page.evaluate((other) => Object.assign(window, { aiAnswer: `1. ${other}\n2. Unlisted Sans` }), other);
  await dialog.locator('#mf-ai').click();
  await expect(matches.first()).toHaveAttribute('data-family', other);
  await expect(matches.first().locator('.mf-score em')).toHaveText('AI');
  expect(await calls()).toBe(1);
  const sent = await page.evaluate(() => (window as unknown as { puter: { ai: { calls: { prompt: string; type: string }[] } } }).puter.ai.calls[0]);
  expect(sent.type).toBe('image/png');
  expect(sent.prompt).toContain('Crimson Pro');
  await dialog.locator('#mf-cancel').click();
  await expect(dialog).toHaveCount(0);
  expect((await textLayer(page))!.family).toBe('Inter');
});
