// Placeholder: replaced by the full Browser implementation.
import { h } from '../lib/dom.js';

export function install(app) {
  app.registerPanel({
    id: 'browser',
    title: 'Browser',
    icon: 'win-browser',
    region: 'side',
    create(app, host) {
      host.body.append(h('div.empty-state', h('h3', 'Browser')));
      return {};
    },
  });
}
