import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import { CLI_EXIT, parseArgv, runPmCli } from "../src/index.js";

describe("pm CLI runner", () => {
  it("prints human help for pm help and includes root examples", async () => {
    const io = createIo();

    const exitCode = await runPmCli({ argv: ["help"], version: "9.9.9", ...io });

    assert.equal(exitCode, CLI_EXIT.OK);
    assert.match(io.stdoutText(), /pm 9\.9\.9/u);
    assert.match(io.stdoutText(), /pm ls/u);
    assert.match(io.stdoutText(), /pm mail latest/u);
    assert.match(io.stdoutText(), /pm read <messageId>/u);
    assert.match(io.stdoutText(), /pm otp --json/u);
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
    assert.deepEqual(parseArgv(["read", "msg1"]).command, "mail:read");

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
  });

  it("dispatches pm ls with injected clients", async () => {
    const io = createIo();
    const list = mock.fn(async (options) => ({
      messages: [{ id: "msg1", subject: "Hello" }],
      options,
    }));

    const exitCode = await runPmCli({
      argv: ["ls", "--timeout", "20", "--session", "session.json"],
      clients: { mail: { list } },
      ...io,
    });

    assert.equal(exitCode, CLI_EXIT.OK);
    assert.equal(io.stdoutText(), "msg1\tHello\n");
    assert.equal(list.mock.callCount(), 1);
    assert.deepEqual(list.mock.calls[0].arguments[0], {
      timeout: 20,
      config: null,
      session: "session.json",
      quiet: false,
      verbose: false,
      format: "human",
    });
  });

  it("dispatches mail latest, read, and otp with JSON envelopes", async () => {
    const latestIo = createIo();
    const readIo = createIo();
    const otpIo = createIo();
    const latest = mock.fn(async () => ({ message: { subject: "Latest" } }));
    const read = mock.fn(async (messageId) => ({ id: messageId, subject: "Read" }));
    const get = mock.fn(async () => ({ code: "123456" }));

    assert.equal(await runPmCli({ argv: ["mail", "latest", "--json"], clients: { mail: { latest } }, ...latestIo }), CLI_EXIT.OK);
    assert.equal(await runPmCli({ argv: ["read", "msg42", "--json"], clients: { mail: { read } }, ...readIo }), CLI_EXIT.OK);
    assert.equal(await runPmCli({ argv: ["otp", "--json"], clients: { otp: { get } }, ...otpIo }), CLI_EXIT.OK);

    assert.equal(JSON.parse(latestIo.stdoutText()).command, "mail:latest");
    assert.equal(JSON.parse(readIo.stdoutText()).data.id, "msg42");
    assert.equal(JSON.parse(otpIo.stdoutText()).data.code, "123456");
    assert.equal(read.mock.calls[0].arguments[0], "msg42");
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

  it("honors quiet mode for human success output", async () => {
    const io = createIo();
    const list = mock.fn(async () => ({ messages: [{ id: "msg1", subject: "Hello" }] }));

    const exitCode = await runPmCli({ argv: ["ls", "--quiet"], clients: { mail: { list } }, ...io });

    assert.equal(exitCode, CLI_EXIT.OK);
    assert.equal(io.stdoutText(), "");
    assert.equal(io.stderrText(), "");
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
