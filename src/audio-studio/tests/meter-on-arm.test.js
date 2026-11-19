import { expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { Session } from '../src/model/session.js';
import * as S from '../src/model/session-edits.js';
import { installPreferences } from '../src/features/preferences.js';

function setup() {
  localStorage.clear();
  const app = new App();
  app.syncGraph = () => {};
  const toggle = vi.fn(() => (app.inputMetering = !app.inputMetering));
  app.commands.register([{ id: 'transport.meterInput', label: 'Meter Input Signal', run: toggle }]);
  installPreferences(app);
  const doc = app.addDocument(new Session({ name: 'S.asesx', sampleRate: 1000, tracks: 2 }));
  const arm = (i, on) => doc.apply('Arm', S.updateTrack(doc.state, doc.state.tracks[i].id, { arm: on }));
  return { app, doc, toggle, arm };
}

it('meters the input from the first armed track until the last is disarmed', () => {
  const { app, toggle, arm } = setup();
  arm(0, true);
  expect(app.inputMetering).toBe(true);
  arm(1, true);
  arm(0, false);
  expect(toggle).toHaveBeenCalledTimes(1);
  arm(1, false);
  expect(app.inputMetering).toBe(false);
  expect(toggle).toHaveBeenCalledTimes(2);
});

it('leaves metering switched on by hand alone, and does nothing when turned off', () => {
  const { app, toggle, arm } = setup();
  app.inputMetering = true;
  arm(0, true);
  arm(0, false);
  expect(app.inputMetering).toBe(true);
  expect(toggle).not.toHaveBeenCalled();
  app.inputMetering = false;
  app.prefs.set('meterOnArm', false);
  arm(0, true);
  expect(toggle).not.toHaveBeenCalled();
});
