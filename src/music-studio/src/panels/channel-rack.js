// Placeholder: replaced by the full Channel rack implementation.
import { h } from '../lib/dom.js';

export function install(app) {
  app.registerPanel({
    id: 'rack',
    title: 'Channel rack',
    icon: 'win-rack',
    region: 'dock',
    create(app, host) {
      host.body.append(h('div.empty-state', h('h3', 'Channel rack')));
      return {};
    },
  });
}
