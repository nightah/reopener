#!/usr/bin/env node
/*
 * Regenerates the popup screenshots in this directory.
 *
 * Each screenshot is a static HTML mock that reproduces the exact DOM the
 * popup builds (see ../popup.js), styled with the real ../popup.css, then
 * rendered with headless Chromium and trimmed to a framed PNG. Keeping the
 * sample data here (see the "Data" section) means the set can be extended
 * incrementally — edit the entries or add a shot, then rerun:
 *
 *     node screenshots/generate.js
 *
 * Run this on macOS to match the committed screenshots: `-apple-system`
 * resolves to SF Pro there, exactly as in the popup. On other platforms it
 * falls back to whatever sans-serif is installed, so the text weight/shape
 * will differ.
 *
 * Prerequisites: Chromium or Chrome, and ImageMagick. The binaries are
 * auto-detected (incl. the macOS .app paths); override with the CHROMIUM /
 * MAGICK env vars if needed. Favicons are fetched live from Google's favicon
 * service, so the run needs network access.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SHOTS = __dirname;
const REPO = path.resolve(__dirname, '..');

// Resolve a runnable binary from a candidate list (PATH names or absolute
// paths, e.g. the macOS .app bundles), verifying each with `--version`.
function resolveBin(kind, envVar, candidates) {
  const list = [process.env[envVar], ...candidates].filter(Boolean);
  for (const bin of list) {
    try { execFileSync(bin, ['--version'], { stdio: 'ignore' }); return bin; } catch { /* try next */ }
  }
  throw new Error(`Could not find ${kind}. Tried: ${list.join(', ')}. `
    + `Install it or set the ${envVar} env var to its path.`);
}
const CHROMIUM = resolveBin('Chromium/Chrome', 'CHROMIUM', [
  'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]);
const MAGICK = resolveBin('ImageMagick', 'MAGICK', ['magick']);

const popupCss = fs.readFileSync(path.join(REPO, 'popup.css'), 'utf8');
const headerIcon = fs.readFileSync(path.join(REPO, 'icons/icon48.svg'), 'utf8')
  .replace('<svg ', '<svg class="header-icon" ');

// Page (behind the popup) background and popup shadow, per theme.
const PAGE_BG = { dark: '#12121e', light: '#c6cbd7' };
const SHADOW = { dark: '0 10px 26px rgba(0,0,0,.34)', light: '0 10px 26px rgba(0,0,0,.16)' };

// ── SVG glyphs (mirroring popup.js) ──────────────────────────────
const G = {
  doc:    'M2 2h12v12H2V2zm1 1v10h10V3H3zm2 2h6v1H5V5zm0 2h6v1H5V7zm0 2h4v1H5V9z',
  window: 'M3 1h10a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1V2a1 1 0 011-1zm0 2v7h10V3H3zm-1 10h11a1 1 0 01-1 1H2a1 1 0 01-1-1V4a1 1 0 011 1z',
  mask:   'M8 3C4 3 1.5 4.5 1 6.5c-.3 1.2.2 2.4 1.3 3.1 1 .7 2.3.9 3.3.4.9-.4 1.4-1.2 2.4-1.2s1.5.8 2.4 1.2c1 .5 2.3.3 3.3-.4 1.1-.7 1.6-1.9 1.3-3.1C14.5 4.5 12 3 8 3zM5 8.2a1.3 1.3 0 110-2.6 1.3 1.3 0 010 2.6zm6 0a1.3 1.3 0 110-2.6 1.3 1.3 0 010 2.6z',
};
const svg = (w, d) => `<svg viewBox="0 0 16 16" fill="currentColor" width="${w}" height="${w}"><path d="${d}"/></svg>`;
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Highlight the first case-insensitive occurrence of q (mirrors appendHighlighted).
function hl(text, q) {
  if (!q) return esc(text);
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return esc(text);
  return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
}
const fav = host => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
const faviconEl = o => o.placeholder
  ? `<span class="tab-favicon-placeholder">${svg(12, G.doc)}</span>`
  : `<img class="tab-favicon" src="${fav(o.host)}" alt="">`;

const windowBadge = () =>
  `<span class="from-window" role="button" title="Restore the whole window">${svg(10, G.window)}Window</span>`;
const privateBadge = () =>
  `<span class="private-badge" title="Closed from a private window">${svg(10, G.mask)}Private</span>`;

// A leaf tab row (top-level or, with o.child, indented inside a window).
function tabRow(o, q = '') {
  const cls = 'tab-item' + (o.child ? ' child-tab' : '') + (o.selected ? ' selected' : '');
  return `<div class="${cls}" role="listitem" tabindex="-1">`
    + faviconEl(o)
    + `<div class="tab-body"><div class="tab-title">${hl(o.title, q)}</div>`
    + `<div class="tab-url">${hl(o.url, q)}</div></div>`
    + (o.private ? privateBadge() : '')
    + (o.fromWindow ? windowBadge() : '')
    + `<span class="tab-time">${o.time}</span></div>`;
}

function windowRow(o) {
  const cls = 'tab-item window-item' + (o.selected ? ' selected' : '');
  return `<div class="${cls}" role="listitem" tabindex="-1">`
    + `<span class="window-toggle">${o.open ? '−' : '+'}</span>`
    + `<span class="tab-favicon-placeholder">${svg(13, G.window)}</span>`
    + `<div class="tab-body"><div class="tab-title window-title">Window</div>`
    + `<div class="window-sub">${o.count} tabs</div></div>`
    + (o.private ? privateBadge() : '')
    + `<span class="tab-time">${o.time}</span></div>`;
}

// ── Data (newest first) ──────────────────────────────────────────
const nightah = { title: 'nightah/reopener: Track and search closed tabs', url: 'https://github.com/nightah/reopener', host: 'github.com', time: '2m ago' };
const awesome = { title: 'sindresorhus/awesome: 😎 Awesome lists of awesome', url: 'https://github.com/sindresorhus/awesome', host: 'github.com', time: '3m ago', private: true };
const claude = { title: 'anthropics/claude-code: Claude Code CLI', url: 'https://github.com/anthropics/claude-code', host: 'github.com', time: '4m ago' };
const mdn = { title: 'MDN Web Docs: browser.tabs API', url: 'https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs', host: 'developer.mozilla.org', time: '4m ago' };
const so = { title: 'Stack Overflow - Where Developers Learn, Share, & Build Careers', url: 'https://stackoverflow.com/', host: 'stackoverflow.com', time: '4m ago' };
const hn = { title: "Hacker News | Ask HN: What's your Firefox setup?", url: 'https://news.ycombinator.com/item?id=39284752', host: 'news.ycombinator.com', time: '8m ago' };
// Tabs inside the private window. octocat is a github page, so it surfaces in
// the "github" search as a private + window result.
const octocat = { title: 'octocat/Hello-World: My first repository on GitHub!', url: 'https://github.com/octocat/Hello-World', host: 'github.com', time: '10m ago' };
const proton = { title: 'Proton Mail: Secure email that protects your privacy', url: 'https://mail.proton.me/u/0/inbox', host: 'mail.proton.me', time: '10m ago' };
const youtube = { title: 'YouTube', url: 'https://www.youtube.com/', host: 'www.youtube.com', time: '15m ago' };
const addons = { title: 'Add-ons Manager', url: 'about:addons', placeholder: true, time: '18m ago' };

// Full chronological list used by dark / light / context-menu. Both a normal
// window and a private window are expanded to show their tabs.
function fullList({ selectFirst = false, selectPrivateWindow = false } = {}) {
  return [
    tabRow({ ...nightah, selected: selectFirst }),
    tabRow(awesome),
    windowRow({ count: 3, time: '4m ago', open: true }),
    tabRow({ ...claude, child: true }),
    tabRow({ ...mdn, child: true }),
    tabRow({ ...so, child: true }),
    tabRow(hn),
    windowRow({ count: 2, time: '10m ago', open: true, private: true, selected: selectPrivateWindow }),
    tabRow({ ...octocat, child: true }),
    tabRow({ ...proton, child: true }),
    windowRow({ count: 2, time: '12m ago', open: false }),
    tabRow(youtube),
    tabRow(addons),
  ].join('');
}

// The "github" search results (flat): a plain tab, a private single tab, a tab
// from a (normal) window, and a tab that is BOTH private and from a window.
function githubSearch() {
  const q = 'github';
  return [
    tabRow({ ...nightah, selected: true }, q),
    tabRow({ ...awesome }, q),
    tabRow({ ...claude, fromWindow: true }, q),
    tabRow({ ...octocat, private: true, fromWindow: true }, q),
  ].join('');
}

// ── Page assembly ────────────────────────────────────────────────
function header() {
  return `<div class="header"><div class="header-left">${headerIcon}<span class="header-title">Reopener</span></div>`
    + `<div class="header-actions">`
    + `<button class="icon-btn" title="Clear history"><svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg></button>`
    + `<button class="icon-btn" title="Settings"><svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16"><path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/></svg></button>`
    + `</div></div>`;
}
function searchBar({ value = '', count = '' }) {
  const input = value
    ? `<input id="search" type="text" value="${esc(value)}">`
    : `<input id="search" type="text" placeholder="Search closed tabs...">`;
  return `<div class="search-bar"><div class="search-pill">`
    + `<svg class="search-icon" viewBox="0 0 20 20" fill="currentColor" width="15" height="15"><path fill-rule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clip-rule="evenodd"/></svg>`
    + input + `<span class="count">${count}</span></div></div>`;
}
const clearMenu = () =>
  `<div class="popup-menu menu-clear" role="menu">`
  + `<button role="menuitem">Clear searched history</button>`
  + `<button role="menuitem">Clear recent…</button>`
  + `<div class="menu-form"><input type="number" value="5"><span class="menu-form-unit">min</span><button>Clear</button></div>`
  + `<button id="clear-private" role="menuitem">Clear all private history</button>`
  + `<button class="danger" role="menuitem">Clear all history</button></div>`;
const contextMenu = () =>
  `<div class="popup-menu menu-context" role="menu">`
  + `<button role="menuitem">Open</button>`
  + `<button class="danger" role="menuitem">Delete</button></div>`;

// On non-macOS renderers there's no SF Pro and no macOS font-smoothing, so text
// lands lighter than the canonical macOS screenshots. Nudge the weights that
// stand out most (titles and the search field) to approximate that heavier
// look. macOS runs render the real popup styling untouched.
const NON_MAC_TWEAK = process.platform === 'darwin' ? '' : `
.popup .tab-title{ font-weight:600; }
.popup #search{ font-weight:500; }`;

function page({ theme, body, extraCss = '' }) {
  return `<!DOCTYPE html><html${theme === 'light' ? ' data-theme="light"' : ''}><head><meta charset="utf-8"><style>
${popupCss}
:root{ --page-bg:${PAGE_BG.dark}; }
[data-theme="light"]{ --page-bg:${PAGE_BG.light}; }
html,body{margin:0;}
body{ width:auto; max-height:none; background:var(--page-bg); display:block; padding:24px; overflow:visible; }
.popup{ width:640px; max-height:none; background:var(--bg); color:var(--text); font-family:var(--font);
  font-size:13px; display:flex; flex-direction:column; overflow:hidden; border-radius:12px;
  border:1px solid var(--border); box-shadow:${SHADOW[theme]}; position:relative; }
.popup #results{ max-height:none; overflow:visible; }
.popup .popup-menu{ position:absolute; }
${NON_MAC_TWEAK}
${extraCss}
</style></head><body><div class="popup">${body}</div></body></html>`;
}

// ── Screenshot definitions ───────────────────────────────────────
const shots = [
  { name: 'dark', theme: 'dark',
    body: header() + searchBar({ count: '12' }) + `<div id="results" role="list">${fullList({ selectFirst: true })}</div>` },
  { name: 'light', theme: 'light',
    body: header() + searchBar({ count: '12' }) + `<div id="results" role="list">${fullList({ selectFirst: true })}</div>` },
  { name: 'search', theme: 'dark',
    body: header() + searchBar({ value: 'github', count: '4 of 12' }) + `<div id="results" role="list">${githubSearch()}</div>` },
  { name: 'clear-menu', theme: 'dark', extraCss: '.menu-clear{ top:58px; right:14px; }',
    body: header() + searchBar({ value: 'github', count: '4 of 12' })
      + `<div id="results" role="list">${githubSearch()}</div>` + clearMenu() },
  { name: 'context-menu', theme: 'dark', extraCss: '.menu-context{ top:432px; left:150px; }',
    body: header() + searchBar({ count: '12' })
      + `<div id="results" role="list">${fullList({ selectPrivateWindow: true })}</div>` + contextMenu() },
];

// ── Render ───────────────────────────────────────────────────────
const size = png => execFileSync(MAGICK, [png, '-format', '%wx%h', 'info:']).toString().trim();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reopener-shots-'));
try {
  for (const s of shots) {
    const htmlPath = path.join(tmp, `${s.name}.html`);
    const rawPath = path.join(tmp, `${s.name}.raw.png`);
    const outPath = path.join(SHOTS, `${s.name}.png`);
    fs.writeFileSync(htmlPath, page(s));
    execFileSync(CHROMIUM, ['--headless', '--hide-scrollbars', '--disable-gpu',
      '--force-device-scale-factor=1', '--virtual-time-budget=8000', '--window-size=720,2000',
      `--screenshot=${rawPath}`, `file://${htmlPath}`], { stdio: 'ignore' });
    execFileSync(MAGICK, [rawPath, '-fuzz', '8%', '-trim', '+repage',
      '-bordercolor', PAGE_BG[s.theme], '-border', '24', '-alpha', 'off', outPath]);
    console.log(`generated ${s.name}.png (${size(outPath)})`);
  }
  // Fuzzy trim reacts to the fainter light shadow, so pin light to dark's exact
  // frame (identical layout) for a matched pair in the README.
  const darkPng = path.join(SHOTS, 'dark.png');
  const lightPng = path.join(SHOTS, 'light.png');
  if (fs.existsSync(darkPng) && fs.existsSync(lightPng)) {
    const [w, h] = size(darkPng).split('x');
    execFileSync(MAGICK, [lightPng, '-background', PAGE_BG.light, '-gravity', 'center',
      '-extent', `${w}x${h}`, '-alpha', 'off', lightPng]);
    console.log(`normalized light.png to ${w}x${h}`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
