import { describe, it, expect } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { startRecorder } from '../src/core/script-recorder.js';
import { runScript } from '../src/core/script-run.js';
import { nodeTransport } from './helpers/script-transport.js';

async function record(edit) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Docs');
  wb.setInput(id, 1, 0, 'old');
  wb.clearHistory();
  const json = wb.toJSON();
  const rec = startRecorder(wb);
  edit(wb, id);
  const copy = new Workbook(json);
  const res = await runScript({ wb: copy, code: rec.stop(), transport: nodeTransport(), timeout: 10000 });
  expect(res.error).toBe(null);
  return { wb, copy };
}
const cell = (wb, r) => { const c = wb.getCell(wb.activeSheetId, r, 0); return { v: c?.v ?? null, f: c?.f ?? null, link: c?.hyperlink ?? null }; };

describe('recording a link', () => {
  it('replays the text given to show', async () => {
    const { wb, copy } = await record((wb, id) => { wb.setLink(id, 1, 0, 'https://example.com', 'Example'); wb.setLink(id, 2, 0, 'https://example.com/c', 'C'); });
    expect(cell(wb, 1)).toEqual({ v: 'Example', f: null, link: 'https://example.com' });
    expect(cell(copy, 1)).toEqual(cell(wb, 1));
    expect(cell(copy, 2)).toEqual(cell(wb, 2));
  });

  it('replays a link on a cell that keeps its text', async () => {
    const { wb, copy } = await record((wb, id) => wb.setLink(id, 0, 0, 'https://example.com/docs', 'Docs'));
    expect(cell(copy, 0)).toEqual(cell(wb, 0));
  });
});
