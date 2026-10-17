import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {unzipSync} from 'fflate';
import {showAllTools,onTab} from './helpers/editor-tools.js';
import {reopenDocx} from './helpers/reopen-docx.js';
const source='tests/fixtures/hyperlink-fields/control.docx';
test('navigates field links and edits one paragraph of a spanning link without losing other targets',async({page},info)=>{
 test.setTimeout(180000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.fieldLinkOpens=[];window.open=(...args)=>{window.fieldLinkOpens.push(args);return null;};});
 await page.goto('/playground.html');await showAllTools(page);await page.getByLabel('Open DOCX file').setInputFiles(source);
 const input=page.getByRole('textbox',{name:'Document text'});await expect(input).toHaveValue(/^Hyperlink field controls/);await expect(input).toHaveJSProperty('readOnly',false);await expect(page.locator('canvas.canvas-page')).toHaveCount(2);
 const original=await input.inputValue(),parts=unzipSync(readFileSync(source));
 const reopen=async(path,text)=>{page.removeAllListeners('dialog');await reopenDocx(page,input,path,text);};
 const choose=async text=>input.evaluate((el,text)=>{const at=el.value.indexOf(text)+1;el.focus();el.setSelectionRange(at,at);el.dispatchEvent(new Event('select',{bubbles:true}));},text);
 const dialog=async()=>{await input.press('ControlOrMeta+k');await expect(page.getByRole('dialog')).toBeVisible();};
 const save=async name=>{const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath(name+'.docx');await(await pending).saveAs(path);return path;};
 for(const label of ['Internal target','Native flag target','Simple target','Second part']){
  await choose(label);await dialog();await page.getByRole('dialog').getByRole('button',{name:'Open link',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await input.evaluate(el=>el.selectionStart)).toBe(original.indexOf('Destination'));
 }
 await choose('External reference');await dialog();await page.getByRole('dialog').getByRole('button',{name:'Open link',exact:true}).click();
 expect(await page.evaluate(()=>window.fieldLinkOpens)).toEqual([['https://example.com/reference?q=a%20b','_blank','noopener,noreferrer']]);
 await choose('First part');await dialog();await page.getByRole('dialog').getByRole('button',{name:'Remove link',exact:true}).click();
 const changed=await save('removed-first-paragraph');await reopen(changed,original);
 await choose('Second part');await dialog();await page.getByRole('dialog').getByRole('button',{name:'Open link',exact:true}).click();expect(await input.evaluate(el=>el.selectionStart)).toBe(original.indexOf('Destination'));
 await choose('First part');await expect((await onTab(page,'insert')).getByRole('button',{name:'Insert or edit link',exact:true})).toHaveAttribute('aria-pressed','false');
 await reopen(source,original);
 const at=original.indexOf('Empty complex: [')+'Empty complex: ['.length;
 await input.evaluate((el,at)=>{el.focus();el.setSelectionRange(at,at);el.dispatchEvent(new Event('select',{bubbles:true}));},at);await page.keyboard.insertText('Filled');
 const filled=original.slice(0,at)+'Filled'+original.slice(at);await expect(input).toHaveValue(filled);const output=await save('refilled');
 await page.getByRole('button',{name:'Undo',exact:true}).click();await expect(input).toHaveValue(original);expect(unzipSync(readFileSync(await save('undo')))).toEqual(parts);
 await reopen(output,filled);await choose('Filled');await dialog();await page.getByRole('dialog').getByRole('button',{name:'Open link',exact:true}).click();expect(await input.evaluate(el=>el.selectionStart)).toBe(filled.indexOf('Destination'));expect(errors).toEqual([]);
});
