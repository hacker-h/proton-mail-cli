import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildMailMetadataFilter, filterMailMessages, parseBrowserMessageRef } from "../src/mail-runner.js";

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

  it("builds Proton metadata filters from mail options", () => {
    assert.deepEqual(buildMailMetadataFilter({
      subject: "Invoice",
      from: "billing@example.test",
      to: "ops@example.test",
      labelId: "0",
      unread: true,
      after: 1700000000,
      before: 1700003600,
    }), {
      Subject: "Invoice",
      From: "billing@example.test",
      To: "ops@example.test",
      LabelID: "0",
      Unread: 1,
      Begin: 1700000000,
      End: 1700003600,
    });

    assert.deepEqual(buildMailMetadataFilter({ read: true }), { Unread: 0 });
  });
});
