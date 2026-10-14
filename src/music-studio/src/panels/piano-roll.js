// Placeholder: replaced by the full Piano roll implementation.
import { h } from '../lib/dom.js';

export function install(app) {
  app.registerPanel({
    id: 'pianoRoll',
    title: 'Piano roll',
    icon: 'win-piano',
    region: 'dock',
    create(app, host) {
      host.body.append(h('div.empty-state', h('h3', 'Piano roll')));
      return {};
    },
  });
}
