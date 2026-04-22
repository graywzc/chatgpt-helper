# AI Chat Navigator Testing Checklist

This repo does not currently include an automated test runner, so this file tracks manual regression tests for the issues fixed in the current branch.

## 1. Virtual scrolling missed older asks

- Issue:
  The sidebar only listed a subset of user asks because ChatGPT virtualizes the conversation DOM.
- Fix summary:
  The content script now performs a denser top-to-bottom scan, records stable message metadata, and navigates using cached positions instead of only the currently rendered DOM.
- Test steps:
  1. Open a long ChatGPT conversation with many user asks.
  2. Scroll to the middle or near the bottom of the thread.
  3. Open the sidebar.
  4. Confirm the sidebar lists asks from the whole conversation, including early asks that are not currently visible on screen.
  5. Click an early ask and confirm the thread scrolls back to that message.

## 2. Popup toggle to auto-show the sidebar

- Issue:
  The popup had no way to enable automatic sidebar opening.
- Fix summary:
  Added a popup toggle backed by `chrome.storage` that enables automatic sidebar opening on supported sites.
- Test steps:
  1. Open the extension popup.
  2. Confirm the `Show sidebar automatically` toggle is visible.
  3. Enable the toggle.
  4. Refresh a supported chat page.
  5. Confirm the sidebar opens automatically.
  6. Disable the toggle.
  7. Refresh again and confirm the sidebar does not auto-open.

## 3. `You said` prefix appeared in sidebar items

- Issue:
  Sidebar labels displayed `You said` before the actual ask text.
- Fix summary:
  User message text is now normalized before caching and rendering so the `You said` prefix is removed.
- Test steps:
  1. Open one ChatGPT conversation, one Claude conversation, and one Gemini conversation.
  2. Open the sidebar on each site.
  3. Confirm sidebar labels begin with the real ask text and do not include `You said`.

## 4. Claude duplicated the same ask repeatedly

- Issue:
  Claude sometimes repeated the same ask multiple times in the sidebar when only one ask existed.
- Fix summary:
  Deduplication for messages without stable ids now merges nearby same-text entries instead of treating each overlapping scan step as a new ask.
- Test steps:
  1. Open a Claude conversation with a single user ask.
  2. Open the sidebar.
  3. Confirm the ask appears exactly once.
  4. Close and reopen the sidebar.
  5. Confirm duplicates are still not added.

## 5. Claude sidebar got stuck on `Scanning messages...`

- Issue:
  Some Claude conversations caused the scan to run visually but never leave the loading state.
- Fix summary:
  The scan loop now detects stalls, supports cancellation, and always resolves the sidebar out of the loading state.
- Test steps:
  1. Open a long Claude conversation.
  2. Open the sidebar.
  3. Confirm the panel eventually shows either the message list, `No messages yet.`, or a retryable error message.
  4. Confirm it does not stay forever on `Scanning messages...`.

## 6. Revisiting a topic triggered a rescan

- Issue:
  Returning to a previously visited topic forced a new scan instead of reusing the previous index.
- Fix summary:
  Added per-conversation caching so previously scanned topics can restore their sidebar entries without another full crawl.
- Test steps:
  1. Open a conversation and let the sidebar finish loading.
  2. Switch to another conversation.
  3. Switch back to the first conversation.
  4. Confirm the sidebar restores quickly without visible full-page scan scrolling.

## 7. Gemini mixed asks from other topics into the current topic

- Issue:
  Gemini sometimes included asks from unrelated topics in the current sidebar.
- Fix summary:
  Gemini message lookup is now scoped to the active `main` conversation region and ignores hidden/non-visible nodes.
- Test steps:
  1. Open Gemini topic A and scan it.
  2. Switch to Gemini topic B with clearly different asks.
  3. Open the sidebar in topic B.
  4. Confirm asks from topic A are not present in topic B.

## 8. Gemini duplicated asks in the sidebar

- Issue:
  Gemini sometimes showed the same ask twice.
- Fix summary:
  No-id deduplication now uses both text and approximate document anchor position so repeated sightings of the same ask collapse into one entry.
- Test steps:
  1. Open a Gemini topic with at least two asks.
  2. Open the sidebar.
  3. Confirm each ask appears once.
  4. Close and reopen the sidebar.
  5. Confirm duplicates are still not introduced.

## 9. Gemini appended the new topic’s asks onto the old topic

- Issue:
  After switching topics in Gemini, asks from the new topic were appended to the old sidebar list.
- Fix summary:
  Added conversation-key guards so mutation processing only updates the active conversation cache and never merges across topics.
- Test steps:
  1. Open Gemini topic A and note its sidebar entries.
  2. Switch to Gemini topic B.
  3. Confirm topic B does not append onto the end of topic A’s sidebar list.
  4. Switch back to topic A and confirm its cached list remains topic-specific.

## 10. Gemini kept showing the old topic’s asks after topic switch

- Issue:
  Switching Gemini topics could leave the old sidebar content on screen instead of loading the new topic.
- Fix summary:
  Topic changes now cancel in-flight scans, clear stale in-memory state, react to SPA navigation events more aggressively, and refresh the visible sidebar in place for the new conversation.
- Test steps:
  1. Open Gemini topic A and leave the sidebar open.
  2. Switch directly to Gemini topic B.
  3. Confirm the sidebar does not continue showing topic A’s asks.
  4. Confirm it either shows cached asks for topic B immediately or transitions through a loading state into topic B’s asks.

## 11. ChatGPT index was not reliably cached across revisits

- Issue:
  ChatGPT revisits could still rescan because the cache lived only in content-script memory.
- Fix summary:
  Conversation caches now persist through `chrome.storage.local`, so revisiting a topic can survive content-script restarts and full Chrome restarts.
- Test steps:
  1. Open a ChatGPT conversation and let the sidebar finish scanning.
  2. Switch to another ChatGPT conversation.
  3. Return to the original conversation.
  4. Confirm the sidebar restores from cache instead of performing another full scan.
  5. Refresh the page if needed and confirm the cached conversation still restores.
  6. Fully close Chrome, reopen it, return to the same conversation, and confirm the cached conversation still restores.

## Smoke test

- Run after any change to `content.js`, `popup.html`, `popup.js`, or `manifest.json`.
- Steps:
  1. Reload the unpacked extension in Chrome.
  2. Open one ChatGPT conversation, one Claude conversation, and one Gemini conversation.
  3. Confirm the popup opens and the auto-show toggle renders.
  4. Confirm the sidebar can open and close on all three sites.
  5. Confirm clicking a sidebar item scrolls to the expected ask.
