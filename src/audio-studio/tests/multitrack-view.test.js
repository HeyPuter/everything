import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { App } from '../src/app.js';
import { installCore } from '../src/features/core.js';
import { installMultitrack } from '../src/features/multitrack.js';
import { Session } from '../src/model/session.js';
import { Channel } from '../src/audio/channel.js';
import * as S from '../src/model/session-edits.js';
import { mixerPanel, fader } from '../src/panels/mixer.js';
import { sessionPropertySection } from '../src/multitrack/properties.js';

beforeAll(() => {
  // jsdom has no canvas; the view draws nothing without a context.
  HTMLCanvasElement.prototype.getContext = () => null;
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
  }
});

const RATE = 48000;

function setup() {
  localStorage.clear();
  const app = new App();
  installCore(app);
  installMultitrack(app);
  app.syncGraph = () => {};
  const doc = new Session({ name: 'Test.asesx', sampleRate: RATE, tracks: 3 });
  const src = doc.addSource({ name: 'tone.wav', channels: [Channel.fromSamples(new Float32Array(RATE * 4).fill(0.25))] });
  const clip = S.createClip({ trackId: doc.state.tracks[0].id, sourceId: src, name: 'tone', start: RATE, length: RATE * 2 });
  doc.apply('Insert File', S.addClips(doc.state, [clip]));
  app.addDocument(doc);
  const view = app.documentKinds.get('session').view(app, doc);
  document.body.replaceChildren(view.el);
  // jsdom has no layout: give the lanes a size.
  view.width = 1000;
  view.height = 600;
  view.computeRows();
  doc.setView(0, RATE * 10);
  app.currentView = () => view;
  return { app, doc, view, clip };
}

describe('multitrack view', () => {
  let ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('builds a header per track plus the master, in order', () => {
    const { view, doc } = ctx;
    const names = [...view.el.querySelectorAll('.mt-th-name')].map((i) => i.value);
    expect(names).toEqual([...doc.state.tracks.map((t) => t.name), 'Mix']);
    expect(view.el.querySelector('.mt-th.master .mt-tb-arm')).toBeNull();
  });

  it('inverts polarity from the header and hides effects power without effects', () => {
    const { view, doc } = ctx;
    const hd = view.el.querySelector('.mt-th');
    expect(hd.querySelector('.mt-tb-fx').hidden).toBe(true);
    hd.querySelector('.mt-tb-invert').click();
    expect(doc.state.tracks[0].invert).toBe(true);
    expect(view.el.querySelector('.mt-th .mt-tb-invert').getAttribute('aria-pressed')).toBe('true');
    expect([...hd.querySelectorAll('.mt-th-select option')].map((o) => o.textContent)).toContain('Default Stereo Input');
  });

  it('offers Add Video Track while the session has no video', async () => {
    const { app, doc } = ctx;
    const { MENUS } = await import('../src/ui/menus.js');
    const tracks = MENUS.find((m) => m.label === 'Multitrack').submenu.find((x) => x.label === 'Tracks').submenu;
    expect(tracks).toContain('mt.addVideoTrack');
    expect(app.commands.isEnabled('mt.addVideoTrack')).toBe(true);
    doc.amendView((st) => ({ ...st, video: { id: 'v1', sourceId: 'x', name: 'V', start: 0, offset: 0, length: 10 } }));
    expect(app.commands.isEnabled('mt.addVideoTrack')).toBe(false);
  });

  it('switches single effects from the header in effects mode', () => {
    const { app, view, doc } = ctx;
    const id = doc.state.tracks[0].id;
    doc.apply('Track Effects', S.updateTrack(doc.state, id, { fx: [{ id: 'e1', effect: 'amplify', values: {}, enabled: true }] }));
    app.prefs.set('mtHeaderMode', 'fx');
    view.syncHeaders();
    const chip = view.el.querySelector('.mt-th .mt-th-fxname');
    expect(chip.textContent).toBe('Amplify');
    chip.querySelector('.mt-th-fxpower').click();
    expect(doc.state.tracks[0].fx[0].enabled).toBe(false);
    view.syncHeaders();
    expect(view.el.querySelector('.mt-th .mt-th-fxname').classList.contains('off')).toBe(true);
  });

  it('shows every visible track in the navigator and scrolls with it', () => {
    const { view, doc } = ctx;
    const segs = () => [...view.el.querySelectorAll('.mt-vnav-seg')];
    expect(segs()).toHaveLength(doc.state.tracks.length + 1);
    view.height = 200;
    view.computeRows();
    const thumb = view.el.querySelector('.mt-vnav-thumb');
    const span = view.contentHeight;
    expect(parseFloat(thumb.style.height)).toBeCloseTo((200 / span) * 100, 1);
    view.el.querySelector('.mt-vnav').dispatchEvent(new WheelEvent('wheel', { deltaY: 100, cancelable: true }));
    expect(view.scrollY).toBe(100);
    expect(parseFloat(thumb.style.top)).toBeCloseTo((100 / span) * 100, 1);
    doc.amendView((st) => ({ ...st, tracks: st.tracks.map((t, i) => (i === 1 ? { ...t, hidden: true } : t)) }));
    view.computeRows();
    expect(segs()).toHaveLength(doc.state.tracks.length);
  });

  it('toggles mute from the header as one undo step and updates the button', () => {
    const { view, doc } = ctx;
    const btn = view.el.querySelector('.mt-th .mt-tb-mute');
    btn.click();
    expect(doc.state.tracks[0].mute).toBe(true);
    expect(doc.history.undoLabel).toBe('Mute On');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    doc.history.undo();
    expect(view.el.querySelector('.mt-th .mt-tb-mute').getAttribute('aria-pressed')).toBe('false');
  });

  it('changes track volume from the keyboard on the readout', () => {
    const { view, doc } = ctx;
    const hot = view.el.querySelector('.mt-th .hot');
    hot.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    hot.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(doc.state.tracks[0].volume).toBeCloseTo(0.2);
    expect(doc.history.entries.filter((e) => e.label === 'Track Volume')).toHaveLength(2);
  });

  it('renames a track from its name field', () => {
    const { view, doc } = ctx;
    const input = view.el.querySelector('.mt-th-name');
    input.value = 'Vocals';
    input.dispatchEvent(new Event('change'));
    expect(doc.state.tracks[0].name).toBe('Vocals');
  });

  it('hit-tests clip regions and empty lanes', () => {
    const { view, clip } = ctx;
    const r = view.clipRects().find((q) => q.clip.id === clip.id);
    expect(r.x0).toBeCloseTo(100);
    expect(r.x1).toBeCloseTo(300);
    expect(view.hitTest(150, r.y + 8).part).toBe('header');
    expect(view.hitTest(r.x0 + 1, r.y + 60).part).toBe('edgeIn');
    expect(view.hitTest(r.x1 - 1, r.y + 60).part).toBe('edgeOut');
    expect(view.hitTest(r.x0 + 4, r.y + 7).part).toBe('fadeIn');
    expect(view.hitTest(200, r.y + 90).part).toBe('body');
    expect(view.hitTest(600, r.y + 60).part).toBe('empty');
    const envY = r.wy + 2 + 0.5 * (r.wh - 4);
    expect(view.hitTest(200, envY)).toMatchObject({ part: 'line', param: 'volume' });
  });

  it('reorders tracks by dragging headers past hidden tracks', () => {
    const { view, doc } = ctx;
    const [t1, t2, t3] = doc.state.tracks.map((t) => t.id);
    doc.amendView((st) => S.updateTrack(st, t1, { hidden: true }));
    view.syncHeaders();
    // Rows: Track 2, Track 3, Mix. Drop Track 2 below Track 3.
    const r3 = view.rowOf(t3);
    view.showReorder(t2, r3.top + r3.total - 2);
    view.finishReorder(t2, r3.top + r3.total - 2);
    expect(doc.state.tracks.map((t) => t.id)).toEqual([t1, t3, t2]);
    // And back above Track 3: it lands right before it, after the hidden track.
    view.syncHeaders();
    const top = view.rowOf(t3).top;
    view.showReorder(t2, top + 2);
    view.finishReorder(t2, top + 2);
    expect(doc.state.tracks.map((t) => t.id)).toEqual([t1, t2, t3]);
  });

  it('Tab skips clips on hidden tracks', () => {
    const { view, doc, clip } = ctx;
    const t2 = doc.state.tracks[1].id;
    const hidden = S.createClip({ trackId: t2, sourceId: clip.sourceId, name: 'hidden', start: RATE * 2, length: RATE });
    const later = S.createClip({ trackId: doc.state.tracks[2].id, sourceId: clip.sourceId, name: 'later', start: RATE * 3, length: RATE });
    doc.apply('Add', S.addClips(doc.state, [hidden, later]));
    doc.amendView((st) => S.updateTrack(st, t2, { hidden: true }));
    view.syncHeaders();
    const tab = () => view.surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    tab();
    expect([...doc.selectedClips]).toEqual([clip.id]);
    tab();
    expect([...doc.selectedClips]).toEqual([later.id]);
  });

  it('drags a clip down past a hidden track onto the row under the pointer', () => {
    const { view, doc, clip, app } = ctx;
    app.prefs.set('snapping', false);
    doc.apply('Add Track', S.addTrack(doc.state, S.createTrack({ name: 'Track 4' })));
    const [, t2, t3] = doc.state.tracks.map((t) => t.id);
    doc.amendView((st) => S.updateTrack(st, t2, { hidden: true }));
    view.syncHeaders();
    view.surface.setPointerCapture = () => {};
    const pointer = (type, x, y) => view.surface.dispatchEvent(Object.assign(new Event(type, { bubbles: true }), { clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse' }));
    const r = view.clipRects().find((q) => q.clip.id === clip.id);
    const target = view.rowOf(t3);
    pointer('pointerdown', 200, r.y + 60);
    pointer('pointermove', 210, r.y + 60);
    pointer('pointermove', 200, target.top + 60);
    pointer('pointerup', 200, target.top + 60);
    expect(S.findClip(doc.state, clip.id)).toMatchObject({ trackId: t3, start: clip.start });
  });

  it('snaps to clip edges and the playhead within eight pixels', () => {
    const { view, app } = ctx;
    app.prefs.set('snap', { ruler: false, markers: true, clips: true });
    expect(view.snap(RATE + view.fpp * 5)).toBe(RATE);
    expect(view.snap(RATE + view.fpp * 20)).toBe(Math.round(RATE + view.fpp * 20));
    app.prefs.set('snapping', false);
    expect(view.snap(RATE + 3)).toBe(RATE + 3);
  });

  it('runs clip commands: split at the playhead, nudge, delete and undo', async () => {
    const { app, doc, clip } = ctx;
    doc.selectClips([clip.id]);
    doc.setCursor(RATE * 2);
    await app.commands.run('clip.split');
    expect(doc.state.clips).toHaveLength(2);
    await app.commands.run('edit.selectAll');
    await app.commands.run('edit.delete');
    expect(doc.state.clips).toHaveLength(0);
    await app.commands.run('edit.undo');
    expect(doc.state.clips).toHaveLength(2);
    doc.selectClips([doc.state.clips[1].id]);
    const before = doc.state.clips[1].start;
    await app.commands.run('clip.nudgeRight');
    expect(doc.state.clips.find((c) => c.start > before)).toBeTruthy();
  });

  it('copies and pastes clips at the playhead on the selected track', async () => {
    const { app, doc, clip } = ctx;
    doc.selectClips([clip.id]);
    await app.commands.run('edit.copy');
    doc.selectTrack(doc.state.tracks[2].id);
    doc.setCursor(RATE * 5);
    await app.commands.run('edit.paste');
    const pasted = doc.state.clips.find((c) => c.id !== clip.id);
    expect(pasted).toMatchObject({ trackId: doc.state.tracks[2].id, start: RATE * 5, length: RATE * 2 });
  });

  it('copies the clip parts in the time selection onto the selected track', async () => {
    const { app, doc, clip } = ctx;
    const [t1, t2, t3] = doc.state.tracks.map((t) => t.id);
    const other = S.createClip({ trackId: t2, sourceId: clip.sourceId, name: 'late', start: RATE * 4, length: RATE });
    doc.apply('Add', S.addClips(doc.state, [other]));
    // Both clips selected, but the time selection only covers the one on Track 2.
    doc.selectClips([clip.id, other.id]);
    doc.setSelection(RATE * 4, RATE * 5, { tracks: [t1, t2] });
    await app.commands.run('edit.copy');
    doc.setSelection(RATE * 8, RATE * 8);
    doc.selectTrack(t3);
    doc.setCursor(RATE * 8);
    await app.commands.run('edit.paste');
    const pasted = doc.state.clips.filter((c) => c.id !== clip.id && c.id !== other.id);
    expect(pasted.map((c) => [c.trackId, c.start, c.length])).toEqual([[t3, RATE * 8, RATE]]);
  });

  it('ripple deletes the time selection across all tracks', async () => {
    const { app, doc } = ctx;
    doc.setSelection(0, RATE / 2);
    await app.commands.run('edit.rippleTimeAll');
    expect(doc.state.clips[0].start).toBe(RATE / 2);
  });

  it('adds tracks and buses after the selected track and routes to buses', async () => {
    const { app, doc } = ctx;
    doc.selectTrack(doc.state.tracks[0].id);
    await app.commands.run('mt.addBus');
    expect(doc.state.tracks[1].type).toBe('bus');
    await app.commands.run('mt.setTrackOutput', { id: doc.state.tracks[0].id, output: doc.state.tracks[1].id });
    expect(doc.state.tracks[0].output).toBe(doc.state.tracks[1].id);
    const sel = document.querySelector('.mt-th select[aria-label="Track output"]');
    expect([...sel.options].map((o) => o.textContent)).toContain('Bus A');
  });

  it('switches tools per editor and reports available tools', () => {
    const { app } = ctx;
    expect(app.toolAvailable('razor')).toBe(true);
    expect(app.toolAvailable('heal')).toBe(false);
    expect(app.commands.isEnabled('tool.slip')).toBe(true);
  });
});

describe('mixer panel', () => {
  it('shows a strip per track and the master, with a keyboard fader', () => {
    const { app, doc } = setup();
    const panel = mixerPanel(app);
    document.body.append(panel.el);
    panel.show();
    const strips = panel.el.querySelectorAll('.mx-strip');
    expect(strips).toHaveLength(doc.state.tracks.length + 1);
    expect(panel.el.querySelector('.mx-master .mx-strip')).toBeTruthy();
    const f = strips[0].querySelector('.mx-fader');
    f.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
    expect(doc.state.tracks[0].volume).toBe(-3);
    expect(f.getAttribute('aria-valuetext')).toBe('-3.0 dB');
    strips[1].querySelector('.mt-tb-solo').click();
    expect(doc.state.tracks[1].solo).toBe(true);
  });

  it('has polarity, automation mode and collapsible sections', () => {
    const { app, doc } = setup();
    const panel = mixerPanel(app);
    document.body.append(panel.el);
    panel.show();
    const strip = panel.el.querySelector('.mx-strip');
    strip.querySelector('.mt-tb-invert').click();
    expect(doc.state.tracks[0].invert).toBe(true);
    expect(doc.history.undoLabel).toBe('Invert Polarity On');
    expect(strip.querySelector('.mt-tb-invert').getAttribute('aria-pressed')).toBe('true');
    const mode = strip.querySelector('.mx-mode');
    mode.value = 'touch';
    mode.dispatchEvent(new Event('change'));
    expect(doc.state.tracks[0].mode).toBe('touch');
    // The gutter collapses a section in every strip and remembers it.
    const btn = panel.el.querySelector(".mx-gutter-btn[data-sec='sends']");
    btn.click();
    expect(app.prefs.get('mixerCollapsed')).toEqual(['sends']);
    expect(panel.el.classList.contains('mx-hide-sends')).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    btn.click();
    expect(panel.el.classList.contains('mx-hide-sends')).toBe(false);
    panel.el.remove();
  });

  it('turns a single track effect on and off from its strip', () => {
    const { app, doc } = setup();
    const id = doc.state.tracks[0].id;
    doc.apply('Track Effects', S.updateTrack(doc.state, id, { fx: [null, { id: 'e1', effect: 'amplify', values: {}, enabled: true }] }));
    const panel = mixerPanel(app);
    document.body.append(panel.el);
    panel.show();
    const strip = panel.el.querySelector('.mx-strip');
    expect([...strip.querySelectorAll('.mx-fx-slot')]).toHaveLength(4);
    strip.querySelector('.mx-fx-power').click();
    expect(doc.state.tracks[0].fx[1].enabled).toBe(false);
    expect(doc.history.undoLabel).toBe('Effect Off');
    expect(panel.el.querySelector('.mx-strip .mx-fx-slot').classList.contains('off')).toBe(true);
    panel.el.querySelector('.mx-strip .mx-fx-power').click();
    expect(doc.state.tracks[0].fx[1].enabled).toBe(true);
    panel.el.remove();
  });

  it('fader keys reach silence and back', () => {
    const changes = [];
    const el = fader({ value: -59, label: 'Test', onChange: (v) => changes.push(v) });
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' }));
    expect(changes.pop()).toBe(S.SILENT_DB);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(changes.pop()).toBe(-60);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: '0' }));
    expect(changes.pop()).toBe(0);
  });
});

describe('session properties', () => {
  it('edits the selected clip and track', () => {
    const { app, doc, clip } = setup();
    doc.selectClips([clip.id]);
    const el = sessionPropertySection(app, doc);
    const gain = el.querySelector('input[aria-label="Clip gain in dB"]');
    gain.value = '-6';
    gain.dispatchEvent(new Event('change'));
    expect(S.findClip(doc.state, clip.id).gain).toBe(-6);
    const loop = [...el.querySelectorAll('label.check')].find((l) => l.textContent === 'Loop').querySelector('input');
    loop.checked = true;
    loop.dispatchEvent(new Event('change'));
    expect(S.findClip(doc.state, clip.id).loop).toBe(true);
    expect(el.textContent).toContain('Stretch');
    expect([...el.querySelectorAll('.prop-row')].find((r) => r.textContent.startsWith('Stretch')).textContent).toBe('StretchOff');
    doc.apply('Stretch', S.updateClips(doc.state, [clip.id], { stretch: { mode: 'rendered', ratio: 1.25, semitones: -3, formants: false, sourceId: clip.sourceId } }));
    const stretched = sessionPropertySection(app, doc);
    expect([...stretched.querySelectorAll('.prop-row')].find((r) => r.textContent.startsWith('Stretch')).textContent).toBe('StretchRendered, 125% -3 st');
    const channels = (e) => [...e.querySelectorAll('.prop-row')].find((r) => r.textContent.startsWith('Channels')).textContent;
    expect(channels(el)).toBe('ChannelsStereo');
    doc.apply('Surround', S.updateTrack(doc.state, doc.state.tracks[1].id, { channels: 6 }));
    doc.selectTrack(doc.state.tracks[1].id);
    expect(channels(sessionPropertySection(app, doc))).toBe('Channels5.1');
    const name = el.querySelector('input[aria-label="Track name"]');
    name.value = 'Lead';
    name.dispatchEvent(new Event('change'));
    expect(doc.state.tracks[0].name).toBe('Lead');
  });
});

describe('automation writing', () => {
  it('records knob moves during playback in Touch mode as one undo step', () => {
    const { app, doc } = setup();
    const id = doc.state.tracks[0].id;
    doc.apply('Mode', S.updateTrack(doc.state, id, { mode: 'touch' }));
    let pos = 0;
    Object.defineProperty(app.engine, 'playing', { get: () => true, configurable: true });
    Object.defineProperty(app, 'playhead', { get: () => pos, configurable: true });
    const c = doc.controls;
    const steps = doc.history.entries.length;
    pos = 1000;
    c.set(id, 'volume', -3, 'input');
    pos = 20000;
    c.set(id, 'volume', -9, 'input');
    pos = 30000;
    c.set(id, 'volume', -9, 'change');
    expect(doc.overrides[id]?.volume).toBeUndefined();
    c.commit(40000);
    delete app.engine.playing;
    const lane = S.findTrack(doc.state, id).automation.volume;
    expect(doc.history.entries.length).toBe(steps + 1);
    expect(doc.history.undoLabel).toBe('Write Automation');
    // Recorded from the first move to the release, back to the track's own level on either side.
    expect(lane[0]).toEqual({ t: 999, v: 0 });
    expect(lane[1]).toEqual({ t: 1000, v: -3 });
    expect(lane[lane.length - 2]).toEqual({ t: 30000, v: -9 });
    expect(lane[lane.length - 1]).toEqual({ t: 30001, v: 0 });
    expect(S.findTrack(doc.state, id).volume).toBe(0);
  });

  it('keeps every touch of a control during one playback in Touch mode', () => {
    const { app, doc } = setup();
    const id = doc.state.tracks[0].id;
    doc.apply('Mode', S.updateTrack(doc.state, id, { mode: 'touch' }));
    let pos = 0;
    Object.defineProperty(app.engine, 'playing', { get: () => true, configurable: true });
    Object.defineProperty(app, 'playhead', { get: () => pos, configurable: true });
    const c = doc.controls;
    pos = 1000;
    c.set(id, 'volume', -3, 'input');
    pos = 5000;
    c.set(id, 'volume', -6, 'change');
    pos = 20000;
    c.set(id, 'volume', -12, 'input');
    pos = 25000;
    c.set(id, 'volume', -15, 'change');
    c.commit(40000);
    delete app.engine.playing;
    const lane = S.findTrack(doc.state, id).automation.volume;
    expect(lane[1]).toEqual({ t: 1000, v: -3 });
    expect(lane).toContainEqual({ t: 5000, v: -6 });
    expect(lane).toContainEqual({ t: 20000, v: -12 });
    expect(lane[lane.length - 2]).toEqual({ t: 25000, v: -15 });
    // Between and after the touches the track is back at its own level.
    expect(S.envelopeValue(lane, 12000)).toBe(0);
    expect(lane[lane.length - 1]).toEqual({ t: 25001, v: 0 });
  });

  it('sets a keyframe at the playhead when stopped with automation', () => {
    const { doc } = setup();
    const id = doc.state.tracks[0].id;
    doc.apply('Auto', S.setAutomation(doc.state, id, 'volume', [{ t: 0, v: 0 }]));
    doc.setCursor(RATE);
    doc.controls.set(id, 'volume', -6, 'change');
    expect(S.findTrack(doc.state, id).automation.volume).toEqual([{ t: 0, v: 0 }, { t: RATE, v: -6 }]);
    expect(doc.controls.value(S.findTrack(doc.state, id), 'volume', RATE / 2)).toBe(-3);
  });
});
