const CHATGPT_CONVERSATION_URL_PATTERN = /^https:\/\/chatgpt\.com\/backend-api\/conversation\/([^/?#]+)/;
const HEADER_ALLOWLIST = new Set([
  'authorization',
  'oai-client-build-number',
  'oai-client-version',
  'oai-device-id',
  'oai-language',
  'openai-organization',
  'x-openai-target-path',
  'x-openai-target-route',
]);

let latestChatGptRequestHeaders = null;
const latestObservedConversationRequestAt = new Map();
const FETCH_TIMEOUT_MS = 10000;

function getConversationIdFromUrl(url) {
  const match = typeof url === 'string' ? url.match(CHATGPT_CONVERSATION_URL_PATTERN) : null;
  return match ? decodeURIComponent(match[1]) : null;
}

function normalizeCapturedHeaders(headers = [], url) {
  const conversationId = getConversationIdFromUrl(url);
  if (!conversationId) return null;

  const normalized = {
    capturedAt: Date.now(),
    conversationId,
    headers: {
      accept: 'application/json',
    },
  };

  for (const header of headers) {
    const name = String(header?.name || '').toLowerCase();
    if (!HEADER_ALLOWLIST.has(name)) continue;
    normalized.headers[name] = header.value;
  }

  if (!normalized.headers.authorization) {
    return null;
  }

  normalized.headers['x-openai-target-path'] = `/backend-api/conversation/${conversationId}`;
  normalized.headers['x-openai-target-route'] = '/backend-api/conversation/{conversation_id}';
  return normalized;
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  details => {
    const normalized = normalizeCapturedHeaders(details.requestHeaders, details.url);
    if (normalized) {
      latestChatGptRequestHeaders = normalized;
      latestObservedConversationRequestAt.set(normalized.conversationId, normalized.capturedAt);
      if (typeof details.tabId === 'number' && details.tabId >= 0) {
        chrome.tabs.sendMessage(details.tabId, {
          type: 'cgpt-nav:chatgpt-request-observed',
          conversationId: normalized.conversationId,
          observedAt: normalized.capturedAt,
        }, () => {
          void chrome.runtime?.lastError;
        });
      }
    }
  },
  {
    urls: [
      'https://chatgpt.com/backend-api/conversation/*',
      'https://chat.openai.com/backend-api/conversation/*',
    ],
    types: ['xmlhttprequest', 'other'],
  },
  ['requestHeaders', 'extraHeaders']
);

async function fetchConversationJson(conversationId) {
  if (!latestChatGptRequestHeaders?.headers?.authorization) {
    throw new Error('ChatGPT auth headers have not been captured yet');
  }

  const url = `https://chatgpt.com/backend-api/conversation/${encodeURIComponent(conversationId)}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(latestChatGptRequestHeaders.headers)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    headers.set(name, value);
  }

  headers.set('accept', 'application/json');
  headers.set('x-openai-target-path', `/backend-api/conversation/${conversationId}`);
  headers.set('x-openai-target-route', '/backend-api/conversation/{conversation_id}');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`ChatGPT conversation fetch timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(`ChatGPT conversation fetch failed (${response.status})`);
  }

  return await response.json();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'cgpt-nav:get-chatgpt-observed-request-stamp') {
    const conversationId = typeof message.conversationId === 'string' ? message.conversationId : null;
    sendResponse({
      ok: true,
      observedAt: conversationId ? (latestObservedConversationRequestAt.get(conversationId) ?? null) : null,
    });
    return undefined;
  }

  if (message?.type !== 'cgpt-nav:fetch-chatgpt-conversation') return undefined;

  const conversationId = typeof message.conversationId === 'string' ? message.conversationId : null;
  const observedAt = typeof message.observedAt === 'number' ? message.observedAt : null;
  if (!conversationId) {
    sendResponse({ ok: false, error: 'Missing conversation id' });
    return undefined;
  }

  const latestObservedAt = latestObservedConversationRequestAt.get(conversationId) ?? null;
  if (!latestObservedAt) {
    sendResponse({ ok: false, error: 'ChatGPT conversation request has not been observed yet' });
    return undefined;
  }

  if (observedAt !== latestObservedAt) {
    sendResponse({
      ok: false,
      stale: true,
      error: 'No fresh ChatGPT conversation request to mirror yet',
      observedAt: latestObservedAt,
    });
    return undefined;
  }

  void (async () => {
    try {
      const payload = await fetchConversationJson(conversationId);
      sendResponse({ ok: true, payload });
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
  })();

  return true;
});
