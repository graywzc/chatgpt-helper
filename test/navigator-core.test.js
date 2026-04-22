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
  assert.deepEqual(manifest.content_scripts[0].js, ['navigator-core.js', 'content.js']);
});

test('popup includes the auto-show toggle controls', () => {
  const popupPath = path.join(__dirname, '..', 'popup.html');
  const popupHtml = fs.readFileSync(popupPath, 'utf8');

  assert.match(popupHtml, /Show sidebar automatically/);
  assert.match(popupHtml, /id="auto-show-toggle"/);
  assert.match(popupHtml, /popup\.js/);
});
