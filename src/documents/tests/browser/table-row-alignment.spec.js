import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {unzipSync} from 'fflate';
import {showAllTools,onTab} from './helpers/editor-tools.js';
import {reopenDocx} from './helpers/reopen-docx.js';
const source='public/fixtures/table-row-alignment.docx';
const reference=JSON.parse(readFileSync('tests/fixtures/table-row-alignment/reference.json','utf8'));
test('matches native row alignment, exposes mixed state, and preserves structural edits and undo',async({page},info)=>{
 await page.goto('/playground.html');await showAllTools(page);await page.getByLabel('Open DOCX file').setInputFiles(source);
 const input=page.getByRole('textbox',{name:'Document text'});await expect(input).toHaveValue(/^Row alignment/);await expect(input).toHaveJSProperty('readOnly',false);await expect(page.locator('#playground-error')).toBeEmpty();
 const lines=await page.evaluate(async()=>{
  const {DocxPackage}=await import('/src/engine/docx.js');const {TextDocument}=await import('/src/engine/model.js');const {layoutDocument}=await import('/src/engine/layout.js');const {pageGeometry}=await import('/src/engine/page-settings.js');const {loadCanvasFonts,measureCanvasText}=await import('/src/engine/canvas-text.js');
  const p=await DocxPackage.open(new Uint8Array(await(await fetch('/fixtures/table-row-alignment.docx')).arrayBuffer()));await loadCanvasFonts(p);const d=new TextDocument(p.paragraphs,p.pageSettings,p.numbering,p.styles,p.tables,p.assets),ctx=document.createElement('canvas').getContext('2d');
  return layoutDocument(d.paragraphs,(t,s)=>measureCanvasText(ctx,t,s),pageGeometry(d.pageSettings),d.numbering,d.tables).lines.map(l=>({text:l.fragments.map(f=>f.text).join(''),x:l.fragments[0]?.x,y:l.baseline,page:l.page}));
 });
 for(const ref of reference.text){const line=lines.find(l=>l.text===ref.text);expect(line,ref.text).toBeTruthy();expect(Math.abs(line.x*.75-ref.x),ref.text).toBeLessThan(.3);}
 const canvas=page.locator('canvas.canvas-page').first();
 for(const text of ['T0R0C0','T0R1C0','T0R2C0']){const line=lines.find(l=>l.text===text);await canvas.click({position:{x:line.x+1,y:line.y-3}});expect(await input.evaluate((el,n)=>el.value.slice(el.selectionStart,el.selectionStart+n),text.length)).toBe(text);}
 await canvas.screenshot({path:info.outputPath('row-alignment.png')});
 const select=text=>input.evaluate((el,text)=>{const at=el.value.indexOf(text);el.setSelectionRange(at,at);el.dispatchEvent(new Event('select',{bubbles:true}));},text);
 // A closed modal stays in the DOM for its exit animation. The page can
 // reopen properties immediately; only the active dialog owns these controls.
 const dialog=page.locator('.modal-root:not(.closing)').getByRole('dialog',{name:'Table properties',exact:true});
 // Table properties is on the contextual Table Layout tab, which shows (unselected) inside a table.
 const properties=page.getByRole('button',{name:'Table properties',exact:true}),openProperties=async()=>{await onTab(page,'tableLayout');await properties.click();};
 await select('T0R0C0');await openProperties();await expect(dialog.getByLabel('Table alignment',{exact:true})).toHaveValue('mixed');await dialog.getByRole('button',{name:'Apply',exact:true}).click();await expect(page.getByRole('button',{name:'Undo',exact:true})).toBeDisabled();
 const download=async suffix=>{const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath(`row-alignment${suffix}.docx`);await(await pending).saveAs(path);return path;};
 await openProperties();await dialog.getByLabel('Table alignment',{exact:true}).selectOption('left');await dialog.getByRole('button',{name:'Apply',exact:true}).click();const aligned=await download('-aligned');await page.getByRole('button',{name:'Undo',exact:true}).click();
 await select('T0R1C0');await page.getByRole('combobox',{name:'Table actions',exact:true}).selectOption('addRow');await page.keyboard.insertText('New right row');const added=await download('-added');await input.press('ControlOrMeta+z');await input.press('ControlOrMeta+z');
 const original=await input.inputValue(),a=unzipSync(readFileSync(source)),b=unzipSync(readFileSync(await download('-undo')));for(const name of Object.keys(a))expect(Buffer.from(a[name]).equals(Buffer.from(b[name])),name).toBe(true);
 await reopenDocx(page,input,aligned,original);await select('T0R0C0');await openProperties();await expect(dialog.getByLabel('Table alignment',{exact:true})).toHaveValue('left');await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.getByLabel('Open DOCX file').setInputFiles(added);await expect(input).toHaveValue(/New right row/);await expect(page.locator('#playground-error')).toBeEmpty();
});
