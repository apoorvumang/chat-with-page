// TLDR — background service worker (MV3).
// Responsibilities:
//  - create the "TLDR" context-menu item (contexts: selection)
//  - on click: open the side panel in the click's user-gesture context, then
//    ask the content script to snapshot + extract the selection it stored.
//  - stash the extracted text (keyed by tabId) in session storage and notify
//    an already-open panel.

const MENU_ID = "tldr-capture";

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

  // MUST be called synchronously within the user-gesture of the click,
  // otherwise chrome.sidePanel.open throws.
  try {
    await chrome.sidePanel.open({ tabId });
  } catch (e) {
    console.error("[TLDR] sidePanel.open failed:", e);
  }

  const extraction = await captureSelection(tabId);
  const payload = {
    tabId,
    text: extraction.text || "",
    error: extraction.error || null,
    url: tab.url || null,
  };

  await chrome.storage.session.set({ [seedKey(tabId)]: payload });

  // Notify the panel if it's already listening. Ignore "no receiver" errors.
  chrome.runtime
    .sendMessage({ type: "selection-captured", ...payload })
    .catch(() => {});
});

function seedKey(tabId) {
  return "seed:" + tabId;
}

async function captureSelection(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "capture-selection" });
  } catch (e) {
    // Content script might not be present yet (tab predates install, etc.).
    // Try an on-demand injection, then retry once.
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
      return await chrome.tabs.sendMessage(tabId, { type: "capture-selection" });
    } catch (e2) {
      console.warn("[TLDR] capture-selection failed:", e2);
      return {
        text: "",
        error:
          "Couldn't read the selection on this page (it may be a restricted page such as chrome:// or the Web Store).",
      };
    }
  }
}
