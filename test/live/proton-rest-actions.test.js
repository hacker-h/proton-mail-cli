import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Labels, LabelType } from "../../src/index.js";
import { assertLivePrefix, createRestClient, makeLivePrefix, redact, restMutationTestOptions, restTestOptions, runPmJson } from "./helpers.js";

describe("live Proton REST metadata and API smoke", restTestOptions, () => {
  it("lists metadata, labels, conversations, and events", async () => {
    const client = createRestClient();

    const metadata = await client.getMessageMetadata({}, 0, 5);
    assert.equal(Array.isArray(metadata.messages), true);
    assert.equal(typeof metadata.total, "number");
    assert.equal(typeof metadata.stale, "boolean");

    const labels = await client.getLabels([LabelType.LABEL, LabelType.FOLDER, LabelType.SYSTEM]);
    assert.equal(Array.isArray(labels), true);

    const conversations = await client.getConversations({}, 0, 5);
    assert.equal(Array.isArray(conversations.conversations), true);
    assert.equal(typeof conversations.total, "number");

    const eventId = await client.getLatestEventId();
    if (eventId !== undefined) {
      assert.equal(typeof eventId, "string");
      assert.ok(eventId.length > 0);
      const events = await client.getEvents(eventId);
      assert.ok(events && typeof events === "object", "events endpoint should return an object payload");
    }
  });

  it("runs CLI REST metadata and action dry-run without mutating mail", async () => {
    const env = { PROTONMAIL_REST_SESSION_FILE: process.env.PROTONMAIL_REST_SESSION_FILE || "" };
    const list = runPmJson(["ls", "--after", "1", "--limit", "5"], env);
    assert.equal(list.ok, true, redact(JSON.stringify(list.error || list)));
    assert.equal(list.data.source, "rest");

    const action = runPmJson(["mail", "mark-read", "--from-search", "--after", "1", "--limit", "5", "--dry-run"], env);
    assert.equal(action.ok, true, redact(JSON.stringify(action.error || action)));
    assert.equal(action.data.source, "rest");
    assert.equal(action.data.action, "mark-read");
    assert.equal(action.data.dryRun, true);
    assert.equal(Array.isArray(action.data.affected), true);
    assert.equal(action.data.affected.length, 0);
  });
});

describe("live Proton REST reversible mutations", restMutationTestOptions, () => {
  it("creates a test label, labels/unlabels one message, and restores read state", async () => {
    const client = createRestClient();
    const prefix = makeLivePrefix("rest");
    const labelName = `${prefix}-label`;
    assertLivePrefix(labelName, prefix);

    const metadata = await client.getMessageMetadata({}, 0, 10);
    const target = metadata.messages.find((message) => message && typeof message === "object" && typeof message.ID === "string");
    assert.ok(target, "REST mutation test requires at least one metadata-visible message");

    const message = /** @type {Record<string, unknown>} */ (target);
    const messageId = String(message.ID);
    const wasUnread = Boolean(message.Unread);
    let labelId = "";

    try {
      const created = await client.createLabel(labelName, "#6d4aff", LabelType.LABEL);
      assert.ok(created && typeof created === "object", "label creation should return a label");
      labelId = String(/** @type {Record<string, unknown>} */ (created).ID || "");
      assert.ok(labelId, "created label must include an ID");

      const renamed = `${prefix}-renamed`;
      assertLivePrefix(renamed, prefix);
      await client.updateLabel(labelId, renamed, "#008a00");

      await client.markMessagesUnread([messageId]);
      let refreshed = await client.getMessage(messageId);
      assert.equal(Boolean(/** @type {Record<string, unknown>} */ (refreshed || {}).Unread), true);

      await client.markMessagesRead([messageId]);
      refreshed = await client.getMessage(messageId);
      assert.equal(Boolean(/** @type {Record<string, unknown>} */ (refreshed || {}).Unread), false);

      await client.labelMessages([messageId], labelId);
      const labeled = await client.getMessageMetadata({ LabelID: labelId }, 0, 10);
      assert.ok(labeled.messages.some((candidate) => candidate && typeof candidate === "object" && candidate.ID === messageId));

      await client.unlabelMessages([messageId], labelId);
    } finally {
      if (messageId) {
        if (wasUnread) await client.markMessagesUnread([messageId]);
        else await client.markMessagesRead([messageId]);
      }
      if (labelId) await client.deleteLabel(labelId);
    }
  });
});
