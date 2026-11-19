import { describe, it, expect, beforeAll } from 'vitest';
import { Session } from '../src/model/session.js';
import * as V from '../src/model/session-video.js';
import { App } from '../src/app.js';
import { installCore } from '../src/features/core.js';
import { installMultitrack } from '../src/features/multitrack.js';
import { installVideo } from '../src/features/video.js';
import { videoPanel, previewDivisor } from '../src/video/video-panel.js';
import { MENUS, commandMenuPaths } from '../src/ui/menus.js';

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = () => null;
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
  globalThis.URL.createObjectURL ??= () => 'blob:video';
});

function setup() {
  localStorage.clear();
  const app = new App();
  installCore(app);
  installMultitrack(app);
  installVideo(app);
  app.syncGraph = () => {};
  const doc = new Session({ name: 'Film.asesx', sampleRate: 1000, tracks: 2 });
  const sourceId = V.addVideoSource(doc, { name: 'Scene.webm', blob: new Blob([new Uint8Array(4)], { type: 'video/webm' }), width: 320, height: 180, duration: 8, fps: 25 });
  doc.apply('Insert File', V.setVideoClip(doc.state, V.createVideoClip({ sourceId, name: 'Scene', start: 0, length: 8000 })));
  app.addDocument(doc);
  return { app, doc };
}

describe('video preview resolution', () => {
  it('draws small only while playing unless full resolution on stop is off', () => {
    expect(previewDivisor({ resolution: 'full', playing: true })).toBe(1);
    expect(previewDivisor({ resolution: '4', playing: true })).toBe(4);
    expect(previewDivisor({ resolution: '4', playing: false })).toBe(1);
    expect(previewDivisor({ resolution: '2', playing: false, fullOnStop: false })).toBe(2);
    expect(previewDivisor({ resolution: 'odd', playing: true })).toBe(1);
  });

  it('has View > Video Display commands for the resolution', () => {
    const { app } = setup();
    expect(app.commands.isEnabled('view.videoFullOnStop')).toBe(false);
    app.commands.run('view.videoRes4');
    expect(app.prefs.get('videoResolution')).toBe('4');
    expect(app.commands.isChecked('view.videoRes4')).toBe(true);
    expect(app.commands.isChecked('view.videoFullOnStop')).toBe(true);
    app.commands.run('view.videoFullOnStop');
    expect(app.prefs.get('videoFullOnStop')).toBe(false);
    expect(commandMenuPaths(MENUS).get('view.videoRes2')).toEqual(['Video Display']);
  });

  it('shows the reduced picture in the panel when it applies', () => {
    const { app } = setup();
    const panel = videoPanel(app);
    document.body.replaceChildren(panel.el);
    panel.show();
    const low = panel.el.querySelector('.video-low');
    expect(low.hidden).toBe(true);
    app.prefs.set('videoResolution', '2');
    // Stopped, with full resolution on stop: still the full picture.
    expect(low.hidden).toBe(true);
    app.prefs.set('videoFullOnStop', false);
    expect(low.hidden).toBe(false);
    expect(panel.el.querySelector('.video-el').classList.contains('video-under')).toBe(true);
  });
});

describe('spotting the picture while dragging audio clips', () => {
  it('shows the dragged clip start in the panel and the lane, then returns to the playhead', () => {
    const { app, doc } = setup();
    const panel = videoPanel(app);
    document.body.replaceChildren(panel.el);
    panel.show();
    const frame = panel.el.querySelector('.video-frame');
    app.emit('clip-spot', doc, 2500);
    expect(frame.classList.contains('spotting')).toBe(true);
    expect(panel.el.querySelector('.video-spot-badge').hidden).toBe(false);
    app.emit('clip-spot', doc, null);
    expect(frame.classList.contains('spotting')).toBe(false);
    // Turned off in Preferences > Video: the panel stays on the playhead.
    app.prefs.set('videoSpot', false);
    app.emit('clip-spot', doc, 2500);
    expect(frame.classList.contains('spotting')).toBe(false);
  });

  it('marks the spot on the video lane', () => {
    const { app, doc } = setup();
    const view = app.documentKinds.get('session').view(app, doc);
    document.body.replaceChildren(view.el);
    const lane = view.videoLane;
    lane.width = 800;
    lane.height = 40;
    app.emit('clip-spot', doc, 1000);
    lane.frame();
    expect(lane.spotEl.hidden).toBe(false);
    app.emit('clip-spot', doc, null);
    lane.frame();
    expect(lane.spotEl.hidden).toBe(true);
    view.destroy();
  });
});

describe('clip drags report the spot', () => {
  it('moving a clip reports its new start, and releasing ends the spotting', async () => {
    const { Channel } = await import('../src/audio/channel.js');
    const S = await import('../src/model/session-edits.js');
    const { app, doc } = setup();
    const src = doc.addSource({ name: 'tone.wav', channels: [Channel.fromSamples(new Float32Array(4000).fill(0.25))] });
    const clip = S.createClip({ trackId: doc.state.tracks[0].id, sourceId: src, name: 'tone', start: 1000, length: 2000 });
    doc.apply('Insert File', S.addClips(doc.state, [clip]));
    const view = app.documentKinds.get('session').view(app, doc);
    document.body.replaceChildren(view.el);
    view.width = 1000;
    view.height = 600;
    view.computeRows();
    doc.setView(0, 10000);
    app.prefs.set('snapping', false);
    const spots = [];
    app.on('clip-spot', (d, f) => spots.push(f));
    view.surface.setPointerCapture = () => {};
    const pointer = (type, x, y) => view.surface.dispatchEvent(Object.assign(new Event(type, { bubbles: true }), { clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse' }));
    const r = view.clipRects().find((q) => q.clip.id === clip.id);
    const x0 = view.xOf(1500);
    pointer('pointerdown', x0, r.y + 30);
    pointer('pointermove', x0 + 10, r.y + 30);
    pointer('pointermove', x0 + 100, r.y + 30);
    pointer('pointerup', x0 + 100, r.y + 30);
    expect(spots.length).toBeGreaterThan(1);
    expect(spots.at(-1)).toBe(null);
    expect(spots.at(-2)).toBe(S.findClip(doc.state, clip.id).start);
    view.destroy();
  });
});
