import { createElement, Images, RefreshCw, Link, Server, Route, Download, KeyRound, ShieldAlert, Undo2, CircleCheck, MapPinned, Flag, Ban } from 'lucide';
import { icon as kitIcon } from '../../ui/icons.js';

// Icons the kit does not carry.
const extra = {
  images: Images, refresh: RefreshCw, link: Link, server: Server, route: Route, download: Download, key: KeyRound,
  insecure: ShieldAlert, restore: Undo2, connected: CircleCheck, stay: MapPinned, flag: Flag, dismiss: Ban,
};
export function icon(name, size = 18) {
  if (!Object.hasOwn(extra, name)) return kitIcon(name, size);
  return createElement(extra[name], { width: size, height: size, 'stroke-width': 1.8, 'aria-hidden': 'true', focusable: 'false', class: 'icon' });
}
