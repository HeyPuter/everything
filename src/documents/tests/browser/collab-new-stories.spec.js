import { test, expect } from '@playwright/test';
import { unzipSync, strFromU8 } from 'fflate';
import { readFileSync } from 'node:fs';

// A new header, footer or note is a new part of the package the sharing tab opened: the room carries the story's
// text but not the part, so the others never had it. A guest's footnote left the sharing tab with a reference to a
// note its file did not hold (a DOCX Word reports as damaged), and the note's text was lost.
const text = page => page.getByRole('textbox', { name: 'Document text' });
const editorText = page => text(page).evaluate(el => el.value);

async function openPlayground(page, name) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/playground.html?name=${name}`);
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
}
async function shareLink(page) {
  await page.getByRole('button', { name: 'Share', exact: true }).first().click();
  await page.getByRole('menuitem', { name: 'Invite People…' }).click();
  const dialog = page.getByRole('dialog', { name: /^Share/ });
  await dialog.getByRole('button', { name: 'Copy Link' }).click();
  const field = dialog.getByRole('textbox', { name: 'Invitation link' });
  await expect(field).toHaveValue(/collab-local=/);
  const link = await field.inputValue();
  await dialog.getByRole('button', { name: 'Done' }).click();
  return link;
}

test('a shared document refuses new headers and notes the others could not receive, and its file stays whole', async ({ context }, info) => {
  const ann = await context.newPage();
  const errors = [];
  ann.on('pageerror', e => errors.push(e.message));
  await openPlayground(ann, 'Ann');
  await text(ann).fill('Body text.');
  const link = await shareLink(ann);
  const bob = await context.newPage();
  bob.on('pageerror', e => errors.push(e.message));
  await bob.setViewportSize({ width: 1440, height: 900 });
  await bob.goto(link.replace('playground.html', 'playground.html?name=Bob'));
  await expect.poll(() => editorText(bob)).toBe('Body text.');

  // The guest inserts a footnote: refused, with the reason, and nothing changes for either of them.
  await text(bob).evaluate(el => { el.focus(); el.setSelectionRange(4, 4); el.dispatchEvent(new Event('select')); });
  await bob.locator('#ribbon-tab-references').click();
  await bob.locator('#ribbon-panel-references').getByRole('button', { name: 'Insert Footnote', exact: true }).click();
  await expect(bob.locator('.toast-root')).toContainText('while the document is shared');
  await bob.keyboard.type('X');
  await expect.poll(() => editorText(ann)).toBe('BodyX text.');

  // The sharing tab adds a header: refused too, since the others would never see it.
  await ann.locator('#ribbon-tab-insert').click();
  await ann.locator('#ribbon-panel-insert').getByRole('button', { name: 'Header', exact: true }).click();
  await ann.getByRole('menuitem', { name: 'Edit Header' }).click();
  await expect(ann.locator('.toast-root')).toContainText('while the document is shared');
  await expect(ann.locator('#ribbon-tab-headerFooter')).not.toHaveAttribute('aria-selected', 'true');

  const [download] = await Promise.all([ann.waitForEvent('download'), ann.getByRole('button', { name: 'Download .docx' }).first().click()]);
  const saved = info.outputPath('shared.docx');
  await download.saveAs(saved);
  const files = unzipSync(new Uint8Array(readFileSync(saved)));
  expect(strFromU8(files['word/document.xml'])).not.toMatch(/footnoteReference|headerReference/);
  expect(errors).toEqual([]);
});
