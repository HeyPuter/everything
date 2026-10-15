// Preference sections built from simple rows (Interface, Viewport, Editing, Animation, Input,
// Navigation, System, Save & Load, File Paths). Themes, Lights, Add-ons and Keymap have their
// own modules.
import { h, type Child } from '../ui/h';
import { app } from '../app/app';
import { panel, checkbox, colorSwatch, textField } from '../ui/widgets';
import { icon } from '../ui/icons';
import { loadFontFile, clearFontFile, isFileFont } from './fonts';
import { splitRow } from '../ui/props';
import { prefs, formatDate } from '../app/prefs';
import { renderContext } from '../render/context';
import { python, PYODIDE_INDEX_URL, PYODIDE_VERSION } from '../scripting/python';
import { registerPrefSection } from './editor';
import { pBool, pNum, pEnum, pText, pColor, note, infoRow } from './ui';
import { setPref } from './store';
import { ndofDevices } from './ndof';

// ---------------------------------------------------------------------------
// Interface

function fontRow(slot: 'ui' | 'mono', label: string, placeholder: string): Child {
  const key = slot === 'ui' ? 'font_ui' : 'font_ui_mono';
  return splitRow(
    label,
    h(
      'div',
      { class: 'prefs-font-row' },
      textField(`pf-${key}`, prefs[key], (v) => setPref(key, v), { placeholder }),
      h('button', { class: 'btn icon-btn', 'data-tip': 'Load Font File\nUse a .ttf, .otf or .woff font file', 'aria-label': `Load ${label} file`, onclick: () => void loadFontFile(slot) }, icon('file_folder')),
      prefs[key] ? h('button', { class: 'btn icon-btn', 'data-tip': 'Default\nUse the built-in font', 'aria-label': `Reset ${label}`, onclick: () => void (isFileFont(slot) ? clearFontFile(slot) : setPref(key, '')) }, icon('x')) : null,
    ),
  );
}

const E = (value: string, label: string, description?: string) => ({ value, label, description });

registerPrefSection({
  id: 'INTERFACE',
  label: 'Interface',
  group: 0,
  draw: () => [
    panel('pf-display', 'Display', () => [
      pNum('resolution_scale', 'Resolution Scale', { min: 0.25, max: 4, softMin: 0.5, softMax: 2, step: 0.05, precision: 2, slider: true, tip: 'Size of the whole interface' }),
      pNum('font_size', 'Font Size', { min: 8, max: 24, int: true, unit: 'pixel' }),
      pBool('show_splash', 'Splash Screen', 'Show the splash screen with recent files when the application starts fresh'),
      pBool('show_developer_ui', 'Developer Extras', 'Show options meant for script and add-on authors: internal operators in menu search, index overlays'),
      pBool('show_tooltips', 'User Tooltips', 'Show a description when the pointer rests on a control', { heading: 'Tooltips' }),
      pBool('show_tooltips_python', 'Python Tooltips', 'Tooltips also show the scripting data path or operator call', { disabled: !prefs.show_tooltips }),
    ]),
    panel('pf-editors', 'Editors', () => [
      pBool('show_navigate_ui', 'Navigation Controls', 'Show the zoom, pan, camera and projection buttons under the navigation gizmo of the 3D Viewport'),
      pBool('show_corner_split', 'Corner Splitting', 'Drag an area corner to split it or join it with a neighbour', { heading: 'Areas' }),
      pBool('show_edge_resize', 'Edge Resize', 'Drag the gap between areas to resize them'),
      pBool('show_regions_visibility_toggle', 'Region Toggles', 'Show the small arrow that brings back a hidden header'),
      pEnum('color_picker_type', 'Color Picker Type', [
        E('CIRCLE_HSV', 'Circle (HSV)', 'Hue around a disc, saturation outwards, value on the bar'),
        E('CIRCLE_HSL', 'Circle (HSL)', 'Hue around a disc, saturation outwards, lightness on the bar'),
        E('SQUARE_SV', 'Square (SV + H)', 'Saturation and value in a square, hue on the bar'),
        E('SQUARE_HS', 'Square (HS + V)', 'Hue and saturation in a square, value on the bar'),
        E('SQUARE_HV', 'Square (HV + S)', 'Hue and value in a square, saturation on the bar'),
      ]),
      pEnum('header_align', 'Header Position', [E('NONE', 'Keep Existing', 'Each editor keeps its own header side'), E('TOP', 'Top', 'Headers at the top of every editor'), E('BOTTOM', 'Bottom', 'Headers at the bottom of every editor')]),
      pEnum('factor_display_type', 'Factor Display Type', [E('FACTOR', 'Factor', 'Show values between 0 and 1 as factors'), E('PERCENTAGE', 'Percentage', 'Show values between 0 and 1 as percentages')], { expand: true }),
      panel('pf-statusbar', 'Status Bar', () => [
        pBool('show_statusbar_stats', 'Scene Statistics', 'Object, vertex and face counts of the scene'),
        pBool('show_statusbar_scene_duration', 'Scene Duration', 'Length of the frame range as time and frames'),
        pBool('show_statusbar_memory', 'System Memory', 'Memory used by the application (where the browser reports it)'),
        pBool('show_statusbar_version', 'Application Version'),
      ], { sub: true }),
      panel('pf-temp', 'Temporary Editors', () => [
        pEnum('render_display_type', 'Render In', [
          E('NONE', 'Keep User Interface', 'Render without showing the result (F11 shows it)'),
          E('AREA', 'Image Editor', 'Show the result in the largest area, switched to an Image Editor (F11 switches back)'),
          E('WINDOW', 'New Window', 'Show the result in a floating window'),
          E('SCREEN', 'Maximized Window', 'Show the result in a window covering the screen'),
        ]),
      ], { sub: true }),
    ]),
    panel('pf-lang', 'Language', () => [
      pEnum('date_format', 'Date Format', [E('DEFAULT', 'System Default'), E('BE_DASH', 'YYYY-MM-DD'), E('LE_SLASH', 'DD/MM/YYYY'), E('LE_DOT', 'DD.MM.YYYY'), E('ME_SLASH', 'MM/DD/YYYY')]),
      pEnum('time_format', 'Time Format', [E('DEFAULT', 'System Default'), E('H24', '24-Hour'), E('H12', '12-Hour (AM/PM)')], { expand: true }),
      note(`Example: ${formatDate(Date.now())}. Used for recent files, auto saves and the File Browser.`),
    ], { closed: true }),
    panel('pf-text', 'Text Rendering', () => [
      pBool('use_text_antialiasing', 'Anti-Aliasing', 'Smooth the edges of interface text'),
      fontRow('ui', 'Interface Font', 'Inter (built in)'),
      fontRow('mono', 'Monospaced Font', 'JetBrains Mono (built in)'),
      note('Enter the name of a font installed on this computer (e.g. "Helvetica Neue"), or load a font file. Leave empty for the built-in fonts.'),
    ]),
    panel('pf-menus', 'Menus', () => [
      pBool('use_mouse_over_open', 'Open on Mouse Over', 'Menu bar menus open when the pointer rests on them'),
      pNum('open_toplevel_delay', 'Top Level Delay', { min: 0, max: 1000, int: true, unit: 'none', disabled: !prefs.use_mouse_over_open, tip: 'Milliseconds before a menu bar menu opens under the pointer' }),
      pNum('open_sublevel_delay', 'Submenu Delay', { min: 0, max: 1000, int: true, tip: 'Milliseconds before a submenu opens under the pointer' }),
      panel('pf-pie', 'Pie Menus', () => [
        pNum('pie_animation_timeout', 'Animation Timeout', { min: 0, max: 500, int: true, tip: 'Length of the opening animation in milliseconds (0: none)' }),
        pNum('pie_tap_timeout', 'Tap Key Timeout', { min: 0, max: 2000, int: true, tip: 'Releasing the key sooner than this (ms) keeps the pie open; later it picks the highlighted item' }),
        pNum('pie_menu_radius', 'Radius', { min: 40, max: 300, int: true, unit: 'pixel' }),
        pNum('pie_menu_threshold', 'Threshold', { min: 2, max: 200, int: true, unit: 'pixel', tip: 'Distance from the center before a direction is highlighted' }),
        pNum('pie_menu_confirm', 'Confirm Threshold', { min: 0, max: 400, int: true, unit: 'pixel', tip: 'Moving this far picks the highlighted item at once (0: off)' }),
      ], { sub: true }),
    ]),
    panel('pf-access', 'Accessibility', () => [pBool('use_reduce_motion', 'Reduce Motion', 'Turn off animated view changes, menu animations and transitions')]),
  ],
});

// ---------------------------------------------------------------------------
// Viewport

registerPrefSection({
  id: 'VIEWPORT',
  label: 'Viewport',
  group: 0,
  draw: () => [
    panel('pf-vp-display', 'Display', () => [
      pBool('show_object_info', 'Object Info', 'Show the frame, collection and active object in the top-left corner', { heading: 'Text Info Overlay' }),
      pBool('show_view_name', 'View Name', 'Show the name and projection of the view'),
      pBool('show_playback_fps', 'Playback Frame Rate (FPS)', 'Show the frame rate reached while the animation plays'),
      pNum('view_lens', 'Default Focal Length', { min: 1, max: 250, int: true, tip: 'Lens of newly opened 3D Viewports, in millimeters' }),
      pNum('gizmo_size', 'Gizmo Size', { min: 10, max: 200, int: true, unit: 'pixel', tip: 'Size of the move, rotate and scale gizmos' }),
      pEnum('mini_axis_type', 'Navigation', [E('GIZMO', 'Interactive Gizmo', 'The clickable axes gizmo in the upper-right corner'), E('MINIMAL', 'Simple Axes', 'Small axes in the lower-left corner'), E('NONE', 'None')]),
      prefs.mini_axis_type === 'GIZMO' ? pNum('gizmo_size_navigate_v3d', 'Navigation Gizmo Size', { min: 30, max: 200, int: true, unit: 'pixel' }) : null,
      prefs.mini_axis_type === 'MINIMAL' ? [pNum('mini_axis_size', 'Axes Size', { min: 10, max: 64, int: true, unit: 'pixel' }), pNum('mini_axis_brightness', 'Axes Brightness', { min: 0, max: 10, int: true, slider: true })] : null,
    ]),
    panel('pf-vp-quality', 'Quality', () => [
      pEnum('viewport_aa', 'Anti-Aliasing', [E('OFF', 'No Anti-Aliasing', 'Fastest, jagged edges'), E('MSAA', 'Multisample', 'Smooth edges using the GPU’s multisampling')], { expand: true }),
      note('Anti-aliasing applies after the page is reloaded.'),
    ]),
    panel('pf-vp-tex', 'Textures', () => [
      pEnum('anisotropic_filter', 'Anisotropic Filtering', [E('1', 'Off'), E('2', '2×'), E('4', '4×'), E('8', '8×'), E('16', '16×')], { tip: 'Sharper textures on surfaces seen at a grazing angle' }),
    ]),
  ],
});

// ---------------------------------------------------------------------------
// Editing

const DUP_LABELS: [string, string][] = [
  ['ACTION', 'Action'],
  ['ARMATURE', 'Armature'],
  ['CAMERA', 'Camera'],
  ['CURVE', 'Curve'],
  ['GREASEPENCIL', 'Grease Pencil'],
  ['LATTICE', 'Lattice'],
  ['LIGHT', 'Light'],
  ['MATERIAL', 'Material'],
  ['MESH', 'Mesh'],
  ['META', 'Metaball'],
  ['FONT', 'Text'],
];

registerPrefSection({
  id: 'EDITING',
  label: 'Editing',
  group: 0,
  draw: () => [
    panel('pf-ed-objects', 'Objects', () => [
      panel('pf-ed-new', 'New Objects', () => [
        pEnum('object_align', 'Align', [E('WORLD', 'World', 'New objects line up with the world axes'), E('VIEW', 'View', 'New objects face the view'), E('CURSOR', '3D Cursor', 'New objects take the rotation of the 3D cursor')]),
        pBool('use_enter_edit_mode', 'Enter Edit Mode', 'Switch to Edit Mode after adding an object that has one'),
        pEnum('material_link', 'Link Materials To', [E('OBDATA', 'Object Data', 'New material slots belong to the mesh / curve and are shared by its users'), E('OBJECT', 'Object', 'New material slots belong to the object')]),
      ], { sub: true }),
      panel('pf-ed-dup', 'Copy on Duplicate', () => [
        note('Duplicate (Shift D) copies these data-blocks; the others stay shared with the original.'),
        h('div', { class: 'prefs-grid' }, DUP_LABELS.map(([k, label]) => checkbox(`pf-dup-${k}`, label, prefs.duplicate[k] !== false, (v) => setPref('duplicate', { ...prefs.duplicate, [k]: v })))),
      ], { sub: true }),
    ]),
    panel('pf-ed-annot', 'Annotations', () => [pColor('annotation_color', 'Default Color'), pNum('annotation_eraser_radius', 'Eraser Radius', { min: 1, max: 200, int: true, unit: 'pixel', tip: 'Ctrl-drag with the Annotate tool erases strokes this close to the pointer' })]),
    panel('pf-ed-gp', 'Grease Pencil', () => [pNum('gpencil_min_distance', 'Point Spacing', { min: 0.1, max: 50, precision: 1, unit: 'pixel', tip: 'Pointer movement needed before a drawn stroke records another point (larger: lighter, smoother strokes)' })]),
    panel('pf-ed-text', 'Text Editor', () => [pBool('use_text_edit_auto_close', 'Auto Close Character Pairs', 'Typing ( [ { or a quote adds the closing one; a selection gets wrapped')]),
    panel('pf-ed-nodes', 'Node Editor', () => [
      pBool('node_use_insert_offset', 'Auto-Offset', 'Push downstream nodes to the right when a node is dropped onto a link'),
      pNum('node_margin', 'Auto-Offset Margin', { min: 0, max: 255, int: true, unit: 'pixel', disabled: !prefs.node_use_insert_offset }),
    ]),
    panel('pf-ed-weight', 'Weight Paint', () => {
      const ramp = prefs.weight_color_range;
      const css = (c: number[]) => `rgb(${c.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255)).join(',')})`;
      return [
        pBool('use_weight_color_range', 'Custom Gradient', 'Show vertex weights with the colours below instead of the default heat map'),
        prefs.use_weight_color_range
          ? [
              h('div', { class: 'prefs-ramp', style: { background: `linear-gradient(to right, ${ramp.map(css).join(', ')})` } }),
              ramp.map((c, i) =>
                splitRow(
                  `Weight ${['0', '0.25', '0.5', '0.75', '1'][i]}`,
                  colorSwatch(`pf-wr-${i}`, c, (v, f) => {
                    if (!f) return;
                    const next = ramp.map((x) => [...x] as [number, number, number]);
                    next[i] = [v[0], v[1], v[2]];
                    setPref('weight_color_range', next);
                  }, { linear: false }),
                ),
              ),
            ]
          : null,
      ];
    }),
    panel('pf-ed-misc', 'Miscellaneous', () => [pColor('sculpt_paint_overlay_color', 'Sculpt Mask Color')]),
  ],
});

// ---------------------------------------------------------------------------
// Animation

registerPrefSection({
  id: 'ANIMATION',
  label: 'Animation',
  group: 0,
  draw: () => [
    panel('pf-an-timeline', 'Timeline', () => [
      pNum('view2d_grid_spacing_min', 'Minimum Grid Spacing', { min: 10, max: 200, int: true, unit: 'pixel', tip: 'Smallest distance between time grid lines in the animation editors' }),
      pEnum('timecode_style', 'Timecode Style', [
        E('MINIMAL', 'Minimal Info', 'Seconds and frames, e.g. 3+12'),
        E('SMPTE', 'SMPTE (Full)', 'Hours, minutes, seconds and frames, e.g. 00:00:03:12'),
        E('SMPTE_COMPACT', 'SMPTE (Compact)', 'Only the parts in use, e.g. 3:12'),
        E('MILLISECONDS', 'Compact with Milliseconds', 'Minutes, seconds and milliseconds, e.g. 00:03.500'),
        E('SECONDS_ONLY', 'Only Seconds', 'Seconds with one decimal, e.g. 3.5'),
      ]),
      note('Used where an editor shows seconds (View ▸ Show Seconds).'),
    ]),
    panel('pf-an-keys', 'Keyframes', () => [
      pBool('use_keyframe_insert_needed', 'Only Insert Needed', 'Skip keyframes that would not change the curve'),
      pBool('use_insertkey_xyz_to_rgb', 'XYZ to RGB', 'New location, rotation and scale curves are coloured red, green and blue'),
    ]),
    panel('pf-an-fcurves', 'F-Curves', () => [
      pNum('fcurve_unselected_alpha', 'Unselected Opacity', { min: 0.01, max: 1, slider: true, precision: 2, tip: 'Opacity of unselected curves in the Graph Editor' }),
      pBool('show_only_selected_curve_keyframes', 'Only Selected Keyframes Handles', 'Show keyframes and handles only on selected curves'),
      pEnum('keyframe_new_interpolation_type', 'Default Interpolation', [E('CONSTANT', 'Constant'), E('LINEAR', 'Linear'), E('BEZIER', 'Bézier')]),
      pEnum('keyframe_new_handle_type', 'Default Handles', [E('FREE', 'Free'), E('ALIGNED', 'Aligned'), E('VECTOR', 'Vector'), E('AUTO', 'Automatic'), E('AUTO_CLAMPED', 'Auto Clamped')]),
      pBool('use_negative_frames', 'Allow Negative Frames', 'The current frame may go below 0'),
    ]),
  ],
});

// ---------------------------------------------------------------------------
// Input & Navigation

registerPrefSection({
  id: 'INPUT',
  label: 'Input',
  group: 2,
  draw: () => [
    panel('pf-kb', 'Keyboard', () => [pBool('emulate_numpad', 'Emulate Numpad', 'The 1 to 0 keys of the main keyboard act as the numpad ones in the 3D Viewport (useful for laptops)')]),
    panel('pf-mouse', 'Mouse', () => [
      pBool('emulate_3_button_mouse', 'Emulate 3 Button Mouse', 'A modifier with the left mouse button acts as the middle button'),
      pEnum('mouse_emulate_3_button_modifier', 'Emulation Modifier', [E('ALT', 'Alt'), E('OSKEY', 'Cmd / Win')], { expand: true, disabled: !prefs.emulate_3_button_mouse }),
      pBool('use_mouse_continuous', 'Continuous Grab', 'While moving, rotating or scaling, the pointer is captured so motion continues past the window edges'),
      pBool('use_drag_immediately', 'Release Confirms', 'Moving an item by dragging it ends when the button is released'),
      pNum('mouse_double_click_time', 'Double Click Speed', { min: 50, max: 1000, int: true, tip: 'Milliseconds between two presses of a key bound to Double Click' }),
      pNum('drag_threshold_mouse', 'Drag Threshold', { min: 1, max: 50, int: true, unit: 'pixel', tip: 'Distance the pointer moves before a click turns into a drag' }),
    ]),
    panel('pf-touchpad', 'Touchpad', () => [
      pBool('trackpad_orbit', 'Two-Finger Scroll Orbits', 'Two-finger scrolling orbits the view (off: it zooms)'),
      pEnum('touchpad_scroll_direction', 'Scroll Direction', [E('TRADITIONAL', 'Traditional', 'The view turns the way the fingers move'), E('NATURAL', 'Natural', 'The view turns against the finger movement')], { expand: true }),
    ]),
    panel('pf-ndof', 'NDOF', () => {
      const devs = ndofDevices();
      return [
        h('div', { class: 'prefs-note' }, devs.length ? `Connected: ${devs.map((d) => `${d.kind} (${d.id})`).join(', ')}` : 'No 3D mouse or game controller detected. Connect one and move it to wake it up.'),
        pBool('ndof_enabled', 'Use 3D Mouse', 'Navigate the 3D Viewport under the pointer with a 3D mouse'),
        pBool('ndof_use_game_controller', 'Use Game Controller', 'Game controllers navigate too: left stick pans, right stick orbits, triggers zoom', { disabled: !prefs.ndof_enabled }),
        pEnum('ndof_navigation_mode', 'Navigation', [E('OBJECT', 'Object', 'The scene turns as if held in the hand'), E('FLY', 'Fly', 'The viewer moves through the scene')], { expand: true }),
        pNum('ndof_translation_sensitivity', 'Pan Sensitivity', { min: 0.01, max: 40, precision: 2 }),
        pNum('ndof_rotation_sensitivity', 'Orbit Sensitivity', { min: 0.01, max: 40, precision: 2 }),
        pNum('ndof_deadzone', 'Deadzone', { min: 0, max: 0.9, slider: true, precision: 2, tip: 'Small movements below this are ignored' }),
        pEnum('ndof_zoom_direction', 'Zoom Direction', [E('FORWARD', 'Forward / Backward', 'Push or pull the cap to zoom'), E('UP', 'Up / Down', 'Lift or press the cap to zoom')], { expand: true }),
        pBool('ndof_lock_horizon', 'Lock Horizon', 'Keep the horizon level (no roll)'),
        h('div', { class: 'prefs-subhead' }, 'Invert Axes'),
        h('div', { class: 'prefs-grid' }, ([['ndof_panx_invert_axis', 'Pan X'], ['ndof_pany_invert_axis', 'Pan Y'], ['ndof_panz_invert_axis', 'Pan Z'], ['ndof_rotx_invert_axis', 'Pitch'], ['ndof_roty_invert_axis', 'Yaw'], ['ndof_rotz_invert_axis', 'Roll']] as const).map(([k, label]) => checkbox(`pf-${k}`, label, prefs[k], (v) => setPref(k, v)))),
      ];
    }, { closed: true }),
    panel('pf-tablet', 'Tablet', () => [
      pNum('pressure_threshold_max', 'Max Threshold', { min: 0.01, max: 1, slider: true, precision: 2, tip: 'Pen pressure that already counts as full strength' }),
      pNum('pressure_softness', 'Softness', { min: -1, max: 1, slider: true, precision: 2, tip: 'Above 0 light strokes get stronger, below 0 they get weaker' }),
    ]),
  ],
});

registerPrefSection({
  id: 'NAVIGATION',
  label: 'Navigation',
  group: 2,
  draw: () => [
    panel('pf-orbit', 'Orbit & Pan', () => [
      pEnum('orbit_method', 'Orbit Method', [E('TURNTABLE', 'Turntable', 'Orbit around the vertical axis and keep the horizon level'), E('TRACKBALL', 'Trackball', 'Orbit freely in every direction')], { expand: true }),
      pNum('view_rotate_sensitivity', 'Orbit Sensitivity', { min: 0.05, max: 3, step: 0.01, precision: 2, tip: 'Degrees per pixel of mouse movement' }),
      pBool('use_rotate_around_active', 'Orbit Around Selection', 'Orbit around the center of the selection instead of the view center'),
      pBool('use_auto_perspective', 'Auto Perspective', 'Switch to orthographic for axis-aligned views and back to perspective when orbiting'),
      pNum('smooth_view', 'Smooth View', { min: 0, max: 1000, int: true, tip: 'Length of animated view changes such as framing, in milliseconds (0: instant)' }),
      pNum('rotation_angle', 'Rotation Angle', { min: 0.1, max: 90, precision: 1, tip: 'Degrees the numpad 4 / 6 / 8 / 2 keys orbit by' }),
    ]),
    panel('pf-zoom', 'Zoom', () => [
      pEnum('view_zoom_axis', 'Zoom Axis', [E('VERTICAL', 'Vertical', 'Drag up and down to zoom'), E('HORIZONTAL', 'Horizontal', 'Drag left and right to zoom')], { expand: true }),
      pBool('invert_mouse_zoom', 'Invert Mouse Zoom Direction', 'Ctrl + middle mouse drag zooms the other way'),
      pBool('invert_zoom_wheel', 'Invert Wheel Zoom Direction', 'Scroll the wheel the other way to zoom in'),
      pBool('use_zoom_to_mouse', 'Zoom to Mouse Position', 'Zoom toward the pointer instead of the view center'),
    ]),
    panel('pf-fly', 'Fly & Walk', () => [
      pEnum('navigation_mode', 'View Navigation', [E('WALK', 'Walk', 'Shift ` walks through the scene'), E('FLY', 'Fly', 'Shift ` flies through the scene')], { expand: true }),
      panel('pf-walk', 'Walk', () => [
        pBool('walk_use_mouse_reverse', 'Reverse Mouse', 'Moving the mouse up looks down'),
        pNum('walk_mouse_speed', 'Mouse Sensitivity', { min: 0.01, max: 10, precision: 2 }),
        pNum('walk_teleport_time', 'Teleport Duration', { min: 0, max: 10, precision: 2, unit: 'time' }),
        pNum('walk_speed', 'Walk Speed', { min: 0, max: 100, precision: 2, tip: 'Meters per second (0: scaled to the view)' }),
        pNum('walk_speed_factor', 'Speed Factor', { min: 1, max: 20, precision: 1, tip: 'Shift walks this many times faster' }),
      ], { sub: true }),
      panel('pf-gravity', 'Gravity', () => [
        pBool('walk_use_gravity', 'Gravity', 'Walking starts with gravity on (Tab toggles it)'),
        pNum('walk_view_height', 'View Height', { min: 0.01, max: 100, precision: 2, unit: 'distance' }),
        pNum('walk_jump_height', 'Jump Height', { min: 0.01, max: 100, precision: 2, unit: 'distance' }),
      ], { sub: true }),
    ]),
  ],
});

// ---------------------------------------------------------------------------
// Keymap

registerPrefSection({ id: 'KEYMAP', label: 'Keymap', group: 2, draw: (c) => c.editor.keymapView.body() });

// ---------------------------------------------------------------------------
// System

let glInfo: [string, string][] | null = null;
function systemRows(): Child {
  if (!glInfo) {
    glInfo = [];
    try {
      const r = renderContext?.engine.renderer;
      const gl = (r?.getContext() as WebGL2RenderingContext | undefined) ?? document.createElement('canvas').getContext('webgl2');
      if (!gl) glInfo.push(['WebGL', 'Not available']);
      else {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        glInfo.push(['Vendor', String(dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR))]);
        glInfo.push(['Renderer', String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))]);
        glInfo.push(['Version', String(gl.getParameter(gl.VERSION))]);
        glInfo.push(['Shading Language', String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION))]);
        glInfo.push(['Max Texture Size', String(gl.getParameter(gl.MAX_TEXTURE_SIZE))]);
        glInfo.push(['Max Samples', String(gl.getParameter(gl.MAX_SAMPLES))]);
        glInfo.push(['Extensions', String(gl.getSupportedExtensions()?.length ?? 0)]);
      }
      glInfo.push(['WebGPU', typeof navigator !== 'undefined' && 'gpu' in navigator ? 'Available' : 'Not available']);
    } catch (e) {
      glInfo.push(['WebGL', `Unavailable (${(e as Error).message})`]);
    }
  }
  return glInfo.map(([a, b]) => infoRow(a, b));
}

function pythonRows(): Child {
  const st = python.state;
  return [
    infoRow('Status', st === 'ready' ? `Loaded (Python ${python.version})` : st === 'loading' ? 'Loading…' : st === 'error' ? 'Failed to load' : 'Not loaded (loads on first use)'),
    infoRow('Runtime', `Pyodide ${PYODIDE_VERSION} (MPL-2.0)`),
    infoRow('Source', PYODIDE_INDEX_URL),
    st === 'error' ? h('div', { class: 'prefs-note err' }, python.error) : null,
  ];
}

function deviceRows(): Child {
  const n = navigator as Navigator & { deviceMemory?: number; userAgentData?: { platform?: string } };
  return [
    infoRow('Device Pixel Ratio', String(devicePixelRatio)),
    infoRow('CPU Threads', String(n.hardwareConcurrency ?? '?')),
    infoRow('Memory', n.deviceMemory ? `${n.deviceMemory} GB (approx.)` : 'Unknown'),
    infoRow('Platform', n.userAgentData?.platform ?? n.platform ?? ''),
    infoRow('Browser', n.userAgent),
    infoRow('Storage', typeof indexedDB !== 'undefined' ? 'IndexedDB available (session recovery)' : 'IndexedDB unavailable'),
  ];
}

registerPrefSection({
  id: 'SYSTEM',
  label: 'System',
  group: 3,
  draw: () => [
    panel('pf-gpu', 'Display Graphics', () => systemRows()),
    panel('pf-memory', 'Memory & Limits', () => [
      pNum('undo_steps', 'Undo Steps', { min: 0, max: 512, int: true, tip: 'How many steps Undo can go back' }),
      note(`${app.undo.history.length} step(s) in the current history.`),
      pNum('scrollback', 'Console Scrollback Lines', { min: 32, max: 100000, int: true, tip: 'Lines the Python Console keeps' }),
    ]),
    panel('pf-sound', 'Sound', () => [
      pEnum('audio_sample_rate', 'Sample Rate', [E('0', 'Automatic', 'The output device’s own rate'), E('44100', '44.1 kHz'), E('48000', '48 kHz'), E('96000', '96 kHz'), E('192000', '192 kHz')]),
      pEnum('audio_channels', 'Channels', [E('1', 'Mono'), E('2', 'Stereo'), E('4', '4 Channels'), E('6', '5.1 Surround'), E('8', '7.1 Surround')]),
      pEnum('audio_latency', 'Buffer', [E('interactive', 'Low Latency', 'Smallest output buffer: sound follows the timeline closely'), E('balanced', 'Balanced'), E('playback', 'Smooth Playback', 'Largest buffer: fewest dropouts on slow devices')]),
      note('Sound settings apply the next time playback starts. Channels are limited by the output device.'),
    ]),
    panel('pf-network', 'Network', () => [pBool('use_online_access', 'Allow Online Access', 'Let features reach the internet: downloading the Python runtime (first use) and the AI assistant. Everything else works offline.')]),
    panel('pf-py', 'Python', () => pythonRows()),
    panel('pf-dev', 'Device', () => deviceRows(), { closed: true }),
  ],
});

// ---------------------------------------------------------------------------
// Save & Load

registerPrefSection({
  id: 'SAVE_LOAD',
  label: 'Save & Load',
  group: 3,
  draw: () => [
    panel('pf-blend', 'Project Files', () => [
      pBool('use_load_ui', 'Load UI', 'Opening a project also restores its workspaces and editor layout'),
      pBool('use_save_prompt', 'Save Prompt', 'Ask before leaving the page when there are changes since the last save'),
      pNum('recent_files', 'Recent Files', { min: 1, max: 50, int: true, tip: 'How many recently used projects are kept (with a copy in browser storage)' }),
    ]),
    panel('pf-autosave', 'Auto Save', () => [
      pBool('use_auto_save_temporary_files', 'Auto Save', 'Keep a recovery copy of the project at regular intervals (in addition to saving after edits)'),
      pNum('autosave_interval', 'Timer (Minutes)', { min: 1, max: 60, int: true, disabled: !prefs.use_auto_save_temporary_files }),
      h('div', { class: 'prefs-btn-row' }, h('button', { class: 'btn', onclick: () => app.run('wm.recover_last_session') }, 'Recover Last Session'), h('button', { class: 'btn', onclick: () => app.run('wm.recover_auto_save') }, 'Recover Auto Save…')),
    ]),
    panel('pf-textfiles', 'Text Files', () => [pBool('use_tabs_as_spaces', 'Tabs as Spaces', 'The Tab key in the Text Editor inserts spaces')]),
    panel('pf-autorun', 'Auto Run Scripts', () => [
      pBool('use_scripts_auto_execute', 'Auto Run Scripts', 'Run the texts marked Text ▸ Register when a project is opened. Only turn this on for projects you trust: scripts can change anything in the project.'),
    ]),
    panel('pf-fb', 'File Browser', () => [
      pBool('use_filter_files', 'Filter Files', 'New File Browsers show only projects, images, models and texts'),
      pBool('show_hidden_files_datablocks', 'Show Hidden Files', 'New File Browsers list files whose names start with a dot'),
    ]),
  ],
});
