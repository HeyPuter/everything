// Changes made while the worker could not be reached are sent as soon as it
// answers again, not when a long retry delay runs out.
import { afterEach, describe, expect, it } from 'vitest';
import { editor, environment, until, wait } from './collab-helpers';
import { closeAll, connect, edit, invite, share } from './collab-session-helpers';

afterEach(closeAll);

describe('reconnecting after offline edits', () => {
  it('sends queued changes once synchronization works again', async () => {
    const env = environment();
    const { room } = await share(env);
    const b = await connect(env, editor, room, { token: await invite(env, room, 'editor') });
    env.offlineUsers.add(editor.uuid);
    edit(b, 'Rename', (d) => (d.layers[0].name = 'Offline name'));
    await b.binding.idle();
    await until(() => b.client.status.state === 'offline', 2000, 'offline status');
    // Failed deliveries back off (1 s, 2 s, then 4 s).
    await wait(3500);
    env.offlineUsers.delete(editor.uuid);
    const back = Date.now();
    await until(() => b.client.status.pending === 0 && b.client.status.state === 'connected', 6000, 'delivery');
    expect(Date.now() - back).toBeLessThan(1500);
  }, 20_000);
});
