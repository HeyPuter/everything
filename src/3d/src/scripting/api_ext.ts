// Feature files that extend the scripting object model (api.ts). Imported wherever scripts run
// (runner.ts), after api.ts has defined the wrappers they add members to.
import './api_anim';
import './api_data';
import './handlers';
import './api_context';
import './api_shapes';
import './api_image';
import './api_nodes';
import './script_ops';
import '../scenes/scripting';
import '../bake/script';
import './api_idprops';
import '../tracking/scripting';
