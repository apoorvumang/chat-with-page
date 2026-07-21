// TLDR — side panel chat UI.
// Receives only { text } from the page and sends back { start, end } character
// offsets. The DOM node map never leaves the selected content-script frame.

const els = {
  contextText: document.getElementById("context-text"),
  messages: document.getElementById("messages"),
  form: document.getElementById("composer"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
  clearHl: document.getElementById("clear-hl"),
  notice: document.getElementById("notice"),
  toast: document.getElementById("toast"),
  credits: document.getElementById("credits"),
  auth: document.getElementById("auth"),
  authForm: document.getElementById("auth-form"),
  authKey: document.getElementById("auth-key"),
  authConnect: document.getElementById("auth-connect"),
  authError: document.getElementById("auth-error"),
  disconnect: document.getElementById("disconnect"),
};

const state = {
  tabId: null,
  windowId: null,
  frameId: 0,
  captureId: null,
  capturedAt: 0,
  context: "",
  history: [], // [{ role: "user" | "assistant", content }]
  invalidated: false,
  busy: false,
  connected: false,
  contextVersion: 0,
  authEpoch: 0,
  highlightEpoch: 0,
  highlightedTarget: null,
  // Summary request held until a TokenPath key is available.
  pendingAutoSummary: null,
};

init();

async function init() {
  wireUI();
  watchTab();

  // Install the live listener before *any* await, including the active-tab
  // lookup. A newly opened panel can otherwise miss a very fast capture.
  const earlyCaptures = [];
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "selection-captured") return;
    if (state.windowId == null) {
      earlyCaptures.push(msg);
      return;
    }
    if (
      msg.windowId != null &&
      msg.windowId !== state.windowId
    ) {
      return;
    }
    // A side panel can persist while its window switches tabs. The newest
    // explicit TLDR capture becomes this panel's target tab + frame.
    applySeed(msg);
  });

  const authReady = initAuth();
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  state.tabId = tab?.id ?? null;
  state.windowId = tab?.windowId ?? null;

  // Runtime messages are broadcast to every open panel, so keep only captures
  // for this panel's window and apply the newest one first.
  const earlyCapture = earlyCaptures
    .filter(
      (msg) =>
        state.windowId == null ||
        msg.windowId == null ||
        msg.windowId === state.windowId
    )
    .sort((a, b) => (Number(b.capturedAt) || 0) - (Number(a.capturedAt) || 0))[0];
  if (earlyCapture) {
    applySeed(earlyCapture);
  }

  // Pick up a selection captured before the panel finished loading.
  if (state.tabId != null) {
    const stored = await chrome.storage.session.get(seedKey(state.tabId));
    const seed = stored[seedKey(state.tabId)];
    if (seed) applySeed(seed);
  }
  await authReady;
  maybeRunAutoSummary();
}

function seedKey(tabId) {
  return "seed:" + tabId;
}

function applySeed(seed) {
  if (seed.captureId && seed.captureId === state.captureId) return false;
  if (
    Number.isFinite(seed.capturedAt) &&
    seed.capturedAt < state.capturedAt
  ) {
    return false;
  }
  cancelHighlightAndClear();
  state.captureId = seed.captureId || null;
  state.capturedAt = Number(seed.capturedAt) || Date.now();
  state.tabId = seed.tabId ?? state.tabId;
  state.frameId = Number.isInteger(seed.frameId) ? seed.frameId : 0;

  if (seed.error) {
    state.context = "";
    state.history = [];
    state.pendingAutoSummary = null;
    state.contextVersion++;
    els.messages.innerHTML = "";
    els.contextText.textContent = seed.error;
    setEnabled(false);
    return true;
  }
  if (!seed.text) {
    state.context = "";
    state.history = [];
    state.pendingAutoSummary = null;
    state.contextVersion++;
    els.messages.innerHTML = "";
    els.contextText.textContent = "No text was captured.";
    setEnabled(false);
    return true;
  }

  // A fresh capture clears any prior invalidation and chat.
  state.context = seed.text;
  state.invalidated = false;
  state.history = [];
  state.contextVersion++;
  state.pendingAutoSummary = null;
  hideNotice();
  els.messages.innerHTML = "";
  els.contextText.textContent = seed.text;
  setEnabled(true);

  const summary = TldrPanelLogic.buildSummaryRequest(seed.text);
  if (summary.skip) {
    addMessage(
      "assistant note",
      "Already concise — ask anything about this selection."
    );
    return true;
  }
  state.pendingAutoSummary = summary;
  maybeRunAutoSummary();
  return true;
}

function maybeRunAutoSummary() {
  if (
    !state.connected ||
    state.busy ||
    !state.context ||
    !state.pendingAutoSummary
  ) {
    return;
  }
  const summary = state.pendingAutoSummary;
  state.pendingAutoSummary = null;
  runTurn(summary.prompt, {
    echoUser: false,
    summary,
    maxOutputTokens: summary.maxOutputTokens,
  });
}

// --- TokenPath auth ---------------------------------------------------------

async function initAuth() {
  const authEpoch = ++state.authEpoch;
  const { key } = await TokenPath.getAuth();
  if (authEpoch !== state.authEpoch) return;
  if (!key) {
    setConnected(false);
    return;
  }
  setConnected(true);
  // Refresh/validate in the background. Selection display and panel bootstrap
  // must never wait on this unrelated network request.
  TokenPath.fetchCredits()
    .then((credits) => {
      if (authEpoch === state.authEpoch) updateCredits(credits);
    })
    .catch(async (e) => {
      if (
        authEpoch === state.authEpoch &&
        e instanceof TokenPath.Error &&
        (e.status === 401 || e.status === 403)
      ) {
        await TokenPath.clearKey();
        if (authEpoch !== state.authEpoch) return;
        setConnected(false);
        showAuthError("Your saved TokenPath key was rejected — paste a new one.");
      }
    });
}

async function onConnectSubmit(e) {
  e.preventDefault();
  const key = els.authKey.value.trim();
  if (!key) return;
  const authEpoch = ++state.authEpoch;

  els.authConnect.disabled = true;
  showAuthError(null);
  try {
    await TokenPath.setKey(key);
    const credits = await TokenPath.fetchCredits(); // validates the key
    if (authEpoch !== state.authEpoch) return;
    updateCredits(credits);
  } catch (err) {
    if (authEpoch !== state.authEpoch) return;
    await TokenPath.clearKey();
    showAuthError(
      err instanceof TokenPath.Error && (err.status === 401 || err.status === 403)
        ? "That key was rejected. Copy a fresh tpk_… key from platform.tokenpath.ai."
        : err.message || "Couldn't reach TokenPath."
    );
    els.authConnect.disabled = false;
    return;
  }

  els.authKey.value = "";
  els.authConnect.disabled = false;
  setConnected(true);
  maybeRunAutoSummary();
}

async function onDisconnect(e) {
  e.preventDefault();
  state.authEpoch++;
  await TokenPath.clearKey();
  setConnected(false);
}

function setConnected(connected) {
  state.connected = connected;
  els.auth.hidden = connected;
  els.disconnect.hidden = !connected;
  if (!connected) {
    els.credits.hidden = true;
    if (!state.context) els.authKey.focus();
  } else {
    maybeRunAutoSummary();
  }
}

function updateCredits(availableTokens) {
  if (availableTokens == null) return;
  els.credits.textContent = formatTokens(availableTokens) + " tokens";
  els.credits.hidden = false;
}

function showAuthError(text) {
  els.authError.hidden = !text;
  els.authError.textContent = text || "";
}

function wireUI() {
  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = els.input.value.trim();
    if (!text || state.busy || !state.context) return;
    els.input.value = "";
    autoGrow();
    runTurn(text, { echoUser: true });
  });

  els.input.addEventListener("input", autoGrow);
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      els.form.requestSubmit();
    }
  });

  els.clearHl.addEventListener("click", () => {
    state.highlightEpoch++;
    const fallback =
      state.tabId == null
        ? null
        : { tabId: state.tabId, frameId: state.frameId };
    clearActiveHighlight(fallback).catch(() => {});
  });

  els.authForm.addEventListener("submit", onConnectSubmit);
  els.disconnect.addEventListener("click", onDisconnect);
}

function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 120) + "px";
}

async function runTurn(
  userText,
  { echoUser, summary = null, maxOutputTokens = null }
) {
  if (!state.connected) {
    if (summary) state.pendingAutoSummary = summary;
    els.auth.hidden = false;
    showToast("Connect TokenPath to start chatting.");
    els.authKey.focus();
    return;
  }

  if (echoUser) {
    state.history.push({ role: "user", content: userText });
    addMessage("user", userText);
  }

  const context = state.context;
  const contextVersion = state.contextVersion;
  const history = [
    ...state.history,
    ...(echoUser ? [] : [{ role: "user", content: userText }]),
  ];
  state.busy = true;
  els.send.disabled = true;
  const thinking = addThinking();

  let result = null;
  let failure = null;
  try {
    result = await askLLM(context, history, { maxOutputTokens });
  } catch (e) {
    failure = e;
  }

  thinking.remove();

  // A new page selection arrived while this request was running. Never append
  // the old answer to the new context; release the slot and start its summary.
  if (contextVersion !== state.contextVersion) {
    state.busy = false;
    els.send.disabled = !state.context;
    maybeRunAutoSummary();
    return;
  }

  if (failure) {
    // A failed visible user turn has no assistant counterpart and must not
    // leak into the next request's conversational history.
    if (echoUser) state.history.pop();
    await renderFailure(failure);
  } else {
    const answer = summary
      ? TldrPanelLogic.enforceShorterSummary(
          result.answer,
          context,
          summary.maxUnits
        )
      : result.answer;
    state.history.push({ role: "assistant", content: answer });
    addAnswer(
      answer,
      answer === result.answer ? result.attributions || [] : [],
      {
        tabId: state.tabId,
        frameId: state.frameId,
        captureId: state.captureId,
        contextVersion: state.contextVersion,
      }
    );
    updateCredits(result.creditsRemaining);
  }

  state.busy = false;
  els.send.disabled = !state.context;
  maybeRunAutoSummary();
}

// Turn an API failure into an actionable chat message.
async function renderFailure(e) {
  if (!(e instanceof TokenPath.Error)) {
    addMessage("assistant", "Something went wrong generating an answer.");
    return;
  }
  if (e.status === 401 || e.status === 403) {
    const authEpoch = ++state.authEpoch;
    await TokenPath.clearKey();
    if (authEpoch !== state.authEpoch) return;
    setConnected(false);
    showAuthError("Your TokenPath key was rejected — paste a new one.");
    addMessage("assistant", "Your TokenPath key was rejected. Reconnect to continue.");
    return;
  }
  if (e.status === 402) {
    addErrorMessage(
      "You're out of TokenPath credits. ",
      "Top up at platform.tokenpath.ai →",
      TokenPath.PLATFORM_URL
    );
    updateCredits(0);
    return;
  }
  if (e.status === 429) {
    addMessage("assistant", "TokenPath is rate-limiting requests — try again in a few seconds.");
    return;
  }
  addMessage("assistant", e.message || "TokenPath request failed.");
}

// --- Rendering --------------------------------------------------------------

function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = "msg " + role;
  div.textContent = text;
  els.messages.appendChild(div);
  scrollToBottom();
  return div;
}

// An assistant message whose tail is a clickable external link.
function addErrorMessage(text, linkText, href) {
  const div = addMessage("assistant", text);
  const link = document.createElement("a");
  link.className = "msg-link";
  link.textContent = linkText;
  link.href = href;
  link.target = "_blank";
  link.rel = "noreferrer";
  div.appendChild(link);
  return div;
}

function addThinking() {
  const div = document.createElement("div");
  div.className = "msg assistant thinking";
  div.textContent = "Thinking…";
  els.messages.appendChild(div);
  scrollToBottom();
  return div;
}

// Render the answer, turning server-provided attributions into clickable spans.
function addAnswer(answer, attributions, source) {
  const div = document.createElement("div");
  div.className = "msg assistant";

  const sorted = [...attributions]
    .filter(
      (item) =>
        Number.isFinite(item.answerStart) &&
        Number.isFinite(item.answerEnd) &&
        item.answerEnd > item.answerStart &&
        Number.isFinite(item.sourceStart) &&
        Number.isFinite(item.sourceEnd) &&
        item.sourceEnd > item.sourceStart
    )
    .sort((a, b) => a.answerStart - b.answerStart);

  let cursor = 0;
  for (const item of sorted) {
    if (item.answerStart < cursor || item.answerStart >= answer.length) continue;
    const answerEnd = Math.min(item.answerEnd, answer.length);
    if (item.answerStart > cursor) {
      div.appendChild(document.createTextNode(answer.slice(cursor, item.answerStart)));
    }
    const span = document.createElement("span");
    span.className = "attrib";
    span.textContent = answer.slice(item.answerStart, answerEnd);
    if (Number.isFinite(item.confidence)) {
      span.title =
        Math.round(item.confidence * 100) + "% match — click to find in the page";
      if (item.confidence < 0.35) span.classList.add("attrib-low");
    } else {
      span.title = "Click to find this in the page";
    }
    span.addEventListener("click", () =>
      onAttribClick(item.sourceStart, item.sourceEnd, source)
    );
    div.appendChild(span);
    cursor = answerEnd;
  }
  if (cursor < answer.length) {
    div.appendChild(document.createTextNode(answer.slice(cursor)));
  }

  els.messages.appendChild(div);
  scrollToBottom();
}

function isCurrentHighlight(source, epoch) {
  return (
    epoch === state.highlightEpoch &&
    !state.invalidated &&
    source.contextVersion === state.contextVersion &&
    source.captureId === state.captureId
  );
}

function clearHighlightTarget(target) {
  if (!target || target.tabId == null) return Promise.resolve();
  return chrome.tabs
    .sendMessage(
      target.tabId,
      {
        type: "clear-highlight",
        captureId: target.captureId || null,
      },
      { frameId: Number.isInteger(target.frameId) ? target.frameId : 0 }
    )
    .catch(() => {});
}

async function clearActiveHighlight(fallback = null) {
  const target = state.highlightedTarget || fallback;
  state.highlightedTarget = null;
  await clearHighlightTarget(target);
}

function cancelHighlightAndClear() {
  state.highlightEpoch++;
  clearActiveHighlight().catch(() => {});
}

async function onAttribClick(start, end, source) {
  if (state.invalidated) {
    showToast("The page navigated — re-select and choose TLDR again.");
    return;
  }
  if (
    source.tabId == null ||
    !Number.isFinite(start) ||
    !Number.isFinite(end)
  ) {
    return;
  }

  const epoch = ++state.highlightEpoch;
  await clearActiveHighlight();
  if (!isCurrentHighlight(source, epoch)) return;
  try {
    const response = await chrome.tabs.sendMessage(
      source.tabId,
      {
        type: "highlight",
        start,
        end,
        captureId: source.captureId,
      },
      { frameId: source.frameId }
    );
    if (!isCurrentHighlight(source, epoch)) {
      await clearHighlightTarget(source);
      return;
    }
    if (!response?.ok) {
      showToast("Couldn't locate that text in the page.");
      return;
    }
    state.highlightedTarget = source;
  } catch (e) {
    if (isCurrentHighlight(source, epoch)) {
      showToast("Page not reachable (it may have navigated).");
    }
  }
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

// --- Tab lifecycle ----------------------------------------------------------

function watchTab() {
  chrome.tabs.onUpdated.addListener((id, changeInfo) => {
    if (id !== state.tabId) return;
    if (changeInfo.url) {
      invalidate(
        "The page navigated. The captured selection no longer maps to the live page — re-select text and choose TLDR again."
      );
    }
  });
  chrome.tabs.onRemoved.addListener((id) => {
    if (id === state.tabId) invalidate("The tab was closed.");
  });
}

function invalidate(reason) {
  state.invalidated = true;
  cancelHighlightAndClear();
  showNotice(reason);
}

// --- Small helpers ----------------------------------------------------------

function setEnabled(on) {
  els.input.disabled = !on;
  els.send.disabled = !on;
}

function showNotice(text) {
  els.notice.textContent = text;
  els.notice.hidden = false;
}
function hideNotice() {
  els.notice.hidden = true;
}

let toastTimer = null;
function showToast(text) {
  els.toast.textContent = text;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2600);
}

// ============================================================================
// askLLM — grounded generation and fixed-span attribution via POST /v1/answer.
// The source offsets index the exact (possibly code-point-limited) document
// sent here, which is always a prefix of the content script's extraction.
// ============================================================================
async function askLLM(context, messages, { maxOutputTokens = null } = {}) {
  const lastUserIndex = messages.map((m) => m.role).lastIndexOf("user");
  const question =
    lastUserIndex === -1
      ? "Summarize the selected text."
      : messages[lastUserIndex].content;
  // Prior turns only; the latest user turn travels as `question`.
  const prior = messages
    .slice(0, lastUserIndex === -1 ? messages.length : lastUserIndex)
    .filter((m) => m.content && m.content.trim())
    .slice(-40)
    .map((m) => ({
      role: m.role,
      content: TldrPanelLogic.truncateCodePoints(m.content, 10_000),
    }));

  const documentText = TldrPanelLogic.truncateCodePoints(
    context,
    TokenPath.MAX_DOCUMENT_CHARS
  );
  const questionText = TldrPanelLogic.truncateCodePoints(question, 10_000);
  return TokenPath.answer({
    document: documentText,
    question: questionText,
    messages: prior,
    maxOutputTokens,
  });
}
