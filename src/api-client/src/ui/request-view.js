/**
 * Request editor tab: name and breadcrumb, method and URL, section tabs
 * (Params, Authorization, Headers, Body, Scripts, Settings, Docs) and the
 * response pane, side by side or stacked with a draggable divider.
 */
import { h, fill, domId, debounce, shortcut, isComposing } from '../lib/dom.js';
import { icon } from './icons.js';
import { METHODS, RAW_TYPES, normalizeRequest, formField } from '../core/model.js';
import { paramsFromUrl, urlWithParams, syncPathVars, splitUrl } from '../core/url.js';
import { autoHeaders, resolveRequest } from '../core/prepare.js';
import { createVarInput, isVariableDefined, refreshVarInputs } from './var-input.js';
import { createKvTable } from './kv-table.js';
import { createAuthEditor, AUTH_LABELS } from './auth-editor.js';
import { createScriptsEditor } from './scripts-editor.js';
import { codeEditor, refreshEditorVariables, LARGE_DOCUMENT } from './code-editor.js';
import { showMenu, menuButton } from './menu.js';
import { ResponseView, responseCharset } from './response-view.js';
import { prefs } from './prefs.js';
import { toast } from './toast.js';
import { prettyJson, prettyJsonBody, prettyXml, decodeText } from '../core/pretty.js';

const codegen = () => import('../core/codegen.js');
const looksLikeCurl = (text) => /^\s*(?:\$\s+|>\s+|PS[^>]*>\s*)?curl(?:\.exe)?\s/i.test(text);
import { formatBytes } from '../lib/format.js';
import { openDialog, promptDialog } from './dialog.js';

export const COMMON_HEADERS = [
  'Accept', 'Accept-Encoding', 'Accept-Language', 'Authorization', 'Cache-Control', 'Connection', 'Content-Disposition', 'Content-Encoding',
  'Content-Language', 'Content-Length', 'Content-Type', 'Cookie', 'DNT', 'Forwarded', 'From', 'Host', 'If-Match', 'If-Modified-Since',
  'If-None-Match', 'If-Range', 'If-Unmodified-Since', 'Idempotency-Key', 'Origin', 'Pragma', 'Prefer', 'Range', 'Referer', 'TE',
  'Upgrade', 'User-Agent', 'Via', 'X-API-Key', 'X-Correlation-ID', 'X-Forwarded-For', 'X-Forwarded-Host', 'X-Forwarded-Proto', 'X-Request-ID',
  'X-Requested-With',
];

/** Narrower than this, the response goes below the request even when set to be beside it. */
export const SIDE_BY_SIDE_MIN = 640;

const SECTIONS = [
  ['params', 'Params'],
  ['auth', 'Authorization'],
  ['headers', 'Headers'],
  ['body', 'Body'],
  ['scripts', 'Scripts'],
  ['settings', 'Settings'],
  ['docs', 'Docs'],
];

const BODY_MODES = [
  ['none', 'none'],
  ['form', 'form-data'],
  ['urlencoded', 'x-www-form-urlencoded'],
  ['raw', 'raw'],
  ['binary', 'binary'],
  ['graphql', 'GraphQL'],
];

const RAW_LABELS = { json: 'JSON', text: 'Text', javascript: 'JavaScript', html: 'HTML', xml: 'XML' };

export class RequestView {
  // The last query params that had rows, to take ids and descriptions from while the query is cleared and retyped.
  #paramsPool = null;
  #vars = null;
  #collectionId = null;

  constructor(app, tab) {
    this.app = app;
    this.tab = tab;
    this.section = tab.section || 'params';
    this.editors = [];
    this.id = domId('req');
    this.persist = debounce(() => {
      app.draftChanged(tab);
      // Save turns on with the first edit (and off when edits are undone) without rebuilding the header.
      if (this.saveBtn) this.saveBtn.disabled = !!tab.refId && !app.isDirty(tab);
    }, 120);
    this.el = h('div.req-view');
    this.build();
  }

  get draft() {
    return this.tab.draft;
  }

  get loc() {
    return this.tab.refId ? this.app.ws.locate(this.tab.refId) : null;
  }

  /**
   * Variables in reach. Fields keep this one object, which looks up the
   * request's collection on each call, so they follow the request when it moves.
   */
  get vars() {
    const scope = () => this.app.varsFor(this.loc?.collection.id || null);
    return (this.#vars ||= { get: (n) => scope().get(n), list: () => scope().list(), resolve: (t) => scope().resolve(t) });
  }

  /** Repaints variables when the request has moved to another collection since it was last drawn. */
  #followCollection() {
    const id = this.loc?.collection.id || null;
    if (id === this.#collectionId) return;
    this.#collectionId = id;
    refreshVarInputs();
    refreshEditorVariables();
    this.onVariablesChanged();
  }

  /** Records an edit to the draft. */
  changed({ head = false } = {}) {
    this.persist();
    if (head) this.#renderHead();
    this.#renderTabCounts();
    if (this.section === 'headers') this.#renderAutoHeaders();
    if (this.app.rightPanelKind === 'code') this.#renderCode();
  }

  build() {
    for (const ed of [...this.editors, ...(this.bodyEditors || [])]) ed.destroy();
    this.editors = [];
    this.bodyEditors = [];
    this.response?.destroy();
    this.codeView?.destroy();
    this.codeView = null;
    this.head = h('div.req-head');
    this.nameInput = null;
    this.#collectionId = this.loc?.collection.id || null;
    this.#renderHead();

    // Method + URL + Send.
    this.methodBtn = h('button.method-btn', { type: 'button', 'aria-label': `Method: ${this.draft.method}` });
    this.#renderMethod();
    this.methodBtn.addEventListener('click', () => this.#methodMenu());
    this.methodBtn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.#methodMenu();
      }
    });
    this.url = createVarInput({
      value: this.draft.url,
      placeholder: 'Enter a URL or paste a cURL command',
      label: 'Request URL',
      vars: this.vars,
      onInput: (v) => this.#onUrlInput(v),
      onEnter: () => this.app.sendTab(this.tab),
      onPaste: (e) => this.#onPaste(e),
    });
    this.sendBtn = h('button.btn.primary.send-btn', { type: 'button', 'aria-keyshortcuts': 'Control+Enter Meta+Enter', title: `Send (${shortcut('Mod+Enter')})`, onclick: (e) => this.#onSendClick(e) }, icon('sendH', 15), h('span', 'Send'));
    const sendMore = h('button.btn.primary', { type: 'button', 'aria-label': 'More send options' }, icon('chevronDown', 15));
    menuButton(sendMore, () => [
      { label: 'Send', icon: 'sendH', kbd: shortcut('Mod+Enter'), run: () => this.app.sendTab(this.tab) },
      { label: 'Send from the browser', icon: 'globe', run: () => this.app.sendTab(this.tab, { transport: 'browser' }) },
      this.app.session.signedIn
        ? { label: 'Send through Puter relay', icon: 'server', run: () => this.app.sendTab(this.tab, { transport: 'relay' }) }
        : { label: 'Sign in and send through Puter relay', icon: 'server', disabled: !this.app.session.puter, run: () => this.app.signInAndSend(this.tab, 'relay') },
      '-',
      { label: 'Copy as cURL', icon: 'terminal', run: () => this.copyAs('curl') },
      { label: 'Show code snippet', icon: 'code', run: () => this.app.toggleRightPanel('code', true) },
    ], { align: 'end', label: 'Send options' });
    const urlRow = h('div.url-row', h('div.url-box', this.methodBtn, this.url.el), h('div.split-btn', this.sendBtn, sendMore));

    // Section tabs.
    this.tabsEl = h('div.tabs', { role: 'tablist', 'aria-label': 'Request sections' });
    this.tabsEl.addEventListener('keydown', (e) => this.#tabKeys(e));
    this.codeBtn = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Code snippet', title: 'Code snippet', 'aria-pressed': String(this.app.rightPanelKind === 'code'), onclick: () => this.app.toggleRightPanel('code') }, icon('code', 16));
    const cookiesBtn = h('button.link-btn.tab-link', { type: 'button', onclick: () => import('./dialogs.js').then((m) => m.openCookiesDialog(this.app)) }, 'Cookies');
    this.panels = {};
    for (const [key] of SECTIONS) this.panels[key] = h('div.req-panel', { role: 'tabpanel', id: `${this.id}-${key}-panel`, 'aria-labelledby': `${this.id}-${key}`, hidden: true, tabindex: '-1' });
    this.#renderTabs();

    this.response = new ResponseView(this.app, this.tab, {
      onRetry: () => this.app.sendTab(this.tab),
      onRelay: () => this.app.sendTab(this.tab, { transport: 'relay' }),
      onSignInSend: (transport) => this.app.signInAndSend(this.tab, transport),
      onSaveExample: (result) => this.#saveExample(result),
    });
    if (this.tab.result) this.response.show(this.tab.result);
    else if (this.tab.refId) this.#restoreResponse();

    this.top = h('div.req-pane.top', h('div.req-tabs-row', this.tabsEl, h('div.tab-extra', cookiesBtn, this.codeBtn)), ...Object.values(this.panels));
    this.resizer = h('div.resizer.horizontal', { role: 'separator', 'aria-label': 'Resize request and response', tabindex: '0', 'aria-orientation': 'horizontal' });
    this.bottom = h('div.req-pane.bottom', this.response.el);
    this.split = h('div.req-split', { dataset: { mobile: this.tab.mobilePane || 'request' } }, this.top, this.resizer, this.bottom);
    this.mobileSwitch = h('div.mobile-switch', this.#mobileSwitch());
    this.#wireSplit();
    this.setLayout(prefs.get('layout'));
    this.splitObserver = new ResizeObserver(() => this.#fitLayout());
    this.splitObserver.observe(this.split);
    fill(this.el, this.head, urlRow, this.mobileSwitch, this.split);
    this.showSection(this.section);
    if (this.tab.abort) this.onSending(true);
  }

  // Header --------------------------------------------------------------------

  #renderHead() {
    if (!this.nameInput) this.#buildHead();
    const loc = this.loc;
    const name = this.nameInput;
    // Updated in place, never rebuilt: a focused name keeps its caret and what is being typed.
    if (name.value !== this.draft.name) {
      name.value = this.draft.name;
      name.size = Math.max(8, Math.min(48, name.value.length + 1));
    }
    for (const node of [...this.crumbsEl.childNodes]) if (node !== name) node.remove();
    if (loc) {
      loc.parents.forEach((p, i) => {
        // The collection gives way first; --chars lets each keep a few letters (editor.css).
        const crumb = h(`button.crumb${i ? '' : '.crumb-root'}`, { type: 'button', title: `Open ${p.name}`, style: { '--chars': String(p.name.length) }, onclick: () => this.app.openTab(p.type, p.id) }, p.name);
        name.before(crumb, h('span.sep', { 'aria-hidden': 'true' }, '/'));
      });
    } else name.before(h('span.crumb.unsaved', 'Unsaved'), h('span.sep', { 'aria-hidden': 'true' }, '/'));
    const shared = loc?.collection.shared;
    if (shared) {
      const viewOnly = !['write', 'manage'].includes(shared.mode);
      name.after(h('span.badge.shared-badge', { title: `Shared by ${shared.owner}${viewOnly ? '. Save a copy to keep changes.' : ''}` }, icon(viewOnly ? 'lock' : 'users', 12), viewOnly ? 'View only' : `Shared by ${shared.owner}`));
    }
    this.saveBtn.disabled = !!this.tab.refId && !this.app.isDirty(this.tab);
  }

  /** The name field and the Save and actions buttons, made once per build. */
  #buildHead() {
    const name = h('input.req-name', { type: 'text', value: this.draft.name, 'aria-label': 'Request name', spellcheck: false, size: Math.max(8, Math.min(48, this.draft.name.length + 1)) });
    name.addEventListener('input', () => {
      this.draft.name = name.value;
      name.size = Math.max(8, Math.min(48, name.value.length + 1));
      this.changed();
    });
    name.addEventListener('blur', () => {
      if (!name.value.trim()) {
        name.value = this.draft.name = 'Untitled Request';
        this.changed();
      }
    });
    name.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === 'Escape') && !isComposing(e)) {
        e.preventDefault();
        this.url.focus();
      }
    });
    this.nameInput = name;
    this.crumbsEl = h('nav.crumbs', { 'aria-label': 'Location' }, name);
    const save = h('button.btn.sm', { type: 'button', title: `Save (${shortcut('Mod+S')})`, onclick: () => this.app.saveTab(this.tab) }, icon('save', 14), h('span', 'Save'));
    this.saveBtn = save;
    const saveMore = h('button.btn.sm', { type: 'button', 'aria-label': 'More save options' }, icon('chevronDown', 14));
    menuButton(saveMore, () => [
      { label: 'Save', icon: 'save', kbd: shortcut('Mod+S'), run: () => this.app.saveTab(this.tab) },
      { label: 'Save as...', icon: 'copy', kbd: shortcut('Mod+Shift+S'), run: () => this.app.saveTabAs(this.tab) },
      this.tab.refId && this.app.isDirty(this.tab) ? { label: 'Revert changes', icon: 'refresh', run: () => this.revert() } : null,
    ], { align: 'end', label: 'Save options' });
    const more = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Request actions' }, icon('more', 16));
    menuButton(more, () => [
      { label: 'Duplicate', icon: 'copy', run: () => this.app.openTab('request', null, { draft: { ...structuredClone(this.draft), id: undefined, name: `${this.draft.name} Copy` } }) },
      { label: 'Copy as cURL', icon: 'terminal', run: () => this.copyAs('curl') },
      { label: 'Copy URL', icon: 'link', run: () => navigator.clipboard?.writeText(this.vars.resolve(this.draft.url)).then(() => toast({ kind: 'success', title: 'URL copied' })) },
      this.tab.refId ? '-' : null,
      this.tab.refId ? { label: 'Delete', icon: 'trash', danger: true, run: () => this.app.deleteItem(this.tab.refId) } : null,
    ], { align: 'end', label: 'Request actions' });
    fill(this.head, this.crumbsEl, h('div.req-head-actions', h('div.split-btn', save, saveMore), more));
  }

  onSaved() {
    this.#renderHead();
  }

  revert() {
    const saved = this.loc?.item;
    if (!saved) return;
    this.tab.draft = normalizeRequest(structuredClone(saved));
    this.tab.savedKey = null;
    this.reload();
    this.app.draftChanged(this.tab);
  }

  /** Rebuilds from the draft (after revert or a remote change). */
  reload() {
    this.#paramsPool = null;
    const focusUrl = document.activeElement === this.url?.input;
    this.build();
    if (focusUrl) this.url.focus();
  }

  onContextChanged() {
    this.#renderHead();
    this.#followCollection();
    if (this.section === 'auth') this.authEditor?.refresh();
    if (this.section === 'headers') this.#renderAutoHeaders();
  }

  onVariablesChanged() {
    if (this.section === 'headers') this.#renderAutoHeaders();
    if (this.app.rightPanelKind === 'code') this.#renderCode();
  }

  // Method and URL --------------------------------------------------------------

  #renderMethod() {
    fill(this.methodBtn, h('span.method', { dataset: { m: this.draft.method } }, this.draft.method), icon('chevronDown', 14));
    this.methodBtn.setAttribute('aria-label', `Method: ${this.draft.method}`);
  }

  setMethod(m) {
    this.draft.method = m.toUpperCase();
    this.#renderMethod();
    this.changed();
    this.app.tabbar.render();
  }

  #methodMenu() {
    showMenu(
      [
        ...METHODS.map((m) => ({ label: m, render: () => h('span.method', { dataset: { m }, style: { fontSize: '12px' } }, m), checked: this.draft.method === m, run: () => this.setMethod(m) })),
        '-',
        {
          label: 'Custom method...',
          icon: 'pencil',
          run: async () => {
            const m = await promptDialog({ title: 'Custom method', label: 'Method name', value: METHODS.includes(this.draft.method) ? '' : this.draft.method, confirmLabel: 'Use method', validate: (v) => (/^[A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*$/.test(v) ? '' : 'Use letters, digits and simple symbols, with no spaces.') });
            if (m) this.setMethod(m);
          },
        },
      ],
      { anchor: this.methodBtn, label: 'HTTP method' },
    );
  }

  #onUrlInput(v) {
    this.draft.url = v;
    const params = JSON.stringify(this.draft.params);
    const pathVars = JSON.stringify(this.draft.pathVars);
    // Backspacing to "?" leaves no rows to match the retyped params with: until the "?" goes too, use the last ones.
    const had = this.draft.params.some((p) => p.enabled);
    if (had) this.#paramsPool = this.draft.params;
    else if (splitUrl(v).query == null) this.#paramsPool = null;
    this.draft.params = paramsFromUrl(v, had ? this.draft.params : this.#paramsPool || this.draft.params);
    this.draft.pathVars = syncPathVars(v, this.draft.pathVars, { renamed: true });
    // Most keystrokes leave both tables as they were; rebuilding them each time would be wasted work.
    if (JSON.stringify(this.draft.params) !== params) this.paramsTable?.setRows(this.draft.params);
    if (JSON.stringify(this.draft.pathVars) !== pathVars) this.#renderPathVars();
    this.changed();
  }

  async #onPaste(e) {
    const text = e.clipboardData?.getData('text') || '';
    if (!looksLikeCurl(text)) return;
    e.preventDefault();
    try {
      const { parseCurl } = await import('../core/curl.js');
      const parsed = parseCurl(text);
      const name = this.draft.name;
      Object.assign(this.tab.draft, normalizeRequest({ ...parsed, id: this.draft.id, name, scripts: this.draft.scripts, settings: this.draft.settings, examples: this.draft.examples, description: this.draft.description }));
      this.reload();
      this.app.draftChanged(this.tab);
      if (parsed.warnings?.length) toast({ kind: 'warning', title: 'cURL command imported', text: parsed.warnings.join(' ') });
      else toast({ kind: 'success', title: 'cURL command imported', text: 'Method, URL, headers and body were filled in.' });
    } catch (err) {
      toast({ kind: 'error', title: 'Could not read that cURL command', text: err.message });
    }
  }

  focusUrl() {
    this.url.focus();
    this.url.input.select();
  }

  focus() {
    this.url.focus();
    return true;
  }

  // Section tabs ----------------------------------------------------------------

  #counts() {
    const d = this.draft;
    const n = (list) => list.filter((x) => x.enabled && x.key).length;
    return {
      params: n(d.params) + d.pathVars.filter((p) => p.value).length || null,
      headers: n(d.headers) || null,
      body: d.body.mode !== 'none' ? 'dot' : null,
      auth: d.auth.type !== 'inherit' && d.auth.type !== 'none' ? 'dot' : null,
      scripts: d.scripts.pre.trim() || d.scripts.post.trim() ? 'dot' : null,
      docs: d.description.trim() || d.examples.length ? 'dot' : null,
    };
  }

  #renderTabs() {
    const counts = this.#counts();
    fill(
      this.tabsEl,
      SECTIONS.map(([key, label]) => {
        const c = counts[key];
        return h(
          'button.tab',
          {
            type: 'button',
            role: 'tab',
            id: `${this.id}-${key}`,
            'aria-selected': String(this.section === key),
            'aria-controls': `${this.id}-${key}-panel`,
            tabindex: this.section === key ? '0' : '-1',
            dataset: { key },
            onclick: () => this.showSection(key),
          },
          label,
          c === 'dot' ? h('span.dot', { 'aria-label': 'has content' }) : c ? h('span.count', String(c)) : null,
        );
      }),
    );
  }

  #renderTabCounts() {
    const counts = this.#counts();
    for (const btn of this.tabsEl.children) {
      const c = counts[btn.dataset.key];
      btn.querySelector('.dot, .count')?.remove();
      if (c === 'dot') btn.append(h('span.dot', { 'aria-label': 'has content' }));
      else if (c) btn.append(h('span.count', String(c)));
    }
  }

  #tabKeys(e) {
    const keys = SECTIONS.map((s) => s[0]);
    const i = keys.indexOf(this.section);
    let next = null;
    if (e.key === 'ArrowRight') next = keys[(i + 1) % keys.length];
    else if (e.key === 'ArrowLeft') next = keys[(i - 1 + keys.length) % keys.length];
    else if (e.key === 'Home') next = keys[0];
    else if (e.key === 'End') next = keys[keys.length - 1];
    if (!next) return;
    e.preventDefault();
    this.showSection(next);
    this.tabsEl.querySelector(`[data-key="${next}"]`)?.focus();
  }

  showSection(key) {
    this.section = key;
    this.tab.section = key;
    for (const btn of this.tabsEl.children) {
      const on = btn.dataset.key === key;
      btn.setAttribute('aria-selected', String(on));
      btn.tabIndex = on ? 0 : -1;
    }
    for (const [k, panel] of Object.entries(this.panels)) panel.hidden = k !== key;
    const panel = this.panels[key];
    if (!panel.dataset.built) {
      panel.dataset.built = '1';
      this[`render_${key}`](panel);
    } else if (key === 'headers') this.#renderAutoHeaders();
    if (this.tab.mobilePane === 'response') this.#setMobile('request');
  }

  // Params ------------------------------------------------------------------------

  render_params(panel) {
    this.paramsTable = createKvTable({
      rows: this.draft.params,
      vars: this.vars,
      label: 'Query parameters',
      onChange: (rows) => {
        this.draft.params = rows;
        this.#paramsPool = null;
        this.draft.url = urlWithParams(this.draft.url, rows);
        this.draft.pathVars = syncPathVars(this.draft.url, this.draft.pathVars);
        this.url.setValue(this.draft.url);
        this.changed();
      },
    });
    this.pathVarsEl = h('div.path-vars');
    fill(
      panel,
      h('div.panel-head', h('span.panel-title', 'Query Params'), h('span.spacer'), this.paramsTable.bulkToggle),
      this.paramsTable.el,
      this.pathVarsEl,
    );
    this.#renderPathVars();
  }

  #renderPathVars() {
    if (!this.pathVarsEl) return;
    if (!this.draft.pathVars.length) {
      fill(this.pathVarsEl);
      return;
    }
    const rows = this.draft.pathVars.map((p, i) => {
      const value = createVarInput({
        value: p.value,
        placeholder: 'Value',
        label: `Value of path variable ${p.key}`,
        vars: this.vars,
        className: 'kv-input',
        onInput: (v) => {
          this.draft.pathVars[i].value = v;
          this.changed();
        },
      });
      const desc = h('input.kv-plain', { type: 'text', value: p.description, placeholder: 'Description', 'aria-label': `Description of path variable ${p.key}`, oninput: (e) => { this.draft.pathVars[i].description = e.target.value; this.changed(); } });
      return h('tr', h('td.kv-key-fixed.mono', p.key), h('td', value.el), h('td.kv-desc-col', desc));
    });
    fill(
      this.pathVarsEl,
      h('div.panel-head', h('span.panel-title', 'Path Variables')),
      h('div.kv-scroll', h('table.kv', { 'aria-label': 'Path variables' }, h('thead', h('tr', h('th', 'Key'), h('th', 'Value'), h('th.kv-desc-col', 'Description'))), h('tbody', rows))),
    );
  }

  // Auth ---------------------------------------------------------------------------

  render_auth(panel) {
    this.authEditor = createAuthEditor({
      auth: this.draft.auth,
      vars: this.vars,
      app: this.app,
      allowInherit: true,
      inheritFrom: () => {
        const loc = this.loc;
        if (!loc) return null;
        for (let i = loc.parents.length - 1; i >= 0; i--) {
          const p = loc.parents[i];
          if (p.auth && p.auth.type !== 'inherit') return { name: p.name, label: AUTH_LABELS[p.auth.type] };
        }
        return null;
      },
      onChange: (auth) => {
        this.draft.auth = auth;
        this.changed();
      },
    });
    fill(panel, this.authEditor.el);
  }

  // Headers -------------------------------------------------------------------------

  render_headers(panel) {
    this.headersTable = createKvTable({
      rows: this.draft.headers,
      vars: this.vars,
      label: 'Headers',
      keySuggestions: COMMON_HEADERS,
      onChange: (rows) => {
        this.draft.headers = rows;
        this.changed();
      },
    });
    this.autoHeadersEl = h('div');
    fill(panel, h('div.panel-head', h('span.panel-title', 'Headers'), h('span.spacer'), this.headersTable.bulkToggle), this.headersTable.el, this.autoHeadersEl);
    this.#renderAutoHeaders();
  }

  #renderAutoHeaders() {
    if (!this.autoHeadersEl) return;
    const list = autoHeaders(this.draft, this.loc?.parents || [], this.vars.resolve);
    const open = this.autoHeadersEl.querySelector('details')?.open || false;
    fill(
      this.autoHeadersEl,
      list.length
        ? h(
            'details.auto-headers',
            { open },
            h('summary', `${list.length} header${list.length > 1 ? 's' : ''} added automatically`),
            h('table', h('tbody', list.map((x) => h('tr', h('td.mono', x.key), h('td.mono', { title: x.value }, x.key === 'Authorization' ? maskAuth(x.value) : x.value), h('td', x.reason))))),
          )
        : null,
    );
  }

  // Body ----------------------------------------------------------------------------

  render_body(panel) {
    const name = domId('body-mode');
    const modes = h(
      'div.radio-row',
      { role: 'radiogroup', 'aria-label': 'Body type' },
      BODY_MODES.map(([key, label]) =>
        h(
          'label',
          h('input', { type: 'radio', name, value: key, checked: this.draft.body.mode === key, onchange: () => { this.draft.body.mode = key; this.changed(); this.#renderBodyContent(); } }),
          label,
        ),
      ),
    );
    this.bodyExtra = h('div.body-extra', { style: { display: 'flex', gap: '8px', alignItems: 'center' } });
    this.bodyContent = h('div.body-content', { style: { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0', gap: '8px' } });
    fill(panel, h('div.body-mode-row', modes, h('span.spacer'), this.bodyExtra), this.bodyContent);
    this.#renderBodyContent();
  }

  #renderBodyContent() {
    for (const ed of this.bodyEditors || []) ed.destroy();
    this.bodyEditors = [];
    const b = this.draft.body;
    fill(this.bodyExtra);
    switch (b.mode) {
      case 'none':
        fill(this.bodyContent, h('p.body-none', 'This request does not have a body.'));
        break;
      case 'form':
      case 'urlencoded': {
        const isForm = b.mode === 'form';
        const table = createKvTable({
          rows: isForm ? b.form : b.urlencoded,
          vars: this.vars,
          label: isForm ? 'Form fields' : 'URL-encoded fields',
          files: isForm,
          makeRow: isForm ? () => formField() : null,
          onPickFile: () => this.pickFile(),
          onChange: (rows) => {
            if (isForm) b.form = rows;
            else b.urlencoded = rows;
            this.changed();
          },
        });
        fill(this.bodyExtra, table.bulkToggle);
        fill(this.bodyContent, table.el, isForm ? h('p.field-hint', 'Files you attach stay on this device and are not synced.') : null);
        break;
      }
      case 'raw': {
        const typeSel = h(
          'select.select.sm.raw-type',
          { 'aria-label': 'Raw body type', onchange: (e) => { b.rawType = e.target.value; ed.setLanguage(b.rawType); this.changed(); renderBeautify(); } },
          RAW_TYPES.map((t) => h('option', { value: t, selected: b.rawType === t }, RAW_LABELS[t])),
        );
        const beautify = h('button.btn.sm', { type: 'button', onclick: () => this.#beautify(ed) }, icon('braces', 14), 'Beautify');
        const renderBeautify = () => {
          beautify.hidden = !['json', 'xml', 'html'].includes(b.rawType);
        };
        renderBeautify();
        let large = b.raw.length > LARGE_DOCUMENT;
        const ed = codeEditor({
          doc: b.raw,
          language: b.rawType,
          label: 'Request body',
          placeholder: b.rawType === 'json' ? '{\n  "key": "value"\n}' : '',
          large,
          onChange: (v) => {
            b.raw = v;
            if ((v.length > LARGE_DOCUMENT) !== large) {
              large = !large;
              // The editor is still applying this edit: it takes the change once done.
              queueMicrotask(() => ed.setLarge(large));
            }
            this.changed();
          },
          onSubmit: () => this.app.sendTab(this.tab),
          isVariableDefined: (n) => isVariableDefined(this.vars, n),
        });
        this.bodyEditors.push(ed);
        fill(this.bodyExtra, typeSel, beautify);
        fill(this.bodyContent, ed.el);
        break;
      }
      case 'binary': {
        const file = b.binary;
        fill(
          this.bodyContent,
          h(
            'div.binary-pick',
            h('button.btn', { type: 'button', onclick: async () => { const f = await this.pickFile(); if (f) { b.binary = f; this.changed(); this.#renderBodyContent(); } } }, icon('paperclip', 15), file ? 'Change file' : 'Choose file'),
            file ? h('span', h('strong', file.name), h('span', { style: { color: 'var(--text-muted)' } }, ` ${formatBytes(file.size)}${file.type ? `, ${file.type}` : ''}`)) : h('span', { style: { color: 'var(--text-muted)' } }, 'No file chosen'),
            file ? h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Remove file', onclick: () => { b.binary = null; this.changed(); this.#renderBodyContent(); } }, icon('x', 14)) : null,
          ),
          h('p.field-hint', 'The file is sent as the request body as is. It stays on this device and is not synced.'),
        );
        break;
      }
      case 'graphql': {
        const q = codeEditor({ doc: b.graphql.query, language: 'text', label: 'GraphQL query', placeholder: 'query {\n  viewer { id }\n}', onChange: (v) => { b.graphql.query = v; this.changed(); }, onSubmit: () => this.app.sendTab(this.tab), isVariableDefined: (n) => isVariableDefined(this.vars, n) });
        const v = codeEditor({ doc: b.graphql.variables, language: 'json', label: 'GraphQL variables', placeholder: '{\n  "id": 1\n}', onChange: (val) => { b.graphql.variables = val; this.changed(); }, isVariableDefined: (n) => isVariableDefined(this.vars, n) });
        this.bodyEditors.push(q, v);
        fill(this.bodyContent, h('div.graphql-grid', h('div.field', h('span.field-label', 'Query'), q.el), h('div.field', h('span.field-label', 'Variables'), v.el)));
        break;
      }
      default:
        fill(this.bodyContent);
    }
  }

  #beautify(ed) {
    const b = this.draft.body;
    const text = ed.getValue();
    try {
      let out = text;
      if (b.rawType === 'json') {
        try {
          out = prettyJsonBody(text);
        } catch (err) {
          toast({ kind: 'error', title: 'The body is not valid JSON', text: err.message });
          return;
        }
      } else out = prettyXml(text);
      ed.setValue(out);
      b.raw = out;
      this.changed();
    } catch {
      toast({ kind: 'error', title: 'Could not format the body' });
    }
  }

  /** Opens the file chooser and stores the file locally. Returns a file ref. */
  pickFile() {
    return new Promise((resolve) => {
      const input = h('input', { type: 'file', style: { display: 'none' } });
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        input.remove();
        if (!file) return resolve(null);
        const ref = await this.app.ws.putFile(file);
        resolve({ ref, name: file.name, size: file.size, type: file.type });
      });
      input.addEventListener('cancel', () => {
        input.remove();
        resolve(null);
      });
      document.body.append(input);
      input.click();
    });
  }

  // Scripts --------------------------------------------------------------------------

  render_scripts(panel) {
    const ed = createScriptsEditor({
      scripts: this.draft.scripts,
      label: 'Request scripts',
      isVariableDefined: (n) => isVariableDefined(this.vars, n),
      onChange: (scripts) => {
        this.draft.scripts = scripts;
        this.changed();
      },
    });
    this.editors.push(ed);
    fill(panel, ed.el);
  }

  // Settings ---------------------------------------------------------------------------

  render_settings(panel) {
    const s = this.draft.settings;
    const row = (title, desc, control) => h('div.setting-row', h('div.setting-text', h('span.setting-title', { id: control.id ? `${control.id}-l` : null }, title), h('span.setting-desc', desc)), control);
    const sw = (key) => {
      const id = domId('set');
      const el = h('input.switch', { type: 'checkbox', id, role: 'switch', checked: s[key], 'aria-labelledby': `${id}-l`, onchange: (e) => { s[key] = e.target.checked; this.changed(); } });
      return el;
    };
    const timeoutId = domId('set');
    const timeout = h('input.input', { type: 'number', id: timeoutId, min: 0, step: 100, value: s.timeoutMs || '', placeholder: 'App default', 'aria-labelledby': `${timeoutId}-l`, oninput: (e) => { s.timeoutMs = Math.max(0, Number(e.target.value) || 0); this.changed(); } });
    const transportId = domId('set');
    const transport = h(
      'select.select',
      { id: transportId, 'aria-labelledby': `${transportId}-l`, onchange: (e) => { s.transport = e.target.value; this.changed(); } },
      [['auto', 'App default'], ['browser', 'Browser'], ['relay', 'Puter relay']].map(([v, l]) => h('option', { value: v, selected: s.transport === v }, l)),
    );
    fill(
      panel,
      h(
        'div.settings-list',
        row('Follow redirects', 'Follow 3xx responses to their final destination. Has no effect while Follow redirects is off in Settings.', sw('followRedirects')),
        row('Encode URL', 'Percent-encode characters that are not allowed in URLs, such as spaces.', sw('encodeUrl')),
        row('Timeout', 'Milliseconds to wait for a response. Empty uses the app setting.', timeout),
        row('Send through', 'Overrides the app setting for this request.', transport),
      ),
    );
  }

  // Docs -----------------------------------------------------------------------------------

  render_docs(panel) {
    const id = domId('docs');
    const area = h('textarea.textarea.docs-area', { id, value: this.draft.description, placeholder: 'Describe what this request does, its parameters and expected responses.', oninput: (e) => { this.draft.description = e.target.value; this.changed(); } });
    const examples = h('div.examples');
    const renderExamples = () =>
      fill(
        examples,
        this.draft.examples.length
          ? h(
              'ul.example-list',
              this.draft.examples.map((ex, i) =>
                h(
                  'li',
                  h('span.status-pill', { dataset: { class: ex.status < 300 ? 'success' : ex.status < 400 ? 'redirect' : ex.status < 500 ? 'client' : 'server' } }, String(ex.status)),
                  h('span.example-name', ex.name),
                  h('button.btn.sm', { type: 'button', onclick: () => this.#showExample(ex) }, 'View'),
                  h('button.icon-btn.sm', { type: 'button', 'aria-label': `Delete example ${ex.name}`, onclick: () => { this.draft.examples.splice(i, 1); this.changed(); renderExamples(); } }, icon('trash', 14)),
                ),
              ),
            )
          : h('p.field-hint', 'Save a response as an example from the response menu to document what this request returns.'),
      );
    renderExamples();
    this.renderExamples = renderExamples;
    fill(panel, h('div.field', h('label.field-label', { for: id }, 'Description'), area), h('div.field', h('span.field-label', 'Examples'), examples));
  }

  async #saveExample(result) {
    const r = result.response;
    const name = await promptDialog({ title: 'Save as example', label: 'Example name', value: `${r.status} ${r.statusText || ''}`.trim(), confirmLabel: 'Save example' });
    if (!name) return;
    this.draft.examples.push({
      id: crypto.randomUUID(),
      name,
      status: r.status,
      statusText: r.statusText,
      headers: r.headers.map(([key, value]) => ({ id: crypto.randomUUID(), key, value, enabled: true, description: '' })),
      body: decodeText(r.body.subarray(0, 512 * 1024), responseCharset(r)),
      request: { method: this.draft.method, url: this.draft.url },
    });
    this.changed();
    this.renderExamples?.();
    toast({ kind: 'success', title: 'Example added', text: this.tab.refId ? 'Save the request to keep it.' : 'Save the request to a collection to keep it.' });
  }

  async #showExample(ex) {
    const ed = codeEditor({ doc: ex.body.trim().startsWith('{') || ex.body.trim().startsWith('[') ? prettyJson(ex.body) : ex.body, readOnly: true, language: 'json', label: 'Example body', wrap: true });
    openDialog({
      title: ex.name,
      wide: true,
      body: [h('p', { style: { margin: 0 } }, h('span.status-pill', { dataset: { class: 'success' } }, `${ex.status} ${ex.statusText || ''}`)), h('div', { style: { height: '50vh', display: 'flex' } }, ed.el)],
      onClose: () => ed.destroy(),
    });
  }

  // Response layout -------------------------------------------------------------------

  #wireSplit() {
    const key = 'split';
    let start = 0;
    let startRatio = 0;
    const apply = (ratio) => {
      const r = Math.min(0.85, Math.max(0.15, ratio));
      this.top.style.flex = `0 0 ${r * 100}%`;
      this.resizer.setAttribute('aria-valuenow', String(Math.round(r * 100)));
    };
    this.resizer.setAttribute('aria-valuemin', '15');
    this.resizer.setAttribute('aria-valuemax', '85');
    const side = () => this.split.classList.contains('side');
    const onMove = (e) => {
      const rect = this.split.getBoundingClientRect();
      const d = side() ? (e.clientX - start) / rect.width : (e.clientY - start) / rect.height;
      const r = Math.min(0.85, Math.max(0.15, startRatio + d));
      apply(r);
      prefs.set(key, r);
    };
    const stop = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', stop);
      document.body.classList.remove('resizing', 'resizing-y');
    };
    this.resizer.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      start = side() ? e.clientX : e.clientY;
      startRatio = prefs.get(key);
      document.body.classList.add(side() ? 'resizing' : 'resizing-y');
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', stop);
    });
    this.resizer.addEventListener('keydown', (e) => {
      const dec = side() ? 'ArrowLeft' : 'ArrowUp';
      const inc = side() ? 'ArrowRight' : 'ArrowDown';
      if (e.key !== dec && e.key !== inc) return;
      e.preventDefault();
      const r = Math.min(0.85, Math.max(0.15, prefs.get(key) + (e.key === inc ? 0.05 : -0.05)));
      apply(r);
      prefs.set(key, r);
    });
    this.applySplit = () => apply(prefs.get(key));
    this.applySplit();
  }

  setLayout(layout) {
    this.layout = layout;
    this.#fitLayout();
  }

  /** Side by side needs room for both panes: a narrower split shows the response below, as Settings says. */
  #fitLayout() {
    const width = this.split.clientWidth;
    const side = this.layout === 'side' && !(width && width < SIDE_BY_SIDE_MIN);
    if (this.split.classList.contains('side') === side) return;
    this.split.classList.toggle('side', side);
    this.resizer.setAttribute('aria-orientation', side ? 'vertical' : 'horizontal');
    this.applySplit?.();
  }

  #mobileSwitch() {
    const seg = h('div.segmented', { role: 'radiogroup', 'aria-label': 'Show' });
    for (const [k, label] of [['request', 'Request'], ['response', 'Response']]) {
      seg.append(h('button', { type: 'button', role: 'radio', dataset: { k }, 'aria-checked': String((this.tab.mobilePane || 'request') === k), onclick: () => this.#setMobile(k) }, label));
    }
    this.mobileSeg = seg;
    return seg;
  }

  #setMobile(k) {
    this.tab.mobilePane = k;
    this.split.dataset.mobile = k;
    for (const b of this.mobileSeg.children) b.setAttribute('aria-checked', String(b.dataset.k === k));
  }

  // Sending ----------------------------------------------------------------------------------

  #onSendClick(e) {
    // Send turns into Cancel under the pointer: the second click of a double-click must not cancel.
    // Keyboard presses (detail 0) and later clicks still do.
    if (this.tab.abort && e.detail > 0 && performance.now() - this.tab.sendStarted < 300) return;
    this.app.sendTab(this.tab);
  }

  onSending(on) {
    this.sendBtn.classList.toggle('sending', on);
    fill(this.sendBtn, on ? icon('x', 15) : icon('sendH', 15), h('span', on ? 'Cancel' : 'Send'));
    this.sendBtn.setAttribute('aria-label', on ? 'Cancel request' : 'Send');
    this.response.setSending(on);
    if (on) this.#setMobile('response');
  }

  showResult(result) {
    // Pre-request scripts may change what was sent; the draft itself is never changed.
    this.response.show(result);
  }

  async #restoreResponse() {
    const saved = await this.app.ws.getResponse(this.tab.refId).catch(() => null);
    // A send that started meanwhile owns the response area.
    if (!saved || this.tab.result || this.tab.abort) return;
    const { tests = [], warnings = [], ...response } = saved;
    this.tab.result = { response, tests, logs: [], warnings, error: null, restored: true };
    this.response.show(this.tab.result);
  }

  // Code snippet panel ---------------------------------------------------------------------

  onRightPanel(open) {
    this.codeBtn?.setAttribute('aria-pressed', String(open && this.app.rightPanelKind === 'code'));
  }

  renderRightPanel(container) {
    this.rightContainer = container;
    return this.#renderCode();
  }

  async #renderCode() {
    const container = this.rightContainer;
    if (!container || container.hidden || this.app.activeTab !== this.tab) return;
    const { LANGUAGES, generateCode } = await codegen();
    const lang = prefs.get('codeLang') || 'curl';
    let code;
    try {
      const { resolved } = resolveRequest(this.draft, { parents: this.loc?.parents || [], resolver: { resolve: this.vars.resolve } });
      code = generateCode(lang, resolved);
    } catch (err) {
      code = `// ${err.message}`;
    }
    if (this.codeView && container.contains(this.codeView.el)) {
      this.codeView.setValue(code);
      this.codeView.setLanguage(langSyntax(LANGUAGES, lang));
      return;
    }
    const select = h(
      'select.select.sm',
      { 'aria-label': 'Language', onchange: (e) => { prefs.set('codeLang', e.target.value); this.#renderCode(); } },
      LANGUAGES.map((l) => h('option', { value: l.id, selected: l.id === lang }, l.label)),
    );
    const copy = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Copy code', title: 'Copy', onclick: () => navigator.clipboard?.writeText(this.codeView.getValue()).then(() => toast({ kind: 'success', title: 'Code copied' })) }, icon('copy', 15));
    const close = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Close code snippet', onclick: () => this.app.toggleRightPanel('code') }, icon('x', 15));
    this.codeView?.destroy();
    this.codeView = codeEditor({ doc: code, readOnly: true, language: langSyntax(LANGUAGES, lang), label: 'Code snippet', wrap: true, lineNumbers: false, fold: false, className: 'bare' });
    fill(
      container,
      h('div.right-head', h('h2.right-title', icon('code', 15), 'Code snippet'), h('span.spacer'), copy, close),
      h('div.right-tools', select),
      h('div.right-body', this.codeView.el),
      h('p.right-note', 'Variables are filled in with values from the active environment.'),
    );
  }

  async copyAs(lang) {
    try {
      const { generateCode } = await codegen();
      const { resolved } = resolveRequest(this.draft, { parents: this.loc?.parents || [], resolver: { resolve: this.vars.resolve } });
      await navigator.clipboard.writeText(generateCode(lang, resolved));
      toast({ kind: 'success', title: 'Copied as cURL' });
    } catch {
      toast({ kind: 'error', title: 'Could not copy to the clipboard' });
    }
  }

  // Lifecycle ---------------------------------------------------------------------------------

  onShow({ focus } = {}) {
    this.#renderHead();
    if (focus) setTimeout(() => (this.draft.url ? this.tabsEl.querySelector('[aria-selected="true"]') : this.url.input)?.focus(), 0);
  }

  onHide() {}

  destroy() {
    for (const ed of [...this.editors, ...(this.bodyEditors || [])]) ed.destroy();
    this.codeView?.destroy();
    this.response.destroy();
    this.splitObserver.disconnect();
  }
}

function maskAuth(v) {
  const sp = v.indexOf(' ');
  if (sp < 0) return '••••••••';
  return `${v.slice(0, sp)} ••••••••`;
}

function langSyntax(languages, id) {
  const l = languages.find((x) => x.id === id);
  const s = l?.syntax || 'text';
  return s === 'javascript' ? 'javascript' : 'text';
}

