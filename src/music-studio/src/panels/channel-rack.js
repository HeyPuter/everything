// Channel rack feature: registers the step sequencer panel, the instrument
// editor windows (app.openChannelEditor) and the rack's scoped commands.
// The panel itself lives in rack/rack-view.js; editors in rack/editor.js.

import '../styles/rack.css';
import { RackView } from '../rack/rack-view.js';
import { openChannelEditor } from '../rack/editor.js';
import { channelActions } from '../rack/actions.js';
import { closeWindows } from '../ui/windows.js';

export function install(app) {
  const store = app.store;
  const actions = channelActions(app);

  app.registerPanel({
    id: 'rack',
    title: 'Channel rack',
    short: 'Rack',
    icon: 'win-rack',
    region: 'dock',
    create(appRef, host) {
      return new RackView(appRef, host).api();
    },
  });

  app.openChannelEditor = (id) => openChannelEditor(app, id);

  // Editors of deleted channels close (undoing a clone, deleting from anywhere).
  store.on('change', (p, prev) => {
    if (p.channels === prev.channels || p.channels.length >= prev.channels.length) return;
    const ids = new Set(p.channels.map((c) => c.id));
    for (const c of prev.channels) if (!ids.has(c.id)) closeWindows(`channel:${c.id}`);
  });

  const view = () => app.panel('rack')?.view || null;
  const targets = () => {
    const sel = store.view.selectedChannels;
    const ids = store.project.channels.filter((c) => sel.has(c.id)).map((c) => c.id);
    return ids.length ? ids : store.view.channel ? [store.view.channel] : [];
  };
  const hasChannel = () => store.project.channels.length > 0;

  app.commands.register(
    { id: 'rack.rename', label: 'Rename channel...', keys: ['F2'], scope: 'rack', enabled: hasChannel, run: () => actions.rename(store.channel.id) },
    { id: 'rack.moveUp', label: 'Move channel up', keys: ['Alt+ArrowUp'], scope: 'rack', enabled: hasChannel, run: () => actions.move(targets(), -1) },
    { id: 'rack.moveDown', label: 'Move channel down', keys: ['Alt+ArrowDown'], scope: 'rack', enabled: hasChannel, run: () => actions.move(targets(), 1) },
    { id: 'rack.mute', label: 'Mute selected channels', keys: ['M'], scope: 'rack', enabled: hasChannel, run: () => actions.toggleMute(targets()) },
    { id: 'rack.solo', label: 'Solo channel', keys: ['S'], scope: 'rack', enabled: hasChannel, run: () => actions.solo(store.channel.id) },
    { id: 'rack.openEditor', label: 'Channel editor', scope: 'rack', enabled: hasChannel, run: () => app.openChannelEditor(store.channel.id) },
    { id: 'rack.velocityLane', label: 'Velocity lane', scope: 'rack', checked: () => Boolean(view()?.velLane), enabled: () => Boolean(view()), run: () => view()?.toggleVelLane() },
    { id: 'rack.addBar', label: 'Add a bar of steps', scope: 'rack', run: () => view()?.resize(1) },
    { id: 'rack.removeBar', label: 'Remove a bar of steps', scope: 'rack', run: () => view()?.resize(-1) },
  );
}
