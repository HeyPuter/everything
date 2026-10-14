// Icons for the slide show and recording commands, drawn for this project
// in the idiom of src/chrome/icons.js (20-unit grid, glass classes), and the
// line icons the show's own controls use.
import {
  createElement,
  AArrowDown,
  AArrowUp,
  Captions,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleStop,
  Ellipsis,
  Highlighter,
  LayoutGrid,
  Mic,
  MicOff,
  Moon,
  Pause,
  Play,
  RotateCcw,
  Settings,
  SkipForward,
  Square,
  Trash2,
  Video,
  VideoOff,
  X,
  ZoomIn,
} from "lucide";
import { registerCommandIcons } from "../chrome/icons.js";
import { iconButton } from "../ui.js";

const LINE = {
  AArrowDown,
  AArrowUp,
  Captions,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleStop,
  Ellipsis,
  Highlighter,
  LayoutGrid,
  Mic,
  MicOff,
  Moon,
  Pause,
  Play,
  RotateCcw,
  Settings,
  SkipForward,
  Square,
  Trash2,
  Video,
  VideoOff,
  X,
  ZoomIn,
};

/** A line icon for the show's controls. */
export function lineIcon(name, size = 18) {
  return createElement(LINE[name] || Circle, {
    width: size,
    height: size,
    "stroke-width": 1.7,
    "aria-hidden": "true",
    focusable: "false",
  });
}

/** A control-bar button with one of the show's line icons. */
export function lineButton(label, name, handler, attrs = {}) {
  const b = iconButton(label, null, handler, attrs);
  b.append(lineIcon(name));
  return b;
}

const slideFrame = (x, y, w, h, c = "of") =>
  `<rect class="${c}" x="${x}" y="${y}" width="${w}" height="${h}" rx="1.4"/>` +
  `<rect class="ks" x="${x + w * 0.14}" y="${y + h * 0.18}" width="${w * 0.5}" height="1.6" rx="0.8"/>` +
  `<path class="o ln" d="M${x + w * 0.14} ${y + h * 0.52}h${w * 0.45}"/>`;
const recordDot = (cx, cy, rad = 3.6) =>
  `<circle class="knock" cx="${cx}" cy="${cy}" r="${rad + 0.9}"/>` +
  `<circle class="rs" cx="${cx}" cy="${cy}" r="${rad}"/>` +
  `<circle class="wh" cx="${cx}" cy="${cy}" r="${rad * 0.4}"/>` +
  `<circle class="glint" cx="${cx - rad * 0.3}" cy="${cy - rad * 0.35}" r="${rad * 0.22}"/>`;
const person = (cx, cy, rad) =>
  `<circle class="knock" cx="${cx}" cy="${cy}" r="${rad + 0.9}"/>` +
  `<circle class="bf" cx="${cx}" cy="${cy}" r="${rad}"/>` +
  `<circle class="bs" cx="${cx}" cy="${cy - rad * 0.28}" r="${rad * 0.32}"/>` +
  `<path class="bs" d="M${cx - rad * 0.62} ${cy + rad * 0.62}a${rad * 0.62} ${rad * 0.5} 0 0 1 ${rad * 1.24} 0z"/>`;
const captionBox = (x, y, w, h) =>
  `<rect class="of" x="${x}" y="${y}" width="${w}" height="${h}" rx="1.6"/>` +
  `<path class="b thick" d="M${x + 2} ${y + h - 3.2}h${w * 0.38}M${x + 2 + w * 0.45} ${y + h - 3.2}h${w * 0.3}"/>` +
  `<path class="o thick" d="M${x + 2} ${y + h - 6}h${w * 0.55}"/>`;
const smallGear = (cx, cy, rad) =>
  `<circle class="knock" cx="${cx}" cy="${cy}" r="${rad + 1}"/>` +
  `<circle class="ns" cx="${cx}" cy="${cy}" r="${rad}"/>` +
  `<circle class="wh" cx="${cx}" cy="${cy}" r="${rad * 0.38}"/>` +
  `<path class="ns thick" d="M${cx} ${cy - rad - 0.9}v1.2M${cx} ${cy + rad - 0.3}v1.2M${cx - rad - 0.9} ${cy}h1.2M${cx + rad - 0.3} ${cy}h1.2"/>`;

registerCommandIcons({
  liveCamera: slideFrame(2.5, 3, 14, 10.5) + person(14.5, 13.5, 4),
  recordFromStart: slideFrame(2.5, 3, 14, 10.5) + recordDot(15, 14.5),
  recordFromCurrent:
    `<rect class="kf glassy" x="2.5" y="2.5" width="12" height="9" rx="1.4"/>` +
    slideFrame(4.5, 5, 12.5, 9.5) +
    recordDot(15, 14.5),
  clearRecording:
    slideFrame(2.5, 3, 14, 10.5) +
    `<circle class="knock" cx="15" cy="14.5" r="4.5"/>` +
    `<circle class="rs" cx="15" cy="14.5" r="3.6"/>` +
    `<path class="wh thick" d="M13.4 12.9l3.2 3.2M16.6 12.9l-3.2 3.2"/>`,
  resetToCamera:
    slideFrame(2.5, 3, 14, 10.5) +
    person(14.5, 13.5, 4) +
    `<path class="g thick" d="M3.5 17.5a4 4 0 0 1 5-2.5"/><path class="g thick" d="M8.8 13.8l-.3 1.4 1.3.5"/>`,
  subtitles: captionBox(2.5, 4, 15, 12),
  subtitleSettings: captionBox(2, 3.5, 14, 11) + smallGear(15, 15, 3),
  exportVideo:
    `<rect class="of" x="2.5" y="4" width="11" height="9" rx="1.4"/>` +
    `<path class="bf" d="M13.5 7l3.5-2v7l-3.5-2z"/>` +
    `<circle class="knock" cx="14.5" cy="15" r="4.2"/>` +
    `<circle class="gs" cx="14.5" cy="15" r="3.4"/>` +
    `<path class="wh thick" d="M14.5 13v4M12.9 15.5l1.6 1.6 1.6-1.6"/>`,
});
