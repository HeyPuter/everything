// Placeholder: replaced by the full Mixer implementation.
import { h } from '../lib/dom.js';

export function install(app) {
  app.registerPanel({
    id: 'mixer',
    title: 'Mixer',
    icon: 'win-mixer',
    region: 'dock',
    create(app, host) {
      host.body.append(h('div.empty-state', h('h3', 'Mixer')));
      return {};
    },
  });
}
