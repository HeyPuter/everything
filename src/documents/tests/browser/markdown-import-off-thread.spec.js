import { test, expect } from '@playwright/test';

/**
 * The Markdown parser's time grows faster than the file for some text: 60 kB of "*a*a*a…" held the window for
 * minutes while it opened, all of it on the page's thread. The file is read in a worker, so the window answers
 * meanwhile, and a file not read by the deadline opens as its lines of text, with a notice saying so.
 */
const input = page => page.getByRole('textbox', { name: 'Document text' });

test('a Markdown file that is slow to parse opens without freezing the window', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('input[type=file][aria-label="Open DOCX file"]').setInputFiles({ name: 'stars.md', mimeType: 'text/markdown', buffer: Buffer.from(`Start ${'*a'.repeat(30000)} end`) });
  // The page's thread is free while the file is read: a script runs at once.
  for (let i = 0; i < 3; i++) {
    const started = Date.now();
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
    expect(Date.now() - started).toBeLessThan(2000);
  }
  await expect(input(page)).toHaveValue(/^Start .* end$/, { timeout: 90000 });
});

test('Markdown not read by the deadline is read as its lines of text', async ({ page }) => {
  await page.goto('/mock.html#/new');
  const result = await page.evaluate(async () => {
    const { markdownHtmlOffThread } = await import('/src/lib/markdown-html.js');
    const slow = await markdownHtmlOffThread(`# Title\n\nStart ${'*a'.repeat(30000)} end\n<b>x</b>`, { deadline: 1 });
    const quick = await markdownHtmlOffThread('# Title\n\nSome *emphasis* and <b>bold</b> &copy; &notit; &#x41;.\n\n<script>alert(1)</script>');
    return { slow, quick };
  });
  expect(result.slow.plain).toBe(true);
  expect(result.slow.html.startsWith('<p># Title</p><p></p><p>Start *a*a*a')).toBe(true);
  expect(result.slow.html.endsWith(' end</p><p>&lt;b&gt;x&lt;/b&gt;</p>')).toBe(true);
  expect(result.quick.plain).toBe(false);
  expect(result.quick.html).toContain('<h1>Title</h1>');
  expect(result.quick.html).toContain('<em>emphasis</em>');
  expect(result.quick.html).toContain('<b>bold</b>');
  // Character references read in the worker as on the page: a name the table lacks stays as written.
  expect(result.quick.html).toContain('© &amp;notit; A.');
  expect(result.quick.html).not.toContain('script');
});
