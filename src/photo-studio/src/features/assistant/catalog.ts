// The command catalog the Assistant searches. About 870 commands are too
// many to describe to the model on every turn, so the model gets a short list
// of common ones plus two tools: a ranked search returning one compact line
// per command, tool or panel, and on-demand details with the settings a
// command takes. Built from the live registries; pure enough to test in Node.
import type { Command, MenuItem, Panel, Tool } from '../../app/registry';
import { formatShortcut } from '../../app/shortcuts';
import { filterMenu, opIdFromCommand } from '../filters/menu';
import { OPS, type OpSpec } from './ops';
import { describeParams, type Param } from './params';

export type EntryKind = 'command' | 'tool' | 'panel' | 'op';
// How a step gets its settings: none, recorded settings passed directly,
// a dialog the user fills in during the run, an AI dialog opened prefilled,
// or an Assistant operation.
export type InputKind = 'none' | 'settings' | 'dialog' | 'ai' | 'op';
export type CatalogEntry = {
  id: string;
  kind: EntryKind;
  label: string;
  // Where to find it: menu path, panel menu or toolbar.
  path: string[];
  shortcut?: string;
  description?: string;
  input: InputKind;
  hidden?: boolean;
  // Searchable words (label, path, ID parts, description).
  words: string[];
  descWords: string[];
};

// Generative commands: they spend the user's Puter credits, so a plan only
// opens their dialog prefilled and the user presses Generate.
export const AI_COMMANDS = new Set(['edit.generate-image', 'edit.edit-with-prompt', 'edit.ai-fill', 'edit.ai-expand']);
// Commands the Assistant never runs: script and Assistant management,
// closing documents and discarding history.
export function blockedCommand(id: string) {
  return (
    /^(script|scripts|assistant|generations)\./.test(id) ||
    id.startsWith('window.panel.menu-') ||
    ['file.scripts-browse', 'file.scripts-browse-cloud', 'file.script-events', 'file.batch-link', 'file.close', 'file.close-all', 'file.close-others', 'file.revert', 'edit.purge-history', 'edit.purge-all', 'edit.purge-clipboard', 'edit.purge-video-cache'].includes(id)
  );
}

const immediateFilters = new Set(filterMenu.filter((f) => f.immediate).map((f) => f.id));
// Commands (besides filters) that apply recorded settings `{ params }` directly.
const SETTINGS_PARAMS: Record<string, Param[]> = {
  'image.upscale': [
    { key: 'percent', type: 'integer', label: 'Scale', min: 101, max: 800, unit: '%', default: 200 },
    { key: 'detail', type: 'number', label: 'Detail', min: 0, max: 100, unit: '%', default: 50 },
  ],
};
// Prefilled settings of the AI dialogs (`{ prefill }`); kept in sync with
// assist/generate.ts and retouch/ai.ts.
const STYLE_IDS = ['none', 'photo', 'cinematic', 'painting', 'watercolor', 'ink', 'flat', 'render', 'pixel'];
const ASPECT_IDS = ['target', '1:1', '4:3', '3:2', '16:9', '3:4', '2:3', '9:16'];
export const AI_PARAMS: Record<string, Param[]> = {
  'edit.generate-image': [
    { key: 'prompt', type: 'text', label: 'Prompt', required: true },
    { key: 'style', type: 'enum', label: 'Style', options: STYLE_IDS.map((value) => ({ value })) },
    { key: 'aspect', type: 'enum', label: 'Aspect', options: ASPECT_IDS.map((value) => ({ value })), description: 'target follows the selection or canvas' },
    { key: 'count', type: 'integer', label: 'Variations', min: 1, max: 4 },
  ],
  'edit.edit-with-prompt': [{ key: 'prompt', type: 'text', label: 'Instruction', required: true }],
  'edit.ai-fill': [
    { key: 'prompt', type: 'text', label: 'Prompt', required: true },
    { key: 'method', type: 'enum', label: 'Method', options: [{ value: 'edit', label: 'Instruction edit' }, { value: 'inpaint', label: 'Mask inpainting' }] },
  ],
  'edit.ai-expand': [
    ...['left', 'top', 'right', 'bottom'].map((key): Param => ({ key, type: 'integer', label: key[0].toUpperCase() + key.slice(1), min: 0, max: 4096, unit: 'px' })),
    { key: 'prompt', type: 'text', label: 'Prompt' },
  ],
};

export function commandInput(c: Pick<Command, 'id' | 'label'>): InputKind {
  if (AI_COMMANDS.has(c.id)) return 'ai';
  const op = opIdFromCommand(c.id);
  if (c.id.startsWith('filter.apply.') && op) return immediateFilters.has(op) ? 'none' : 'settings';
  if (c.id === 'filter.denoise' || c.id === 'filter.sharpen-details' || SETTINGS_PARAMS[c.id]) return 'settings';
  return c.label.endsWith('…') ? 'dialog' : 'none';
}

/** Settings a command takes as `{ params }` or `{ prefill }` (loads the filter catalog on demand). */
export async function commandParams(id: string): Promise<Param[] | undefined> {
  if (AI_PARAMS[id]) return AI_PARAMS[id];
  if (SETTINGS_PARAMS[id]) return SETTINGS_PARAMS[id];
  const op = opIdFromCommand(id);
  if (!op || immediateFilters.has(op)) return undefined;
  const [{ filterOp }, { fromParamSpecs }] = await Promise.all([import('../filters/catalog'), import('./params')]);
  const spec = filterOp(op);
  return spec ? fromParamSpecs(spec.params) : undefined;
}

const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'with', 'my', 'this', 'that', 'it', 'by', 'how', 'do', 'i', 'can', 'make', 'more', 'less', 'some', 'into', 'from', 'is', 'be', 'me', 'add', 'use', 'new']);
// Everyday words for the names used in menus.
const SYNONYMS: Record<string, string[]> = {
  remove: ['delete', 'erase', 'clear'],
  delete: ['remove'],
  erase: ['eraser', 'remove'],
  background: ['backdrop'],
  bright: ['brightness', 'exposure', 'light'],
  brighten: ['brightness', 'exposure', 'light'],
  lighten: ['brightness', 'exposure', 'light'],
  dark: ['brightness', 'exposure', 'shadow'],
  darken: ['brightness', 'exposure', 'burn'],
  contrast: ['curve', 'level', 'tone'],
  dramatic: ['contrast', 'clarity', 'curve'],
  punchy: ['contrast', 'vibrance', 'clarity'],
  vivid: ['vibrance', 'saturation'],
  colorful: ['vibrance', 'saturation'],
  color: ['hue', 'saturation', 'balance'],
  colour: ['color', 'hue', 'saturation'],
  warm: ['photo', 'filter', 'temperature', 'balance'],
  cool: ['photo', 'filter', 'temperature', 'balance'],
  bw: ['black', 'white', 'desaturate'],
  grayscale: ['black', 'white', 'desaturate', 'gray'],
  monochrome: ['black', 'white', 'desaturate'],
  soft: ['blur', 'feather'],
  smooth: ['blur', 'smooth'],
  blurry: ['blur'],
  sharp: ['sharpen', 'detail'],
  crisp: ['sharpen', 'clarity'],
  detail: ['sharpen', 'clarity'],
  grainy: ['grain', 'noise'],
  noisy: ['noise', 'denoise'],
  denoise: ['noise', 'reduce'],
  turn: ['rotate'],
  straighten: ['rotate', 'ruler', 'crop'],
  mirror: ['flip'],
  resize: ['size', 'image', 'scale'],
  enlarge: ['upscale', 'size'],
  bigger: ['upscale', 'size', 'canvas'],
  smaller: ['size', 'image'],
  cut: ['crop', 'via'],
  trim: ['crop', 'trim'],
  text: ['type', 'character'],
  title: ['type', 'text'],
  caption: ['type', 'text'],
  words: ['type', 'text'],
  font: ['type', 'character'],
  shadow: ['drop', 'shadow'],
  glow: ['outer', 'inner', 'glow'],
  outline: ['stroke'],
  border: ['stroke', 'border', 'canvas'],
  vignette: ['lens', 'correction', 'vignette'],
  sky: ['sky', 'replacement'],
  person: ['subject'],
  people: ['subject'],
  object: ['subject', 'objects'],
  cutout: ['subject', 'background', 'mask'],
  hide: ['mask', 'hide'],
  generate: ['generate', 'ai'],
  ai: ['generate', 'fill', 'expand', 'prompt'],
  extend: ['expand', 'canvas'],
  widen: ['expand', 'canvas'],
  fix: ['heal', 'spot', 'patch'],
  blemish: ['spot', 'heal'],
  retouch: ['heal', 'clone', 'patch'],
  undo: ['undo', 'history'],
  save: ['save', 'export'],
  export: ['export', 'save'],
  layer: ['layer'],
  merge: ['merge', 'flatten'],
  combine: ['merge', 'group'],
  transparent: ['opacity', 'transparency'],
  see: ['opacity', 'visible'],
};
/** Lower-case words of a text, lightly stemmed ("blurring" → "blur"). */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(stem);
}
function stem(w: string) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3).replace(/(.)\1$/, '$1');
  if (w.length > 4 && w.endsWith('ed') && !w.endsWith('eed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('es') && /(ss|sh|ch|x)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

type Sources = {
  commands: Map<string, Command>;
  tools: Map<string, Tool>;
  panels: Map<string, Panel>;
  skeleton: { id: string; label: string; items: MenuItem[] }[];
  contributions: { menu: string; after?: string; items: MenuItem[] }[];
  // Panel menus, when a workspace is available to build them.
  panelMenu?: (p: Panel) => MenuItem[];
  ops?: OpSpec[];
};

export class Catalog {
  readonly entries: CatalogEntry[] = [];
  private byId = new Map<string, CatalogEntry>();
  constructor(private src: Sources) {
    const paths = menuPaths(src);
    for (const c of src.commands.values()) {
      const panelId = c.id.startsWith('window.panel.') ? c.id.slice('window.panel.'.length) : undefined;
      const path = paths.get(c.id) ?? (panelId && src.panels.has(panelId) ? ['Window', 'Panels'] : []);
      this.add({ id: c.id, kind: 'command', label: c.label, path, shortcut: formatShortcut(c.shortcut) || undefined, description: c.description, input: commandInput(c), hidden: !!c.hidden || blockedCommand(c.id) });
    }
    for (const t of src.tools.values()) this.add({ id: `tool.${t.id}`, kind: 'tool', label: t.label, path: ['Tools panel'], shortcut: t.key, input: 'none' });
    for (const p of src.panels.values()) this.add({ id: `panel.${p.id}`, kind: 'panel', label: `${p.title} panel`, path: ['Window', 'Panels'], input: 'none' });
    for (const o of src.ops ?? OPS) this.add({ id: o.id, kind: 'op', label: o.label, path: [], description: o.description, input: 'op' });
  }
  private add(x: Omit<CatalogEntry, 'words' | 'descWords'>) {
    const e: CatalogEntry = { ...x, words: [...new Set([...words(x.label), ...words(x.id.replace(/^(tool|panel|op)\./, '')), ...x.path.flatMap(words)])], descWords: words(x.description ?? '') };
    this.entries.push(e);
    this.byId.set(e.id, e);
  }
  get(id: string): CatalogEntry | undefined {
    return this.byId.get(id);
  }
  /** Ranked matches for a free-text query (hidden and blocked commands left out). */
  search(query: string, opts: { kind?: EntryKind | 'any'; limit?: number } = {}): CatalogEntry[] {
    const limit = Math.max(1, Math.min(40, opts.limit ?? 12));
    const q = words(query).filter((w) => !STOP.has(w));
    if (!q.length) return [];
    const weighted = new Map<string, number>();
    for (const w of q) weighted.set(w, 1);
    for (const w of q) for (const s of SYNONYMS[w] ?? []) if (!weighted.has(stem(s))) weighted.set(stem(s), 0.45);
    const phrase = query.trim().toLowerCase();
    const scored: { e: CatalogEntry; s: number }[] = [];
    for (const e of this.entries) {
      if (e.hidden || (opts.kind && opts.kind !== 'any' && e.kind !== opts.kind)) continue;
      const label = words(e.label);
      let s = 0;
      let matched = 0;
      for (const [w, k] of weighted) {
        let m = 0;
        if (label.includes(w)) m = 4;
        else if (w.length > 2 && label.some((x) => x.startsWith(w))) m = 2.5;
        else if (e.words.includes(w)) m = 1.6;
        else if (w.length > 2 && e.words.some((x) => x.startsWith(w))) m = 1.1;
        else if (e.descWords.includes(w)) m = 0.8;
        if (m && k === 1) matched++;
        s += m * k;
      }
      if (!s) continue;
      if (phrase.length > 2 && e.label.toLowerCase().includes(phrase)) s += 4;
      // Prefer entries matching every word typed, then shorter labels.
      s += matched === q.length ? 2 : 0;
      s -= label.length * 0.05;
      if (e.kind === 'panel') s -= 0.5;
      scored.push({ e, s });
    }
    return scored
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => x.e);
  }
  /** One compact line per entry, as the model sees search results. */
  line(e: CatalogEntry): string {
    const where = e.kind === 'tool' ? `toolbar${e.shortcut ? `, key ${e.shortcut}` : ''}` : e.path.length ? `${e.path.join(' > ')}` : '';
    const input = e.kind === 'command' && e.input !== 'none' ? ` | input: ${e.input}` : '';
    const short = e.kind === 'command' && e.shortcut ? ` | ${e.shortcut}` : '';
    return `${e.id} | ${e.label}${where ? ` | ${where}` : ''}${input}${short}`;
  }
  /** Full details of entries (description, where, settings schema). */
  async details(ids: string[], extra?: { needsSelection?: (id: string) => boolean; enabled?: (id: string) => boolean | undefined }): Promise<string> {
    const out: string[] = [];
    for (const raw of ids.slice(0, 12)) {
      const id = String(raw);
      const e = this.get(id) ?? this.get(this.src.commands.has(id) ? id : '');
      if (!e) {
        out.push(`${id}: not found. Search the catalog for the right ID.`);
        continue;
      }
      const lines = [`${e.id} — ${e.label} (${e.kind})`];
      if (e.description) lines.push(e.description);
      if (e.kind === 'command') {
        if (e.path.length) lines.push(`Menu: ${e.path.join(' > ')}`);
        if (e.shortcut) lines.push(`Shortcut: ${e.shortcut}`);
        if (blockedCommand(e.id)) lines.push('The Assistant cannot run this command; mention it in an answer instead.');
        else if (e.input === 'none') lines.push('Takes no settings.');
        else if (e.input === 'dialog') lines.push('Opens a dialog where the user picks settings during the run (prefer an operation or a command with settings when one fits).');
        else {
          const params = await commandParams(e.id);
          if (e.input === 'ai') lines.push('Generative AI: uses the user’s Puter credits. In a plan its dialog opens prefilled with these args and the user presses Generate:');
          else lines.push('Settings (pass as args; missing ones use defaults):');
          if (params?.length) lines.push(describeParams(params));
        }
        if (extra?.needsSelection?.(e.id)) lines.push('Needs a selection.');
        const enabled = extra?.enabled?.(e.id);
        if (enabled === false) lines.push('Not available in the current state of the document.');
      } else if (e.kind === 'op') {
        const op = (this.src.ops ?? OPS).find((o) => o.id === e.id)!;
        lines.push('Args:', describeParams(op.params));
        if (op.id === 'op.add_adjustment_layer') lines.push(await adjustmentHelp());
      } else if (e.kind === 'tool') {
        lines.push(`A tool in the toolbar${e.shortcut ? ` (key ${e.shortcut})` : ''}. Tools are used by hand on the canvas; a plan cannot use them, but an answer can point to them.`);
      } else lines.push(`Opens with the command window.${e.id}.`);
      out.push(lines.join('\n'));
    }
    return out.join('\n\n');
  }
}

async function adjustmentHelp() {
  const { ADJUSTMENT_KINDS } = await import('../../imaging/adjust/model');
  const { ADJUSTMENT_PARAMS, adjustmentDefaults } = await import('./ops');
  const lines = ['Settings by kind (params):'];
  for (const k of ADJUSTMENT_KINDS) {
    const flat = ADJUSTMENT_PARAMS[k];
    lines.push(
      flat
        ? `${k}: ${flat.length ? flat.map((p) => `${p.key}${p.min !== undefined ? ` ${p.min}..${p.max}` : p.options ? ` ${p.options.map((o) => o.value).join('|')}` : ` ${p.type}`}`).join(', ') : 'no settings'}`
        : `${k}: nested object merged with these defaults ${adjustmentDefaults(k)}`,
    );
  }
  lines.push('curves points are [input, output] pairs in 0..255, e.g. an S-curve { rgb: { mode: "points", points: [[0,0],[64,48],[192,212],[255,255]] } }.');
  return lines.join('\n');
}

/** Menu path (top menu and submenus) of every command reachable from the menu bar or a panel menu. */
function menuPaths(src: Sources): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const dynamic = (id: string | undefined) => (id ? [...src.commands.values()].filter((c) => c.menu === id && !c.hidden).map((c) => c.id) : []);
  const withContrib = (menu: string, items: MenuItem[]) => {
    const list = [...items];
    for (const c of src.contributions.filter((m) => m.menu === menu)) {
      const at = c.after ? list.findIndex((i) => i === c.after || (typeof i === 'object' && i.id === c.after)) : -1;
      if (at >= 0) list.splice(at + 1, 0, ...c.items);
      else list.push(...c.items);
    }
    return list;
  };
  const walk = (path: string[], id: string | undefined, items: MenuItem[], depth = 0) => {
    if (depth > 6) return;
    for (const i of [...(id ? withContrib(id, items) : items), ...dynamic(id)]) {
      if (i === '-') continue;
      if (typeof i === 'string') {
        if (!out.has(i)) out.set(i, path);
      } else walk([...path, i.label], i.id, i.items, depth + 1);
    }
  };
  for (const m of src.skeleton) walk([m.label], m.id, m.items);
  if (src.panelMenu)
    for (const p of src.panels.values()) {
      try {
        walk([`${p.title} panel menu`], undefined, src.panelMenu(p));
      } catch {
        /* A panel menu that needs more of the workspace is skipped. */
      }
    }
  return out;
}

// Common commands listed in the system prompt so most requests need no search.
export const COMMON_COMMANDS = [
  'select.all', 'select.deselect', 'select.inverse', 'select.subject', 'select.sky', 'select.color-range', 'select.modify-feather',
  'layer.remove-background', 'layer.duplicate', 'layer.new', 'layer.group', 'layer.merge-visible', 'layer.flatten', 'layer.clipping-mask', 'layer.mask-reveal-selection', 'layer.mask-hide-selection', 'layer.harmonize',
  'image.auto-tone', 'image.auto-contrast', 'image.auto-color', 'image.crop', 'image.trim', 'image.rotate-cw', 'image.rotate-ccw', 'image.rotate-180', 'image.flip-horizontal', 'image.flip-vertical', 'image.upscale',
  'adjust.desaturate', 'adjust.invert', 'adjust.equalize',
  'filter.apply.gaussian-blur', 'filter.apply.unsharp-mask', 'filter.denoise', 'filter.sharpen-details', 'filter.apply.add-noise', 'filter.convert-live',
  'edit.generate-image', 'edit.edit-with-prompt', 'edit.ai-fill', 'edit.ai-expand', 'edit.context-fill', 'edit.sky-replacement',
];
