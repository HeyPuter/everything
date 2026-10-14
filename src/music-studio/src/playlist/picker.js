// Clip source picker: the column left of the track headers listing patterns,
// audio clip channels and automation, each with its color. Click selects the
// source the Draw and Paint tools place; double-click (or Enter) opens it;
// sources drag onto tracks; right-click opens rename, color, clone, delete.

import { h } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { setDragData } from '../lib/dnd.js';
import { isContextKey } from '../ui/menu.js';
import { sourceColor, sourceName } from './clips.js';

const sameSrc = (a, b) => a && b && a.kind === b.kind && a.id === b.id;

/** Sources of a project in picker order: [{ kind, id }]. */
export function listSources(project) {
  return [
    ...project.patterns.map((p) => ({ kind: 'pattern', id: p.id })),
    ...project.channels.filter((c) => c.type === 'audio').map((c) => ({ kind: 'audio', id: c.id })),
    ...Object.keys(project.automation).map((id) => ({ kind: 'auto', id })),
  ];
}

export function createPicker(V) {
  const { app, store } = V;
  const list = h('ul.pl-src-list', { role: 'listbox', 'aria-label': 'Clip sources' });
  const el = h('div.pl-picker', list);
  let items = []; // { src, li }
  let focusKey = '';

  const keyOf = (src) => `${src.kind}:${src.id}`;

  function heading(label, addCmd, addLabel) {
    const add = addCmd && app.commands.has(addCmd)
      ? h('button.icon-btn.xs', { type: 'button', 'aria-label': addLabel, title: addLabel, onclick: () => app.commands.run(addCmd) }, icon('plus', 12))
      : null;
    return h('li.pl-src-head', { role: 'presentation' }, h('span', label), add);
  }

  function option(src, project, uses) {
    const name = sourceName(project, src);
    const glyph = src.kind === 'pattern' ? null : src.kind === 'audio' ? 'audio' : 'automation';
    const li = h(
      'li.pl-src',
      {
        role: 'option',
        tabindex: '-1',
        draggable: 'true',
        'aria-selected': 'false',
        dataset: { key: keyOf(src), hint: `${name}: click to draw with it, double-click to open, drag onto a track` },
      },
      h('span.pl-src-swatch', { style: { background: sourceColor(project, src) }, 'aria-hidden': 'true' }, glyph ? icon(glyph, 10) : null),
      h('span.pl-src-name', name),
      uses ? h('span.pl-src-uses', { 'aria-hidden': 'true', title: `${uses} clip${uses === 1 ? '' : 's'} in the playlist` }, String(uses)) : null,
    );
    li.setAttribute('aria-label', `${name}${src.kind === 'audio' ? ', audio' : src.kind === 'auto' ? ', automation' : ''}, ${uses ? `${uses} clip${uses === 1 ? '' : 's'}` : 'unused'}`);
    li.addEventListener('click', () => {
      V.setSource(src);
      focusItem(src);
    });
    li.addEventListener('dblclick', () => V.openSource(src));
    li.addEventListener('dragstart', (e) => {
      const payload = src.kind === 'pattern' ? { kind: 'pattern', id: src.id } : src.kind === 'audio' ? { kind: 'channel', id: src.id } : { kind: 'automation', id: src.id };
      setDragData(e, payload, name);
    });
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      V.setSource(src);
      V.sourceMenu(src, { x: e.clientX, y: e.clientY });
    });
    return li;
  }

  function render() {
    const project = store.project;
    const uses = new Map();
    for (const c of project.clips) {
      const k = `${c.kind}:${c.ref}`;
      uses.set(k, (uses.get(k) || 0) + 1);
    }
    const hadFocus = list.contains(document.activeElement);
    items = [];
    const nodes = [heading('Patterns', 'patterns.new', 'New pattern')];
    const sources = listSources(project);
    const add = (src) => {
      const li = option(src, project, uses.get(keyOf(src)) || 0);
      items.push({ src, li });
      nodes.push(li);
    };
    sources.filter((s) => s.kind === 'pattern').forEach(add);
    const audio = sources.filter((s) => s.kind === 'audio');
    nodes.push(heading('Audio clips'));
    if (audio.length) audio.forEach(add);
    else nodes.push(h('li.pl-src-empty', { role: 'presentation' }, 'Drop audio files on a track'));
    const autos = sources.filter((s) => s.kind === 'auto');
    nodes.push(heading('Automation', 'add.automation', 'Add automation clip'));
    if (autos.length) autos.forEach(add);
    else nodes.push(h('li.pl-src-empty', { role: 'presentation' }, 'Automate the last tweaked control from the Add menu'));
    list.replaceChildren(...nodes);
    sync();
    if (hadFocus) items.find((it) => keyOf(it.src) === focusKey)?.li.focus({ preventScroll: true });
  }

  /** Marks the selected source and keeps one option tabbable. */
  function sync() {
    let tabbable = null;
    for (const it of items) {
      const on = sameSrc(it.src, V.source);
      it.li.setAttribute('aria-selected', String(on));
      it.li.classList.toggle('current', it.src.kind === 'pattern' && it.src.id === store.view.pattern);
      it.li.tabIndex = -1;
      if (on) tabbable = it.li;
    }
    (tabbable || items[0]?.li)?.setAttribute('tabindex', '0');
  }

  function focusItem(src) {
    const it = items.find((x) => sameSrc(x.src, src));
    if (!it) return;
    focusKey = keyOf(src);
    for (const x of items) x.li.tabIndex = x === it ? 0 : -1;
    it.li.focus({ preventScroll: false });
  }

  list.addEventListener('keydown', (e) => {
    const i = items.findIndex((it) => it.li === document.activeElement);
    if (i < 0) return;
    const move = (j) => {
      e.preventDefault();
      const it = items[Math.max(0, Math.min(items.length - 1, j))];
      V.setSource(it.src);
      focusItem(it.src);
    };
    if (e.key === 'ArrowDown') move(i + 1);
    else if (e.key === 'ArrowUp') move(i - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(items.length - 1);
    else if (e.key === 'Enter') {
      e.preventDefault();
      V.openSource(items[i].src);
    } else if (isContextKey(e)) {
      e.preventDefault();
      const r = items[i].li.getBoundingClientRect();
      V.sourceMenu(items[i].src, { x: r.left + 16, y: r.bottom });
    } else if (e.key === 'F2') {
      e.preventDefault();
      e.stopPropagation();
      V.renameSource(items[i].src);
    }
  });

  return { el, render, sync };
}
