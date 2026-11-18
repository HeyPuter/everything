/**
 * Application dialogs: import, export, settings, keyboard shortcuts, the
 * "save to collection" picker and the cookie manager. Each opens a modal
 * built on openDialog (focus trap, Escape, focus return) and talks to the
 * App object only through its public methods.
 */
import { h, fill, announce, shortcut, domId, isMac, debounce, isComposing } from '../lib/dom.js';
import { uid } from '../lib/ids.js';
import { cloneWithNewIds, requestsIn, walk, AUTH_SECRETS, onlyVariables } from '../core/model.js';
import { FORMATS, detectFormat, importData, exportNative, exportCollectionV2, exportEnvironmentV2 } from '../core/io/index.js';
import { icon } from './icons.js';
import { prefs } from './prefs.js';
import { toast } from './toast.js';
import { openDialog, confirmDialog } from './dialog.js';
import { canEdit } from '../data/shared.js';

export const APP_VERSION = '0.1.0 alpha';
const SOURCE_URL = 'https://github.com/heyputer/everything';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const formatLabel = (id) => FORMATS.find((f) => f.id === id)?.label || 'Unknown format';

// Shared widgets ---------------------------------------------------------------

/**
 * Segmented single choice with radio semantics: arrows move and select,
 * only the checked option is in the tab order.
 */
function segmented({ label, labelledBy, options, value, onChange }) {
  const group = h('div.segmented', { role: 'radiogroup', 'aria-label': labelledBy ? null : label, 'aria-labelledby': labelledBy || null });
  const buttons = options.map((o) =>
    h(
      'button',
      { type: 'button', role: 'radio', dataset: { value: o.value }, onclick: () => select(o.value, true), disabled: o.disabled || false },
      o.icon ? icon(o.icon, 14) : null,
      h('span', o.label),
    ),
  );
  const select = (v, fire) => {
    for (const b of buttons) {
      const on = b.dataset.value === v;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    if (fire) onChange?.(v);
  };
  group.addEventListener('keydown', (e) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(e.key in keys)) return;
    e.preventDefault();
    const enabled = buttons.filter((b) => !b.disabled);
    const i = enabled.indexOf(document.activeElement);
    const next = enabled[(i + keys[e.key] + enabled.length) % enabled.length];
    next.focus();
    select(next.dataset.value, true);
  });
  group.append(...buttons);
  select(value, false);
  group.setValue = (v) => select(v, false);
  return group;
}

/** Horizontal tabs with roving focus. tabs: [{ id, label, icon, panel }] */
function tabset(tabs, { label, initial = tabs[0].id, onChange, orientation = 'horizontal', className = '' } = {}) {
  const list = h(`div.tabs${className ? `.${className}` : ''}`, { role: 'tablist', 'aria-label': label, 'aria-orientation': orientation });
  const panels = [];
  const btns = tabs.map((t) => {
    const tabId = domId('tab');
    const panelId = domId('tabpanel');
    const btn = h('button.tab', { type: 'button', role: 'tab', id: tabId, 'aria-controls': panelId, dataset: { id: t.id }, onclick: () => select(t.id, true) }, t.icon ? icon(t.icon, 15) : null, h('span', t.label));
    const panel = h('div.tabpanel', { role: 'tabpanel', id: panelId, 'aria-labelledby': tabId, tabindex: '-1', hidden: true }, t.panel);
    panels.push(panel);
    return btn;
  });
  let current = null;
  const select = (id, focus = false, fire = true) => {
    current = id;
    btns.forEach((b, i) => {
      const on = b.dataset.id === id;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      panels[i].hidden = !on;
      if (on && focus) b.focus();
    });
    if (fire) onChange?.(id);
  };
  list.addEventListener('keydown', (e) => {
    const vertical = orientation === 'vertical';
    const next = vertical ? 'ArrowDown' : 'ArrowRight';
    const prev = vertical ? 'ArrowUp' : 'ArrowLeft';
    const i = btns.findIndex((b) => b.dataset.id === current);
    let j = null;
    if (e.key === next || (vertical && e.key === 'ArrowRight')) j = i + 1;
    else if (e.key === prev || (vertical && e.key === 'ArrowLeft')) j = i - 1;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = btns.length - 1;
    if (j == null) return;
    e.preventDefault();
    select(btns[(j + btns.length) % btns.length].dataset.id, true);
  });
  list.append(...btns);
  select(initial, false, false);
  return { list, panels, select, get current() { return current; } };
}

/** Saves text as a file through a temporary link. */
export function downloadText(fileName, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: fileName, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function slug(name) {
  return (
    String(name || 'export')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 60) || 'export'
  );
}

const switchRow = ({ label, hint, checked, onChange }) => {
  const id = domId('switch');
  const input = h('input.switch', { type: 'checkbox', id, role: 'switch', checked, onchange: () => onChange(input.checked) });
  const hintId = hint ? domId('hint') : null;
  if (hintId) input.setAttribute('aria-describedby', hintId);
  return h('div.st-row', h('div.st-row-text', h('label.st-row-label', { for: id }, label), hint ? h('p.field-hint', { id: hintId }, hint) : null), input);
};

// Import -------------------------------------------------------------------------

/** Counts what an import result holds, for the preview. */
export function summarize(result) {
  const collections = result.collections.map((c) => {
    let folders = 0;
    walk(c, (i) => {
      if (i.type === 'folder') folders += 1;
    });
    return { name: c.name, requests: requestsIn(c).length, folders };
  });
  const environments = result.environments.map((e) => ({ name: e.name, variables: e.variables.length }));
  return { collections, environments, globals: result.globals?.length || 0 };
}

/** Adds imported data without overwriting anything. Returns { collections, environments } as added. */
export async function addImported(app, result) {
  const ws = app.ws;
  const collections = [];
  const environments = [];
  // Remembers what is already in, so trying again after a failure part way does not add things twice.
  const done = (result.added ??= new Set());
  for (const c of result.collections) {
    if (done.has(c)) continue;
    const fresh = ws.collides(c) ? cloneWithNewIds(c) : c;
    collections.push(await ws.addCollection({ ...fresh, type: 'collection' }));
    done.add(c);
  }
  for (const e of result.environments) {
    if (done.has(e)) continue;
    const taken = e.id === 'globals' || ws.getEnvironment(e.id);
    environments.push(await ws.addEnvironment(taken ? { ...e, id: uid() } : e));
    done.add(e);
  }
  // Globals from a backup join the existing ones; a variable already defined here keeps its value.
  const globals = (result.globals || []).filter((v) => !ws.globals.variables.some((x) => x.key === v.key));
  if (globals.length) await ws.updateGlobals((g) => g.variables.push(...globals.map((v) => ({ ...v, id: uid() }))));
  return { collections, environments, globals };
}

export function openImportDialog(app, { tab = 'file', text = '' } = {}) {
  /** Items to import: [{ source, format, result, error }] */
  let items = [];
  let busy = false;
  let dlg;

  // File tab
  const fileInput = h('input.sr-only', { type: 'file', multiple: true, accept: '.json,.yaml,.yml,.har,.txt,.sh', tabindex: '-1', 'aria-hidden': 'true' });
  const chooseBtn = h('button.btn', { type: 'button', onclick: () => fileInput.click() }, icon('upload', 15), h('span', 'Choose files'));
  const drop = h(
    'div.imp-drop',
    icon('fileJson', 28, 1.5),
    h('p.imp-drop-title', 'Drop files here'),
    h('p.field-hint', 'JSON, YAML, HAR or a text file with a cURL command. You can pick several at once.'),
    chooseBtn,
    fileInput,
  );
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.length) readFiles([...fileInput.files]);
    fileInput.value = '';
  });

  // Paste tab
  const pasteId = domId('paste');
  const textarea = h('textarea.textarea.imp-paste', {
    id: pasteId,
    rows: 9,
    spellcheck: false,
    autocomplete: 'off',
    placeholder: "curl https://api.example.com/users -H 'Accept: application/json'\n\nor paste a collection, OpenAPI document or HAR file as JSON or YAML",
  });
  textarea.value = text;
  const detected = h('p.imp-detected', { role: 'status', 'aria-live': 'polite' });
  const analyzePaste = debounce(() => readPaste(), 250);
  textarea.addEventListener('input', () => {
    // Reading a large paste takes a while, so the format is shown once typing pauses.
    if (!textarea.value.trim()) showDetected(null);
    analyzePaste();
  });
  textarea.addEventListener('paste', () => setTimeout(() => analyzePaste.flush(), 0));
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (isMac ? e.metaKey : e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      analyzePaste.flush();
      Promise.resolve(pastePromise).then(() => runImport());
    }
  });

  // Link tab
  const urlId = domId('url');
  const urlInput = h('input.input', { id: urlId, type: 'url', inputmode: 'url', placeholder: 'https://example.com/openapi.yaml', autocomplete: 'off', spellcheck: false });
  const fetchBtn = h('button.btn', { type: 'submit' }, icon('download', 15), h('span', 'Fetch'));
  const linkError = h('div.imp-link-error', { role: 'alert' });
  const linkForm = h(
    'form.imp-link',
    {
      onsubmit: (e) => {
        e.preventDefault();
        readLink();
      },
    },
    h('div.field', h('label', { for: urlId }, 'File address'), h('div.imp-link-row', urlInput, fetchBtn)),
    h('p.field-hint', 'The file is downloaded straight from your browser. Servers that do not allow cross-origin requests (CORS) will block this; if that happens, download the file and use the File tab.'),
    linkError,
  );

  const tabs = tabset(
    [
      { id: 'file', label: 'File', icon: 'upload', panel: drop },
      { id: 'paste', label: 'Paste text', icon: 'fileText', panel: h('div.field', h('label', { for: pasteId }, 'cURL command, JSON or YAML'), textarea, detected) },
      { id: 'link', label: 'Link', icon: 'link', panel: linkForm },
    ],
    {
      label: 'Import from',
      initial: tab,
      onChange: (id) => {
        // Each tab is its own source: switching clears a preview from another one,
        // and pasted text still waiting to be analyzed is dropped.
        if (id !== 'paste') {
          analyzePaste.cancel();
          pastePromise = null;
        }
        if (items.length && items[0].tab !== id) {
          items = [];
          renderPreview();
        }
        if (id === 'paste' && textarea.value.trim()) readPaste();
      },
    },
  );

  const preview = h('div.imp-preview', { 'aria-live': 'polite' });
  const supported = h(
    'details.imp-formats',
    h('summary', 'Supported formats'),
    h('ul', FORMATS.map((f) => h('li', f.label))),
  );

  const importBtn = h('button.btn.primary', { type: 'button', disabled: true, onclick: () => runImport() }, 'Import');
  const body = h('div.imp', tabs.list, ...tabs.panels, preview, supported);

  // Dropping files anywhere in the dialog works, whichever tab is showing.
  let dragDepth = 0;
  body.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    dragDepth += 1;
    drop.classList.add('over');
    if (tabs.current !== 'file') tabs.select('file');
  });
  body.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  body.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) drop.classList.remove('over');
  });
  body.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    drop.classList.remove('over');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) readFiles(files);
  });

  const isSingleCurl = () => items.length === 1 && items[0].format === 'curl' && items[0].tab === 'paste' && items[0].result;

  function detect(content) {
    try {
      return detectFormat(content);
    } catch {
      return null;
    }
  }

  /** format: what detect() found in the pasted text. */
  function showDetected(format) {
    if (!textarea.value.trim()) {
      fill(detected);
      return;
    }
    fill(
      detected,
      format
        ? [icon('circleCheck', 14), h('span', 'Detected: ', h('strong', formatLabel(format)))]
        : [icon('info', 14), h('span', 'Format not recognized yet.')],
    );
  }

  let pastePromise = null;
  async function readPaste() {
    const t = textarea.value;
    const trimmed = t.trim();
    if (!trimmed) {
      showDetected(null);
      items = [];
      renderPreview();
      return;
    }
    const format = detect(trimmed);
    showDetected(format);
    const run = (pastePromise = analyze(t, 'Pasted text', null, 'paste', trimmed === t ? format : undefined));
    const item = await run;
    if (run !== pastePromise || textarea.value !== t || tabs.current !== 'paste') return;
    items = [item];
    renderPreview();
  }

  async function readFiles(files) {
    tabs.select('file');
    setBusy(true, `Reading ${plural(files.length, 'file')}...`);
    const read = [];
    for (const f of files) {
      let textContent;
      try {
        textContent = await f.text();
      } catch {
        read.push({ tab: 'file', source: f.name, error: 'The file could not be read.' });
        continue;
      }
      read.push(await analyze(textContent, f.name, f.name, 'file'));
    }
    items = read;
    setBusy(false);
    renderPreview();
  }

  async function readLink() {
    const raw = urlInput.value.trim();
    fill(linkError);
    let url;
    try {
      url = new URL(raw);
      if (!/^https?:$/.test(url.protocol)) throw new Error();
    } catch {
      fill(linkError, h('p.field-error', 'Enter a full http:// or https:// address.'));
      urlInput.setAttribute('aria-invalid', 'true');
      urlInput.focus();
      return;
    }
    urlInput.removeAttribute('aria-invalid');
    setBusy(true, 'Downloading...');
    fetchBtn.disabled = true;
    try {
      let res;
      try {
        res = await window.fetch(url.href, { headers: { Accept: 'application/json, application/yaml, text/yaml, text/plain, */*' } });
      } catch {
        throw new Error(
          'The file could not be downloaded. The server may not allow requests from this page (CORS), or the address is unreachable. Download the file and import it from the File tab instead.',
        );
      }
      if (!res.ok) throw new Error(`The server responded with ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.`);
      const content = await res.text();
      const raw = url.pathname.split('/').pop() || url.hostname;
      let name = raw;
      try {
        name = decodeURIComponent(raw);
      } catch {
        // A stray % in the file name: show it as written.
      }
      items = [await analyze(content, url.href, name, 'link')];
    } catch (err) {
      items = [];
      fill(linkError, h('div.callout', { dataset: { kind: 'error' } }, icon('alert', 16), h('div', err.message)));
    } finally {
      fetchBtn.disabled = false;
      setBusy(false);
      renderPreview();
    }
  }

  /** format: detect(content), when already known. */
  async function analyze(content, source, fileName, tabId, format = detect(content)) {
    try {
      const result = await importData(content, { fileName });
      return { tab: tabId, source, format: result.format || format, result };
    } catch (err) {
      return { tab: tabId, source, format, error: err.message || String(err) };
    }
  }

  function setBusy(on, label = '') {
    busy = on;
    if (on) fill(preview, h('p.imp-busy', { role: 'status' }, h('span.spinner.sm', { 'aria-hidden': 'true' }), label));
    updateButton();
  }

  function updateButton() {
    const ok = items.filter((i) => i.result);
    importBtn.disabled = busy || !ok.length;
    importBtn.textContent = isSingleCurl() ? 'Open request' : 'Import';
  }

  function renderPreview() {
    if (!items.length) {
      fill(preview);
      updateButton();
      return;
    }
    const blocks = items.map((it) => {
      const head = h('div.imp-item-head', icon(it.error ? 'alert' : 'fileJson', 15), h('span.imp-item-source', { title: it.source }, it.source), it.format ? h('span.badge', formatLabel(it.format)) : null);
      if (it.error) return h('div.imp-item.error', head, h('div.callout', { dataset: { kind: 'error' } }, icon('alert', 16), h('div', it.error)));
      const warnings = it.result.warnings || [];
      const warningBox = warnings.length
        ? h(
            'div.callout',
            { dataset: { kind: 'warning' } },
            icon('warning', 16),
            h('div', h('strong', plural(warnings.length, 'warning')), h('ul.imp-warnings', warnings.slice(0, 20).map((w) => h('li', w)), warnings.length > 20 ? h('li', `and ${warnings.length - 20} more`) : null)),
          )
        : null;
      if (it.format === 'curl' && it.tab === 'paste') {
        const req = it.result.collections[0]?.items[0];
        return h(
          'div.imp-item',
          head,
          h('div.imp-req', h('span.method', { dataset: { m: req?.method } }, req?.method), h('span.imp-req-url', req?.url || '(no URL)')),
          h('p.field-hint', 'This command opens in a new request tab. Save it to a collection from there.'),
          warningBox,
        );
      }
      const s = summarize(it.result);
      const max = 6;
      const rows = [
        ...s.collections.slice(0, max).map((c) =>
          h('li', icon('collections', 14), h('span.imp-name', c.name), h('span.imp-count', [plural(c.requests, 'request'), c.folders ? plural(c.folders, 'folder') : null].filter(Boolean).join(', '))),
        ),
        ...s.environments.slice(0, max).map((e) => h('li', icon('globe', 14), h('span.imp-name', e.name), h('span.imp-count', plural(e.variables, 'variable')))),
        s.globals ? h('li', icon('globe', 14), h('span.imp-name', 'Globals'), h('span.imp-count', plural(s.globals, 'variable'))) : null,
      ];
      const hidden = Math.max(0, s.collections.length - max) + Math.max(0, s.environments.length - max);
      const parts = [];
      if (s.collections.length) parts.push(plural(s.collections.length, 'collection'));
      if (s.environments.length) parts.push(plural(s.environments.length, 'environment'));
      if (s.globals) parts.push(plural(s.globals, 'global variable'));
      return h(
        'div.imp-item',
        head,
        h('p.imp-summary', `Will add ${parts.join(' and ')}.`),
        h('ul.imp-list', rows, hidden ? h('li.imp-more', `and ${hidden} more`) : null),
        warningBox,
      );
    });
    fill(preview, blocks);
    updateButton();
  }

  async function runImport() {
    if (importBtn.disabled) return;
    if (isSingleCurl()) {
      const req = items[0].result.collections[0].items[0];
      dlg.close(true);
      app.newRequest({ ...req, name: req.name });
      announce('Request opened');
      return;
    }
    const ok = items.filter((i) => i.result);
    if (!ok.length) return;
    setBusy(true, 'Importing...');
    try {
      const added = { collections: [], environments: [], globals: [] };
      for (const it of ok) {
        const r = await addImported(app, it.result);
        added.collections.push(...r.collections);
        added.environments.push(...r.environments);
        added.globals.push(...r.globals);
        // Done with this one: if a later item fails, trying again must not add it twice.
        items = items.filter((x) => x !== it);
      }
      dlg.close(true);
      const parts = [];
      if (added.collections.length) parts.push(plural(added.collections.length, 'collection'));
      if (added.environments.length) parts.push(plural(added.environments.length, 'environment'));
      if (added.globals.length) parts.push(plural(added.globals.length, 'global variable'));
      const first = added.collections[0];
      toast({
        kind: 'success',
        title: 'Import complete',
        text: `Added ${parts.join(' and ')}.`,
        actions: first ? [{ label: 'Open', run: () => app.openTab('collection', first.id) }] : [],
      });
      if (first) {
        app.showSection?.('collections');
        app.sidebar?.reveal?.(first.id);
      } else if (added.environments.length) {
        app.showSection?.('environments');
      }
    } catch (err) {
      setBusy(false);
      renderPreview();
      toast({ kind: 'error', title: 'Import failed', text: err.message || String(err) });
    }
  }

  dlg = openDialog({
    title: 'Import',
    body,
    wide: true,
    className: 'imp-dialog',
    footer: [h('button.btn', { type: 'button', onclick: () => dlg.close(false) }, 'Cancel'), importBtn],
    initialFocus: () => (tab === 'paste' ? textarea : tab === 'link' ? urlInput : chooseBtn),
  });
  if (tab === 'paste' && text.trim()) readPaste();
  return dlg;
}

// Export -------------------------------------------------------------------------

function stripSecrets(env) {
  return { ...env, variables: env.variables.map((v) => (v.secret ? { ...v, value: '' } : v)) };
}

function stripAuthSecrets(node) {
  const out = { ...node };
  if (node.auth) {
    out.auth = { ...node.auth };
    for (const [type, fields] of Object.entries(AUTH_SECRETS)) {
      if (!node.auth[type]) continue;
      out.auth[type] = { ...node.auth[type] };
      // Names and ids stay; a value that only names a {{variable}} stays too.
      for (const f of fields) if (!onlyVariables(out.auth[type][f])) out.auth[type][f] = '';
    }
  }
  if (node.items) out.items = node.items.map(stripAuthSecrets);
  return out;
}

function stripCollectionSecrets(c) {
  return { ...stripAuthSecrets(c), variables: (c.variables || []).map((v) => (v.secret ? { ...v, value: '' } : v)) };
}

export function openExportDialog(app, { collectionId = null, environmentId = null } = {}) {
  const ws = app.ws;
  const cols = ws.collections;
  const envs = ws.environments;
  let scope = collectionId ? 'collections' : environmentId ? 'environments' : 'everything';
  const chosenCols = new Set(collectionId ? [collectionId] : cols.map((c) => c.id));
  const chosenEnvs = new Set(environmentId ? [environmentId] : envs.map((e) => e.id));
  let format = 'native';
  let includeSecrets = true;
  let dlg;

  const scopeLabel = domId('scope');
  const scopeCtl = segmented({
    labelledBy: scopeLabel,
    value: scope,
    options: [
      { value: 'everything', label: 'Everything' },
      { value: 'collections', label: 'Collections', disabled: !cols.length },
      { value: 'environments', label: 'Environments', disabled: !envs.length },
    ],
    onChange: (v) => {
      scope = v;
      render();
    },
  });

  const picker = h('div.exp-picker');
  const formatBox = h('div.exp-formats');
  const summary = h('p.field-hint', { role: 'status' });
  const secretsId = domId('secrets');
  const secrets = h('input', {
    type: 'checkbox',
    id: secretsId,
    checked: includeSecrets,
    onchange: () => {
      includeSecrets = secrets.checked;
    },
  });
  const downloadBtn = h('button.btn.primary', { type: 'button', onclick: () => run('download') }, icon('download', 15), h('span', 'Download'));
  const copyBtn = h('button.btn', { type: 'button', onclick: () => run('copy') }, icon('copy', 15), h('span', 'Copy'));

  const checklist = (list, chosen, kind) => {
    const allId = domId('all');
    const all = h('input', { type: 'checkbox', id: allId });
    const boxes = list.map((x) => {
      const id = domId('pick');
      const box = h('input', {
        type: 'checkbox',
        id,
        checked: chosen.has(x.id),
        onchange: () => {
          if (box.checked) chosen.add(x.id);
          else chosen.delete(x.id);
          syncAll();
          render(false);
        },
      });
      const meta = kind === 'collections' ? plural(requestsIn(x).length, 'request') : plural(x.variables.length, 'variable');
      return h('label.exp-pick', { for: id }, box, h('span.exp-pick-name', { title: x.name }, x.name), h('span.exp-pick-meta', meta));
    });
    const syncAll = () => {
      all.checked = chosen.size === list.length;
      all.indeterminate = chosen.size > 0 && chosen.size < list.length;
    };
    all.addEventListener('change', () => {
      for (const x of list) (all.checked ? chosen.add(x.id) : chosen.delete(x.id));
      boxes.forEach((b) => (b.querySelector('input').checked = all.checked));
      render(false);
    });
    syncAll();
    return h(
      'fieldset.exp-fieldset',
      h('legend.sr-only', kind === 'collections' ? 'Collections to export' : 'Environments to export'),
      h('label.exp-pick.exp-all', { for: allId }, all, h('span.exp-pick-name', 'Select all')),
      h('div.exp-pick-list', boxes),
    );
  };

  const formatOptions = () => {
    const opts = [{ value: 'native', label: formatLabel('native'), hint: 'Keeps folders, scripts, auth and examples. Best for backups and for moving data between devices.' }];
    if (scope === 'collections' && chosenCols.size === 1) {
      opts.push({ value: 'collection-v2.1', label: formatLabel('collection-v2.1'), hint: 'A single collection in a widely supported format, for use in other tools.' });
    }
    if (scope === 'environments' && chosenEnvs.size === 1) {
      opts.push({ value: 'environment-v2', label: formatLabel('environment-v2'), hint: 'A single environment in a widely supported format.' });
    }
    return opts;
  };

  function render(rebuildPicker = true) {
    if (rebuildPicker) {
      if (scope === 'collections') fill(picker, checklist(cols, chosenCols, 'collections'));
      else if (scope === 'environments') fill(picker, checklist(envs, chosenEnvs, 'environments'));
      else fill(picker, h('p.field-hint', `All ${plural(cols.length, 'collection')} and ${plural(envs.length, 'environment')} in this workspace.`));
    }
    const opts = formatOptions();
    if (!opts.some((o) => o.value === format)) format = 'native';
    const name = domId('fmt');
    fill(
      formatBox,
      h(
        'fieldset.exp-fieldset',
        h('legend.field-label', 'Format'),
        opts.map((o) => {
          const id = domId('fmt-opt');
          const hintId = domId('fmt-hint');
          const radio = h('input', {
            type: 'radio',
            name,
            id,
            value: o.value,
            checked: o.value === format,
            'aria-describedby': hintId,
            onchange: () => {
              format = o.value;
            },
          });
          return h('label.exp-format', { for: id }, radio, h('span.exp-format-text', h('span.exp-format-label', o.label), h('span.field-hint', { id: hintId }, o.hint)));
        }),
      ),
    );
    const { collections, environments, globals } = selection();
    const globalCount = globals?.variables.filter((v) => v.key).length || 0;
    const empty = !collections.length && !environments.length && !globalCount;
    downloadBtn.disabled = empty;
    copyBtn.disabled = empty;
    summary.textContent = empty ? 'Choose at least one item to export.' : `Exporting ${[collections.length ? plural(collections.length, 'collection') : null, environments.length ? plural(environments.length, 'environment') : null, globalCount ? plural(globalCount, 'global variable') : null].filter(Boolean).join(' and ')}.`;
  }

  function selection() {
    if (scope === 'everything') return { collections: ws.collections, environments: ws.environments, globals: ws.globals };
    if (scope === 'collections') return { collections: ws.collections.filter((c) => chosenCols.has(c.id)), environments: [] };
    return { collections: [], environments: ws.environments.filter((e) => chosenEnvs.has(e.id)) };
  }

  function build() {
    let { collections, environments, globals = null } = selection();
    if (!includeSecrets) {
      collections = collections.map(stripCollectionSecrets);
      environments = environments.map(stripSecrets);
      globals = globals && stripSecrets(globals);
    }
    const date = new Date().toISOString().slice(0, 10);
    if (format === 'collection-v2.1' && collections.length === 1) {
      return { text: exportCollectionV2(collections[0]), file: `${slug(collections[0].name)}.collection.json` };
    }
    if (format === 'environment-v2' && environments.length === 1) {
      return { text: exportEnvironmentV2(environments[0]), file: `${slug(environments[0].name)}.environment.json` };
    }
    const single = collections.length + environments.length === 1 ? (collections[0] || environments[0]).name : null;
    return { text: exportNative({ collections, environments, globals }), file: single && !globals?.variables.length ? `${slug(single)}.api-client.json` : `api-client-export-${date}.json` };
  }

  async function run(kind) {
    const { text, file } = build();
    if (kind === 'copy') {
      try {
        await navigator.clipboard.writeText(text);
        toast({ kind: 'success', title: 'Copied to the clipboard' });
        dlg.close(true);
      } catch {
        toast({ kind: 'error', title: 'Could not copy', text: 'The browser blocked clipboard access. Use Download instead.' });
      }
      return;
    }
    downloadText(file, text);
    dlg.close(true);
    toast({ kind: 'success', title: 'Export ready', text: `Saved as ${file}.` });
  }

  render();
  const body = h(
    'div.exp',
    h('div.field', h('span.field-label', { id: scopeLabel }, 'What to export'), scopeCtl),
    picker,
    formatBox,
    h('label.check', { for: secretsId }, secrets, h('span', 'Include secrets')),
    h('p.field-hint.exp-secret-hint', 'Values of secret variables, and tokens, passwords and keys in auth settings. Turn this off before sharing the file with someone else.'),
    summary,
  );
  dlg = openDialog({
    title: 'Export',
    body,
    className: 'exp-dialog',
    footer: [h('button.btn', { type: 'button', onclick: () => dlg.close(false) }, 'Cancel'), h('span.spacer'), copyBtn, downloadBtn],
    initialFocus: () => scopeCtl.querySelector('[aria-checked="true"]'),
  });
  return dlg;
}

// Settings -----------------------------------------------------------------------

const TRANSPORTS = [
  {
    value: 'auto',
    label: 'Automatic',
    icon: 'zap',
    text: 'When you are signed in, requests go through the Puter relay, so CORS does not apply. Local servers (localhost and your network), which the relay cannot reach, are sent from the browser. When you are signed out, requests are sent from the browser. Recommended.',
  },
  {
    value: 'browser',
    label: 'Browser only',
    icon: 'globe',
    text: 'Fastest and private: requests go straight from this page to the server. The server must allow cross-origin requests (CORS), the browser will not let you set some headers such as Cookie, and some response headers stay hidden.',
  },
  {
    value: 'relay',
    label: 'Puter relay',
    icon: 'server',
    text: 'Works with any server. Every header is sent exactly as written and every response header is shown. Traffic passes through the Puter relay, while TLS (HTTPS encryption) is done in your browser. Requires signing in.',
  },
];

export function openSettingsDialog(app, section = 'general') {
  let dlg;
  const signedIn = !!app.session?.signedIn;

  const general = () => {
    const themeLabel = domId('lbl');
    const layoutLabel = domId('lbl');
    return h(
      'div.st-section',
      h('h3.st-title', 'General'),
      h(
        'div.st-row',
        h('div.st-row-text', h('span.st-row-label', { id: themeLabel }, 'Theme'), h('p.field-hint', 'System follows your device setting.')),
        segmented({
          labelledBy: themeLabel,
          value: prefs.get('theme'),
          options: [
            { value: 'system', label: 'System', icon: 'monitor' },
            { value: 'light', label: 'Light', icon: 'sun' },
            { value: 'dark', label: 'Dark', icon: 'moon' },
          ],
          onChange: (v) => app.setTheme(v),
        }),
      ),
      h(
        'div.st-row',
        h('div.st-row-text', h('span.st-row-label', { id: layoutLabel }, 'Response pane'), h('p.field-hint', 'Where responses appear in request tabs. Narrow windows always show it below.')),
        segmented({
          labelledBy: layoutLabel,
          value: prefs.get('layout') === 'side' ? 'side' : 'stacked',
          options: [
            { value: 'stacked', label: 'Below', icon: 'rows' },
            { value: 'side', label: 'Beside', icon: 'columns' },
          ],
          onChange: (v) => app.setLayout(v),
        }),
      ),
    );
  };

  const requests = () => {
    const name = domId('transport');
    const legendId = domId('lbl');
    const current = prefs.get('transport');
    const cards = TRANSPORTS.map((t) => {
      const id = domId('tr');
      const descId = domId('tr-desc');
      const disabled = t.value === 'relay' && !signedIn;
      const radio = h('input', {
        type: 'radio',
        name,
        id,
        value: t.value,
        checked: current === t.value,
        disabled,
        'aria-describedby': descId,
        onchange: () => {
          app.setTransport(t.value);
          announce(`Requests are sent through: ${t.label}`);
        },
      });
      return h(
        `label.st-card${disabled ? '.disabled' : ''}`,
        { for: id },
        radio,
        h(
          'span.st-card-body',
          h('span.st-card-title', icon(t.icon, 15), t.label, t.value === 'auto' ? h('span.badge', 'Default') : null),
          h('span.st-card-text', { id: descId }, t.text),
          disabled && app.session?.puter
            ? h('span.st-card-text', h('button.link-btn', { type: 'button', onclick: (e) => { e.preventDefault(); app.signIn(); } }, 'Sign in'), ' to use the relay.')
            : null,
        ),
      );
    });

    const timeoutId = domId('timeout');
    const timeoutErr = h('p.field-error', { role: 'alert' });
    const timeout = h('input.input.st-num', { id: timeoutId, type: 'number', min: 0, step: 1000, inputmode: 'numeric', value: String(prefs.get('timeoutMs') || 0), 'aria-describedby': `${timeoutId}-hint` });
    timeout.addEventListener('change', () => {
      const n = Number(timeout.value);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        timeout.setAttribute('aria-invalid', 'true');
        timeoutErr.textContent = 'Enter a whole number of milliseconds, or 0 for no limit.';
        return;
      }
      timeout.removeAttribute('aria-invalid');
      timeoutErr.textContent = '';
      prefs.set('timeoutMs', n);
    });

    return h(
      'div.st-section',
      h('h3.st-title', 'Requests'),
      h('fieldset.st-cards', { 'aria-labelledby': legendId }, h('legend.st-row-label', { id: legendId }, 'Send requests through'), cards),
      h(
        'div.st-row',
        h('div.st-row-text', h('label.st-row-label', { for: timeoutId }, 'Default timeout'), h('p.field-hint', { id: `${timeoutId}-hint` }, 'In milliseconds. 0 means no limit. A request can override this in its settings.'), timeoutErr),
        h('div.st-num-wrap', timeout, h('span.st-unit', { 'aria-hidden': 'true' }, 'ms')),
      ),
      switchRow({
        label: 'Follow redirects',
        hint: 'When off, no request follows redirects. When on, each request can turn it off in its settings.',
        checked: prefs.get('followRedirects') !== false,
        onChange: (v) => prefs.set('followRedirects', v),
      }),
    );
  };

  const data = () => {
    const historyCount = h('span');
    const cookieCount = h('span');
    const counts = () => {
      historyCount.textContent = plural(app.ws.history?.length || 0, 'entry', 'entries');
      cookieCount.textContent = plural(app.cookieJar?.size || 0, 'cookie');
    };
    counts();
    const user = app.session?.user?.username;
    const storage = signedIn
      ? h('div.callout', { dataset: { kind: 'info' } }, icon('cloud', 16), h('div', h('strong', 'Synced to your Puter account'), h('div', `Collections, environments and history are saved on this device and synced to ${user ? `${user}'s` : 'your'} Puter account. Cookies and saved responses stay on this device.`)))
      : h(
          'div.callout',
          icon('database', 16),
          h(
            'div',
            h('strong', 'Saved in this browser only'),
            h('div', 'Your work is stored on this device. Clearing site data removes it.'),
            app.session?.puter ? h('div.st-callout-action', h('button.link-btn', { type: 'button', onclick: () => app.signIn() }, 'Sign in'), ' to sync across devices.') : null,
          ),
        );
    const action = (title, text, btn) => h('div.st-row', h('div.st-row-text', h('span.st-row-label', title), h('p.field-hint', text)), btn);
    return h(
      'div.st-section',
      h('h3.st-title', 'Data'),
      storage,
      action('Export', 'Download all collections and environments as one file.', h('button.btn', { type: 'button', onclick: () => openExportDialog(app) }, icon('download', 15), h('span', 'Export everything'))),
      action('Import', 'Add collections and environments from a file, a link or a cURL command.', h('button.btn', { type: 'button', onclick: () => { dlg.close(); openImportDialog(app); } }, icon('import', 15), h('span', 'Import'))),
      action(
        'History',
        h('span', 'Requests you have sent: ', historyCount, '.'),
        h(
          'button.btn',
          {
            type: 'button',
            onclick: async () => {
              const ok = await confirmDialog({ title: 'Clear history?', message: 'Every entry in your request history will be deleted. Saved requests are not affected.', confirmLabel: 'Clear history', danger: true });
              if (!ok) return;
              await app.ws.clearHistory();
              counts();
              toast({ kind: 'success', title: 'History cleared' });
            },
          },
          icon('trash', 15),
          h('span', 'Clear history'),
        ),
      ),
      action(
        'Cookies',
        h('span', 'Stored for relay requests: ', cookieCount, '. ', h('button.link-btn', { type: 'button', onclick: () => openCookiesDialog(app) }, 'Manage cookies')),
        h(
          'button.btn',
          {
            type: 'button',
            onclick: async () => {
              const ok = await confirmDialog({ title: 'Clear cookies?', message: 'All cookies stored by this app will be deleted.', confirmLabel: 'Clear cookies', danger: true });
              if (!ok) return;
              app.cookieJar?.clear();
              app.persistCookies?.();
              counts();
              toast({ kind: 'success', title: 'Cookies cleared' });
            },
          },
          icon('cookie', 15),
          h('span', 'Clear cookies'),
        ),
      ),
    );
  };

  const about = () =>
    h(
      'div.st-section',
      h('h3.st-title', 'About'),
      h(
        'div.st-about',
        h('img.st-about-icon', { src: './icon-192.png', alt: '', width: 48, height: 48 }),
        h('div', h('div.st-about-name', 'API Client'), h('div.st-about-version', `Version ${APP_VERSION}`)),
      ),
      h('p.st-about-text', 'Build, send and test HTTP requests in your browser. Organize them in collections, switch between environments, and optionally sync everything with your Puter account.'),
      h(
        'div.st-about-links',
        h('a.btn', { href: SOURCE_URL, target: '_blank', rel: 'noopener' }, icon('github', 15), h('span', 'Source code'), h('span.sr-only', '(opens in a new tab)')),
        h('button.btn', { type: 'button', onclick: () => openShortcutsDialog() }, icon('keyboard', 15), h('span', 'Keyboard shortcuts')),
      ),
      h('p.field-hint', 'Open source. Contributions and bug reports are welcome on GitHub.'),
    );

  const sections = [
    { id: 'general', label: 'General', icon: 'settings', panel: general() },
    { id: 'requests', label: 'Requests', icon: 'sendH', panel: requests() },
    { id: 'data', label: 'Data', icon: 'database', panel: data() },
    { id: 'about', label: 'About', icon: 'info', panel: about() },
  ];
  const valid = sections.some((s) => s.id === section) ? section : 'general';
  const nav = tabset(sections, { label: 'Settings sections', initial: valid, orientation: 'vertical', className: 'st-nav' });
  dlg = openDialog({
    title: 'Settings',
    wide: true,
    className: 'st-dialog',
    body: h('div.st', nav.list, h('div.st-content', nav.panels)),
    initialFocus: () => nav.list.querySelector('[aria-selected="true"]'),
  });
  return dlg;
}

// Shortcuts ----------------------------------------------------------------------

const ctrlBacktick = () => (isMac ? '⌃`' : 'Ctrl+`');

export const SHORTCUT_GROUPS = [
  {
    title: 'General',
    items: [
      ['Search and commands', ['Mod+K']],
      ['Import', ['Mod+O']],
      ['Keyboard shortcuts', ['Mod+/', '?']],
      ['Toggle sidebar', ['Mod+\\']],
      ['Toggle console', [ctrlBacktick]],
    ],
  },
  {
    title: 'Requests',
    items: [
      ['Send', ['Mod+Enter']],
      ['Save', ['Mod+S']],
      ['Save as', ['Mod+Shift+S']],
      ['New request', ['Mod+Alt+N']],
      ['Focus URL', ['Mod+Alt+U']],
    ],
  },
  {
    title: 'Tabs',
    items: [
      ['Close tab', ['Mod+Alt+W']],
      ['Next tab', ['Mod+Alt+]']],
      ['Previous tab', ['Mod+Alt+[']],
    ],
  },
  {
    title: 'In the sidebar',
    items: [
      ['Move between items', ['↑', '↓']],
      ['Expand or collapse', ['←', '→']],
      ['Open', ['Enter']],
      ['Rename', ['F2']],
      ['Duplicate', ['Mod+D']],
      ['Delete', ['Delete']],
    ],
  },
  {
    title: 'In editors',
    items: [
      ['Find', ['Mod+F']],
      ['Toggle comment', ['Mod+/']],
    ],
  },
];

export function openShortcutsDialog() {
  const keyLabel = (k) => (typeof k === 'function' ? k() : shortcut(k));
  const groups = SHORTCUT_GROUPS.map((g) => {
    const headId = domId('sc');
    return h(
      'section.sc-group',
      { 'aria-labelledby': headId },
      h('h3.sc-title', { id: headId }, g.title),
      h(
        'dl.sc-list',
        g.items.map(([label, keys]) => {
          const parts = [];
          const arrows = keys.every((k) => typeof k === 'string' && k.length === 1 && /[←-↓]/.test(k));
          keys.forEach((k, i) => {
            if (i) parts.push(arrows ? ' ' : h('span.sc-or', 'or'));
            parts.push(h('kbd', keyLabel(k)));
          });
          return h('div.sc-row', h('dt', label), h('dd', parts));
        }),
      ),
    );
  });
  let dlg;
  dlg = openDialog({
    title: 'Keyboard shortcuts',
    wide: true,
    className: 'sc-dialog',
    body: h('div.sc', groups),
    footer: [h('button.btn.primary', { type: 'button', onclick: () => dlg.close() }, 'Done')],
  });
  return dlg;
}

// Save to collection ---------------------------------------------------------------

let lastDestination = null; // { collectionId, folderId } remembered for the session

/**
 * Asks for a request name and a destination. Resolves
 * { name, collectionId, folderId, newCollection } or null when cancelled.
 * newCollection is a name (and collectionId null) when the user creates one.
 * View-only collections are never offered. With moving (a request or folder), it asks
 * only where to move it: no name, and neither the folder itself nor what is inside it.
 */
export function openSaveDialog(app, { name = '', collectionId = null, folderId = null, moving = null } = {}) {
  const ws = app.ws;
  const blocked = new Set();
  if (moving) {
    blocked.add(moving.id);
    walk(moving, (item) => blocked.add(item.id));
  }
  for (const c of ws.collections) if (c.shared && !canEdit(c.shared.mode)) blocked.add(c.id);
  const collections = () => ws.collections.filter((c) => !blocked.has(c.id));
  let dlg;
  // path: [] is the list of collections; [collectionId, ...folderIds] is inside one.
  let path = [];
  let creating = collections().length === 0;
  let active = 0;
  let options = [];

  const start = collectionId ? { collectionId, folderId } : lastDestination;
  if (start && ws.getCollection(start.collectionId) && !blocked.has(start.collectionId)) {
    path = [start.collectionId];
    if (start.folderId && start.folderId !== start.collectionId) {
      const loc = ws.locate(start.folderId);
      if (loc && loc.collection.id === start.collectionId && loc.item.type === 'folder' && !blocked.has(start.folderId)) {
        path = [start.collectionId, ...loc.parents.slice(1).map((p) => p.id), start.folderId];
      }
    }
  }

  const nameId = domId('save-name');
  const nameInput = h('input.input', { id: nameId, type: 'text', value: name || 'Untitled Request', autocomplete: 'off', spellcheck: false });
  const nameErr = h('p.field-error', { role: 'alert' });
  const listId = domId('save-list');
  const filterLabel = domId('save-filter-label');
  const filter = h('input.input.sm.save-filter', {
    type: 'search',
    role: 'combobox',
    'aria-controls': listId,
    'aria-expanded': 'true',
    'aria-autocomplete': 'list',
    'aria-labelledby': filterLabel,
    placeholder: 'Filter collections and folders',
    autocomplete: 'off',
    spellcheck: false,
  });
  const crumbs = h('nav.save-crumbs', { 'aria-label': 'Location' });
  const list = h('div.save-list', { id: listId, role: 'listbox', 'aria-label': 'Collections and folders' });
  const dest = h('p.save-dest', { role: 'status', 'aria-live': 'polite' });
  const newId = domId('new-col');
  const newInput = h('input.input', { id: newId, type: 'text', value: 'My Collection', autocomplete: 'off' });
  const newBox = h(
    'div.save-new',
    h('div.field', h('label', { for: newId }, 'New collection name'), newInput),
    collections().length ? h('button.link-btn', { type: 'button', onclick: () => setCreating(false) }, 'Choose an existing collection instead') : null,
  );
  const newBtn = h('button.btn.sm.ghost', { type: 'button', onclick: () => setCreating(true) }, icon('folderPlus', 14), h('span', 'New collection'));
  const picker = h('div.save-picker', h('div.save-picker-head', crumbs, newBtn), filter, list);
  const saveBtn = h('button.btn.primary', { type: 'button', onclick: () => submit() }, moving ? 'Move' : 'Save');

  const node = () => {
    if (!path.length) return null;
    const c = ws.getCollection(path[0]);
    if (!c) return null;
    if (path.length === 1) return c;
    return ws.locate(path[path.length - 1])?.item || null;
  };

  const namesOf = (p) => {
    const c = ws.getCollection(p[0]);
    if (!c) return [];
    return [c.name, ...p.slice(1).map((id) => ws.locate(id)?.item.name || '')];
  };

  /** All containers for the filtered (flat) view. */
  const allContainers = () => {
    const out = [];
    for (const c of collections()) {
      out.push({ id: c.id, name: c.name, kind: 'collection', path: [c.id], detail: '' });
      walk(c, (item, parents) => {
        if (item.type !== 'folder' || blocked.has(item.id) || parents.some((p) => blocked.has(p.id))) return;
        out.push({ id: item.id, name: item.name, kind: 'folder', path: [c.id, ...parents.map((p) => p.id), item.id], detail: [c.name, ...parents.map((p) => p.name)].join(' / ') });
      });
    }
    return out;
  };

  function setCreating(on) {
    creating = on;
    render();
    (on ? newInput : filter).focus();
    if (on) newInput.select();
  }

  function goTo(p) {
    path = p;
    filter.value = '';
    // Inside a collection the first option is Back; start on the first folder, or on nothing
    // when there are no folders, so Enter saves here instead of going back up.
    active = p.length ? 1 : 0;
    render();
    filter.focus();
  }

  function render() {
    picker.hidden = creating;
    newBox.hidden = !creating;
    if (!creating) {
      // Breadcrumb
      const parts = [h('button.save-crumb', { type: 'button', onclick: () => goTo([]), 'aria-current': path.length ? null : 'location' }, 'All collections')];
      path.forEach((id, i) => {
        const label = namesOf(path.slice(0, i + 1))[i];
        parts.push(h('span.save-sep', { 'aria-hidden': 'true' }, icon('chevronRight', 12)));
        parts.push(h('button.save-crumb', { type: 'button', title: label, onclick: () => goTo(path.slice(0, i + 1)), 'aria-current': i === path.length - 1 ? 'location' : null }, label));
      });
      fill(crumbs, parts);

      // Options
      const q = filter.value.trim().toLowerCase();
      let entries;
      if (q) {
        entries = allContainers()
          .filter((x) => x.name.toLowerCase().includes(q) || x.detail.toLowerCase().includes(q))
          .slice(0, 100)
          .map((x) => ({ ...x, target: x.path }));
      } else if (!path.length) {
        entries = collections().map((c) => ({ id: c.id, name: c.name, kind: 'collection', target: [c.id], detail: plural(requestsIn(c).length, 'request') }));
      } else {
        const n = node();
        entries = (n?.items || []).filter((i) => i.type === 'folder' && !blocked.has(i.id)).map((f) => ({ id: f.id, name: f.name, kind: 'folder', target: [...path, f.id], detail: '' }));
        if (path.length) entries.unshift({ id: '..', name: 'Back', kind: 'up', target: path.slice(0, -1), detail: '' });
      }
      options = entries.map((x, i) => {
        const id = `${listId}-${i}`;
        const el = h(
          'div.save-opt',
          { id, role: 'option', 'aria-selected': 'false', dataset: { kind: x.kind } },
          icon(x.kind === 'up' ? 'chevronLeft' : x.kind === 'collection' ? 'collections' : 'folder', 15),
          h('span.save-opt-name', x.name),
          x.detail ? h('span.save-opt-detail', x.detail) : null,
          x.kind === 'up' ? null : icon('chevronRight', 14),
        );
        el.addEventListener('mousedown', (e) => e.preventDefault());
        el.addEventListener('click', () => goTo(x.target));
        return { el, entry: x };
      });
      if (!options.length) {
        const msg = q ? 'No collections or folders match.' : path.length ? 'No folders here. Save directly into this location.' : 'No collections yet.';
        fill(list, h('div.save-empty', { role: 'presentation' }, msg));
      } else fill(list, options.map((o) => o.el));
      setActive(active === null || (path.length && !q && options.length === 1) ? null : Math.min(active, options.length - 1));
    }
    renderDestination();
  }

  function setActive(i) {
    if (!options.length || i === null) {
      active = i === null ? null : 0;
      options.forEach((o) => o.el.setAttribute('aria-selected', 'false'));
      filter.removeAttribute('aria-activedescendant');
      return;
    }
    active = (i + options.length) % options.length;
    options.forEach((o, k) => o.el.setAttribute('aria-selected', String(k === active)));
    filter.setAttribute('aria-activedescendant', options[active].el.id);
    options[active].el.scrollIntoView({ block: 'nearest' });
  }

  function destination() {
    if (creating) {
      const n = newInput.value.trim();
      return n ? { newCollection: n } : null;
    }
    const n = node();
    if (!n) return null;
    return { collectionId: path[0], folderId: path.length > 1 ? path[path.length - 1] : null };
  }

  function renderDestination() {
    const d = destination();
    const valid = !!d && (!!moving || !!nameInput.value.trim());
    saveBtn.disabled = !valid;
    if (!d) {
      fill(dest, icon('info', 14), h('span', creating ? 'Enter a name for the new collection.' : 'Choose a collection or folder to save into.'));
      return;
    }
    const where = d.newCollection ? `${d.newCollection} (new collection)` : namesOf(path).join(' / ');
    fill(dest, icon('folder', 14), h('span', moving ? 'Move to ' : 'Save to ', h('strong', where)));
  }

  function submit() {
    // A move keeps the item's name, whatever it is; only a save needs one typed.
    const n = moving ? moving.name : nameInput.value.trim();
    if (!moving && !n) {
      nameErr.textContent = 'Enter a name for the request.';
      nameInput.setAttribute('aria-invalid', 'true');
      nameInput.focus();
      return;
    }
    const d = destination();
    if (!d) {
      (creating ? newInput : filter).focus();
      return;
    }
    if (!d.newCollection && !moving) lastDestination = { collectionId: d.collectionId, folderId: d.folderId };
    dlg.close({ name: n, collectionId: d.collectionId || null, folderId: d.folderId || null, newCollection: d.newCollection || null });
  }

  filter.addEventListener('input', () => {
    active = 0;
    render();
  });
  filter.addEventListener('keydown', (e) => {
    if (isComposing(e)) return;
    if (e.key === 'ArrowDown') setActive((active ?? -1) + 1);
    else if (e.key === 'ArrowUp') setActive((active ?? 0) - 1);
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.stopPropagation();
      submit();
    } else if (e.key === 'Enter' || (e.key === 'ArrowRight' && !filter.value)) {
      const o = options[active];
      if (o) goTo(o.entry.target);
      else if (e.key === 'Enter') submit();
    } else if ((e.key === 'Backspace' || e.key === 'ArrowLeft') && !filter.value && path.length) goTo(path.slice(0, -1));
    else return;
    e.preventDefault();
  });
  nameInput.addEventListener('input', () => {
    nameErr.textContent = '';
    nameInput.removeAttribute('aria-invalid');
    renderDestination();
  });
  const enterSubmits = (e) => {
    if (e.key === 'Enter' && !isComposing(e)) {
      e.preventDefault();
      e.stopPropagation();
      submit();
    }
  };
  nameInput.addEventListener('keydown', enterSubmits);
  newInput.addEventListener('keydown', enterSubmits);
  newInput.addEventListener('input', renderDestination);

  render();
  const body = h(
    'div.save',
    moving ? null : h('div.field', h('label', { for: nameId }, 'Request name'), nameInput, nameErr),
    h('div.field', h('span.field-label', { id: filterLabel }, moving ? 'Move to' : 'Save to'), picker, newBox),
    dest,
  );
  dlg = openDialog({
    title: moving ? `Move "${moving.name}"` : 'Save request',
    body,
    className: 'save-dialog',
    footer: [h('button.btn', { type: 'button', onclick: () => dlg.close(null) }, 'Cancel'), saveBtn],
    initialFocus: moving ? (creating ? newInput : filter) : nameInput,
  });
  if (!moving) nameInput.select();
  return dlg.result.then((v) => (v && typeof v === 'object' ? v : null));
}

// Cookies ------------------------------------------------------------------------

function formatExpires(ms) {
  if (ms == null) return 'Session';
  const d = new Date(ms);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function toLocalInput(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function openCookiesDialog(app) {
  const jar = app.cookieJar;
  let dlg;
  let selected = jar?.domains()[0] || null;
  let editing = null; // key of the cookie whose value is being edited
  let adding = false;

  const changed = (message) => {
    app.persistCookies?.();
    if (message) announce(message);
  };

  const domainNav = h('div.ck-domains');
  const domainSelectId = domId('ck-domain');
  const domainSelect = h('select.select.ck-domain-select', { id: domainSelectId, 'aria-label': 'Domain' });
  domainSelect.addEventListener('change', () => {
    selected = domainSelect.value;
    editing = null;
    render();
  });
  const main = h('div.ck-main');
  const addBtn = h('button.btn.sm', { type: 'button', onclick: () => { adding = !adding; render(); if (adding) main.querySelector('.ck-add input')?.focus(); } }, icon('plus', 14), h('span', 'Add cookie'));

  function render() {
    const domains = jar ? jar.domains() : [];
    if (selected && !domains.includes(selected)) selected = domains[0] || null;
    // Domain list (desktop) and select (phones).
    const counts = new Map();
    for (const c of jar ? jar.list() : []) counts.set(c.domain, (counts.get(c.domain) || 0) + 1);
    fill(
      domainNav,
      h('div.ck-domains-head', h('span.field-label', 'Domains'), h('span.badge', String(domains.length))),
      domains.length
        ? h(
            'ul.ck-domain-list',
            { 'aria-label': 'Domains' },
            domains.map((d) =>
              h(
                'li',
                h(
                  'button.ck-domain',
                  { type: 'button', 'aria-current': d === selected ? 'true' : null, onclick: () => { selected = d; editing = null; render(); main.querySelector('h3')?.focus(); } },
                  h('span.ck-domain-name', d),
                  h('span.ck-domain-count', String(counts.get(d) || 0)),
                ),
              ),
            ),
          )
        : h('p.field-hint.ck-none', 'No domains yet.'),
    );
    fill(domainSelect, domains.map((d) => h('option', { value: d, selected: d === selected }, `${d} (${counts.get(d) || 0})`)));
    domainSelect.hidden = !domains.length;

    const parts = [];
    if (adding) parts.push(addForm());
    if (!domains.length) {
      if (!adding) {
        parts.push(
          h(
            'div.empty',
            icon('cookie', 28, 1.5),
            h('p.empty-title', 'No cookies yet'),
            h('p', 'Cookies set by servers on requests sent through the Puter relay appear here. You can also add one yourself.'),
          ),
        );
      }
    } else if (selected) {
      const cookies = jar.list().filter((c) => c.domain === selected).sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
      parts.push(
        h(
          'div.ck-domain-head',
          h('h3.ck-domain-title', { tabindex: '-1' }, selected),
          h(
            'button.btn.sm',
            {
              type: 'button',
              onclick: async () => {
                const ok = await confirmDialog({ title: 'Clear domain?', message: `All ${plural(cookies.length, 'cookie')} for ${selected} will be deleted.`, confirmLabel: 'Clear', danger: true });
                if (!ok) return;
                const d = selected;
                const at = jar.domains().indexOf(d);
                jar.clearDomain(d);
                changed(`Cookies for ${d} cleared`);
                domainGone(at);
              },
            },
            icon('trash', 14),
            h('span', 'Clear domain'),
          ),
        ),
        cookieTable(cookies),
      );
    }
    fill(main, parts);
  }

  /** After the domain at index lost its last cookie: shows the next one and focuses it, or Add cookie when none are left. */
  function domainGone(index) {
    const domains = jar.domains();
    selected = domains[Math.min(index, domains.length - 1)] || null;
    editing = null;
    render();
    const btn = domainNav.querySelector('.ck-domain[aria-current="true"]');
    // Phones show the select instead of the list.
    (!selected ? addBtn : btn?.checkVisibility?.() !== false ? btn : domainSelect).focus();
  }

  const keyOf = (c) => `${c.domain}\n${c.path}\n${c.name}`;

  function cookieTable(cookies) {
    const rows = cookies.map((c) => {
      const key = keyOf(c);
      const flags = [c.secure ? 'Secure' : null, c.httpOnly ? 'HttpOnly' : null, c.sameSite ? `SameSite=${c.sameSite}` : null, c.hostOnly ? 'Host only' : null].filter(Boolean);
      let valueCell;
      let actions;
      if (editing === key) {
        const input = h('input.input.sm.mono', { type: 'text', value: c.value, 'aria-label': `Value of ${c.name || 'cookie'}`, spellcheck: false, autocomplete: 'off' });
        const save = () => {
          jar.set({ ...c, value: input.value });
          editing = null;
          changed(`Cookie ${c.name} updated`);
          render();
          main.querySelector(`[data-key="${CSS.escape(key)}"] .ck-edit`)?.focus();
        };
        const cancel = () => {
          editing = null;
          render();
          main.querySelector(`[data-key="${CSS.escape(key)}"] .ck-edit`)?.focus();
        };
        input.addEventListener('keydown', (e) => {
          if (isComposing(e)) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            save();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            cancel();
          }
        });
        valueCell = input;
        actions = [
          h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Save value', title: 'Save', onclick: save }, icon('check', 14)),
          h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Cancel editing', title: 'Cancel', onclick: cancel }, icon('x', 14)),
        ];
        setTimeout(() => {
          input.focus();
          input.select();
        }, 0);
      } else {
        valueCell = h('span.ck-value.mono', { title: c.value }, c.value || h('span.ck-muted', '(empty)'));
        actions = [
          h('button.icon-btn.sm.ck-edit', { type: 'button', 'aria-label': `Edit value of ${c.name || 'cookie'}`, title: 'Edit value', onclick: () => { editing = key; render(); } }, icon('pencil', 14)),
          h(
            'button.icon-btn.sm',
            {
              type: 'button',
              'aria-label': `Delete cookie ${c.name || ''}`.trim(),
              title: 'Delete',
              onclick: () => {
                const at = jar.domains().indexOf(c.domain);
                jar.remove(c.domain, c.path, c.name);
                changed(`Cookie ${c.name} deleted`);
                if (!jar.domains().includes(c.domain)) return domainGone(at);
                render();
                (main.querySelector('.ck-edit') || main.querySelector('h3'))?.focus();
              },
            },
            icon('trash', 14),
          ),
        ];
      }
      return h(
        'tr',
        { dataset: { key } },
        h('th.mono', { scope: 'row' }, c.name || h('span.ck-muted', '(no name)')),
        h('td.ck-value-cell', valueCell),
        h('td.mono', c.path),
        h('td', { title: c.expires == null ? 'Deleted when the app session ends' : new Date(c.expires).toISOString() }, formatExpires(c.expires)),
        h('td', flags.length ? h('span.ck-flags', flags.map((f) => h('span.badge', f))) : h('span.ck-muted', 'None')),
        h('td.ck-actions', actions),
      );
    });
    return h(
      'div.ck-table-wrap',
      h(
        'table.ck-table',
        h('caption.sr-only', `Cookies for ${selected}`),
        h('thead', h('tr', h('th', { scope: 'col' }, 'Name'), h('th', { scope: 'col' }, 'Value'), h('th', { scope: 'col' }, 'Path'), h('th', { scope: 'col' }, 'Expires'), h('th', { scope: 'col' }, 'Flags'), h('th', { scope: 'col' }, h('span.sr-only', 'Actions')))),
        h('tbody', rows),
      ),
    );
  }

  function addForm() {
    const field = (label, input, hint) => {
      input.id = input.id || domId('ck-f');
      return h('div.field', h('label', { for: input.id }, label), input, hint ? h('p.field-hint', hint) : null);
    };
    const domain = h('input.input', { type: 'text', value: selected || '', placeholder: 'api.example.com', autocomplete: 'off', spellcheck: false, required: true });
    const name = h('input.input', { type: 'text', placeholder: 'session', autocomplete: 'off', spellcheck: false });
    const value = h('input.input.mono', { type: 'text', autocomplete: 'off', spellcheck: false });
    const path = h('input.input', { type: 'text', value: '/', autocomplete: 'off', spellcheck: false });
    const expires = h('input.input', { type: 'datetime-local', value: toLocalInput(null) });
    const check = (label) => {
      const id = domId('ck-c');
      const box = h('input', { type: 'checkbox', id });
      return { box, el: h('label.check', { for: id }, box, h('span', label)) };
    };
    const secure = check('Secure');
    const httpOnly = check('HttpOnly');
    const subdomains = check('Include subdomains');
    const error = h('p.field-error', { role: 'alert' });
    const form = h(
      'form.ck-add',
      {
        'aria-label': 'Add cookie',
        onsubmit: (e) => {
          e.preventDefault();
          const d = domain.value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
          if (!d) {
            error.textContent = 'Enter a domain, such as api.example.com.';
            domain.focus();
            return;
          }
          if (!name.value.trim() && !value.value) {
            error.textContent = 'Enter a name or a value.';
            name.focus();
            return;
          }
          let exp = null;
          if (expires.value) {
            exp = new Date(expires.value).getTime();
            if (!Number.isFinite(exp)) {
              error.textContent = 'The expiry date is not valid.';
              expires.focus();
              return;
            }
            if (exp <= Date.now()) {
              error.textContent = 'The expiry date is in the past, so the cookie would be deleted right away.';
              expires.focus();
              return;
            }
          }
          let stored;
          try {
            stored = jar.set({
              name: name.value.trim(),
              value: value.value,
              domain: d,
              path: path.value.trim().startsWith('/') ? path.value.trim() : '/',
              expires: exp,
              secure: secure.box.checked,
              httpOnly: httpOnly.box.checked,
              hostOnly: !subdomains.box.checked,
            });
          } catch (err) {
            error.textContent = err.message || 'The cookie could not be added.';
            return;
          }
          adding = false;
          selected = stored.domain;
          changed(`Cookie ${stored.name} added to ${stored.domain}`);
          render();
          addBtn.focus();
        },
      },
      h('h3.ck-add-title', 'Add cookie'),
      h(
        'div.ck-add-grid',
        field('Domain', domain),
        field('Path', path),
        field('Name', name),
        field('Value', value),
        field('Expires', expires, 'Leave empty for a session cookie.'),
      ),
      h('div.ck-add-checks', secure.el, httpOnly.el, subdomains.el),
      error,
      h(
        'div.ck-add-actions',
        h('button.btn.sm', { type: 'button', onclick: () => { adding = false; render(); addBtn.focus(); } }, 'Cancel'),
        h('button.btn.sm.primary', { type: 'submit' }, 'Add cookie'),
      ),
    );
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        adding = false;
        render();
        addBtn.focus();
      }
    });
    return form;
  }

  render();
  const body = h(
    'div.ck',
    h('div.callout', { dataset: { kind: 'info' } }, icon('info', 16), h('div', "Cookies are stored on this device and sent with requests that go through the Puter relay. Browser requests use the browser's own cookie rules and cannot read or send these.")),
    h('div.ck-toolbar', h('label.sr-only', { for: domainSelectId }, 'Domain'), domainSelect, h('span.spacer'), addBtn),
    h('div.ck-layout', domainNav, main),
  );
  const clearAll = h(
    'button.btn',
    {
      type: 'button',
      onclick: async () => {
        if (!jar?.size) return;
        const ok = await confirmDialog({ title: 'Clear all cookies?', message: `All ${plural(jar.size, 'cookie')} across every domain will be deleted.`, confirmLabel: 'Clear all', danger: true });
        if (!ok) return;
        jar.clear();
        changed('All cookies cleared');
        render();
      },
    },
    icon('trash', 15),
    h('span', 'Clear all'),
  );
  dlg = openDialog({
    title: 'Cookies',
    wide: true,
    className: 'ck-dialog',
    body,
    footer: [clearAll, h('span.spacer'), h('button.btn.primary', { type: 'button', onclick: () => dlg.close() }, 'Done')],
    initialFocus: addBtn,
  });
  return dlg;
}
