import { describe, it, expect } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runScript } from '../src/core/script-run.js';
import { nodeTransport } from './helpers/script-transport.js';

const exited = (worker) => new Promise((resolve) => { if (worker.threadId === -1) resolve(); else worker.once('exit', resolve); });

describe('script isolation', () => {
  it('leaves the script no window, document, puter, network or storage', async () => {
    const wb = new Workbook();
    const logs = [];
    const res = await runScript({ wb, transport: nodeTransport(), onLog: (l) => logs.push(l.text), code: `async function main(workbook) {
      const names = ['window', 'document', 'puter', 'fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts', 'indexedDB', 'caches', 'navigator', 'Worker', 'BroadcastChannel', 'localStorage', 'location', 'parent', 'top'];
      console.log(names.filter((n) => typeof globalThis[n] !== 'undefined').join(',') || 'none');
      let refused = false;
      try { fetch('https://example.com'); } catch (e) { refused = e instanceof TypeError; }
      console.log(refused ? 'fetch refused' : 'fetch ran');
      try { globalThis.fetch = () => 1; } catch (e) { /* frozen */ }
      console.log(typeof globalThis.fetch);
    }` });
    expect(res.error).toBe(null);
    expect(logs).toEqual(['none', 'fetch refused', 'undefined']);
  });

  it('checks every message, even one the script forges', async () => {
    const wb = new Workbook();
    const forged = await runScript({ wb, transport: nodeTransport(), code: `async function main() {
      self.postMessage({ type: 'ops', ops: [{ op: 'eval', code: 'alert(1)', line: 2 }] });
      await new Promise((r) => setTimeout(r, 50));
    }` });
    expect(forged.ok).toBe(false);
    expect(forged.error.message).toMatch(/Unknown operation "eval"/);
    const style = await runScript({ wb, transport: nodeTransport(), code: `async function main(workbook) {
      self.postMessage({ type: 'ops', ops: [{ op: 'style', sheet: workbook.getActiveWorksheet()._id, a: 'A1', patch: { bg: 'url(javascript:1)' } }] });
      await new Promise((r) => setTimeout(r, 50));
    }` });
    expect(style.error.message).toMatch(/not a colour/);
    const sheet = await runScript({ wb, transport: nodeTransport(), code: `async function main() {
      self.postMessage({ type: 'ops', ops: [{ op: 'write', sheet: 'nope', a: 'A1', rows: [[1]] }] });
      await new Promise((r) => setTimeout(r, 50));
    }` });
    expect(sheet.error.message).toMatch(/no longer exists/);
    expect(wb.getValue(wb.activeSheetId, 0, 0)).toBe(null);
  });

  it('stops a script that runs too long, mid-loop, and keeps the app responsive', async () => {
    const wb = new Workbook();
    const workers = [];
    const started = Date.now();
    const res = await runScript({ wb, transport: nodeTransport(workers), timeout: 400, code: `async function main(workbook) {
      workbook.getActiveWorksheet().getRange('A1').setValue('before');
      await new Promise((r) => setTimeout(r, 20));
      for (;;) {}
    }` });
    expect(res.timedOut).toBe(true);
    expect(res.error.message).toMatch(/more than 0 seconds|was stopped/);
    expect(Date.now() - started).toBeLessThan(5000);
    await exited(workers[0]);
    // What it did before the loop stands, as one step that can be undone.
    expect(wb.getValue(wb.activeSheetId, 0, 0)).toBe('before');
    expect(wb.undoLabels()).toEqual(['Run script']);
  });

  it('stops when asked', async () => {
    const wb = new Workbook();
    const workers = [];
    const stop = new AbortController();
    const running = runScript({ wb, transport: nodeTransport(workers), signal: stop.signal, code: 'async function main() { for (;;) {} }' });
    setTimeout(() => stop.abort(), 100);
    const res = await running;
    expect(res.stopped).toBe(true);
    await exited(workers[0]);
  });

  it('undoes and redoes everything a script did as one step', async () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, 'keep');
    const before = JSON.stringify(wb.toJSON());
    const res = await runScript({ wb, transport: nodeTransport(), label: 'Run script "Tidy"', code: `async function main(workbook) {
      const s = workbook.getActiveWorksheet();
      for (let i = 0; i < 30; i++) s.getCell(i + 1, 0).setValue(i);
      await s.getRange('A1').getValues();
      s.getRange('A1:A31').getFormat().getFont().setBold(true);
      s.getRange('1:1').insert();
      workbook.addWorksheet('More').getRange('B2').setValue('x');
      s.getRange('A1').setValue('top');
    }` });
    expect(res.error).toBe(null);
    expect(wb.undoLabels()).toEqual(['Run script "Tidy"', 'Edit cell']);
    const after = JSON.stringify(wb.toJSON());
    wb.undo();
    expect(JSON.stringify(wb.toJSON())).toBe(before);
    wb.redo();
    expect(JSON.stringify(wb.toJSON())).toBe(after);
    expect(wb.sheetByName('More')).toBeTruthy();
  });

  it('makes no undo step for a script that changes nothing', async () => {
    const wb = new Workbook();
    const res = await runScript({ wb, transport: nodeTransport(), code: 'async function main(workbook) { console.log(await workbook.getActiveWorksheet().getRange("A1").getValue()); }' });
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(false);
    expect(wb.canUndo()).toBe(false);
  });
});
