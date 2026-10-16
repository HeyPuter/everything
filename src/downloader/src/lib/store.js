import { extractFilename, detectCategory } from './types.js';

const STORAGE_KEY = 'downloader:state:v1';

export class Store {
  constructor() {
    this.tasks = [];
    this.activeCategory = 'all';
    this.searchQuery = '';
    this.subscribers = new Set();
    this.settings = {
      theme: 'system',
      saveTarget: 'cloud',
      maxConcurrent: 3,
      soundOnComplete: true,
    };

    this.loadState();
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  notify() {
    for (const fn of this.subscribers) {
      try {
        fn(this);
      } catch (e) {
        console.error('Subscriber error:', e);
      }
    }
  }

  addTask(data) {
    const filename = data.filename || extractFilename(data.url);
    const category = data.category || detectCategory(filename);

    const task = {
      id: `dl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      url: data.url,
      filename,
      category,
      totalBytes: data.totalBytes || null,
      receivedBytes: 0,
      progress: 0,
      speed: 0,
      eta: null,
      status: 'queued',
      error: null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      saveTarget: data.saveTarget || this.settings.saveTarget,
      savedPath: null,
    };

    this.tasks.unshift(task);
    this.saveState();
    this.notify();
    return task;
  }

  updateTask(id, patch) {
    const index = this.tasks.findIndex((t) => t.id === id);
    if (index === -1) return null;

    this.tasks[index] = { ...this.tasks[index], ...patch };
    this.saveState();
    this.notify();
    return this.tasks[index];
  }

  removeTask(id) {
    this.tasks = this.tasks.filter((t) => t.id !== id);
    this.saveState();
    this.notify();
  }

  clearCompleted() {
    this.tasks = this.tasks.filter((t) => t.status !== 'completed');
    this.saveState();
    this.notify();
  }

  clearAll() {
    this.tasks = [];
    this.saveState();
    this.notify();
  }

  getTask(id) {
    return this.tasks.find((t) => t.id === id) || null;
  }

  setFilter(category) {
    this.activeCategory = category;
    this.notify();
  }

  setSearch(query) {
    this.searchQuery = query;
    this.notify();
  }

  updateSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    this.saveState();
    this.notify();
  }

  getFilteredTasks() {
    let list = this.tasks;

    if (this.activeCategory === 'active') {
      list = list.filter((t) => t.status === 'downloading' || t.status === 'connecting' || t.status === 'queued');
    } else if (this.activeCategory === 'completed') {
      list = list.filter((t) => t.status === 'completed');
    } else if (this.activeCategory !== 'all') {
      list = list.filter((t) => t.category === this.activeCategory);
    }

    if (this.searchQuery.trim()) {
      const q = this.searchQuery.toLowerCase().trim();
      list = list.filter((t) =>
        t.filename.toLowerCase().includes(q) ||
        t.url.toLowerCase().includes(q)
      );
    }

    return list;
  }

  getStats() {
    const total = this.tasks.length;
    const active = this.tasks.filter((t) => t.status === 'downloading' || t.status === 'connecting').length;
    const completed = this.tasks.filter((t) => t.status === 'completed').length;
    const totalSpeed = this.tasks.reduce((sum, t) => sum + (t.speed || 0), 0);
    const downloadedBytes = this.tasks.reduce((sum, t) => sum + (t.receivedBytes || 0), 0);

    return {
      total,
      active,
      completed,
      totalSpeed,
      downloadedBytes,
    };
  }

  async loadState() {
    try {
      if (typeof puter !== 'undefined' && puter.kv) {
        const cloudData = await puter.kv.get(STORAGE_KEY);
        if (cloudData) {
          const parsed = typeof cloudData === 'string' ? JSON.parse(cloudData) : cloudData;
          if (parsed && Array.isArray(parsed.tasks)) {
            this.tasks = parsed.tasks;
            if (parsed.settings) this.settings = { ...this.settings, ...parsed.settings };
            this.notify();
            return;
          }
        }
      }
    } catch {}

    // Fallback to localStorage
    try {
      const local = localStorage.getItem(STORAGE_KEY);
      if (local) {
        const parsed = JSON.parse(local);
        if (parsed && Array.isArray(parsed.tasks)) {
          this.tasks = parsed.tasks;
          if (parsed.settings) this.settings = { ...this.settings, ...parsed.settings };
          this.notify();
        }
      }
    } catch {}
  }

  async saveState() {
    const payload = {
      tasks: this.tasks.map((t) => ({
        ...t,
        speed: 0,
        eta: null,
        status: t.status === 'downloading' ? 'paused' : t.status,
      })),
      settings: this.settings,
    };

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {}

    try {
      if (typeof puter !== 'undefined' && puter.kv) {
        await puter.kv.set(STORAGE_KEY, payload);
      }
    } catch {}
  }
}
