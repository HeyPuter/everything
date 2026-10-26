import { test, expect } from '@playwright/test';

const MAC = process.platform === 'darwin';
const select = (input, start, end = start) => input.evaluate((el, [a, b]) => { el.setSelectionRange(a, b); el.dispatchEvent(new Event('select', { bubbles: true })); }, [start, end]);
const selected = page => page.evaluate(() => { const m = window.__docs.current.view.engine.model; return m.text.slice(...m.range); });
const spoken = page => page.evaluate(() => window.__spoken.filter(u => !u.cancelled).map(u => u.text));
/** The browser's speech is replaced by one that reports words when told to. */
async function open(page, text) {
  await page.addInitScript(() => {
    window.__spoken = [];
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speak: u => window.__spoken.push(u), cancel() {}, pause() {}, resume() {} } });
    /** Report the word that starts at `word`'s first occurrence in the current utterance, or end it. */
    window.__say = word => { const u = window.__spoken.at(-1); if (word === null) u.onend(); else u.onboundary({ name: 'word', charIndex: u.text.indexOf(word) }); };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input.fill(text);
  return input;
}
const readAloud = page => page.keyboard.press(MAC ? 'Alt+Meta+Space' : 'Control+Alt+Space');

test('Read Aloud leaves out text tracked as deleted, as the page shows it struck out', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await open(page, 'Keep this old word here.\nSecond line.');
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.session.body.trackChanges = true; });
  await select(input, 10, 14);
  await page.keyboard.press('Delete');
  await expect.poll(() => page.evaluate(() => window.__docs.current.view.engine.model.text)).toBe('Keep this old word here.\nSecond line.');
  await select(input, 0);
  await readAloud(page);
  await expect.poll(() => spoken(page)).toEqual(['Keep this word here.']);
  await page.evaluate(() => window.__say('word'));
  expect(await selected(page)).toBe('word');
  await page.evaluate(() => window.__say(null));
  await expect.poll(() => spoken(page)).toEqual(['Keep this word here.', 'Second line.']);
  expect(errors).toEqual([]);
});

test('Read Aloud keeps highlighting the words it reads after the document is edited', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await open(page, 'One two three four.\nFive six.\nSeven.');
  await select(input, 0);
  await readAloud(page);
  await page.evaluate(() => window.__say('two'));
  expect(await selected(page)).toBe('two');
  // Typing before the words still to be read moves them.
  await select(input, 0);
  await page.keyboard.type('Zero ');
  await page.evaluate(() => window.__say('four'));
  expect(await selected(page)).toBe('four.');
  // A paragraph added further on is read in its place.
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.model.select(e.model.text.indexOf('Seven')); e.syncInput(); });
  await input.focus();
  await page.keyboard.type('Added.\n');
  await page.evaluate(() => window.__say(null));
  await expect.poll(async () => (await spoken(page)).at(-1)).toBe('Five six.');
  await page.evaluate(() => window.__say(null));
  await expect.poll(async () => (await spoken(page)).at(-1)).toBe('Added.');
  await page.evaluate(() => window.__say('Added'));
  expect(await selected(page)).toBe('Added.');
  await page.evaluate(() => window.__say(null));
  await expect.poll(async () => (await spoken(page)).at(-1)).toBe('Seven.');
  expect(errors).toEqual([]);
});

test('Read Aloud starts at the caret, and its player moves between paragraphs, also after one is removed', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await open(page, 'First one.\nSecond one.\nThird one.\nFourth one.');
  await select(input, 13);
  await readAloud(page);
  await expect.poll(() => spoken(page)).toEqual(['cond one.']);
  const player = page.getByRole('toolbar', { name: 'Read Aloud' });
  await player.getByRole('button', { name: 'Next paragraph' }).click();
  await expect.poll(async () => (await spoken(page)).at(-1)).toBe('Third one.');
  await player.getByRole('button', { name: 'Previous paragraph' }).click();
  await expect.poll(async () => (await spoken(page)).at(-1)).toBe('Second one.');
  // The paragraph being read is deleted: Next reads the one now in its place.
  await page.evaluate(() => { const e = window.__docs.current.view.engine, at = e.model.text.indexOf('Second'); e.model.select(at, at + 'Second one.\n'.length); e.syncInput(); });
  await input.focus();
  await page.keyboard.press('Delete');
  await expect.poll(() => page.evaluate(() => window.__docs.current.view.engine.model.text)).toBe('First one.\nThird one.\nFourth one.');
  await player.getByRole('button', { name: 'Next paragraph' }).click();
  await expect.poll(async () => (await spoken(page)).at(-1)).toBe('Third one.');
  await player.getByRole('button', { name: 'Previous paragraph' }).click();
  await expect.poll(async () => (await spoken(page)).at(-1)).toBe('First one.');
  await player.getByRole('button', { name: 'Stop reading' }).click();
  await expect(player).toBeHidden();
  expect(errors).toEqual([]);
});
