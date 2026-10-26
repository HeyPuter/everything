import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';
import { reopenDocx } from './helpers/reopen-docx.js';

// Picture Format, Shape Format and Arrange: formatting, wrapping, positioning, grouping and the panes.
const SHOTS = process.env.PICTURE_SHOTS || '';
const shot = (page, name) => SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : null;
const PNG = readFileSync('icon-128.png');
const OBJECT = '￼';

async function start(page, { width = 1440 } = {}) {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Pictures and shapes sit beside this paragraph of text. '.repeat(6));
  await input.press('ControlOrMeta+Home');
  return { input, errors };
}
async function insertPicture(page, input) {
  await onTab(page, 'insert');
  await page.getByLabel('Insert picture file').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
  await expect.poll(async () => (await input.inputValue()).split(OBJECT).length - 1).toBeGreaterThan(0);
  await expect(page.locator('#ribbon-tab-picture')).toBeVisible();
  await expect(page.locator('#ribbon-tab-picture')).toHaveAttribute('aria-selected', 'true');
  return page.locator('#ribbon-panel-picture');
}
async function insertShape(page, name = 'Rectangle', at = { x: 420, y: 380 }) {
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Shapes', exact: true }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
  // The gallery starts drawing: drag on the page to place the shape.
  const box = await page.locator('canvas.canvas-page').first().boundingBox();
  await page.mouse.move(box.x + at.x, box.y + at.y); await page.mouse.down(); await page.mouse.move(box.x + at.x + 120, box.y + at.y + 70, { steps: 4 }); await page.mouse.up();
  await expect(page.locator('#ribbon-tab-shapeFormat')).toBeVisible();
  await onTab(page, 'shapeFormat');
  return page.locator('#ribbon-panel-shapeFormat');
}
/** A ribbon command, opening its group's drop-down first when the window folded the group. */
async function ribbonCommand(page, panel, group, name) {
  const direct = panel.getByRole('button', { name, exact: true });
  if (await direct.isVisible()) return direct;
  await panel.getByRole('button', { name: group, exact: true }).click();
  return page.locator('.ribbon-flyout').getByRole('button', { name, exact: true });
}
async function save(page, info, name) {
  const path = info.outputPath(`${name}.docx`);
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  mkdirSync('test-results/pictures-exports', { recursive: true }); copyFileSync(path, `test-results/pictures-exports/${name}.docx`);
  const parts = unzipSync(new Uint8Array(readFileSync(path)));
  return { path, parts, xml: part => strFromU8(parts[part]) };
}
const undoButton = page => page.getByRole('button', { name: 'Undo', exact: true }).first();

test('picture styles, border, effects, corrections, color, transparency and alt text', async ({ page }, info) => {
  test.setTimeout(180000);
  const { input, errors } = await start(page);
  const ribbon = await insertPicture(page, input);
  await shot(page, 'picture-format');
  // Picture Styles gallery: a white frame with a shadow.
  // A narrow ribbon (or a wide UI font) shows fewer thumbnails; the rest are in the gallery's More menu.
  const whiteFrame = ribbon.getByRole('option', { name: 'White Frame', exact: true });
  if (await whiteFrame.isVisible()) await whiteFrame.click();
  else { await ribbon.getByRole('button', { name: 'More Picture Styles', exact: true }).click(); await page.getByRole('menuitem', { name: 'White Frame', exact: true }).click(); }
  await expect(undoButton(page)).toBeEnabled();
  // Picture Border: a theme color and a weight.
  await ribbon.getByRole('button', { name: 'Picture Border', exact: true }).click();
  await shot(page, 'picture-border');
  await page.getByRole('menuitem', { name: 'Red', exact: true }).click();
  await ribbon.getByRole('button', { name: 'Picture Border', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Weight' }).click();
  await page.getByRole('menuitemradio', { name: '3 pt' }).click();
  // Picture Effects → Shadow.
  await ribbon.getByRole('button', { name: 'Picture Effects', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Shadow' }).click();
  await page.getByRole('menuitemradio', { name: 'Offset: Bottom', exact: true }).click();
  // Corrections: brightness/contrast; Color: grayscale; Transparency.
  await ribbon.getByRole('button', { name: 'Corrections', exact: true }).click();
  await shot(page, 'corrections');
  await page.getByRole('menuitem', { name: 'Brightness: +20% Contrast: +20%' }).click();
  await ribbon.getByRole('button', { name: 'Color', exact: true }).click();
  await shot(page, 'color');
  await page.getByRole('menuitem', { name: 'Grayscale' }).click();
  await ribbon.getByRole('button', { name: 'Transparency', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Transparency: 30%' }).click();
  // Alt Text pane.
  await ribbon.getByRole('button', { name: 'Alt Text', exact: true }).click();
  const alt = page.getByRole('complementary', { name: 'Alt Text pane' });
  await alt.getByRole('textbox', { name: 'Description' }).fill('A blue square logo');
  await alt.getByRole('button', { name: 'Save' }).click();
  await shot(page, 'alt-text');
  await alt.getByRole('button', { name: 'Close Alt Text pane' }).click();
  const { path, xml } = await save(page, info, 'picture-format');
  const body = xml('word/document.xml');
  expect(body).toMatch(/<a:ln w="38100"><a:solidFill><a:srgbClr val="E02424"\/>/);
  expect(body).toMatch(/<a:outerShdw [^>]*dir="5400000"/);
  expect(body).toMatch(/<a:grayscl\/>/);
  expect(body).toMatch(/<a:lum bright="20000" contrast="20000"\/>/);
  expect(body).toMatch(/<a:alphaModFix amt="70000"\/>/);
  expect(body).toMatch(/descr="A blue square logo"/);
  await reopenDocx(page, input, path, await input.inputValue(), { timeout: 30000 });
  await expect(page.locator('.canvas-message')).not.toContainText('read-only');
  expect(errors).toEqual([]);
});

test('wrap text, position, layout dialog, rotate and crop to shape', async ({ page }, info) => {
  test.setTimeout(180000);
  const { input, errors } = await start(page);
  const ribbon = await insertPicture(page, input);
  await ribbon.getByRole('button', { name: 'Wrap Text', exact: true }).click();
  await shot(page, 'wrap-text');
  await page.getByRole('menuitemradio', { name: 'Square' }).click();
  await expect.poll(async () => (await save(page, info, 'wrap-square')).xml('word/document.xml')).toMatch(/<wp:wrapSquare wrapText="bothSides"\/>/);
  await ribbon.getByRole('button', { name: 'Position', exact: true }).click();
  await shot(page, 'position');
  await page.getByRole('menuitem', { name: 'Position in Top Right with Square Text Wrapping' }).click();
  // Layout dialog: Tight wrapping with larger distances; then a rotation.
  await ribbon.getByRole('button', { name: 'Size and Position…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Layout' });
  await dialog.getByRole('tab', { name: 'Text Wrapping' }).click();
  await dialog.getByText('Tight', { exact: true }).click();
  await dialog.getByRole('spinbutton', { name: 'Distance from text left (in)' }).fill('0.25');
  await dialog.getByRole('tab', { name: 'Size' }).click();
  await dialog.getByRole('spinbutton', { name: 'Rotation (degrees)' }).fill('0');
  await shot(page, 'layout-dialog');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeHidden();
  await ribbon.getByRole('button', { name: 'Rotate', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Flip Horizontal' }).click();
  // Crop to Shape: an oval.
  await ribbon.getByRole('button', { name: 'Crop options' }).click();
  await page.getByRole('menuitem', { name: 'Crop to Shape' }).click();
  await page.getByRole('menuitem', { name: 'Oval', exact: true }).click();
  const { path, xml } = await save(page, info, 'picture-layout');
  const body = xml('word/document.xml');
  expect(body).toMatch(/<wp:wrapTight wrapText="bothSides"><wp:wrapPolygon/);
  expect(body).toMatch(/distL="228600"/);
  expect(body).toMatch(/prst="ellipse"/);
  expect(body).toMatch(/flipH="1"/);
  await reopenDocx(page, input, path, await input.inputValue(), { timeout: 30000 });
  await expect(page.locator('.canvas-message')).not.toContainText('read-only');
  expect(errors).toEqual([]);
});

test('shape styles, fill, outline, effects, WordArt and Format pane', async ({ page }, info) => {
  test.setTimeout(180000);
  const { input, errors } = await start(page);
  const ribbon = await insertShape(page, 'Rounded Rectangle');
  await shot(page, 'shape-format');
  await ribbon.getByRole('option', { name: 'Colored Fill: Accent 2' }).click();
  await ribbon.getByRole('button', { name: 'Shape Fill', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Gradient' }).click();
  await page.getByRole('menuitem', { name: 'Linear Down' }).click();
  await ribbon.getByRole('button', { name: 'Shape Outline', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Dashes' }).click();
  await page.getByRole('menuitemradio', { name: 'Dash', exact: true }).click();
  await ribbon.getByRole('button', { name: 'Shape Effects', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Shadow' }).click();
  await page.getByRole('menuitemradio', { name: 'Offset: Bottom Right' }).click();
  // Format pane: line width.
  await ribbon.getByRole('button', { name: 'Format Shape', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Format pane' });
  await expect(pane.getByRole('heading', { name: 'Format Shape' })).toBeVisible();
  await pane.getByRole('spinbutton', { name: 'Width' }).fill('2.5'); await pane.getByRole('spinbutton', { name: 'Width' }).press('Enter');
  await shot(page, 'format-pane');
  await pane.getByRole('button', { name: 'Close Format pane' }).click();
  // A text box: WordArt quick style, middle alignment and a different shape.
  await ribbon.getByRole('button', { name: 'Draw Text Box', exact: true }).click();
  const textDialog = page.getByRole('dialog', { name: 'Edit drawing text' });
  await expect(textDialog).toBeVisible();
  await textDialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(textDialog).toHaveCount(0);
  await onTab(page, 'shapeFormat');
  await (await ribbonCommand(page, ribbon, 'WordArt Styles', 'Quick Styles')).click();
  await shot(page, 'wordart-styles');
  await page.getByRole('menuitem', { name: 'Fill: Gold, Shadow' }).click();
  await (await ribbonCommand(page, ribbon, 'Text', 'Align Text')).click();
  await page.getByRole('menuitemradio', { name: 'Middle' }).click();
  await ribbon.getByRole('button', { name: 'Edit Shape', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Change Shape' }).click();
  await page.getByRole('menuitem', { name: 'Oval', exact: true }).click();
  const { path, xml } = await save(page, info, 'shape-format');
  const body = xml('word/document.xml');
  expect(body).toMatch(/<w14:textFill><w14:solidFill><w14:srgbClr w14:val="FFC000"\/>/);
  expect(body).toMatch(/anchor="ctr"/);
  expect(body).toMatch(/<wps:txbx>[\s\S]*|prst="ellipse"/);
  expect(body).toMatch(/prst="ellipse"/);
  expect(body).toMatch(/<a:gradFill rotWithShape="1">/);
  expect(body).toMatch(/<a:prstDash val="dash"\/>/);
  expect(body).toMatch(/<a:ln w="31750"/);
  expect(body).toMatch(/<a:outerShdw /);
  await reopenDocx(page, input, path, await input.inputValue(), { timeout: 30000 });
  await expect(page.locator('.canvas-message')).not.toContainText('read-only');
  expect(errors).toEqual([]);
});

test('selection pane, align, group and ungroup', async ({ page }, info) => {
  test.setTimeout(180000);
  const { input, errors } = await start(page);
  await insertShape(page, 'Oval', { x: 160, y: 420 });
  const ribbon = await insertShape(page, 'Rectangle', { x: 460, y: 470 });
  await ribbon.getByRole('button', { name: 'Selection Pane', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Selection pane' });
  await expect(pane.getByRole('listitem')).toHaveCount(2);
  // A list of buttons (a listbox's options cannot hold the name and visibility buttons); selected objects are current.
  await expect(pane.getByRole('listbox')).toHaveCount(0);
  await expect(pane.getByRole('listitem').nth(1).getByRole('button')).toHaveCount(2);
  await expect(pane.locator('[aria-current="true"]')).toHaveCount(1);
  await shot(page, 'selection-pane');
  // Rename and select both from the pane.
  const first = pane.getByRole('listitem').first().locator('.pic-selection-name');
  await first.dblclick();
  await pane.getByRole('textbox').fill('Blue box'); await pane.getByRole('textbox').press('Enter');
  await expect(pane.getByRole('listitem').first()).toContainText('Blue box');
  await pane.getByRole('listitem').nth(1).locator('.pic-selection-name').click({ modifiers: ['Shift'] });
  await ribbon.getByRole('button', { name: 'Align', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Align Top' }).click();
  await pane.getByRole('listitem').first().locator('.pic-selection-name').click();
  await pane.getByRole('listitem').nth(1).locator('.pic-selection-name').click({ modifiers: ['Shift'] });
  await ribbon.getByRole('button', { name: 'Group', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Group', exact: true }).click();
  await expect(pane.getByRole('listitem')).toHaveCount(1);
  let saved = await save(page, info, 'grouped');
  expect(saved.xml('word/document.xml')).toMatch(/<wpg:wgp>/);
  await ribbon.getByRole('button', { name: 'Group', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Ungroup' }).click();
  await expect(pane.getByRole('listitem')).toHaveCount(2);
  saved = await save(page, info, 'ungrouped');
  expect(saved.xml('word/document.xml')).not.toMatch(/<wpg:wgp>/);
  expect(saved.xml('word/document.xml')).toMatch(/name="Blue box"/);
  await reopenDocx(page, input, saved.path, await input.inputValue(), { timeout: 30000 });
  expect(errors).toEqual([]);
});

test('remove background, artistic effects, layout options, compress and rotating a shape on the page', async ({ page }, info) => {
  test.setTimeout(240000);
  const { input, errors } = await start(page);
  const ribbon = await insertPicture(page, input);
  await ribbon.getByRole('button', { name: 'Remove Background', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove Background' });
  await expect(dialog.getByText(/of the picture will be removed/)).toBeVisible();
  await shot(page, 'remove-background');
  await dialog.getByRole('button', { name: 'Keep Changes' }).click();
  await expect(dialog).toBeHidden();
  await ribbon.getByRole('button', { name: 'Artistic Effects', exact: true }).click();
  await shot(page, 'artistic-effects');
  await page.getByRole('menuitem', { name: /Pencil/ }).click();
  // The processed picture keeps the original in its original layer.
  await expect.poll(async () => (await save(page, info, 'processed')).xml('word/document.xml'), { timeout: 30000 }).toMatch(/a14:imgLayer[^>]*r:embed=[\s\S]*a14:backgroundRemoval[\s\S]*a14:artistic/);
  // Layout Options beside the picture: in front of text.
  await page.getByRole('button', { name: 'Layout Options' }).click();
  await shot(page, 'layout-options');
  await page.getByRole('menuitemradio', { name: 'In Front of Text' }).click();
  await expect.poll(async () => (await save(page, info, 'front')).xml('word/document.xml')).toMatch(/<wp:wrapNone\/>/);
  // Compress Pictures: the picture is resampled for 96 ppi and the original layer is dropped.
  await ribbon.getByRole('button', { name: 'Compress Pictures', exact: true }).click();
  const compress = page.getByRole('dialog', { name: 'Compress Pictures' });
  await compress.getByText('Email (96 ppi)').click();
  await compress.getByRole('button', { name: 'OK' }).click();
  await expect.poll(async () => (await save(page, info, 'compressed')).xml('word/document.xml'), { timeout: 30000 }).not.toMatch(/a14:imgLayer/);
  // A shape rotated with its handle: snapped to 15 degrees through the drawing's transform.
  await input.press('ControlOrMeta+End');
  await insertShape(page, 'Rectangle', { x: 300, y: 560 });
  const host = page.locator('.canvas-editor-content');
  const rotate = host.getByRole('button', { name: 'Rotate image', exact: true });
  await expect(rotate).toBeVisible();
  const frame = await host.locator('.canvas-image-frame').first().boundingBox(), handle = await rotate.boundingBox();
  const cx = frame.x + frame.width / 2, cy = frame.y + frame.height / 2;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.keyboard.down('Shift'); await page.mouse.down();
  await page.mouse.move(cx + 80, cy - 70, { steps: 6 }); await page.mouse.move(cx + 120, cy - 10, { steps: 4 });
  await page.mouse.up(); await page.keyboard.up('Shift');
  const { path, xml } = await save(page, info, 'rotated-shape');
  await expect.poll(async () => (await save(page, info, 'rotated-shape')).xml('word/document.xml')).toMatch(/<wps:spPr><a:xfrm rot="(5400000|4500000|3600000|6300000)"/);
  void xml;
  await reopenDocx(page, input, path, await input.inputValue(), { timeout: 30000 });
  expect(errors).toEqual([]);
});

test('alt text typed for one picture stays with it when another object or the text is selected', async ({ page }, info) => {
  const { input, errors } = await start(page);
  await insertPicture(page, input);
  await onTab(page, 'insert');
  await page.getByLabel('Insert picture file').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
  await expect.poll(async () => (await input.inputValue()).split(OBJECT).length - 1).toBe(2);
  await onTab(page, 'picture');
  // The second picture is selected: describe it, then click the first one without saving first.
  await page.locator('#ribbon-panel-picture').getByRole('button', { name: 'Alt Text', exact: true }).click();
  const alt = page.getByRole('complementary', { name: 'Alt Text pane' }), description = alt.getByRole('textbox', { name: 'Description' });
  await expect(alt).toContainText('Picture 2');
  await description.fill('Second picture');
  const box = await page.locator('canvas.canvas-page').first().boundingBox();
  await page.mouse.click(box.x + 136, box.y + 136);
  await expect(alt).toContainText('Picture 1');
  await expect(description).toHaveValue('');
  // A description left in the field when clicking into the text is kept too.
  await description.fill('First picture');
  await page.mouse.click(box.x + 600, box.y + 300);
  await expect(alt).toContainText('Select a picture or shape');
  await expect.poll(async () => [...(await save(page, info, 'alt-text-owner')).xml('word/document.xml').matchAll(/<wp:docPr [^>]*>/g)].map(m => m[0].match(/descr="([^"]*)"/)?.[1] ?? ''))
    .toEqual(['First picture', 'Second picture']);
  expect(errors).toEqual([]);
});

test('the Layout dialog keeps an untouched size and free rotation exactly, and shows the tab of an invalid field', async ({ page }, info) => {
  const { input, errors } = await start(page);
  const ribbon = await insertPicture(page, input);
  // Rotate freely with the handle (no Shift): a fractional angle.
  const host = page.locator('.canvas-editor-content');
  const frame = await host.locator('.canvas-image-frame').first().boundingBox(), handle = await host.getByRole('button', { name: 'Rotate image', exact: true }).boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down(); await page.mouse.move(frame.x + frame.width / 2 + 37, frame.y + frame.height / 2 - 90, { steps: 5 }); await page.mouse.up();
  const frameXml = xml => [xml.match(/<wp:extent [^>]*>/)[0], xml.match(/<a:xfrm[^>]*>/)[0]];
  let before;
  await expect.poll(async () => { before = frameXml((await save(page, info, 'layout-exact-before')).xml('word/document.xml')); return before[1]; }).toMatch(/rot="\d*[1-9]\d{0,3}"/);
  // A 128 px picture is 1.333… in wide; the dialog shows 1.33 and must not resize it to that.
  await ribbon.getByRole('button', { name: 'Size and Position…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Layout' });
  await dialog.getByRole('tab', { name: 'Text Wrapping' }).click();
  await dialog.getByText('In front of text', { exact: true }).click();
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeHidden();
  const after = frameXml((await save(page, info, 'layout-exact-after')).xml('word/document.xml'));
  expect(after).toEqual(before);
  expect(after[0]).toBe('<wp:extent cx="1219200" cy="1219200"/>');
  // An invalid size entered on the Size tab is pointed out there, whichever tab is showing on OK.
  await ribbon.getByRole('button', { name: 'Size and Position…' }).click();
  await dialog.getByRole('tab', { name: 'Size' }).click();
  await dialog.getByRole('spinbutton', { name: 'Width (in)' }).fill('0');
  await dialog.getByRole('tab', { name: 'Position' }).click();
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog.getByRole('tab', { name: 'Size' })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('spinbutton', { name: 'Width (in)' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(errors).toEqual([]);
});

test('pictures over the session limits are scaled down on insertion and on Change Picture', async ({ page }, info) => {
  test.setTimeout(120000);
  const { input, errors } = await start(page);
  // A 24-megapixel camera JPEG and a large WebP, drawn in the page.
  const picture = (type, width, height) => page.evaluate(async ([type, width, height]) => {
    const canvas = Object.assign(document.createElement('canvas'), { width, height }), g = canvas.getContext('2d');
    for (let i = 0; i < 60; i++) { g.fillStyle = `hsl(${i * 37 % 360} 70% 50%)`; g.fillRect(i * width / 60, (i * 7 % 10) * height / 10, width / 5, height / 5); }
    const blob = await new Promise(resolve => canvas.toBlob(resolve, type, 0.9));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, [type, width, height]).then(bytes => Buffer.from(bytes));
  const size = bytes => bytes[0] === 0x89 ? [bytes.readUInt32BE(16), bytes.readUInt32BE(20)] : (() => {
    for (let at = 2; at < bytes.length;) { const marker = bytes[at + 1], length = bytes.readUInt16BE(at + 2); if (marker >= 0xc0 && marker <= 0xc2) return [bytes.readUInt16BE(at + 7), bytes.readUInt16BE(at + 5)]; at += 2 + length; }
  })();
  await onTab(page, 'insert');
  await page.getByLabel('Insert picture file').setInputFiles({ name: 'camera.jpg', mimeType: 'image/jpeg', buffer: await picture('image/jpeg', 6000, 4000) });
  await expect.poll(async () => (await input.inputValue()).split(OBJECT).length - 1).toBe(1);
  await onTab(page, 'insert');
  await page.getByLabel('Insert picture file').setInputFiles({ name: 'large.webp', mimeType: 'image/webp', buffer: await picture('image/webp', 4500, 4500) });
  await expect.poll(async () => (await input.inputValue()).split(OBJECT).length - 1).toBe(2);
  let { parts } = await save(page, info, 'large-pictures');
  const media = () => Object.entries(parts).filter(([name]) => name.startsWith('word/media/')).map(([name, bytes]) => [name.split('.').pop(), ...size(Buffer.from(bytes))]).sort();
  expect(media()).toEqual([['jpg', 4096, 2731], ['png', 4000, 4000]]);
  // Change Picture takes the same route.
  await onTab(page, 'picture');
  await page.getByLabel('Change picture file').setInputFiles({ name: 'camera.jpg', mimeType: 'image/jpeg', buffer: await picture('image/jpeg', 4000, 6000) });
  await expect.poll(async () => { ({ parts } = await save(page, info, 'large-pictures-changed')); return media(); }).toContainEqual(['jpg', 2731, 4096]);
  expect(errors).toEqual([]);
});

test('Picture Format at phone width', async ({ page }) => {
  const { input, errors } = await start(page, { width: 390 });
  await insertPicture(page, input);
  await shot(page, 'phone-picture-format');
  await onTab(page, 'picture');
  await page.locator('#ribbon-panel-picture').getByRole('button', { name: 'Alt Text', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Alt Text pane' })).toBeVisible();
  await shot(page, 'phone-alt-text');
  expect(errors).toEqual([]);
});
