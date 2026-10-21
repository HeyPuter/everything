// Shared helpers for the Render / Output / View Layer properties tabs.
import { app } from '../../../app/app';
import { checkbox, panel } from '../../../ui/widgets';
import { defaultRender } from '../../../data/defaults';
import type { Child, VNode } from '../../../ui/h';
import { num, oid, type PropOpts } from '../../../ui/props';
import { bindProp } from '../../../ui/binding';
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

/**
 * A number row with a checkbox in front of the field that enables it (e.g. Noise Threshold).
 * The number is drawn dimmed while the checkbox is off.
 */
export function checkNum<T extends object>(owner: T, boolKey: keyof T & string, numKey: keyof T & string, label: string, opts: PropOpts = {}): Child {
  const o = owner as unknown as Record<string, unknown>;
  const row = num(owner, numKey, label, { ...opts, disabled: opts.disabled || !o[boolKey] }) as VNode;
  const value = row.children?.[1];
  if (!value) return row;
  const id = `${oid(owner)}.${boolKey}`;
  bindProp({ id, owner: o, key: boolKey, label, kind: 'bool' });
  value.children.unshift(
    checkbox(id, '', !!o[boolKey], (v) => {
      o[boolKey] = v;
      changed(label);
    }, { tip: opts.tip }),
  );
  value.attrs.class = 'sr-value rs-checknum';
  return row;
}
