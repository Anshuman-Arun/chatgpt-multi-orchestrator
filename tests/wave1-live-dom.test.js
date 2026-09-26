const test = require('node:test');
const assert = require('node:assert/strict');
globalThis.MultiAgentWave1Core = require('../wave1-core.js');
globalThis.YOLOConfig = require('../config.js');
globalThis.YOLOPlatforms = require('../platforms.js');
const Dom = require('../wave1-dom.js');

test('empty ProseMirror placeholder newline is not mistaken for a human draft', () => {
  const placeholder = {
    textContent: '',
    matches: (selector) => selector === 'p[data-empty-paragraph="true"][data-placeholder].placeholder',
    querySelector: (selector) => selector === 'br.ProseMirror-trailingBreak' ? {} : null
  };
  const composer = {
    tagName: 'DIV',
    innerText: '\n',
    textContent: '',
    childElementCount: 1,
    firstElementChild: placeholder
  };
  assert.equal(Dom.rawComposerText(composer), '');

  placeholder.textContent = ' ';
  composer.textContent = ' ';
  assert.equal(Dom.rawComposerText(composer), '\n');
});

test('plain ProseMirror paragraphs read back the exact inserted multiline payload', () => {
  const payload = 'first line\n\nsecond line\n<<<END:WORKER>>>';
  const paragraphs = ['first line', '', 'second line', '<<<END:WORKER>>>'].map((text) => ({
    tagName: 'P',
    textContent: text,
    childNodes: text ? [{ nodeType: 3 }] : [{ nodeType: 1, tagName: 'BR', className: 'ProseMirror-trailingBreak' }]
  }));
  const composer = {
    tagName: 'DIV',
    innerText: 'first line\n\n\n\nsecond line\n\n<<<END:WORKER>>>',
    textContent: 'first linesecond line<<<END:WORKER>>>',
    children: paragraphs,
    childElementCount: paragraphs.length,
    firstElementChild: paragraphs[0],
    matches: (selector) => selector === '[data-composer-markdown]'
  };
  assert.equal(Dom.rawComposerText(composer), payload);
});

test('current Project turn units expose distinct exact user and assistant message identities', () => {
  const makeUnit = (role, id, text) => {
    const body = {
      innerText: role === 'user' ? `${text}\n…\nShow more` : text,
      textContent: role === 'user' ? `${text}…Show more` : text,
      getAttribute: (name) => name === 'data-chatgpt-selection-message-id' ? id : null,
      querySelector: (selector) => role === 'user' && selector === '[data-search-result-target] .whitespace-pre-wrap'
        ? { innerText: text, textContent: text } : null
    };
    const unit = {
      innerText: `${role === 'user' ? 'You' : 'ChatGPT'} said:\n${text}`,
      textContent: text,
      getAttribute: (name) => ({
        'data-chatgpt-search-unit-key': `fallback-turn-0:${role === 'user' ? 0 : 2}:${role}`,
        'data-chatgpt-search-message-ids': id
      })[name] || null,
      querySelector: (selector) => selector === (role === 'user' ? '[data-user-message-bubble]' : '[data-chatgpt-selection-message-id]') ? body : null,
      closest: () => unit
    };
    return unit;
  };
  const user = makeUnit('user', 'user-message-id', 'hi');
  const assistant = makeUnit('assistant', 'assistant-message-id', 'Hello.');
  const doc = {
    querySelectorAll: (selector) => selector.includes("[data-chatgpt-search-unit-key$=':user']") ? [user, assistant] : []
  };
  const location = { hostname: 'chatgpt.com', href: 'https://chatgpt.com/g/g-p-project/c/conversation' };
  const snapshot = Dom.snapshot(doc, location);
  assert.deepEqual(snapshot.turns.map(({ role, identity_key, text }) => ({ role, identity_key, text })), [
    { role: 'user', identity_key: 'msg:user-message-id', text: 'hi' },
    { role: 'assistant', identity_key: 'msg:assistant-message-id', text: 'Hello.' }
  ]);
});

