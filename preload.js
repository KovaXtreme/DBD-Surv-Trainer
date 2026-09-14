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

  // ----- mouse side buttons (M1/M4/M5) as regular hotkeys -----
  // Tells main.js whether the "click a box, press a key" capture UI is
  // currently open, so it knows to relay mouse clicks for capture (see
  // onMouseButtonInput) even before anything is actually bound to one.
  setCapturingMouseButtons: (capturing) => ipcRenderer.send('set-capturing-mouse-buttons', capturing),

  // Tells main.js which screen is currently showing in the main window,
  // so it can gate hotkey dispatch (timer:* only while '1v1' is active,
  // map:* only while 'maps' is active).
  setActiveScreen: (screenName) => ipcRenderer.send('set-active-screen', screenName),
  // Fired whenever M1/M4/M5 is clicked while capturing is active,
  // regardless of whether it matches an existing binding -- this is what
  // lets a hotkey card capture "the user just clicked their side button"
  // the same way it captures a keydown event.
  onMouseButtonInput: (callback) => {
    ipcRenderer.on('mouse-button-input', (_event, buttonName) => callback(buttonName));
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

  // ----- timer overlay window repositioning -----
  // The timer overlay is now a small window sized to just the bar
  // itself (not a full-screen invisible one), so "dragging the bar"
  // means actually moving that OS window. One-shot fetch of its fixed
  // size plus the display's bounds, so the renderer can convert a saved
  // or dragged position into absolute screen coordinates and compute
  // snap targets without any of that being hardcoded on its side.
  getTimerOverlayGeometry: () => ipcRenderer.invoke('get-timer-overlay-geometry'),
  // x/y are the window's target top-left in absolute screen coordinates.
  moveTimerOverlayWindow: (x, y) => ipcRenderer.send('move-timer-overlay-window', x, y),
  // width/height in pixels -- resizes the window to fit its content.
  // centerX/centerY: the window's CURRENT center point, passed through
  // directly from the renderer's own stable tracked value (ovWinX/Y)
  // rather than main.js re-deriving it from the window's current native
  // bounds -- re-deriving it that way was causing a compounding
  // rounding drift.
  //
  // invoke (not send/fire-and-forget) -- returns the ACTUAL center the
  // window ended up at, which can differ from the requested centerX/Y
  // whenever main.js had to clamp the position to keep the (now larger)
  // window fully on-screen. Without this round-trip, the renderer kept
  // right on believing its own pre-clamp centerX/Y was still accurate
  // even after main.js silently corrected it -- and since every
  // SUBSEQUENT resize call used that same stale, now-wrong value as its
  // own "current center", the error compounded further with each
  // resize near an edge. This is exactly what showed up as "still
  // drifts a bit, worse the closer to an edge" even after the
  // center-based (non-edge-anchored) resize math was already confirmed
  // correct in isolation -- the math was fine, but the renderer's own
  // notion of "current center" could silently fall out of sync with
  // reality. The renderer updates ovWinX/Y from this response every
  // time (see syncOvWindowSize), so the two stay in agreement even
  // right after a clamp.
  // oldWidth/oldHeight: the window's size just BEFORE this resize --
  // lets main.js detect whether an edge was flush against the display
  // boundary beforehand (i.e. the overlay was snapped there via the
  // drag magnet), and if so, keep growing/shrinking away from THAT
  // edge instead of always symmetrically from the center -- otherwise
  // an overlay snapped flush to, say, the top of the screen visibly
  // drifts away from the top every time the size changes, since only
  // the center point (not the edge the player actually cares about)
  // was ever being preserved.
  // dock (last argument): the renderer's own explicit record of which
  // display edge/corner the overlay is currently snapped to, plus how far
  // the window's edge should sit from that display edge. main.js uses it
  // instead of trying to guess from edge proximity -- see
  // computeDockedCenter there for why guessing was the actual cause of a
  // snapped overlay drifting off its edge during a Size drag.
  resizeTimerOverlayWindow: (width, height, centerX, centerY, oldWidth, oldHeight, dock) =>
    ipcRenderer.invoke('resize-timer-overlay-window', width, height, centerX, centerY, oldWidth, oldHeight, dock),
  // Same three, mirrored for the map overlay window.
  getMapOverlayGeometry: () => ipcRenderer.invoke('get-map-overlay-geometry'),
  moveMapOverlayWindow: (x, y) => ipcRenderer.send('move-map-overlay-window', x, y),
  // Same reasoning as the timer's own, above.
  resizeMapOverlayWindow: (width, height, centerX, centerY, oldWidth, oldHeight, dock) =>
    ipcRenderer.invoke('resize-map-overlay-window', width, height, centerX, centerY, oldWidth, oldHeight, dock),

  // ----- overlay window lifecycle (create/destroy on activate) -----
  // Called by the MAIN window's own toggle -- creates (or destroys) the
  // actual overlay window rather than it always existing in the
  // background, invisible, from app startup.
  showTimerOverlay: () => ipcRenderer.send('show-timer-overlay'),
  hideTimerOverlay: () => ipcRenderer.send('hide-timer-overlay'),
  showMapOverlay: () => ipcRenderer.send('show-map-overlay'),
  hideMapOverlay: () => ipcRenderer.send('hide-map-overlay'),
  // Called by the TIMER OVERLAY window's own renderer once it has
  // finished sizing/positioning itself correctly -- only then does
  // main.js actually reveal the (until now hidden) window, so there's
  // no visible snap into place a moment after it first appears.
  notifyTimerOverlayReady: () => ipcRenderer.send('timer-overlay-ready'),
  // Same, for the map overlay window.
  notifyMapOverlayReady: () => ipcRenderer.send('map-overlay-ready'),

  // Called by the TIMER OVERLAY window while the user is typing directly
  // on it, to push those live edits back to the main window (the source
  // of truth for name/score/edit-mode state).
  sendOverlayEditUpdate: (payload) => ipcRenderer.send('overlay-edit-update', payload),

  // Called by the MAIN window to receive those edits.
  onOverlayEditUpdate: (callback) => {
    ipcRenderer.on('overlay-edit-update', (_event, payload) => callback(payload));
  },

  // Called by the TIMER OVERLAY window when a drag (repositioning the
  // bar while unlocked) ends there, to relay the final position back to
  // the main window -- same source-of-truth pattern as the name/score
  // edits above, since the main window owns saving position to
  // localStorage and its own settings panel needs to reflect it too.
  sendOverlayPositionUpdate: (payload) => ipcRenderer.send('overlay-position-update', payload),

  // Called by the MAIN window to receive that position update.
  onOverlayPositionUpdate: (callback) => {
    ipcRenderer.on('overlay-position-update', (_event, payload) => callback(payload));
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
