// Compare native controls with positions validated against the actual painter.
import {chromium} from '@playwright/test';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const folder='tests/fixtures/installed-tracking-origins/';
const [output,baseURL='http://127.0.0.1:5173']=process.argv.slice(2);
if(!output)throw Error('Usage: node tools/probe-installed-tracking-origins.mjs <output.json> [BASE_URL]');
const reference=JSON.parse(readFileSync(folder+'reference.json'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
if(sha(readFileSync(folder+'control.docx'))!==reference.sourceSha256||sha(readFileSync(folder+'cases.json'))!==reference.casesSha256)throw Error('Control/reference binding changed');
for(const c of reference.cases)if(sha(readFileSync(folder+`page-${c.page+1}.emf`))!==c.captureSha256)throw Error('Native capture changed');
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage();await page.goto(new URL('/playground.html',baseURL).href);
 await page.getByRole('textbox',{name:'Document text'}).waitFor();
 const actual=await page.evaluate(async encoded=>{
  const{openCanvasDocument,CanvasEditor,setCanvasTextStyle}=await import('/tools/reviewed-family-modules.js');
  const{paintText}=await import('/src/engine/canvas-paint-text.js');
  const{pkg,images}=await openCanvasDocument(Uint8Array.from(atob(encoded),c=>c.charCodeAt(0)));
  const host=document.createElement('div');document.body.append(host);const editor=new CanvasEditor(host,{...pkg,images});
  try{
   if(editor.readOnly)throw Error('Expected editable structured controls');
   const rows=[];
   for(const line of editor.layout.lines){
    if(line.fragments.length!==1)throw Error('Expected one unwrapped run per control');
    const f=line.fragments[0],canvas=document.createElement('canvas');canvas.width=1000;canvas.height=128;
    const ctx=canvas.getContext('2d');setCanvasTextStyle(ctx,f);
    const fill=ctx.fillText.bind(ctx);let recorded=false;
    ctx.fillText=function(text,x,y){
     if(recorded)throw Error('Unexpected repeated paint');recorded=true;
     const m=this.getTransform();if(m.b||m.c)throw Error('Unexpected rotation/shear');
     const width=this.measureText(text).width;
     const starts=Array.from({length:text.length},(_,i)=>width-this.measureText(text.slice(i)).width);
     const prefix=Array.from({length:text.length},(_,i)=>this.measureText(text.slice(0,i)).width);
     const make=()=>{
      const c=document.createElement('canvas');c.width=Math.ceil(width+64);c.height=Math.ceil(parseFloat(this.font)*2+64);
      const p=c.getContext('2d');for(const key of ['font','fontKerning','letterSpacing','wordSpacing','textRendering','direction'])p[key]=this[key];
      return p;
     };
     const whole=make(),baseline=parseFloat(this.font)+32;
     whole.fillText(text,32,baseline);
     const a=whole.getImageData(0,0,whole.canvas.width,whole.canvas.height).data;
     const candidates=Object.entries({suffix:starts,prefix}).map(([method,origins])=>{
      const parts=make();parts.fontKerning='none';
      [...text].forEach((ch,i)=>parts.fillText(ch,32+origins[i],baseline));
      const b=parts.getImageData(0,0,parts.canvas.width,parts.canvas.height).data;
      let differentPixels=0;for(let i=3;i<a.length;i+=4)if(a[i]!==b[i])differentPixels++;
      return{method,differentPixels,glyphsPt:origins.map(v=>(m.a*(x+v)+m.e)*.75)};
     });
     const best=candidates.toSorted((a,b)=>a.differentPixels-b.differentPixels)[0];
     rows.push({page:line.page,text,font:this.font,letterSpacing:this.letterSpacing,...best,
      candidateMasks:candidates.map(({method,differentPixels})=>({method,differentPixels})),advancePt:width*m.a*.75});
     fill(text,x,y);
    };
    // Keep the production painter's horizontal origin, with a small local baseline.
    paintText(ctx,f,64);if(!recorded)throw Error('No text painted');
   }
   return{pages:editor.layout.pages.length,rows};
  }finally{editor.destroy();host.remove();}
 },readFileSync(folder+'control.docx').toString('base64'));
 if(actual.pages!==27||actual.rows.length!==162)throw Error('Wrong page/record count');
 const comparison=reference.cases.flatMap(c=>c.origins.map((r,i)=>{
  const a=actual.rows.filter(r=>r.page===c.page)[i];
  if(a.text!==r.text)throw Error('Native/browser text mismatch');
  const errorsPt=a.glyphsPt.map((x,j)=>x-r.glyphsPt[j]);
  return{page:c.page,family:c.family,size:c.size,trackingPt:c.trackingPt,text:r.text,
   font:a.font,letterSpacing:a.letterSpacing,method:a.method,candidateMasks:a.candidateMasks,differentPixels:a.differentPixels,
   maxOriginErrorPt:Math.max(...errorsPt.map(Math.abs)),advanceErrorPt:a.advancePt-r.advancePt,errorsPt};
 }));
 const result={scope:'Unligated, unkerned, regular installed ASCII controls; actual painter prefix/suffix position candidates checked by exact alpha masks. Only zero-error candidates are validated. Native page metafile origin comparison, not full raster equivalence.',sourceSha256:reference.sourceSha256,comparison};
 writeFileSync(output,JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({cases:comparison.length,maskFailures:comparison.filter(r=>r.differentPixels).length,
  maxOriginErrorPt:Math.max(...comparison.map(r=>r.maxOriginErrorPt)),maxAdvanceErrorPt:Math.max(...comparison.map(r=>Math.abs(r.advanceErrorPt))),
  worst:comparison.toSorted((a,b)=>b.maxOriginErrorPt-a.maxOriginErrorPt).slice(0,3)},null,2));
}finally{await browser.close();}
