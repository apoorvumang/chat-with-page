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
};

const state = {
  tabId: null,
  context: "",
  history: [], // [{ role: "user" | "assistant", content }]
  invalidated: false,
  busy: false,
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

  // Auto-summarize so the attribution round-trip is visible immediately.
  runTurn("Summarize the selected text.", { echoUser: false });
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
}

function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 120) + "px";
}

async function runTurn(userText, { echoUser }) {
  if (echoUser) {
    state.history.push({ role: "user", content: userText });
    addMessage("user", userText);
  }

  state.busy = true;
  els.send.disabled = true;
  const thinking = addThinking();

  let result;
  try {
    result = await askLLM(state.context, [
      ...state.history,
      ...(echoUser ? [] : [{ role: "user", content: userText }]),
    ]);
  } catch (e) {
    result = { answer: "Something went wrong generating an answer.", attributions: [] };
  }

  thinking.remove();
  state.history.push({ role: "assistant", content: result.answer });
  addAnswer(result.answer, result.attributions || []);

  state.busy = false;
  els.send.disabled = false;
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
    span.title = "Click to find this in the page";
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
// STUB — replace with the real LLM + TokenPath integration.
//
//   askLLM(context, messages) -> { answer, attributions }
//   attributions: [{ answerStart, answerEnd, sourceStart, sourceEnd }]
//     answerStart/answerEnd -> char offsets into `answer`
//     sourceStart/sourceEnd -> char offsets into `context` (the extraction
//                              string), which the content script maps to live
//                              DOM nodes for highlighting.
//
// This stub summarizes by echoing the first sentence of each paragraph and
// attributing each bullet back to its exact source span, so the highlight
// round-trip is demonstrable without any API keys.
// ============================================================================
async function askLLM(context, messages) {
  await new Promise((r) => setTimeout(r, 250));

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const question = lastUser ? lastUser.content : "";

  const prefix =
    "Here's a TLDR of the selected text" +
    (question && !/summar/i.test(question) ? ` (re: "${question}")` : "") +
    ":\n\n";

  const paragraphs = context
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean);

  const attributions = [];
  let body = "";

  for (const para of paragraphs.slice(0, 6)) {
    const m = para.match(/^[\s\S]*?[.!?](\s|$)/);
    const sentence = (m ? m[0] : para).trim();
    if (!sentence) continue;

    const sourceStart = context.indexOf(sentence);
    const sourceEnd = sourceStart + sentence.length;

    const bulletPrefix = "• ";
    const answerStart = prefix.length + body.length + bulletPrefix.length;
    body += bulletPrefix + sentence;
    const answerEnd = prefix.length + body.length;
    body += "\n";

    if (sourceStart >= 0) {
      attributions.push({ answerStart, answerEnd, sourceStart, sourceEnd });
    }
  }

  if (!body) {
    return {
      answer: "I couldn't find any content in the selection to summarize.",
      attributions: [],
    };
  }

  return { answer: prefix + body.trimEnd(), attributions };
}
