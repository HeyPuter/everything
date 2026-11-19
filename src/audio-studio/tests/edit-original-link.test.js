import { expect, it } from 'vitest';
import { buildXmp, parseXmp } from '../src/audio/xmp.js';
import { runExport } from '../src/export/pipeline.js';
import { parseWav } from '../src/audio/wav.js';
import { originFromMeta } from '../src/storage/files.js';
import { renderedDoc } from '../src/multitrack/render.js';
import { Prefs } from '../src/lib/prefs.js';

it('keeps the session link of a mixdown in the saved file', async () => {
  const x = buildXmp({ editOriginal: '/u/Songs/Band.asesx' });
  expect(x).toContain('xmlns:asx=');
  expect(parseXmp(x)).toEqual({ editOriginal: '/u/Songs/Band.asesx' });
  // Without the link no extra namespace is declared.
  expect(buildXmp({ title: 'T' })).not.toContain('xmlns:asx=');
  const ch = [new Float32Array(10)];
  const blob = await runExport({ options: { format: 'wav', sampleRate: 8000, channels: 1, bitDepth: 16, dither: 'none', settings: {} }, sourceRate: 8000, frames: 10, read: (at, n) => ch.map((c) => c.subarray(at, at + n)), meta: { editOriginal: '/u/Songs/Band.asesx' } });
  const meta = parseWav(await blob.arrayBuffer()).meta;
  expect(originFromMeta(meta)).toEqual({ sessionId: null, name: 'Band.asesx', path: '/u/Songs/Band.asesx' });
  expect(originFromMeta({})).toBe(null);
});

it('mixdowns of a saved session carry the link unless the preference is off', () => {
  const prefs = new Prefs(null);
  const app = { prefs, uniqueName: (n) => n };
  const session = { id: 's1', name: 'Band.asesx', sampleRate: 8000, source: { type: 'puter', path: '/u/Band.asesx' } };
  const data = [new Float32Array(4)];
  expect(renderedDoc(app, session, data, 'Mix').state.meta).toEqual({ editOriginal: '/u/Band.asesx' });
  prefs.set('embedEditOriginal', false);
  expect(renderedDoc(app, session, data, 'Mix').state.meta).toEqual({});
  prefs.set('embedEditOriginal', true);
  expect(renderedDoc(app, { ...session, source: { type: 'new' } }, data, 'Mix').state.meta).toEqual({});
});
