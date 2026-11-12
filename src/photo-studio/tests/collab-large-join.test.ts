// Joining a large shared document downloads its tiles a few batches at a
// time rather than one round trip after another.
import { afterEach, describe, expect, it } from 'vitest';
import { editor, environment, wait } from './collab-helpers';
import { closeAll, connect, invite, share } from './collab-session-helpers';
import { newDocument } from '../src/model/document';
import { newPixelLayer } from '../src/model/pixel-layer';
import { writeRect } from '../src/model/tiles';
import type { RoomService } from '../src/collab/server/service';

afterEach(closeAll);

describe('joining a large document', () => {
  it('downloads tile batches in parallel, at most four at once, and gets every tile', async () => {
    const env = environment();
    const { room } = await share(env, {
      doc: (assets) => {
        const doc = newDocument(2048, 2048, 'Big');
        const l = newPixelLayer('Noise', doc);
        const data = new Uint8ClampedArray(2048 * 2048 * 4);
        let x = 1;
        // Every tile different, so none is shared.
        for (let i = 0; i < data.length; i++) data[i] = (x = (x * 1103515245 + 12345) >>> 0) >>> 24;
        l.pixels = writeRect(assets.tiles, l.pixels!, 0, 0, { width: 2048, height: 2048, data });
        doc.layers = [l];
        return doc;
      },
    });
    const token = await invite(env, room, 'editor');
    let inFlight = 0,
      most = 0,
      gets = 0;
    env.route = () =>
      ({
        call: async (identity: never, input: Record<string, unknown>) => {
          if (input.op !== 'asset.get') return env.service.call(identity, input);
          gets++;
          most = Math.max(most, ++inFlight);
          try {
            await wait(20);
            return await env.service.call(identity, input);
          } finally {
            inFlight--;
          }
        },
      }) as unknown as RoomService;
    const b = await connect(env, editor, room, { token });
    expect(Object.keys(b.binding.history.document.layers[0].pixels!.tiles)).toHaveLength(64);
    expect(gets).toBe(3);
    expect(most).toBe(3);
  }, 60_000);
});
