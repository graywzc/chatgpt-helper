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
    if (host === 'chatgpt.com' || host === 'chat.openai.com') {
      return 'data';
    }
    return 'scan';
  }

  function shouldReuseIndexedMessages(indexingMode, hasCompletedFullIndex) {
    return indexingMode === 'dom' || Boolean(hasCompletedFullIndex);
  }

  function getChatGptConversationIdFromUrl(url) {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/c\/([^/]+)$/);
    return match ? match[1] : null;
  }

  function extractTextFromChatGptContent(value, textParts = []) {
    if (typeof value === 'string') {
      textParts.push(value);
      return textParts;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        extractTextFromChatGptContent(item, textParts);
      }
      return textParts;
    }

    if (!value || typeof value !== 'object') {
      return textParts;
    }

    if (typeof value.text === 'string') {
      textParts.push(value.text);
    }

    if (typeof value.result === 'string') {
      textParts.push(value.result);
    }

    if (typeof value.value === 'string') {
      textParts.push(value.value);
    }

    if (typeof value.caption === 'string') {
      textParts.push(value.caption);
    }

    if (Array.isArray(value.parts)) {
      extractTextFromChatGptContent(value.parts, textParts);
    }

    if (Array.isArray(value.content)) {
      extractTextFromChatGptContent(value.content, textParts);
    }

    return textParts;
  }

  function getOrderedChatGptNodes(conversation) {
    const mapping = conversation?.mapping;
    if (!mapping || typeof mapping !== 'object') return [];

    const nodes = Object.values(mapping).filter(node => node && typeof node === 'object');
    if (nodes.length === 0) return [];

    const currentNodeId = conversation?.current_node;
    if (currentNodeId && mapping[currentNodeId]) {
      const lineage = [];
      const seen = new Set();
      let cursor = mapping[currentNodeId];

      while (cursor) {
        const key = cursor.id ?? cursor.message?.id ?? cursor.parent ?? `node-${lineage.length}`;
        if (seen.has(key)) break;
        seen.add(key);
        lineage.push(cursor);
        cursor = cursor.parent ? mapping[cursor.parent] : null;
      }

      return lineage.reverse();
    }

    return nodes.sort((a, b) => {
      const aTime = typeof a?.message?.create_time === 'number' ? a.message.create_time : Number.POSITIVE_INFINITY;
      const bTime = typeof b?.message?.create_time === 'number' ? b.message.create_time : Number.POSITIVE_INFINITY;
      if (aTime !== bTime) return aTime - bTime;
      return String(a?.id ?? a?.message?.id ?? '').localeCompare(String(b?.id ?? b?.message?.id ?? ''));
    });
  }

  function extractChatGptUserMessages(conversation) {
    const orderedNodes = getOrderedChatGptNodes(conversation);
    const messages = [];
    let currentUserMessage = null;

    for (const node of orderedNodes) {
      const message = node?.message;
      if (!message) continue;
      const text = normalizeMessageText(
        extractTextFromChatGptContent(message.content).join(' ')
      );
      const textLength = Math.max(text.length, 1);

      if (!text) continue;

      if (message.author?.role !== 'user') {
        if (currentUserMessage) {
          currentUserMessage.segmentWeight += textLength;
        }
        continue;
      }

      currentUserMessage = {
        id: message.id ?? node.id ?? null,
        text,
        segmentWeight: textLength,
      };
      messages.push(currentUserMessage);
    }

    return messages;
  }

  const api = {
    cloneMessageData,
    createConversationCacheEntry,
    createMessageKey,
    extractChatGptUserMessages,
    findNearbyMessageIndexByText,
    getChatGptConversationIdFromUrl,
    getConversationCacheStorageKey,
    getConversationKeyFromUrl,
    getIndexingModeForHost,
    getProviderForHost,
    normalizeMessageText,
    normalizeConversationCacheEntry,
    shouldReuseIndexedMessages,
    shouldProcessConversationUpdate,
  };

  globalScope.CGPTNavCore = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
