import {beforeAll,afterAll,it,expect} from 'vitest';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {unzipSync} from 'fflate';
import {parseXml} from '../src/engine/docx-xml.js';
import {readDiagramDataModel} from '../src/engine/diagram-data-model.js';
import {buildDiagramLayoutTree,selectDiagramPoints} from '../src/engine/diagram-layout-tree.js';
const D='http://schemas.openxmlformats.org/drawingml/2006/diagram',A='http://schemas.openxmlformats.org/drawingml/2006/main';
let dom;beforeAll(()=>{dom=new JSDOM();globalThis.DOMParser=dom.window.DOMParser;globalThis.XMLSerializer=dom.window.XMLSerializer;});afterAll(()=>dom.window.close());
const folder='tests/fixtures/diagram-layout-selection/';
const root=text=>parseXml(text).documentElement;
const parts=unzipSync(readFileSync(folder+'control.docx'));
const graph=index=>readDiagramDataModel(root(parts[`word/diagrams/data${index}.xml`]));
const selector=attributes=>root(`<d:forEach xmlns:d="${D}" ${attributes}/>`);

it('selects the same nodes and conditional shapes as ten initialized native diagrams',()=>{
 const reference=JSON.parse(readFileSync(folder+'reference.json','utf8')),cases=JSON.parse(readFileSync(folder+'cases.json','utf8'));
 for(const [file,hash]of Object.entries(reference.hashes))expect(createHash('sha256').update(readFileSync(folder+file)).digest('hex')).toBe(hash);
 expect(cases).toHaveLength(10);
 for(const [index,testCase]of cases.entries()){
  const layout=root(parts[`word/diagrams/layout${index}.xml`]),before=new XMLSerializer().serializeToString(layout);
  const tree=buildDiagramLayoutTree(layout,graph(index));
  expect(tree.algorithm).toEqual({type:'lin',params:testCase.dir==='rev'?{linDir:'fromR'}:{}});
  const shapes=tree.children.filter(n=>n.algorithm?.type==='tx');
  const native=[...reference.pages[index]].sort((a,b)=>testCase.dir==='rev'?b.x-a.x:a.x-b.x);
  expect(shapes).toHaveLength(native.length);
  for(const [i,node]of shapes.entries()){
   const color=node.point.xml.getElementsByTagNameNS(A,'srgbClr')[0].getAttribute('val').toLowerCase();
   expect(color).toBe(native[i].color.slice(0,3).map(v=>v.toString(16).padStart(2,'0')).join(''));
   expect(node.shape.getAttribute('type')).toBe(native[i].curved?'ellipse':'rect');
   expect(node.presentation).toEqual([node.point]);expect(node.constraints).toHaveLength(2);
  }
  const spaces=tree.children.filter(n=>n.algorithm?.type==='sp');
  expect(spaces).toHaveLength('gap' in testCase?(testCase.hideLastTrans==='false'?3:2):0);
  for(const space of spaces){expect(space.point.type).toBe('sibTrans');expect(space.presentation).toEqual([]);}
  expect(new XMLSerializer().serializeToString(layout)).toBe(before);
 }
});

it('uses global sibling position after a slice, not iteration position',()=>{
 const tree=buildDiagramLayoutTree(root(parts['word/diagrams/layout3.xml']),graph(3));
 expect(tree.children.map(n=>n.shape.getAttribute('type'))).toEqual(['rect','rect']);
});
it('supports an optional empty connection list',()=>{
 const model=readDiagramDataModel(root(`<d:dataModel xmlns:d="${D}"><d:ptLst><d:pt modelId="0" type="doc"/></d:ptLst></d:dataModel>`));
 expect(model.connections.size).toBe(0);expect(selectDiagramPoints(model,model.root,selector('axis="ch"'))).toEqual([]);
});
it('selects ancestor, sibling and multi-axis descendant contexts',()=>{
 const model=graph(9),nodes=[...model.points.values()].filter(p=>p.type==='node');
 const leaf=nodes[2],parent=nodes[1];
 expect(selectDiagramPoints(model,leaf,selector('axis="par"'))).toEqual([parent]);
 expect(selectDiagramPoints(model,leaf,selector('axis="ancst"'))).toEqual([parent,model.root]);
 expect(selectDiagramPoints(model,model.root,selector('axis="root des" ptType="all node"'))).toEqual(nodes);
 expect(selectDiagramPoints(model,nodes[0],selector('axis="follow" ptType="node"'))).toEqual([parent,leaf]);
 expect(selectDiagramPoints(model,parent,selector('axis="precedSib" ptType="node"'))).toEqual([nodes[0]]);
});
it.each(['axis="ch" st="0"','axis="ch" step="0"','axis="ch" step="-1"','axis="ch" cnt="-1"','axis="unknown"','axis="ch" ptType="unknown"','axis="root des" ptType="node"','axis="ch" hideLastTrans="invalid"'])('rejects unsupported or ambiguous iterator attributes: %s',attrs=>{
 const model=graph(0);expect(()=>selectDiagramPoints(model,model.root,selector(attrs))).toThrow('diagram layout');
});
it('honors per-point variable overrides and equivalent boolean spellings',()=>{
 const model=graph(0),pr=model.root.xml.getElementsByTagNameNS(D,'prSet')[0];
 pr.append(root(`<d:presLayoutVars xmlns:d="${D}"><d:dir val="rev"/><d:bulletEnabled val="true"/></d:presLayoutVars>`));
 const layout=root(`<d:layoutDef xmlns:d="${D}"><d:layoutNode name="root"><d:varLst><d:dir/></d:varLst><d:choose><d:if func="var" arg="bulletEnabled" op="equ" val="1"><d:alg type="lin"/></d:if><d:else><d:alg type="sp"/></d:else></d:choose></d:layoutNode></d:layoutDef>`);
 const tree=buildDiagramLayoutTree(layout,model);expect(tree.variables.dir).toBe('rev');expect(tree.algorithm.type).toBe('lin');
});

it('refuses a layout whose nested iterators would expand into millions of nodes, quickly',()=>{
 const id=i=>`{00000000-0000-0000-0000-${String(i).padStart(12,'0')}}`,doc='{10000000-0000-0000-0000-000000000000}',n=40;
 const model=readDiagramDataModel(root(`<dgm:dataModel xmlns:dgm="${D}" xmlns:a="${A}"><dgm:ptLst><dgm:pt modelId="${doc}" type="doc"/>${Array.from({length:n},(_,i)=>`<dgm:pt modelId="${id(i+1)}" type="node"/>`).join('')}</dgm:ptLst><dgm:cxnLst>${Array.from({length:n},(_,i)=>`<dgm:cxn modelId="${id(1000+i)}" srcId="${doc}" destId="${id(i+1)}" srcOrd="${i}" destOrd="0"/>`).join('')}</dgm:cxnLst></dgm:dataModel>`));
 const layout=levels=>root(`<dgm:layoutDef xmlns:dgm="${D}"><dgm:layoutNode name="root"><dgm:alg type="lin"/><dgm:forEach axis="ch" ptType="node">${'<dgm:forEach axis="root ch" ptType="all node">'.repeat(levels-1)}<dgm:layoutNode name="n"><dgm:alg type="tx"/><dgm:shape type="rect"/></dgm:layoutNode>${'</dgm:forEach>'.repeat(levels-1)}</dgm:forEach></dgm:layoutNode></dgm:layoutDef>`);
 expect(buildDiagramLayoutTree(layout(2),model).children.length).toBeGreaterThan(n);
 const started=performance.now();
 expect(()=>buildDiagramLayoutTree(layout(5),model)).toThrow(/too many nodes|expands too far/);
 expect(performance.now()-started).toBeLessThan(10000);
});
