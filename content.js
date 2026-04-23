(() => {
  const SIDEBAR_ID = 'cgpt-nav-sidebar';
  const TOGGLE_ID = 'cgpt-nav-toggle';
  const MAIN_SHIFT_CLASS = 'cgpt-nav-shifted';
  const AUTO_SHOW_KEY = 'cgptNavAutoShowSidebar';
  const DEBUG_MODE_KEY = 'cgptNavDebugMode';
  const navCore = globalThis.CGPTNavCore;

  let sidebar = null;
  let toggle = null;
  let observer = null;
  let autoShowEnabled = false;
  let debugModeEnabled = false;
  let sidebarShouldBeVisible = false;
  let hasCompletedFullIndexForConversation = false;
  let sidebarStatusMessage = '';
  let debugLogEntries = [];
  const conversationCache = new Map();
  const CACHE_STORAGE_PREFIX = 'cgptNavCache:';
  let currentConversationKey = navCore.getConversationKeyFromUrl(location.href);

  // Persists across sidebar open/close; reset on SPA navigation.
  let messageData = []; // { key: string, id: string|null, text: string, segmentWeight?: number, scrollTop: number|null, anchorTop: number|null }[]
  let isScanning = false;
  let activeScanToken = 0;
  let lastDataIndexStartedAt = 0;
  let lastObservedDataMutationSignature = '';
  let lastConsumedObservedRequestAt = null;
  const DATA_INDEX_MIN_INTERVAL_MS = 1500;

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

  function shouldUseDataIndexing() {
    return getSiteConfig().indexingMode === 'data';
  }

  function shouldReuseIndexedMessages() {
    return navCore.shouldReuseIndexedMessages(
      getSiteConfig().indexingMode,
      hasCompletedFullIndexForConversation
    );
  }

  function runtimeSendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, response => {
        const error = chrome.runtime?.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(response);
      });
    });
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

  function getMaxAnchorTop(container = findScrollContainer()) {
    return Math.max(container.scrollHeight - container.clientHeight, 0);
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

  async function waitForHumanMessages(timeoutMs = 4000, intervalMs = 100) {
    const deadline = Date.now() + timeoutMs;
    let messages = getHumanMessages();
    while (messages.length === 0 && Date.now() < deadline) {
      await delay(intervalMs);
      messages = getHumanMessages();
    }
    return messages;
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

  function getVisibleDataMutationSignature() {
    if (!shouldUseDataIndexing()) return '';
    const visibleMessages = getHumanMessages();
    if (visibleMessages.length === 0) return '';

    return visibleMessages
      .map(el => getMessageId(el) ?? getMessageText(el).slice(0, 120))
      .join('|');
  }

  function findMessageIndexById(id) {
    if (!id) return -1;
    return messageData.findIndex(message => message.id === id);
  }

  function findMessageIndexByTextFrom(text, startIndex = 0) {
    if (!text) return -1;
    for (let index = Math.max(startIndex, 0); index < messageData.length; index += 1) {
      if (messageData[index].text === text) return index;
    }
    return -1;
  }

  function findVisibleElementForMessageIndex(targetIndex) {
    const visibleEntries = getHumanMessages().map(messageEl => ({
      element: messageEl,
      id: getMessageId(messageEl),
      text: getMessageText(messageEl),
    }));

    let searchStart = 0;
    for (const entry of visibleEntries) {
      let matchedIndex = -1;

      if (entry.id) {
        matchedIndex = messageData.findIndex((message, candidateIndex) =>
          candidateIndex >= searchStart && message.id === entry.id
        );
      }

      if (matchedIndex < 0 && entry.text) {
        matchedIndex = findMessageIndexByTextFrom(entry.text, searchStart);
      }

      if (matchedIndex < 0) continue;
      searchStart = matchedIndex + 1;

      if (matchedIndex === targetIndex) {
        return entry.element;
      }
    }

    return null;
  }

  function syncVisibleDataMessageAnchors() {
    if (!shouldUseDataIndexing()) return false;

    const container = findScrollContainer();
    const containerRect = container.getBoundingClientRect();
    const visibleEntries = getHumanMessages().map(messageEl => ({
      element: messageEl,
      id: getMessageId(messageEl),
      text: getMessageText(messageEl),
    }));
    if (visibleEntries.length === 0) return false;

    let changed = false;
    let searchStart = 0;

    for (const entry of visibleEntries) {
      let matchedIndex = -1;

      if (entry.id) {
        matchedIndex = messageData.findIndex((message, candidateIndex) =>
          candidateIndex >= searchStart && message.id === entry.id
        );
      }

      if (matchedIndex < 0 && entry.text) {
        matchedIndex = findMessageIndexByTextFrom(entry.text, searchStart);
      }

      if (matchedIndex < 0) continue;

      const message = messageData[matchedIndex];
      const anchorTop = Math.round(
        container.scrollTop
        + entry.element.getBoundingClientRect().top
        - containerRect.top
      );

      if (typeof message.anchorTop === 'number' && message.anchorTop !== anchorTop) {
        message.anchorTop = anchorTop;
        changed = true;
      } else if (typeof message.anchorTop !== 'number') {
        message.anchorTop = anchorTop;
        changed = true;
      }
      if (typeof message.scrollTop === 'number' && message.scrollTop !== anchorTop) {
        message.scrollTop = anchorTop;
        changed = true;
      } else if (typeof message.scrollTop !== 'number') {
        message.scrollTop = anchorTop;
        changed = true;
      }

      searchStart = matchedIndex + 1;
    }

    return changed;
  }

  function normalizeMonotonicAnchors() {
    if (!Array.isArray(messageData) || messageData.length === 0) return false;

    let changed = false;
    const cumulativeWeights = getCumulativeMessageWeights();
    let previousIndex = -1;
    let previousAnchorTop = null;

    for (let index = 0; index < messageData.length; index += 1) {
      const message = messageData[index];
      if (typeof message?.anchorTop !== 'number') continue;

      if (previousAnchorTop === null || message.anchorTop > previousAnchorTop) {
        previousIndex = index;
        previousAnchorTop = message.anchorTop;
        continue;
      }

      let rightIndex = -1;
      for (let cursor = index + 1; cursor < messageData.length; cursor += 1) {
        const candidate = messageData[cursor];
        if (typeof candidate?.anchorTop === 'number' && candidate.anchorTop > previousAnchorTop) {
          rightIndex = cursor;
          break;
        }
      }

      if (rightIndex >= 0) {
        const rightAnchorTop = messageData[rightIndex].anchorTop;
        const runStart = index;
        const totalSize = cumulativeWeights[rightIndex] - cumulativeWeights[previousIndex];

        for (let cursor = runStart; cursor < rightIndex; cursor += 1) {
          const leftSize = cumulativeWeights[cursor] - cumulativeWeights[previousIndex];
          const rightSize = cumulativeWeights[rightIndex] - cumulativeWeights[cursor];
          let nextPos;
          if (totalSize <= 0) {
            nextPos = previousAnchorTop + (cursor - previousIndex);
          } else {
            nextPos = Math.round(
              (previousAnchorTop * (rightSize / totalSize))
              + (rightAnchorTop * (leftSize / totalSize))
            );
          }

          const minAllowed = previousAnchorTop + (cursor - previousIndex);
          const maxAllowed = rightAnchorTop - (rightIndex - cursor);
          nextPos = Math.max(minAllowed, Math.min(nextPos, maxAllowed));

          if (messageData[cursor].anchorTop !== nextPos) {
            messageData[cursor].anchorTop = nextPos;
            if (typeof messageData[cursor].scrollTop === 'number') {
              messageData[cursor].scrollTop = nextPos;
            }
            changed = true;
          }
        }

        previousIndex = rightIndex;
        previousAnchorTop = messageData[rightIndex].anchorTop;
        index = rightIndex;
        continue;
      }

      for (let cursor = index; cursor < messageData.length; cursor += 1) {
        const candidate = messageData[cursor];
        if (typeof candidate?.anchorTop !== 'number') continue;

        const nextPos = previousAnchorTop + Math.max(cursor - previousIndex, 1);
        if (candidate.anchorTop !== nextPos) {
          candidate.anchorTop = nextPos;
          if (typeof candidate.scrollTop === 'number') {
            candidate.scrollTop = nextPos;
          }
          changed = true;
        }
        previousIndex = cursor;
        previousAnchorTop = candidate.anchorTop;
      }

      break;
    }

    return changed;
  }

  function getMessageSegmentWeight(message) {
    const explicitWeight = Number(message?.segmentWeight);
    if (Number.isFinite(explicitWeight) && explicitWeight > 0) {
      return explicitWeight;
    }
    return Math.max(String(message?.text || '').length, 1);
  }

  function getCumulativeMessageWeights() {
    const weights = [0];
    for (let index = 0; index < messageData.length; index += 1) {
      weights.push(weights[index] + getMessageSegmentWeight(messageData[index]));
    }
    return weights;
  }

  function getKnownAnchor(index, maxAnchorTop) {
    if (index < 0) {
      return { index: 0, anchorTop: 0 };
    }

    if (index >= messageData.length - 1) {
      return { index: Math.max(messageData.length - 1, 0), anchorTop: maxAnchorTop };
    }

    const message = messageData[index];
    if (typeof message?.anchorTop === 'number') {
      return { index, anchorTop: message.anchorTop };
    }

    return null;
  }

  function estimateMessageAnchorTop(index, maxAnchorTop) {
    const targetMessage = messageData[index];
    if (!targetMessage) return null;

    if (index <= 0) return 0;
    if (index >= messageData.length - 1) return maxAnchorTop;
    if (typeof targetMessage.anchorTop === 'number') return targetMessage.anchorTop;

    let before = getKnownAnchor(-1, maxAnchorTop);
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const anchor = getKnownAnchor(cursor, maxAnchorTop);
      if (anchor) {
        before = anchor;
        break;
      }
    }

    let after = getKnownAnchor(messageData.length - 1, maxAnchorTop);
    for (let cursor = index + 1; cursor < messageData.length; cursor += 1) {
      const anchor = getKnownAnchor(cursor, maxAnchorTop);
      if (anchor) {
        after = anchor;
        break;
      }
    }

    if (!before || !after) return null;
    if (before.index === after.index) return before.anchorTop;

    const cumulativeWeights = getCumulativeMessageWeights();
    const leftSize = cumulativeWeights[index] - cumulativeWeights[before.index];
    const rightSize = cumulativeWeights[after.index] - cumulativeWeights[index];
    const totalSize = leftSize + rightSize;

    if (totalSize <= 0) {
      return Math.round((before.anchorTop + after.anchorTop) / 2);
    }

    return Math.round(
      (before.anchorTop * (rightSize / totalSize))
      + (after.anchorTop * (leftSize / totalSize))
    );
  }

  function getNearestKnownAnchors(index, maxAnchorTop = getMaxAnchorTop()) {
    let before = index > 0 ? getKnownAnchor(-1, maxAnchorTop) : null;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const anchor = getKnownAnchor(cursor, maxAnchorTop);
      if (anchor) {
        before = anchor;
        break;
      }
    }

    let after = index < messageData.length - 1 ? getKnownAnchor(messageData.length - 1, maxAnchorTop) : null;
    for (let cursor = index + 1; cursor < messageData.length; cursor += 1) {
      const anchor = getKnownAnchor(cursor, maxAnchorTop);
      if (anchor) {
        after = anchor;
        break;
      }
    }

    return { before, after };
  }

  function getMidpointFallbackTop(index, targetTop, maxAnchorTop = getMaxAnchorTop()) {
    const { before, after } = getNearestKnownAnchors(index, maxAnchorTop);
    const candidates = [before, after].filter(Boolean);
    if (candidates.length === 0) return null;

    let fartherAnchor = candidates[0];
    for (const candidate of candidates.slice(1)) {
      if (Math.abs(candidate.anchorTop - targetTop) > Math.abs(fartherAnchor.anchorTop - targetTop)) {
        fartherAnchor = candidate;
      }
    }

    return Math.round((fartherAnchor.anchorTop + targetTop) / 2);
  }

  function seedBoundaryAnchors() {
    if (!shouldUseDataIndexing() || messageData.length === 0) return false;

    const maxAnchorTop = getMaxAnchorTop();
    let changed = false;
    const firstMessage = messageData[0];
    const lastMessage = messageData[messageData.length - 1];

    if (firstMessage && typeof firstMessage.anchorTop !== 'number') {
      firstMessage.anchorTop = 0;
      firstMessage.scrollTop = 0;
      changed = true;
    }

    if (lastMessage && typeof lastMessage.anchorTop !== 'number') {
      lastMessage.anchorTop = maxAnchorTop;
      lastMessage.scrollTop = maxAnchorTop;
      changed = true;
    }

    return changed;
  }

  async function persistAnchorUpdates(changed) {
    if (!changed) return;

    if (shouldUseDataIndexing()) {
      changed = normalizeMonotonicAnchors() || changed;
      seedBoundaryAnchors();
    }

    if (hasCompletedFullIndexForConversation) {
      await saveCachedMessages();
    }

    if (debugModeEnabled && sidebar?.classList.contains('cgpt-nav-visible')) {
      buildSidebar();
    }
  }

  function clearCurrentConversationAnchors() {
    if (!shouldUseDataIndexing()) return;

    for (const message of messageData) {
      message.anchorTop = null;
      message.scrollTop = null;
    }

    seedBoundaryAnchors();
    void persistAnchorUpdates(true);
  }

  function formatAnchorValue(value) {
    return typeof value === 'number' ? String(Math.round(value)) : '—';
  }

  function getCurrentPositionMap(maxAnchorTop = getMaxAnchorTop()) {
    const positions = new Map();
    for (let index = 0; index < messageData.length; index += 1) {
      positions.set(index, estimateMessageAnchorTop(index, maxAnchorTop));
    }
    return positions;
  }

  function getPositionSnapshot(maxAnchorTop = getMaxAnchorTop()) {
    return {
      positions: getCurrentPositionMap(maxAnchorTop),
    };
  }

  function collectPositionTransitions(previousSnapshot, nextSnapshot, skippedIndices = new Set()) {
    const updates = [];

    for (let index = 0; index < messageData.length; index += 1) {
      if (skippedIndices.has(index)) continue;
      const previousPos = previousSnapshot?.positions?.get(index);
      const nextPos = nextSnapshot?.positions?.get(index);
      if (typeof previousPos === 'number' && typeof nextPos === 'number' && previousPos !== nextPos) {
        updates.push(`  item ${index + 1}, pos ${Math.round(previousPos)} -> ${Math.round(nextPos)}`);
      }
    }

    return updates;
  }

  function logPositionTransitions(previousSnapshot, nextSnapshot, skippedIndices = new Set(), label = 'recalculated pos updates') {
    if (!debugModeEnabled) return;
    const updates = collectPositionTransitions(previousSnapshot, nextSnapshot, skippedIndices);
    addDebugLog(label);
    if (updates.length === 0) {
      addDebugLog('  no recalculated pos updates');
      return;
    }
    for (const update of updates) {
      addDebugLog(update);
    }
  }

  function resetDebugLogs() {
    debugLogEntries = [];
  }

  function beginDebugLogSession(label) {
    if (!debugModeEnabled) return;
    if (debugLogEntries.length > 0) {
      debugLogEntries.push('--------------');
    }
    if (label) {
      debugLogEntries.push(String(label));
    }
    if (debugLogEntries.length > 80) {
      debugLogEntries = debugLogEntries.slice(-80);
    }
  }

  function addDebugLog(message) {
    if (!debugModeEnabled) return;
    debugLogEntries.push(String(message));
    if (debugLogEntries.length > 80) {
      debugLogEntries = debugLogEntries.slice(-80);
    }
    renderDebugPanel();
  }

  function renderDebugPanel() {
    if (!sidebar) return;
    const debugPanel = sidebar.querySelector('#cgpt-nav-debug-panel');
    if (!debugPanel) return;
    debugPanel.hidden = !(debugModeEnabled && shouldUseDataIndexing() && debugLogEntries.length > 0);
    debugPanel.innerHTML = '';
    for (const line of debugLogEntries) {
      const row = document.createElement('div');
      row.className = 'cgpt-nav-debug-log-row';
      row.textContent = line;
      debugPanel.appendChild(row);
    }
  }

  function collectVisibleAnchorUpdates(previousSnapshot) {
    const container = findScrollContainer();
    const containerRect = container.getBoundingClientRect();
    const visibleEntries = getHumanMessages().map(messageEl => ({
      element: messageEl,
      id: getMessageId(messageEl),
      text: getMessageText(messageEl),
      pos: Math.round(container.scrollTop + messageEl.getBoundingClientRect().top - containerRect.top),
    }));

    let searchStart = 0;
    const updates = [];
    const updatedIndices = new Set();
    let matchedTargetElement = null;
    let matchedTarget = false;
    let matchedTargetPos = null;

    for (const entry of visibleEntries) {
      let matchedIndex = -1;

      if (entry.id) {
        matchedIndex = messageData.findIndex((message, candidateIndex) =>
          candidateIndex >= searchStart && message.id === entry.id
        );
      }

      if (matchedIndex < 0 && entry.text) {
        matchedIndex = findMessageIndexByTextFrom(entry.text, searchStart);
      }

      if (matchedIndex < 0) continue;

      searchStart = matchedIndex + 1;
      if (previousSnapshot?.targetIndex === matchedIndex) {
        matchedTarget = true;
        matchedTargetElement = entry.element;
        matchedTargetPos = entry.pos;
      }
      const previousPos = previousSnapshot?.positions?.get(matchedIndex);

      if (typeof previousPos === 'number' && Math.round(previousPos) === entry.pos) {
        continue;
      }

      if (typeof previousPos === 'number') {
        updates.push(`  item ${matchedIndex + 1}, pos ${Math.round(previousPos)} -> ${entry.pos}`);
      } else {
        updates.push(`  item ${matchedIndex + 1}, pos ${entry.pos}`);
      }
      updatedIndices.add(matchedIndex);
    }

    return { updates, updatedIndices, matchedTargetElement, matchedTarget, matchedTargetPos };
  }

  function logVisibleAnchorUpdates(previousSnapshot, label = 'scan dom, find') {
    if (!debugModeEnabled) return null;
    const result = collectVisibleAnchorUpdates(previousSnapshot);
    const { updates } = result;
    addDebugLog(label);
    if (updates.length === 0) {
      addDebugLog('  no new pos updates');
      return result;
    }
    for (const update of updates) {
      addDebugLog(update);
    }
    return result;
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

  function mergeKnownAnchorsIntoEntries(nextEntries, knownEntries) {
    if (!Array.isArray(nextEntries) || nextEntries.length === 0) return nextEntries;
    if (!Array.isArray(knownEntries) || knownEntries.length === 0) return nextEntries;

    const byId = new Map();
    const byKey = new Map();

    for (const entry of knownEntries) {
      if (!entry || (typeof entry.anchorTop !== 'number' && typeof entry.scrollTop !== 'number')) continue;
      if (entry.id) {
        byId.set(entry.id, entry);
      }
      if (entry.key) {
        byKey.set(entry.key, entry);
      }
    }

    return nextEntries.map(entry => {
      const known = (entry.id && byId.get(entry.id)) || byKey.get(entry.key);
      if (!known) return entry;

      return {
        ...entry,
        anchorTop: typeof known.anchorTop === 'number' ? known.anchorTop : entry.anchorTop,
        scrollTop: typeof known.scrollTop === 'number' ? known.scrollTop : entry.scrollTop,
      };
    });
  }

  async function fetchChatGptConversationEntries() {
    const conversationId = navCore.getChatGptConversationIdFromUrl(location.href);
    if (!conversationId) {
      throw new Error('Could not determine ChatGPT conversation id');
    }
    const observedResponse = await runtimeSendMessage({
      type: 'cgpt-nav:get-chatgpt-observed-request-stamp',
      conversationId,
    });
    if (!observedResponse?.ok) {
      throw new Error(observedResponse?.error || 'Could not read ChatGPT request state');
    }

    const observedAt = typeof observedResponse.observedAt === 'number' ? observedResponse.observedAt : null;
    if (!observedAt) {
      throw new Error('ChatGPT conversation request has not been observed yet');
    }

    if (lastConsumedObservedRequestAt === observedAt && hasCompletedFullIndexForConversation) {
      return cloneMessageData(messageData);
    }

    const response = await runtimeSendMessage({
      type: 'cgpt-nav:fetch-chatgpt-conversation',
      conversationId,
      observedAt,
    });
    if (!response?.ok) {
      throw new Error(response?.error || 'ChatGPT conversation fetch failed');
    }

    lastConsumedObservedRequestAt = observedAt;
    const conversation = response.payload;
    const messages = navCore.extractChatGptUserMessages(conversation);
    const nextOccurrenceByText = new Map();
    const freshEntries = messages.map(message => {
      const occurrence = nextOccurrenceByText.get(message.text) ?? 0;
      nextOccurrenceByText.set(message.text, occurrence + 1);
      return {
        key: getMessageKey(message.id, message.text, occurrence),
        id: message.id,
        text: message.text,
        segmentWeight: message.segmentWeight,
        scrollTop: null,
        anchorTop: null,
      };
    });

    return mergeKnownAnchorsIntoEntries(freshEntries, messageData);
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
    seedBoundaryAnchors();

    if (normalizedCached) {
      try {
        await storageSet(storage, { [storageKey]: normalizedCached });
      } catch (error) {
        console.warn('AI Chat Navigator cache touch failed', error);
      }
    }

    return messageData;
  }

  async function seedVisibleAnchorsFromCurrentDom() {
    if (!shouldUseDataIndexing() || messageData.length === 0) return;
    await waitForHumanMessages(2500, 100);
    await persistAnchorUpdates(syncVisibleDataMessageAnchors());
  }

  async function saveCachedMessages() {
    const status = hasCompletedFullIndexForConversation ? 'ready' : 'partial';
    const entry = navCore.createConversationCacheEntry({
      conversationKey: currentConversationKey,
      provider: getProvider(),
      messages: messageData,
      status,
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

  function setSidebarStatus(message = '') {
    sidebarStatusMessage = message;
  }

  function renderStatus(message) {
    setSidebarStatus(message);
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

  function shouldBackgroundIndexConversation() {
    if (isScanning) return false;
    if (!navCore.shouldProcessConversationUpdate(currentConversationKey, getConversationKey())) return false;
    if (shouldUseDataIndexing()) {
      return Date.now() - lastDataIndexStartedAt >= DATA_INDEX_MIN_INTERVAL_MS;
    }
    if (shouldUseDomIndexing()) return false;
    return !hasCompletedFullIndexForConversation;
  }

  async function maybeStartBackgroundIndexing(reason = 'unknown') {
    if (!shouldBackgroundIndexConversation()) return;
    if (shouldUseDataIndexing()) {
      lastDataIndexStartedAt = Date.now();
    }

    try {
      await indexMessages();
      if (!navCore.shouldProcessConversationUpdate(currentConversationKey, getConversationKey())) return;
      if (sidebar?.classList.contains('cgpt-nav-visible')) {
        buildSidebar();
      }
    } catch (error) {
      if (error?.message === 'Scan cancelled') return;
      console.error('AI Chat Navigator background index failed', error);
      if (sidebar?.classList.contains('cgpt-nav-visible') && messageData.length === 0) {
        renderStatus('Could not scan messages. Close and reopen the panel to retry.');
      }
    }
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
    setSidebarStatus('');
    resetDebugLogs();
    messageData = [];
    lastObservedDataMutationSignature = '';
    lastConsumedObservedRequestAt = null;

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

    if (shouldUseDataIndexing()) {
      void maybeStartBackgroundIndexing('conversation-change');
    }

    if (sidebarWasVisible) {
      if (messageData.length > 0) {
        buildSidebar();
        if (shouldReuseIndexedMessages()) {
          return;
        }
      }

      await showSidebar();
      return;
    }

    void maybeStartBackgroundIndexing('conversation-change');
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
    let publishedMessageCount = -1;

    const publishScanProgress = async (statusMessage = 'Scanning messages…') => {
      if (!navCore.shouldProcessConversationUpdate(currentConversationKey, getConversationKey())) return;
      if (entries.length === publishedMessageCount && sidebarStatusMessage === statusMessage) return;

      messageData = cloneMessageData(entries);
      publishedMessageCount = entries.length;
      setSidebarStatus(statusMessage);

      if (entries.length > 0) {
        await saveCachedMessages();
      }

      if (sidebar?.classList.contains('cgpt-nav-visible')) {
        buildSidebar();
      }
    };

    const collect = currentTop => {
      let changed = false;
      for (const el of getHumanMessages()) {
        const text = getMessageText(el);
        if (!text) continue;

        const id = getMessageId(el);
        const anchorTop = getMessageAnchorTop(el, currentTop);
        if (id && firstIndexById.has(id)) {
          const existing = entries[firstIndexById.get(id)];
          if (currentTop < existing.scrollTop) {
            existing.scrollTop = currentTop;
            changed = true;
          }
          if (anchorTop < existing.anchorTop) {
            existing.anchorTop = anchorTop;
            changed = true;
          }
          if (text.length > existing.text.length) {
            existing.text = text;
            changed = true;
          }
          continue;
        }

        if (!id) {
          const existingIndex = findNearbyMessageIndexByText(entries, text, anchorTop, dedupeDistance);
          if (existingIndex >= 0) {
            const existing = entries[existingIndex];
            if (currentTop < existing.scrollTop) {
              existing.scrollTop = currentTop;
              changed = true;
            }
            if (anchorTop < existing.anchorTop) {
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

        const occurrence = nextOccurrenceByText.get(text) ?? 0;
        nextOccurrenceByText.set(text, occurrence + 1);

        const key = getMessageKey(id, text, occurrence);
        const entry = { key, id, text, scrollTop: currentTop, anchorTop };
        entries.push(entry);

        if (id) {
          firstIndexById.set(id, entries.length - 1);
        }
        changed = true;
      }

      return changed;
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
      setSidebarStatus('Scanning messages…');
      await waitForHumanMessages();
      let signature = await waitForViewportToSettle('');
      if (collect(container.scrollTop)) {
        await publishScanProgress();
      }

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
        if (collect(container.scrollTop)) {
          await publishScanProgress();
        }

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
      if (collect(container.scrollTop)) {
        await publishScanProgress();
      }

      messageData = entries;
      hasCompletedFullIndexForConversation = entries.length > 0;
      setSidebarStatus(hasCompletedFullIndexForConversation ? 'Scanning done' : 'Scanning messages…');
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
      setSidebarStatus('Scanning done');
      await saveCachedMessages();
      return;
    }

    if (shouldUseDataIndexing()) {
      const requestToken = ++activeScanToken;
      isScanning = true;
      setSidebarStatus('Loading conversation…');

      try {
        const entries = await fetchChatGptConversationEntries();
        if (requestToken !== activeScanToken) {
          throw new Error('Scan cancelled');
        }

        messageData = entries;
        hasCompletedFullIndexForConversation = entries.length > 0;
        seedBoundaryAnchors();
        setSidebarStatus(hasCompletedFullIndexForConversation ? 'Scanning done' : 'No messages yet.');
        if (sidebar?.classList.contains('cgpt-nav-visible')) {
          buildSidebar();
        }
        await saveCachedMessages();
        return;
      } finally {
        isScanning = false;
      }
    }

    await scanMessages();
  }

  async function scrollToMessage(id, index) {
    const { highlightColor } = getSiteConfig();
    const targetMessage = messageData[index];
    if (!targetMessage) return;

    const describeElementForDebug = el => {
      if (!el) return 'null';
      const root = el.closest?.('[data-message-id]') || null;
      const rect = el.getBoundingClientRect();
      return [
        `tag=${el.tagName?.toLowerCase() || 'unknown'}`,
        `id=${getMessageId(el) || 'none'}`,
        `class=${typeof el.className === 'string' && el.className ? el.className.slice(0, 80) : 'none'}`,
        `top=${Math.round(rect.top)}`,
        `height=${Math.round(rect.height)}`,
        `hasRoot=${root ? 'yes' : 'no'}`,
        root && root !== el ? `rootTag=${root.tagName?.toLowerCase() || 'unknown'}` : null,
        root && root !== el ? `rootId=${getMessageId(root) || 'none'}` : null,
      ].filter(Boolean).join(' ');
    };

    const highlight = async (el, forcedTargetPos = null) => {
      const scrollTarget = el.closest?.('[data-message-id]') || el;
      const container = findScrollContainer();
      const containerRect = container.getBoundingClientRect();
      const scrollTargetRect = scrollTarget.getBoundingClientRect();
      const computedTargetPos = Math.round(
        container.scrollTop + scrollTargetRect.top - containerRect.top
      );
      const targetPos = typeof forcedTargetPos === 'number' ? forcedTargetPos : computedTargetPos;
      if (debugModeEnabled && shouldUseDataIndexing()) {
        addDebugLog(`scroll target raw: ${describeElementForDebug(el)}`);
        addDebugLog(`scroll target final: ${describeElementForDebug(scrollTarget)}`);
        if (typeof forcedTargetPos === 'number') {
          addDebugLog(`using scanned pos for final jump: ${forcedTargetPos}`);
        }
        addDebugLog(`final target pos for container.scrollTop: ${targetPos}`);
        addDebugLog(`scroll container top before final jump: ${Math.round(container.scrollTop)}`);
      }
      container.scrollTop = targetPos;
      if (debugModeEnabled && shouldUseDataIndexing()) {
        addDebugLog(`scroll container top immediately after final jump: ${Math.round(container.scrollTop)}`);
        await delay(150);
        addDebugLog(`scroll container top 150ms after final jump: ${Math.round(container.scrollTop)}`);
        await delay(250);
        addDebugLog(`scroll container top 400ms after final jump: ${Math.round(container.scrollTop)}`);
      }
      scrollTarget.style.transition = 'background 0.3s';
      scrollTarget.style.background = highlightColor;
      setTimeout(() => { scrollTarget.style.background = ''; }, 1200);
    };

    if (debugModeEnabled && shouldUseDataIndexing()) {
      beginDebugLogSession(`after clicking item ${index + 1}`);
    }

    if (targetMessage.id) {
      // Element may already be in the DOM (not virtualized out).
      let el = document.querySelector(`[data-message-id="${CSS.escape(targetMessage.id)}"]`);
      if (el) {
        addDebugLog('target already in dom');
        const preSnapshot = debugModeEnabled ? getPositionSnapshot() : null;
        await persistAnchorUpdates(syncVisibleDataMessageAnchors());
        if (debugModeEnabled) {
          logPositionTransitions(preSnapshot, getPositionSnapshot());
          logVisibleAnchorUpdates(preSnapshot);
        }
        addDebugLog('go to it by container.scrollTop = pos');
        await highlight(el);
        return;
      }
    }

    if (shouldUseDataIndexing()) {
      const container = findScrollContainer();
      const maxTop = Math.max(container.scrollHeight - container.clientHeight, 0);
      const findVisibleTarget = () => {
        if (targetMessage.id) {
          const exactMatch = document.querySelector(`[data-message-id="${CSS.escape(targetMessage.id)}"]`);
          if (exactMatch) return exactMatch;
        }

        return getHumanMessages().find(messageEl => {
          const visibleId = getMessageId(messageEl);
          if (targetMessage.id && visibleId) {
            return visibleId === targetMessage.id;
          }
          return getMessageText(messageEl) === targetMessage.text;
        }) ?? null;
      };
      const findVisibleTargetByIndex = () => findVisibleElementForMessageIndex(index);

      const visitedTops = new Set();

      for (let attempt = 0; attempt < 14; attempt += 1) {
        const preJumpVisibleTarget = findVisibleTarget() || findVisibleElementForMessageIndex(index);
        if (preJumpVisibleTarget) {
          const preJumpSnapshot = debugModeEnabled ? getPositionSnapshot(maxTop) : null;
          await persistAnchorUpdates(syncVisibleDataMessageAnchors());
          if (debugModeEnabled) {
            const visibleUpdates = logVisibleAnchorUpdates(preJumpSnapshot, 'pre-jump dom scan and find');
            logPositionTransitions(preJumpSnapshot, getPositionSnapshot(maxTop), visibleUpdates?.updatedIndices, 'pre-jump recalculated pos updates');
          }
          addDebugLog('find the item, go to it by container.scrollTop = pos');
          await highlight(preJumpVisibleTarget);
          return;
        }

        const preJumpSnapshot = debugModeEnabled ? getPositionSnapshot(maxTop) : null;
        await persistAnchorUpdates(syncVisibleDataMessageAnchors());
        if (debugModeEnabled) {
          const preJumpVisibleUpdates = logVisibleAnchorUpdates(preJumpSnapshot, 'pre-jump dom scan and find');
          logPositionTransitions(preJumpSnapshot, getPositionSnapshot(maxTop), preJumpVisibleUpdates?.updatedIndices, 'pre-jump recalculated pos updates');
        }

        let estimatedAnchorTop = estimateMessageAnchorTop(index, maxTop);
        if (typeof estimatedAnchorTop !== 'number') {
          const ratio = messageData.length <= 1 ? 0 : index / (messageData.length - 1);
          estimatedAnchorTop = Math.round(maxTop * ratio);
        }

        const nextTop = Math.max(0, Math.min(estimatedAnchorTop, maxTop));
        if (attempt === 0) {
          addDebugLog(`going to the estimated pos by container.scrollTop = ${nextTop}`);
        } else {
          addDebugLog(`re-estimate to container.scrollTop = ${nextTop}`);
        }
        const topKey = Math.round(nextTop / 4);
        if (visitedTops.has(topKey)) break;
        visitedTops.add(topKey);

        const previousTargetEstimate = estimateMessageAnchorTop(index, maxTop);
        const debugSnapshot = debugModeEnabled ? { ...getPositionSnapshot(maxTop), targetIndex: index } : null;
        container.scrollTop = nextTop;
        await delay(280);
        await persistAnchorUpdates(syncVisibleDataMessageAnchors());
        if (debugModeEnabled) {
          const postJumpVisibleUpdates = logVisibleAnchorUpdates(debugSnapshot, 'post-jump dom scan and find');
          logPositionTransitions(debugSnapshot, getPositionSnapshot(maxTop), postJumpVisibleUpdates?.updatedIndices, 'post-jump recalculated pos updates');
        }
        const { matchedTargetElement, matchedTarget, matchedTargetPos } = collectVisibleAnchorUpdates({ targetIndex: index });
        addDebugLog(`post-jump target matched in scan: ${matchedTarget ? 'yes' : 'no'}`);
        addDebugLog(`post-jump matchedTargetElement: ${matchedTargetElement ? 'yes' : 'no'}`);

        let postScrollVisibleTarget = matchedTargetElement || findVisibleTarget() || findVisibleTargetByIndex();
        if (!postScrollVisibleTarget && matchedTarget) {
          addDebugLog('post-jump target matched but no element returned, retrying resolve');
          await delay(60);
          postScrollVisibleTarget = findVisibleTargetByIndex() || findVisibleTarget();
        }
        addDebugLog(`post-jump resolved target element: ${postScrollVisibleTarget ? 'yes' : 'no'}`);
        if (postScrollVisibleTarget) {
          addDebugLog(`post-jump resolved target isConnected: ${postScrollVisibleTarget.isConnected ? 'yes' : 'no'}`);
          addDebugLog('find the item, go to it by container.scrollTop = pos');
          if (debugModeEnabled && sidebar?.classList.contains('cgpt-nav-visible')) {
            buildSidebar();
          }
          await highlight(postScrollVisibleTarget, matchedTargetPos);
          return;
        }
        if (matchedTarget) {
          addDebugLog('post-jump target was matched in scan but could not be resolved for highlight');
        }

        const nextTargetEstimate = estimateMessageAnchorTop(index, maxTop);
        const targetEstimateChanged = typeof previousTargetEstimate === 'number'
          && typeof nextTargetEstimate === 'number'
          && Math.round(previousTargetEstimate) !== Math.round(nextTargetEstimate);

        if (!targetEstimateChanged) {
          const midpointTop = getMidpointFallbackTop(index, nextTop, maxTop);
          if (typeof midpointTop === 'number' && !visitedTops.has(Math.round(midpointTop / 4))) {
            addDebugLog(`midpoint fallback to container.scrollTop = ${midpointTop}`);
            container.scrollTop = Math.max(0, Math.min(midpointTop, maxTop));
            await delay(280);
            await persistAnchorUpdates(syncVisibleDataMessageAnchors());
            if (debugModeEnabled) {
              const midpointDebugSnapshot = { ...getPositionSnapshot(maxTop), targetIndex: index };
              const midpointVisibleUpdates = logVisibleAnchorUpdates(midpointDebugSnapshot, 'post-jump dom scan and find');
              logPositionTransitions(midpointDebugSnapshot, getPositionSnapshot(maxTop), midpointVisibleUpdates?.updatedIndices, 'post-jump recalculated pos updates');
            }
            const midpointKey = Math.round(midpointTop / 4);
            visitedTops.add(midpointKey);
            const {
              matchedTargetElement: midpointMatchedTargetElement,
              matchedTarget: midpointMatchedTarget,
            } = collectVisibleAnchorUpdates({ targetIndex: index });
            addDebugLog(`midpoint target matched in scan: ${midpointMatchedTarget ? 'yes' : 'no'}`);
            addDebugLog(`midpoint matchedTargetElement: ${midpointMatchedTargetElement ? 'yes' : 'no'}`);

            let midpointVisibleTarget = midpointMatchedTargetElement || findVisibleTarget() || findVisibleTargetByIndex();
            if (!midpointVisibleTarget && midpointMatchedTarget) {
              addDebugLog('midpoint target matched but no element returned, retrying resolve');
              await delay(60);
              midpointVisibleTarget = findVisibleTargetByIndex() || findVisibleTarget();
            }
            addDebugLog(`midpoint resolved target element: ${midpointVisibleTarget ? 'yes' : 'no'}`);
            if (midpointVisibleTarget) {
              addDebugLog(`midpoint resolved target isConnected: ${midpointVisibleTarget.isConnected ? 'yes' : 'no'}`);
              addDebugLog('find the item, go to it by element.scrollIntoView');
              if (debugModeEnabled && sidebar?.classList.contains('cgpt-nav-visible')) {
                buildSidebar();
              }
              highlight(midpointVisibleTarget);
              return;
            }
            if (midpointMatchedTarget) {
              addDebugLog('midpoint target was matched in scan but could not be resolved for highlight');
            }
          }

          // Estimate is stuck — the stored anchor is stale. Clear it so the next
          // iteration re-interpolates from updated neighbor positions instead of
          // returning the same wrong value and hitting the visitedTops guard again.
          if (typeof targetMessage.anchorTop === 'number') {
            addDebugLog(`invalidating stale anchorTop ${targetMessage.anchorTop} for item ${index + 1}`);
            targetMessage.anchorTop = null;
            if (typeof targetMessage.scrollTop === 'number') {
              targetMessage.scrollTop = null;
            }
          }
        }
      }

      addDebugLog('error: could not find the target item in dom after search');

      return;
    }

    if (typeof targetMessage.scrollTop !== 'number') {
      return;
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
      await persistAnchorUpdates(syncVisibleDataMessageAnchors());
      addDebugLog('find text match, go to it by element.scrollIntoView');
      highlight(visibleMatch);
      return;
    }

    container.scrollTop = Math.min(targetMessage.scrollTop, maxTop);
  }

  function buildSidebar() {
    const list = sidebar.querySelector('#cgpt-nav-list');
    const previousScrollTop = list.scrollTop;
    list.innerHTML = '';
    seedBoundaryAnchors();

    const clearAnchorsBtn = sidebar.querySelector('.cgpt-nav-header-btn');
    if (clearAnchorsBtn) {
      const shouldShowClearAnchors = debugModeEnabled && shouldUseDataIndexing();
      clearAnchorsBtn.hidden = !shouldShowClearAnchors;
    }

    renderDebugPanel();

    if (messageData.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'cgpt-nav-empty';
      empty.textContent = sidebarStatusMessage || 'No messages yet.';
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

      if (debugModeEnabled && shouldUseDataIndexing()) {
        const currentPos = estimateMessageAnchorTop(i, getMaxAnchorTop());
        const posMeta = document.createElement('div');
        posMeta.className = 'cgpt-nav-debug-row';
        posMeta.textContent = `pos ${formatAnchorValue(currentPos)}`;
        item.appendChild(posMeta);
      }

      item.addEventListener('click', () => scrollToMessage(id, i));
      list.appendChild(item);
    });

    if (sidebarStatusMessage) {
      const status = document.createElement('div');
      status.className = 'cgpt-nav-status';
      status.textContent = sidebarStatusMessage;
      list.appendChild(status);
    }

    list.scrollTop = previousScrollTop;
  }

  function createSidebar() {
    sidebar = document.createElement('div');
    sidebar.id = SIDEBAR_ID;

    const header = document.createElement('div');
    header.className = 'cgpt-nav-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'cgpt-nav-title-wrap';

    const title = document.createElement('span');
    title.textContent = 'Your Messages';
    titleWrap.appendChild(title);

    const debugPanel = document.createElement('div');
    debugPanel.id = 'cgpt-nav-debug-panel';
    debugPanel.hidden = true;
    titleWrap.appendChild(debugPanel);

    const headerActions = document.createElement('div');
    headerActions.className = 'cgpt-nav-header-actions';

    const clearAnchorsBtn = document.createElement('button');
    clearAnchorsBtn.className = 'cgpt-nav-header-btn';
    clearAnchorsBtn.type = 'button';
    clearAnchorsBtn.textContent = 'Clear anchors';
    clearAnchorsBtn.title = 'Clear cached absolute positions for this chat';
    clearAnchorsBtn.hidden = true;
    clearAnchorsBtn.addEventListener('click', clearCurrentConversationAnchors);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'cgpt-nav-close';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Close sidebar';
    closeBtn.addEventListener('click', hideSidebar);

    headerActions.appendChild(clearAnchorsBtn);
    headerActions.appendChild(closeBtn);
    header.appendChild(titleWrap);
    header.appendChild(headerActions);

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
    sidebar.classList.add('cgpt-nav-visible');
    toggle.classList.add('cgpt-nav-active');

    if (isScanning) {
      if (messageData.length > 0) {
        buildSidebar();
      } else {
        renderStatus(shouldUseDomIndexing() ? 'Loading messages…' : 'Scanning messages…');
      }
      return;
    }

    if (!navCore.shouldProcessConversationUpdate(currentConversationKey, getConversationKey())) {
      await loadCachedMessages();
    }

    if (messageData.length > 0) {
      buildSidebar();
      if (shouldReuseIndexedMessages()) {
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

  async function loadDebugModePreference() {
    const storage = getStorageArea();
    if (!storage) return false;

    const result = await storageGet(storage, { [DEBUG_MODE_KEY]: false });
    debugModeEnabled = Boolean(result[DEBUG_MODE_KEY]);
    return debugModeEnabled;
  }

  function watchPreferenceChanges() {
    if (!chrome.storage?.onChanged) return;

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;

      if (changes[AUTO_SHOW_KEY]) {
        autoShowEnabled = Boolean(changes[AUTO_SHOW_KEY].newValue);

        if (autoShowEnabled && sidebar && !sidebar.classList.contains('cgpt-nav-visible')) {
          showSidebar();
        }
      }

      if (changes[DEBUG_MODE_KEY]) {
        debugModeEnabled = Boolean(changes[DEBUG_MODE_KEY].newValue);
        if (sidebar?.classList.contains('cgpt-nav-visible')) {
          buildSidebar();
        }
      }
    });
  }

  function watchRuntimeMessages() {
    if (!chrome.runtime?.onMessage) return;

    chrome.runtime.onMessage.addListener(message => {
      if (message?.type !== 'cgpt-nav:chatgpt-request-observed') return;
      if (!shouldUseDataIndexing()) return;

      const conversationId = navCore.getChatGptConversationIdFromUrl(location.href);
      if (!conversationId || message.conversationId !== conversationId) return;
      if (typeof message.observedAt === 'number' && message.observedAt === lastConsumedObservedRequestAt) {
        return;
      }

      lastDataIndexStartedAt = 0;
      void maybeStartBackgroundIndexing('observed-request');
    });
  }

  let rebuildTimer = null;

  function startObserver() {
    observer = new MutationObserver(() => {
      clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(() => {
        if (!navCore.shouldProcessConversationUpdate(currentConversationKey, getConversationKey())) return;

        if (shouldUseDataIndexing()) {
          return;
        }

        if (!sidebar.classList.contains('cgpt-nav-visible') || isScanning) return;

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
        if (!shouldUseDomIndexing() && !hasCompletedFullIndexForConversation) {
          return;
        }

        if (hasCompletedFullIndexForConversation) {
          void saveCachedMessages();
        }
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
    await seedVisibleAnchorsFromCurrentDom();
    lastObservedDataMutationSignature = getVisibleDataMutationSignature();
    await loadAutoShowPreference();
    await loadDebugModePreference();
    void maybeStartBackgroundIndexing('init');
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
  watchRuntimeMessages();

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
