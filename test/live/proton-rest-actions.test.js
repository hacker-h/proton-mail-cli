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

    const conversationId = findConversationId(metadata.messages, conversations.conversations);
    if (conversationId) {
      const detail = await client.getConversation(conversationId);
      assertStableObject(detail, "conversation payload");
      const conversation = /** @type {Record<string, unknown>} */ (detail || {}).Conversation;
      assertStableObject(conversation, "nested conversation payload");
      assert.equal(/** @type {Record<string, unknown>} */ (conversation).ID, conversationId);
    }

    const eventId = await client.getLatestEventId();
    if (eventId !== undefined) {
      assert.equal(typeof eventId, "string");
      assert.ok(eventId.length > 0);
      const events = await client.getEvents(eventId);
      assertStableObject(events, "events payload");
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

  it("creates, lists, applies, renames, and deletes labels and folders through the CLI", async () => {
    const client = createRestClient();
    const env = { PROTONMAIL_REST_SESSION_FILE: process.env.PROTONMAIL_REST_SESSION_FILE || "" };
    const prefix = makeLivePrefix("labels");
    const labelName = `${prefix}-label`;
    const folderName = `${prefix}-folder`;
    assertLivePrefix(labelName, prefix);
    assertLivePrefix(folderName, prefix);

    const metadata = await client.getMessageMetadata({}, 0, 10);
    const target = metadata.messages.find((message) => message && typeof message === "object" && typeof message.ID === "string");
    assert.ok(target, "label/folder CLI test requires at least one metadata-visible message");
    const messageId = String(/** @type {Record<string, unknown>} */ (target).ID);
    let labelId = "";
    let folderId = "";
    let labelApplied = false;

    try {
      const createdLabel = runPmJson(["labels", "create", labelName, "--color", "#6d4aff"], env);
      assert.equal(createdLabel.ok, true, redact(JSON.stringify(createdLabel.error || createdLabel)));
      labelId = String(createdLabel.data.label.ID || createdLabel.data.id || "");
      assert.ok(labelId, "created label must include an ID");

      const createdFolder = runPmJson(["folders", "create", folderName, "--color", "#008a00"], env);
      assert.equal(createdFolder.ok, true, redact(JSON.stringify(createdFolder.error || createdFolder)));
      folderId = String(createdFolder.data.label.ID || createdFolder.data.id || "");
      assert.ok(folderId, "created folder must include an ID");

      const listedLabels = runPmJson(["labels", "list"], env);
      assert.ok(listedLabels.data.labels.some((label) => label.ID === labelId && label.Name === labelName));
      const listedFolders = runPmJson(["folders", "list"], env);
      assert.ok(listedFolders.data.labels.some((folder) => folder.ID === folderId && folder.Name === folderName));

      const apply = runPmJson(["mail", "label", "--label", labelId, messageId], env);
      assert.equal(apply.ok, true, redact(JSON.stringify(apply.error || apply)));
      labelApplied = true;

      const filtered = runPmJson(["ls", "--label", labelId, "--limit", "10"], env);
      assert.equal(filtered.ok, true, redact(JSON.stringify(filtered.error || filtered)));
      assert.ok(filtered.data.messages.some((message) => message.ID === messageId));

      const renamedLabel = `${prefix}-label-renamed`;
      const renamedFolder = `${prefix}-folder-renamed`;
      assertLivePrefix(renamedLabel, prefix);
      assertLivePrefix(renamedFolder, prefix);
      const labelUpdate = runPmJson(["labels", "update", labelId, renamedLabel, "--color", "#008a00"], env);
      assert.equal(labelUpdate.ok, true, redact(JSON.stringify(labelUpdate.error || labelUpdate)));
      const folderUpdate = runPmJson(["folders", "update", folderId, renamedFolder, "--color", "#6d4aff"], env);
      assert.equal(folderUpdate.ok, true, redact(JSON.stringify(folderUpdate.error || folderUpdate)));

      const unlabel = runPmJson(["mail", "unlabel", "--label", labelId, messageId], env);
      assert.equal(unlabel.ok, true, redact(JSON.stringify(unlabel.error || unlabel)));
      labelApplied = false;

      const deleteLabel = runPmJson(["labels", "delete", labelId, "--yes"], env);
      assert.equal(deleteLabel.ok, true, redact(JSON.stringify(deleteLabel.error || deleteLabel)));
      labelId = "";
      const deleteFolder = runPmJson(["folders", "delete", folderId, "--yes"], env);
      assert.equal(deleteFolder.ok, true, redact(JSON.stringify(deleteFolder.error || deleteFolder)));
      folderId = "";
    } finally {
      if (labelApplied && labelId) {
        try {
          await client.unlabelMessages([messageId], labelId);
        } finally {
          await client.deleteLabel(labelId);
        }
      } else if (labelId) {
        await client.deleteLabel(labelId);
      }
      if (folderId) await client.deleteLabel(folderId);
    }
  });

  it("observes events after a reversible message mutation", async () => {
    const client = createRestClient();
    const prefix = makeLivePrefix("events");
    const labelName = `${prefix}-label`;
    assertLivePrefix(labelName, prefix);
    const metadata = await client.getMessageMetadata({}, 0, 10);
    const target = metadata.messages.find((message) => message && typeof message === "object" && typeof message.ID === "string");
    assert.ok(target, "REST event test requires at least one metadata-visible message");

    const message = /** @type {Record<string, unknown>} */ (target);
    const messageId = String(message.ID);
    let labelId = "";

    try {
      const created = await client.createLabel(labelName, "#6d4aff", LabelType.LABEL);
      assert.ok(created && typeof created === "object", "event test label creation should return a label");
      labelId = String(/** @type {Record<string, unknown>} */ (created).ID || "");
      assert.ok(labelId, "event test label must include an ID");

      const eventId = await client.getLatestEventId();
      assert.equal(typeof eventId, "string");
      assert.ok(eventId.length > 0);

      await client.labelMessages([messageId], labelId);

      const events = await waitForMutationEvent(client, eventId, messageId, labelId);
      assertStableObject(events, "events after mutation payload");
      assert.notEqual(events.EventID, eventId, "event stream should advance after mutation");
    } finally {
      if (labelId) {
        try {
          await client.unlabelMessages([messageId], labelId);
        } finally {
          await client.deleteLabel(labelId);
        }
      }
    }
  });
});

function findConversationId(messages, conversations) {
  for (const source of messages) {
    if (!source || typeof source !== "object") continue;
    const record = /** @type {Record<string, unknown>} */ (source);
    const id = record.ConversationID || record.ConversationId;
    if (typeof id === "string" && id.trim()) return id;
  }
  for (const source of conversations) {
    if (!source || typeof source !== "object") continue;
    const record = /** @type {Record<string, unknown>} */ (source);
    const id = record.ID;
    if (typeof id === "string" && id.trim()) return id;
  }
  return "";
}

function assertStableObject(value, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} should be an object`);
}

async function waitForMutationEvent(client, eventId, messageId, labelId) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const events = await client.getEvents(eventId);
    if (hasMutationEvent(events, eventId, messageId, labelId)) return events;
    await delay(2000);
  }
  const events = await client.getEvents(eventId);
  assert.fail(`event stream did not include mutation for ${messageId}: ${redact(JSON.stringify(events))}`);
}

function hasMutationEvent(events, previousEventId, messageId, labelId) {
  if (!events || typeof events !== "object" || Array.isArray(events)) return false;
  const record = /** @type {Record<string, unknown>} */ (events);
  if (typeof record.EventID !== "string" || record.EventID === previousEventId) return false;
  return containsExactValue(record, messageId) || containsExactValue(record, labelId);
}

function containsExactValue(value, expected) {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((item) => containsExactValue(item, expected));
  if (!value || typeof value !== "object") return false;
  return Object.values(/** @type {Record<string, unknown>} */ (value)).some((item) => containsExactValue(item, expected));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
