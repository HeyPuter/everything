import {
  createElement, Plus, X, Check, ChevronLeft, ChevronRight, ChevronDown, Ellipsis,
  Pencil, Trash2, Sun, Moon, Monitor, Search, Calendar, Clock, MapPin, Map,
  Users, GripVertical, AlertTriangle, WifiOff, LoaderCircle, ArrowLeft,
  ArrowRight, Menu, FileText, Wallet, Backpack, Plane, Copy, Heart, Globe, Upload, CircleHelp,
} from 'lucide';

const icons = {
  plus: Plus, close: X, check: Check, chevronLeft: ChevronLeft, chevronRight: ChevronRight,
  chevronDown: ChevronDown, more: Ellipsis, pencil: Pencil, trash: Trash2, sun: Sun,
  moon: Moon, monitor: Monitor, search: Search, calendar: Calendar, clock: Clock,
  pin: MapPin, map: Map, users: Users, grip: GripVertical, warning: AlertTriangle,
  offline: WifiOff, loading: LoaderCircle, arrowLeft: ArrowLeft, arrowRight: ArrowRight,
  menu: Menu, file: FileText, wallet: Wallet, backpack: Backpack, plane: Plane,
  copy: Copy, heart: Heart, globe: Globe, upload: Upload, help: CircleHelp,
};
export function icon(name, size = 18) {
  return createElement(icons[name] ?? CircleHelp, {
    width: size, height: size, 'stroke-width': 1.8, 'aria-hidden': 'true',
    focusable: 'false', class: 'icon',
  });
}
