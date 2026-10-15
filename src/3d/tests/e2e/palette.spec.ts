import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

const rootVar = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

test('default palette: Default preset equals the built-in colours; every preset applies and switches back', async ({ page }) => {
  const errors = await openApp(page);
  const info = await page.evaluate(async () => {
    const t = await import('/src/prefs/themes.ts');
    const def = t.BUILTIN_THEMES.find((p) => p.id === 'DEFAULT')!;
    return {
      defaultMatches: JSON.stringify(t.presetValues(def)) === JSON.stringify(t.defaultValues()),
      presets: t.BUILTIN_THEMES.map((p) => ({ id: p.id, v: t.presetValues(p) })),
    };
  });
  expect(info.defaultMatches).toBe(true);
  const def = info.presets.find((p) => p.id === 'DEFAULT')!.v;
  // the default palette's key colours, as the interface draws them
  expect(await rootVar(page, '--c-region')).toBe(def.region);
  expect(await rootVar(page, '--accent')).toBe(def.accent);
  expect(def.region).toBe('#2d2e30');
  // X / Y / Z stay red / green / blue
  const ch = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [xr, xg, xb] = ch(def.x),
    [yr, yg, yb] = ch(def.y),
    [zr, zg, zb] = ch(def.z);
  expect(xr).toBeGreaterThan(Math.max(xg, xb) * 2);
  expect(yg).toBeGreaterThan(Math.max(yr, yb));
  expect(zb).toBeGreaterThan(Math.max(zr, zg));
  // selected and active objects stay clearly apart
  expect(def.object_selected).not.toBe(def.object_active);

  for (const p of info.presets) {
    await page.evaluate(async (id) => (await import('/src/prefs/theme_ui.ts')).setThemePreset(id), p.id);
    expect(await rootVar(page, '--c-region'), p.id).toBe(p.v.region);
    expect(await rootVar(page, '--accent'), p.id).toBe(p.v.accent);
    expect(await rootVar(page, '--c-text'), p.id).toBe(p.v.text);
    const canvas = await page.evaluate(async () => {
      const reg = await import('/src/nodes/registry.ts');
      const anim = await import('/src/animation/theme.ts');
      return { nodes: reg.NODE_EDITOR_COLORS.back, anim: anim.C.back };
    });
    expect(canvas.nodes, p.id).toBe(p.v.nd_back);
    expect(canvas.anim.toLowerCase().startsWith('#') ? canvas.anim.slice(0, 7) : canvas.anim, p.id).toBe(p.v['anim.back'].slice(0, 7));
  }
  await page.evaluate(async () => (await import('/src/prefs/theme_ui.ts')).setThemePreset('DEFAULT'));
  expect(await rootVar(page, '--c-region')).toBe(def.region);
  await expectNoErrors(errors);
});
