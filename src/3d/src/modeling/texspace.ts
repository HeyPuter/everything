// Curve, text and surface texture space: the Texture Space panel of their Object Data tab and
// curve.match_texture_space (fit the texture space to the evaluated geometry and stop following it).
import { h } from '../ui/h';
import { app, registerOperators } from '../app/app';
import { opButton } from '../ui/widgets';
import { curveDataPanels } from '../editors/properties/tabs';
import { texSpacePanel } from '../editors/properties/more/mesh';
import { boundsTexSpace } from '../render/texspace';

const CURVE_TYPES = ['CURVE', 'FONT', 'SURFACE'];
const evaluatedPositions = (id: string) => app.graph.get(id)?.mesh?.positions ?? new Float32Array(0);

registerOperators([
  {
    idname: 'curve.match_texture_space',
    label: 'Match Texture Space',
    description: 'Fit the texture space to the bounds of the evaluated curve and keep it there',
    poll: () => {
      const ob = app.activeObject;
      return !!ob?.data && CURVE_TYPES.includes(ob.type) && !!app.doc.curves[ob.data];
    },
    exec: () => {
      const ob = app.activeObject!;
      const cu = app.doc.curves[ob.data!];
      const b = boundsTexSpace(evaluatedPositions(ob.id));
      cu.use_auto_texspace = false;
      cu.texspace_location = b.location;
      cu.texspace_size = b.size;
      app.changed('doc');
    },
  },
]);

curveDataPanels.push((o, cu) => {
  if (cu.use_auto_texspace === undefined) cu.use_auto_texspace = true;
  return texSpacePanel('cu-texspace', cu, () => evaluatedPositions(o.id), () => h('div', { class: 'btn-row' }, opButton('curve.match_texture_space', 'Match Texture Space')));
});
