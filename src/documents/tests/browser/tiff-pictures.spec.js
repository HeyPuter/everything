import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { reopenDocx } from './helpers/reopen-docx.js';
import { expectBodyEditParts } from './helpers/expect-body-edit-parts.js';

const folder = 'tests/fixtures/tiff-pictures';
const ref = JSON.parse(readFileSync(`${folder}/reference.json`));
const cases = JSON.parse(readFileSync(`${folder}/cases.json`));
async function inspect(page, path) {
  return page.evaluate(async encoded => {
    const { DocxPackage } = await import('/src/engine/docx.js');
    const { TextDocument } = await import('/src/engine/model.js');
    const { layoutDocument } = await import('/src/engine/layout.js');
    const { pageGeometry } = await import('/src/engine/page-settings.js');
    const { loadCanvasFonts, measureCanvasText } = await import('/src/engine/canvas-text.js');
    const p = await DocxPackage.open(Uint8Array.from(atob(encoded), c => c.charCodeAt(0)));
    await loadCanvasFonts(p);
    const d = new TextDocument(p.paragraphs,p.pageSettings,p.numbering,p.styles,p.tables,p.assets);
    const ctx = document.createElement('canvas').getContext('2d');
    const placed = layoutDocument(d.paragraphs,(t,s)=>measureCanvasText(ctx,t,s),pageGeometry(d.pageSettings),d.numbering,d.tables,p.pageStories,{styles:d.styles});
    return { pages: placed.pageCount, pictures: placed.lines.flatMap(l=>l.fragments.filter(f=>f.image).map(f=>{
      const canvas = document.querySelectorAll('canvas.canvas-page')[l.page], ratio = canvas.width/parseFloat(canvas.style.width);
      const top = l.baseline-f.ascent, context = canvas.getContext('2d');
      return {page:l.page,x:f.x*.75,y:top*.75,width:f.width*.75,height:f.ascent*.75,
        samples:[.2,.4,.6,.8].flatMap(y=>[.2,.4,.6,.8].map(x=>Array.from(context.getImageData(Math.round((f.x+x*f.width)*ratio),Math.round((top+y*f.ascent)*ratio),1,1).data).slice(0,3)))};
    })) };
  },readFileSync(path).toString('base64'));
}
test('renders embedded TIFF pixels like the native reference and preserves binary media through edits',async({page},info)=>{
  test.setTimeout(120000);
  const source=`${folder}/control.docx`,bytes=readFileSync(source),parts=unzipSync(bytes),errors=[];
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(ref.sourceSha256);
  expect(createHash('sha256').update(readFileSync(`${folder}/native.pdf`)).digest('hex')).toBe(ref.pdfSha256);
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/playground.html');await page.getByLabel('Open DOCX file').setInputFiles(source);
  const input=page.getByRole('textbox',{name:'Document text'});
  await expect(input).toHaveValue(/multipage/);await expect(input).toHaveJSProperty('readOnly',false);
  const verify=async path=>{
    await expect(page.locator('canvas.canvas-page')).toHaveCount(ref.pages);
    const actual=await inspect(page,path);
    writeFileSync(info.outputPath(path===source?'original.json':'edited.json'),JSON.stringify(actual,null,2));
    expect(actual.pages).toBe(ref.pages);expect(actual.pictures).toHaveLength(cases.length);
    for(const [i,p]of actual.pictures.entries()){
      expect(p.page).toBe(ref.pictures[i].page);
      for(const axis of ['x','y','width','height'])expect(Math.abs(p[axis]-ref.pictures[i][axis]),`${cases[i].name} ${axis}`).toBeLessThan(.2);
      // CMYK's device-to-RGB color management remains a separate measured gap.
      if(cases[i].name!=='cmyk')for(let j=0;j<p.samples.length;j++)for(let k=0;k<3;k++)expect(Math.abs(p.samples[j][k]-ref.pictures[i].samples[j][k]),`${cases[i].name} pixel ${j} channel ${k}`).toBeLessThanOrEqual(1);
    }
  };
  await verify(source);
  for(let i=0;i<ref.pages;i++)writeFileSync(info.outputPath(`page-${i+1}.png`),Buffer.from(await page.locator('canvas.canvas-page').nth(i).evaluate(c=>c.toDataURL().split(',')[1]),'base64'));
  const original=await input.inputValue();
  const save=async name=>{const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath(name+'.docx');await(await pending).saveAs(path);return path;};
  expect(unzipSync(readFileSync(await save('noedit')))).toEqual(parts);
  await input.press('ControlOrMeta+Home');await page.keyboard.insertText('Edited ');const edited=await save('edited');
  expectBodyEditParts(unzipSync(readFileSync(edited)),parts);
  await input.press('ControlOrMeta+z');await expect(input).toHaveValue(original);expect(unzipSync(readFileSync(await save('undo')))).toEqual(parts);
  await reopenDocx(page,input,edited,'Edited '+original);await verify(edited);expect(errors).toEqual([]);
});

test('tracks the unresolved native CMYK TIFF color-management difference',async({page},info)=>{
  test.fail(true,'The native reference applies a device CMYK conversion not yet matched by the TIFF pixel decoder.');
  await page.goto('/playground.html');await page.getByLabel('Open DOCX file').setInputFiles(`${folder}/control.docx`);
  await expect(page.getByRole('textbox',{name:'Document text'})).toHaveValue(/multipage/);
  const actual=await inspect(page,`${folder}/control.docx`),i=cases.findIndex(c=>c.name==='cmyk');
  writeFileSync(info.outputPath('cmyk.json'),JSON.stringify({actual:actual.pictures[i],word:ref.pictures[i]},null,2));
  expect(actual.pictures[i].samples).toEqual(ref.pictures[i].samples);
});

test('inserts a TIFF without transcoding its bytes and reopens it',async({page},info)=>{
  await page.goto('/playground.html');await page.getByRole('button',{name:'New',exact:true}).click();
  const input=page.getByRole('textbox',{name:'Document text'});await expect(input).toHaveValue('');
  await page.getByLabel('Insert image file').setInputFiles(`${folder}/image1.tiff`);
  await expect(input).toHaveValue('\ufffc');
  const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();
  const path=info.outputPath('inserted.docx');await(await pending).saveAs(path);
  const parts=unzipSync(readFileSync(path)),media=Object.keys(parts).filter(p=>p.startsWith('word/media/'));
  expect(media).toHaveLength(1);expect(media[0]).toMatch(/\.tiff$/);expect(parts[media[0]]).toEqual(new Uint8Array(readFileSync(`${folder}/image1.tiff`)));
  await reopenDocx(page,input,path,'\ufffc');await expect(input).toHaveJSProperty('readOnly',false);
  await expect(page.locator('#playground-error')).toBeEmpty();
});

test('changes the pixels of a TIFF picture from its own decoded pixels',async({page},info)=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/playground.html');await page.getByRole('button',{name:'New',exact:true}).click();
  const input=page.getByRole('textbox',{name:'Document text'});
  await page.getByLabel('Insert image file').setInputFiles(`${folder}/image1.tiff`);
  await expect(input).toHaveValue('￼');
  await page.locator('.ribbon-card').getByRole('button',{name:'Color',exact:true}).click();
  await page.getByRole('menuitem',{name:/Saturation: 0%/}).first().click();
  const save=async()=>{const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath('saturation.docx');await(await pending).saveAs(path);return unzipSync(readFileSync(path));};
  // The shown picture is the processed PNG; the TIFF stays as the original layer, byte for byte.
  await expect.poll(async()=>new TextDecoder().decode((await save())['word/document.xml']),{timeout:30000}).toMatch(/<a:blip r:embed="[^"]+"[\s\S]*a14:imgLayer r:embed="[^"]+"[\s\S]*a14:saturation sat="0"/);
  const parts=await save(),media=Object.keys(parts).filter(p=>p.startsWith('word/media/')).sort();
  expect(media.map(p=>p.slice(p.lastIndexOf('.')))).toEqual(['.png','.tiff']);
  expect(parts[media.find(p=>p.endsWith('.tiff'))]).toEqual(new Uint8Array(readFileSync(`${folder}/image1.tiff`)));
  await expect(page.getByRole('alert')).toHaveCount(0);expect(errors).toEqual([]);
});
