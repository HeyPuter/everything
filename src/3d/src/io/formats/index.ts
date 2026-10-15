// io/formats subsystem entry point: import feature files here for their registration side effects.
// Order defines the order in File ▸ Import / Export.
import './collada-format';
import './alembic/index';
import './usd/index';
import './mesh-formats'; // Wavefront OBJ, Stanford PLY, STL
import './fbx/index';
import './gltf/index';
import '../blend/index';
