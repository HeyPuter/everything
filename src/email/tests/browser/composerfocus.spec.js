import { test, expect } from '@playwright/test';

// A resumed draft carries on from the end of what the writer wrote, which in
// a reply is above the signature and the quote.

const quote = Array.from({ length: 60 }, (unused, i) => `> line ${i} of the original message`).join('\n');

test('resuming a reply draft puts the caret after the writer\'s text, not under the quote', async ({ page }) => {
  await page.goto('/tests/browser/composer.html');
  await page.evaluate(async (quoted) => {
    const { openCompose } = await import('/src/ui/compose.js');
    const { createDraftStore } = await import('/src/lib/drafts.js');
    const drafts = createDraftStore('focus-test');
    // What app.js hands the dialog for Reply, with a signature set.
    const modal = openCompose({ username: 'focus-test', mailPath: '/focus-test/.mail', drafts,
      signature: 'Morgan', prefill: { kind: 'reply', to: 'ana@example.com', subject: 'Re: Plan',
        body: `\n\nOn Mon, Ana wrote:\n${quoted}`, inReplyTo: '<a@x>' } });
    window.__drafts = drafts;
    window.__modal = modal;
  }, quote);
  const body = page.getByRole('textbox', { name: 'Message body' });
  await page.keyboard.type('Sounds good');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Reopen it from Drafts.
  await page.evaluate(async () => {
    const { openCompose } = await import('/src/ui/compose.js');
    openCompose({ username: 'focus-test', mailPath: '/focus-test/.mail', drafts: window.__drafts,
      signature: 'Morgan', prefill: null, draft: window.__drafts.list()[0] });
  });
  await page.keyboard.type(' -- and thanks!');
  const text = await body.innerText();
  expect(text.startsWith('Sounds good -- and thanks!')).toBe(true);
});

test('Enter in the subject of a resumed reply draft goes to the writer\'s text, not under the quote', async ({ page }) => {
  await page.goto('/tests/browser/composer.html');
  await page.evaluate(async (quoted) => {
    const { openCompose } = await import('/src/ui/compose.js');
    const { createDraftStore } = await import('/src/lib/drafts.js');
    const drafts = createDraftStore('focus-test-2');
    drafts.save({ id: 'reply-draft', to: 'ana@example.com', subject: 'Re: Plan',
      body: `Sounds good\n\n-- \nMorgan\n\nOn Mon, Ana wrote:\n${quoted}`, inReplyTo: '<a@x>' });
    openCompose({ username: 'focus-test-2', mailPath: '/m/.mail', drafts, prefill: null, draft: drafts.list()[0] });
  }, quote);
  await page.getByRole('textbox', { name: 'Subject', exact: true }).press('Enter');
  await page.keyboard.type('!');
  const text = await page.getByRole('textbox', { name: 'Message body' }).innerText();
  expect(text.startsWith('Sounds good!')).toBe(true);
});

test('a quote the writer made themselves is part of their own text', async ({ page }) => {
  await page.goto('/tests/browser/composer.html');
  await page.evaluate(async () => {
    const { openCompose } = await import('/src/ui/compose.js');
    const { createDraftStore } = await import('/src/lib/drafts.js');
    const drafts = createDraftStore('focus-test-3');
    drafts.save({ id: 'note', to: 'ana@example.com', subject: 'Notes',
      body: 'As the brief says:\n\n> Ship it by Friday\n\nSo that is the plan', html: '' });
    openCompose({ username: 'focus-test-3', mailPath: '/m/.mail', drafts, prefill: null, draft: drafts.list()[0] });
  });
  await page.keyboard.type('.');
  const text = await page.getByRole('textbox', { name: 'Message body' }).innerText();
  expect(text.trimEnd().endsWith('So that is the plan.')).toBe(true);
});
