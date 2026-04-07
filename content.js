(() => {
  const SIDEBAR_ID = 'cgpt-nav-sidebar';
  const TOGGLE_ID = 'cgpt-nav-toggle';
  const MAIN_SHIFT_CLASS = 'cgpt-nav-shifted';

  let sidebar = null;
  let toggle = null;
  let observer = null;

  function getHumanMessages() {
    // ChatGPT marks user messages with data-message-author-role="user"
    return Array.from(
      document.querySelectorAll('[data-message-author-role="user"]')
    );
  }

  function truncate(text, maxLen = 80) {
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean.length > maxLen ? clean.slice(0, maxLen) + '…' : clean;
  }

  function scrollToMessage(el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Brief highlight
    el.style.transition = 'background 0.3s';
    el.style.background = 'rgba(99,102,241,0.15)';
    setTimeout(() => { el.style.background = ''; }, 1200);
  }

  function buildSidebar() {
    const messages = getHumanMessages();
    const list = sidebar.querySelector('#cgpt-nav-list');
    list.innerHTML = '';

    if (messages.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'cgpt-nav-empty';
      empty.textContent = 'No messages yet.';
      list.appendChild(empty);
      return;
    }

    messages.forEach((msgEl, i) => {
      const text = msgEl.innerText || msgEl.textContent || '';
      const item = document.createElement('button');
      item.className = 'cgpt-nav-item';
      item.title = text.trim();

      const num = document.createElement('span');
      num.className = 'cgpt-nav-num';
      num.textContent = i + 1;

      const label = document.createElement('span');
      label.className = 'cgpt-nav-label';
      label.textContent = truncate(text);

      item.appendChild(num);
      item.appendChild(label);
      item.addEventListener('click', () => scrollToMessage(msgEl));
      list.appendChild(item);
    });
  }

  function createSidebar() {
    sidebar = document.createElement('div');
    sidebar.id = SIDEBAR_ID;

    const header = document.createElement('div');
    header.className = 'cgpt-nav-header';

    const title = document.createElement('span');
    title.textContent = 'Your Messages';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'cgpt-nav-close';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Close sidebar';
    closeBtn.addEventListener('click', hideSidebar);

    header.appendChild(title);
    header.appendChild(closeBtn);

    const list = document.createElement('div');
    list.id = 'cgpt-nav-list';

    sidebar.appendChild(header);
    sidebar.appendChild(list);
    document.body.appendChild(sidebar);
  }

  function createToggle() {
    toggle = document.createElement('button');
    toggle.id = TOGGLE_ID;
    toggle.title = 'Toggle message navigator';
    toggle.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="8" y1="6" x2="21" y2="6"/>
        <line x1="8" y1="12" x2="21" y2="12"/>
        <line x1="8" y1="18" x2="21" y2="18"/>
        <line x1="3" y1="6" x2="3.01" y2="6"/>
        <line x1="3" y1="12" x2="3.01" y2="12"/>
        <line x1="3" y1="18" x2="3.01" y2="18"/>
      </svg>
    `;
    toggle.addEventListener('click', () => {
      if (sidebar.classList.contains('cgpt-nav-visible')) {
        hideSidebar();
      } else {
        showSidebar();
      }
    });
    document.body.appendChild(toggle);
  }

  function showSidebar() {
    buildSidebar();
    sidebar.classList.add('cgpt-nav-visible');
    toggle.classList.add('cgpt-nav-active');
  }

  function hideSidebar() {
    sidebar.classList.remove('cgpt-nav-visible');
    toggle.classList.remove('cgpt-nav-active');
  }

  let rebuildTimer = null;

  function startObserver() {
    observer = new MutationObserver(() => {
      // Debounce and skip if the mutation came from our own sidebar
      clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(() => {
        if (!sidebar.classList.contains('cgpt-nav-visible')) return;
        observer.disconnect();
        buildSidebar();
        observer.observe(document.body, { childList: true, subtree: true });
      }, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    if (document.getElementById(SIDEBAR_ID)) return;
    createSidebar();
    createToggle();
    startObserver();
  }

  // Wait for the page to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Re-init on SPA navigation (ChatGPT is a SPA) — only watch direct children of body
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(() => {
        const existing = document.getElementById(SIDEBAR_ID);
        if (existing) existing.remove();
        const existingToggle = document.getElementById(TOGGLE_ID);
        if (existingToggle) existingToggle.remove();
        if (observer) observer.disconnect();
        init();
      }, 800);
    }
  }).observe(document.body, { childList: true });
})();
