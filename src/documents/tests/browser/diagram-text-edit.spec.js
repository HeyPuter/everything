import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';

// A diagram keeps its outline as its description, which Edit Diagram reads back. Text typed into its
// shapes goes into that outline, so Edit Diagram no longer brings the old text back and the description
// read to screen readers says what the shapes show.
const descr = async (page, info, name) => {
  const download = page.waitForEvent('download'); await downloadDocx(page);
  const path = info.outputPath(name); await (await download).saveAs(path);
  const xml = strFromU8(unzipSync(readFileSync(path))['word/document.xml']);
  return xml.match(/<wp:docPr\b[^>]*\bdescr="([^"]*)"/)[1].replace(/&#10;/g, '\n');
};
const contextMenu = async page => {
  const frame = await page.locator('.canvas-image-frame').boundingBox();
  await page.mouse.click(frame.x + frame.width / 2, frame.y + frame.height / 2, { button: 'right' });
  return page.getByRole('menu').first();
};

test('text typed into a diagram\'s shapes is what Edit Diagram shows and what its description says', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Start. '); await input.press('End');
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Diagram', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Basic Process/ }).click();
  await page.getByRole('dialog', { name: 'Diagram' }).getByRole('button', { name: 'Insert', exact: true }).click();
  await expect(page.locator('.canvas-image-frame')).toBeVisible();
  const original = await descr(page, info, 'inserted.docx');
  expect(original).toBe('Diagram: Basic Process (Blue)\nPlan\n  Goals\n  Budget\nBuild\n  Prototype\nReview\nLaunch');

  // The second shape shows "Build" and its sub-item: rename it and add a sub-item.
  await (await contextMenu(page)).getByRole('menuitem', { name: 'Edit drawing text', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Text frame 2', exact: true }).click();
  const draft = page.getByRole('dialog', { name: 'Edit drawing text' });
  await expect(draft).toBeVisible();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Construct'); await page.keyboard.press('Enter');
  await page.keyboard.type('Prototype'); await page.keyboard.press('Enter'); await page.keyboard.type('Pilot');
  await draft.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(draft).toBeHidden();
  const edited = 'Diagram: Basic Process (Blue)\nPlan\n  Goals\n  Budget\nConstruct\n  Prototype\n  Pilot\nReview\nLaunch';
  expect(await descr(page, info, 'edited.docx')).toBe(edited);

  await (await contextMenu(page)).getByRole('menuitem', { name: 'Edit Diagram…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Diagram' });
  await expect(dialog.getByRole('textbox').first()).toHaveValue('Plan\n  Goals\n  Budget\nConstruct\n  Prototype\n  Pilot\nReview\nLaunch');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

  // One step: Undo puts back the shape's text and the outline together.
  await input.focus(); await input.press('ControlOrMeta+z');
  expect(await descr(page, info, 'undone.docx')).toBe(original);
  expect(errors).toEqual([]);
});
