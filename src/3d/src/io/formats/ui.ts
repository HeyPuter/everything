// Small modal dialogs for format options and for picking companion files (external glTF buffers/textures, OBJ materials).

export interface FormatOption {
  id: string;
  label: string;
  type: 'bool' | 'enum' | 'float' | 'int' | 'string';
  default: boolean | string | number;
  items?: [string, string][];
  /** scripting property name when it differs from `id` */
  bpy?: string;
  /** scripting enum values accepted for this option, mapped to ours */
  bpyItems?: Record<string, string>;
  min?: number;
  max?: number;
  step?: number;
  description?: string;
  /** visible only when the predicate holds */
  showIf?: (v: Record<string, unknown>) => boolean;
}

export class AbortError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'AbortError';
  }
}

const STORE = 'p3d-io-options';

export function loadOptions(key: string, options: FormatOption[]): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  for (const o of options) v[o.id] = o.default;
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? '{}')[key] as Record<string, unknown> | undefined;
    if (saved) for (const o of options) if (typeof saved[o.id] === typeof o.default && (o.type !== 'enum' || o.items?.some((i) => i[0] === saved[o.id]))) v[o.id] = saved[o.id];
  } catch {
    // storage unavailable
  }
  return v;
}

function saveOptions(key: string, values: Record<string, unknown>) {
  try {
    const all = JSON.parse(localStorage.getItem(STORE) ?? '{}');
    all[key] = values;
    localStorage.setItem(STORE, JSON.stringify(all));
  } catch {
    // storage unavailable
  }
}

interface DialogParts {
  root: HTMLDivElement;
  body: HTMLDivElement;
  close: () => void;
  onEnter?: () => void;
}

function dialog(title: string, onCancel: () => void): DialogParts {
  const overlay = document.createElement('div');
  overlay.className = 'io-dialog-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.35);display:grid;place-items:center;';
  const root = document.createElement('div');
  root.className = 'popover io-dialog';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', title);
  root.tabIndex = -1;
  root.style.cssText = 'position:relative;min-width:300px;max-width:min(440px,calc(100vw - 32px));padding:10px 12px;display:flex;flex-direction:column;gap:6px;';
  const head = document.createElement('div');
  head.className = 'pop-title';
  head.textContent = title;
  const body = document.createElement('div');
  body.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
  root.append(head, body);
  overlay.append(root);
  document.body.append(overlay);
  const parts: DialogParts = { root, body, close: () => {} };
  // modal key handling regardless of focus: Escape cancels, Enter confirms, app shortcuts are blocked
  const onKey = (e: KeyboardEvent) => {
    // menus and prompts opened from the dialog (e.g. its preset menu) handle their own keys
    if ((e.target as Element | null)?.closest?.('.popup-layer') || document.querySelector('.popup-layer .menu')) return;
    const inside = root.contains(e.target as Node);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      parts.close();
      onCancel();
    } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement || e.target instanceof HTMLSelectElement)) {
      e.preventDefault();
      e.stopPropagation();
      parts.onEnter?.();
    } else if (!inside) e.stopPropagation();
  };
  addEventListener('keydown', onKey, true);
  parts.close = () => {
    removeEventListener('keydown', onKey, true);
    overlay.remove();
  };
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) {
      parts.close();
      onCancel();
    }
  });
  // keys typed inside the dialog never reach the app's keymaps
  root.addEventListener('keydown', (e) => e.stopPropagation());
  return parts;
}

function buttonRow(parts: DialogParts, okLabel: string, ok: () => void, cancel: () => void) {
  const row = document.createElement('div');
  row.className = 'btn-row';
  row.style.marginTop = '8px';
  const c = document.createElement('button');
  c.className = 'btn';
  c.textContent = 'Cancel';
  c.onclick = () => {
    parts.close();
    cancel();
  };
  const o = document.createElement('button');
  o.className = 'btn on';
  o.textContent = okLabel;
  o.onclick = () => {
    parts.close();
    ok();
  };
  row.append(c, o);
  parts.root.append(row);
  parts.onEnter = () => o.click();
  requestAnimationFrame(() => o.focus());
  return o;
}

/** Rows other modules put at the top of options dialogs (the preset menu); `sync` redraws the inputs. */
export const optionsDialogHooks: ((key: string, values: Record<string, unknown>, sync: () => void) => HTMLElement | null)[] = [];

/**
 * Show options; resolves with the chosen values or rejects with AbortError. `initial` replaces
 * the remembered values; `selection` adds a "Selected Only" toggle (its value is `__selection`).
 */
export function optionsDialog(
  title: string,
  key: string,
  options: FormatOption[],
  okLabel: string,
  intro?: string,
  initial?: Record<string, unknown>,
  selection?: { id: string; label: string; value: boolean },
): Promise<Record<string, unknown>> {
  const values = initial ? { ...loadOptions(key, options), ...initial } : loadOptions(key, options);
  if (!options.length && !selection) return Promise.resolve(values);
  return new Promise((resolve, reject) => {
    const parts = dialog(title, () => reject(new AbortError()));
    if (selection) values.__selection = selection.value;
    if (intro && !selection) {
      const p = document.createElement('div');
      p.style.cssText = 'color:var(--c-text-dim);margin-bottom:4px;';
      p.textContent = intro;
      parts.body.append(p);
    }
    const rows: { o: FormatOption; el: HTMLElement; input?: HTMLInputElement | HTMLSelectElement }[] = [];
    const refresh = () => rows.forEach(({ o, el }) => (el.style.display = !o.showIf || o.showIf(values) ? '' : 'none'));
    const sync = () => {
      for (const r of rows) {
        if (!r.input) continue;
        if (r.input instanceof HTMLInputElement && r.input.type === 'checkbox') r.input.checked = !!values[r.o.id];
        else r.input.value = String(values[r.o.id]);
      }
      refresh();
    };
    for (const f of optionsDialogHooks) {
      const el = f(key, values, sync);
      if (el) parts.body.append(el);
    }
    const shown: FormatOption[] = selection ? [{ id: '__selection', label: selection.label, type: 'bool', default: false, description: 'Only export the objects that are selected' }, ...options] : options;
    for (const o of shown) {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:var(--row);';
      if (o.description) row.title = o.description;
      const name = document.createElement('span');
      name.textContent = o.label;
      let input: HTMLInputElement | HTMLSelectElement;
      if (o.type === 'string') {
        const t = document.createElement('input');
        t.type = 'text';
        t.value = String(values[o.id] ?? '');
        t.style.cssText = 'background:var(--w-text, var(--w-num));color:var(--c-text);border:none;border-radius:var(--radius);height:var(--row);width:160px;padding:0 6px;';
        t.onchange = () => (values[o.id] = t.value);
        input = t;
        row.append(name, t);
      } else if (o.type === 'bool') {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!values[o.id];
        cb.onchange = () => {
          values[o.id] = cb.checked;
          refresh();
        };
        input = cb;
        row.style.justifyContent = 'flex-start';
        row.append(cb, name);
      } else if (o.type === 'enum') {
        const sel = document.createElement('select');
        sel.style.cssText = 'background:var(--w-regular);color:var(--c-text);border:none;border-radius:var(--radius);height:var(--row);min-width:120px;';
        for (const [v, l] of o.items ?? []) {
          const opt = document.createElement('option');
          opt.value = v;
          opt.textContent = l;
          sel.append(opt);
        }
        sel.value = String(values[o.id]);
        sel.onchange = () => {
          values[o.id] = sel.value;
          refresh();
        };
        input = sel;
        row.append(name, sel);
      } else {
        const num = document.createElement('input');
        num.type = 'number';
        num.step = String(o.step ?? (o.type === 'int' ? 1 : 0.01));
        if (o.min !== undefined) num.min = String(o.min);
        if (o.max !== undefined) num.max = String(o.max);
        num.value = String(values[o.id]);
        num.style.cssText = 'background:var(--w-num);color:var(--c-text);border:none;border-radius:var(--radius);height:var(--row);width:110px;padding:0 6px;';
        num.onchange = () => {
          let v = parseFloat(num.value);
          if (!Number.isFinite(v)) v = o.default as number;
          if (o.min !== undefined) v = Math.max(o.min, v);
          if (o.max !== undefined) v = Math.min(o.max, v);
          if (o.type === 'int') v = Math.round(v);
          values[o.id] = v;
          num.value = String(v);
        };
        input = num;
        row.append(name, num);
      }
      input.setAttribute('aria-label', o.label);
      rows.push({ o, el: row, input });
      parts.body.append(row);
    }
    refresh();
    buttonRow(
      parts,
      okLabel,
      () => {
        const { __selection: _sel, ...keep } = values;
        saveOptions(key, keep);
        resolve(values);
      },
      () => reject(new AbortError()),
    );
  });
}

/** Ask the user to pick companion files (a click provides the user activation for the picker). */
export function companionFilesDialog(title: string, message: string, missing: string[], accept: string): Promise<File[]> {
  return new Promise((resolve) => {
    const parts = dialog(title, () => resolve([]));
    const p = document.createElement('div');
    p.style.cssText = 'color:var(--c-text);white-space:pre-wrap;';
    p.textContent = `${message}\n\n${missing.slice(0, 12).join('\n')}${missing.length > 12 ? `\n… and ${missing.length - 12} more` : ''}`;
    parts.body.append(p);
    const ok = buttonRow(
      parts,
      'Choose Files…',
      () => {},
      () => resolve([]),
    );
    // replace the OK action: open a multi-file picker
    ok.onclick = () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = accept;
      input.onchange = () => {
        parts.close();
        resolve(Array.from(input.files ?? []));
      };
      input.addEventListener('cancel', () => {
        parts.close();
        resolve([]);
      });
      input.click();
    };
    const cancel = parts.root.querySelector('.btn-row .btn') as HTMLButtonElement;
    cancel.textContent = 'Skip';
  });
}
