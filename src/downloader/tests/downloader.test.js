import { describe, it, expect, beforeEach } from 'vitest';
import {
  extractFilename,
  detectCategory,
  fmtBytes,
  fmtSpeed,
  fmtDuration,
} from '../src/lib/types.js';
import { Store } from '../src/lib/store.js';

describe('types & formatting helpers', () => {
  describe('extractFilename', () => {
    it('extracts simple filename from URL pathname', () => {
      expect(extractFilename('https://releases.ubuntu.com/24.04/ubuntu-desktop.iso')).toBe('ubuntu-desktop.iso');
      expect(extractFilename('https://example.com/assets/video.mp4')).toBe('video.mp4');
    });

    it('handles URL encoded characters in URL', () => {
      expect(extractFilename('https://example.com/files/My%20Document%20(v2).pdf')).toBe('My Document (v2).pdf');
    });

    it('prioritizes Content-Disposition header when available', () => {
      const cd1 = 'attachment; filename="custom_export.zip"';
      expect(extractFilename('https://example.com/download?id=123', cd1)).toBe('custom_export.zip');

      const cd2 = "attachment; filename*=UTF-8''final_report.xlsx";
      expect(extractFilename('https://example.com/download?id=456', cd2)).toBe('final_report.xlsx');
    });

    it('generates fallback filename when path has no extension', () => {
      const name = extractFilename('https://example.com/api/stream');
      expect(name).toMatch(/^download_\d+$/);
    });
  });

  describe('detectCategory', () => {
    it('correctly maps file extensions to categories', () => {
      expect(detectCategory('movie.mp4')).toBe('video');
      expect(detectCategory('clip.mkv')).toBe('video');
      expect(detectCategory('song.mp3')).toBe('audio');
      expect(detectCategory('podcast.flac')).toBe('audio');
      expect(detectCategory('book.pdf')).toBe('document');
      expect(detectCategory('sheet.xlsx')).toBe('document');
      expect(detectCategory('bundle.zip')).toBe('archive');
      expect(detectCategory('disk.tar.gz')).toBe('archive');
      expect(detectCategory('setup.exe')).toBe('program');
      expect(detectCategory('script.sh')).toBe('program');
      expect(detectCategory('photo.webp')).toBe('image');
      expect(detectCategory('banner.png')).toBe('image');
    });

    it('falls back to document for unknown extensions', () => {
      expect(detectCategory('unknown.xyz')).toBe('document');
      expect(detectCategory('noext')).toBe('document');
    });
  });

  describe('fmtBytes', () => {
    it('formats various byte sizes with correct unit', () => {
      expect(fmtBytes(0)).toBe('0 B');
      expect(fmtBytes(512)).toBe('512 B');
      expect(fmtBytes(1024)).toBe('1.0 KB');
      expect(fmtBytes(1536)).toBe('1.5 KB');
      expect(fmtBytes(1048576)).toBe('1.0 MB');
      expect(fmtBytes(1073741824)).toBe('1.0 GB');
      expect(fmtBytes(-100)).toBe('0 B');
    });
  });

  describe('fmtSpeed', () => {
    it('formats transfer speeds correctly', () => {
      expect(fmtSpeed(0)).toBe('0 KB/s');
      expect(fmtSpeed(500)).toBe('500 B/s');
      expect(fmtSpeed(102400)).toBe('100.0 KB/s');
      expect(fmtSpeed(2097152)).toBe('2.00 MB/s');
    });
  });

  describe('fmtDuration', () => {
    it('formats seconds into mm:ss or hh:mm:ss', () => {
      expect(fmtDuration(0)).toBe('00:00');
      expect(fmtDuration(45)).toBe('00:45');
      expect(fmtDuration(75)).toBe('01:15');
      expect(fmtDuration(3665)).toBe('1:01:05');
      expect(fmtDuration(null)).toBe('--:--');
      expect(fmtDuration(Infinity)).toBe('--:--');
    });
  });
});

describe('Store functionality', () => {
  let store;

  beforeEach(() => {
    store = new Store();
    store.tasks = [];
  });

  it('adds a task with auto-detected attributes', () => {
    const task = store.addTask({
      url: 'https://example.com/files/archive.zip',
    });

    expect(task.id).toBeDefined();
    expect(task.filename).toBe('archive.zip');
    expect(task.category).toBe('archive');
    expect(task.status).toBe('queued');
    expect(task.progress).toBe(0);
    expect(store.tasks.length).toBe(1);
  });

  it('updates task properties and notifies subscribers', () => {
    const task = store.addTask({ url: 'https://example.com/video.mp4' });
    let notified = false;
    store.subscribe(() => { notified = true; });

    const updated = store.updateTask(task.id, {
      status: 'downloading',
      progress: 50,
      receivedBytes: 5000,
      totalBytes: 10000,
      speed: 102400,
    });

    expect(updated.status).toBe('downloading');
    expect(updated.progress).toBe(50);
    expect(notified).toBe(true);
  });

  it('filters tasks by category', () => {
    store.addTask({ url: 'https://example.com/song.mp3' }); // audio
    store.addTask({ url: 'https://example.com/clip.mp4' }); // video
    store.addTask({ url: 'https://example.com/doc.pdf' });  // document

    store.setFilter('video');
    const filtered = store.getFilteredTasks();
    expect(filtered.length).toBe(1);
    expect(filtered[0].category).toBe('video');

    store.setFilter('all');
    expect(store.getFilteredTasks().length).toBe(3);
  });

  it('searches tasks by filename or url', () => {
    store.addTask({ url: 'https://example.com/my-awesome-video.mp4' });
    store.addTask({ url: 'https://example.com/secret_document.pdf' });

    store.setSearch('awesome');
    const results = store.getFilteredTasks();
    expect(results.length).toBe(1);
    expect(results[0].filename).toBe('my-awesome-video.mp4');
  });

  it('calculates aggregate statistics correctly', () => {
    const t1 = store.addTask({ url: 'https://example.com/1.zip' });
    const t2 = store.addTask({ url: 'https://example.com/2.zip' });

    store.updateTask(t1.id, {
      status: 'downloading',
      speed: 200000,
      receivedBytes: 500000,
    });

    store.updateTask(t2.id, {
      status: 'completed',
      speed: 0,
      receivedBytes: 1000000,
    });

    const stats = store.getStats();
    expect(stats.total).toBe(2);
    expect(stats.active).toBe(1);
    expect(stats.completed).toBe(1);
    expect(stats.totalSpeed).toBe(200000);
    expect(stats.downloadedBytes).toBe(1500000);
  });

  it('removes tasks and clears completed tasks', () => {
    const t1 = store.addTask({ url: 'https://example.com/1.zip' });
    const t2 = store.addTask({ url: 'https://example.com/2.zip' });

    store.updateTask(t1.id, { status: 'completed' });
    store.updateTask(t2.id, { status: 'paused' });

    store.clearCompleted();
    expect(store.tasks.length).toBe(1);
    expect(store.tasks[0].id).toBe(t2.id);

    store.removeTask(t2.id);
    expect(store.tasks.length).toBe(0);
  });

  it('handles batch task creation correctly', () => {
    const urls = [
      'https://example.com/file1.zip',
      'https://example.com/file2.mp4',
      '   ',
      'invalid-url',
      'https://example.com/file3.pdf',
    ];

    const tasks = store.addBatchTasks(urls, 'cloud');
    expect(tasks.length).toBe(3);
    expect(tasks[0].filename).toBe('file1.zip');
    expect(tasks[1].filename).toBe('file2.mp4');
    expect(tasks[2].filename).toBe('file3.pdf');
    expect(store.tasks.length).toBe(3);
  });

  it('manages task selection for inspector drawer', () => {
    const t1 = store.addTask({ url: 'https://example.com/item.zip' });
    expect(store.selectedTaskId).toBeNull();

    store.selectTask(t1.id);
    expect(store.selectedTaskId).toBe(t1.id);

    store.removeTask(t1.id);
    expect(store.selectedTaskId).toBeNull();
  });
});
