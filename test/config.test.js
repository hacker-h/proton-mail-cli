import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  defaultConfigFile,
  defaultSessionFilePath,
  doctorConfig,
  doctorSession,
  inspectSessionFile,
  redact,
  resolveCliConfig,
  resolveSecret,
} from "../src/index.js";

describe("CLI config resolution", () => {
  it("uses OS config and cache locations instead of repo-local data defaults", () => {
    const env = { XDG_CONFIG_HOME: "/tmp/config", XDG_CACHE_HOME: "/tmp/cache" };

    assert.equal(defaultConfigFile(env, "linux"), path.join("/tmp/config", "proton-mail-cli", "config.json"));
    assert.equal(defaultSessionFilePath(env, "linux"), path.join("/tmp/cache", "proton-mail-cli", "protonmail-auth.json"));
  });

  it("applies flag, env, config file, and default precedence", () => {
    const configPath = "/tmp/pm-config.json";
    const resolved = resolveCliConfig({
      global: { config: configPath, session: "/flag/session.json", timeout: 9 },
      env: {
        PROTONMAIL_SESSION_FILE: "/env/session.json",
        PROTONMAIL_TIMEOUT_SECONDS: "8",
        PROTONMAIL_USERNAME: "user@example.com",
        PROTONMAIL_PASSWORD_FILE: "/tmp/password",
      },
      exists: (filePath) => filePath === configPath || filePath === "/tmp/password",
      readFile: (filePath) => {
        if (filePath === configPath) return JSON.stringify({ sessionFile: "/config/session.json", timeoutSeconds: 7 });
        if (filePath === "/tmp/password") return "s3cr3t\n";
        throw new Error(`Unexpected path ${filePath}`);
      },
    });

    assert.equal(resolved.values.sessionFile, "/flag/session.json");
    assert.equal(resolved.values.timeout, 9);
    assert.equal(resolved.values.username, "user@example.com");
    assert.equal(resolved.values.password, "s3cr3t");
    assert.deepEqual(resolved.sources, {
      config: "flag",
      sessionFile: "flag",
      timeout: "flag",
      username: "env",
      password: "file",
    });
  });

  it("supports command-backed secrets after direct and file forms", () => {
    const runCommand = mock.fn(() => "from-command\n");
    const secret = resolveSecret("PROTONMAIL_PASSWORD", {
      env: { PROTONMAIL_PASSWORD_COMMAND: "security find-generic-password" },
      runCommand,
    });

    assert.deepEqual(secret, { value: "from-command", source: "command" });
    assert.equal(runCommand.mock.callCount(), 1);
  });

  it("reports missing secret files through doctor config", () => {
    const data = doctorConfig({}, {
      env: { PROTONMAIL_PASSWORD_FILE: "/no/such/file" },
      exists: () => false,
      readFile: () => {
        throw new Error("missing file");
      },
    });

    assert.equal(data.status, "config_error");
    assert.equal(data.credentials.password.configured, false);
    assert.equal(data.credentials.password.source, "file");
    assert.match(data.credentials.password.error, /missing file/u);
  });

  it("treats non-object JSON configs as config errors", () => {
    const data = doctorConfig({ config: "/tmp/config.json" }, {
      env: {},
      exists: () => true,
      readFile: () => "null",
    });

    assert.equal(data.status, "config_error");
    assert.equal(data.configFile.exists, true);
    assert.equal(data.configFile.loaded, false);
    assert.match(data.configFile.error, /JSON object/u);
  });

  it("redacts secret fields, tokens, email addresses, and message bodies", () => {
    const output = redact({
      username: "user@example.com",
      password: "secret",
      Authorization: "Bearer abc123",
      messageBody: "Your OTP is 123456",
      nested: { note: "contact user@example.com token=abc" },
    });

    assert.equal(output.username, "[email]");
    assert.equal(output.password, "[redacted]");
    assert.equal(output.Authorization, "[redacted]");
    assert.equal(output.messageBody, "[redacted]");
    assert.equal(output.nested.note, "contact [email] token=[redacted]");
  });
});

describe("doctor commands", () => {
  it("explains config readiness without leaking configured secrets", () => {
    const data = doctorConfig({}, {
      env: {
        XDG_CONFIG_HOME: "/tmp/config",
        XDG_CACHE_HOME: "/tmp/cache",
        PROTONMAIL_USERNAME: "user@example.com",
        PROTONMAIL_PASSWORD: "topsecret123",
      },
      exists: () => false,
    });

    assert.equal(data.status, "ok");
    assert.equal(data.credentials.username.configured, true);
    assert.equal(data.credentials.password.configured, true);
    assert.equal(JSON.stringify(data).includes("topsecret123"), false);
    assert.equal(JSON.stringify(data).includes("user@example.com"), false);
  });

  it("reports missing, readable, and unreadable saved sessions", () => {
    assert.equal(inspectSessionFile("/tmp/missing.json", { exists: () => false }).status, "missing_session");

    const ready = inspectSessionFile("/tmp/session.json", {
      exists: () => true,
      readFile: () => JSON.stringify({ cookies: [{ name: "AUTH" }], origins: [{}] }),
    });
    assert.equal(ready.status, "session_ready");
    assert.equal(ready.cookies, 1);

    const unreadable = inspectSessionFile("/tmp/session.json", { exists: () => true, readFile: () => "{" });
    assert.equal(unreadable.status, "session_unreadable");
  });

  it("normalizes injected auth doctor states", async () => {
    const baseOptions = {
      env: { XDG_CONFIG_HOME: "/tmp/config", XDG_CACHE_HOME: "/tmp/cache" },
      exists: () => false,
    };

    assert.equal((await doctorSession({}, { doctor: { session: async () => ({ sessionExpired: true }) } }, baseOptions)).status, "expired_session");
    assert.equal((await doctorSession({}, { doctor: { session: async () => ({ twoFactor: true, manualRequired: true }) } }, baseOptions)).status, "manual_required");
    assert.equal((await doctorSession({}, { doctor: { session: async () => ({ upstreamFailure: true, message: "503" }) } }, baseOptions)).status, "upstream_failure");
    assert.equal((await doctorSession({}, { doctor: { session: async () => ({ success: true, sessionValid: true }) } }, baseOptions)).status, "auth_ready");
  });
});
