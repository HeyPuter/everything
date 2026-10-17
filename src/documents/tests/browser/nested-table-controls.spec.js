import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {unzipSync} from 'fflate';
import {showAllTools,onTab} from './helpers/editor-tools.js';
import {reopenDocx} from './helpers/reopen-docx.js';
const reference=JSON.parse(readFileSync('tests/fixtures/nested-tables/nested-width-reference.json','utf8'));
const select=async(input,label)=>input.evaluate((el,label)=>{const at=el.value.indexOf(label);el.focus();el.setSelectionRange(at,at);el.dispatchEvent(new Event('select',{bubbles:true}));},label);
async function bounds(page){
 await page.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
 return page.locator('canvas.canvas-page').first().evaluate(c=>{const pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let left=Infinity,right=-Infinity;for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){const at=4*(y*c.width+x);if([201,231,181].every((v,i)=>Math.abs(pixels[at+i]-v)<=1)){left=Math.min(left,x);right=Math.max(right,x+1);}}return {left:left*612/c.width,right:right*612/c.width};});
}
function matches(actual,expected){for(const edge of ['left','right'])expect(Math.abs(actual[edge]-expected[edge]),edge).toBeLessThan(1);}
for(const mode of ['width-half','width-half-15'])test(`uses native parent-relative percentages and exposes Fit to cell with undo and reopen: ${mode}`,async({page},info)=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/playground.html');await showAllTools(page);
 await page.getByLabel('Open DOCX file').setInputFiles(`tests/fixtures/nested-tables/nested-clipping-${mode}.docx`);const input=page.getByRole('textbox',{name:'Document text'});await expect(input).toHaveValue(/Inner line 6/);
 matches(await bounds(page),reference[mode].colors.inner);await select(input,'Inner line 1');
 const actions=page.getByRole('combobox',{name:'Table actions',exact:true});await expect(actions.locator('option[value="fitPage"]')).toHaveText('Fit to cell');
 await (await onTab(page,'tableLayout')).getByRole('button',{name:'Table properties',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('Percent widths use the containing cell’s writing width.');await page.getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 await actions.selectOption('fitPage');matches(await bounds(page),reference[mode.endsWith('-15')?'width-full-15':'width-full'].colors.inner);
 await page.getByRole('button',{name:'Undo',exact:true}).click();matches(await bounds(page),reference[mode].colors.inner);
 await page.getByRole('button',{name:'Redo',exact:true}).click();matches(await bounds(page),reference[mode.endsWith('-15')?'width-full-15':'width-full'].colors.inner);
 const event=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath('nested-fit-cell.docx');await(await event).saveAs(path);await reopenDocx(page,input,path,await input.inputValue());matches(await bounds(page),reference[mode.endsWith('-15')?'width-full-15':'width-full'].colors.inner);
 await select(input,'Outer before');await expect(actions.locator('option[value="fitPage"]')).toHaveText('Fit to page');await expect(actions.locator('option[value="repeatHeader"]')).toBeEnabled();expect(errors).toEqual([]);
});
test('explains preserved nested header flags and permits explicit removal and undo',async({page},info)=>{
 await page.goto('/playground.html');await showAllTools(page);const source='public/fixtures/nested-header-inner-15.docx';await page.getByLabel('Open DOCX file').setInputFiles(source);
 const input=page.getByRole('textbox',{name:'Document text'});await expect(input).toHaveValue(/Inner A1/);await select(input,'Inner A1');const actions=page.getByRole('combobox',{name:'Table actions',exact:true});
 await expect(actions).toBeEnabled();
 // Inspect the option itself; Playwright's disabled matcher follows its label
 // to the enclosing enabled select in this inspector.
 await expect(actions.locator('option[value="repeatHeader"]')).toHaveJSProperty('disabled',true);await expect(actions.locator('option[value="repeatHeader"]')).toHaveText('Nested tables do not repeat their own header rows');await expect(actions.locator('option[value="clearHeader"]')).toHaveText('Remove header flags');await expect(actions.locator('option[value="clearHeader"]')).toHaveJSProperty('disabled',false);
 await (await onTab(page,'tableLayout')).getByRole('button',{name:'Table properties',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('imported header flags are preserved until removed');await page.getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 await actions.selectOption('clearHeader');await expect(actions.locator('option[value="clearHeader"]')).toHaveJSProperty('disabled',true);await page.getByRole('button',{name:'Undo',exact:true}).click();await expect(actions.locator('option[value="clearHeader"]')).toHaveJSProperty('disabled',false);
 const event=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath('nested-header-flags-restored.docx');await(await event).saveAs(path);
 expect(unzipSync(readFileSync(path))).toEqual(unzipSync(readFileSync(source)));
 await reopenDocx(page,input,path,await input.inputValue());await select(input,'Outer before');await expect(actions.locator('option[value="repeatHeader"]')).toHaveJSProperty('disabled',false);
});
