const assert = require("assert");
const { readFileSync } = require("fs");
const { join } = require("path");
const vm = require("vm");

const calls = [];
let clickHandler;
let sendMessageImpl = () => Promise.resolve({ text: "Fable 5", error: null });
const chrome = {
  runtime: {
    onInstalled: { addListener() {} },
    sendMessage(message) {
      calls.push(["runtime.sendMessage", message]);
      return Promise.resolve();
    },
  },
  contextMenus: {
    create() {},
    onClicked: {
      addListener(handler) {
        clickHandler = handler;
      },
    },
  },
  sidePanel: {
    setPanelBehavior() {
      return Promise.resolve();
    },
    // Deliberately never resolves: capture must not wait for panel animation.
    open(options) {
      calls.push(["sidePanel.open", options]);
      return new Promise(() => {});
    },
  },
  tabs: {
    sendMessage(tabId, message, options) {
      calls.push(["tabs.sendMessage", tabId, message, options]);
      return sendMessageImpl(tabId, message, options);
    },
  },
  scripting: {
    executeScript() {
      calls.push(["scripting.executeScript"]);
      return Promise.resolve();
    },
    insertCSS() {
      calls.push(["scripting.insertCSS"]);
      return Promise.resolve();
    },
  },
  storage: {
    session: {
      set(value) {
        calls.push(["storage.session.set", value]);
        return Promise.resolve();
      },
    },
  },
};

const source = readFileSync(join(__dirname, "..", "background.js"), "utf8");
vm.runInNewContext(source, {
  chrome,
  console: { error() {}, warn() {} },
  Date,
  Promise,
  Math,
});

assert.ok(clickHandler, "context-menu listener registered");

(async () => {
  await clickHandler(
    {
      menuItemId: "tldr-capture",
      frameId: 7,
      selectionText: "Fable 5",
    },
    { id: 42, windowId: 3, url: "https://mail.google.com/mail/u/0/" }
  );

  const openIndex = calls.findIndex(([name]) => name === "sidePanel.open");
  const injectionIndex = calls.findIndex(
    ([name]) => name === "scripting.executeScript"
  );
  const captureIndex = calls.findIndex(([name]) => name === "tabs.sendMessage");
  const storeIndex = calls.findIndex(([name]) => name === "storage.session.set");
  assert.ok(
    injectionIndex >= 0 && injectionIndex < openIndex,
    "exact-frame injection begins before opening the panel"
  );
  assert.ok(openIndex >= 0 && captureIndex > openIndex);
  assert.ok(storeIndex > captureIndex, "captured seed stored without awaiting panel open");

  const capture = calls[captureIndex];
  assert.strictEqual(capture[1], 42);
  assert.strictEqual(capture[2].type, "capture-selection");
  assert.strictEqual(capture[2].selectionText, "Fable 5");
  assert.ok(capture[2].captureId);
  assert.strictEqual(capture[3].frameId, 7);

  const storedObject = calls[storeIndex][1];
  const seed = storedObject["seed:42"];
  assert.strictEqual(seed.frameId, 7);
  assert.strictEqual(seed.windowId, 3);
  assert.ok(seed.captureId);
  console.log("PASS: selection capture does not wait for side-panel opening");
  console.log("PASS: Gmail/nested-frame capture preserves the originating frame");
  console.log("PASS: content injection begins before panel focus can hide selection");

  let retryAttempt = 0;
  sendMessageImpl = () => {
    retryAttempt += 1;
    if (retryAttempt === 1) {
      return Promise.reject(new Error("Receiving end does not exist"));
    }
    return Promise.resolve({ text: "Substack selection", error: null });
  };
  const retryStart = calls.length;
  await clickHandler(
    {
      menuItemId: "tldr-capture",
      frameId: 0,
      selectionText: "Substack selection",
    },
    { id: 43, windowId: 3, url: "https://example.substack.com/p/post" }
  );
  const retryCalls = calls.slice(retryStart);
  assert.strictEqual(
    retryCalls.filter(([name]) => name === "tabs.sendMessage").length,
    2,
    "capture retries once after exact-frame injection completes"
  );
  assert.strictEqual(
    retryCalls.find(([name]) => name === "storage.session.set")[1]["seed:43"]
      .text,
    "Substack selection"
  );
  console.log("PASS: already-open Substack tabs retry capture after injection");

  let contentRetryAttempt = 0;
  sendMessageImpl = () => {
    contentRetryAttempt += 1;
    if (contentRetryAttempt === 1) {
      return Promise.resolve({
        text: "",
        error: "The page changed before the selection could be captured.",
      });
    }
    return Promise.resolve({ text: "Recovered selection", error: null });
  };
  const contentRetryStart = calls.length;
  await clickHandler(
    {
      menuItemId: "tldr-capture",
      frameId: 0,
      selectionText: "Recovered selection",
    },
    { id: 44, windowId: 3, url: "https://example.substack.com/p/post" }
  );
  const contentRetryCalls = calls.slice(contentRetryStart);
  assert.strictEqual(
    contentRetryCalls.filter(([name]) => name === "tabs.sendMessage").length,
    2,
    "content-level capture errors retry once after injection"
  );
  assert.strictEqual(
    contentRetryCalls.find(([name]) => name === "storage.session.set")[1][
      "seed:44"
    ].text,
    "Recovered selection"
  );
  console.log("PASS: a stale page-changed response is retried after injection");

  const pending = [];
  sendMessageImpl = () =>
    new Promise((resolve) => {
      pending.push(resolve);
    });
  const storageStart = calls.length;
  const older = clickHandler(
    { menuItemId: "tldr-capture", frameId: 0, selectionText: "older" },
    { id: 99, windowId: 3, url: "https://x.com/home" }
  );
  const newer = clickHandler(
    { menuItemId: "tldr-capture", frameId: 0, selectionText: "newer" },
    { id: 99, windowId: 3, url: "https://x.com/home" }
  );
  assert.strictEqual(pending.length, 2);
  pending[1]({ text: "newer", error: null });
  await newer;
  pending[0]({ text: "older", error: null });
  await older;

  const racedSeeds = calls
    .slice(storageStart)
    .filter(([name]) => name === "storage.session.set")
    .map(([, value]) => value["seed:99"]);
  assert.deepStrictEqual(
    racedSeeds.map((seed) => seed.text),
    ["newer"],
    "a slow older extraction must not replace the newer click"
  );
  console.log("PASS: out-of-order extraction completion keeps the newest click");
  console.log("\nAll background assertions passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
