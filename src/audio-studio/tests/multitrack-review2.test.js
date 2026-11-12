// Regression tests for multitrack fixes from the second pass of the adversarial review.
import { describe, it, expect } from 'vitest';
import * as S from '../src/model/session-edits.js';
import { remixClip, unremixClip, revertRemixes } from '../src/model/clip-remix.js';

describe('reverting part of a remixed clip', () => {
  const segs = [
    [100, 400],
    [200, 500],
    [700, 1000],
  ];
  const remixed = () =>
    remixClip(
      S.createClip({
        trackId: 't',
        sourceId: 'orig',
        start: 300,
        offset: 100,
        length: 500,
        fadeOut: { length: 80, curve: 0 },
      }),
      { target: 900 },
      segs,
      'k',
    );

  it('returns each piece of a split remix to its own share of the original, without duplicating it', () => {
    let s = S.addClips(S.createSessionState({ tracks: 0 }), [remixed()]);
    s = S.splitClips(s, null, 300 + 450);
    const [left, right] = s.clips;
    const back = revertRemixes(s, [left.id, right.id]);
    const [l, r] = back.clips;
    expect(l).toMatchObject({
      sourceId: 'orig',
      start: 300,
      offset: 100,
      length: 250,
      remix: null,
    });
    expect(r).toMatchObject({
      sourceId: 'orig',
      start: 750,
      offset: 350,
      length: 250,
      remix: null,
    });
    // Together they hold the original range once.
    expect(l.offset + l.length).toBe(r.offset);
    expect(r.offset + r.length).toBe(600);
    expect(r.fadeOut.length).toBe(80);
    // A whole remixed clip still goes back to the whole original range.
    expect(unremixClip(remixed())).toMatchObject({ offset: 100, length: 500 });
  });
});

describe('Write automation during loop playback', () => {
  it('writes every pass that played, not only from the start to where playback stopped', async () => {
    const { Emitter } = await import('../src/lib/emitter.js');
    const { Session } = await import('../src/model/session.js');
    const { TrackControls } = await import('../src/multitrack/track-controls.js');
    for (const mode of ['write', 'latch']) {
      const doc = new Session({ name: 'A.asesx', tracks: 1, sampleRate: 1000 });
      const t = doc.state.tracks[0];
      doc.apply(
        'Setup',
        S.setAutomation(S.updateTrack(doc.state, t.id, { mode }), t.id, 'volume', [
          { t: 0, v: -3 },
        ]),
      );
      const app = new Emitter();
      app.engine = { playing: true, range: { loop: { start: 1000, end: 2000 } } };
      app.active = doc;
      app.playhead = 1500;
      app.syncGraph = () => {};
      const tc = new TrackControls(app, doc);
      tc.begin();
      app.playhead = 1600;
      tc.set(t.id, 'volume', -10, 'change');
      // Playback goes on looping with nothing touched, then stops early in a pass.
      for (const f of [1800, 1990, 1100, 1500, 1990, 1050, 1200]) tc.follow(f);
      tc.commit(1200);
      const lane = S.findTrack(doc.state, t.id).automation.volume;
      for (const f of [1050, 1300, 1700, 1990])
        expect(S.envelopeValue(lane, f)).toBeCloseTo(-10, 6);
      // Outside the loop the lane is as it was.
      expect(S.envelopeValue(lane, 500)).toBeCloseTo(-3, 6);
      expect(S.envelopeValue(lane, 2500)).toBeCloseTo(-3, 6);
    }
  });
});

describe('Write automation and seeks', () => {
  it('does not write past where playback was when it jumped back by a seek', async () => {
    const { Emitter } = await import('../src/lib/emitter.js');
    const { Session } = await import('../src/model/session.js');
    const { TrackControls } = await import('../src/multitrack/track-controls.js');
    const doc = new Session({ name: 'A.asesx', tracks: 1, sampleRate: 1000 });
    const t = doc.state.tracks[0];
    doc.apply(
      'Setup',
      S.setAutomation(S.updateTrack(doc.state, t.id, { mode: 'write' }), t.id, 'volume', [
        { t: 0, v: -3 },
      ]),
    );
    const app = new Emitter();
    app.engine = { playing: true, range: { loop: { start: 0, end: 10000 } } };
    app.active = doc;
    app.playhead = 1000;
    app.syncGraph = () => {};
    const tc = new TrackControls(app, doc);
    tc.begin();
    app.playhead = 1100;
    tc.set(t.id, 'volume', -10, 'change');
    // Seek back from 3000 to 2000, play on to 2500.
    for (const f of [2000, 3000, 2000, 2500]) tc.follow(f);
    tc.commit(2500);
    const lane = S.findTrack(doc.state, t.id).automation.volume;
    expect(S.envelopeValue(lane, 2800)).toBeCloseTo(-10, 6);
    expect(S.envelopeValue(lane, 5000)).toBeCloseTo(-3, 6);
  });
});

describe('Mixer panel in a short frame', () => {
  it('scrolls vertically to the faders instead of cutting them off', async () => {
    const fs = await import('node:fs');
    const css = fs.readFileSync(`${import.meta.dirname}/../src/styles/multitrack.css`, 'utf8');
    const panel = css.match(/\.mixer-panel \{[^}]*\}/)[0];
    expect(panel).toMatch(/overflow-y: auto;/);
    expect(panel).toMatch(/align-items: flex-start;/);
    expect(css).toMatch(
      /\.mixer-panel > \.mx-strips,\s*\.mixer-panel > \.mx-master \{\s*min-height: 100%;/,
    );
  });
});

describe('multitrack stylesheet', () => {
  it('closes every rule, so the remix dialog styles apply outside the EQ curve', async () => {
    const fs = await import('node:fs');
    const css = fs
      .readFileSync(`${import.meta.dirname}/../src/styles/multitrack.css`, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    let depth = 0;
    for (const ch of css) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
    expect(css).toMatch(/\.mx-eq-curve \{[^{}]*cursor: pointer;\s*\}/);
  });
});

describe('session templates with buses of the same name', () => {
  it('keep each output and send on the bus it used', async () => {
    const { templateFromState, stateFromTemplate } = await import('../src/multitrack/templates.js');
    let s = S.createSessionState({
      tracks: 0,
      template: [{ name: 'Vox' }, { name: 'FX', type: 'bus' }, { name: 'FX', type: 'bus' }],
    });
    const [vox, fx1, fx2] = s.tracks;
    s = S.updateTrack(s, vox.id, { output: fx2.id });
    s = S.setSend(s, vox.id, 0, { target: fx2.id, level: -6 });
    s = S.updateTrack(s, fx1.id, { output: fx2.id });
    const t = JSON.parse(JSON.stringify(templateFromState(s, 'Dup')));
    const n = stateFromTemplate(t, { sampleRate: 48000, bitDepth: 32, autoCrossfade: true });
    const [v, b1, b2] = n.tracks;
    expect(v.output).toBe(b2.id);
    expect(v.sends[0].target).toBe(b2.id);
    expect(b1.output).toBe(b2.id);
    expect(b2.output).toBe('master');
  });
});

describe('keyboard focus in track headers and Mixer strips', () => {
  it('selects the track, as a click does', async () => {
    HTMLCanvasElement.prototype.getContext = () => null;
    if (!globalThis.ResizeObserver) {
      globalThis.ResizeObserver = class {
        observe() {}
        disconnect() {}
      };
    }
    localStorage.clear();
    const { App } = await import('../src/app.js');
    const { installCore } = await import('../src/features/core.js');
    const { installMultitrack } = await import('../src/features/multitrack.js');
    const { Session } = await import('../src/model/session.js');
    const { mixerPanel } = await import('../src/panels/mixer.js');
    const app = new App();
    installCore(app);
    installMultitrack(app);
    app.syncGraph = () => {};
    const doc = new Session({ name: 'K.asesx', sampleRate: 48000, tracks: 3 });
    app.addDocument(doc);
    const view = app.documentKinds.get('session').view(app, doc);
    const mixer = mixerPanel(app);
    document.body.replaceChildren(view.el, mixer.el);
    mixer.show();
    const [t0, t1, t2] = doc.state.tracks.map((t) => t.id);
    expect(doc.selectedTrack).toBe(t0);
    view.headers.get(t1).volNum.focus();
    expect(doc.selectedTrack).toBe(t1);
    mixer.el.querySelector(`.mx-strip[data-id="${t2}"] .mx-fader`).focus();
    expect(doc.selectedTrack).toBe(t2);
  });
});
