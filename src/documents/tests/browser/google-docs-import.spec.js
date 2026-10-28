import { test, expect } from '@playwright/test';

// A web page from Google Docs' File > Download > Web page: a blank line is an empty paragraph the style sheet gives a
// line's height, and nested lists are lists of their own, nested by class (lst-kix_<list>-<level>).
const PAGE = `<html><head><meta content="text/html; charset=UTF-8" http-equiv="content-type"><style type="text/css">
ol.lst-kix_abc-0.start{counter-reset:lst-ctn-kix_abc-0 0}.lst-kix_abc-0>li{counter-increment:lst-ctn-kix_abc-0}
ul.lst-kix_def-1{list-style-type:none}.c2{height:11pt}.c0{margin:0;padding:0}.c4{font-weight:700}
</style></head><body class="c5 doc-content">
<p class="c0"><span class="c4">Plan</span></p><p class="c0 c2"><span class="c1"></span></p>
<p class="c0"><span class="c1">After a blank line</span></p>
<ol class="c3 lst-kix_abc-0 start" start="1"><li class="c0 li-bullet-0"><span class="c1">One</span></li></ol>
<ul class="c3 lst-kix_def-1 start"><li class="c0 li-bullet-1"><span class="c1">Detail</span></li></ul>
<ol class="c3 lst-kix_abc-0"><li class="c0 li-bullet-0"><span class="c1">Two</span></li></ol>
<p class="c0 c2"><span class="c1"></span></p><p class="c0"><span class="c1">End</span></p></body></html>`;

test('a Google Docs web page opens with its blank lines and nested, numbered lists', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('input[type=file][aria-label="Open DOCX file"]').setInputFiles({ name: 'Plan.html', mimeType: 'text/html', buffer: Buffer.from(PAGE) });
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toHaveValue('Plan\n\nAfter a blank line\nOne\nDetail\nTwo\n\nEnd');
  const lists = await page.evaluate(() => window.__docs.current.view.engine.model.paragraphs.map(p => p.list?.level ?? null));
  expect(lists).toEqual([null, null, null, 0, 1, 0, null, null]);
  await expect(page.locator('.editor-error')).toHaveCount(0);
});
