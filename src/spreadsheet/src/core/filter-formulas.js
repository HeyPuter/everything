/** Formula intervals retain each row's references when a filter spans an edit. */
import { MAX_ROW, MAX_COL, shiftFormula, shiftRef, parseRefText, refToText, adjustFormula, mapFormulaRefs, adjustRefForDelete, sameSheetName } from './refs.js';
import { tokenize } from './formula/tokenizer.js';
import { ruleFormulaBody } from './validation.js';
import { adjustLineRules, adjustBlockRules } from './rule-refs.js';

function storedParts(criterion) {
  const saved = criterion.formulaParts;
  if (!saved || saved.formula !== criterion.formula || !Array.isArray(saved.parts) || !saved.parts.length) return null;
  if (!saved.parts.every(p => p && typeof p.source === 'string' && p.range &&
    ['r1','r2'].every(k=>Number.isInteger(p.range[k])&&p.range[k]>=0&&p.range[k]<=MAX_ROW) &&
    ['c1','c2'].every(k=>Number.isInteger(p.range[k])&&p.range[k]>=0&&p.range[k]<=MAX_COL) &&
    p.range.r1<=p.range.r2 && p.range.c1===p.range.c2)) return null;
  if (saved.parts.some((p,i)=>i && (p.range.r1!==saved.parts[i-1].range.r2+1 || p.range.c1!==saved.parts[0].range.c1))) return null;
  return saved.parts;
}
export function filterFormulaRules(criterion, range, col) {
  const parts = storedParts(criterion) || [{source:criterion.formula,range:{r1:range.r1+1,r2:range.r2,c1:col,c2:col}}];
  return parts.flatMap((p,i)=>{
    const r1=i?Math.max(p.range.r1,range.r1+1):range.r1+1;
    const r2=i===parts.length-1?range.r2:Math.min(p.range.r2,range.r2);
    return r1>r2?[]:[{type:'formula',range:{r1,r2,c1:col,c2:col},source:shiftFormula(p.source,r1-p.range.r1,col-p.range.c1)}];
  });
}
export function filterFormulaReader(criterion, range, col) {
  const parts=storedParts(criterion);
  if (!parts) {
    const rule={source:criterion.formula,range:{r1:range.r1+1,c1:col}};
    return ()=>rule;
  }
  return r=>{
    let lo=0,hi=parts.length-1;
    while(lo<hi){const mid=(lo+hi)>>1;if(r>parts[mid].range.r2)lo=mid+1;else hi=mid;}
    return parts[lo];
  };
}
// A later interval may refer above the filter's first row. Avoid destroying
// such references as #REF! while assembling the editable combined formula.
function displayFormula(part, base) {
  const formula=ruleFormulaBody(part.source), dr=base.r1-part.range.r1,dc=base.c1-part.range.c1;
  let tokens;try{tokens=tokenize(formula);}catch{return formula;}
  let out='',last=0;
  for(const t of tokens) {
    if(t.type!=='ref')continue;
    const ref=parseRefText(t.text,t.sheet,t.sheetEnd);if(!ref)continue;
    if(t.spill)ref.spill=true;
    const shifted=shiftRef(ref,dr,dc); let text;
    if(shifted)text=refToText(shifted);
    else {
      const row=(value,absolute)=>absolute?String(value+1):`ROW()+(${value-part.range.r1})`;
      const col=(value,absolute)=>absolute?String(value+1):`COLUMN()+(${value-part.range.c1})`;
      const address=(r,c,ar,ac)=>`ADDRESS(${row(r,ar)},${col(c,ac)},1)`;
      const prefix=refToText(ref).split('!').slice(0,-1).join('!');
      const quoted=s=>'"'+s.replaceAll('"','""')+'"';
      text=`INDIRECT(${prefix?quoted(prefix+'!')+'&':''}${address(ref.r1,ref.c1,ref.absR1,ref.absC1)}${ref.kind==='cell'?(ref.spill?'&"#"':''):'&":"&'+address(ref.r2,ref.c2,ref.absR2,ref.absC2)})`;
    }
    out+=formula.slice(last,t.start)+text;last=t.end;
  }
  return out+formula.slice(last);
}
export function compileFilterFormula(criterion, rules, range, col) {
  const next={...criterion};delete next.formulaParts;
  if(!rules.length){next.formula='FALSE()';return next;}
  const base={r1:range.r1+1,c1:col};
  let formula=displayFormula(rules.at(-1),base);
  for(let i=rules.length-2;i>=0;i--)formula=`IF(ROW()<${rules[i+1].range.r1+1},${displayFormula(rules[i],base)},${formula})`;
  if(String(criterion.formula).trimStart().startsWith('='))formula='='+formula;
  next.formula=formula;
  if(rules.length>1)next.formulaParts={formula,parts:rules.map(p=>({source:p.source,range:{...p.range}}))};
  return next;
}
export function mapFilterFormula(criterion, fn) {
  if(!criterion.formula)return criterion;
  const parts=storedParts(criterion);
  if(!parts){const formula=fn(criterion.formula);return formula===criterion.formula?criterion:{...criterion,formula};}
  let changed=false;
  const rules=parts.map(p=>{const source=fn(p.source,p.range);changed ||= source!==p.source;return {...p,source};});
  if(!changed)return criterion;
  const first=parts[0].range,last=parts.at(-1).range;
  return compileFilterFormula(criterion,rules,{r1:first.r1-1,r2:last.r2},first.c1);
}
// A replacement template can temporarily sit just beyond the grid. Permit
// that intermediate address only when this deletion brings it back in bounds.
function replacementFormula(formula, dr, dc, options) {
  return mapFormulaRefs(formula, ref => {
    let next={...ref};
    for(const [key,absolute,delta] of [['r1','absR1',dr],['r2','absR2',dr],['c1','absC1',dc],['c2','absC2',dc]])if(!next[absolute])next[key]+=delta;
    for(const [lo,hi,absLo,absHi] of [['r1','r2','absR1','absR2'],['c1','c2','absC1','absC2']])if(next[lo]>next[hi]) {
      [next[lo],next[hi]]=[next[hi],next[lo]];
      [next[absLo],next[absHi]]=[next[absHi],next[absLo]];
    }
    const lo=options.axis==='row'?'c1':'r1',hi=options.axis==='row'?'c2':'r2';
    if(ref.kind!=='rows'&&ref.kind!=='cols'&&sameSheetName(ref.sheet||options.ownerSheet,options.sheetName)
      &&next[lo]>=options.bandStart&&next[hi]<=options.bandEnd) {
      const before=next;next=adjustRefForDelete(next,options.axis,options.at,options.count);
      if(next)for(const [key,absolute] of options.axis==='row'?[['r1','absR1'],['r2','absR2']]:[['c1','absC1'],['c2','absC2']]) {
        if(before[key]>=options.at&&before[key]<options.at+options.count)next[absolute]=true;
      }
    }
    return next&&shiftRef(next,0,0);
  });
}
function replacementParts(template, future, options) {
  const rows=new Set([future.r1,future.r2+1]),cols=new Set([future.c1,future.c2+1]);
  const add=(axis,n)=>{const lo=axis==='row'?'r1':'c1',hi=axis==='row'?'r2':'c2';if(n>future[lo]&&n<=future[hi])(axis==='row'?rows:cols).add(n);};
  mapFormulaRefs(template.source,ref=>{
    if(ref.kind==='rows'||ref.kind==='cols'||!sameSheetName(ref.sheet||options.ownerSheet,options.sheetName))return ref;
    for(const [axis,lo,hi,absLo,absHi] of [['row','r1','r2','absR1','absR2'],['col','c1','c2','absC1','absC2']]) {
      const edges=axis===options.axis?[options.at,options.at+options.count]:[options.bandStart,options.bandEnd+1];
      for(const [key,absolute] of [[lo,absLo],[hi,absHi]])if(!ref[absolute])for(const edge of edges)add(axis,edge-ref[key]+template.range[lo]);
    }
    return ref;
  });
  const r=[...rows].sort((a,b)=>a-b),c=[...cols].sort((a,b)=>a-b),parts=[];
  for(let i=0;i<r.length-1;i++)for(let j=0;j<c.length-1;j++) {
    const range={r1:r[i],r2:r[i+1]-1,c1:c[j],c2:c[j+1]-1};
    const source=replacementFormula(template.source,range.r1-template.range.r1,range.c1-template.range.c1,options);
    const lo=options.axis==='row'?'r1':'c1',hi=options.axis==='row'?'r2':'c2';range[lo]-=options.count;range[hi]-=options.count;
    parts.push({...template,range,source});
  }
  return parts;
}
export function adjustFilterForEdit(filter, options) {
  if(!filter)return null;
  const {ownerSheet,sheetName,axis,at,count,remove,bandStart,bandEnd}=options;
  const block=bandStart!=null, orthLo=axis==='row'?'c1':'r1', orthHi=axis==='row'?'c2':'r2';
  const moves=sameSheetName(ownerSheet,sheetName) && (!block || filter.range[orthLo]>=bandStart&&filter.range[orthHi]<=bandEnd);
  const map=n=>!moves||n<at?n:!remove?n+count:n<at+count?null:n-count;
  const range={...filter.range};
  if(moves) {
    const lo=axis==='row'?'r1':'c1',hi=axis==='row'?'r2':'c2';
    range[lo]=map(range[lo])??at;range[hi]=map(range[hi])??at-1;
  }
  // A deletion that leaves a filter its header row alone ends it; one that finds it so already (a table whose data rows
  // were all deleted keeps its buttons for the rows it grows by) leaves it be.
  if(range.r1>range.r2||range.c1>range.c2||(moves&&remove&&range.r1===range.r2&&filter.range.r1!==filter.range.r2))return null;
  const criteria={};
  for(const [key,criterion] of Object.entries(filter.criteria)) {
    const oldCol=Number(key),col=axis==='col'?map(oldCol):oldCol;if(col==null)continue;
    if(!criterion.formula){criteria[col]=criterion;continue;}
    let input=filterFormulaRules(criterion,filter.range,oldCol);
    const replacements=[];
    if(range.r1===range.r2){criteria[col]=block?criterion:mapFilterFormula(criterion,f=>adjustFormula(f,options));continue;}
    if(block&&remove&&!moves&&sameSheetName(ownerSheet,sheetName)) {
      // A filter remains rectangular when only some of its cells shift.
      // Continue the relative pattern onto replacement cells in that column.
      if(axis==='col'&&oldCol>=at&&oldCol<at+count) input=input.flatMap(p=>{
        const points=[p.range.r1,Math.max(p.range.r1,bandStart),Math.min(p.range.r2+1,bandEnd+1),p.range.r2+1]
          .filter(n=>n>=p.range.r1&&n<=p.range.r2+1);
        const sorted=[...new Set(points)].sort((a,b)=>a-b),out=[];
        for(let i=0;i<sorted.length-1;i++) {
          const r1=sorted[i],r2=sorted[i+1]-1,c=r1>=bandStart&&r2<=bandEnd?at+count:oldCol;
          if(c!==oldCol)replacements.push(...replacementParts(p,{r1,r2,c1:c,c2:c},options));
          else out.push({...p,range:{r1,r2,c1:c,c2:c},source:shiftFormula(p.source,r1-p.range.r1,0)});
        }
        return out;
      });
      else if(axis==='row'&&oldCol>=bandStart&&oldCol<=bandEnd&&filter.range.r2>=at&&filter.range.r2<at+count&&input.length) {
        const last=input.at(-1),r1=at+count;
        replacements.push(...replacementParts(last,{r1,r2:filter.range.r2+count,c1:oldCol,c2:oldCol},options));
      }
    }
    let rules=(block?adjustBlockRules:adjustLineRules)(input,'source',options);
    if(replacements.length)rules=[...rules,...replacements].sort((a,b)=>a.range.r1-b.range.r1);
    // Deleting the header promotes a surviving row; inserting at the first
    // data row gives the new rows the neighboring formula's pattern.
    rules=rules.flatMap((p,i)=>{
      const r1=i?Math.max(p.range.r1,range.r1+1):range.r1+1,r2=Math.min(p.range.r2,range.r2);
      return r1>r2?[]:[{...p,range:{r1,r2,c1:col,c2:col},source:shiftFormula(p.source,r1-p.range.r1,col-p.range.c1)}];
    });
    criteria[col]=compileFilterFormula(criterion,rules,range,col);
  }
  return {...filter,range,criteria, ...(filter.hiddenButtons ? { hiddenButtons: filter.hiddenButtons.map(c => axis === 'col' ? map(c) : c).filter(c => c != null && c >= range.c1 && c <= range.c2) } : {})};
}
