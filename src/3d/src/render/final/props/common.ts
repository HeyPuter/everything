// Shared helpers for the Render / Output / View Layer properties tabs.
import { app } from '../../../app/app';
import { checkbox, panel } from '../../../ui/widgets';
import { defaultRender } from '../../../data/defaults';
import type { Child } from '../../../ui/h';
import type { RenderSettings } from '../../../data/types';

/** The scene's render settings with every field present (older files lack newer ones). */
export function renderSettings(): RenderSettings {
  const r = app.doc.scene.render;
  const d = defaultRender() as unknown as Record<string, unknown>;
  const o = r as unknown as Record<string, unknown>;
  for (const k in d) if (o[k] === undefined) o[k] = d[k];
  return r;
}

export function changed(label: string) {
  app.pushUndo(label);
  app.changed('doc');
}

/** Checkbox drawn in a panel header that toggles a boolean setting. */
export function headerToggle<T extends object>(owner: T, key: keyof T & string, label: string): Child {
  const o = owner as unknown as Record<string, unknown>;
  return checkbox(`hdr-${key}`, '', !!o[key], (v) => {
    o[key] = v;
    changed(label);
  });
}

/** Sub-panel (nested inside a panel body). */
export function sub(id: string, title: string, body: () => Child, opts: { closed?: boolean; header?: Child } = {}) {
  return panel(id, title, body, { ...opts, sub: true });
}
