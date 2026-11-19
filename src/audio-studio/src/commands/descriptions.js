// One-line descriptions of commands for the Keyboard Shortcuts dialog: written
// out for the commands people look up most, and otherwise put together from
// what the command is (an effect, a panel, a tool, a workspace, an on/off
// setting, a dialog) and where it sits in the menus.

import { getEffect } from '../effects/registry.js';
import { EFFECT_GROUPS } from '../ui/menus.js';

/** Written descriptions, by command id. */
export const DESCRIPTIONS = {
  'file.open': 'Opens audio, video or session files.',
  'file.save': 'Saves the file in its own format and place, or asks where when it has none.',
  'file.saveAs': 'Saves under a new name, format or folder; the open file follows the new copy.',
  'file.saveCopy': 'Writes a copy elsewhere; the open file stays as it is.',
  'file.saveAll': 'Saves every open file and session that has changes.',
  'file.close': 'Closes the active file, asking to save changes first.',
  'file.closeAll': 'Closes every open file and session.',
  'file.exportFile': 'Writes the audio to a new file in any format, leaving the open file unchanged.',
  'file.newAudio': 'Starts an empty audio file with the sample rate, channels and bit depth you choose.',
  'file.newSession': 'Starts a multitrack session, optionally from a template.',
  'file.import': 'Adds files to the Files panel without switching to them.',
  'file.runScript': 'Runs a JavaScript file that automates the app.',
  'edit.undo': 'Takes back the last change.',
  'edit.redo': 'Does again the change that was undone.',
  'edit.repeat': 'Runs the previous command again, with its dialog.',
  'edit.cut': 'Removes the selection and puts it on the current clipboard.',
  'edit.copy': 'Puts a copy of the selection on the current clipboard.',
  'edit.paste': 'Inserts the clipboard at the playhead, or replaces the selection with it.',
  'edit.mixPaste': 'Mixes the clipboard into the audio at the playhead.',
  'edit.delete': 'Removes the selection; the audio after it moves up.',
  'edit.selectAll': 'Selects the whole file, or every clip in a session.',
  'edit.deselect': 'Clears the selection.',
  'edit.crop': 'Keeps only the selection and removes the rest.',
  'edit.insertSilence': 'Inserts silence of a length you choose at the playhead.',
  'edit.convertSampleType': 'Changes the sample rate, channels or bit depth of the file.',
  'edit.keyboardShortcuts': 'Shows and changes every keyboard shortcut.',
  'edit.preferences': 'Opens the settings for the whole app.',
  'marker.add': 'Adds a cue marker at the playhead, or a range marker over the selection.',
  'marker.next': 'Moves the playhead to the next marker.',
  'marker.previous': 'Moves the playhead to the previous marker.',
  'transport.play': 'Starts or stops playback.',
  'transport.stop': 'Stops playback or recording.',
  'transport.record': 'Starts recording into the file, or onto armed tracks in a session.',
  'transport.loop': 'Plays the selection (or the whole file) over and over.',
  'transport.toStart': 'Moves the playhead to the start.',
  'transport.toEnd': 'Moves the playhead to the end.',
  'view.waveform': 'Switches to the Waveform editor for the active file.',
  'view.multitrack': 'Switches to the Multitrack editor.',
  'view.spectral': 'Shows or hides the spectral frequency display under the waveform.',
  'view.zoomInTime': 'Shows less time, in more detail.',
  'view.zoomOutTime': 'Shows more time, in less detail.',
  'view.zoomFull': 'Shows the whole file or session.',
  'clip.split': 'Cuts the selected clips (or the clip under the playhead) in two at the playhead.',
  'clip.merge': 'Joins the selected clips into one.',
  'mt.addStereo': 'Adds a stereo audio track after the selected one.',
  'mt.mixdownAll': 'Renders the whole session to a new audio file.',
  'help.gettingStarted': 'Shows a short guide to the main tasks.',
  'help.shortcuts': 'Shows and changes every keyboard shortcut.',
  'file.revert': 'Throws away the changes since the file was last saved.',
  'file.properties': 'Shows the file\'s format, size and other details in the Properties panel.',
  'edit.repeatNoDialog': 'Runs the previous command again with the same settings, without its dialog.',
  'edit.copyToNew': 'Makes a new file from the selection.',
  'edit.pasteToNew': 'Makes a new file from the clipboard.',
  'fx.invert': 'Flips the polarity of the selection.',
  'fx.reverse': 'Plays the selection backwards from now on.',
  'fx.silence': 'Replaces the selection with silence, keeping its length.',
  'fx.applyLast': 'Applies the last effect again with the same settings.',
  'transport.toggle': 'Starts playback, or stops it when playing.',
  'transport.pause': 'Pauses playback where it is.',
  'transport.rewind': 'Moves the playhead backwards while held.',
  'transport.forward': 'Moves the playhead forwards while held.',
  'transport.shuttleReverse': 'Plays backwards; pressing again plays faster.',
  'transport.shuttleStop': 'Stops shuttle playback.',
  'transport.shuttleForward': 'Plays forwards; pressing again plays faster.',
  'transport.punchRoll': 'Plays a few seconds before the playhead, then records from it.',
  'edit.extractChannels': 'Makes a mono file of each channel.',
  'edit.editOriginal': 'Opens the session this mixdown came from.',
  'edit.trimToSelection': 'Keeps only the selection and removes the rest.',
  'clip.splitAll': 'Cuts every clip under the playhead in two.',
  'clip.uniqueCopy': 'Gives the clip its own copy of the audio, so edits to it affect no other clip.',
  'clip.editSource': 'Opens the clip\'s source file in the Waveform editor.',
  'clip.bringToFront': 'Puts the clip above the clips it overlaps.',
  'clip.sendToBack': 'Puts the clip below the clips it overlaps.',
  'workspace.reset': 'Puts the panels back as the workspace was saved.',
  'workspace.saveChanges': 'Keeps the current panel layout as this workspace.',
  'view.toggleEditor': 'Switches between the Waveform and Multitrack editors.',
  'analysis.scanAmplitude': 'Measures the peak, RMS and other statistics of the selection.',
  'analysis.scanFrequency': 'Shows the frequency content at the playhead.',
};

/** Third person of a command's first word: "Move" -> "Moves", "Apply" -> "Applies". */
const VERB = /^(Move|Scroll|Select|Switch|Show|Open|Trim|Split|Convert|Apply|Clear|Add|Set|Bring|Send|Scan|Edit|Reveal|Close|Copy|Paste|Repeat|Mute|Solo|Arm|Monitor|Start|Stop|Decrease|Increase|Nudge|Zoom|Play|Silence|Insert|Delete|Remove|Toggle|Normalize|Fade|Rename|Merge|Lock|Loop|Go|Jump|Mark|Save|Export|Import|Restore|Reset)\b\s*(.*)$/;
export function asSentence(label) {
  const m = VERB.exec(plain(label));
  if (!m) return '';
  const verb = m[1];
  const third = /(ch|sh|s|x)$/.test(verb) ? `${verb}es` : /[^aeiou]y$/.test(verb) ? `${verb.slice(0, -1)}ies` : `${verb}s`;
  // Lower case, keeping acronyms ("UMID", "5.1").
  const rest = m[2]
    .split(' ')
    .map((w) => (/^[A-Z0-9.]{2,}$/.test(w) ? w : w.toLowerCase()))
    .join(' ');
  return `${third}${rest ? ` ${rest}` : ''}.`;
}

const effectGroup = (id) => EFFECT_GROUPS.find((g) => g.ids.includes(id))?.label || '';
const plain = (label) => String(label).replace(/\.\.\.$/, '').trim();

/**
 * A one-line description of command `id`. `paths` (commandMenuPaths()) gives the menu it
 * sits in; `label` is its name as the dialog shows it.
 */
export function describeCommand(C, id, { paths = null, label = null } = {}) {
  const cmd = C.commands?.get?.(id) || C.get?.(id);
  if (!cmd) return '';
  if (cmd.description) return cmd.description;
  if (DESCRIPTIONS[id]) return DESCRIPTIONS[id];
  const name = plain(label ?? C.label(id));
  const [prefix, rest = ''] = id.split(/\.(.*)/s);
  if (prefix === 'fx') {
    const def = getEffect(rest);
    if (def?.about) return def.about;
    if (def) {
      const group = effectGroup(rest);
      const what = def.params?.length ? `Opens ${def.name}${group ? ` (${group})` : ''} to preview and apply it` : `Applies ${def.name}${group ? ` (${group})` : ''}`;
      return `${what} to the selection, or to the whole file without one.`;
    }
  }
  if (prefix === 'window') return `Shows or hides the ${name} panel.`;
  if (prefix === 'tool') return `Switches to the ${name} tool.`;
  if (prefix === 'prefs') return `Opens Preferences at the ${name} page.`;
  if (/^workspace\.select\d+$/.test(id)) return `Switches to the ${name.replace(/^Workspace \d+:\s*/, '')} workspace.`;
  const path = paths?.get?.(id)?.filter(Boolean) || [];
  const where = path.length ? ` (${path.join(' > ')})` : '';
  if (cmd.checked) return `Turns ${name} on or off${where}.`;
  if (/\.\.\.$/.test(String(label ?? C.label(id)))) return `Opens the ${name} dialog${where}.`;
  return asSentence(name) || (path.length ? `${path.join(' > ')} > ${name}.` : '');
}
