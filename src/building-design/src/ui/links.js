/**
 * Linking other projects: choose a project file, place it origin to
 * origin, and manage (reload, remove) the links of the open project.
 */
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { openDialog, toast, confirmDialog } from './dialog.js';
import { decodeProject, baseName } from '../io/native.js';
import { cloudList, cloudRead, deviceOpen, usePuterPickers, puterOpenPicker } from '../io/storage.js';
import { isSignedIn, puterAvailable } from '../platform.js';
import { linkData } from '../core/links.js';
import { upgradeDoc } from '../core/template.js';
import { MODEL_KINDS } from '../core/scene.js';
import { groupFromProject } from '../core/groups.js';
import { packParts } from '../core/imported.js';

function modelCount(doc) {
  let n = 0;
  for (const k of MODEL_KINDS) if (k !== 'link') n += doc.count(k);
  return n;
}

/** Ask where the project to link is: resolves to { name, path?, buffer } or null. */
export async function chooseProject(app) {
  if (usePuterPickers()) {
    try {
      return await puterOpenPicker();
    } catch {
      return null;
    }
  }
  const signed = puterAvailable() && (await isSignedIn().catch(() => false));
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      document.querySelector('dialog[open]')?._close?.(null);
      resolve(v);
    };
    const list = h('ul.file-list', { role: 'list' });
    const body = h(
      'div',
      h('p.dialog-text', 'The linked project is shown in this one, read-only, and moves and rotates as a whole. A copy is kept with this project; reload it when the original changes.'),
      h('div', { style: { margin: '12px 0' } }, h('button.btn', { type: 'button', onClick: async () => {
        const f = await deviceOpen();
        if (f) finish({ name: f.name, buffer: f.buffer });
      } }, icon('device', 16), 'Choose a file on this device')),
      signed ? h('h3.dlg-sub', 'Your projects in Puter') : h('p.field-hint', 'Sign in to link projects from your Puter storage.'),
      list,
    );
    if (signed)
      cloudList()
        .then(({ items }) => {
          clear(list);
          if (!items.length) list.append(h('li.file-empty', 'No projects in Puter yet.'));
          for (const f of items)
            list.append(h('li', h('button.file-item', { type: 'button', onClick: async () => finish({ name: f.name, path: f.path, buffer: await cloudRead(f.path) }) }, icon('cloud', 16), h('span.file-name', baseName(f.name)))));
        })
        .catch(() => list.append(h('li.file-empty', 'Could not list your projects.')));
    openDialog({ title: 'Link Project', body, size: 'md', actions: [{ label: 'Cancel', value: null }] }).then(() => finish(null));
    void app;
  });
}

async function readLinked(src) {
  const doc = upgradeDoc(await decodeProject(src.buffer));
  return doc;
}

export async function linkProject(app) {
  const src = await chooseProject(app);
  if (!src) return;
  let linked;
  try {
    linked = await readLinked(src);
  } catch (err) {
    return toast(err.message || 'That file could not be read.', { kind: 'error' });
  }
  let el;
  app.commit('Link project', () => (el = app.doc.add({ kind: 'link', name: baseName(src.name), path: src.path || null, data: linkData(linked), at: [0, 0], rotation: 0, z: 0 })));
  app.select([el.id]);
  toast(`Linked ${el.name} (${modelCount(linked)} elements), origin to origin. Move or rotate it into place.`, { kind: 'success' });
}

/** Load a newer copy of a link from where it came from, or from a file the user picks. */
export async function reloadLink(app, id, pick = false) {
  const el = app.doc.get(id);
  if (!el) return;
  let src = null;
  try {
    if (!pick && el.path && puterAvailable()) src = { name: el.name, path: el.path, buffer: await cloudRead(el.path) };
    else src = await chooseProject(app);
  } catch (err) {
    return toast(`Could not read ${el.path}: ${err.message || err}. Use Reload From to choose the file.`, { kind: 'error' });
  }
  if (!src) return;
  try {
    const linked = await readLinked(src);
    app.commit('Reload link', () => app.doc.update(id, { data: linkData(linked), path: src.path || el.path || null }));
    toast(`Reloaded ${el.name}.`, { kind: 'success' });
  } catch (err) {
    toast(err.message || 'That file could not be read.', { kind: 'error' });
  }
}

/**
 * Load another project's ground floor as a model group type (with any of
 * its types and materials this project lacks), then place it.
 */
export async function loadAsGroup(app) {
  const src = await chooseProject(app);
  if (!src) return;
  let other;
  try {
    other = await readLinked(src);
  } catch (err) {
    return toast(err.message || 'That file could not be read.', { kind: 'error' });
  }
  const doc = app.doc;
  let type;
  try {
    app.commit('Load as group', () => (type = groupFromProject(other, doc, baseName(src.name))));
  } catch (err) {
    return toast(err.message, { kind: 'error' });
  }
  if (!type) return toast('That project has no model elements on its first level.', { kind: 'error' });
  app.placeType(type, 'group');
  toast(`Loaded ${type.name} as a group (${type.members.length} elements). Click to place it.`, { kind: 'success' });
}

/** Show an IFC file from another tool in this project, read-only. */
export async function linkIFC(app) {
  const input = h('input', { type: 'file', accept: '.ifc' });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    app.setPrompt(`Reading ${file.name}...`);
    let read;
    try {
      const { readIFC } = await import('../io/ifcread.js');
      read = readIFC(await file.text());
    } catch (err) {
      console.error(err);
      return toast(`Could not read ${file.name}: ${err.message || err}`, { kind: 'error' });
    }
    if (!read.parts.length) return toast('No geometry this app can read was found in that file.', { kind: 'error' });
    const packed = packParts(read);
    let el;
    app.commit('Link IFC', () => (el = app.doc.add({ kind: 'importedModel', name: read.name || file.name, source: file.name, at: [0, 0], rotation: 0, z: 0, ...packed })));
    app.select([el.id]);
    toast(`Placed ${packed.count} elements from ${file.name}, origin to origin. Move or rotate the model into place.`, { kind: 'success' });
  });
  input.click();
}

export function manageLinksDialog(app) {
  const body = h('div');
  const render = () => {
    clear(body);
    const links = app.doc.all('link');
    if (!links.length) {
      body.append(h('p.dialog-text', 'This project has no links. Use Link Project on the Insert tab to show another project in this one.'));
      return;
    }
    const tbody = h('tbody');
    for (const el of links) {
      const e = app.scene.link(el);
      tbody.append(
        h('tr',
          h('td', el.name),
          h('td.muted', el.path || 'Device file'),
          h('td.num', e.doc ? String(modelCount(e.doc)) : 'Unreadable'),
          h('td', h('span.inline',
            h('button.btn.sm', { type: 'button', disabled: !el.path, onClick: () => reloadLink(app, el.id).then(render) }, 'Reload'),
            h('button.btn.sm', { type: 'button', onClick: () => reloadLink(app, el.id, true).then(render) }, 'Reload From...'),
            h('button.icon-btn.sm', { type: 'button', 'aria-label': `Remove ${el.name}`, onClick: async () => {
              if (!(await confirmDialog('Remove link?', `${el.name} will no longer be shown in this project.`, { confirm: 'Remove', danger: true }))) return;
              app.commit('Remove link', () => app.doc.remove(el.id));
              render();
            } }, icon('trash', 14))))),
      );
    }
    body.append(h('table.vg-table', h('thead', h('tr', h('th', 'Name'), h('th', 'Source'), h('th', 'Elements'), h('th', h('span.sr-only', 'Actions')))), tbody));
  };
  render();
  return openDialog({ title: 'Manage Links', body, size: 'lg', actions: [{ label: 'Link Project...', onClick: () => (linkProject(app), true) }, { label: 'Close', primary: true, value: true }] });
}
