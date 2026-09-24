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


test('DOM turn snapshots preserve substantive whitespace while comparisons normalize separately', () => {
  const source = read('wave1-dom.js');
  const start = source.indexOf('function turnDescriptor');
  const end = source.indexOf('function classifyError', start);
  assert.ok(start >= 0 && end > start);
  const descriptor = source.slice(start, end);
  assert.match(descriptor, /replace\(\/\\r\\n\?\/g, "\\n"\)/);
  assert.doesNotMatch(descriptor, /const text = Core\.normalizeText/);
  assert.match(descriptor, /Core\.fingerprint\(text\)/);
});


test('terminal Delivery failure states atomically update minimum task/run state', () => {
  const source = read('wave1-store.js');

  const failedStart = source.indexOf('async function failPreSend');
  const failedEnd = source.indexOf('async function authorizeSend', failedStart);
  assert.ok(failedStart >= 0 && failedEnd > failedStart);
  const failed = source.slice(failedStart, failedEnd);
  assert.match(failed, /"tasks", "runs"/);
  assert.match(failed, /status: "FAILED"/);

  const unknownStart = source.indexOf('async function markDeliveryUnknown');
  const unknownEnd = source.indexOf('async function markDelivered', unknownStart);
  assert.ok(unknownStart >= 0 && unknownEnd > unknownStart);
  const unknown = source.slice(unknownStart, unknownEnd);
  assert.match(unknown, /"tasks", "runs"/);
  assert.match(unknown, /status: "BLOCKED"/);
});


test('legacy YOLO send path is disabled once a conversation is Wave-1 bound', () => {
  const source = read('content.js');
  const helperStart = source.indexOf('async function wave1BindingBlocksLegacySend');
  const writeStart = source.indexOf('async function writeAndSubmit');
  const submit = source.indexOf('Platforms.submitComposer', writeStart);
  assert.ok(helperStart >= 0);
  assert.ok(writeStart > helperStart);
  assert.ok(submit > writeStart);
  const helper = source.slice(helperStart, writeStart);
  assert.match(helper, /type:\s*"WAVE1_STATUS"/);
  assert.match(helper, /response\?\.binding/);

  const sendRegion = source.slice(writeStart, submit);
  assert.match(sendRegion, /await wave1BindingBlocksLegacySend\(actionPageId\)/);
  assert.match(sendRegion, /wave1\.conversation_reserved/);
});


test('assistant identity replacement resets quiescence and updates durable candidate', () => {
  const storeSource = read('wave1-store.js');
  const backgroundSource = read('wave1-background.js');

  const mutationStart = storeSource.indexOf('async function recordAssistantMutation');
  const mutationEnd = storeSource.indexOf('async function markResponseReceived', mutationStart);
  assert.ok(mutationStart >= 0 && mutationEnd > mutationStart);
  const mutation = storeSource.slice(mutationStart, mutationEnd);
  assert.match(mutation, /identityChanged/);
  assert.match(mutation, /assistant_candidate:/);
  assert.match(mutation, /assistant_last_changed_at = timestamp|assistant_last_changed_at:\s*timestamp/);

  const responseStart = backgroundSource.indexOf('if (delivery.state === "RESPONSE_STARTED")');
  const responseEnd = backgroundSource.indexOf('if (delivery.state === "RESPONSE_RECEIVED")', responseStart);
  const branch = backgroundSource.slice(responseStart, responseEnd);
  assert.match(branch, /candidate\.identity_key/);
  assert.match(branch, /delivery\.assistant_candidate\?\.identity_key/);
  assert.match(branch, /Store\.recordAssistantMutation/);
});


test('composer readback uses exact canonical text and an exact payload hash', () => {
  const domSource = read('wave1-dom.js');
  const storeSource = read('wave1-store.js');
  const backgroundSource = read('wave1-background.js');

  const exactStart = domSource.indexOf('function composerForExactPayload');
  const exactEnd = domSource.indexOf('function writeComposerExact', exactStart);
  const exact = domSource.slice(exactStart, exactEnd);
  assert.match(exact, /rawComposerText/);
  assert.match(exact, /Core\.canonicalText/);
  assert.doesNotMatch(exact, /Core\.normalizeText/);

  assert.match(storeSource, /payload_exact_hash/);
  const filledStart = backgroundSource.indexOf('async function handleComposerFilled');
  const filledEnd = backgroundSource.indexOf('async function handleFailPreSend', filledStart);
  const filled = backgroundSource.slice(filledStart, filledEnd);
  assert.match(filled, /payload_exact_hash/);
  assert.match(filled, /Core\.canonicalText/);
});


test('recognized post-delivery UI error becomes RESPONSE_FAILED atomically', () => {
  const storeSource = read('wave1-store.js');
  const backgroundSource = read('wave1-background.js');

  const failedStart = storeSource.indexOf('async function markResponseFailed');
  const failedEnd = storeSource.indexOf('async function markResponseStarted', failedStart);
  assert.ok(failedStart >= 0 && failedEnd > failedStart);
  const failed = storeSource.slice(failedStart, failedEnd);
  assert.match(failed, /"tasks", "runs"/);
  assert.match(failed, /"RESPONSE_FAILED"/);
  assert.match(failed, /appendEvent/);

  const reconcileStart = backgroundSource.indexOf('async function reconcile');
  const reconcileEnd = backgroundSource.indexOf('async function handleJournal', reconcileStart);
  const reconcile = backgroundSource.slice(reconcileStart, reconcileEnd);
  assert.match(reconcile, /snapshot\.error_code/);
  assert.match(reconcile, /Store\.markResponseFailed/);
});


test('manual user turn after owned receipt supersedes response durably', () => {
  const storeSource = read('wave1-store.js');
  const backgroundSource = read('wave1-background.js');

  const start = storeSource.indexOf('async function markResponseSuperseded');
  const end = storeSource.indexOf('async function markResponseFailed', start);
  assert.ok(start >= 0 && end > start);
  const fn = storeSource.slice(start, end);
  assert.match(fn, /RESPONSE_SUPERSEDED/);
  assert.match(fn, /"tasks", "runs"/);
  assert.match(fn, /status: "BLOCKED"/);

  const reconcileStart = backgroundSource.indexOf('async function reconcile');
  const reconcileEnd = backgroundSource.indexOf('async function handleJournal', reconcileStart);
  const reconcile = backgroundSource.slice(reconcileStart, reconcileEnd);
  assert.match(reconcile, /FOREIGN_USER_TURN_AFTER_OWNED_RECEIPT/);
  assert.match(reconcile, /Store\.markResponseSuperseded/);
});


test('foreign user turn anywhere in the delivery window supersedes after exact receipt', () => {
  const source = read('wave1-background.js');
  const receiptStart = source.indexOf('const receipt = await Core.findOwnedUserReceipt');
  const deliveredStart = source.indexOf('delivery = await Store.markDelivered', receiptStart);
  const responseStart = source.indexOf('if (delivery.state === "DELIVERED")', deliveredStart);
  assert.ok(receiptStart >= 0 && deliveredStart > receiptStart && responseStart > deliveredStart);
  const region = source.slice(receiptStart, responseStart);
  assert.match(region, /newUserTurns\(delivery, snapshot\)/);
  assert.match(region, /FOREIGN_USER_TURN_IN_DELIVERY_WINDOW/);
  assert.match(region, /Store\.markResponseSuperseded/);
});


test('Wave-1 suppresses reconciliation during the consume-to-Send critical section', () => {
  const source = read('wave1-content.js');
  assert.match(source, /let sendCriticalSection = false/);

  const scheduleStart = source.indexOf('function scheduleReconcile');
  const scheduleEnd = source.indexOf('async function reconcileNow', scheduleStart);
  const schedule = source.slice(scheduleStart, scheduleEnd);
  assert.match(schedule, /sendCriticalSection/);

  const executeStart = source.indexOf('async function executeDelivery');
  const executeEnd = source.indexOf('async function createAndRun', executeStart);
  const execute = source.slice(executeStart, executeEnd);
  const criticalOn = execute.indexOf('sendCriticalSection = true');
  const consume = execute.indexOf('type: "WAVE1_CONSUME_SEND"');
  const invoke = execute.indexOf('Dom.invokeAuthorizedSend');
  const markSent = execute.indexOf('type: "WAVE1_MARK_SENT_UNCONFIRMED"');
  const criticalOff = execute.lastIndexOf('sendCriticalSection = false');
  assert.ok(criticalOn >= 0 && consume > criticalOn && invoke > consume && markSent > invoke && criticalOff > markSent);
  assert.match(execute, /finally\s*\{[\s\S]*sendCriticalSection = false/);
});
