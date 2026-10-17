import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
const source='public/fixtures/shape-edge-spacing.docx';
const reference=JSON.parse(readFileSync('tests/fixtures/shape-edge-spacing/reference.json','utf8'));
test.use({deviceScaleFactor:3});
for(const missingFont of [false,true]) test(`matches native shape-edge spacing and preserves markup (${missingFont ? 'substituted font' : 'declared font'})`,async({page},info)=>{
 test.setTimeout(120000);
 expect(createHash('sha256').update(readFileSync(source)).digest('hex')).toBe(reference.sourceSha256);
 expect(createHash('sha256').update(readFileSync('tests/fixtures/shape-edge-spacing/native.pdf')).digest('hex')).toBe(reference.pdfSha256);
 await page.addInitScript(()=>{
  window.shapePaint=[];
  const fill=OffscreenCanvasRenderingContext2D.prototype.fillText;
  OffscreenCanvasRenderingContext2D.prototype.fillText=function(text,x,y,...rest){
   if(/^E\d{2} /.test(text)){
    const m=this.getTransform(),metrics=this.measureText(text);
    // Upright shape text paints at the raster density (m.d), which follows the page scale.
    window.shapePaint.push({text,font:this.font,color:this.fillStyle,baseline:(m.b*x+m.d*y+m.f)/m.d*.75,ascent:metrics.actualBoundingBoxAscent*.75,descent:metrics.actualBoundingBoxDescent*.75});
   }
   return fill.call(this,text,x,y,...rest);
  };
 });
 const sourceParts=unzipSync(readFileSync(source));
 if(missingFont) sourceParts['word/document.xml']=strToU8(strFromU8(sourceParts['word/document.xml']).replaceAll('Arial','Missing Shape Control Font'));
 const sourceBytes=missingFont ? zipSync(sourceParts) : readFileSync(source);
 await page.goto('/playground.html');
 const referenceFont=await page.evaluate(async()=>{try{await new FontFace('reference probe','local("Arial")').load();return true;}catch{return false;}});
 await page.getByLabel('Open DOCX file').setInputFiles({name:'shape-edge-spacing.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:Buffer.from(sourceBytes)});
 const input=page.getByRole('textbox',{name:'Document text'});await expect(input).toHaveValue(/^Shape edge spacing/,{timeout:45000});await expect(input).toHaveJSProperty('readOnly',false);
 const check=async()=>{
  await expect(page.locator('#playground-error')).toBeEmpty();await expect(page.locator('canvas.canvas-page')).toHaveCount(3);
  const bands=await page.evaluate(cases=>{
   return cases.map(({x,y,page})=>{
    const canvas=document.querySelectorAll('canvas.canvas-page')[page],ctx=canvas.getContext('2d'),scale=canvas.width/612;
    const left=Math.round(x*scale),top=Math.round(y*scale),w=Math.round(200*scale),h=Math.round(110*scale);
    const data=ctx.getImageData(left,top,w,h).data,result=[];
    for(let py=0;py<h;py++){
     let ink=false;for(let px=0;px<w;px++){const k=(py*w+px)*4;const [r,g,b]=data.slice(k,k+3);if(b>r+25&&b>g+12&&r<100){ink=true;break;}}
     if(ink){if(!result.length||py>result.at(-1)[1]+1)result.push([py,py]);else result.at(-1)[1]=py;}
    }
    return result.map(([a,b])=>[(top+a)/scale,(top+b+1)/scale]);
   });
  },reference.cases);
  const paint=await page.evaluate(cases=>cases.map(c=>window.shapePaint.filter(p=>p.text.startsWith(c.id+' ')).slice(-c.count)),reference.cases);
  // TextMetrics at 32px is not a raster oracle for glyphs painted under a 2x
  // transform: font hinting changes pixel coverage on Linux. Independently
  // rasterize the native face at the native reference's baseline and the shape raster scale.
  // Keep the existing baseline, clipping and native Arial comparisons below.
  const nativeBands=await page.evaluate(({cases,paint})=>cases.map((c,i)=>{
   const scale=8/3,canvas=new OffscreenCanvas(Math.ceil(200*scale),Math.ceil(110*scale)),ctx=canvas.getContext('2d');
   ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
   ctx.scale(2,2);ctx.beginPath();ctx.rect(8,8,188*4/3,98*4/3);ctx.clip();
   paint[i].forEach((p,j)=>{ctx.font=p.font;ctx.fillStyle=p.color;ctx.fillText(p.text,8,(c.baselines[j]-c.y)*4/3);});
   const data=ctx.getImageData(0,0,canvas.width,canvas.height).data,bands=[];
   for(let y=0;y<canvas.height;y++){
    let ink=false;for(let x=0;x<canvas.width;x++){const k=(y*canvas.width+x)*4;const [r,g,b]=data.slice(k,k+3);if(b>r+25&&b>g+12&&r<100){ink=true;break;}}
    if(ink){if(!bands.length||y>bands.at(-1)[1]+1)bands.push([y,y]);else bands.at(-1)[1]=y;}
   }
   return bands.map(([a,b])=>[c.y+a/scale,c.y+(b+1)/scale]);
  }),{cases:reference.cases,paint});
  for(const [i,c] of reference.cases.entries()){
   expect(bands[i].length,JSON.stringify(bands)).toBe(c.bands.length);
   expect(paint[i]).toHaveLength(c.count);
   for(let j=0;j<c.count;j++){
    const p=paint[i][j];expect(p.font).toMatch(/^32px /);
    expect(Math.abs(c.y+p.baseline-c.baselines[j]),`painted baseline ${c.id}`).toBeLessThan(.15);
    expect(nativeBands[i]).toHaveLength(c.count);
    const native=nativeBands[i][j];
    for(let k=0;k<2;k++)expect(Math.abs(bands[i][j][k]-native[k]),`native ink ${c.id}: ${JSON.stringify(bands[i])}`).toBeLessThan(1);
    // A native Arial raster is an ink oracle only when that actual face exists.
    if(referenceFont&&!missingFont)for(let k=0;k<2;k++)expect(Math.abs(bands[i][j][k]-c.bands[j][k]),`native ink ${c.id}`).toBeLessThan(1);
   }
  }
 };
 await check();writeFileSync(info.outputPath('shape-edge-spacing.png'),Buffer.from(await page.locator('canvas.canvas-page').first().evaluate(c=>c.toDataURL().split(',')[1]),'base64'));
 const original=await input.inputValue();await input.press('ControlOrMeta+Home');await page.keyboard.insertText('Edited ');await check();
 const save=async suffix=>{const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath(`shape-edge-spacing${suffix}.docx`);await(await pending).saveAs(path);return path;};
 const edited=await save('-edited');await input.press('ControlOrMeta+z');await expect(input).toHaveValue(original);await check();
 const a=unzipSync(sourceBytes),b=unzipSync(readFileSync(await save('-undo')));for(const name of Object.keys(a))expect(Buffer.from(a[name]).equals(Buffer.from(b[name])),name).toBe(true);
 const savedXml=new TextDecoder().decode(unzipSync(readFileSync(edited))['word/document.xml']);
 const sourceXml=new TextDecoder().decode(unzipSync(sourceBytes)['word/document.xml']);
 const groups=xml=>xml.match(/<(?:[\w]+:)?wsp\b[\s\S]*?<\/(?:[\w]+:)?wsp>/g);
 expect(groups(sourceXml)).toHaveLength(21);expect(groups(savedXml)).toEqual(groups(sourceXml));
 const previous=await input.elementHandle();page.once('dialog',d=>d.accept());await page.getByLabel('Open DOCX file').setInputFiles(edited);
 await expect.poll(()=>previous.evaluate(el=>el.isConnected),{timeout:45000}).toBe(false);await previous.dispose();
 await expect(input).toHaveValue('Edited '+original);await expect(input).toHaveJSProperty('readOnly',false);await check();
});

