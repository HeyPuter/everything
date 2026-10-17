import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { reopenDocx } from './helpers/reopen-docx.js';

for (const fixture of ['zero-axis-groups','zero-axis-group-rotations','zero-axis-group-geometry','zero-axis-group-relative','zero-axis-group-effects','straight-connector-groups']) {
const reference = JSON.parse(readFileSync(`tests/fixtures/${fixture}/reference.json`, 'utf8'));

if(fixture!=='zero-axis-group-effects') test(`${fixture}: paths match independently recorded native endpoints and physical pens`, async ({ page }, info) => {
  test.setTimeout(60000);
  expect(createHash('sha256').update(readFileSync(`public/fixtures/${fixture}.docx`)).digest('hex')).toBe(reference.sourceSha256);
  expect(createHash('sha256').update(readFileSync(`tests/fixtures/${fixture}/native.pdf`)).digest('hex')).toBe(reference.pdfSha256);
  await page.goto('/playground.html');
  const actual = await page.evaluate(async fixture => {
    const { DocxPackage } = await import('/src/engine/docx.js');
    const { decodeShape } = await import('/src/engine/canvas-shapes.js');
    const { positionedImageFrame } = await import('/src/engine/positioned-images.js');
    const { pageGeometry } = await import('/src/engine/page-settings.js');
    const pkg = await DocxPackage.open(new Uint8Array(await (await fetch(`/fixtures/${fixture}.docx`)).arrayBuffer()));
    const proto = OffscreenCanvasRenderingContext2D.prototype, originals = {}, result = [];
    let points = [], strokes = [];
    for (const name of ['beginPath', 'moveTo', 'lineTo', 'stroke']) {
      originals[name] = proto[name];
      proto[name] = function (...args) {
        if (name === 'beginPath') points = [];
        if (name === 'moveTo' || name === 'lineTo') {
          const m = this.getTransform();
          points.push([(m.a*args[0]+m.c*args[1]+m.e)/2, (m.b*args[0]+m.d*args[1]+m.f)/2]);
        }
        if (name === 'stroke') strokes.push({points:[...points], width:this.lineWidth});
        return originals[name].apply(this,args);
      };
    }
    try {
      for (const [id,asset] of Object.entries(pkg.assets)) {
        strokes = [];
        const initial = await decodeShape(asset,new Map());
        let decoded=initial;
        if (asset.relativeFrame) {
          const image=pkg.paragraphs.flatMap(p=>p.runs).find(r=>r.image?.assetId===id).image;
          const frame=positionedImageFrame({image},{page:0,y:0},pageGeometry(pkg.pageSettings));
          strokes=[];
          decoded=initial.forPage(null,frame);
        }
        // Scenes that can be painted for the screen defer their raster until the bitmap is first read.
        const bitmap=decoded.bitmap;
        result.push(strokes.map(s => ({width:s.width*.75,points:s.points.map(([x,y]) => [(x+decoded.left)*.75,(y+decoded.top)*.75])})));
        const surface=new OffscreenCanvas(bitmap.width,bitmap.height), context=surface.getContext('2d');
        context.drawImage(bitmap,0,0);
        const pixels=context.getImageData(0,0,surface.width,surface.height).data;
        result[result.length-1][0].ink=Array.from(pixels).filter((v,i)=>i%4===3 && v>0).length;
        initial.close();
      }
    } finally { for (const name of Object.keys(originals)) proto[name]=originals[name]; }
    return result;
  }, fixture);
  await info.attach('paths', {body:JSON.stringify(actual,null,2),contentType:'application/json'});
  expect(actual).toHaveLength(reference.cases.length);
  reference.cases.forEach((c,i) => {
    expect(actual[i],c.name).toHaveLength(1);
    const s=actual[i][0];
    if (Math.hypot(c.native.end[0]-c.native.start[0],c.native.end[1]-c.native.start[1])>1) expect(s.ink,c.name).toBeGreaterThan(100);
    else expect(s.ink,c.name).toBe(0);
    expect(s.width,c.name).toBeCloseTo(c.native.strokeWidth,5);
    expect(s.points,c.name).toHaveLength(2);
    [c.native.start,c.native.end].forEach((p,j) => p.forEach((v,k) =>
      expect.soft(Math.abs(s.points[j][k]+(k===0?c.x:c.y)-v),c.name).toBeLessThan(.015)));
  });
});

test(`${fixture}: editable load, immutable export, undo and reopen`, async ({page},info)=>{
  test.setTimeout(120000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/playground.html');
  await page.getByLabel('Open DOCX file').setInputFiles(`public/fixtures/${fixture}.docx`);
  const input=page.getByRole('textbox',{name:'Document text'});
  await expect(input).toHaveValue(/controls/);
  await expect(input).toHaveJSProperty('readOnly',false);
  await expect(page.locator('canvas.canvas-page')).toHaveCount(1);
  // The model can be ready before the first bitmap paint. Wait for every
  // nondegenerate native stroke before taking the undo raster baseline.
  await expect.poll(()=>page.locator('canvas.canvas-page').evaluate((c,cases)=>{
    const data=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    return cases.filter(p=>p.native.outline || Math.hypot(p.native.end[0]-p.native.start[0],p.native.end[1]-p.native.start[1])>1).every(p=>{
      const rgb=[0,2,4].map(i=>parseInt(p.color.slice(i,i+2),16));
      for(let i=0;i<data.length;i+=4) if(rgb.every((v,j)=>Math.abs(v-data[i+j])<2)) return true;
      return false;
    });
  },reference.cases)).toBe(true);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const snapshot=async()=>{
    await input.evaluate(e=>e.blur());
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    return page.locator('canvas.canvas-page').evaluate(c=>c.toDataURL());
  };
  const before=await snapshot(),original=await input.inputValue();
  const parts=unzipSync(readFileSync(`public/fixtures/${fixture}.docx`));
  const save=async name=>{
    const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();
    const path=info.outputPath(`${name}.docx`);await(await pending).saveAs(path);return path;
  };
  expect(unzipSync(readFileSync(await save('noedit')))).toEqual(parts);
  await input.press('ControlOrMeta+Home');await page.keyboard.insertText('Edited ');
  const edited=await save('edited'),changed=unzipSync(readFileSync(edited));
  for (const name of Object.keys(parts)) if(name!=='word/document.xml') expect(changed[name],name).toEqual(parts[name]);
  await input.press('ControlOrMeta+z');await expect(input).toHaveValue(original);
  expect(unzipSync(readFileSync(await save('undo')))).toEqual(parts);
  await expect.poll(async()=>createHash('sha256').update(await snapshot()).digest('hex')).toBe(createHash('sha256').update(before).digest('hex'));
  if(fixture==='zero-axis-groups' || fixture==='zero-axis-group-relative' || fixture==='straight-connector-groups') {
    const canvas=page.locator('canvas.canvas-page');
    const indices=fixture==='zero-axis-group-relative' ? [2,3,4,5] : [0,1,11];
    for(const i of indices) {
      const c=reference.cases[i];
      let x=(c.native.start[0]+c.native.end[0])/2,y=(c.native.start[1]+c.native.end[1])/2;
      if(fixture==='zero-axis-group-relative') {
        // The native reference's percentage-expanded outer frame is selectable even
        // where its collapsed artwork leaves blank space.
        const frames=[[0,198],[153,0],[153,72],[72,198],[153,198],[153,198]];
        x=c.x+frames[i][0]*.2;y=c.y+frames[i][1]*.8;
      }
      const scale=await canvas.evaluate(c=>c.getBoundingClientRect().width/612);
      await canvas.click({position:{x:x*scale,y:y*scale}});
      await expect.poll(()=>input.evaluate(e=>e.selectionEnd-e.selectionStart)).toBe(1);
    }
  }
  await reopenDocx(page,input,edited,'Edited '+original);
  await expect(input).toHaveJSProperty('readOnly',false);
  await expect(page.locator('canvas.canvas-page')).toHaveCount(1);
  await expect(page.locator('#playground-error')).toBeEmpty();expect(errors).toEqual([]);
  writeFileSync(info.outputPath('page.png'),Buffer.from((await snapshot()).split(',')[1],'base64'));
});
}

test('collapsed group shadows and patterned outlines match the native reference',async({page})=>{
  test.setTimeout(60000);
  const fixture='zero-axis-group-effects';
  const reference=JSON.parse(readFileSync(`tests/fixtures/${fixture}/reference.json`,'utf8'));
  expect(createHash('sha256').update(readFileSync(`public/fixtures/${fixture}.docx`)).digest('hex')).toBe(reference.sourceSha256);
  expect(createHash('sha256').update(readFileSync(`tests/fixtures/${fixture}/native.pdf`)).digest('hex')).toBe(reference.pdfSha256);
  await page.goto('/playground.html');
  await page.getByLabel('Open DOCX file').setInputFiles(`public/fixtures/${fixture}.docx`);
  const input=page.getByRole('textbox',{name:'Document text'});
  await expect(input).toHaveValue(/Zero-axis shadow/);await expect(input).toHaveJSProperty('readOnly',false);
  const sample=()=>page.locator('canvas.canvas-page').evaluate((canvas,cases)=>{
    const scale=canvas.width/612,data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    const bounds=(color,c)=>{
      const rgb=[0,2,4].map(i=>parseInt(color.slice(i,i+2),16));let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
      for(let y=Math.floor((c.y-40)*scale);y<Math.min(canvas.height,(c.y+220)*scale);y++)for(let x=Math.floor((c.x-40)*scale);x<Math.min(canvas.width,(c.x+200)*scale);x++){
        const at=4*(y*canvas.width+x);
        if(rgb.every((v,j)=>Math.abs(v-data[at+j])<10)){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x+1);bottom=Math.max(bottom,y+1);}
      }
      return Number.isFinite(left)?[left/scale,top/scale,right/scale,bottom/scale]:null;
    };
    let patternInk=0;
    for(let i=0;i<data.length;i+=4)if((data[i]<30&&data[i+1]<30&&data[i+2]>230)||(data[i]>230&&data[i+1]>230&&data[i+2]<30))patternInk++;
    return {cases:cases.map(c=>({outline:bounds(c.color,c),shadow:bounds('00AA00',c)})),patternInk};
  },reference.cases);
  await expect.poll(async()=> (await sample()).cases.every(c=>c.outline)).toBe(true);
  const actual=await sample();expect(actual.patternInk).toBe(0);
  reference.cases.forEach((c,i)=>{
    for(const key of ['outline','shadow']) {
      if(!c.native[key]) expect(actual.cases[i][key]).toBe(null);
      else {expect(actual.cases[i][key],c.name).not.toBe(null);c.native[key].forEach((v,j)=>expect(Math.abs(actual.cases[i][key][j]-v),`${c.name} ${key}`).toBeLessThan(1));}
    }
  });
});
