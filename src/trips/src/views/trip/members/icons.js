import { createElement, Link, Mail, Share2, UserPlus, Crown, LogOut, Inbox, UserRound, RefreshCw, ShieldCheck } from 'lucide';
import { icon as kitIcon } from '../../../ui/icons.js';

// Icons the kit does not carry.
const extra = { link: Link, mail: Mail, share: Share2, invite: UserPlus, crown: Crown, leave: LogOut, inbox: Inbox, guest: UserRound, refresh: RefreshCw, shield: ShieldCheck };

export function icon(name, size = 18) {
  if (!Object.hasOwn(extra, name)) return kitIcon(name, size);
  return createElement(extra[name], { width: size, height: size, 'stroke-width': 1.8, 'aria-hidden': 'true', focusable: 'false', class: 'icon' });
}
