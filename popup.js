// Apply theme synchronously before first paint to avoid flash
(function () {
  const t = localStorage.getItem('reopener-theme') || 'dark';
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute('data-theme',
    t === 'auto' ? (dark ? 'dark' : 'light') : t);
}());

const DEFAULT_MAX_VISIBLE = 200;

let allTabs = [];
let filtered = [];
let selectedIndex = -1;

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

function faviconSrc(tab) {
  if (tab.favIconUrl) return tab.favIconUrl;
  try {
    const { hostname } = new URL(tab.url);
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=32`;
  } catch { return null; }
}

// Builds the SVG placeholder entirely via DOM — no innerHTML.
function makePlaceholderEl() {
  const span = document.createElement('span');
  span.className = 'tab-favicon-placeholder';
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M2 2h12v12H2V2zm1 1v10h10V3H3zm2 2h6v1H5V5zm0 2h6v1H5V7zm0 2h4v1H5V9z');
  svg.appendChild(path);
  span.appendChild(svg);
  return span;
}

function makeFaviconEl(tab) {
  const src = faviconSrc(tab);
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
  if (!query) {
    el.textContent = text;
    return;
  }
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx !== -1) {
    if (idx > 0) el.appendChild(document.createTextNode(text.slice(0, idx)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(idx, idx + query.length);
    el.appendChild(mark);
    if (idx + query.length < text.length) {
      el.appendChild(document.createTextNode(text.slice(idx + query.length)));
    }
  } else {
    el.textContent = text;
  }
}

function renderResults(query) {
  const q = (query || '').trim();

  filtered = q
    ? allTabs
        .map(tab => ({ tab, score: fuzzyScore(q, tab.title, tab.url) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)
        .map(({ tab }) => tab)
    : allTabs.slice(0, DEFAULT_MAX_VISIBLE);

  const resultsEl = document.getElementById('results');
  const emptyEl = document.getElementById('empty');
  const countEl = document.getElementById('count');

  if (filtered.length === 0 && allTabs.length === 0) {
    emptyEl.classList.remove('hidden');
    resultsEl.replaceChildren();
    countEl.textContent = '';
    return;
  }

  emptyEl.classList.add('hidden');

  const total = allTabs.length;
  countEl.textContent = q
    ? `${filtered.length} of ${total}`
    : total > DEFAULT_MAX_VISIBLE
      ? `showing ${DEFAULT_MAX_VISIBLE} of ${total}`
      : `${total}`;

  const fragment = document.createDocumentFragment();

  filtered.forEach((tab, i) => {
    const item = document.createElement('div');
    item.className = 'tab-item';
    item.setAttribute('role', 'listitem');
    item.setAttribute('tabindex', '-1');
    item.dataset.index = String(i);
    item.dataset.url = tab.url;

    item.appendChild(makeFaviconEl(tab));

    const body = document.createElement('div');
    body.className = 'tab-body';

    const titleEl = document.createElement('div');
    titleEl.className = 'tab-title';
    appendHighlighted(titleEl, tab.title, q);

    const urlEl = document.createElement('div');
    urlEl.className = 'tab-url';
    appendHighlighted(urlEl, tab.url, q);

    body.appendChild(titleEl);
    body.appendChild(urlEl);
    item.appendChild(body);

    const timeEl = document.createElement('span');
    timeEl.className = 'tab-time';
    timeEl.textContent = relativeTime(tab.closedAt);
    item.appendChild(timeEl);

    item.addEventListener('click', () => openTab(tab.url));
    fragment.appendChild(item);
  });

  resultsEl.replaceChildren(fragment);
  selectedIndex = -1;

  if (filtered.length > 0) {
    selectedIndex = 0;
    resultsEl.firstElementChild.classList.add('selected');
  }
}

function openTab(url) {
  browser.tabs.create({ url });
  window.close();
}

async function deleteSelected() {
  if (selectedIndex < 0 || !filtered[selectedIndex]) return;

  const keepIndex = selectedIndex;
  allTabs.splice(allTabs.indexOf(filtered[selectedIndex]), 1);
  await browser.storage.local.set({ closedTabs: allTabs });

  renderResults(document.getElementById('search').value);

  if (filtered.length > 0 && keepIndex > 0) {
    const newIndex = Math.min(keepIndex, filtered.length - 1);
    const items = document.querySelectorAll('.tab-item');
    items[0]?.classList.remove('selected');
    items[newIndex]?.classList.add('selected');
    items[newIndex]?.scrollIntoView({ block: 'nearest' });
    selectedIndex = newIndex;
  }
}

function moveSelection(delta) {
  if (filtered.length === 0) return;
  const items = document.querySelectorAll('.tab-item');
  if (selectedIndex >= 0) items[selectedIndex]?.classList.remove('selected');
  selectedIndex = Math.max(0, Math.min(filtered.length - 1, selectedIndex + delta));
  const el = items[selectedIndex];
  if (el) { el.classList.add('selected'); el.scrollIntoView({ block: 'nearest' }); }
}

document.addEventListener('DOMContentLoaded', async () => {
  const searchEl = document.getElementById('search');

  // Sync theme from storage and watch OS preference changes
  const { theme = 'dark' } = await browser.storage.local.get('theme');
  localStorage.setItem('reopener-theme', theme);
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const applyTheme = t => document.documentElement.setAttribute('data-theme',
    t === 'auto' ? (mq.matches ? 'dark' : 'light') : t);
  applyTheme(theme);
  mq.addEventListener('change', () => { if (theme === 'auto') applyTheme('auto'); });

  const { closedTabs = [] } = await browser.storage.local.get('closedTabs');
  allTabs = closedTabs;
  renderResults('');

  searchEl.focus();

  searchEl.addEventListener('input', () => renderResults(searchEl.value));

  searchEl.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); }
    else if (e.key === 'Delete') { e.preventDefault(); deleteSelected(); }
    else if (e.key === 'Enter') {
      if (selectedIndex >= 0 && filtered[selectedIndex]) {
        openTab(filtered[selectedIndex].url);
      } else if (filtered.length > 0) {
        openTab(filtered[0].url);
      }
    }
  });

  document.getElementById('btn-settings').addEventListener('click', () => {
    browser.runtime.openOptionsPage();
    window.close();
  });
});
