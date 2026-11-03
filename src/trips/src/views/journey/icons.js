import {
  createElement, BookOpen, NotebookPen, Laugh, Smile, Meh, Annoyed, Frown, Sun, CloudSun, Cloud, CloudFog, CloudRain, Snowflake,
  CloudLightning, Wind, Camera, Images, Video, MapPin, LocateFixed, Share2, UserPlus, LogOut, Settings, Eye, EyeOff, RotateCcw, Link,
  Unlink, Route, ChartColumn, Tag, ThumbsUp, ThumbsDown, Sparkles, Flag, CalendarDays, Lightbulb, Upload, HardDrive, Star, ImagePlus,
  ScanSearch, SquarePen, Lock, Navigation, Hash, Trash2, Globe,
} from 'lucide';
import { icon as kitIcon } from '../../ui/icons.js';

const extra = {
  journey: BookOpen, write: NotebookPen, camera: Camera, photos: Images, video: Video, 'map-pin': MapPin, locate: LocateFixed,
  share: Share2, invite: UserPlus, leave: LogOut, settings: Settings, eye: Eye, hidden: EyeOff, restore: RotateCcw, link: Link,
  unlink: Unlink, route: Route, stats: ChartColumn, tag: Tag, pro: ThumbsUp, con: ThumbsDown, highlight: Sparkles, flag: Flag,
  day: CalendarDays, suggestion: Lightbulb, upload: Upload, drive: HardDrive, star: Star, addPhoto: ImagePlus, nearby: ScanSearch,
  edit: SquarePen, lock: Lock, checkin: Navigation, hash: Hash, delete: Trash2, web: Globe,
  // Moods.
  great: Laugh, good: Smile, okay: Meh, meh: Annoyed, bad: Frown,
  // Weather.
  clear: Sun, partly: CloudSun, cloudy: Cloud, fog: CloudFog, rain: CloudRain, snow: Snowflake, thunder: CloudLightning, wind: Wind,
};

export const TYPE_ICONS = Object.freeze({ moment: 'write', day: 'day', checkin: 'checkin', highlight: 'highlight', suggestion: 'suggestion' });

export function icon(name, size = 18) {
  if (!Object.hasOwn(extra, name)) return kitIcon(name, size);
  return createElement(extra[name], { width: size, height: size, 'stroke-width': size <= 16 ? 2 : 1.8, 'aria-hidden': 'true', focusable: 'false', class: 'icon' });
}
