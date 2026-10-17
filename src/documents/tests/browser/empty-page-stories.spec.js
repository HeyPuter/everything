import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {unzipSync} from 'fflate';
import {showAllTools} from './helpers/editor-tools.js';
const source='public/fixtures/empty-page-stories.docx',reference=JSON.parse(readFileSync('tests/fixtures/empty-page-stories/reference.json'));
test.use({deviceScaleFactor:2});
test('edits body and shared styles with empty header/footer variants, matching the native reference and retaining their XML',async({page},info)=>{
 test.setTimeout(120000);
 for(const[name,suffix]of[['plain',''],['shaded','-shaded']])for(const[file,hash]of[[`public/fixtures/empty-page-stories${suffix}.docx`,reference[name].sourceSha256],[`tests/fixtures/empty-page-stories/${name}-native.pdf`,reference[name].pdfSha256]])expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(hash);
 await page.goto('/playground.html');await showAllTools(page);await page.getByLabel('Open DOCX file').setInputFiles(source);const input=page.getByRole('textbox',{name:'Document text'});await expect(input).toHaveValue(reference.plain.text.join('\n'));await expect(input).toHaveJSProperty('readOnly',false);const original=await input.inputValue();
 const native=await page.evaluate(async()=>{try{await new FontFace('native control','local("Arial")').load();return true;}catch{return false;}});
 const check=async shaded=>{
  await expect(page.locator('#playground-error')).toBeEmpty();await expect(page.locator('canvas.canvas-page')).toHaveCount(3);
  // While the body is edited, header and footer bands are shown under a 52% white wash.
  const bands=await page.locator('canvas.canvas-page').evaluateAll(cs=>cs.map(c=>{const fill=(r,g,b)=>r===34&&g===170&&b===136||r===149&&g===214&&b===198;const scale=c.width/612,d=c.getContext('2d').getImageData(Math.round(500*scale),0,1,c.height).data,groups=[];for(let y=0;y<c.height;y++)if(fill(d[y*4],d[y*4+1],d[y*4+2])){const last=groups.at(-1);if(!last||y>last.end+1)groups.push({start:y,end:y});else last.end=y;}return groups.map(g=>({top:g.start/scale,bottom:(g.end+1)/scale}));}));
  for(let i=0;i<3;i++){const expected=reference[shaded?'shaded':'plain'].bands[i];expect(bands[i]).toHaveLength(expected.length);if(native)for(let j=0;j<expected.length;j++)for(const edge of ['top','bottom'])expect(Math.abs(bands[i][j][edge]-expected[j][edge]),`${i} ${j} ${edge}`).toBeLessThan(1);}
 };
 await check(false);await input.press('ControlOrMeta+Home');await page.keyboard.insertText('Edited ');await check(false);
 await page.getByRole('button',{name:'Edit paragraph style',exact:true}).click();await page.getByRole('textbox',{name:'Style paragraph fill',exact:true}).fill('22AA88');await page.getByRole('dialog').getByRole('button',{name:'Apply',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);await check(true);
 const save=async suffix=>{const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath('empty-page-stories-'+suffix+'.docx');await(await pending).saveAs(path);return path;};
 const edited=await save('edited'),parts=unzipSync(readFileSync(source)),out=unzipSync(readFileSync(edited));for(const[n,b]of Object.entries(parts))if(!['word/document.xml','word/styles.xml'].includes(n))expect(Buffer.from(out[n]).equals(Buffer.from(b)),n).toBe(true);
 await input.press('ControlOrMeta+z');await check(false);await input.press('ControlOrMeta+z');await expect(input).toHaveValue(original);expect(unzipSync(readFileSync(await save('undo')))).toEqual(parts);
 page.once('dialog',d=>d.accept());const before=await input.elementHandle();await page.getByLabel('Open DOCX file').setInputFiles(edited);await expect.poll(()=>before.evaluate(el=>el.isConnected)).toBe(false);await before.dispose();await expect(input).toHaveValue('Edited '+original);await expect(input).toHaveJSProperty('readOnly',false);await check(true);
});
