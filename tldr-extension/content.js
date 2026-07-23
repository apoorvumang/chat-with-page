// TLDR — content script.
// Owns the node map: char offsets in the extracted text -> live Text nodes.
// The map NEVER crosses the message boundary; the panel only exchanges
// { text } and { start, end } char offsets with us.

(() => {
  // Guard against same-version double-injection (manifest + on-demand
  // scripting.executeScript). A versioned marker lets a fresh script replace a
  // stale isolated-world listener after an unpacked extension reload.
  const CONTENT_VERSION = "2026-07-24.2";
  if (window.__tldrContentLoaded === CONTENT_VERSION) return;
  window.__tldrContentLoaded = CONTENT_VERSION;

  const HL_NAME = "tldr-attrib";
  const QUOTE_CONTEXT_LENGTH = 48;
  const MAX_QUOTE_MATCHES = 256;
  const MAX_QUOTE_SOURCE_LENGTH = 500_000;
  const MAX_CAPTURE_CONTEXT_SOURCE_LENGTH = 100_000;

  // The live Range snapshotted at contextmenu time (before the menu click can
  // collapse the visible selection).
  let storedRange = null;
  let pendingExtraction = null;

  // Last extraction: { text, map, error }. map entries:
  //   { start, end, node, rawOffsets }
  // where start/end are offsets into `text`, and rawOffsets[i] is the raw
  // node.data offset of the extraction char at position (start + i).
  let extraction = null;

  let highlight = null;

  // --- Selection snapshot ---------------------------------------------------

  function isActiveInstance() {
    return window.__tldrContentLoaded === CONTENT_VERSION;
  }

  function liveSelectionRange() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }
    const range = selection.getRangeAt(0);
    if (range.startContainer.ownerDocument !== document) return null;
    return range.cloneRange();
  }

  function rememberLiveSelection(eagerlyExtract) {
    const range = liveSelectionRange();
    if (!range) {
      if (eagerlyExtract) pendingExtraction = null;
      return;
    }
    if (!eagerlyExtract && storedRange && sameRange(range, storedRange)) {
      return;
    }
    storedRange = range;
    // Keep the active captured extraction available for the open answer while
    // preparing the next context-menu capture separately. Chrome's flattened
    // selectionText is only a hint; Gmail/X can normalize invisible characters
    // differently from the exact DOM Range.
    if (eagerlyExtract) pendingExtraction = extractFromRange(range);
  }

  function sameRange(a, b) {
    return (
      a.startContainer === b.startContainer &&
      a.startOffset === b.startOffset &&
      a.endContainer === b.endContainer &&
      a.endOffset === b.endOffset
    );
  }

  document.addEventListener(
    "selectionchange",
    () => {
      if (isActiveInstance()) rememberLiveSelection(false);
    },
    true
  );
  document.addEventListener(
    "contextmenu",
    () => {
      if (isActiveInstance()) rememberLiveSelection(true);
    },
    true
  );

  // On-demand injection into a tab that predates extension installation/reload
  // happens after the contextmenu event. Snapshot immediately while the native
  // selection is still live, before the side panel finishes opening.
  rememberLiveSelection(false);

  // --- Message handling -----------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // A newer on-demand injection supersedes this instance. Do not race its
    // response with stale capture/highlight state from an already-open tab.
    if (!isActiveInstance()) return false;
    switch (msg && msg.type) {
      case "capture-selection": {
        const hint = normalizeForComparison(msg.selectionText || "");
        const hadPendingExtraction =
          !!pendingExtraction && !pendingExtraction.error;
        let candidate = pendingExtraction;
        pendingExtraction = null;

        if (!candidate || candidate.error) {
          candidate = extractFromRange(liveSelectionRange() || storedRange);
        }

        if (hint && candidate.error) {
          candidate = extractFromTextHint(msg.selectionText);
        } else if (
          hint &&
          !hadPendingExtraction &&
          normalizeForComparison(candidate.text) !== hint
        ) {
          // Tabs that predate injection may not have an eager contextmenu
          // snapshot. Prefer a unique hint remap when one exists, but never
          // replace a valid live Range with a text-search error.
          const hinted = extractFromTextHint(msg.selectionText);
          if (!hinted.error) candidate = hinted;
        }
        extraction = candidate;
        clearHighlight();
        extraction.captureId = msg.captureId || null;
        // The exact DOM map is now owned by `extraction`; the browser's native
        // blue selection is no longer needed and makes the page look stuck in
        // selection mode after the user chooses TLDR.
        sendResponse({ text: extraction.text, error: extraction.error });
        if (!extraction.error) clearNativeSelection();
        break;
      }
      case "highlight": {
        const ok =
          (!msg.captureId || msg.captureId === extraction?.captureId) &&
          highlightRange(msg.start, msg.end);
        sendResponse({ ok });
        break;
      }
      case "clear-highlight": {
        const ok =
          !msg.captureId || msg.captureId === extraction?.captureId;
        if (ok) clearHighlight();
        sendResponse({ ok });
        break;
      }
      default:
        break;
    }
    // All handlers respond synchronously.
    return false;
  });

  function clearNativeSelection() {
    try {
      const selection = window.getSelection();
      if (selection?.rangeCount && !selection.isCollapsed) {
        selection.removeAllRanges();
      }
    } catch (e) {
      // Visual cleanup is best-effort and must never turn a valid capture into
      // a failed one on an unusual document implementation.
    }
  }

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

    const styleCache = new WeakMap();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
        if (!isVisibleTextNode(node, styleCache)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const map = [];
    let text = "";
    let prevBlock = null;
    let prevTextNode = null;
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
      const block = nearestBlock(node, styleCache);
      if (
        text.length > 0 &&
        (block !== prevBlock || hasLineBreakBetween(prevTextNode, node, root))
      ) {
        text += "\n";
      }
      prevBlock = block;
      prevTextNode = node;

      const start = text.length;
      text += out;
      map.push({
        start,
        end: text.length,
        node,
        rawOffsets,
        messageAnchor: makeWhatsAppMessageAnchor(node),
      });
    }

    if (!text) {
      return {
        text: "",
        map: [],
        error: "No readable text found in the selection.",
      };
    }
    const anchor = makeRangeAnchor(range);
    attachAnchorPaths(map, anchor);
    attachScopeQuoteContexts(map, anchor);
    return { text, map, error: null, anchor };
  }

  // Rebuild a page-wide normalized text map only as a mutation fallback. If
  // the complete captured selection occurs exactly once, its absolute source
  // offsets can be rebased onto fresh nodes without searching for (and maybe
  // choosing the wrong copy of) a short phrase such as "Fable 5".
  function refreshDetachedExtraction() {
    if (!extraction || !extraction.text || !document.body) return false;
    if (
      extraction.anchor?.routeKey &&
      extraction.anchor.routeKey !== currentRouteKey()
    ) {
      return false;
    }

    const scope = resolveAnchorScope(extraction.anchor);
    // Rebase only when the complete captured selection is unique inside the
    // source. A saved child path cannot safely choose between repeated quotes
    // after a reorder.
    if (scope && rebaseExtractionWithin(scope)) return true;

    // If a stable source identity was captured, never fall through to a body
    // search: the same words may occur in another tweet/message.
    if (isStableAnchor(extraction.anchor)) return false;
    return rebaseExtractionWithin(document.body);
  }

  function rebaseExtractionWithin(scope) {
    const rebuilt = extractFromRoot(scope);
    const needle = extraction.text;
    const first = rebuilt.text.indexOf(needle);
    if (first < 0 || rebuilt.text.indexOf(needle, first + 1) >= 0) return false;

    const end = first + needle.length;
    const map = sliceMap(rebuilt.map, first, end);
    if (!map.length) return false;
    attachAnchorPaths(map, extraction.anchor);
    attachScopeQuoteContexts(map, extraction.anchor);
    extraction.map = map;
    return true;
  }

  // Gmail and X frequently replace subtrees with structurally equivalent
  // nodes. Preserve a path beneath a stable source identity so the exact Range
  // can be reconstructed before falling back to scoped text matching.
  function makeRangeAnchor(range) {
    let scope =
      range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    let selector = null;
    let kind = null;
    let statusId = null;
    let articleKey = null;
    const ancestors = [];
    for (let el = scope; el; el = el.parentElement) ancestors.push(el);

    // Prefer durable identities anywhere above the selection over a nearer but
    // ephemeral React wrapper/id.
    for (const el of ancestors) {
      const tweetId = el.getAttribute?.("data-tweet-id");
      if (!tweetId) continue;
      const candidate = `[data-tweet-id="${CSS.escape(tweetId)}"]`;
      if (document.querySelectorAll(candidate).length === 1) {
        scope = el;
        selector = candidate;
        kind = "x-post";
        break;
      }
    }

    // In the logged-in X SPA, identify a tweet by its own status permalink;
    // data-testid="tweet" alone is repeated throughout feeds and replies.
    for (const el of kind ? [] : ancestors) {
      if (el.matches?.('article[data-testid="tweet"]')) {
        const id = findOwnXStatusId(el);
        if (id) {
          scope = el;
          kind = "x-status";
          statusId = id;
          break;
        }
      }
    }

    for (const el of kind ? [] : ancestors) {
      for (const attribute of ["data-message-id", "data-legacy-message-id"]) {
        const value = el.getAttribute?.(attribute);
        if (!value) continue;
        const candidate = `[${attribute}="${CSS.escape(value)}"]`;
        if (document.querySelectorAll(candidate).length === 1) {
          scope = el;
          selector = candidate;
          kind = "gmail-message";
          break;
        }
      }
      if (selector) break;
    }

    for (const el of kind ? [] : ancestors) {
      const testId = el.getAttribute?.("data-testid");
      if (
        testId &&
        [
          "twitterArticleReadView",
          "twitterArticleRichTextView",
          "twitter-article-title",
          "longformRichTextComponent",
        ].includes(testId)
      ) {
        const candidate = `[data-testid="${CSS.escape(testId)}"]`;
        if (document.querySelectorAll(candidate).length === 1) {
          scope = el;
          selector = candidate;
          kind = "x-article";
          break;
        }
      }
    }

    // A single semantic article root is a stable scope across SSR hydration
    // and responsive rerenders even when its internal text nodes are replaced.
    for (const el of kind ? [] : ancestors) {
      const heading = el.matches?.("article")
        ? el.querySelector("h1, h2, h3")
        : null;
      const headingKey = normalizeForComparison(heading?.textContent || "");
      if (
        headingKey &&
        document.querySelectorAll("article").length === 1
      ) {
        scope = el;
        selector = "article";
        kind = "article";
        articleKey = headingKey;
        break;
      }
    }

    for (const el of kind || isXHost() ? [] : ancestors) {
      if (el.id) {
        const candidate = `#${CSS.escape(el.id)}`;
        if (document.querySelectorAll(candidate).length === 1) {
          scope = el;
          selector = candidate;
          kind = "element-id";
          break;
        }
      }
    }
    if (!selector && !kind) {
      scope = document.body;
      selector = "body";
      kind = "body";
    }
    if (!scope) return null;
    const startPath = nodePath(scope, range.startContainer);
    const endPath = nodePath(scope, range.endContainer);
    if (!startPath || !endPath) return null;
    return {
      selector,
      kind,
      statusId,
      articleKey,
      routeKey: currentRouteKey(),
      startPath,
      endPath,
      startOffset: range.startOffset,
      endOffset: range.endOffset,
    };
  }

  function isXHost() {
    return /(^|\.)(x|twitter)\.com$/i.test(location.hostname);
  }

  function currentRouteKey() {
    // Ordinary fragments are scroll positions, not source identity. Preserve
    // hashes only for Gmail and conventional hash-routed SPAs.
    const routeHash =
      location.hostname === "mail.google.com" ||
      /^#(?:!|\/)/.test(location.hash)
        ? location.hash
        : "";
    return (
      location.origin +
      location.pathname +
      location.search +
      routeHash
    );
  }

  function findOwnXStatusId(article) {
    for (const link of article.querySelectorAll('a[href*="/status/"]')) {
      if (link.closest('article[data-testid="tweet"]') !== article) continue;
      let pathname;
      try {
        pathname = new URL(link.href, location.href).pathname;
      } catch (e) {
        continue;
      }
      const match = pathname.match(/\/status\/(\d+)/);
      if (match) return match[1];
    }
    return null;
  }

  function nodePath(scope, target) {
    const path = [];
    let node = target;
    while (node && node !== scope) {
      const parent = node.parentNode;
      if (!parent) return null;
      const index = Array.prototype.indexOf.call(parent.childNodes, node);
      if (index < 0) return null;
      path.unshift(index);
      node = parent;
    }
    return node === scope ? path : null;
  }

  function nodeAtPath(scope, path) {
    let node = scope;
    for (const index of path) {
      node = node?.childNodes?.[index];
      if (!node) return null;
    }
    return node;
  }

  function attachAnchorPaths(map, anchor) {
    if (!isStableAnchor(anchor)) return;
    const scope = resolveAnchorScope(anchor);
    if (!scope) return;
    for (const entry of map) {
      entry.anchorPath = nodePath(scope, entry.node);
    }
  }

  // Capture bounded quote context outside each selected Text-node slice. This
  // is still fast and private to the content frame, but gives a later lazy
  // resolver evidence when an attribution consumes a whole node or selection.
  function attachScopeQuoteContexts(map, anchor) {
    const fallbackScope = resolveAnchorScope(anchor) || document.body;
    const groups = new Map();
    for (const entry of map) {
      const scope = entry.messageAnchor
        ? resolveWhatsAppMessageScope(entry.messageAnchor)
        : fallbackScope;
      if (!scope) continue;
      let entries = groups.get(scope);
      if (!entries) {
        entries = [];
        groups.set(scope, entries);
      }
      entries.push(entry);
    }

    for (const [scope, entries] of groups) {
      attachQuoteContextsFromRoot(
        entries,
        scope,
        "scopePrefix",
        "scopeSuffix"
      );
    }

    // A nearest-block context follows a paragraph when it is reordered, while
    // the broader semantic-scope context helps when wrappers disappear.
    const blockGroups = new Map();
    const styleCache = new WeakMap();
    for (const entry of map) {
      const block = nearestBlock(entry.node, styleCache);
      if (!block) continue;
      let entries = blockGroups.get(block);
      if (!entries) {
        entries = [];
        blockGroups.set(block, entries);
      }
      entries.push(entry);
    }
    for (const [block, entries] of blockGroups) {
      attachQuoteContextsFromRoot(
        entries,
        block,
        "blockPrefix",
        "blockSuffix"
      );
    }
  }

  function attachQuoteContextsFromRoot(
    entries,
    root,
    prefixKey,
    suffixKey
  ) {
    const rebuilt = extractFromRoot(
      root,
      true,
      MAX_CAPTURE_CONTEXT_SOURCE_LENGTH
    );
    if (rebuilt.overflow) return;
    const projection = buildQuoteProjection(rebuilt.text, rebuilt.map);
    const byNode = new WeakMap();
    for (const freshEntry of rebuilt.map) {
      byNode.set(freshEntry.node, freshEntry);
    }

    for (const entry of entries) {
      const freshEntry = byNode.get(entry.node);
      if (!freshEntry || !entry.rawOffsets.length) continue;
      const firstRawOffset = entry.rawOffsets[0];
      const lastRawOffset = entry.rawOffsets[entry.rawOffsets.length - 1];
      const first = canonicalOffsetForRaw(
        freshEntry,
        firstRawOffset,
        false
      );
      const last = canonicalOffsetForRaw(
        freshEntry,
        lastRawOffset,
        true
      );
      if (!Number.isFinite(first) || !Number.isFinite(last)) continue;

      const projectedStart = lowerBound(
        projection.canonicalOffsets,
        first
      );
      const projectedEnd = upperBound(
        projection.canonicalOffsets,
        last
      );
      entry[prefixKey] = projection.text.slice(
        Math.max(0, projectedStart - QUOTE_CONTEXT_LENGTH),
        projectedStart
      );
      entry[suffixKey] = projection.text.slice(
        projectedEnd,
        projectedEnd + QUOTE_CONTEXT_LENGTH
      );
    }
  }

  function canonicalOffsetForRaw(entry, rawOffset, preferBefore) {
    let candidate = -1;
    for (let index = 0; index < entry.rawOffsets.length; index++) {
      const current = entry.rawOffsets[index];
      if (current === rawOffset) return entry.start + index;
      if (preferBefore) {
        if (current > rawOffset) break;
        candidate = index;
      } else if (current >= rawOffset) {
        return entry.start + index;
      }
    }
    return candidate >= 0 ? entry.start + candidate : null;
  }

  function lowerBound(values, target) {
    let low = 0;
    let high = values.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (values[middle] < target) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function upperBound(values, target) {
    let low = 0;
    let high = values.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (values[middle] <= target) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  // WhatsApp serializes each message with a durable true_/false_ data-id
  // inside a role=row wrapper. A cross-message selection's common ancestor is
  // the conversation pane, so preserve a path for each mapped text node within
  // its own message as a narrower recovery identity.
  function makeWhatsAppMessageAnchor(node) {
    if (location.hostname !== "web.whatsapp.com") return null;
    const parent = node?.parentElement;
    const row = parent?.closest?.('[role="row"]');
    if (!row) return null;

    let dataId = null;
    for (let element = parent; element; element = element.parentElement) {
      const candidateId = element.getAttribute?.("data-id") || "";
      if (/^(true|false)_/.test(candidateId)) {
        // Keep walking so a quoted-message identity cannot beat the outer
        // identity of the current bubble.
        dataId = candidateId;
      }
      if (element === row) break;
    }
    if (!dataId) {
      const candidates = [
        ...row.querySelectorAll('[data-id^="true_"], [data-id^="false_"]'),
      ];
      if (candidates.length !== 1) return null;
      dataId = candidates[0].getAttribute("data-id");
    }

    const path = nodePath(row, node);
    if (!dataId || !path) return null;
    return { dataId, path };
  }

  function resolveWhatsAppMessageScope(anchor) {
    if (!anchor?.dataId || !Array.isArray(anchor.path)) return null;
    let candidates;
    try {
      const selector = `[data-id="${CSS.escape(anchor.dataId)}"]`;
      candidates = [...document.querySelectorAll(selector)];
    } catch (e) {
      return null;
    }
    if (candidates.length !== 1) return null;
    const identity = candidates[0];
    const row = identity.closest?.('[role="row"]');
    const scope = row || identity;
    return isRenderedElement(scope) ? scope : null;
  }

  function resolveAnchorScope(anchor) {
    if (!anchor) return null;
    if (anchor.kind === "x-status" && anchor.statusId) {
      const candidates = [
        ...document.querySelectorAll('article[data-testid="tweet"]'),
      ].filter((article) => findOwnXStatusId(article) === anchor.statusId);
      const rendered = candidates.filter(isRenderedElement);
      return rendered.length === 1 ? rendered[0] : null;
    }
    if (anchor.kind === "article" && anchor.articleKey) {
      const candidates = [...document.querySelectorAll("article")].filter(
        (article) =>
          normalizeForComparison(
            article.querySelector("h1, h2, h3")?.textContent || ""
          ) === anchor.articleKey
      );
      const rendered = candidates.filter(isRenderedElement);
      return rendered.length === 1 ? rendered[0] : null;
    }
    if (!anchor.selector) return null;
    try {
      const candidates = [...document.querySelectorAll(anchor.selector)];
      const rendered = candidates.filter(isRenderedElement);
      if (isStableAnchor(anchor)) {
        return rendered.length === 1 ? rendered[0] : null;
      }
      if (anchor.kind === "element-id") {
        return rendered.length === 1 ? rendered[0] : null;
      }
      return rendered[0] || candidates[0] || null;
    } catch (e) {
      return null;
    }
  }

  function isStableAnchor(anchor) {
    // A generic element id is a useful fast-path scope, not a semantic source
    // identity. Responsive apps can replace or rename layout roots while the
    // original mapped text nodes remain valid. Gmail/X identities stay strict.
    return (
      !!anchor &&
      anchor.kind !== "body" &&
      anchor.kind !== "element-id"
    );
  }

  function sliceMap(sourceMap, sliceStart, sliceEnd) {
    const map = [];
    for (const entry of sourceMap) {
      if (entry.end <= sliceStart) continue;
      if (entry.start >= sliceEnd) break;
      const overlapStart = Math.max(entry.start, sliceStart);
      const overlapEnd = Math.min(entry.end, sliceEnd);
      const from = overlapStart - entry.start;
      const to = overlapEnd - entry.start;
      map.push({
        start: overlapStart - sliceStart,
        end: overlapEnd - sliceStart,
        node: entry.node,
        rawOffsets: entry.rawOffsets.slice(from, to),
        messageAnchor: entry.messageAnchor || null,
        anchorPath: entry.anchorPath || null,
        scopePrefix: entry.scopePrefix || "",
        scopeSuffix: entry.scopeSuffix || "",
        blockPrefix: entry.blockPrefix || "",
        blockSuffix: entry.blockSuffix || "",
      });
    }
    return map;
  }

  // Last-resort recovery for tabs/frames that predate extension injection: the
  // context-menu API still gives us flattened selectionText. Anchor it only
  // when it has one unique occurrence in the live normalized frame, so this
  // fallback cannot silently choose the wrong duplicate.
  function extractFromTextHint(rawHint) {
    const needle = normalizeForComparison(rawHint);
    if (!needle || !document.body) {
      return {
        text: "",
        map: [],
        error: "No selection was captured. Select some text and try again.",
      };
    }
    const rebuilt = extractFromRoot(document.body);
    let flat = "";
    const canonicalOffsets = [];
    let inWhitespace = false;
    for (let i = 0; i < rebuilt.text.length; i++) {
      const ch = rebuilt.text[i];
      if (isComparisonIgnorable(ch)) continue;
      if (isWs(ch)) {
        if (inWhitespace) continue;
        inWhitespace = true;
        flat += " ";
        canonicalOffsets.push(i);
      } else {
        inWhitespace = false;
        flat += foldComparisonChar(ch);
        canonicalOffsets.push(i);
      }
    }
    const first = flat.indexOf(needle);
    if (first < 0 || flat.indexOf(needle, first + 1) >= 0) {
      return {
        text: "",
        map: [],
        error:
          first < 0
            ? "The page changed before the selection could be captured."
            : "That selection appears more than once. Select it again so TLDR can keep the exact occurrence.",
      };
    }
    const canonicalStart = canonicalOffsets[first];
    const canonicalEnd = canonicalOffsets[first + needle.length - 1] + 1;
    const text = rebuilt.text.slice(canonicalStart, canonicalEnd);
    const map = sliceMap(rebuilt.map, canonicalStart, canonicalEnd);
    return map.length
      ? {
          text,
          map,
          error: null,
          anchor: {
            selector: "body",
            kind: "body",
            routeKey: currentRouteKey(),
          },
        }
      : { text: "", map: [], error: "No readable text found in the selection." };
  }

  function normalizeForComparison(text) {
    const normalized = String(text || "")
      .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, "")
      .replace(/\s+/gu, " ")
      .trim();
    return normalized.replace(/[A-Z]/g, foldComparisonChar);
  }

  // CSS text-transform can make Chrome's context-menu selectionText use a
  // different case from the DOM (Substack dates are a current example). Keep
  // folding ASCII-only and length-preserving so canonicalOffsets stay exact.
  function foldComparisonChar(ch) {
    return ch >= "A" && ch <= "Z" ? ch.toLowerCase() : ch;
  }

  function extractFromRoot(
    root,
    renderedOnly = false,
    maxCharacters = Infinity
  ) {
    const styleCache = new WeakMap();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const accepted = renderedOnly
          ? isRenderedTextNode(node, styleCache)
          : isVisibleTextNode(node, styleCache);
        return accepted
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    const map = [];
    let text = "";
    let prevBlock = null;
    let prevTextNode = null;
    let node;
    while ((node = walker.nextNode())) {
      const { out, rawOffsets } = normalizeSlice(node.data, 0, node.data.length);
      if (!out) continue;
      const block = nearestBlock(node, styleCache);
      if (
        text.length > 0 &&
        (block !== prevBlock || hasLineBreakBetween(prevTextNode, node, root))
      ) {
        text += "\n";
      }
      prevBlock = block;
      prevTextNode = node;
      const start = text.length;
      text += out;
      if (text.length > maxCharacters) {
        return { text: "", map: [], overflow: true };
      }
      map.push({
        start,
        end: text.length,
        node,
        rawOffsets,
        messageAnchor: makeWhatsAppMessageAnchor(node),
      });
    }
    return { text, map, overflow: false };
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
    return !!ch && /\s/u.test(ch);
  }

  function isComparisonIgnorable(ch) {
    return !!ch && /[\u00ad\u200b-\u200d\u2060\ufeff]/u.test(ch);
  }

  function computedStyle(el, cache) {
    let style = cache && cache.get(el);
    if (!style) {
      style = window.getComputedStyle(el);
      if (cache) cache.set(el, style);
    }
    return style;
  }

  function isRenderedTextNode(node, cache) {
    let el = node.parentElement;
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return false;
    while (el) {
      if (el.hidden) return false;
      const cs = computedStyle(el, cache);
      if (cs.display === "none") return false;
      if (cs.visibility === "hidden" || cs.visibility === "collapse") {
        return false;
      }
      el = el.parentElement;
    }
    return true;
  }

  function isVisibleTextNode(node, cache) {
    if (!isRenderedTextNode(node, cache)) return false;
    let el = node.parentElement;
    let selectable = null;
    while (el) {
      const cs = computedStyle(el, cache);
      // `user-select` can be overridden below a non-selectable app shell.
      // WhatsApp does exactly that: the shell is `none`, while message text is
      // explicitly `text`. The closest decisive value controls whether this
      // node is selectable; distant ancestors must not override it. Continue
      // walking every ancestor for actual visibility checks.
      if (selectable === null && cs.userSelect && cs.userSelect !== "auto") {
        selectable = cs.userSelect !== "none";
      }
      el = el.parentElement;
    }
    return selectable !== false;
  }

  function isRenderedElement(element) {
    if (!element?.isConnected) return false;
    for (let el = element; el; el = el.parentElement) {
      if (el.hidden) return false;
      const style = window.getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse"
      ) {
        return false;
      }
    }
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

  function isBlockEl(el, cache) {
    if (!el) return false;
    const d = computedStyle(el, cache).display;
    return BLOCK_DISPLAYS.has(d);
  }

  function nearestBlock(node, cache) {
    let el = node.parentElement;
    while (el && !isBlockEl(el, cache)) el = el.parentElement;
    return el || node.parentElement;
  }

  function hasLineBreakBetween(previous, current, root) {
    if (!previous || !current) return false;
    let node = previous;
    // The text nodes are adjacent in the TreeWalker, so this normally visits
    // only a handful of intervening elements. The cap guards pathological DOM.
    for (let steps = 0; steps < 256; steps++) {
      node = nextDomNode(node, root);
      if (!node || node === current) return false;
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName === "BR") {
        return true;
      }
    }
    return false;
  }

  function nextDomNode(node, root) {
    if (node.firstChild) return node.firstChild;
    while (node && node !== root) {
      if (node.nextSibling) return node.nextSibling;
      node = node.parentNode;
    }
    return null;
  }

  // --- Highlighting ---------------------------------------------------------

  function highlightRange(rawStart, rawEnd) {
    if (!extraction || !extraction.map.length) return false;
    const resolved = resolveLiveAttributionRange(rawStart, rawEnd);
    if (!resolved) return false;
    clearHighlight();
    applyHighlight(resolved.range);
    scrollRangeIntoView(resolved.range);
    return true;
  }

  function resolveLiveAttributionRange(rawStart, rawEnd) {
    if (!extraction || !extraction.map.length) return null;
    if (
      extraction.anchor?.routeKey &&
      extraction.anchor.routeKey !== currentRouteKey()
    ) {
      return null;
    }

    // The original map is the cheapest and strongest identity signal. Check
    // only the clicked attribution so unrelated hydration elsewhere in the
    // selected document cannot invalidate an unchanged target.
    if (extractionSpanIsCurrent(rawStart, rawEnd)) {
      return resolveRange(rawStart, rawEnd);
    }

    // If the complete selection is still present, rebasing it preserves the
    // server's original occurrence offsets even for repeated short phrases.
    if (
      refreshDetachedExtraction() &&
      extractionSpanIsCurrent(rawStart, rawEnd)
    ) {
      return resolveRange(rawStart, rawEnd);
    }

    // Otherwise resolve only the clicked quote within its original semantic
    // source. Context disambiguates repeats; missing or tied matches fail.
    return resolveSpanFromQuote(rawStart, rawEnd);
  }

  function mappedEntriesForSpan(rawStart, rawEnd) {
    const { start, end } = clampSpan(extraction.text, rawStart, rawEnd);
    if (end <= start) return null;
    const startEntry =
      findEntry(extraction.map, start) ||
      firstEntryAtOrAfter(extraction.map, start);
    const endEntry =
      findEntry(extraction.map, end - 1) ||
      lastEntryAtOrBefore(extraction.map, end - 1);
    if (!startEntry || !endEntry) return null;
    const first = extraction.map.indexOf(startEntry);
    const last = extraction.map.indexOf(endEntry);
    if (first < 0 || last < first) return null;
    return { start, end, first, last };
  }

  function extractionSpanIsCurrent(rawStart, rawEnd) {
    if (
      extraction.anchor?.routeKey &&
      extraction.anchor.routeKey !== currentRouteKey()
    ) {
      return false;
    }
    const scope = resolveAnchorScope(extraction.anchor);
    if (isStableAnchor(extraction.anchor) && !scope) return false;
    const target = mappedEntriesForSpan(rawStart, rawEnd);
    if (!target) return false;
    const styleCache = new WeakMap();
    for (let index = target.first; index <= target.last; index++) {
      if (
        !mapEntryIsCurrent(
          extraction.map[index],
          scope,
          styleCache,
          target.start,
          target.end
        )
      ) {
        return false;
      }
    }
    return true;
  }

  function resolveSpanFromQuote(rawStart, rawEnd) {
    const target = mappedEntriesForSpan(rawStart, rawEnd);
    if (!target) return null;
    const scope = recoveryScopeForSpan(target);
    if (!scope) return null;

    const capturedProjection = buildQuoteProjection(
      extraction.text,
      extraction.map
    );
    const selector = makeQuoteSelector(capturedProjection, target);
    if (!selector.exact) return null;

    // Selectability is a capture concern, not a liveness requirement. Dynamic
    // apps may remove a temporary user-select override while the source remains
    // rendered and attributable.
    const rebuilt = extractFromRoot(
      scope,
      true,
      MAX_QUOTE_SOURCE_LENGTH
    );
    if (rebuilt.overflow) return null;
    const liveProjection = buildQuoteProjection(rebuilt.text, rebuilt.map);
    const match = chooseQuoteMatch(liveProjection.text, selector);
    if (!match) return null;

    const canonicalStart = liveProjection.canonicalOffsets[match.index];
    const canonicalEnd =
      liveProjection.canonicalOffsets[
        match.index + selector.exact.length - 1
      ] + 1;
    if (
      !Number.isFinite(canonicalStart) ||
      !Number.isFinite(canonicalEnd)
    ) {
      return null;
    }
    const resolved = resolveRangeFromMap(
      rebuilt.map,
      canonicalStart,
      canonicalEnd
    );
    if (!resolved) return null;
    if (
      match.evidence === "path" &&
      !rangeMatchesCapturedPath(resolved.range, target, scope)
    ) {
      return null;
    }
    return resolved;
  }

  function recoveryScopeForSpan(target) {
    const entries = extraction.map.slice(target.first, target.last + 1);
    const messageAnchors = entries
      .map((entry) => entry.messageAnchor)
      .filter(Boolean);
    if (messageAnchors.length) {
      // A reused conversation root is not a message identity. Recover only
      // when every target entry belongs to one exact serialized message.
      if (messageAnchors.length !== entries.length) return null;
      const ids = new Set(messageAnchors.map((anchor) => anchor.dataId));
      if (ids.size !== 1) return null;
      return resolveWhatsAppMessageScope(messageAnchors[0]);
    }
    if (location.hostname === "web.whatsapp.com") return null;

    const anchored = resolveAnchorScope(extraction.anchor);
    if (isStableAnchor(extraction.anchor)) return anchored;
    return anchored || document.body;
  }

  function buildQuoteProjection(text, map) {
    let projected = "";
    const canonicalOffsets = [];
    let inWhitespace = false;
    let mapIndex = 0;

    for (let index = 0; index < text.length; index++) {
      while (mapIndex < map.length && map[mapIndex].end <= index) mapIndex++;
      const mapped =
        mapIndex < map.length &&
        map[mapIndex].start <= index &&
        index < map[mapIndex].end;
      const ch = text[index];
      if (isWs(ch)) {
        if (inWhitespace) continue;
        inWhitespace = true;
        projected += " ";
        canonicalOffsets.push(index);
        continue;
      }
      // Synthetic block separators are whitespace. Any other unmapped
      // character is not backed by a live DOM position and is ignored.
      if (!mapped) continue;
      inWhitespace = false;
      projected += ch;
      canonicalOffsets.push(index);
    }
    return { text: projected, canonicalOffsets };
  }

  function makeQuoteSelector(projection, target) {
    const startEntry = extraction.map[target.first];
    const endEntry = extraction.map[target.last];
    const exact = projectedSlice(
      projection,
      target.start,
      target.end
    ).trim();
    // Prefer context inside the boundary Text nodes so a paragraph can move
    // without being tied to its old neighbor. Selection-wide context provides
    // evidence when the quote consumes an entire boundary node.
    const localPrefix = projectedSlice(
      projection,
      startEntry.start,
      target.start
    ).slice(-QUOTE_CONTEXT_LENGTH);
    const localSuffix = projectedSlice(
      projection,
      target.end,
      endEntry.end
    ).slice(0, QUOTE_CONTEXT_LENGTH);
    const selectionPrefix = projectedSlice(
      projection,
      0,
      target.start
    ).slice(-QUOTE_CONTEXT_LENGTH);
    const selectionSuffix = projectedSlice(
      projection,
      target.end,
      extraction.text.length
    ).slice(0, QUOTE_CONTEXT_LENGTH);
    const scopedPrefix = (
      (startEntry.scopePrefix || "") + localPrefix
    ).slice(-QUOTE_CONTEXT_LENGTH);
    const scopedSuffix = (
      localSuffix + (endEntry.scopeSuffix || "")
    ).slice(0, QUOTE_CONTEXT_LENGTH);
    const blockPrefix = (
      (startEntry.blockPrefix || "") + localPrefix
    ).slice(-QUOTE_CONTEXT_LENGTH);
    const blockSuffix = (
      localSuffix + (endEntry.blockSuffix || "")
    ).slice(0, QUOTE_CONTEXT_LENGTH);
    const contexts = [];
    addQuoteContext(contexts, localPrefix, localSuffix);
    addQuoteContext(contexts, blockPrefix, blockSuffix);
    addQuoteContext(contexts, scopedPrefix, scopedSuffix);
    addQuoteContext(contexts, selectionPrefix, selectionSuffix);
    return { exact, contexts };
  }

  function addQuoteContext(contexts, prefix, suffix) {
    if (!prefix && !suffix) return;
    if (
      contexts.some(
        (context) =>
          context.prefix === prefix && context.suffix === suffix
      )
    ) {
      return;
    }
    contexts.push({ prefix, suffix });
  }

  function projectedSlice(projection, canonicalStart, canonicalEnd) {
    let value = "";
    for (let index = 0; index < projection.text.length; index++) {
      const offset = projection.canonicalOffsets[index];
      if (offset < canonicalStart) continue;
      if (offset >= canonicalEnd) break;
      value += projection.text[index];
    }
    return value;
  }

  function chooseQuoteMatch(text, selector) {
    const matches = [];
    let cursor = 0;
    while (cursor <= text.length - selector.exact.length) {
      const match = text.indexOf(selector.exact, cursor);
      if (match < 0) break;
      matches.push(match);
      if (matches.length > MAX_QUOTE_MATCHES) return null;
      cursor = match + 1;
    }
    if (!matches.length) return null;

    const supported = new Set();
    for (const context of selector.contexts) {
      const contextual = matches.filter((match) =>
        quoteContextMatches(text, selector.exact, match, context)
      );
      if (contextual.length === 1) supported.add(contextual[0]);
    }
    if (supported.size === 1) {
      return { index: [...supported][0], evidence: "context" };
    }
    // A lone exact quote is only tentative: it still has to occupy the saved
    // path and raw offsets. Otherwise a mutated original could redirect to a
    // surviving duplicate elsewhere in the same source.
    return matches.length === 1
      ? { index: matches[0], evidence: "path" }
      : null;
  }

  function quoteContextMatches(text, exact, match, context) {
    const prefixMatches =
      !context.prefix ||
      text.slice(match - context.prefix.length, match) === context.prefix;
    const suffixMatches =
      !context.suffix ||
      text.slice(
        match + exact.length,
        match + exact.length + context.suffix.length
      ) === context.suffix;
    return prefixMatches && suffixMatches;
  }

  function rangeMatchesCapturedPath(range, target, scope) {
    const startEntry = extraction.map[target.first];
    const endEntry = extraction.map[target.last];
    const startPath =
      startEntry.messageAnchor?.path || startEntry.anchorPath;
    const endPath = endEntry.messageAnchor?.path || endEntry.anchorPath;
    if (!Array.isArray(startPath) || !Array.isArray(endPath)) return false;

    const startNode = nodeAtPath(scope, startPath);
    const endNode = nodeAtPath(scope, endPath);
    const startIndex = Math.max(target.start, startEntry.start);
    const endIndex = Math.min(target.end - 1, endEntry.end - 1);
    const startOffset =
      startEntry.rawOffsets[startIndex - startEntry.start];
    const endOffset =
      endEntry.rawOffsets[endIndex - endEntry.start] + 1;
    return (
      startNode === range.startContainer &&
      endNode === range.endContainer &&
      startOffset === range.startOffset &&
      endOffset === range.endOffset
    );
  }

  function mapEntryIsCurrent(
    entry,
    scope,
    styleCache,
    spanStart = entry.start,
    spanEnd = entry.end
  ) {
    return mapEntryMatchesNode(
      entry,
      entry.node,
      scope,
      styleCache,
      spanStart,
      spanEnd
    );
  }

  function mapEntryMatchesNode(
    entry,
    node,
    scope,
    styleCache,
    spanStart = entry.start,
    spanEnd = entry.end
  ) {
    const messageScope = entry.messageAnchor
      ? resolveWhatsAppMessageScope(entry.messageAnchor)
      : null;
    if (
      !node?.isConnected ||
      (scope && !scope.contains(node)) ||
      (entry.messageAnchor &&
        (!messageScope || !messageScope.contains(node))) ||
      !isRenderedTextNode(node, styleCache)
    ) {
      return false;
    }
    const start = Math.max(entry.start, spanStart);
    const end = Math.min(entry.end, spanEnd);
    if (end <= start) return false;
    let actual = "";
    for (let index = start; index < end; index++) {
      const rawOffset = entry.rawOffsets[index - entry.start];
      const ch = node.data[rawOffset];
      if (ch == null) return false;
      actual += isWs(ch) ? " " : ch;
    }
    return actual === extraction.text.slice(start, end);
  }

  function resolveRange(rawStart, rawEnd) {
    if (!extraction || !extraction.map.length) return null;
    const { start, end } = clampSpan(extraction.text, rawStart, rawEnd);
    if (end <= start) return null;
    return resolveRangeFromMap(extraction.map, start, end);
  }

  function resolveRangeFromMap(map, start, end) {
    // The extraction string contains synthetic "\n" block separators that have
    // no map entry. Clamp ends onto real mapped characters.
    const startEntry = findEntry(map, start) || firstEntryAtOrAfter(map, start);
    const endEntry = findEntry(map, end - 1) || lastEntryAtOrBefore(map, end - 1);
    if (!startEntry || !endEntry) return null;

    const sIdx = Math.max(start, startEntry.start);
    const eIdx = Math.min(end - 1, endEntry.end - 1);
    if (
      eIdx < sIdx ||
      !startEntry.node.isConnected ||
      !endEntry.node.isConnected
    ) {
      return null;
    }

    const nodeStart = startEntry.rawOffsets[sIdx - startEntry.start];
    const nodeEnd = endEntry.rawOffsets[eIdx - endEntry.start] + 1;
    if (!Number.isFinite(nodeStart) || !Number.isFinite(nodeEnd)) return null;

    try {
      const range = document.createRange();
      range.setStart(startEntry.node, nodeStart);
      range.setEnd(endEntry.node, nodeEnd);
      return { range, startEntry, endEntry };
    } catch (e) {
      // Do not fall back to a naked text search: it silently selects the first
      // duplicate occurrence. A failed exact remap is safer than a false cite.
      return null;
    }
  }

  // Highlight exactly the span TokenPath resolved — it already snaps to word
  // boundaries and verbatim source occurrences server-side, so any client-side
  // expansion (e.g. to sentence bounds) would only blur the precision that
  // token-level attribution buys. Just clamp into range and keep the ends off
  // whitespace / the synthetic "\n" block separators.
  function clampSpan(text, start, end) {
    const n = text.length;
    const rawStart = Number(start);
    const rawEnd = Number(end);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
      return { start: 0, end: 0 };
    }
    let s = Math.max(0, Math.min(Math.trunc(rawStart), n));
    let e = Math.max(s, Math.min(Math.trunc(rawEnd), n));

    while (s < e && isWs(text[s])) s++;
    while (e > s && isWs(text[e - 1])) e--;

    return { start: s, end: e };
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
    highlight = new Highlight(range);
    CSS.highlights.set(HL_NAME, highlight);
  }

  function clearHighlight() {
    if (!("highlights" in CSS)) {
      const selection = window.getSelection();
      if (selection) selection.removeAllRanges();
      return;
    }
    if (highlight) {
      highlight.clear();
      highlight = null;
    }
    CSS.highlights.delete(HL_NAME);
  }

  // Center the exact Range through nested scroll panes. Gmail's nearest text
  // parent is often the full-height message body, so element.scrollIntoView()
  // can report success while leaving the attributed line off-screen.
  function scrollRangeIntoView(range) {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const behavior = reduced ? "auto" : "smooth";
    let element =
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer
        : range.startContainer.parentElement;
    const initialRect = range.getBoundingClientRect();
    if (!element || (!initialRect.width && !initialRect.height)) {
      element?.scrollIntoView({ behavior, block: "center", inline: "nearest" });
      return;
    }

    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = window.getComputedStyle(parent);
      const scrollable =
        /(auto|scroll|overlay)/.test(style.overflowY) &&
        parent.scrollHeight > parent.clientHeight + 1;
      if (!scrollable) continue;
      const rect = range.getBoundingClientRect();
      const box = parent.getBoundingClientRect();
      if (rect.top < box.top || rect.bottom > box.bottom) {
        parent.scrollBy?.({
          top: rect.top - box.top - box.height / 2 + rect.height / 2,
          // Apply inner scrolls immediately so geometry for outer Gmail panes
          // is measured after the inner pane has moved.
          behavior: "auto",
        });
      }
    }

    const rect = range.getBoundingClientRect();
    // Leave room for sticky application chrome (notably X's top navigation)
    // instead of considering a technically on-screen but covered line visible.
    const topSafeArea = Math.min(96, Math.max(24, window.innerHeight * 0.08));
    if (rect.top < topSafeArea || rect.bottom > window.innerHeight) {
      window.scrollBy({
        top:
          rect.top -
          (window.innerHeight + topSafeArea) / 2 +
          rect.height / 2,
        behavior,
      });
    }
  }
})();
