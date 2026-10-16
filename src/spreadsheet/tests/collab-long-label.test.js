import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { RoomClient } from '../src/collab/client.js';
import { memoryOutbox } from '../src/collab/outbox.js';
import { MAX_LABEL } from '../src/collab/ops.js';
import { saveScenario, showScenario } from '../src/core/scenarios.js';
import { environment, owner, SERVER, until } from './collab-helpers.js';

const open = [];
afterEach(() => { for (const c of open.splice(0)) c.close(); });

it('a step with a name longer than the room keeps is shared, its name cut without splitting a character', async () => {
  const env = environment();
  const wb = new Workbook({ sheets: [{ name: 'Plan' }] });
  const room = await RoomClient.create({ puter: env.sdk(owner), server: SERVER, wb, name: 'Plan', file: null });
  const a = new RoomClient({ puter: env.sdk(owner), server: SERVER, room, store: memoryOutbox(), poll: 50, noPeers: true });
  open.push(a);
  await a.open();
  const refused = [];
  a.addEventListener('refused', (e) => refused.push(e.detail.message));
  const s = a.wb.sheets[0].id;
  // The Scenario Manager takes names up to 255 characters; an emoji straddles the room's limit.
  const name = `Best case ${'x'.repeat(MAX_LABEL - 'Show scenario Best case '.length - 1)}😀 and more`;
  expect(saveScenario(a.wb, s, { name, cells: [{ r: 0, c: 0 }], values: [42] })).toBe(null);
  await until(() => !a.replica.pending.length, 4000, 'scenario saved');
  env.offline = true; // a brief blip, so the next edits travel in one commit
  a.wb.setInput(s, 5, 5, 'typed just before');
  showScenario(a.wb, s, name);
  await until(() => a.status.state === 'offline', 4000, 'offline');
  env.offline = false;
  await a.flush();
  await a.settled();
  expect(refused).toEqual([]);
  expect(a.wb.getValue(s, 5, 5)).toBe('typed just before');
  expect(a.wb.getValue(s, 0, 0)).toBe(42);
  const labels = env.calls.filter((c) => c.op === 'commit').flatMap((c) => c.changes.map((ch) => ch.label));
  const shown = labels.find((l) => l.startsWith('Show scenario'));
  expect(shown.length).toBeLessThanOrEqual(MAX_LABEL);
  expect(shown).toBe(`Show scenario ${name}`.slice(0, MAX_LABEL - 1));
  // Undo here still names the whole step.
  expect(a.wb.undoLabel()).toBe(`Show scenario ${name}`);
});
