# Wave 1 live Brave validation

Date: 2026-09-25/26 (America/Los_Angeles)

## Environment

- Windows 11 Home, build `10.0.26200`
- Brave `153.1.95.104`, existing signed-in Plus profile
- Node `v24.19.0`, npm `11.17.0`
- Branch `wave1/single-chat-vertical-slice`

Chrome was not available on this laptop, so the user-authorized Brave profile was used for the authenticated smoke test. The user confirmed one YOLO extension copy was listed and reloaded the unpacked `dist/yolo` build.

## Live success

The saved Project conversation was:

`https://chatgpt.com/g/g-p-6ab73618f64081919594033bd68bdc76-test-project/c/6ab73c98-7fbc-83e8-b654-1898c78ca3c8`

The controller bound conversation `conversation_01ab3dad-5b61-4f86-95c8-eebdcbc66464` and ran delivery `delivery_135d9319-693e-4b56-81a8-5cb7d2c7e12f`. The owned user turn was identified by message ID `90e20a01-4808-4f90-8a76-fdddb28adf95`; the assistant turn was identified by message ID `d29bb3e7-d521-4136-9503-5f99a38c0def`. The UI showed exactly one router-owned user delivery and the expected identifiers.

The journal UI reconstructed 21 events with this state path:

`PENDING -> CLAIMED -> COMPOSER_FILLING -> COMPOSER_FILLED -> SUBMITTING -> SENT_UNCONFIRMED -> DELIVERED -> RESPONSE_STARTED -> RESPONSE_RECEIVED -> ACKED`

The assistant response ended with the current worker protocol and `status: "DONE"`. The successful response was requested as a plain-text fenced code block because the live model otherwise rendered `<` characters as a two-bracket form. The adapter read the rendered DOM text and accepted the exact three-line sentinel and JSON block.

## Negative live tests

- Existing human draft `DO NOT DELETE THIS DRAFT`: delivery failed before mutation; the draft remained byte-for-byte intact and no user turn was sent.
- Long response stopped with ChatGPT's Stop control before a terminal block: response reached `RESPONSE_RECEIVED` but never `ACKED`.
- Responses with malformed/two-bracket terminal output: response was recorded without `ACKED`; no automatic resend occurred.

## Current Project DOM observations

- URL: `https://chatgpt.com/g/g-p-<project-id>-<project-slug>/c/<conversation-uuid>`
- Composer: `div[contenteditable="true"].ProseMirror[role="textbox"][aria-label="Ask ChatGPT"]`
- Send: `button[aria-label="Send"]`
- Stop: `button[aria-label="Stop"]`
- Turn units: `[data-chatgpt-search-unit-key="fallback-turn-N:0:user"]` and `...:2:assistant`
- Message identity: `data-chatgpt-search-message-ids`, `data-chatgpt-selection-message-id`, and outer `data-turn-key`
- `data-message-id`: not present
- Exact user payload: `[data-user-message-bubble] [data-search-result-target] .whitespace-pre-wrap`; long bubbles also contain `Show more`, which is excluded
- Copy controls: assistant Copy copied the rendered response text in the malformed-response test; the successful response exposed a code-block Copy control
- Thinking/generation: Stop was present while text was mutating; completion remained pending until Stop disappeared and the configured quiescence period elapsed
- Page console: repeated ChatGPT minified React error `#418` hydration warnings; no extension service-worker console was exposed through the browser control

## Evidence limitation

The browser control cannot access Brave internal extension pages or the extension service-worker DevTools surface. Therefore this run verifies persistence behavior through the live journal, source-level IndexedDB transaction tests, and the final ACK, but does not claim a direct interactive inspection of the extension database stores. No database records were manually edited.

