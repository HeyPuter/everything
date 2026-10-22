// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Workbook} from '../src/core/workbook.js';
import {openPrintDialog} from '../src/ui/printdialog.js';
import {printSheet} from '../src/ui/print.js';
import {closeAllModals} from '../src/ui/modal.js';
import * as S from '../src/core/selection.js';
vi.mock('../src/ui/print.js',async original=>({...await original(),printSheet:vi.fn(()=>true)}));
beforeEach(()=>{vi.stubGlobal('matchMedia',()=>({matches:true}));printSheet.mockClear();});
afterEach(()=>{closeAllModals();document.body.replaceChildren();localStorage.clear();vi.restoreAllMocks();vi.unstubAllGlobals();});

it('edits first/even text with token chips and saves the choices with Undo',async()=>{
  document.body.innerHTML='<div id="app"></div>';
  const wb=new Workbook({sheets:[{name:'Report',cells:{'0,0':{v:1}},printSettings:{differentFirst:true,footer:'Regular',firstFooter:''}}]});
  const old=structuredClone(wb.activeSheet.printSettings);
  const modal=openPrintDialog({wb,sheetId:()=>wb.activeSheetId,selection:()=>S.single(0,0),range:()=>({r1:0,c1:0,r2:0,c2:0}),grid:{focus(){}}});
  const input=modal.panel.querySelector('[aria-label="First page footer text"]');
  expect(input.closest('.row').hidden).toBe(false);
  input.value='Opening ';input.dispatchEvent(new Event('input'));input.focus();
  const pageButton=[...modal.panel.querySelectorAll('button')].find(b=>b.textContent==='Page number');
  pageButton.click();
  expect(input.value).toBe('Opening &[Page]');
  const even=[...modal.panel.querySelectorAll('label.check')].find(n=>n.textContent==='Different odd and even pages').querySelector('input');
  even.click();
  const evenInput=modal.panel.querySelector('[aria-label="Even pages footer text"]');
  expect(evenInput.closest('.row').hidden).toBe(false);
  evenInput.value='Even';evenInput.dispatchEvent(new Event('input'));
  modal.panel.querySelector('form').requestSubmit();await Promise.resolve();
  expect(printSheet).toHaveBeenCalledWith(expect.anything(),expect.anything(),undefined,expect.objectContaining({differentFirst:true,differentOddEven:true,firstFooter:'Opening &P',evenFooter:'Even'}));
  expect(wb.activeSheet.printSettings).toMatchObject({differentFirst:true,differentOddEven:true,firstFooter:'Opening &P',evenFooter:'Even'});
  wb.undo();expect(wb.activeSheet.printSettings).toEqual(old);
});
