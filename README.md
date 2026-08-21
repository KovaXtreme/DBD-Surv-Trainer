# DBD Surv Trainer

### ⬇️ [**Click here to download the latest version**](../../releases/latest)

Unofficial desktop tool for Dead by Daylight survivor training — 1v1 timer with an in-game overlay, clock callouts for maps, a moonwalk trainer, and more.

Not affiliated with, endorsed by, or connected to Behaviour Interactive in any way. Dead by Daylight and all related names are trademarks of Behaviour Interactive Inc.

## Download

Grab the latest version from the **[Releases](../../releases)** page of this repository — download `DBD Surv Trainer Setup X.X.X.exe` and install it like any other Windows program.

It isn't digitally signed, so Windows may show a SmartScreen warning ("Windows protected your PC") the first time you run the installer: click **"More info"** then **"Run anyway"**.

## What it does

- **1v1 Timer** with a scoreboard overlay, always on top of the game, editable in-game
- **Map overlay** with clock callouts (from [Hens' Callouts](https://hens333.com/callouts), used with permission), automatic map detection via OCR
- **Moonwalk trainer** and **vault/pallet timing trainer**
- **Keyboard**, **mouse (M1)**, and **Xbox controller (XInput)** hotkeys, all freely rebindable
- Fully customizable overlay colors, position, size, and opacity

## A note on the Shift / M1 hotkeys

As an **optional feature, off by default**, the app can start the timer by pressing Shift or the left mouse button (M1), in addition to the regular F1-F12 keys. To do this, while that option is enabled, the app listens system-wide for those specific key presses — a technique in the same general category as programs like AutoHotkey, which has been reported as detected in some games with anti-cheat systems (including, in some contexts, EasyAntiCheat).

Another popular Dead by Daylight tool with a similar feature (starting a 1v1 timer with Shift), "DBD 1v1 Timer," has publicly stated it uses the same category of technique — confirming this isn't an isolated approach among tools like this, though that's still not a safety guarantee either way.

**Important points:**
- This only applies to people who explicitly enable the "Enable a dedicated Crouch/M1 key" option and bind Shift or M1 to an action. If you never enable it, that part of the code never runs on your PC at all.
- Using **only** the regular hotkeys (F-keys, freely rebindable) and the **controller**, this category of risk doesn't apply: those work through a different mechanism entirely (standard system shortcuts, or periodic polling of the controller's state via XInput, the same API games themselves use).
- The actual risk can't be quantified with certainty — it may well be low in practice, but it can't be ruled out entirely either.

**Disclaimer:** this software is provided "as is," with no warranty of any kind. Using the Shift/M1 feature is a voluntary choice made by whoever enables it. The author accepts no responsibility for any action (bans, suspensions, or otherwise) taken by the game's anti-cheat or developer against anyone using this or any other part of the app.

## Reporting an issue

If something isn't working, open an [Issue](../../issues) on this repository describing what's happening — the more detail you give (screenshots, what you expected, what actually happened), the easier it is to fix.

## Credits

See the Credits section inside the app itself for the full list of acknowledgments.
