// The browser: one keyboard-navigable tree (role tree) with a search field
// that filters every section.
//
//   Instruments  the three instrument types and every preset by category.
//                Click previews, double-click or Enter adds to the rack,
//                drag onto the rack or playlist.
//   Effects      the effect catalog by category. Drag onto a mixer insert;
//                Enter adds to the selected insert.
//   Project      patterns, channels, samples and automation of the open
//                project, updated live (rebuilt only when what it shows changes).
//   My files     signed in: ~/MusicStudio (Projects, Samples, Exports), the
//                home folder and folders picked with the Puter folder picker,
//                listed lazily. Audio previews stream only on an explicit play
//                (temporary read URLs are rate limited), projects open on
//                double-click, files drag into the rack and playlist.
//                Signed out: what the cloud is for, Sign in, and imports from
//                this device.
//   This device  projects saved in this browser.
//
// Keyboard: arrows move and expand, Enter runs the main action, Space
// previews, typing jumps to a matching row, Shift+F10 opens the row's menu,
// Ctrl+F (Cmd+F) focuses the search.

import { h, announce, debounce } from '../lib/dom.js';
import { icon, registerIcons } from '../ui/icons.js';
import { contextMenu, openMenu, isContextKey } from '../ui/menu.js';
import { setDragData } from '../lib/dnd.js';
import { Play, Square, ChevronsDownUp, FolderSearch } from 'lucide';
import * as puter from '../storage/puter.js';
import * as E from '../model/edits.js';
import { FILE_EXT, MAX_FX_SLOTS } from '../model/project.js';
import { EFFECTS } from '../effects/catalog.js';
import { isAudioName } from '../io/wav.js';
import { instrumentNodes, effectNodes, projectNodes, projectSignature, filterNodes, flattenNodes, typeahead, countLeaves } from './browser-items.js';
import '../styles/browser.css';

registerIcons({ 'br-play': Play, 'br-stop': Square, 'collapse-all': ChevronsDownUp, 'folder-search': FolderSearch });

const DEFAULT_OPEN = ['sec:instruments', 'sec:project', 'sec:files'];
const FOLDER_LIMIT = 500;
const SHOWN_EXT = /\.(msproj|midi?)$/i;

export function install(app) {
  app.registerPanel({
    id: 'browser',
    title: 'Browser',
    icon: 'win-browser',
    region: 'side',
    create: (app, host) => createBrowser(app, host),
  });
  app.commands.register({ id: 'browser.search', label: 'Search the browser', keys: ['Mod+F'], scope: 'browser', run: () => app.panel('browser')?.focusSearch?.() });
}

function createBrowser(app, host) {
  const store = app.store;
  const prefs = app.prefs;
  const expanded = new Set(prefs.get('browserExpanded') || DEFAULT_OPEN);
  let query = '';
  let focusId = null;
  let rows = [];
  let visible = true;
  let needsRender = true;

  // ---------------------------------------------------------------- data
  const library = { instruments: instrumentNodes(), effects: effectNodes() };
  let projectSig = '';
  let projectKids = [];
  const syncProject = () => {
    const sig = projectSignature(store.project);
    if (sig === projectSig) return false;
    projectSig = sig;
    projectKids = projectNodes(store.project);
    return true;
  };

  // My files: folder listings cached by path.
  const folders = new Map(); // path -> { loading, items, error }
  const extraRoots = [];
  let dirs = null; // { music, home } once the username is known
  let localProjects = [];
  const playing = { path: null, audio: null };
  const urls = new Map(); // path -> temporary read URL (they are rate limited: reuse)

  const refreshAccount = async () => {
    dirs = null;
    folders.clear();
    if (puter.isSignedIn()) {
      try {
        dirs = { music: await puter.appDir(), home: await puter.homeDir() };
      } catch {
        dirs = null;
      }
    }
    invalidate();
  };
  const refreshLocal = async () => {
    try {
      localProjects = (await app.library?.listLocal()) || [];
    } catch {
      localProjects = [];
    }
    invalidate();
  };

  const loadFolder = async (path, force = false) => {
    if (!puter.isSignedIn()) return;
    const cur = folders.get(path);
    if (cur && !force && (cur.loading || cur.items)) return;
    folders.set(path, { loading: true });
    invalidate();
    try {
      const list = await puter.readdir(path);
      const items = (Array.isArray(list) ? list : list?.items || []).filter((it) => puter.isDir(it) || isAudioName(it.name) || SHOWN_EXT.test(it.name));
      items.sort((a, b) => Number(puter.isDir(b)) - Number(puter.isDir(a)) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
      folders.set(path, { items });
    } catch (err) {
      folders.set(path, { error: err?.code === 'subject_does_not_exist' || err?.status === 404 ? 'missing' : 'error' });
    }
    invalidate();
  };

  const folderNode = (path, label, { root = false } = {}) => {
    const id = `dir:${path}`;
    const state = folders.get(path);
    let children;
    if (state?.items) {
      children = state.items.slice(0, FOLDER_LIMIT).map((it) => (puter.isDir(it) ? folderNode(it.path, it.name) : fileNode(it)));
      if (state.items.length > FOLDER_LIMIT) children.push({ id: `${id}:more`, label: `${state.items.length - FOLDER_LIMIT} more items not shown`, kind: 'note' });
      if (!children.length) children = [{ id: `${id}:empty`, label: 'No audio, project or MIDI files', kind: 'note' }];
    } else if (state?.error) {
      children = [{ id: `${id}:err`, label: state.error === 'missing' ? (root ? 'Nothing saved yet. Projects, samples and exports appear here.' : 'This folder no longer exists') : 'This folder could not be opened', kind: 'note' }];
    } else if (state?.loading) {
      children = [{ id: `${id}:loading`, label: 'Loading...', kind: 'note' }];
    }
    return { id, label, kind: 'folder', icon: 'folder', lazy: !state, children, data: { path } };
  };
  const fileNode = (it) => {
    const audio = isAudioName(it.name);
    const project = it.name.toLowerCase().endsWith(FILE_EXT);
    return {
      id: `file:${it.path}`,
      label: it.name,
      kind: 'file',
      icon: audio ? 'file-audio' : project ? 'file-music' : 'list-music',
      detail: it.size ? sizeText(it.size) : '',
      data: { path: it.path, name: it.name, size: it.size || 0, audio, project, midi: !audio && !project },
    };
  };

  const filesSection = () => {
    if (!puter.sdk()) return [{ id: 'files:offline', label: 'Puter is not available right now. Check your connection, then reload.', kind: 'note' }];
    if (!puter.isSignedIn()) {
      return [
        { id: 'files:why', label: 'Sign in to keep projects, samples and exports in your Puter cloud and open them on any device.', kind: 'note' },
        { id: 'files:signin', label: 'Sign in to Puter', kind: 'action', icon: 'log-in', data: { run: () => app.signIn?.() } },
        { id: 'files:import', label: 'Import audio from this device...', kind: 'action', icon: 'upload', data: { run: () => app.commands.run('file.importAudio') } },
        { id: 'files:open', label: 'Open a project from this device...', kind: 'action', icon: 'folder-open', data: { run: () => app.commands.run('file.openLocal') } },
      ];
    }
    if (!dirs) return [{ id: 'files:loading', label: 'Loading...', kind: 'note' }];
    return [
      folderNode(dirs.music, 'MusicStudio', { root: true }),
      folderNode(dirs.home, 'Home'),
      ...extraRoots.map((p) => folderNode(p, p.slice(p.lastIndexOf('/') + 1) || p)),
      { id: 'files:pick', label: 'Browse another folder...', kind: 'action', icon: 'folder-search', data: { run: pickFolder } },
      { id: 'files:import', label: 'Import audio from this device...', kind: 'action', icon: 'upload', data: { run: () => app.commands.run('file.importAudio') } },
    ];
  };

  const deviceSection = () => {
    if (!localProjects.length) return [{ id: 'dev:none', label: puter.isSignedIn() ? 'No projects saved in this browser' : 'Projects you save while signed out appear here', kind: 'note' }];
    return localProjects.map((m) => ({ id: `local:${m.key}`, label: m.name, kind: 'project', icon: 'file-music', detail: m.key === app.file?.local ? 'Open' : '', data: { local: m.key, name: m.name } }));
  };

  const tree = () => [
    { id: 'sec:instruments', label: 'Instruments', kind: 'section', children: library.instruments },
    { id: 'sec:effects', label: 'Effects', kind: 'section', children: library.effects },
    { id: 'sec:project', label: 'Project', kind: 'section', children: projectKids },
    { id: 'sec:files', label: 'My files', kind: 'section', children: filesSection() },
    { id: 'sec:device', label: 'This device', kind: 'section', children: deviceSection() },
  ];

  // ---------------------------------------------------------------- DOM
  const search = h('input.input.br-search', { type: 'search', placeholder: 'Search instruments, effects, files', 'aria-label': 'Search the browser', autocomplete: 'off', spellcheck: false, 'aria-controls': 'browser-tree' });
  const status = h('div.sr-only', { 'aria-live': 'polite' });
  const treeEl = h('div.br-tree#browser-tree', { role: 'tree', 'aria-label': 'Browser' });
  const emptyEl = h('div.br-empty', { hidden: true });
  const root = h('div.browser', h('div.br-head', h('span.br-search-icon', icon('search', 14)), search), treeEl, emptyEl, status);
  host.body.append(root);

  const toolbar = h(
    'div.br-tools',
    h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Import audio', title: 'Import audio files', onclick: () => app.commands.run('file.importAudio') }, icon('upload', 14)),
    h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Collapse all', title: 'Collapse all', onclick: collapseAll }, icon('collapse-all', 14)),
  );

  function invalidate() {
    needsRender = true;
    if (visible) scheduleRender();
  }
  const scheduleRender = debounce(() => render(), 16);

  function render() {
    needsRender = false;
    const nodes = filterNodes(tree(), query);
    rows = flattenNodes(nodes, expanded, { expandAll: Boolean(query) });
    const hadFocus = treeEl.contains(document.activeElement);
    if (!rows.some((r) => r.node.id === focusId)) focusId = rows.find((r) => r.node.kind !== 'note')?.node.id || rows[0]?.node.id || null;
    const view = store.view;
    const frag = document.createDocumentFragment();
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    for (const r of rows) frag.append(rowEl(r, view, words));
    treeEl.replaceChildren(frag);
    emptyEl.hidden = Boolean(rows.length);
    if (!rows.length) emptyEl.replaceChildren(h('p', `Nothing matches "${query}".`), h('button.btn.sm', { type: 'button', onclick: () => setQuery('') }, 'Clear search'));
    if (hadFocus) focusRow(focusId, false);
  }

  function rowEl(r, view, words) {
    const n = r.node;
    const cls = ['br-row', `k-${n.kind}`];
    if (n.kind === 'pattern' && n.data.id === view.pattern) cls.push('current');
    if (n.kind === 'channel' && view.selectedChannels.has(n.data.id)) cls.push('current');
    if (n.kind === 'file' && playing.path === n.data.path) cls.push('playing');
    const draggable = ['instrument', 'preset', 'effect', 'pattern', 'channel', 'file', 'sample'].includes(n.kind);
    const el = h(`div.${cls.join('.')}`, {
      role: 'treeitem',
      id: rowDomId(n.id),
      tabindex: n.id === focusId ? '0' : '-1',
      'aria-level': String(r.level),
      'aria-setsize': String(r.size),
      'aria-posinset': String(r.pos),
      'aria-expanded': r.expandable ? String(r.open) : null,
      'aria-selected': n.id === focusId ? 'true' : 'false',
      'aria-disabled': n.kind === 'note' ? 'true' : null,
      'aria-description': n.detail || null,
      draggable: draggable ? 'true' : null,
      dataset: { id: n.id },
      style: { '--level': String(r.level - 1) },
    });
    el.append(h('span.br-chev', r.expandable ? icon(r.open ? 'chevron-down' : 'chevron-right', 12) : null));
    if (n.kind !== 'section' && n.kind !== 'note') {
      el.append(h('span.br-icon', n.color ? { style: { color: n.color } } : {}, icon(n.icon || (n.kind === 'group' ? 'folder' : 'music'), 14)));
    }
    el.append(h('span.br-label', highlight(n.label, words)));
    if (n.count !== undefined) el.append(h('span.br-count', String(n.count)));
    else if (n.detail && n.kind !== 'instrument' && n.kind !== 'effect') el.append(h('span.br-detail', n.detail));
    if (n.kind === 'file' && n.data.audio) {
      const on = playing.path === n.data.path;
      el.append(h('button.icon-btn.xs.br-play', { type: 'button', tabindex: '-1', 'aria-label': on ? `Stop ${n.label}` : `Preview ${n.label}`, title: on ? 'Stop preview' : 'Preview (Space)', dataset: { action: 'preview' } }, icon(on ? 'br-stop' : 'br-play', 12)));
    }
    if (n.detail && (n.kind === 'instrument' || n.kind === 'effect')) el.title = n.detail;
    return el;
  }

  function highlight(label, words) {
    if (!words.length) return label;
    const lower = label.toLowerCase();
    const w = words.find((x) => lower.includes(x));
    if (!w) return label;
    const i = lower.indexOf(w);
    return [label.slice(0, i), h('mark', label.slice(i, i + w.length)), label.slice(i + w.length)];
  }

  const rowDomId = (id) => `br-${id.replace(/[^\w-]/g, '_')}`;
  const rowIndex = (id) => rows.findIndex((r) => r.node.id === id);
  const rowAt = (id) => rows[rowIndex(id)] || null;

  function focusRow(id, scroll = true) {
    if (!id) return;
    const prev = treeEl.querySelector('[tabindex="0"]');
    const el = document.getElementById(rowDomId(id));
    if (!el) return;
    if (prev && prev !== el) {
      prev.tabIndex = -1;
      prev.setAttribute('aria-selected', 'false');
    }
    focusId = id;
    el.tabIndex = 0;
    el.setAttribute('aria-selected', 'true');
    el.focus({ preventScroll: !scroll });
    if (scroll) el.scrollIntoView({ block: 'nearest' });
  }

  function setExpanded(id, open) {
    if (open === expanded.has(id)) return;
    if (open) expanded.add(id);
    else expanded.delete(id);
    prefs.set('browserExpanded', [...expanded].filter((x) => x.startsWith('sec:') || x.startsWith('grp:') || x.startsWith('cat:') || x.startsWith('fxcat:') || x.startsWith('prj:')));
    const row = rowAt(id);
    if (open && row?.node.kind === 'folder') loadFolder(row.node.data.path);
    render();
  }

  function toggle(row) {
    if (!row?.expandable) return;
    if (query) {
      // While searching every group is open; clear the search to browse instead.
      return;
    }
    setExpanded(row.node.id, !row.open);
  }

  function collapseAll() {
    expanded.clear();
    expanded.add('sec:instruments');
    prefs.set('browserExpanded', [...expanded]);
    render();
  }

  function setQuery(q) {
    query = q;
    if (search.value !== q) search.value = q;
    render();
    if (q) {
      const n = countLeaves(filterNodes(tree(), q));
      status.textContent = n ? `${n} result${n === 1 ? '' : 's'}` : 'No results';
    }
  }

  // ---------------------------------------------------------------- actions
  let stopAudition = null;
  const stopPreview = () => {
    stopAudition?.();
    stopAudition = null;
    if (playing.audio) {
      playing.audio.pause();
      playing.audio.removeAttribute('src');
      playing.audio.load();
    }
    if (playing.path) {
      playing.path = null;
      invalidate();
    }
  };

  async function audition(spec, ms) {
    stopPreview();
    const engine = app.engine;
    if (!engine?.audition) return;
    try {
      await engine.start();
      const stop = engine.audition(spec, spec.type === 'drum' ? 60 : 60, 0.8);
      stopAudition = typeof stop === 'function' ? stop : null;
      const mine = stopAudition;
      if (mine) setTimeout(() => {
        if (stopAudition === mine) {
          mine();
          stopAudition = null;
        }
      }, ms);
    } catch (err) {
      console.warn('Music Studio: preview failed.', err);
    }
  }

  async function previewFile(data) {
    if (playing.path === data.path) {
      stopPreview();
      return;
    }
    stopPreview();
    if (!puter.isSignedIn()) return;
    playing.path = data.path;
    invalidate();
    try {
      let url = urls.get(data.path);
      if (!url) {
        try {
          url = await puter.readURL(data.path, '2h');
        } catch {
          // Read URLs are rate limited: fall back to downloading the file once.
          url = URL.createObjectURL(await puter.readFile(data.path));
        }
        urls.set(data.path, url);
      }
      if (playing.path !== data.path) return;
      playing.audio ||= new Audio();
      playing.audio.onended = () => {
        if (playing.path === data.path) stopPreview();
      };
      playing.audio.src = url;
      await playing.audio.play();
      announce(`Previewing ${data.name}`);
    } catch (err) {
      if (playing.path === data.path) stopPreview();
      app.notify(`${data.name} could not be previewed: ${puter.errorMessage(err)}`, { error: true });
    }
  }

  const selectedInsert = () => {
    const t = app.panel('mixer')?.selectedTrack;
    if (Number.isInteger(t) && t >= 0 && t < store.project.mixer.length) return t;
    const ch = store.channel;
    return ch && ch.mixer > 0 ? ch.mixer : 1;
  };

  function addEffect(type, track = selectedInsert()) {
    const t = store.project.mixer[track];
    if (!t) return;
    if (t.fx.length >= MAX_FX_SLOTS) {
      app.notify(`${t.name} already has ${MAX_FX_SLOTS} effects`, { error: true });
      return;
    }
    const r = store.apply('Add effect', (p) => E.addSlot(p, track, type));
    app.notify(`Added ${EFFECTS[type]?.label || type} to ${t.name}`);
    if (r?.id) app.openEffectEditor?.(track, r.id);
  }

  function addPreset(data) {
    app.addChannel({ type: data.type, name: data.name, params: data.params });
  }

  async function importFile(data, as = 'sampler') {
    try {
      await app.importAudioFromPath?.(data.path, { as });
      app.notify(`Imported ${data.name}`);
    } catch (err) {
      app.notify(err?.message || `${data.name} could not be imported.`, { error: true });
    }
  }

  async function openFileNode(data) {
    if (data.project) return app.openProjectPath?.(data.path);
    if (data.midi) return app.files?.importMidiBlob(await puter.readFile(data.path), data.name);
    return importFile(data);
  }

  async function pickFolder() {
    try {
      const dir = await puter.pickDirectory();
      if (!dir?.path) return;
      if (!extraRoots.includes(dir.path)) extraRoots.push(dir.path);
      expanded.add(`dir:${dir.path}`);
      loadFolder(dir.path);
      render();
      focusRow(`dir:${dir.path}`);
    } catch (err) {
      app.reportError(err);
    }
  }

  /** Single click (and Space): select or preview. */
  function preview(row) {
    const n = row.node;
    const d = n.data;
    switch (n.kind) {
      case 'instrument':
        if (d.type !== 'sampler') audition({ type: d.type, params: d.params }, d.type === 'drum' ? 1500 : 700);
        break;
      case 'preset':
        audition({ type: d.type, params: d.params }, d.type === 'drum' ? 1500 : 700);
        break;
      case 'pattern':
        store.setPattern(d.id);
        break;
      case 'channel':
        store.selectChannels([d.id]);
        break;
      case 'sample':
        if (app.samples.has(d.id)) audition({ type: 'sampler', sample: d.id, params: {} }, 3000);
        break;
      case 'file':
        if (d.audio) previewFile(d);
        break;
      default:
    }
  }

  /** Double click and Enter: the main action. */
  function activate(row) {
    const n = row.node;
    const d = n.data;
    switch (n.kind) {
      case 'section':
      case 'group':
      case 'folder':
        toggle(row);
        break;
      case 'instrument':
      case 'preset':
        stopPreview();
        addPreset(d);
        break;
      case 'effect':
        addEffect(d.type);
        break;
      case 'pattern':
        store.setPattern(d.id);
        app.shell.show('rack', { focus: false });
        break;
      case 'channel':
        if (app.openChannelEditor) app.openChannelEditor(d.id);
        else store.selectChannels([d.id]);
        break;
      case 'sample':
        app.addChannel({ type: 'sampler', name: store.project.samples[d.id]?.name?.replace(/\.[^.]+$/, '') || 'Sampler', sample: d.id });
        break;
      case 'file':
        stopPreview();
        openFileNode(d).catch((err) => app.reportError(err));
        break;
      case 'project':
        app.openLocalProject?.(d.local).catch((err) => app.reportError(err));
        break;
      case 'action':
        d.run?.();
        break;
      default:
    }
  }

  function menuFor(row) {
    const n = row.node;
    const d = n.data;
    const items = [];
    switch (n.kind) {
      case 'instrument':
      case 'preset':
        items.push({ type: 'cmd', label: 'Add to channel rack', keys: 'Enter', run: () => addPreset(d) });
        if (d.type !== 'sampler') items.push({ type: 'cmd', label: 'Preview', keys: 'Space', run: () => preview(row) });
        break;
      case 'effect': {
        const insert = selectedInsert();
        items.push({ type: 'cmd', label: `Add to ${store.project.mixer[insert]?.name || `insert ${insert}`}`, keys: 'Enter', run: () => addEffect(d.type, insert) });
        items.push({ type: 'cmd', label: 'Add to master', run: () => addEffect(d.type, 0) });
        break;
      }
      case 'pattern':
        items.push({ type: 'cmd', label: 'Select pattern', run: () => store.setPattern(d.id) });
        items.push({ type: 'cmd', label: 'Rename...', run: () => (store.setPattern(d.id), app.commands.run('patterns.rename')) });
        items.push({ type: 'cmd', label: 'Clone', run: () => (store.setPattern(d.id), app.commands.run('patterns.clone')) });
        break;
      case 'channel':
        items.push({ type: 'cmd', label: 'Select channel', run: () => store.selectChannels([d.id]) });
        if (app.openChannelEditor) items.push({ type: 'cmd', label: 'Open instrument', keys: 'Enter', run: () => app.openChannelEditor(d.id) });
        break;
      case 'sample':
        items.push({ type: 'cmd', label: 'Add as sampler channel', keys: 'Enter', run: () => activate(row) });
        break;
      case 'file':
        if (d.audio) {
          items.push({ type: 'cmd', label: playing.path === d.path ? 'Stop preview' : 'Preview', keys: 'Space', run: () => previewFile(d) });
          items.push({ type: 'cmd', label: 'Add as sampler channel', keys: 'Enter', run: () => importFile(d, 'sampler') });
          items.push({ type: 'cmd', label: 'Add as audio clip channel', run: () => importFile(d, 'audio') });
        } else if (d.project) items.push({ type: 'cmd', label: 'Open project', keys: 'Enter', run: () => activate(row) });
        else items.push({ type: 'cmd', label: 'Import MIDI', keys: 'Enter', run: () => activate(row) });
        break;
      case 'folder':
        items.push({ type: 'cmd', label: row.open ? 'Collapse' : 'Expand', run: () => toggle(row) });
        items.push({ type: 'cmd', label: 'Refresh', run: () => loadFolder(d.path, true) });
        break;
      case 'project':
        items.push({ type: 'cmd', label: 'Open project', keys: 'Enter', run: () => activate(row) });
        items.push({ type: 'cmd', label: 'Manage saved projects...', run: () => app.openLocalProjects?.() });
        break;
      default:
        if (row.expandable) items.push({ type: 'cmd', label: row.open ? 'Collapse' : 'Expand', run: () => toggle(row) });
    }
    return items;
  }

  function dragPayload(n) {
    const d = n.data;
    switch (n.kind) {
      case 'instrument':
        return { kind: 'instrument', type: d.type };
      case 'preset':
        return { kind: 'preset', type: d.type, name: d.name, params: d.params };
      case 'effect':
        return { kind: 'effect', type: d.type };
      case 'pattern':
        return { kind: 'pattern', id: d.id };
      case 'channel':
        return { kind: 'channel', id: d.id };
      case 'sample':
        return { kind: 'sample', id: d.id, name: n.label };
      case 'file':
        return { kind: 'file', path: d.path, name: d.name, size: d.size };
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------- events
  const rowFromEvent = (e) => {
    const el = e.target.closest?.('.br-row');
    return el ? rowAt(el.dataset.id) : null;
  };

  treeEl.addEventListener('click', (e) => {
    const row = rowFromEvent(e);
    if (!row) return;
    focusRow(row.node.id, false);
    if (e.target.closest('[data-action="preview"]')) {
      previewFile(row.node.data);
      return;
    }
    if (row.node.kind === 'action') {
      activate(row);
      return;
    }
    if (row.expandable && (e.target.closest('.br-chev') || ['section', 'group', 'folder'].includes(row.node.kind))) {
      toggle(row);
      return;
    }
    if (row.node.kind !== 'file') preview(row);
  });
  treeEl.addEventListener('dblclick', (e) => {
    const row = rowFromEvent(e);
    if (!row || row.expandable || row.node.kind === 'action' || e.target.closest('button')) return;
    activate(row);
  });
  treeEl.addEventListener('contextmenu', (e) => {
    const row = rowFromEvent(e);
    if (!row) return;
    const items = menuFor(row);
    if (!items.length) return;
    focusRow(row.node.id, false);
    contextMenu(e, items, row.node.label);
  });
  treeEl.addEventListener('dragstart', (e) => {
    const row = rowFromEvent(e);
    const payload = row && dragPayload(row.node);
    if (!payload) {
      e.preventDefault();
      return;
    }
    stopPreview();
    setDragData(e, payload, row.node.label);
  });

  let typed = '';
  let typedAt = 0;
  treeEl.addEventListener('keydown', (e) => {
    const i = rowIndex(focusId);
    const row = rows[i];
    if (!row) return;
    const go = (j) => {
      const k = Math.max(0, Math.min(rows.length - 1, j));
      focusRow(rows[k].node.id);
    };
    const page = Math.max(1, Math.floor(treeEl.clientHeight / 28) - 1);
    if (isContextKey(e)) {
      e.preventDefault();
      const items = menuFor(row);
      const el = document.getElementById(rowDomId(row.node.id));
      if (items.length && el) openMenu(items, { anchor: el, label: row.node.label });
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case 'ArrowDown':
        go(i + 1);
        break;
      case 'ArrowUp':
        go(i - 1);
        break;
      case 'Home':
        go(0);
        break;
      case 'End':
        go(rows.length - 1);
        break;
      case 'PageDown':
        go(i + page);
        break;
      case 'PageUp':
        go(i - page);
        break;
      case 'ArrowRight':
        if (row.expandable && !row.open) toggle(row);
        else if (row.open) go(i + 1);
        break;
      case 'ArrowLeft':
        if (row.expandable && row.open && !query) toggle(row);
        else if (row.parent) focusRow(row.parent);
        break;
      case 'Enter':
        activate(row);
        break;
      case ' ':
        if (row.expandable) toggle(row);
        else if (row.node.kind === 'action') activate(row);
        else preview(row);
        break;
      case 'Escape':
        if (playing.path || stopAudition) stopPreview();
        else if (query) setQuery('');
        else return;
        break;
      default:
        if (e.key.length === 1 && e.key !== ' ') {
          const now = performance.now();
          typed = now - typedAt > 700 ? e.key : typed + e.key;
          typedAt = now;
          const j = typeahead(rows, i, typed);
          if (j >= 0) go(j);
          break;
        }
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  });

  search.addEventListener('input', debounce(() => setQuery(search.value), 120));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && rows.length) {
      e.preventDefault();
      focusRow(rows.find((r) => r.node.kind !== 'section' && r.node.kind !== 'note')?.node.id || rows[0].node.id);
    } else if (e.key === 'Escape' && search.value) {
      e.preventDefault();
      e.stopPropagation();
      setQuery('');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const first = rows.find((r) => !['section', 'group', 'note', 'folder'].includes(r.node.kind));
      if (first) {
        focusRow(first.node.id);
        activate(first);
      }
    }
  });

  // Audio and project files dropped from the operating system onto the browser.
  root.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      root.classList.add('drop-target');
    }
  });
  root.addEventListener('dragleave', (e) => {
    if (!root.contains(e.relatedTarget)) root.classList.remove('drop-target');
  });
  root.addEventListener('drop', (e) => {
    root.classList.remove('drop-target');
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    (async () => {
      for (const f of files) {
        try {
          const r = await app.files?.openFile(f);
          if (r?.sampleId) app.notify(`Imported ${f.name}`);
        } catch (err) {
          app.notify(err?.message || `${f.name} could not be opened.`, { error: true });
        }
      }
    })();
  });

  // ---------------------------------------------------------------- live updates
  store.on('change', (p, prev) => {
    if (p.patterns === prev.patterns && p.channels === prev.channels && p.samples === prev.samples && p.automation === prev.automation) return;
    if (syncProject()) invalidate();
  });
  store.on('view', () => invalidate());
  app.on('account', refreshAccount);
  app.on('file', refreshLocal);
  app.on('saving', () => {
    if (!app.saving) refreshLocal();
  });
  syncProject();
  refreshAccount();
  refreshLocal();
  render();

  return {
    toolbar,
    onShow() {
      visible = true;
      if (needsRender) render();
    },
    onHide() {
      visible = false;
      stopPreview();
    },
    focus() {
      if (focusId && rowAt(focusId)) focusRow(focusId);
      else search.focus();
    },
    focusSearch() {
      search.focus();
      search.select();
    },
  };
}

function sizeText(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
