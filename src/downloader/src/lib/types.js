/**
 * File category definitions, MIME/extension mapping, and formatting utilities.
 */

export const CATEGORIES = [
  { id: 'all', label: 'All Downloads', icon: 'download' },
  { id: 'active', label: 'Active', icon: 'refresh' },
  { id: 'completed', label: 'Completed', icon: 'checkCircle' },
  { id: 'video', label: 'Videos', icon: 'video' },
  { id: 'audio', label: 'Audio', icon: 'music' },
  { id: 'document', label: 'Documents', icon: 'document' },
  { id: 'archive', label: 'Compressed', icon: 'archive' },
  { id: 'program', label: 'Programs', icon: 'terminal' },
  { id: 'image', label: 'Images', icon: 'image' },
];

export const EXT_CATEGORY_MAP = {
  // Video
  mp4: 'video', mkv: 'video', avi: 'video', webm: 'video', mov: 'video', flv: 'video', wmv: 'video', m4v: 'video',
  // Audio
  mp3: 'audio', wav: 'audio', flac: 'audio', aac: 'audio', ogg: 'audio', m4a: 'audio', wma: 'audio', opus: 'audio',
  // Document
  pdf: 'document', doc: 'document', docx: 'document', txt: 'document', rtf: 'document',
  xls: 'document', xlsx: 'document', ppt: 'document', pptx: 'document', csv: 'document',
  md: 'document', epub: 'document', mobi: 'document',
  // Archive
  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive',
  bz2: 'archive', xz: 'archive', iso: 'archive', tgz: 'archive',
  // Program
  exe: 'program', msi: 'program', dmg: 'program', apk: 'program', deb: 'program',
  rpm: 'program', appimage: 'program', sh: 'program', bat: 'program', bin: 'program',
  // Image
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image',
  avif: 'image', bmp: 'image', ico: 'image', tiff: 'image',
};

/**
 * Infer filename and extension from URL or Content-Disposition header.
 */
export function extractFilename(url, contentDisposition = '') {
  if (contentDisposition) {
    const filenameMatch = contentDisposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
    if (filenameMatch && filenameMatch[1]) {
      return decodeURIComponent(filenameMatch[1].trim());
    }
  }

  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    const segments = pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && last.includes('.')) {
      return decodeURIComponent(last);
    }
  } catch {}

  return `download_${Date.now()}`;
}

/**
 * Determine category from filename extension.
 */
export function detectCategory(filename) {
  if (!filename) return 'document';
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return 'document';
  const ext = filename.slice(dot + 1).toLowerCase();
  return EXT_CATEGORY_MAP[ext] || 'document';
}

/**
 * Format bytes into human readable format (KB, MB, GB).
 */
export function fmtBytes(bytes, decimals = 1) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const val = bytes / Math.pow(k, i);
  return `${val.toFixed(i === 0 ? 0 : decimals)} ${sizes[i]}`;
}

/**
 * Format speed in B/s, KB/s, or MB/s.
 */
export function fmtSpeed(bytesPerSec) {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 KB/s';
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`;
}

/**
 * Format seconds into mm:ss or hh:mm:ss.
 */
export function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds === Infinity) return '--:--';
  const s = Math.floor(seconds);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Pre-configured verified sample files for quick 1-click test downloads.
 */
export const SAMPLE_DOWNLOADS = [
  {
    name: 'Puter Crystal Nebula (4K JPG)',
    url: './samples/puter-crystal-wallpaper.jpg',
    category: 'image',
    size: 700638,
  },
  {
    name: 'Puter Guide (TXT)',
    url: './samples/puter-demo-document.txt',
    category: 'document',
    size: 720,
  },
  {
    name: 'Everything Logo (PNG)',
    url: 'https://raw.githubusercontent.com/HeyPuter/everything/main/assets/everything.png',
    category: 'image',
    size: 32000,
  },
  {
    name: 'Lucide ES Module (JS)',
    url: 'https://cdn.jsdelivr.net/npm/lucide@latest/dist/esm/lucide.js',
    category: 'program',
    size: 51200,
  },
];
