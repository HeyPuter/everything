import type { Editor } from '../editor';
import { commands, findCommand, registerCommand, tools, panels, type Command } from '../app/registry';
import { allLayers, findLayer, type Layer } from '../model/document';
import { linkedPartners } from '../model/links';
import { transformBounds } from '../model/transform';
import { assertEditable } from '../model/layers';
import { escapeXML } from '../model/assets';
import { eventShortcut, formatShortcut, normalizeShortcut } from '../app/shortcuts';
import { svg } from '../app/icons';

type Box = { x: number; y: number; width: number; height: number };
function layerBox(l: Layer, e: Editor): Box {
  if (l.kind === 'group') {
    const boxes = l.children.filter((c) => c.kind !== 'adjustment').map((c) => layerBox(c, e));
    if (!boxes.length) return { x: 0, y: 0, width: e.doc.width, height: e.doc.height };
    const x = Math.min(...boxes.map((b) => b.x)),
      y = Math.min(...boxes.map((b) => b.y));
    return { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x, height: Math.max(...boxes.map((b) => b.y + b.height)) - y };
  }
  return transformBounds(l.transform);
}
function translate(l: Layer, dx: number, dy: number) {
  if (l.kind === 'group') for (const c of l.children) translate(c, dx, dy);
  else {
    l.transform.x += dx;
    l.transform.y += dy;
  }
}
type Edge = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';
function align(e: Editor, edge: Edge) {
  const roots = e.selectedLayers;
  if (!roots.length) return;
  assertEditable(e.doc, roots, 'position');
  const boxes = roots.map((l) => layerBox(l, e));
  // With one layer, align to the selection or the canvas.
  const ref: Box = e.doc.selection
    ? e.doc.selection
    : roots.length === 1
      ? { x: 0, y: 0, width: e.doc.width, height: e.doc.height }
      : (() => {
          const x = Math.min(...boxes.map((b) => b.x)),
            y = Math.min(...boxes.map((b) => b.y));
          return { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x, height: Math.max(...boxes.map((b) => b.y + b.height)) - y };
        })();
  const selected = new Set(allLayers(roots).map((l) => l.id));
  e.command('Align', (d) => {
    roots.forEach((r, i) => {
      const l = findLayer(d.layers, r.id)!;
      const b = boxes[i];
      let dx = 0,
        dy = 0;
      if (edge === 'left') dx = ref.x - b.x;
      if (edge === 'right') dx = ref.x + ref.width - (b.x + b.width);
      if (edge === 'hcenter') dx = ref.x + ref.width / 2 - (b.x + b.width / 2);
      if (edge === 'top') dy = ref.y - b.y;
      if (edge === 'bottom') dy = ref.y + ref.height - (b.y + b.height);
      if (edge === 'vcenter') dy = ref.y + ref.height / 2 - (b.y + b.height / 2);
      translate(l, Math.round(dx), Math.round(dy));
      // Linked layers that are not selected themselves keep their offset.
      for (const p of linkedPartners(d.layers, r.id))
        if (!selected.has(p.id)) {
          selected.add(p.id);
          translate(p, Math.round(dx), Math.round(dy));
        }
    });
  });
}
function distribute(e: Editor, edge: Edge | 'h-space' | 'v-space') {
  const roots = e.selectedLayers;
  if (roots.length < 3) {
    e.message('Select three or more layers to distribute.');
    return;
  }
  assertEditable(e.doc, roots, 'position');
  const items = roots.map((l) => ({ l, b: layerBox(l, e) }));
  const horizontal = ['left', 'hcenter', 'right', 'h-space'].includes(edge);
  const pos = (b: Box) =>
    edge === 'left' ? b.x : edge === 'right' ? b.x + b.width : edge === 'hcenter' ? b.x + b.width / 2 : edge === 'top' ? b.y : edge === 'bottom' ? b.y + b.height : edge === 'vcenter' ? b.y + b.height / 2 : horizontal ? b.x : b.y;
  items.sort((a, b) => pos(a.b) - pos(b.b));
  const moves = new Map<string, number>();
  if (edge === 'h-space' || edge === 'v-space') {
    const size = (b: Box) => (horizontal ? b.width : b.height);
    const start = pos(items[0].b),
      end = pos(items.at(-1)!.b) + size(items.at(-1)!.b);
    const gap = (end - start - items.reduce((s, it) => s + size(it.b), 0)) / (items.length - 1);
    let at = start;
    for (const it of items) {
      moves.set(it.l.id, at - pos(it.b));
      at += size(it.b) + gap;
    }
  } else {
    const first = pos(items[0].b),
      last = pos(items.at(-1)!.b);
    items.forEach((it, i) => moves.set(it.l.id, first + ((last - first) * i) / (items.length - 1) - pos(it.b)));
  }
  e.command('Distribute', (d) => {
    for (const [id, m] of moves) translate(findLayer(d.layers, id)!, horizontal ? Math.round(m) : 0, horizontal ? 0 : Math.round(m));
  });
}

// ----- Command search -----
function openSearch(e: Editor) {
  document.querySelector('.command-search')?.remove();
  const pop = document.createElement('div');
  pop.className = 'command-search popover';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Search');
  // A combobox: the focus stays in the field and the highlighted result is
  // its active descendant, so screen readers say each result as it is reached.
  pop.innerHTML = `<input type="search" placeholder="Search commands, tools and panels" aria-label="Search commands" role="combobox" aria-autocomplete="list" aria-controls="command-search-results" aria-expanded="false"><div class="search-results" id="command-search-results" role="listbox" aria-label="Results"></div>`;
  const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  document.body.append(pop);
  const input = pop.querySelector('input')!,
    list = pop.querySelector<HTMLElement>('.search-results')!;
  type Item = { kind: string; label: string; detail: string; run: () => void; icon: string };
  const items: Item[] = [
    ...[...commands.values()].filter((c) => !c.hidden && !c.id.startsWith('window.panel.')).map((c) => ({ kind: 'Command', label: c.label.replace('…', ''), detail: formatShortcut(c.shortcut), run: () => void e.runCommand(c.id), icon: 'chevron-right' })),
    ...[...tools.values()].map((t) => ({ kind: 'Tool', label: t.label, detail: t.key ?? '', run: () => e.setTool(t.id), icon: t.icon })),
    ...[...panels.values()].map((p) => ({ kind: 'Panel', label: p.title, detail: '', run: () => e.dock.show(p.id), icon: p.icon })),
  ];
  let active = 0;
  let shown: Item[] = [];
  const render = () => {
    const q = input.value.trim().toLowerCase();
    shown = (q ? items.filter((i) => i.label.toLowerCase().includes(q) || i.kind.toLowerCase().startsWith(q)) : items.slice(0, 0))
      .sort((a, b) => Number(!a.label.toLowerCase().startsWith(q)) - Number(!b.label.toLowerCase().startsWith(q)))
      .slice(0, 40);
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.innerHTML = shown
      .map((i, k) => `<div class="search-item ${k === active ? 'active' : ''}" role="option" id="command-search-${k}" aria-selected="${k === active}" data-k="${k}">${svg(i.icon, 14)}<span>${escapeXML(i.label)}</span><small>${i.kind}</small><kbd>${escapeXML(i.detail)}</kbd></div>`)
      .join('') || (q ? '<p class="muted">No results</p>' : '<p class="muted">Type to search menus, tools and panels.</p>');
    input.setAttribute('aria-expanded', String(shown.length > 0));
    if (shown.length) input.setAttribute('aria-activedescendant', `command-search-${active}`);
    else input.removeAttribute('aria-activedescendant');
    list.querySelector('.search-item.active')?.scrollIntoView({ block: 'nearest' });
  };
  const close = () => {
    pop.remove();
    document.removeEventListener('pointerdown', outside, true);
  };
  const outside = (ev: Event) => {
    if (!pop.contains(ev.target as Node)) close();
  };
  input.addEventListener('input', () => {
    active = 0;
    render();
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') active = Math.min(shown.length - 1, active + 1);
    else if (ev.key === 'ArrowUp') active = Math.max(0, active - 1);
    else if (ev.key === 'Enter' && shown[active]) {
      close();
      // The focus goes back first, so a dialog the command opens returns it there.
      opener?.focus({ preventScroll: true });
      shown[active].run();
      return;
    } else if (ev.key === 'Escape') {
      close();
      opener?.focus({ preventScroll: true });
      return;
    } else return;
    ev.preventDefault();
    render();
  });
  list.addEventListener('click', (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-k]');
    if (!row) return;
    close();
    opener?.focus({ preventScroll: true });
    shown[Number(row.dataset.k)].run();
  });
  document.addEventListener('pointerdown', outside, true);
  render();
  input.focus();
}

// ----- Keyboard shortcut customization -----
const shortcutKey = 'photo-studio-shortcuts';
// Shortcuts as registered, recorded before a customization replaces them so
// a reset or a workspace switch can restore them without reloading.
const defaultShortcuts = new Map<string, Command['shortcut']>();
export function customShortcuts(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(shortcutKey) ?? '{}');
    if (v && typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.entries(v).filter(([, s]) => typeof s === 'string')) as Record<string, string>;
  } catch {
    /* Optional. */
  }
  return {};
}
export function applyCustomShortcuts() {
  for (const [id, s] of defaultShortcuts) {
    const c = commands.get(id);
    if (c) c.shortcut = s;
  }
  for (const [id, s] of Object.entries(customShortcuts())) {
    const c = findCommand(id);
    if (!c) continue;
    if (!defaultShortcuts.has(c.id)) defaultShortcuts.set(c.id, c.shortcut);
    c.shortcut = s || undefined;
  }
}
/** Replace the custom shortcut set (an empty set restores the defaults). */
export function setCustomShortcuts(custom: Record<string, string>) {
  try {
    if (Object.keys(custom).length) localStorage.setItem(shortcutKey, JSON.stringify(custom));
    else localStorage.removeItem(shortcutKey);
  } catch {
    /* Optional. */
  }
  applyCustomShortcuts();
}
function shortcutEditor(e: Editor) {
  const d = document.querySelector<HTMLDialogElement>('#dialog')!;
  let custom: Record<string, string> = {};
  try {
    custom = JSON.parse(localStorage.getItem(shortcutKey) ?? '{}');
  } catch {
    /* Optional. */
  }
  const list = [...commands.values()].filter((c) => !c.id.startsWith('window.panel.') || true).sort((a, b) => a.id.localeCompare(b.id));
  d.innerHTML = `<form method="dialog" class="shortcut-editor"><h2>Keyboard Shortcuts</h2><p class="muted">Click a shortcut field (or press Enter on it) and press the new key combination; Escape stops recording. Backspace clears it. Conflicts are shown in red.</p><input type="search" class="shortcut-filter" placeholder="Filter" aria-label="Filter commands"><div class="shortcut-table">${list
    .map((c) => `<label class="shortcut-entry" data-id="${c.id}"><span>${escapeXML(c.label)} <small class="muted">${escapeXML(c.id)}</small></span><input readonly data-shortcut="${c.id}" value="${escapeXML(Array.isArray(c.shortcut) ? c.shortcut[0] : (c.shortcut ?? ''))}" aria-label="Shortcut for ${escapeXML(c.label)}"></label>`)
    .join('')}</div><div class="dialog-actions"><button type="button" data-reset-shortcuts>Reset to Defaults</button><button type="button" id="cancel-dialog">Cancel</button><button class="primary">OK</button></div></form>`;
  const conflicts = () => {
    const seen = new Map<string, HTMLInputElement[]>();
    d.querySelectorAll<HTMLInputElement>('[data-shortcut]').forEach((i) => {
      i.classList.remove('conflict');
      if (!i.value) return;
      const k = normalizeShortcut(i.value);
      seen.set(k, [...(seen.get(k) ?? []), i]);
    });
    for (const group of seen.values()) if (group.length > 1) group.forEach((i) => i.classList.add('conflict'));
  };
  // A field records keys once clicked (or Enter is pressed on it) until
  // Escape or the focus leaves; otherwise Tab and Escape keep their usual
  // meaning, so the keyboard can move through the list and close the dialog.
  const form = d.querySelector('form')!;
  const record = (t: HTMLInputElement, on: boolean) => {
    t.classList.toggle('recording', on);
    t.placeholder = on ? 'Press keys…' : '';
  };
  form.addEventListener('pointerdown', (ev) => {
    const t = ev.target as HTMLInputElement;
    if (t.dataset?.shortcut) record(t, true);
  });
  form.addEventListener('focusout', (ev) => {
    const t = ev.target as HTMLInputElement;
    if (t.dataset?.shortcut) record(t, false);
  });
  form.addEventListener('keydown', (ev) => {
    const t = ev.target as HTMLInputElement;
    if (!t.dataset?.shortcut) return;
    const clear = (ev.key === 'Backspace' || ev.key === 'Delete') && !ev.metaKey && !ev.ctrlKey && !ev.altKey;
    if (!t.classList.contains('recording')) {
      if (ev.key === 'Enter' || ev.key === ' ') record(t, true);
      else if (clear) {
        t.value = '';
        custom[t.dataset.shortcut] = '';
        conflicts();
      } else return;
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    if (['Meta', 'Control', 'Alt', 'Shift'].includes(ev.key)) return;
    if (ev.key === 'Escape') return record(t, false);
    // Recorded exactly as keyDown will see it: by physical key, so Shift+] or
    // Option+A is stored as itself rather than as "}" or "å", and Ctrl stays Ctrl on a Mac.
    t.value = ev.key === 'Backspace' && !ev.metaKey && !ev.ctrlKey ? '' : eventShortcut(ev);
    custom[t.dataset.shortcut] = t.value;
    conflicts();
  }, true);
  d.querySelector<HTMLInputElement>('.shortcut-filter')!.addEventListener('input', (ev) => {
    const q = (ev.target as HTMLInputElement).value.toLowerCase();
    d.querySelectorAll<HTMLElement>('.shortcut-entry').forEach((row) => (row.hidden = !!q && !row.textContent!.toLowerCase().includes(q)));
  });
  d.querySelector('[data-reset-shortcuts]')!.addEventListener('click', () => {
    setCustomShortcuts({});
    d.close();
    e.message('Keyboard shortcuts reset to defaults.');
  });
  d.querySelector('#cancel-dialog')!.addEventListener('click', () => d.close());
  form.onsubmit = (ev) => {
    ev.preventDefault();
    try {
      localStorage.setItem(shortcutKey, JSON.stringify(custom));
    } catch {
      /* Optional. */
    }
    applyCustomShortcuts();
    d.close();
    e.message('Keyboard shortcuts updated.');
  };
  conflicts();
  d.showModal();
}

export function installArrange(_e: Editor) {
  const many = (n: number) => (e: Editor) => e.selectedIds.size >= n;
  const edges: [Edge, string][] = [['top', 'Top Edges'], ['vcenter', 'Vertical Centers'], ['bottom', 'Bottom Edges'], ['left', 'Left Edges'], ['hcenter', 'Horizontal Centers'], ['right', 'Right Edges']];
  for (const [edge, label] of edges) {
    registerCommand({ id: `layer.align-${edge}`, label, enabled: many(1), run: (e) => align(e, edge) });
    registerCommand({ id: `layer.distribute-${edge}`, label, enabled: many(3), run: (e) => distribute(e, edge) });
  }
  registerCommand(
    { id: 'layer.distribute-h-space', label: 'Horizontal Space', enabled: many(3), run: (e) => distribute(e, 'h-space') },
    { id: 'layer.distribute-v-space', label: 'Vertical Space', enabled: many(3), run: (e) => distribute(e, 'v-space') },
    {
      id: 'layer.reverse',
      label: 'Reverse',
      enabled: many(2),
      run: (e) => {
        const ids = new Set(e.selectedIds);
        e.command('Reverse Layers', (d) => {
          const walk = (list: Layer[]) => {
            const idx = list.map((l, i) => (ids.has(l.id) ? i : -1)).filter((i) => i >= 0);
            const picked = idx.map((i) => list[i]).reverse();
            idx.forEach((i, k) => (list[i] = picked[k]));
            list.forEach((l) => walk(l.children));
          };
          walk(d.layers);
        });
      },
    },
    { id: 'edit.search', label: 'Search', shortcut: 'Mod+F', recordable: false, run: (e) => openSearch(e) },
    { id: 'edit.keyboard-shortcuts', label: 'Keyboard Shortcuts…', shortcut: 'Mod+Alt+Shift+K', recordable: false, run: (e) => shortcutEditor(e) },
  );
}
