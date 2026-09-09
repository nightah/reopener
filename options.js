const DEFAULT_MAX_TABS = 9999;
const DEFAULT_EXPAND_THRESHOLD = 10;

function showStatus(msg, isError = false) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status' + (isError ? ' error' : '');
  setTimeout(() => el.classList.add('hidden'), 2500);
}

// Firefox no longer runs window.confirm() reliably from extension UI, so the
// destructive action confirms inline instead. Resolves true when accepted.
function askConfirm(message) {
  const modal = document.getElementById('modal');
  const okBtn = document.getElementById('modal-ok');
  const cancelBtn = document.getElementById('modal-cancel');
  document.getElementById('modal-text').textContent = message;
  modal.classList.remove('hidden');
  okBtn.focus();
  return new Promise(resolve => {
    const done = result => {
      modal.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onBackdrop = e => { if (e.target === modal) done(false); };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      else if (e.key === 'Enter') { e.preventDefault(); done(true); }
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey, true);
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');

  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme',
      t === 'auto' ? (mq.matches ? 'dark' : 'light') : t);
  }

  // ── Theme toggle ──────────────────────────────────────────
  const { theme = 'auto' } = await browser.storage.local.get('theme');
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

  // ── Window groups ─────────────────────────────────────────
  const expandToggle = document.getElementById('expand-windows');
  const thresholdInput = document.getElementById('expand-threshold');
  const {
    expandWindows = false,
    expandThreshold = DEFAULT_EXPAND_THRESHOLD,
  } = await browser.storage.local.get(['expandWindows', 'expandThreshold']);

  expandToggle.checked = expandWindows;
  thresholdInput.value = expandThreshold;
  thresholdInput.disabled = !expandWindows;

  expandToggle.addEventListener('change', async () => {
    thresholdInput.disabled = !expandToggle.checked;
    await browser.storage.local.set({ expandWindows: expandToggle.checked });
    showStatus('Saved.');
  });

  thresholdInput.addEventListener('change', async () => {
    const val = parseInt(thresholdInput.value, 10);
    if (!val || val < 1) { showStatus('Enter a number greater than 0.', true); return; }
    await browser.storage.local.set({ expandThreshold: val });
    showStatus('Saved.');
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
    if (!await askConfirm('Clear all closed tab history? This cannot be undone.')) return;
    await browser.storage.local.set({ closedTabs: [] });
    showStatus('History cleared.');
  });
});
