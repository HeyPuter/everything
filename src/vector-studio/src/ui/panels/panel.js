/**
 * Panel base class. Panels build their DOM once in build(), then refresh in
 * update(), which the dock calls (coalesced into one animation frame) when
 * the active editor, its selection, document or style changes, and only
 * while the panel is visible.
 */
import { h } from '../../lib/dom.js';

export class Panel {
  static id = 'panel';
  static title = 'Panel';
  static icon = 'square-dashed';
  /** 'dock' panels appear as tabs in the right dock; 'strip' panels in the icon strip. */
  static placement = 'strip';
  static shortcut = '';

  constructor(app) {
    this.app = app;
    this.el = h(`div.panel-body.panel-${this.constructor.id}`);
    this.built = false;
    this.visible = false;
  }

  get editor() {
    return this.app.editor;
  }

  get id() {
    return this.constructor.id;
  }

  ensureBuilt() {
    if (!this.built) {
      this.build();
      this.built = true;
    }
  }

  build() {}

  update() {}

  /**
   * The panel's options menu: a menu spec (command ids, '-', submenus and
   * `{ label, run, checked, enabled }` items, see resolveItems) shown from
   * the menu button in the panel header. Empty means no button.
   */
  menu() {
    return [];
  }

  /** Called when the panel becomes visible. */
  shown() {
    this.visible = true;
    this.ensureBuilt();
    this.update();
  }

  hidden() {
    this.visible = false;
  }
}

/** Empty-state message used by panels when there is no document. */
export function emptyState(text) {
  return h('p.panel-empty', text);
}
