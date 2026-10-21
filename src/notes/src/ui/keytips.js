import { h, announce } from '../lib/dom.js';

/*
 * Key hints: press and release Alt to show a letter on every ribbon tab,
 * type a letter to open that tab, then type the letters shown on a
 * command to run it. Escape steps back; any click or focus change ends it.
 */

const TAB_KEYS = { file: 'F', home: 'H', insert: 'N', draw: 'D', view: 'W', help: 'Y', table: 'J' };

/** Assigns short unique keys to labels, preferring their initials. */
export function assignKeys(labels, reserved = []) {
  const used = new Set(reserved);
  const out = [];
  for (const label of labels) {
    const words = String(label).toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    const candidates = [];
    if (words[0]) candidates.push(words[0][0]);
    if (words[1]) candidates.push(words[0][0] + words[1][0]);
    for (const ch of words.join('')) candidates.push(ch);
    for (const ch of words.join('')) for (const d of '123456789') candidates.push(ch + d);
    const key = candidates.find((k) => !used.has(k) && ![...used].some((u) => u.startsWith(k) || k.startsWith(u))) || candidates.find((k) => !used.has(k)) || `Z${out.length}`;
    used.add(key);
    out.push(key);
  }
  return out;
}

export class KeyTips {
  constructor(app) {
    this.app = app;
    this.active = false;
    this.layer = null;
    this.targets = [];
    this.typed = '';
    this.altAlone = false;
    app.listen(document, 'keydown', (e) => this.onKeyDown(e), true);
    app.listen(document, 'keyup', (e) => this.onKeyUp(e), true);
    app.listen(document, 'pointerdown', () => this.stop(), true);
    app.listen(window, 'blur', () => {
      this.altAlone = false;
      this.stop();
    });
  }

  onKeyDown(e) {
    if (e.key === 'Alt') {
      this.altAlone = !e.repeat && !e.ctrlKey && !e.metaKey && !e.shiftKey;
      return;
    }
    this.altAlone = false;
    if (!this.active) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      if (this.level === 'commands') this.showTabs();
      else this.stop(true);
      return;
    }
    if (e.key === 'Backspace') {
      this.typed = this.typed.slice(0, -1);
      this.filter();
      return;
    }
    const ch = e.key.length === 1 ? e.key.toUpperCase() : '';
    if (!/^[A-Z0-9]$/.test(ch)) return;
    this.typed += ch;
    const exact = this.targets.find((t) => t.key === this.typed);
    if (exact) {
      this.typed = '';
      exact.run();
      return;
    }
    if (!this.targets.some((t) => t.key.startsWith(this.typed))) this.typed = '';
    this.filter();
  }

  onKeyUp(e) {
    if (e.key !== 'Alt') return;
    const alone = this.altAlone;
    this.altAlone = false;
    if (!alone) return;
    if (document.querySelector('dialog[open], .reader, .menu')) return;
    e.preventDefault();
    if (this.active) this.stop(true);
    else this.start();
  }

  start() {
    if (this.app.isPhone()) return;
    this.active = true;
    this.returnFocus = document.activeElement;
    this.layer = h('div.keytips', { 'aria-hidden': 'true' });
    document.body.append(this.layer);
    this.showTabs();
    announce('KeyTips on. Type a letter to choose a tab. Escape to exit.');
  }

  stop(restore = false) {
    if (!this.active) return;
    this.active = false;
    this.layer?.remove();
    this.layer = null;
    this.targets = [];
    this.typed = '';
    // Cancelled: a collapsed ribbon's panel opened by a tab's key closes too.
    if (restore) this.app.ribbon.closePeek();
    if (restore && this.returnFocus?.isConnected) {
      if (!this.app.editor.restoreRange()) this.returnFocus.focus();
    }
  }

  showTabs() {
    this.level = 'tabs';
    this.typed = '';
    const ribbon = this.app.ribbon;
    const targets = [{ el: this.app.fileBtn, key: TAB_KEYS.file, run: () => {
      this.stop();
      this.app.fileBtn.click();
    } }];
    for (const btn of ribbon.tabList.querySelectorAll('[role="tab"]')) {
      const id = btn.id.replace('tab-', '');
      targets.push({ el: btn, key: TAB_KEYS[id] || id[0].toUpperCase(), run: () => {
        if (this.app.ribbon.el.dataset.collapsed === 'true') this.app.ribbon.el.classList.add('peek');
        ribbon.select(id);
        this.showCommands();
      } });
    }
    const quick = [['undo', 'Z'], ['redo', 'R'], ['share', 'S']];
    for (const [id, key] of quick) {
      const el = id === 'share' ? this.app.shareBtn : id === 'undo' ? this.app.undoBtn : this.app.redoBtn;
      targets.push({ el, key: `${key}`, run: () => {
        this.stop(true);
        this.app.runCommand(id);
      } });
    }
    targets.push({ el: ribbon.tellMe, key: 'Q', run: () => {
      this.stop();
      this.app.focusTellMe();
    } });
    this.targets = targets;
    this.paint();
  }

  showCommands() {
    this.level = 'commands';
    this.typed = '';
    const els = [...this.app.ribbon.panel.querySelectorAll('button.rb-btn, button.rb-gallery-item, button.rb-gallery-more, .rb-combo input')].filter((el) => el.offsetParent !== null && !el.disabled);
    const keys = assignKeys(els.map((el) => el.getAttribute('aria-label') || el.textContent));
    this.targets = els.map((el, i) => ({
      el,
      key: keys[i],
      run: () => {
        this.stop();
        if (el.tagName === 'INPUT') el.focus();
        else {
          // Commands act on the note's caret, so give it back first.
          if (!el.hasAttribute('aria-haspopup')) this.app.editor.restoreRange();
          el.click();
        }
      },
    }));
    this.paint();
  }

  paint() {
    if (!this.layer) return;
    this.layer.replaceChildren(...this.targets.map((t) => {
      const tip = h('span.keytip', t.key);
      // Small labelled buttons sit in tight stacks, and a big split button's
      // label is under its top half, so a tip under either would cover text;
      // put it over the icon instead.
      const label = t.el.matches('.rb-btn:not(.big)') && t.el.querySelector('.rb-label');
      const splitTop = t.el.matches('.rb-split.big > .rb-btn:first-child') && t.el.nextElementSibling?.querySelector('span')?.offsetParent !== null;
      const iconEl = ((label && label.offsetParent !== null) || splitTop) && t.el.querySelector('.icon');
      if (iconEl) {
        const r = iconEl.getBoundingClientRect();
        tip.style.left = `${Math.round(r.left + r.width / 2)}px`;
        tip.style.top = `${Math.round(r.top + r.height / 2 - 8)}px`;
      } else {
        // Big buttons' labels run to their bottom edge, so tips hang below.
        const r = t.el.getBoundingClientRect();
        tip.style.left = `${Math.round(r.left + r.width / 2)}px`;
        tip.style.top = `${Math.round(r.bottom - (t.el.classList.contains('big') ? 3 : 6))}px`;
      }
      t.tip = tip;
      return tip;
    }));
  }

  filter() {
    for (const t of this.targets) t.tip?.classList.toggle('dim', Boolean(this.typed) && !t.key.startsWith(this.typed));
  }
}
