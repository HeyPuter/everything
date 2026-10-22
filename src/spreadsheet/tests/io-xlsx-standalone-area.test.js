import { expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';
const parser = new (new JSDOM('').window.DOMParser)();
const read = (zip,path) => new TextDecoder().decode(X.CFB.find(zip,path).content);
const set = (zip,path,text) => { const p=X.CFB.find(zip,path);p.content=new TextEncoder().encode(text);p.size=p.content.length; };
function book(grouping='standard') {
  const wb=new Workbook({sheets:[{name:'Data',charts:[{type:'area',title:'Area',anchor:{r:2,c:4},range:{r1:0,c1:0,r2:3,c2:2},
    stacked:grouping!=='standard',stack100:grouping==='percentStacked',legend:true,
    yMin:grouping==='percentStacked'?-1:-100,yMax:grouping==='percentStacked'?1:100,
    colors:['#123456','#789abc'],sourceRefs:[{name:'First',categories:'Data!A1:A4',values:'Data!B1:B4'},{name:'Second',categories:'Data!A1:A4',values:'Data!C1:C4'}],
    appearance:{plot:{x:.2,y:.2,w:.6,h:.6},categoryBetween:false,axisCrossings:{x:grouping==='standard'?40:0,y:'autoZero'},
      lines:[{width:3,color:'#102030'},{width:2,color:'#405060'}]},
  }]}]});
  [['A',-40,10],['B',60,20],['C',20,-30],['D',40,15]].forEach((row,r)=>row.forEach((v,c)=>wb.setInput(wb.activeSheetId,r,c,String(v))));
  return wb;
}
async function native(wb,change) {
  const zip=X.CFB.read(new Uint8Array(await(await workbookToXlsx(wb)).arrayBuffer()),{type:'array'});
  let xml=read(zip,'/xl/charts/chart1_1.xml');if(change) xml=change(xml);set(zip,'/xl/charts/chart1_1.xml',xml);
  set(zip,'/xl/workbook.xml',read(zip,'/xl/workbook.xml').replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g,''));
  return {wb:await workbookFromFile(X.CFB.write(zip,{type:'array',fileType:'zip'}),'native.xlsx'),xml};
}
function draw(wb) {
  const sheet=wb.activeSheet,chart=sheet.charts[0];
  return parser.parseFromString(renderChartSvg(chartData(wb,sheet.id,chart),chart,600,400),'image/svg+xml');
}
const areas = wb => [...draw(wb).querySelectorAll('.chart-area')].map(n=>n.getAttribute('d'));
it.each(['standard','stacked','percentStacked'])('imports and round-trips standalone %s area charts as editable areas',async grouping=>{
  let {wb}=await native(book(grouping));
  expect(wb.activeSheet.charts).toHaveLength(1);
  const paths=areas(wb);
  expect(paths).toHaveLength(2);
  for(let pass=0;pass<2;pass++) {
    const chart=wb.activeSheet.charts[0];
    expect(chart).toMatchObject({type:'area',stacked:grouping!=='standard',stack100:grouping==='percentStacked',colors:['#123456','#789abc']});
    expect(chart.appearance).not.toHaveProperty('seriesGroups');
    expect(chart.appearance.axisCrossings.x).toBe(grouping==='standard'?40:0);
    expect(areas(wb)).toEqual(paths);
    expect(draw(wb).querySelectorAll('.chart-area')).toHaveLength(2);
    expect(draw(wb).querySelector('.chart-area').getAttribute('fill')).toBe('#123456');
    const out=await native(wb);
    expect(out.xml.match(/<c:areaChart>/g)).toHaveLength(1);
    expect(out.xml).toContain(`<c:grouping val="${grouping}"/>`);
    expect(out.xml).not.toContain('<c:barChart>');wb=out.wb;
  }
  const sheet=wb.activeSheet,chart=sheet.charts[0];
  wb.setInput(sheet.id,1,1,'35');expect(areas(wb)).not.toEqual(paths);
  wb.undo();expect(areas(wb)).toEqual(paths);
  const id=wb.duplicateChart(sheet.id,chart.id);expect(wb.chartById(sheet.id,id).appearance).toEqual(chart.appearance);
});
it('uses custom ordinary baselines and algebraic stacked bases',async()=>{
  const ordinary=(await native(book())).wb,stacked=(await native(book('stacked'))).wb;
  expect(areas(ordinary)[0]).toBe('M 120 248 L 240 128 L 360 176 L 480 152 L 480 152 L 120 152 Z');
  // The second band begins at the first series, including a negative base.
  expect(areas(stacked)[1]).toBe('M 120 236 L 240 104 L 360 212 L 480 134 L 480 152 L 360 176 L 240 128 L 120 248 Z');
});
it.each([xml=>xml.replace('<c:grouping val="standard"/>',''),xml=>xml.replace('<c:grouping val="standard"/>','<c:grouping/>')])('uses standard grouping when the optional grouping or its value is absent',async change=>{
  const {wb}=await native(book(),change);expect(wb.activeSheet.charts[0]).toMatchObject({type:'area',stacked:false,stack100:false});expect(areas(wb)).toHaveLength(2);
});
it('edits area stacking without stale group metadata overriding the change',async()=>{
  const {wb}=await native(book('stacked')),sheet=wb.activeSheet,chart=sheet.charts[0];
  wb.updateChart(sheet.id,chart.id,{stacked:false,stack100:false});
  const {wb:back,xml}=await native(wb);expect(xml).toContain('<c:grouping val="standard"/>');expect(back.activeSheet.charts[0].stacked).toBe(false);
});
it('preserves gaps and signed percent stacks without invalid geometry',async()=>{
  const wb=book('percentStacked'),id=wb.activeSheetId;wb.setInput(id,1,1,'');
  const {wb:back}=await native(wb),svg=draw(back).documentElement.outerHTML;
  expect(svg).not.toMatch(/NaN|Infinity/);
  // An area drops to zero at the empty cell, as Excel draws it, rather than splitting in two.
  expect(draw(back).querySelectorAll('.chart-area')).toHaveLength(2);
  expect(chartData(back,back.activeSheetId,back.activeSheet.charts[0]).series[0].values).toEqual([-40,null,20,40]);
});
it('formats authored styled percent-area ticks as percentages',()=>{
  const doc=draw(book('percentStacked'));
  expect([...doc.querySelectorAll('text')].some(n=>n.textContent==='100%')).toBe(true);
});
it('retains explicit tick number formats on percent-area charts',async()=>{
  const wb=book('percentStacked'),chart=wb.activeSheet.charts[0];
  wb.updateChart(wb.activeSheetId,chart.id,{appearance:{...chart.appearance,yFormat:'0.0%'}});
  const {wb:back}=await native(wb);
  expect([...draw(back).querySelectorAll('text')].some(n=>n.textContent==='100.0%')).toBe(true);
});
