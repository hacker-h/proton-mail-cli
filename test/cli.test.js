import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CLI_EXIT, parseArgv, runPmCli } from "../src/index.js";

describe("pm CLI runner", () => {
  it("prints human help for pm help and includes root examples", async () => {
    const io = createIo();

    const exitCode = await runPmCli({ argv: ["help"], version: "9.9.9", ...io });

    assert.equal(exitCode, CLI_EXIT.OK);
    assert.match(io.stdoutText(), /pm 9\.9\.9/u);
    assert.match(io.stdoutText(), /pm ls/u);
    assert.match(io.stdoutText(), /pm mail latest/u);
    assert.match(io.stdoutText(), /pm mail search --match <text>/u);
    assert.match(io.stdoutText(), /pm read <messageId>/u);
    assert.match(io.stdoutText(), /pm mail mark-read <messageId...>/u);
    assert.match(io.stdoutText(), /pm doctor config --json/u);
    assert.equal(io.stderrText(), "");
  });

  it("prints JSON help for --json --help", async () => {
    const io = createIo();

    const exitCode = await runPmCli({ argv: ["--json", "--help"], version: "1.2.3", ...io });

    const envelope = JSON.parse(io.stdoutText());
    assert.equal(exitCode, CLI_EXIT.OK);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.command, "help");
    assert.equal(envelope.meta.envelope, "pm.v1");
    assert.match(envelope.data.usage, /pm ls/u);
    assert.equal(io.stderrText(), "");
  });

  it("supports pm version and --version", async () => {
    const command = createIo();
    const flag = createIo();

    assert.equal(await runPmCli({ argv: ["version"], version: "1.2.3", ...command }), CLI_EXIT.OK);
    assert.equal(await runPmCli({ argv: ["--version"], version: "1.2.3", ...flag }), CLI_EXIT.OK);

    assert.equal(command.stdoutText(), "pm 1.2.3\n");
    assert.equal(flag.stdoutText(), "pm 1.2.3\n");
  });

  it("normalizes aliases and global flags", () => {
    assert.deepEqual(parseArgv(["ls"]).command, "mail:list");
    assert.deepEqual(parseArgv(["list"]).command, "mail:list");
    assert.deepEqual(parseArgv(["inbox"]).command, "mail:list");
    assert.deepEqual(parseArgv(["mail", "list"]).command, "mail:list");
    assert.deepEqual(parseArgv(["mail", "search", "--match", "github"]).command, "mail:search");
    assert.deepEqual(parseArgv(["read", "msg1"]).command, "mail:read");
    assert.deepEqual(parseArgv(["doctor", "config"]).command, "doctor:config");
    assert.deepEqual(parseArgv(["doctor", "auth"]).command, "doctor:session");
    assert.deepEqual(parseArgv(["update"]).command, "update");
    assert.deepEqual(parseArgv(["update", "--version", "2.2.1"]).args, ["--version", "2.2.1"]);
    assert.deepEqual(parseArgv(["self-update"]).command, "update");
    assert.equal(parseArgv(["mail", "mark-read", "msg1"]).command, "mail:mark-read");

    const parsed = parseArgv([
      "mail",
      "latest",
      "--json",
      "--timeout",
      "15",
      "--config=config.json",
      "--session",
      "session.json",
      "--verbose",
    ]);

    assert.equal(parsed.command, "mail:latest");
    assert.equal(parsed.global.format, "json");
    assert.equal(parsed.global.timeout, 15);
    assert.equal(parsed.global.config, "config.json");
    assert.equal(parsed.global.session, "session.json");
    assert.equal(parsed.global.verbose, true);

    const tableParsed = parseArgv(["ls", "--format", "table"]);
    assert.equal(tableParsed.global.format, "table");
    assert.throws(() => parseArgv(["ls", "--format", "csv"]), {
      code: "INVALID_FORMAT",
      exitCode: CLI_EXIT.USAGE,
    });
  });

  it("dispatches pm ls with injected clients", async () => {
    const io = createIo();
    const list = mock.fn(async (options) => ({
      messages: [{ id: "msg1", subject: "Hello" }],
      options,
    }));
    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "pm-config-home-"));

    let exitCode;
    await withEnv({ XDG_CONFIG_HOME: configHome }, async () => {
      exitCode = await runPmCli({
        argv: ["ls", "--timeout", "20", "--session", "session.json", "--format", "table"],
        clients: { mail: { list } },
        ...io,
      });
    });

    assert.equal(exitCode, CLI_EXIT.OK);
    assert.equal(io.stdoutText(), "msg1\tHello\n");
    assert.equal(list.mock.callCount(), 1);
    assert.deepEqual(list.mock.calls[0].arguments[0], {
      timeout: 20,
      config: path.join(configHome, "proton-mail-cli", "config.json"),
      session: path.resolve("session.json"),
      restSessionFile: "",
      quiet: false,
      verbose: false,
      format: "table",
    });
  });

  it("passes mail list filters to injected clients", async () => {
    const io = createIo();
    const list = mock.fn(async () => ({
      success: true,
      source: "browser",
      messages: [{ index: 0, preview: "GitHub verification" }],
    }));

    const exitCode = await runPmCli({
      argv: ["ls", "--match", "/github/i", "--folder", "all-mail", "--limit", "3", "--require-match", "--json"],
      clients: { mail: { list } },
      ...io,
    });

    assert.equal(exitCode, CLI_EXIT.OK);
    const envelope = JSON.parse(io.stdoutText());
    assert.equal(envelope.data.status, "matched");
    assert.equal(envelope.data.source, "browser");
    assert.equal(envelope.data.count, 1);
    assert.deepEqual(envelope.data.messages, [{ ref: "browser:index:0", index: 0, preview: "GitHub verification" }]);
    const options = list.mock.calls[0].arguments[0];
    assert.equal(options.matchText instanceof RegExp, true);
    assert.equal(options.matchText.test("GitHub"), true);
    assert.equal(options.folder, "all-mail");
    assert.equal(options.limit, 3);
    assert.equal(options.requireMatch, true);
  });

  it("passes REST metadata filters to injected mail clients", async () => {
    const io = createIo();
    const list = mock.fn(async () => ({ success: true, source: "rest", messages: [] }));

    const exitCode = await runPmCli({
      argv: [
        "ls",
        "--subject",
        "Invoice",
        "--from",
        "billing@example.test",
        "--to",
        "ops@example.test",
        "--label",
        "0",
        "--unread",
        "--after",
        "2024-01-01T00:00:00Z",
        "--before",
        "1704153600",
        "--json",
      ],
      clients: { mail: { list } },
      ...io,
    });

    assert.equal(exitCode, CLI_EXIT.OK);
    const options = list.mock.calls[0].arguments[0];
    assert.equal(options.subject, "Invoice");
    assert.equal(options.from, "billing@example.test");
    assert.equal(options.to, "ops@example.test");
    assert.equal(options.labelId, "0");
    assert.equal(options.unread, true);
    assert.deepEqual(options.metadataFilter, {
      Subject: "Invoice",
      From: "billing@example.test",
      To: "ops@example.test",
      LabelID: "0",
      Unread: 1,
      Begin: 1704067200,
      End: 1704153600,
    });
  });

  it("returns empty mail list results unless --require-match is set", async () => {
    const relaxed = createIo();
    const required = createIo();
    const list = mock.fn(async () => ({ success: true, source: "browser", messages: [] }));

    assert.equal(await runPmCli({ argv: ["ls", "--json"], clients: { mail: { list } }, ...relaxed }), CLI_EXIT.OK);
    const relaxedEnvelope = JSON.parse(relaxed.stdoutText());
    assert.equal(relaxedEnvelope.data.status, "no_match");
    assert.equal(relaxedEnvelope.data.count, 0);
    assert.deepEqual(relaxedEnvelope.data.messages, []);

    assert.equal(await runPmCli({ argv: ["ls", "--require-match", "--json"], clients: { mail: { list } }, ...required }), CLI_EXIT.USAGE);
    const requiredEnvelope = JSON.parse(required.stderrText());
    assert.equal(requiredEnvelope.error.code, "NO_MATCH");
  });

  it("passes env session and timeout values to normal mail dispatch", async () => {
    const io = createIo();
    const list = mock.fn(async (options) => ({ messages: [], options }));

    await withEnv({
      XDG_CONFIG_HOME: "/tmp/pm-config-home",
      XDG_CACHE_HOME: "/tmp/pm-cache-home",
      PROTONMAIL_CONFIG_FILE: undefined,
      PROTONMAIL_SESSION_FILE: "/env/session.json",
      PROTONMAIL_TIMEOUT_SECONDS: "42",
    }, async () => {
      const exitCode = await runPmCli({ argv: ["ls"], clients: { mail: { list } }, ...io });

      assert.equal(exitCode, CLI_EXIT.OK);
    });

    assert.equal(list.mock.callCount(), 1);
    assert.deepEqual(list.mock.calls[0].arguments[0], {
      timeout: 42,
      config: path.join("/tmp/pm-config-home", "proton-mail-cli", "config.json"),
      session: "/env/session.json",
      restSessionFile: "",
      quiet: false,
      verbose: false,
      format: "human",
    });
  });

  it("passes config-file session and timeout values to normal mail dispatch", async () => {
    const io = createIo();
    const list = mock.fn(async (options) => ({ messages: [], options }));
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-cli-config-"));
    const configPath = path.join(tempDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ sessionFile: "/config/session.json", timeoutSeconds: 33 }));

    await withEnv({
      XDG_CONFIG_HOME: "/tmp/pm-config-home",
      XDG_CACHE_HOME: "/tmp/pm-cache-home",
      PROTONMAIL_CONFIG_FILE: undefined,
      PROTONMAIL_SESSION_FILE: undefined,
      PROTONMAIL_TIMEOUT_SECONDS: undefined,
    }, async () => {
      const exitCode = await runPmCli({ argv: ["ls", "--config", configPath], clients: { mail: { list } }, ...io });

      assert.equal(exitCode, CLI_EXIT.OK);
    });

    assert.equal(list.mock.callCount(), 1);
    assert.deepEqual(list.mock.calls[0].arguments[0], {
      timeout: 33,
      config: configPath,
      session: "/config/session.json",
      restSessionFile: "",
      quiet: false,
      verbose: false,
      format: "human",
    });
  });

  it("dispatches mail latest, read, and action commands with JSON envelopes", async () => {
    const latestIo = createIo();
    const readIo = createIo();
    const actionIo = createIo();
    const latest = mock.fn(async () => ({ message: { subject: "Latest" } }));
    const read = mock.fn(async (messageId) => ({ message: { id: messageId, subject: "Read", bodyText: "Body" } }));
    const action = mock.fn(async () => ({ success: true, source: "rest", action: "mark-read", affected: ["msg42"], skipped: [], failed: [] }));

    assert.equal(await runPmCli({ argv: ["mail", "latest", "--json"], clients: { mail: { latest } }, ...latestIo }), CLI_EXIT.OK);
    assert.equal(await runPmCli({ argv: ["read", "msg42", "--json"], clients: { mail: { read } }, ...readIo }), CLI_EXIT.OK);
    assert.equal(await runPmCli({ argv: ["mail", "mark-read", "msg42", "--json"], clients: { mail: { action } }, ...actionIo }), CLI_EXIT.OK);

    assert.equal(JSON.parse(latestIo.stdoutText()).command, "mail:latest");
    assert.equal(JSON.parse(readIo.stdoutText()).data.message.id, "msg42");
    assert.equal(JSON.parse(actionIo.stdoutText()).data.action, "mark-read");
    assert.equal(read.mock.calls[0].arguments[0], "msg42");
  });

  it("passes config, session, and timeout to mail read clients", async () => {
    const io = createIo();
    const read = mock.fn(async (messageId) => ({ message: { id: messageId, subject: "Read", bodyText: "Body" } }));
    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "pm-config-home-"));

    let exitCode;
    await withEnv({ XDG_CONFIG_HOME: configHome }, async () => {
      exitCode = await runPmCli({
        argv: ["read", "browser:index:2", "--timeout", "21", "--session", "session.json", "--json"],
        clients: { mail: { read } },
        ...io,
      });
    });

    assert.equal(exitCode, CLI_EXIT.OK);
    assert.equal(read.mock.calls[0].arguments[0], "browser:index:2");
    assert.deepEqual(read.mock.calls[0].arguments[1], {
      timeout: 21,
      config: path.join(configHome, "proton-mail-cli", "config.json"),
      session: path.resolve("session.json"),
      restSessionFile: "",
      quiet: false,
      verbose: false,
      format: "json",
    });
  });

  it("normalizes read results and preserves explicit body output", async () => {
    const io = createIo();
    const read = mock.fn(async () => ({
      success: true,
      source: "browser",
      message: {
        index: 2,
        subject: "Read subject",
        preview: "Preview line",
        bodyText: "Full body text",
      },
      debugEvents: [{ message: "selector detail" }],
    }));

    assert.equal(await runPmCli({ argv: ["read", "browser:index:2", "--json"], clients: { mail: { read } }, ...io }), CLI_EXIT.OK);
    const envelopeText = io.stdoutText();
    const envelope = JSON.parse(envelopeText);
    assert.deepEqual(envelope.data.message, {
      ref: "browser:index:2",
      index: 2,
      subject: "Read subject",
      preview: "Preview line",
      bodyText: "Full body text",
    });
    assert.equal(envelopeText.includes("debugEvents"), false);
    assert.equal(read.mock.calls[0].arguments[0], "browser:index:2");
  });

  it("prints read bodies in human mode", async () => {
    const io = createIo();
    const read = mock.fn(async () => ({ message: { subject: "Read subject", bodyText: "Full body text" } }));

    assert.equal(await runPmCli({ argv: ["read", "browser:index:2"], clients: { mail: { read } }, ...io }), CLI_EXIT.OK);
    assert.equal(io.stdoutText(), "Full body text\n");
    assert.equal(io.stderrText(), "");
  });

  it("returns structured read failures", async () => {
    const io = createIo();
    const read = mock.fn(async () => ({ success: false, error: "No matching Proton Mail message found user@example.com" }));

    assert.equal(await runPmCli({ argv: ["read", "browser:index:99", "--json"], clients: { mail: { read } }, ...io }), CLI_EXIT.USAGE);
    const envelopeText = io.stderrText();
    const envelope = JSON.parse(envelopeText);
    assert.equal(envelope.error.code, "NO_MATCH");
    assert.equal(envelopeText.includes("user@example.com"), false);
  });

  it("normalizes mail latest results and omits message bodies", async () => {
    const io = createIo();
    const latest = mock.fn(async () => ({
      success: true,
      source: "browser",
      message: {
        index: 0,
        subject: "Latest subject",
        preview: "Preview line",
        bodyText: "Private body",
      },
      debugEvents: [{ message: "selector detail" }],
    }));

    assert.equal(await runPmCli({ argv: ["mail", "latest", "--match", "Preview", "--json"], clients: { mail: { latest } }, ...io }), CLI_EXIT.OK);
    const envelopeText = io.stdoutText();
    const envelope = JSON.parse(envelopeText);
    assert.equal(envelope.data.status, "matched");
    assert.deepEqual(envelope.data.message, {
      ref: "browser:index:0",
      index: 0,
      subject: "Latest subject",
      preview: "Preview line",
    });
    assert.equal(envelopeText.includes("Private body"), false);
    assert.equal(envelopeText.includes("debugEvents"), false);
    assert.equal(latest.mock.calls[0].arguments[0].matchText, "Preview");
  });

  it("dispatches mail search with required match filters", async () => {
    const io = createIo();
    const search = mock.fn(async () => ({
      success: true,
      source: "browser",
      messages: [
        { index: 1, preview: "GitHub sign-in link" },
      ],
    }));

    assert.equal(await runPmCli({
      argv: ["mail", "search", "--match", "github", "--folder", "all-mail", "--limit", "4", "--json"],
      clients: { mail: { search } },
      ...io,
    }), CLI_EXIT.OK);

    const envelope = JSON.parse(io.stdoutText());
    assert.equal(envelope.command, "mail:search");
    assert.equal(envelope.data.status, "matched");
    assert.equal(envelope.data.count, 1);
    assert.deepEqual(envelope.data.messages, [{ ref: "browser:index:1", index: 1, preview: "GitHub sign-in link" }]);
    const options = search.mock.calls[0].arguments[0];
    assert.equal(options.matchText, "github");
    assert.equal(options.folder, "all-mail");
    assert.equal(options.limit, 4);
  });

  it("requires --match for mail search", async () => {
    const io = createIo();
    const search = mock.fn(async () => ({ messages: [] }));

    assert.equal(await runPmCli({ argv: ["mail", "search", "--json"], clients: { mail: { search } }, ...io }), CLI_EXIT.USAGE);
    const envelope = JSON.parse(io.stderrText());
    assert.equal(envelope.error.code, "MISSING_MATCH");
    assert.equal(search.mock.callCount(), 0);
  });

  it("classifies mail latest no-match and redacts relaxed failures", async () => {
    const relaxed = createIo();
    const required = createIo();
    const latest = mock.fn(async () => ({ success: false, error: "No matching Proton Mail message found user@example.com password=abc" }));

    assert.equal(await runPmCli({ argv: ["mail", "latest", "--json"], clients: { mail: { latest } }, ...relaxed }), CLI_EXIT.OK);
    const relaxedText = relaxed.stdoutText();
    const relaxedEnvelope = JSON.parse(relaxedText);
    assert.equal(relaxedEnvelope.data.status, "no_match");
    assert.equal(relaxedText.includes("user@example.com"), false);
    assert.equal(relaxedText.includes("abc"), false);

    assert.equal(await runPmCli({ argv: ["mail", "latest", "--require-match", "--json"], clients: { mail: { latest } }, ...required }), CLI_EXIT.USAGE);
    assert.equal(JSON.parse(required.stderrText()).error.code, "NO_MATCH");
  });

  it("keeps safe REST metadata fields in mail list output", async () => {
    const io = createIo();
    const list = mock.fn(async () => ({
      success: true,
      source: "rest",
      messages: [{
        ID: "m1",
        Subject: "Invoice",
        Sender: { Name: "Billing", Address: "billing@example.test" },
        Time: 1704067200,
        Unread: 1,
        LabelIDs: ["0"],
        Body: "Encrypted body should not be listed",
      }],
    }));

    assert.equal(await runPmCli({ argv: ["ls", "--json"], clients: { mail: { list } }, ...io }), CLI_EXIT.OK);
    const envelopeText = io.stdoutText();
    const envelope = JSON.parse(envelopeText);
    assert.deepEqual(envelope.data.messages, [{
      ID: "m1",
      Subject: "Invoice",
      Sender: { Name: "Billing", Address: "billing@example.test" },
      Time: 1704067200,
      Unread: 1,
      LabelIDs: ["0"],
    }]);
    assert.equal(envelopeText.includes("Encrypted body"), false);
  });

  it("rejects invalid mail command flags before dispatch", async () => {
    const invalidLimit = createIo();
    const conflictingState = createIo();
    const invalidDate = createIo();
    const unknown = createIo();
    const list = mock.fn(async () => ({ messages: [] }));

    assert.equal(await runPmCli({ argv: ["ls", "--limit", "many", "--json"], clients: { mail: { list } }, ...invalidLimit }), CLI_EXIT.USAGE);
    assert.equal(JSON.parse(invalidLimit.stderrText()).error.code, "INVALID_LIMIT");

    assert.equal(await runPmCli({ argv: ["mail", "latest", "--unknown", "--json"], clients: { mail: { latest: list } }, ...unknown }), CLI_EXIT.USAGE);
    assert.equal(JSON.parse(unknown.stderrText()).error.code, "UNKNOWN_FLAG");

    assert.equal(await runPmCli({ argv: ["ls", "--read", "--unread", "--json"], clients: { mail: { list } }, ...conflictingState }), CLI_EXIT.USAGE);
    assert.equal(JSON.parse(conflictingState.stderrText()).error.code, "CONFLICTING_FLAGS");

    assert.equal(await runPmCli({ argv: ["ls", "--after", "soon", "--json"], clients: { mail: { list } }, ...invalidDate }), CLI_EXIT.USAGE);
    assert.equal(JSON.parse(invalidDate.stderrText()).error.code, "INVALID_DATE");
    assert.equal(list.mock.callCount(), 0);
  });


  it("passes explicit mail action IDs to injected clients", async () => {
    const io = createIo();
    const action = mock.fn(async (options) => ({
      success: true,
      source: "rest",
      action: options.action,
      affected: options.ids,
      skipped: options.skipped,
      failed: [],
    }));

    assert.equal(await runPmCli({
      argv: ["mail", "label", "--label", "10", "msg1", "msg1", "msg2", "--json"],
      clients: { mail: { action } },
      ...io,
    }), CLI_EXIT.OK);

    const options = action.mock.calls[0].arguments[0];
    assert.equal(options.action, "label");
    assert.equal(options.labelId, "10");
    assert.deepEqual(options.ids, ["msg1", "msg2"]);
    assert.deepEqual(options.skipped, [{ id: "msg1", reason: "duplicate" }]);
    const envelope = JSON.parse(io.stdoutText());
    assert.equal(envelope.data.status, "applied");
    assert.deepEqual(envelope.data.affected, ["msg1", "msg2"]);
    assert.deepEqual(envelope.data.skipped, [{ id: "msg1", reason: "duplicate" }]);
  });

  it("requires confirmation or dry-run for selection-based mail actions", async () => {
    const missing = createIo();
    const dryRun = createIo();
    const action = mock.fn(async (options) => ({
      success: true,
      source: "rest",
      action: options.action,
      dryRun: options.dryRun,
      requested: 1,
      affected: [],
      skipped: [{ id: "msg1", reason: "dry_run" }],
      failed: [],
    }));

    assert.equal(await runPmCli({ argv: ["mail", "mark-read", "--from-search", "--subject", "Invoice", "--json"], clients: { mail: { action } }, ...missing }), CLI_EXIT.USAGE);
    assert.equal(JSON.parse(missing.stderrText()).error.code, "CONFIRMATION_REQUIRED");

    assert.equal(await runPmCli({ argv: ["mail", "mark-read", "--from-search", "--subject", "Invoice", "--dry-run", "--json"], clients: { mail: { action } }, ...dryRun }), CLI_EXIT.OK);
    const options = action.mock.calls[0].arguments[0];
    assert.equal(options.fromSearch, true);
    assert.equal(options.dryRun, true);
    assert.deepEqual(options.metadataFilter, { Subject: "Invoice" });
    assert.equal(JSON.parse(dryRun.stdoutText()).data.status, "dry_run");
  });

  it("reports partial mail action failures deterministically", async () => {
    const io = createIo();
    const action = mock.fn(async () => ({
      success: false,
      source: "rest",
      action: "trash",
      affected: ["msg1"],
      skipped: [],
      failed: [{ id: "msg2", code: "MAIL_ACTION_FAILED", message: "user@example.com password=abc" }],
    }));

    assert.equal(await runPmCli({ argv: ["mail", "trash", "msg1", "msg2", "--json"], clients: { mail: { action } }, ...io }), CLI_EXIT.OK);
    const envelopeText = io.stdoutText();
    const envelope = JSON.parse(envelopeText);
    assert.equal(envelope.data.status, "partial_failure");
    assert.deepEqual(envelope.data.affected, ["msg1"]);
    assert.equal(envelope.data.failed[0].id, "msg2");
    assert.equal(envelopeText.includes("user@example.com"), false);
    assert.equal(envelopeText.includes("abc"), false);
  });


  it("normalizes upstream partial mail action responses", async () => {
    const io = createIo();
    const action = mock.fn(async () => ({
      success: false,
      source: "rest",
      action: "mark-read",
      affected: ["msg1"],
      failed: [{ id: "msg2", code: "2500", message: "Rejected" }],
    }));

    assert.equal(await runPmCli({ argv: ["mail", "mark-read", "msg1", "msg2", "--json"], clients: { mail: { action } }, ...io }), CLI_EXIT.OK);
    const envelope = JSON.parse(io.stdoutText());
    assert.equal(envelope.data.status, "partial_failure");
    assert.deepEqual(envelope.data.affected, ["msg1"]);
    assert.deepEqual(envelope.data.failed, [{ id: "msg2", code: "2500", message: "Rejected" }]);
  });

  it("rejects unsafe mail action selections before dispatch", async () => {
    const invalid = createIo();
    const missingLabel = createIo();
    const unsupportedMatch = createIo();
    const action = mock.fn(async () => ({ affected: [] }));

    assert.equal(await runPmCli({ argv: ["mail", "mark-read", "browser:index:0", "--json"], clients: { mail: { action } }, ...invalid }), CLI_EXIT.USAGE);
    assert.equal(JSON.parse(invalid.stderrText()).error.code, "INVALID_MESSAGE_ID");

    assert.equal(await runPmCli({ argv: ["mail", "label", "msg1", "--json"], clients: { mail: { action } }, ...missingLabel }), CLI_EXIT.USAGE);
    assert.equal(JSON.parse(missingLabel.stderrText()).error.code, "MISSING_LABEL");

    assert.equal(await runPmCli({ argv: ["mail", "trash", "--from-search", "--match", "github", "--dry-run", "--json"], clients: { mail: { action } }, ...unsupportedMatch }), CLI_EXIT.USAGE);
    assert.equal(JSON.parse(unsupportedMatch.stderrText()).error.code, "UNSUPPORTED_SEARCH_MATCH");
    assert.equal(action.mock.callCount(), 0);
  });

  it("returns a contract stub error without live clients", async () => {
    const human = createIo();
    const json = createIo();

    assert.equal(await runPmCli({ argv: ["ls"], ...human }), CLI_EXIT.UNAVAILABLE);
    assert.match(human.stderrText(), /CLI contract stub/u);
    assert.equal(human.stdoutText(), "");

    assert.equal(await runPmCli({ argv: ["ls", "--json"], ...json }), CLI_EXIT.UNAVAILABLE);
    const envelope = JSON.parse(json.stderrText());
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, "FEATURE_NOT_IMPLEMENTED");
    assert.equal(json.stdoutText(), "");
  });

  it("returns predictable usage errors", async () => {
    const unknown = createIo();
    const invalidFormat = createIo();
    const missingRead = createIo();

    assert.equal(await runPmCli({ argv: ["wat"], ...unknown }), CLI_EXIT.USAGE);
    assert.match(unknown.stderrText(), /Unknown command/u);

    assert.equal(await runPmCli({ argv: ["--json", "--format", "xml", "help"], ...invalidFormat }), CLI_EXIT.USAGE);
    assert.equal(JSON.parse(invalidFormat.stderrText()).error.code, "INVALID_FORMAT");

    assert.equal(await runPmCli({ argv: ["read", "--json"], ...missingRead }), CLI_EXIT.USAGE);
    assert.equal(JSON.parse(missingRead.stderrText()).error.code, "MISSING_MESSAGE_ID");
  });

  it("rejects unexpected positional arguments before dispatch", async () => {
    const listIo = createIo();
    const readIo = createIo();
    const list = mock.fn(async () => ({ messages: [] }));
    const read = mock.fn(async () => ({ id: "msg1" }));

    assert.equal(await runPmCli({ argv: ["ls", "extra", "--json"], clients: { mail: { list } }, ...listIo }), CLI_EXIT.USAGE);
    assert.equal(await runPmCli({ argv: ["read", "msg1", "extra", "--json"], clients: { mail: { read } }, ...readIo }), CLI_EXIT.USAGE);

    assert.equal(JSON.parse(listIo.stderrText()).error.code, "UNEXPECTED_ARGUMENT");
    assert.equal(JSON.parse(readIo.stderrText()).error.code, "UNEXPECTED_ARGUMENT");
    assert.equal(list.mock.callCount(), 0);
    assert.equal(read.mock.callCount(), 0);
  });

  it("honors quiet mode for human success output", async () => {
    const io = createIo();
    const list = mock.fn(async () => ({ messages: [{ id: "msg1", subject: "Hello" }] }));

    const exitCode = await runPmCli({ argv: ["ls", "--quiet"], clients: { mail: { list } }, ...io });

    assert.equal(exitCode, CLI_EXIT.OK);
    assert.equal(io.stdoutText(), "");
    assert.equal(io.stderrText(), "");
  });

  it("dispatches pm update with stable JSON output", async () => {
    const io = createIo();
    const update = mock.fn(async (options) => ({
      success: true,
      status: "dry_run",
      repo: options.repo,
      tag: "v2.2.1",
      requestedTag: options.tag,
      prefix: options.prefix,
      asset: "proton-mail-cli-2.2.1.tgz",
      pm: "/tmp/pm-prefix/bin/pm",
      dryRun: options.dryRun,
    }));

    const exitCode = await runPmCli({
      argv: ["update", "--tag", "2.2.1", "--prefix", "/tmp/pm-prefix", "--repo", "owner/repo", "--dry-run", "--json"],
      clients: { update: { run: update } },
      ...io,
    });

    assert.equal(exitCode, CLI_EXIT.OK);
    const envelope = JSON.parse(io.stdoutText());
    assert.equal(envelope.command, "update");
    assert.equal(envelope.data.status, "dry_run");
    assert.equal(envelope.data.repo, "owner/repo");
    assert.equal(envelope.data.requestedTag, "2.2.1");
    assert.equal(envelope.data.prefix, "/tmp/pm-prefix");
    assert.equal(update.mock.calls[0].arguments[0].dryRun, true);
    assert.equal(io.stderrText(), "");
  });

  it("returns stable update failures", async () => {
    const io = createIo();
    const update = mock.fn(async () => ({
      success: false,
      status: "unsupported_install_mode",
      error: "source checkout",
    }));

    const exitCode = await runPmCli({ argv: ["update", "--json"], clients: { update: { run: update } }, ...io });

    assert.equal(exitCode, CLI_EXIT.RUNTIME);
    const envelope = JSON.parse(io.stderrText());
    assert.equal(envelope.command, "update");
    assert.equal(envelope.error.code, "UNSUPPORTED_INSTALL_MODE");
  });

  it("runs doctor config and session commands with stable JSON statuses", async () => {
    const configIo = createIo();
    const sessionIo = createIo();

    assert.equal(await runPmCli({ argv: ["doctor", "config", "--json"], version: "1.2.3", ...configIo }), CLI_EXIT.OK);
    assert.equal(await runPmCli({ argv: ["doctor", "session", "--json"], version: "1.2.3", ...sessionIo }), CLI_EXIT.OK);

    const config = JSON.parse(configIo.stdoutText());
    const session = JSON.parse(sessionIo.stdoutText());
    assert.equal(config.command, "doctor:config");
    assert.equal(config.data.status, "ok");
    assert.equal(session.command, "doctor:session");
    assert.match(session.data.status, /missing_session|session_ready|session_unreadable/u);
  });

  it("redacts secret details in JSON errors", async () => {
    const io = createIo();
    const clients = {
      mail: {
        list: async () => {
          throw new Error("password=abc user@example.com");
        },
      },
    };

    assert.equal(await runPmCli({ argv: ["ls", "--json"], clients, ...io }), CLI_EXIT.RUNTIME);
    const envelope = JSON.parse(io.stderrText());
    assert.equal(JSON.stringify(envelope).includes("abc"), false);
    assert.equal(JSON.stringify(envelope).includes("user@example.com"), false);
  });
});

function createIo() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

async function withEnv(values, callback) {
  const previous = {};
  for (const key of Object.keys(values)) {
    previous[key] = process.env[key];
    const value = values[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await callback();
  } finally {
    for (const key of Object.keys(values)) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
