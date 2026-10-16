import './styles/tokens.css';
import './styles/app.css';

import { Store } from './lib/store.js';
import { DownloadEngine } from './lib/downloader.js';
import { CATEGORIES, SAMPLE_DOWNLOADS, fmtBytes, fmtSpeed, fmtDuration } from './lib/types.js';
import { icon } from './ui/icons.js';

// Initialize core store and engine
const store = new Store();
const engine = new DownloadEngine(store);

// UI State
let activeModal = null; // 'new-task' | 'settings' | null
let probeResult = null;
let probing = false;

// Toast helper
function showToast(message, type = 'info') {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = 'toast';
  const iconName = type === 'success' ? 'checkCircle' : type === 'error' ? 'alert' : 'zap';
  toast.innerHTML = `
    <span style="color: ${type === 'success' ? 'var(--accent-green)' : type === 'error' ? 'var(--accent-red)' : 'var(--accent-cyan)'}">
      ${icon(iconName, 18)}
    </span>
    <span>${message}</span>
  `;

  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 200ms ease';
    setTimeout(() => toast.remove(), 250);
  }, 3500);
}

// Theme helper
function applyTheme(theme) {
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
  localStorage.setItem('downloader:theme', theme);
}

// Main Render Function
function render() {
  const root = document.getElementById('app');
  if (!root) return;

  const stats = store.getStats();
  const tasks = store.getFilteredTasks();
  const activeCategory = store.activeCategory;

  root.innerHTML = `
    <!-- Header -->
    <header class="app-header">
      <div class="brand">
        <img src="./icon-128.png" alt="Downloader" class="brand-icon" />
        <span class="brand-title">Downloader</span>
        <span class="brand-badge">v1.0</span>
      </div>

      <div class="header-center">
        <div class="live-speed-pill" title="Aggregate download bandwidth">
          <span class="pulse-dot"></span>
          <span>${fmtSpeed(stats.totalSpeed)}</span>
          ${stats.active > 0 ? `<span style="opacity: 0.6; font-size: 11px;">(${stats.active} active)</span>` : ''}
        </div>
      </div>

      <div class="header-actions">
        <button class="btn btn-primary" id="btn-open-new">
          ${icon('plus', 16)}
          <span>New Download</span>
        </button>
        <button class="icon-btn" id="btn-toggle-theme" title="Toggle Dark/Light Mode">
          ${icon(document.documentElement.dataset.theme === 'light' ? 'moon' : 'sun', 18)}
        </button>
        <button class="icon-btn" id="btn-open-settings" title="Settings">
          ${icon('settings', 18)}
        </button>
      </div>
    </header>

    <!-- App Body: Sidebar + Main -->
    <div class="app-body">
      <!-- Sidebar -->
      <aside class="sidebar">
        <div class="sidebar-title">Categories</div>
        ${CATEGORIES.map((cat) => {
          let count = 0;
          if (cat.id === 'all') count = store.tasks.length;
          else if (cat.id === 'active') count = stats.active;
          else if (cat.id === 'completed') count = stats.completed;
          else count = store.tasks.filter((t) => t.category === cat.id).length;

          const isActive = activeCategory === cat.id;
          return `
            <div class="nav-item ${isActive ? 'active' : ''}" data-cat="${cat.id}">
              <div class="nav-item-left">
                ${icon(cat.icon, 16)}
                <span>${cat.label}</span>
              </div>
              <span class="nav-badge">${count}</span>
            </div>
          `;
        }).join('')}

        <!-- Storage Info Card -->
        <div class="storage-card">
          <div class="storage-header">
            ${icon(store.settings.saveTarget === 'cloud' ? 'cloud' : 'hardDrive', 16)}
            <span>Puter Cloud OS</span>
          </div>
          <div class="storage-sub">
            Target: <strong>${store.settings.saveTarget === 'cloud' ? '/Downloads/' : 'Local Device'}</strong>
          </div>
          <div class="storage-sub">
            Total fetched: <strong>${fmtBytes(stats.downloadedBytes)}</strong>
          </div>
        </div>
      </aside>

      <!-- Main View -->
      <main class="main-view">
        <!-- Toolbar -->
        <div class="toolbar">
          <div class="search-box">
            ${icon('search', 16)}
            <input type="text" id="search-input" placeholder="Search files or URLs..." value="${store.searchQuery}" />
            ${store.searchQuery ? `<button class="icon-btn" id="btn-clear-search" style="padding: 2px;">${icon('x', 14)}</button>` : ''}
          </div>

          <div class="toolbar-stats">
            <span class="stat-chip">${icon('download', 14)} ${stats.total} total</span>
            <span class="stat-chip">${icon('checkCircle', 14)} ${stats.completed} done</span>
            ${stats.completed > 0 ? `
              <button class="btn btn-secondary" id="btn-clear-completed" style="padding: 6px 12px; font-size: 12px;">
                ${icon('trash', 14)} Clear Completed
              </button>
            ` : ''}
          </div>
        </div>

        <!-- Task List / Empty State -->
        <div class="content-scroll">
          ${tasks.length === 0 ? renderEmptyState() : tasks.map((t) => renderTaskCard(t)).join('')}
        </div>
      </main>
    </div>

    <!-- Modals Container -->
    ${activeModal === 'new-task' ? renderNewTaskModal() : ''}
    ${activeModal === 'settings' ? renderSettingsModal() : ''}
  `;

  bindEvents(root);
}

// Render Empty State with Sample Downloads
function renderEmptyState() {
  return `
    <div class="empty-state">
      <div class="empty-icon-wrap">
        ${icon('arrowDown', 36)}
      </div>
      <div class="empty-title">No downloads in this view</div>
      <div class="empty-sub">
        Paste a direct download link, click <strong>New Download</strong> above, or choose a quick sample file below to test the download manager.
      </div>

      <div class="sample-downloads-grid">
        ${SAMPLE_DOWNLOADS.map((sample) => `
          <div class="sample-card" data-sample-url="${sample.url}" data-sample-name="${sample.name}" data-sample-cat="${sample.category}">
            <div class="sample-card-left">
              <div class="task-icon-badge badge-${sample.category}">
                ${icon(sample.category === 'video' ? 'video' : sample.category === 'audio' ? 'music' : sample.category === 'image' ? 'image' : 'document', 20)}
              </div>
              <div style="text-align: left;">
                <div style="font-size: 13px; font-weight: 600;">${sample.name}</div>
                <div style="font-size: 11.5px; color: var(--text-muted);">${fmtBytes(sample.size)} · Direct Link</div>
              </div>
            </div>
            <button class="btn btn-secondary" style="padding: 6px 12px; font-size: 12px;">
              ${icon('download', 14)} Fetch
            </button>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

// Render Task Card
function renderTaskCard(task) {
  const isDownloading = task.status === 'downloading';
  const isCompleted = task.status === 'completed';
  const isPaused = task.status === 'paused';
  const isError = task.status === 'error';

  let statusClass = 'status-connecting';
  if (isDownloading) statusClass = 'status-downloading';
  else if (isCompleted) statusClass = 'status-completed';
  else if (isPaused) statusClass = 'status-paused';
  else if (isError) statusClass = 'status-error';

  const catIcon = task.category === 'video' ? 'video'
    : task.category === 'audio' ? 'music'
    : task.category === 'image' ? 'image'
    : task.category === 'archive' ? 'archive'
    : task.category === 'program' ? 'terminal'
    : 'document';

  return `
    <div class="task-card ${isDownloading ? 'downloading' : ''}" data-id="${task.id}">
      <div class="task-icon-badge badge-${task.category}">
        ${icon(catIcon, 22)}
      </div>

      <div class="task-info">
        <div class="task-header">
          <span class="task-filename" title="${task.filename}">${task.filename}</span>
          <span class="task-status-tag ${statusClass}">
            ${task.status}
          </span>
        </div>

        <!-- Progress Bar -->
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" style="width: ${task.progress}%;"></div>
        </div>

        <div class="task-meta">
          <div class="task-meta-left">
            <span>${fmtBytes(task.receivedBytes)} / ${task.totalBytes ? fmtBytes(task.totalBytes) : 'Unknown size'}</span>
            <span>(${task.progress}%)</span>
            ${isDownloading ? `<span>· ${fmtSpeed(task.speed)}</span>` : ''}
            ${isDownloading && task.eta !== null ? `<span>· ETA ${fmtDuration(task.eta)}</span>` : ''}
          </div>

          <div class="task-meta-right">
            ${task.savedPath ? `<span title="Saved in Puter Cloud" style="color: var(--accent-cyan); font-size: 11px;">☁ ${task.savedPath}</span>` : ''}
          </div>
        </div>

        ${isError && task.error ? `
          <div style="font-size: 11.5px; color: var(--accent-red); display: flex; align-items: center; gap: 4px;">
            ${icon('alert', 12)} ${task.error}
          </div>
        ` : ''}
      </div>

      <!-- Actions -->
      <div class="task-actions">
        ${isDownloading ? `
          <button class="icon-btn btn-pause" data-id="${task.id}" title="Pause">
            ${icon('pause', 16)}
          </button>
        ` : ''}

        ${isPaused ? `
          <button class="icon-btn btn-resume" data-id="${task.id}" title="Resume">
            ${icon('play', 16)}
          </button>
        ` : ''}

        ${isError ? `
          <button class="icon-btn btn-retry" data-id="${task.id}" title="Retry">
            ${icon('refresh', 16)}
          </button>
          <button class="icon-btn btn-save-device" data-id="${task.id}" title="Open or download directly in browser">
            ${icon('external', 16)}
          </button>
        ` : ''}

        ${isCompleted ? `
          <button class="icon-btn btn-save-device" data-id="${task.id}" title="Save to computer (browser download)">
            ${icon('hardDrive', 16)}
          </button>
        ` : ''}

        <button class="icon-btn btn-delete" data-id="${task.id}" title="Remove download">
          ${icon('trash', 16)}
        </button>
      </div>
    </div>
  `;
}

// Render New Task Modal
function renderNewTaskModal() {
  return `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal-box">
        <div class="modal-header">
          <div class="modal-title" style="display: flex; align-items: center; gap: 8px;">
            ${icon('download', 18)}
            <span>Add New Download</span>
          </div>
          <button class="icon-btn" id="modal-close">${icon('x', 18)}</button>
        </div>

        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Download URL (Direct HTTP / HTTPS / Blob)</label>
            <div style="display: flex; gap: 8px;">
              <input type="url" id="new-url-input" class="input-text" placeholder="https://example.com/file.zip" style="flex: 1;" autofocus />
              <button class="btn btn-secondary" id="btn-probe" style="padding: 0 14px;" ${probing ? 'disabled' : ''}>
                ${probing ? icon('refresh', 14) : icon('zap', 14)}
                <span>${probing ? 'Probing...' : 'Inspect'}</span>
              </button>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">Save As Filename (Optional)</label>
            <input type="text" id="new-filename-input" class="input-text" placeholder="Auto-detected from URL" />
          </div>

          ${probeResult ? `
            <div style="background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: 12px; font-size: 12.5px; display: flex; flex-direction: column; gap: 4px;">
              <div style="display: flex; justify-content: space-between;">
                <span style="color: var(--text-muted);">Detected Filename:</span>
                <strong>${probeResult.filename}</strong>
              </div>
              <div style="display: flex; justify-content: space-between;">
                <span style="color: var(--text-muted);">Content Size:</span>
                <strong>${probeResult.totalBytes ? fmtBytes(probeResult.totalBytes) : 'Stream / Unknown'}</strong>
              </div>
              <div style="display: flex; justify-content: space-between;">
                <span style="color: var(--text-muted);">Category:</span>
                <span style="text-transform: capitalize;">${probeResult.category}</span>
              </div>
            </div>
          ` : ''}

          <div class="form-group">
            <label class="form-label">Storage Target</label>
            <div style="display: flex; gap: 16px; font-size: 13px;">
              <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
                <input type="radio" name="saveTarget" value="cloud" ${store.settings.saveTarget === 'cloud' ? 'checked' : ''} />
                <span>Puter Cloud OS (/Downloads)</span>
              </label>
              <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
                <input type="radio" name="saveTarget" value="device" ${store.settings.saveTarget === 'device' ? 'checked' : ''} />
                <span>Local Computer</span>
              </label>
            </div>
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn btn-secondary" id="modal-cancel">Cancel</button>
          <button class="btn btn-primary" id="btn-submit-download">
            ${icon('download', 16)} Start Download
          </button>
        </div>
      </div>
    </div>
  `;
}

// Render Settings Modal
function renderSettingsModal() {
  const currentTheme = document.documentElement.dataset.theme || 'system';

  return `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal-box">
        <div class="modal-header">
          <div class="modal-title" style="display: flex; align-items: center; gap: 8px;">
            ${icon('settings', 18)}
            <span>Downloader Settings</span>
          </div>
          <button class="icon-btn" id="modal-close">${icon('x', 18)}</button>
        </div>

        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Appearance & Theme</label>
            <div style="display: flex; gap: 10px;">
              <button class="btn ${currentTheme === 'dark' ? 'btn-primary' : 'btn-secondary'} btn-theme-choice" data-theme="dark" style="flex: 1;">
                ${icon('moon', 14)} Dark
              </button>
              <button class="btn ${currentTheme === 'light' ? 'btn-primary' : 'btn-secondary'} btn-theme-choice" data-theme="light" style="flex: 1;">
                ${icon('sun', 14)} Light
              </button>
              <button class="btn ${currentTheme === 'system' ? 'btn-primary' : 'btn-secondary'} btn-theme-choice" data-theme="system" style="flex: 1;">
                ${icon('monitor', 14)} System
              </button>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">Default Download Storage</label>
            <div style="display: flex; gap: 16px; font-size: 13px;">
              <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
                <input type="radio" name="defaultSaveTarget" value="cloud" ${store.settings.saveTarget === 'cloud' ? 'checked' : ''} />
                <span>Puter Cloud (/Downloads)</span>
              </label>
              <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
                <input type="radio" name="defaultSaveTarget" value="device" ${store.settings.saveTarget === 'device' ? 'checked' : ''} />
                <span>Local Computer</span>
              </label>
            </div>
          </div>

          <div class="form-group" style="margin-top: 10px; padding-top: 12px; border-top: 1px solid var(--border-subtle);">
            <label class="form-label">Data & History</label>
            <button class="btn btn-secondary" id="btn-clear-all-data" style="color: var(--accent-red); border-color: rgba(214, 48, 49, 0.3);">
              ${icon('trash', 14)} Clear All Downloads & History
            </button>
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn btn-primary" id="modal-close-btn">Done</button>
        </div>
      </div>
    </div>
  `;
}

// Bind DOM Events
function bindEvents(root) {
  // Navigation / Filter
  root.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      const cat = item.dataset.cat;
      store.setFilter(cat);
    });
  });

  // Search
  const searchInput = root.querySelector('#search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      store.setSearch(e.target.value);
    });
  }

  const btnClearSearch = root.querySelector('#btn-clear-search');
  if (btnClearSearch) {
    btnClearSearch.addEventListener('click', () => {
      store.setSearch('');
    });
  }

  // Clear completed
  const btnClearCompleted = root.querySelector('#btn-clear-completed');
  if (btnClearCompleted) {
    btnClearCompleted.addEventListener('click', () => {
      store.clearCompleted();
      showToast('Completed downloads cleared from list', 'info');
    });
  }

  // Theme Toggle Button in Header
  const btnTheme = root.querySelector('#btn-toggle-theme');
  if (btnTheme) {
    btnTheme.addEventListener('click', () => {
      const current = document.documentElement.dataset.theme;
      const next = current === 'light' ? 'dark' : 'light';
      applyTheme(next);
      render();
    });
  }

  // Open New Download Modal
  const btnOpenNew = root.querySelector('#btn-open-new');
  if (btnOpenNew) {
    btnOpenNew.addEventListener('click', () => {
      activeModal = 'new-task';
      probeResult = null;
      render();
    });
  }

  // Open Settings Modal
  const btnOpenSettings = root.querySelector('#btn-open-settings');
  if (btnOpenSettings) {
    btnOpenSettings.addEventListener('click', () => {
      activeModal = 'settings';
      render();
    });
  }

  // Task Actions
  root.querySelectorAll('.btn-pause').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      engine.pause(id);
      showToast('Download paused', 'info');
    });
  });

  root.querySelectorAll('.btn-resume').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      engine.resume(id);
      showToast('Download resumed', 'info');
    });
  });

  root.querySelectorAll('.btn-retry').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      engine.retry(id);
      showToast('Retrying download...', 'info');
    });
  });

  root.querySelectorAll('.btn-save-device').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      engine.saveToDevice(id);
      showToast('Saving to local device...', 'success');
    });
  });

  root.querySelectorAll('.btn-delete').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      engine.cancel(id);
      store.removeTask(id);
      showToast('Download removed', 'info');
    });
  });

  // Sample Download 1-Click Cards
  root.querySelectorAll('.sample-card').forEach((card) => {
    card.addEventListener('click', () => {
      const url = card.dataset.sampleUrl;
      const filename = card.dataset.sampleName;
      const category = card.dataset.sampleCat;

      const task = store.addTask({
        url,
        filename,
        category,
        saveTarget: store.settings.saveTarget,
      });

      engine.start(task);
      showToast(`Started downloading ${filename}`, 'success');
    });
  });

  // Modal Handlers
  const modalOverlay = root.querySelector('#modal-overlay');
  if (modalOverlay) {
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) {
        activeModal = null;
        probeResult = null;
        render();
      }
    });

    const closeBtns = root.querySelectorAll('#modal-close, #modal-cancel, #modal-close-btn');
    closeBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        activeModal = null;
        probeResult = null;
        render();
      });
    });

    // Probe URL button
    const btnProbe = root.querySelector('#btn-probe');
    const urlInput = root.querySelector('#new-url-input');
    const filenameInput = root.querySelector('#new-filename-input');

    if (btnProbe && urlInput) {
      btnProbe.addEventListener('click', async () => {
        const url = urlInput.value.trim();
        if (!url) {
          showToast('Please enter a valid URL first', 'error');
          return;
        }

        probing = true;
        render();

        try {
          const res = await engine.probeUrl(url);
          probeResult = res;
          if (filenameInput && !filenameInput.value) {
            filenameInput.value = res.filename;
          }
          showToast('URL inspected successfully', 'success');
        } catch (e) {
          showToast('Could not probe URL', 'error');
        } finally {
          probing = false;
          render();
        }
      });
    }

    // Submit new download
    const btnSubmit = root.querySelector('#btn-submit-download');
    if (btnSubmit && urlInput) {
      btnSubmit.addEventListener('click', () => {
        const url = urlInput.value.trim();
        if (!url) {
          showToast('URL is required', 'error');
          return;
        }

        const customFilename = filenameInput ? filenameInput.value.trim() : '';
        const targetRadio = root.querySelector('input[name="saveTarget"]:checked');
        const saveTarget = targetRadio ? targetRadio.value : store.settings.saveTarget;

        const task = store.addTask({
          url,
          filename: customFilename || (probeResult && probeResult.filename) || undefined,
          totalBytes: (probeResult && probeResult.totalBytes) || undefined,
          saveTarget,
        });

        activeModal = null;
        probeResult = null;
        engine.start(task);
        showToast(`Starting download: ${task.filename}`, 'success');
      });
    }

    // Settings Theme choices
    root.querySelectorAll('.btn-theme-choice').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.theme;
        applyTheme(t);
        store.updateSettings({ theme: t });
        render();
      });
    });

    // Settings save target radio
    root.querySelectorAll('input[name="defaultSaveTarget"]').forEach((radio) => {
      radio.addEventListener('change', (e) => {
        store.updateSettings({ saveTarget: e.target.value });
        showToast('Default storage updated', 'info');
      });
    });

    // Clear all history
    const btnClearAll = root.querySelector('#btn-clear-all-data');
    if (btnClearAll) {
      btnClearAll.addEventListener('click', () => {
        if (confirm('Are you sure you want to clear all download history?')) {
          store.clearAll();
          activeModal = null;
          showToast('All downloads cleared', 'info');
        }
      });
    }
  }
}

// Subscribe to store updates
store.subscribe(() => {
  render();
});

// Initial render
render();
