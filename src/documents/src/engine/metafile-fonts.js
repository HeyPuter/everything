import { fileFontFamily } from './file-fonts.js';
import { loadLocalFace } from './local-font-probe.js';
// Generated metafile SVGs embed explicitly supplied file fonts. Other faces
// still require availability in the isolated image document.
// Probe installed faces without registering an alias or downloading a font.
export async function missingMetafileFonts(groups) {
  if (!groups.length || typeof FontFace === 'undefined') return [];
  const available = new Map();
  const names = [...new Set(groups.flat())];
  const queue = [...names];
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const name = queue.pop();
      if (fileFontFamily(name)) { available.set(name, true); continue; }
      const quoted = JSON.stringify(name);
      try {
        await loadLocalFace('Metafile font probe', `local(${quoted})`);
        available.set(name, true);
      } catch { available.set(name, false); }
    }
  }));
  return [...new Set(groups.filter(group => !group.some(name => available.get(name))).map(group => group[0]))];
}
