import { svg } from './icons';
import { labelDialogsOnOpen } from '../ui/dialog';
import { installLongPress } from './long-press';

/** Static workspace chrome. Menus, tools, panels and options are filled in by
 * their controllers from the registries. */
export function appShell(root: HTMLElement) {
  labelDialogsOnOpen();
  installLongPress();
  root.innerHTML = `
<header class="topbar">
  <div class="brand" title="Photo Studio" aria-label="Photo Studio">${appIcon(22)}</div>
  <nav class="menubar" aria-label="Application menu"></nav>
  <div class="top-actions">
    <button class="top-search" data-command="edit.search" title="Search commands (⌘F)" aria-label="Search commands">${svg('search', 16)}</button>
    <button data-command="file.save" class="save-button" title="Save to Puter">${svg('cloud-upload', 16)}<span>Save</span></button>
    <button data-command="file.export-as" class="export-button" title="Export">Export ${svg('arrow-up-right', 16)}</button>
    <button data-command="app.account" id="account" class="account" title="Puter account" aria-label="Puter account">${svg('user-round', 16)}</button>
  </div>
</header>
<div class="optionsbar" role="toolbar" aria-label="Tool options">
  <button type="button" class="active-tool-icon" id="tool-icon" data-command="tool.preset-picker" title="Tool presets" aria-label="Tool presets" aria-haspopup="dialog"></button><span id="tool-name" class="sr-only"></span>
  <div id="tool-options"></div>
  <div class="options-end">
    <label class="theme-label"><span class="sr-only">Color theme</span><select id="theme" aria-label="Color theme"><option value="dark">Dark</option><option value="medium">Medium</option><option value="light">Light</option><option value="system">System</option></select></label>
    <button data-command="window.toggle-panels" class="icon-button" title="Show or hide panels (Tab)" aria-label="Toggle panels">${svg('panel-right', 17)}</button>
  </div>
</div>
<div class="editor-layout">
  <aside class="toolbar" aria-label="Tools">
    <div class="toolbar-grip" aria-hidden="true"></div>
    <div class="tool-slots" role="toolbar" aria-label="Editing tools" aria-orientation="vertical"></div>
    <div class="tool-separator" role="separator"></div>
    <div class="color-chips">
      <button class="chip-default" data-command="color.default" title="Default foreground and background colors (D)" aria-label="Default colors">${svg('default-colors', 12)}</button>
      <button class="chip-swap" data-command="color.swap" title="Switch foreground and background colors (X)" aria-label="Switch colors">${svg('swap-colors', 12)}</button>
      <button class="chip bg-chip" data-command="color.pick-background" aria-label="Background color" title="Set background color"></button>
      <button class="chip fg-chip" data-command="color.pick-foreground" aria-label="Foreground color" title="Set foreground color"></button>
      <input type="color" id="foreground" value="#000000" aria-label="Foreground color value" tabindex="-1" class="sr-only">
    </div>
    <button class="tool-slot quick-mask-button" data-command="select.quick-mask" title="Edit in Quick Mask mode (Q)" aria-label="Quick Mask mode">${svg('quick-mask')}</button>
    <button class="tool-slot" data-command="view.cycle-screen-mode" title="Change screen mode (F)" aria-label="Change screen mode">${svg('screen-mode')}</button>
  </aside>
  <main class="workspace">
    <div class="document-tabs" role="tablist" aria-label="Open documents"></div>
    <div class="canvas-area">
      <div class="ruler-origin" aria-hidden="true"></div>
      <div id="ruler-x" class="ruler ruler-x" aria-hidden="true"></div>
      <div id="ruler-y" class="ruler ruler-y" aria-hidden="true"></div>
      <div id="viewport" tabindex="0" aria-label="Image canvas">
        <div id="stage"><canvas id="canvas" aria-label="Document preview"></canvas><svg id="overlay" aria-hidden="true"></svg></div>
        <svg id="screen-overlay" aria-hidden="true"></svg>
        <div id="empty">
          <div class="start-head">
            ${appIcon(64, 'empty-logo')}
            <span class="empty-eyebrow">PHOTO STUDIO</span>
            <h1>Start with an image.</h1>
            <p>Open a photo or a layered PSD,<br>or create something from scratch.</p>
            <div class="empty-actions"><button class="primary" data-command="file.open">${svg('folder-open', 16)}Open an image</button><button class="secondary" data-command="file.new">${svg('file-plus', 16)}New document</button></div>
          </div>
          <div class="start-drop"><span class="drop-hint">${svg('download', 14)}Drop files anywhere in this workspace to open them</span><small>PSD · PSB · TIFF · PNG · JPEG · WebP · AVIF · GIF · BMP · .photo</small></div>
        </div>
      </div>
    </div>
    <section class="bottom-dock" aria-label="Bottom panels" hidden></section>
  </main>
  <aside class="dock" aria-label="Panels">
    <div class="dock-strip" role="toolbar" aria-label="Collapsed panels" aria-orientation="vertical"></div>
    <div class="dock-drawer" hidden></div>
    <div class="dock-column"></div>
  </aside>
</div>
<footer class="statusbar">
  <span class="status-zoom"><button data-command="view.zoom-out" class="icon-button" aria-label="Zoom out" title="Zoom out">${svg('minus', 14)}</button><input id="zoom-label" class="zoom-field" value="100%" aria-label="Zoom level" title="Type a zoom level and press Enter" spellcheck="false" autocomplete="off"><button data-command="view.zoom-in" class="icon-button" aria-label="Zoom in" title="Zoom in">${svg('plus', 14)}</button></span>
  <span id="tab-size">1600 × 1000</span><span class="canvas-color-mode">RGB / 8</span><span id="pointer-info" aria-live="off"></span>
  <span id="status" role="status">Ready</span>
  <span class="status-end"><span id="engine-status">Starting graphics…</span><a href="https://developer.puter.com" target="_blank" rel="noopener">Puter</a></span>
</footer>
<input id="file-input" type="file" accept="image/png,image/jpeg,image/webp,image/avif,image/gif,image/bmp,image/tiff,image/svg+xml,.photo,.psd,.psb,.tif,.tiff,.bmp,.ico,.tga,.ppm,.pgm,.pbm,.pnm" multiple hidden>
<dialog id="dialog"></dialog><div id="toast" role="status" hidden></div>`;
}
export function appIcon(size: number, className = '') {
  return `<img class="app-icon${className ? ` ${className}` : ''}" src="/app-icon.png" width="${size}" height="${size}" alt="" draggable="false" decoding="async">`;
}
