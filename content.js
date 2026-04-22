(() => {
  const SIDEBAR_ID = 'cgpt-nav-sidebar';
  const TOGGLE_ID = 'cgpt-nav-toggle';
  const MAIN_SHIFT_CLASS = 'cgpt-nav-shifted';

  let sidebar = null;
  let toggle = null;
  let observer = null;

  // Persists across sidebar open/close; reset on SPA navigation.
  let messageData = []; // { id: string|null, text: string }[]

  function getSiteConfig() {
    const host = location.hostname;
    if (host === 'claude.ai') {
      return {
        selectors: ['[data-testid="user-message"]'],
        highlightColor: 'rgba(218, 119, 86, 0.15)',
      };
    }
    if (host === 'gemini.google.com') {
      return {
        selectors: ['.query-text', 'user-query .query-content'],
        highlightColor: 'rgba(66, 133, 244, 0.15)',
      };
    }
    return {
      selectors: ['[data-message-author-role="user"]'],
      highlightColor: 'rgba(99, 102, 241, 0.15)',
    };
  }

  function getHumanMessages() {
    const { selectors } = getSiteConfig();
    for (const sel of selectors) {
      const els = Array.from(document.querySelectorAll(sel));
      if (els.length > 0) return els;
    }
    return [];
  }

  function truncate(text, maxLen = 80) {
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean.length > maxLen ? clean.slice(0, maxLen) + '…' : clean;
  }

  // Finds the scrollable container that holds the conversation.
  function findScrollContainer() {
    const { selectors } = getSiteConfig();
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        let node = el.parentElement;
        while (node && node !== document.body) {
          const { overflowY } = window.getComputedStyle(node);
          if (overflowY === 'auto' || overflowY === 'scroll') return node;
          node = node.parentElement;
        }
      }
    }
    return document.documentElement;
  }

  // Returns the stable message ID attribute if present (ChatGPT sets data-message-id).
  function getMessageId(el) {
    return el.dataset.messageId
      || el.closest('[data-message-id]')?.dataset.messageId
      || null;
  }

  // Collects all user messages by scrolling the conversation from top to bottom.
  // Restores the original scroll position when done.
  async function scanMessages() {
    const container = findScrollContainer();
    const savedTop = container.scrollTop;
    const seenKeys = new Set();

    const collect = () => {
      for (const el of getHumanMessages()) {
        const id = getMessageId(el);
        // Use id when available; fall back to text prefix as a dedup key.
        const key = id ?? el.textContent.trim().slice(0, 80);
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          messageData.push({ id, text: el.innerText || el.textContent });
        }
      }
    };

    container.scrollTop = 0;
    await new Promise(r => setTimeout(r, 150));

    let lastTop = -1;
    while (container.scrollTop !== lastTop) {
      collect();
      lastTop = container.scrollTop;
      container.scrollTop += Math.max(container.clientHeight, 400);
      await new Promise(r => setTimeout(r, 100));
    }
    collect(); // final pass at the bottom

    container.scrollTop = savedTop;
  }

  async function scrollToMessage(id, index) {
    const { highlightColor } = getSiteConfig();

    const highlight = el => {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.style.transition = 'background 0.3s';
      el.style.background = highlightColor;
      setTimeout(() => { el.style.background = ''; }, 1200);
    };

    if (id) {
      // Element may already be in the DOM (not virtualized out).
      let el = document.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
      if (el) { highlight(el); return; }

      // Scroll to the approximate position to trigger the virtual renderer.
      const container = findScrollContainer();
      const fraction = messageData.length > 1 ? index / (messageData.length - 1) : 0;
      container.scrollTop = fraction * container.scrollHeight;
      await new Promise(r => setTimeout(r, 300));

      el = document.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
      if (el) { highlight(el); return; }
    }

    // Final fallback: just scroll to the proportional position.
    const container = findScrollContainer();
    const fraction = messageData.length > 1 ? index / (messageData.length - 1) : 0;
    container.scrollTop = fraction * container.scrollHeight;
  }

  function buildSidebar() {
    const list = sidebar.querySelector('#cgpt-nav-list');
    list.innerHTML = '';

    if (messageData.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'cgpt-nav-empty';
      empty.textContent = 'No messages yet.';
      list.appendChild(empty);
      return;
    }

    messageData.forEach(({ id, text }, i) => {
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
      item.addEventListener('click', () => scrollToMessage(id, i));
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

  async function showSidebar() {
    sidebar.classList.add('cgpt-nav-visible');
    toggle.classList.add('cgpt-nav-active');

    // Show a loading placeholder while we scan.
    const list = sidebar.querySelector('#cgpt-nav-list');
    list.innerHTML = '<div class="cgpt-nav-empty">Scanning messages…</div>';

    messageData = [];
    await scanMessages();
    buildSidebar();
  }

  function hideSidebar() {
    sidebar.classList.remove('cgpt-nav-visible');
    toggle.classList.remove('cgpt-nav-active');
  }

  let rebuildTimer = null;

  function startObserver() {
    observer = new MutationObserver(() => {
      clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(() => {
        if (!sidebar.classList.contains('cgpt-nav-visible')) return;
        // Merge any newly visible messages into messageData without rescanning.
        const seenKeys = new Set(
          messageData.map(m => m.id ?? m.text.trim().slice(0, 80))
        );
        for (const el of getHumanMessages()) {
          const id = getMessageId(el);
          const key = id ?? el.textContent.trim().slice(0, 80);
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            messageData.push({ id, text: el.innerText || el.textContent });
          }
        }
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Re-init on SPA navigation.
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
        messageData = [];
        init();
      }, 800);
    }
  }).observe(document.body, { childList: true });
})();
