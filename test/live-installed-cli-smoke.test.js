import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertInstalledPmPath,
  buildSmokeEnv,
  commandError,
  parsePackOutput,
  redact,
  runInstalledCliSmoke,
  searchNeedle,
} from "../scripts/live-installed-cli-smoke.mjs";

const tempDirs = [];

after(() => {
  for (const directory of tempDirs) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("installed live CLI smoke helpers", () => {
  it("parses npm pack JSON output", () => {
    const stdout = "npm notice\n[{\"filename\":\"proton-mail-cli-0.0.0.tgz\"}]\ntrailing notice\n";
    assert.equal(parsePackOutput(stdout), "proton-mail-cli-0.0.0.tgz");
  });

  it("rejects pm binaries outside the clean smoke app", () => {
    const directory = tempDir();
    const appDir = path.join(directory, "app");
    const root = path.join(directory, "workspace");
    const appPm = path.join(appDir, "node_modules", ".bin", "pm");
    const rootPm = path.join(root, "bin", "pm.js");
    fs.mkdirSync(path.dirname(appPm), { recursive: true });
    fs.mkdirSync(path.dirname(rootPm), { recursive: true });
    fs.writeFileSync(appPm, "#!/usr/bin/env node\n");
    fs.writeFileSync(rootPm, "#!/usr/bin/env node\n");

    assert.doesNotThrow(() => assertInstalledPmPath(appPm, { appDir, root }));
    assert.throws(() => assertInstalledPmPath(rootPm, { appDir, root }), /outside smoke app|workspace source/u);
  });

  it("builds a curated live env without source resolution overrides", () => {
    const env = buildSmokeEnv({
      homeDir: "/tmp/pm-home",
      sessionFile: "session.json",
      baseDir: "/tmp/workspace",
      env: {
        NODE_PATH: "/workspace/src",
        INIT_CWD: "/workspace",
        PROTONMAIL_USERNAME: "owner@example.com",
        PROTONMAIL_LIVE_HEADLESS: "0",
        PLAYWRIGHT_BROWSERS_PATH: "/runner/cache/ms-playwright",
      },
    });

    assert.equal(env.NODE_PATH, undefined);
    assert.equal(env.INIT_CWD, undefined);
    assert.equal(env.HOME, "/tmp/pm-home");
    assert.equal(env.XDG_CONFIG_HOME, path.join("/tmp/pm-home", ".config"));
    assert.equal(env.XDG_CACHE_HOME, path.join("/tmp/pm-home", ".cache"));
    assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, "/runner/cache/ms-playwright");
    assert.equal(env.PROTONMAIL_SESSION_FILE, path.join("/tmp/workspace", "session.json"));
    assert.equal(env.PROTONMAIL_LIVE_SESSION_FILE, path.join("/tmp/workspace", "session.json"));
    assert.equal(env.PROTONMAIL_CONFIG_FILE, path.join("/tmp/pm-home", "config.json"));
    assert.equal(env.PROTONMAIL_LIVE_HEADLESS, "0");
    assert.equal(env.PROTONMAIL_USERNAME, "owner@example.com");
  });

  it("preserves the runner Playwright browser cache outside the isolated home", () => {
    const env = buildSmokeEnv({
      homeDir: "/tmp/pm-home",
      baseDir: "/tmp/workspace",
      env: {
        HOME: "/runner/home",
        XDG_CACHE_HOME: "/runner/xdg-cache",
      },
    });

    assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, expectedDefaultPlaywrightBrowsersPath("/runner/home", "/runner/xdg-cache"));
    assert.equal(env.PLAYWRIGHT_BROWSERS_PATH.startsWith(env.HOME), false);
  });

  it("redacts command diagnostics", () => {
    const message = commandError("pm", ["mail", "search", "--match", "user@example.com"], {
      status: 1,
      stdout: "",
      stderr: "user@example.com password=abc session=secret Authorization: Bearer token bodyText=hello",
    });

    assert.equal(message.includes("user@example.com"), false);
    assert.equal(message.includes("abc"), false);
    assert.equal(message.includes("Bearer token"), false);
    assert.equal(redact('{"bodyText":"secret words"}').includes("secret words"), false);
    assert.equal(redact("bodyText=secret words").includes("secret words"), false);
    assert.equal(redact("password=secret words").includes("secret words"), false);
  });

  it("redacts mailbox-derived match terms from command diagnostics", () => {
    const message = commandError("pm", ["mail", "latest", "--match", "Sensitive reset code", "--require-match"], {
      status: 1,
      stdout: "",
      stderr: "no match",
    });

    assert.equal(message.includes("Sensitive reset code"), false);
    assert.match(message, /--match \[redacted\]/u);
  });

  it("selects a stable search needle from message metadata", () => {
    assert.equal(searchNeedle({ subject: "GitHub notification" }), "GitHub notification");
    assert.equal(searchNeedle({ preview: "Hi short LongPreviewToken end" }), "LongPreviewToken");
  });

  it("runs the installed pm command sequence from the temp app", async () => {
    const directory = tempDir();
    const root = path.join(directory, "workspace");
    const appDir = path.join(directory, "app");
    const pm = path.join(appDir, "node_modules", ".bin", process.platform === "win32" ? "pm.cmd" : "pm");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(path.dirname(pm), { recursive: true });
    fs.writeFileSync(pm, "#!/usr/bin/env node\n");
    const calls = [];

    const summary = await runInstalledCliSmoke({
      root,
      tempRoot: directory,
      tarball: path.join(directory, "proton-mail-cli-0.0.0.tgz"),
      pm,
      sessionFile: path.join(directory, "session.json"),
      env: { PROTONMAIL_LIVE_READ_MATCH: "GitHub" },
      run: (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd, env: options.env });
        assert.equal(command, pm);
        assert.equal(options.cwd, appDir);
        assert.equal(options.env.PROTONMAIL_SESSION_FILE, path.join(directory, "session.json"));
        return jsonResult(responseFor(args));
      },
    });

    assert.equal(summary.tarball, "proton-mail-cli-0.0.0.tgz");
    assert.equal(summary.readRef, "browser:index:0");
    assert.deepEqual(calls.map((call) => call.args.slice(0, -3)), [
      ["doctor", "config"],
      ["doctor", "session"],
      ["ls", "--limit", "5"],
      ["mail", "search", "--match", "GitHub", "--limit", "5", "--require-match"],
      ["mail", "latest", "--match", "GitHub", "--require-match"],
      ["read", "browser:index:0"],
    ]);
  });

  it("cleans up auto-created temp dirs after installed smoke", async () => {
    let appDir = "";
    const root = tempDir();
    const summary = await runInstalledCliSmoke({
      root,
      tarball: path.join(os.tmpdir(), "proton-mail-cli-0.0.0.tgz"),
      sessionFile: path.join(os.tmpdir(), "pm-live-installed-session.json"),
      env: { PROTONMAIL_LIVE_READ_MATCH: "GitHub" },
      run: (command, args, options) => {
        appDir = options.cwd || "";
        if (command === "npm") {
          const pm = path.join(appDir, "node_modules", ".bin", process.platform === "win32" ? "pm.cmd" : "pm");
          fs.mkdirSync(path.dirname(pm), { recursive: true });
          fs.writeFileSync(pm, "#!/usr/bin/env node\n");
          return { status: 0, stdout: "", stderr: "" };
        }
        return jsonResult(responseFor(args));
      },
    });

    assert.equal(summary.readRef, "browser:index:0");
    assert.equal(fs.existsSync(appDir), false);
  });
});

function responseFor(args) {
  const command = args.slice(0, -3).join(" ");
  if (command === "doctor config") return { ok: true, command: "doctor:config", data: { status: "ok" } };
  if (command === "doctor session") return { ok: true, command: "doctor:session", data: { status: "session_ready" } };
  if (command === "ls --limit 5") return mailMessages();
  if (command === "mail search --match GitHub --limit 5 --require-match") return mailMessages();
  if (command === "mail latest --match GitHub --require-match") {
    return { ok: true, command: "mail:latest", data: { source: "browser", status: "matched", message: { ref: "browser:index:0", subject: "GitHub notification" } } };
  }
  if (command === "read browser:index:0") {
    return { ok: true, command: "mail:read", data: { source: "browser", status: "matched", message: { ref: "browser:index:0", bodyText: "readable body" } } };
  }
  throw new Error(`unexpected command ${command}`);
}

function mailMessages() {
  return {
    ok: true,
    command: "mail:list",
    data: {
      source: "browser",
      status: "matched",
      messages: [{ ref: "browser:index:0", subject: "GitHub notification", preview: "GitHub notification preview" }],
    },
  };
}

function jsonResult(value) {
  return { status: 0, stdout: `${JSON.stringify(value)}\n`, stderr: "" };
}

function tempDir() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pm-live-installed-test-"));
  tempDirs.push(directory);
  return directory;
}

function expectedDefaultPlaywrightBrowsersPath(home, xdgCacheHome) {
  if (process.platform === "darwin") return path.join(home, "Library", "Caches", "ms-playwright");
  if (process.platform === "win32") return path.join(home, "AppData", "Local", "ms-playwright");
  return path.join(xdgCacheHome, "ms-playwright");
}
