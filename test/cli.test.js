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
    assert.match(io.stdoutText(), /pm read <messageId>/u);
    assert.match(io.stdoutText(), /pm otp --json/u);
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
    assert.deepEqual(parseArgv(["read", "msg1"]).command, "mail:read");
    assert.deepEqual(parseArgv(["doctor", "config"]).command, "doctor:config");
    assert.deepEqual(parseArgv(["doctor", "auth"]).command, "doctor:session");

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
    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "pm-config-home-"));

    let exitCode;
    await withEnv({ XDG_CONFIG_HOME: configHome }, async () => {
      exitCode = await runPmCli({
        argv: ["ls", "--timeout", "20", "--session", "session.json"],
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
      quiet: false,
      verbose: false,
      format: "human",
    });
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

  it("rejects unexpected positional arguments before dispatch", async () => {
    const listIo = createIo();
    const otpIo = createIo();
    const readIo = createIo();
    const list = mock.fn(async () => ({ messages: [] }));
    const get = mock.fn(async () => ({ code: "123456" }));
    const read = mock.fn(async () => ({ id: "msg1" }));

    assert.equal(await runPmCli({ argv: ["ls", "extra", "--json"], clients: { mail: { list } }, ...listIo }), CLI_EXIT.USAGE);
    assert.equal(await runPmCli({ argv: ["otp", "extra", "--json"], clients: { otp: { get } }, ...otpIo }), CLI_EXIT.USAGE);
    assert.equal(await runPmCli({ argv: ["read", "msg1", "extra", "--json"], clients: { mail: { read } }, ...readIo }), CLI_EXIT.USAGE);

    assert.equal(JSON.parse(listIo.stderrText()).error.code, "UNEXPECTED_ARGUMENT");
    assert.equal(JSON.parse(otpIo.stderrText()).error.code, "UNEXPECTED_ARGUMENT");
    assert.equal(JSON.parse(readIo.stderrText()).error.code, "UNEXPECTED_ARGUMENT");
    assert.equal(list.mock.callCount(), 0);
    assert.equal(get.mock.callCount(), 0);
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
