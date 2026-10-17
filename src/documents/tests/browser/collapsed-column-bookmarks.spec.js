import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {unzipSync,strFromU8} from 'fflate';
import {showAllTools,onTab} from './helpers/editor-tools.js';
import {reopenDocx} from './helpers/reopen-docx.js';
const source='tests/fixtures/column-bookmarks/collapsed.docx';
test('navigates and edits a collapsed column-tagged bookmark without expanding its range',async({page},info)=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/playground.html');await showAllTools(page);
 await page.getByLabel('Open DOCX file').setInputFiles(source);
 const input=page.getByRole('textbox',{name:'Document text'});await expect(input).toHaveValue(/^MiddleColumn/);await expect(input).toBeEditable();
 const original=await input.inputValue(),parts=unzipSync(readFileSync(source));
 const save=async name=>{const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath(name+'.docx');await(await pending).saveAs(path);return path;};
 const go=async()=>{
  await (await onTab(page,'insert')).getByRole('button',{name:'Bookmarks',exact:true}).click();
  const list=page.getByRole('listbox',{name:'Document bookmarks',exact:true});await expect(list.locator('option')).toHaveCount(2);
  const id=await list.locator('option').filter({hasText:/^CollapsedCell ·/}).getAttribute('value');await list.selectOption(id);
  await page.getByRole('dialog').getByRole('button',{name:'Go to bookmark',exact:true}).click();
  const selection=await input.evaluate(el=>[el.selectionStart,el.selectionEnd]);expect(selection[0]).toBe(selection[1]);return selection[0];
 };
 expect(unzipSync(readFileSync(await save('noedit')))).toEqual(parts);
 const at=await go();expect(at).toBe(original.indexOf('T5R1C1'));
 await page.keyboard.insertText('Added ');const expected=original.slice(0,at)+'Added '+original.slice(at),edited=await save('edited');
 expect(await go()).toBe(at+6);
 const out=unzipSync(readFileSync(edited));for(const n of Object.keys(parts))if(n!=='word/document.xml'&&n!=='word/settings.xml')expect(out[n],n).toEqual(parts[n]);
 // The text changed, so the saved spelling and grammar completion flags no longer hold (§17.15.1.65).
 expect(strFromU8(out['word/settings.xml'])).toBe(strFromU8(parts['word/settings.xml']).replace('w:spelling="clean" w:grammar="clean"','w:spelling="dirty" w:grammar="dirty"'));
 await input.press('ControlOrMeta+z');await expect(input).toHaveValue(original);expect(unzipSync(readFileSync(await save('undo')))).toEqual(parts);
 await reopenDocx(page,input,edited,expected);expect(await go()).toBe(at+6);expect(errors).toEqual([]);
});
