import { test, expect } from '@playwright/test';

// A header, footer or note is laid out on one page: page and column breaks have no place in it.
const input = page => page.locator('.canvas-input');
const paste = (page, text, html = '') => input(page).evaluate((el, [text, html]) => {
  el.focus(); const data = new DataTransfer(); if (html) data.setData('text/html', html); data.setData('text/plain', text);
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
}, [text, html]);
const header = page => page.evaluate(() => window.__docs.current.view.engine.model.paragraphs.map(p => p.runs.map(r => r.text).join('')));

test('text with page or column breaks pastes into a header as paragraphs, and Ctrl+Enter there says why it does nothing', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Document text' }).fill('Body text');
  await page.getByRole('tab', { name: 'Insert' }).click();
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Header', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit Header' }).click();
  await expect(input(page)).toHaveAttribute('aria-label', 'Header text');
  // Text copied from a PDF or a terminal can hold form feeds between pages.
  await paste(page, 'Page one\fPage two\u000eColumn');
  await expect.poll(() => header(page)).toEqual(['Page one', 'Page two', 'Column']);
  await expect(page.getByText('taller than a page')).toHaveCount(0);
  // So does this editor's own copy of text with a page break in it.
  await input(page).press('ControlOrMeta+a');
  await paste(page, 'A\fB', '<div data-documents-fragment="{&quot;paragraphs&quot;:[{&quot;text&quot;:&quot;A\\fB&quot;,&quot;runs&quot;:[{&quot;text&quot;:&quot;A\\fB&quot;,&quot;format&quot;:{&quot;bold&quot;:true}}],&quot;mark&quot;:false,&quot;styleId&quot;:null,&quot;styleName&quot;:null,&quot;alignment&quot;:&quot;left&quot;,&quot;list&quot;:null}]}"><p>A</p><p>B</p></div>');
  await expect.poll(() => header(page)).toEqual(['A', 'B']);
  // A page break typed there is refused with the reason, not as a header taller than a page.
  await input(page).press('ControlOrMeta+Enter');
  await expect(page.getByText('Headers, footers and notes can’t hold page or column breaks.').first()).toBeVisible();
  await expect(page.getByText('taller than a page')).toHaveCount(0);
  expect(await header(page)).toEqual(['A', 'B']);
  await page.keyboard.press('Escape');
  await expect(input(page)).toHaveAttribute('aria-label', 'Document text');
  // The body still takes them.
  await input(page).press('ControlOrMeta+End');
  await paste(page, 'x\fy');
  await expect(input(page)).toHaveValue('Body textx\ny');
  expect(await page.evaluate(() => window.__docs.current.view.engine.model.text)).toBe('Body textx\fy');
  expect(errors).toEqual([]);
});
