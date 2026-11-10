// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { StatusBar } from '../src/ui/statusbar.js';
import { App } from '../src/app.js';

afterEach(() => document.querySelectorAll('.menu').forEach((m) => m.remove()));

function bar(settings) {
  const app = { settings: { osnapModes: [], polarInc: 90, ...settings }, applySettings() {}, pushSettingsToCloud() {}, cmdline: { log() {} }, run() {} };
  app.setSetting = App.prototype.setSetting.bind(app);
  app.toggleSetting = App.prototype.toggleSetting.bind(app);
  const sb = new StatusBar(app);
  document.body.append(sb.el);
  return { app, sb };
}

describe('status bar menus', () => {
  it('turns Ortho off when a polar increment is picked', () => {
    const { app, sb } = bar({ ortho: true, polar: false });
    [...sb.el.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Polar tracking settings').click();
    [...document.querySelectorAll('.menu .menu-item')].find((b) => b.textContent.startsWith('45,')).click();
    sb.refresh();
    expect(app.settings).toMatchObject({ polar: true, ortho: false, polarInc: 45 });
    expect(sb.buttons.get('ortho').getAttribute('aria-pressed')).toBe('false');
    sb.el.remove();
  });
  it('keeps Ortho and Polar exclusive when toggled', () => {
    const { app, sb } = bar({ ortho: false, polar: true });
    app.toggleSetting('ortho');
    expect(app.settings).toMatchObject({ ortho: true, polar: false });
    app.toggleSetting('polar');
    expect(app.settings).toMatchObject({ ortho: false, polar: true });
    app.toggleSetting('polar');
    expect(app.settings).toMatchObject({ ortho: false, polar: false });
    sb.el.remove();
  });
});
