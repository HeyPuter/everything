import {test,expect} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';

test.setTimeout(180000);
let comparison;
test.beforeAll(async({},info)=>{
 const output=info.outputPath('comparison.json');
 execFileSync(process.execPath,['tools/probe-installed-tracking-origins.mjs',output,info.project.use.baseURL],{timeout:150000,stdio:'pipe'});
 comparison=JSON.parse(readFileSync(output)).comparison;
});

test('installed tracking controls validate measured origins against production paint masks',()=>{
 expect(comparison).toHaveLength(162);
 for(const row of comparison){
  expect(row.differentPixels,`${row.family}/${row.size}/${row.trackingPt}/${row.text}`).toBe(0);
  if(row.family==='Garamond'&&row.size===28&&row.trackingPt===0&&row.text==='MMMMMMMMMMMMMMMM')continue;
  expect(row.maxOriginErrorPt,`${row.family}/${row.size}/${row.trackingPt}/${row.text}`).toBeLessThan(.2);
 }
});

test('28-point untracked Garamond repeated M meets the existing 0.2-point native bound',()=>{
 test.fail(true,'Native export-position difference remains; independent wrap thresholds match outline advances. Keep the existing native bound.');
 const row=comparison.find(r=>r.family==='Garamond'&&r.size===28&&r.trackingPt===0&&r.text==='MMMMMMMMMMMMMMMM');
 expect(row.maxOriginErrorPt).toBeLessThan(.2);
});
