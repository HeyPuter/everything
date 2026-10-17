import {test,expect} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

test('actual saved paint states retain tracking and reconstruct complete glyph masks',async({baseURL},info)=>{
 test.setTimeout(150000);
 const root='tests/fixtures/installed-tracking-origins/',reference=JSON.parse(readFileSync(root+'reference.json'));
 const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
 expect(hash(root+'control.docx')).toBe(reference.sourceSha256);
 expect(hash(root+'cases.json')).toBe(reference.casesSha256);
 const output=info.outputPath('actual-paints.json');
 execFileSync(process.execPath,['tools/probe-painted-glyph-origin-masks.mjs',root+'control.docx',output,`--base-url=${baseURL}`],{timeout:120000,stdio:'pipe'});
 const actual=JSON.parse(readFileSync(output));
 expect(actual.sourceSha256).toBe(reference.sourceSha256);
 expect(actual.pages).toBe(27);expect(actual.readOnly).toBe(false);expect(actual.excluded).toHaveLength(0);expect(actual.rows).toHaveLength(162);
 for(const row of actual.rows){
  const c=reference.cases[row.page],native=c.origins.find(r=>r.text===row.text);
  expect(native).toBeTruthy();expect(row.replayAdvanceErrorPx).toBe(0);
  expect(row.differentPixels).toBe(0);expect(row.alphaAbsoluteError).toBe(0);
  expect(Math.abs(parseFloat(row.letterSpacing)*row.matrix[0]/row.ratio*.75-c.trackingPt)).toBeLessThan(1e-6);
  expect(row.originsPt).toHaveLength(native.glyphsPt.length);
  // Retain the existing expected-failure case and bound from the native
  // installed-tracking suite. This diagnostic does not resolve that defect.
  if(c.family==='Garamond'&&c.size===28&&c.trackingPt===0&&row.text==='MMMMMMMMMMMMMMMM')continue;
  row.originsPt.forEach((x,i)=>expect(Math.abs(x-native.glyphsPt[i])).toBeLessThan(.2));
 }
});

test('bold origin capture is opt-in and reconstructs independent regular/bold controls',async({baseURL},info)=>{
 test.setTimeout(150000);
 const root='tests/fixtures/small-text-raster/',reference=JSON.parse(readFileSync(root+'reference.json'));
 const sourceHash=createHash('sha256').update(readFileSync(root+'control.docx')).digest('hex');
 expect(sourceHash).toBe(reference.sourceSha256);
 const results=[];
 for(const includeBold of [false,true]){
  const output=info.outputPath(includeBold?'bold-paints.json':'regular-paints.json');
  execFileSync(process.execPath,['tools/probe-painted-glyph-origin-masks.mjs',root+'control.docx',output,`--base-url=${baseURL}`,...includeBold?['--include-bold']:[]],{timeout:120000,stdio:'pipe'});
  const actual=JSON.parse(readFileSync(output));results.push(actual);
  expect(actual.sourceSha256).toBe(sourceHash);expect(actual.pages).toBe(1);expect(actual.readOnly).toBe(false);
  expect(actual.rows).toHaveLength(includeBold?19:13);expect(actual.excluded).toHaveLength(includeBold?0:6);
  for(const row of actual.rows){
   expect(row.replayAdvanceErrorPx).toBe(0);expect(row.differentPixels).toBe(0);expect(row.alphaAbsoluteError).toBe(0);
   expect(row.originsPt).toHaveLength(row.text.length);
  }
 }
 expect(results[1].rows.filter(row=>!row.font.startsWith('bold '))).toEqual(results[0].rows);
 expect(results[0].excluded.every(row=>row.font.startsWith('bold '))).toBe(true);
});
