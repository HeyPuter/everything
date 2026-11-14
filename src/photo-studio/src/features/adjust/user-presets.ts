// Saved settings for every adjustment kind: a bar above the controls in the
// Image > Adjustments dialogs and in adjustment-layer Properties to recall
// the settings used last, save the current settings under a name and delete
// saved ones. Stored per browser; settings are normalized against the kind's
// defaults when recalled, so entries from older versions keep working.
import type { AdjustmentKind } from '../../imaging/adjust';
import { escapeXML } from '../../model/assets';
import { svg } from '../../app/icons';
import type { AdjustHost } from './host';
import { specAdjustment } from './spec';
import { h, nextId } from './ui';

const KEY = 'photo-studio-adjust-presets';
const LAST_KEY = 'photo-studio-adjust-last';
export type SavedPreset = { name: string; params: Record<string, unknown> };
type Store = Partial<Record<AdjustmentKind, SavedPreset[]>>;

// In-memory copies keep presets working when storage is unavailable.
let memory: Store | undefined;
let lastMemory: Partial<Record<AdjustmentKind, Record<string, unknown>>> | undefined;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Storage is optional; the in-memory copy still works this session. */
  }
}
const store = (): Store => (memory ??= read<Store>(KEY, {}));
const lastStore = () =>
  (lastMemory ??= read<Partial<Record<AdjustmentKind, Record<string, unknown>>>>(LAST_KEY, {}));

export function savedPresets(kind: AdjustmentKind): SavedPreset[] {
  const list = store()[kind];
  return Array.isArray(list)
    ? list.filter(
        (p) => p && typeof p.name === 'string' && p.params && typeof p.params === 'object',
      )
    : [];
}
/** Save (or replace, by name) the settings for a kind. */
export function savePreset(kind: AdjustmentKind, name: string, params: unknown) {
  const clean = name.trim().slice(0, 80);
  if (!clean) return;
  const list = savedPresets(kind).filter((p) => p.name !== clean);
  list.push({ name: clean, params: structuredClone(params) as Record<string, unknown> });
  list.sort((a, b) => a.name.localeCompare(b.name));
  store()[kind] = list;
  write(KEY, store());
}
export function deletePreset(kind: AdjustmentKind, name: string) {
  store()[kind] = savedPresets(kind).filter((p) => p.name !== name);
  write(KEY, store());
}
/** Remember the settings a dialog applied, for "Last Used". */
export function rememberLast(kind: AdjustmentKind, params: unknown) {
  lastStore()[kind] = structuredClone(params) as Record<string, unknown>;
  write(LAST_KEY, lastStore());
}
export const lastUsed = (kind: AdjustmentKind) => lastStore()[kind];
/** Typed settings for stored params (normalized against the defaults). */
export function presetParams(kind: AdjustmentKind, params: Record<string, unknown>) {
  return specAdjustment({ kind, params })?.params;
}
/** Forget cached copies (tests). */
export function resetPresetCache() {
  memory = undefined;
  lastMemory = undefined;
}

/** The saved-settings bar for an editor host. */
export function presetBar(host: AdjustHost): HTMLElement {
  const kind = host.kind;
  const bar = h('div', { class: 'adj-saved', role: 'group', 'aria-label': 'Saved settings' });
  const id = nextId('saved');
  const apply = (params: Record<string, unknown>) => {
    const p = presetParams(kind, params);
    if (!p) return;
    host.params = p as typeof host.params;
    host.ui = {};
    host.change(true);
    host.rerender();
  };
  const draw = (naming = false) => {
    const list = savedPresets(kind);
    const last = host.dialog ? lastUsed(kind) : undefined;
    if (naming) {
      bar.innerHTML = `<input type="text" class="adj-saved-name" data-own-keys maxlength="80" placeholder="Name for these settings" aria-label="Name for these settings"><button type="button" class="primary adj-saved-ok">Save</button><button type="button" class="secondary adj-saved-cancel">Cancel</button>`;
      const input = bar.querySelector<HTMLInputElement>('input')!;
      const done = (save: boolean) => {
        if (save && input.value.trim()) savePreset(kind, input.value, host.params);
        draw();
        if (save && input.value.trim()) {
          bar.querySelector<HTMLSelectElement>('select')!.value =
            `user:${input.value.trim().slice(0, 80)}`;
          bar.querySelector<HTMLButtonElement>('.adj-saved-delete')!.disabled = false;
        }
        bar.querySelector<HTMLElement>(save ? 'select' : '.adj-saved-add')?.focus();
      };
      input.addEventListener('keydown', (ev) => {
        // Enter and Escape act on the name field, not the dialog.
        if (ev.key === 'Enter' || ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          done(ev.key === 'Enter');
        }
      });
      bar.querySelector('.adj-saved-ok')!.addEventListener('click', () => done(true));
      bar.querySelector('.adj-saved-cancel')!.addEventListener('click', () => done(false));
      input.focus();
      return;
    }
    const options = [
      `<option value="">${list.length || last ? 'Choose saved settings…' : 'No saved settings'}</option>`,
      last ? `<option value="last">Last Used</option>` : '',
      ...list.map((p) => `<option value="user:${escapeXML(p.name)}">${escapeXML(p.name)}</option>`),
    ].join('');
    bar.innerHTML = `<label for="${id}">Saved</label><select id="${id}" class="adj-saved-select">${options}</select><button type="button" class="icon-button adj-saved-add" title="Save these settings…" aria-label="Save these settings">${svg('bookmark', 15)}</button><button type="button" class="icon-button adj-saved-delete" title="Delete the chosen saved settings" aria-label="Delete saved settings" disabled>${svg('trash-2', 15)}</button>`;
    const sel = bar.querySelector('select')!;
    const del = bar.querySelector<HTMLButtonElement>('.adj-saved-delete')!;
    sel.disabled = !list.length && !last;
    sel.addEventListener('change', () => {
      del.disabled = !sel.value.startsWith('user:');
      if (sel.value === 'last' && last) apply(last);
      else if (sel.value.startsWith('user:')) {
        const p = list.find((x) => x.name === sel.value.slice(5));
        if (p) apply(p.params);
      }
    });
    bar.querySelector('.adj-saved-add')!.addEventListener('click', () => draw(true));
    del.addEventListener('click', () => {
      if (!sel.value.startsWith('user:')) return;
      deletePreset(kind, sel.value.slice(5));
      draw();
    });
  };
  draw();
  return bar;
}
