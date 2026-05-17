#!/usr/bin/env node
import { ProtonMailBrowserClient } from "../src/browser-client.js";
import { ProtonMailClient } from "../src/client.js";
import { runPmCli } from "../src/cli.js";
import { Labels, LabelType, MAX_BATCH_IDS } from "../src/constants.js";
import { filterMailMessages, parseBrowserMessageRef } from "../src/mail-runner.js";
import { FileSessionStore } from "../src/rest-session-store.js";
import { runUpdate, UpdateError } from "../src/update.js";

const exitCode = await runPmCli({
  argv: process.argv.slice(2),
  clients: {
    mail: {
      list: listMailFromBrowser,
      latest: latestMailFromBrowser,
      search: searchMailFromBrowser,
      read: readMailFromBrowser,
      action: runMailActionFromRest,
    },
    update: {
      run: runUpdateFromRelease,
    },
    labels: {
      list: listLabelsFromRest,
      create: createLabelFromRest,
      update: updateLabelFromRest,
      delete: deleteLabelFromRest,
    },
  },
});
process.exitCode = exitCode;

async function listMailFromBrowser(options) {
  if (options.metadataFilter) return listMailFromRest(options);
  const client = browserClient(options);
  const result = await client.getInboxMessages(browserOptions(options));
  return { ...result, source: "browser" };
}

async function listMailFromRest(options) {
  if (!options.restSessionFile) {
    return {
      success: false,
      source: "rest",
      error: "REST metadata filters require PROTONMAIL_REST_SESSION_FILE or restSessionFile in config",
    };
  }
  const client = new ProtonMailClient({
    sessionStore: new FileSessionStore(options.restSessionFile),
    timeoutMs: options.timeout ? options.timeout * 1000 : undefined,
  });
  const result = await client.getMessageMetadata(options.metadataFilter, 0, options.limit || undefined);
  return {
    success: true,
    source: "rest",
    total: result.total,
    stale: result.stale,
    messages: result.messages,
  };
}

async function latestMailFromBrowser(options) {
  const client = browserClient(options);
  const result = await client.getLatestMessage(browserOptions(options));
  return { ...result, source: "browser" };
}

async function searchMailFromBrowser(options) {
  const client = browserClient(options);
  const result = await client.getInboxMessages(browserOptions(options));
  if (result?.success === false) return { ...result, source: "browser" };

  const messages = Array.isArray(result?.messages) ? filterMailMessages(result.messages, options.matchText) : [];
  return {
    ...result,
    source: "browser",
    messages,
  };
}

async function readMailFromBrowser(messageRef, options) {
  const index = parseBrowserMessageRef(messageRef);
  if (index === null) {
    return {
      success: false,
      error: "pm read currently supports browser:index:N refs emitted by pm ls and pm mail search",
    };
  }

  const client = browserClient(options);
  const result = await client.getLatestMessage({
    ...browserOptions(options),
    matchText: (message) => message.index === index,
  });
  return { ...result, source: "browser" };
}

async function runMailActionFromRest(options) {
  if (!options.restSessionFile) {
    return {
      success: false,
      status: "rest_session_missing",
      source: "rest",
      action: options.action,
      dryRun: options.dryRun,
      requested: 0,
      affected: [],
      skipped: [],
      failed: [],
      error: "REST mail actions require PROTONMAIL_REST_SESSION_FILE or restSessionFile in config",
    };
  }

  const client = restClient(options);
  const skipped = Array.isArray(options.skipped) ? [...options.skipped] : [];
  let ids = Array.isArray(options.ids) ? [...options.ids] : [];

  if (options.fromSearch) {
    const result = await client.getMessageMetadata(options.metadataFilter || {}, 0, options.limit || undefined);
    ids = normalizeActionIds(result.messages
      .map((message) => message && typeof message === "object" ? /** @type {Record<string, unknown>} */ (message).ID : "")
      .filter((id) => typeof id === "string" && id.length > 0));
  }

  if (options.dryRun) {
    return {
      success: true,
      status: "dry_run",
      source: "rest",
      action: options.action,
      labelId: options.labelId,
      dryRun: true,
      requested: ids.length + skipped.length,
      affected: [],
      skipped: [...skipped, ...ids.map((id) => ({ id, reason: "dry_run" }))],
      failed: [],
    };
  }

  const affected = [];
  const failed = [];
  for (const chunk of chunks(ids, MAX_BATCH_IDS)) {
    try {
      const responses = await applyMailActionChunk(client, options, chunk);
      const upstreamFailures = actionFailuresFromResponses(responses);
      if (upstreamFailures.length > 0) {
        const failedIds = new Set(upstreamFailures.map((failure) => failure.id));
        affected.push(...chunk.filter((id) => !failedIds.has(id)));
        failed.push(...upstreamFailures);
      } else {
        affected.push(...chunk);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push(...chunk.map((id) => ({ id, code: "MAIL_ACTION_FAILED", message })));
    }
  }

  return {
    success: failed.length === 0,
    status: failed.length > 0 ? "partial_failure" : "applied",
    source: "rest",
    action: options.action,
    labelId: options.labelId,
    dryRun: false,
    requested: ids.length + skipped.length,
    affected,
    skipped,
    failed,
  };
}

function restClient(options) {
  return new ProtonMailClient({
    sessionStore: new FileSessionStore(options.restSessionFile),
    timeoutMs: options.timeout ? options.timeout * 1000 : undefined,
  });
}

function missingRestLabelResult(options) {
  return {
    success: false,
    status: "rest_session_missing",
    source: "rest",
    entity: options.entity,
    error: `${options.entity} commands require PROTONMAIL_REST_SESSION_FILE or restSessionFile in config`,
  };
}

async function listLabelsFromRest(options) {
  if (!options.restSessionFile) return missingRestLabelResult(options);
  const labels = await restClient(options).getLabels([labelType(options)]);
  return { success: true, source: "rest", entity: options.entity, labels };
}

async function createLabelFromRest(options) {
  if (!options.restSessionFile) return missingRestLabelResult(options);
  const label = await restClient(options).createLabel(options.name, options.color || "#6d4aff", labelType(options), options.parentId || undefined);
  return { success: true, source: "rest", entity: options.entity, action: "create", label };
}

async function updateLabelFromRest(options) {
  if (!options.restSessionFile) return missingRestLabelResult(options);
  const client = restClient(options);
  const current = await findLabelById(client, options);
  if (!current) return { success: false, status: "not_found", source: "rest", entity: options.entity, id: options.id, error: `${options.entity} was not found` };
  const label = await client.updateLabel(
    options.id,
    options.name || current.Name || current.name || "",
    options.color || current.Color || current.color || "#6d4aff",
    options.parentId || current.ParentID || current.parentId || undefined
  );
  return { success: true, source: "rest", entity: options.entity, action: "update", id: options.id, label };
}

async function deleteLabelFromRest(options) {
  if (!options.restSessionFile) return missingRestLabelResult(options);
  await restClient(options).deleteLabel(options.id);
  return { success: true, source: "rest", entity: options.entity, action: "delete", id: options.id, deleted: true };
}

async function findLabelById(client, options) {
  const labels = await client.getLabels([labelType(options)]);
  return labels.find((label) => label && typeof label === "object" && String(label.ID || label.id || "") === options.id);
}

function labelType(options) {
  return options.entity === "folder" ? LabelType.FOLDER : LabelType.LABEL;
}

async function applyMailActionChunk(client, options, ids) {
  if (options.action === "mark-read") return client.markMessagesRead(ids);
  if (options.action === "mark-unread") return client.markMessagesUnread(ids);
  if (options.action === "label") return client.labelMessages(ids, options.labelId);
  if (options.action === "unlabel") return client.unlabelMessages(ids, options.labelId);
  if (options.action === "trash") return client.labelMessages(ids, Labels.TRASH);
  if (options.action === "delete") return client.deleteMessages(ids);
  throw new Error(`Unknown mail action: ${options.action}`);
}

function normalizeActionIds(values) {
  const seen = new Set();
  const ids = [];
  for (const value of values) {
    const id = String(value || "").trim();
    if (!id || /^browser:index:/u.test(id) || /[\s\u0000-\u001f]/u.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function actionFailuresFromResponses(responses) {
  const failures = [];
  for (const response of Array.isArray(responses) ? responses : [responses]) {
    const candidates = Array.isArray(response?.Responses)
      ? response.Responses
      : Array.isArray(response?.responses)
        ? response.responses
        : [];
    for (const candidate of candidates) {
      const id = candidate?.ID || candidate?.id;
      const payload = candidate?.Response || candidate?.response || candidate;
      const code = payload?.Code ?? payload?.code;
      if (!id || code === undefined || code === 1000) continue;
      failures.push({
        id: String(id),
        code: String(code),
        message: String(payload?.Error || payload?.error || "Proton Mail action failed"),
      });
    }
  }
  return failures;
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function browserClient(options) {
  return new ProtonMailBrowserClient({
    headless: true,
    sessionFile: options.session,
    timeoutSeconds: options.timeout || undefined,
  });
}

function browserOptions(options) {
  return {
    headless: true,
    timeoutSeconds: options.timeout || undefined,
    matchText: options.matchText,
    folder: options.folder,
    limit: options.limit,
  };
}

async function runUpdateFromRelease(options) {
  try {
    return await runUpdate(options);
  } catch (error) {
    if (error instanceof UpdateError) {
      return {
        success: false,
        status: updateStatus(error.code),
        error: error.message,
      };
    }
    throw error;
  }
}

function updateStatus(code) {
  if (code === "UNSUPPORTED_INSTALL_MODE") return "unsupported_install_mode";
  if (code === "INVALID_UPDATE_TAG") return "invalid_tag";
  if (code === "INVALID_REPO") return "invalid_repo";
  if (code === "MISSING_CHECKSUMS") return "missing_checksums";
  if (code === "UNSUPPORTED_RELEASE_ASSETS") return "unsupported_release_assets";
  if (code === "RELEASE_METADATA_FAILED" || code === "INVALID_RELEASE_METADATA") return "release_metadata_failed";
  if (code === "RELEASE_ASSET_DOWNLOAD_FAILED") return "release_asset_download_failed";
  if (code === "UPDATE_COMMAND_FAILED") return "install_failed";
  if (code === "CHECKSUM_FAILED") return "checksum_failed";
  return "failed";
}
