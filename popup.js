const AUTO_SHOW_KEY = 'cgptNavAutoShowSidebar';
const DEBUG_MODE_KEY = 'cgptNavDebugMode';

function getStorageArea() {
  return chrome.storage?.local ?? null;
}

async function loadPreference() {
  const toggle = document.getElementById('auto-show-toggle');
  const status = document.getElementById('auto-show-status');
  const debugToggle = document.getElementById('debug-mode-toggle');
  const debugStatus = document.getElementById('debug-mode-status');
  const storage = getStorageArea();

  if (!toggle || !status || !debugToggle || !debugStatus) return;
  if (!storage) {
    toggle.disabled = true;
    debugToggle.disabled = true;
    status.textContent = 'Storage unavailable in this browser.';
    debugStatus.textContent = 'Storage unavailable in this browser.';
    return;
  }

  const result = await storage.get({ [AUTO_SHOW_KEY]: false, [DEBUG_MODE_KEY]: false });
  toggle.checked = Boolean(result[AUTO_SHOW_KEY]);
  debugToggle.checked = Boolean(result[DEBUG_MODE_KEY]);
  status.textContent = toggle.checked
    ? 'Sidebar opens automatically on supported chat pages.'
    : 'Sidebar opens only when you click the floating button.';
  debugStatus.textContent = debugToggle.checked
    ? 'Shows anchor diagnostics and the clear-anchors control in the sidebar.'
    : 'Keeps navigation diagnostics hidden.';

  toggle.addEventListener('change', async () => {
    await storage.set({ [AUTO_SHOW_KEY]: toggle.checked });
    status.textContent = toggle.checked
      ? 'Sidebar opens automatically on supported chat pages.'
      : 'Sidebar opens only when you click the floating button.';
  });

  debugToggle.addEventListener('change', async () => {
    await storage.set({ [DEBUG_MODE_KEY]: debugToggle.checked });
    debugStatus.textContent = debugToggle.checked
      ? 'Shows anchor diagnostics and the clear-anchors control in the sidebar.'
      : 'Keeps navigation diagnostics hidden.';
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
