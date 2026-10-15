import { describe, expect, it } from 'vitest';
import { parseAddonInfo, addonId, addonLang } from '../../src/prefs/addons_core';

describe('add-on metadata', () => {
  it('reads bl_info from Python without running it', () => {
    const src = `bl_info = {\n    "name": "Tidy Tools",\n    "author": "Someone",\n    "version": (1, 2, 0),\n    "category": "Mesh",\n    "description": "Cleans up \\"things\\"",\n}\nimport bpy\n`;
    expect(parseAddonInfo(src, 'tidy.py')).toEqual({ name: 'Tidy Tools', author: 'Someone', version: '1.2.0', category: 'Mesh', description: 'Cleans up "things"' });
    expect(addonLang('tidy.py', src)).toBe('python');
  });

  it('reads a JavaScript bl_info object and falls back to the file name', () => {
    const src = `const bl_info = { name: 'Scatter', version: [2, 1], category: 'Object' };\nfunction register() {}`;
    expect(parseAddonInfo(src, 'scatter.js')).toMatchObject({ name: 'Scatter', version: '2.1', category: 'Object', author: '' });
    expect(parseAddonInfo('function register() {}', 'my-cool_addon.js')).toMatchObject({ name: 'my cool addon', category: 'User' });
    expect(addonLang('x.js', src)).toBe('javascript');
    expect(addonLang('noext', 'import bpy\ndef register():\n  pass')).toBe('python');
  });

  it('derives module ids from file names', () => {
    expect(addonId('My Add-on v2.py')).toBe('my_add_on_v2');
    expect(addonId('.js')).toBe('addon');
  });
});
