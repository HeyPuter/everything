import { downloadDocx } from './helpers/editor-tools.js';
import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {openReadOnlyPreview} from './helpers/preview.js';
const source='tests/fixtures/preview-issues/control.docx';
for(const entry of ['/playground.html','/mock.html'])test('read-only feature list is specific, keyboard accessible and clears on the next document: '+entry,async({page},info)=>{
 await page.goto(entry);await openReadOnlyPreview(page,source);
 const notice=page.locator('.canvas-message'),summary=notice.locator('summary');
 await expect(summary).toContainText('Unsupported features detected');
 await summary.focus();await summary.press('Enter');
 const items=notice.locator('li');await expect(items.filter({hasText:'Right-to-left paragraph layout'})).toHaveCount(1);
 // Hidden text (w:vanish) is editable now, so its repeated declarations are not reported.
 await expect(items.filter({hasText:'Hidden text'})).toHaveCount(0);await expect(items.filter({hasText:/border/i})).toHaveCount(1);
 const labels=await items.allTextContents();expect(new Set(labels).size).toBe(labels.length);
 await expect(page.getByRole('textbox',{name:'Document text'})).toHaveJSProperty('readOnly',true);
 await expect(page.locator('canvas.canvas-page')).toHaveCount(1);
 await page.screenshot({path:info.outputPath('feature-list.png')});
 const event=page.waitForEvent('download');await downloadDocx(page);
 const path=info.outputPath('original.docx');await(await event).saveAs(path);expect(readFileSync(path)).toEqual(readFileSync(source));
 await summary.press('Enter');await expect(notice.locator('details')).not.toHaveAttribute('open','');
 await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/two-paragraphs.docx');
 if(entry==='/mock.html')await page.getByRole('button',{name:'Leave without saving',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Document text'})).toHaveJSProperty('readOnly',false);
 await expect(page.locator('.canvas-message')).toBeHidden();await expect(page.locator('.preview-features')).toHaveCount(0);
 await page.getByRole('textbox',{name:'Document text'}).press('ControlOrMeta+Home');await page.keyboard.insertText('EDIT ');
 await expect(page.getByRole('textbox',{name:'Document text'})).toHaveValue(/^EDIT /);
});
