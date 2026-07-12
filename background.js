const DEFAULT_MAX_TABS = 9999;

// How long to keep buffering tabs from a closing window before finalising the
// group. tabs.onRemoved fires per-tab; we collect them and flush once the burst
// settles (or when windows.onRemoved confirms the window is gone).
const WINDOW_FLUSH_MS = 250;

// Live tab cache: tabId -> { title, url, favIconUrl, groupId }
const tabCache = new Map();

// Live tab-group metadata: groupId -> { title, color, collapsed }. Captured
// while groups exist so we can rebuild them after a window is closed (the group
// is gone by the time tabs.onRemoved fires).
const groupCache = new Map();

// Windows currently closing: windowId -> { tabs: [...], timer }
const closingWindows = new Map();

// The tabGroups WebExtensions API is recent; degrade gracefully if unavailable.
const hasTabGroups = typeof browser !== 'undefined' && !!browser.tabGroups;

function shouldSkip(url) {
  if (!url) return true;
  return url.startsWith('about:') || url.startsWith('moz-extension:') || url === 'chrome://newtab/';
}

// A real group id is a non-negative number; ungrouped tabs report -1 (or the
// property is absent on older Firefox).
function groupIdOf(tab) {
  return (typeof tab.groupId === 'number' && tab.groupId >= 0) ? tab.groupId : null;
}

async function cacheGroup(groupId) {
  if (!hasTabGroups || groupId == null) return;
  try {
    const g = await browser.tabGroups.get(groupId);
    groupCache.set(groupId, { title: g.title || '', color: g.color, collapsed: !!g.collapsed });
  } catch (_) { /* group may have just been removed */ }
}

// A serialisable group descriptor for a single stored tab (its original group
// id plus the cached metadata), or null when the tab wasn't grouped. A lone tab
// can still belong to a group, so single-tab entries carry this too.
function groupDescriptor(groupId) {
  if (groupId == null || !groupCache.has(groupId)) return null;
  return { id: groupId, ...groupCache.get(groupId) };
}

function cacheTab(tab) {
  if (tab && tab.id && !shouldSkip(tab.url)) {
    const groupId = groupIdOf(tab);
    tabCache.set(tab.id, {
      title: tab.title || tab.url,
      url: tab.url,
      favIconUrl: tab.favIconUrl && !tab.favIconUrl.startsWith('data:') ? tab.favIconUrl : null,
      groupId,
      private: !!tab.incognito,
    });
    if (groupId != null) cacheGroup(groupId); // refresh metadata, fire-and-forget
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

// Find a window still in Firefox's closed-session buffer whose tabs best match
// the given URLs, returning its sessionId (or null). Used both to record the
// sessionId at close time (minMatches = 1) and to re-discover it at restore time
// for entries saved before session capture existed (a stricter minMatches, to
// avoid restoring the wrong window). Best-effort: the buffer is small and ages
// out, so this is often null, in which case restore rebuilds from URLs.
async function matchClosedWindow(urls, minMatches) {
  if (!browser.sessions || !browser.sessions.getRecentlyClosed) return null;
  try {
    const recent = await browser.sessions.getRecentlyClosed({ maxResults: 25 });
    const wanted = new Set(urls);
    let best = null, bestScore = 0;
    for (const s of recent) {
      const w = s.window;
      if (!w || !w.sessionId || !Array.isArray(w.tabs)) continue;
      // Score by how many of our URLs this closed window contains; the buffered
      // tabs exclude about:/moz-extension: pages, so counts won't be exact.
      let score = 0;
      for (const t of w.tabs) if (wanted.has(t.url)) score++;
      if (score > bestScore) { bestScore = score; best = w.sessionId; }
    }
    return bestScore >= minMatches ? best : null;
  } catch (_) {
    return null;
  }
}

async function flushWindow(windowId) {
  const buf = closingWindows.get(windowId);
  if (!buf) return;
  clearTimeout(buf.timer);
  closingWindows.delete(windowId);

  const tabs = buf.tabs;
  if (tabs.length === 0) return;

  const closedAt = Date.now();
  const isPrivate = !!buf.private;

  // A window that only had one (non-skipped) tab is just a normal single close,
  // but it may still have been in a group, so preserve that.
  if (tabs.length === 1) {
    const { title, url, favIconUrl, groupId } = tabs[0];
    const group = groupDescriptor(groupId);
    enqueue(() => pushEntry({ type: 'tab', title, url, favIconUrl, closedAt, ...(group && { group }), ...(isPrivate && { private: true }) }));
    return;
  }

  // Collect the metadata for every group represented among the closed tabs.
  const groups = {};
  for (const t of tabs) {
    if (t.groupId != null && groupCache.has(t.groupId) && !(t.groupId in groups)) {
      groups[t.groupId] = groupCache.get(t.groupId);
    }
  }

  // Private windows are never in Firefox's closed-session buffer, so don't try
  // to match one (it could only match an unrelated normal window); restore will
  // rebuild from the stored URLs.
  const sessionId = isPrivate ? null : await matchClosedWindow(tabs.map(t => t.url), 1);
  enqueue(() => pushEntry({ type: 'window', closedAt, tabs, groups, sessionId, ...(isPrivate && { private: true }) }));
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
    // lastModified is in seconds; convert to ms. Keep data: URIs because Firefox
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
        // Keep Firefox's sessionId so these can still be restored natively (with
        // groups etc.) while they remain in the session buffer.
        : { type: 'window', closedAt, tabs: wtabs, sessionId: s.window.sessionId || null });
    }
  }

  if (seeded.length > 0) {
    await browser.storage.local.set({ closedTabs: seeded });
  }
}

init();

// Restore a closed window. Done in the background (not the popup) because
// opening the new window steals focus and closes the popup, which would abort a
// multi-step restore.
//
// Two strategies, best first:
//   1. Native session restore: if we recorded Firefox's sessionId and it's
//      still in the closed-session buffer, browser.sessions.restore() brings the
//      window back with FULL fidelity: tab groups, scroll position, form data,
//      pinned/container state, and even file:// tabs (native restore isn't
//      subject to the extension API's URL restrictions).
//   2. URL rebuild: reconstruct the window from stored URLs and re-create the
//      tab groups we captured. This is the only option for windows that have
//      aged out of the session buffer, but it CANNOT reopen file:// (or other
//      privileged) tabs: Firefox refuses to let an extension navigate to them,
//      so those are reported back as `failed` and remain in history.
async function restoreWindowEntry(entry) {
  // Private windows aren't captured in Firefox's session buffer, so there's no
  // sessionId to restore natively, so always rebuild into a fresh private window.
  if (entry && entry.private) return rebuildWindow(entry);

  if (browser.sessions && browser.sessions.restore) {
    // Prefer the sessionId captured at close; otherwise try to re-discover the
    // window in Firefox's closed-session buffer (helps entries saved before
    // session capture existed, e.g. your current 59-tab window). Require a
    // strong URL match there so we don't restore an unrelated window.
    let sessionId = entry && entry.sessionId;
    if (!sessionId && entry && Array.isArray(entry.tabs)) {
      const urls = entry.tabs.map(t => t.url);
      sessionId = await matchClosedWindow(urls, Math.max(2, Math.ceil(urls.length * 0.7)));
    }
    if (sessionId) {
      try {
        await browser.sessions.restore(sessionId);
        return { via: 'session', failed: [] };
      } catch (_) {
        // Aged out of the session buffer; fall through to a URL rebuild.
      }
    }
  }
  return rebuildWindow(entry);
}

async function rebuildWindow(entry) {
  const tabs = entry.tabs || [];
  const items = tabs.map((t, index) => ({ ...t, index }));
  // http/https URLs go in one fast, native windows.create batch. Anything else
  // (file://, about:, moz-extension:, …) is opened separately: the batch form
  // rejects the *entire* window if a single URL is one it won't accept.
  const batch = items.filter(it => /^https?:\/\//i.test(it.url));
  const deferred = items.filter(it => !/^https?:\/\//i.test(it.url));

  // Reopen a private window's tabs back into a private window. If the user has
  // since revoked "Run in Private Windows", windows.create rejects, so surface
  // every URL as failed rather than crashing the restore.
  const createProps = entry.private ? { incognito: true } : {};
  let win;
  try {
    win = batch.length
      ? await browser.windows.create({ ...createProps, url: batch.map(it => it.url) })
      : await browser.windows.create({ ...createProps });
  } catch (err) {
    console.warn('Reopener: could not open window', err && err.message);
    return { via: 'rebuild', failed: items.map(it => it.url) };
  }
  // Only an empty (no-batch) window carries a placeholder new-tab to clean up.
  const blankTabId = batch.length ? null : (win.tabs && win.tabs[0] && win.tabs[0].id);

  // Track created tabs so we can regroup them. Batch tabs come back in url order.
  const created = [];
  if (batch.length && win.tabs) {
    win.tabs.forEach((tab, i) => {
      if (batch[i]) created.push({ tabId: tab.id, groupId: batch[i].groupId ?? null, index: batch[i].index });
    });
  }

  const failed = [];
  for (const it of deferred.sort((a, b) => a.index - b.index)) {
    try {
      const tab = await browser.tabs.create({ windowId: win.id, url: it.url, index: it.index, active: false });
      created.push({ tabId: tab.id, groupId: it.groupId ?? null, index: it.index });
    } catch (err) {
      console.warn('Reopener: could not reopen', it.url, err && err.message);
      failed.push(it.url);
    }
  }

  // Remove the placeholder, but not if it's the only tab (Firefox closes an
  // empty window).
  if (blankTabId != null && failed.length < tabs.length) {
    await browser.tabs.remove(blankTabId).catch(() => {});
  }

  await rebuildGroups(win.id, created, entry.groups || {});
  return { via: 'rebuild', failed };
}

// Put restored tabs into a group. Rejoins the original group if it still exists
// (e.g. a single tab reopened into the very window it was closed from); failing
// that, creates a fresh group with the saved title/colour. Best-effort.
async function attachToGroup(windowId, tabIds, origGroupId, meta) {
  if (!hasTabGroups || !browser.tabs.group || !tabIds.length) return;

  if (origGroupId != null) {
    try {
      // Rejoin the original group only if it still exists in this same window;
      // grouping into a group in another window would drag the tab over there.
      const g = await browser.tabGroups.get(origGroupId);
      if (g && g.windowId === windowId) {
        await browser.tabs.group({ tabIds, groupId: origGroupId });
        return; // rejoined the original group, keeping its own title/colour
      }
    } catch (_) { /* group is gone; fall through and make a new one */ }
  }

  try {
    const newGroupId = await browser.tabs.group({ tabIds, createProperties: { windowId } });
    if (meta) {
      await browser.tabGroups.update(newGroupId, {
        title: meta.title || '',
        color: meta.color,
        collapsed: !!meta.collapsed,
      });
    }
  } catch (err) {
    console.warn('Reopener: could not group restored tabs', err && err.message);
  }
}

// Re-create every captured group in a rebuilt window. Best-effort: does nothing
// if the tabGroups API is unavailable or the entry predates group capture.
async function rebuildGroups(windowId, created, groups) {
  // Bucket restored tabs by their original group id, preserving tab order.
  const byGroup = new Map();
  for (const c of created.slice().sort((a, b) => a.index - b.index)) {
    if (c.groupId == null) continue;
    if (!byGroup.has(c.groupId)) byGroup.set(c.groupId, []);
    byGroup.get(c.groupId).push(c.tabId);
  }
  for (const [origGroupId, tabIds] of byGroup) {
    // The window is freshly created, so the original group never still exists
    // here; pass null so a new group is always made with the stored metadata.
    await attachToGroup(windowId, tabIds, null, groups[origGroupId]);
  }
}

// Reopen a closed tab natively from Firefox's session buffer, matching by URL.
// Native restore isn't bound by the extension API's URL restrictions, so this
// can bring back file:// and other privileged pages. Returns whether it worked
// (false if sessions are unavailable or the tab has aged out of the buffer).
async function restoreTabFromSession(url) {
  if (!browser.sessions || !browser.sessions.getRecentlyClosed || !browser.sessions.restore) {
    return false;
  }
  try {
    const recent = await browser.sessions.getRecentlyClosed({ maxResults: 25 });
    const match = recent.find(s => s.tab && s.tab.sessionId && s.tab.url === url);
    if (!match) return false;
    await browser.sessions.restore(match.tab.sessionId);
    return true;
  } catch (_) {
    return false;
  }
}

// Restore a single closed tab, re-grouping it if it was in a group.
async function restoreTabEntry({ url, group, private: isPrivate }) {
  // A private tab can't be recreated with browser.tabs.create (no incognito
  // option) and was never in the session buffer, so open it in its own private
  // window. Fails gracefully if private access has since been revoked.
  if (isPrivate) {
    if (!/^https?:\/\//i.test(url)) return { failed: [url] };
    try {
      await browser.windows.create({ incognito: true, url });
      return { failed: [] };
    } catch (err) {
      console.warn('Reopener: could not reopen private tab', url, err && err.message);
      return { failed: [url] };
    }
  }

  // Prefer Firefox's native restore whenever the tab is still in the session
  // buffer: it brings the tab back with its scroll position and form data (and
  // works for file:// and other privileged pages too). It reopens in the tab's
  // original window.
  if (await restoreTabFromSession(url)) return { failed: [] };

  // Aged out of the buffer; rebuild it ourselves. Only http/https can be opened
  // via the API; file:// and privileged pages have no fallback.
  if (!/^https?:\/\//i.test(url)) {
    console.warn('Reopener: could not reopen', url, '(unopenable and not in session buffer)');
    return { failed: [url] };
  }
  let tab;
  try {
    tab = await browser.tabs.create({ url });
  } catch (err) {
    console.warn('Reopener: could not reopen', url, err && err.message);
    return { failed: [url] };
  }
  if (group) await attachToGroup(tab.windowId, [tab.id], group.id ?? null, group);
  return { failed: [] };
}

browser.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === 'restoreWindow') return restoreWindowEntry(msg.entry);
  if (msg.type === 'restoreTab') return restoreTabEntry(msg);
});

// ── Reconcile "restore previous session" ───────────────────────────────────
// With that setting on, quitting Firefox closes every window (which we capture)
// and relaunching reopens them, so the shutdown captures are phantom entries
// for windows that were never really closed. There's no shutdown event for a
// persistent background script, so instead we reconcile when the background
// loads: wait for any session restore to settle, then drop the just-captured
// window entries that match a window that is currently open.
//
// Running on load (rather than only runtime.onStartup) is both correct and
// covers temporarily-loaded add-ons, which aren't running at browser launch and
// so never get onStartup: re-adding one after a relaunch triggers this instead.
// It's safe to run on every load because we only ever delete a *closed*-window
// entry when a matching window is *currently open*, which, outside a session
// restore, never happens (a window you closed isn't also open).
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function openUrlSet(win) {
  return new Set((win.tabs || []).map(t => t.url).filter(u => !shouldSkip(u)));
}

// Poll until session restore stops adding windows and tabs, then return each
// window's set of restorable URLs. Firefox replays windows one at a time, so
// keying on the tab count alone (or settling after a single brief pause) can
// snapshot mid-restore and miss the windows that come back last; those windows
// then keep their phantom entries forever. To avoid that we (a) fold the window
// count into the stability signature so a new window always resets the counter,
// (b) never settle on the initial empty state before any tab has been restored,
// and (c) require a longer quiet period across more ticks.
async function snapshotRestoredWindows() {
  let prev = '', stableTicks = 0;
  for (let i = 0; i < 40; i++) {
    const wins = await browser.windows.getAll({ populate: true });
    const tabTotal = wins.reduce((n, w) => n + (w.tabs ? w.tabs.length : 0), 0);
    const sig = wins.length + '/' + tabTotal;
    if (sig === prev && tabTotal > 0) {
      if (++stableTicks >= 3) return wins.map(openUrlSet);
    } else {
      stableTicks = 0;
      prev = sig;
    }
    await delay(500);
  }
  const wins = await browser.windows.getAll({ populate: true });
  return wins.map(openUrlSet);
}

// Does a captured window entry correspond to this restored window's URLs? Nearly
// all of the entry's tabs must be present and the open window must not be much
// bigger (i.e. the same window, not a superset that merely contains them).
function windowMatches(entry, openSet) {
  const urls = entry.tabs.map(t => t.url).filter(u => !shouldSkip(u));
  if (urls.length === 0) return false;
  let matched = 0;
  for (const u of urls) if (openSet.has(u)) matched++;
  return matched >= Math.ceil(urls.length * 0.8) && openSet.size <= urls.length + 3;
}

async function pruneRestoredWindows(openSets) {
  const { closedTabs = [] } = await browser.storage.local.get('closedTabs');
  const windowEntries = closedTabs.filter(e => e.type === 'window');
  if (windowEntries.length === 0) return;

  // Only touch the final shutdown burst: entries closed at essentially the same
  // moment as the most recent window entry. This protects windows genuinely
  // closed earlier that happen to share URLs with a restored one.
  const shutdownAt = windowEntries.reduce((m, e) => Math.max(m, e.closedAt), 0);
  const BURST_MS = 5000;

  const remaining = openSets.slice();
  const drop = new Set();
  for (const entry of closedTabs) {
    if (entry.type !== 'window' || shutdownAt - entry.closedAt > BURST_MS) continue;
    const idx = remaining.findIndex(set => windowMatches(entry, set));
    if (idx !== -1) {
      remaining.splice(idx, 1);   // each restored window accounts for one entry
      drop.add(entry);
    }
  }

  if (drop.size > 0) {
    await browser.storage.local.set({ closedTabs: closedTabs.filter(e => !drop.has(e)) });
  }
}

async function reconcileRestoredSession() {
  try {
    const { closedTabs = [] } = await browser.storage.local.get('closedTabs');
    if (!closedTabs.some(e => e.type === 'window')) return; // nothing prunable
    const openSets = await snapshotRestoredWindows();
    await enqueue(() => pruneRestoredWindows(openSets));
  } catch (err) {
    console.error('Reopener:', err);
  }
}

reconcileRestoredSession();

// The settle-poll above can only wait so long before it must snapshot, and
// Firefox sometimes replays the last window of a session well after the others.
// On a real browser start (runtime.onStartup fires only then, i.e. exactly when
// "restore previous session" is replaying windows) watch for new windows for a
// short grace period and re-prune as each one appears, so a late-restored window
// still clears its phantom entry. This only adds coverage: the load-time
// reconcile above still runs on every load, including for temporarily-loaded
// add-ons re-added after a relaunch, which never receive onStartup.
async function pruneAgainstOpenWindows() {
  try {
    const { closedTabs = [] } = await browser.storage.local.get('closedTabs');
    if (!closedTabs.some(e => e.type === 'window')) return; // nothing prunable
    const wins = await browser.windows.getAll({ populate: true });
    await enqueue(() => pruneRestoredWindows(wins.map(openUrlSet)));
  } catch (err) {
    console.error('Reopener:', err);
  }
}

if (browser.runtime && browser.runtime.onStartup) {
  browser.runtime.onStartup.addListener(() => {
    let debounce = null;
    const onCreated = () => {
      // Debounce so a freshly-restored window's tabs have a moment to populate
      // before we test it against the phantom entries.
      clearTimeout(debounce);
      debounce = setTimeout(pruneAgainstOpenWindows, 1000);
    };
    browser.windows.onCreated.addListener(onCreated);
    // Once the session has had time to finish restoring, stop watching and do a
    // final sweep for anything that landed right at the end of the grace period.
    setTimeout(() => {
      browser.windows.onCreated.removeListener(onCreated);
      clearTimeout(debounce);
      pruneAgainstOpenWindows();
    }, 30000);
  });
}

browser.tabs.onCreated.addListener(cacheTab);
browser.tabs.onUpdated.addListener((_id, _info, tab) => cacheTab(tab));

browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
  const info = tabCache.get(tabId);
  tabCache.delete(tabId);

  if (!info || shouldSkip(info.url)) return;

  // The private flag is a window-level property (see flushWindow), so it isn't
  // stored per child tab, only on the resulting tab/window entry.
  const record = { title: info.title, url: info.url, favIconUrl: info.favIconUrl, groupId: info.groupId ?? null };

  if (removeInfo.isWindowClosing) {
    // Buffer tabs from the same closing window into one group.
    let buf = closingWindows.get(removeInfo.windowId);
    if (!buf) {
      buf = { tabs: [], private: !!info.private };
      closingWindows.set(removeInfo.windowId, buf);
    }
    buf.tabs.push(record);
    clearTimeout(buf.timer);
    buf.timer = setTimeout(() => flushWindow(removeInfo.windowId), WINDOW_FLUSH_MS);
  } else {
    const { title, url, favIconUrl, groupId } = record;
    const group = groupDescriptor(groupId);
    enqueue(() => pushEntry({ type: 'tab', title, url, favIconUrl, closedAt: Date.now(), ...(group && { group }), ...(info.private && { private: true }) }));
  }
});

// windows.onRemoved confirms a window is fully gone, so flush immediately rather
// than waiting on the debounce timer.
browser.windows.onRemoved.addListener(flushWindow);
