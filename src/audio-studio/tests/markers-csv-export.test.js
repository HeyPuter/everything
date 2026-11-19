import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { AudioFile } from '../src/model/audio-file.js';
import { createMarker } from '../src/model/markers.js';
import { installCoreCommands } from '../src/commands/core.js';
import { parseDelimited } from '../src/storage/markers-io.js';

afterEach(() => vi.unstubAllGlobals());

function setup() {
  localStorage.clear();
  const blobs = [];
  vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: (b) => (blobs.push(b), 'blob:x'), revokeObjectURL: () => {} }));
  const app = new App();
  app.notify = vi.fn();
  installCoreCommands(app);
  const doc = app.addDocument(AudioFile.blank({ name: 'Talk.wav', sampleRate: 1000, channels: 1, seconds: 10 }));
  const markers = [createMarker({ name: 'Intro', start: 0 }), createMarker({ name: 'Ad', start: 2000, duration: 500 }), createMarker({ name: 'Outro', start: 9000 })];
  doc.apply('Markers', { ...doc.state, markers });
  return { app, doc, markers, blobs };
}

const names = async (blob) => parseDelimited(await blob.text(), '\t').slice(1).map((r) => r[0]);

it('exports only the selected markers', async () => {
  const { app, markers, blobs } = setup();
  app.selectedMarkerIds = () => [markers[1].id, markers[2].id];
  expect(app.commands.label('file.exportMarkers')).toBe('Selected Markers to CSV...');
  await app.commands.run('file.exportMarkers');
  expect(await names(blobs[0])).toEqual(['Ad', 'Outro']);
});

it('exports every marker when none is selected, and takes ids from the Markers panel toolbar', async () => {
  const { app, markers, blobs } = setup();
  app.selectedMarkerIds = () => [];
  await app.commands.run('file.exportMarkers');
  expect(await names(blobs[0])).toEqual(['Intro', 'Ad', 'Outro']);
  await app.commands.run('file.exportMarkers', { ids: [markers[0].id] });
  expect(await names(blobs[1])).toEqual(['Intro']);
});
