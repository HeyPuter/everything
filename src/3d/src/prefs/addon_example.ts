// A small example add-on offered in Preferences ▸ Add-ons ("Install Example").
export const EXAMPLE_ADDON = {
  filename: 'scatter_cubes.js',
  source: `// Example add-on: adds "Scatter Cubes" to F3 search and a sidebar panel in the 3D Viewport.
const bl_info = {
  name: 'Scatter Cubes',
  author: 'Example',
  version: [1, 0],
  category: 'Object',
  description: 'Adds a grid of small cubes around the 3D cursor',
};

class ScatterCubes extends bpy.types.Operator {
  static bl_idname = 'object.example_scatter_cubes';
  static bl_label = 'Scatter Cubes';
  static bl_options = ['REGISTER', 'UNDO'];
  static properties = {
    count: bpy.props.IntProperty({ name: 'Count', default: 3, min: 1, max: 8 }),
    spacing: bpy.props.FloatProperty({ name: 'Spacing', default: 1.5, min: 0.1 }),
  };
  execute(context) {
    const c = context.scene.cursor.location;
    const half = (this.count - 1) / 2;
    for (let i = 0; i < this.count; i++)
      for (let j = 0; j < this.count; j++)
        bpy.ops.mesh.primitive_cube_add({ size: this.spacing * 0.4, location: [c.x + (i - half) * this.spacing, c.y + (j - half) * this.spacing, c.z] });
    return 'FINISHED';
  }
}

class ScatterPanel extends bpy.types.Panel {
  static bl_label = 'Scatter';
  static bl_category = 'Example';
  draw(context) {
    this.layout.label({ text: 'Grid of cubes at the 3D cursor' });
    this.layout.operator('object.example_scatter_cubes');
  }
}

function register() {
  bpy.utils.register_class(ScatterCubes);
  bpy.utils.register_class(ScatterPanel);
}

function unregister() {
  bpy.utils.unregister_class(ScatterPanel);
  bpy.utils.unregister_class(ScatterCubes);
}
`,
};
