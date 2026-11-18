import { expect, test } from '@playwright/test';
import { boot, downloadFrom, openImage, start } from './helpers';

for (const [source, target] of [[200, 1], [16, 320]]) {
  test(`Export As accepts a ${target}px width for a ${source}px source`, async ({ page }) => {
    await boot(page);
    await openImage(page, source, source, '#336699');
    await start(page, 'file.export-as');
    const dialog = page.locator('dialog.export-dialog');
    await dialog.locator('input[name="outWidth"]').fill(String(target));
    await dialog.locator('select[name="resample"]').focus();
    expect(await dialog.locator('form').evaluate((form: HTMLFormElement) => [...form.elements].filter((el) => el instanceof HTMLInputElement && !el.validity.valid).map((el) => (el as HTMLInputElement).name))).toEqual([]);
    const file = await downloadFrom(page, () => dialog.locator('[data-act="export"]').click());
    expect(file.bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect([file.bytes.readUInt32BE(16), file.bytes.readUInt32BE(20)]).toEqual([target, target]);
  });
}

test('Export As names the image and canvas size fields apart', async ({ page }) => {
  await boot(page);
  await openImage(page, 40, 30, '#336699');
  await start(page, 'file.export-as');
  const dialog = page.getByRole('dialog', { name: 'Export As' });
  const field = (name: string) => dialog.getByRole('spinbutton', { name, exact: true });
  await expect(field('Image width')).toHaveValue('40');
  await expect(field('Image height')).toHaveValue('30');
  await expect(field('Canvas width')).toHaveValue('40');
  await expect(field('Canvas height')).toHaveValue('30');
});
