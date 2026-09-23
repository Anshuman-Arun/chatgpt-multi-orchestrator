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
