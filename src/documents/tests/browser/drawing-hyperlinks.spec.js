import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { showAllTools } from './helpers/editor-tools.js';
import { reopenDocx } from './helpers/reopen-docx.js';
const sourcePath='tests/fixtures/drawing-hyperlinks/precedence.docx';
const source=readFileSync(sourcePath), reference=JSON.parse(readFileSync('tests/fixtures/drawing-hyperlinks/reference.json'));
const sameParts=(actual,expected,except=[])=>{expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());for(const name of Object.keys(expected))if(!except.includes(name))expect(Buffer.from(actual[name]).equals(Buffer.from(expected[name])),name).toBe(true);};
const outer='https://example.com/outer', changed='https://example.com/changed';
async function open(page, path = sourcePath) {
  await page.addInitScript(()=>{window.linkOpens=[];window.open=(...args)=>{window.linkOpens.push(args);return null;};});
  await page.goto('/playground.html');await showAllTools(page);await page.getByLabel('Open DOCX file').setInputFiles(path);
  const input=page.getByRole('textbox',{name:'Document text'});await expect(input).toHaveValue(/^Control 1:/);await expect(input).toHaveJSProperty('readOnly',false);return input;
}
async function geometry(page, bytes = source) {
  return page.evaluate(async bytes=>{
    const {DocxPackage}=await import('/src/engine/docx.js');const {layoutDocument}=await import('/src/engine/layout.js');
    const {pageGeometry}=await import('/src/engine/page-settings.js');const {loadCanvasFonts,measureCanvasText}=await import('/src/engine/canvas-text.js');
    const p=await DocxPackage.open(new Uint8Array(bytes));await loadCanvasFonts(p);const c=document.createElement('canvas').getContext('2d');
    const layout=layoutDocument(p.paragraphs,(t,s)=>measureCanvasText(c,t,s),pageGeometry(p.pageSettings),p.numbering,p.tables);
    return {pages:layout.pageCount,width:layout.pages[0].width,frames:layout.lines.flatMap(l=>l.fragments.filter(f=>f.image).map(f=>({start:f.start,end:f.end,page:l.page,x:f.x,y:l.baseline-f.ascent,width:f.image.width/9525,height:f.image.height/9525,target:f.image.hyperlink?.target})))};
  },[...bytes]);
}
async function choose(input,index=0) {await input.evaluate((e,index)=>{const positions=[...e.value.matchAll(/\ufffc/g)].map(m=>m.index);e.focus();e.setSelectionRange(positions[index],positions[index]+1);e.dispatchEvent(new Event('select',{bubbles:true}));},index);}
async function save(page,info,name) {const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath(name+'.docx');await(await pending).saveAs(path);return path;}

test('matches native linked picture frames and opens only active outer links',async({page},info)=>{
  const hash=b=>createHash('sha256').update(b).digest('hex');expect(hash(source)).toBe(reference.sourceSha256);expect(hash(readFileSync('tests/fixtures/drawing-hyperlinks/precedence.pdf'))).toBe(reference.pdfSha256);
  await open(page);const g=await geometry(page);expect(g.pages).toBe(reference.pages);expect(g.frames).toHaveLength(4);
  const active=g.frames.filter(f=>f.target);expect(active).toHaveLength(reference.links.length);
  reference.links.forEach((r,i)=>{expect(active[i].target).toBe(r.target);for(const key of ['x','y','width','height'])expect(Math.abs(active[i][key]*.75-r[key]),key).toBeLessThan(.15);});
  writeFileSync(info.outputPath('geometry.json'),JSON.stringify(g,null,2));
  const canvas=page.locator('canvas.canvas-page').first();await canvas.scrollIntoViewIfNeeded();const box=await canvas.boundingBox(),scale=box.width/g.width;
  for(const index of [0,1,2,3]){const f=g.frames[index];await page.keyboard.down('Control');await page.mouse.click(box.x+(f.x+f.width/2)*scale,box.y+(f.y+f.height/2)*scale);await page.keyboard.up('Control');}
  expect(await page.evaluate(()=>window.linkOpens)).toEqual([[outer,'_blank','noopener,noreferrer'],[outer,'_blank','noopener,noreferrer']]);
  sameParts(unzipSync(readFileSync(await save(page,info,'noedit'))),unzipSync(source));
  writeFileSync(info.outputPath('page1.png'),Buffer.from((await canvas.evaluate(c=>c.toDataURL())).split(',')[1],'base64'));
});

test('edits, removes and undoes drawing links using the existing keyboard dialog',async({page},info)=>{
  const input=await open(page),original=await input.inputValue();await choose(input);await input.press('ControlOrMeta+k');
  const address=page.getByRole('textbox',{name:'Link address',exact:true});await expect(address).toHaveValue(outer);await address.fill(changed);
  await page.getByRole('dialog').getByRole('button',{name:'Apply',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  const edited=await save(page,info,'edited'),parts=unzipSync(readFileSync(edited)),before=unzipSync(source);
  sameParts(parts,before,['word/document.xml','word/_rels/document.xml.rels']);
  await page.getByRole('button',{name:'Undo',exact:true}).click();sameParts(unzipSync(readFileSync(await save(page,info,'undo'))),before);
  await reopenDocx(page,input,edited,original);await choose(input);await input.press('ControlOrMeta+k');await expect(address).toHaveValue(changed);
  await page.getByRole('dialog').getByRole('button',{name:'Open link',exact:true}).click();expect(await page.evaluate(()=>window.linkOpens.at(-1))).toEqual([changed,'_blank','noopener,noreferrer']);
  await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await page.getByRole('button',{name:'Remove link',exact:true}).click();
  const removed=await save(page,info,'removed');await reopenDocx(page,input,removed,original);await choose(input);
  // Selecting the drawing brings up its format tab; the Link command lives on Insert.
  await page.getByRole('tab',{name:'Insert',exact:true}).click();await expect(page.getByRole('button',{name:'Insert or edit link',exact:true})).toHaveAttribute('aria-pressed','false');
  await choose(input,2);await input.press('ControlOrMeta+k');await expect(address).toHaveValue(outer);
});

test('keeps quoted and named inner frames inactive through browser editing', async ({page}, info) => {
  const path = 'tests/fixtures/drawing-hyperlinks/inner-frames.docx', bytes = readFileSync(path);
  const ref = JSON.parse(readFileSync('tests/fixtures/drawing-hyperlinks/inner-frames-reference.json'));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(ref.sourceSha256);
  expect(createHash('sha256').update(readFileSync('tests/fixtures/drawing-hyperlinks/inner-frames.pdf')).digest('hex')).toBe(ref.pdfSha256);
  const input = await open(page, path), g = await geometry(page, bytes);
  expect(g.frames.filter(f => f.target).map(f => f.target)).toEqual(ref.links);
  const canvas = page.locator('canvas.canvas-page').first(); await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox(), scale = box.width / g.width;
  for (const f of g.frames) {
    await page.keyboard.down('Control'); await page.mouse.click(box.x + (f.x + f.width / 2) * scale, box.y + (f.y + f.height / 2) * scale); await page.keyboard.up('Control');
  }
  expect(await page.evaluate(() => window.linkOpens)).toEqual(ref.links.map(target => [target, '_blank', 'noopener,noreferrer']));
  sameParts(unzipSync(readFileSync(await save(page, info, 'inner-noedit'))), unzipSync(bytes));
  await input.focus(); await input.press('ControlOrMeta+Home'); await page.keyboard.insertText('Edit ');
  const edited = await save(page, info, 'inner-edited'), text = await input.inputValue();
  await input.press('ControlOrMeta+z'); sameParts(unzipSync(readFileSync(await save(page, info, 'inner-undo'))), unzipSync(bytes));
  await reopenDocx(page, input, edited, text); await expect(input).toHaveJSProperty('readOnly', false);
});
