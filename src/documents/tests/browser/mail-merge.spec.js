import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { reopenDocx } from './helpers/reopen-docx.js';

const caret = (input, at) => input.evaluate((el, at) => { const n = at < 0 ? el.value.length : at; el.focus(); el.setSelectionRange(n, n); el.dispatchEvent(new Event('select')); }, at);
async function download(page, info, name) {
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
  const path = info.outputPath(`${name}.docx`);
  await (await event).saveAs(path);
  mkdirSync('test-results/mail-merge', { recursive: true });
  copyFileSync(path, `test-results/mail-merge/${name}.docx`);
  return path;
}
const ribbon = page => page.locator('.ribbon-card');
const acceptNext = page => page.once('dialog', dialog => dialog.accept());
test.use({ viewport: { width: 1440, height: 900 } });

test('types a list, inserts fields, previews, saves and merges to a new document', async ({ page }, info) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toHaveValue(/^A small beginning/);
  await page.getByRole('tab', { name: 'Mailings' }).click();

  // Type a new list of two recipients.
  await ribbon(page).getByRole('button', { name: 'Select Recipients' }).click();
  await page.getByRole('menuitem', { name: 'Type a New List…' }).click();
  const grid = page.getByRole('dialog', { name: 'New Address List' });
  await grid.getByLabel('Title, entry 1').fill('Ms.');
  await grid.getByLabel('First Name, entry 1').fill('Rosa');
  await grid.getByLabel('Last Name, entry 1').fill('Vidal');
  await grid.getByLabel('Address Line 1, entry 1').fill('1 Pier Rd');
  await grid.getByLabel('City, entry 1').fill('Oslo');
  await grid.getByLabel('Country, entry 1').fill('Norway');
  await grid.getByRole('button', { name: 'New Entry' }).click();
  await grid.getByLabel('First Name, entry 2').fill('Ken');
  await grid.getByLabel('Last Name, entry 2').fill('Ito');
  await grid.getByLabel('Address Line 1, entry 2').fill('9 Elm St');
  await grid.getByLabel('City, entry 2').fill('Austin');
  await grid.getByLabel('State, entry 2').fill('TX');
  await grid.getByLabel('ZIP Code, entry 2').fill('78701');
  await grid.getByLabel('Country, entry 2').fill('United States');
  await grid.getByRole('button', { name: 'OK' }).click();
  await expect(grid).toBeHidden();
  await expect(ribbon(page).getByRole('button', { name: 'Edit Recipient List' })).toBeEnabled();

  // Address block, greeting line and a city field at the start of the letter.
  await caret(input, 0);
  await ribbon(page).getByRole('button', { name: 'Address Block' }).click();
  const block = page.getByRole('dialog', { name: 'Insert Address Block' });
  await expect(block.locator('.mm-preview')).toHaveText('Ms. Rosa Vidal\n1 Pier Rd\nOslo\nNorway');
  await block.getByRole('button', { name: 'Next recipient' }).click();
  await expect(block.locator('.mm-preview')).toHaveText('Ken Ito\n9 Elm St\nAustin, TX 78701');
  await block.getByRole('button', { name: 'Insert' }).click();
  await expect(block).toBeHidden();
  await page.keyboard.press('Enter');
  await ribbon(page).getByRole('button', { name: 'Greeting Line' }).click();
  await page.getByRole('dialog', { name: 'Insert Greeting Line' }).getByRole('button', { name: 'Insert' }).click();
  await page.keyboard.press('Enter');
  await page.keyboard.type('Greetings from ');
  await ribbon(page).getByRole('button', { name: 'Insert Merge Field' }).click();
  await page.getByRole('menuitem', { name: 'City', exact: true }).click();
  await page.keyboard.type('.');
  await expect(input).toHaveValue(/^«AddressBlock»\n«GreetingLine»\nGreetings from «City»\.A small beginning/);

  // Preview the first and second recipients.
  await ribbon(page).getByRole('button', { name: 'Preview Results' }).click();
  await expect(input).toHaveValue(/^Ms\. Rosa Vidal\n1 Pier Rd\nOslo\nNorway\nDear Ms\. Vidal,\nGreetings from Oslo\./);
  await ribbon(page).getByRole('button', { name: 'Next Record' }).click();
  await expect(input).toHaveValue(/^Ken Ito\n9 Elm St\nAustin, TX 78701\nDear Ito,\nGreetings from Austin\./);
  await expect(ribbon(page).getByRole('spinbutton', { name: 'Go to record' })).toHaveValue('2');
  await ribbon(page).getByRole('button', { name: 'Highlight Merge Fields' }).click();
  await expect(ribbon(page).getByRole('button', { name: 'Highlight Merge Fields' })).toHaveAttribute('aria-pressed', 'true');

  // Check for errors finds nothing missing.
  await ribbon(page).getByRole('button', { name: 'Check for Errors' }).click();
  const check = page.getByRole('dialog', { name: 'Check for Errors' });
  await expect(check).toContainText('found no errors');
  await check.getByRole('button', { name: 'Close' }).first().click();

  // Save: real fields, merge settings and the embedded list; reopening restores the list.
  const saved = await download(page, info, 'main-document');
  const parts = unzipSync(readFileSync(saved));
  const xml = strFromU8(parts['word/document.xml']);
  expect(xml).toContain('<w:instrText xml:space="preserve"> MERGEFIELD City </w:instrText>');
  expect(xml).toMatch(/<w:instrText xml:space="preserve"> ADDRESSBLOCK \\f /);
  expect(xml).toMatch(/<w:instrText xml:space="preserve"> GREETINGLINE \\f /);
  expect(strFromU8(parts['word/settings.xml'])).toContain('<w:mainDocumentType w:val="formLetters"/>');
  expect(strFromU8(parts['word/settings.xml'])).toContain('<w:viewMergedData/><w:activeRecord w:val="2"/>');
  expect(Object.keys(parts).some(name => /^customXml\/item\d+\.xml$/.test(name))).toBe(true);
  const text = await input.inputValue();
  await reopenDocx(page, input, saved, text);
  await page.getByRole('tab', { name: 'Mailings' }).click();
  await expect(ribbon(page).getByRole('button', { name: 'Preview Results' })).toHaveAttribute('aria-pressed', 'true');
  await ribbon(page).getByRole('button', { name: 'Preview Results' }).click();
  await expect(input).toHaveValue(/^«AddressBlock»\n«GreetingLine»\nGreetings from «City»\./);

  // Finish: one document per recipient, opened as a new document.
  await ribbon(page).getByRole('button', { name: 'Finish & Merge' }).click();
  await page.getByRole('menuitem', { name: 'Edit Individual Documents…' }).click();
  acceptNext(page);
  await page.getByRole('dialog', { name: 'Merge to New Document' }).getByRole('button', { name: 'OK' }).click();
  await expect(page.locator('.canvas-title')).toHaveValue(/merged/);
  await expect(input).toHaveValue(/^Ms\. Rosa Vidal\n1 Pier Rd\nOslo\nNorway\nDear Ms\. Vidal,\nGreetings from Oslo\.A small beginning[\s\S]*\nKen Ito\n9 Elm St\nAustin, TX 78701\nDear Ito,\nGreetings from Austin\./);
  const merged = await download(page, info, 'merged-letters');
  const mergedXml = strFromU8(unzipSync(readFileSync(merged))['word/document.xml']);
  expect(mergedXml).not.toContain('MERGEFIELD');
  expect(mergedXml.match(/<w:sectPr/g)).toHaveLength(2);
  expect(errors).toEqual([]);
});

test('imports a workbook, applies rules and filters, and builds a label sheet', async ({ page }, info) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toHaveValue(/^A small beginning/);
  await page.getByRole('tab', { name: 'Mailings' }).click();
  await ribbon(page).getByRole('button', { name: 'Select Recipients' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Use an Existing List…' }).click();
  await (await chooser).setFiles('tests/fixtures/mail-merge/recipients.xlsx');
  const list = page.getByRole('dialog', { name: 'Mail Merge Recipients' });
  await expect(list).toContainText('2 of 2 recipients will be merged');
  await expect(list.getByRole('cell', { name: '2026-03-02' })).toBeVisible();
  await list.getByRole('button', { name: /^City/ }).click();
  await expect(list.locator('tbody tr').first()).toContainText('Austin');
  await list.getByRole('checkbox', { name: 'Include recipient 1' }).uncheck();
  await expect(list).toContainText('1 of 2 recipients will be merged');
  await list.getByRole('button', { name: 'OK' }).click();

  // An If…Then…Else rule with a nested field.
  await caret(input, 0);
  await ribbon(page).getByRole('button', { name: 'Rules' }).click();
  await page.getByRole('menuitem', { name: 'If…Then…Else…' }).click();
  const rule = page.getByRole('dialog', { name: 'If…Then…Else Rule' });
  await rule.getByLabel('Field name').selectOption('City');
  await rule.getByLabel('Compare to').fill('Austin');
  await rule.getByLabel('Insert this text', { exact: true }).fill('Howdy');
  await rule.getByLabel('Otherwise insert this text').fill('Hello');
  await rule.getByRole('button', { name: 'Insert' }).click();
  await expect(input).toHaveValue(/^HowdyA small beginning/);
  await ribbon(page).getByRole('button', { name: 'Preview Results' }).click();
  await expect(input).toHaveValue(/^HowdyA small/);
  const saved = await download(page, info, 'rules');
  const xml = strFromU8(unzipSync(readFileSync(saved))['word/document.xml']);
  expect(xml).toContain('<w:instrText xml:space="preserve"> IF "</w:instrText>');
  expect(xml).toContain('<w:instrText xml:space="preserve"> MERGEFIELD City </w:instrText>');
  await reopenDocx(page, input, saved, await input.inputValue());
  await expect(input).toHaveJSProperty('readOnly', false);

  // Start a labels merge: a new label sheet with an address block in every label.
  await page.getByRole('tab', { name: 'Mailings' }).click();
  await ribbon(page).getByRole('button', { name: 'Start Mail Merge' }).click();
  await page.getByRole('menuitemradio', { name: 'Labels…' }).click();
  const options = page.getByRole('dialog', { name: 'Label Options' });
  await options.getByLabel('Label sheet', { exact: true }).selectOption('letter-10');
  acceptNext(page);
  await options.getByRole('button', { name: 'OK' }).click();
  await expect(input).toHaveValue(/^«AddressBlock»\s+«Next Record»«AddressBlock»/);
  await expect(page.locator('.canvas-title')).toHaveValue('Labels');
  await page.getByRole('tab', { name: 'Mailings' }).click();
  await expect(ribbon(page).getByRole('button', { name: 'Update Labels' })).toBeEnabled();
  await ribbon(page).getByRole('button', { name: 'Update Labels' }).click();
  const labels = await download(page, info, 'labels-main');
  const settings = strFromU8(unzipSync(readFileSync(labels))['word/settings.xml']);
  expect(settings).toContain('<w:mainDocumentType w:val="mailingLabels"/>');
  expect(errors).toEqual([]);
});

test('adds an envelope to the document and prints labels from the Labels dialog', async ({ page }, info) => {
  test.setTimeout(90000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toHaveValue(/^A small beginning/);
  await page.getByRole('tab', { name: 'Mailings' }).click();
  await ribbon(page).getByRole('button', { name: 'Envelopes', exact: true }).click();
  const envelope = page.getByRole('dialog', { name: 'Envelopes' });
  await envelope.getByRole('textbox', { name: 'Delivery address' }).fill('Rosa Vidal\n1 Pier Rd\nOslo');
  await envelope.getByRole('textbox', { name: 'Return address' }).fill('Sam Lee\n4 Main St');
  await envelope.getByLabel('Envelope size').selectOption('dl');
  await expect(envelope.locator('.mm-envelope-preview text')).toHaveCount(5);
  await envelope.getByRole('button', { name: 'Add to Document' }).click();
  await expect(input).toHaveValue(/^Sam Lee\n4 Main St\nRosa Vidal\n1 Pier Rd\nOslo\nA small beginning/);
  await expect(page.locator('canvas.canvas-page')).toHaveCount(2);
  const saved = await download(page, info, 'envelope');
  const xml = strFromU8(unzipSync(readFileSync(saved))['word/document.xml']);
  expect(xml).toMatch(/<w:pgSz w:w="12472" w:h="6236" w:orient="landscape"\/>/);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(input).toHaveValue(/^A small beginning/);

  await ribbon(page).getByRole('button', { name: 'Labels', exact: true }).click();
  const labels = page.getByRole('dialog', { name: 'Labels' });
  await labels.getByRole('textbox', { name: 'Address' }).fill('Sam Lee\n4 Main St');
  await labels.getByLabel('Label sheet', { exact: true }).selectOption('a4-21');
  await expect(labels.locator('.mm-sheet-preview rect.mm-label')).toHaveCount(21);
  await labels.getByRole('radio', { name: 'A single label' }).check();
  await labels.getByLabel('Row').fill('2');
  await labels.getByLabel('Column').fill('3');
  await expect(labels.locator('.mm-sheet-preview rect.is-on')).toHaveCount(1);
  await labels.getByRole('radio', { name: 'Full page of the same label' }).check();
  acceptNext(page);
  await labels.getByRole('button', { name: 'New Document' }).click();
  await expect(page.locator('.canvas-title')).toHaveValue('Labels');
  await expect(input).toHaveValue(/^Sam Lee\n4 Main St[\s\S]{1,4}Sam Lee\n4 Main St/);
  const sheet = await download(page, info, 'label-sheet');
  expect(strFromU8(unzipSync(readFileSync(sheet))['word/document.xml']).match(/<w:tc>/g).length).toBeGreaterThanOrEqual(21);
  expect(errors).toEqual([]);
});

test('prints one copy per recipient and saves email messages when sending is unavailable', async ({ page }, info) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { window.print = () => { window.printCalls = (window.printCalls || 0) + 1; }; });
  await page.goto('/playground.html');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toHaveValue(/^A small beginning/);
  await page.getByRole('tab', { name: 'Mailings' }).click();
  await page.locator('input[type=file][accept*=".xlsx"]').setInputFiles('tests/fixtures/mail-merge/recipients.csv');
  await page.getByRole('dialog', { name: 'Mail Merge Recipients' }).getByRole('button', { name: 'OK' }).click();
  await ribbon(page).getByRole('button', { name: 'Start Mail Merge' }).click();
  await page.getByRole('menuitemradio', { name: 'Email Messages' }).click();
  await caret(input, 0);
  await ribbon(page).getByRole('button', { name: 'Insert Merge Field' }).click();
  await page.getByRole('menuitem', { name: 'First Name', exact: true }).click();
  await page.keyboard.type(', your order is ready. ');
  await expect(input).toHaveValue(/^«First Name», your order is ready\. A small/);

  // Print: three recipients, one page each, captured in one print job; the placeholders return afterwards.
  await ribbon(page).getByRole('button', { name: 'Finish & Merge' }).click();
  await page.getByRole('menuitem', { name: 'Print Documents…' }).click();
  await page.getByRole('dialog', { name: 'Merge to Printer' }).getByRole('button', { name: 'OK' }).click();
  await expect.poll(() => page.evaluate(() => window.printCalls)).toBe(1);
  await expect(page.locator('.print-stage canvas')).toHaveCount(3);
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(page.locator('.print-stage')).toHaveCount(0);
  await expect(input).toHaveValue(/^«First Name», your order is ready\./);

  // Email: without a mail account the messages download as .eml files; Ana has no address.
  await ribbon(page).getByRole('button', { name: 'Finish & Merge' }).click();
  await page.getByRole('menuitem', { name: 'Send Email Messages…' }).click();
  const options = page.getByRole('dialog', { name: 'Merge to Email' });
  await expect(options.getByLabel('To', { exact: true })).toHaveValue('Email');
  await options.getByLabel('Subject line').fill('Your order');
  const zip = page.waitForEvent('download');
  await options.getByRole('button', { name: 'Continue' }).click();
  const path = info.outputPath('messages.zip');
  await (await zip).saveAs(path);
  const files = unzipSync(readFileSync(path));
  expect(Object.keys(files)).toEqual(['001 rosa@example.com.eml', '002 ken@example.com.eml']);
  const first = strFromU8(files['001 rosa@example.com.eml']);
  expect(first).toContain('To: rosa@example.com\r\nSubject: Your order\r\n');
  const body = first.split('Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n--')[0];
  expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toMatch(/^Rosa, your order is ready\. A small beginning/);
  const saved = await download(page, info, 'email-main');
  expect(strFromU8(unzipSync(readFileSync(saved))['word/settings.xml'])).toContain('<w:mainDocumentType w:val="email"/>');
  expect(strFromU8(unzipSync(readFileSync(saved))['word/settings.xml'])).toContain('<w:mailSubject w:val="Your order"/>');
  expect(errors).toEqual([]);
});
