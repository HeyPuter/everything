import { afterEach, expect, it } from 'vitest';
import { editor, environment } from './collab-helpers';
import { closeAll, connect, edit, invite, settle, share } from './collab-session-helpers';

afterEach(closeAll);

for (const target of [0, 1]) it(`retains shared history row ${target} at the limit without undoing another person's work`, async () => {
  const env = environment(), { room, a } = await share(env);
  const b = await connect(env, editor, room, { token: await invite(env, room, 'editor') });
  const h = a.binding.history;
  h.limit = 1;
  edit(a, 'First', (d) => { d.layers[0].name = 'First'; });
  await settle(a, b);
  const position = h.holdPosition(target);
  edit(a, 'Second', (d) => { d.layers[0].name = 'Second'; });
  await settle(a, b);
  edit(b, 'Peer edit', (d) => { d.layers[1].name = 'Peer edit'; });
  await settle(a, b);
  position.restore();
  position.release();
  await settle(a, b);
  for (const p of [a, b]) expect(p.binding.history.document.layers.slice(0, 2).map((l) => l.name)).toEqual([target ? 'First' : 'Background', 'Peer edit']);
  expect(h.redoLabels).toEqual(target ? ['Second'] : ['First', 'Second']);
  while (h.canRedo) h.redo();
  await settle(a, b);
  expect(h.document.layers[0].name).toBe('Second');
  edit(a, 'Third', (d) => { d.layers[0].name = 'Third'; });
  await settle(a, b);
  expect(h.labels).toEqual(['Third']);
});
