const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Store = require('../wave1-store.js');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('Wave-1 authoritative stores are IndexedDB-backed and include the required durable entities', () => {
  assert.deepEqual(Store.STORE_NAMES, [
    'meta', 'runs', 'tasks', 'conversation_bindings', 'deliveries', 'leases', 'worker_results', 'events'
  ]);
  const source = read('wave1-store.js');
  assert.match(source, /indexedDB\.open\(DB_NAME, DB_VERSION\)/);
  assert.doesNotMatch(source, /chrome\.storage/);
  assert.match(source, /SEND_CAPABILITY_CONSUMED/);
  assert.match(source, /previous_state/);
  assert.match(source, /next_state/);
});

test('Wave-1 delegates Send to the existing YOLO actuator and does not synthesize Enter', () => {
  const source = read('wave1-dom.js');
  const start = source.indexOf('function invokeAuthorizedSend');
  const end = source.indexOf('return Object.freeze', start);
  assert.ok(start >= 0 && end > start);
  const actuator = source.slice(start, end);
  assert.match(actuator, /wave1-durable-submitting/);
  assert.match(actuator, /Platforms\.submitComposer/);
  assert.equal((actuator.match(/\.click\(\)/g) || []).length, 0);
  assert.equal((actuator.match(/\.requestSubmit\(\)/g) || []).length, 0);
  assert.doesNotMatch(source, /KeyboardEvent|key\s*:\s*["']Enter["']/);
});

test('MutationObserver is a wake signal only in the Wave-1 content adapter', () => {
  const source = read('wave1-content.js');
  const marker = 'const observer = new MutationObserver';
  const start = source.indexOf(marker);
  const end = source.indexOf('function start()', start);
  assert.ok(start >= 0 && end > start);
  const callbackRegion = source.slice(start, end);
  assert.match(callbackRegion, /scheduleReconcile\(150\)/);
  assert.doesNotMatch(callbackRegion, /runtimeSend\(|invokeAuthorizedSend|markDeliveryUnknown|WAVE1_/);
});

test('content send sequence consumes durable authorization before invoking the actuator', () => {
  const source = read('wave1-content.js');
  const consume = source.indexOf('type: "WAVE1_CONSUME_SEND"');
  const invoke = source.indexOf('Dom.invokeAuthorizedSend', consume);
  assert.ok(consume >= 0);
  assert.ok(invoke > consume);
  assert.match(source.slice(consume, invoke), /if \(!consumed\.ok\)/);
});


test('authorized Send permit is lease-bounded and rechecks UI idleness at actuation time', () => {
  const storeSource = read('wave1-store.js');
  const domSource = read('wave1-dom.js');
  assert.match(storeSource, /lease_expires_at:\s*Number\(lease\.expires_at\)/);
  const start = domSource.indexOf('function invokeAuthorizedSend');
  const end = domSource.indexOf('return Object.freeze', start);
  assert.ok(start >= 0 && end > start);
  const actuator = domSource.slice(start, end);
  assert.match(actuator, /permit\.lease_expires_at/);
  assert.match(actuator, /Date\.now\(\)/);
  assert.match(actuator, /Platforms\.isGenerating/);
  assert.match(actuator, /classifyError/);
});


test('conversation baseline preserves every currently rendered turn identity', () => {
  const source = read('wave1-store.js');
  const start = source.indexOf('function sanitizeBaseline');
  const end = source.indexOf('function beginComposerFilling', start);
  assert.ok(start >= 0 && end > start);
  const baseline = source.slice(start, end);
  assert.doesNotMatch(baseline, /slice\(-\d+\)/);
});


test('ACK persists the substantive assistant response in worker_results', () => {
  const storeSource = read('wave1-store.js');
  const captureStart = storeSource.indexOf('async function captureDoneAndAck');
  const captureEnd = storeSource.indexOf('async function getDelivery', captureStart);
  assert.ok(captureStart >= 0 && captureEnd > captureStart);
  const capture = storeSource.slice(captureStart, captureEnd);
  assert.match(capture, /response_text:\s*String\(delivery\.response_text\s*\|\|\s*""\)/);
  assert.match(capture, /if \(!delivery\.response_text \|\| !delivery\.response_text_hash\)/);
  assert.doesNotMatch(capture, /response_text\s*=\s*""/);
});


test('RESPONSE_RECEIVED durably snapshots assistant text before terminal ACK', () => {
  const storeSource = read('wave1-store.js');
  const backgroundSource = read('wave1-background.js');

  const receivedStart = storeSource.indexOf('async function markResponseReceived');
  const receivedEnd = storeSource.indexOf('async function annotateProtocolFailure', receivedStart);
  assert.ok(receivedStart >= 0 && receivedEnd > receivedStart);
  const received = storeSource.slice(receivedStart, receivedEnd);
  assert.match(received, /response_text:\s*String\(response_text\s*\|\|\s*""\)/);

  const transitionCall = backgroundSource.indexOf('Store.markResponseReceived');
  assert.ok(transitionCall >= 0);
  assert.match(backgroundSource.slice(transitionCall, transitionCall + 900), /response_text:\s*candidate\.text/);

  const responseReceivedBranch = backgroundSource.indexOf('if \(delivery.state === "RESPONSE_RECEIVED"\)');
  assert.ok(responseReceivedBranch >= 0);
  const branch = backgroundSource.slice(responseReceivedBranch, responseReceivedBranch + 1800);
  assert.match(branch, /Core\.parseWorkerTerminal\(delivery\.response_text, delivery\)/);
  assert.doesNotMatch(branch, /if \(!candidate\)/);
});


test('thinking detection excludes persistent composer controls and requires active response scope', () => {
  const source = read('wave1-dom.js');
  const start = source.indexOf('function thinkingActive');
  const end = source.indexOf('function snapshot', start);
  assert.ok(start >= 0 && end > start);
  const thinking = source.slice(start, end);
  assert.match(thinking, /closest\?\.\("form"\)/);
  assert.match(thinking, /latestAssistantRoot/);
  assert.match(thinking, /role='status'|role === "status"/);
});


test('error classification ignores stale historical turn errors', () => {
  const source = read('wave1-dom.js');
  const start = source.indexOf('function classifyError');
  const end = source.indexOf('function sendPath', start);
  assert.ok(start >= 0 && end > start);
  const classify = source.slice(start, end);
  assert.match(classify, /latestTurnRoot/);
  assert.match(classify, /containingTurn/);
  assert.match(classify, /if \(containingTurn && containingTurn !== latestTurnRoot\) continue/);
});
