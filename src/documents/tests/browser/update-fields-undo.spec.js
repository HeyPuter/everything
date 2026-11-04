import { test, expect } from '@playwright/test';

// F9 pressed in a header updates the body's fields and the header's own: one undo step takes back both.
test('Update Fields from a header changing body and header fields is one undo step', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled({ timeout: 20000 });
  await page.getByRole('textbox', { name: 'Document text' }).focus();
  await page.keyboard.type('Figure ');
  // A sequence field whose saved result (7) is out of date.
  await page.evaluate(async () => {
    const { insertBodyField, fieldInstruction } = await import('/src/engine/field-results.js');
    const e = window.__docs.current.view.engine;
    e.execute(() => insertBodyField(e.model, fieldInstruction({ name: 'SEQ', argument: 'Figure' }), '7'));
  });
  await page.evaluate(() => window.__docs.current.view.commands.headerItems('header').find(item => item.label === 'Edit Header').onSelect());
  await expect.poll(() => page.evaluate(() => window.__docs.current.view.engine.session.path)).not.toBeNull();
  // A header date field showing a year long past.
  await page.evaluate(async () => {
    const { storyPageField } = await import('/src/engine/header-footer-designs.js');
    const e = window.__docs.current.view.engine;
    e.execute(() => e.model.insertFieldRun(storyPageField('DATE \\@ yyyy', '1999')));
  });
  const state = () => page.evaluate(() => {
    const e = window.__docs.current.view.engine, header = [...e.session.models].find(([path]) => path !== null)[1];
    return { body: e.session.body.text.replace(/￼/g, ''), header: header.paragraphs.flatMap(p => p.runs).find(r => r.field)?.field.cachedText, steps: e.session.history.length };
  });
  const before = await state();
  expect(before).toMatchObject({ body: 'Figure 7', header: '1999' });
  await page.keyboard.press('F9');
  const year = String(new Date().getFullYear());
  await expect.poll(async () => (await state()).header).toBe(year);
  await expect.poll(async () => (await state()).body).toBe('Figure 1');
  expect((await state()).steps).toBe(before.steps + 1);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await state()).toEqual(before);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  expect(await state()).toEqual({ body: 'Figure 1', header: year, steps: before.steps + 1 });
});
