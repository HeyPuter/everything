import { describe, it, expect, afterEach } from 'vitest';
import { Channel } from '../src/audio/channel.js';
import { AudioFile } from '../src/model/audio-file.js';
import { getEffect, registerEffect } from '../src/effects/registry.js';
import { openEffectDialog } from '../src/effects/dialog.js';
import { openDialog } from '../src/ui/dialog.js';
import { fakeApp, filled } from './fx-helpers.js';

registerEffect({
  id: 'floatEnv',
  name: 'Float Envelope',
  group: 'Amplitude and Compression',
  kind: null,
  params: [{ id: 'env', label: 'Envelope', type: 'envelope', min: 0, max: 2, unit: '%', default: [{ t: 0, v: 1 }, { t: 1, v: 1 }] }],
  process: async ({ channels }) => channels,
});

function setup() {
  const app = fakeApp();
  const doc = new AudioFile({ name: 'a.wav', sampleRate: 48000, channels: [Channel.fromSamples(filled(4800, 0.1)), Channel.fromSamples(filled(4800, 0.1))] });
  app.documents.push(doc);
  app.active = doc;
  return { app, doc };
}

const esc = (target = document.body) => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

afterEach(() => document.querySelectorAll('.dialog-backdrop').forEach((b) => b.remove()));

describe('floating (modeless) dialogs', () => {
  it('leave the app usable: keys outside the window do not reach it', async () => {
    const handle = {};
    const p = openDialog({ title: 'Float', body: document.createElement('div'), modeless: true, handle, className: 'float-test' });
    const backdrop = document.querySelector('.dialog-backdrop');
    expect(backdrop.classList.contains('modeless')).toBe(true);
    expect(handle.el.classList.contains('floating')).toBe(true);
    expect(handle.el.getAttribute('aria-modal')).toBe('false');
    // Escape with focus outside the window is the app's, not the window's.
    document.body.focus();
    esc();
    expect(document.querySelector('.dialog.floating')).not.toBeNull();
    // Inside the window Escape closes it.
    esc(handle.el.querySelector('button'));
    expect(await p).toBeNull();
  });

  it('can be closed by its opener through the handle', async () => {
    const handle = {};
    const p = openDialog({ title: 'Float', body: document.createElement('div'), modeless: true, handle });
    handle.close('done');
    expect(await p).toBe('done');
    expect(document.querySelector('.dialog-backdrop')).toBeNull();
  });
});

describe('floating effect windows', () => {
  it('preview the effect on any playback of the file while open', async () => {
    const { app, doc } = setup();
    const p = openEffectDialog(app, getEffect('amplify'), { doc, modeless: true });
    expect(document.querySelector('.fx-dialog.floating')).not.toBeNull();
    expect(app.previewFx?.map((s) => s.key)).toEqual(['preview:amplify']);
    // Power off bypasses the preview slot.
    document.querySelector('.fx-power').click();
    expect(app.previewFx[0].enabled).toBe(false);
    // Playback started in the editor turns the Preview button into Stop.
    app.emit('transport', 'playing');
    expect(document.querySelector('.fx-play').getAttribute('aria-label')).toBe('Stop preview');
    document.querySelector('.dialog-head .icon-btn').click();
    expect(await p).toBeNull();
    expect(app.previewFx).toBeNull();
  });

  it('keeps one window: another effect replaces it, the same effect keeps it', async () => {
    const { app, doc } = setup();
    const first = openEffectDialog(app, getEffect('amplify'), { doc, modeless: true });
    const again = openEffectDialog(app, getEffect('amplify'), { doc, modeless: true });
    expect(await again).toBeNull();
    expect(document.querySelectorAll('.fx-dialog')).toHaveLength(1);
    const other = openEffectDialog(app, getEffect('hardLimiter') || getEffect('amplify'), { doc, modeless: true, mode: 'edit', slotId: 's1' });
    expect(await first).toBeNull();
    expect(document.querySelectorAll('.fx-dialog')).toHaveLength(1);
    document.querySelector('.dialog-head .icon-btn').click();
    expect(await other).toBeNull();
  });

  it('closes when another file becomes active', async () => {
    const { app, doc } = setup();
    const p = openEffectDialog(app, getEffect('amplify'), { doc, modeless: true });
    app.emit('active', null);
    expect(await p).toBeNull();
    expect(document.querySelector('.fx-dialog')).toBeNull();
  });

  it('Apply resolves the values; envelope dialogs stay modal', async () => {
    const { app, doc } = setup();
    const p = openEffectDialog(app, getEffect('amplify'), { doc, modeless: true });
    document.querySelector('.fx-dialog .btn.primary').click();
    expect(await p).toMatchObject({ left: 0, right: 0 });
    const q = openEffectDialog(app, getEffect('floatEnv'), { doc, modeless: true });
    expect(document.querySelector('.dialog-backdrop').classList.contains('modeless')).toBe(false);
    document.querySelector('.dialog-head .icon-btn').click();
    expect(await q).toBeNull();
  });
});
