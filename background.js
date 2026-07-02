const DEFAULT_MAX_TABS = 9999;

// How long to keep buffering tabs from a closing window before finalising the
// group. tabs.onRemoved fires per-tab; we collect them and flush once the burst
// settles (or when windows.onRemoved confirms the window is gone).
const WINDOW_FLUSH_MS = 250;

// Live tab cache: tabId -> { title, url, favIconUrl }
const tabCache = new Map();

// Windows currently closing: windowId -> { tabs: [...], timer }
const closingWindows = new Map();

function shouldSkip(url) {
  if (!url) return true;
  return url.startsWith('about:') || url.startsWith('moz-extension:') || url === 'chrome://newtab/';
}

function cacheTab(tab) {
  if (tab && tab.id && !shouldSkip(tab.url)) {
    tabCache.set(tab.id, {
      title: tab.title || tab.url,
      url: tab.url,
      favIconUrl: tab.favIconUrl && !tab.favIconUrl.startsWith('data:') ? tab.favIconUrl : null,
    });
  }
}

function tabCount(entry) {
  return entry.type === 'window' ? entry.tabs.length : 1;
}

// Serialise all storage mutations through one promise chain. Closing a window
// fires many events at once; without this they would race on read-modify-write
// and all but the last write would be lost.
let writeChain = Promise.resolve();
function enqueue(task) {
  writeChain = writeChain.then(task).catch(err => console.error('Reopener:', err));
  return writeChain;
}

async function pushEntry(entry) {
  const { closedTabs = [], maxTabs = DEFAULT_MAX_TABS } =
    await browser.storage.local.get(['closedTabs', 'maxTabs']);

  closedTabs.unshift(entry);

  // Trim by total tab count (a window group counts as all its tabs), always
  // keeping the newest entries.
  let total = 0;
  for (let i = 0; i < closedTabs.length; i++) {
    total += tabCount(closedTabs[i]);
    if (total >= maxTabs) { closedTabs.length = i + 1; break; }
  }

  await browser.storage.local.set({ closedTabs });
}

function flushWindow(windowId) {
  const buf = closingWindows.get(windowId);
  if (!buf) return;
  clearTimeout(buf.timer);
  closingWindows.delete(windowId);

  const tabs = buf.tabs;
  if (tabs.length === 0) return;

  const closedAt = Date.now();
  // A window that only had one (non-skipped) tab is just a normal single close.
  const entry = tabs.length === 1
    ? { type: 'tab', ...tabs[0], closedAt }
    : { type: 'window', closedAt, tabs };

  enqueue(() => pushEntry(entry));
}

// On startup: seed the live tab cache, and pre-populate closed-tab history
// from Firefox's built-in session store if our store is empty.
async function init() {
  const tabs = await browser.tabs.query({});
  tabs.forEach(cacheTab);

  const { closedTabs } = await browser.storage.local.get('closedTabs');
  if (closedTabs && closedTabs.length > 0) return; // already have history

  const nowSec = Math.floor(Date.now() / 1000);
  const sessions = await browser.sessions.getRecentlyClosed();
  const seeded = [];

  for (const s of sessions) {
    // lastModified is in seconds; convert to ms. Keep data: URIs — Firefox
    // stores favicons that way in the session store, and we only seed ~25 items.
    if (s.tab && !shouldSkip(s.tab.url)) {
      seeded.push({
        type: 'tab',
        title: s.tab.title || s.tab.url,
        url: s.tab.url,
        favIconUrl: s.tab.favIconUrl || null,
        closedAt: (s.tab.lastModified || nowSec) * 1000,
      });
    } else if (s.window && Array.isArray(s.window.tabs)) {
      const wtabs = s.window.tabs
        .filter(t => !shouldSkip(t.url))
        .map(t => ({ title: t.title || t.url, url: t.url, favIconUrl: t.favIconUrl || null }));
      if (wtabs.length === 0) continue;
      const closedAt = (s.window.lastModified || nowSec) * 1000;
      seeded.push(wtabs.length === 1
        ? { type: 'tab', ...wtabs[0], closedAt }
        : { type: 'window', closedAt, tabs: wtabs });
    }
  }

  if (seeded.length > 0) {
    await browser.storage.local.set({ closedTabs: seeded });
  }
}

init();

browser.tabs.onCreated.addListener(cacheTab);
browser.tabs.onUpdated.addListener((_id, _info, tab) => cacheTab(tab));

browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
  const info = tabCache.get(tabId);
  tabCache.delete(tabId);

  if (!info || shouldSkip(info.url)) return;

  const record = { title: info.title, url: info.url, favIconUrl: info.favIconUrl };

  if (removeInfo.isWindowClosing) {
    // Buffer tabs from the same closing window into one group.
    let buf = closingWindows.get(removeInfo.windowId);
    if (!buf) {
      buf = { tabs: [] };
      closingWindows.set(removeInfo.windowId, buf);
    }
    buf.tabs.push(record);
    clearTimeout(buf.timer);
    buf.timer = setTimeout(() => flushWindow(removeInfo.windowId), WINDOW_FLUSH_MS);
  } else {
    enqueue(() => pushEntry({ type: 'tab', ...record, closedAt: Date.now() }));
  }
});

// windows.onRemoved confirms a window is fully gone — flush immediately rather
// than waiting on the debounce timer.
browser.windows.onRemoved.addListener(flushWindow);
