import { describe, it, expect } from 'vitest';
import { paramControls } from '../src/effects/param-ui.js';
import { numberField } from '../src/effects/layout.js';
import { coerce } from '../src/effects/params.js';
import { ratioField, parseClock } from '../src/effects/views/time-pitch.js';
import { beatsField } from '../src/effects/time-units.js';
import { openEffectDialog } from '../src/effects/dialog.js';
import { getEffect } from '../src/effects/index.js';
import { Session } from '../src/model/session.js';
import { fakeApp } from './fx-helpers.js';
import { userPresets } from '../src/effects/presets.js';
import { effectsRackPanel, rackPresets, saveRackPreset } from '../src/effects/rack-panel.js';
import { createRack } from '../src/effects/rack.js';

/** Opens a value field for typing and commits it unchanged; returns the text it offered. */
const commitUnchanged = (el) => {
  el.querySelector('.hot').dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
  );
  const input = el.querySelector('.hot-edit');
  const text = input.value;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return text;
};

describe('value fields opened for typing', () => {
  const cases = [
    [{ id: 'f', min: 20, max: 20000, step: 1, default: 1000, unit: 'Hz', scale: 'log' }, 1234],
    [{ id: 'f', min: 20, max: 20000, step: 1, default: 1000, unit: 'Hz' }, 12345],
    [{ id: 't', min: 0, max: 5000, step: 1, default: 100, unit: 'ms' }, 1234],
    [{ id: 't', min: 0.1, max: 5000, step: 0.1, default: 100, unit: 'ms', scale: 'log' }, 1234.5],
  ];
  it.each(cases)('keep a %o value that kHz or seconds display rounds (%d)', (p, v) => {
    const def = { id: 'probe', name: 'Probe', params: [{ label: 'Value', ...p }] };
    let values = { [p.id]: v };
    const c = paramControls(
      def,
      () => values,
      (id, x) => {
        values = { ...values, [id]: coerce(def.params[0], x) };
        c.refresh(values, id);
      },
    );
    document.body.append(c.el);
    // Clicking the value and pressing Enter (or clicking away) used to commit "1.23 kHz".
    expect(commitUnchanged(c.el)).toBe(String(v));
    expect(values[p.id]).toBe(v);
    c.el.remove();
  });

  it('keep the value in hand-laid-out dialogs too', () => {
    const p = {
      id: 'f',
      label: 'Frequency',
      min: 20,
      max: 20000,
      step: 1,
      default: 1000,
      unit: 'Hz',
    };
    let values = { f: 1234 };
    const subs = [];
    const ctx = {
      def: { params: [p] },
      get values() {
        return values;
      },
      set: (id, v) => {
        values = { ...values, [id]: coerce(p, v) };
        subs.forEach((fn) => fn(values));
      },
      subscribe: (fn) => subs.push(fn),
    };
    const wrap = document.createElement('div');
    wrap.append(numberField(ctx, 'f'));
    document.body.append(wrap);
    commitUnchanged(wrap);
    expect(values.f).toBe(1234);
    wrap.remove();
  });

  it('still start from the display text when it reads back exactly', () => {
    const p = { id: 'g', label: 'Gain', min: -24, max: 24, step: 0.1, default: 0, unit: 'dB' };
    let values = { g: -3 };
    const c = paramControls(
      { id: 'probe', name: 'Probe', params: [p] },
      () => values,
      (id, x) => {
        values = { ...values, [id]: coerce(p, x) };
        c.refresh(values, id);
      },
    );
    document.body.append(c.el);
    expect(commitUnchanged(c.el)).toBe('-3.0');
    c.el.remove();
    // A value between steps (a delay time restated in beats) offers its display text.
    const q = { id: 'b', label: 'Beats', min: 0, max: 4, step: 0.001, default: 1, unit: 'beats' };
    const d = paramControls(
      { id: 'probe', name: 'Probe', params: [q] },
      () => ({ b: 0.2216667 }),
      () => {},
    );
    document.body.append(d.el);
    expect(commitUnchanged(d.el)).toBe('0.222');
    d.el.remove();
  });
});

describe('custom value fields with a decimal comma', () => {
  const typeInto = (el, text) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const input = document.querySelector('.hot-edit');
    input.value = text;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  };
  const ctxFor = (params, initial) => {
    let values = { ...initial };
    const subs = [];
    return {
      def: { params },
      get values() {
        return values;
      },
      set: (id, v) => {
        values = { ...values, [id]: v };
        subs.forEach((fn) => fn(values));
      },
      subscribe: (fn) => subs.push(fn),
    };
  };

  it('read "1,5" as 1.5 in the Pitch Shifter ratio', () => {
    const ctx = ctxFor([], { semitones: 0, cents: 0 });
    const hot = ratioField(ctx);
    document.body.append(hot);
    // The comma was dropped: "1,5" read as 15, limited to a ratio of 4 (+24 semitones).
    typeInto(hot, '1,5');
    expect(ctx.values).toMatchObject({ semitones: 7, cents: 2 });
    hot.remove();
  });

  it('read "1,5" as 1.5 beats in Tempo Sync', () => {
    const p = { id: 'rate', label: 'Rate', min: 0.01, max: 10, default: 1, unit: 'Hz' };
    const ctx = ctxFor([p], { rate: 1 });
    ctx.app = { timeOptions: () => ({ tempo: 120, beatNote: 4 }) };
    const el = beatsField(ctx, 'rate');
    document.body.append(el);
    typeInto(el.querySelector('.hot'), '1,5');
    // 1.5 beats at 120 BPM (500 ms a beat) is one sweep per 750 ms.
    expect(ctx.values.rate).toBeCloseTo(1000 / 750, 6);
    el.remove();
  });

  it('read a decimal comma in typed durations', () => {
    expect(parseClock('0:02,5')).toBe(2.5);
    expect(parseClock('2,5')).toBe(2.5);
    expect(parseClock('1:02.5')).toBe(62.5);
  });
});

describe('effect dialogs for session chains', () => {
  it('preview by playing the session', async () => {
    const app = fakeApp();
    const doc = new Session({ name: 'S', sampleRate: 48000, tracks: 2 });
    doc.setSelection(4800, 9600);
    app.active = doc;
    const plays = [];
    app.play = (o) => plays.push(o);
    // A track's effect slot (rack.js) or track EQ: edit mode, no audio file.
    const p = openEffectDialog(app, getEffect('studioReverb'), {
      mode: 'edit',
      onChange: () => {},
    });
    const dlg = [...document.querySelectorAll('.fx-dialog')].at(-1);
    const play = dlg.querySelector('.fx-play');
    // There was no way to hear the chain: Preview was off and the dialog holds the keyboard.
    expect(play.disabled).toBe(false);
    play.click();
    expect(plays).toEqual([{ from: 4800, loop: true }]);
    expect(play.getAttribute('aria-label')).toBe('Stop preview');
    dlg.querySelector('.dialog-head .icon-btn').click();
    expect(await p).toBeNull();
  });
});

describe('slot lists of chains without empty slots (clip effects)', () => {
  it('focus, announce and open the slot the effect lands in', async () => {
    const { createRackEditor, makeSlot } = await import('../src/effects/rack.js');
    const app = fakeApp();
    app.prefs.set('fxOpenOnAdd', true);
    let menus = 0;
    let menu = null;
    app.openMenu = (items) => {
      menus++;
      menu = items;
    };
    // A clip chain closes up: an effect chosen for slot 5 becomes the second.
    let slots = [makeSlot('amplify')];
    const ed = createRackEditor({
      app,
      getSlots: () => slots,
      setSlots: (next) => (slots = next.filter(Boolean)),
    });
    const live = document.createElement('div');
    live.id = 'live-region';
    document.body.append(ed.el, live);
    ed.chooser(4);
    menu
      .flatMap((g) => g.items || [])
      .find((it) => it.label === 'Studio Reverb')
      .run();
    await new Promise((r) => setTimeout(r, 50));
    expect(slots.map((s) => s.effect)).toEqual(['amplify', 'studioReverb']);
    expect(live.textContent).toBe('Studio Reverb added to slot 2');
    // The new effect's settings open (the slot menu used to open again on the empty slot 5).
    const dlg = [...document.querySelectorAll('.fx-dialog')].at(-1);
    expect(menus).toBe(1);
    expect(dlg?.querySelector('.dialog-title').textContent).toBe('Effect - Studio Reverb (Slot 2)');
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Close').click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => requestAnimationFrame(r));
    // The slot list's keyboard stop is the new effect, not the empty slot 5.
    const names = [...ed.el.querySelectorAll('.rack-name')];
    expect(names.findIndex((b) => b.tabIndex === 0)).toBe(1);
    // Moving the last effect down leaves it where it is, and its slot keeps the keyboard stop.
    names[1].dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(live.textContent).toBe('Moved to slot 2');
    expect([...ed.el.querySelectorAll('.rack-name')].findIndex((b) => b.tabIndex === 0)).toBe(1);
    ed.el.remove();
    live.remove();
  });
});

describe('saving a preset under a name in use', () => {
  const save = (bar, name) => {
    bar.querySelector('input').value = name;
    [...bar.querySelectorAll('button')].find((b) => b.textContent === 'Save').click();
  };

  it('asks before replacing an effect preset', async () => {
    const app = fakeApp();
    const done = openEffectDialog(app, getEffect('amplify'), { values: { left: 2, right: 2 } });
    const dlg = [...document.querySelectorAll('.fx-dialog')].at(-1);
    const saveBtn = dlg.querySelector('[aria-label="Save settings as a preset"]');
    saveBtn.click();
    const bar = dlg.querySelector('.fx-namebar');
    save(bar, 'My Preset');
    expect(userPresets(app.prefs, 'amplify').map((p) => p.values.left)).toEqual([2]);
    // Other settings saved under the default name again used to replace it without a word.
    const left = [...dlg.querySelectorAll('input[type=range]')].find(
      (i) => i.getAttribute('aria-label') === 'Left',
    );
    left.value = '5';
    left.dispatchEvent(new Event('input'));
    saveBtn.click();
    save(bar, 'My Preset');
    expect(userPresets(app.prefs, 'amplify').map((p) => p.values.left)).toEqual([2]);
    expect(bar.hidden).toBe(false);
    expect(bar.querySelector('.fx-name-error').textContent).toMatch(/already exists/);
    // Saving again confirms.
    save(bar, 'My Preset');
    expect(userPresets(app.prefs, 'amplify').map((p) => p.values.left)).toEqual([5]);
    expect(bar.hidden).toBe(true);
    dlg.querySelector('.dialog-head .icon-btn').click();
    await done;
  });

  it('asks before replacing a rack preset', () => {
    const app = fakeApp();
    saveRackPreset(app.prefs, 'Chain', { ...createRack(), mix: 0.5 });
    const panel = effectsRackPanel(app);
    app.active = { kind: 'audio', name: 'a.wav' };
    panel.show();
    document.body.append(panel.el);
    panel.el.querySelector('[aria-label="Save rack as a preset"]').click();
    const bar = panel.el.querySelector('.rack-namebar');
    save(bar, 'Chain');
    expect(rackPresets(app.prefs)[0].rack.mix).toBe(0.5);
    save(bar, 'Chain');
    expect(rackPresets(app.prefs)[0].rack.mix).toBe(1);
    panel.el.remove();
  });
});
