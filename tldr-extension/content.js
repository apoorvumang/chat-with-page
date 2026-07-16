// TLDR — content script.
// Owns the node map: char offsets in the extracted text -> live Text nodes.
// The map NEVER crosses the message boundary; the panel only exchanges
// { text } and { start, end } char offsets with us.

(() => {
  // Guard against double-injection (manifest + on-demand scripting.executeScript).
  if (window.__tldrContentLoaded) return;
  window.__tldrContentLoaded = true;

  const HL_NAME = "tldr-attrib";

  // The live Range snapshotted at contextmenu time (before the menu click can
  // collapse the visible selection).
  let storedRange = null;

  // Last extraction: { text, map, error }. map entries:
  //   { start, end, node, rawOffsets }
  // where start/end are offsets into `text`, and rawOffsets[i] is the raw
  // node.data offset of the extraction char at position (start + i).
  let extraction = null;

  let highlight = null;

  // --- Selection snapshot ---------------------------------------------------

  document.addEventListener(
    "contextmenu",
    () => {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
        storedRange = sel.getRangeAt(0).cloneRange();
      }
    },
    true
  );

  // --- Message handling -----------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg && msg.type) {
      case "capture-selection": {
        extraction = extractFromRange(storedRange);
        sendResponse({ text: extraction.text, error: extraction.error });
        break;
      }
      case "highlight": {
        const ok = highlightRange(msg.start, msg.end);
        sendResponse({ ok });
        break;
      }
      case "clear-highlight": {
        clearHighlight();
        sendResponse({ ok: true });
        break;
      }
      default:
        break;
    }
    // All handlers respond synchronously.
    return false;
  });

  // --- Extraction -----------------------------------------------------------

  function extractFromRange(range) {
    if (!range) {
      return {
        text: "",
        map: [],
        error: "No selection was captured. Select some text and try again.",
      };
    }
    let root = range.commonAncestorContainer;
    if (!root || !root.isConnected) {
      return {
        text: "",
        map: [],
        error: "The page changed; that selection is no longer available.",
      };
    }
    // A TreeWalker only visits descendants. When the selection is inside a
    // single text node, commonAncestorContainer IS that text node (very common
    // — e.g. selecting within one tweet or one sentence), so walk its parent
    // element instead; the acceptNode filter still restricts us to the range.
    if (root.nodeType !== Node.ELEMENT_NODE) {
      root = root.parentElement || root.parentNode;
    }
    if (!root) {
      return { text: "", map: [], error: "No readable text found in the selection." };
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
        if (!isVisibleTextNode(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const map = [];
    let text = "";
    let prevBlock = null;
    let node;

    while ((node = walker.nextNode())) {
      let rawStart = 0;
      let rawEnd = node.data.length;
      if (node === range.startContainer) rawStart = range.startOffset;
      if (node === range.endContainer) rawEnd = range.endOffset;
      if (rawStart >= rawEnd) continue;

      const { out, rawOffsets } = normalizeSlice(node.data, rawStart, rawEnd);
      if (!out) continue;

      // Insert a newline between block-level boundaries so the LLM sees
      // paragraph structure.
      const block = nearestBlock(node);
      if (text.length > 0 && block !== prevBlock) {
        text += "\n";
      }
      prevBlock = block;

      const start = text.length;
      text += out;
      map.push({ start, end: text.length, node, rawOffsets });
    }

    if (!text) {
      return {
        text: "",
        map: [],
        error: "No readable text found in the selection.",
      };
    }
    return { text, map, error: null };
  }

  // Collapse each run of whitespace to a single space, recording the source
  // raw offset for every emitted character so offsets round-trip exactly.
  function normalizeSlice(raw, from, to) {
    let out = "";
    const rawOffsets = [];
    let inWs = false;
    for (let i = from; i < to; i++) {
      const ch = raw[i];
      if (isWs(ch)) {
        if (inWs) continue;
        inWs = true;
        out += " ";
        rawOffsets.push(i);
      } else {
        inWs = false;
        out += ch;
        rawOffsets.push(i);
      }
    }
    return { out, rawOffsets };
  }

  function isWs(ch) {
    return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === " ";
  }

  function isVisibleTextNode(node) {
    const el = node.parentElement;
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return false;
    const cs = window.getComputedStyle(el);
    if (cs.display === "none") return false;
    if (cs.visibility === "hidden" || cs.visibility === "collapse") return false;
    return true;
  }

  const BLOCK_DISPLAYS = new Set([
    "block",
    "flex",
    "grid",
    "list-item",
    "table",
    "table-row",
    "table-cell",
    "table-caption",
    "flow-root",
  ]);

  function isBlockEl(el) {
    if (!el) return false;
    const d = window.getComputedStyle(el).display;
    return BLOCK_DISPLAYS.has(d);
  }

  function nearestBlock(node) {
    let el = node.parentElement;
    while (el && !isBlockEl(el)) el = el.parentElement;
    return el || node.parentElement;
  }

  // --- Highlighting ---------------------------------------------------------

  function highlightRange(rawStart, rawEnd) {
    if (!extraction || !extraction.map.length) return false;

    let { start, end } = snapToSentence(extraction.text, rawStart, rawEnd);
    if (end <= start) return false;

    const map = extraction.map;
    // The extraction string contains synthetic "\n" block separators that have
    // no map entry. Clamp both ends onto real, mapped characters so a range
    // that snapped onto a separator (e.g. a heading with no trailing period)
    // still resolves.
    const startEntry = findEntry(map, start) || firstEntryAtOrAfter(map, start);
    const endEntry = findEntry(map, end - 1) || lastEntryAtOrBefore(map, end - 1);
    if (!startEntry || !endEntry) return false;

    const sIdx = Math.max(start, startEntry.start);
    const eIdx = Math.min(end - 1, endEntry.end - 1);
    if (eIdx < sIdx) return false;

    if (!startEntry.node.isConnected || !endEntry.node.isConnected) {
      // DOM mutated out from under us — best-effort text search fallback.
      return highlightByTextSearch(extraction.text.slice(sIdx, eIdx + 1));
    }

    const nodeStart = startEntry.rawOffsets[sIdx - startEntry.start];
    const nodeEnd = endEntry.rawOffsets[eIdx - endEntry.start] + 1;

    let range;
    try {
      range = document.createRange();
      range.setStart(startEntry.node, nodeStart);
      range.setEnd(endEntry.node, nodeEnd);
    } catch (e) {
      return highlightByTextSearch(extraction.text.slice(start, end));
    }

    applyHighlight(range);
    const anchor = startEntry.node.parentElement;
    if (anchor) anchor.scrollIntoView({ behavior: "smooth", block: "center" });
    return true;
  }

  // Expand [start, end) outward to sentence boundaries; token-level spans are
  // noisy and this is the default UX.
  function snapToSentence(text, start, end) {
    const n = text.length;
    start = Math.max(0, Math.min(start, n));
    end = Math.max(start, Math.min(end, n));

    let s = start;
    while (s > 0 && !isSentenceEnd(text[s - 1])) s--;
    while (s < end && isWs(text[s])) s++;

    let e = end;
    while (e < n && !isSentenceEnd(text[e - 1])) e++;
    // Don't let the range end on trailing whitespace / a "\n" block separator.
    while (e > s && isWs(text[e - 1])) e--;

    return { start: s, end: e };
  }

  function isSentenceEnd(ch) {
    return ch === "." || ch === "!" || ch === "?" || ch === "\n";
  }

  // Binary search: entry with start <= offset < end.
  function findEntry(map, offset) {
    let lo = 0;
    let hi = map.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const e = map[mid];
      if (offset < e.start) hi = mid - 1;
      else if (offset >= e.end) lo = mid + 1;
      else return e;
    }
    return null;
  }

  // First entry whose text reaches at or past `offset` (for clamping a range
  // start that landed in a synthetic separator gap).
  function firstEntryAtOrAfter(map, offset) {
    for (let i = 0; i < map.length; i++) if (map[i].end > offset) return map[i];
    return null;
  }

  // Last entry whose text starts at or before `offset`.
  function lastEntryAtOrBefore(map, offset) {
    for (let i = map.length - 1; i >= 0; i--) {
      if (map[i].start <= offset) return map[i];
    }
    return null;
  }

  function applyHighlight(range) {
    if (!("highlights" in CSS)) {
      // Extremely old Chrome — fall back to native selection.
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    if (!highlight) {
      highlight = new Highlight();
      CSS.highlights.set(HL_NAME, highlight);
    }
    highlight.clear();
    highlight.add(range);
  }

  function clearHighlight() {
    if (highlight) highlight.clear();
  }

  // Best-effort fallback when the original nodes are detached.
  function highlightByTextSearch(str) {
    const needle = str.trim().replace(/\s+/g, " ");
    if (!needle || typeof window.find !== "function") return false;
    const sel = window.getSelection();
    sel.removeAllRanges();
    const found = window.find(needle, false, false, true, false, false, false);
    if (found && sel.rangeCount) {
      const range = sel.getRangeAt(0).cloneRange();
      applyHighlight(range);
      const anchor = range.startContainer.parentElement || document.body;
      anchor.scrollIntoView({ behavior: "smooth", block: "center" });
      sel.removeAllRanges();
      return true;
    }
    return false;
  }
})();
