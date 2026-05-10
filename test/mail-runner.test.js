import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { filterMailMessages, parseBrowserMessageRef } from "../src/mail-runner.js";

describe("mail runner helpers", () => {
  it("filters previews with case-insensitive text", () => {
    const messages = [
      { index: 0, preview: "GitHub sign-in" },
      { index: 1, preview: "Bank notice" },
    ];

    assert.deepEqual(filterMailMessages(messages, "github"), [{ index: 0, preview: "GitHub sign-in" }]);
  });

  it("does not leak RegExp lastIndex across message previews", () => {
    const messages = [
      { index: 0, preview: "GitHub sign-in" },
      { index: 1, preview: "GitHub notification" },
      { index: 2, preview: "GitHub release" },
    ];

    assert.deepEqual(filterMailMessages(messages, /github/gi), messages);
  });

  it("parses only explicit browser message refs", () => {
    assert.equal(parseBrowserMessageRef("browser:index:12"), 12);
    assert.equal(parseBrowserMessageRef("12"), null);
    assert.equal(parseBrowserMessageRef("msg_123"), null);
  });
});
