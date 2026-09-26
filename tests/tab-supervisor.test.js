const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "tab-supervisor.js"), "utf8");
const sharedSource = fs.readFileSync(path.join(root, "shared.js"), "utf8");

function makeHarness({ fail = "query" } = {}) {
  const errors = [];
  let alarmCallback = null;
  const listeners = {
    alarm: null,
    startup: null,
    installed: null,
    updated: null,
    activated: null,
    removed: null
  };

  const chrome = {
    runtime: {
      get lastError() { return null; },
      onStartup: { addListener(handler) { listeners.startup = handler; } },
      onInstalled: { addListener(handler) { listeners.installed = handler; } }
    },
    alarms: {
      create(name, options) {
        if (name === "yolo-tab-supervisor" && options?.periodInMinutes === 1) alarmCallback = options;
      },
      get(name, callback) { callback?.(null); },
      onAlarm: {
        addListener(handler) { listeners.alarm = handler; }
      }
    },
    tabs: {
      query(queryInfo, callback) {
        if (fail === "query") throw new Error("tabs.query rejected");
        callback?.([]);
      },
      get(tabId, callback) {
        if (fail === "get") throw new Error(`tabs.get(${tabId}) rejected`);
        callback?.({ id: tabId, url: "https://chatgpt.com/c/test" });
      },
      update(tabId, updateProperties, callback) {
        callback?.({ id: tabId });
      },
      sendMessage(tabId, message, callback) {
        callback?.({ ok: true });
      },
      onUpdated: { addListener(handler) { listeners.updated = handler; } },
      onActivated: { addListener(handler) { listeners.activated = handler; } },
      onRemoved: { addListener(handler) { listeners.removed = handler; } }
    },
    scripting: {
      executeScript(target, options, callback) {
        callback?.();
      }
    }
  };

  const context = {
    console: {
      error: (message) => errors.push(message)
    },
    Date,
    Promise,
    Math,
    JSON,
    setTimeout,
    clearTimeout,
    chrome,
    globalThis: undefined,
    YOLOConfig: {
      VERSION: "test",
      STORAGE_KEYS: { global: "globalSettings", pages: "pages", pageWorkflows: "pageWorkflows" },
      DEFAULT_SETTINGS: { protectActiveWorkflowTabs: false },
      isSupportedUrl(url) { return /^https:\/\/[^/]*chatgpt\.com/.test(String(url)); },
      pageId(url) { return String(url); },
      isDurablePageId(pageId) { return /\/c\/[^/]+$/.test(String(pageId)); },
      mergeSettings(...sources) { return Object.assign({}, ...sources); },
      pageSettingsKey(pageId) { return `pageSettings:${pageId}`; },
      workflowKey(pageId) { return `workflow:${pageId}`; }
    },
    YOLOLifecycle: {
      shouldProtectTab({ enabled }) { return Boolean(enabled); }
    }
  };

  vm.runInNewContext(sharedSource, context, { filename: "shared.js" });
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "tab-supervisor.js" });

  return { listeners, errors };
}

async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("listener catches and logs alarm sweep rejection", async () => {
  const { listeners, errors } = makeHarness({ fail: "query" });
  listeners.alarm?.({ name: "yolo-tab-supervisor" });
  await flushMicrotasks();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Tab supervisor sweep failed:/);
});

test("listener catches and logs startup sweep rejection", async () => {
  const { listeners, errors } = makeHarness({ fail: "query" });
  listeners.startup?.();
  await flushMicrotasks();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Tab supervisor startup sweep failed:/);
});

test("listener catches and logs install sweep rejection", async () => {
  const { listeners, errors } = makeHarness({ fail: "query" });
  listeners.installed?.();
  await flushMicrotasks();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Tab supervisor install sweep failed:/);
});

test("listener catches and logs onUpdated tab inspection rejection", async () => {
  const { listeners, errors } = makeHarness({ fail: "get" });
  listeners.updated?.(42, { status: "complete" });
  await flushMicrotasks();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Tab supervisor updated-tab inspection failed:/);
});

test("listener catches and logs onActivated tab inspection rejection", async () => {
  const { listeners, errors } = makeHarness({ fail: "get" });
  listeners.activated?.({ tabId: 7 });
  await flushMicrotasks();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Tab supervisor activated-tab inspection failed:/);
});


test("fallback reinjection includes shared runtime before dependent content scripts", () => {
  const scriptsMatch = source.match(/const SCRIPT_FILES = Object\.freeze\(\[([\s\S]*?)\]\);/);
  assert.ok(scriptsMatch);
  const scripts = Array.from(scriptsMatch[1].matchAll(/"([^"]+\.js)"/g), (match) => match[1]);
  const sharedIndex = scripts.indexOf("shared.js");
  const contentIndex = scripts.indexOf("content.js");
  const wave1Index = scripts.indexOf("wave1-content.js");
  assert.ok(sharedIndex >= 0);
  assert.ok(sharedIndex < contentIndex);
  assert.ok(sharedIndex < wave1Index);
});


test("tab health requires both legacy and Wave-1 content runtimes", () => {
  assert.match(source, /YOLOTAB_HEALTH_CHECK/);
  assert.match(source, /WAVE1_CONTENT_HEALTH/);
  assert.match(source, /legacyHealth\?\.ok/);
  assert.match(source, /wave1Health\?\.ok/);
});
