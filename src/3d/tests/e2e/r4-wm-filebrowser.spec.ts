// File Browser: sortable list columns, select / execute under the pointer, bookmark operators.
import { test, expect } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
test('File Browser: column sorting, pointer select, bookmarks', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for await (const [name] of (root as any).entries()) await root.removeEntry(name, { recursive: true });
    for (const [n, size] of [['a.txt', 30], ['b.txt', 5], ['c.txt', 12]] as const) {
      const w = await (await root.getFileHandle(n, { create: true })).createWritable();
      await w.write('x'.repeat(size));
      await w.close();
    }
  });
  const v = (await page.locator('.area[data-editor="VIEW_3D"]').boundingBox())!;
  await page.mouse.move(v.x + 300, v.y + 300);
  await page.evaluate(() => (window as any).app.hoverArea.setType('FILE_BROWSER'));
  const fb = page.locator('.area[data-editor="FILE_BROWSER"]');
  await fb.locator('.fb-side-item', { hasText: 'Browser Storage' }).click();
  await expect(fb.locator('.fb-item')).toHaveCount(3);
  await page.evaluate(() => (window as any).app.hoverArea.editor.setView('LIST_VERTICAL'));
  const names = () => fb.locator('.fb-item .fb-name').allTextContents();
  // clicking a column sorts by it (sizes: largest first), clicking again reverses
  await fb.locator('.fb-col', { hasText: 'Size' }).click();
  await expect.poll(names).toEqual(['a.txt', 'c.txt', 'b.txt']);
  await fb.locator('.fb-col', { hasText: 'Size' }).click();
  await expect.poll(names).toEqual(['b.txt', 'c.txt', 'a.txt']);
  await fb.locator('.fb-col', { hasText: 'Name' }).click();
  await expect.poll(names).toEqual(['a.txt', 'b.txt', 'c.txt']);
  // select under the pointer, extend with the operator's options
  const run = (op: string, props: Record<string, unknown> = {}, event?: { x: number; y: number }) =>
    page.evaluate(([o, p, ev]) => { const a = (window as any).app; return a.run(o, p, { area: a.hoverArea, event: ev ?? undefined }); }, [op, props, event ?? null] as const);
  const bx = (await fb.locator('.fb-item', { hasText: 'b.txt' }).boundingBox())!;
  const cx = (await fb.locator('.fb-item', { hasText: 'c.txt' }).boundingBox())!;
  await run('file.select', { open: false }, { x: bx.x + 20, y: bx.y + bx.height / 2 });
  await expect(fb.locator('.fb-item.on')).toHaveText([/b\.txt/]);
  await run('file.select', { open: false, extend: true }, { x: cx.x + 20, y: cx.y + cx.height / 2 });
  await expect(fb.locator('.fb-item.on')).toHaveCount(2);
  // execute under the pointer opens the text
  await run('file.mouse_execute', {}, { x: cx.x + 20, y: cx.y + cx.height / 2 });
  await expect.poll(() => page.evaluate(() => Object.values((window as any).app.doc.texts).map((t: any) => t.name).join(','))).toContain('c.txt');
  // bookmarks: add, go there by name, delete
  await page.mouse.move(bx.x + 20, bx.y + 4);
  await page.keyboard.press('Control+b');
  await expect(fb.locator('.fb-side-item', { hasText: 'Browser Storage' })).toHaveCount(2);
  expect(await run('file.select_bookmark', { dir: 'Browser Storage' })).toBe('FINISHED');
  await fb.locator('.fb-side-item', { hasText: 'Browser Storage' }).nth(1).click({ button: 'right' });
  await expect(page.locator('.menu .menu-item', { hasText: 'Move Down' })).toBeVisible();
  await page.locator('.menu .menu-item', { hasText: 'Delete Bookmark' }).click();
  await expect(fb.locator('.fb-side-item', { hasText: 'Browser Storage' })).toHaveCount(1);
  // hidden files toggle alias
  const hid = await page.evaluate(() => (window as any).app.hoverArea.editor.showHidden);
  await run('file.hidedot');
  expect(await page.evaluate(() => (window as any).app.hoverArea.editor.showHidden)).toBe(!hid);
  await expectNoErrors(errors);
});
