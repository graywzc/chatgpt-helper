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

  const api = {
    cloneMessageData,
    createMessageKey,
    findNearbyMessageIndexByText,
    getConversationCacheStorageKey,
    getConversationKeyFromUrl,
    normalizeMessageText,
    shouldProcessConversationUpdate,
  };

  globalScope.CGPTNavCore = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
