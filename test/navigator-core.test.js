const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../navigator-core.js');

test('normalizes the user message text and removes the You said prefix', () => {
  assert.equal(core.normalizeMessageText('  You said:   hello   world  '), 'hello world');
  assert.equal(core.normalizeMessageText('You said - test prompt'), 'test prompt');
  assert.equal(core.normalizeMessageText('plain prompt'), 'plain prompt');
});

test('creates stable conversation cache keys from urls', () => {
  assert.equal(
    core.getConversationKeyFromUrl('https://chatgpt.com/c/69e66adc-1e2c-83e8-8799-3d1fc784ddc9?model=gpt-4o'),
    'https://chatgpt.com/c/69e66adc-1e2c-83e8-8799-3d1fc784ddc9'
  );
  assert.equal(
    core.getConversationKeyFromUrl('https://gemini.google.com/app/1a1b97320be15e3a'),
    'https://gemini.google.com/app/1a1b97320be15e3a'
  );
});

test('creates storage keys for cached conversation indexes', () => {
  assert.equal(
    core.getConversationCacheStorageKey('cgptNavCache:', 'https://chatgpt.com/c/abc'),
    'cgptNavCache:https://chatgpt.com/c/abc'
  );
});

test('maps supported hosts to providers', () => {
  assert.equal(core.getProviderForHost('chatgpt.com'), 'chatgpt');
  assert.equal(core.getProviderForHost('chat.openai.com'), 'chatgpt');
  assert.equal(core.getProviderForHost('claude.ai'), 'claude');
  assert.equal(core.getProviderForHost('gemini.google.com'), 'gemini');
});

test('dedupes nearby no-id messages with the same text', () => {
  const messages = [
    { text: 'what is Chrome auto browse', scrollTop: 100, anchorTop: 140 },
  ];

  assert.equal(
    core.findNearbyMessageIndexByText(messages, 'what is Chrome auto browse', 150, 40),
    0
  );
});

test('does not dedupe far-apart repeated prompts', () => {
  const messages = [
    { text: 'repeat prompt', scrollTop: 100, anchorTop: 140 },
  ];

  assert.equal(
    core.findNearbyMessageIndexByText(messages, 'repeat prompt', 600, 40),
    -1
  );
});

test('blocks conversation updates when the active topic changed', () => {
  assert.equal(
    core.shouldProcessConversationUpdate(
      'https://gemini.google.com/app/topic-a',
      'https://gemini.google.com/app/topic-b'
    ),
    false
  );
  assert.equal(
    core.shouldProcessConversationUpdate(
      'https://gemini.google.com/app/topic-a',
      'https://gemini.google.com/app/topic-a'
    ),
    true
  );
});

test('uses DOM indexing for claude and gemini, scan indexing elsewhere', () => {
  assert.equal(core.getIndexingModeForHost('claude.ai'), 'dom');
  assert.equal(core.getIndexingModeForHost('gemini.google.com'), 'dom');
  assert.equal(core.getIndexingModeForHost('chatgpt.com'), 'data');
});

test('only reuses cached scan results after a full index completed', () => {
  assert.equal(core.shouldReuseIndexedMessages('dom', false), true);
  assert.equal(core.shouldReuseIndexedMessages('scan', true), true);
  assert.equal(core.shouldReuseIndexedMessages('scan', false), false);
});

test('extracts the ChatGPT conversation id from chat URLs', () => {
  assert.equal(
    core.getChatGptConversationIdFromUrl('https://chatgpt.com/c/69e66adc-1e2c-83e8-8799-3d1fc784ddc9'),
    '69e66adc-1e2c-83e8-8799-3d1fc784ddc9'
  );
  assert.equal(core.getChatGptConversationIdFromUrl('https://chatgpt.com/'), null);
});

test('extracts user asks from the active ChatGPT conversation branch', () => {
  const messages = core.extractChatGptUserMessages({
    current_node: 'assistant-2',
    mapping: {
      root: { id: 'root', parent: null, message: null },
      'user-1': {
        id: 'user-1',
        parent: 'root',
        message: {
          id: 'user-1',
          author: { role: 'user' },
          create_time: 1,
          content: {
            content_type: 'text',
            parts: ['First ask'],
          },
        },
      },
      'assistant-1': {
        id: 'assistant-1',
        parent: 'user-1',
        message: {
          id: 'assistant-1',
          author: { role: 'assistant' },
          create_time: 2,
          content: {
            content_type: 'text',
            parts: ['Answer'],
          },
        },
      },
      'user-2': {
        id: 'user-2',
        parent: 'assistant-1',
        message: {
          id: 'user-2',
          author: { role: 'user' },
          create_time: 3,
          content: {
            content_type: 'multimodal_text',
            parts: [
              'Second ask',
              { type: 'text', text: 'with extra detail' },
            ],
          },
        },
      },
      'assistant-2': {
        id: 'assistant-2',
        parent: 'user-2',
        message: {
          id: 'assistant-2',
          author: { role: 'assistant' },
          create_time: 4,
          content: {
            content_type: 'text',
            parts: ['Another answer'],
          },
        },
      },
      'user-alt': {
        id: 'user-alt',
        parent: 'assistant-1',
        message: {
          id: 'user-alt',
          author: { role: 'user' },
          create_time: 3.5,
          content: {
            content_type: 'text',
            parts: ['Ignored alternate branch'],
          },
        },
      },
    },
  });

  assert.deepEqual(messages, [
    { id: 'user-1', text: 'First ask', segmentWeight: 15 },
    { id: 'user-2', text: 'Second ask with extra detail', segmentWeight: 42 },
  ]);
});

test('creates provider-agnostic cache entries with metadata', () => {
  const entry = core.createConversationCacheEntry({
    conversationKey: 'https://claude.ai/chat/abc',
    provider: 'claude',
    messages: [{ key: 'id:1', text: 'hello', scrollTop: 10, anchorTop: 12 }],
    status: 'ready',
    indexedAt: 100,
    lastVisitedAt: 200,
    indexVersion: 3,
  });

  assert.deepEqual(entry, {
    conversationKey: 'https://claude.ai/chat/abc',
    provider: 'claude',
    status: 'ready',
    indexedAt: 100,
    lastVisitedAt: 200,
    indexVersion: 3,
    messageCount: 1,
    messages: [{ key: 'id:1', text: 'hello', scrollTop: 10, anchorTop: 12 }],
  });
});

test('normalizes legacy array cache entries into the shared cache shape', () => {
  const normalized = core.normalizeConversationCacheEntry(
    [{ key: 'id:1', text: 'hello', scrollTop: 10, anchorTop: 12 }],
    {
      conversationKey: 'https://gemini.google.com/app/abc',
      provider: 'gemini',
    }
  );

  assert.equal(normalized.conversationKey, 'https://gemini.google.com/app/abc');
  assert.equal(normalized.provider, 'gemini');
  assert.equal(normalized.status, 'ready');
  assert.equal(normalized.messageCount, 1);
  assert.deepEqual(normalized.messages, [{ key: 'id:1', text: 'hello', scrollTop: 10, anchorTop: 12 }]);
});

test('normalizes object cache entries and fills missing defaults', () => {
  const normalized = core.normalizeConversationCacheEntry(
    {
      status: 'partial',
      messages: [{ key: 'id:2', text: 'hi', scrollTop: 20, anchorTop: 25 }],
    },
    {
      conversationKey: 'https://chatgpt.com/c/abc',
      provider: 'chatgpt',
    }
  );

  assert.equal(normalized.conversationKey, 'https://chatgpt.com/c/abc');
  assert.equal(normalized.provider, 'chatgpt');
  assert.equal(normalized.status, 'partial');
  assert.equal(normalized.indexVersion, 1);
  assert.equal(normalized.messageCount, 1);
  assert.deepEqual(normalized.messages, [{ key: 'id:2', text: 'hi', scrollTop: 20, anchorTop: 25 }]);
});

test('clones message data without reusing object references', () => {
  const original = [{ key: 'id:1', text: 'hello', scrollTop: 10, anchorTop: 12 }];
  const cloned = core.cloneMessageData(original);

  assert.deepEqual(cloned, original);
  assert.notEqual(cloned, original);
  assert.notEqual(cloned[0], original[0]);
});

test('manifest includes storage permission and loads the shared core before the content script', () => {
  const manifestPath = path.join(__dirname, '..', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  assert.ok(manifest.permissions.includes('storage'));
  assert.ok(manifest.permissions.includes('webRequest'));
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.deepEqual(manifest.content_scripts[0].js, ['navigator-core.js', 'content.js']);
});

test('content script stores conversation indexes in chrome.storage.local', () => {
  const contentPath = path.join(__dirname, '..', 'content.js');
  const contentSource = fs.readFileSync(contentPath, 'utf8');

  assert.match(contentSource, /function getCacheStorageArea\(\)\s*\{\s*return chrome\.storage\?\.local \?\? null;\s*\}/);
  assert.doesNotMatch(contentSource, /chrome\.storage\?\.session/);
});

test('content script requests ChatGPT conversation data through the extension worker', () => {
  const contentPath = path.join(__dirname, '..', 'content.js');
  const contentSource = fs.readFileSync(contentPath, 'utf8');

  assert.match(contentSource, /chrome\.runtime\.sendMessage\(message,\s*response =>/);
  assert.match(contentSource, /chrome\.runtime\.onMessage\.addListener/);
  assert.match(contentSource, /cgpt-nav:chatgpt-request-observed/);
  assert.match(contentSource, /type:\s*'cgpt-nav:get-chatgpt-observed-request-stamp'/);
  assert.match(contentSource, /type:\s*'cgpt-nav:fetch-chatgpt-conversation'/);
  assert.match(contentSource, /lastConsumedObservedRequestAt/);
  assert.match(contentSource, /segmentWeight:\s*message\.segmentWeight/);
  assert.match(contentSource, /estimateMessageAnchorTop/);
  assert.match(contentSource, /const DEBUG_MODE_KEY = 'cgptNavDebugMode'/);
  assert.match(contentSource, /Clear cached absolute positions for this chat/);
  assert.match(contentSource, /pos \$\{formatAnchorValue\(currentPos\)\}/);
  assert.match(contentSource, /mergeKnownAnchorsIntoEntries/);
  assert.match(contentSource, /cgpt-nav-debug-panel/);
  assert.match(contentSource, /going to the estimated pos by container\.scrollTop/);
  assert.match(contentSource, /go to it by container\.scrollTop = pos/);
  assert.doesNotMatch(contentSource, /__cgptNavDebug/);
  assert.doesNotMatch(contentSource, /AI Chat Navigator debug/);
});

test('background worker captures conversation request headers and fetches ChatGPT conversations', () => {
  const backgroundPath = path.join(__dirname, '..', 'background.js');
  const backgroundSource = fs.readFileSync(backgroundPath, 'utf8');

  assert.match(backgroundSource, /chrome\.webRequest\.onBeforeSendHeaders\.addListener/);
  assert.match(backgroundSource, /chrome\.tabs\.sendMessage/);
  assert.match(backgroundSource, /cgpt-nav:chatgpt-request-observed/);
  assert.match(backgroundSource, /cgpt-nav:get-chatgpt-observed-request-stamp/);
  assert.match(backgroundSource, /message\?\.\s*type\s*!==\s*'cgpt-nav:fetch-chatgpt-conversation'/);
  assert.match(backgroundSource, /latestObservedConversationRequestAt/);
  assert.match(backgroundSource, /No fresh ChatGPT conversation request to mirror yet/);
  assert.match(backgroundSource, /ChatGPT auth headers have not been captured yet/);
  assert.match(backgroundSource, /https:\/\/chatgpt\.com\/backend-api\/conversation/);
  assert.doesNotMatch(backgroundSource, /AI Chat Navigator background/);
});

test('popup includes the auto-show toggle controls', () => {
  const popupPath = path.join(__dirname, '..', 'popup.html');
  const popupHtml = fs.readFileSync(popupPath, 'utf8');

  assert.match(popupHtml, /Show sidebar automatically/);
  assert.match(popupHtml, /id="auto-show-toggle"/);
  assert.match(popupHtml, /Navigation debug mode/);
  assert.match(popupHtml, /id="debug-mode-toggle"/);
  assert.match(popupHtml, /popup\.js/);
});

test('popup script persists the debug mode toggle', () => {
  const popupScriptPath = path.join(__dirname, '..', 'popup.js');
  const popupSource = fs.readFileSync(popupScriptPath, 'utf8');

  assert.match(popupSource, /const DEBUG_MODE_KEY = 'cgptNavDebugMode'/);
  assert.match(popupSource, /debug-mode-toggle/);
  assert.match(popupSource, /debug-mode-status/);
});

test('navigation loop clears stale anchorTop when the position estimate is stuck', () => {
  const contentPath = path.join(__dirname, '..', 'content.js');
  const contentSource = fs.readFileSync(contentPath, 'utf8');

  // The !targetEstimateChanged branch must null out the anchor so the next
  // iteration re-interpolates from neighbors rather than returning the same
  // stale value and hitting the visitedTops guard again.
  assert.match(contentSource, /if \(!targetEstimateChanged\)/);
  assert.match(contentSource, /targetMessage\.anchorTop = null/);

  // previousTargetEstimate and nextTargetEstimate must use a direct
  // estimateMessageAnchorTop call, not a full position-map snapshot.
  assert.match(contentSource, /previousTargetEstimate = estimateMessageAnchorTop\(index, maxTop\)/);
  assert.match(contentSource, /nextTargetEstimate = estimateMessageAnchorTop\(index, maxTop\)/);
});

test('debug logging in the navigation loop is gated on debugModeEnabled', () => {
  const contentPath = path.join(__dirname, '..', 'content.js');
  const contentSource = fs.readFileSync(contentPath, 'utf8');

  // logVisibleAnchorUpdates must short-circuit when debug mode is off so it
  // never triggers a DOM scan unconditionally.
  assert.match(contentSource, /function logVisibleAnchorUpdates[\s\S]*?if \(!debugModeEnabled\) return null/);

  // collectVisibleAnchorUpdates in the navigation loop must receive only
  // { targetIndex: index } — the positions map is only needed for debug output.
  assert.match(contentSource, /collectVisibleAnchorUpdates\(\{ targetIndex: index \}\)/);

  // getPositionSnapshot must be called conditionally, never unconditionally
  // inside the navigation hot-path.
  assert.match(contentSource, /debugModeEnabled \? getPositionSnapshot\(/);

  // syncVisibleDataMessageAnchors must not be called with the debugModeEnabled
  // argument (it never accepted one; the argument was silently ignored).
  assert.doesNotMatch(contentSource, /syncVisibleDataMessageAnchors\(debugModeEnabled\)/);
});
