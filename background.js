const DEFAULT_MAX_TABS = 9999;

// Live tab cache: tabId -> { title, url, favIconUrl }
const tabCache = new Map();

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

// On startup: seed the live tab cache, and pre-populate closed-tab history
// from Firefox's built-in session store if our store is empty.
async function init() {
  const tabs = await browser.tabs.query({});
  tabs.forEach(cacheTab);

  const { closedTabs } = await browser.storage.local.get('closedTabs');
  if (closedTabs && closedTabs.length > 0) return; // already have history

  const sessions = await browser.sessions.getRecentlyClosed();
  const seeded = sessions
    .filter(s => s.tab && !shouldSkip(s.tab.url))
    .map(s => ({
      title: s.tab.title || s.tab.url,
      url: s.tab.url,
      // Keep data: URIs here — Firefox stores favicons this way in the session
      // store, and we only seed ~25 tabs so storage cost is negligible.
      favIconUrl: s.tab.favIconUrl || null,
      // lastModified is in seconds; convert to ms
      closedAt: (s.tab.lastModified || Math.floor(Date.now() / 1000)) * 1000,
    }));

  if (seeded.length > 0) {
    await browser.storage.local.set({ closedTabs: seeded });
  }
}

init();

browser.tabs.onCreated.addListener(cacheTab);

browser.tabs.onUpdated.addListener((_id, _info, tab) => cacheTab(tab));

browser.tabs.onRemoved.addListener(async (tabId) => {
  const info = tabCache.get(tabId);
  tabCache.delete(tabId);

  if (!info || shouldSkip(info.url)) return;

  const { closedTabs = [], maxTabs = DEFAULT_MAX_TABS } =
    await browser.storage.local.get(['closedTabs', 'maxTabs']);

  closedTabs.unshift({
    title: info.title,
    url: info.url,
    favIconUrl: info.favIconUrl,
    closedAt: Date.now(),
  });

  if (closedTabs.length > maxTabs) closedTabs.length = maxTabs;

  await browser.storage.local.set({ closedTabs });
});
