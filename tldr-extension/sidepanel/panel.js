// TLDR — side panel chat UI.
// Receives only { text } from the page and only ever sends back
// { start, end } char offsets. The node map lives in the content script.

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
  context: "",
  history: [], // [{ role: "user" | "assistant", content }]
  invalidated: false,
  busy: false,
  connected: false,
  // Set when a selection arrives before the user has connected; the auto
  // summary runs right after a successful connect.
  pendingAutoSummary: false,
};

init();

async function init() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  state.tabId = tab?.id ?? null;

  wireUI();
  watchTab();
  await initAuth();

  // Pick up a selection captured before the panel finished loading.
  if (state.tabId != null) {
    const stored = await chrome.storage.session.get(seedKey(state.tabId));
    const seed = stored[seedKey(state.tabId)];
    if (seed) applySeed(seed);
  }

  // Live updates if the user triggers TLDR again while the panel is open.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "selection-captured" && msg.tabId === state.tabId) {
      applySeed(msg);
    }
  });
}

function seedKey(tabId) {
  return "seed:" + tabId;
}

function applySeed(seed) {
  if (seed.error) {
    els.contextText.textContent = seed.error;
    setEnabled(false);
    return;
  }
  if (!seed.text) {
    els.contextText.textContent = "No text was captured.";
    setEnabled(false);
    return;
  }

  // A fresh capture clears any prior invalidation and chat.
  state.context = seed.text;
  state.invalidated = false;
  state.history = [];
  hideNotice();
  els.messages.innerHTML = "";
  els.contextText.textContent = seed.text;
  setEnabled(true);

  // Auto-summarize so the attribution round-trip is visible immediately —
  // once there's a TokenPath connection to run it through.
  if (state.connected) {
    runTurn("Summarize the selected text.", { echoUser: false });
  } else {
    state.pendingAutoSummary = true;
  }
}

// --- TokenPath auth ---------------------------------------------------------

async function initAuth() {
  const { key } = await TokenPath.getAuth();
  if (!key) {
    setConnected(false);
    return;
  }
  setConnected(true);
  // Validate lazily: show the balance if the key works, drop to the auth
  // card if it no longer does.
  try {
    updateCredits(await TokenPath.fetchCredits());
  } catch (e) {
    if (e instanceof TokenPath.Error && (e.status === 401 || e.status === 403)) {
      await TokenPath.clearKey();
      setConnected(false);
      showAuthError("Your saved TokenPath key was rejected — paste a new one.");
    }
  }
}

async function onConnectSubmit(e) {
  e.preventDefault();
  const key = els.authKey.value.trim();
  if (!key) return;

  els.authConnect.disabled = true;
  showAuthError(null);
  try {
    await TokenPath.setKey(key);
    updateCredits(await TokenPath.fetchCredits()); // validates the key
  } catch (err) {
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

  if (state.context && state.pendingAutoSummary) {
    state.pendingAutoSummary = false;
    runTurn("Summarize the selected text.", { echoUser: false });
  }
}

async function onDisconnect(e) {
  e.preventDefault();
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
    if (state.tabId == null) return;
    chrome.tabs
      .sendMessage(state.tabId, { type: "clear-highlight" })
      .catch(() => {});
  });

  els.authForm.addEventListener("submit", onConnectSubmit);
  els.disconnect.addEventListener("click", onDisconnect);
}

function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 120) + "px";
}

async function runTurn(userText, { echoUser }) {
  if (!state.connected) {
    state.pendingAutoSummary = true;
    els.auth.hidden = false;
    showToast("Connect TokenPath to start chatting.");
    els.authKey.focus();
    return;
  }

  if (echoUser) {
    state.history.push({ role: "user", content: userText });
    addMessage("user", userText);
  }

  state.busy = true;
  els.send.disabled = true;
  const thinking = addThinking();

  let result = null;
  let failure = null;
  try {
    result = await askLLM(state.context, [
      ...state.history,
      ...(echoUser ? [] : [{ role: "user", content: userText }]),
    ]);
  } catch (e) {
    failure = e;
  }

  thinking.remove();

  if (failure) {
    await renderFailure(failure);
  } else {
    state.history.push({ role: "assistant", content: result.answer });
    addAnswer(result.answer, result.attributions || []);
    updateCredits(result.creditsRemaining);
  }

  state.busy = false;
  els.send.disabled = false;
}

// Turn an API failure into an actionable chat message.
async function renderFailure(e) {
  if (!(e instanceof TokenPath.Error)) {
    addMessage("assistant", "Something went wrong generating an answer.");
    return;
  }
  if (e.status === 401 || e.status === 403) {
    await TokenPath.clearKey();
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

// Render the answer, turning attributions into clickable spans.
function addAnswer(answer, attributions) {
  const div = document.createElement("div");
  div.className = "msg assistant";

  const sorted = [...attributions]
    .filter(
      (a) =>
        Number.isFinite(a.answerStart) &&
        Number.isFinite(a.answerEnd) &&
        a.answerEnd > a.answerStart
    )
    .sort((a, b) => a.answerStart - b.answerStart);

  let cursor = 0;
  for (const a of sorted) {
    if (a.answerStart < cursor) continue; // skip overlaps
    if (a.answerStart > cursor) {
      div.appendChild(document.createTextNode(answer.slice(cursor, a.answerStart)));
    }
    const span = document.createElement("span");
    span.className = "attrib";
    span.textContent = answer.slice(a.answerStart, a.answerEnd);
    if (Number.isFinite(a.confidence)) {
      span.title =
        Math.round(a.confidence * 100) + "% match — click to find in the page";
      if (a.confidence < 0.35) span.classList.add("attrib-low");
    } else {
      span.title = "Click to find this in the page";
    }
    span.addEventListener("click", () =>
      onAttribClick(a.sourceStart, a.sourceEnd)
    );
    div.appendChild(span);
    cursor = a.answerEnd;
  }
  if (cursor < answer.length) {
    div.appendChild(document.createTextNode(answer.slice(cursor)));
  }

  els.messages.appendChild(div);
  scrollToBottom();
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

async function onAttribClick(start, end) {
  if (state.invalidated) {
    showToast("The page navigated — re-select and choose TLDR again.");
    return;
  }
  if (state.tabId == null || !Number.isFinite(start) || !Number.isFinite(end)) {
    return;
  }
  try {
    const res = await chrome.tabs.sendMessage(state.tabId, {
      type: "highlight",
      start,
      end,
    });
    if (!res || !res.ok) {
      showToast("Couldn't locate that text in the page.");
    }
  } catch (e) {
    showToast("Page not reachable (it may have navigated).");
  }
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
// askLLM — one authenticated round-trip to TokenPath's POST /v1/answer, which
// generates a grounded answer and attributes it in the same call.
//
//   askLLM(context, messages) -> { answer, attributions, creditsRemaining }
//   attributions: [{ answerStart, answerEnd, sourceStart, sourceEnd, confidence }]
//     answerStart/answerEnd -> char offsets into `answer`
//     sourceStart/sourceEnd -> char offsets into `context` (the extraction
//                              string), which the content script maps to live
//                              DOM nodes for highlighting.
//
// `context` is sent verbatim as `document` — never trimmed or re-normalized —
// so the source offsets in the response index straight into it.
// ============================================================================
async function askLLM(context, messages) {
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
    .map((m) => ({ role: m.role, content: m.content.slice(0, 10_000) }));

  return TokenPath.answer({
    document: context.slice(0, TokenPath.MAX_DOCUMENT_CHARS),
    question: question.slice(0, 10_000),
    messages: prior,
  });
}
