// Custom Properties panels of the Properties editor tabs other than Object (object data,
// material, world, scene, bone).
import { onAppReady } from '../app/app';
import type { Child } from './h';
import { panel } from './widgets';
import { propertiesTabs } from '../editors/properties/properties';
import { contextObject } from '../ops/wm_context';
import { customPropsPanelBody } from './customprops';

/** Tab id → context path of the data-block whose custom properties the tab shows. */
const TABS: Record<string, string> = { DATA: 'object.data', MATERIAL: 'material', WORLD: 'world', SCENE: 'scene', BONE: 'active_bone' };

onAppReady(() => {
  for (const [tab, path] of Object.entries(TABS)) {
    const t = propertiesTabs.find((x) => x.id === tab);
    if (!t) continue;
    const draw = t.draw;
    t.draw = (p): Child => {
      const body = draw(p);
      const block = contextObject(path);
      if (!block || typeof block !== 'object') return body;
      return [body, panel(`${tab.toLowerCase()}-custom`, 'Custom Properties', () => customPropsPanelBody(block as Record<string, unknown>, path), { closed: true })];
    };
  }
});
