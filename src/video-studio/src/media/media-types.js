/**
 * Which files import as media: file name extensions per kind and the accept
 * list every media file picker uses (Home and the media panel). Kept apart
 * from probe.js, which loads Mediabunny, so Home can use it.
 */

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
export const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|weba)$/i;
export const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|ogv|ts|mts|m2ts|3gp|3g2)$/i;

/**
 * MPEG transport streams (AVCHD cameras' .mts and .m2ts, broadcast .ts):
 * WebCodecs decodes them, but browsers' media elements don't play them, so
 * the preview plays a proxy (model/proxy.js).
 */
export const STREAM_EXTS = new Set(['ts', 'mts', 'm2ts']);

const MIME_BY_EXT = { ts: 'video/mp2t', mts: 'video/mp2t', m2ts: 'video/mp2t', '3gp': 'video/3gpp', '3g2': 'video/3gpp2' };

/**
 * The MIME type to store for a media file. Systems label some video files
 * with other types (macOS calls .mts files model/vnd.mts): those get the
 * type of their extension.
 */
export function mediaMime(file) {
  const type = file.type || '';
  if (/^(video|audio|image)\//.test(type)) return type;
  const ext = /\.([a-z0-9]+)$/i.exec(file.name || '')?.[1]?.toLowerCase();
  return MIME_BY_EXT[ext] || type;
}

/** Extensions listed besides the MIME families: systems that don't know a type would grey them out. */
const EXTRA = {
  video: ['.mkv', '.mov', '.m4v', '.webm', '.mts', '.m2ts', '.ts', '.3gp'],
  audio: ['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.opus'],
  image: [],
};

/** The accept attribute of a picker for one kind of media (replacing a file keeps its kind). */
export const ACCEPT_FOR = Object.fromEntries(Object.entries(EXTRA).map(([kind, ext]) => [kind, [`${kind}/*`, ...ext].join(',')]));

/** The accept attribute of media file pickers. */
export const MEDIA_ACCEPT = ['video/*', 'audio/*', 'image/*', ...EXTRA.video, ...EXTRA.audio].join(',');

/** 'image' | 'audio' | 'video' by MIME type or extension; null for other files. */
export function guessKind(file) {
  const type = file.type || '';
  if (type.startsWith('image/') || IMAGE_EXT.test(file.name || '')) return 'image';
  if (type.startsWith('audio/') || AUDIO_EXT.test(file.name || '')) return 'audio';
  if (type.startsWith('video/') || VIDEO_EXT.test(file.name || '')) return 'video';
  return null;
}
