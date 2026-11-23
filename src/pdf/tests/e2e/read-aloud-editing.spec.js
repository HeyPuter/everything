import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

test.skip(({ isMobile }) => isMobile, 'desktop menus');

// Read to end turned the page as each one was read, and turning the page saved and closed the
// text being typed: someone correcting the words as they heard them lost the edit's focus,
// and the next keys went nowhere.
test('Read to end leaves the page alone while its text is being edited', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.addInitScript(() => {
    window.spoken = [];
    window.SpeechSynthesisUtterance = class {
      constructor(text) {
        this.text = text;
      }
    };
    // A voice that finishes each piece when the test says so.
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        paused: false,
        speak(utterance) {
          window.spoken.push(utterance.text);
          window.finishSpeaking = () => utterance.onend?.();
        },
        cancel() {},
      },
    });
  });
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++)
    doc.addPage([612, 792]).drawText(`Page ${i} words`, { x: 50, y: 700, size: 20, font });
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'read-aloud.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 3');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('menuitem', { name: 'View', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Read out loud' }).click();
  await page.getByRole('menuitem', { name: 'Read to end of document', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.spoken)).toEqual(['Page 1 words']);

  await page.getByRole('button', { name: 'Edit text: Page 1 words', exact: true }).dblclick();
  const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
  await expect(input).toBeFocused();
  await page.keyboard.press('Meta+ArrowRight');
  await page.keyboard.insertText(' and');
  await page.evaluate(() => window.finishSpeaking());
  // The voice reads on; the page and the edit stay.
  await expect.poll(() => page.evaluate(() => window.spoken.length)).toBe(2);
  expect(await page.evaluate(() => window.spoken[1])).toBe('Page 2 words');
  await page.keyboard.insertText(' more');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('Page 1 words and more');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 3');

  // Once the edit is done, the page follows the voice again.
  await page.locator('.workspace').click({ position: { x: 4, y: 4 } });
  await expect(input).toHaveCount(0);
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.evaluate(() => window.finishSpeaking());
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 3');
  await expect.poll(() => page.evaluate(() => window.spoken.at(-1))).toBe('Page 3 words');
});
