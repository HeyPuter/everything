// Playlist panel: the song arrangement. Registers the panel, its tool, zoom
// and automation point / curve commands (scope 'playlist'), and the Add
// menu's marker and automation clip commands. The view itself lives in playlist/view.js.

import { createPlaylistView, TOOLS } from '../playlist/view.js';
import { addAutomationClip } from '../automation/create.js';
import { announce } from '../lib/dom.js';

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
    // Automation points and curves from the keyboard (playlist/curves.js).
    { id: 'playlist.pointPrev', label: 'Previous automation point', keys: [','], scope: 'playlist', run: () => view()?.stepPoint?.(-1) },
    { id: 'playlist.pointNext', label: 'Next automation point', keys: ['.'], scope: 'playlist', run: () => view()?.stepPoint?.(1) },
    { id: 'playlist.curveDown', label: 'Bend automation curve down', keys: ['['], scope: 'playlist', run: () => view()?.bendCurve?.(-1) },
    { id: 'playlist.curveUp', label: 'Bend automation curve up', keys: [']'], scope: 'playlist', run: () => view()?.bendCurve?.(1) },
    { id: 'playlist.curveReset', label: 'Make automation curve linear', keys: ['\\'], scope: 'playlist', run: () => view()?.resetCurve?.() },
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
