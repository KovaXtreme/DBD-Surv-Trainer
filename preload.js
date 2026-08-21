const { contextBridge, ipcRenderer } = require('electron');

// Everything the renderer (index.html) is allowed to call on the main
// process is listed here explicitly. Nothing else from Node/Electron is
// reachable from the page's own JavaScript.
contextBridge.exposeInMainWorld('electronAPI', {
  // ----- custom titlebar (frame:false on the main window) -----
  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowToggleMaximize: () => ipcRenderer.send('window-toggle-maximize'),
  windowClose: () => ipcRenderer.send('window-close'),
  // Fired when the window is maximized/restored by any means (the custom
  // button, double-clicking the drag region, a Windows snap gesture) so
  // the button's own icon can stay in sync even when it wasn't what
  // triggered the change.
  onWindowMaximizedChange: (callback) => {
    ipcRenderer.on('window-maximized-change', (_event, isMaximized) => callback(isMaximized));
  },
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // ----- global hotkeys -----
  // bindings: array of { id: string, key: string|null } where `key` is a
  // JS KeyboardEvent.key value (e.g. 'F1', 'a', ' ' for space). Called by
  // the MAIN window whenever the user's key bindings change, so the OS-level
  // shortcuts stay in sync with what's shown in the Hotkeys panel.
  updateHotkeys: (bindings) => ipcRenderer.send('update-hotkeys', bindings),

  // Called by the MAIN window at startup to receive hotkey presses that
  // happened while the app didn't have focus (e.g. while DBD is focused).
  onHotkeyFired: (callback) => {
    ipcRenderer.on('hotkey-fired', (_event, actionId) => callback(actionId));
  },

  // ----- controller (XInput) hotkeys -----
  // Entirely separate from the keyboard/mouse hotkeys above: bindings is
  // an array of { id: string, button: string|null } where `button` is an
  // XInput button name (e.g. "XINPUT_GAMEPAD_A"). A gamepad button and a
  // keyboard key are never in conflict, so this never needs merging with
  // updateHotkeys.
  updateGamepadHotkeys: (bindings) => ipcRenderer.send('update-gamepad-hotkeys', bindings),

  // Fired on every controller input change (press or release), regardless
  // of whether it matches a current binding -- this is what the "press a
  // button to bind" capture UI listens to, same idea as capturing a
  // keydown event for keyboard binding.
  onGamepadInput: (callback) => {
    ipcRenderer.on('gamepad-input', (_event, buttons) => callback(buttons));
  },

  // ----- match timer (authoritative in the main process) -----
  // The actual elapsed-time counting happens in main.js, not in either
  // renderer window -- see the note there for why (Chromium throttles
  // requestAnimationFrame/setInterval in backgrounded windows in ways
  // that turned out unreliable specifically while the app is unfocused
  // during real gameplay). These just request an action; the resulting
  // state comes back on the 'match-tick' broadcast below.
  matchStartPause: () => ipcRenderer.send('match-start-pause'),
  matchStartLeftOnly: () => ipcRenderer.send('match-start-left-only'),
  matchReset: () => ipcRenderer.send('match-reset'),
  matchSwapSides: () => ipcRenderer.send('match-swap-sides'),

  // One-shot fetch of the current authoritative state, used right after a
  // window (either one) finishes loading so it starts in sync instead of
  // at zero if a match was already running.
  matchGetState: () => ipcRenderer.invoke('match-get-state'),

  // Fired by the main process on every tick while a match is running (and
  // once immediately on every start/pause/reset/swap), to both windows at
  // once -- this is the sole source of truth for t1Elapsed/t2Elapsed/
  // activeTimer/matchRunning inside Electron.
  onMatchTick: (callback) => {
    ipcRenderer.on('match-tick', (_event, payload) => callback(payload));
  },

  // ----- overlay state mirroring -----
  // Called by the MAIN window (source of truth) every time the timer or
  // map overlay's visible state changes, to mirror it into the separate
  // overlay windows.
  sendStateSync: (payload) => ipcRenderer.send('state-sync', payload),

  // Called by the OVERLAY windows to receive those mirrored updates.
  onStateSync: (callback) => {
    ipcRenderer.on('state-sync', (_event, payload) => callback(payload));
  },

  // ----- overlay window behavior -----
  // Lets the MAIN window flip the timer overlay window between click-through
  // (so clicks reach the game) and interactive (so the user can click into
  // the name/score fields while in "edit" mode).
  setOverlayClickThrough: (overlayName, ignore) =>
    ipcRenderer.send('set-overlay-click-through', overlayName, ignore),

  // Called by the TIMER OVERLAY window while the user is typing directly
  // on it, to push those live edits back to the main window (the source
  // of truth for name/score/edit-mode state).
  sendOverlayEditUpdate: (payload) => ipcRenderer.send('overlay-edit-update', payload),

  // Called by the MAIN window to receive those edits.
  onOverlayEditUpdate: (callback) => {
    ipcRenderer.on('overlay-edit-update', (_event, payload) => callback(payload));
  },

  // Called by the MAP OVERLAY window when a version dot is clicked
  // directly on the in-game overlay, to relay that pick back to the main
  // window (which owns mapCurrent, same source-of-truth pattern as the
  // timer's name/score edits above).
  sendMapVersionSelect: (mapIndex) => ipcRenderer.send('map-version-select', mapIndex),

  // Called by the MAIN window to receive that pick.
  onMapVersionSelect: (callback) => {
    ipcRenderer.on('map-version-select', (_event, mapIndex) => callback(mapIndex));
  },

  // ----- map auto-detect -----
  // Grabs a screenshot, crops it to where DBD shows the map name, and runs
  // OCR + matching against the app's own map list. `payload` is
  // { mapNames, region? } -- mapNames is window.MAP_DATA from the
  // renderer, region is an optional { left, right, top, bottom } override
  // (0-1 fractions of screen size) for future per-user calibration.
  // Resolves to { match: {name,file}|null, rawText, croppedDataUrl }.
  captureMapRegion: (payload) => ipcRenderer.invoke('capture-map-region', payload),

  // ----- environment flag -----
  // Lets index.html tell it's running inside the desktop app (vs. a plain
  // browser tab), so it can enable desktop-only features.
  isDesktopApp: true
});
