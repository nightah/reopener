# Reopener

A Firefox extension that tracks every tab you close and lets you find and restore them instantly.

## Features

- **Unlimited history**: remembers up to 9,999 closed tabs by default (configurable)
- **Fuzzy search**: search by page title or URL; results rank title matches above URL matches
- **Window grouping**: closing a whole window is captured as one group showing its tab count, with expand/collapse. Restore the entire window in one click, or expand it and restore individual tabs
- **Full-fidelity restore**: restoring a window prefers Firefox's own session store, bringing back tab groups, scroll position, form data, pinned/container state, and even local `file://` tabs. When the window has aged out of Firefox's session buffer, it rebuilds from stored URLs and re-creates the tab groups it captured
- **Tab-group aware**: remembers each tab's group (name and colour), including for single tabs, and puts them back in their groups on restore
- **Private windows**: when you allow Reopener to run in private windows, it remembers closed private tabs and windows too, tags them with a **Private** badge, and reopens them back into a private window. A dedicated "Clear all private history" action (shown only when relevant) wipes just those
- **Session-restore friendly**: if you quit with "restore previous session" enabled, the windows Firefox brings back are not left behind as phantom closed-window entries
- **Right-click actions**: right-click any entry for a quick Open / Delete menu
- **Flexible clearing**: clear all history, only the tabs matching your current search, or everything closed within the last N minutes (each confirmed first)
- **Favicons**: displays cached favicons with Google's favicon service as a fallback
- **Relative timestamps**: see how long ago each tab was closed at a glance
- **Keyboard navigation**: arrow keys to move, Enter to open, Delete to remove, and left/right to collapse/expand a window
- **Seeded on install**: pre-populated from Firefox's built-in session history (closed tabs and windows) the first time it runs
- **Light, dark and auto themes**: follows your OS appearance or pin to either mode
- **Lightweight**: no external dependencies, no background network requests

## Screenshots

### Dark mode

![Reopener popup in dark mode](screenshots/dark.png)

### Light mode

![Reopener popup in light mode](screenshots/light.png)

Closed windows appear as expandable groups (shown here collapsed and expanded).

### Search

Type to instantly filter by title or URL. Matching characters are highlighted and results are counted. Search reaches into closed windows too; results that came from a window are tagged with a **Window** badge you can click to restore the whole set. Entries closed from a private window carry a **Private** badge.

![Fuzzy search filtering by "github"](screenshots/search.png)

### Right-click menu

Right-click any entry for a quick Open or Delete action.

![Right-click context menu with Open and Delete](screenshots/context-menu.png)

### Clearing history

The trash icon opens a menu to clear everything, just the tabs matching your current search, or anything closed within the last few minutes.

![Clear history dropdown menu](screenshots/clear-menu.png)

## Installation

### Firefox Add-ons (recommended)

Install directly from [addons.mozilla.org](https://addons.mozilla.org). Search for **Reopener**.

### Manual (developer mode)

1. Clone or download this repository
2. Open Firefox and go to `about:debugging`
3. Click **This Firefox** in the sidebar
4. Click **Load Temporary Add-on...**
5. Select the `manifest.json` file from this directory

## Usage

Click the **Reopener** button in the Firefox toolbar to open the popup.

| Action | Key |
|---|---|
| Move selection down | `↓` |
| Move selection up | `↑` |
| Expand / collapse a window group | `→` / `←` |
| Open selected entry | `Enter` |
| Remove selected entry | `Delete` |
| Dismiss a menu | `Esc` |

The first result is always pre-selected so you can hit Enter immediately to reopen the most recently closed tab.

**Window groups**: a closed window shows as a "Window" row with its tab count and a `+` / `−` toggle. Click the toggle to expand it and see the individual tabs; click the row itself to restore the whole window (after confirming). Inside an expanded group, clicking a tab restores just that one into the current window.

**How restore works**: when you restore a window, Reopener first tries to reopen it through Firefox's session store, which brings the window back exactly as it was, including tab groups, scroll position, form data, pinned/container tabs, and local `file://` pages. If the window is no longer in Firefox's session buffer (for example an older entry), Reopener rebuilds it from the stored URLs and re-creates its tab groups; in that case `file://` and other privileged pages cannot be reopened by an extension and are left in your history with a note.

Restoring an **individual tab** works the same way: if the tab is still in Firefox's session buffer it is reopened natively (restoring its scroll position and form data, and working even for `file://` pages); otherwise Reopener recreates it from the stored URL and puts it back in its original group. A `file://` or privileged page that has aged out of Firefox's session buffer cannot be reopened by an extension; Reopener copies its address to your clipboard so you can paste it into the address bar (`Ctrl+L`, then `Ctrl+V` and `Enter`), and it stays in your history for reference.

**Right-click** any row for an **Open** / **Delete** menu.

**Clearing history**: the trash icon next to the settings gear opens a menu with three options, each of which asks for confirmation:

- **Clear searched history**: removes only the tabs matching your current search (enabled when a search is active)
- **Clear recent**: removes everything closed within the last N minutes
- **Clear all private history**: removes only entries closed from private windows (shown when Reopener is allowed in private windows, or any private entries exist)
- **Clear all history**: wipes everything

## Settings

Open the settings page via the gear icon in the popup, or through `about:addons` → Reopener → Preferences.

| Setting | Default | Description |
|---|---|---|
| Appearance | Auto | Light, Dark, or Auto (follows OS) |
| Expand windows by default | Off | Whether window groups open expanded rather than collapsed |
| Auto-expand threshold | 10 | When the above is on, only windows with this many tabs or fewer auto-expand; larger ones stay collapsed |
| Maximum closed tabs | 9,999 | How many closed tabs to keep in history |
| Clear history | n/a | Wipes all stored tab history (per-search and time-based clearing live in the popup's trash menu) |

## Privacy

All tab history is stored locally in `browser.storage.local` and never leaves your device.

Private (incognito) tabs are only captured if you explicitly allow Reopener to run in private windows (`about:addons` → Reopener → **Run in Private Windows** → *Allow*); it is off by default. When enabled, private tabs are remembered the same way as normal ones, which means their titles and URLs persist locally after the private window closes — use **Clear all private history** to remove them.

When a tab does not have a cached favicon, Reopener falls back to `https://www.google.com/s2/favicons?domain=<hostname>` to fetch one. Only the hostname (e.g. `github.com`) is sent, never the full URL, page title, or any other data.

## License

MIT: see [LICENSE](LICENSE) for details.
