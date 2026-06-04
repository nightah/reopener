const DEFAULT_MAX_TABS = 9999;

function showStatus(msg, isError = false) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status' + (isError ? ' error' : '');
  setTimeout(() => el.classList.add('hidden'), 2500);
}

document.addEventListener('DOMContentLoaded', async () => {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');

  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme',
      t === 'auto' ? (mq.matches ? 'dark' : 'light') : t);
  }

  // ── Theme toggle ──────────────────────────────────────────
  const { theme = 'dark' } = await browser.storage.local.get('theme');
  localStorage.setItem('reopener-theme', theme);
  applyTheme(theme);
  mq.addEventListener('change', () => { if (currentTheme === 'auto') applyTheme('auto'); });

  let currentTheme = theme;
  document.querySelectorAll('.seg-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === theme);
    btn.addEventListener('click', async () => {
      currentTheme = btn.dataset.value;
      await browser.storage.local.set({ theme: currentTheme });
      localStorage.setItem('reopener-theme', currentTheme);
      document.querySelectorAll('.seg-btn').forEach(b =>
        b.classList.toggle('active', b === btn));
      applyTheme(currentTheme);
    });
  });

  // ── Max tabs ──────────────────────────────────────────────
  const input = document.getElementById('max-tabs');
  const { maxTabs = DEFAULT_MAX_TABS } = await browser.storage.local.get('maxTabs');
  input.value = maxTabs;

  document.getElementById('btn-save').addEventListener('click', async () => {
    const val = parseInt(input.value, 10);
    if (!val || val < 1) { showStatus('Enter a number greater than 0.', true); return; }
    await browser.storage.local.set({ maxTabs: val });
    const { closedTabs = [] } = await browser.storage.local.get('closedTabs');
    if (closedTabs.length > val) {
      closedTabs.length = val;
      await browser.storage.local.set({ closedTabs });
    }
    showStatus('Saved.');
  });

  document.getElementById('btn-clear').addEventListener('click', async () => {
    if (!confirm('Clear all closed tab history?')) return;
    await browser.storage.local.set({ closedTabs: [] });
    showStatus('History cleared.');
  });
});
