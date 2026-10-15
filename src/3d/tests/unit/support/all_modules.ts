// Registers every operator, keymap and data type the app has, as the browser entry point does,
// so scripting tests see the full bpy.ops surface. Import it dynamically after setApp().
import '../../../src/app/keys';
import '../../../src/app/keys_extra';
import '../../../src/editors/outliner';
import '../../../src/ui/buttons';
import '../../../src/editors/properties/properties';
import '../../../src/editors/properties/tabs';
import '../../../src/editors/properties/stack';
import '../../../src/eval/modifiers_extra';
import '../../../src/anim/motionpaths';
import '../../../src/editors/view3d/tools3d';
import '../../../src/ops/imageobjects';
import '../../../src/ops/viewnav';
import '../../../src/ops/bakeaction';
import '../../../src/editors/filebrowser';
import '../../../src/editors/timeline';
import '../../../src/editors/uv/uveditor';
import '../../../src/ops/object';
import '../../../src/ops/view3d';
import '../../../src/ops/screen';
import '../../../src/ops/transform';
import '../../../src/ops/wm';
import '../../../src/ops/data';
import '../../../src/io/files';
import '../../../src/modules';
