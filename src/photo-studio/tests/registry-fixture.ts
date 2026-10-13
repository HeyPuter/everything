// Registers every feature in Node, so tests can check the real command, tool,
// panel and menu registries. Browser globals a feature touches while
// installing are stood in for by inert proxies; nothing here runs a command.
import { vi } from 'vitest';

const inert = (): unknown =>
  new Proxy(function () {}, {
    get: (_t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : k === Symbol.iterator ? function* () {} : inert()),
    apply: () => inert(),
    construct: () => inert() as object,
  });

export async function loadRegistry() {
  const g = globalThis as Record<string, unknown>;
  for (const k of ['document', 'window', 'localStorage', 'matchMedia', 'requestAnimationFrame', 'Worker', 'HTMLElement', 'customElements', 'location', 'addEventListener', 'OffscreenCanvas', 'MutationObserver'])
    if (!(k in g)) g[k] = inert();
  const { loadPreferences } = await import('../src/model/preferences');
  const own: Record<string, unknown> = { preferences: loadPreferences(null), settings: {}, preferenceHooks: [], documentHooks: [], closeHooks: [], saveHooks: [], updateHooks: [] };
  const editor = new Proxy(own, { get: (t, k) => (k in t ? t[k as string] : inert()), set: (t, k, v) => ((t[k as string] = v), true) });
  // A feature that reaches for another browser global gets a stand-in too.
  for (let attempt = 0; ; attempt++) {
    vi.resetModules();
    try {
      const { installFeatures } = await import('../src/features/index');
      const registry = await import('../src/app/registry');
      installFeatures(editor as never);
      // Color registers its swatch libraries from a module it loads during
      // install; wait for it so the load never outlives the test file.
      await import('../src/features/color/swatches');
      await new Promise((r) => setTimeout(r, 0));
      // The dock registers Window → Panels commands at startup.
      for (const p of registry.panels.values())
        if (!registry.commands.has(`window.panel.${p.id}`)) registry.registerCommand({ id: `window.panel.${p.id}`, label: p.title, shortcut: p.shortcut, menu: 'window.panels', run: () => {} });
      return { ...registry, editor: editor as never };
    } catch (error) {
      const missing = /^(\w+) is not defined/.exec((error as Error).message);
      if (!missing || attempt > 40) throw error;
      g[missing[1]] = inert();
    }
  }
}
