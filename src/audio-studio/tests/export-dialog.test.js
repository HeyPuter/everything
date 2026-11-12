import { describe, it, expect, beforeEach } from 'vitest';
import { exportFileDialog } from '../src/export/dialog.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Prefs } from '../src/lib/prefs.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const $ = (sel) => document.querySelector(sel);

function change(el, value) {
  el.value = String(value);
  el.dispatchEvent(new Event('change'));
}

describe('Export File dialog', () => {
  let app;
  beforeEach(() => {
    document.body.replaceChildren();
    delete window.puter;
    app = { prefs: new Prefs(null) };
  });

  it('switches formats, edits the sample type on its own page and returns the options', async () => {
    const doc = AudioFile.blank({ name: 'Podcast.wav', sampleRate: 48000, channels: 2, seconds: 2 });
    doc.info.bitDepth = 24;
    const pending = exportFileDialog(app, doc, { mode: 'export' });
    await tick(10);
    const name = $('.io-name');
    expect(name.value).toBe('Podcast.wav');
    // Without Puter only "This device" can be chosen.
    expect($('select[aria-label=Location]').value).toBe('download');
    expect($('.io-export').textContent).toContain('48000 Hz Stereo, 24-bit');
    // WebCodecs formats are listed but disabled in this environment.
    expect($('select[aria-label=Format] option[value=opus]').disabled).toBe(true);
    change($('select[aria-label=Format]'), 'mp3');
    expect(name.value).toBe('Podcast.mp3');
    expect($('select[aria-label="Bitrate (CBR)"]').value).toBe('192');
    change($('select[aria-label="Bitrate (CBR)"]'), 320);
    change($('select[aria-label=Format]'), 'flac');
    expect($('select[aria-label="Compression Level"]').value).toBe('5');
    // Change... opens the sample type page in place of the form.
    $('[aria-label="Change sample type"]').click();
    expect($('.io-sample-page').hidden).toBe(false);
    expect($('.io-export').hidden).toBe(true);
    expect($('.dialog-title').textContent).toBe('Change Sample Type');
    change($('select[aria-label="Sample rate"]'), 44100);
    change($('select[aria-label=Channels]'), 1);
    change($('select[aria-label="Bit depth"]'), 16);
    change($('select[aria-label=Dither]'), 'shaped');
    [...document.querySelectorAll('.io-sample-actions .btn')].find((b) => b.textContent === 'OK').click();
    expect($('.io-export').hidden).toBe(false);
    expect($('.io-export').textContent).toContain('44100 Hz Mono, 16-bit');
    name.value = 'Final cut';
    $('.dialog-foot .btn.primary').click();
    const r = await pending;
    expect(r.fileName).toBe('Final cut.flac');
    expect(r.location).toEqual({ type: 'download' });
    expect(r.options).toMatchObject({ format: 'flac', sampleRate: 44100, channels: 1, bitDepth: 16, dither: 'shaped', settings: { level: 5 } });
    // Choices are remembered for the next export.
    expect(app.prefs.get('exportPrefs')).toMatchObject({ format: 'flac', dither: 'shaped', settings: { flac: { level: 5 } } });
  });

  it('requires a file name and lets Escape leave the sample type page', async () => {
    const doc = AudioFile.blank({ name: 'a.wav', sampleRate: 44100, channels: 1, seconds: 1 });
    const pending = exportFileDialog(app, doc, { mode: 'saveAs' });
    await tick(10);
    $('.io-name').value = '   ';
    $('.dialog-foot .btn.primary').click();
    await tick(10);
    expect($('.io-error').textContent).toMatch(/file name/);
    $('[aria-label="Change sample type"]').click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect($('.io-sample-page').hidden).toBe(true);
    expect($('.io-export-dialog')).not.toBe(null);
    [...document.querySelectorAll('.dialog-foot .btn')].find((b) => b.textContent === 'Cancel').click();
    expect(await pending).toBe(null);
  });

  it("starts Save As in the folder of the document's Puter file", async () => {
    window.puter = { auth: { isSignedIn: () => true, getUser: async () => ({ username: 'u' }) } };
    app.prefs.set('exportFolder', '/u/Exports');
    const doc = AudioFile.blank({ name: 'Song.wav', sampleRate: 44100, channels: 1, seconds: 1 });
    doc.source = { type: 'puter', path: '/u/Music/Album/Song.wav' };
    const pending = exportFileDialog(app, doc, { mode: 'saveAs' });
    await tick(10);
    expect($('.io-path').textContent).toBe('/u/Music/Album');
    $('.dialog-foot .btn.primary').click();
    expect((await pending).location).toEqual({ type: 'puter', dir: '/u/Music/Album' });
    // Export keeps going to the last export folder.
    app.prefs.set('exportFolder', '/u/Exports');
    const third = exportFileDialog(app, doc, { mode: 'export' });
    await tick(10);
    expect($('.io-path').textContent).toBe('/u/Exports');
    [...document.querySelectorAll('.dialog-foot .btn')]
      .find((b) => b.textContent === 'Cancel')
      .click();
    await third;
  });
});
