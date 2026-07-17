// Isolated test of the pure offset logic that lives in content.js / panel.js.
// Simulates: extraction string + node map -> stub attributions -> highlight
// resolution, asserting the source span resolves to correct raw node offsets.

const assert = require("assert");

// --- copies of the pure functions under test (kept identical to source) ---

function isWs(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === " ";
}
function isSentenceEnd(ch) {
  return ch === "." || ch === "!" || ch === "?" || ch === "\n";
}
function snapToSentence(text, start, end) {
  const n = text.length;
  start = Math.max(0, Math.min(start, n));
  end = Math.max(start, Math.min(end, n));
  let s = start;
  while (s > 0 && !isSentenceEnd(text[s - 1])) s--;
  while (s < end && isWs(text[s])) s++;
  let e = end;
  while (e < n && !isSentenceEnd(text[e - 1])) e++;
  while (e > s && isWs(text[e - 1])) e--;
  return { start: s, end: e };
}
function findEntry(map, offset) {
  let lo = 0, hi = map.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, e = map[mid];
    if (offset < e.start) hi = mid - 1;
    else if (offset >= e.end) lo = mid + 1;
    else return e;
  }
  return null;
}
function firstEntryAtOrAfter(map, offset) {
  for (let i = 0; i < map.length; i++) if (map[i].end > offset) return map[i];
  return null;
}
function lastEntryAtOrBefore(map, offset) {
  for (let i = map.length - 1; i >= 0; i--) if (map[i].start <= offset) return map[i];
  return null;
}

// resolve a source [start,end) the way content.js highlightRange does
function resolve(text, map, rawStart, rawEnd) {
  let { start, end } = snapToSentence(text, rawStart, rawEnd);
  if (end <= start) return null;
  const startEntry = findEntry(map, start) || firstEntryAtOrAfter(map, start);
  const endEntry = findEntry(map, end - 1) || lastEntryAtOrBefore(map, end - 1);
  if (!startEntry || !endEntry) return null;
  const sIdx = Math.max(start, startEntry.start);
  const eIdx = Math.min(end - 1, endEntry.end - 1);
  if (eIdx < sIdx) return null;
  const nodeStart = startEntry.rawOffsets[sIdx - startEntry.start];
  const nodeEnd = endEntry.rawOffsets[eIdx - endEntry.start] + 1;
  return { startEntry, endEntry, nodeStart, nodeEnd, snappedText: text.slice(sIdx, eIdx + 1) };
}

// stub attribution logic (mirror of askLLM)
function stubAttribs(context) {
  const blocks = [];
  let cursor = 0;
  for (const raw of context.split("\n")) {
    const leading = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed) blocks.push({ text: trimmed, start: cursor + leading });
    cursor += raw.length + 1;
  }
  const out = [];
  for (const block of blocks.slice(0, 6)) {
    const m = block.text.match(/^[\s\S]*?[.!?](?=\s|$)/);
    const sentence = m ? m[0] : block.text;
    out.push({ sourceStart: block.start, sourceEnd: block.start + sentence.length, sentence });
  }
  return out;
}

// --- build a fake extraction: a heading (no period) + a paragraph ---
// Each map entry maps 1:1 here (no whitespace collapse), rawOffsets[i] = start+i
// but we deliberately give nodes DIFFERENT base rawOffsets to catch off-by-one.
function makeEntry(node, start, str, rawBase) {
  const rawOffsets = [];
  for (let i = 0; i < str.length; i++) rawOffsets.push(rawBase + i);
  return { start, end: start + str.length, node, rawOffsets };
}

const heading = "About the Project"; // no sentence terminator
const para = "This is the first sentence. And a second one.";
const text = heading + "\n" + para;

const map = [
  makeEntry({ id: "h", isConnected: true }, 0, heading, 100),
  // note the "\n" at index heading.length is synthetic — NOT in the map
  makeEntry({ id: "p", isConnected: true }, heading.length + 1, para, 500),
];

// 1) stub attributions have exact source slices
const attribs = stubAttribs(text);
assert.strictEqual(attribs.length, 2, "two blocks");
assert.strictEqual(text.slice(attribs[0].sourceStart, attribs[0].sourceEnd), "About the Project");
assert.strictEqual(text.slice(attribs[1].sourceStart, attribs[1].sourceEnd), "This is the first sentence.");
console.log("PASS: stub source offsets slice exactly");

// 2) heading attribution resolves (this was the bug: snapped onto "\n")
const rH = resolve(text, map, attribs[0].sourceStart, attribs[0].sourceEnd);
assert.ok(rH, "heading resolves");
assert.strictEqual(rH.startEntry.node.id, "h");
assert.strictEqual(rH.endEntry.node.id, "h");
assert.strictEqual(rH.nodeStart, 100, "heading raw start");
assert.strictEqual(rH.nodeEnd, 100 + heading.length, "heading raw end excludes newline");
assert.strictEqual(rH.snappedText, "About the Project");
console.log("PASS: heading (no period) resolves and excludes the \\n separator");

// 3) paragraph first-sentence resolves into the second node
const rP = resolve(text, map, attribs[1].sourceStart, attribs[1].sourceEnd);
assert.ok(rP, "para resolves");
assert.strictEqual(rP.startEntry.node.id, "p");
assert.strictEqual(rP.nodeStart, 500, "para raw start");
assert.strictEqual(rP.snappedText, "This is the first sentence.");
console.log("PASS: paragraph sentence resolves into correct node with correct raw offsets");

// 4) a range that starts right on the newline gap still clamps to real text
const gap = heading.length; // index of "\n"
const rGap = resolve(text, map, gap, gap + 5);
assert.ok(rGap, "gap-adjacent range resolves");
console.log("PASS: range touching the separator gap clamps to a real entry");

console.log("\nAll round-trip assertions passed.");
