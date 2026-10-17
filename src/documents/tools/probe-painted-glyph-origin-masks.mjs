// Capture the actual Canvas paint state, then validate suffix-origin proxies by
// exact alpha-mask reconstruction. Embedded programs remain opaque; no Local
// Font Access grant or font-program extraction is introduced.
import {chromium} from '@playwright/test';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname} from 'node:path';
const [source,output,...args]=process.argv.slice(2);
// The dev server's address: Playwright runs it on PLAYWRIGHT_PORT, a manual run on Vite's default.
const baseURL=args.find(option=>option.startsWith('--base-url='))?.slice('--base-url='.length)||'http://127.0.0.1:5173';
const options=args.filter(option=>!option.startsWith('--base-url='));
if(!source||!output||options.some(option=>!['--include-bold','--include-bmp'].includes(option)))throw Error('Usage: node tools/probe-painted-glyph-origin-masks.mjs source.docx output.json [--include-bold] [--include-bmp] [--base-url=URL]');
const includeBold=options.includes('--include-bold');
const includeBmp=options.includes('--include-bmp');
const sourceHash=()=>createHash('sha256').update(readFileSync(source)).digest('hex');
const sourceSha256=sourceHash();
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage();
 await page.route(/\/src\/engine\/embedded-fonts\.js(?:\?.*)?$/,route=>route.fulfill({contentType:'text/javascript',
  body:'export const decodeEmbeddedFont=()=>null,isEmbeddedFont=()=>false,embeddedPreviewOnly=()=>false,embeddedFontSources=()=>null,documentEmbeddedFonts=()=>new Map();'}));
 await page.addInitScript(()=>{
  window.glyphPaintRecords=new Map();
  const states=new WeakMap(),proto=CanvasRenderingContext2D.prototype;
  const state=ctx=>{
   if(!states.has(ctx))states.set(ctx,{values:{},stack:[]});
   return states.get(ctx);
  };
  // Chrome may serialize an empty spacing string after save(), while retaining
  // the active numeric spacing. Record accepted assignments and restore them
  // with the graphics state rather than silently replaying zero spacing.
  for(const property of ['letterSpacing','wordSpacing']){
   const descriptor=Object.getOwnPropertyDescriptor(proto,property);
   if(!descriptor?.get||!descriptor.set)throw Error(`Missing Canvas ${property} descriptor`);
   Object.defineProperty(proto,property,{...descriptor,set(value){
    descriptor.set.call(this,value);
    if(typeof value==='string'&&/^[-+]?(?:\d+\.?\d*|\.\d+)px$/.test(value))state(this).values[property]=value;
   }});
  }
  const save=proto.save,restore=proto.restore;
  proto.save=function(...args){state(this).stack.push({...state(this).values});return save.apply(this,args);};
  proto.restore=function(...args){const values=state(this).stack.pop();const result=restore.apply(this,args);if(values)state(this).values=values;return result;};
  const native=CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText=function(text,x,y,...rest){
   if(this.canvas.isConnected&&this.canvas.classList.contains('canvas-page')&&typeof text==='string'&&text.trim()){
    const m=this.getTransform(),ratio=this.canvas.width/parseFloat(this.canvas.style.width);
    const record={page:Number(this.canvas.dataset.page),text,font:this.font,fontKerning:this.fontKerning,
     letterSpacing:state(this).values.letterSpacing??this.letterSpacing,wordSpacing:state(this).values.wordSpacing??this.wordSpacing,textRendering:this.textRendering,
     direction:this.direction,textAlign:this.textAlign,textBaseline:this.textBaseline,
     matrix:[m.a,m.b,m.c,m.d,m.e,m.f],ratio,x,y,maxWidth:rest[0]??null,actualAdvancePx:this.measureText(text).width};
    const key=JSON.stringify([record.page,text,x,y,record.font,record.matrix]);
    window.glyphPaintRecords.set(key,record);
   }
   return native.call(this,text,x,y,...rest);
  };
 });
 await page.goto(new URL('/playground.html',baseURL).href);
 await page.evaluate(async()=>{const guard=await import('/src/engine/embedded-fonts.js');
  if(guard.decodeEmbeddedFont.toString()!=='()=>null'||guard.embeddedFontSources.toString()!=='()=>null')throw Error('Opaque font guard missing');});
 const old=await page.getByRole('textbox',{name:'Document text'}).elementHandle();
 await page.evaluate(async()=>{
  const {CanvasEditor}=await import('/tools/reviewed-family-modules.js');
  const paint=CanvasEditor.prototype.paint;
  CanvasEditor.prototype.paint=function(...args){
   if(!this.destroyed&&!args[0]?.printing)window.glyphPaintRecords.clear();
   return paint.apply(this,args);
  };
 });
 await page.evaluate(()=>window.glyphPaintRecords.clear());
 await page.getByLabel('Open DOCX file').setInputFiles(source);
 await page.waitForFunction(el=>!el.isConnected,old,{timeout:120000});
 await page.locator('canvas.canvas-page').first().waitFor({timeout:120000});
 const result=await page.evaluate(({includeBold,includeBmp})=>{
  const rows=[],excluded=[];
  for(const r of window.glyphPaintRecords.values()){
   const [a,b,c,d,e,f]=r.matrix;
   const fontPrefix=r.font.split(/[\d.]+px\s/,1)[0];
   const supportedText=includeBmp
    ? [...r.text].every(char=>char.length===1&&(char===' '||char==='\u00a0'||!/[\p{C}\p{Z}]/u.test(char)))
    : !/[^\x20-\x7e]/.test(r.text);
   if(!supportedText||r.direction!=='ltr'||!['left','start'].includes(r.textAlign)||r.textBaseline!=='alphabetic'||
      r.maxWidth!==null||Math.abs(b)>1e-10||Math.abs(c)>1e-10||Math.abs(a-d)>1e-10||a<=0||!/^(?:(?:normal|bold|400|700)\s+)*$/.test(fontPrefix)||!includeBold&&/bold|\b700\b/.test(fontPrefix)){
    excluded.push({...r,reason:`Outside untransformed ${includeBold?'regular/bold':'regular'} LTR ${includeBmp?'BMP':'ASCII'} probe`});continue;
   }
   const em=Number(r.font.match(/([\d.]+)px/)?.[1]);
   const create=()=>{
    const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
    return {canvas,ctx};
   };
   const setup=ctx=>{
    ctx.font=r.font;ctx.fontKerning=r.fontKerning;ctx.letterSpacing=r.letterSpacing;ctx.wordSpacing=r.wordSpacing;
    ctx.textRendering=r.textRendering;ctx.direction='ltr';ctx.textAlign='left';ctx.textBaseline='alphabetic';
   };
   const measured=create();setup(measured.ctx);const width=measured.ctx.measureText(r.text).width;
   const replayAdvanceErrorPx=Math.abs(width-r.actualAdvancePx);
   if(replayAdvanceErrorPx>1e-8)throw Error(`Paint-state replay changed advance: ${r.text}: ${replayAdvanceErrorPx}`);
   const w=Math.ceil(width+em*4),h=Math.ceil(em*4);
   if(!Number.isFinite(em)||w<1||h<1||w>8192||h>512){excluded.push({...r,reason:'Outside bounded raster dimensions'});continue;}
   const x=em*2,y=em*2,base=create(),candidate=create();
   for(const layer of [base,candidate]){layer.canvas.width=w;layer.canvas.height=h;setup(layer.ctx);}
   base.ctx.fillText(r.text,x,y);
   const starts=Array.from({length:r.text.length},(_,i)=>width-measured.ctx.measureText(r.text.slice(i)).width);
   candidate.ctx.fontKerning='none';
   [...r.text].forEach((ch,i)=>candidate.ctx.fillText(ch,x+starts[i],y));
   const original=base.ctx.getImageData(0,0,w,h).data,pixels=candidate.ctx.getImageData(0,0,w,h).data;
   let differentPixels=0,alphaAbsoluteError=0;
   for(let i=3;i<pixels.length;i+=4){if(pixels[i]!==original[i])differentPixels++;alphaAbsoluteError+=Math.abs(pixels[i]-original[i]);}
   rows.push({...r,replayAdvanceErrorPx,differentPixels,alphaAbsoluteError,originsPt:starts.map(s=>(a*(r.x+s)+e)/r.ratio*.75),baselinePt:(d*r.y+f)/r.ratio*.75,canvasAdvancePt:width*a/r.ratio*.75});
  }
  return {pages:document.querySelectorAll('canvas.canvas-page').length,readOnly:document.querySelector('.canvas-input').readOnly,
   opaqueFontGuardVerified:true,
   scope:`Actual captured paint state; exact alpha-mask validation of suffix positions in local glyph space for bounded ${includeBold?'regular/bold':'regular'} LTR ${includeBmp?'BMP':'ASCII'} runs. No general shaping or native reference raster equivalence claim.`,rows,excluded};
 },{includeBold,includeBmp});
 if(sourceHash()!==sourceSha256)throw Error('Source changed during paint observation');
 result.sourceSha256=sourceSha256;
 result.browserVersion=browser.version();
 mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({pages:result.pages,readOnly:result.readOnly,rows:result.rows.length,exact:result.rows.filter(r=>!r.differentPixels).length,excluded:result.excluded.length}));
}finally{await browser.close();}
