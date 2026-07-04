// Apply theme synchronously before first paint to avoid flash
(function () {
  const t = localStorage.getItem('reopener-theme') || 'auto';
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute('data-theme',
    t === 'auto' ? (dark ? 'dark' : 'light') : t);
}());

const DEFAULT_MAX_VISIBLE = 200;

let allEntries = [];              // array of {type:'tab',...} | {type:'window', tabs:[...]}
const expanded = new Set();       // window entry object refs that are expanded
let rows = [];                    // navigable rows for the current render: {el, activate, remove, toggle?}
let selectedIndex = -1;

// Right-click context menu state
let menuEl = null;
let ctxOnOpen = null;
let ctxOnDelete = null;

// Clear-history dropdown
let clearMenuEl = null;

// Whether the add-on is allowed to run in private windows. Cached at load; used
// to decide whether the "Clear all private history" option is worth showing.
let privateAllowed = false;

function isWindow(entry) {
  return entry && entry.type === 'window';
}
function tabCount(entry) {
  return isWindow(entry) ? entry.tabs.length : 1;
}

function relativeTime(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Returns a score > 0 if query matches, 0 if not.
function fuzzyScore(query, title, url) {
  if (!query) return 1;
  const q = query.toLowerCase();
  const titleL = title.toLowerCase();
  const urlL = url.toLowerCase();
  const titleIdx = titleL.indexOf(q);
  if (titleIdx !== -1) return 2000 - titleIdx;
  const urlIdx = urlL.indexOf(q);
  if (urlIdx !== -1) return 1000 - urlIdx;
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every(w => titleL.includes(w) || urlL.includes(w))) return 500;
  return 0;
}

function faviconSrc(item) {
  if (item.favIconUrl) return item.favIconUrl;
  try {
    const { hostname } = new URL(item.url);
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=32`;
  } catch { return null; }
}

function svgEl(width, pathD) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(width));
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', pathD);
  svg.appendChild(path);
  return svg;
}

function makePlaceholderEl() {
  const span = document.createElement('span');
  span.className = 'tab-favicon-placeholder';
  span.appendChild(svgEl(12, 'M2 2h12v12H2V2zm1 1v10h10V3H3zm2 2h6v1H5V5zm0 2h6v1H5V7zm0 2h4v1H5V9z'));
  return span;
}

function makeWindowIconEl() {
  const span = document.createElement('span');
  span.className = 'tab-favicon-placeholder';
  // Stacked windows glyph
  span.appendChild(svgEl(13, 'M3 1h10a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1V2a1 1 0 011-1zm0 2v7h10V3H3zm-1 10h11a1 1 0 01-1 1H2a1 1 0 01-1-1V4a1 1 0 011 1z'));
  return span;
}

function makeWindowBadgeEl(onClick) {
  const span = document.createElement('span');
  span.className = 'from-window';
  span.setAttribute('role', 'button');
  span.title = 'Restore the whole window';
  span.appendChild(svgEl(10, 'M3 1h10a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1V2a1 1 0 011-1zm0 2v7h10V3H3zm-1 10h11a1 1 0 01-1 1H2a1 1 0 01-1-1V4a1 1 0 011 1z'));
  span.appendChild(document.createTextNode('Window'));
  span.addEventListener('click', (e) => {
    e.stopPropagation();   // don't trigger the row's single-tab restore
    onClick();
  });
  return span;
}

// A non-interactive pill marking an entry that came from a private window,
// mirroring the "Window" badge. Firefox calls this "Private" browsing.
function makePrivateBadgeEl() {
  const span = document.createElement('span');
  span.className = 'private-badge';
  span.title = 'Closed from a private window';
  // Domino-mask glyph
  span.appendChild(svgEl(10, 'M8 3C4 3 1.5 4.5 1 6.5c-.3 1.2.2 2.4 1.3 3.1 1 .7 2.3.9 3.3.4.9-.4 1.4-1.2 2.4-1.2s1.5.8 2.4 1.2c1 .5 2.3.3 3.3-.4 1.1-.7 1.6-1.9 1.3-3.1C14.5 4.5 12 3 8 3zM5 8.2a1.3 1.3 0 110-2.6 1.3 1.3 0 010 2.6zm6 0a1.3 1.3 0 110-2.6 1.3 1.3 0 010 2.6z'));
  span.appendChild(document.createTextNode('Private'));
  return span;
}

function makeFaviconEl(item) {
  const src = faviconSrc(item);
  if (!src) return makePlaceholderEl();
  const img = document.createElement('img');
  img.className = 'tab-favicon';
  img.src = src;
  img.alt = '';
  img.addEventListener('error', () => img.replaceWith(makePlaceholderEl()));
  return img;
}

// Appends text to el with the matched portion wrapped in a <mark>.
function appendHighlighted(el, text, query) {
  if (!query) { el.textContent = text; return; }
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) { el.textContent = text; return; }
  if (idx > 0) el.appendChild(document.createTextNode(text.slice(0, idx)));
  const mark = document.createElement('mark');
  mark.textContent = text.slice(idx, idx + query.length);
  el.appendChild(mark);
  if (idx + query.length < text.length) {
    el.appendChild(document.createTextNode(text.slice(idx + query.length)));
  }
}

function saveEntries() {
  return browser.storage.local.set({ closedTabs: allEntries });
}

// ── Restore actions ───────────────────────────────────────
// Group descriptor for a tab inside a window group, or null if ungrouped.
function childGroup(entry, t) {
  if (t.groupId == null || !entry.groups) return null;
  const meta = entry.groups[t.groupId];
  return meta ? { id: t.groupId, ...meta } : null;
}

// Copy text to the clipboard, returning whether it worked. Uses the async
// Clipboard API (granted by the clipboardWrite permission) with an execCommand
// fallback for good measure.
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }
}

// Tell the user about pages that couldn't be reopened (file:// or privileged
// pages that Firefox won't let an extension open and that have aged out of its
// session buffer), and put their addresses on the clipboard so they can paste
// them into the address bar (Ctrl+L, Ctrl+V, Enter).
async function notifyUnreopenable(urls) {
  const n = urls.length;
  const copied = await copyToClipboard(urls.join('\n'));
  const lead = n === 1
    ? `This page couldn't be reopened`
    : `${n} pages couldn't be reopened`;
  let hint;
  if (copied && n === 1) {
    hint = `Its address was copied to your clipboard. Press Ctrl+L, then Ctrl+V and Enter to open it.`;
  } else if (copied) {
    hint = `Their addresses were copied to your clipboard.`;
  } else {
    hint = `Address${n === 1 ? '' : 'es'}:\n${urls.join('\n')}`;
  }
  alert(`${lead}: a local file or privileged page Firefox won't let an extension ` +
        `open, no longer in its recent-session history.\n\n${hint}\n\n` +
        `${n === 1 ? 'It remains' : 'They remain'} in your Reopener history.`);
}

async function restoreTab(url, group, isPrivate) {
  // Routed through the background so it can re-group the tab (and so a file://
  // failure is reported rather than silently swallowed as the popup closes).
  const res = await browser.runtime.sendMessage({ type: 'restoreTab', url, group: group || null, private: !!isPrivate });
  if (res && res.failed && res.failed.length) await notifyUnreopenable(res.failed);
  window.close();
}

async function restoreWindow(entry) {
  const n = entry.tabs.length;
  if (!confirm(`Restore this window with ${n} tab${n === 1 ? '' : 's'}?`)) return;
  // The background script does the restore: opening the window steals focus and
  // closes this popup, which would abort the work if it ran here. It restores
  // natively (tab groups, scroll, form data, file:// tabs) when the window is
  // still in Firefox's session buffer, otherwise rebuilds from stored URLs.
  const res = await browser.runtime.sendMessage({ type: 'restoreWindow', entry });
  if (res && res.failed && res.failed.length) await notifyUnreopenable(res.failed);
  window.close();
}

// ── Deletion ──────────────────────────────────────────────
async function removeEntry(entry) {
  const i = allEntries.indexOf(entry);
  if (i !== -1) allEntries.splice(i, 1);
  expanded.delete(entry);
  await saveEntries();
}

async function removeChildTab(entry, childIndex) {
  entry.tabs.splice(childIndex, 1);
  // The stored window no longer matches Firefox's session snapshot, so drop the
  // sessionId; restore must now rebuild from our (edited) tab list.
  delete entry.sessionId;
  if (entry.tabs.length === 1) {
    // Collapse a one-tab window group back into a plain tab entry, keeping the
    // surviving tab's group membership.
    const only = entry.tabs[0];
    const group = childGroup(entry, only);
    entry.type = 'tab';
    entry.title = only.title;
    entry.url = only.url;
    entry.favIconUrl = only.favIconUrl;
    if (group) entry.group = group; else delete entry.group;
    delete entry.tabs;
    delete entry.groups;
    expanded.delete(entry);
  } else if (entry.tabs.length === 0) {
    const i = allEntries.indexOf(entry);
    if (i !== -1) allEntries.splice(i, 1);
    expanded.delete(entry);
  }
  await saveEntries();
}

// ── Clear history ─────────────────────────────────────────
async function clearSearched(query) {
  const q = (query || '').trim();
  if (!q) return;
  const matchCount = flatten().filter(it => fuzzyScore(q, it.title, it.url) > 0).length;
  if (matchCount === 0) return;
  if (!confirm(`Clear ${matchCount} matching tab${matchCount === 1 ? '' : 's'} from history?`)) return;

  const next = [];
  for (const e of allEntries) {
    if (isWindow(e)) {
      const kept = e.tabs.filter(t => fuzzyScore(q, t.title, t.url) === 0);
      if (kept.length === e.tabs.length) next.push(e);   // untouched, keep sessionId
      else if (kept.length === 1) {
        const only = kept[0];
        const group = childGroup(e, only);
        next.push({ type: 'tab', title: only.title, url: only.url,
          favIconUrl: only.favIconUrl, closedAt: e.closedAt, ...(group && { group }),
          ...(e.private && { private: true }) });
      }
      // Trimmed window: drop the sessionId so restore rebuilds our edited list
      // rather than natively reopening the tabs the user just cleared.
      else if (kept.length > 1) next.push({ ...e, tabs: kept, sessionId: null });
      // 0 kept → drop the group entirely
    } else if (fuzzyScore(q, e.title, e.url) === 0) {
      next.push(e);
    }
  }
  allEntries = next;
  await saveEntries();
  document.getElementById('search').value = '';
  rerender();
}

async function clearRecent(minutes) {
  const cutoff = Date.now() - minutes * 60000;
  const removedTabs = allEntries
    .filter(e => e.closedAt >= cutoff)
    .reduce((n, e) => n + tabCount(e), 0);
  if (removedTabs === 0) { alert('No tabs were closed in that time range.'); return; }
  if (!confirm(`Clear ${removedTabs} tab${removedTabs === 1 ? '' : 's'} closed in the last ${minutes} minute${minutes === 1 ? '' : 's'}?`)) return;
  allEntries = allEntries.filter(e => e.closedAt < cutoff);
  await saveEntries();
  rerender();
}

async function clearAll() {
  if (allEntries.length === 0) return;
  if (!confirm('Clear all closed tab history? This cannot be undone.')) return;
  allEntries = [];
  await saveEntries();
  rerender();
}

async function clearPrivate() {
  // A window is uniformly private, so the entry-level flag covers both plain
  // private tabs and private window groups.
  const removedTabs = allEntries.filter(e => e.private).reduce((n, e) => n + tabCount(e), 0);
  if (removedTabs === 0) { alert('No private tabs in history.'); return; }
  if (!confirm(`Clear ${removedTabs} private tab${removedTabs === 1 ? '' : 's'} from history?`)) return;
  allEntries = allEntries.filter(e => !e.private);
  await saveEntries();
  rerender();
}

// ── Row builders ──────────────────────────────────────────
function buildTabRow(item, query, { indented, activate, remove, fromWindow, onWindowRestore }) {
  const el = document.createElement('div');
  el.className = 'tab-item' + (indented ? ' child-tab' : '');
  el.setAttribute('role', 'listitem');
  el.setAttribute('tabindex', '-1');

  el.appendChild(makeFaviconEl(item));

  const body = document.createElement('div');
  body.className = 'tab-body';
  const titleEl = document.createElement('div');
  titleEl.className = 'tab-title';
  appendHighlighted(titleEl, item.title, query);
  const urlEl = document.createElement('div');
  urlEl.className = 'tab-url';
  appendHighlighted(urlEl, item.url, query);
  body.appendChild(titleEl);
  body.appendChild(urlEl);
  el.appendChild(body);

  if (item.private) el.appendChild(makePrivateBadgeEl());
  if (fromWindow) el.appendChild(makeWindowBadgeEl(onWindowRestore));

  const timeEl = document.createElement('span');
  timeEl.className = 'tab-time';
  timeEl.textContent = relativeTime(item.closedAt);
  el.appendChild(timeEl);

  el.addEventListener('click', activate);
  el.addEventListener('contextmenu', e => showContextMenu(e, el, activate, remove));
  rows.push({ el, activate, remove });
  return el;
}

function buildWindowRow(entry, container) {
  const el = document.createElement('div');
  el.className = 'tab-item window-item';
  el.setAttribute('role', 'listitem');
  el.setAttribute('tabindex', '-1');

  const isOpen = expanded.has(entry);

  const toggle = document.createElement('span');
  toggle.className = 'window-toggle';
  toggle.textContent = isOpen ? '−' : '+';   // − / +
  el.appendChild(toggle);

  el.appendChild(makeWindowIconEl());

  const body = document.createElement('div');
  body.className = 'tab-body';
  const titleEl = document.createElement('div');
  titleEl.className = 'tab-title window-title';
  titleEl.textContent = 'Window';
  const subEl = document.createElement('div');
  subEl.className = 'window-sub';
  subEl.textContent = `${entry.tabs.length} tabs`;
  body.appendChild(titleEl);
  body.appendChild(subEl);
  el.appendChild(body);

  if (entry.private) el.appendChild(makePrivateBadgeEl());

  const timeEl = document.createElement('span');
  timeEl.className = 'tab-time';
  timeEl.textContent = relativeTime(entry.closedAt);
  el.appendChild(timeEl);

  const doToggle = (e) => {
    if (e) e.stopPropagation();
    if (expanded.has(entry)) expanded.delete(entry); else expanded.add(entry);
    render(document.getElementById('search').value);
  };
  const openWindow = () => restoreWindow(entry);
  const deleteWindow = () => removeEntry(entry).then(rerender);
  toggle.addEventListener('click', doToggle);
  el.addEventListener('click', openWindow);
  el.addEventListener('contextmenu', e => showContextMenu(e, el, openWindow, deleteWindow));

  rows.push({ el, activate: openWindow, remove: deleteWindow, toggle: doToggle });
  container.appendChild(el);

  if (isOpen) {
    entry.tabs.forEach((t, ti) => {
      const item = { title: t.title, url: t.url, favIconUrl: t.favIconUrl, closedAt: entry.closedAt };
      container.appendChild(buildTabRow(item, '', {
        indented: true,
        activate: () => restoreTab(t.url, childGroup(entry, t), entry.private),
        remove: () => removeChildTab(entry, ti).then(rerender),
      }));
    });
  }
}

function rerender() {
  render(document.getElementById('search').value);
}

// Flatten every stored tab (including those inside window groups) for search.
function flatten() {
  const out = [];
  allEntries.forEach(entry => {
    if (isWindow(entry)) {
      entry.tabs.forEach((t, ti) => out.push({
        title: t.title, url: t.url, favIconUrl: t.favIconUrl,
        closedAt: entry.closedAt, entry, childIndex: ti, group: childGroup(entry, t),
        private: !!entry.private,
      }));
    } else {
      out.push({
        title: entry.title, url: entry.url, favIconUrl: entry.favIconUrl,
        closedAt: entry.closedAt, entry, childIndex: -1, group: entry.group || null,
        private: !!entry.private,
      });
    }
  });
  return out;
}

function render(query) {
  const q = (query || '').trim();
  const resultsEl = document.getElementById('results');
  const emptyEl = document.getElementById('empty');
  const countEl = document.getElementById('count');

  rows = [];
  selectedIndex = -1;

  const totalTabs = allEntries.reduce((n, e) => n + tabCount(e), 0);

  if (allEntries.length === 0) {
    emptyEl.classList.remove('hidden');
    resultsEl.replaceChildren();
    countEl.textContent = '';
    return;
  }
  emptyEl.classList.add('hidden');

  const fragment = document.createDocumentFragment();

  if (q) {
    // ── Search mode: flat list of matching tabs ──
    const matches = flatten()
      .map(item => ({ item, score: fuzzyScore(q, item.title, item.url) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, DEFAULT_MAX_VISIBLE)
      .map(({ item }) => item);

    countEl.textContent = `${matches.length} of ${totalTabs}`;

    matches.forEach(item => {
      fragment.appendChild(buildTabRow(item, q, {
        indented: false,
        fromWindow: item.childIndex >= 0,
        onWindowRestore: () => restoreWindow(item.entry),
        activate: () => restoreTab(item.url, item.group, item.private),
        remove: () => (item.childIndex >= 0
          ? removeChildTab(item.entry, item.childIndex)
          : removeEntry(item.entry)).then(rerender),
      }));
    });
  } else {
    // ── Grouped chronological view ──
    countEl.textContent = String(totalTabs);

    allEntries.slice(0, DEFAULT_MAX_VISIBLE).forEach(entry => {
      if (isWindow(entry)) {
        buildWindowRow(entry, fragment);
      } else {
        fragment.appendChild(buildTabRow(entry, '', {
          indented: false,
          activate: () => restoreTab(entry.url, entry.group, entry.private),
          remove: () => removeEntry(entry).then(rerender),
        }));
      }
    });
  }

  resultsEl.replaceChildren(fragment);

  if (rows.length > 0) {
    selectedIndex = 0;
    rows[0].el.classList.add('selected');
  }
}

function hideContextMenu() {
  if (menuEl) menuEl.classList.add('hidden');
}

function hideClearMenu() {
  if (clearMenuEl) clearMenuEl.classList.add('hidden');
}

function hideMenus() {
  hideContextMenu();
  hideClearMenu();
}

function openClearMenu(btn) {
  hideContextMenu();
  // "Clear searched" only makes sense with an active query.
  document.getElementById('clear-searched').disabled = !document.getElementById('search').value.trim();
  // "Clear all private history" only makes sense if we could have private
  // entries: the add-on is allowed in private windows, or some are already here.
  document.getElementById('clear-private').classList.toggle(
    'hidden', !(privateAllowed || allEntries.some(e => e.private)));
  document.getElementById('clear-recent-form').classList.add('hidden');
  clearMenuEl.classList.remove('hidden');
  const r = btn.getBoundingClientRect();
  const mr = clearMenuEl.getBoundingClientRect();
  clearMenuEl.style.left = Math.max(4, r.right - mr.width) + 'px';
  clearMenuEl.style.top = (r.bottom + 4) + 'px';
}

function showContextMenu(e, el, onOpen, onDelete) {
  e.preventDefault();
  if (!menuEl) return;
  hideClearMenu();

  // Move selection to the right-clicked row
  const idx = rows.findIndex(r => r.el === el);
  if (idx >= 0) {
    if (selectedIndex >= 0 && rows[selectedIndex]) rows[selectedIndex].el.classList.remove('selected');
    selectedIndex = idx;
    el.classList.add('selected');
  }

  ctxOnOpen = onOpen;
  ctxOnDelete = onDelete;

  menuEl.classList.remove('hidden');
  const rect = menuEl.getBoundingClientRect();
  let x = e.clientX, y = e.clientY;
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
  menuEl.style.left = Math.max(4, x) + 'px';
  menuEl.style.top = Math.max(4, y) + 'px';
}

function moveSelection(delta) {
  if (rows.length === 0) return;
  if (selectedIndex >= 0) rows[selectedIndex].el.classList.remove('selected');
  selectedIndex = Math.max(0, Math.min(rows.length - 1, selectedIndex + delta));
  const row = rows[selectedIndex];
  row.el.classList.add('selected');
  row.el.scrollIntoView({ block: 'nearest' });
}

document.addEventListener('DOMContentLoaded', async () => {
  const searchEl = document.getElementById('search');

  // Sync theme from storage and watch OS preference changes
  const { theme = 'auto' } = await browser.storage.local.get('theme');
  localStorage.setItem('reopener-theme', theme);
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const applyTheme = t => document.documentElement.setAttribute('data-theme',
    t === 'auto' ? (mq.matches ? 'dark' : 'light') : t);
  applyTheme(theme);
  mq.addEventListener('change', () => { if (theme === 'auto') applyTheme('auto'); });

  // Is the add-on allowed to run in private windows? Gates the private-clear
  // option; best-effort, defaults to false if the API is unavailable.
  privateAllowed = await browser.extension.isAllowedIncognitoAccess().catch(() => false);

  // Wire the right-click context menu
  menuEl = document.getElementById('context-menu');
  document.getElementById('ctx-open').addEventListener('click', () => {
    hideContextMenu();
    if (ctxOnOpen) ctxOnOpen();
  });
  document.getElementById('ctx-delete').addEventListener('click', () => {
    hideContextMenu();
    if (ctxOnDelete) ctxOnDelete();
  });

  // Wire the clear-history dropdown
  clearMenuEl = document.getElementById('clear-menu');
  const btnClear = document.getElementById('btn-clear');
  const clearRecentForm = document.getElementById('clear-recent-form');
  const clearMinutes = document.getElementById('clear-minutes');
  btnClear.addEventListener('click', (e) => {
    e.stopPropagation();
    if (clearMenuEl.classList.contains('hidden')) openClearMenu(btnClear);
    else hideClearMenu();
  });
  clearMenuEl.addEventListener('click', e => e.stopPropagation());
  document.getElementById('clear-searched').addEventListener('click', () => {
    const q = searchEl.value;
    hideClearMenu();
    clearSearched(q);
  });
  document.getElementById('clear-recent').addEventListener('click', () => {
    clearRecentForm.classList.toggle('hidden');
    if (!clearRecentForm.classList.contains('hidden')) clearMinutes.focus();
  });
  const submitRecent = () => {
    const m = parseInt(clearMinutes.value, 10);
    if (!m || m < 1) { clearMinutes.focus(); return; }
    hideClearMenu();
    clearRecent(m);
  };
  document.getElementById('clear-recent-go').addEventListener('click', submitRecent);
  clearMinutes.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submitRecent(); }
  });
  document.getElementById('clear-private').addEventListener('click', () => {
    hideClearMenu();
    clearPrivate();
  });
  document.getElementById('clear-all').addEventListener('click', () => {
    hideClearMenu();
    clearAll();
  });

  document.addEventListener('click', hideMenus);
  document.addEventListener('scroll', hideMenus, true);
  window.addEventListener('blur', hideMenus);

  const { closedTabs = [], expandWindows = false, expandThreshold = 10 } =
    await browser.storage.local.get(['closedTabs', 'expandWindows', 'expandThreshold']);
  // Normalise legacy entries (stored before window grouping existed) to tabs.
  allEntries = closedTabs.map(e => e.type ? e : { type: 'tab', ...e });

  // Default expansion: when enabled, expand windows up to the configured size.
  if (expandWindows) {
    allEntries.forEach(e => {
      if (isWindow(e) && e.tabs.length <= expandThreshold) expanded.add(e);
    });
  }

  render('');

  searchEl.focus();
  searchEl.addEventListener('input', () => render(searchEl.value));

  searchEl.addEventListener('keydown', e => {
    const menuOpen = (menuEl && !menuEl.classList.contains('hidden')) ||
                     (clearMenuEl && !clearMenuEl.classList.contains('hidden'));
    if (e.key === 'Escape' && menuOpen) {
      e.preventDefault(); hideMenus(); return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); }
    else if (e.key === 'Delete') { e.preventDefault(); rows[selectedIndex]?.remove?.(); }
    else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && rows[selectedIndex]?.toggle) {
      e.preventDefault();
      rows[selectedIndex].toggle();
    }
    else if (e.key === 'Enter') {
      if (rows[selectedIndex]) rows[selectedIndex].activate();
    }
  });

  document.getElementById('btn-settings').addEventListener('click', () => {
    browser.runtime.openOptionsPage();
    window.close();
  });
});
