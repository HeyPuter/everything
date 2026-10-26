import { test, expect } from '@playwright/test';

const text = page => page.getByRole('textbox', { name: 'Document text' });
const editorText = page => text(page).evaluate(el => el.value);
// A 64x40 blue PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAoCAIAAADBrGu+AAAAPUlEQVR42u3PQQkAAAgEsMtnMLMawww+hcEKLNXzWgQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELhbh+DEAtSaHCQAAAABJRU5ErkJggg==';

test('a picture added before sharing reaches the people who join', async ({ browser }) => {
  test.setTimeout(120000);
  const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const owner = await ownerContext.newPage();
  await owner.goto('/mock.html?user=ada#/new');
  await expect(owner.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(owner).fill('Plan.');
  await owner.evaluate(async png => {
    const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
    await window.__docs.current.view.engine.insertImageFile(new File([bytes], 'blue.png', { type: 'image/png' }));
  }, PNG);
  await expect(owner.locator('.canvas-save-status')).toHaveAttribute('aria-label', 'Saved to Puter', { timeout: 15000 });
  await owner.getByRole('button', { name: 'Share', exact: true }).first().click();
  await owner.getByRole('menuitem', { name: 'Invite People…' }).click();
  const dialog = owner.getByRole('dialog', { name: /^Share/ });
  await dialog.getByRole('textbox', { name: 'People to invite' }).fill('bob');
  await dialog.getByRole('button', { name: 'Invite' }).click();
  await expect(dialog.locator('.sh-status')).toContainText('bob can open the document');
  const link = await dialog.getByRole('textbox', { name: 'Invitation link' }).inputValue();
  await dialog.getByRole('button', { name: 'Done' }).click();
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const guest = await guestContext.newPage();
  await guest.goto(link.replace('mock.html', 'mock.html?user=bob').replace(/&collab-invite=[^&]*/, ''));
  await expect.poll(() => editorText(guest), { timeout: 15000 }).toContain('Plan.');
  // The picture's bytes are there to paint, as they are for the owner.
  const pictures = page => page.evaluate(() => {
    const engine = window.__docs.current.view.engine;
    const ids = engine.session.body.paragraphs.flatMap(p => p.runs.filter(r => r.image).map(r => r.image.assetId || r.image.id || r.image));
    return { ids: ids.length, bitmaps: engine.images.size, withBytes: Object.values(engine.session.body.assets || {}).filter(a => a?.bytes?.length).length };
  });
  const own = await pictures(owner);
  expect(own.ids).toBe(1);
  await expect.poll(() => pictures(guest), { timeout: 15000 }).toEqual(own);
  // Sharing them is where the shared document starts, not a change of the owner's to undo.
  expect(await owner.evaluate(() => window.__docs.current.view.engine.session.history.length)).toBe(0);
  await ownerContext.close(); await guestContext.close();
});
