import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';
import { reopenDocx } from './helpers/reopen-docx.js';

const SHOTS = process.env.INSERT_SHOTS || '';
const shot = (page, name) => SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : null;
async function start(page, { text = 'First paragraph of the document.', width = 1440 } = {}) {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill(text);
  await onTab(page, 'insert');
  return { input, errors, ribbon: page.locator('#ribbon-panel-insert') };
}
/** Download the document, keep a copy for schema validation, and return its parts. */
async function save(page, info, name) {
  const path = info.outputPath(`${name}.docx`);
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  mkdirSync('test-results/insert-exports', { recursive: true }); copyFileSync(path, `test-results/insert-exports/${name}.docx`);
  const parts = unzipSync(new Uint8Array(readFileSync(path)));
  return { path, parts, xml: name => strFromU8(parts[name]) };
}
const undo = page => page.getByRole('button', { name: 'Undo', exact: true }).click();

test('cover pages, headers, footers and page number formats', async ({ page }, info) => {
  test.setTimeout(90000);
  const { input, errors, ribbon } = await start(page);
  await ribbon.getByRole('button', { name: 'Cover Page', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Sidebar' })).toBeVisible();
  await shot(page, 'cover-gallery');
  await page.getByRole('menuitem', { name: 'Block' }).click();
  await expect.poll(() => input.inputValue()).toContain('Company name');
  await expect(page.locator('canvas.canvas-page')).toHaveCount(2);
  // Choosing another design replaces the cover; removing it restores the document.
  await ribbon.getByRole('button', { name: 'Cover Page', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Remove Current Cover Page' }).click();
  await expect(input).toHaveValue('First paragraph of the document.');
  await undo(page);
  await expect.poll(() => input.inputValue()).toContain('Company name');

  await ribbon.getByRole('button', { name: 'Header', exact: true }).click();
  await shot(page, 'header-gallery');
  await page.getByRole('menuitem', { name: /^Banded/ }).click();
  await expect(page.getByRole('tab', { name: 'Header & Footer' })).toBeVisible();
  await onTab(page, 'insert');
  await ribbon.getByRole('button', { name: 'Footer', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Page X of Y/ }).click();
  await onTab(page, 'insert');
  await ribbon.getByRole('button', { name: 'Page Number', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Format Page Numbers…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Page Number Format' });
  await dialog.getByRole('combobox', { name: 'Number format' }).selectOption('lowerRoman');
  await dialog.getByRole('radio', { name: 'Start at' }).click();
  await dialog.getByRole('spinbutton', { name: 'Start at' }).fill('3');
  await shot(page, 'page-number-format');
  await dialog.getByRole('button', { name: 'OK' }).click();
  const { path, xml } = await save(page, info, 'headers-footers');
  expect(xml('word/document.xml')).toMatch(/<w:pgNumType w:fmt="lowerRoman" w:start="3"\/>/);
  const stories = Object.keys(unzipSync(new Uint8Array(readFileSync(path)))).filter(p => /word\/(header|footer)\d*\.xml/.test(p)).map(p => xml(p)).join('');
  expect(stories).toMatch(/w:instr=" PAGE "/); expect(stories).toMatch(/w:instr=" NUMPAGES "/); expect(stories).toMatch(/<w:shd [^>]*w:fill="2F5597"/);
  await reopenDocx(page, input, path, await input.inputValue(), { timeout: 20000 });
  expect(errors).toEqual([]);
});

test('text boxes, WordArt, signature lines, drop caps, date fields and fields', async ({ page }, info) => {
  test.setTimeout(120000);
  const { input, errors, ribbon } = await start(page, { text: 'Hello world, this paragraph begins with a large letter. '.repeat(4) });
  // Drop cap: the first letter moves into its own framed paragraph, and None puts it back.
  await ribbon.getByRole('button', { name: 'Drop Cap', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Dropped' }).click();
  await expect.poll(() => input.inputValue()).toMatch(/^H\nello world/);
  await ribbon.getByRole('button', { name: 'Drop Cap', exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Dropped' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('menuitem', { name: 'Drop Cap Options…' }).click();
  const cap = page.getByRole('dialog', { name: 'Drop Cap' });
  await cap.getByRole('spinbutton', { name: 'Lines to drop' }).fill('2');
  await shot(page, 'drop-cap-dialog');
  await cap.getByRole('button', { name: 'OK' }).click();
  await shot(page, 'drop-cap');
  await input.press('ControlOrMeta+End');
  // Text box from the gallery opens its text for editing.
  await ribbon.getByRole('button', { name: 'Text Box', exact: true }).click();
  await shot(page, 'text-box-gallery');
  await page.getByRole('menuitem', { name: /^Sidebar/ }).click();
  const drawingText = page.getByRole('dialog', { name: 'Edit drawing text' });
  await expect(drawingText).toBeVisible();
  await drawingText.getByRole('button', { name: 'Cancel' }).click();
  await input.press('ControlOrMeta+End');
  // WordArt
  await ribbon.getByRole('button', { name: 'WordArt', exact: true }).click();
  await shot(page, 'wordart-gallery');
  await page.getByRole('menuitem', { name: 'Fill: White, Outline: Blue' }).click();
  await expect(page.getByRole('dialog', { name: 'Edit drawing text' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Edit drawing text' }).getByRole('button', { name: 'Cancel' }).click();
  await input.press('ControlOrMeta+End');
  // Signature line
  await ribbon.getByRole('button', { name: 'Signature Line', exact: true }).click();
  const signature = page.getByRole('dialog', { name: 'Signature Line' });
  await signature.getByRole('textbox', { name: 'Suggested signer', exact: true }).fill('Sam Lee');
  await signature.getByRole('textbox', { name: 'Suggested signer’s title' }).fill('Director');
  await signature.getByRole('button', { name: 'Insert' }).click();
  await input.press('ControlOrMeta+End');
  // Date and time as a field
  await ribbon.getByRole('button', { name: 'Date & Time', exact: true }).click();
  const date = page.getByRole('dialog', { name: 'Date and Time' });
  await date.getByRole('option').nth(2).click();
  await date.getByRole('checkbox', { name: 'Update automatically' }).check();
  await shot(page, 'date-time');
  await date.getByRole('button', { name: 'Insert' }).click();
  // Field dialog: AUTHOR in uppercase
  await input.press('ControlOrMeta+End'); await page.keyboard.type(' by ');
  await ribbon.getByRole('button', { name: 'Quick Parts', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Field…' }).click();
  const field = page.getByRole('dialog', { name: 'Field' });
  await field.getByRole('listbox', { name: 'Field names' }).selectOption('FILENAME');
  await field.getByRole('combobox', { name: 'Format' }).selectOption('Upper');
  await expect(field.locator('.insert-field-code')).toHaveText('{ FILENAME \\* Upper \\* MERGEFORMAT }');
  await shot(page, 'field-dialog');
  await field.getByRole('button', { name: 'Insert' }).click();
  await expect.poll(() => input.inputValue()).toMatch(/ by UNTITLED DOCUMENT\.DOCX$/);
  // AutoText: save a selection, then insert it again.
  await input.evaluate(el => { el.setSelectionRange(1, 12); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await ribbon.getByRole('button', { name: 'Quick Parts', exact: true }).click();
  await page.getByRole('menuitem', { name: 'AutoText' }).click();
  await page.getByRole('menuitem', { name: 'Save Selection to AutoText Gallery…' }).click();
  await page.getByRole('dialog', { name: 'Create New Building Block' }).getByRole('textbox').fill('Greeting');
  await page.getByRole('dialog', { name: 'Create New Building Block' }).getByRole('button', { name: 'Save' }).click();
  await input.press('ControlOrMeta+End');
  await ribbon.getByRole('button', { name: 'Quick Parts', exact: true }).click();
  await page.getByRole('menuitem', { name: 'AutoText' }).click();
  await page.getByRole('menuitem', { name: /^Greeting/ }).click();
  await expect.poll(() => input.inputValue()).toMatch(/ello world$/);
  const { path, xml } = await save(page, info, 'text-group');
  const body = xml('word/document.xml');
  expect(body).toMatch(/<w:framePr [^>]*w:dropCap="drop"[^>]*w:lines="2"|<w:framePr [^>]*w:lines="2"[^>]*w:dropCap="drop"/);
  expect(body.match(/<wps:txbx>/g)).toHaveLength(3);
  expect(body).toMatch(/w14:textOutline/);
  expect(body).toContain('Sam Lee');
  expect(body).toMatch(/DATE \\@ "MMMM d, yyyy"/);
  expect(body).toMatch(/FILENAME \\\* Upper/);
  await reopenDocx(page, input, path, await input.inputValue(), { timeout: 20000 });
  expect(errors).toEqual([]);
});

test('icons, diagrams, charts, drawn shapes and SVG pictures save as drawings and reopen editable', async ({ page }, info) => {
  test.setTimeout(150000);
  const { input, errors, ribbon } = await start(page, { text: 'Illustrations.' });
  // Icons: search, choose two, recolor and insert.
  await ribbon.getByRole('button', { name: 'Icons', exact: true }).click();
  const icons = page.getByRole('dialog', { name: 'Icons' });
  await icons.getByRole('searchbox', { name: 'Search icons' }).fill('light');
  await icons.locator('.insert-icon').first().click();
  await icons.getByRole('searchbox', { name: 'Search icons' }).fill('');
  await icons.locator('.insert-icon').nth(3).click();
  await shot(page, 'icons-dialog');
  await icons.getByRole('button', { name: 'Insert (2)' }).click();
  await expect.poll(() => input.inputValue()).toBe('Illustrations.￼￼');
  await input.press('ControlOrMeta+End'); await input.press('Enter');
  // Diagram: an organization chart typed as an outline.
  await ribbon.getByRole('button', { name: 'Diagram', exact: true }).click();
  await shot(page, 'diagram-gallery');
  await page.getByRole('menuitem', { name: /^Organization Chart/ }).click();
  const diagram = page.getByRole('dialog', { name: 'Diagram' });
  await diagram.getByRole('textbox', { name: 'Diagram text' }).fill('Director\n  Design\n  Engineering\n    Web\n    Mobile\n  Sales');
  await shot(page, 'diagram-dialog');
  await diagram.getByRole('button', { name: 'Insert' }).click();
  await expect.poll(() => input.inputValue()).toMatch(/\n￼$/);
  // Editing regenerates the same drawing with the new text, in one undo step.
  await page.locator('canvas.canvas-page').first().click({ button: 'right', position: { x: 300, y: 260 } }).catch(() => {});
  await page.keyboard.press('Escape');
  await input.evaluate(el => { const at = el.value.lastIndexOf('￼'); el.setSelectionRange(at, at + 1); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await onTab(page, 'insert');
  await ribbon.getByRole('button', { name: 'Diagram', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit Selected Diagram…' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit Diagram' });
  await expect(edit.getByRole('textbox', { name: 'Diagram text' })).toHaveValue('Director\n  Design\n  Engineering\n    Web\n    Mobile\n  Sales');
  await edit.getByRole('option', { name: /^Basic Process/ }).click();
  await edit.getByRole('button', { name: 'Update' }).click();
  await input.press('ControlOrMeta+End'); await input.press('Enter');
  // Chart: a bar chart with edited data.
  await ribbon.getByRole('button', { name: 'Chart', exact: true }).click();
  const chart = page.getByRole('dialog', { name: 'Insert Chart' });
  await chart.getByRole('option', { name: 'Clustered Bar' }).click().catch(async () => chart.getByRole('option').nth(3).click());
  await chart.getByRole('textbox', { name: 'Chart title' }).fill('Quarterly sales');
  await chart.getByRole('textbox', { name: 'Category 1', exact: true }).fill('North');
  await shot(page, 'chart-dialog');
  await chart.getByRole('button', { name: 'Insert' }).click();
  await expect.poll(() => input.inputValue()).toMatch(/\n￼$/);
  await shot(page, 'illustrations');
  await onTab(page, 'insert');
  // A shape drawn by dragging on the page takes the dragged size.
  await ribbon.getByRole('button', { name: 'Shapes', exact: true }).click();
  await shot(page, 'shapes-gallery');
  await page.getByRole('menuitem', { name: 'Flowchart: Decision' }).click();
  const box = await page.locator('canvas.canvas-page').first().boundingBox();
  const top = Math.max(box.y, 0) + 300; // A visible spot beside the chart.
  await page.mouse.move(box.x + 640, top); await page.mouse.down(); await page.mouse.move(box.x + 736, top + 48, { steps: 4 }); await page.mouse.up();
  await expect(page.getByRole('spinbutton', { name: 'Shape width (in)' })).toHaveValue('1');
  await expect(page.getByRole('spinbutton', { name: 'Shape height (in)' })).toHaveValue('0.5');
  await onTab(page, 'insert');
  // An SVG picture is stored with a PNG fallback.
  await page.getByLabel('Insert picture file').setInputFiles({ name: 'mark.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32" viewBox="0 0 64 32"><rect width="64" height="32" rx="6" fill="#2F5597"/></svg>') });
  await expect.poll(async () => (await input.inputValue()).split('￼').length - 1).toBe(6);
  const { path, parts, xml } = await save(page, info, 'illustrations');
  const media = Object.keys(parts).filter(p => p.startsWith('word/media/'));
  expect(media.filter(p => p.endsWith('.svg'))).toHaveLength(3);
  expect(media.filter(p => p.endsWith('.png'))).toHaveLength(3);
  expect(Object.keys(parts).filter(p => /^word\/charts\/.*\.xml$/.test(p))).toHaveLength(1);
  const body = xml('word/document.xml');
  expect(body).toMatch(/wpg:wgp/); expect(body).toContain('Diagram: Basic Process');
  expect(body).toMatch(/prst="flowChartDecision"/);
  expect(xml(Object.keys(parts).find(p => /^word\/charts\/.*\.xml$/.test(p)))).toMatch(/<c:barDir val="bar"\/>/);
  await reopenDocx(page, input, path, await input.inputValue(), { timeout: 30000 });
  await expect(page.locator('.canvas-message')).not.toContainText('read-only');
  expect(errors).toEqual([]);
});

test('a chart that reads its data from a workbook is not offered for data editing', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/playground.html');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/chart-metadata-basic.docx');
  await expect.poll(() => input.inputValue()).toContain('\ufffc');
  const at = (await input.inputValue()).indexOf('\ufffc');
  await input.evaluate((el, at) => { el.focus(); el.setSelectionRange(at, at + 1); el.dispatchEvent(new Event('select', { bubbles: true })); }, at);
  // With the chart selected, Chart edits it: its data lives in a workbook, so it is kept as it is.
  await (await onTab(page, 'insert')).locator('#ribbon-panel-insert').getByRole('button', { name: 'Chart', exact: true }).click();
  await expect(page.getByText('This chart’s data cannot be edited here. It is kept as it is.').first()).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Edit Chart' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the equation preview hint stays readable on its paper in the dark theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  const { input } = await start(page, { text: 'Formula: ' });
  await input.press('ControlOrMeta+End');
  await page.keyboard.press(process.platform === 'darwin' ? 'Control+Equal' : 'Alt+Equal');
  const hint = page.getByRole('dialog', { name: 'Equation' }).locator('.insert-equation-preview .field-hint');
  await expect(hint).toHaveText('Type an equation to see it here.');
  const ratio = await hint.evaluate(node => {
    const rgb = color => { const c = document.createElement('canvas').getContext('2d'); c.fillStyle = color; c.fillRect(0, 0, 1, 1); return [...c.getImageData(0, 0, 1, 1).data].slice(0, 3); };
    const luminance = color => rgb(color).map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const [a, b] = [luminance(getComputedStyle(node).color), luminance(getComputedStyle(node.closest('.insert-equation-preview')).backgroundColor)];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
});

test('equations, symbols and text from a file', async ({ page }, info) => {
  test.setTimeout(120000);
  const { input, errors, ribbon } = await start(page, { text: 'Formula: ' });
  await input.press('ControlOrMeta+End');
  // Ctrl+= (Alt+= off the Mac) opens the equation editor with a live preview.
  await page.keyboard.press(process.platform === 'darwin' ? 'Control+Equal' : 'Alt+Equal');
  const equation = page.getByRole('dialog', { name: 'Equation' });
  await equation.getByRole('textbox', { name: 'Equation in linear format' }).fill('x = (-b ± √(b^2 - 4ac))/2a');
  await expect(equation.locator('.insert-equation-preview math mfrac')).toHaveCount(1);
  await shot(page, 'equation-dialog');
  await equation.getByRole('button', { name: 'Insert' }).click();
  await expect.poll(() => input.inputValue()).toBe('Formula: ￼');
  // Equation gallery
  await page.getByRole('button', { name: 'Equation gallery' }).click();
  await shot(page, 'equation-gallery');
  await page.getByRole('menuitem', { name: /^Pythagorean/ }).click();
  // Symbols: the More Symbols dialog stays open for several characters.
  await input.press('ControlOrMeta+End');
  await ribbon.getByRole('button', { name: 'Symbol', exact: true }).click();
  await page.getByRole('menuitem', { name: 'More Symbols…' }).click();
  const symbols = page.getByRole('dialog', { name: 'Symbol' });
  await symbols.getByRole('textbox', { name: 'Character code (hexadecimal)' }).fill('2603');
  await symbols.getByRole('button', { name: 'Insert' }).click();
  await symbols.getByRole('radio', { name: 'Special Characters' }).click();
  await symbols.getByRole('option', { name: /Em Dash/ }).click();
  await shot(page, 'symbol-dialog');
  await symbols.getByRole('button', { name: 'Insert' }).click();
  await symbols.getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => input.inputValue()).toMatch(/☃—$/);
  // Recently used symbols lead the Symbol gallery.
  await ribbon.getByRole('button', { name: 'Symbol', exact: true }).click();
  await expect(page.getByRole('menu').getByRole('menuitem').first()).toHaveAccessibleName(/^—/);
  await page.keyboard.press('Escape');
  // Text from a Markdown file keeps its headings and emphasis.
  await input.press('ControlOrMeta+End'); await input.press('Enter');
  await ribbon.getByRole('button', { name: 'Object', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Text from File…' }).click();
  await (await chooser).setFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\n\nSome **bold** words.') });
  await expect.poll(() => input.inputValue()).toMatch(/Notes\nSome bold words\.$/);
  const { path, xml } = await save(page, info, 'equations-symbols');
  const body = xml('word/document.xml');
  expect(body.match(/<m:oMath[ >]/g)?.length).toBeGreaterThanOrEqual(2);
  expect(body).toMatch(/<m:f>/); expect(body).toContain('☃');
  await reopenDocx(page, input, path, await input.inputValue(), { timeout: 20000 });
  expect(errors).toEqual([]);
});

test('the Date and Time and Special Characters lists are one Tab stop with arrow-key movement', async ({ page }) => {
  const { input, errors, ribbon } = await start(page, { text: 'Dated ' });
  await input.press('ControlOrMeta+End');
  const tabStops = list => list.getByRole('option').evaluateAll(options => options.filter(o => o.tabIndex >= 0).length);
  // Date and Time: focus starts on the chosen format; Tab leaves the list for the checkbox.
  await ribbon.getByRole('button', { name: 'Date & Time', exact: true }).click();
  const date = page.getByRole('dialog', { name: 'Date and Time' }), formats = date.getByRole('listbox', { name: 'Available formats' });
  await expect(formats.getByRole('option').first()).toBeFocused();
  expect(await tabStops(formats)).toBe(1);
  await page.keyboard.press('End');
  await expect(formats.getByRole('option').last()).toBeFocused();
  await expect(formats.getByRole('option').last()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown');
  await expect(formats.getByRole('option').nth(1)).toBeFocused();
  await expect(formats.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
  expect(await tabStops(formats)).toBe(1);
  await page.keyboard.press('Tab');
  await expect(date.getByRole('checkbox', { name: 'Update automatically' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(formats.getByRole('option').nth(1)).toBeFocused();
  await date.getByRole('button', { name: 'Cancel' }).click();
  // Special Characters: one Tab stop; the arrows choose the character Insert puts in.
  await ribbon.getByRole('button', { name: 'Symbol', exact: true }).click();
  await page.getByRole('menuitem', { name: 'More Symbols…' }).click();
  const symbols = page.getByRole('dialog', { name: 'Symbol' });
  await symbols.getByRole('radio', { name: 'Special Characters' }).click();
  const special = symbols.getByRole('listbox', { name: 'Special characters' });
  expect(await tabStops(special)).toBe(1);
  await special.getByRole('option', { name: /Em Dash/ }).click();
  await page.keyboard.press('ArrowDown');
  const next = special.getByRole('option', { name: /En Dash/ });
  await expect(next).toBeFocused();
  await expect(next).toHaveAttribute('aria-selected', 'true');
  expect(await tabStops(special)).toBe(1);
  await page.keyboard.press('Tab');
  expect(await special.evaluate(list => list.contains(document.activeElement))).toBe(false);
  await symbols.getByRole('button', { name: 'Insert' }).click();
  await symbols.getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => input.inputValue()).toBe('Dated –');
  expect(errors).toEqual([]);
});

test('Text from File reads Unicode and Windows text files as opening them does', async ({ page }) => {
  const { input, errors, ribbon } = await start(page, { text: 'Start' });
  const insert = async (name, buffer) => {
    await input.press('ControlOrMeta+End'); await input.press('Enter');
    await ribbon.getByRole('button', { name: 'Object', exact: true }).click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('menuitem', { name: 'Text from File…' }).click();
    await (await chooser).setFiles({ name, mimeType: 'text/plain', buffer });
  };
  // Notepad's "Unicode" is UTF-16 with a byte order mark; older editors save in the Windows code page.
  await insert('unicode.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Grüße 😀\r\nZweite Zeile', 'utf16le')]));
  await expect.poll(() => input.inputValue()).toBe('Start\nGrüße 😀\nZweite Zeile');
  await insert('legacy.txt', Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x35]));
  await expect.poll(() => input.inputValue()).toBe('Start\nGrüße 😀\nZweite Zeile\nCafé €5');
  expect(errors).toEqual([]);
});

test('Text from File puts a web page in a table cell as its paragraphs, without its scripts or styles', async ({ page }) => {
  const { input, errors, ribbon } = await start(page, { text: 'Start' });
  await ribbon.getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByRole('button', { name: 'Insert', exact: true }).click();
  await ribbon.getByRole('button', { name: 'Object', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Text from File…' }).click();
  await (await chooser).setFiles({ name: 'page.html', mimeType: 'text/html', buffer: Buffer.from('<!doctype html><html><head><title>Page</title></head><body><style>p { color: red }</style><script>var secret = 1;</script>\n<h1>Heading</h1>\n<p>First\n   paragraph.</p><p>Second<br>line</p></body></html>') });
  await expect.poll(() => input.inputValue()).toContain('Heading\nFirst paragraph.\nSecond');
  expect(await input.inputValue()).not.toMatch(/color: red|secret/);
  // The caret was in the table's first cell, where formatting does not carry: the text went in there.
  await expect(ribbon.page().getByRole('tab', { name: 'Table Design' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Text from File puts a Markdown file in a table cell as its text, without its marks', async ({ page }) => {
  const { input, errors, ribbon } = await start(page, { text: 'Start' });
  await ribbon.getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByRole('button', { name: 'Insert', exact: true }).click();
  await ribbon.getByRole('button', { name: 'Object', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Text from File…' }).click();
  await (await chooser).setFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\n\nSome **bold** words and a [link](https://example.com).\n\n- item\n') });
  await expect.poll(() => input.inputValue()).toContain('Notes\nSome bold words and a link.\nitem');
  expect(await input.inputValue()).not.toMatch(/[#*[\]]/);
  await expect(ribbon.page().getByRole('tab', { name: 'Table Design' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Text from File leaves out what opening the file leaves out: hidden text, menus and front matter', async ({ page }) => {
  const { input, errors, ribbon } = await start(page, { text: 'Start' });
  const insert = async (name, mimeType, source) => {
    await input.press('ControlOrMeta+End'); await input.press('Enter');
    await ribbon.getByRole('button', { name: 'Object', exact: true }).click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('menuitem', { name: 'Text from File…' }).click();
    await (await chooser).setFiles({ name, mimeType, buffer: Buffer.from(source) });
  };
  await insert('page.html', 'text/html', '<nav>Home | About</nav><p>Shown</p><p hidden>Hidden note</p><div style="display:none">Popup text</div><p>Also shown</p>');
  await expect.poll(() => input.inputValue()).toBe('Start\nShown\nAlso shown');
  await insert('post.md', 'text/markdown', '---\ntitle: Draft\n---\n\nPost body\n');
  await expect.poll(() => input.inputValue()).toBe('Start\nShown\nAlso shown\nPost body');
  await insert('log.txt', 'text/plain', 'one\u0000two\u0007\n');
  await expect.poll(() => input.inputValue()).toBe('Start\nShown\nAlso shown\nPost body\nonetwo');
  expect(errors).toEqual([]);
});

test('a picture Puter AI could not make is explained in plain words', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  // The SDK rejects with its own error object rather than an Error.
  await page.evaluate(() => { puter.ai.txt2img = async () => { throw { success: false, error: { code: 'insufficient_funds', message: 'Insufficient funds' } }; }; });
  await (await onTab(page, 'insert')).locator('#ribbon-panel-insert').getByRole('button', { name: 'Pictures', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Generate with AI…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Generate a Picture' });
  await dialog.getByRole('textbox', { name: 'Describe the picture' }).fill('A lighthouse at dawn');
  await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Your Puter AI allowance has run out for now.');
  await expect(dialog).not.toContainText('Generating');
  await expect(dialog.getByRole('button', { name: 'Generate', exact: true })).toBeEnabled();
});

test('a picture made with Puter AI takes its description as its alternative text', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await (await onTab(page, 'insert')).locator('#ribbon-panel-insert').getByRole('button', { name: 'Pictures', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Generate with AI…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Generate a Picture' });
  await dialog.getByRole('textbox', { name: 'Describe the picture' }).fill('A lighthouse at dawn');
  await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
  await dialog.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__docs.current.view.engine.model.paragraphs.flatMap(p => p.runs).find(r => r.image)?.image.alt)).toBe('A lighthouse at dawn');
});
