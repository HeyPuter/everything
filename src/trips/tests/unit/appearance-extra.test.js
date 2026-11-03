import { describe, expect, it } from 'vitest';
import { applyAppearance, cleanPrefs, defaultPrefs, orderTabs } from '../../src/lib/prefs.js';

const routes = [{ id: 'dashboard' }, { id: 'preview' }, { id: 'settings' }, { id: 'atlas' }, { id: 'week' }];

describe('appearance [2] preferences', () => {
  it('validate density, accent and tab order', () => {
    expect(defaultPrefs('en-GB')).toMatchObject({ density: 'comfortable', accent: 'blue', tabOrder: [] });
    expect(cleanPrefs({ density: 'compact', accent: 'teal', tabOrder: ['week', 'dashboard', 'week', 'Bad Id'] })).toEqual({ density: 'compact', accent: 'teal', tabOrder: ['week', 'dashboard'] });
    expect(cleanPrefs({ density: 'tiny', accent: 'gold', tabOrder: 'week' })).toEqual({});
  });

  it('set the root attributes, leaving the defaults unmarked', () => {
    const root = document.createElement('html');
    applyAppearance({ textSize: 1, contrast: 'normal', motion: 'system', density: 'compact', accent: 'rose' }, root);
    expect(root.dataset).toMatchObject({ density: 'compact', accent: 'rose' });
    applyAppearance({ textSize: 1, contrast: 'normal', motion: 'system', density: 'comfortable', accent: 'blue' }, root);
    expect(root.dataset.density).toBeUndefined();
    expect(root.dataset.accent).toBeUndefined();
  });

  it('order phone tabs by preference, then registry order for the rest', () => {
    expect(orderTabs(routes, { tabOrder: ['week', 'atlas'] }).map((item) => item.id)).toEqual(['week', 'atlas', 'dashboard', 'preview', 'settings']);
    expect(orderTabs(routes, { tabOrder: ['gone', 'settings'] }).map((item) => item.id)).toEqual(['settings', 'dashboard', 'preview', 'atlas', 'week']);
    expect(orderTabs(routes, { tabOrder: [] }).map((item) => item.id)).toEqual(routes.map((item) => item.id));
  });
});
