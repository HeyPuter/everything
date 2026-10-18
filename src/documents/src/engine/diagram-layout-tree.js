import { UnsupportedDocumentError } from './errors.js';

const DGM='http://schemas.openxmlformats.org/drawingml/2006/diagram';
const fail=reason=>{throw new UnsupportedDocumentError(`diagram layout with ${reason}`);};
const elements=n=>[...(n?.children||[])];
const direct=(n,name)=>elements(n).filter(c=>c.namespaceURI===DGM&&c.localName===name);
const types=new Set(['all','doc','node','norm','nonNorm','asst','nonAsst','parTrans','pres','sibTrans']);
function matches(p,type){
 if(type==='all')return true;
 if(type==='node')return ['node','asst'].includes(p.type);
 if(type==='norm')return p.type==='node';
 if(type==='nonNorm')return p.type!=='node';
 if(type==='nonAsst')return p.type!=='asst';
 return p.type===type;
}
function parentOf(model,point){
 return ['parTrans','sibTrans'].includes(point.type)?model.connections.get(point.xml.getAttribute('cxnId'))?.source:model.parent.get(point.id)?.source;
}
function peers(model,point,hideLast){
 const result=[],edges=model.outgoing.get(point.id)||[];
 for(const [index,edge]of edges.entries()){
  const before=model.points.get(edge.xml.getAttribute('parTransId')),after=model.points.get(edge.xml.getAttribute('sibTransId'));
  if(before)result.push(before);result.push(edge.destination);
  if(after&&(!hideLast||index!==edges.length-1))result.push(after);
 }
 return result;
}
function descendants(model,point,hideLast){
 const result=[],stack=peers(model,point,hideLast).reverse();
 while(stack.length){const p=stack.pop();result.push(p);stack.push(...peers(model,p,hideLast).reverse());}
 return result;
}
function axisPoints(model,point,axis,hideLast){
 if(axis==='none')return [];
 if(axis==='self')return [point];
 if(axis==='root')return [model.root];
 if(axis==='ch')return peers(model,point,hideLast);
 if(axis==='des'||axis==='desOrSelf')return [...(axis==='desOrSelf'?[point]:[]),...descendants(model,point,hideLast)];
 const parent=parentOf(model,point);
 if(axis==='par')return parent?[parent]:[];
 if(axis==='ancst'||axis==='ancstOrSelf'){
  const result=axis==='ancstOrSelf'?[point]:[];let p=parent;
  while(p){result.push(p);p=parentOf(model,p);}return result;
 }
 if(['follow','followSib','preced','precedSib'].includes(axis)){
  if(!parent)return [];
  // Include the terminal transition when locating the context, then filter it
  // from the selected peers when hideLastTrans is active.
  const siblings=peers(model,parent,false),index=siblings.indexOf(point);
  if(index<0)fail('an unresolved sibling context');
  const selected=axis.startsWith('follow')?siblings.slice(index+1):siblings.slice(0,index);
  const visible=new Set(peers(model,parent,hideLast));
  return selected.filter(p=>visible.has(p)).flatMap(p=>axis.endsWith('Sib')?[p]:[p,...descendants(model,p,hideLast)]);
 }
 fail(`unsupported ${axis} axis`);
}
function iteratorOptions(xml){
 const axes=(xml.getAttribute('axis')||'none').trim().split(/\s+/);
 const attributes={};
 for(const [name,fallback]of Object.entries({ptType:'all',st:'1',step:'1',cnt:'0',hideLastTrans:'true'})){
  const value=xml.getAttribute(name),list=value===null?axes.map(()=>fallback):value.trim().split(/\s+/);
  if(list.length!==axes.length)fail(`ambiguous ${name} axis list`);
  attributes[name]=list;
 }
 return axes.map((axis,i)=>{
  const type=attributes.ptType[i],start=attributes.st[i],step=attributes.step[i],count=attributes.cnt[i],hidden=attributes.hideLastTrans[i];
  if(!types.has(type)||!/^\d+$/.test(start)||!/^\d+$/.test(step)||!/^\d+$/.test(count)||Number(count)>0xffffffff||![start,step].every(v=>Number(v)>=1&&Number(v)<=0x7fffffff)||!['true','false','1','0'].includes(hidden))fail('unsupported iterator bounds or point types');
  return {axis,type,start:Number(start),step:Number(step),count:Number(count),hideLast:['true','1'].includes(hidden)};
 });
}

export function selectDiagramPoints(model,point,xml){
 let current=[point];
 for(const {axis,type,start,step,count,hideLast}of iteratorOptions(xml)){
  const next=[];
  for(const context of current){
   const candidates=axisPoints(model,context,axis,hideLast).filter(p=>matches(p,type));
   let taken=0;
   for(let i=start-1;i<candidates.length&&(!count||taken<count);i+=step,taken++)next.push(candidates[i]);
  }
  current=[...new Set(next)];
 }
 return current;
}
function depth(model,point){let result=0,p=point;while((p=parentOf(model,p)))result++;return result;}
function condition(model,point,xml,variables){
 const fn=xml.getAttribute('func'),arg=xml.getAttribute('arg');let actual;
 if(fn==='var'){
  if(!Object.hasOwn(variables,arg))fail(`unresolved ${arg} variable`);
  actual=variables[arg];
 }else{
  const selected=selectDiagramPoints(model,point,xml);
  if(fn==='cnt')actual=selected.length;
  else if(fn==='maxDepth')actual=selected.reduce((n,p)=>Math.max(n,depth(model,p)),0);
  else if(fn==='depth')actual=selected.length?depth(model,selected[0]):0;
  else if(['pos','revPos','posEven','posOdd'].includes(fn)){
   if(selected.length!==1)fail('an ambiguous position condition');
   const options=iteratorOptions(xml).at(-1),p=selected[0],parent=parentOf(model,p);
   const siblings=(parent?peers(model,parent,options.hideLast):[model.root]).filter(p=>matches(p,options.type));
   const position=siblings.indexOf(p)+1;
   actual=fn==='pos'?position:fn==='revPos'?siblings.length-position+1:fn==='posEven'?Number(position%2===0):Number(position%2===1);
  }else fail(`unsupported ${fn} function`);
 }
 let expected=xml.getAttribute('val');
 if(typeof actual==='number'){
  if(!/^-?\d+$/.test(expected||''))fail('a nonnumeric comparison');expected=Number(expected);
 }
 if(typeof actual==='boolean'){
  if(!['1','0','true','false'].includes(expected))fail('a nonboolean comparison');expected=['1','true'].includes(expected);
 }
 const op=xml.getAttribute('op');
 if(op==='equ')return actual===expected;
 if(op==='neq')return actual!==expected;
 if(typeof actual!=='number')fail('an ordered variable comparison');
 if(op==='gt')return actual>expected;if(op==='gte')return actual>=expected;
 if(op==='lt')return actual<expected;if(op==='lte')return actual<=expected;
 fail('an unsupported comparison');
}
function variablesFor(xml,point,inherited){
 const result={...inherited};
 const lists=[...direct(xml,'varLst'),...direct(point.xml,'prSet').flatMap(p=>direct(p,'presLayoutVars'))];
 for(const list of lists)for(const variable of elements(list)){
  if(variable.namespaceURI!==DGM)fail('an unsupported variable namespace');
  const defaults={dir:'norm',resizeHandles:'rel',bulletEnabled:'0'};
  const value=variable.getAttribute('val')??defaults[variable.localName];
  if(value===undefined)fail(`an unresolved ${variable.localName} default`);
  if(['bulletEnabled','orgChart'].includes(variable.localName)){
   if(!['1','0','true','false'].includes(value))fail('an invalid boolean variable');
   result[variable.localName]=['1','true'].includes(value);
  }else result[variable.localName]=value;
 }
 return result;
}

// Expand selection and conditional markup into a layout tree. Constraints and
// style XML stay attached to the correct instantiated node for the next stage;
// this function does not invent positions or use the saved drawing geometry.
const MAX_LAYOUT_NODES=10000,MAX_LAYOUT_STEPS=500000;
export function buildDiagramLayoutTree(definition,model){
 if(definition?.namespaceURI!==DGM||definition.localName!=='layoutDef')fail('an invalid definition');
 const roots=direct(definition,'layoutNode');if(roots.length!==1)fail('missing or duplicate layout roots');
 const output={children:[]},stack=[{xml:roots[0],point:model.root,parent:output,variables:{dir:'norm'}}];
 // Nested iterators multiply: a few hundred bytes of layout over a modest data model can expand into
 // millions of nodes. Real diagrams stay far below these bounds; past them the drawing is not editable.
 let nodes=0,steps=0;
 while(stack.length){
  if(++steps>MAX_LAYOUT_STEPS)fail('a layout that expands too far');
  const task=stack.pop(),{xml,point,parent}=task;
  if(xml.namespaceURI!==DGM)fail('an unsupported layout namespace');
  const kind=xml.localName;
  const schedule=(nodes,context=task)=>{for(let i=nodes.length-1;i>=0;i--)stack.push({...context,xml:nodes[i]});};
  if(kind==='layoutNode'){
   if(xml.getAttribute('moveWith')||(xml.getAttribute('chOrder')||'b')!=='b')fail('unsupported child ordering or moveWith');
   const variables=variablesFor(xml,point,task.variables);
   if(++nodes>MAX_LAYOUT_NODES)fail('a layout with too many nodes');
   const node={name:xml.getAttribute('name')||'',styleLabel:xml.getAttribute('styleLbl')||'',point,variables,children:[],constraints:[],rules:[],shape:null,algorithm:null,presentation:[]};
   parent.children.push(node);schedule(elements(xml),{point,parent:node,variables});
  }else if(kind==='forEach'){
   if(xml.getAttribute('ref'))fail('referenced iterators');
   const selected=selectDiagramPoints(model,point,xml);
   for(let i=selected.length-1;i>=0;i--)schedule(elements(xml),{...task,point:selected[i]});
  }else if(kind==='choose'){
   let branch;
   for(const item of elements(xml)){
    if(item.namespaceURI!==DGM||!['if','else'].includes(item.localName))fail('an invalid conditional branch');
    if(item.localName==='else'||condition(model,point,item,task.variables)){branch=item;break;}
   }
   if(branch)schedule(elements(branch));
  }else if(kind==='varLst')continue;
  else if(kind==='alg'){
   if(parent.algorithm)fail('multiple active algorithms');
   const params={};for(const p of elements(xml)){
    if(p.namespaceURI!==DGM||p.localName!=='param'||!p.getAttribute('type')||Object.hasOwn(params,p.getAttribute('type')))fail('ambiguous algorithm parameters');
    params[p.getAttribute('type')]=p.getAttribute('val');
   }
   parent.algorithm={type:xml.getAttribute('type'),params};
  }else if(kind==='shape'){
   if(parent.shape)fail('multiple active shapes');parent.shape=xml;
  }else if(kind==='presOf')parent.presentation.push(...selectDiagramPoints(model,point,xml));
  else if(kind==='constrLst')parent.constraints.push(...elements(xml));
  else if(kind==='ruleLst')parent.rules.push(...elements(xml));
  else fail(`unsupported ${kind} layout markup`);
 }
 return output.children[0];
}
