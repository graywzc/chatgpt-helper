const AUTO_SHOW_KEY = 'cgptNavAutoShowSidebar';

function getStorageArea() {
  return chrome.storage?.local ?? null;
}

async function loadPreference() {
  const toggle = document.getElementById('auto-show-toggle');
  const status = document.getElementById('auto-show-status');
  const storage = getStorageArea();

  if (!toggle || !status) return;
  if (!storage) {
    toggle.disabled = true;
    status.textContent = 'Storage unavailable in this browser.';
    return;
  }

  const result = await storage.get({ [AUTO_SHOW_KEY]: false });
  toggle.checked = Boolean(result[AUTO_SHOW_KEY]);
  status.textContent = toggle.checked
    ? 'Sidebar opens automatically on supported chat pages.'
    : 'Sidebar opens only when you click the floating button.';

  toggle.addEventListener('change', async () => {
    await storage.set({ [AUTO_SHOW_KEY]: toggle.checked });
    status.textContent = toggle.checked
      ? 'Sidebar opens automatically on supported chat pages.'
      : 'Sidebar opens only when you click the floating button.';
  });
}

document.addEventListener('DOMContentLoaded', () => {
  loadPreference().catch(error => {
    const status = document.getElementById('auto-show-status');
    if (status) {
      status.textContent = `Could not load setting: ${error.message}`;
    }
  });
});
