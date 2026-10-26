// Original DrawingML cached column-chart reader. Source chart parts are immutable.
import { parseXml } from './docx-xml.js';
import { partPathForUrl } from './package-part-paths.js';
import { UnsupportedDocumentError } from './errors.js';
import { drawingColor } from './docx-drawing-style.js';
import { readChartText, readChartRichTitle } from './docx-chart-text.js';
import { MC, alternateBranch, activeDescendants } from './docx-compatibility.js';
export const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const children = n => [...(n?.children || [])].flatMap(c => c.namespaceURI === MC && c.localName === 'AlternateContent' ? children(alternateBranch(c)) : [c]);
const child = (n, name, ns = C) => children(n).find(c => c.namespaceURI === ns && c.localName === name);
const fail = why => { throw new UnsupportedDocumentError(`charts with ${why}`); };
function check(n, names, repeated = [], ns = C) {
  const seen = new Set();
  for (const c of children(n)) {
    if (c.namespaceURI !== ns || !names.includes(c.localName) || seen.has(c.localName) && !repeated.includes(c.localName)) fail(`unsupported or duplicate ${c.localName}`);
    seen.add(c.localName);
  }
}
function val(n, name, fallback) {
  const node = child(n, name);
  if (!node) return fallback;
  check(node, []);
  const defaults = { date1904: 'true', roundedCorners: 'true', autoTitleDeleted: 'true', autoUpdate: 'true', noMultiLvlLbl: 'true', showDLblsOverMax: 'true', showLegendKey: 'true', showVal: 'true', showCatName: 'true', showSerName: 'true', showPercent: 'true', showBubbleSize: 'true', dispBlanksAs: 'zero', invertIfNegative: 'true', grouping: 'clustered', gapWidth: '150%', overlap: '0%', legendPos: 'r', lblAlgn: 'ctr', lblOffset: '100%', orientation: 'minMax', majorTickMark: 'cross', minorTickMark: 'cross', tickLblPos: 'nextTo', delete: 'true', auto: 'true', varyColors: 'true', overlay: 'true', plotVisOnly: 'true' };
  const value = node.getAttribute('val') ?? defaults[name]; if (value === undefined) fail(`missing ${name} value`);
  return value.trim();
}
function number(raw, label, fallback) {
  if (raw === undefined) return fallback;
  raw = raw?.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw) || !Number.isFinite(Number(raw)) || Math.abs(Number(raw)) > 1e12 || /[1-9]/.test(raw.split(/[eE]/)[0]) && Math.abs(Number(raw)) < 1e-9) fail(`invalid or out-of-range ${label}`);
  return Number(raw);
}
function integer(raw, label, max = 1000) {
  const value = number(raw, label);
  if (!Number.isInteger(value) || value < 0 || value > max) fail(`invalid ${label}`);
  return value;
}
function choice(raw, choices, label) { if (!choices.includes(raw)) fail(`unsupported ${label}`); return raw; }
function color(n, fallback, scheme) {
  if (!n) return fallback;
  if (children(n).length !== 1) fail('missing or conflicting solid colors');
  return `#${drawingColor(children(n)[0], scheme).toLowerCase()}`;
}
function shape(n, fallback = null, scheme, variableWidth = false) {
  if (n?.hasAttribute('bwMode') && !['auto', 'clr'].includes(n.getAttribute('bwMode'))) fail('black-and-white chart transforms');
  check(n, ['solidFill', 'noFill', 'ln', 'effectLst'], [], A);
  check(child(n, 'effectLst', A), []);
  if (child(n, 'solidFill', A) && child(n, 'noFill', A)) fail('conflicting fills');
  check(child(n, 'noFill', A), []);
  const line = child(n, 'ln', A); check(line, ['solidFill', 'noFill', 'round'], [], A);
  check(child(line, 'round', A), []);
  for (const [key, expected] of [['cap', 'flat'], ['cmpd', 'sng'], ['algn', 'ctr']]) if (line?.hasAttribute(key) && line.getAttribute(key) !== expected) fail(`unsupported line ${key}`);
  if (child(line, 'solidFill', A) && child(line, 'noFill', A)) fail('conflicting line fills');
  check(child(line, 'noFill', A), []);
  const lineWidth = line?.hasAttribute('w') ? number(line.getAttribute('w'), 'line width') : 9525;
  if (variableWidth ? !Number.isInteger(lineWidth) || lineWidth < 0 || lineWidth > 20116800 : lineWidth !== 9525) fail('custom or invalid line widths');
  return { ...(variableWidth ? { lineWidth: lineWidth / 9525 } : {}), fill: child(n, 'noFill', A) ? null : color(child(n, 'solidFill', A), fallback, scheme), line: child(line, 'noFill', A) ? null : color(child(line, 'solidFill', A), null, scheme), ...(child(line, 'round', A) ? { lineJoin: 'round' } : {}) };
}
function cache(source, kind) {
  check(source, [`${kind}Ref`, `${kind}Lit`]);
  const ref = child(source, `${kind}Ref`), literal = child(source, `${kind}Lit`);
  if (!!ref === !!literal) fail('missing or conflicting cached data');
  if (ref) { check(ref, ['f', `${kind}Cache`]); if (!child(ref, 'f')) fail('missing reference formula'); }
  const data = literal || child(ref, `${kind}Cache`); if (!data) fail('missing cached values');
  check(data, kind === 'num' ? ['formatCode', 'ptCount', 'pt'] : ['ptCount', 'pt'], ['pt']);
  if (kind === 'num' && child(data, 'formatCode') && child(data, 'formatCode').textContent !== 'General') fail('custom number formats');
  const count = integer(val(data, 'ptCount'), 'point count'), result = Array(count), seen = new Set();
  for (const pt of children(data).filter(n => n.localName === 'pt')) {
    check(pt, ['v']); const index = integer(pt.getAttribute('idx'), 'point index');
    if (index >= count || seen.has(index) || !child(pt, 'v')) fail('invalid cached point indices'); seen.add(index);
    const value = child(pt, 'v').textContent;
    if (value.length > 200) fail('oversized labels');
    result[index] = kind === 'num' ? number(value, 'cached number') : value;
  }
  if (!count || seen.size !== count) fail('incomplete cached data');
  return result;
}
// Builder-shaped XY charts move axes (horizontal bars, scatter X) and may cross
// value axes at category midpoints; column charts keep the original subset.
function axis(n, kind, scheme, text, fonts, { position = kind === 'category' ? 'b' : 'l', between = ['between'], formats = kind === 'value' ? ['General', '0%'] : ['General'] } = {}) {
  if (!n) fail('missing axes');
  check(n, ['axId', 'scaling', 'delete', 'axPos', 'majorGridlines', 'numFmt', 'majorTickMark', 'minorTickMark', 'tickLblPos', 'spPr', 'txPr', 'crossAx', 'crosses', 'crossesAt', ...(kind === 'category' ? ['auto', 'lblAlgn', 'lblOffset', 'noMultiLvlLbl'] : ['crossBetween'])]);
  const fmt = child(n, 'numFmt'); check(fmt, []);
  const numberFormat = fmt ? choice(fmt.getAttribute('formatCode'), formats, 'axis number format') : null;
  if (fmt && !['0', '1', 'false', 'true'].includes(fmt.getAttribute('sourceLinked'))) fail('invalid number-format source link');
  const scaling = child(n, 'scaling'); if (!scaling) fail('missing axis scaling'); check(scaling, ['orientation']);
  choice(val(scaling, 'orientation', 'minMax'), ['minMax'], 'axis orientation');
  choice(val(n, 'delete', '0'), ['0', 'false'], 'hidden axes');
  choice(val(n, 'axPos'), [position], 'axis position');
  choice(val(n, 'majorTickMark', 'out'), ['out', 'none'], 'major ticks');
  choice(val(n, 'minorTickMark', 'none'), ['none'], 'minor ticks');
  choice(val(n, 'tickLblPos', 'nextTo'), ['nextTo'], 'label position');
  if (child(n, 'crosses') && child(n, 'crossesAt')) fail('conflicting axis crossings');
  choice(val(n, 'crosses', 'autoZero'), ['autoZero'], 'axis crossing');
  if (number(val(n, 'crossesAt', '0'), 'axis crossing') !== 0) fail('nonzero axis crossings');
  let crossBetween;
  if (kind === 'category') {
    choice(val(n, 'auto', '1'), ['1', 'true'], 'category axis');
    choice(val(n, 'lblAlgn', 'ctr'), ['ctr'], 'category label alignment');
    if (!['100', '100%'].includes(val(n, 'lblOffset', '100'))) fail('custom category label offsets');
    choice(val(n, 'noMultiLvlLbl', '0'), ['0', '1', 'false', 'true'], 'multilevel label flag');
  } else crossBetween = choice(val(n, 'crossBetween', 'between'), between, 'category crossings');
  const grid = child(n, 'majorGridlines'); check(grid, ['spPr']);
  const lineColor = (props, fallback) => { const style = shape(props, null, scheme); return child(props, 'ln', A) ? style.line : fallback; };
  const labelText = readChartText(child(n, 'txPr'), text, scheme, fonts);
  return { id: integer(val(n, 'axId'), 'axis ID', 4294967295), cross: integer(val(n, 'crossAx'), 'cross axis', 4294967295), line: lineColor(child(n, 'spPr'), '#777777'), grid: grid ? lineColor(child(grid, 'spPr'), '#d0d0d0') : null, ticks: val(n, 'majorTickMark', 'out') === 'out', ...(numberFormat ? { numberFormat } : {}), ...(labelText ? { text: labelText } : {}), ...(between.length > 1 ? { crossBetween } : {}) };
}

// Markers are explicit circles or none; automatic symbols cycle by series.
function seriesMarker(n, scheme) {
  if (!n) fail('automatic series markers');
  check(n, ['symbol', 'size', 'spPr']);
  if (choice(val(n, 'symbol'), ['none', 'circle'], 'marker symbol') === 'none') return null;
  const size = integer(val(n, 'size'), 'marker size', 72), props = child(n, 'spPr');
  if (size < 2) fail('invalid marker size');
  if (!props || !child(props, 'ln', A) || !child(props, 'solidFill', A) && !child(props, 'noFill', A)) fail('inherited marker appearance');
  return { symbol: 'circle', size, ...shape(props, null, scheme, true) };
}

function extensions(node, kind) {
  check(node, ['ext'], ['ext']);
  const seen = new Set();
  for (const ext of children(node)) {
    const uri = ext.getAttribute('uri');
    if (!uri || seen.has(uri) || children(ext).length !== 1) fail('invalid chart extensions');
    seen.add(uri); const value = children(ext)[0];
    if (kind === 'series' && uri === '{C3380CC4-5D6E-409C-BE32-E72D297353CC}' && value.namespaceURI === 'http://schemas.microsoft.com/office/drawing/2014/chart' && value.localName === 'uniqueId') {
      check(value, []); if (!value.hasAttribute('val') || value.getAttribute('val').length > 200) fail('invalid series unique IDs');
    } else if (kind === 'chart' && uri === '{56B9EC1D-385E-4148-901F-78D8002777C0}' && value.namespaceURI === 'http://schemas.microsoft.com/office/drawing/2017/03/chart' && value.localName === 'dataDisplayOptions16') {
      check(value, ['dispNaAsBlank'], [], value.namespaceURI);
      const flag = child(value, 'dispNaAsBlank', value.namespaceURI); check(flag, []);
      if (flag) choice(flag.getAttribute('val') ?? 'false', ['0', '1', 'false', 'true'], 'N/A blank flag');
      // Complete finite caches below contain neither blank nor #N/A points.
    } else fail('unsupported chart extensions');
  }
}

function explicitChartStyles(parts, path, style) {
  const slash = path.lastIndexOf('/'), chartRelsPath = `${path.slice(0, slash + 1)}_rels/${path.slice(slash + 1)}.rels`;
  const chartRels = parts[chartRelsPath] ? children(parseXml(parts[chartRelsPath]).documentElement) : [];
  const styleLinks = chartRels.filter(n => n.namespaceURI === REL && n.getAttribute('Type') === 'http://schemas.microsoft.com/office/2011/relationships/chartStyle');
  if (style || styleLinks.length) {
    let styleRoot;
    const CS = 'http://schemas.microsoft.com/office/drawing/2012/chartStyle';
    if (styleLinks.length) {
      if (styleLinks.length !== 1 || ![null, 'Internal'].includes(styleLinks[0].getAttribute('TargetMode'))) fail('duplicate or external chart styles');
      let target; try { target = new URL(styleLinks[0].getAttribute('Target'), `https://docx.invalid/${path}`); } catch { fail('invalid chart style targets'); }
      const name = decodeURIComponent(target.pathname).slice(1);
      if (target.origin !== 'https://docx.invalid' || target.search || target.hash || !parts[name]) fail('missing or external chart styles');
      styleRoot = parseXml(parts[name]).documentElement;
      if (styleRoot.namespaceURI !== CS || styleRoot.localName !== 'chartStyle') fail('invalid chart styles');
    }
    const completeShape = (node, role, lineOnly = false, strictLineAttributes = true) => {
      const props = child(node, 'spPr'), line = child(props, 'ln', A);
      if (!props || !child(props, 'effectLst', A) || !line || !child(line, 'noFill', A) && !child(line, 'solidFill', A) || !lineOnly && !child(props, 'noFill', A) && !child(props, 'solidFill', A)) fail('inherited chart appearance');
      if (strictLineAttributes && child(line, 'solidFill', A) && !['w', 'cap', 'cmpd', 'algn'].every(k => line.hasAttribute(k))) fail('inherited chart line formatting');
      if (styleRoot) {
        const entries = children(styleRoot).filter(n => n.namespaceURI === CS && n.localName === role);
        if (entries.length !== 1) fail('missing or duplicate chart style entries');
        const entry = entries[0], mods = (entry.getAttribute('mods') || '').split(/\s+/).filter(Boolean);
        if (mods.some(m => !['allowNoFillOverride', 'allowNoLineOverride'].includes(m))) fail('unsupported chart style modifiers');
        const inherited = child(entry, 'spPr', CS);
        if (child(props, 'noFill', A) && (child(inherited, 'solidFill', A) || !['0', undefined].includes(child(entry, 'fillRef', CS)?.getAttribute('idx'))) && !mods.includes('allowNoFillOverride')) fail('a chart style that prevents no-fill overrides');
        if (child(line, 'noFill', A) && (child(child(inherited, 'ln', A), 'solidFill', A) || !['0', undefined].includes(child(entry, 'lnRef', CS)?.getAttribute('idx'))) && !mods.includes('allowNoLineOverride')) fail('a chart style that prevents no-line overrides');
      }
    };
    return completeShape;
  }
  return null;
}

const FULL_TEXT = ['fontSize', 'fontAscii', 'bold', 'italic', 'color', 'kerning'];
const latinOnly = list => !list.some(t => /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(t));
// Retained doughnut and pie charts use cached data; formulas/workbooks are never
// executed. Pie charts are the zero-hole case and must declare one series.
function readDoughnut(root, chart, scheme, fonts, text, styledShape) {
  check(chart, ['title', 'autoTitleDeleted', 'plotArea', 'legend', 'plotVisOnly', 'dispBlanksAs', 'showDLblsOverMax', 'extLst']);
  choice(val(chart, 'plotVisOnly', '1'), ['1','true'], 'hidden data');
  choice(val(chart, 'dispBlanksAs', 'gap'), ['gap','zero','span'], 'blank display');
  choice(val(chart, 'showDLblsOverMax', '0'), ['0','1','false','true'], 'label maximum flag');
  extensions(child(chart, 'extLst'), 'chart');
  const declaredShape = (node, role) => {
    const props = child(node, 'spPr'), line = child(props, 'ln', A);
    if (!props || !child(props, 'effectLst', A) || !line ||
        !child(props, 'solidFill', A) && !child(props, 'noFill', A) ||
        !child(line, 'solidFill', A) && !child(line, 'noFill', A)) fail('inherited doughnut appearance');
    styledShape?.(node, role, false, false);
    return shape(props, null, scheme, true);
  };
  const layout = (node, title = false) => {
    check(node, ['manualLayout']);
    const manual = child(node, 'manualLayout');
    if (!manual) { if (title) fail('automatic doughnut title placement'); return null; }
    check(manual, ['layoutTarget','xMode','yMode','wMode','hMode','x','y','w','h']);
    choice(val(manual, 'layoutTarget', 'inner'), ['inner'], 'outer doughnut layout');
    for (const key of ['xMode','yMode']) choice(val(manual, key, 'factor'), ['edge'], 'relative doughnut layout');
    for (const key of ['wMode','hMode']) choice(val(manual, key, 'factor'), ['factor'], 'edge-sized doughnut layout');
    const result = {};
    for (const key of ['x','y',...(!title ? ['w','h'] : [])]) {
      result[key] = number(val(manual, key), 'manual layout');
      if (result[key] === undefined || result[key] < 0 || result[key] > 1 || ['w','h'].includes(key) && !result[key]) fail('out-of-frame doughnut layout');
    }
    if (title && (child(manual,'w') || child(manual,'h'))) fail('explicit doughnut title extents');
    if (!title && (result.x+result.w > 1+1e-9 || result.y+result.h > 1+1e-9)) fail('out-of-frame doughnut layout');
    return result;
  };
  const plot = child(chart,'plotArea'), pie = !child(plot,'doughnutChart'), kind = pie ? 'pieChart' : 'doughnutChart';
  check(plot,['layout',kind,'spPr']);
  const ring = child(plot,kind);check(ring,['varyColors','ser','dLbls','firstSliceAng',...(pie?[]:['holeSize'])],['ser']);
  choice(val(ring,'varyColors','1'),['0','1','false','true'],'per-point color flag');
  const scalar = (key,fallback) => { const n=child(ring,key);check(n,[]);return n?.getAttribute('val') ?? fallback; };
  const angle=integer(scalar('firstSliceAng','0'),'first slice angle',360);
  const hole=pie?0:integer(scalar('holeSize','10').replace(/%$/,''),'hole size',90);if(!pie&&hole<10)fail('invalid hole size');
  const switches=['showLegendKey','showVal','showCatName','showSerName','showPercent','showBubbleSize'];
  const labels = node => {
    check(node,['delete',...switches,'showLeaderLines']);
    const deleted=choice(val(node,'delete','0'),['0','1','false','true'],'label deletion');
    const flags=Object.fromEntries(switches.filter(k=>child(node,k)).map(k=>[k,['1','true'].includes(choice(val(node,k,'0'),['0','1','false','true'],'label flag'))]));
    const leader=child(node,'showLeaderLines');check(leader,[]);
    if(leader)choice(leader.getAttribute('val')??'true',['0','1','false','true'],'leader line flag');
    return {deleted:child(node,'delete')?['1','true'].includes(deleted):undefined,flags};
  };
  const chartLabels=labels(child(ring,'dLbls')),orders=new Set(),indices=new Set();
  const series=children(ring).filter(n=>n.localName==='ser').map((node,index)=>{
    check(node,['idx','order','tx','spPr','explosion','dPt','dLbls','cat','val','extLst'],['dPt']);
    extensions(child(node,'extLst'),'series');
    const order=integer(val(node,'order'),'series order',4294967295),id=integer(val(node,'idx'),'series index',4294967295);
    if(orders.has(order)||indices.has(id))fail('duplicate series');orders.add(order);indices.add(id);
    const explosion=child(node,'explosion');check(explosion,[]);
    if(explosion&&number(explosion.getAttribute('val')??'0','explosion')!==0)fail('exploded doughnuts');
    let name=`Series ${index+1}`;const tx=child(node,'tx');
    if(tx){if(child(tx,'v')){check(tx,['v']);name=child(tx,'v').textContent;}else{const names=cache(tx,'str');if(names.length!==1)fail('series names with multiple values');name=names[0];}}
    if(name.length>200)fail('oversized series names');
    const categories=cache(child(node,'cat'),'str'),values=cache(child(node,'val'),'num');
    if(values.length>100||categories.length!==values.length)fail('different or excessive point counts');
    const ownLabels=child(node,'dLbls')?labels(child(node,'dLbls')):null;
    if(!(ownLabels?.deleted ?? chartLabels.deleted) && Object.values({...chartLabels.flags,...ownLabels?.flags}).some(Boolean))fail('visible doughnut data labels');
    if(child(node,'spPr'))declaredShape(node,'dataPoint');
    const points=Array(values.length);
    for(const point of children(node).filter(n=>n.localName==='dPt')){
      check(point,['idx','bubble3D','explosion','spPr','extLst']);extensions(child(point,'extLst'),'series');
      const i=integer(val(point,'idx'),'point index');if(i>=values.length||points[i])fail('invalid or duplicate doughnut point');
      const bubble=child(point,'bubble3D');check(bubble,[]);if(bubble)choice(bubble.getAttribute('val')??'true',['0','false'],'3D doughnut points');
      const exp=child(point,'explosion');check(exp,[]);if(exp&&number(exp.getAttribute('val')??'0','explosion')!==0)fail('exploded doughnut points');
      points[i]=declaredShape(point,'dataPoint');
    }
    if(points.filter(Boolean).length!==values.length)fail('inherited doughnut point colors');
    return {order,name,categories,values,points};
  }).sort((a,b)=>a.order-b.order);
  if(!series.length||series.length>(pie?1:20))fail('missing or excessive doughnut series');
  let title=null;const titleNode=child(chart,'title');
  const autoDeleted=choice(val(chart,'autoTitleDeleted','1'),['0','1','false','true'],'automatic title flag');
  if(child(titleNode,'tx')){
    // Rich titles are placed automatically above the plot, like column titles.
    check(titleNode,['tx','layout','overlay','spPr','txPr']);check(child(titleNode,'layout'),[]);
    choice(val(titleNode,'overlay','0'),['0','false'],'title overlay');
    const tx=child(titleNode,'tx');check(tx,['rich']);if(!child(tx,'rich'))fail('missing rich doughnut title');
    const paragraphs=readChartRichTitle(child(tx,'rich'),readChartText(child(titleNode,'txPr'),text,scheme,fonts),scheme,fonts);
    title={paragraphs,style:paragraphs[0].runs[0]?.style||paragraphs[0].style,overlay:false,background:declaredShape(titleNode,'title')};
  }else if(titleNode){
    check(titleNode,['layout','overlay','spPr','txPr']);
    choice(val(titleNode,'overlay','0'),['0','1','false','true'],'title overlay');
    const style=readChartText(child(titleNode,'txPr'),text,scheme,fonts);
    if(!['fontSize','fontAscii','bold','italic','color','kerning'].every(k=>style?.[k]!==undefined))fail('inherited doughnut title text');
    if(series.length!==1||/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(series[0].name))fail('automatic multiseries or mixed-script titles');
    title={text:series[0].name,style,layout:layout(child(titleNode,'layout'),true),background:declaredShape(titleNode,'title')};
  }else if(['0','false'].includes(autoDeleted))fail('automatic doughnut title placement');
  // Legends list the first series' categories. Their text must be fully declared.
  const legend=child(chart,'legend');let legendText;check(legend,['legendPos','overlay','spPr','txPr']);
  if(legend){
    choice(val(legend,'legendPos','r'),['r','b'],'legend position');choice(val(legend,'overlay','0'),['0','false'],'overlaid legends');
    const style=declaredShape(legend,'legend');if(style.fill||style.line)fail('filled or bordered legends');
    legendText=readChartText(child(legend,'txPr'),text,scheme,fonts);
    if(!FULL_TEXT.every(k=>legendText?.[k]!==undefined))fail('inherited legend text formatting');
    if(!latinOnly(series[0].categories))fail('explicit mixed-script label formatting');
  }
  return {type:pie?'pie':'doughnut',series,angle,hole,layout:layout(child(plot,'layout')),title,
    background:declaredShape(root,'chartArea'),plot:declaredShape(plot,'plotArea'),
    ...(legend?{legend:true,legendPosition:val(legend,'legendPos','r'),legendText}:{})};
}

export function readChart(parts, reference, readSchemeColor, readFonts) {
  check(reference, []);
  const relId = reference.getAttributeNS(R, 'id');
  const rels = parts['word/_rels/document.xml.rels'] && parseXml(parts['word/_rels/document.xml.rels']);
  const matches = [...(rels?.getElementsByTagNameNS(REL, 'Relationship') || [])].filter(n => n.getAttribute('Id') === relId);
  if (!relId || matches.length !== 1) fail('missing or ambiguous relationships');
  const rel = matches[0];
  if (rel.getAttribute('Type') !== `${R}/chart` || ![null, 'Internal'].includes(rel.getAttribute('TargetMode'))) fail('external or non-chart relationships');
  let url, path;
  try { url = new URL(rel.getAttribute('Target'), 'https://docx.invalid/word/document.xml'); path = partPathForUrl(parts, url); } catch { fail('invalid targets'); }
  if (url.origin !== 'https://docx.invalid' || url.search || url.hash || !parts[path]) fail('missing or external parts');
  // A chart can replace its containing document's theme. Do not resolve its
  // scheme colors against that document when a chart-local override is present.
  let chartRelationships;
  const checkTheme = () => {
    if (!chartRelationships) {
      const slash = path.lastIndexOf('/'), relPath = `${path.slice(0, slash + 1)}_rels/${path.slice(slash + 1)}.rels`;
      chartRelationships = parts[relPath] ? children(parseXml(parts[relPath]).documentElement) : [];
    }
    if (chartRelationships.some(n => n.namespaceURI === REL && n.getAttribute('Type') === `${R}/themeOverride`)) fail('chart-local theme overrides');
  };
  const scheme = name => { checkTheme(); return readSchemeColor?.(name); };
  const fonts = name => { checkTheme(); return readFonts?.(name); };
  const types = parseXml(parts['[Content_Types].xml']);
  if (![...types.getElementsByTagNameNS('*', 'Override')].some(n => n.getAttribute('PartName') === `/${path}` && n.getAttribute('ContentType') === 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml')) fail('incorrect content types');
  const root = parseXml(parts[path]).documentElement;
  if (root.namespaceURI !== C || root.localName !== 'chartSpace') fail('invalid chart parts');
  activeDescendants(root);
  check(root, ['date1904', 'lang', 'roundedCorners', 'style', 'chart', 'spPr', 'txPr', 'externalData']);
  choice(val(root, 'date1904', '0'), ['0', '1', 'false', 'true'], 'date system');
  choice(val(root, 'roundedCorners', '0'), ['0', 'false'], 'rounded chart frames');
  const style = child(root, 'style');
  if (style && (integer(val(root, 'style'), 'chart style', 48) < 1)) fail('invalid chart style');
  const text = readChartText(child(root, 'txPr'), undefined, scheme, fonts);
  const external = child(root, 'externalData'); check(external, ['autoUpdate']);
  if (external) {
    choice(val(external, 'autoUpdate', '0'), ['0', 'false'], 'automatic data refresh');
    const slash = path.lastIndexOf('/'), rp = `${path.slice(0, slash + 1)}_rels/${path.slice(slash + 1)}.rels`;
    const links = parts[rp] ? children(parseXml(parts[rp]).documentElement) : [];
    const found = links.filter(n => n.namespaceURI === REL && n.getAttribute('Id') === external.getAttributeNS(R, 'id'));
    if (found.length !== 1 || found[0].getAttribute('Type') !== `${R}/package` || ![null, 'Internal'].includes(found[0].getAttribute('TargetMode'))) fail('missing or external chart workbooks');
    let target; try { target = new URL(found[0].getAttribute('Target'), `https://docx.invalid/${path}`); } catch { fail('invalid workbook targets'); }
    const workbook = decodeURIComponent(target.pathname).slice(1);
    if (target.origin !== 'https://docx.invalid' || target.search || target.hash || !parts[workbook]) fail('missing or external chart workbooks');
    const contentType = [...types.documentElement.children].find(n => n.localName === 'Override' && n.getAttribute('PartName') === `/${workbook}`)?.getAttribute('ContentType') || [...types.documentElement.children].find(n => n.localName === 'Default' && n.getAttribute('Extension') === workbook.split('.').at(-1))?.getAttribute('ContentType');
    if (contentType !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') fail('non-OOXML chart workbooks');
  }
  const chart = child(root, 'chart'); if (!chart) fail('missing chart');
  if (child(child(chart, 'plotArea'), 'doughnutChart') || child(child(chart, 'plotArea'), 'pieChart')) return { path, relId, chart: readDoughnut(root, chart, scheme, fonts, text, explicitChartStyles(parts, path, style)) };
  check(chart, ['title', 'autoTitleDeleted', 'plotArea', 'legend', 'plotVisOnly', 'dispBlanksAs', 'showDLblsOverMax', 'extLst']); choice(val(chart, 'plotVisOnly', '1'), ['1', 'true'], 'hidden data');
  const titleNode = child(chart, 'title');
  const autoTitleDeleted = choice(val(chart, 'autoTitleDeleted', '1'), ['0', '1', 'false', 'true'], 'automatic chart titles');
  if (!titleNode && ['0', 'false'].includes(autoTitleDeleted)) fail('generated column chart titles');
  let title;
  if (titleNode) {
    check(titleNode, ['tx', 'layout', 'overlay', 'spPr', 'txPr']);
    check(child(titleNode, 'layout'), []);
    const tx = child(titleNode, 'tx'); check(tx, ['rich']);
    const rich = child(tx, 'rich'); if (!rich) fail('missing rich column chart title');
    const titleText = readChartText(child(titleNode, 'txPr'), text, scheme, fonts);
    const paragraphs = readChartRichTitle(rich, titleText, scheme, fonts);
    title = { paragraphs, style: paragraphs[0].runs[0]?.style || paragraphs[0].style, overlay: ['1', 'true'].includes(choice(val(titleNode, 'overlay', child(titleNode, 'overlay') ? '1' : '0'), ['0', '1', 'false', 'true'], 'title overlay')), background: shape(child(titleNode, 'spPr'), null, scheme) };
  }
  choice(val(chart, 'dispBlanksAs', 'gap'), ['gap', 'zero', 'span'], 'blank display');
  choice(val(chart, 'showDLblsOverMax', '0'), ['0', '1', 'false', 'true'], 'label maximum flag');
  extensions(child(chart, 'extLst'), 'chart');
  const plot = child(chart, 'plotArea');
  const kind = ['barChart', 'lineChart', 'areaChart', 'scatterChart'].find(name => child(plot, name));
  if (!kind) fail('unsupported chart types');
  const scatter = kind === 'scatterChart', stroked = kind === 'lineChart' || scatter;
  check(plot, ['layout', kind, ...(scatter ? [] : ['catAx']), 'valAx', 'spPr'], scatter ? ['valAx'] : []); check(child(plot, 'layout'), []);
  const bars = child(plot, kind);
  check(bars, {
    barChart: ['barDir', 'grouping', 'varyColors', 'ser', 'dLbls', 'gapWidth', 'overlap', 'axId'],
    lineChart: ['grouping', 'varyColors', 'ser', 'dLbls', 'marker', 'smooth', 'axId'],
    areaChart: ['grouping', 'varyColors', 'ser', 'dLbls', 'axId'],
    scatterChart: ['scatterStyle', 'varyColors', 'ser', 'dLbls', 'axId'],
  }[kind], ['ser', 'axId']);
  const labels = child(bars, 'dLbls'), switches = ['showLegendKey', 'showVal', 'showCatName', 'showSerName', 'showPercent', 'showBubbleSize'];
  check(labels, switches);
  for (const name of switches) choice(val(labels, name, '0'), ['0', 'false'], 'visible data labels');
  choice(val(bars, 'varyColors', '0'), ['0', 'false'], 'per-point colors');
  let type, grouping, overlap, gap, markers = true;
  if (kind === 'barChart') {
    type = choice(val(bars, 'barDir'), ['col', 'bar'], 'bar direction') === 'bar' ? 'bar' : 'column';
    grouping = choice(val(bars, 'grouping', 'clustered'), ['clustered', 'stacked', 'percentStacked'], 'bar grouping');
    overlap = number(val(bars, 'overlap', '0').replace(/%$/, ''), 'overlap');
    if (!Number.isInteger(overlap) || overlap < -100 || overlap > 100) fail('invalid overlap');
    gap = integer(val(bars, 'gapWidth', '150').replace(/%$/, ''), 'gap width', 500);
  } else if (kind === 'lineChart') {
    type = 'line'; grouping = choice(val(bars, 'grouping', 'standard'), ['standard'], 'line grouping');
    markers = ['1', 'true'].includes(choice(val(bars, 'marker', '1'), ['0', '1', 'false', 'true'], 'marker flag'));
    choice(val(bars, 'smooth', '0'), ['0', 'false'], 'smoothed lines');
  } else if (kind === 'areaChart') {
    type = 'area'; grouping = choice(val(bars, 'grouping', 'standard'), ['standard', 'stacked'], 'area grouping');
  } else {
    // Both styles draw exactly what each series declares: its line and marker.
    type = 'scatter'; choice(val(bars, 'scatterStyle'), ['lineMarker', 'marker'], 'scatter style');
  }
  const orders = new Set(), indices = new Set();
  const seriesChildren = {
    barChart: ['idx', 'order', 'tx', 'spPr', 'invertIfNegative', 'cat', 'val', 'extLst'],
    lineChart: ['idx', 'order', 'tx', 'spPr', 'marker', 'cat', 'val', 'smooth', 'extLst'],
    areaChart: ['idx', 'order', 'tx', 'spPr', 'cat', 'val', 'extLst'],
    scatterChart: ['idx', 'order', 'tx', 'spPr', 'marker', 'xVal', 'yVal', 'smooth', 'extLst'],
  }[kind];
  const series = children(bars).filter(n => n.localName === 'ser').map((n, index) => {
    check(n, seriesChildren);
    extensions(child(n, 'extLst'), 'series');
    const order = integer(val(n, 'order'), 'series order', 4294967295), id = integer(val(n, 'idx'), 'series index', 4294967295);
    if (orders.has(order) || indices.has(id)) fail('duplicate series'); orders.add(order); indices.add(id);
    let name = `Series ${index + 1}`;
    const tx = child(n, 'tx');
    if (tx) { if (child(tx, 'v')) { check(tx, ['v']); name = child(tx, 'v').textContent; } else { const values = cache(tx, 'str'); if (values.length !== 1) fail('series names with multiple values'); name = values[0]; } }
    if (name.length > 200) fail('oversized series names');
    if (kind === 'barChart') {
      const categories = cache(child(n, 'cat'), 'str'), values = cache(child(n, 'val'), 'num');
      if (categories.length !== values.length) fail('different category and value counts');
      const invert = choice(val(n, 'invertIfNegative', '1'), ['0', '1', 'false', 'true'], 'negative inversion');
      return { order, name, categories, values, invertIfNegative: invert === '1' || invert === 'true', ...shape(child(n, 'spPr'), ['#4472c4', '#ed7d31', '#a5a5a5'][index % 3], scheme) };
    }
    // Other chart types have no palette fallback here: series paint is explicit.
    const props = child(n, 'spPr');
    if (!props || !child(props, 'ln', A) || !stroked && !child(props, 'solidFill', A) && !child(props, 'noFill', A)) fail('inherited series appearance');
    if (!stroked) {
      const categories = cache(child(n, 'cat'), 'str'), values = cache(child(n, 'val'), 'num');
      if (categories.length !== values.length) fail('different category and value counts');
      return { order, name, categories, values, ...shape(props, null, scheme) };
    }
    choice(val(n, 'smooth'), ['0', 'false'], 'smoothed or implicitly smoothed series');
    const { lineWidth, line, lineJoin } = shape(props, null, scheme, true), point = seriesMarker(child(n, 'marker'), scheme);
    const stroke = { line, lineWidth, ...(lineJoin ? { lineJoin } : {}), marker: markers ? point : null };
    if (!scatter) {
      const categories = cache(child(n, 'cat'), 'str'), values = cache(child(n, 'val'), 'num');
      if (categories.length !== values.length) fail('different category and value counts');
      return { order, name, categories, values, ...stroke };
    }
    // Text X values plot at their 1-based positions.
    const x = child(n, 'xVal'), numeric = !!(child(x, 'numRef') || child(x, 'numLit'));
    const xs = cache(x, numeric ? 'num' : 'str'), values = cache(child(n, 'yVal'), 'num');
    if (xs.length !== values.length) fail('different X and Y value counts');
    return { order, name, xValues: numeric ? xs : xs.map((_, i) => i + 1), ...(numeric ? {} : { categories: xs }), values, ...stroke };
  }).sort((a, b) => a.order - b.order);
  if (!series.length || series.length > 20 || series.some(s => s.values.length > 100) || !scatter && series.some(s => JSON.stringify(s.categories) !== JSON.stringify(series[0].categories))) fail('too many or inconsistent series');
  let categoryAxis, valueAxis, xAxis, axisNodes;
  if (scatter) {
    const nodes = children(plot).filter(n => n.localName === 'valAx'), at = pos => nodes.find(n => child(n, 'axPos')?.getAttribute('val') === pos);
    if (nodes.length !== 2 || !at('b') || !at('l')) fail('unsupported scatter axis positions');
    xAxis = axis(at('b'), 'value', scheme, text, fonts, { position: 'b', between: ['midCat', 'between'], formats: ['General'] });
    valueAxis = axis(at('l'), 'value', scheme, text, fonts, { position: 'l', between: ['midCat', 'between'] });
    axisNodes = [[at('b'), 'categoryAxis', xAxis], [at('l'), 'valueAxis', valueAxis]];
  } else {
    const horizontal = type === 'bar';
    categoryAxis = axis(child(plot, 'catAx'), 'category', scheme, text, fonts, { position: horizontal ? 'l' : 'b' });
    valueAxis = axis(child(plot, 'valAx'), 'value', scheme, text, fonts, kind === 'barChart' ? { position: horizontal ? 'b' : 'l' } : { between: ['between', 'midCat'] });
    axisNodes = [[child(plot, 'catAx'), 'categoryAxis', categoryAxis], [child(plot, 'valAx'), 'valueAxis', valueAxis]];
  }
  const crossing = categoryAxis || xAxis;
  const ids = children(bars).filter(n => n.localName === 'axId').map(n => integer(n.getAttribute('val'), 'bar axis ID', 4294967295));
  if (ids.length !== 2 || new Set(ids).size !== 2 || !ids.includes(crossing.id) || !ids.includes(valueAxis.id) || crossing.cross !== valueAxis.id || valueAxis.cross !== crossing.id) fail('inconsistent axis references');
  const legend = child(chart, 'legend'); check(legend, ['legendPos', 'overlay', 'spPr', 'txPr']);
  if (legend) {
    choice(val(legend, 'legendPos', 'r'), ['r', 'b'], 'legend position'); choice(val(legend, 'overlay', '0'), ['0', 'false'], 'overlaid legends');
    const style = shape(child(legend, 'spPr'), null, scheme); if (style.fill || style.line) fail('filled or bordered legends');
  }
  // Built-in and application style defaults are dormant only when every visible
  // property in this subset is explicitly overridden. Never invent their
  // palette, font or effects when a direct declaration is missing.
  const completeShape = explicitChartStyles(parts, path, style);
  if (completeShape) {
    if (titleNode) completeShape(titleNode, 'title');
    if (legend) completeShape(legend, 'legend');
    completeShape(root, 'chartArea'); completeShape(plot, 'plotArea');
    for (const n of children(bars).filter(n => n.localName === 'ser')) {
      completeShape(n, stroked ? 'dataPointLine' : 'dataPoint', stroked);
      const point = child(n, 'marker'); if (stroked && child(point, 'spPr')) completeShape(point, 'dataPointMarker');
    }
    for (const [node, role, data] of axisNodes) {
      completeShape(node, role);
      const grid = child(node, 'majorGridlines'); if (grid) completeShape(grid, 'gridlineMajor', true);
      if (!['fontSize', 'fontAscii', 'bold', 'italic', 'color', 'kerning'].every(k => data.text?.[k] !== undefined)) fail('inherited chart text formatting');
    }
  }
  const legendText = readChartText(child(legend, 'txPr'), text, scheme, fonts);
  if (legend && (completeShape || val(legend, 'legendPos', 'r') === 'b' || type !== 'column') && !FULL_TEXT.every(k => legendText?.[k] !== undefined)) fail('inherited legend text formatting');
  if (crossing.text && !latinOnly(series[0].categories || []) || legend && legendText && !latinOnly(series.map(s => s.name))) fail('explicit mixed-script label formatting');
  const layout = kind === 'barChart' ? { gap, grouping, overlap, categoryAxis } : scatter ? { xAxis } : { grouping, categoryAxis };
  return { path, relId, chart: { type, series, ...layout, valueAxis, legend: !!legend, ...(legend ? { legendPosition: val(legend, 'legendPos', 'r') } : {}), ...(title ? { title } : {}), ...(text ? { text } : {}), ...(legendText ? { legendText } : {}), background: shape(child(root, 'spPr'), null, scheme), plot: shape(child(plot, 'spPr'), null, scheme) } };
}
