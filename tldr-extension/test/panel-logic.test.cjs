const assert = require("assert");
const Logic = require("../sidepanel/panel-logic.js");

const textWithWords = (count) =>
  Array.from({ length: count }, (_, index) => `w${index}`).join(" ");

for (const count of [1, 10, 24]) {
  const request = Logic.buildSummaryRequest(textWithWords(count));
  assert.strictEqual(request.skip, true, `${count} words should skip auto-summary`);
}
console.log("PASS: already-short selections skip model summarization");

const medium = Logic.buildSummaryRequest(textWithWords(25));
assert.strictEqual(medium.skip, false);
assert.strictEqual(medium.maxWords, 12);
assert.ok(medium.maxWords < medium.sourceWords);
assert.ok(medium.maxOutputTokens >= 16 && medium.maxOutputTokens <= 128);
assert.match(medium.prompt, /at most 12 words/);

const large = Logic.buildSummaryRequest(textWithWords(500));
assert.strictEqual(large.maxWords, 80);
assert.strictEqual(large.maxOutputTokens, 128);
console.log("PASS: summary word and token budgets scale and cap");

assert.strictEqual(
  Logic.enforceShorterSummary("one two three four", "one two three"),
  "one two…"
);
assert.strictEqual(
  Logic.enforceShorterSummary("short answer", "this source has several more words"),
  "short answer"
);
assert.ok(
  Logic.enforceShorterSummary(textWithWords(30), textWithWords(25), 12)
    .match(/\S+/g).length < 25
);
console.log("PASS: displayed TL;DR is always strictly shorter than its source");

const cjk = Logic.buildSummaryRequest("这是一个用于验证没有空格的长文本摘要行为并确保模型不会返回比原始选择更长内容的测试段落它还包含更多字符以超过短文本阈值");
assert.strictEqual(cjk.skip, false);
assert.match(cjk.prompt, /characters/);
console.log("PASS: long CJK selections do not bypass summarization");

assert.strictEqual(Logic.truncateCodePoints("ab🙂cd", 3), "ab🙂");
assert.strictEqual(Logic.truncateCodePoints("ab🙂cd", 4), "ab🙂c");
console.log("PASS: document limits never split emoji surrogate pairs");

console.log("\nAll panel-logic assertions passed.");
