import {it,expect,beforeAll,afterAll} from 'vitest';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {unzipSync} from 'fflate';
import {DocxPackage,createDocx} from '../src/engine/docx.js';
import {paragraph} from '../src/engine/model.js';
import {previewNotice,previewFeatureLabels,pictureFontNotice,scriptFontNotice} from '../src/views/preview-notice.js';
import {recordPreviewIssue} from '../src/engine/preview-issues.js';
import {UnsupportedDocumentError} from '../src/engine/errors.js';
let dom;
it('discloses unavailable script metrics without disabling editing or interpreting font names as markup',()=>{
 const container=document.createElement('div');
 container.append(...scriptFontNotice(['<Font & Metrics>','<Font & Metrics>']));
 expect(container.children).toHaveLength(1);
 expect(container.textContent).toContain('approximate for <Font & Metrics>');
 expect(container.textContent).not.toContain('read-only');
 expect(container.querySelector('font')).toBeNull();
 expect(scriptFontNotice()).toEqual([]);
});
it('keeps lengthy script font notices collapsed and keyboard accessible',()=>{
 const container=document.createElement('div');
 container.append(...scriptFontNotice(['A','B','C','D','E']));
 expect(container.querySelector('details').open).toBe(false);
 expect(container.querySelector('ul').tabIndex).toBe(0);
 expect(container.querySelectorAll('li')).toHaveLength(5);
});
it('shows missing picture fonts safely without claiming the document is read-only',()=>{
 const container=document.createElement('div');
 container.append(...pictureFontNotice({missingPictureFonts:['<Missing & Font>','<Missing & Font>']}));
 expect(container.children).toHaveLength(1);
 expect(container.textContent).toContain('<Missing & Font>');
 expect(container.textContent).not.toContain('read-only');
 expect(container.querySelector('missing')).toBeNull();
 expect(pictureFontNotice({})).toEqual([]);
 const many=document.createElement('div');many.append(...pictureFontNotice({missingPictureFonts:['A','B','C','D','E']}));
 expect(many.querySelector('details').open).toBe(false);
 expect(many.querySelectorAll('li')).toHaveLength(5);
 expect(many.querySelector('ul').tabIndex).toBe(0);
});
beforeAll(()=>{dom=new JSDOM();globalThis.Node=dom.window.Node;globalThis.document=dom.window.document;globalThis.DOMParser=dom.window.DOMParser;globalThis.XMLSerializer=dom.window.XMLSerializer;});
afterAll(()=>{dom.window.close();delete globalThis.Node;delete globalThis.document;delete globalThis.DOMParser;delete globalThis.XMLSerializer;});
it('collects independent active preview failures, deduplicates repeated features and retains the source',async()=>{
 const bytes=readFileSync('tests/fixtures/preview-issues/control.docx');
 const p=await DocxPackage.open(bytes,{bestEffort:true});
 // Hidden text is supported since 2026-10-09 and right-to-left paragraphs (w:bidi) since 2026-11-10:
 // neither is reported, and the wave border alone keeps the document read-only.
 expect(p.readOnly).toBe(true);expect(p.previewIssues).not.toContain('bidi');
 expect(p.previewIssues.filter(x=>/border/i.test(x))).toHaveLength(1);
 expect(p.paragraphs.find(x=>x.runs[0]?.text==='Directional paragraph').format.bidi).toBe(true);
 expect(p.parts).toEqual(unzipSync(bytes));expect(()=>p.export()).toThrow('read-only');
 expect(p.paragraphs[0].runs[0].bold).toBe(true);
 const ordinary=await DocxPackage.open(new Uint8Array(await createDocx([paragraph('Ordinary')]).export().arrayBuffer()),{bestEffort:true});
 expect(ordinary.readOnly).not.toBe(true);expect(ordinary.previewIssues).toBeUndefined();
});
it('uses readable feature labels and renders document-controlled diagnostic text safely',()=>{
 const nodes=previewNotice({previewIssues:['right-to-left section columns or line numbers','vanish','vanish','<img src=x onerror=alert(1)>']});
 const container=document.createElement('div');container.append(...nodes);
 expect(container.querySelectorAll('li')).toHaveLength(3);
 expect(container.textContent).toContain('Right-to-left columns or line numbers');expect(container.textContent).toContain('Hidden text');
 expect(container.querySelector('img')).toBeNull();expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
 expect(container.querySelector('summary').textContent).toBe('Unsupported features detected (3)');
 expect(container.querySelector('details').open).toBe(false);
 expect(previewFeatureLabels(['moveFrom','moveTo'])).toEqual(['Tracked moved text']);
 expect(previewFeatureLabels([`page borders (${new UnsupportedDocumentError('paragraph borders with This paragraph border style is not supported yet.').message})`])).toEqual(['Page border styles']);
});
it('retains ordinary layout/image errors without fabricating an unsupported feature',()=>{
 const issues=new Set();recordPreviewIssue(issues,new Error('Image format cannot be decoded.'));recordPreviewIssue(issues,new Error('Image format cannot be decoded.'));
 expect([...issues]).toEqual(['Image format cannot be decoded.']);
 const container=document.createElement('div');container.append(...previewNotice({}));
 expect(container.textContent).toContain('could not identify');expect(container.querySelector('ul')).toBeNull();
});
