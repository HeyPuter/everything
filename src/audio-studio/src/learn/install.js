// The Learn feature: the panel of guided tutorials and its menu commands.

import { learnPanel, learnRunner } from './panel.js';
import '../styles/learn.css';

export function installLearn(app) {
  app.registerPanel({
    id: 'learn',
    title: 'Learn',
    create: learnPanel,
    near: ['assistant', 'properties', 'effects'],
    menu: () => [{ type: 'cmd', label: 'Stop Tutorial', enabled: Boolean(app.learn?.current), run: () => app.learn?.stop() }],
  });
  const open = () => {
    learnRunner(app);
    app.dock?.openPanel('learn');
  };
  app.commands.register([
    {
      id: 'window.learn',
      label: 'Learn',
      enabled: (a) => a.panels.has('learn'),
      checked: (a) => Boolean(a.dock?.isOpen('learn')),
      run: () => (app.dock?.isVisible('learn') ? app.dock.closePanel('learn') : open()),
    },
    { id: 'help.learn', label: 'Learn', run: open },
  ]);
}
