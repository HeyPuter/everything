import { UnsupportedDocumentError } from './errors.js';
import { serializeFragment } from './docx-compatibility.js';
import { fieldInstructionTokens, pageFieldInstruction, pageFieldSegments, writePageFieldResult } from './docx-page-fields.js';
import { checkedHyperlinkDestination, hyperlinkId } from './hyperlinks.js';
import { sameRevision } from './revisions.js';
const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const is=(n,name)=>n.namespaceURI===W && n.localName===name;
const fail=message=>{throw new UnsupportedDocumentError(message);};
// The same tracked insertion or deletion, including the insertion a deletion sits in.
const sameChange=(a,b)=>sameRevision(a,b)&&JSON.stringify(a?.inserted||null)===JSON.stringify(b?.inserted||null);

// Retain the authored TOC/PAGEREF instructions and cached results. This is not
// their evaluator: opening/editing must not regenerate a manually edited TOC.
export function bodyFieldInstruction(instruction) {
  if(!/^\s*(?:TOC|PAGEREF|HYPERLINK|XE|INDEX)(?:\s|$)/i.test(instruction))return pageFieldInstruction(instruction);
  const args=fieldInstructionTokens(instruction,true),tokens=args.map(a=>a.value),type=tokens[0]?.toUpperCase();
  const bookmarkArgument=i=>({bookmark:tokens[i],bookmarkCodeRange:[args[i].start,args[i].end]});
  // INDEX results are retained like TOC results; XE has no visible result.
  if(type==='XE'){
    if(tokens[1]===undefined||tokens[1].startsWith('\\'))fail('an XE without an entry argument');
    let bookmark;
    for(let i=2;i<tokens.length;i++){
      if(['\\b','\\i'].includes(tokens[i]))continue;
      if(!['\\f','\\r','\\t','\\y'].includes(tokens[i]))fail('an unsupported XE field switch');
      const name=tokens[i],argument=tokens[++i];
      if(argument===undefined||argument.startsWith('\\'))fail('a missing XE switch argument');
      if(name==='\\r')bookmark=bookmarkArgument(i);
    }
    return {type,instruction,...bookmark};
  }
  if(type==='TOC'||type==='INDEX'){
    const scope=tokens.indexOf('\\b');
    if(scope>=0&&(!tokens[scope+1]||tokens[scope+1].startsWith('\\')))fail(`a ${type} without its bookmark scope`);
    return {type,instruction,...(scope>=0?bookmarkArgument(scope+1):{})};
  }
  if(type==='PAGEREF'){
    if(!tokens[1]||tokens[1].startsWith('\\'))fail('a PAGEREF without a bookmark argument');
    return {type,instruction,...bookmarkArgument(1)};
  }
  let address,anchor,tooltip='',frame,bookmark;
  for(let i=1;i<tokens.length;i++){
    // A quoted argument is never a switch, though a UNC path ("\\\\server\\share") starts with a backslash.
    const token=tokens[i],quoted=instruction[args[i].start]==='"';
    if((quoted||!token.startsWith('\\'))&&address===undefined){address=token;continue;}
    if(['\\l','\\o','\\t','\\*'].includes(token)){
      const value=tokens[++i];if(value===undefined||value.startsWith('\\'))fail('a missing HYPERLINK switch argument');
      if(token==='\\l'){anchor=value;bookmark=bookmarkArgument(i);}else if(token==='\\o')tooltip=value;else if(token==='\\t')frame=value;
    }else if(!['\\h','\\n'].includes(token))fail('an unsupported HYPERLINK field switch');
  }
  if(address!==undefined&&anchor!==undefined)fail('a HYPERLINK field combining an external address and bookmark');
  if(address===undefined&&anchor===undefined)fail('a HYPERLINK field without a destination');
  // The read-only notice lists what the document contains, so it names the link rather than repeating the link dialog's advice.
  let destination;try{destination=checkedHyperlinkDestination(address===undefined?{anchor:anchor||null}:address);}catch{
    if(address===undefined)fail('a HYPERLINK field to an invalid bookmark name');
    // A file, relative or UNC path is kept as written, like a w:hyperlink relationship target (docx-hyperlinks.js):
    // shown as a link, never followed from the editor. Script and data addresses still keep the document read-only.
    if(/^\s*(?:javascript|vbscript|data)\s*:/i.test(address))fail('a HYPERLINK field to a script or data address');
    if(!address||/[\u0000-\u001f\u007f\uD800-\uDFFF\uFFFE\uFFFF]/u.test(address))fail('a HYPERLINK field to an invalid address');
    destination={target:address,retainedTarget:true};
  }
  return {type,instruction,...bookmark,hyperlink:{...destination,tooltip,...(frame?{frame}:{})}};
}

export function bodyFieldReader(nextOrder = () => 0) {
  const stack=[]; let count=0;
  const parsed = source => {
    const root=new DOMParser().parseFromString(`<w:p xmlns:w="${W}">${source}</w:p>`,'application/xml').documentElement;
    const segments=pageFieldSegments(root,bodyFieldInstruction);
    if(segments.length!==1 || !segments[0].field) fail('an invalid body field envelope');
    return segments[0].field;
  };
  return {
    get scope(){return stack.map(f=>f.field.id).join(',');},
    get inCode(){return stack.at(-1)?.phase==='code';},
    get inToc(){return stack.some(f=>f.phase!=='code'&&/^\s*TOC(?:\s|$)/i.test(f.instruction??f.field.instruction));},
    get link(){return stack.findLast(f=>f.phase!=='code'&&f.field.resultLink)?.field.resultLink;},
    finish(){if(stack.length)fail('an unterminated body field');},
    prompt(retained, nodes, offset, markers, read, link){
      if(stack.at(-1)?.phase==='code')fail('a MACROBUTTON inside a field instruction');
      const field={...retained,id:`bodyField${++count}`};
      markers.push({type:'start',offset:offset(),field,order:nextOrder(),...(link?{link}:{})});
      for(const node of nodes)read(node,link);
      markers.push({type:'end',offset:offset(),field,order:nextOrder(),...(link?{link}:{})});
    },
    simple(node, offset, markers, read){
      if(stack.at(-1)?.phase==='code')fail('nested body fields inside instructions');
      const field={...parsed(serializeFragment(node.cloneNode(false))),id:`bodyField${++count}`,simple:true};
      if(field.hyperlink)field.resultLink={...field.hyperlink,id:hyperlinkId(),fieldId:field.id};
      markers.push({type:'start',offset:offset(),field,order:nextOrder()});
      const active={field,phase:'simple'};stack.push(active);
      for(const child of node.children)read(child);
      if(stack.at(-1)!==active)fail('a body field crossing a simple field boundary');
      stack.pop();markers.push({type:'end',offset:offset(),field,order:nextOrder()});
    },
    /** Keep the cached result of a field nested in an instruction inside the outer field's envelope. */
    absorb(node, run){
      const active=stack.at(-1);
      if(active?.phase!=='code'||active.nested.at(-1)!=='result')return false;
      const fragment=run.cloneNode(false),properties=[...run.children].find(n=>is(n,'rPr'));
      if(properties)fragment.append(properties.cloneNode(true));fragment.append(node.cloneNode(true));
      active.opening+=serializeFragment(fragment);return true;
    },
    // `revision` is the tracked change the delimiter sits in. A field whose begin, separator and end
    // delimiters share one change was inserted or deleted as a whole (§17.13.5.18, §17.13.5.14); the field
    // keeps it as `revision`, so saving writes those delimiters back inside it.
    token(node, run, offset, markers, link, revision=null){
      // Deleted field code is w:delInstrText (§17.16, deleted field code). The retained envelope holds it as w:instrText; the
      // field's deletion turns it back on save.
      if(is(node,'delInstrText')&&revision?.type==='del'){
        const code=node.ownerDocument.createElementNS(W,`${node.prefix?node.prefix+':':''}instrText`);
        for(const attr of [...node.attributes])code.setAttributeNode(attr.cloneNode(true));
        code.append(...[...node.childNodes].map(n=>n.cloneNode(true)));node=code;
      }
      if(!is(node,'fldChar')&&!is(node,'instrText'))return false;
      const active=stack.at(-1);
      const fragment=run.cloneNode(false),properties=[...run.children].find(n=>is(n,'rPr'));
      if(properties)fragment.append(properties.cloneNode(true));fragment.append(node.cloneNode(true));
      const source=serializeFragment(fragment);
      if(is(node,'instrText')){
        if(active?.phase!=='code'||active.nested.at(-1)==='result')fail('a body instruction outside its field code');
        active.opening+=source;active.instruction+=node.textContent;return true;
      }
      const kind=node.getAttributeNS(W,'fldCharType');
      // Fields nested in an instruction (the operands of IF, NEXTIF, SKIPIF) belong to the outer envelope.
      if(active?.phase==='code'&&(kind==='begin'||active.nested.length)){
        if(kind==='begin'){active.nested.push('code');active.instruction+='{';}
        else if(kind==='separate'&&active.nested.at(-1)==='code')active.nested[active.nested.length-1]='result';
        else if(kind==='end'){active.nested.pop();active.instruction+='}';}
        else fail('an unmatched body field delimiter');
        active.opening+=source;return true;
      }
      if(kind==='begin'){
        stack.push({field:{id:`bodyField${++count}`},opening:source,instruction:'',phase:'code',nested:[],revision,tracked:!!revision});
      }else if(kind==='separate'&&active?.phase==='code'){
        if(!sameChange(active.revision,revision))active.tracked=false;
        if(/^\s*HYPERLINK(?:\s|$)/i.test(active.instruction)){
          const {hyperlink}=bodyFieldInstruction(active.instruction);
          active.field.resultLink={...hyperlink,id:hyperlinkId(),fieldId:active.field.id};
        }
        active.opening+=source;active.phase='result';markers.push({type:'start',offset,field:active.field,order:nextOrder(),...(link?{link}:{})});
      }else if(kind==='end'&&active&&active.phase!=='simple'){
        if(active.phase==='code')markers.push({type:'start',offset,field:active.field,order:nextOrder(),...(link?{link}:{})});
        Object.assign(active.field,parsed(active.opening+source));
        if(active.field.type==='XE'&&active.phase!=='code')fail('an XE field with a result');
        if(active.field.hyperlink&&!active.field.resultLink)active.field.resultLink={...active.field.hyperlink,id:hyperlinkId(),fieldId:active.field.id};
        if(active.tracked&&sameChange(active.revision,revision))active.field.revision=structuredClone(revision);
        markers.push({type:'end',offset,field:active.field,order:nextOrder(),...(link?{link}:{})});stack.pop();
      }else fail('an unmatched body field delimiter');
      return true;
    },
  };
}

export function bodyFieldSimpleShell(field, doc) {
  return bodyFieldEnvelope(field,doc)[0];
}

function bodyFieldEnvelope(field,doc){
  const nodes=writePageFieldResult({...field,instruction:field.originalInstruction??field.instruction},[],doc,bodyFieldInstruction);
  if(!field.originalInstruction||field.originalInstruction===field.instruction)return nodes;
  if(nodes.length===1&&is(nodes[0],'fldSimple')){nodes[0].setAttributeNS(W,'w:instr',field.instruction);return nodes;}
  const texts=nodes.flatMap(n=>[...n.getElementsByTagNameNS(W,'instrText')]);
  const original=texts.map(n=>n.textContent).join(''),edited=field.instruction;
  let prefix=0,suffix=0;while(prefix<original.length&&prefix<edited.length&&original[prefix]===edited[prefix])prefix++;
  while(suffix<original.length-prefix&&suffix<edited.length-prefix&&original.at(-1-suffix)===edited.at(-1-suffix))suffix++;
  const end=original.length-suffix,replacement=edited.slice(prefix,edited.length-suffix);let at=0,inserted=false;
  for(const text of texts){
    const value=text.textContent,clamp=n=>Math.max(0,Math.min(value.length,n));
    const insert=!inserted&&at+value.length>=prefix;
    text.textContent=value.slice(0,clamp(prefix-at))+(insert?replacement:'')+value.slice(clamp(end-at));
    inserted ||= insert;at+=value.length;
  }
  return nodes;
}

export function bodyFieldBoundary(marker, doc) {
  const nodes=bodyFieldEnvelope(marker.field,doc);
  if(nodes.length===1 && is(nodes[0],'fldSimple')){
    const make=name=>doc.createElementNS(W,`w:${name}`),run=make('r'),delimiter=make('fldChar');
    delimiter.setAttributeNS(W,'w:fldCharType',marker.type==='start'?'begin':'end');
    run.append(delimiter);
    if(marker.type==='end')return [run];
    for(const name of ['fldLock','dirty'])if(nodes[0].hasAttributeNS(W,name))delimiter.setAttributeNS(W,`w:${name}`,nodes[0].getAttributeNS(W,name));
    const instruction=make('r'),text=make('instrText');text.setAttributeNS('http://www.w3.org/XML/1998/namespace','xml:space','preserve');text.textContent=marker.field.instruction;instruction.append(text);
    // Index, authority and contents entries have no result, so no separator (§17.16.5.62, .63, .72).
    if(['XE','TA','TC'].includes(marker.field.type))return [run,instruction];
    const separator=make('r'),separate=make('fldChar');separate.setAttributeNS(W,'w:fldCharType','separate');separator.append(separate);
    return [run,instruction,separator];
  }
  return marker.type==='start'?nodes.slice(0,-1):nodes.slice(-1);
}
