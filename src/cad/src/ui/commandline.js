/**
 * Command line: shows the current prompt with clickable options, accepts
 * typed commands and values, keeps a scrollable history, and suggests
 * commands as you type.
 */
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { showMenu } from './menu.js';

const MAX_HISTORY = 400;

export class CommandLine {
  constructor(app) {
    this.app = app;
    this.typed = [];
    this.typedIndex = -1;
    this.suggestions = [];
    this.suggestIndex = -1;
    this.expanded = false;

    this.history = h('div.cmd-history', { role: 'log', 'aria-live': 'polite', 'aria-label': 'Command history' });
    this.promptEl = h('span.cmd-prompt', { 'aria-live': 'polite' });
    this.optionsEl = h('span.cmd-options');
    this.input = h('input.cmd-input', {
      type: 'text',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      'aria-label': 'Command',
      role: 'combobox',
      'aria-expanded': 'false',
      'aria-autocomplete': 'list',
      'aria-controls': 'cmd-suggest',
      enterkeyhint: 'enter',
      placeholder: 'Type a command',
    });
    this.suggestEl = h('ul.cmd-suggest', { id: 'cmd-suggest', role: 'listbox', 'aria-label': 'Command suggestions', hidden: true });
    this.menuBtn = h(
      'button.icon-btn.cmd-btn',
      { type: 'button', 'aria-label': 'Recent commands', 'aria-haspopup': 'menu', 'data-tip': 'Recent commands', onClick: (e) => this.recentMenu(e.currentTarget) },
      icon('terminal', 16),
    );
    this.expandBtn = h(
      'button.icon-btn.cmd-btn',
      { type: 'button', 'aria-label': 'Show command history', 'aria-expanded': 'false', 'data-tip': 'Command history', 'data-tip-keys': 'F2', onClick: () => this.toggleHistory() },
      icon('history', 16),
    );
    this.enterBtn = h('button.btn.sm.cmd-action', { type: 'button', onClick: () => this.submit() }, 'Enter');
    this.cancelBtn = h('button.btn.sm.ghost.cmd-action', { type: 'button', onClick: () => this.app.editor.cancel() }, 'Cancel');
    this.line = h(
      'div.cmd-line',
      this.menuBtn,
      h('div.cmd-main', h('div.cmd-text', this.promptEl, this.optionsEl), this.input),
      h('div.cmd-actions', this.cancelBtn, this.enterBtn),
      this.expandBtn,
    );
    this.el = h('div.cmdline', { role: 'region', 'aria-label': 'Command line' }, this.suggestEl, this.history, this.line);
    this.el.classList.add('idle');
    this._bind();
    this.prompt(null);
  }

  _bind() {
    const inp = this.input;
    inp.addEventListener('keydown', (e) => this._key(e));
    inp.addEventListener('input', () => {
      this._suggest();
      this.app.editor?.drawOverlay();
    });
    // Text picked in the history stays selected until the next press elsewhere
    // (the canvas keeps the browser from clearing it), so Copy can tell text
    // that is meant to be copied from a selection left behind.
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (!this.history.contains(e.target) && this.textSelected()) window.getSelection().removeAllRanges();
      },
      true,
    );
    // Later, so a click on a suggestion still lands; not when typing has refocused the line.
    inp.addEventListener('blur', () =>
      setTimeout(() => document.activeElement !== inp && this._hideSuggest(), 120),
    );
  }

  _key(e) {
    // Enter and Space belong to the input method while it composes (Space picks a candidate).
    if (e.isComposing || e.keyCode === 229) return;
    const ed = this.app.editor;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (this.suggestIndex >= 0 && !this.suggestEl.hidden) return this._pick(this.suggestIndex);
      this.submit();
    } else if (e.key === ' ' && ed.spaceSubmits) {
      e.preventDefault();
      if (this.suggestIndex >= 0 && !this.suggestEl.hidden) return this._pick(this.suggestIndex);
      this.submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (!this.suggestEl.hidden) return this._hideSuggest();
      this.input.value = '';
      ed.cancel();
      this.app.focusCanvas();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      if (!this.suggestEl.hidden && this.suggestions.length) {
        this.suggestIndex = (this.suggestIndex + dir + this.suggestions.length) % this.suggestions.length;
        this._renderSuggest();
        return;
      }
      if (!this.typed.length) return;
      if (this.typedIndex < 0) this.typedIndex = this.typed.length;
      this.typedIndex = Math.max(0, Math.min(this.typed.length, this.typedIndex + dir));
      this.input.value = this.typed[this.typedIndex] ?? '';
    } else if (e.key === 'Tab' && !this.suggestEl.hidden && this.suggestions.length) {
      e.preventDefault();
      this.suggestIndex = (this.suggestIndex + (e.shiftKey ? -1 : 1) + this.suggestions.length) % this.suggestions.length;
      this._renderSuggest();
    } else if (e.key === 'F2') {
      e.preventDefault();
      this.toggleHistory();
    } else if (e.key === 'Backspace' && !this.input.value && this.app.editor.request) {
      e.preventDefault();
    }
  }

  submit() {
    const text = this.input.value;
    this.input.value = '';
    this._hideSuggest();
    if (text.trim()) this._remember(text);
    this.typedIndex = -1;
    this.app.editor.submit(text);
    this.app.editor.drawOverlay();
  }

  /** Insert a typed character coming from the canvas. */
  type(ch) {
    this.input.focus({ preventScroll: true });
    this.input.value += ch;
    this._suggest();
    this.app.editor?.drawOverlay();
  }

  value() {
    return this.input.value;
  }

  setValue(v) {
    this.input.value = v;
  }

  /** Whether text in the history is selected (for the browser's own Copy). */
  textSelected() {
    const sel = window.getSelection?.();
    return !!sel && !sel.isCollapsed && this.history.contains(sel.anchorNode) && String(sel) !== '';
  }

  /** Show the active prompt, or the idle state when text is null. */
  prompt(text, options = [], def) {
    clear(this.promptEl);
    clear(this.optionsEl);
    const busy = text != null;
    this.el.classList.toggle('busy', busy);
    this.el.classList.toggle('idle', !busy);
    if (!busy) {
      this.input.placeholder = 'Type a command';
      return;
    }
    this.input.placeholder = '';
    this.promptEl.textContent = text;
    for (const o of options || []) {
      const isDef = def && (o.value === def || o.key === def);
      this.optionsEl.append(
        h(
          `button.cmd-opt${isDef ? '.default' : ''}`,
          {
            type: 'button',
            onClick: () => {
              this.input.value = o.key;
              this.submit();
            },
            'aria-label': `${o.label}${isDef ? ' (default)' : ''}`,
          },
          o.label,
        ),
      );
    }
  }

  log(text, kind = 'info') {
    const line = h(`div.cmd-log.${kind}`, text);
    this.history.append(line);
    while (this.history.childElementCount > MAX_HISTORY) this.history.firstChild.remove();
    this.history.scrollTop = this.history.scrollHeight;
    // Recent lines stay briefly visible above the collapsed command line.
    line.classList.add('fresh');
    setTimeout(() => line.classList.remove('fresh'), 6000);
  }

  toggleHistory(force) {
    this.expanded = force ?? !this.expanded;
    this.el.classList.toggle('expanded', this.expanded);
    this.expandBtn.setAttribute('aria-expanded', String(this.expanded));
    this.history.scrollTop = this.history.scrollHeight;
  }

  recentMenu(anchor) {
    const seen = [];
    for (let i = this.typed.length - 1; i >= 0 && seen.length < 10; i--) {
      const c = this.app.editor.find(this.typed[i]);
      if (c && !seen.includes(c)) seen.push(c);
    }
    const last = this.app.editor.lastCommand ? this.app.editor.find(this.app.editor.lastCommand) : null;
    if (last && !seen.includes(last)) seen.unshift(last);
    const items = seen.length ? seen.map((c) => ({ label: c.label, icon: c.icon, action: () => this.app.run(c.name) })) : [{ label: 'No recent commands', disabled: true }];
    showMenu(anchor, items, { label: 'Recent commands' });
  }

  _suggest() {
    const t = this.input.value.trim().toUpperCase();
    if (!t || this.app.editor.request || /[\d@#<,.-]/.test(t[0])) return this._hideSuggest();
    // A typed name or alias (C for CIRCLE) comes first, before longer names that start with it.
    const hit = this.app.commands.get(t);
    const seen = new Set(hit ? [hit] : []);
    const out = hit ? [{ c: hit, exact: true, alias: t !== hit.name ? t : null }] : [];
    for (const [key, c] of this.app.commands) {
      if (seen.has(c)) continue;
      if (key.startsWith(t) || c.label.toUpperCase().startsWith(t)) {
        seen.add(c);
        out.push({ c, exact: key === t, alias: key !== c.name ? key : null });
      }
    }
    out.sort((a, b) => b.exact - a.exact || a.c.name.length - b.c.name.length);
    this.suggestions = out.slice(0, 8);
    this.suggestIndex = this.suggestions.length ? 0 : -1;
    this._renderSuggest();
  }

  _renderSuggest() {
    clear(this.suggestEl);
    if (!this.suggestions.length) return this._hideSuggest();
    this.suggestEl.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
    this.suggestions.forEach((s, i) => {
      const li = h(
        'li.cmd-sug',
        {
          role: 'option',
          id: `cmd-sug-${i}`,
          'aria-selected': String(i === this.suggestIndex),
          onPointerdown: (e) => {
            e.preventDefault();
            this._pick(i);
          },
        },
        icon(s.c.icon, 16),
        h('span.cmd-sug-name', s.c.name),
        h('span.cmd-sug-label', s.c.label),
        s.alias ? h('span.cmd-sug-alias', s.alias) : null,
      );
      this.suggestEl.append(li);
    });
    this.input.setAttribute('aria-activedescendant', this.suggestIndex >= 0 ? `cmd-sug-${this.suggestIndex}` : '');
  }

  _hideSuggest() {
    this.suggestEl.hidden = true;
    this.suggestions = [];
    this.suggestIndex = -1;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
  }

  _pick(i) {
    const s = this.suggestions[i];
    if (!s) return;
    this.input.value = '';
    this._hideSuggest();
    this._remember(s.c.name);
    this.typedIndex = -1;
    this.app.run(s.c.name);
  }

  /** Add an entry to the typed history (ArrowUp), keeping the last 100. */
  _remember(text) {
    this.typed.push(text);
    if (this.typed.length > 100) this.typed.shift();
  }
}
