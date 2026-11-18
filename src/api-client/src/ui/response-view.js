/**
 * Response pane: status line, body (pretty, raw, preview), headers, cookies
 * and test results. Large bodies are formatted in a worker and shown in a
 * virtualized editor with syntax highlighting turned off past a size limit.
 */
import { h, fill, domId, shortcut, announce } from '../lib/dom.js';
import { icon } from './icons.js';
import { codeEditor } from './code-editor.js';
import { showPopover } from './popover.js';
import { menuButton } from './menu.js';
import { toast } from './toast.js';
import { formatBytes, formatMs, statusClass, statusText } from '../lib/format.js';
import { languageFor, looksLikeText, isTextContentType, decodeText, declaredCharset } from '../core/pretty.js';
import { format } from '../core/formatter.js';
import { contentTypeOf, charsetOf } from '../core/send.js';
import { parseSetCookie } from '../core/cookies.js';
import { prefs } from './prefs.js';

const LARGE = 3 * 1048576;
const HUGE = 40 * 1048576;
const LANGS = [['json', 'JSON'], ['xml', 'XML'], ['html', 'HTML'], ['javascript', 'JavaScript'], ['text', 'Text']];
// A language Format as does not offer (CSS) is shown as Text, so the list says what is shown.
const shownLanguage = (lang) => (LANGS.some(([v]) => v === lang) ? lang : 'text');

/** The charset the server names for a response, or else the one an HTML or XML body declares. */
export function responseCharset(r) {
  const named = charsetOf(r.headers);
  if (named) return named;
  const lang = languageFor(contentTypeOf(r.headers), new TextDecoder('latin1').decode(r.body.subarray(0, 512)));
  return lang === 'html' || lang === 'xml' ? declaredCharset(r.body) : '';
}

export class ResponseView {
  constructor(app, tab, { onRetry, onRelay, onSignInSend, onSaveExample } = {}) {
    this.app = app;
    this.tab = tab;
    this.onRetry = onRetry;
    this.onRelay = onRelay;
    this.onSignInSend = onSignInSend;
    this.onSaveExample = onSaveExample;
    this.result = null;
    this.section = 'body';
    this.mode = 'pretty';
    this.language = null;
    this.editor = null;
    this.blobUrl = null;
    this.el = h('section.resp', { 'aria-label': 'Response' });
    this.renderEmpty();
  }

  destroy() {
    this.editor?.destroy();
    clearInterval(this.timer);
    clearTimeout(this.filterTimer);
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
  }

  renderEmpty() {
    this.editor?.destroy();
    this.editor = null;
    fill(
      this.el,
      h('div.resp-bar', h('h2.resp-title', 'Response')),
      h(
        'div.resp-empty',
        icon('sendH', 28),
        h('p', 'Send the request to see the response here.'),
        h('p.resp-hint', h('kbd', shortcut('Mod+Enter')), h('span', ' to send')),
      ),
    );
  }

  setSending(on) {
    clearInterval(this.timer);
    if (!on) return;
    // A view rebuilt mid-send keeps counting from when the request started.
    const started = this.tab.sendStarted ?? performance.now();
    const elapsed = h('span.resp-elapsed', formatMs(performance.now() - started));
    this.timer = setInterval(() => {
      elapsed.textContent = formatMs(performance.now() - started);
    }, 100);
    this.editor?.destroy();
    this.editor = null;
    fill(
      this.el,
      h('div.resp-bar', h('h2.resp-title', 'Response')),
      h(
        'div.resp-empty',
        { role: 'status' },
        h('div.spinner', { 'aria-hidden': 'true' }),
        h('p', 'Sending request... ', elapsed),
        h('button.btn.sm', { type: 'button', onclick: () => this.tab.abort?.abort() }, 'Cancel'),
      ),
    );
  }

  show(result) {
    this.result = result;
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }
    this.language = null;
    if (!result) return this.renderEmpty();
    if (!result.response) return this.#renderError(result);
    const failed = result.tests.filter((t) => !t.passed && !t.skipped).length;
    if (this.section === 'tests' && !result.tests.length) this.section = 'body';
    if (failed && this.section === 'body' && result.error?.phase !== 'post') {
      // Keep the body visible; the tests tab shows the failure count.
    }
    this.#render();
  }

  #renderError(result) {
    const err = result.error || { message: 'Something went wrong.' };
    const signedIn = this.app.session.signedIn;
    const actions = [];
    if (err.code !== 'aborted') actions.push(h('button.btn.sm', { type: 'button', onclick: () => this.onRetry?.() }, icon('refresh', 14), 'Try again'));
    const signInSend = (transport) => h('button.btn.sm.primary', { type: 'button', onclick: () => this.onSignInSend?.(transport) }, icon('logIn', 14), 'Sign in and send');
    if (err.code === 'signed-out') {
      // Signed out, or the Puter session expired: the relay needs an account.
      if (this.app.session.puter) actions.push(signInSend(err.transport === 'relay' ? 'relay' : null));
    } else if (['cors', 'network', 'mixed-content'].includes(err.code) && err.transport !== 'relay') {
      if (signedIn) actions.push(h('button.btn.sm.primary', { type: 'button', onclick: () => this.onRelay?.() }, icon('server', 14), 'Send through Puter relay'));
      else if (this.app.session.puter) actions.push(signInSend('relay'));
    }
    if (err.code === 'script') actions.push(h('button.btn.sm', { type: 'button', onclick: () => this.app.console.setOpen(true) }, icon('terminal', 14), 'Open console'));
    const title = err.code === 'aborted' ? 'Request cancelled' : err.code === 'script' ? 'Script error' : err.code === 'timeout' ? 'Request timed out' : 'Could not send request';
    this.editor?.destroy();
    this.editor = null;
    fill(
      this.el,
      h('div.resp-bar', h('h2.resp-title', 'Response')),
      h(
        'div.resp-error',
        { role: err.code === 'aborted' ? 'status' : 'alert' },
        h('div.resp-error-icon', icon(err.code === 'aborted' ? 'circleSlash' : 'alert', 26)),
        h('h3', title),
        h('p', err.message),
        err.hint ? h('p.resp-hint', err.hint) : null,
        result.resolved ? h('p.resp-url.mono', `${result.resolved.method} ${result.resolved.url}`) : null,
        actions.length ? h('div.resp-error-actions', actions) : null,
        result.tests?.length ? this.#testsList(result.tests) : null,
      ),
    );
  }

  #render() {
    const r = this.result.response;
    const tests = this.result.tests;
    const passed = tests.filter((t) => t.passed).length;
    const failed = tests.filter((t) => !t.passed && !t.skipped).length;
    const cookies = this.#cookies();
    const tabsId = domId('resp');
    const sections = [
      ['body', 'Body', null],
      ['cookies', 'Cookies', cookies.length || null],
      ['headers', 'Headers', r.headers.length],
      ['tests', 'Test Results', tests.length ? `${passed}/${tests.length}` : null],
    ];
    const tablist = h(
      'div.tabs.resp-tabs',
      { role: 'tablist', 'aria-label': 'Response sections' },
      sections.map(([key, label, count]) =>
        h(
          'button.tab',
          {
            type: 'button',
            role: 'tab',
            id: `${tabsId}-${key}`,
            'aria-selected': String(this.section === key),
            'aria-controls': `${tabsId}-panel`,
            tabindex: this.section === key ? '0' : '-1',
            onclick: () => {
              this.section = key;
              this.#render();
              this.el.querySelector(`#${tabsId}-${key}`)?.focus();
            },
          },
          label,
          count != null ? h(`span.count${key === 'tests' && failed ? '.fail' : ''}`, String(count)) : null,
        ),
      ),
    );
    tablist.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const keys = sections.map((s) => s[0]);
      const i = keys.indexOf(this.section);
      this.section = keys[(i + (e.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length];
      this.#render();
      this.el.querySelector(`#${tabsId}-${this.section}`)?.focus();
    });
    const cls = statusClass(r.status);
    const status = h('span.status-pill', { dataset: { class: cls } }, `${r.status || ''} ${statusText(r.status, r.statusText)}`.trim());
    const timeBtn = h('button.resp-metric', { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', title: 'Timing details' }, formatMs(r.timeMs));
    timeBtn.addEventListener('click', () => showPopover(timeBtn, this.#timing(r), { align: 'end', label: 'Timing', focus: false }));
    const sizeBtn = h('button.resp-metric', { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', title: 'Size details' }, formatBytes(r.size?.body ?? r.body.length));
    sizeBtn.addEventListener('click', () => showPopover(sizeBtn, this.#sizes(r), { align: 'end', label: 'Size', focus: false }));
    const transport = h(
      'span.resp-transport',
      { title: r.transport === 'relay' ? 'Sent through the Puter relay' : 'Sent from the browser' },
      icon(r.transport === 'relay' ? 'server' : 'globe', 13),
      h('span', r.transport === 'relay' ? 'Relay' : 'Browser'),
    );
    const more = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Response actions' }, icon('more', 16));
    menuButton(more, () => [
      { label: 'Save response to file', icon: 'download', run: () => this.#download() },
      { label: 'Copy body', icon: 'copy', run: () => this.#copyBody() },
      this.onSaveExample ? { label: 'Save as example', icon: 'save', run: () => this.onSaveExample(this.result) } : null,
      '-',
      { label: 'Clear response', icon: 'x', run: () => this.#clear() },
    ], { align: 'end', label: 'Response actions' });
    const panel = h('div.resp-panel', { id: `${tabsId}-panel`, role: 'tabpanel', 'aria-labelledby': `${tabsId}-${this.section}` });
    const warnings = this.result.warnings?.length
      ? h('div.resp-warnings', this.result.warnings.map((w) => h('div.callout', { dataset: { kind: 'warning' } }, icon('warning', 14), h('span', w))))
      : null;
    const scriptErr = this.result.error ? h('div.callout.resp-script-error', { dataset: { kind: 'error' } }, icon('alert', 14), h('span', this.result.error.message)) : null;
    this.editor?.destroy();
    this.editor = null;
    fill(
      this.el,
      h(
        'div.resp-bar',
        tablist,
        h('div.resp-meta', { role: 'group', 'aria-label': 'Response summary' }, status, h('span.sep'), timeBtn, h('span.sep'), sizeBtn, h('span.sep'), transport, more),
      ),
      scriptErr,
      warnings,
      panel,
    );
    if (this.section === 'body') this.#renderBody(panel);
    else if (this.section === 'headers') this.#renderHeaders(panel, r.headers);
    else if (this.section === 'cookies') this.#renderCookies(panel, cookies);
    else this.#renderTests(panel);
  }

  #timing(r) {
    const t = r.timings || {};
    const rows = [
      ['Connect', t.connect, 'Opening the connection, including TLS'],
      ['Waiting', t.firstByte, 'Time to the first byte of the response'],
      ['Download', t.download, 'Receiving the response'],
    ].filter(([, v]) => v != null && !Number.isNaN(v));
    const total = r.timeMs || 1;
    return h(
      'div.metric-pop',
      h('div.metric-head', h('span', 'Total'), h('strong', formatMs(r.timeMs))),
      rows.length
        ? rows.map(([label, v, desc]) =>
            h(
              'div.metric-row',
              { title: desc },
              h('span', label),
              h('div.metric-bar', h('span', { style: { width: `${Math.max(2, Math.min(100, (v / total) * 100))}%` } })),
              h('span.mono', formatMs(v)),
            ),
          )
        : null,
      h('p.metric-note', r.transport === 'relay' ? 'Measured in this browser, through the Puter relay.' : 'Measured in this browser. Browsers hide connection details for cross-origin requests.'),
    );
  }

  #sizes(r) {
    const rows = [
      ['Body', r.size?.body ?? r.body.length],
      r.size?.encoded != null && r.size.encoded !== r.size.body ? ['On the wire', r.size.encoded] : null,
      ['Headers', r.size?.headers],
    ].filter(Boolean);
    return h('div.metric-pop', h('div.metric-head', h('span', 'Response size')), rows.map(([k, v]) => h('div.metric-row.plain', h('span', k), h('span.mono', formatBytes(v)))));
  }

  #cookies() {
    const set = this.result.response.headers.filter(([k]) => k.toLowerCase() === 'set-cookie').map(([, v]) => v);
    return set.map((v) => parseSetCookie(v)).filter(Boolean);
  }

  // Body ------------------------------------------------------------------------

  #contentType() {
    return contentTypeOf(this.result.response.headers);
  }

  #renderBody(panel) {
    const r = this.result.response;
    const ct = this.#contentType();
    const bytes = r.body;
    if (!bytes.length) {
      fill(panel, h('div.resp-empty.small', h('p', r.status === 204 || r.status === 304 ? 'This response has no body.' : 'The response body is empty.')));
      return;
    }
    const isImage = /^image\//.test(ct);
    const isPdf = ct === 'application/pdf';
    const isMedia = /^(audio|video)\//.test(ct);
    const textual = isTextContentType(ct) || (!isImage && !isPdf && !isMedia && looksLikeText(bytes));
    const lang = this.language || shownLanguage(languageFor(ct, textual ? new TextDecoder().decode(bytes.subarray(0, 512)) : ''));
    const canPreview = isImage || isPdf || isMedia || lang === 'html' || ct === 'image/svg+xml';
    if (!textual && !canPreview) {
      fill(
        panel,
        h(
          'div.resp-empty.small',
          icon('fileText', 24),
          h('p', `Binary response (${ct || 'unknown type'}, ${formatBytes(bytes.length)}).`),
          h('button.btn.sm', { type: 'button', onclick: () => this.#download() }, icon('download', 14), 'Save to file'),
        ),
      );
      return;
    }
    // What this body is shown as; this.mode stays the user's choice for the next response.
    this.shown = !textual ? 'preview' : this.mode === 'preview' && !canPreview ? 'pretty' : this.mode;
    const modes = [textual ? ['pretty', 'Pretty'] : null, textual ? ['raw', 'Raw'] : null, canPreview ? ['preview', 'Preview'] : null].filter(Boolean);
    const seg = h(
      'div.segmented',
      { role: 'radiogroup', 'aria-label': 'Body view' },
      modes.map(([k, label]) =>
        h('button', { type: 'button', role: 'radio', 'aria-checked': String(this.shown === k), onclick: () => { this.mode = k; this.#renderBody(panel); } }, label),
      ),
    );
    const langSelect =
      this.shown === 'pretty'
        ? h(
            'select.select.sm.resp-lang',
            { 'aria-label': 'Format as', onchange: (e) => { this.language = e.target.value; this.#renderBody(panel); } },
            LANGS.map(([v, l]) => h('option', { value: v, selected: v === lang }, l)),
          )
        : null;
    const wrapBtn = h(
      'button.icon-btn.sm',
      { type: 'button', 'aria-label': 'Wrap lines', 'aria-pressed': String(prefs.get('wrapResponse')), title: 'Wrap lines', onclick: () => { prefs.set('wrapResponse', !prefs.get('wrapResponse')); wrapBtn.setAttribute('aria-pressed', String(prefs.get('wrapResponse'))); this.editor?.setWrap(prefs.get('wrapResponse')); } },
      icon('wrap', 15),
    );
    const searchBtn = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Find in response', title: `Find (${shortcut('Mod+F')})`, onclick: () => this.editor?.openSearch() }, icon('search', 15));
    const copyBtn = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Copy response body', title: 'Copy', onclick: () => this.#copyBody() }, icon('copy', 15));
    const canFilter = this.shown === 'pretty' && lang === 'json' && bytes.length <= LARGE;
    const filterRow = canFilter ? this.#filterRow() : null;
    const filterBtn = canFilter
      ? h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Filter with a JSON path', title: 'Filter with a JSON path', 'aria-pressed': String(!!this.filterOpen), 'aria-controls': filterRow.id }, icon('filter', 15))
      : null;
    filterBtn?.addEventListener('click', () => {
      this.filterOpen = !this.filterOpen;
      filterBtn.setAttribute('aria-pressed', String(this.filterOpen));
      filterRow.hidden = !this.filterOpen;
      if (this.filterOpen) filterRow.querySelector('input').focus();
      else this.#applyFilter('');
    });
    // Images, PDFs and media have no text to copy.
    const tools = h('div.resp-tools', seg, langSelect, h('span.spacer'), filterBtn, this.shown !== 'preview' ? wrapBtn : null, this.shown !== 'preview' ? searchBtn : null, textual ? copyBtn : null);
    const area = h('div.resp-body');
    fill(panel, tools, filterRow, area);
    this.editor?.destroy();
    this.editor = null;
    if (this.shown === 'preview') return this.#renderPreview(area, ct, lang);
    if (bytes.length > HUGE) {
      fill(area, h('div.resp-empty.small', h('p', `This response is ${formatBytes(bytes.length)}, too large to show here.`), h('button.btn.sm', { type: 'button', onclick: () => this.#download() }, icon('download', 14), 'Save to file')));
      return;
    }
    const large = bytes.length > LARGE;
    const editor = codeEditor({ doc: '', readOnly: true, language: this.shown === 'pretty' ? lang : 'text', wrap: prefs.get('wrapResponse'), large, label: 'Response body', className: 'bare' });
    this.editor = editor;
    area.append(editor.el);
    const loading = large ? h('div.resp-loading', { role: 'status' }, h('div.spinner'), h('span', 'Formatting...')) : null;
    if (loading) area.append(loading);
    const token = (this.renderToken = (this.renderToken || 0) + 1);
    format({ bytes, language: this.shown === 'pretty' ? lang : 'text', charset: this.#charset() })
      .then(({ text, pretty }) => {
        if (token !== this.renderToken || this.editor !== editor) return;
        this.text = text;
        this.prettyText = pretty;
        this.parsed = undefined;
        editor.setValue(this.shown === 'pretty' ? pretty : text);
        if (this.filterOpen && this.filterQuery) this.#applyFilter(this.filterQuery);
        loading?.remove();
      })
      .catch(() => loading?.remove());
  }

  #filterRow() {
    const id = domId('jp');
    const input = h('input.input.sm.mono', { type: 'text', value: this.filterQuery || '', placeholder: '$.data[*].id', 'aria-label': 'JSON path', 'aria-describedby': `${id}-msg`, spellcheck: false, autocomplete: 'off' });
    const msg = h('span.resp-filter-msg', { id: `${id}-msg`, 'aria-live': 'polite' });
    input.addEventListener('input', () => {
      clearTimeout(this.filterTimer);
      this.filterTimer = setTimeout(() => this.#applyFilter(input.value, msg), 180);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        input.value = '';
        this.#applyFilter('', msg);
      }
    });
    this.filterMsg = msg;
    return h('div.resp-filter', { id, hidden: !this.filterOpen }, icon('filter', 14), input, msg);
  }

  async #applyFilter(path, msg = this.filterMsg) {
    this.filterQuery = path;
    const editor = this.editor;
    // Only the Pretty view shows filter results.
    if (!editor || this.shown !== 'pretty') return;
    if (!path.trim()) {
      this.editor.setValue(this.prettyText ?? '');
      if (msg) msg.textContent = '';
      return;
    }
    try {
      const { query, parseJsonExact } = await import('../core/json-path.js');
      if (this.editor !== editor) return;
      if (this.parsed === undefined) this.parsed = parseJsonExact(this.text ?? this.#bodyText());
      const found = query(this.parsed.value, path);
      this.editor.setValue(found.length ? this.parsed.stringify(found.length === 1 ? found[0] : found) : '');
      if (msg) msg.textContent = found.length ? `${found.length} match${found.length === 1 ? '' : 'es'}` : 'No matches';
    } catch (err) {
      if (msg) msg.textContent = err instanceof SyntaxError ? 'The response is not valid JSON.' : err.message;
    }
  }

  #renderPreview(area, ct, lang) {
    const r = this.result.response;
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }
    if (ct === 'image/svg+xml') {
      // A data: URL keeps the SVG out of this page's origin, so its scripts cannot run here.
      let bin = '';
      for (let i = 0; i < r.body.length; i += 0x8000) bin += String.fromCharCode(...r.body.subarray(i, i + 0x8000));
      fill(area, h('div.resp-preview.media', h('img', { src: `data:image/svg+xml;base64,${btoa(bin)}`, alt: 'Image returned by the server' })));
      return;
    }
    const blob = new Blob([r.body], { type: ct || (lang === 'html' ? 'text/html' : 'application/octet-stream') });
    if (/^image\//.test(ct)) {
      this.blobUrl = URL.createObjectURL(blob);
      fill(area, h('div.resp-preview.media', h('img', { src: this.blobUrl, alt: 'Image returned by the server' })));
    } else if (/^audio\//.test(ct)) {
      this.blobUrl = URL.createObjectURL(blob);
      fill(area, h('div.resp-preview.media', h('audio', { src: this.blobUrl, controls: true })));
    } else if (/^video\//.test(ct)) {
      this.blobUrl = URL.createObjectURL(blob);
      fill(area, h('div.resp-preview.media', h('video', { src: this.blobUrl, controls: true })));
    } else if (ct === 'application/pdf') {
      this.blobUrl = URL.createObjectURL(blob);
      fill(area, h('iframe.resp-frame', { src: this.blobUrl, title: 'PDF preview' }));
    } else {
      // HTML runs with no scripts, no same-origin access, no forms and no navigation.
      const frame = h('iframe.resp-frame', { title: 'HTML preview', sandbox: '', referrerpolicy: 'no-referrer' });
      // srcdoc pages take this app's URL as their base; resolve relative links against the response URL instead.
      const base = /^https?:/i.test(r.url || '') ? `<base href="${r.url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}">` : '';
      // After any doctype: anything before it would put the page in quirks mode.
      const html = this.#bodyText();
      const doctype = html.match(/^\uFEFF?\s*<!doctype[^>]*>/i)?.[0] || '';
      frame.srcdoc = doctype + base + html.slice(doctype.length);
      fill(area, h('p.resp-preview-note', icon('lock', 12), h('span', 'Preview runs without scripts.')), frame);
    }
  }

  #clear() {
    this.tab.result = null;
    // Forget the stored copy too, or it comes back when the tab is reopened.
    if (this.tab.refId) this.app.ws?.saveResponse(this.tab.refId, null).catch(() => {});
    this.show(null);
  }

  #bodyText() {
    const r = this.result.response;
    return decodeText(r.body, this.#charset());
  }

  #charset() {
    return responseCharset(this.result.response);
  }

  async #copyBody() {
    try {
      // What the editor shows (pretty or filtered); the body itself in Preview, which has no editor.
      const r = this.result.response;
      const ct = this.#contentType();
      const textual = isTextContentType(ct) || (!/^(image|audio|video)\//.test(ct) && ct !== 'application/pdf' && looksLikeText(r.body));
      const text = this.editor ? this.editor.getValue() : textual ? this.#bodyText() : '';
      if (!text) {
        toast({ kind: 'info', title: 'Nothing to copy' });
        return;
      }
      await navigator.clipboard.writeText(text);
      toast({ kind: 'success', title: 'Response copied' });
    } catch {
      toast({ kind: 'error', title: 'Could not copy to the clipboard' });
    }
  }

  #download() {
    const r = this.result.response;
    const ct = this.#contentType();
    const ext = { 'application/json': 'json', 'text/html': 'html', 'application/xml': 'xml', 'text/xml': 'xml', 'text/plain': 'txt', 'text/csv': 'csv', 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/webp': 'webp' }[ct] || 'bin';
    const disposition = r.headers.find(([k]) => k.toLowerCase() === 'content-disposition')?.[1] || '';
    const name = filenameFrom(disposition) || `response.${ext}`;
    const url = URL.createObjectURL(new Blob([r.body], { type: ct || 'application/octet-stream' }));
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Headers, cookies, tests ------------------------------------------------------

  #renderHeaders(panel, headers) {
    const filter = h('input.input.sm', { type: 'search', placeholder: 'Filter headers', 'aria-label': 'Filter headers' });
    const tbody = h('tbody');
    const draw = () => {
      const q = filter.value.trim().toLowerCase();
      fill(
        tbody,
        headers
          .filter(([k, v]) => !q || k.toLowerCase().includes(q) || v.toLowerCase().includes(q))
          .map(([k, v]) =>
            h(
              'tr',
              h('td.mono', k),
              h('td.mono', v),
              h('td.copy-cell', h('button.icon-btn.sm', { type: 'button', 'aria-label': `Copy ${k}`, onclick: () => navigator.clipboard?.writeText(v).then(() => announce('Copied')) }, icon('copy', 13))),
            ),
          ),
      );
    };
    filter.addEventListener('input', draw);
    draw();
    const r = this.result.response;
    fill(
      panel,
      h('div.resp-tools', filter, h('span.spacer'), h('span.resp-tools-note', `${headers.length} header${headers.length === 1 ? '' : 's'}`)),
      h('div.resp-scroll', h('table.data-table', h('thead', h('tr', h('th', 'Name'), h('th', 'Value'), h('th', h('span.sr-only', 'Copy')))), tbody)),
      r.transport === 'browser'
        ? h('p.resp-note', icon('info', 13), h('span', 'Browsers only show headers the server exposes to web pages. Send through the Puter relay to see every header.'))
        : null,
    );
  }

  #renderCookies(panel, cookies) {
    const r = this.result.response;
    if (!cookies.length) {
      fill(
        panel,
        h(
          'div.resp-empty.small',
          icon('cookie', 24),
          h('p', r.transport === 'browser' ? 'Browsers do not let web pages read cookies set by other sites.' : 'This response did not set any cookies.'),
          r.transport === 'browser' ? h('p.resp-hint', 'Send through the Puter relay to see and keep cookies.') : null,
        ),
      );
      return;
    }
    fill(
      panel,
      h(
        'div.resp-scroll',
        h(
          'table.data-table',
          h('thead', h('tr', ['Name', 'Value', 'Domain', 'Path', 'Expires', 'Flags'].map((t) => h('th', t)))),
          h(
            'tbody',
            cookies.map((c) =>
              h(
                'tr',
                h('td.mono', c.name),
                h('td.mono', c.value),
                h('td', c.domain || new URL(r.url).hostname),
                h('td', c.path || '/'),
                h('td', c.expires ? new Date(c.expires).toLocaleString() : 'Session'),
                h('td', [c.httpOnly ? 'HttpOnly' : null, c.secure ? 'Secure' : null, c.sameSite ? `SameSite=${c.sameSite}` : null].filter(Boolean).join(', ')),
              ),
            ),
          ),
        ),
      ),
      h('p.resp-note', icon('info', 13), h('span', 'Cookies from relay requests are kept on this device and sent with later relay requests. ', h('button.link-btn', { type: 'button', onclick: () => import('./dialogs.js').then((m) => m.openCookiesDialog(this.app)) }, 'Manage cookies'))),
    );
  }

  #renderTests(panel) {
    fill(panel, this.#testsList(this.result.tests, true));
  }

  #testsList(tests, withFilter = false) {
    if (!tests.length) {
      return h(
        'div.resp-empty.small',
        icon('listChecks', 24),
        h('p', 'No tests ran for this request.'),
        h('p.resp-hint', 'Add tests in the Scripts tab, for example: test("Status is 200", () => expect(response.status).toBe(200))'),
      );
    }
    let filter = this.testFilter || 'all';
    const list = h('ul.test-list');
    const counts = { all: tests.length, passed: tests.filter((t) => t.passed).length, failed: tests.filter((t) => !t.passed && !t.skipped).length, skipped: tests.filter((t) => t.skipped).length };
    // The Skipped button only shows when something was skipped; without it, show everything.
    if (filter === 'skipped' && !counts.skipped) filter = 'all';
    const draw = () => {
      const shown = tests.filter((t) => filter === 'all' || (filter === 'passed' ? t.passed : filter === 'failed' ? !t.passed && !t.skipped : t.skipped));
      fill(
        list,
        shown.map((t) =>
          h(
            `li.test${t.skipped ? '.skipped' : t.passed ? '.passed' : '.failed'}`,
            h('span.test-icon', icon(t.skipped ? 'circleSlash' : t.passed ? 'circleCheck' : 'circleX', 15)),
            h('span.test-state', t.skipped ? 'Skipped' : t.passed ? 'Passed' : 'Failed'),
            h('div.test-text', h('span.test-name', t.name), t.error ? h('span.test-error.mono', t.error) : null),
            t.source ? h('span.test-source', t.source) : null,
          ),
        ),
      );
    };
    const seg = withFilter
      ? h(
          'div.segmented',
          { role: 'radiogroup', 'aria-label': 'Show tests' },
          [['all', 'All'], ['passed', 'Passed'], ['failed', 'Failed'], ['skipped', 'Skipped']]
            .filter(([k]) => k !== 'skipped' || counts.skipped)
            .map(([k, label]) => {
              const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(filter === k) }, `${label} ${counts[k]}`);
              b.addEventListener('click', () => {
                filter = this.testFilter = k;
                for (const x of seg.children) x.setAttribute('aria-checked', String(x === b));
                draw();
              });
              return b;
            }),
        )
      : null;
    draw();
    return h('div.tests', seg ? h('div.resp-tools', seg) : null, h('div.resp-scroll', list));
  }
}

/** File name from a Content-Disposition header, preferring the RFC 5987 filename* form. */
export function filenameFrom(disposition) {
  const extended = disposition.match(/filename\*\s*=\s*([^']*)'[^']*'([^;\s]+)/i);
  if (extended) {
    try {
      return decodeURIComponent(extended[2]);
    } catch {
      // Not UTF-8 percent-encoding: try the plain form.
    }
  }
  const plain = disposition.match(/(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i);
  if (!plain) return '';
  const name = (plain[1] ?? plain[2]).replace(/\\(.)/g, '$1').trim();
  try {
    return decodeURIComponent(name); // Some servers percent-encode the plain form too.
  } catch {
    return name;
  }
}
