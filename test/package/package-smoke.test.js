import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("installed pm package smoke", () => {
  it("runs the packed pm binary help, version, and JSON failure path", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pm-package-smoke-"));
    const packDir = path.join(tempRoot, "pack");
    const appDir = path.join(tempRoot, "app");
    const homeDir = path.join(tempRoot, "home");
    fs.mkdirSync(packDir, { recursive: true });
    fs.mkdirSync(appDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });

    const pack = run("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: ROOT });
    assert.equal(pack.status, 0, pack.stderr);
    const [packed] = JSON.parse(pack.stdout);
    assert.ok(packed.filename, "npm pack should return a tarball filename");
    const tarball = path.join(packDir, packed.filename);
    assert.equal(fs.existsSync(tarball), true, `missing packed tarball: ${tarball}`);

    const install = run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { cwd: appDir });
    assert.equal(install.status, 0, install.stderr);

    const pm = path.join(appDir, "node_modules", ".bin", process.platform === "win32" ? "pm.cmd" : "pm");
    assert.equal(fs.existsSync(pm), true, "installed package should expose node_modules/.bin/pm");

    const env = isolatedEnv(homeDir);
    const help = run(pm, ["--help"], { cwd: appDir, env });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage:/u);
    assert.match(help.stdout, /pm ls/u);
    assert.match(help.stdout, /--format <human\|json\|table>/u);
    assert.equal(help.stderr, "");

    const version = run(pm, ["--version"], { cwd: appDir, env });
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, /^pm \d+\.\d+\.\d+/u);
    assert.equal(version.stderr, "");

    const importCheck = run(process.execPath, [
      "--input-type=module",
      "--eval",
      "import { ProtonMailClient, ProtonMailBrowserClient, FileSessionStore, buildMailMetadataFilter } from 'proton-mail-cli'; console.log(`${typeof ProtonMailClient}:${typeof ProtonMailBrowserClient}:${typeof FileSessionStore}:${typeof buildMailMetadataFilter}`);",
    ], { cwd: appDir, env });
    assert.equal(importCheck.status, 0, importCheck.stderr);
    assert.equal(importCheck.stdout, "function:function:function:function\n");
    assert.equal(importCheck.stderr, "");

    const failure = run(pm, ["read", "msg1", "--json"], { cwd: appDir, env });
    assert.equal(failure.status, 1, failure.stderr);
    assert.equal(failure.stdout, "");

    const envelope = JSON.parse(failure.stderr);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.command, "mail:read");
    assert.equal(envelope.data, null);
    assert.equal(envelope.error.code, "INVALID_MESSAGE_REF");
    assert.equal(envelope.meta.envelope, "pm.v1");

    const mailUsage = run(pm, ["ls", "--limit", "not-a-number", "--json"], { cwd: appDir, env });
    assert.equal(mailUsage.status, 1, mailUsage.stderr);
    assert.equal(mailUsage.stdout, "");
    assert.equal(JSON.parse(mailUsage.stderr).error.code, "INVALID_LIMIT");

    const mailDateUsage = run(pm, ["ls", "--after", "not-a-date", "--json"], { cwd: appDir, env });
    assert.equal(mailDateUsage.status, 1, mailDateUsage.stderr);
    assert.equal(mailDateUsage.stdout, "");
    assert.equal(JSON.parse(mailDateUsage.stderr).error.code, "INVALID_DATE");

    const restSessionUsage = run(pm, ["ls", "--subject", "Invoice", "--require-match", "--json"], { cwd: appDir, env });
    assert.equal(restSessionUsage.status, 1, restSessionUsage.stderr);
    assert.equal(restSessionUsage.stdout, "");
    assert.equal(JSON.parse(restSessionUsage.stderr).error.code, "REST_SESSION_REQUIRED");

    const searchUsage = run(pm, ["mail", "search", "--json"], { cwd: appDir, env });
    assert.equal(searchUsage.status, 1, searchUsage.stderr);
    assert.equal(searchUsage.stdout, "");
    assert.equal(JSON.parse(searchUsage.stderr).error.code, "MISSING_MATCH");

    const actionUsage = run(pm, ["mail", "mark-read", "browser:index:0", "--json"], { cwd: appDir, env });
    assert.equal(actionUsage.status, 1, actionUsage.stderr);
    assert.equal(actionUsage.stdout, "");
    assert.equal(JSON.parse(actionUsage.stderr).error.code, "INVALID_MESSAGE_ID");

    const actionConfirm = run(pm, ["mail", "mark-read", "--from-search", "--subject", "Invoice", "--json"], { cwd: appDir, env });
    assert.equal(actionConfirm.status, 1, actionConfirm.stderr);
    assert.equal(actionConfirm.stdout, "");
    assert.equal(JSON.parse(actionConfirm.stderr).error.code, "CONFIRMATION_REQUIRED");
  });
});

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function isolatedEnv(homeDir) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PROTONMAIL_")) delete env[key];
  }
  env.HOME = homeDir;
  env.XDG_CONFIG_HOME = path.join(homeDir, ".config");
  env.XDG_CACHE_HOME = path.join(homeDir, ".cache");
  return env;
}
