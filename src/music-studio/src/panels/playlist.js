// Playlist panel: the song arrangement. Registers the panel, its tool and
// zoom commands (scope 'playlist'), and the Add menu's marker and automation
// clip commands. The view itself lives in playlist/view.js.

import { createPlaylistView, TOOLS } from '../playlist/view.js';
import { addAutomationClip } from '../automation/create.js';
import { announce } from '../lib/dom.js';
import { adjacentMarker } from '../playlist/clips.js';
import { ticksPerBeat } from '../model/time.js';

export function install(app) {
  app.registerPanel({
    id: 'playlist',
    title: 'Playlist',
    icon: 'win-playlist',
    region: 'main',
    create(app, host) {
      return createPlaylistView(app, host);
    },
  });

  const view = () => app.panel('playlist')?.view || null;
  const setTool = (id) => {
    app.tools.playlist = id;
    app.emit('tool', 'playlist', id);
    const v = view();
    if (v) v.setTool(id);
  };

  // Previous / next marker from the song position. While playing, "previous"
  // skips a marker just passed (within a beat) so repeated presses walk back.
  const jumpMarker = (dir) => {
    const p = app.store.project;
    const e = app.engine;
    const pos = e.mode === 'song' ? e.position : 0;
    const slack = e.playing ? ticksPerBeat(p.sig) : 0;
    const m = adjacentMarker(p.markers, pos, dir, slack);
    if (!m) {
      announce(dir > 0 ? 'No marker after the song position' : 'No marker before the song position');
      return;
    }
    const v = view();
    if (v) v.jumpToMarker(m);
    else {
      app.setMode('song');
      e.seek(m.pos);
      announce(`Marker ${m.name}`);
    }
  };

  app.commands.register(
    ...TOOLS.map((t) => ({
      id: `playlist.tool.${t.id}`,
      label: `${t.label} tool`,
      keys: [t.key],
      scope: 'playlist',
      checked: () => (app.tools.playlist || 'draw') === t.id,
      run: () => setTool(t.id),
    })),
    { id: 'playlist.zoomIn', label: 'Zoom in', keys: ['=', '+'], scope: 'playlist', run: () => view()?.zoomAt(1.5) },
    { id: 'playlist.zoomOut', label: 'Zoom out', keys: ['-'], scope: 'playlist', run: () => view()?.zoomAt(1 / 1.5) },
    { id: 'playlist.zoomFit', label: 'Zoom to fit song', keys: ['Shift+F'], scope: 'playlist', run: () => view()?.zoomFit() },
    {
      id: 'add.marker',
      label: 'Add marker...',
      keys: ['Alt+T'],
      run: () => {
        const v = view();
        const pos = app.engine.mode === 'song' ? app.engine.position : v ? v.cursor.tick : 0;
        if (v) v.addMarker(Math.round(pos));
        else app.shell.show('playlist');
      },
    },
    { id: 'transport.prevMarker', label: 'Previous marker', keys: [','], enabled: () => app.store.project.markers.length > 0, run: () => jumpMarker(-1) },
    { id: 'transport.nextMarker', label: 'Next marker', keys: ['.'], enabled: () => app.store.project.markers.length > 0, run: () => jumpMarker(1) },
    {
      id: 'add.automation',
      label: 'Add automation clip',
      run: async () => {
        const r = await addAutomationClip(app);
        if (!r) return;
        app.shell.show('playlist', { focus: false });
        const v = view();
        if (v) {
          v.selectClips([r.clipId], { announce: false, reveal: true });
          const clip = app.store.project.clips.find((c) => c.id === r.clipId);
          v.setSource({ kind: 'auto', id: r.id });
          if (clip) v.announceClip(clip, 'Added ');
        } else announce('Automation clip added');
      },
    },
  );
}
