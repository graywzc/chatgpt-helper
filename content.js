(() => {
  const SIDEBAR_ID = 'cgpt-nav-sidebar';
  const TOGGLE_ID = 'cgpt-nav-toggle';
  const MAIN_SHIFT_CLASS = 'cgpt-nav-shifted';
  const AUTO_SHOW_KEY = 'cgptNavAutoShowSidebar';
  const navCore = globalThis.CGPTNavCore;

  let sidebar = null;
  let toggle = null;
  let observer = null;
  let autoShowEnabled = false;
  let sidebarShouldBeVisible = false;
  let hasCompletedFullIndexForConversation = false;
  const conversationCache = new Map();
  const CACHE_STORAGE_PREFIX = 'cgptNavCache:';
  let currentConversationKey = navCore.getConversationKeyFromUrl(location.href);

  // Persists across sidebar open/close; reset on SPA navigation.
  let messageData = []; // { key: string, id: string|null, text: string, scrollTop: number, anchorTop: number }[]
  let isScanning = false;
  let activeScanToken = 0;

  function getSiteConfig() {
    const host = location.hostname;
    if (host === 'claude.ai') {
      return {
        indexingMode: navCore.getIndexingModeForHost(host),
        selectors: ['[data-testid="user-message"]'],
        highlightColor: 'rgba(218, 119, 86, 0.15)',
      };
    }
    if (host === 'gemini.google.com') {
      return {
        indexingMode: navCore.getIndexingModeForHost(host),
        rootSelector: 'main',
        selectors: ['.query-text', 'user-query .query-content'],
        highlightColor: 'rgba(66, 133, 244, 0.15)',
      };
    }
    return {
      indexingMode: navCore.getIndexingModeForHost(host),
      selectors: ['[data-message-author-role="user"]'],
      highlightColor: 'rgba(99, 102, 241, 0.15)',
    };
  }

  function shouldUseDomIndexing() {
    return getSiteConfig().indexingMode === 'dom';
  }

  function getHumanMessages() {
    const { selectors, rootSelector } = getSiteConfig();
    const root = rootSelector ? document.querySelector(rootSelector) : document;
    for (const sel of selectors) {
      const els = Array.from((root || document).querySelectorAll(sel)).filter(isVisibleMessage);
      if (els.length > 0) return els;
    }
    return [];
  }

  function truncate(text, maxLen = 80) {
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean.length > maxLen ? clean.slice(0, maxLen) + '…' : clean;
  }

  function getStorageArea() {
    return chrome.storage?.local ?? null;
  }

  function getCacheStorageArea() {
    return chrome.storage?.local ?? null;
  }

  function storageGet(area, keys) {
    if (!area) return Promise.resolve({});
    return new Promise((resolve, reject) => {
      area.get(keys, result => {
        const error = chrome.runtime?.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(result);
      });
    });
  }

  function storageSet(area, values) {
    if (!area) return Promise.resolve();
    return new Promise((resolve, reject) => {
      area.set(values, () => {
        const error = chrome.runtime?.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve();
      });
    });
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function getViewportSignature(messages) {
    return messages
      .map(el => getMessageId(el) ?? getMessageText(el).slice(0, 80))
      .join('|');
  }

  function isVisibleMessage(el) {
    if (!el || !el.isConnected) return false;
    if (sidebar && sidebar.contains(el)) return false;

    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }

    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
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

  function getMessageText(el) {
    return navCore.normalizeMessageText(el.innerText || el.textContent || '');
  }

  function getMessageKey(id, text, occurrence) {
    return navCore.createMessageKey(id, text, occurrence);
  }

  function findMessageIndexById(id) {
    if (!id) return -1;
    return messageData.findIndex(message => message.id === id);
  }

  function getMessageAnchorTop(el, scrollTop) {
    return Math.round(scrollTop + el.getBoundingClientRect().top);
  }

  function findNearbyMessageIndexByText(messages, text, anchorTop, maxDistance) {
    return navCore.findNearbyMessageIndexByText(messages, text, anchorTop, maxDistance);
  }

  function getConversationKey() {
    return navCore.getConversationKeyFromUrl(location.href);
  }

  function getProvider() {
    return navCore.getProviderForHost(location.hostname);
  }

  function getConversationCacheStorageKey(conversationKey) {
    return navCore.getConversationCacheStorageKey(CACHE_STORAGE_PREFIX, conversationKey);
  }

  function cloneMessageData(messages) {
    return navCore.cloneMessageData(messages);
  }

  function collectDomMessages() {
    const entries = [];
    const firstIndexById = new Map();
    const nextOccurrenceByText = new Map();
    const dedupeDistance = 48;

    for (const el of getHumanMessages()) {
      const text = getMessageText(el);
      if (!text) continue;

      const id = getMessageId(el);
      const anchorTop = Math.round(window.scrollY + el.getBoundingClientRect().top);
      const scrollTop = anchorTop;

      if (id && firstIndexById.has(id)) {
        const existing = entries[firstIndexById.get(id)];
        if (text.length > existing.text.length) existing.text = text;
        if (anchorTop < existing.anchorTop) {
          existing.anchorTop = anchorTop;
          existing.scrollTop = scrollTop;
        }
        continue;
      }

      if (!id) {
        const existingIndex = findNearbyMessageIndexByText(entries, text, anchorTop, dedupeDistance);
        if (existingIndex >= 0) {
          const existing = entries[existingIndex];
          if (text.length > existing.text.length) existing.text = text;
          if (anchorTop < existing.anchorTop) {
            existing.anchorTop = anchorTop;
            existing.scrollTop = scrollTop;
          }
          continue;
        }
      }

      const occurrence = nextOccurrenceByText.get(text) ?? 0;
      nextOccurrenceByText.set(text, occurrence + 1);

      const key = getMessageKey(id, text, occurrence);
      const entry = { key, id, text, scrollTop, anchorTop };
      entries.push(entry);

      if (id) {
        firstIndexById.set(id, entries.length - 1);
      }
    }

    return entries.sort((a, b) => (a.anchorTop ?? a.scrollTop) - (b.anchorTop ?? b.scrollTop));
  }

  async function loadCachedMessages() {
    currentConversationKey = getConversationKey();
    const provider = getProvider();
    const storage = getCacheStorageArea();
    const storageKey = getConversationCacheStorageKey(currentConversationKey);
    let cached = conversationCache.get(currentConversationKey);
    if (!cached) {
      try {
        const result = await storageGet(storage, [storageKey]);
        cached = result[storageKey];
        if (cached !== undefined) {
          const normalizedEntry = navCore.normalizeConversationCacheEntry(cached, {
            conversationKey: currentConversationKey,
            provider,
          });
          conversationCache.set(currentConversationKey, normalizedEntry);
          cached = normalizedEntry;
        }
      } catch (error) {
        console.warn('AI Chat Navigator cache read failed', error);
      }
    }
    const normalizedCached = cached
      ? navCore.normalizeConversationCacheEntry(cached, {
        conversationKey: currentConversationKey,
        provider,
      })
      : null;

    if (normalizedCached) {
      normalizedCached.lastVisitedAt = Date.now();
      conversationCache.set(currentConversationKey, normalizedCached);
    }

    messageData = normalizedCached ? cloneMessageData(normalizedCached.messages) : [];
    hasCompletedFullIndexForConversation = normalizedCached?.status === 'ready';

    if (normalizedCached) {
      try {
        await storageSet(storage, { [storageKey]: normalizedCached });
      } catch (error) {
        console.warn('AI Chat Navigator cache touch failed', error);
      }
    }

    return messageData;
  }

  async function saveCachedMessages() {
    const entry = navCore.createConversationCacheEntry({
      conversationKey: currentConversationKey,
      provider: getProvider(),
      messages: messageData,
      status: hasCompletedFullIndexForConversation ? 'ready' : 'partial',
    });
    conversationCache.set(currentConversationKey, entry);
    const storage = getCacheStorageArea();
    const storageKey = getConversationCacheStorageKey(currentConversationKey);
    try {
      await storageSet(storage, { [storageKey]: entry });
    } catch (error) {
      console.warn('AI Chat Navigator cache write failed', error);
    }
  }

  function renderStatus(message) {
    const list = sidebar?.querySelector('#cgpt-nav-list');
    if (!list) return;
    list.innerHTML = '';

    const status = document.createElement('div');
    status.className = 'cgpt-nav-empty';
    status.textContent = message;
    list.appendChild(status);
  }

  function getSidebarStatusText() {
    return sidebar?.querySelector('#cgpt-nav-list .cgpt-nav-empty')?.textContent?.trim() ?? '';
  }

  function shouldRetryVisibleSidebar() {
    if (!sidebar?.classList.contains('cgpt-nav-visible')) return false;
    if (isScanning) return false;
    if (messageData.length > 0) return false;

    const statusText = getSidebarStatusText();
    return statusText === 'Scanning messages…' || statusText === 'Loading conversation…';
  }

  async function refreshVisibleSidebarIfNeeded() {
    if (!shouldRetryVisibleSidebar()) return;

    await loadCachedMessages();
    if (messageData.length > 0) {
      buildSidebar();
      return;
    }

    await showSidebar();
  }

  function ensureUiMounted() {
    const sidebarWasMissing = !sidebar || !sidebar.isConnected;
    const toggleWasMissing = !toggle || !toggle.isConnected;

    if (!sidebar || !sidebar.isConnected) {
      createSidebar();
    }
    if (!toggle || !toggle.isConnected) {
      createToggle();
    }

    if (sidebarShouldBeVisible) {
      sidebar.classList.add('cgpt-nav-visible');
      toggle.classList.add('cgpt-nav-active');
      if ((sidebarWasMissing || toggleWasMissing) && messageData.length > 0) {
        buildSidebar();
      }
    }
  }

  function handleUrlChange() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    handleConversationChange();
  }

  async function handleConversationChange() {
    ensureUiMounted();
    currentConversationKey = getConversationKey();
    activeScanToken += 1;
    isScanning = false;
    hasCompletedFullIndexForConversation = false;
    messageData = [];

    if (observer) {
      observer.disconnect();
      observer = null;
    }

    const sidebarWasVisible = sidebar?.classList.contains('cgpt-nav-visible');

    if (sidebarWasVisible) {
      renderStatus('Loading conversation…');
    }

    await loadCachedMessages();

    if (!observer) {
      startObserver();
    }

    if (sidebarWasVisible) {
      if (messageData.length > 0) {
        buildSidebar();
      } else {
        await showSidebar();
      }
    }
  }

  // Collects all user messages by scrolling the conversation from top to bottom.
  // Restores the original scroll position when done.
  async function scanMessages() {
    const scanToken = ++activeScanToken;
    const container = findScrollContainer();
    const savedTop = container.scrollTop;
    const entries = [];
    const firstIndexById = new Map();
    const nextOccurrenceByText = new Map();
    const stepSize = Math.max(Math.floor(container.clientHeight * 0.45), 160);
    const dedupeDistance = Math.max(Math.floor(container.clientHeight * 0.9), 240);
    const tolerance = 2;

    const collect = currentTop => {
      for (const el of getHumanMessages()) {
        const text = getMessageText(el);
        if (!text) continue;

        const id = getMessageId(el);
        const anchorTop = getMessageAnchorTop(el, currentTop);
        if (id && firstIndexById.has(id)) {
          const existing = entries[firstIndexById.get(id)];
          if (currentTop < existing.scrollTop) existing.scrollTop = currentTop;
          if (anchorTop < existing.anchorTop) existing.anchorTop = anchorTop;
          if (text.length > existing.text.length) existing.text = text;
          continue;
        }

        if (!id) {
          const existingIndex = findNearbyMessageIndexByText(entries, text, anchorTop, dedupeDistance);
          if (existingIndex >= 0) {
            const existing = entries[existingIndex];
            if (currentTop < existing.scrollTop) existing.scrollTop = currentTop;
            if (anchorTop < existing.anchorTop) existing.anchorTop = anchorTop;
            if (text.length > existing.text.length) existing.text = text;
            continue;
          }
        }

        const occurrence = nextOccurrenceByText.get(text) ?? 0;
        nextOccurrenceByText.set(text, occurrence + 1);

        const key = getMessageKey(id, text, occurrence);
        const entry = { key, id, text, scrollTop: currentTop, anchorTop };
        entries.push(entry);

        if (id) {
          firstIndexById.set(id, entries.length - 1);
        }
      }
    };

    const waitForViewportToSettle = async previousSignature => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await delay(120);
        const messages = getHumanMessages();
        const signature = getViewportSignature(messages);
        if (!signature || signature !== previousSignature) return signature;
      }
      return previousSignature;
    };

    isScanning = true;
    try {
      container.scrollTop = 0;
      let signature = await waitForViewportToSettle('');
      collect(container.scrollTop);

      let currentTop = container.scrollTop;
      let stallCount = 0;
      let iterations = 0;
      while (currentTop < Math.max(container.scrollHeight - container.clientHeight, 0) - tolerance) {
        if (scanToken !== activeScanToken) {
          throw new Error('Scan cancelled');
        }

        const liveMaxTop = Math.max(container.scrollHeight - container.clientHeight, 0);
        const nextTop = Math.min(currentTop + stepSize, liveMaxTop);
        if (nextTop <= currentTop + tolerance) break;
        container.scrollTop = nextTop;
        const previousSignature = signature;
        signature = await waitForViewportToSettle(signature);
        collect(container.scrollTop);

        const updatedTop = container.scrollTop;
        if (updatedTop <= currentTop + tolerance && signature === previousSignature) {
          stallCount += 1;
          if (stallCount >= 3) break;
        } else {
          stallCount = 0;
        }

        currentTop = updatedTop;
        iterations += 1;
        if (iterations >= 500) break;
      }

      container.scrollTop = Math.max(container.scrollHeight - container.clientHeight, 0);
      await waitForViewportToSettle(signature);
      collect(container.scrollTop);

      messageData = entries;
      hasCompletedFullIndexForConversation = true;
      await saveCachedMessages();
    } finally {
      container.scrollTop = savedTop;
      isScanning = false;
    }
  }

  async function indexMessages() {
    if (shouldUseDomIndexing()) {
      messageData = collectDomMessages();
      hasCompletedFullIndexForConversation = true;
      await saveCachedMessages();
      return;
    }

    await scanMessages();
  }

  async function scrollToMessage(id, index) {
    const { highlightColor } = getSiteConfig();
    const targetMessage = messageData[index];
    if (!targetMessage) return;

    const highlight = el => {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.style.transition = 'background 0.3s';
      el.style.background = highlightColor;
      setTimeout(() => { el.style.background = ''; }, 1200);
    };

    if (targetMessage.id) {
      // Element may already be in the DOM (not virtualized out).
      let el = document.querySelector(`[data-message-id="${CSS.escape(targetMessage.id)}"]`);
      if (el) { highlight(el); return; }
    }

    const container = findScrollContainer();
    const estimatedTop = Math.max(targetMessage.scrollTop - Math.floor(container.clientHeight * 0.25), 0);
    const maxTop = Math.max(container.scrollHeight - container.clientHeight, 0);
    container.scrollTop = Math.min(estimatedTop, maxTop);
    await delay(250);

    if (targetMessage.id) {
      let el = document.querySelector(`[data-message-id="${CSS.escape(targetMessage.id)}"]`);
      if (el) { highlight(el); return; }

      const targetIndex = findMessageIndexById(targetMessage.id);
      const start = Math.max(targetIndex - 2, 0);
      const end = Math.min(targetIndex + 2, messageData.length - 1);
      for (let i = start; i <= end; i += 1) {
        const candidateTop = Math.max(
          messageData[i].scrollTop - Math.floor(container.clientHeight * 0.25),
          0
        );
        container.scrollTop = Math.min(candidateTop, maxTop);
        await delay(220);
        el = document.querySelector(`[data-message-id="${CSS.escape(targetMessage.id)}"]`);
        if (el) { highlight(el); return; }
      }
    }

    const visibleMatch = getHumanMessages().find(el => getMessageText(el) === targetMessage.text);
    if (visibleMatch) {
      highlight(visibleMatch);
      return;
    }

    container.scrollTop = Math.min(targetMessage.scrollTop, maxTop);
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
    ensureUiMounted();
    sidebarShouldBeVisible = true;
    if (isScanning) return;
    if (!navCore.shouldProcessConversationUpdate(currentConversationKey, getConversationKey())) {
      await loadCachedMessages();
    }

    sidebar.classList.add('cgpt-nav-visible');
    toggle.classList.add('cgpt-nav-active');

    if (messageData.length > 0) {
      buildSidebar();
      if (shouldUseDomIndexing() || hasCompletedFullIndexForConversation) {
        return;
      }
    }

    if (messageData.length === 0) {
      renderStatus(shouldUseDomIndexing() ? 'Loading messages…' : 'Scanning messages…');
    }

    try {
      await indexMessages();
      if (!sidebar.classList.contains('cgpt-nav-visible')) return;
      if (!navCore.shouldProcessConversationUpdate(currentConversationKey, getConversationKey())) return;
      buildSidebar();
    } catch (error) {
      if (error?.message === 'Scan cancelled') {
        if (!sidebar.classList.contains('cgpt-nav-visible')) return;
        renderStatus('Loading conversation…');
        void refreshVisibleSidebarIfNeeded();
        return;
      }
      console.error('AI Chat Navigator scan failed', error);
      renderStatus('Could not scan messages. Close and reopen the panel to retry.');
    }
  }

  function hideSidebar() {
    sidebarShouldBeVisible = false;
    sidebar.classList.remove('cgpt-nav-visible');
    toggle.classList.remove('cgpt-nav-active');
  }

  async function loadAutoShowPreference() {
    const storage = getStorageArea();
    if (!storage) return false;

    const result = await storageGet(storage, { [AUTO_SHOW_KEY]: false });
    autoShowEnabled = Boolean(result[AUTO_SHOW_KEY]);
    return autoShowEnabled;
  }

  function watchPreferenceChanges() {
    if (!chrome.storage?.onChanged) return;

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes[AUTO_SHOW_KEY]) return;
      autoShowEnabled = Boolean(changes[AUTO_SHOW_KEY].newValue);

      if (autoShowEnabled && sidebar && !sidebar.classList.contains('cgpt-nav-visible')) {
        showSidebar();
      }
    });
  }

  let rebuildTimer = null;

  function startObserver() {
    observer = new MutationObserver(() => {
      clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(() => {
        if (!sidebar.classList.contains('cgpt-nav-visible') || isScanning) return;
        if (!navCore.shouldProcessConversationUpdate(currentConversationKey, getConversationKey())) return;

        if (shouldUseDomIndexing()) {
          const rebuiltMessages = collectDomMessages();
          if (JSON.stringify(rebuiltMessages) === JSON.stringify(messageData)) return;

          messageData = rebuiltMessages;
          void saveCachedMessages();
          observer.disconnect();
          buildSidebar();
          observer.observe(document.body, { childList: true, subtree: true });
          return;
        }

        // Merge any newly visible messages into messageData without rescanning.
        const visibleMessages = getHumanMessages();
        if (visibleMessages.length === 0) return;

        const seenKeys = new Set(messageData.map(message => message.key));
        const occurrenceByText = new Map();
        for (const message of messageData) {
          if (!message.id) {
            const count = occurrenceByText.get(message.text) ?? 0;
            occurrenceByText.set(message.text, count + 1);
          }
        }

        let changed = false;
        const container = findScrollContainer();
        const dedupeDistance = Math.max(Math.floor(container.clientHeight * 0.9), 240);
        for (const el of getHumanMessages()) {
          const id = getMessageId(el);
          const text = getMessageText(el);
          if (!text) continue;
          const anchorTop = getMessageAnchorTop(el, container.scrollTop);

          if (id) {
            const existingIndex = findMessageIndexById(id);
            if (existingIndex >= 0) {
              const existing = messageData[existingIndex];
              if (container.scrollTop < existing.scrollTop) {
                existing.scrollTop = container.scrollTop;
                changed = true;
              }
              if (anchorTop < (existing.anchorTop ?? existing.scrollTop)) {
                existing.anchorTop = anchorTop;
                changed = true;
              }
              if (text.length > existing.text.length) {
                existing.text = text;
                changed = true;
              }
              continue;
            }
          }

          if (!id) {
            const existingIndex = findNearbyMessageIndexByText(
              messageData,
              text,
              anchorTop,
              dedupeDistance
            );
            if (existingIndex >= 0) {
              const existing = messageData[existingIndex];
              if (container.scrollTop < existing.scrollTop) {
                existing.scrollTop = container.scrollTop;
                changed = true;
              }
              if (anchorTop < (existing.anchorTop ?? existing.scrollTop)) {
                existing.anchorTop = anchorTop;
                changed = true;
              }
              if (text.length > existing.text.length) {
                existing.text = text;
                changed = true;
              }
              continue;
            }
          }

          const occurrence = occurrenceByText.get(text) ?? 0;
          const key = getMessageKey(id, text, occurrence);
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            occurrenceByText.set(text, occurrence + 1);
            messageData.push({ key, id, text, scrollTop: container.scrollTop, anchorTop });
            changed = true;
          }
        }

        if (!changed) return;

        void saveCachedMessages();
        observer.disconnect();
        buildSidebar();
        observer.observe(document.body, { childList: true, subtree: true });
      }, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  async function init() {
    ensureUiMounted();
    startObserver();
    await loadCachedMessages();
    await loadAutoShowPreference();
    if (autoShowEnabled) {
      showSidebar();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      void init().catch(error => {
        console.error('AI Chat Navigator init failed', error);
      });
    });
  } else {
    void init().catch(error => {
      console.error('AI Chat Navigator init failed', error);
    });
  }

  watchPreferenceChanges();

  // Re-init on SPA navigation.
  let lastUrl = location.href;

  const originalPushState = history.pushState.bind(history);
  history.pushState = function (...args) {
    const result = originalPushState(...args);
    handleUrlChange();
    return result;
  };

  const originalReplaceState = history.replaceState.bind(history);
  history.replaceState = function (...args) {
    const result = originalReplaceState(...args);
    handleUrlChange();
    return result;
  };

  window.addEventListener('popstate', handleUrlChange);
  window.addEventListener('hashchange', handleUrlChange);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    void refreshVisibleSidebarIfNeeded();
  });
  window.addEventListener('focus', () => {
    void refreshVisibleSidebarIfNeeded();
  });

  new MutationObserver(() => {
    ensureUiMounted();
    handleUrlChange();
  }).observe(document.documentElement, { childList: true, subtree: true });
  window.setInterval(() => {
    ensureUiMounted();
    handleUrlChange();
  }, 500);
})();
