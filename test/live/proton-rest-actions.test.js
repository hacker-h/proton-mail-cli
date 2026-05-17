import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Labels, LabelType } from "../../src/index.js";
import {
  assertLivePrefix,
  browserTestOptions,
  cleanupTmpDir,
  closeLivePage,
  createRestClient,
  hasRestSession,
  hasSecondaryCredentials,
  makeLivePrefix,
  openLiveInboxPage,
  pollBrowserMessage,
  prepareSessionFile,
  redact,
  restMutationTestOptions,
  restTestOptions,
  runPmJson,
  sendBrowserMessage,
} from "./helpers.js";

const mailboxActionTestOptions = hasRestSession && process.env.PROTONMAIL_LIVE_REST_MUTATION === "1" && !browserTestOptions.skip && hasSecondaryCredentials
  ? {}
  : { skip: "Set PROTONMAIL_LIVE_TEST=1, PROTONMAIL_LIVE_REST_MUTATION=1, REST session, reusable browser auth, and PROTONMAIL_USERNAME2/PROTONMAIL_PASSWORD2 for mailbox action mutation tests" };

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

describe("live Proton REST generated-message mailbox actions", mailboxActionTestOptions, () => {
  it("archives, restores, stars, spam-moves, and folder-moves a generated message", async () => {
    const client = createRestClient();
    const prefix = makeLivePrefix("mailbox");
    const subject = `${prefix}-subject`;
    const body = `${prefix}-body`;
    const folderName = `${prefix}-folder`;
    assertLivePrefix(subject, prefix);
    assertLivePrefix(body, prefix);
    assertLivePrefix(folderName, prefix);

    const primarySession = prepareSessionFile();
    const secondarySession = prepareSessionFile({ seed: false, useConfigured: false });
    let secondaryRuntime;
    let messageId = "";
    let folderId = "";

    try {
      secondaryRuntime = await openLiveInboxPage({
        sessionFile: secondarySession.sessionFile,
        usernameEnv: "PROTONMAIL_USERNAME2",
        passwordEnv: "PROTONMAIL_PASSWORD2",
      });
      await sendBrowserMessage(secondaryRuntime.page, { to: [process.env.PROTONMAIL_USERNAME || ""], subject, body });
      await pollBrowserMessage({ sessionFile: primarySession.sessionFile, usernameEnv: "PROTONMAIL_USERNAME", passwordEnv: "PROTONMAIL_PASSWORD", subject, bodyText: body });

      messageId = await findGeneratedMessageId(client, subject, prefix);
      const createdFolder = await client.createLabel(folderName, "#008a00", LabelType.FOLDER);
      folderId = String(/** @type {Record<string, unknown>} */ (createdFolder || {}).ID || "");
      assert.ok(folderId, "created folder must include an ID");

      await assertCliAction(["mail", "archive", messageId], Labels.ARCHIVE, messageId);
      await assertCliAction(["mail", "unarchive", messageId], Labels.INBOX, messageId);
      await assertCliAction(["mail", "star", messageId], Labels.STARRED, messageId);
      runPmJson(["mail", "unstar", messageId], { PROTONMAIL_REST_SESSION_FILE: process.env.PROTONMAIL_REST_SESSION_FILE || "" });
      await assertMessageNotInLabel(client, messageId, Labels.STARRED);
      await assertCliAction(["mail", "spam", messageId], Labels.SPAM, messageId);
      await assertCliAction(["mail", "not-spam", messageId], Labels.INBOX, messageId);
      await assertCliAction(["mail", "move-to-folder", "--folder", folderName, messageId], folderId, messageId);
    } finally {
      await closeLivePage(secondaryRuntime);
      if (messageId) {
        await ignoreCleanupError(client.unlabelMessages([messageId], Labels.STARRED));
        await ignoreCleanupError(client.labelMessages([messageId], Labels.TRASH));
        await ignoreCleanupError(client.deleteMessages([messageId]));
      }
      if (folderId) await ignoreCleanupError(client.deleteLabel(folderId));
      cleanupTmpDir(primarySession.tmpDir);
      cleanupTmpDir(secondarySession.tmpDir);
    }
  });
});

async function assertCliAction(args, labelId, messageId) {
  const result = runPmJson(args, { PROTONMAIL_REST_SESSION_FILE: process.env.PROTONMAIL_REST_SESSION_FILE || "" });
  assert.equal(result.ok, true, redact(JSON.stringify(result.error || result)));
  assert.equal(result.data.source, "rest");
  assert.deepEqual(result.data.affected, [messageId]);
  await assertMessageInLabel(createRestClient(), messageId, labelId);
}

async function findGeneratedMessageId(client, subject, prefix) {
  const metadata = await client.getMessageMetadata({ Subject: subject }, 0, 10);
  const target = metadata.messages.find((message) => {
    const item = message && typeof message === "object" ? /** @type {Record<string, unknown>} */ (message) : {};
    return typeof item.ID === "string" && String(item.Subject || "").includes(prefix);
  });
  assert.ok(target, `generated message not visible in REST metadata: ${redact(subject)}`);
  return String(/** @type {Record<string, unknown>} */ (target).ID);
}

async function assertMessageInLabel(client, messageId, labelId) {
  const result = await client.getMessageMetadata({ LabelID: labelId }, 0, 20);
  assert.ok(result.messages.some((message) => message && typeof message === "object" && /** @type {Record<string, unknown>} */ (message).ID === messageId), `message ${messageId} missing label ${labelId}`);
}

async function assertMessageNotInLabel(client, messageId, labelId) {
  const result = await client.getMessageMetadata({ LabelID: labelId }, 0, 20);
  assert.equal(result.messages.some((message) => message && typeof message === "object" && /** @type {Record<string, unknown>} */ (message).ID === messageId), false, `message ${messageId} still has label ${labelId}`);
}

async function ignoreCleanupError(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error || error !== undefined);
  }
}
