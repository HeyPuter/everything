// Undo in a shared document undoes only this person's own work: undoing the
// addition of a layer someone else has since painted on or renamed keeps it.
import { afterEach, describe, expect, it } from 'vitest';
import { editor, environment } from './collab-helpers';
import { closeAll, connect, edit, idOf, invite, paintOn, pixel, settle, share } from './collab-session-helpers';
import { newPixelLayer } from '../src/model/pixel-layer';

afterEach(closeAll);
const names = (p: { binding: { history: { document: { layers: { name: string }[] } } } }) => p.binding.history.document.layers.map((l) => l.name);

describe('undoing a layer addition in a shared document', () => {
  it('keeps the layer, and everything in it, when someone else changed it since', async () => {
    const env = environment();
    const { room, a } = await share(env);
    const b = await connect(env, editor, room, { token: await invite(env, room, 'editor') });
    const said: string[] = [];
    (a.binding as unknown as { o: { onMessage?: (t: string) => void } }).o.onMessage = (t) => said.push(t);
    edit(a, 'New Layer', (d) => d.layers.push(newPixelLayer('Mine', d)));
    await settle(a, b);
    paintOn(b, idOf(b, 'Mine'), 0, 0, 40, 40, 99);
    edit(b, 'Rename', (d) => (d.layers.find((l) => l.name === 'Mine')!.name = 'Renamed by B'));
    await settle(a, b);
    a.binding.history.undo();
    await settle(a, b);
    for (const p of [a, b]) {
      expect(names(p)).toEqual(['Background', 'Top', 'Fill', 'Renamed by B']);
      expect(pixel(p, idOf(p, 'Renamed by B'), 5, 5)).toBe(99);
    }
    expect(said.join('\n')).toContain('Nothing to undo in “New Layer”');
  });
  it('still removes a layer nobody else touched, and Redo brings it back', async () => {
    const env = environment();
    const { room, a } = await share(env);
    const b = await connect(env, editor, room, { token: await invite(env, room, 'editor') });
    edit(a, 'New Layer', (d) => d.layers.push(newPixelLayer('Mine', d)));
    paintOn(a, idOf(a, 'Mine'), 0, 0, 10, 10, 50);
    // Someone else's edit elsewhere does not keep it.
    await settle(a, b);
    edit(b, 'Rename', (d) => (d.layers[0].name = 'Base'));
    await settle(a, b);
    a.binding.history.undo();
    a.binding.history.undo();
    await settle(a, b);
    expect(names(b)).toEqual(['Base', 'Top', 'Fill']);
    a.binding.history.redo();
    a.binding.history.redo();
    await settle(a, b);
    expect(names(b)).toEqual(['Base', 'Top', 'Fill', 'Mine']);
    expect(pixel(b, idOf(b, 'Mine'), 5, 5)).toBe(50);
  });
  it('undoes one’s own painting on a layer someone else also painted on', async () => {
    const env = environment();
    const { room, a } = await share(env);
    const b = await connect(env, editor, room, { token: await invite(env, room, 'editor') });
    const top = idOf(a, 'Top');
    paintOn(a, top, 0, 0, 10, 10, 50);
    await settle(a, b);
    paintOn(b, top, 300, 300, 10, 10, 70);
    await settle(a, b);
    a.binding.history.undo();
    await settle(a, b);
    for (const p of [a, b]) {
      expect(pixel(p, top, 5, 5)).toBe(0);
      expect(pixel(p, top, 305, 305)).toBe(70);
    }
  });
});
