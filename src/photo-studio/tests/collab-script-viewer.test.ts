// A script run on a shared document the person can only view or comment on
// is told its edits were refused, instead of being told they worked.
import { afterEach, describe, expect, it } from 'vitest';
import { environment, viewer } from './collab-helpers';
import { closeAll, connect, invite, share } from './collab-session-helpers';
import { DocumentSession } from '../src/app/session';
import { ScriptHost } from '../src/features/scripting/host';
import type { Editor } from '../src/editor';
import type { PhotoDocument } from '../src/model/document';

afterEach(closeAll);

describe('scripts on a shared document without edit access', () => {
  it('fail with the reason instead of reporting edits that never happened', async () => {
    const env = environment();
    const { room } = await share(env);
    const v = await connect(env, viewer, room, { token: await invite(env, room, 'viewer', true) });
    const s = new DocumentSession(v.binding.history.document);
    s.history = v.binding.history;
    s.assets = v.assets;
    s.hasDocument = true;
    const messages: string[] = [];
    (v.binding as unknown as { o: { onMessage?: (t: string) => void } }).o.onMessage = (t) => messages.push(t);
    const e = {
      sessions: [s],
      session: s,
      hasDocument: true,
      get doc() {
        return s.doc;
      },
      get selectedIds() {
        return s.selectedIds;
      },
      selectLayers(ids: string[]) {
        s.selectedIds = new Set(ids);
      },
      command(label: string, f: (d: PhotoDocument) => void) {
        s.history.execute(label, f);
      },
      update() {},
      message() {},
      color: '#000000',
      background: '#ffffff',
      async switchSession() {},
    };
    const host = new ScriptHost(e as unknown as Editor, {} as never, 'Rename (script)');
    const bg = s.doc.layers[0];
    await expect(host.call('layers.set', [s.id, bg.id, { name: 'Renamed' }])).rejects.toThrow('You can view this shared document but not change it.');
    expect(s.doc.layers[0].name).toBe(bg.name);
    host.finish();
  });
});
