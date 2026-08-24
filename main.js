const { app, BrowserWindow, ipcMain, globalShortcut, screen, desktopCapturer, Menu } = require('electron');
const path = require('path');
const { detectMapFromImage } = require('./map-detect');

let mainWindow = null;
let mapOverlayWindow = null;
let timerOverlayWindow = null;

// ---------------------------------------------------------------------
// Authoritative match-timer ticking, run in the MAIN PROCESS
// ---------------------------------------------------------------------
// Moved here (out of both renderer windows) because Chromium's
// requestAnimationFrame/setInterval throttling for backgrounded or
// unfocused windows is a long-standing, still-imperfect area even with
// backgroundThrottling:false set (electron/electron#9567, #20974, #31016,
// #42378 are all separate, still-open reports of exactly this on
// Windows). The main window is unfocused for as long as the player is
// actually in DBD -- exactly when accurate timing matters most, and
// exactly when two different renderer-side ticking attempts here already
// turned out unreliable. A plain Node.js setInterval in the MAIN PROCESS
// has no such throttling at all: it isn't a page and has no visibility
// state to throttle against.
let matchRunning = false;
let matchActiveTimer = 1;
let matchT1Elapsed = 0;
let matchT2Elapsed = 0;
let matchLastTickAt = null;
let matchSyncSeq = 0;
let matchTickInterval = null;

function broadcastMatchTick(){
  const payload = {
    seq: ++matchSyncSeq,
    t1Elapsed: matchT1Elapsed, t2Elapsed: matchT2Elapsed,
    activeTimer: matchActiveTimer, matchRunning: matchRunning
  };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('match-tick', payload);
  if (timerOverlayWindow && !timerOverlayWindow.isDestroyed()) timerOverlayWindow.webContents.send('match-tick', payload);
}

function ensureMatchTickIntervalState(){
  if (matchRunning && !matchTickInterval){
    matchLastTickAt = Date.now();
    matchTickInterval = setInterval(() => {
      const now = Date.now();
      const dt = now - matchLastTickAt;
      matchLastTickAt = now;
      if (matchActiveTimer === 1) matchT1Elapsed += dt; else matchT2Elapsed += dt;
      broadcastMatchTick();
    }, 20); // 50/sec: smooth enough for a hundredths display, cheap for Node either way
  } else if (!matchRunning && matchTickInterval){
    clearInterval(matchTickInterval);
    matchTickInterval = null;
  }
}

// accelerator (Electron's key-name format) -> actionId currently bound to it
let registeredAccelerators = new Map();
// Remembers the most recent bindings list so it can be re-applied once
// initM1Feature finishes loading (see below) -- applyHotkeyBindings can
// run before that async load completes, in which case a Shift/Ctrl/Alt
// binding wouldn't yet know to route to the uiohook path and would be
// silently dropped instead of just working a moment later.
let lastHotkeyBindings = null;

// ---------------------------------------------------------------------
// M1 (left mouse click) as an alternate "start left side" trigger
// ---------------------------------------------------------------------
// Unlike keyboard hotkeys, Electron's own globalShortcut API has no concept
// of mouse buttons at all -- this needs a real global mouse hook, which is
// what uiohook-napi provides. And unlike a keyboard key (which is safe to
// bind globally since normal desktop use rarely needs e.g. a crouch key),
// the LEFT MOUSE BUTTON is used constantly for everything on the whole
// PC -- so a bare global hook would fire the timer on every single click
// anywhere, not just in-game. active-win (which app is currently in the
// foreground) is what gates it to only actually do anything while Dead by
// Daylight itself is the focused window.
//
// Both packages are loaded dynamically (not via top-level require()) so
// that: (a) a platform/architecture without a prebuilt native binary for
// uiohook-napi doesn't crash the whole app -- M1 support just silently
// stays unavailable -- and (b) it works regardless of whether either
// package ships as CommonJS or ESM-only.
let uIOhookInstance = null;
let activeWindowFn = null;
let m1FeatureReady = false;
let m1HookRunning = false;

// ---------------------------------------------------------------------
// Keys Electron's globalShortcut can't handle: bare modifiers (Shift/Ctrl/
// Alt alone) and "M1" (the left mouse click, treated as just another
// bindable key everywhere in the UI now, not a separate toggle)
// ---------------------------------------------------------------------
// Electron's globalShortcut genuinely cannot register a bare modifier key
// on its own -- confirmed by Electron's own issue tracker (a "shift"-only
// accelerator throws a conversion error at registration time) -- and it
// has no concept of mouse buttons at all. uiohook-napi's own keyboard/mouse
// hook covers both, so any binding using Shift/Control/Alt/M1 is dispatched
// through here instead of globalShortcut. "M1" additionally only ever
// fires while Dead by Daylight itself is the focused window (checked
// below) -- unlike a keyboard key, which is safe to bind globally, the
// left mouse button is used constantly for everything on the whole PC, so
// a bare click hook without that check would fire from clicking anywhere.
const SPECIAL_UIOHOOK_KEYCODE = {}; // Shift/Control/Alt -> keycode, filled in once uiohook-napi has loaded
// key name ("Shift", "Control", "Alt", or "M1") -> actionId currently
// bound to it. Populated from the same bindings list applyHotkeyBindings
// receives, just filtered to these instead of going through globalShortcut.
let specialBindings = new Map();
// True while the renderer's "click a box, press a key/button" capture UI
// is actively listening for a NEW binding (either grid). The shared hook
// needs to stay running during that window even if nothing is bound to
// a mouse button yet, purely so mouse clicks can be relayed for capture.
let capturingMouseButtons = false;

// Which screen is currently showing in the main window ('1v1', 'maps',
// or anything else -- home/hub, credits, etc). Every hotkey action id is
// prefixed 'timer:' or 'map:'; dispatch only goes through while the
// matching screen is the active one, even while the game itself has
// focus -- see set-active-screen below and shouldDispatchHotkey's use at
// every dispatch site (globalShortcut, the modifier-key path, the mouse
// button path, and gamepad).
let activeScreen = null;
function shouldDispatchHotkey(actionId) {
  if (actionId.startsWith('timer:')) return activeScreen === '1v1';
  if (actionId.startsWith('map:')) return activeScreen === 'maps';
  return true;
}

// Only ever used to gate the M1-equivalent trigger (whichever of its
// three input paths -- mouse click, its own dedicated keyboard binding,
// or its own dedicated controller binding -- actually fired), on
// request: unlike every other hotkey here (which are all safe to leave
// bound globally, since they're deliberate F-keys/controller buttons
// nobody presses by accident), M1 specifically mirrors the game's own
// most-used input (a left click, or whatever's remapped to stand in for
// one), so without this it could start the timer from clicking or
// pressing that same button anywhere on the whole PC, not just in Dead
// by Daylight itself. Resolves to true (fires anyway) if active-win
// itself is unavailable or throws -- gating a real feature behind a
// diagnostic dependency failing silently would be a worse outcome than
// occasionally firing outside the game.
async function isDbdFocused() {
  if (!activeWindowFn) return true;
  try {
    const win = await activeWindowFn();
    if (!win) return false;
    const title = (win.title || '').toLowerCase();
    const ownerName = (win.owner && win.owner.name || '').toLowerCase();
    return title.includes('dead by daylight') || ownerName.includes('deadbydaylight') || ownerName.includes('dead by daylight');
  } catch (err) {
    console.warn('[M1 DBD check] active-win threw, allowing the trigger through:', err && err.message);
    return true;
  }
}

// True while any of this app's own windows (main window, or either
// overlay) currently holds OS focus -- checked as an OR alongside
// isDbdFocused for every keyboard/mouse hotkey (see
// isDbdOrAppFocused below), so binding, say, "R" to Start Timer and
// then clicking into the app's own settings window to change something
// doesn't itself get treated as "not Dead by Daylight" and silently
// swallow the press.
function isOwnAppFocused() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) return true;
  if (timerOverlayWindow && !timerOverlayWindow.isDestroyed() && timerOverlayWindow.isFocused()) return true;
  if (mapOverlayWindow && !mapOverlayWindow.isDestroyed() && mapOverlayWindow.isFocused()) return true;
  return false;
}

// The general-purpose version of isDbdFocused, on request: gates EVERY
// keyboard and mouse hotkey (not just M1) behind "Dead by Daylight or
// this app itself has focus" -- so binding hotkeys to ordinary keys
// (not just dedicated F-keys) doesn't risk them firing while browsing,
// using Discord, etc. with neither the game nor the app focused.
// Deliberately NOT applied to controller/gamepad bindings -- those stay
// exactly as they already were (always active), matching an earlier,
// explicit request to leave the controller path alone.
async function isDbdOrAppFocused() {
  if (isOwnAppFocused()) return true;
  return isDbdFocused();
}

function refreshSharedHookState() {
  if (!uIOhookInstance) return;
  const needed = specialBindings.size > 0 || capturingMouseButtons;
  if (needed && !m1HookRunning) {
    try {
      uIOhookInstance.start();
      m1HookRunning = true;
      console.log('[hook] shared uiohook mouse+keyboard hook STARTED (special bindings:', Array.from(specialBindings.keys()), ')');
    } catch (err) {
      console.warn('[hook] failed to start:', err && err.message);
    }
  } else if (!needed && m1HookRunning) {
    try {
      uIOhookInstance.stop();
      console.log('[hook] shared uiohook mouse+keyboard hook STOPPED (nothing needs it anymore)');
    } catch (err) { /* already stopped */ }
    m1HookRunning = false;
  }
}

// ---------------------------------------------------------------------
// Controller (XInput) hotkeys
// ---------------------------------------------------------------------
// Deliberately built on POLLING (asking XInput's own native GetState on
// an interval) rather than any kind of system-wide input hook -- the same
// "ask what the current state is" category as GetAsyncKeyState would be
// for the keyboard, not the "intercept every event as it happens"
// category uiohook-napi (used above for Shift/M1) falls into.
//
// Talks to Windows' own xinput1_4.dll (falling back to xinput1_3.dll or
// xinput9_1_0.dll on older systems) directly via koffi -- the same DLL
// any game itself would use to read a controller. koffi specifically
// (rather than the xinput-ffi package first tried here) because koffi
// ships a prebuilt binary for Windows in the npm package itself: no C++
// compiler, no Python, no Visual Studio Build Tools needed on whatever
// machine this runs `npm install` on. xinput-ffi depends on the older
// ffi-napi under the hood, which does require all of that to compile from
// source -- confirmed the hard way (a real `npm install` failing on
// missing Python) before switching to this.
let gamepadPollInterval = null;
let gamepadFeatureReady = false;
let XInputGetStateFn = null;
// XInput button name (e.g. "XINPUT_GAMEPAD_A") -> actionId currently
// bound to it. Populated the same way specialBindings is, just for
// gamepad buttons instead of keyboard/mouse.
let gamepadBindings = new Map();
let lastGamepadButtons = [];

// Bit flags from XInput.h (XINPUT_GAMEPAD_*), plus two synthetic
// "buttons" this file invents for the analog triggers (XInput reports
// those as a 0-255 pressure value, not a bit -- treating "pressed past a
// threshold" as on/off makes them usable as hotkeys the same way every
// other button here is).
const XINPUT_BUTTON_BITS = {
  XINPUT_GAMEPAD_DPAD_UP: 0x0001,
  XINPUT_GAMEPAD_DPAD_DOWN: 0x0002,
  XINPUT_GAMEPAD_DPAD_LEFT: 0x0004,
  XINPUT_GAMEPAD_DPAD_RIGHT: 0x0008,
  XINPUT_GAMEPAD_START: 0x0010,
  XINPUT_GAMEPAD_BACK: 0x0020,
  XINPUT_GAMEPAD_LEFT_THUMB: 0x0040,
  XINPUT_GAMEPAD_RIGHT_THUMB: 0x0080,
  XINPUT_GAMEPAD_LEFT_SHOULDER: 0x0100,
  XINPUT_GAMEPAD_RIGHT_SHOULDER: 0x0200,
  XINPUT_GAMEPAD_A: 0x1000,
  XINPUT_GAMEPAD_B: 0x2000,
  XINPUT_GAMEPAD_X: 0x4000,
  XINPUT_GAMEPAD_Y: 0x8000
};
const TRIGGER_THRESHOLD = 30; // 0-255, same default xinput-ffi's own helper used

function gamepadStateToButtons(state) {
  const buttons = [];
  const w = state.wButtons;
  for (const name in XINPUT_BUTTON_BITS) {
    if (w & XINPUT_BUTTON_BITS[name]) buttons.push(name);
  }
  if (state.bLeftTrigger > TRIGGER_THRESHOLD) buttons.push('GAMEPAD_LEFT_TRIGGER');
  if (state.bRightTrigger > TRIGGER_THRESHOLD) buttons.push('GAMEPAD_RIGHT_TRIGGER');
  return buttons;
}

async function initGamepadFeature() {
  try {
    const koffi = require('koffi');
    // Deliberately FLAT, not the nested { dwPacketNumber, Gamepad: {...} }
    // shape the real XINPUT_STATE C struct technically has. Every
    // verified koffi example of a struct used as an _Out_ parameter (the
    // Win32 docs' own GetCursorPos/POINT, gettimeofday/timeval, etc.) is a
    // single flat struct -- none of them nest a struct-within-a-struct
    // like XINPUT_STATE really does, and there's no confirmed example of
    // that being auto-decoded correctly either. Since a flat layout here
    // occupies the exact same bytes in the exact same order as the real
    // (nested) struct would -- dwPacketNumber first, then wButtons,
    // bLeftTrigger, bRightTrigger, and the four thumbstick shorts, with no
    // gaps either way -- this sidesteps that uncertainty entirely rather
    // than relying on nested-struct decoding actually working as hoped.
    const XINPUT_STATE = koffi.struct('XINPUT_STATE', {
      dwPacketNumber: 'uint32_t',
      wButtons: 'uint16_t',
      bLeftTrigger: 'uint8_t',
      bRightTrigger: 'uint8_t',
      sThumbLX: 'int16_t',
      sThumbLY: 'int16_t',
      sThumbRX: 'int16_t',
      sThumbRY: 'int16_t'
    });

    // Not every Windows install has every one of these -- xinput1_4 ships
    // with Windows 8+, xinput1_3 is the older DirectX SDK redistributable
    // some games still bundle, xinput9_1_0 is the Vista-era fallback
    // that's been present on every Windows version since. Trying them in
    // this order and using whichever actually loads covers all of them.
    let lib = null;
    for (const dllName of ['xinput1_4.dll', 'xinput1_3.dll', 'xinput9_1_0.dll']) {
      try {
        lib = koffi.load(dllName);
        console.log('[gamepad] loaded', dllName);
        break;
      } catch (err) { /* try the next one */ }
    }
    if (!lib) throw new Error('no XInput DLL could be loaded on this system');

    XInputGetStateFn = lib.func('uint32_t __stdcall XInputGetState(uint32_t dwUserIndex, _Out_ XINPUT_STATE *pState)');

    // Reads ALL 4 XInput slots and merges whatever buttons are pressed
    // across them -- NOT just slot 0. Confirmed the hard way: on at least
    // one real machine, slot 0 reports as permanently "connected" but its
    // packet number and every field stay frozen forever (a phantom device
    // left behind by some other software or driver), while the actual
    // physical controller sits at slot 1 and behaves completely normally.
    // Since this app only ever cares about "was some button pressed" for
    // hotkey purposes -- never which specific player/controller pressed
    // it -- merging every slot's buttons together sidesteps needing to
    // guess correctly which single slot is the real one, for this user or
    // anyone else whose controller doesn't happen to land on slot 0.
    //
    // Also logs each slot's connected/not-connected status, but only on
    // the rare occasions it actually changes (plugging in, unplugging) --
    // not every poll, which would flood the console 30x/sec for no
    // reason once things are working normally.
    let lastConnectedLogged = [null, null, null, null];
    function readAllConnectedSlotsButtons() {
      let buttons = [];
      for (let slot = 0; slot < 4; slot++) {
        let state = {};
        const connected = (XInputGetStateFn(slot, state) === 0);
        if (connected !== lastConnectedLogged[slot]) {
          console.log('[gamepad] slot', slot, 'connected:', connected);
          lastConnectedLogged[slot] = connected;
        }
        if (!connected) continue;
        buttons = buttons.concat(gamepadStateToButtons(state));
      }
      // A phantom slot and a real one could theoretically report the same
      // button name at once (not a real scenario here, but cheap to guard
      // against) -- dedupe so "newly pressed" comparisons downstream stay
      // simple set comparisons.
      return Array.from(new Set(buttons));
    }

    gamepadPollInterval = setInterval(() => {
      const buttons = readAllConnectedSlotsButtons();

      // Relayed as-is to the renderer regardless of whether anything
      // matches a binding -- this is what powers the "press a button to
      // bind" capture UI, which needs to see every press, not just ones
      // that already match something.
      if (buttons.length && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('gamepad-input', buttons);
      }

      // Only buttons newly present now but not a moment ago count as a
      // fresh press. Without this, a button held down for e.g. a full
      // second would fire repeatedly as the poll loop keeps reporting
      // it "active", the same way a stuck key would under raw polling.
      const newlyPressed = buttons.filter((b) => !lastGamepadButtons.includes(b));
      for (const button of newlyPressed) {
        // Logged unconditionally (not just when it matches a binding) --
        // this is the line that confirms whether a real button press is
        // reaching this code at all, which matters most while the user is
        // in "Press a button..." capture mode in the UI (nothing is bound
        // yet at that point, so the FIRED log below would otherwise never
        // print during the exact moment being tested).
        console.log('[gamepad] button pressed:', button);
        const actionId = gamepadBindings.get(button);
        if (!actionId) continue;
        // Deliberately no Dead by Daylight focus check here, unlike the
        // mouse-click and keyboard M1 paths -- explicitly excluded: the
        // controller's own "M1 Equivalent" button should keep firing
        // anywhere, same as every other controller binding, not just
        // while the game itself is focused.
        if (shouldDispatchHotkey(actionId)) {
          console.log('[gamepad] FIRED:', button, '->', actionId, 'at', new Date().toISOString());
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('hotkey-fired', actionId);
          }
        } else {
          console.log('[gamepad]', button, '-> bound to', actionId, 'but wrong screen active (', activeScreen, ') -- skipped');
        }
      }
      lastGamepadButtons = buttons;
    }, 33); // ~30hz -- plenty responsive for a hotkey press, no need to poll faster

    gamepadFeatureReady = true;
    console.log('[gamepad] XInput polling started (~30hz)');
  } catch (err) {
    console.warn('[gamepad feature] unavailable on this system (koffi/XInput failed to load):', err && err.message);
    gamepadFeatureReady = false;
  }
}

async function initM1Feature() {
  try {
    const uiohookModule = await import('uiohook-napi');
    uIOhookInstance = uiohookModule.uIOhook;
    const UiohookKey = uiohookModule.UiohookKey;
    SPECIAL_UIOHOOK_KEYCODE.Shift = UiohookKey.Shift;
    SPECIAL_UIOHOOK_KEYCODE.Control = UiohookKey.Ctrl;
    SPECIAL_UIOHOOK_KEYCODE.Alt = UiohookKey.Alt;
    const activeWinModule = await import('active-win');
    activeWindowFn = activeWinModule.default || activeWinModule.activeWindow;

    uIOhookInstance.on('keydown', async (e) => {
      if (specialBindings.size === 0) return;
      for (const [keyName, actionId] of specialBindings) {
        if (keyName === 'M1' || keyName === 'M2' || keyName === 'M4' || keyName === 'M5') continue; // handled in the mousedown listener below
        if (e.keycode === SPECIAL_UIOHOOK_KEYCODE[keyName]) {
          // Same focus check as every other keyboard/mouse hotkey now --
          // a bare Shift/Ctrl/Alt binding is just as easy to press
          // unintentionally while doing something else on the PC as any
          // ordinary key, so it gets the same treatment.
          if (!(await isDbdOrAppFocused())) {
            console.log('[hotkeys]', keyName, '->', actionId, 'but neither Dead by Daylight nor this app has focus -- skipped');
            return;
          }
          if (!shouldDispatchHotkey(actionId)) {
            console.log('[hotkeys]', keyName, '-> bound to', actionId, 'but wrong screen active (', activeScreen, ') -- skipped');
            return;
          }
          console.log('[hotkeys] modifier key FIRED:', keyName, '->', actionId, 'at', new Date().toISOString());
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('hotkey-fired', actionId);
          }
          return;
        }
      }
    });

    // Button numbers per uiohook-napi/libuiohook convention: 1=left,
    // 2=right, 3=middle, 4=side/back (X1), 5=side/forward (X2). Middle
    // click (3) is left out -- too easy to trigger by accident (e.g.
    // opening a link in a new tab) for how rarely it's actually useful as
    // a hotkey, unlike M1/M2/M4/M5 which are all deliberate, purposeful
    // clicks.
    const MOUSE_BUTTON_NAMES = { 1: 'M1', 2: 'M2', 4: 'M4', 5: 'M5' };

    uIOhookInstance.on('mousedown', async (e) => {
      const buttonName = MOUSE_BUTTON_NAMES[e.button];
      if (!buttonName) return;

      // While the renderer is "listening" for a hotkey to bind (any slot,
      // either grid), relay every mouse button press it cares about --
      // this is what lets clicking M4/M5 actually get captured as a
      // binding, the same principle as the gamepad capture relay further
      // up this file. Logged unconditionally too, so a real run can
      // immediately confirm whether these button numbers are correct for
      // someone's actual mouse (side buttons aren't 100% standardized
      // across every manufacturer).
      if (capturingMouseButtons) {
        console.log('[mouse] button pressed while capturing:', buttonName, '(raw button code', e.button + ')');
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('mouse-button-input', buttonName);
        }
      }

      const actionId = specialBindings.get(buttonName);
      if (!actionId) return;
      // Every bound mouse button (M1, M2, M4, M5 alike) now requires
      // Dead by Daylight or this app's own windows to have focus -- on
      // request, extending the check M1 alone already had to the other
      // three too, so none of them can fire while doing something
      // unrelated on the PC with neither the game nor the app focused.
      if (!(await isDbdOrAppFocused())) {
        console.log('[mouse]', buttonName, '->', actionId, 'but neither Dead by Daylight nor this app has focus -- skipped');
        return;
      }
      if (!shouldDispatchHotkey(actionId)) {
        console.log('[mouse]', buttonName, '-> bound to', actionId, 'but wrong screen active (', activeScreen, ') -- skipped');
        return;
      }
      console.log('[mouse] FIRED:', buttonName, '->', actionId, 'at', new Date().toISOString());
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('hotkey-fired', actionId);
      } else {
        console.warn('[mouse] mainWindow unavailable, could not dispatch');
      }
    });

    // Deliberately NOT starting the hook here. uIOhook.start() installs a
    // real, always-on system-wide input hook the moment it runs -- keeping
    // that active unconditionally turned out to interfere with Electron's
    // own globalShortcut keyboard hotkeys (F1 and friends stopped firing
    // in-game once this was added). refreshSharedHookState() -- called
    // whenever bindings change -- starts/stops it based on whether
    // anything actually needs it right now (a Shift/Ctrl/Alt/M1 binding
    // present), so it stays off the rest of the time and can't interfere
    // with normal Electron hotkeys.
    m1FeatureReady = true;

    // Covers the startup race: the renderer may have already sent its
    // hotkey bindings (via update-hotkeys) before this async import
    // finished, in which case any Shift/Ctrl/Alt/M1 binding in there
    // didn't know to route to the uiohook path yet. Re-processing the
    // same list now (if one arrived) picks it up correctly.
    if (lastHotkeyBindings) {
      console.log('[hotkeys] re-applying bindings received before uiohook finished loading');
      applyHotkeyBindings(lastHotkeyBindings);
    }
  } catch (err) {
    console.warn('[M1 feature] unavailable on this system (uiohook-napi/active-win failed to load):', err && err.message);
    m1FeatureReady = false;
  }
}

// ---------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------

// F12 (or Ctrl+Shift+I, for keyboards without dedicated function keys --
// common on smaller/laptop layouts) opens DevTools for whichever window
// it's pressed in -- registered directly on each window's webContents
// (not through the application menu, which is set to null below and
// would normally be what wires up these standard shortcuts) so they keep
// working regardless of that. Useful for troubleshooting a specific
// visual bug report without needing to rebuild with the menu re-enabled
// just for that.
function attachDevToolsShortcut(win) {
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return;
    const isF12 = input.key === 'F12';
    const isCtrlShiftI = input.control && input.shift && input.key.toLowerCase() === 'i';
    if (isF12 || isCtrlShiftI) {
      win.webContents.toggleDevTools();
    }
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#0c0708',
    // No native OS titlebar/menu -- replaced by a custom one built in
    // index.html (drag region + minimize/maximize/close buttons wired to
    // the IPC handlers below) so it matches the app's own dark theme
    // instead of Windows' default white titlebar and File/Edit/View/
    // Window/Help menu bar.
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Without this, Chromium pauses requestAnimationFrame/setInterval
      // in this window once it's minimized (or otherwise not visible) to
      // save resources -- which is exactly where the match timer's tick
      // loop and the state-sync-to-overlays interval both live. That made
      // the timer silently stop advancing (and stop pushing updates to
      // the overlay windows) whenever the app was minimized during a
      // match, even though hotkeys/state changes themselves still landed.
      backgroundThrottling: false
    }
  });

  attachDevToolsShortcut(mainWindow);

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Keeps the custom maximize/restore button's icon in sync if the window
  // gets maximized/restored some other way (double-clicking the custom
  // titlebar's drag region, a Windows snap gesture, etc), not just via
  // the button itself.
  mainWindow.on('maximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('window-maximized-change', true);
  });
  mainWindow.on('unmaximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('window-maximized-change', false);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Closing the main window closes the whole app, including overlays.
    if (mapOverlayWindow) mapOverlayWindow.close();
    if (timerOverlayWindow) timerOverlayWindow.close();
  });
}

function createOverlayWindow(viewName) {
  const display = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    fullscreenable: false,
    hasShadow: false,
    // The timer overlay needs to become focusable while the player is
    // editing names/score directly on it, and the map overlay needs the
    // same while picking a map version from the dots (both toggled via
    // 'set-overlay-click-through' below) -- otherwise clicks wouldn't
    // land once click-through is turned off for either of them.
    focusable: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Same reasoning as the main window: these windows must keep
      // rendering the live timer/map smoothly even while the OS considers
      // them "background" (e.g. the game has focus, or the main window is
      // minimized).
      backgroundThrottling: false
    }
  });

  // Keep the overlay above the game: on Windows/macOS this uses a level
  // above normal always-on-top windows, which tends to work over
  // borderless-fullscreen games. True fullscreen-exclusive games can still
  // cover it -- ask the player to use borderless/windowed fullscreen mode.
  win.setAlwaysOnTop(true, 'screen-saver');

  // Click-through by default so the game underneath still receives input.
  // Deliberately NOT using the {forward: true} option: it's specifically
  // the "forward" subclass of setIgnoreMouseEvents that has a long-standing,
  // confirmed Electron bug on Windows causing the cursor to flicker between
  // the pointer and default arrow on every hoverable element system-wide
  // (electron/electron#48035, #35414, #30808) -- forwarding isn't actually
  // needed here anyway, since these overlay windows have no hover-reactive
  // UI to drive while they're click-through; they only need real mouse
  // input while explicitly made interactive during name/score editing
  // (see 'set-overlay-click-through' below), which doesn't use forwarding.
  win.setIgnoreMouseEvents(true);

  attachDevToolsShortcut(win);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
    search: 'view=' + viewName
  });

  win.on('closed', () => {
    if (viewName === 'map') mapOverlayWindow = null;
    if (viewName === 'timer') timerOverlayWindow = null;
  });

  return win;
}

function createAllWindows() {
  createMainWindow();
  mapOverlayWindow = createOverlayWindow('map');
  timerOverlayWindow = createOverlayWindow('timer');

  // Windows-specific workaround: transparent, always-on-top "layered"
  // windows are sometimes not repainted by the OS compositor (DWM) as
  // often as their actual content changes, even though the page's own
  // DOM/JS is updating correctly every frame -- the pixels on screen can
  // lag behind. Nudging the native opacity by an imperceptible amount
  // forces DWM to treat the surface as dirty and repaint it. No effect on
  // macOS/Linux, where this isn't a known issue, but harmless there too.
  if (process.platform === 'win32') {
    setInterval(() => {
      [mapOverlayWindow, timerOverlayWindow].forEach((win) => {
        if (win && !win.isDestroyed()) {
          const current = win.getOpacity();
          win.setOpacity(current > 0.995 ? 0.999 : 1.0);
        }
      });
    }, 250);
  }
}

// ---------------------------------------------------------------------
// Global hotkeys
// ---------------------------------------------------------------------

// Converts a JS KeyboardEvent.key value (what the renderer already stores
// from its existing "click a box, press a key" rebind UI) into an Electron
// accelerator string. Covers the key types this app actually uses
// (function keys, letters/digits, space, arrows). Extend as needed if more
// key types become bindable.
function keyToAccelerator(key) {
  if (!key) return null;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return key; // F1-F24
  if (key === ' ') return 'Space';
  if (key.length === 1) return key.toUpperCase();
  const named = {
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Escape: 'Esc', Enter: 'Return', Tab: 'Tab', Backspace: 'Backspace',
    Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown'
  };
  return named[key] || null;
}

// bindings: array of { id, key } sent from the renderer whenever hotkeys
// are loaded or changed. Re-registers everything from scratch each time --
// simple and correct, and this only happens on user edits, not per-frame.
//
// DIAGNOSTIC LOGGING: temporarily verbose on purpose. If F1/etc. still
// don't fire in-game, the terminal window running `npm start` will show
// exactly what's happening -- whether registration itself fails (OS/another
// app already owns that key), or registration succeeds but the callback
// never runs (which would point somewhere else entirely, e.g. Electron's
// globalShortcut fighting with the uiohook mouse hook at a lower level
// than expected). That distinction is needed before making any further
// change here, rather than guessing again.
// True while the regular-key bindings (the ones routed through
// Electron's globalShortcut, i.e. everything except mouse clicks and
// bare modifier keys, which go through uiohook instead and don't have
// this problem) are currently actually claimed at the OS level.
// globalShortcut.register() doesn't just "listen" for a key -- it
// claims it EXCLUSIVELY system-wide, so as long as e.g. "F" is
// registered, pressing F never reaches Discord or a browser either,
// REGARDLESS of any in-callback focus check. The only real fix is to
// unregister the key entirely the moment focus leaves Dead by Daylight/
// this app, and re-register it the moment focus returns -- tracked here
// so the polling loop below knows which direction to move in.
let globalShortcutsClaimed = false;

// Actually performs the globalShortcut.register() calls for the current
// lastHotkeyBindings, if any. Split out from applyHotkeyBindings so the
// focus-poll loop below can call this same logic on a focus transition,
// not just when the bindings themselves change.
function claimGlobalShortcuts() {
  if (globalShortcutsClaimed) return;
  globalShortcutsClaimed = true;
  registeredAccelerators.clear();

  (lastHotkeyBindings || []).forEach(({ id, key }) => {
    if (key === 'M1' || key === 'M2' || key === 'M4' || key === 'M5') return; // uiohook path, not this one
    if (key && SPECIAL_UIOHOOK_KEYCODE.hasOwnProperty(key)) return; // uiohook path, not this one

    const accelerator = keyToAccelerator(key);
    if (!accelerator) return;
    if (registeredAccelerators.has(accelerator)) {
      console.warn('[hotkeys]', accelerator, 'for', id, '-> already used by', registeredAccelerators.get(accelerator), 'in this same batch, skipped');
      return;
    }

    const ok = globalShortcut.register(accelerator, () => {
      if (!shouldDispatchHotkey(id)) {
        console.log('[hotkeys]', accelerator, '-> bound to', id, 'but wrong screen active (', activeScreen, ') -- skipped');
        return;
      }
      console.log('[hotkeys] FIRED:', accelerator, '->', id, 'at', new Date().toISOString());
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('hotkey-fired', id);
      } else {
        console.warn('[hotkeys] FIRED but mainWindow is unavailable, could not dispatch', id);
      }
    });

    if (ok) {
      registeredAccelerators.set(accelerator, id);
    } else {
      console.warn('[hotkeys] FAILED to register', accelerator, 'for', id,
        '-- likely already owned by another running application or the OS.');
    }
  });

  console.log('[hotkeys] claimed (Dead by Daylight or this app has focus). Registered:', Array.from(registeredAccelerators.entries()));
}

// The inverse -- fully releases every regular key back to normal OS/
// other-app use. Deliberately does NOT touch specialBindings (the
// uiohook-routed mouse/modifier-key path) -- those were never claimed
// exclusively in the first place, so there's nothing to release there.
function releaseGlobalShortcuts() {
  if (!globalShortcutsClaimed) return;
  globalShortcutsClaimed = false;
  globalShortcut.unregisterAll();
  registeredAccelerators.clear();
  console.log('[hotkeys] released (neither Dead by Daylight nor this app has focus) -- regular keys are free for normal typing again.');
}

// Polls the same focus check as every hotkey dispatch site, purely to
// claim/release the regular-key bindings at the right moments -- kept
// deliberately much slower than the gamepad poll (focus doesn't change
// anywhere near as often as a button press does), so this doesn't add
// meaningful overhead.
let focusPollInterval = null;
async function pollFocusAndUpdateClaim() {
  const focused = await isDbdOrAppFocused();
  if (focused) claimGlobalShortcuts();
  else releaseGlobalShortcuts();
}
function startFocusPoll() {
  pollFocusAndUpdateClaim(); // immediately, so there's no up-to-500ms gap before the first real check
  if (focusPollInterval) return;
  focusPollInterval = setInterval(pollFocusAndUpdateClaim, 500);
}

function applyHotkeyBindings(bindings) {
  console.log('[hotkeys] applyHotkeyBindings called with', (bindings || []).length, 'bindings:',
    JSON.stringify(bindings));

  // Regular-key registration itself now happens in claimGlobalShortcuts,
  // driven by the focus poll above -- unclaim first so a rebind while
  // currently claimed doesn't leave a stale accelerator registered
  // alongside the new one, then let the very next poll tick (at most
  // 500ms away) re-claim with the fresh bindings if focus still
  // qualifies.
  releaseGlobalShortcuts();
  specialBindings.clear();

  (bindings || []).forEach(({ id, key }) => {
    if (key === 'M1' || key === 'M2' || key === 'M4' || key === 'M5') {
      // Mouse clicks: routed to the uiohook mousedown listener (with its
      // own Dead by Daylight-or-app focus check) instead of
      // globalShortcut, which has no concept of mouse buttons at all.
      specialBindings.set(key, id);
      console.log('[hotkeys]', key, 'for', id, '-> routed to the uiohook mouse-click path (not globalShortcut)');
      return;
    }
    if (key && SPECIAL_UIOHOOK_KEYCODE.hasOwnProperty(key)) {
      // Shift/Control/Alt alone: Electron's globalShortcut cannot register
      // these at all, so this goes through the uiohook keyboard hook
      // instead (see SPECIAL_UIOHOOK_KEYCODE / refreshSharedHookState).
      specialBindings.set(key, id);
      console.log('[hotkeys]', key, 'for', id, '-> routed to the uiohook modifier-key path (not globalShortcut)');
      return;
    }
  });

  refreshSharedHookState();
  startFocusPoll();
}

// ---------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------

// Custom titlebar controls (see frame:false on mainWindow above) -- the
// renderer has no direct way to minimize/maximize/close its own native
// window, so these just relay the button clicks to the real BrowserWindow
// methods that do.
ipcMain.on('window-minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});
ipcMain.on('window-toggle-maximize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window-close', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});
ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.on('update-hotkeys', (_event, bindings) => {
  lastHotkeyBindings = bindings;
  applyHotkeyBindings(bindings);
});

// bindings: array of { id, button } where button is an XInput button name
// (e.g. "XINPUT_GAMEPAD_A") or null/undefined if that action has no
// controller button assigned. Entirely separate list from update-hotkeys
// above -- a gamepad button and a keyboard key are never in conflict with
// each other, so there's no need to merge or cross-check them.
ipcMain.on('update-gamepad-hotkeys', (_event, bindings) => {
  gamepadBindings = new Map();
  (bindings || []).forEach(({ id, button }) => {
    if (button) gamepadBindings.set(button, id);
  });
  console.log('[gamepad] bindings updated:', Array.from(gamepadBindings.entries()));
});

// Sent by the renderer the moment its "click a box, press a key" capture
// UI opens/closes (either grid). While true, the shared hook is kept
// running (see refreshSharedHookState) purely so a mouse click can be
// relayed back via 'mouse-button-input' for the box to capture -- needed
// even when nothing is bound to a mouse button yet.
ipcMain.on('set-capturing-mouse-buttons', (_event, capturing) => {
  capturingMouseButtons = !!capturing;
  refreshSharedHookState();
});

ipcMain.on('set-active-screen', (_event, screenName) => {
  activeScreen = screenName;
  console.log('[hotkeys] active screen set to:', screenName, '-- timer:* hotkeys', (screenName === '1v1' ? 'ENABLED' : 'disabled'), ', map:* hotkeys', (screenName === 'maps' ? 'ENABLED' : 'disabled'));
});

ipcMain.on('state-sync', (_event, payload) => {
  [mapOverlayWindow, timerOverlayWindow].forEach((win) => {
    if (win && !win.isDestroyed()) win.webContents.send('state-sync', payload);
  });
});

ipcMain.on('set-overlay-click-through', (_event, overlayName, ignore) => {
  const win = overlayName === 'map' ? mapOverlayWindow : timerOverlayWindow;
  if (win && !win.isDestroyed()) {
    // No {forward: true} here either -- see the note in createOverlayWindow
    // above. The `forward` option only matters when `ignore` is true
    // anyway (a fully-interactive window doesn't need it), which is
    // exactly the case that triggers the Electron cursor-flicker bug.
    win.setIgnoreMouseEvents(!!ignore);
    if (!ignore) {
      // Entering interactive/edit mode: the window needs real OS keyboard
      // focus for typing into the name/score fields to actually land.
      win.show();
      win.focus();
    }
  }
});

// Relays live name/score edits made directly on the timer overlay window
// back to the main window, which is the source of truth for that state.
ipcMain.on('overlay-edit-update', (_event, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('overlay-edit-update', payload);
  }
});

// Same idea as overlay-edit-update above, for dragging the timer overlay
// bar directly in the real (usually click-through) overlay window --
// that's the only place the bar is actually visible/draggable at all
// (the main window keeps it hidden, see html.electron-main-window #ovBar
// in the CSS), so a drag ending there needs to relay the final position
// back to the main window, which owns saving it to localStorage and is
// what the settings panel's own state reflects.
ipcMain.on('overlay-position-update', (_event, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('overlay-position-update', payload);
  }
});

// ---------------------------------------------------------------------
// Match-timer control -- acts on the authoritative state above, then
// immediately broadcasts so both windows reflect the change without
// waiting for the next scheduled tick.
// ---------------------------------------------------------------------
ipcMain.on('match-start-pause', () => {
  matchRunning = !matchRunning;
  ensureMatchTickIntervalState();
  broadcastMatchTick();
});

ipcMain.on('match-start-left-only', () => {
  if (matchRunning) return; // no-op while running, by design
  matchActiveTimer = 1;
  matchRunning = true;
  ensureMatchTickIntervalState();
  broadcastMatchTick();
});

ipcMain.on('match-reset', () => {
  matchRunning = false;
  // Only the currently active timer gets zeroed -- the other side's
  // elapsed time is left untouched, and matchActiveTimer itself isn't
  // forced back to 1, so a reset mid-match doesn't silently switch which
  // side is "active" for the next start.
  if (matchActiveTimer === 1) matchT1Elapsed = 0; else matchT2Elapsed = 0;
  ensureMatchTickIntervalState();
  broadcastMatchTick();
});

ipcMain.on('match-swap-sides', () => {
  const t = matchT1Elapsed; matchT1Elapsed = matchT2Elapsed; matchT2Elapsed = t;
  broadcastMatchTick();
});

// The renderer asks for the current authoritative state when a window
// first loads (or reloads), so it starts in sync instead of at zero.
ipcMain.handle('match-get-state', () => ({
  seq: ++matchSyncSeq,
  t1Elapsed: matchT1Elapsed, t2Elapsed: matchT2Elapsed,
  activeTimer: matchActiveTimer, matchRunning: matchRunning
}));

// Same idea for a map version dot clicked directly on the map overlay
// window -- relays the pick back to the main window, which owns
// mapCurrent and will sync the new state back out to both overlays.
ipcMain.on('map-version-select', (_event, mapIndex) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('map-version-select', mapIndex);
  }
});

// Captures the primary display, crops to the region where DBD shows the
// map name, runs OCR on it, and matches the result against the app's own
// map list (passed in from the renderer, which already computed it as
// window.MAP_DATA -- kept as the single source of truth for map names).
// Returns { match: {name,file}|null, rawText, croppedDataUrl } so the
// renderer can show useful diagnostic info even on a miss.
ipcMain.handle('capture-map-region', async (_event, payload) => {
  try {
    const mapNames = (payload && payload.mapNames) || [];
    const region = payload && payload.region;
    const display = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: display.size.width,
        height: display.size.height
      }
    });
    const primary = sources[0];
    if (!primary) return { match: null, rawText: '', croppedDataUrl: null };
    return await detectMapFromImage(primary.thumbnail, mapNames, region);
  } catch (err) {
    console.error('[capture-map-region] failed:', err);
    return { match: null, rawText: '', croppedDataUrl: null, error: String(err) };
  }
});

// ---------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------

app.whenReady().then(() => {
  // No default File/Edit/View/Window/Help menu bar -- the custom titlebar
  // in index.html replaces it entirely, and that stock menu (mostly
  // reload/devtools/zoom entries meant for development) has no real use
  // for someone just running the app.
  Menu.setApplicationMenu(null);

  createAllWindows();
  initM1Feature();
  initGamepadFeature();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createAllWindows();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (uIOhookInstance) {
    try { uIOhookInstance.stop(); } catch (err) { /* already stopped/unavailable */ }
  }
  if (matchTickInterval) clearInterval(matchTickInterval);
  if (gamepadPollInterval) clearInterval(gamepadPollInterval);
});
