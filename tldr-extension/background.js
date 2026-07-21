// TLDR — background service worker (MV3).
// Responsibilities:
//  - create the "TLDR" context-menu item (contexts: selection)
//  - on click: open the side panel in the click's user-gesture context, then
//    ask the content script to snapshot + extract the selection it stored.
//  - stash the extracted text (keyed by tabId) in session storage and notify
//    an already-open panel.

const MENU_ID = "tldr-capture";
let captureSequence = 0;
const latestCaptureByTab = new Map();

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "TLDR",
    contexts: ["selection"],
  });
});

// Let clicking the toolbar icon toggle the panel too (harmless convenience).
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || tab.id == null) return;
  const tabId = tab.id;
  const frameId = Number.isInteger(info.frameId) ? info.frameId : 0;
  // Freshness is click order, not extraction completion order. Dynamic pages
  // can make an older capture resolve after a newer click.
  const capturedAt = Date.now();
  const captureId = `${capturedAt}:${++captureSequence}`;
  latestCaptureByTab.set(tabId, captureId);

  // Also start an idempotent injection immediately, before the panel can take
  // focus. Declared content scripts are not retroactively added to tabs that
  // were already open when an unpacked extension was reloaded. Starting this
  // without awaiting preserves the user gesture for sidePanel.open while giving
  // content.js a chance to snapshot the still-live selection.
  const contentReady = warmContentScript(tabId, frameId);

  // MUST be called synchronously within the user-gesture of the click,
  // otherwise chrome.sidePanel.open throws. Do not await it before capture:
  // opening the panel can take seconds and dynamic pages (notably Gmail) may
  // replace the selected DOM nodes in that time.
  chrome.sidePanel.open({ tabId }).catch((e) => {
    console.error("[TLDR] sidePanel.open failed:", e);
  });

  const extraction = await captureSelection(
    tabId,
    frameId,
    info.selectionText || "",
    captureId,
    contentReady
  );
  if (latestCaptureByTab.get(tabId) !== captureId) return;
  const payload = {
    captureId,
    capturedAt,
    tabId,
    windowId: tab.windowId,
    frameId,
    text: extraction.text || "",
    error: extraction.error || null,
    url: tab.url || null,
  };

  await chrome.storage.session.set({ [seedKey(tabId)]: payload });
  if (latestCaptureByTab.get(tabId) !== captureId) return;

  // Notify the panel if it's already listening. Ignore "no receiver" errors.
  chrome.runtime
    .sendMessage({ type: "selection-captured", ...payload })
    .catch(() => {});
});

function seedKey(tabId) {
  return "seed:" + tabId;
}

function warmContentScript(tabId, frameId) {
  const target = { tabId, frameIds: [frameId] };
  try {
    return Promise.all([
      chrome.scripting.executeScript({ target, files: ["content.js"] }),
      chrome.scripting.insertCSS({ target, files: ["content.css"] }),
    ]).catch(() => {});
  } catch (e) {
    return Promise.resolve();
  }
}

async function captureSelection(
  tabId,
  frameId,
  selectionText,
  captureId,
  contentReady
) {
  let first = null;
  try {
    first = await chrome.tabs.sendMessage(
      tabId,
      { type: "capture-selection", selectionText, captureId },
      { frameId }
    );
    if (first && !first.error) return first;
  } catch (e) {
    // A missing receiver is expected for a tab that predates installation.
  }

  // A stale/older listener can also answer with a content-level error before
  // the proactive injection has installed the current code. Wait for it and
  // retry exactly once for either kind of failure.
  try {
    await contentReady;
    const retried = await chrome.tabs.sendMessage(
      tabId,
      { type: "capture-selection", selectionText, captureId },
      { frameId }
    );
    return retried || first || captureFailure();
  } catch (e) {
    console.warn("[TLDR] capture-selection failed:", e);
    return first || captureFailure();
  }
}

function captureFailure() {
  return {
    text: "",
    error:
      "Couldn't read the selection on this page (it may be a restricted page such as chrome:// or the Web Store).",
  };
}
