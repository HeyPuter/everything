import {test,expect} from '@playwright/test';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {unzipSync} from 'fflate';
import {reopenDocx} from './helpers/reopen-docx.js';
const root='tests/fixtures/wmf-crop-detail/',ref=JSON.parse(readFileSync(root+'reference.json','utf8'));
for(const native of ref.cases)test.describe(`vector effects at device scale ${native.deviceScale}`,()=>{
 test.use({deviceScaleFactor:native.deviceScale});
 test('retains native fine lines and colors through crops, flips, edits, export and undo',async({page},info)=>{
  for(const[name,hash]of Object.entries(ref.sha256))expect(createHash('sha256').update(readFileSync(root+name)).digest('hex')).toBe(hash);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/playground.html');
  await page.getByLabel('Open DOCX file').setInputFiles(root+'effects.docx');const input=page.getByRole('textbox',{name:'Document text'});
  await expect(input).toHaveValue(/^Shape defaults controls/);await expect(input).toHaveJSProperty('readOnly',false);
  const check=async()=>{
   await expect(page.locator('canvas.canvas-page')).toHaveCount(1);
   const result=await page.locator('canvas.canvas-page').evaluate((canvas,reference)=>{
    const ctx=canvas.getContext('2d'),scale=canvas.width/612;
    const samples=reference.samples.map(s=>Array.from(ctx.getImageData(Math.round(s.x*scale),Math.round(s.y*scale),1,1).data).slice(0,3));
    const profiles=reference.profiles.map(p=>{
     let count=0,previous=false;const x=Math.round(p.x*scale);
     for(let y=Math.round(p.top*scale);y<Math.round(p.bottom*scale);y++){
      const ink=Math.min(...ctx.getImageData(x,y,1,1).data.slice(0,3))<210;
      if(ink&&!previous)count++;previous=ink;
     }
     return count;
    });return {samples,profiles};
   },native);
   expect(result.profiles).toEqual(native.profiles.map(p=>p.count));
   const differences=result.samples.flatMap((color,i)=>color.some((c,j)=>c!==native.samples[i].color[j])?[{sample:native.samples[i],actual:color}]:[]);
   expect(differences).toEqual([]);
  };
  await check();writeFileSync(info.outputPath('reference.png'),Buffer.from(await page.locator('canvas.canvas-page').evaluate(c=>c.toDataURL().split(',')[1]),'base64'));
  const original=await input.inputValue(),parts=unzipSync(readFileSync(root+'effects.docx'));
  const save=async name=>{const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath(name+'.docx');await(await pending).saveAs(path);return path;};
  expect(unzipSync(readFileSync(await save('noedit')))).toEqual(parts);
  await input.press('ControlOrMeta+Home');await page.keyboard.insertText('Edited ');await check();
  const edited=await save('edited'),saved=unzipSync(readFileSync(edited));
  for(const[name,bytes]of Object.entries(parts))if(name!=='word/document.xml')expect(saved[name]).toEqual(bytes);
  await input.press('ControlOrMeta+z');await expect(input).toHaveValue(original);expect(unzipSync(readFileSync(await save('undo')))).toEqual(parts);
  await reopenDocx(page,input,edited,'Edited '+original);await check();expect(errors).toEqual([]);
 });
});

test('SVG effects retain the enlarged vector silhouette and original color-effect order',async({page})=>{
 await page.goto('/playground.html');
 const result=await page.evaluate(async()=>{
  const {decodeImage}=await import('/src/engine/images.js');const {paintImage}=await import('/src/engine/paint-image.js');
  const bytes=new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path d="M4 0H5V16H4Z" fill="#204080"/></svg>');
  const raw=await decodeImage({mime:'image/svg+xml',bytes}),image=await decodeImage({mime:'image/svg+xml',bytes,pictureEffects:[['000000','FFFFFF'],{type:'luminance',brightness:.2,contrast:0}]});
  try{
   const render=image=>{const c=new OffscreenCanvas(256,256),ctx=c.getContext('2d');paintImage(ctx,image,0,0,256,256);return ctx.getImageData(0,0,256,256).data;};
   const a=render(raw),b=render(image);let alpha=0,color=0,opaque=0;
   for(let i=0;i<a.length;i+=4){
    if(a[i+3]!==b[i+3])alpha++;
    if(a[i+3]===255){opaque++;const gray=Math.min(255,Math.floor((2126*a[i]+7152*a[i+1]+722*a[i+2])/10000)+51);if(b[i]!==gray||b[i+1]!==gray||b[i+2]!==gray)color++;}
   }return {alpha,color,opaque};
  }finally{raw.close();image.close();}
 });
 expect(result.opaque).toBeGreaterThan(1000);expect(result.alpha).toBe(0);expect(result.color).toBe(0);
});

test('EMF effects preserve the enlarged vector alpha silhouette and opaque color mapping',async({page})=>{
 const bytes=unzipSync(readFileSync('public/fixtures/emf-paths.docx'))['word/media/control0.emf'];
 await page.goto('/playground.html');
 const result=await page.evaluate(async bytes=>{
  const {decodeImage}=await import('/src/engine/images.js');const {paintImage}=await import('/src/engine/paint-image.js');const {emfInfo}=await import('/src/engine/emf-images.js');
  const asset={bytes:new Uint8Array(bytes),mime:'image/emf'},raw=await decodeImage(asset),effect=await decodeImage({...asset,duotone:[['000000','FFFFFF']]});
  // Non-neutral EMF effects map the physical frame through the final output pixel (docs/conformance.md,
  // "EMF pixel effects: inclusive output-device frame correction"); unadjusted metafiles keep their viewport.
  // Compare the effect with the vector drawn through that same frame at the enlarged size.
  const frame=emfInfo(asset.bytes,{pixelEffects:true}).rasterFrame;
  try{
   const render=image=>{const c=new OffscreenCanvas(512,256),ctx=c.getContext('2d');paintImage(ctx,image,0,0,512,256);return ctx.getImageData(0,0,512,256).data;};
   const framed=image=>{const c=new OffscreenCanvas(512,256),ctx=c.getContext('2d');ctx.drawImage(image,0,0,511*frame.width,255*frame.height);return ctx.getImageData(0,0,512,256).data;};
   const a=framed(raw),b=render(effect);let alpha=0,color=0,opaque=0;
   for(let i=0;i<a.length;i+=4){
    if(a[i+3]!==b[i+3])alpha++;
    if(a[i+3]===255){opaque++;const gray=Math.floor((2126*a[i]+7152*a[i+1]+722*a[i+2])/10000);if(b[i]!==gray||b[i+1]!==gray||b[i+2]!==gray)color++;}
   }return {alpha,color,opaque};
  }finally{raw.close();effect.close();}
 },[...bytes]);
 expect(result.opaque).toBeGreaterThan(1000);expect(result.alpha).toBe(0);expect(result.color).toBe(0);
});
