// Audio track commands on the video timeline. Registration is eager (menus,
// the Timeline panel and the command search see every command); decoding,
// mixing and the commands themselves load on first use.
import type { Editor } from '../../editor';
import { registerCommand, type Command } from '../../app/registry';
import { lazy, lazyRun } from '../../app/lazy';
import { findAudioClip } from '../../model/audio-timeline';
import { hasAnimation } from './state';
import { hasTimeline, selectedAudioClips, selectedAudioTrack, timelineOf, videoLayerOf, videoView } from './video-state';

export const audioCommands = lazy(() => import('./audio-commands'));
/** Clip commands act on the selected audio clips while any is selected. */
export const audioSelected = (e: Editor) => hasTimeline(e) && selectedAudioClips(e).length > 0;
const linkedSelected = (e: Editor) => audioSelected(e) && selectedAudioClips(e).some((id) => findAudioClip(timelineOf(e)!, id)?.clip.link);
const canAdd = (e: Editor) => e.hasDocument && !hasAnimation(e) && !e.doc.layers.some((l) => l.artboard);
const trackFlag = (e: Editor, flag: 'muted' | 'solo') => hasTimeline(e) && !!selectedAudioTrack(e)?.[flag];

/** Panel menu entries for audio (after the clip entries). */
export const audioMenu = () => [
  'timeline.audio-add', 'timeline.audio-track-new', 'timeline.audio-track-rename', 'timeline.audio-track-delete', 'timeline.audio-track-mute', 'timeline.audio-track-solo', '-',
  'timeline.audio-settings', 'timeline.audio-duplicate', 'timeline.audio-unlink', 'timeline.audio-delete', 'timeline.audio-scrub',
];
/** Context menu of an audio clip. */
export const audioClipMenu = () => ['timeline.split', 'timeline.trim-start', 'timeline.trim-end', '-', 'timeline.audio-settings', 'timeline.audio-duplicate', 'timeline.audio-unlink', 'timeline.audio-delete'];
/** Context menu of an audio track header. */
export const audioTrackMenu = () => ['timeline.audio-add', 'timeline.audio-track-rename', 'timeline.audio-track-mute', 'timeline.audio-track-solo', '-', 'timeline.audio-track-new', 'timeline.audio-track-delete'];

export function installAudio() {
  const m = audioCommands;
  const flag = (id: string, label: string, which: 'muted' | 'solo', description: string): Command => ({
    id,
    label,
    enabled: hasTimeline,
    checked: (e) => trackFlag(e, which),
    description,
    ...lazyRun(m, (x, e, arg) => x.toggleTrack(e, which, arg)),
  });
  registerCommand(
    { id: 'timeline.audio-add', label: 'Add Audio…', recordable: false, enabled: canAdd, description: 'Add a sound file (WAV, MP3, AAC, Ogg, Opus or FLAC) as a clip at the playhead', ...lazyRun(m, (x, e, arg) => x.addAudio(e, arg)) },
    { id: 'timeline.audio-track-new', label: 'New Audio Track', enabled: hasTimeline, ...lazyRun(m, (x, e) => x.newTrack(e)) },
    { id: 'timeline.audio-track-delete', label: 'Delete Audio Track', enabled: (e) => !!timelineOf(e)?.audio?.length, description: 'Remove the selected audio track and its clips', ...lazyRun(m, (x, e, arg) => x.deleteTrack(e, arg)) },
    { id: 'timeline.audio-track-rename', label: 'Rename Audio Track…', enabled: hasTimeline, ...lazyRun(m, (x, e, arg) => x.renameTrack(e, arg)) },
    flag('timeline.audio-track-mute', 'Mute Audio Track', 'muted', 'Silence the selected audio track'),
    flag('timeline.audio-track-solo', 'Solo Audio Track', 'solo', 'Play only solo tracks'),
    { id: 'timeline.audio-set', label: 'Audio Settings', hidden: true, enabled: hasTimeline, ...lazyRun(m, (x, e, arg) => x.setAudio(e, arg)) },
    { id: 'timeline.audio-settings', label: 'Audio Clip Settings…', enabled: (e) => audioSelected(e) && selectedAudioClips(e).length === 1, description: 'Gain and fades of the selected audio clip', ...lazyRun(m, (x, e) => x.clipSettings(e)) },
    { id: 'timeline.audio-delete', label: 'Delete Audio Clips', enabled: audioSelected, ...lazyRun(m, (x, e) => x.deleteClips(e)) },
    { id: 'timeline.audio-duplicate', label: 'Duplicate Audio Clips', enabled: audioSelected, description: 'Copy the selected audio clips right after themselves', ...lazyRun(m, (x, e) => x.duplicateClips(e)) },
    { id: 'timeline.audio-unlink', label: 'Unlink Audio', enabled: linkedSelected, description: 'Let the sound of a video layer move on its own', ...lazyRun(m, (x, e) => x.unlinkClips(e)) },
    {
      id: 'timeline.audio-scrub',
      label: 'Audio Scrubbing',
      enabled: hasTimeline,
      recordable: false,
      checked: (e) => hasTimeline(e) && videoView(e).scrubAudio,
      description: 'Play a short snippet of sound while dragging the playhead',
      run: (e) => {
        videoView(e).scrubAudio = !videoView(e).scrubAudio;
        e.update();
      },
    },
    { id: 'layer.video-mute', label: 'Mute Video Sound', enabled: (e) => !!videoLayerOf(e)?.video.audio, checked: (e) => !!videoLayerOf(e)?.video.muted, description: 'Silence the sound of the selected video layer', ...lazyRun(m, (x, e) => x.toggleVideoMute(e)) },
  );
}
