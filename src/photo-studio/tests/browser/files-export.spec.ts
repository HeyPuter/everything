// Export As: color conversion for formats without profiles, and cancelling
// while the file is encoded.
import { expect, test } from '@playwright/test';
import { boot, idle, openImage, start } from './helpers';

test('formats that cannot carry the profile are always converted to sRGB', async ({ page }) => {
  await boot(page);
  await openImage(page, 60, 40, '#c04030');
  await page.evaluate(async () => {
    const { encodeIccProfile } = await import('/src/model/psd-resources.ts');
    const { serializeIcc } = await import('/src/color/icc-write.ts');
    const { builtinProfile } = await import('/src/color/builtin-profiles.ts');
    const icc = encodeIccProfile(serializeIcc(builtinProfile('compatible-rgb-1998')));
    window.photoStudio.command('Assign Profile', (d) => void (d.iccProfile = icc));
    localStorage.setItem('photo-studio-export', JSON.stringify({ format: 'png', convertSrgb: false }));
  });
  await idle(page);
  await start(page, 'file.export-as');
  const dialog = page.locator('dialog.export-dialog');
  const convert = dialog.locator('input[name="convertSrgb"]');
  const label = dialog.locator('label.export-check:has(input[name="convertSrgb"])');
  await expect(convert).not.toBeChecked();
  await expect(convert).toBeEnabled();
  for (const format of ['webp', 'gif', 'bmp']) {
    await dialog.locator('select[name="format"]').selectOption(format);
    await expect(convert).toBeChecked();
    await expect(convert).toBeDisabled();
    await expect(label).toHaveText('Convert to sRGB (required for this format)');
  }
  // The choice made for formats that embed the profile is kept.
  await dialog.locator('select[name="format"]').selectOption('tiff');
  await expect(convert).not.toBeChecked();
  await expect(convert).toBeEnabled();
  await expect(label).toHaveText('Convert to sRGB');
});

test('cancelling while the export encodes does not download the file', async ({ page }) => {
  await boot(page);
  await openImage(page, 300, 200, '#3060c0');
  await page.evaluate(() => {
    const w = window as unknown as { hold: boolean; held: (() => void)[]; jobDone: boolean; downloads: string[] };
    w.held = [];
    w.downloads = [];
    const post = Worker.prototype.postMessage;
    // Hold export jobs (they carry settings) until the test releases them.
    Worker.prototype.postMessage = function (this: Worker, msg: { id: number; settings?: unknown }, ...rest: []) {
      if (!w.hold || !msg?.settings) return post.call(this, msg, ...rest);
      w.held.push(() => {
        this.addEventListener('message', (ev) => ev.data.id === msg.id && (w.jobDone = true));
        post.call(this, msg, ...rest);
      });
    } as typeof post;
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (this.download) w.downloads.push(this.download);
      else click.call(this);
    };
  });
  await start(page, 'file.export-as');
  const dialog = page.locator('dialog.export-dialog');
  await dialog.locator('select[name="format"]').selectOption('jpeg');
  await expect(dialog.locator('.export-busy')).toBeHidden();
  await page.evaluate(() => ((window as unknown as { hold: boolean }).hold = true));
  // A setting the preview has not encoded yet, so Export encodes again.
  await dialog.locator('input[name="quality"]').fill('40');
  await dialog.locator('button[data-act="export"]').click();
  await expect(dialog.locator('.export-busy')).toHaveText('Encoding…');
  await expect(dialog.locator('button[data-act="cancel"]')).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => {
    const w = window as unknown as { hold: boolean; held: (() => void)[] };
    w.hold = false;
    for (const f of w.held.splice(0)) f();
  });
  await page.waitForFunction(() => (window as unknown as { jobDone: boolean }).jobDone);
  // Let the rest of the export run (provenance, download) if it still would.
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as unknown as { downloads: string[] }).downloads)).toEqual([]);
  await expect(page.locator('#status')).not.toHaveText(/Exported/);
});
