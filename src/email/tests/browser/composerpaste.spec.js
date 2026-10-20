import { test, expect } from '@playwright/test';

const start = async (page) => {
  await page.goto('/tests/browser/composer.html');
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
};

test('pasting Office content (html + a picture of it) pastes the text, not only an attachment', async ({ page }) => {
  await start(page);
  const body = page.getByRole('textbox', { name: 'Message body' });
  await body.click();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/html', '<table><tr><td>Q3</td><td>42</td></tr></table>');
    dt.setData('text/plain', 'Q3\t42');
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' }));
    document.querySelector('.rte-body').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(body).toContainText('Q3');
  await expect(page.locator('.compose-attachments .chip')).toHaveCount(0);
});

test('a pasted screenshot or copied image is still attached', async ({ page }) => {
  await start(page);
  await page.getByRole('textbox', { name: 'Message body' }).click();
  await page.evaluate(() => {
    for (const html of ['', '<img src="https://example.com/cat.png">']) {
      const dt = new DataTransfer();
      if (html) dt.setData('text/html', html);
      dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' }));
      document.querySelector('.rte-body').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }
  });
  await expect(page.locator('.compose-attachments .chip')).toHaveCount(2);
});


