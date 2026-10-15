// Geometry nodes entry: node types, the NODES modifier, the Geometry Node Editor, the modifier
// panel and viewport display. Imported from src/modules.ts.
import './core';
import './icons';
import './geonodes.css';
import './editor';
import './panel';
import './display';
import './curves/gizmoui';
import { installItemResolver } from './editor';
import { app, onAppReady } from '../app/app';
import { pruneModifierCaches } from './modifier';

// app is created after modules register; hook document-level listeners once it exists
onAppReady(() => {
  installItemResolver();
  app.subscribe((kinds) => {
    if (kinds.has('doc')) pruneModifierCaches(app.doc);
  });
});
export {};
