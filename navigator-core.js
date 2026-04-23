(function (globalScope) {
  function normalizeMessageText(rawText) {
    return String(rawText || '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^You said[:\s-]*/i, '')
      .trim();
  }

  function createMessageKey(id, text, occurrence) {
    if (id) return `id:${id}`;
    return `text:${String(text).slice(0, 200)}#${occurrence}`;
  }

  function findNearbyMessageIndexByText(messages, text, anchorTop, maxDistance) {
    return messages.findIndex(message =>
      !message.id
      && message.text === text
      && Math.abs((message.anchorTop ?? message.scrollTop) - anchorTop) <= maxDistance
    );
  }

  function cloneMessageData(messages) {
    return messages.map(message => ({ ...message }));
  }

  function getProviderForHost(host) {
    if (host === 'claude.ai') return 'claude';
    if (host === 'gemini.google.com') return 'gemini';
    if (host === 'chatgpt.com' || host === 'chat.openai.com') return 'chatgpt';
    return 'unknown';
  }

  function createConversationCacheEntry({
    conversationKey,
    provider,
    messages,
    status = 'ready',
    indexedAt = Date.now(),
    lastVisitedAt = indexedAt,
    indexVersion = 1,
  }) {
    return {
      conversationKey,
      provider,
      status,
      indexedAt,
      lastVisitedAt,
      indexVersion,
      messageCount: Array.isArray(messages) ? messages.length : 0,
      messages: cloneMessageData(Array.isArray(messages) ? messages : []),
    };
  }

  function normalizeConversationCacheEntry(rawEntry, fallback = {}) {
    const {
      conversationKey = null,
      provider = 'unknown',
    } = fallback;

    if (Array.isArray(rawEntry)) {
      return createConversationCacheEntry({
        conversationKey,
        provider,
        messages: rawEntry,
      });
    }

    if (!rawEntry || typeof rawEntry !== 'object') {
      return createConversationCacheEntry({
        conversationKey,
        provider,
        messages: [],
        status: 'partial',
      });
    }

    return createConversationCacheEntry({
      conversationKey: rawEntry.conversationKey ?? conversationKey,
      provider: rawEntry.provider ?? provider,
      messages: Array.isArray(rawEntry.messages) ? rawEntry.messages : [],
      status: rawEntry.status ?? 'ready',
      indexedAt: typeof rawEntry.indexedAt === 'number' ? rawEntry.indexedAt : Date.now(),
      lastVisitedAt: typeof rawEntry.lastVisitedAt === 'number'
        ? rawEntry.lastVisitedAt
        : (typeof rawEntry.indexedAt === 'number' ? rawEntry.indexedAt : Date.now()),
      indexVersion: typeof rawEntry.indexVersion === 'number' ? rawEntry.indexVersion : 1,
    });
  }

  function getConversationKeyFromUrl(url) {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  }

  function getConversationCacheStorageKey(prefix, conversationKey) {
    return `${prefix}${conversationKey}`;
  }

  function shouldProcessConversationUpdate(currentConversationKey, liveConversationKey) {
    return currentConversationKey === liveConversationKey;
  }

  function getIndexingModeForHost(host) {
    if (host === 'claude.ai' || host === 'gemini.google.com') {
      return 'dom';
    }
    return 'scan';
  }

  const api = {
    cloneMessageData,
    createConversationCacheEntry,
    createMessageKey,
    findNearbyMessageIndexByText,
    getConversationCacheStorageKey,
    getConversationKeyFromUrl,
    getIndexingModeForHost,
    getProviderForHost,
    normalizeMessageText,
    normalizeConversationCacheEntry,
    shouldProcessConversationUpdate,
  };

  globalScope.CGPTNavCore = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
