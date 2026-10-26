import {
  createElement,
  Download, Pause, Play, Trash2, Folder, ExternalLink, HardDrive, Cloud,
  FileText, Film, Music, Archive, Image, Monitor, Sun, Moon, Plus, Check,
  RefreshCw, AlertCircle, Settings, X, Search, CheckCircle2, Clock, Terminal,
  ChevronRight, Zap, Copy, Filter, ArrowDownToLine, MoreVertical,
  User, LogOut, Volume2, VolumeX, Layers, Info
} from 'lucide';

const ICONS = {
  download: Download,
  pause: Pause,
  play: Play,
  trash: Trash2,
  folder: Folder,
  external: ExternalLink,
  hardDrive: HardDrive,
  cloud: Cloud,
  document: FileText,
  video: Film,
  music: Music,
  archive: Archive,
  image: Image,
  monitor: Monitor,
  sun: Sun,
  moon: Moon,
  plus: Plus,
  check: Check,
  refresh: RefreshCw,
  alert: AlertCircle,
  settings: Settings,
  x: X,
  search: Search,
  checkCircle: CheckCircle2,
  clock: Clock,
  terminal: Terminal,
  chevRight: ChevronRight,
  zap: Zap,
  copy: Copy,
  filter: Filter,
  arrowDown: ArrowDownToLine,
  more: MoreVertical,
  user: User,
  logOut: LogOut,
  volume: Volume2,
  volumeMute: VolumeX,
  layers: Layers,
  info: Info,
};

export function icon(name, size = 18, strokeWidth = 2) {
  const def = ICONS[name] || ICONS.download;
  const node = createElement(def);
  node.setAttribute('width', size);
  node.setAttribute('height', size);
  node.setAttribute('stroke-width', strokeWidth);
  node.setAttribute('aria-hidden', 'true');
  return node.outerHTML;
}

export function iconNode(name, size = 18, strokeWidth = 2) {
  const tpl = document.createElement('template');
  tpl.innerHTML = icon(name, size, strokeWidth);
  return tpl.content.firstElementChild;
}
