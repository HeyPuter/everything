// Placeholder: replaced by the full Playlist implementation.
import { h } from '../lib/dom.js';

export function install(app) {
  app.registerPanel({
    id: 'playlist',
    title: 'Playlist',
    icon: 'win-playlist',
    region: 'main',
    create(app, host) {
      host.body.append(h('div.empty-state', h('h3', 'Playlist')));
      return {};
    },
  });
}
