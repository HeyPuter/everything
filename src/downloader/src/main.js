import './styles/tokens.css';
import './styles/app.css';

import { Store } from './lib/store.js';
import { DownloadEngine } from './lib/downloader.js';
import { CATEGORIES, SAMPLE_DOWNLOADS, fmtBytes, fmtSpeed, fmtDuration } from './lib/types.js';
import { icon } from './ui/icons.js';
import { auth } from './lib/auth.js';
import { BandwidthGraph } from './ui/graph.js';

// Core store and engine instances
const store = new Store();
const engine = new DownloadEngine(store);

// UI State
let activeModal = null; // 'new-task' | 'settings' | null
let modalTab = 'single'; // 'single' | 'batch'
let probeResult = null;
let probing = false;
let userDropdownOpen = false;
let bandwidthGraph = null;
let isDraggingOver = false;

// Register Service Worker in production
if ('serviceWorker' in navigator && window.location.protocol.startsWith('http') && !window.location.hostname.includes('localhost')) {
  navigator.serviceWorker.register('./sw.js').catch((err) => {
    console.debug('ServiceWorker registration skipped:', err);
  });
}

// Toast notification helper
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
  const selectedTask = store.selectedTaskId ? store.getTask(store.selectedTaskId) : null;

  root.innerHTML = `
    <!-- Header -->
    <header class="app-header">
      <div class="brand">
        <img src="./icon-128.png" alt="Downloader" class="brand-icon" />
        <span class="brand-title">Downloader</span>
        <span class="brand-badge">v1.1</span>
      </div>

      <div class="header-center">
        <!-- Live Speed Pill + Sparkline Canvas -->
        <div class="bandwidth-graph-wrap" title="Live download bandwidth history">
          <canvas class="bandwidth-canvas" id="bandwidth-canvas" width="100" height="26"></canvas>
          <div class="live-speed-pill" style="border: none; background: transparent; padding: 0;">
            <span class="pulse-dot"></span>
            <span>${fmtSpeed(stats.totalSpeed)}</span>
            ${stats.active > 0 ? `<span style="opacity: 0.6; font-size: 11px;">(${stats.active})</span>` : ''}
          </div>
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

        <!-- Puter User Profile / Sign-in -->
        <div class="user-menu-wrap">
          ${auth.signedIn && auth.user ? `
            <button class="user-btn" id="btn-user-menu">
              <span class="user-avatar">${(auth.user.username || 'U')[0].toUpperCase()}</span>
              <span>${auth.user.username || 'Puter User'}</span>
            </button>
            ${userDropdownOpen ? `
              <div class="user-dropdown">
                <div class="user-dropdown-header">
                  <div class="user-dropdown-name">${auth.user.username}</div>
                  <div class="user-dropdown-sub">Puter Cloud Connected</div>
                </div>
                <button class="dropdown-item" id="btn-open-cloud-files">
                  ${icon('cloud', 15)} Open /Downloads
                </button>
                <button class="dropdown-item" id="btn-sign-out" style="color: var(--accent-red);">
                  ${icon('logOut', 15)} Sign Out
                </button>
              </div>
            ` : ''}
          ` : `
            <button class="btn btn-secondary" id="btn-sign-in" style="padding: 6px 12px; font-size: 12.5px;">
              ${icon('cloud', 14)} Sign in with Puter
            </button>
          `}
        </div>
      </div>
    </header>

    <!-- App Body: Sidebar + Main Content -->
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

        <!-- Storage Card -->
        <div class="storage-card">
          <div class="storage-header">
            ${icon(store.settings.saveTarget === 'cloud' ? 'cloud' : 'hardDrive', 16)}
            <span>Puter Cloud Storage</span>
          </div>
          <div class="storage-sub">
            Location: <strong>${store.settings.saveTarget === 'cloud' ? '/Downloads/' : 'Local Device'}</strong>
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
            <input type="text" id="search-input" placeholder="Search downloads (Press / to focus)..." value="${store.searchQuery}" />
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

        <!-- Task List or Empty State -->
        <div class="content-scroll">
          ${tasks.length === 0 ? renderEmptyState() : tasks.map((t) => renderTaskCard(t, t.id === store.selectedTaskId)).join('')}
        </div>
      </main>

      <!-- Task Detail Drawer / Inspector -->
      ${selectedTask ? renderTaskDrawer(selectedTask) : ''}
    </div>

    <!-- Modals -->
    ${activeModal === 'new-task' ? renderNewTaskModal() : ''}
    ${activeModal === 'settings' ? renderSettingsModal() : ''}

    <!-- Drag & Drop Overlay -->
    ${isDraggingOver ? `
      <div class="drag-overlay">
        <div class="drag-box">
          <div style="margin-bottom: 8px;">${icon('arrowDown', 48)}</div>
          <div style="font-size: 18px; font-weight: 700;">Drop URL to Download</div>
          <div style="font-size: 13px; opacity: 0.8; margin-top: 4px;">Release link anywhere to start fetching</div>
        </div>
      </div>
    ` : ''}
  `;

  bindEvents(root);

  // Initialize and update Bandwidth Canvas Graph
  const canvas = root.querySelector('#bandwidth-canvas');
  if (canvas) {
    if (!bandwidthGraph) {
      bandwidthGraph = new BandwidthGraph(canvas);
    } else {
      bandwidthGraph.canvas = canvas;
      bandwidthGraph.ctx = canvas.getContext('2d');
    }
    bandwidthGraph.push(stats.totalSpeed);
  }
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
        Paste a direct link, click <strong>New Download</strong>, drag-and-drop a link, or choose a quick sample file below to test.
      </div>

      <div class="sample-downloads-grid">
        ${SAMPLE_DOWNLOADS.map((sample) => `
          <div class="sample-card" data-sample-url="${sample.url}" data-sample-name="${sample.name}" data-sample-cat="${sample.category}">
            <div class="sample-card-left">
              <div class="task-icon-badge badge-${sample.category}">
                ${icon(sample.category === 'video' ? 'video' : sample.category === 'audio' ? 'music' : sample.category === 'image' ? 'image' : sample.category === 'program' ? 'terminal' : 'document', 20)}
              </div>
              <div style="text-align: left;">
                <div style="font-size: 13px; font-weight: 600;">${sample.name}</div>
                <div style="font-size: 11.5px; color: var(--text-muted);">${fmtBytes(sample.size)} · Sample Resource</div>
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
function renderTaskCard(task, isSelected) {
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
    <div class="task-card ${isDownloading ? 'downloading' : ''} ${isSelected ? 'selected' : ''}" data-id="${task.id}" style="${isSelected ? 'border-color: var(--primary); box-shadow: var(--shadow-glow);' : ''} cursor: pointer;">
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
            <span>${fmtBytes(task.receivedBytes)} / ${task.totalBytes ? fmtBytes(task.totalBytes) : 'Stream size'}</span>
            <span>(${task.progress}%)</span>
            ${isDownloading ? `<span>· ${fmtSpeed(task.speed)}</span>` : ''}
            ${isDownloading && task.eta !== null ? `<span>· ETA ${fmtDuration(task.eta)}</span>` : ''}
          </div>

          <div class="task-meta-right">
            ${task.savedPath ? `<span title="Stored in Puter Cloud" style="color: var(--accent-cyan); font-size: 11px;">☁ ${task.savedPath}</span>` : ''}
          </div>
        </div>

        ${isError && task.error ? `
          <div style="font-size: 11.5px; color: var(--accent-red); display: flex; align-items: center; gap: 4px;">
            ${icon('alert', 12)} ${task.error}
          </div>
        ` : ''}
      </div>

      <!-- Actions -->
      <div class="task-actions" onclick="event.stopPropagation();">
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
          <button class="icon-btn btn-save-device" data-id="${task.id}" title="Download directly in browser">
            ${icon('external', 16)}
          </button>
        ` : ''}

        ${isCompleted ? `
          <button class="icon-btn btn-save-device" data-id="${task.id}" title="Save to computer">
            ${icon('hardDrive', 16)}
          </button>
        ` : ''}

        <button class="icon-btn btn-inspect" data-id="${task.id}" title="Inspect Details">
          ${icon('info', 16)}
        </button>

        <button class="icon-btn btn-delete" data-id="${task.id}" title="Remove">
          ${icon('trash', 16)}
        </button>
      </div>
    </div>
  `;
}

// Render Inspector Detail Drawer
function renderTaskDrawer(task) {
  return `
    <aside class="task-drawer">
      <div class="drawer-header">
        <div class="drawer-title" style="display: flex; align-items: center; gap: 8px;">
          ${icon('info', 18)}
          <span>Download Inspector</span>
        </div>
        <button class="icon-btn" id="drawer-close">${icon('x', 18)}</button>
      </div>

      <div class="drawer-content">
        <div class="drawer-meta-group">
          <div class="drawer-meta-label">Filename</div>
          <div class="drawer-meta-val">
            <strong style="font-size: 14px;">${task.filename}</strong>
          </div>
        </div>

        <div class="drawer-meta-group">
          <div class="drawer-meta-label">Direct URL</div>
          <div class="drawer-meta-val">
            <span style="font-family: var(--font-mono); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${task.url}</span>
            <button class="icon-btn btn-copy-url" data-url="${task.url}" title="Copy URL" style="padding: 4px;">
              ${icon('copy', 14)}
            </button>
          </div>
        </div>

        <div class="drawer-meta-group">
          <div class="drawer-meta-label">Transfer Metrics</div>
          <div class="drawer-meta-val" style="flex-direction: column; align-items: stretch; gap: 6px;">
            <div style="display: flex; justify-content: space-between;">
              <span style="color: var(--text-muted);">Status:</span>
              <span style="font-weight: 600; text-transform: uppercase;">${task.status}</span>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span style="color: var(--text-muted);">Size:</span>
              <strong>${fmtBytes(task.receivedBytes)} / ${task.totalBytes ? fmtBytes(task.totalBytes) : 'Unknown'}</strong>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span style="color: var(--text-muted);">Current Speed:</span>
              <span>${fmtSpeed(task.speed)}</span>
            </div>
            ${task.avgSpeed ? `
              <div style="display: flex; justify-content: space-between;">
                <span style="color: var(--text-muted);">Average Speed:</span>
                <span>${fmtSpeed(task.avgSpeed)}</span>
              </div>
            ` : ''}
            ${task.elapsedSeconds ? `
              <div style="display: flex; justify-content: space-between;">
                <span style="color: var(--text-muted);">Duration:</span>
                <span>${fmtDuration(task.elapsedSeconds)}</span>
              </div>
            ` : ''}
          </div>
        </div>

        <div class="drawer-meta-group">
          <div class="drawer-meta-label">Storage Details</div>
          <div class="drawer-meta-val" style="flex-direction: column; align-items: stretch; gap: 6px;">
            <div style="display: flex; justify-content: space-between;">
              <span style="color: var(--text-muted);">Target:</span>
              <span>${task.saveTarget === 'cloud' ? 'Puter Cloud OS' : 'Local Computer'}</span>
            </div>
            ${task.savedPath ? `
              <div style="display: flex; justify-content: space-between;">
                <span style="color: var(--text-muted);">Cloud Path:</span>
                <span style="color: var(--accent-cyan); font-weight: 500;">${task.savedPath}</span>
              </div>
            ` : ''}
          </div>
        </div>

        <div class="drawer-actions">
          ${task.savedPath ? `
            <button class="btn btn-secondary" id="btn-drawer-cloud-folder">
              ${icon('cloud', 15)} Open /Downloads in Puter
            </button>
          ` : ''}

          <button class="btn btn-secondary btn-save-device" data-id="${task.id}">
            ${icon('hardDrive', 15)} Export to Computer
          </button>

          <button class="btn btn-secondary btn-retry" data-id="${task.id}">
            ${icon('refresh', 15)} Redownload File
          </button>

          <button class="btn btn-secondary btn-delete" data-id="${task.id}" style="color: var(--accent-red); border-color: rgba(214,48,49,0.3);">
            ${icon('trash', 15)} Delete Task
          </button>
        </div>
      </div>
    </aside>
  `;
}

// Render New Task Modal (Single & Batch Mode)
function renderNewTaskModal() {
  return `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal-box">
        <div class="modal-header">
          <div class="modal-title" style="display: flex; align-items: center; gap: 8px;">
            ${icon('download', 18)}
            <span>Add Downloads</span>
          </div>
          <button class="icon-btn" id="modal-close">${icon('x', 18)}</button>
        </div>

        <div class="modal-body">
          <!-- Mode Tabs -->
          <div class="modal-tabs">
            <div class="modal-tab ${modalTab === 'single' ? 'active' : ''}" data-tab="single">
              Single URL
            </div>
            <div class="modal-tab ${modalTab === 'batch' ? 'active' : ''}" data-tab="batch">
              Batch Download (Multi-URL)
            </div>
          </div>

          ${modalTab === 'single' ? `
            <div class="form-group">
              <label class="form-label">Target URL</label>
              <div style="display: flex; gap: 8px;">
                <input type="url" id="new-url-input" class="input-text" placeholder="https://example.com/file.zip" style="flex: 1;" autofocus />
                <button class="btn btn-secondary" id="btn-probe" style="padding: 0 14px;" ${probing ? 'disabled' : ''}>
                  ${probing ? icon('refresh', 14) : icon('zap', 14)}
                  <span>${probing ? 'Checking...' : 'Inspect'}</span>
                </button>
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">Save As Filename (Optional)</label>
              <input type="text" id="new-filename-input" class="input-text" placeholder="Auto-detected from URL or remote headers" />
            </div>

            ${probeResult ? `
              <div style="background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: 12px; font-size: 12.5px; display: flex; flex-direction: column; gap: 4px;">
                <div style="display: flex; justify-content: space-between;">
                  <span style="color: var(--text-muted);">Detected Name:</span>
                  <strong>${probeResult.filename}</strong>
                </div>
                <div style="display: flex; justify-content: space-between;">
                  <span style="color: var(--text-muted);">File Size:</span>
                  <strong>${probeResult.totalBytes ? fmtBytes(probeResult.totalBytes) : 'Stream / Unknown'}</strong>
                </div>
                <div style="display: flex; justify-content: space-between;">
                  <span style="color: var(--text-muted);">Category:</span>
                  <span style="text-transform: capitalize;">${probeResult.category}</span>
                </div>
              </div>
            ` : ''}
          ` : `
            <div class="form-group">
              <label class="form-label">Paste URLs (one URL per line)</label>
              <textarea id="batch-urls-input" class="textarea-batch" placeholder="https://example.com/file1.zip&#10;https://example.com/file2.mp4&#10;https://example.com/file3.pdf"></textarea>
            </div>
          `}

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
            ${icon('download', 16)} Start ${modalTab === 'batch' ? 'Batch' : ''} Download
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
            <span>Preferences & Settings</span>
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

          <div class="form-group">
            <label class="form-label">Notification Audio</label>
            <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer;">
              <input type="checkbox" id="check-sound-enabled" ${store.settings.soundEnabled ? 'checked' : ''} />
              <span>Play pleasant completion chime when downloads finish</span>
            </label>
          </div>

          <div class="form-group" style="margin-top: 10px; padding-top: 12px; border-top: 1px solid var(--border-subtle);">
            <label class="form-label">Data & Storage Management</label>
            <div style="display: flex; gap: 10px;">
              <button class="btn btn-secondary" id="btn-clear-all-data" style="color: var(--accent-red); border-color: rgba(214, 48, 49, 0.3); flex: 1;">
                ${icon('trash', 14)} Clear All History
              </button>
              <button class="btn btn-secondary" id="btn-export-history" style="flex: 1;">
                ${icon('copy', 14)} Export History JSON
              </button>
            </div>
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
  // Navigation / Categories
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
      showToast('Completed downloads cleared', 'info');
    });
  }

  // Theme Toggle Button
  const btnTheme = root.querySelector('#btn-toggle-theme');
  if (btnTheme) {
    btnTheme.addEventListener('click', () => {
      const current = document.documentElement.dataset.theme;
      const next = current === 'light' ? 'dark' : 'light';
      applyTheme(next);
      render();
    });
  }

  // Puter User Menu Toggle
  const btnUserMenu = root.querySelector('#btn-user-menu');
  if (btnUserMenu) {
    btnUserMenu.addEventListener('click', (e) => {
      e.stopPropagation();
      userDropdownOpen = !userDropdownOpen;
      render();
    });
  }

  // Puter Sign In
  const btnSignIn = root.querySelector('#btn-sign-in');
  if (btnSignIn) {
    btnSignIn.addEventListener('click', async () => {
      await auth.signIn();
    });
  }

  // Puter Sign Out
  const btnSignOut = root.querySelector('#btn-sign-out');
  if (btnSignOut) {
    btnSignOut.addEventListener('click', async () => {
      await auth.signOut();
      userDropdownOpen = false;
      showToast('Signed out of Puter', 'info');
    });
  }

  // Open Cloud Files in Puter
  const btnOpenFiles = root.querySelector('#btn-open-cloud-files, #btn-drawer-cloud-folder');
  if (btnOpenFiles) {
    btnOpenFiles.addEventListener('click', async () => {
      userDropdownOpen = false;
      const ok = await auth.openDownloadsInPuter();
      if (!ok) {
        showToast('Files are saved under /Downloads in Puter Cloud', 'info');
      }
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

  // Task Cards click to select & inspect
  root.querySelectorAll('.task-card').forEach((card) => {
    card.addEventListener('click', () => {
      const id = card.dataset.id;
      store.selectTask(store.selectedTaskId === id ? null : id);
    });
  });

  // Drawer Close
  const drawerClose = root.querySelector('#drawer-close');
  if (drawerClose) {
    drawerClose.addEventListener('click', () => {
      store.selectTask(null);
    });
  }

  // Copy Direct Link
  root.querySelectorAll('.btn-copy-url').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const url = btn.dataset.url;
      navigator.clipboard.writeText(url).then(() => {
        showToast('Download link copied to clipboard', 'success');
      });
    });
  });

  // Task Card Actions
  root.querySelectorAll('.btn-pause').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      engine.pause(btn.dataset.id);
      showToast('Download paused', 'info');
    });
  });

  root.querySelectorAll('.btn-resume').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      engine.resume(btn.dataset.id);
      showToast('Download resumed', 'info');
    });
  });

  root.querySelectorAll('.btn-retry').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      engine.retry(btn.dataset.id);
      showToast('Retrying download...', 'info');
    });
  });

  root.querySelectorAll('.btn-save-device').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      engine.saveToDevice(btn.dataset.id);
      showToast('Saving to local computer...', 'success');
    });
  });

  root.querySelectorAll('.btn-inspect').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      store.selectTask(btn.dataset.id);
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

  // Sample 1-Click Cards
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

    // Tab Switcher (Single vs Batch)
    root.querySelectorAll('.modal-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        modalTab = tab.dataset.tab;
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
          showToast('Please enter a URL first', 'error');
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
        } catch {
          showToast('Could not inspect URL', 'error');
        } finally {
          probing = false;
          render();
        }
      });
    }

    // Submit Download (Single or Batch)
    const btnSubmit = root.querySelector('#btn-submit-download');
    if (btnSubmit) {
      btnSubmit.addEventListener('click', () => {
        const targetRadio = root.querySelector('input[name="saveTarget"]:checked');
        const saveTarget = targetRadio ? targetRadio.value : store.settings.saveTarget;

        if (modalTab === 'batch') {
          const textarea = root.querySelector('#batch-urls-input');
          const lines = textarea ? textarea.value.split('\n') : [];
          const tasks = store.addBatchTasks(lines, saveTarget);
          if (tasks.length === 0) {
            showToast('No valid URLs found in batch list', 'error');
            return;
          }

          activeModal = null;
          tasks.forEach((t) => engine.start(t));
          showToast(`Started batch download of ${tasks.length} files`, 'success');
        } else {
          const url = urlInput ? urlInput.value.trim() : '';
          if (!url) {
            showToast('URL is required', 'error');
            return;
          }

          const customFilename = filenameInput ? filenameInput.value.trim() : '';
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
        }
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

    // Settings default storage radio
    root.querySelectorAll('input[name="defaultSaveTarget"]').forEach((radio) => {
      radio.addEventListener('change', (e) => {
        store.updateSettings({ saveTarget: e.target.value });
        showToast('Default storage updated', 'info');
      });
    });

    // Settings sound chime checkbox
    const soundCheck = root.querySelector('#check-sound-enabled');
    if (soundCheck) {
      soundCheck.addEventListener('change', (e) => {
        store.updateSettings({ soundEnabled: e.target.checked });
        showToast(`Sound chime ${e.target.checked ? 'enabled' : 'disabled'}`, 'info');
      });
    }

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

    // Export history
    const btnExportHistory = root.querySelector('#btn-export-history');
    if (btnExportHistory) {
      btnExportHistory.addEventListener('click', () => {
        const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(store.tasks, null, 2));
        const dlAnchor = document.createElement('a');
        dlAnchor.setAttribute('href', dataStr);
        dlAnchor.setAttribute('download', `downloader_export_${Date.now()}.json`);
        document.body.appendChild(dlAnchor);
        dlAnchor.click();
        dlAnchor.remove();
        showToast('History exported as JSON', 'success');
      });
    }
  }

  // Dismiss dropdown on window click
  window.addEventListener('click', (e) => {
    if (userDropdownOpen && !e.target.closest('.user-menu-wrap')) {
      userDropdownOpen = false;
      render();
    }
  }, { once: true });
}

// Global Keyboard Shortcuts
window.addEventListener('keydown', (e) => {
  const target = e.target;
  const isInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');

  if (e.key === 'Escape') {
    if (activeModal) {
      activeModal = null;
      render();
    } else if (store.selectedTaskId) {
      store.selectTask(null);
    }
    return;
  }

  if (isInput) return;

  if (e.key === '/' || e.key === '?') {
    e.preventDefault();
    const input = document.getElementById('search-input');
    if (input) input.focus();
  } else if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    activeModal = 'new-task';
    render();
  } else if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
    e.preventDefault();
    const current = document.documentElement.dataset.theme;
    applyTheme(current === 'light' ? 'dark' : 'light');
    render();
  }
});

// Drag and Drop URL handler
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (!isDraggingOver) {
    isDraggingOver = true;
    render();
  }
});

window.addEventListener('dragleave', (e) => {
  if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
    isDraggingOver = false;
    render();
  }
});

window.addEventListener('drop', (e) => {
  e.preventDefault();
  isDraggingOver = false;

  const text = e.dataTransfer ? e.dataTransfer.getData('text/plain') : '';
  if (text && /^https?:\/\//i.test(text.trim())) {
    activeModal = 'new-task';
    render();
    setTimeout(() => {
      const input = document.getElementById('new-url-input');
      if (input) {
        input.value = text.trim();
        const probeBtn = document.getElementById('btn-probe');
        if (probeBtn) probeBtn.click();
      }
    }, 100);
  } else {
    render();
  }
});

// Reactive Subscriptions
store.subscribe(() => {
  render();
});

auth.subscribe(() => {
  render();
});

// Initial boot
auth.checkAuth();
render();
