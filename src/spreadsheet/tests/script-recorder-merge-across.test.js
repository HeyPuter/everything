import { describe, it, expect } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { startRecorder } from '../src/core/script-recorder.js';
import { runScript } from '../src/core/script-run.js';
import { nodeTransport } from './helpers/script-transport.js';

async function record(setup, edit) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  setup(wb, id);
  wb.clearHistory();
  const json = wb.toJSON();
  const rec = startRecorder(wb);
  edit(wb, id);
  const code = rec.stop();
  const copy = new Workbook(json);
  const res = await runScript({ wb: copy, code, transport: nodeTransport(), timeout: 10000 });
  expect(res.error).toBe(null);
  return { wb, copy, id: copy.activeSheetId, code };
}

describe('recording', () => {
  it('replays Merge Across as a merge on each row', async () => {
    const { copy, id } = await record((wb, id) => wb.setInput(id, 0, 0, 'a'),
      (wb, id) => wb.mergeBlocks(id, [{ r1: 0, c1: 0, r2: 0, c2: 2 }, { r1: 1, c1: 0, r2: 1, c2: 2 }]));
    expect(copy.sheet(id).merges.map((m) => [m.r1, m.c1, m.r2, m.c2])).toEqual([[0, 0, 0, 2], [1, 0, 1, 2]]);
  });
});
