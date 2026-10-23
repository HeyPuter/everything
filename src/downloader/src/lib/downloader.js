import { extractFilename, detectCategory } from './types.js';
import { playDownloadCompleteChime } from './sound.js';

export class DownloadEngine {
  constructor(store) {
    this.store = store;
    this.activeControllers = new Map(); // id -> AbortController
    this.activeBlobs = new Map(); // id -> Blob
  }

  async probeUrl(url) {
    try {
      const resp = await fetch(url, { method: 'HEAD' });
      const lengthHeader = resp.headers.get('content-length');
      const dispHeader = resp.headers.get('content-disposition');
      const typeHeader = resp.headers.get('content-type') || '';

      const totalBytes = lengthHeader ? parseInt(lengthHeader, 10) : null;
      const filename = extractFilename(url, dispHeader);
      const category = detectCategory(filename);

      return {
        ok: true,
        filename,
        totalBytes,
        category,
        contentType: typeHeader,
      };
    } catch {
      // Fallback if HEAD is rejected by CORS
      const filename = extractFilename(url);
      return {
        ok: true,
        filename,
        totalBytes: null,
        category: detectCategory(filename),
        contentType: '',
      };
    }
  }

  async start(task) {
    if (this.activeControllers.has(task.id)) {
      return;
    }

    const controller = new AbortController();
    this.activeControllers.set(task.id, controller);

    const startTime = Date.now();

    this.store.updateTask(task.id, {
      status: 'connecting',
      error: null,
      speed: 0,
      startedAt: task.startedAt || startTime,
    });

    try {
      const response = await fetch(task.url, {
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const lengthHeader = response.headers.get('content-length');
      const totalBytes = lengthHeader ? parseInt(lengthHeader, 10) : task.totalBytes;
      const dispHeader = response.headers.get('content-disposition');
      const resolvedName = task.filename || extractFilename(task.url, dispHeader);
      const category = detectCategory(resolvedName);

      this.store.updateTask(task.id, {
        status: 'downloading',
        filename: resolvedName,
        category,
        totalBytes,
      });

      const reader = response.body.getReader();
      const chunks = [];
      let receivedBytes = 0;
      let lastTime = performance.now();
      let lastBytes = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        chunks.push(value);
        receivedBytes += value.length;

        const now = performance.now();
        const elapsed = (now - lastTime) / 1000;

        let speed = task.speed || 0;
        let eta = null;

        if (elapsed >= 0.5) {
          const deltaBytes = receivedBytes - lastBytes;
          speed = Math.round(deltaBytes / elapsed);
          lastTime = now;
          lastBytes = receivedBytes;

          if (totalBytes && speed > 0) {
            const remaining = totalBytes - receivedBytes;
            eta = Math.max(0, Math.round(remaining / speed));
          }
        }

        const progress = totalBytes ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : 0;

        this.store.updateTask(task.id, {
          receivedBytes,
          progress,
          speed,
          eta,
        });
      }

      // Download complete
      const finishTime = Date.now();
      const elapsedSeconds = Math.max(0.1, (finishTime - startTime) / 1000);
      const avgSpeed = Math.round(receivedBytes / elapsedSeconds);

      const mime = response.headers.get('content-type') || 'application/octet-stream';
      const blob = new Blob(chunks, { type: mime });
      this.activeBlobs.set(task.id, blob);

      let savedPath = null;

      // Save to Puter Cloud filesystem if Puter is active and cloud is target
      const target = task.saveTarget || this.store.settings.saveTarget;
      if (target === 'cloud' && typeof puter !== 'undefined' && puter.fs) {
        try {
          await puter.fs.mkdir('/Downloads').catch(() => {});
          const cloudPath = `/Downloads/${resolvedName}`;
          await puter.fs.write(cloudPath, blob);
          savedPath = cloudPath;
        } catch (fsErr) {
          console.warn('Puter FS write skipped or failed:', fsErr);
        }
      }

      this.activeControllers.delete(task.id);
      this.store.updateTask(task.id, {
        status: 'completed',
        progress: 100,
        receivedBytes,
        totalBytes: totalBytes || receivedBytes,
        speed: 0,
        avgSpeed,
        elapsedSeconds: Math.round(elapsedSeconds),
        eta: 0,
        completedAt: finishTime,
        savedPath,
      });

      // Play completion chime if enabled
      if (this.store.settings.soundEnabled) {
        playDownloadCompleteChime();
      }

    } catch (err) {
      this.activeControllers.delete(task.id);
      if (err.name === 'AbortError') {
        // Paused or cancelled intentionally
        return;
      }
      let errMsg = err.message || 'Download failed';
      if (errMsg.includes('Failed to fetch') || errMsg.includes('NetworkError')) {
        errMsg = 'CORS/Network restricted (click external icon to download directly)';
      }
      this.store.updateTask(task.id, {
        status: 'error',
        error: errMsg,
        speed: 0,
      });
    }
  }

  pause(id) {
    const controller = this.activeControllers.get(id);
    if (controller) {
      controller.abort();
      this.activeControllers.delete(id);
    }
    this.store.updateTask(id, {
      status: 'paused',
      speed: 0,
      eta: null,
    });
  }

  resume(id) {
    const task = this.store.getTask(id);
    if (task) {
      this.start(task);
    }
  }

  cancel(id) {
    const controller = this.activeControllers.get(id);
    if (controller) {
      controller.abort();
      this.activeControllers.delete(id);
    }
    this.store.updateTask(id, {
      status: 'cancelled',
      speed: 0,
      eta: null,
    });
  }

  retry(id) {
    const task = this.store.getTask(id);
    if (task) {
      this.store.updateTask(id, {
        receivedBytes: 0,
        progress: 0,
        status: 'queued',
        error: null,
      });
      this.start(this.store.getTask(id));
    }
  }

  saveToDevice(id) {
    const task = this.store.getTask(id);
    if (!task) return;

    const blob = this.activeBlobs.get(id);
    if (blob) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = task.filename || 'download';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } else {
      // Trigger download via direct link
      const a = document.createElement('a');
      a.href = task.url;
      a.download = task.filename || 'download';
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }

  getBlob(id) {
    return this.activeBlobs.get(id) || null;
  }
}
