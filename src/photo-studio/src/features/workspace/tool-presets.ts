import type { Editor } from '../../editor';
import { registerCommand, registerPanel, tools, type Panel, type Tool } from '../../app/registry';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';
import { formDialog } from '../../ui/dialog';
import { brushFor, type BrushSettings } from '../paint';
import { paintingTools } from '../brushes';
import { effectsState } from '../effects/state';
import { shapeOpts } from '../vector/shape-options';
import { uniqueName } from './preset-file';

// Tool presets: a tool together with its options, saved under a name and
// applied from the Tool Presets panel or the picker at the left of the options
// bar. A preset records the option values the tool's options bar reads (found
// by rendering the options against a recording proxy) plus the state of the
// shared option stores (brush tips, gradient, pattern and shape settings).

export type ToolPreset = {
  id: string;
  name: string;
  tool: string;
  // `e.settings` keys and editor fields the tool's options read.
  settings?: Record<string, unknown>;
  fields?: Record<string, unknown>;
  // Shared option stores by provider ID.
  state?: Record<string, unknown>;
};

// Settings that describe the document or an operation in progress rather
// than a tool's options.
const transient = new Set([
  'quickMask', 'quickMaskPreview', 'draftGuides', 'activeChannel', 'numberKey', 'extrasHidden', 'hideSelectionEdges', 'hideTargetPath',
  'imageSize', 'canvasSize', 'crop', 'cloneSample', 'healSample', 'historySource', 'typeSession',
]);
const editorFields = ['brushSize', 'tolerance', 'maskSoftness', 'maskOpacity', 'autoSelect'] as const;

/** Option values small and plain enough to store as JSON. */
function plain(v: unknown): unknown {
  if (v === undefined || typeof v === 'function') return undefined;
  if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) return v;
  try {
    const json = JSON.stringify(v);
    return json.length <= 8192 ? JSON.parse(json) : undefined;
  } catch {
    return undefined;
  }
}

/** Keys of `e.settings` and editor fields a tool's options bar depends on. */
export function optionKeys(e: Editor, tool: Tool) {
  const settings = new Set<string>(),
    fields = new Set<string>();
  const settingsProxy = new Proxy(e.settings, {
    get(target, key) {
      if (typeof key === 'string' && !transient.has(key)) settings.add(key);
      return Reflect.get(target, key);
    },
  });
  const editorProxy = new Proxy(e, {
    get(target, key) {
      if (key === 'settings') return settingsProxy;
      if (typeof key === 'string' && (editorFields as readonly string[]).includes(key)) fields.add(key);
      const v = Reflect.get(target, key, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  try {
    tool.options?.(editorProxy);
  } catch {
    /* Options that need a document still report the keys they read first. */
  }
  return { settings, fields };
}

type StateProvider = { id: string; applies: (tool: Tool) => boolean; capture: (tool: Tool) => unknown; apply: (tool: Tool, value: unknown) => void };
const toB64 = (d: Uint8Array) => {
  let s = '';
  for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode(...d.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const providers: StateProvider[] = [
  {
    id: 'brush',
    applies: (t) => paintingTools.has(t.id),
    capture: (t) => {
      const { sample, ...rest } = brushFor(t.id);
      return { ...structuredClone(rest), sample: sample ? { width: sample.width, height: sample.height, data: toB64(sample.data) } : undefined };
    },
    apply: (t, v) => {
      const { sample, ...rest } = v as Partial<BrushSettings> & { sample?: { width: number; height: number; data: string } };
      Object.assign(brushFor(t.id), structuredClone(rest), {
        dynamics: { ...(rest.dynamics ?? {}) },
        sample: sample ? { width: sample.width, height: sample.height, data: fromB64(sample.data) } : undefined,
      });
    },
  },
  {
    id: 'gradient',
    applies: (t) => t.id === 'gradient',
    capture: () => structuredClone({ tool: effectsState.tool, gradient: effectsState.gradient }),
    apply: (_t, v) => {
      const s = v as Pick<typeof effectsState, 'tool' | 'gradient'>;
      if (s.tool) effectsState.tool = { ...effectsState.tool, ...structuredClone(s.tool) };
      if (s.gradient) effectsState.gradient = structuredClone(s.gradient);
    },
  },
  {
    id: 'pattern',
    applies: (t) => t.id === 'pattern-stamp' || t.id === 'bucket',
    capture: () => ({ patternId: effectsState.patternId, patternAligned: effectsState.patternAligned, patternScale: effectsState.patternScale }),
    apply: (_t, v) => Object.assign(effectsState, v as object),
  },
  {
    id: 'shape',
    applies: (t) => t.group === 'shape' || t.group === 'pen',
    capture: () => structuredClone(shapeOpts),
    apply: (_t, v) => Object.assign(shapeOpts, structuredClone(v as object)),
  },
];

/** Snapshot of a tool's current options. */
export function captureToolPreset(e: Editor, toolId: string, name: string): ToolPreset {
  const tool = tools.get(toolId)!;
  const preset: ToolPreset = { id: crypto.randomUUID(), name, tool: toolId };
  const keys = optionKeys(e, tool);
  const settings: Record<string, unknown> = {};
  for (const k of keys.settings) {
    const v = plain(e.settings[k]);
    if (v !== undefined) settings[k] = v;
  }
  if (Object.keys(settings).length) preset.settings = settings;
  const fields: Record<string, unknown> = {};
  for (const k of keys.fields) fields[k] = (e as unknown as Record<string, unknown>)[k];
  if (Object.keys(fields).length) preset.fields = fields;
  const state: Record<string, unknown> = {};
  for (const p of providers) if (p.applies(tool)) state[p.id] = plain(p.capture(tool));
  if (Object.keys(state).length) preset.state = state;
  return preset;
}
export function applyToolPreset(e: Editor, preset: ToolPreset) {
  const tool = tools.get(preset.tool);
  if (!tool) {
    e.message('The tool of this preset is not available.');
    return;
  }
  if (e.tool !== tool.id) e.setTool(tool.id);
  for (const [k, v] of Object.entries(preset.settings ?? {})) e.settings[k] = structuredClone(v);
  for (const [k, v] of Object.entries(preset.fields ?? {}))
    if ((editorFields as readonly string[]).includes(k) && typeof v === typeof (e as unknown as Record<string, unknown>)[k]) (e as unknown as Record<string, unknown>)[k] = v;
  for (const p of providers) if (preset.state?.[p.id] !== undefined && p.applies(tool)) p.apply(tool, preset.state[p.id]);
  selectedPreset = preset.id;
  e.options();
  e.dock?.update();
  e.message(`Tool preset “${preset.name}” applied.`);
}

export function validToolPreset(v: unknown): v is ToolPreset {
  if (!v || typeof v !== 'object') return false;
  const p = v as ToolPreset;
  const obj = (x: unknown) => x === undefined || (!!x && typeof x === 'object' && !Array.isArray(x));
  return typeof p.id === 'string' && typeof p.name === 'string' && !!p.name.trim() && typeof p.tool === 'string' && obj(p.settings) && obj(p.fields) && obj(p.state);
}

// ----- Storage -----
const storageKey = 'photo-studio-tool-presets';
let presets: ToolPreset[] = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return Array.isArray(v) ? v.filter(validToolPreset) : [];
  } catch {
    return [];
  }
})();
let selectedPreset = '';
let currentToolOnly = true;
export const toolPresets = (): ToolPreset[] => structuredClone(presets);
export function setToolPresets(e: Editor | undefined, list: ToolPreset[]) {
  presets = structuredClone(list.filter(validToolPreset));
  try {
    localStorage.setItem(storageKey, JSON.stringify(presets));
  } catch {
    /* Optional; presets stay for this session. */
  }
  e?.dock?.update();
}

export async function newToolPreset(e: Editor) {
  const tool = e.activeTool;
  if (!tool) return;
  const v = await formDialog('New Tool Preset', [{ name: 'name', label: 'Name', value: uniqueName(tool.label.replace(/ Tool$/, ''), presets.map((p) => p.name)) }], 'OK', 'Saves the current tool with its options.');
  if (!v) return;
  const preset = captureToolPreset(e, tool.id, v.name.trim() || tool.label);
  setToolPresets(e, [...presets, preset]);
  selectedPreset = preset.id;
  e.dock?.update();
  e.message(`Tool preset “${preset.name}” saved.`);
}
async function renamePreset(e: Editor, id: string) {
  const p = presets.find((x) => x.id === id);
  if (!p) return;
  const v = await formDialog('Rename Tool Preset', [{ name: 'name', label: 'Name', value: p.name }], 'OK');
  if (v?.name.trim()) setToolPresets(e, presets.map((x) => (x.id === id ? { ...x, name: v.name.trim() } : x)));
}
function deletePreset(e: Editor, id: string) {
  setToolPresets(e, presets.filter((x) => x.id !== id));
  if (selectedPreset === id) selectedPreset = '';
}

function presetRows(e: Editor, list: ToolPreset[], picker = false) {
  if (!list.length)
    return `<p class="muted tool-preset-empty">${currentToolOnly || picker ? `No presets for the ${escapeXML(e.activeTool?.label ?? 'current tool')}.` : 'No tool presets yet.'} Set up a tool and save it as a preset.</p>`;
  return list
    .map((p) => {
      const t = tools.get(p.tool);
      return `<div class="tool-preset-row ${p.id === selectedPreset ? 'selected' : ''}" role="option" aria-selected="${p.id === selectedPreset}" data-tool-preset="${p.id}" tabindex="0" title="${escapeXML(`${p.name} — ${t?.label ?? p.tool}`)}">${svg(t?.icon ?? 'tool-preset', 15)}<span class="tool-preset-name">${escapeXML(p.name)}</span>${picker ? '' : `<button class="icon-button tool-preset-delete" data-delete-tool-preset="${p.id}" aria-label="Delete ${escapeXML(p.name)}" title="Delete preset">${svg('trash-2', 13)}</button>`}</div>`;
    })
    .join('');
}
const visible = (e: Editor, onlyCurrent: boolean) => presets.filter((p) => !onlyCurrent || p.tool === e.tool);

const panel: Panel = {
  id: 'tool-presets',
  title: 'Tool Presets',
  icon: 'tool-preset',
  location: 'strip',
  mount: (e, el) => {
    el.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement;
      const del = t.closest<HTMLElement>('[data-delete-tool-preset]');
      if (del) {
        deletePreset(e, del.dataset.deleteToolPreset!);
        return;
      }
      const row = t.closest<HTMLElement>('[data-tool-preset]');
      const p = row && presets.find((x) => x.id === row.dataset.toolPreset);
      if (p) applyToolPreset(e, p);
    });
    el.addEventListener('dblclick', (ev) => {
      const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-tool-preset]');
      if (row) void renamePreset(e, row.dataset.toolPreset!);
    });
    el.addEventListener('keydown', (ev) => {
      const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-tool-preset]');
      // A row's Delete button keeps its own keys.
      if (!row || (ev.target as HTMLElement).closest('button')) return;
      const p = presets.find((x) => x.id === row.dataset.toolPreset);
      if (p && (ev.key === 'Enter' || ev.key === ' ')) applyToolPreset(e, p);
      else if (p && (ev.key === 'Delete' || ev.key === 'Backspace')) deletePreset(e, p.id);
      else return;
      ev.preventDefault();
    });
    el.addEventListener('change', (ev) => {
      const t = ev.target as HTMLInputElement;
      if (t.dataset.currentToolOnly === undefined) return;
      currentToolOnly = t.checked;
      e.dock.update();
    });
  },
  update: (e, el) => {
    el.innerHTML = `<div class="tool-presets-panel"><div class="tool-preset-list" role="listbox" aria-label="Tool presets">${presetRows(e, visible(e, currentToolOnly))}</div><div class="layer-footer"><label class="tool-preset-filter"><input type="checkbox" data-current-tool-only ${currentToolOnly ? 'checked' : ''}>Current Tool Only</label><span class="panel-tabs-spacer"></span><button data-command="tool.preset-new" title="New tool preset" aria-label="New tool preset">${svg('plus', 16)}</button><button data-command="tool.preset-delete" title="Delete tool preset" aria-label="Delete tool preset" ${selectedPreset ? '' : 'disabled'}>${svg('trash-2', 16)}</button></div></div>`;
  },
  menu: () => ['tool.preset-new', 'tool.preset-rename', 'tool.preset-delete', '-', 'edit.preset-manager'],
};

/** Popover beside the tool icon at the left of the options bar. */
function openPicker(e: Editor) {
  const anchor = e.el('#tool-icon');
  const existing = document.querySelector('.tool-preset-picker');
  if (existing) {
    existing.remove();
    return;
  }
  let all = false;
  const pop = document.createElement('div');
  pop.className = 'popover tool-preset-picker';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Tool presets');
  const render = () => {
    pop.innerHTML = `<div class="tool-preset-picker-head"><strong>${escapeXML(e.activeTool?.label ?? 'Tool')} Presets</strong><button class="icon-button" data-picker-new title="New tool preset" aria-label="New tool preset">${svg('plus', 15)}</button></div><div class="tool-preset-list" role="listbox" aria-label="Tool presets">${presetRows(e, visible(e, !all), !all)}</div><div class="tool-preset-picker-foot"><label><input type="checkbox" data-picker-all ${all ? 'checked' : ''}>Show all tools</label><button data-picker-manage>Manage…</button></div>`;
  };
  render();
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${r.left}px`;
  pop.style.top = `${r.bottom + 4}px`;
  const close = () => {
    pop.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', escape, true);
  };
  const outside = (ev: Event) => {
    if (!pop.contains(ev.target as Node) && !anchor.contains(ev.target as Node)) close();
  };
  const escape = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return;
    ev.stopPropagation();
    close();
    anchor.focus();
  };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', escape, true);
  pop.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    if (t.closest('[data-picker-new]')) {
      close();
      void newToolPreset(e);
      return;
    }
    if (t.closest('[data-picker-manage]')) {
      close();
      e.dock.show('tool-presets');
      return;
    }
    const row = t.closest<HTMLElement>('[data-tool-preset]');
    const p = row && presets.find((x) => x.id === row.dataset.toolPreset);
    if (p) {
      close();
      applyToolPreset(e, p);
    }
  });
  pop.addEventListener('keydown', (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-tool-preset]');
    const p = row && presets.find((x) => x.id === row.dataset.toolPreset);
    if (p && (ev.key === 'Enter' || ev.key === ' ')) {
      ev.preventDefault();
      close();
      applyToolPreset(e, p);
    }
  });
  pop.addEventListener('change', (ev) => {
    if ((ev.target as HTMLElement).dataset.pickerAll === undefined) return;
    all = (ev.target as HTMLInputElement).checked;
    render();
  });
  pop.querySelector<HTMLElement>('[data-tool-preset]')?.focus();
}

export function installToolPresets() {
  registerPanel(panel);
  registerCommand(
    { id: 'tool.preset-picker', label: 'Tool Preset Picker', hidden: true, recordable: false, run: (e) => openPicker(e) },
    { id: 'tool.preset-new', label: 'New Tool Preset…', recordable: false, enabled: (e) => !!e.activeTool, run: (e) => newToolPreset(e) },
    { id: 'tool.preset-rename', label: 'Rename Tool Preset…', recordable: false, enabled: () => presets.some((p) => p.id === selectedPreset), run: (e) => renamePreset(e, selectedPreset) },
    { id: 'tool.preset-delete', label: 'Delete Tool Preset', recordable: false, enabled: () => presets.some((p) => p.id === selectedPreset), run: (e) => deletePreset(e, selectedPreset) },
  );
}
