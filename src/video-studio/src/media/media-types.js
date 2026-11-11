/**
 * Which files import as media: file name extensions per kind and the accept
 * list every media file picker uses (Home and the media panel). Kept apart
 * from probe.js, which loads Mediabunny, so Home can use it.
 */

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
export const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|weba)$/i;
export const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|ogv)$/i;

/** Extensions listed besides the MIME families: systems that don't know a type would grey them out. */
const EXTRA = {
  video: ['.mkv', '.mov', '.m4v', '.webm'],
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
