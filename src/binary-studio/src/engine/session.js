const STORAGE_KEY = 'binary-studio.sessions.v1';

/**
 * Persist analysis annotations (not the whole binary) in localStorage.
 */
export function saveSession(meta) {
  const all = listSessions();
  const id = meta.id || `sess_${Date.now().toString(36)}`;
  const entry = {
    id,
    name: meta.name || 'Untitled',
    format: meta.format,
    arch: meta.arch,
    fileName: meta.fileName || '',
    fileSize: meta.fileSize || 0,
    sha256: meta.sha256 || null,
    annotations: meta.annotations || { symbols: {}, bookmarks: [], comments: {} },
    savedAt: new Date().toISOString(),
  };
  const next = [entry, ...all.filter((s) => s.id !== id)].slice(0, 40);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return entry;
}

export function listSessions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function loadSession(id) {
  return listSessions().find((s) => s.id === id) || null;
}

export function deleteSession(id) {
  const next = listSessions().filter((s) => s.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('SHA-256 requires Web Crypto (crypto.subtle)');
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
