/**
 * Block library palette: thumbnails of the drawing's block definitions.
 * Click to insert; rename or delete unused blocks from the item menu.
 */
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { drawPreview } from './preview.js';
import { openDialog, promptDialog, confirmDialog } from './dialog.js';
import { showMenu } from './menu.js';
import { tableKey } from '../core/schema.js';
import { keepScroll } from './focus.js';

export class BlockLibrary {
  constructor(app) {
    this.app = app;
    this.query = '';
    this.search = h('input.input.sm', { type: 'search', placeholder: 'Search blocks', 'aria-label': 'Search blocks', spellcheck: 'false' });
    this.search.addEventListener('input', () => {
      this.query = this.search.value.trim().toLowerCase();
      this.render();
    });
    this.search.addEventListener('keydown', (e) => e.stopPropagation());
    this.grid = h('ul.bl-grid', { role: 'list' });
    this.empty = h('p.bl-empty', 'This drawing has no blocks yet. Select objects and use Create block (B) to make one.');
    this.el = h(
      'div.bl',
      h('div.bl-toolbar', this.search, h('button.btn.sm', { type: 'button', onClick: () => app.run('BLOCK'), 'data-tip': 'Create block' }, icon('block-create', 16), h('span', 'Create'))),
      this.grid,
      this.empty,
    );
  }

  names() {
    return [...this.app.doc.drawing.blocks.keys()].filter((n) => !n.startsWith('*')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  refresh() {
    if (this.el.isConnected) this.render();
  }

  render() {
    if (!this.app.doc) return;
    const d = this.app.doc.drawing;
    const names = this.names().filter((n) => !this.query || n.toLowerCase().includes(this.query));
    // The dock scrolls the palette; emptying the list would send it back to the top.
    const restoreScroll = keepScroll(this.el.parentElement);
    // Rebuilding the list takes the focused button with it (after Delete or
    // Rename from an item's menu, or any change to the drawing's tables).
    const active = this.grid.contains(document.activeElement) ? document.activeElement : null;
    const index = active ? [...this.grid.children].indexOf(active.closest('li')) : -1;
    clear(this.grid);
    this.empty.hidden = this.names().length > 0;
    const fg = getComputedStyle(document.documentElement).getPropertyValue('--fg').trim();
    // A drawing can have hundreds of blocks, and the list is rebuilt after every
    // change to a table: only the thumbnails scrolled into view are drawn.
    this._thumbs?.disconnect();
    const draws = new WeakMap();
    const inView =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver((entries, io) => {
            for (const en of entries) {
              if (!en.isIntersecting) continue;
              io.unobserve(en.target);
              draws.get(en.target)?.();
            }
          });
    this._thumbs = inView;
    for (const name of names) {
      const b = d.blocks.get(name);
      const canvas = h('canvas.bl-thumb', { width: 120, height: 84, 'aria-hidden': 'true' });
      const item = h(
        'li.bl-item',
        h(
          'button.bl-btn',
          { type: 'button', 'aria-label': `Insert ${name}`, 'data-key': `insert:${name}`, onClick: () => this.app.run('INSERT', { name }) },
          canvas,
          h('span.bl-name', name),
        ),
        h(
          'button.icon-btn.sm.bl-more',
          {
            type: 'button',
            'aria-label': `More actions for ${name}`,
            'aria-haspopup': 'menu',
            'data-key': `more:${name}`,
            onClick: (e) =>
              showMenu(e.currentTarget, [
                { label: 'Insert', icon: 'block-insert', action: () => this.app.run('INSERT', { name }) },
                { label: 'Rename...', action: () => this.rename(name) },
                { label: 'Delete', icon: 'trash', action: () => this.remove(name) },
              ]),
          },
          icon('more', 16),
        ),
      );
      this.grid.append(item);
      const draw = () => drawPreview(canvas, d, b.entities, { fg });
      if (inView) {
        draws.set(canvas, draw);
        inView.observe(canvas);
      } else requestAnimationFrame(draw);
    }
    restoreScroll();
    if (active) {
      const same = [...this.grid.querySelectorAll('[data-key]')].find((el) => el.dataset.key === active.dataset.key);
      // Its block is gone: the block now in its place, or the search box.
      const li = this.grid.children[Math.min(index, this.grid.children.length - 1)];
      (same ?? li?.querySelector('.bl-btn') ?? this.search).focus({ preventScroll: true });
    }
  }

  usage(name) {
    const d = this.app.doc.drawing;
    let n = 0;
    for (const e of d.entities.values()) if (e.type === 'insert' && e.name === name) n++;
    for (const b of d.blocks.values()) for (const e of b.entities) if (e.type === 'insert' && e.name === name) n++;
    return n;
  }

  async rename(name) {
    const d = this.app.doc.drawing;
    const v = await promptDialog('Rename block', 'New name', name, {
      validate: (s) => (!s ? 'Enter a name.' : /[<>/\\":;?*|=`]/.test(s) ? 'That name has characters that are not allowed.' : (tableKey(d.blocks, s) ?? name) !== name ? 'A block with that name exists.' : null),
    });
    if (!v || v === name) return;
    d.transaction('Rename block', () => {
      const b = d.blocks.get(name);
      d.setBlock(v, { ...b, name: v });
      d.setBlock(name, null);
      for (const [id, e] of d.entities) if (e.type === 'insert' && e.name === name) d.update(id, { name: v });
      for (const bl of d.blocks.values()) if (bl.entities.some((e) => e.type === 'insert' && e.name === name)) d.setBlock(bl.name, { ...bl, entities: bl.entities.map((e) => (e.type === 'insert' && e.name === name ? { ...e, name: v } : e)) });
    });
  }

  async remove(name) {
    const d = this.app.doc.drawing;
    const used = this.usage(name);
    if (used) {
      await openDialog({ title: 'Block in use', body: h('p.dialog-text', `"${name}" is used ${used} time${used === 1 ? '' : 's'}. Erase or explode those references first.`), size: 'sm', actions: [{ label: 'OK', primary: true }] });
      return;
    }
    if (!(await confirmDialog('Delete block?', `Delete the definition of "${name}"?`, { confirm: 'Delete', danger: true }))) return;
    d.transaction('Delete block', () => d.setBlock(name, null));
  }

  /** Let the user pick a block; resolves with its name or null. */
  async choose() {
    const d = this.app.doc.drawing;
    const names = this.names();
    if (!names.length) return null;
    let chosen = null;
    const fg = getComputedStyle(document.documentElement).getPropertyValue('--fg').trim();
    const list = h('ul.bl-grid.choose', { role: 'listbox', 'aria-label': 'Blocks' });
    let close;
    for (const name of names) {
      const canvas = h('canvas.bl-thumb', { width: 120, height: 84, 'aria-hidden': 'true' });
      list.append(
        h(
          'li.bl-item',
          { role: 'none' },
          h(
            'button.bl-btn',
            {
              type: 'button',
              role: 'option',
              onClick: () => {
                chosen = name;
                close?.();
              },
            },
            canvas,
            h('span.bl-name', name),
          ),
        ),
      );
      requestAnimationFrame(() => drawPreview(canvas, d, d.blocks.get(name).entities, { fg }));
    }
    const p = openDialog({ title: 'Insert block', body: list, size: 'lg', actions: [{ label: 'Cancel' }] });
    close = () => document.querySelector('dialog[open]')?._close(null);
    await p;
    return chosen;
  }
}
