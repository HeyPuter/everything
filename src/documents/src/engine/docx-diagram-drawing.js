// Read-only saved diagram drawings (MS-ODRAWXML section 2.10). The data model
// and layout remain authoritative; this adapter does not claim to run layout.
import {parseXml} from './docx-xml.js';
import {partPathForUrl} from './package-part-paths.js';
import {UnsupportedDocumentError} from './errors.js';
import {WPG,WPS} from './docx-compatibility.js';
export const DGM='http://schemas.openxmlformats.org/drawingml/2006/diagram';
const DSP='http://schemas.microsoft.com/office/drawing/2008/diagram';
const A='http://schemas.openxmlformats.org/drawingml/2006/main';
const R='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL='http://schemas.openxmlformats.org/package/2006/relationships';
const CT='http://schemas.openxmlformats.org/package/2006/content-types';
const kids=n=>[...(n?.children||[])];
const fail=why=>{throw new UnsupportedDocumentError(`diagram drawings with ${why}`);};
function one(n,ns,name,required=false) {
  const found=kids(n).filter(c=>c.namespaceURI===ns&&c.localName===name);
  if(found.length>1||required&&!found.length)fail(`missing or duplicate ${name}`);
  return found[0];
}
function check(n,ns,names,repeated=[]) {
  const seen=new Set();
  for(const c of kids(n)) {
    if(c.namespaceURI!==ns||!names.includes(c.localName)||seen.has(c.localName)&&!repeated.includes(c.localName))fail(`unsupported or duplicate ${c.localName}`);
    seen.add(c.localName);
  }
}
export function validateEmptyDiagramText(body) {
  if(!body)return;
  check(body,A,['bodyPr','lstStyle','p'],['p']);
  one(body,A,'bodyPr',true);
  if(!kids(body).some(n=>n.localName==='p'))fail('missing diagram paragraphs');
  if(kids(one(body,A,'lstStyle')).length)fail('diagram list styles');
  for(const p of kids(body).filter(n=>n.localName==='p')) {
    check(p,A,['pPr','r','endParaRPr'],['r']);
    const props=one(p,A,'pPr');
    if(kids(props).some(n=>n.localName.startsWith('bu')&&n.localName!=='buNone'))fail('diagram text bullets');
    for(const run of kids(p).filter(n=>n.localName==='r')) {
      check(run,A,['rPr','t']);
      if(!/^ *$/.test(one(run,A,'t',true).textContent))fail('visible diagram text');
    }
    for(const props of [one(p,A,'endParaRPr'),one(one(p,A,'pPr'),A,'defRPr'),...kids(p).filter(n=>n.localName==='r').map(n=>one(n,A,'rPr'))].filter(Boolean)) {
      if(props.hasAttribute('u')&&props.getAttribute('u')!=='none'||props.hasAttribute('strike')&&props.getAttribute('strike')!=='noStrike'||kids(props).some(n=>n.localName==='highlight'))fail('decorated diagram whitespace');
    }
  }
}
export function readDiagramParts(parts,rels,types,reference,sourcePart) {
  check(reference,DGM,[]);
  const resolve=(id,relationType,contentType,ns,rootName)=>{
    const matches=[...(rels?.getElementsByTagNameNS(REL,'Relationship')||[])].filter(n=>n.getAttribute('Id')===id);
    if(!id||matches.length!==1)fail('missing or ambiguous relationships');
    const rel=matches[0];
    if(rel.getAttribute('Type')!==relationType||rel.hasAttribute('TargetMode')&&rel.getAttribute('TargetMode')!=='Internal')fail('external or mismatched relationships');
    let url,path;
    try {url=new URL(rel.getAttribute('Target'),`https://docx.invalid/${sourcePart}`);path=partPathForUrl(parts,url);}catch{fail('invalid part targets');}
    if(url.origin!=='https://docx.invalid'||url.search||url.hash||!parts[path])fail('missing or external parts');
    const matchesType=[...types.getElementsByTagNameNS(CT,'Override')].filter(n=>n.getAttribute('PartName')===`/${path}`);
    if(matchesType.length!==1||matchesType[0].getAttribute('ContentType')!==contentType)fail('incorrect part content types');
    const root=parseXml(parts[path]).documentElement;
    if(root.namespaceURI!==ns||root.localName!==rootName)fail('incorrect part roots');
    return root;
  };
  const standard='application/vnd.openxmlformats-officedocument.drawingml.diagram';
  const diagrams={};
  for(const [key,kind,type,root] of [['dm','Data','Data','dataModel'],['lo','Layout','Layout','layoutDef'],['qs','QuickStyle','Style','styleDef'],['cs','Colors','Colors','colorsDef']]) {
    const part=resolve(reference.getAttributeNS(R,key),`${R}/diagram${kind}`,`${standard}${type}+xml`,DGM,root);
    diagrams[key]=part;
  }
  return {...diagrams,resolve};
}
export function readDiagramDrawing(parts,rels,types,reference,sourcePart,width,height) {
  const {dm:data,resolve}=readDiagramParts(parts,rels,types,reference,sourcePart);
  const extensions=kids(one(data,DGM,'extLst')).filter(n=>n.namespaceURI===A&&n.localName==='ext'&&n.getAttribute('uri')===DSP);
  if(extensions.length!==1)fail('missing or ambiguous saved drawings');
  const extension=one(extensions[0],DSP,'dataModelExt',true);
  const drawing=resolve(extension.getAttribute('relId'),'http://schemas.microsoft.com/office/2007/relationships/diagramDrawing','application/vnd.ms-office.drawingml.diagramDrawing+xml',DSP,'drawing');
  check(drawing,DSP,['spTree']);
  const doc=parseXml(`<wpg:wgp xmlns:wpg="${WPG}" xmlns:wps="${WPS}" xmlns:a="${A}"/>`);
  const make=(ns,name)=>doc.createElementNS(ns,`${ns===WPG?'wpg':ns===WPS?'wps':'a'}:${name}`);
  const copy=(n,ns,name)=>{const result=make(ns,name);for(const a of [...n.attributes])result.setAttributeNS(a.namespaceURI,a.name,a.value);for(const c of [...n.childNodes])result.append(doc.importNode(c,true));return result;};
  const group=(node,root=false,depth=0)=>{
    if(depth>12)fail('excessive group nesting');
    check(node,DSP,['nvGrpSpPr','grpSpPr','sp','grpSp'],['sp','grpSp']);
    const result=root?doc.documentElement:make(WPG,'grpSp');
    const nv=one(node,DSP,'nvGrpSpPr',true);check(nv,DSP,['cNvPr','cNvGrpSpPr']);
    result.append(copy(one(nv,DSP,'cNvPr',true),WPG,'cNvPr'),copy(one(nv,DSP,'cNvGrpSpPr',true),WPG,'cNvGrpSpPr'));
    const props=copy(one(node,DSP,'grpSpPr',true),WPG,'grpSpPr');
    if(root&&!one(props,A,'xfrm')) {
      const transform=make(A,'xfrm');
      for(const [name,attrs] of [['off',{x:0,y:0}],['ext',{cx:width,cy:height}],['chOff',{x:0,y:0}],['chExt',{cx:width,cy:height}]]) {
        const n=make(A,name);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,String(v));transform.append(n);
      }
      props.prepend(transform);
    }
    result.append(props);
    for(const n of kids(node)) {
      if(n.localName==='grpSp')result.append(group(n,false,depth+1));
      if(n.localName!=='sp')continue;
      check(n,DSP,['nvSpPr','spPr','style','txBody','txXfrm']);
      if(n.getElementsByTagNameNS(A,'blipFill').length)fail('picture fills with diagram-local relationships');
      if(!/^(?:\d+|\{[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\})$/.test(n.getAttribute('modelId')||''))fail('invalid shape model IDs');
      validateEmptyDiagramText(one(n,DSP,'txBody'));
      const sp=make(WPS,'wsp'),nv=one(n,DSP,'nvSpPr',true);check(nv,DSP,['cNvPr','cNvSpPr']);
      sp.append(copy(one(nv,DSP,'cNvPr',true),WPS,'cNvPr'),copy(one(nv,DSP,'cNvSpPr',true),WPS,'cNvSpPr'),copy(one(n,DSP,'spPr',true),WPS,'spPr'));
      const style=one(n,DSP,'style');if(style)sp.append(copy(style,WPS,'style'));
      sp.append(make(WPS,'bodyPr'));result.append(sp);
    }
    return result;
  };
  return group(one(drawing,DSP,'spTree',true),true);
}
