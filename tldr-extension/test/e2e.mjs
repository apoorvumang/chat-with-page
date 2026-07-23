import { chromium } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// If setup-libs.sh vendored the extra shared libs (no-root environments),
// point the child Chromium process at them automatically.
const vendored = join(__dirname, "_libs", "flat");
if (existsSync(vendored)) {
  process.env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH
    ? `${vendored}:${process.env.LD_LIBRARY_PATH}`
    : vendored;
}

// Load the real content script (../content.js relative to this test file).
const CONTENT_JS = readFileSync(join(__dirname, "..", "content.js"), "utf8");
const PANEL_URL = pathToFileURL(
  join(__dirname, "..", "sidepanel", "panel.html")
).href;

const SITES = [
  "https://example.com",
  "https://en.wikipedia.org/wiki/Web_browser",
  "https://www.gnu.org/philosophy/free-sw.html",
  "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/p",
  "https://news.ycombinator.com",
  "https://bfl.ai/blog/flux-3",
  "https://taekim.substack.com/p/taes-new-substack-launches-today",
  "https://x.com/nasa", // expect a login/anti-bot wall — included to show the limit
];

// Mirror of the panel.js stub block-splitting, so we attribute the same way
// the real UI does (headings, first-sentence-per-block).
function stubAttribs(context) {
  const blocks = [];
  let cursor = 0;
  for (const raw of context.split("\n")) {
    const leading = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed) blocks.push({ text: trimmed, start: cursor + leading });
    cursor += raw.length + 1;
  }
  return blocks.slice(0, 8).map((b) => {
    const m = b.text.match(/^[\s\S]*?[.!?](?=\s|$)/);
    const sentence = m ? m[0] : b.text;
    return { sourceStart: b.start, sourceEnd: b.start + sentence.length, sentence };
  });
}

const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();

async function setupPage(page) {
  // chrome shim must exist before content.js registers its listener.
  await page.evaluate(() => {
    window.chrome = {
      runtime: {
        onMessage: { addListener: (fn) => (window.__tldrMsg = fn) },
      },
    };
  });
  // Inject via evaluate (Runtime.evaluate) rather than a <script> tag so we
  // are exempt from page CSP — mirroring how a real content script runs in an
  // isolated world. content.js is an IIFE expression, so it evaluates cleanly.
  await page.evaluate(CONTENT_JS);
}

// Select a range and fire the same messages background.js would.
async function captureRegion(page, mode) {
  return page.evaluate((mode) => {
    // find candidate text nodes
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) {
      const t = n.data.replace(/\s+/g, " ").trim();
      if (t.length >= 3 && n.parentElement && n.parentElement.offsetParent !== null) {
        nodes.push(n);
      }
      if (nodes.length > 400) break;
    }
    if (!nodes.length) return { error: "no text nodes on page" };

    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();

    if (mode === "single") {
      // A selection entirely inside ONE text node (the x.com failure shape).
      const node = nodes.find((x) => x.data.trim().length >= 40) || nodes[0];
      const s = node.data.search(/\S/);
      range.setStart(node, Math.max(0, s));
      range.setEnd(node, Math.min(node.data.length, s + 35));
    } else {
      // A multi-block region: first node .. a node ~15 later (spans headings).
      const a = nodes[0];
      const b = nodes[Math.min(nodes.length - 1, 15)];
      range.setStart(a, a.data.search(/\S/) < 0 ? 0 : a.data.search(/\S/));
      range.setEnd(b, b.data.length);
    }
    sel.addRange(range);

    // content.js snapshots the selection on contextmenu.
    document.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

    let resp;
    window.__tldrMsg({ type: "capture-selection" }, null, (r) => (resp = r));
    return resp;
  }, mode);
}

async function highlight(page, start, end) {
  return page.evaluate(
    ({ start, end }) => {
      let resp;
      window.__tldrMsg({ type: "highlight", start, end }, null, (r) => (resp = r));
      const hl = CSS.highlights ? CSS.highlights.get("tldr-attrib") : null;
      const ranges = hl ? [...hl].map((r) => r.toString()) : [];
      return { resp, ranges };
    },
    { start, end }
  );
}

const browser = await chromium.launch({ args: ["--no-sandbox"] });
let totalPass = 0,
  totalFail = 0,
  deterministicFail = 0;

function recordDeterministic(good) {
  if (good) {
    totalPass++;
  } else {
    totalFail++;
    deterministicFail++;
  }
}

// Side-panel regression: a never-resolving credits refresh must not hold the
// seed behind "Waiting…"; fixed attribution spans route to the original frame.
// The LinkedIn-shaped emoji also verifies that TokenPath's code-point answer
// and source offsets become browser-native UTF-16 offsets at the API boundary.
{
  const page = await browser.newPage();
  try {
    await page.addInitScript(() => {
      const source =
        "Fable 5 appeared during the first preview with early concept art and an initial cast reveal 🎓. " +
        "Later, after several production updates and a new showcase, Fable 5 shipped worldwide to players across every supported market.";
      window.__panelSource = source;
      window.__panelSent = [];
      window.__panelRequests = [];
      const runtimeListeners = [];
      window.__panelRuntimeListeners = runtimeListeners;
      window.chrome = {
        tabs: {
          query: () =>
            new Promise((resolve) => {
              window.__resolvePanelQuery = resolve;
            }),
          sendMessage: async (...args) => {
            window.__panelSent.push(args);
            return { ok: true };
          },
          onUpdated: { addListener() {} },
          onRemoved: { addListener() {} },
        },
        runtime: {
          onMessage: {
            addListener(listener) {
              runtimeListeners.push(listener);
            },
          },
        },
        storage: {
          local: {
            async get() {
              return { tokenpathKey: "tpk_test" };
            },
            async set() {},
            async remove() {},
          },
          session: {
            async get(key) {
              return {
                [key]: {
                  captureId: "seed-1",
                  capturedAt: 1,
                  tabId: 42,
                  windowId: 3,
                  frameId: 9,
                  text: source,
                  error: null,
                },
              };
            },
          },
        },
      };

      window.fetch = async (url, options = {}) => {
        const path = String(url);
        if (path.endsWith("/v1/me/credits")) {
          return new Promise(() => {});
        }
        const request = options.body ? JSON.parse(options.body) : null;
        window.__panelRequests.push({ path, request });
        if (path.endsWith("/v1/answer")) {
          const answer = "After the launch 🎓, Fable 5 shipped worldwide.";
          const answerUtf16Start = answer.indexOf("Fable 5");
          const sourceUtf16Start = request.document.lastIndexOf("Fable 5");
          const codePointOffset = (text, utf16Offset) =>
            Array.from(text.slice(0, utf16Offset)).length;
          const answerStart = codePointOffset(answer, answerUtf16Start);
          const sourceStart = codePointOffset(request.document, sourceUtf16Start);
          return new Response(
            JSON.stringify({
              answer,
              attributions: [
                {
                  answer: {
                    start: answerStart,
                    end: answerStart + 7,
                    text: "Fable 5",
                  },
                  source: {
                    start: sourceStart,
                    end: sourceStart + 7,
                    text: "Fable 5",
                    confidence: 0.94,
                  },
                },
              ],
              credits_remaining: 999,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("{}", { status: 404 });
      };
    });
    await page.goto(PANEL_URL);
    await page.evaluate(() => {
      // Deliver the capture before tabs.query resolves. The panel must already
      // be listening and replay it once its window identity is known.
      window.__panelRuntimeListeners[0]?.({
        type: "selection-captured",
        captureId: "seed-1",
        capturedAt: 1,
        tabId: 42,
        windowId: 3,
        frameId: 9,
        text: window.__panelSource,
        error: null,
      });
      window.__resolvePanelQuery([{ id: 42, windowId: 3 }]);
    });
    await page.waitForFunction(
      () => document.getElementById("context-text")?.textContent.startsWith("Fable 5")
    );
    await page.waitForSelector(".attrib");

    const panelResult = await page.evaluate(async () => {
      // A delayed older capture from another tab must be rejected without
      // changing where this answer's attribution is routed.
      window.__panelRuntimeListeners[0]?.({
        type: "selection-captured",
        captureId: "stale-seed",
        capturedAt: 0,
        tabId: 77,
        windowId: 3,
        frameId: 12,
        text: "stale",
      });
      document.querySelector(".attrib").click();
      for (let i = 0; i < 100 && window.__panelSent.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const answerRequest = window.__panelRequests.find((item) =>
        item.path.endsWith("/v1/answer")
      );
      return {
        context: document.getElementById("context-text").textContent,
        hasFixedSpans: !!document.querySelector(".attrib"),
        attributedText: document.querySelector(".attrib")?.textContent,
        answerRequest,
        sent: window.__panelSent[0],
      };
    });

    const sentMessage = panelResult.sent?.[1];
    const sentOptions = panelResult.sent?.[2];
    const sourceText = panelResult.context;
    const expectedFocus = sourceText.lastIndexOf("Fable 5");
    const good =
      panelResult.hasFixedSpans &&
      panelResult.attributedText === "Fable 5" &&
      panelResult.answerRequest?.request?.max_output_tokens <= 128 &&
      /at most \d+ words/.test(panelResult.answerRequest?.request?.question || "") &&
      sentMessage?.type === "highlight" &&
      sentMessage?.start === expectedFocus &&
      sentMessage?.end === expectedFocus + 7 &&
      sentMessage?.captureId === "seed-1" &&
      panelResult.sent?.[0] === 42 &&
      sentOptions?.frameId === 9;
    console.log("\n### Side-panel selection fixture");
    console.log(
      `  [nonblocking seed + Unicode-safe fixed-span routing] ${good ? "PASS" : "FAIL"}` +
        ` — frame=${sentOptions?.frameId}, source=${sentMessage?.start}`
    );
    recordDeterministic(good);
  } catch (error) {
    console.log(
      `\n### Side-panel selection fixture\n  FAIL — ${String(error.message).split("\n")[0]}`
    );
    recordDeterministic(false);
  } finally {
    await page.close();
  }
}

// Gmail-shaped regression: nested scroll pane, inline spans + <br>, repeated
// text, and a message subtree replacement between capture and highlight.
{
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <style>
        #pane { height: 180px; overflow-y: auto; border: 1px solid; }
        .spacer { height: 620px; }
        [data-message-id] { min-height: 420px; font: 16px sans-serif; }
      </style>
      <div id="pane">
        <div class="spacer"></div>
        <div data-message-id="gmail-message-1">
          <div class="first">Fable <span>5</span> appeared in a preview.</div>
          <br>
          <div class="second">Later, Fable <span>5</span> shipped worldwide.</div>
        </div>
      </div>
    `);
    await setupPage(page);

    const captured = await page.evaluate(() => {
      const first = document.querySelector(".first").firstChild;
      const second = document.querySelector(".second").lastChild;
      const range = document.createRange();
      range.setStart(first, 0);
      range.setEnd(second, second.data.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.querySelector(".second").dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true })
      );
      let response;
      window.__tldrMsg(
        { type: "capture-selection", selectionText: selection.toString() },
        null,
        (value) => (response = value)
      );
      return response;
    });

    const secondStart = captured.text.lastIndexOf("Fable 5");
    const result = await page.evaluate(
      ({ source, start }) => {
        const oldMessage = document.querySelector("[data-message-id]");
        oldMessage.replaceWith(oldMessage.cloneNode(true));
        let response;
        window.__tldrMsg(
          {
            type: "highlight",
            start,
            end: start + 7,
          },
          null,
          (value) => (response = value)
        );
        const focus = CSS.highlights.get("tldr-attrib");
        const focusRange = focus && [...focus][0];
        const parent = focusRange?.startContainer?.parentElement;
        return {
          response,
          text: focusRange?.toString() || "",
          second: !!parent?.closest(".second"),
          scrollTop: document.getElementById("pane").scrollTop,
          source,
        };
      },
      { source: captured.text, start: secondStart }
    );

    const good =
      captured.text.includes("\n") &&
      secondStart > captured.text.indexOf("Fable 5") &&
      result.response?.ok &&
      result.text === "Fable 5" &&
      result.second &&
      result.scrollTop > 0;
    console.log("\n### Gmail-like dynamic message fixture");
    console.log(
      `  [frame content capture + remap + highlight] ${good ? "PASS" : "FAIL"}` +
        ` — focus="${result.text}", second=${result.second}, scroll=${result.scrollTop}`
    );
    recordDeterministic(good);
  } catch (error) {
    console.log(
      `\n### Gmail-like dynamic message fixture\n  FAIL — ${String(error.message).split("\n")[0]}`
    );
    recordDeterministic(false);
  } finally {
    await page.close();
  }
}

// WhatsApp disables selection on its app shell, then explicitly re-enables
// message text. Capture a link-preview-to-image-caption selection across two
// bubbles while excluding metadata that remains genuinely unselectable.
{
  const page = await browser.newPage();
  try {
    const fixture = `
      <style>
        #app { user-select: none; }
        #main { width: 520px; }
        .message, .preview { display: block; margin: 8px; }
        .selectable-text { display: block; user-select: text; }
        .meta { user-select: text; }
        .controls { user-select: none; }
      </style>
      <div id="app">
        <section id="main">
          <div class="message" role="row" data-id="true_fixture_message_1">
            <div class="preview">
              <span id="preview-domain" class="selectable-text">github.com</span>
              <span class="selectable-text">https://github.com/everything3d/e3d-openscad-studio</span>
            </div>
            <div class="selectable-text">code is https://github.com/everything3d/e3d-openscad-studio push to main to deploy</div>
            <span class="meta">4:04 PM</span>
            <button class="controls">Reply</button>
          </div>
          <div class="message" role="row" data-id="true_fixture_message_2">
            <img alt="Community team sign" width="120" height="80">
            <div id="image-caption" class="selectable-text">Can we make for all of these</div>
            <span class="meta">7:23 PM</span>
          </div>
        </section>
      </div>
    `;
    await page.route("https://web.whatsapp.com/**", (route) =>
      route.fulfill({ contentType: "text/html", body: fixture })
    );
    await page.goto("https://web.whatsapp.com/fixture");
    await setupPage(page);

    const result = await page.evaluate(() => {
      const first = document.getElementById("preview-domain").firstChild;
      const last = document.getElementById("image-caption").firstChild;
      const range = document.createRange();
      range.setStart(first, 0);
      range.setEnd(last, last.data.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const selectionText = selection.toString();
      document.getElementById("main").dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true })
      );

      let captured;
      window.__tldrMsg(
        { type: "capture-selection", selectionText },
        null,
        (value) => (captured = value)
      );
      const nativeSelectionAfterCapture = selection.toString();

      // WhatsApp can replace its virtualized rows while previews and timestamps
      // hydrate. Recover the target beneath its exact serialized message id;
      // another message with the same caption must not steal the attribution.
      const main = document.getElementById("main");
      main.replaceWith(main.cloneNode(true));
      document.getElementById("preview-domain").textContent = "github.example";
      document.querySelector(".meta").textContent = "4:05 PM";
      document.getElementById("image-caption").classList.remove("selectable-text");
      document.getElementById("main").id = "main-next";
      document.getElementById("main-next").insertAdjacentHTML(
        "beforeend",
        '<div role="row" data-id="false_fixture_duplicate"><div class="selectable-text">Can we make for all of these</div></div>'
      );
      const target = "Can we make for all of these";
      const start = captured.text.indexOf(target);
      let highlighted;
      window.__tldrMsg(
        { type: "highlight", start, end: start + target.length },
        null,
        (value) => (highlighted = value)
      );
      const focus =
        [...(CSS.highlights.get("tldr-attrib") || [])][0]?.toString() || "";
      document
        .getElementById("image-caption")
        .closest('[role="row"]')
        .setAttribute("data-id", "false_fixture_reused_for_other_chat");
      let reusedMessage;
      window.__tldrMsg(
        { type: "highlight", start, end: start + target.length },
        null,
        (value) => (reusedMessage = value)
      );
      document
        .getElementById("image-caption")
        .closest('[role="row"]')
        .setAttribute("data-id", "true_fixture_message_2");
      document.getElementById("image-caption").textContent = "Changed target";
      let changedTarget;
      window.__tldrMsg(
        { type: "highlight", start, end: start + target.length },
        null,
        (value) => (changedTarget = value)
      );
      return {
        captured,
        nativeSelectionAfterCapture,
        highlighted,
        focus,
        reusedMessage,
        changedTarget,
      };
    });

    const good =
      !result.captured?.error &&
      result.captured?.text.includes("github.com") &&
      result.captured?.text.includes("Can we make for all of these") &&
      result.captured?.text.includes("4:04 PM") &&
      !result.captured?.text.includes("Reply") &&
      !result.captured?.text.includes("7:23 PM") &&
      result.nativeSelectionAfterCapture === "" &&
      result.highlighted?.ok &&
      result.focus === "Can we make for all of these" &&
      result.reusedMessage?.ok === false &&
      result.changedTarget?.ok === false;
    console.log("\n### WhatsApp-style selectable-message fixture");
    console.log(
      `  [selectable override + unrelated mutation + highlight] ${good ? "PASS" : "FAIL"}` +
        ` — error=${result.captured?.error || "none"}, focus="${result.focus}"`
    );
    recordDeterministic(good);
  } catch (error) {
    console.log(
      `\n### WhatsApp-style selectable-message fixture\n  FAIL — ${String(error.message).split("\n")[0]}`
    );
    recordDeterministic(false);
  } finally {
    await page.close();
  }
}

// SSR articles can hydrate or update media/lead content while an attributed
// paragraph later in the same selection remains unchanged. Restore only the
// clicked span beneath the unique semantic article instead of requiring every
// selected node to remain byte-identical.
{
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <main id="site-root">
        <article>
          <h1>FLUX 3: Real-World Visual Intelligence</h1>
          <p id="article-lead">FLUX 3 jointly learns from images, videos, and audio within one unified architecture.</p>
          <p id="article-target">Early results suggest this is the right path for real-world visual intelligence. Server-rendered footnote.</p>
        </article>
        <aside>Early results suggest this is the right path for real-world visual intelligence.</aside>
      </main>
    `);
    await setupPage(page);
    const result = await page.evaluate(() => {
      const lead = document.getElementById("article-lead").firstChild;
      const tail = document.getElementById("article-target").firstChild;
      const range = document.createRange();
      range.setStart(lead, 0);
      range.setEnd(tail, tail.data.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const selectionText = selection.toString();
      document.querySelector("article").dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true })
      );
      let captured;
      window.__tldrMsg(
        { type: "capture-selection", selectionText },
        null,
        (value) => (captured = value)
      );

      const article = document.querySelector("article");
      const hydrated = article.cloneNode(true);
      hydrated.querySelector("#article-lead").textContent =
        "The lead changed after a client-side media block hydrated.";
      hydrated.querySelector("#article-target").firstChild.data =
        "Early results suggest this is the right path for real-world visual intelligence. Hydrated client footnote.";
      article.replaceWith(hydrated);

      const target =
        "Early results suggest this is the right path for real-world visual intelligence.";
      const start = captured.text.indexOf(target);
      let highlighted;
      window.__tldrMsg(
        { type: "highlight", start, end: start + target.length },
        null,
        (value) => (highlighted = value)
      );
      const focus =
        [...(CSS.highlights.get("tldr-attrib") || [])][0]?.toString() || "";
      const duplicate = document.querySelector("article").cloneNode(true);
      duplicate.id = "duplicate-article";
      document.querySelector("article").after(duplicate);
      let duplicateArticle;
      window.__tldrMsg(
        { type: "highlight", start, end: start + target.length },
        null,
        (value) => (duplicateArticle = value)
      );
      duplicate.remove();
      document.getElementById("article-target").firstChild.data =
        "Early output suggests this is the right path for real-world visual intelligence. Hydrated client footnote.";
      let changedTarget;
      window.__tldrMsg(
        { type: "highlight", start, end: start + target.length },
        null,
        (value) => (changedTarget = value)
      );
      return {
        captured,
        highlighted,
        focus,
        duplicateArticle,
        changedTarget,
      };
    });
    const good =
      !result.captured?.error &&
      result.highlighted?.ok &&
      result.duplicateArticle?.ok === false &&
      result.changedTarget?.ok === false &&
      result.focus ===
        "Early results suggest this is the right path for real-world visual intelligence.";
    console.log("\n### Dynamic SSR article fixture");
    console.log(
      `  [unrelated hydration + semantic-span restore] ${good ? "PASS" : "FAIL"}` +
        ` — focus="${result.focus}"`
    );
    recordDeterministic(good);
  } catch (error) {
    console.log(
      `\n### Dynamic SSR article fixture\n  FAIL — ${String(error.message).split("\n")[0]}`
    );
    recordDeterministic(false);
  } finally {
    await page.close();
  }
}

// Chrome's context-menu selectionText can flatten or omit invisible formatting
// characters differently from the exact DOM Range. A successful eager snapshot
// must remain authoritative instead of producing a false "page changed" error.
{
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<p id="source">Selected\u200b text from the page.</p><p id="other">Other text.</p>'
    );
    await setupPage(page);
    const result = await page.evaluate(() => {
      const source = document.getElementById("source");
      const node = source.firstChild;
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      source.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

      let captured;
      window.__tldrMsg(
        {
          type: "capture-selection",
          // Simulate Chrome flattening the invisible character out.
          selectionText: "Selected text from the page.",
        },
        null,
        (value) => (captured = value)
      );
      const nativeSelectionAfterCapture = selection.toString();

      let highlighted;
      const start = captured.text.indexOf("text");
      window.__tldrMsg(
        { type: "highlight", start, end: start + 4 },
        null,
        (value) => (highlighted = value)
      );
      const focus = [...(CSS.highlights.get("tldr-attrib") || [])][0];
      return {
        captured,
        nativeSelectionAfterCapture,
        highlighted,
        focus: focus?.toString() || "",
      };
    });
    const good =
      !result.captured?.error &&
      result.captured?.text.includes("Selected") &&
      result.nativeSelectionAfterCapture === "" &&
      result.highlighted?.ok &&
      result.focus === "text";
    console.log("\n### Flattened selection hint fixture");
    console.log(
      `  [exact Range beats normalized hint + clears native selection] ${good ? "PASS" : "FAIL"}` +
        ` — selected=${result.nativeSelectionAfterCapture.length}, focus="${result.focus}"`
    );
    recordDeterministic(good);
  } catch (error) {
    console.log(
      `\n### Flattened selection hint fixture\n  FAIL — ${String(error.message).split("\n")[0]}`
    );
    recordDeterministic(false);
  } finally {
    await page.close();
  }
}

// Substack-style header-to-body selection with CSS-transformed date and
// unselectable reaction controls. This exercises the late-injection fallback.
{
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <style>
        .date { text-transform: uppercase; }
        .actions { user-select: none; }
      </style>
      <article aria-hidden="true">
        <h1 id="title">Substack Capture</h1>
        <div class="date">Jul 06, 2026</div>
        <div class="actions"><span>1,985</span> <span>182</span> <button>Share</button></div>
        <p id="body">Article body starts here and continues.</p>
      </article>
    `);

    // Simulate an already-open tab: the user selected from the title into the
    // body, but content.js was injected only after the native selection had
    // collapsed. The context-menu API still supplies the rendered text hint.
    await page.evaluate(() => {
      const range = document.createRange();
      range.setStart(document.getElementById("title").firstChild, 0);
      const tail = document.getElementById("body").firstChild;
      range.setEnd(tail, tail.data.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      selection.removeAllRanges();
    });
    await setupPage(page);

    const result = await page.evaluate(() => {
      // A collapsed caret is not the stale blue selection the feature is meant
      // to clear, so late-injection recovery must leave it alone.
      const selection = window.getSelection();
      const caret = document.createRange();
      caret.setStart(document.getElementById("body").firstChild, 0);
      caret.collapse(true);
      selection.removeAllRanges();
      selection.addRange(caret);

      let captured;
      window.__tldrMsg(
        {
          type: "capture-selection",
          selectionText:
            "Substack Capture JUL 06, 2026 Article body starts here and continues.",
        },
        null,
        (value) => (captured = value)
      );
      let highlighted;
      const start = captured.text.indexOf("Article body");
      window.__tldrMsg(
        { type: "highlight", start, end: start + "Article body".length },
        null,
        (value) => (highlighted = value)
      );
      const focus = [...(CSS.highlights.get("tldr-attrib") || [])][0];
      return {
        captured,
        caretPreserved: selection.rangeCount === 1 && selection.isCollapsed,
        highlighted,
        focus: focus?.toString() || "",
      };
    });
    const good =
      !result.captured?.error &&
      result.captured?.text.includes("Jul 06, 2026") &&
      !result.captured?.text.includes("1,985") &&
      !result.captured?.text.includes("Share") &&
      result.caretPreserved &&
      result.highlighted?.ok &&
      result.focus === "Article body";
    console.log("\n### Substack late-injection fixture");
    console.log(
      `  [header→body hint remap] ${good ? "PASS" : "FAIL"}` +
        ` — caret=${result.caretPreserved}, focus="${result.focus}"`
    );
    recordDeterministic(good);
  } catch (error) {
    console.log(
      `\n### Substack late-injection fixture\n  FAIL — ${String(error.message).split("\n")[0]}`
    );
    recordDeterministic(false);
  } finally {
    await page.close();
  }
}

// X Article fixture based on the current long-form selectors and DraftJS block
// shape. Article bodies are sign-in-gated in a clean browser, so this keeps a
// deterministic regression for the full body rather than merely its preview.
{
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div id="react-root">
        <main>
          <div data-testid="twitterArticleReadView">
            <h1 data-testid="twitter-article-title"><span>Reading an order book</span></h1>
            <div data-testid="longformRichTextComponent">
              <div data-contents="true">
                <div data-block="true"><div class="public-DraftStyleDefault-block"><span data-text="true">An order book records resting bids and asks.</span></div></div>
                <div data-block="true"><div class="public-DraftStyleDefault-block"><span data-text="true">Depth changes as participants add and cancel liquidity.</span></div></div>
                <div data-block="true" class="second"><div class="public-DraftStyleDefault-block"><span data-text="true">The live order book can therefore move before a trade prints.</span></div></div>
              </div>
            </div>
          </div>
        </main>
      </div>
    `);
    await setupPage(page);
    const captured = await page.evaluate(() => {
      const title = document.querySelector("[data-testid=twitter-article-title] span").firstChild;
      const tail = document.querySelector(".second [data-text=true]").firstChild;
      const range = document.createRange();
      range.setStart(title, 0);
      range.setEnd(tail, tail.data.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.querySelector(".second").dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true })
      );
      let response;
      window.__tldrMsg(
        { type: "capture-selection", selectionText: selection.toString() },
        null,
        (value) => (response = value)
      );
      return response;
    });
    const sourceStart = captured.text.lastIndexOf("order book");
    const result = await page.evaluate(
      ({ start }) => {
        const view = document.querySelector("[data-testid=twitterArticleReadView]");
        view.replaceWith(view.cloneNode(true));
        let response;
        window.__tldrMsg(
          {
            type: "highlight",
            start,
            end: start + 10,
          },
          null,
          (value) => (response = value)
        );
        const range = [...CSS.highlights.get("tldr-attrib")][0];
        return {
          response,
          text: range?.toString(),
          second: !!range?.startContainer?.parentElement?.closest(".second"),
        };
      },
      { start: sourceStart }
    );
    const good =
      captured.text.split("\n").length >= 4 &&
      result.response?.ok &&
      result.text === "order book" &&
      result.second;
    console.log("\n### X Article long-form fixture");
    console.log(
      `  [DraftJS blocks + rerender + repeated text] ${good ? "PASS" : "FAIL"}` +
        ` — focus="${result.text}", second=${result.second}`
    );
    recordDeterministic(good);
  } catch (error) {
    console.log(
      `\n### X Article long-form fixture\n  FAIL — ${String(error.message).split("\n")[0]}`
    );
    recordDeterministic(false);
  } finally {
    await page.close();
  }
}

// Public X currently exposes stable post identity as data-tweet-id. A React
// rerender plus feed reorder must not rebind a short duplicate to another post.
{
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<main><ol id="timeline">' +
        '<li><article data-tweet-id="111" itemscope itemtype="https://schema.org/SocialMediaPosting"><span>Fable 5</span></article></li>' +
        '<li><article data-tweet-id="222" itemscope itemtype="https://schema.org/SocialMediaPosting"><span>Fable 5</span></article></li>' +
        "</ol></main>"
    );
    await setupPage(page);
    const result = await page.evaluate(() => {
      const source = document.querySelector('[data-tweet-id="111"]');
      const node = source.querySelector("span").firstChild;
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      source.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

      let captured;
      window.__tldrMsg(
        { type: "capture-selection", selectionText: selection.toString() },
        null,
        (value) => (captured = value)
      );

      const rerendered = source.closest("li").cloneNode(true);
      source.closest("li").remove();
      document.getElementById("timeline").append(rerendered);
      document.getElementById("timeline").insertAdjacentHTML(
        "afterbegin",
        '<li><article data-tweet-id="333" itemscope itemtype="https://schema.org/SocialMediaPosting"><span>Fable 5</span></article></li>'
      );

      let response;
      window.__tldrMsg(
        { type: "highlight", start: 0, end: "Fable 5".length },
        null,
        (value) => (response = value)
      );
      const highlighted = [...(CSS.highlights.get("tldr-attrib") || [])][0];
      return {
        captured,
        response,
        text: highlighted?.toString() || "",
        tweetId:
          highlighted?.startContainer?.parentElement
            ?.closest("article[data-tweet-id]")
            ?.getAttribute("data-tweet-id") || null,
      };
    });
    const good =
      result.captured?.text === "Fable 5" &&
      result.response?.ok &&
      result.text === "Fable 5" &&
      result.tweetId === "111";
    console.log("\n### X duplicate-post identity fixture");
    console.log(
      `  [rerender + reorder preserves data-tweet-id] ${good ? "PASS" : "FAIL"}` +
        ` — id=${result.tweetId}, focus="${result.text}"`
    );
    recordDeterministic(good);
  } catch (error) {
    console.log(
      `\n### X duplicate-post identity fixture\n  FAIL — ${String(error.message).split("\n")[0]}`
    );
    recordDeterministic(false);
  } finally {
    await page.close();
  }
}

// React may reuse a connected Text node for different content. Connectivity
// alone is not enough evidence that saved source offsets still point at it.
{
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<article data-tweet-id="444"><span>Fable 5</span></article>'
    );
    await setupPage(page);
    const result = await page.evaluate(() => {
      const source = document.querySelector("span").firstChild;
      const range = document.createRange();
      range.selectNodeContents(source);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      source.parentElement.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true })
      );
      let captured;
      window.__tldrMsg(
        { type: "capture-selection", selectionText: selection.toString() },
        null,
        (value) => (captured = value)
      );

      source.data = "Wrong 55";
      let response;
      window.__tldrMsg(
        { type: "highlight", start: 0, end: "Fable 5".length },
        null,
        (value) => (response = value)
      );
      const highlighted = CSS.highlights.get("tldr-attrib");
      return {
        captured,
        response,
        count: highlighted ? [...highlighted].length : 0,
      };
    });
    const good =
      result.captured?.text === "Fable 5" &&
      result.response?.ok === false &&
      result.count === 0;
    console.log("\n### Connected-node mutation fixture");
    console.log(
      `  [changed source text is rejected] ${good ? "PASS" : "FAIL"}` +
        ` — ok=${result.response?.ok}, ranges=${result.count}`
    );
    recordDeterministic(good);
  } catch (error) {
    console.log(
      `\n### Connected-node mutation fixture\n  FAIL — ${String(error.message).split("\n")[0]}`
    );
    recordDeterministic(false);
  } finally {
    await page.close();
  }
}

// Public X post detail page. Target the post body itself (not navigation) and
// replace its rendered span before highlighting to exercise React rerenders.
{
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36",
  });
  const url = "https://x.com/NASA/status/2079303636895629808";
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForTimeout(1800);
    await setupPage(page);
    const captured = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.data.includes("Crew-13")) break;
      }
      if (!node) return { error: "post body not found" };
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      node.parentElement.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      let response;
      window.__tldrMsg(
        { type: "capture-selection", selectionText: selection.toString() },
        null,
        (value) => (response = value)
      );
      node.parentElement.replaceWith(node.parentElement.cloneNode(true));
      return response;
    });
    const start = captured.text?.indexOf("Crew-13") ?? -1;
    const result =
      start >= 0
        ? await highlight(page, start, start + "Crew-13".length)
        : { resp: null, ranges: [] };
    const good =
      !captured.error &&
      result.resp?.ok &&
      result.ranges.join("") === "Crew-13";
    console.log("\n### X post detail page");
    console.log(
      `  [post capture + React rerender + highlight] ${good ? "PASS" : "FAIL"}` +
        ` — "${result.ranges.join("")}"`
    );
    good ? totalPass++ : totalFail++;
  } catch (error) {
    console.log(
      `\n### X post detail page\n  LOAD FAILED — ${String(error.message).split("\n")[0]}`
    );
    totalFail++;
  } finally {
    await page.close();
  }
}

for (const url of SITES) {
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36",
  });
  const label = url.replace(/^https?:\/\//, "");
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForTimeout(1200);
    await setupPage(page);

    // Test 1: single-text-node selection extracts (the x.com regression).
    const single = await captureRegion(page, "single");
    const singleOk = single && !single.error && single.text && single.text.length > 5;
    console.log(
      `\n### ${label}`
    );
    console.log(
      `  [single-node capture] ${singleOk ? "PASS" : "FAIL"}` +
        (singleOk ? ` — "${single.text.slice(0, 45)}…"` : ` — ${JSON.stringify(single)}`)
    );
    singleOk ? totalPass++ : totalFail++;

    // Test 2: multi-block capture + highlight every attribution (incl. headings)
    const region = await captureRegion(page, "region");
    if (!region || region.error || !region.text) {
      console.log(`  [region capture] FAIL — ${JSON.stringify(region)}`);
      totalFail++;
    } else {
      const attribs = stubAttribs(region.text);
      let ok = 0,
        bad = 0;
      const failures = [];
      for (const a of attribs) {
        const { resp, ranges } = await highlight(page, a.sourceStart, a.sourceEnd);
        const hlText = ranges.join(" ");
        const want = norm(region.text.slice(a.sourceStart, a.sourceEnd)).split(" ")[0] || "";
        const good = resp && resp.ok && hlText.length > 0 && norm(hlText).includes(want);
        if (good) ok++;
        else {
          bad++;
          failures.push(`"${a.sentence.slice(0, 30)}" -> ok=${resp && resp.ok} hl="${hlText.slice(0, 30)}"`);
        }
      }
      console.log(
        `  [region capture] PASS — ${region.text.split("\n").filter(Boolean).length} blocks`
      );
      console.log(
        `  [attribution highlights] ${ok}/${ok + bad} resolved${bad ? " — misses: " + failures.join(" | ") : ""}`
      );
      bad === 0 ? totalPass++ : totalFail++;
    }
  } catch (e) {
    console.log(`\n### ${label}\n  LOAD FAILED — ${String(e.message).split("\n")[0]}`);
    totalFail++;
  } finally {
    await page.close();
  }
}

await browser.close();
console.log(`\n=========================\nsuites passed: ${totalPass}, failed: ${totalFail}`);
if (deterministicFail > 0) process.exitCode = 1;
