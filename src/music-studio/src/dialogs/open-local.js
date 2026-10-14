// "Open project" while signed out: the projects saved in this browser, with
// download and delete, plus opening a file from the device and a pointer to
// cloud storage. A listbox: arrows move, Enter opens, Delete removes.

import { h, announce } from '../lib/dom.js';
import { openDialog, confirmDialog } from '../ui/dialog.js';
import { icon } from '../ui/icons.js';
import { downloadBlob, safeFileName } from '../io/download.js';
import { FILE_EXT } from '../model/project.js';
import * as puter from '../storage/puter.js';

/** "Today 14:05", "Yesterday", "3 Oct" (pure, `now` injectable). */
export function formatWhen(ms, now = Date.now()) {
  const d = new Date(ms);
  const today = new Date(now);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(today) - day(d)) / 86400000);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Yesterday ${time}`;
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

const size = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export async function openLocalProjects(app) {
  const lib = app.library;
  let items = await lib.listLocal();
  let selected = items.find((m) => m.key === app.file?.local)?.key || items[0]?.key || null;
  const list = h('div.lp-list', { role: 'listbox', 'aria-label': 'Projects saved in this browser', tabindex: '0', 'data-own-enter': '' });
  const empty = h('div.lp-empty', h('p', 'No projects are saved in this browser yet.'), h('p.faint', 'Use File > Save to keep the current project here.'));
  let closeDialog = null;

  const render = () => {
    list.replaceChildren();
    empty.hidden = items.length > 0;
    list.hidden = !items.length;
    for (const m of items) {
      const row = h(
        'div.lp-row',
        { role: 'option', id: `lp-${m.key}`, 'aria-selected': String(m.key === selected), dataset: { key: m.key } },
        h('span.lp-icon', icon('file-music', 16)),
        h('span.lp-name', m.name, m.key === app.file?.local ? h('span.lp-badge', 'Open') : null),
        h('span.lp-meta.faint', `${formatWhen(m.modified)}, ${size(m.size || 0)}`),
        h('button.icon-btn.sm', { type: 'button', tabindex: '-1', 'aria-label': `Download ${m.name}`, title: 'Save to your device', onclick: (e) => (e.stopPropagation(), download(m)) }, icon('download', 14)),
        h('button.icon-btn.sm', { type: 'button', tabindex: '-1', 'aria-label': `Delete ${m.name}`, title: 'Delete from this browser', onclick: (e) => (e.stopPropagation(), remove(m)) }, icon('trash-2', 14)),
      );
      row.addEventListener('click', () => select(m.key));
      row.addEventListener('dblclick', () => open(m.key));
      list.append(row);
    }
    if (selected) list.setAttribute('aria-activedescendant', `lp-${selected}`);
    else list.removeAttribute('aria-activedescendant');
  };
  const select = (key) => {
    selected = key;
    for (const r of list.children) r.setAttribute('aria-selected', String(r.dataset.key === key));
    list.setAttribute('aria-activedescendant', `lp-${key}`);
    list.querySelector(`[data-key="${key}"]`)?.scrollIntoView({ block: 'nearest' });
  };
  const open = async (key) => {
    if (!key) return;
    closeDialog?.(null);
    await app.files.openLocalKey(key).catch((err) => app.reportError(err));
  };
  const download = async (m) => {
    try {
      const project = await lib.loadLocal(m.key);
      const { blob } = await lib.exportFile(project, {});
      downloadBlob(blob, `${safeFileName(m.name)}${FILE_EXT}`);
    } catch (err) {
      app.reportError(err);
    }
  };
  const remove = async (m) => {
    const ok = await confirmDialog({ title: 'Delete project', message: `Delete "${m.name}" from this browser? This cannot be undone.`, confirm: 'Delete', danger: true });
    if (!ok) return;
    await lib.deleteLocal(m.key);
    if (app.file?.local === m.key) app.files.setFile(null);
    items = await lib.listLocal();
    if (selected === m.key) selected = items[0]?.key || null;
    render();
    announce(`Deleted ${m.name}`);
    list.focus();
  };
  list.addEventListener('keydown', (e) => {
    const i = items.findIndex((m) => m.key === selected);
    const moves = { ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity };
    if (e.key in moves && items.length) {
      e.preventDefault();
      select(items[Math.max(0, Math.min(items.length - 1, (i < 0 ? 0 : i) + moves[e.key]))].key);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      open(selected);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
      e.preventDefault();
      remove(items[i]);
    }
  });
  render();

  const canSignIn = Boolean(puter.sdk()) && puter.env() !== 'app' && !puter.isSignedIn();
  const body = h(
    'div.local-projects',
    list,
    empty,
    canSignIn
      ? h('div.lp-cloud', icon('cloud', 16), h('span', 'Sign in to Puter to save projects to your cloud and open them on any device.'), h('button.btn.sm', { type: 'button', onclick: () => (closeDialog?.(null), app.signIn?.()) }, 'Sign in'))
      : null,
  );
  const footerStart = h('button.btn', { type: 'button', onclick: () => (closeDialog?.(null), app.commands.run('file.openLocal')) }, icon('upload', 14), h('span', 'Open from this device...'));
  const r = await openDialog({
    title: 'Open project',
    wide: true,
    className: 'dlg-open-local',
    body: (close) => {
      closeDialog = close;
      return body;
    },
    footerStart,
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Open', value: 'open', primary: true, disabled: !items.length },
    ],
    initialFocus: '.lp-list',
  });
  if (r === 'open') await open(selected);
}
