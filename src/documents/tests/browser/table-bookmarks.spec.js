import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { showAllTools, onTab } from './helpers/editor-tools.js';
import { reopenDocx } from './helpers/reopen-docx.js';
const select = (input,text,from=0,to=text.length) => input.evaluate((el,{text,from,to}) => { const at=el.value.indexOf(text);el.focus();el.setSelectionRange(at+from,at+to);el.dispatchEvent(new Event('select',{bubbles:true})); },{text,from,to});
const download = async (page,info,name) => { const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download .docx',exact:true}).click();const path=info.outputPath(name);await(await pending).saveAs(path);return path; };
const sameParts = (a,b) => { expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());for(const [name,bytes] of Object.entries(a))expect(Buffer.from(b[name]).equals(Buffer.from(bytes)),name).toBe(true); };
for(const [name,target,changed] of [['table-bookmarks','Alpha','AlXpha'],['table-bookmarks-merged','Next','NeXxt']])test(`edits, copies and reopens ${name} while retaining marker scopes`,async({page},info)=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/playground.html');await showAllTools(page);await page.getByLabel('Open DOCX file').setInputFiles(`public/fixtures/${name}.docx`);
 const input=page.getByRole('textbox',{name:'Document text'});await expect(input).toHaveValue(new RegExp(target));await expect(input).toHaveJSProperty('readOnly',false);const original=await input.inputValue();
 await select(input,target);const copied=await input.evaluate(el=>{const data=new DataTransfer();el.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:data}));return data.getData('text/plain');});expect(copied).toBe(target);
 await select(input,target,2,2);await input.evaluate(el=>{const data=new DataTransfer();data.setData('text/plain','X');el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));});const expected=original.replace(target,changed);await expect(input).toHaveValue(expected);
 const saved=await download(page,info,`${name}.docx`);await page.getByRole('button',{name:'Undo',exact:true}).click();await expect(input).toHaveValue(original);sameParts(unzipSync(readFileSync(`public/fixtures/${name}.docx`)),unzipSync(readFileSync(await download(page,info,`${name}-undo.docx`))));
 await reopenDocx(page,input,saved,expected);await (await onTab(page,'insert')).getByRole('button',{name:'Bookmarks',exact:true}).click();const list=page.getByRole('listbox',{name:'Document bookmarks',exact:true});await expect(list.locator('option')).toHaveCount(name==='table-bookmarks'?7:3);
 if(name==='table-bookmarks'){const id=await list.locator('option').filter({hasText:/^FirstRow ·/}).getAttribute('value');await list.selectOption(id);await page.getByRole('dialog').getByRole('button',{name:'Go to bookmark',exact:true}).click();expect(await input.evaluate(el=>el.selectionStart)).toBe(expected.indexOf(changed));}
 expect(errors).toEqual([]);
});
test('preserves the third card bookmark through edits and opens its oversized pictures editable',async({page},info)=>{
 test.skip(!process.env.THIRD_BIRTHDAY_CARD_PATH,'Optional private local corpus specimen');const source=readFileSync(process.env.THIRD_BIRTHDAY_CARD_PATH),parts=unzipSync(source);
 await page.goto('/playground.html');
 const result=await page.evaluate(async bytes=>{
  const {DocxPackage}=await import('/src/engine/docx.js'),{TextDocument}=await import('/src/engine/model.js'),{validateCanvasLayout}=await import('/src/engine/canvas-text.js');
  const p=await DocxPackage.open(new Uint8Array(bytes)),model=p=>new TextDocument(p.paragraphs,p.pageSettings,p.numbering,p.styles,p.tables,p.assets),d=model(p);
  let layoutError;try{await validateCanvasLayout(p);}catch(e){layoutError=e.message;}
  const ranges=d=>d.bookmarks.map(b=>[b.name,b.start,b.end]),before=ranges(d),at=d.text.indexOf('Save the Date!');d.select(at,at+14);d.replace('Mark the Date!');
  const save=async()=>[...new Uint8Array(await p.export(d.paragraphs,d.pageSettings,d.numbering,d.styles,d.tables,d.assets).arrayBuffer())];
  const edited=await save(),reopened=model(await DocxPackage.open(new Uint8Array(edited))),after=ranges(reopened),textMatches=d.text===reopened.text;d.undo();
  return {layoutError,before,after,textMatches,edited,restored:await save()};
 },[...source]);
 expect(result.layoutError).toBeUndefined();expect(result.textMatches).toBe(true);expect(result.after).toEqual(result.before);
 const edited=Buffer.from(result.edited),out=unzipSync(edited);writeFileSync(info.outputPath('third-birthday-bookmarks.docx'),edited);sameParts(parts,unzipSync(new Uint8Array(result.restored)));
 expect(Object.keys(out).sort()).toEqual(Object.keys(parts).sort());for(const name of Object.keys(parts))if(name!=='word/document.xml')expect(Buffer.from(out[name]).equals(Buffer.from(parts[name])),name).toBe(true);
 const structure=await page.evaluate(([before,after])=>{
  const parse=s=>new DOMParser().parseFromString(s,'application/xml');
  const tree=n=>[n.namespaceURI,n.localName,[...n.attributes].filter(a=>a.namespaceURI!=='http://www.w3.org/2000/xmlns/').map(a=>[a.namespaceURI,a.localName,a.value]).sort(),[...n.childNodes].filter(c=>c.nodeType===1||c.nodeType===3).map(c=>c.nodeType===1?tree(c):c.textContent)];
  return ['bookmarkStart','bookmarkEnd','drawing'].map(name=>[name,...[before,after].map(s=>[...parse(s).getElementsByTagNameNS('*',name)].map(n=>[n.parentNode.localName,tree(n)]))]);
 },[strFromU8(parts['word/document.xml']),strFromU8(out['word/document.xml'])]);for(const [name,before,after] of structure)expect(after,name).toEqual(before);
 await page.getByLabel('Open DOCX file').setInputFiles(process.env.THIRD_BIRTHDAY_CARD_PATH);
 await expect(page.getByRole('textbox',{name:'Document text'})).toHaveValue(/Save the Date!/);
 await expect(page.getByRole('textbox',{name:'Document text'})).toHaveJSProperty('readOnly',false);
 await expect(page.locator('#playground-error')).toBeEmpty();
 for(let i=0;i<await page.locator('canvas.canvas-page').count();i++)writeFileSync(info.outputPath(`third-birthday-${i+1}.png`),Buffer.from(await page.locator('canvas.canvas-page').nth(i).evaluate(c=>c.toDataURL().split(',')[1]),'base64'));
});
