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
//
// Gated on app.isPackaged: only works when running from source (`npm
// start` / `electron .`), never in the built .exe end users download
// from GitHub Releases. Without this, anyone running the installed app
// could open DevTools and freely inspect/edit the live UI (Elements
// panel, console, etc.) -- harmless in the sense that it's local-only
// and never touches the actual files on disk, but there's no reason to
// hand that capability to every end user when it's really a
// development/troubleshooting aid.
function attachDevToolsShortcut(win) {
  win.webContents.on('before-input-event', (_event, input) => {
    if (app.isPackaged) return;
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

// Fixed size for the TIMER overlay window specifically (see below) --
// used only as its CREATION-time size, before the renderer measures
// the bar's real content and resizes it to match (see
// resize-timer-overlay-window further down) -- calibrated close to
// what the bar actually measures at 100% scale with default names, so
// that near-instant correction is a small, barely-visible snap rather
// than an obviously bigger jump. The map overlay is untouched by any
// of this -- still a full-display window, still positioned via CSS
// percentage within it, exactly as before.
const TIMER_OV_WIN_W = 993;
const TIMER_OV_WIN_H = 109;
// Same idea, same margin math (see MAP_WIN_MARGIN_PX in the renderer --
// 26px, matching the timer's own, since the dashed positioning frame's
// CSS is identical: 10px outline-offset + 2px outline width = 12px past
// the edge either way) applied to the map overlay now too -- initial
// guess based on the map image's own default 300px width at 100% size,
// square aspect ratio, plus 2*26 margin on each side.
// Initial creation-size guess, same self-correcting role as
// TIMER_OV_WIN_W/H above -- updated to match the new MAP_WIN_MARGIN_PX
// (60px, see the renderer for why) and a rough estimate of the actual
// card height (the square map image plus its title header bar above
// it, not just a plain square).
const MAP_OV_WIN_W = 420;
const MAP_OV_WIN_H = 500;
// Mirrors OV_WIN_MARGIN_PX/MAP_WIN_MARGIN_PX in the renderer -- these
// values MUST stay in sync with those (not derived/shared automatically,
// since main.js and the renderer are separate files/processes). Used
// specifically by the resize handlers' clampWindowToDisplay call, to
// let the window's transparent margin extend this many px past the
// display edge before actually clamping -- see the long comment on
// clampWindowToDisplay for why.
//
// The timer's margin is now asymmetric per side (0/10/2/2, not one
// uniform value) -- the window is sized to sit exactly flush against
// the dashed positioning frame on request ("a filo esatto... estendo
// esattamente all'esterno"), and the frame itself sits a different
// distance from the bar on each side (see .ov-bar.positioning::before
// in the renderer's CSS, and OV_FRAME_OFFSET_TOP/BOTTOM/LEFT/RIGHT
// there, which these four MUST stay in sync with).
const TIMER_OV_WIN_MARGIN_TOP = 0;
const TIMER_OV_WIN_MARGIN_BOTTOM = 10;
const TIMER_OV_WIN_MARGIN_LEFT = 2;
const TIMER_OV_WIN_MARGIN_RIGHT = 2;
const MAP_OV_WIN_MARGIN_PX = 60;

function createOverlayWindow(viewName) {
  const display = screen.getPrimaryDisplay();
  const isTimer = viewName === 'timer';
  const isMap = viewName === 'map';
  // Both overlay windows are now sized to just their own content (plus
  // margin), not the whole display -- this is what makes them show up
  // as normal, tightly-cropped, OBS-capturable windows instead of one
  // invisible full-screen window each. Positioned near each one's own
  // long-standing default screen location initially (bottom-center for
  // the timer, upper-right for the map); the renderer corrects this to
  // the user's actual saved position immediately on load via
  // moveTimerOverlayWindow/moveMapOverlayWindow, since that's saved in
  // the renderer's own localStorage, not reachable from here.
  let winX = display.bounds.x;
  let winY = display.bounds.y;
  let winW = display.bounds.width;
  let winH = display.bounds.height;
  if (isTimer) {
    winX = display.bounds.x + Math.round((display.bounds.width - TIMER_OV_WIN_W) / 2);
    // Flush against the very top of the screen by default (was 74% down,
    // i.e. the lower third) -- matches the window's own top margin of 0
    // (see TIMER_OV_WIN_MARGIN_TOP/OV_FRAME_OFFSET_TOP), so the dashed
    // positioning frame lands with zero gap against the monitor's own
    // top edge on a fresh install, before the player has ever dragged it
    // anywhere themselves.
    winY = display.bounds.y;
    winW = TIMER_OV_WIN_W;
    winH = TIMER_OV_WIN_H;
  } else if (isMap) {
    // Top-left corner by default (was upper-right at 88%/12%). Uses the
    // window's own placeholder size here, same caveat as the timer's own
    // default above -- the renderer corrects this to a precise flush
    // position (see computeMapSnapTargetsX/Y) once it knows the map's
    // real rendered size, so this placeholder only needs to be roughly
    // right, not pixel-exact.
    winX = display.bounds.x;
    winY = display.bounds.y;
    winW = MAP_OV_WIN_W;
    winH = MAP_OV_WIN_H;
  }
  // THE OVERLAY WINDOWS ARE THE SIZE OF THE DISPLAY, AND NEVER CHANGE.
  //
  // Every remaining overlay bug traced back to the window changing shape:
  // an anchored window's POSITION is a function of its size, so resizing
  // it also moves it, and the OS bounds and the page's own layout
  // viewport do not update in the same frame -- which is the sideways
  // flash. Worse, a window that no longer hugs the bar put the drag, the
  // snap magnet and the anchoring into two different reference frames
  // (one measured from the bar, one from the window), over 200px apart,
  // which is what made a grabbed overlay squirt out from under the cursor.
  //
  // A window that is always exactly the display has neither problem, and
  // not by being careful about it: there is no size to change, no
  // position to recompute, and window coordinates and screen coordinates
  // differ by a constant. One frame of reference for everything.
  winX = display.bounds.x;
  winY = display.bounds.y;
  winW = display.bounds.width;
  winH = display.bounds.height;
  const win = new BrowserWindow({
    x: winX,
    y: winY,
    // Both overlay windows load the same index.html, which only carries
    // one shared <title> tag ("DBD Surv Trainer") -- with nothing here
    // to override it, that's the ONLY name OBS's Window Capture picker
    // (or any other window list) ever saw for either one, making them
    // indistinguishable in that list. This sets each one's real OS-level
    // window title directly, independent of when/whether the page's own
    // title tag loads, so the distinction shows up immediately and
    // reliably in that picker.
    title: isTimer ? 'DBD Surv Trainer - 1v1 Timer'
      : isMap ? 'DBD Surv Trainer - Maps Clocks'
      : 'DBD Surv Trainer',
    width: winW,
    height: winH,
    // Created hidden on purpose -- shown explicitly once the renderer
    // has finished sizing/positioning itself correctly (see
    // 'timer-overlay-ready'/'map-overlay-ready' below), so the very
    // first thing the player ever sees (or OBS captures) is already the
    // right size in the right place, not a visible snap into place a
    // moment later.
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    // skipTaskbar removed on purpose (was true) -- with it set, this
    // window never showed up in the taskbar at all, which almost
    // certainly doubled as the reason OBS's Window Capture source list
    // couldn't find it either (window-picker lists like that typically
    // enumerate the same "normal, taskbar-visible" windows). Showing it
    // in the taskbar is a purely window-manager-level visibility change
    // -- unlike disabling hardware acceleration, it doesn't touch how
    // anything actually renders, so it doesn't carry that same risk of
    // breaking the transparency itself.
    resizable: false,
    // movable stays false for BOTH overlays -- dragging the bar itself
    // (handled entirely in the renderer/main.js pair below for the
    // timer) is a deliberate, separate mechanism from the OS's own
    // native window-drag, which would fight with the click-through /
    // snap-to-edge logic already in place.
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
    // Windows 11 rounds the corners of frameless windows by default, and
    // on a TRANSPARENT one the rounding is drawn as a faint hairline that
    // survives along the straight edges too -- it reads as a stray light
    // pixel just inside the window's own boundary, and whether it lands
    // on a whole device pixel or gets split across two depends on the
    // window's exact size, which is why it would appear at some Size
    // values and not others. Squared off, there is no rounding to draw.
    roundedCorners: false,
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

  // Electron's default behavior is to resync a window's native title to
  // match the PAGE's own <title> tag the moment it finishes loading (and
  // again on any later document.title change) -- which undid the custom
  // title set above the instant index.html loaded, since both overlays
  // load that same file and it carries one shared <title>DBD Surv
  // Trainer</title> for all three windows. That's why OBS's Window
  // Capture picker kept showing plain "DBD Surv Trainer" for every
  // window regardless of the title passed to the constructor -- it was
  // reading the real, current title, which really had been overwritten
  // back to the generic one moments after each window appeared.
  win.on('page-title-updated', (event) => {
    event.preventDefault();
  });

  win.on('closed', () => {
    if (viewName === 'map') mapOverlayWindow = null;
    if (viewName === 'timer') timerOverlayWindow = null;
  });

  return win;
}

function createAllWindows() {
  createMainWindow();

  // Overlay windows are NOT created here at startup -- they only come
  // into existence when the corresponding overlay is actually activated
  // (see ensureTimerOverlayWindow/ensureMapOverlayWindow and the show/
  // hide IPC handlers below), and are destroyed again when deactivated.
  // Nothing spawns silently in the background (visible in Alt-Tab/OBS's
  // window list, even fully transparent) before the user has actually
  // turned anything on.

  // Windows-specific workaround: transparent, always-on-top "layered"
  // windows are sometimes not repainted by the OS compositor (DWM) as
  // often as their actual content changes, even though the page's own
  // DOM/JS is updating correctly every frame -- the pixels on screen can
  // lag behind. Nudging the native opacity by an imperceptible amount
  // forces DWM to treat the surface as dirty and repaint it. No effect on
  // macOS/Linux, where this isn't a known issue, but harmless there too.
  // Guarded per-window since either one can now be null/destroyed at any
  // given moment.
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

// Creates the timer overlay window if it doesn't already exist (a
// second activation while it's already up is a harmless no-op, not a
// duplicate window). Stays hidden (see show:false in createOverlayWindow)
// until 'timer-overlay-ready' below says it's safe to reveal.
function ensureTimerOverlayWindow() {
  if (timerOverlayWindow && !timerOverlayWindow.isDestroyed()) return timerOverlayWindow;
  timerOverlayWindow = createOverlayWindow('timer');
  return timerOverlayWindow;
}

// Same, for the map overlay window.
function ensureMapOverlayWindow() {
  if (mapOverlayWindow && !mapOverlayWindow.isDestroyed()) return mapOverlayWindow;
  mapOverlayWindow = createOverlayWindow('map');
  return mapOverlayWindow;
}

ipcMain.on('show-timer-overlay', () => {
  ensureTimerOverlayWindow();
});

ipcMain.on('hide-timer-overlay', () => {
  if (timerOverlayWindow && !timerOverlayWindow.isDestroyed()) {
    timerOverlayWindow.close();
  }
  timerOverlayWindow = null;
});

ipcMain.on('show-map-overlay', () => {
  ensureMapOverlayWindow();
});

ipcMain.on('hide-map-overlay', () => {
  if (mapOverlayWindow && !mapOverlayWindow.isDestroyed()) {
    mapOverlayWindow.close();
  }
  mapOverlayWindow = null;
});

// Sent by the TIMER overlay window's own renderer once it has finished
// fetching its geometry, restoring/moving to its saved position, and
// resizing to match its real content -- i.e. exactly the point where
// showing it can't produce a visible snap, because everything about its
// size and position is already final. See show:false in
// createOverlayWindow.
ipcMain.on('timer-overlay-ready', () => {
  if (timerOverlayWindow && !timerOverlayWindow.isDestroyed()) {
    timerOverlayWindow.show();
  }
});

// Same, for the map overlay window.
ipcMain.on('map-overlay-ready', () => {
  if (mapOverlayWindow && !mapOverlayWindow.isDestroyed()) {
    mapOverlayWindow.show();
  }
});

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

// ----- timer overlay window repositioning + dynamic sizing (dragging
// moves the actual OS window now, not just CSS position within a
// full-screen one; the window's SIZE now also tracks the bar's own
// real rendered size + a fixed margin -- see resize-timer-overlay-
// window below -- rather than staying at one guessed fixed size that
// could never correctly fit every combination of name length, scale%,
// and side-by-side/stacked layout at once) -----
//
// Position is tracked by the window's CENTER point throughout this
// whole system (move, resize, geometry, and what gets saved/restored
// in the renderer) -- NOT its top-left corner. This matters because the
// window's SIZE changes dynamically (see resize below): top-left is
// only meaningful relative to a specific size, so a position saved
// while the window was one size and restored after it settled at a
// DIFFERENT size (which happens on essentially every launch, since the
// window starts at TIMER_OV_WIN_W/H and gets resized to the real
// content moments later) would silently shift where the bar actually
// ends up -- and since the shifted result is what gets saved again
// next time, that error compounds further on every subsequent launch.
// That compounding drift is exactly what showed up as "the overlay
// spawns further off-screen every time the app is reopened". The
// center point doesn't have this problem: it stays meaningful and
// correct regardless of what size the window happens to be, which is
// also exactly the point resize-timer-overlay-window already anchors
// to when it resizes -- using the same reference point everywhere
// closes the gap between them instead of letting them drift apart.
//
// One-shot fetch the renderer calls right after load, and again whenever
// it needs fresh numbers (e.g. right before starting a drag) -- gives it
// everything needed to convert a saved/dragged position into absolute
// screen coordinates and compute where the screen's own edges are for
// snapping, without hardcoding any of that on the renderer side.
ipcMain.handle('get-timer-overlay-geometry', () => {
  const display = screen.getPrimaryDisplay();
  // currentCenterX/Y come from the window's OWN current bounds (already
  // positioned/sized at a sensible default by createOverlayWindow
  // above) -- returned here so the renderer only needs to override this
  // with a saved position when one genuinely exists, instead of
  // duplicating that same "reasonable default" math a second time on
  // its side.
  let currentCenterX = display.bounds.x + TIMER_OV_WIN_W / 2;
  let currentCenterY = display.bounds.y + TIMER_OV_WIN_H / 2;
  if (timerOverlayWindow && !timerOverlayWindow.isDestroyed()) {
    const bounds = timerOverlayWindow.getBounds();
    currentCenterX = bounds.x + bounds.width / 2;
    currentCenterY = bounds.y + bounds.height / 2;
  }
  return {
    currentCenterX: currentCenterX,
    currentCenterY: currentCenterY,
    displayX: display.bounds.x,
    displayY: display.bounds.y,
    displayW: display.bounds.width,
    displayH: display.bounds.height
  };
});

// Shared by all four move/resize handlers below (timer + map). Given a
// desired CENTER point and a window size, returns the top-left x/y that
// keeps the WHOLE window inside the display when it fits (rather than
// the old clamp, which only guaranteed 40px stayed visible -- enough to
// still grab and drag it back, but happily let most of a freshly
// enlarged window hang off the edge, which is exactly what "growing it
// pushes it off-screen" was). Falls back to anchoring flush against the
// near edge only in the genuine edge case where the window itself is
// bigger than the display in that dimension, since full containment
// isn't possible there regardless of position.
//
// Also returns whether each axis was ACTUALLY clamped (clampedX/
// clampedY) -- resize-*-overlay-window below uses this to report back
// the exact, unrounded requested center whenever nothing needed
// clamping (the overwhelming majority of resizes, comfortably away
// from any edge), instead of always recomputing it from the rounded
// pixel position. Recomputing from the rounded pixel was the source of
// a slow, real drift confirmed directly: JS's Math.round always rounds
// a .5 boundary UP, never down, so a sequence of resizes whose width/
// height alternate between odd and even (completely ordinary while
// dragging a scale/size slider) hit that .5 boundary repeatedly and
// biased the same direction every single time -- small per-step, but
// compounding into a real, visible several-pixel drift over the course
// of one drag, EVEN with the renderer's own center-correction relay
// already in place (that relay faithfully reports the rounding-biased
// result back -- it doesn't remove the bias, since the bias comes from
// this rounding step itself, not from disagreement between the
// renderer and main.js about what was requested).
// margin (optional, default 0): how many pixels of the window's OWN
// edge are allowed to extend past the display boundary before this
// actually clamps anything -- lets the window's transparent margin
// (drawn around the bar/map so the dashed positioning frame and glow
// effects have room -- see OV_FRAME_OFFSET_*/MAP_WIN_MARGIN_PX in the
// renderer) sit slightly off-screen exactly the way the drag/snap
// system already intends, while still guaranteeing the actual VISIBLE
// content (window inset by that same margin) never goes off-screen.
// Without this, resizing an overlay that had been snapped flush
// against an edge (bar's own edge at display+8px, per the snap system,
// meaning the WINDOW's edge sits a bit further out, inside its own
// margin) would get its whole window+margin forced fully on-screen,
// visibly shoving the bar inward by the difference -- confirmed
// directly from a screenshot: the same overlay, snapped to the top at
// 100% size, showing its dashed frame flush with the screen's top
// edge, then visibly sitting well below it after only changing size to
// 80%, even with the edge-anchoring fix already keeping the bar's
// OWN previous edge as the anchor point -- the anchor math was correct,
// but this clamp was then moving the result anyway.
//
// Accepts either a single number (one uniform margin on every side --
// what the map overlay still uses) or an object { top, bottom, left,
// right } for a window whose margin differs per side (the timer, now
// that it sits exactly flush against its own frame, which itself isn't
// the same distance from the bar on every side).
function clampWindowToDisplay(centerX, centerY, w, h, display, margin) {
  let top, bottom, left, right;
  if (margin && typeof margin === 'object') {
    top = margin.top || 0;
    bottom = margin.bottom || 0;
    left = margin.left || 0;
    right = margin.right || 0;
  } else {
    top = bottom = left = right = margin || 0;
  }
  const idealX = centerX - w / 2;
  const idealY = centerY - h / 2;
  const minX = display.bounds.x - left;
  const maxX = display.bounds.x + display.bounds.width - w + right;
  let x, clampedX;
  if (minX >= maxX) {
    x = minX;
    clampedX = true;
  } else {
    const boundedIdealX = Math.max(minX, Math.min(maxX, idealX));
    clampedX = (boundedIdealX !== idealX);
    x = Math.round(boundedIdealX);
  }
  const minY = display.bounds.y - top;
  const maxY = display.bounds.y + display.bounds.height - h + bottom;
  let y, clampedY;
  if (minY >= maxY) {
    y = minY;
    clampedY = true;
  } else {
    const boundedIdealY = Math.max(minY, Math.min(maxY, idealY));
    clampedY = (boundedIdealY !== idealY);
    y = Math.round(boundedIdealY);
  }
  return { x, y, clampedX, clampedY };
}

// Given the window's OLD center + OLD size, checks whether it was
// sitting flush against a display edge (e.g. dragged there via the
// renderer's own snap-to-edge magnet) on each axis independently, and
// if so, returns a NEW center that keeps that same edge fixed as the
// window grows/shrinks -- rather than always growing symmetrically
// from the center, which visibly pulls an edge-snapped overlay away
// from the very edge it was snapped to every time its size changes
// (an overlay flush against the top of the screen at 100% size ends up
// well below the top at 50%, since only the center point, not the top
// edge, was ever being preserved).
//
// Deliberately NOT the same "which half of the display is the center
// in" heuristic tried earlier for general edge-anchoring, which was
// reverted for being unstable near the display's own midline (a tiny
// position shift right around 50% flipped which side it anchored to,
// reading as "moves around unpredictably"). Checking actual proximity
// to 0 or to the display's far edge is a fundamentally more stable
// signal: it only matters near the edges themselves (where an overlay
// deliberately snapped there will genuinely sit), not across the whole
// width/height of the display the way a less-than/greater-than-the-
// midpoint check does.
// tolerance (required, not a fixed shared constant): how many px the
// window's OWN edge can differ from the display boundary before this
// still counts as "flush against it". This has to be based on each
// overlay's own margin, not one shared fixed number -- when snapped
// via the drag magnet, the bar/map's own edge lands ~8px from the
// display edge (the renderer's own OV_EDGE_MARGIN_PX), but the
// WINDOW's edge sits margin px further out than that. A single fixed
// 20px tolerance correctly covered the timer (26px margin -> ~18px
// window-edge offset, within 20) but silently missed the map (60px
// margin -> ~52px offset, well past 20) -- confirmed directly from two
// screenshots showing the map's dashed frame flush with the screen at
// 100% size and visibly detached from it at 50%, the exact bug already
// fixed for the timer, just not actually caught for the map since this
// check was failing before ever reaching the anchoring logic below.
function computeEdgeAnchoredCenter(oldCenterX, oldCenterY, oldW, oldH, display, tolerance) {
  if (!oldW || !oldH) {
    // No known previous size (e.g. the very first resize for a freshly
    // created window) -- nothing to anchor from, fall back to the
    // requested center unchanged.
    return { centerX: oldCenterX, centerY: oldCenterY };
  }
  const oldLeft = oldCenterX - oldW / 2;
  const oldRight = oldCenterX + oldW / 2;
  const oldTop = oldCenterY - oldH / 2;
  const oldBottom = oldCenterY + oldH / 2;
  const nearLeft = Math.abs(oldLeft - display.bounds.x) <= tolerance;
  const nearRight = Math.abs(oldRight - (display.bounds.x + display.bounds.width)) <= tolerance;
  const nearTop = Math.abs(oldTop - display.bounds.y) <= tolerance;
  const nearBottom = Math.abs(oldBottom - (display.bounds.y + display.bounds.height)) <= tolerance;
  return {
    anchorLeft: nearLeft,
    anchorRight: !nearLeft && nearRight,
    anchorTop: nearTop,
    anchorBottom: !nearTop && nearBottom,
    oldLeft, oldRight, oldTop, oldBottom
  };
}

// ---------------------------------------------------------------------
// EXPLICIT DOCKING (replaces the proximity-guessing above as the primary
// path -- computeEdgeAnchoredCenter is only still used as a fallback for
// an old renderer that doesn't send a dock descriptor).
//
// The old system tried to INFER, on every single resize, whether the
// overlay was currently snapped to an edge, by checking how close its
// previous window edges happened to be to the display's edges. That is
// unreliable in both directions and is the actual root cause of "the
// overlay comes away from the edge while I drag the Size slider":
//
//   * the tolerance has to be wide enough to cover the window's own
//     transparent margin (75px for the map), which means an overlay
//     merely sitting NEAR an edge -- never deliberately snapped there --
//     gets silently treated as docked, and a large map can satisfy
//     nearTop AND nearBottom at once, so a centred map gets yanked to
//     the top;
//   * conversely, the moment anything (a clamp, a rounding step, one
//     stale oldWidth/oldHeight pair from a competing resize path) moves
//     the window by more than the tolerance, the check silently fails
//     and the overlay is treated as free-floating -- it then grows from
//     its centre and visibly peels away from the edge it was glued to,
//     with no way to ever get back, because the next resize starts from
//     the already-wrong position.
//
// Both problems disappear once the renderer simply TELLS us where the
// overlay is docked (it knows exactly: the drag's own snap magnet is
// what put it there). The docked position is then recomputed ABSOLUTELY
// from the display bounds on every resize -- never incrementally from
// the previous position -- so it is exact every time and mathematically
// cannot drift, no matter how many resizes happen or in what order.
//
// dock: { x: 'left'|'center'|'right'|null,
//         y: 'top'|'center'|'bottom'|null,
//         insetX: number, insetY: number }
// insetX/insetY = how far the WINDOW's own docked edge should sit from
// the display's edge. It is normally NEGATIVE, because the window is
// deliberately larger than the visible overlay (transparent margin for
// the dashed frame and the neon glow): the timer sits flush (0), the map
// sits at MAP_EDGE_MARGIN_PX - MAP_WIN_MARGIN_PX so that its dashed
// frame -- not its window -- is what lands exactly on the screen edge.
// A null on an axis means "not docked on this axis": that axis keeps
// whatever free-floating behaviour the caller asks for.
function computeDockedCenter(dock, w, h, display) {
  const dx = display.bounds.x, dy = display.bounds.y;
  const dw = display.bounds.width, dh = display.bounds.height;
  const insetX = (dock && typeof dock.insetX === 'number') ? dock.insetX : 0;
  const insetY = (dock && typeof dock.insetY === 'number') ? dock.insetY : 0;
  const out = { x: null, y: null };
  const dkx = dock && dock.x;
  const dky = dock && dock.y;
  if (dkx === 'left') out.x = dx + insetX + w / 2;
  else if (dkx === 'right') out.x = dx + dw - insetX - w / 2;
  else if (dkx === 'center') out.x = dx + dw / 2;
  if (dky === 'top') out.y = dy + insetY + h / 2;
  else if (dky === 'bottom') out.y = dy + dh - insetY - h / 2;
  else if (dky === 'center') out.y = dy + dh / 2;
  return out;
}
function hasDock(dock) {
  return !!(dock && (dock.x || dock.y));
}
// The renderer asks for the off-screen guard to be skipped on a resize
// that is deliberately larger than the overlay actually needs (see
// ovSyncWindowToContent in the renderer: the window is grown with
// headroom so that one resize covers many slider steps, instead of one
// native resize per step). Clamping such a window would shove it inward
// to keep the OVERSIZE fully on-screen and drag the overlay along with
// it -- a visible jump caused entirely by empty transparent space. The
// exact fit that follows a moment later is clamped normally.
function noClampRequested(dock) {
  return !!(dock && dock.noClamp);
}
// A resize that must NOT move the window: only its width and height
// change, its top-left corner stays exactly where it is.
//
// Moving a frameless transparent window is the expensive, visibly
// glitchy operation -- far more so than resizing one in place, which is
// why a left- or top-docked overlay (whose x/y never depend on its size)
// was always smooth while a right-docked or centred one was not. The
// renderer places its content from absolute screen coordinates now, so
// it no longer needs the window to sit in any particular spot: it only
// needs the window to be big enough, and to know where it is. That lets
// the one growth at the start of a size gesture be a pure resize.
function anchorTopLeftRequested(dock) {
  return !!(dock && dock.anchorTopLeft);
}

// Moves the actual timer overlay window -- called continuously while
// dragging (see ovPositionMousemove in the renderer) and once more on
// drop. centerX/centerY are the window's target CENTER point in
// absolute screen coordinates (see the note above for why center, not
// top-left); clamped here (not trusted from the renderer) so a fast
// drag that outruns the cursor can't push the window fully off-screen
// where it would become impossible to grab again. Uses the window's
// CURRENT actual size (not a fixed constant) to convert center back to
// the top-left setBounds itself actually needs, since size now varies
// with content -- see resize-timer-overlay-window.
ipcMain.on('move-timer-overlay-window', (_event, centerX, centerY) => {
  if (!timerOverlayWindow || timerOverlayWindow.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  const bounds = timerOverlayWindow.getBounds();
  // Deliberately the OLDER, looser "40px must stay visible" clamp here,
  // NOT clampWindowToDisplay (that one's reserved for resize -- see
  // below) -- dragging is meant to allow tucking the overlay flush
  // against or mostly past an edge if that's where it's wanted, same
  // as before this whole rework. Only growing via resize should be
  // prevented from pushing the window off-screen; freely dragging it
  // there on purpose is a different, intentional case.
  const x = centerX - bounds.width / 2;
  const y = centerY - bounds.height / 2;
  const clampedX = Math.max(
    display.bounds.x - bounds.width + 40,
    Math.min(display.bounds.x + display.bounds.width - 40, Math.round(x))
  );
  const clampedY = Math.max(
    display.bounds.y - bounds.height + 40,
    Math.min(display.bounds.y + display.bounds.height - 40, Math.round(y))
  );
  timerOverlayWindow.setBounds({
    x: clampedX, y: clampedY, width: bounds.width, height: bounds.height
  });
});

// Resizes the timer overlay window to exactly match the bar's own
// current rendered size plus a fixed margin (see OV_WIN_MARGIN_PX in
// the renderer) -- called on the scale slider's release. Grows
// symmetrically from the CENTER (via clampWindowToDisplay) rather than
// anchoring to whichever edge/corner the overlay currently sits near --
// an edge-anchored version was tried, but "which half of the display is
// the center in" is exactly the wrong thing to base that decision on
// for an overlay sitting anywhere close to the screen's own midline (the
// timer's own default position is dead-center horizontally): a tiny
// shift in center position right around that midpoint flips the anchor
// decision from one side to the other, which is what showed up as
// "moves around unpredictably, sometimes up then back down" even for a
// steady, one-directional size change. Growing from the center is
// always the exact same, fully predictable math regardless of where the
// overlay happens to sit -- clampWindowToDisplay still keeps it from
// going off-screen, which was the actual original ask; edge-anchoring
// was a later refinement that turned out less stable than the plain
// version it replaced.
//
// handle (not on) -- returns the ACTUAL resulting center, which the
// renderer uses to correct its own ovWinX/Y (see resizeTimerOverlayWindow
// in preload.js for the fuller reasoning: without this, the renderer's
// own idea of "current center" could silently fall out of sync with
// reality every time clamping actually changed the requested position,
// which then compounded further on every subsequent resize near an
// edge).
ipcMain.handle('resize-timer-overlay-window', (_event, width, height, centerX, centerY, oldWidth, oldHeight, dock) => {
  // No-op on the window itself now: the overlay windows are display-sized
  // and fixed (see createOverlayWindow). The renderer still calls this
  // during startup, so the reply keeps its shape -- the centre it asked
  // for is simply echoed straight back.
  return { centerX, centerY, clampedX: false, clampedY: false };

  if (!timerOverlayWindow || timerOverlayWindow.isDestroyed()) return null;
  const display = screen.getPrimaryDisplay();
  // centerX/centerY come directly from the renderer's own stable
  // tracked ovWinX/Y -- NOT re-derived from timerOverlayWindow.
  // getBounds() -- re-reading already-rounded native bounds and
  // rounding again on top of that, repeatedly, is what caused the
  // overlay to visibly drift toward the bottom-right over many resizes
  // before this was fixed.
  const w = Math.max(40, Math.round(width));
  const h = Math.max(40, Math.round(height));
  // Explicit dock first (see computeDockedCenter). Absolute, exact, and
  // drift-proof: a docked axis is recomputed straight from the display
  // bounds, so it lands on the same pixel every single resize.
  const docked = computeDockedCenter(dock, w, h, display);
  // Fallback for an axis with no dock: the old proximity guess is only
  // consulted when the renderer sent no dock descriptor at all (older
  // renderer). When it DID send one, a null axis genuinely means "free
  // floating" and must be left alone -- guessing there is exactly what
  // used to move an overlay the user had deliberately left in the middle
  // of the screen.
  const anchor = hasDock(dock) ? null
    : computeEdgeAnchoredCenter(centerX, centerY, oldWidth, oldHeight, display, TIMER_OV_WIN_MARGIN_BOTTOM + 15);
  const anchoredCenterX = (docked.x !== null) ? docked.x
    : (anchor && anchor.anchorLeft) ? (anchor.oldLeft + w / 2)
    : (anchor && anchor.anchorRight) ? (anchor.oldRight - w / 2)
    // Free-floating on X: the bar is centred in its window and the
    // window resizes around that same centre, so preserving the centre
    // preserves the bar's on-screen position exactly. Rounded to a whole
    // pixel, and paired with the renderer forcing an EVEN window width
    // (see ovWinSizeForBar), so x = centreX - w/2 lands with no rounding
    // residue and the bar can't shuffle sideways by half a pixel as the
    // width's parity flips during a Size drag.
    : Math.round(centerX);
  const anchoredCenterY = (docked.y !== null) ? docked.y
    : (anchor && anchor.anchorTop) ? (anchor.oldTop + h / 2)
    : (anchor && anchor.anchorBottom) ? (anchor.oldBottom - h / 2)
    // Free-floating on Y: keep the window's CENTRE fixed. The bar is no
    // longer pinned to the window's top edge -- the window is routinely
    // larger than the bar now, so the renderer centres the bar's box
    // inside it instead (see ovSetBarScale). Those two have to agree:
    // holding the top edge here while the renderer holds the centre
    // meant every height change moved the bar by half the difference,
    // which is one of the ways an overlay jumped out from under the
    // cursor mid-positioning.
    : Math.round(centerY);
  const pos = clampWindowToDisplay(anchoredCenterX, anchoredCenterY, w, h, display, {
    top: TIMER_OV_WIN_MARGIN_TOP, bottom: TIMER_OV_WIN_MARGIN_BOTTOM,
    left: TIMER_OV_WIN_MARGIN_LEFT, right: TIMER_OV_WIN_MARGIN_RIGHT
  });
  // A docked axis is NEVER clamped. The dock target is the user's own
  // explicit intent (they dragged it there and the snap magnet caught
  // it), and it is already exact by construction; letting the generic
  // off-screen guard second-guess it is precisely what used to shove a
  // top-snapped overlay a few pixels down the moment its size changed,
  // and what broke docking outright for an overlay larger than the
  // display in one dimension (where the clamp gives up and pins the
  // window to one fixed edge regardless of what was asked for).
  if (docked.x !== null || noClampRequested(dock)) { pos.x = Math.round(anchoredCenterX - w / 2); pos.clampedX = false; }
  if (docked.y !== null || noClampRequested(dock)) { pos.y = Math.round(anchoredCenterY - h / 2); pos.clampedY = false; }
  if (anchorTopLeftRequested(dock)) {
    // Pure resize -- read the window's real current corner and keep it.
    const keep = timerOverlayWindow.getBounds();
    timerOverlayWindow.setBounds({ x: keep.x, y: keep.y, width: w, height: h });
    return { centerX: keep.x + w / 2, centerY: keep.y + h / 2, clampedX: false, clampedY: false };
  }
  timerOverlayWindow.setBounds({
    x: pos.x,
    y: pos.y,
    width: w,
    height: h
  });
  // Echoes back the EXACT (possibly edge-anchored) requested center on
  // any axis that wasn't actually clamped -- see the long comment on
  // clampWindowToDisplay for why recomputing it from the rounded pixel
  // position every time was itself the source of a slow drift, even
  // nowhere near an edge.
  return {
    centerX: pos.clampedX ? (pos.x + w / 2) : anchoredCenterX,
    centerY: pos.clampedY ? (pos.y + h / 2) : anchoredCenterY
  };
});

// ----- map overlay window repositioning + dynamic sizing -- same
// center-anchored system as the timer's own three handlers just above
// (see the long note above get-timer-overlay-geometry for why center,
// not top-left), mirrored here for the map overlay window. -----
ipcMain.handle('get-map-overlay-geometry', () => {
  const display = screen.getPrimaryDisplay();
  let currentCenterX = display.bounds.x + MAP_OV_WIN_W / 2;
  let currentCenterY = display.bounds.y + MAP_OV_WIN_H / 2;
  if (mapOverlayWindow && !mapOverlayWindow.isDestroyed()) {
    const bounds = mapOverlayWindow.getBounds();
    currentCenterX = bounds.x + bounds.width / 2;
    currentCenterY = bounds.y + bounds.height / 2;
  }
  return {
    currentCenterX: currentCenterX,
    currentCenterY: currentCenterY,
    displayX: display.bounds.x,
    displayY: display.bounds.y,
    displayW: display.bounds.width,
    displayH: display.bounds.height
  };
});

ipcMain.on('move-map-overlay-window', (_event, centerX, centerY) => {
  if (!mapOverlayWindow || mapOverlayWindow.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  const bounds = mapOverlayWindow.getBounds();
  // Same "old looser 40px clamp for dragging" reasoning as the timer's
  // own move handler above -- clampWindowToDisplay stays reserved for
  // resize only.
  const x = centerX - bounds.width / 2;
  const y = centerY - bounds.height / 2;
  const clampedX = Math.max(
    display.bounds.x - bounds.width + 40,
    Math.min(display.bounds.x + display.bounds.width - 40, Math.round(x))
  );
  const clampedY = Math.max(
    display.bounds.y - bounds.height + 40,
    Math.min(display.bounds.y + display.bounds.height - 40, Math.round(y))
  );
  mapOverlayWindow.setBounds({
    x: clampedX, y: clampedY, width: bounds.width, height: bounds.height
  });
});

// handle (not on) -- see the timer's own resize handler above for why
// this returns the actual resulting center.
ipcMain.handle('resize-map-overlay-window', (_event, width, height, centerX, centerY, oldWidth, oldHeight, dock) => {
  // No-op on the window itself now: the overlay windows are display-sized
  // and fixed (see createOverlayWindow). The renderer still calls this
  // during startup, so the reply keeps its shape -- the centre it asked
  // for is simply echoed straight back.
  return { centerX, centerY, clampedX: false, clampedY: false };

  if (!mapOverlayWindow || mapOverlayWindow.isDestroyed()) return null;
  const display = screen.getPrimaryDisplay();
  const w = Math.max(40, Math.round(width));
  const h = Math.max(40, Math.round(height));
  // Same explicit-dock-first system as the timer's handler above -- see
  // computeDockedCenter for why guessing from edge proximity had to go.
  // It mattered even more here: the map's tolerance was MAP_OV_WIN_MARGIN_PX
  // + 15 = 75px, wide enough that a large map centred on a 1080p screen
  // satisfied "near the top" AND "near the bottom" simultaneously and got
  // silently anchored to the top, and wide enough that a map merely
  // parked near an edge was treated as glued to it.
  const docked = computeDockedCenter(dock, w, h, display);
  const anchor = hasDock(dock) ? null
    : computeEdgeAnchoredCenter(centerX, centerY, oldWidth, oldHeight, display, MAP_OV_WIN_MARGIN_PX + 15);
  const anchoredCenterX = (docked.x !== null) ? docked.x
    : (anchor && anchor.anchorLeft) ? (anchor.oldLeft + w / 2)
    : (anchor && anchor.anchorRight) ? (anchor.oldRight - w / 2)
    : centerX;
  const anchoredCenterY = (docked.y !== null) ? docked.y
    : (anchor && anchor.anchorTop) ? (anchor.oldTop + h / 2)
    : (anchor && anchor.anchorBottom) ? (anchor.oldBottom - h / 2)
    : centerY;
  const pos = clampWindowToDisplay(anchoredCenterX, anchoredCenterY, w, h, display, MAP_OV_WIN_MARGIN_PX);
  // Docked axes bypass the clamp entirely -- see the timer handler.
  if (docked.x !== null || noClampRequested(dock)) { pos.x = Math.round(anchoredCenterX - w / 2); pos.clampedX = false; }
  if (docked.y !== null || noClampRequested(dock)) { pos.y = Math.round(anchoredCenterY - h / 2); pos.clampedY = false; }
  if (anchorTopLeftRequested(dock)) {
    // Pure resize -- read the window's real current corner and keep it.
    const keep = mapOverlayWindow.getBounds();
    mapOverlayWindow.setBounds({ x: keep.x, y: keep.y, width: w, height: h });
    return { centerX: keep.x + w / 2, centerY: keep.y + h / 2, clampedX: false, clampedY: false };
  }
  mapOverlayWindow.setBounds({
    x: pos.x,
    y: pos.y,
    width: w,
    height: h
  });
  // Same "echo back the exact requested center unless genuinely
  // clamped" fix as the timer's own resize handler above.
  return {
    centerX: pos.clampedX ? (pos.x + w / 2) : anchoredCenterX,
    centerY: pos.clampedY ? (pos.y + h / 2) : anchoredCenterY
  };
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
  // Flips ONLY which side is currently active -- nothing about the
  // timers' own elapsed values, names, scores, or colors moves at all
  // anymore. This used to swap matchT1Elapsed/matchT2Elapsed (making
  // it look like the two sides' running times had traded places); now
  // it's a pure handoff of which physical input (Start/Crouch/M1)
  // controls which side going forward -- Player 1's box always stays
  // Player 1's box, Player 2's always stays Player 2's, only the
  // active-timer indicator (see the renderer's own activeTimer-based
  // ".active" class) moves to reflect the new input target.
  matchActiveTimer = matchActiveTimer === 1 ? 2 : 1;
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
